//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
	"juggler/internal/userpaths/userpathstest"
)

func TestResolveModelCapabilities(t *testing.T) {
	const providerName = "test_capability_resolution"
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ModelContextWindows: map[string]int{
			"live-model":   111,
			"static-model": 222,
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{{
			ID:              "live-model",
			ContextWindow:   333,
			MaxOutputTokens: 44,
		}},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "exact live model wins over static metadata",
			model: "live-model",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 333,
				MaxOutputTokens:     44,
			},
		},
		{
			name:  "missing live model derives output reserve from known context",
			model: "static-model",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 222,
				MaxOutputTokens:     provider.ContextSafetyReserve(222),
			},
		},
		{
			name:  "unknown model remains unknown",
			model: "unknown-model",
			want:  provider.ModelCapabilities{},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestResolveModelCapabilitiesStaticResolverAndLivePrecedence(t *testing.T) {
	const providerName = "test_capability_static_resolver"
	fallback := provider.ModelCapabilities{
		ContextWindowTokens:    200000,
		MaxOutputTokens:        64000,
		ProviderOverheadTokens: 40000,
	}
	provider.RegisterProvider(provider.ProviderInfo{
		Name: providerName,
		ResolveModelCapabilities: func(model string) (provider.ModelCapabilities, bool) {
			return fallback, model == "sonnet"
		},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	t.Run("fresh alias uses conservative fallback", func(t *testing.T) {
		s := &Server{}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != fallback {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, fallback)
		}
		if got := s.resolveModelCapabilities(providerName, "custom"); got != (provider.ModelCapabilities{}) {
			t.Fatalf("unknown alias = %+v, want unknown", got)
		}
	})

	t.Run("positive live limits override fallback and retain overhead", func(t *testing.T) {
		s := &Server{}
		providers := []ProviderStatus{{
			Name: providerName,
			ModelsWithContext: []ModelWithContext{{
				ID: "sonnet", ContextWindow: 1000000, MaxOutputTokens: 32000,
			}},
		}}
		s.providersList.Store(&providers)
		want := provider.ModelCapabilities{
			ContextWindowTokens:    1000000,
			MaxOutputTokens:        32000,
			ProviderOverheadTokens: 40000,
		}
		if got := s.resolveModelCapabilities(providerName, "sonnet"); got != want {
			t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, want)
		}
	})
}

func TestResolveModelCapabilitiesKeepsFallbackForNonPositiveLiveValues(t *testing.T) {
	const providerName = "test_capability_live_unknown"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"model": 999},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name:              providerName,
		ModelsWithContext: []ModelWithContext{{ID: "model"}},
	}}
	s.providersList.Store(&providers)

	if got := s.resolveModelCapabilities(providerName, "model"); got != (provider.ModelCapabilities{ContextWindowTokens: 999, MaxOutputTokens: provider.ContextSafetyReserve(999)}) {
		t.Fatalf("resolveModelCapabilities() = %+v, want positive static fallback with derived reserve", got)
	}
}

// TestResolveModelCapabilitiesHonoursUserLimitOverrides pins the escape hatch
// for a model whose real limits differ from what this build believes: the
// user's models.limits override outranks the catalogue AND the live list, and
// applies even when the model appears in neither (an empty cache at startup, or
// a gateway alias the provider never lists).
func TestResolveModelCapabilitiesHonoursUserLimitOverrides(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "test_capability_user_overrides"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"catalogued": 128000},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Limits = map[string]map[string]core.ModelLimits{providerName: {
			"catalogued":   {ContextWindow: 1000000, MaxOutputTokens: 64000},
			"listed":       {ContextWindow: 200000},
			"never-listed": {ContextWindow: 512000},
		}}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}

	s := &Server{settings: newSettingsStore()}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "listed", ContextWindow: 32000, MaxOutputTokens: 4096},
		},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "override beats the compiled-in catalogue",
			model: "catalogued",
			want:  provider.ModelCapabilities{ContextWindowTokens: 1000000, MaxOutputTokens: 64000},
		},
		{
			// The half the user left blank still comes from the provider, so
			// correcting a window does not silently discard a good output cap.
			name:  "override beats the live list, per field",
			model: "listed",
			want:  provider.ModelCapabilities{ContextWindowTokens: 200000, MaxOutputTokens: 4096},
		},
		{
			// Nothing knows this model. Without the override it would be
			// unknown, and admission would have no window to charge against.
			name:  "override alone makes an unlisted model usable",
			model: "never-listed",
			want: provider.ModelCapabilities{
				ContextWindowTokens: 512000,
				MaxOutputTokens:     provider.ContextSafetyReserve(512000),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}

// TestWindowResolverReportsAssumedWindow pins what the worker is told about a
// guessed window: that it is one while the provider's fallback stands, and that
// it no longer is once the user has typed the real number in. Compaction reads
// this to say which window it folded at, so a user who has already corrected
// the window must not be told it is a guess.
func TestWindowResolverReportsAssumedWindow(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "test_capability_window_assumed"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName},
		func(provider.Config) (provider.Provider, error) { return nil, nil })

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Limits = map[string]map[string]core.ModelLimits{providerName: {
			"corrected": {ContextWindow: 256000},
		}}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
	s := &Server{settings: newSettingsStore()}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "guessed", ContextWindow: 8192, WindowAssumed: true},
			{ID: "corrected", ContextWindow: 8192, WindowAssumed: true},
			{ID: "reported", ContextWindow: 131072, FromAPI: true},
		},
	}}
	s.providersList.Store(&providers)

	// None of the three states an output limit, so every reserve is derived.
	resolve := s.createWindowResolver()
	for model, want := range map[string]worker.ContextWindowInfo{
		"guessed":   {WindowTokens: 8192, ReserveTokens: int(provider.ContextSafetyReserve(8192)), Assumed: true, ReserveDerived: true, OutputRaiseCeiling: 4096},
		"corrected": {WindowTokens: 256000, ReserveTokens: int(provider.ContextSafetyReserve(256000)), ReserveDerived: true, OutputRaiseCeiling: 128000},
		"reported":  {WindowTokens: 131072, ReserveTokens: int(provider.ContextSafetyReserve(131072)), ReserveDerived: true, OutputRaiseCeiling: 65536},
	} {
		if got := resolve(worker.ModelConfig{Provider: providerName, Model: model}); got != want {
			t.Errorf("%s: resolver = %+v, want %+v", model, got, want)
		}
	}
}

// TestWindowResolverReportsDerivedReserve pins what the truncation notice is
// told about the budget that ended a turn: whether it is Juggler's default
// derived from the window, or a limit the provider or the user set. Only the
// first may be described as derived.
func TestWindowResolverReportsDerivedReserve(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "test_capability_reserve_derived"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName},
		func(provider.Config) (provider.Provider, error) { return nil, nil })

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Limits = map[string]map[string]core.ModelLimits{providerName: {
			"user-set": {MaxOutputTokens: 50000},
		}}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
	s := &Server{settings: newSettingsStore()}
	published := []ModelWithContext{
		// llama.cpp: a window and nothing else.
		{ID: "unreported", ContextWindow: 262144},
		// An OpenAI-compatible list that already stood the derived reserve in.
		{ID: "provider-derived", ContextWindow: 262144, MaxOutputTokens: 32768},
		{ID: "reported", ContextWindow: 262144, MaxOutputTokens: 16384, FromAPI: true},
		{ID: "user-set", ContextWindow: 262144},
		{ID: "over-ceiling", ContextWindow: 100000, MaxOutputTokens: 90000},
	}
	derivedFlags := map[string]bool{"provider-derived": true}
	settings := s.settings.get()
	for i, m := range published {
		published[i] = withDerivedOutputBudget(applyModelLimits(m, settings.ModelLimitsFor(providerName, m.ID)), derivedFlags[m.ID])
	}
	providers := []ProviderStatus{{Name: providerName, ModelsWithContext: published}}
	s.providersList.Store(&providers)

	resolve := s.createWindowResolver()
	for model, want := range map[string]worker.ContextWindowInfo{
		"unreported":       {WindowTokens: 262144, ReserveTokens: 32768, ReserveDerived: true, OutputRaiseCeiling: 131072},
		"provider-derived": {WindowTokens: 262144, ReserveTokens: 32768, ReserveDerived: true, OutputRaiseCeiling: 131072},
		"reported":         {WindowTokens: 262144, ReserveTokens: 16384, OutputRaiseCeiling: 16384},
		"user-set":         {WindowTokens: 262144, ReserveTokens: 50000, OutputRaiseCeiling: 131072},
		"over-ceiling":     {WindowTokens: 100000, ReserveTokens: 20000, ReserveDerived: true, OutputRaiseCeiling: 50000},
	} {
		if got := resolve(worker.ModelConfig{Provider: providerName, Model: model}); got != want {
			t.Errorf("%s: resolver = %+v, want %+v", model, got, want)
		}
	}
	// With no window known there is nothing to derive from, so nothing may
	// claim to have been derived.
	if got := resolve(worker.ModelConfig{Provider: providerName, Model: "unlisted"}); got.ReserveDerived {
		t.Errorf("unlisted model with no window claims a derived reserve: %+v", got)
	}
}

// TestWindowResolverReportsHowFarMaxOutputCanRise pins the ceiling a one-off
// retry may raise Max output to: the limit the provider itself states, even
// beneath a lower user override; half the window when it states none; and
// nothing at all on a provider whose transport has no per-request output knob.
func TestWindowResolverReportsHowFarMaxOutputCanRise(t *testing.T) {
	userpathstest.Isolate(t)
	const raisable, fixed = "test_capability_raise", "test_capability_raise_fixed"
	provider.RegisterProvider(provider.ProviderInfo{Name: raisable},
		func(provider.Config) (provider.Provider, error) { return nil, nil })
	provider.RegisterProvider(provider.ProviderInfo{Name: fixed, FixedOutputCap: true},
		func(provider.Config) (provider.Provider, error) { return nil, nil })

	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Models.Limits = map[string]map[string]core.ModelLimits{raisable: {
			"lowered": {MaxOutputTokens: 8000},
		}}
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
	s := &Server{settings: newSettingsStore()}
	settings := s.settings.get()
	published := []ModelWithContext{
		{ID: "lowered", ContextWindow: 200000, MaxOutputTokens: 64000, FromAPI: true},
	}
	for i, m := range published {
		published[i] = withDerivedOutputBudget(applyModelLimits(m, settings.ModelLimitsFor(raisable, m.ID)), false)
	}
	providers := []ProviderStatus{
		{Name: raisable, ModelsWithContext: published},
		{Name: fixed, ModelsWithContext: []ModelWithContext{{ID: "local", ContextWindow: 262144}}},
	}
	s.providersList.Store(&providers)

	resolve := s.createWindowResolver()
	if got := resolve(worker.ModelConfig{Provider: raisable, Model: "lowered"}); got.ReserveTokens != 8000 || got.OutputRaiseCeiling != 64000 {
		t.Errorf("lowered: resolver = %+v, want reserve 8000 under the provider's own 64000 ceiling", got)
	}
	if got := resolve(worker.ModelConfig{Provider: fixed, Model: "local"}); got.OutputRaiseCeiling != 0 {
		t.Errorf("fixed-cap provider offers a raise: %+v", got)
	}
}

// TestPublishedModelCarriesDerivedOutputBudget pins the number the settings UI
// shows in place of a bare "auto": the budget admission will actually charge
// for a model whose provider reports no usable output limit, worked out by the
// server so the browser never re-implements the formula.
func TestPublishedModelCarriesDerivedOutputBudget(t *testing.T) {
	tests := []struct {
		name            string
		model           ModelWithContext
		limits          core.ModelLimits
		providerDerived bool
		wantDerived     int
		wantMaxOutput   int
	}{
		{name: "an unreported cap derives from the window",
			model: ModelWithContext{ContextWindow: 262144}, wantDerived: 32768},
		{name: "a reported cap derives nothing",
			model: ModelWithContext{ContextWindow: 262144, MaxOutputTokens: 16384}, wantDerived: 0, wantMaxOutput: 16384},
		{name: "a cap the provider derived is labelled as derived",
			model: ModelWithContext{ContextWindow: 262144, MaxOutputTokens: 32768}, providerDerived: true,
			wantDerived: 32768, wantMaxOutput: 32768},
		{name: "a user override keeps the derived figure as what clearing restores",
			model: ModelWithContext{ContextWindow: 262144}, limits: core.ModelLimits{MaxOutputTokens: 50000},
			wantDerived: 32768, wantMaxOutput: 50000},
		{name: "a window override derives from the window in force",
			model: ModelWithContext{ContextWindow: 8192}, limits: core.ModelLimits{ContextWindow: 524288},
			wantDerived: 64000},
		{name: "an unknown window derives nothing",
			model: ModelWithContext{}, wantDerived: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := withDerivedOutputBudget(applyModelLimits(test.model, test.limits), test.providerDerived)
			if got.DerivedMaxOutputTokens != test.wantDerived || got.MaxOutputTokens != test.wantMaxOutput {
				t.Fatalf("derived/max = %d/%d, want %d/%d",
					got.DerivedMaxOutputTokens, got.MaxOutputTokens, test.wantDerived, test.wantMaxOutput)
			}
		})
	}
}

// TestApplyModelLimitsPublishesEffectiveAndReportedValues pins what the
// catalogue puts on the wire: consumers read one effective number, and the
// provider's own is preserved beside it only where an override replaced it, so
// the settings UI can show what clearing the field restores.
func TestApplyModelLimitsPublishesEffectiveAndReportedValues(t *testing.T) {
	base := ModelWithContext{ID: "m", ContextWindow: 128000, MaxOutputTokens: 16384}

	t.Run("no override leaves the entry untouched", func(t *testing.T) {
		got := applyModelLimits(base, core.ModelLimits{})
		if got.ContextWindow != 128000 || got.MaxOutputTokens != 16384 {
			t.Fatalf("limits = %d/%d, want the provider's 128000/16384", got.ContextWindow, got.MaxOutputTokens)
		}
		if got.ProviderContextWindow != nil || got.ProviderMaxOutputTokens != nil {
			t.Fatal("reported values published without an override — the UI would read that as overridden")
		}
	})

	t.Run("one override replaces one field and records it", func(t *testing.T) {
		got := applyModelLimits(base, core.ModelLimits{ContextWindow: 1000000})
		if got.ContextWindow != 1000000 {
			t.Fatalf("context window = %d, want the override 1000000", got.ContextWindow)
		}
		if got.ProviderContextWindow == nil || *got.ProviderContextWindow != 128000 {
			t.Fatalf("reported window = %v, want 128000", got.ProviderContextWindow)
		}
		if got.MaxOutputTokens != 16384 || got.ProviderMaxOutputTokens != nil {
			t.Fatalf("output limit disturbed: %d / %v", got.MaxOutputTokens, got.ProviderMaxOutputTokens)
		}
	})

	t.Run("a provider that reports nothing overrides to a recorded zero", func(t *testing.T) {
		// The pointer is why this is expressible: a plain int could not tell
		// "provider reported 0" from "not overridden".
		got := applyModelLimits(ModelWithContext{ID: "m"}, core.ModelLimits{ContextWindow: 64000})
		if got.ContextWindow != 64000 {
			t.Fatalf("context window = %d, want 64000", got.ContextWindow)
		}
		if got.ProviderContextWindow == nil || *got.ProviderContextWindow != 0 {
			t.Fatalf("reported window = %v, want a recorded 0", got.ProviderContextWindow)
		}
	})
}

// TestResolveModelCapabilitiesDerivesOneEffectiveOutputLimit pins the unified
// output-limit policy on the snapshot: a known window with no output limit
// from any source gets the shared derived reserve (the same value admission
// charges and the wire sends), while explicit limits from any source win.
func TestResolveModelCapabilitiesDerivesOneEffectiveOutputLimit(t *testing.T) {
	const providerName = "test_capability_output_unification"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:                providerName,
		ModelContextWindows: map[string]int{"context-only": 100000, "huge-context": 400000},
	}, func(provider.Config) (provider.Provider, error) { return nil, nil })

	s := &Server{}
	providers := []ProviderStatus{{
		Name: providerName,
		ModelsWithContext: []ModelWithContext{
			{ID: "live-explicit", ContextWindow: 128000, MaxOutputTokens: 8192},
			{ID: "live-context-only", ContextWindow: 64000},
			{ID: "live-cap-equals-window", ContextWindow: 50000, MaxOutputTokens: 50000},
			{ID: "live-cap-above-window", ContextWindow: 50000, MaxOutputTokens: 60000},
		},
	}}
	s.providersList.Store(&providers)

	tests := []struct {
		name  string
		model string
		want  provider.ModelCapabilities
	}{
		{
			name:  "small window derives a fifth",
			model: "context-only",
			want:  provider.ModelCapabilities{ContextWindowTokens: 100000, MaxOutputTokens: 20000},
		},
		{
			name:  "huge window derives an eighth",
			model: "huge-context",
			want:  provider.ModelCapabilities{ContextWindowTokens: 400000, MaxOutputTokens: 50000},
		},
		{
			name:  "explicit live limit wins over derivation",
			model: "live-explicit",
			want:  provider.ModelCapabilities{ContextWindowTokens: 128000, MaxOutputTokens: 8192},
		},
		{
			name:  "live context-only derives reserve",
			model: "live-context-only",
			want:  provider.ModelCapabilities{ContextWindowTokens: 64000, MaxOutputTokens: 12800},
		},
		{
			// F2: an output cap equal to the window leaves no input room; clamp
			// it to the derived reserve so admission never bricks the model.
			name:  "reported cap equal to window clamps to derived reserve",
			model: "live-cap-equals-window",
			want:  provider.ModelCapabilities{ContextWindowTokens: 50000, MaxOutputTokens: provider.ContextSafetyReserve(50000)},
		},
		{
			name:  "reported cap above window clamps to derived reserve",
			model: "live-cap-above-window",
			want:  provider.ModelCapabilities{ContextWindowTokens: 50000, MaxOutputTokens: provider.ContextSafetyReserve(50000)},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := s.resolveModelCapabilities(providerName, test.model); got != test.want {
				t.Fatalf("resolveModelCapabilities() = %+v, want %+v", got, test.want)
			}
		})
	}
}
