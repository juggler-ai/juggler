# Git Worktrees — a Juggler extension

Reference extension for [issue #51](https://github.com/juggler-ai/juggler/issues/51):
worktrees implemented **as an extension**, not baked into the core app.

Worktree isolation is an **Environment** capability — "where does this
conversation's work physically happen" — which is **orthogonal to the Strategy
axis** (loop autonomy: read-only / default / yolo). You pick an environment AND a
strategy independently, so you can run a worktree with any autonomy level.
Bundling worktrees into a Strategy would consume the single strategy slot and
wrongly force "isolated" vs "yolo/read-only" to be one choice.

Selecting the **Worktree** environment for a conversation makes it work inside
its own dedicated `git worktree` (branch `juggler/conv-<id>`) for **every git
repository under the project** — the root repo plus any nested repos/submodules —
so two conversations (side-tabs) editing the same repos never clobber each
other's files or index.

## How it works

It relies on a single small primitive that this branch adds to the extension
API — `this.bindWorkspace(sourceRoot, workspaceRoot)` (also `juggler/ops` →
`bindWorkspace`). The environment:

1. On activation, discovers every repo under the project and runs
   `git worktree add` (via the `shell` op) for each.
2. Calls `bindWorkspace(repoRoot, worktreePath)` once per repo. Core routes each
   file/shell/search/tree op to the worktree of whichever repo the path belongs
   to (longest-prefix match), so a conversation spanning several repos gets each
   one isolated.

Core never learns what a "worktree" is: it only remaps paths per bound source.
The same primitive would let someone write a devcontainer, remote-dev, or
ephemeral-sandbox extension. Binding *per source directory* (rather than one
session cwd, as t3code does) is what makes the multi-repo case work.

See `docs/design/worktrees-as-extension.md` for the full design and diagrams.

## Install (development)

This ships as an *example*, not an auto-enabled built-in (worktrees are opt-in).
Install it like any third-party extension:

```bash
juggler ext link ./examples/extensions/juggler-worktrees
```

Then pick **Worktree** from the environment selector for any conversation whose
project is a git repository (independently of its strategy).

## Status

**WIP / proof-of-concept.** The `Environment` capability type is new in this
branch. What's done vs. remaining:

- **Done & verified:** the core primitive (`bindWorkspace` + `WorkspaceRegistry`
  + `PathScope.WithRemap`, incl. multi-repo longest-prefix routing), the SDK
  `EnvironmentType` base class, and manifest `provides.environments`.
- **Remaining (WIP, needs the engine/UI):** the worker→engine dispatch of the
  environment lifecycle hooks (`onActivate`/`onDeactivate`/`onTeardown`,
  analogous to the existing strategy-hook dispatch), the registry registration
  of environment capabilities, and an `environment-selector` UI beside the
  strategy selector. Until those land, the binding is exercised via the core
  mechanism/tests rather than the live selector.

See `docs/design/worktrees-as-extension.md`.
