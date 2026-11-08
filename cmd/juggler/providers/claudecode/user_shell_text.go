//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"fmt"
	"slices"
	"strings"

	"juggler/cmd/juggler/providers/provider"
)

// userShellCallsAsText rewrites each shell command the user ran themselves
// (`! cmd`, a bash tool call whose id carries provider.UserShellToolUseIDPrefix)
// into one user message holding the command and its output, placed where the
// call stands. The call's tool_result is folded into that message.
//
// The CLI keeps its own session file, and the user's command is not in it: the
// model never made that call. As a tool_use/tool_result pair it can only reach
// the CLI by being written into that file, and the warm-append refuses it — the
// file ends on the model's text reply, or on the model's own dangling call, not
// on this one — so every `! cmd` cold-started the session. As user text it
// travels on stdin like any other message, and the warm session stays warm.
//
// It runs once per request, before routing, so the resume hashes, the stdin
// delta and a cold rebuild all see the same messages. The rewrite is
// deterministic, so a session stays warm across turns. A command still running
// arrives with the worker's placeholder result; it is rendered the same way and
// changes, like any tool result, when the real one lands.
//
// req.Messages is copied before it is changed: the slice belongs to the caller.
func userShellCallsAsText(req provider.MessageRequest) provider.MessageRequest {
	if !slices.ContainsFunc(req.Messages, isUserShellMessage) {
		return req
	}
	results := map[string]provider.Message{}
	for _, m := range req.Messages {
		if m.Type == "tool-result" && isUserShellMessage(m) {
			results[m.ToolUseID] = m
		}
	}
	out := make([]provider.Message, 0, len(req.Messages))
	for _, m := range req.Messages {
		if !isUserShellMessage(m) {
			out = append(out, m)
			continue
		}
		if m.Type != "tool-use" {
			continue // a result, folded into its call's message (or an orphan, dropped)
		}
		result, ok := results[m.ToolUseID]
		out = append(out, userShellTextMessage(m, result, ok))
	}
	req.Messages = out
	return req
}

// isUserShellMessage reports whether m is the call or the result of a shell
// command the user ran themselves.
func isUserShellMessage(m provider.Message) bool {
	return (m.Type == "tool-use" || m.Type == "tool-result") &&
		strings.HasPrefix(m.ToolUseID, provider.UserShellToolUseIDPrefix)
}

// userShellTextMessage renders one user shell command, with its result when it
// has one, as the user message the model reads.
func userShellTextMessage(call, result provider.Message, hasResult bool) provider.Message {
	command, _ := call.ToolInput["command"].(string)
	var b strings.Builder
	b.WriteString("<user-shell-command>\n")
	b.WriteString("I ran this shell command myself; it is not a call you made.\n")
	fmt.Fprintf(&b, "$ %s\n", command)
	switch {
	case !hasResult:
		b.WriteString("(no output recorded)\n")
	case result.IsError:
		fmt.Fprintf(&b, "<output error=\"true\">\n%s\n</output>\n", result.Content)
	default:
		fmt.Fprintf(&b, "<output>\n%s\n</output>\n", result.Content)
	}
	b.WriteString("</user-shell-command>")
	return provider.Message{Type: "user", Content: b.String(), Parts: result.Parts}
}
