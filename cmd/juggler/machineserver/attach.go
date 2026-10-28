//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// handleAttach holds the caller attached (see attach) for as long as it keeps
// this request open, so an implicit server does not exit idle under it. It
// answers 200 at once with one line of JSON, the server's status, sent only
// once the caller is counted, and then sends nothing more. The response ends
// when the caller goes — its connection closing, however its process ended —
// or when the server's lifetime ends, so a held attachment never stalls the
// shutdown's drain. POST /api/server/attach, with no body.
func (s *Server) handleAttach(w http.ResponseWriter, r *http.Request) {
	// net/http notices a caller going only once it has read the request body
	// to its end, so read it first.
	_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 1<<10))
	detach := s.attach()
	defer detach()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(s.status()); err != nil {
		return
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		return
	}
	select {
	case <-r.Context().Done():
	case <-s.lifetime().Done():
	}
}

// Attachment is a client's hold on the machine server (Client.Attach). While
// it stands, the server counts the client as attached and does not exit idle.
type Attachment struct {
	body io.ReadCloser
	done chan struct{}
}

// Attach holds this client attached to the server until Close, keeping an
// implicit server from exiting idle. It returns once the server has counted
// the attachment.
func (c *Client) Attach() (*Attachment, error) {
	req, err := http.NewRequest(http.MethodPost, "http://"+c.addr+"/api/server/attach", http.NoBody) //nolint:noctx // held until Close; the wait for an answer is bounded by the transport
	if err != nil {
		return nil, err
	}
	req.Header.Set(TokenHeader, c.token)
	// No overall timeout: the response stays open for as long as the
	// attachment stands. Only the wait for the server's answer is bounded.
	hc := &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: statusProbeTimeout}}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w (server.json names %s, which is not answering)", errNoServer, c.addr)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, responseError(resp)
	}
	// The status line is sent once the server counts the attachment.
	br := bufio.NewReader(resp.Body)
	if _, err := br.ReadBytes('\n'); err != nil {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("attach to the Juggler server at %s: %w", c.addr, err)
	}
	a := &Attachment{body: resp.Body, done: make(chan struct{})}
	go func() {
		_, _ = io.Copy(io.Discard, br)
		close(a.done)
	}()
	return a, nil
}

// Done closes when the attachment has ended: Close was called, or the server
// ended it — it shut down, or the connection to it was lost.
func (a *Attachment) Done() <-chan struct{} { return a.done }

// Close lets the server go, and returns once the attachment has ended.
func (a *Attachment) Close() {
	_ = a.body.Close()
	<-a.done
}
