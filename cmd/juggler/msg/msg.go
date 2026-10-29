//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package msg carries user-facing text out of Go code in a form the UI can
// translate: a Message is the English template — the catalogue key, exactly as
// a t() call in web/sdk/lib/i18n.js names it — plus the values for its
// placeholders, and a client renders it in the viewer's language with
// serverText(). English() renders it here, for logs, errors and clients that
// do not translate; Format renders it from a catalogue.
//
// Templates use the same ICU MessageFormat subset as t(): `{name}`,
// `{n, plural, =0 {…} one {# item} other {# items}}` and
// `{kind, select, a {…} other {…}}`, with apostrophe quoting. The two
// formatters are held together by one fixture both test suites run
// (web/js-tests/fixtures/i18n-format-parity.json).
//
// `scripts/i18n extract` collects the template of every New, NewCtx and
// NewError call into web/i18n/en.json, so the template must be a string
// literal (or a `+` of literals) written at the call — a template held in a
// variable is never extracted, and so never translated.
package msg

import "maps"

// Message is user-facing text: an English template and its parameters. On the
// wire it is {"key": template, "params": {...}, "context": ...}, params and
// context omitted when empty — the argument serverText() takes.
type Message struct {
	// Key is the English template: the catalogue key and the fallback.
	Key string `json:"key"`
	// Params holds the values for the template's placeholders. Values should be
	// JSON scalars (strings, numbers, booleans), since the client receives them
	// as JSON.
	Params map[string]any `json:"params,omitempty"`
	// Context separates identical English with different meanings, as t()'s
	// {context} option does.
	Context string `json:"context,omitempty"`
}

// contextSeparator joins a context to its source in a catalogue key
// (gettext's convention, as messageKey in web/sdk/lib/i18n.js).
const contextSeparator = "\u0004"

// badKey names a parameter value whose key was missing or not a string.
const badKey = "!BADKEY"

// New returns the Message for template, with params given as alternating
// names and values, as log/slog takes them:
//
//	msg.New("Model {name} not found", "name", id)
//
// A name that is not a string, or a value with no name, is stored under
// "!BADKEY" rather than dropped, so the mistake shows.
func New(template string, params ...any) Message {
	return Message{Key: template, Params: pairs(params)}
}

// NewCtx is New for a message with a context, which keeps identical English
// with different meanings ("Open" the verb, "Open" the state) apart in the
// catalogue.
func NewCtx(context, template string, params ...any) Message {
	return Message{Key: template, Params: pairs(params), Context: context}
}

// pairs turns alternating names and values into a params map; nil for none.
func pairs(kv []any) map[string]any {
	if len(kv) == 0 {
		return nil
	}
	out := make(map[string]any, (len(kv)+1)/2)
	for i := 0; i < len(kv); i += 2 {
		name, ok := kv[i].(string)
		if !ok || i+1 == len(kv) {
			// Consume just this element, so the pairs after it stay aligned.
			out[badKey] = kv[i]
			i--
			continue
		}
		out[name] = kv[i+1]
	}
	return out
}

// CatalogKey is the key the message is filed under in a catalogue: the
// template, prefixed by its context when it has one.
func (m Message) CatalogKey() string {
	if m.Context == "" {
		return m.Key
	}
	return m.Context + contextSeparator + m.Key
}

// English renders the message in its source language.
func (m Message) English() string {
	return render(m.Key, m.Params, sourceLocale)
}

// String is English, so a Message prints as its text.
func (m Message) String() string {
	return m.English()
}

// IsZero reports whether the message is empty.
func (m Message) IsZero() bool {
	return m.Key == ""
}

// Format renders m in locale from catalog, the merged catalogue for that
// locale (webui.LoadCatalog's result): the translation filed under
// m.CatalogKey(), or the English when the catalogue has none or the
// translation does not parse — the fallbacks t() makes. locale chooses the
// plural rules and number format; the pseudo-locale en-XA uses English ones.
// Unlike t(), which uses the locale along the fallback chain the translation
// was found in, the plural rules are always locale's.
//
// A parameter that is itself a Message (a name the server knows, such as a
// tunnel mode's title) is formatted the same way first. That is Go's alone:
// serverText() takes only scalars, so such a message is for Go to draw.
func Format(locale string, catalog map[string]string, m Message) string {
	params := m.Params
	cloned := false
	for name, v := range m.Params {
		if inner, ok := v.(Message); ok {
			if !cloned {
				params, cloned = maps.Clone(m.Params), true
			}
			params[name] = Format(locale, catalog, inner)
		}
	}
	if translated, ok := catalog[m.CatalogKey()]; ok && translated != "" {
		if out, ok := renderStrict(translated, params, formatLocale(locale)); ok {
			return out
		}
	}
	return render(m.Key, params, sourceLocale)
}

// Error is an error whose text is a Message. Error() is the English, so it
// logs and wraps like any error; a handler that finds one with errors.As can
// send the Message instead, for the client to show translated.
type Error struct {
	Message Message
	// Err is the underlying cause, if any; Unwrap returns it.
	Err error
}

// NewError returns an *Error for template and params, as New takes them.
func NewError(template string, params ...any) *Error {
	return &Error{Message: New(template, params...)}
}

// Error returns the message in English.
func (e *Error) Error() string {
	return e.Message.English()
}

// Unwrap returns the cause.
func (e *Error) Unwrap() error {
	return e.Err
}

// Wrap returns a copy of e with err as its cause.
func (e *Error) Wrap(err error) *Error {
	return &Error{Message: e.Message, Err: err}
}
