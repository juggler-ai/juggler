//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/tests/helpers"
)

func TestConfig_Default(t *testing.T) {
	cfg := core.DefaultConfig()

	helpers.AssertEqual(t, cfg.Server.Port, 3939)
	helpers.AssertEqual(t, cfg.Server.Host, "localhost")
	helpers.AssertEqual(t, cfg.Context.TokenBudget, 0) // 0 = auto-calculate
	helpers.AssertTrue(t, len(cfg.Project.Exclude) > 0, "should have default excludes")
	// Which plugins ship off is a property of the build, not of a project's
	// config: a fresh config records no switches of its own, and the default is
	// applied when the set is resolved.
	helpers.AssertTrue(t, len(cfg.Plugins.Disabled) == 0 && len(cfg.Plugins.Enabled) == 0,
		"a default config should record no plugin switches of its own")
	resolved := cfg.ResolvedDisabledPlugins()
	helpers.AssertTrue(t, len(resolved) == 1 && resolved[0] == "@juggler/exa",
		"only Exa should be disabled by default")
}

func TestConfig_LoadNonExistent(t *testing.T) {
	project := helpers.EmptyProject(t)
	defer project.Cleanup()

	cfg, err := core.LoadConfig(project.Path)
	helpers.AssertNoError(t, err)

	// Should return defaults
	helpers.AssertEqual(t, cfg.Server.Port, 3939)
}

func TestConfig_SaveAndLoad(t *testing.T) {
	project := helpers.EmptyProject(t)
	defer project.Cleanup()

	// Create custom config
	cfg := core.DefaultConfig()
	cfg.Model = "anthropic/claude-3-5-sonnet-20241022"
	cfg.Server.Port = 4000
	cfg.Context.TokenBudget = 10000

	// Save
	err := cfg.Save(project.Path)
	helpers.AssertNoError(t, err)

	// Load
	loaded, err := core.LoadConfig(project.Path)
	helpers.AssertNoError(t, err)

	helpers.AssertEqual(t, loaded.Model, "anthropic/claude-3-5-sonnet-20241022")
	helpers.AssertEqual(t, loaded.Server.Port, 4000)
	helpers.AssertEqual(t, loaded.Context.TokenBudget, 10000)
}

func TestConfig_GetModel(t *testing.T) {
	cfg := core.DefaultConfig()
	cfg.Model = "gemini/gemini-2.0-flash-exp"

	helpers.AssertEqual(t, cfg.GetModel(), "gemini/gemini-2.0-flash-exp")
}
