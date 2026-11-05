//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation

#import <Foundation/Foundation.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The process macOS holds responsible for pid: the one its privacy prompts
// and settings name. Not in the SDK's headers, so weakly imported.
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t) __attribute__((weak_import));

// responsiblePath returns the executable of the process macOS holds
// responsible for this one, malloc'd, or NULL when it cannot be told.
static char *responsiblePath(void) {
	if (responsibility_get_pid_responsible_for_pid == NULL) {
		return NULL;
	}
	pid_t pid = responsibility_get_pid_responsible_for_pid(getpid());
	if (pid <= 0) {
		return NULL;
	}
	char buf[PROC_PIDPATHINFO_MAXSIZE];
	if (proc_pidpath(pid, buf, sizeof buf) <= 0) {
		return NULL;
	}
	return strdup(buf);
}

// infoName returns the bundle at path's display name, else its name,
// malloc'd, or NULL when it has neither.
static char *infoName(const char *path) {
	@autoreleasepool {
		NSBundle *b = [NSBundle bundleWithPath:[NSString stringWithUTF8String:path]];
		for (NSString *key in @[@"CFBundleDisplayName", @"CFBundleName"]) {
			id name = [b objectForInfoDictionaryKey:key];
			if ([name isKindOfClass:[NSString class]] && [name length] > 0) {
				return strdup([name UTF8String]);
			}
		}
		return NULL;
	}
}
*/
import "C"

import (
	"path"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// responsibleAppName is the app macOS holds responsible for this process, as
// System Settings lists it: whatever started it passes responsibility on —
// the terminal `juggler serve` runs in — unless it was launched as an app of
// its own, as the desktop app launches JugglerServer.app. "" when that is no
// app (a launch agent, sshd) or cannot be told.
func responsibleAppName() string {
	bundle := bundleOf(responsibleExecutable())
	if bundle == "" {
		return ""
	}
	return bundleName(bundle)
}

// bundleOf is the app bundle exe is the main executable of — the innermost
// .app it is in, when it sits in that bundle's Contents/MacOS — or "" for an
// executable that is no bundle's.
func bundleOf(exe string) string {
	dir, file := path.Split(exe)
	bundle, ok := strings.CutSuffix(dir, "/Contents/MacOS/")
	if file == "" || !ok {
		return ""
	}
	if name := path.Base(bundle); name == ".app" || !strings.HasSuffix(name, ".app") {
		return ""
	}
	return bundle
}

// responsibleExecutable is the executable of the process macOS holds
// responsible for this one, "" when it cannot be told.
func responsibleExecutable() string {
	p := C.responsiblePath()
	if p == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(p))
	return C.GoString(p)
}

// bundleName is the app bundle at path's name as System Settings lists it:
// its display name, else its name, else its file name.
func bundleName(path string) string {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	if name := C.infoName(cpath); name != nil {
		defer C.free(unsafe.Pointer(name))
		return C.GoString(name)
	}
	return strings.TrimSuffix(filepath.Base(path), ".app")
}

// osProductVersion is the version of macOS running, such as "27.0.1".
func osProductVersion() string {
	v, _ := unix.Sysctl("kern.osproductversion")
	return v
}
