# Contributing to Juggler

Thanks for your interest. This document covers the basics. The authoritative
engineering guide — architecture, concurrency, Yjs invariants, and the
submodule-fork workflow — is [`AGENTS.md`](AGENTS.md).

## Setup

Juggler needs:

- **Go 1.27+** — the only requirement for compiling.
- **A recent Node toolchain** — for the JS/CSS linters and the frontend
  type-check. `make lint`, `make build` and `make test-full` need it; `make
  go-build` and `make test` don't. The first lint run installs the toolchain
  into `tooling/node_modules` itself.
- **On Linux, the GTK4 development packages** — the server links GTK4 +
  WebKitGTK 6.0 through cgo, so the headers must be present at build time:

  ```bash
  sudo apt-get install -y libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev
  ```

  (Fedora: `gtk4-devel webkitgtk6.0-devel libsoup3-devel`; Arch: `gtk4
  webkitgtk-6.0 libsoup3`.) Without them the build fails in pkg-config before
  it compiles anything. Running the tests on a machine with no display
  additionally needs Xvfb; the server itself needs no display when Node.js is
  available — see
  [`docs/headless-linux.md`](docs/headless-linux.md).

Clone with submodules so the vendored Wails fork is populated:

```bash
git clone --recurse-submodules https://github.com/juggler-ai/juggler
cd juggler
make go-build
```

If you already cloned without submodules, run `git submodule update --init --recursive`.

## Building and running

```bash
make go-build    # Build the Go binaries only — no linters, no Node
make build       # Lint + build all Go binaries (bin/juggler, bin/juggler-app, bin/juggler-test)
make dev         # Build, then run the server against on-disk assets
make help        # Every target, including the packaging ones
```

On macOS the binaries land inside `bin/Juggler.app`, with `bin/juggler` and
`bin/juggler-app` as symlinks into the bundle; elsewhere they're plain files in
`bin/`. `make mac-dmg`, `make win-installer` and `make linux-tarball` build the
distributable packages (unsigned).

Juggler is two binaries: `cmd/juggler` is the headless **server** (HTTP/WS plus
the hidden engine WebView), and `cmd/juggler-app` is the multi-window **desktop
app** (`bin/Juggler.app`). The desktop app is a pure viewer that talks to a
server over HTTP/WebSocket. See the Architecture section of
[`AGENTS.md`](AGENTS.md) for the full split.

## Tests

`make test` runs the whole suite (Go unit, integration, and browser tests) and
skips linting for a fast inner loop. No API keys required.

```bash
make test                      # Full suite, no linting
make test RUN='TestDiffView'   # One test by name regex, across whichever layer it lives in
make test-full                 # Lint + full suite — run this before opening a PR
```

`make test RUN='<regex>'` is the supported way to run a single test; it flips on
`-v` and tees output to `bin/test*.log`. Don't invoke `go test`, `node`, or the
browser harness by hand.

## Linting

```bash
make lint         # Go + JS type-check + JS lint + CSS
make lint-types   # TypeScript type-check of the frontend only
```

CI runs the same lints. Fix lint errors locally before pushing; don't use
`--no-verify` to skip hooks.

CI here is a sanity gate only — lint, build, and tests on hosted runners, with
no secrets. Official signed binaries are built and published to the
[Releases](https://github.com/juggler-ai/juggler/releases) page by the
maintainer's separate release pipeline, so green CI never produces release
artifacts.

### The frontend is type-checked JavaScript, not TypeScript

`web/` is plain JavaScript with types expressed as JSDoc annotations, but it is
**fully type-checked**: `make lint-types` runs `tsc` against
`tooling/jsconfig.json` with `checkJs` and `strict` on. The frontend gets the
same checker, inference, and editor tooling as a `.ts` codebase with no build or
transpile step between source and what ships. Type errors fail `make lint`, so
keep your JSDoc honest — new frontend code is expected to type-check clean.

## Commit and PR style

- One logical change per commit; rebase noise out before opening the PR.
- Commit subjects: short imperative ("Fix CI", "Bump Node versions for CI") —
  match the style in `git log`.
- After a failing pre-commit hook, make a new commit rather than amending: the
  failed commit never happened, so `--amend` would rewrite the previous one.
- Add tests for behaviour changes. Prefer browser integration tests under
  `tests/integration/` over Go unit tests for anything with a UI surface.

## Repository layout

- **`docs/`** is published, user-facing documentation only — not plans, working
  notes, or temporary files.
- WIP planning docs and scratch notes go in **`scratch/`** (git-ignored).
  Promote a doc into `docs/` only once it's meant for users.

## Architecture conventions

A few conventions you'll be held to in review; full rationale is in
[`AGENTS.md`](AGENTS.md).

- **Concurrency**: goroutines and channels, not mutexes. The one sanctioned
  `sync.Mutex` is `ycrdtMu` (the y-crdt C binding isn't goroutine-safe); any
  other mutex will be flagged.
- **Yjs invariants**: when two pieces of CRDT state must co-vary, encode the
  relationship as a reactive observer, not in a click handler.
- **Plugins** drive behaviour by mutating the Yjs document; they don't call
  `workerManager` directly.
- **Render callbacks** never perform state changes — fire events from the action
  site instead.
- **The server stays windowless**: `cmd/juggler` creates only the hidden engine
  WebView in production. Visible windows belong to `cmd/juggler-app`.

## Vendored fork (`3rdparty/wails`)

The Wails fork is a git submodule wired in through a `go.mod` `replace`
directive; the submodule pointer is the source of truth. Its local patches,
their upstream status and the rebase procedure are in
[`docs/wails-fork.md`](docs/wails-fork.md).

## Licensing and contributor agreements

The repo carries two licenses — AGPL-3.0-or-later for the application and
Apache-2.0 for `web/sdk/**` and `web/extensions/**`; see
[`LICENSING.md`](LICENSING.md). A contribution remains publicly available under
the license of the directory it lands in. The contributor agreements also let
Julian Storer and a qualifying successor license contributions commercially,
including in proprietary Juggler editions. Contributors retain their copyright.

Contributing involves two separate requirements: a one-time **Contributor
License Agreement**, which grants distribution and patent rights, and a
per-commit **Developer Certificate of Origin sign-off**, which certifies the
provenance of each change.

### Individual Contributor License Agreement

Before your first contribution can be merged, sign
[Juggler ICLA version 1.0](CLA.md). You sign once, not once per pull request.
The CLA check comments on your first PR with the exact statement to post from
your GitHub account. The statement identifies the agreement version and acts as
your electronic signature. Save the agreement and signing comment for your
records.

Every author whose commits appear in a PR must be covered. If a force-push adds
an author who has not signed, the check returns to pending. Unknown or
unverifiable authors must resolve their coverage before merge.

The ICLA does not transfer ownership. It permits open-source and proprietary
licensing while committing that a contribution included in the public Project
will remain available under the open-source license that covered its destination
when submitted.

### Contributions connected to a company

If an employer or another entity may own your work, both layers must be covered:
you sign the ICLA, and an authorized representative of the entity executes the
[Corporate Contributor License Agreement](CCLA.md). Contact
`info@juggler.studio` to arrange private execution and authorization of your
GitHub identity. Do not post a signed CCLA, company address, or employee roster
in a public issue or pull request.

The automated CLA check records individual signatures. Corporate agreements and
rosters are verified separately; a green individual CLA check does not by
itself prove company authorization. Tell the maintainer in the PR if corporate
coverage applies.

Contributor-agreement records are handled as described in
[`CONTRIBUTOR-AGREEMENT-PRIVACY.md`](CONTRIBUTOR-AGREEMENT-PRIVACY.md).

### Sign your work

Every commit must carry a `Signed-off-by:` line certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) — that
you wrote the change, or otherwise have the right to submit it under the
applicable open-source license:

```bash
git commit -s
```

This appends `Signed-off-by: Your Name <you@example.com>` from your Git
`user.name` and `user.email`. The sign-off must match that commit’s author name
and email. If you forgot it, recreate or amend your unmerged commit with a valid
sign-off before pushing. PRs containing unsigned commits fail the DCO check and
cannot be merged.

The DCO and ICLA are deliberately separate: DCO records provenance for every
commit; the ICLA supplies the standing rights needed for open and commercial
distribution.

## Reporting bugs

Open an issue using the bug template. For security issues, see
[`SECURITY.md`](SECURITY.md) — please don't file them as public issues.
