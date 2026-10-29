//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestLockedProjectPageSurvivesItsOwnEncoding is the regression test for a
// window that rendered every space in the document as a "+".
//
// url.QueryEscape encodes for application/x-www-form-urlencoded, where a space
// becomes "+". A data: URL is only ever percent-decoded, so that "+" is never
// turned back into a space — and it corrupted not just the message but the
// markup carrying it: the doctype, the charset declaration and the one CSS
// declaration containing a space all arrived broken.
func TestLockedProjectPageSurvivesItsOwnEncoding(t *testing.T) {
	const message = "This project is locked by another process."

	page := lockedProjectPage("Project locked", message)
	doc, err := decodeDataURL(page)
	if err != nil {
		t.Fatalf("the window URL is not a decodable data URL: %v", err)
	}

	for _, want := range []string{
		"<!doctype html>",
		`<meta charset="utf-8">`,
		"font:16px -apple-system",
		message,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("decoded page missing %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, "+") {
		t.Errorf("decoded page still contains a literal '+' where a space belongs:\n%s", doc)
	}
}

// decodeDataURL decodes a data: URL the way a webview would: split on the first
// comma, then percent-decode (or base64-decode) the payload. Notably it does
// NOT apply the form-urlencoded plus-to-space rule, because no browser does.
func decodeDataURL(page string) (string, error) {
	_, payload, found := strings.Cut(page, ",")
	if !found {
		return "", fmt.Errorf("no comma separating the data URL header from its payload")
	}
	if strings.Contains(page[:len(page)-len(payload)], ";base64") {
		decoded, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	}
	return url.PathUnescape(payload)
}

func TestLockedProjectErrorExplainsSafeRecovery(t *testing.T) {
	project := t.TempDir()
	err := newLockedProjectError(project, &core.InstanceInfo{PID: 123, Host: "127.0.0.1", Port: 7777})
	message := (&appState{}).trParagraphs(err.adviceMessages())
	for _, want := range []string{
		"could not connect",
		filepath.Join(project, ".juggler", "juggler.lock"),
		"no other Juggler process",
		"delete that file",
		"123",
	} {
		if !strings.Contains(message, want) {
			t.Errorf("recovery message missing %q:\n%s", want, message)
		}
	}
}
