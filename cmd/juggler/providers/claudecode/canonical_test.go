//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Tests for canonicalToolName, the single helper both the live-stream parser
// and the SDK tools/call control path call to turn a CLI-emitted tool name
// into the Juggler tool key. Adding the prefix/alias logic in one place lets
// every entry point share the same rules without duplicating string surgery.

package claudecode

import (
	"testing"
)

func TestCanonicalToolName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"strips juggler prefix from registered tool", "mcp__juggler__batch_grep", "batch_grep"},
		{"strips juggler prefix from bash", "mcp__juggler__bash", "bash"},
		{"strips juggler prefix from read_file", "mcp__juggler__read_file", "read_file"},
		{"already-canonical name is unchanged", "batch_grep", "batch_grep"},
		{"unknown unprefixed name passes through", "some_unknown_tool", "some_unknown_tool"},
		{"bare server name without subtool is left alone", "mcp__juggler", "mcp__juggler"},
		{"doubly-prefixed name strips only one", "mcp__juggler__mcp__juggler__bash", "mcp__juggler__bash"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := canonicalToolName(tc.in); got != tc.want {
				t.Errorf("canonicalToolName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestParser_ToolUsePrefixStripped_BatchGrep: a tool_use stream for
// `batch_grep` must reach the frontend with the prefix removed, so the
// registry lookup in response-handler.js doesn't fall into the unknown-tool
// branch.
func TestParser_ToolUsePrefixStripped_BatchGrep(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "mcp__juggler__batch_grep"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"searches":[{"pattern":"foo"}]}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}},
		}),
	}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(res.Blocks))
	}
	if res.Blocks[0].ToolName != "batch_grep" {
		t.Errorf("ToolName=%q, want batch_grep", res.Blocks[0].ToolName)
	}
}

// bareToolUseLines is a complete tool_use block carrying an unprefixed name,
// followed by the tool_use stop that ends the batch.
func bareToolUseLines(t *testing.T, name string) []string {
	t.Helper()
	return []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": name}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"command":"tail -f log"}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}},
		}),
	}
}

// TestParser_BareNativeToolName_SkipsBlock: a tool_use whose name arrived
// WITHOUT the mcp__juggler__ prefix is resolved on the CLI's side and never
// reaches juggler as a tools/call. Monitor is the case that hung a conversation
// in the wild: it is both a CLI built-in and a juggler tool, so stripping an
// absent prefix made the parser dispatch it as juggler's own, and the result it
// produced stashed forever waiting for a park that could never come while the
// CLI blocked on its next real call.
//
// Not dispatching is the whole fix. The block is skipped and tallied as
// CLI-served so the batch parks nothing on our side, and the turn reads on.
func TestParser_BareNativeToolName_SkipsBlock(t *testing.T) {
	c := newParserClient()
	res, _, _, _, err := feedLines(t, c, bareToolUseLines(t, "Monitor"))
	if err != nil {
		t.Fatalf("a bare CLI-native tool_use must be skipped, not fail the turn: %v", err)
	}
	if len(res.Blocks) != 0 {
		t.Fatalf("want no dispatchable blocks, got %+v", res.Blocks)
	}
	if res.cliServedThisCall != 1 {
		t.Errorf("skipped block should be tallied as CLI-served, got %d", res.cliServedThisCall)
	}
}

// TestParser_BareJugglerToolName_SkipsBlock: the common case in the wild is not
// a leaked built-in at all — it is the model calling one of juggler's OWN tools
// by the bare name it sees in its transcript ("bash" rather than
// "mcp__juggler__bash"). Failing the turn for that killed a working session over
// something the CLI recovers from by itself: it rejects the unknown name and the
// model re-issues the call correctly on the same open process.
func TestParser_BareJugglerToolName_SkipsBlock(t *testing.T) {
	c := newParserClient()
	res, _, _, _, err := feedLines(t, c, bareToolUseLines(t, "bash"))
	if err != nil {
		t.Fatalf("a bare juggler tool name must be skipped, not fail the turn: %v", err)
	}
	if len(res.Blocks) != 0 {
		t.Fatalf("want no dispatchable blocks, got %+v", res.Blocks)
	}
	if res.cliServedThisCall != 1 {
		t.Errorf("skipped block should be tallied as CLI-served, got %d", res.cliServedThisCall)
	}
	if res.StopReason == "tool_use" {
		t.Error("a batch that parked nothing on our side must not pause the turn")
	}
}

// TestParser_DoublePrefixedToolName_SkipsBlock: a model has been seen calling
// mcp__juggler__mcp__juggler__todo — the prefix written twice. Juggler
// advertises its tools unprefixed and the CLI adds the prefix once, so no such
// tool exists: the CLI answers "No such tool available" itself and never sends a
// tools/call. Dispatching it as `todo` produced a result no parked call would
// ever claim, and that orphan desynchronised tool delivery until the turn hung.
func TestParser_DoublePrefixedToolName_SkipsBlock(t *testing.T) {
	c := newParserClient()
	res, _, _, _, err := feedLines(t, c, bareToolUseLines(t, mcpToolPrefix+mcpToolPrefix+"bash"))
	if err != nil {
		t.Fatalf("a doubly-prefixed tool name must be skipped, not fail the turn: %v", err)
	}
	if len(res.Blocks) != 0 {
		t.Fatalf("want no dispatchable blocks, got %+v", res.Blocks)
	}
	if res.cliServedThisCall != 1 {
		t.Errorf("skipped block should be tallied as CLI-served, got %d", res.cliServedThisCall)
	}
	if res.StopReason == "tool_use" {
		t.Error("a batch that parked nothing on our side must not pause the turn")
	}
}
