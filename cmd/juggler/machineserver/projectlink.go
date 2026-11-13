//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"

	"juggler/internal/jlog"
)

// A project's link, /p/<key>/, is where its session is served, and the address
// stays the project's from one day to the next. A session is not so lasting —
// one with no viewer retires within seconds — and its id, minted afresh at
// every open, is its handle in the control API and no address. The link names
// the project instead: the proxy serves whichever session the project has
// (handleProjectProxy), and while it has none running, the page that opens it
// (serveOpener).
//
// The key is the folder's name, for a person to read, and a hash of its whole
// path, which tells two folders of one name apart and is the same on every
// machine-server start. The path itself stays out of the URL — out of browser
// history, out of a link pasted elsewhere — and so does every folder above the
// project. It hashes the path as resolveProject gives it, the string the
// registry and recents tell projects apart by, so a key matches exactly the
// projects the server already counts as one.

// projectSlugMax caps the readable half of a key.
const projectSlugMax = 40

// projectHashBytes is how much of the path's hash a key carries, as hex.
const projectHashBytes = 4

// projectKey is project's key: <slug of its folder's name>-<8 hex digits>.
func projectKey(project string) string {
	sum := sha256.Sum256([]byte(project))
	return projectSlug(filepath.Base(project)) + "-" + hex.EncodeToString(sum[:projectHashBytes])
}

// projectSlug is name as lowercase ASCII letters and digits, every other run of
// characters one dash, with no dash at either end, at most projectSlugMax long;
// "project" when nothing of name survives.
func projectSlug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
			if b.Len() >= projectSlugMax {
				break
			}
			continue
		}
		dash = true
	}
	if b.Len() == 0 {
		return "project"
	}
	return b.String()
}

// projectLink is the path of project's link on this server.
func projectLink(project string) string {
	return "/p/" + projectKey(project) + "/"
}

// recentForKey is the recent project whose key is key: what a project's link
// opens when the project has no session. It reads the recents from disk, so it
// is asked only on a page load of a link the registry has no session for
// (serveOpener). A project with neither — never opened here, or fallen off the
// recents — has no link that resolves until it is opened again.
func (s *Server) recentForKey(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	for _, p := range s.knownRecents() {
		if projectKey(p) == key {
			return p, true
		}
	}
	return "", false
}

// knownRecents is the machine's recents with gone folders dropped, as the
// sessions page is offered them; none when the server keeps no recents.
func (s *Server) knownRecents() []string {
	if s.recents == nil {
		return nil
	}
	paths, err := s.recents.Prune()
	if err != nil {
		jlog.Error("[machineserver] reading recents: %v", err)
	}
	return paths
}
