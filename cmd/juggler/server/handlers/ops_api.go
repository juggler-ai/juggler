//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"
)

// OperationRequest represents a request to perform a native operation.
// AllowedPaths carries the caller's standing allowed-paths grant at the request
// top level (NOT inside Params) so the path boundary is assembled once into a
// PathScope rather than re-extracted from the params map at each op callsite.
type OperationRequest struct {
	ToolID       string         `json:"toolId"`
	Operation    string         `json:"operation"`
	Params       map[string]any `json:"params"`
	AllowedPaths []string       `json:"allowedPaths,omitempty"`
	// ConversationID identifies the conversation whose tool this is, so the op
	// runs in that conversation's dedicated git worktree rather than the shared
	// project root (see core.ConvWorktrees). Empty ⇒ the base project root, so
	// non-git projects and callers that don't send it behave exactly as before.
	ConversationID string `json:"conversationId,omitempty"`
}

// OperationResponse represents the response from a native operation
type OperationResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// OpsAPI handles the unified native operations API. The project path is
// looked up via a provider func so runtime project switches retarget ops.
type OpsAPI struct {
	pathProvider func() string
	// remapperFor returns a path remapper for a conversation: a function that
	// redirects an already-validated real path into that conversation's
	// dedicated git worktree of whichever repo the path belongs to (see
	// core.ConvWorktrees). Returns nil (identity) when isolation doesn't apply.
	// remapperFor itself may be nil, in which case every op uses the shared
	// project path unchanged.
	remapperFor func(convID string) func(string) string
	// Operation handlers are stateless and recreated per request.
}

// NewOpsAPI creates a new operations API handler. pathProvider must return the
// current project path on each call. remapperFor supplies a conversation's
// per-repo worktree remapper (may be nil).
func NewOpsAPI(pathProvider func() string, remapperFor func(convID string) func(string) string) *OpsAPI {
	return &OpsAPI{pathProvider: pathProvider, remapperFor: remapperFor}
}

// HandleOperationCall is the unified entry point for all native operations
func (api *OpsAPI) HandleOperationCall(w http.ResponseWriter, r *http.Request) {
	var req OperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, r, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Get current project path (empty ⇒ no project loaded).
	projectPath := api.pathProvider()
	if projectPath == "" {
		api.sendError(w, r, "no project loaded", http.StatusConflict)
		return
	}

	// Build this conversation's per-repo worktree remapper. The scope stays
	// rooted at the REAL project (so containment/authorization are unchanged),
	// and the remapper redirects each resolved path into the conversation's
	// worktree of the repo it belongs to — so a conversation touching several
	// repos gets each of them isolated. nil ⇒ no redirect.
	var remap func(string) string
	if api.remapperFor != nil && req.ConversationID != "" {
		remap = api.remapperFor(req.ConversationID)
	}

	// Route to appropriate operation handler. r.Context() is cancelled when the
	// client aborts the request (browser aborts the op fetch on Escape), so
	// long-running ops can stop early instead of running to completion.
	result, err := api.routeOperation(r.Context(), req.ToolID, req.Operation, req.Params, projectPath, req.AllowedPaths, remap)
	if err != nil {
		// Return operation errors as success=false in the response body with HTTP 200
		// This allows the frontend to handle the error gracefully
		// HTTP 500 should only be for actual server failures (panics, crashes)
		api.sendOperationError(w, r, err.Error())
		return
	}

	api.sendSuccess(w, r, result)
}

// routeOperation routes the operation to the appropriate handler based on tool ID
// Uses the operations registry for dynamic handler lookup
// Creates a new handler instance for each request with the session's project path
func (api *OpsAPI) routeOperation(ctx context.Context, toolID, operation string, params map[string]any, projectPath string, allowedPaths []string, remap func(string) string) (any, error) {
	// Get factory from registry
	factory, err := ops.GetGlobal(toolID)
	if err != nil {
		return nil, fmt.Errorf("no operation handler registered for tool: %s", toolID)
	}

	// Create handler instance bound to the request's path boundary: the
	// session's project path widened by the caller's allowed-paths grant, with
	// resolved paths redirected into the conversation's per-repo worktrees.
	// No caching - operations are stateless.
	scope := ops.NewPathScope(projectPath, allowedPaths).WithRemap(remap)
	handler := factory(scope)

	// Execute the operation
	result, err := handler.Execute(ctx, operation, params)
	if err != nil {
		// Log the error for debugging
		jlog.Error("[OpsAPI] Error executing %s/%s: %v", toolID, operation, err)
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
// Operation errors like "search string not found" are not server errors
func (api *OpsAPI) sendOperationError(w http.ResponseWriter, r *http.Request, message string) {
	WriteJSON(w, r, http.StatusOK, OperationResponse{
		Success: false,
		Error:   message,
	})
}
