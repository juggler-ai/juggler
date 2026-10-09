//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import "encoding/json"

// StreamMessage represents a message in Claude CLI's stream-json output.
// Different message formats use different fields:
//   - type="system", subtype="init": session id, available tools, etc.
//   - type="system", subtype="result": Result as object with token counts
//   - type="result", subtype="success": Result as string, Usage at top level
//   - type="stream_event": fine-grained Anthropic API event (always on; we
//     pass --include-partial-messages).
//   - type="control_request": CLI asking us to do something (typically:
//     execute an MCP tools/call against our in-process MCP server). Routes
//     through the stdio control protocol — see control_protocol.go.
//   - type="control_response": CLI replying to a control_request we sent
//     (e.g. our initialize handshake).
//   - type="control_cancel_request": CLI cancelling a pending outbound
//     control_request, typically because the LLM turn was interrupted.
//
// The CLI also emits `type="assistant"` envelopes summarising each turn; the
// stream_event parser already finalises blocks and usage from the partial
// events, so those envelopes carry no fields we need to model here.
type StreamMessage struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype,omitempty"` // "init", "result", "success"
	SessionID string `json:"session_id,omitempty"`

	// On `type=result`, the CLI sets these when the API call itself
	// failed (e.g. 400 bad request). Subtype stays "success" — the CLI's
	// distinction is "the CLI ran successfully" vs "the LLM call within
	// it"; we have to check IsError too. APIErrorStatus is the HTTP
	// status from Anthropic. The error text itself lives in Result.
	IsError        bool `json:"is_error,omitempty"`
	APIErrorStatus int  `json:"api_error_status,omitempty"`

	// Stream-event / result content.
	Result     json.RawMessage              `json:"result,omitempty"`     // Can be string or ResultContent object
	Usage      *TopLevelUsage               `json:"usage,omitempty"`      // Top-level usage for "result" type messages
	Event      *StreamEventDetail           `json:"event,omitempty"`      // For type="stream_event"
	ModelUsage map[string]*ModelUsageDetail `json:"modelUsage,omitempty"` // On "result" events: keyed by full model id

	// Control protocol fields. RequestID is shared across all three
	// control envelope types; the dispatcher routes on Type and keys on
	// RequestID.
	RequestID string               `json:"request_id,omitempty"` // control_request, control_response, control_cancel_request
	Request   *ControlRequestBody  `json:"request,omitempty"`    // control_request payload
	Response  *ControlResponseBody `json:"response,omitempty"`   // control_response payload
}

// ControlRequestBody is the body of a control_request envelope (both
// directions). Many fields are subtype-specific — read Subtype first and
// only consult the fields relevant to that subtype.
type ControlRequestBody struct {
	Subtype string `json:"subtype"`

	// mcp_message (CLI → SDK): the CLI is asking us to dispatch an MCP
	// JSONRPC method against the named in-process server.
	ServerName string          `json:"server_name,omitempty"`
	Message    json.RawMessage `json:"message,omitempty"` // raw JSONRPC envelope

	// can_use_tool (CLI → SDK): only fires if we wire
	// --permission-prompt-tool stdio; today we don't, so these fields
	// are present for forward compatibility only.
	ToolName  string          `json:"tool_name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`

	// initialize (SDK → CLI): one-shot handshake immediately after spawn.
	// We send an empty initialize; the listed fields are kept for forward
	// compatibility with hooks/agents/skills if we want to opt in later.
	Hooks                  json.RawMessage `json:"hooks,omitempty"`
	Agents                 json.RawMessage `json:"agents,omitempty"`
	Skills                 json.RawMessage `json:"skills,omitempty"`
	ExcludeDynamicSections bool            `json:"excludeDynamicSections,omitempty"`

	// set_model / set_permission_mode / interrupt (SDK → CLI): runtime
	// control. Reserved for future use; the wrapper doesn't currently
	// emit these.
	Model string `json:"model,omitempty"`
	Mode  string `json:"mode,omitempty"`
}

// ControlResponseBody is the body of a control_response envelope.
// The Subtype is always "success" or "error". On success, Response is the
// per-subtype payload (e.g. for mcp_message it wraps the JSONRPC result);
// on error, Error carries a human-readable string.
type ControlResponseBody struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// JSONRPCMessage models the inner payload carried by
// control_request{subtype:mcp_message}. The CLI speaks vanilla JSONRPC 2.0
// over the stdio control channel; we read Method to dispatch and respond
// with the same ID and either Result or Error populated.
type JSONRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *JSONRPCError   `json:"error,omitempty"`
}

// JSONRPCError is the standard JSONRPC 2.0 error object.
type JSONRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// MCPToolsCallParams matches the MCP spec for tools/call params. Note there is
// no tool_use_id on the wire: the dispatcher routes a delivered result to the
// parked call by (Name, canonical(Arguments)) key, FIFO among same-key, with a
// same-tool-name fallback for arg-drift — never crossing tool types. See the
// parkedCalls doc in control_protocol.go.
type MCPToolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// MCPToolsCallResult is the result payload our in-process MCP server
// returns on a successful tools/call. The CLI surfaces Content as the
// LLM's view of the tool output; IsError flips the response to a
// tool-failure branch in the LLM. Each Content entry is an MCPContentBlock
// or an MCPImageBlock.
type MCPToolsCallResult struct {
	Content []any `json:"content"`
	IsError bool  `json:"isError,omitempty"`
}

// MCPContentBlock is a text block in an MCP tools/call result.
type MCPContentBlock struct {
	Type string `json:"type"` // "text"
	Text string `json:"text"`
}

// MCPImageBlock is an image block in an MCP tools/call result: base64 bytes
// keyed by MIME type. The CLI hands it to the model inside the tool_result.
type MCPImageBlock struct {
	Type     string `json:"type"` // "image"
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

// MCPInitializeResult is the result payload returned by our in-process MCP
// server's initialize method.
type MCPInitializeResult struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ServerInfo      MCPServerInfo  `json:"serverInfo"`
}

// MCPServerInfo identifies our in-process MCP server to the CLI.
type MCPServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// MCPToolsListResult is the result payload our in-process MCP server
// returns on tools/list. Tools are typed as raw JSON so callers can hand
// in pre-built ToolDefinition objects without an extra marshal/unmarshal
// hop.
type MCPToolsListResult struct {
	Tools []json.RawMessage `json:"tools"`
}

// ModelUsageDetail is the per-model entry in a result event's modelUsage map.
// The CLI reports the model's actual contextWindow and maxOutputTokens here,
// which we use to keep ListModelsWithInfo self-updating.
type ModelUsageDetail struct {
	InputTokens     int `json:"inputTokens,omitempty"`
	OutputTokens    int `json:"outputTokens,omitempty"`
	ContextWindow   int `json:"contextWindow,omitempty"`
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

// StreamEventDetail mirrors the Anthropic API event types that the CLI passes
// through verbatim when --include-partial-messages is enabled.
//
// The event types we handle:
//   - message_start: initial empty message envelope (we read usage from it).
//   - content_block_start: a new content block opens at .Index with .ContentBlock.Type
//     ("text", "thinking", "tool_use").
//   - content_block_delta: incremental update; .Delta.Type indicates which kind of delta
//     (text_delta, thinking_delta, signature_delta, input_json_delta).
//   - content_block_stop: the block at .Index is complete.
//   - message_delta: carries final stop_reason in .Delta.StopReason and final .Usage.
//   - message_stop: end of the message.
type StreamEventDetail struct {
	Type         string              `json:"type"`
	Index        int                 `json:"index,omitempty"`
	ContentBlock *StreamEventContent `json:"content_block,omitempty"`
	Delta        *StreamEventDelta   `json:"delta,omitempty"`
	Message      *MessageStartInfo   `json:"message,omitempty"` // for message_start: carries only usage
	Usage        *UsageInfo          `json:"usage,omitempty"`   // for message_delta
}

// MessageStartInfo is the message envelope on a stream_event message_start.
// We only consult its Usage; the per-block content is delivered separately
// via content_block_* events, so we don't unmarshal it.
type MessageStartInfo struct {
	Usage *UsageInfo `json:"usage,omitempty"`
}

// StreamEventContent is the content_block field on a content_block_start event.
type StreamEventContent struct {
	Type  string         `json:"type"` // "text", "thinking", "tool_use"
	Text  string         `json:"text,omitempty"`
	ID    string         `json:"id,omitempty"`    // tool_use only
	Name  string         `json:"name,omitempty"`  // tool_use only
	Input map[string]any `json:"input,omitempty"` // tool_use only (usually empty at start)
}

// StreamEventDelta is the delta field on content_block_delta and message_delta events.
type StreamEventDelta struct {
	Type        string `json:"type,omitempty"`
	Text        string `json:"text,omitempty"`         // text_delta
	Thinking    string `json:"thinking,omitempty"`     // thinking_delta
	Signature   string `json:"signature,omitempty"`    // signature_delta
	PartialJSON string `json:"partial_json,omitempty"` // input_json_delta
	StopReason  string `json:"stop_reason,omitempty"`  // message_delta
}

// TopLevelUsage contains usage info at the top level of "result" type messages
type TopLevelUsage struct {
	InputTokens              int `json:"input_tokens,omitempty"`
	OutputTokens             int `json:"output_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
}

// ResultContent represents the final result in a system message
type ResultContent struct {
	InputTokens              int    `json:"input_tokens,omitempty"`
	OutputTokens             int    `json:"output_tokens,omitempty"`
	TotalTokens              int    `json:"total_tokens,omitempty"`
	StopReason               string `json:"stop_reason,omitempty"`
	CacheReadInputTokens     int    `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int    `json:"cache_creation_input_tokens,omitempty"`
}

// UsageInfo contains token usage information
type UsageInfo struct {
	InputTokens              int `json:"input_tokens,omitempty"`
	OutputTokens             int `json:"output_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
}

// InitData contains initialization information from the CLI
type InitData struct {
	SessionID string   `json:"session_id"`
	Tools     []string `json:"tools,omitempty"`
	MCPTools  []string `json:"mcp_tools,omitempty"`
}
