//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofrs/flock"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// TestCredentialWriteWaitsForAnotherProcessesLock: a machine runs one juggler
// server per open project, and they all write ~/.juggler/credentials.json. A write
// is load-modify-save, so two of them overlapping means the second reloads before
// the first has saved and then writes a document missing the first's change —
// silently reverting it. The in-process semaphore cannot see another process, so
// the serialisation has to be a file lock.
//
// The lock is taken here directly, which is exactly what another server process
// looks like from in here.
func TestCredentialWriteWaitsForAnotherProcessesLock(t *testing.T) {
	userpathstest.Isolate(t)
	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatalf("new credentials store: %v", err)
	}

	other := flock.New(credentialsLockPath())
	if err := os.MkdirAll(filepath.Dir(credentialsLockPath()), 0o700); err != nil {
		t.Fatalf("create config dir: %v", err)
	}
	if locked, err := other.TryLock(); err != nil || !locked {
		t.Fatalf("could not stand in for another process holding the lock: locked=%v err=%v", locked, err)
	}

	done := make(chan error, 1)
	go func() { done <- store.SetRawKey("ollama_host", "http://written-second:11434") }()

	select {
	case err := <-done:
		t.Fatalf("the write went ahead while another process held the lock (err=%v), so two servers can overwrite each other", err)
	case <-time.After(250 * time.Millisecond):
		// Still waiting, which is the point.
	}

	if err := other.Unlock(); err != nil {
		t.Fatalf("release the stand-in lock: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("the write failed once the lock was free: %v", err)
		}
	case <-time.After(settingsLockTimeout):
		t.Fatal("the write never completed after the lock was released")
	}
	if got := store.GetRawKey("ollama_host"); got != "http://written-second:11434" {
		t.Errorf("stored host = %q, want the value written after the wait", got)
	}
}

func TestLoadCodexCLIAccessTokenReadsCodexHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	token := testJWT(t, time.Now().Add(time.Hour))
	writeCodexAuth(t, dir, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"access_token": token,
			"account_id":   "acct_123",
		},
	})

	got, accountID, err := loadCodexCLIAccessToken()
	if err != nil {
		t.Fatalf("loadCodexCLIAccessToken: %v", err)
	}
	if got != token {
		t.Fatalf("token mismatch")
	}
	if accountID != "acct_123" {
		t.Fatalf("accountID = %q, want acct_123", accountID)
	}
}

func TestLoadCodexCLIAccessTokenFallsBackToHome(t *testing.T) {
	// Isolate the home dir (HOME and USERPROFILE, the latter being what
	// os.UserHomeDir resolves on Windows) so the codex auth lands where the
	// loader looks.
	home := userpathstest.Isolate(t)
	t.Setenv("CODEX_HOME", "")
	token := testJWT(t, time.Now().Add(time.Hour))
	writeCodexAuth(t, filepath.Join(home, ".codex"), map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"access_token": token,
		},
	})

	got, _, err := loadCodexCLIAccessToken()
	if err != nil {
		t.Fatalf("loadCodexCLIAccessToken: %v", err)
	}
	if got != token {
		t.Fatalf("token mismatch")
	}
}

func TestLoadCodexCLIAccessTokenRejectsInvalidAuth(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "missing file"},
		{name: "malformed json", body: `{`},
		{name: "wrong auth mode", body: `{"auth_mode":"api_key","tokens":{"access_token":"` + testJWT(t, time.Now().Add(time.Hour)) + `"}}`},
		{name: "missing token", body: `{"auth_mode":"chatgpt","tokens":{}}`},
		{name: "expired token", body: `{"auth_mode":"chatgpt","tokens":{"access_token":"` + testJWT(t, time.Now().Add(-time.Hour)) + `"}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			if tt.body != "" {
				if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(tt.body), 0600); err != nil {
					t.Fatalf("write auth: %v", err)
				}
			}

			_, _, err := loadCodexCLIAccessToken()
			if err == nil {
				t.Fatal("expected error")
			}
			msg := err.Error()
			if !strings.Contains(msg, "Codex") || !strings.Contains(msg, "ChatGPT app") || !strings.Contains(msg, "codex login") {
				t.Fatalf("error should mention Codex sign-in options, got %q", msg)
			}
			if !strings.Contains(msg, filepath.Join(dir, "auth.json")) {
				t.Fatalf("error should mention checked auth path, got %q", msg)
			}
		})
	}
}

// TestOAuthProviderSwitchLeavesTheLoginReadable: switching an OAuth provider off
// refuses its credential to everything that would serve a turn, but the login
// itself is still there — onboarding asks about it to tell "switched off" from
// "never signed in", and must keep getting the true answer.
func TestOAuthProviderSwitchLeavesTheLoginReadable(t *testing.T) {
	userpathstest.Isolate(t)
	const name = "core_oauthswitch"
	const source = "core_oauthswitch_src"
	RegisterOAuthBearerSource(source, func() (ProviderCredential, error) {
		return ProviderCredential{BearerToken: "tok"}, nil
	})
	provider.RegisterProvider(provider.ProviderInfo{
		Name:       name,
		AuthType:   provider.AuthTypeOAuthBearer,
		AuthSource: source,
	}, nil)
	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatalf("new credentials store: %v", err)
	}

	if _, err := store.GetProviderCredential(name); err != nil {
		t.Fatalf("an OAuth provider must be on by default: %v", err)
	}
	if err := store.SetProviderEnabled(name, false); err != nil {
		t.Fatalf("switch off: %v", err)
	}
	if _, err := store.GetProviderCredential(name); err == nil {
		t.Fatal("a switched-off OAuth provider must not hand out its credential")
	}
	if !store.IsProviderSwitchedOff(name) {
		t.Fatal("IsProviderSwitchedOff must report the user's choice")
	}
	if _, err := store.ResolveOAuthLogin(name); err != nil {
		t.Fatalf("the login must still resolve while switched off: %v", err)
	}
}

// A corrupt credentials file must not permanently lock the user out: the next
// write quarantines the bad file and starts fresh. This reproduces the reported
// "failed to parse credentials file: invalid character 'e' after top-level
// value" — a valid JSON object followed by trailing garbage.
func TestSetRawKeyRecoversFromCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	corrupt := []byte(`{ "onboarding_complete": "true" }enabled_claudecode": "true" }`)
	if err := os.WriteFile(path, corrupt, 0600); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}
	store := &CredentialsStore{filePath: path}

	// Sanity: the strict Load path rejects it (this is what bricked the user).
	if _, err := store.Load(); err == nil {
		t.Fatalf("expected Load to reject corrupt file")
	}

	if err := store.SetRawKey("anthropic_api_key", "sk-test"); err != nil {
		t.Fatalf("SetRawKey on corrupt file: %v", err)
	}

	creds, err := store.Load()
	if err != nil {
		t.Fatalf("Load after recovery: %v", err)
	}
	if got := creds["anthropic_api_key"]; got != "sk-test" {
		t.Fatalf("anthropic_api_key = %q, want sk-test", got)
	}
	if len(creds) != 1 {
		t.Fatalf("creds = %v, want only the new key", creds)
	}

	// The original bytes are preserved for manual recovery.
	quarantined, err := os.ReadFile(path + ".corrupt")
	if err != nil {
		t.Fatalf("read quarantine: %v", err)
	}
	if string(quarantined) != string(corrupt) {
		t.Fatalf("quarantine bytes = %q, want original corrupt content", quarantined)
	}
}

// The reported failure was "Failed to save anthropic API key: ... invalid
// character 'e' after top-level value". Lock the exact entry point from the
// screenshot (SetAPIKey, not just the sibling SetRawKey): a corrupt file must
// not block saving a provider key from the settings UI.
func TestSetAPIKeyRecoversFromCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	corrupt := []byte(`{ "onboarding_complete": "true" }enabled_claudecode": "true" }`)
	if err := os.WriteFile(path, corrupt, 0600); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}
	store := &CredentialsStore{filePath: path}

	// SetAPIKey resolves the provider through the registry, which providers
	// populate via blank import at package-init; the core test binary pulls in
	// none of them, so register the anthropic metadata directly. Initializer is
	// nil because the key read/write path never constructs a provider instance.
	if _, ok := provider.GetProviderInfo("anthropic"); !ok {
		provider.RegisterProvider(provider.ProviderInfo{
			Name:          "anthropic",
			ConfigKeyName: "anthropic_api_key",
			AuthType:      provider.AuthTypeAPIKey,
		}, nil)
	}

	if err := store.SetAPIKey("anthropic", "sk-ant-test"); err != nil {
		t.Fatalf("SetAPIKey on corrupt file: %v", err)
	}

	got, err := store.GetAPIKey("anthropic")
	if err != nil {
		t.Fatalf("GetAPIKey after recovery: %v", err)
	}
	if got != "sk-ant-test" {
		t.Fatalf("anthropic key = %q, want sk-ant-test", got)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("expected quarantined file: %v", err)
	}
}

// Concurrent writes to distinct keys must (a) never produce a torn/corrupt
// file and (b) never lose an update. Atomic temp+rename gives (a): a
// truncate-then-write os.WriteFile would leave trailing bytes on interleave.
// Per-path locking of the load→modify→save sequence gives (b): without it two
// writers each load a snapshot missing the other's key and the last rename
// drops it, so OpenAI-compatible settings would all report Saved but persist
// none. Non-empty values so blanks aren't treated as deletes.
func TestSaveAtomicUnderConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	store := &CredentialsStore{filePath: path}

	const writers = 24
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			// Mix long and short payloads so a non-atomic write would leave a tail.
			key := fmt.Sprintf("key_%02d", n)
			val := strings.Repeat("v", (n%7)*16+1)
			if err := store.SetRawKey(key, val); err != nil {
				t.Errorf("SetRawKey(%s): %v", key, err)
			}
		}(i)
	}
	wg.Wait()

	creds, err := store.Load()
	if err != nil {
		t.Fatalf("file corrupt after concurrent writes: %v", err)
	}
	// Every writer's key must survive — a lost update means the read-modify-write
	// sequences interleaved and one writer clobbered another.
	for i := 0; i < writers; i++ {
		key := fmt.Sprintf("key_%02d", i)
		want := strings.Repeat("v", (i%7)*16+1)
		if got := creds[key]; got != want {
			t.Errorf("%s = %q, want %q (lost update under concurrent writes)", key, got, want)
		}
	}
}

func writeCodexAuth(t *testing.T, dir string, body map[string]any) {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatalf("mkdir auth dir: %v", err)
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal auth: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), data, 0600); err != nil {
		t.Fatalf("write auth: %v", err)
	}
}

func testJWT(t *testing.T, exp time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload, err := json.Marshal(map[string]any{"exp": exp.Unix()})
	if err != nil {
		t.Fatalf("marshal jwt payload: %v", err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}
