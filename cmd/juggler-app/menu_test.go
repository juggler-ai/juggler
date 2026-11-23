//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// editRoles are the Wails roles whose accelerators are the webview's own
// editing keys (Ctrl+Z/Y/X/C/V/A, Backspace).
var editRoles = map[application.Role]bool{
	application.EditMenu: true, application.Undo: true, application.Redo: true,
	application.Cut: true, application.Copy: true, application.Paste: true,
	application.PasteAndMatchStyle: true, application.Delete: true,
	application.SelectAll: true,
}

func findEditRole(nodes []menuNode) (application.Role, bool) {
	for _, n := range nodes {
		if editRoles[n.role] {
			return n.role, true
		}
		if r, ok := findEditRole(n.children); ok {
			return r, true
		}
	}
	return application.NoRole, false
}

// TestWindowsMenuLeavesEditingKeysToTheWebview: on Windows a menu accelerator
// becomes a global key binding that runs alongside WebView2's own handling of
// the key, so an Edit role there pastes, deletes or undoes twice.
func TestWindowsMenuLeavesEditingKeysToTheWebview(t *testing.T) {
	a := &appState{}
	for _, dev := range []bool{false, true} {
		if r, ok := findEditRole(menuSpec(a, dev, "windows")); ok {
			t.Errorf("dev=%v: the Windows menu has edit role %v", dev, r)
		}
	}
	if _, ok := findEditRole(menuSpec(a, false, "darwin")); !ok {
		t.Error("the macOS menu has no Edit menu")
	}
}

// pageChords are the menu accelerators whose keys the page binds itself
// (key-shortcut-manager.js: new-conversation, new-window, zoom-in, zoom-out).
var pageChords = map[string]bool{
	"CmdOrCtrl+n": true, "CmdOrCtrl+Shift+n": true, "CmdOrCtrl+plus": true, "CmdOrCtrl+-": true,
}

func menuAccels(nodes []menuNode, into map[string]bool) map[string]bool {
	for _, n := range nodes {
		if n.accel != "" {
			into[n.accel] = true
		}
		menuAccels(n.children, into)
	}
	return into
}

// TestWindowsMenuLeavesPageChordsToThePage: for the same reason, a Windows
// menu item carrying a chord the page also binds acts twice — Ctrl+Shift+N
// opened two windows. macOS keeps them: its menu accelerator preempts the
// webview's keydown, and is the only way ⌘N reaches the app at all.
func TestWindowsMenuLeavesPageChordsToThePage(t *testing.T) {
	a := &appState{}
	win := menuAccels(menuSpec(a, false, "windows"), map[string]bool{})
	mac := menuAccels(menuSpec(a, false, "darwin"), map[string]bool{})
	for chord := range pageChords {
		if win[chord] {
			t.Errorf("the Windows menu binds %s, which the page handles too", chord)
		}
		if !mac[chord] {
			t.Errorf("the macOS menu lost %s", chord)
		}
	}
	if !win["CmdOrCtrl+o"] {
		t.Error("the Windows menu lost Ctrl+O, which the page does not bind")
	}
}
