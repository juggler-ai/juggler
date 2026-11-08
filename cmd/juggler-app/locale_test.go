//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// pseudoApp is an appState speaking the pseudo-locale, from the generated
// web/i18n/en-XA.json — so any shell text that is not a message (or whose
// message the extract never collected) still reads as English.
func pseudoApp(t *testing.T) *appState {
	t.Helper()
	data, err := os.ReadFile("../../web/i18n/en-XA.json")
	if err != nil {
		t.Fatalf("read en-XA catalogue: %v", err)
	}
	var catalog map[string]string
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatalf("parse en-XA catalogue: %v", err)
	}
	a := &appState{}
	a.locale.Store(&appLocale{locale: "en-XA", catalog: catalog})
	return a
}

var placeholderPattern = regexp.MustCompile(`\{[A-Za-z0-9_]+\}`)
var asciiLetter = regexp.MustCompile(`[A-Za-z]`)

// isPseudoLocalized is isPseudoLocalized in web/sdk/lib/i18n.js: bracketed,
// padded, and no ASCII letter left outside the data it was given.
func isPseudoLocalized(text string, data ...string) bool {
	s := strings.TrimSpace(text)
	if !strings.HasPrefix(s, "[") || !strings.HasSuffix(s, "]") || !strings.Contains(s, "·") {
		return false
	}
	for _, d := range data {
		s = strings.ReplaceAll(s, d, "")
	}
	return !asciiLetter.MatchString(placeholderPattern.ReplaceAllString(s, ""))
}

// menuLabels flattens a menu spec into its labels, rendered by a, with the
// path to each so a failure names the item.
func menuLabels(a *appState, nodes []menuNode, path string) map[string]string {
	out := map[string]string{}
	for _, n := range nodes {
		if n.separator {
			continue
		}
		p := path + "/" + n.label.English()
		out[p] = a.tr(n.label)
		for k, v := range menuLabels(a, n.children, p) {
			out[k] = v
		}
	}
	return out
}

// TestMenuSpeaksTheUILanguage renders every native menu label — the items the
// app makes and the Wails role items it relabels — on every platform that has
// a menu, under the pseudo-locale.
func TestMenuSpeaksTheUILanguage(t *testing.T) {
	a := pseudoApp(t)
	for _, goos := range []string{"darwin", "windows"} {
		for _, dev := range []bool{false, true} {
			nodes := append([]menuNode{appMenuNode(a)}, menuSpec(a, dev, goos)...)
			labels := menuLabels(a, nodes, goos)
			if len(labels) < 20 {
				t.Fatalf("%s dev=%v: only %d labels in the menu spec", goos, dev, len(labels))
			}
			for path, label := range labels {
				if !isPseudoLocalized(label) {
					t.Errorf("%s dev=%v: %s is %q, not translated", goos, dev, path, label)
				}
			}
		}
	}
}

// TestDialogsSpeakTheUILanguage covers the native dialogs, the chooser's
// default title, window titles and the stand-in pages.
func TestDialogsSpeakTheUILanguage(t *testing.T) {
	a := pseudoApp(t)
	texts := map[string]string{
		"quit title":       a.tr(quitDialogTitle),
		"quit confirm":     a.tr(quitDialogConfirm),
		"keep working":     a.tr(keepWorkingLabel),
		"window title":     a.tr(appWindowTitle),
		"mismatch title":   a.tr(mismatchWindowTitle),
		"mismatch heading": a.tr(mismatchPageTitle),
		"restart server":   a.tr(restartServerLabel),
		"lost heading":     a.tr(lostPageTitle),
		"picker title":     a.tr(defaultPickerTitle),
		"remote refusal":   a.tr(remoteWindowRefusal),
		"quitting, one":    a.tr(quitBusyMessage(1)),
		"quitting, two":    a.tr(quitBusyMessage(2)),
		"restarting, one":  a.tr(restartBusyMessage(1)),
		"restarting, two":  a.tr(restartBusyMessage(3)),
	}
	for name, text := range texts {
		// The counts are data, so they are digits here.
		if !isPseudoLocalized(text) {
			t.Errorf("%s is %q, not translated", name, text)
		}
	}

	mismatch := mismatchStandIn(&versionMismatchError{app: core.Version, server: "7.8.9", occ: machineserver.Occupancy{
		Sessions: []machineserver.Session{{Project: "/7/8"}}, Clients: 1, LAN: true, Tunnel: "p2p", HandStarted: true,
		// A catalogued message stands in for the mode's title, which the
		// server sends.
		TunnelTitle: &restartServerLabel,
	}})
	for i, m := range mismatch.message {
		if text := a.tr(m); !isPseudoLocalized(text, "7.8.9", "/7/8", core.Version) {
			t.Errorf("mismatch paragraph %d is %q, not translated", i, text)
		}
	}
}

// TestControlLocaleAdoptsTheServersCatalogue: the page's report of its
// language makes the shell fetch that window's server's catalogue and speak it.
func TestControlLocaleAdoptsTheServersCatalogue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/i18n/catalog" || r.URL.Query().Get("locale") != "fr" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"locale": "fr", "messages": map[string]string{"Keep working": "Continuer"}})
	}))
	defer srv.Close()

	a := &appState{}
	a.adoptLocale(srv.URL, "fr")
	if got := a.tr(keepWorkingLabel); got != "Continuer" {
		t.Fatalf("after adopting fr, %q", got)
	}
	// English needs no catalogue, and a server that cannot answer leaves the
	// language as it was.
	a.adoptLocale(srv.URL+"/nowhere", "de")
	if got := a.tr(keepWorkingLabel); got != "Continuer" {
		t.Fatalf("a failed fetch changed the language: %q", got)
	}
	a.adoptLocale("", "")
	if got := a.tr(keepWorkingLabel); got != "Keep working" {
		t.Fatalf("the default language is not English: %q", got)
	}
}

// TestAdoptLocaleBeforeLaunchLeavesTheMenus: the startup language is adopted
// before the app has launched, when there is no main thread to relabel the
// menus on, so it must not try.
func TestAdoptLocaleBeforeLaunchLeavesTheMenus(t *testing.T) {
	a := &appState{app: &application.App{}, menuBar: application.NewMenu()}
	a.adoptLocale("", "")
	if got := a.tr(keepWorkingLabel); got != "Keep working" {
		t.Fatalf("the startup language was not adopted: %q", got)
	}
}
