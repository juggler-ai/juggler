//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Pure regime classification: given a stored session and an incoming
// request, decide which dispatch path StreamMessage will take.

package claudecode

import (
	"fmt"
	"strings"

	"juggler/cmd/juggler/providers/provider"
)

// continuationCovers reports whether req.Messages contains a tool-result
// for every pending tool ID. Pure predicate — does not consult liveness.
// Consumed by classifyRegime alongside hasLiveCLI and the user-interjection
// check.
func continuationCovers(sess *activeSession, messages []provider.Message) bool {
	if sess == nil || len(sess.pendingTools) == 0 {
		return false
	}
	pending := make(map[string]bool, len(sess.pendingTools))
	for _, t := range sess.pendingTools {
		pending[t.ID] = true
	}
	found := 0
	for _, msg := range messages {
		if msg.Type == "tool-result" && pending[msg.ToolUseID] {
			found++
		}
	}
	return found == len(sess.pendingTools)
}

// userInterjectedAfterPendingTools reports whether req.Messages contains any
// non-tool-result content positioned after the most recent tool-result for
// one of the session's pending tool IDs. That trailing content (typically a
// user message the user typed while tools were running) cannot be delivered
// through continueSession's MCP-only fast path — it would be silently
// dropped — so the caller must route through resume-with-delta instead.
func userInterjectedAfterPendingTools(sess *activeSession, messages []provider.Message) bool {
	if sess == nil || len(sess.pendingTools) == 0 || len(messages) == 0 {
		return false
	}
	pending := make(map[string]bool, len(sess.pendingTools))
	for _, t := range sess.pendingTools {
		pending[t.ID] = true
	}
	lastMatchingToolResult := -1
	for i, msg := range messages {
		if msg.Type == "tool-result" && pending[msg.ToolUseID] {
			lastMatchingToolResult = i
		}
	}
	if lastMatchingToolResult < 0 {
		return false // continuationCovers would have already returned false
	}
	for i := lastMatchingToolResult + 1; i < len(messages); i++ {
		if messages[i].Type != "tool-result" {
			return true
		}
	}
	return false
}

// systemPromptChanged reports whether systemPrompt differs from the one the live
// CLI was spawned with. The CLI takes its prompt from --system-prompt at spawn
// and never re-reads it, so a parked CLI cannot carry an edited prompt: feeding
// it tool results would keep the old one for its whole lifetime. A session with
// no recorded prompt hash reports no change.
func systemPromptChanged(sess *activeSession, systemPrompt string) bool {
	return sess.sentSystemHash != 0 && hashSystemPrompt(systemPrompt) != sess.sentSystemHash
}

// deltaCarriesToolResult reports whether any message in messages[start:end] is a
// tool-result. A tool_result reaches the CLI exactly two ways: live, over the MCP
// control stream (regimeContinue), or paired into resumed history by the
// synthetic-resume rebuild (regimeStartFresh). It can NEVER be delivered as a
// stdin user-message delta — the resumed transcript ends on a dangling assistant
// tool_use the CLI answered over its (by-then-closed) control stream, so a stdin
// tool_result has no open tools/call to bind to and is silently dropped. So a
// delta carrying a tool_result must never route to regimeResumeDelta.
func deltaCarriesToolResult(messages []provider.Message, start, end int) bool {
	for i := start; i < end && i < len(messages); i++ {
		if messages[i].Type == "tool-result" {
			return true
		}
	}
	return false
}

// streamRegime tags which dispatch path StreamMessage will (or would) take
// for a given (session, request) pair.
type streamRegime int

const (
	_ streamRegime = iota

	// regimeStartFresh spawns a brand-new -p invocation with full history.
	// Used for first turns, model changes, or any prefix divergence.
	regimeStartFresh

	// regimeContinue feeds tool_results to the parked CLI via MCP.
	// Requires a live CLI, results for every pendingTool, no user content
	// past the matching tool-results, and an unchanged system prompt.
	regimeContinue

	// regimeResumeDelta spawns/reuses `claude --resume <uuid>` and pipes
	// messages[DeltaStart:DeltaEnd] via stdin. If SoftReset is true, the
	// parked CLI is killed first (clearing pendingTools); the resumed
	// session re-reads its saved transcript so the cache stays warm.
	regimeResumeDelta

	// regimeResumeAppendResult handles a tool_result-bearing delta when the
	// live CLI is gone (cancel-while-parked then interject, or answer after a
	// restart): the leading tool_results close the dangling tool_use the warm
	// transcript ends on. Rather than cold-rebuild under a fresh uuid, append
	// the paired results into the CLI's OWN warm session file and re-resume the
	// same uuid, piping only the non-tool_result tail on stdin. The unchanged
	// prefix cache-hits. DeltaStart/DeltaEnd bracket the whole delta;
	// pairedResultResumeSplit re-derives the file-vs-stdin boundary at dispatch.
	regimeResumeAppendResult
)

// regimeDecision is the output of classifyRegime: enough information to
// dispatch (StreamMessage) the request.
type regimeDecision struct {
	Regime     streamRegime
	DeltaStart int  // valid for regimeResumeDelta
	DeltaEnd   int  // valid for regimeResumeDelta
	SoftReset  bool // valid for regimeResumeDelta: kill parked CLI first
	// NoNewMsgs is the steady-state warm case: every message in req.Messages
	// is already covered by sentCount. Reported via regimeStartFresh because
	// StreamMessage cold-starts in this state.
	NoNewMsgs bool
	// Reason is a short diagnostic for the cold-start log. Set on
	// regimeStartFresh.
	Reason string
}

// classifyRegime is a pure predicate: given the stored session and the
// incoming request, decide which dispatch regime applies. Single source of
// truth that StreamMessage consumes for routing. liveCLI lets the caller
// short-circuit regimeContinue when the parked subprocess is gone — pass
// sess.hasLiveCLI() at dispatch time (a dead CLI degrades to
// regimeResumeDelta with SoftReset, which is still warm).
func classifyRegime(sess *activeSession, currentModel, systemPrompt string, messages []provider.Message, liveCLI bool) regimeDecision {
	if sess == nil || sess.sessionUUID == "" {
		return regimeDecision{Regime: regimeStartFresh, Reason: "no-session"}
	}
	if continuationCovers(sess, messages) && liveCLI && !userInterjectedAfterPendingTools(sess, messages) &&
		!systemPromptChanged(sess, systemPrompt) {
		return regimeDecision{Regime: regimeContinue}
	}
	// claude --resume against a different model does not share cache.
	if sess.model != "" && sess.model != currentModel {
		return regimeDecision{Regime: regimeStartFresh, Reason: "model-changed"}
	}
	start, end, ok, reason := canResumeWithDelta(sess, systemPrompt, messages)
	if !ok {
		return regimeDecision{
			Regime:    regimeStartFresh,
			Reason:    reason,
			NoNewMsgs: reason == "no-new-msgs",
		}
	}
	// A delta carrying a tool_result cannot be piped on stdin (see
	// deltaCarriesToolResult). We only reach here when regimeContinue was
	// unavailable — typically the live CLI that parked the tools/call is gone
	// (app restart, crash, watchdog re-exec) so pendingTools didn't survive, or
	// it parked but the user interjected. Routing such a delta through
	// regimeResumeDelta would --resume the old transcript (ending on a dangling
	// assistant tool_use answered over the now-closed control stream) and feed the
	// tool_result as a stdin user message with no open tools/call to attach to —
	// the answer is silently lost ("permission stream closed"). Route to a fresh
	// synthetic resume instead: moveTrailingToolResultsToHistory pairs the
	// tool_result into the rebuilt history so the model actually sees it.
	if deltaCarriesToolResult(messages, start, end) {
		// If the delta's leading tool_results close the dangling tool_use the
		// warm transcript ends on, we can pair them into the warm session file
		// and re-resume warm instead of cold-rebuilding (see
		// regimeResumeAppendResult). Otherwise the result can't be safely placed
		// in the warm file, so fall back to a fresh synthetic resume.
		if _, ok := pairedResultResumeSplit(messages, start, end); ok {
			return regimeDecision{
				Regime:     regimeResumeAppendResult,
				DeltaStart: start,
				DeltaEnd:   end,
			}
		}
		return regimeDecision{Regime: regimeStartFresh, Reason: "delta-tool-result"}
	}
	return regimeDecision{
		Regime:     regimeResumeDelta,
		DeltaStart: start,
		DeltaEnd:   end,
		SoftReset:  len(sess.pendingTools) > 0,
	}
}

// pairedResultResumeSplit reports whether the delta messages[deltaStart:deltaEnd]
// can be warm-appended. The resume anchor is captured at the park BEFORE the CLI
// emits its tool_use, so the assistant turn the CLI parked on is the HEAD of the
// delta (already durably in the warm session file), not part of the committed
// prefix. The delta must therefore look like:
//
//	[ assistant turn (text / thinking / tool_use) ]   ← already in the warm file
//	[ tool_results closing every dangling tool_use ]  ← appended into the file
//	[ non-tool_result tail (the user's interjection) ] ← piped on stdin (may be empty)
//
// The calls and their results need not be in two separate runs. The worker
// groups a turn's ordinary tool calls ahead of their results, but a thread
// (create_thread) is emitted as its own tool_use+tool_result pair beside that
// group, so a turn that called a tool and a thread in parallel arrives as
// [use, result, use, result]. A tool_use after a result is therefore still
// taken as one of the parked turn's calls — but only a tool_use: once a result
// is in, assistant text or thinking means the model spoke again, in a turn the
// warm file does not hold. Whether each call really is one the warm file is
// parked on is settled against the file itself, by identity, when the results
// are appended (pairResultsWithToolUses), which cold-starts on any mismatch.
//
// On success it returns tailStart: the index splitting the leading content from
// the stdin tail. It fails when the delta's assistant head carries no tool_use,
// when a tool_result doesn't close a call made before it, when assistant
// content other than a tool_use follows a result, when some tool_use is left
// unanswered, or when a tool_result trails the non-result content — any of
// which makes a clean warm append impossible, so the caller cold-starts fresh
// instead.
func pairedResultResumeSplit(messages []provider.Message, deltaStart, deltaEnd int) (tailStart int, ok bool) {
	if deltaStart < 0 || deltaEnd > len(messages) {
		return 0, false
	}
	// The parked assistant turn (already committed to the warm file) and the
	// tool_results closing every tool_use it is dangling on.
	dangling := map[string]bool{}
	answered := map[string]bool{}
	i := deltaStart
	for ; i < deltaEnd; i++ {
		m := messages[i]
		if m.Type == "tool-result" {
			if !dangling[m.ToolUseID] {
				return 0, false // a result that doesn't close a call made before it
			}
			answered[m.ToolUseID] = true
			continue
		}
		if provider.MessageTypeToRole(m.Type) != "assistant" {
			break
		}
		if m.Type != "tool-use" {
			if len(answered) > 0 {
				return 0, false // the model spoke again: a later turn, not the parked one
			}
			continue
		}
		if m.ToolUseID != "" {
			dangling[m.ToolUseID] = true
		}
	}
	if len(dangling) == 0 {
		return 0, false
	}
	if len(answered) != len(dangling) {
		return 0, false // not every dangling tool_use got a result
	}
	// The stdin tail must carry no further tool_result.
	for j := i; j < deltaEnd; j++ {
		if messages[j].Type == "tool-result" {
			return 0, false
		}
	}
	return i, true
}

// isVolatileContextMessage reports whether a message is one of the standing
// context items (pinned/@-mentioned file contents, memory, …) the worker
// re-renders every turn. Their content can change turn-to-turn, so they must not
// anchor the resume prefix.
func isVolatileContextMessage(msgType string) bool {
	return msgType == "context-item" || msgType == "context-item-updated"
}

// stablePrefixCount returns the length of the stable decision prefix: everything
// except a trailing run of volatile standing-context messages.
//
// The worker renders each standing context item at the position its item stands
// in the conversation (buildMessages), so a context render CAN be the last thing
// in a request — an item added while the thread was busy is promoted into the
// items array after the last user message. Anchoring the resume prefix on one
// would force a "diverged" cold start every turn, because its bytes change
// turn-to-turn and flip hashRequestPrefix over the anchored range. Stripping the
// trailing run keeps it eligible for replacement instead.
func stablePrefixCount(messages []provider.Message) int {
	n := len(messages)
	for n > 0 && isVolatileContextMessage(messages[n-1].Type) {
		n--
	}
	return n
}

// canResumeWithDelta reports whether Juggler's projection of the CLI transcript
// is compatible with a new request. heldCount records the full request extent
// accepted by stdin and rejects rollback. sentCount and its element hashes cover
// the stable decision prefix, so trailing volatile context remains eligible for
// replacement and the next delta starts at sentCount.
//
// Returns the (deltaStart, deltaEnd) range on success. On failure, returns a
// short cold-start reason: "no-uuid", "shrunk", "diverged", or "no-new-msgs".
func canResumeWithDelta(sess *activeSession, systemPrompt string, messages []provider.Message) (int, int, bool, string) {
	if sess == nil || sess.sessionUUID == "" {
		return 0, 0, false, "no-uuid"
	}
	heldCount := sess.heldCount
	if heldCount < sess.sentCount {
		heldCount = sess.sentCount
	}
	if heldCount > len(messages) {
		return 0, 0, false, "shrunk"
	}
	if !decisionPrefixMatches(sess, systemPrompt, messages) {
		return 0, 0, false, "diverged"
	}
	if sess.sentCount == len(messages) {
		return 0, 0, false, "no-new-msgs"
	}
	return sess.sentCount, len(messages), true, ""
}

func decisionPrefixMatches(sess *activeSession, systemPrompt string, messages []provider.Message) bool {
	if sess.sentCount > len(messages) {
		return false
	}
	if sess.sentSystemHash != 0 || len(sess.sentMsgHashes) > 0 {
		if sess.sentSystemHash == 0 || hashSystemPrompt(systemPrompt) != sess.sentSystemHash || len(sess.sentMsgHashes) != sess.sentCount {
			return false
		}
		for i := 0; i < sess.sentCount; i++ {
			if hashMessage(&messages[i]) != sess.sentMsgHashes[i] {
				return false
			}
		}
		return true
	}
	return hashRequestPrefix(systemPrompt, messages, sess.sentCount) == sess.sentHash
}

// diagnoseDivergence returns a short, human-readable description of the FIRST
// prefix element that no longer matches what the CLI was last fed, for the
// cold-start log. Pure; relies on the per-element fingerprints captured by the
// previous finalizeTurn (captureSentPrefix). The system prompt is the head of
// the cached prefix, so it is reported before any message. Returns "" when the
// session lacks fingerprint metadata (e.g. restored from a pre-upgrade sidecar)
// or when no single element localises the difference, so the caller falls back
// to the bare reason string.
func diagnoseDivergence(sess *activeSession, systemPrompt string, messages []provider.Message) string {
	if sess == nil || (sess.sentSystemHash == 0 && len(sess.sentMsgHashes) == 0) {
		return ""
	}
	if sess.sentSystemHash != 0 && hashSystemPrompt(systemPrompt) != sess.sentSystemHash {
		return "system prompt changed (a context item or the env block rendered differently)"
	}
	if sess.heldCount > len(messages) {
		return fmt.Sprintf("history shrank from %d to %d messages", sess.heldCount, len(messages))
	}
	limit := len(sess.sentMsgHashes)
	if limit > len(messages) {
		limit = len(messages)
	}
	for i := 0; i < limit; i++ {
		if hashMessage(&messages[i]) != sess.sentMsgHashes[i] {
			return describeFirstDivergence(sess, messages, i)
		}
	}
	return ""
}

// describeFirstDivergence localises the first mismatching prefix element and,
// crucially, says WHY it mismatches: a genuine in-place content edit, or a
// structural SHIFT where a wire message was inserted/removed earlier and slid
// everything after it. The shift case is the signature of a history item whose
// rendering changes LENGTH across turns — e.g. a thread / delegated-tool item
// that emits only its tool_use while its sub-thread is pending, then a
// tool_use+tool_result pair once the result lands (buildThreadToolResultMap
// returns nil until then). Such an item mutating in committed history is what
// busts the resume anchor and cold-starts a conversation that "seemingly keeps
// prefix". The preview names the concrete culprit so the fix targets the right
// item, not the innocent message that happens to sit at the shifted index.
func describeFirstDivergence(sess *activeSession, messages []provider.Message, i int) string {
	for d := 1; d <= 4; d++ {
		// INSERTED: the anchor element that used to sit at i now appears d slots
		// later in the current build — d wire message(s) were inserted before here.
		if i+d < len(messages) && sess.sentMsgHashes[i] == hashMessage(&messages[i+d]) {
			return fmt.Sprintf("message[%d] (type=%s) — prefix shifted: %d wire message(s) INSERTED before here; new=%s",
				i, messages[i].Type, d, previewMessage(&messages[i]))
		}
		// REMOVED: the current element at i matches an anchor element d slots
		// later — d wire message(s) were removed before here.
		if i+d < len(sess.sentMsgHashes) && hashMessage(&messages[i]) == sess.sentMsgHashes[i+d] {
			return fmt.Sprintf("message[%d] (type=%s) — prefix shifted: %d wire message(s) REMOVED before here; still-here=%s",
				i, messages[i].Type, d, previewMessage(&messages[i]))
		}
	}
	return fmt.Sprintf("message[%d] (type=%s) content changed in place; now=%s",
		i, messages[i].Type, previewMessage(&messages[i]))
}

// previewMessage renders a short, whitespace-collapsed snippet of a wire message
// for the cache-miss diagnostic — enough to recognise which conversation item
// destabilised the prefix without dumping full bodies into the log.
func previewMessage(m *provider.Message) string {
	body := m.Content
	if m.ToolName != "" {
		body = m.ToolName + " " + body
	}
	body = strings.Join(strings.Fields(body), " ")
	const max = 80
	if len(body) > max {
		body = body[:max] + "…"
	}
	return fmt.Sprintf("%s:%q", m.Type, body)
}
