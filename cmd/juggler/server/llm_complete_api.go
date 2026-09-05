//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
)

const (
	// llmCompleteDefaultTimeout bounds an HTTP-driven out-of-band completion when
	// the caller names no bound of its own. Slightly longer than the auto-namer's
	// own bound to accommodate larger caps.
	llmCompleteDefaultTimeout = 30 * time.Second
	// llmCompleteMinTimeout is the floor for a caller-supplied bound: a request
	// too small to reach the provider is indistinguishable from a broken one.
	llmCompleteMinTimeout = 1 * time.Second
	// llmCompleteMaxTimeout is the ceiling, and the reason the clamp exists. The
	// out-of-band pool is four slots wide and shared server-wide, so an
	// over-patient caller would otherwise hold one against every other micro-task
	// on the machine for as long as it liked.
	llmCompleteMaxTimeout = 60 * time.Second
)

// handleLLMComplete runs a single bounded out-of-band completion over
// QuickComplete. It backs the plugin generateText op and any UI micro-task.
//
// Body: {system?, prompt, model?, maxTokens?, timeoutMs?}. `model` is a union:
//   - omitted / "cheap" → the resolved cheap model (auto-derived from the
//     current default when unpinned); unresolvable ⇒ 400.
//   - "default"         → the resolved default model.
//   - {provider, model, thinking?} → used as-is, validated against the live list.
//
// Response: {text, usage:{inputTokens, outputTokens, cachedTokens}}. maxTokens
// is server-clamped by QuickComplete into a sane [floor, ceiling] band — the
// floor gives a reasoning cheap model room to think, so plugins never starve it
// into an empty reply. timeoutMs is clamped here (see clampCompleteTimeout).
//
// Failures carry a status a caller can act on without reading prose: 429 the
// pool is momentarily saturated, 504 the bound elapsed, 400 the request or the
// model is wrong, 502 everything else.
func (s *Server) handleLLMComplete(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		System    string          `json:"system"`
		Prompt    string          `json:"prompt"`
		Model     json.RawMessage `json:"model"`
		MaxTokens int64           `json:"maxTokens"`
		TimeoutMs int64           `json:"timeoutMs"`
	}](w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		handlers.WriteError(w, r, http.StatusBadRequest, "prompt is required")
		return
	}

	modelRef, errMsg := s.resolveLLMCompleteModel(r.Context(), req.Model)
	if errMsg != "" {
		handlers.WriteError(w, r, http.StatusBadRequest, errMsg)
		return
	}

	res, err := s.QuickComplete(r.Context(), QuickCompleteRequest{
		Model:  modelRef,
		System: req.System,
		Prompt: req.Prompt,
		// MaxTokens passed through verbatim: QuickComplete is the single authority
		// that clamps the output budget into [floor, ceiling], flooring it so a
		// reasoning cheap model is not starved into an empty reply.
		MaxTokens: req.MaxTokens,
		Timeout:   clampCompleteTimeout(req.TimeoutMs),
	})
	if err != nil {
		status, msg := completeErrorStatus(err)
		handlers.WriteError(w, r, status, msg)
		return
	}

	handlers.WriteJSON(w, r, 0, map[string]any{
		"text": res.Text,
		"usage": map[string]any{
			"inputTokens":  res.Usage.InputTokens,
			"outputTokens": res.Usage.OutputTokens,
			"cachedTokens": res.Usage.CachedTokens,
		},
	})
}

// clampCompleteTimeout turns a caller-supplied millisecond bound into the
// wall-clock timeout to run under. Absent or non-positive means "no preference"
// and yields the default; anything else is clamped into
// [llmCompleteMinTimeout, llmCompleteMaxTimeout] rather than rejected, so a
// plugin that asks for something silly still gets its completion.
//
// The ceiling is compared in milliseconds, before the multiply: a large enough
// value would otherwise overflow into a negative Duration, which
// context.WithTimeout treats as already expired — so the most patient possible
// request would be the one that failed instantly.
func clampCompleteTimeout(ms int64) time.Duration {
	if ms <= 0 {
		return llmCompleteDefaultTimeout
	}
	if ms > int64(llmCompleteMaxTimeout/time.Millisecond) {
		return llmCompleteMaxTimeout
	}
	if d := time.Duration(ms) * time.Millisecond; d > llmCompleteMinTimeout {
		return d
	}
	return llmCompleteMinTimeout
}

// completeErrorStatus maps a QuickComplete failure to the status and message the
// client sees.
//
// The status is the contract callers classify on — the message is prose written
// for a human and free to change — so each outcome a caller would respond to
// differently gets its own code: wait a moment and try again (429), the model
// was too slow (504), or stop and go and fix something (502). An unclassified
// failure keeps its own text, since that text is all the user has to tell a dead
// credential from an unreachable host.
func completeErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ErrQuickCompleteBusy):
		return http.StatusTooManyRequests, "Too many concurrent completions, try again"
	case errors.Is(err, ErrQuickCompleteTimeout):
		return http.StatusGatewayTimeout, "The model didn't answer in time"
	default:
		return http.StatusBadGateway, err.Error()
	}
}

// resolveLLMCompleteModel resolves the request's `model` union to a concrete
// ModelRef, or returns a non-empty error message describing why it couldn't.
func (s *Server) resolveLLMCompleteModel(ctx context.Context, raw json.RawMessage) (core.ModelRef, string) {
	// Omitted / null ⇒ cheap.
	trimmed := strings.TrimSpace(string(raw))
	if len(raw) == 0 || trimmed == "null" {
		return s.resolveCheapAlias(ctx)
	}

	// String alias: "cheap" | "default".
	var alias string
	if err := json.Unmarshal(raw, &alias); err == nil {
		switch alias {
		case "", "cheap":
			return s.resolveCheapAlias(ctx)
		case "default":
			ref, _ := s.resolveDefaultModel(ctx)
			if ref.Provider == "" || ref.Model == "" {
				return core.ModelRef{}, "no default model available"
			}
			return ref, ""
		default:
			return core.ModelRef{}, "unknown model alias: " + alias
		}
	}

	// Explicit {provider, model, thinking?}.
	var obj struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil || obj.Provider == "" || obj.Model == "" {
		return core.ModelRef{}, "invalid model: expected \"cheap\", \"default\", or {provider, model}"
	}
	concrete, ok := s.liveModelMatch(obj.Provider, obj.Model)
	if !ok {
		return core.ModelRef{}, "model not available: " + obj.Provider + "/" + obj.Model
	}
	return core.ModelRef{Provider: obj.Provider, Model: concrete, Thinking: obj.Thinking}, ""
}

// resolveCheapAlias resolves the "cheap" alias: the cheap model derived from the
// current default as primary. Unresolvable ⇒ a user-facing error message.
func (s *Server) resolveCheapAlias(ctx context.Context) (core.ModelRef, string) {
	primary, _ := s.resolveDefaultModel(ctx)
	ref, ok := s.resolveCheapModel(ctx, primary)
	if !ok {
		return core.ModelRef{}, "no cheap model available"
	}
	return ref, ""
}
