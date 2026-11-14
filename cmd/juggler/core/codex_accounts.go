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
	"regexp"
	"strings"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
)

// Several ChatGPT accounts are several Codex logins, each in its own
// CODEX_HOME, read exactly as the default ~/.codex/auth.json is
// (docs/provider-auth-policy.md). The default account's OAuth source is
// "codex_cli"; an extra account's is "codex_cli:<its CODEX_HOME>", registered
// the first time the account asks for it.

const (
	// codexDefaultSource is the default account's OAuth source.
	codexDefaultSource = "codex_cli"
	// codexSourcePrefix starts the OAuth source name of a login kept in a
	// CODEX_HOME of its own.
	codexSourcePrefix = codexDefaultSource + ":"
)

// CodexHome is the default account's CODEX_HOME: $CODEX_HOME, or ~/.codex.
func CodexHome() (string, error) {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return home, nil
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get user home directory: %w", err)
	}
	return filepath.Join(homeDir, ".codex"), nil
}

// codexAuthPathIn is auth.json in codexHome, or in the default account's
// CODEX_HOME when codexHome is "".
func codexAuthPathIn(codexHome string) (string, error) {
	if codexHome == "" {
		var err error
		if codexHome, err = CodexHome(); err != nil {
			return "", err
		}
	}
	return filepath.Join(codexHome, "auth.json"), nil
}

// CodexSignInCommand is the command that signs in the login kept in codexHome,
// keeping it in a file — the keyring has no auth.json for Juggler to read. ""
// is the default account's CODEX_HOME, which needs no variable set.
func CodexSignInCommand(codexHome string) string {
	const login = "codex login -c cli_auth_credentials_store=file"
	if codexHome == "" {
		return login
	}
	return provider.SignInCommandLine("CODEX_HOME", codexHome, login)
}

// CodexAuthSource is the OAuth source that reads the Codex login kept in
// codexHome, registering it on first use; the default account's for "".
func CodexAuthSource(codexHome string) string {
	if codexHome == "" {
		return codexDefaultSource
	}
	name := codexSourcePrefix + codexHome
	if _, ok := lookupOAuthSource(name); !ok {
		RegisterOAuthSource(name, codexSource(codexHome))
	}
	return name
}

// codexSource is the OAuth source of the Codex login kept in codexHome ("" for
// the default account's).
func codexSource(codexHome string) OAuthSource {
	return OAuthSource{
		Resolve: func() (ProviderCredential, error) { return resolveCodexCredential(codexHome) },
		Present: func() bool {
			path, err := codexAuthPathIn(codexHome)
			if err != nil {
				return false
			}
			_, err = os.Stat(path)
			return err == nil
		},
		Label: func() string {
			login, err := ReadCodexLogin(codexHome)
			if err != nil {
				return ""
			}
			return login.Email
		},
		KeySource: KeySourceCodexCLI,
	}
}

// resolveCodexCredential resolves the bearer of the ChatGPT login kept in
// codexHome ("" for the default account's).
func resolveCodexCredential(codexHome string) (ProviderCredential, error) {
	token, accountID, err := loadCodexAccessToken(codexHome)
	if err != nil {
		return errorAuthHint(err), err
	}
	var headers map[string]string
	if accountID != "" {
		headers = map[string]string{"ChatGPT-Account-Id": accountID}
	}
	return ProviderCredential{
		BearerToken: token,
		Headers:     headers,
		KeySource:   KeySourceCodexCLI,
	}.withAuthHint(msg.New("Signed in via ChatGPT app or Codex CLI")), nil
}

// CodexLogin is what a Codex login says about itself.
type CodexLogin struct {
	// AuthMode is "chatgpt" for a ChatGPT plan, "apikey" for a Platform key.
	AuthMode string
	// Email is who signed in, from the id_token's email claim.
	Email string
}

// ReadCodexLogin reads the login kept in codexHome ("" for the default
// account's), without minting or checking a token.
func ReadCodexLogin(codexHome string) (CodexLogin, error) {
	path, err := codexAuthPathIn(codexHome)
	if err != nil {
		return CodexLogin{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return CodexLogin{}, err
	}
	var auth codexAuthFile
	if err := json.Unmarshal(data, &auth); err != nil {
		return CodexLogin{}, err
	}
	return CodexLogin{AuthMode: auth.AuthMode, Email: jwtEmail(auth.Tokens.IDToken)}, nil
}

// jwtEmail is the email claim of a JWT, unverified: it names an account on a
// settings card and decides nothing.
func jwtEmail(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return claims.Email
}

// codexKeyringStore matches config.toml asking the Codex CLI to keep its
// login in the OS keyring ("keyring", or "auto", which prefers it).
var codexKeyringStore = regexp.MustCompile(`(?m)^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"`)

// codexKeepsLoginInKeyring reports whether codexHome's config keeps the login
// in the system keyring, where there is no auth.json for Juggler to read.
func codexKeepsLoginInKeyring(codexHome string) bool {
	data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	return err == nil && codexKeyringStore.Match(data)
}
