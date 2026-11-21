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

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestPlanSyntheticSessionReturnsNil pins the ONLY meaning of a nil plan: a
// genuine cold start, with no prior history to preserve. Every other shape
// must produce a plan — see TestPlanSyntheticSessionNeverDropsAssistantHistory
// for why nil is never an acceptable answer when history exists.
func TestPlanSyntheticSessionReturnsNil(t *testing.T) {
	cases := []struct {
		name string
		msgs []provider.Message
	}{
		{"empty", nil},
		{"single user (no history to replay)", []provider.Message{{Type: "user", Content: "hi"}}},
	}
	for _, c := range cases {
		if got := planSyntheticSession(c.msgs, nil); got != nil {
			t.Errorf("%s: expected nil plan; got %+v", c.name, got)
		}
	}
}

// TestPlanSyntheticSessionNeverDropsAssistantHistory states the invariant the
// caller depends on: nil means "nothing to preserve", NEVER "history I am
// about to discard".
//
// startFreshSession reads a nil plan as a true first turn and spawns without
// --resume, then pipes only user-role content (formatMessagesAsStreamJSONLines
// drops assistant messages by design). So for any conversation that HAS
// history, a nil plan silently deletes every assistant turn and every tool_use
// block, leaving the tool_results orphaned — the model is handed a
// conversation in which it apparently never called a tool, and truthfully
// reports as much.
func TestPlanSyntheticSessionNeverDropsAssistantHistory(t *testing.T) {
	const openID = "toolu_open_call"
	// Every case shares real history: a user turn and an assistant answer.
	history := []provider.Message{
		{Type: "user", Content: "the original question"},
		{Type: "assistant", Content: "the original answer"},
	}
	cases := []struct {
		name string
		tail []provider.Message
	}{
		{"user tail (the ordinary continuation)", []provider.Message{
			{Type: "user", Content: "a follow-up question"},
		}},
		{"assistant tail (regenerate: last turn re-sent)", []provider.Message{
			{Type: "assistant", Content: "a regenerated answer"},
		}},
		{"assistant tail ending in an unanswered tool_use", []provider.Message{
			{Type: "tool-use", ToolUseID: openID, ToolName: "bash", ToolInput: map[string]any{"command": "ls"}},
		}},
	}
	for _, c := range cases {
		msgs := append(append([]provider.Message(nil), history...), c.tail...)
		plan := planSyntheticSession(msgs, jugglerToolNameSet([]provider.ToolDefinition{{Name: "bash"}}))
		if plan == nil {
			t.Errorf("%s: plan is nil, so %d messages of history get discarded; nil must mean cold start only",
				c.name, len(msgs))
			continue
		}
		// A preserved plan is worthless if the assistant turn didn't make it.
		var sawAssistant bool
		for _, m := range plan.historyToFile {
			if m.Role == "assistant" {
				sawAssistant = true
			}
		}
		if !sawAssistant {
			t.Errorf("%s: no assistant turn survived into history; roles: %v", c.name, roleSeq(plan.historyToFile))
		}
		// The CLI ignores a zero-content user message, so a plan with an empty
		// tail would stall instead of generating.
		if len(plan.tailContent) == 0 {
			t.Errorf("%s: tailContent is empty; the CLI needs a user turn to respond to", c.name)
		}
	}
}

// TestPlanSyntheticSessionAssistantTailPreservesHistory covers the shape a
// regenerate produces: the worker re-sends the conversation with the previous
// assistant reply still on the end, so the last API message is assistant-role.
// A nil plan there means startFreshSession spawns bare `-p` and falls back to
// piping user-role content only — every assistant turn and every tool_use
// block silently gone, the tool_results left orphaned. The model then denies
// having made tool calls it did make.
//
// The plan must instead carry the WHOLE conversation into the resumed file and
// put a nudge on stdin.
func TestPlanSyntheticSessionAssistantTailPreservesHistory(t *testing.T) {
	const toolUseID = "toolu_bash_start_server"
	plan := planSyntheticSession([]provider.Message{
		{Type: "user", Content: "check the fix end to end"},
		{Type: "assistant", Content: "Starting a headless server:"},
		{Type: "tool-use", ToolUseID: toolUseID, ToolName: "bash", ToolInput: map[string]any{
			"command": "juggler --port 45999",
		}},
		{Type: "tool-result", ToolUseID: toolUseID, Content: "AI Code Agent • v0.5.6"},
		{Type: "user", Content: "Suggest a short one line commit message"},
		{Type: "assistant", Content: "Fixed ReadJugglerSource fetching unversioned asset paths"},
	}, jugglerToolNameSet([]provider.ToolDefinition{{Name: "bash"}}))
	if plan == nil {
		t.Fatalf("expected non-nil plan for an assistant tail; nil discards the whole conversation")
	}

	// The assistant's tool_use must survive, under the prefixed name the CLI
	// records in its own sessions.
	var foundUse, foundResult, foundTailText bool
	for _, m := range plan.historyToFile {
		for _, b := range m.Content {
			switch {
			case m.Role == "assistant" && b.Type == "tool_use" && b.ID == toolUseID:
				foundUse = true
				if b.Name != mcpToolPrefix+"bash" {
					t.Errorf("tool_use name = %q; want %q", b.Name, mcpToolPrefix+"bash")
				}
			case m.Role == "user" && b.Type == "tool_result" && b.ToolUseID == toolUseID:
				foundResult = true
			case m.Role == "assistant" && b.Type == "text" &&
				strings.Contains(b.Text, "Fixed ReadJugglerSource"):
				foundTailText = true
			}
		}
	}
	if !foundUse {
		t.Errorf("assistant tool_use %s was dropped from history; roles: %v", toolUseID, roleSeq(plan.historyToFile))
	}
	if !foundResult {
		t.Errorf("tool_result for %s was dropped from history; roles: %v", toolUseID, roleSeq(plan.historyToFile))
	}
	if !foundTailText {
		t.Errorf("trailing assistant reply was dropped from history; roles: %v", roleSeq(plan.historyToFile))
	}

	// stdin can't be empty — the CLI ignores a zero-content user message — so
	// the tail is the nudge.
	if len(plan.tailContent) != 1 || plan.tailContent[0].Type != "text" ||
		plan.tailContent[0].Text != continuationNudge {
		t.Errorf("tailContent = %+v; want a single %q text block", plan.tailContent, continuationNudge)
	}
}

// TestPlanSyntheticSessionReframesLeadingAssistant guards against the
// Anthropic-API "first message must be user" rule. After conversation
// compaction the first juggler item is an assistant summary; without
// reframing, claude --resume of a JSONL starting with an assistant
// turn silently returns end_turn with zero tokens.
func TestPlanSyntheticSessionReframesLeadingAssistant(t *testing.T) {
	plan := planSyntheticSession([]provider.Message{
		{Type: "assistant", Content: "[Compacted summary of prior conversation]"},
		{Type: "user", Content: "first question after compaction"},
		{Type: "assistant", Content: "first answer"},
		{Type: "user", Content: "second question"},
	}, nil)
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}
	if len(plan.historyToFile) == 0 || plan.historyToFile[0].Role != "user" {
		t.Fatalf("historyToFile[0].Role = %q; want user (leading assistant must be reframed)",
			plan.historyToFile[0].Role)
	}
	head := plan.historyToFile[0]
	if len(head.Content) != 1 || head.Content[0].Type != "text" {
		t.Fatalf("reframed head should be a single text block; got %+v", head.Content)
	}
	if !strings.Contains(head.Content[0].Text, "Previous conversation summary:") {
		t.Errorf("reframed head missing summary prefix; got %q", head.Content[0].Text)
	}
	if !strings.Contains(head.Content[0].Text, "Compacted summary of prior conversation") {
		t.Errorf("reframed head dropped original summary text; got %q", head.Content[0].Text)
	}

	// Critical: after reframing the leading assistant as user, alternation
	// must still hold. Without a spliced-in empty assistant between the
	// new user and the original "first question" user, the Anthropic API
	// rejects (two consecutive users) and the CLI silently bails.
	wantRoles := []string{"user", "assistant", "user", "assistant"}
	if len(plan.historyToFile) != len(wantRoles) {
		t.Fatalf("history length = %d; want %d. Roles: %v",
			len(plan.historyToFile), len(wantRoles), roleSeq(plan.historyToFile))
	}
	for i, want := range wantRoles {
		if plan.historyToFile[i].Role != want {
			t.Errorf("historyToFile[%d].Role = %q; want %q. Full sequence: %v",
				i, plan.historyToFile[i].Role, want, roleSeq(plan.historyToFile))
		}
	}
	// The spliced empty assistant should be plan.historyToFile[1].
	if got := plan.historyToFile[1]; got.Role != "assistant" || len(got.Content) != 1 ||
		got.Content[0].Type != "text" || got.Content[0].Text != "" {
		t.Errorf("expected spliced empty assistant at [1]; got %+v", got)
	}
}

// TestPlanSyntheticSessionMovesTrailingToolResults covers the case
// where the loaded session would otherwise end with an open assistant
// tool_use and the matching tool_result lives in the tail user message.
// Empirically the CLI silently bails in that shape; the fix relocates
// those tool_results into history so the file ends fully paired and
// stdin carries only the user's text.
func TestPlanSyntheticSessionMovesTrailingToolResults(t *testing.T) {
	const danglingID = "toolu_TaskUpdate"
	plan := planSyntheticSession([]provider.Message{
		{Type: "user", Content: "kick off"},
		{Type: "tool-use", ToolUseID: danglingID, ToolName: "TaskUpdate", ToolInput: map[string]any{"status": "done"}},
		{Type: "tool-result", ToolUseID: danglingID, Content: "Unknown tool: TaskUpdate", IsError: true},
		{Type: "user", Content: "my actual question"},
	}, nil)
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}
	// History should end with `user: tool_result(danglingID)` (relocated).
	last := plan.historyToFile[len(plan.historyToFile)-1]
	if last.Role != "user" {
		t.Fatalf("expected history to end with user (tool_result relocated); got role=%s", last.Role)
	}
	foundResult := false
	for _, b := range last.Content {
		if b.Type == "tool_result" && b.ToolUseID == danglingID {
			foundResult = true
		}
	}
	if !foundResult {
		t.Errorf("expected relocated tool_result in last history entry; content=%+v", last.Content)
	}
	// Tail should be text-only — no tool_result.
	for _, b := range plan.tailContent {
		if b.Type == "tool_result" {
			t.Errorf("tail still contains tool_result after relocation; got %+v", b)
		}
	}
	// Tail should still have the user's question text.
	foundText := false
	for _, b := range plan.tailContent {
		if b.Type == "text" && strings.Contains(b.Text, "my actual question") {
			foundText = true
		}
	}
	if !foundText {
		t.Errorf("tail dropped user's text; got %+v", plan.tailContent)
	}
}

// TestPlanSyntheticSessionTailResultPreventsDuplicate covers the
// real-world failure where the user's NEW message contains the
// tool_result for the dangling tool_use at the end of history. With
// the trailing-tool-result relocation in place that tool_result moves
// into history (not synthesized), and the orphan repair must not add
// a duplicate on top. Double-pairing makes Anthropic reject and the
// CLI bails silently.
func TestPlanSyntheticSessionTailResultPreventsDuplicate(t *testing.T) {
	const danglingID = "toolu_TaskUpdate_handled_in_tail"
	plan := planSyntheticSession([]provider.Message{
		{Type: "user", Content: "do a thing"},
		{Type: "tool-use", ToolUseID: danglingID, ToolName: "TaskUpdate", ToolInput: map[string]any{"status": "done"}},
		// The user's next message group: a tool_result (juggler-generated
		// "Unknown tool" error for the unhandled TaskUpdate call) plus a
		// new question. These collapse into one user APIMessage which
		// becomes the tail; the relocation moves the tool_result into
		// history while leaving the text in the tail.
		{Type: "tool-result", ToolUseID: danglingID, Content: "Unknown tool: TaskUpdate", IsError: true},
		{Type: "user", Content: "next question"},
	}, nil)
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}
	count := 0
	for _, m := range plan.historyToFile {
		if m.Role != "user" {
			continue
		}
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.ToolUseID == danglingID {
				count++
			}
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one tool_result for %s in history (the relocated real one); got %d", danglingID, count)
	}
}

// TestPlanSyntheticSessionRepairsOrphanToolUse covers the real-world
// failure where the model called a Claude-native tool juggler doesn't
// handle (TaskUpdate, etc.) so the conversation ends up with an
// assistant tool_use that never got a tool_result. Without repair the
// Anthropic API rejects on resume and the CLI silently emits empty
// end_turn.
func TestPlanSyntheticSessionRepairsOrphanToolUse(t *testing.T) {
	const orphanID = "toolu_orphan_TaskUpdate"
	plan := planSyntheticSession([]provider.Message{
		{Type: "user", Content: "do a thing"},
		{Type: "tool-use", ToolUseID: orphanID, ToolName: "TaskUpdate", ToolInput: map[string]any{"status": "done"}},
		// NOTE: no matching tool-result for orphanID.
		{Type: "user", Content: "another question"},
	}, nil)
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}
	// Look for the synthesised tool_result anywhere in the history.
	var found *anthropic.APIContentBlock
	for _, m := range plan.historyToFile {
		if m.Role != "user" {
			continue
		}
		for i := range m.Content {
			if m.Content[i].Type == "tool_result" && m.Content[i].ToolUseID == orphanID {
				found = &m.Content[i]
				break
			}
		}
	}
	if found == nil {
		t.Fatalf("orphan tool_use %s was not repaired; history: %+v", orphanID, plan.historyToFile)
	}
	if !found.IsError {
		t.Errorf("synthetic tool_result should set is_error=true; got %+v", found)
	}
	if found.Content == "" {
		t.Errorf("synthetic tool_result should have explanatory content; got empty")
	}
}

func roleSeq(msgs []anthropic.APIMessage) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = m.Role
	}
	return out
}

func TestPlanSyntheticSessionMultiTurnEndsOnUser(t *testing.T) {
	plan := planSyntheticSession([]provider.Message{
		{Type: "user", Content: "first question"},
		{Type: "assistant", Content: "first answer"},
		{Type: "user", Content: "second question"},
	}, nil)
	if plan == nil {
		t.Fatalf("expected non-nil plan for 3-message history")
	}
	if len(plan.historyToFile) != 2 ||
		plan.historyToFile[0].Role != "user" ||
		plan.historyToFile[1].Role != "assistant" {
		t.Fatalf("historyToFile = %+v; want [user, assistant]", plan.historyToFile)
	}
	if len(plan.tailContent) == 0 {
		t.Fatalf("tailContent empty; want trailing user turn")
	}
	if !strings.Contains(plan.sessionUUID, "-") {
		t.Fatalf("sessionUUID looks unset/invalid: %q", plan.sessionUUID)
	}
}

func TestWriteSyntheticSessionToolUseShape(t *testing.T) {
	// Mirrors the production scenario: user → assistant tool_use →
	// user tool_result → user (new question). The CLI must see the
	// tool_use/tool_result pair as authentic history so the model
	// doesn't deny having made the tool call.
	const toolUseID = "toolu_test_create_thread_001"
	msgs := []provider.Message{
		{Type: "user", Content: "spawn a thread to review the Go backend"},
		{Type: "tool-use", ToolUseID: toolUseID, ToolName: "create_thread", ToolInput: map[string]any{
			"goal":   "Review Go backend",
			"prompt": "Examine cmd/juggler",
		}},
		{Type: "tool-result", ToolUseID: toolUseID, Content: "[Completed Thread: Review Go backend]\nFindings: ..."},
		{Type: "user", Content: "what thread did you spawn?"},
	}
	plan := planSyntheticSession(msgs, jugglerToolNameSet([]provider.ToolDefinition{{Name: "create_thread"}}))
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}

	// Isolate ~/.claude under the test's tempdir. Isolate sets USERPROFILE too,
	// which is what os.UserHomeDir resolves on Windows.
	userpathstest.Isolate(t)

	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	path, err := writeSyntheticSession(workingDir, "", plan)
	if err != nil {
		t.Fatalf("writeSyntheticSession: %v", err)
	}
	wantDir := filepath.Join(os.Getenv("HOME"), ".claude", "projects", ProjectDirName(workingDir))
	if filepath.Dir(path) != wantDir {
		t.Fatalf("session file under %q; want %q", filepath.Dir(path), wantDir)
	}
	if filepath.Base(path) != plan.sessionUUID+".jsonl" {
		t.Fatalf("session filename %q; want %s.jsonl", filepath.Base(path), plan.sessionUUID)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	// TransformToAPIMessagesForCLI groups consecutive same-role messages
	// into one API message — four input messages collapse to three:
	// user, assistant(tool_use), user(tool_result + text). The
	// moveTrailingToolResultsToHistory step then relocates the tool_result
	// out of the tail and into history (so the file ends with a fully-
	// paired tool call and the tail is text-only), giving three file
	// entries: user, assistant(tool_use), user(tool_result).
	if len(lines) != 3 {
		t.Fatalf("expected 3 file entries; got %d. Content:\n%s", len(lines), string(data))
	}

	type entry struct {
		Type           string         `json:"type"`
		UUID           string         `json:"uuid"`
		ParentUUID     *string        `json:"parentUuid"`
		IsSidechain    bool           `json:"isSidechain"`
		Message        map[string]any `json:"message"`
		Timestamp      string         `json:"timestamp"`
		UserType       string         `json:"userType"`
		Entrypoint     string         `json:"entrypoint"`
		Cwd            string         `json:"cwd"`
		SessionID      string         `json:"sessionId"`
		Version        string         `json:"version"`
		GitBranch      string         `json:"gitBranch"`
		PromptID       string         `json:"promptId,omitempty"`
		PermissionMode string         `json:"permissionMode,omitempty"`
	}
	var entries []entry
	for i, line := range lines {
		var e entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("line %d not valid JSON: %v\n%s", i, err, line)
		}
		entries = append(entries, e)
	}

	// Field-set checks shared by every entry.
	for i, e := range entries {
		if e.UUID == "" {
			t.Errorf("entry %d: missing uuid", i)
		}
		if e.SessionID != plan.sessionUUID {
			t.Errorf("entry %d: sessionId=%q; want %q", i, e.SessionID, plan.sessionUUID)
		}
		if e.Cwd != workingDir {
			t.Errorf("entry %d: cwd=%q; want %q", i, e.Cwd, workingDir)
		}
		if e.UserType != "external" {
			t.Errorf("entry %d: userType=%q; want external", i, e.UserType)
		}
		if e.Entrypoint != "sdk-cli" {
			t.Errorf("entry %d: entrypoint=%q; want sdk-cli", i, e.Entrypoint)
		}
		if e.Version == "" {
			t.Errorf("entry %d: missing version", i)
		}
		if e.Timestamp == "" {
			t.Errorf("entry %d: missing timestamp", i)
		}
	}

	// parentUuid chain: first is null, rest reference the previous entry.
	if entries[0].ParentUUID != nil {
		t.Errorf("entry 0: parentUuid = %v; want null", entries[0].ParentUUID)
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].ParentUUID == nil || *entries[i].ParentUUID != entries[i-1].UUID {
			got := "<nil>"
			if entries[i].ParentUUID != nil {
				got = *entries[i].ParentUUID
			}
			t.Errorf("entry %d: parentUuid=%s; want %s (uuid of entry %d)", i, got, entries[i-1].UUID, i-1)
		}
	}

	// Role/type shape.
	if entries[0].Type != "user" || entries[1].Type != "assistant" || entries[2].Type != "user" {
		t.Errorf("type chain = %q,%q,%q; want user,assistant,user",
			entries[0].Type, entries[1].Type, entries[2].Type)
	}

	// User entry must carry promptId + permissionMode.
	if entries[0].PromptID == "" {
		t.Errorf("entry 0 (user): missing promptId")
	}
	if entries[0].PermissionMode != "default" {
		t.Errorf("entry 0 (user): permissionMode=%q; want default", entries[0].PermissionMode)
	}

	// Decisive: the assistant entry contains a tool_use block with the
	// real toolUseId / name / input — the whole point of Path 2. If this
	// fails, the model will deny having spawned the thread.
	asst := entries[1].Message
	if role, _ := asst["role"].(string); role != "assistant" {
		t.Errorf("assistant entry message.role = %v; want assistant", asst["role"])
	}
	contentList, ok := asst["content"].([]any)
	if !ok {
		t.Fatalf("assistant entry content not an array: %T", asst["content"])
	}
	foundToolUse := false
	for _, b := range contentList {
		block, ok := b.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] != "tool_use" {
			continue
		}
		foundToolUse = true
		if block["id"] != toolUseID {
			t.Errorf("tool_use id = %v; want %q", block["id"], toolUseID)
		}
		// Must be the mcp__juggler__-prefixed name the CLI actually exposes —
		// the bare "create_thread" would make the resumed model imitate a name
		// the CLI rejects ("No such tool available"), forcing a re-call.
		if block["name"] != "mcp__juggler__create_thread" {
			t.Errorf("tool_use name = %v; want mcp__juggler__create_thread", block["name"])
		}
		input, ok := block["input"].(map[string]any)
		if !ok {
			t.Fatalf("tool_use input not an object: %T", block["input"])
		}
		if input["goal"] != "Review Go backend" {
			t.Errorf("tool_use input.goal = %v; want %q", input["goal"], "Review Go backend")
		}
		if input["prompt"] != "Examine cmd/juggler" {
			t.Errorf("tool_use input.prompt = %v; want %q", input["prompt"], "Examine cmd/juggler")
		}
	}
	if !foundToolUse {
		t.Errorf("assistant entry has no tool_use block: %v", contentList)
	}

	// Tail (what gets piped to stdin). Two adjacent user-role messages
	// (the tool_result and the new question) collapse into one API
	// After moveTrailingToolResultsToHistory relocates the trailing
	// tool_result into history (so the file ends with a fully-paired
	// tool call), the tail carries ONLY the user's new text.
	var tail map[string]any
	if err := json.Unmarshal(tailStdinLine(plan), &tail); err != nil {
		t.Fatalf("tail not valid JSON: %v", err)
	}
	if tail["type"] != "user" {
		t.Errorf("tail.type = %v; want user", tail["type"])
	}
	if tail["session_id"] != plan.sessionUUID {
		t.Errorf("tail.session_id = %v; want %q", tail["session_id"], plan.sessionUUID)
	}
	tailMsg, _ := tail["message"].(map[string]any)
	tailContent, _ := tailMsg["content"].([]any)
	if len(tailContent) != 1 {
		t.Fatalf("tail content len = %d; want 1 (text only); content=%v", len(tailContent), tailContent)
	}
	txt, _ := tailContent[0].(map[string]any)
	if txt["type"] != "text" || txt["text"] != "what thread did you spawn?" {
		t.Errorf("tail block 0 = %v; want text=\"what thread did you spawn?\"", txt)
	}
	// And the relocated tool_result must live in history with the
	// correct tool_use_id so the model can pair it with the assistant
	// tool_use that's two entries earlier in the file.
	thirdMsg := entries[2].Message
	thirdContent, _ := thirdMsg["content"].([]any)
	if len(thirdContent) != 1 {
		t.Fatalf("history entry 2 content len = %d; want 1 tool_result", len(thirdContent))
	}
	tr, _ := thirdContent[0].(map[string]any)
	if tr["type"] != "tool_result" || tr["tool_use_id"] != toolUseID {
		t.Errorf("history entry 2 block = %v; want tool_result for %q", tr, toolUseID)
	}
}

// TestSyntheticTranscript_ToolInputAlwaysValidJSON is a regression lock on the
// invariant that juggler NEVER hands the CLI a malformed tool input — the
// builder-side complement to parser.go's stream-side guard.
//
// Context: the "tool/request divergence" cascade was triggered by a malformed
// tool input (`{"offset": 142"}`, a stray quote) that desynced tool-result
// delivery. parser.go now catches such bytes when they arrive FROM the CLI's
// stdout stream. This test pins the other direction — the bytes juggler writes
// TO the CLI (the synthetic --resume transcript and the stdin tail). Today that
// is malformed-proof by construction: tool inputs flow as map[string]any
// (provider.Message.ToolInput → APIContentBlock.Input) and reach the wire only
// through json.Marshal, which is total over JSON-safe Go values. This test
// guards that property so a future "preserve the exact bytes" refactor —
// switching Input to json.RawMessage/string, or hand-building the input JSON by
// concatenation — can't silently reopen the malformed-input path. It feeds
// adversarial inputs whose string VALUES contain the exact characters (quotes,
// braces, backslashes, a number adjacent to a quoted sibling) that break naive
// non-json.Marshal serialization, and asserts every emitted line round-trips.
func TestSyntheticTranscript_ToolInputAlwaysValidJSON(t *testing.T) {
	const toolUseID = "toolu_adversarial_input_001"
	// Values chosen to break any serializer that isn't json.Marshal: embedded
	// quotes, a stray-quote-after-number shape, backslashes, braces, newlines,
	// and a nested object/array carrying the same hazards.
	toolInput := map[string]any{
		"file_path": `cmd/juggler/"weird".go`,
		"pattern":   `offset": 142" , "limit`, // literally the bug's byte shape, as a value
		"escapes":   "line1\nline2\ttab\\back\"quote",
		"offset":    142,
		"limit":     60,
		"nested": map[string]any{
			"q":   `"`,
			"arr": []any{1, `}`, `"x"`, "a\\b"},
		},
	}
	msgs := []provider.Message{
		{Type: "user", Content: "search for the thing"},
		{Type: "tool-use", ToolUseID: toolUseID, ToolName: "grep", ToolInput: toolInput},
		{Type: "tool-result", ToolUseID: toolUseID, Content: "no matches"},
		{Type: "user", Content: "ok, what next?"},
	}
	plan := planSyntheticSession(msgs, jugglerToolNameSet([]provider.ToolDefinition{{Name: "grep"}}))
	if plan == nil {
		t.Fatalf("expected non-nil plan")
	}

	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	path, err := writeSyntheticSession(workingDir, "", plan)
	if err != nil {
		t.Fatalf("writeSyntheticSession: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}

	// Invariant 1: every transcript line is valid JSON. A malformed input would
	// make its line unparseable — exactly the failure parser.go saw inbound.
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	var foundToolUse bool
	for i, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("transcript line %d is not valid JSON: %v\n%s", i, err, line)
		}
		msg, _ := entry["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		for _, b := range content {
			block, _ := b.(map[string]any)
			if block["type"] != "tool_use" {
				continue
			}
			foundToolUse = true
			// Invariant 2: the tool_use input is a JSON object that round-trips
			// byte-for-byte to the original (canonical-marshal both — encoding/json
			// sorts map keys and normalises 142/142.0 consistently on each side).
			gotInput, ok := block["input"].(map[string]any)
			if !ok {
				t.Fatalf("line %d tool_use input is not an object: %T", i, block["input"])
			}
			want, _ := json.Marshal(toolInput)
			got, _ := json.Marshal(gotInput)
			if string(want) != string(got) {
				t.Errorf("tool_use input did not round-trip:\n want %s\n  got %s", want, got)
			}
		}
	}
	if !foundToolUse {
		t.Fatalf("no tool_use block found in transcript:\n%s", string(data))
	}

	// Invariant 3: the stdin tail (the other thing juggler writes to the CLI) is
	// valid JSON too. It carries no tool_use here, but the same json.Marshal path
	// guards it, and a regression would surface as an unparseable envelope.
	if err := json.Unmarshal(tailStdinLine(plan), new(map[string]any)); err != nil {
		t.Fatalf("stdin tail is not valid JSON: %v", err)
	}
}
