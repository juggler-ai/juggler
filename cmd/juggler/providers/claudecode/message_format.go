//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"fmt"
	"strings"

	"juggler/cmd/juggler/providers/anthropic"
	provider "juggler/cmd/juggler/providers/registry"
)

// mcpToolPrefix is the prefix Claude CLI adds to MCP tools based on server name.
// We strip this when receiving tool calls, and add it back when sending history.
const mcpToolPrefix = "mcp__juggler__"

// canonicalToolName is the single chokepoint that turns a tool name we
// received from the CLI (over either a stream_event tool_use block or an
// SDK tools/call control_request) into the Juggler tool key the worker
// expects. Both the parser and the control-protocol router run names
// through here so the registry-lookup rule lives in exactly one place.
//
// The strip is applied in a loop so a doubly-prefixed name (mcp__juggler__
// repeated, e.g. if tools were ever advertised pre-prefixed in tools/list —
// see mcp_inproc.go) still resolves correctly. Names that don't start with
// the full `mcp__juggler__` separator are returned unchanged; in particular
// the bare server name `mcp__juggler` is left alone so we never silently
// look up the empty string.
func canonicalToolName(name string) string {
	for strings.HasPrefix(name, mcpToolPrefix) {
		name = name[len(mcpToolPrefix):]
	}
	return name
}

// claudeToJugglerTools maps Claude native tool names to Juggler equivalents.
// When Claude tries to use its built-in tools (Read, Edit, etc.), we convert
// them to the corresponding Juggler tools so they work transparently.
var claudeToJugglerTools = map[string]string{
	"Read":  "read_file",
	"Edit":  "edit_file",
	"Write": "write_file",
	"Bash":  "execute_command",
	"Grep":  "grep",
}

// claudeParamMapping maps Claude param names to Juggler param names per tool.
// Claude uses different parameter names (e.g., "file_path" vs "path").
var claudeParamMapping = map[string]map[string]string{
	"Read":  {"file_path": "path"},
	"Edit":  {"file_path": "path", "old_string": "old_str", "new_string": "new_str"},
	"Write": {"file_path": "path"},
	// Bash and Grep use same param names, no mapping needed
}

// convertClaudeNativeTool converts Claude native tools to Juggler equivalents.
// Returns the converted tool name and input, or the original if not a Claude native tool.
func convertClaudeNativeTool(toolName string, input map[string]any) (string, map[string]any) {
	jugglerName, isClaudeTool := claudeToJugglerTools[toolName]
	if !isClaudeTool {
		return toolName, input
	}

	// Convert parameter names if mapping exists
	paramMap, hasMapping := claudeParamMapping[toolName]
	if !hasMapping {
		return jugglerName, input
	}

	// Create new input with converted param names
	newInput := make(map[string]any)
	for k, v := range input {
		if newKey, mapped := paramMap[k]; mapped {
			newInput[newKey] = v
		} else {
			newInput[k] = v
		}
	}
	return jugglerName, newInput
}

// modelAlias maps whatever was configured on the client to the value handed
// to the CLI's --model arg (also the cache key for self-updated model specs).
//
// A known family in c.model collapses to its canonical alias ("opus" |
// "haiku" | "fable" | "sonnet"), so a full id like "claude-sonnet-4-5"
// resolves to "sonnet" and tracks the latest of that family. An unrecognised
// non-empty value is passed through verbatim rather than silently coerced to
// sonnet: a future family or an explicit full id reaches the CLI as-is, which
// resolves or rejects it — far better than quietly running a different model.
// Only an empty model defaults to "sonnet" (the CLI needs something).
func (c *Client) modelAlias() string {
	model := strings.ToLower(strings.TrimSpace(c.model))
	switch {
	case strings.Contains(model, "opus"):
		return "opus"
	case strings.Contains(model, "haiku"):
		return "haiku"
	case strings.Contains(model, "fable"):
		return "fable"
	case strings.Contains(model, "sonnet"):
		return "sonnet"
	case model == "":
		return "sonnet"
	default:
		return model
	}
}

// commonArgs builds the CLI flags shared by fresh and resume invocations.
func (c *Client) commonArgs(systemPrompt string) []string {
	args := []string{
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--max-turns", "0",
	}
	if systemPrompt != "" {
		args = append(args, "--system-prompt", systemPrompt)
	}
	args = append(args, "--model", c.modelAlias())
	// Without an explicit flag the CLI resolves its permission mode from
	// settings files shared with the user's own interactive sessions in the
	// same folder (e.g. a plan mode persisted in .claude/settings.local.json),
	// which would strand the spawned CLI with every tool blocked. A CLI arg
	// outranks all settings sources, so pin it to default.
	args = append(args, "--permission-mode", "default")

	if mcpConfig, err := c.buildMCPConfig(); err == nil && mcpConfig != "" {
		args = append(args, "--mcp-config", mcpConfig)
		args = append(args, "--strict-mcp-config")
		args = append(args, "--allowedTools", "mcp__juggler__*")
		// The Task* family (Task, TaskCreate, TaskUpdate, TaskList,
		// TaskOutput, TaskGet, TaskStop) and similar Claude-native control
		// tools are all listed explicitly — if a new Anthropic tool slips
		// through, juggler won't produce a tool_result for it and the
		// dangling tool_use poisons synthetic resume (the CLI silently
		// emits end_turn with zero tokens on the next turn).
		args = append(args, "--disallowedTools", "Edit,Write,Read,Bash,Glob,Grep,LS,MultiEdit,NotebookEdit,TodoRead,TodoWrite,WebFetch,WebSearch,Task,TaskCreate,TaskUpdate,TaskList,TaskOutput,TaskGet,TaskStop,ExitPlanMode,EnterPlanMode,KillShell,AskUserQuestion,Skill,LSP,ToolSearch,Agent,CronCreate,CronDelete,CronList,RemoteTrigger,EnterWorktree,ExitWorktree")
	}
	return args
}

// formatMessagesAsStreamJSONLines converts juggler messages into one
// stream-json line per user-role API message, suitable for piping to a CLI
// invocation that uses --input-format stream-json. Assistant blocks are
// skipped: claude already has them in its session via --resume, so
// re-feeding them would either be rejected or break caching.
//
// Each line is a JSON object of the form:
//
//	{"type":"user","message":{"role":"user","content":[...]},"parent_tool_use_id":null,"session_id":"<uuid>"}
//
// where content is the array of content blocks (text, tool_result, etc.) for
// that user-role message in Anthropic API format.
func (c *Client) formatMessagesAsStreamJSONLines(messages []provider.Message, sessionID string) ([]string, error) {
	apiMessages := anthropic.TransformToAPIMessagesForCLI(messages)

	// Coalesce every user-role message into a SINGLE stream-json envelope.
	// The persistent CLI answers each '\n'-terminated envelope as its own
	// turn, but a juggler StreamMessage call reads exactly one terminal turn
	// (readUntilPauseOrComplete returns at the first end_turn). Emitting more
	// than one envelope per turn therefore leaves the surplus turns' responses
	// buffered in activeSession.content and mis-attributed to a later message.
	// Multiple user messages arise when dropped assistant turns split the users
	// apart (user/assistant/user/...), which TransformToAPIMessages can't group;
	// merging their content blocks keeps the invariant one turn == one envelope.
	//
	// Assistant content is dropped here: it's already in claude's session via
	// --resume, or absent in a history-less cold start. We don't add the
	// mcp__juggler__ prefix to tool_use blocks because user-role messages carry
	// only tool_result blocks (which reference tool_use_id, not name).
	var content []anthropic.APIContentBlock
	for i := range apiMessages {
		if apiMessages[i].Role != "user" {
			continue
		}
		content = append(content, apiMessages[i].Content...)
	}
	if len(content) == 0 {
		return nil, nil
	}
	envelope := map[string]any{
		"type":               "user",
		"message":            map[string]any{"role": "user", "content": content},
		"parent_tool_use_id": nil,
		"session_id":         sessionID,
	}
	buf, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal stream-json line: %w", err)
	}
	return []string{string(buf)}, nil
}

// buildMCPConfig creates the MCP config JSON the CLI consumes via
// --mcp-config. We declare a single server of type "sdk" so the CLI
// routes its MCP calls (tools/list, tools/call, etc.) over the stdio
// control protocol back to us, rather than opening an HTTP connection.
// See control_protocol.go and mcp_inproc.go for the receiving side.
//
// This shape matches the Claude Agent SDK's --mcp-config payload
// (anthropics/claude-agent-sdk-python/_internal/transport/subprocess_cli.py:307-329).
func (c *Client) buildMCPConfig() (string, error) {
	config := map[string]any{
		"mcpServers": map[string]any{
			mcpServerName: map[string]any{
				"type": "sdk",
				"name": mcpServerName,
			},
		},
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("failed to marshal MCP config: %w", err)
	}
	return string(configJSON), nil
}
