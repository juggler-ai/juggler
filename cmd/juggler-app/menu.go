//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"runtime"

	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// menuNode is one entry of the native menu, described as data so every label
// is a message: rendered in the UI language as the menu is built, and again
// whenever that changes (relabelMenus).
//
// A node with a role is a Wails role item. Wails labels those in English, so
// the node's label replaces it; for a role that is a submenu (Edit, Window,
// Services, Speech), children are the role's own items in Wails' order,
// separators skipped, and relabel them by position. A node without a role and
// with children is a submenu built here; one with neither is an item.
type menuNode struct {
	label     msg.Message
	role      application.Role
	accel     string
	onClick   func(*application.Context)
	separator bool
	children  []menuNode
}

// menuSeparator is a separator line.
var menuSeparator = menuNode{separator: true}

// installAppMenu builds the native application menu. Session ▸ Open… asks the
// focused window's page for the sessions page, where a project is opened or
// another computer's server connected to; Session ▸ New Conversation creates a
// conversation in the focused window (mirrors the in-app Cmd+N shortcut);
// Session ▸ New Window opens another in-process window (no project → picker);
// View carries dev-only reload/devtools plus Toggle Full Screen; Help ▸ Learn
// More opens the browser.
func installAppMenu(a *appState, devMode bool) {
	// Linux renders the application menu as a GtkMenuBar embedded at the top of
	// the window (Wails prepends it into the window's vbox), which looks wrong
	// against our custom header. macOS shows it as the global top-of-screen menu
	// bar (correct) and the frameless Windows window doesn't display it at all,
	// so only Linux needs suppressing. The Linux window builds its menu bar
	// solely from globalApplication.applicationMenu, and the default-menu
	// fallback is darwin-only — so by never calling Menu.Set here, applicationMenu
	// stays nil and the window attaches no menu bar at all.
	//
	// So macOS is the one platform where these labels are seen, and the one
	// whose relabelling matters.
	if runtime.GOOS == "linux" {
		return
	}
	menu := application.NewMenu()
	a.menuBar = menu
	buildAppMenu(a, menu)
	for _, n := range menuSpec(a, devMode, runtime.GOOS) {
		a.addMenuNode(menu, n)
	}
	a.app.Menu.Set(menu)
}

// menuSpec is the menu after the application menu (buildAppMenu), for goos.
func menuSpec(a *appState, devMode bool, goos string) []menuNode {
	exec := func(script string) func(*application.Context) {
		return func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS(script)
			}
		}
	}
	dispatch := func(event string) func(*application.Context) {
		return exec("window.dispatchEvent(new CustomEvent('" + event + "'))")
	}

	session := menuNode{label: msg.New("Session"), children: []menuNode{
		{label: msg.New("Open or connect to a new session..."), accel: "CmdOrCtrl+o", onClick: dispatch("juggler:open-project")},
		// New Conversation owns Cmd+N (the browser new-tab key most people reach for) and
		// creates a conversation in the focused window by dispatching the same
		// event the in-app Cmd+N shortcut fires. The native menu accelerator
		// preempts the webview keydown, so this is the only path Cmd+N takes here
		// — no double trigger. It is also the only path Cmd+N has anywhere: a
		// browser reserves that chord for its own New window and never delivers
		// it to the page, which is why the frontend binds Alt+N as an alias (see
		// key-shortcut-manager.js).
		{label: msg.New("New Conversation"), accel: "CmdOrCtrl+n", onClick: exec("document.dispatchEvent(new CustomEvent('juggler:new-conversation'))")},
		// New Window moves to the Shift variant so it stops shadowing New
		// Conversation's Cmd+N. Like New Conversation, it dispatches into the focused window's page rather
		// than opening the window here: the page's own newWindow() carries THIS
		// window's live theme and font size to the child (see
		// header-controls.js). Opening it in Go could only pass the global
		// last-used values, not the source window's — which is what made a new
		// window adopt the last-active appearance instead of the one it was
		// launched from.
		{label: msg.New("New Window"), accel: "CmdOrCtrl+Shift+n", onClick: dispatch("juggler:new-window")},
		menuSeparator,
		{label: msg.NewCtx("menu", "Close"), role: application.CloseWindow},
	}}

	// The Edit menu is macOS-only. There the role items are native selectors
	// and the menu is how WKWebView gets its editing keys at all. On Windows
	// the menu is never displayed, yet Wails still turns each accelerator into
	// a global key binding that runs its own JS edit command while WebView2
	// handles the same key natively — so Ctrl+V pasted twice and Backspace,
	// Ctrl+Z and the rest acted twice. WebView2 needs no help with them.
	var edit []menuNode
	if goos == "darwin" {
		edit = []menuNode{
			{label: msg.New("Undo"), role: application.Undo},
			{label: msg.New("Redo"), role: application.Redo},
			{label: msg.New("Cut"), role: application.Cut},
			{label: msg.New("Copy"), role: application.Copy},
			{label: msg.New("Paste"), role: application.Paste},
			{label: msg.New("Paste and Match Style"), role: application.PasteAndMatchStyle},
			{label: msg.New("Delete"), role: application.Delete},
			{label: msg.New("Select All"), role: application.SelectAll},
			{label: msg.New("Speech"), role: application.SpeechMenu, children: []menuNode{
				{label: msg.New("Start Speaking"), role: application.StartSpeaking},
				{label: msg.New("Stop Speaking"), role: application.StopSpeaking},
			}},
		}
	}

	// Font-size zoom (mirrors the header bar's −/+ buttons), not the webview's
	// own page zoom — that breaks the fixed layout. The page also handles the
	// Cmd +/− keypresses directly for browser tabs that have no native menu.
	view := []menuNode{
		{label: msg.New("Zoom In"), accel: "CmdOrCtrl+plus", onClick: dispatch("juggler:zoom-in")},
		{label: msg.New("Zoom Out"), accel: "CmdOrCtrl+-", onClick: dispatch("juggler:zoom-out")},
		menuSeparator,
	}
	if devMode {
		view = append(view,
			menuNode{label: msg.New("Reload"), role: application.Reload},
			menuNode{label: msg.New("Force Reload"), role: application.ForceReload},
			menuNode{label: msg.New("Open Developer Tools"), role: application.OpenDevTools},
			menuSeparator)
	}
	view = append(view, menuNode{label: msg.New("Toggle Full Screen"), role: application.ToggleFullscreen})

	window := []menuNode{
		{label: msg.New("Minimize"), role: application.Minimise},
		{label: msg.NewCtx("window menu", "Zoom"), role: application.Zoom},
	}
	if goos == "darwin" {
		window = append(window, menuNode{label: msg.New("Bring All to Front"), role: application.Front})
	} else {
		window = append(window, menuNode{label: msg.NewCtx("menu", "Close"), role: application.CloseWindow})
	}

	spec := []menuNode{session}
	if edit != nil {
		spec = append(spec, menuNode{label: msg.New("Edit"), role: application.EditMenu, children: edit})
	}
	return append(spec,
		menuNode{label: msg.New("View"), children: view},
		// The Window role, not a submenu of our own: it is what has macOS list the
		// open windows in it.
		menuNode{label: msg.New("Window"), role: application.WindowMenu, children: window},
		menuNode{label: msg.New("Help"), children: []menuNode{
			{label: msg.New("Learn More"), onClick: func(_ *application.Context) {
				if err := openInBrowser("https://juggler.studio"); err != nil {
					logf("open Learn More failed: %v", err)
				}
			}},
		}},
	)
}

// appMenuNode is the macOS application menu. It mirrors Wails' AppMenu role
// (About, Services, Hide/HideOthers/UnHide, Quit) rather than using it, for the
// one difference aboutItem makes; afterAbout is placed right after About. The
// Services role keeps its native submenu injection — macOS fills that submenu
// with other applications' services itself, so only its title is ours to
// translate.
func appMenuNode(a *appState, afterAbout ...menuNode) menuNode {
	items := []menuNode{aboutItem(a)}
	items = append(items, afterAbout...)
	items = append(items,
		menuSeparator,
		menuNode{label: msg.New("Services"), role: application.ServicesMenu},
		menuSeparator,
		menuNode{label: msg.New("Hide Juggler"), role: application.Hide},
		menuNode{label: msg.New("Hide Others"), role: application.HideOthers},
		menuNode{label: msg.New("Show All"), role: application.UnHide},
		menuSeparator,
		menuNode{label: msg.New("Quit Juggler"), role: application.Quit},
	)
	// macOS treats the first submenu as the app menu whatever its label.
	return menuNode{label: msg.New("Juggler"), children: items}
}

// aboutItem is "About Juggler". It opens the page's own about box (the one the
// header logo opens) instead of Wails' About role, whose handler puts up the
// platform's stock about panel in a separate window — a second, plainer about
// box for an app that already has one.
func aboutItem(a *appState) menuNode {
	return menuNode{label: msg.New("About Juggler"), onClick: func(_ *application.Context) {
		if win := a.app.Window.Current(); win != nil {
			win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-about'))")
		}
	}}
}

// addMenuNode appends n to menu, labelled in the UI language, and records each
// label so relabelMenus can re-render it.
func (a *appState) addMenuNode(menu *application.Menu, n menuNode) {
	switch {
	case n.separator:
		menu.AddSeparator()
	case n.role != application.NoRole:
		before := menuLen(menu)
		menu.AddRole(n.role)
		if menuLen(menu) == before {
			return // a role this build leaves out, such as dev tools in production
		}
		a.labelRoleItem(menu.ItemAt(before), n)
	case n.children != nil:
		sub := menu.AddSubmenu(a.tr(n.label))
		a.trackLabel(menu.ItemAt(menuLen(menu)-1), n.label)
		for _, c := range n.children {
			a.addMenuNode(sub, c)
		}
	default:
		item := menu.Add(a.tr(n.label))
		a.trackLabel(item, n.label)
		if n.accel != "" {
			item.SetAccelerator(n.accel)
		}
		if n.onClick != nil {
			item.OnClick(n.onClick)
		}
	}
}

// labelRoleItem gives a Wails role item, and the items of a role submenu, the
// labels n describes. SetLabel leaves the role's accelerator and action alone.
func (a *appState) labelRoleItem(item *application.MenuItem, n menuNode) {
	item.SetLabel(a.tr(n.label))
	a.trackLabel(item, n.label)
	sub := item.GetSubmenu()
	if sub == nil {
		return
	}
	i := 0
	for _, c := range n.children {
		for sub.ItemAt(i) != nil && sub.ItemAt(i).IsSeparator() {
			i++
		}
		child := sub.ItemAt(i)
		if child == nil {
			return
		}
		a.labelRoleItem(child, c)
		i++
	}
}

// trackLabel records that item's label renders m.
func (a *appState) trackLabel(item *application.MenuItem, m msg.Message) {
	if item != nil {
		a.menuLabels = append(a.menuLabels, menuLabel{item: item, label: m})
	}
}

// menuLen counts menu's items; Wails exposes them only by index.
func menuLen(menu *application.Menu) int {
	n := 0
	for menu.ItemAt(n) != nil {
		n++
	}
	return n
}
