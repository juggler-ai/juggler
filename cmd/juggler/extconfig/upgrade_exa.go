//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package extconfig

import (
	"slices"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// Where an Exa API key is stored: the @juggler/exa extension's own setting
// in builds up to 0.8.1, and one of the Web Search Services' settings since.
var (
	exaKeyBefore = secretKey("@juggler/exa", "api_key")
	exaKeyAfter  = secretKey("@juggler/search-backends", "exa_api_key")
)

// exaWebSearchOrder is the Web search order given to a user whose Exa key is
// moved: Exa first, then the default.
var exaWebSearchOrder = append([]string{"@juggler/search-backends/exa"}, core.DefaultWebSearchOrder...)

// UpgradeExaToWebSearch carries an Exa API key saved under @juggler/exa to
// its setting in @juggler/search-backends and, while the Web search order is
// still the default, puts Exa first in it — so a user who searched with Exa's
// own tool searches with Exa through WebSearch. A key already set in the new
// place is kept.
//
// It acts once: the old key is deleted last, after the order is written, so a
// step that fails is retried at the next start rather than half-done for good.
// Every project's server runs it at start; each step is idempotent, so two
// starting together agree.
func UpgradeExaToWebSearch() {
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		jlog.Error("extconfig: Exa key upgrade: %v", err)
		return
	}
	upgradeExaToWebSearch(credentials)
}

func upgradeExaToWebSearch(credentials *core.CredentialsStore) {
	old := credentials.GetRawKey(exaKeyBefore)
	if old == "" {
		return
	}
	if credentials.GetRawKey(exaKeyAfter) == "" {
		if err := credentials.SetRawKey(exaKeyAfter, old); err != nil {
			jlog.Error("extconfig: moving the Exa API key: %v", err)
			return
		}
	}
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		if gs.WebSearch.Order != nil {
			return false // the user has chosen an order; leave it
		}
		order := slices.Clone(exaWebSearchOrder)
		gs.WebSearch.Order = &order
		return true
	}); err != nil {
		jlog.Error("extconfig: putting Exa in the Web search order: %v", err)
		return
	}
	if err := credentials.SetRawKey(exaKeyBefore, ""); err != nil {
		jlog.Error("extconfig: deleting the moved Exa API key: %v", err)
		return
	}
	jlog.Info("extconfig: moved the Exa API key to Web Search Services")
}
