//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"errors"
	"fmt"

	"juggler/cmd/juggler/providers/provider"
)

// Compaction observability. Three surfaces, three audiences:
//
//   - The event tape (JUGGLER_TRACE) gets structured per-pass and per-call
//     records plus orchestrator start/outcome markers — the test-assertable,
//     cross-correlatable trail.
//   - The conversation log gets an Info line when an operation starts, and one
//     per outcome, for normal (non-trace) forensics. A successful fold or
//     shrink writes its own outcome line where it lands (compaction_trigger.go);
//     recordCompactionOutcome writes the line for one that was cancelled or
//     failed, which would otherwise spend its hidden calls without a trace. The
//     start line matters as much: a compaction can run for minutes before any
//     outcome, and the log is where a user looks to learn why it is running.
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
	compactionKindFolded = "folded"
	compactionKindAuto   = "auto"
	compactionKindShrink = "shrink"
)

// compactionTapeHooks returns reducer hooks that mirror pass planning and
// per-call usage onto the worker's event tape. Nil-safe when tracing is off
// (Record no-ops); the hooks themselves are always cheap enough to install.
func (r *run) compactionTapeHooks(kind string) compactionHooks {
	threadID := r.t.thread.itemID
	return compactionHooks{
		passPlanned: func(pass, chunks int, layerEstimate int64) {
			r.tape.Record("compaction-pass", map[string]any{
				"kind": kind, "thread": threadID, "pass": pass, "chunks": chunks, "layerEstimate": layerEstimate,
			})
		},
		callCompleted: func(pass int, _ hiddenLLMRequest, response *LLMResponse) {
			if response == nil {
				return
			}
			r.tape.Record("compaction-call", map[string]any{
				"kind": kind, "thread": threadID, "pass": pass,
				"input": response.InputTokens, "output": response.OutputTokens,
				"cached":     provider.TokenCount(response.CachedTokens),
				"cacheWrite": provider.TokenCount(response.CacheWriteTokens),
			})
		},
	}
}

// recordCompactionStart tapes and logs an orchestrator's entry with its budget
// frame.
func (r *run) recordCompactionStart(kind string, window, reserve, envelope int64) {
	r.tape.Record("compaction-start", map[string]any{
		"kind": kind, "thread": r.t.thread.itemID, "window": window, "reserve": reserve, "envelope": envelope,
	})
	r.log.Info("[compaction] started (kind=%s thread=%q window=%d reserve=%d envelope=%d)",
		kind, r.t.thread.itemID, window, reserve, envelope)
}

// recordCompactionOutcome tapes one completed (or aborted) operation with its
// full accounting, and logs it when it was cancelled or failed. outcome is
// "fold", "shrink", "shrink-only", "result", "error", or "cancelled".
func (r *run) recordCompactionOutcome(kind, outcome string, result CompactionResult, extra map[string]any) {
	summary := map[string]any{
		"kind": kind, "thread": r.t.thread.itemID, "outcome": outcome,
		"passes": result.Passes, "calls": result.Calls, "spend": result.EstimatedSpend,
		"input": result.Usage.InputTokens, "output": result.Usage.OutputTokens,
		"cached": result.Usage.CachedTokens, "cacheWrite": result.Usage.CacheWriteTokens,
		"durationMs": result.DurationMs,
	}
	for k, v := range extra {
		summary[k] = v
	}
	r.tape.Record("compaction-outcome", summary)
	if outcome == "cancelled" || outcome == "error" {
		detail := ""
		if len(extra) > 0 {
			detail = fmt.Sprintf(" %v", extra)
		}
		r.log.Info("[compaction] %s (kind=%s thread=%q passes=%d calls=%d input=%d output=%d cached=%d in %dms)%s",
			outcome, kind, r.t.thread.itemID, result.Passes, result.Calls,
			result.Usage.InputTokens, result.Usage.OutputTokens, result.Usage.CachedTokens, result.DurationMs, detail)
	}
}

// usageMap renders hidden-call usage as the nested map shape used in durable
// accounting (item Data, thread YMap, error-item data). recordCompactionOutcome
// deliberately keeps flat top-level keys for the event tape and is not built
// from this.
func usageMap(u CompactionUsage) map[string]any {
	return map[string]any{
		keyInputTokens:      u.InputTokens,
		keyOutputTokens:     u.OutputTokens,
		keyCachedTokens:     u.CachedTokens,
		keyCacheWriteTokens: u.CacheWriteTokens,
	}
}

// compactionAccountingMap renders a CompactionResult as a plain map for
// durable storage (item Data, thread YMap, error-item data).
func compactionAccountingMap(result CompactionResult) map[string]any {
	m := map[string]any{
		keyPasses:         result.Passes,
		keyCalls:          result.Calls,
		keyEstimatedSpend: result.EstimatedSpend,
		keyDurationMs:     result.DurationMs,
		keyUsage:          usageMap(result.Usage),
	}
	if result.SourceFingerprint != "" {
		m[keySourceFingerprint] = result.SourceFingerprint
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
			keyCompactionReason: string(bounded.Reason),
			keyCompactionCalls:  bounded.Calls,
			keyCompactionSpend:  bounded.Spend,
			keyCompactionUsage:  usageMap(bounded.Usage),
		}
	}
	var cancelled *BoundedCompactionCancelledError
	if errors.As(err, &cancelled) {
		m := compactionAccountingMap(cancelled.Result)
		m[keyCompactionReason] = "cancelled"
		return m
	}
	return nil
}
