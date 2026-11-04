//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/url"
	"runtime"
	"strings"

	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// A window is moved by its page's header bar — on macOS too, whose title bar is
// transparent and lets the page's header be the place to drag — and a
// frameless one (Windows, Linux) is minimised, maximised and closed by it as
// well. So a page that is not Juggler's — a server's plain 404, a proxy's
// error page, a link followed out of a session, the webview's own "can't reach
// this page" — leaves the window with no way to do some or all of that.
//
// After every page load the window is handed a script (offerForeignPageBar)
// that looks for the header's <window-caption-controls>, which every page the
// app shows a window has. Where there is none, it lays a fallback bar over the
// top of the page: dragging it moves the window, and its buttons go back to
// Juggler and, where the window has no native ones (platformFrameless),
// minimise, maximise and close. On macOS it leaves the traffic lights their
// gutter, as the header does. It runs through ExecJS and talks back
// through the webview's message bridge (window._wails.invoke, which the Wails
// runtime puts in every page), so no page's Content-Security-Policy can stop
// either. The page is left as it is beneath, so one worth having — a sign-in
// page in front of a server — can still be used.
//
// Each offer carries a fresh token, and only the bar holding the window's
// latest one is answered: a frame inside one of Juggler's own pages (a pinned
// HTML file's) sees the bridge too, but never a token, so it cannot press the
// buttons. A page that forged one would only move or close its own window.

var (
	foreignPageLabel = msg.New("This page isn't part of Juggler")
	foreignPageBack  = msg.New("Back to Juggler")
	foreignMinimise  = msg.New("Minimise")
	foreignMaximise  = msg.New("Maximise")
	foreignRestore   = msg.New("Restore")
	foreignClose     = msg.New("Close")
)

// foreignPagePrefix starts each message a fallback bar sends, followed by a
// foreignPageMessage as JSON.
const foreignPagePrefix = "juggler:foreign-page:"

// foreignPageMessage is a fallback bar's button press: the token its offer
// carried, the button, and the page it lies over.
type foreignPageMessage struct {
	Token  string `json:"token"`
	Action string `json:"action"`
	URL    string `json:"url"`
}

// pageLoadedEvent is the window event Wails emits as each page finishes
// loading — after it has put its runtime's bridge in the page.
func pageLoadedEvent() (events.WindowEventType, bool) {
	switch runtime.GOOS {
	case "windows":
		return events.Windows.WebViewNavigationCompleted, true
	case "linux":
		return events.Linux.WindowLoadFinished, true
	case "darwin":
		return events.Mac.WebViewDidFinishNavigation, true
	}
	return 0, false
}

// offerForeignPageBar hands e's newly loaded page the fallback bar's script,
// under a token minted for this load.
func (a *appState) offerForeignPageBar(e *winEntry) {
	token := mintControlSecret()
	current := false
	a.reg(func(st *regState) {
		if st.windows[e.id] == e {
			e.foreignToken, current = token, true
		}
	})
	if !current || e.win == nil {
		return
	}
	look := foreignBarLook{
		theme:      a.chromeTheme(e),
		fullscreen: e.win.IsFullscreen(),
		maximised:  e.win.IsMaximised(),
	}
	e.win.ExecJS(a.foreignPageScript(token, e.role == roleMain, platformFrameless, look))
}

// foreignBarLook is how the window the bar is laid over looks as its page
// loads: the theme its last Juggler page reported, and whether it is
// fullscreen (no traffic lights to leave room for) or maximised (the
// maximise button shows Restore). The bar takes it as it was; a change while
// the page is up is not followed, beyond the bar's own maximise button.
type foreignBarLook struct {
	theme                 string
	fullscreen, maximised bool
}

// foreignBarConfig is everything the bar's script is given, as JSON.
type foreignBarConfig struct {
	Token      string            `json:"token"`
	Prefix     string            `json:"prefix"`
	CanGoBack  bool              `json:"canGoBack"`
	Frameless  bool              `json:"frameless"`
	Fullscreen bool              `json:"fullscreen"`
	Maximised  bool              `json:"maximised"`
	Labels     map[string]string `json:"labels"`
	// The web UI's chrome (window_chrome_tokens.go): its geometry and close
	// colours, the theme's colours, and the caption glyphs.
	Gutter      string            `json:"gutter"`
	Strip       string            `json:"strip"`
	CloseHover  string            `json:"closeHover"`
	CloseActive string            `json:"closeActive"`
	Colours     chromeThemeTokens `json:"colours"`
	Glyphs      json.RawMessage   `json:"glyphs"`
}

// foreignPageScript is the fallback bar's script for one page load, holding
// token. A board has no Back to Juggler: what it shows is its opener's to
// decide, and its close takes it back there. frameless is whether the bar
// carries the window's minimise, maximise and close, which a window with a
// frame has natively.
func (a *appState) foreignPageScript(token string, canGoBack, frameless bool, look foreignBarLook) string {
	colours, ok := windowChrome.Themes[look.theme]
	if !ok {
		colours = windowChrome.Themes["dark"]
	}
	cfg, _ := json.Marshal(foreignBarConfig{
		Token:      token,
		Prefix:     foreignPagePrefix,
		CanGoBack:  canGoBack,
		Frameless:  frameless,
		Fullscreen: look.fullscreen,
		Maximised:  look.maximised,
		Labels: map[string]string{
			"page":     a.tr(foreignPageLabel),
			"back":     a.tr(foreignPageBack),
			"minimise": a.tr(foreignMinimise),
			"maximise": a.tr(foreignMaximise),
			"restore":  a.tr(foreignRestore),
			"close":    a.tr(foreignClose),
		},
		Gutter:      windowChrome.Gutter,
		Strip:       windowChrome.Strip,
		CloseHover:  windowChrome.CloseHover,
		CloseActive: windowChrome.CloseActive,
		Colours:     colours,
		Glyphs:      windowChrome.Glyphs,
	})
	return fmt.Sprintf(foreignPageScriptTemplate, cfg)
}

// foreignPageScriptTemplate takes a foreignBarConfig. It builds the bar with
// the DOM and CSSOM alone — no markup, no style sheet — which a page's CSP or
// Trusted Types cannot refuse, inside a closed shadow root the page's own CSS
// cannot reach. It wears the header's chrome as window-chrome.css draws it:
// the theme's colours, the caption buttons' glyphs and close red, the macOS
// traffic-light gutter (none in fullscreen, none on a frameless window), and
// the strip along the top edge left to the OS's resize zone, which does not
// drag the window.
const foreignPageScriptTemplate = `(function (bar) {
  if (window.top !== window || document.querySelector("window-caption-controls")) return;
  var c = bar.colours;
  var send = function (m) {
    if (window._wails && window._wails.invoke) window._wails.invoke(m);
    else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(m);
    else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.external) window.webkit.messageHandlers.external.postMessage(m);
  };
  var press = function (action) {
    send(bar.prefix + JSON.stringify({ token: bar.token, action: action, url: location.href }));
  };
  var NS = "http://www.w3.org/2000/svg";
  var setAll = function (el, attrs) {
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  };
  var glyph = function (name) {
    var svg = document.createElementNS(NS, "svg");
    setAll(svg, bar.glyphs.svg);
    setAll(svg, { "aria-hidden": "true", focusable: "false", width: "10", height: "10" });
    bar.glyphs[name].forEach(function (part) {
      var el = document.createElementNS(NS, part[0]);
      setAll(el, part[1]);
      svg.appendChild(el);
    });
    return svg;
  };
  var old = document.getElementById("__juggler-foreign-page-bar");
  if (old) old.remove();
  var host = document.createElement("div");
  host.id = "__juggler-foreign-page-bar";
  var root = host.attachShadow({ mode: "closed" });
  var strip = parseFloat(bar.strip) || 0;
  var gutter = !bar.frameless && !bar.fullscreen;
  var el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed", top: "0", left: "0", right: "0", height: "32px", zIndex: "2147483647",
    display: "flex", alignItems: "stretch", boxSizing: "border-box",
    paddingLeft: gutter ? bar.gutter : "12px",
    background: c.bg, color: c.text, borderBottom: "1px solid " + c.border,
    font: "12px/32px system-ui, sans-serif", userSelect: "none", cursor: "default"
  });
  var text = document.createElement("span");
  text.textContent = bar.labels.page + (location.host ? " \u2014 " + location.host : "");
  Object.assign(text.style, { flex: "1", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" });
  el.appendChild(text);
  var button = function (content, title, action, close) {
    var b = document.createElement("button");
    b.type = "button";
    if (typeof content === "string") b.textContent = content; else b.appendChild(content);
    b.title = title;
    b.setAttribute("aria-label", title);
    Object.assign(b.style, {
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "0", margin: "0", padding: "0 14px", minWidth: "46px", background: "transparent",
      color: c.textSecondary, font: "inherit", cursor: "default"
    });
    var rest = function () { b.style.background = "transparent"; b.style.color = c.textSecondary; };
    b.addEventListener("mouseenter", function () {
      b.style.background = close ? bar.closeHover : c.raised;
      b.style.color = close ? c.onAccent : c.text;
    });
    b.addEventListener("mouseleave", rest);
    b.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      b.style.background = close ? bar.closeActive : c.border;
    });
    b.addEventListener("mouseup", function () { b.style.background = close ? bar.closeHover : c.raised; });
    b.addEventListener("dblclick", function (e) { e.stopPropagation(); });
    b.addEventListener("click", function (e) { e.stopPropagation(); press(action); });
    return b;
  };
  var maximised = bar.maximised;
  var maxButton;
  var showMaximised = function () {
    if (!maxButton) return;
    var label = maximised ? bar.labels.restore : bar.labels.maximise;
    maxButton.replaceChildren(glyph(maximised ? "restore" : "maximise"));
    maxButton.title = label;
    maxButton.setAttribute("aria-label", label);
  };
  if (bar.canGoBack) el.appendChild(button(bar.labels.back, bar.labels.back, "back", false));
  if (bar.frameless) {
    el.appendChild(button(glyph("minimise"), bar.labels.minimise, "minimise", false));
    maxButton = button(glyph("maximise"), bar.labels.maximise, "maximise", false);
    maxButton.addEventListener("click", function () { maximised = !maximised; showMaximised(); });
    el.appendChild(maxButton);
    el.appendChild(button(glyph("close"), bar.labels.close, "close", true));
    showMaximised();
  }
  el.addEventListener("mousedown", function (e) {
    if (e.button === 0 && e.clientY >= strip) send("wails:drag");
  });
  el.addEventListener("dblclick", function (e) {
    if (e.clientY < strip) return;
    send("wails:drag:doubleclick");
    maximised = !maximised;
    showMaximised();
  });
  root.appendChild(el);
  (document.body || document.documentElement).appendChild(host);
})(%s);`

// handleRawMessage is the app's Wails RawMessageHandler: every message a page
// sends through the bridge that is not Wails' own. The only ones it answers
// are a fallback bar's.
func (a *appState) handleRawMessage(window application.Window, message string, _ *application.OriginInfo) {
	body, ok := strings.CutPrefix(message, foreignPagePrefix)
	if !ok || window == nil {
		return
	}
	var m foreignPageMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		return
	}
	var e *winEntry
	id := window.ID()
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if w.win != nil && w.win.ID() == id {
				e = w
			}
		}
	})
	if e != nil {
		a.foreignPageAction(e, m)
	}
}

// foreignPageAction carries out a fallback bar's button press on e, if the bar
// holds e's latest token, and reports whether it did.
func (a *appState) foreignPageAction(e *winEntry, m foreignPageMessage) bool {
	switch m.Action {
	case "back", "minimise", "maximise", "close":
	default:
		return false
	}
	if m.Action == "back" && e.role != roleMain {
		return false
	}
	valid := false
	var v windowView
	a.reg(func(st *regState) {
		if st.windows[e.id] != e || e.foreignToken == "" ||
			subtle.ConstantTimeCompare([]byte(m.Token), []byte(e.foreignToken)) != 1 {
			return
		}
		valid, v = true, e.view
		if m.Action == "close" {
			// The page beneath is not Juggler's: it has no drafts to rescue
			// and would never answer the close gate.
			e.settled = true
		}
	})
	if !valid {
		return false
	}
	switch m.Action {
	case "back":
		a.foreignPageBack(e, v, m.URL)
	case "minimise":
		onNativeWindow(e, func(win *application.WebviewWindow) { win.Minimise() })
	case "maximise":
		onNativeWindow(e, func(win *application.WebviewWindow) { win.ToggleMaximise() })
	case "close":
		onNativeWindow(e, func(win *application.WebviewWindow) { win.Close() })
	}
	return true
}

// foreignPageBack is Back to Juggler: the page the window was showing,
// loaded again — unless that page is the foreign one, which loading again
// would only show again. Then it is the server's own page for a server by URL,
// and another attempt at the project's session on this machine.
func (a *appState) foreignPageBack(e *winEntry, v windowView, pageURL string) {
	switch {
	case v.standIn == nil && v.serverURL != "" && !samePage(pageURL, v.serverURL):
		a.showView(e, showing(v), v, windowOpts{})
	case v.spec.isURL():
		spec := v.spec
		spec.remoteProject = ""
		a.showView(e, showing(v), a.framedPageView(spec, originOf(spec.url), true), windowOpts{})
	default:
		a.retarget(e, showing(v), v.spec, windowOpts{})
	}
}

// samePage reports whether two URLs name one page, whatever their queries and
// fragments, and a trailing slash. One that does not parse is taken to be the
// same, so a doubt never reloads a page into itself.
func samePage(a, b string) bool {
	ua, errA := url.Parse(a)
	ub, errB := url.Parse(b)
	if errA != nil || errB != nil {
		return true
	}
	return strings.EqualFold(ua.Scheme, ub.Scheme) && strings.EqualFold(ua.Host, ub.Host) &&
		strings.TrimSuffix(ua.Path, "/") == strings.TrimSuffix(ub.Path, "/")
}

// originOf is a server URL's scheme and host, where the server's own page is:
// the server a --url with a path to something gone still names.
func originOf(serverURL string) string {
	u, err := url.Parse(serverURL)
	if err != nil || u.Host == "" {
		return serverURL
	}
	return u.Scheme + "://" + u.Host
}

// onNativeWindow runs do on e's native window on the main thread, if it has one.
func onNativeWindow(e *winEntry, do func(*application.WebviewWindow)) {
	if win := e.win; win != nil {
		application.InvokeAsync(func() { do(win) })
	}
}
