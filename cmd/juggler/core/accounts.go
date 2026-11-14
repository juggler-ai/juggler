//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// accounts.json records the provider accounts the user added on top of each
// type's default account: a second Claude Code login, a team Anthropic key, a
// custom endpoint. A provider account registers as a provider whose name is
// its id, so everything keyed on a provider name — credentials, model
// selections, hidden models, every conversation — is per account for free.
//
// The default account of a built-in type keeps the type's bare name and is not
// listed here, which is why an install that never adds an account has no file
// at all, and why upgrading needs no migration for any built-in provider. The
// one migration is of custom-providers.json, whose endpoints become accounts
// here; the file's existence is the record that it ran.
//
// Secrets never go in here. Keys stay in credentials.json.

// AccountsFileVersion is the schema version written into accounts.json.
const AccountsFileVersion = 1

// AccountEntry is one account the user added.
type AccountEntry struct {
	// Type is the provider type the account instantiates, e.g. "claudecode" or
	// "openai-compatible".
	Type string `json:"type"`
	// DisplayName is the account's name in the model picker and settings.
	DisplayName string `json:"displayName,omitempty"`
	// Settings are the type's own per-account fields (a config dir, a base URL).
	// Never a secret.
	Settings map[string]any `json:"settings,omitempty"`
}

// DefaultAccountOverride is what the user changed about a type's default
// account, which otherwise has no entry anywhere.
type DefaultAccountOverride struct {
	DisplayName string `json:"displayName,omitempty"`
}

// AccountsFile is the parsed accounts.json document.
type AccountsFile struct {
	Version int `json:"version"`
	// Accounts maps an account id (the provider name it registers as) to its
	// entry.
	Accounts map[string]AccountEntry `json:"accounts,omitempty"`
	// SwitchedOff holds custom endpoints that were switched off when
	// custom-providers.json was migrated. They are not accounts — there is no
	// "off" state — but are offered back in "Add an account", which needs their
	// definitions kept somewhere.
	SwitchedOff map[string]AccountEntry `json:"switchedOff,omitempty"`
	// Defaults maps a type name to what the user changed about its default
	// account.
	Defaults map[string]DefaultAccountOverride `json:"defaults,omitempty"`
}

// normalize fills the maps a reader or a mutation expects to be able to index.
func (f *AccountsFile) normalize() {
	if f.Version == 0 {
		f.Version = AccountsFileVersion
	}
	if f.Accounts == nil {
		f.Accounts = map[string]AccountEntry{}
	}
	if f.SwitchedOff == nil {
		f.SwitchedOff = map[string]AccountEntry{}
	}
	if f.Defaults == nil {
		f.Defaults = map[string]DefaultAccountOverride{}
	}
}

// accountsLock serialises this process's read-modify-writes; the file lock
// serialises them against the other juggler servers sharing the config dir.
// A 1-capacity channel used as a binary semaphore (the codebase forbids
// sync.Mutex).
var accountsLock = make(chan struct{}, 1)

// AccountsPath is <ConfigDir>/accounts.json.
func AccountsPath() string {
	return filepath.Join(userpaths.ConfigDir(), "accounts.json")
}

func accountsLockPath() string {
	return filepath.Join(userpaths.ConfigDir(), "accounts.lock")
}

// AccountsFileExists reports whether accounts.json exists, which is the record
// that custom-providers.json has been migrated.
func AccountsFileExists() bool {
	_, err := os.Stat(AccountsPath())
	return err == nil
}

// LoadAccounts reads accounts.json. A missing file reads as an empty document;
// an unparseable one is an error, so it surfaces rather than silently dropping
// every account (QuarantineCorruptAccounts is the startup's remedy).
func LoadAccounts() (AccountsFile, error) {
	var f AccountsFile
	data, err := atomicio.RobustReadFile(AccountsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			f.normalize()
			return f, nil
		}
		return f, fmt.Errorf("failed to read accounts.json: %w", err)
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &f); err != nil {
			return AccountsFile{}, fmt.Errorf("failed to parse accounts.json: %w", err)
		}
	}
	f.normalize()
	return f, nil
}

// UpdateAccounts runs a read-modify-write of accounts.json, serialised against
// every other writer in this process and on this machine. The file is created
// if missing. A mutation returning an error writes nothing.
func UpdateAccounts(mutate func(*AccountsFile) error) error {
	accountsLock <- struct{}{}
	defer func() { <-accountsLock }()
	return withFileLock(accountsLockPath(), "accounts", func() error {
		f, err := LoadAccounts()
		if err != nil {
			return err
		}
		if err := mutate(&f); err != nil {
			return err
		}
		return writeAccounts(f)
	})
}

// writeAccounts writes the document atomically and owner-only: an account's
// settings can hold a gateway's request headers, which are credential-adjacent.
func writeAccounts(f AccountsFile) error {
	f.normalize()
	f.Version = AccountsFileVersion
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o700); err != nil {
		return err
	}
	return atomicio.WriteFile(AccountsPath(), data, 0o600)
}

// QuarantineCorruptAccounts moves an unparseable accounts.json aside to
// accounts.json.corrupt, keeping its bytes for manual recovery, and writes an
// empty document in its place. Writing one, rather than leaving no file, is what
// stops the custom-providers.json migration from running again and bringing
// back endpoints the user has since removed. The default accounts are
// unaffected either way: they never depended on the file. Reports whether it
// quarantined anything.
func QuarantineCorruptAccounts() (bool, error) {
	accountsLock <- struct{}{}
	defer func() { <-accountsLock }()
	quarantined := false
	err := withFileLock(accountsLockPath(), "accounts", func() error {
		_, loadErr := LoadAccounts()
		if loadErr == nil || !AccountsFileExists() {
			return nil
		}
		quarantine := AccountsPath() + ".corrupt"
		if err := atomicio.RobustRename(AccountsPath(), quarantine); err != nil {
			return fmt.Errorf("%w (and could not move it aside: %v)", loadErr, err)
		}
		jlog.Error("[Accounts] Quarantined corrupt accounts.json to %s (%v); the accounts it held are gone until restored by hand", quarantine, loadErr)
		quarantined = true
		return writeAccounts(AccountsFile{})
	})
	return quarantined, err
}
