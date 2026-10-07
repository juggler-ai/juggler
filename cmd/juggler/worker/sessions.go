//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"strings"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// Sessions.
//
// A thread a tool call spawns is a SESSION: named at creation, and callable
// again. A later call naming it appends one more invocation message to the
// transcript that thread already has and runs it — so a follow-up question
// costs a warm cache instead of a fresh orientation, and the child is never
// told it is being resumed. From its side a new user message simply arrived at
// the end of the conversation it was already having; the only difference from a
// human typing into the column is who wrote the message, and that it carries
// tool-use coordinates.
//
// The caller gets a second item for it: an ALIAS, standing where the call was
// made, showing the same thread and answering for that one run (aliasItem, and
// ConversationItem.AliasOf). One item per call is what keeps the parent's
// history in call order — a resume appends to it rather than inserting into the
// middle of it.
//
// The name is the whole handle. There is no session object, no registry and no
// lifecycle: a session IS a thread with a `sessionName` on its Y.Map, scoped to
// the thread that called it, owned by the tool that made the call. Ownership is
// read back off the thread's run records rather than stored a second time, and
// it is part of the match — so one tool can never resume another's session,
// whatever the model types.
//
// Create versus resume is implicit: a name that matches resumes, a name that
// does not creates. The exposure runs one way only. An accidental CREATE costs
// a correct answer arrived at slowly; an accidental RESUME would inherit
// context the caller never asked for. Every result opens with the name that was
// actually used (sessionPreamble), so a wrong guess is visible rather than
// silent, and a caller who never planned to follow up can still do so.

// maxSessionNameLen bounds a caller-supplied name. A handle the model cannot
// retype from memory is no handle at all.
const maxSessionNameLen = 40

// sessionTokens splits a name into lowercase alphanumeric words. Shared by the
// two things that produce a name, so a caller-supplied one and a generated one
// are drawn from the same alphabet.
func sessionTokens(s string) []string {
	var parts []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			parts = append(parts, cur.String())
			cur.Reset()
		}
	}
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			cur.WriteRune(r)
			continue
		}
		flush()
	}
	flush()
	return parts
}

// sessionSlug normalises a caller-supplied session name. Names are matched by
// equality, so both ends of the comparison pass through here: "Auth Hunt" and
// "auth-hunt" are the same session, and a model that half-remembers the
// punctuation still lands on it.
func sessionSlug(name string) string {
	out := strings.Join(sessionTokens(name), "-")
	if len(out) > maxSessionNameLen {
		out = out[:maxSessionNameLen]
	}
	return strings.Trim(out, "-")
}

// sessionBaseForTool derives the stem of an auto-generated name from the tool
// that spawns the child: WebFetch → "webfetch-1", create_thread → "thread-1".
func sessionBaseForTool(toolName string) string {
	parts := sessionTokens(toolName)
	// "create_thread" names the act; the session is the thread.
	if len(parts) > 1 && parts[0] == "create" {
		parts = parts[1:]
	}
	if len(parts) == 0 {
		return "session"
	}
	return strings.Join(parts, "-")
}

// threadSession is one session in a calling thread: a child thread with a name,
// the tool that owns it, and whether its latest run is over.
type threadSession struct {
	threadItemID string
	name         string
	tool         string
	settled      bool
}

// sessionToolOf reports which tool owns a session — the tool named by its most
// recent invocation. Taken from the run records because they are already the
// authority on who called in; storing it again on the thread would be a second
// copy to keep true.
func sessionToolOf(item ConversationItem) string {
	runs := threadRunRecords(item)
	if len(runs) == 0 {
		return ""
	}
	return runs[len(runs)-1].call.ToolName
}

// sessionsInCallingThread lists the sessions belonging to the thread being
// processed — the scope a session name is unique in. Cross-thread and
// cross-conversation handles are deliberately out of scope: a session belongs
// to the transcript that can see its results.
func (r *run) sessionsInCallingThread() []threadSession {
	var out []threadSession
	for _, item := range r.getTargetItems() {
		if item.Type != ItemTypeThread || item.SessionName == "" {
			continue
		}
		// An alias carries a frozen copy of the name for its tile alone. Reading
		// it as a session would register the same session twice and send the next
		// call naming it to allocateSessionName, which would suffix a resume into
		// a fresh spawn. The canonical is a sibling in this array, so every
		// session is still found exactly once.
		if item.AliasOf != "" {
			continue
		}
		out = append(out, threadSession{
			threadItemID: item.ItemID,
			name:         item.SessionName,
			tool:         sessionToolOf(item),
			settled:      threadRunSettled(item),
		})
	}
	return out
}

// sessionResolution is what one call's session argument came to.
type sessionResolution struct {
	// resumeThreadID names the existing session this call invokes again. Empty
	// means the call creates one.
	resumeThreadID string
	// name is the session's name: the one it already had, or the one a new
	// session is created with. Never empty.
	name string
	// busy reports that the named session's run is still in flight. A second
	// invocation is an error, not a queue — concurrent runs against one child
	// are out of scope, and queueing would hide the collision rather than
	// report it.
	busy bool
}

// resolveSession decides whether a call starts a session or continues one, and
// under what name.
func (r *run) resolveSession(toolName, requested string) sessionResolution {
	sessions := r.sessionsInCallingThread()
	taken := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		taken[s.name] = true
	}
	requested = sessionSlug(requested)
	if requested != "" {
		for _, s := range sessions {
			if s.name != requested || s.tool != toolName {
				continue
			}
			if !s.settled {
				return sessionResolution{name: s.name, busy: true}
			}
			return sessionResolution{resumeThreadID: s.threadItemID, name: s.name}
		}
	}
	return sessionResolution{name: allocateSessionName(taken, sessionBaseForTool(toolName), requested)}
}

// allocateSessionName picks a name no session in the calling thread is using.
// An unmatched request is honoured as given; one already taken by another
// tool's session keeps the caller's word and gains a suffix, rather than being
// silently swapped for something the caller never wrote. The result is reported
// back in the preamble either way, so the model always sees what it got.
func allocateSessionName(taken map[string]bool, base, requested string) string {
	if requested != "" && !taken[requested] {
		return requested
	}
	stem := base
	if requested != "" {
		stem = requested
	}
	for i := 1; ; i++ {
		candidate := fmt.Sprintf("%s-%d", stem, i)
		if !taken[candidate] {
			return candidate
		}
	}
}

// sessionPreamble is the line a session-backed result opens with: the handle to
// call this session again, whether this call started it or continued one, and
// the run's status whenever that was anything other than rest. It replaces the
// thread header for a session, and it is read on every delegated call — so it
// is information, kept terse and machine-shaped.
func sessionPreamble(name string, call int, status string) string {
	head := name + " · new"
	if call > 1 {
		head = fmt.Sprintf("%s · resumed, call %d", name, call)
	}
	if status != "" && status != runStatusRest {
		head += " · " + status
	}
	return head
}

// receiptPreamble is the line a receipt's message opens with: which thread
// spoke, that nobody called it, and how the run ended when that was anything
// other than rest. It takes the place of sessionPreamble's "resumed, call N",
// which would be a lie twice over — no call was made, so there is no call to
// number.
func receiptPreamble(label, status string) string {
	head := label + " · continued in the thread"
	if status != "" && status != runStatusRest {
		head += " · " + status
	}
	return head
}

// sessionBusyMessage is the refusal a caller gets for invoking a session whose
// run has not finished.
func sessionBusyMessage(name string) string {
	return fmt.Sprintf("Session %q is still running — one run at a time. "+
		"Wait for its result, or make this call without a session to start a new one.", name)
}

// invocationMessage builds the user item that starts one run: the call's
// prompt, the return contract when the call states one, and the tool-use
// coordinates that pair the run's outcome back to the call. Held per-message
// rather than on the thread, which is what lets the thread be invoked more than
// once — N invocations are N stamped user items in order down the transcript,
// each paired against the run it began.
//
// A dispatched thread has no call, so its zero toolSpawn leaves the message
// unstamped.
func invocationMessage(spec threadSpec, call toolSpawn) ConversationItem {
	content := spec.Prompt
	if spec.ResultSpec != "" {
		content += "\n\n---\nYour last message is what the caller receives. It must contain: " + spec.ResultSpec
	}
	return ConversationItem{
		Type:         ItemTypeUser,
		ItemID:       generateItemID(),
		Content:      content,
		Timestamp:    time.Now().Format(time.RFC3339),
		RunToolUseID: call.ToolUseID,
		RunToolName:  call.ToolName,
		RunToolInput: call.ToolInput,
		RunGoal:      call.RunGoal,
	}
}

// continuationMarker builds the message a Continue starts its run with: no
// content, no call, nothing to say — just somewhere for that run's outcome to be
// recorded.
//
// Every run needs a record of its own, because a record is what the parent's
// items point at (ConversationItem.RunItemID) and what tells every decider the
// thread is working again. Continue is the one gesture with no message behind
// it, and reusing the previous run's record — clearing its outcome to make it
// look open — would rewrite an answer the parent may already have read, turning
// a settled result back into the pending placeholder mid-history.
//
// It emits nothing on the wire (itemWireMessages), so a Continue still costs the
// model exactly what it always did: nothing.
func continuationMarker() ConversationItem {
	return ConversationItem{
		Type:         ItemTypeUser,
		ItemID:       generateItemID(),
		Timestamp:    time.Now().Format(time.RFC3339),
		Continuation: true,
	}
}

// aliasItem is the parent's view of one call into a session it has already
// called: a thread item that owns no transcript and points at the canonical
// thread holding it.
//
// The alias is what makes a resume APPEND to the parent's history rather than
// insert into the middle of it. Its run selector (RunToolUseID/RunToolName/
// RunToolInput) names the one run it stands for, so the wire emits this call's
// tool_use/tool_result pair at the position the call was made — leaving every
// earlier pair, and the prompt cache warmed on them, untouched.
//
// goal and sessionName are frozen display copies for the tile alone; the thread
// they describe is the truth. RunGoal is the per-call label surfaces show; it is
// resolved from the spec rather than inferred from the tool's detailed input.
func aliasItem(canonicalItemID, goal, sessionName string, call toolSpawn) ConversationItem {
	return ConversationItem{
		Type:         ItemTypeThread,
		ItemID:       generateItemID(),
		Timestamp:    time.Now().Format(time.RFC3339),
		AliasOf:      canonicalItemID,
		Goal:         goal,
		SessionName:  sessionName,
		RunToolUseID: call.ToolUseID,
		RunToolName:  call.ToolName,
		RunToolInput: call.ToolInput,
		RunGoal:      call.RunGoal,
	}
}

// receiptItem is the parent's view of a run NOBODY CALLED: the user typed into
// a stopped child, or continued it. It stands where an alias would, and shows
// the same thread, but it is not an alias of a call — there is no tool_use to
// name, so it selects its run by the child message that started it (RunItemID)
// and reports on the wire as a single user-role message (appendThreadMessages).
//
// It exists because the alternative is rewriting a pair the model has already
// read. The item still waiting on a call may absorb a human's resume — nothing
// has been sent, so nothing moves — but once that call has been answered the
// answer is committed history, and a second run has to land somewhere of its
// own. Appending it here is what keeps the parent's committed prefix, and the
// prompt cache warmed on it, exactly where they were.
//
// goal and sessionName are frozen display copies for the tile alone, as on an
// alias; the thread they describe is the truth.
func receiptItem(canonicalItemID, goal, sessionName, runItemID string) ConversationItem {
	return ConversationItem{
		Type:        ItemTypeThread,
		ItemID:      generateItemID(),
		Timestamp:   time.Now().Format(time.RFC3339),
		AliasOf:     canonicalItemID,
		Goal:        goal,
		SessionName: sessionName,
		RunItemID:   runItemID,
	}
}

// resumeSession invokes an existing session again. It inserts this call's alias
// item into the calling thread, appends the call's invocation message to the end
// of the child's transcript, and leaves the reducer to dispatch the run, exactly
// as it dispatches a fresh child.
//
// Those two appends are the whole of it. Nothing is cleared, replayed or
// re-prompted; SeedThreadFromParent is create-only, so the parent's standing
// context is not cloned in a second time, and the return contract is re-stated
// only when THIS call supplies one. A goal does update the column header — it is
// the one thread-level field a call may carry, and ignoring it would leave the
// header describing work the session has moved past. The same goes for
// resultSpec: it is thread-level, so the header states the latest contract while
// an earlier alias still shows a result shaped by an older one. That is the
// header describing the session as it stands, which is what a header is for —
// while each item keeps its own short label in RunGoal.
func (r *run) resumeSession(threadItemID string, spec threadSpec, call toolSpawn) error {
	nested := r.doc.GetThreadItemsArray(threadItemID)
	if nested == nil {
		return fmt.Errorf("session thread %s not found", threadItemID)
	}

	// One undo unit, as a creation is: the header update, the alias item and the
	// appended message collapse into a single group. A resume that left an orphan
	// alias, or a message no parent item answers for, is a broken document.
	r.tracker.StopCapturing()
	mergeFrom := r.tracker.UndoStackLen()

	var goal, sessionName string
	ycrdtMu.Lock()
	if m := findThreadYMap(r.doc.getItems(), threadItemID); m != nil {
		goal, _ = m.Get("goal").(string)
		resultSpec, _ := m.Get("resultSpec").(string)
		sessionName, _ = m.Get("sessionName").(string)
		if (spec.Goal != "" && spec.Goal != goal) || (spec.ResultSpec != "" && spec.ResultSpec != resultSpec) {
			r.doc.transactTracked(func(_ *ycrdt.Transaction) {
				if spec.Goal != "" && spec.Goal != goal {
					m.Set("goal", spec.Goal)
					goal = spec.Goal
				}
				if spec.ResultSpec != "" && spec.ResultSpec != resultSpec {
					m.Set("resultSpec", spec.ResultSpec)
				}
			})
		}
	}
	ycrdtMu.Unlock()

	// The alias goes in first, at the end of the calling thread — where the turn
	// making this call stands — so it is in the document before the run it stands
	// for can settle.
	if call.ToolUseID != "" {
		target := r.getTargetItemsYArray()
		r.tracker.AppendMessageIntoArray(target, aliasItem(threadItemID, goal, sessionName, call))
	}

	r.tracker.AppendMessageIntoArray(nested, invocationMessage(spec, call))
	r.tracker.MergeFromIndex(mergeFrom)
	r.tracker.StopCapturing()

	r.log.Info("[worker] resumed session %s (thread %s)", call.SessionName, threadItemID)
	return nil
}
