//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// historyNavRecoil is how long, after an undo or redo, the reducer stays still
// for the Yjs echoes of that history step. Its length is not what keeps the
// step undone on a slow core; see navRecoilUntilMs.
const historyNavRecoil = 500 * time.Millisecond

// undoGrouping is the worker's state for making undo mean what the user did:
// one press reverts one user action, and an undo or redo is not taken as a
// request to advance the conversation. It holds two pieces:
//
//   - Two merge marks: the undo-stack index a multi-step operation started at,
//     so every group added since can be collapsed into one on its end. One is
//     for a compaction run, one for a browser-bracketed command (e.g. /clear).
//   - Two reducer holds around a history step: the items observer muted while
//     the UndoManager applies it, and a short recoil window after it.
//
// It records indices and windows; the undo stack itself is the tracker's.
// Every field is read and written only by the methods in this file
// (TestWorkerSeamsOwnTheirState). Run goroutine only, which every method
// asserts (actor_guard.go).
type undoGrouping struct {
	// undoActor is the worker's actor guard; nil for a grouping built bare.
	undoActor *actorGuard
	// observerMuted, when true, makes handleItemsChange a no-op. Set for the
	// duration of an undo/redo so the document mutations the UndoManager
	// applies don't kick the reducer (which would otherwise see e.g. a restored
	// thread + trailing user message and immediately dispatch ActionCallLLM,
	// undoing the user's undo in front of their eyes).
	observerMuted bool
	// navRecoilUntilMs is set briefly after undo/redo. During this window doc
	// updates still apply and save, but every items change releases the LLM
	// claims and skips the reducer instead of driving it forward from whatever
	// last item shape the history step exposed. Explicit send/continue intent
	// ends the window at once; otherwise it expires so later user actions
	// delivered as Yjs sync (e.g. approval clicks) work.
	//
	// The window is a second line, not the one undo stays undone by: the history
	// step itself releases every claim (handleUndoOrRedo), the UndoManager's scope
	// is the items array only, and no client writes processingState, so an echo
	// reaching the reducer after the window — as it does on a slow core — finds
	// no awaiting_llm to dispatch on and rests exactly as it would inside it
	// (TestUndoEchoAfterRecoilDoesNotRedispatch).
	navRecoilUntilMs int64
	// compactionMergeFrom, when >= 0, is the undo-stack index whose entry holds
	// the viewer-side compaction insert. While set, every undo group the
	// strategy adds during the compaction run is collapsed into that entry on
	// idle, so the whole compaction undoes as one user action. -1 means no
	// compaction in flight.
	compactionMergeFrom int
	// commandMergeFrom, when >= 0, is the undo-stack index captured at the start
	// of a browser-driven multi-step command. On the matching end marker every
	// undo group added since is collapsed into that entry. -1 means no command
	// bracket is open.
	commandMergeFrom int
}

// newUndoGrouping returns grouping state with nothing in flight. Both marks
// mean "nothing in flight" at -1, so the zero value would read as "collapse
// everything from entry 0".
func newUndoGrouping(actor *actorGuard) undoGrouping {
	return undoGrouping{undoActor: actor, compactionMergeFrom: -1, commandMergeFrom: -1}
}

// own asserts the caller is the actor.
func (u *undoGrouping) own() { u.undoActor.assertActor("the undo grouping") }

// ---- Reducer holds around a history step ----

// muteObserver silences handleItemsChange while a history step is applied.
func (u *undoGrouping) muteObserver() { u.own(); u.observerMuted = true }

// unmuteObserver ends muteObserver.
func (u *undoGrouping) unmuteObserver() { u.own(); u.observerMuted = false }

// observerIsMuted reports whether handleItemsChange should do nothing.
func (u *undoGrouping) observerIsMuted() bool { u.own(); return u.observerMuted }

// startNavRecoil opens the post-history-step recoil window at now.
func (u *undoGrouping) startNavRecoil(now time.Time) {
	u.own()
	u.navRecoilUntilMs = now.Add(historyNavRecoil).UnixMilli()
}

// endNavRecoil closes the recoil window: an explicit user intent has arrived.
func (u *undoGrouping) endNavRecoil() { u.own(); u.navRecoilUntilMs = 0 }

// inNavRecoil reports whether now falls inside the recoil window. A window
// found expired is closed, so the check costs nothing afterwards.
func (u *undoGrouping) inNavRecoil(now time.Time) bool {
	u.own()
	if u.navRecoilUntilMs == 0 {
		return false
	}
	if now.UnixMilli() < u.navRecoilUntilMs {
		return true
	}
	u.navRecoilUntilMs = 0
	return false
}

// ---- Merge marks ----

// markCompactionStart records the undo-stack index of the compaction insert.
func (u *undoGrouping) markCompactionStart(idx int) { u.own(); u.compactionMergeFrom = idx }

// takeCompactionMerge returns the compaction mark and clears it; ok is false
// when no compaction is in flight.
func (u *undoGrouping) takeCompactionMerge() (idx int, ok bool) {
	u.own()
	idx, u.compactionMergeFrom = u.compactionMergeFrom, -1
	return idx, idx >= 0
}

// openCommand records the undo-stack index a bracketed command starts at.
func (u *undoGrouping) openCommand(idx int) { u.own(); u.commandMergeFrom = idx }

// takeCommandMerge returns the command mark and clears it; ok is false when no
// bracket is open.
func (u *undoGrouping) takeCommandMerge() (idx int, ok bool) {
	u.own()
	idx, u.commandMergeFrom = u.commandMergeFrom, -1
	return idx, idx >= 0
}
