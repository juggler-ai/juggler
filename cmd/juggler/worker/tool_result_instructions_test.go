//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestToolResultCarriesFolderInstructions pins how the instruction files a call
// loaded for a folder reach the model: inside that call's own tool_result,
// after the tool's output and before any hook's note, each tagged with its
// path. Anywhere else — a message of their own after the batch — would read to
// the claudecode provider as the user interjecting, and could fall between a
// tool_use and its result.
func TestToolResultCarriesFolderInstructions(t *testing.T) {
	item := ConversationItem{
		ToolUseID:    "t",
		Result:       json.RawMessage(`{"content":"file text","isError":false}`),
		Instructions: json.RawMessage(`[{"path":"pkg/AGENTS.md","content":"Use pnpm.\n"},{"path":"pkg/AGENTS.local.md","content":"  "}]`),
		Hooks:        json.RawMessage(`[{"id":"h","event":"afterTool","note":"A note."}]`),
	}
	want := "file text" +
		"\n\n<instructions path=\"pkg/AGENTS.md\">\nUse pnpm.\n</instructions>" +
		"\n\n<hook-note source=\"h\">\nA note.\n</hook-note>"
	if got := buildToolResultMap(item)["content"]; got != want {
		t.Errorf("content =\n%q\nwant\n%q", got, want)
	}
}
