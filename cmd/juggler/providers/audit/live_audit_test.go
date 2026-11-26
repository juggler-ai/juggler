//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package audit

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

// strictCatalogCoverage names the providers where a served-but-uncatalogued
// model is a fault rather than a design.
//
// The difference is what the provider's default MEANS. z.ai, Moonshot and
// Mistral set a default that describes their current line, so an unlisted model
// inheriting it is the intended answer and usually right. OpenAI and DeepSeek
// set a last-resort figure that is a guess about a model nobody catalogued —
// and since neither endpoint publishes limits, a model that lands on it is
// running on that guess forever, with no symptom but early compaction.
var strictCatalogCoverage = map[string]bool{
	"openai":   true,
	"deepseek": true,
}

// conservativeCatalog names providers whose static entries are deliberately
// LOWER than what the endpoint reports, so the two disagreeing is a decision
// rather than drift.
//
// openaicodex is the case: its static windows are used only when the ChatGPT
// catalog is unreachable or the user is signed out, which makes them guesses
// about a backend we could not reach. Guessing low compacts early; guessing
// high walks a fully-built prompt into a rejection. See openaicodex/models.go.
// A catalog entry ABOVE the endpoint is still a failure here — that is
// over-promising, which is the direction with a hard failure at the end of it.
var conservativeCatalog = map[string]bool{
	"openaicodex": true,
}

// sanityBounds is the range a model's limits must fall in for one provider, for
// the providers where a number outside it is evidence of a fault rather than a
// surprise. A provider absent from this map is still audited for drift; it
// simply has no independent floor to check against.
//
// These are the "could this possibly be right" bounds, not the catalog. z.ai's
// entry is the one this began as: a per-provider live test that only z.ai had.
var sanityBounds = map[string]struct {
	minWindow, minOutput, maxOutput int
}{
	// The documented catalog floor, and the coding endpoint's max_tokens
	// ceiling (it rejects anything above 131072).
	"zai": {minWindow: 128000, minOutput: 16000, maxOutput: 131072},
	// Every model DeepSeek serves is 1M/384K.
	"deepseek": {minWindow: 1000000, minOutput: 32768, maxOutput: 384000},
	// The oldest model OpenAI still serves is gpt-4 at 8192.
	"openai": {minWindow: 8192, minOutput: 4096, maxOutput: 272000},
	// Claude 4.5 and below are 200K; nothing smaller is served.
	"anthropic": {minWindow: 200000, minOutput: 4096, maxOutput: 128000},
}

// TestCatalogDrift compares what each provider currently serves against what
// Juggler says about it, and is the answer to the question this whole area
// keeps raising: how do we find out a limit went stale before a user does?
//
// It reports three things, and treats them differently because they are not
// equally certain:
//
//   - A model the provider serves that our catalog has never heard of, whose
//     limits it also does not publish. That model is running on a flat default
//     right now. It fails the audit: it is the exact shape of "catalogued at
//     128k, actually 1M", which is invisible in use — the model works and
//     merely compacts eight times sooner than it needed to.
//   - A published limit that disagrees with our catalogued one. Also a failure:
//     one of the two numbers is wrong, and it is not the provider's.
//   - A catalogued model the provider no longer lists. Only logged. A model can
//     be missing from one plan or one key and perfectly valid on another, so
//     this is a prompt to check, not a verdict.
//
// Opt-in, because it spends a network round-trip per provider against your real
// keys, and skipped entirely in `make test`. Run it before a release, or after
// any vendor announcement:
//
//	JUGGLER_MODELS_AUDIT=1 make test-go RUN='TestCatalogDrift'
//
// Credentials come from wherever the app would find them (the credentials store
// and the provider environment variables), so it audits exactly the providers
// you have configured and names the ones it had to skip.
func TestCatalogDrift(t *testing.T) {
	if os.Getenv("JUGGLER_MODELS_AUDIT") != "1" {
		t.Skip("set JUGGLER_MODELS_AUDIT=1 to run the live catalog drift audit (one network call per configured provider)")
	}

	registerCatalogProviders()
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatalf("credentials store: %v", err)
	}

	var skipped []string
	audited := 0
	for _, info := range provider.ListProviderInfos() {
		cred, err := credStore.GetProviderCredential(info.Name)
		if err != nil {
			skipped = append(skipped, info.Name)
			continue
		}
		audited++
		t.Run(info.Name, func(t *testing.T) {
			auditProvider(t, info, cred)
		})
	}

	sort.Strings(skipped)
	t.Logf("audited %d provider(s); no credentials for: %v", audited, skipped)
	if audited == 0 {
		t.Skip("no provider had credentials, so nothing was compared")
	}
}

func auditProvider(t *testing.T, info provider.ProviderInfo, cred core.ProviderCredential) {
	t.Helper()

	client, err := provider.InitializeProvider(info.Name, provider.Config{
		APIKey:      cred.APIKey,
		BearerToken: cred.BearerToken,
		Headers:     cred.Headers,
		Model:       "placeholder-for-listing-models",
	})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	live, err := client.ListModelsWithInfo(ctx)
	if err != nil {
		// A local daemon that is not running, or a key that no longer works, is
		// not drift. Say so and move on rather than reporting it as a stale
		// catalog.
		t.Skipf("could not list models, so nothing was compared: %v", err)
	}
	if len(live) == 0 {
		t.Fatal("the provider listed no models at all")
	}

	bounds, hasBounds := sanityBounds[info.Name]
	served := make(map[string]bool, len(live))

	for _, model := range live {
		id := catalogKey(model.ID)
		served[id] = true
		// Ask the provider's own resolver rather than the map: a provider may
		// reach an entry by more than one id (OpenAI resolves a dated snapshot
		// through its undated alias), and a model that resolves is catalogued
		// however it got there.
		catalogued, inCatalog := catalogWindow(info, id)

		switch {
		case model.FromAPI && inCatalog && model.ContextWindow != catalogued:
			// The endpoint and the catalog disagree. The endpoint wins at
			// runtime, so nothing is broken today — but the catalog is what
			// answers when the list cannot be fetched, and it is now wrong.
			if conservativeCatalog[info.Name] && catalogued < model.ContextWindow {
				t.Logf("NOTE: %s: endpoint reports %d, the catalog deliberately says %d", model.ID, model.ContextWindow, catalogued)
				break
			}
			t.Errorf("%s: endpoint reports a %d window, the catalog says %d — the offline answer is stale",
				model.ID, model.ContextWindow, catalogued)
		case !model.FromAPI && !inCatalog:
			// Nothing knows this model's size and nothing can learn it. It is
			// running on a flat default right now.
			message := "%s: served but uncatalogued, and the endpoint publishes no limits — it is running on the %d default"
			if !strictCatalogCoverage[info.Name] {
				t.Logf("NOTE: "+message, model.ID, model.ContextWindow)
				break
			}
			t.Errorf(message, model.ID, model.ContextWindow)
		}

		if !hasBounds {
			continue
		}
		if model.ContextWindow < bounds.minWindow {
			t.Errorf("%s: context window %d is below this provider's %d floor", model.ID, model.ContextWindow, bounds.minWindow)
		}
		if model.MaxOutputTokens < bounds.minOutput || model.MaxOutputTokens > bounds.maxOutput {
			t.Errorf("%s: output cap %d outside the plausible [%d, %d]", model.ID, model.MaxOutputTokens, bounds.minOutput, bounds.maxOutput)
		}
		if model.MaxOutputTokens >= model.ContextWindow {
			t.Errorf("%s: output cap %d leaves no room for input in a %d window", model.ID, model.MaxOutputTokens, model.ContextWindow)
		}
	}

	// Catalogued but not served. Logged, not failed: a model can be withheld
	// from one plan or one key and be perfectly alive on another.
	var unserved []string
	for id := range info.ModelContextWindows {
		if !served[id] {
			unserved = append(unserved, id)
		}
	}
	sort.Strings(unserved)
	for _, id := range unserved {
		t.Logf("NOTE: catalogued %q, but this account's model list omits it — check whether it was retired", id)
	}
	t.Logf("compared %d served model(s) against %d catalogued", len(live), len(info.ModelContextWindows))
}

// catalogWindow returns the window Juggler holds for a model with no live list
// in hand, and whether anything holds one at all. It prefers the provider's
// capability resolver, which is what admission itself consults, and falls back
// to the published map for a provider that has no resolver.
func catalogWindow(info provider.ProviderInfo, modelID string) (int, bool) {
	if info.ResolveModelCapabilities != nil {
		if caps, found := info.ResolveModelCapabilities(modelID); found && caps.ContextWindowTokens > 0 {
			return int(caps.ContextWindowTokens), true
		}
	}
	window, found := info.ModelContextWindows[modelID]
	return window, found
}

// catalogKey normalises a provider-reported model id to the form the catalogs
// are keyed by. Gemini returns ids carrying the collection prefix
// ("models/gemini-3.8-flash") while its catalog is keyed on the bare id, so
// without this every Gemini model reads as both uncatalogued and unserved.
func catalogKey(modelID string) string {
	return strings.TrimPrefix(modelID, "models/")
}
