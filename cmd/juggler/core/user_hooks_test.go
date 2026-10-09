//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestListUserHooksParsesAValidFile pins the file format end to end: every
// frontmatter field lands, and the body is the text the hook adds.
func TestListUserHooksParsesAValidFile(t *testing.T) {
	dir := t.TempDir()
	writeHookFile(t, dir, "nono-denial.md", "---\n"+
		"description: Explain nono sandbox denials\n"+
		"event: afterTool\n"+
		"tool: bash, write_file\n"+
		`result: "Operation not permitted|EPERM"`+"\n"+
		"isError: true\n"+
		"repeat: once-per-thread\n"+
		"---\n"+
		"Run `nono why` to see what was denied.\n")

	hooks := ListUserHooks(dir)
	if len(hooks) != 1 {
		t.Fatalf("got %d hooks, want 1", len(hooks))
	}
	h := hooks[0]
	if h.Error != "" {
		t.Fatalf("unexpected error: %s", h.Error)
	}
	want := UserHookFrontmatter{
		Description: "Explain nono sandbox denials",
		Event:       "afterTool",
		Tool:        "bash, write_file",
		Result:      "Operation not permitted|EPERM",
		IsError:     "true",
		Repeat:      "once-per-thread",
	}
	if h.Frontmatter != want {
		t.Errorf("frontmatter = %+v, want %+v", h.Frontmatter, want)
	}
	if h.Name != "nono-denial" || h.Scope != "user" {
		t.Errorf("name/scope = %q/%q", h.Name, h.Scope)
	}
	if h.Body != "Run `nono why` to see what was denied.\n" {
		t.Errorf("body = %q", h.Body)
	}
}

// TestListUserHooksReportsBrokenFiles pins that a hook which cannot run is
// listed with the reason rather than dropped: a guard the user believes is
// active and silently is not is the worst outcome a hook can have.
func TestListUserHooksReportsBrokenFiles(t *testing.T) {
	cases := []struct {
		name, file, wantErr string
	}{
		{"no-event.md", "---\ndescription: d\n---\nnote\n", "missing required frontmatter field: event"},
		{"bad-event.md", "---\ndescription: d\nevent: onStop\n---\nnote\n", `event must be "beforeTool" or "afterTool"`},
		{"allow.md", "---\ndescription: d\nevent: beforeTool\nverdict: allow\n---\nx\n", `verdict must be "deny" or "ask"`},
		{"late-verdict.md", "---\ndescription: d\nevent: afterTool\nverdict: deny\n---\nx\n", "verdict applies only to a beforeTool hook"},
		{"early-result.md", "---\ndescription: d\nevent: beforeTool\nresult: EPERM\n---\nx\n", "result applies only to an afterTool hook"},
		{"empty-body.md", "---\ndescription: d\nevent: afterTool\n---\n\n", "the body is empty"},
		{"no-frontmatter.md", "just text\n", "missing YAML frontmatter"},
		{"Bad_Name.md", "---\ndescription: d\nevent: afterTool\n---\nx\n", "invalid hook name"},
	}
	dir := t.TempDir()
	for _, c := range cases {
		writeHookFile(t, dir, c.name, c.file)
	}
	byName := map[string]UserHook{}
	for _, h := range ListUserHooks(dir) {
		byName[h.Name+".md"] = h
	}
	for _, c := range cases {
		h, ok := byName[c.name]
		if !ok {
			t.Errorf("%s: not listed", c.name)
			continue
		}
		if !strings.Contains(h.Error, c.wantErr) {
			t.Errorf("%s: error = %q, want it to contain %q", c.name, h.Error, c.wantErr)
		}
	}
}

// TestListUserHooksAskNeedsNoBody pins the one verdict whose body is optional:
// an "ask" hook parks the call for the user, and the card already says why.
func TestListUserHooksAskNeedsNoBody(t *testing.T) {
	dir := t.TempDir()
	writeHookFile(t, dir, "ask-migrations.md", "---\ndescription: d\nevent: beforeTool\ninput: migrations/\nverdict: ask\n---\n")
	hooks := ListUserHooks(dir)
	if len(hooks) != 1 || hooks[0].Error != "" {
		t.Fatalf("hooks = %+v, want one valid hook", hooks)
	}
}

// TestListUserHooksMissingDir pins that no hooks directory means no hooks, not
// an error and not a nil the API would serialise as null.
func TestListUserHooksMissingDir(t *testing.T) {
	hooks := ListUserHooks(filepath.Join(t.TempDir(), "absent"))
	if hooks == nil || len(hooks) != 0 {
		t.Fatalf("hooks = %#v, want an empty, non-nil list", hooks)
	}
}

func writeHookFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
