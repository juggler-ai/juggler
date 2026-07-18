//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package copilot

// Copilot has NO static model list. The live catalog from
// api.githubcopilot.com/models is the only source of truth for what the account
// can actually call — a model that isn't in it is rejected at /chat/completions
// with a 400 model_not_supported. So if the catalog can't be fetched we surface
// no models at all rather than invent ones that would fail on use. These two
// constants are only numeric guards for a real, listed model whose catalog entry
// happens to omit its limits — never a stand-in for a model.
const (
	DefaultContextWindow   = 128000
	DefaultMaxOutputTokens = 16384
)
