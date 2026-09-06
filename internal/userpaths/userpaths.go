//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package userpaths is the single source of truth for Juggler's per-user
// directories: durable config and the regenerable cache beneath it.
//
// On Linux (and other Unixes) these follow the XDG Base Directory Specification,
// so Juggler keeps its state where well-behaved software is expected to:
//
//	ConfigDir  $XDG_CONFIG_HOME/juggler   (default ~/.config/juggler)
//	CacheDir   $XDG_CACHE_HOME/juggler    (default ~/.cache/juggler)
//
// macOS and Windows keep the historical single-folder layout — durable config in
// ~/.juggler and its regenerable cache in ~/.juggler/cache — since neither
// follows XDG by convention. Logs live in neither tree on any platform: see
// internal/logpaths, which resolves them to the platform-conventional log
// directory (XDG_STATE_HOME on Linux).
//
// JUGGLER_CONFIG_DIR overrides the config location outright on every platform and
// keeps the cache nested beneath it (<dir>/cache), so a single environment
// variable still relocates ALL per-user state to one portable folder — which is
// how CI and tests isolate state per run.
//
// A one-time Migrate moves a pre-XDG ~/.juggler tree into the XDG directories on
// Linux; see Migrate.
package userpaths

import (
	"os"
	"path/filepath"
	"runtime"
)

// ConfigDir returns Juggler's per-user config directory (credentials, default
// model, extensions, sessions, recents metadata).
//
// JUGGLER_CONFIG_DIR overrides it outright when set, relocating every piece of
// per-user state to that directory. CI and tests use this to isolate state per
// run, so concurrent or back-to-back runs on a shared/persistent machine never
// bleed into each other; it also lets a user keep a portable config location.
//
// Otherwise it is the platform-conventional config directory (see the package
// doc), falling back to the OS temp dir when the home directory can't be
// resolved, so a path is always produced.
func ConfigDir() string {
	if dir := os.Getenv("JUGGLER_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return resolveConfigDir(runtime.GOOS, home, os.Getenv)
}

// resolveConfigDir computes the platform-conventional config directory from
// injected inputs (GOOS, home, an env lookup), so every OS branch is unit-
// testable from any host. Returns the OS temp dir as a last resort.
func resolveConfigDir(goos, home string, getenv func(string) string) string {
	switch goos {
	case "darwin", "windows":
		if home != "" {
			return filepath.Join(home, ".juggler")
		}
	default: // Linux and other Unixes — XDG Base Directory spec.
		if xdg := getenv("XDG_CONFIG_HOME"); xdg != "" {
			return filepath.Join(xdg, "juggler")
		}
		if home != "" {
			return filepath.Join(home, ".config", "juggler")
		}
	}
	return filepath.Join(os.TempDir(), "juggler")
}

// CacheDir returns the regenerable cache directory. Files here are safe to
// delete — Juggler rebuilds them on demand. Callers MkdirAll it before writing.
//
// When JUGGLER_CONFIG_DIR is set the cache is nested beneath it (<dir>/cache) so
// one override still isolates cache along with config. Otherwise it is the
// platform-conventional cache directory (see the package doc): a sibling of
// ConfigDir on Linux ($XDG_CACHE_HOME/juggler), nested inside it on
// macOS/Windows (~/.juggler/cache).
func CacheDir() string {
	if dir := os.Getenv("JUGGLER_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "cache")
	}
	home, _ := os.UserHomeDir()
	return resolveCacheDir(runtime.GOOS, home, os.Getenv)
}

// resolveCacheDir computes the platform-conventional cache directory from
// injected inputs, mirroring resolveConfigDir. The homeless fallback nests the
// cache under the config fallback so the two stay related when there is nowhere
// conventional to put them.
func resolveCacheDir(goos, home string, getenv func(string) string) string {
	switch goos {
	case "darwin", "windows":
		if home != "" {
			return filepath.Join(home, ".juggler", "cache")
		}
	default: // Linux and other Unixes — XDG Base Directory spec.
		if xdg := getenv("XDG_CACHE_HOME"); xdg != "" {
			return filepath.Join(xdg, "juggler")
		}
		if home != "" {
			return filepath.Join(home, ".cache", "juggler")
		}
	}
	return filepath.Join(os.TempDir(), "juggler", "cache")
}
