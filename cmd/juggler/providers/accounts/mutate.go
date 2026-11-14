//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"cmp"
	"errors"
	"fmt"
	"maps"
	"os"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

// An account has two verbs, add and remove; there is no "off". Removing an
// account the user added deletes it and everything keyed to its id. Removing a
// type's default account only marks it removed (enabled_<type>=false), which
// turns it back into a candidate in "Add an account" — and adding it from
// there restores it under its bare id, with everything that names it
// intact. Juggler never deletes a login it does not own: a config dir or a
// CODEX_HOME is the user's.

// SaveResult answers an add or an edit: the account's id, and the whole list
// for the page to redraw from.
type SaveResult struct {
	ID string `json:"id"`
	List
}

// saveParams is one account in the vocabulary the add form and the card post.
type saveParams struct {
	// ID names the account to edit; empty adds one.
	ID string `json:"id"`
	// Type is the type to add an account of.
	Type        string         `json:"type"`
	DisplayName *string        `json:"displayName"`
	Settings    map[string]any `json:"settings"`
	// APIKey, when set, is stored as the account's key.
	APIKey *string `json:"apiKey"`
}

func save(p saveParams) (SaveResult, error) {
	var (
		id  string
		err error
	)
	if p.ID != "" {
		id, err = p.ID, edit(p)
	} else {
		id, err = add(p)
	}
	if err != nil {
		return SaveResult{}, err
	}
	list, err := buildList()
	return SaveResult{ID: id, List: list}, err
}

// takesDefault reports whether adding an account of t with these settings
// restores the type's default account: the default is free (absent or
// removed), and the settings name no login of their own — a folder, a host —
// which would make the account another login, not the default.
func takesDefault(t provider.TypeInfo, settings map[string]any, store *core.CredentialsStore) (bool, error) {
	if !t.HasDefaultAccount || len(settings) > 0 {
		return false, nil
	}
	info, ok := provider.GetProviderInfo(t.Name)
	if !ok {
		return false, fmt.Errorf("%s is not available in this build", t.DisplayName)
	}
	creds, err := store.Load()
	if err != nil {
		return false, err
	}
	state, _ := stateOfDefault(creds, store, info)
	return state != defaultPresent, nil
}

func add(p saveParams) (string, error) {
	t, ok := provider.LookupType(p.Type)
	if !ok {
		return "", fmt.Errorf("unknown provider type %q", p.Type)
	}
	name := ""
	if p.DisplayName != nil {
		name = strings.TrimSpace(*p.DisplayName)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return "", err
	}
	if isDefault, err := takesDefault(t, p.Settings, store); err != nil {
		return "", err
	} else if isDefault {
		return t.Name, addDefault(t, name, p.APIKey, store)
	}
	if t.Instantiate == nil {
		return "", fmt.Errorf("%s takes no further accounts", t.DisplayName)
	}

	var id string
	// The id is allocated, the login checked against every other account's and
	// the entry written in one read-modify-write, so two adds at once can
	// neither take one id nor add one login twice.
	if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		var err error
		if id, err = allocateID(t, name, *f); err != nil {
			return err
		}
		settings, err := prepareSettings(t, *f, id, p.Settings)
		if err != nil {
			return err
		}
		if name == "" {
			name = defaultAccountName(t, id)
		}
		// The key goes in first, so the account is never registered without it.
		if p.APIKey != nil {
			if err := setKeyOf(store, t, id, *p.APIKey); err != nil {
				return err
			}
		}
		f.Accounts[id] = core.AccountEntry{Type: t.Name, DisplayName: name, Settings: settings}
		return nil
	}); err != nil {
		return "", err
	}
	return id, Sync()
}

// addDefault makes a type's default account present again, under its bare
// id, with key as its key when given.
func addDefault(t provider.TypeInfo, name string, key *string, store *core.CredentialsStore) error {
	info, ok := provider.GetProviderInfo(t.Name)
	if !ok {
		return fmt.Errorf("%s is not available in this build", t.DisplayName)
	}
	if err := restoreDefault(store, info); err != nil {
		return err
	}
	if key != nil && info.ConfigKeyName != "" {
		if err := store.SetRawKey(info.ConfigKeyName, *key); err != nil {
			return err
		}
	}
	return setDefaultName(t, name)
}

// defaultAccountName is the name an added account gets when the user gave
// none: the type's name told apart by the id's suffix, or for a type with no
// default account to tell it from, the suffix alone.
func defaultAccountName(t provider.TypeInfo, id string) string {
	suffix := strings.TrimPrefix(id, t.AccountIDPrefix())
	if !t.HasDefaultAccount {
		return suffix
	}
	return provider.AccountName(t.DisplayName, suffix)
}

// prepareSettings puts an account's settings in the form they are saved in
// (the type's PrepareSettings), after refusing settings that name the login
// another account of the type already has — for a Claude Code account, the
// same config dir. The refusal comes first, so a refused add leaves nothing
// behind.
func prepareSettings(t provider.TypeInfo, file core.AccountsFile, self string, settings map[string]any) (map[string]any, error) {
	if other, ok := accountWithLogin(file, t, settings, self); ok {
		return nil, fmt.Errorf("that is already the account %q", cmp.Or(other.DisplayName, other.Type))
	}
	if t.PrepareSettings == nil {
		return settings, nil
	}
	return t.PrepareSettings(settings)
}

// accountWithLogin is the account of t, other than self, whose settings name
// the same login as settings (TypeInfo.LoginKey).
func accountWithLogin(file core.AccountsFile, t provider.TypeInfo, settings map[string]any, self string) (core.AccountEntry, bool) {
	if t.LoginKey == nil {
		return core.AccountEntry{}, false
	}
	key := t.LoginKey(settings)
	if key == "" {
		return core.AccountEntry{}, false
	}
	for id, entry := range file.Accounts {
		if id != self && entry.Type == t.Name && t.LoginKey(entry.Settings) == key {
			return entry, true
		}
	}
	return core.AccountEntry{}, false
}

// setDefaultName records a default account's name when it differs from the
// type's own, which is the only thing about a default account accounts.json
// holds.
func setDefaultName(t provider.TypeInfo, name string) error {
	if name == "" || name == t.DisplayName {
		if !core.AccountsFileExists() {
			return nil
		}
		name = ""
	}
	if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
		if name == "" {
			delete(f.Defaults, t.Name)
		} else {
			f.Defaults[t.Name] = core.DefaultAccountOverride{DisplayName: name}
		}
		return nil
	}); err != nil {
		return err
	}
	return Sync()
}

// restoreDefault makes a type's default account present again. An API-key
// account is its key, so it only needs the removed-flag cleared; any other
// kind is marked added ("true"), so it stays an account while its login or
// server is missing and its card can say how to sign in or start it.
func restoreDefault(store *core.CredentialsStore, info provider.ProviderInfo) error {
	if info.EffectiveAuthType() == provider.AuthTypeAPIKey {
		return store.SetRawKey("enabled_"+info.Name, "")
	}
	return store.SetRawKey("enabled_"+info.Name, "true")
}

func edit(p saveParams) error {
	file, err := core.LoadAccounts()
	if err != nil {
		return err
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}
	if entry, ok := file.Accounts[p.ID]; ok {
		t, known := provider.LookupType(entry.Type)
		if !known && p.Settings != nil {
			return fmt.Errorf("this version of Juggler cannot edit %q", p.ID)
		}
		if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
			e := f.Accounts[p.ID]
			if p.DisplayName != nil {
				e.DisplayName = strings.TrimSpace(*p.DisplayName)
			}
			if p.Settings != nil {
				merged := maps.Clone(e.Settings)
				if merged == nil {
					merged = map[string]any{}
				}
				maps.Copy(merged, p.Settings)
				settings, err := prepareSettings(t, *f, p.ID, merged)
				if err != nil {
					return err
				}
				e.Settings = settings
			}
			f.Accounts[p.ID] = e
			return nil
		}); err != nil {
			return err
		}
		if err := Sync(); err != nil {
			return err
		}
	} else if t, ok := provider.LookupType(p.ID); ok && t.HasDefaultAccount {
		if p.DisplayName != nil {
			if err := setDefaultName(t, strings.TrimSpace(*p.DisplayName)); err != nil {
				return err
			}
		}
	} else {
		return fmt.Errorf("no account %q", p.ID)
	}
	if p.APIKey != nil {
		return setKey(store, file, p.ID, *p.APIKey)
	}
	return nil
}

// errNoKey is the refusal of a key for an account that takes none.
var errNoKey = errors.New("this account takes no API key")

// setKey stores (or, given an empty key, clears) one account's API key, in the
// slot its id resolves to whether or not it is registered.
func setKey(store *core.CredentialsStore, file core.AccountsFile, id, apiKey string) error {
	if entry, ok := file.Accounts[id]; ok {
		t, _ := provider.LookupType(entry.Type)
		return setKeyOf(store, t, id, apiKey)
	}
	if info, ok := provider.GetProviderInfo(id); ok && info.Type == id && info.ConfigKeyName != "" {
		return store.SetRawKey(info.ConfigKeyName, apiKey)
	}
	return fmt.Errorf("no account %q with a key", id)
}

// setKeyOf stores an added account's key in its type's slot for it.
func setKeyOf(store *core.CredentialsStore, t provider.TypeInfo, id, apiKey string) error {
	if t.KeySlot == nil {
		return errNoKey
	}
	key, _ := t.KeySlot(id)
	return store.SetRawKey(key, apiKey)
}

// remove removes one account; see the comment at the top of this file.
func remove(id string) error {
	file, err := core.LoadAccounts()
	if err != nil {
		return err
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return err
	}

	if entry, ok := file.Accounts[id]; ok {
		if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
			delete(f.Accounts, id)
			return nil
		}); err != nil {
			return err
		}
		// Whatever it signed in with inside Juggler goes with it; a login
		// another app keeps (a config dir, a CODEX_HOME, an editor's) is the
		// user's and stays.
		t, _ := provider.LookupType(entry.Type)
		slots := []string{provider.AccountOAuthTokenKey(id)}
		if t.KeySlot != nil {
			key, _ := t.KeySlot(id)
			slots = append(slots, key)
		}
		for _, key := range slots {
			if err := store.SetRawKey(key, ""); err != nil {
				return err
			}
		}
		if err := Sync(); err != nil {
			return err
		}
		// The id is free for a new account now, which must inherit nothing:
		// neither what the type remembers of this one nor what it was chosen
		// for.
		if t.Forget != nil {
			t.Forget(id)
		}
		core.ForgetProviderReferences(id)
		return nil
	}

	t, ok := provider.LookupType(id)
	info, registered := provider.GetProviderInfo(id)
	if !ok || !t.HasDefaultAccount || !registered {
		return fmt.Errorf("no account %q", id)
	}
	if info.EffectiveAuthType() == provider.AuthTypeAPIKey {
		// A key typed into Juggler is the account; deleting it removes it. A
		// key the environment still supplies is not ours to delete, so the
		// flag is what takes the account away and puts the variable under
		// Found.
		if err := store.SetRawKey(info.ConfigKeyName, ""); err != nil {
			return err
		}
		if info.EnvVarName == "" || os.Getenv(info.EnvVarName) == "" {
			return nil
		}
	}
	return store.SetProviderEnabled(id, false)
}

// addCandidate adds an offered login as an account.
func addCandidate(key string) (SaveResult, error) {
	file, err := core.LoadAccounts()
	if err != nil {
		return SaveResult{}, err
	}
	id := key
	if t, ok := provider.LookupType(key); ok && t.HasDefaultAccount {
		store, err := core.NewCredentialsStore()
		if err != nil {
			return SaveResult{}, err
		}
		info, ok := provider.GetProviderInfo(key)
		if !ok {
			return SaveResult{}, fmt.Errorf("nothing to add for %q", key)
		}
		if err := restoreDefault(store, info); err != nil {
			return SaveResult{}, err
		}
	} else if _, ok := file.SwitchedOff[key]; ok {
		if err := core.UpdateAccounts(func(f *core.AccountsFile) error {
			entry, ok := f.SwitchedOff[key]
			if !ok {
				return fmt.Errorf("nothing to add for %q", key)
			}
			delete(f.SwitchedOff, key)
			f.Accounts[key] = entry
			return nil
		}); err != nil {
			return SaveResult{}, err
		}
		if err := Sync(); err != nil {
			return SaveResult{}, err
		}
	} else if c, ok := foundCandidate(key); ok {
		if id, err = add(saveParams{Type: c.Type, DisplayName: &c.DisplayName, Settings: c.Settings}); err != nil {
			return SaveResult{}, err
		}
	} else {
		return SaveResult{}, fmt.Errorf("nothing to add for %q", key)
	}
	list, err := buildList()
	return SaveResult{ID: id, List: list}, err
}

// Preview is the id and name an account added with a given name would get, so
// the add form can show them before the user commits.
type Preview struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	// IsDefault says the add would restore the type's default account, which
	// takes no settings of its own.
	IsDefault bool `json:"isDefault"`
}

// preview answers what adding an account of typeName named name would make.
// It is a forecast: an add made at the same time may take the id first, and
// the add then takes the next.
func preview(typeName, name string, settings map[string]any) (Preview, error) {
	t, ok := provider.LookupType(typeName)
	if !ok {
		return Preview{}, fmt.Errorf("unknown provider type %q", typeName)
	}
	name = strings.TrimSpace(name)
	store, err := core.NewCredentialsStore()
	if err != nil {
		return Preview{}, err
	}
	if isDefault, err := takesDefault(t, settings, store); err != nil {
		return Preview{}, err
	} else if isDefault {
		return Preview{ID: t.Name, DisplayName: cmp.Or(name, t.DisplayName), IsDefault: true}, nil
	}
	file, err := core.LoadAccounts()
	if err != nil {
		return Preview{}, err
	}
	id, err := allocateID(t, name, file)
	if err != nil {
		return Preview{}, err
	}
	return Preview{ID: id, DisplayName: cmp.Or(name, defaultAccountName(t, id))}, nil
}

// allocateID picks the id a new account of t takes beyond its default:
// "<prefix><slug>" (TypeInfo.AccountIDPrefix), the slug taken from the name
// the user gave with the type's own name stripped (AccountNameStem), made
// unique with a numeric suffix. Ids are never renamed afterwards.
func allocateID(t provider.TypeInfo, name string, file core.AccountsFile) (string, error) {
	prefix := t.AccountIDPrefix()
	slug := slugify(provider.AccountNameStem(t.DisplayName, name))
	if room := provider.MaxAccountIDLength - len(prefix) - 3; len(slug) > room {
		slug = strings.TrimRight(slug[:room], "-")
	}
	taken := func(id string) bool {
		_, registered := provider.GetProviderInfo(id)
		_, added := file.Accounts[id]
		_, parked := file.SwitchedOff[id]
		return registered || added || parked
	}
	candidate := func(n int) string {
		switch {
		case slug == "":
			return prefix + strconv.Itoa(n)
		case n == 1:
			return prefix + slug
		default:
			return prefix + slug + "-" + strconv.Itoa(n)
		}
	}
	start := 1
	if slug == "" {
		start = 2
	}
	for n := start; n < 1000; n++ {
		if id := candidate(n); !taken(id) {
			if !provider.AccountIDPattern.MatchString(id) {
				return "", fmt.Errorf("cannot make an account id from %q", name)
			}
			return id, nil
		}
	}
	return "", fmt.Errorf("no free account id for %q", name)
}

// slugify lowercases s, folds accented letters to their base letter ("Équipe"
// is "equipe"), and joins its alphanumeric runs with single hyphens.
func slugify(s string) string {
	var b strings.Builder
	pendingHyphen := false
	for _, r := range norm.NFKD.String(strings.ToLower(s)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingHyphen && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingHyphen = false
			b.WriteRune(r)
		case unicode.Is(unicode.Mn, r):
			// A combining accent left by the decomposition: part of the letter
			// before it.
		default:
			pendingHyphen = true
		}
	}
	return b.String()
}
