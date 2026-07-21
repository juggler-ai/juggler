//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"path/filepath"
	"strings"
)

// WorkspaceRegistry maps a conversation to an alternate execution root — its
// "workspace" — chosen by an EXTENSION, not by core. Core knows nothing about
// what a workspace is or how it is created: a git worktree, a devcontainer
// mount, an ephemeral sandbox, a remote checkout. It only knows that while a
// conversation has a workspace bound, that conversation's file/shell/search/tree
// ops should execute under the workspace root instead of the project root, with
// paths still validated in real-project space (see ops.PathScope.WithRemap).
//
// This is the whole core-side contribution to the "worktrees as an extension"
// design (issue #51): a per-conversation execution-root indirection plus a bind
// API. The policy — deciding a workspace exists, creating it, tearing it down —
// lives in an extension (see web/extensions/juggler-worktrees/).
//
// It is a channel-based actor (the repo lint forbids sync.Mutex/RWMutex): all
// map access runs on one goroutine. It is project-scoped (hangs off
// projectState), so a SwitchProject starts every conversation fresh.
type WorkspaceRegistry struct {
	reqCh  chan wsReq
	quitCh chan struct{}
	root   string // real project root; workspaces are alternate roots for it
}

type wsReqKind int

const (
	wsBind wsReqKind = iota
	wsUnbind
	wsGet
	wsList
)

type wsReq struct {
	kind   wsReqKind
	convID string
	root   string
	resp   chan wsResp
}

type wsResp struct {
	root string
	list map[string]string
}

// NewWorkspaceRegistry builds a registry for a project root. root is the real
// project path; a bound workspace is treated as an alternate root for the whole
// project subtree. The actor goroutine runs until Close.
func NewWorkspaceRegistry(projectRoot string) *WorkspaceRegistry {
	r := &WorkspaceRegistry{
		reqCh:  make(chan wsReq),
		quitCh: make(chan struct{}),
		root:   filepath.Clean(projectRoot),
	}
	go r.run()
	return r
}

// Bind records that convID's ops should execute under workspaceRoot. Idempotent;
// a re-bind replaces the previous root.
func (r *WorkspaceRegistry) Bind(convID, workspaceRoot string) {
	if convID == "" || workspaceRoot == "" {
		return
	}
	r.ask(wsReq{kind: wsBind, convID: convID, root: filepath.Clean(workspaceRoot)})
}

// Unbind clears any workspace binding for convID (ops revert to the project
// root). Called by an extension on teardown, and by the server when a
// conversation is deleted.
func (r *WorkspaceRegistry) Unbind(convID string) {
	if convID == "" {
		return
	}
	r.ask(wsReq{kind: wsUnbind, convID: convID})
}

// Root returns the workspace root bound to convID, or "" when none is bound.
func (r *WorkspaceRegistry) Root(convID string) string {
	if convID == "" {
		return ""
	}
	return r.ask(wsReq{kind: wsGet, convID: convID}).root
}

// Remapper returns a path-remap function for convID, or nil when no workspace is
// bound (⇒ the ops layer runs the conversation directly in the project). The
// returned function redirects a real absolute path that lives under the project
// root into the workspace, preserving its project-relative location; paths
// outside the project root (e.g. an allowed-paths grant elsewhere) are returned
// unchanged, so a workspace never captures out-of-project access.
func (r *WorkspaceRegistry) Remapper(convID string) func(string) string {
	ws := r.Root(convID)
	if ws == "" {
		return nil
	}
	root := r.root
	return func(abs string) string {
		abs = filepath.Clean(abs)
		rel, err := filepath.Rel(root, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return abs // outside the project subtree — not remapped
		}
		if rel == "." {
			return ws
		}
		return filepath.Join(ws, rel)
	}
}

// Tracked returns a snapshot of convID → workspace root (diagnostics/tests).
func (r *WorkspaceRegistry) Tracked() map[string]string {
	return r.ask(wsReq{kind: wsList}).list
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
		return wsResp{list: map[string]string{}}
	}
}

func (r *WorkspaceRegistry) run() {
	roots := map[string]string{} // convID → workspace root
	for {
		select {
		case <-r.quitCh:
			return
		case req := <-r.reqCh:
			switch req.kind {
			case wsBind:
				roots[req.convID] = req.root
				req.resp <- wsResp{}
			case wsUnbind:
				delete(roots, req.convID)
				req.resp <- wsResp{}
			case wsGet:
				req.resp <- wsResp{root: roots[req.convID]}
			case wsList:
				out := make(map[string]string, len(roots))
				for k, v := range roots {
					out[k] = v
				}
				req.resp <- wsResp{list: out}
			}
		}
	}
}
