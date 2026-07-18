//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"
)

// GitHub Copilot uses two-legged auth. A long-lived GitHub OAuth token (written
// to disk by the user's editor Copilot plugin) is exchanged at
// copilot_internal/v2/token for a short-lived (~25-30 min) Copilot bearer, which
// is what api.githubcopilot.com actually accepts. We cache the exchanged bearer
// in-process and re-exchange only when it nears expiry — so while it's fresh the
// credential string is stable and the conversation cache (keyed on
// credential.CacheKey) gets a hit, and after refresh the new string
// transparently rebuilds the cached client.

// copilotTokenExchangeURL is a var (not const) so tests can point it at an
// httptest server.
var copilotTokenExchangeURL = "https://api.github.com/copilot_internal/v2/token"

const (
	// Editor identity presented to GitHub. The Copilot endpoints only serve an
	// allow-listed editor client, so Juggler presents the values a current
	// VS Code Copilot Chat build sends. Bump these together. Note: this is
	// outside GitHub's published ToS — see the provider docs.
	copilotEditorVersion = "vscode/1.99.3"
	copilotPluginVersion = "copilot-chat/0.26.7"
	copilotUserAgent     = "GitHubCopilotChat/0.26.7"
	copilotIntegrationID = "vscode-chat"
	// copilotAPIVersion and copilotIntent are required on /chat/completions:
	// without them the endpoint rejects otherwise-valid models with a 400
	// model_not_supported. /models is lenient and doesn't need them, but sending
	// them everywhere is harmless and matches a real editor client.
	copilotAPIVersion = "2025-04-01"
	copilotIntent     = "conversation-panel"

	// copilotRefreshMargin re-exchanges this long before expires_at so an
	// in-flight turn never races the token going stale.
	copilotRefreshMargin = 5 * time.Minute

	// copilotFallbackTTL bounds a token whose response omitted expires_at.
	copilotFallbackTTL = 25 * time.Minute
)

// resolveCopilotCredential is the OAuthBearerResolver registered for the
// "github_copilot" source (see oauth_sources.go). It sources the GitHub login,
// exchanges it for a short-lived Copilot bearer, and returns the resolved
// credential with the Copilot request headers attached.
func resolveCopilotCredential() (ProviderCredential, error) {
	token, err := loadCopilotBearer()
	if err != nil {
		return ProviderCredential{AuthHint: err.Error()}, err
	}
	return ProviderCredential{
		BearerToken: token,
		Headers:     CopilotHeaders(),
		KeySource:   KeySourceCopilot,
		AuthHint:    copilotSignedInHint(),
	}, nil
}

// copilotSignedInHint labels the signed-in state, naming how the login was
// sourced so the settings UI can tell a device-flow login from an editor one.
func copilotSignedInHint() string {
	if copilotHasDeviceLogin() {
		return "Signed in with GitHub"
	}
	return "Signed in via your editor's Copilot login"
}

// CopilotHeaders are the headers api.githubcopilot.com (and the token-exchange
// endpoint) require alongside Authorization. Returned in the resolved
// credential so the openaibase client sends them on every request.
func CopilotHeaders() map[string]string {
	return map[string]string{
		"Editor-Version":         copilotEditorVersion,
		"Editor-Plugin-Version":  copilotPluginVersion,
		"Copilot-Integration-Id": copilotIntegrationID,
		"User-Agent":             copilotUserAgent,
		"Openai-Intent":          copilotIntent,
		"X-GitHub-Api-Version":   copilotAPIVersion,
		// X-Initiator is REQUIRED on /chat/completions: without it the endpoint
		// rejects otherwise-valid models with 400 model_not_supported (the same
		// symptom a missing Editor-Version produces). /models is lenient and
		// doesn't need it. Editor clients vary it (user vs agent) for premium-
		// request accounting; a constant "user" satisfies the model-support gate.
		"X-Initiator":                         "user",
		"X-Vscode-User-Agent-Library-Version": "electron-fetch",
	}
}

type copilotExchangeResponse struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
	Endpoints struct {
		API string `json:"api"`
	} `json:"endpoints"`
}

type copilotCachedToken struct {
	bearer    string
	apiBase   string // account-correct API host from the exchange (endpoints.api)
	expiresAt time.Time
	oauthKey  string // re-exchange if the underlying GitHub login changes
}

// copilotDefaultAPIBase is the individual-plan host; used until an exchange
// reports the account's real endpoints.api (Business/Enterprise plans route to
// api.business./api.enterprise.githubcopilot.com, and calling the wrong host
// returns 400 model_not_supported for every model).
const copilotDefaultAPIBase = "https://api.githubcopilot.com"

// copilotTokenGate is a size-1 semaphore serialising read-modify-write on the
// cached token (the core forbids sync.Mutex; channels are the house style).
var (
	copilotTokenGate  = make(chan struct{}, 1)
	copilotTokenCache copilotCachedToken
)

// CopilotAPIBase returns the API host the last token exchange reported for this
// account (falling back to the individual-plan host before the first exchange).
// The provider uses it for both /models and /chat/completions so they always
// agree with the account's plan.
func CopilotAPIBase() string {
	copilotTokenGate <- struct{}{}
	defer func() { <-copilotTokenGate }()
	if copilotTokenCache.apiBase != "" {
		return copilotTokenCache.apiBase
	}
	return copilotDefaultAPIBase
}

// loadCopilotBearer sources the GitHub OAuth token, then returns a valid
// short-lived Copilot bearer, exchanging (and caching) only when needed.
func loadCopilotBearer() (string, error) {
	oauth, err := loadCopilotOAuthToken()
	if err != nil {
		return "", err
	}

	copilotTokenGate <- struct{}{}
	defer func() { <-copilotTokenGate }()

	if c := copilotTokenCache; c.bearer != "" && c.oauthKey == oauth &&
		time.Now().Add(copilotRefreshMargin).Before(c.expiresAt) {
		return c.bearer, nil
	}

	bearer, apiBase, expiresAt, err := exchangeCopilotToken(context.Background(), oauth)
	if err != nil {
		return "", err
	}
	copilotTokenCache = copilotCachedToken{bearer: bearer, apiBase: apiBase, expiresAt: expiresAt, oauthKey: oauth}
	return bearer, nil
}

func exchangeCopilotToken(ctx context.Context, oauth string) (bearer, apiBase string, expiresAt time.Time, err error) {
	var resp copilotExchangeResponse
	// GitHub accepts the classic "token <oauth>" scheme for these OAuth tokens.
	if err := utils.GetJSON(ctx, copilotTokenExchangeURL, utils.JSONGetOptions{
		RawAuthorization: "token " + oauth,
		Headers:          CopilotHeaders(),
		Defaults:         map[string]string{"Accept": "application/json"},
		Label:            "GitHub Copilot token exchange",
	}, &resp); err != nil {
		return "", "", time.Time{}, fmt.Errorf("copilot token exchange failed (is your GitHub Copilot subscription active?): %w", err)
	}
	if resp.Token == "" {
		return "", "", time.Time{}, fmt.Errorf("copilot token exchange returned no token")
	}
	expiresAt = time.Now().Add(copilotFallbackTTL)
	if resp.ExpiresAt > 0 {
		expiresAt = time.Unix(resp.ExpiresAt, 0)
	}
	apiBase = strings.TrimRight(strings.TrimSpace(resp.Endpoints.API), "/")
	if apiBase == "" {
		apiBase = copilotDefaultAPIBase
	}
	// GitHub reports the individual-plan host as api.individual.githubcopilot.com,
	// but the chat endpoint for individual plans is the bare api.githubcopilot.com
	// (what the official editor clients use). Business/Enterprise keep their own
	// subdomain from endpoints.api.
	apiBase = strings.Replace(apiBase, "//api.individual.githubcopilot.com", "//api.githubcopilot.com", 1)
	return resp.Token, apiBase, expiresAt, nil
}

// loadCopilotOAuthToken finds the GitHub OAuth token the user's editor Copilot
// plugin wrote to disk. Order: explicit env override, then apps.json (current
// layout), then hosts.json (older neovim/copilot.vim layout).
func loadCopilotOAuthToken() (string, error) {
	if tok := strings.TrimSpace(os.Getenv("GH_COPILOT_TOKEN")); tok != "" {
		return tok, nil
	}
	// A login the user completed through Juggler's device flow takes precedence
	// over an editor's on-disk login — it's the one they explicitly chose here.
	if tok := copilotStoredOAuthToken(); tok != "" {
		return tok, nil
	}
	dir := copilotConfigDir()
	for _, name := range []string{"apps.json", "hosts.json"} {
		if tok := readCopilotTokenFile(filepath.Join(dir, name)); tok != "" {
			return tok, nil
		}
	}
	return "", fmt.Errorf("not signed in — click “Sign in with GitHub” below, or sign in to Copilot in VS Code, a JetBrains IDE, or Neovim (checked %s)", dir)
}

func copilotConfigDir() string {
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "github-copilot")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".config", "github-copilot")
	}
	return filepath.Join(home, ".config", "github-copilot")
}

// readCopilotTokenFile parses both the apps.json shape
//
//	{"github.com:Iv1.xxxx": {"oauth_token": "gho_..."}, ...}
//
// and the hosts.json shape
//
//	{"github.com": {"oauth_token": "gho_..."}}
//
// returning the first oauth_token found under a github.com* key.
func readCopilotTokenFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var m map[string]struct {
		OAuthToken string `json:"oauth_token"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		jlog.Debug("copilot: ignoring unparseable %s: %v", path, err)
		return ""
	}
	for key, v := range m {
		if strings.HasPrefix(key, "github.com") && v.OAuthToken != "" {
			return v.OAuthToken
		}
	}
	return ""
}
