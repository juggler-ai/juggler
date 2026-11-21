//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"os"
	"slices"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// CodexHomes lists the CODEX_HOMEs on this machine whose sessions/ folders
// may hold Codex transcripts, each once, in its one spelling
// (provider.CanonicalDir): the default account's first (core.CodexHome), then
// every extra account's in accounts.json, then any further login found where
// one conventionally lives (conventionalHomes). It reads files only — never a
// credential — so a process that registers no providers, as a machine server
// does, may call it. Whether a folder exists, or holds any transcript, is the
// caller's to find out.
func CodexHomes() []string {
	seen := map[string]bool{}
	var out []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		dir = provider.CanonicalDir(dir)
		key := provider.FolderLoginKey(dir)
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, dir)
	}
	defaultHome, _ := core.CodexHome()
	add(defaultHome)
	if f, err := core.LoadAccounts(); err != nil {
		jlog.Error("[openaicodex] reading accounts for their CODEX_HOMEs: %v", err)
	} else {
		var extra []string
		for _, acct := range f.Accounts {
			if dir, _ := acct.Settings[codexHomeSetting].(string); acct.Type == TypeName && dir != "" {
				extra = append(extra, dir)
			}
		}
		// Map order is random; the list is not.
		slices.Sort(extra)
		for _, dir := range extra {
			add(dir)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, dir := range conventionalHomes(home, defaultHome) {
			add(dir)
		}
	}
	return out
}
