//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"sort"

	"juggler/cmd/juggler/providers/provider"
)

// Discovery finds the further Claude Code logins already on this machine, for
// the settings page to offer in "Add an account". It looks where a
// second login conventionally lives — a ~/.claude-<name> or ~/.claude_<name>
// config dir, or one a shell alias or export points CLAUDE_CONFIG_DIR at — and
// confirms each with `claude auth status` run as that login. Reading a dotfile
// to find a path is all it reads: never a token.
//
// A path is probed only when it already holds a .claude.json. The CLI creates
// its config dir on any call, `auth status` included, so probing a guess would
// leave an empty folder in the user's home.

// loginPrefixes start the names of the folders a further login conventionally
// lives in.
var loginPrefixes = []string{".claude-", ".claude_"}

// Discover lists the Claude Code logins on this machine that are not the
// default account's. Which of them are accounts already is the caller's to
// weed out.
func Discover(ctx context.Context) []provider.Candidate {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	return discoverIn(ctx, home, defaultConfigDir())
}

// conventionalLogins lists the config dirs in home where a further login
// conventionally lives that hold a .claude.json, in their one spelling,
// sorted, without defaultDir — the default account's.
func conventionalLogins(home, defaultDir string) []string {
	skip := provider.FolderLoginKey(defaultDir)

	seen := map[string]bool{}
	var dirs []string
	consider := func(dir string) {
		dir = provider.CanonicalDir(dir)
		key := provider.FolderLoginKey(dir)
		if seen[key] || key == skip {
			return
		}
		seen[key] = true
		if info, err := os.Stat(filepath.Join(dir, ".claude.json")); err == nil && info.Mode().IsRegular() {
			dirs = append(dirs, dir)
		}
	}
	for _, dir := range provider.FoldersNamedLike(home, loginPrefixes...) {
		consider(dir)
	}
	for _, dir := range provider.FoldersNamedInShellFiles(home, "CLAUDE_CONFIG_DIR") {
		consider(dir)
	}
	sort.Strings(dirs)
	return dirs
}

// discoverIn is Discover for the home directory home, with defaultDir the
// default account's config dir.
func discoverIn(ctx context.Context, home, defaultDir string) []provider.Candidate {
	dirs := conventionalLogins(home, defaultDir)

	// Each probe is a short-lived claude; run them side by side.
	results := make([]authProbeResult, len(dirs))
	done := make(chan struct{}, len(dirs))
	for i, dir := range dirs {
		go func() {
			results[i] = authStatusProbe(ctx, dir)
			done <- struct{}{}
		}()
	}
	for range dirs {
		<-done
	}

	var out []provider.Candidate
	for i, dir := range dirs {
		if results[i].verdict != authProbeSignedIn {
			continue
		}
		out = append(out, provider.Candidate{
			Key:         TypeName + ":" + dir,
			Type:        TypeName,
			DisplayName: provider.AccountName(Info().DisplayName, provider.FolderSuffix(dir, loginPrefixes...)),
			Reason:      provider.CandidateFound,
			Path:        provider.HomeRelative(dir, home),
			Label:       results[i].email,
			Settings:    map[string]any{configDirSetting: dir},
		})
	}
	return out
}
