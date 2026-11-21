//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"cmp"
	"context"
	"errors"
	"os"
	"sort"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
)

// Several ChatGPT accounts — a personal and a work plan — are several Codex
// logins, each in its own CODEX_HOME, which the user signs in with `codex
// login` (file storage, so there is an auth.json to read). Juggler reads each
// auth.json exactly as it reads the default ~/.codex/auth.json and never writes
// or refreshes one, so two accounts never contend for a refresh token. It never
// moves a conversation to another account on its own
// (docs/provider-auth-policy.md).

// TypeName is the provider type, and the id of its default account.
const TypeName = "openaicodex"

// AccountType gives the type what its further accounts need.
func AccountType(t *provider.TypeInfo) {
	t.Instantiate = Instantiate
	t.Discover = Discover
	t.PrepareSettings = PrepareSettings
	t.SignInCommand = SignInCommand
	t.LoginKey = LoginKey
}

// codexHomeSetting is the account setting holding an extra account's
// CODEX_HOME.
const codexHomeSetting = "codexHome"

// homePrefixes start the names of the folders a further login conventionally
// lives in.
var homePrefixes = []string{".codex-", ".codex_"}

// Instantiate builds the provider for one extra account: the default
// account's, reading the login in the account's own CODEX_HOME and naming that
// CODEX_HOME wherever it says how to sign in.
func Instantiate(acct provider.Account) (provider.ProviderInfo, provider.ProviderInitializer, error) {
	home, _ := acct.Settings[codexHomeSetting].(string)
	if home == "" {
		return provider.ProviderInfo{}, nil, errors.New("no CODEX_HOME")
	}
	info, initializer := openaibase.Build(descriptor(acct.ID, cmp.Or(acct.DisplayName, displayName), home))
	info.AccountLabel = core.OAuthLoginLabel(info.AuthSource)
	return info, initializer, nil
}

// PrepareSettings validates an extra account's CODEX_HOME and gives it its one
// spelling, creating it if it does not exist: `codex login` refuses a
// CODEX_HOME that is not there.
func PrepareSettings(settings map[string]any) (map[string]any, error) {
	raw, _ := settings[codexHomeSetting].(string)
	defaultHome, _ := core.CodexHome()
	dir, err := provider.PrepareAccountDir(raw, defaultHome)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return map[string]any{codexHomeSetting: dir}, nil
}

// LoginKey is the login an account's settings name: its CODEX_HOME.
func LoginKey(settings map[string]any) string {
	raw, _ := settings[codexHomeSetting].(string)
	return provider.FolderLoginKey(raw)
}

// SignInCommand is the command that signs an extra account in.
func SignInCommand(acct provider.Account) string {
	home, _ := acct.Settings[codexHomeSetting].(string)
	if home == "" {
		return ""
	}
	return core.CodexSignInCommand(home)
}

// Discover lists the ChatGPT logins on this machine that are not the default
// account's: ~/.codex-<name> and ~/.codex_<name>, and the CODEX_HOMEs shell
// startup files name, each holding an auth.json signed in with ChatGPT.
func Discover(_ context.Context) []provider.Candidate {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	defaultHome, _ := core.CodexHome()
	return discoverIn(home, defaultHome)
}

// conventionalHomes lists the CODEX_HOMEs in home where a further login
// conventionally lives, in their one spelling, sorted, without defaultHome —
// the default account's.
func conventionalHomes(home, defaultHome string) []string {
	seen := map[string]bool{provider.FolderLoginKey(defaultHome): true}
	var dirs []string
	for _, dir := range append(provider.FoldersNamedLike(home, homePrefixes...), provider.FoldersNamedInShellFiles(home, "CODEX_HOME")...) {
		dir = provider.CanonicalDir(dir)
		if key := provider.FolderLoginKey(dir); !seen[key] {
			seen[key] = true
			dirs = append(dirs, dir)
		}
	}
	sort.Strings(dirs)
	return dirs
}

// discoverIn is Discover for the home directory home, with defaultHome the
// default account's CODEX_HOME.
func discoverIn(home, defaultHome string) []provider.Candidate {
	dirs := conventionalHomes(home, defaultHome)

	var out []provider.Candidate
	for _, dir := range dirs {
		login, err := core.ReadCodexLogin(dir)
		if err != nil || login.AuthMode != "chatgpt" {
			continue
		}
		out = append(out, provider.Candidate{
			Key:         TypeName + ":" + dir,
			Type:        TypeName,
			DisplayName: provider.AccountName(displayName, provider.FolderSuffix(dir, homePrefixes...)),
			Reason:      provider.CandidateFound,
			Path:        provider.HomeRelative(dir, home),
			Label:       login.Email,
			Settings:    map[string]any{codexHomeSetting: dir},
		})
	}
	return out
}
