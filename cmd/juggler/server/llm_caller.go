//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
)

// toLLMResponseBlocks converts a provider's accumulated content blocks into the
// worker's LLMResponseBlock shape, marshaling each block's tool input to JSON.
// Shared by the solicited-turn caller (createLLMCaller) and the autonomous-turn
// sink (workerTurnSink.DeliverTurn), which produced byte-identical loops.
func toLLMResponseBlocks(blocks []provider.ContentBlock) []worker.LLMResponseBlock {
	out := make([]worker.LLMResponseBlock, 0, len(blocks))
	for _, block := range blocks {
		var toolInput json.RawMessage
		if block.ToolInput != nil {
			toolInput, _ = json.Marshal(block.ToolInput)
		}
		out = append(out, worker.LLMResponseBlock{
			Type:     block.Type,
			Content:  block.Content,
			ID:       block.ToolUseID,
			Name:     block.ToolName,
			Input:    toolInput,
			Metadata: block.Metadata,
		})
	}
	return out
}

// appendStreamedBlock accumulates one streamed chunk into the turn's structured
// blocks. Adjacent text/thinking deltas coalesce into a single block so the
// transaction JSON records one block per logical content block rather than one
// per delta; tool_use and other discrete chunks always start a fresh block.
//
// A block's provider data (an Anthropic thinking signature, an OpenAI reasoning
// item's id and encrypted content) is known only once the block ends, so it
// arrives on a trailing contentless chunk that coalesces into the block above.
// Merging it across the join is what keeps it — appending "" to the content and
// discarding the rest would drop the only copy.
func appendStreamedBlock(blocks []provider.ContentBlock, chunk provider.StreamChunk) []provider.ContentBlock {
	n := len(blocks)
	if n == 0 ||
		(chunk.Type != provider.ContentBlockTypeText && chunk.Type != provider.ContentBlockTypeThinking) ||
		blocks[n-1].Type != chunk.Type {
		return append(blocks, provider.ContentBlock(chunk))
	}

	last := &blocks[n-1]
	last.Content += chunk.Content
	if len(chunk.Metadata) > 0 && last.Metadata == nil {
		last.Metadata = make(map[string]any, len(chunk.Metadata))
	}
	for k, v := range chunk.Metadata {
		last.Metadata[k] = v
	}
	return blocks
}

// createWindowResolver returns the read-only window resolver injected into every
// worker (worker.WindowResolverFunc). It maps a model identity to its context
// window and output reserve through the same resolveModelCapabilities path the
// LLM caller uses for admission, so the proactive compaction trigger divides the
// worker-owned anchored input usage by exactly the window admission would apply.
// Returns (0, 0) for an unknown model, which the worker reads as "no threshold".
func (s *Server) createWindowResolver() worker.WindowResolverFunc {
	return func(mc worker.ModelConfig) worker.ContextWindowInfo {
		caps, assumed := s.resolveModelLimits(mc.Provider, mc.Model)
		return worker.ContextWindowInfo{
			WindowTokens:  int(caps.ContextWindowTokens),
			ReserveTokens: int(caps.MaxOutputTokens),
			Assumed:       assumed,
		}
	}
}

// createAutoCompactGate returns the gate injected into every worker
// (worker.AutoCompactGateFunc) reporting whether automatic compaction is
// enabled. It reads the raw credentials-store key live — GetRawKey re-reads the
// file each call — so a settings toggle takes effect on the next turn with no
// restart or re-push. The key stores the DISABLED state ("1" ⇒ disabled), so an
// absent/empty value means enabled (default-on). If the credentials store can't
// be constructed, the gate fails open to enabled (current behavior).
func (s *Server) createAutoCompactGate() worker.AutoCompactGateFunc {
	// Raw credential key mirrors handlers/config.go autoCompactDisabledKey.
	const autoCompactDisabledKey = "auto_compact_disabled"
	store, err := core.NewCredentialsStore()
	if err != nil {
		jlog.Error("auto-compaction gate: credentials store unavailable, defaulting to enabled: %v", err)
		return func() bool { return true }
	}
	return func() bool {
		return store.GetRawKey(autoCompactDisabledKey) != "1"
	}
}

// createSpendLimitResolver returns the ceiling resolver injected into every
// worker (worker.SpendLimitFunc): how many cumulative input tokens one
// conversation may spend before delegated work is asked to land. It reads the
// raw credentials-store key live — GetRawKey re-reads the file each call — so a
// settings change takes effect on the next turn boundary with no restart.
//
// An absent or unparseable value means the shipped default, and an explicit 0
// means no ceiling. If the credentials store can't be constructed the default
// applies: a ceiling nobody configured is still the behaviour we ship, and
// failing open to unlimited would quietly remove the guard on the machines least
// able to report that it had gone.
func (s *Server) createSpendLimitResolver() worker.SpendLimitFunc {
	// Raw credential key mirrors handlers/config.go spendLimitTokensKey.
	const spendLimitTokensKey = "spend_limit_tokens"
	store, err := core.NewCredentialsStore()
	if err != nil {
		jlog.Error("spend ceiling: credentials store unavailable, using the default: %v", err)
		return func() int64 { return worker.DefaultSpendCeilingTokens }
	}
	return func() int64 {
		raw := strings.TrimSpace(store.GetRawKey(spendLimitTokensKey))
		if raw == "" {
			return worker.DefaultSpendCeilingTokens
		}
		limit, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || limit < 0 {
			return worker.DefaultSpendCeilingTokens
		}
		return limit
	}
}

// createLLMCaller creates a function that workers can use to call the
// LLM directly. The closure captures the per-server conversationCache so
// Conversation handles are reused across turns for the same (convID,
// provider, model) triple. The cache also owns shutdown semantics: conv
// delete → cc.CloseConversation(convID); server shutdown → cc.Shutdown.
func (s *Server) createLLMCaller() worker.LLMCallFunc {
	return func(ctx context.Context, request json.RawMessage, chunkHandler func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		// Wait for the hidden engine WebView to be connected before the turn
		// starts, so it is ready before the provider streams any tool_use. Fails
		// the turn with a clear error rather than letting tool requests be
		// silently dropped to a missing engine. No-op (returns true) in tests and
		// the test-pool, where the engine is an always-on iframe.
		if !s.ensureEngineReady() {
			return nil, fmt.Errorf("engine is not available — tools cannot execute (the engine WebView did not connect in time)")
		}

		// Parse worker request
		var req struct {
			SystemPrompt         string               `json:"systemPrompt"`
			Messages             []provider.Message   `json:"messages"`
			Tools                []ToolDefinition     `json:"tools"`
			ConversationID       string               `json:"conversationId"`
			ThreadID             string               `json:"threadId"`
			WorkspaceID          string               `json:"workspaceId,omitempty"`
			ModelConfig          core.ModelRef        `json:"modelConfig"`
			TransactionID        string               `json:"transactionId"`
			ToolChoice           *provider.ToolChoice `json:"toolChoice,omitempty"`
			MaxOutputTokens      int64                `json:"maxOutputTokens,omitempty"`
			BypassContextGuard   bool                 `json:"bypassContextGuard,omitempty"`
			SyntheticTranscript  bool                 `json:"syntheticTranscript,omitempty"`
			ExplicitContinuation bool                 `json:"explicitContinuation,omitempty"`
			// 0 = the default soft ceiling; 1 = the hard window (automatic
			// compaction is disabled for this conversation).
			ContextCeilingFraction float64 `json:"contextCeilingFraction,omitempty"`
		}
		if err := json.Unmarshal(request, &req); err != nil {
			return nil, fmt.Errorf("failed to parse LLM request: %w", err)
		}

		// Initial model discovery runs asynchronously. Wait before doing dispatch
		// work so this turn cannot bind its conversation to incomplete startup
		// metadata. The gate honors the turn context and provider-startup timeout.
		s.awaitProvidersReady(ctx)
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		// Resolve image attachments: the worker→caller JSON carries only an
		// asset reference (AssetID + mime + dims), never the bytes. Load the
		// bytes from the per-conversation asset store here, in memory, just
		// before Submit, so raw image data never travels in the request JSON and
		// is never marshaled by the cost estimator. A missing asset is logged
		// and skipped (the part is dropped at transform time) rather than
		// failing the whole turn.
		assetStore := worker.NewAssetStore(s.convDir)
		for i := range req.Messages {
			for j := range req.Messages[i].Parts {
				part := &req.Messages[i].Parts[j]
				if part.AssetID == "" || len(part.Data) > 0 {
					continue
				}
				data, mime, err := assetStore.Get(req.ConversationID, part.AssetID)
				if err != nil {
					jlog.Error("LLM caller: could not resolve asset %s for conversation %s: %v", part.AssetID, req.ConversationID, err)
					continue
				}
				part.Data = data
				if part.Mime == "" {
					part.Mime = mime
				}
			}
		}

		// Get credentials
		creds, err := core.NewCredentialsStore()
		if err != nil {
			return nil, fmt.Errorf("failed to get credentials: %w", err)
		}
		credential, err := creds.GetProviderCredential(req.ModelConfig.Provider)
		if err != nil {
			// The stored/selected provider has no usable credentials (no API key,
			// provider disabled, OAuth not signed in). Wrap with the worker sentinel
			// so the strategy loop surfaces a user-fixable "pick another model"
			// validation error (Guard B) instead of a generic turn failure, and
			// never retries a model that cannot run until the user acts.
			return nil, fmt.Errorf("%w: %v", worker.ErrProviderUnavailable, err)
		}

		// Where this conversation works: the project unless it is bound to a
		// workspace. Resolved before the handle is opened, so a binding that
		// cannot be honoured (still provisioning, closed, root gone, unknown, or
		// nowhere this provider can be spawned) fails the turn saying which —
		// rather than running in the project root, which would edit the wrong
		// tree and look exactly like working.
		workspaceRoot, err := turnDir(s.Workspaces().Resolve, req.WorkspaceID, req.ModelConfig.Provider)
		if err != nil {
			return nil, err
		}

		// Open (or reuse) the per-conversation handle. The cache binds
		// state to (convID, providerName, model, workspace); a mid-conversation
		// model switch closes the old handle and opens a fresh one. The
		// turn's ThreadID rides on the MessageRequest below — a stateful
		// provider (claudecode) keys its per-thread session off it.
		capabilities := s.resolveModelCapabilities(req.ModelConfig.Provider, req.ModelConfig.Model)
		conv, err := s.conversationCache.GetOrOpen(ctx, req.ConversationID, req.ModelConfig.Provider, req.ModelConfig.Model, credential, capabilities, workspaceRoot)
		if err != nil {
			return nil, fmt.Errorf("open conversation: %w", err)
		}

		// Convert tools
		providerTools := make([]provider.ToolDefinition, len(req.Tools))
		for i, tool := range req.Tools {
			providerTools[i] = provider.ToolDefinition{
				Name:        tool.Name,
				Description: tool.Description,
				InputSchema: tool.InputSchema,
			}
		}

		mreq := provider.MessageRequest{
			Messages:       req.Messages,
			SystemPrompt:   req.SystemPrompt,
			Tools:          providerTools,
			ConversationID: req.ConversationID,
			ThreadID:       req.ThreadID,
			ToolChoice:     req.ToolChoice,
			// F1: per-request wire output cap (hidden compaction map calls). 0 =
			// use the client/model default; adapters apply it as a min().
			MaxOutputTokens:        req.MaxOutputTokens,
			BypassContextGuard:     req.BypassContextGuard,
			SyntheticTranscript:    req.SyntheticTranscript,
			ContextCeilingFraction: req.ContextCeilingFraction,
			ExplicitContinuation:   req.ExplicitContinuation,
			// The chosen level is the provider's own native string; passed through
			// verbatim, and each provider ignores any value it doesn't advertise.
			// Rides per-turn; deliberately NOT part of the conversation-cache key.
			ThinkingLevel: req.ModelConfig.Thinking,
			// The serving class, same contract: the provider's own tier id,
			// per-turn, ignored by any provider that doesn't advertise it.
			ServiceTier: req.ModelConfig.ServiceTier,
		}

		// Adapter that bridges Provider's StructuredStreamCallback to the
		// worker's chunk-handler shape and accumulates structured blocks
		// so the worker can post-process tool_use blocks once the turn
		// completes (text/thinking are visible mid-stream via chunks).
		var blocks []provider.ContentBlock
		cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Status chunks are transient (rate-limit retries, parking
			// notes). Surface to worker as a chunk; don't accumulate.
			if chunk.Type == provider.ContentBlockTypeStatus {
				reason, _ := chunk.Metadata["cacheMissReason"].(string)
				chunkHandler(worker.StreamChunk{
					Type:            chunk.Type,
					Content:         chunk.Content,
					CacheMissReason: reason,
					Notice:          streamNoticeFrom(chunk.Metadata),
				})
				return nil, nil
			}
			// Activity chunks are complete, replaceable snapshots for live UI state.
			// Forward them to the worker but never retain them in the response.
			if chunk.Type == provider.ContentBlockTypeActivity {
				chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content, Metadata: chunk.Metadata})
				return nil, nil
			}
			// Progress chunks carry a running output-token estimate for the
			// UI's mid-stream spinner. Transient — never accumulated.
			if chunk.Type == provider.ContentBlockTypeProgress {
				out, _ := chunk.Metadata["outputTokens"].(int)
				chunkHandler(worker.StreamChunk{Type: chunk.Type, OutputTokens: out})
				return nil, nil
			}
			// Usage chunks carry the mid-stream input-token anchor (and any
			// cache hit/TTL the provider has reported so far). Transient —
			// never accumulated; the end-of-turn write overwrites with
			// final numbers.
			if chunk.Type == provider.ContentBlockTypeUsage {
				in, _ := chunk.Metadata["inputTokens"].(int)
				cached, _ := chunk.Metadata["cachedTokens"].(int)
				var ttlMs int64
				switch v := chunk.Metadata["cacheTTLMs"].(type) {
				case int64:
					ttlMs = v
				case int:
					ttlMs = int64(v)
				}
				chunkHandler(worker.StreamChunk{
					Type:         chunk.Type,
					InputTokens:  in,
					CachedTokens: cached,
					CacheTTLMs:   ttlMs,
				})
				return nil, nil
			}
			chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content, Metadata: chunk.Metadata})
			blocks = appendStreamedBlock(blocks, chunk)
			return nil, nil
		}

		// Submit drives the solicited turn. The provider derives fresh-turn
		// vs tool-result-continuation from req.Messages' trailing entries
		// itself, so there is no separate delivery call at this layer.
		//
		// Wrap the call in an osactivity assertion so macOS does not
		// App-Nap us mid-request. Refcounted, so nested HTTP calls in
		// providers that also assert compose without leaking. Released
		// in defer regardless of how the call returns (success, error,
		// panic), so we can never leave the assertion held when idle.
		osactivity.Begin()
		defer osactivity.End()

		result, err := conv.Submit(ctx, mreq, cb)
		if err != nil {
			return nil, err
		}

		return &worker.LLMResponse{
			Blocks:                  toLLMResponseBlocks(blocks),
			InputTokens:             result.InputTokens,
			InputTokensApproximate:  result.InputTokensApproximate,
			OutputTokens:            result.OutputTokens,
			CachedTokens:            result.CachedTokens,
			CacheWriteTokens:        result.CacheWriteTokens,
			StopReason:              result.StopReason,
			AdmissionEstimateTokens: result.AdmissionEstimateTokens,
			AdmissionAnchored:       result.AdmissionAnchored,
			TransactionID:           req.TransactionID,
			CacheTTLMs:              conv.CacheTTL().Milliseconds(),
		}, nil
	}
}

// workerTurnSink routes a Conversation's autonomous turns to the owning worker
// as `provider-turn` inbound messages. One per conversation, built by the
// cache's turn-sink factory at open time and Subscribe()d onto the handle.
// DeliverTurn may be called from a provider-owned goroutine (claudecode's
// always-on stdout reader); Manager.HandleMessage hops onto the manager actor
// and the worker's inbound FIFO, so this is safe to call off the worker
// goroutine. A nil sendCallback is passed so no client callback is registered
// for this system-injected message.
// streamNoticeFrom lifts a provider-composed durable notice off a status
// chunk's metadata. Returns nil unless both halves are present: a notice with
// no summary or no body would land in the transcript as an empty warning row,
// which is worse than saying nothing.
func streamNoticeFrom(metadata map[string]any) *worker.StreamNotice {
	summary, _ := metadata["noticeSummary"].(string)
	content, _ := metadata["noticeContent"].(string)
	if summary == "" || content == "" {
		return nil
	}
	source, _ := metadata["noticeSource"].(string)
	return &worker.StreamNotice{Summary: summary, Content: content, Source: source}
}

type workerTurnSink struct {
	convID  string
	manager *worker.Manager
}

func (s *workerTurnSink) DeliverTurn(turn provider.ProviderTurn) {
	payload, err := json.Marshal(worker.ProviderTurnMessage{
		Type:                   "provider-turn",
		Blocks:                 toLLMResponseBlocks(turn.Blocks),
		StopReason:             turn.Result.StopReason,
		InputTokens:            turn.Result.InputTokens,
		InputTokensApproximate: turn.Result.InputTokensApproximate,
		OutputTokens:           turn.Result.OutputTokens,
		CachedTokens:           turn.Result.CachedTokens,
		CacheWriteTokens:       turn.Result.CacheWriteTokens,
		Autonomous:             turn.Autonomous,
	})
	if err != nil {
		return
	}
	s.manager.HandleMessage(s.convID, "provider-turn", payload, nil)
}
