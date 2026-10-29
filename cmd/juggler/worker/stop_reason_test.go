//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestStopReasonWireValuesUnchanged pins the JSON both ways round. The viewer
// reads `stopReason` as a plain string (the transaction detail renderer
// branches on "cancelled"), so naming the type in Go must not rename a value on
// the wire — and a reason the worker has no constant for must still survive a
// round trip rather than being dropped.
func TestStopReasonWireValuesUnchanged(t *testing.T) {
	encoded, err := json.Marshal(LLMResponse{StopReason: provider.StopReasonToolUse})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(encoded, &asMap); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}
	if asMap["stopReason"] != "tool_use" {
		t.Errorf("stopReason marshalled as %#v, want the plain string \"tool_use\"", asMap["stopReason"])
	}

	for _, raw := range []string{"max_tokens", "refusal", "cancelled", "some_future_reason"} {
		var decoded LLMResponse
		if err := json.Unmarshal([]byte(`{"stopReason":"`+raw+`"}`), &decoded); err != nil {
			t.Fatalf("unmarshal %q: %v", raw, err)
		}
		if string(decoded.StopReason) != raw {
			t.Errorf("decoded %q as %q, want it carried through verbatim", raw, decoded.StopReason)
		}
	}
}
