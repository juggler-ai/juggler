//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
)

// WorkspaceRegistry maps a conversation's source directories to alternate
// execution roots — "workspaces" — chosen by an EXTENSION, not by core. Core
// knows nothing about what a workspace is or how it is created: a git worktree,
// a devcontainer mount, an ephemeral sandbox. It only knows that while a
// conversation has one or more source→workspace bindings, that conversation's
// file/shell/search/tree ops on a path under a bound source directory should
// execute under the corresponding workspace root, with the path still validated
// in real-project space (see ops.PathScope.WithRemap).
//
// A conversation may bind SEVERAL source directories at once — one per git
// repository it works with. This is the crucial difference from t3code, which
// binds a single whole-session cwd per thread and so cannot isolate more than
// one repo: here, a path is routed to a workspace by LONGEST-PREFIX match over
// the conversation's bound sources, so repoA and its nested repoB each map to
// their own worktree. Core does pure prefix routing; the extension owns
// discovering repositories and deciding their roots (see the worktrees
// extension).
//
// Bindings are PERSISTED to <project>/.juggler/workspaces.json (loaded on
// construction, atomically rewritten on every change), so a workspace survives a
// server restart and — critically — a conversation deleted while the server was
// down can still be detected as an Orphan on the next launch and its worktree
// cleaned up. This is the whole core-side contribution to "worktrees as an
// extension" (issue #51): a per-(conversation, source) execution-root
// indirection, a bind API, and a durable record for cleanup.
//
// It is a channel-based actor (the repo lint forbids sync.Mutex/RWMutex): all
// map access — and each persistence write — runs on one goroutine. It is
// project-scoped (hangs off projectState).
type WorkspaceRegistry struct {
	reqCh  chan wsReq
	quitCh chan struct{}
	path   string // persistence file, "" ⇒ in-memory only (no-project mode)
}

type wsReqKind int

const (
	wsBind      wsReqKind = iota
	wsUnbind              // unbind one source for a conversation
	wsUnbindAll           // unbind every source for a conversation
	wsSnapshot            // all (source→workspace) bindings for a conversation
	wsOrphans             // all bindings whose conversation is not in the live set
)

type wsReq struct {
	kind       wsReqKind
	convID     string
	sourceRoot string
	workspace  string
	live       map[string]bool
	resp       chan wsResp
}

type wsResp struct {
	bindings map[string]string            // sourceRoot → workspace
	orphans  map[string]map[string]string // convID → (sourceRoot → workspace)
}

// NewWorkspaceRegistry builds a registry for a project, loading any persisted
// bindings from <projectRoot>/.juggler/workspaces.json. The actor goroutine runs
// until Close.
func NewWorkspaceRegistry(projectRoot string) *WorkspaceRegistry {
	r := &WorkspaceRegistry{
		reqCh:  make(chan wsReq),
		quitCh: make(chan struct{}),
	}
	if strings.TrimSpace(projectRoot) != "" {
		r.path = filepath.Join(projectRoot, ".juggler", "workspaces.json")
	}
	go r.run(loadWorkspaceBindings(r.path))
	return r
}

// Bind records that, for convID, real paths under sourceRoot execute under
// workspaceRoot instead. Idempotent; a re-bind of the same source replaces its
// workspace. Persisted.
func (r *WorkspaceRegistry) Bind(convID, sourceRoot, workspaceRoot string) {
	if convID == "" || sourceRoot == "" || workspaceRoot == "" {
		return
	}
	r.ask(wsReq{kind: wsBind, convID: convID, sourceRoot: filepath.Clean(sourceRoot), workspace: filepath.Clean(workspaceRoot)})
}

// Unbind clears the binding for one source directory of convID. Persisted.
func (r *WorkspaceRegistry) Unbind(convID, sourceRoot string) {
	if convID == "" || sourceRoot == "" {
		return
	}
	r.ask(wsReq{kind: wsUnbind, convID: convID, sourceRoot: filepath.Clean(sourceRoot)})
}

// UnbindAll clears every workspace binding for convID. Persisted. Called when a
// conversation is deleted (and when its orphaned worktrees have been swept).
func (r *WorkspaceRegistry) UnbindAll(convID string) {
	if convID == "" {
		return
	}
	r.ask(wsReq{kind: wsUnbindAll, convID: convID})
}

// Bindings returns a snapshot of convID's source→workspace bindings.
func (r *WorkspaceRegistry) Bindings(convID string) map[string]string {
	if convID == "" {
		return map[string]string{}
	}
	return r.ask(wsReq{kind: wsSnapshot, convID: convID}).bindings
}

// Orphans returns every convID→(source→workspace) binding whose convID is NOT in
// the live set. Passed the ids of all conversations that still exist (active +
// binned), it surfaces the workspaces of conversations that were permanently
// deleted — including deletions that happened while the server was down — so
// their worktrees can be torn down on the next project open.
func (r *WorkspaceRegistry) Orphans(live map[string]bool) map[string]map[string]string {
	return r.ask(wsReq{kind: wsOrphans, live: live}).orphans
}

// Remapper returns a path-remap function for convID, or nil when it has no
// bindings. Redirects a real absolute path into the workspace of the most
// specific (longest-prefix) bound source that contains it; a path under no bound
// source is returned unchanged.
func (r *WorkspaceRegistry) Remapper(convID string) func(string) string {
	bindings := r.Bindings(convID)
	if len(bindings) == 0 {
		return nil
	}
	return func(abs string) string {
		abs = filepath.Clean(abs)
		bestSrc, bestWs, bestLen := "", "", -1
		for src, ws := range bindings {
			rel, err := filepath.Rel(src, abs)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
				continue
			}
			if len(src) > bestLen {
				bestSrc, bestWs, bestLen = src, ws, len(src)
			}
		}
		if bestLen < 0 {
			return abs
		}
		rel, _ := filepath.Rel(bestSrc, abs)
		if rel == "." {
			return bestWs
		}
		return filepath.Join(bestWs, rel)
	}
}

// WorkspaceFor returns the workspace bound to an exact source directory for
// convID, or "" when that source is not bound.
func (r *WorkspaceRegistry) WorkspaceFor(convID, sourceRoot string) string {
	return r.Bindings(convID)[filepath.Clean(sourceRoot)]
}

// Close stops the actor goroutine.
func (r *WorkspaceRegistry) Close() {
	select {
	case <-r.quitCh:
	default:
		close(r.quitCh)
	}
}

func (r *WorkspaceRegistry) ask(req wsReq) wsResp {
	req.resp = make(chan wsResp, 1)
	select {
	case r.reqCh <- req:
		return <-req.resp
	case <-r.quitCh:
		return wsResp{bindings: map[string]string{}, orphans: map[string]map[string]string{}}
	}
}

func (r *WorkspaceRegistry) run(byConv map[string]map[string]string) {
	for {
		select {
		case <-r.quitCh:
			return
		case req := <-r.reqCh:
			switch req.kind {
			case wsBind:
				m := byConv[req.convID]
				if m == nil {
					m = map[string]string{}
					byConv[req.convID] = m
				}
				m[req.sourceRoot] = req.workspace
				r.save(byConv)
				req.resp <- wsResp{}
			case wsUnbind:
				if m := byConv[req.convID]; m != nil {
					delete(m, req.sourceRoot)
					if len(m) == 0 {
						delete(byConv, req.convID)
					}
					r.save(byConv)
				}
				req.resp <- wsResp{}
			case wsUnbindAll:
				if _, ok := byConv[req.convID]; ok {
					delete(byConv, req.convID)
					r.save(byConv)
				}
				req.resp <- wsResp{}
			case wsSnapshot:
				out := map[string]string{}
				for k, v := range byConv[req.convID] {
					out[k] = v
				}
				req.resp <- wsResp{bindings: out}
			case wsOrphans:
				orphans := map[string]map[string]string{}
				for convID, m := range byConv {
					if req.live[convID] {
						continue
					}
					copyM := map[string]string{}
					for k, v := range m {
						copyM[k] = v
					}
					orphans[convID] = copyM
				}
				req.resp <- wsResp{orphans: orphans}
			}
		}
	}
}

// save atomically rewrites the persistence file with the current bindings. Runs
// on the actor goroutine (serialized with all mutations). Best-effort: a write
// failure is logged and the in-memory state is authoritative for this session.
func (r *WorkspaceRegistry) save(byConv map[string]map[string]string) {
	if r.path == "" {
		return
	}
	data, err := json.MarshalIndent(byConv, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		jlog.Debug("workspace: persist mkdir failed: %v", err)
		return
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		jlog.Debug("workspace: persist write failed: %v", err)
		return
	}
	if err := atomicio.RobustRename(tmp, r.path); err != nil {
		jlog.Debug("workspace: persist rename failed: %v", err)
		_ = os.Remove(tmp)
	}
}

// loadWorkspaceBindings reads persisted bindings, or an empty map when the file
// is absent/unreadable/corrupt (never fatal — a lost record just means a
// re-bind on next activation and, at worst, a worktree that lingers until it is
// rediscovered).
func loadWorkspaceBindings(path string) map[string]map[string]string {
	out := map[string]map[string]string{}
	if path == "" {
		return out
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(data, &out)
	if out == nil {
		out = map[string]map[string]string{}
	}
	return out
}
