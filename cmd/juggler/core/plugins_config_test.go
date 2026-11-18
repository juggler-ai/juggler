//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// writePluginsConfig plants a .juggler/config.json holding just the plugin lists.
func writePluginsConfig(t *testing.T, dir string, plugins map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".juggler"), 0o755); err != nil {
		t.Fatalf("mkdir .juggler: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"plugins": plugins})
	if err := os.WriteFile(filepath.Join(dir, ".juggler", "config.json"), raw, 0o644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
}

// defaultOff stands in for the build's default-off plugins for one test, so
// the mechanism is tested whether or not any extension ships off.
func defaultOff(t *testing.T, ids ...string) {
	t.Helper()
	saved := defaultDisabledPlugins
	defaultDisabledPlugins = ids
	t.Cleanup(func() { defaultDisabledPlugins = saved })
}

// TestLoadConfigLeavesTheUsersDisabledListAlone: loading is a read. The
// code-level default set used to be appended into the loaded config, so every
// read mutated the user's data and the default could never be removed — it came
// back on the next load. Defaults now resolve on top of the file instead.
func TestLoadConfigLeavesTheUsersDisabledListAlone(t *testing.T) {
	dir := t.TempDir()
	defaultOff(t, "@juggler/off")
	writePluginsConfig(t, dir, map[string]any{"disabled": []string{"memory"}})

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !slices.Equal(cfg.Plugins.Disabled, []string{"memory"}) {
		t.Errorf("LoadConfig edited the user's disabled list: %v", cfg.Plugins.Disabled)
	}
	if !slices.Contains(cfg.ResolvedDisabledPlugins(), "@juggler/off") {
		t.Errorf("the default-off plugin is not resolved off: %v", cfg.ResolvedDisabledPlugins())
	}
	if !slices.Contains(cfg.ResolvedDisabledPlugins(), "memory") {
		t.Errorf("the user's own entry was lost: %v", cfg.ResolvedDisabledPlugins())
	}
}

// TestResolvedDisabledPluginsAppliesTheCountermand: `enabled` overrides both the
// code default and an explicit user entry, and the resolved set never repeats an
// id however many times the two lists mention it.
func TestResolvedDisabledPluginsAppliesTheCountermand(t *testing.T) {
	dir := t.TempDir()
	defaultOff(t, "@juggler/off", "@juggler/also-off")
	writePluginsConfig(t, dir, map[string]any{
		"disabled": []string{"@juggler/off", "memory", "memory"},
		"enabled":  []string{"@juggler/off"},
	})

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	got := cfg.ResolvedDisabledPlugins()
	want := []string{"@juggler/also-off", "memory"}
	if !slices.Equal(got, want) {
		t.Errorf("resolved = %v, want exactly %v", got, want)
	}
}

// TestSetResolvedDisabledPluginsKeepsEachIdInOneList pins the split between
// the two lists. `enabled` exists only to countermand a default-off plugin, so
// switching such a plugin on must MOVE its id, never leave it in both lists at
// once — the same id under both used to be how "switched on" was stored, which
// is unreadable by hand.
func TestSetResolvedDisabledPluginsKeepsEachIdInOneList(t *testing.T) {
	defaultOff(t, "@juggler/off")
	var cfg Config

	// The user switches the default-off extension ON and one capability inside
	// it OFF: the resolved set is exactly {off-tool}.
	cfg.SetResolvedDisabledPlugins([]string{"off-tool"})
	if slices.Contains(cfg.Plugins.Disabled, "@juggler/off") {
		t.Errorf("a switched-on plugin is still listed disabled: %+v", cfg.Plugins)
	}
	if !slices.Equal(cfg.Plugins.Enabled, []string{"@juggler/off"}) {
		t.Errorf("the countermand for a default-off plugin was not recorded: %+v", cfg.Plugins)
	}
	if got := cfg.ResolvedDisabledPlugins(); !slices.Equal(got, []string{"off-tool"}) {
		t.Errorf("resolved disabled = %v, want [off-tool]", got)
	}
}

// TestSetResolvedDisabledPluginsWritesNoDefaults: a default-off plugin left
// alone is reported off without the user's file mentioning it. The default
// belongs to the code, so it must not be written into the user's data.
func TestSetResolvedDisabledPluginsWritesNoDefaults(t *testing.T) {
	defaultOff(t, "@juggler/off")
	var cfg Config
	if got := cfg.ResolvedDisabledPlugins(); !slices.Equal(got, []string{"@juggler/off"}) {
		t.Errorf("a default-off plugin is not reported off: %v", got)
	}

	// The catalog sends every default-off plugin still off plus the user's own.
	cfg.SetResolvedDisabledPlugins([]string{"@juggler/off", "memory"})
	if !slices.Equal(cfg.Plugins.Disabled, []string{"memory"}) || len(cfg.Plugins.Enabled) != 0 {
		t.Errorf("only the user's own entry should be recorded: %+v", cfg.Plugins)
	}
	if got := cfg.ResolvedDisabledPlugins(); !slices.Equal(got, []string{"@juggler/off", "memory"}) {
		t.Errorf("resolved disabled = %v, want [@juggler/off memory]", got)
	}
}
