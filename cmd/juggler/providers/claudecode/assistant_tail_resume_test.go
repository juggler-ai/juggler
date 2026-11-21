//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestFreshStartWithAssistantTailResumesHistory drives the whole dispatch path
// for a conversation whose last message is the assistant's — the shape a
// regenerate produces, and the shape a turn takes after the previous one was
// interrupted mid-tool-call.
//
// The failure it pins: with no synthetic plan, startFreshSession spawns a bare
// `-p` with no --resume and falls back to piping user-role content only. Every
// assistant turn and every tool_use block is dropped, so the surviving
// tool_results reference calls that no longer exist anywhere in the request.
// The model is handed a conversation in which it never called a tool and
// answers accordingly — denying work it actually did.
//
// The two assertions are the two halves of the loss: the spawn must carry a
// --resume at all, and the file it resumes must still contain the tool call.
func TestFreshStartWithAssistantTailResumesHistory(t *testing.T) {
	// Redirect ~/.claude so the synthesised session lands in the test's
	// tempdir rather than the developer's real project history.
	userpathstest.Isolate(t)

	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-assistant-tail")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-assistant-tail"

	const toolUseID = "toolu_bash_headless_server"
	msgs := []provider.Message{
		userMsg("check the fix end to end"),
		assistantMsg("Starting a headless server:"),
		toolUseMsg(toolUseID, "bash"),
		toolResultMsg(toolUseID, "AI Code Agent • v0.5.6"),
		userMsg("Suggest a short one line commit message"),
		// The tail: the assistant's own reply, re-sent.
		assistantMsg("Fixed ReadJugglerSource fetching unversioned asset paths"),
	}
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
		Tools: []provider.ToolDefinition{{Name: "bash"}},
	}, nopCallback()); err != nil {
		t.Fatalf("assistant-tail turn: %v", err)
	}

	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("expected at least one fake-CLI spawn, got none")
	}
	last := trace[len(trace)-1]
	if last.ResumeID == "" {
		t.Fatalf("spawn carried no --resume, so the CLI started with an empty session: "+
			"%d messages of history (including a %s tool call) were flattened away. Argv: %v",
			len(msgs), "bash", last.Argv)
	}

	// The resumed file must still contain the tool_use, under the prefixed
	// name the CLI records in its own native sessions.
	sessionPath := filepath.Join(os.Getenv("HOME"), ".claude", "projects",
		ProjectDirName(c.workingDir), last.ResumeID+".jsonl")
	data, err := os.ReadFile(sessionPath)
	if err != nil {
		t.Fatalf("read synthesised session %s: %v", sessionPath, err)
	}
	body := string(data)
	if !strings.Contains(body, `"type":"tool_use"`) {
		t.Errorf("synthesised session has no tool_use block — the assistant's tool call was dropped:\n%s", body)
	}
	if !strings.Contains(body, mcpToolPrefix+"bash") {
		t.Errorf("synthesised session missing the %sbash tool_use name:\n%s", mcpToolPrefix, body)
	}
	if !strings.Contains(body, toolUseID) {
		t.Errorf("synthesised session missing tool_use id %s:\n%s", toolUseID, body)
	}

	c.dropSession(convID)
}
