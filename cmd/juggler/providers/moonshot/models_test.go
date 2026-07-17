//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"reflect"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestRegister(t *testing.T) {
	Register()

	info, ok := provider.GetProviderInfo("moonshot")
	if !ok {
		t.Fatal("moonshot provider was not registered")
	}
	if info.DisplayName != "Moonshot Kimi" {
		t.Errorf("display name = %q, want %q", info.DisplayName, "Moonshot Kimi")
	}
	if info.ConfigKeyName != "moonshot_api_key" || info.EnvVarName != "MOONSHOT_API_KEY" {
		t.Errorf("credential metadata = (%q, %q), want independent Moonshot keys", info.ConfigKeyName, info.EnvVarName)
	}
	if got := info.ModelContextWindows["kimi-k3"]; got != 1000000 {
		t.Errorf("registered kimi-k3 context window = %d, want 1000000", got)
	}
}

func TestModelFilter(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"kimi-k3", true},
		{"KIMI-K2.5", true},
		{"moonshot-v1-128k", true},
		{"moonshot-v1-8k-vision-preview", true},
		{"moonshot-embedding-v1", false},
		{"kimi-audio-preview", false},
		{"moonshot-tts-v1", false},
		{"unrelated-chat-model", false},
	}
	for _, tc := range cases {
		if got := modelFilter(tc.model); got != tc.want {
			t.Errorf("modelFilter(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
}

func TestModelCapabilities(t *testing.T) {
	if got := contextWindowCaps.Lookup("kimi-k3"); got != 1000000 {
		t.Errorf("context window(kimi-k3) = %d, want 1000000", got)
	}
	if got := maxOutputCaps.Lookup("kimi-k3"); got != 131072 {
		t.Errorf("max output(kimi-k3) = %d, want 131072", got)
	}
	if got := contextWindowCaps.Lookup("kimi-future"); got != DefaultContextWindow {
		t.Errorf("context window(unknown) = %d, want default %d", got, DefaultContextWindow)
	}
	if got := maxOutputCaps.Lookup("kimi-future"); got != DefaultMaxOutputTokens {
		t.Errorf("max output(unknown) = %d, want default %d", got, DefaultMaxOutputTokens)
	}
}

func TestInputModalities(t *testing.T) {
	if got := inputModalities("kimi-k2.5"); !reflect.DeepEqual(got, []string{"text", "image"}) {
		t.Errorf("inputModalities(kimi-k2.5) = %v, want text and image", got)
	}
	if got := inputModalities("moonshot-v1-8k-vision-preview"); !reflect.DeepEqual(got, []string{"text", "image"}) {
		t.Errorf("inputModalities(vision model) = %v, want text and image", got)
	}
	if got := inputModalities("moonshot-v1-8k"); got != nil {
		t.Errorf("inputModalities(text model) = %v, want nil", got)
	}
}

func TestThinkingSpec(t *testing.T) {
	spec := thinkingSpec("kimi-k3")
	if !reflect.DeepEqual(spec.Levels, []string{provider.ThinkingMax}) {
		t.Errorf("kimi-k3 thinking levels = %v, want [max]", spec.Levels)
	}
	if spec.Default != provider.ThinkingMax || spec.Effort[provider.ThinkingMax] != "max" {
		t.Errorf("kimi-k3 thinking spec = %+v, want max default and mapping", spec)
	}
	if spec := thinkingSpec("kimi-k2.5"); len(spec.Levels) != 0 {
		t.Errorf("kimi-k2.5 thinking levels = %v, want none", spec.Levels)
	}
}
