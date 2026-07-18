//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// defaultMaxOutputTokens is Anthropic's standard per-request output limit.
const defaultMaxOutputTokens = 8192

// toolUseAccumulator tracks a tool_use block being assembled from streaming chunks
type toolUseAccumulator struct {
	id          string
	name        string
	argsBuilder strings.Builder
}

// thinkingAccumulator tracks a thinking block being assembled from streaming chunks
type thinkingAccumulator struct {
	contentBuilder strings.Builder
	signature      string
}

// transformMessages converts unified Message[] to Anthropic SDK format.
// Uses TransformToAPIMessages() for message grouping and alternation,
// then converts to SDK-specific types.
func transformMessages(messages []provider.Message) []anthropicsdk.MessageParam {
	// Use shared message transformation (defined in messages.go)
	apiMessages := TransformToAPIMessages(messages)
	if len(apiMessages) == 0 {
		return nil
	}

	// Convert to SDK format
	return convertToSDKMessages(apiMessages)
}

// convertToSDKMessages converts APIMessage[] to anthropicsdk.MessageParam[].
// Handles SDK-specific type conversions for each content block type.
func convertToSDKMessages(apiMessages []APIMessage) []anthropicsdk.MessageParam {
	result := make([]anthropicsdk.MessageParam, 0, len(apiMessages))

	for _, msg := range apiMessages {
		var role anthropicsdk.MessageParamRole
		if msg.Role == "user" {
			role = anthropicsdk.MessageParamRoleUser
		} else {
			role = anthropicsdk.MessageParamRoleAssistant
		}

		var blocks []anthropicsdk.ContentBlockParamUnion
		for _, block := range msg.Content {
			sdkBlock := convertBlockToSDK(block)
			if sdkBlock != nil {
				blocks = append(blocks, *sdkBlock)
			}
		}

		if len(blocks) > 0 {
			result = append(result, anthropicsdk.MessageParam{
				Role:    role,
				Content: blocks,
			})
		}
	}

	return result
}

// convertBlockToSDK converts an APIContentBlock to an SDK content block.
func convertBlockToSDK(block APIContentBlock) *anthropicsdk.ContentBlockParamUnion {
	switch block.Type {
	case "text":
		b := anthropicsdk.NewTextBlock(block.Text)
		return &b

	case "thinking":
		thinkingBlock := anthropicsdk.ThinkingBlockParam{
			Type:      "thinking",
			Thinking:  block.Thinking,
			Signature: block.Signature,
		}
		return &anthropicsdk.ContentBlockParamUnion{
			OfThinking: &thinkingBlock,
		}

	case "tool_use":
		// NewToolUseBlock's signature is (id, input, name) — input second, name
		// third. The input is the parsed object, not a JSON string: the SDK field
		// is `omitzero`+required, so a nil map is dropped and the API rejects with
		// "tool_use.input: Field required"; substitute an empty (non-nil) map so a
		// no-arg call still marshals as `input:{}`.
		input := any(block.Input)
		if block.Input == nil {
			input = map[string]any{}
		}
		b := anthropicsdk.NewToolUseBlock(block.ID, input, block.Name)
		return &b

	case "tool_result":
		b := anthropicsdk.NewToolResultBlock(block.ToolUseID, block.Content, block.IsError)
		return &b

	case "image":
		// The shared transform only emits base64 image sources. The CLI path
		// serializes APIContentBlock to JSON directly; the SDK path needs the
		// block mapped into the SDK's image-block union.
		if block.Source == nil {
			return nil
		}
		b := anthropicsdk.NewImageBlockBase64(block.Source.MediaType, block.Source.Data)
		return &b

	default:
		return nil
	}
}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}

// Client implements provider.Provider for Anthropic Claude
type Client struct {
	client          *anthropicsdk.Client
	model           string
	maxOutputTokens int64
}

// NewClient creates a new Anthropic provider
func NewClient(cfg provider.Config) (provider.Provider, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("API key is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}

	client := anthropicsdk.NewClient(
		option.WithAPIKey(cfg.APIKey),
	)

	return &Client{
		client:          &client,
		model:           cfg.Model,
		maxOutputTokens: cfg.ModelCapabilities.MaxOutputTokens,
	}, nil
}

// Name returns the provider name
func (c *Client) Name() string {
	return "anthropic"
}

// convertToolChoice maps the provider-agnostic ToolChoice onto the Anthropic
// SDK union. Returns ok=false for nil/auto (the default — the model decides),
// so the caller leaves params.ToolChoice unset.
func convertToolChoice(tc *provider.ToolChoice) (anthropicsdk.ToolChoiceUnionParam, bool) {
	if tc == nil {
		return anthropicsdk.ToolChoiceUnionParam{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" {
			return anthropicsdk.ToolChoiceUnionParam{}, false
		}
		return anthropicsdk.ToolChoiceParamOfTool(tc.Name), true
	case provider.ToolChoiceAny:
		return anthropicsdk.ToolChoiceUnionParam{OfAny: &anthropicsdk.ToolChoiceAnyParam{}}, true
	case provider.ToolChoiceNone:
		return anthropicsdk.ToolChoiceUnionParam{OfNone: &anthropicsdk.ToolChoiceNoneParam{}}, true
	default: // auto / unknown
		return anthropicsdk.ToolChoiceUnionParam{}, false
	}
}

// convertTools converts provider.ToolDefinition to Anthropic SDK format
func convertTools(tools []provider.ToolDefinition) []anthropicsdk.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]anthropicsdk.ToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Extract properties and required from the input schema
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err != nil {
			// ⚠️ CRITICAL: Tool schema unmarshal failed
			jlog.Error("WARNING: Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			jlog.Error("Raw InputSchema bytes (%d bytes): %s", len(tool.InputSchema), string(tool.InputSchema))
			jlog.Error("Skipping tool '%s'", tool.Name)
			continue // Skip invalid schemas
		}

		// Extract the properties object (the actual parameter definitions)
		properties := schemaMap["properties"]
		if properties == nil {
			properties = map[string]any{} // Empty properties if not specified
		}

		// Extract required fields
		var required []string
		if req, ok := schemaMap["required"].([]any); ok {
			required = make([]string, 0, len(req))
			for _, r := range req {
				if rStr, ok := r.(string); ok {
					required = append(required, rStr)
				}
			}
		}

		// Create ToolInputSchemaParam with extracted fields
		schema := anthropicsdk.ToolInputSchemaParam{
			Type:       "object",
			Properties: properties,
			Required:   required,
		}

		// Create the tool union param with full ToolParam including description
		result = append(result, anthropicsdk.ToolUnionParam{
			OfTool: &anthropicsdk.ToolParam{
				Name:        tool.Name,
				Description: anthropicsdk.String(tool.Description),
				InputSchema: schema,
			},
		})
	}
	return result
}

// buildMessageParams assembles the Anthropic SDK request from a provider
// request, including the prompt-cache breakpoints. Pure (no network, no ctx)
// so the cache-breakpoint scheme is unit-testable.
//
// Prompt cache layout (Anthropic matches the longest previously-written prefix,
// in tools → system → messages order):
//
//		[ tools ][ system ] | cache_control | [ history ] | cache_control |
//
//	  - The system breakpoint caches tools+system. This prefix is stable across a
//	    strategy change and across turns (it varies only on a plugin enable/disable
//	    or a pinned-file edit), so the breakpoint actually hits instead of
//	    cold-starting every phase change.
//	  - The history breakpoint sits on the final block of the final message, so
//	    each turn writes an incrementally longer prefix and the next turn reads
//	    the prior one — a rolling cache over the growing conversation, with no
//	    offset bookkeeping on our side.
//
// Two breakpoints, well within Anthropic's limit of four. Below the model's
// minimum cacheable size the breakpoints are silently ignored by the API, so
// always emitting them is safe.
func (c *Client) buildMessageParams(req provider.MessageRequest) anthropicsdk.MessageNewParams {
	messages := transformMessages(req.Messages)
	setRollingCacheBreakpoint(messages)

	maxTokens := c.maxOutputTokens
	if maxTokens <= 0 {
		maxTokens = int64(GetMaxOutputTokens(c.model))
	}
	params := anthropicsdk.MessageNewParams{
		Model:     anthropicsdk.Model(c.model),
		MaxTokens: maxTokens,
		Messages:  messages,
	}

	// System prompt as a single cached block (stable prefix — see the cache
	// layout note on buildMessageParams).
	if req.SystemPrompt != "" {
		sys := anthropicsdk.TextBlockParam{Text: req.SystemPrompt, Type: "text"}
		sys.CacheControl = anthropicsdk.NewCacheControlEphemeralParam()
		params.System = []anthropicsdk.TextBlockParam{sys}
	}

	// Add tools if provided
	if len(req.Tools) > 0 {
		params.Tools = convertTools(req.Tools)
		// Honour a forced tool choice (e.g. a plugin forcing return_result).
		// Only meaningful when tools are present.
		if tc, ok := convertToolChoice(req.ToolChoice); ok {
			params.ToolChoice = tc
		}
	}

	// Extended thinking. Anthropic forbids a forced tool_choice (type "tool" or
	// "any") together with thinking — a hard 400 — so a forced-tool turn (e.g.
	// /compact forcing return_result) wins and drops thinking for that turn.
	// Temperature is never set here, which thinking also requires.
	if budget, ok := thinkingBudgetForLevel(c.model, req.ThinkingLevel, maxTokens); ok && !forcesTool(req.ToolChoice) {
		params.Thinking = anthropicsdk.ThinkingConfigParamOfEnabled(budget)
	}

	return params
}

// forcesTool reports whether a ToolChoice compels the model to call a tool
// (mode "tool" or "any"). Only these two modes conflict with extended thinking;
// "auto"/"none"/nil do not.
func forcesTool(tc *provider.ToolChoice) bool {
	return tc != nil && (tc.Mode == provider.ToolChoiceTool || tc.Mode == provider.ToolChoiceAny)
}

// thinkingBudgetForLevel maps a canonical thinking level to an Anthropic
// budget_tokens value for the given model. It returns (budget, true) when
// thinking should be enabled for this turn, or (0, false) for "off"/absent/
// unknown levels and models that don't support extended thinking. The budget is
// clamped to stay a safe margin (~4k answer headroom) below the effective
// max_tokens going on the wire, since Anthropic requires budget_tokens <
// max_tokens. The wire value is passed in rather than re-derived from the
// static catalog so a capability snapshot carrying a lower output limit can
// never push budget_tokens above max_tokens (a hard 400).
func thinkingBudgetForLevel(model, level string, maxTokens int64) (int64, bool) {
	if !SupportsThinking(model) {
		return 0, false
	}
	var budget int64
	switch provider.NormalizeThinkingLevel(level) {
	case provider.ThinkingLow:
		budget = 2048
	case provider.ThinkingMedium:
		budget = 8192
	case provider.ThinkingHigh:
		budget = 16384
	case provider.ThinkingMax:
		budget = 32768
	default: // "off", absent, or unknown ⇒ no thinking param (current behaviour)
		return 0, false
	}
	const answerHeadroom int64 = 4096
	maxBudget := maxTokens - answerHeadroom
	if maxBudget < 1024 { // Anthropic requires budget_tokens ≥ 1024
		return 0, false
	}
	if budget > maxBudget {
		budget = maxBudget
	}
	return budget, true
}

// setRollingCacheBreakpoint places an ephemeral cache_control breakpoint on the
// final content block of the final message. Anthropic matches the longest
// previously-cached prefix, so writing the breakpoint at the tail each turn
// rolls the cache forward across the conversation without us tracking offsets.
// No-op on empty input or a message with no blocks.
func setRollingCacheBreakpoint(messages []anthropicsdk.MessageParam) {
	if len(messages) == 0 {
		return
	}
	last := &messages[len(messages)-1]
	if len(last.Content) == 0 {
		return
	}
	if cc := last.Content[len(last.Content)-1].GetCacheControl(); cc != nil {
		*cc = anthropicsdk.NewCacheControlEphemeralParam()
	}
}

// sendMessageStreaming sends a message request using the streaming API to preserve block generation order.
// Emits chunks to callback in real-time as content is generated.
// Returns the accumulated blocks and metadata for the tool execution loop.
func (c *Client) sendMessageStreaming(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StructuredResponse, error) {
	// Check context before making API call
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Build request params (system/tools/messages + prompt-cache breakpoints).
	params := c.buildMessageParams(req)

	// Log the SDK request payload
	jlog.Trace("[anthropic REQUEST] model=%s, messages=%d", string(params.Model), len(params.Messages))

	// Provider-boundary liveness: the SDK stream blocks on a socket read with
	// no deadline of its own, so guard it with an idle watchdog that cancels
	// streamCtx if the upstream goes silent (half-open connection, server
	// stalled mid-response). Each event resets it; see utils.StreamIdleTimeout.
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	idleTimeout := utils.EffectiveStreamIdleTimeout()
	idle := utils.NewIdleWatchdog(idleTimeout, cancel)
	defer idle.Stop()

	// Create streaming request - this preserves block generation order
	stream := c.client.Messages.NewStreaming(streamCtx, params)
	defer func() { _ = stream.Close() }() // release the underlying TLS conn on every return path

	// Track accumulated blocks in generation order
	var blocks []provider.ContentBlock
	// The frontend handles tool execution, so no tool results are returned here.

	// Track current block being assembled
	var currentTextBuilder strings.Builder
	var currentToolUse *toolUseAccumulator
	var currentThinking *thinkingAccumulator
	var currentBlockType string

	// Token counts and stop reason from message_delta. Per the provider
	// boundary contract (registry/provider.go StreamResult), InputTokens
	// is the TOTAL prompt (fresh + cache_read + cache_creation), and
	// cacheRead/cacheWrite are reported as their own subset fields.
	var inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens int
	var stopReason string

	// Running output-token estimate for the UI's mid-stream spinner.
	progress := provider.NewProgressEmitter(callback)

	// Process streaming events in order
	for stream.Next() {
		idle.Reset()
		event := stream.Current()

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		switch event.Type {
		case "message_start":
			// Extract input token count from initial message.
			//
			// We deliberately do NOT emit a transient `usage` chunk here.
			// The Anthropic-style usage that arrives at message_start has
			// been observed to be cumulative across all API calls in a
			// single juggler turn (the LLM-internal tool-use chain) — so
			// emitting it mid-stream would flash a wrong number in the
			// footer before end-of-turn corrects it. The footer keeps
			// showing the previous turn's correct anchor until the new
			// end-of-turn write lands, which is the least-wrong UX.
			if event.Message.Usage.InputTokens > 0 {
				inputTokens = int(event.Message.Usage.InputTokens)
			}

		case "content_block_start":
			// Finalize any previous block before starting new one
			c.finalizeCurrentBlock(&blocks, &currentTextBuilder, &currentToolUse, &currentThinking, currentBlockType)

			// Initialize accumulator based on block type
			currentBlockType = event.ContentBlock.Type
			switch event.ContentBlock.Type {
			case "text":
				// Text block - will accumulate via text_delta
				currentTextBuilder.Reset()
			case "thinking":
				// Thinking block - will accumulate via thinking_delta
				currentThinking = &thinkingAccumulator{}
			case "tool_use", "server_tool_use":
				// Tool use block - will accumulate via input_json_delta
				currentToolUse = &toolUseAccumulator{
					id:   event.ContentBlock.ID,
					name: event.ContentBlock.Name,
				}
			}

		case "content_block_delta":
			// Process delta based on type
			switch event.Delta.Type {
			case "text_delta":
				// Stream text immediately via callback (preserves UI responsiveness)
				text := event.Delta.Text
				currentTextBuilder.WriteString(text)
				progress.Add(text)
				if _, err := callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: text,
				}); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}

			case "input_json_delta":
				// Accumulate tool input JSON (streamed incrementally)
				if currentToolUse != nil {
					currentToolUse.argsBuilder.WriteString(event.Delta.PartialJSON)
					progress.Add(event.Delta.PartialJSON)
				}

			case "thinking_delta":
				// Stream thinking content immediately
				if currentThinking != nil {
					thinking := event.Delta.Thinking
					currentThinking.contentBuilder.WriteString(thinking)
					progress.Add(thinking)
					if _, err := callback(provider.StreamChunk{
						Type:    provider.ContentBlockTypeThinking,
						Content: thinking,
					}); err != nil {
						return nil, fmt.Errorf("callback error: %w", err)
					}
				}

			case "signature_delta":
				// Accumulate signature for thinking block
				if currentThinking != nil {
					currentThinking.signature += event.Delta.Signature
				}
			}

		case "content_block_stop":
			// Finalize the current block and add to blocks array
			block := c.finalizeCurrentBlock(&blocks, &currentTextBuilder, &currentToolUse, &currentThinking, currentBlockType)
			currentBlockType = ""

			// For tool_use blocks, stream to frontend (no execution - frontend handles that)
			if block != nil && block.Type == provider.ContentBlockTypeToolUse {
				if _, err := callback(provider.StreamChunk(*block)); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}
			}

		case "message_delta":
			// Extract stop_reason and output token count
			if event.Delta.StopReason != "" {
				stopReason = string(event.Delta.StopReason)
			}
			if event.Usage.OutputTokens > 0 {
				outputTokens = int(event.Usage.OutputTokens)
			}
			// Emit a transient `usage` chunk so the UI footer flips
			// to a real input-token anchor as soon as this API call
			// finishes. message_delta carries per-call authoritative
			// usage; we deliberately do NOT use message_start here
			// because some upstreams (notably the claudecode CLI)
			// report message_start.usage cumulatively across calls,
			// producing 10×–40× wrong values.
			fresh := int(event.Usage.InputTokens)
			cacheRead := int(event.Usage.CacheReadInputTokens)
			cacheWrite := int(event.Usage.CacheCreationInputTokens)
			if total := fresh + cacheRead + cacheWrite; total > 0 {
				// Promote per-call authoritative usage so the final
				// StructuredResponse reflects the boundary contract
				// (InputTokens = total prompt; CachedTokens / CacheWriteTokens
				// reported separately as subsets).
				inputTokens = total
				cacheReadTokens = cacheRead
				cacheWriteTokens = cacheWrite
				if _, err := callback(provider.StreamChunk{
					Type: provider.ContentBlockTypeUsage,
					Metadata: map[string]any{
						"inputTokens":  total,
						"cachedTokens": cacheRead,
					},
				}); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}
			}
		}
	}

	// Check for stream errors
	if err := stream.Err(); err != nil {
		// Distinguish a watchdog-induced idle stall (our streamCtx cancel, with
		// the parent ctx still alive) from a caller cancel or a real API error.
		// Word it so the worker's transient classifier retries (it matches
		// "stream stalled" / "connection may have dropped").
		if idle.Fired() && ctx.Err() == nil {
			return nil, utils.StallError("anthropic", idleTimeout)
		}
		return nil, fmt.Errorf("anthropic streaming error: %w", err)
	}

	// Finalize any remaining block
	c.finalizeCurrentBlock(&blocks, &currentTextBuilder, &currentToolUse, &currentThinking, currentBlockType)

	// Parse XML tool calls in text blocks and convert to ToolUse blocks
	blocks = utils.ParseXMLToolCalls(blocks, req.Tools)

	return &provider.StructuredResponse{
		Blocks:           blocks,
		StopReason:       stopReason,
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		CachedTokens:     cacheReadTokens,
		CacheWriteTokens: cacheWriteTokens,
	}, nil
}

// finalizeCurrentBlock finalizes the current block being accumulated and adds it to blocks.
// Returns the finalized block if one was created, nil otherwise.
func (c *Client) finalizeCurrentBlock(
	blocks *[]provider.ContentBlock,
	textBuilder *strings.Builder,
	toolUse **toolUseAccumulator,
	thinking **thinkingAccumulator,
	blockType string,
) *provider.ContentBlock {
	var block *provider.ContentBlock

	switch blockType {
	case "text":
		if textBuilder.Len() > 0 {
			b := provider.ContentBlock{
				Type:    provider.ContentBlockTypeText,
				Content: textBuilder.String(),
			}
			*blocks = append(*blocks, b)
			block = &b
			textBuilder.Reset()
		}

	case "thinking":
		if *thinking != nil && (*thinking).contentBuilder.Len() > 0 {
			b := provider.ContentBlock{
				Type:    provider.ContentBlockTypeThinking,
				Content: (*thinking).contentBuilder.String(),
				Metadata: map[string]any{
					"signature": (*thinking).signature,
				},
			}
			*blocks = append(*blocks, b)
			block = &b
			*thinking = nil
		}

	case "tool_use", "server_tool_use":
		if *toolUse != nil {
			// Parse accumulated JSON
			var input map[string]any
			argsStr := (*toolUse).argsBuilder.String()
			if argsStr != "" {
				if err := json.Unmarshal([]byte(argsStr), &input); err != nil {
					jlog.Error("Failed to parse tool input JSON for %s: %v", (*toolUse).name, err)
					input = map[string]any{}
				}
			} else {
				input = map[string]any{}
			}

			b := provider.ContentBlock{
				Type:      provider.ContentBlockTypeToolUse,
				ToolUseID: (*toolUse).id,
				ToolName:  (*toolUse).name,
				ToolInput: input,
			}
			*blocks = append(*blocks, b)
			block = &b
			*toolUse = nil
		}
	}

	return block
}

// OpenConversation returns a native anthropic Conversation handle.
// anthropic is stateless from the conversation's view (one HTTP request
// per turn carries its own history) so the handle just owns the model
// identity + per-turn dispatch.
func (c *Client) OpenConversation(ctx context.Context, convID string) (provider.Conversation, error) {
	// CacheTTL 5m: the ephemeral cache_control breakpoints buildMessageParams
	// writes default to Anthropic's 5-minute TTL, so the UI treats a warm anchor
	// as stale after 5 minutes of inactivity.
	return &provider.StatelessConversation{ConvID: convID, TTL: 5 * time.Minute, Dispatch: c.streamMessage}, nil
}

// streamMessage streams a message to Claude API.
// Makes a single API call and returns. Tool execution is handled by frontend.
// Uses real streaming API to preserve block generation order.
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Stream response from API - this preserves block generation order
	// and emits chunks to callback in real-time
	resp, err := c.sendMessageStreaming(ctx, req, callback)
	if err != nil {
		return nil, err
	}

	return &provider.StreamResult{
		StopReason:       resp.StopReason,
		InputTokens:      resp.InputTokens,
		OutputTokens:     resp.OutputTokens,
		CachedTokens:     resp.CachedTokens,
		CacheWriteTokens: resp.CacheWriteTokens,
	}, nil
}

// ListModelsWithInfo returns detailed information about available models from Anthropic API
// Note: Anthropic API doesn't expose context window info, so we use hardcoded fallbacks
func (c *Client) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	// Use the Anthropic Models API to list available models
	page, err := c.client.Models.List(ctx, anthropicsdk.ModelListParams{})
	if err != nil {
		return nil, fmt.Errorf("failed to list models from Anthropic: %w", err)
	}

	var modelInfos []provider.ModelInfo
	for _, model := range page.Data {
		// Anthropic API doesn't provide context window info, use hardcoded fallback
		contextWindow := GetContextWindow(model.ID)

		var inputModalities []string
		if SupportsImageInput(model.ID) {
			inputModalities = []string{"text", "image"}
		}

		var thinkingLevels []string
		var defaultThinkingLevel string
		if SupportsThinking(model.ID) {
			thinkingLevels = []string{provider.ThinkingOff, provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh, provider.ThinkingMax}
			defaultThinkingLevel = provider.ThinkingOff
		}

		modelInfos = append(modelInfos, provider.ModelInfo{
			ID:                   model.ID,
			DisplayName:          utils.FirstNonEmpty(model.DisplayName, utils.ModelDisplayName(model.ID)),
			ContextWindow:        contextWindow,
			MaxOutputTokens:      GetMaxOutputTokens(model.ID),
			FromAPI:              false, // Hardcoded fallback
			InputModalities:      inputModalities,
			ThinkingLevels:       thinkingLevels,
			DefaultThinkingLevel: defaultThinkingLevel,
		})
	}

	return modelInfos, nil
}

// Info returns provider metadata
func Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:                "anthropic",
		DisplayName:         "Anthropic (API)",
		ConfigKeyName:       "anthropic_api_key",
		EnvVarName:          "ANTHROPIC_API_KEY",
		APIKeyURL:           "https://console.anthropic.com/settings/keys",
		ModelContextWindows: ModelContextWindows,
	}
}
