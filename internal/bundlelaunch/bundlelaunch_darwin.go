//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package bundlelaunch

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework AppKit -framework Foundation

#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <string.h>

// bundleExecutable returns the path of the executable of the bundle at path,
// malloc'd, or NULL when path is not a bundle that has one.
static char *bundleExecutable(const char *path) {
	@autoreleasepool {
		NSBundle *b = [NSBundle bundleWithPath:[NSString stringWithUTF8String:path]];
		NSString *exe = b.executablePath;
		if (exe == nil) {
			return NULL;
		}
		return strdup(exe.fileSystemRepresentation);
	}
}

// launched is what launchBundle returns: the new process's pid, or 0 and a
// malloc'd description of why there is none.
typedef struct {
	pid_t pid;
	char *err;
} launched;

// launchBundle launches a new instance of the app bundle at path, in the
// background and without activating it, with args and env (each "NAME=value")
// as its whole argument list and environment.
//
// It asks for the launch asynchronously (NSWorkspaceLaunchAsync), and so uses
// launchApplicationAtURL:options:configuration:error:, deprecated since macOS
// 11 for openApplicationAtURL:configuration:completionHandler:. That, and this
// without the flag, answer only once the new process checks in with
// LaunchServices as an app: a process that never does, as a windowless server
// never does, is answered after LaunchServices gives up on it, 30 seconds on.
// This answers as soon as the process exists.
static launched launchBundle(const char *path, char **args, int nargs, char **env, int nenv) {
	@autoreleasepool {
		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path] isDirectory:YES];

		NSMutableArray<NSString *> *a = [NSMutableArray arrayWithCapacity:nargs];
		for (int i = 0; i < nargs; i++) {
			[a addObject:[NSString stringWithUTF8String:args[i]]];
		}
		NSMutableDictionary<NSString *, NSString *> *e = [NSMutableDictionary dictionaryWithCapacity:nenv];
		for (int i = 0; i < nenv; i++) {
			NSString *kv = [NSString stringWithUTF8String:env[i]];
			NSRange eq = kv == nil ? NSMakeRange(NSNotFound, 0) : [kv rangeOfString:@"="];
			if (eq.location == NSNotFound || eq.location == 0) {
				continue;
			}
			e[[kv substringToIndex:eq.location]] = [kv substringFromIndex:eq.location + 1];
		}

		NSError *error = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
		NSRunningApplication *app = [[NSWorkspace sharedWorkspace]
			launchApplicationAtURL:url
			               options:NSWorkspaceLaunchAsync | NSWorkspaceLaunchNewInstance | NSWorkspaceLaunchWithoutActivation | NSWorkspaceLaunchWithoutAddingToRecents
			         configuration:@{
				         NSWorkspaceLaunchConfigurationArguments: a,
				         NSWorkspaceLaunchConfigurationEnvironment: e,
			         }
			                 error:&error];
#pragma clang diagnostic pop
		launched out = {0, NULL};
		if (app != nil && app.processIdentifier > 0) {
			out.pid = app.processIdentifier;
		} else if (error != nil) {
			out.err = strdup([NSString stringWithFormat:@"%@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code].UTF8String);
		} else {
			out.err = strdup("LaunchServices launched no process");
		}
		return out;
	}
}
*/
import "C"

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Bundle reports the app bundle whose executable exe is, symlinks resolved:
// exe is <bundle>/Contents/MacOS/<name>, and <name> is the executable
// <bundle>'s Info.plist names, which is the one LaunchServices would run.
func Bundle(exe string) (string, bool) {
	real, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", false
	}
	macos := filepath.Dir(real)
	contents := filepath.Dir(macos)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" {
		return "", false
	}
	bundle := filepath.Dir(contents)
	cBundle := C.CString(bundle)
	defer C.free(unsafe.Pointer(cBundle))
	cExe := C.bundleExecutable(cBundle)
	if cExe == nil {
		return "", false
	}
	defer C.free(unsafe.Pointer(cExe))
	own, err := filepath.EvalSymlinks(C.GoString(cExe))
	if err != nil || own != real {
		return "", false
	}
	return bundle, true
}

// Start launches a new instance of bundle through LaunchServices, in the
// background, with args as its arguments and env as its environment, less the
// variables naming the starter's launchd job (jobEnv). It returns the
// process's pid and a channel that closes when the process exits. Its stdio is
// the null device and its working directory the root, as for any app
// LaunchServices launches.
//
// The process is not a child of the caller, so the caller cannot wait for it:
// its exit is watched with kqueue instead.
func Start(bundle string, args, env []string) (int, <-chan struct{}, error) {
	// The queue that will watch the exit exists before the process does: once
	// it is launched, there is no failing to watch it.
	kq, err := unix.Kqueue()
	if err != nil {
		return 0, nil, fmt.Errorf("kqueue: %w", err)
	}
	unix.CloseOnExec(kq)

	envNoJob := withoutJobEnv(env)
	cArgs := cStrings(args)
	defer freeCStrings(cArgs, len(args))
	cEnv := cStrings(envNoJob)
	defer freeCStrings(cEnv, len(envNoJob))
	cBundle := C.CString(bundle)
	defer C.free(unsafe.Pointer(cBundle))

	res := C.launchBundle(cBundle, cArgs, C.int(len(args)), cEnv, C.int(len(envNoJob)))
	if res.pid == 0 {
		_ = unix.Close(kq)
		msg := "unknown error"
		if res.err != nil {
			msg = C.GoString(res.err)
			C.free(unsafe.Pointer(res.err))
		}
		return 0, nil, fmt.Errorf("launch %s: %s", filepath.Base(bundle), msg)
	}
	pid := int(res.pid)
	return pid, watchExit(kq, pid), nil
}

// watchExit returns a channel that closes when pid exits, watched on kq, which
// it closes once it has. A watch that cannot be set closes it at once: the
// error is ESRCH, a pid already gone, and any other must not be read as a
// process that lives on, which would hold its starter waiting for good.
func watchExit(kq, pid int) <-chan struct{} {
	exited := make(chan struct{})
	var ev unix.Kevent_t
	unix.SetKevent(&ev, pid, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ONESHOT)
	ev.Fflags = unix.NOTE_EXIT
	if _, err := unix.Kevent(kq, []unix.Kevent_t{ev}, nil, nil); err != nil {
		_ = unix.Close(kq)
		close(exited)
		return exited
	}
	go func() {
		defer close(exited)
		defer func() { _ = unix.Close(kq) }()
		out := make([]unix.Kevent_t, 1)
		for {
			n, err := unix.Kevent(kq, nil, out, nil)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if err != nil || n > 0 {
				return
			}
		}
	}()
	return exited
}

// cStrings copies ss to a C array of C strings, which freeCStrings frees.
func cStrings(ss []string) **C.char {
	if len(ss) == 0 {
		return nil
	}
	arr := (**C.char)(C.malloc(C.size_t(len(ss)) * C.size_t(unsafe.Sizeof((*C.char)(nil)))))
	elems := unsafe.Slice(arr, len(ss))
	for i, s := range ss {
		elems[i] = C.CString(s)
	}
	return arr
}

// freeCStrings frees arr, of n strings, from cStrings.
func freeCStrings(arr **C.char, n int) {
	if arr == nil {
		return
	}
	for _, c := range unsafe.Slice(arr, n) {
		C.free(unsafe.Pointer(c))
	}
	C.free(unsafe.Pointer(arr))
}

// jobEnv are the variables launchd sets in a job's environment, naming that
// job. They describe the starter, not the bundle being started, whose launch
// gets its own.
var jobEnv = []string{"XPC_SERVICE_NAME", "XPC_FLAGS", "__CFBundleIdentifier"}

// withoutJobEnv is env without the jobEnv variables.
func withoutJobEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if name, _, _ := strings.Cut(kv, "="); !slices.Contains(jobEnv, name) {
			out = append(out, kv)
		}
	}
	return out
}
