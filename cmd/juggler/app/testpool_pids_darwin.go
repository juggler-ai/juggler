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
#import <objc/message.h>

// The window hosts exactly one web view; see findWebView in
// testpool_timers_darwin.go, which this mirrors.
static WKWebView* findPoolWebView(NSView* view) {
	if ([view isKindOfClass:[WKWebView class]]) {
		return (WKWebView*)view;
	}
	for (NSView* sub in view.subviews) {
		WKWebView* found = findPoolWebView(sub);
		if (found != nil) {
			return found;
		}
	}
	return nil;
}

// pidFrom sends a pid-returning SPI selector to target, or answers 0 when the
// selector is gone, so a WebKit that drops one costs that process and nothing
// else.
static pid_t pidFrom(id target, NSString* name) {
	SEL sel = NSSelectorFromString(name);
	if (target == nil || ![target respondsToSelector:sel]) {
		return 0;
	}
	return ((pid_t (*)(id, SEL))objc_msgSend)(target, sel);
}

// poolProcessPIDs writes the web, network and GPU process pids behind one
// window's web view into out[0..2]; a zero is one this WebKit would not name.
static void poolProcessPIDs(void* nsWindow, int* out) {
	out[0] = out[1] = out[2] = 0;
	if (nsWindow == NULL) {
		return;
	}
	WKWebView* webView = findPoolWebView(((__bridge NSWindow*)nsWindow).contentView);
	if (webView == nil) {
		return;
	}
	out[0] = pidFrom(webView, @"_webProcessIdentifier");
	out[1] = pidFrom(webView.configuration.websiteDataStore, @"_networkProcessIdentifier");
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
	out[2] = pidFrom(webView.configuration.processPool, @"_gpuProcessIdentifier");
#pragma clang diagnostic pop
}
*/
import "C"

import (
	"slices"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// webProcessPIDs names the WebKit processes that run these windows' pages: a
// web process per page, and the network and GPU processes they share. WebKit
// launches all three as XPC services, outside this process's tree, so this is
// the only way to tell them from another app's. The selectors are WebKit SPI,
// sent behind -respondsToSelector:, and this file is never in a production
// build (see unthrottleHiddenPageTimers for why that matters).
//
// Must run on the main thread: it reads live web views.
func webProcessPIDs(wins ...*application.WebviewWindow) []int {
	var pids []int
	for _, win := range wins {
		if win == nil {
			continue
		}
		handle := win.NativeWindow()
		if handle == nil {
			continue
		}
		var out [3]C.int
		C.poolProcessPIDs(handle, &out[0])
		for _, pid := range out {
			if pid > 0 && !slices.Contains(pids, int(pid)) {
				pids = append(pids, int(pid))
			}
		}
	}
	return pids
}
