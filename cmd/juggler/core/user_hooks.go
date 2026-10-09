//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"juggler/internal/userpaths"
)

// User hooks are declarative markdown files — the no-code tier of tool hooks,
// below the `hooks` extension capability. One hook per file, in user scope only:
//
//	~/.juggler/hooks/*.md
//
// There is deliberately no project scope. A hook runs on every matching tool
// call without anyone invoking it, so a file a cloned repository could supply
// would be repository code acting with no click; user scope is trusted because
// the user put it there, exactly like an extension.
//
// A hook file is data interpreted by one generic frontend HookType. Its
// frontmatter says when it fires; its body is what it says:
//
//	---
//	description: Explain nono sandbox denials
//	event: afterTool
//	tool: bash
//	result: Operation not permitted|EPERM|EACCES
//	repeat: once-per-thread
//	---
//	The nono sandbox denied that. Run `nono why <path>` to see why ...
//
// This file is their store: the directory, the format, and the read. The HTTP
// surface is handlers.UserHooksAPI; the matching rules live with the runtime
// (web/js/services/hook-runtime.js), which is the one place they are applied.

// validHookEvents are the events a hook file may declare.
var validHookEvents = map[string]bool{"beforeTool": true, "afterTool": true}

// validHookVerdicts are the verdicts a beforeTool hook file may declare. A file
// with no verdict adds its body as a note instead of ruling on the call. There is
// no "allow": a file is static text and cannot tell the calls it would wave
// through from the ones it should not, so approving stays with code (an
// extension hook) or with the user.
var validHookVerdicts = map[string]bool{"deny": true, "ask": true}

// validHookRepeats are the repeat modes a hook file may declare.
var validHookRepeats = map[string]bool{"always": true, "once-per-thread": true}

// UserHookFrontmatter is the parsed frontmatter of a hook file. Description and
// event are required; their absence is surfaced as an Error on the owning
// UserHook, never a silent drop.
type UserHookFrontmatter struct {
	Description string `json:"description,omitempty"`
	Event       string `json:"event,omitempty"`   // beforeTool | afterTool
	Tool        string `json:"tool,omitempty"`    // comma-separated tool names; empty = every tool
	Input       string `json:"input,omitempty"`   // regex tested against the call's JSON input
	Result      string `json:"result,omitempty"`  // regex tested against the result text (afterTool only)
	IsError     string `json:"isError,omitempty"` // "true" | "false" — match failed or succeeded calls only (afterTool only)
	Verdict     string `json:"verdict,omitempty"` // deny | ask (beforeTool only); empty = add a note
	Repeat      string `json:"repeat,omitempty"`  // always (default) | once-per-thread
}

// UserHook is one discovered hook file. A file that fails to parse or validate is
// still returned with Error set, so the manager can say exactly why it is not
// running.
type UserHook struct {
	Name        string              `json:"name"`
	Scope       string              `json:"scope"` // always "user"
	Path        string              `json:"path"`  // absolute on-disk path
	Frontmatter UserHookFrontmatter `json:"frontmatter"`
	Body        string              `json:"body"`
	Error       string              `json:"error,omitempty"`
}

// UserHookDir is the hook directory (~/.juggler/hooks).
func UserHookDir() string {
	return filepath.Join(userpaths.ConfigDir(), "hooks")
}

// ListUserHooks returns every hook file in dir, sorted by name. A missing
// directory yields an empty list; malformed files are returned with Error set.
func ListUserHooks(dir string) []UserHook {
	hooks := []UserHook{}
	if dir == "" {
		return hooks
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return hooks // absent or unreadable — no hooks here
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		hooks = append(hooks, readUserHook(filepath.Join(dir, entry.Name())))
	}
	sort.Slice(hooks, func(i, j int) bool { return hooks[i].Name < hooks[j].Name })
	return hooks
}

// readUserHook reads and validates one hook file.
func readUserHook(path string) UserHook {
	name := strings.TrimSuffix(filepath.Base(path), ".md")
	hook := UserHook{Name: name, Scope: "user", Path: path}
	if !ValidUserCommandName(name) {
		hook.Error = "invalid hook name (must be lowercase letters, digits, and hyphens, starting with a letter)"
		return hook
	}
	data, err := os.ReadFile(path)
	if err != nil {
		hook.Error = fmt.Sprintf("could not read file: %v", err)
		return hook
	}
	fmLines, body, err := splitFrontmatter(data)
	hook.Body = body
	if err != nil {
		hook.Error = err.Error()
		return hook
	}
	scanFrontmatterFields(fmLines, func(key, value string) {
		assignHookField(&hook.Frontmatter, key, value)
	})
	hook.Error = validateUserHook(hook.Frontmatter, body)
	return hook
}

// assignHookField maps one frontmatter key to its field. Unknown keys are ignored.
func assignHookField(fm *UserHookFrontmatter, key, value string) {
	switch key {
	case "description":
		fm.Description = value
	case "event":
		fm.Event = value
	case "tool":
		fm.Tool = value
	case "input":
		fm.Input = value
	case "result":
		fm.Result = value
	case "isError":
		fm.IsError = value
	case "verdict":
		fm.Verdict = value
	case "repeat":
		fm.Repeat = value
	}
}

// validateUserHook returns the first problem with a hook definition, or "" when
// it is valid. The input and result patterns are JavaScript regular expressions,
// compiled and checked where they run (the frontend registry), since Go's RE2
// accepts a different language.
func validateUserHook(fm UserHookFrontmatter, body string) string {
	switch {
	case strings.TrimSpace(fm.Description) == "":
		return "missing required frontmatter field: description"
	case fm.Event == "":
		return `missing required frontmatter field: event ("beforeTool" or "afterTool")`
	case !validHookEvents[fm.Event]:
		return fmt.Sprintf(`event must be "beforeTool" or "afterTool", not %q`, fm.Event)
	case fm.Verdict != "" && fm.Event != "beforeTool":
		return "verdict applies only to a beforeTool hook — an afterTool hook runs after the call has happened"
	case fm.Verdict != "" && !validHookVerdicts[fm.Verdict]:
		return fmt.Sprintf(`verdict must be "deny" or "ask", not %q`, fm.Verdict)
	case fm.Result != "" && fm.Event != "afterTool":
		return "result applies only to an afterTool hook — there is no result before the call"
	case fm.IsError != "" && fm.Event != "afterTool":
		return "isError applies only to an afterTool hook — there is no result before the call"
	case fm.IsError != "" && fm.IsError != "true" && fm.IsError != "false":
		return fmt.Sprintf(`isError must be "true" or "false", not %q`, fm.IsError)
	case fm.Repeat != "" && !validHookRepeats[fm.Repeat]:
		return fmt.Sprintf(`repeat must be "always" or "once-per-thread", not %q`, fm.Repeat)
	case fm.Verdict != "ask" && strings.TrimSpace(body) == "":
		return "the body is empty — it is the note (or, for deny, the reason) the hook adds"
	}
	return ""
}
