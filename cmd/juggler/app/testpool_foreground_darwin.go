//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin && !production

package app

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// With occlusion detection off, WebKit counts a page as visible whenever its
// window is ordered in, whatever WindowServer says covers it or where the
// window sits. WebKit SPI: declared here, sent only behind -respondsToSelector:.
@interface WKWebView (JugglerTestPoolForeground)
- (void)_setWindowOcclusionDetectionEnabled:(BOOL)enabled;
- (BOOL)_windowOcclusionDetectionEnabled;
@end

enum {
	foregroundNoWebView = 0,
	foregroundNoSetter = -1,
	foregroundDidNotStick = -2,
	foregroundNotOrderedIn = -3,
	foregroundOK = 1,
};

static WKWebView* findForegroundWebView(NSView* view) {
	if ([view isKindOfClass:[WKWebView class]]) {
		return (WKWebView*)view;
	}
	for (NSView* sub in view.subviews) {
		WKWebView* found = findForegroundWebView(sub);
		if (found != nil) {
			return found;
		}
	}
	return nil;
}

// presentToWebKitOnly orders a test window in where nobody can see or reach it
// — far off every screen, fully transparent, ignoring the mouse, out of
// Mission Control and window cycling, without activating the app — and tells
// its web view to ignore occlusion, so WebKit treats the page as visible.
static int presentToWebKitOnly(void* nsWindow) {
	if (nsWindow == NULL) {
		return foregroundNoWebView;
	}
	NSWindow* window = (__bridge NSWindow*)nsWindow;
	WKWebView* webView = findForegroundWebView(window.contentView);
	if (webView == nil) {
		return foregroundNoWebView;
	}
	if (![webView respondsToSelector:@selector(_setWindowOcclusionDetectionEnabled:)]) {
		return foregroundNoSetter;
	}
	[webView _setWindowOcclusionDetectionEnabled:NO];
	if ([webView respondsToSelector:@selector(_windowOcclusionDetectionEnabled)] && [webView _windowOcclusionDetectionEnabled]) {
		return foregroundDidNotStick;
	}
	window.alphaValue = 0;
	window.ignoresMouseEvents = YES;
	window.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorStationary;
	[window setFrameOrigin:NSMakePoint(-30000, -30000)];
	[window orderFrontRegardless];
	if (!window.isVisible) {
		return foregroundNotOrderedIn;
	}
	return foregroundOK;
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// keepTestPageForeground keeps a test window's web process in the foreground
// scheduling band, so the suites run on the performance cores. Reports whether
// it took effect.
//
// WebKit gives the process behind a page in a never-shown window background
// QoS about 30 seconds after load (priority 4 in `ps`), and on Apple silicon
// that band runs on the efficiency cores alone: measured, the twelve slowest
// unit suites took 86.7s that way against 15.8s with the window shown, and
// `make test-all` about 13 minutes against 4. Neither WKPreferences'
// inactive-scheduling policy nor its process-suppression switch changes the
// band; only a page WebKit counts as visible keeps it. The window is ordered in
// where it cannot be seen, rather than shown, so a run puts nothing on screen
// and takes no focus.
//
// JUGGLER_TEST_BACKGROUND_POOL=1 leaves the window hidden, which is the
// efficiency-core pool kept as a stress mode (testPoolBackgroundRequested).
//
// Lives in a `!production` file for the reason the timer switch does
// (unthrottleHiddenPageTimers): the selector strings are compiled in wherever
// the category is declared, and only the test pool wants them.
//
// Must run on the main thread, after the window's web view exists.
func keepTestPageForeground(win *application.WebviewWindow) bool {
	handle := win.NativeWindow()
	if handle == nil {
		return false
	}
	switch C.presentToWebKitOnly(handle) {
	case C.foregroundNoWebView:
		return false
	case C.foregroundNoSetter:
		reportUnthrottle("this WebKit does not answer -_setWindowOcclusionDetectionEnabled:, so the test pages stay hidden and run on the efficiency cores", true)
		return false
	case C.foregroundDidNotStick:
		reportUnthrottle("-_setWindowOcclusionDetectionEnabled:NO was sent, and occlusion detection still reads back on: the test pages stay hidden and run on the efficiency cores", true)
		return false
	case C.foregroundNotOrderedIn:
		reportUnthrottle("the test window was ordered in and still reads back not visible: its pages stay hidden and run on the efficiency cores", true)
		return false
	}
	return true
}
