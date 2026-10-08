//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/ops"
)

// Generic task-output delivery.
//
// A plugin that has started a background task (via the generic shell
// run-in-background op) can ask the worker to stream that task's stdout into a
// thread as turn-boundary messages, by submitting a `deliverTaskOutput`
// pendingRequests entry. The worker claims it and runs a delivery pump: it polls
// the task's accumulated output, and each time new complete lines appear it
// injects them into the owning thread — queued while a turn is in flight,
// auto-waking the thread when idle (the same intake a typed-while-busy message
// uses). When the task exits (or is cancelled) the pump injects a terminal note
// and completes the entry.
//
// Nothing here is specific to any one tool: the binding carries only a task id
// and a display label. The Monitor tool is the first consumer, but bash's
// run_in_background or any future plugin can request the same delivery.

const (
	// deliveryPollInterval is how often a pump re-reads its task's output.
	deliveryPollInterval = 750 * time.Millisecond
	// deliveryMaxLines auto-stops a runaway task after this many delivered
	// lines, so a misconfigured filter can't flood the conversation forever.
	deliveryMaxLines = 500
	// deliveryMaxInjectChars caps a single injected batch; longer batches are
	// tail-truncated with a note.
	deliveryMaxInjectChars = 8000
)

// taskDeliveryPump is the worker-side handle for one running delivery. The
// goroutine owns the polling loop; the run() goroutine owns the map entry and
// signals stop by closing `stop`.
type taskDeliveryPump struct {
	entryID       string // owning pendingRequests entry id
	ownerThreadID string // thread that owns the entry AND receives the output ("" = root)
	taskID        string
	label         string
	stop          chan struct{}
}

// injectThreadMessageMsg is the payload of the generic "inject-thread-message"
// worker message: drop a message into a thread at the next turn boundary. When
// TaskID is set the injected user item is stamped with that task's provenance
// (TaskSourceRef), so the UI can offer a Stop control on the chunk itself.
type injectThreadMessageMsg struct {
	ThreadItemID string `json:"threadItemId"`
	Text         string `json:"text"`
	TaskID       string `json:"taskId,omitempty"`
	Label        string `json:"label,omitempty"`
}

// deliveryEndedMsg is the payload of "delivery-ended": a pump has finished, so
// the run loop drops it and completes its pendingRequests entry.
type deliveryEndedMsg struct {
	EntryID       string `json:"entryId"`
	OwnerThreadID string `json:"ownerThreadId"`
}

// startTaskDeliveryPump launches a delivery pump for a claimed deliverTaskOutput
// entry, unless one is already running for it. Runs on the run() goroutine.
func (w *ConversationWorker) startTaskDeliveryPump(entryID, ownerThreadID, taskID, label string) {
	if taskID == "" {
		w.writePendingEntryError(ownerThreadID, entryID, "deliverTaskOutput: missing taskId")
		return
	}
	if w.pumps.running(entryID) {
		return
	}
	p := &taskDeliveryPump{
		entryID:       entryID,
		ownerThreadID: ownerThreadID,
		taskID:        taskID,
		label:         label,
		stop:          make(chan struct{}),
	}
	w.pumps.add(p)
	go w.runDeliveryPump(p)
}

// runDeliveryPump polls the task and forwards new output. Goroutine; talks back
// to the run() goroutine only via w.Send so all doc mutation stays single-writer.
func (w *ConversationWorker) runDeliveryPump(p *taskDeliveryPump) {
	ticker := time.NewTicker(deliveryPollInterval)
	defer ticker.Stop()

	var lastLen, totalLines int
	var partial string

	end := func() {
		payload, _ := json.Marshal(deliveryEndedMsg{EntryID: p.entryID, OwnerThreadID: p.ownerThreadID})
		w.Send("delivery-ended", payload)
	}
	inject := func(text string) {
		if len(text) > deliveryMaxInjectChars {
			text = "… (truncated)\n" + text[len(text)-deliveryMaxInjectChars:]
		}
		payload, _ := json.Marshal(injectThreadMessageMsg{
			ThreadItemID: p.ownerThreadID,
			Text:         text,
			TaskID:       p.taskID,
			Label:        p.label,
		})
		w.Send("inject-thread-message", payload)
	}

	for {
		select {
		case <-w.done:
			return
		case <-p.stop:
			return
		case <-ticker.C:
			snap := ops.TaskState(p.taskID)
			if !snap.Found {
				inject(deliveryHeader(p.label) + "\nbackground task is no longer available (it may have been reaped after the server restarted).")
				end()
				return
			}

			// Diff against last-seen output. On a shrink (capped-buffer
			// truncation), resync without re-emitting rather than duplicate.
			out := snap.Output
			var delta string
			if len(out) >= lastLen {
				delta = out[lastLen:]
			}
			lastLen = len(out)

			lines, rest := splitCompleteLines(partial + delta)
			partial = rest
			if len(lines) > 0 {
				totalLines += len(lines)
				inject(deliveryHeader(p.label) + "\n" + strings.Join(lines, "\n"))
				if totalLines >= deliveryMaxLines {
					ops.KillTask(p.taskID)
					inject(deliveryHeader(p.label) + fmt.Sprintf("\n[auto-stopped after %d lines — narrow the command's filter and start a new monitor if you still need it]", totalLines))
					end()
					return
				}
			}

			if snap.Status == "completed" || snap.Status == "failed" {
				if partial != "" {
					inject(deliveryHeader(p.label) + "\n" + partial)
				}
				inject(deliveryHeader(p.label) + fmt.Sprintf("\nbackground task ended (status %s, exit code %d)", snap.Status, snap.ExitCode))
				end()
				return
			}
		}
	}
}

// deliveryHeader is the generic per-message framing; the label is the plugin's.
func deliveryHeader(label string) string {
	if label == "" {
		return "[background task output]"
	}
	return "[" + label + "]"
}

// splitCompleteLines splits s into complete lines (those terminated by '\n') and
// returns the trailing incomplete remainder separately, so a line split across
// two polls is delivered whole. Blank lines are dropped — a filtered monitor
// stream's blank lines carry no signal.
func splitCompleteLines(s string) (lines []string, rest string) {
	idx := strings.LastIndexByte(s, '\n')
	if idx < 0 {
		return nil, s
	}
	complete := s[:idx]
	rest = s[idx+1:]
	for _, ln := range strings.Split(complete, "\n") {
		ln = strings.TrimRight(ln, "\r")
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	return lines, rest
}

// handleInjectThreadMessage drops a message into a thread at the next turn
// boundary: queued when a turn is in flight, added-and-dispatched (auto-wake)
// when idle. Mirrors handleSendMessage's intake so injected messages behave
// exactly like a typed-while-busy / typed-while-idle user message. Generic —
// any worker-internal producer can use it.
func (r *run) handleInjectThreadMessage(payload json.RawMessage) {
	var msg injectThreadMessageMsg
	if !r.decodePayload("inject-thread-message", payload, &msg) {
		return
	}
	input := UserMessageInput{Text: msg.Text}
	if input.isEmpty() {
		return
	}
	// Stamp the chunk with its originating task so the UI can join it back to the
	// live deliverTaskOutput binding and offer the same Stop control the monitor's
	// tool-action shows. Generic: a producer that passes no taskId yields a plain
	// user message.
	if msg.TaskID != "" {
		input.TaskSource = &TaskSourceRef{TaskID: msg.TaskID, Label: msg.Label}
	}

	// Busy: queue it; the strategy loop drains at its next boundary. Both halves
	// are asked of the target thread, so delivery into an idle thread isn't held
	// up by a sibling.
	if r.threadActivity(msg.ThreadItemID) != ActivityNone || r.threadRunState(msg.ThreadItemID) != StateIdle {
		r.enqueuePendingMessage(msg.ThreadItemID, input)
		return
	}

	// Idle: add the message to the thread, then drive a fresh turn. The thread is
	// passed to the write rather than set on the run (see handleSendMessage).
	dest, ok := r.resolveThread(msg.ThreadItemID)
	if !ok {
		return // thread vanished — drop the event
	}
	r.addUserMessageTo(dest, input)
	r.batcher.Flush()
	r.handleItemsChange()

	// Claim the LLM and ask the reducer to dispatch — the same two-step
	// handleSendMessage uses. handleItemsChange alone reconciles state but does
	// not start a turn; without this the injected message would sit unanswered.
	r.requestLLM(msg.ThreadItemID)
	r.sched.markReconcile()
}

// handleDeliveryEnded finalizes a pump that has stopped: drop its handle and
// mark its pendingRequests entry completed (GC'd shortly after). Run() goroutine.
func (w *ConversationWorker) handleDeliveryEnded(payload json.RawMessage) {
	var msg deliveryEndedMsg
	if !w.decodePayload("delivery-ended", payload, &msg) {
		return
	}
	w.pumps.forget(msg.EntryID)
	w.writePendingEntryCompletedThread(msg.OwnerThreadID, msg.EntryID, "", "")
}
