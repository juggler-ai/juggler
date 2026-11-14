//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"juggler/internal/jlog"
)

// ForgetProviderReferences drops the preferences and selections that name a
// provider id: its hidden models and token limits, and the default, cheap,
// decision and recent model entries naming it.
//
// This is the only place a provider's curated preferences are destroyed, and it
// is deliberate. Everywhere else, settings and the model stores KEEP entries
// naming a provider they cannot see — a build without it, or one waiting on a
// credential, must not cost the user what they curated. Deleting an account is
// not that case: it is gone for good, and its id is free to be given to a
// different account, which would otherwise inherit hidden models and token
// limits describing models it has never served. A type's default account is
// never deleted this way — removing one only marks it removed, so it comes back
// with everything it had.
//
// Conversations keep the ModelRef they hold: a conversation is history, and the
// picker says the provider is not configured.
//
// Failures are logged rather than returned. The account itself is already
// gone, so there is nothing for the user to retry, and every reader of these
// stores already tolerates an entry naming a provider that is not registered.
func ForgetProviderReferences(name string) {
	if _, err := UpdateGlobalSettings(func(gs *GlobalSettings) bool {
		_, hidden := gs.Models.Hidden[name]
		_, limited := gs.Models.Limits[name]
		if !hidden && !limited {
			return false
		}
		delete(gs.Models.Hidden, name)
		delete(gs.Models.Limits, name)
		return true
	}); err != nil {
		jlog.Error("[Accounts] Could not drop %s's model preferences: %v", name, err)
	}

	if store, err := NewDefaultModelStore(); err != nil {
		jlog.Error("[Accounts] Could not open the default-model store: %v", err)
	} else {
		clearModelRefNaming(name, "default model", store.Load, store.Save)
	}
	if store, err := NewCheapModelStore(); err != nil {
		jlog.Error("[Accounts] Could not open the cheap-model store: %v", err)
	} else {
		// Adapted to the shared helper's ModelRef shape. Only the pin is at
		// stake here: a setting that names no provider cannot name this one, so
		// an explicit "no cheap model" is never reached, let alone undone.
		load := func() (ModelRef, error) {
			setting, err := store.Load()
			return setting.ModelRef, err
		}
		save := func(ref ModelRef) error {
			return store.Save(CheapModelSetting{ModelRef: ref})
		}
		clearModelRefNaming(name, "cheap model", load, save)
	}
	if store, err := NewDecisionModelStore(); err != nil {
		jlog.Error("[Accounts] Could not open the decision-model store: %v", err)
	} else {
		clearModelRefNaming(name, "decision model", store.Load, store.Save)
	}
	if store, err := NewRecentModelsStore(); err != nil {
		jlog.Error("[Accounts] Could not open the recent-models store: %v", err)
	} else if err := store.RemoveProvider(name); err != nil {
		jlog.Error("[Accounts] Could not drop %s from the recent models: %v", name, err)
	}
}

// clearModelRefNaming clears a stored model selection when it names the given
// provider. The stores read an empty ref as "forget the selection", which puts
// the choice back where it started rather than leaving a pick nothing can serve.
func clearModelRefNaming(providerName, label string, load func() (ModelRef, error), save func(ModelRef) error) {
	ref, err := load()
	if err != nil {
		jlog.Error("[Accounts] Could not read the %s selection: %v", label, err)
		return
	}
	if ref.Provider != providerName {
		return
	}
	if err := save(ModelRef{}); err != nil {
		jlog.Error("[Accounts] Could not clear the %s selection: %v", label, err)
	}
}
