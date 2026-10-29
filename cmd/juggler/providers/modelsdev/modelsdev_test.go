//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package modelsdev

import (
	"bytes"
	"reflect"
	"sort"
	"testing"
	"time"
)

// TestEncodeRoundTripsOneLinePerModel pins the file format: it must decode to
// what was encoded, and each model must sit on a line of its own so a refresh
// diffs model by model.
func TestEncodeRoundTripsOneLinePerModel(t *testing.T) {
	snap := Snapshot{
		Source:  "src",
		Fetched: "2026-10-26",
		Providers: map[string]Provider{
			"hosted": {
				Name: "Hosted", API: "https://api.hosted.example/v1", Doc: "https://docs.hosted.example",
				Models: map[string]Model{
					"org/Big-Model": {Context: 262144, Output: 65536, Input: []string{"image", "text"}},
					"small":         {Context: 32768},
				},
			},
			"bare": {Name: "Bare", API: "https://bare.example/v1", Models: map[string]Model{"b": {Context: 8192}}},
		},
	}
	encoded, err := snap.Encode()
	if err != nil {
		t.Fatal(err)
	}
	back, err := decodeSnapshot(encoded)
	if err != nil {
		t.Fatalf("encoded snapshot does not decode: %v\n%s", err, encoded)
	}
	if !reflect.DeepEqual(back, snap) {
		t.Errorf("round trip:\n got %+v\nwant %+v", back, snap)
	}
	for _, line := range []string{
		`        "org/Big-Model": {"context":262144,"output":65536,"input":["image","text"]}`,
		`        "small": {"context":32768}`,
	} {
		if !bytes.Contains(encoded, []byte(line+",\n")) && !bytes.Contains(encoded, []byte(line+"\n")) {
			t.Errorf("encoded snapshot lacks the line %q:\n%s", line, encoded)
		}
	}
	again, _ := back.Encode()
	if !bytes.Equal(again, encoded) {
		t.Error("encoding is not deterministic")
	}
}

func TestLookup(t *testing.T) {
	cat := New(Snapshot{Providers: map[string]Provider{
		"hosted": {API: "https://api.hosted.example/v1", Models: map[string]Model{
			"org/Big-Model": {Context: 262144, Output: 65536, Input: []string{"image", "text"}},
			"small":         {Context: 32768},
		}},
		// Two plans of one gateway, catalogued under the same base URL.
		"gateway":     {API: "https://gw.example/v1/", Models: map[string]Model{"m": {Context: 200000, Output: 32000, Input: []string{"image", "text"}}}},
		"gateway-pro": {API: "https://gw.example/v1", Models: map[string]Model{"m": {Context: 1000000, Output: 0}}},
		// A local server, as a test fixture may catalogue one.
		"local": {API: "http://127.0.0.1:8080/v1", Models: map[string]Model{"l": {Context: 4096}}},
	}})

	tests := []struct {
		name, baseURL, model string
		want                 Model
		ok                   bool
	}{
		{"exact", "https://api.hosted.example/v1", "org/Big-Model", Model{Context: 262144, Output: 65536, Input: []string{"image", "text"}}, true},
		{"trailing slash, host case and scheme", "http://API.Hosted.example/v1/", "small", Model{Context: 32768}, true},
		{"model id case", "https://api.hosted.example/v1", "ORG/big-model", Model{Context: 262144, Output: 65536, Input: []string{"image", "text"}}, true},
		{"unlisted model", "https://api.hosted.example/v1", "brand-new", Model{}, false},
		{"other path on a catalogued host", "https://api.hosted.example/v2", "small", Model{}, false},
		{"uncatalogued host", "https://elsewhere.example/v1", "small", Model{}, false},
		{"no host", "api.hosted.example/v1", "small", Model{}, false},
		{"empty model", "https://api.hosted.example/v1", "", Model{}, false},
		{"shared URL takes the narrowest of each", "https://gw.example/v1", "m", Model{Context: 200000, Output: 32000}, true},
		{"port is part of the server", "http://127.0.0.1:8080/v1", "l", Model{Context: 4096}, true},
		{"different port", "http://127.0.0.1:9090/v1", "l", Model{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := cat.Lookup(tt.baseURL, tt.model)
			if ok != tt.ok || !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Lookup(%q, %q) = %+v, %v; want %+v, %v", tt.baseURL, tt.model, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestProvidersAreOrderedByName(t *testing.T) {
	cat := New(Snapshot{Providers: map[string]Provider{
		"b": {Name: "beta", API: "https://b.example/v1"},
		"a": {Name: "Alpha", API: "https://a.example/v1", Doc: "https://a.example/docs"},
		"c": {Name: "Alpha", API: "https://c.example/v1"},
	}})
	want := []ProviderEntry{
		{ID: "a", Name: "Alpha", API: "https://a.example/v1", Doc: "https://a.example/docs"},
		{ID: "c", Name: "Alpha", API: "https://c.example/v1"},
		{ID: "b", Name: "beta", API: "https://b.example/v1"},
	}
	if got := cat.Providers(); !reflect.DeepEqual(got, want) {
		t.Errorf("Providers() = %+v, want %+v", got, want)
	}
}

// TestEmbeddedSnapshot checks the file this build ships, whatever the last
// refresh put in it: it decodes, it is dated, it is in the canonical encoding
// (so it was written by the generator, not edited by hand), and every model in
// it can be found again through its provider's base URL — which is the only
// way the app ever asks. That every base URL is one the generator keeps is
// checked beside the generator (gen's TestEmbeddedSnapshotBaseURLsAreMatchable).
func TestEmbeddedSnapshot(t *testing.T) {
	snap, err := decodeSnapshot(snapshotJSON)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.DateOnly, snap.Fetched); err != nil {
		t.Errorf("fetched %q is not a YYYY-MM-DD date: %v", snap.Fetched, err)
	}
	if len(snap.Providers) == 0 {
		t.Fatal("embedded snapshot holds no providers")
	}
	canonical, err := snap.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(canonical, snapshotJSON) {
		t.Error("snapshot.json is not in the generator's encoding; regenerate it with `make models-sync` rather than editing it")
	}

	cat := Embedded()
	ids := make([]string, 0, len(snap.Providers))
	for id := range snap.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := snap.Providers[id]
		for mid, m := range p.Models {
			if m.Context <= 0 {
				t.Errorf("%s/%s has no context window", id, mid)
			}
			if _, ok := cat.Lookup(p.API, mid); !ok {
				t.Errorf("%s/%s is not found through %s", id, mid, p.API)
			}
		}
	}
}
