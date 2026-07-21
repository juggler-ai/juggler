# Git Worktrees — a Juggler extension

Reference extension for [issue #51](https://github.com/juggler-ai/juggler/issues/51):
worktrees implemented **as an extension**, not baked into the core app.

Selecting the **Worktree** strategy for a conversation makes that conversation
work inside its own dedicated `git worktree` (branch `juggler/conv-<id>`) for
**every git repository under the project** — the root repo plus any nested
repos/submodules — so two conversations (side-tabs) editing the same repos never
clobber each other's files or index.

## How it works

It relies on a single small primitive that this branch adds to the extension
API — `this.bindWorkspace(sourceRoot, workspaceRoot)` (also `juggler/ops` →
`bindWorkspace`). The strategy:

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

Then pick **Worktree** from the strategy selector for any conversation whose
project is a git repository.

## Status

**WIP / proof-of-concept.** Known gaps (see the design doc's "Open questions"):

- The workspace binding is in-memory per server process; there is no lifecycle
  hook yet to re-bind after a reload/restart, or to tear the worktree down when
  a conversation is deleted. Core clears the *mapping* on delete as a safety net,
  but the worktree itself is left on disk for manual `git worktree prune`.
- Isolation is per git repository under the project.
