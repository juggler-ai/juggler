//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"errors"
)

// Compaction observability. Three surfaces, three audiences:
//
//   - The event tape (JUGGLER_TRACE) gets structured per-pass and per-call
//     records plus orchestrator start/outcome markers — the test-assertable,
//     cross-correlatable trail.
//   - The conversation log gets one Info line per outcome for normal
//     (non-trace) forensics.
//   - Durable state carries the accounting: the compaction-summary item's
//     Data, the folded thread's compactionAccounting map, and the terminal
//     error item's data on failure — so success, failure, and cancellation
//     all leave complete operation-level diagnostics.
//
// Hidden-call usage (input/output/cached/cache-write) is accumulated by the
// reducer's budget on every completed call and survives typed failure and
// cancellation on CompactionResult. Cost is intentionally absent: provider
// responses carry no cost field today.

// compactionOutcome kinds recorded on the tape and in logs.
const (
	compactionKindFolded   = "folded"
	compactionKindRecovery = "recovery"
	compactionKindShrink   = "shrink"
)

// compactionTapeHooks returns reducer hooks that mirror pass planning and
// per-call usage onto the worker's event tape. Nil-safe when tracing is off
// (Record no-ops); the hooks themselves are always cheap enough to install.
func (w *ConversationWorker) compactionTapeHooks(kind string) compactionHooks {
	threadID := w.thread.itemID
	return compactionHooks{
		passPlanned: func(pass, chunks int, layerEstimate int64) {
			w.tape.Record("compaction-pass", map[string]any{
				"kind": kind, "thread": threadID, "pass": pass, "chunks": chunks, "layerEstimate": layerEstimate,
			})
		},
		callCompleted: func(pass int, _ hiddenLLMRequest, response *LLMResponse) {
			if response == nil {
				return
			}
			w.tape.Record("compaction-call", map[string]any{
				"kind": kind, "thread": threadID, "pass": pass,
				"input": response.InputTokens, "output": response.OutputTokens,
				"cached": response.CachedTokens, "cacheWrite": response.CacheWriteTokens,
			})
		},
	}
}

// recordCompactionStart tapes an orchestrator's entry with its budget frame.
func (w *ConversationWorker) recordCompactionStart(kind string, window, reserve, envelope int64) {
	w.tape.Record("compaction-start", map[string]any{
		"kind": kind, "thread": w.thread.itemID, "window": window, "reserve": reserve, "envelope": envelope,
	})
}

// recordCompactionOutcome tapes and logs one completed (or aborted) operation
// with its full accounting. outcome is "fold", "shrink", "shrink-only",
// "result", "error", or "cancelled".
func (w *ConversationWorker) recordCompactionOutcome(kind, outcome string, result CompactionResult, extra map[string]any) {
	summary := map[string]any{
		"kind": kind, "thread": w.thread.itemID, "outcome": outcome,
		"passes": result.Passes, "calls": result.Calls, "spend": result.EstimatedSpend,
		"input": result.Usage.InputTokens, "output": result.Usage.OutputTokens,
		"cached": result.Usage.CachedTokens, "cacheWrite": result.Usage.CacheWriteTokens,
		"durationMs": result.DurationMs,
	}
	for k, v := range extra {
		summary[k] = v
	}
	w.tape.Record("compaction-outcome", summary)
}

// compactionAccountingMap renders a CompactionResult as a plain map for
// durable storage (item Data, thread YMap, error-item data).
func compactionAccountingMap(result CompactionResult) map[string]any {
	m := map[string]any{
		"passes":         result.Passes,
		"calls":          result.Calls,
		"estimatedSpend": result.EstimatedSpend,
		"durationMs":     result.DurationMs,
		"usage": map[string]any{
			"inputTokens":      result.Usage.InputTokens,
			"outputTokens":     result.Usage.OutputTokens,
			"cachedTokens":     result.Usage.CachedTokens,
			"cacheWriteTokens": result.Usage.CacheWriteTokens,
		},
	}
	if result.SourceFingerprint != "" {
		m["sourceFingerprint"] = result.SourceFingerprint
	}
	return m
}

// compactionErrorData extracts durable accounting from a recovery/compaction
// error chain for the terminal error item's data, so a failed or cancelled
// operation still leaves its partial accounting in the doc. Returns nil when
// the error carries no compaction accounting.
func compactionErrorData(err error) map[string]any {
	var bounded *BoundedCompactionError
	if errors.As(err, &bounded) {
		return map[string]any{
			"compactionReason": string(bounded.Reason),
			"compactionCalls":  bounded.Calls,
			"compactionSpend":  bounded.Spend,
			"compactionUsage": map[string]any{
				"inputTokens":      bounded.Usage.InputTokens,
				"outputTokens":     bounded.Usage.OutputTokens,
				"cachedTokens":     bounded.Usage.CachedTokens,
				"cacheWriteTokens": bounded.Usage.CacheWriteTokens,
			},
		}
	}
	var cancelled *BoundedCompactionCancelledError
	if errors.As(err, &cancelled) {
		m := compactionAccountingMap(cancelled.Result)
		m["compactionReason"] = "cancelled"
		return m
	}
	return nil
}
