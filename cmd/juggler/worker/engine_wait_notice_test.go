//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// TestSlowEngineIsNamedInThePreparingStatus pins what a turn held up by a slow
// engine tells the user: that the engine has not picked the request up, then
// that it is working on it (from its request-recv trace, through the real
// engine-trace handler), then that it has gone quiet, and once it answers, the
// plain "Preparing request" again. Without it the whole wait reads "Preparing
// request", which on a loaded machine is indistinguishable from a wedge.
//
// The stand-in engine acts on each status it is shown rather than on a clock,
// so the sequence is the same on any core.
func TestSlowEngineIsNamedInThePreparingStatus(t *testing.T) {
	unclaimed, _ := engineWaitUnclaimed.message()
	working, _ := engineWaitWorking.message()
	quiet, _ := engineWaitQuiet.message()

	w, requestIDs := newToolsRequestHarness(t, func(*ConversationWorker, int, string) {})
	w.slowEngineAfter, w.quietEngineAfter = 20*time.Millisecond, 100*time.Millisecond

	seen := make(chan string, 16)
	w.SetCallback("observer", func(b []byte) {
		var event struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &event) == nil && event.Type == string(msgStatus) && event.Status == string(statusPreparing) {
			seen <- event.Message
		}
	})

	var got []string
	go func() {
		requestID := <-requestIDs
		for message := range seen {
			got = append(got, message)
			switch message {
			case unclaimed.English():
				w.handleEngineTrace(json.RawMessage(fmt.Sprintf(`{"event":%q,"requestId":%q}`, engineTraceRequestRecv, requestID)))
			case quiet.English():
				sendToolsReply(w, requestID, "slow-engine-tool")
				return
			}
		}
	}()

	if _, _, err := w.currentRun().requestContextAndToolsFor(nil, true); err != nil {
		t.Fatalf("requestContextAndToolsFor: %v (statuses %q)", err, got)
	}
	plain := <-seen
	want := []string{unclaimed.English(), working.English(), quiet.English()}
	if fmt.Sprint(got) != fmt.Sprint(want) || plain != "" {
		t.Fatalf("preparing statuses = %q then %q, want %q then the plain one", got, plain, want)
	}
}
