//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// captureSentPrefix is the production path finalizeTurn uses to record what the
// CLI holds; these tests drive diagnoseDivergence off the same capture so the
// diagnostic can never drift from how the fingerprints are stored.

func TestDiagnoseDivergence_SystemPrompt(t *testing.T) {
	msgs := []provider.Message{userMsg("a"), assistantMsg("b"), userMsg("c")}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("system v1", msgs)

	got := diagnoseDivergence(sess, "system v2", msgs)
	if !strings.Contains(got, "system prompt") {
		t.Fatalf("expected system-prompt divergence, got %q", got)
	}
}

func TestDiagnoseDivergence_Message(t *testing.T) {
	msgs := []provider.Message{userMsg("a"), assistantMsg("b"), userMsg("c")}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", msgs)

	mutated := append([]provider.Message{}, msgs...)
	mutated[1] = assistantMsg("b-changed")
	got := diagnoseDivergence(sess, "sys", mutated)
	if !strings.Contains(got, "message[1]") {
		t.Fatalf("expected message[1] divergence, got %q", got)
	}
}

func TestDiagnoseDivergence_ToolResultField(t *testing.T) {
	// A divergence in a non-Content field (tool-result body) must still be
	// detected and localised — the per-element hash covers the same fields the
	// aggregate does.
	msgs := []provider.Message{
		userMsg("a"),
		toolUseMsg("call_1", "bash"),
		toolResultMsg("call_1", "out"),
		userMsg("c"),
	}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", msgs)

	mutated := append([]provider.Message{}, msgs...)
	mutated[2] = toolResultMsg("call_1", "DIFFERENT out")

	// Precondition: the aggregate decision hash must also see this as a divergence.
	if hashRequestPrefix("sys", mutated, len(mutated)) == sess.sentHash {
		t.Fatal("precondition failed: aggregate hash should differ when a tool-result body changes")
	}
	got := diagnoseDivergence(sess, "sys", mutated)
	if !strings.Contains(got, "message[2]") {
		t.Fatalf("expected message[2] divergence, got %q", got)
	}
}

func TestDiagnoseDivergence_SystemPromptReportedBeforeMessage(t *testing.T) {
	// When both the system prompt and a message changed, the system prompt
	// (head of the cached prefix) is reported first.
	msgs := []provider.Message{userMsg("a"), assistantMsg("b")}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", msgs)

	mutated := append([]provider.Message{}, msgs...)
	mutated[0] = userMsg("a-changed")
	got := diagnoseDivergence(sess, "different sys", mutated)
	if !strings.Contains(got, "system prompt") {
		t.Fatalf("system prompt should be reported before message divergence, got %q", got)
	}
}

func TestDiagnoseDivergence_Shrunk(t *testing.T) {
	msgs := []provider.Message{userMsg("a"), assistantMsg("b"), userMsg("c")}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", msgs)

	got := diagnoseDivergence(sess, "sys", msgs[:1])
	if !strings.Contains(got, "shrank") {
		t.Fatalf("expected shrink diagnosis, got %q", got)
	}
}

func TestDiagnoseDivergence_NoMetadata(t *testing.T) {
	// A session restored from a pre-upgrade sidecar carries sentCount/sentHash
	// but no per-element fingerprints; diagnose returns "" so the caller logs
	// the bare reason rather than a misleading localisation.
	sess := &activeSession{sessionUUID: "u", sentCount: 2, sentHash: 0xabc}
	got := diagnoseDivergence(sess, "sys", []provider.Message{userMsg("a"), assistantMsg("b")})
	if got != "" {
		t.Fatalf("expected empty diagnosis without fingerprint metadata, got %q", got)
	}
}

func TestDiagnoseDivergence_IdenticalInputsDoNotLocalise(t *testing.T) {
	// Identical inputs would not reach this path in production (the aggregate
	// would match), but diagnose must not falsely localise a difference.
	msgs := []provider.Message{userMsg("a"), assistantMsg("b")}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", msgs)

	if got := diagnoseDivergence(sess, "sys", msgs); got != "" {
		t.Fatalf("identical inputs must not localise a divergence, got %q", got)
	}
}

// TestCaptureSentPrefix_FingerprintsCoverAggregate guards the load-bearing
// invariant: whenever the aggregate sentHash detects a change, at least one
// per-element fingerprint also differs, so diagnoseDivergence can always name a
// culprit. Exercised across every prefix-element field.
func TestCaptureSentPrefix_FingerprintsCoverAggregate(t *testing.T) {
	base := []provider.Message{
		userMsg("a"),
		toolUseMsg("call_1", "bash"),
		toolResultMsg("call_1", "out"),
		assistantMsg("b"),
	}
	sess := &activeSession{sessionUUID: "u"}
	sess.captureSentPrefix("sys", base)

	mutations := map[string][]provider.Message{
		"message content": {userMsg("a2"), toolUseMsg("call_1", "bash"), toolResultMsg("call_1", "out"), assistantMsg("b")},
		"tool name":       {userMsg("a"), toolUseMsg("call_1", "write"), toolResultMsg("call_1", "out"), assistantMsg("b")},
		"tool-use id":     {userMsg("a"), toolUseMsg("call_2", "bash"), toolResultMsg("call_1", "out"), assistantMsg("b")},
	}
	for name, mutated := range mutations {
		if hashRequestPrefix("sys", mutated, len(mutated)) == sess.sentHash {
			t.Errorf("%s: aggregate hash unchanged — test precondition broken", name)
			continue
		}
		if got := diagnoseDivergence(sess, "sys", mutated); got == "" {
			t.Errorf("%s: aggregate diverged but diagnose localised nothing", name)
		}
	}
}

// TestSidecarRoundTripsFingerprints proves the per-element fingerprints survive
// persistence, so a session restored after a restart (the reported scenario:
// resume-after-pause that may follow a watchdog re-exec) can still localise a
// divergence on its first turn rather than logging a bare "diverged".
func TestSidecarRoundTripsFingerprints(t *testing.T) {
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_fp_roundtrip"
	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "rt--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	msgs := []provider.Message{userMsg("a"), assistantMsg("b"), userMsg("c")}
	sess := &activeSession{sessionUUID: "uuid-rt"}
	sess.captureSentPrefix("sys", msgs)
	saveDiskSession(c.workingDir, convID, c.workingDir, "", sess)

	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil {
		t.Fatal("expected to load saved session")
	}
	mutated := append([]provider.Message{}, msgs...)
	mutated[1] = assistantMsg("b-changed")
	if got := diagnoseDivergence(loaded, "sys", mutated); !strings.Contains(got, "message[1]") {
		t.Fatalf("reloaded session failed to localise divergence, got %q", got)
	}
}
