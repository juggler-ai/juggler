//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	provider "juggler/cmd/juggler/providers/registry"
)

// providerName is the registry id for the ACP provider.
const providerName = "acp"

// Register adds the ACP provider to the global registry. Called once at startup
// from registerProviders (app/run.go), alongside every other built-in provider.
// Agents are configured in acp.json via the settings-panel "ACP agents" tab
// (see ops.go / RegisterOps). AutoDetect gates the provider's first-startup
// visibility: with no agent configured it reports unavailable, so a default
// install shows nothing in the model picker. That check is a one-time snapshot
// (the registry memoises AutoDetect under sync.Once), so it does NOT notice an
// agent added mid-session — the settings tab enables the provider directly on
// save (ensureAcpProviderEnabled) to surface it without a restart.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}

// Info returns the provider metadata surfaced in settings and the model picker.
func Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:        providerName,
		DisplayName: "ACP Agents",
		Description: "Drives external Agent Client Protocol (ACP) agents over stdio (e.g. Gemini CLI, Zed agents). Add agents in the \"ACP agents\" settings tab; each appears as a model.",
		AuthType:    provider.AuthTypeToggle,
		AutoDetect:  anyAgentConfigured,
		// ACP agents are black boxes: the protocol carries no context-window or
		// output-limit metadata, and each agent's own backend enforces its
		// limits. Without this, fail-closed admission would reject every ACP
		// turn with UnknownContextLimitError.
		AllowUnknownLimits: true,
	}
}
