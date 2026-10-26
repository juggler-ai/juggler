//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "encoding/json"

// ToolDefinition represents a tool that the LLM can use
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`       // Raw JSON schema
	Category    string          `json:"category,omitempty"` // Tool category: "read", "write", "meta"
}

// ViewerFault is an uncaught fault reported by a viewer page.
//
// A viewer runs in a window whose console cannot be opened in a release build,
// so without this a fault in the UI leaves no trace anywhere: the page renders
// something wrong, or stops rendering, and the log it would be diagnosed from
// records a server that did its job. The engine reports its own faults the same
// way (see engine-worker-runtime.js); this is the viewer's half.
type ViewerFault struct {
	Type    frameType `json:"type"`             // "viewer-fault"
	Source  string    `json:"source"`           // What was running, e.g. "observe:tool-action-message"
	Message string    `json:"message"`          // The error's message
	Stack   string    `json:"stack,omitempty"`  // Stack trace, when the throw carried one
	ConvID  string    `json:"convId,omitempty"` // Conversation it happened under, when known
	Detail  string    `json:"detail,omitempty"` // Anything else that narrows it down
}

// ShellStartRequest represents a request to start a streaming shell command
type ShellStartRequest struct {
	Type        frameType `json:"type"`                  // "shell-start"
	ShellID     string    `json:"shellId"`               // Unique ID for this shell execution
	ConvId      string    `json:"convId,omitempty"`      // Conversation that owns this shell (spill-file bucket)
	ThreadId    string    `json:"threadId,omitempty"`    // Thread within it that ran the tool call; empty is the root thread
	ToolUseId   string    `json:"toolUseId,omitempty"`   // Tool call that started it, so the process list can lead back to it
	Command     string    `json:"command"`               // Shell command to execute
	Cwd         string    `json:"cwd,omitempty"`         // Working directory
	Timeout     int       `json:"timeout,omitempty"`     // Timeout in milliseconds
	WorkspaceID string    `json:"workspaceId,omitempty"` // Where to run it; empty is the project, as every shell meant before workspaces existed
}

// ShellCancelRequest represents a request to cancel a running shell command
type ShellCancelRequest struct {
	Type    frameType `json:"type"`    // "shell-cancel"
	ShellID string    `json:"shellId"` // ID of shell to cancel
}

// ViewerRelay is one viewer addressing another by viewer id.
//
// The server routes it and reads nothing inside it: the payload is opaque and
// travels verbatim, so what two viewers say to each other stays between them and
// needs no server-side release to change. What the server does supply is the
// sender — the relay it delivers carries the sending connection's own viewer id
// as `from`, never a value taken from the message, so a viewer cannot claim to
// be another one. Nothing is persisted and nothing is queued for a viewer that
// is not connected; a relay to an absent or unknown id is dropped.
type ViewerRelay struct {
	Type    frameType       `json:"type"`    // "viewer-relay"
	To      string          `json:"to"`      // Viewer id to deliver to
	Payload json.RawMessage `json:"payload"` // Opaque to the server
}

// GenericWSMessage is used to determine message type before parsing
type GenericWSMessage struct {
	Type string `json:"type,omitempty"`
	// WorkerMsgType is the inner type carried by a "worker-message" envelope
	// (worker.WorkerMessage). Probed here so a routing decision that depends on
	// which worker message this is can be made before the envelope is parsed;
	// empty for every other message type.
	WorkerMsgType string `json:"workerMsgType,omitempty"`
}
