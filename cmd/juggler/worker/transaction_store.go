//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/atomicio"
	"juggler/internal/jlog"
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
// Blobs are large and rarely read whole (only when a user opens the "View
// Transaction" panel). Each is written once, and later rewritten only to drop
// its input once it is old (see TrimInputs). Items in the Yjs doc reference blobs by
// transactionId. A blob is GC-eligible once no live item and no undoLog
// entry references its id; see Sweep.
//
// Path resolution is delegated to a PathProviderFunc supplied by the
// session store, so the transaction store doesn't need to know about
// the project path or the per-conversation folder naming scheme.
type TransactionStore struct {
	pathProvider PathProviderFunc

	// lock is a one-slot semaphore (a send takes it, a receive gives it back)
	// that orders a single-blob strip against Delete and DeleteAll (see
	// stripInput), and guards stripped.
	lock chan struct{}
	// stripped names the blobs, as convID/txnID, this store has already
	// stripped or tried to, so a trim reads each blob once per store rather
	// than on every save.
	stripped map[string]bool

	// trim is the background trim's bookkeeping; see RequestTrim.
	trim trimRunner
}

// trimRunner is RequestTrim's single-flight state, guarded by its own
// one-slot semaphore, lock.
type trimRunner struct {
	lock    chan struct{}
	running bool
	pending *trimRequest
	stopped bool
	stop    chan struct{} // closed by StopTrim
	done    sync.WaitGroup
}

// trimRequest is one TrimInputs call waiting to run.
type trimRequest struct {
	convID string
	keep   map[string]bool
}

// NewTransactionStore returns a store backed by the given path provider.
// The <convDir>/txns/ directory is created lazily on Save.
func NewTransactionStore(pathProvider PathProviderFunc) *TransactionStore {
	return &TransactionStore{
		pathProvider: pathProvider,
		lock:         make(chan struct{}, 1),
		stripped:     make(map[string]bool),
		trim:         trimRunner{lock: make(chan struct{}, 1), stop: make(chan struct{})},
	}
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
// It outlasts a read of the blob under way, and waits out a strip of it.
func (s *TransactionStore) Delete(convID, txnID string) error {
	s.lock <- struct{}{}
	defer func() { <-s.lock }()
	delete(s.stripped, convID+"/"+txnID)
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
	s.lock <- struct{}{}
	defer func() { <-s.lock }()
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

// txnInputKeepNewest is how many of a conversation's newest round-trips keep
// their input. Each one's input replays the whole history up to it, so keeping
// it on every blob makes a conversation's txns/ grow with the square of its
// length — gigabytes for a few thousand round-trips. Fifty bounds that to a
// small multiple of the history while leaving a recent run's panel whole.
const txnInputKeepNewest = 50

// TrimInputs strips the input (core.StripTxnBlobInput) of every blob that is
// neither among the newest txnInputKeepNewest, by id, nor named in keep. Ids
// sort by age: the worker mints them as txn_<unix ms>_<sequence>.
//
// Best-effort per blob: one that cannot be stripped is logged, left as it is,
// and not tried again by this store. Only a failure to list the directory is
// returned.
func (s *TransactionStore) TrimInputs(convID string, keep map[string]bool) error {
	return s.trimInputs(convID, keep, nil)
}

// trimInputs is TrimInputs, returning early once stop is closed (nil: never).
func (s *TransactionStore) trimInputs(convID string, keep map[string]bool, stop <-chan struct{}) error {
	ids, err := s.List(convID)
	if err != nil {
		return err
	}
	sort.Strings(ids)
	for _, id := range ids[:max(0, len(ids)-txnInputKeepNewest)] {
		if keep[id] {
			continue
		}
		select {
		case <-stop:
			return nil
		default:
		}
		s.stripInput(convID, id)
	}
	return nil
}

// stripInput strips one blob's input, unless this store already has.
//
// Held under lock, against Delete: the strip reads the blob and renames a
// stripped copy over it, so a Delete landing between the two would be undone.
func (s *TransactionStore) stripInput(convID, txnID string) {
	key := convID + "/" + txnID
	s.lock <- struct{}{}
	defer func() { <-s.lock }()
	if s.stripped[key] {
		return
	}
	// Marked whatever the outcome: a blob that will not strip is not worth a
	// read and a log line on every save. A fresh store tries it once more.
	s.stripped[key] = true
	path := s.path(convID, txnID)
	if _, err := core.StripTxnBlobInput(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		jlog.Info("[txn] failed to strip input of %s: %v", path, err)
	}
}

// RequestTrim runs TrimInputs in the background. One trim runs at a time per
// store: a request made while one runs replaces any still waiting and starts
// as soon as it ends, so a burst of saves costs at most one more pass. The
// first pass over a conversation reads every blob old enough to strip — for a
// long one, gigabytes — which is why it never runs on the caller's goroutine.
// After that the store remembers what it stripped, and a pass touches only the
// blobs that have just aged out of the newest txnInputKeepNewest.
//
// A no-op once StopTrim has been called, and on a nil store.
func (s *TransactionStore) RequestTrim(convID string, keep map[string]bool) {
	if s == nil {
		return
	}
	s.trim.lock <- struct{}{}
	defer func() { <-s.trim.lock }()
	if s.trim.stopped {
		return
	}
	s.trim.pending = &trimRequest{convID: convID, keep: keep}
	if s.trim.running {
		return
	}
	s.trim.running = true
	s.trim.done.Add(1)
	go s.runTrims()
}

// runTrims serves trim requests until none is waiting or StopTrim is called.
func (s *TransactionStore) runTrims() {
	defer s.trim.done.Done()
	for {
		s.trim.lock <- struct{}{}
		req := s.trim.pending
		s.trim.pending = nil
		if req == nil || s.trim.stopped {
			s.trim.running = false
			<-s.trim.lock
			return
		}
		<-s.trim.lock
		if err := s.trimInputs(req.convID, req.keep, s.trim.stop); err != nil {
			jlog.Info("[txn] failed to trim inputs of conv=%s: %v", req.convID, err)
		}
	}
}

// StopTrim stops the background trim and waits for it to return, which it
// does after the blob it is on; no trim starts afterwards. Callers stop it
// before the conversation's folder can be moved or removed, which on Windows
// fails while a file in it is open. Safe to call more than once, and on a nil
// store.
func (s *TransactionStore) StopTrim() {
	if s == nil {
		return
	}
	s.trim.lock <- struct{}{}
	if !s.trim.stopped {
		s.trim.stopped = true
		close(s.trim.stop)
	}
	<-s.trim.lock
	s.trim.done.Wait()
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
