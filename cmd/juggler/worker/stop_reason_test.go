//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"reflect"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestStopReasonIsCanonicalType pins the one vocabulary a turn's ending is
// named in. Every struct below carries a stop reason across a layer boundary —
// out of a provider, over the worker's wire protocol, into the turn loop — and
// each must name provider.StopReason rather than a bare string.
//
// The type is the enforcement. A plain `string` field accepts whatever the
// upstream happened to say, so each provider is free to invent its own spelling
// and the turn loop's `== "max_tokens"` quietly stops matching for one of them.
// Only the worker can see both packages, which is why the assertion lives here.
func TestStopReasonIsCanonicalType(t *testing.T) {
	want := reflect.TypeOf(provider.StopReason(""))

	for _, tc := range []struct {
		name string
		typ  reflect.Type
	}{
		{"worker.LLMResponse", reflect.TypeOf(LLMResponse{})},
		{"worker.ProviderTurnMessage", reflect.TypeOf(ProviderTurnMessage{})},
		{"worker.MockResponse", reflect.TypeOf(MockResponse{})},
		{"provider.StreamResult", reflect.TypeOf(provider.StreamResult{})},
	} {
		field, ok := tc.typ.FieldByName("StopReason")
		if !ok {
			t.Errorf("%s has no StopReason field", tc.name)
			continue
		}
		if field.Type != want {
			t.Errorf("%s.StopReason is %v, want %v", tc.name, field.Type, want)
		}
	}
}

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
