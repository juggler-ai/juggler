//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
)

// Workspace is the environment a conversation's tools run in: somewhere to
// execute commands and read and write files, plus the identity that place is
// shown under. A project has one implicit workspace — itself — and as many
// registered ones as the user has made.
//
// Every session has a default workspace that is not in this table: id "",
// rooted at the project path. A conversation bound to it behaves as if
// workspaces did not exist, which is what keeps the feature free when nobody
// uses it.
//
// Kind and Root are carried here, on the server's own row, rather than being
// asked of whatever extension created the workspace. Kind is stored data:
// RegisterWorkspace records local for a registration that names none, and
// OpenError alone says whether this server can open a row. A Root is a path on
// this machine only for a row OpenError accepts, so nothing stats one before
// asking. An extension can be
// disabled, uninstalled, or simply fail to load while its workspaces are still
// on the table and conversations are still bound to them; resolving an
// operation must not depend on any of that. What the provider supplies —
// status, finish actions, reconciliation — degrades when it is absent. Where
// the files are does not.
//
// Meta is opaque to the server: it is the provider's own record of what it
// built (a base branch, a host, which steps have run), stored and returned
// verbatim. It is also the only thing a half-finished provision leaves behind
// that survives the process that started it, so a provider writes into it
// before each irreversible step rather than after.
//
// Place is where the workspace's box sits in the tab bar. A workspace is a
// place rather than an event, so its box holds a position of its own: one taken
// from whichever conversation happened to be in it would move whenever work
// started or finished there, and an empty box would have nothing to take a
// position from at all.
//
// It has three values, and the distinction between the first two is the whole
// point of the field:
//
//   - "" — no place recorded. A row written before boxes kept one, or one whose
//     place stopped meaning anything (see reconcileWorkspaceAnchors). The box is
//     drawn by the older reading of the bar: at its first conversation, or past
//     everything when it has none.
//   - PlaceHead — the head of the bar, asked for and stored.
//   - a conversation id — immediately behind that conversation.
//
// "Nowhere recorded" must never read as "the top", or every box climbs to the
// top of the sidebar the first time anything about it is unknown. A neighbour
// rather than an index is what lets a real place survive conversations being
// created and binned elsewhere in the bar; removeConvIDFromSession re-anchors it
// when the neighbour itself goes.
type Workspace struct {
	ID              string         `json:"id"`                        // Server-assigned, stable for the workspace's life
	Kind            string         `json:"kind"`                      // "local" (WorkspaceKindLocal) is this machine, and the only kind that opens; see OpenError
	Root            string         `json:"root"`                      // Absolute path to the tree
	Label           string         `json:"label,omitempty"`           // What the UI calls it, e.g. "feat/tunnels"
	Place           string         `json:"place,omitempty"`           // Where its box sits: "" for unrecorded, PlaceHead, or the conversation it sits behind
	ProviderID      string         `json:"providerId,omitempty"`      // Extension owning its lifecycle; empty for one nobody manages
	BaseWorkspaceID string         `json:"baseWorkspaceId,omitempty"` // The workspace it was provisioned from; empty means the default
	State           string         `json:"state"`                     // provisioning | ready | closed
	Meta            map[string]any `json:"meta,omitempty"`            // Provider-private; never interpreted here
	Available       bool           `json:"available"`                 // Whether its root is there; recomputed on every read (see availableNow), never read back from disk
	Stale           bool           `json:"stale,omitempty"`           // Provisioning, but no process is provisioning it (see verifyWorkspaces)
	ClosedAt        string         `json:"closedAt,omitempty"`        // RFC3339, set when it was finished with; orders the tombstone cap
}

// DefaultWorkspaceID is the id of the workspace that is the project itself. It
// is deliberately the empty string: a conversation that has never heard of
// workspaces is bound to it by saying nothing, and an operation that names no
// workspace runs where every operation used to run.
const DefaultWorkspaceID = ""

// WorkspaceKindLocal is the kind of a tree on the machine Juggler is running
// on. RegisterWorkspace records it for a registration that names no kind, and
// it is the only kind OpenError lets open.
const WorkspaceKindLocal = "local"

// OpenError is why this server cannot open the row, or nil when it can. Only a
// local row is a tree on this machine; any other kind is refused by name, and
// its Root is never read as a path here.
func (w Workspace) OpenError() error {
	if w.Kind == WorkspaceKindLocal {
		return nil
	}
	return fmt.Errorf("workspace %s is a %q workspace, which this server cannot open", w.Name(), w.Kind)
}

// The three states of a workspace. There are three rather than the obvious
// closed-or-not because a workspace exists on the table before it is usable: it
// is registered up front so that a provision interrupted half way through
// leaves a row to clean up, instead of debris on disk that nothing knows about.
//
// Both non-ready states refuse operations, and they say different things when
// they do: one is a workspace that is still being built, the other is one
// somebody finished with.
const (
	WorkspaceStateProvisioning = "provisioning"
	WorkspaceStateReady        = "ready"
	WorkspaceStateClosed       = "closed"
)

// Limits on the table. Not a security boundary — it is all the user's own state
// — but it is persisted into session.json and broadcast to every viewer on each
// edit, which is enough reason to have a ceiling.
//
// Sixty-four workspaces is far past the point of being useful: the heaviest
// worktree habit runs to a handful of pooled trees.
const (
	MaxWorkspaces         = 64
	MaxWorkspaceMetaBytes = 16 * 1024
	MaxWorkspaceLabelLen  = 256
)

// MaxClosedWorkspaces is how many tombstones are kept before the oldest are
// dropped.
//
// A closed row describes nothing on disk. It is kept for one purpose: so a
// conversation still bound to it is told its workspace was finished with, and
// by whom, rather than that the id is unknown. That is worth having for a
// workspace somebody may go back to and worth nothing for the hundredth one
// they finished with last month — and without a ceiling the table only ever
// grows, since nothing else removes them.
//
// Sixteen because the message is for the recently departed. Past that the
// oldest go, and a conversation bound to one that has gone gets the banner for
// a binding the table has lost, which offers to put it back. That is a worse
// sentence, not a broken state.
//
// Only closed rows are counted and only closed rows are evicted: a workspace
// somebody is still working in is never given up to make room.
const MaxClosedWorkspaces = 16

// workspaceIDRe constrains workspace ids to what can be used unescaped as a map
// key, a log token and a JSON field. Ids are assigned here rather than by the
// client (unlike pins), but they are echoed back in every operation request, so
// the shape is still checked on the way in.
var workspaceIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// GenerateWorkspaceID returns a fresh `ws_<9-char base36>` id. Workspace ids are
// allocated here rather than by the client: they are what an operation request
// names, so the set of ids that resolve is exactly the set the server made.
func GenerateWorkspaceID() string {
	return generatePrefixedID("ws_")
}

// refreshAvailability records whether this workspace's root is there right now.
//
// Only a ready workspace's availability means anything: one still being
// provisioned has a root that does not exist yet by design, and both non-ready
// states refuse operations regardless. Checking it for them anyway keeps the
// field's meaning literal — the root is there — rather than making it a
// second, quieter copy of the state.
//
// The stored field is written only by RefreshWorkspaceAvailability, whose job
// is noticing a change worth telling the viewers about. Everything that reads
// a row gets a live answer instead.
//
// A row this server cannot open is never available: its root is not a path on
// this machine, so a directory that happens to have that name proves nothing.
func (w *Workspace) refreshAvailability() {
	if w.Root == "" || w.OpenError() != nil {
		w.Available = false
		return
	}
	info, err := os.Stat(w.Root)
	w.Available = err == nil && info.IsDir()
}

// availableNow returns a clone whose Available reports whether the root is
// there at this moment. Every path that hands a row outside the actor goes
// through it, which is what makes the stored field unreadable rather than
// merely refreshed often: a caller cannot obtain the cached value even by
// asking before anything has re-checked it.
//
// The stat is the same one WorkspaceLookup.Usable makes, deliberately. Two
// answers to one question is what this removes; the remaining cost is a stat
// per row per read, of at most MaxWorkspaces local directories.
func (w Workspace) availableNow() Workspace {
	c := w.Clone()
	c.refreshAvailability()
	return c
}

// Clone returns a copy whose meta map the caller may mutate freely. The values
// inside it are shared by reference, as elsewhere in the session: they are only
// ever replaced wholesale, never edited in place.
func (w Workspace) Clone() Workspace {
	c := w
	if w.Meta != nil {
		c.Meta = make(map[string]any, len(w.Meta))
		for k, v := range w.Meta {
			c.Meta[k] = v
		}
	}
	return c
}

// IsReady reports whether operations may run against this workspace.
func (w Workspace) IsReady() bool { return w.State == WorkspaceStateReady }

// Validate checks a workspace the client is asking to register or update.
func (w Workspace) Validate() error {
	if w.ID != "" && !workspaceIDRe.MatchString(w.ID) {
		return fmt.Errorf("invalid workspace id: %q", w.ID)
	}
	if w.Kind == "" {
		return fmt.Errorf("workspace must have a kind")
	}
	if w.Root == "" {
		return fmt.Errorf("workspace must have a root")
	}
	if len([]rune(w.Label)) > MaxWorkspaceLabelLen {
		return fmt.Errorf("workspace label is too long (%d chars, max %d)", len([]rune(w.Label)), MaxWorkspaceLabelLen)
	}
	// Shape only. A place naming a conversation this session does not have is
	// repaired on the next load rather than refused here: the id is a position
	// in the bar, and a stale one is a box drawn in the wrong place, never a
	// reason to reject the edit that carried it.
	if w.Place != "" && w.Place != PlaceHead && !IsValidConvID(w.Place) {
		return fmt.Errorf("invalid workspace place: %q", w.Place)
	}
	switch w.State {
	case WorkspaceStateProvisioning, WorkspaceStateReady, WorkspaceStateClosed:
	default:
		return fmt.Errorf("invalid workspace state: %q", w.State)
	}
	return validateWorkspaceMeta(w.Meta)
}

// validateWorkspaceMeta checks that a provider's private blob is JSON the
// server can store and hand back, and that it is not unreasonably large.
func validateWorkspaceMeta(meta map[string]any) error {
	if len(meta) == 0 {
		return nil
	}
	encoded, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("workspace meta is not serialisable: %w", err)
	}
	if len(encoded) > MaxWorkspaceMetaBytes {
		return fmt.Errorf("workspace meta is too large (%d bytes, max %d)", len(encoded), MaxWorkspaceMetaBytes)
	}
	return nil
}

// verifyWorkspaces is the load-time pass over the table: it flags every row
// that was being provisioned when the last process ended. Returns whether
// anything changed, so the caller only writes the manifest when it has
// something to say.
//
// No row is refused or dropped here, whatever its kind: one this server cannot
// open stays on the table and is refused when something asks to work in it.
//
// It runs on the server, at session load, rather than in the browser once the
// extensions are up. There is no leader among clients, so a browser-side pass
// means every open window runs it — duplicate offers, and two windows racing
// the same destructive cleanup. This half needs no provider and no UI: it is a
// flag, and it is the same answer however many windows are watching.
//
// Provisioning is browser-driven, so a row still in that state at load is stale
// by definition: the process that was building it is gone. That makes the rule
// a line rather than a heuristic with a timeout — there is no case where one is
// legitimately still running.
//
// It deliberately does not re-check the roots. Availability is computed on
// every read (see availableNow), so a load-time stat would be answering a
// question nobody asks until the next read, which stats again anyway.
func verifyWorkspaces(session *Session) bool {
	changed := false
	for i := range session.Workspaces {
		ws := &session.Workspaces[i]
		if ws.State == WorkspaceStateProvisioning && !ws.Stale {
			ws.Stale = true
			changed = true
		}
	}
	return changed
}

// WorkspaceLookup answers what a workspace id means to the session holding the
// table. It reports false for an id the session has never registered — which
// must stay a refusal, never a fall back to the project.
type WorkspaceLookup func(id string) (Workspace, bool)

// Usable resolves an id to the workspace that may be worked in, or says why it
// may not be. Everything that acts on a conversation's binding goes through
// here, by way of workspace.Resolver — an operation from the engine, the
// directory a provider's CLI is spawned in — so that the answer cannot differ
// between them: a turn that refuses to run is far better than one that runs
// somewhere else.
//
// The five refusals, and why each is what it is:
//
//   - One still being provisioned refuses, saying so. The UI parks a send until
//     its workspace is ready, so this is the inherited binding and the second
//     window, not the common path.
//   - A closed one refuses too, and differently: the id still resolves, so the
//     conversation can be told the workspace was finished with rather than that
//     it never existed.
//   - A kind this server cannot open refuses by name (see OpenError), and is
//     asked before the root, which is not a path on this machine for such a
//     row: "missing its root" would send the user looking for a directory.
//   - A root that has gone (the worktree was removed behind our back) fails
//     once and legibly, rather than as a run of cryptic errors from whichever
//     operation happened to touch it first.
//   - An id the session does not know is an error and never a fall back to the
//     project. A stale binding that silently ran in the project root would edit
//     the wrong tree, and look exactly like working.
//
// The default workspace is not asked about here: it has no row, and
// workspace.Resolver answers it with the project.
func (lookup WorkspaceLookup) Usable(id string) (Workspace, error) {
	if lookup == nil {
		return Workspace{}, fmt.Errorf("unknown workspace: %s", id)
	}
	ws, ok := lookup(id)
	if !ok {
		return Workspace{}, fmt.Errorf("unknown workspace: %s", id)
	}
	switch ws.State {
	case WorkspaceStateReady:
	case WorkspaceStateProvisioning:
		return Workspace{}, fmt.Errorf("workspace %s is still being created", ws.Name())
	case WorkspaceStateClosed:
		return Workspace{}, fmt.Errorf("workspace %s was closed", ws.Name())
	default:
		return Workspace{}, fmt.Errorf("workspace %s is in an unknown state: %s", ws.Name(), ws.State)
	}
	if err := ws.OpenError(); err != nil {
		return Workspace{}, err
	}
	if info, err := os.Stat(ws.Root); err != nil || !info.IsDir() {
		return Workspace{}, fmt.Errorf("workspace %s is missing its root: %s", ws.Name(), ws.Root)
	}
	return ws, nil
}

// Name is what to call a workspace in an error: its label when it has one,
// since that is what the user named it, and its id otherwise.
func (w Workspace) Name() string {
	if w.Label != "" {
		return w.Label
	}
	return w.ID
}

// FindWorkspace returns the registered workspace with this id.
//
// The default workspace is deliberately not one of them: it has no row, and the
// caller that needs a root for it already holds the project path. Asking for
// "" here is therefore a miss, not the project.
func (s *Session) FindWorkspace(id string) (Workspace, bool) {
	for _, ws := range s.Workspaces {
		if ws.ID == id {
			return ws, true
		}
	}
	return Workspace{}, false
}
