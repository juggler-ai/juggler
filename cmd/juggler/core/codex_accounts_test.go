//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// idTokenFor is an id_token carrying email, as the Codex CLI stores one.
func idTokenFor(t *testing.T, email string) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"email": email})
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// writeCodexLogin writes a ChatGPT login into codexHome, as `codex login`
// does with file storage.
func writeCodexLogin(t *testing.T, codexHome, token, accountID, email string) {
	t.Helper()
	writeCodexAuth(t, codexHome, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"access_token": token,
			"account_id":   accountID,
			"id_token":     idTokenFor(t, email),
		},
	})
}

// TestCodexAccountsReadTheirOwnLogin: an extra Codex account reads the
// auth.json in its own CODEX_HOME and nothing else, and the default account
// keeps reading $CODEX_HOME. Getting this wrong is silent: every turn on
// "ChatGPT (work)" would run on the personal plan.
func TestCodexAccountsReadTheirOwnLogin(t *testing.T) {
	userpathstest.Isolate(t)
	personal, work := t.TempDir(), t.TempDir()
	t.Setenv("CODEX_HOME", personal)
	exp := time.Now().Add(time.Hour)
	personalToken, workToken := testJWT(t, exp)+"p", testJWT(t, exp)+"w"
	writeCodexLogin(t, personal, personalToken, "acct_personal", "me@home.test")
	writeCodexLogin(t, work, workToken, "acct_work", "me@work.test")

	for _, info := range []provider.ProviderInfo{
		{Name: "codexfake", AuthType: provider.AuthTypeOAuthBearer, AuthSource: "codex_cli"},
		{Name: "codexfake-work", Type: "codexfake", AuthType: provider.AuthTypeOAuthBearer, AuthSource: CodexAuthSource(work)},
	} {
		provider.RegisterProvider(info, nil)
		t.Cleanup(func() { provider.UnregisterProvider(info.Name) })
	}
	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]struct{ token, account, label string }{
		"codexfake":      {personalToken, "acct_personal", "me@home.test"},
		"codexfake-work": {workToken, "acct_work", "me@work.test"},
	} {
		cred, err := store.GetProviderCredential(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if cred.BearerToken != want.token || cred.Headers["ChatGPT-Account-Id"] != want.account {
			t.Errorf("%s resolved account %q; want its own login, %q", name, cred.Headers["ChatGPT-Account-Id"], want.account)
		}
		info, _ := provider.GetProviderInfo(name)
		if got := OAuthLoginLabel(info.AuthSource); got != want.label {
			t.Errorf("%s is labelled %q; want %q from its id_token", name, got, want.label)
		}
		if ok, _ := HasOAuthLogin(info.AuthSource); !ok {
			t.Errorf("%s's login is not seen", name)
		}
	}

	missing := filepath.Join(t.TempDir(), "never-signed-in")
	if ok, _ := HasOAuthLogin(CodexAuthSource(missing)); ok {
		t.Errorf("a CODEX_HOME with no auth.json counts as a login")
	}
}

// TestCodexKeyringLoginIsNamed: a Codex CLI set to keep its login in the system
// keyring writes no auth.json, so Juggler sees no login at all — and the hint
// says why rather than telling a signed-in user to sign in.
func TestCodexKeyringLoginIsNamed(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model = \"x\"\ncli_auth_credentials_store = \"keyring\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := loadCodexAccessToken(home)
	if err == nil || !strings.Contains(err.Error(), "cli_auth_credentials_store=file") {
		t.Fatalf("a keyring login reported %v; want it to say how to store the login in a file", err)
	}
}
