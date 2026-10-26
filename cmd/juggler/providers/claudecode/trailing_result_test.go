//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// queryTrailer is the `result` envelope the CLI writes after a query whose
// stream already ended at end_turn. Its usage is the WHOLE query's — every API
// call of a long tool-use run summed — taken from a real 54-turn sub-agent run.
const queryTrailer = `{"type":"result","subtype":"success","result":"first run's report",` +
	`"usage":{"input_tokens":104,"cache_read_input_tokens":5882974,"cache_creation_input_tokens":165590,"output_tokens":54949}}`

// oneCallTurnLines is one complete API call ending at end_turn, with per-call
// usage on message_start and message_delta as the real CLI reports it.
func oneCallTurnLines(text string, cacheRead int) []string {
	mk := func(v map[string]any) string { b, _ := json.Marshal(v); return string(b) }
	usage := map[string]any{"input_tokens": 2, "cache_read_input_tokens": cacheRead, "cache_creation_input_tokens": 4434, "output_tokens": 332}
	return []string{
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start", "message": map[string]any{"usage": usage}}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_stop", "index": 0}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": usage}}),
	}
}

// liveTestSession attaches a live CLI whose stdout is the returned channel.
func liveTestSession(c *Client, uuid string) chan string {
	content := make(chan string, 64)
	c.activeSession = &activeSession{
		sessionUUID: uuid,
		live:        &liveCLI{content: content, scanErr: make(chan error, 1)},
	}
	return content
}

// readTurn runs one read loop with a deadline, so a parser that swallows too
// much fails the test instead of hanging it.
func readTurn(t *testing.T, c *Client) (*turnResult, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	turn, _, err := c.readUntilPauseOrComplete(ctx, discardStreamChunks)
	return turn, err
}

// TestQueryTrailerIsNotTheNextTurn pins what a resumed session reads first.
//
// A read ends at the stream's own end_turn, and the CLI writes the query's
// `result` envelope after it, so that envelope is still waiting when the next
// Submit reads. Read as a turn, it is an instant, empty end_turn carrying the
// whole previous query's usage: a resumed sub-agent was charged 754k weighted
// tokens for it on its first turn — told its run budget was nearly spent before
// doing anything — and its real first answer was left in the pipe.
func TestQueryTrailerIsNotTheNextTurn(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	content := liveTestSession(c, "uuid-trailer")

	for _, l := range oneCallTurnLines("first run's report", 178071) {
		content <- l
	}
	first, err := readTurn(t, c)
	if err != nil || turnText(first) != "first run's report" {
		t.Fatalf("first read = %q, %v; want the first run's report", turnText(first), err)
	}

	// The query's trailer lands after that read has returned, then the resumed
	// run's own reply follows it.
	content <- queryTrailer
	for _, l := range oneCallTurnLines("second run's answer", 179333) {
		content <- l
	}

	second, err := readTurn(t, c)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if got := turnText(second); got != "second run's answer" {
		t.Fatalf("second read = %q (stop=%q, cacheRead=%d), want the resumed run's own reply — the previous query's result envelope was read as this turn",
			got, second.StopReason, second.CacheReadTokens)
	}
	if second.CacheReadTokens != 179333 || second.OutputTokens != 332 {
		t.Fatalf("second read usage = cacheRead %d, output %d; want this call's 179333 / 332, not the previous query's totals",
			second.CacheReadTokens, second.OutputTokens)
	}
	if len(content) != 0 {
		t.Fatalf("%d line(s) left unread after the resumed turn", len(content))
	}
}

// TestOwedTrailerStillSurfacesAnError: only a clean trailer is passed over. A
// failed result in that position is the CLI reporting a failure, and the turn
// must end with it rather than wait on a reply that is not coming.
func TestOwedTrailerStillSurfacesAnError(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	content := liveTestSession(c, "uuid-trailer-err")

	for _, l := range oneCallTurnLines("done", 1000) {
		content <- l
	}
	if _, err := readTurn(t, c); err != nil {
		t.Fatalf("first read: %v", err)
	}

	content <- `{"type":"result","subtype":"success","is_error":true,"api_error_status":500,"result":"API Error: 500 overloaded"}`
	turn, err := readTurn(t, c)
	if err == nil {
		t.Fatalf("read = %q (stop=%q), want the CLI's failure surfaced", turnText(turn), turn.StopReason)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("the failed result was passed over and the read waited out its deadline")
	}
}

// TestUnowedResultStillEndsATurn: a result that closes a read no stream_event
// answered — nothing owed — is the turn's own ending, as it always was.
func TestUnowedResultStillEndsATurn(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	content := liveTestSession(c, "uuid-unowed")

	content <- `{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":10,"output_tokens":5}}`
	turn, err := readTurn(t, c)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if turn.StopReason != provider.StopReasonEndTurn {
		t.Fatalf("StopReason = %q, want end_turn", turn.StopReason)
	}
}
