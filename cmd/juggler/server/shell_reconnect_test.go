//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/worker"
)

// shellReconnectBudget bounds each wait in these tests. Every one of them is
// for something the server does on its own once the engine is back, so the
// budget only decides how long a broken server takes to fail the test.
const shellReconnectBudget = 30 * time.Second

// newShellSocketServer is newEngineSocketServer with a project, so a shell the
// engine starts has a tree to run in.
func newShellSocketServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := newTestServerStateWithProject(t)
	s.workerManager = worker.NewManager()
	s.upgrader = websocket.Upgrader{}
	s.apiToken = testSocketToken
	ts := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	t.Cleanup(ts.Close)
	return s, ts
}

// shellFrames reads conn on its own goroutine and hands over every
// shell-output frame for shellID, until the connection ends.
func shellFrames(conn *websocket.Conn, shellID string) <-chan map[string]any {
	out := make(chan map[string]any, 64)
	go func() {
		defer close(out)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			if m["type"] == "shell-output" && m["shellId"] == shellID {
				out <- m
			}
		}
	}()
	return out
}

// An eviction, or any other loss of the engine's socket, closes a connection
// whose realm is still running and comes straight back: the bash tool is still
// awaiting its command on the far side. So the command outlives the connection
// that started it, and how it ended reaches the engine on the connection it has
// now. Killing it with the socket killed a build every time a busy machine
// starved the engine for half a minute, and the cancellation was sent to the
// dead socket, so the tool waited out its twenty-minute safety net instead.
func TestEngineShell_OutlivesTheConnectionThatStartedIt(t *testing.T) {
	s, ts := newShellSocketServer(t)
	const shellID = "sh-outlives"

	first := dialEngine(t, ts)
	firstFrames := shellFrames(first, shellID)
	// The command waits for a file the test writes only once the engine is back,
	// so it is certainly still running across the whole gap, however slow the
	// machine, and it never waits on a clock.
	release := t.TempDir() + "/release"
	if err := first.WriteJSON(ShellStartRequest{
		Type:    frameShellStart,
		ShellID: shellID,
		Command: "echo started; while [ ! -e '" + release + "' ]; do sleep 0.05; done; echo survived",
	}); err != nil {
		t.Fatalf("send shell-start: %v", err)
	}
	if !awaitShellData(firstFrames, "started") {
		t.Fatal("the shell never started on the first connection")
	}

	// Exactly what evictSilentEngine does to the connection.
	evicted := s.engineClient.Load()
	if evicted == nil {
		t.Fatal("no engine registered")
	}
	evicted.Close()
	if !waitUntil(shellReconnectBudget, func() bool { return s.engineClient.Load() == nil }) {
		t.Fatal("the evicted engine was never cleared")
	}

	second := dialEngine(t, ts)
	secondFrames := shellFrames(second, shellID)
	if !waitUntil(shellReconnectBudget, func() bool { return s.engineClient.Load() != nil }) {
		t.Fatal("the reconnected engine never registered")
	}
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatalf("release the command: %v", err)
	}

	done, output := awaitShellDoneFrame(secondFrames)
	if done == nil {
		t.Fatalf("the reconnected engine never heard how the command ended (output it did get: %q)", output)
	}
	if done["error"] != nil || done["exitCode"] != float64(0) {
		t.Fatalf("the command ended %+v, want a clean exit: it was killed with the connection that started it", done)
	}
	if !strings.Contains(output, "survived") {
		t.Errorf("the reconnected engine got %q, want the command's output after the gap", output)
	}
	// Completion is recorded wherever it lands, so nothing is left registered
	// for a cancel to find.
	if !waitUntil(shellReconnectBudget, func() bool { return !s.viewerCancelShell(shellID) }) {
		t.Error("the finished shell is still registered as running")
	}
}

// A command that ends while no engine is attached at all keeps how it ended
// until one is: the done chunk is the only word its bash tool will ever get.
func TestEngineShell_EndingWithNoEngineIsHeldForTheNextOne(t *testing.T) {
	s, ts := newShellSocketServer(t)
	const shellID = "sh-held"

	first := dialEngine(t, ts)
	firstFrames := shellFrames(first, shellID)
	dir := t.TempDir()
	release, ended := dir+"/release", dir+"/ended"
	if err := first.WriteJSON(ShellStartRequest{
		Type:    frameShellStart,
		ShellID: shellID,
		Command: "echo started; while [ ! -e '" + release + "' ]; do sleep 0.05; done; echo in-the-gap; touch '" + ended + "'",
	}); err != nil {
		t.Fatalf("send shell-start: %v", err)
	}
	if !awaitShellData(firstFrames, "started") {
		t.Fatal("the shell never started on the first connection")
	}

	s.engineClient.Load().Close()
	if !waitUntil(shellReconnectBudget, func() bool { return s.engineClient.Load() == nil }) {
		t.Fatal("the evicted engine was never cleared")
	}
	// Let the command finish with nobody to tell.
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatalf("release the command: %v", err)
	}
	if !waitUntil(shellReconnectBudget, func() bool { _, err := os.Stat(ended); return err == nil }) {
		t.Fatal("the command never finished")
	}

	second := dialEngine(t, ts)
	done, output := awaitShellDoneFrame(shellFrames(second, shellID))
	if done == nil {
		t.Fatalf("the next engine never heard how the command ended (output it did get: %q)", output)
	}
	if done["error"] != nil || done["exitCode"] != float64(0) {
		t.Fatalf("the command ended %+v, want a clean exit", done)
	}
	if !strings.Contains(output, "in-the-gap") {
		t.Errorf("the next engine got %q, want the output written while no engine was attached", output)
	}
}

// awaitShellData waits for a chunk whose data contains want.
func awaitShellData(frames <-chan map[string]any, want string) bool {
	deadline := time.After(shellReconnectBudget)
	for {
		select {
		case m, ok := <-frames:
			if !ok {
				return false
			}
			if d, _ := m["data"].(string); strings.Contains(d, want) {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// awaitShellDoneFrame collects data until the done chunk, and returns that
// chunk with everything that arrived; nil when none came.
func awaitShellDoneFrame(frames <-chan map[string]any) (map[string]any, string) {
	var output strings.Builder
	deadline := time.After(shellReconnectBudget)
	for {
		select {
		case m, ok := <-frames:
			if !ok {
				return nil, output.String()
			}
			if d, _ := m["data"].(string); d != "" {
				output.WriteString(d)
			}
			if m["done"] == true {
				return m, output.String()
			}
		case <-deadline:
			return nil, output.String()
		}
	}
}
