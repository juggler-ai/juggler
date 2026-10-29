//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// The frames the server sends its clients, one struct per shape. A frame type
// whose senders build it two ways has a struct for each, so neither carries a
// key the other never sent; TestFramesKeepTheirShape pins each against the JSON
// its site sent before it was typed. Frames relayed whole (engine-bridge,
// worker-message) are bytes another client wrote and have no struct here.

// bareFrame is a frame that is its type and nothing else (session-changed,
// heartbeat).
type bareFrame struct {
	Type frameType `json:"type"`
}

// messageFrame carries an English message the client shows as it is
// (server-shutdown, server-full).
type messageFrame struct {
	Type    frameType `json:"type"`
	Message string    `json:"message"`
}

// textFrame carries a message as English and as the message itself, for the
// client to show translated (notice, and the error a client is sent for a
// conversation the server declined to open).
type textFrame struct {
	Type    frameType   `json:"type"`
	Message string      `json:"message"`
	Text    msg.Message `json:"text"`
}

// sessionFrame is the first frame a client admitted to the socket is sent: its
// own server-assigned id, its viewer id as the server accepted it (empty when
// it sent none usable), and this server instance's boot id.
type sessionFrame struct {
	Type     frameType `json:"type"`
	ClientID string    `json:"clientId"`
	ViewerID string    `json:"viewerId"`
	BootID   string    `json:"bootId"`
}

// viewerRelayFrame delivers one viewer's message to another. From is the
// sending connection's own viewer id; the payload is opaque to the server.
type viewerRelayFrame struct {
	Type    frameType       `json:"type"`
	From    string          `json:"from"`
	Payload json.RawMessage `json:"payload"`
}

type clientsChangedFrame struct {
	Type    frameType          `json:"type"`
	Count   int                `json:"count"`
	Clients []clientDescriptor `json:"clients"`
}

type sessionMetadataChangedFrame struct {
	Type     frameType      `json:"type"`
	Metadata map[string]any `json:"metadata"`
}

type workspacesChangedFrame struct {
	Type       frameType       `json:"type"`
	Workspaces []workspace.Row `json:"workspaces"`
}

// processesChangedFrame is the whole of the project's process inventory: every
// shell process running for any conversation in it (ops.ListProcesses).
type processesChangedFrame struct {
	Type      frameType         `json:"type"`
	Processes []ops.ProcessInfo `json:"processes"`
}

type pinboardChangedFrame struct {
	Type  frameType  `json:"type"`
	Board string     `json:"board"`
	Pins  []core.Pin `json:"pins"`
}

// pinboardRevealFrame names the conversation that asked (from) only when one
// did; an unattributed reveal is one every viewer follows.
type pinboardRevealFrame struct {
	Type  frameType `json:"type"`
	Board string    `json:"board"`
	Pin   string    `json:"pin"`
	From  string    `json:"from,omitempty"`
}

// conversationsChangedFrame is one op on the conversation list. name rides only
// the ops that set one (created, renamed, restored); from only an attributed
// focus.
type conversationsChangedFrame struct {
	Type frameType `json:"type"`
	Op   string    `json:"op"`
	ID   string    `json:"id"`
	Name string    `json:"name,omitempty"`
	From string    `json:"from,omitempty"`
}

// conversationsReorderedFrame is the reordered op, which carries the whole new
// order instead of one id.
type conversationsReorderedFrame struct {
	Type  frameType `json:"type"`
	Op    string    `json:"op"` // "reordered"
	Order []string  `json:"order"`
}

type providersUpdateFrame struct {
	Type      frameType        `json:"type"`
	Providers []ProviderStatus `json:"providers"`
	Ready     bool             `json:"ready"`
}

type fileChangeFrame struct {
	Type    frameType         `json:"type"`
	Changes []core.FileChange `json:"changes"`
}

type pluginChangedFrame struct {
	Type frameType `json:"type"`
	Path string    `json:"path"`
}

type settingsChangedFrame struct {
	Type     frameType           `json:"type"`
	Settings core.GlobalSettings `json:"settings"`
}

type runOneShotFrame struct {
	Type       frameType `json:"type"`
	RequestID  string    `json:"requestId"`
	Prompt     string    `json:"prompt"`
	StrategyID string    `json:"strategyId"`
	Name       string    `json:"name"`
	TimeoutMs  int64     `json:"timeoutMs"`
}

// shellOutputFrame is one chunk of a streaming shell command, or its refusal.
// Which keys it carries depends on the chunk, and the pointers are what say so:
// status (and hint) only on a status chunk; exitCode on every done chunk, 0
// included; the spill fields only when the output was spilled. Build it with
// shellOutputFrameOf or shellRefusedFrame.
type shellOutputFrame struct {
	Type        frameType `json:"type"`
	ShellID     string    `json:"shellId"`
	Data        *string   `json:"data,omitempty"`
	Done        bool      `json:"done"`
	Status      string    `json:"status,omitempty"`
	Hint        string    `json:"hint,omitempty"`
	ExitCode    *int      `json:"exitCode,omitempty"`
	Error       string    `json:"error,omitempty"`
	OutputFile  string    `json:"outputFile,omitempty"`
	OutputBytes *int64    `json:"outputBytes,omitempty"`
	Truncated   *bool     `json:"truncated,omitempty"`
}

// shellOutputFrameOf is the frame for one streamed chunk.
func shellOutputFrameOf(chunk ops.ShellStreamChunk) shellOutputFrame {
	f := shellOutputFrame{Type: frameShellOutput, ShellID: chunk.ShellID, Data: &chunk.Data, Done: chunk.Done}
	if chunk.Status != "" {
		f.Status, f.Hint = chunk.Status, chunk.Hint
	}
	if chunk.Done {
		f.ExitCode = &chunk.ExitCode
		f.Error = chunk.Error
		if chunk.OutputFile != "" {
			f.OutputFile = chunk.OutputFile
			f.OutputBytes, f.Truncated = &chunk.OutputBytes, &chunk.Truncated
		}
	}
	return f
}

// shellRefusedFrame settles a shell the server would not start: a done chunk
// carrying the reason, the shape the requester is waiting for.
func shellRefusedFrame(shellID, reason string) shellOutputFrame {
	return shellOutputFrame{Type: frameShellOutput, ShellID: shellID, Done: true, Error: reason}
}
