//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
)

func TestRegisterProviderInfo(t *testing.T) {
	Register()
	info, ok := provider.GetProviderInfo("openaicodex")
	if !ok {
		t.Fatal("openaicodex provider not registered")
	}
	if info.EffectiveAuthType() != provider.AuthTypeOAuthBearer {
		t.Fatalf("auth type = %q, want %q", info.EffectiveAuthType(), provider.AuthTypeOAuthBearer)
	}
	if info.AuthSource != "codex_cli" {
		t.Fatalf("auth source = %q, want codex_cli", info.AuthSource)
	}
	if info.ConfigKeyName != "" {
		t.Fatalf("ConfigKeyName = %q, want empty for OAuth provider", info.ConfigKeyName)
	}
	// With the catalog unreachable its static windows are stand-ins, and the
	// backend rejects an over-long request ("exceeds the context window of this
	// model") rather than truncating it — so it can judge a guessed window.
	if !info.StaticWindowsAssumed || !info.RejectsContextOverflow {
		t.Fatalf("StaticWindowsAssumed = %v, RejectsContextOverflow = %v; want both", info.StaticWindowsAssumed, info.RejectsContextOverflow)
	}
}

func TestCodexThinkingSpecHasNoColdCacheFallback(t *testing.T) {
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{})
	t.Cleanup(func() { replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{}) })

	for _, model := range []string{"gpt-5.2-codex", "gpt-5.6-sol", "codex-max"} {
		if got := codexThinkingSpec(model); len(got.Options()) != 0 || got.Default != "" {
			t.Errorf("codexThinkingSpec(%q) = %+v, want zero spec without /models metadata", model, got)
		}
	}
}

func TestReplaceReasoningSpecsDropsStaleModels(t *testing.T) {
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{
		"old-model": openaibase.EffortSpec("medium", "low", "medium", "high"),
	})
	replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{
		"new-model": openaibase.EffortSpec("high", "high", "xhigh"),
	})
	t.Cleanup(func() { replaceReasoningSpecs(map[string]openaibase.ThinkingSpec{}) })

	if got := codexThinkingSpec("old-model"); len(got.Options()) != 0 {
		t.Fatalf("old-model retained stale levels after catalog replacement: %v", got.Options())
	}
	if got := codexThinkingSpec("new-model"); !slices.Equal(got.Options(), []string{"high", "xhigh"}) || got.Default != "high" {
		t.Fatalf("new-model spec = %+v, want replacement catalog values", got)
	}
}

// TestServiceTierSpecsAreReplacedWholesale is the money guard for the catalog
// cache. A tier the backend has stopped offering must vanish on the next fetch:
// keeping it would show a "Fast" control that bills at a premium rate for a
// request the backend now declines.
func TestServiceTierSpecsAreReplacedWholesale(t *testing.T) {
	replaceServiceTierSpecs(map[string]openaibase.ServiceTierSpec{
		"retired-model": {Tiers: []provider.ServiceTier{{ID: "priority", Name: "Fast"}}},
	})
	replaceServiceTierSpecs(map[string]openaibase.ServiceTierSpec{
		"current-model": {Tiers: []provider.ServiceTier{{ID: "priority", Name: "Fast"}}},
	})
	t.Cleanup(func() { replaceServiceTierSpecs(map[string]openaibase.ServiceTierSpec{}) })

	if got := codexServiceTierSpec("retired-model"); len(got.Tiers) != 0 {
		t.Fatalf("retired-model kept stale tiers after catalog replacement: %+v", got.Tiers)
	}
	if got := codexServiceTierSpec("current-model"); len(got.Tiers) != 1 {
		t.Fatalf("current-model spec = %+v, want the replacement catalog's tier", got)
	}
}

// TestCodexServiceTierSpecHasNoColdCacheFallback pins the fail-closed rule: with
// no catalog fetched, no model offers a paid tier. Guessing one from a slug
// would spend real money on an unverified entitlement.
func TestCodexServiceTierSpecHasNoColdCacheFallback(t *testing.T) {
	replaceServiceTierSpecs(map[string]openaibase.ServiceTierSpec{})
	t.Cleanup(func() { replaceServiceTierSpecs(map[string]openaibase.ServiceTierSpec{}) })

	for _, model := range []string{"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"} {
		if got := codexServiceTierSpec(model); len(got.Tiers) != 0 || got.Default != "" {
			t.Errorf("codexServiceTierSpec(%q) = %+v, want zero spec without /models metadata", model, got)
		}
	}
}

func TestListModelsParsesCodexCatalog(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	var authHeader string
	var accountHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			t.Fatalf("path = %q, want /models", r.URL.Path)
		}
		if r.URL.Query().Get("client_version") == "" {
			t.Fatal("client_version query was not set")
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"models": [
				{"slug":"hidden-model","visibility":"hide","context_window":1,"priority":0},
				{"slug":"gpt-5.5","visibility":"list","context_window":272000,"max_output_tokens":32768,"priority":1,
					"default_reasoning_level":"high",
					"supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"}],
					"service_tiers":[{"id":"priority","name":"Fast","description":"1.5x speed, increased usage"}],
					"additional_speed_tiers":["fast"],
					"default_service_tier":null},
				{"slug":"gpt-5.3-codex","visibility":"list","max_context_window":192000,"priority":2,
					"service_tiers":[]}
			]
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	models, err := listModels(context.Background(), "token", map[string]string{"ChatGPT-Account-Id": "acct_123"})
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if authHeader != "Bearer token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
	// Two visible catalog models, then the static entries the catalog did not
	// return. gpt-5.5 is in both, and must not be listed twice.
	if len(models) != 9 {
		t.Fatalf("got %d models, want 9", len(models))
	}
	if models[0].ID != "gpt-5.5" || models[0].ContextWindow != 272000 || models[0].MaxOutputTokens != 32768 || !models[0].FromAPI {
		t.Fatalf("unexpected first model: %+v", models[0])
	}
	// Thinking levels come verbatim from the backend's supported_reasoning_levels,
	// not a slug heuristic: xhigh/max must survive, in order, with the API default.
	if !slices.Equal(models[0].ThinkingLevels, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("gpt-5.5 thinking levels = %v, want API-declared [low medium high xhigh max]", models[0].ThinkingLevels)
	}
	if models[0].DefaultThinkingLevel != "high" {
		t.Fatalf("gpt-5.5 default thinking level = %q, want API-declared high", models[0].DefaultThinkingLevel)
	}
	if models[1].ID != "gpt-5.3-codex" || models[1].ContextWindow != 192000 || models[1].MaxOutputTokens != DefaultMaxOutputTokens {
		t.Fatalf("unexpected second model: %+v", models[1])
	}
	// A model that declares no supported_reasoning_levels advertises no reasoning
	// control — we no longer manufacture levels it never claimed.
	if len(models[1].ThinkingLevels) != 0 {
		t.Fatalf("gpt-5.3-codex thinking levels = %v, want none (API declared none)", models[1].ThinkingLevels)
	}
	// The wire gate resolves its spec through codexThinkingSpec, which must read
	// the same API-declared levels listModels just cached — so a turn requesting
	// xhigh is sent, not silently dropped.
	if got := codexThinkingSpec("gpt-5.5").Options(); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("codexThinkingSpec(gpt-5.5) = %v, want cached API levels including xhigh", got)
	}
	// Serving classes come from the catalog's service_tiers, with the backend's
	// own id, label and blurb preserved — the UI shows the provider's words for
	// what the user is buying rather than inventing copy for it.
	if len(models[0].ServiceTiers) != 1 {
		t.Fatalf("gpt-5.5 service tiers = %+v, want the one API-declared tier", models[0].ServiceTiers)
	}
	if tier := models[0].ServiceTiers[0]; tier.ID != "priority" || tier.Name != "Fast" || tier.Description != "1.5x speed, increased usage" {
		t.Fatalf("service tier = %+v, want the catalog entry verbatim", tier)
	}
	// default_service_tier is null in the catalog and must stay empty — a
	// fabricated default would be spent on the user's behalf.
	if models[0].DefaultServiceTier != "" {
		t.Fatalf("default service tier = %q, want empty for a null catalog value", models[0].DefaultServiceTier)
	}
	// The wire gate resolves through codexServiceTierSpec, which must see the
	// same tier listModels just cached, and must reject one it never declared.
	if got := codexServiceTierSpec("gpt-5.5"); len(got.Tiers) != 1 || got.Tiers[0].ID != "priority" {
		t.Fatalf("codexServiceTierSpec(gpt-5.5) = %+v, want the cached priority tier", got)
	}
	if got := codexServiceTierSpec("gpt-5.3-codex"); len(got.Tiers) != 0 {
		t.Fatalf("codexServiceTierSpec(gpt-5.3-codex) = %+v, want no tiers on the wire", got)
	}
	// A model declaring an empty service_tiers list offers standard serving
	// only — the deprecated additional_speed_tiers field must not resurrect it.
	if len(models[1].ServiceTiers) != 0 {
		t.Fatalf("gpt-5.3-codex service tiers = %+v, want none (API declared none)", models[1].ServiceTiers)
	}

	// A slug present in both the live catalog and the static map is listed once,
	// keeping the API's richer entry rather than shadowing it with the stand-in.
	occurrences := 0
	for _, model := range models {
		if model.ID == "gpt-5.5" {
			occurrences++
			if !model.FromAPI {
				t.Fatalf("gpt-5.5 came back as the static stand-in, want the API entry: %+v", model)
			}
		}
	}
	if occurrences != 1 {
		t.Fatalf("gpt-5.5 listed %d times, want 1 — static fallback must not duplicate a catalog model", occurrences)
	}

	fallbackIDs := map[string]bool{}
	for _, model := range models[2:] {
		fallbackIDs[model.ID] = !model.FromAPI
	}
	for _, id := range []string{"gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"} {
		if !fallbackIDs[id] {
			t.Fatalf("missing static fallback %s in %+v", id, models)
		}
		for _, model := range models[2:] {
			if model.ID != id {
				continue
			}
			if len(model.ThinkingLevels) != 0 || model.DefaultThinkingLevel != "" {
				t.Fatalf("static fallback %s advertised guessed thinking metadata: %+v", id, model)
			}
			// A stand-in must never offer a paid serving class: nothing has
			// confirmed the account can use one, and the turn would be billed
			// at a premium rate for a request the backend declines.
			if len(model.ServiceTiers) != 0 || model.DefaultServiceTier != "" {
				t.Fatalf("static fallback %s advertised guessed service tiers: %+v", id, model)
			}
			if model.ContextWindow != catalogContextWindow {
				t.Fatalf("static fallback %s context window = %d, want %d", id, model.ContextWindow, catalogContextWindow)
			}
			if !model.WindowAssumed {
				t.Fatalf("static fallback %s window is not marked assumed: %+v", id, model)
			}
		}
	}
}

// TestCodexClientVersionCoversEveryModel is the guard that makes knownModels a
// safe place to add a slug. The catalog serves each row only to clients at or
// above the minimal_client_version it declares, so a slug added without moving
// codexClientVersion up is simply never returned — no error, no empty list, the
// model just is not there. This test says so at the point of the edit.
func TestCodexClientVersionCoversEveryModel(t *testing.T) {
	for _, model := range knownModels {
		if model.MinClientVersion == "" {
			continue
		}
		if compareCodexVersions(codexClientVersion, model.MinClientVersion) < 0 {
			t.Errorf("codexClientVersion = %q but %s needs >= %q — raise codexClientVersion to a real Codex release at or above it",
				codexClientVersion, model.Slug, model.MinClientVersion)
		}
	}
}

// compareCodexVersions orders two dotted version strings numerically, so
// "0.153.4" sorts above "0.99.0" where a string compare would not.
func compareCodexVersions(a, b string) int {
	partsA, partsB := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(partsA) || i < len(partsB); i++ {
		var numA, numB int
		if i < len(partsA) {
			numA, _ = strconv.Atoi(partsA[i])
		}
		if i < len(partsB) {
			numB, _ = strconv.Atoi(partsB[i])
		}
		if numA != numB {
			return numA - numB
		}
	}
	return 0
}

func TestCompareCodexVersions(t *testing.T) {
	if compareCodexVersions("0.153.4", "0.99.0") <= 0 {
		t.Error("0.153.4 must sort above 0.99.0 — the comparison is numeric, not lexical")
	}
	if compareCodexVersions("0.153.0", "0.153") != 0 || compareCodexVersions("0.153.4", "0.153.4") != 0 {
		t.Error("equal versions must compare equal, with a missing trailing component read as zero")
	}
	if compareCodexVersions("0.152.9", "0.153.0") >= 0 {
		t.Error("0.152.9 must sort below 0.153.0")
	}
}

// TestListModelsAdmitsKnownHiddenModels covers GPT-6 Astra, which the catalog
// ships as visibility "hide": configurable through the API but deliberately
// absent from Codex's own picker. Juggler lists the slugs it knows about, so a
// hidden row for a known slug is admitted with its live metadata intact, while
// a hidden row for anything else stays out of the picker.
func TestListModelsAdmitsKnownHiddenModels(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"models": [
				{"slug":"gpt-6-astra","visibility":"hide","context_window":272000,"max_context_window":872000,"priority":1,
					"default_reasoning_level":"low",
					"supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}],
					"service_tiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"},{"id":"ultrafast","name":"Ultrafast","description":"The fastest available responses for latency-sensitive work."}],
					"default_service_tier":null},
				{"slug":"internal-eval-model","visibility":"hide","context_window":272000,"priority":2},
				{"slug":"gpt-5.5","visibility":"list","context_window":272000,"priority":3}
			]
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	models, err := listModels(context.Background(), "token", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := make(map[string]provider.ModelInfo, len(models))
	for _, m := range models {
		byID[m.ID] = m
	}

	astra, ok := byID["gpt-6-astra"]
	if !ok {
		t.Fatalf("gpt-6-astra missing from %+v", models)
	}
	// Admitted from the live row, not manufactured by the static stand-in: the
	// catalog is authoritative wherever it speaks.
	if !astra.FromAPI {
		t.Fatalf("gpt-6-astra = %+v, want the live catalog entry rather than the static stand-in", astra)
	}
	if astra.ContextWindow != 872000 {
		t.Fatalf("gpt-6-astra ContextWindow = %d, want 872000 (max_context_window)", astra.ContextWindow)
	}
	wantLevels := []string{"low", "medium", "high", "xhigh", "max", "ultra"}
	if !slices.Equal(astra.ThinkingLevels, wantLevels) || astra.DefaultThinkingLevel != "low" {
		t.Fatalf("gpt-6-astra reasoning = %v/%q, want API-declared %v with default low", astra.ThinkingLevels, astra.DefaultThinkingLevel, wantLevels)
	}
	if len(astra.ServiceTiers) != 2 || astra.ServiceTiers[0].ID != "priority" || astra.ServiceTiers[1].ID != "ultrafast" {
		t.Fatalf("gpt-6-astra service tiers = %+v, want the catalog's priority and ultrafast entries", astra.ServiceTiers)
	}
	// The wire gates read through these caches, so an admitted hidden model must
	// be able to send the effort and tier it just advertised.
	if got := codexThinkingSpec("gpt-6-astra").Options(); !slices.Equal(got, wantLevels) {
		t.Fatalf("codexThinkingSpec(gpt-6-astra) = %v, want the cached API levels", got)
	}
	if got := codexServiceTierSpec("gpt-6-astra"); len(got.Tiers) != 2 {
		t.Fatalf("codexServiceTierSpec(gpt-6-astra) = %+v, want the cached tiers", got)
	}
	// A hidden slug we do not ship stays hidden — admitting the catalog's whole
	// hidden section would put internal and evaluation models in the picker.
	if _, listed := byID["internal-eval-model"]; listed {
		t.Fatalf("internal-eval-model was admitted from a hidden catalog row: %+v", models)
	}
}

// TestKnownModelsDriveEverything checks that the one table is in fact the one
// place to edit: the map the settings UI and the static fallbacks read is
// derived from it, entry for entry.
func TestKnownModelsDriveEverything(t *testing.T) {
	if len(ModelContextWindows) != len(knownModels) {
		t.Fatalf("ModelContextWindows has %d entries for %d known models — it must be derived, not maintained alongside", len(ModelContextWindows), len(knownModels))
	}
	for _, model := range knownModels {
		window, ok := ModelContextWindows[model.Slug]
		if !ok {
			t.Errorf("%s is not in ModelContextWindows, so it is unselectable while signed out", model.Slug)
			continue
		}
		if window != model.ContextWindow || window <= 0 {
			t.Errorf("%s window = %d, want the table's %d", model.Slug, window, model.ContextWindow)
		}
	}
	if _, ok := ModelContextWindows["gpt-6-astra"]; !ok {
		t.Error("gpt-6-astra is missing from the ChatGPT-plan model list")
	}
}

// TestPlanCatalogMatchesTheLiveList pins knownModels against what the ChatGPT
// backend actually serves. Both directions are silent failures: a slug the
// catalog has retired stays selectable and 400s on use, and a slug missing from
// here is absent from the picker for anyone signed out — while a slug whose
// minimal_client_version is above codexClientVersion is withheld from the live
// response entirely, with nothing in the reply to say a row was dropped.
func TestPlanCatalogMatchesTheLiveList(t *testing.T) {
	for _, slug := range []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"} {
		if _, ok := ModelContextWindows[slug]; !ok {
			t.Errorf("%s is not listed, so the ChatGPT plan's current model is unselectable", slug)
		}
	}
	// Retired from Codex-with-ChatGPT-sign-in on 2026-08-31.
	for _, slug := range []string{"gpt-5.4", "gpt-5.4-mini"} {
		if _, ok := ModelContextWindows[slug]; ok {
			t.Errorf("%s is still listed, but the backend no longer accepts it", slug)
		}
	}
}

func TestUsageStatsCallsCodexEndpoint(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	var authHeader string
	var accountHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" {
			t.Fatalf("path = %q, want /usage", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		accountHeader = r.Header.Get("ChatGPT-Account-Id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type": "pro",
			"rate_limit": {
				"primary_window": {"used_percent": 42, "reset_at": 2000, "limit_window_seconds": 18000}
			}
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	stats, err := usageStats(context.Background(), "token", map[string]string{"ChatGPT-Account-Id": "acct_123"})
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if authHeader != "Bearer token" {
		t.Fatalf("Authorization header = %q, want bearer token", authHeader)
	}
	if accountHeader != "acct_123" {
		t.Fatalf("ChatGPT-Account-Id header = %q, want acct_123", accountHeader)
	}
	if stats.Plan != "pro" || len(stats.Stats) != 1 || derefPct(stats.Stats[0].UsedPercent) != 42 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

// TestListModelsPrefersMaxContextWindow pins which of the catalog's two windows
// a model is run at.
//
// The catalog states both. `context_window` is the operating point the Codex CLI
// picks for itself and compacts against; `max_context_window` is the ceiling the
// backend will actually accept — for the gpt-5.6 family, 872000 against a 272000
// operating point. Juggler is not the Codex CLI and brings its own compaction
// policy, so the number it needs is the one the wire enforces. Taking the
// smaller of the two understates a legitimate prompt by more than half a million
// tokens and paints a conversation that is nowhere near its limit as saturated.
func TestListModelsPrefersMaxContextWindow(t *testing.T) {
	originalBaseURL := baseURL
	baseURL = ""
	t.Cleanup(func() { baseURL = originalBaseURL })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"models": [
				{"slug":"gpt-5.6-sol","visibility":"list","context_window":272000,"max_context_window":872000,"max_output_tokens":32768,"priority":1},
				{"slug":"gpt-5.5","visibility":"list","context_window":272000,"max_output_tokens":32768,"priority":2},
				{"slug":"gpt-5.3-codex","visibility":"list","max_context_window":192000,"priority":3}
			]
		}`))
	}))
	defer server.Close()
	baseURL = server.URL

	models, err := listModels(context.Background(), "token", nil)
	if err != nil {
		t.Fatalf("listModels: %v", err)
	}
	byID := make(map[string]provider.ModelInfo, len(models))
	for _, m := range models {
		byID[m.ID] = m
	}

	// Both stated: the enforced ceiling wins.
	if got := byID["gpt-5.6-sol"].ContextWindow; got != 872000 {
		t.Fatalf("gpt-5.6-sol ContextWindow = %d, want 872000 (max_context_window, not the 272000 operating point)", got)
	}
	// Only the operating point stated: it is the only number there is, and a
	// model whose ceiling the catalog declines to name is not assumed to have a
	// larger one.
	if got := byID["gpt-5.5"].ContextWindow; got != 272000 {
		t.Fatalf("gpt-5.5 ContextWindow = %d, want 272000 (no max_context_window declared)", got)
	}
	// Only the ceiling stated: unchanged, and still the fallback it always was.
	if got := byID["gpt-5.3-codex"].ContextWindow; got != 192000 {
		t.Fatalf("gpt-5.3-codex ContextWindow = %d, want 192000", got)
	}
}
