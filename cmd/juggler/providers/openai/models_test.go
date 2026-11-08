//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import "testing"

// TestCurrentCatalogIsDeclared covers every text model the Platform API
// currently serves. OpenAI's /v1/models returns four fields and no limits at
// all, so nothing at runtime can correct an omission here: an id missing from
// these tables runs at 128000 against whatever its real window is, and the only
// symptom is a conversation that compacts early.
func TestCurrentCatalogIsDeclared(t *testing.T) {
	for _, tc := range []struct {
		model  string
		window int
		output int
	}{
		{"gpt-6-astra", 1050000, 128000},
		{"gpt-6.1-sol", 1050000, 128000},
		{"gpt-6-sol", 1050000, 128000},
		{"gpt-6-luna", 1050000, 128000},
		{"gpt-5.6-sol", 1050000, 128000},
		{"gpt-5.6-terra", 1050000, 128000},
		{"gpt-5.6-luna", 1050000, 128000},
		{"gpt-5.6-cyber", 400000, 128000},
		{"gpt-5.5", 1050000, 128000},
		{"gpt-5.5-pro", 1050000, 128000},
		{"gpt-5.4", 1050000, 128000},
		{"gpt-5.4-pro", 1050000, 128000},
		{"gpt-5.4-mini", 400000, 128000},
		{"gpt-5.4-nano", 400000, 128000},
		{"gpt-5.3-codex", 400000, 128000},
		{"gpt-5.2", 400000, 128000},
		{"gpt-5.2-pro", 400000, 128000},
		// The one this test was written for: catalogued at 128000 for a model
		// documented at 400000, so every gpt-5.1 conversation compacted at less
		// than a third of the room it had.
		{"gpt-5.1", 400000, 128000},
		{"gpt-5", 400000, 128000},
		{"gpt-5-mini", 400000, 128000},
		{"gpt-5-nano", 400000, 128000},
		// gpt-5-pro is the one model in the line whose output ceiling is not
		// 128000, and it is more than double it.
		{"gpt-5-pro", 400000, 272000},
		{"chat-latest", 400000, 128000},
		// 1047576, not 1048576. OpenAI publishes the odd figure.
		{"gpt-4.1", 1047576, 32768},
		{"gpt-4.1-mini", 1047576, 32768},
		{"gpt-4o", 128000, 16384},
		{"gpt-4o-mini", 128000, 16384},
		{"o3", 200000, 100000},
		{"o1", 200000, 100000},
	} {
		window, ok := contextWindowCaps.LookupKnown(tc.model)
		if !ok || window != tc.window {
			t.Errorf("%s context window = %d (declared: %v), want %d", tc.model, window, ok, tc.window)
		}
		output, ok := maxOutputCaps.LookupKnown(tc.model)
		if !ok || output != tc.output {
			t.Errorf("%s max output = %d (declared: %v), want %d", tc.model, output, ok, tc.output)
		}
	}
}

// TestWithdrawnModelsCarryNoPromise checks that ids OpenAI has shut down, and
// one that never existed on the API at all, hold no catalog entry. A catalogued
// window presents a dead id as a sized, selectable model; gpt-5.1-thinking is
// worse than dead, being a ChatGPT product name whose 196000 matches nothing
// OpenAI has ever published.
func TestWithdrawnModelsCarryNoPromise(t *testing.T) {
	for _, model := range []string{
		"gpt-5.1-thinking", // never an API model
		"gpt-4-32k",        // shut down 2025-06-06
		"o1-preview",       // shut down 2025-07-28
		"o1-mini",          // shut down 2025-10-27
	} {
		if _, known := contextWindowCaps.LookupKnown(model); known {
			t.Errorf("%q still has a catalogued context window, but it cannot be called", model)
		}
		if _, known := maxOutputCaps.LookupKnown(model); known {
			t.Errorf("%q still has a catalogued output cap, but it cannot be called", model)
		}
	}
}

// TestDatedSnapshotsResolveThroughTheirAlias covers the ids OpenAI's model list
// actually contains. It offers "gpt-5.4" and "gpt-5.4-2026-03-05" side by side
// and both are selectable, but a catalog keyed only on the undated alias sizes
// the dated one at the 128000 default — the same silent early-compaction bug,
// reached by picking the pinned version of a model that was already catalogued.
func TestDatedSnapshotsResolveThroughTheirAlias(t *testing.T) {
	cases := []struct {
		model  string
		window int
		output int
	}{
		{"gpt-5.4-2026-03-05", 1050000, 128000},
		{"gpt-5.5-2026-04-23", 1050000, 128000},
		{"gpt-5.4-pro-2026-03-05", 1050000, 128000},
		{"gpt-5.4-mini-2026-03-17", 400000, 128000},
		{"gpt-5.1-2025-11-13", 400000, 128000},
		{"gpt-5-pro-2025-10-06", 400000, 272000},
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.window {
			t.Errorf("context window(%q) = %d, want %d via its undated alias", tc.model, got, tc.window)
		}
		if got := maxOutputCaps.Lookup(tc.model); got != tc.output {
			t.Errorf("max output(%q) = %d, want %d via its undated alias", tc.model, got, tc.output)
		}
	}
	// A date is only stripped to find a key. An id that means nothing to the
	// catalog still fails closed rather than inheriting a fabricated limit.
	if _, known := contextWindowCaps.LookupKnown("not-a-model-2026-01-01"); known {
		t.Error("an unknown id resolved a window by having a date on it")
	}
}

// TestIsChatModel keeps the model picker to models a conversation can be held
// with. OpenAI's /v1/models lists the entire platform — video, image, speech,
// transcription, realtime audio, embeddings — and anything admitted here
// becomes a selectable "model" sized by the 128000 default, because no catalog
// will ever carry a context window for a video generator.
func TestIsChatModel(t *testing.T) {
	chat := []string{
		"gpt-6-astra", "gpt-5.6-sol", "gpt-5.4-2026-03-05", "gpt-5.1-codex",
		"gpt-5.1-chat-latest", "chat-latest", "gpt-4o", "gpt-4.1-mini",
		"o1", "o3", "o4-mini",
	}
	for _, model := range chat {
		if !isChatModel(model) {
			t.Errorf("isChatModel(%q) = false, want true", model)
		}
	}
	notChat := []string{
		"sora-2", "sora-2-pro", "gpt-image-2", "gpt-image-1-mini", "chatgpt-image-latest",
		"gpt-realtime-2.1", "gpt-realtime-mini", "gpt-realtime-translate",
		"gpt-transcribe", "gpt-live-transcribe", "gpt-4o-mini-transcribe",
		"gpt-4o-mini-tts", "gpt-5-search-api", "gpt-4o-search-preview",
		"text-embedding-3-large", "omni-moderation-latest", "whisper-1",
		"dall-e-3", "babbage-002", "davinci-002",
	}
	for _, model := range notChat {
		if isChatModel(model) {
			t.Errorf("isChatModel(%q) = true, but it cannot answer a chat completion", model)
		}
	}
}

// TestVisionFollowsGeneration pins image support as a generation comparison
// rather than a list of prefixes, so a model id newer than this code is not
// reported text-only — which silently strips the images off a turn.
func TestVisionFollowsGeneration(t *testing.T) {
	for _, model := range []string{"gpt-6-astra", "gpt-6", "gpt-7-somecodename", "gpt-5.6-sol", "gpt-5", "gpt-4o", "gpt-4.1", "o4-mini", "o3"} {
		if !supportsVision(model) {
			t.Errorf("supportsVision(%q) = false, want true", model)
		}
	}
	for _, model := range []string{"gpt-4", "gpt-3.5-turbo", "o1-mini", "o3-mini", "gpt-oss-120b"} {
		if supportsVision(model) {
			t.Errorf("supportsVision(%q) = true, want false (text-only)", model)
		}
	}
	if got := inputModalities("gpt-6-astra"); len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Errorf("inputModalities(gpt-6-astra) = %v, want [text image]", got)
	}
}
