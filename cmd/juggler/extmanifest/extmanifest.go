//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package extmanifest is the server-independent core of Juggler's extension
// packaging: parsing, validating, and glob-expanding a juggler.extension.json.
// It is shared by the server's extension discovery (cmd/juggler/server/handlers)
// and the `juggler ext validate` CLI, so both judge a manifest identically
// without the CLI having to boot a server.
package extmanifest

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// DefaultEngineAPIVersion is the fallback host SDK version used when it cannot be
// read from web/sdk/version.js. Keep in lockstep with ENGINE_API_VERSION there.
const DefaultEngineAPIVersion = "1.0.0"

// ManifestFileName is the well-known manifest filename at an extension root.
const ManifestFileName = "juggler.extension.json"

// Provides declares the capability globs an extension contributes, by plugin
// type. Globs are relative to the extension root.
type Provides struct {
	ContextItems []string `json:"contextItems,omitempty"`
	Strategies   []string `json:"strategies,omitempty"`
	Commands     []string `json:"commands,omitempty"`
	InfoCards    []string `json:"infoCards,omitempty"`
	FileViewers  []string `json:"fileViewers,omitempty"`
	// PinboardItems declares the pinboard item types the extension contributes —
	// the kinds of panel a user can pin to the board. Like info cards these are
	// viewer-only capabilities: they render DOM and are never loaded in the engine
	// worker.
	PinboardItems []string `json:"pinboardItems,omitempty"`
	// PinboardItemMeta declares the agent-facing descriptors for those pinboard
	// item types — one side-effect-free module per type, whose default export tells
	// the model the type exists, what it shows, and what parameters it takes. Unlike
	// the item types themselves these ARE loaded in the engine worker, where the
	// pin tool runs, which is why they are declared separately: a pin module renders
	// DOM at import and cannot go there. A type with no descriptor is still pinnable
	// by name but is invisible to the model. Not a capability on its own — a
	// descriptor describes an item type, so it never satisfies the "provides
	// something" check by itself.
	PinboardItemMeta []string `json:"pinboardItemMeta,omitempty"`
	// WorkspaceProviders declares the workspace providers the extension
	// contributes — what can create and look after a place a conversation works
	// in: a git worktree, a throwaway copy of the tree, a directory on another
	// machine. Viewer-only, like pinboard items: the lifecycle is user-driven,
	// and the engine resolves a workspace from the session's own row without
	// asking whoever made it.
	WorkspaceProviders []string `json:"workspaceProviders,omitempty"`
	// Hooks declares the tool hooks the extension contributes — policy and
	// observation that runs around every tool call whichever strategy is active:
	// before a call (deny it, force an approval, add a note) and after it (add a
	// note for the model, mark it failed). Loaded in both realms; only the
	// engine, where tools run, ever calls one.
	Hooks []string `json:"hooks,omitempty"`
	// SystemPrompt is a single module path (not a glob) whose default export
	// `({enabledPluginIds}) => string` contributes terse, durable guidance to
	// the system prompt — the extension's voice on how to use its tools. It is
	// a function of the enabled-plugin set only, so it is cache-stable across
	// turns and a strategy change (it changes only when plugins are toggled).
	SystemPrompt string `json:"systemPrompt,omitempty"`
	// Tests declares the extension's own test suites (globs relative to the
	// extension root), so each extension owns its tests instead of dumping them
	// into the shared js-tests/ pool. Test-only: not a runtime capability (it is
	// ignored by Validate's capability check and never served via /api/extensions),
	// and it is surfaced only through the test harness's extension-tests endpoint.
	// Conventionally the files live under a "_tests/" directory, whose leading
	// underscore makes `//go:embed extensions/*` skip them so test code never
	// ships in a production binary (mirroring the js-tests/ build-tag exclusion).
	Tests []string `json:"tests,omitempty"`
}

// Setting describes one user-configurable extension value. Settings are global
// in the first API version; Scope is retained in the manifest contract so later
// versions can add project-scoped values without changing its shape.
//
// Capability optionally names one of the extension's own capabilities as
// "<itemType>:<id>" (e.g. "strategy:auto-approve"); the settings UI then also
// shows the setting on that capability's page. It changes where the setting is
// displayed, never where it is stored or who can read it.
type Setting struct {
	Key        string          `json:"key"`
	Type       string          `json:"type"`
	Label      string          `json:"label"`
	Help       string          `json:"help,omitempty"`
	Default    json.RawMessage `json:"default,omitempty"`
	Required   bool            `json:"required,omitempty"`
	Options    []string        `json:"options,omitempty"`
	Scope      string          `json:"scope,omitempty"`
	Capability string          `json:"capability,omitempty"`
}

var settingCapabilityRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*:[^\s:]+$`)

// EffectiveScope returns the normalized setting scope.
func (s Setting) EffectiveScope() string {
	if strings.TrimSpace(s.Scope) == "" {
		return "global"
	}
	return strings.TrimSpace(s.Scope)
}

// Manifest is the parsed juggler.extension.json. It governs packaging,
// versioning, permissioning and discovery; per-capability `static MANIFEST`
// identifies each individual plugin.
type Manifest struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Version     string    `json:"version"`
	Author      string    `json:"author,omitempty"`
	Homepage    string    `json:"homepage,omitempty"`
	License     string    `json:"license,omitempty"` // informational SPDX id for the extension's own code, e.g. "Apache-2.0"
	EngineAPI   string    `json:"engineApi,omitempty"`
	Permissions []string  `json:"permissions,omitempty"`
	Settings    []Setting `json:"settings,omitempty"`
	Provides    Provides  `json:"provides"`
}

// Parse decodes and structurally validates the manifest JSON. Unknown fields are
// rejected so a typo'd key is a clear error rather than a silent no-op.
func Parse(data []byte) (Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// Validate enforces required fields and the engineApi compat range.
func Validate(m Manifest, engineVersion string) error {
	if strings.TrimSpace(m.ID) == "" {
		return fmt.Errorf("manifest missing required field: id")
	}
	if strings.TrimSpace(m.Name) == "" {
		return fmt.Errorf("manifest missing required field: name")
	}
	if strings.TrimSpace(m.Version) == "" {
		return fmt.Errorf("manifest missing required field: version")
	}
	if len(m.Provides.ContextItems) == 0 &&
		len(m.Provides.Strategies) == 0 &&
		len(m.Provides.Commands) == 0 &&
		len(m.Provides.InfoCards) == 0 &&
		len(m.Provides.FileViewers) == 0 &&
		len(m.Provides.PinboardItems) == 0 &&
		len(m.Provides.WorkspaceProviders) == 0 &&
		len(m.Provides.Hooks) == 0 &&
		strings.TrimSpace(m.Provides.SystemPrompt) == "" {
		return fmt.Errorf("manifest %q provides no capabilities", m.ID)
	}
	if !SatisfiesEngineAPI(m.EngineAPI, engineVersion) {
		return fmt.Errorf("extension %q requires engineApi %q, incompatible with host %s",
			m.ID, m.EngineAPI, engineVersion)
	}
	if err := ValidateSettings(m.Settings); err != nil {
		return fmt.Errorf("extension %q settings: %w", m.ID, err)
	}
	return nil
}

var settingKeyRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)

// ValidateSettings validates the declarative settings schema and all defaults.
func ValidateSettings(settings []Setting) error {
	seen := make(map[string]bool, len(settings))
	for i, setting := range settings {
		prefix := fmt.Sprintf("field %d", i+1)
		if !settingKeyRe.MatchString(setting.Key) {
			return fmt.Errorf("%s has invalid key %q (use letters, digits, underscore, or hyphen; start with a letter)", prefix, setting.Key)
		}
		if seen[setting.Key] {
			return fmt.Errorf("duplicate key %q", setting.Key)
		}
		seen[setting.Key] = true
		if strings.TrimSpace(setting.Label) == "" {
			return fmt.Errorf("setting %q is missing label", setting.Key)
		}
		switch setting.Type {
		case "string", "text", "secret", "boolean", "number", "url":
			if len(setting.Options) != 0 {
				return fmt.Errorf("setting %q type %q does not support options", setting.Key, setting.Type)
			}
		case "enum":
			if len(setting.Options) == 0 {
				return fmt.Errorf("setting %q type enum requires options", setting.Key)
			}
			optionSeen := map[string]bool{}
			for _, option := range setting.Options {
				if option == "" || optionSeen[option] {
					return fmt.Errorf("setting %q has empty or duplicate enum option %q", setting.Key, option)
				}
				optionSeen[option] = true
			}
		default:
			return fmt.Errorf("setting %q has unsupported type %q", setting.Key, setting.Type)
		}
		if setting.EffectiveScope() != "global" {
			return fmt.Errorf("setting %q has unsupported scope %q; only global is supported", setting.Key, setting.Scope)
		}
		if setting.Capability != "" && !settingCapabilityRe.MatchString(setting.Capability) {
			return fmt.Errorf("setting %q has invalid capability %q (use \"<itemType>:<id>\", e.g. \"strategy:my-strategy\")", setting.Key, setting.Capability)
		}
		if len(setting.Default) != 0 {
			var value any
			if err := json.Unmarshal(setting.Default, &value); err != nil {
				return fmt.Errorf("setting %q has invalid default: %w", setting.Key, err)
			}
			if setting.Type == "secret" {
				return fmt.Errorf("setting %q type secret cannot declare a default", setting.Key)
			}
			if _, err := ValidateSettingValue(setting, value); err != nil {
				return fmt.Errorf("setting %q has invalid default: %w", setting.Key, err)
			}
		}
	}
	return nil
}

// ValidateSettingValue validates and normalizes a decoded JSON setting value.
func ValidateSettingValue(setting Setting, value any) (any, error) {
	switch setting.Type {
	case "string", "text", "secret":
		v, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("must be a string")
		}
		return v, nil
	case "url":
		v, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("must be a string URL")
		}
		parsed, err := url.ParseRequestURI(v)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, fmt.Errorf("must be an absolute URL")
		}
		return v, nil
	case "boolean":
		v, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("must be a boolean")
		}
		return v, nil
	case "number":
		v, ok := value.(float64)
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("must be a finite number")
		}
		return v, nil
	case "enum":
		v, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("must be a string")
		}
		for _, option := range setting.Options {
			if v == option {
				return v, nil
			}
		}
		return nil, fmt.Errorf("must be one of %q", setting.Options)
	default:
		return nil, fmt.Errorf("has unsupported type %q", setting.Type)
	}
}

// Warnings returns non-fatal advisories about a manifest that passed validation.
// Currently the only one: a blank engineApi makes SatisfiesEngineAPI accept any
// host (the field's compat check is silently disabled), so steer the author to
// declare a range.
func Warnings(m Manifest) []string {
	var warnings []string
	if strings.TrimSpace(m.EngineAPI) == "" {
		warnings = append(warnings, "manifest omits engineApi; compatibility is unchecked — add e.g. \"^1.0.0\"")
	}
	return warnings
}

// ExpandGlobs resolves a list of root-relative globs against fsys (rooted at the
// extension dir) to root-relative file paths, applying the same path-traversal
// guard as the server so a glob can never escape the extension root. Duplicate
// matches across globs are de-duplicated while preserving first-seen order.
func ExpandGlobs(fsys fs.FS, globs []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, g := range globs {
		clean := path.Clean(g)
		// Reject genuine escapes only: an absolute path, exactly "..", or a path
		// that climbs out ("../…"). path.Clean collapses interior traversal, so a
		// leading ".." is the sole escape signature — a name that merely CONTAINS
		// ".." (e.g. "foo..bar-context-item.js") stays inside the root and is fine.
		if g == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			return nil, fmt.Errorf("invalid provides glob %q: must stay inside the extension root", g)
		}
		matches, err := fs.Glob(fsys, clean)
		if err != nil {
			return nil, fmt.Errorf("invalid provides glob %q: %w", g, err)
		}
		for _, match := range matches {
			if seen[match] {
				continue
			}
			seen[match] = true
			out = append(out, match)
		}
	}
	return out, nil
}

var engineAPIVersionRe = regexp.MustCompile(`ENGINE_API_VERSION\s*=\s*['"]([^'"]+)['"]`)

// ReadEngineAPIVersion extracts ENGINE_API_VERSION from web/sdk/version.js on the
// given filesystem, keeping the version single-sourced in the SDK. Falls back to
// DefaultEngineAPIVersion if the file is unreadable or unparseable.
func ReadEngineAPIVersion(fsys fs.FS) string {
	data, err := fs.ReadFile(fsys, "sdk/version.js")
	if err != nil {
		return DefaultEngineAPIVersion
	}
	if m := engineAPIVersionRe.FindSubmatch(data); m != nil {
		return string(m[1])
	}
	return DefaultEngineAPIVersion
}

// SatisfiesEngineAPI mirrors satisfiesEngineApi in web/sdk/version.js: it accepts
// an exact version (1.2.3), a caret range (^1.2.3 — same major, >= floor), or *
// (any). Anything unrecognised returns false so the host surfaces a clear error.
func SatisfiesEngineAPI(rng, version string) bool {
	trimmed := strings.TrimSpace(rng)
	if trimmed == "*" || trimmed == "" {
		return true
	}
	cur, ok := parseSemver(version)
	if !ok {
		return false
	}
	if strings.HasPrefix(trimmed, "^") {
		floor, ok := parseSemver(trimmed[1:])
		if !ok {
			return false
		}
		if cur[0] != floor[0] {
			return false // same major
		}
		if cur[1] != floor[1] {
			return cur[1] > floor[1]
		}
		return cur[2] >= floor[2]
	}
	exact, ok := parseSemver(trimmed)
	if !ok {
		return false
	}
	return cur[0] == exact[0] && cur[1] == exact[1] && cur[2] == exact[2]
}

var semverRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)`)

// parseSemver extracts the leading major.minor.patch triple from v.
func parseSemver(v string) ([3]int, bool) {
	m := semverRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return [3]int{}, false
	}
	var out [3]int
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}
