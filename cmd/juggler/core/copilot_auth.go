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
	"regexp"
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

// copilotTokenExchangeURL, when non-empty, overrides the token-exchange endpoint
// (tests point it at an httptest server). In production it stays empty and the
// URL is derived per-host by resolveCopilotExchangeURL, so a GitHub Enterprise
// Cloud login exchanges against its own host (api.<tenant>.ghe.com) rather than
// the public api.github.com.
var copilotTokenExchangeURL = ""

// copilotDefaultHost is the public GitHub host. GitHub Enterprise Cloud with
// data residency serves each tenant from <tenant>.ghe.com instead; the login
// discovery below reads the host from the editor login (or the user's saved
// preference) and every endpoint is derived from it.
const copilotDefaultHost = "github.com"

// copilotGHEHostPattern matches a GitHub Enterprise Cloud (data residency) host,
// e.g. "acme.ghe.com". We accept ONLY github.com and *.ghe.com so a stray or
// hostile config value can never point the token exchange at an arbitrary host.
var copilotGHEHostPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*\.ghe\.com$`)

// copilotLogin is a resolved GitHub OAuth login: the long-lived token plus the
// host it belongs to (github.com or a *.ghe.com Enterprise Cloud tenant).
type copilotLogin struct {
	token string
	host  string
	// editor: the login is one an editor keeps on disk, not Juggler's own.
	editor bool
}

// copilotNormalizeHost lower-cases and trims a host so comparisons and map keys
// are stable regardless of how the editor plugin or the user cased it.
func copilotNormalizeHost(host string) string {
	return strings.ToLower(strings.TrimSpace(host))
}

// copilotValidHost reports whether host is one Juggler will talk to: the public
// github.com or a GitHub Enterprise Cloud *.ghe.com tenant.
func copilotValidHost(host string) bool {
	host = copilotNormalizeHost(host)
	return host == copilotDefaultHost || copilotGHEHostPattern.MatchString(host)
}

// resolveCopilotExchangeURL returns the Copilot token-exchange endpoint for host
// (api.<host>/copilot_internal/v2/token). copilotTokenExchangeURL overrides it
// in tests.
func resolveCopilotExchangeURL(host string) string {
	if copilotTokenExchangeURL != "" {
		return copilotTokenExchangeURL
	}
	return "https://api." + host + "/copilot_internal/v2/token"
}

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

// copilotDefaultAPIBase is the individual-plan host; used until an exchange
// reports the account's real endpoints.api (Business/Enterprise plans route to
// api.business./api.enterprise.githubcopilot.com, and calling the wrong host
// returns 400 model_not_supported for every model).
const copilotDefaultAPIBase = "https://api.githubcopilot.com"

func exchangeCopilotToken(ctx context.Context, login copilotLogin) (bearer, apiBase string, expiresAt time.Time, err error) {
	var resp copilotExchangeResponse
	// GitHub accepts the classic "token <oauth>" scheme for these OAuth tokens.
	if err := utils.GetJSON(ctx, resolveCopilotExchangeURL(login.host), utils.JSONGetOptions{
		RawAuthorization: "token " + login.token,
		Headers:          CopilotHeaders(),
		Defaults:         map[string]string{"Accept": "application/json"},
		Label:            "GitHub Copilot token exchange",
	}, &resp); err != nil {
		return "", "", time.Time{}, fmt.Errorf("couldn't exchange the Copilot token (is Copilot enabled on your GitHub account?): %w", err)
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

// loadCopilotLogin finds the GitHub OAuth login (token + host) the user's editor
// Copilot plugin wrote to disk, or one they completed through Juggler. Order:
// explicit env override, then Juggler's own device-flow login, then apps.json
// (current layout), then hosts.json (older neovim/copilot.vim layout). The host
// is either github.com or a *.ghe.com Enterprise Cloud tenant; every endpoint is
// derived from it.
func loadCopilotLogin() (copilotLogin, error) {
	preferred := copilotPreferredHost()

	if tok := strings.TrimSpace(os.Getenv("GH_COPILOT_TOKEN")); tok != "" {
		host := copilotNormalizeHost(os.Getenv("GH_COPILOT_HOST"))
		if host == "" {
			host = preferred
		}
		if host == "" {
			host = copilotDefaultHost
		}
		if !copilotValidHost(host) {
			return copilotLogin{}, fmt.Errorf("GH_COPILOT_HOST %q is not github.com or a *.ghe.com host", host)
		}
		return copilotLogin{token: tok, host: host}, nil
	}
	// A login the user completed through Juggler's device flow takes precedence
	// over an editor's on-disk login — it's the one they explicitly chose here.
	if tok := copilotStoredOAuthToken(); tok != "" {
		host := preferred
		if host == "" {
			host = copilotDefaultHost
		}
		return copilotLogin{token: tok, host: host}, nil
	}
	if login, ok := pickCopilotLogin(copilotEditorLogins(), preferred); ok {
		return login, nil
	}
	return copilotLogin{}, fmt.Errorf("not signed in — click “Sign in with GitHub” below, or sign in to Copilot in VS Code, a JetBrains IDE, or Neovim (checked %s)", copilotConfigDir())
}

// pickCopilotLogin chooses among discovered editor logins: the user's preferred
// host first, then public github.com, then whatever remains — so a GitHub
// Enterprise-only editor login is used automatically, while a machine with both
// a github.com and a *.ghe.com login stays deterministic.
func pickCopilotLogin(logins []copilotLogin, preferred string) (copilotLogin, bool) {
	if preferred != "" {
		for _, l := range logins {
			if l.host == preferred {
				return l, true
			}
		}
	}
	for _, l := range logins {
		if l.host == copilotDefaultHost {
			return l, true
		}
	}
	if len(logins) > 0 {
		return logins[0], true
	}
	return copilotLogin{}, false
}

// copilotEditorLogins are the GitHub logins editors keep on this machine:
// apps.json (current layout), then hosts.json (older neovim/copilot.vim
// layout).
func copilotEditorLogins() []copilotLogin {
	dir := copilotConfigDir()
	var found []copilotLogin
	for _, name := range []string{"apps.json", "hosts.json"} {
		found = append(found, readCopilotTokenFile(filepath.Join(dir, name))...)
	}
	return found
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
// returning every login whose key names a host Juggler talks to (github.com or a
// *.ghe.com tenant). The host is the part before the first ':' — the apps.json
// key is "<host>:<clientId>", the hosts.json key is the bare host.
func readCopilotTokenFile(path string) []copilotLogin {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m map[string]struct {
		OAuthToken string `json:"oauth_token"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		jlog.Debug("copilot: ignoring unparseable %s: %v", path, err)
		return nil
	}
	var out []copilotLogin
	for key, v := range m {
		if v.OAuthToken == "" {
			continue
		}
		host := copilotNormalizeHost(key)
		if i := strings.IndexByte(host, ':'); i >= 0 {
			host = host[:i]
		}
		if !copilotValidHost(host) {
			continue
		}
		out = append(out, copilotLogin{token: v.OAuthToken, host: host, editor: true})
	}
	return out
}
