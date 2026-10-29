//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Shared helpers for the tool-delivery permutation harness. These were per-test
// closures duplicated across every TestToolDelivery* function; hoisting them to
// package level keeps each scenario free of mechanical boilerplate. They build
// scriptCalls for the scriptable fake, drive a single message request, and assert
// the routing/fidelity properties the whole suite shares.

package claudecode

import (
	"context"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// bashCall is a scriptCall for the "bash" tool whose tool_use and tools/call args
// match (no drift) — the workhorse builder for harness scenarios.
func bashCall(id, cmd string) scriptCall {
	return scriptCall{ID: id, Name: "bash", UseArgs: map[string]any{"command": cmd}}
}

// driftCall builds a "bash" scriptCall whose tool_use args (useCmd) differ from
// its tools/call args (callCmd), modelling arg-drift across a resume/restart so
// the provider's (name+args) key misses and the same-tool-name fallback must
// still deliver to the right call.
func driftCall(id, useCmd, callCmd string) scriptCall {
	return scriptCall{
		ID: id, Name: "bash",
		UseArgs:  map[string]any{"command": useCmd},
		CallArgs: map[string]any{"command": callCmd},
	}
}

// orphanCall builds a "bash" tools/call with NO tool_use block (empty ID) — an
// orphan park the worker never drives; discardStaleBuffers must error-release it
// at the turn boundary.
func orphanCall(cmd string) scriptCall {
	return scriptCall{Name: "bash", CallArgs: map[string]any{"command": cmd}}
}

// sendMsg streams one message request through the client and fails the test on a
// transport error, returning the StreamResult for assertions.
func sendMsg(t *testing.T, c *Client, convID string, msgs []provider.Message) *provider.StreamResult {
	t.Helper()
	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback())
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	return res
}

// assertRegime confirms classifyRegime picks the expected dispatch path for a
// continuation, and — when wantReason is non-empty — the exact reason, so a
// scenario reaching the right regime for the WRONG cause is caught rather than
// silently accepted. Pass "" for wantReason to skip the reason check.
func assertRegime(t *testing.T, c *Client, msgs []provider.Message, want streamRegime, wantReason, label string) {
	t.Helper()
	dec := classifyRegime(c.activeSession, c.model, "sys", msgs, c.activeSession.hasLiveCLI())
	if dec.Regime != want {
		t.Fatalf("%s: classifyRegime = %d (reason=%q), want %d", label, dec.Regime, dec.Reason, want)
	}
	if wantReason != "" && dec.Reason != wantReason {
		t.Fatalf("%s: classifyRegime reason = %q, want %q", label, dec.Reason, wantReason)
	}
}

// assertNotDeliveredLive asserts no RESULT:: for any of ids ever crossed the
// control protocol: a tool abandoned by a restart / divergence / cold resume has
// its result paired into rebuilt history by the synthetic resume, never answered
// over the live stream. This is the load-bearing abandonment assertion —
// checkToolPairing ignores ids excluded from deliveredIDs, so without this a
// stray live delivery to an abandoned id would slip past.
func assertNotDeliveredLive(t *testing.T, tapePath string, ids ...string) {
	t.Helper()
	for _, r := range readTape(t, tapePath) {
		if r.Event != "answer" {
			continue
		}
		m := resultTextRE.FindStringSubmatch(r.Text)
		if m == nil {
			continue // an abort/error release — exactly what an abandoned call gets
		}
		for _, id := range ids {
			if m[1] == id {
				t.Errorf("abandoned tool %q received a RESULT over the control protocol (%q on %s) — it must be paired into rebuilt history, not delivered live", id, r.Text, r.ReqID)
			}
		}
	}
}

// SetBinaryPathForTesting pins the claude CLI path and the env vars added to
// spawned children. Returns a restore function. Test helpers call this to
// redirect spawnCLIPipes to a fake binary (typically the test binary itself,
// re-exec'd via the helper-process pattern).
func SetBinaryPathForTesting(path string, extraEnv ...string) (restore func()) {
	oldPath := pinnedBinaryPath
	oldEnv := testExtraSpawnEnv
	pinnedBinaryPath = path
	testExtraSpawnEnv = append([]string(nil), extraEnv...)
	return func() {
		pinnedBinaryPath = oldPath
		testExtraSpawnEnv = oldEnv
	}
}
