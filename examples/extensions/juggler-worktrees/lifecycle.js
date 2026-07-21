//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @module juggler-worktrees/lifecycle
 *
 * Reference extension for issue #51 — "worktrees as an extension, not baked into
 * the core app." Implemented as a **lifecycle module** (manifest
 * `provides.lifecycle`): a plain module whose default export is a hooks object
 * the host invokes per conversation. This is lighter than a capability type — no
 * class, no selector, no per-conversation id — and opt-in is **per project**
 * (enable this extension). It is orthogonal to the Strategy axis (loop autonomy),
 * so it composes with read-only / default / yolo alike.
 *
 * On conversation activation it gives the conversation its own dedicated `git
 * worktree` (branch `juggler/conv-<id>`) for EVERY git repository under the
 * project — the root repo plus any nested repos/submodules. It binds one
 * source→workspace pair per repo (`juggler/ops` → `bindWorkspace`), which is what
 * lets one conversation span more than one repository, each isolated; a single
 * session cwd cannot. Core knows nothing about git — it only remaps ops onto the
 * bound roots.
 */

import { shell, bindWorkspace, unbindWorkspace } from 'juggler/ops';

/**
 * @param {string} convShort - Short conversation id (branch/dir suffix).
 * @returns {string} A `sh` script.
 */
function ensureWorktreesScript(convShort) {
  // Runs in the PROJECT root (no workspace bound yet), so discovery and
  // `git worktree add` operate on the real repositories. Prints one
  // `sourceRoot<TAB>worktree` line per repo. Idempotent.
  return `
set -e
proj=$(pwd)
find "$proj" -maxdepth 4 -name .git \\
  -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.juggler/*' 2>/dev/null \\
  | while IFS= read -r g; do dirname "$g"; done | sort -u \\
  | while IFS= read -r top; do
      [ -n "$top" ] || continue
      name=$(basename "$top")
      h=$(printf '%s' "$top" | cksum | cut -d' ' -f1)
      wt="$HOME/.juggler/worktrees/$name-$h/conv-${convShort}"
      branch="juggler/conv-${convShort}"
      mkdir -p "$(dirname "$wt")"
      if [ ! -d "$wt" ]; then
        if git -C "$top" show-ref --verify --quiet "refs/heads/$branch"; then
          git -C "$top" worktree add "$wt" "$branch" >/dev/null 2>&1 || continue
        else
          git -C "$top" worktree add -b "$branch" "$wt" HEAD >/dev/null 2>&1 || continue
        fi
      fi
      mkdir -p "$wt/.juggler"
      printf '*\\n' > "$wt/.juggler/.gitignore"
      printf '%s\\t%s\\n' "$top" "$wt"
    done
`;
}

/**
 * @param {string} convShort - Short conversation id (branch/dir suffix).
 * @returns {string} A `sh` script.
 */
function removeWorktreesScript(convShort) {
  // Best-effort teardown: remove each clean per-conversation worktree (no
  // --force, so worktrees holding uncommitted work are kept).
  return `
proj=$(pwd)
find "$proj" -maxdepth 4 -name .git \\
  -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.juggler/*' 2>/dev/null \\
  | while IFS= read -r g; do dirname "$g"; done | sort -u \\
  | while IFS= read -r top; do
      name=$(basename "$top")
      h=$(printf '%s' "$top" | cksum | cut -d' ' -f1)
      wt="$HOME/.juggler/worktrees/$name-$h/conv-${convShort}"
      [ -d "$wt" ] && git -C "$top" worktree remove "$wt" >/dev/null 2>&1 || true
    done
`;
}

/**
 * @param {string} conversationId - Full conversation id.
 * @returns {string} A filesystem-safe short id.
 */
function shortId(conversationId) {
  return String(conversationId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';
}

/** @type {import('juggler/lifecycle').LifecycleModule} */
export default {
  /**
   * Ensure a worktree exists for every repo under the project and bind each, so
   * every file/shell/search/tree op in this conversation runs in the matching
   * worktree. Paths are still validated against the real project root.
   * @param {import('juggler/lifecycle').LifecycleContext} ctx - Hook context.
   * @returns {Promise<void>}
   */
  async onConversationActivated(ctx) {
    const convShort = shortId(ctx.conversationId);
    let pairs = [];
    try {
      const res = await shell({ command: ensureWorktreesScript(convShort), timeout: 120000 });
      if (!res || res.success === false) return;
      pairs = String(res.stdout || '')
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('\t')).filter((pp) => pp.length === 2 && pp[0] && pp[1]);
    } catch {
      return; // fall back to the project checkout
    }
    for (const [sourceRoot, worktreeRoot] of pairs) {
      await bindWorkspace(ctx.conversationId, sourceRoot, worktreeRoot);
    }
  },

  /**
   * On conversation delete, unbind and best-effort remove the clean worktrees.
   * @param {import('juggler/lifecycle').LifecycleDeleteContext} ctx - Hook context.
   * @returns {Promise<void>}
   */
  async onConversationDeleted(ctx) {
    try {
      await shell({ command: removeWorktreesScript(shortId(ctx.conversationId)), timeout: 60000 });
    } catch {
      // best effort — leave worktrees for manual `git worktree prune`
    }
    await unbindWorkspace(ctx.conversationId);
  }
};
