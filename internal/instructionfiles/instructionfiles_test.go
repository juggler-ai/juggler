//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package instructionfiles

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"testing"
)

// TestNamesMatchFrontend pins the one list of instruction file names to its
// frontend copy. The server admits global files by these names and the
// frontend probes projects by its own; if they drifted, a name would be found
// in every project and refused globally, or the other way round, with nothing
// to say why.
func TestNamesMatchFrontend(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	src, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "web", "js", "services", "instruction-files.js"))
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)INSTRUCTION_FILE_NAMES = Object\.freeze\(\[(.*?)\]\)`).FindSubmatch(src)
	if block == nil {
		t.Fatal("INSTRUCTION_FILE_NAMES not found in instruction-files.js")
	}
	var frontend []string
	for _, m := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(block[1], -1) {
		frontend = append(frontend, string(m[1]))
	}
	if !slices.Equal(frontend, Names) {
		t.Fatalf("instruction-files.js lists %q, instructionfiles.Names lists %q", frontend, Names)
	}
}
