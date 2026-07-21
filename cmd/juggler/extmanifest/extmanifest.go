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
	// Lifecycle is a single module path (not a glob) whose default export is an
	// object of async hooks the host invokes on conversation lifecycle events —
	// `onConversationActivated` / `onConversationDeleted`. It lets an extension
	// run project-scoped setup/teardown that the capability types can't express:
	// notably, moving each of a project's git repositories into a per-conversation
	// worktree (via `bindWorkspace` — see `juggler/ops`). It is orthogonal to
	// Strategies (loop autonomy); an enabled lifecycle module applies to every
	// conversation in the project (per-project opt-in, by enabling the extension).
	Lifecycle string `json:"lifecycle,omitempty"`
	// SystemPrompt is a single module path (not a glob) whose default export
	// `({enabledPluginIds}) => string` contributes terse, durable guidance to
	// the system prompt — the extension's voice on how to use its tools. It is
	// a function of the enabled-plugin set only, so it is cache-stable across
	// turns and a strategy change (it changes only when plugins are toggled).
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

// Manifest is the parsed juggler.extension.json. It governs packaging,
// versioning, permissioning and discovery; per-capability `static MANIFEST`
// identifies each individual plugin.
type Manifest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Author      string   `json:"author,omitempty"`
	Homepage    string   `json:"homepage,omitempty"`
	License     string   `json:"license,omitempty"` // informational SPDX id for the extension's own code, e.g. "Apache-2.0"
	EngineAPI   string   `json:"engineApi,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	Provides    Provides `json:"provides"`
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
		strings.TrimSpace(m.Provides.Lifecycle) == "" &&
		strings.TrimSpace(m.Provides.SystemPrompt) == "" {
		return fmt.Errorf("manifest %q provides no capabilities", m.ID)
	}
	if !SatisfiesEngineAPI(m.EngineAPI, engineVersion) {
		return fmt.Errorf("extension %q requires engineApi %q, incompatible with host %s",
			m.ID, m.EngineAPI, engineVersion)
	}
	return nil
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
