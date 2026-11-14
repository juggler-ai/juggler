//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestCanResumeWithDelta_HeldExtentRejectsTrackedHistoryMutations(t *testing.T) {
	systemPrompt := "sys"
	base := []provider.Message{
		userMsg("question"),
		assistantMsg("answer"),
		contextItemMsg("context v1"),
	}
	sess := &activeSession{sessionUUID: "uuid-held"}
	sess.captureSentPrefix(systemPrompt, base)
	if sess.heldCount != 3 || sess.sentCount != 2 {
		t.Fatalf("projection = held %d / decision %d, want 3 / 2", sess.heldCount, sess.sentCount)
	}

	cases := []struct {
		name     string
		messages []provider.Message
		reason   string
	}{
		{"truncate to old decision anchor", base[:2], "shrunk"},
		{"truncate further", base[:1], "shrunk"},
		{"delete from decision prefix", []provider.Message{base[1], base[2], userMsg("new")}, "diverged"},
		{"edit decision prefix", []provider.Message{userMsg("edited"), base[1], base[2]}, "diverged"},
		{"reorder decision prefix", []provider.Message{base[1], base[0], base[2]}, "diverged"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, ok, reason := canResumeWithDelta(sess, systemPrompt, tc.messages); ok || reason != tc.reason {
				t.Fatalf("canResumeWithDelta = ok %v reason %q, want false/%q", ok, reason, tc.reason)
			}
		})
	}

	extended := []provider.Message{base[0], base[1], userMsg("next"), contextItemMsg("context v2")}
	start, end, ok, reason := canResumeWithDelta(sess, systemPrompt, extended)
	if !ok || reason != "" || start != 2 || end != 4 {
		t.Fatalf("volatile extension = [%d,%d) ok %v reason %q, want [2,4) true", start, end, ok, reason)
	}
}

func TestCanResumeWithDelta_ElementHashesAreAuthoritative(t *testing.T) {
	messages := []provider.Message{userMsg("one"), assistantMsg("two"), userMsg("three")}
	sess := &activeSession{sessionUUID: "uuid-elements"}
	sess.captureSentPrefix("sys", messages[:2])
	sess.sentHash ^= 1

	if _, _, ok, reason := canResumeWithDelta(sess, "sys", messages); !ok {
		t.Fatalf("aggregate-only mismatch over matching elements must resume, got %q", reason)
	}

	legacy := &activeSession{
		sessionUUID: "uuid-legacy",
		heldCount:   2,
		sentCount:   2,
		sentHash:    hashRequestPrefix("sys", messages, 2),
	}
	if _, _, ok, reason := canResumeWithDelta(legacy, "sys", messages); !ok {
		t.Fatalf("legacy aggregate fallback must resume, got %q", reason)
	}
}

func TestFailedTurnWritePersistsFullAssistantProjection(t *testing.T) {
	installFakeClaude(t, fakeModeFailSecond, "uuid-failed-write")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_uuid-failed-write"
	convDir := filepath.Join(c.workingDir, ".juggler", "failed--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conversation: %v", err)
	}
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("first turn: %v", err)
	}

	messages := []provider.Message{
		userMsg("hello"),
		assistantMsg("earlier answer"),
		userMsg("request that fails"),
	}
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       messages,
	}, nopCallback())
	if err == nil {
		t.Fatal("fake failure must surface")
	}

	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil {
		t.Fatal("successful request write followed by error must persist its projection")
	}
	if loaded.heldCount != len(messages) || loaded.sentCount != len(messages) {
		t.Fatalf("failed-turn projection = held %d / decision %d, want %d / %d", loaded.heldCount, loaded.sentCount, len(messages), len(messages))
	}
	if _, _, ok, reason := canResumeWithDelta(loaded, "sys", messages); ok || reason != "no-new-msgs" {
		t.Fatalf("same request retry = ok %v reason %q, want synthetic nudge rather than duplicate feed", ok, reason)
	}
}

func TestDiskSession_OldSidecarDefaultsHeldCountToDecisionCount(t *testing.T) {
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-old-held"
	convDir := filepath.Join(c.workingDir, ".juggler", "legacy--"+convID)
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conversation: %v", err)
	}
	data := []byte(`{"sessionUUID":"legacy-uuid","sentCount":2,"sentHash":7}`)
	if err := os.WriteFile(legacySessionDiskPath(c.workingDir, convID), data, 0o644); err != nil {
		t.Fatalf("write legacy sidecar: %v", err)
	}

	loaded := loadDiskSession(c.workingDir, convID, c.workingDir, "")
	if loaded == nil || loaded.heldCount != 2 || loaded.sentCount != 2 {
		t.Fatalf("legacy projection = %+v, want heldCount and sentCount 2", loaded)
	}
}
