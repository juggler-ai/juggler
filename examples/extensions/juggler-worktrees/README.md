# Git Worktrees — a Juggler extension

Reference extension for [issue #51](https://github.com/juggler-ai/juggler/issues/51):
worktrees implemented **as an extension**, not baked into the core app.

Selecting the **Worktree** strategy for a conversation makes that conversation
work inside its own dedicated `git worktree` on a `juggler/conv-<id>` branch, so
two conversations (side-tabs) editing the same repository never clobber each
other's files or index.

## How it works

It relies on a single small primitive that this branch adds to the extension
API — `this.bindWorkspace(root)` (also `juggler/ops` → `bindWorkspace`). The
strategy:

1. On activation, runs `git worktree add` (via the `shell` op) to create a
   per-conversation worktree.
2. Calls `bindWorkspace(worktreePath)` to redirect the conversation's
   file/shell/search/tree ops into that worktree.

Core never learns what a "worktree" is: it only remaps the conversation's
execution root. The same primitive would let someone write a devcontainer,
remote-dev, or ephemeral-sandbox extension.

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
