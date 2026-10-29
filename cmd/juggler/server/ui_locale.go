//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io/fs"
	"net/http"
	"os"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/webui"
	"juggler/web"
)

// The UI language. The choice is GlobalSettings.UILocale; the translations are
// web/i18n/<locale>.json, one flat object per locale mapping each English
// source string to its translation (the format registerCatalog takes — see
// web/sdk/lib/i18n.js). web/i18n/en.json is the list of source strings that
// translators work from, never a catalogue: English is what every message
// already is.
//
// A viewer is handed its catalogue inline by serveIndex, so the first frame is
// already translated. The engine has no page of its own to read, so it fetches
// the same file through handleUICatalog. The catalogue lookup itself is
// webui.LoadCatalog, shared with the machine server's sessions page.

// uiLocale is the UI language the user chose, or "" for the default. A server
// without a settings store (a bare test server) has none.
func (s *Server) uiLocale() string {
	if s.settings == nil {
		return ""
	}
	return core.NormalizeUILocale(s.settings.get().UILocale)
}

// uiCatalog is the catalogue for locale from the served asset tree (the disk
// tree under --assets-from-disk, so an edited catalogue shows on reload).
func (s *Server) uiCatalog(locale string) map[string]string {
	return webui.LoadCatalog(func(p string) ([]byte, error) { return s.readWebAsset(p, web.Files) }, locale)
}

// uiCatalogResponse is GET /api/i18n/catalog's body.
type uiCatalogResponse struct {
	Locale   string            `json:"locale"`
	Messages map[string]string `json:"messages"`
	// Extensions holds each extension's own catalogue for the locale, by
	// extension id (see ExtensionsAPI.Catalogs); registered by the client under
	// that id as its namespace.
	Extensions map[string]map[string]string `json:"extensions"`
}

// handleUICatalog serves GET /api/i18n/catalog?locale=<tag>: the core
// catalogue — what the page would have been given inline — and every
// extension's. The engine reads both from here; a viewer reads the extensions'
// before loading their code (the core one is already in its page). A locale with
// no catalogue answers an empty one — every message then falls back to English,
// which is the same thing a missing catalogue means anywhere else.
func (s *Server) handleUICatalog(w http.ResponseWriter, r *http.Request) {
	locale := r.URL.Query().Get("locale")
	if !core.IsValidUILocale(locale) {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid UI language"))
		return
	}
	messages := s.uiCatalog(locale)
	if messages == nil {
		messages = map[string]string{}
	}
	extensions := map[string]map[string]string{}
	if s.extensionsAPI != nil {
		extensions = s.extensionsAPI.Catalogs(locale)
	}
	handlers.WriteJSON(w, r, 0, uiCatalogResponse{Locale: locale, Messages: messages, Extensions: extensions})
}

// uiLocales is the UI languages the served asset tree has a catalogue for
// (webui.AvailableLocales): the embedded tree's, and under --assets-from-disk
// the on-disk tree's too, so a catalogue just added shows on reload.
func (s *Server) uiLocales() []string {
	trees := []fs.FS{web.Files}
	if s.assetsFromDisk {
		if staticDir, err := s.findStaticDir(); err == nil {
			trees = append(trees, os.DirFS(staticDir))
		}
	}
	return webui.AvailableLocales(trees...)
}

// uiLocalesResponse is GET /api/i18n/locales's body.
type uiLocalesResponse struct {
	// Locales are BCP 47 tags, sorted; never null.
	Locales []string `json:"locales"`
}

// handleUILocales serves GET /api/i18n/locales: the UI languages there is a
// catalogue for, which the Language picker in Settings → Appearance offers
// beside English. Adding web/i18n/<tag>.json adds the language; nothing else
// lists them.
func (s *Server) handleUILocales(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, uiLocalesResponse{Locales: s.uiLocales()})
}
