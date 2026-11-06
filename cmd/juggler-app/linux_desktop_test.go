//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"juggler/internal/srcroot"
)

// TestLinuxDesktopNamesAgree: a shell gives a Linux window its icon only
// through a .desktop entry it can match the window to, by the application id
// or by the program name against StartupWMClass. The app sets those names
// here, install.sh writes the entry and the Makefile names the icons, so a
// rename in any one of them leaves every window with the generic icon, which
// nothing else would notice.
func TestLinuxDesktopNamesAgree(t *testing.T) {
	root, err := srcroot.Find("")
	if err != nil {
		t.Fatalf("source root: %v", err)
	}
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatalf("%v", err)
		}
		return string(b)
	}
	assignment := func(file, text, name string) string {
		m := regexp.MustCompile(`(?m)^` + name + `=(\S+)$`).FindStringSubmatch(text)
		if m == nil {
			t.Fatalf("%s assigns no %s", file, name)
		}
		return m[1]
	}

	installSh := read("packaging/linux/install.sh")
	makefile := read("Makefile")
	for _, c := range []struct{ file, name, got, want string }{
		{"packaging/linux/install.sh", "APP_ID", assignment("install.sh", installSh, "APP_ID"), linuxApplicationID},
		{"packaging/linux/install.sh", "WM_CLASS", assignment("install.sh", installSh, "WM_CLASS"), linuxProgramName},
		{"Makefile", "LINUX_APP_ID", assignment("Makefile", makefile, "LINUX_APP_ID"), linuxApplicationID},
	} {
		if c.got != c.want {
			t.Errorf("%s sets %s=%s, but juggler-app's Linux options say %q", c.file, c.name, c.got, c.want)
		}
	}
}
