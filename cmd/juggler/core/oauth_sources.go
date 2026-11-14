//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

// OAuth-bearer source registry. Providers whose auth is a short-lived bearer
// minted from an external login (a CLI token file, a device-flow login, …)
// register a source here keyed by their ProviderInfo.AuthSource;
// GetProviderCredential dispatches on that name, and the account list asks the
// same source whether its login is there and who it belongs to. New sources —
// including ones from a wrapping distribution — are additive: call
// RegisterOAuthSource, no core edit required.

// OAuthBearerResolver produces a provider's resolved bearer credential (or an
// error whose message is safe to surface as the sign-in hint).
type OAuthBearerResolver func() (ProviderCredential, error)

// OAuthSource is one external login a provider's bearer is minted from.
type OAuthSource struct {
	// Resolve mints (or reuses) the bearer.
	Resolve OAuthBearerResolver
	// Present reports whether the login is there, reading only local files: the
	// account list asks it of every OAuth account each time the settings page
	// opens, so it must neither mint a token nor wait on the network. A login
	// that is present but expired still counts — the account exists, and its
	// status line says to sign in again. Nil counts as present.
	Present func() bool
	// Label is who the login is signed in as, from what is already known
	// locally, or "". Display only, never identity. Nil knows nothing.
	Label func() string
	// KeySource is what the account's card says the login comes from.
	KeySource KeySource
}

// oauthSourceGate is a size-1 semaphore guarding the registry map (the core
// forbids sync.Mutex; channels are the house style).
var (
	oauthSourceGate = make(chan struct{}, 1)
	oauthSources    = map[string]OAuthSource{}
)

// init registers the default accounts' sources so they are present for every
// caller (including package-core tests) regardless of provider-registration
// order.
func init() {
	RegisterOAuthSource(codexDefaultSource, codexSource(""))
	RegisterOAuthSource(copilotDefaultSource, copilotSource(""))
}

// RegisterOAuthSource registers (or replaces) the source for an AuthSource
// name. Safe to call at startup from any package.
func RegisterOAuthSource(name string, source OAuthSource) {
	oauthSourceGate <- struct{}{}
	oauthSources[name] = source
	<-oauthSourceGate
}

// UnregisterOAuthSource drops a source, when the account it served is removed.
func UnregisterOAuthSource(name string) {
	oauthSourceGate <- struct{}{}
	delete(oauthSources, name)
	<-oauthSourceGate
}

// lookupOAuthSource returns the source registered for name, if any.
func lookupOAuthSource(name string) (OAuthSource, bool) {
	oauthSourceGate <- struct{}{}
	source, ok := oauthSources[name]
	<-oauthSourceGate
	return source, ok
}

// HasOAuthLogin reports whether the external login an OAuth source reads is
// present, and the key source it would report (OAuthSource.Present).
func HasOAuthLogin(name string) (bool, KeySource) {
	source, ok := lookupOAuthSource(name)
	if !ok {
		return false, KeySourceNone
	}
	return source.Present == nil || source.Present(), source.KeySource
}

// OAuthLoginLabel is who an OAuth source's login is signed in as, or "" when
// that cannot be said without the network (OAuthSource.Label).
func OAuthLoginLabel(name string) string {
	source, ok := lookupOAuthSource(name)
	if !ok || source.Label == nil {
		return ""
	}
	return source.Label()
}
