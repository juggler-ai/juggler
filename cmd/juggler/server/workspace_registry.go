//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"path/filepath"
	"strings"
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
// extension). This is the whole core-side contribution to "worktrees as an
// extension" (issue #51): a per-(conversation, source) execution-root
// indirection plus a bind API.
//
// It is a channel-based actor (the repo lint forbids sync.Mutex/RWMutex): all
// map access runs on one goroutine. It is project-scoped (hangs off
// projectState), so a SwitchProject starts every conversation fresh.
type WorkspaceRegistry struct {
	reqCh  chan wsReq
	quitCh chan struct{}
}

type wsReqKind int

const (
	wsBind      wsReqKind = iota
	wsUnbind              // unbind one source for a conversation
	wsUnbindAll           // unbind every source for a conversation
	wsSnapshot            // all (source→workspace) bindings for a conversation
)

type wsReq struct {
	kind       wsReqKind
	convID     string
	sourceRoot string
	workspace  string
	resp       chan wsResp
}

type wsResp struct {
	bindings map[string]string // sourceRoot → workspace
}

// NewWorkspaceRegistry builds an empty registry. The actor goroutine runs until
// Close. projectRoot is accepted for symmetry/no-project checks by the caller;
// the registry itself is path-agnostic (it routes by the bound source prefixes).
func NewWorkspaceRegistry(_ string) *WorkspaceRegistry {
	r := &WorkspaceRegistry{
		reqCh:  make(chan wsReq),
		quitCh: make(chan struct{}),
	}
	go r.run()
	return r
}

// Bind records that, for convID, real paths under sourceRoot execute under
// workspaceRoot instead. Idempotent; a re-bind of the same source replaces its
// workspace. Both paths are cleaned to absolute-comparable form.
func (r *WorkspaceRegistry) Bind(convID, sourceRoot, workspaceRoot string) {
	if convID == "" || sourceRoot == "" || workspaceRoot == "" {
		return
	}
	r.ask(wsReq{kind: wsBind, convID: convID, sourceRoot: filepath.Clean(sourceRoot), workspace: filepath.Clean(workspaceRoot)})
}

// Unbind clears the binding for one source directory of convID.
func (r *WorkspaceRegistry) Unbind(convID, sourceRoot string) {
	if convID == "" || sourceRoot == "" {
		return
	}
	r.ask(wsReq{kind: wsUnbind, convID: convID, sourceRoot: filepath.Clean(sourceRoot)})
}

// UnbindAll clears every workspace binding for convID (all its ops revert to the
// real paths). Called by the server when a conversation is deleted.
func (r *WorkspaceRegistry) UnbindAll(convID string) {
	if convID == "" {
		return
	}
	r.ask(wsReq{kind: wsUnbindAll, convID: convID})
}

// Bindings returns a snapshot of convID's source→workspace bindings (empty when
// none). Used by the git-status card to remap each discovered repo.
func (r *WorkspaceRegistry) Bindings(convID string) map[string]string {
	if convID == "" {
		return map[string]string{}
	}
	return r.ask(wsReq{kind: wsSnapshot, convID: convID}).bindings
}

// Remapper returns a path-remap function for convID, or nil when it has no
// bindings (⇒ the ops layer runs the conversation directly in the project). The
// returned function redirects a real absolute path into the workspace of the
// most specific (longest-prefix) bound source directory that contains it,
// preserving its location within that source; a path under no bound source is
// returned unchanged.
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
				continue // abs is not under this source
			}
			if len(src) > bestLen {
				bestSrc, bestWs, bestLen = src, ws, len(src)
			}
		}
		if bestLen < 0 {
			return abs // under no bound source
		}
		rel, _ := filepath.Rel(bestSrc, abs)
		if rel == "." {
			return bestWs
		}
		return filepath.Join(bestWs, rel)
	}
}

// WorkspaceFor returns the workspace bound to an exact source directory for
// convID, or "" when that source is not bound. Used by git-status to show each
// repo's checkout for the visible conversation.
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
		return wsResp{bindings: map[string]string{}}
	}
}

func (r *WorkspaceRegistry) run() {
	// convID → (sourceRoot → workspaceRoot)
	byConv := map[string]map[string]string{}
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
				req.resp <- wsResp{}
			case wsUnbind:
				if m := byConv[req.convID]; m != nil {
					delete(m, req.sourceRoot)
					if len(m) == 0 {
						delete(byConv, req.convID)
					}
				}
				req.resp <- wsResp{}
			case wsUnbindAll:
				delete(byConv, req.convID)
				req.resp <- wsResp{}
			case wsSnapshot:
				out := map[string]string{}
				for k, v := range byConv[req.convID] {
					out[k] = v
				}
				req.resp <- wsResp{bindings: out}
			}
		}
	}
}
