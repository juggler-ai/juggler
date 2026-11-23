//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// Who may call what. The agent's tool calls come in by /api/ops/call and the
// user's client by /api/ops/client; a ClientOnly tool is refused at the first,
// and only an AnyTree tool called at the second may run in a tree no workspace
// names. These are the gates that keep the agent out of the git client's
// writes and out of the worktrees only the git client shows.

// whereOps answers with the workspace it was built in.
type whereOps struct{ scope ops.PathScope }

func (o whereOps) Execute(context.Context, string, map[string]any) (any, error) {
	return o.scope.Workspace(), nil
}

// callersAPI is an API with an ordinary tool, a ClientOnly one and an AnyTree
// one, over a project and a wider resolver that also names "wt:far", a tree no
// workspace does.
func callersAPI() *OpsAPI {
	table := ops.NewTable()
	where := func(scope ops.PathScope) ops.Operations { return whereOps{scope} }
	table.Register("callers-ordinary", ops.Registration{Factory: where})
	table.Register("callers-client", ops.Registration{Factory: where, ClientOnly: true})
	table.Register("callers-anytree", ops.Registration{Factory: where, ClientOnly: true, AnyTree: true})
	project := &scripted{root: nowhere + "/project", build: true}
	far := &scripted{id: "wt:far", root: nowhere + "/far", build: true}
	resolve := func(id string) (workspace.Workspace, error) {
		if id == "" {
			return project, nil
		}
		return nil, errors.New("unknown workspace: " + id)
	}
	wider := func(id string) (workspace.Workspace, error) {
		if id == far.id {
			return far, nil
		}
		return resolve(id)
	}
	return NewOpsAPI(resolve).WithTable(table).WithClientTrees(wider)
}

// call posts one request to an entry and returns what it answered.
func call(t *testing.T, entry http.HandlerFunc, toolID, workspaceID string) OperationResponse {
	t.Helper()
	body, _ := json.Marshal(OperationRequest{ToolID: toolID, Operation: "where", WorkspaceID: workspaceID})
	rec := httptest.NewRecorder()
	entry(rec, httptest.NewRequest(http.MethodPost, "/api/ops/x", bytes.NewReader(body)))
	var resp OperationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s in %q: %v\n%s", toolID, workspaceID, err, rec.Body.String())
	}
	return resp
}

func TestOpsAgentEntryRefusesClientOnlyToolsAndWiderTrees(t *testing.T) {
	api := callersAPI()
	for _, tc := range []struct{ tool, ws string }{
		{"callers-client", ""},
		{"callers-anytree", ""},
		{"callers-anytree", "wt:far"},
		{"callers-ordinary", "wt:far"},
	} {
		if resp := call(t, api.HandleOperationCall, tc.tool, tc.ws); resp.Success {
			t.Errorf("the agent's entry ran %s in %q (answered %v); it must refuse", tc.tool, tc.ws, resp.Data)
		}
	}
	if resp := call(t, api.HandleOperationCall, "callers-ordinary", ""); !resp.Success {
		t.Errorf("the agent's entry refused an ordinary tool: %s", resp.Error)
	}
}

func TestOpsClientEntryReachesWiderTreesOnlyForAnyTreeTools(t *testing.T) {
	api := callersAPI()
	for _, tc := range []struct{ tool, ws string }{
		{"callers-ordinary", ""},
		{"callers-client", ""},
		{"callers-anytree", ""},
		{"callers-anytree", "wt:far"},
	} {
		if resp := call(t, api.HandleClientCall, tc.tool, tc.ws); !resp.Success || resp.Data != tc.ws {
			t.Errorf("the client's entry, %s in %q = %+v; want it run there", tc.tool, tc.ws, resp)
		}
	}
	for _, tool := range []string{"callers-ordinary", "callers-client"} {
		if resp := call(t, api.HandleClientCall, tool, "wt:far"); resp.Success {
			t.Errorf("the client's entry ran %s, which is not AnyTree, in a tree no workspace names", tool)
		}
	}
}
