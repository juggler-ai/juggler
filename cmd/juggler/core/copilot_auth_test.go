//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// resetCopilotState forgets every Copilot account's state — extra accounts,
// bearers, labels — so a test starts, and leaves, as a fresh process would.
func resetCopilotState() {
	copilotStateGate <- struct{}{}
	ids := make([]string, 0, len(copilotAccounts))
	for id := range copilotAccounts {
		ids = append(ids, id)
	}
	<-copilotStateGate
	for _, id := range ids {
		ForgetCopilotAccount(id)
	}
	copilotStateGate <- struct{}{}
	copilotCaches = map[string]copilotCachedToken{}
	copilotLabels = map[string]copilotLabel{}
	copilotExchangeGates = map[string]chan struct{}{}
	<-copilotStateGate
}

// defaultCopilotBearer is the default account's resolved bearer.
func defaultCopilotBearer() (string, error) {
	cred, err := resolveCopilotCredential("")
	return cred.BearerToken, err
}

func TestLoadCopilotOAuthToken(t *testing.T) {
	t.Run("apps.json", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir()) // isolate the credentials store
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:Iv1.b507a08c87ecfe98":{"user":"octocat","oauth_token":"gho_apps"}}`)
		login, err := loadCopilotLogin()
		if err != nil || login.token != "gho_apps" || login.host != "github.com" {
			t.Fatalf("login=%+v err=%v, want gho_apps@github.com", login, err)
		}
	})

	t.Run("apps.json ghe.com", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		// A GitHub Enterprise Cloud (data residency) login: the only entry, so it
		// is reused automatically with no host configuration.
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"acme.ghe.com:Iv1.b507a08c87ecfe98":{"user":"octocat","oauth_token":"gho_ghe"}}`)
		login, err := loadCopilotLogin()
		if err != nil || login.token != "gho_ghe" || login.host != "acme.ghe.com" {
			t.Fatalf("login=%+v err=%v, want gho_ghe@acme.ghe.com", login, err)
		}
		if got := resolveCopilotExchangeURL(login.host); got != "https://api.acme.ghe.com/copilot_internal/v2/token" {
			t.Fatalf("exchange URL = %q, want the tenant's api host", got)
		}
	})

	t.Run("github.com preferred over ghe.com when both present", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"acme.ghe.com:x":{"oauth_token":"gho_ghe"},"github.com:y":{"oauth_token":"gho_dotcom"}}`)
		login, err := loadCopilotLogin()
		if err != nil || login.host != "github.com" {
			t.Fatalf("login=%+v err=%v, want github.com to win by default", login, err)
		}
	})

	t.Run("hosts.json fallback", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "hosts.json"),
			`{"github.com":{"oauth_token":"gho_hosts"}}`)
		login, err := loadCopilotLogin()
		if err != nil || login.token != "gho_hosts" || login.host != "github.com" {
			t.Fatalf("login=%+v err=%v, want gho_hosts@github.com", login, err)
		}
	})

	t.Run("stored device token beats editor files", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:x":{"oauth_token":"gho_apps"}}`)
		if err := storeCopilotOAuthToken("gho_device", "github.com"); err != nil {
			t.Fatalf("store: %v", err)
		}
		t.Cleanup(func() { _ = clearCopilotDeviceLogin() })
		login, err := loadCopilotLogin()
		if err != nil || login.token != "gho_device" {
			t.Fatalf("login=%+v err=%v, want gho_device", login, err)
		}
		if copilotStoredOAuthToken() == "" {
			t.Fatal("no device-flow login is stored")
		}
		if err := clearCopilotDeviceLogin(); err != nil {
			t.Fatalf("clear: %v", err)
		}
		// After sign-out the editor file wins again.
		if login, _ := loadCopilotLogin(); login.token != "gho_apps" {
			t.Fatalf("post-signout token=%q, want gho_apps", login.token)
		}
	})

	t.Run("env override wins", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "gho_env")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:x":{"oauth_token":"gho_apps"}}`)
		login, err := loadCopilotLogin()
		if err != nil || login.token != "gho_env" {
			t.Fatalf("token=%q err=%v, want gho_env", login.token, err)
		}
	})

	t.Run("missing login errors", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		t.Setenv("XDG_CONFIG_HOME", t.TempDir())
		if _, err := loadCopilotLogin(); err == nil {
			t.Fatal("expected error when no login present")
		}
	})
}

func TestExchangeNormalizesIndividualHost(t *testing.T) {
	resetCopilotState()
	t.Cleanup(resetCopilotState)
	t.Setenv("GH_COPILOT_TOKEN", "gho_oauth")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"token":"t","expires_at":%d,"endpoints":{"api":"https://api.individual.githubcopilot.com"}}`,
			time.Now().Add(30*time.Minute).Unix())
	}))
	defer srv.Close()
	orig := copilotTokenExchangeURL
	copilotTokenExchangeURL = srv.URL
	t.Cleanup(func() { copilotTokenExchangeURL = orig })

	if _, err := defaultCopilotBearer(); err != nil {
		t.Fatalf("defaultCopilotBearer: %v", err)
	}
	// The individual subdomain is rewritten to the bare host the editor clients use.
	if base := CopilotAPIBase(""); base != "https://api.githubcopilot.com" {
		t.Fatalf("CopilotAPIBase(\"\") = %q, want bare individual host", base)
	}
}

func TestPollCopilotDeviceLoginStatuses(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	resetCopilotState()
	t.Cleanup(resetCopilotState)

	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	orig := copilotAccessTokenURL
	copilotAccessTokenURL = srv.URL
	t.Cleanup(func() { copilotAccessTokenURL = orig })

	cases := []struct {
		name string
		resp string
		want CopilotLoginStatus
	}{
		{"pending", `{"error":"authorization_pending"}`, CopilotLoginPending},
		{"slow_down", `{"error":"slow_down"}`, CopilotLoginSlowDown},
		{"expired", `{"error":"expired_token"}`, CopilotLoginExpired},
		{"denied", `{"error":"access_denied"}`, CopilotLoginDenied},
	}
	for _, c := range cases {
		body = c.resp
		got, err := PollCopilotDeviceLogin(context.Background(), "", "github.com", "dev-code")
		if err != nil || got != c.want {
			t.Fatalf("%s: got %q err=%v, want %q", c.name, got, err, c.want)
		}
	}

	// Authorization persists the token and reports authorized.
	body = `{"access_token":"gho_new"}`
	got, err := PollCopilotDeviceLogin(context.Background(), "", "github.com", "dev-code")
	if err != nil || got != CopilotLoginAuthorized {
		t.Fatalf("authorized: got %q err=%v", got, err)
	}
	if tok := copilotStoredOAuthToken(); tok != "gho_new" {
		t.Fatalf("stored token = %q, want gho_new", tok)
	}
}

func TestLoadCopilotBearerExchangesAndCaches(t *testing.T) {
	resetCopilotState()
	t.Cleanup(resetCopilotState)
	t.Setenv("GH_COPILOT_TOKEN", "gho_oauth")

	var exchanges int32
	var gotAuth, gotIntegration string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&exchanges, 1)
		gotAuth = r.Header.Get("Authorization")
		gotIntegration = r.Header.Get("Copilot-Integration-Id")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"token":"copilot-bearer","expires_at":%d,"endpoints":{"api":"https://api.business.githubcopilot.com/"}}`,
			time.Now().Add(30*time.Minute).Unix())
	}))
	defer srv.Close()
	orig := copilotTokenExchangeURL
	copilotTokenExchangeURL = srv.URL
	t.Cleanup(func() { copilotTokenExchangeURL = orig })

	tok, err := defaultCopilotBearer()
	if err != nil || tok != "copilot-bearer" {
		t.Fatalf("first: tok=%q err=%v", tok, err)
	}
	if gotAuth != "token gho_oauth" {
		t.Fatalf("exchange Authorization = %q, want 'token gho_oauth'", gotAuth)
	}
	if gotIntegration != "vscode-chat" {
		t.Fatalf("Copilot-Integration-Id = %q, want vscode-chat", gotIntegration)
	}
	// The account-correct API host from endpoints.api is captured (trailing slash trimmed).
	if base := CopilotAPIBase(""); base != "https://api.business.githubcopilot.com" {
		t.Fatalf("CopilotAPIBase(\"\") = %q, want the exchanged business host", base)
	}

	// Second call while fresh: served from cache, no new exchange.
	if _, err := defaultCopilotBearer(); err != nil {
		t.Fatalf("second: %v", err)
	}
	if n := atomic.LoadInt32(&exchanges); n != 1 {
		t.Fatalf("exchanges = %d, want 1 (cache hit expected)", n)
	}

	// Force the cached token near expiry: next call must re-exchange.
	copilotStateGate <- struct{}{}
	c := copilotCaches[""]
	c.expiresAt = time.Now().Add(1 * time.Minute)
	copilotCaches[""] = c
	<-copilotStateGate
	if _, err := defaultCopilotBearer(); err != nil {
		t.Fatalf("third: %v", err)
	}
	if n := atomic.LoadInt32(&exchanges); n != 2 {
		t.Fatalf("exchanges = %d, want 2 (refresh expected)", n)
	}
}

func TestCopilotHostPreference(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	resetCopilotState()
	t.Cleanup(resetCopilotState)

	// Default with nothing stored.
	if got := CopilotHost(); got != "github.com" {
		t.Fatalf("CopilotHost() = %q, want github.com by default", got)
	}
	// An arbitrary host is rejected.
	if err := SetCopilotHost("evil.example.com"); err == nil {
		t.Fatal("SetCopilotHost accepted a non-github/ghe host")
	}
	// A *.ghe.com tenant is accepted and becomes the preference.
	if err := SetCopilotHost("acme.ghe.com"); err != nil {
		t.Fatalf("SetCopilotHost(ghe): %v", err)
	}
	if got := CopilotHost(); got != "acme.ghe.com" {
		t.Fatalf("CopilotHost() = %q, want acme.ghe.com", got)
	}
	// With a preference set, a matching editor login wins over github.com.
	logins := []copilotLogin{{token: "a", host: "github.com"}, {token: "b", host: "acme.ghe.com"}}
	if l, ok := pickCopilotLogin(logins, copilotPreferredHost()); !ok || l.token != "b" {
		t.Fatalf("pickCopilotLogin = %+v ok=%v, want the acme.ghe.com login", l, ok)
	}
	// Resetting to github.com clears the preference.
	if err := SetCopilotHost("github.com"); err != nil {
		t.Fatalf("SetCopilotHost(github.com): %v", err)
	}
	if got := copilotPreferredHost(); got != "" {
		t.Fatalf("copilotPreferredHost() = %q, want empty after reset", got)
	}
}

func TestPollPersistsEnterpriseHost(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	resetCopilotState()
	t.Cleanup(resetCopilotState)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_ghe"}`))
	}))
	defer srv.Close()
	orig := copilotAccessTokenURL
	copilotAccessTokenURL = srv.URL
	t.Cleanup(func() { copilotAccessTokenURL = orig })

	got, err := PollCopilotDeviceLogin(context.Background(), "", "acme.ghe.com", "dev-code")
	if err != nil || got != CopilotLoginAuthorized {
		t.Fatalf("poll: got %q err=%v", got, err)
	}
	if tok := copilotStoredOAuthToken(); tok != "gho_ghe" {
		t.Fatalf("stored token = %q, want gho_ghe", tok)
	}
	// The host the flow ran against is persisted as the preference.
	if h := copilotPreferredHost(); h != "acme.ghe.com" {
		t.Fatalf("copilotPreferredHost() = %q, want acme.ghe.com", h)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
