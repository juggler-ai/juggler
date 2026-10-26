//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package audit

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// modelsDevIDs maps each built-in provider with a hand-kept table to the
// models.dev provider describing the same service. It is explicit rather than
// matched by base URL because models.dev records no URL for a provider with a
// dedicated SDK (OpenAI, Anthropic, Google, Mistral) — the very tables most
// worth checking — and the URLs it does record do not always match ours to the
// path.
var modelsDevIDs = map[string]string{
	"openai":      "openai",
	"anthropic":   "anthropic",
	"gemini":      "google",
	"mistral":     "mistral",
	"deepseek":    "deepseek",
	"moonshot":    "moonshotai-cn",
	"zai":         "zai-coding-plan",
	"opencodezen": "opencode",
}

// unitSlack is how far below models.dev a window may sit and still agree. The
// two sides often count the same window in different units — a vendor's "1M"
// or "256K" is 1,000,000 or 256,000 in one place and 1,048,576 or 262,144 in
// the other — and 2^20 is 4.9% above 10^6. A gap that size, with ours the
// lower, is a rounding convention, not drift.
const unitSlack = 0.05

// modelsDevDisagreements records the built-in limits that differ from
// models.dev on purpose, keyed "provider/model", each with the reason ours is
// the right number. An entry is a decision; anything not listed here that
// disagrees fails the audit.
var modelsDevDisagreements = map[string]string{
	"mistral/codestral-2508": "Mistral's docs say 128k; models.dev's 256000 is the endpoint's card, and of the two the smaller cannot overrun (see mistral/models.go). " +
		"Its 8192 output cap comes from a third-party router; Mistral publishes none, and output shares the window",
	"mistral/codestral-latest": "an alias of codestral-2508, same reasoning; models.dev's 4096 output cap cites no source",
}

// TestModelsDevDrift compares the hand-kept built-in model tables with the
// models.dev catalogue, without touching any provider's API. It is the half of
// `make models-sync` that keeps the tables honest between releases.
//
// For each model a mapped provider catalogues, it fails where ours promises
// more than models.dev states (a window or output cap above its figure), or
// where our window is so far below it that the table has fallen behind —
// unless modelsDevDisagreements says why ours is right — and logs a model
// models.dev does not list. It also logs the
// models models.dev lists that the table does not — a new release is usually
// the first sign a table has fallen behind, though plenty of what it lists
// (embeddings, speech, retired ids) never belongs in one.
//
// Opt-in: it reads the full upstream catalogue that `make models-sync` keeps
// beside the build, named by JUGGLER_MODELSDEV_API.
func TestModelsDevDrift(t *testing.T) {
	path := os.Getenv("JUGGLER_MODELSDEV_API")
	if path == "" {
		t.Skip("set JUGGLER_MODELSDEV_API to a models.dev api.json (`make models-sync` does) to audit the built-in tables against it")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var upstream map[string]struct {
		Models map[string]struct {
			Limit struct {
				Context int64 `json:"context"`
				Output  int64 `json:"output"`
			} `json:"limit"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &upstream); err != nil {
		t.Fatalf("decoding %s: %v", path, err)
	}

	registerCatalogProviders()
	infos := map[string]provider.ProviderInfo{}
	for _, info := range provider.ListProviderInfos() {
		infos[info.Name] = info
	}

	names := make([]string, 0, len(modelsDevIDs))
	for name := range modelsDevIDs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		devID := modelsDevIDs[name]
		t.Run(name, func(t *testing.T) {
			info, ok := infos[name]
			if !ok {
				t.Fatalf("no built-in provider %q is registered; update modelsDevIDs", name)
			}
			dev, ok := upstream[devID]
			if !ok {
				t.Fatalf("models.dev has no provider %q any more; update modelsDevIDs", devID)
			}
			folded := make(map[string]string, len(dev.Models))
			for id := range dev.Models {
				folded[strings.ToLower(id)] = id
			}

			ours := make([]string, 0, len(info.ModelContextWindows))
			for id := range info.ModelContextWindows {
				ours = append(ours, id)
			}
			sort.Strings(ours)

			var unlisted []string
			seen := map[string]bool{}
			for _, id := range ours {
				devModelID, listed := folded[strings.ToLower(id)]
				if !listed {
					unlisted = append(unlisted, id)
					continue
				}
				seen[devModelID] = true
				d := dev.Models[devModelID].Limit

				window := int64(info.ModelContextWindows[id])
				var output int64
				if info.ResolveModelCapabilities != nil {
					if caps, ok := info.ResolveModelCapabilities(id); ok {
						output = caps.MaxOutputTokens
					}
				}

				key := name + "/" + id
				if reason, decided := modelsDevDisagreements[key]; decided {
					t.Logf("%s: differs from models.dev on purpose: %s", key, reason)
					continue
				}
				switch {
				case d.Context <= 0:
				case window > d.Context:
					t.Errorf("%s: window %d is above the %d models.dev states — an over-long request is rejected, or silently truncated", key, window, d.Context)
				case float64(window) < float64(d.Context)*(1-unitSlack):
					t.Errorf("%s: window %d is well below the %d models.dev states — the model compacts long before it needs to", key, window, d.Context)
				}
				// Only a cap above models.dev's is a fault: models.dev states
				// the most a model can produce (sometimes its whole window), and
				// a lower cap of ours is a choice about how much to reserve. A
				// zero one is left to the derived reserve.
				if d.Output > 0 && output > d.Output {
					t.Errorf("%s: output cap %d is above the %d models.dev states — a request asking for it is a 400", key, output, d.Output)
				}
			}

			var missing []string
			for id := range dev.Models {
				if !seen[id] {
					missing = append(missing, id)
				}
			}
			sort.Strings(missing)
			if len(unlisted) > 0 {
				t.Logf("catalogued here, not listed by models.dev/%s (%d): %s", devID, len(unlisted), strings.Join(unlisted, ", "))
			}
			if len(missing) > 0 {
				t.Logf("listed by models.dev/%s, not catalogued here (%d): %s", devID, len(missing), strings.Join(missing, ", "))
			}
		})
	}
}
