//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"juggler/internal/userpaths"
)

// User-defined slash commands are declarative markdown files (YAML frontmatter +
// prompt-template body), one command per file, in two scopes:
//
//	~/.juggler/commands/*.md            user scope (all projects)
//	<project>/.juggler/commands/*.md    project scope (git-shareable)
//
// They are the no-code tier below extensions: a command is *data* interpreted by
// a single generic frontend CommandType. This file is their store: where each
// scope lives, the file format, and the reads and writes. The HTTP surface is
// handlers.UserCommandsAPI.

// userCommandNamePattern is the allowed command name (= filename sans .md).
var userCommandNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// validRunModes are the execution modes a definition may declare.
var validRunModes = map[string]bool{"send": true, "draft": true, "subthread": true}

// UserCommandFrontmatter is the parsed YAML frontmatter of a command file. All
// fields are optional except description (required; its absence is surfaced as
// an Error on the owning UserCommand, never a silent drop).
// A model override is the same four-part reference the model picker produces:
// Provider names the account it runs on, and Thinking/ServiceTier are the dials
// that model advertises. Model alone (no Provider) is also valid — it is what a
// hand-written file and the define_command tool produce — and is resolved
// against the provider list by id on the client.
type UserCommandFrontmatter struct {
	Description string `json:"description,omitempty"`
	ArgsHint    string `json:"argsHint,omitempty"`
	Run         string `json:"run,omitempty"`         // send (default) | draft | subthread
	Strategy    string `json:"strategy,omitempty"`    // subthread only
	Provider    string `json:"provider,omitempty"`    // subthread only
	Model       string `json:"model,omitempty"`       // subthread only
	Thinking    string `json:"thinking,omitempty"`    // subthread only
	ServiceTier string `json:"serviceTier,omitempty"` // subthread only
	Icon        string `json:"icon,omitempty"`
	Goal        string `json:"goal,omitempty"` // subthread only — thread goal label
}

// UserCommand is one discovered command file. A file that fails to parse or
// validate is still returned with Error set so the manager UI can show exactly
// why it is broken — never a silent drop.
type UserCommand struct {
	Name        string                 `json:"name"`
	Scope       string                 `json:"scope"` // "user" | "project"
	Path        string                 `json:"path"`  // absolute on-disk path
	Frontmatter UserCommandFrontmatter `json:"frontmatter"`
	Body        string                 `json:"body"`
	Error       string                 `json:"error,omitempty"`
}

// UserCommandSpec is a command as written: its frontmatter fields and its
// template. The server owns markdown serialization so the editor dialog and the
// define_command tool share one format and one validation path.
type UserCommandSpec struct {
	Description string `json:"description"`
	ArgsHint    string `json:"argsHint"`
	Run         string `json:"run"`
	Strategy    string `json:"strategy"`
	Provider    string `json:"provider"`
	Model       string `json:"model"`
	Thinking    string `json:"thinking"`
	ServiceTier string `json:"serviceTier"`
	Icon        string `json:"icon"`
	Goal        string `json:"goal"`
	Template    string `json:"template"` // the prompt-template body
}

// UserCommandDir is the user-scope command directory (~/.juggler/commands).
func UserCommandDir() string {
	return filepath.Join(userpaths.ConfigDir(), "commands")
}

// ProjectCommandDir is the project-scope command directory
// (<project>/.juggler/commands), or "" in no-project mode.
func ProjectCommandDir(projectPath string) string {
	if projectPath == "" {
		return ""
	}
	return filepath.Join(projectPath, ".juggler", "commands")
}

// ValidUserCommandName reports whether name is an allowed command name, and so
// a safe file name inside a scope directory.
func ValidUserCommandName(name string) bool {
	return userCommandNamePattern.MatchString(name)
}

// ListUserCommands returns every command in the two scope directories, sorted
// by scope then name for deterministic output. Either directory may be "" or
// absent, and contributes nothing then. Malformed files are returned with Error
// set rather than dropped.
func ListUserCommands(userDir, projectDir string) []UserCommand {
	commands := []UserCommand{}
	commands = append(commands, discoverCommands(userDir, "user")...)
	commands = append(commands, discoverCommands(projectDir, "project")...)
	sort.Slice(commands, func(i, j int) bool {
		if commands[i].Scope != commands[j].Scope {
			return commands[i].Scope < commands[j].Scope
		}
		return commands[i].Name < commands[j].Name
	})
	return commands
}

// ValidateUserCommand returns a field→message map of validation errors (empty
// when the command is valid). Collisions with built-in/extension command ids are
// deliberately NOT checked here: built-ins are defined in frontend JS the server
// cannot enumerate, so a colliding definition still writes and is flagged at
// registry load time (surfaced in the manager UI).
func ValidateUserCommand(name string, spec UserCommandSpec) map[string]string {
	errs := map[string]string{}
	if !ValidUserCommandName(name) {
		errs["name"] = "name must be lowercase, start with a letter, and use only letters, digits, and hyphens"
	}
	if strings.TrimSpace(spec.Description) == "" {
		errs["description"] = "description is required"
	}
	if spec.Run != "" && !validRunModes[spec.Run] {
		errs["run"] = `run must be one of "send", "draft", or "subthread"`
	}
	if strings.TrimSpace(spec.Template) == "" {
		errs["template"] = "template is required"
	}
	return errs
}

// WriteUserCommand creates or overwrites <dir>/<name>.md, creating dir on
// demand, and returns the entry a later ListUserCommands would report for it.
// The caller validates first (ValidateUserCommand); this only writes.
func WriteUserCommand(dir, scope, name string, spec UserCommandSpec) (UserCommand, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return UserCommand{}, fmt.Errorf("could not create commands dir: %w", err)
	}
	path := filepath.Join(dir, name+".md")
	if err := os.WriteFile(path, []byte(serializeCommand(spec)), 0o644); err != nil {
		return UserCommand{}, fmt.Errorf("could not write command: %w", err)
	}
	return UserCommand{
		Name:        name,
		Scope:       scope,
		Path:        path,
		Frontmatter: frontmatterOf(spec),
		Body:        spec.Template,
	}, nil
}

// DeleteUserCommand removes <dir>/<name>.md. A missing file is a no-op success
// (idempotent delete). The caller checks the name (ValidUserCommandName).
func DeleteUserCommand(dir, name string) error {
	path := filepath.Join(dir, name+".md")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("could not delete command: %w", err)
	}
	return nil
}

// frontmatterOf projects a spec onto the frontmatter shape returned by
// discovery, so a write's reply matches what a subsequent list would report.
func frontmatterOf(spec UserCommandSpec) UserCommandFrontmatter {
	return UserCommandFrontmatter{
		Description: spec.Description,
		ArgsHint:    spec.ArgsHint,
		Run:         spec.Run,
		Strategy:    spec.Strategy,
		Provider:    spec.Provider,
		Model:       spec.Model,
		Thinking:    spec.Thinking,
		ServiceTier: spec.ServiceTier,
		Icon:        spec.Icon,
		Goal:        spec.Goal,
	}
}

// serializeCommand renders a spec as a markdown file: a YAML frontmatter block
// (only non-empty fields) followed by the template body. The output
// round-trips through parseCommandFile.
func serializeCommand(spec UserCommandSpec) string {
	var b strings.Builder
	b.WriteString("---\n")
	writeField(&b, "description", spec.Description)
	writeField(&b, "argsHint", spec.ArgsHint)
	writeField(&b, "run", spec.Run)
	writeField(&b, "strategy", spec.Strategy)
	writeField(&b, "provider", spec.Provider)
	writeField(&b, "model", spec.Model)
	writeField(&b, "thinking", spec.Thinking)
	writeField(&b, "serviceTier", spec.ServiceTier)
	writeField(&b, "icon", spec.Icon)
	writeField(&b, "goal", spec.Goal)
	b.WriteString("---\n")
	b.WriteString(spec.Template)
	if !strings.HasSuffix(spec.Template, "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

// writeField emits one `key: value` frontmatter line when value is non-empty,
// quoting values whose leading/trailing whitespace or reserved leading
// characters would otherwise not round-trip through the flat parser.
func writeField(b *strings.Builder, key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	if needsQuoting(value) {
		value = `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	b.WriteString(key)
	b.WriteString(": ")
	b.WriteString(value)
	b.WriteString("\n")
}

// needsQuoting reports whether a scalar value must be quoted to survive a
// round-trip (leading/trailing whitespace, or a leading YAML-significant char).
func needsQuoting(v string) bool {
	if v != strings.TrimSpace(v) {
		return true
	}
	if v == "" {
		return true
	}
	switch v[0] {
	case '"', '\'', '#', '&', '*', '!', '|', '>', '%', '@', '`', '[', '{':
		return true
	}
	return false
}

// discoverCommands scans one scope directory for *.md command files. A missing
// directory yields nothing. Each file is parsed; parse/validation failures are
// returned with Error set (never dropped).
func discoverCommands(dir, scope string) []UserCommand {
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil // absent or unreadable — no commands here
	}
	var out []UserCommand
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".md")
		path := filepath.Join(dir, entry.Name())
		cmd := UserCommand{Name: name, Scope: scope, Path: path}

		if !ValidUserCommandName(name) {
			cmd.Error = "invalid command name (must be lowercase letters, digits, and hyphens, starting with a letter)"
			out = append(out, cmd)
			continue
		}

		data, err := os.ReadFile(path)
		if err != nil {
			cmd.Error = fmt.Sprintf("could not read file: %v", err)
			out = append(out, cmd)
			continue
		}
		fm, body, err := parseCommandFile(data)
		cmd.Frontmatter = fm
		cmd.Body = body
		if err != nil {
			cmd.Error = err.Error()
		} else if strings.TrimSpace(fm.Description) == "" {
			cmd.Error = "missing required frontmatter field: description"
		}
		out = append(out, cmd)
	}
	return out
}

// parseCommandFile splits a command file into its frontmatter and body. The
// frontmatter is a flat `key: value` block delimited by `---` lines; the body is
// everything after the closing delimiter. The parser is deliberately flat (no
// nested YAML) — the schema is a handful of scalar fields — which keeps it
// dependency-free and tolerant of the Claude-Code `.claude/commands` format on
// import (unknown keys are ignored; `argument-hint` maps to argsHint).
func parseCommandFile(data []byte) (UserCommandFrontmatter, string, error) {
	var fm UserCommandFrontmatter
	fmLines, body, err := splitFrontmatter(data)
	if err != nil {
		return fm, body, err
	}
	scanFrontmatterFields(fmLines, func(key, value string) {
		assignFrontmatterField(&fm, key, value)
	})
	return fm, body, nil
}

// assignFrontmatterField maps one frontmatter key to its struct field. Unknown
// keys are ignored; `argument-hint` is accepted as an alias of argsHint for
// Claude-Code import compatibility.
func assignFrontmatterField(fm *UserCommandFrontmatter, key, value string) {
	switch key {
	case "description":
		fm.Description = value
	case "argsHint", "argument-hint":
		fm.ArgsHint = value
	case "run":
		fm.Run = value
	case "strategy":
		fm.Strategy = value
	case "provider":
		fm.Provider = value
	case "model":
		fm.Model = value
	case "thinking":
		fm.Thinking = value
	case "serviceTier":
		fm.ServiceTier = value
	case "icon":
		fm.Icon = value
	case "goal":
		fm.Goal = value
	}
}
