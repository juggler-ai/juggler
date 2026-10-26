//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

// ModelCaps resolves a per-model integer capability — a context window or a
// max-output-tokens cap — from an exact-id override map over a single default.
//
// Every OpenAI-compatible provider with a fixed model catalog (openai, zai,
// deepseek, etc.) resolves both dimensions through it, so a new reasoning model
// is one map entry and no provider can silently fall out of step (e.g. raising
// the default in one place but forgetting the override map).
type ModelCaps struct {
	Default   int
	Overrides map[string]int
	// Normalize optionally maps a provider-reported model id onto the key the
	// Overrides map uses, for a vendor that serves the same model under more
	// than one id. OpenAI is the case: it lists both "gpt-5.4" and the dated
	// snapshot "gpt-5.4-2026-03-05", and both are selectable — so without this
	// the snapshot is a different, uncatalogued model that silently runs on the
	// provider default. Nil means the id is the key.
	Normalize func(model string) string
	// Fallback is a second catalogue, asked about a model the Overrides do not
	// name, with the id exactly as the provider reported it. A positive figure
	// it returns is knowledge about that model, as an override is; anything
	// else falls through to Default. Custom endpoints use it to consult the
	// models.dev snapshot. Nil means no second catalogue.
	Fallback func(model string) (int, bool)
}

// key returns the Overrides key for a model id, applying Normalize when set.
// An id that is already a key is left alone: normalisation only ever supplies a
// second way in, never overrides an exact entry.
func (c ModelCaps) key(model string) string {
	if c.Normalize == nil {
		return model
	}
	if _, exact := c.Overrides[model]; exact {
		return model
	}
	return c.Normalize(model)
}

// Lookup returns the override for model if present, else the Fallback's
// figure, else Default.
func (c ModelCaps) Lookup(model string) int {
	if v, ok := c.LookupKnown(model); ok {
		return v
	}
	return c.Default
}

// LookupKnown reports whether model has an explicit catalog entry — an
// override, or a figure from the Fallback — returning it. Unlike Lookup,
// Default is not a match: defaults exist to enrich provider-reported model ids
// (e.g. a newly released model on a live list), never to vouch for an id the
// provider itself never catalogued — those must fail closed rather than
// inherit a fabricated limit.
func (c ModelCaps) LookupKnown(model string) (int, bool) {
	if c.Overrides != nil {
		if v, ok := c.Overrides[c.key(model)]; ok {
			return v, true
		}
	}
	if c.Fallback != nil {
		if v, ok := c.Fallback(model); ok && v > 0 {
			return v, true
		}
	}
	return 0, false
}
