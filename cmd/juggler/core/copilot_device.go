//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitHub OAuth device flow for Copilot sign-in. Users without an editor Copilot
// plugin (or who don't want to depend on one) can sign in directly from
// Juggler: we POST for a device+user code, the user enters the user code at
// github.com/login/device, and we poll until GitHub returns an OAuth token. That
// long-lived token is persisted in the credentials store (copilot_oauth_token)
// and thereafter sourced by loadCopilotOAuthToken, exactly like an editor login,
// then exchanged for the short-lived Copilot bearer on each use.

// Device-flow endpoints (vars so tests can point them at an httptest server).
var (
	copilotDeviceCodeURL  = "https://github.com/login/device/code"
	copilotAccessTokenURL = "https://github.com/login/oauth/access_token"
)

const (
	// copilotClientID is the public GitHub App client id the editor Copilot
	// plugins use for the device flow. Not a secret (it ships in every editor
	// plugin); it only identifies the app the user authorises.
	copilotClientID = "Iv1.b507a08c87ecfe98"

	// copilotOAuthScope is the scope the editor plugins request.
	copilotOAuthScope = "read:user"

	// copilotOAuthTokenKey is the credentials.json key holding the device-flow
	// OAuth token once the user signs in through Juggler.
	copilotOAuthTokenKey = "copilot_oauth_token"
)

// CopilotDeviceCode is the start-of-flow payload the UI shows the user: enter
// UserCode at VerificationURI, then the client polls with DeviceCode.
type CopilotDeviceCode struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	ExpiresIn       int    `json:"expiresIn"`
	Interval        int    `json:"interval"`
}

// CopilotLoginStatus is the outcome of one device-flow poll.
type CopilotLoginStatus string

const (
	CopilotLoginPending    CopilotLoginStatus = "pending"    // user hasn't authorised yet; keep polling
	CopilotLoginSlowDown   CopilotLoginStatus = "slow_down"  // poll less often; keep polling
	CopilotLoginAuthorized CopilotLoginStatus = "authorized" // token obtained and persisted
	CopilotLoginExpired    CopilotLoginStatus = "expired"    // device code expired; restart the flow
	CopilotLoginDenied     CopilotLoginStatus = "denied"     // user denied access
)

// StartCopilotDeviceLogin requests a device+user code pair from GitHub.
func StartCopilotDeviceLogin(ctx context.Context) (CopilotDeviceCode, error) {
	var raw struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
		Error           string `json:"error"`
		ErrorDetail     string `json:"error_description"`
	}
	form := url.Values{"client_id": {copilotClientID}, "scope": {copilotOAuthScope}}
	if err := copilotPostForm(ctx, copilotDeviceCodeURL, form, &raw); err != nil {
		return CopilotDeviceCode{}, err
	}
	if raw.Error != "" {
		return CopilotDeviceCode{}, fmt.Errorf("github device-code request failed: %s", copilotErrText(raw.Error, raw.ErrorDetail))
	}
	if raw.DeviceCode == "" || raw.UserCode == "" {
		return CopilotDeviceCode{}, fmt.Errorf("github device-code response was incomplete")
	}
	interval := raw.Interval
	if interval <= 0 {
		interval = 5
	}
	return CopilotDeviceCode{
		DeviceCode:      raw.DeviceCode,
		UserCode:        raw.UserCode,
		VerificationURI: raw.VerificationURI,
		ExpiresIn:       raw.ExpiresIn,
		Interval:        interval,
	}, nil
}

// PollCopilotDeviceLogin performs one poll for deviceCode. On authorization it
// persists the OAuth token (and clears the bearer cache) before returning
// CopilotLoginAuthorized; otherwise it maps GitHub's error to a status the
// caller loops on. A non-nil error is a transport/unexpected failure only.
func PollCopilotDeviceLogin(ctx context.Context, deviceCode string) (CopilotLoginStatus, error) {
	if strings.TrimSpace(deviceCode) == "" {
		return "", fmt.Errorf("device code is required")
	}
	var raw struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDetail string `json:"error_description"`
	}
	form := url.Values{
		"client_id":   {copilotClientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	if err := copilotPostForm(ctx, copilotAccessTokenURL, form, &raw); err != nil {
		return "", err
	}
	if raw.AccessToken != "" {
		if err := storeCopilotOAuthToken(raw.AccessToken); err != nil {
			return "", fmt.Errorf("failed to persist Copilot login: %w", err)
		}
		return CopilotLoginAuthorized, nil
	}
	switch raw.Error {
	case "authorization_pending":
		return CopilotLoginPending, nil
	case "slow_down":
		return CopilotLoginSlowDown, nil
	case "expired_token":
		return CopilotLoginExpired, nil
	case "access_denied":
		return CopilotLoginDenied, nil
	default:
		return "", fmt.Errorf("github device-login failed: %s", copilotErrText(raw.Error, raw.ErrorDetail))
	}
}

// SignOutCopilot clears a device-flow login (and the cached bearer). It does not
// touch an editor-managed login on disk — only Juggler's own stored token.
func SignOutCopilot() error {
	return clearCopilotDeviceLogin()
}

// copilotPostForm POSTs form-encoded values and decodes a JSON response,
// requesting JSON via Accept so GitHub doesn't reply with a query string.
func copilotPostForm(ctx context.Context, endpoint string, form url.Values, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("failed to build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", copilotUserAgent)

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github returned %d: %s", resp.StatusCode, string(body))
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return fmt.Errorf("failed to decode github response: %w", err)
	}
	return nil
}

func copilotErrText(code, detail string) string {
	if detail != "" {
		return detail
	}
	if code != "" {
		return code
	}
	return "unknown error"
}

// storeCopilotOAuthToken persists the device-flow OAuth token and invalidates
// the cached bearer so the next resolve re-exchanges under the new login.
func storeCopilotOAuthToken(token string) error {
	store, err := NewCredentialsStore()
	if err != nil {
		return err
	}
	if err := store.SetRawKey(copilotOAuthTokenKey, token); err != nil {
		return err
	}
	clearCopilotTokenCache()
	return nil
}

func clearCopilotDeviceLogin() error {
	store, err := NewCredentialsStore()
	if err != nil {
		return err
	}
	if err := store.SetRawKey(copilotOAuthTokenKey, ""); err != nil {
		return err
	}
	clearCopilotTokenCache()
	return nil
}

// copilotStoredOAuthToken returns the device-flow token Juggler persisted, or ""
// when the user hasn't signed in through Juggler.
func copilotStoredOAuthToken() string {
	store, err := NewCredentialsStore()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(store.GetRawKey(copilotOAuthTokenKey))
}

// copilotHasDeviceLogin reports whether a Juggler device-flow login is stored.
func copilotHasDeviceLogin() bool {
	return copilotStoredOAuthToken() != ""
}

// clearCopilotTokenCache drops the cached exchanged bearer so the next resolve
// re-exchanges (after a sign-in/sign-out changes the underlying OAuth token).
func clearCopilotTokenCache() {
	copilotTokenGate <- struct{}{}
	copilotTokenCache = copilotCachedToken{}
	<-copilotTokenGate
}
