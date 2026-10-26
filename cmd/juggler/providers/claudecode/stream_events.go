//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"fmt"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// handleStreamEvent dispatches Anthropic API events that the CLI passes
// through verbatim when --include-partial-messages is enabled. Per-block
// accumulators carry text/JSON across deltas; tool_use chunks are emitted
// to the callback only at content_block_stop so the callback never sees a
// partial tool input.
func (c *Client) handleStreamEvent(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	if ev == nil {
		return false, 0, nil
	}
	if result.partialBlocks == nil {
		result.partialBlocks = make(map[int]*partialBlock)
	}

	switch ev.Type {
	case "message_start":
		onMessageStart(ev, result, callback)
	case "content_block_start":
		onContentBlockStart(ev, result)
	case "content_block_delta":
		return onContentBlockDelta(ev, result, callback)
	case "content_block_stop":
		return onContentBlockStop(ev, result, callback)
	case "message_delta":
		return onMessageDelta(ev, result, callback)
	case "message_stop":
		// No-op; we already finalised via message_delta.
	}
	return false, 0, nil
}

// onMessageStart opens one API call of the turn: it announces generation and
// resets the per-call usage and tool tallies.
func onMessageStart(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) {
	// The API has accepted the prompt and begun generating — the silent
	// ingestion wait (system/init → here, the long cache-miss segment on a
	// cold start) is over. Emit the mid-wait beat so the spinner flips off
	// "Waiting"/"Processing conversation history" to "Generating
	// response" the moment work starts, instead of looking stuck right up
	// until the first token. Harmless on the later message_start of a
	// multi-call turn: by then output tokens have streamed, so the frontend
	// shows the token flow alongside the latest activity description.
	emitActivity(callback, activityGenerating)

	// A juggler "turn" can contain multiple Anthropic API calls (the LLM
	// internally chains tool-use round-trips). The claudecode CLI emits
	// usage that appears to *accumulate* across those calls within one
	// turn — we observed `cache_read_input_tokens` of 223k on plain
	// Opus (200k window) and 8754k after a long loop. Resetting at
	// every message_start makes only the final API call's usage
	// survive into `turnResult`, which matches what the footer wants
	// to display (the prompt size the *next* turn will cache against).
	// Trade-off: we lose per-call totals across the chain, but better
	// no info than wildly wrong info.
	result.InputTokens = 0
	result.CacheReadTokens = 0
	result.CacheWriteTokens = 0
	// OutputTokens reset too — message_delta of the final call will
	// set the authoritative value.
	result.OutputTokens = 0
	// The tool tallies describe one API call's block batch, and this is
	// the start of a new one.
	result.dispatchableThisCall = 0
	result.cliServedThisCall = 0
	result.bareNameThisCall = 0
	if ev.Message != nil && ev.Message.Usage != nil {
		result.InputTokens = ev.Message.Usage.InputTokens
		result.OutputTokens = ev.Message.Usage.OutputTokens
		result.CacheReadTokens = ev.Message.Usage.CacheReadInputTokens
		result.CacheWriteTokens = ev.Message.Usage.CacheCreationInputTokens
		result.usageFromStream = true
		jlog.Debug("claudecode usage[message_start]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d",
			ev.Message.Usage.InputTokens, ev.Message.Usage.CacheReadInputTokens,
			ev.Message.Usage.CacheCreationInputTokens, ev.Message.Usage.OutputTokens,
			ev.Message.Usage.InputTokens+ev.Message.Usage.CacheReadInputTokens+ev.Message.Usage.CacheCreationInputTokens)
		// We deliberately do NOT emit a transient `usage` chunk here.
		// The CLI reports message_start usage cumulatively across all
		// API calls in one juggler turn — emitting it mid-stream
		// would flash a wrong number in the footer (10× too high on
		// long tool-use loops). The footer keeps showing the previous
		// turn's correct anchor until end-of-turn writes the new one.
	}
}

// onContentBlockStart opens an accumulator for the block at ev.Index.
func onContentBlockStart(ev *StreamEventDetail, result *turnResult) {
	if ev.ContentBlock == nil {
		return
	}
	pb := &partialBlock{kind: ev.ContentBlock.Type}
	if pb.kind == "tool_use" {
		pb.toolID = ev.ContentBlock.ID
		pb.toolName = ev.ContentBlock.Name
	}
	result.partialBlocks[ev.Index] = pb
}

// onContentBlockDelta appends one delta to its block's accumulator, streaming
// text and thinking to the callback as they arrive.
func onContentBlockDelta(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	pb := result.partialBlocks[ev.Index]
	if pb == nil || ev.Delta == nil {
		return false, 0, nil
	}
	switch ev.Delta.Type {
	case "text_delta":
		pb.text += ev.Delta.Text
		if ev.Delta.Text != "" {
			result.progress.Add(ev.Delta.Text)
			if _, err := callback(provider.StreamChunk{
				Type:    provider.ContentBlockTypeText,
				Content: ev.Delta.Text,
			}); err != nil {
				return false, 0, err
			}
		}
	case "thinking_delta":
		pb.text += ev.Delta.Thinking
		if ev.Delta.Thinking != "" {
			result.progress.Add(ev.Delta.Thinking)
			if _, err := callback(provider.StreamChunk{
				Type:    provider.ContentBlockTypeThinking,
				Content: ev.Delta.Thinking,
			}); err != nil {
				return false, 0, err
			}
		}
	case "signature_delta":
		pb.signature += ev.Delta.Signature
	case "input_json_delta":
		pb.toolJSON.WriteString(ev.Delta.PartialJSON)
		result.progress.Add(ev.Delta.PartialJSON)
	}
	return false, 0, nil
}

// onContentBlockStop finalises the block at ev.Index into result.Blocks.
func onContentBlockStop(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	pb := result.partialBlocks[ev.Index]
	if pb == nil {
		return false, 0, nil
	}
	delete(result.partialBlocks, ev.Index)

	switch pb.kind {
	case "text":
		result.Blocks = append(result.Blocks, provider.ContentBlock{
			Type:    provider.ContentBlockTypeText,
			Content: pb.text,
		})
	case "thinking":
		if err := finishThinkingBlock(pb, result, callback); err != nil {
			return false, 0, err
		}
	case "tool_use":
		return finishToolUseBlock(pb, result, callback)
	}
	return false, 0, nil
}

// finishThinkingBlock appends a completed thinking block, sending its signature
// on ahead to the callback.
func finishThinkingBlock(pb *partialBlock, result *turnResult, callback provider.StructuredStreamCallback) error {
	block := provider.ContentBlock{
		Type:    provider.ContentBlockTypeThinking,
		Content: pb.text,
	}
	if pb.signature != "" {
		block.Metadata = map[string]any{"signature": pb.signature}
		// The signature is complete only at the end of the block, so it
		// rides a contentless chunk the worker attaches to the thinking
		// already on screen. Without it the block reaches the next turn
		// unsigned and is dropped rather than replayed.
		if _, err := callback(provider.StreamChunk{
			Type:     provider.ContentBlockTypeThinking,
			Metadata: block.Metadata,
		}); err != nil {
			return err
		}
	}
	result.Blocks = append(result.Blocks, block)
	return nil
}

// finishToolUseBlock parses a tool_use block's accumulated input (it arrives as
// JSON fragments via input_json_delta) and emits it as one complete tool_use
// chunk — or skips it, when the block is not juggler's to dispatch.
//
// A tool_use whose name arrived WITHOUT the mcp__juggler__ prefix is
// never juggler's to dispatch, whatever the name says.
// canonicalToolName strips a prefix that was never there, so a bare
// name juggler also serves (Monitor is both a CLI built-in and a
// juggler tool) would dispatch as juggler's own; the CLI meanwhile
// resolves the call on its side and never sends a tools/call, so the
// result finds no parked call and stashes forever while the CLI blocks
// on its next genuinely-MCP call — both sides wait until teardown.
//
// Skipping the block is what avoids that, and it is enough on its own:
// nothing is dispatched, so nothing can go unclaimed. Failing the turn
// as well would cost more than it saves — a turn error tears the
// process down (finalizeTurn), which kills the CLI's own recovery and
// hands the user an error where there was a working session.
//
// The name still says which of two things happened, so the log line
// does too. A CLI built-in means --disallowedTools has gone stale and
// the CLI may have acted where juggler cannot see it: an ERROR worth
// chasing, and never grounds for re-sending the request, which could
// run it twice. Anything else is the model using a name it was never
// offered — imitating the bare names in its own transcript
// (prefixJugglerToolUses covers why they are there) or in the prompt's
// prose. The CLI rejects it with "No such tool available" and the
// model usually re-issues it correctly on the same open process, so
// the turn heals itself; when it doesn't, maxBareToolNameRounds ends it.
//
// A name carrying the prefix TWICE (mcp__juggler__mcp__juggler__todo) is the
// same case from the other side: tools/list advertises unprefixed names and
// the CLI prefixes each once, so no such tool exists, the CLI rejects it, and
// no tools/call follows. It is skipped and counted exactly like a bare name.
func finishToolUseBlock(pb *partialBlock, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	if !isServableToolName(pb.toolName) {
		if isCLINativeToolName(pb.toolName) {
			jlog.Error("claudecode: CLI native tool %q leaked past --disallowedTools — skipping the block rather than dispatching it as juggler's own (which deadlocks the conversation). The CLI may have served it itself, unseen by juggler. Add it to disallowedNativeTools.", pb.toolName)
		} else {
			jlog.Info("claudecode: model called %q, which is not %s followed by a tool name — skipping the block; the CLI rejects the name itself and drives the model's retry", pb.toolName, mcpToolPrefix)
			result.bareNameThisCall++
			result.bareNames = append(result.bareNames, pb.toolName)
		}
		result.cliServedThisCall++
		_, _ = callback(provider.StreamChunk{
			Type:    provider.ContentBlockTypeStatus,
			Content: fmt.Sprintf("Tool name %s isn't callable — retrying", pb.toolName),
		})
		return false, 0, nil
	}
	toolName := canonicalToolName(pb.toolName)
	input := map[string]any{}
	if raw := pb.toolJSON.String(); raw != "" {
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			// A non-empty payload that won't parse is a block the model
			// mis-sampled: observed as a doubled comma (`"offset": 340, ,
			// "limit": 70`) and as JSON that simply stops mid-object. The CLI
			// validates tool input too, and answers such a block ITSELF —
			// recording it as `__unparsedToolInput`, synthesising an
			// InputValidationError tool_result, and feeding that back so the
			// model retries the call through the same open process. So:
			//
			// DO NOT dispatch it. Falling through to empty args makes the
			// worker execute a phantom call (e.g. read with no file_path) and
			// feed its error into the control-protocol (name+args) FIFO, where
			// it matches no CLI park — permanently shifting every later result
			// by one and cross-delivering wrong file contents (the "tool/request
			// divergence" cascade).
			//
			// DO NOT fail the turn either. The CLI is mid-recovery; a turn
			// error tears the process down (finalizeTurn) and kills the retry
			// it was about to make. Skip the block, tally it as CLI-served so
			// onStopReason knows this batch parks nothing on our side,
			// and keep reading.
			jlog.Error("claudecode: malformed tool input JSON for %s — skipping the block; the CLI answers it with an InputValidationError and drives the model's retry: %v (raw=%s)", toolName, err, raw)
			result.cliServedThisCall++
			_, _ = callback(provider.StreamChunk{
				Type:    provider.ContentBlockTypeStatus,
				Content: fmt.Sprintf("Invalid tool input for %s — retrying", toolName),
			})
			return false, 0, nil
		}
	}
	chunk := provider.StreamChunk{
		Type:      provider.ContentBlockTypeToolUse,
		ToolUseID: pb.toolID,
		ToolName:  toolName,
		ToolInput: input,
	}
	if _, err := callback(chunk); err != nil {
		return false, 0, err
	}
	result.Blocks = append(result.Blocks, provider.ContentBlock(chunk))
	result.dispatchableThisCall++
	return false, 0, nil
}

// isServableToolName reports whether a tool_use name is one the CLI will send
// back to juggler as a tools/call: the mcp__juggler__ prefix exactly once,
// followed by a name that does not itself start with it.
func isServableToolName(name string) bool {
	rest, ok := strings.CutPrefix(name, mcpToolPrefix)
	return ok && !strings.HasPrefix(rest, mcpToolPrefix)
}

// onMessageDelta closes one API call: its usage, then its stop reason.
func onMessageDelta(ev *StreamEventDetail, result *turnResult, callback provider.StructuredStreamCallback) (bool, int, error) {
	// Usage first, stop reason second. Anthropic puts both on this one event,
	// and onStopReason's tool_use arm leaves the read loop the moment it sees the
	// stop reason — so a usage read placed after it is never reached on a
	// pausing call, and every count that call was billed for is lost. An
	// agentic turn pauses at every tool batch and reaches end_turn once, so
	// that is nearly all of them.
	if ev.Usage != nil {
		if err := recordMessageDeltaUsage(ev.Usage, result, callback); err != nil {
			return false, 0, err
		}
	}
	if ev.Delta != nil && ev.Delta.StopReason != "" {
		return onStopReason(ev.Delta.StopReason, result)
	}
	return false, 0, nil
}

// recordMessageDeltaUsage stores one API call's usage on result and streams it
// to the footer.
func recordMessageDeltaUsage(usage *UsageInfo, result *turnResult, callback provider.StructuredStreamCallback) error {
	result.InputTokens = usage.InputTokens
	result.OutputTokens = usage.OutputTokens
	result.CacheReadTokens = usage.CacheReadInputTokens
	result.CacheWriteTokens = usage.CacheCreationInputTokens
	result.usageFromStream = true
	jlog.Debug("claudecode usage[message_delta]: input=%d cacheRead=%d cacheWrite=%d output=%d total=%d",
		usage.InputTokens, usage.CacheReadInputTokens,
		usage.CacheCreationInputTokens, usage.OutputTokens,
		usage.InputTokens+usage.CacheReadInputTokens+usage.CacheCreationInputTokens)
	// Emit a transient `usage` chunk so the UI footer can flip to
	// a real input-token anchor as soon as this API call finishes
	// (rather than waiting for the worker's end-of-turn write).
	// We use message_delta — NOT message_start — because the CLI
	// reports message_start.usage cumulatively across API calls
	// in the session (we observed 10×–40× wrong values there).
	// message_delta.usage is per-call and authoritative; it's
	// what produces the correct end-of-turn anchor.
	uncachedInput := usage.InputTokens
	cacheRead := usage.CacheReadInputTokens
	cacheWrite := usage.CacheCreationInputTokens
	if total := uncachedInput + cacheRead + cacheWrite; total > 0 {
		if _, err := callback(provider.StreamChunk{
			Type: provider.ContentBlockTypeUsage,
			Metadata: map[string]any{
				"inputTokens":  total,
				"cachedTokens": cacheRead,
			},
		}); err != nil {
			return err
		}
	}
	return nil
}

// onStopReason applies an API call's stop reason. true means pause the turn for
// the returned number of tool_use blocks.
func onStopReason(stopReason string, result *turnResult) (bool, int, error) {
	// Map Anthropic stop_reason to our stop reasons. tool_use causes a
	// pause; end_turn lets readUntilPauseOrComplete exit cleanly.
	switch stopReason {
	case "tool_use":
		// A batch that parked nothing on our side must not pause the turn.
		// Two shapes reach here, and the CLI recovers from both by itself
		// on the same open process:
		//
		//   - every block had unparseable input, so the CLI answered each
		//     one with an InputValidationError (cliServedThisCall > 0);
		//   - the response carried no usable tool_use block at all — the
		//     model stopped mid-block, or emitted none — so the CLI
		//     discards the message and feeds itself "The previous response
		//     failed to produce a valid tool call. Please retry the tool
		//     call now."
		//
		// Pausing on either hands the worker a round with no tools to
		// execute while the CLI streams its recovery call into s.content
		// with nobody reading it — content the next Submit would then
		// dequeue as if it were that message's reply. And a round that
		// streamed text before failing reads to the worker as a finished
		// turn (text counts as an action, no tool_use means nothing left to
		// do), so the conversation ends with no tool run, no error, and no
		// explanation. Stay in the read loop: the recovery round belongs to
		// this turn, and the turn ends at its real stop reason. A CLI that
		// recovers with nothing instead trips the idle watchdog, which ends
		// the turn with a visible stall.
		if result.dispatchableThisCall == 0 {
			if result.bareNameThisCall > 0 {
				result.bareNameRounds++
				if result.bareNameRounds >= maxBareToolNameRounds {
					jlog.Info("claudecode: %d consecutive rounds of bare tool names (%s) — abandoning the turn for the worker to re-send",
						result.bareNameRounds, strings.Join(result.bareNames, ", "))
					return false, 0, unusableBareNameOutput(result)
				}
			}
			if result.cliServedThisCall > 0 {
				jlog.Info("claudecode: tool_use pause with no dispatchable blocks (%d answered by the CLI itself) — reading on for its recovery round", result.cliServedThisCall)
			} else {
				jlog.Info("claudecode: tool_use stop carrying no tool call at all — the CLI discards the message and re-prompts itself; reading on for its recovery round")
			}
			return false, 0, nil
		}
		result.StopReason = provider.StopReasonToolUse
		// Count emitted tool_use blocks for the caller's tally.
		count := 0
		for _, b := range result.Blocks {
			if b.Type == provider.ContentBlockTypeToolUse {
				count++
			}
		}
		return true, count, nil
	case "end_turn", "stop_sequence", "max_tokens":
		// Giving up after a rejected bare name: the model is answering
		// without ever having reached a tool (see maxBareToolNameRounds).
		if result.bareNameRounds > 0 {
			jlog.Info("claudecode: turn ended after a round of bare tool names (%s) and no tool call — abandoning it for the worker to re-send",
				strings.Join(result.bareNames, ", "))
			return false, 0, unusableBareNameOutput(result)
		}
		result.StopReason = provider.StopReasonEndTurn
	default:
		result.StopReason = provider.StopReason(stopReason)
	}
	return false, 0, nil
}
