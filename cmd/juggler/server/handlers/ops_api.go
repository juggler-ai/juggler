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
// that error's Code and Detail beside it.
type OperationResponse struct {
	Success bool           `json:"success"`
	Data    any            `json:"data,omitempty"`
	Error   string         `json:"error,omitempty"`
	Code    string         `json:"code,omitempty"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// OpsAPI handles the unified native operations API. Each request's workspace
// is resolved afresh, so a runtime project switch retargets ops and a workspace
// registered a moment ago is reachable.
type OpsAPI struct {
	resolve workspace.ResolveFunc
	// Operation handlers are stateless and recreated per request.
}

// NewOpsAPI creates a new operations API handler. resolve turns a request's
// workspace id into the Workspace its operation runs in ("" is the project).
func NewOpsAPI(resolve workspace.ResolveFunc) *OpsAPI {
	return &OpsAPI{resolve: resolve}
}

// HandleOperationCall is the unified entry point for all native operations
func (api *OpsAPI) HandleOperationCall(w http.ResponseWriter, r *http.Request) {
	var req OperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, r, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Every operation belongs to a project, whichever workspace it runs in.
	if project, err := api.resolve(core.DefaultWorkspaceID); err != nil || project.Root() == "" {
		api.sendError(w, r, "no project loaded", http.StatusConflict)
		return
	}

	// Route to appropriate operation handler. r.Context() is cancelled when the
	// client aborts the request (browser aborts the op fetch on Escape), so
	// long-running ops can stop early instead of running to completion.
	result, err := api.routeOperation(r.Context(), req)
	if err != nil {
		// Return operation errors as success=false in the response body with HTTP 200
		// This allows the frontend to handle the error gracefully
		// HTTP 500 should only be for actual server failures (panics, crashes)
		api.sendOperationError(w, r, err)
		return
	}

	api.sendSuccess(w, r, result)
}

// routeOperation routes the operation to the handler for its tool, in the
// workspace it named. Handlers are stateless and built per request by the
// workspace, which decides the path boundary they are confined to — the same
// one a streaming shell in that workspace gets (Server.processShellRequest).
// A workspace that cannot be worked in refuses here, in the words
// core.WorkspaceLookup.Usable chose, so an operation and the CLI it belongs to
// can never disagree about it.
func (api *OpsAPI) routeOperation(ctx context.Context, req OperationRequest) (any, error) {
	ws, err := api.resolve(req.WorkspaceID)
	if err != nil {
		return nil, err
	}

	handler, err := ws.Operations(req.ToolID, req.AllowedPaths)
	if err != nil {
		return nil, fmt.Errorf("no operation handler registered for tool: %s", req.ToolID)
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
func (api *OpsAPI) sendError(w http.ResponseWriter, r *http.Request, message string, statusCode int) {
	WriteJSON(w, r, statusCode, OperationResponse{
		Success: false,
		Error:   message,
	})
}

// sendOperationError sends an operation error response (HTTP 200 with success=false)
// Operation errors like "search string not found" are not server errors. A
// coded error's code and detail travel beside its message.
func (api *OpsAPI) sendOperationError(w http.ResponseWriter, r *http.Request, err error) {
	resp := OperationResponse{Success: false, Error: err.Error()}
	var coded *ops.CodedError
	if errors.As(err, &coded) {
		resp.Code = coded.Code
		resp.Detail = coded.Detail
	}
	WriteJSON(w, r, http.StatusOK, resp)
}
