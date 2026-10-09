//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package workspace

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// lookupOver is a session's workspace table holding exactly these rows.
func lookupOver(rows ...core.Workspace) core.WorkspaceLookup {
	return func(id string) (core.Workspace, bool) {
		for _, row := range rows {
			if row.ID == id {
				return row, true
			}
		}
		return core.Workspace{}, false
	}
}

// ready is a usable local workspace row rooted at root.
func ready(id, kind, label, root string) core.Workspace {
	return core.Workspace{ID: id, Kind: kind, Label: label, Root: root, State: core.WorkspaceStateReady}
}

// Naming no workspace is the project: every request that says nothing lands
// in the project.
func TestResolverProjectIsTheDefault(t *testing.T) {
	project := t.TempDir()
	ws, err := NewResolver(func() string { return project }, nil, nil).Resolve(core.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("Resolve(\"\"): %v", err)
	}
	if ws.ID() != "" || ws.Root() != project || ws.Name() != "" {
		t.Fatalf("project resolved as id=%q root=%q name=%q, want id \"\", root %q, no name", ws.ID(), ws.Root(), ws.Name(), project)
	}
	if dir, ok := ws.LocalDir(); !ok || dir != project {
		t.Fatalf("LocalDir() = %q, %v, want the project %q", dir, ok, project)
	}
}

// With no project open the project still resolves, rooted nowhere. The callers
// that answer without one — an absolute path completed, a polled card with
// nothing to count — go on answering, and each one that needs a tree already
// checks for an empty root.
func TestResolverProjectWithNoneOpenIsRootedNowhere(t *testing.T) {
	ws, err := NewResolver(func() string { return "" }, nil, nil).Resolve(core.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("Resolve(\"\") with no project: %v", err)
	}
	if ws.Root() != "" {
		t.Fatalf("Root() = %q with no project open, want empty", ws.Root())
	}
}

// A local row opens as the tree on this machine it names. (A registration that
// names no kind is recorded as local by core's RegisterWorkspace, so no lookup
// ever hands a kindless row here.)
func TestResolverOpensALocalRow(t *testing.T) {
	project, tree := t.TempDir(), t.TempDir()
	ws, err := NewResolver(func() string { return project },
		lookupOver(ready("ws_tree", core.WorkspaceKindLocal, "feat/tunnels", tree)), nil).Resolve("ws_tree")
	if err != nil {
		t.Fatalf("Resolve(ws_tree): %v", err)
	}
	if ws.ID() != "ws_tree" || ws.Root() != tree || ws.Name() != "feat/tunnels" {
		t.Errorf("resolved as id=%q root=%q name=%q", ws.ID(), ws.Root(), ws.Name())
	}
	if dir, ok := ws.LocalDir(); !ok || dir != tree {
		t.Errorf("LocalDir() = %q, %v, want %q", dir, ok, tree)
	}
}

// A workspace that works in the project itself (a group) is not a tree of its
// own, and naming one there would claim a separate tree that does not exist.
func TestResolverNamesOnlyATreeOfItsOwn(t *testing.T) {
	project, tree := t.TempDir(), t.TempDir()
	resolve := NewResolver(func() string { return project }, lookupOver(
		ready("ws_group", core.WorkspaceKindLocal, "Billing", project+string(filepath.Separator)),
		ready("ws_tree", core.WorkspaceKindLocal, "", tree),
	), nil).Resolve

	if ws, err := resolve("ws_group"); err != nil || ws.Name() != "" {
		t.Errorf("a group in the project is named %q (err %v), want no name", nameOf(ws), err)
	}
	if ws, err := resolve("ws_tree"); err != nil || ws.Name() != "ws_tree" {
		t.Errorf("an unlabelled tree is named %q (err %v), want its id", nameOf(ws), err)
	}
}

func nameOf(ws Workspace) string {
	if ws == nil {
		return "<nil>"
	}
	return ws.Name()
}

// Four of the refusals core.WorkspaceLookup.Usable makes (the fifth, a kind
// this server cannot open, is TestResolverRefusesAKindItCannotOpen), plus a
// server with no session. The dangerous answer is never the error — it is the project, handed
// back for a binding that could not be honoured.
func TestResolverRefusesWhatCannotBeWorkedIn(t *testing.T) {
	project, gone := t.TempDir(), t.TempDir()
	resolve := NewResolver(func() string { return project }, lookupOver(
		core.Workspace{ID: "ws_building", Kind: core.WorkspaceKindLocal, Root: gone, State: core.WorkspaceStateProvisioning},
		core.Workspace{ID: "ws_closed", Kind: core.WorkspaceKindLocal, Root: gone, State: core.WorkspaceStateClosed},
		ready("ws_gone", core.WorkspaceKindLocal, "", gone+"-removed"),
	), nil).Resolve

	for id, want := range map[string]string{
		"ws_building":         "still being created",
		"ws_closed":           "was closed",
		"ws_gone":             "missing its root",
		"ws_never_registered": "unknown workspace",
	} {
		ws, err := resolve(id)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Resolve(%q) err = %v, want it to say %q", id, err, want)
		}
		if ws != nil {
			t.Errorf("Resolve(%q) handed back %q alongside its refusal", id, ws.Root())
		}
	}

	if _, err := NewResolver(func() string { return project }, nil, nil).Resolve("ws_any"); err == nil ||
		!strings.Contains(err.Error(), "no session is loaded") {
		t.Errorf("Resolve with no session err = %v, want it to say no session is loaded", err)
	}
}

// A row recording a kind this server cannot open is refused by name, never
// served as if it were this machine.
func TestResolverRefusesAKindItCannotOpen(t *testing.T) {
	project, tree := t.TempDir(), t.TempDir()
	_, err := NewResolver(func() string { return project },
		lookupOver(ready("ws_far", "elsewhere", "", tree)), nil).Resolve("ws_far")
	if err == nil || !strings.Contains(err.Error(), "elsewhere") {
		t.Fatalf("Resolve of an unknown kind err = %v, want a refusal naming the kind", err)
	}
}

// The browser reads a row's hostsLocalProviders to decide whether to offer a
// CLI provider; the server spawns one wherever the resolved workspace's
// LocalDir says. Describe asks the workspace the row opens to, which is what
// keeps those the same answer — for a row still being built as well as a ready
// one, since the picker is drawn before the tree exists.
func TestDescribeIsWhatTheRowsWorkspaceSays(t *testing.T) {
	project := t.TempDir()
	rows := []core.Workspace{
		ready("ws_local", core.WorkspaceKindLocal, "", t.TempDir()),
		{ID: "ws_building", Kind: core.WorkspaceKindLocal, Root: t.TempDir() + "-not-yet", State: core.WorkspaceStateProvisioning},
	}
	resolve := NewResolver(func() string { return project }, lookupOver(rows...), nil).Resolve
	described := Describe(rows)
	if len(described) != len(rows) {
		t.Fatalf("Describe returned %d rows for %d", len(described), len(rows))
	}
	for i, row := range described {
		if row.ID != rows[i].ID {
			t.Fatalf("row %d is %q, want %q: Describe keeps the table's order", i, row.ID, rows[i].ID)
		}
		if !row.HostsLocalProviders {
			t.Errorf("%s: HostsLocalProviders = false, want true for a tree on this machine", row.ID)
		}
		if ws, err := resolve(row.ID); err == nil {
			if _, ok := ws.LocalDir(); ok != row.HostsLocalProviders {
				t.Errorf("%s: LocalDir ok = %v, but the row says %v", row.ID, ok, row.HostsLocalProviders)
			}
		}
	}

	// A row this server cannot open has no workspace to host anything.
	if far := Describe([]core.Workspace{ready("ws_far", "elsewhere", "", t.TempDir())}); far[0].HostsLocalProviders {
		t.Errorf("a row of a kind nothing opens says it hosts local providers")
	}

	// The field rides beside the row's own, in the shape the browser reads.
	encoded, err := json.Marshal(described[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"hostsLocalProviders":true`) || !strings.Contains(string(encoded), `"id":"ws_local"`) {
		t.Errorf("row encodes as %s, want the row's fields with hostsLocalProviders beside them", encoded)
	}
}
