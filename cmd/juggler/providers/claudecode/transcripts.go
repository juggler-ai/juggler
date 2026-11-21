//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
	"juggler/internal/projectpaths"
)

// What a reader of the user's own Claude Code transcripts needs to know that
// only this package does: where the CLI keeps them (ConfigDirs, then
// <dir>/projects/<ProjectDirName(cwd)>/<uuid>.jsonl), and which of them
// Juggler wrote itself (JugglerSessionUUIDs, SyntheticVersion). Each reads
// files only — none runs claude or reads a credential — so a process that
// registers no providers, as a machine server does, may call them.

// ConfigDirs lists the config dirs on this machine whose projects/ folders
// may hold Claude Code transcripts, each once, in its one spelling
// (provider.CanonicalDir): the default account's first, then every extra
// account's in accounts.json, then any further login found where one
// conventionally lives (conventionalLogins). Whether a folder exists, or holds
// any transcript, is the caller's to find out.
func ConfigDirs() []string {
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
	defaultDir := defaultConfigDir()
	add(defaultDir)
	if f, err := core.LoadAccounts(); err != nil {
		jlog.Error("[claudecode] reading accounts for their config dirs: %v", err)
	} else {
		var extra []string
		for _, acct := range f.Accounts {
			if dir, _ := acct.Settings[configDirSetting].(string); acct.Type == TypeName && dir != "" {
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
		for _, dir := range conventionalLogins(home, defaultDir) {
			add(dir)
		}
	}
	return out
}

// JugglerSessionUUIDs is the set of claude session UUIDs project's
// conversations ran on: the one each conversation's sidecar names
// (claude_session.json), in the open conversations and the binned ones, and in
// the legacy flat sidecars. A sidecar names only a conversation's latest
// session, so a transcript Juggler drove earlier in the same conversation is
// not here; tell those by what they hold (SyntheticVersion, Juggler's tools).
// Empty, never nil, for a project with no state folder.
func JugglerSessionUUIDs(project string) map[string]bool {
	out := map[string]bool{}
	read := func(path string) {
		data, err := os.ReadFile(path)
		if err != nil {
			return
		}
		var st diskSessionState
		if json.Unmarshal(data, &st) == nil && st.SessionUUID != "" {
			out[st.SessionUUID] = true
		}
	}
	stateDir := projectpaths.StateDir(project)
	for _, dir := range []string{stateDir, core.ConvBinDir(stateDir)} {
		idx, err := core.ScanConvDirs(dir)
		if err != nil {
			continue
		}
		for _, folder := range idx.ByID {
			read(filepath.Join(folder, "claude_session.json"))
		}
	}
	entries, _ := os.ReadDir(stateDir)
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".claudecode.json") {
			read(filepath.Join(stateDir, e.Name()))
		}
	}
	return out
}
