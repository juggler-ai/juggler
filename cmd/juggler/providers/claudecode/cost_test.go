//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"io"
	"os/exec"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// mustStartSentinel spawns a long-lived dummy process so hasLiveCLI()
// returns true on a fake activeSession. The command (sentinelCommand, defined
// per-OS) blocks reading stdin, which we never write to, so it stays alive
// until killed.
func mustStartSentinel(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := sentinelCommand()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sentinel: %v", err)
	}
	return cmd
}

// seedSession attaches sess to c as its activeSession and returns a
// cleanup that detaches it. Mirrors how the conversation handle would
// populate c.activeSession in production.
func seedSession(t *testing.T, c *Client, sess *activeSession) func() {
	t.Helper()
	c.activeSession = sess
	return func() { c.activeSession = nil }
}

// newTestClient gives each test an isolated workingDir so the disk-sidecar
// fallback can't pull in state from elsewhere.
func newTestClient(t *testing.T, model string) *Client {
	t.Helper()
	t.Setenv("JUGGLER_PROJECT_PATH", t.TempDir())
	p, err := NewClient(provider.Config{Model: model})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	// Reap any persistent CLI subprocess before t.TempDir cleanup runs so
	// Windows can delete the working dir (it can't remove a dir a live process
	// holds open). closeSession kills+waits the live CLI; nil-safe no-op when
	// none was spawned.
	t.Cleanup(c.closeSession)
	return c
}

func userMsg(content string) provider.Message {
	return provider.Message{Type: "user", Content: content}
}

func assistantMsg(content string) provider.Message {
	return provider.Message{Type: "assistant", Content: content}
}

func toolUseMsg(id, name string) provider.Message {
	return provider.Message{Type: "tool-use", ToolUseID: id, ToolName: name}
}

func toolResultMsg(id, content string) provider.Message {
	return provider.Message{Type: "tool-result", ToolUseID: id, Content: content}
}

func TestHashRequestPrefix_Stability(t *testing.T) {
	base := []provider.Message{
		userMsg("hello"),
		assistantMsg("hi there"),
		userMsg("question"),
	}
	sys := "you are helpful"
	prefixHash := hashRequestPrefix(sys, base, 2)

	extended := append([]provider.Message{}, base...)
	extended = append(extended, assistantMsg("answer"))
	if got := hashRequestPrefix(sys, extended, 2); got != prefixHash {
		t.Errorf("extending messages must not change prefix hash: got %d want %d", got, prefixHash)
	}

	mutated := append([]provider.Message{}, base...)
	mutated[1] = assistantMsg("different reply")
	if got := hashRequestPrefix(sys, mutated, 2); got == prefixHash {
		t.Errorf("editing a prefix message must change the prefix hash; both = %d", got)
	}

	// System prompt is part of the prefix: editing it changes the hash
	// regardless of whether messages changed. This is the property that
	// lets the resume check detect a prompt edit without a special case.
	if got := hashRequestPrefix("DIFFERENT", base, 2); got == prefixHash {
		t.Errorf("changing the system prompt must change the prefix hash")
	}
}

func TestCanResumeWithDelta(t *testing.T) {
	msgs := []provider.Message{
		userMsg("a"),
		assistantMsg("b"),
		userMsg("c"),
	}
	uuid := "uuid-1"
	sys := "system prompt"

	cases := []struct {
		name     string
		sess     *activeSession
		inputSys string
		input    []provider.Message
		want     string // "" for ok, otherwise the reason
		wantOK   bool
	}{
		{
			name:     "no session",
			sess:     nil,
			inputSys: sys,
			input:    msgs,
			want:     "no-uuid",
			wantOK:   false,
		},
		{
			name:     "no uuid",
			sess:     &activeSession{sentCount: 2, sentHash: hashRequestPrefix(sys, msgs, 2)},
			inputSys: sys,
			input:    msgs,
			want:     "no-uuid",
			wantOK:   false,
		},
		{
			name:     "shrunk",
			sess:     &activeSession{sessionUUID: uuid, sentCount: 5, sentHash: 0},
			inputSys: sys,
			input:    msgs,
			want:     "shrunk",
			wantOK:   false,
		},
		{
			name:     "diverged: messages prefix mutated",
			sess:     &activeSession{sessionUUID: uuid, sentCount: 2, sentHash: 0xdeadbeef},
			inputSys: sys,
			input:    msgs,
			want:     "diverged",
			wantOK:   false,
		},
		{
			name:     "diverged: system prompt edited",
			sess:     &activeSession{sessionUUID: uuid, sentCount: 2, sentHash: hashRequestPrefix(sys, msgs, 2)},
			inputSys: "DIFFERENT system prompt",
			input:    msgs,
			want:     "diverged",
			wantOK:   false,
		},
		{
			name:     "no new msgs",
			sess:     &activeSession{sessionUUID: uuid, sentCount: 3, sentHash: hashRequestPrefix(sys, msgs, 3)},
			inputSys: sys,
			input:    msgs,
			want:     "no-new-msgs",
			wantOK:   false,
		},
		{
			name:     "ok delta",
			sess:     &activeSession{sessionUUID: uuid, sentCount: 2, sentHash: hashRequestPrefix(sys, msgs, 2)},
			inputSys: sys,
			input:    msgs,
			want:     "",
			wantOK:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start, end, ok, reason := canResumeWithDelta(tc.sess, tc.inputSys, tc.input)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (reason=%q)", ok, tc.wantOK, reason)
			}
			if !ok && reason != tc.want {
				t.Errorf("reason = %q, want %q", reason, tc.want)
			}
			if ok && (start != tc.sess.sentCount || end != len(tc.input)) {
				t.Errorf("range = (%d,%d), want (%d,%d)", start, end, tc.sess.sentCount, len(tc.input))
			}
		})
	}
}

func TestContinuationCovers(t *testing.T) {
	msgs := []provider.Message{
		userMsg("question"),
		toolUseMsg("t1", "bash"),
		toolUseMsg("t2", "bash"),
		toolResultMsg("t1", "ok"),
		toolResultMsg("t2", "ok"),
	}

	pendingT12 := []pendingToolMeta{{ID: "t1", Name: "bash"}, {ID: "t2", Name: "bash"}}
	if !continuationCovers(&activeSession{pendingTools: pendingT12}, msgs) {
		t.Errorf("expected continuation to cover both pending IDs")
	}

	missing := msgs[:4] // only one tool-result
	if continuationCovers(&activeSession{pendingTools: pendingT12}, missing) {
		t.Errorf("expected continuation NOT to cover when one tool-result missing")
	}

	if continuationCovers(nil, msgs) {
		t.Errorf("nil session must not cover")
	}
	if continuationCovers(&activeSession{}, msgs) {
		t.Errorf("session with no pendingToolIDs must not cover")
	}
}

// TestUserInterjectedAfterPendingTools locks in the guard that routes
// "user typed a new message while tools were running" away from
// continueSession (which would silently drop the user content) and into
// the soft-reset + resume-with-delta path. Each case mirrors a real
// claudecode scenario.
func TestUserInterjectedAfterPendingTools(t *testing.T) {
	pending := []pendingToolMeta{{ID: "t1", Name: "bash"}}
	sess := &activeSession{pendingTools: pending}

	// Happy path: pure tool-result tail; this is what continueSession
	// is for. Must NOT be flagged as interjection.
	clean := []provider.Message{
		userMsg("question"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "ok"),
	}
	if userInterjectedAfterPendingTools(sess, clean) {
		t.Errorf("clean tool-result tail must not be flagged as interjection")
	}

	// User typed something after the tool ran. continueSession can't
	// deliver this — must be flagged so the caller routes via resume.
	interjected := append(append([]provider.Message{}, clean...), userMsg("actually, do something else"))
	if !userInterjectedAfterPendingTools(sess, interjected) {
		t.Errorf("user message after tool-result must be flagged as interjection")
	}

	// Multiple tool-results in a row (parallel tool_use) still count as
	// clean — only NON-tool-result content past the last match flips it.
	pendingTwo := []pendingToolMeta{{ID: "t1", Name: "bash"}, {ID: "t2", Name: "bash"}}
	multi := []provider.Message{
		userMsg("question"),
		toolUseMsg("t1", "bash"),
		toolUseMsg("t2", "bash"),
		toolResultMsg("t1", "ok"),
		toolResultMsg("t2", "ok"),
	}
	if userInterjectedAfterPendingTools(&activeSession{pendingTools: pendingTwo}, multi) {
		t.Errorf("parallel tool-results without interjection must not be flagged")
	}

	// No pending tools or no messages — vacuously false.
	if userInterjectedAfterPendingTools(&activeSession{}, clean) {
		t.Errorf("no pending tools must not flag")
	}
	if userInterjectedAfterPendingTools(sess, nil) {
		t.Errorf("empty messages must not flag")
	}
}

// TestContinueSession_CapturesSystemPromptInPrefixHash guards against a
// false-positive prefix-divergence after a tool-calling turn. continueSession
// must thread the full request into finalizeTurn so the captured prefix hash
// includes the system prompt; otherwise the next turn's resume check sees a
// mismatch and cold-starts even when nothing was edited.
func TestContinueSession_CapturesSystemPromptInPrefixHash(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	convID := "conv-cs"
	systemPrompt := "you are a helpful assistant"

	// Pre-buffer the success event the continuation will read off the
	// "live CLI". No real subprocess or reader goroutine needed — we feed
	// the content channel directly (the reader, in production, is what
	// forwards content lines there after peeling off control frames).
	content := make(chan string, 4)
	content <- `{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100}}`
	scanDone := make(chan struct{})
	scanErr := make(chan error, 1)

	c.activeSession = &activeSession{
		sessionUUID:  "uuid-1",
		pendingTools: []pendingToolMeta{{ID: "t1", Name: "bash"}},
		live: &liveCLI{
			content:  content,
			scanDone: scanDone,
			scanErr:  scanErr,
			// continueSession needs the control protocol to deliver
			// tool-results to the (notional) parked CLI. Use io.Discard
			// for stdin — no parked control_request exists in this test
			// since we're testing finalizeTurn's prefix-hash capture, not
			// the actual delivery.
			control: newControlProtocol(io.Discard),
		},
	}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()

	msgs := []provider.Message{
		userMsg("question"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "ok"),
	}
	// Drive the public StreamMessage path: its regime-continue routing calls
	// into continueSession because pendingTools match the tail tool-results
	// and hasLiveCLI returns true (backed by the sentinel cmd wired below).
	cb := func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }
	// hasLiveCLI checks cmd != nil; supply a sentinel cmd with a long-lived
	// process so the continuation path is taken. /bin/cat blocks reading
	// stdin (none of which we ever write) and exits when killed.
	sentinel := mustStartSentinel(t)
	c.activeSession.live.cmd = sentinel
	t.Cleanup(func() { _ = sentinel.Process.Kill(); _ = sentinel.Wait() })

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   systemPrompt,
		Messages:       msgs,
	}, cb); err != nil {
		t.Fatalf("StreamMessage (continuation): %v", err)
	}

	if c.activeSession == nil {
		t.Fatal("session was dropped after continuation")
	}
	want := hashRequestPrefix(systemPrompt, msgs, len(msgs))
	if got := c.activeSession.sentHash; got != want {
		t.Errorf("after continuation, sentHash = %d, want %d (covers system prompt + messages)",
			got, want)
	}
}

// TestCommonArgs_NoBetas verifies that no `--betas` flag is emitted — the
// claudecode provider targets Max/Pro OAuth, where `--betas` is silently
// ignored, so we never pass it.
func TestCommonArgs_NoBetas(t *testing.T) {
	c := &Client{model: "sonnet"}
	args := c.commonArgs("")
	for _, a := range args {
		if a == "--betas" {
			t.Fatalf("--betas must not appear; got %v", args)
		}
	}
}

// TestCommonArgs_PinsDefaultPermissionMode verifies that `--permission-mode
// default` is always emitted — without it the CLI resolves its permission
// mode from settings files shared with the user's interactive sessions in
// the same folder, so a persisted plan mode would block every tool.
func TestCommonArgs_PinsDefaultPermissionMode(t *testing.T) {
	c := &Client{model: "sonnet"}
	args := c.commonArgs("")
	for i, a := range args {
		if a == "--permission-mode" {
			if i+1 >= len(args) || args[i+1] != "default" {
				t.Fatalf("--permission-mode must be followed by \"default\"; got %v", args)
			}
			return
		}
	}
	t.Fatalf("--permission-mode default must appear; got %v", args)
}

// TestListModels_OffersBaseFamilyOnly verifies that the model list is exactly
// the base family (sonnet / opus / haiku / fable) with no `-1m` siblings.
func TestListModels_OffersBaseFamilyOnly(t *testing.T) {
	c, _ := NewClient(provider.Config{Model: "sonnet"})
	infos, _ := c.ListModelsWithInfo(context.Background())
	pick := func(id string) provider.ModelInfo {
		for _, mi := range infos {
			if mi.ID == id {
				return mi
			}
		}
		return provider.ModelInfo{}
	}
	for _, base := range []string{"sonnet", "opus", "haiku", "fable"} {
		if pick(base).ID == "" {
			t.Fatalf("%s missing from ListModelsWithInfo", base)
		}
		if v := pick(base + "-1m"); v.ID != "" {
			t.Fatalf("%s-1m must not be offered; got %+v", base, v)
		}
	}
}

// TestModelAlias verifies that known families collapse to their canonical
// alias, an unrecognised value is passed through verbatim (not coerced to
// sonnet), and only an empty model defaults to sonnet.
func TestModelAlias(t *testing.T) {
	cases := []struct{ model, want string }{
		{"sonnet", "sonnet"},
		{"claude-sonnet-4-5", "sonnet"},
		{"opus", "opus"},
		{"haiku", "haiku"},
		{"fable", "fable"},
		{"claude-fable-5", "fable"},
		{"Fable", "fable"},
		{"", "sonnet"},
		{"some-future-model", "some-future-model"},
		{"  gpt-quux  ", "gpt-quux"},
	}
	for _, tc := range cases {
		c := &Client{model: tc.model}
		if got := c.modelAlias(); got != tc.want {
			t.Errorf("modelAlias(%q) = %q; want %q", tc.model, got, tc.want)
		}
	}
}
