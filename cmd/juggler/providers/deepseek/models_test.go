//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import "testing"

// currentModels is every model id DeepSeek serves. The endpoint returns bare
// ids — no window, no output cap, not even a created timestamp — so nothing at
// runtime can correct this file. It is the only thing standing between a user
// and a number invented years ago.
var currentModels = []string{
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"deepseek-flash",
	"deepseek-v4-flash-vision-exp",
}

// TestDeepSeekOutputCapHasReasoningHeadroom guards that a reasoning model gets
// enough output budget for its chain-of-thought.
//
// This began with deepseek-reasoner (R1), which spends output tokens thinking
// before it answers: the original flat 8192 cap throttled the reasoning itself
// and produced empty `finish=length` turns the worker silently retried. R1 is
// gone, but the failure it describes is a property of reasoning models, not of
// that id — so the guard now stands over the models that actually reason today,
// all of which document a 384K ceiling.
func TestDeepSeekOutputCapHasReasoningHeadroom(t *testing.T) {
	for _, model := range currentModels {
		if got := maxOutputCaps.Lookup(model); got != 384000 {
			t.Errorf("max output(%q) = %d, want the documented 384000", model, got)
		}
	}
	// An id nobody catalogued still clears the floor that caused the original
	// truncation, since a new DeepSeek model is far likelier to reason than not.
	if got := maxOutputCaps.Lookup("deepseek-vNext"); got < 32768 {
		t.Errorf("max output(unknown) = %d, want >= 32768 (reasoning needs headroom)", got)
	}
}

// TestDeepSeekContextWindow pins the served models' windows and the
// unknown-model default.
func TestDeepSeekContextWindow(t *testing.T) {
	// Every current model advertises a 1M-token window. Without an entry a model
	// falls to the 128k default and its conversations compact ~8x too early.
	for _, model := range currentModels {
		if got := contextWindowCaps.Lookup(model); got != 1000000 {
			t.Errorf("context window(%s) = %d, want 1000000", model, got)
		}
	}
	if got := contextWindowCaps.Lookup("deepseek-vNext"); got != DefaultContextWindow {
		t.Errorf("context window(unknown) = %d, want default %d", got, DefaultContextWindow)
	}
}

// TestDiscontinuedModelsCarryNoPromise checks that the ids DeepSeek switched
// off on 2026-07-24 hold no catalog entry. A window for a model that cannot be
// called is worse than none: it presents a dead id as a sized, selectable
// choice.
func TestDiscontinuedModelsCarryNoPromise(t *testing.T) {
	for _, model := range []string{"deepseek-chat", "deepseek-reasoner", "deepseek-coder"} {
		if _, known := contextWindowCaps.LookupKnown(model); known {
			t.Errorf("%q still has a catalogued context window — it was discontinued on 2026-07-24", model)
		}
		if _, known := maxOutputCaps.LookupKnown(model); known {
			t.Errorf("%q still has a catalogued output cap — it was discontinued on 2026-07-24", model)
		}
	}
}

// TestVisionModelSurvivesTheModelFilter is the reason deepseek-v4-flash-vision-exp
// needs an entry at all. The provider filter drops ids ENDING in "-vision", and
// this one ends "-exp", so it reaches users — sized by whatever the catalog says
// about it. Uncatalogued, that was the 128k default against a real 1M window.
func TestVisionModelSurvivesTheModelFilter(t *testing.T) {
	filter := modelFilter()
	if !filter("deepseek-v4-flash-vision-exp") {
		t.Fatal("deepseek-v4-flash-vision-exp is filtered out — the catalog entry would be unreachable")
	}
	for _, excluded := range []string{"deepseek-embedding", "deepseek-chat-vision", "deepseek-tts"} {
		if filter(excluded) {
			t.Errorf("%q passed the model filter, but it is not a chat model", excluded)
		}
	}
}
