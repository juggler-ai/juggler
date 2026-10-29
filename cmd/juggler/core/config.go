//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"juggler/internal/atomicio"
)

// Config represents the application configuration
type Config struct {
	// Model identifies both provider and model (e.g., "anthropic/claude-3-5-sonnet-20241022")
	// Format: "provider/model-name" or just "model-name" for default provider
	Model string `json:"model,omitempty"`

	// Verbose enables debug-level console logging (same as -v / --verbose).
	Verbose bool `json:"verbose,omitempty"`

	// AssetsFromDisk loads web assets from web/ on disk instead of the embedded
	// FS, disables caching, and reloads templates per request (same as
	// --assets-from-disk).
	AssetsFromDisk bool `json:"assetsFromDisk,omitempty"`

	// Server settings
	Server ServerConfig `json:"server"`

	// Context settings
	Context ContextConfig `json:"context"`

	// Project settings
	Project ProjectConfig `json:"project"`

	// Plugins settings
	Plugins PluginsConfig `json:"plugins"`

	// Logging settings
	Logging LoggingConfig `json:"logging,omitempty"`
}

// ServerConfig contains HTTP server configuration
type ServerConfig struct {
	Port int    `json:"port"`
	Host string `json:"host"`
}

// ContextConfig contains context management settings
type ContextConfig struct {
	TokenBudget int `json:"token_budget"` // Maximum tokens in working set (0 = auto-calculate)
}

// ProjectConfig contains project-specific settings
type ProjectConfig struct {
	Exclude     []string `json:"exclude"`       // Patterns to exclude
	MaxFileSize int64    `json:"max_file_size"` // Maximum file size to process
}

// LoggingConfig tunes log retention and the on/off switch. The log file path is
// derived centrally from the project by internal/logpaths (the
// platform-conventional log dir), so one process always maps to one well-known
// file; it is not configurable here.
type LoggingConfig struct {
	// MaxSizeMB caps each log file before it rotates to "<path>.1". Default 10.
	MaxSizeMB int `json:"max_size_mb,omitempty"`
	// MaxBackups is how many rotated "<path>.N" files to keep. Default 5.
	MaxBackups int `json:"max_backups,omitempty"`
	// MaxAgeDays deletes whole log files (and their rotation backups) not
	// modified in this many days, swept from the log directory at startup so a
	// dead project's logs — or a pile of old test runs — don't accumulate
	// forever. Active logs keep a current mtime and survive. Default 14; a
	// negative value disables the age sweep.
	MaxAgeDays int `json:"max_age_days,omitempty"`
	// Disabled turns off on-disk logging entirely (console only).
	Disabled bool `json:"disabled,omitempty"`
}

// PluginsConfig records what this project switched off, and what it switched on
// that the build ships off. An id belongs to exactly one of the two lists; read
// them through Config.ResolvedDisabledPlugins rather than directly, which is
// what applies the build's defaults on top.
type PluginsConfig struct {
	// Disabled lists capability and extension ids this project switched off
	// (e.g. ["exa-search", "@juggler/mcp"]). Both kinds share one flat list.
	Disabled []string `json:"disabled,omitempty"`

	// Enabled countermands DefaultDisabledPlugins: it lists the ids this project
	// switched ON that would otherwise be off. Nothing else belongs here — an id
	// that is simply on is absent from both lists.
	Enabled []string `json:"enabled,omitempty"`

	// Attribution remembers what each switched-off id was, keyed by id. A hint,
	// never authority: the lists above decide what is off, and this only decides
	// how it is described. Kept only for ids currently switched off.
	Attribution map[string]PluginAttribution `json:"attribution,omitempty"`
}

// PluginAttribution describes a capability well enough to show a row for it
// after the module that defines it has stopped loading.
//
// A capability's id lives inside its JS module, so once that module no longer
// loads — its extension removed, its file renamed, a fault introduced — nothing
// in the running app can say what a leftover id in the disabled list WAS. The
// UI records this at the moment it switches something off, which is exactly when
// it still knows.
//
// File is the module's base name rather than its served URL on purpose: a user
// extension's URL carries an epoch segment that changes whenever extensions are
// rescanned, so a stored URL would stop matching. Within one extension and one
// capability type the base name is unique, which is all the matching needs.
type PluginAttribution struct {
	// Extension is the id of the extension that provided the capability.
	Extension string `json:"extension,omitempty"`
	// File is the base name of the capability's module file.
	File string `json:"file,omitempty"`
	// Type is the capability type ("context-item", "strategy", …).
	Type string `json:"type,omitempty"`
	// Name is the human label the capability's manifest carried.
	Name string `json:"name,omitempty"`
}

// DefaultConfig returns default configuration
func DefaultConfig() *Config {
	return &Config{
		Server: ServerConfig{
			Port: 3939,
			Host: "localhost",
		},
		Context: ContextConfig{
			TokenBudget: 0, // 0 = auto-calculate based on provider
		},
		Project: ProjectConfig{
			Exclude: []string{
				".*",
				"__pycache__",
				"*.pyc",
				"node_modules",
				"dist",
				"build",
				".git",
				".juggler",
			},
			MaxFileSize: 1048576, // 1MB
		},
		// Empty on purpose: which plugins ship switched off is
		// defaultDisabledPlugins, resolved on top of a project's own lists.
		Plugins: PluginsConfig{},
		Logging: LoggingConfig{
			// On-disk logging is on by default so post-mortem diagnostics
			// (watchdog force-exits, shutdown-path traces) survive after the
			// process is gone — console output is lost when launched from the
			// .app bundle. The path is derived centrally (internal/logpaths);
			// set "disabled": true in config.json to turn it off.
			MaxSizeMB:  10,
			MaxBackups: 5,
			MaxAgeDays: 14,
		},
	}
}

// LoadConfig loads configuration from file
func LoadConfig(projectPath string) (*Config, error) {
	configPath := filepath.Join(projectPath, ".juggler", "config.json")

	cfg := DefaultConfig()
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return cfg, nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	// Fill fields left absent by the file with their defaults. The plugin lists
	// are deliberately not among them: they are the user's record of what they
	// switched, and the build's own defaults are applied on top at read time by
	// ResolvedDisabledPlugins rather than written in here.
	defaults := DefaultConfig()
	if cfg.Server.Port == 0 {
		cfg.Server.Port = defaults.Server.Port
	}
	if cfg.Server.Host == "" {
		cfg.Server.Host = defaults.Server.Host
	}
	// Don't set token budget to default here - let it be 0 for auto-calculation
	if len(cfg.Project.Exclude) == 0 {
		cfg.Project.Exclude = defaults.Project.Exclude
	}
	if cfg.Project.MaxFileSize == 0 {
		cfg.Project.MaxFileSize = defaults.Project.MaxFileSize
	}
	if cfg.Logging.MaxSizeMB == 0 {
		cfg.Logging.MaxSizeMB = defaults.Logging.MaxSizeMB
	}
	if cfg.Logging.MaxBackups == 0 {
		cfg.Logging.MaxBackups = defaults.Logging.MaxBackups
	}
	if cfg.Logging.MaxAgeDays == 0 {
		cfg.Logging.MaxAgeDays = defaults.Logging.MaxAgeDays
	}

	return cfg, nil
}

// Save saves configuration to file
func (c *Config) Save(projectPath string) error {
	configPath := filepath.Join(projectPath, ".juggler", "config.json")

	jugglerDir := filepath.Dir(configPath)
	if err := os.MkdirAll(jugglerDir, 0755); err != nil {
		return fmt.Errorf("failed to create .juggler directory: %w", err)
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}
	if err := atomicio.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// GetModel returns the configured model string
// Format: "provider/model-name" (e.g., "anthropic/claude-3-5-sonnet-20241022")
func (c *Config) GetModel() string {
	return c.Model
}

// IsVerboseEnabled returns whether verbose (debug-level) logging is enabled.
func (c *Config) IsVerboseEnabled() bool {
	return c.Verbose
}

// IsAssetsFromDiskEnabled returns whether web assets should be served from
// disk (live-reload dev mode) instead of the embedded FS.
func (c *Config) IsAssetsFromDiskEnabled() bool {
	return c.AssetsFromDisk
}

// RememberPluginAttribution folds in what the caller has just learned about the
// ids it switched off, then drops every entry that no longer describes a
// switched-off id.
//
// Merging rather than replacing is the point: the caller only knows about
// capabilities that are currently loading, and the entries worth most are for
// the ones that are not. Pruning is the other half — attribution describes the
// disabled list and nothing else, so switching an id back on takes its entry
// with it and the file cannot accumulate a record of every capability ever
// toggled. Call it AFTER SetResolvedDisabledPlugins.
func (c *Config) RememberPluginAttribution(hints map[string]PluginAttribution) {
	merged := make(map[string]PluginAttribution, len(c.Plugins.Attribution)+len(hints))
	for id, entry := range c.Plugins.Attribution {
		merged[id] = entry
	}
	for id, entry := range hints {
		merged[id] = entry
	}

	kept := map[string]PluginAttribution{}
	for _, id := range c.ResolvedDisabledPlugins() {
		if entry, ok := merged[id]; ok {
			kept[id] = entry
		}
	}
	if len(kept) == 0 {
		c.Plugins.Attribution = nil
		return
	}
	c.Plugins.Attribution = kept
}

// GetTokenBudget returns the token budget to use
// If explicitly set in config, returns that value
// Otherwise, returns 0 to signal auto-calculation based on provider
func (c *Config) GetTokenBudget() int {
	return c.Context.TokenBudget
}

// defaultDisabledPlugins are the plugin ids that ship switched off. This is a
// property of the build, not of any project, so it is never written into a
// user's config file — it is applied on top of one by
// ResolvedDisabledPlugins. Switching such a plugin on is recorded as a
// countermand in Plugins.Enabled.
var defaultDisabledPlugins = []string{"@juggler/exa"}

// ResolvedDisabledPlugins is the set of ids actually switched off for this
// project: the build's defaults plus the project's own disabled entries, minus
// anything the project explicitly switched on. Deduplicated, and ordered
// defaults-first then file order, so the answer is stable across loads.
func (c *Config) ResolvedDisabledPlugins() []string {
	enabled := make(map[string]bool, len(c.Plugins.Enabled))
	for _, id := range c.Plugins.Enabled {
		enabled[id] = true
	}
	seen := make(map[string]bool, len(defaultDisabledPlugins)+len(c.Plugins.Disabled))
	resolved := make([]string, 0, len(defaultDisabledPlugins)+len(c.Plugins.Disabled))
	for _, id := range slices.Concat(defaultDisabledPlugins, c.Plugins.Disabled) {
		if enabled[id] || seen[id] {
			continue
		}
		seen[id] = true
		resolved = append(resolved, id)
	}
	return resolved
}

// SetResolvedDisabledPlugins records the set of ids that should be switched off,
// splitting it across the two stored lists so each id lands in exactly one of
// them: entries the build already switches off need no record, and a default the
// caller wants ON becomes a countermand.
func (c *Config) SetResolvedDisabledPlugins(disabled []string) {
	want := make(map[string]bool, len(disabled))
	for _, id := range disabled {
		want[id] = true
	}

	c.Plugins.Disabled = make([]string, 0, len(disabled))
	seen := make(map[string]bool, len(disabled))
	for _, id := range disabled {
		if seen[id] || slices.Contains(defaultDisabledPlugins, id) {
			continue
		}
		seen[id] = true
		c.Plugins.Disabled = append(c.Plugins.Disabled, id)
	}

	c.Plugins.Enabled = make([]string, 0, len(defaultDisabledPlugins))
	for _, id := range defaultDisabledPlugins {
		if !want[id] {
			c.Plugins.Enabled = append(c.Plugins.Enabled, id)
		}
	}
}
