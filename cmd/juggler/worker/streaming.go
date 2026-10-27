//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	providerutils "juggler/cmd/juggler/providers/utils"
)

// A streamed block's content is a plain string value in a Y.Map, so writing it
// replaces the whole value rather than appending to it: the Yjs update the
// write produces is as long as the message SO FAR, not as long as the new
// characters. One write per provider delta therefore puts O(n²) bytes on the
// wire over a turn — a 20k-character reply arriving in a thousand deltas is
// megabytes of sync traffic per connected client, which is what a remote or
// slow connection actually feels.
//
// Spacing writes in proportion to the content already accumulated keeps a
// turn's total roughly linear: as the reply grows, each write costs more, so
// they are made less often. The reader loses nothing — a single delta is a
// smaller and smaller share of what is on screen as the message lengthens.
const (
	// streamWriteMinChars is the floor on new characters between writes, so a
	// short message still streams smoothly instead of arriving in lumps.
	streamWriteMinChars = 24
	// streamWriteLengthRatio spaces writes at one per len(content)/16 new
	// characters, once that exceeds the floor.
	streamWriteLengthRatio = 16
	// streamWriteMaxDelayMs caps the gap between writes, so a slow trickle of
	// tokens never looks stalled.
	streamWriteMaxDelayMs = 250
)

// streamingState holds accumulated streaming content for one LLM turn.
// Zeroed at iteration boundaries by finalizeStreaming.
//
// The *Content fields are always the complete accumulated text. The document
// is allowed to lag behind them between writes (see the throttle constants
// above); the *WrittenLen fields record how much of each block the document
// currently holds, so a flush knows whether anything is outstanding.
type streamingState struct {
	textMsgID       string
	thinkingMsgID   string
	textContent     string
	thinkingContent string

	textWrittenLen      int
	thinkingWrittenLen  int
	lastTextWriteMs     int64
	lastThinkingWriteMs int64

	// Input usage the provider reported mid-stream for the round-trip in
	// flight. A cancelled round-trip writes a transaction blob like any other,
	// and this is the only account it can give of the prompt it sent: the
	// end-of-turn numbers never arrive for a call that was stopped. Held for
	// the whole round-trip — a tool_use or provider-state chunk finalizes the
	// streamed blocks mid-call and must not take the measurement with them.
	//
	// cachedReported keeps the blob's nil-versus-zero contract: a provider that
	// reported no cache figure is unknown, which is not the same answer as a
	// measured miss.
	inputTokens    int
	cachedTokens   int
	cachedReported bool
}

// queueStreamChunk sends a streaming chunk to this run's dedicated channel.
// Thread-safe: can be called from any goroutine (e.g., the LLM provider goroutine).
// Uses a large dedicated channel (not the shared inbound) so chunks are never dropped.
//
// Falls through on worker shutdown so a provider still emitting after its reader
// has gone is released rather than parked on a channel nobody will drain again.
func (r *run) queueStreamChunk(chunk StreamChunk) {
	select {
	case r.t.chunks <- chunk:
	case <-r.done:
	}
}

// deliverLLMResponse hands one provider attempt's correlated result to the
// shared turn channel. Stale results are consumed and rejected by waiters using
// TurnID; delivery never drains another attempt's answer.
func (r *run) deliverLLMResponse(turnID string, response *LLMResponse, err error) {
	select {
	case r.t.responseChan <- llmCallResult{TurnID: turnID, Response: response, Err: err}:
	case <-r.done:
	}
}

// processCoalescedStreamChunks reads one chunk plus any additional buffered chunks
// for turnID, coalesces adjacent text/thinking chunks, and processes them. Chunks
// from stale provider attempts are discarded rather than crossing generations.
func (r *run) processCoalescedStreamChunks(turnID string, first StreamChunk) {
	// Drain all currently buffered chunks, retaining only this attempt.
	chunks := make([]StreamChunk, 0, 1)
	if first.TurnID == turnID {
		chunks = append(chunks, first)
	}
	for {
		select {
		case chunk := <-r.t.chunks:
			if chunk.TurnID == turnID {
				chunks = append(chunks, chunk)
			}
		default:
			goto process
		}
	}
process:
	if len(chunks) == 0 {
		return
	}
	// Coalesce adjacent same-type text/thinking chunks
	coalesced := make([]StreamChunk, 0, len(chunks))
	current := chunks[0]
	for i := 1; i < len(chunks); i++ {
		c := chunks[i]
		if c.Type == current.Type && (current.Type == provider.ContentBlockTypeText || current.Type == provider.ContentBlockTypeThinking) {
			current.Content += c.Content
			// A thinking block's provider data (signature, reasoning item id)
			// rides on a trailing contentless chunk, which lands here. Carry it
			// onto the merged chunk or the merge is where it goes missing.
			if len(c.Metadata) > 0 && current.Metadata == nil {
				current.Metadata = make(map[string]any, len(c.Metadata))
			}
			for k, v := range c.Metadata {
				current.Metadata[k] = v
			}
		} else {
			coalesced = append(coalesced, current)
			current = c
		}
	}
	coalesced = append(coalesced, current)

	for _, chunk := range coalesced {
		r.processStreamChunk(chunk)
	}
}

// drainStreamChunks folds any chunk still buffered for the current provider
// attempt into the document, then levels the write throttle up.
//
// It stands in for the run loop's old chunk case: a chunk that lands after its
// wait loop has already returned has no later write to be folded into, so
// nothing else would ever pick it up and the throttle must not hold it back.
// Chunks carrying another attempt's generation are discarded, exactly as that
// case discarded them.
func (r *run) drainStreamChunks() {
	for {
		select {
		case chunk := <-r.t.chunks:
			r.processCoalescedStreamChunks(r.t.llmTurnID, chunk)
		default:
			r.flushPendingStreamWrites()
			return
		}
	}
}

// processStreamChunk handles incremental streaming of LLM responses.
// Updates the conversation document and sends streaming-content messages to browser.
func (r *run) processStreamChunk(chunk StreamChunk) {
	switch chunk.Type {
	case provider.ContentBlockTypeText:
		r.clearRetryingStatus()
		r.processTextChunk(chunk)
	case provider.ContentBlockTypeThinking:
		r.clearRetryingStatus()
		r.processThinkingChunk(chunk)
	case provider.ContentBlockTypeActivity:
		// Provider activity is a complete, replaceable snapshot. It lives only in
		// this run's processingState entry and is never inserted into
		// conversation history.
		r.patchLiveRun(func(entry runEntry) { entry.setDescription(chunk.Content) })
	case provider.ContentBlockTypeProviderState:
		// Hidden continuation data is durable and ordered with the provider's
		// visible output, even when it has no content of its own.
		r.finalizeStreaming()
		if len(chunk.Metadata) > 0 {
			id := generateItemID()
			r.t.attemptOutput = append(r.t.attemptOutput, id)
			r.appendTargetMessage(ConversationItem{
				Type:         ItemTypeProviderState,
				ItemID:       id,
				ProviderData: chunk.Metadata,
				Timestamp:    time.Now().Format(time.RFC3339),
			})
		}
	case provider.ContentBlockTypeProgress:
		// Transient mid-stream progress: a running output-token estimate
		// from the provider. Merge into this run's processingState entry so
		// every peer renders the same digit off the doc (no point-to-point WS
		// frame — a second browser view would never receive it). Throttled
		// because text deltas can arrive ~30/sec on a fast provider; one
		// Yjs broadcast per delta would dominate the sync channel.
		now := time.Now().UnixMilli()
		if now-r.t.lastProgressWriteMs >= 200 {
			r.t.lastProgressWriteMs = now
			r.mergeProcessingTokens(chunk.OutputTokens, 0, 0)
		}
	case provider.ContentBlockTypeUsage:
		// Surface input/cached tokens on the live spinner status text
		// (transient — cleared when status leaves "streaming"). The
		// footer's anchor reads the most recent transaction blob's
		// `inputTokens` on demand instead. Spinner text is purely
		// cosmetic and tolerates noisy provider numbers.
		//
		// The same figures are kept on the run, where a cancel can still reach
		// them: the blob a cancelled round-trip writes has no other source for
		// what the call sent.
		if chunk.InputTokens > 0 {
			r.t.streaming.inputTokens = chunk.InputTokens
			if chunk.CachedTokens > 0 {
				r.t.streaming.cachedTokens = chunk.CachedTokens
				r.t.streaming.cachedReported = true
			}
			r.mergeProcessingTokens(0, chunk.InputTokens, chunk.CachedTokens)
		}
	case provider.ContentBlockTypeStatus:
		// Provider-emitted retry, cache, or notice status. These exceptional
		// conditions replace any ordinary activity description and remain visible
		// as the turn's current phase until output takes precedence.
		//
		// A status chunk may ALSO carry a consequential cache miss. That is not
		// transient — it is an event worth reading after the fact — so it lands
		// in the transcript as its own item instead of riding the spinner.
		r.clearProcessingDescription()
		r.mergeProcessingPhase(chunk.Content)
		r.insertCacheMissNotice(chunk.CacheMissReason)
		r.insertProviderNotice(chunk.Notice)
	default:
		// Other chunk types (tool_use, etc.) end any provider activity.
		r.clearProcessingDescription()
		r.finalizeStreaming()
	}
}

// clearProcessingDescription drops this run's provider-activity line. Scoped to
// the run's own entry: a sibling's activity snapshot is its own business.
func (r *run) clearProcessingDescription() {
	r.patchLiveRun(runEntry.clearDescription)
}

// streamWriteDue reports whether an accumulated block has moved far enough — in
// characters or in elapsed time — to be worth re-encoding into the document.
func streamWriteDue(contentLen, writtenLen int, lastWriteMs, nowMs int64) bool {
	threshold := contentLen / streamWriteLengthRatio
	if threshold < streamWriteMinChars {
		threshold = streamWriteMinChars
	}
	return contentLen-writtenLen >= threshold || nowMs-lastWriteMs >= streamWriteMaxDelayMs
}

// resetStreamingText starts a fresh text block: the accumulated content and the
// marks that track how much of it the document holds go together, or the next
// block's throttle would compare against the previous block's length.
func (r *run) resetStreamingText() {
	r.t.streaming.textContent = ""
	r.t.streaming.textWrittenLen = 0
	r.t.streaming.lastTextWriteMs = 0
}

// resetStreamingThinking is resetStreamingText's counterpart for thinking blocks.
func (r *run) resetStreamingThinking() {
	r.t.streaming.thinkingContent = ""
	r.t.streaming.thinkingWrittenLen = 0
	r.t.streaming.lastThinkingWriteMs = 0
}

// writeStreamingText puts the whole accumulated text block into the document
// and records what the document now holds.
func (r *run) writeStreamingText() {
	// Update content using messageId lookup - avoids expensive GetItems() JSON conversion
	r.updateRunItem(r.t.streaming.textMsgID, keyContent, r.t.streaming.textContent)
	r.t.streaming.textWrittenLen = len(r.t.streaming.textContent)
	r.t.streaming.lastTextWriteMs = time.Now().UnixMilli()
}

// writeStreamingThinking is writeStreamingText's counterpart for thinking blocks.
func (r *run) writeStreamingThinking() {
	r.updateRunItem(r.t.streaming.thinkingMsgID, keyContent, r.t.streaming.thinkingContent)
	r.t.streaming.thinkingWrittenLen = len(r.t.streaming.thinkingContent)
	r.t.streaming.lastThinkingWriteMs = time.Now().UnixMilli()
}

// flushStreamingText writes any text the throttle is still holding back. A
// no-op when the document is already current, so a caller that cannot tell
// whether a write is outstanding can call it unconditionally — which is what
// every path that reads, persists or finalises the document does.
func (r *run) flushStreamingText() {
	if r.t.streaming.textMsgID == "" || r.t.streaming.textWrittenLen >= len(r.t.streaming.textContent) {
		return
	}
	r.writeStreamingText()
}

// flushStreamingThinking is flushStreamingText's counterpart for thinking blocks.
func (r *run) flushStreamingThinking() {
	if r.t.streaming.thinkingMsgID == "" || r.t.streaming.thinkingWrittenLen >= len(r.t.streaming.thinkingContent) {
		return
	}
	r.writeStreamingThinking()
}

// flushPendingStreamWrites brings the document level with the accumulated
// streaming content of both block kinds. Every path that ends a block, ends a
// turn, persists the document, or hands it to something that reads it back must
// go through here first: the throttle's lag is only ever allowed to be
// transient, and a missed flush silently truncates a message.
func (r *run) flushPendingStreamWrites() {
	r.flushStreamingText()
	r.flushStreamingThinking()
}

func (r *run) processTextChunk(chunk StreamChunk) {
	// If starting a new text block (ID is empty), reset accumulated content
	// This ensures each text block's content is tracked separately for duplicate detection
	if r.t.streaming.textMsgID == "" {
		// Text following a thinking block leaves that block's tail unwritten;
		// nothing else will come back to it until the turn ends.
		r.flushStreamingThinking()
		r.resetStreamingText()
	}

	// Accumulate content for this block
	r.t.streaming.textContent += chunk.Content

	// Extract <plan> tags from accumulated text and set as nextSteps metadata
	r.extractPlanTag()

	// Create new message if needed
	if r.t.streaming.textMsgID == "" {
		r.t.streaming.textMsgID = generateItemID()
		r.t.attemptOutput = append(r.t.attemptOutput, r.t.streaming.textMsgID)
		msg := ConversationItem{
			Type:      ItemTypeAssistant,
			ItemID:    r.t.streaming.textMsgID,
			Content:   r.t.streaming.textContent,
			Timestamp: time.Now().Format(time.RFC3339),
		}
		r.appendTargetMessage(msg)
		// The first write of a block is never throttled: the bubble has to
		// appear the moment the model starts talking.
		r.t.streaming.textWrittenLen = len(r.t.streaming.textContent)
		r.t.streaming.lastTextWriteMs = time.Now().UnixMilli()
	} else if streamWriteDue(len(r.t.streaming.textContent), r.t.streaming.textWrittenLen,
		r.t.streaming.lastTextWriteMs, time.Now().UnixMilli()) {
		r.writeStreamingText()
	}
}

// extractPlanTag extracts <plan>...</plan> content from streaming text and
// stores it as the emitting thread's `nextSteps` (per-thread state, like
// goal/result). The root thread has no Y.Map of its own, so its plan lives on
// conversation metadata; a sub-thread's plan lives on its own thread Y.Map.
func (r *run) extractPlanTag() {
	const openTag = "<plan>"
	const closeTag = "</plan>"

	openIdx := strings.Index(r.t.streaming.textContent, openTag)
	if openIdx == -1 {
		return
	}

	closeIdx := strings.Index(r.t.streaming.textContent, closeTag)
	if closeIdx == -1 {
		return // Tag not yet closed (still streaming)
	}

	plan := strings.TrimSpace(r.t.streaming.textContent[openIdx+len(openTag) : closeIdx])
	if plan != "" {
		// Per-thread: a sub-thread's plan lives on its own thread Y.Map so each
		// column reads its own plan and concurrent threads never share one slot.
		// The root thread has no Y.Map, so its plan lives on conversation metadata.
		if r.t.thread.itemID == "" {
			r.doc.SetMetadata(keyNextSteps, plan)
		} else {
			r.doc.SetThreadField(r.t.thread.itemID, keyNextSteps, plan)
		}
	}
}

func (r *run) processThinkingChunk(chunk StreamChunk) {
	// A thinking block's provider data (Anthropic signature, OpenAI reasoning
	// item id + encrypted content) is known only once the block ends, so it
	// arrives on a trailing contentless chunk. With no thinking block on screen
	// there is nothing to attach it to: an item created for it would be empty,
	// which renders as a blank tile and is dropped from the wire anyway
	// (itemWireMessages emits nothing for contentless thinking). Let it go.
	if chunk.Content == "" && len(chunk.Metadata) > 0 && r.t.streaming.thinkingMsgID == "" {
		return
	}

	// Finalize any active text streaming when thinking starts
	if r.t.streaming.textMsgID != "" && r.t.streaming.thinkingMsgID == "" {
		// The text block is ending here, so this is the last chance to write
		// whatever the throttle held back from it.
		r.flushStreamingText()
		r.t.streaming.textMsgID = ""
	}

	// If starting a new thinking block (ID is empty), reset accumulated content
	// This ensures each thinking block's content is tracked separately for duplicate detection
	if r.t.streaming.thinkingMsgID == "" {
		r.resetStreamingThinking()
	}

	// Accumulate content for this block
	r.t.streaming.thinkingContent += chunk.Content

	// Create new message if needed
	if r.t.streaming.thinkingMsgID == "" {
		r.t.streaming.thinkingMsgID = generateItemID()
		r.t.attemptOutput = append(r.t.attemptOutput, r.t.streaming.thinkingMsgID)
		msg := ConversationItem{
			Type:         ItemTypeThinking,
			ItemID:       r.t.streaming.thinkingMsgID,
			Content:      r.t.streaming.thinkingContent,
			ProviderData: chunk.Metadata,
			Timestamp:    time.Now().Format(time.RFC3339),
		}
		r.appendTargetMessage(msg)
		// The first write of a block is never throttled: the tile has to appear
		// the moment the model starts reasoning.
		r.t.streaming.thinkingWrittenLen = len(r.t.streaming.thinkingContent)
		r.t.streaming.lastThinkingWriteMs = time.Now().UnixMilli()
		return
	}

	// Provider data is what lets the next turn replay this block: Anthropic
	// rejects a signatureless thinking block, and the Responses API needs
	// the reasoning item's id and encrypted content to carry the chain of
	// thought across a tool call. It rides a trailing chunk that ends the
	// block, so the content goes in alongside it whatever the throttle says.
	if len(chunk.Metadata) > 0 {
		r.flushStreamingThinking()
		r.updateRunItem(r.t.streaming.thinkingMsgID, keyProviderData, chunk.Metadata)
		return
	}

	if streamWriteDue(len(r.t.streaming.thinkingContent), r.t.streaming.thinkingWrittenLen,
		r.t.streaming.lastThinkingWriteMs, time.Now().UnixMilli()) {
		r.writeStreamingThinking()
	}
}

// mergeProcessingTokens augments this run's processingState entry with running
// token counts, so every observing client renders the same spinner text off the
// doc. Each non-zero argument overwrites its slot; zeros preserve the prior value
// (so the "progress" chunk handler can update outputTokens without clobbering
// the inputTokens/cachedTokens written earlier by the "usage" chunk). No-op
// unless the run's own status is a live processing one — we don't want to revive
// a stale spinner after sendStatus("idle").
//
// Read and write happen inside one hold on the entry the counts belong to: two
// runs streaming at once report their own totals, and neither can lose the
// other's update between a read and a write.
func (r *run) mergeProcessingTokens(outputTokens, inputTokens, cachedTokens int) {
	r.patchLiveRun(func(entry runEntry) { entry.mergeTokens(outputTokens, inputTokens, cachedTokens) })
}

// mergeProcessingPhase writes a provider-emitted phase label into this run's
// processingState entry so every observing client renders the same spinner text
// off the doc. Mirrors mergeProcessingTokens' liveness guard: a no-op unless the
// run's own status is a running one, so a status chunk that races past
// sendStatus("idle") can't revive a stale spinner.
func (r *run) mergeProcessingPhase(phase string) {
	if phase == "" {
		return
	}
	r.patchLiveRun(func(entry runEntry) { entry.setPhase(phase) })
}

// cacheMissNoticeText is a cache-miss notice's text. The content states, in
// plain English, what the miss cost, with the provider's own reason after it
// verbatim: the lead goes ABOVE the underlying text, never in place of it. The
// summary is the same statement cut to a transcript row, which has one line to
// say what happened in, so it drops the cache the lead names and keeps the
// cost, which is the part worth reading in passing.
func cacheMissNoticeText(reason string) (summary, content msg.Message) {
	return msg.New("Claude Code re-read the whole conversation"),
		msg.New("Claude Code re-read the whole conversation instead of using its cached copy, so this turn cost more than it needed to.\n\nReason: {reason}",
			"reason", reason)
}

// insertCacheMissNotice records a consequential provider cache miss in the
// transcript, at the point in the conversation where it happened — after the
// message that triggered the turn, before the reply it paid for. A miss is
// worth reading after the fact (and worth still being there tomorrow), so it is
// a durable item rather than a caption on a spinner that the next status frame
// overwrites.
//
// Going through appendTargetMessage stamps the in-flight transaction id, so
// undoing the turn takes the notice with it. The item is deliberately absent
// from itemWireMessages: the model neither needs nor benefits from reading
// about our caching.
func (r *run) insertCacheMissNotice(reason string) {
	if reason == "" || reason == r.t.lastCacheMissNotice {
		return
	}
	r.t.lastCacheMissNotice = reason
	notice := ConversationItem{
		Type:      ItemTypeNotice,
		ItemID:    generateItemID(),
		Source:    "claudecode",
		Timestamp: time.Now().Format(time.RFC3339),
	}
	// The summary is the row's only text — the transcript shows a warning
	// triangle, a "Warning" lozenge and this — so it is a sentence that explains
	// itself, kept to one line. The detail is in Content, for the panel.
	summary, content := cacheMissNoticeText(reason)
	setNoticeText(&notice, summary, content)
	r.appendTargetMessage(notice)
}

// insertProviderNotice records a durable warning the provider composed in full
// — a serving tier the backend declined, say — at the point in the conversation
// where it happened.
//
// Deduplicated on the whole notice for the worker's lifetime, because the
// conditions that produce one rarely hold for a single turn: a plan that cannot
// use a tier cannot use it on the next turn either, and a warning repeated on
// every reply stops being information and becomes wallpaper. Once is the
// honest count.
func (r *run) insertProviderNotice(notice *StreamNotice) {
	if notice == nil || notice.Summary == "" || notice.Content == "" {
		return
	}
	key := notice.Summary + "\x00" + notice.Content
	if key == r.t.lastProviderNotice {
		return
	}
	r.t.lastProviderNotice = key
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeNotice,
		ItemID:    generateItemID(),
		Summary:   notice.Summary,
		Content:   notice.Content,
		Source:    notice.Source,
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// truncationNoticeData is the Data payload of a truncation notice that offers a
// one-off retry: the Max output to retry at, and the items the cut-off turn left
// that the retry replaces. Absent when no larger Max output can be had.
type truncationNoticeData struct {
	RetryMaxOutput int      `json:"retryMaxOutput,omitempty"`
	Discard        []string `json:"discard,omitempty"`
}

// insertTruncationNotice records that the provider ended a turn at its output
// budget, at the point in the conversation where it happened.
//
// A truncation is not deduplicated the way a provider-composed notice is: two
// turns cut short are two separate events, each worth seeing where it landed,
// whereas a declined serving tier is one standing condition restated. The
// strategy loop calls this at most once per turn, so there is no repetition to
// suppress within a turn either.
//
// The budget quoted is the output reserve admission charged for this model,
// which includes the user's Max output tokens override, so the note explains
// the limit the user can actually act on rather than a provider-side default
// nobody here can see. It is also the max_tokens sent, except where a
// provider's catalogue knows a lower ceiling for the model and the request is
// clamped to that.
//
// A budget Juggler derived from the window is the one a user cannot trace to
// anything they or their server set, so that case names the figure as Juggler's
// default, the window it came from, and what raising it costs.
//
// When endsRun is true the run stops here, with nothing of the turn worth
// keeping beyond what the retry would redo, and a larger Max output can be had,
// the notice also offers a one-off retry at double the figure that ran out —
// capped where the provider's own limit, or half the window, says it must be.
func (r *run) insertTruncationNotice(response *LLMResponse, endsRun bool) {
	limits := r.resolveContextWindow()
	reserve := limits.ReserveTokens
	// A raised retry that ran out too is quoted at the figure it was sent with,
	// which is no longer the derived default.
	if r.t.maxOutputTokens > reserve {
		reserve = r.t.maxOutputTokens
		limits.ReserveDerived = false
	}

	// The measured figures say whichever of the budget and its use are known.
	budget := "none"
	switch {
	case reserve > 0 && response.OutputTokens > 0:
		budget = "both"
	case reserve > 0:
		budget = "reserve"
	case response.OutputTokens > 0:
		budget = "used"
	}
	// The lead states, in plain English, what a max_tokens stop actually was;
	// the measured numbers follow it, and it never replaces them. The reported
	// case — a reasoning model that never reached an answer — is said outright,
	// because the transcript shows thinking and then nothing, which reads like a
	// crash rather than a budget.
	content := msg.New("The model hit its output limit before it finished, so this turn stops mid-reply."+
		"{thinkingOnly, select, yes { It used all of that on thinking, so there is no answer to show.} other {}}\n\n"+
		"{budget, select, both {Max output: {reserve} tokens; this turn used {used}. } reserve {Max output: {reserve} tokens. } used {This turn produced {used} output tokens. } other {}}"+
		"Thinking counts against it. To allow longer replies, raise this model's "+
		"Max output tokens under its provider's \"Models and token limits\" in Settings. Unless you set it there, "+
		"Juggler uses the limit your provider reports for the model, or derives one from its context window, so a "+
		"window smaller than the one your server really serves shrinks replies too.",
		"thinkingOnly", yesNo(!hasAssistantText(response)), "budget", budget,
		"reserve", reserve, "used", response.OutputTokens)
	if limits.ReserveDerived && reserve > 0 && limits.WindowTokens > 0 {
		content = msg.New("The model hit its output limit before it finished, so this turn stops mid-reply."+
			"{thinkingOnly, select, yes { It used all of that on thinking, so there is no answer to show.} other {}}\n\n"+
			"{budget, select, both {Max output: {reserve} tokens; this turn used {used}. } other {Max output: {reserve} tokens. }}"+
			"Neither you nor the provider set a limit for this model, so that is Juggler's default, derived from its "+
			"{window}-token context window. Thinking counts against it. To allow longer replies, set this model's "+
			"Max output tokens under its provider's \"Models and token limits\" in Settings. Max output is held back "+
			"inside the context window, so a larger one leaves less room for conversation history.",
			"thinkingOnly", yesNo(!hasAssistantText(response)), "budget", budget,
			"reserve", reserve, "used", response.OutputTokens, "window", limits.WindowTokens)
	}

	source := ""
	if mc := r.resolveModelConfig(); mc != nil {
		source = mc.Provider
	}
	notice := ConversationItem{
		Type:      ItemTypeNotice,
		ItemID:    generateItemID(),
		Source:    source,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	if retry := min(2*reserve, limits.OutputRaiseCeiling); endsRun && reserve > 0 && retry > reserve {
		data := truncationNoticeData{
			RetryMaxOutput: retry,
			Discard:        append([]string(nil), r.t.attemptOutput...),
		}
		if raw, err := json.Marshal(data); err == nil {
			notice.Data = raw
		}
	}
	// The lead alone is the row: it already says what happened in one line, and
	// the measured numbers that follow it are the panel's business.
	setNoticeText(&notice, msg.New("The model hit its output limit before it finished, so this turn stops mid-reply."), content)
	r.appendTargetMessage(notice)
}

func (r *run) finalizeStreaming() {
	// Both blocks end here, and clearing the IDs makes their accumulated content
	// unreachable — so anything the throttle held back goes in first. This is
	// the flush point for a tool_use or provider-state chunk arriving mid-turn
	// and for every strategy-loop iteration boundary.
	r.flushPendingStreamWrites()

	// Only clear IDs, not content - content is used for duplicate detection in processLLMResponse
	r.t.streaming.textMsgID = ""
	r.t.streaming.thinkingMsgID = ""
}

// partialCancelledResponse assembles whatever text/thinking content was mid-stream
// when the user cancelled, so the transaction blob records the truncated output.
// Returns nil if nothing had been emitted yet.
//
// It carries the round-trip's input usage too, where the provider reported any.
// A cancelled call is a call that was paid for, and its blob is the last one in
// the thread — so it is the one the footer anchors on. Recording nothing there
// leaves the footer with an anchor that reports nothing, which it cannot draw at
// all: the count vanishes for a conversation whose every earlier turn has one.
func (r *run) partialCancelledResponse() *LLMResponse {
	// The blob and the transcript must show the same truncated output, so the
	// document catches up with the accumulated content before it is read off.
	r.flushPendingStreamWrites()

	var blocks []LLMResponseBlock
	if r.t.streaming.thinkingContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeThinking, Thinking: r.t.streaming.thinkingContent})
	}
	if r.t.streaming.textContent != "" {
		blocks = append(blocks, LLMResponseBlock{Type: provider.ContentBlockTypeText, Content: r.t.streaming.textContent})
	}
	response := &LLMResponse{
		StopReason:  provider.StopReasonCancelled,
		Blocks:      blocks,
		InputTokens: r.t.streaming.inputTokens,
	}
	if r.t.streaming.cachedReported {
		response.CachedTokens = provider.Reported(r.t.streaming.cachedTokens)
	}
	return response
}

// resetStreamingUsage drops the input usage measured for the round-trip that has
// just ended, so the next one starts with no measurement of its own rather than
// inheriting the previous call's. Part of the iteration boundary in the strategy
// loop, alongside the content resets — deliberately not part of
// finalizeStreaming, which also runs mid-call.
func (r *run) resetStreamingUsage() {
	r.t.streaming.inputTokens = 0
	r.t.streaming.cachedTokens = 0
	r.t.streaming.cachedReported = false
}

// waitForLLMResponse waits for an LLM response while processing stream chunks
// and handling cancel messages. Stream chunks arrive on a dedicated channel
// and are coalesced before Yjs updates to minimize transaction overhead.
//
// timeout runs from the attempt's last model output (failingSince), not from
// its start: a call that keeps producing is never cut off, however long it
// runs, while one that produces nothing for timeout gives up even if status or
// usage chunks keep its provider's idle watchdog fed.
func (r *run) waitForLLMResponse(turnID string, timeout time.Duration) (*LLMResponse, error) {
	// Every exit from the wait — response, cancel, timeout, worker stop, panic —
	// ends the streamed blocks, so the document catches up here rather than at
	// each return. The flush is a direct write, never a wait on the throttle
	// window, so a finished stream still completes immediately.
	defer r.flushPendingStreamWrites()

	start := time.Now()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case result := <-r.t.responseChan:
			if result.TurnID != turnID {
				continue
			}
			// Drain remaining chunks from this attempt before returning. Chunks
			// carrying another generation are stale and are discarded.
			for {
				select {
				case chunk := <-r.t.chunks:
					if chunk.TurnID == turnID {
						r.processStreamChunk(chunk)
					}
				default:
					if result.Err != nil {
						return result.Response, &deliveredLLMError{err: result.Err}
					}
					return result.Response, nil
				}
			}
		case chunk := <-r.t.chunks:
			r.processCoalescedStreamChunks(turnID, chunk)
		case <-r.t.wake:
			if r.loadState() == StateCancelling {
				return nil, ErrCancelled
			}
		case <-timer.C:
			if left := timeout - time.Since(r.failingSince(start)); left > 0 {
				timer.Reset(left)
				continue
			}
			return nil, fmt.Errorf("LLM request timed out")
		case <-r.done:
			return nil, fmt.Errorf("worker stopped")
		}
	}
}

// waitForContextAndTools waits on the private channels registered for this pair.
// A nil context channel means only the tools response is required.
//
// It waits for as long as the engine that was asked stays attached, checking
// every `check`, and at most `ceiling` (see ContextTimeout). An engine that
// goes away can never answer, so that fails at the next check and says so.
func (r *run) waitForContextAndTools(check, ceiling time.Duration, contextReply, toolsReply <-chan json.RawMessage) (json.RawMessage, json.RawMessage, error) {
	asked := r.callbacks.engineClientID()
	started := time.Now()
	ticker := time.NewTicker(check)
	defer ticker.Stop()
	ceilingTimer := time.NewTimer(ceiling)
	defer ceilingTimer.Stop()

	var contextResult, toolsResult json.RawMessage
	needContext := contextReply != nil
	if !needContext {
		contextResult = []byte("null")
	}

	for contextResult == nil || toolsResult == nil {
		ctxChan := contextReply
		if contextResult != nil {
			ctxChan = nil
		}
		toolsChan := toolsReply
		if toolsResult != nil {
			toolsChan = nil
		}
		select {
		case contextResult = <-ctxChan:
		case toolsResult = <-toolsChan:
		case <-r.t.wake:
			if r.loadState() == StateCancelling {
				return nil, nil, ErrCancelled
			}
		case <-ticker.C:
			now := r.callbacks.engineClientID()
			if asked != "" && now == asked {
				continue
			}
			if asked == "" {
				return nil, nil, fmt.Errorf("context/tools request had no engine attached to answer it (no %s response after %s)", missingHalves(contextResult, toolsResult), time.Since(started).Round(time.Millisecond))
			}
			attached := now
			if attached == "" {
				attached = "none"
			}
			return nil, nil, fmt.Errorf("context/tools request's engine %s is no longer attached (now %s; no %s response after %s)", asked, attached, missingHalves(contextResult, toolsResult), time.Since(started).Round(time.Millisecond))
		case <-ceilingTimer.C:
			return nil, nil, fmt.Errorf("context/tools request unanswered after %s by engine %s, still attached (no %s response)", ceiling, asked, missingHalves(contextResult, toolsResult))
		case <-r.done:
			return nil, nil, fmt.Errorf("worker stopped")
		}
	}

	// Return nil for context when it wasn't requested
	if !needContext {
		contextResult = nil
	}

	return contextResult, toolsResult, nil
}

// defaultRetryWait is what a rate limit that states no reset is retried after.
// It is a guess, and callers are told as much (the second return of
// parseRetryWaitFromMsg) so that nothing treats it as the provider's word.
const defaultRetryWait = 2 * time.Second

// parseRetryWaitFromMsg extracts the wait a provider stated, from a 429's body
// fields where it carries them and otherwise from the message prose ("in 1.9s",
// "after 2s"). The second return reports whether the provider actually said
// anything; when it is false the duration is defaultRetryWait, a guess.
//
// The distinction is the whole point. A conversation that reads an unstated
// wait as "about two seconds" retries into a four-hour cap, three times per
// thread, and learns nothing it could have acted on.
func parseRetryWaitFromMsg(msg string) (time.Duration, bool) {
	// The body a provider states its reset in is embedded in the error text by
	// the time it reaches here, so it is read from the text directly. Providers
	// that hand us the response itself go through providerutils.ParseRateLimitHint
	// at the provider boundary, where the headers are still attached.
	if d := providerutils.ParseRateLimitHint(nil, msg); d > 0 {
		return d, true
	}
	lower := strings.ToLower(msg)
	for _, prefix := range []string{"in ", "after "} {
		if idx := strings.Index(lower, prefix); idx != -1 {
			rest := msg[idx+len(prefix):]
			var secs float64
			if _, err := fmt.Sscanf(rest, "%fs", &secs); err == nil && secs > 0 {
				return min(time.Duration(secs*float64(time.Second)), providerutils.MaxRateLimitHint), true
			}
		}
	}
	return defaultRetryWait, false
}

// RetryWaitResult reports how a waitForRetryDelay call ended.
// At most one of Cancelled / NewMessage / Paused is true; all false means the
// timer elapsed normally and the caller should retry the request.
type RetryWaitResult struct {
	Cancelled  bool // caller should return from runStrategyLoop
	NewMessage bool // user sent a new message; caller should restart the outer strategy loop
	Paused     bool // a polite stop landed on this thread; caller should end the turn at rest
}

// waitForRetryDelay parks for d, and reports the three things that can end the
// backoff early: a cancel, a fresh user message queued for this run's thread, and
// a polite stop (Pause) landing over it.
//
// The last two are why retryWaiting exists. Every other wait a turn does ends on
// its own — a response lands, a reply comes back — and anything that arrives
// meanwhile is read at the next turn boundary. A backoff has no such boundary:
// the wait is dead time before a request that the user has either superseded or
// asked us not to make. So both signal interject (see nudgeRetryWait and
// nudgePoliteStop) and the backoff is abandoned.
//
// A pause wins here even with partial output already streamed, unlike a queued
// message: the reason a user reaches for Pause is most often the rate limiting
// that put this run in a backoff in the first place, and honouring it only on a
// clean attempt would refuse it exactly when it is meant.
func (r *run) waitForRetryDelay(d time.Duration) RetryWaitResult {
	// Chunks from the attempt that just failed can still be draining into the
	// throttle; whichever way the wait ends, the document catches up with them.
	defer r.flushPendingStreamWrites()

	r.t.retryWaiting.Store(true)
	defer r.t.retryWaiting.Store(false)

	timer := time.NewTimer(d)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return RetryWaitResult{}

		case <-r.t.wake:
			if r.loadState() == StateCancelling {
				return RetryWaitResult{Cancelled: true}
			}

		case <-r.t.interject:
			if r.politeStopCovers(r.t.thread.itemID) {
				return RetryWaitResult{Paused: true}
			}
			// Only redirect when no tokens have streamed yet (pure retry — no
			// partial response). With partial output on screen the composer is
			// still locked, so the queued message waits for the ordinary boundary.
			if r.t.streaming.textContent == "" && r.t.streaming.thinkingContent == "" {
				return RetryWaitResult{NewMessage: true}
			}

		case chunk := <-r.t.chunks:
			r.processCoalescedStreamChunks(r.t.llmTurnID, chunk)
		case <-r.done:
			return RetryWaitResult{Cancelled: true}
		}
	}
}

// missingHalves names which half of a context/tools request never answered —
// the context reply is engine-only (single responder), so a wedge is almost
// always the context side. Naming it turns an opaque failure into an
// actionable diagnosis.
func missingHalves(contextResult, toolsResult json.RawMessage) string {
	var missing []string
	if contextResult == nil {
		missing = append(missing, "context")
	}
	if toolsResult == nil {
		missing = append(missing, "tools")
	}
	return strings.Join(missing, "+")
}
