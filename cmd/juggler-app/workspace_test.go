//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func workspacePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "config", "workspace.json")
}

// What one run saves, the next one reads back: the open windows in order, the
// last theme and the last zoom. Each is saved on its own, so saving one must
// keep the others. An empty window (the server's page) is not one of them: it
// views no session, and becomes a project's window only by opening one there,
// which records it as that project's.
func TestTheWorkspaceComesBackAsItWasSaved(t *testing.T) {
	path := workspacePath(t)
	w := newWorkspaceStoreAt(path)
	w.saveTheme("light")
	w.saveZoom(120)
	w.flush([]workspaceEntry{{Project: "/a"}, {Server: "http://remote:3000"}, {Project: ""}})

	next := newWorkspaceStoreAt(path)
	want := []windowSpec{{project: "/a"}, {url: "http://remote:3000", connected: true}}
	if got := next.load(); !reflect.DeepEqual(got, want) {
		t.Errorf("load() = %+v, want %+v", got, want)
	}
	if (windowSpec{}).restorable() {
		t.Error("an empty window is restorable")
	}
	if got := next.loadLastTheme(); got != "light" {
		t.Errorf("loadLastTheme() = %q, want light", got)
	}
	if got := next.loadLastZoom(); got != 120 {
		t.Errorf("loadLastZoom() = %d, want 120", got)
	}

	// A later save of the windows alone leaves the theme and zoom as they were.
	next.flush([]workspaceEntry{{Project: "/b"}})
	f := readWorkspaceFile(path)
	if f.LastTheme != "light" || f.LastZoom != 120 || len(f.Windows) != 1 || f.Windows[0].Project != "/b" {
		t.Errorf("after a windows-only save the file holds %+v", f)
	}
}

// A quit records the whole window set, and the teardown that follows closes the
// windows one by one. Those closes must not record the shrinking set after it,
// or the next launch restores only the windows that happened to close last.
func TestQuittingKeepsTheWholeWindowSet(t *testing.T) {
	path := workspacePath(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(path)
	a.reg(func(st *regState) {
		st.windows["w1"] = &winEntry{id: "w1", spec: windowSpec{project: "/a"}}
		st.windows["w2"] = &winEntry{id: "w2", spec: windowSpec{project: "/b"}}
	})
	a.onShutdown()
	a.reg(func(st *regState) { delete(st.windows, "w1") })
	a.persistWorkspace()
	a.workspace.flush(nil) // barrier: nil entries leave the set unchanged
	got := readWorkspaceFile(path).Windows
	want := []workspaceEntry{{Project: "/a"}, {Project: "/b"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("after quitting, the workspace holds %+v, want %+v", got, want)
	}
}

// Pages report their theme and zoom as teardown begins, after the quit's own
// snapshot has been written. Saving them then starts a write the exiting
// process does not live to finish, which strands its temp file beside the
// workspace and loses the value anyway.
func TestQuittingSavesNoThemeOrZoom(t *testing.T) {
	path := workspacePath(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(path)
	a.setWindowTheme(nil, "light")
	a.setWindowZoom(100)
	a.workspace.flush([]workspaceEntry{{Project: "/a"}})

	a.reg(func(st *regState) { st.quitting = true })
	a.setWindowTheme(nil, "dark")
	a.setWindowZoom(110)
	a.workspace.flush(nil) // barrier: nil entries leave the set unchanged

	if f := readWorkspaceFile(path); f.LastTheme != "light" || f.LastZoom != 100 {
		t.Errorf("after quitting the workspace holds theme %q and zoom %d, want light and 100 from before the quit",
			f.LastTheme, f.LastZoom)
	}
}

// A process killed mid-save leaves its temp file beside the workspace, and
// nothing else will ever remove it. The next run's first save clears them.
func TestTheFirstSaveClearsTempsAKilledRunLeft(t *testing.T) {
	path := workspacePath(t)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".workspace.json.1840525170.tmp", ".workspace.json.88313521.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(`{"windows":[]}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	newWorkspaceStoreAt(path).flush([]workspaceEntry{{Project: "/a"}})

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "workspace.json" {
		t.Errorf("the config directory holds %v, want only workspace.json", entries)
	}
}

// Signing out of Windows or shutting it down ends the app through Wails' own
// quit. Unauthorised, the busy guard vetoes that quit and Windows kills the
// process before the window set is written. A shutdown that something else
// cancelled must not quit the app at all.
func TestWindowsEndSessionAuthorisesTheQuit(t *testing.T) {
	a := newTestAppState(t)
	quitting := func() bool {
		var q bool
		a.reg(func(st *regState) { q = st.quitting })
		return q
	}

	if _, swallow := a.interceptWndProc(0, wmEndSession-1, 1, 0); swallow || quitting() {
		t.Fatal("any other message passes through untouched")
	}
	if _, swallow := a.interceptWndProc(0, wmEndSession, 0, 0); !swallow {
		t.Fatal("a cancelled end of session must be kept from Wails, which quits on any WM_ENDSESSION")
	}
	if quitting() {
		t.Fatal("a cancelled end of session must not authorise a quit")
	}
	if _, swallow := a.interceptWndProc(0, wmEndSession, 1, 0); swallow {
		t.Fatal("an ending session must reach Wails, whose quit runs the shutdown")
	}
	if !quitting() || !a.shouldQuit() {
		t.Fatal("an ending session must authorise the quit, so the busy guard lets it through")
	}
}

// Nothing saved yet is an empty workspace, not an error.
func TestAMissingWorkspaceIsEmpty(t *testing.T) {
	w := newWorkspaceStoreAt(workspacePath(t))
	if got := w.load(); len(got) != 0 {
		t.Errorf("load() = %+v, want nothing", got)
	}
	if w.loadLastTheme() != "" || w.loadLastZoom() != 0 {
		t.Error("a missing workspace reported a theme or zoom")
	}
}

// The file is replaced whole rather than rewritten where it stands, so a write
// cut short — a crash, a full disk, power lost mid-quit — leaves the previous
// workspace rather than a torn one, which would read as no workspace at all.
func TestTheWorkspaceFileIsReplacedRatherThanRewritten(t *testing.T) {
	path := workspacePath(t)
	writeWorkspaceFile(path, workspaceFile{Windows: []workspaceEntry{{Project: "/a"}}})
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	writeWorkspaceFile(path, workspaceFile{Windows: []workspaceEntry{{Project: "/b"}}})
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Windows' os.Stat keeps the path, not the file's identity, and SameFile
	// looks that up when it compares — so both sides are whatever holds the
	// name by then, and it reports the same file however the write was done.
	if runtime.GOOS != "windows" && os.SameFile(before, after) {
		t.Error("the workspace file was rewritten in place; an interrupted write would tear it")
	}
	if got := readWorkspaceFile(path).Windows; len(got) != 1 || got[0].Project != "/b" {
		t.Errorf("read back %+v, want the second write", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("the config directory holds %d entries, want only workspace.json: %v", len(entries), entries)
	}
}

// A workspace that cannot be read is not thrown away. The app starts with its
// default window either way, but the file is set aside where someone can find
// it, rather than overwritten by the next save.
func TestACorruptWorkspaceIsKeptAside(t *testing.T) {
	path := workspacePath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	torn := []byte(`{"windows":[{"project":"/a"},{"proj`)
	if err := os.WriteFile(path, torn, 0o644); err != nil {
		t.Fatal(err)
	}

	if f := readWorkspaceFile(path); !reflect.DeepEqual(f, workspaceFile{}) {
		t.Errorf("a corrupt workspace read as %+v, want empty", f)
	}
	kept, err := os.ReadFile(path + ".corrupt")
	if err != nil {
		t.Fatalf("the corrupt workspace was not kept aside: %v", err)
	}
	if string(kept) != string(torn) {
		t.Errorf("kept %q, want the file as it was", kept)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the corrupt file is still where the next save goes (stat: %v)", err)
	}
}
