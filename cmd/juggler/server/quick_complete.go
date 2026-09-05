//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	"juggler/cmd/juggler/providers/provider"
)

const (
	// quickCompleteConcurrency bounds simultaneous out-of-band completions.
	quickCompleteConcurrency = 4
	// quickCompleteDefaultTimeout is the wall-clock bound applied when a request
	// leaves Timeout unset.
	quickCompleteDefaultTimeout = 15 * time.Second
	// quickCompleteMinMaxTokens is the floor for a request's output budget, and
	// the single most important guardrail on this channel. A reasoning model
	// (GLM, DeepSeek-R1, gpt-5-mini, gemini-2.5-flash) spends output-token budget
	// on hidden chain-of-thought BEFORE it emits any visible text, so too small a
	// cap truncates the turn at finish=length having produced nothing — an empty
	// reply. The channel serves such models without being able to detect them in
	// advance (GLM advertises no thinking capability yet reasons), so every
	// caller — whatever it asks for — is floored to enough budget to think AND
	// answer. The cap is only ever a ceiling on generation, never a target, so
	// this costs a non-reasoning model nothing: it still stops at its natural end.
	quickCompleteMinMaxTokens int64 = 2048
	// quickCompleteMaxTokensCeiling hard-caps a request's output regardless of
	// what the caller asks for — these are micro-tasks, not summaries. It sits
	// above quickCompleteMinMaxTokens so the floor never exceeds the ceiling.
	quickCompleteMaxTokensCeiling int64 = 4096
)

// ErrQuickCompleteBusy is returned when the out-of-band concurrency limit is
// already saturated. Callers should treat it as a fast, retryable rejection
// (HTTP 429), never as a turn failure.
var ErrQuickCompleteBusy = errors.New("quick-complete concurrency limit reached")

// ErrQuickCompleteTimeout is returned when this request's own wall-clock bound
// elapsed before the model answered. It is a distinct sentinel because a slow
// model and a broken one need opposite responses — one is worth another go, the
// other needs the user to go and fix something — and every caller that could
// tell them apart was previously left string-matching a provider's prose.
//
// It wraps context.DeadlineExceeded, so a caller may classify it either as this
// sentinel or as an ordinary deadline.
var ErrQuickCompleteTimeout = fmt.Errorf("quick complete: the model did not answer in time: %w", context.DeadlineExceeded)

// QuickCompleteRequest is one bounded, out-of-band single-turn completion. The
// caller pre-resolves Model to a concrete {provider, model, thinking}.
type QuickCompleteRequest struct {
	Model     core.ModelRef // provider+model+thinking; caller pre-resolves
	System    string        // optional system prompt
	Prompt    string        // the user content (single turn)
	MaxTokens int64         // small output cap; <=0 ⇒ a small default, clamped to the ceiling
	Timeout   time.Duration // wall-clock bound; 0 ⇒ quickCompleteDefaultTimeout
}

// QuickCompleteUsage is the trimmed token accounting returned alongside the text.
type QuickCompleteUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	CachedTokens int `json:"cachedTokens"`
}

// QuickCompleteResult is the assembled text plus usage from a QuickComplete call.
type QuickCompleteResult struct {
	Text  string
	Usage QuickCompleteUsage
}

// QuickComplete runs a single bounded LLM turn with no tools, no Yjs document,
// no worker, and no persistence — a stripped sibling of createLLMCaller's
// closure. It opens an ephemeral provider Conversation (a throwaway id, never
// entered into the per-conversation cache), submits one user message,
// accumulates only text content, and returns.
//
// Guardrails: an output budget floored for reasoning headroom and capped
// (MaxOutputTokens), a wall-clock timeout, and a server-wide concurrency
// limiter. Over-cap callers get ErrQuickCompleteBusy
// immediately rather than queueing, and a request that outlives its own bound
// gets ErrQuickCompleteTimeout; both are retryable by construction. Missing
// credentials and provider failures are returned as they arrive, for the caller
// to handle (the auto-namer swallows them).
func (s *Server) QuickComplete(ctx context.Context, req QuickCompleteRequest) (QuickCompleteResult, error) {
	if req.Model.Provider == "" || req.Model.Model == "" {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: model not specified")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: empty prompt")
	}

	// Concurrency limiter: acquire a slot or bail fast. The buffered channel is
	// the semaphore; a full buffer means the cap is saturated.
	if s.quickCompleteSem != nil {
		select {
		case s.quickCompleteSem <- struct{}{}:
			defer func() { <-s.quickCompleteSem }()
		default:
			return QuickCompleteResult{}, ErrQuickCompleteBusy
		}
	}

	// Wait out startup provider discovery so capability resolution sees the real
	// live list (no-op in steady state).
	s.awaitProvidersReady(ctx)
	if err := ctx.Err(); err != nil {
		return QuickCompleteResult{}, err
	}

	creds, err := core.NewCredentialsStore()
	if err != nil {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: credentials: %w", err)
	}
	credential, err := creds.GetProviderCredential(req.Model.Provider)
	if err != nil {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: provider %q unavailable: %w", req.Model.Provider, err)
	}

	capabilities := s.resolveModelCapabilities(req.Model.Provider, req.Model.Model)
	info, _ := provider.GetProviderInfo(req.Model.Provider)

	// Build the provider directly (bypassing conversationCache) so this ephemeral
	// turn never pollutes the per-conversation handle cache or reuses a user
	// conversation's provider-side session.
	prov, err := provider.InitializeProvider(req.Model.Provider, provider.Config{
		APIKey:            credential.APIKey,
		BearerToken:       credential.BearerToken,
		Headers:           credential.Headers,
		Model:             req.Model.Model,
		ModelCapabilities: capabilities,
		BudgetContract: provider.BudgetContract{
			AllowUnknownLimits: info.AllowUnknownLimits,
		},
	})
	if err != nil {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: initialize provider %q: %w", req.Model.Provider, err)
	}

	conv, err := prov.OpenConversation(ctx, ephemeralConvID())
	if err != nil {
		return QuickCompleteResult{}, fmt.Errorf("quick complete: open conversation: %w", err)
	}
	defer func() { _ = conv.Close() }()

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = quickCompleteDefaultTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Clamp the output budget into [floor, ceiling]. The floor guarantees a
	// reasoning model room to think before answering (see quickCompleteMinMaxTokens);
	// an unset or under-budget request is raised to it rather than starved.
	maxTokens := req.MaxTokens
	if maxTokens < quickCompleteMinMaxTokens {
		maxTokens = quickCompleteMinMaxTokens
	}
	if maxTokens > quickCompleteMaxTokensCeiling {
		maxTokens = quickCompleteMaxTokensCeiling
	}

	mreq := provider.MessageRequest{
		Messages:        []provider.Message{{Type: "user", Content: req.Prompt}},
		SystemPrompt:    req.System,
		MaxOutputTokens: maxTokens,
		// The prompt is tiny and single-turn; skip the silent-truncation guard.
		BypassContextGuard: true,
		// Native provider level, passed through verbatim; the provider ignores
		// any value it doesn't advertise.
		ThinkingLevel: req.Model.Thinking,
		// ServiceTier is deliberately NOT forwarded. These are out-of-band
		// micro-tasks the user never asked for and never sees the latency of —
		// naming a tab at a premium serving rate spends real money to save time
		// nobody is waiting on. Standard serving is always the right call here.
	}

	// Accumulate only text blocks; ignore thinking / status / progress / usage
	// noise (mirrors llm_caller.go's chunk switch, minus everything but text).
	var b strings.Builder
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if err := callCtx.Err(); err != nil {
			return nil, err
		}
		if chunk.Type == provider.ContentBlockTypeText {
			b.WriteString(chunk.Content)
		}
		return nil, nil
	}

	// Keep macOS from App-Napping us mid-request; refcounted + released in defer.
	osactivity.Begin()
	defer osactivity.End()

	result, err := conv.Submit(callCtx, mreq, cb)
	if err != nil {
		// Classified from the deadline itself rather than from the returned error:
		// a provider is free to wrap, re-word or wholly replace the error of a
		// request cancelled underneath it, so callCtx is the only reliable witness
		// that OUR bound is what fired. A caller whose own ctx ended gets the raw
		// error — that expiry is theirs to interpret, not ours to rename.
		if callCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
			return QuickCompleteResult{}, ErrQuickCompleteTimeout
		}
		return QuickCompleteResult{}, err
	}

	usage := QuickCompleteUsage{}
	if result != nil {
		usage.InputTokens = result.InputTokens
		usage.OutputTokens = result.OutputTokens
		usage.CachedTokens = provider.TokenCount(result.CachedTokens)
	}
	return QuickCompleteResult{Text: strings.TrimSpace(b.String()), Usage: usage}, nil
}

// ephemeralConvID mints a throwaway conversation id for an out-of-band turn, so
// a stateful provider keys its session off something that can never collide with
// a real conversation folder id.
func ephemeralConvID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// rand failure is effectively impossible; a fixed suffix is still unique
		// enough for an ephemeral, immediately-closed handle.
		return "oob-fallback"
	}
	return "oob-" + hex.EncodeToString(buf[:])
}
