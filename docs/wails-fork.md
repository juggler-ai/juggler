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

As of the rebase onto upstream `b6167d9b1` (v3.0.0-beta.34 + 10), 2026-10-25.
The stack is listed in order, oldest first. "Used by" names the code here that
needs the patch, so you can see what breaks if a patch is dropped or upstream's
version of it lands with a different API.

| # | Patch (subject) | Purpose | Files (under `v3/`) | Upstream | Used by | Drop when merged? |
|---|---|---|---|---|---|---|
| 1 | `feat(application): add MacWebviewPreferences.KeepRunningWhenHidden` | Keep a hidden macOS WKWebView's timers and JS running instead of throttled | `pkg/application/webview_window_darwin.go`, `webview_window_options.go` | Proposal [WEP #5920](https://github.com/wailsapp/wails/pull/5920), open; review deferred until after v3 GA. Implementation on the fork's `feat/keep-running-when-hidden`, no PR yet | `cmd/juggler/app/engine_lifecycle.go`, `window_testpool.go` | Yes. Adapt the call sites if the merged API differs |
| 2 | `feat(windows): keep WebView2 alive when hidden via KeepRunningWhenHidden` | Windows counterpart of #1: hidden WebView2 isn't suspended | `pkg/application/webview_window_options.go`, `webview_window_windows.go` | Same proposal as #1 | `cmd/juggler/app/engine_lifecycle.go`, `window_testpool.go` | Yes, as #1 |
| 3 | `feat(windows): render every message dialog with a themed TaskDialog` | Every message dialog, not only a question with custom buttons, is a themed task dialog with the title as its heading and standard buttons and icons by type | `pkg/application/dialogs_windows.go`, `dialogs_taskdialog.go`, `dialogs_taskdialog_test.go` | Proposal [WEP #5922](https://github.com/wailsapp/wails/pull/5922), open; review deferred until after v3 GA. Upstream's [#6308](https://github.com/wailsapp/wails/pull/6308) added TaskDialog for question dialogs with custom buttons; this patch extends that path. The fork's `feat/windows-themed-taskdialog` holds the earlier standalone version, which predates #6308 | Every Windows message dialog (no API) | Yes |
| 4 | `fix(linux): apply the window title to frameless windows` | Taskbars and window switchers can name frameless windows | `pkg/application/linux_cgo.go`, `linux_cgo_gtk3.go` | [PR #5960](https://github.com/wailsapp/wails/pull/5960), open. It conflicts with upstream `master` (changelog only); the rebased commit is the resolution | The frameless app window on Linux | Yes |
| 5 | `fix(v3): open a file chooser when a dialog accepts files and directories` | An open dialog that accepts both files and folders can still select files on Linux and Windows | `pkg/application/dialogs.go`, `dialogs_test.go`, `dialogs_android.go`, `dialogs_ios.go`, `dialogs_windows.go`, `linux_cgo.go`, `linux_cgo_gtk3.go` | Not yet offered; local branch `fix/file-directory-dialog` | `cmd/juggler-app/control.go` (the open-path dialog) | Yes |
| 6 | `fix(v3,macos): keep displays in the coordinate space their windows are measured in` | Screen bounds on mixed-DPI setups agree with window positions | `pkg/application/screen_darwin.go`, `screen_linux.go`, `screenmanager.go`, `screenmanager_dip_test.go` | Not yet offered; fixes open issue [#5409](https://github.com/wailsapp/wails/issues/5409) | `cmd/juggler-app` window placement (`Screen.GetAll` in `app_state.go`, `startup_diag.go`) | Yes |
| 7 | `fix(v3/updater): hand the staging directory to the swap helper` | A download racing a pending restart can't delete the payload the swap helper is about to install | `pkg/updater/updater.go`, `updater_test.go` | Not yet offered | — | Yes |
| 8 | `fix(v3/updater): validate the staged payload before and after the swap` | A damaged or emptied update rolls back instead of replacing a working app | `pkg/updater/helper.go`, `helper_unix.go`, `helper_windows.go`, `validate.go`, `validate_test.go`, `helper_test.go`, `helper_recovery_test.go` | Not yet offered | — | Yes |
| 9 | `feat(v3): add WebviewWindow.SetEnableFileDrop` | Turn native file drop on and off at runtime, leaving HTML5 drag-and-drop to the page when off | `pkg/application/webview_window.go`, `webview_window_{darwin,linux,windows,android,ios}.go`, `application_server.go` | Not yet offered | `cmd/juggler-app/app_state.go` | Yes |
| 10 | `fix(v3,macos): keep fullscreen when Escape reaches the window as a WebKit command` | `DisableEscapeExitsFullscreen` also holds when Escape is pressed in a focused text field | `pkg/application/webview_window_darwin.{h,m}`, `webview_panel_darwin.m`, `webview_window_options.go`, `escape_fullscreen_darwin_test.go`, `testdata/escape_fullscreen/` | Not yet offered; local branch `fix/macos-escape-fullscreen-text-field`. Extends upstream's [#5310](https://github.com/wailsapp/wails/pull/5310) | `cmd/juggler-app/app_state.go` (`DisableEscapeExitsFullscreen`) | Yes |
| 11 | `feat(v3): add Options.EphemeralWebviewStorage` | Webviews keep no website data on disk: non-persistent store (macOS, Linux), InPrivate (Windows) | `pkg/application/application_options.go` (+test), `linux_cgo.{c,go,h}`, `linux_cgo_gtk3.go`, `webview_window_darwin.go`, `webview_window_windows.go`, `internal/webview2/pkg/edge/chromium.go`, `ICoreWebView2Environment10.go` (+test); at the fork root, `docs/mpress/content/reference/application.md` | Not yet offered. Keeps its own `edge/` binding: upstream's [#6309](https://github.com/wailsapp/wails/pull/6309) fixed the inherited slots in `pkg/webview2`, but that package is imported by nothing, passes the HWND by pointer and queries the interface on `ICoreWebView2` | `cmd/juggler/app/window_testpool.go` | Yes |
| 12 | `fix(v3,windows): apply frameless window decorations at creation` | A frameless window shown during WebView2 setup, before it is registered, still gets its DWM border, shadow and rounded corners: they are applied once at creation, not only on `WM_ACTIVATE`, whose first instance is lost | `pkg/application/webview_window_windows.go` | Not yet offered | The frameless app window on Windows (`revealInitialWindowWhenReady` in `cmd/juggler-app/startup_diag.go` shows it during setup) | Yes |
| 13 | `test(v3,windows): keep the WebView2 lifetime tests valid under checkptr` | `go test -race` enables checkptr, which aborts on a `uintptr` turned back into a Go pointer. The tests that stand in for native code hold a handler as its address and the vtable read while it was reachable, match reference counts by address, and take COM out-parameters as typed callback arguments, so none makes that conversion | `internal/webview2/pkg/edge/chromium_lifetime_test.go`, `chromium_lifetime_live_test.go`, `com_refs_test.go`, `chromium_recovery_test.go`, `chromium_runtime_errors_test.go` | Not yet offered; fixes tests from upstream's [#6184](https://github.com/wailsapp/wails/pull/6184) and [#6222](https://github.com/wailsapp/wails/pull/6222) | `make test-wails-patches` on Windows, which runs `-race` | Yes |

Every patch except #1–#3 also adds its own line to
`v3/UNRELEASED_CHANGELOG.md`.

To refresh the Upstream column, run
`gh pr list -R wailsapp/wails --author <you> --state all`. Then match each PR's
head branch against the fork's branches.

## What tests the patches

The fork is its own Go module, so none of this repo's `./...` patterns reach
it, and lint skips `3rdparty/`. **`make test-wails-patches`** runs the fork's
own tests for the packages the patches touch. These are `WAILS_PATCH_PKGS` in
the `Makefile`, plus `pkg/w32` and `internal/webview2/pkg/edge` on Windows. On
other hosts it also vets the patched packages for `windows/amd64`, so a patch
that breaks the Windows build fails on any OS. `make test` includes the
target, and CI runs it on Linux, macOS and Windows.

Keep the list in step with the Files column: a patch that touches a new package
adds that package to `WAILS_PATCH_PKGS`.

Builds compile only the default GTK4 backend on Linux. The `linux_cgo_gtk3.go`
halves of patches 4, 5 and 11 compile only with `-tags gtk3`, which upstream's
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
   - The routine conflict is `v3/UNRELEASED_CHANGELOG.md`, because upstream
     empties it at every release. Keep upstream's side and add back only the
     line the patch itself adds.
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
     that PR's branch as well.
