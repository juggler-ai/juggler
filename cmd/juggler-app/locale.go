//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/internal/apipaths"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The native shell — menus, dialogs, window titles, choosers, the locked-project
// page — speaks the UI language the pages do. Its text is msg.New messages
// rendered through tr.
//
// The catalogue comes from a server, GET /api/i18n/catalog, rather than being
// embedded here. A server's catalogue is the one its pages render with: the
// core's messages and every source registered with the server
// (webui.RegisterCatalogFS) — which is how text that is compiled into this
// binary by a packaged build, but whose catalogue lives with that build's
// server, gets translated at all. It also keeps the web tree out of this binary,
// which carries only the window shell its stand-in pages wear (web.Shell); a
// stand-in's page is handed this catalogue too. Until a server has answered,
// the shell speaks English.

// sourceLocale is the language messages are written in (webui.SourceLocale).
const sourceLocale = "en"

// appLocale is the shell's UI language and the catalogue it renders from.
// Replaced whole, never edited, so it is read without a lock.
type appLocale struct {
	locale  string
	catalog map[string]string
}

// tr renders m in the shell's UI language, or in English before one is known.
func (a *appState) tr(m msg.Message) string {
	if a == nil {
		return m.English()
	}
	cur := a.locale.Load()
	if cur == nil {
		return m.English()
	}
	return msg.Format(cur.locale, cur.catalog, m)
}

// startupLocale is the UI language the global settings name, or the source
// language when they name none.
func startupLocale() string {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		logf("i18n: settings read failed, speaking %s: %v", sourceLocale, err)
	}
	return normalizeShellLocale(gs.UILocale)
}

// normalizeShellLocale returns locale's canonical tag, or the source language
// for "" (the default) and anything unusable.
func normalizeShellLocale(locale string) string {
	if l := core.NormalizeUILocale(locale); l != "" {
		return l
	}
	return sourceLocale
}

// adoptLocale makes locale the shell's language, with the catalogue serverURL
// serves for it, and relabels the menus. English needs no catalogue. Nothing
// changes when locale is already the shell's, or when the server cannot answer
// — the shell keeps the language it had rather than dropping to English.
func (a *appState) adoptLocale(serverURL, locale string) {
	locale = normalizeShellLocale(locale)
	if cur := a.locale.Load(); cur != nil && cur.locale == locale {
		return
	}
	var catalog map[string]string
	if locale != sourceLocale {
		var err error
		if catalog, err = fetchUICatalog(serverURL, locale); err != nil {
			logf("i18n: catalogue for %s: %v", locale, err)
			return
		}
	}
	a.locale.Store(&appLocale{locale: locale, catalog: catalog})
	a.relabelMenus()
}

var catalogHTTP = &http.Client{Timeout: 4 * time.Second}

// fetchUICatalog reads serverURL's UI catalogue for locale.
func fetchUICatalog(serverURL, locale string) (map[string]string, error) {
	if serverURL == "" {
		return nil, fmt.Errorf("no server")
	}
	u := strings.TrimRight(serverURL, "/") + apipaths.Prefix + "/i18n/catalog?locale=" + url.QueryEscape(locale)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil) //nolint:gosec // the URL of a server a window views
	if err != nil {
		return nil, err
	}
	resp, err := catalogHTTP.Do(req) //nolint:gosec // the URL of a server a window views
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var body struct {
		Messages map[string]string `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Messages, nil
}

// controlLocale takes the page's report of the UI language it was served in,
// sent once as it loads. A page reloads into a new language, so this is also
// how a change reaches the shell.
func (a *appState) controlLocale(w http.ResponseWriter, r *http.Request, e *winEntry) {
	var serverURL string
	a.reg(func(st *regState) {
		if win := st.windows[e.id]; win != nil {
			serverURL = win.view.serverURL
		}
	})
	go a.adoptLocale(serverURL, r.URL.Query().Get("locale"))
	w.WriteHeader(http.StatusNoContent)
}

// menuLabel is a native menu item and the message its label renders.
type menuLabel struct {
	item  *application.MenuItem
	label msg.Message
}

// relabelMenus re-renders every tracked menu label in the shell's language and
// rebuilds the menu bar, which on macOS is what retitles a top-level menu: the
// bar shows each submenu's NSMenu title, which only a rebuild sets. Before the
// app has launched it does nothing; the launch relabels them instead.
func (a *appState) relabelMenus() {
	if a.app == nil || a.menuBar == nil || !a.launched.Load() {
		return
	}
	application.InvokeAsync(func() {
		for _, l := range a.menuLabels {
			l.item.SetLabel(a.tr(l.label))
		}
		a.menuBar.Update()
	})
}
