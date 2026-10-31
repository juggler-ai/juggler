//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/msg"
	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// A launch with neither --url nor --project restores the set of windows that was
// open last time, each at its remembered geometry. The set lives in
// ~/.juggler/workspace.json, keyed by project; each project's window reopens
// that project's session on this machine's server, and its size/position is
// session state, held server-side in the project's session.json (via
// /api/session/window-state, see window_state_client.go) — except for a window
// onto a server by URL, whose frame stays on this machine (remote_frames.go).
// Together they reopen "the most recently opened set of sessions" where the
// user left them.
//
// The store is owned by a single goroutine (no mutex, per the concurrency
// rule); saves are ordered, and flush waits for durability at quit.

// windowSpec identifies what a window views: a local project's session on this
// machine's server, no project (an empty window, which shows that server's own
// page), or an explicit external server URL. It is the single source of a
// window's geometry key and its workspace entry.
//
// A URL comes from one of two places, and connected says which. A server the
// user connected to by typing its address (Session ▸ Connect to Server…) is
// one they mean to come back to, so it is restored like a project. A --url
// launch is a one-shot connection to an address someone else supplied — a
// script or a shortcut, naming a server that may be up for that run only — so
// restoring it could open a window onto a dead server.
type windowSpec struct {
	project   string
	url       string
	connected bool
}

func (s windowSpec) isURL() bool { return s.url != "" }

// restorable reports whether a next launch should bring this window back: a
// project window (which reopens its session) or a connected server — never a
// --url one, and never an empty window, which views no session (a launch with
// nothing to restore opens one anyway).
func (s windowSpec) restorable() bool {
	if s.isURL() {
		return s.connected
	}
	return s.project != ""
}

// sameView reports whether two specs show the same thing. How a URL window came
// to be open is not part of what it shows, so a --url launch finds a connected
// window onto the same server.
func (s windowSpec) sameView(o windowSpec) bool {
	return s.project == o.project && s.url == o.url
}

// entry is the persisted form of a spec. A connected server is filed under its
// own key, so an address under "url" can always be read as a --url window and
// dropped (see load).
func (s windowSpec) entry() workspaceEntry {
	switch {
	case s.connected:
		return workspaceEntry{Server: s.url}
	case s.isURL():
		return workspaceEntry{URL: s.url}
	}
	return workspaceEntry{Project: s.project}
}

// openFailedError is a project's session that this machine's server would not
// open. Its window shows the server's own page instead (serverURL), saying why.
type openFailedError struct {
	project   string
	serverURL string
	server    serverProc
	err       error
}

func (e *openFailedError) Error() string {
	return fmt.Sprintf("open the session for %s: %v", e.project, e.err)
}

func (e *openFailedError) Unwrap() error { return e.err }

// notice is what the server's page says in place of the session: why it did
// not open, in the shell's UI language. The reason is the server's English,
// passed as a parameter, as a log line would be.
func (e *openFailedError) notice(a *appState) string {
	return a.tr(msg.New("The session for {project} could not be opened: {error}", "project", e.project, "error", e.err.Error()))
}

// resolveWindow returns the URL a window for spec loads, before the window's
// own query: a server by URL as given; on this machine's server, an empty
// window's server page or a project's session (opened now, or found running).
// It also returns which process of this machine's server that is (zero for a
// server by URL). Without start, this machine's server is only found, never
// started (serverClient). A server that cannot be had is the serverClient's
// error; a session it will not open is an *openFailedError.
func (a *appState) resolveWindow(spec windowSpec, start bool) (string, serverProc, error) {
	if spec.isURL() {
		return normalizeURL(spec.url), serverProc{}, nil
	}
	for attempt := 1; ; attempt++ {
		c, err := a.serverClient(start)
		if err != nil {
			return "", serverProc{}, err
		}
		root := "http://" + c.Addr()
		if spec.project == "" {
			return root, procOf(c), nil
		}
		project := expandProject(spec.project)
		sess, _, err := c.OpenSession(project)
		if err == nil {
			return strings.TrimSuffix(c.SessionURL(sess.ID), "/"), procOf(c), nil
		}
		if machineserver.ServerGoing(err) && attempt < connectAttempts {
			// Caught the server on its way out: once it has gone, the next
			// serverClient finds or starts the one there is now.
			a.awaitServerGone(c)
			continue
		}
		return "", serverProc{}, &openFailedError{project: project, serverURL: root, server: procOf(c), err: err}
	}
}

// expandProject resolves project to an absolute path (expanding a leading ~),
// or "" when project is empty.
func expandProject(project string) string {
	if project == "" {
		return ""
	}
	project = userpaths.ExpandHome(project)
	if abs, err := filepath.Abs(project); err == nil {
		return abs
	}
	return project
}

// workspaceEntry is the on-disk form of one open window.
type workspaceEntry struct {
	Project string `json:"project,omitempty"`
	URL     string `json:"url,omitempty"`
	Server  string `json:"server,omitempty"`
}

func (e workspaceEntry) spec() windowSpec {
	switch {
	case e.Server != "":
		return windowSpec{url: e.Server, connected: true}
	case e.URL != "":
		return windowSpec{url: e.URL}
	}
	return windowSpec{project: e.Project}
}

// workspaceFile is the JSON document: an ordered list of open windows plus a
// small "last theme used" hint. lastTheme is the most recent theme any page
// reported; it's read back at startup to paint a restored window's bare native
// frame to match instead of flashing the dark default before the page's first
// paint (see buildWindow's bgTheme). The theme mode itself is a machine
// preference in the server's settings.json, which the Go side can't read at
// window-build time; lastTheme (a painted colour) is only the seed a new
// window's bare frame is painted with.
type workspaceFile struct {
	Windows   []workspaceEntry `json:"windows"`
	LastTheme string           `json:"lastTheme,omitempty"`
	// LastZoom is the most recent page-reported UI zoom (root font-size %) across
	// all windows. Read back at startup to seed the ?zoom= hint the next window
	// (a restored, Finder-launched, or Session ▸ New Window one with no inherited
	// value) opens with, so it inherits the last-active size rather than resetting
	// to the default. The zoom itself is a machine preference in the server's
	// settings.json; this is only the seed a new window's first frame is painted at.
	LastZoom int `json:"lastZoom,omitempty"`
}

// workspaceStore persists the open-window set. One goroutine owns the file;
// callers send ordered saves (fire-and-forget) or flush (wait for the write).
type workspaceStore struct {
	saves chan wsSaveReq
	path  string
}

type wsSaveReq struct {
	entries []workspaceEntry // nil leaves the persisted window set unchanged
	theme   *string          // nil leaves the persisted theme unchanged
	zoom    *int             // nil leaves the persisted zoom unchanged
	done    chan struct{}    // non-nil for a synchronous flush
}

func newWorkspaceStore() *workspaceStore {
	return newWorkspaceStoreAt(workspaceFilePath())
}

// newWorkspaceStoreAt is newWorkspaceStore keeping its document at path.
func newWorkspaceStoreAt(path string) *workspaceStore {
	w := &workspaceStore{saves: make(chan wsSaveReq, 16), path: path}
	go func() {
		// Hold the whole document in memory so a windows-only or theme-only save
		// preserves the other field. Seed from disk once; this goroutine is the
		// file's sole writer thereafter (no mutex, per the concurrency rule).
		cur := readWorkspaceFile(w.path)
		swept := false
		for req := range w.saves {
			// A run killed mid-save strands its temp file beside the document.
			// Clear them before the first write, not at construction: the store
			// is built before the single-instance lock is taken, and a second
			// launch's sweep would delete the running app's in-flight temp. A
			// second launch exits at that lock, before anything has saved.
			if !swept {
				swept = true
				if err := atomicio.RemoveTemps(w.path); err != nil {
					logf("workspace: clearing stale temp files: %v", err)
				}
			}
			if req.entries != nil {
				cur.Windows = req.entries
			}
			if req.theme != nil {
				cur.LastTheme = *req.theme
			}
			if req.zoom != nil {
				cur.LastZoom = *req.zoom
			}
			writeWorkspaceFile(w.path, cur)
			if req.done != nil {
				close(req.done)
			}
		}
	}()
	return w
}

// save records the set asynchronously, preserving call order.
func (w *workspaceStore) save(entries []workspaceEntry) {
	w.saves <- wsSaveReq{entries: entries}
}

// flush records the set and waits for the write — used at quit so the final set
// is durable before the process exits.
func (w *workspaceStore) flush(entries []workspaceEntry) {
	done := make(chan struct{})
	w.saves <- wsSaveReq{entries: entries, done: done}
	<-done
}

// saveTheme records the last-used theme, preserving the open-window set.
// Best-effort and fire-and-forget, like save; a failure just means the next
// launch falls back to its default frame colour.
func (w *workspaceStore) saveTheme(theme string) {
	if normaliseTheme(theme) == "" {
		return
	}
	w.saves <- wsSaveReq{theme: &theme}
}

// saveZoom records the last-used UI zoom, preserving the open-window set and
// theme. Best-effort and fire-and-forget, like saveTheme; a failure just means
// the next launch's first window falls back to the default size.
func (w *workspaceStore) saveZoom(zoom int) {
	if zoom <= 0 {
		return
	}
	w.saves <- wsSaveReq{zoom: &zoom}
}

// loadLastZoom returns the persisted last-used UI zoom (0 when absent/corrupt).
// Read at startup to seed the ?zoom= inheritance hint before any page reports.
func (w *workspaceStore) loadLastZoom() int {
	return readWorkspaceFile(w.path).LastZoom
}

// load reads the persisted set as specs (empty when missing/corrupt → caller
// falls back to a single default window).
func (w *workspaceStore) load() []windowSpec {
	f := readWorkspaceFile(w.path)
	specs := make([]windowSpec, 0, len(f.Windows))
	for _, e := range f.Windows {
		s := e.spec()
		// Never restore a --url window (see windowSpec), whose address is not
		// expected to be valid next launch, or an empty one. Skipping such
		// entries here also clears any stale ones from workspace.json.
		if !s.restorable() {
			continue
		}
		specs = append(specs, s)
	}
	return specs
}

// loadLastTheme returns the persisted last-used theme, normalised to a theme we
// know (or "" when absent/corrupt/unknown). Read at startup to seed the native
// frame colour before any page has reported its theme.
func (w *workspaceStore) loadLastTheme() string {
	return normaliseTheme(readWorkspaceFile(w.path).LastTheme)
}

func workspaceFilePath() string {
	return filepath.Join(userpaths.ConfigDir(), "workspace.json")
}

// readWorkspaceFile parses the document, returning a zero value when the file is
// missing or corrupt (callers then fall back to their defaults).
//
// A corrupt file is moved aside to path+".corrupt" and logged, rather than left
// for the next save to overwrite: the windows it held are lost to this launch
// either way, but not to the person who goes looking for them.
func readWorkspaceFile(path string) workspaceFile {
	data, err := atomicio.RobustReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("workspace: read failed: %v", err)
		}
		return workspaceFile{}
	}
	var f workspaceFile
	if err := json.Unmarshal(data, &f); err != nil {
		aside := path + ".corrupt"
		if rerr := atomicio.RobustRename(path, aside); rerr != nil {
			logf("workspace: %s is corrupt (%v), and could not be moved aside: %v", path, err, rerr)
		} else {
			logf("workspace: %s is corrupt (%v); kept it as %s and started with no saved windows", path, err, aside)
		}
		return workspaceFile{}
	}
	return f
}

// writeWorkspaceFile replaces the document whole (atomicio.WriteFile), so a
// write cut short by a crash or a full disk leaves the previous workspace
// rather than a torn file that would read back as none.
func writeWorkspaceFile(path string, doc workspaceFile) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logf("workspace: mkdir failed: %v", err)
		return
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		logf("workspace: encode failed: %v", err)
		return
	}
	if err := atomicio.WriteFile(path, data, 0o644); err != nil {
		logf("workspace: write failed: %v", err)
	}
}
