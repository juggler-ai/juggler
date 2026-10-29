//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package modelsdev is a compiled-in snapshot of the models.dev catalogue
// (https://models.dev), trimmed to the OpenAI-compatible providers and to the
// facts Juggler uses: each provider's name, base URL and documentation link,
// and each model's context window, output cap and input modalities.
//
// It exists for custom endpoints. A custom endpoint whose model list returns
// bare ids leaves Juggler nothing to size its models by; when that endpoint is
// a hosted provider models.dev catalogues, the catalogue's figure for the
// model on that provider is the best answer short of the server's own.
//
// The snapshot is data, not code: snapshot.json is written by `go generate`
// (gen/main.go, the only code here that touches the network, and never part
// of the app) and refreshed before each release. The app makes no request to
// models.dev. The data is MIT-licensed; see MODELS-DEV-LICENSE.
package modelsdev

import (
	_ "embed"
	"net/url"
	"sort"
	"strings"
	"sync"

	"juggler/internal/jlog"
)

//go:generate go run ./gen -o snapshot.json

//go:embed snapshot.json
var snapshotJSON []byte

// Snapshot is the trimmed catalogue as stored in snapshot.json.
type Snapshot struct {
	// Source is the URL the snapshot was taken from.
	Source string `json:"source"`
	// Fetched is the UTC date of the fetch, YYYY-MM-DD. The release tooling
	// reads it to refuse a release cut on stale data.
	Fetched   string              `json:"fetched"`
	Providers map[string]Provider `json:"providers"`
}

// Provider is one catalogued provider, keyed in Snapshot.Providers by its
// models.dev id.
type Provider struct {
	Name string `json:"name"`
	// API is the provider's OpenAI-compatible base URL.
	API    string           `json:"api"`
	Doc    string           `json:"doc,omitempty"`
	Models map[string]Model `json:"models"`
}

// Model is one model as a provider serves it. A non-positive limit means the
// catalogue does not know it.
type Model struct {
	Context int `json:"context,omitempty"`
	Output  int `json:"output,omitempty"`
	// Input lists the accepted input modalities, sorted. Empty means text
	// only: the snapshot omits the common case to keep one line per model
	// short.
	Input []string `json:"input,omitempty"`
}

// InputModalities returns the model's input modalities, with text-only
// spelled out rather than left empty.
func (m Model) InputModalities() []string {
	if len(m.Input) == 0 {
		return []string{"text"}
	}
	return m.Input
}

// ProviderEntry describes a catalogued provider for a user choosing one.
type ProviderEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	API  string `json:"api"`
	Doc  string `json:"doc,omitempty"`
}

// Catalog answers questions about a snapshot. Build one with New or Parse;
// the app's own is Embedded.
type Catalog struct {
	snap Snapshot
	// byURL maps a normalised base URL to the providers serving there. It is
	// usually one; models.dev lists a few gateways twice under the same URL
	// (two plans of one service), and a model there is sized by every entry.
	byURL map[string][]providerIndex
}

type providerIndex struct {
	exact  map[string]Model
	folded map[string]Model
}

// New indexes a snapshot. It applies no filtering of its own — what a
// snapshot holds is decided when it is made (gen/trim.go) — so a test can catalogue a
// local server.
func New(s Snapshot) *Catalog {
	c := &Catalog{snap: s, byURL: make(map[string][]providerIndex)}
	for _, p := range s.Providers {
		key := normaliseURL(p.API)
		if key == "" {
			continue
		}
		idx := providerIndex{exact: p.Models, folded: make(map[string]Model, len(p.Models))}
		for id, m := range p.Models {
			idx.folded[strings.ToLower(id)] = m
		}
		c.byURL[key] = append(c.byURL[key], idx)
	}
	return c
}

// Parse decodes and indexes snapshot.json-shaped data.
func Parse(data []byte) (*Catalog, error) {
	s, err := decodeSnapshot(data)
	if err != nil {
		return nil, err
	}
	return New(s), nil
}

var embedded = sync.OnceValue(func() *Catalog {
	c, err := Parse(snapshotJSON)
	if err != nil {
		// TestEmbeddedSnapshot stops a build that ships an unreadable file;
		// this keeps one that slipped through from taking providers down with
		// it. An empty catalogue sizes nothing, which is the behaviour without
		// a catalogue at all.
		jlog.Error("[modelsdev] embedded snapshot unreadable: %v", err)
		return New(Snapshot{})
	}
	return c
})

// Embedded returns the catalogue compiled into this build.
func Embedded() *Catalog { return embedded() }

// Providers lists the catalogued providers, ordered by name for display.
func (c *Catalog) Providers() []ProviderEntry {
	out := make([]ProviderEntry, 0, len(c.snap.Providers))
	for id, p := range c.snap.Providers {
		out = append(out, ProviderEntry{ID: id, Name: p.Name, API: p.API, Doc: p.Doc})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Lookup returns what the catalogue says about modelID as served from
// baseURL, and whether it knows. It matches only when baseURL is a catalogued
// provider's own base URL, and the model one that provider lists.
//
// There is deliberately no match on the model id alone. The same id is served
// at very different lengths by different hosts — one open-weights model
// appears at windows from 32k to 164k across twenty providers — so an id says
// little about a server the catalogue does not know, and the per-endpoint
// default (with the UI marking it assumed) remains the honest answer there.
//
// Where several catalogue entries share the URL, the narrowest figure wins:
// an assumed window must never over-state what the server will serve.
func (c *Catalog) Lookup(baseURL, modelID string) (Model, bool) {
	key := normaliseURL(baseURL)
	if key == "" || modelID == "" {
		return Model{}, false
	}
	var found []Model
	for _, idx := range c.byURL[key] {
		m, ok := idx.exact[modelID]
		if !ok {
			m, ok = idx.folded[strings.ToLower(modelID)]
		}
		if ok {
			found = append(found, m)
		}
	}
	if len(found) == 0 {
		return Model{}, false
	}
	return narrowest(found), true
}

// narrowest combines several descriptions of one model into the most
// conservative: the smallest known limits, and only the modalities all agree on.
func narrowest(ms []Model) Model {
	out := ms[0]
	for _, m := range ms[1:] {
		out.Context = minKnown(out.Context, m.Context)
		out.Output = minKnown(out.Output, m.Output)
		out.Input = intersect(out.InputModalities(), m.InputModalities())
	}
	if textOnly(out.Input) {
		out.Input = nil
	}
	return out
}

// minKnown is min over the positive values, where non-positive means unknown.
func minKnown(a, b int) int {
	switch {
	case a <= 0:
		return b
	case b <= 0:
		return a
	}
	return min(a, b)
}

func intersect(a, b []string) []string {
	var out []string
	for _, x := range a {
		for _, y := range b {
			if x == y {
				out = append(out, x)
				break
			}
		}
	}
	return out
}

// normaliseURL reduces a base URL to the part that identifies a server: host
// (lower-cased, port kept) and path without a trailing slash. Scheme, query and
// fragment are dropped, so a user who typed http:// or a trailing slash still
// matches. Anything without a host is "".
func normaliseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Host) + strings.TrimRight(u.Path, "/")
}
