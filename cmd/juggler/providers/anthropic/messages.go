//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/base64"
	"encoding/json"

	"juggler/cmd/juggler/providers/provider"
)

// APIContentBlock represents an Anthropic API content block.
// This is the standard format used by both the Anthropic API and Claude CLI.
type APIContentBlock struct {
	Type string `json:"type"` // "text", "tool_use", "tool_result", "thinking"

	// For text blocks
	Text string `json:"text,omitempty"`

	// For thinking blocks
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`

	// For tool_use blocks
	ID    string         `json:"id,omitempty"`
	Name  string         `json:"name,omitempty"`
	Input map[string]any `json:"input,omitempty"`

	// For tool_result blocks
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`

	// For image blocks
	Source *APIImageSource `json:"source,omitempty"`
}

// APIImageSource is the Anthropic `source` object for an image content block.
// Only the base64 variant is emitted: the bytes are inlined as a base64 string
// keyed by media type. Shared by the anthropic SDK path and the claudecode CLI
// stream-json path (which serializes APIContentBlock directly).
type APIImageSource struct {
	Type      string `json:"type"`       // "base64"
	MediaType string `json:"media_type"` // e.g. "image/png"
	Data      string `json:"data"`       // base64-encoded bytes
}

// MarshalJSON enforces an Anthropic API invariant: every tool_use block
// must carry an `input` object, even if empty. The Input field is tagged
// `omitempty`, which strips both nil AND empty maps — producing a
// request the API rejects with
// "messages.N.content.M.tool_use.input: Field required". The common
// trigger is a no-arg tool call.
//
// Implementation: marshal via an alias type to get default behaviour for
// every other field, then unconditionally inject `"input": {}` when the
// block is a tool_use and the marshalled form lacks it.
func (b APIContentBlock) MarshalJSON() ([]byte, error) {
	type alias APIContentBlock
	data, err := json.Marshal(alias(b))
	if err != nil {
		return nil, err
	}
	if b.Type != "tool_use" {
		return data, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if _, ok := m["input"]; !ok {
		m["input"] = json.RawMessage("{}")
		return json.Marshal(m)
	}
	return data, nil
}

// APIMessage represents an Anthropic API format message.
// Used by both the anthropic provider (via SDK) and claudecode provider (via JSON).
type APIMessage struct {
	Role    string            `json:"role"` // "user", "assistant"
	Content []APIContentBlock `json:"content"`
}

// TransformToAPIMessages converts provider.Message[] to Anthropic API format messages.
// Both this and TransformToAPIMessagesForCLI include thinking blocks with their
// signatures, preserving Claude's reasoning across conversation turns.
//
// Key behaviors:
//   - Groups consecutive same-role messages into single messages with multiple content blocks
//   - Preserves thinking block signatures for round-tripping
//   - Handles all message types: user, assistant, thinking, tool-use, tool-result, context-item, context-item-updated, system-reminder
//   - Filters out UI-only messages (error, system)
func TransformToAPIMessages(messages []provider.Message) []APIMessage {
	return transformToAPIMessagesInternal(messages)
}

// TransformToAPIMessagesForCLI converts provider.Message[] to API format for Claude CLI.
// Includes thinking blocks with their signatures for round-tripping, preserving
// Claude's reasoning across conversation turns.
func TransformToAPIMessagesForCLI(messages []provider.Message) []APIMessage {
	return transformToAPIMessagesInternal(messages)
}

// transformToAPIMessagesInternal is the shared implementation. Thinking blocks
// are included in the output, reconstructed with their signatures.
func transformToAPIMessagesInternal(messages []provider.Message) []APIMessage {
	if len(messages) == 0 {
		return nil
	}

	var result []APIMessage
	var currentBlocks []APIContentBlock
	var currentRole string

	flushBlocks := func() {
		if len(currentBlocks) > 0 {
			result = append(result, APIMessage{
				Role:    currentRole,
				Content: currentBlocks,
			})
			currentBlocks = nil
		}
	}

	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages (error, system)
		}

		// If role changes, flush accumulated blocks
		if role != currentRole && len(currentBlocks) > 0 {
			flushBlocks()
		}
		currentRole = role

		// Convert message to appropriate content block
		switch msg.Type {
		case "user":
			if msg.Content != "" {
				currentBlocks = append(currentBlocks, APIContentBlock{
					Type: "text",
					Text: msg.Content,
				})
			}
			currentBlocks = AppendImageBlocks(currentBlocks, msg.Parts)

		case "assistant":
			if msg.Content != "" {
				currentBlocks = append(currentBlocks, APIContentBlock{
					Type: "text",
					Text: msg.Content,
				})
			}

		case "thinking":
			// Reconstruct the thinking block with its signature from providerData.
			// Anthropic REQUIRES a valid signature on any thinking block passed
			// back and rejects a signatureless one (400). A thinking block
			// generated by a different provider (e.g. DeepSeek, whose reasoning
			// carries no Anthropic signature) can reach here after a
			// mid-conversation provider switch, as can reasoning stored before
			// signatures were persisted — so drop any thinking block without a
			// signature rather than 400 the turn, while still round-tripping
			// genuine signed Claude reasoning.
			sig := ""
			if msg.ProviderData != nil {
				sig, _ = msg.ProviderData["signature"].(string)
			}
			if sig == "" {
				continue
			}
			currentBlocks = append(currentBlocks, APIContentBlock{
				Type:      "thinking",
				Thinking:  msg.Content,
				Signature: sig,
			})

		case "tool-use":
			currentBlocks = append(currentBlocks, APIContentBlock{
				Type:  "tool_use",
				ID:    msg.ToolUseID,
				Name:  msg.ToolName,
				Input: msg.ToolInput,
			})

		case "tool-result":
			currentBlocks = append(currentBlocks, APIContentBlock{
				Type:      "tool_result",
				ToolUseID: msg.ToolUseID,
				Content:   msg.Content,
				IsError:   msg.IsError,
			})
			// A tool that returned images (e.g. read on a PNG) carries them as
			// image parts. Emit them as image content blocks in this same user
			// turn, right after the tool_result block — Anthropic accepts extra
			// content after tool_result blocks, and both the SDK and CLI paths map
			// these image blocks natively (transformContentBlock's image case).
			currentBlocks = AppendImageBlocks(currentBlocks, msg.Parts)

		case "context-item", "context-item-updated", "guidance", "system-reminder":
			// These are user-role messages with text content, all cacheable in
			// place: a context-item(-updated) block stands where its item stands
			// in the conversation, and guidance/system-reminder are stable once
			// written.
			if msg.Content != "" {
				currentBlocks = append(currentBlocks, APIContentBlock{
					Type: "text",
					Text: msg.Content,
				})
			}
			currentBlocks = AppendImageBlocks(currentBlocks, msg.Parts)
		}
	}

	// Flush any remaining blocks
	flushBlocks()

	// Insert empty assistant messages between consecutive user messages (Claude API requirement)
	return insertEmptyAssistantAPIMessages(result)
}

// AppendImageBlocks appends one base64 image content block per image MediaPart
// with resolved bytes. Parts whose Data is empty are skipped defensively — the
// server resolves bytes from the asset store before Submit, so an unresolved
// part means the asset was missing and is better dropped than sent malformed.
// Images attach to user-role messages only (the caller cases — user, the
// user-role context-item family, and tool-result — all map to the user role).
// The claudecode provider also uses it to nest a tool's images inside the
// tool_result it journals into a warm session file.
func AppendImageBlocks(blocks []APIContentBlock, parts []provider.MediaPart) []APIContentBlock {
	for _, part := range parts {
		if part.Type != "image" || len(part.Data) == 0 {
			continue
		}
		blocks = append(blocks, APIContentBlock{
			Type: "image",
			Source: &APIImageSource{
				Type:      "base64",
				MediaType: part.Mime,
				Data:      base64.StdEncoding.EncodeToString(part.Data),
			},
		})
	}
	return blocks
}

// insertEmptyAssistantAPIMessages inserts empty assistant messages between consecutive user messages.
// This satisfies Claude's strict user/assistant alternation requirement.
func insertEmptyAssistantAPIMessages(messages []APIMessage) []APIMessage {
	if len(messages) == 0 {
		return messages
	}

	result := make([]APIMessage, 0, len(messages)*2)
	var prevRole string

	for _, msg := range messages {
		// If we have two consecutive user messages, insert an empty assistant message
		if prevRole == "user" && msg.Role == "user" {
			result = append(result, APIMessage{
				Role: "assistant",
				Content: []APIContentBlock{{
					Type: "text",
					Text: "",
				}},
			})
		}

		result = append(result, msg)
		prevRole = msg.Role
	}

	return result
}
