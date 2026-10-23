//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
	"github.com/openai/openai-go/v3/shared"
)

// convertToolsToResponsesAPI converts provider.ToolDefinition to Responses API tool format
func convertToolsToResponsesAPI(tools []provider.ToolDefinition) []responses.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]responses.ToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		result = append(result, responses.ToolUnionParam{
			OfFunction: &responses.FunctionToolParam{
				Name:        tool.Name,
				Description: openai.String(tool.Description),
				Parameters:  toolParameters(tool),
			},
		})
	}
	return result
}

// transformMessagesToResponsesInput converts unified Message[] to Responses API input format
func transformMessagesToResponsesInput(messages []provider.Message) responses.ResponseNewParamsInputUnion {
	var inputItems responses.ResponseInputParam

	// Images returned by a tool ride in a following user message: a
	// function_call_output item is text-only. Accumulate and flush after each run
	// of tool results so consecutive outputs stay contiguous (see the Chat
	// Completions transform for the same ordering constraint).
	var pendingToolImages responses.ResponseInputMessageContentListParam
	flushToolImages := func() {
		if len(pendingToolImages) > 0 {
			inputItems = append(inputItems, responses.ResponseInputItemParamOfMessage(pendingToolImages, "user"))
			pendingToolImages = nil
		}
	}

	// System prompt is set separately on params; here we build input items
	// from the messages.
	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" && msg.Type != "provider-state" {
			continue // Skip UI-only and foreign provider-state messages
		}

		if msg.Type != "tool-result" {
			flushToolImages()
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if contentList := buildResponsesUserContent(msg); len(contentList) > 0 {
				inputItems = append(inputItems, responses.ResponseInputItemParamOfMessage(contentList, "user"))
			}

		case "provider-state", "thinking":
			// New conversations carry Responses continuation state in a hidden,
			// ordered provider-state message. Thinking remains accepted for legacy
			// conversations that stored the same fields on the visible summary.
			if msg.ProviderData == nil {
				continue
			}
			itemID, _ := msg.ProviderData["reasoningItemId"].(string)
			encrypted, _ := msg.ProviderData["encryptedContent"].(string)
			if itemID == "" || encrypted == "" {
				continue
			}
			item := &responses.ResponseReasoningItemParam{
				ID:               itemID,
				EncryptedContent: openai.String(encrypted),
				Summary:          []responses.ResponseReasoningItemSummaryParam{},
			}
			if summaries, ok := msg.ProviderData["summary"].([]any); ok {
				for _, raw := range summaries {
					if summary, ok := raw.(map[string]any); ok {
						if text, _ := summary["text"].(string); text != "" {
							item.Summary = append(item.Summary, responses.ResponseReasoningItemSummaryParam{Text: text})
						}
					}
				}
			}
			if len(item.Summary) == 0 && msg.Content != "" {
				item.Summary = append(item.Summary, responses.ResponseReasoningItemSummaryParam{Text: msg.Content})
			}
			inputItems = append(inputItems, responses.ResponseInputItemUnionParam{OfReasoning: item})

		case "assistant":
			// Assistant messages use output_text type, not input_text
			inputItems = append(inputItems, responses.ResponseInputItemParamOfOutputMessage(
				[]responses.ResponseOutputMessageContentUnionParam{
					{
						OfOutputText: &responses.ResponseOutputTextParam{
							Text: msg.Content,
						},
					},
				},
				"", // ID is optional for conversation history
				responses.ResponseOutputMessageStatusCompleted,
			))

		case "tool-use":
			argsJSON, err := json.Marshal(msg.ToolInput)
			if err != nil {
				jlog.Error("Failed to marshal tool input: %v", err)
				continue
			}
			// OpenAI requires valid JSON object, not "null"
			if string(argsJSON) == "null" {
				argsJSON = []byte("{}")
			}
			// Parameter order: (arguments, callID, name)
			inputItems = append(inputItems, responses.ResponseInputItemParamOfFunctionCall(
				string(argsJSON),
				msg.ToolUseID,
				msg.ToolName,
			))

		case "tool-result":
			// Use placeholder for empty results - LLM expects a result for every tool call,
			// and some APIs (e.g., Z.AI) reject empty content
			content := msg.Content
			if isEmptyContent(content) {
				content = emptyContentPlaceholder
			}
			// Built field by field rather than via
			// ResponseInputItemParamOfFunctionCallOutput, which sets only the
			// output: a function call output without its CallID cannot be
			// matched to the call it answers.
			inputItems = append(inputItems, responses.ResponseInputItemUnionParam{
				OfFunctionCallOutput: &responses.ResponseInputItemFunctionCallOutputParam{
					CallID: openai.String(msg.ToolUseID),
					Output: responses.ResponseInputItemFunctionCallOutputOutputUnionParam{
						OfString: openai.String(content),
					},
				},
			})
			// Queue image output to follow this run of tool results as a user turn.
			for _, part := range msg.Parts {
				if uri := imageDataURI(part); uri != "" {
					pendingToolImages = append(pendingToolImages, responses.ResponseInputContentUnionParam{
						OfInputImage: &responses.ResponseInputImageParam{
							ImageURL: openai.String(uri),
							Detail:   responses.ResponseInputImageDetailAuto,
						},
					})
				}
			}
		}
	}

	flushToolImages()

	return responses.ResponseNewParamsInputUnion{
		OfInputItemList: inputItems,
	}
}

// defaultResponsesInstructions is injected when ForceResponsesAPI is set and
// the system prompt is blank: those Responses-only catalogs require non-empty
// instructions on the request.
const defaultResponsesInstructions = "You are a helpful assistant."

// streamMessageResponses uses the Responses API for models that need it.
func (c *Client) streamMessageResponses(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with Responses API, model %s, %d messages", c.model, len(req.Messages))

	instructions := req.SystemPrompt
	if c.quirks.ForceResponsesAPI && strings.TrimSpace(instructions) == "" {
		instructions = defaultResponsesInstructions
	}

	// Build request params - Model is a string type
	params := responses.ResponseNewParams{
		Model: c.model,
		Input: transformMessagesToResponsesInput(c.requestMessages(req)),
	}
	// The ChatGPT Codex backend rejects max_output_tokens (see the quirk);
	// every other Responses endpoint honours it as the per-request output cap.
	if !c.quirks.OmitResponsesMaxOutputTokens {
		params.MaxOutputTokens = openai.Int(int64(c.effectiveMaxOutputTokens(req)))
	}
	if !c.quirks.ForceResponsesAPI {
		params.Temperature = openai.Float(1.0)
	}

	// Pin prompt-cache routing to this conversation/thread so the growing
	// prefix stays on one cache shard across turns instead of being
	// load-balanced onto a cold shard and re-billed (see promptCacheKey).
	if key := promptCacheKey(req); key != "" {
		params.PromptCacheKey = openai.String(key)
	}

	// Add system prompt as instructions
	if instructions != "" {
		params.Instructions = openai.String(instructions)
	}

	// Add tools if provided
	if len(req.Tools) > 0 {
		params.Tools = convertToolsToResponsesAPI(req.Tools)
		if tc, ok := convertToolChoiceResponses(req.ToolChoice, !c.quirks.ForcedToolChoiceSupported); ok {
			params.ToolChoice = tc
		}
	}

	// Reasoning. The advertised level list is the gate for both fields: a model
	// with no levels is not a reasoning model, and sending it a `reasoning`
	// object risks a hard 400.
	//
	// The summary is what makes reasoning visible. The Responses API streams
	// reasoning_summary_text events ONLY when a summary is asked for — with
	// effort alone the model still reasons, but emits nothing to show for it,
	// so the thinking handlers below never fire and the turn renders as a long
	// silence followed by an answer. Requested for every reasoning model, not
	// just one the user picked a level for, because the default turn (empty
	// ThinkingLevel, so no effort) is the common case.
	if len(c.thinkingSpec.Levels) > 0 {
		params.Reasoning.Summary = shared.ReasoningSummaryAuto
		// Effort is still omitted (ok=false) for an absent or unadvertised
		// level, leaving the model on its own default.
		if effort, ok := c.thinkingSpec.effortFor(req.ThinkingLevel); ok {
			params.Reasoning.Effort = openai.ReasoningEffort(effort)
		}
		// Ask for the reasoning in a form that can be handed back. These calls
		// are stateless (store=false), so the model cannot look up its own
		// earlier reasoning by id — the encrypted blob travelling back in the
		// next request's input is the only thing that carries a chain of
		// thought across a tool call.
		params.Include = append(params.Include, responses.ResponseIncludableReasoningEncryptedContent)
	}

	// Serving class. Omitted (ok=false) unless the human picked a tier this
	// model advertises, so the standard-speed request stays byte-identical. The
	// backend may serve a different tier than the one asked for without saying
	// so — sentTier is what response.completed compares against.
	sentTier, _ := c.serviceTierSpec.tierFor(req.ServiceTier)
	if sentTier != "" {
		params.ServiceTier = responses.ResponseNewParamsServiceTier(sentTier)
	}

	// Create streaming request
	opts := []option.RequestOption{}
	if c.quirks.ForceResponsesAPI {
		opts = append(opts,
			option.WithJSONSet("store", false),
			option.WithJSONSet("stream", true),
		)
	}
	// Cache-affinity routing: the backend pins consecutive requests for the
	// same session_id to the replica holding their prompt cache. See the
	// quirk's doc comment for the measured effect.
	if c.quirks.SessionAffinityHeader {
		if sid := sessionAffinityID(req.ConversationID); sid != "" {
			opts = append(opts, option.WithHeader("session_id", sid))
		}
	}
	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout. The session
	// also carries the running output-token estimate behind the UI spinner.
	sess, streamCtx := utils.NewStreamSession(ctx, c.providerName, callback)
	defer sess.Close()
	streamCtx, sawDone := withDoneSentinel(streamCtx)

	stream := c.client.Responses.NewStreaming(streamCtx, params, opts...)

	var inputTokens, outputTokens int
	var cachedTokens *int
	var textContent strings.Builder
	var thinkingContent strings.Builder
	type summaryKey struct {
		itemID       string
		summaryIndex int64
	}
	summaries := make(map[summaryKey]*strings.Builder)

	// emitThinking is reserved for raw Responses reasoning text. Summaries use
	// Activity snapshots below; Chat Completions reasoning remains Thinking.
	emitThinking := func(text string) error {
		if text == "" {
			return nil
		}
		thinkingContent.WriteString(text)
		sess.Progress(text)
		_, err := callback(provider.StreamChunk{
			Type:    provider.ContentBlockTypeThinking,
			Content: text,
		})
		return err
	}

	// Track function calls being assembled (keyed by item ID)
	functionCalls := make(map[string]*toolCallAccumulator)

	// Stop reason reported by a response.incomplete event, applied to a
	// text-only turn below. Empty until such an event arrives.
	var incompleteStop provider.StopReason
	// A response ends with response.completed or response.incomplete (its
	// failures return from the loop), and a gateway emulating the API may end
	// it with the [DONE] sentinel instead. A body that ends before any of them
	// was cut off.
	sawTerminal := false

	// Process the stream - events are ResponseStreamEventUnion
	for stream.Next() {
		sess.Reset()
		evt := stream.Current()

		// Handle different event types using string comparison and As* methods
		switch evt.Type {
		case "response.output_item.added":
			// New output item added - check if it's a function call
			item := evt.AsResponseOutputItemAdded()
			if item.Item.Type == "function_call" {
				fc := item.Item.AsFunctionCall()
				functionCalls[item.Item.ID] = &toolCallAccumulator{
					id:   fc.CallID,
					name: fc.Name,
				}
			}

		case "response.output_text.delta":
			// Text content delta
			delta := evt.AsResponseOutputTextDelta()
			if delta.Delta != "" {
				textContent.WriteString(delta.Delta)
				sess.Progress(delta.Delta)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: delta.Delta,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

		case "response.function_call_arguments.delta":
			// Function call arguments delta
			delta := evt.AsResponseFunctionCallArgumentsDelta()
			if fc, exists := functionCalls[delta.ItemID]; exists {
				fc.argsBuilder.WriteString(delta.Delta)
				sess.Progress(delta.Delta)
			}

		case "response.output_item.done":
			// A finished reasoning item is durable hidden continuation state. Keep
			// it ordered at the point the backend emitted it rather than attaching
			// it to a visible/transient summary.
			done := evt.AsResponseOutputItemDone()
			if done.Item.Type == "reasoning" {
				reasoning := done.Item.AsReasoning()
				if reasoning.EncryptedContent != "" && reasoning.ID != "" {
					summary := make([]any, 0, len(reasoning.Summary))
					for _, part := range reasoning.Summary {
						summary = append(summary, map[string]any{"type": "summary_text", "text": part.Text})
					}
					if _, err := callback(provider.StreamChunk{
						Type: provider.ContentBlockTypeProviderState,
						Metadata: map[string]any{
							"provider":         "openai-responses",
							"itemType":         "reasoning",
							"reasoningItemId":  reasoning.ID,
							"encryptedContent": reasoning.EncryptedContent,
							"summary":          summary,
						},
					}); err != nil {
						return nil, err
					}
				}
			}

		case "response.reasoning_summary_text.delta":
			// Summary deltas are indexed independently. Accumulate each slot and
			// emit its complete current value as a replaceable Activity snapshot.
			delta := evt.AsResponseReasoningSummaryTextDelta()
			key := summaryKey{itemID: delta.ItemID, summaryIndex: delta.SummaryIndex}
			acc := summaries[key]
			if acc == nil {
				acc = &strings.Builder{}
				summaries[key] = acc
			}
			acc.WriteString(delta.Delta)
			sess.Progress(delta.Delta)
			if _, err := callback(provider.StreamChunk{
				Type:    provider.ContentBlockTypeActivity,
				Content: acc.String(),
				Metadata: map[string]any{
					"provider":     "openai-responses",
					"kind":         "reasoning-summary",
					"itemId":       delta.ItemID,
					"outputIndex":  delta.OutputIndex,
					"summaryIndex": delta.SummaryIndex,
				},
			}); err != nil {
				return nil, err
			}

		case "response.reasoning_text.delta":
			// Raw reasoning delta (emitted by some Responses-API models in
			// place of, or alongside, the summary stream).
			if err := emitThinking(evt.AsResponseReasoningTextDelta().Delta); err != nil {
				return nil, err
			}

		case "response.completed":
			sawTerminal = true
			// Extract token usage from completed response. InputTokens here is
			// already the TOTAL prompt (incl. cache), per the Responses API
			// schema, so it matches the provider boundary contract directly.
			// CachedTokens is read separately as a subset.
			completed := evt.AsResponseCompleted()
			if completed.Response.Usage.InputTokens > 0 {
				inputTokens = int(completed.Response.Usage.InputTokens)
			}
			if completed.Response.Usage.OutputTokens > 0 {
				outputTokens = int(completed.Response.Usage.OutputTokens)
			}
			// Presence check, not a value check: cached usage is recorded only
			// when the backend actually sent input_tokens_details, so an
			// explicit cached_tokens:0 becomes a reported zero while an omitted
			// details block leaves CachedTokens nil (unknown).
			if completed.Response.Usage.JSON.InputTokensDetails.Valid() {
				cachedTokens = provider.Reported(int(completed.Response.Usage.InputTokensDetails.CachedTokens))
			}
			// Re-emit authoritative per-call prompt usage as a transient chunk so
			// the footer meter can anchor on it mid-turn (StreamsLiveUsage
			// providers). response.completed fires once per call.
			if inputTokens > 0 {
				if _, err := callback(provider.StreamChunk{
					Type:     provider.ContentBlockTypeUsage,
					Metadata: map[string]any{"inputTokens": inputTokens, "cachedTokens": provider.TokenCount(cachedTokens)},
				}); err != nil {
					return nil, err
				}
			}
			// The serving class the backend actually used. A tier is a request,
			// not a guarantee: the response comes back 200 with a different tier
			// and no explanation, so this echo is the only evidence the choice
			// was declined.
			if chunk, ok := c.serviceTierDowngrade(sentTier, string(completed.Response.ServiceTier)); ok {
				if _, err := callback(chunk); err != nil {
					return nil, err
				}
			}

		case "error":
			// A failure reported in-band on an otherwise-healthy 200 stream (an
			// auth rejection mid-stream, a backend fault) rather than as an HTTP
			// status. stream.Err() stays nil afterwards, so unless this becomes
			// the turn's error the turn returns zero blocks and a clean
			// end_turn — a conversation that stops with nothing to show for it.
			e := evt.AsError()
			return nil, c.inBandFailure(e.Code, fmt.Sprintf("openai-responses stream error: %s", responsesErrorText(e.Code, e.Message, e.Param)))

		case "response.failed":
			// Terminal failure of the response itself; same silent-stop
			// reasoning as the error event above.
			failed := evt.AsResponseFailed().Response.Error
			return nil, c.inBandFailure(string(failed.Code), fmt.Sprintf("openai-responses response failed: %s", responsesErrorText(string(failed.Code), failed.Message, "")))

		case "response.incomplete":
			sawTerminal = true
			// The response stopped short (token cap, content filter). What
			// streamed so far stands, so this is a stop reason rather than an
			// error — but it must not be reported as a clean finish.
			incompleteStop = mapResponsesIncompleteReason(evt.AsResponseIncomplete().Response.IncompleteDetails.Reason)

		default:
			// Every other event is progress detail this loop has no use for
			// (response.created, *.done, content-part boundaries). Traced, never
			// dropped in silence, so a newly-meaningful event type is findable.
			jlog.Trace("[openai-responses] unhandled event %s", evt.Type)
		}
	}

	if err := stream.Err(); err != nil {
		if stall := sess.StallError(); stall != nil {
			return nil, stall
		}
		return nil, c.streamEventFailure(sess.Annotate(err))
	}
	if !sawTerminal && !sawDone.Load() {
		return nil, provider.NewFailureError(provider.FailureTruncated,
			sess.Annotate(fmt.Errorf("%s stream ended before response.completed", c.providerName)).Error(), nil)
	}

	// Log the response summary
	jlog.Trace("[openai-responses RESPONSE] text=%d chars, thinking=%d chars, tools=%d, input_tokens=%d, output_tokens=%d",
		textContent.Len(), thinkingContent.Len(), len(functionCalls), inputTokens, outputTokens)

	// Stream tool_use blocks to frontend
	for _, fc := range functionCalls {
		if err := emitToolCall(fc, callback); err != nil {
			return nil, err
		}
	}

	// A truncated turn that still asked for tools stays "tool_use": the calls
	// were emitted above and the loop has to resolve them.
	stopReason := provider.StopReasonEndTurn
	switch {
	case len(functionCalls) > 0:
		stopReason = provider.StopReasonToolUse
	case incompleteStop != "":
		stopReason = incompleteStop
	}

	inputTokens, inputTokensApproximate, outputTokens := estimateMissingUsage(req, inputTokens, outputTokens, textContent.String())

	return &provider.StreamResult{
		StopReason:             stopReason,
		InputTokens:            inputTokens,
		InputTokensApproximate: inputTokensApproximate,
		OutputTokens:           outputTokens,
		CachedTokens:           cachedTokens,
		// CacheWriteTokens stays nil: the Responses API has no cache-write
		// usage field, so a write count is unknowable here — never claim 0.
	}, nil
}

// convertToolChoiceResponses encodes decideToolChoice's verdict as the
// Responses API tool_choice union. ok=false means send no tool_choice.
func convertToolChoiceResponses(tc *provider.ToolChoice, downgradeForcedTool bool) (responses.ResponseNewParamsToolChoiceUnion, bool) {
	switch decideToolChoice(tc, downgradeForcedTool) {
	case toolChoiceNamed:
		return responses.ResponseNewParamsToolChoiceUnion{
			OfFunctionTool: &responses.ToolChoiceFunctionParam{Name: tc.Name},
		}, true
	case toolChoiceRequired:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsRequired)}, true
	case toolChoiceNone:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsNone)}, true
	default:
		return responses.ResponseNewParamsToolChoiceUnion{}, false
	}
}

// buildResponsesUserContent builds the Responses API content list for one
// unified user message: the text (if non-empty) as an input_text item plus one
// input_image item per image part. An empty list (no text, no images) signals
// the caller to skip the message, preserving the pre-image empty-skip behaviour.
func buildResponsesUserContent(msg provider.Message) responses.ResponseInputMessageContentListParam {
	var list responses.ResponseInputMessageContentListParam
	if !isEmptyContent(msg.Content) {
		list = append(list, responses.ResponseInputContentUnionParam{
			OfInputText: &responses.ResponseInputTextParam{
				Text: msg.Content,
				Type: "input_text",
			},
		})
	}
	for _, part := range msg.Parts {
		if uri := imageDataURI(part); uri != "" {
			list = append(list, responses.ResponseInputContentUnionParam{
				OfInputImage: &responses.ResponseInputImageParam{
					ImageURL: openai.String(uri),
					Detail:   responses.ResponseInputImageDetailAuto,
				},
			})
		}
	}
	return list
}

// responsesErrorText renders a Responses-API error onto one line. The backend
// populates the triple inconsistently (a code with no message is common), so
// every present field is kept, and an empty one still names itself rather than
// surfacing as a blank error.
func responsesErrorText(code, message, param string) string {
	text := message
	if text == "" {
		text = "no detail reported"
	}
	var extra []string
	if code != "" {
		extra = append(extra, "code "+code)
	}
	if param != "" {
		extra = append(extra, "param "+param)
	}
	if len(extra) > 0 {
		text += " (" + strings.Join(extra, ", ") + ")"
	}
	return text
}

// mapResponsesIncompleteReason maps a Responses-API incomplete_details.reason
// onto provider.StopReason. An unrecognised reason returns "", leaving the
// computed stop reason alone: inventing a stop reason the rest of the pipeline
// doesn't know is worse than the finish it already inferred.
func mapResponsesIncompleteReason(reason string) provider.StopReason {
	switch reason {
	case "max_output_tokens":
		return provider.StopReasonMaxTokens
	case "content_filter":
		return provider.StopReasonContentFilter
	default:
		jlog.Trace("[openai-responses] unmapped incomplete reason %q", reason)
		return ""
	}
}
