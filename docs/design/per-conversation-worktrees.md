# Per-conversation, per-repository git worktrees (t3code-style isolation)

Juggler hosts many conversations (side-tabs) in one process, and the engine is a
**single, engine-wide tool executor** shared by all of them. Left alone, two
tabs each running an agent edit the same working tree and clobber each other.
This gives every conversation its own dedicated git worktree — and, because one
conversation may touch more than one repository (a folder of service repos, a
repo with nested submodules), it isolates **each (conversation, repository) pair
independently**.

This follows the model t3code popularised — bind a thread to a worktree so its
cwd, terminals, diff view, git status and cleanup all move with it — and extends
it to the multi-repo case. (t3code itself keys worktrees by *branch + repository*
and namespaces cross-repo branches as `t3code/pr-<n>/…`; Juggler namespaces per
conversation as `juggler/conv-<id>`.)

## The constraint this had to solve

A tool call used to reach the Go layer with **no conversation identity**: the
engine's `callOp` (`web/js/services/ops-api.js`) POSTed
`{toolId, operation, params, allowedPaths}` to `/api/ops/call`, and the server
rebuilt the sandbox from one process-global project path. So the core work was
carrying `conversationId` from the tool down to the op, then redirecting each
resolved path into the right per-(conversation, repo) worktree.

## How it works — a path remap, not a whole-session re-root

Worktrees live at separate paths (`~/.juggler/worktrees/…`), but the agent
thinks in the real project layout. Rather than re-root the whole session (which
can't stay consistent when a conversation spans several repos at different
locations, and isn't portable), each **individual filesystem access** is
redirected at the moment it happens:

1. **Identity (JS).** Each tool knows its conversation. `ContextItem._withConv`
   tags op params with `conversationId`; `callOp` lifts it to a top-level
   transport field (and strips it from the op params), and the streaming shell
   passes it via `sendShellStart`. Every file/search/tree/shell tool tags its
   calls (read, write, edit, grep, glob, tree, bash, batch, explore_code,
   monitor); the git-status card sends `?conversationId=`. Project-shared state
   (the memory file) and viewer-only previews deliberately do **not** tag.

2. **Validate real, redirect execution (Go).** `PathScope`
   (`ops/validation.go`) stays rooted at the **real project** — containment
   checks and out-of-scope-write authorization run in real-project space, so the
   security boundary is unchanged. Its new `WithRemap` redirects the *resolved*
   path into the conversation's worktree of whichever repo it belongs to
   (`Server.repoRemapper` → `core.ConvWorktrees.Remap`). `file_ops.go` needs
   **zero** changes; search/tree ops search the worktree but report
   **project-relative** paths so the agent's subsequent reads remap back to the
   same worktree files; the shell's cwd is validated against the real root then
   redirected.

3. **The registry (`core/conv_worktree.go`).** A channel-based actor (the repo
   lint forbids `sync.Mutex`) keyed by `(convID, repoTop)`:
   - `Remap(convID, absPath)` — resolve the path's repository (the enclosing repo
     under the project, catching nested repos/submodules; a loose non-git file
     stays shared), ensure that repo's worktree on first use, and rewrite the
     path into it. Idempotent and race-safe: the actor serialises check-then-
     create so concurrent ops for one (conversation, repo) trigger exactly one
     `git worktree add`.
   - `WorktreeForRepo(convID, repoTop)` — used by the git-status card to scan
     each discovered repo in the conversation's checkout.
   - `Release(convID, permanent)` — on a permanent delete, prune every worktree
     of that conversation, each only if pristine (no uncommitted changes, no
     unmerged commits); a bin (soft delete) keeps them. Never discards work.

## Layout & opt-out

`~/.juggler/worktrees/<repo>-<hash>/conv-<slug>-<hash>` on branch
`juggler/conv-<slug>-<hash>`, off each repo's HEAD at first touch. A
worktree-local `.juggler/.gitignore` (`*`) keeps Juggler's metadata out of the
diff. On by default for git repos; off via `"project": {"worktree": false}`,
`--no-worktree` (or `--worktree` to force on), and automatically in `--test`
mode.

## Coverage note

Isolation is per **git repo under the project**. A project-wide operation issued
from a *non-git* parent folder — a grep across the whole folder, or a shell
command using absolute cross-repo paths — sees the real tree for the parts that
belong to no repo; git-tracked work is always isolated. This is the irreducible
cost of a portable (no symlink/bind-mount) redirect, and could be unioned later.

## Verification

- `core/worktree_test.go` runs against **real git**: single-repo redirect,
  multiple independent repos in one conversation, nested-repo-isolated-from-
  parent, project-inside-a-larger-repo, restart adoption, metadata-ignored,
  prune-if-pristine / keep-dirty / keep-soft-delete, `repoRootWithin` unit cases,
  config toggle.
- `ops/conv_remap_test.go` exercises a live remap end-to-end: a write lands in
  the worktree (not the real project), a read sees it, grep reports it
  project-relative, and an ordinary in-project write still authorizes without the
  out-of-root approval flag (the security ordering).
- Full `core` + `ops` + `server` + `handlers` + `app` suites pass on Go 1.26;
  `golangci-lint` (incl. the mutex ban) is clean; the JS changes pass `tsc` +
  `eslint`; the non-browser integration suite passes.
- The browser JS harness (`TestBrowser`) drives a real GTK4/WebKit window and
  needs a display that this environment's headless GTK stack can't provide; it's
  left to CI.
