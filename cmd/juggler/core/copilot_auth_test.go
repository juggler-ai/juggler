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

func resetCopilotTokenCache() {
	copilotTokenGate <- struct{}{}
	copilotTokenCache = copilotCachedToken{}
	<-copilotTokenGate
}

func TestLoadCopilotOAuthToken(t *testing.T) {
	t.Run("apps.json", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir()) // isolate the credentials store
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:Iv1.b507a08c87ecfe98":{"user":"octocat","oauth_token":"gho_apps"}}`)
		tok, err := loadCopilotOAuthToken()
		if err != nil || tok != "gho_apps" {
			t.Fatalf("token=%q err=%v, want gho_apps", tok, err)
		}
	})

	t.Run("hosts.json fallback", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "hosts.json"),
			`{"github.com":{"oauth_token":"gho_hosts"}}`)
		tok, err := loadCopilotOAuthToken()
		if err != nil || tok != "gho_hosts" {
			t.Fatalf("token=%q err=%v, want gho_hosts", tok, err)
		}
	})

	t.Run("stored device token beats editor files", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:x":{"oauth_token":"gho_apps"}}`)
		if err := storeCopilotOAuthToken("gho_device"); err != nil {
			t.Fatalf("store: %v", err)
		}
		t.Cleanup(func() { _ = clearCopilotDeviceLogin() })
		tok, err := loadCopilotOAuthToken()
		if err != nil || tok != "gho_device" {
			t.Fatalf("token=%q err=%v, want gho_device", tok, err)
		}
		if !copilotHasDeviceLogin() {
			t.Fatal("copilotHasDeviceLogin() = false, want true")
		}
		if err := clearCopilotDeviceLogin(); err != nil {
			t.Fatalf("clear: %v", err)
		}
		// After sign-out the editor file wins again.
		if tok, _ := loadCopilotOAuthToken(); tok != "gho_apps" {
			t.Fatalf("post-signout token=%q, want gho_apps", tok)
		}
	})

	t.Run("env override wins", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "gho_env")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		writeFile(t, filepath.Join(dir, "github-copilot", "apps.json"),
			`{"github.com:x":{"oauth_token":"gho_apps"}}`)
		tok, err := loadCopilotOAuthToken()
		if err != nil || tok != "gho_env" {
			t.Fatalf("token=%q err=%v, want gho_env", tok, err)
		}
	})

	t.Run("missing login errors", func(t *testing.T) {
		t.Setenv("GH_COPILOT_TOKEN", "")
		t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
		t.Setenv("XDG_CONFIG_HOME", t.TempDir())
		if _, err := loadCopilotOAuthToken(); err == nil {
			t.Fatal("expected error when no login present")
		}
	})
}

func TestExchangeNormalizesIndividualHost(t *testing.T) {
	resetCopilotTokenCache()
	t.Cleanup(resetCopilotTokenCache)
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

	if _, err := loadCopilotBearer(); err != nil {
		t.Fatalf("loadCopilotBearer: %v", err)
	}
	// The individual subdomain is rewritten to the bare host the editor clients use.
	if base := CopilotAPIBase(); base != "https://api.githubcopilot.com" {
		t.Fatalf("CopilotAPIBase() = %q, want bare individual host", base)
	}
}

func TestPollCopilotDeviceLoginStatuses(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	resetCopilotTokenCache()
	t.Cleanup(resetCopilotTokenCache)

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
		got, err := PollCopilotDeviceLogin(context.Background(), "dev-code")
		if err != nil || got != c.want {
			t.Fatalf("%s: got %q err=%v, want %q", c.name, got, err, c.want)
		}
	}

	// Authorization persists the token and reports authorized.
	body = `{"access_token":"gho_new"}`
	got, err := PollCopilotDeviceLogin(context.Background(), "dev-code")
	if err != nil || got != CopilotLoginAuthorized {
		t.Fatalf("authorized: got %q err=%v", got, err)
	}
	if tok := copilotStoredOAuthToken(); tok != "gho_new" {
		t.Fatalf("stored token = %q, want gho_new", tok)
	}
}

func TestLoadCopilotBearerExchangesAndCaches(t *testing.T) {
	resetCopilotTokenCache()
	t.Cleanup(resetCopilotTokenCache)
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

	tok, err := loadCopilotBearer()
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
	if base := CopilotAPIBase(); base != "https://api.business.githubcopilot.com" {
		t.Fatalf("CopilotAPIBase() = %q, want the exchanged business host", base)
	}

	// Second call while fresh: served from cache, no new exchange.
	if _, err := loadCopilotBearer(); err != nil {
		t.Fatalf("second: %v", err)
	}
	if n := atomic.LoadInt32(&exchanges); n != 1 {
		t.Fatalf("exchanges = %d, want 1 (cache hit expected)", n)
	}

	// Force the cached token near expiry: next call must re-exchange.
	copilotTokenGate <- struct{}{}
	copilotTokenCache.expiresAt = time.Now().Add(1 * time.Minute)
	<-copilotTokenGate
	if _, err := loadCopilotBearer(); err != nil {
		t.Fatalf("third: %v", err)
	}
	if n := atomic.LoadInt32(&exchanges); n != 2 {
		t.Fatalf("exchanges = %d, want 2 (refresh expected)", n)
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
