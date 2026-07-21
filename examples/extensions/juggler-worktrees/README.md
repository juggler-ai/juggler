# Git Worktrees — a Juggler extension

Reference extension for [issue #51](https://github.com/juggler-ai/juggler/issues/51):
worktrees implemented **as an extension**, not baked into the core app.

It's a **lifecycle module** (manifest `provides.lifecycle`) — a plain module whose
default export is a hooks object the host calls per conversation. That's lighter
than a capability class: no class, no selector, no per-conversation id. Opt-in is
**per project** — enable this extension and every conversation in the project
runs in worktrees. It's orthogonal to the Strategy axis (loop autonomy:
read-only / default / yolo), so it composes with any strategy.

With it enabled, each conversation works inside its own dedicated `git worktree`
(branch `juggler/conv-<id>`) for **every git repository under the project** — the
root repo plus any nested repos/submodules — so two conversations (side-tabs)
editing the same repos never clobber each other's files or index.

## How it works

It relies on one small primitive this branch adds — `juggler/ops` →
`bindWorkspace(conversationId, sourceRoot, workspaceRoot)`. The module's
`onConversationActivated` hook:

1. Discovers every repo under the project and runs `git worktree add` (via the
   `shell` op) for each.
2. Calls `bindWorkspace(convId, repoRoot, worktreePath)` once per repo. Core
   routes each file/shell/search/tree op to the worktree of whichever repo the
   path belongs to (longest-prefix match), so a conversation spanning several
   repos gets each isolated.

`onConversationDeleted` unbinds and best-effort removes the clean worktrees.

Core never learns what a "worktree" is: it only remaps paths per bound source.
The same primitive would let someone write a devcontainer, remote-dev, or
ephemeral-sandbox lifecycle module. Binding *per source directory* (rather than
one session cwd, as t3code does) is what makes the multi-repo case work.

See `docs/design/worktrees-as-extension.md` for the full design and diagrams.

## Install (development)

Install it like any third-party extension:

```bash
juggler ext link ./examples/extensions/juggler-worktrees
```

Then enable it for the project (Settings → Extensions). Every conversation in a
git project then runs in worktrees, at any strategy.

## Status

**WIP / proof-of-concept.** What's done vs. remaining:

- **Done & verified:** the core primitive (`bindWorkspace` + `WorkspaceRegistry`
  + `PathScope.WithRemap`, incl. multi-repo longest-prefix routing), the SDK
  lifecycle contract (`juggler/lifecycle`), manifest `provides.lifecycle`, and
  the host-side loader `runExtensionLifecycleHook`.
- **Remaining (WIP, needs the running engine):** the single call-site that
  invokes `runExtensionLifecycleHook('onConversationActivated', …)` when the
  engine first activates a conversation (and `'onConversationDeleted'` on delete).
  Until that call is wired, the binding is exercised via the core mechanism/tests
  rather than the live engine.

See `docs/design/worktrees-as-extension.md`.
