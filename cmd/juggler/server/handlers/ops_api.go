//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
	"juggler/internal/jlog"
)

// OperationRequest represents a request to perform a native operation.
// AllowedPaths carries the caller's standing allowed-paths grant at the request
// top level (NOT inside Params) so the path boundary is assembled once into a
// PathScope rather than re-extracted from the params map at each op callsite.
//
// WorkspaceID rides at the top level for the same reason, and names WHERE the
// operation runs: empty is the project itself. It is an id rather than a root because the engine
// executes tool calls an LLM composed — an id only resolves to somewhere the
// user registered through the UI, where a raw root would let a prompt-injected
// model point its own scope anywhere.
type OperationRequest struct {
	ToolID       string         `json:"toolId"`
	Operation    string         `json:"operation"`
	Params       map[string]any `json:"params"`
	AllowedPaths []string       `json:"allowedPaths,omitempty"`
	WorkspaceID  string         `json:"workspaceId,omitempty"`
}

// OperationResponse represents the response from a native operation. A failure
// carries its message in Error and, when the op failed with an *ops.CodedError,
// that error's Code and Detail beside it. Error is always English — it is what
// a tool result tells the model — and Message, when the failure is a msg.Error
// (see ErrorMessage), is the same text for the UI to show translated.
type OperationResponse struct {
	Success bool           `json:"success"`
	Data    any            `json:"data,omitempty"`
	Error   string         `json:"error,omitempty"`
	Message *msg.Message   `json:"message,omitempty"`
	Code    string         `json:"code,omitempty"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// OpsAPI handles the unified native operations API. Each request's workspace
// is resolved afresh, so a workspace registered a moment ago is reachable.
//
// It has two entries, and which one a request came in by is the only thing it
// knows about the caller. POST /api/ops/call (HandleOperationCall) is the agent's
// tool calls' — the one every context item's ops reach, approved and recorded
// as the agent's — and the one through which an extension's ordinary use of a
// tool is made. POST /api/ops/client (HandleClientCall) is the user's client's:
// the extension services a pin, card or provider is given in the viewer
// (extension-services.js), acting for the user in the UI. Every gate between
// them is here, from the tool's ops.Registration:
//
//   - a ClientOnly tool is refused at the agent's entry, whatever it names;
//   - only an AnyTree tool, and only at the client's entry, resolves its
//     workspace id through the wider resolver (WithClientTrees) — the one
//     that names trees no workspace does. Every other call resolves through
//     the workspaces alone, so no tool the agent can call ever runs there.
type OpsAPI struct {
	resolve workspace.ResolveFunc
	// wider resolves an AnyTree tool's workspace id at the client's entry;
	// nil is resolve.
	wider workspace.ResolveFunc
	// table is the server's registrations over the process-wide ones; nil is
	// the process-wide ones alone.
	table *ops.Table
	// Operation handlers are stateless and recreated per request.
}

// caller is which entry a request came in by.
type caller int

const (
	callerAgent  caller = iota // POST /api/ops/call
	callerClient               // POST /api/ops/client
)

// NewOpsAPI creates a new operations API handler. resolve turns a request's
// workspace id into the Workspace its operation runs in ("" is the project).
func NewOpsAPI(resolve workspace.ResolveFunc) *OpsAPI {
	return &OpsAPI{resolve: resolve}
}

// WithTable has the API look tools up in table, the server's own
// registrations over the process-wide ones.
func (api *OpsAPI) WithTable(table *ops.Table) *OpsAPI {
	api.table = table
	return api
}

// WithClientTrees has an AnyTree tool called by the client resolve its
// workspace id through wider (see workspace.GitTrees.ResolveGit).
func (api *OpsAPI) WithClientTrees(wider workspace.ResolveFunc) *OpsAPI {
	api.wider = wider
	return api
}

// HandleOperationCall is the agent's entry point for native operations: every
// tool but a ClientOnly one, in a workspace.
func (api *OpsAPI) HandleOperationCall(w http.ResponseWriter, r *http.Request) {
	api.serve(w, r, callerAgent)
}

// HandleClientCall is the user's client's entry point: every tool, and an
// AnyTree tool in the trees the wider resolver names besides.
func (api *OpsAPI) HandleClientCall(w http.ResponseWriter, r *http.Request) {
	api.serve(w, r, callerClient)
}

// serve answers one operation request that came in by from.
func (api *OpsAPI) serve(w http.ResponseWriter, r *http.Request, from caller) {
	var req OperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, r, msg.New("Invalid request: {detail}", "detail", err.Error()), http.StatusBadRequest)
		return
	}

	// Every operation belongs to a project, whichever workspace it runs in.
	if project, err := api.resolve(core.DefaultWorkspaceID); err != nil || project.Root() == "" {
		m := msg.New("no project loaded")
		WriteJSON(w, r, http.StatusConflict, OperationResponse{Success: false, Error: m.English(), Message: &m, Code: ops.CodeNoProject})
		return
	}

	// Route to appropriate operation handler. r.Context() is cancelled when the
	// client aborts the request (browser aborts the op fetch on Escape), so
	// long-running ops can stop early instead of running to completion.
	result, err := api.route(r.Context(), from, req)
	if err != nil {
		// Return operation errors as success=false in the response body with HTTP 200
		// This allows the frontend to handle the error gracefully
		// HTTP 500 should only be for actual server failures (panics, crashes)
		api.sendOperationError(w, r, err)
		return
	}

	api.sendSuccess(w, r, result)
}

// route routes the operation to the handler for its tool, in the workspace it
// named, for a request that came in by from, gated by the tool's registration
// (see OpsAPI). Handlers are stateless and built per request by the
// workspace, which decides the path boundary they are confined to — the same
// one a streaming shell in that workspace gets (Server.processShellRequest).
// A workspace that cannot be worked in refuses here, in the words
// core.WorkspaceLookup.Usable chose, so an operation and the CLI it belongs to
// can never disagree about it.
func (api *OpsAPI) route(ctx context.Context, from caller, req OperationRequest) (any, error) {
	reg, err := api.table.Lookup(req.ToolID)
	if err != nil {
		return nil, fmt.Errorf("no operation handler registered for tool: %s", req.ToolID)
	}
	if reg.ClientOnly && from != callerClient {
		return nil, msg.NewError("{tool} acts for the user in the app, and is not one of the agent's tools.", "tool", req.ToolID)
	}
	resolve := api.resolve
	if reg.AnyTree && from == callerClient && api.wider != nil {
		resolve = api.wider
	}
	ws, err := resolve(req.WorkspaceID)
	if err != nil {
		return nil, err
	}

	handler, err := ws.Operations(reg, req.AllowedPaths)
	if err != nil {
		return nil, err
	}

	result, err := handler.Execute(ctx, req.Operation, req.Params)
	if err != nil {
		// Log the error for debugging
		jlog.Error("[OpsAPI] Error executing %s/%s: %v", req.ToolID, req.Operation, err)
	}

	return result, err
}

// sendSuccess sends a success response
func (api *OpsAPI) sendSuccess(w http.ResponseWriter, r *http.Request, data any) {
	WriteJSON(w, r, 0, OperationResponse{
		Success: true,
		Data:    data,
	})
}

// sendError sends an error response
func (api *OpsAPI) sendError(w http.ResponseWriter, r *http.Request, m msg.Message, statusCode int) {
	WriteJSON(w, r, statusCode, OperationResponse{
		Success: false,
		Error:   m.English(),
		Message: &m,
	})
}

// sendOperationError sends an operation error response (HTTP 200 with success=false)
// Operation errors like "search string not found" are not server errors. A
// coded error's code and detail travel beside its message.
func (api *OpsAPI) sendOperationError(w http.ResponseWriter, r *http.Request, err error) {
	resp := OperationResponse{Success: false, Error: err.Error(), Message: ErrorMessage(err)}
	var coded *ops.CodedError
	if errors.As(err, &coded) {
		resp.Code = coded.Code
		resp.Detail = coded.Detail
	}
	WriteJSON(w, r, http.StatusOK, resp)
}
