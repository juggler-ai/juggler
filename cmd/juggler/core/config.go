//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	// Worktree controls per-instance git worktree isolation. When nil (the
	// default) or true, opening a git repository runs Juggler inside a
	// dedicated linked worktree on its own branch, so parallel instances don't
	// collide in the same working tree. Set false to operate directly in the
	// checkout. Ignored for non-git folders and repositories with no commits.
	Worktree *bool `json:"worktree,omitempty"`
}

// WorktreeEnabled reports whether per-instance git worktree isolation is on.
// It defaults to true, so a config that omits the field opts in.
func (p ProjectConfig) WorktreeEnabled() bool {
	return p.Worktree == nil || *p.Worktree
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

// PluginsConfig contains plugin-related settings
type PluginsConfig struct {
	// Disabled is a list of plugin IDs to disable (e.g., ["web-search", "compact"])
	Disabled []string `json:"disabled,omitempty"`

	// Enabled is a list of plugin IDs to re-enable (overrides global disabled, project-level only)
	Enabled []string `json:"enabled,omitempty"`
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

	// Fill any field left zero by the file with its default.
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
	if err := os.WriteFile(configPath, data, 0644); err != nil {
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

// GetTokenBudget returns the token budget to use
// If explicitly set in config, returns that value
// Otherwise, returns 0 to signal auto-calculation based on provider
func (c *Config) GetTokenBudget() int {
	return c.Context.TokenBudget
}

// GetDisabledPlugins returns the list of disabled plugin IDs
func (c *Config) GetDisabledPlugins() []string {
	if c.Plugins.Disabled == nil {
		return []string{}
	}
	return c.Plugins.Disabled
}

// GetEnabledPlugins returns the list of explicitly enabled plugin IDs
func (c *Config) GetEnabledPlugins() []string {
	if c.Plugins.Enabled == nil {
		return []string{}
	}
	return c.Plugins.Enabled
}

// CalculateTokenBudget calculates the token budget based on a provider's context window
// Returns the explicit TokenBudget if set (user override)
// Otherwise, calculates as 60% of the provider's context window
// The 60% allocation accounts for:
// - System prompts (~5-10%)
// - Tool definitions (~5-10%)
// - Output tokens (~20-25%)
// - Safety margin (~5-10%)
// Returns 0 if no valid context window is available (caller should handle this)
func CalculateTokenBudget(explicitBudget int, contextWindow int) int {
	// If user set an explicit budget, use it
	if explicitBudget > 0 {
		return explicitBudget
	}

	// Calculate as 60% of context window
	if contextWindow > 0 {
		return int(float64(contextWindow) * 0.6)
	}

	// No valid context window - return 0 (caller should handle)
	return 0
}
