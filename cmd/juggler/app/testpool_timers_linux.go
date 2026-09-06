//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux && !production && !gtk3

package app

/*
#cgo linux pkg-config: gtk4 webkitgtk-6.0

#include <gtk/gtk.h>
#include <webkit/webkit.h>

// WebKitGTK snaps a hidden page's DOM timer due times to a 1s grid, exactly as
// the Cocoa port does: HiddenPageDOMTimerThrottlingEnabled defaults to true for
// PLATFORM(COCOA) || PLATFORM(GTK), and a timer that has reached its nesting
// limit — every self-rescheduling chain, which is what a UI flow and the suite
// driving it are made of — is then aligned to the next second. A suite is
// priced in the number of ticks it waits out rather than in the work it does:
// the pinboard suites make ~85 timer calls and run in under a second on an
// unthrottled pool, and in 58s on a throttled one.
//
// A page is hidden on this port whenever its widget is unmapped
// (webkitWebViewBaseUpdateVisibility is gtk_widget_get_mapped plus toplevel
// state), and the pool window is deliberately never shown, so the pool is
// permanently a hidden page and there is no visibility to win back.
//
// There is no C setter and no environment variable for the preference. The one
// switch is the runtime feature list, where every exposed boolean preference
// appears under an identifier the generator makes by stripping a trailing
// "Enabled" — so HiddenPageDOMTimerThrottlingEnabled is asked for as
// "HiddenPageDOMTimerThrottling". The list is walked rather than searched
// because webkit_feature_list_find() is newer than the API itself.
#if WEBKIT_CHECK_VERSION(2, 42, 0)

// findWebView returns the first WebKitWebView in a widget tree. Wails owns the
// web view and exposes only the GtkWindow, so the widget hierarchy is the seam
// available to us; the window holds a box, and the box holds the one web view.
static WebKitWebView* findWebView(GtkWidget* widget) {
	if (widget == NULL) {
		return NULL;
	}
	if (WEBKIT_IS_WEB_VIEW(widget)) {
		return WEBKIT_WEB_VIEW(widget);
	}
	for (GtkWidget* child = gtk_widget_get_first_child(widget);
	     child != NULL;
	     child = gtk_widget_get_next_sibling(child)) {
		WebKitWebView* found = findWebView(child);
		if (found != NULL) {
			return found;
		}
	}
	return NULL;
}

// unthrottleHiddenPageTimers switches the alignment off for one window's web
// view. Returns 0 when there is no web view to configure or the preference is
// not in the feature list, so the caller can say so rather than silently
// running a throttled pool.
static int unthrottleHiddenPageTimers(void* gtkWindow) {
	if (gtkWindow == NULL) {
		return 0;
	}
	WebKitWebView* webView = findWebView(GTK_WIDGET(gtkWindow));
	if (webView == NULL) {
		return 0;
	}
	WebKitSettings* settings = webkit_web_view_get_settings(webView);
	if (settings == NULL) {
		return 0;
	}
	WebKitFeatureList* features = webkit_settings_get_all_features();
	if (features == NULL) {
		return 0;
	}
	int found = 0;
	for (gsize i = 0, n = webkit_feature_list_get_length(features); i < n; i++) {
		WebKitFeature* feature = webkit_feature_list_get(features, i);
		const char* identifier = webkit_feature_get_identifier(feature);
		// The companion auto-increase escalates a long-hidden page's grid from
		// 1s upwards. It is off by default on this port, but leaving it armed
		// would re-throttle a page that somehow re-enabled the first.
		if (g_strcmp0(identifier, "HiddenPageDOMTimerThrottling") == 0) {
			webkit_settings_set_feature_enabled(settings, feature, FALSE);
			found = 1;
		} else if (g_strcmp0(identifier, "HiddenPageDOMTimerThrottlingAutoIncreases") == 0) {
			webkit_settings_set_feature_enabled(settings, feature, FALSE);
		}
	}
	webkit_feature_list_unref(features);
	return found;
}

#else

// The feature list arrived in WebKitGTK 2.42. An older library leaves the
// throttled default in place instead of failing to build.
static int unthrottleHiddenPageTimers(void* gtkWindow) {
	(void)gtkWindow;
	return 0;
}

#endif
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// unthrottleHiddenPageTimers stops the test pool's hidden window coarsening the
// timers of the code under test, so a suite is priced in the work it does
// rather than in the number of timer ticks it waits out. Reports whether it
// took effect.
//
// This lives here rather than in the vendored Wails fork for the same reasons
// the macOS one does: the switch serves the test pool alone, and the fork is
// kept as a rebaseable series of patches upstream could take.
//
// Must run on the main thread, after the window's web view exists — it walks
// live GTK widget state. The preference is re-read by WebCore when it changes,
// so setting it on a window that has already loaded is enough.
func unthrottleHiddenPageTimers(win *application.WebviewWindow) bool {
	handle := win.NativeWindow()
	if handle == nil {
		return false
	}
	return C.unthrottleHiddenPageTimers(handle) != 0
}
