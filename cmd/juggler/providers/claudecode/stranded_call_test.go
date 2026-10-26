//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stranded-call recovery: a tools/call the CLI is blocked on, which no result
// juggler holds will ever answer. Whatever desynchronised the delivery, the
// read loop must answer such a call itself rather than leave both sides
// waiting until the server is restarted.

package claudecode

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// TestReleaseStrandedCalls_PrefersExactStashFromAnyGeneration: a parked call
// whose own result is stashed in a generation it can no longer see is answered
// with that result; one with nothing to pair with is answered with an error.
func TestReleaseStrandedCalls_PrefersExactStashFromAnyGeneration(t *testing.T) {
	buf, cp := captureStdin()
	defer cp.teardown()

	bashArgs := json.RawMessage(`{"command":"cat proposal.md"}`)
	park(t, cp, "req-bash", "1", "bash", bashArgs)
	park(t, cp, "req-read", "2", "read", json.RawMessage(`{"file_path":"/x"}`))
	// The bash result arrives in a later generation than its park.
	cp.runOnActor(func() {
		cp.currentGeneration++
		cp.stashedResults = append(cp.stashedResults, stashedResult{
			key:        makeMCPMatchKey("bash", bashArgs),
			result:     &provider.ToolResult{ToolUseID: "t1", Content: "BASH-OUT", ResultStatus: provider.ResultStatusSuccess},
			generation: cp.currentGeneration,
		})
	})

	if n := cp.releaseStrandedCalls(0); n != 2 {
		t.Fatalf("released %d stranded call(s), want 2", n)
	}
	got := answeredRequestIDs(t, buf)
	if got["req-bash"] != "BASH-OUT" {
		t.Errorf("req-bash got %q, want its own stashed result BASH-OUT", got["req-bash"])
	}
	if !strings.Contains(got["req-read"], "lost") {
		t.Errorf("req-read got %q, want an error saying its result was lost", got["req-read"])
	}
	if n := cp.releaseStrandedCalls(0); n != 0 {
		t.Errorf("a second sweep released %d call(s); every call was already answered", n)
	}
}

// TestReleaseStrandedCalls_LeavesYoungCallsAlone: a call parked moments ago is
// a call whose result is still on its way, not a stranded one.
func TestReleaseStrandedCalls_LeavesYoungCallsAlone(t *testing.T) {
	_, cp := captureStdin()
	defer cp.teardown()
	park(t, cp, "req-bash", "1", "bash", json.RawMessage(`{"command":"ls"}`))
	if n := cp.releaseStrandedCalls(time.Hour); n != 0 {
		t.Fatalf("released %d call(s) parked well inside the grace window", n)
	}
}

// chanWriter hands each write to a channel, so a test can watch the CLI's
// stdin while the control-protocol actor writes it from its own goroutine.
type chanWriter chan string

func (w chanWriter) Write(p []byte) (int, error) {
	w <- string(p)
	return len(p), nil
}

// TestContinueSession_ReleasesStrandedCall reproduces the end state of the
// production wedge from the provider's side: every result for the round has
// been delivered, yet the CLI is still blocked on a tools/call none of them
// answered, so it writes nothing and the turn waits. The read loop must notice
// the parked call outliving the grace window with no model output, answer it,
// and let the CLI finish the turn.
func TestContinueSession_ReleasesStrandedCall(t *testing.T) {
	prevGrace, prevIdle := strandedCallGrace, utils.StreamIdleTimeout
	strandedCallGrace = 50 * time.Millisecond
	// Without the recovery the turn would end only at the idle watchdog — kept
	// short so a regression fails fast rather than hanging the suite.
	utils.StreamIdleTimeout = 3 * time.Second
	t.Cleanup(func() { strandedCallGrace, utils.StreamIdleTimeout = prevGrace, prevIdle })

	c := newTestClient(t, "claude-sonnet-4-6")
	stdin := make(chanWriter, 16)
	cp := newControlProtocol(stdin)

	// The CLI is blocked on a bash call; the round's only pending tool is a read
	// whose result will stash, answering nothing.
	park(t, cp, "req-bash", "1", "bash", json.RawMessage(`{"command":"cat proposal.md"}`))
	content := make(chan string, 4)
	readArgs := json.RawMessage(`{"file_path":"/x"}`)
	// No scanner runs here, so nothing would close scanDone and a stalled turn's
	// teardown would wait on it forever. Close it once the idle watchdog has had
	// its chance, as a real scanner would once teardown killed the process.
	scanDone := make(chan struct{})
	time.AfterFunc(utils.StreamIdleTimeout+time.Second, func() { close(scanDone) })
	c.activeSession = &activeSession{
		sessionUUID:  "uuid-stranded",
		pendingTools: []pendingToolMeta{{ID: "t1", Name: "read", Args: readArgs}},
		live: &liveCLI{
			content:  content,
			scanDone: scanDone,
			scanErr:  make(chan error, 1),
			control:  cp,
		},
	}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()
	sentinel := mustStartSentinel(t)
	c.activeSession.live.cmd = sentinel
	t.Cleanup(func() { _ = sentinel.Process.Kill(); _ = sentinel.Wait() })

	// Play the CLI: once its bash call is answered, it finishes the turn.
	answer := make(chan string, 1)
	go func() {
		for line := range stdin {
			if strings.Contains(line, `"request_id":"req-bash"`) {
				answer <- line
				content <- `{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}`
				return
			}
		}
	}()

	msgs := []provider.Message{
		userMsg("go"),
		toolUseMsg("t1", "read"),
		toolResultMsg("t1", "file contents"),
	}
	cb := func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: "conv-stranded",
		SystemPrompt:   "sys",
		Messages:       msgs,
	}, cb); err != nil {
		t.Fatalf("the turn did not recover from a stranded tools/call: %v", err)
	}

	select {
	case line := <-answer:
		if !strings.Contains(line, `"isError":true`) || !strings.Contains(line, "lost") {
			t.Errorf("stranded call answered with %s, want an error result saying the result was lost", line)
		}
	default:
		t.Fatal("the turn ended without answering the stranded call")
	}
}
