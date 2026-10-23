//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

// convertToolChoiceChat encodes decideToolChoice's verdict as the Chat
// Completions tool_choice union. ok=false means send no tool_choice.
func convertToolChoiceChat(tc *provider.ToolChoice, downgradeForcedTool bool) (openai.ChatCompletionToolChoiceOptionUnionParam, bool) {
	switch decideToolChoice(tc, downgradeForcedTool) {
	case toolChoiceNamed:
		return openai.ChatCompletionToolChoiceOptionUnionParam{
			OfFunctionToolChoice: &openai.ChatCompletionNamedToolChoiceParam{
				Function: openai.ChatCompletionNamedToolChoiceFunctionParam{Name: tc.Name},
			},
		}, true
	case toolChoiceRequired:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("required")}, true
	case toolChoiceNone:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("none")}, true
	default:
		return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
	}
}

// convertToolsToOpenAI converts provider.ToolDefinition to Chat Completions
// function tools.
func convertToolsToOpenAI(tools []provider.ToolDefinition) []openai.ChatCompletionToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]openai.ChatCompletionToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		result = append(result, openai.ChatCompletionFunctionTool(shared.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  toolParameters(tool),
		}))
	}
	return result
}

// toolCallAccumulator tracks a tool call being assembled from streaming chunks
type toolCallAccumulator struct {
	id          string
	name        string
	argsBuilder strings.Builder
}

// emitToolCall unmarshals one accumulator's streamed arguments and emits its
// tool_use stream chunk. Empty arguments are treated as an empty object so a
// no-argument tool call still emits (rather than failing JSON parsing).
func emitToolCall(acc *toolCallAccumulator, callback provider.StructuredStreamCallback) error {
	argsStr := acc.argsBuilder.String()
	if argsStr == "" {
		argsStr = "{}"
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(argsStr), &input); err != nil {
		return fmt.Errorf("LLM generated invalid JSON for tool %s (id: %s): %w\nRaw args: %s", acc.name, acc.id, err, argsStr)
	}
	if _, err := callback(provider.StreamChunk{
		Type:      provider.ContentBlockTypeToolUse,
		ToolUseID: acc.id,
		ToolName:  acc.name,
		ToolInput: input,
	}); err != nil {
		return err
	}
	return nil
}

// flushToolCalls emits a tool_use stream chunk for every accumulator, in
// ascending index order. The map is keyed on the wire-side index, which OpenAI
// itself streams as contiguous {0..N-1} but other openaibase-derived
// providers may stream sparsely.
// Iterating 0..len-1 would silently drop sparse entries.
func flushToolCalls(buffers map[int]*toolCallAccumulator, callback provider.StructuredStreamCallback) error {
	indices := make([]int, 0, len(buffers))
	for idx := range buffers {
		indices = append(indices, idx)
	}
	sort.Ints(indices)

	for _, idx := range indices {
		if err := emitToolCall(buffers[idx], callback); err != nil {
			return err
		}
	}
	return nil
}

// buildChatUserMessage builds the Chat Completions user message for one unified
// message. With no image parts it emits the plain string content form
// (byte-identical to the pre-image behaviour, empty content skipped); the
// content-array form is used only when images are present, in which case the
// text (if any) becomes a text part alongside one image_url part per image.
// ok=false means the message is empty (no text, no images) and must be skipped.
func buildChatUserMessage(msg provider.Message) (openai.ChatCompletionMessageParamUnion, bool) {
	var imageParts []openai.ChatCompletionContentPartUnionParam
	for _, part := range msg.Parts {
		if uri := imageDataURI(part); uri != "" {
			imageParts = append(imageParts, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
				URL: uri,
			}))
		}
	}

	if len(imageParts) == 0 {
		// No images: preserve exact prior behaviour — plain string content,
		// empty messages skipped.
		if isEmptyContent(msg.Content) {
			return openai.ChatCompletionMessageParamUnion{}, false
		}
		return openai.UserMessage(msg.Content), true
	}

	parts := make([]openai.ChatCompletionContentPartUnionParam, 0, len(imageParts)+1)
	if !isEmptyContent(msg.Content) {
		parts = append(parts, openai.TextContentPart(msg.Content))
	}
	parts = append(parts, imageParts...)
	return openai.UserMessage(parts), true
}

// reasoningProducerKey is the providerData key a replaying client stamps on
// the reasoning it streams, valued "<provider>/<model>". The history records
// nothing else about which model wrote a thinking block, and only a model's own
// reasoning belongs in its replayed sequence (see ReasoningReplay).
const reasoningProducerKey = "reasoningProducer"

// reasoningProducer is the stamp this client puts on, and matches against,
// its own reasoning.
func (c *Client) reasoningProducer() string {
	return c.providerName + "/" + c.model
}

// Groups consecutive assistant messages with their tool calls. replay says
// whether and how earlier reasoning goes back; producer is the
// reasoningProducerKey stamp it replays.
func transformMessages(messages []provider.Message, useDeveloperRole bool, replay ReasoningReplay, producer, systemPrompt string) []openai.ChatCompletionMessageParamUnion {
	apiMessages := make([]openai.ChatCompletionMessageParamUnion, 0, len(messages)+1)

	// Add system prompt first if provided
	if systemPrompt != "" {
		if useDeveloperRole {
			apiMessages = append(apiMessages, openai.DeveloperMessage(systemPrompt))
		} else {
			apiMessages = append(apiMessages, openai.SystemMessage(systemPrompt))
		}
	}

	// Track assistant message accumulation (text + tool calls grouped together).
	// pendingReasoning holds this model's stamped reasoning for replay.
	// Consecutive blocks are joined, go out on the next assistant message
	// only, and are then spent. A block with no assistant message after it
	// before the next user-role message (its output was compacted or dropped)
	// is discarded rather than moved onto a later call's message. When one
	// response's tool calls are split into several use/result pairs (delegated
	// calls emitted as thread items), the reasoning rides the first.
	var pendingAssistantText strings.Builder
	var pendingReasoning strings.Builder
	var pendingToolCalls []openai.ChatCompletionMessageToolCallUnionParam

	flushAssistant := func() {
		if pendingAssistantText.Len() > 0 || len(pendingToolCalls) > 0 {
			assistantMsg := openai.ChatCompletionAssistantMessageParam{}
			if len(pendingToolCalls) > 0 {
				assistantMsg.ToolCalls = pendingToolCalls
			}
			if pendingAssistantText.Len() > 0 {
				assistantMsg.Content = openai.ChatCompletionAssistantMessageParamContentUnion{
					OfString: openai.String(pendingAssistantText.String()),
				}
			}
			if replay.Field != "" {
				switch {
				case pendingReasoning.Len() > 0:
					assistantMsg.SetExtraFields(map[string]any{replay.Field: pendingReasoning.String()})
				case replay.Required:
					assistantMsg.SetExtraFields(map[string]any{replay.Field: replay.Placeholder})
				}
			}
			apiMessages = append(apiMessages, openai.ChatCompletionMessageParamUnion{
				OfAssistant: &assistantMsg,
			})
			pendingReasoning.Reset()
		}
		pendingAssistantText.Reset()
		pendingToolCalls = nil
	}

	// A tool-result that returned images can't ride on the role="tool" message
	// (those are text-only), so images are accumulated here and flushed as a
	// following role="user" message. Accumulating (rather than emitting inline)
	// keeps consecutive tool messages contiguous: [tool(A), tool(B), user(imgs)]
	// stays valid, whereas [tool(A), user(img), tool(B)] would not.
	var pendingToolImages []openai.ChatCompletionContentPartUnionParam
	flushToolImages := func() {
		if len(pendingToolImages) > 0 {
			apiMessages = append(apiMessages, openai.UserMessage(pendingToolImages))
			pendingToolImages = nil
		}
	}

	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages (error, system)
		}

		// Any non-tool-result message ends a run of tool results: flush their
		// images as a user turn before this message is emitted.
		if msg.Type != "tool-result" {
			flushToolImages()
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Flush any pending assistant content first
			flushAssistant()
			// Reasoning still pending here lost the output it belongs to.
			pendingReasoning.Reset()
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if userMsg, ok := buildChatUserMessage(msg); ok {
				apiMessages = append(apiMessages, userMsg)
			}

		case "assistant":
			pendingAssistantText.WriteString(msg.Content)

		case "thinking":
			// Thinking blocks are internal model state with no standard Chat
			// Completions channel, so they are dropped unless the model takes
			// its reasoning back (Quirks.ReasoningReplay). Only this model's
			// own reasoning belongs in its sequence: another model's (a
			// mid-conversation switch) and the worker's own notes carry no
			// matching stamp.
			if replay.Field != "" {
				if s, _ := msg.ProviderData[reasoningProducerKey].(string); s != "" && s == producer {
					pendingReasoning.WriteString(msg.Content)
				}
			}

		case "tool-use":
			// Accumulate with pending assistant message
			argsJSON, err := json.Marshal(msg.ToolInput)
			if err != nil {
				jlog.Error("Failed to marshal tool input: %v", err)
				continue
			}
			// OpenAI requires valid JSON object, not "null"
			if string(argsJSON) == "null" {
				argsJSON = []byte("{}")
			}
			pendingToolCalls = append(pendingToolCalls, openai.ChatCompletionMessageToolCallUnionParam{
				OfFunction: &openai.ChatCompletionMessageFunctionToolCallParam{
					ID: msg.ToolUseID,
					Function: openai.ChatCompletionMessageFunctionToolCallFunctionParam{
						Name:      msg.ToolName,
						Arguments: string(argsJSON),
					},
				},
			})

		case "tool-result":
			// Flush pending assistant content before tool result
			flushAssistant()
			// Reasoning still pending here lost the output it belongs to.
			pendingReasoning.Reset()
			// OpenAI expects role="tool" with tool_call_id
			// Use placeholder for empty results - LLM expects a result for every tool call,
			// and some APIs (e.g., Z.AI) reject empty content
			content := msg.Content
			if isEmptyContent(content) {
				content = emptyContentPlaceholder
			}
			apiMessages = append(apiMessages, openai.ToolMessage(content, msg.ToolUseID))
			// Queue any image output to follow this run of tool messages as a
			// user turn (role="tool" can't carry images).
			for _, part := range msg.Parts {
				if uri := imageDataURI(part); uri != "" {
					pendingToolImages = append(pendingToolImages, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
						URL: uri,
					}))
				}
			}
		}
	}

	// Flush any remaining assistant content, then any trailing tool-result images.
	flushAssistant()
	flushToolImages()

	return apiMessages
}

// streamMessageChatCompletions streams using the Chat Completions API
func (c *Client) streamMessageChatCompletions(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with model %s, %d messages", c.model, len(req.Messages))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Transform unified Message[] to OpenAI format
	apiMessages := transformMessages(c.requestMessages(req), c.quirks.UseDeveloperRole, c.quirks.ReasoningReplay, c.reasoningProducer(), req.SystemPrompt)

	// Log the SDK request payload for debugging
	jlog.Trace("[openai REQUEST] model=%s, messages=%d, tools=%d", c.model, len(apiMessages), len(req.Tools))

	// Build request params
	params := openai.ChatCompletionNewParams{
		Model:       openai.ChatModel(c.model),
		Messages:    apiMessages,
		Temperature: openai.Float(1.0),
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	}

	// Pin prompt-cache routing to this conversation/thread so the growing
	// prefix stays on one cache shard across turns instead of being
	// load-balanced onto a cold shard and re-billed (see promptCacheKey).
	if key := promptCacheKey(req); key != "" {
		params.PromptCacheKey = openai.String(key)
	}

	if c.quirks.IncludeFrequencyPenalty {
		params.FrequencyPenalty = openai.Float(0.3)
	}

	if c.quirks.IncludePresencePenalty {
		params.PresencePenalty = openai.Float(0.3)
	}

	if len(req.Tools) > 0 {
		params.Tools = convertToolsToOpenAI(req.Tools)
		if tc, ok := convertToolChoiceChat(req.ToolChoice, !c.quirks.ForcedToolChoiceSupported); ok {
			params.ToolChoice = tc
		}
	}

	// Reasoning effort. Omitted (ok=false) for non-reasoning models and absent/
	// unsupported levels, keeping the request byte-identical to today.
	if effort, ok := c.thinkingSpec.effortFor(req.ThinkingLevel); ok {
		params.ReasoningEffort = openai.ReasoningEffort(effort)
	}

	// Honour the model's real output cap when the descriptor supplied one (the
	// same value the model list advertises); fall back to a conservative
	// default only when it's unset. Not a floor — a model that legitimately
	// caps below the default (e.g. ollama's 4096) must send its own value, or
	// ModelInfo.MaxOutputTokens would be a lie relative to the wire.
	maxTokens := c.effectiveMaxOutputTokens(req)

	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout. The session
	// also carries the running output-token estimate behind the UI spinner.
	sess, streamCtx := utils.NewStreamSession(ctx, c.providerName, callback)
	defer sess.Close()
	streamCtx, sawDone := withDoneSentinel(streamCtx)

	stream := c.client.Chat.Completions.NewStreaming(streamCtx, params, option.WithJSONSet(c.quirks.MaxTokensParamName, maxTokens))

	// Track tool calls being assembled (OpenAI streams them incrementally)
	toolCallBuffers := make(map[int]*toolCallAccumulator)

	var inputTokens, outputTokens, lastEmittedInput int
	var cachedTokens *int
	var lastFinishReason string
	var textContent strings.Builder
	var thinkingContent strings.Builder

	// stampReasoning ends the reasoning block with a contentless thinking chunk
	// carrying this client's producer stamp, which the worker stores as the
	// block's providerData; ReasoningReplay replays only stamped blocks. It
	// runs before the first output that follows the reasoning, while the
	// worker still has that block open.
	stamped := false
	stampReasoning := func() error {
		if stamped || c.quirks.ReasoningReplay.Field == "" || thinkingContent.Len() == 0 {
			return nil
		}
		stamped = true
		_, err := callback(provider.StreamChunk{
			Type:     provider.ContentBlockTypeThinking,
			Metadata: map[string]any{reasoningProducerKey: c.reasoningProducer()},
		})
		return err
	}

	// Process the stream
	for stream.Next() {
		sess.Reset()
		chunk := stream.Current()

		if chunk.Usage.PromptTokens > 0 {
			inputTokens = int(chunk.Usage.PromptTokens)
		}
		if chunk.Usage.CompletionTokens > 0 {
			outputTokens = int(chunk.Usage.CompletionTokens)
		}
		// Presence check, not a value check: cached usage is recorded only when
		// the chunk actually carries prompt_tokens_details, so an explicit
		// cached_tokens:0 becomes a reported zero while an omitted details
		// block leaves CachedTokens nil (unknown).
		if chunk.Usage.JSON.PromptTokensDetails.Valid() {
			cachedTokens = provider.Reported(int(chunk.Usage.PromptTokensDetails.CachedTokens))
		}
		// Re-emit authoritative per-call prompt usage as a transient chunk so the
		// footer meter can anchor on it mid-turn (StreamsLiveUsage providers).
		// Chat Completions reports usage in the final chunk; guard on change so a
		// provider that repeats it across chunks emits only once.
		if inputTokens > 0 && inputTokens != lastEmittedInput {
			lastEmittedInput = inputTokens
			if _, err := callback(provider.StreamChunk{
				Type:     provider.ContentBlockTypeUsage,
				Metadata: map[string]any{"inputTokens": inputTokens, "cachedTokens": provider.TokenCount(cachedTokens)},
			}); err != nil {
				return nil, err
			}
		}

		for _, choice := range chunk.Choices {
			if choice.FinishReason != "" {
				lastFinishReason = choice.FinishReason
			}

			// Stream reasoning ("thinking") content immediately. Reasoning
			// models on the Chat Completions wire (GLM, DeepSeek-R1, OpenRouter,
			// …) carry chain-of-thought in a non-standard delta field
			// (`reasoning_content` or `reasoning`), which the SDK parks in
			// ExtraFields. Surfacing it both
			// shows live thinking and — crucially — feeds the output-token
			// progress estimate, so a model that reasons for minutes no longer
			// leaves the spinner frozen on "Receiving" with no movement.
			if reasoning := extraReasoningDelta(choice.Delta.JSON.ExtraFields); reasoning != "" {
				thinkingContent.WriteString(reasoning)
				sess.Progress(reasoning)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeThinking,
					Content: reasoning,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

			// Stream text content immediately
			if choice.Delta.Content != "" {
				if err := stampReasoning(); err != nil {
					return nil, err
				}
				textContent.WriteString(choice.Delta.Content)
				sess.Progress(choice.Delta.Content)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: choice.Delta.Content,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

			// Accumulate tool calls
			for _, toolCall := range choice.Delta.ToolCalls {
				idx := int(toolCall.Index)
				if _, exists := toolCallBuffers[idx]; !exists {
					toolCallBuffers[idx] = &toolCallAccumulator{argsBuilder: strings.Builder{}}
				}
				acc := toolCallBuffers[idx]
				if toolCall.ID != "" {
					acc.id = toolCall.ID
				}
				if toolCall.Function.Name != "" {
					acc.name = toolCall.Function.Name
				}
				if toolCall.Function.Arguments != "" {
					acc.argsBuilder.WriteString(toolCall.Function.Arguments)
					sess.Progress(toolCall.Function.Arguments)
				}
			}
		}
	}

	if err := stream.Err(); err != nil {
		if stall := sess.StallError(); stall != nil {
			return nil, stall
		}
		return nil, c.streamEventFailure(sess.Annotate(err))
	}
	// The body ended without either of the two things that end a complete
	// answer: a choice's finish_reason or the [DONE] sentinel. Servers are
	// allowed to omit one of them, never both, so this is a cut-off — and
	// acting on what arrived would run a half reply or a half-formed tool call.
	if lastFinishReason == "" && !sawDone.Load() {
		return nil, provider.NewFailureError(provider.FailureTruncated,
			sess.Annotate(fmt.Errorf("%s stream ended with neither a finish_reason nor [DONE]", c.providerName)).Error(), nil)
	}

	// Log the response summary
	jlog.Trace("[openai RESPONSE] text=%d chars, thinking=%d chars, tools=%d, finish=%s, input_tokens=%d, output_tokens=%d, cached=%d",
		textContent.Len(), thinkingContent.Len(), len(toolCallBuffers), lastFinishReason, inputTokens, outputTokens, provider.TokenCount(cachedTokens))

	// A response with no text still has its reasoning stamped, ahead of its
	// tool calls.
	if err := stampReasoning(); err != nil {
		return nil, err
	}

	// Stream tool_use blocks to frontend (no execution - frontend handles that)
	if err := flushToolCalls(toolCallBuffers, callback); err != nil {
		return nil, err
	}

	inputTokens, inputTokensApproximate, outputTokens := estimateMissingUsage(req, inputTokens, outputTokens, textContent.String())

	return &provider.StreamResult{
		StopReason:             mapOpenAIFinishReason(lastFinishReason),
		InputTokens:            inputTokens,
		InputTokensApproximate: inputTokensApproximate,
		OutputTokens:           outputTokens,
		CachedTokens:           cachedTokens,
	}, nil
}

func mapOpenAIFinishReason(reason string) provider.StopReason {
	switch reason {
	case "stop":
		return provider.StopReasonEndTurn
	case "tool_calls", "function_call":
		return provider.StopReasonToolUse
	case "length":
		return provider.StopReasonMaxTokens
	case "content_filter":
		// Preserve the signal rather than collapsing into a clean end_turn — a
		// filtered (often empty) completion would otherwise be indistinguishable
		// from a normal finish.
		return provider.StopReasonContentFilter
	default:
		return provider.StopReasonEndTurn
	}
}
