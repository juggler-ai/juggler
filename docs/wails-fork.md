# The Wails fork

Juggler's desktop shell and hidden engine webview are built on
[Wails v3](https://github.com/wailsapp/wails). It builds against a fork,
[`juggler-ai/wails`](https://github.com/juggler-ai/wails), checked out as the
submodule `3rdparty/wails` and wired in by a `replace` in `go.mod`. The fork is
upstream `master` plus a short stack of local patches on the branch
`juggler-changes`. Each patch is written to be offered upstream, and each is
dropped once upstream carries it.

This page is the ledger of those patches and the procedure for rebasing them.

## Patch ledger

As of the rebase onto upstream `25288cb56` (v3.1.0-nightly.20261027 + 1),
2026-10-28; the Upstream column was last checked on 2026-10-28.
The stack is listed in order, oldest first. "Used by" names the code here that
needs the patch, so you can see what breaks if a patch is dropped or upstream's
version of it lands with a different API.

| # | Patch (subject) | Purpose | Files (under `v3/`) | Upstream | Used by | Drop when merged? |
|---|---|---|---|---|---|---|
| 1 | `feat(application): add MacWebviewPreferences.KeepRunningWhenHidden` | Keep a never-shown macOS WKWebView running instead of suspended; WebKit still throttles it as a hidden page | `pkg/application/webview_window_darwin.go`, `webview_window_options.go` | Proposal [WEP #5920](https://github.com/wailsapp/wails/pull/5920), open, awaiting review. The fork's `feat/keep-running-when-hidden` has the upstream-ready implementation (rows 1 and 2, on current `master`), whose comments and messages are corrected to what was measured: the policy keeps a never-shown WebView running instead of suspended, but WebKit still throttles it as a hidden page. The patches here predate that correction. That branch also leaves out patch 2's `chromium.Show()` at controller creation, so a hidden window's controller stays hidden, and in efficiency mode, until its first navigation completes. No implementation PR yet | `cmd/juggler/app/engine_lifecycle.go`, `window_testpool.go` | Yes. Adapt the call sites if the merged API differs |
| 2 | `feat(windows): keep WebView2 alive when hidden via KeepRunningWhenHidden` | Windows counterpart of #1: hidden WebView2 isn't suspended | `pkg/application/webview_window_options.go`, `webview_window_windows.go` | Same proposal as #1 | `cmd/juggler/app/engine_lifecycle.go`, `window_testpool.go` | Yes, as #1 |
| 3 | `feat(windows): render every message dialog with a themed TaskDialog` | Every message dialog, not only a question with custom buttons, is a themed task dialog with the title as its heading and standard buttons and icons by type | `pkg/application/dialogs_windows.go`, `dialogs_taskdialog.go`, `dialogs_taskdialog_test.go` | Proposal [WEP #5922](https://github.com/wailsapp/wails/pull/5922), open, awaiting review. Upstream's [#6308](https://github.com/wailsapp/wails/pull/6308) added TaskDialog for question dialogs with custom buttons; this patch extends that path. The patch is the fork's `feat/windows-themed-taskdialog`: a standard Yes/No question can't be dismissed with Escape or the close box (as with `MB_YESNO`), and an `E_INVALIDARG` failure is logged as an error | Every Windows message dialog (no API) | Yes |
| 4 | `fix(linux): apply the window title to frameless windows` | Taskbars and window switchers can name frameless windows | `pkg/application/linux_cgo.go`, `linux_cgo_gtk3.go` | [PR #5960](https://github.com/wailsapp/wails/pull/5960), open, mergeable | The frameless app window on Linux | Yes |
| 5 | `fix(v3): open a file chooser when a dialog accepts files and directories` | An open dialog that accepts both files and folders can still select files on Linux and Windows | `pkg/application/dialogs.go`, `dialogs_test.go`, `dialogs_android.go`, `dialogs_ios.go`, `dialogs_windows.go`, `linux_cgo.go`, `linux_cgo_gtk3.go` | Issue [#6355](https://github.com/wailsapp/wails/issues/6355) asks whether upstream accepts the behaviour change (a dialog passing only `CanChooseDirectories(true)` stops being a folder picker on Linux and Windows); PR or WEP to follow. Local branch `fix/file-directory-dialog` | `cmd/juggler-app/control.go` (the open-path dialog) | Yes |
| 6 | `feat(v3): add WebviewWindow.SetEnableFileDrop` | Turn native file drop on and off at runtime, leaving HTML5 drag-and-drop to the page when off; `IsFileDropEnabled` reads it back | `pkg/application/webview_window.go`, `webview_window_{darwin,linux,windows,android,ios}.go`, `application_server.go`, `linux_cgo.c`, `linux_cgo_gtk3.go`, `webview_window_filedrop_test.go` | Proposal [WEP #6354](https://github.com/wailsapp/wails/pull/6354), open, awaiting review. Implementation on the fork's `feat/set-enable-file-drop` | `cmd/juggler-app/app_state.go` | Yes. Adapt the call site if the merged API differs |
| 7 | `fix(v3/macos): keep fullscreen on Escape in a focused text field` | `DisableEscapeExitsFullscreen` also holds when Escape is pressed in a focused text field, which AppKit routes as a command that exits fullscreen without calling `cancelOperation:` | `pkg/application/webview_window_darwin.{h,m}`, `webview_panel_darwin.m`, `webview_window_options.go`, `escape_fullscreen_darwin_test.go`, `testdata/escape_fullscreen/` | [PR #6359](https://github.com/wailsapp/wails/pull/6359), open; the patch is the PR branch's version. Its opt-in fullscreen test (`WAILS_TEST_FULLSCREEN=1`) shows the bug in a control case and passes with the fix. Extends upstream's [#5307](https://github.com/wailsapp/wails/pull/5307) | `cmd/juggler-app/app_state.go` (`DisableEscapeExitsFullscreen`) | Yes |
| 8 | `feat(v3): add Options.EphemeralWebviewStorage` | Webviews keep no website data on disk: non-persistent store (macOS, Linux), InPrivate (Windows) | `pkg/application/application_options.go` (+test), `linux_cgo.{c,go,h}`, `linux_cgo_gtk3.go`, `webview_window_darwin.go`, `webview_window_windows.go`, `internal/webview2/pkg/edge/chromium.go`, `ICoreWebView2Environment10.go` (+test); at the fork root, `docs/mpress/content/reference/application.md` | Proposal [WEP #6353](https://github.com/wailsapp/wails/pull/6353), open, awaiting review. Implementation on the fork's `feat/ephemeral-webview-storage`. Keeps its own `edge/` binding: upstream's [#6309](https://github.com/wailsapp/wails/pull/6309) fixed the inherited slots in `pkg/webview2`, but that package is imported by nothing, passes the HWND by pointer and queries the interface on `ICoreWebView2` | `cmd/juggler/app/window_testpool.go` | Yes |
| 9 | `fix(v3,windows): apply frameless window decorations at creation` | A frameless window shown during WebView2 setup, before it is registered, still gets its DWM border, shadow and rounded corners: they are applied once at creation, not only on `WM_ACTIVATE`, whose first instance is lost | `pkg/application/webview_window_windows.go` | [PR #6347](https://github.com/wailsapp/wails/pull/6347), open | The frameless app window on Windows (`revealInitialWindowWhenReady` in `cmd/juggler-app/startup_diag.go` shows it during setup) | Yes |
| 10 | `test(v3,windows): keep the WebView2 lifetime tests valid under checkptr` | `go test -race` enables checkptr, which aborts on a `uintptr` turned back into a Go pointer. The tests that stand in for native code hold a handler as its address and the vtable read while it was reachable, match reference counts by address, and take COM out-parameters as typed callback arguments, so none makes that conversion | `internal/webview2/pkg/edge/chromium_lifetime_test.go`, `chromium_lifetime_live_test.go`, `com_refs_test.go`, `chromium_recovery_test.go`, `chromium_runtime_errors_test.go` | [PR #6348](https://github.com/wailsapp/wails/pull/6348), open; fixes tests from upstream's [#6184](https://github.com/wailsapp/wails/pull/6184) and [#6222](https://github.com/wailsapp/wails/pull/6222) | `make test-wails-patches` on Windows, which runs `-race` | Yes |
| 11 | `test(v3,windows): keep the lifetime tests' host window out of allocation batches` | The lifetime tests prove a window collected by its weak pointer becoming nil, which Go does not promise for a tiny pointer-free object batched into one slot with a live one. Without `-race` the tiny allocator batched `hostWindow` with the replacement Chromium's allocations, intermittently failing `TestLiveReplacementReleasesAbandonedHandlers`. A pointer field keeps it out of any batch; `TestHostWindowIsCollectedBesideLiveObjects` fails deterministically without it | `internal/webview2/pkg/edge/com_refs_test.go` | Not yet offered; fixes tests from upstream's [#6184](https://github.com/wailsapp/wails/pull/6184), so it belongs beside #10 in [PR #6348](https://github.com/wailsapp/wails/pull/6348) | `make test-wails-patches` on Windows without `-race` (the default with no C compiler) | Yes |

Upstream's `v3/UNRELEASED_CHANGELOG.md` is generated from each PR after it
merges, and its `AGENTS.md` forbids contribution PRs from editing it. The
patches' upstream PR branches, and the patches here, leave it alone.

To refresh the Upstream column, run
`gh pr list -R wailsapp/wails --author <you> --state all`. Then match each PR's
head branch against the fork's branches. The submodule's `origin` fetches only
`master` and `juggler-changes`, so a plain `git fetch` leaves every other
`origin/<branch>` stale: read the branch tips with `git ls-remote origin` and
fetch the ones you compare by name.

## What tests the patches

The fork is its own Go module, so none of this repo's `./...` patterns reach
it, and lint skips `3rdparty/`. **`make test-wails-patches`** runs the fork's
own tests for the packages the patches touch. These are `WAILS_PATCH_PKGS` in
the `Makefile`, plus `pkg/w32` and `internal/webview2/pkg/edge` on Windows. On
other hosts it also vets the patched packages for `windows/amd64`, so a patch
that breaks the Windows build fails on any OS. `make test` includes the
target, and CI runs it on Linux, macOS and Windows.

Keep the list in step with the Files column: a patch that touches a new package
adds that package to `WAILS_PATCH_PKGS`, and a package no patch touches any
more leaves it, with upstream's CI trusted for its tests.

Builds compile only the default GTK4 backend on Linux. The `linux_cgo_gtk3.go`
halves of patches 4, 5, 6 and 8 compile only with `-tags gtk3`, which upstream's
CI builds but ours does not.

## The bundled runtime

`/wails/runtime.js` is served from `cmd/juggler/server/wails_runtime.js`, a
copy of the fork's committed bundle
`v3/internal/assetserver/bundledassets/runtime.js`. The `wails-runtime-embed`
step of every build makes that copy. Upstream's CI requires a PR's committed
bundle to equal a clean rebuild of its TypeScript, so `master` is consistent.
The bundle can only go stale through a change made here, and the step **fails
the build** when it can show that it has:

- the runtime source has uncommitted changes but the bundle doesn't;
- a commit to the runtime source (tests excluded) is newer than the last commit
  to the bundle;
- the bundle is missing (the submodule isn't checked out).

To fix it, run **`make wails-runtime-build`**. It runs `npm ci` and then the
same esbuild commands as the fork's `task runtime:build:assets`. Commit the
regenerated bundle in the fork. None of the current patches touch the runtime
source.

## Rebasing onto upstream

Work inside `3rdparty/wails`.

1. **Get full history.** The submodule is cloned at depth 1. Run
   `git fetch --unshallow origin` once, then add upstream and fetch it:
   `git remote add upstream https://github.com/wailsapp/wails.git` and
   `git fetch upstream master --tags`.
2. **Find what upstream already has.** Run
   `git cherry -v upstream/master juggler-changes`. A line marked `-` is a
   patch upstream already carries: drop it in the rebase, and drop its row
   here. An upstream fix may also make a patch redundant without being
   identical to it, so read upstream's log for the files in the ledger:
   `git log upstream/master --not juggler-changes -- <files>`.
3. **Rebase on a new branch.** Run
   `git switch -c juggler-changes-rebase-<date> juggler-changes`, then
   `git rebase upstream/master`.
   - The routine conflict is `v3/UNRELEASED_CHANGELOG.md`, which upstream's
     automation writes after every merge and empties at every release. Keep
     upstream's side whole; a patch adds no line of its own.
   - For a real conflict, keep the patch upstream-ready: upstream's commit
     style, one concern per commit, and nothing specific to this project.
   - Upstream may also have changed a code path a patch relies on without
     conflicting with it. Before trusting a clean rebase, compare the patch's
     result with upstream's new code (`git diff upstream/master HEAD -- <file>`).
4. **Point this repo at it.** Set the `require github.com/wailsapp/wails/v3`
   version in `go.mod` to upstream's nearest tag (`git describe --tags
   upstream/master`). The `replace` makes the version a label, but it should
   say what's in the tree. Run `go mod tidy`; a fork dependency bump comes
   through here.
5. **Test.** Run `make test-wails-patches`, then `make test`. A stale-bundle
   failure from `wails-runtime-embed` means running `make wails-runtime-build`
   and committing the result in the fork.
6. **Update this ledger:** subjects, files, upstream status, and the "As of"
   line.
7. **Publish.** Pushing anything is a deliberate, reviewed step:
   - Push the new branch to the fork.
   - Before moving `juggler-changes`, tag its current tip
     (`git tag pin/<date> origin/juggler-changes && git push origin pin/<date>`).
     The rebase makes that tip unreachable, and older checkouts of this repo
     fetch their pinned SHA at depth 1, which GitHub only promises for
     reachable commits.
   - Then `git push --force-with-lease origin juggler-changes-rebase-<date>:juggler-changes`.
   - Commit the submodule pointer together with `go.mod` here.
   - Where a patch has an open upstream PR, force-push its rebased commit to
     that PR's branch as well. Where the PR branch has moved on in review (a
     fix the patch here lacks), take the PR's version into the stack, not the
     other way round.
