//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package modelsdev

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"slices"
	"sort"
	"strings"
)

// openAICompatibleNPM is the AI SDK package models.dev records for a provider
// reached over the OpenAI Chat Completions API — the only protocol a custom
// endpoint speaks. models.dev requires such a provider to state its base URL,
// so every one carries the field a lookup needs.
const openAICompatibleNPM = "@ai-sdk/openai-compatible"

// upstreamProvider and upstreamModel are the slice of models.dev's api.json
// that Trim reads. Everything else in it is ignored.
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

// Trim reduces models.dev's api.json to a Snapshot. It keeps a provider only
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
// figure it is looked up for.
func Trim(apiJSON []byte, source, fetched string) (Snapshot, error) {
	var upstream map[string]upstreamProvider
	if err := json.Unmarshal(apiJSON, &upstream); err != nil {
		return Snapshot{}, fmt.Errorf("decoding models.dev catalogue: %w", err)
	}
	out := Snapshot{Source: source, Fetched: fetched, Providers: make(map[string]Provider)}
	for id, up := range upstream {
		if up.NPM != openAICompatibleNPM || !matchableBaseURL(up.API) {
			continue
		}
		p := Provider{Name: up.Name, API: up.API, Doc: up.Doc, Models: make(map[string]Model)}
		for mid, um := range up.Models {
			if um.Limit.Context <= 0 {
				continue
			}
			m := Model{Context: um.Limit.Context, Output: max(um.Limit.Output, 0)}
			input := slices.Clone(um.Modalities.Input)
			sort.Strings(input)
			input = slices.Compact(input)
			if !textOnly(input) {
				m.Input = input
			}
			p.Models[mid] = m
		}
		if len(p.Models) > 0 {
			out.Providers[id] = p
		}
	}
	if len(out.Providers) == 0 {
		return Snapshot{}, fmt.Errorf("models.dev catalogue held no OpenAI-compatible provider; refusing to write an empty snapshot")
	}
	return out, nil
}

// textOnly reports whether a sorted modality list says text and nothing else,
// the case Model leaves empty.
func textOnly(input []string) bool {
	return len(input) == 0 || (len(input) == 1 && input[0] == "text")
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

// Encode writes a snapshot as snapshot.json: valid JSON, keys sorted, and one
// line per model, so that a refresh reads in a diff as the models it changed.
func (s Snapshot) Encode() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString("{\n")
	fmt.Fprintf(&b, "  \"source\": %s,\n", mustJSON(s.Source))
	fmt.Fprintf(&b, "  \"fetched\": %s,\n", mustJSON(s.Fetched))
	b.WriteString("  \"providers\": {")
	for i, id := range sortedKeys(s.Providers) {
		p := s.Providers[id]
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "\n    %s: {\n", mustJSON(id))
		fmt.Fprintf(&b, "      \"name\": %s,\n", mustJSON(p.Name))
		fmt.Fprintf(&b, "      \"api\": %s,\n", mustJSON(p.API))
		if p.Doc != "" {
			fmt.Fprintf(&b, "      \"doc\": %s,\n", mustJSON(p.Doc))
		}
		b.WriteString("      \"models\": {")
		for j, mid := range sortedKeys(p.Models) {
			if j > 0 {
				b.WriteByte(',')
			}
			line, err := json.Marshal(p.Models[mid])
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "\n        %s: %s", mustJSON(mid), line)
		}
		b.WriteString("\n      }\n    }")
	}
	b.WriteString("\n  }\n}\n")
	return b.Bytes(), nil
}

func decodeSnapshot(data []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return Snapshot{}, fmt.Errorf("decoding models.dev snapshot: %w", err)
	}
	return s, nil
}

// mustJSON encodes a string as a JSON string literal; strings always encode.
func mustJSON(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
