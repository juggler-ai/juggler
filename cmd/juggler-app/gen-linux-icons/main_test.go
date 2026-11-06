//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"juggler/internal/srcroot"
)

// These tests are the Linux packaging's only run before a release: CI packages
// a tarball on a release commit alone, so the icon tree and the install.sh
// beside it are exercised here, against the real icon and the real script.

func sourceRoot(t *testing.T) string {
	t.Helper()
	root, err := srcroot.Find("")
	if err != nil {
		t.Fatalf("source root: %v", err)
	}
	return root
}

// appID is the icon and .desktop name install.sh installs under.
func appID(t *testing.T, root string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "packaging/linux/install.sh"))
	if err != nil {
		t.Fatalf("%v", err)
	}
	m := regexp.MustCompile(`(?m)^APP_ID=(\S+)$`).FindSubmatch(b)
	if m == nil {
		t.Fatalf("install.sh assigns no APP_ID")
	}
	return string(m[1])
}

func iconPath(dir, name string, size int) string {
	return filepath.Join(dir, "hicolor", fmt.Sprintf("%dx%d", size, size), "apps", name+".png")
}

func TestRendersEveryHicolorSizeFromTheAppIcon(t *testing.T) {
	root := sourceRoot(t)
	out := t.TempDir()
	if err := run(filepath.Join(root, "assets/icons/juggler-icon.png"), out, "test.icon"); err != nil {
		t.Fatalf("run: %v", err)
	}
	for _, n := range sizes {
		path := iconPath(out, "test.icon", n)
		f, err := os.Open(path)
		if err != nil {
			t.Errorf("%dpx: %v", n, err)
			continue
		}
		img, err := png.Decode(f)
		_ = f.Close()
		if err != nil {
			t.Errorf("%dpx: not a PNG: %v", n, err)
			continue
		}
		if b := img.Bounds(); b.Dx() != n || b.Dy() != n {
			t.Errorf("%dpx icon is %dx%d", n, b.Dx(), b.Dy())
		}
		// The icon is opaque at its centre; a scaler that drew nothing leaves
		// it transparent there.
		if _, _, _, a := img.At(n/2, n/2).RGBA(); a == 0 {
			t.Errorf("%dpx icon is transparent at its centre: nothing was drawn", n)
		}
	}
}

func TestRefusesASourceItCannotRenderEverySizeFrom(t *testing.T) {
	for _, c := range []struct {
		name string
		w, h int
	}{
		{"not square", 600, 512},
		{"smaller than the largest size", 256, 256},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			src := filepath.Join(dir, "src.png")
			var buf bytes.Buffer
			if err := png.Encode(&buf, image.NewNRGBA(image.Rect(0, 0, c.w, c.h))); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			out := filepath.Join(dir, "out")
			if err := run(src, out, "x"); err == nil {
				t.Errorf("a %dx%d source was accepted", c.w, c.h)
			}
			if _, err := os.Stat(out); !os.IsNotExist(err) {
				t.Errorf("a refused source still wrote %s", out)
			}
		})
	}
}

// TestInstallScriptRegistersTheAppAndUninstallRemovesIt runs install.sh from a
// directory laid out as the tarball unpacks, under a name holding every
// character the entry's Exec= has to escape, and reads back what a desktop
// would: the command it launches, and the icons it draws.
func TestInstallScriptRegistersTheAppAndUninstallRemovesIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("install.sh is a POSIX shell script for Linux desktops")
	}
	root := sourceRoot(t)
	id := appID(t, root)

	tmp := t.TempDir()
	unpacked := filepath.Join(tmp, "Juggler \"dir\" `x` $HOME 100% back\\slash")
	if err := os.MkdirAll(unpacked, 0o755); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(unpacked, "juggler-app")
	if err := os.WriteFile(app, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(filepath.Join(root, "packaging/linux/install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unpacked, "install.sh"), script, 0o755); err != nil {
		t.Fatal(err)
	}
	icons := filepath.Join(unpacked, "icons")
	if err := run(filepath.Join(root, "assets/icons/juggler-icon.png"), icons, id); err != nil {
		t.Fatalf("rendering the icons: %v", err)
	}

	data := filepath.Join(tmp, "data")
	installSh := func(args ...string) {
		t.Helper()
		cmd := exec.Command("sh", append([]string{filepath.Join(unpacked, "install.sh")}, args...)...)
		cmd.Env = append(os.Environ(), "HOME="+tmp, "XDG_DATA_HOME="+data)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("install.sh %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}

	installSh()

	entryPath := filepath.Join(data, "applications", id+".desktop")
	entry := readDesktopEntry(t, entryPath)
	for key, want := range map[string]string{
		"Type":           "Application",
		"Name":           "Juggler",
		"Icon":           id,
		"StartupWMClass": "Juggler",
		"Terminal":       "false",
	} {
		if got := entry[key]; got != want {
			t.Errorf("%s=%q, want %q", key, got, want)
		}
	}
	if got := unescapeDesktopString(entry["TryExec"]); got != app {
		t.Errorf("TryExec names %q, want %q", got, app)
	}
	if argv, err := parseDesktopExec(entry["Exec"]); err != nil {
		t.Errorf("Exec=%s: %v", entry["Exec"], err)
	} else if len(argv) != 1 || argv[0] != app {
		t.Errorf("Exec=%s launches %q, want [%q]", entry["Exec"], argv, app)
	}
	if validate, err := exec.LookPath("desktop-file-validate"); err == nil {
		if out, err := exec.Command(validate, entryPath).CombinedOutput(); err != nil {
			t.Errorf("desktop-file-validate: %v\n%s", err, out)
		}
	}

	themeIcons := filepath.Join(data, "icons")
	for _, n := range sizes {
		want, err := os.ReadFile(iconPath(icons, id, n))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(iconPath(themeIcons, id, n))
		if err != nil {
			t.Errorf("%dpx icon not installed: %v", n, err)
		} else if !bytes.Equal(got, want) {
			t.Errorf("%dpx icon installed differs from the one shipped", n)
		}
	}

	installSh("--uninstall")

	if _, err := os.Stat(entryPath); !os.IsNotExist(err) {
		t.Errorf("--uninstall left %s", entryPath)
	}
	for _, n := range sizes {
		if path := iconPath(themeIcons, id, n); fileExists(path) {
			t.Errorf("--uninstall left %s", path)
		}
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readDesktopEntry reads the [Desktop Entry] group's keys, raw.
func readDesktopEntry(t *testing.T, path string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no desktop entry: %v", err)
	}
	lines := strings.Split(string(b), "\n")
	if len(lines) == 0 || lines[0] != "[Desktop Entry]" {
		t.Fatalf("%s does not open with [Desktop Entry]:\n%s", path, b)
	}
	entry := map[string]string{}
	for _, line := range lines[1:] {
		if strings.HasPrefix(line, "[") {
			break
		}
		if key, value, ok := strings.Cut(line, "="); ok {
			entry[key] = value
		}
	}
	return entry
}

// unescapeDesktopString undoes a desktop entry's string-value escapes.
func unescapeDesktopString(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] != '\\' || i+1 == len(v) {
			b.WriteByte(v[i])
			continue
		}
		i++
		switch v[i] {
		case 's':
			b.WriteByte(' ')
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		default:
			b.WriteByte(v[i])
		}
	}
	return b.String()
}

// parseDesktopExec splits an Exec= value into the argv a desktop launches, as
// the Desktop Entry Specification reads it: the string escapes first, then
// the quoting, in which ", `, $ and \ are taken literally after a backslash,
// then the field codes, where %% is a literal %. Any other field code is an
// error, since the entry is not meant to pass one.
func parseDesktopExec(v string) ([]string, error) {
	s := unescapeDesktopString(v)
	var argv []string
	var arg strings.Builder
	inArg, quoted := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quoted && c == '\\' && i+1 < len(s) && strings.IndexByte("\"`$\\", s[i+1]) >= 0:
			i++
			arg.WriteByte(s[i])
		case quoted && c == '"':
			quoted = false
		case !quoted && c == '"':
			quoted, inArg = true, true
		case !quoted && c == ' ':
			if inArg {
				argv = append(argv, arg.String())
				arg.Reset()
				inArg = false
			}
		default:
			arg.WriteByte(c)
			inArg = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("unterminated quote")
	}
	if inArg {
		argv = append(argv, arg.String())
	}
	for i, a := range argv {
		var b strings.Builder
		for j := 0; j < len(a); j++ {
			if a[j] != '%' {
				b.WriteByte(a[j])
				continue
			}
			if j+1 < len(a) && a[j+1] == '%' {
				b.WriteByte('%')
				j++
				continue
			}
			return nil, fmt.Errorf("argument %q holds a field code", a)
		}
		argv[i] = b.String()
	}
	return argv, nil
}
