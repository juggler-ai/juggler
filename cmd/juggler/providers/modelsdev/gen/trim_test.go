//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/providers/modelsdev"
)

// upstreamFixture is a cut-down models.dev api.json with one provider of each
// kind trim must tell apart.
const upstreamFixture = `{
  "hosted": {
    "id": "hosted", "name": "Hosted", "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.hosted.example/v1", "doc": "https://docs.hosted.example",
    "env": ["HOSTED_API_KEY"],
    "models": {
      "org/Big-Model": {"id": "org/Big-Model", "limit": {"context": 262144, "output": 65536},
        "modalities": {"input": ["text", "image", "text"], "output": ["text"]}, "cost": {"input": 1}},
      "small": {"id": "small", "limit": {"context": 32768, "output": 0},
        "modalities": {"input": ["text"], "output": ["text"]}},
      "embedder": {"id": "embedder", "limit": {"context": 0, "output": 0},
        "modalities": {"input": ["text"], "output": ["text"]}}
    }
  },
  "dedicated-sdk": {
    "id": "dedicated-sdk", "name": "Dedicated", "npm": "@ai-sdk/google",
    "models": {"g": {"id": "g", "limit": {"context": 1000000, "output": 65536}}}
  },
  "templated": {
    "id": "templated", "name": "Templated", "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.example/accounts/${ACCOUNT_ID}/v1",
    "models": {"t": {"id": "t", "limit": {"context": 128000, "output": 8192}}}
  },
  "local": {
    "id": "local", "name": "Local", "npm": "@ai-sdk/openai-compatible",
    "api": "http://127.0.0.1:1234/v1",
    "models": {"l": {"id": "l", "limit": {"context": 128000, "output": 8192}}}
  },
  "only-unsized": {
    "id": "only-unsized", "name": "Unsized", "npm": "@ai-sdk/openai-compatible",
    "api": "https://unsized.example/v1",
    "models": {"u": {"id": "u", "limit": {"context": 0, "output": 0}}}
  }
}`

func TestTrimKeepsOnlyMatchableOpenAICompatibleProviders(t *testing.T) {
	snap, err := trim([]byte(upstreamFixture), "https://models.dev/api.json", "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	want := modelsdev.Snapshot{
		Source:  "https://models.dev/api.json",
		Fetched: "2026-10-26",
		Providers: map[string]modelsdev.Provider{
			"hosted": {
				Name: "Hosted", API: "https://api.hosted.example/v1", Doc: "https://docs.hosted.example",
				Models: map[string]modelsdev.Model{
					// Modalities sorted and de-duplicated; text-only omitted.
					"org/Big-Model": {Context: 262144, Output: 65536, Input: []string{"image", "text"}},
					"small":         {Context: 32768},
				},
			},
		},
	}
	if !reflect.DeepEqual(snap, want) {
		t.Errorf("trim:\n got %+v\nwant %+v", snap, want)
	}
}

func TestTrimRefusesAnEmptySnapshot(t *testing.T) {
	if _, err := trim([]byte(`{"x": {"npm": "@ai-sdk/google"}}`), "s", "2026-10-26"); err == nil {
		t.Error("trim of a catalogue with no usable provider returned no error")
	}
	if _, err := trim([]byte(`<html>`), "s", "2026-10-26"); err == nil {
		t.Error("trim of a non-JSON body returned no error")
	}
}

// TestEmbeddedSnapshotBaseURLsAreMatchable checks the snapshot this build
// ships against the filter trim applies: every provider in it has a base URL
// trim would keep.
func TestEmbeddedSnapshotBaseURLsAreMatchable(t *testing.T) {
	providers := modelsdev.Embedded().Providers()
	if len(providers) == 0 {
		t.Fatal("embedded snapshot holds no providers")
	}
	for _, p := range providers {
		if !matchableBaseURL(p.API) {
			t.Errorf("provider %s has an unmatchable base URL %q", p.ID, p.API)
		}
	}
}
