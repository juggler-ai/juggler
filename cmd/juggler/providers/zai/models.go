//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"strconv"
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// The model *list* is never hardcoded — ListModelsWithInfo pulls it live from
// z.ai's /models endpoint, so new GLM releases appear automatically. What lives
// here is the per-model capability metadata that endpoint does NOT return: its
// objects carry only id/object/created/owned_by, no context window or output
// cap, and z.ai does not document the endpoint at all. So this is not a
// fallback for z.ai — it is the only source of limits its models will ever
// have, and the drift audit (providers/audit) is the only thing that will tell
// us it has gone stale.

// ModelContextWindows overrides DefaultContextWindow for models whose window is
// not 200K. The bulk of the modern line (glm-4.6 onward, glm-5, glm-5.1) is 200K;
// the glm-4.5 series is 128K. GLM-5.2 and GLM-5.3 carry a 1M-token window under
// their plain base ids — z.ai serves them directly over the standard coding
// endpoint, not via a special variant. (Verified on the wire: the coding endpoint
// ingested and billed 640K+ input tokens for a single glm-5.2 request. An earlier
// "glm-5.2[1m]" suffix was a phantom — z.ai 400s it as "Unknown Model" — so the 1M
// window belongs on the base id, not an opt-in variant.)
var ModelContextWindows = map[string]int{
	"glm-4.5":       128000,
	"glm-4.5-air":   128000,
	"glm-5.2":       1000000,
	"glm-5.3":       1000000,
	"glm-5.3-flash": 1000000,
	// The vision line sits below the 200K default rather than above it.
	"glm-4.6v":            128000,
	"glm-4.6v-flash":      128000,
	"glm-4.6v-flashx":     128000,
	"glm-4-32b-0414-128k": 128000,
}

// DefaultContextWindow is used for unknown models. The whole current z.ai
// catalog is 200K except the glm-4.5 series above, so a new model is far more
// likely 200K than not — the optimistic default matches reality.
const DefaultContextWindow = 200000

// DefaultMaxOutputTokens is the per-request output cap for the text line. GLM
// is a reasoning model — it spends output budget thinking before answering — so
// this sits well above a non-reasoning default to give chain-of-thought room to
// complete; an 8192 cap throttled the reasoning itself, producing empty
// `finish=length` turns.
//
// z.ai documents 128K for the GLM-5.x/4.7/4.6 line, so this is deliberately
// half the ceiling rather than all of it: 65536 is accepted by every model in
// the catalog including the older 4.5 series (96K), which keeps one number
// right for all of them and lets a newly-released model inherit a cap that
// cannot 400. A model whose real ceiling has been verified carries it in
// ModelMaxOutputTokens instead, since the endpoint publishes none.
const DefaultMaxOutputTokens = 65536

// ModelMaxOutputTokens holds the models whose ceiling is not the default.
//
// Above it: GLM-5.2 and the GLM-5.3 line, at the ceiling the coding endpoint
// enforces (verified on the wire 2026-10-22: 131072 is accepted, 131073 is
// rejected with "限制数值范围[1,131072]"). A reasoning model capped below its
// ceiling has a long chain of thought cut off before it acts, so a model whose
// real ceiling is known gets all of it.
//
// Below it: the vision line and the legacy 32B. z.ai rejects a max_tokens above
// a model's ceiling outright, so without these entries every turn on one of
// them is a 400, not a truncation.
var ModelMaxOutputTokens = map[string]int{
	"glm-5.2":       131072,
	"glm-5.3":       131072,
	"glm-5.3-flash": 131072,

	"glm-4.6v":            32000,
	"glm-4.6v-flash":      32000,
	"glm-4.6v-flashx":     32000,
	"glm-4.5v":            16000,
	"glm-4-32b-0414-128k": 16000,
}

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// inputModalities reports the input modalities a GLM model accepts. Only the
// vision line takes images, and it names itself with a "v" straight after the
// version (glm-4.6v, glm-4.6v-flash, glm-4.5v); every other model — GLM-5.3
// included — is text-only, and z.ai answers a request carrying an image with a
// 400. Declaring that is what keeps the request builder from forwarding a
// tool's image to a model that cannot take it.
func inputModalities(modelID string) []string {
	rest, found := strings.CutPrefix(strings.ToLower(modelID), "glm-")
	if !found {
		return nil
	}
	end := strings.IndexFunc(rest, func(r rune) bool {
		return r != '.' && (r < '0' || r > '9')
	})
	if end <= 0 || rest[end] != 'v' {
		return nil
	}
	if after := rest[end+1:]; after != "" && after[0] != '-' {
		return nil
	}
	return []string{"text", "image"}
}

// thinkingSpec returns a GLM model's reasoning-effort selector. z.ai accepts the
// OpenAI-shaped reasoning_effort field only on GLM-5.2 and above; older models
// (glm-5.1, glm-5, glm-4.x) reject it, so they get the zero spec and the UI
// hides the control. Those models still stream thinking — z.ai enables it by
// default — there is simply no wire knob to change the effort.
//
// Both generations advertise three behaviourally-distinct tiers, defaulting to
// max — z.ai's own default, what a GLM turn uses when no level is sent. They
// differ at the bottom of the range. GLM-5.2 accepts none, which skips thinking
// altogether. GLM-5.3 always thinks: its documented vocabulary is max/high/low
// only, and the coding endpoint answers a none request with as much reasoning as
// max (verified on the wire: low and minimal yield zero reasoning tokens, none
// yields ~1000, the same as max), so low is its floor.
//
// z.ai collapses the rest of the seven documented values server-side (medium →
// high, xhigh → max, minimal ≈ the floor). Levels are sent verbatim, so those
// aliases stay unadvertised — they would be knobs that quietly do nothing.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	major, minor, ok := glmVersion(modelID)
	switch {
	case !ok || major < 5 || (major == 5 && minor < 2):
		return openaibase.ThinkingSpec{}
	case major == 5 && minor == 2:
		return openaibase.EffortSpec("max", "none", "high", "max")
	default:
		return openaibase.EffortSpec("max", "low", "high", "max")
	}
}

// glmVersion extracts the numeric major.minor version from a GLM model id
// ("glm-5.2" → 5, 2; "glm-4.5-air" → 4, 5; "glm-5" → 5, 0). ok is false for ids
// without a "glm-" prefix or a leading numeric version.
func glmVersion(modelID string) (major, minor int, ok bool) {
	rest, found := strings.CutPrefix(strings.ToLower(modelID), "glm-")
	if !found {
		return 0, 0, false
	}
	// Keep only the leading run of digits and dots; a suffix like "-air" or
	// "-flash" ends the version.
	if end := strings.IndexFunc(rest, func(r rune) bool {
		return r != '.' && (r < '0' || r > '9')
	}); end >= 0 {
		rest = rest[:end]
	}
	parts := strings.SplitN(rest, ".", 2)
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	if len(parts) == 2 && parts[1] != "" {
		if minor, err = strconv.Atoi(parts[1]); err != nil {
			return 0, 0, false
		}
	}
	return major, minor, true
}
