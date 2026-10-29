//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"slices"
	"sort"
	"strings"

	"juggler/cmd/juggler/providers/modelsdev"
)

// openAICompatibleNPM is the AI SDK package models.dev records for a provider
// reached over the OpenAI Chat Completions API — the only protocol a custom
// endpoint speaks. models.dev requires such a provider to state its base URL,
// so every one carries the field a lookup needs.
const openAICompatibleNPM = "@ai-sdk/openai-compatible"

// upstreamProvider and upstreamModel are the slice of models.dev's api.json
// that trim reads. Everything else in it is ignored.
type upstreamProvider struct {
	Name   string                   `json:"name"`
	NPM    string                   `json:"npm"`
	API    string                   `json:"api"`
	Doc    string                   `json:"doc"`
	Models map[string]upstreamModel `json:"models"`
}

type upstreamModel struct {
	Limit struct {
		Context int `json:"context"`
		Output  int `json:"output"`
	} `json:"limit"`
	Modalities struct {
		Input []string `json:"input"`
	} `json:"modalities"`
}

// trim reduces models.dev's api.json to a Snapshot. It keeps a provider only
// if a custom endpoint could be pointed at it and recognised by its base URL:
//
//   - it speaks the OpenAI-compatible API;
//   - its base URL is a literal one. Some are templates the user completes
//     (an account id, a region), which can never equal what they type;
//   - its base URL is not on this machine or a private network. Those entries
//     describe a local server's typical port, and matching on it would size
//     whatever the user happens to run there by somebody else's model.
//
// A model is kept only when its context window is known, since that is the
// figure it is looked up for. Its input modalities are sorted and
// de-duplicated, and left empty when they say text and nothing else, as
// modelsdev.Model stores that case.
func trim(apiJSON []byte, source, fetched string) (modelsdev.Snapshot, error) {
	var upstream map[string]upstreamProvider
	if err := json.Unmarshal(apiJSON, &upstream); err != nil {
		return modelsdev.Snapshot{}, fmt.Errorf("decoding models.dev catalogue: %w", err)
	}
	out := modelsdev.Snapshot{Source: source, Fetched: fetched, Providers: make(map[string]modelsdev.Provider)}
	for id, up := range upstream {
		if up.NPM != openAICompatibleNPM || !matchableBaseURL(up.API) {
			continue
		}
		p := modelsdev.Provider{Name: up.Name, API: up.API, Doc: up.Doc, Models: make(map[string]modelsdev.Model)}
		for mid, um := range up.Models {
			if um.Limit.Context <= 0 {
				continue
			}
			m := modelsdev.Model{Context: um.Limit.Context, Output: max(um.Limit.Output, 0)}
			input := slices.Clone(um.Modalities.Input)
			sort.Strings(input)
			input = slices.Compact(input)
			if len(input) > 0 && !slices.Equal(input, []string{"text"}) {
				m.Input = input
			}
			p.Models[mid] = m
		}
		if len(p.Models) > 0 {
			out.Providers[id] = p
		}
	}
	if len(out.Providers) == 0 {
		return modelsdev.Snapshot{}, fmt.Errorf("models.dev catalogue held no OpenAI-compatible provider; refusing to write an empty snapshot")
	}
	return out, nil
}

// matchableBaseURL reports whether raw is a literal, public base URL.
func matchableBaseURL(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, "${}") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) {
		return false
	}
	return true
}
