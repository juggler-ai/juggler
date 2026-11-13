//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// Moving a project's folder. A session's child is rooted in its project's
// path for its whole life, so a project is never moved under one: the session
// is retired, the folder moved (core.RelocateProject), and a session opened on
// the new path — a new id and a new link. A window on the old session finds it
// gone, as it would after any stop, and asks where the project went
// (handleRelocation); a page load of the old link opens the new one
// (serveOpener). What the server remembers of a move lasts as long as the
// server does.

// relocationRetry is how long a relocation waits before asking the session
// again whether it may retire. A turn still running holds the session, and
// the conversation that asked for the move is usually still finishing its
// turn when it does.
const relocationRetry = time.Second

// relocation is one project's move, from one folder to another.
type relocation struct {
	id, from, to string
	// done closes when the move has ended, one way or the other; err is set
	// before it closes, nil when the project is now at to.
	done chan struct{}
	err  error
}

// handleRelocateSession moves the project of session id to another folder
// once nothing holds the session: every conversation idle, no approval
// waiting. It answers 202 at once with where the project will be, after
// checking what can be checked now (core.CheckProjectRelocation); the move
// itself follows (runRelocation). This machine only.
// POST /api/server/sessions/{id}/relocate {"project": "/abs/path" or "~/path"}.
func (s *Server) handleRelocateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Project string `json:"project"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
		return
	}
	sess, ok := s.reg.get(mux.Vars(r)["id"])
	if !ok {
		writeMessageError(w, http.StatusNotFound, msg.New("unknown session"))
		return
	}
	dest := filepath.Clean(userpaths.ExpandHome(req.Project))
	if err := core.CheckProjectRelocation(sess.Project, dest); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	rel := &relocation{id: sess.ID, from: sess.Project, to: dest, done: make(chan struct{})}
	if prior, loaded := s.relocations.LoadOrStore(sess.Project, rel); loaded {
		select {
		case <-prior.(*relocation).done:
			s.relocations.Store(sess.Project, rel)
		default:
			writeMessageError(w, http.StatusConflict, msg.New("this project is already being moved"))
			return
		}
	}
	s.work.Add(1)
	go func() {
		defer s.work.Done()
		s.runRelocation(rel)
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"project": dest, "link": linkUnder(s.requestBase(r), projectLink(dest))})
}

// runRelocation carries out rel: retires its session, moves the folder, and
// opens a session where the project has gone — or, when the move fails,
// where it was.
func (s *Server) runRelocation(rel *relocation) {
	defer close(rel.done)
	if !s.retireForRelocation(rel.id) {
		rel.err = errors.New("the machine server is shutting down")
		return
	}
	open := rel.to
	if rel.err = core.RelocateProject(rel.from, rel.to); rel.err != nil {
		jlog.Error("[machineserver] moving %s to %s: %v", rel.from, rel.to, rel.err)
		open = rel.from
	} else {
		jlog.Info("[machineserver] moved %s to %s", rel.from, rel.to)
	}
	if res := s.openSession(s.lifetime(), open, false); res.refusal != nil {
		jlog.Error("[machineserver] reopening %s after its move: refused (%d)", open, res.status)
	}
}

// retireForRelocation waits until session id may retire and retires it, as
// an unviewed session is retired (Server.retire) but whoever is viewing it: a
// refusal — a turn running, an approval waiting — is asked again after
// relocationRetry. A session that has gone, or is not running to be asked,
// holds the project no longer, or will once it has settled; the move itself
// checks the project's lock. Reports false only when the server is shutting
// down.
func (s *Server) retireForRelocation(id string) bool {
	for {
		c, exists := s.reg.claimForRelocation(id)
		if !exists {
			return true
		}
		if c != nil {
			switch requestRetirement(c) {
			case retireAccepted:
				c.stop()
				s.reg.remove(id)
				return true
			case retireExited:
				if c.exitedCleanly() {
					s.reg.remove(id)
					return true
				}
				s.reg.retirementRefused(id, c)
			default:
				s.reg.retirementRefused(id, c)
			}
		}
		select {
		case <-s.lifetime().Done():
			return false
		case <-time.After(relocationRetry):
		}
	}
}

// claimForRelocation claims running session id for the question whether its
// child may retire, as retireUnviewed does but whoever is viewing it. c is nil
// when the session is not running to be asked; exists is false when there is
// no such session.
func (r *registry) claimForRelocation(id string) (c *child, exists bool) {
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e == nil {
			return
		}
		exists = true
		if e.child == nil || e.State != SessionRunning {
			return
		}
		e.setState(SessionStopping)
		e.retiring = make(chan struct{})
		c = e.child
	})
	return c, exists
}

// movedTo is where project has moved to: the folder of its last relocation,
// once that has finished and succeeded. A relocation still under way is
// waited for. ok is false for a project never moved, or whose move failed.
func (s *Server) movedTo(project string) (dest string, ok bool) {
	v, found := s.relocations.Load(filepath.Clean(project))
	if !found {
		return "", false
	}
	rel := v.(*relocation)
	<-rel.done
	return rel.to, rel.err == nil
}

// movedToKey is movedTo for the project whose link key is key, without
// waiting: for a page load of an old link (serveOpener).
func (s *Server) movedToKey(key string) (dest string, ok bool) {
	s.relocations.Range(func(_, v any) bool {
		rel := v.(*relocation)
		if projectKey(rel.from) != key {
			return true
		}
		select {
		case <-rel.done:
			dest, ok = rel.to, rel.err == nil
		default:
		}
		return false
	})
	return dest, ok
}

// relocationResponse is the GET /api/server/relocations payload.
type relocationResponse struct {
	Project string `json:"project"`
	Link    string `json:"link"`
}

// handleRelocation says where a project has moved to, waiting for a move
// still under way: 404 for a project that has not moved.
// GET /api/server/relocations?project=/abs/path.
func (s *Server) handleRelocation(w http.ResponseWriter, r *http.Request) {
	dest, ok := s.movedTo(r.URL.Query().Get("project"))
	if !ok {
		writeMessageError(w, http.StatusNotFound, msg.New("this project has not moved"))
		return
	}
	writeJSON(w, http.StatusOK, relocationResponse{Project: dest, Link: linkUnder(s.requestBase(r), projectLink(dest))})
}

// MovedTo asks where project has moved to, waiting for a move still under
// way; ok is false for a project that has not moved. Like OpenSession, the
// call has no timeout of its own: the server bounds the wait.
func (c *Client) MovedTo(project string) (dest string, ok bool, err error) {
	untimed := &http.Client{Transport: c.http.Transport}
	var out relocationResponse
	status, err := c.sendWith(untimed, http.MethodGet, "/relocations?project="+url.QueryEscape(project), nil, &out)
	if status == http.StatusNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return out.Project, true, nil
}
