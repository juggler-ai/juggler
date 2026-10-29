//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside stop_reason_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
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
