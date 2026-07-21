//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "encoding/json"

// ToolDefinition represents a tool that the LLM can use
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`       // Raw JSON schema
	Category    string          `json:"category,omitempty"` // Tool category: "read", "write", "meta"
}

// ModelConfig represents LLM provider and model configuration: a concrete
// (Provider, Model) pair.
type ModelConfig struct {
	Provider string `json:"provider"`           // LLM provider name (e.g., "anthropic", "openai")
	Model    string `json:"model"`              // LLM model name (e.g., "claude-sonnet-4-20250514")
	Thinking string `json:"thinking,omitempty"` // Canonical thinking level ("off"/"low"/"medium"/"high"/"max"); empty ⇒ provider default
}

// ShellStartRequest represents a request to start a streaming shell command
type ShellStartRequest struct {
	Type           string `json:"type"`                     // "shell-start"
	ShellID        string `json:"shellId"`                  // Unique ID for this shell execution
	Command        string `json:"command"`                  // Shell command to execute
	Cwd            string `json:"cwd,omitempty"`            // Working directory
	Timeout        int    `json:"timeout,omitempty"`        // Timeout in milliseconds
	ConversationID string `json:"conversationId,omitempty"` // Owning conversation, so the shell runs in that conversation's bound workspace. Empty ⇒ project root.
}

// ShellCancelRequest represents a request to cancel a running shell command
type ShellCancelRequest struct {
	Type    string `json:"type"`    // "shell-cancel"
	ShellID string `json:"shellId"` // ID of shell to cancel
}

// GenericWSMessage is used to determine message type before parsing
type GenericWSMessage struct {
	Type string `json:"type,omitempty"`
}
