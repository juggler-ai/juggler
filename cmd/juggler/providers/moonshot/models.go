//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// The API model catalog supplies model ids but not reliable context/output
// metadata, so keep documented capability overrides here while discovering the
// actual list live. Unknown future Kimi models receive conservative defaults.
const (
	DefaultContextWindow   = 128000
	DefaultMaxOutputTokens = 32768
)

var ModelContextWindows = map[string]int{
	"kimi-k3":                         1000000,
	"kimi-k2.7-code":                  256000,
	"kimi-k2.7-code-highspeed":        256000,
	"kimi-k2.6":                       256000,
	"kimi-k2.5":                       256000,
	"moonshot-v1-8k":                  8000,
	"moonshot-v1-32k":                 32000,
	"moonshot-v1-128k":                128000,
	"moonshot-v1-8k-vision-preview":   8000,
	"moonshot-v1-32k-vision-preview":  32000,
	"moonshot-v1-128k-vision-preview": 128000,
}

// K3's documented default output allowance is 131072 tokens. K2.7/K2.6/K2.5
// default to 32768. Legacy Moonshot V1 limits include input and output in the
// named context window, so cap their generated output conservatively.
var ModelMaxOutputTokens = map[string]int{
	"kimi-k3":                         131072,
	"moonshot-v1-8k":                  8000,
	"moonshot-v1-32k":                 32000,
	"moonshot-v1-128k":                32768,
	"moonshot-v1-8k-vision-preview":   8000,
	"moonshot-v1-32k-vision-preview":  32000,
	"moonshot-v1-128k-vision-preview": 32768,
}

var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// modelFilter keeps chat-capable Kimi/Moonshot models while excluding obvious
// embedding/audio endpoints should they appear in the account catalog.
func modelFilter(modelID string) bool {
	id := strings.ToLower(modelID)
	if !strings.HasPrefix(id, "kimi-") && !strings.HasPrefix(id, "moonshot-") {
		return false
	}
	for _, marker := range []string{"embedding", "tts", "audio"} {
		if strings.Contains(id, marker) {
			return false
		}
	}
	return true
}

func inputModalities(modelID string) []string {
	id := strings.ToLower(modelID)
	if strings.HasPrefix(id, "kimi-k3") ||
		strings.HasPrefix(id, "kimi-k2.7-code") ||
		strings.HasPrefix(id, "kimi-k2.6") ||
		strings.HasPrefix(id, "kimi-k2.5") ||
		strings.Contains(id, "vision") {
		return []string{"text", "image"}
	}
	return nil
}

// K3 accepts OpenAI-compatible reasoning_effort, currently only "max". K2.x
// models use Moonshot's separate `thinking` object, so leave their selector
// hidden and rely on the provider default rather than sending an invalid field.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	if strings.HasPrefix(strings.ToLower(modelID), "kimi-k3") {
		return openaibase.ThinkingSpec{
			Levels:  []string{provider.ThinkingMax},
			Default: provider.ThinkingMax,
			Effort: map[string]string{
				provider.ThinkingMax: "max",
			},
		}
	}
	return openaibase.ThinkingSpec{}
}
