//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/gitview/gitviewtest"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/workspace"
)

// The git tool acts for the user. Through the server's own dispatcher, as New
// builds it, the agent's entry (/api/ops/call) refuses it outright, and only
// the client's entry (/api/ops/client) runs it — in a workspace, or in a
// worktree no workspace names, which nothing at the agent's entry resolves.
func TestGitToolIsTheClientsAlone(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitviewtest.LendClocks(time.Minute, 5*time.Minute))

	s := newTestServerStateWithProject(t)
	project := s.ProjectPath()
	gitIn(t, project, "init", "-q")
	gitIn(t, project, "config", "user.email", "test@example.com")
	gitIn(t, project, "config", "user.name", "Juggler Test")
	gitIn(t, project, "commit", "-q", "--allow-empty", "-m", "init")
	linked := filepath.Join(t.TempDir(), "linked")
	gitIn(t, project, "worktree", "add", "-q", "-b", "side", linked)
	wt := workspace.WorktreeID("", "", linked)
	ops.Register("callers-probe", func(scope ops.PathScope) ops.Operations { return probeOps{} })
	api := s.newOpsAPI()

	ask := func(entry http.HandlerFunc, tool, op, ws string, params map[string]any) handlers.OperationResponse {
		t.Helper()
		body, _ := json.Marshal(handlers.OperationRequest{ToolID: tool, Operation: op, Params: params, WorkspaceID: ws})
		rec := httptest.NewRecorder()
		entry(rec, httptest.NewRequest(http.MethodPost, "/api/ops/x", bytes.NewReader(body)).WithContext(t.Context()))
		var resp handlers.OperationResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("%s/%s in %q: %v\n%s", tool, op, ws, err, rec.Body.String())
		}
		return resp
	}
	changes := map[string]any{"kind": "changes"}
	run := map[string]any{"op": map[string]any{"kind": "stage", "paths": []string{"x"}}}

	for _, tc := range []struct {
		op     string
		ws     string
		params map[string]any
	}{
		{"status", "", nil},
		{"read", "", changes},
		{"run", "", run},
		{"read", wt, changes},
		{"run", wt, run},
	} {
		if resp := ask(api.HandleOperationCall, gitToolID, tc.op, tc.ws, tc.params); resp.Success {
			t.Errorf("the agent's entry ran git %s in %q: %+v", tc.op, tc.ws, resp.Data)
		}
	}
	if resp := ask(api.HandleOperationCall, "callers-probe", "x", wt, nil); resp.Success {
		t.Errorf("the agent's entry resolved a worktree no workspace names")
	}
	if resp := ask(api.HandleClientCall, "callers-probe", "x", wt, nil); resp.Success {
		t.Errorf("the client's entry ran a tool that is not AnyTree in a worktree no workspace names")
	}

	if resp := ask(api.HandleClientCall, gitToolID, "status", "", nil); !resp.Success {
		t.Errorf("the client's entry refused git status: %s", resp.Error)
	}
	resp := ask(api.HandleClientCall, gitToolID, "read", wt, changes)
	raw, _ := json.Marshal(resp.Data)
	var got struct{ Branch string }
	if !resp.Success || json.Unmarshal(raw, &got) != nil || got.Branch != "side" {
		t.Errorf("the client's git read in the linked worktree = %+v, want its side branch", resp)
	}
	if resp := ask(api.HandleOperationCall, "callers-probe", "x", "", nil); !resp.Success {
		t.Errorf("the agent's entry refused an ordinary tool in the project: %s", resp.Error)
	}
}

// probeOps answers every operation.
type probeOps struct{}

func (probeOps) Execute(ctx context.Context, _ string, _ map[string]any) (any, error) {
	return "ran", ctx.Err()
}
