//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"fmt"
	"strings"

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/provider"
)

// mcpToolPrefix is the prefix Claude CLI adds to MCP tools based on server name.
// We strip this when receiving tool calls, and add it back when sending history.
const mcpToolPrefix = "mcp__juggler__"

// disallowedNativeTools is the explicit deny list passed to the CLI as
// --disallowedTools. Juggler serves every tool itself over the in-process MCP
// server (--allowedTools mcp__juggler__*), so any Claude-native tool left
// enabled is a hazard, in two distinct ways:
//
//   - A native name juggler does NOT serve produces a tool_use juggler never
//     answers. The dangling tool_use poisons synthetic resume (the CLI emits
//     end_turn with zero tokens on the next turn).
//   - A native name juggler DOES serve (Monitor is both a CLI built-in and a
//     juggler tool) is worse: canonicalToolName strips the absent
//     mcp__juggler__ prefix, so the parser cannot tell the two apart and
//     dispatches the block as juggler's own. The CLI meanwhile answers its
//     native call itself and never sends a tools/call, so juggler's result
//     finds no parked call and is stashed forever while the CLI blocks on its
//     next, genuinely-MCP call. Both sides wait: the conversation hangs until
//     teardown.
//
// The list is therefore deliberately over-broad — an entry the CLI doesn't
// know costs only a launch warning, which cli_lifecycle.go already filters,
// whereas a missing entry costs a wedged conversation. Re-check it against the
// CLI's built-in set whenever the pinned CLI version moves.
var disallowedNativeTools = []string{
	// File and shell built-ins.
	"Edit", "Write", "Read", "Bash", "BashOutput", "Glob", "Grep", "LS",
	"MultiEdit", "NotebookEdit", "KillShell",
	// Planning and todo built-ins.
	"TodoRead", "TodoWrite", "ExitPlanMode", "EnterPlanMode",
	// Web built-ins.
	"WebFetch", "WebSearch",
	// Task/agent orchestration built-ins.
	"Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskOutput", "TaskGet",
	"TaskStop", "Agent", "Workflow", "ListAgents", "SendMessage",
	// Scheduling, notification and remote-control built-ins.
	"CronCreate", "CronDelete", "CronList", "RemoteTrigger", "ScheduleWakeup",
	"PushNotification", "Monitor",
	// Editor/session built-ins.
	"AskUserQuestion", "Skill", "SlashCommand", "LSP", "ToolSearch",
	"ReportFindings", "DesignSync", "EnterWorktree", "ExitWorktree",
}

// canonicalToolName is the single chokepoint that turns a tool name we
// received from the CLI (over either a stream_event tool_use block or an
// SDK tools/call control_request) into the Juggler tool key the worker
// expects. Both the parser and the control-protocol router run names
// through here so the registry-lookup rule lives in exactly one place.
//
// The prefix is stripped exactly once, because the CLI adds it exactly once to
// the unprefixed names tools/list advertises (mcp_inproc.go). A name carrying it
// twice is therefore no tool at all — the CLI rejects it itself — and must not
// resolve to one of juggler's (see finishToolUseBlock). Names that don't start
// with the full `mcp__juggler__` separator are returned unchanged; in particular
// the bare server name `mcp__juggler` is left alone so we never silently look
// up the empty string.
func canonicalToolName(name string) string {
	return strings.TrimPrefix(name, mcpToolPrefix)
}

// cliNativeToolNames is disallowedNativeTools as a set, for the one question
// the parser asks of an unprefixed tool_use name: is this a tool the CLI serves
// ITSELF?
//
// The distinction matters because two very different things arrive unprefixed.
// A CLI built-in means --disallowedTools has gone stale and the CLI may have
// acted without juggler seeing it. Anything else is the model imitating the bare
// names in its own transcript (see prefixJugglerToolUses) — the CLI knows only
// mcp__juggler__*, so it rejects the name and the model re-issues it correctly.
// Same wire shape, opposite diagnosis.
var cliNativeToolNames = func() map[string]struct{} {
	set := make(map[string]struct{}, len(disallowedNativeTools))
	for _, name := range disallowedNativeTools {
		set[name] = struct{}{}
	}
	return set
}()

// isCLINativeToolName reports whether name is one of the CLI's own built-ins.
func isCLINativeToolName(name string) bool {
	_, ok := cliNativeToolNames[name]
	return ok
}

// canonicalAlias collapses any model string — a bare alias, a full CLI id like
// "claude-sonnet-4-5-20250929", or a modelUsage map key — to its family alias
// ("opus" | "haiku" | "fable" | "sonnet") by substring. An unrecognised
// non-empty value is returned lowercased+trimmed verbatim; an empty value
// returns "". This is the single source of truth for family matching, shared by
// modelAlias (which maps the configured model to the --model arg / cache key)
// and the parser (which must match a modelUsage entry's full id back to the
// requested alias so it learns each model's window from that model's own
// entry, never a co-billed background model's).
//
// Order matters: check the more specific families before "sonnet" only where
// substrings could overlap; today the four families are mutually exclusive
// substrings, so order is not load-bearing, but keep the explicit cases.
func canonicalAlias(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(model, "opus"):
		return "opus"
	case strings.Contains(model, "haiku"):
		return "haiku"
	case strings.Contains(model, "fable"):
		return "fable"
	case strings.Contains(model, "sonnet"):
		return "sonnet"
	default:
		return model
	}
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
	if alias := canonicalAlias(c.model); alias != "" {
		return alias
	}
	return "sonnet"
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
	// same folder — a plan mode persisted in .claude/settings.local.json would
	// strand the spawned CLI with every tool blocked and no way out (juggler
	// disallows ExitPlanMode). A CLI arg outranks all settings sources, so pin
	// it to default — matching the permissionMode juggler stamps into its
	// synthetic session entries (synthetic_resume.go).
	args = append(args, "--permission-mode", "default")

	// Unconditional: --allowedTools and --disallowedTools are what confine the
	// CLI to juggler's own tools, so they travel with --mcp-config as one
	// indivisible unit. Spawning with any of them missing is never a degraded
	// mode worth having — it is a CLI running its native toolset behind our back.
	args = append(args, "--mcp-config", c.buildMCPConfig())
	args = append(args, "--strict-mcp-config")
	args = append(args, "--allowedTools", "mcp__juggler__*")
	args = append(args, "--disallowedTools", strings.Join(disallowedNativeTools, ","))
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
//
// The payload is a fixed two-key map of string values, so marshalling it
// cannot fail and the result is never empty. It returns a bare string to keep
// that guarantee at the type level: an error return here would invite callers
// to treat "no MCP config" as a tolerable outcome, and spawning without
// --mcp-config also drops --allowedTools and --disallowedTools, leaving the
// CLI with none of juggler's tools and all of its own native ones unblocked.
func (c *Client) buildMCPConfig() string {
	config := map[string]any{
		"mcpServers": map[string]any{
			mcpServerName: map[string]any{
				"type": "sdk",
				"name": mcpServerName,
			},
		},
	}
	configJSON, _ := json.Marshal(config)
	return string(configJSON)
}
