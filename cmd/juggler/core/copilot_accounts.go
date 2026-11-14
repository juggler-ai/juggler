//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"cmp"
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// Several Copilot accounts are several GitHub logins, and every account —
// default or extra — is resolved by the same code: its login, exchanged for a
// bearer cached as its own, routed to the API host its own plan reports. Only
// where the login comes from differs.
//
// The default account (id "") keeps everything it always had: Juggler's
// device-flow token (copilot_oauth_token), the preferred host (copilot_host),
// and an editor's login when there is no token of Juggler's. An extra account
// is one GitHub login of its own on a host of its own: a device-flow token kept
// under its own key (provider.AccountOAuthTokenKey), or — when it was added
// from a login an editor holds — that editor login for its host. It never
// falls back to another login: an extra account with nothing of its own is
// signed out. Nothing switches a conversation from one account to another.

const (
	// copilotDefaultSource is the default account's OAuth source.
	copilotDefaultSource = "github_copilot"
	// copilotSourcePrefix starts an extra account's OAuth source name.
	copilotSourcePrefix = copilotDefaultSource + ":"
)

// copilotAccount is one Copilot account. The zero value is the default
// account, whose host and login are found afresh on every use.
type copilotAccount struct {
	// id is the account's provider id; "" for the default account.
	id   string
	host string
	// editor: the account's login is the one an editor holds for host.
	editor bool
}

// login is the account's GitHub login.
func (a copilotAccount) login() (copilotLogin, error) {
	if a.id == "" {
		return loadCopilotLogin()
	}
	if tok := copilotAccountToken(a.id); tok != "" {
		return copilotLogin{token: tok, host: a.host}, nil
	}
	if a.editor {
		for _, l := range copilotEditorLogins() {
			if l.host == a.host {
				return l, nil
			}
		}
	}
	return copilotLogin{}, fmt.Errorf("not signed in — click “Sign in with GitHub” on this account (%s)", a.host)
}

// providerID is the provider the account registers as.
func (a copilotAccount) providerID() string {
	return cmp.Or(a.id, copilotTypeName)
}

// copilotTypeName is the Copilot provider type, and its default account's id.
const copilotTypeName = "copilot"

// copilotLabel is who an account's login was found to be: the GitHub login
// that token belongs to, once asked.
type copilotLabel struct {
	token   string
	login   string
	askedAt time.Time
}

// copilotLabelRetry is how long a failed lookup of who a login is waits before
// it is asked again.
const copilotLabelRetry = time.Minute

// Per-account state, all keyed by account id ("" for the default account) and
// guarded by copilotStateGate, a size-1 semaphore (the core forbids
// sync.Mutex). Never held across a network call: an exchange holds only its
// own account's gate in copilotExchangeGates.
var (
	copilotStateGate = make(chan struct{}, 1)
	// copilotAccounts holds the extra accounts whose sources are registered.
	copilotAccounts      = map[string]copilotAccount{}
	copilotCaches        = map[string]copilotCachedToken{}
	copilotLabels        = map[string]copilotLabel{}
	copilotExchangeGates = map[string]chan struct{}{}
)

type copilotCachedToken struct {
	bearer    string
	apiBase   string // account-correct API host from the exchange (endpoints.api)
	expiresAt time.Time
	oauthKey  string // re-exchange if the underlying GitHub login (token or host) changes
}

// CopilotNormalizeHost is host as a Copilot account stores it: lower-cased,
// github.com when empty, and refused unless it is github.com or a *.ghe.com
// tenant, so no setting can point a GitHub token at another host.
func CopilotNormalizeHost(host string) (string, error) {
	host = cmp.Or(copilotNormalizeHost(host), copilotDefaultHost)
	if !copilotValidHost(host) {
		return "", msg.NewError("{host} is not github.com or a *.ghe.com host", "host", strconv.Quote(host))
	}
	return host, nil
}

// CopilotAuthSource is the OAuth source of a Copilot account, registering an
// extra account's on first use and on every change of its host or login; the
// default account's for "" accountID.
func CopilotAuthSource(accountID, host string, editorLogin bool) (string, error) {
	if accountID == "" {
		return copilotDefaultSource, nil
	}
	host, err := CopilotNormalizeHost(host)
	if err != nil {
		return "", err
	}
	copilotStateGate <- struct{}{}
	copilotAccounts[accountID] = copilotAccount{id: accountID, host: host, editor: editorLogin}
	<-copilotStateGate
	name := copilotSourcePrefix + accountID
	RegisterOAuthSource(name, copilotSource(accountID))
	return name, nil
}

// ForgetCopilotAccount drops everything kept in memory for an extra account
// that was removed — its source, its bearer, who it was — since its id may be
// given to a new account.
func ForgetCopilotAccount(accountID string) {
	if accountID == "" {
		return
	}
	UnregisterOAuthSource(copilotSourcePrefix + accountID)
	copilotStateGate <- struct{}{}
	delete(copilotAccounts, accountID)
	delete(copilotCaches, accountID)
	delete(copilotLabels, accountID)
	delete(copilotExchangeGates, accountID)
	<-copilotStateGate
}

// copilotSource is the OAuth source of the Copilot account accountID.
func copilotSource(accountID string) OAuthSource {
	return OAuthSource{
		Resolve: func() (ProviderCredential, error) { return resolveCopilotCredential(accountID) },
		Present: func() bool {
			a, ok := copilotAccountOf(accountID)
			if !ok {
				return false
			}
			_, err := a.login()
			return err == nil
		},
		Label:     func() string { return copilotLabelOf(accountID) },
		KeySource: KeySourceCopilot,
	}
}

// copilotAccountOf is the account accountID ("" for the default), if its
// source is registered.
func copilotAccountOf(accountID string) (copilotAccount, bool) {
	if accountID == "" {
		return copilotAccount{}, true
	}
	copilotStateGate <- struct{}{}
	defer func() { <-copilotStateGate }()
	a, ok := copilotAccounts[accountID]
	return a, ok
}

// hasExtraCopilotAccounts reports whether a Copilot account beyond the default
// is registered, which is when the default's label is worth a lookup: it tells
// the two apart in the model picker.
func hasExtraCopilotAccounts() bool {
	copilotStateGate <- struct{}{}
	defer func() { <-copilotStateGate }()
	return len(copilotAccounts) > 0
}

// copilotAccountToken is an extra account's stored device-flow token, or "".
func copilotAccountToken(accountID string) string {
	store, err := NewCredentialsStore()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(store.GetRawKey(provider.AccountOAuthTokenKey(accountID)))
}

// storeCopilotAccountToken stores (or, given "", clears) an extra account's
// device-flow token, and drops its bearer so the next resolve re-exchanges.
func storeCopilotAccountToken(accountID, token string) error {
	store, err := NewCredentialsStore()
	if err != nil {
		return err
	}
	if err := store.SetRawKey(provider.AccountOAuthTokenKey(accountID), token); err != nil {
		return err
	}
	clearCopilotCache(accountID)
	return nil
}

// resolveCopilotCredential resolves account accountID's bearer: its login,
// exchanged (and cached) only when needed, with the Copilot request headers
// attached.
func resolveCopilotCredential(accountID string) (ProviderCredential, error) {
	a, ok := copilotAccountOf(accountID)
	if !ok {
		err := fmt.Errorf("copilot account %q is not registered", accountID)
		return errorAuthHint(err), err
	}
	login, err := a.login()
	if err != nil {
		return errorAuthHint(err), err
	}
	token, err := exchangeCachedCopilotToken(accountID, login)
	if err != nil {
		return errorAuthHint(err), err
	}
	if accountID != "" || hasExtraCopilotAccounts() {
		go learnCopilotLabel(a, login)
	}
	return ProviderCredential{
		BearerToken: token,
		Headers:     CopilotHeaders(),
		KeySource:   KeySourceCopilot,
	}.withAuthHint(copilotSignedInHint(login)), nil
}

// copilotSignedInHint labels the signed-in state, naming how the login was
// sourced so the settings UI can tell a device-flow login from an editor one.
func copilotSignedInHint(login copilotLogin) msg.Message {
	switch {
	case login.host == copilotDefaultHost && !login.editor:
		return msg.New("Signed in with GitHub")
	case login.host == copilotDefaultHost:
		return msg.New("Signed in via your editor's Copilot login")
	case !login.editor:
		return msg.New("Signed in with GitHub to {host}", "host", login.host)
	default:
		return msg.New("Signed in via your editor's Copilot login to {host}", "host", login.host)
	}
}

// copilotExchangeGate is the gate serialising account accountID's token
// exchanges, so two turns starting at once exchange once.
func copilotExchangeGate(accountID string) chan struct{} {
	copilotStateGate <- struct{}{}
	defer func() { <-copilotStateGate }()
	gate, ok := copilotExchangeGates[accountID]
	if !ok {
		gate = make(chan struct{}, 1)
		copilotExchangeGates[accountID] = gate
	}
	return gate
}

// exchangeCachedCopilotToken is a valid bearer for login, cached as account
// accountID's, exchanged only when the cache holds none for this login or it
// nears expiry. Only this account's exchange gate is held across the network.
func exchangeCachedCopilotToken(accountID string, login copilotLogin) (string, error) {
	// Keyed on host+token so a switch of either forces a re-exchange.
	cacheKey := login.host + "\x00" + login.token

	gate := copilotExchangeGate(accountID)
	gate <- struct{}{}
	defer func() { <-gate }()

	copilotStateGate <- struct{}{}
	c := copilotCaches[accountID]
	<-copilotStateGate
	if c.bearer != "" && c.oauthKey == cacheKey && time.Now().Add(copilotRefreshMargin).Before(c.expiresAt) {
		return c.bearer, nil
	}
	bearer, apiBase, expiresAt, err := exchangeCopilotToken(context.Background(), login)
	if err != nil {
		return "", err
	}
	copilotStateGate <- struct{}{}
	copilotCaches[accountID] = copilotCachedToken{bearer: bearer, apiBase: apiBase, expiresAt: expiresAt, oauthKey: cacheKey}
	<-copilotStateGate
	return bearer, nil
}

// clearCopilotCache drops account accountID's cached bearer, so the next
// resolve re-exchanges (after a sign-in, sign-out or host change).
func clearCopilotCache(accountID string) {
	copilotStateGate <- struct{}{}
	delete(copilotCaches, accountID)
	<-copilotStateGate
}

// CopilotAPIBase is the API host account accountID's ("" for the default) last
// token exchange reported, or the individual-plan host before the first. The
// provider uses it for both /models and /chat/completions so they always agree
// with the account's plan.
func CopilotAPIBase(accountID string) string {
	copilotStateGate <- struct{}{}
	defer func() { <-copilotStateGate }()
	return cmp.Or(copilotCaches[accountID].apiBase, copilotDefaultAPIBase)
}

// copilotUserURL, when non-empty, overrides the GitHub user endpoint (tests
// point it at an httptest server).
var copilotUserURL = ""

// copilotUserTimeout bounds the one-off lookup of who a login belongs to.
const copilotUserTimeout = 5 * time.Second

// learnCopilotLabel asks GitHub which GitHub login an account's login is, once
// per token (again after copilotLabelRetry when the lookup failed), and shows
// it on the account. Display only, never identity. Run in the background: it
// is never on the path of a turn.
func learnCopilotLabel(a copilotAccount, login copilotLogin) {
	copilotStateGate <- struct{}{}
	known := copilotLabels[a.id]
	ask := known.token != login.token || (known.login == "" && time.Since(known.askedAt) >= copilotLabelRetry)
	if ask {
		copilotLabels[a.id] = copilotLabel{token: login.token, askedAt: time.Now()}
	}
	<-copilotStateGate
	if !ask {
		return
	}
	endpoint := copilotUserURL
	if endpoint == "" {
		endpoint = "https://api." + login.host + "/user"
		if login.host == copilotDefaultHost {
			endpoint = "https://api.github.com/user"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), copilotUserTimeout)
	defer cancel()
	var user struct {
		Login string `json:"login"`
	}
	if err := utils.GetJSON(ctx, endpoint, utils.JSONGetOptions{
		RawAuthorization: "token " + login.token,
		Defaults:         map[string]string{"Accept": "application/json"},
		Label:            "GitHub user lookup",
	}, &user); err != nil || user.Login == "" {
		return
	}
	copilotStateGate <- struct{}{}
	current := copilotLabels[a.id].token == login.token
	if current {
		copilotLabels[a.id] = copilotLabel{token: login.token, login: user.Login, askedAt: time.Now()}
	}
	<-copilotStateGate
	if current {
		provider.SetAccountLabel(a.providerID(), user.Login)
	}
}

// copilotLabelOf is who account accountID's current login was found to be,
// or "".
func copilotLabelOf(accountID string) string {
	a, ok := copilotAccountOf(accountID)
	if !ok {
		return ""
	}
	login, err := a.login()
	if err != nil {
		return ""
	}
	copilotStateGate <- struct{}{}
	defer func() { <-copilotStateGate }()
	if l := copilotLabels[accountID]; l.token == login.token {
		return l.login
	}
	return ""
}

// CopilotFoundLogins are the hosts of the editor logins on this machine other
// than the one the default account uses: a second GitHub login it passes over,
// offered as an account of its own.
func CopilotFoundLogins() []string {
	var used string
	if l, err := loadCopilotLogin(); err == nil {
		used = l.host
	}
	seen := map[string]bool{used: true}
	var out []string
	for _, l := range copilotEditorLogins() {
		if !seen[l.host] {
			seen[l.host] = true
			out = append(out, l.host)
		}
	}
	return out
}
