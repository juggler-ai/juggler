# The fsnotify fork

Juggler watches project and settings directories with
[fsnotify](https://github.com/fsnotify/fsnotify). It builds against
`3rdparty/fsnotify`, a copy of the v1.10.1 release with two fixes, wired in by a
`replace` in `go.mod`. The copy is plain files, not a submodule: the release's
non-test Go source, its `LICENSE` (BSD-3-Clause), and its `go.mod`/`go.sum`.
Its `golang.org/x/sys` requirement is raised to the version Juggler builds
with, so its test runs against the same code it ships with.

## The fixes

**On Windows, `Watcher.Close` can wait forever.** `Close` puts a reply channel
on `w.done`, wakes the reader goroutine, and waits for the answer. When the
request arrives while the reader is inside `sendError`, waiting for someone
to read `Watcher.Errors`, `sendError` takes the request and returns. The
request is gone, so when the wake-up arrives the reader finds nothing on
`w.done` and goes back to waiting for I/O. `Close` never returns. `sendEvent`
already puts the request back, and the fix makes `sendError` do the same
(`backend_windows.go`). Any error the reader reports can be the one in flight,
such as an event-buffer overflow or a failed read. The result is a project
switch or shutdown that never finishes, or a test that hangs in its cleanup.

`TestWindowsSendErrorKeepsCloseRequest` (`backend_windows_test.go`, added
here) recreates that ordering without timing: it queues a close request
without the wake-up and calls `sendError` with nothing reading `Errors`, so
the request is the only case it can take. It then checks the request is still
there and that the reader answers it. `make test-wails-patches` runs it on
Windows and cross-vets the package for windows/amd64 elsewhere.

**On Windows, a read that fills the buffer drops all but its first event.**
When `ReadDirectoryChangesW` completes with `ERROR_MORE_DATA`, the reader
takes the buffer's length to be `unsafe.Sizeof(watch.buf)`. That was right
while `buf` was a 64 KiB array; since v1.7.0 (PR #521, which made the size
configurable) it is a slice, so the size is the 24-byte slice header. The walk
stops after the first entry with "Windows system assumed buffer larger than it
is, events have likely been missed", and the rest are lost. The fix uses
`len(watch.buf)`. In the same switch, `ERROR_NOTIFY_ENUM_DIR` (the system
could not record every change) fell to the default case, which reports the
error without reading that directory again, so it went deaf. It is now
reported as `ErrEventOverflow` and the read restarted. No test covers either:
the completion's error code comes from `GetQueuedCompletionStatus`, which a
test cannot make return them. Juggler's project watcher rescans after any
error (`core/filewatcher.go`, `recoverLost`), so what is still lost costs a
re-walk, not a stale view.

## Upstream

Upstream has the `Close` bug on `main` and in v1.10.1, the latest release. As
of 2026-11-23 it is [issue #807](https://github.com/fsnotify/fsnotify/issues/807).
Three open PRs carry the same one-line fix:
[#808](https://github.com/fsnotify/fsnotify/pull/808),
[#801](https://github.com/fsnotify/fsnotify/pull/801) and
[#769](https://github.com/fsnotify/fsnotify/pull/769), which also fixes
[#768](https://github.com/fsnotify/fsnotify/issues/768).

As of 2026-11-24 the buffer bug has no upstream issue or PR, and `main` still
has it. Open PR [#782](https://github.com/fsnotify/fsnotify/pull/782) rewrites
the code around it; check whether it changes that line before relying on it.

**Drop the copy** once a release carries both fixes. Delete `3rdparty/fsnotify`,
remove the `replace` lines, require that release, and run `go mod tidy`. Then
take `FSNOTIFY_FORK` out of `test-wails-patches` in the `Makefile` and remove
this page and its mention in `LICENSING.md` and `CONTRIBUTING.md`.
