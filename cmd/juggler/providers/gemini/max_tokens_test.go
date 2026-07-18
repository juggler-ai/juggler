//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"math"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestNewClientRejectsMaxOutputTokensAboveInt32(t *testing.T) {
	_, err := NewClient(provider.Config{
		APIKey: "test",
		Model:  "gemini-test",
		ModelCapabilities: provider.ModelCapabilities{
			MaxOutputTokens: int64(math.MaxInt32) + 1,
		},
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds Gemini limit") {
		t.Fatalf("NewClient error = %v, want Gemini max-output limit error", err)
	}
}

func TestPrepareRequestUsesAdmissionMaxOutputTokens(t *testing.T) {
	c := &Client{model: "gemini-test", maxOutputTokens: 12345}
	config, _, err := c.prepareRequest(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("prepareRequest: %v", err)
	}
	if config.MaxOutputTokens != 12345 {
		t.Fatalf("MaxOutputTokens = %d, want 12345", config.MaxOutputTokens)
	}
}

func TestPrepareRequestLeavesMaxOutputTokensUnsetWithoutCapability(t *testing.T) {
	c := &Client{model: "gemini-test"}
	config, _, err := c.prepareRequest(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("prepareRequest: %v", err)
	}
	if config.MaxOutputTokens != 0 {
		t.Fatalf("MaxOutputTokens = %d, want API default 0", config.MaxOutputTokens)
	}
}
