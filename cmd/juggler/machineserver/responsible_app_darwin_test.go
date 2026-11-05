//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBundleOfPath: the bundle a main executable is the main executable of is
// the innermost .app it is in — JugglerServer.app, launched as an app of its
// own, not the Juggler.app that holds it — and only when it sits where a
// bundle's executable does.
func TestBundleOfPath(t *testing.T) {
	for _, c := range []struct{ path, want string }{
		{"/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "/System/Applications/Utilities/Terminal.app"},
		{"/Applications/Juggler.app/Contents/Helpers/JugglerServer.app/Contents/MacOS/juggler", "/Applications/Juggler.app/Contents/Helpers/JugglerServer.app"},
		{"/Applications/Juggler.app/Contents/MacOS/juggler-app", "/Applications/Juggler.app"},
		{"/bin/zsh", ""},
		{"/Users/me/.app/Contents/MacOS/tool", ""},
		{"/Applications/Tool.app/Contents/Resources/bin/tool", ""},
	} {
		if got := bundleOf(c.path); got != c.want {
			t.Errorf("bundleOf(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// TestBundleName: an app is named as System Settings lists it — its display
// name, else its name, else its bundle's file name.
func TestBundleName(t *testing.T) {
	dir := t.TempDir()
	bundle := func(file, info string) string {
		t.Helper()
		path := filepath.Join(dir, file)
		if err := os.MkdirAll(filepath.Join(path, "Contents", "MacOS"), 0o755); err != nil {
			t.Fatal(err)
		}
		if info != "" {
			plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>` + info + `</dict></plist>`
			if err := os.WriteFile(filepath.Join(path, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return path
	}
	for _, c := range []struct{ path, want string }{
		{bundle("JugglerServer.app", `<key>CFBundleName</key><string>Server</string><key>CFBundleDisplayName</key><string>Juggler Server</string>`), "Juggler Server"},
		{bundle("Named.app", `<key>CFBundleName</key><string>Named Tool</string>`), "Named Tool"},
		{bundle("Plain.app", ""), "Plain"},
	} {
		if got := bundleName(c.path); got != c.want {
			t.Errorf("bundleName(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// TestResponsibleExecutable: macOS names the executable it holds responsible
// for this process — some ancestor's, or its own.
func TestResponsibleExecutable(t *testing.T) {
	got := responsibleExecutable()
	if got == "" || !filepath.IsAbs(got) {
		t.Errorf("responsibleExecutable() = %q, want an absolute path", got)
	}
	t.Logf("responsible for this test: %s, named %q", got, responsibleAppName())
}
