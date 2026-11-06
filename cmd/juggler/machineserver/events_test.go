//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/internal/attention"
)

// sseEvent is one server-sent event: its name and data, or err when the
// stream ended or failed instead.
type sseEvent struct {
	name, data string
	err        error
}

// readEvents delivers the stream's events in order, comment lines skipped,
// ending with one whose err is set.
func readEvents(body io.Reader) <-chan sseEvent {
	out := make(chan sseEvent, 16)
	go func() {
		defer close(out)
		br := bufio.NewReader(body)
		var ev sseEvent
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				out <- sseEvent{err: err}
				return
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case line == "":
				if ev.name != "" || ev.data != "" {
					out <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
			case strings.HasPrefix(line, "event: "):
				ev.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data += strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return out
}

// nextEvent is the stream's next event, failing the test if none comes.
func nextEvent(t *testing.T, events <-chan sseEvent) sseEvent {
	t.Helper()
	select {
	case ev := <-events:
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no event within 5s")
		return sseEvent{}
	}
}

// eventSessions decodes a sessions event's sessions.
func eventSessions(t *testing.T, ev sseEvent) []Session {
	t.Helper()
	if ev.err != nil || ev.name != "sessions" {
		t.Fatalf("event = %+v, want a sessions event", ev)
	}
	var body struct {
		Sessions []Session       `json:"sessions"`
		Recents  recentsResponse `json:"recents"`
	}
	if err := json.Unmarshal([]byte(ev.data), &body); err != nil {
		t.Fatalf("sessions event data %q: %v", ev.data, err)
	}
	return body.Sessions
}

// The events stream sends the sessions at once, then again on each change to
// them and only then, and ends with the server's lifetime.
func TestServerEventsPushesChanges(t *testing.T) {
	r := newRegistry()
	s := &Server{reg: r, token: testToken}
	sess, _ := r.reserve("/p")
	c := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
	r.setRunning(sess.ID, c, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/api/server/events", nil)
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("events: %d %q, want 200 text/event-stream", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	events := readEvents(resp.Body)

	first := eventSessions(t, nextEvent(t, events))
	if len(first) != 1 || first[0].ID != sess.ID || first[0].Attention != nil {
		t.Fatalf("first event = %+v, want the one session, no attention yet", first)
	}

	report := attention.Report{Rev: 1, Conversations: []attention.Conversation{conv("c1", attention.Waiting, 0)}}
	r.setAttention(sess.ID, c, report)
	if got := eventSessions(t, nextEvent(t, events)); got[0].Attention == nil || got[0].Attention.Waiting != 1 {
		t.Fatalf("after setAttention: %+v, want one waiting", got[0].Attention)
	}

	// The same report again changes nothing, so the next event is the change
	// after it.
	r.setAttention(sess.ID, c, report)
	r.setActivity(sess.ID, c, true, 0, time.Now())
	if got := eventSessions(t, nextEvent(t, events)); !got[0].Busy {
		t.Fatalf("after setActivity: %+v, want busy (an unchanged report sent an event)", got[0])
	}

	s.endLifetime()
	if ev := nextEvent(t, events); !errors.Is(ev.err, io.EOF) {
		t.Fatalf("after the lifetime ended: %+v, want the stream closed", ev)
	}
}

func TestServerEventsNeedTheToken(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	if code := send(t, "GET", front.URL+"/api/server/events", "", ""); code != http.StatusUnauthorized {
		t.Fatalf("tokenless events: %d, want 401", code)
	}
}
