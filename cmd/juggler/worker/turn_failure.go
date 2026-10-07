//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// runFoldedCompactionTurn runs a browser-folded /compact (or /handoff) thread's
// turn, which is summarized by the bounded reducer rather than an ordinary
// strategy turn: probe the whole transcript once and, on a provider overflow,
// map/reduce it. This is the single summarizer, committing through
// writeBoundedCompactionResult. handled is false when the thread is not such a
// fold (or already has its summary), and the caller runs an ordinary turn. When
// handled, the turn is over; the deferred cleanup drives idle, which collapses
// the fold + summary into one undo group (compactionMergeFromIdx).
func (r *run) runFoldedCompactionTurn() (verdict turnVerdict, handled bool) {
	threadID := r.t.thread.itemID
	if threadID == "" || !r.isBoundedCompactionThread(threadID) || r.threadHasResult(threadID) {
		return turnContinue, false
	}
	itemIDs := r.foldedCompactionContextItemIDs(threadID)
	ctxResult, tools, prepErr := r.requestContextAndToolsForItemIDs(itemIDs)
	if prepErr != nil {
		if !errors.Is(prepErr, ErrCancelled) {
			r.sendError(fmt.Sprintf("Failed to get context/tools for compaction: %v", prepErr), "")
		}
		return turnDone, true
	}
	handled, compactErr := r.runFoldedThreadCompaction(r.resolveModelConfig(), ctxResult, tools)
	if !handled {
		return turnContinue, false
	}
	if compactErr != nil && !errors.Is(compactErr, errBoundedCompactionCancelled) {
		r.log.Error("❌ compaction error: %s", compactErr.Error())
		errorData := map[string]any{}
		for k, v := range compactionErrorData(compactErr) {
			errorData[k] = v
		}
		r.sendErrorWithData(compactErr.Error(), "", errorData)
	}
	// The fold committed before this run started, so ending without a
	// summary leaves the parent holding a fold tile and nothing else.
	// Mark it, whatever the reason: an error item goes inside the
	// sub-thread where the parent cannot show it, and cancellation
	// writes nothing at all. Checked against the thread rather than
	// against compactErr because a partial run may still have committed.
	if compactErr != nil && !r.threadHasResult(threadID) {
		// One message either way so the state is greppable by one string,
		// but a fold the human cancelled is an outcome, not a fault: only a
		// genuine failure is worth an ERROR in a log someone is scanning for
		// what broke.
		line := "[compaction] fold %s left unsummarized: %s"
		if errors.Is(compactErr, errBoundedCompactionCancelled) {
			r.log.Info(line, threadID, compactErr.Error())
		} else {
			r.log.Error(line, threadID, compactErr.Error())
		}
		r.setCompactionUnsummarized(threadID)
	}
	r.t.txnID = ""
	return turnDone, true
}

// handleTurnFailure decides what a failed LLM call means for the run. The
// transaction blob is already saved, and r.t.txnID still names it, so every
// error item inserted here is stamped with it and its View Transaction button
// opens that blob. Every path clears r.t.txnID before returning.
//
// The failures are tried in this order, and the order matters:
//   - cancellation ends the turn silently;
//   - an unusable provider (Guard B), an authentication refusal, and a
//     provider that can't run here (a missing CLI) are user-fixable setup
//     problems, terminal and never retried, and are
//     checked before any context-limit handling because they are unrelated to
//     it;
//   - a context overflow (or a silent-truncation advisory) may stop, retry
//     without the pre-flight guard, or become a terminal error of its own;
//   - a dated usage cap is latched for the whole conversation;
//   - anything else is reported as it stands.
func (r *run) handleTurnFailure(st *strategyRunState, err error, llmRequest json.RawMessage, duration time.Duration) turnVerdict {
	defer func() { r.t.txnID = "" }()

	if errors.Is(err, ErrCancelled) {
		return turnDone
	}
	if errors.Is(err, ErrProviderUnavailable) {
		r.reportProviderUnavailable(err, duration)
		return turnDone
	}
	// The provider refused a call it actually made, on authentication
	// grounds. Guard B cannot catch this: it fires when credential
	// resolution fails beforehand, and a CLI-backed provider resolves no
	// credential of its own — the refusal is the first sign the login has
	// lapsed. Same terminal shape as Guard B, and equally never retried.
	var authErr *provider.AuthError
	if errors.As(err, &authErr) {
		r.reportUserFixableFailure(userFixableFailure{
			provider: authErr.Provider, hint: authErr.Hint, message: authErr.Message,
			defaultLead: "The provider isn't signed in.", kind: "auth", code: "auth-required", logLabel: "authentication",
		}, err, duration)
		return turnDone
	}
	// The provider can't run on this machine at all (a CLI it drives isn't
	// installed). Nothing was attempted, so it is as terminal as an auth
	// refusal and just as pointless to retry.
	var setupErr *provider.SetupError
	if errors.As(err, &setupErr) {
		r.reportUserFixableFailure(userFixableFailure{
			provider: setupErr.Provider, hint: setupErr.Hint, message: setupErr.Message,
			defaultLead: "The provider isn't set up on this machine.", kind: "setup", code: "provider-setup", logLabel: "setup",
		}, err, duration)
		return turnDone
	}

	verdict, settled, err := r.resolveContextOverflow(st, err, llmRequest)
	if settled {
		return verdict
	}

	r.log.Error("❌ LLM error: %s", err.Error())
	errorData := r.turnErrorData(duration)
	// A failed bounded compaction / context recovery still leaves its
	// partial accounting on the durable error item.
	for k, v := range compactionErrorData(err) {
		errorData[k] = v
	}

	var rateLimit *RateLimitError
	if errors.As(err, &rateLimit) && !rateLimit.ResetAt.IsZero() {
		r.restOnRateLimit(rateLimit, err, errorData)
		return turnDone
	}

	r.sendErrorWithData(err.Error(), "", errorData)
	return turnDone
}

// turnErrorData is the accounting every terminal-error item carries: how long
// the failed call took, and which model it was made against.
func (r *run) turnErrorData(duration time.Duration) map[string]any {
	errorData := map[string]any{"duration": duration.Milliseconds()}
	if mc := r.resolveModelConfig(); mc != nil {
		errorData["provider"] = mc.Provider
		errorData["model"] = mc.Model
	}
	return errorData
}

// reportProviderUnavailable handles Guard B: the selected model's provider
// can't be used (no API key, provider disabled, OAuth not signed in, sign-in
// expired). That is a user-fixable setup problem, so it carries the
// validation-error code "provider-unavailable" — prompt to pick another model,
// never auto-retry.
func (r *run) reportProviderUnavailable(err error, duration time.Duration) {
	msg := "The selected model's provider can't be used. Pick another model, or configure it in settings."
	errorData := r.turnErrorData(duration)
	if mc := r.resolveModelConfig(); mc != nil {
		msg = fmt.Sprintf("The provider for %s (%s) can't be used. Pick another model, or configure %s in settings.", mc.Model, mc.Provider, mc.Provider)
	}
	// Carry the resolver's own account of what is wrong ("codex access
	// token is expired; sign in with the Codex app or run `codex
	// login`"). The lead says what to do, the detail says why, and a
	// credential failure is barely actionable without it — an expired
	// sign-in reads as a lie when reported as "isn't configured".
	if detail := providerUnavailableDetail(err); detail != "" {
		msg += "\n\n" + detail
	}
	// This ends the turn, so it needs a durable record like any other
	// terminal failure. The validation-error status alone is a
	// client-side transient notice: it is a timed toast when the
	// conversation is on screen and nothing at all when it isn't, so a
	// credential that lapses mid-loop leaves a turn that simply stops.
	// Insert the item first, while turn.txnID still stamps it with
	// the transaction saved before the failure was handled.
	r.sendErrorWithData(msg, "", errorData)
	r.sendStatusWithCode("validation-error", msg, "provider-unavailable")
}

// userFixableFailure describes a terminal failure the user fixes outside the
// turn — a provider.AuthError or provider.SetupError — in the terms
// reportUserFixableFailure reports it in.
type userFixableFailure struct {
	provider    string // registry name of the provider at fault, or ""
	hint        string // the provider's remediation, written for the reader
	message     string // the provider's own account, kept beneath the hint
	defaultLead string // the lead when the provider gave no hint
	kind        string // the error item's errorKind, which the row keys its actions off
	code        string // the validation-error status code
	logLabel    string // names the class in the server log
}

// reportUserFixableFailure handles a provider that refused the call on
// authentication grounds, or that cannot run on this machine at all, in the
// same terminal shape as reportProviderUnavailable.
func (r *run) reportUserFixableFailure(f userFixableFailure, err error, duration time.Duration) {
	// The provider's hint leads, because it is the only sentence here
	// written for the person reading it — the provider's own error text
	// is addressed to someone standing at its command line. That text
	// still follows, since it is the only diagnosable part.
	lead := f.hint
	if lead == "" {
		lead = f.defaultLead
	}
	msg := lead
	if detail := strings.TrimSpace(f.message); detail != "" {
		msg += "\n\n" + detail
	}
	errorData := r.turnErrorData(duration)
	if f.provider != "" {
		errorData["provider"] = f.provider
	}
	// errorKind lets the transcript row offer the remediation action
	// without re-deriving the classification by matching on the text.
	errorData["errorKind"] = f.kind
	r.log.Error("❌ LLM error (%s): %s", f.logLabel, err.Error())
	// Durable item first, for the same reason as Guard B: the status is
	// a transient client-side notice and would leave nothing behind for
	// a sign-in that lapsed while nobody was watching.
	r.sendErrorWithData(msg, "", errorData)
	// Only the lead goes to the composer warning. The detail belongs in
	// the transcript, where there is room to read it.
	r.sendStatusWithCode("validation-error", lead, f.code)
}

// resolveContextOverflow gives a context-limit failure to the overflow handler.
// settled reports that the handler decided the turn's outcome itself (stop, or
// retry without the pre-flight guard), and verdict is that outcome. Otherwise
// the returned error is the one to report: err itself when it was not an
// overflow, or the handler's synthesized terminal error. That error must not
// re-enter overflow handling in the same iteration, even when it wraps a
// provider overflow, which is why it is returned rather than re-classified.
func (r *run) resolveContextOverflow(st *strategyRunState, err error, llmRequest json.RawMessage) (verdict turnVerdict, settled bool, reportErr error) {
	overflow, ok := asContextOverflow(err)
	if !ok {
		return turnDone, false, err
	}
	// The guard-bypassed fallback is single-shot. Registry admission honors
	// the bypass before transport, so an advisory on a bypassed request means
	// a broken caller/provider contract; stop without ever publishing the
	// estimate as a terminal user error. Provider rejections carry no such
	// single-shot guard.
	if overflow.advisory && st.bypassContextGuard {
		r.log.Error("[context guard] advisory repeated after fallback bypass; stopping without a terminal estimate error")
		return turnDone, true, err
	}
	// Parse the original request only now that it is needed (a
	// context-limit overflow), not on every successful turn.
	var originalRequest hiddenLLMRequest
	_ = json.Unmarshal(llmRequest, &originalRequest)
	retry, terminal := r.handleContextOverflow(overflow, &st.compaction, originalRequest.ModelConfig)
	switch {
	case terminal != nil:
		return turnDone, false, terminal
	case retry:
		st.bypassContextGuard = true
		return turnContinue, true, err
	default:
		return turnDone, true, err
	}
}

// restOnRateLimit handles a usage cap the provider dated. That is a fact about
// the ACCOUNT, not about this request, so it is latched here — the one place
// every terminal LLM error passes — and stands over every thread in the
// conversation until it lifts. Exactly one thread wins that latch and reports
// it; the others met the same refusal and have nothing to add, so they rest
// silently and the conversation says this once instead of once per thread.
//
// Both rest the way a Pause rests, without settling: a thread stopped by a
// cap is not a thread that finished, and settling would report an answer it
// never gave and hand its parent a fresh turn — straight back into the wall.
func (r *run) restOnRateLimit(rateLimit *RateLimitError, err error, errorData map[string]any) {
	providerName := ""
	if mc := r.resolveModelConfig(); mc != nil {
		providerName = mc.Provider
	}
	if !r.latchRateLimit(providerName, rateLimit.ResetAt) {
		r.log.Info("Usage limit on %s already reported for this conversation — resting this thread instead of reporting it again", providerName)
	} else {
		r.log.Info("Usage limit on %s stands until %s — latched, so no thread here calls it again until the user sends", providerName, rateLimit.ResetAt.Format(time.RFC3339))
		r.sendErrorWithData(rateLimitReport(providerName, rateLimit.ResetAt, time.Now(), err.Error()), "", errorData)
	}
	r.promotePendingItems(r.t.thread.itemID)
	r.t.politelyStopped = true
}
