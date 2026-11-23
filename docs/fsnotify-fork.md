# The fsnotify fork

Juggler watches project and settings directories with
[fsnotify](https://github.com/fsnotify/fsnotify). It builds against
`3rdparty/fsnotify`, a copy of the v1.10.1 release with one fix, wired in by a
`replace` in `go.mod`. The copy is plain files, not a submodule: the release's
non-test Go source, its `LICENSE` (BSD-3-Clause), and its `go.mod`/`go.sum`.
Its `golang.org/x/sys` requirement is raised to the version Juggler builds
with, so its test runs against the same code it ships with.

## The fix

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

## Upstream

Upstream has this bug on `main` and in v1.10.1, the latest release. As of
2026-11-23 it is [issue #807](https://github.com/fsnotify/fsnotify/issues/807).
Three open PRs carry the same one-line fix:
[#808](https://github.com/fsnotify/fsnotify/pull/808),
[#801](https://github.com/fsnotify/fsnotify/pull/801) and
[#769](https://github.com/fsnotify/fsnotify/pull/769), which also fixes
[#768](https://github.com/fsnotify/fsnotify/issues/768).

**Drop the copy** once a release carries the fix. Delete `3rdparty/fsnotify`,
remove the `replace` lines, require that release, and run `go mod tidy`. Then
take `FSNOTIFY_FORK` out of `test-wails-patches` in the `Makefile` and remove
this page and its mention in `LICENSING.md` and `CONTRIBUTING.md`.
