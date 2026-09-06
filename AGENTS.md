# Juggler

## Build / Test / Lint / Dev

```bash
make build          # Lint + build Go binaries (bin/juggler, bin/juggler-app, bin/juggler-test)
make test           # All tests (unit + integration + browser); RUN='<name>' runs one
make go-build       # Build Go binaries only (skip linting)
make test-full      # Lint + tests. Run before opening a PR.
make lint           # All linters (Go + JS + CSS) — the only way to lint everything
make fix            # Auto-fix what the linters can (gofmt, eslint/stylelint --fix); then re-lint
make dev            # Build and run server
make build-windows  # Cross-compile bin/windows/*.exe (pure-Go, no cgo)
```

`make build` and `make test` **must** pass before any task is complete.

### Run them in the foreground

They are ordinary commands that take a few minutes (`make test` is typically
3–6). Run the bare command with a timeout long enough to cover it — 20 minutes
— and wait for it to finish.

**Never** start a build or test run as a background task, poll it, wait on its
pid, or loop until the process exits. It gains nothing: you get the identical
output several turns later, having spent those turns guessing an interval —
too short burns turns, too long stalls the task, and "wait for the process to
disappear" wedges on the first thing that outlives it. If a run genuinely
exceeds the timeout, that is a hang worth reporting, not a reason to relaunch
it detached.

**Never pipe them through `tail`, `head`, `grep`, or `tee`.** The output is
already the summary (see Tests below), and `tail` is the worst choice of the
lot: a failure is written top-down, so truncating to the tail keeps the summary
line you already had and cuts the assertion that says what broke.

## Linting

- **`make lint` and `make lint-files` are the only sanctioned ways to lint.**
  Never invoke `golangci-lint`, `go vet`, `gofmt`, `eslint`, or `stylelint`
  directly — every config, flag, ignore pattern, and pinned tool version lives
  in the `Makefile` / `scripts/lint-files`, and a hand-rolled invocation
  silently diverges from what CI enforces.
- To lint specific files (routed by extension to the same linters):
  ```bash
  make lint-files FILES="cmd/juggler/worker/foo.go web/js/bar.js"
  ```
- **Before fixing lint failures by hand, run `make fix`** — it applies every
  auto-fix the linters can (gofmt, `golangci-lint --fix`, `eslint --fix`,
  `stylelint --fix`) using the same configs and globs as `make lint`, then tells
  you to re-lint. It never fixes type errors (lint-types) or dead code
  (lint-deadcode) — those still need a human. `make fix` and `make fix-files`
  are the only sanctioned ways to auto-fix; don't run `gofmt -w`, `eslint --fix`,
  or `stylelint --fix` directly (same drift reason as lint). Per-file:
  ```bash
  make fix-files FILES="cmd/juggler/worker/foo.go web/css/bar.css"
  ```

## Tests

- `make test` runs the whole suite (Go unit + integration + browser) without
  `-v`, so its output already is the summary: one `ok <pkg> <time>` line per
  passing package, and on failure only the failing tests' own output. Each layer
  announces itself, the first failing layer stops the run — so a failure is the
  last thing on screen — and a `✗` line under it names the layer. The same text
  is teed to `bin/test*.log` purely for afterwards; the log and the terminal
  hold the same thing, so there is nothing to tail or grep.
- **To run one specific test, pass `RUN='<regex>'`** — a `go test -run` pattern
  matched against test-function names. It also turns on `-v` so you see that
  test's own output, and silences the packages that hold no matching test (which
  under `-v` would otherwise announce themselves and bury the one you asked
  for). This is the sanctioned way to iterate on a single test;
  **don't run `node`, the browser harness, or `go test` by hand** — the target
  builds the right binary, sets the flags CI uses, and tees the log for you.
  ```bash
  make test RUN='TestDiffView'            # one test, whichever layer it's in
  make test RUN='TestDiffView/collapsed'  # one subtest
  make test-go RUN='TestWorker'           # restrict to the fast unit layer
  ```
- Browser tests launch `bin/juggler --assets-from-disk`, serving the local
  `web/` tree. Once `bin/juggler` exists, web-only edits don't need a rebuild —
  rerun `make test RUN='<name>'` (Go builds are incremental, so this is cheap).
  Rebuild only for Go / embedded-asset / build-file changes.
- Browser-test lanes share one offscreen pool window. They do not reliably paint,
  so a test must not await `requestAnimationFrame` or a post-layout
  `ResizeObserver` delivery; exercise a synchronous seam instead. Lane viewport
  width also varies by platform and may cross the 36rem phone breakpoint, so
  geometry that depends on a breakpoint belongs in an explicitly sized iframe.
- rAF delivery in a lane is platform-split: frames never arrive on macOS or
  Linux (WebKitGTK), but Windows (WebView2) delivers them — so product code
  deferred through `requestAnimationFrame` is exercised only on Windows CI.
  Test such behaviour by calling the deferred function directly.
- The pool is `JUGGLER_TEST_WINDOWS` subprocesses x `JUGGLER_TEST_IFRAMES` lanes,
  and the lanes inside one subprocess share a single content process — one JS
  heap, one main thread. Raising iframes while dropping windows to 1 serialises
  the suite onto that thread and produces cascades of arbitrary timeouts.
- Suite timings are load-sensitive. A browser test that fails in a full run and
  passes alone is not a regression in the code it asserts on — re-run the exact
  subtest in isolation before investigating it. It is not automatically "just
  load" either: that shape has twice turned out to be a real harness fault that
  only a busy machine reaches.
- **Every wait in a test rides the per-test deadline** (`budgetFor` /
  `deadlineFor` in `web/js-tests/utilities/test-deadline.js`), never a bare
  nominal timeout of its own. A number chosen when a lane had the pool to itself
  measures the pool rather than the code once nine lanes share a machine.
  `unit:test-budget` asserts this contract; add a case to it when you add a wait.
- A wait whose expiry does not itself fail the test — one that answers a dialog
  or a prompt something else is blocked on — must record why it gave up. Silence
  there turns a missed deadline into a hang that gets reported much later,
  against whatever was in flight at the time.

## Git commits

- Commit messages: **one line, minimal, past tense**
  (e.g. `Fixed cross-conversation cancel leak`).

## Changelog

- Add entries under `[Unreleased]` in `CHANGELOG.md` as you make user-facing
  changes; release tooling rolls that section into a dated version section when
  a release is cut.
- **Each release is a single flat list of changes** — no `Added`/`Changed`/
  `Fixed` subsection headers.
- **Entries are terse one-liners**: ~12 words, the user-visible headline only.
  Match the length of the existing entries.

## Conventions

- **`docs/` is published user-facing docs only.** Assistant plans, notes, and
  scratch go in `scratch/` (git-ignored); promote to `docs/` only when it's for
  users.
- Refer to code locations as `file_path:line_number`.

## Architecture

Two binaries, not one:

- **`cmd/juggler` — the server.** Headless terminal process doing all the work:
  HTTP/WebSocket server, session store, and the hidden engine WebView (backend
  JS — tool execution, prompt building). Strictly windowless in production
  (macOS accessory app, `Mac.ActivationPolicy: Accessory`). Never create a
  visible window in the server's production path.
- **`cmd/juggler-app` — the desktop app** (`bin/Juggler.app`). One long-lived
  process owning many visible windows, each a pure viewer pointed at a server
  over HTTP/WebSocket. Connects to a running server (`--url`) or
  spawns/discovers a local one.

Key invariants:

- **Engine is the single place tools execute**, but the **worker decides when**.
  The worker observes the doc and commands the engine per tool-action
  (`evaluate-tool` / `execute-tool` / `cancel-tool`); the engine has no reactive
  tool reducer. State is pushed ahead of each command on one ordered mailbox.
- **Durable state lives in the Go worker's Yjs doc** (source of truth); the
  engine carries no decision state. When two pieces of Yjs state must co-vary,
  maintain it in a reactive observer, not in click handlers.
- **Window geometry is per-project session state**, stored server-side in the
  session and exposed at `GET/PUT /api/session/window-state`.
- **Sub-threads reach the LLM by two dispatch paths** that share no code, so a
  change to one proves nothing about the other. Both are described at
  `tryReconcile` (`thread_reducer.go`); test both.
- A `ReadinessCheck` must fail open on an unanswerable probe — otherwise a
  disabled provider can never run the turn that would re-enable it. (How that
  lands on `Available` vs `Credentialed`: `ProviderStatus`, `providers_api.go`.)

## Web UI

- **Event feeds are not interchangeable** — `onLLMStatusChange` and
  `conversation:changed` answer different questions. Which to use, and why
  handlers on the latter stay read-only and unbatched: `session.js`.
- **An automatic scroll may never increase `|scrollTop|`** (distance from the
  end) in the column-reverse `#message-list`; auto-selection can land on a
  non-tail row and yank the view backwards. `conversation-area`'s reader anchor
  reads "content changed size" as evidence of drift — which a streaming turn
  satisfies — and its `scrollTo` cancels an in-flight smooth scroll, so any new
  programmatic scroll calls `_beginProgrammaticScroll()` first and targets a
  clamped extreme rather than a measured delta, so an interrupted trip still
  converges. Lanes barely paint; test these by calling the guard directly.
- **A "new" conversation is not empty in the doc** — items are seeded with
  standing context items (system prompt, agents files, memory) before the first
  message. Count real history with `isConversationalItemType()`
  (`web/sdk/lib/message.js`), never `items.length === 0`.
- Transcript render cost is linear in conversation length. A `content-visibility`
  row skip was measured and removed (a constant factor, no change in scaling);
  if long-thread jank returns, the fix that changes the curve is windowing.

## Debugging the viewer

- Viewer JS faults reach `server.log` as
  `[viewer-fault] <source>: <message> conv=<id>` — window errors, unhandled
  rejections, failed Yjs applies, throwing observers. Grep for it first on any
  "the UI froze / stopped updating" report; a release-build viewer has no
  console.
- **One conversation frozen while the others work, and sends still go out** =
  something threw inside `DocumentSyncManager._applyBatchedUpdates`
  (`web/js/utils/document-sync-manager.js`). It drains the pending queue before
  `Y.applyUpdate`, and by design every observer and re-render runs synchronously
  inside that apply — so a render bug kills inbound sync for that one
  conversation permanently. Outbound survives because it rides
  `doc.on('update')`, a separate path.
- Liveness proves nothing about the UI: the server's viewer-silence window is
  fed by a bare `setInterval` heartbeat, and the client's stall timer by the
  server's own heartbeat, stamped before parsing. A viewer whose render layer is
  dead keeps both happy. To place a wedge, ask `GET /api/health/active` (false =
  the server is idle and the bug is client-side), then check whether `doc.yjs`
  changed when the user acted (unchanged = the input never reached the server).

## Paths

- **Logs** live in the platform log dir, deliberately OUTSIDE `~/.juggler/`:
  macOS `~/Library/Logs/Juggler/`, Linux `$XDG_STATE_HOME/juggler/logs/`,
  Windows `%LOCALAPPDATA%\Juggler\Logs\`. `JUGGLER_LOG_DIR` overrides the dir
  (tests use it). Layout, rotation, and retention: `docs/logging.md`; code in
  `internal/logpaths` + `internal/jlog`.
- **Config** (`internal/userpaths`): `ConfigDir()` = `~/.juggler` is the single
  source of truth. Durable state (credentials, sessions, extensions) lives
  directly under it; regenerable ephemera under `CacheDir()` =
  `~/.juggler/cache/`. Doc: `docs/config-directory.md`.

## Vendored forks

`3rdparty/wails` is a git submodule (`go.mod` `replace` points at it). After a
fresh clone: `git submodule update --init --recursive`. It's shallow by default;
unshallow before rebasing onto upstream. Keep the branch upstream-PR-ready — no
juggler-specific references.
