//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// workspaceForTest returns a ready local workspace rooted at an existing
// directory, which is what the load-time verification pass expects to find.
func workspaceForTest(t *testing.T, id, root string) Workspace {
	t.Helper()
	return Workspace{
		ID:         id,
		Kind:       WorkspaceKindLocal,
		Root:       root,
		Label:      "feat/tunnels",
		ProviderID: "git-worktree",
		State:      WorkspaceStateReady,
		Available:  true,
		Meta:       map[string]any{"branch": "feat/tunnels", "treeAdded": true},
	}
}

// No caller can be handed a stale answer about whether a root is there.
//
// Availability used to be a cache: stat'd at load and at each register or
// update, then persisted and broadcast. `Usable` meanwhile stat'd afresh on
// every call, so the same question had two answers that were free to disagree
// — and a tree removed while the app ran left the cached one saying yes for
// the rest of the session. Every row that leaves the actor now carries a live
// answer, so the cache cannot be read back.
//
// Nothing here calls RefreshWorkspaceAvailability: that exists to notice a
// change worth broadcasting, and if the reads below depended on it having run
// the cache would simply have a longer fuse.
func TestWorkspaces_AvailabilityIsNeverServedFromTheCache(t *testing.T) {
	project := t.TempDir()
	mgr, err := NewSessionManagerForPath(project)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	tree := filepath.Join(project, "a-worktree")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ws, err := mgr.RegisterWorkspace(Workspace{
		Kind: WorkspaceKindLocal, Root: tree, Label: "feat/tunnels", State: WorkspaceStateReady,
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if !ws.Available {
		t.Fatalf("registered = %+v, want available while its tree is there", ws)
	}

	if err := os.RemoveAll(tree); err != nil {
		t.Fatalf("removing the tree: %v", err)
	}

	if listed := mgr.ListWorkspaces(); len(listed) != 1 || listed[0].Available {
		t.Fatalf("ListWorkspaces = %+v, want the row reporting its root has gone", listed)
	}
	if got, ok := mgr.GetWorkspace(ws.ID); !ok || got.Available {
		t.Fatalf("GetWorkspace = %+v (ok=%v), want the row reporting its root has gone", got, ok)
	}

	// And back again, because a place that returns is usable again. This is the
	// half a tombstone could never give back, and the reason a missing root is
	// not one.
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatalf("remaking the tree: %v", err)
	}
	if got, _ := mgr.GetWorkspace(ws.ID); !got.Available {
		t.Fatalf("GetWorkspace = %+v, want it available once its tree is back", got)
	}
}

// A registered workspace survives a trip through session.json. The table is the
// only record of where a conversation's files are, so anything dropped here
// strands every conversation bound to it.
func TestWorkspaces_SurviveSaveAndLoad(t *testing.T) {
	store, dir := newStoreForTest(t)

	sess := NewSession()
	sess.Workspaces = []Workspace{workspaceForTest(t, "ws_1", dir)}
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Workspaces) != 1 {
		t.Fatalf("Workspaces = %v, want the one that was saved", loaded.Workspaces)
	}
	got := loaded.Workspaces[0]
	want := sess.Workspaces[0]
	if got.ID != want.ID || got.Kind != want.Kind || got.Root != want.Root ||
		got.Label != want.Label || got.ProviderID != want.ProviderID || got.State != want.State {
		t.Fatalf("workspace round-tripped as %+v, want %+v", got, want)
	}
	if got.Meta["branch"] != "feat/tunnels" || got.Meta["treeAdded"] != true {
		t.Fatalf("meta round-tripped as %v, want the provider's blob verbatim", got.Meta)
	}
}

// A box's place survives a trip through session.json alongside the row it
// belongs to. An anchor naming a conversation the session still has is a live
// position, and the load-time reconcile leaves it alone.
func TestWorkspaces_PlaceSurvivesSaveAndLoad(t *testing.T) {
	store, dir := newStoreForTest(t)

	convID, _, _, err := store.CreateConversationFolder("Anchor", "conv_anchor1")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}

	sess := NewSession()
	sess.ConversationOrder = []string{convID}
	ws := workspaceForTest(t, "ws_1", dir)
	ws.Place = convID
	sess.Workspaces = []Workspace{ws}
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Workspaces) != 1 || loaded.Workspaces[0].Place != convID {
		t.Fatalf("Workspaces = %+v, want the box still anchored to %s", loaded.Workspaces, convID)
	}
}

// A box keeps its place when the conversation it sits behind is binned: it
// inherits that conversation's predecessor rather than being left pointing at
// something the order no longer has.
func TestRemoveConv_ReanchorsBoxesOntoThePredecessor(t *testing.T) {
	sess := NewSession()
	sess.ConversationOrder = []string{"conv_a", "conv_b", "conv_c"}
	sess.Workspaces = []Workspace{
		workspaceForTest(t, "ws_mid", t.TempDir()),
		workspaceForTest(t, "ws_head", t.TempDir()),
		workspaceForTest(t, "ws_other", t.TempDir()),
	}
	sess.Workspaces[0].Place = "conv_b"
	sess.Workspaces[1].Place = "conv_a"
	sess.Workspaces[2].Place = "conv_c"

	removeConvIDFromSession(sess, "conv_b")
	if got := sess.Workspaces[0].Place; got != "conv_a" {
		t.Fatalf("place = %q, want conv_a — a box inherits its neighbour's place", got)
	}

	// A box behind the first conversation has no predecessor to inherit, so it
	// takes the head of the bar — named as the head, never as an empty field,
	// which means no place at all. The box re-anchored a moment ago follows its
	// new neighbour down to the same place.
	removeConvIDFromSession(sess, "conv_a")
	if got := sess.Workspaces[1].Place; got != PlaceHead {
		t.Fatalf("place = %q, want %q", got, PlaceHead)
	}
	if got := sess.Workspaces[0].Place; got != PlaceHead {
		t.Fatalf("place = %q, want the re-anchored box to follow its new neighbour", got)
	}
	if got := sess.Workspaces[2].Place; got != "conv_c" {
		t.Fatalf("place = %q, want a box anchored elsewhere left alone", got)
	}
}

// A box keeps the place it is drawn in when the conversation it sits behind is
// dragged somewhere else, the same way it does when that conversation is binned.
// The tab a box is anchored to is an ordinary tab with nothing drawn on it to
// say so, so a box that travelled with it would be moving on a gesture aimed at
// something else entirely — and the drag that provoked this could send a box
// four slots up the bar.
//
// The mover is named by the client rather than read back off the order: two
// adjacent tabs swapping leaves the same pair of sequences whichever of them was
// dragged, so there is nothing in the order itself to tell them apart.
func TestReorderConversations_ReanchorsBoxOffTheDraggedConversation(t *testing.T) {
	// The bar is [a, b, c, d] with a box drawn between b and c.
	tests := []struct {
		name       string
		next       []int
		place      int
		moved      int
		want       int
		reanchored bool
	}{
		{
			name:       "dragged to the head of the bar",
			next:       []int{1, 0, 2, 3},
			place:      1,
			moved:      1,
			want:       0,
			reanchored: true,
		},
		{
			name:       "dragged past the end of the bar",
			next:       []int{0, 2, 3, 1},
			place:      1,
			moved:      1,
			want:       0,
			reanchored: true,
		},
		{
			// The tab was already in front of the one below the box, so the flat
			// order comes back identical and the box is the only thing that has
			// moved. A re-anchor conditional on the order changing would miss
			// this one, and the tab would spring back above the box on reload.
			name:       "dragged from above the box to just below it",
			next:       []int{0, 1, 2, 3},
			place:      1,
			moved:      1,
			want:       0,
			reanchored: true,
		},
		{
			name:       "a box anchored to some other tab is left alone",
			next:       []int{1, 0, 2, 3},
			place:      2,
			moved:      1,
			want:       2,
			reanchored: false,
		},
		{
			// A bump, a duplicate, or a viewer syncing its whole list: nothing
			// was dragged, so no box gives up its place.
			name:       "a reorder that names no mover moves no box",
			next:       []int{1, 0, 2, 3},
			place:      1,
			moved:      -1,
			want:       1,
			reanchored: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			projectDir := t.TempDir()
			store, err := NewFileSessionStore(projectDir)
			if err != nil {
				t.Fatal(err)
			}
			mgr, err := NewSessionManager(SessionManagerConfig{Store: store, ProjectPath: projectDir})
			if err != nil {
				t.Fatal(err)
			}
			defer mgr.Shutdown()

			ids := make([]string, 4)
			for i, name := range []string{"A", "B", "C", "D"} {
				id, _, err := mgr.CreateConversation(name)
				if err != nil {
					t.Fatal(err)
				}
				ids[i] = id
			}
			// A new conversation is created at the head of the bar, so the order
			// they were made in is the reverse of the one they are in. Say it.
			if _, _, err := mgr.ReorderConversations(ids, ""); err != nil {
				t.Fatalf("setting up the order: %v", err)
			}

			ws, err := mgr.RegisterWorkspace(Workspace{
				Root:  t.TempDir(),
				State: WorkspaceStateReady,
				Place: ids[tc.place],
			})
			if err != nil {
				t.Fatalf("RegisterWorkspace: %v", err)
			}

			next := make([]string, len(tc.next))
			for i, at := range tc.next {
				next[i] = ids[at]
			}
			moved := ""
			if tc.moved >= 0 {
				moved = ids[tc.moved]
			}

			_, reanchored, err := mgr.ReorderConversations(next, moved)
			if err != nil {
				t.Fatalf("reorder: %v", err)
			}
			if reanchored != tc.reanchored {
				t.Fatalf("reanchored = %v, want %v — the caller broadcasts the workspace table on the strength of this", reanchored, tc.reanchored)
			}

			var got string
			for _, row := range mgr.ListWorkspaces() {
				if row.ID == ws.ID {
					got = row.Place
				}
			}
			if want := ids[tc.want]; got != want {
				t.Fatalf("place = %q, want %q (conversation %d of [a b c d])", got, want, tc.want)
			}
		})
	}
}

// A box behind the first conversation has no predecessor to inherit when that
// conversation is dragged away, so it takes the head of the bar — named as the
// head, which is a position, and never as an empty field, which is the absence
// of one.
func TestReorderConversations_ReanchorsToTheHeadWhenNothingIsAhead(t *testing.T) {
	projectDir := t.TempDir()
	store, err := NewFileSessionStore(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := NewSessionManager(SessionManagerConfig{Store: store, ProjectPath: projectDir})
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	a, _, err := mgr.CreateConversation("A")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := mgr.CreateConversation("B")
	if err != nil {
		t.Fatal(err)
	}

	// A new conversation is created at the head, so b is above a until this says
	// otherwise. The box is then anchored to the first tab in the bar.
	if _, _, err := mgr.ReorderConversations([]string{a, b}, ""); err != nil {
		t.Fatalf("setting up the order: %v", err)
	}

	ws, err := mgr.RegisterWorkspace(Workspace{Root: t.TempDir(), State: WorkspaceStateReady, Place: a})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	if _, _, err := mgr.ReorderConversations([]string{b, a}, a); err != nil {
		t.Fatalf("reorder: %v", err)
	}

	var got string
	for _, row := range mgr.ListWorkspaces() {
		if row.ID == ws.ID {
			got = row.Place
		}
	}
	if got != PlaceHead {
		t.Fatalf("place = %q, want %q", got, PlaceHead)
	}
}

// A manifest edited between runs can name a conversation that is not there. The
// box goes back to having no recorded place — which is the truth, and is drawn
// by its first member — rather than being sent to either end of the bar.
func TestWorkspaces_LoadClearsADanglingAnchor(t *testing.T) {
	store, dir := newStoreForTest(t)

	sess := NewSession()
	ws := workspaceForTest(t, "ws_1", dir)
	ws.Place = "conv_longgone"
	sess.Workspaces = []Workspace{ws}
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Workspaces) != 1 || loaded.Workspaces[0].Place != "" {
		t.Fatalf("Workspaces = %+v, want a dangling place cleared, not reinterpreted", loaded.Workspaces)
	}
}

// An empty place is the absence of one, and nothing may quietly turn it into a
// position.
//
// Every workspace row written before boxes kept a place has no `place` key, and
// unmarshals to the zero value. If that read as the head of the bar, every one
// of them would climb to the top of the sidebar — and so would any box whose
// place the server had to give up on. The value has to survive a load meaning
// exactly what it meant on disk: nothing.
func TestWorkspaces_AnUnplacedRowStaysUnplaced(t *testing.T) {
	store, dir := newStoreForTest(t)

	convID, _, _, err := store.CreateConversationFolder("A", "conv_only1")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}

	// A row as an older version wrote it: no place recorded at all. The root is
	// quoted by the encoder rather than pasted in, since a Windows temp path is
	// full of backslashes and would not survive as a raw JSON string body.
	root, err := json.Marshal(dir)
	if err != nil {
		t.Fatalf("marshal root: %v", err)
	}
	var ws Workspace
	if err := json.Unmarshal([]byte(`{"id":"ws_old","kind":"local","root":`+string(root)+`,"state":"ready"}`), &ws); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ws.Place != "" {
		t.Fatalf("place = %q, want a row with no place key to have no place", ws.Place)
	}

	sess := NewSession()
	sess.ConversationOrder = []string{convID}
	sess.Workspaces = []Workspace{ws}
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := loaded.Workspaces[0].Place; got != "" {
		t.Fatalf("place = %q, want it still unrecorded after a load", got)
	}

	// And binning the last conversation leaves it unrecorded rather than
	// inventing one: the box was never placed, so there is nothing to inherit.
	removeConvIDFromSession(loaded, convID)
	if got := loaded.Workspaces[0].Place; got != "" {
		t.Fatalf("place = %q, want an unplaced box left unplaced by a bin", got)
	}
}

// Clone must deep-copy the table. A snapshot handed out by GetSession is
// mutated freely by its caller; if the meta map were shared, a provider
// checkpointing into a snapshot would be writing into the actor's live state.
func TestWorkspaces_CloneIsolatesMeta(t *testing.T) {
	sess := NewSession()
	sess.Workspaces = []Workspace{workspaceForTest(t, "ws_1", t.TempDir())}

	snapshot := sess.Clone()
	snapshot.Workspaces[0].Meta["branch"] = "something-else"
	snapshot.Workspaces[0].Label = "renamed"
	snapshot.Workspaces = append(snapshot.Workspaces, workspaceForTest(t, "ws_2", t.TempDir()))

	if sess.Workspaces[0].Meta["branch"] != "feat/tunnels" {
		t.Fatalf("original meta = %v, want it untouched by the snapshot", sess.Workspaces[0].Meta)
	}
	if sess.Workspaces[0].Label != "feat/tunnels" {
		t.Fatalf("original label = %q, want it untouched by the snapshot", sess.Workspaces[0].Label)
	}
	if len(sess.Workspaces) != 1 {
		t.Fatalf("original table has %d rows, want the snapshot's append to have stayed there", len(sess.Workspaces))
	}
}

// A session that has never made a workspace stores no table at all, and one
// that asks for the default workspace by id gets a miss — the project is not a
// row, and the caller that wants it already holds the project path.
func TestWorkspaces_DefaultIsNotARow(t *testing.T) {
	sess := NewSession()
	if sess.Workspaces != nil {
		t.Fatalf("new session has %v, want no table until one is made", sess.Workspaces)
	}
	if ws, ok := sess.FindWorkspace(DefaultWorkspaceID); ok {
		t.Fatalf("FindWorkspace(default) returned %+v, want a miss", ws)
	}
}

func TestWorkspace_Validate(t *testing.T) {
	base := workspaceForTest(t, "ws_1", t.TempDir())

	if err := base.Validate(); err != nil {
		t.Fatalf("a well-formed workspace was rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*Workspace)
		want   string
	}{
		{"no kind", func(w *Workspace) { w.Kind = "" }, "kind"},
		{"no root", func(w *Workspace) { w.Root = "" }, "root"},
		{"bad state", func(w *Workspace) { w.State = "half-built" }, "state"},
		{"bad id", func(w *Workspace) { w.ID = "../escape" }, "id"},
		{"long label", func(w *Workspace) { w.Label = strings.Repeat("A", MaxWorkspaceLabelLen+1) }, "label"},
		{"bad place", func(w *Workspace) { w.Place = "../escape" }, "place"},
		{"huge meta", func(w *Workspace) {
			w.Meta = map[string]any{"blob": strings.Repeat("x", MaxWorkspaceMetaBytes+1)}
		}, "meta"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ws := base.Clone()
			tc.mutate(&ws)
			err := ws.Validate()
			if err == nil {
				t.Fatalf("Validate() accepted %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Validate() = %q, want a message naming %q", err, tc.want)
			}
		})
	}
}

// managerForWorkspaceTest starts a manager on a fresh project, as a window
// would, and returns it with the project directory.
func managerForWorkspaceTest(t *testing.T) (*SessionManager, string) {
	t.Helper()
	store, dir := newStoreForTest(t)
	m := startManager(store, dir, "")
	t.Cleanup(m.Shutdown)
	return m, dir
}

// Every write to the table is refused when no project is open.
//
// A workspace is a place a conversation works, and in no-project mode there is
// no conversation and nowhere for a row to live: the session is backed by a
// scratch directory this process deletes on the way out. Accepting a
// registration would file it there and report success, telling the user a
// workspace exists that goes away when the window closes.
//
// The refusal has to be keyed on the project path rather than on the session,
// because there IS one — NewSessionManagerForPath("") makes a real session over
// the scratch dir, precisely so the rest of the server need not special-case a
// nil manager.
func TestWorkspaceWrites_RefusedWithNoProjectOpen(t *testing.T) {
	m, err := NewSessionManagerForPath("")
	if err != nil {
		t.Fatalf("NewSessionManagerForPath(\"\"): %v", err)
	}
	t.Cleanup(m.Shutdown)

	if _, err := m.RegisterWorkspace(Workspace{Root: t.TempDir(), State: WorkspaceStateReady}); err == nil {
		t.Fatal("RegisterWorkspace succeeded with no project open")
	} else if !strings.Contains(err.Error(), "no project") {
		t.Fatalf("RegisterWorkspace error = %q, want it to say no project is open", err)
	}
	if listed := m.ListWorkspaces(); len(listed) != 0 {
		t.Fatalf("ListWorkspaces = %+v, want nothing registered", listed)
	}

	// The other writes go the same way. Readers are left alone: asking an empty
	// table a question is harmless, and refusing List would make every surface
	// that shows workspaces handle an error it could do nothing about.
	if _, err := m.UpdateWorkspace("ws_anything", WorkspacePatch{}); err == nil {
		t.Fatal("UpdateWorkspace succeeded with no project open")
	}
	if _, err := m.CloseWorkspace("ws_anything"); err == nil {
		t.Fatal("CloseWorkspace succeeded with no project open")
	}
	if err := m.UnregisterWorkspace("ws_anything"); err == nil {
		t.Fatal("UnregisterWorkspace succeeded with no project open")
	}
	if m.ClaimWorkspaceReconcile() {
		t.Fatal("ClaimWorkspaceReconcile handed out the once-per-run job with no project to reconcile")
	}
}

// A workspace is registered before it is built, so the row that describes a
// provision is on the table from the first command it runs.
func TestRegisterWorkspace_DefaultsToProvisioning(t *testing.T) {
	m, _ := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: filepath.Join(t.TempDir(), "not-built-yet")})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if ws.ID == "" || !strings.HasPrefix(ws.ID, "ws_") {
		t.Fatalf("assigned id = %q, want a ws_ id", ws.ID)
	}
	if ws.State != WorkspaceStateProvisioning {
		t.Fatalf("state = %q, want %q", ws.State, WorkspaceStateProvisioning)
	}
	if ws.Kind != WorkspaceKindLocal {
		t.Fatalf("kind = %q, want %q", ws.Kind, WorkspaceKindLocal)
	}
	if ws.Available {
		t.Fatalf("available = true for a root that does not exist yet")
	}

	listed := m.ListWorkspaces()
	if len(listed) != 1 || listed[0].ID != ws.ID {
		t.Fatalf("ListWorkspaces = %+v, want the registered workspace", listed)
	}
	if got, ok := m.GetWorkspace(ws.ID); !ok || got.ID != ws.ID {
		t.Fatalf("GetWorkspace(%s) = %+v, %v", ws.ID, got, ok)
	}
	if _, ok := m.GetWorkspace("ws_nope"); ok {
		t.Fatalf("GetWorkspace of an unknown id reported a hit")
	}
}

// The flip to ready is what a finished provision writes, and it is what makes
// the root real: availability is re-checked on every write.
func TestUpdateWorkspace_ReadyFlipAndMetaMerge(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir, Meta: map[string]any{"branch": "feat/x", "treeAdded": false}})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	ready := WorkspaceStateReady
	label := "feat/x"
	updated, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{
		State: &ready,
		Label: &label,
		Meta:  map[string]any{"treeAdded": true, "hookStarted": true},
	})
	if err != nil {
		t.Fatalf("UpdateWorkspace: %v", err)
	}
	if updated.State != WorkspaceStateReady || updated.Label != "feat/x" {
		t.Fatalf("updated = %+v, want a ready workspace labelled feat/x", updated)
	}
	if !updated.Available {
		t.Fatalf("available = false for a root that is there")
	}
	// Merged, not replaced: the key the patch never mentioned survives.
	if updated.Meta["branch"] != "feat/x" || updated.Meta["treeAdded"] != true || updated.Meta["hookStarted"] != true {
		t.Fatalf("meta = %v, want the patch merged over what was there", updated.Meta)
	}

	// A nil value deletes its key, as it does for session metadata.
	updated, err = m.UpdateWorkspace(ws.ID, WorkspacePatch{Meta: map[string]any{"hookStarted": nil}})
	if err != nil {
		t.Fatalf("UpdateWorkspace (delete key): %v", err)
	}
	if _, present := updated.Meta["hookStarted"]; present {
		t.Fatalf("meta = %v, want hookStarted deleted", updated.Meta)
	}
}

// A new workspace's box is drawn at the end of the bar, and the row says so
// rather than leaving it to be worked out: nothing is bound to a workspace when
// it is registered, so there is no conversation to take a place from.
func TestRegisterWorkspace_SeedsTheBoxAtTheEndOfTheBar(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	// In a session with no conversations, the end of the bar is its head.
	first, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if first.Place != PlaceHead {
		t.Fatalf("place = %q, want %q — a bar with no conversations ends where it starts", first.Place, PlaceHead)
	}

	// A create prepends, so the last id in the order is the first one made.
	a, _, err := m.CreateConversation("A")
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	b, _, err := m.CreateConversation("B")
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}

	second, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if second.Place != a {
		t.Fatalf("place = %q, want %q — the last conversation in the order", second.Place, a)
	}

	// A registration that names its own place keeps it.
	third, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady, Place: b})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if third.Place != b {
		t.Fatalf("place = %q, want the place the registration asked for (%q)", third.Place, b)
	}
}

// Where a box sits is the user's to set, and a patch is how a box drag says so.
func TestUpdateWorkspace_PlaceIsPatchable(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	anchor := "conv_abc123"
	updated, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{Place: &anchor})
	if err != nil {
		t.Fatalf("UpdateWorkspace: %v", err)
	}
	if updated.Place != anchor {
		t.Fatalf("place = %q, want %q", updated.Place, anchor)
	}

	// The head of the bar is a position like any other and is named as one. An
	// empty field is the absence of a place, and must never be read as the top.
	head := PlaceHead
	updated, err = m.UpdateWorkspace(ws.ID, WorkspacePatch{Place: &head})
	if err != nil {
		t.Fatalf("UpdateWorkspace (to the head): %v", err)
	}
	if updated.Place != PlaceHead {
		t.Fatalf("place = %q, want %q", updated.Place, PlaceHead)
	}

	// A patch that never mentions it leaves it alone, as with every other field.
	if _, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{Place: &anchor}); err != nil {
		t.Fatalf("UpdateWorkspace: %v", err)
	}
	label := "feat/x"
	updated, err = m.UpdateWorkspace(ws.ID, WorkspacePatch{Label: &label})
	if err != nil {
		t.Fatalf("UpdateWorkspace (label only): %v", err)
	}
	if updated.Place != anchor {
		t.Fatalf("place = %q, want %q left alone by a patch about the label", updated.Place, anchor)
	}

	malformed := "../escape"
	if _, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{Place: &malformed}); err == nil {
		t.Fatalf("a malformed anchor was accepted")
	}
}

func TestUpdateWorkspace_UnknownIDIsAnError(t *testing.T) {
	m, _ := managerForWorkspaceTest(t)

	label := "ghost"
	if _, err := m.UpdateWorkspace("ws_nope", WorkspacePatch{Label: &label}); err == nil {
		t.Fatalf("UpdateWorkspace of an unknown id succeeded, want an error")
	}
}

// Closing tombstones the row, is idempotent, and is final: a closed workspace
// takes no further changes, because conversations have already been told it is
// gone.
func TestCloseWorkspace_TombstonesAndIsFinal(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	closed, err := m.CloseWorkspace(ws.ID)
	if err != nil {
		t.Fatalf("CloseWorkspace: %v", err)
	}
	if closed.State != WorkspaceStateClosed {
		t.Fatalf("state = %q, want %q", closed.State, WorkspaceStateClosed)
	}
	if again, err := m.CloseWorkspace(ws.ID); err != nil || again.State != WorkspaceStateClosed {
		t.Fatalf("closing twice = %+v, %v; want the tombstone back unchanged", again, err)
	}
	if _, ok := m.GetWorkspace(ws.ID); !ok {
		t.Fatalf("closed workspace left the table; the id must keep resolving")
	}

	ready := WorkspaceStateReady
	if _, err := m.UpdateWorkspace(ws.ID, WorkspacePatch{State: &ready}); err == nil {
		t.Fatalf("a closed workspace was reopened, want the update refused")
	}
	if _, err := m.CloseWorkspace("ws_nope"); err == nil {
		t.Fatalf("closing an unknown id succeeded, want an error")
	}
}

// Unregister is the rollback path: the workspace was never built, so there is
// nothing anyone can have been bound to, and forgetting it is right.
func TestUnregisterWorkspace_RemovesAndIsIdempotent(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if err := m.UnregisterWorkspace(ws.ID); err != nil {
		t.Fatalf("UnregisterWorkspace: %v", err)
	}
	if len(m.ListWorkspaces()) != 0 {
		t.Fatalf("table = %+v, want it empty", m.ListWorkspaces())
	}
	if err := m.UnregisterWorkspace(ws.ID); err != nil {
		t.Fatalf("unregistering twice: %v, want it to be a no-op", err)
	}
}

func TestRegisterWorkspace_RejectsDuplicateID(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{Root: dir})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if _, err := m.RegisterWorkspace(Workspace{ID: ws.ID, Root: dir}); err == nil {
		t.Fatalf("registering a second workspace under id %s succeeded", ws.ID)
	}
}

// An id offered by the caller is kept rather than replaced with a fresh one.
//
// This is what recovering a lost table is made of. A conversation's binding
// survives in its own document when session.json does not, and it is an opaque
// id: nothing on disk says which tree it meant. So the way back is to register
// the place again UNDER that id, at which point every conversation bound to it
// resolves once more — rather than adopting the tree under a new id and moving
// each conversation to it by hand.
func TestRegisterWorkspace_KeepsASuppliedID(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	ws, err := m.RegisterWorkspace(Workspace{ID: "ws_stranded", Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if ws.ID != "ws_stranded" {
		t.Fatalf("ID = %q, want the id the caller asked for", ws.ID)
	}

	found, ok := m.GetWorkspace("ws_stranded")
	if !ok || found.Root != dir {
		t.Fatalf("GetWorkspace(ws_stranded) = %+v, %v; want the row that was just registered", found, ok)
	}
}

// A registration naming a kind this server cannot open is refused at the door,
// rather than accepted onto the table as a row every operation then refuses.
func TestRegisterWorkspace_RefusesAKindItCannotOpen(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	_, err := m.RegisterWorkspace(Workspace{Kind: "elsewhere", Root: dir, State: WorkspaceStateReady})
	if err == nil || !strings.Contains(err.Error(), "elsewhere") {
		t.Fatalf("RegisterWorkspace(kind elsewhere) err = %v, want a refusal naming the kind", err)
	}
	if listed := m.ListWorkspaces(); len(listed) != 0 {
		t.Fatalf("ListWorkspaces = %+v, want nothing registered", listed)
	}
}

// A row of a kind this server cannot open is refused for what it is, and is
// never reported as available, whether or not a directory of that name happens
// to exist on this machine: its root is not a path here at all.
func TestWorkspaces_AKindThatCannotOpenIsNeverTreatedAsALocalPath(t *testing.T) {
	_, dir := newStoreForTest(t)
	here := t.TempDir()
	writeManifest(t, dir, `{
	  "version": 5,
	  "conversationOrder": [],
	  "activeConversationId": "",
	  "messageHistory": [],
	  "workspaces": [
	    {"id":"ws_far","kind":"elsewhere","root":`+jsonPath(t, filepath.Join(here, "not-on-this-machine"))+`,"state":"ready"},
	    {"id":"ws_far_here","kind":"elsewhere","root":`+jsonPath(t, here)+`,"state":"ready"}
	  ]
	}`)
	m, err := NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(m.Shutdown)

	lookup := WorkspaceLookup(m.GetWorkspace)
	for _, id := range []string{"ws_far", "ws_far_here"} {
		if _, err := lookup.Usable(id); err == nil || !strings.Contains(err.Error(), `"elsewhere"`) {
			t.Errorf("Usable(%s) err = %v, want a refusal naming the kind", id, err)
		}
	}
	for _, ws := range m.ListWorkspaces() {
		if ws.Available {
			t.Errorf("%s listed as available, but nothing here can open it", ws.ID)
		}
	}
}

// writeManifest hand-writes a session.json, as an older build (or another
// machine) would have left one.
func writeManifest(t *testing.T, dir, manifest string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".juggler", "session.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("write session.json: %v", err)
	}
}

// jsonPath renders a path as a JSON string literal, quotes included. A Windows
// root is full of backslashes, and a backslash pasted straight into a manifest
// is an escape sequence: "C:\Users\..." is not the path, it is a parse error.
func jsonPath(t *testing.T, path string) string {
	t.Helper()
	quoted, err := json.Marshal(path)
	if err != nil {
		t.Fatalf("marshal path %q: %v", path, err)
	}
	return string(quoted)
}

// loadFresh loads through a new store, as a newly opened window would.
func loadFresh(t *testing.T, dir string) *Session {
	t.Helper()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return sess
}

// A provisioning row is stale by definition: no provisioner survives a
// restart, so a row still in that state at load is the wreckage of one and is
// flagged for the reconcile pass to clear up.
//
// Roots are deliberately NOT checked here. Availability is computed on every
// read (see availableNow), so a load-time stat would decide, persist and
// broadcast an answer that the very next read re-derives — which is how the
// two could disagree, and how a tree removed mid-session went on reading as
// present for the rest of the session. That property is tested against the
// reads themselves, in TestWorkspaces_AvailabilityIsNeverServedFromTheCache.
func TestLoad_FlagsStaleProvisions(t *testing.T) {
	_, dir := newStoreForTest(t)
	live := t.TempDir()

	writeManifest(t, dir, `{
	  "version": 5,
	  "conversationOrder": [],
	  "activeConversationId": "",
	  "messageHistory": [],
	  "workspaces": [
	    {"id":"ws_live","kind":"local","root":`+jsonPath(t, live)+`,"state":"ready","available":true},
	    {"id":"ws_gone","kind":"local","root":`+jsonPath(t, filepath.Join(live, "removed-by-hand"))+`,"state":"ready","available":true},
	    {"id":"ws_half","kind":"local","root":`+jsonPath(t, filepath.Join(live, "never-finished"))+`,"state":"provisioning"}
	  ]
	}`)

	sess := loadFresh(t, dir)
	if len(sess.Workspaces) != 3 {
		t.Fatalf("Workspaces = %+v, want all three rows kept", sess.Workspaces)
	}
	byID := map[string]Workspace{}
	for _, ws := range sess.Workspaces {
		byID[ws.ID] = ws
	}
	if !byID["ws_half"].Stale {
		t.Fatalf("ws_half = %+v, want it flagged stale — nothing is provisioning it", byID["ws_half"])
	}
	if byID["ws_live"].Stale {
		t.Fatalf("ws_live = %+v, want a ready workspace left unflagged", byID["ws_live"])
	}

	// The verdict is persisted, so a second window reads it rather than
	// re-deriving it, and reopening the project does not re-offer a cleanup
	// that was already dealt with.
	again := loadFresh(t, dir)
	for _, ws := range again.Workspaces {
		if ws.ID == "ws_half" && !ws.Stale {
			t.Fatalf("ws_half came back unflagged after a second load")
		}
	}
}

// A manifest that predates workspaces, one with the table removed, and one that
// is corrupt must all load. The table is state the app can rebuild; the
// conversations are not, and nothing here may cost them.
func TestLoad_ToleratesAbsentAndCorruptWorkspaceTable(t *testing.T) {
	for _, tc := range []struct {
		name     string
		manifest string
	}{
		{"no table", `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":[]}`},
		{"null table", `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":[],"workspaces":null}`},
		{"corrupt manifest", `{ this is not valid json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, dir := newStoreForTest(t)
			if _, _, _, err := store.CreateConversationFolder("Untitled 1", ""); err != nil {
				t.Fatalf("CreateConversationFolder: %v", err)
			}
			writeManifest(t, dir, tc.manifest)

			sess := loadFresh(t, dir)
			if len(sess.Workspaces) != 0 {
				t.Fatalf("Workspaces = %+v, want an empty table", sess.Workspaces)
			}
			if len(sess.ConversationOrder) != 1 {
				t.Fatalf("ConversationOrder = %v, want the conversation on disk", sess.ConversationOrder)
			}
		})
	}
}

// A manifest field this build has never heard of survives a load and save.
//
// The case it is really about is a downgrade: run an older Juggler on a project
// that has workspaces, and every conversation bound to one is stranded the
// moment that build saves the session — not by a crash, but by a struct that
// quietly dropped a field it did not know. What goes for the workspace table
// goes for whatever is added next, so this is enforced generally.
func TestSaveLoad_KeepsManifestFieldsThisBuildDoesNotKnow(t *testing.T) {
	store, dir := newStoreForTest(t)

	writeManifest(t, dir, `{
	  "version": 5,
	  "conversationOrder": [],
	  "activeConversationId": "",
	  "messageHistory": [],
	  "somethingFromTheFuture": {"kept": ["verbatim", 2]}
	}`)

	sess := loadFresh(t, dir)
	sess.ActiveConversationID = "conv_x"
	if err := store.Save(sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, ".juggler", "session.json"))
	if err != nil {
		t.Fatalf("read session.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("re-read saved manifest: %v", err)
	}
	future, ok := raw["somethingFromTheFuture"].(map[string]any)
	if !ok {
		t.Fatalf("saved manifest = %s, want the unknown field kept", data)
	}
	kept, ok := future["kept"].([]any)
	if !ok || len(kept) != 2 || kept[0] != "verbatim" {
		t.Fatalf("unknown field came back as %v, want it verbatim", future)
	}
	if raw["activeConversationId"] != "conv_x" {
		t.Fatalf("activeConversationId = %v, want the write this build made", raw["activeConversationId"])
	}
}

// Reconciling is destructive and only the browser can do it, so exactly one
// client per run is told to. A later run asks again.
func TestClaimWorkspaceReconcile_AnswersOncePerRun(t *testing.T) {
	store, dir := newStoreForTest(t)
	m := startManager(store, dir, "")
	t.Cleanup(m.Shutdown)

	if !m.ClaimWorkspaceReconcile() {
		t.Fatalf("the first client was not given the reconcile")
	}
	if m.ClaimWorkspaceReconcile() {
		t.Fatalf("a second window was given the reconcile too")
	}

	// A new run of the server — the claim is about this process, not the
	// project, so it is offered again.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	m2 := startManager(fresh, dir, "")
	t.Cleanup(m2.Shutdown)
	if !m2.ClaimWorkspaceReconcile() {
		t.Fatalf("the next run was not offered the reconcile")
	}
}

// A provision does not need a restart to be abandoned — a reloaded tab is
// enough, and the server is up throughout it. The load-time sweep never runs,
// the claim was spent by the window that has gone, and the half-built tree and
// its row sit there until the app is restarted.
//
// When the last window goes, nothing is provisioning anything: the same
// argument the load-time sweep makes, at the only other moment it holds. So the
// rows still marked provisioning are flagged stale, and the reconcile is
// offered again to whoever opens next.
func TestWorkspacesUnwatched_StalesProvisionsAndReoffersTheReconcile(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	half, err := m.RegisterWorkspace(Workspace{Root: filepath.Join(dir, "never-finished")})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	ready, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if !m.ClaimWorkspaceReconcile() {
		t.Fatalf("the window that started the provision was not given the reconcile")
	}

	m.WorkspacesUnwatched()

	abandoned, ok := m.GetWorkspace(half.ID)
	if !ok || !abandoned.Stale {
		t.Fatalf("the interrupted provision = %+v, want it flagged stale", abandoned)
	}
	if built, _ := m.GetWorkspace(ready.ID); built.Stale {
		t.Fatalf("a ready workspace = %+v, want it left unflagged", built)
	}
	if !m.ClaimWorkspaceReconcile() {
		t.Fatalf("the next window was not offered the reconcile, so nothing will ever clear the half-built tree")
	}
	// Still one window at a time: the claim that was just taken is spent, and
	// a second window opening beside it is told no.
	if m.ClaimWorkspaceReconcile() {
		t.Fatalf("the re-offer became a standing offer; two windows would race the same cleanup")
	}
}

// An id is assigned by the server, but it is echoed back in every operation
// request, so it has to be usable as a path-free token wherever it lands.
func TestWorkspace_IDShapeRejectsSeparators(t *testing.T) {
	for _, id := range []string{"a/b", "..", filepath.Join("x", "y"), "with space", ""} {
		ws := workspaceForTest(t, id, t.TempDir())
		if id == "" {
			// The empty id is the default workspace's, which is never a row and
			// so never validated as one; Validate only checks a non-empty id.
			continue
		}
		if err := ws.Validate(); err == nil {
			t.Fatalf("Validate() accepted workspace id %q", id)
		}
	}
}

// Two boxes with no conversation between them are drawn in the order the table
// holds them, so that order is part of what the sidebar records — and until it
// could be written, a user dragging one empty box above another was shown the
// result and had it taken away again by the next broadcast, because nothing on
// either row had changed.
func TestReorderWorkspaces_WritesTheOrderTheTableIsHeldIn(t *testing.T) {
	m, dir := managerForWorkspaceTest(t)

	first, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	second, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	third, err := m.RegisterWorkspace(Workspace{Root: dir, State: WorkspaceStateReady})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	ids := func(list []Workspace) string {
		out := make([]string, 0, len(list))
		for _, ws := range list {
			out = append(out, ws.ID)
		}
		return strings.Join(out, ",")
	}

	list, err := m.ReorderWorkspaces([]string{third.ID, first.ID, second.ID})
	if err != nil {
		t.Fatalf("ReorderWorkspaces: %v", err)
	}
	if got, want := ids(list), strings.Join([]string{third.ID, first.ID, second.ID}, ","); got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	if got := ids(m.ListWorkspaces()); got != ids(list) {
		t.Fatalf("ListWorkspaces = %s, want the order just written (%s)", got, ids(list))
	}

	// A caller naming only some of them says where those go; the rest keep their
	// order behind them. The strip a drop describes holds only the boxes that
	// were drawn, and a workspace can be closed in another window mid-gesture.
	list, err = m.ReorderWorkspaces([]string{second.ID, "ws_nothing_like_it"})
	if err != nil {
		t.Fatalf("ReorderWorkspaces (partial): %v", err)
	}
	if got, want := ids(list), strings.Join([]string{second.ID, third.ID, first.ID}, ","); got != want {
		t.Fatalf("order = %s, want %s — named first, the rest as they were", got, want)
	}

	// And it survives the trip through session.json, or the order would last
	// only as long as the process that was told about it.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	loaded, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got, want := ids(loaded.Workspaces), strings.Join([]string{second.ID, third.ID, first.ID}, ","); got != want {
		t.Fatalf("reloaded order = %s, want %s", got, want)
	}
}
