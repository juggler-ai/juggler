//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"errors"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/customprovider"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// The accounts this package registered, so Sync can retire the ones the user
// removed, and why each one it could not register was refused, for its card.
//
// syncLock serialises whole reconciliations and guards both; a 1-capacity
// channel used as a binary semaphore (the codebase forbids sync.Mutex).
var (
	syncLock   = make(chan struct{}, 1)
	registered = map[string]bool{}
	refused    = map[string]error{}
)

// errNoType refuses an account whose type this build does not have, or whose
// type takes no accounts beyond its default here. The entry stays in the file
// for a build that can.
var errNoType = errors.New("this build cannot use this account")

// RegisterAll registers every account in accounts.json, after migrating the
// custom endpoints into it on the first start that needs to. Call it once at
// startup, after the built-ins and before any credential is read: a provider's
// key is resolved through the ConfigKeyName its registration carries.
func RegisterAll() {
	customprovider.RegisterType()
	if err := Sync(); err != nil {
		jlog.Error("[Accounts] Could not register accounts: %v", err)
	}
	go rediscover(context.Background())
}

// ApplyDefaultNames gives each type's default account the name the picker
// shows for it, from accounts.json and who is signed in. Call it when an
// account changes in place (provider.OnAccountChanged).
func ApplyDefaultNames() {
	file, err := core.LoadAccounts()
	if err != nil {
		return
	}
	applyDefaultNames(file)
}

// Sync reconciles the registry with accounts.json: each account is built by
// its type's Instantiate and registered (re-registering replaces an edited
// one), and one no longer in the file is unregistered. A turn already under
// way keeps the client it built.
func Sync() error {
	syncLock <- struct{}{}
	defer func() { <-syncLock }()

	file, err := core.LoadAccounts()
	if err != nil {
		return err
	}
	desired := map[string]bool{}
	refused = map[string]error{}
	for id, entry := range file.Accounts {
		t, ok := provider.LookupType(entry.Type)
		if !ok || t.Instantiate == nil {
			refused[id] = errNoType
			jlog.Error("[Accounts] Not registering %q: this build has no %q accounts", id, entry.Type)
			continue
		}
		info, initializer, err := t.Instantiate(provider.Account{
			ID: id, Type: entry.Type, DisplayName: entry.DisplayName, Settings: entry.Settings,
		})
		if err != nil {
			refused[id] = err
			jlog.Error("[Accounts] Not registering %q: %v", id, err)
			continue
		}
		provider.RegisterProvider(info, initializer)
		desired[id] = true
	}
	for id := range registered {
		if !desired[id] {
			provider.UnregisterProvider(id)
		}
	}
	registered = desired
	refreshLoginLabels()
	applyDefaultNames(file)
	return nil
}

// refusal is why Sync could not register the account id, or nil.
func refusal(id string) error {
	syncLock <- struct{}{}
	defer func() { <-syncLock }()
	return refused[id]
}

// refreshLoginLabels re-reads who is signed in to every account whose login is
// a file another app keeps (core.OAuthLoginLabel), since that changes whenever
// the user signs in there. A label a provider learns some other way is left
// alone.
func refreshLoginLabels() {
	for _, info := range provider.ListProviderInfos() {
		if info.EffectiveAuthType() != provider.AuthTypeOAuthBearer {
			continue
		}
		if label := core.OAuthLoginLabel(info.AuthSource); label != "" && label != info.AccountLabel {
			provider.SetAccountLabel(info.Name, label)
		}
	}
}

// applyDefaultNames gives each type's default account, which its own package
// registered under the type's name, the name the picker shows for it.
func applyDefaultNames(file core.AccountsFile) {
	extras := map[string]int{}
	for _, entry := range file.Accounts {
		extras[entry.Type]++
	}
	for _, t := range provider.Types() {
		if !t.HasDefaultAccount {
			continue
		}
		info, ok := provider.GetProviderInfo(t.Name)
		if !ok {
			continue
		}
		if want := defaultDisplayName(t, file, info.AccountLabel, extras[t.Name] > 0); info.DisplayName != want {
			provider.SetDisplayName(t.Name, want)
		}
	}
}

// defaultDisplayName is the name of a type's default account: the user's own
// name for it, or else the type's — told apart by who is signed in once the
// type has a second account, so two groups in the picker never share a name.
func defaultDisplayName(t provider.TypeInfo, file core.AccountsFile, label string, hasExtras bool) string {
	if override := file.Defaults[t.Name].DisplayName; override != "" {
		return override
	}
	if hasExtras && label != "" {
		return t.DisplayName + " (" + label + ")"
	}
	return t.DisplayName
}
