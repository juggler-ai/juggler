//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import (
	"regexp"
	"strings"

	"juggler/cmd/juggler/providers/utils"
)

// OpenAI's /v1/models returns id, object, created and owned_by — four fields,
// no limits — so there is nothing for endpoint discovery to read here and this
// table is the only thing that sizes an OpenAI model. An id missing from it
// runs at DefaultContextWindow, which is not a visible failure: the model works
// and compacts a conversation long before it had to.

// ModelContextWindows maps OpenAI model ids to their context window sizes (in
// tokens). Source: developers.openai.com model pages.
var ModelContextWindows = map[string]int{
	// GPT-6 Series (1.05M total: 922K input + 128K output)
	"gpt-6-astra":   1050000,
	"gpt-6.1-sol":   1050000,
	"gpt-6.1-terra": 1050000,
	"gpt-6-sol":     1050000,
	"gpt-6-luna":    1050000,

	// Daybreak aliases: Blue has the GPT-6 window, Red the 400K one.
	"gpt-daybreak-blue-latest": 1050000,
	"gpt-daybreak-red-latest":  400000,

	// GPT-5.6 Series (1.05M total: 922K input + 128K output). The bare
	// "gpt-5.6" is an alias that routes to Sol.
	"gpt-5.6":       1050000,
	"gpt-5.6-sol":   1050000,
	"gpt-5.6-terra": 1050000,
	"gpt-5.6-luna":  1050000,
	"gpt-5.6-cyber": 400000,

	// GPT-5.4 / 5.5 Series (1.05M total; the mini and nano are 400K)
	"gpt-5.5":      1050000,
	"gpt-5.5-pro":  1050000,
	"gpt-5.4":      1050000,
	"gpt-5.4-pro":  1050000,
	"gpt-5.4-mini": 400000,
	"gpt-5.4-nano": 400000,

	// GPT-5.1 / 5.2 / 5.3 Series. Codex Spark is the small, fast one: 128K.
	"gpt-5.3-codex":       400000,
	"gpt-5.3-codex-spark": 128000,
	"gpt-5.2":             400000,
	"gpt-5.2-pro":         400000,
	"gpt-5.2-codex":       400000,
	"gpt-5.1":             400000,

	// GPT-5 Series (272K input + 128K output)
	"gpt-5":      400000,
	"gpt-5-mini": 400000,
	"gpt-5-nano": 400000,
	"gpt-5-pro":  400000,

	// Codex variants. OpenAI's deprecation page lists these as shut down while
	// /v1/models still returns them, so they remain selectable — and a
	// selectable model has to be sized.
	"gpt-5-codex":        400000,
	"gpt-5.1-codex":      400000,
	"gpt-5.1-codex-mini": 400000,
	"gpt-5.1-codex-max":  400000,

	// The ChatGPT-tuned snapshots, likewise still listed.
	"chat-latest":         400000,
	"gpt-5-chat-latest":   400000,
	"gpt-5.1-chat-latest": 400000,
	"gpt-5.2-chat-latest": 400000,
	"gpt-5.3-chat-latest": 400000,

	// GPT-4.1 Series. 1047576 is the published figure — not the 1048576 the
	// power of two would suggest.
	"gpt-4.1":      1047576,
	"gpt-4.1-mini": 1047576,
	"gpt-4.1-nano": 1047576,

	// GPT-4o Series
	"gpt-4o":      128000,
	"gpt-4o-mini": 128000,

	// GPT-4 Turbo
	"gpt-4-turbo": 128000,

	// GPT-4. The 0613 snapshot predates the YYYY-MM-DD naming, so it needs its
	// own entry rather than resolving through the alias.
	"gpt-4":      8192,
	"gpt-4-0613": 8192,

	// GPT-3.5. Small windows, and the ones that matter most to get right: the
	// 128000 default would be an over-promise here, not an under-count, and an
	// over-promise fails the request outright rather than compacting early.
	"gpt-3.5-turbo":      16385,
	"gpt-3.5-turbo-16k":  16385,
	"gpt-3.5-turbo-0125": 16385,
	"gpt-3.5-turbo-1106": 16385,

	// o-Series reasoning models
	"o4-mini": 200000,
	"o3":      200000,
	"o3-pro":  200000,
	"o3-mini": 200000,
	"o1":      200000,
	"o1-pro":  200000,
}

// ModelMaxOutputTokens maps OpenAI model ids to their max output tokens. This
// rides every Chat Completions request as max_tokens, so a value above a
// model's real ceiling is a hard 400 and one below it silently truncates.
var ModelMaxOutputTokens = map[string]int{
	// The whole modern line shares a 128000 output ceiling.
	"gpt-6-astra":   128000,
	"gpt-6.1-sol":   128000,
	"gpt-6.1-terra": 128000,
	"gpt-6-sol":     128000,
	"gpt-6-luna":    128000,

	"gpt-daybreak-blue-latest": 128000,
	"gpt-daybreak-red-latest":  128000,
	"gpt-5.6":                  128000,
	"gpt-5.6-sol":              128000,
	"gpt-5.6-terra":            128000,
	"gpt-5.6-luna":             128000,
	"gpt-5.6-cyber":            128000,
	"gpt-5.5":                  128000,
	"gpt-5.5-pro":              128000,
	"gpt-5.4":                  128000,
	"gpt-5.4-pro":              128000,
	"gpt-5.4-mini":             128000,
	"gpt-5.4-nano":             128000,
	"gpt-5.3-codex":            128000,
	"gpt-5.2":                  128000,
	"gpt-5.2-pro":              128000,
	"gpt-5.2-codex":            128000,
	"gpt-5.1":                  128000,

	// Codex Spark's ceiling is a quarter of its window, below the line's.
	"gpt-5.3-codex-spark": 32000,
	"gpt-5":               128000,
	"gpt-5-mini":          128000,
	"gpt-5-nano":          128000,

	"gpt-5-codex":        128000,
	"gpt-5.1-codex":      128000,
	"gpt-5.1-codex-mini": 128000,
	"gpt-5.1-codex-max":  128000,

	"chat-latest":         128000,
	"gpt-5-chat-latest":   128000,
	"gpt-5.1-chat-latest": 128000,
	"gpt-5.2-chat-latest": 128000,
	"gpt-5.3-chat-latest": 128000,

	// gpt-5-pro is the exception: more than double the line's ceiling, and
	// two thirds of its own window.
	"gpt-5-pro": 272000,

	// GPT-4.1 Series
	"gpt-4.1":      32768,
	"gpt-4.1-mini": 32768,
	"gpt-4.1-nano": 32768,

	// GPT-4o Series
	"gpt-4o":      16384,
	"gpt-4o-mini": 16384,

	// GPT-4 Turbo
	"gpt-4-turbo": 4096,

	// GPT-4. The documented 8192 output ceiling is the whole window: input and
	// output share it, so a request asking for all of it has nowhere to put the
	// prompt. Half the window is the largest cap that is always answerable.
	"gpt-4":      4096,
	"gpt-4-0613": 4096,

	// GPT-3.5
	"gpt-3.5-turbo":      4096,
	"gpt-3.5-turbo-16k":  4096,
	"gpt-3.5-turbo-0125": 4096,
	"gpt-3.5-turbo-1106": 4096,

	// o-Series reasoning models
	"o4-mini": 100000,
	"o3":      100000,
	"o3-pro":  100000,
	"o3-mini": 100000,
	"o1":      100000,
	"o1-pro":  100000,
}

// DefaultContextWindow is used for unknown models
const DefaultContextWindow = 128000

// DefaultMaxOutputTokens is used for unknown models
const DefaultMaxOutputTokens = 16384

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
//
// Both resolve a dated snapshot through its undated alias. OpenAI lists the two
// side by side — "gpt-5.4" and "gpt-5.4-2026-03-05" are the same model, and the
// picker offers both — so without that, choosing the dated one silently sized
// it at the 128000 default.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows, Normalize: snapshotBaseID}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens, Normalize: snapshotBaseID}
)

// snapshotDateSuffix matches the trailing release date on a pinned OpenAI model
// id, e.g. the "-2026-03-05" of "gpt-5.4-2026-03-05".
var snapshotDateSuffix = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)

// snapshotBaseID strips a dated snapshot suffix, returning the undated alias
// the catalog is keyed by. An id without one is returned unchanged.
func snapshotBaseID(model string) string {
	return snapshotDateSuffix.ReplaceAllString(model, "")
}

// isChatModel admits the models a conversation can actually be held with, and
// drops everything else OpenAI's /v1/models returns.
//
// That endpoint lists the whole platform — image generation, video, speech,
// transcription, realtime audio, embeddings, moderation — and none of it can
// answer a chat completion. Unfiltered, they reach the model picker as
// selectable choices, each sized by the 128000 default because no catalog will
// ever have an entry for a video model's context window.
func isChatModel(modelID string) bool {
	id := strings.ToLower(modelID)

	named := strings.HasPrefix(id, "gpt-") || strings.HasPrefix(id, "chatgpt-") ||
		strings.HasPrefix(id, "chat-") || strings.HasPrefix(id, "o1") ||
		strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4")
	if !named {
		return false
	}
	// Markers of a non-chat modality or endpoint. "search" covers the
	// *-search-api and *-search-preview models, which are a retrieval product
	// rather than a chat model.
	for _, marker := range []string{
		"image", "audio", "realtime", "transcribe", "tts", "whisper",
		"embedding", "moderation", "search", "sora", "dall-e", "live",
		// gpt-3.5-turbo-instruct answers the legacy completions endpoint, not
		// chat.
		"instruct",
	} {
		if strings.Contains(id, marker) {
			return false
		}
	}
	return true
}
