//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// newTestServerStateWithProject is newTestServerState plus a real
// SessionManager rooted at a temp dir, and the project path beside it as
// seedProjectState records it, so processShellRequest (which resolves the
// project as the command's tree) has a valid project.
func newTestServerStateWithProject(t *testing.T) *Server {
	t.Helper()
	s := &Server{wsFleet: wsFleet{hub: newClientHub()}}
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s.projectState.Store(&projectState{projectPath: mgr.GetProjectPath(), sessionManager: mgr, viewers: newViewerGroup()})
	return s
}

// elsewhere is a Workspace that is not on this machine: it has no LocalDir, and
// runs its streaming shell itself. Only what the server's callers use is
// answered; the embedded nil interface panics on anything else, which a test
// would report as a caller reaching for more than it should.
type elsewhere struct {
	workspace.Workspace
	shellRan *workspace.ShellRequest
}

func (e *elsewhere) ID() string               { return "ws_far" }
func (e *elsewhere) Name() string             { return "far-tree" }
func (e *elsewhere) LocalDir() (string, bool) { return "", false }

func (e *elsewhere) StreamShell(_ context.Context, req workspace.ShellRequest, out chan<- ops.ShellStreamChunk) {
	e.shellRan = &req
	out <- ops.ShellStreamChunk{ShellID: req.ShellID, Data: "ran over there", Done: true}
	close(out)
}

// resolveOnly answers one id with one workspace and refuses every other.
func resolveOnly(id string, ws workspace.Workspace) workspace.ResolveFunc {
	return func(asked string) (workspace.Workspace, error) {
		if asked == id {
			return ws, nil
		}
		return nil, errors.New("unknown workspace: " + asked)
	}
}

// A streaming command runs wherever its workspace runs commands — the
// workspace's own StreamShell, never a process the server starts here in a root
// it read off the row — and one whose workspace cannot be resolved is refused in
// the shape the engine is waiting for.
func TestStreamShell_RunsInTheResolvedWorkspace(t *testing.T) {
	s := newTestServerStateWithProject(t)
	far := &elsewhere{}
	engine := testWSClient("engine")

	s.streamShell(context.Background(), resolveOnly("ws_far", far), ShellStartRequest{
		ShellID: "sh-far", ConvId: "conv", Command: "make test", Cwd: "sub", Timeout: 1234, WorkspaceID: "ws_far",
	}, engine)
	if far.shellRan == nil {
		t.Fatal("the workspace never ran the command")
	}
	if want := (workspace.ShellRequest{ShellID: "sh-far", ConvID: "conv", Command: "make test", Cwd: "sub", TimeoutMs: 1234}); *far.shellRan != want {
		t.Errorf("the workspace ran %+v, want %+v", *far.shellRan, want)
	}
	if msg := nextShellOutput(t, engine); msg["data"] != "ran over there" || msg["done"] != true {
		t.Errorf("the engine received %+v, want the workspace's own output", msg)
	}

	s.streamShell(context.Background(), resolveOnly("ws_far", far), ShellStartRequest{
		ShellID: "sh-lost", Command: "echo hi", WorkspaceID: "ws_gone",
	}, engine)
	if msg := nextShellOutput(t, engine); msg["done"] != true || !strings.Contains(fmt.Sprint(msg["error"]), "unknown workspace: ws_gone") {
		t.Errorf("an unresolvable workspace ended %+v, want a done chunk carrying the refusal", msg)
	}
}

// nextShellOutput is the next shell-output message the client was sent.
func nextShellOutput(t *testing.T, c *WSClient) map[string]any {
	t.Helper()
	select {
	case msg := <-c.send:
		m, _ := msg.json.(map[string]any)
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("no shell-output arrived")
		return nil
	}
}

// awaitShellDone drains a test WSClient's send channel looking for the
// shell-output `done` chunk for shellID. processShellRequest enqueues every
// chunk before returning, so this only ever blocks on the (generous) deadline
// when the chunk genuinely never arrives.
func awaitShellDone(t *testing.T, c *WSClient, shellID string) bool {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case msg := <-c.send:
			m, ok := msg.json.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "shell-output" && m["shellId"] == shellID && m["done"] == true {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// TestProcessShellRequest_DeliversToRequesterNotViewerGroup is the regression
// guard for the bash-wedge bug. shell-output is consumed solely by the engine's
// shellExecuteStreaming, which resolves the bash tool on the `done` chunk. The
// chunk must reach the client that REQUESTED the shell — not the project's
// viewer group — because the persistent engine is not a reliable viewer-group
// member (it never reloads to re-join after a SwitchProject).
func TestProcessShellRequest_DeliversToRequesterNotViewerGroup(t *testing.T) {
	s := newTestServerStateWithProject(t)

	// The requester (engine) is deliberately NOT a viewer-group member.
	engine := testWSClient("engine")

	// A viewer IS in the group — proves we are routing to the requester, not
	// broadcasting to the group.
	viewer := testWSClient("viewer")
	s.joinViewerGroup(viewer)

	complete := make(chan string, 1)
	s.processShellRequest(context.Background(),
		ShellStartRequest{ShellID: "sh-test", Command: "echo hi"}, engine, complete)

	if !awaitShellDone(t, engine, "sh-test") {
		t.Fatal("engine requester never received shell-output done chunk")
	}

	// The viewer-group member must NOT receive shell-output (it is no longer on
	// the shell path; live output rides the separate engine-bridge channel).
	select {
	case msg := <-viewer.send:
		t.Fatalf("viewer-group member unexpectedly received a message on the shell path: %+v", msg)
	default:
	}
}

// TestProcessShellRequest_SurvivesViewerGroupSwap reproduces the exact failure:
// the engine joined the original project's viewer group, then a SwitchProject
// replaced that group with a fresh one (and stopped the old one) without the
// engine re-joining. bash must still complete. Under the old viewer-group
// broadcast this stranded the engine (output went to the new group, which the
// engine was never in); read/grep over HTTP and worker-messages were unaffected,
// so only bash wedged.
func TestProcessShellRequest_SurvivesViewerGroupSwap(t *testing.T) {
	s := newTestServerStateWithProject(t)

	engine := testWSClient("engine")
	s.joinViewerGroup(engine) // engine joined the ORIGINAL group

	// Simulate SwitchProject: a brand-new viewer group replaces the old one,
	// the old one is stopped, and the persistent engine never re-joins.
	old := s.projectState.Load()
	newMgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(newMgr.Shutdown)
	s.projectState.Store(&projectState{sessionManager: newMgr, viewers: newViewerGroup()})
	old.viewers.stop()

	complete := make(chan string, 1)
	s.processShellRequest(context.Background(),
		ShellStartRequest{ShellID: "sh2", Command: "echo hi"}, engine, complete)

	if !awaitShellDone(t, engine, "sh2") {
		t.Fatal("engine never received shell-output after viewer-group swap (bash-wedge regression)")
	}
}
