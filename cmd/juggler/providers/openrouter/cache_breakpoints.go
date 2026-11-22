//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import "strings"

// cacheBreakpoints is the descriptor's CacheBreakpointsFn. Claude caches
// nothing unless the request carries cache_control, which OpenRouter relays to
// every upstream serving it (Anthropic, Bedrock, Vertex)
// (https://openrouter.ai/docs/guides/best-practices/prompt-caching). The other
// vendors it routes to cache prefixes on their own. A "~" prefix is one of
// OpenRouter's latest-version aliases (~anthropic/claude-sonnet-latest).
func cacheBreakpoints(modelID string) bool {
	vendor, _, _ := strings.Cut(strings.TrimPrefix(strings.ToLower(modelID), "~"), "/")
	return vendor == "anthropic"
}
