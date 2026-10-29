//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// POST /api/one-shot is how `juggler run` reaches the engine of the session
// child it spawned: one request carries one run, held open until the engine
// reports. These drive the route against a real engine socket, with the test
// answering as the engine would.

// oneShotRouteBudget bounds each wait in these tests for a step that should
// follow at once. It is patience before failing, never a duration under test.
const oneShotRouteBudget = 30 * time.Second

// oneShotRoute is a server with the route mounted, and a channel told each
// time a request to it has returned.
type oneShotRoute struct {
	s        *Server
	engineTS *httptest.Server
	url      string
	entered  chan struct{}
	returned chan struct{}
}

func newOneShotRoute(t *testing.T) *oneShotRoute {
	t.Helper()
	s, engineTS := newEngineSocketServer(t)
	// Nothing here beats, so the realm stays proven for the whole test.
	s.setEngineLivenessWindow(time.Hour)
	s.shutdownChan = make(chan struct{})
	r := &oneShotRoute{s: s, engineTS: engineTS, entered: make(chan struct{}, 4), returned: make(chan struct{}, 4)}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.entered <- struct{}{}
		s.handleOneShot(w, req)
		r.returned <- struct{}{}
	}))
	t.Cleanup(ts.Close)
	r.url = ts.URL
	return r
}

// routeAnswer is how one POST to the route went.
type routeAnswer struct {
	status int
	body   string
	err    error
}

// post sends body to the route on its own goroutine; how it went arrives on
// the returned channel.
func (r *oneShotRoute) post(ctx context.Context, body any) <-chan routeAnswer {
	answers := make(chan routeAnswer, 1)
	data, _ := json.Marshal(body)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(data))
		if err != nil {
			answers <- routeAnswer{err: err}
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			answers <- routeAnswer{err: err}
			return
		}
		defer resp.Body.Close()
		text, err := io.ReadAll(resp.Body)
		answers <- routeAnswer{status: resp.StatusCode, body: string(text), err: err}
	}()
	return answers
}

// connectEngine dials an engine and waits until the server counts it.
func (r *oneShotRoute) connectEngine(t *testing.T) *websocket.Conn {
	t.Helper()
	conn := dialEngine(t, r.engineTS)
	if !waitUntil(oneShotRouteBudget, r.s.IsEngineConnected) {
		t.Fatal("the engine never registered")
	}
	return conn
}

// awaitRunFrame reads the engine's socket until the run-one-shot frame arrives.
func awaitRunFrame(t *testing.T, conn *websocket.Conn) runOneShotFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(oneShotRouteBudget))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("the engine was never asked to run: %v", err)
		}
		var f runOneShotFrame
		if json.Unmarshal(data, &f) == nil && f.Type == frameRunOneShot {
			return f
		}
	}
}

func awaitResponse(t *testing.T, answers <-chan routeAnswer) (int, string) {
	t.Helper()
	select {
	case a := <-answers:
		if a.err != nil {
			t.Fatalf("POST /api/one-shot: %v", a.err)
		}
		return a.status, a.body
	case <-time.After(oneShotRouteBudget):
		t.Fatal("POST /api/one-shot never answered")
	}
	return 0, ""
}

func decodeResult(t *testing.T, body string) OneShotResult {
	t.Helper()
	var res OneShotResult
	if err := json.Unmarshal([]byte(body), &res); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return res
}

func TestOneShotRouteAnswersWithTheEnginesResult(t *testing.T) {
	r := newOneShotRoute(t)
	conn := r.connectEngine(t)

	answers := r.post(context.Background(), OneShotRequest{
		Prompt: "fix it", StrategyID: "yolo", Name: "Run 1", TimeoutMs: 90_000,
	})
	frame := awaitRunFrame(t, conn)
	if frame.Prompt != "fix it" || frame.StrategyID != "yolo" || frame.Name != "Run 1" || frame.TimeoutMs != 90_000 {
		t.Fatalf("the engine was asked %+v, want the request as posted", frame)
	}
	if err := conn.WriteJSON(map[string]any{
		"type": frameOneShotResult, "requestId": frame.RequestID, "status": OneShotParked,
		"conversationId": "conv_1", "turns": 2, "finalText": "nearly", "parkedTool": "ask",
	}); err != nil {
		t.Fatalf("answer as the engine: %v", err)
	}

	code, body := awaitResponse(t, answers)
	if code != http.StatusOK {
		t.Fatalf("status %d: %s", code, body)
	}
	got := decodeResult(t, body)
	if got.Status != OneShotParked || got.ConversationID != "conv_1" || got.Turns != 2 || got.FinalText != "nearly" || got.ParkedTool != "ask" {
		t.Fatalf("answered %+v, want the engine's result", got)
	}
}

// A run can arrive before the child's engine has: a freshly spawned child
// reports its address as soon as it is bound, well before its engine connects.
// The route waits for the engine rather than refusing the run.
func TestOneShotRouteWaitsForTheEngineToConnect(t *testing.T) {
	r := newOneShotRoute(t)

	answers := r.post(context.Background(), OneShotRequest{Prompt: "hi", StrategyID: "yolo", Name: "Run 2"})
	<-r.entered
	conn := r.connectEngine(t)
	frame := awaitRunFrame(t, conn)
	_ = conn.WriteJSON(map[string]any{"type": frameOneShotResult, "requestId": frame.RequestID, "status": OneShotCompleted})

	code, body := awaitResponse(t, answers)
	if got := decodeResult(t, body); code != http.StatusOK || got.Status != OneShotCompleted {
		t.Fatalf("status %d, result %+v; want the run carried out once the engine came", code, got)
	}
}

// The caller owns the clock: when it gives up, the route lets go of the run at
// once, so an answer arriving later goes nowhere and the next run is not
// refused as a second one in flight.
func TestOneShotRouteLetsGoOfARunItsCallerAbandoned(t *testing.T) {
	r := newOneShotRoute(t)
	conn := r.connectEngine(t)

	ctx, cancel := context.WithCancel(context.Background())
	_ = r.post(ctx, OneShotRequest{Prompt: "hi", StrategyID: "yolo", Name: "Run 3"})
	awaitRunFrame(t, conn)
	cancel()

	select {
	case <-r.returned:
	case <-time.After(oneShotRouteBudget):
		t.Fatal("the route kept waiting for a run whose caller had gone")
	}
	if _, err := r.s.oneShot.arm("run_next"); err != nil {
		t.Fatalf("an abandoned run was left armed: %v", err)
	}
}

// A caller that goes while the route is still waiting for the engine is let go
// too, rather than leaving a request parked on an engine that may never come.
func TestOneShotRouteStopsWaitingForTheEngineWhenItsCallerGoes(t *testing.T) {
	r := newOneShotRoute(t)

	ctx, cancel := context.WithCancel(context.Background())
	_ = r.post(ctx, OneShotRequest{Prompt: "hi", StrategyID: "yolo", Name: "Run 4"})
	<-r.entered
	cancel()

	select {
	case <-r.returned:
	case <-time.After(oneShotRouteBudget):
		t.Fatal("the route kept waiting for an engine after its caller had gone")
	}
}

func TestOneShotRouteReportsAServerShuttingDown(t *testing.T) {
	r := newOneShotRoute(t)

	answers := r.post(context.Background(), OneShotRequest{Prompt: "hi", StrategyID: "yolo", Name: "Run 5"})
	<-r.entered
	close(r.s.shutdownChan)

	code, body := awaitResponse(t, answers)
	got := decodeResult(t, body)
	if code != http.StatusOK || got.Status != OneShotFailed || got.ErrorText == "" {
		t.Fatalf("status %d, result %+v; want a failed run that says why", code, got)
	}
}

func TestOneShotRouteRefusesARequestWithNothingToRun(t *testing.T) {
	r := newOneShotRoute(t)
	for _, body := range []string{`{}`, `{"prompt":"   "}`, `not json`} {
		resp, err := http.Post(r.url, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST %s: %v", body, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s: status %d, want 400", body, resp.StatusCode)
		}
	}
}
