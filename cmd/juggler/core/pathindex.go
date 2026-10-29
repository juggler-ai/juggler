//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"sort"
	"strings"
	"sync"

	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"
)

// maxIndexedPaths caps the number of project-relative paths a PathIndex holds.
// A flat []string of 200k entries is ~16 MB; the cap bounds footprint on
// pathological trees. It is a plain constant on purpose — no config knob.
const maxIndexedPaths = 200_000

// PathIndex is an in-memory list of project-relative paths used to answer "@"
// file-mention completion instantly, without re-walking the tree per keystroke.
//
// It is a single-owner actor: the paths slice is built once (synchronously, at
// construction, before run() starts) and thereafter owned exclusively by run(),
// which serves searches and applies inserts/deletes off channels. This follows
// the project's concurrency rule — goroutines + channels, never a mutex (the
// only sanctioned mutex is ycrdtMu in worker/document.go).
type PathIndex struct {
	searches chan searchReq
	inserts  chan string
	deletes  chan string
	replaces chan replaceReq

	stop     chan struct{}
	stopped  chan struct{} // closed by run() on exit; lets late callers bail
	stopOnce sync.Once     // guards close(stop) — safe from Stop() and watchLoop

	// paths is project-relative, forward-slash; directories carry a trailing
	// "/". Owned by run() once the goroutine starts. partial is set when the
	// index hit maxIndexedPaths and coverage is therefore incomplete.
	paths   []string
	partial bool
}

type searchReq struct {
	query string
	limit int
	reply chan []ops.FileMatch
}

// replaceReq swaps the whole index in one shot (used when a .gitignore change
// forces a rebuild). The new slice was walked off the owner goroutine.
type replaceReq struct {
	paths   []string
	partial bool
}

// newPathIndex takes ownership of paths (built by the caller's tree walk) and
// starts the owning goroutine. partial records whether the walk hit the cap.
func newPathIndex(paths []string, partial bool) *PathIndex {
	if partial {
		jlog.Info("[PathIndex] Path cap (%d) reached; @-completion coverage is incomplete", maxIndexedPaths)
	}
	ix := &PathIndex{
		searches: make(chan searchReq),
		inserts:  make(chan string),
		deletes:  make(chan string),
		replaces: make(chan replaceReq),
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
		paths:    paths,
		partial:  partial,
	}
	go ix.run()
	return ix
}

// run is the sole owner of ix.paths. It serves searches and applies mutations
// until stop is closed.
func (ix *PathIndex) run() {
	defer close(ix.stopped)
	for {
		select {
		case req := <-ix.searches:
			req.reply <- ix.search(req.query, req.limit)
		case p := <-ix.inserts:
			ix.insert(p)
		case p := <-ix.deletes:
			ix.remove(p)
		case r := <-ix.replaces:
			ix.paths = r.paths
			ix.partial = r.partial
		case <-ix.stop:
			return
		}
	}
}

// stopSignal tells the owning goroutine to exit. Idempotent and non-blocking;
// safe to call from multiple goroutines (e.g. FileWatcher.Stop and watchLoop's
// teardown both call into it).
func (ix *PathIndex) stopSignal() {
	ix.stopOnce.Do(func() { close(ix.stop) })
}

// close signals the owning goroutine to exit and waits for it, so that any
// Search/add/del racing with teardown deterministically resolves via the
// stopped guard (returns nil / no-ops) instead of blocking. Idempotent.
func (ix *PathIndex) close() {
	ix.stopSignal()
	<-ix.stopped
}

// add enqueues an insert of p (dir paths carry a trailing "/"). Non-blocking
// against a stopped index. Called from the file-watcher goroutine.
func (ix *PathIndex) add(p string) {
	select {
	case ix.inserts <- p:
	case <-ix.stopped:
	}
}

// del enqueues removal of p (and its subtree, if p is a directory). The caller
// passes the rel path without a trailing slash. Non-blocking against a stopped
// index. Called from the file-watcher goroutine.
func (ix *PathIndex) del(p string) {
	select {
	case ix.deletes <- p:
	case <-ix.stopped:
	}
}

// replace swaps the entire index contents (a fresh tree walk after a
// .gitignore change). Non-blocking against a stopped index. Called from the
// file-watcher goroutine.
func (ix *PathIndex) replace(paths []string, partial bool) {
	select {
	case ix.replaces <- replaceReq{paths: paths, partial: partial}:
	case <-ix.stopped:
	}
}

// insert appends a path (dir paths carry a trailing "/"). Runs on the owner
// goroutine. No dedup scan here — creates are for genuinely new paths, and
// search() dedups its bounded output to absorb the rare fsnotify double-fire.
func (ix *PathIndex) insert(p string) {
	if p == "" || p == "/" {
		return
	}
	if len(ix.paths) >= maxIndexedPaths {
		ix.partial = true
		return
	}
	ix.paths = append(ix.paths, p)
}

// remove drops p and, if p is a directory, everything beneath it. Called on
// remove/rename events; the caller passes the rel path without a trailing
// slash, so we match p, p+"/", and any p+"/..." descendant. Runs on the owner
// goroutine. Order is irrelevant (search re-sorts), so we swap-delete.
func (ix *PathIndex) remove(p string) {
	if p == "" {
		return
	}
	prefix := p + "/"
	out := ix.paths[:0]
	for _, e := range ix.paths {
		if e == p || e == prefix || strings.HasPrefix(e, prefix) {
			continue
		}
		out = append(out, e)
	}
	ix.paths = out
}

// Search returns up to limit matches for query, ranked by relevance. It is
// called from arbitrary HTTP goroutines; the work runs on the owner goroutine.
// Returns nil if the index has been stopped (torn down).
func (ix *PathIndex) Search(query string, limit int) []ops.FileMatch {
	if ix == nil {
		return nil
	}
	reply := make(chan []ops.FileMatch, 1)
	select {
	case ix.searches <- searchReq{query: query, limit: limit, reply: reply}:
		return <-reply
	case <-ix.stopped:
		return nil
	}
}

type scored struct {
	ops.FileMatch
	baseOff int // offset of the query within the basename
	depth   int
	pathLen int
	lowered string
}

// search returns paths whose BASENAME contains query as a contiguous substring
// (case-insensitive), ranked best→worst by: earlier match offset in the
// basename, then shallower depth, then shorter path, then alphabetical. Runs on
// the owner goroutine.
//
// Matching is deliberately basename-substring only — no full-path matching and
// no fuzzy/subsequence matching. Those surface files that don't actually
// contain what you typed (a long query's letters coincidentally scattered
// across a deep path), padding the menu with noise. Every result here contains
// the typed string, contiguously, in its own name.
func (ix *PathIndex) search(query string, limit int) []ops.FileMatch {
	if limit <= 0 {
		limit = 20
	}
	q := strings.ToLower(query)
	if q == "" {
		return nil
	}

	matches := make([]scored, 0, 64)
	for _, p := range ix.paths {
		isDir := strings.HasSuffix(p, "/")
		trimmed := p
		if isDir {
			trimmed = p[:len(p)-1]
		}
		lower := strings.ToLower(trimmed)
		base := lower
		if i := strings.LastIndexByte(lower, '/'); i >= 0 {
			base = lower[i+1:]
		}

		off := strings.Index(base, q)
		if off < 0 {
			continue
		}

		matches = append(matches, scored{
			FileMatch: ops.FileMatch{Path: p, IsDir: isDir},
			baseOff:   off,
			depth:     strings.Count(trimmed, "/"),
			pathLen:   len(p),
			lowered:   lower,
		})
	}

	sort.Slice(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.baseOff != b.baseOff {
			return a.baseOff < b.baseOff
		}
		if a.depth != b.depth {
			return a.depth < b.depth
		}
		if a.pathLen != b.pathLen {
			return a.pathLen < b.pathLen
		}
		return a.lowered < b.lowered
	})

	out := make([]ops.FileMatch, 0, limit)
	seen := make(map[string]struct{}, limit)
	for _, m := range matches {
		if len(out) >= limit {
			break
		}
		if _, dup := seen[m.Path]; dup {
			continue
		}
		seen[m.Path] = struct{}{}
		out = append(out, m.FileMatch)
	}
	return out
}
