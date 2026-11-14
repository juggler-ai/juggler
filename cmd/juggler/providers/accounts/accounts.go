//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package accounts is the user's provider accounts as one list: each type's
// default account when it is present, every account added in accounts.json,
// and the logins on this machine that are not accounts (candidates). It is
// what the settings page's Providers section draws, through the "accounts" ops.
//
// An account is a registered provider whose name is the account id (see
// provider.TypeInfo), so nothing here sits on the path of a turn: a turn names
// a provider, and the registry resolves it as it always has.
package accounts

import (
	"cmp"
	"errors"
	"os"
	"sort"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// Account is one account as the settings page draws it.
type Account struct {
	ID              string `json:"id"`
	Type            string `json:"type"`
	TypeDisplayName string `json:"typeDisplayName"`
	DisplayName     string `json:"displayName"`
	Category        string `json:"category"`
	// IsDefault marks the type's default account, which keeps the type's bare
	// id and has no accounts.json entry.
	IsDefault bool `json:"isDefault"`
	// Detected marks a default account found on this machine — a login
	// another app keeps, a CLI or a local server — rather than typed in.
	Detected bool `json:"detected,omitempty"`
	// KeySource says where its key or login comes from — "credentials" for a
	// key typed into Juggler, "env" for an environment variable, or the
	// external login it borrows. Empty for an account with no key to speak of.
	KeySource core.KeySource `json:"keySource,omitempty"`
	// EnvVarName is the environment variable that may supply its key, if any.
	EnvVarName string `json:"envVarName,omitempty"`
	// Problem says why an account that should be registered is not, and
	// ProblemMessage is the message it was rendered from, when it was.
	Problem        string       `json:"problem,omitempty"`
	ProblemMessage *msg.Message `json:"problemMessage,omitempty"`
	// AccountLabel says who is signed in, when known.
	AccountLabel string `json:"accountLabel,omitempty"`
	// SignInCommand is what to run in a terminal to sign the account in, for
	// a type that signs in outside Juggler.
	SignInCommand string `json:"signInCommand,omitempty"`
	// Settings are the type's per-account fields, from accounts.json.
	Settings map[string]any `json:"settings,omitempty"`
	// Registered reports that the account reached the provider registry, so
	// its models can be listed and chosen.
	Registered bool `json:"registered"`
}

// List is the whole of the Providers section's data.
type List struct {
	Accounts   []Account            `json:"accounts"`
	Candidates []provider.Candidate `json:"candidates"`
}

// defaultState is where a type's default account stands.
type defaultState int

const (
	// defaultAbsent: nothing configured or found, so no card and no candidate;
	// the type is reached through "Add account".
	defaultAbsent defaultState = iota
	// defaultPresent: an account, shown with a card.
	defaultPresent
	// defaultRemoved: the user removed it (enabled_<type>=false), so it is a
	// candidate.
	defaultRemoved
)

// stateOfDefault decides where a type's default account stands, without the
// network: a key is read where it is stored, a login is looked for on disk, and
// only a local server's own detection probe may reach out, as it always has.
func stateOfDefault(creds core.Credentials, store *core.CredentialsStore, info provider.ProviderInfo) (defaultState, core.KeySource) {
	flag, flagged := creds["enabled_"+info.Name]
	if flagged && flag == "false" {
		return defaultRemoved, core.KeySourceNone
	}
	switch info.EffectiveAuthType() {
	case provider.AuthTypeToggle:
		if flag == "true" || (!flagged && info.AutoDetect != nil && provider.CheckAutoDetect(info.Name)) {
			return defaultPresent, core.KeySourceNone
		}
	case provider.AuthTypeOAuthBearer:
		if ok, source := core.HasOAuthLogin(info.AuthSource); ok {
			return defaultPresent, source
		}
		// Added from "Add account" before its login exists: a card that says
		// how to sign in.
		if flag == "true" {
			return defaultPresent, core.KeySourceNone
		}
	case provider.AuthTypeAPIKey:
		if source := store.GetAPIKeySource(info.Name); source != core.KeySourceNone {
			return defaultPresent, source
		}
	}
	return defaultAbsent, core.KeySourceNone
}

// isDetected reports whether a present default account was found on this
// machine rather than typed in: a CLI or local server, or an OAuth login that
// is there (one added before its login exists was not found).
func isDetected(info provider.ProviderInfo, source core.KeySource) bool {
	switch info.EffectiveAuthType() {
	case provider.AuthTypeToggle:
		return true
	case provider.AuthTypeOAuthBearer:
		return source != core.KeySourceNone
	default:
		return false
	}
}

// buildList assembles the accounts and candidates.
func buildList() (List, error) {
	refreshLoginLabels()
	file, err := core.LoadAccounts()
	if err != nil {
		return List{}, err
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return List{}, err
	}
	creds, err := store.Load()
	if err != nil {
		return List{}, err
	}

	out := List{Accounts: []Account{}, Candidates: []provider.Candidate{}}

	for _, t := range provider.Types() {
		if !t.HasDefaultAccount {
			continue
		}
		info, ok := provider.GetProviderInfo(t.Name)
		if !ok {
			continue
		}
		state, source := stateOfDefault(creds, store, info)
		// The name the picker shows, which Sync derives (applyDefaultNames).
		name := info.DisplayName
		switch state {
		case defaultPresent:
			out.Accounts = append(out.Accounts, Account{
				ID: t.Name, Type: t.Name, TypeDisplayName: t.DisplayName, DisplayName: name,
				Category: string(t.Category), IsDefault: true, KeySource: source,
				Detected:   isDetected(info, source),
				EnvVarName: info.EnvVarName, AccountLabel: info.AccountLabel, Registered: true,
			})
		case defaultRemoved:
			out.Candidates = append(out.Candidates, provider.Candidate{
				Key: t.Name, Type: t.Name, AccountID: t.Name, DisplayName: name, Reason: provider.CandidateRemoved,
			})
		case defaultAbsent:
		}
	}

	for id, entry := range file.Accounts {
		out.Accounts = append(out.Accounts, addedAccount(id, entry, creds))
	}

	for id, entry := range file.SwitchedOff {
		out.Candidates = append(out.Candidates, provider.Candidate{
			Key: id, Type: entry.Type, AccountID: id, DisplayName: entry.DisplayName,
			Reason: provider.CandidateSwitchedOff, Settings: entry.Settings,
		})
	}

	out.Candidates = append(out.Candidates, foundCandidates(file)...)

	// Default accounts first, in type order, then the added ones by id, so a
	// card keeps its place across redraws.
	sort.SliceStable(out.Accounts, func(i, j int) bool {
		a, b := out.Accounts[i], out.Accounts[j]
		if a.IsDefault != b.IsDefault {
			return a.IsDefault
		}
		if a.IsDefault {
			return false // already in type order
		}
		return a.ID < b.ID
	})
	sort.SliceStable(out.Candidates, func(i, j int) bool { return out.Candidates[i].Key < out.Candidates[j].Key })
	return out, nil
}

// addedAccount is the card of an account in accounts.json, whether or not it
// could be registered: one that could not is the one the user has come to
// settings to fix.
func addedAccount(id string, entry core.AccountEntry, creds core.Credentials) Account {
	a := Account{ID: id, Type: entry.Type, DisplayName: entry.DisplayName, Settings: entry.Settings}
	t, known := provider.LookupType(entry.Type)
	if known {
		a.TypeDisplayName = t.DisplayName
		a.Category = string(t.Category)
		if t.SignInCommand != nil {
			a.SignInCommand = t.SignInCommand(provider.Account{ID: id, Type: entry.Type, DisplayName: entry.DisplayName, Settings: entry.Settings})
		}
		if t.KeySlot != nil {
			// Read from the slot rather than through the registry, so an
			// account that did not register still shows its key row.
			key, envVar := t.KeySlot(id)
			a.KeySource, a.EnvVarName = keySourceOf(creds, key, envVar), envVar
		}
	}
	if info, ok := provider.GetProviderInfo(id); ok {
		a.Registered = true
		a.AccountLabel = info.AccountLabel
		a.DisplayName = cmp.Or(a.DisplayName, info.DisplayName)
	} else {
		var m msg.Message
		var me *msg.Error
		switch err := refusal(id); {
		case err == nil, errors.Is(err, errNoType):
			m = msg.New("This version of Juggler cannot use this account.")
		case errors.As(err, &me):
			m = me.Message
		default:
			a.Problem = err.Error()
		}
		if !m.IsZero() {
			a.Problem, a.ProblemMessage = m.English(), &m
		}
	}
	a.DisplayName = cmp.Or(a.DisplayName, id)
	return a
}

// keySourceOf is where a key kept in the credentials slot key, or else in the
// environment variable envVar, comes from.
func keySourceOf(creds core.Credentials, key, envVar string) core.KeySource {
	switch {
	case creds[key] != "":
		return core.KeySourceCredentials
	case envVar != "" && os.Getenv(envVar) != "":
		return core.KeySourceEnvVar
	default:
		return core.KeySourceNone
	}
}

// TypeEntry is one type in the "Add account" menu.
type TypeEntry struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
	// DescriptionMessage is the message Description was rendered from.
	DescriptionMessage *msg.Message `json:"descriptionMessage,omitempty"`
	Category           string       `json:"category"`
	// HasDefaultAccount marks a built-in type, whose first account takes the
	// type's bare id.
	HasDefaultAccount bool `json:"hasDefaultAccount"`
	// AcceptsExtra says the type can take accounts beyond its default.
	AcceptsExtra bool `json:"acceptsExtra"`
}

// typeEntries lists the types for the "Add account" menu.
func typeEntries() []TypeEntry {
	types := provider.Types()
	out := make([]TypeEntry, 0, len(types))
	for _, t := range types {
		entry := TypeEntry{
			Name: t.Name, DisplayName: t.DisplayName, Description: t.Description.English(),
			Category: string(t.Category), HasDefaultAccount: t.HasDefaultAccount,
			AcceptsExtra: t.Instantiate != nil,
		}
		if !t.Description.IsZero() {
			m := t.Description
			entry.DescriptionMessage = &m
		}
		out = append(out, entry)
	}
	return out
}

// logListError logs a list failure the ops layer is about to report.
func logListError(err error) {
	jlog.Error("[Accounts] Could not list accounts: %v", err)
}
