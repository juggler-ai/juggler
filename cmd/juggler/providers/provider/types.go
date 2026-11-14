//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"juggler/cmd/juggler/msg"
)

// A provider TYPE is a kind of account — Claude Code, Anthropic, an
// OpenAI-compatible endpoint — and a provider ACCOUNT is one login of a type,
// registered as a provider whose name is the account id. The registry above
// knows only accounts; this one knows the types they are made from, which is
// what the settings page's "Add account" menu lists and what an account in
// accounts.json names.
//
// Each built-in type's first account, its default account, keeps the type's
// own bare name ("claudecode", "anthropic") and is registered exactly as it
// always was, by the type's own package. Further accounts of a type are
// "<type>-<slug>", built by its Instantiate.

// Category groups types in the "Add account" menu.
type Category string

const (
	// CategorySubscription is a plan the user already pays for, reached through
	// a login another app owns (a CLI, an editor).
	CategorySubscription Category = "subscription"
	// CategoryAPIKey is a hosted API reached with a key.
	CategoryAPIKey Category = "api_key"
	// CategoryLocal is a model server on the user's own machine or network.
	CategoryLocal Category = "local"
	// CategoryCustom is an endpoint the user describes themselves.
	CategoryCustom Category = "custom"
)

// AccountIDPattern is the shape of an account id: a lowercase letter, then
// hyphen-separated alphanumeric runs. Safe as a DOM id, a CSS id selector, a
// credential key and a JSON key.
var AccountIDPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)

// MaxAccountIDLength bounds an account id made for a new account.
const MaxAccountIDLength = 40

// Account is one account of a type, as accounts.json records it.
type Account struct {
	// ID is the provider name the account registers as.
	ID          string
	Type        string
	DisplayName string
	// Settings are the type's own per-account fields. Never a secret.
	Settings map[string]any
}

// Candidate is a login found on this machine that is not an account — offered
// in "Add an account" for the user to add, never added on their behalf.
type Candidate struct {
	// Key identifies the candidate, for adding it: the account id it would
	// restore, or "<type>:<path>" for a found login.
	Key string `json:"key"`
	// Type is the provider type it would be an account of.
	Type string `json:"type"`
	// AccountID is the id adding it would give the account.
	AccountID string `json:"accountId"`
	// DisplayName is the name adding it would give the account.
	DisplayName string `json:"displayName,omitempty"`
	// Reason says why it is offered: CandidateRemoved, CandidateSwitchedOff
	// or CandidateFound.
	Reason string `json:"reason"`
	// Path is where it was found (a config dir, a server address), if anywhere.
	Path string `json:"path,omitempty"`
	// Label says who is signed in there, when known. Display only.
	Label string `json:"label,omitempty"`
	// Settings are the account settings adding it would write.
	Settings map[string]any `json:"settings,omitempty"`
}

// Candidate reasons.
const (
	// CandidateRemoved is a type's default account the user removed; adding it
	// back restores it under its bare id.
	CandidateRemoved = "removed"
	// CandidateSwitchedOff is a custom endpoint whose custom-providers.json
	// entry was switched off when it was migrated (AccountsFile.SwitchedOff).
	CandidateSwitchedOff = "switched-off"
	// CandidateFound is a further login discovered on this machine.
	CandidateFound = "found"
)

// TypeInfo describes one provider type.
type TypeInfo struct {
	// Name is the type id, and the id of its default account.
	Name        string
	DisplayName string
	// Description is the one-line blurb in the "Add account" menu.
	Description msg.Message
	Category    Category
	// HasDefaultAccount says the type registers a default account under its
	// bare name with no accounts.json entry — every built-in. False for
	// openai-compatible, which exists only as accounts the user added.
	HasDefaultAccount bool
	// Instantiate builds the provider for one account in accounts.json. Nil
	// for a type that takes no accounts beyond its default.
	Instantiate func(acct Account) (ProviderInfo, ProviderInitializer, error)
	// Discover lists logins found on this machine that are not yet accounts.
	// Nil for a type with nothing to find.
	Discover func(ctx context.Context) []Candidate
	// PrepareSettings validates an account's settings and puts them in the
	// form they are saved in, before an add or an edit. Nil for a type whose
	// accounts carry none.
	PrepareSettings func(settings map[string]any) (map[string]any, error)
	// SignInCommand is the command a user runs in a terminal to sign one of
	// the type's extra accounts in, or "". Nil for a type with no such command.
	SignInCommand func(acct Account) string
	// IDPrefix starts the id of each account added beyond the default; Name
	// and a hyphen when empty.
	IDPrefix string
	// KeySlot names where one of the type's added accounts keeps its API key:
	// the credentials-store key, and the environment variable that may supply
	// it instead ("" for none). Nil for a type whose accounts take no key.
	KeySlot func(accountID string) (configKey, envVar string)
	// LoginKey names the login an account's settings sign in to — a folder, a
	// host's editor login — so that two accounts of the type never share one.
	// "" for settings that name none. Nil for a type whose accounts may repeat.
	// It must not touch the disk beyond reading: it runs before an add is
	// accepted.
	LoginKey func(settings map[string]any) string
	// Forget drops whatever the type keeps in memory for an account that was
	// removed, since its id may be given to a new account. Nil when it keeps
	// nothing.
	Forget func(accountID string)
}

// AccountIDPrefix is what the id of each added account of the type starts
// with.
func (t TypeInfo) AccountIDPrefix() string {
	if t.IDPrefix != "" {
		return t.IDPrefix
	}
	return t.Name + "-"
}

// AccountName is the name an account of a type gets from a word that tells it
// apart: "Anthropic (team)", or "Anthropic (Claude Code CLI, work)" for a type
// whose own name already ends in parentheses.
func AccountName(typeDisplayName, suffix string) string {
	if base, ok := strings.CutSuffix(typeDisplayName, ")"); ok && strings.Contains(base, "(") {
		return base + ", " + suffix + ")"
	}
	return typeDisplayName + " (" + suffix + ")"
}

// AccountNameStem is what tells a name apart from its type's own: the name with
// the type's name, as AccountName writes it, taken off the front. An account id
// is made from it.
func AccountNameStem(typeDisplayName, name string) string {
	for _, prefix := range []string{typeDisplayName, strings.TrimSuffix(typeDisplayName, ")")} {
		if len(name) >= len(prefix) && strings.EqualFold(name[:len(prefix)], prefix) {
			return name[len(prefix):]
		}
	}
	return name
}

// AccountKeySlot is the KeySlot of an API-key type: the account id with
// hyphens folded to underscores, so "anthropic-team" keeps its key under
// "anthropic_team_api_key", and no environment variable — the type's variable
// belongs to the default account, and deriving one (ANTHROPIC_TEAM_API_KEY)
// could collide with a variable the vendor's own tools read. A default account
// keeps the key its type always used.
func AccountKeySlot(accountID string) (configKey, envVar string) {
	return strings.ReplaceAll(accountID, "-", "_") + "_api_key", ""
}

// AccountOAuthTokenKey is the credentials-store key holding the OAuth token an
// extra account signed in with inside Juggler (a Copilot device-flow login):
// "copilot-work" keeps its token under "copilot_work_oauth_token". A default
// account keeps the key its type always used.
func AccountOAuthTokenKey(accountID string) string {
	return strings.ReplaceAll(accountID, "-", "_") + "_oauth_token"
}

// InstantiateAPIKeyAccount is the Instantiate of an API-key type: the type's
// default account, registered under the account's id and name with the key
// slot AccountKeySlot gives it. The default's initializer serves every
// account, since a client is handed its key in Config and keeps no state
// shared between keys.
func InstantiateAPIKeyAccount(acct Account) (ProviderInfo, ProviderInitializer, error) {
	info, initializer, err := CloneAccount(acct)
	if err != nil {
		return ProviderInfo{}, nil, err
	}
	if info.EffectiveAuthType() != AuthTypeAPIKey {
		return ProviderInfo{}, nil, fmt.Errorf("provider type %q does not use an API key", acct.Type)
	}
	info.ConfigKeyName, info.EnvVarName = AccountKeySlot(acct.ID)
	return info, initializer, nil
}

// CloneAccount is the type's default account's provider under acct's id and
// name, with no label: the start of an Instantiate for a type whose clients
// take everything that differs between accounts from their Config (a key, a
// bearer and its headers), so the default's initializer serves every account.
// The caller changes what makes the account its own — a key slot, an OAuth
// source.
func CloneAccount(acct Account) (ProviderInfo, ProviderInitializer, error) {
	registryLock <- struct{}{}
	base, ok := providerInfos[acct.Type]
	initializer := initializers[acct.Type]
	<-registryLock
	if !ok || base.Type != acct.Type {
		return ProviderInfo{}, nil, fmt.Errorf("provider type %q is not registered", acct.Type)
	}
	info := base
	info.Name = acct.ID
	info.Type = acct.Type
	// Never the default's registered name, which may be the user's own name for
	// that account.
	info.DisplayName = acct.DisplayName
	if info.DisplayName == "" {
		if t, ok := LookupType(acct.Type); ok {
			info.DisplayName = t.DisplayName
		}
	}
	info.AccountLabel = ""
	return info, initializer, nil
}

var (
	typesLock = make(chan struct{}, 1)
	types     = make(map[string]TypeInfo)
)

// RegisterType registers a provider type, replacing one of the same name.
func RegisterType(t TypeInfo) {
	typesLock <- struct{}{}
	types[t.Name] = t
	<-typesLock
}

// LookupType returns the type named name.
func LookupType(name string) (TypeInfo, bool) {
	typesLock <- struct{}{}
	defer func() { <-typesLock }()
	t, ok := types[name]
	return t, ok
}

// Types returns every registered type, sorted by name.
func Types() []TypeInfo {
	typesLock <- struct{}{}
	out := make([]TypeInfo, 0, len(types))
	for _, t := range types {
		out = append(out, t)
	}
	<-typesLock
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
