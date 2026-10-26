//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"strconv"
	"strings"
)

// ModelContextWindows maps Anthropic model ids to their context window sizes
// (in tokens).
//
// This is the offline answer only. Anthropic's Models API returns
// max_input_tokens and max_tokens per model, and ListModelsWithInfo prefers
// them — so this table is what a lapsed key, a failed fetch or a hand-typed id
// resolves against, and the generation rules below cover the ids it omits.
var ModelContextWindows = map[string]int{
	// The current lineup — Fable, Mythos, Opus and Sonnet from 4.6 up — carries
	// a 1M window as both default and maximum, at standard per-token pricing,
	// so no beta header is involved. currentLineupLimits answers for the whole
	// generation, dated ids included; these entries exist so the settings model
	// list has something to show.
	"claude-fable-5-1":  1000000,
	"claude-mythos-5-1": 1000000,
	"claude-fable-5":    1000000,
	"claude-mythos-5":   1000000,
	"claude-opus-5":     1000000,
	"claude-sonnet-5":   1000000,
	"claude-opus-4-8":   1000000,
	"claude-opus-4-7":   1000000,
	"claude-opus-4-6":   1000000,
	"claude-sonnet-4-6": 1000000,

	// The 4.5 generation stayed at 200K.
	"claude-opus-4-5":   200000,
	"claude-sonnet-4-5": 200000,
	"claude-haiku-4-5":  200000,
}

// DefaultContextWindow is the fallback context window if model is not found
const DefaultContextWindow = 200000

// GetContextWindow returns the context window for a given model
// Returns DefaultContextWindow if the model is not found
func GetContextWindow(model string) int {
	if window, ok := ModelContextWindows[model]; ok {
		return window
	}
	if window, _, ok := currentLineupLimits(strings.ToLower(model)); ok {
		return window
	}
	return DefaultContextWindow
}

// currentLineupLimits returns the context window and output ceiling shared by
// the current lineup — Fable, Mythos, Opus and Sonnet — and true when the id
// names one of them. Every member publishes a 1M window and a 128k output
// ceiling, so the generation carries the limits and the family only says which
// naming this is; that is what lets a new family name (Fable, Mythos) resolve
// without being added to a list.
//
// The lineup starts at 4.6, which is where the 1M window arrived: 4.5 and below
// are 200k, and the family ladder in catalogMaxOutputTokens still answers for
// them. Matching on the generation rather than on exact ids covers both the
// dateless pinned ids used from 4.6 on and any dated variant.
//
// It deliberately does not extend to generations past 5. That asymmetry is the
// point: a model below the floor is merely sized conservatively, while an
// output ceiling guessed too high for a model nobody has seen is a hard 400 on
// every request it ever makes. So the ceiling moves up only when a released
// generation is known to carry it, and an unrecognised one falls through to
// defaultMaxOutputTokens.
func currentLineupLimits(m string) (contextWindow, maxOutput int, ok bool) {
	major, minor, hasVersion := claudeVersion(m)
	inLineup := major == 5 || (major == 4 && minor >= 6)
	if !hasVersion || !inLineup {
		return 0, 0, false
	}
	for _, family := range []string{"fable", "mythos", "opus", "sonnet"} {
		if strings.Contains(m, family) {
			return 1000000, 128000, true
		}
	}
	return 0, 0, false
}

// CatalogKnows reports whether the offline catalogue recognises model — by
// exact id, or by the generation rules catalogMaxOutputTokens applies — rather
// than answering it with defaults. The models.dev drift audit asks it to tell
// a model the rules already cover from one they have never heard of.
func CatalogKnows(model string) bool {
	if _, ok := ModelContextWindows[model]; ok {
		return true
	}
	_, ok := catalogMaxOutputTokens(model)
	return ok
}

// GetMaxOutputTokens returns the maximum number of output tokens a model can
// emit in a single response — the value to send as the request's max_tokens.
// Anthropic rejects max_tokens above a model's ceiling (a hard 400) and silently
// truncates at it otherwise, so this must be per-model rather than a fixed cap.
//
// Detection is by substring rather than exact map lookup because the Models API
// hands back dated ids (claude-sonnet-4-5-20250929) that an exact map would miss,
// and because the catalog uses two naming orders (claude-sonnet-4.5 and
// claude-4.5-sonnet). Order matters: the most specific generations are checked
// first, since "claude-3-5-sonnet" also contains "claude-3".
//
// Ceilings (Anthropic docs): generation 5 (Fable, Mythos, Opus, Sonnet) →
// 128000; Opus 4.x → 32000; Sonnet/Haiku 4.x and Sonnet 3.7 → 64000;
// Sonnet/Haiku 3.5 → 8192; Claude 3 (non-3.5) → 4096. Unknown/future ids fall
// back to defaultMaxOutputTokens, which is at or below every known model's
// ceiling so an unrecognised id can never produce a max_tokens 400.
//
// This is the offline answer. ListModelsWithInfo prefers the per-model max_tokens
// the Models API returns, so this ladder is consulted for a failed model fetch,
// a lapsed key, or an id typed by hand.
func GetMaxOutputTokens(model string) int {
	if value, known := catalogMaxOutputTokens(model); known {
		return value
	}
	return defaultMaxOutputTokens
}

// catalogMaxOutputTokens returns the per-model output ceiling and true when the
// static catalog recognises the model's generation, or (0, false) for ids it
// does not know (live-list-only or future models). It exists so callers can
// distinguish a genuinely-known 8192 ceiling (Claude 3.5) from an unknown id
// that merely defaults to 8192 — GetMaxOutputTokens collapses both, but the
// wire clamp in buildMessageParams must only override the capability snapshot
// when the catalog actually knows the model.
func catalogMaxOutputTokens(model string) (int, bool) {
	m := strings.ToLower(model)

	// Generation 5 shares one ceiling across every family, so it is checked
	// ahead of the family ladder below — "claude-opus-5" also contains "opus".
	if _, maxOutput, ok := currentLineupLimits(m); ok {
		return maxOutput, true
	}

	isOpus := strings.Contains(m, "opus")
	isSonnet := strings.Contains(m, "sonnet")
	isHaiku := strings.Contains(m, "haiku")

	// Generation 4 appears either family-first ("sonnet-4", "sonnet-4.5",
	// "sonnet-4-5", "opus-4-1") or version-first in the short aliases
	// ("4-sonnet", "4.5-sonnet").
	gen4 := func(family string) bool {
		return strings.Contains(m, family+"-4") ||
			strings.Contains(m, "4-"+family) ||
			strings.Contains(m, "4.0-"+family) ||
			strings.Contains(m, "4.1-"+family) ||
			strings.Contains(m, "4.5-"+family)
	}

	switch {
	case isOpus && gen4("opus"):
		return 32000, true
	case isSonnet && gen4("sonnet"):
		return 64000, true
	case isHaiku && gen4("haiku"):
		return 64000, true
	case strings.Contains(m, "3-7-sonnet") || strings.Contains(m, "claude-3.7"):
		return 64000, true
	case strings.Contains(m, "3-5-") || strings.Contains(m, "claude-3.5"):
		return 8192, true
	case strings.Contains(m, "claude-3"):
		return 4096, true
	default:
		return 0, false
	}
}

// SupportsThinking reports whether an Anthropic model supports a reasoning
// control — the manual budget on 3.7 through 4.5, adaptive thinking steered by
// effort from 4.6 on. Claude 3.7 Sonnet and everything from generation 4 up
// qualify; the original Claude 3 and Claude 3.5 models do not.
//
// The test is the generation rather than a list of family names: a family-keyed
// list answers "no" for any family it does not name, and Anthropic ships new
// families (Fable, Mythos) as well as new generations. claudeVersion reads the
// generation out of both id orders and both separators, so a family it has
// never seen needs nothing here.
//
// An id naming no generation at all stays false. Being wrong in that direction
// only withholds a control; the opposite direction would offer one the model
// rejects.
//
// This is the offline answer. ListModelsWithInfo prefers the per-model
// thinking capability the Models API returns.
func SupportsThinking(model string) bool {
	major, minor, ok := claudeVersion(model)
	switch {
	case !ok:
		return false
	case major >= 4:
		return true
	default:
		return major == 3 && minor >= 7
	}
}

// supportsForcedToolChoice reports whether a model accepts a tool_choice that
// compels a call — type "tool" or "any". The models whose thinking is always on
// reject both with a 400, because a forced call would skip thinking they offer
// no way to disable and the model would write its working-out into the tool
// arguments instead. tool_choice "auto" and "none" stay accepted everywhere,
// which is what keeps compaction's disabled-tools probe legal.
//
// That is the Fable and Mythos lineage from 5.1 on. Fable 5 and Mythos 5 accept
// a forced choice, so the test is the version and not the family alone; from 5.1
// the restriction travels with the lineage, which is why a later generation of
// it keeps the answer rather than aging out of it.
func supportsForcedToolChoice(model string) bool {
	major, minor, ok := claudeVersion(model)
	if !ok || major < 5 || (major == 5 && minor < 1) {
		return true
	}
	m := strings.ToLower(model)
	return !strings.Contains(m, "fable") && !strings.Contains(m, "mythos")
}

// thinkingAlwaysOn reports whether a model thinks on every turn with no way to
// turn it off: it rejects both thinking.type "disabled" and the manual
// "enabled" form, leaving effort as the only control over how deeply it thinks.
//
// That is the Fable and Mythos lineage, at every version. It is the cause behind
// two separate rules — a prefill has nowhere to go when thinking opens the turn,
// and omitting the thinking config cannot mean "no thinking" — so both read it
// rather than repeat the test.
func thinkingAlwaysOn(model string) bool {
	m := strings.ToLower(model)
	return strings.Contains(m, "fable") || strings.Contains(m, "mythos")
}

// supportsAssistantPrefill reports whether a model accepts a request whose last
// message is an assistant turn — a prefill, asking the model to continue that
// message rather than answer it. A model that always thinks rejects one with a
// 400: thinking opens the turn, and a prefill leaves nowhere for it to go.
//
// Being wrong toward "unsupported" costs a two-token user turn; being wrong
// toward "supported" is a 400 on every continuation, so anything unattested
// stays supported and is corrected by evidence rather than by guess.
func supportsAssistantPrefill(model string) bool {
	return !thinkingAlwaysOn(model)
}

// thinkingMode names the wire form a model accepts for extended thinking. The
// zero value is the adaptive form, which is what an unrecognised id gets — see
// thinkingModeForModel for why that direction is the safe one.
type thinkingMode int

const (
	// thinkingAdaptive is thinking.type "adaptive", steered by
	// output_config.effort. Generation 4.6 and later.
	thinkingAdaptive thinkingMode = iota
	// thinkingLegacy is thinking.type "enabled" with an explicit budget_tokens.
	// Generation 4.5 and earlier.
	thinkingLegacy
)

// thinkingModeForModel reports which thinking wire form a model accepts.
// Anthropic split the API at generation 4.6: 4.5 and earlier accept only the
// manual form (thinking.type "enabled" with budget_tokens) and reject
// "adaptive" with a 400, while 4.7 and later accept only "adaptive" and reject
// "enabled" with a 400. Generation 4.6 accepts both and documents "enabled" as
// deprecated, so it takes the adaptive path along with everything newer.
//
// An id carrying no recognisable generation falls to adaptive. The set of models
// needing the manual form is closed — it ends at 4.5, and Anthropic adds only
// newer models — while ids keep arriving from the live Models API, so an
// unrecognised id is far likelier to be newer than older. Defaulting the other
// way would hand every future model the 400 this mapping exists to avoid.
//
// Callers reach this only for models SupportsThinking already accepts; models
// with no thinking at all never consult it.
func thinkingModeForModel(model string) thinkingMode {
	major, minor, ok := claudeVersion(model)
	switch {
	case !ok:
		return thinkingAdaptive
	case major > 4, major == 4 && minor >= 6:
		return thinkingAdaptive
	default:
		return thinkingLegacy
	}
}

// claudeVersion extracts the numeric major.minor generation from an Anthropic
// model id ("claude-sonnet-4-5-20250929" → 4, 5; "claude-opus-4-6" → 4, 6;
// "claude-3-7-sonnet-20250219" → 3, 7; "claude-sonnet-5" → 5, 0). Ids name the
// generation either family-first ("sonnet-4-5") or version-first ("3-7-sonnet"),
// separated by dashes or by a dot ("claude-4.5-sonnet"), so the first numeric
// token is the major and a numeric token immediately after it is the minor.
// A run of more than two digits is a release date rather than a version, and is
// skipped. ok is false for ids naming no generation at all
// ("claude-mythos-preview").
func claudeVersion(model string) (major, minor int, ok bool) {
	tokens := strings.Split(strings.ToLower(model), "-")
	for i, token := range tokens {
		head, tail, dotted := strings.Cut(token, ".")
		value, isVersion := versionNumber(head)
		if !isVersion {
			continue
		}
		major = value
		// A dotted token carries both parts ("4.5"); a bare one carries the
		// major, with any minor in the token that follows ("4", "5").
		if dotted {
			minor, _ = versionNumber(tail)
			return major, minor, true
		}
		if i+1 < len(tokens) {
			if next, isMinor := versionNumber(tokens[i+1]); isMinor {
				minor = next
			}
		}
		return major, minor, true
	}
	return 0, 0, false
}

// versionNumber parses one version component. Components are one or two digits;
// a longer run of digits is a release date (20250929), never a version.
func versionNumber(token string) (int, bool) {
	if token == "" || len(token) > 2 {
		return 0, false
	}
	value, err := strconv.Atoi(token)
	if err != nil {
		return 0, false
	}
	return value, true
}

// SupportsImageInput reports whether an Anthropic model accepts image input.
// Every model from Claude 3 on is multimodal; the older text-only models
// (Claude 2, instant) are not in our catalog. Keyed on the generation for the
// same reason as SupportsThinking — a family-keyed list answers "no" for a
// family it has not been told about.
//
// This is the offline answer. ListModelsWithInfo prefers the per-model
// image_input capability the Models API returns.
func SupportsImageInput(model string) bool {
	major, _, ok := claudeVersion(model)
	return ok && major >= 3
}
