//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"sort"
	"time"
)

// Workspace lifecycle, on the actor goroutine.
//
// The table is written from two directions at once — the browser provisioning a
// workspace, and a second window watching it appear — so every mutation here
// runs as a write task with exclusive access to the live session, like every
// other session mutation. Reads hand back clones: the caller owns what it is
// given and can do nothing to the table with it.

// WorkspacePatch is a targeted change to one workspace. Every field is
// optional, and an omitted one leaves what is there alone — a provider
// checkpointing its progress must be able to write one key without restating
// the row it has not finished building.
//
// Meta is merged key by key rather than replaced, on PatchMetadata's pattern: a
// nil value deletes its key. Replacement would make every checkpoint a
// read-modify-write across the wire, and two windows could then overwrite each
// other's steps.
type WorkspacePatch struct {
	Label *string        `json:"label,omitempty"`
	Root  *string        `json:"root,omitempty"`
	State *string        `json:"state,omitempty"`
	Place *string        `json:"place,omitempty"`
	Meta  map[string]any `json:"meta,omitempty"`
}

// ErrWorkspaceNotFound is returned for an id that is not on the table. It is
// deliberately an error rather than a silent miss: a stale binding must surface
// where it is used, not quietly run somewhere else.
var ErrWorkspaceNotFound = fmt.Errorf("workspace not found")

// ErrNoProject refuses every write to the table while no project is open.
//
// A workspace is a place a conversation works, and in no-project mode there are
// no conversations and nowhere for a row to live: the session is real but sits
// in a scratch directory this process deletes on the way out. Registering one
// there would report success for something that vanishes with the window.
//
// The condition is the PROJECT PATH, not the session. There is always a session
// — NewSessionManagerForPath("") builds one over the scratch dir precisely so
// the rest of the server need not special-case a nil manager — so a guard on
// `s.session == nil` names this state without ever testing it.
var ErrNoProject = fmt.Errorf("no project is open")

// projectOpen reports whether there is a project to keep a workspace table for.
// The path is immutable for the manager's lifetime, so this is safe to ask off
// the actor as well as on it.
func (m *SessionManager) projectOpen() bool {
	return m.projectPath != ""
}

// ListWorkspaces returns every registered workspace, in the order the table
// holds them — which is where two boxes sharing a place get their order from
// (see ReorderWorkspaces).
func (m *SessionManager) ListWorkspaces() []Workspace {
	out, _ := runRead(m, func(s *sessionState) ([]Workspace, error) {
		if s.session == nil {
			return []Workspace{}, nil
		}
		return listWorkspaces(s.session), nil
	})
	return out
}

// RefreshWorkspaceAvailability re-stats every root and reports whether any
// answer changed since the last time the viewers were told.
//
// This is the only writer of the stored Available field, and the field exists
// for this alone: reads answer live (see availableNow), so nothing downstream
// depends on what is recorded here. What it buys is the broadcast. A tree
// removed by hand — or by an agent running in this very session — changes no
// row and so prompts no edit, and without something noticing, every open
// window goes on showing a place that is not there until the next unrelated
// change happens to republish the table.
//
// It stays a stat and a flag. A root that has gone is not closed here: closing
// is a decision somebody made, being gone is a fact that can reverse, and this
// is the half of it that reverses on its own when the disk comes back.
func (m *SessionManager) RefreshWorkspaceAvailability() bool {
	if !m.projectOpen() {
		return false
	}
	changed, _ := runWrite(m, func(s *sessionState) (bool, error) {
		if s.session == nil {
			return false, nil
		}
		changed := false
		for i := range s.session.Workspaces {
			ws := &s.session.Workspaces[i]
			was := ws.Available
			ws.refreshAvailability()
			if ws.Available != was {
				changed = true
			}
		}
		if !changed {
			return false, nil
		}
		if err := s.store.Save(s.session); err != nil {
			return false, err
		}
		return true, nil
	})
	return changed
}

// GetWorkspace returns one registered workspace by id.
//
// The default workspace is not one of them and answers false: it has no row,
// and every caller that could ask for it already holds the project path.
func (m *SessionManager) GetWorkspace(id string) (Workspace, bool) {
	type result struct {
		ws Workspace
		ok bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil {
			return result{}, nil
		}
		ws, ok := s.session.FindWorkspace(id)
		return result{ws: ws.availableNow(), ok: ok}, nil
	})
	return r.ws, r.ok
}

// RegisterWorkspace puts a workspace on the table and returns it as stored,
// with the id the server assigned it.
//
// A workspace is registered BEFORE it is built, in the provisioning state, so
// that a provision interrupted half way through leaves a row describing what
// was started. The alternative — register on success — makes an interrupted
// provision invisible: a half-made worktree on disk that nothing in the app has
// heard of, for the user to find months later.
func (m *SessionManager) RegisterWorkspace(ws Workspace) (Workspace, error) {
	if !m.projectOpen() {
		return Workspace{}, ErrNoProject
	}
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, ErrNoProject
		}
		if ws.State == "" {
			ws.State = WorkspaceStateProvisioning
		}
		// A registration that names no kind is a tree on this machine. This is
		// the one place an empty kind means local: anywhere else a row without
		// one is a kind OpenError does not open.
		if ws.Kind == "" {
			ws.Kind = WorkspaceKindLocal
		}
		// Kind is fixed at registration — no patch changes it — so this is the
		// one place a row that could never be opened is kept off the table.
		if err := ws.OpenError(); err != nil {
			return Workspace{}, err
		}
		if ws.ID == "" {
			ws.ID = GenerateWorkspaceID()
		}
		// Where its box is drawn, for a registration that did not say: behind the
		// last conversation there is, which is the end of the bar. A workspace is
		// registered before anything is bound to it, so there is no member to be
		// drawn at and it would otherwise have no place at all. With no
		// conversations to sit behind, the end of the bar is its head.
		if ws.Place == "" {
			ws.Place = PlaceHead
			if n := len(s.session.ConversationOrder); n > 0 {
				ws.Place = s.session.ConversationOrder[n-1]
			}
		}
		if err := ws.Validate(); err != nil {
			return Workspace{}, err
		}
		if _, exists := s.session.FindWorkspace(ws.ID); exists {
			return Workspace{}, fmt.Errorf("workspace id already registered: %s", ws.ID)
		}
		if len(s.session.Workspaces) >= MaxWorkspaces {
			return Workspace{}, fmt.Errorf("too many workspaces: %d (max %d)", len(s.session.Workspaces), MaxWorkspaces)
		}
		ws = ws.Clone()
		ws.Stale = false
		// Kept in step with what this edit is about to publish. The stored field
		// is the broadcast's baseline, not an answer anyone reads, so a write
		// that leaves it behind makes the next refresh report a change that has
		// already been told.
		ws.refreshAvailability()
		s.session.Workspaces = append(s.session.Workspaces, ws)
		if err := s.store.Save(s.session); err != nil {
			return Workspace{}, err
		}
		return ws.availableNow(), nil
	})
}

// UpdateWorkspace applies a patch to one workspace and returns it as stored.
//
// A closed workspace takes no further changes. Closing is the end of a
// workspace's life rather than a state it can be talked out of: conversations
// have already been told it is gone, and reviving the row would leave them
// bound to something they were told to rebind away from. A new workspace is
// what a second life looks like.
func (m *SessionManager) UpdateWorkspace(id string, patch WorkspacePatch) (Workspace, error) {
	if !m.projectOpen() {
		return Workspace{}, ErrNoProject
	}
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, ErrNoProject
		}
		idx := -1
		for i, ws := range s.session.Workspaces {
			if ws.ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return Workspace{}, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, id)
		}
		ws := s.session.Workspaces[idx].Clone()
		if ws.State == WorkspaceStateClosed {
			return Workspace{}, fmt.Errorf("workspace %s is closed", id)
		}
		if patch.Label != nil {
			ws.Label = *patch.Label
		}
		if patch.Root != nil {
			ws.Root = *patch.Root
		}
		if patch.State != nil {
			ws.State = *patch.State
		}
		// Where its box is drawn, which is the one field a viewer writes on
		// nobody's behalf but the user's: it is what a box drag commits.
		if patch.Place != nil {
			ws.Place = *patch.Place
		}
		if len(patch.Meta) > 0 {
			if ws.Meta == nil {
				ws.Meta = map[string]any{}
			}
			for k, v := range patch.Meta {
				if v == nil {
					delete(ws.Meta, k)
					continue
				}
				ws.Meta[k] = v
			}
		}
		if err := ws.Validate(); err != nil {
			return Workspace{}, err
		}
		// A row that has left provisioning is no longer a leftover of a
		// provision that died, whatever an earlier load decided.
		if ws.State != WorkspaceStateProvisioning {
			ws.Stale = false
		}
		ws.refreshAvailability() // the broadcast's baseline; see RegisterWorkspace
		s.session.Workspaces[idx] = ws
		// A patch is the other way a row can be closed — it is how the reconcile
		// pass tombstones one that has moved on — so the cap is applied here too,
		// or a table could only be trimmed through the close route.
		if ws.State == WorkspaceStateClosed {
			closeWorkspaceAt(s.session, idx)
			ws = s.session.Workspaces[idx].Clone()
			pruneClosedWorkspaces(s.session)
		}
		if err := s.store.Save(s.session); err != nil {
			return Workspace{}, err
		}
		return ws.availableNow(), nil
	})
}

// ReorderWorkspaces rewrites the order the table is held in, which is the order
// the boxes sharing a place are drawn in.
//
// A box sits behind a conversation (see Workspace.Place), which puts it in one
// of the gaps between them — and two boxes in the same gap, with no conversation
// between them to tell them apart, are drawn in the order the table holds them.
// So that order is part of what the sidebar shows, and a user who drags one
// empty box above another has changed nothing on either row: the table is the
// only field that holds where those two boxes sit, which is why the move is
// recorded here.
//
// Named rows come first, in the order given; anything unnamed keeps its relative
// order behind them. An id that is not on the table is ignored — the caller is
// describing a strip that may have been drawn before a workspace was closed.
func (m *SessionManager) ReorderWorkspaces(ids []string) ([]Workspace, error) {
	if !m.projectOpen() {
		return nil, ErrNoProject
	}
	return runWrite(m, func(s *sessionState) ([]Workspace, error) {
		if s.session == nil {
			return nil, ErrNoProject
		}
		byID := make(map[string]int, len(s.session.Workspaces))
		for i, ws := range s.session.Workspaces {
			byID[ws.ID] = i
		}

		ordered := make([]Workspace, 0, len(s.session.Workspaces))
		taken := make(map[string]bool, len(ids))
		for _, id := range ids {
			idx, ok := byID[id]
			if !ok || taken[id] {
				continue
			}
			taken[id] = true
			ordered = append(ordered, s.session.Workspaces[idx])
		}
		for _, ws := range s.session.Workspaces {
			if !taken[ws.ID] {
				ordered = append(ordered, ws)
			}
		}

		same := true
		for i := range ordered {
			if ordered[i].ID != s.session.Workspaces[i].ID {
				same = false
				break
			}
		}
		if same {
			return listWorkspaces(s.session), nil
		}

		s.session.Workspaces = ordered
		if err := s.store.Save(s.session); err != nil {
			return nil, err
		}
		return listWorkspaces(s.session), nil
	})
}

// listWorkspaces answers with the table as a caller reads it: availability
// live rather than as last recorded.
func listWorkspaces(session *Session) []Workspace {
	list := make([]Workspace, 0, len(session.Workspaces))
	for _, ws := range session.Workspaces {
		list = append(list, ws.availableNow())
	}
	return list
}

// CloseWorkspace tombstones a workspace: the row stays, the state becomes
// closed, and operations against it fail saying so.
//
// It is a tombstone rather than a deletion because the id outlives it. Any
// number of conversations may be bound to a workspace and none of them owns it,
// so the one that closes it leaves the others holding an id — and an id that
// still resolves can say "this was closed" where one that has been forgotten
// can only say "unknown", which is the message reserved for a binding that is
// genuinely stale.
//
// Closing one that is already closed is not an error: two windows may reach it,
// and neither is in a position to know what the other did.
func (m *SessionManager) CloseWorkspace(id string) (Workspace, error) {
	if !m.projectOpen() {
		return Workspace{}, ErrNoProject
	}
	return runWrite(m, func(s *sessionState) (Workspace, error) {
		if s.session == nil {
			return Workspace{}, ErrNoProject
		}
		for i, ws := range s.session.Workspaces {
			if ws.ID != id {
				continue
			}
			if ws.State == WorkspaceStateClosed {
				return ws.availableNow(), nil
			}
			closeWorkspaceAt(s.session, i)
			closed := s.session.Workspaces[i].availableNow()
			// After the clone: the prune may move or remove rows, and what this
			// answers with is the row as it was closed either way. A tombstone
			// that was evicted the moment it was made is still what happened.
			pruneClosedWorkspaces(s.session)
			if err := s.store.Save(s.session); err != nil {
				return Workspace{}, err
			}
			return closed, nil
		}
		return Workspace{}, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, id)
	})
}

// closeWorkspaceAt tombstones the row at an index and stamps when, which is
// what orders the cap. Shared by the two paths that can close one, so that a
// row closed by a patch is as evictable as one closed by the close route.
func closeWorkspaceAt(session *Session, i int) {
	ws := session.Workspaces[i]
	ws.State = WorkspaceStateClosed
	ws.Stale = false
	if ws.ClosedAt == "" {
		ws.ClosedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	session.Workspaces[i] = ws
}

// pruneClosedWorkspaces drops the oldest tombstones past MaxClosedWorkspaces,
// and reports whether it removed any.
//
// Oldest by when they were closed rather than by their place in the table: the
// table is in registration order, and the workspace made first is not
// generally the one finished with first. A tombstone from before this field
// existed sorts oldest, which is the right end for it.
func pruneClosedWorkspaces(session *Session) bool {
	closed := make([]int, 0, len(session.Workspaces))
	for i, ws := range session.Workspaces {
		if ws.State == WorkspaceStateClosed {
			closed = append(closed, i)
		}
	}
	if len(closed) <= MaxClosedWorkspaces {
		return false
	}

	sort.SliceStable(closed, func(a, b int) bool {
		return session.Workspaces[closed[a]].ClosedAt < session.Workspaces[closed[b]].ClosedAt
	})
	doomed := make(map[int]bool, len(closed)-MaxClosedWorkspaces)
	for _, i := range closed[:len(closed)-MaxClosedWorkspaces] {
		doomed[i] = true
	}

	kept := make([]Workspace, 0, len(session.Workspaces)-len(doomed))
	for i, ws := range session.Workspaces {
		if !doomed[i] {
			kept = append(kept, ws)
		}
	}
	session.Workspaces = kept
	return true
}

// ClaimWorkspaceReconcile answers yes to the first client of this run that
// offers to reconcile the workspace table against what is on disk, and no to
// every client after it.
//
// Reconciling means asking each provider what it can actually find — running
// `git worktree list` and its like, offering to clean up what nothing is bound
// to. That is the browser's job, because only the browser has the providers.
// But there is no leader among clients: without this, every open window would
// run it, and two windows would race each other's destructive git commands over
// the same trees.
//
// Settled on the actor goroutine, where two windows opening together are
// serialized and the second is told no. Deliberately not persisted: a run that
// ends before reconciling leaves the next one to do it.
func (m *SessionManager) ClaimWorkspaceReconcile() bool {
	if !m.projectOpen() {
		return false
	}
	claimed, _ := runWrite(m, func(s *sessionState) (bool, error) {
		if s.session == nil || s.workspacesReconciled {
			return false, nil
		}
		s.workspacesReconciled = true
		return true, nil
	})
	return claimed
}

// WorkspacesUnwatched records that no window is watching this project any more:
// every provisioning row is flagged stale, and the reconcile is offered afresh.
//
// The load-time sweep's argument is that provisioning is browser-driven, so a
// row still in that state when no browser can be driving it is a provision that
// died. Session load is one moment where that holds; the last window closing —
// which is what a page reload is, for the length of the reload — is the other.
// Without this, a provision interrupted by a reload leaves its row and its
// half-built tree until the app is restarted, because the claim was spent by
// the window that has gone.
//
// Re-offering the claim keeps the one-window rule it exists for: it puts the
// offer back, it does not make it standing, and it is only ever put back at a
// moment when nothing is provisioning.
func (m *SessionManager) WorkspacesUnwatched() {
	if !m.projectOpen() {
		return
	}
	_, _ = runWrite(m, func(s *sessionState) (bool, error) {
		if s.session == nil {
			return false, nil
		}
		changed := false
		for i := range s.session.Workspaces {
			ws := &s.session.Workspaces[i]
			if ws.State == WorkspaceStateProvisioning && !ws.Stale {
				ws.Stale = true
				changed = true
			}
		}
		s.workspacesReconciled = false
		if changed {
			if err := s.store.Save(s.session); err != nil {
				return false, err
			}
		}
		return changed, nil
	})
}

// UnregisterWorkspace removes a row outright — what rolling back a provision
// does, and the one case where forgetting is right: the workspace was never
// built, so there is nothing for anyone to have been bound to.
//
// Removing one that is not there is not an error, for the same reason closing
// twice isn't: rollback and cleanup can both arrive here.
func (m *SessionManager) UnregisterWorkspace(id string) error {
	if !m.projectOpen() {
		return ErrNoProject
	}
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		for i, ws := range s.session.Workspaces {
			if ws.ID != id {
				continue
			}
			s.session.Workspaces = append(s.session.Workspaces[:i], s.session.Workspaces[i+1:]...)
			return struct{}{}, s.store.Save(s.session)
		}
		return struct{}{}, nil
	})
	return err
}
