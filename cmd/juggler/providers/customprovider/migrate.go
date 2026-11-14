//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"encoding/json"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// LegacyID is the id of the endpoint that was once Juggler's only custom
// OpenAI-compatible provider, configured through three raw credentials rather
// than through an instance record.
//
// It is the one instance whose registered provider id is not prefixed, and the
// one whose credential key and environment variable keep their historic names.
// The id is what every stored reference names — default-model.json,
// cheap-model.json, recent-models.json, models.hidden, models.limits and every
// conversation document — and there is no transaction spanning those, so it can
// never be renamed.
const LegacyID = "openai-compatible"

// The raw credentials the single endpoint was configured through. The API key
// is left where it is: the migrated instance registers a ConfigKeyName naming
// this same key, so the user's existing key is found unmoved.
const (
	legacyBaseURLCredKey = "openai_compatible_base_url"
	legacyHeadersCredKey = "openai_compatible_headers"
	legacyAPIKeyCredKey  = "openai_compatible_api_key"
	legacyEnvVarName     = "OPENAI_COMPATIBLE_API_KEY"
	legacyDisplayName    = "OpenAI-compatible (custom)"
)

// migrateToAccounts moves the endpoints into accounts.json, once. In order:
//
//   - accounts.json exists: done. Its existence is the whole record of the
//     migration having run — nothing it reads is ever cleared, since a
//     downgrade needs it — so a user who deletes a migrated endpoint would
//     otherwise have it resurrected on every start. A corrupt one is moved
//     aside and replaced by an empty one, for the same reason
//     (core.QuarantineCorruptAccounts).
//   - custom-providers.json exists: each endpoint becomes an account under the
//     id it was registered as, keeping its key where it is. One that was
//     switched off is kept aside to be offered back rather than made an
//     account. The file is left exactly as it was, for a downgrade.
//   - the three raw credentials of the single endpoint that predates the file
//     exist: it becomes the account LegacyID, keeping its historic id and key.
//
// Anything else writes nothing: an accounts.json written for a user who had no
// endpoint would be a lie about having asked.
func migrateToAccounts() error {
	if core.AccountsFileExists() {
		_, err := core.QuarantineCorruptAccounts()
		return err
	}
	instances, exists, err := loadLegacyFile()
	if err != nil {
		// Written by an older build and unparseable there too, so nothing the
		// user had was working. Nothing is written, so a fixed file migrates on
		// the next start.
		return err
	}
	if !exists {
		inst, ok := legacySingleton()
		if !ok {
			return nil
		}
		instances = map[string]Instance{LegacyID: inst}
	}
	return core.UpdateAccounts(func(f *core.AccountsFile) error {
		for id, inst := range instances {
			// An entry that could never have been saved through the UI was
			// never registered either, so it is dropped and named in the log.
			if err := validateIDShape(id); err != nil {
				jlog.Error("[CustomProvider] Not migrating entry: %v", err)
				continue
			}
			if err := ValidateInstance(inst); err != nil {
				jlog.Error("[CustomProvider] Not migrating %q: %v", id, err)
				continue
			}
			if inst.IsEnabled() {
				f.Accounts[RegisteredName(id)] = entryFromInstance(inst)
			} else {
				f.SwitchedOff[RegisteredName(id)] = entryFromInstance(inst)
			}
		}
		return nil
	})
}

// legacySingleton reads the one endpoint the raw credentials describe, from the
// days before there could be several. The credentials are never cleared (a
// downgrade would need them).
func legacySingleton() (Instance, bool) {
	store, err := core.NewCredentialsStore()
	if err != nil {
		return Instance{}, false
	}
	baseURL := strings.TrimSpace(store.GetRawKey(legacyBaseURLCredKey))
	if baseURL == "" {
		return Instance{}, false
	}
	return Instance{
		DisplayName: legacyDisplayName,
		Protocol:    ProtocolOpenAI,
		BaseURL:     baseURL,
		Headers:     parseHeaderJSON(store.GetRawKey(legacyHeadersCredKey)),
	}, true
}

// parseHeaderJSON parses a JSON object of string→string header pairs. Blank
// input returns nil; malformed input is logged and treated as no headers, so a
// typo in the old settings box costs the headers rather than the endpoint.
func parseHeaderJSON(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		jlog.Error("[CustomProvider] Ignoring invalid custom headers JSON: %v", err)
		return nil
	}
	if len(parsed) == 0 {
		return nil
	}
	return parsed
}
