//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ServerBinary is the server binary every spawn site in the integration suites
// runs.
//
// JUGGLER_TEST_SERVER names it outright, for a build system that keeps its
// test-capable server somewhere other than the slot the desktop app occupies —
// pointing the suites at that binary is then a matter of one variable, and
// bin/juggler is left alone.
//
// Otherwise it is <root>/bin plus the platform executable name — "juggler" on
// Unix, "juggler.exe" on Windows. Both halves of the contract need this:
// `go build -o` writes the output name verbatim (it does NOT append .exe on a
// Windows target), and Windows exec.LookPath refuses to run an extension-less
// file. So the spawn sites and the CI build step must all agree on this name,
// or the suites fail at spawn with "executable file not found" on Windows
// (which -short used to hide).
func ServerBinary(root string) string {
	if custom := os.Getenv("JUGGLER_TEST_SERVER"); custom != "" {
		return custom
	}
	name := "juggler"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(root, "bin", name)
}

// EnvWithOverride returns env with every entry for key replaced by one
// key=value, appended last.
func EnvWithOverride(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			out = append(out, entry)
		}
	}
	return append(out, prefix+value)
}

// CopyDir copies the tree at src into dst, keeping each entry's mode.
func CopyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
