//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
)

// An attachment is held two ways. The held POST /api/server/attach ends the
// moment the client's process does, however it ended. And the client beats
// (POST /api/server/attach/<id>/beat) every attachBeatEvery, which tells a live
// client from one whose process is still there but has stopped — hung, or its
// connection silently gone. The server checks every attachCheckEvery, and drops
// an attachment that has not beaten since attachMissLimit of its checks in a
// row: it ends the held response, which the client sees as Done. A live client
// then attaches again. The count is of the server's own checks, not of time, so
// a machine that sleeps misses no beats: its checks sleep with it.
const (
	attachBeatEvery  = 5 * time.Second
	attachCheckEvery = 5 * time.Second
	attachMissLimit  = 6
)

// attachment is one held POST /api/server/attach, as the server tracks it.
type attachment struct {
	// beaten is set by each beat and cleared by each check.
	beaten atomic.Bool
	// missed counts the checks in a row that found no beat since the last.
	missed atomic.Int32
	// dropped closes when the server drops the attachment.
	dropped  chan struct{}
	dropOnce sync.Once
	detach   func()
}

func (a *attachment) drop() {
	a.dropOnce.Do(func() {
		a.detach()
		close(a.dropped)
	})
}

// attachStatus is the line handleAttach answers with: the server's status and
// the attachment's id, which its beats name.
type attachStatus struct {
	statusResponse
	Attachment string `json:"attachment"`
}

// handleAttach holds the caller attached (see attach) for as long as it keeps
// this request open and keeps beating, so an implicit server does not exit idle
// under it. It answers 200 at once with one line of JSON (attachStatus), sent
// only once the caller is counted, and then sends nothing more. The response
// ends when the caller goes — its connection closing, however its process ended
// — when it stops beating (checkAttachments), or when the server's lifetime
// ends, so a held attachment never stalls the shutdown's drain. A server
// already shutting down refuses with 503, as an open does, so a client that
// caught it on its way out learns so from the answer rather than from an
// attachment that ends a moment later.
// POST /api/server/attach {"pid": the local client process id, "session": optional session id}.
// A named session is held as a viewer until the attachment ends or drops.
func (s *Server) handleAttach(w http.ResponseWriter, r *http.Request) {
	if s.callerKind(r) != "" {
		http.Error(w, "Forbidden: only local clients may attach", http.StatusForbidden)
		return
	}
	// net/http notices a caller going only once it has read the request body
	// to its end, so read it first.
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<10))
	var req struct {
		PID     int    `json:"pid"`
		Session string `json:"session,omitempty"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeMessageError(w, http.StatusBadRequest, msg.New("invalid request body: {error}", "error", err.Error()))
			return
		}
	}
	if s.lifetime().Err() != nil {
		writeMessageError(w, http.StatusServiceUnavailable, msg.New("the machine server is shutting down"))
		return
	}
	var release func()
	if req.Session != "" {
		var ok bool
		release, ok = s.reg.holdViewer(req.Session)
		if !ok {
			sess, found := s.reg.get(req.Session)
			if !found {
				writeMessageError(w, http.StatusNotFound, msg.New("unknown session"))
			} else {
				http.Error(w, "session is not running (state: "+string(sess.State)+")", http.StatusServiceUnavailable)
			}
			return
		}
	}
	id := mintAttachmentID()
	letServerGo := s.attach()
	// Counted first, then closing read: see shutdownIf.
	if s.closing.Load() || s.lifetime().Err() != nil {
		if release != nil {
			release()
		}
		letServerGo()
		writeMessageError(w, http.StatusServiceUnavailable, msg.New("the machine server is shutting down"))
		return
	}
	detach := func() {
		if release != nil {
			release()
		}
		letServerGo()
	}
	defer detach()
	// Count the attachment before releasing the starter hold. Other clients
	// attaching do not release the starter process's hold.
	if s.starter > 0 && req.PID == s.starter {
		s.starterGone.Store(true)
	}
	a := &attachment{dropped: make(chan struct{}), detach: detach}
	s.attachments.Store(id, a)
	defer s.attachments.Delete(id)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(attachStatus{statusResponse: s.status(), Attachment: id}); err != nil {
		return
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		return
	}
	select {
	case <-r.Context().Done():
	case <-a.dropped:
	case <-s.lifetime().Done():
	}
}

// handleBeat records a beat for the attachment it names: 204, or 404 when the
// server holds no such attachment — it has ended, or been dropped.
// POST /api/server/attach/{id}/beat.
func (s *Server) handleBeat(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 1<<10))
	v, ok := s.attachments.Load(mux.Vars(r)["id"])
	if !ok {
		writeMessageError(w, http.StatusNotFound, msg.New("unknown attachment"))
		return
	}
	v.(*attachment).beaten.Store(true)
	w.WriteHeader(http.StatusNoContent)
}

// checkAttachments is one of the server's checks: each attachment that has not
// beaten since the last one has missed it, and one that has missed
// attachMissLimit in a row is dropped.
func (s *Server) checkAttachments() {
	s.attachments.Range(func(k, v any) bool {
		a := v.(*attachment)
		if a.beaten.Swap(false) {
			a.missed.Store(0)
			return true
		}
		if a.missed.Add(1) >= attachMissLimit {
			jlog.Info("[machineserver] attachment %s stopped beating — dropping it", k)
			a.drop()
		}
		return true
	})
}

// watchAttachments checks the attachments on each tick, until ticks closes or
// the server's lifetime ends.
func (s *Server) watchAttachments(ticks <-chan time.Time) {
	for {
		select {
		case _, ok := <-ticks:
			if !ok {
				return
			}
			s.check()
		case <-s.lifetime().Done():
			return
		}
	}
}

// mintAttachmentID returns a fresh random attachment id.
func mintAttachmentID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("machineserver.mintAttachmentID: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// Attachment is a client's hold on the machine server (Client.Attach). While
// it stands, the server counts the client as attached and does not exit idle.
type Attachment struct {
	body io.ReadCloser
	done chan struct{}
}

// Attach holds this client attached to the server until Close, keeping an
// implicit server from exiting idle, and beats for it while it stands. It
// returns once the server has counted the attachment. An optional session ID
// also holds that running session as a viewer; omit it for a desktop client.
func (c *Client) Attach(sessionIDs ...string) (*Attachment, error) {
	if len(sessionIDs) > 1 {
		return nil, fmt.Errorf("attach: expected at most one session ID")
	}
	var session string
	if len(sessionIDs) == 1 {
		session = sessionIDs[0]
	}
	body, _ := json.Marshal(struct {
		PID     int    `json:"pid"`
		Session string `json:"session,omitempty"`
	}{PID: os.Getpid(), Session: session})
	// No clock bounds any of it: the response stays open for as long as the
	// attachment stands, and the wait for the server's first answer lasts
	// while the server does — the connection dropping ends it, and so does
	// the server's process exiting (cancelIfServerExits), which also covers a
	// connection left half-open by a server that died.
	ctx, cancel := context.WithCancel(context.Background())
	answered := make(chan struct{})
	failed := func(err error) (*Attachment, error) {
		close(answered)
		cancel()
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+c.addr+"/api/server/attach", bytes.NewReader(body))
	if err != nil {
		return failed(err)
	}
	req.Header.Set(TokenHeader, c.token)
	req.Header.Set("Content-Type", "application/json")
	go c.cancelIfServerExits(answered, cancel)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return failed(unanswered(c.addr, err))
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return failed(responseError(resp))
	}
	// The status line is sent once the server counts the attachment.
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadBytes('\n')
	if err != nil {
		_ = resp.Body.Close()
		return failed(unanswered(c.addr, err))
	}
	var st attachStatus
	if err := json.Unmarshal(line, &st); err != nil {
		_ = resp.Body.Close()
		return failed(fmt.Errorf("attach to the Juggler server at %s: %w", c.addr, err))
	}
	close(answered)
	a := &Attachment{body: resp.Body, done: make(chan struct{})}
	go func() {
		_, _ = io.Copy(io.Discard, br)
		cancel()
		close(a.done)
	}()
	go c.beat(a, st.Attachment)
	return a, nil
}

// cancelIfServerExits cancels an attach still waiting for the server's first
// answer once the server's process (c.PID) has exited, looking every
// connectPoll until answered closes. A client that knows no process (PID
// zero) leaves the wait to the connection alone.
func (c *Client) cancelIfServerExits(answered <-chan struct{}, cancel context.CancelFunc) {
	if c.PID <= 0 {
		return
	}
	tick := time.NewTicker(connectPoll)
	defer tick.Stop()
	for {
		select {
		case <-answered:
			return
		case <-tick.C:
			if !processAlive(c.PID) {
				cancel()
				return
			}
		}
	}
}

// beat posts a's beats until it ends. A server that no longer knows the
// attachment has dropped it, so a 404 ends it here too, in case the held
// response has not.
func (c *Client) beat(a *Attachment, id string) {
	every := c.beatEvery
	if every == 0 {
		every = attachBeatEvery
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-a.done:
			return
		case <-tick.C:
		}
		status, err := c.send(http.MethodPost, "/attach/"+id+"/beat", nil, nil)
		switch {
		case status == http.StatusNotFound:
			_ = a.body.Close()
			return
		case err == nil && c.beaten != nil:
			c.beaten(id)
		}
	}
}

// Done closes when the attachment has ended: Close was called, or the server
// ended it — it shut down, dropped it, or the connection to it was lost.
func (a *Attachment) Done() <-chan struct{} { return a.done }

// Close lets the server go, and returns once the attachment has ended.
func (a *Attachment) Close() {
	_ = a.body.Close()
	<-a.done
}
