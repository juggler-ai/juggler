//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package copilot

import (
	"cmp"
	"context"
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
)

// A further Copilot account is a GitHub login of its own on a host of its own
// (core/copilot_accounts.go): one the user signs in to on its card through the
// device flow, or an editor's login on a host the default account does not
// use, found on this machine and added from there.

// TypeName is the provider type, and the id of its default account.
const TypeName = "copilot"

// AccountType gives the type what its further accounts need.
func AccountType(t *provider.TypeInfo) {
	t.Instantiate = Instantiate
	t.Discover = Discover
	t.PrepareSettings = PrepareSettings
	t.LoginKey = LoginKey
	t.Forget = Forget
}

// Account settings.
const (
	// hostSetting is the account's GitHub host: github.com or a *.ghe.com
	// Enterprise Cloud tenant.
	hostSetting = "host"
	// loginSetting is loginEditor for an account whose login is the one an
	// editor keeps for its host.
	loginSetting = "login"
	loginEditor  = "editor"
)

// Instantiate builds the provider for one extra account: its own login, its
// own bearer, and its own plan's API host.
func Instantiate(acct provider.Account) (provider.ProviderInfo, provider.ProviderInitializer, error) {
	host, _ := acct.Settings[hostSetting].(string)
	source, err := core.CopilotAuthSource(acct.ID, host, acct.Settings[loginSetting] == loginEditor)
	if err != nil {
		return provider.ProviderInfo{}, nil, err
	}
	d := descriptor(acct.ID, cmp.Or(acct.DisplayName, displayName), source, apiBaseFor(acct.ID))
	d.Type = TypeName
	info, initializer := openaibase.Build(d)
	info.AccountLabel = core.OAuthLoginLabel(source)
	return info, initializer, nil
}

// PrepareSettings validates an extra account's GitHub host, github.com when
// none is given, and keeps only the settings an account has.
func PrepareSettings(settings map[string]any) (map[string]any, error) {
	raw, _ := settings[hostSetting].(string)
	host, err := core.CopilotNormalizeHost(raw)
	if err != nil {
		return nil, err
	}
	out := map[string]any{hostSetting: host}
	if settings[loginSetting] == loginEditor {
		out[loginSetting] = loginEditor
	}
	return out, nil
}

// LoginKey is the login an account's settings name: an editor's login is one
// per host; a device-flow login is the account's own, so it names none.
func LoginKey(settings map[string]any) string {
	if settings[loginSetting] != loginEditor {
		return ""
	}
	host, err := core.CopilotNormalizeHost(fmt.Sprint(settings[hostSetting]))
	if err != nil {
		return ""
	}
	return loginEditor + ":" + host
}

// Forget drops what core keeps in memory for a removed account.
func Forget(accountID string) {
	core.ForgetCopilotAccount(accountID)
}

// Discover offers the editor logins on this machine the default account does
// not use — a github.com login beside an Enterprise Cloud one — each as an
// account of its own.
func Discover(_ context.Context) []provider.Candidate {
	var out []provider.Candidate
	for _, host := range core.CopilotFoundLogins() {
		out = append(out, provider.Candidate{
			Key:         TypeName + ":editor:" + host,
			Type:        TypeName,
			DisplayName: provider.AccountName(displayName, host),
			Reason:      provider.CandidateFound,
			Path:        host,
			Settings:    map[string]any{hostSetting: host, loginSetting: "editor"},
		})
	}
	return out
}
