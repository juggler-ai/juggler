//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	provider "juggler/cmd/juggler/providers/registry"
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

// createWindowResolver returns the read-only window resolver injected into every
// worker (worker.WindowResolverFunc). It maps a model identity to its context
// window and output reserve through the same resolveModelCapabilities path the
// LLM caller uses for admission, so the proactive compaction trigger divides the
// worker-owned anchored input usage by exactly the window admission would apply.
// Returns (0, 0) for an unknown model, which the worker reads as "no threshold".
func (s *Server) createWindowResolver() worker.WindowResolverFunc {
	return func(mc worker.ModelConfig) (int, int) {
		caps := s.resolveModelCapabilities(mc.Provider, mc.Model)
		return int(caps.ContextWindowTokens), int(caps.MaxOutputTokens)
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
			SystemPrompt       string               `json:"systemPrompt"`
			Messages           []provider.Message   `json:"messages"`
			Tools              []ToolDefinition     `json:"tools"`
			ConversationID     string               `json:"conversationId"`
			ThreadID           string               `json:"threadId"`
			ModelConfig        ModelConfig          `json:"modelConfig"`
			TransactionID      string               `json:"transactionId"`
			ToolChoice         *provider.ToolChoice `json:"toolChoice,omitempty"`
			MaxOutputTokens    int64                `json:"maxOutputTokens,omitempty"`
			BypassContextGuard bool                 `json:"bypassContextGuard,omitempty"`
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

		// Open (or reuse) the per-conversation handle. The cache binds
		// state to (convID, providerName, model); a mid-conversation
		// model switch closes the old handle and opens a fresh one. The
		// turn's ThreadID rides on the MessageRequest below — a stateful
		// provider (claudecode) keys its per-thread session off it.
		capabilities := s.resolveModelCapabilities(req.ModelConfig.Provider, req.ModelConfig.Model)
		conv, err := s.conversationCache.GetOrOpen(ctx, req.ConversationID, req.ModelConfig.Provider, req.ModelConfig.Model, credential, capabilities)
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
			MaxOutputTokens:    req.MaxOutputTokens,
			BypassContextGuard: req.BypassContextGuard,
			// The chosen level is the provider's own native string; passed through
			// verbatim, and each provider ignores any value it doesn't advertise.
			// Rides per-turn; deliberately NOT part of the conversation-cache key.
			ThinkingLevel: req.ModelConfig.Thinking,
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
				chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content})
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
			chunkHandler(worker.StreamChunk{Type: chunk.Type, Content: chunk.Content})
			// Coalesce adjacent text/thinking deltas into a single block so the
			// transaction JSON records one block per logical content block, not
			// one per streamed delta. Tool_use and other discrete chunks always
			// start a fresh block.
			if n := len(blocks); n > 0 &&
				(chunk.Type == provider.ContentBlockTypeText || chunk.Type == provider.ContentBlockTypeThinking) &&
				blocks[n-1].Type == chunk.Type {
				blocks[n-1].Content += chunk.Content
			} else {
				blocks = append(blocks, provider.ContentBlock(chunk))
			}
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
			Blocks:                 toLLMResponseBlocks(blocks),
			InputTokens:            result.InputTokens,
			InputTokensApproximate: result.InputTokensApproximate,
			OutputTokens:           result.OutputTokens,
			CachedTokens:           result.CachedTokens,
			CacheWriteTokens:       result.CacheWriteTokens,
			StopReason:             result.StopReason,
			TransactionID:          req.TransactionID,
			CacheTTLMs:             conv.CacheTTL().Milliseconds(),
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
