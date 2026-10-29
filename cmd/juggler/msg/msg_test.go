//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
)

// parityFixture is shared with the JS half (unit:i18n-format-parity), which
// runs the same cases through the SDK's t() and serverText().
const parityFixture = "../../../web/js-tests/fixtures/i18n-format-parity.json"

// TestFormatParity runs the cases the SDK's formatter is held to, so the Go
// and JS renderings of one message cannot drift apart.
func TestFormatParity(t *testing.T) {
	data, err := os.ReadFile(parityFixture)
	if err != nil {
		t.Fatalf("read %s: %v", parityFixture, err)
	}
	var cases []struct {
		Name     string            `json:"name"`
		Template string            `json:"template"`
		Params   map[string]any    `json:"params"`
		Context  string            `json:"context"`
		Locale   string            `json:"locale"`
		Catalog  map[string]string `json:"catalog"`
		Expected string            `json:"expected"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse %s: %v", parityFixture, err)
	}
	if len(cases) == 0 {
		t.Fatal("the parity fixture is empty")
	}
	for _, c := range cases {
		m := Message{Key: c.Template, Params: c.Params, Context: c.Context}
		locale := c.Locale
		if locale == "" {
			locale = "en"
		}
		if got := Format(locale, c.Catalog, m); got != c.Expected {
			t.Errorf("%s: Format(%q, …, %q) = %q, want %q", c.Name, locale, c.Template, got, c.Expected)
		}
		// With no translation in play, English() is the same rendering.
		if c.Catalog == nil && locale == "en" {
			if got := m.English(); got != c.Expected {
				t.Errorf("%s: English() = %q, want %q", c.Name, got, c.Expected)
			}
		}
	}
}

// The wire shape is what serverText() reads: key always, params and context
// only when there are any.
func TestMessageJSON(t *testing.T) {
	for _, c := range []struct {
		m    Message
		want string
	}{
		{New("Close"), `{"key":"Close"}`},
		{New("Model {name} not found", "name", "gpt"), `{"key":"Model {name} not found","params":{"name":"gpt"}}`},
		{NewCtx("verb", "Open"), `{"key":"Open","context":"verb"}`},
	} {
		got, err := json.Marshal(c.m)
		if err != nil {
			t.Fatalf("marshal %+v: %v", c.m, err)
		}
		if string(got) != c.want {
			t.Errorf("json = %s, want %s", got, c.want)
		}
	}
}

// Names and values pair up as slog's do; a broken pair is kept, visibly, and
// does not shift the pairs after it.
func TestNewPairs(t *testing.T) {
	m := New("{a} {b}", "a", 1, 2, "b", "x")
	if m.Params["a"] != 1 || m.Params["b"] != "x" || m.Params[badKey] != 2 {
		t.Fatalf("params = %v", m.Params)
	}
	if m := New("{a}", "a"); m.Params[badKey] != "a" {
		t.Fatalf("a dangling name: params = %v", m.Params)
	}
	if m := New("Close"); m.Params != nil {
		t.Fatalf("no params should leave Params nil, got %v", m.Params)
	}
}

// Go values render as the JS String() of their JSON form would, so a Message
// built in Go reads the same here as in the viewer.
func TestGoValues(t *testing.T) {
	m := New("{i} {u} {f} {s} {e}", "i", int64(-3), "u", uint8(7), "f", float32(0.5), "s", stringer{}, "e", errors.New("boom"))
	if got, want := m.English(), "-3 7 0.5 str boom"; got != want {
		t.Fatalf("English() = %q, want %q", got, want)
	}
	if got := New("{n, plural, one {# file} other {# files}}", "n", 1).English(); got != "1 file" {
		t.Fatalf("an int count: %q", got)
	}
}

// A Message given as another's parameter is translated with it: Format looks
// both up in the catalogue, and English renders both in English.
func TestAMessageParameterIsTranslatedWithItsMessage(t *testing.T) {
	m := New("The {tunnel} link", "tunnel", New("Direct P2P"))
	catalog := map[string]string{"The {tunnel} link": "Le lien {tunnel}", "Direct P2P": "P2P direct"}
	if got, want := Format("fr", catalog, m), "Le lien P2P direct"; got != want {
		t.Fatalf("Format = %q, want %q", got, want)
	}
	if got, want := m.English(), "The Direct P2P link"; got != want {
		t.Fatalf("English() = %q, want %q", got, want)
	}
}

type stringer struct{}

func (stringer) String() string { return "str" }

// An *Error reads as its English, unwraps to its cause, and is found by
// errors.As through a wrap.
func TestError(t *testing.T) {
	cause := errors.New("dial failed")
	err := fmt.Errorf("connect: %w", NewError("Cannot reach {host}", "host", "example.com").Wrap(cause))
	if got := err.Error(); got != "connect: Cannot reach example.com" {
		t.Fatalf("Error() = %q", got)
	}
	var e *Error
	if !errors.As(err, &e) || e.Message.Key != "Cannot reach {host}" {
		t.Fatalf("errors.As did not find the message: %v", err)
	}
	if !errors.Is(err, cause) {
		t.Fatal("the cause does not unwrap")
	}
}
