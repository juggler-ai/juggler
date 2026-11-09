//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package instructionfiles names the user's global agent instruction files —
// the AGENTS.md a user keeps for every project — and is the one place that
// decides where they live.
//
// Two folders hold them, widest first:
//
//	<ConfigDir>/            Juggler's own (~/.juggler on macOS/Windows)
//	~/.agents/              the cross-agent folder, as for skills
//
// JUGGLER_SKILLS_USER_DIR relocates both beneath one base (<base>/juggler and
// <base>/agents), exactly as it relocates the user skill roots that sit inside
// these same folders. Test servers set it so a developer's own global files
// never reach a test conversation.
//
// It lives in internal/ so the read scope (ops) and the config endpoint can
// share it without an import cycle.
package instructionfiles

import (
	"os"
	"path/filepath"

	"juggler/internal/userpaths"
)

// Names is every file name that holds agent instructions, in the order they are
// read within one folder: each .local file — personal, and usually gitignored —
// straight after its shared twin. It must match INSTRUCTION_FILE_NAMES in
// web/js/services/instruction-files.js, which probes the same names in a
// project (TestNamesMatchFrontend).
var Names = []string{
	"AGENTS.md",
	"AGENTS.local.md",
	"CLAUDE.md",
	"CLAUDE.local.md",
	".claude.md",
	".cursorrules",
	".instructions",
}

// Dirs returns the folders that hold the user's global instruction files,
// widest first. A folder that does not exist is harmless — nothing is found
// there.
func Dirs() []string {
	if base := os.Getenv("JUGGLER_SKILLS_USER_DIR"); base != "" {
		return []string{filepath.Join(base, "juggler"), filepath.Join(base, "agents")}
	}
	dirs := []string{userpaths.ConfigDir()}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		dirs = append(dirs, filepath.Join(home, ".agents"))
	}
	return dirs
}

// IsGlobalFile reports whether absPath names one of the global instruction
// files exactly: one of Names, directly inside one of Dirs. Nothing else in
// those folders qualifies — <ConfigDir> also holds credentials.
func IsGlobalFile(absPath string) bool {
	if !filepath.IsAbs(absPath) {
		return false
	}
	clean := filepath.Clean(absPath)
	dir, name := filepath.Dir(clean), filepath.Base(clean)
	nameOK := false
	for _, n := range Names {
		if n == name {
			nameOK = true
			break
		}
	}
	if !nameOK {
		return false
	}
	for _, d := range Dirs() {
		if filepath.Clean(d) == dir {
			return true
		}
	}
	return false
}
