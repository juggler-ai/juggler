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
  `-v`, so its output already is the summary; it is also teed to `bin/test.log`.
- **To run one specific test, pass `RUN='<regex>'`** — a `go test -run` pattern
  matched against test-function names. It also turns on `-v` so you see that
  test's own output. This is the sanctioned way to iterate on a single test;
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

- **No mutexes.** Use goroutines + channels. The one sanctioned `sync.Mutex` is
  `ycrdtMu` in `cmd/juggler/worker/document.go` (y-crdt C binding isn't
  goroutine-safe). Any other mutex is a regression.
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
- **One process → one project, but each conversation gets its own worktree of
  every repo it touches.** The engine is a single, engine-wide tool executor
  shared by every conversation (side-tab), so two tabs each running an agent
  would otherwise edit one shared checkout and clobber each other. To isolate
  them, each **(conversation, repository)** pair gets its own dedicated linked
  **git worktree** on a `juggler/conv-<id>` branch — because one conversation may
  span several repos (a folder of services, a repo with nested submodules), each
  is isolated independently (`cmd/juggler/core/conv_worktree.go` — a
  channel-based `ConvWorktrees` actor; git plumbing in `worktree.go`). The
  mechanism is a **path remap**, not a whole-session re-root: a tool call carries
  a `conversationId` (JS side: every file/search/tree/shell op tags its params
  via `ContextItem._withConv`, hoisted to the transport by
  `callOp`/`sendShellStart`), and the Go `PathScope` (`ops/validation.go`)
  **validates each path in real-project space** (the security boundary is
  unchanged) then **redirects the resolved path into the conversation's worktree
  of whichever repo the path belongs to** (`Server.repoRemapper`). Ops
  (`ops_api.go`), the streaming shell (`websocket_loop.go`), and the git-status
  card (`git_status_api.go` + `?conversationId=`, scanning each discovered repo
  in the conversation's checkout) all flow through the remap. Search/tree ops
  search the worktree but report **project-relative** paths so the agent's reads
  remap back consistently. Worktrees live under
  `ConfigDir()/worktrees/<repo>-<hash>/conv-<id>`; a conversation re-adopts its
  worktrees across restarts, a permanent delete prunes each only if pristine, and
  a worktree-local `.juggler/.gitignore` keeps metadata out of the diff. A path
  in no repo under the project (a loose file), an empty convID, a non-git
  project, or the feature disabled ⇒ the real path unchanged, so nothing changes
  for those. Toggle with `project.worktree` in config or
  `--worktree`/`--no-worktree` (test mode forces it off for a stable root).
  Project-shared state (the memory file) and viewer-only file previews
  deliberately stay on the base project root.

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
