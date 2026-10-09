//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestBuildToolResultMapAppendsHookNotes pins where a hook's note reaches the
// model: inside the call's own tool_result, after the tool's output, tagged with
// the hook that wrote it. Records that carry no note (a verdict, a hook that
// matched and said nothing) contribute nothing.
func TestBuildToolResultMapAppendsHookNotes(t *testing.T) {
	item := ConversationItem{
		ToolUseID: "tool_1",
		Result:    json.RawMessage(`{"content":"touch: /etc/x: Operation not permitted","isError":true}`),
		Hooks: json.RawMessage(`[
			{"id":"nono-denial","event":"afterTool","note":"Run nono why to diagnose."},
			{"id":"silent","event":"afterTool"},
			{"id":"second","event":"afterTool","note":"  Another note.  "}
		]`),
	}
	m := buildToolResultMap(item)
	want := "touch: /etc/x: Operation not permitted" +
		"\n\n<hook-note source=\"nono-denial\">\nRun nono why to diagnose.\n</hook-note>" +
		"\n\n<hook-note source=\"second\">\nAnother note.\n</hook-note>"
	if m["content"] != want {
		t.Errorf("content =\n%q\nwant\n%q", m["content"], want)
	}
	if m["isError"] != true {
		t.Errorf("isError = %v, want the tool's own verdict untouched", m["isError"])
	}
}

// TestBuildToolResultMapWithoutHooksIsUnchanged pins that a call no hook spoke
// on projects byte-identically to one from before hooks existed — the prompt
// cache prefix of every existing conversation depends on it.
func TestBuildToolResultMapWithoutHooksIsUnchanged(t *testing.T) {
	for _, hooks := range []string{"", `[]`, `[{"id":"x","event":"beforeTool","verdict":"allow"}]`, `not json`} {
		item := ConversationItem{
			ToolUseID: "tool_2",
			Result:    json.RawMessage(`{"content":"ok","isError":false}`),
		}
		if hooks != "" {
			item.Hooks = json.RawMessage(hooks)
		}
		if got := buildToolResultMap(item)["content"]; got != "ok" {
			t.Errorf("hooks %s: content = %q, want %q", hooks, got, "ok")
		}
	}
}
