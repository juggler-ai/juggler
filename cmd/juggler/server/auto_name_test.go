//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
)

// TestAutoNameTransient pins which completion failures earn a re-attempt. The
// case that matters most is the first: an upstream overload used to end the
// whole naming attempt on the spot, so a tab silently kept "Untitled N" until
// the user pressed Auto-name by hand.
func TestAutoNameTransient(t *testing.T) {
	overloaded := errors.New(`received error while streaming: {"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}`)

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"upstream overload", overloaded, true},
		{"wrapped overload", fmt.Errorf("quick complete: %w", overloaded), true},
		{"out-of-band channel busy", ErrQuickCompleteBusy, true},
		{"per-call timeout", context.DeadlineExceeded, true},
		{"bad credentials", errors.New(`quick complete: provider "anthropic" unavailable: no credential`), false},
		{"model rejected the request", errors.New("400 invalid_request_error"), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := autoNameTransient(context.Background(), tt.err); got != tt.want {
				t.Fatalf("autoNameTransient(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}

	// An expired naming budget makes every error terminal: the deadline that
	// fired was the outer one, so re-attempting would fail instantly forever.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if autoNameTransient(ctx, overloaded) {
		t.Fatal("autoNameTransient = true on a cancelled budget, want false")
	}
}

// TestSleepCtx pins the backoff's abandon-on-expiry contract: a naming attempt
// whose budget dies mid-backoff must stop, not wake up and call the provider.
func TestSleepCtx(t *testing.T) {
	if !sleepCtx(context.Background(), time.Millisecond) {
		t.Fatal("sleepCtx = false for a completed wait, want true")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sleepCtx(ctx, time.Hour) {
		t.Fatal("sleepCtx = true on a cancelled context, want false")
	}
}

func TestSanitizeAutoName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Fix login bug", "Fix login bug"},
		{"trims space", "   Add dark mode   ", "Add dark mode"},
		{"strips straight quotes", `"Refactor auth layer"`, "Refactor auth layer"},
		{"strips single quotes", `'Cleanup CI'`, "Cleanup CI"},
		{"strips curly quotes", "\u201cShip the release\u201d", "Ship the release"},
		{"first line only", "Update parser\nand also the lexer", "Update parser"},
		{"skips leading blank lines", "\n\n  Wire up webhooks", "Wire up webhooks"},
		{"collapses whitespace", "Set   up\tCI   pipeline", "Set up CI pipeline"},
		{"trims trailing punctuation", "Investigate flaky test.", "Investigate flaky test"},
		{"empty", "", ""},
		{"whitespace only", "   \n\t ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeAutoName(tt.in); got != tt.want {
				t.Fatalf("sanitizeAutoName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeAutoNameCapsLength(t *testing.T) {
	long := strings.Repeat("word ", 40) // far over the cap
	got := sanitizeAutoName(long)
	if n := len([]rune(got)); n > autoNameMaxLen {
		t.Fatalf("sanitized length = %d runes, want <= %d", n, autoNameMaxLen)
	}
	if got == "" {
		t.Fatal("expected a non-empty truncated title")
	}
}

// TestSanitizeAutoNameTruncatesOnWordBoundary pins that a title overrunning the
// cap is cut back to a whole word. The prompt asks for the specific subject of
// the task (a file, a symbol, an error), which is exactly the detail that pushes
// a title over the cap — and a title severed mid-word identifies it worse than
// the generic one it was meant to beat.
func TestSanitizeAutoNameTruncatesOnWordBoundary(t *testing.T) {
	// 52 runes: the cut at 48 lands one letter into "flake".
	got := sanitizeAutoName("Investigate browser pool connection starvation flake")
	if want := "Investigate browser pool connection starvation"; got != want {
		t.Fatalf("sanitizeAutoName = %q, want %q", got, want)
	}

	// No boundary to fall back to: a hard cut is better than nothing.
	long := strings.Repeat("x", 60)
	if n := len([]rune(sanitizeAutoName(long))); n != autoNameMaxLen {
		t.Fatalf("unbroken title kept %d runes, want %d", n, autoNameMaxLen)
	}
}

func TestTruncateRunesMultibyte(t *testing.T) {
	// Ensure a multibyte string isn't split mid-rune and stays within the cap.
	in := strings.Repeat("é", 10)
	got := truncateRunes(in, 4)
	if n := len([]rune(got)); n > 4 {
		t.Fatalf("truncateRunes kept %d runes, want <= 4", n)
	}
	if !strings.HasPrefix(in, got) {
		t.Fatalf("truncateRunes(%q) = %q, not a prefix", in, got)
	}
}

func TestAcceptableAutoName(t *testing.T) {
	good := []string{
		"Fix login bug",
		"Add dark mode toggle",
		"Refactor auth layer",
		"Investigate flaky CI test",
		"Wire up webhooks",
		"Import CSV parser rewrite", // starts with a legit word, not a preamble
	}
	bad := []string{
		"",
		// The exact real-world failure: a conversational reply, truncated.
		"I'd be happy to help organize those changes into",
		"I'll take a look at that for you",
		"I'm on it right away",
		"Sure, let's get started on this",
		"Here's a summary of the task",
		"Let me help you with that",
		"Of course I can do that",
		"Okay so what you want is a new parser",
		// A full sentence: too many words even without a preamble.
		"This title clearly runs well past any sensible tab label length here",
	}
	for _, g := range good {
		if !acceptableAutoName(g) {
			t.Errorf("expected %q to be acceptable", g)
		}
	}
	for _, b := range bad {
		if acceptableAutoName(b) {
			t.Errorf("expected %q to be rejected", b)
		}
	}
}

// TestSiblingTitles pins which existing tab names the namer is shown as an
// avoid-list. Placeholders carry no information to avoid, the conversation being
// named is not its own sibling, and a name repeated across tabs is worth saying
// once.
func TestSiblingTitles(t *testing.T) {
	order := []string{"c1", "c2", "c3", "c4", "c5", "c6"}
	names := map[string]string{
		"c1": "Fix login redirect bug",
		"c2": "Untitled 4", // placeholder: nothing to distinguish from
		"c3": "Add dark mode toggle",
		"c4": "Fix login redirect bug", // duplicate, case-folded below
		"c5": "fix LOGIN redirect BUG",
		"c6": "   ", // blank name on disk
		// "c7" is in neither map nor order.
	}

	got := siblingTitles(order, names, "c3", 24)
	want := []string{"Fix login redirect bug"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("siblingTitles = %q, want %q", got, want)
	}

	// The conversation being named is excluded by id, not by name: c4 and c5 are
	// other tabs that happen to share c1's name, and dropping c1 leaves theirs
	// standing (once, folded).
	got = siblingTitles(order, names, "c1", 24)
	want = []string{"Add dark mode toggle", "Fix login redirect bug"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("siblingTitles excluding c1 = %q, want %q", got, want)
	}

	// A conversation absent from the tab order (never in the order, or evicted
	// mid-derivation) still gets the others.
	if got := siblingTitles(order, names, "c7", 24); len(got) != 2 {
		t.Fatalf("siblingTitles for an unknown id = %q, want 2 names", got)
	}
}

// TestSiblingTitlesPrefersNeighbours pins the rule for trimming an over-long
// avoid-list: keep the tabs nearest this one in tab order — the ones it will sit
// beside and be mistaken for — and keep them in tab order, not distance order.
func TestSiblingTitlesPrefersNeighbours(t *testing.T) {
	var order []string
	names := map[string]string{}
	for i := range 9 {
		id := fmt.Sprintf("c%d", i)
		order = append(order, id)
		names[id] = fmt.Sprintf("Title %d", i)
	}

	got := siblingTitles(order, names, "c4", 4)
	want := []string{"Title 2", "Title 3", "Title 5", "Title 6"}
	if len(got) != len(want) {
		t.Fatalf("siblingTitles = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("siblingTitles = %q, want %q", got, want)
		}
	}
}

// TestAutoNamePromptListsTitlesInUse pins that the avoid-list reaches the model,
// and that an empty one leaves no empty scaffolding behind for the model to
// puzzle over.
func TestAutoNamePromptListsTitlesInUse(t *testing.T) {
	with := autoNamePrompt("fix the flaky test", []string{"Fix login redirect bug", "Add dark mode toggle"})
	for _, want := range []string{"TITLES IN USE", "Fix login redirect bug", "Add dark mode toggle", "fix the flaky test"} {
		if !strings.Contains(with, want) {
			t.Fatalf("prompt missing %q:\n%s", want, with)
		}
	}

	without := autoNamePrompt("fix the flaky test", nil)
	if strings.Contains(without, "TITLES IN USE") {
		t.Fatalf("prompt has an empty titles section:\n%s", without)
	}
	if !strings.Contains(without, "fix the flaky test") {
		t.Fatalf("prompt missing the message:\n%s", without)
	}
}

// TestAutoNameFailedNotice pins that the toast for a naming whose completion
// gave up carries the reason it gave up, in the provider's own words — the same
// sentence the model chooser shows for that provider — rather than a blanket
// "the model was unavailable" that leaves the user no way to tell an expired
// login from an outage. The "quick complete:" plumbing prefixes are ours, not
// the provider's, and stay out of it.
func TestAutoNameFailedNotice(t *testing.T) {
	const codexHint = "codex access token is expired; sign in with the ChatGPT app or run `codex login` (checked /home/u/.codex/auth.json)"

	tests := []struct {
		name    string
		err     error
		want    []string
		notWant []string
	}{
		{
			name:    "expired login",
			err:     &providerUnavailableError{op: "quick complete", provider: "codex", err: errors.New(codexHint)},
			want:    []string{"gpt-5-mini", codexHint},
			notWant: []string{"quick complete", "unavailable"},
		},
		{
			name: "provider refused the credential mid-request",
			err: fmt.Errorf("stream: %w", &provider.AuthError{
				Provider: "anthropic", Status: 401,
				Message: "OAuth access token has expired.",
				Hint:    "Sign in again with `claude login`.",
			}),
			want:    []string{"OAuth access token has expired", "Sign in again with `claude login`"},
			notWant: []string{"stream:"},
		},
		{
			name:    "timed out",
			err:     ErrQuickCompleteTimeout,
			want:    []string{"did not answer in time"},
			notWant: []string{"quick complete", "deadline exceeded"},
		},
		{
			name:    "anything else",
			err:     fmt.Errorf("quick complete: open conversation: %w", errors.New("400 invalid_request_error")),
			want:    []string{"open conversation: 400 invalid_request_error"},
			notWant: []string{"quick complete"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := autoNameCompletionFailedNotice("gpt-5-mini", tt.err).English()
			for _, want := range tt.want {
				if !strings.Contains(got, want) {
					t.Errorf("notice %q is missing %q", got, want)
				}
			}
			for _, bad := range tt.notWant {
				if strings.Contains(got, bad) {
					t.Errorf("notice %q contains %q", got, bad)
				}
			}
			if strings.Contains(got, "..") {
				t.Errorf("notice %q doubles its full stop", got)
			}
		})
	}
}

// TestNameIsProvisionalWithoutLoadedWorker pins the "can't tell ⇒ don't rename" reading
// of the auto-namer's guard. The marker lives in the conversation's doc, so only
// a loaded worker can answer; with no worker manager at all, or no worker for the
// id, the guard must refuse rather than rename a name it cannot inspect.
func TestNameIsProvisionalWithoutLoadedWorker(t *testing.T) {
	if (&Server{}).isProvisionalName("conv_missing1") {
		t.Error("isProvisionalName = true with no worker manager, want false")
	}

	wm := worker.NewManager()
	t.Cleanup(wm.Shutdown)
	if (&Server{workerManager: wm}).isProvisionalName("conv_missing2") {
		t.Error("isProvisionalName = true for a conversation with no loaded worker, want false")
	}
}
