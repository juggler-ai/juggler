//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// TestUndoEchoAfterRecoilDoesNotRedispatch pins that an undo stays undone
// however late the viewer's echo of it reaches the worker. On a slow core that
// echo lands after historyNavRecoil has run out, so the reducer, not the recoil,
// is what sees it — and it must decide exactly what it decides inside the
// window: nothing. The undo itself withdrew the parked turn's claim, so the
// trailing user message it exposes is history, not a request.
func TestUndoEchoAfterRecoilDoesNotRedispatch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		delay time.Duration
	}{
		{"inside-window", historyNavRecoil / 10},
		{"after-window", historyNavRecoil + 300*time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, acks := historyNavHarness(t)
			r := w.currentRun()
			// a-1 (the harness's reply) is one group; the user's message after it
			// is the next, and the turn it started is parked awaiting the LLM.
			r.appendTargetMessage(userMsg("please continue"))
			w.tracker.StopCapturing()
			r.appendTargetMessage(assistantMsg("an answer"))
			w.tracker.StopCapturing()
			w.doc.SetMetadata("processingState", map[string]any{
				"activity":     ActivityAwaitingLLM,
				"threadItemId": "",
				"status":       "processing_tools",
			})

			payload, _ := json.Marshal(map[string]string{"ackId": "undo-echo"})
			r.handleUndo(payload)
			if ack := awaitAck(t, acks, 5*time.Second); ack.Result != true {
				t.Fatal("the undo was refused")
			}
			before := len(w.doc.GetItems())

			time.Sleep(tc.delay)
			// The viewer's echo: any document change reaches handleItemsChange,
			// and the run loop drains the reducer after every event.
			w.doc.SetMetadata("echo", "from-viewer")
			r.handleItemsChange()
			r.drainReconcile()

			if got := w.getActivity(); got != ActivityNone {
				t.Fatalf("echo %s after the undo left activity %q; the undo's withdrawn turn came back", tc.delay, got)
			}
			if w.sched.hasLive() {
				t.Fatalf("echo %s after the undo started a turn", tc.delay)
			}
			if n := len(w.doc.GetItems()); n != before {
				t.Fatalf("echo %s after the undo changed the items (%d → %d)", tc.delay, before, n)
			}
		})
	}
}
