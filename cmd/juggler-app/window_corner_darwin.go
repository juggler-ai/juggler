//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/message.h>

// readCornerRadius asks AppKit how round the window's corners are. AppKit has
// no public API for it; -[NSWindow _cornerRadius] is private, so it is asked
// only if the window answers to it, and -1 means it does not. It reads 0 in
// fullscreen. Main thread only: it reads live NSWindow state.
static double readCornerRadius(void* nsWindow) {
    if (nsWindow == NULL) {
        return -1;
    }
    NSWindow* window = (__bridge NSWindow*)nsWindow;
    SEL sel = NSSelectorFromString(@"_cornerRadius");
    if (![window respondsToSelector:sel]) {
        return -1;
    }
    return ((CGFloat (*)(id, SEL))objc_msgSend)(window, sel);
}

// macOSMajorVersion is the running macOS's major version (15, 26, ...).
// NSProcessInfo is safe to ask from any thread.
static int macOSMajorVersion(void) {
    return (int)[[NSProcessInfo processInfo] operatingSystemVersion].majorVersion;
}
*/
import "C"

import (
	"math"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// measuredCornerRadius is the corner radius AppKit last reported for one of
// this app's windows, in points, or 0 before any has been measured. Every
// window has the same style, so one measurement speaks for the next window.
var measuredCornerRadius atomic.Int32

// noteWindowCornerRadius measures win's corner radius for the windows opened
// after it (windowCornerRadius). Main thread only. A reading of 0 or less —
// fullscreen, or an AppKit without the method — is no measurement.
func noteWindowCornerRadius(win *application.WebviewWindow) {
	handle := win.NativeWindow()
	if handle == nil {
		return
	}
	if r := float64(C.readCornerRadius(handle)); r > 0 && r < 64 {
		measuredCornerRadius.Store(int32(math.Round(r)))
	}
}

// windowCornerRadius is how round the corners of a window this app opens are,
// in points (CSS pixels at 100%): what AppKit last reported, else what this
// macOS is known to draw for a titled window with no toolbar — 16 from macOS 26
// on, 10 from Big Sur to Sequoia.
func windowCornerRadius() int {
	if r := measuredCornerRadius.Load(); r > 0 {
		return int(r)
	}
	if C.macOSMajorVersion() >= 26 {
		return 16
	}
	return 10
}
