//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/atomicio"
)

// TransactionBlobInput carries everything SaveBlob needs to assemble a
// transaction blob; centralises the JSON shape so callers don't reproduce it.
type TransactionBlobInput struct {
	ConversationID string
	TxnID          string
	LLMRequest     json.RawMessage
	Response       *LLMResponse // may be nil on early-fail paths
	ErrMsg         string
	StartTime      time.Time
	Duration       time.Duration
	ModelConfig    *ModelConfig
}

// SaveBlob writes a per-round-trip transaction blob to <convDir>/txns/<txnID>.json.
//
// The blob is the source of truth for "View Transaction" — every item whose
// transactionId equals txnID is rendered against it. We persist it BEFORE any
// further Yjs mutation so even a crashing post-process leaves the inputs
// recoverable. GC sweeps the blob once no live item or undoLog entry
// references it.
//
// in.Response may be nil — that branch records the input context plus errMsg
// so a failed-round-trip's error item still has something to show. ErrMsg
// should be empty on the success path.
func (s *TransactionStore) SaveBlob(in TransactionBlobInput) error {
	if s == nil {
		return nil // not initialised (e.g. tests without projectPath)
	}

	var reqData map[string]any
	_ = json.Unmarshal(in.LLMRequest, &reqData)

	input := map[string]any{}
	if reqData != nil {
		input["systemPrompt"] = reqData["systemPrompt"]
		input["messages"] = reqData["messages"]
		input["tools"] = reqData["tools"]
		if tc, ok := reqData["toolChoice"]; ok {
			input["toolChoice"] = tc
		}
	}

	output := map[string]any{}
	blob := map[string]any{
		"id":          in.TxnID,
		"timestamp":   in.StartTime.Format(time.RFC3339),
		"duration":    in.Duration.Milliseconds(),
		"modelConfig": in.ModelConfig,
		"input":       input,
		"output":      output,
	}

	if in.Response != nil {
		blob["inputTokens"] = in.Response.InputTokens
		if in.Response.InputTokensApproximate {
			blob["inputTokensApproximate"] = true
		}
		blob["outputTokens"] = in.Response.OutputTokens
		// Cache usage is written only when the provider reported it: an absent
		// key means unknown, while an explicit 0 is a provider-reported zero.
		if in.Response.CachedTokens != nil {
			blob["cachedTokens"] = *in.Response.CachedTokens
		}
		if in.Response.CacheWriteTokens != nil {
			blob["cacheWriteTokens"] = *in.Response.CacheWriteTokens
		}
		blob["stopReason"] = in.Response.StopReason
		output["blocks"] = in.Response.Blocks
	}

	if in.ErrMsg != "" {
		blob["stopReason"] = provider.StopReasonError
		output["error"] = in.ErrMsg
	}

	data, err := json.Marshal(blob)
	if err != nil {
		return fmt.Errorf("marshal txn blob: %w", err)
	}
	return s.Save(in.ConversationID, in.TxnID, data)
}

// TransactionStore persists per-conversation LLM transaction blobs as one
// JSON file per transaction under <convDir>/txns/.
//
// Blobs are large, write-once, and rarely read (only when a user opens the
// "View Transaction" panel). Items in the Yjs doc reference blobs by
// transactionId. A blob is GC-eligible once no live item and no undoLog
// entry references its id; see Sweep.
//
// Path resolution is delegated to a PathProviderFunc supplied by the
// session store, so the transaction store doesn't need to know about
// the project path or the per-conversation folder naming scheme.
type TransactionStore struct {
	pathProvider PathProviderFunc
}

// NewTransactionStore returns a store backed by the given path provider.
// The <convDir>/txns/ directory is created lazily on Save.
func NewTransactionStore(pathProvider PathProviderFunc) *TransactionStore {
	return &TransactionStore{pathProvider: pathProvider}
}

// dir returns the per-conversation transactions directory or "" if the
// conversation is unknown to the path provider.
func (s *TransactionStore) dir(convID string) string {
	if s.pathProvider == nil {
		return ""
	}
	convDir, ok := s.pathProvider(convID)
	if !ok {
		return ""
	}
	return core.ConvTxnsDir(convDir)
}

// path returns the on-disk path for a single transaction blob.
func (s *TransactionStore) path(convID, txnID string) string {
	return filepath.Join(s.dir(convID), txnID+".json")
}

// Save writes a transaction blob atomically (temp file + rename).
// Creates the parent directory if needed. No-op if the conversation is
// unknown to the path provider (e.g. test setups without persistence).
func (s *TransactionStore) Save(convID, txnID string, data []byte) error {
	dir := s.dir(convID)
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create txn dir: %w", err)
	}
	dst := s.path(convID, txnID)
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write txn temp: %w", err)
	}
	if err := atomicio.RobustRename(tmp, dst); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename txn: %w", err)
	}
	return nil
}

// Load reads a transaction blob. Returns os.ErrNotExist if absent.
func (s *TransactionStore) Load(convID, txnID string) ([]byte, error) {
	return os.ReadFile(s.path(convID, txnID))
}

// List returns the transaction IDs currently on disk for a conversation.
// Returns an empty slice (no error) if the directory does not exist.
func (s *TransactionStore) List(convID string) ([]string, error) {
	dir := s.dir(convID)
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read txn dir: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		ids = append(ids, strings.TrimSuffix(name, ".json"))
	}
	return ids, nil
}

// Delete removes a single transaction blob. Missing files are not an error.
// It outlasts a read of the blob under way.
func (s *TransactionStore) Delete(convID, txnID string) error {
	if err := atomicio.RobustRemove(s.path(convID, txnID)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete txn: %w", err)
	}
	return nil
}

// DeleteAll removes the entire transactions directory for a conversation.
// Used when a conversation is deleted.
func (s *TransactionStore) DeleteAll(convID string) error {
	dir := s.dir(convID)
	if dir == "" {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove txn dir: %w", err)
	}
	return nil
}

// CopyAll copies every transaction blob from srcConvID's directory into
// dstConvID's directory. Used when duplicating a conversation so items in
// the new conversation can still resolve their transactionId references.
// A missing source directory is not an error (the conversation had no
// transactions yet).
func (s *TransactionStore) CopyAll(srcConvID, dstConvID string) error {
	ids, err := s.List(srcConvID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		data, err := s.Load(srcConvID, id)
		if err != nil {
			return fmt.Errorf("read src txn %s: %w", id, err)
		}
		if err := s.Save(dstConvID, id, data); err != nil {
			return err
		}
	}
	return nil
}

// Sweep deletes any transaction blob whose id is not in liveSet.
// Caller is responsible for building liveSet from both the live items tree
// and the undoLog (anything resurrectable via undo/redo must be retained).
func (s *TransactionStore) Sweep(convID string, liveSet map[string]bool) error {
	ids, err := s.List(convID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if liveSet[id] {
			continue
		}
		if err := s.Delete(convID, id); err != nil {
			return err
		}
	}
	return nil
}
