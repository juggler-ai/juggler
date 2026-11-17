//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"sync"

	"juggler/cmd/juggler/gitops"
	"juggler/internal/jlog"
)

// The git watches viewers ask for.
//
// A viewer sends one git-watch frame naming every workspace whose git state it
// shows ("" is the project), replacing whatever it named before; it sends the
// whole set again after a reconnect, and an empty set when it shows none. Each
// named workspace is watched once however many viewers name it
// (Workspace.GitWatch), for exactly as long as one of them still does: the last
// to stop asking, or to disconnect, ends it. Each change is sent as a git-change
// frame to the connections that asked for that workspace, and no others.
//
// A workspace that cannot be resolved is not watched; its viewer's status read
// reports why, as it would have anyway. A viewer naming it again — after a
// reconnect, or on switching back to it — tries again.

// gitWatchEntry is one workspace's watch and the connections it is for.
type gitWatchEntry struct {
	cancel  context.CancelFunc
	clients map[string]bool
}

// gitWatchHub holds every git watch. Its state belongs to one goroutine, which
// everything else reaches through cmds; it is started on first use, so a server
// no viewer ever asks has no goroutine for it.
type gitWatchHub struct {
	once     sync.Once
	stopOnce sync.Once
	cmds     chan func()
	quit     chan struct{}

	// Owned by the hub's goroutine.
	clients map[string]map[string]bool // by connection: the workspaces it asked for
	watches map[string]*gitWatchEntry  // by workspace id
}

// gitHub is the server's git watch hub, started if it was not.
func (s *Server) gitHub() *gitWatchHub {
	h := &s.gitWatches
	h.once.Do(func() {
		// Buffered so a connection's read loop hands over its frames in order
		// and moves on, while a watch is started behind it.
		h.cmds = make(chan func(), 64)
		h.quit = make(chan struct{})
		h.clients = map[string]map[string]bool{}
		h.watches = map[string]*gitWatchEntry{}
		go h.run()
	})
	return h
}

func (h *gitWatchHub) run() {
	for {
		select {
		case fn := <-h.cmds:
			fn()
		case <-h.quit:
			for _, e := range h.watches {
				e.cancel()
			}
			h.watches = map[string]*gitWatchEntry{}
			return
		}
	}
}

// post queues fn for the hub's goroutine, unless the hub has stopped.
func (h *gitWatchHub) post(fn func()) bool {
	select {
	case h.cmds <- fn:
		return true
	case <-h.quit:
		return false
	}
}

// setGitWatches makes ids the workspaces a connection watches.
func (s *Server) setGitWatches(clientID string, ids []string) {
	h := s.gitHub()
	h.post(func() { h.set(s, clientID, ids) })
}

// dropGitWatches ends a departed connection's watches.
func (s *Server) dropGitWatches(clientID string) {
	s.setGitWatches(clientID, nil)
}

// stopGitWatches ends every watch, for shutdown. Safe to call twice.
func (s *Server) stopGitWatches() {
	h := s.gitHub()
	h.stopOnce.Do(func() { close(h.quit) })
}

// set is setGitWatches on the hub's goroutine.
func (h *gitWatchHub) set(s *Server, clientID string, ids []string) {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	for id := range h.clients[clientID] {
		if !want[id] {
			h.release(clientID, id)
		}
	}
	for id := range want {
		e := h.watches[id]
		if e == nil {
			if e = h.start(s, id); e == nil {
				continue
			}
			h.watches[id] = e
		}
		e.clients[clientID] = true
	}
	if len(want) == 0 {
		delete(h.clients, clientID)
	} else {
		h.clients[clientID] = want
	}
}

// release takes one connection off a workspace's watch, ending the watch when
// it was the last.
func (h *gitWatchHub) release(clientID, id string) {
	e := h.watches[id]
	if e == nil {
		return
	}
	delete(e.clients, clientID)
	if len(e.clients) == 0 {
		e.cancel()
		delete(h.watches, id)
	}
}

// start begins watching a workspace, or says why it cannot and returns nil.
func (h *gitWatchHub) start(s *Server, id string) *gitWatchEntry {
	ws, err := s.gitResolve(id)
	if err != nil {
		jlog.Info("[GitWatch] Not watching workspace %q: %v", id, err)
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	changes, err := ws.GitWatch(ctx)
	if err != nil {
		cancel()
		jlog.Info("[GitWatch] Not watching workspace %q: %v", id, err)
		return nil
	}
	e := &gitWatchEntry{cancel: cancel, clients: map[string]bool{}}
	go h.forward(s, id, e, changes)
	return e
}

// forward sends each of a watch's batches to the connections that asked for
// it, until the watch ends.
func (h *gitWatchHub) forward(s *Server, id string, e *gitWatchEntry, changes <-chan []gitops.Change) {
	for batch := range changes {
		frame := newGitChangeFrame(id, batch)
		h.post(func() {
			// A watch ended and begun again is another entry; this one's news
			// is for nobody.
			if h.watches[id] != e {
				return
			}
			for clientID := range e.clients {
				s.viewerSendToClient(clientID, frame)
			}
		})
	}
}

// sendToGitWatchers sends frame to every connection whose git-watch set names
// workspace id — whether or not its watch could be started, since what the
// set says is which workspace's git the viewer shows. It is sent from the hub's
// goroutine, so it reaches each connection after every set the connection
// made before it.
func (s *Server) sendToGitWatchers(id string, frame any) {
	h := s.gitHub()
	h.post(func() {
		for clientID, ids := range h.clients {
			if ids[id] {
				s.viewerSendToClient(clientID, frame)
			}
		}
	})
}

// newGitChangeFrame is one batch of a workspace's changes as the wire spells it.
func newGitChangeFrame(id string, batch []gitops.Change) gitChangeFrame {
	repos := make([]gitChangeRepo, 0, len(batch))
	for _, c := range batch {
		repos = append(repos, gitChangeRepo{Path: c.Repo, Kinds: c.Kinds.Names()})
	}
	return gitChangeFrame{Type: frameGitChange, Workspace: id, Repos: repos}
}
