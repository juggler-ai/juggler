//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// In-process MCP server for the claudecode provider. Handles the JSONRPC
// methods the CLI invokes via stdio control_request{subtype:mcp_message}:
// initialize, tools/list, tools/call. initialize and tools/list are
// synchronous; tools/call is asynchronous — we surface the call to the
// worker via the existing StructuredStreamCallback path and respond later
// when the worker hands back the tool-result on the next StreamMessage
// invocation.

package claudecode

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// mcpServerName is the name we register our in-process server under in
// the --mcp-config JSON. The CLI uses it to disambiguate which server a
// given mcp_message belongs to.
const mcpServerName = "juggler"

// mcpToolDef is the slim ToolDefinition shape the CLI expects from
// tools/list — name, description, inputSchema. Wider provider.Tool fields
// are flattened down here. Defined as raw JSON to side-step pulling the
// full provider.Tool shape into the protocol layer.
type mcpToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// toolDefsToMCPList converts the provider's tool definitions into the
// MCP-spec tools/list payload. Field names map 1:1 except inputSchema
// (camelCase on the wire, since MCP follows JSONRPC convention).
//
// Tool names are advertised UNPREFIXED. The CLI adds the
// `mcp__<server-name>__` prefix itself when exposing tools to the LLM,
// based on the server name in --mcp-config. Prefixing on our side too
// would produce names like `mcp__juggler__mcp__juggler__bash` and the
// CLI reports "Unknown tool" when the LLM tries to call them.
//
// A tool whose schema fails validateToolInputSchema is dropped from the
// payload and named in the log rather than failing the whole list. The
// consumer of tools/list rejects a malformed payload wholesale, so one bad
// schema would otherwise cost the model every tool it has — and it fails
// downstream, far from the definition at fault. Dropping bounds the damage to
// the offending tool and puts its name where the diagnosis starts.
func toolDefsToMCPList(tools []provider.ToolDefinition) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(tools))
	for _, t := range tools {
		if reason := validateToolInputSchema(t.InputSchema); reason != "" {
			jlog.Info("[claudecode] tool %q withheld from tools/list: %s", t.Name, reason)
			continue
		}
		def := mcpToolDef{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
		raw, err := json.Marshal(def)
		if err != nil {
			return nil, fmt.Errorf("marshal tool %q: %w", t.Name, err)
		}
		out = append(out, raw)
	}
	return out, nil
}

// validateToolInputSchema reports why an inputSchema is unusable as an MCP
// parameter schema, or "" when it is well-formed. Tool parameters are always
// passed as a named object, so the root must be an object schema: anything
// else is refused downstream, where the error names neither the tool nor the
// missing keyword.
//
// The check is deliberately narrow — it rejects only what is unambiguously
// broken, so a tool is never withheld over a stylistic quibble. `properties`
// may legitimately be absent on a no-argument tool; when present it must be an
// object. Stricter house rules (properties always declared, every `required`
// name present in them) belong in the extension test suite, which owns every
// definition and can fail the build instead of a live turn.
func validateToolInputSchema(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "no inputSchema declared"
	}
	var schema struct {
		Type       string          `json:"type"`
		Properties json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return fmt.Sprintf("inputSchema is not a JSON object: %v", err)
	}
	if schema.Type != "object" {
		if schema.Type == "" {
			return `inputSchema has no "type" (want "object")`
		}
		return fmt.Sprintf("inputSchema type is %q, want \"object\"", schema.Type)
	}
	if len(schema.Properties) > 0 && !bytes.HasPrefix(bytes.TrimSpace(schema.Properties), []byte("{")) {
		return "inputSchema properties is not a JSON object"
	}
	return ""
}

// mcpInitializeResult is the canonical initialize response we send back
// when the CLI handshakes against our in-process server. The protocol
// version matches MCP 2024-11-05 (the version Claude Code's CLI accepts).
func mcpInitializeResult() MCPInitializeResult {
	return MCPInitializeResult{
		ProtocolVersion: "2024-11-05",
		Capabilities: map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		ServerInfo: MCPServerInfo{
			Name:    mcpServerName,
			Version: "1.0.0",
		},
	}
}

// jsonrpcSuccess wraps a result payload in a JSONRPC 2.0 success envelope
// matching the originating ID. Caller marshals the returned envelope into
// the control_response.response.mcp_response field.
func jsonrpcSuccess(id json.RawMessage, result any) (json.RawMessage, error) {
	resBytes, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	env := JSONRPCMessage{JSONRPC: "2.0", ID: id, Result: resBytes}
	return json.Marshal(env)
}

// jsonrpcFailure wraps an error in a JSONRPC 2.0 error envelope. The CLI
// will surface this to the LLM as a tool failure (treated like IsError
// content for tools/call, or just a method failure for tools/list etc.).
func jsonrpcFailure(id json.RawMessage, code int, message string) (json.RawMessage, error) {
	env := JSONRPCMessage{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &JSONRPCError{Code: code, Message: message},
	}
	return json.Marshal(env)
}

// mcpToolsCallSuccess builds the JSONRPC envelope for a successful
// tools/call response. Content text + IsError mirror MCP's spec; the CLI
// uses IsError to decide whether to surface as a failed tool to the LLM.
// Each image part with resolved bytes follows the text as an image block; a
// part whose asset was missing has no bytes and is skipped.
func mcpToolsCallSuccess(id json.RawMessage, content string, parts []provider.MediaPart, isError bool) (json.RawMessage, error) {
	blocks := []any{MCPContentBlock{Type: "text", Text: content}}
	for _, part := range parts {
		if part.Type != "image" || len(part.Data) == 0 {
			continue
		}
		blocks = append(blocks, MCPImageBlock{
			Type:     "image",
			Data:     base64.StdEncoding.EncodeToString(part.Data),
			MimeType: part.Mime,
		})
	}
	return jsonrpcSuccess(id, MCPToolsCallResult{Content: blocks, IsError: isError})
}
