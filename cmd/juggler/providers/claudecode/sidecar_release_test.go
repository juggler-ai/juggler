//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// runOneTurnWithSidecar drives a single text turn through the fake CLI so a
// sessionUUID is captured and the on-disk sidecar is written, then returns
// the Client, convID, and the sidecar path. It creates the per-conversation
// folder up front so the modern sidecarDiskPath (via ScanConvDirs) resolves
// — the legacy-path tests sidestep this, but here we exercise the real path.
func runOneTurnWithSidecar(t *testing.T, sessionID string) (*Client, string, string) {
	t.Helper()
	installFakeClaude(t, fakeModeUntilClose, sessionID)
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_" + sessionID

	convDir := filepath.Join(c.workingDir, ".juggler", "release--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	sidecar := filepath.Join(convDir, "claude_session.json")
	if _, err := os.Stat(sidecar); err != nil {
		t.Fatalf("precondition failed: turn did not write sidecar at %s: %v", sidecar, err)
	}
	return c, convID, sidecar
}

// TestClose_PreservesSidecar is the regression guard for the "no prior
// session" cache-miss storm. Releasing a conversation handle (cache
// eviction on model switch, graceful server shutdown, or the desktop app
// stopping a server as a window closes) routes through conversation.Close.
// That MUST keep the on-disk sidecar: the conversation still exists and
// will be reopened, and the sidecar is exactly what lets the next turn
// --resume warm instead of cold-starting the entire history. Deleting it
// here is what made every restart re-send 20k+ uncached tokens.
func TestClose_PreservesSidecar(t *testing.T) {
	c, convID, sidecar := runOneTurnWithSidecar(t, "uuid-preserve")

	// Exactly what the server does on shutdown / eviction (per-thread teardown).
	c.closeSession()

	if c.activeSession != nil {
		t.Error("Close must drop the in-memory session")
	}
	if _, err := os.Stat(sidecar); err != nil {
		t.Fatalf("Close deleted the warm-resume sidecar (%v) — the next turn after a restart will cold-start the whole history", err)
	}
	// And the preserved sidecar must still yield a resumable session.
	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil || loaded.sessionUUID == "" {
		t.Fatal("sidecar no longer yields a resumable session after Close")
	}
}

// TestFinalizeTurn_ErrorPreservesSidecar guards the same warm-cache
// property for the turn-error path. A stream-time failure (rate-limit
// exhaustion, a sleep/wake connection drop, an API 400/529) must NOT wipe
// the sidecar: a complete stdin write has already advanced the persisted
// projection, so the user's retry must resume without feeding that request twice.
func TestFinalizeTurn_ErrorPreservesSidecar(t *testing.T) {
	c, convID, sidecar := runOneTurnWithSidecar(t, "uuid-err")

	// One successful turn is on disk; now simulate the next turn failing
	// mid-stream — exactly the (turn, err) finalizeTurn receives from
	// readUntilPauseOrComplete after a transient failure.
	_, err := c.finalizeTurn(provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, &turnResult{}, fmt.Errorf("synthetic stream stall"))
	if err == nil {
		t.Fatal("finalizeTurn must surface the turn error")
	}

	if c.activeSession != nil {
		t.Error("error path must release the in-memory session")
	}
	if _, statErr := os.Stat(sidecar); statErr != nil {
		t.Fatalf("error path deleted the warm-resume sidecar (%v) — the retry will cold-start the whole history", statErr)
	}
	if loaded := loadDiskSession(c.workingDir, convID, c.workingDir, ""); loaded == nil || loaded.sessionUUID == "" {
		t.Fatal("sidecar no longer yields a resumable session after an errored turn")
	}
}

// TestRoutineFreshStartPreservesSidecarBeforeReplacementSucceeds guards the
// compaction / branch-switch path that produced a real "no prior session"
// storm. A divergent, shrunken, or model-changed request must cold-start a NEW
// claude session, but must not delete the OLD sidecar before that replacement
// turn succeeds. If the replacement turn then stalls across sleep/wake, the old
// sidecar is still the only warm-resume anchor for the user's retry.
func TestRoutineFreshStartPreservesSidecarBeforeReplacementSucceeds(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(*Client)
		messages   []provider.Message
		wantReason string
	}{
		{
			name:       "diverged",
			messages:   []provider.Message{userMsg("DIFFERENT prefix"), userMsg("new")},
			wantReason: "diverged",
		},
		{
			name:       "shrunk",
			messages:   nil,
			wantReason: "shrunk",
		},
		{
			name: "model-changed",
			mutate: func(c *Client) {
				c.model = "claude-opus-4-7"
			},
			messages:   []provider.Message{userMsg("hello"), userMsg("new")},
			wantReason: "model-changed",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, convID, sidecar := runOneTurnWithSidecar(t, "uuid-"+tc.name+"-preserve")
			if tc.mutate != nil {
				tc.mutate(c)
			}

			dec := classifyRegime(c.activeSession, c.model, "sys", tc.messages, c.activeSession.hasLiveCLI())
			if dec.Regime != regimeStartFresh || dec.Reason != tc.wantReason {
				t.Fatalf("precondition: regime=(%v,%q), want startFresh/%q", dec.Regime, dec.Reason, tc.wantReason)
			}

			// Exercise the exact branch that previously called dropSession (and
			// deleted sidecar) before startFreshSession had a chance to succeed.
			c.dispatchFreshStart()

			if c.activeSession != nil {
				t.Error("routine fresh-start setup must release the in-memory session")
			}
			if _, statErr := os.Stat(sidecar); statErr != nil {
				t.Fatalf("routine fresh-start setup deleted the previous warm-resume sidecar (%v)", statErr)
			}
			loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
			if loaded == nil || loaded.sessionUUID != "uuid-"+tc.name+"-preserve" {
				t.Fatalf("sidecar should still point at the last successful session; got %+v", loaded)
			}
		})
	}
}

// TestWarmResumeFallbackFailurePreservesSidecar covers warm --resume paths where
// the live CLI has been reaped and the replacement spawn/stdin setup fails
// before a fresh fallback can complete. The old sidecar must survive: it remains
// the last successful warm-resume anchor and should not be deleted merely
// because this attempt could not launch a replacement process.
func TestWarmResumeFallbackFailurePreservesSidecar(t *testing.T) {
	c, convID, sidecar := runOneTurnWithSidecar(t, "uuid-resume-fallback-preserve")
	c.activeSession.tearDownLiveCLI() // leave only the resumable record, as after idle reap/restart.

	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "missing-claude"))
	defer restore()

	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       []provider.Message{userMsg("hello"), assistantMsg("reply"), userMsg("follow-up")},
	}, nopCallback())
	if err == nil {
		t.Fatal("expected missing CLI to make warm-resume attempt fail")
	}
	if _, statErr := os.Stat(sidecar); statErr != nil {
		t.Fatalf("warm-resume fallback failure deleted the previous warm-resume sidecar (%v)", statErr)
	}
	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil || loaded.sessionUUID != "uuid-resume-fallback-preserve" {
		t.Fatalf("sidecar should still point at the last successful session; got %+v", loaded)
	}
}

// TestDivergentFreshStartSuccessReplacesSidecar covers the successful half of
// the same flow: a divergent/shrunken request starts a new claude session, and
// once that replacement turn completes, its UUID overwrites the preserved old
// sidecar.
func TestDivergentFreshStartSuccessReplacesSidecar(t *testing.T) {
	installFakeClaude(t, fakeModeUntilClose, "uuid-diverge-success")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_diverge_success"
	convDir := filepath.Join(c.workingDir, ".juggler", "release--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       []provider.Message{userMsg("original prefix")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       []provider.Message{userMsg("DIFFERENT prefix"), assistantMsg("reply"), userMsg("new")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 2 divergent: %v", err)
	}

	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil || loaded.sessionUUID != "uuid-diverge-success" {
		t.Fatalf("successful divergent turn should save the replacement session; got %+v", loaded)
	}
	if loaded.sentCount != 3 {
		t.Fatalf("successful divergent turn should save new sentCount=3; got %d", loaded.sentCount)
	}
}

// TestDropSession_DeletesSidecar pins the other half of the split: the
// intentional fresh-start paths (a malformed tool_use stop, hard turn errors)
// still wipe the sidecar so the next turn cold-starts deliberately.
func TestDropSession_DeletesSidecar(t *testing.T) {
	c, convID, sidecar := runOneTurnWithSidecar(t, "uuid-drop")

	c.dropSession(convID)

	if c.activeSession != nil {
		t.Error("dropSession must drop the in-memory session")
	}
	if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
		t.Fatalf("dropSession must delete the sidecar (stat err = %v)", err)
	}
}
