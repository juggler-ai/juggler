//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// seedWarmSession writes a minimal CLI-native session file ending on the
// assistant tool_use(s) the CLI parked on. It mirrors the real CLI's layout of
// ONE ENTRY PER CONTENT BLOCK: a turn calling two tools in parallel becomes two
// chained assistant entries (uuid-asst-1, uuid-asst-2, …), one tool_use each —
// not a single entry carrying both. Returns the file path.
func seedWarmSession(t *testing.T, workingDir, sessionUUID string, toolUseIDs ...string) string {
	t.Helper()
	dir := projectsDir(workingDir, "")
	if dir == "" {
		t.Fatal("projectsDir empty (HOME not isolated?)")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	entries := []map[string]any{newSyntheticEntry("user",
		[]map[string]any{{"type": "text", "text": "do the thing"}},
		"uuid-user-1", nil, sessionUUID, workingDir, time.Now())}
	parent := "uuid-user-1"
	for i, id := range toolUseIDs {
		uuid := fmt.Sprintf("uuid-asst-%d", i+1)
		entries = append(entries, newSyntheticEntry("assistant", []map[string]any{{
			"type": "tool_use", "id": id, "name": "bash", "input": map[string]any{"command": "echo hi"},
		}}, uuid, parent, sessionUUID, workingDir, time.Now()))
		parent = uuid
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

// appendRawEntries appends already-shaped JSONL records to a session file,
// used to reproduce the CLI's own non-message bookkeeping records (last-prompt,
// ai-title, mode, queue-operation) which carry no uuid and are not part of the
// parentUuid chain.
func appendRawEntries(t *testing.T, path string, entries ...map[string]any) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open %s for append: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal bookkeeping entry: %v", err)
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			t.Fatalf("append bookkeeping entry: %v", err)
		}
	}
}

// readJSONL parses a JSONL file into a slice of generic entry maps.
func readJSONL(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var e map[string]any
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("unmarshal line %q: %v", line, err)
		}
		out = append(out, e)
	}
	return out
}

// TestAppendToolResultsToWarmSession_HappyPath checks the appended entry closes
// the dangling tool_use: it is a user tool_result chained to the prior tail, in
// the same uuid file, leaving the warm prefix byte-for-byte intact.
func TestAppendToolResultsToWarmSession_HappyPath(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-warm-append"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	results := []provider.Message{toolResultMsg("call_1", "the answer")}
	if err := c.appendToolResultsToWarmSession(results, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v", err)
	}

	// The original two entries must be untouched (warm prefix preserved); a third
	// is appended.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatalf("warm prefix was modified — cache would miss.\nbefore:\n%s\nafter:\n%s", before, after)
	}
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries after append; got %d", len(entries))
	}
	last := entries[2]
	if last["type"] != "user" {
		t.Fatalf("appended entry type = %v, want user", last["type"])
	}
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 (chains to the dangling tool_use)", last["parentUuid"])
	}
	if last["sessionId"] != uuid {
		t.Fatalf("appended entry sessionId = %v, want %s (re-resumes the same warm uuid)", last["sessionId"], uuid)
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("appended message content = %v, want one tool_result block", msg["content"])
	}
	block, _ := content[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "call_1" || block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want tool_result for call_1 with the answer", block)
	}
}

// TestAppendToolResultsToWarmSession_MissingFile errors (so the caller falls back
// to a fresh synthetic resume) when no warm session file exists on disk.
func TestAppendToolResultsToWarmSession_MissingFile(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: "uuid-absent"}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil); err == nil {
		t.Fatal("expected an error for a missing warm session file (forces fresh fallback); got nil")
	}
}

// TestAppendToolResultsToWarmSession_TailNotToolUse errors when the file's last
// entry is not the dangling assistant tool_use the result answers — appending
// there would break tool_use/tool_result adjacency, so we must cold-start.
func TestAppendToolResultsToWarmSession_TailNotToolUse(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-tail-text"
	dir := projectsDir(workingDir, "")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	// A session whose last entry is a plain assistant text turn (no tool_use).
	entry := newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "all done"}},
		"uuid-asst-text", nil, uuid, workingDir, time.Now())
	line, _ := json.Marshal(entry)
	path := filepath.Join(dir, uuid+".jsonl")
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil); err == nil {
		t.Fatal("expected an error when the tail entry isn't a tool_use; got nil")
	}
}

// TestAppendToolResultsToWarmSession_SkipsTrailingBookkeeping appends when the
// dangling tool_use is buried under the CLI's own bookkeeping records. The CLI
// interleaves uuid-less entries (last-prompt, ai-title, mode, queue-operation)
// into the session file, so the tool_use it parked on is routinely not the
// file's physically-last line — treating those records as the tail wrongly
// cold-started an otherwise perfectly warm session.
func TestAppendToolResultsToWarmSession_SkipsTrailingBookkeeping(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-bookkeeping-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		map[string]any{"type": "last-prompt", "lastPrompt": "do the thing", "leafUuid": "uuid-asst-1", "sessionId": uuid},
		map[string]any{"type": "ai-title", "title": "Do The Thing"},
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (bookkeeping records after the tool_use must not force a cold start)", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatalf("warm prefix was modified — cache would miss.\nbefore:\n%s\nafter:\n%s", before, after)
	}
	entries := readJSONL(t, path)
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries (user, tool_use, last-prompt, ai-title, appended result); got %d", len(entries))
	}
	last := entries[4]
	if last["type"] != "user" {
		t.Fatalf("appended entry type = %v, want user", last["type"])
	}
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 — it must chain to the dangling tool_use, not to a bookkeeping record", last["parentUuid"])
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("appended message content = %v, want one tool_result block", msg["content"])
	}
	block, _ := content[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "call_1" || block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want tool_result for call_1 with the answer", block)
	}
}

// TestAppendToolResultsToWarmSession_BookkeepingOverTextTurnStillRefuses locks
// in the real invariant while skipping bookkeeping records: when the last actual
// MESSAGE is a plain assistant text turn, there is no dangling tool_use to
// close and we must still cold-start. Skipping uuid-less records must not
// degrade into accepting any tail at all.
func TestAppendToolResultsToWarmSession_BookkeepingOverTextTurnStillRefuses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-text-under-bookkeeping"
	dir := projectsDir(workingDir, "")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	entry := newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "all done"}},
		"uuid-asst-text", nil, uuid, workingDir, time.Now())
	line, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal entry: %v", err)
	}
	path := filepath.Join(dir, uuid+".jsonl")
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("write session: %v", err)
	}
	appendRawEntries(t, path,
		map[string]any{"type": "last-prompt", "lastPrompt": "do the thing", "leafUuid": "uuid-asst-text", "sessionId": uuid},
	)

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	err = c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil)
	if err == nil {
		t.Fatal("expected an error when the last message is a text turn with no dangling tool_use; got nil")
	}
	// It must refuse because there is no tool_use to close, NOT because it
	// tripped over the uuid-less bookkeeping record on the way — otherwise this
	// test would keep passing even if tail-scanning regressed.
	if !strings.Contains(err.Error(), "tool_use") {
		t.Fatalf("refusal reason = %q, want it to name the missing tool_use (a uuid complaint means the bookkeeping record was treated as the tail)", err)
	}
}

// TestWarmAppendResume_EndToEndResumesWarm drives the user-reported bug all the
// way through dispatch with a REAL warm session file on disk: a tool is parked,
// the live CLI is gone, and the continuation carries the cancelled result plus a
// fresh user message. The turn must re-resume the SAME warm uuid (proving the
// prompt cache stays warm — not a fresh synthetic cold start) and the warm file
// must gain the paired tool_result entry.
func TestWarmAppendResume_EndToEndResumesWarm(t *testing.T) {
	userpathstest.Isolate(t)
	const warmUUID = "uuid-warm-e2e"
	tracePath := installFakeClaude(t, fakeModeUntilClose, warmUUID)
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-warm-e2e"

	// Seed the CLI's own warm session file, ending on the assistant tool_use the
	// worker parked on (what the real CLI leaves on disk).
	path := seedWarmSession(t, c.workingDir, warmUUID, "t1")

	// Anchor the resume at the park: only the user prompt was fed (the assistant
	// tool_use is in the warm file but not in sentCount). No live CLI, no pending
	// tools — exactly the post-cancel / post-restart shape.
	fed := []provider.Message{userMsg("do the thing")}
	c.activeSession = &activeSession{
		sessionUUID: warmUUID,
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix("sys", fed, len(fed)),
		model:       c.model,
	}

	// Continuation: the doc holds the assistant tool_use, t1's cancelled result,
	// and the user's fresh message.
	cont := []provider.Message{
		userMsg("do the thing"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "Cancelled"),
		userMsg("do this instead"),
	}
	if res := sendMsg(t, c, convID, cont); res.StopReason != "end_turn" {
		t.Fatalf("warm-append turn: StopReason = %q, want end_turn", res.StopReason)
	}

	// The spawn must have --resumed the warm uuid, NOT a freshly-minted synthetic
	// one (which is what a cold fallback would do).
	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("no CLI spawn recorded")
	}
	last := trace[len(trace)-1]
	if last.ResumeID != warmUUID {
		t.Fatalf("warm-append spawn ResumeID = %q, want %q (a fresh synthetic uuid means it cold-started instead of warm-appending)", last.ResumeID, warmUUID)
	}

	// The warm file must now carry the paired tool_result, appended after the
	// dangling tool_use (warm prefix preserved, three entries total).
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("warm file = %d entries, want 3 (user, assistant tool_use, appended user tool_result)", len(entries))
	}
	last3 := entries[2]
	if last3["type"] != "user" || last3["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry = %+v, want a user tool_result chained to uuid-asst-1", last3)
	}
	msg, _ := last3["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("appended content = %v, want one tool_result block", msg["content"])
	}
	block, _ := content[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "t1" || block["content"] != "Cancelled" {
		t.Fatalf("appended block = %+v, want tool_result for t1 with Cancelled", block)
	}
}

// abortEntry builds the `user` tool_result a CLI journals when it is handed an
// abandoned-call marker for the tool it was parked on.
func abortEntry(workingDir, sessionUUID, entryUUID, parentUUID, toolUseID string) map[string]any {
	return newSyntheticEntry("user", []map[string]any{{
		"type": "tool_result", "tool_use_id": toolUseID,
		"content": teardownAbortResultText, "is_error": true,
	}}, entryUUID, parentUUID, sessionUUID, workingDir, time.Now())
}

// TestAppendToolResultsToWarmSession_HealsAbandonedCallTail appends when the
// file ends on an abandoned-call marker instead of the dangling tool_use.
//
// This is the shape a tool parked across an app restart leaves behind: the
// marker answers a call that was never actually aborted, only deferred, and the
// real result is the one arriving now. Refusing here cold-started a fully warm
// conversation — ~70k tokens re-read to deliver one plan approval.
func TestAppendToolResultsToWarmSession_HealsAbandonedCallTail(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-abort-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path, abortEntry(workingDir, uuid, "uuid-abort-1", "uuid-asst-1", "call_1"))

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (an abandoned-call marker must not force a cold start)", err)
	}

	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (user, tool_use, real result); got %d — the marker must be cut, not kept", len(entries))
	}
	last := entries[2]
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 (chains to the tool_use, not to the marker)", last["parentUuid"])
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want the real result for call_1", block)
	}
}

// TestAppendToolResultsToWarmSession_HealsStrandedTurnAfterAbandonedCall cuts
// past an assistant turn generated FROM the marker as well. An orphaned CLI
// outlives its parent by a few seconds and can spend that time replying to the
// marker and journalling the reply — a turn no one ever saw, sitting between us
// and the tool_use.
func TestAppendToolResultsToWarmSession_HealsStrandedTurnAfterAbandonedCall(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-stranded-turn"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		abortEntry(workingDir, uuid, "uuid-abort-1", "uuid-asst-1", "call_1"),
		newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "That didn't land."}},
			"uuid-ghost-1", "uuid-abort-1", uuid, workingDir, time.Now()),
		map[string]any{"type": "last-prompt", "lastPrompt": "do the thing", "leafUuid": "uuid-ghost-1", "sessionId": uuid},
	)

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (a stranded turn must not force a cold start)", err)
	}

	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries; got %d — the marker, the stranded turn and its stale last-prompt must all be cut", len(entries))
	}
	if entries[2]["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1", entries[2]["parentUuid"])
	}
}

// TestAppendToolResultsToWarmSession_HealsCLIClosedCallTail appends when the
// file ends on a result the CLI synthesised for itself while being torn down.
//
// A CLI killed while parked on a tools/call closes that call in its own words —
// the observed one is "(<tool> completed with no output)", no is_error, no
// marker text of ours. It is still an answer to a call whose real result is only
// arriving now, so it is cut like any other teardown wreckage; refusing here
// cold-started a fully warm conversation for 80k tokens.
func TestAppendToolResultsToWarmSession_HealsCLIClosedCallTail(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-cli-closed-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path, newSyntheticEntry("user", []map[string]any{{
		"type": "tool_result", "tool_use_id": "call_1",
		"content": "(mcp__juggler__Explore completed with no output)",
	}}, "uuid-cli-closed-1", "uuid-asst-1", uuid, workingDir, time.Now()))

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (a call the CLI closed on its way down must not force a cold start)", err)
	}

	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (user, tool_use, real result); got %d — the CLI's own closing result must be cut, not kept", len(entries))
	}
	last := entries[2]
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 (chains to the tool_use, not to the CLI's closing result)", last["parentUuid"])
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want the real result for call_1", block)
	}
}

// cliAttachmentEntry builds one of the CLI's `attachment` records — here the
// total_tokens_reminder it writes straight after a user entry. Unlike
// last-prompt or ai-title it carries a uuid AND a parentUuid, so it is
// indistinguishable from a real turn to anything keying on "has a uuid".
func cliAttachmentEntry(entryUUID, parentUUID, sessionUUID string, attachment map[string]any) map[string]any {
	return map[string]any{
		"type":       "attachment",
		"uuid":       entryUUID,
		"parentUuid": parentUUID,
		"sessionId":  sessionUUID,
		"timestamp":  time.Now().UTC().Format(time.RFC3339Nano),
		"entrypoint": "sdk-cli",
		"attachment": attachment,
	}
}

// tokensReminder is the attachment the CLI appends after nearly every user
// entry, so a journalled tool_result is almost never the file's last line.
func tokensReminder() map[string]any {
	return map[string]any{"type": "total_tokens_reminder", "text": "<total_tokens>14895227 tokens left</total_tokens>"}
}

// TestAppendToolResultsToWarmSession_HealsCLIClosedCallTailUnderAttachment is
// the shape a reaped CLI actually leaves on disk: it closes the parked call in
// its own words and then writes its total_tokens_reminder after that, burying
// the stale answer one entry deep.
//
// The attachment carries a uuid, so a scan that treats every uuid-bearing entry
// as a message stops on it, never reaches the stale result to cut it, and
// reports a tail of "attachment" — cold-starting a warm conversation for 97k
// tokens on a tool that was only ever waiting for an approval.
func TestAppendToolResultsToWarmSession_HealsCLIClosedCallTailUnderAttachment(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-attachment-over-closed-call"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		newSyntheticEntry("user", []map[string]any{{
			"type": "tool_result", "tool_use_id": "call_1",
			"content": "(mcp__juggler__bash completed with no output)",
		}}, "uuid-cli-closed-1", "uuid-asst-1", uuid, workingDir, time.Now()),
		cliAttachmentEntry("uuid-attach-1", "uuid-cli-closed-1", uuid, tokensReminder()),
	)

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (an attachment written over the CLI's own closing result must not force a cold start)", err)
	}

	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (user, tool_use, real result); got %d — the closing result and the attachment chained to it must both be cut", len(entries))
	}
	last := entries[2]
	if last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry parentUuid = %v, want uuid-asst-1 (chains to the tool_use, not to the wreckage)", last["parentUuid"])
	}
	msg, _ := last["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want the real result for call_1", block)
	}
}

// TestAppendToolResultsToWarmSession_HealsCLIClosedCallTailForParallelCalls is
// the same wreckage left by a turn parked on TWO calls at once, which is what a
// quit mid-turn usually catches.
//
// The CLI journals one entry per content block on the way down too, so it closes
// each parked call in its own entry: the file ends on a RUN of stale answers, one
// per call, under the usual attachment. A cut that stops at the newest of them
// leaves the older one as the tail, and the tail scan reports a file ending in
// "user" — cold-starting a warm conversation exactly as if nothing had been cut.
func TestAppendToolResultsToWarmSession_HealsCLIClosedCallTailForParallelCalls(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-parallel-closed-calls"
	path := seedWarmSession(t, workingDir, uuid, "call_1", "call_2")
	appendRawEntries(t, path,
		newSyntheticEntry("user", []map[string]any{{
			"type": "tool_result", "tool_use_id": "call_1",
			"content": "(mcp__juggler__bash completed with no output)",
		}}, "uuid-cli-closed-1", "uuid-asst-1", uuid, workingDir, time.Now()),
		newSyntheticEntry("user", []map[string]any{{
			"type": "tool_result", "tool_use_id": "call_2",
			"content": "(mcp__juggler__bash completed with no output)",
		}}, "uuid-cli-closed-2", "uuid-asst-2", uuid, workingDir, time.Now()),
		cliAttachmentEntry("uuid-attach-1", "uuid-cli-closed-2", uuid, tokensReminder()),
	)

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	results := []provider.Message{toolResultMsg("call_1", "first answer"), toolResultMsg("call_2", "second answer")}
	if err := c.appendToolResultsToWarmSession(results, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (both closing results must be cut, not just the last)", err)
	}

	entries := readJSONL(t, path)
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries (user, 2 tool_use, 2 real results); got %d — every one of the CLI's closing results must be cut", len(entries))
	}
	for i, want := range []struct{ parent, content string }{
		{"uuid-asst-1", "first answer"},
		{"uuid-asst-2", "second answer"},
	} {
		entry := entries[3+i]
		if entry["parentUuid"] != want.parent {
			t.Fatalf("appended entry %d parentUuid = %v, want %s (each result chains to the tool_use it answers)", i, entry["parentUuid"], want.parent)
		}
		msg, _ := entry["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		block, _ := content[0].(map[string]any)
		if block["content"] != want.content {
			t.Fatalf("appended block %d = %+v, want the real result %q", i, block, want.content)
		}
	}
}

// TestAppendToolResultsToWarmSession_SkipsTrailingUUIDBearingRecords appends
// when the dangling tool_use is buried under the CLI's uuid-BEARING records.
// attachment (listing deltas, token reminders) and system (local_command output)
// entries are written into the parentUuid chain like turns but carry no
// conversation, so the tail scan must walk past them to the parked call exactly
// as it does for last-prompt and ai-title.
func TestAppendToolResultsToWarmSession_SkipsTrailingUUIDBearingRecords(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-record-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		cliAttachmentEntry("uuid-attach-1", "uuid-asst-1", uuid,
			map[string]any{"type": "deferred_tools_delta", "addedNames": []string{"CronCreate"}}),
		map[string]any{
			"type": "system", "subtype": "local_command", "level": "info",
			"uuid": "uuid-system-1", "parentUuid": "uuid-attach-1", "sessionId": uuid,
			"content": "<local-command-stdout>ok</local-command-stdout>",
		},
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (uuid-bearing records after the tool_use must not force a cold start)", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatalf("warm prefix was modified — cache would miss.\nbefore:\n%s\nafter:\n%s", before, after)
	}
	entries := readJSONL(t, path)
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries (user, tool_use, attachment, system, appended result); got %d — records that answer nothing must be kept, not cut", len(entries))
	}
	last := entries[4]
	if last["type"] != "user" || last["parentUuid"] != "uuid-asst-1" {
		t.Fatalf("appended entry = %+v, want a user tool_result chained to uuid-asst-1, not to a record", last)
	}
}

// TestAppendToolResultsToWarmSession_RealUserTailUnderAttachmentStillRefuses
// keeps the widened skip honest: walking past attachment and system entries must
// not let the scan reach BACK past real conversation. A genuine tool_result for
// a call we hold nothing for, with the CLI's attachment written after it, is
// history — so we still cold-start and leave the file alone.
func TestAppendToolResultsToWarmSession_RealUserTailUnderAttachmentStillRefuses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-real-user-under-attachment"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		newSyntheticEntry("user", []map[string]any{{
			"type": "tool_result", "tool_use_id": "call_other", "content": "genuine output",
		}}, "uuid-real-1", "uuid-asst-1", uuid, workingDir, time.Now()),
		cliAttachmentEntry("uuid-attach-1", "uuid-real-1", uuid, tokensReminder()),
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil); err == nil {
		t.Fatal("expected a refusal when real history follows the tool_use; got nil")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("a refused append must leave the file untouched.\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// TestAppendToolResultsToWarmSession_MixedResultTailStillRefuses keeps the
// per-block strictness. A user turn that answers the call we hold a result for
// AND carries something else is a turn the user really sent, so nothing is cut
// and we cold-start instead.
func TestAppendToolResultsToWarmSession_MixedResultTailStillRefuses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-mixed-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path, newSyntheticEntry("user", []map[string]any{
		{"type": "tool_result", "tool_use_id": "call_1", "content": "genuine output"},
		{"type": "text", "text": "and while you're there, do this too"},
	}, "uuid-mixed-1", "uuid-asst-1", uuid, workingDir, time.Now()))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil); err == nil {
		t.Fatal("expected a refusal when the tail entry also carries a block that is not a tool_result; got nil")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("a refused append must leave the file untouched.\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// TestAppendToolResultsToWarmSession_RealUserTailStillRefuses keeps the healing
// narrow. A user turn answering a call we are NOT delivering a result for is
// real conversation that continued past the tool_use, and cutting back to it
// would delete history — so we must still cold-start.
func TestAppendToolResultsToWarmSession_RealUserTailStillRefuses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-real-user-tail"
	path := seedWarmSession(t, workingDir, uuid, "call_1")
	appendRawEntries(t, path,
		newSyntheticEntry("user", []map[string]any{{
			"type": "tool_result", "tool_use_id": "call_other", "content": "genuine output",
		}}, "uuid-real-1", "uuid-asst-1", uuid, workingDir, time.Now()),
		newSyntheticEntry("assistant", []map[string]any{{"type": "text", "text": "done"}},
			"uuid-asst-2", "uuid-real-1", uuid, workingDir, time.Now()),
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "x")}, nil); err == nil {
		t.Fatal("expected a refusal when real history follows the tool_use; got nil")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("a refused append must leave the file untouched.\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// TestAppendToolResultsToWarmSession_SnapshotWinsOverDiskWreckage proves the
// pre-teardown snapshot is what gets written: whatever a dying CLI adds to the
// file afterwards is discarded rather than reasoned about.
func TestAppendToolResultsToWarmSession_SnapshotWinsOverDiskWreckage(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-snapshot"
	path := seedWarmSession(t, workingDir, uuid, "call_1")

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	snapshot := c.snapshotWarmSession()
	if len(snapshot) == 0 {
		t.Fatal("snapshotWarmSession returned nothing for a seeded session")
	}

	// The CLI journals the marker after we snapshotted — the teardown race.
	appendRawEntries(t, path, abortEntry(workingDir, uuid, "uuid-abort-1", "uuid-asst-1", "call_1"))

	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_1", "the answer")}, snapshot); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v", err)
	}
	entries := readJSONL(t, path)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries; got %d — the snapshot must overwrite the wreckage", len(entries))
	}
	msg, _ := entries[2]["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["content"] != "the answer" {
		t.Fatalf("appended block = %+v, want the real result", block)
	}
}

// TestAppendToolResultsToWarmSession_ParallelToolUses closes a turn that called
// two tools at once. The CLI journals one entry per content block, so the file
// ends on TWO chained assistant tool_use entries and its last entry names only
// the second call — reading just that entry made the first call's result look
// like it belonged to another turn, and cold-started every multi-tool turn there
// has ever been. The reported case: an `edit` awaiting approval alongside an
// auto-approved `read`.
func TestAppendToolResultsToWarmSession_ParallelToolUses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-parallel"
	path := seedWarmSession(t, workingDir, uuid, "call_edit", "call_read")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{
		toolResultMsg("call_edit", "edited"),
		toolResultMsg("call_read", "contents"),
	}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v (parallel tool calls must not force a cold start)", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatalf("warm prefix was modified — cache would miss.\nbefore:\n%s\nafter:\n%s", before, after)
	}
	entries := readJSONL(t, path)
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries (user, 2 tool_use, 2 results); got %d", len(entries))
	}
	// One result entry per tool_use entry, each chained to the call it answers —
	// the CLI's own layout — with the last left as the leaf.
	for i, want := range []struct{ parent, id, content string }{
		{"uuid-asst-1", "call_edit", "edited"},
		{"uuid-asst-2", "call_read", "contents"},
	} {
		e := entries[3+i]
		if e["type"] != "user" || e["parentUuid"] != want.parent {
			t.Fatalf("entry %d = %+v, want a user entry chained to %s", 3+i, e, want.parent)
		}
		msg, _ := e["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		if len(content) != 1 {
			t.Fatalf("entry %d content = %v, want one tool_result block", 3+i, msg["content"])
		}
		block, _ := content[0].(map[string]any)
		if block["tool_use_id"] != want.id || block["content"] != want.content {
			t.Fatalf("entry %d block = %+v, want %s → %q", 3+i, block, want.id, want.content)
		}
	}
}

// TestAppendToolResultsToWarmSession_HalfAnsweredRunRefuses keeps the run check
// honest in the other direction: a dangling call with no result would leave the
// rebuilt assistant turn half-answered, which the API rejects outright. Better a
// cold start than a wedged turn.
func TestAppendToolResultsToWarmSession_HalfAnsweredRunRefuses(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-half-answered"
	path := seedWarmSession(t, workingDir, uuid, "call_edit", "call_read")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	err = c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("call_edit", "edited")}, nil)
	if err == nil {
		t.Fatal("expected a refusal when one of the parallel calls has no result; got nil")
	}
	if !strings.Contains(err.Error(), "call_read") {
		t.Fatalf("refusal reason = %q, want it to name the unanswered call_read", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("a refused append must leave the file untouched.\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// TestAppendToolResultsToWarmSession_UnmatchedResult errors when the result's id
// doesn't match a tool_use the warm file is dangling on.
func TestAppendToolResultsToWarmSession_UnmatchedResult(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-mismatch"
	seedWarmSession(t, workingDir, uuid, "call_1")
	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{toolResultMsg("other_call", "x")}, nil); err == nil {
		t.Fatal("expected an error when the result id doesn't match the dangling tool_use; got nil")
	}
}
