//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"juggler/internal/ingress"
	"juggler/tests/helpers"
)

// upgradeFixtureDir holds config dirs as v0.8.0 left them, before provider
// accounts existed. A credentials file is stored as credentials.json.fixture,
// because credentials.json is ignored repo-wide, and gets its real name when
// the fixture is copied into place.
const upgradeFixtureDir = "testdata/upgrade-v0.8.0"

// providerEnvVars are every variable a provider in these fixtures could read a
// key or a login location from. The harness inherits the developer's
// environment, so each is pinned: a real key in it would otherwise show up as
// an account the fixture never had.
var providerEnvVars = []string{
	"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY",
	"OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY",
	"GH_COPILOT_TOKEN", "GITHUB_COPILOT_TOKEN", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
	"OPENAI_COMPATIBLE_API_KEY", "CUSTOM_ACME_API_KEY", "CUSTOM_OLDBOX_API_KEY",
}

// accountRow and candidateRow are the parts of the accounts.list op this test
// holds to.
type accountRow struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	DisplayName string         `json:"displayName"`
	IsDefault   bool           `json:"isDefault"`
	KeySource   string         `json:"keySource"`
	Settings    map[string]any `json:"settings"`
}

type candidateRow struct {
	Type      string `json:"type"`
	AccountID string `json:"accountId"`
	Reason    string `json:"reason"`
}

type accountsList struct {
	Accounts   []accountRow   `json:"accounts"`
	Candidates []candidateRow `json:"candidates"`
}

// upgradeRun is one session child started on a copy of a fixture config dir.
type upgradeRun struct {
	t         *testing.T
	iso       isolatedRun
	env       []string
	project   string
	configDir string
	token     string
	addr      string
	stop      func()
}

func startOnFixture(t *testing.T, fixture string, extraEnv map[string]string) *upgradeRun {
	t.Helper()
	iso := newIsolatedRun(t)
	configDir := filepath.Join(iso.base, "config")
	copyFixture(t, filepath.Join(upgradeFixtureDir, fixture), configDir)

	token := ingress.NewSecret()
	env := helpers.EnvWithOverride(iso.env, "JUGGLER_CONFIG_DIR", configDir)
	env = helpers.EnvWithOverride(env, ingress.SecretEnv, ingress.NewSecret())
	env = helpers.EnvWithOverride(env, ingress.TokenEnv, token)
	for _, name := range providerEnvVars {
		env = helpers.EnvWithOverride(env, name, "")
	}
	for k, v := range extraEnv {
		env = helpers.EnvWithOverride(env, k, v)
	}
	r := &upgradeRun{t: t, iso: iso, env: env, project: newProjectDir(t), configDir: configDir, token: token}
	r.addr, r.stop = startStoppableChild(t, iso, env, r.project)
	return r
}

func (r *upgradeRun) restart() {
	r.t.Helper()
	r.stop()
	r.addr, r.stop = startStoppableChild(r.t, r.iso, r.env, r.project)
}

func (r *upgradeRun) listAccounts() accountsList {
	r.t.Helper()
	body, _ := json.Marshal(map[string]any{"toolId": "accounts", "operation": "list", "params": map[string]any{}})
	req, err := http.NewRequest(http.MethodPost, "http://"+r.addr+"/api/ops/call", bytes.NewReader(body))
	if err != nil {
		r.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Juggler-Token", r.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatalf("accounts.list: %v", err)
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var envelope struct {
		Success bool         `json:"success"`
		Error   string       `json:"error"`
		Data    accountsList `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.Success {
		r.t.Fatalf("accounts.list: status %d, error %q: %s", resp.StatusCode, envelope.Error, data)
	}
	return envelope.Data
}

func (r *upgradeRun) read(rel string) []byte {
	r.t.Helper()
	data, err := os.ReadFile(filepath.Join(r.configDir, rel))
	if err != nil {
		r.t.Fatalf("read %s: %v", rel, err)
	}
	return data
}

// copyFixture copies a fixture tree to dst, dropping the .fixture suffix.
func copyFixture(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, strings.TrimSuffix(rel, ".fixture"))
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
	if err != nil {
		t.Fatalf("copy fixture %s: %v", src, err)
	}
}

func accountByID(list accountsList, id string) (accountRow, bool) {
	for _, a := range list.Accounts {
		if a.ID == id {
			return a, true
		}
	}
	return accountRow{}, false
}

func hasCandidate(list accountsList, accountID, reason string) bool {
	for _, c := range list.Candidates {
		if c.AccountID == accountID && c.Reason == reason {
			return true
		}
	}
	return false
}

// TestProviderAccountsUpgrade starts the server on config dirs exactly as the
// last release before provider accounts left them, and holds the upgrade to its
// promise: no login, key, setting or model selection is lost, everything keeps
// the id every stored reference names, and nothing a downgrade would read is
// rewritten. A failure here is silent in the product: the user simply finds a
// provider, a key or a chosen model gone.
func TestProviderAccountsUpgrade(t *testing.T) {
	t.Run("with endpoints", func(t *testing.T) {
		const fixture = "with-endpoints"
		r := startOnFixture(t, fixture, map[string]string{"OPENAI_API_KEY": "sk-openai-from-env"})

		src := filepath.Join(upgradeFixtureDir, fixture)
		original := func(rel string) []byte {
			data, err := os.ReadFile(filepath.Join(src, rel))
			if err != nil {
				t.Fatal(err)
			}
			return data
		}

		check := func(t *testing.T) {
			list := r.listAccounts()

			// Every default account keeps its bare id, and its key is found
			// where it always was.
			for id, source := range map[string]string{
				"anthropic": "credentials",
				"mistral":   "credentials",
				"openai":    "env",
			} {
				a, ok := accountByID(list, id)
				if !ok {
					t.Fatalf("no %s account; accounts: %+v", id, list.Accounts)
				}
				if a.Type != id || !a.IsDefault || a.KeySource != source {
					t.Errorf("%s = %+v; want type %s, default, key from %s", id, a, id, source)
				}
			}
			if a, ok := accountByID(list, "copilot"); !ok || !a.IsDefault {
				t.Errorf("the stored Copilot login is not the default copilot account: %+v (found %v)", a, ok)
			}

			// The custom endpoints are accounts under the ids they registered
			// as, with their keys and definitions.
			for id, url := range map[string]string{
				"custom-acme":       "http://127.0.0.1:9/acme/v1",
				"openai-compatible": "http://127.0.0.1:9/legacy/v1",
			} {
				a, ok := accountByID(list, id)
				if !ok {
					t.Fatalf("no %s account; accounts: %+v", id, list.Accounts)
				}
				if a.Type != "openai-compatible" || a.KeySource != "credentials" || a.Settings["baseURL"] != url {
					t.Errorf("%s = %+v; want an openai-compatible account at %s with its stored key", id, a, url)
				}
			}
			if a, _ := accountByID(list, "custom-acme"); a.DisplayName != "Acme gateway" {
				t.Errorf("custom-acme is named %q; want Acme gateway", a.DisplayName)
			}

			// What was switched off is offered back, not added.
			if _, ok := accountByID(list, "claudecode"); ok {
				t.Errorf("the switched-off Claude Code came back as an account")
			}
			if !hasCandidate(list, "claudecode", "removed") {
				t.Errorf("the switched-off Claude Code is not offered under Found; candidates: %+v", list.Candidates)
			}
			if _, ok := accountByID(list, "custom-oldbox"); ok {
				t.Errorf("the switched-off endpoint came back as an account")
			}
			if !hasCandidate(list, "custom-oldbox", "switched-off") {
				t.Errorf("the switched-off endpoint is not offered under Found; candidates: %+v", list.Candidates)
			}

			// A downgrade reads these, and nothing about the upgrade may touch them.
			for _, rel := range []string{"custom-providers.json", "default-model.json", "cheap-model.json", "decision-model.json", "cache/recent-models.json"} {
				if got := r.read(rel); !bytes.Equal(got, original(rel)) {
					t.Errorf("%s changed:\n%s\nwant:\n%s", rel, got, original(rel))
				}
			}
			var wantCreds, gotCreds map[string]string
			_ = json.Unmarshal(original("credentials.json.fixture"), &wantCreds)
			if err := json.Unmarshal(r.read("credentials.json"), &gotCreds); err != nil {
				t.Fatalf("credentials.json: %v", err)
			}
			for k, v := range wantCreds {
				if gotCreds[k] != v {
					t.Errorf("credentials.json %s = %q; want %q", k, gotCreds[k], v)
				}
			}
			var wantSettings, gotSettings struct {
				Models json.RawMessage `json:"models"`
			}
			_ = json.Unmarshal(original("settings.json"), &wantSettings)
			_ = json.Unmarshal(r.read("settings.json"), &gotSettings)
			var wm, gm any
			_ = json.Unmarshal(wantSettings.Models, &wm)
			_ = json.Unmarshal(gotSettings.Models, &gm)
			if !reflect.DeepEqual(wm, gm) {
				t.Errorf("settings.json models = %s; want %s", gotSettings.Models, wantSettings.Models)
			}
			if _, err := os.Stat(filepath.Join(r.configDir, "accounts.json")); err != nil {
				t.Errorf("accounts.json was not written: %v", err)
			}
		}

		check(t)
		// The migration runs once: a second start reads accounts.json and
		// leaves the old file alone.
		r.restart()
		check(t)
	})

	t.Run("legacy credentials only", func(t *testing.T) {
		r := startOnFixture(t, "legacy-only", nil)
		list := r.listAccounts()
		a, ok := accountByID(list, "openai-compatible")
		if !ok {
			t.Fatalf("the raw-credential endpoint did not become the openai-compatible account; accounts: %+v", list.Accounts)
		}
		if a.KeySource != "credentials" || a.Settings["baseURL"] != "http://127.0.0.1:9/legacy/v1" {
			t.Errorf("openai-compatible = %+v; want its stored key and base URL", a)
		}
		if got := r.read("default-model.json"); !bytes.Contains(got, []byte(`"openai-compatible"`)) {
			t.Errorf("default-model.json changed: %s", got)
		}
	})
}
