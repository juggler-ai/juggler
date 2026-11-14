//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestCopilotAccountsUseTheirOwnLogin: an extra Copilot account signs in
// through the device flow into a token slot of its own, exchanges that token
// and no other, and routes to the API host its own plan reports; signing it in
// or out leaves the default account's login, host and bearer alone. Getting
// this wrong is silent: turns on "GitHub Copilot (work)" would run on the
// personal plan.
func TestCopilotAccountsUseTheirOwnLogin(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	t.Setenv("GH_COPILOT_TOKEN", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	resetCopilotState()
	t.Cleanup(resetCopilotState)

	plans := map[string]struct{ bearer, api string }{
		"token gho_default": {"bearer-default", "https://api.individual.githubcopilot.com"},
		"token gho_work":    {"bearer-work", "https://api.business.githubcopilot.com"},
	}
	exchange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plan, ok := plans[r.Header.Get("Authorization")]
		if !ok {
			http.Error(w, "unknown token", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/user" {
			fmt.Fprintf(w, `{"login":%q}`, "octo-"+plan.bearer)
			return
		}
		fmt.Fprintf(w, `{"token":%q,"expires_at":%d,"endpoints":{"api":%q}}`, plan.bearer, time.Now().Add(30*time.Minute).Unix(), plan.api)
	}))
	defer exchange.Close()
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"gho_work"}`))
	}))
	defer device.Close()
	origExchange, origDevice, origUser := copilotTokenExchangeURL, copilotAccessTokenURL, copilotUserURL
	copilotTokenExchangeURL, copilotAccessTokenURL, copilotUserURL = exchange.URL, device.URL, exchange.URL+"/user"
	t.Cleanup(func() {
		copilotTokenExchangeURL, copilotAccessTokenURL, copilotUserURL = origExchange, origDevice, origUser
	})

	store, err := NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetRawKey(copilotOAuthTokenKey, "gho_default"); err != nil {
		t.Fatal(err)
	}
	if err := SetCopilotHost("acme.ghe.com"); err != nil {
		t.Fatal(err)
	}

	// Only a registered account may be signed in or out: the id names the
	// credentials slot a token is written to. Nor may a host other than its
	// own pair a token with it.
	if _, err := PollCopilotDeviceLogin(context.Background(), "copilot-work", "github.com", "dev-code"); err == nil {
		t.Fatal("a device login was stored for an account that is not registered")
	}
	if err := SignOutCopilot("copilot-work"); err == nil {
		t.Fatal("an account that is not registered was signed out")
	}
	if _, err := CopilotAuthSource("copilot-evil", "evil.example.com", false); err == nil {
		t.Fatal("an account was given a host that is neither github.com nor *.ghe.com")
	}
	workSource, err := CopilotAuthSource("copilot-work", "github.com", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PollCopilotDeviceLogin(context.Background(), "copilot-work", "acme.ghe.com", "dev-code"); err == nil {
		t.Fatal("a token minted on acme.ghe.com was stored for an account on github.com")
	}

	// The work account signs in, on github.com.
	status, err := PollCopilotDeviceLogin(context.Background(), "copilot-work", "github.com", "dev-code")
	if err != nil || status != CopilotLoginAuthorized {
		t.Fatalf("the work account's sign-in: %q, %v", status, err)
	}
	if got := copilotStoredOAuthToken(); got != "gho_default" {
		t.Fatalf("signing the work account in replaced the default account's token with %q", got)
	}
	if got := copilotPreferredHost(); got != "acme.ghe.com" {
		t.Fatalf("signing the work account in on github.com moved the default account's host to %q", got)
	}
	if err := SetCopilotHost(""); err != nil {
		t.Fatal(err)
	}

	// Who an account is signed in as is learned in the background and
	// published on the account, which is what this waits for.
	labelled := make(chan struct{}, 4)
	provider.OnAccountChanged(func() { labelled <- struct{}{} })
	t.Cleanup(func() { provider.OnAccountChanged(func() {}) })
	for _, info := range []provider.ProviderInfo{
		{Name: "copilot", AuthType: provider.AuthTypeOAuthBearer, AuthSource: copilotDefaultSource},
		{Name: "copilot-work", Type: "copilot", AuthType: provider.AuthTypeOAuthBearer, AuthSource: workSource},
	} {
		provider.RegisterProvider(info, nil)
		t.Cleanup(func() { provider.UnregisterProvider(info.Name) })
	}
	for name, want := range map[string]string{"copilot": "bearer-default", "copilot-work": "bearer-work"} {
		cred, err := store.GetProviderCredential(name)
		if err != nil || cred.BearerToken != want {
			t.Errorf("%s resolved %q, %v; want its own login's %q", name, cred.BearerToken, err, want)
		}
	}
	for OAuthLoginLabel(workSource) == "" {
		select {
		case <-labelled:
		case <-time.After(10 * time.Second):
			t.Fatal("the work account's GitHub login was never learned")
		}
	}
	if got := OAuthLoginLabel(workSource); got != "octo-bearer-work" {
		t.Errorf("the work account is labelled %q; want its GitHub login", got)
	}
	if got := CopilotAPIBase("copilot-work"); got != "https://api.business.githubcopilot.com" {
		t.Errorf("the work account routes to %q; want its own plan's host", got)
	}
	if got := CopilotAPIBase(""); got != "https://api.githubcopilot.com" {
		t.Errorf("the default account routes to %q; want its own plan's host", got)
	}

	if err := SignOutCopilot("copilot-work"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := HasOAuthLogin(workSource); ok {
		t.Errorf("the work account still has a login after signing out")
	}
	if _, err := store.GetProviderCredential("copilot-work"); err == nil {
		t.Errorf("the signed-out work account still resolved a bearer; it must never fall back to another login")
	}
	if cred, err := store.GetProviderCredential("copilot"); err != nil || cred.BearerToken != "bearer-default" {
		t.Errorf("signing the work account out took the default account's login: %q, %v", cred.BearerToken, err)
	}

	// A removed account's id may be given to a new account, which must find
	// nothing of the old one's.
	ForgetCopilotAccount("copilot-work")
	if _, ok := lookupOAuthSource(workSource); ok {
		t.Errorf("a removed account's source still resolves")
	}
	if got := CopilotAPIBase("copilot-work"); got != copilotDefaultAPIBase {
		t.Errorf("a removed account's plan host %q outlived it", got)
	}
}
