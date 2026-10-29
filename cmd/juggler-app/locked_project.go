//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"strconv"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
)

// lockedWindowTitle and lockedPageTitle title the locked-project window and
// head its page.
var (
	lockedWindowTitle = msg.New("Project locked — Juggler")
	lockedPageTitle   = msg.New("Project locked")
)

// lockedProjectError means another process still holds a project's OS-level
// lock, but its instance metadata cannot be verified as a running Juggler
// server. The desktop app presents this in a stand-in window (stand_in.go)
// instead of silently dropping a restored session.
type lockedProjectError struct {
	project string
	info    *core.InstanceInfo
}

func newLockedProjectError(project string, info *core.InstanceInfo) *lockedProjectError {
	return &lockedProjectError{project: project, info: info}
}

// asLockedProject finds a lockedProjectError anywhere in err's chain, so one
// that picked up context on its way back is still shown as a locked project.
func asLockedProject(err error) (*lockedProjectError, bool) {
	var e *lockedProjectError
	ok := errors.As(err, &e)
	return e, ok
}

func (e *lockedProjectError) Error() string {
	return fmt.Sprintf("project is locked: %s", e.project)
}

// lockedProjectPage renders title and message as a self-contained page for the
// window's URL, for when not even a stand-in's local server could be started.
// There is no server to serve it from, so it travels as a data URL.
func lockedProjectPage(title, message string) string {
	t := html.EscapeString(title)
	doc := `<!doctype html><meta charset="utf-8"><title>` + t + `</title>` +
		`<style>body{margin:0;padding:48px;background:#0d1117;color:#e6edf3;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}` +
		`main{max-width:720px;margin:auto}h1{margin-top:0}pre{white-space:pre-wrap;font:inherit}</style>` +
		`<main><h1>` + t + `</h1><pre>` + html.EscapeString(message) + `</pre></main>`

	// Base64, not percent-encoding. url.QueryEscape encodes for
	// application/x-www-form-urlencoded, where a space is "+" — a rule no
	// browser applies to a data URL, so every space arrives as a literal "+"
	// and takes the doctype, the charset and the CSS down with it. PathEscape
	// gets the spaces right but still leaves "?" unescaped and would let a
	// stray "#" truncate the document at the fragment. Base64 has no such
	// characters to get wrong.
	return "data:text/html;charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}

// adviceMessages is core.ProjectLockedError's Advice as messages, one per
// paragraph: in English, joined by blank lines, they are Advice exactly (the
// terminal prints Advice; the window renders these). The process id and port
// are passed as strings, so no locale groups their digits.
func (e *lockedProjectError) adviceMessages() []msg.Message {
	locked := &core.ProjectLockedError{Project: e.project, Info: e.info}
	out := []msg.Message{msg.New("This project is locked by another process, but Juggler could not connect to the session that holds it.\n\n"+
		"The lock file is:\n{path}\n\n"+
		"This usually clears by itself within a few seconds, while the previous session finishes shutting down — try again first. "+
		"If it persists, and you are sure no other Juggler process is running for this project, delete that file and start again.",
		"path", locked.LockPath())}
	if e.info != nil {
		out = append(out, msg.New("The lock recorded Juggler process {pid} at {host}:{port}, but it did not respond as this project.",
			"pid", strconv.Itoa(e.info.PID), "host", e.info.Host, "port", strconv.Itoa(e.info.Port)))
	}
	return out
}
