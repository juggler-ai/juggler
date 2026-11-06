//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// streamingSupervisor is a stand-in machine server whose events stream sends
// one sessions frame and then holds the stream open until its caller goes. It
// reports each call it received, and closes gone when a caller's request has
// ended.
type streamingSupervisor struct {
	addr  string
	calls chan supervisorCall
	gone  chan struct{}
}

// The frame the stand-in sends, byte for byte, which the relay passes on as it is.
const relayedFrame = "event: sessions\ndata: {\"sessions\":[],\"recents\":{\"paths\":[]}}\n\n"

func newStreamingSupervisor(t *testing.T) *streamingSupervisor {
	t.Helper()
	sup := &streamingSupervisor{calls: make(chan supervisorCall, 4), gone: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sup.calls <- supervisorCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, token: r.Header.Get("X-Juggler-Token")}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(relayedFrame))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(sup.gone)
	}))
	t.Cleanup(srv.Close)
	sup.addr = strings.TrimPrefix(srv.URL, "http://")
	return sup
}

// TestSessionRelaysTheMachineServersEvents: a project page follows what the
// sessions page shows — every session's attention, and the recents — without
// holding the control token, which can stop sessions. Its child relays the
// machine server's events stream instead, with the token it already holds,
// naming its session: GET /api/machine/events, read-only, for any viewer the
// child's own auth admits, on this machine or off it. The stream is passed on
// as it arrives, not when it ends, and lives as long as the viewer's request;
// a viewer that goes takes the upstream stream with it. A child with no
// machine server has none to relay.
func TestSessionRelaysTheMachineServersEvents(t *testing.T) {
	sup := newStreamingSupervisor(t)
	s := connectivityServer(t, sup.addr)
	// A viewer off this machine, as the machine server forwards one.
	viewer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.router.ServeHTTP(w, MarkRemoteIngress(r, supervisorIngressKind))
	}))
	t.Cleanup(viewer.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, viewer.URL+"/api/machine/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/machine/events: %d, want 200", resp.StatusCode)
	}
	for header, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-store",
		"X-Accel-Buffering": "no",
	} {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("%s: %q, want %q", header, got, want)
		}
	}

	// The first frame arrives while the upstream stream is still open. A relay
	// that holds it back has the request cancelled under the read, which ends
	// it short.
	stall := time.AfterFunc(10*time.Second, cancel)
	r := bufio.NewReader(resp.Body)
	var got strings.Builder
	for !strings.HasSuffix(got.String(), "\n\n") {
		line, err := r.ReadString('\n')
		got.WriteString(line)
		if err != nil {
			break
		}
	}
	if !stall.Stop() || got.String() != relayedFrame {
		t.Fatalf("relayed %q while the machine server's stream stayed open, want its frame as sent, %q", got.String(), relayedFrame)
	}

	select {
	case call := <-sup.calls:
		want := supervisorCall{method: http.MethodGet, path: "/api/server/events", query: "session=sess-1", token: "control-token"}
		if call != want {
			t.Fatalf("machine server got %+v, want %+v", call, want)
		}
	default:
		t.Fatal("the machine server was never asked")
	}

	// The viewer goes, and so does the upstream stream.
	cancel()
	select {
	case <-sup.gone:
	case <-time.After(10 * time.Second):
		t.Fatal("the machine server's stream outlived the viewer's request")
	}

	// Read-only: nothing but GET.
	post, err := http.Post(viewer.URL+"/api/machine/events", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	post.Body.Close()
	if post.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/machine/events: %d, want 405", post.StatusCode)
	}

	alone := connectivityServer(t, "")
	rec := httptest.NewRecorder()
	alone.router.ServeHTTP(rec, localRequest(http.MethodGet, "/api/machine/events", ""))
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /api/machine/events with no machine server: %d, want 404", rec.Code)
	}
}
