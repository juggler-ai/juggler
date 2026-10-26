//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stream-event emit helpers shared by BOTH fake CLIs — the fixed-mode fake
// (keepalive_test.go) and the scriptable fake (permutation_harness_test.go).
// They synthesize the exact stdout shapes the real `claude` CLI produces under
// --include-partial-messages, and run inside the re-exec'd fake process (so they
// take a *bufio.Writer and never touch *testing.T).

package claudecode

import (
	"bufio"
	"encoding/json"
)

// emitTextTurn writes the stream-event sequence for a single text-only turn:
// content_block_start(text) → content_block_delta(text_delta) →
// content_block_stop → message_delta(stop_reason=end_turn). Usage rides on the
// message_delta with cache_read_input_tokens set to cacheRead so cost/cache
// tests can tell turns apart. It writes no trailing `result` envelope: the read
// returns at stop_reason=end_turn, and the envelope the real CLI writes after it
// is a separate concern, covered in trailing_result_test.go.
func emitTextTurn(out *bufio.Writer, text string, cacheRead int) {
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"},
	}})
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_delta", "index": 0,
		"delta": map[string]any{"type": "text_delta", "text": text},
	}})
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_stop", "index": 0,
	}})
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": "end_turn"},
		"usage": map[string]any{
			"input_tokens": 100, "output_tokens": 50,
			"cache_read_input_tokens": cacheRead, "cache_creation_input_tokens": 200,
		},
	}})
}

// emitToolUseBlock writes the content_block_start/delta/stop sequence for one
// tool_use block at index idx, with name as it appears on the wire (already
// fully qualified). It does NOT emit the trailing stop_reason=tool_use pause:
// the caller emits that once, after parking however many calls the round holds.
func emitToolUseBlock(out *bufio.Writer, idx int, id, name string, args map[string]any) {
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_start", "index": idx,
		"content_block": map[string]any{"type": "tool_use", "id": id, "name": name},
	}})
	argsJSON, _ := json.Marshal(args)
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_delta", "index": idx,
		"delta": map[string]any{"type": "input_json_delta", "partial_json": string(argsJSON)},
	}})
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "content_block_stop", "index": idx,
	}})
}

// emitToolUse writes a complete single tool_use turn — the tool_use block at
// index 0 followed by the stop_reason=tool_use pause. The fixed-mode fake uses
// it for one-tool rounds; the scripted fake drives emitToolUseBlock directly so
// it can park many calls before a single shared pause.
func emitToolUse(out *bufio.Writer, id, name string, input map[string]any) {
	emitToolUseBlock(out, 0, id, name, input)
	emit(out, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
	}})
}
