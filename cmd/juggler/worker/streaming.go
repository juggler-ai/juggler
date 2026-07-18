//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	providerutils "juggler/cmd/juggler/providers/utils"
)

// streamingState holds accumulated streaming content for one LLM turn.
// Zeroed at iteration boundaries by finalizeStreaming.
type streamingState struct {
	textMsgID       string
	thinkingMsgID   string
	textContent     string
	thinkingContent string
}

// queueStreamChunk sends a streaming chunk to a dedicated channel.
// Thread-safe: can be called from any goroutine (e.g., the LLM provider goroutine).
// Uses a large dedicated channel (not the shared inbound) so chunks are never dropped.
func (w *ConversationWorker) queueStreamChunk(chunk StreamChunk) {
	w.streamChunkChan <- chunk
}

// deliverLLMResponse hands a result to waitForLLMResponse via the 1-buffered
// llmResponseChan. Resilient to the cancel-during-rerun race: if a previously-
// cancelled LLM goroutine deposits a stale result after the new call has
// drained the channel, our send would block forever (1-slot full) and the
// new result would never reach waitForLLMResponse. The select drains any
// stale value as a third case so the next iteration's send wins. No default
// branch — we block until exactly one of {send, shutdown, drain} fires.
func (w *ConversationWorker) deliverLLMResponse(response *LLMResponse, err error) {
	result := llmCallResult{Response: response, Err: err}
	for {
		select {
		case w.llmResponseChan <- result:
			return
		case <-w.done:
			return
		case <-w.llmResponseChan:
			// Stale response from a previously-cancelled call. Loop and
			// retry the send on the now-empty channel.
		}
	}
}

// processCoalescedStreamChunks reads one chunk plus any additional buffered chunks,
// coalesces adjacent text/thinking chunks, and processes them. This produces
// at most one Yjs update per chunk type per call instead of one per token.
func (w *ConversationWorker) processCoalescedStreamChunks(first StreamChunk) {
	// Drain all currently buffered chunks
	chunks := []StreamChunk{first}
	for {
		select {
		case chunk := <-w.streamChunkChan:
			chunks = append(chunks, chunk)
		default:
			goto process
		}
	}
process:
	// Coalesce adjacent same-type text/thinking chunks
	coalesced := make([]StreamChunk, 0, len(chunks))
	current := chunks[0]
	for i := 1; i < len(chunks); i++ {
		c := chunks[i]
		if c.Type == current.Type && (current.Type == provider.ContentBlockTypeText || current.Type == provider.ContentBlockTypeThinking) {
			current.Content += c.Content
		} else {
			coalesced = append(coalesced, current)
			current = c
		}
	}
	coalesced = append(coalesced, current)

	for _, chunk := range coalesced {
		w.processStreamChunk(chunk)
	}
}

// processStreamChunk handles incremental streaming of LLM responses.
// Updates the conversation document and sends streaming-content messages to browser.
func (w *ConversationWorker) processStreamChunk(chunk StreamChunk) {
	switch chunk.Type {
	case provider.ContentBlockTypeText:
		w.processTextChunk(chunk)
	case provider.ContentBlockTypeThinking:
		w.processThinkingChunk(chunk)
	case provider.ContentBlockTypeProgress:
		// Transient mid-stream progress: a running output-token estimate
		// from the provider. Merge into processingState so every peer
		// renders the same digit off the doc (no point-to-point WS frame
		// — a second browser view would never receive it). Throttled
		// because text deltas can arrive ~30/sec on a fast provider; one
		// Yjs broadcast per delta would dominate the sync channel.
		now := time.Now().UnixMilli()
		if now-w.lastProgressWriteMs >= 200 {
			w.lastProgressWriteMs = now
			w.mergeProcessingTokens(chunk.OutputTokens, 0, 0)
		}
	case provider.ContentBlockTypeUsage:
		// Surface input/cached tokens on the live spinner status text
		// (transient — cleared when status leaves "streaming"). The
		// footer's anchor reads the most recent transaction blob's
		// `inputTokens` on demand instead. Spinner text is purely
		// cosmetic and tolerates noisy provider numbers.
		if chunk.InputTokens > 0 {
			w.mergeProcessingTokens(0, chunk.InputTokens, chunk.CachedTokens)
		}
	case provider.ContentBlockTypeStatus:
		// Provider-emitted phase/liveness label: cold-start progress
		// ("Starting Claude Code", "Waiting for response") and the CLI's
		// own rate-limit notices. Before the first token streams, nothing
		// else updates the spinner — surface the phase so a long cold start
		// shows what's happening instead of a static "Receiving..." that
		// looks jammed. Transient: cleared by the next sendStatus, hidden by
		// the frontend once output tokens begin to flow.
		w.mergeProcessingPhase(chunk.Content)
	default:
		// Other chunk types (tool_use, etc.) - finalize any active streaming
		w.finalizeStreaming()
	}
}

func (w *ConversationWorker) processTextChunk(chunk StreamChunk) {
	// If starting a new text block (ID is empty), reset accumulated content
	// This ensures each text block's content is tracked separately for duplicate detection
	if w.streaming.textMsgID == "" {
		w.streaming.textContent = ""
	}

	// Accumulate content for this block
	w.streaming.textContent += chunk.Content

	// Extract <plan> tags from accumulated text and set as nextSteps metadata
	w.extractPlanTag()

	// Create new message if needed
	if w.streaming.textMsgID == "" {
		w.streaming.textMsgID = generateItemID()
		msg := ConversationItem{
			Type:      ItemTypeAssistant,
			ItemID:    w.streaming.textMsgID,
			Content:   w.streaming.textContent,
			Timestamp: time.Now().Format(time.RFC3339),
		}
		w.insertTargetMessage(w.getTargetItemsLength(), msg)
	} else {
		// Update content using messageId lookup - avoids expensive GetItems() JSON conversion
		_ = w.updateTargetItemByID(w.streaming.textMsgID, "content", w.streaming.textContent)
	}

}

// extractPlanTag extracts <plan>...</plan> content from streaming text and
// stores it as the emitting thread's `nextSteps` (per-thread state, like
// goal/result). The root thread has no Y.Map of its own, so its plan lives on
// conversation metadata; a sub-thread's plan lives on its own thread Y.Map.
func (w *ConversationWorker) extractPlanTag() {
	const openTag = "<plan>"
	const closeTag = "</plan>"

	openIdx := strings.Index(w.streaming.textContent, openTag)
	if openIdx == -1 {
		return
	}

	closeIdx := strings.Index(w.streaming.textContent, closeTag)
	if closeIdx == -1 {
		return // Tag not yet closed (still streaming)
	}

	plan := strings.TrimSpace(w.streaming.textContent[openIdx+len(openTag) : closeIdx])
	if plan != "" {
		// Per-thread: a sub-thread's plan lives on its own thread Y.Map so each
		// column reads its own plan and concurrent threads never share one slot.
		// The root thread has no Y.Map, so its plan lives on conversation metadata.
		if w.thread.itemID == "" {
			w.doc.SetMetadata("nextSteps", plan)
		} else {
			w.doc.SetThreadField(w.thread.itemID, "nextSteps", plan)
		}
	}
}

func (w *ConversationWorker) processThinkingChunk(chunk StreamChunk) {
	// Finalize any active text streaming when thinking starts
	if w.streaming.textMsgID != "" && w.streaming.thinkingMsgID == "" {
		w.streaming.textMsgID = ""
	}

	// If starting a new thinking block (ID is empty), reset accumulated content
	// This ensures each thinking block's content is tracked separately for duplicate detection
	if w.streaming.thinkingMsgID == "" {
		w.streaming.thinkingContent = ""
	}

	// Accumulate content for this block
	w.streaming.thinkingContent += chunk.Content

	// Create new message if needed
	if w.streaming.thinkingMsgID == "" {
		w.streaming.thinkingMsgID = generateItemID()
		msg := ConversationItem{
			Type:      ItemTypeThinking,
			ItemID:    w.streaming.thinkingMsgID,
			Content:   w.streaming.thinkingContent,
			Timestamp: time.Now().Format(time.RFC3339),
		}
		w.insertTargetMessage(w.getTargetItemsLength(), msg)
	} else {
		// Update content using messageId lookup - avoids expensive GetItems() JSON conversion
		_ = w.updateTargetItemByID(w.streaming.thinkingMsgID, "content", w.streaming.thinkingContent)
	}

}

// mergeProcessingTokens augments the live processingState with running token
// counts so every observing client renders the same spinner text off the doc.
// Each non-zero argument overwrites its slot; zeros preserve the prior value
// (so the "progress" chunk handler can update outputTokens without clobbering
// the inputTokens/cachedTokens written earlier by the "usage" chunk). No-op
// when status isn't currently a live processing one — we don't want to revive
// a stale spinner after sendStatus("idle").
func (w *ConversationWorker) mergeProcessingTokens(outputTokens, inputTokens, cachedTokens int) {
	raw := w.doc.GetMetadata("processingState")
	state, ok := raw.(map[string]any)
	if !ok || state == nil {
		return
	}
	status, _ := state["status"].(string)
	switch status {
	case "preparing", "streaming", "processing_tools", "retrying":
		// live — fall through
	default:
		return
	}
	if outputTokens > 0 {
		state["outputTokens"] = outputTokens
	}
	if inputTokens > 0 {
		state["inputTokens"] = inputTokens
	}
	if cachedTokens > 0 {
		state["cachedTokens"] = cachedTokens
	}
	w.doc.SetMetadata("processingState", state)
}

// mergeProcessingPhase writes a provider-emitted phase label into the live
// processingState so every observing client renders the same spinner text off
// the doc. Mirrors mergeProcessingTokens' liveness guard: a no-op unless the
// status is a running one, so a status chunk that races past sendStatus("idle")
// can't revive a stale spinner. The next sendStatus rebuilds processingState
// without `phase`, so it never leaks past the phase it describes.
func (w *ConversationWorker) mergeProcessingPhase(phase string) {
	if phase == "" {
		return
	}
	raw := w.doc.GetMetadata("processingState")
	state, ok := raw.(map[string]any)
	if !ok || state == nil {
		return
	}
	status, _ := state["status"].(string)
	switch status {
	case "preparing", "streaming", "processing_tools", "retrying":
		// live — fall through
	default:
		return
	}
	state["phase"] = phase
	w.doc.SetMetadata("processingState", state)
}

func (w *ConversationWorker) finalizeStreaming() {
	// Only clear IDs, not content - content is used for duplicate detection in processLLMResponse
	w.streaming.textMsgID = ""
	w.streaming.thinkingMsgID = ""
}

// partialCancelledResponse assembles whatever text/thinking content was mid-stream
// when the user cancelled, so the transaction blob records the truncated output.
// Returns nil if nothing had been emitted yet.
func (w *ConversationWorker) partialCancelledResponse() *LLMResponse {
	var blocks []LLMResponseBlock
	if w.streaming.thinkingContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeThinking, Thinking: w.streaming.thinkingContent})
	}
	if w.streaming.textContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeText, Content: w.streaming.textContent})
	}
	return &LLMResponse{StopReason: "cancelled", Blocks: blocks}
}

// waitForLLMResponse waits for an LLM response while processing stream chunks
// and handling cancel messages. Stream chunks arrive on a dedicated channel
// and are coalesced before Yjs updates to minimize transaction overhead.
func (w *ConversationWorker) waitForLLMResponse(timeout time.Duration) (*LLMResponse, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case result := <-w.llmResponseChan:
			// Drain remaining stream chunks before returning
			for {
				select {
				case chunk := <-w.streamChunkChan:
					w.processStreamChunk(chunk)
				default:
					if result.Err != nil {
						return result.Response, &deliveredLLMError{err: result.Err}
					}
					return result.Response, nil
				}
			}
		case chunk := <-w.streamChunkChan:
			w.processCoalescedStreamChunks(chunk)
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return nil, ErrCancelled
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.livenessC():
			// A machine freeze (sleep, hibernate, host suspend) during the LLM
			// call would otherwise inflate the elapsed digit by the frozen span;
			// service the detector here too so it self-corrects within a tick of
			// the process resuming, without waiting for the call to return.
			w.detectFrozenGap()
		case <-timer.C:
			return nil, fmt.Errorf("LLM request timed out")
		case <-w.done:
			return nil, fmt.Errorf("worker stopped")
		}
	}
}

// waitForContextAndTools waits for context and tools results concurrently.
// Both requests should be sent before calling this. When needContext is false,
// only the tools response is awaited (context result will be nil).
func (w *ConversationWorker) waitForContextAndTools(timeout time.Duration, needContext bool) (json.RawMessage, json.RawMessage, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var contextResult, toolsResult json.RawMessage
	if !needContext {
		contextResult = []byte("null") // mark as "done" so we only wait for tools
	}

	for contextResult == nil || toolsResult == nil {
		// Disable a channel case once its result is received by using a nil channel
		// (selecting on nil blocks forever, effectively removing the case). This
		// prevents the select from consuming a future pair's value when the goroutine
		// has eagerly buffered the next ctx before tools from the current pair arrive.
		var ctxChan <-chan json.RawMessage
		if contextResult == nil {
			ctxChan = w.contextResultChan
		}
		var toolsChan <-chan json.RawMessage
		if toolsResult == nil {
			toolsChan = w.toolsResultChan
		}
		select {
		case result := <-ctxChan:
			contextResult = result
		case result := <-toolsChan:
			toolsResult = result
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return nil, nil, ErrCancelled
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.livenessC():
			w.detectFrozenGap()
		case <-timer.C:
			// Report which half never answered — the context reply is engine-only
			// (single responder), so a wedge is almost always the context side.
			// Naming it turns an opaque timeout into an actionable diagnosis.
			var missing []string
			if contextResult == nil {
				missing = append(missing, "context")
			}
			if toolsResult == nil {
				missing = append(missing, "tools")
			}
			return nil, nil, fmt.Errorf("context/tools request timed out after %s (no %s response)", timeout, strings.Join(missing, "+"))
		case <-w.done:
			return nil, nil, fmt.Errorf("worker stopped")
		}
	}

	// Return nil for context when it wasn't requested
	if !needContext {
		contextResult = nil
	}

	return contextResult, toolsResult, nil
}

// isRateLimitMsg returns true if an error string indicates an HTTP 429 rate-limit.
func isRateLimitMsg(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(msg, "429") ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "too many requests")
}

// isTransientMsg returns true if an error string indicates a transport-level
// failure that a fresh attempt usually clears: the claude CLI stream stalling
// because the upstream connection dropped (machine slept mid-request, network
// blip). These are worth retrying transparently a couple of times. Deliberately
// narrow — it does NOT match the CLI's "exited unexpectedly" message, which can
// signal genuine quota exhaustion that retrying would only paper over.
func isTransientMsg(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, providerutils.StallMarker) ||
		strings.Contains(lower, providerutils.StallDroppedMarker)
}

// parseRetryWaitFromMsg extracts a suggested retry delay from an error string
// ("in 1.9s", "after 2s", etc.). Falls back to 2 seconds.
func parseRetryWaitFromMsg(msg string) time.Duration {
	lower := strings.ToLower(msg)
	for _, prefix := range []string{"in ", "after "} {
		if idx := strings.Index(lower, prefix); idx != -1 {
			rest := msg[idx+len(prefix):]
			var secs float64
			if _, err := fmt.Sscanf(rest, "%fs", &secs); err == nil && secs > 0 && secs < 120 {
				return time.Duration(secs * float64(time.Second))
			}
		}
	}
	return 2 * time.Second
}

// RetryWaitResult reports how a waitForRetryDelay call ended.
// At most one of Cancelled / NewMessage is true; both false means the timer
// elapsed normally and the caller should retry the request.
type RetryWaitResult struct {
	Cancelled  bool // caller should return from runStrategyLoop
	NewMessage bool // user sent a new message; caller should restart the outer strategy loop
}

// waitForRetryDelay parks for d while processing worker messages (cancel,
// send-message, Yjs updates).
func (w *ConversationWorker) waitForRetryDelay(d time.Duration) RetryWaitResult {
	timer := time.NewTimer(d)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return RetryWaitResult{}

		case msg := <-w.inbound:
			switch msg.Type {
			case "cancel":
				if p := w.llmCancelFunc.Swap(nil); p != nil {
					(*p)()
				}
				w.storeState(StateCancelling)
				return RetryWaitResult{Cancelled: true}

			case "send-message":
				// Only redirect when no tokens have streamed yet (pure retry — no partial response).
				if w.streaming.textContent == "" && w.streaming.thinkingContent == "" {
					var sm SendMessageMessage
					if err := json.Unmarshal(msg.Payload, &sm); err == nil {
						if input := sm.UserInput(); !input.isEmpty() {
							if sm.ThreadItemID != w.thread.itemID {
								w.thread.itemID = sm.ThreadItemID
								if sm.ThreadItemID != "" {
									w.thread.itemsArray = w.doc.GetThreadItemsArray(sm.ThreadItemID)
								} else {
									w.thread.itemsArray = nil
								}
							}
							w.addUserMessage(input)
							w.batcher.Flush()
							return RetryWaitResult{NewMessage: true}
						}
					}
				}
				// Has partial streamed tokens — input box should still be locked; ignore.

			default:
				w.handleMessageInWait(msg)
				if w.loadState() == StateCancelling {
					return RetryWaitResult{Cancelled: true}
				}
			}

		case chunk := <-w.streamChunkChan:
			w.processCoalescedStreamChunks(chunk)
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.done:
			return RetryWaitResult{Cancelled: true}
		}
	}
}
