//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
	"juggler/internal/jlog"

	"google.golang.org/api/googleapi"
	"google.golang.org/genai"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}

// Client implements provider.Provider for Google Gemini
type Client struct {
	client          *genai.Client
	model           string
	apiKey          string
	httpClient      *http.Client
	maxOutputTokens int32
}

// NewClient creates a new Gemini provider
func NewClient(cfg provider.Config) (provider.Provider, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("API key is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}
	// A garbage live-list value must not make the provider un-initializable —
	// everything else in the context-window feature degrades gracefully, so clamp
	// an over-large output cap to the int32 wire ceiling rather than failing here.
	maxOutputTokens := int32(0)
	if v := cfg.ModelCapabilities.MaxOutputTokens; v > 0 {
		if v > math.MaxInt32 {
			v = math.MaxInt32
		}
		maxOutputTokens = int32(v)
	}

	ctx := context.Background()
	// A fresh proxy-aware client per construction: genai layers its own auth
	// middleware onto whatever *http.Client it's given, so this must not be a
	// shared singleton. Its transport carries the proxy policy for inference.
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:     cfg.APIKey,
		Backend:    genai.BackendGeminiAPI,
		HTTPClient: httpx.Client(0),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}

	// Create a custom HTTP client for ListModels only (not for genai client)
	httpClient := &http.Client{
		Timeout: 90 * time.Second,
		Transport: &http.Transport{
			Proxy: httpx.Proxy,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   30 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       90 * time.Second,
		},
	}

	return &Client{
		client:          client,
		model:           cfg.Model,
		apiKey:          cfg.APIKey,
		httpClient:      httpClient,
		maxOutputTokens: maxOutputTokens,
	}, nil
}

// Name returns the provider name
func (c *Client) Name() string {
	return "gemini"
}

// prepareRequest builds the common request components for both SendMessage and StreamMessage
func (c *Client) prepareRequest(req provider.MessageRequest) (*genai.GenerateContentConfig, []*genai.Content, error) {
	config := buildGeminiConfig(req.Tools, req.ToolChoice)
	if c.maxOutputTokens > 0 {
		config.MaxOutputTokens = c.maxOutputTokens
	}
	// A per-request wire output cap (F1: hidden compaction map calls) may only
	// lower the effective max output — apply it as a min() against the client
	// value (0 = unset means "no client cap", so the request cap wins there).
	if req.MaxOutputTokens > 0 && req.MaxOutputTokens <= math.MaxInt32 {
		reqCap := int32(req.MaxOutputTokens)
		if config.MaxOutputTokens <= 0 || reqCap < config.MaxOutputTokens {
			config.MaxOutputTokens = reqCap
		}
	}

	if req.SystemPrompt != "" {
		config.SystemInstruction = &genai.Content{
			Parts: []*genai.Part{{Text: req.SystemPrompt}},
		}
	}

	// Thinking budget. Omitted for non-2.5 models and absent/unsupported levels,
	// leaving the request byte-identical to today. A positive budget also asks
	// the model to return its thoughts so they stream as thinking.
	if budget, ok := geminiThinkingSpecFor(c.model).budgetFor(req.ThinkingLevel); ok {
		b := budget
		config.ThinkingConfig = &genai.ThinkingConfig{ThinkingBudget: &b, IncludeThoughts: b > 0}
	}

	contents, err := convertMessagesToGeminiContents(req.Messages, SupportsImageInput(c.model))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to convert messages: %w", err)
	}

	if len(contents) == 0 {
		return nil, nil, fmt.Errorf("no messages to send")
	}

	return config, contents, nil
}

// buildGeminiConfig builds a GenerateContentConfig with tools and safety settings.
// toolChoice (nil = auto) maps onto Gemini's functionCallingConfig so a plugin
// can force a tool (e.g. /compact forcing return_result).
func buildGeminiConfig(tools []provider.ToolDefinition, toolChoice *provider.ToolChoice) *genai.GenerateContentConfig {
	config := &genai.GenerateContentConfig{
		SafetySettings: []*genai.SafetySetting{
			{Category: genai.HarmCategoryHarassment, Threshold: genai.HarmBlockThresholdBlockOnlyHigh},
			{Category: genai.HarmCategoryHateSpeech, Threshold: genai.HarmBlockThresholdBlockOnlyHigh},
			{Category: genai.HarmCategorySexuallyExplicit, Threshold: genai.HarmBlockThresholdBlockOnlyHigh},
			{Category: genai.HarmCategoryDangerousContent, Threshold: genai.HarmBlockThresholdBlockOnlyHigh},
		},
	}

	if len(tools) > 0 {
		config.Tools = convertToolsToGemini(tools)
		config.ToolConfig = &genai.ToolConfig{
			FunctionCallingConfig: geminiFunctionCallingConfig(toolChoice),
		}
	}

	return config
}

// geminiFunctionCallingConfig translates the provider-agnostic ToolChoice into
// Gemini's functionCallingConfig. Default (nil/auto) keeps AUTO; a forced
// specific tool becomes ANY restricted to that function name.
func geminiFunctionCallingConfig(tc *provider.ToolChoice) *genai.FunctionCallingConfig {
	if tc == nil {
		return &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeAuto}
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" {
			return &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeAuto}
		}
		return &genai.FunctionCallingConfig{
			Mode:                 genai.FunctionCallingConfigModeAny,
			AllowedFunctionNames: []string{tc.Name},
		}
	case provider.ToolChoiceAny:
		return &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeAny}
	case provider.ToolChoiceNone:
		return &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeNone}
	default: // auto / unknown
		return &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeAuto}
	}
}

// convertToolsToGemini converts provider.ToolDefinition to Gemini SDK format
func convertToolsToGemini(tools []provider.ToolDefinition) []*genai.Tool {
	if len(tools) == 0 {
		return nil
	}

	functionDeclarations := make([]*genai.FunctionDeclaration, 0, len(tools))
	for _, tool := range tools {
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err != nil {
			jlog.Error("WARNING: Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			continue
		}

		schema := &genai.Schema{Type: genai.TypeObject}

		// Extract properties
		if props, ok := schemaMap["properties"].(map[string]any); ok {
			schema.Properties = make(map[string]*genai.Schema)
			for propName, propVal := range props {
				if propMap, ok := propVal.(map[string]any); ok {
					propSchema := convertPropertySchema(propMap)
					schema.Properties[propName] = propSchema
				}
			}
		}

		// Extract required fields
		if required, ok := schemaMap["required"].([]any); ok {
			schema.Required = make([]string, 0, len(required))
			for _, req := range required {
				if reqStr, ok := req.(string); ok {
					schema.Required = append(schema.Required, reqStr)
				}
			}
		}

		functionDeclarations = append(functionDeclarations, &genai.FunctionDeclaration{
			Name:        tool.Name,
			Description: tool.Description,
			Parameters:  schema,
		})
	}

	return []*genai.Tool{{FunctionDeclarations: functionDeclarations}}
}

// convertPropertySchema converts a JSON schema property to Gemini Schema
func convertPropertySchema(propMap map[string]any) *genai.Schema {
	propSchema := &genai.Schema{}

	if propType, ok := propMap["type"].(string); ok {
		switch propType {
		case "string":
			propSchema.Type = genai.TypeString
		case "number":
			propSchema.Type = genai.TypeNumber
		case "boolean":
			propSchema.Type = genai.TypeBoolean
		case "array":
			propSchema.Type = genai.TypeArray
			if items, ok := propMap["items"].(map[string]any); ok {
				propSchema.Items = convertPropertySchema(items)
			}
		case "object":
			propSchema.Type = genai.TypeObject
		}
	}

	if desc, ok := propMap["description"].(string); ok {
		propSchema.Description = desc
	}

	return propSchema
}

// convertMessagesToGeminiContents converts unified Message[] to Gemini Content format.
// Groups consecutive same-role messages into single Content objects with multiple Parts.
// allowImages gates emitting image inline-data parts: false (text-only model)
// drops them defensively so the request stays API-valid.
func convertMessagesToGeminiContents(messages []provider.Message, allowImages bool) ([]*genai.Content, error) {
	contents := make([]*genai.Content, 0, len(messages))

	// Pre-identify tool-use IDs that lack a ThoughtSignature. These cannot be
	// sent as FunctionCall parts (thinking models require the signature), so they
	// are narrated as prose instead. Their corresponding results must match.
	unsignedToolUseIDs := map[string]bool{}
	for _, msg := range messages {
		if msg.Type == "tool-use" {
			if sigStr, _ := msg.ProviderData["thoughtSignature"].(string); sigStr == "" {
				unsignedToolUseIDs[msg.ToolUseID] = true
			}
		}
	}

	var currentParts []*genai.Part
	var currentRole string

	flushParts := func() {
		if len(currentParts) > 0 {
			contents = append(contents, &genai.Content{Role: currentRole, Parts: currentParts})
			currentParts = nil
		}
	}

	for _, msg := range messages {
		// Map message type to Gemini role
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages (error, system)
		}
		geminiRole := "user"
		if role == "assistant" {
			geminiRole = "model"
		}

		// If role changes, flush accumulated parts
		if geminiRole != currentRole && len(currentParts) > 0 {
			flushParts()
		}
		currentRole = geminiRole

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			if msg.Content != "" {
				currentParts = append(currentParts, &genai.Part{Text: msg.Content})
			}
			if allowImages {
				for _, part := range msg.Parts {
					if part.Type != "image" || len(part.Data) == 0 {
						continue
					}
					currentParts = append(currentParts, &genai.Part{
						InlineData: &genai.Blob{MIMEType: part.Mime, Data: part.Data},
					})
				}
			}

		case "assistant":
			if msg.Content != "" {
				currentParts = append(currentParts, &genai.Part{Text: msg.Content})
			}

		case "thinking":
			// Thinking blocks are internal model state — never send to any provider.

		case "tool-use":
			if unsignedToolUseIDs[msg.ToolUseID] {
				// No ThoughtSignature: narrate as prose to avoid a 400 from the thinking
				// model, without teaching it to mimic a structured text syntax.
				inputJSON, _ := json.Marshal(msg.ToolInput)
				currentParts = append(currentParts, &genai.Part{
					Text: fmt.Sprintf("I used the %s tool with args: %s", msg.ToolName, inputJSON),
				})
			} else {
				p := &genai.Part{FunctionCall: &genai.FunctionCall{Name: msg.ToolName, Args: msg.ToolInput}}
				if sigStr, _ := msg.ProviderData["thoughtSignature"].(string); sigStr != "" {
					if sig, err := base64.StdEncoding.DecodeString(sigStr); err == nil {
						p.ThoughtSignature = sig
					}
				}
				currentParts = append(currentParts, p)
			}

		case "tool-result":
			if unsignedToolUseIDs[msg.ToolUseID] {
				currentParts = append(currentParts, &genai.Part{
					Text: fmt.Sprintf("The %s tool returned: %s", msg.ToolName, msg.Content),
				})
			} else {
				var response map[string]any
				if err := json.Unmarshal([]byte(msg.Content), &response); err != nil {
					response = map[string]any{"result": msg.Content}
				}
				funcName := msg.ToolName
				if funcName == "" {
					funcName = msg.ToolUseID
					if idx := strings.Index(msg.ToolUseID, "_"); idx > 0 {
						funcName = msg.ToolUseID[:idx]
					}
				}
				currentParts = append(currentParts, &genai.Part{
					FunctionResponse: &genai.FunctionResponse{Name: funcName, Response: response},
				})
			}
		}
	}

	// Flush remaining parts
	flushParts()

	return contents, nil
}

// OpenConversation returns a native gemini Conversation handle. gemini
// is stateless from the conversation's view — every turn is one HTTP
// request that carries its full history — so the handle just owns the
// model identity + per-turn dispatch.
func (c *Client) OpenConversation(ctx context.Context, convID string) (provider.Conversation, error) {
	// TTL 0: gemini doesn't expose a TTL-bounded prefix cache through this client.
	return &provider.StatelessConversation{ConvID: convID, Dispatch: c.streamMessage}, nil
}

// streamMessage sends a message and streams the response with structured chunks.
// Makes a single API call and returns. Tool execution is handled by frontend.
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	config, contents, err := c.prepareRequest(req)
	if err != nil {
		return nil, err
	}

	return c.callStreamWithRetry(ctx, c.model, contents, config, callback)
}

// callStreamWithRetry encapsulates the retry logic for Gemini API calls.
func (c *Client) callStreamWithRetry(ctx context.Context, model string, contents []*genai.Content, config *genai.GenerateContentConfig, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	var inputTokens, outputTokens int
	var sentAnyContent bool
	var lastFinishReason genai.FinishReason
	var streamedResultsFromSuccess []*genai.GenerateContentResponse

	const maxRetries = 5
	const initialDelay = 1 * time.Second

	var lastErr error

	for i := 0; i <= maxRetries; i++ {
		// Ensure the context hasn't been cancelled by the user
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		// Log the SDK request payload only on the first attempt
		if i == 0 {
			for ci, content := range contents {
				for pi, p := range content.Parts {
					hasSig := len(p.ThoughtSignature) > 0
					jlog.Debug("[gemini REQUEST] content[%d] role=%s part[%d] text=%d thought=%v funcCall=%v sig=%v",
						ci, content.Role, pi, len(p.Text), p.Thought, p.FunctionCall != nil, hasSig)
				}
			}
		} else {
			jlog.Debug("Retrying Gemini StreamMessage (attempt %d/%d) after error: %v", i, maxRetries, lastErr)
		}

		streamedResultsForCurrentAttempt := []*genai.GenerateContentResponse{} // Reset for each attempt

		var currentInputTokens, currentOutputTokens int
		var currentLastFinishReason genai.FinishReason
		var currentSentAnyContent bool

		// runAttempt streams one attempt under a provider-boundary idle watchdog:
		// the genai SDK stream blocks on a socket read with no deadline of its
		// own, so the watchdog cancels streamCtx if the upstream goes silent.
		// retry=true signals the outer loop to back off and try again; a non-nil
		// err is terminal for the whole call.
		retry, attemptErr := func() (retry bool, err error) {
			streamCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			idleTimeout := utils.EffectiveStreamIdleTimeout()
			idle := utils.NewIdleWatchdog(idleTimeout, cancel)
			defer idle.Stop()

			// lastToolUseBlock receives standalone ThoughtSignature parts streamed after their FunctionCall.
			var lastToolUseBlock *provider.ContentBlock

			// Running output-token estimate for the UI spinner.
			progress := provider.NewProgressEmitter(callback)

			// The actual streaming call
			genaiStream := c.client.Models.GenerateContentStream(streamCtx, model, contents, config)
			for result, err := range genaiStream {
				if err != nil {
					lastErr = err
					// Retry is only safe if NO callback chunks were emitted yet:
					// callbacks have visible side effects (UI text inserts, tool_use
					// blocks the frontend will execute), and re-running the stream
					// would duplicate them.
					if currentSentAnyContent {
						return false, fmt.Errorf("gemini stream error after %d chunks (cannot retry mid-stream): %w", len(streamedResultsForCurrentAttempt), err)
					}
					// Our watchdog cancelled streamCtx because the upstream went
					// silent (parent ctx still alive). Surface as a transient stall
					// so the worker's transient classifier retries the turn.
					if idle.Fired() && ctx.Err() == nil {
						return false, utils.StallError("gemini", idleTimeout)
					}
					if gapiErr, ok := err.(*googleapi.Error); ok && (gapiErr.Code == http.StatusTooManyRequests || gapiErr.Code == http.StatusServiceUnavailable) {
						// Retryable. Back off, then signal the outer loop to retry.
						delay := min(
							// Exponential backoff
							initialDelay*time.Duration(1<<i),
							// Cap delay at 60 seconds
							60*time.Second)
						select {
						case <-time.After(delay):
							return true, nil
						case <-ctx.Done():
							return false, ctx.Err()
						}
					}
					// Not a retryable error.
					return false, fmt.Errorf("gemini API error: %w", err)
				}
				idle.Reset()

				streamedResultsForCurrentAttempt = append(streamedResultsForCurrentAttempt, result)

				if result.UsageMetadata != nil {
					if result.UsageMetadata.PromptTokenCount > 0 {
						currentInputTokens = int(result.UsageMetadata.PromptTokenCount)
					}
					if result.UsageMetadata.CandidatesTokenCount > 0 {
						currentOutputTokens = int(result.UsageMetadata.CandidatesTokenCount)
					}
				}

				if result.PromptFeedback != nil && result.PromptFeedback.BlockReason != "" {
					return false, fmt.Errorf("gemini blocked request: %s", result.PromptFeedback.BlockReason)
				}

				for _, cand := range result.Candidates {
					if cand.FinishReason != "" {
						currentLastFinishReason = cand.FinishReason
					}

					if cand.Content != nil {
						for _, part := range cand.Content.Parts {
							if part.FunctionCall != nil || len(part.ThoughtSignature) > 0 {
								jlog.Debug("[gemini RESPONSE part] funcCall=%v sigLen=%d thought=%v textLen=%d",
									part.FunctionCall != nil, len(part.ThoughtSignature), part.Thought, len(part.Text))
							}
							// Gemini streams ThoughtSignature as a standalone Part after its FunctionCall.
							if len(part.ThoughtSignature) > 0 && part.FunctionCall == nil && part.Text == "" {
								if lastToolUseBlock != nil {
									if lastToolUseBlock.Metadata == nil {
										lastToolUseBlock.Metadata = map[string]any{}
									}
									lastToolUseBlock.Metadata["thoughtSignature"] = base64.StdEncoding.EncodeToString(part.ThoughtSignature)
									jlog.Debug("[gemini RESPONSE] attached standalone ThoughtSignature (len=%d) to tool_use %s",
										len(part.ThoughtSignature), lastToolUseBlock.ToolUseID)
								}
								continue
							}
							for _, block := range mapGeminiPart(part) {
								if block.Type == provider.ContentBlockTypeToolUse {
									lastToolUseBlock = block
									if argsBytes, jerr := json.Marshal(block.ToolInput); jerr == nil {
										progress.Add(string(argsBytes))
									}
								} else {
									progress.Add(block.Content)
								}
								chunk := provider.StreamChunk(*block)
								if _, err := callback(chunk); err != nil {
									return false, err
								}
								currentSentAnyContent = true
							}
						}
					}
				}
			}
			return false, nil // stream completed successfully
		}()

		if attemptErr != nil {
			return nil, attemptErr
		}
		if retry {
			continue
		}

		// Streaming completed without an error — promote the current attempt's
		// values to the top-level variables read by processStreamResult below.
		// Clear lastErr so a successful retry after an earlier 429/503 is not
		// misreported as a failure by the post-loop check.
		lastErr = nil
		inputTokens = currentInputTokens
		outputTokens = currentOutputTokens
		lastFinishReason = currentLastFinishReason
		sentAnyContent = currentSentAnyContent
		streamedResultsFromSuccess = streamedResultsForCurrentAttempt

		break // Success — exit retry loop
	}

	if lastErr != nil {
		return nil, fmt.Errorf("gemini API call failed after %d retries: %w", maxRetries, lastErr)
	}

	return c.processStreamResult(lastFinishReason, sentAnyContent, streamedResultsFromSuccess, inputTokens, outputTokens)
}

// processStreamResult handles the final processing of a successful stream result.
func (c *Client) processStreamResult(lastFinishReason genai.FinishReason, sentAnyContent bool, streamedResultsFromSuccess []*genai.GenerateContentResponse, inputTokens, outputTokens int) (*provider.StreamResult, error) {
	// Check finish reason for errors
	if lastFinishReason == genai.FinishReasonSafety {
		return nil, fmt.Errorf("gemini blocked response due to safety filters")
	}
	if lastFinishReason == genai.FinishReasonRecitation {
		return nil, fmt.Errorf("gemini blocked response due to recitation (copyright)")
	}
	if lastFinishReason == genai.FinishReasonOther {
		return nil, fmt.Errorf("gemini stopped for unknown reason")
	}

	if !sentAnyContent {
		jlog.Trace("[gemini EMPTY_RESPONSE] chunks=%d, finish=%s", len(streamedResultsFromSuccess), lastFinishReason)
		return nil, fmt.Errorf("gemini returned an empty response (no content, chunks=%d, finish=%s)", len(streamedResultsFromSuccess), lastFinishReason)
	}

	return &provider.StreamResult{
		StopReason:   mapGeminiFinishReason(lastFinishReason),
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
	}, nil
}

// mapGeminiFinishReason maps Gemini's FinishReason to normalized stop_reason values.
// Note: Gemini uses FinishReasonStop for both natural endings AND tool calls,
// so tool_use detection must happen at the content block level, not here.
func mapGeminiFinishReason(reason genai.FinishReason) string {
	switch reason {
	case genai.FinishReasonMaxTokens:
		return "max_tokens"
	case genai.FinishReasonStop:
		return "end_turn"
	default:
		// Safety, Recitation, etc. are already handled as errors above
		return "end_turn"
	}
}

// mapGeminiPart maps a Gemini Part to ContentBlocks
// A single part can contain multiple pieces of content
func mapGeminiPart(part *genai.Part) []*provider.ContentBlock {
	if part == nil {
		return nil
	}

	var blocks []*provider.ContentBlock

	// Text content (could be thinking or regular text)
	if part.Text != "" {
		blockType := provider.ContentBlockTypeText
		if part.Thought {
			blockType = provider.ContentBlockTypeThinking
		}
		blocks = append(blocks, &provider.ContentBlock{
			Type:    blockType,
			Content: part.Text,
		})
	}

	// Function call
	if part.FunctionCall != nil {
		randomBytes := make([]byte, 2)
		_, _ = rand.Read(randomBytes)
		toolID := fmt.Sprintf("%s_%s", part.FunctionCall.Name, hex.EncodeToString(randomBytes))

		metadata := map[string]any{}
		if len(part.ThoughtSignature) > 0 {
			metadata["thoughtSignature"] = base64.StdEncoding.EncodeToString(part.ThoughtSignature)
		}

		blocks = append(blocks, &provider.ContentBlock{
			Type:      provider.ContentBlockTypeToolUse,
			Content:   "",
			ToolUseID: toolID,
			ToolName:  part.FunctionCall.Name,
			ToolInput: part.FunctionCall.Args,
			Metadata:  metadata,
		})
	}

	// Inline data (image/media)
	if part.InlineData != nil {
		blocks = append(blocks, &provider.ContentBlock{
			Type:    provider.ContentBlockTypeImage,
			Content: "",
			Metadata: map[string]any{
				"mime_type": part.InlineData.MIMEType,
				"size":      len(part.InlineData.Data),
			},
		})
	}

	// Executable code
	if part.ExecutableCode != nil {
		blocks = append(blocks, &provider.ContentBlock{
			Type:    provider.ContentBlockTypeCode,
			Content: part.ExecutableCode.Code,
			Metadata: map[string]any{
				"language": part.ExecutableCode.Language,
			},
		})
	}

	// Code execution result
	if part.CodeExecutionResult != nil {
		blocks = append(blocks, &provider.ContentBlock{
			Type:    provider.ContentBlockTypeCodeResult,
			Content: part.CodeExecutionResult.Output,
			Metadata: map[string]any{
				"outcome": string(part.CodeExecutionResult.Outcome),
			},
		})
	}

	// FileData (URI-based media)
	if part.FileData != nil {
		blocks = append(blocks, &provider.ContentBlock{
			Type:    provider.ContentBlockTypeImage,
			Content: "",
			Metadata: map[string]any{
				"file_uri":  part.FileData.FileURI,
				"mime_type": part.FileData.MIMEType,
			},
		})
	}

	// If we extracted nothing, check if the part actually had unhandled content
	// (vs being genuinely empty, which Gemini sometimes sends)
	if len(blocks) == 0 && !isEmptyPart(part) {
		jlog.Error("WARNING: Unhandled Gemini part type: %+v", part)
		blocks = append(blocks, &provider.ContentBlock{
			Type:    provider.ContentBlockTypeText,
			Content: "[Gemini returned an unhandled response type - please report this bug]",
		})
	}

	return blocks
}

// isEmptyPart checks if a Gemini part has no displayable content.
// Note: ThoughtSignature alone (without Text) is metadata for continuing
// thought context in subsequent requests - it's not displayable content.
func isEmptyPart(part *genai.Part) bool {
	return part.Text == "" &&
		!part.Thought &&
		part.FunctionCall == nil &&
		part.FunctionResponse == nil &&
		part.InlineData == nil &&
		part.FileData == nil &&
		part.ExecutableCode == nil &&
		part.CodeExecutionResult == nil
}

// ListModelsWithInfo returns detailed information about available models from Gemini API
func (c *Client) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	// Pass the API key via header rather than the URL query string: query-string
	// secrets get logged by HTTP intermediaries (proxies, gateway access logs,
	// browser history if the URL ever leaks). The header is the Google-
	// documented auth mechanism.
	const url = "https://generativelanguage.googleapis.com/v1beta/models"

	var result struct {
		Models []struct {
			Name                       string   `json:"name"`
			DisplayName                string   `json:"displayName"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
			InputTokenLimit            int      `json:"inputTokenLimit"`
			OutputTokenLimit           int      `json:"outputTokenLimit"`
		} `json:"models"`
	}

	if err := utils.GetJSON(ctx, url, utils.JSONGetOptions{
		Headers: map[string]string{"x-goog-api-key": c.apiKey},
		Client:  c.httpClient,
		Label:   "Gemini /models",
	}, &result); err != nil {
		return nil, fmt.Errorf("failed to list models from Gemini: %w", err)
	}

	var modelInfos []provider.ModelInfo
	for _, model := range result.Models {
		if isTextGenerationModel(model.Name, model.SupportedGenerationMethods) {
			contextWindow := model.InputTokenLimit
			if contextWindow == 0 {
				contextWindow = GetContextWindow(model.Name)
			}

			var inputModalities []string
			if SupportsImageInput(model.Name) {
				inputModalities = []string{"text", "image"}
			}

			spec := geminiThinkingSpecFor(model.Name)

			modelInfos = append(modelInfos, provider.ModelInfo{
				ID:                   model.Name,
				DisplayName:          utils.FirstNonEmpty(model.DisplayName, utils.ModelDisplayName(model.Name)),
				ContextWindow:        contextWindow,
				MaxOutputTokens:      model.OutputTokenLimit,
				FromAPI:              model.InputTokenLimit > 0,
				InputModalities:      inputModalities,
				ThinkingLevels:       spec.levels,
				DefaultThinkingLevel: spec.def,
			})
		}
	}

	return modelInfos, nil
}

// isTextGenerationModel checks if a model supports text generation
func isTextGenerationModel(modelName string, supportedMethods []string) bool {
	excludePatterns := []string{"-image", "-image-generation", "-tts", "embedding", "aqa"}
	modelNameLower := strings.ToLower(modelName)

	for _, pattern := range excludePatterns {
		if strings.Contains(modelNameLower, pattern) {
			return false
		}
	}

	textMethods := []string{"generateContent", "generateMessage", "streamGenerateContent"}
	for _, method := range supportedMethods {
		if slices.Contains(textMethods, method) {
			return true
		}
	}

	return false
}

// Info returns provider metadata
func Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:                "gemini",
		DisplayName:         "Google Gemini",
		ConfigKeyName:       "gemini_api_key",
		EnvVarName:          "GEMINI_API_KEY",
		APIKeyURL:           "https://aistudio.google.com/apikey",
		ModelContextWindows: ModelContextWindows,
		// Flash is Gemini's fast/low-cost tier for out-of-band micro-tasks.
		CheapModel: "gemini-2.5-flash",
	}
}
