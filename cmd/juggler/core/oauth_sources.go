//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

// OAuth-bearer source registry. Providers whose auth is a short-lived bearer
// minted from an external login (a CLI token file, a device-flow login, …)
// register a resolver here keyed by their ProviderInfo.AuthSource;
// GetProviderCredential dispatches on that name. This replaces a hardcoded
// switch so new sources — including ones from a wrapping distribution — are
// additive: call RegisterOAuthBearerSource, no core edit required.

// OAuthBearerResolver produces a provider's resolved bearer credential (or an
// error whose message is safe to surface as the sign-in hint).
type OAuthBearerResolver func() (ProviderCredential, error)

// oauthSourceGate is a size-1 semaphore guarding the registry map (the core
// forbids sync.Mutex; channels are the house style).
var (
	oauthSourceGate = make(chan struct{}, 1)
	oauthSources    = map[string]OAuthBearerResolver{}
)

// init registers the built-in sources so they are present for every caller
// (including package-core tests) regardless of provider-registration order.
func init() {
	RegisterOAuthBearerSource("codex_cli", resolveCodexCredential)
	RegisterOAuthBearerSource("github_copilot", resolveCopilotCredential)
}

// RegisterOAuthBearerSource registers (or replaces) the resolver for an
// AuthSource name. Safe to call at startup from any package.
func RegisterOAuthBearerSource(name string, resolver OAuthBearerResolver) {
	oauthSourceGate <- struct{}{}
	oauthSources[name] = resolver
	<-oauthSourceGate
}

// lookupOAuthBearerSource returns the resolver registered for name, if any.
func lookupOAuthBearerSource(name string) (OAuthBearerResolver, bool) {
	oauthSourceGate <- struct{}{}
	resolver, ok := oauthSources[name]
	<-oauthSourceGate
	return resolver, ok
}

// resolveCodexCredential resolves the OpenAI Codex (ChatGPT-plan) bearer from
// the local Codex app/CLI login.
func resolveCodexCredential() (ProviderCredential, error) {
	token, accountID, err := loadCodexCLIAccessToken()
	if err != nil {
		return ProviderCredential{AuthHint: err.Error()}, err
	}
	var headers map[string]string
	if accountID != "" {
		headers = map[string]string{"ChatGPT-Account-Id": accountID}
	}
	return ProviderCredential{
		BearerToken: token,
		Headers:     headers,
		KeySource:   KeySourceCodexCLI,
		AuthHint:    "Signed in via Codex app/CLI",
	}, nil
}
