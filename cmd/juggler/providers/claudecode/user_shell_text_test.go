//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// userShellToolUseMsg is the bash call the worker posts for a `! cmd` the user
// typed (worker/shell_command.go).
func userShellToolUseMsg(id, command string) provider.Message {
	return provider.Message{
		Type: "tool-use", ToolUseID: id, ToolName: "bash",
		ToolInput: map[string]any{"command": command, "description": "Run by the user", "timeout": 1200000},
	}
}

// seedTextTurnSession writes a CLI-native session file whose last entry is the
// assistant's text reply — what the CLI leaves on disk after a turn that ended
// without calling a tool.
func seedTextTurnSession(t *testing.T, workingDir, sessionUUID string) string {
	t.Helper()
	dir := projectsDir(workingDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	entries := []map[string]any{
		newSyntheticEntry("user", []map[string]any{{"type": "text", "text": "do the thing"}},
			"uuid-user-1", nil, sessionUUID, workingDir, time.Now()),
		newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "done"}},
			"uuid-asst-1", "uuid-user-1", sessionUUID, workingDir, time.Now()),
	}
	var buf strings.Builder
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal seed entry: %v", err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	path := filepath.Join(dir, sessionUUID+".jsonl")
	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		t.Fatalf("write seed session: %v", err)
	}
	return path
}

// TestUserShellAfterTextTurnResumesWarm: the user runs `! cmd` while the
// conversation is idle, then sends a message. The warm session file ends on the
// assistant's text reply, and the user's command was never a call the CLI made,
// so it cannot be appended to that file as a tool_use/tool_result pair. The turn
// must still --resume the same warm uuid: the command reaches the CLI as the
// user's text.
func TestUserShellAfterTextTurnResumesWarm(t *testing.T) {
	userpathstest.Isolate(t)
	const warmUUID = "uuid-warm-usershell"
	tracePath := installFakeClaude(t, fakeModeUntilClose, warmUUID)
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-usershell-idle"
	seedTextTurnSession(t, c.workingDir, warmUUID)

	// The previous request was just the prompt; the reply heads the next delta.
	fed := []provider.Message{userMsg("do the thing")}
	c.activeSession = &activeSession{
		sessionUUID: warmUUID,
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix("sys", fed, len(fed)),
		model:       c.model,
	}

	const shellID = provider.UserShellToolUseIDPrefix + "1_000000001"
	cont := []provider.Message{
		userMsg("do the thing"),
		assistantMsg("done"),
		userShellToolUseMsg(shellID, "make deploy"),
		toolResultMsg(shellID, "deployed ok"),
		userMsg("did that work?"),
	}
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("StopReason = %q, want end_turn", res.StopReason)
	}

	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("no CLI spawn recorded")
	}
	if last := trace[len(trace)-1]; last.ResumeID != warmUUID {
		t.Fatalf("spawn ResumeID = %q, want %q: a user's shell command cold-started the session", last.ResumeID, warmUUID)
	}
}

// TestUserShellQueuedDuringTurnResumesWarm: the user's command was queued while
// a turn ran and was promoted after that turn's tool call, so the doc holds the
// model's call and result, then the user's. The warm file ends on the model's
// dangling tool_use. Its result must be appended, and the user's command must
// not be taken for a second call the file is parked on.
func TestUserShellQueuedDuringTurnResumesWarm(t *testing.T) {
	userpathstest.Isolate(t)
	const warmUUID = "uuid-warm-usershell-queued"
	tracePath := installFakeClaude(t, fakeModeUntilClose, warmUUID)
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-usershell-queued"
	path := seedWarmSession(t, c.workingDir, warmUUID, "t1")

	fed := []provider.Message{userMsg("do the thing")}
	c.activeSession = &activeSession{
		sessionUUID: warmUUID,
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix("sys", fed, len(fed)),
		model:       c.model,
	}

	const shellID = provider.UserShellToolUseIDPrefix + "1_000000002"
	cont := []provider.Message{
		userMsg("do the thing"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "hi"),
		userShellToolUseMsg(shellID, "git status"),
		toolResultMsg(shellID, "clean"),
	}
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("StopReason = %q, want end_turn", res.StopReason)
	}

	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("no CLI spawn recorded")
	}
	if last := trace[len(trace)-1]; last.ResumeID != warmUUID {
		t.Fatalf("spawn ResumeID = %q, want %q: a queued user shell command cold-started the session", last.ResumeID, warmUUID)
	}
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("warm file = %d entries, want 3 (user, tool_use t1, appended tool_result t1)", len(entries))
	}
	if body, _ := json.Marshal(entries); strings.Contains(string(body), shellID) {
		t.Fatalf("the user's command was written into the warm file as a tool call: %s", body)
	}
}

// TestUserShellCallsAsText: each of the user's shell calls becomes one user
// message carrying the command and its output; the model's own calls, and
// everything else, pass through untouched.
func TestUserShellCallsAsText(t *testing.T) {
	const shellID = provider.UserShellToolUseIDPrefix + "1_000000003"
	failed := toolResultMsg(shellID, "exit status 2")
	failed.IsError = true
	req := provider.MessageRequest{Messages: []provider.Message{
		userMsg("hi"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "model output"),
		userShellToolUseMsg(shellID, "make deploy"),
		failed,
		userMsg("next"),
	}}
	original := append([]provider.Message(nil), req.Messages...)

	got := userShellCallsAsText(req).Messages
	if len(got) != 5 {
		t.Fatalf("got %d messages, want 5: %+v", len(got), got)
	}
	for i := range 3 {
		if hashMessage(&got[i]) != hashMessage(&original[i]) {
			t.Fatalf("message %d changed: %+v", i, got[i])
		}
	}
	shell := got[3]
	if shell.Type != "user" || shell.ToolUseID != "" {
		t.Fatalf("user shell call = %+v, want a plain user message", shell)
	}
	for _, want := range []string{"make deploy", "exit status 2", "error"} {
		if !strings.Contains(shell.Content, want) {
			t.Errorf("user shell text lacks %q:\n%s", want, shell.Content)
		}
	}
	if got[4].Content != "next" {
		t.Fatalf("trailing message = %+v, want the user's next message", got[4])
	}
	if hashMessage(&req.Messages[3]) != hashMessage(&original[3]) {
		t.Fatal("userShellCallsAsText modified the caller's slice")
	}
}
