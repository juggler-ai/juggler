//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"strconv"
	"strings"
)

// Gemini's /v1beta/models reports inputTokenLimit and outputTokenLimit per
// model, and ListModelsWithInfo prefers both. This file is the offline answer —
// a failed fetch, a lapsed key, an id typed by hand — and the classifiers the
// list endpoint does not answer at all.

// ModelContextWindows maps Gemini model ids to their context window sizes (in
// tokens), per Google's published model documentation. Google states these as
// an exact 1048576 rather than a rounded 1000000, and separately from the
// output limit below.
var ModelContextWindows = map[string]int{
	// Gemini 3.x — the current line.
	"gemini-3.8-flash":       1048576,
	"gemini-3.7-flash":       1048576,
	"gemini-3.6-flash":       1048576,
	"gemini-3.5-flash":       1048576,
	"gemini-3.5-flash-lite":  1048576,
	"gemini-3.1-pro-preview": 1048576,
	"gemini-3.1-flash-lite":  1048576,
	"gemini-3-flash-preview": 1048576,

	// Gemini 2.5 — still served, no shutdown announced.
	"gemini-2.5-pro":        1048576,
	"gemini-2.5-flash":      1048576,
	"gemini-2.5-flash-lite": 1048576,
}

// ModelMaxOutputTokens maps Gemini model ids to their documented output
// ceiling. Every current text model shares 65536.
//
// Without these, a listing that could not be fetched leaves the output limit
// unknown, and admission falls back to the reserve derived from the window —
// a figure sized for the window, not for what the model can write.
var ModelMaxOutputTokens = map[string]int{
	"gemini-3.8-flash":       65536,
	"gemini-3.7-flash":       65536,
	"gemini-3.6-flash":       65536,
	"gemini-3.5-flash":       65536,
	"gemini-3.5-flash-lite":  65536,
	"gemini-3.1-pro-preview": 65536,
	"gemini-3.1-flash-lite":  65536,
	"gemini-3-flash-preview": 65536,
	"gemini-2.5-pro":         65536,
	"gemini-2.5-flash":       65536,
	"gemini-2.5-flash-lite":  65536,
}

// DefaultContextWindow is the fallback context window if model is not found.
// The whole current line is 1048576 and has been for several generations, so an
// unlisted id is far likelier to be another of those than anything smaller.
const DefaultContextWindow = 1048576

// DefaultMaxOutputTokens is the fallback output ceiling for an unlisted model.
const DefaultMaxOutputTokens = 65536

// GetContextWindow returns the context window for a given model.
// Returns DefaultContextWindow if the model is not found.
func GetContextWindow(model string) int {
	if window, ok := CatalogContextWindow(model); ok {
		return window
	}
	return DefaultContextWindow
}

// CatalogContextWindow returns the offline catalogue's context window for model
// and true, or (0, false) when the catalogue has no entry for it — the
// distinction GetContextWindow collapses into DefaultContextWindow, and the one
// the models.dev drift audit asks about. Ids are normalised as the API returns
// them, collection prefix and all.
func CatalogContextWindow(model string) (int, bool) {
	window, ok := ModelContextWindows[baseModelID(model)]
	return window, ok
}

// GetMaxOutputTokens returns the documented output ceiling for a model, or
// DefaultMaxOutputTokens when it is not catalogued.
func GetMaxOutputTokens(model string) int {
	if limit, ok := ModelMaxOutputTokens[baseModelID(model)]; ok {
		return limit
	}
	return DefaultMaxOutputTokens
}

// baseModelID strips the collection prefix the API returns ids with
// ("models/gemini-3.8-flash"), so a catalog keyed on the bare id answers for
// both forms.
func baseModelID(model string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "models/")
}

// SupportsImageInput reports whether a Gemini model accepts image input.
//
// The test is the generation, not a list of name fragments. A fragment list
// answers "no" for every generation released after it was written, and this
// classifier does not merely label the model: it gates image conversion on
// every outbound turn, so a "no" strips the images off the request. Withholding
// an image the model would have read is the expensive direction of error, which
// is why an id whose version cannot be read at all is still treated as
// multimodal provided it names Gemini.
//
// Everything from 1.5 on is natively multimodal. Gemini 1.0 Pro, text-only, is
// the one below the line — long gone from the API, and kept here because
// answering "yes" for it would be a claim, not a caution.
func SupportsImageInput(model string) bool {
	id := baseModelID(model)
	if !strings.HasPrefix(id, "gemini-") {
		return false
	}
	major, minor, ok := geminiVersion(id)
	if !ok {
		return true
	}
	return major > 1 || (major == 1 && minor >= 5)
}

// geminiVersion extracts the numeric major.minor version from a Gemini model id
// ("gemini-3.8-flash" → 3, 8; "gemini-3-flash-preview" → 3, 0). ok is false for
// an id with no leading numeric version after the prefix.
func geminiVersion(id string) (major, minor int, ok bool) {
	rest, found := strings.CutPrefix(id, "gemini-")
	if !found {
		return 0, 0, false
	}
	// Keep only the leading run of digits and dots; a suffix like "-flash" or
	// "-pro-preview" ends the version.
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
