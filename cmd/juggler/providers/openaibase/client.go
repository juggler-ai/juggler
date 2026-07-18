//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/packages/respjson"
	"github.com/openai/openai-go/v3/responses"
	"github.com/openai/openai-go/v3/shared"
)

// extraStringField pulls a string value out of an SDK ExtraFields map — the
// catch-all for JSON keys the typed struct doesn't model. Reasoning models on
// the Chat Completions wire stream chain-of-thought under the non-standard
// `reasoning_content` key, which lands here. Returns "" when the field is
// absent, null, or not a JSON string.
func extraStringField(extra map[string]respjson.Field, key string) string {
	// Note: Field.Valid() reports false for ExtraFields entries (the SDK only
	// marks modeled fields valid), so gate on the raw JSON instead.
	raw := extra[key].Raw()
	if raw == "" || raw == respjson.Null {
		return ""
	}
	var s string
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return ""
	}
	return s
}

// reasoningDeltaKeys are the non-standard Chat Completions delta fields under
// which OpenAI-compatible reasoning models stream chain-of-thought. GLM /
// DeepSeek-R1 use `reasoning_content`; OpenRouter relays it as `reasoning`.
// First non-empty wins (a single response uses one or the other, never both).
var reasoningDeltaKeys = []string{"reasoning_content", "reasoning"}

// extraReasoningDelta returns the reasoning text carried in a delta's
// ExtraFields under any known key, or "" if none is present.
func extraReasoningDelta(extra map[string]respjson.Field) string {
	for _, key := range reasoningDeltaKeys {
		if s := extraStringField(extra, key); s != "" {
			return s
		}
	}
	return ""
}

// Quirks isolates the per-vendor OpenAI-compatible API divergences in one
// struct. Default zero-value matches the standard OpenAI Chat Completions
// contract; each field overrides one vendor-specific wrinkle.
//
// Add new fields here ONLY for differences in the request shape sent on the
// wire — anything else (model lists, capabilities) belongs as a sibling
// model id in ListModelsWithInfo, not as a knob here.
type Quirks struct {
	// UseDeveloperRole sends the system prompt under the "developer" role
	// instead of "system" (OpenAI's newer API surface).
	UseDeveloperRole bool

	// MaxTokensParamName is the name of the output-cap parameter on the
	// wire — usually "max_tokens"; OpenAI's newer models want
	// "max_completion_tokens". Empty defaults to "max_tokens".
	MaxTokensParamName string

	// ForceResponsesAPI sends every model through Responses regardless of
	// model-id naming. Some providers expose Responses-only model catalogs
	// whose slugs do not contain "codex".
	ForceResponsesAPI bool

	// IncludePresencePenalty / IncludeFrequencyPenalty send the named
	// penalty params even when they would be zero. Most vendors silently
	// reject these; deepseek/zai accept them.
	IncludePresencePenalty  bool
	IncludeFrequencyPenalty bool

	// EchoReasoningContent replays a prior assistant turn's chain-of-thought
	// back to the API under the non-standard `reasoning_content` key. DeepSeek's
	// thinking mode rejects a continued turn (e.g. the request that follows a
	// tool call) with 400 "The `reasoning_content` in the thinking mode must be
	// passed back to the API" when the reasoning is missing. Most other vendors
	// have no such requirement (and OpenAI/OpenRouter would ignore it), so this
	// stays off by default and is enabled only where the API demands it.
	EchoReasoningContent bool
}

// Config holds configuration for OpenAI-compatible providers
type Config struct {
	APIKey      string
	BearerToken string
	Headers     map[string]string
	Model       string
	BaseURL     string // Optional custom base URL for OpenAI-compatible APIs
	HTTPClient  option.HTTPClient
	Quirks      Quirks
	// MaxOutputTokens caps generated tokens per request. 0 falls back to
	// fallbackMaxOutputTokens. Carry the model's real limit here so reasoning
	// models aren't throttled mid-thought by a one-size cap.
	MaxOutputTokens int
}

// Client is a shared OpenAI client for OpenAI-compatible providers
type Client struct {
	client          *openai.Client
	model           string
	quirks          Quirks
	maxOutputTokens int
	// thinkingSpec is this model's reasoning-effort support, resolved once at
	// construction from the descriptor's ThinkingSpecFn. Zero value ⇒ no
	// reasoning control (the request omits the effort param).
	thinkingSpec ThinkingSpec
}

// enhanceError adds helpful, human-oriented hints to common API errors. It
// prefers the typed *openai.Error fields (HTTP status, error code) and falls
// back to substring checks for signals that non-OpenAI-compatible gateways
// surface only in the raw message text.
func (c *Client) enhanceError(err error) error {
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusUnauthorized:
			return fmt.Errorf("%w (hint: your API key may be invalid)", err)
		case http.StatusTooManyRequests:
			return fmt.Errorf("%w (hint: rate limit reached, please wait)", err)
		}
		if apiErr.Code == "insufficient_quota" {
			return fmt.Errorf("%w (hint: your account may be out of credits)", err)
		}
	}

	// Fallback: some providers report these signals only in the message text.
	errMsg := err.Error()
	switch {
	case strings.Contains(errMsg, "401") || strings.Contains(errMsg, "Unauthorized"):
		return fmt.Errorf("%w (hint: your API key may be invalid)", err)
	case strings.Contains(errMsg, "429") || strings.Contains(errMsg, "Too Many Requests"):
		return fmt.Errorf("%w (hint: rate limit reached, please wait)", err)
	case strings.Contains(errMsg, "insufficient_quota") || strings.Contains(errMsg, "quota") ||
		strings.Contains(errMsg, "Insufficient balance") || strings.Contains(errMsg, "no resource package"):
		return fmt.Errorf("%w (hint: your account may be out of credits)", err)
	case strings.Contains(errMsg, "model") && strings.Contains(errMsg, "does not exist"):
		return fmt.Errorf("%w (hint: the specified model may not be available)", err)
	}

	return err
}

// ModelFilterFunc is a function that filters model IDs
type ModelFilterFunc func(modelID string) bool

// PrefixModelFilter builds a filter admitting models whose (lower-cased) id
// begins with prefix, minus any ending in one of excludeSuffixes (e.g.
// "-embedding", "-vision"). Shared by the prefix-scoped OpenAI-compatible
// providers (zai, deepseek, …).
func PrefixModelFilter(prefix string, excludeSuffixes ...string) ModelFilterFunc {
	return func(modelID string) bool {
		id := strings.ToLower(modelID)
		if !strings.HasPrefix(id, prefix) {
			return false
		}
		for _, suffix := range excludeSuffixes {
			if strings.HasSuffix(id, suffix) {
				return false
			}
		}
		return true
	}
}

// ContextWindowFunc returns context window and max output tokens for a model
type ContextWindowFunc func(modelID string) (contextWindow int, maxOutputTokens int)

// ModalitiesFunc returns the input modalities a model accepts, e.g.
// ["text","image"]. Return nil for text-only models. May be nil itself, in
// which case every model is treated as text-only.
type ModalitiesFunc func(modelID string) []string

// ListModelsWithInfo returns detailed model information using custom filter and context window functions
func (c *Client) ListModelsWithInfo(ctx context.Context, filterFunc ModelFilterFunc, contextWindowFunc ContextWindowFunc, modalitiesFunc ModalitiesFunc, thinkingSpecFunc ThinkingSpecFunc, providerName string) ([]provider.ModelInfo, error) {
	// Fetch models from API
	page, err := c.client.Models.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list models from %s: %w", providerName, err)
	}

	var modelInfos []provider.ModelInfo
	for _, model := range page.Data {
		// Apply custom filter
		if !filterFunc(model.ID) {
			continue
		}

		// Get context window info using custom function
		contextWindow, maxOutputTokens := contextWindowFunc(model.ID)

		var inputModalities []string
		if modalitiesFunc != nil {
			inputModalities = modalitiesFunc(model.ID)
		}

		var thinkingLevels []string
		var defaultThinkingLevel string
		if thinkingSpecFunc != nil {
			spec := thinkingSpecFunc(model.ID)
			thinkingLevels = spec.Levels
			defaultThinkingLevel = spec.Default
		}

		modelInfos = append(modelInfos, provider.ModelInfo{
			ID:              model.ID,
			DisplayName:     utils.ModelDisplayName(model.ID),
			ContextWindow:   contextWindow,
			MaxOutputTokens: maxOutputTokens,
			// This path always uses fallback context windows; API-sourced
			// windows come from a per-provider ListModelsOverride instead.
			FromAPI:              false,
			InputModalities:      inputModalities,
			ThinkingLevels:       thinkingLevels,
			DefaultThinkingLevel: defaultThinkingLevel,
		})
	}

	return modelInfos, nil
}

// NewClient creates a new OpenAI-compatible client
func NewClient(cfg Config) (*Client, error) {
	opts := []option.RequestOption{}
	if cfg.BearerToken != "" {
		opts = append(opts, option.WithHeader("Authorization", "Bearer "+cfg.BearerToken))
	} else {
		opts = append(opts, option.WithAPIKey(cfg.APIKey))
	}
	if len(cfg.Headers) > 0 {
		keys := make([]string, 0, len(cfg.Headers))
		for key := range cfg.Headers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			opts = append(opts, option.WithHeader(key, cfg.Headers[key]))
		}
	}

	// Add custom base URL if provided (for OpenAI-compatible APIs)
	if cfg.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	if cfg.HTTPClient != nil {
		opts = append(opts, option.WithHTTPClient(cfg.HTTPClient))
	}

	client := openai.NewClient(opts...)

	quirks := cfg.Quirks
	if quirks.MaxTokensParamName == "" {
		quirks.MaxTokensParamName = "max_tokens"
	}

	return &Client{
		client:          &client,
		model:           cfg.Model,
		quirks:          quirks,
		maxOutputTokens: cfg.MaxOutputTokens,
	}, nil
}

// NewClientFromProviderConfig creates a new OpenAI-compatible client from
// provider.Config. Validates that credentials and Model are provided (no defaults).
func NewClientFromProviderConfig(cfg provider.Config, baseURL string, quirks Quirks) (*Client, error) {
	if cfg.APIKey == "" && cfg.BearerToken == "" {
		return nil, fmt.Errorf("API key or bearer token is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}

	return NewClient(Config{
		APIKey:          cfg.APIKey,
		BearerToken:     cfg.BearerToken,
		Headers:         cfg.Headers,
		Model:           cfg.Model,
		BaseURL:         baseURL,
		Quirks:          quirks,
		MaxOutputTokens: int(cfg.ModelCapabilities.MaxOutputTokens),
	})
}

// IsResponsesAPIModel returns true if the model requires the Responses API instead of Chat Completions.
func IsResponsesAPIModel(model string) bool {
	modelLower := strings.ToLower(model)
	// Codex and GPT-5.6 model ids require the Responses API.
	return strings.Contains(modelLower, "codex") || strings.HasPrefix(modelLower, "gpt-5.6")
}

// usesResponsesAPI reports whether this client's calls route through the
// Responses API rather than Chat Completions — either because the model id
// requires it or because the ForceResponsesAPI quirk is set.
func (c *Client) usesResponsesAPI() bool {
	return c.quirks.ForceResponsesAPI || IsResponsesAPIModel(c.model)
}

// convertToolsToResponsesAPI converts provider.ToolDefinition to Responses API tool format
func convertToolsToResponsesAPI(tools []provider.ToolDefinition) []responses.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]responses.ToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Convert input schema to FunctionParameters (map[string]any)
		var params shared.FunctionParameters
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err == nil {
			params = shared.FunctionParameters(schemaMap)
		} else {
			jlog.Error("Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			params = shared.FunctionParameters{}
		}

		result = append(result, responses.ToolUnionParam{
			OfFunction: &responses.FunctionToolParam{
				Name:        tool.Name,
				Description: openai.String(tool.Description),
				Parameters:  params,
			},
		})
	}
	return result
}

// transformMessagesToResponsesInput converts unified Message[] to Responses API input format
func transformMessagesToResponsesInput(messages []provider.Message) responses.ResponseNewParamsInputUnion {
	var inputItems responses.ResponseInputParam

	// System prompt is set separately on params; here we build input items
	// from the messages.
	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if contentList := buildResponsesUserContent(msg); len(contentList) > 0 {
				inputItems = append(inputItems, responses.ResponseInputItemParamOfMessage(contentList, "user"))
			}

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
			inputItems = append(inputItems, responses.ResponseInputItemParamOfFunctionCallOutput(
				msg.ToolUseID,
				content,
			))
		}
	}

	return responses.ResponseNewParamsInputUnion{
		OfInputItemList: inputItems,
	}
}

// fallbackMaxOutputTokens caps generation when the client wasn't told the
// model's real limit (Config.MaxOutputTokens == 0). A conservative
// unset-default; real per-model caps come through the descriptor's
// ContextWindowFn.
const fallbackMaxOutputTokens = 8192

func (c *Client) effectiveMaxOutputTokens() int {
	if c.maxOutputTokens > 0 {
		return c.maxOutputTokens
	}
	return fallbackMaxOutputTokens
}

// defaultResponsesInstructions is injected when ForceResponsesAPI is set and
// the system prompt is blank: those Responses-only catalogs require non-empty
// instructions on the request.
const defaultResponsesInstructions = "You are a helpful assistant."

// promptCacheKey returns a stable per-conversation/thread key for OpenAI's
// prompt-cache routing, or "" when there's no conversation id to key on.
//
// OpenAI's prefix cache lives on a specific backend shard, and requests are
// routed to a shard by hashing the prompt prefix PLUS this key when present.
// Without a stable key, consecutive turns with an identical prefix get
// load-balanced onto different shards and miss a cache that genuinely exists —
// so an agent loop's growing prefix is re-billed at the fresh rate roughly
// every other turn. Sending the same key each turn keeps the conversation
// pinned to one shard. Scoped by thread as well, mirroring how stateful
// providers keep a per-thread session (ThreadID "" = root thread).
//
// Empty conversation id => no key: a constant fallback like "/" would funnel
// unrelated conversations onto a single shard, which is worse than default
// prefix-only routing. This also means the key is absent in unit tests that
// don't set ConversationID, so request bodies there are unchanged.
func promptCacheKey(req provider.MessageRequest) string {
	if req.ConversationID == "" {
		return ""
	}
	return req.ConversationID + "/" + req.ThreadID
}

// streamMessageResponses uses the Responses API for models that need it.
func (c *Client) streamMessageResponses(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with Responses API, model %s, %d messages", c.model, len(req.Messages))

	instructions := req.SystemPrompt
	if c.quirks.ForceResponsesAPI && strings.TrimSpace(instructions) == "" {
		instructions = defaultResponsesInstructions
	}

	// Build request params - Model is a string type
	params := responses.ResponseNewParams{
		Model:           c.model,
		Input:           transformMessagesToResponsesInput(req.Messages),
		MaxOutputTokens: openai.Int(int64(c.effectiveMaxOutputTokens())),
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
		if tc, ok := convertToolChoiceResponses(req.ToolChoice); ok {
			params.ToolChoice = tc
		}
	}

	// Reasoning effort. Omitted (ok=false) for non-reasoning models and absent/
	// unsupported levels, keeping the request byte-identical to today.
	if effort, ok := c.thinkingSpec.effortFor(req.ThinkingLevel); ok {
		params.Reasoning.Effort = openai.ReasoningEffort(effort)
	}

	// Create streaming request
	opts := []option.RequestOption{}
	if c.quirks.ForceResponsesAPI {
		opts = append(opts,
			option.WithJSONSet("store", false),
			option.WithJSONSet("stream", true),
		)
	}
	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout.
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idleTimeout := utils.EffectiveStreamIdleTimeout()
	idle := utils.NewIdleWatchdog(idleTimeout, cancel)
	defer idle.Stop()

	stream := c.client.Responses.NewStreaming(streamCtx, params, opts...)

	var inputTokens, outputTokens, cachedTokens int
	var textContent strings.Builder
	var thinkingContent strings.Builder

	// Running output-token estimate for the UI spinner.
	progress := provider.NewProgressEmitter(callback)

	// emitThinking streams a reasoning delta as live thinking and feeds the
	// output-token progress estimate, so a model that reasons before answering
	// shows movement instead of a frozen "Receiving" spinner.
	emitThinking := func(text string) error {
		if text == "" {
			return nil
		}
		thinkingContent.WriteString(text)
		progress.Add(text)
		_, err := callback(provider.StreamChunk{
			Type:    provider.ContentBlockTypeThinking,
			Content: text,
		})
		return err
	}

	// Track function calls being assembled (keyed by item ID)
	functionCalls := make(map[string]*toolCallAccumulator)

	// Process the stream - events are ResponseStreamEventUnion
	for stream.Next() {
		idle.Reset()
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
				progress.Add(delta.Delta)
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
				progress.Add(delta.Delta)
			}

		case "response.reasoning_summary_text.delta":
			// Reasoning summary delta (o-series / gpt-5-codex): the model's
			// thinking, surfaced the same way as the Chat Completions
			// `reasoning_content` path.
			if err := emitThinking(evt.AsResponseReasoningSummaryTextDelta().Delta); err != nil {
				return nil, err
			}

		case "response.reasoning_text.delta":
			// Raw reasoning delta (emitted by some Responses-API models in
			// place of, or alongside, the summary stream).
			if err := emitThinking(evt.AsResponseReasoningTextDelta().Delta); err != nil {
				return nil, err
			}

		case "response.completed":
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
			if completed.Response.Usage.InputTokensDetails.CachedTokens > 0 {
				cachedTokens = int(completed.Response.Usage.InputTokensDetails.CachedTokens)
			}
		}
	}

	if err := stream.Err(); err != nil {
		if idle.Fired() && ctx.Err() == nil {
			return nil, utils.StallError("openai", idleTimeout)
		}
		return nil, err // Don't enhance - let retry wrapper handle it
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

	stopReason := "end_turn"
	if len(functionCalls) > 0 {
		stopReason = "tool_use"
	}

	// Estimate tokens from content when the API doesn't report usage
	if inputTokens == 0 {
		inputTokens = provider.EstimateTokens(marshalMessagesForEstimate(req)) + estimateImageTokens(req)
	}
	if outputTokens == 0 {
		outputTokens = provider.EstimateTokens(textContent.String())
	}

	return &provider.StreamResult{
		StopReason:   stopReason,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		CachedTokens: cachedTokens,
	}, nil
}

// convertToolChoiceChat maps the provider-agnostic ToolChoice onto the Chat
// Completions tool_choice union. ok=false for nil/auto (the model decides).
func convertToolChoiceChat(tc *provider.ToolChoice) (openai.ChatCompletionToolChoiceOptionUnionParam, bool) {
	if tc == nil {
		return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" {
			return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
		}
		return openai.ChatCompletionToolChoiceOptionUnionParam{
			OfFunctionToolChoice: &openai.ChatCompletionNamedToolChoiceParam{
				Function: openai.ChatCompletionNamedToolChoiceFunctionParam{Name: tc.Name},
			},
		}, true
	case provider.ToolChoiceAny:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("required")}, true
	case provider.ToolChoiceNone:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("none")}, true
	default: // auto / unknown
		return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
	}
}

// convertToolChoiceResponses maps the provider-agnostic ToolChoice onto the
// Responses API tool_choice union. ok=false for nil/auto.
func convertToolChoiceResponses(tc *provider.ToolChoice) (responses.ResponseNewParamsToolChoiceUnion, bool) {
	if tc == nil {
		return responses.ResponseNewParamsToolChoiceUnion{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" {
			return responses.ResponseNewParamsToolChoiceUnion{}, false
		}
		return responses.ResponseNewParamsToolChoiceUnion{
			OfFunctionTool: &responses.ToolChoiceFunctionParam{Name: tc.Name},
		}, true
	case provider.ToolChoiceAny:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsRequired)}, true
	case provider.ToolChoiceNone:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsNone)}, true
	default: // auto / unknown
		return responses.ResponseNewParamsToolChoiceUnion{}, false
	}
}

// convertToolsToOpenAI converts provider.ToolDefinition to OpenAI SDK format
func convertToolsToOpenAI(tools []provider.ToolDefinition) []openai.ChatCompletionToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]openai.ChatCompletionToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Convert input schema to FunctionParameters (map[string]any)
		var params shared.FunctionParameters
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err == nil {
			params = shared.FunctionParameters(schemaMap)
		} else {
			// CRITICAL: Tool schema unmarshal failed - this will cause LLM to not use function calling properly!
			jlog.Error("Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			jlog.Error("Raw InputSchema bytes (%d bytes): %s", len(tool.InputSchema), string(tool.InputSchema))
			jlog.Error("Tool will be sent with empty parameters, causing LLM to fall back to text-based tool syntax")
			// Fallback to empty params
			params = shared.FunctionParameters{}
		}

		// Use the helper function to create a function tool
		result = append(result, openai.ChatCompletionFunctionTool(shared.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  params,
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

// emptyContentPlaceholder is used when tool results have empty content.
// Some APIs (e.g., Z.AI's GLM) reject messages with empty content fields.
const emptyContentPlaceholder = "(no output)"

// isEmptyContent returns true if content is empty or whitespace-only
func isEmptyContent(content string) bool {
	return strings.TrimSpace(content) == ""
}

// transformMessages converts unified Message[] to OpenAI SDK format.
// imageDataURI returns the "data:<mime>;base64,<b64>" encoding of one image
// MediaPart, or "" if the part is not a usable image (wrong type or no bytes).
// Bytes are resolved server-side into part.Data before Submit.
func imageDataURI(part provider.MediaPart) string {
	if part.Type != "image" || len(part.Data) == 0 {
		return ""
	}
	return "data:" + part.Mime + ";base64," + base64.StdEncoding.EncodeToString(part.Data)
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

// Groups consecutive assistant messages with their tool calls.
func transformMessages(messages []provider.Message, useDeveloperRole, echoReasoning bool, systemPrompt string) []openai.ChatCompletionMessageParamUnion {
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
	// pendingReasoning holds the turn's chain-of-thought, replayed back to the
	// API when echoReasoning is set (see Quirks.EchoReasoningContent).
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
			// DeepSeek's thinking mode requires the turn's reasoning to be
			// echoed back under the non-standard `reasoning_content` key.
			if echoReasoning && pendingReasoning.Len() > 0 {
				assistantMsg.SetExtraFields(map[string]any{
					"reasoning_content": pendingReasoning.String(),
				})
			}
			apiMessages = append(apiMessages, openai.ChatCompletionMessageParamUnion{
				OfAssistant: &assistantMsg,
			})
		}
		pendingAssistantText.Reset()
		pendingReasoning.Reset()
		pendingToolCalls = nil
	}

	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages (error, system)
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Flush any pending assistant content first
			flushAssistant()
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if userMsg, ok := buildChatUserMessage(msg); ok {
				apiMessages = append(apiMessages, userMsg)
			}

		case "assistant":
			pendingAssistantText.WriteString(msg.Content)

		case "thinking":
			// Thinking blocks are internal model state. OpenAI has no native
			// thinking channel, so they are normally dropped — but DeepSeek's
			// thinking mode requires the reasoning be replayed on the next
			// request, so accumulate it when echoReasoning is set.
			if echoReasoning {
				pendingReasoning.WriteString(msg.Content)
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
			// OpenAI expects role="tool" with tool_call_id
			// Use placeholder for empty results - LLM expects a result for every tool call,
			// and some APIs (e.g., Z.AI) reject empty content
			content := msg.Content
			if isEmptyContent(content) {
				content = emptyContentPlaceholder
			}
			apiMessages = append(apiMessages, openai.ToolMessage(content, msg.ToolUseID))
		}
	}

	// Flush any remaining assistant content
	flushAssistant()

	return apiMessages
}

// streamMessage streams a message response with structured chunks.
// Makes a single API call and returns. Rate-limit retries are handled by the
// strategy loop (which can update UI state and process new messages during the wait).
// Unexported because the Conversation handle (conversation.go) is the
// public entry point; this is the per-call implementation.
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	var result *provider.StreamResult
	var err error

	if c.usesResponsesAPI() {
		result, err = c.streamMessageResponses(ctx, req, callback)
	} else {
		result, err = c.streamMessageChatCompletions(ctx, req, callback)
	}

	if err != nil {
		return nil, c.enhanceError(err)
	}
	return result, nil
}

// streamMessageChatCompletions streams using the Chat Completions API
func (c *Client) streamMessageChatCompletions(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with model %s, %d messages", c.model, len(req.Messages))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Transform unified Message[] to OpenAI format
	apiMessages := transformMessages(req.Messages, c.quirks.UseDeveloperRole, c.quirks.EchoReasoningContent, req.SystemPrompt)

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
		if tc, ok := convertToolChoiceChat(req.ToolChoice); ok {
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
	maxTokens := c.effectiveMaxOutputTokens()

	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout.
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idleTimeout := utils.EffectiveStreamIdleTimeout()
	idle := utils.NewIdleWatchdog(idleTimeout, cancel)
	defer idle.Stop()

	stream := c.client.Chat.Completions.NewStreaming(streamCtx, params, option.WithJSONSet(c.quirks.MaxTokensParamName, maxTokens))

	// Track tool calls being assembled (OpenAI streams them incrementally)
	toolCallBuffers := make(map[int]*toolCallAccumulator)

	var inputTokens, outputTokens, cachedTokens int
	var lastFinishReason string
	var textContent strings.Builder
	var thinkingContent strings.Builder

	// Running output-token estimate for the UI spinner.
	progress := provider.NewProgressEmitter(callback)

	// Process the stream
	for stream.Next() {
		idle.Reset()
		chunk := stream.Current()

		if chunk.Usage.PromptTokens > 0 {
			inputTokens = int(chunk.Usage.PromptTokens)
		}
		if chunk.Usage.CompletionTokens > 0 {
			outputTokens = int(chunk.Usage.CompletionTokens)
		}
		if chunk.Usage.PromptTokensDetails.CachedTokens > 0 {
			cachedTokens = int(chunk.Usage.PromptTokensDetails.CachedTokens)
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
				progress.Add(reasoning)
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
				textContent.WriteString(choice.Delta.Content)
				progress.Add(choice.Delta.Content)
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
					progress.Add(toolCall.Function.Arguments)
				}
			}
		}
	}

	if err := stream.Err(); err != nil {
		if idle.Fired() && ctx.Err() == nil {
			return nil, utils.StallError("openai", idleTimeout)
		}
		return nil, err // Don't enhance - let retry wrapper handle it
	}

	// Log the response summary
	jlog.Trace("[openai RESPONSE] text=%d chars, thinking=%d chars, tools=%d, finish=%s, input_tokens=%d, output_tokens=%d, cached=%d",
		textContent.Len(), thinkingContent.Len(), len(toolCallBuffers), lastFinishReason, inputTokens, outputTokens, cachedTokens)

	// Stream tool_use blocks to frontend (no execution - frontend handles that)
	if err := flushToolCalls(toolCallBuffers, callback); err != nil {
		return nil, err
	}

	// Estimate tokens from content when the API doesn't report usage
	// (e.g. OpenAI-compatible providers that ignore stream_options)
	if inputTokens == 0 {
		inputTokens = provider.EstimateTokens(marshalMessagesForEstimate(req)) + estimateImageTokens(req)
	}
	if outputTokens == 0 {
		outputTokens = provider.EstimateTokens(textContent.String())
	}

	return &provider.StreamResult{
		StopReason:   mapOpenAIFinishReason(lastFinishReason),
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		CachedTokens: cachedTokens,
	}, nil
}

// marshalMessagesForEstimate serializes message request content for token estimation.
func marshalMessagesForEstimate(req provider.MessageRequest) string {
	var b strings.Builder
	b.WriteString(req.SystemPrompt)
	for _, msg := range req.Messages {
		b.WriteString(msg.Content)
		b.WriteString(msg.ToolName)
		if msg.ToolInput != nil {
			data, _ := json.Marshal(msg.ToolInput)
			b.Write(data)
		}
	}
	for _, t := range req.Tools {
		b.WriteString(t.Name)
		b.WriteString(t.Description)
	}
	return b.String()
}

// estimateImageTokens sums the per-image token estimate across every image part
// in the request, so the text-only chars/4 estimate is modality-aware. Image
// bytes are never marshaled (MediaPart.Data is json:"-"); the dimension-based
// heuristic lives on provider.EstimateImageTokens.
func estimateImageTokens(req provider.MessageRequest) int {
	total := 0
	for _, msg := range req.Messages {
		for _, part := range msg.Parts {
			total += provider.EstimateImageTokens(part)
		}
	}
	return total
}

// mapOpenAIFinishReason maps OpenAI's finish_reason to normalized stop_reason values.
// OpenAI values: "stop", "length", "tool_calls", "content_filter", "function_call"
func mapOpenAIFinishReason(reason string) string {
	switch reason {
	case "stop":
		return "end_turn"
	case "tool_calls", "function_call":
		return "tool_use"
	case "length":
		return "max_tokens"
	case "content_filter":
		// Preserve the signal rather than collapsing into a clean end_turn — a
		// filtered (often empty) completion would otherwise be indistinguishable
		// from a normal finish.
		return "content_filter"
	default:
		return "end_turn"
	}
}
