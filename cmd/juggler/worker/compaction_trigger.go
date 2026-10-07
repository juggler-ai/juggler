//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Automatic compaction: everything that decides to shrink a conversation, and
// does it.
//
// There is one trigger, and it is not in this file — it is the admission
// ceiling (provider.DefaultContextCeilingFraction), evaluated against a fully
// built request before every dispatch. Admission raises a
// ContextCompactionAdvisory at the soft ceiling, and a ContextLimitExceededError
// when a provider rejects a request outright; both arrive here as the same typed
// overflow, so the soft ceiling and the hard wall are one code path. Because a
// dispatch happens between every pair of tool calls, compaction lands in the
// middle of a turn — while a smaller transcript can still help the work in
// progress, rather than after it has finished and a summary is of no use to
// anyone.
//
// Which overflows are believed is the trigger discipline. A provider rejection
// is authoritative. An advisory counts only when its number is anchored to a
// provider-measured prefix (MeasuredPrefix) or when even the estimate exceeds
// the hard window — the character estimator overcounts real transcripts by 2x
// or more, so an unanchored soft-ceiling advisory earns one guard-bypassed
// dispatch instead of a fold, and the provider's answer settles it: a billed
// count that re-anchors admission, or a rejection that re-enters here.
//
// The ladder handleContextOverflow runs, in order: hand a folded /compact thread
// to its summarizer; honour the off switch; shrink an oversized trailing tool
// result in place (a live tool_use/tool_result pair must survive, so it can
// never be folded); then fold the leading run of history — prior summaries
// nested inside it so they never stack — into one summary thread,
// keeping a verbatim suffix within recoverySuffixBudgetFraction of the usable
// window so the fold buys real headroom. Progress is judged structurally — by
// the shape of the durable items, never by a token estimate — and the retry
// after progress dispatches guard-bypassed, so the provider rather than the
// estimator judges whether the fold sufficed. One incident is bounded by
// maxContextRecoveryAttempts.
package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

const (
	// recoverySummaryFloorTokens is the minimum final-summary headroom the
	// reducer window must leave after the verbatim suffix is reserved: the
	// suffix walk stops once another unit would push the reducer window below
	// reserve + floor, keeping the reducer's fit proofs meaningful.
	recoverySummaryFloorTokens int64 = 1000

	// maxContextRecoveryAttempts permits several progressive folds while keeping
	// provider retries small and independent from the reducer's internal call cap.
	maxContextRecoveryAttempts = 4

	// recoverySuffixBudgetFraction is the share of the usable history budget
	// (window minus envelope, reserve and summary floor) a fold may spend on the
	// verbatim suffix it keeps. Recovery triggers at the admission ceiling or at
	// the provider's wall, so a fold that retains everything that merely fits
	// the window puts the retried request straight back at the trigger a few
	// turns later; spending half buys real headroom per incident. The newest
	// unit is exempt (see the suffix walk): a live tool batch that fits the
	// window at all must stay verbatim.
	recoverySuffixBudgetFraction = 0.5
)

// recoverySignature captures the objective structural shape of the target
// items so advance can tell a fold that made real progress from one that
// changed nothing. It measures item count, serialized size, and the id of the
// leading compaction boundary: a fresh fold creates a new summary thread whose
// id lands here, marking genuine progress that count and size can coincidentally
// match across two different attempts (e.g. a shrink-only pass landing on the
// same wire size as the prior fold). Keying off the summary id is safe because
// compactToFit refuses a fold range holding nothing but existing summaries —
// the id only moves when brand-new history is summarized, never by re-wrapping
// summaries alone.
type recoverySignature struct {
	retainedItems int
	foldBoundary  string
	wireSize      int
}

type contextRecoveryResult struct {
	Changed   bool
	Signature recoverySignature
	// FoldedItems is how many durable items the pass folded into a summary
	// thread — zero for shrink-only progress. The ladder uses it to leave the
	// incident's tail notice.
	FoldedItems int
}

type compactionAttempts struct {
	attempts          int
	previousSignature recoverySignature
}

func (s *compactionAttempts) canAttempt() bool {
	return s.attempts < maxContextRecoveryAttempts
}

func (s *compactionAttempts) advance(result contextRecoveryResult, overflow error) (bool, error) {
	if !s.canAttempt() {
		return false, overflow
	}
	s.attempts++
	if !result.Changed || (s.attempts > 1 && result.Signature == s.previousSignature) {
		return false, overflow
	}
	s.previousSignature = result.Signature
	return true, nil
}

func contextLimitFromAdvisory(advisory *provider.ContextCompactionAdvisory) *provider.ContextLimitExceededError {
	return &provider.ContextLimitExceededError{
		EstimatedInputTokens: advisory.EstimatedInputTokens,
		OutputReserveTokens:  advisory.OutputReserveTokens,
		ContextWindowTokens:  advisory.ContextWindowTokens,
		Breakdown:            advisory.Breakdown,
		MeasuredPrefix:       advisory.MeasuredPrefix,
	}
}

// contextGuardLogStepFraction is how far the input estimate must move, as a
// share of the context window, before a standing guard decision is worth
// restating. The window is the yardstick rather than the estimate itself
// because it is what the reader is judging the estimate against, and it scales
// with the model instead of pinning a token count no model agrees on.
const contextGuardLogStepFraction = 0.05

// contextGuardDecision is the last guard decision a worker logged: what it
// decided and on what basis (key), and the estimate it decided against.
type contextGuardDecision struct {
	key      string
	estimate int64
}

// noteContextGuardDecision records a guard decision and reports whether it is
// worth a line.
//
// The guard's decisions are level, not edge. A transcript that cannot be
// reduced re-derives the same verdict on every dispatch, and a dispatch happens
// between every pair of tool calls rather than once per turn, so logging on
// occurrence states one standing condition tens of times. Nothing else in the
// system records these — no error item, no notice, nothing in the transcript —
// which is why the line is kept at all and why it must not become wallpaper.
//
// A decision earns a line when it changes: a different verdict, a different
// basis (a billed count is not a guess), or an estimate that has moved a
// material share of the window. The drift test is what keeps a conversation
// that grows while it cannot shrink legible as a trajectory — a handful of
// lines with the numbers climbing — rather than one line per dispatch.
func (w *ConversationWorker) noteContextGuardDecision(decision, basis string, estimate, window int64) bool {
	key := decision + "\x00" + basis
	// At least one token, so an unknown or tiny window cannot make every repeat
	// "material" and defeat the test it is part of.
	step := max(int64(1), int64(float64(window)*contextGuardLogStepFraction))
	if last := w.lastGuardLog.Load(); last != nil && last.key == key {
		drift := estimate - last.estimate
		if drift < 0 {
			drift = -drift
		}
		if drift < step {
			return false
		}
	}
	w.lastGuardLog.Store(&contextGuardDecision{key: key, estimate: estimate})
	return true
}

// logContextGuardDecision records one guard decision and the numbers behind it,
// unless it only restates the last one (see noteContextGuardDecision).
func (r *run) logContextGuardDecision(decision string, limit *provider.ContextLimitExceededError) {
	if !r.noteContextGuardDecision(decision, limit.InputBasis(), limit.EstimatedInputTokens, limit.ContextWindowTokens) {
		return
	}
	r.log.Info("[context guard] %s (%s=%d reserve=%d window=%d)",
		decision, limit.InputBasis(), limit.EstimatedInputTokens, limit.OutputReserveTokens, limit.ContextWindowTokens)
}

func providerAuthoredContextError(overflow error) error {
	var contextLimit *provider.ContextLimitExceededError
	if errors.As(overflow, &contextLimit) && contextLimit.Cause != nil {
		return fmt.Errorf("%s: %w", contextLimit.Cause.Error(), overflow)
	}
	return overflow
}

// contextOverflow is one context-limit overflow as the recovery ladder sees
// it. A provider rejection and an admission estimate arrive as different error
// types and leave asContextOverflow as this one shape, so the ladder is written
// once for both.
type contextOverflow struct {
	// limit is the normalized overflow (contextLimitFromAdvisory for an
	// estimate).
	limit *provider.ContextLimitExceededError
	// advisory is set when the admission estimate raised the overflow (a
	// silent-truncation guard) rather than a provider rejecting the request.
	// An estimate must never be terminal; cannotReduce is where that decides
	// an outcome.
	advisory bool
	// err is the original error, kept so a terminal outcome can surface the
	// provider-authored cause.
	err error
}

// asContextOverflow classifies err, reporting false when it is not a
// context-limit overflow of either kind.
func asContextOverflow(err error) (contextOverflow, bool) {
	var advisory *provider.ContextCompactionAdvisory
	if errors.As(err, &advisory) {
		return contextOverflow{limit: contextLimitFromAdvisory(advisory), advisory: true, err: err}, true
	}
	var limit *provider.ContextLimitExceededError
	if errors.As(err, &limit) {
		return contextOverflow{limit: limit, err: err}, true
	}
	return contextOverflow{}, false
}

// handleContextOverflow runs the shared bounded-compaction → context-recovery
// ladder for one overflow. recovery is the per-incident attempt budget,
// advanced in place.
//
// A non-nil err is the turn's terminal error. Otherwise retry says what the
// strategy loop does next. True rebuilds the request and dispatches it once
// with the guard bypassed, letting the provider judge it: that follows a fold
// (the fold invalidated the measured anchor, so guarded admission would
// re-judge the compacted history with the raw estimator) and an estimate that
// can be reduced no further. False ends the run quietly, because the incident
// resolved without a turn error (a folded thread summarized, or the reduce was
// cancelled).
//
// An advisory on a request that had already bypassed the guard never reaches
// here: that is a rule about the request, and resolveContextOverflow, which
// holds the request's state, enforces it.
func (r *run) handleContextOverflow(o contextOverflow, recovery *compactionAttempts, modelConfig *ModelConfig) (retry bool, err error) {
	limit := o.limit

	// A browser-folded summary thread reduces in one bounded pass. When this
	// overflow belongs to such a thread, tryBoundedCompaction handles it here.
	if handled, compactErr := r.tryBoundedCompaction(limit, modelConfig); handled {
		if compactErr == nil || errors.Is(compactErr, errBoundedCompactionCancelled) {
			return false, nil
		}
		// Hidden reducer requests bypass the guard, so any error here is a real
		// bounded/provider failure rather than the advisory escaping.
		return false, fmt.Errorf("bounded compaction failed: %w", compactErr)
	}

	// Global off switch: when automatic compaction is disabled, nothing here
	// rewrites history. The manual-fold summarizer above stays enabled (a
	// manually folded thread must still summarize).
	//
	// The request already asked admission for the hard window (buildLLMRequest
	// sets contextCeilingFraction=1 under this same gate), so any advisory
	// reaching here is at the real window rather than the soft ceiling. It is
	// still only an estimate, and an estimate must never be terminal: dispatch
	// one guard-bypassed retry and let the provider be authoritative. If it
	// genuinely does not fit, the rejection returns below and surfaces the
	// provider's own context error, so the user hits the wall — and the "Compact
	// now" affordance — instead of an automatic summarize.
	if !r.autoCompactEnabled() {
		if o.advisory {
			return true, nil
		}
		// Surface the provider's own context error, with a one-line hint that
		// manual /compact still works — the "Compact now" affordance for a
		// deliberately-disabled auto-compaction. Wrapping with %w keeps the
		// provider cause reachable via errors.Is/As.
		return false, fmt.Errorf("%w\n\nContext limit reached — run /compact to summarize the conversation and continue",
			providerAuthoredContextError(o.err))
	}

	// Trigger discipline: an unanchored advisory is the character estimator's
	// word alone, and the estimator overcounts real transcripts by a factor of
	// two or more — acting on it summarizes conversations at half their real
	// ceiling. An estimate may convict only what it says cannot fit the hard
	// window at all (the one protection a silently-truncating provider gets);
	// the soft ceiling belongs to measured numbers. Everything else dispatches
	// once with the guard bypassed and lets the provider judge: an accepted
	// dispatch re-anchors admission with its billed count, and a rejection
	// re-enters here as an authoritative overflow.
	if o.advisory && !limit.MeasuredPrefix &&
		provider.SaturatingAdd(limit.EstimatedInputTokens, limit.OutputReserveTokens) <= limit.ContextWindowTokens {
		r.logContextGuardDecision("unanchored estimate fits the window; dispatching bypassed for a measured verdict", limit)
		return true, nil
	}

	// Ordinary root / subthread turn: summarize or shrink durable history, then
	// rebuild and retry only when its objective shape changed.
	if !recovery.canAttempt() {
		return r.cannotReduce(o,
			"recovery attempt bound reached; dispatching one fallback",
			fmt.Sprintf("stopped after %d progressive attempts", recovery.attempts))
	}

	// Said before recovery runs, so a recovery that then fails still leaves the
	// reason it ran so early on screen. Appending here cannot read as recovery
	// progress: compactToFit takes its before-signature after this.
	if notice, ok := r.assumedWindowNotice(modelConfig); ok {
		r.appendTargetMessage(notice)
	}
	result, recErr := r.compactToFit(limit, modelConfig)
	if errors.Is(recErr, errBoundedCompactionCancelled) {
		return false, nil
	}
	if recErr != nil {
		// A concrete recovery failure (reducer call, concurrent source change,
		// persistence) is its own terminal error — a silent stop would look like
		// a dead conversation. Only the advisory estimate must never be terminal.
		// limit.Cause is nil for an advisory estimate, so the wrap only fires on
		// a provider rejection that carried a cause.
		err := fmt.Errorf("context recovery failed: %w", recErr)
		if limit.Cause != nil {
			err = fmt.Errorf("%w (provider: %s)", err, limit.Cause.Error())
		}
		return false, err
	}
	// Structural progress: the fold (or shrink) just proved with pessimistic
	// per-item estimates that the retained history fits the window, and it also
	// invalidated the measured-prefix anchor — so the one wrong move is to hand
	// the retry back to guarded admission, whose unanchored estimate overcounts
	// the very transcript the fold produced. Dispatch bypassed and let the
	// provider judge: an accepted retry re-anchors admission with its billed
	// count, and a rejection re-enters here with the attempt budget as the bound.
	if progressed, _ := recovery.advance(result, o.err); progressed {
		if result.FoldedItems > 0 {
			r.insertCompactionNotice(result.FoldedItems)
		}
		return true, nil
	}
	return r.cannotReduce(o,
		"nothing left to reduce; dispatching one irreducible fallback",
		"stopped because the request structure did not change")
}

// cannotReduce is the ladder's last move once recovery can do no more, and the
// one place the two overflow kinds part ways by outcome. An advisory is only an
// estimate and must never be terminal, so it earns one guard-bypassed dispatch
// and the provider judges; guardDecision is the context-guard line that says
// so. A provider rejection is authoritative. It is surfaced as the provider
// authored it, never replaced with a local estimate or retry-limit error, so
// errors.Is/As still reach its Cause; stopLine is the compaction log line that
// says why recovery stopped.
func (r *run) cannotReduce(o contextOverflow, guardDecision, stopLine string) (retry bool, err error) {
	if o.advisory {
		r.logContextGuardDecision(guardDecision, o.limit)
		return true, nil
	}
	r.log.Info("[compaction] %s", stopLine)
	return false, providerAuthoredContextError(o.err)
}

func contextRecoverySignature(items []ConversationItem) recoverySignature {
	raw, _ := json.Marshal(items)
	boundary := ""
	for _, item := range items {
		if item.Type == ItemTypeThread && item.BoundedCompaction {
			boundary = item.ItemID
			break
		}
	}
	return recoverySignature{
		retainedItems: len(items),
		foldBoundary:  boundary,
		wireSize:      len(raw),
	}
}

func contextRecoveryOutcome(before recoverySignature, items []ConversationItem) contextRecoveryResult {
	after := contextRecoverySignature(items)
	return contextRecoveryResult{Changed: after != before, Signature: after}
}

// recoveryUnit is an atomic fold-boundary unit over the target items array:
// [start, end) is either a single item or a run of same-transaction
// tool-actions (mirroring buildMessages batching, so a fold boundary can never
// split a tool_use/tool_result batch). est is the unit's estimated wire size.
type recoveryUnit struct {
	start, end int
	est        int64
}

// compactToFit recovers an ordinary root or subthread turn whose request
// was rejected by the provider for context size. It reports objective structural
// progress from the durable item shape; the advisory token estimate is used for
// planning only and is never the progress criterion.
//
// Every failure path returns a typed error: BoundedCompactionError for
// deterministic recovery failures, BoundedCompactionCancelledError (matching
// errBoundedCompactionCancelled) when interrupted mid-reduce.
func (r *run) compactToFit(limitErr *provider.ContextLimitExceededError, modelConfig *ModelConfig) (contextRecoveryResult, error) {
	if !r.exclusivelyOwnsConversation() {
		return contextRecoveryResult{}, errBoundedCompactionCancelled
	}
	before := contextRecoverySignature(r.getTargetItems())
	if r.compactionCancelled() {
		return contextRecoveryResult{}, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "context recovery")
	if err != nil {
		return contextRecoveryResult{}, err
	}
	window := limitErr.ContextWindowTokens
	reserve := limitErr.OutputReserveTokens
	if window <= 0 {
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionContextBound, Message: "context recovery requires a known context window", Window: window}
	}

	// Everything admission counted that is not per-message content is the
	// fixed envelope (system prompt, tools, framing, ids, provider overhead).
	envelope := limitErr.Breakdown.Total - limitErr.Breakdown.MessageTokens - limitErr.Breakdown.ImageTokens
	if envelope < 0 {
		envelope = 0
	}

	r.beginCompactionStatus("Compacting")
	r.recordCompactionStart(compactionKindAuto, window, reserve, envelope)

	// A trailing tool-result payload too large for the suffix budget can never
	// be folded — folding would destroy the live tool pair. Shrink oversized
	// results in place to reducer-generated summaries first; the pair stays
	// intact on the wire and in the visible doc (the full result survives in
	// its transaction blob).
	if err := r.shrinkOversizedTrailingToolResults(limitErr, &pinnedModel, envelope); err != nil {
		return contextRecoveryResult{}, err
	}

	// The synthesized prompt item id: it lives inside the folded thread's nested
	// items, never in the target array, so it matches nothing there and excludes
	// nothing from the canonical fingerprint — it just replaces the old
	// recoveryPromptSentinel and becomes the thread's CompactionPromptItemID.
	promptID := generateItemID()

	items := r.getTargetItems()
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "context recovery could not encode canonical source: " + err.Error(), Cause: err}
	}
	if len(records) == 0 {
		return contextRecoveryOutcome(before, items), nil
	}
	fingerprint := compactionSourceFingerprint(records)

	units := recoveryAtomicUnits(items)
	// A delegated thread's most recent invocation message is pinned on top of
	// the per-item rules: it is where the run in flight will stamp its outcome,
	// and where the thread's liveness is read from (lastInvocationIndex). Every
	// earlier one folds with the run bodies around it, its record preserved on
	// the fold, so a long-lived session folds every completed run in one stretch.
	pinnedInvocation := lastInvocationIndex(items)
	foldable := func(u recoveryUnit) bool {
		return u.start != pinnedInvocation && recoveryUnitFoldable(items[u.start])
	}

	// Leading non-conversational items (rules, plans, other standing context)
	// are pinned: they render through the system prompt (already inside the
	// envelope) and must never be folded. The summary is inserted after them.
	skip := 0
	for skip < len(units) && !foldable(units[skip]) {
		skip++
	}

	// Walk units backward, keeping a verbatim suffix within the fold's retain
	// budget. fullBudget is everything the window can hold after the fixed
	// envelope, the output reserve and the reducer's summary floor; the walk
	// spends only recoverySuffixBudgetFraction of it, so the fold creates
	// headroom instead of stopping at the very pressure that triggered it. The
	// newest unit alone is granted the full budget: a live tool batch that fits
	// the window must survive verbatim (folding it would sever the open tool
	// pair; shrinking is reserved for results that can never fit at all). A
	// pinned unit stops the walk — the fold boundary may not cross it.
	fullBudget := window - envelope - reserve - recoverySummaryFloorTokens
	suffixBudget := int64(float64(fullBudget) * recoverySuffixBudgetFraction)
	k := len(units)
	var suffixEst int64
	for k > skip {
		unit := units[k-1]
		if !foldable(unit) {
			break
		}
		budget := suffixBudget
		if k == len(units) {
			budget = fullBudget
		}
		if suffixEst+unit.est > budget {
			break
		}
		suffixEst += unit.est
		k--
	}
	if k == len(units) {
		return contextRecoveryOutcome(before, items), nil
	}
	// The suffix walk stops at the first pinned unit from the back, but another
	// pinned unit (an in-flight unsummarized fold, an earlier invocation
	// message) can still sit deeper inside [skip, k) with foldable history on
	// both sides of it. The fold is a single contiguous range, so clamp k to
	// the first pinned unit at or after skip — the fold covers only the leading
	// contiguous run and leaves the pin (and everything after it) untouched.
	// units[skip] is foldable by construction, so k stays > skip.
	for p := skip; p < k; p++ {
		if !foldable(units[p]) {
			k = p
			break
		}
	}
	if k <= skip {
		// Every foldable unit fits verbatim within the window, so there is
		// nothing this pass can usefully fold. Two ways to arrive here:
		// shrinkOversizedTrailingToolResults above brought an oversized trailing
		// result under budget, or admission sized the request from a measured
		// prefix while this walk sizes it from per-item estimates, and the two
		// disagree about whether it fits. Either way the answer is the same —
		// succeed and let the caller's retry proceed against this history rather
		// than summarizing history the walk says needs no summary. Admission on
		// the retry is the backstop if that judgement is optimistic: a request
		// that really is over the ceiling is rejected again, and the caller's
		// attempt bound turns a repeat into the bypassed fallback dispatch.
		r.recordCompactionOutcome(compactionKindAuto, "shrink-only", CompactionResult{}, map[string]any{"suffixTokens": suffixEst})
		r.log.Info("[compaction] trailing-result shrink sufficed; no history fold needed (suffix=%d tokens)", suffixEst)
		return contextRecoveryOutcome(before, items), nil
	}

	prefixStart := units[skip].start
	prefixEnd := units[k-1].end
	// A range holding nothing but already-summarized compaction threads would
	// only re-summarize existing summaries — nothing fresh, no progress
	// (mirrors the manual fold's guard, and keeps the foldBoundary progress
	// signal honest: a new summary id always means brand-new history folded).
	hasFresh := false
	for _, it := range items[prefixStart:prefixEnd] {
		if !summarizedCompactionThread(it) {
			hasFresh = true
			break
		}
	}
	if !hasFresh {
		return contextRecoveryOutcome(before, items), nil
	}
	prefixRecords := records[prefixStart:prefixEnd]
	// The hidden compaction calls are independent requests against the full
	// context window: providerOverhead accounts for the provider's fixed overhead
	// exactly once. Subtracting envelope+suffix from the window would double-count
	// that overhead (envelope already includes it) and wrongly charge the original
	// request's system prompt and tools, which the hidden calls do not carry — on
	// a large fixed overhead (e.g. the Claude Code CLI's 40k) the reduced window
	// cannot even fit the empty hidden envelope, bricking recovery. The folded
	// summary is kept fittable by the suffix walk above, which already reserved
	// reserve + recoverySummaryFloorTokens of headroom for it.
	budget := boundedCompactionBudget{
		window:           window,
		reserve:          reserve,
		providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
		// The rejected original request is seeded into the reported accounting;
		// spend gates nothing (see boundedCompactionBudget).
		spend: provider.SaturatingAdd(limitErr.EstimatedInputTokens, reserve),
		calls: 1,
	}

	result, err := r.runReducer(compactionKindAuto, pinnedModel, budget, prefixRecords)
	if err != nil {
		return contextRecoveryResult{}, err
	}

	// Recovery synthesizes the same folded-thread shape /compact produces rather
	// than a bespoke flat summary item: the folded prefix is preserved as the
	// thread's nested items (for undo/inspection and future re-folding) — prior
	// summarized compaction threads nested whole (condenseForRefold),
	// everything else verbatim — a synthesized prompt item is referenced by
	// CompactionPromptItemID (and thereby excluded from canonical history), and
	// the reducer's summary + accounting live on the thread. It renders to the
	// wire through the same bounded-compaction thread path as a browser fold
	// (buildThreadResultMap's inert framing).
	promptItem := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  promptID,
		Content: defaultSummarizationPromptMarker,
	}
	nested := make([]ConversationItem, 0, prefixEnd-prefixStart+1)
	for _, it := range items[prefixStart:prefixEnd] {
		nested = append(nested, condenseForRefold(it))
	}
	nested = append(nested, promptItem)
	nestedJSON, err := json.Marshal(nested)
	if err != nil {
		r.recordCompactionOutcome(compactionKindAuto, "error", result, map[string]any{"reason": string(BoundedCompactionSourceEncoding)})
		return contextRecoveryResult{}, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "context recovery could not encode folded thread items: " + err.Error(), Cause: err}
	}
	resultJSON, _ := json.Marshal(result.Summary)
	summaryItem := ConversationItem{
		Type:                   ItemTypeThread,
		ItemID:                 generateItemID(),
		Timestamp:              time.Now().Format(time.RFC3339),
		Goal:                   "Compacted conversation history",
		Summary:                fmt.Sprintf("Summarized %d earlier items to fit the context window", prefixEnd-prefixStart),
		BoundedCompaction:      true,
		CompactionPromptItemID: promptID,
		Items:                  nestedJSON,
		Result:                 resultJSON,
		FoldedRuns:             foldedRunsIn(items[prefixStart:prefixEnd]),
		// The fold is spliced where the folded history began, far above a reader
		// parked at the tail, and a thread item is the auto-select fallback: left
		// selectable it takes the column out from under whoever is reading. The
		// browser /compact fold opts out for the same reason.
		NoAutoSelect: true,
	}
	// Persist the operation's accounting durably on the thread item itself — the
	// doc is the inspectable record of what the fold cost.
	summaryItem.Data, _ = json.Marshal(compactionAccountingMap(result))

	// Commit only against the exact snapshot the reducer consumed. The
	// fingerprint recheck and the fold run under one ycrdtMu hold inside
	// foldPrefixIntoSummaryTracked, so a concurrent doc change (user edit,
	// queued-message promotion) that lands between check and write cannot leave
	// the fold splicing at stale indices — it aborts rather than clobbering. The
	// tracked variant captures the whole delete+insert as one undo group, so a
	// single undo reverses the fold (parity with the browser /compact fold).
	if !r.foldPrefixIntoSummaryTracked(r.getTargetItemsYArray(), prefixStart, prefixEnd-prefixStart, summaryItem, promptID, fingerprint) {
		r.recordCompactionOutcome(compactionKindAuto, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return contextRecoveryResult{}, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "conversation changed during context recovery; nothing was folded",
			Calls: result.Calls, Spend: result.EstimatedSpend,
			Window: budget.window, Usage: result.Usage,
		}
	}
	r.recordCompactionOutcome(compactionKindAuto, "fold", result, map[string]any{
		"foldedItems": prefixEnd - prefixStart, "suffixTokens": suffixEst, "window": window,
	})
	r.log.Info("[compaction] folded %d items into a compaction summary (passes=%d calls=%d spend=%d window=%d suffix=%d tokens)",
		prefixEnd-prefixStart, result.Passes, result.Calls, result.EstimatedSpend, window, suffixEst)
	outcome := contextRecoveryOutcome(before, r.getTargetItems())
	outcome.FoldedItems = prefixEnd - prefixStart
	return outcome, nil
}

// insertCompactionNotice leaves a durable, wire-invisible record of an
// automatic fold at the point in the conversation where it happened. The
// summary thread itself is spliced where the folded history BEGAN — usually far
// above the reader — so without this the tail shows no trace of the incident
// beyond a transient status frame. Goes through appendTargetMessage like the
// other turn notices; itemWireMessages has no case for notices, so the model
// never reads it.
func (r *run) insertCompactionNotice(foldedItems int) {
	source := ""
	if mc := r.resolveModelConfig(); mc != nil {
		source = mc.Provider
	}
	r.appendTargetMessage(ConversationItem{
		Type:   ItemTypeNotice,
		ItemID: generateItemID(),
		// The row's whole text: what happened, how much of it, and the one thing
		// a reader watching their context fill actually wants to know.
		Summary: fmt.Sprintf("Folded %d earlier items into a summary thread. Nothing was discarded.", foldedItems),
		Content: fmt.Sprintf("The conversation neared the model's context window, so the oldest %d items were folded into a summary thread, "+
			"which stands where the folded history began. It keeps those items verbatim; undo restores them.\n\n"+
			"Not folded: standing context (the system prompt, agents files and memory), the recent conversation, "+
			"and the invocation that set a sub-thread's task.", foldedItems),
		Source:    source,
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// assumedWindowNoticeData is the Data payload of a notice about an assumed
// context window: where the window is corrected, and which window it was, so
// the same guess is reported once per conversation rather than at every fold.
// The browser reads Settings to draw the notice's one action.
type assumedWindowNoticeData struct {
	Settings struct {
		Tab      string `json:"tab"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Field    string `json:"field"`
	} `json:"settings"`
	AssumedWindow int `json:"assumedWindow"`
}

// assumedWindowNotice builds the notice a compaction leaves when the window it
// compacts against is a guess: the provider reported none for this model, no
// catalogue entry knew it, and the user has not set one. That window decides
// when the conversation folds and, since the reply budget is derived from it,
// how long every reply and summary may run — so a model loaded with far more
// than the guess compacts early and answers short, and nothing else on screen
// says why. The notice names the window and carries a link to the one field
// that corrects it.
//
// mc is the model the compaction is for (the rejected request's model); nil
// means the conversation's effective model. Reports false when the window is
// not assumed, is unknown, or this conversation already carries a notice for
// the same model and window.
func (r *run) assumedWindowNotice(mc *ModelConfig) (ConversationItem, bool) {
	if r.windowResolver == nil {
		return ConversationItem{}, false
	}
	if mc == nil {
		if mc = r.resolveModelConfig(); mc == nil {
			return ConversationItem{}, false
		}
	}
	info := r.windowResolver(*mc)
	if !info.Assumed || info.WindowTokens <= 0 {
		return ConversationItem{}, false
	}

	var data assumedWindowNoticeData
	data.Settings.Tab = "providers"
	data.Settings.Provider = mc.Provider
	data.Settings.Model = mc.Model
	data.Settings.Field = "contextWindow"
	data.AssumedWindow = info.WindowTokens
	if r.hasAssumedWindowNotice(data) {
		return ConversationItem{}, false
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return ConversationItem{}, false
	}
	return ConversationItem{
		Type:   ItemTypeNotice,
		ItemID: generateItemID(),
		Summary: fmt.Sprintf("Compacting at an assumed %d-token context window for %s — set the real size in Settings.",
			info.WindowTokens, mc.Model),
		Content: fmt.Sprintf("The server didn't report the context window for %s, so Juggler assumed %d tokens. "+
			"That figure decides when this conversation is compacted, and each reply — compaction summaries included — "+
			"is capped at %d tokens because of it. A model loaded with a larger window compacts far sooner than it needs "+
			"to and writes shorter answers.\n\n"+
			"Enter the window the model is actually loaded with in Settings → Providers, on this model's row. "+
			"It applies from the next turn.",
			mc.Model, info.WindowTokens, info.ReserveTokens),
		Source:    mc.Provider,
		Data:      raw,
		Timestamp: time.Now().Format(time.RFC3339),
	}, true
}

// hasAssumedWindowNotice reports whether root or the current target already
// holds a notice about this same model and assumed window.
func (r *run) hasAssumedWindowNotice(want assumedWindowNoticeData) bool {
	for _, items := range [][]ConversationItem{r.doc.GetItems(), r.getTargetItems()} {
		for _, item := range items {
			if item.Type != ItemTypeNotice || len(item.Data) == 0 {
				continue
			}
			var got assumedWindowNoticeData
			if json.Unmarshal(item.Data, &got) == nil && got == want {
				return true
			}
		}
	}
	return false
}

// recoveryShrunkResultMarker prefixes a tool result that was replaced by a
// reducer-generated summary because it could never fit the model context.
const recoveryShrunkResultMarker = "[tool result exceeded the model context window and was summarized]\n\n"

// shrinkOversizedTrailingToolResults handles the active-tool-loop case: the
// newest history unit is a tool-action batch whose result payload alone busts
// the suffix budget, so the suffix walk could never keep it and folding it
// would destroy the live tool pair. Each oversized result in that trailing
// batch is summarized in place with the bounded reducer (the reducer rune-
// splits a single result larger than one map budget across calls); the tool
// call and its (now summarized) result stay paired on the wire and in the
// visible doc. No-op when the trailing unit fits or is not a tool batch.
func (r *run) shrinkOversizedTrailingToolResults(limitErr *provider.ContextLimitExceededError, pinnedModel *ModelConfig, envelope int64) error {
	window := limitErr.ContextWindowTokens
	reserve := limitErr.OutputReserveTokens

	items := r.getTargetItems()
	units := recoveryAtomicUnits(items)
	if len(units) == 0 {
		return nil
	}
	trailing := units[len(units)-1]
	if items[trailing.start].Type != ItemTypeToolAction {
		return nil
	}
	if window-envelope-trailing.est >= reserve+recoverySummaryFloorTokens {
		return nil // the trailing batch fits the suffix budget as-is
	}

	for i := trailing.start; i < trailing.end; i++ {
		item := items[i]
		var resultBlob map[string]any
		if err := json.Unmarshal(item.Result, &resultBlob); err != nil {
			continue
		}
		resultContent, _ := resultBlob["content"].(string)
		if resultContent == "" {
			continue
		}
		contentEst := provider.EstimateMessageRequestTokenBreakdown(provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: resultContent}},
		}, 0).Total
		if contentEst <= recoverySummaryFloorTokens {
			continue
		}

		// The shrink call is an independent request against the full context
		// window; providerOverhead counts the provider's fixed overhead once. A
		// tiny reserve+floor window would never fit even the empty hidden envelope
		// on providers with a large fixed overhead (e.g. the Claude Code CLI's
		// 40k), which is what deterministically bricked this path. The shrunk
		// summary is bounded by the wire max_tokens (= reserve), so it still lands
		// inside the suffix headroom the trailing-fits gate above requires.
		budget := boundedCompactionBudget{
			window:           window,
			reserve:          reserve,
			providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
		}
		reducer := r.newBoundedReducer(compactionKindShrink, *pinnedModel, budget)
		shrunk, err := reducer.run([]string{resultContent})
		if err != nil {
			if errors.Is(err, errBoundedCompactionCancelled) {
				r.recordCompactionOutcome(compactionKindShrink, "cancelled", shrunk, map[string]any{"toolUseId": item.ToolUseID})
				return &BoundedCompactionCancelledError{Result: shrunk}
			}
			r.recordCompactionOutcome(compactionKindShrink, "error", shrunk, map[string]any{"toolUseId": item.ToolUseID})
			return err
		}
		if r.compactionCancelled() {
			r.recordCompactionOutcome(compactionKindShrink, "cancelled", shrunk, map[string]any{"toolUseId": item.ToolUseID})
			return &BoundedCompactionCancelledError{Result: shrunk}
		}
		// Only the wire-visible content changes. The rest of the blob rides
		// through untouched: the transcript row reads its completed state off
		// result.fullResult, so replacing the field wholesale would leave a
		// finished tool call rendering as though it were still running.
		resultBlob["content"] = recoveryShrunkResultMarker + shrunk.Summary
		if err := r.updateTargetItemByID(item.ItemID, "result", resultBlob); err != nil {
			return &BoundedCompactionError{
				Reason: BoundedCompactionSourceChanged, Message: "tool result disappeared during context recovery: " + err.Error(),
				Calls: shrunk.Calls, Spend: shrunk.EstimatedSpend, Window: reducer.budget.window, Usage: shrunk.Usage,
			}
		}
		r.recordCompactionOutcome(compactionKindShrink, "shrink", shrunk, map[string]any{"toolUseId": item.ToolUseID})
		r.log.Info("[compaction] summarized oversized tool result %s in place (calls=%d spend=%d)",
			item.ToolUseID, shrunk.Calls, shrunk.EstimatedSpend)
	}
	return nil
}

// recoveryUnitFoldable reports whether an item may join the summarized prefix
// or the verbatim suffix: conversational items only. Standing context items
// (rules, plans, system prompts) are pinned in place.
//
// A prior summarized compaction thread is ordinary foldable content: a re-fold
// nests it, transcript and all (condenseForRefold), while the model sees only its
// goal + result, so the conversation converges to [standing context]
// [one summary thread][recent tail] exactly as the browser /compact fold does.
// Pinning prior summaries instead is the stacking failure mode: each pinned
// summary fragments the next fold's contiguous range, so passes fold ever
// thinner slivers while summaries accumulate at the top. Only an in-flight
// fold that has not yet committed its summary is pinned
// (pendingCompactionFold); the summary-only-range guard in compactToFit keeps
// a re-fold from ever summarizing nothing but existing summaries.
//
// The caller applies one further pin this cannot see, because it is positional:
// the thread's most recent invocation message (lastInvocationIndex).
func recoveryUnitFoldable(item ConversationItem) bool {
	if pendingCompactionFold(item) {
		return false
	}
	return isConversationalItemType(item.Type)
}

// recoveryAtomicUnits groups items into fold-boundary units. A run of
// consecutive tool-actions sharing one non-empty TransactionID is a single
// unit (buildMessages emits that run as one batched use/result group, so a
// boundary inside it would sever tool pairs); every other item is a singleton.
func recoveryAtomicUnits(items []ConversationItem) []recoveryUnit {
	units := make([]recoveryUnit, 0, len(items))
	for i := 0; i < len(items); {
		end := i + 1
		if items[i].Type == ItemTypeToolAction && items[i].TransactionID != "" {
			for end < len(items) && items[end].Type == ItemTypeToolAction &&
				items[end].TransactionID == items[i].TransactionID {
				end++
			}
		}
		units = append(units, recoveryUnit{start: i, end: end, est: estimateItemsWireTokens(items[i:end], items)})
		i = end
	}
	return units
}

// estimateItemsWireTokens estimates the admission-side token size of the wire
// messages a unit produces, built through the same message builders as
// buildMessages and json-round-tripped into provider.Message — the exact
// decoding admission sees — so image parts and per-message framing are counted
// identically. Estimation is side-effect free: an unfinished tool result uses
// the same placeholder text appendToolActionResult would emit, without its
// resultFedTurn doc stamp.
//
// siblings is the whole array the unit was cut from: a thread alias reads its
// run's record off the canonical thread item standing there, which is usually
// outside the unit itself.
func estimateItemsWireTokens(items, siblings []ConversationItem) int64 {
	messages := make([]map[string]any, 0, len(items)*2)
	for _, item := range items {
		switch item.Type {
		case ItemTypeUser:
			messages = append(messages, buildUserMessageMap(item))
		case ItemTypeAssistant:
			messages = append(messages, map[string]any{"type": "assistant", "content": item.Content})
		case ItemTypeThinking:
			if item.Content != "" {
				m := map[string]any{"type": "thinking", "content": item.Content}
				if len(item.ProviderData) > 0 {
					m["providerData"] = item.ProviderData
				}
				messages = append(messages, m)
			}
		case ItemTypeToolAction:
			if item.ToolUseID == "" || item.ToolName == "" {
				continue
			}
			messages = append(messages, buildToolUseMap(item))
			if rm := buildToolResultMap(item); rm != nil {
				messages = append(messages, rm)
			} else {
				messages = append(messages, map[string]any{
					"type":      "tool-result",
					"toolUseId": item.ToolUseID,
					"content":   pendingToolResultPlaceholder,
					"isError":   true,
				})
			}
		case ItemTypeThread:
			messages = appendThreadMessages(messages, item, siblings)
		case ItemTypeMetaToolResult:
			if item.ToolName != "" {
				messages = append(messages, buildToolUseMap(item))
			}
			if item.Result != nil {
				if rm := buildToolResultMap(item); rm != nil {
					messages = append(messages, rm)
				}
			}
		case ItemTypeSystemReminder, ItemTypeGuidance:
			if item.Content != "" {
				messages = append(messages, map[string]any{"type": item.Type, "content": item.Content})
			}
		}
	}
	// A well-formed items slice always round-trips; on the (essentially
	// impossible) encode failure, charge a large-but-non-overflowing sentinel so
	// the unit is treated as too big to keep verbatim (forced into the fold)
	// rather than free. MaxInt32 dwarfs any real context window yet stays far
	// below MaxInt64, so the downstream non-saturating suffix arithmetic cannot
	// overflow.
	const unestimableUnitTokens = int64(math.MaxInt32)
	raw, err := json.Marshal(messages)
	if err != nil {
		return unestimableUnitTokens
	}
	var pmsgs []provider.Message
	if err := json.Unmarshal(raw, &pmsgs); err != nil {
		return unestimableUnitTokens
	}
	return provider.EstimateMessageRequestTokenBreakdown(provider.MessageRequest{Messages: pmsgs}, 0).Total
}
