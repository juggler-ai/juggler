//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package userpaths

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// withHome isolates HOME and clears any ambient JUGGLER_CONFIG_DIR / XDG_* via
// the shared helper so the resolved paths are deterministic per test.
func withHome(t *testing.T) string {
	t.Helper()
	return userpathstest.Isolate(t)
}

// noenv is an env lookup that reports every variable as unset.
func noenv(string) string { return "" }

// env builds an env lookup from a map.
func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func TestResolveConfigDirPerPlatform(t *testing.T) {
	const home = "/home/u"
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv, filepath.Join(home, ".juggler")},
		{"windows", "windows", home, noenv, filepath.Join(home, ".juggler")},
		{"linux default (XDG config)", "linux", home, noenv,
			filepath.Join(home, ".config", "juggler")},
		{"linux honours XDG_CONFIG_HOME", "linux", home,
			env(map[string]string{"XDG_CONFIG_HOME": "/xdg/config"}),
			filepath.Join("/xdg/config", "juggler")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveConfigDir(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveConfigDir(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

func TestResolveCacheDirPerPlatform(t *testing.T) {
	const home = "/home/u"
	cases := []struct {
		name   string
		goos   string
		home   string
		getenv func(string) string
		want   string
	}{
		{"macOS", "darwin", home, noenv, filepath.Join(home, ".juggler", "cache")},
		{"windows", "windows", home, noenv, filepath.Join(home, ".juggler", "cache")},
		{"linux default (XDG cache)", "linux", home, noenv,
			filepath.Join(home, ".cache", "juggler")},
		{"linux honours XDG_CACHE_HOME", "linux", home,
			env(map[string]string{"XDG_CACHE_HOME": "/xdg/cache"}),
			filepath.Join("/xdg/cache", "juggler")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveCacheDir(c.goos, c.home, c.getenv); got != c.want {
				t.Errorf("resolveCacheDir(%q) = %q, want %q", c.goos, got, c.want)
			}
		})
	}
}

// On Linux the default cache dir is a SIBLING of the config dir (separate XDG
// roots), not nested inside it as on macOS/Windows.
func TestLinuxCacheIsSiblingOfConfig(t *testing.T) {
	const home = "/home/u"
	cfg := resolveConfigDir("linux", home, noenv)
	cache := resolveCacheDir("linux", home, noenv)
	if strings.HasPrefix(cache, cfg+string(os.PathSeparator)) {
		t.Errorf("linux CacheDir %q must not be nested under ConfigDir %q", cache, cfg)
	}
}

// With no home and no env, both still yield a path (the temp-dir fallback) so
// callers always have somewhere to write, and cache stays under config.
func TestResolveFallsBackWhenHomeless(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		cfg := resolveConfigDir(goos, "", noenv)
		cache := resolveCacheDir(goos, "", noenv)
		if cfg == "" || cache == "" {
			t.Fatalf("%s: homeless resolve returned empty (cfg=%q cache=%q)", goos, cfg, cache)
		}
		if !strings.HasPrefix(cache, cfg) {
			t.Errorf("%s: homeless CacheDir %q not under ConfigDir %q", goos, cache, cfg)
		}
	}
}

func TestConfigDirStable(t *testing.T) {
	withHome(t)
	if a, b := ConfigDir(), ConfigDir(); a != b {
		t.Errorf("ConfigDir() not stable: %q != %q", a, b)
	}
}

// JUGGLER_CONFIG_DIR overrides the home-derived path outright on every platform,
// and CacheDir stays nested beneath it so one override isolates cache too. This
// is how CI and tests isolate per-user state on a shared/persistent machine.
func TestConfigDirEnvOverride(t *testing.T) {
	withHome(t)
	override := filepath.Join(t.TempDir(), "isolated-config")
	t.Setenv("JUGGLER_CONFIG_DIR", override)
	if got := ConfigDir(); got != override {
		t.Fatalf("ConfigDir() = %q, want override %q", got, override)
	}
	if got, want := CacheDir(), filepath.Join(override, "cache"); got != want {
		t.Errorf("CacheDir() = %q, want %q", got, want)
	}
}

// An empty JUGGLER_CONFIG_DIR is ignored, falling back to the platform-derived
// path (so `export JUGGLER_CONFIG_DIR=` doesn't redirect state to a bare path).
func TestConfigDirEnvOverrideEmptyIgnored(t *testing.T) {
	home := withHome(t)
	t.Setenv("JUGGLER_CONFIG_DIR", "")
	want := resolveConfigDir(runtime.GOOS, home, os.Getenv)
	if got := ConfigDir(); got != want {
		t.Fatalf("empty override not ignored: ConfigDir() = %q, want %q", got, want)
	}
}

// ConfigDir/CacheDir resolve under the isolated HOME on the host platform.
func TestConfigAndCacheUnderHome(t *testing.T) {
	home := withHome(t)
	if cfg := ConfigDir(); !strings.HasPrefix(cfg, home) {
		t.Errorf("ConfigDir() %q not under isolated HOME %q", cfg, home)
	}
	if cache := CacheDir(); !strings.HasPrefix(cache, home) {
		t.Errorf("CacheDir() %q not under isolated HOME %q", cache, home)
	}
}
