//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @module juggler-worktrees/worktree-environment-type
 *
 * Reference extension for issue #51 — "worktrees as an extension, not baked
 * into the core app." Worktree isolation is an **Environment**, not a Strategy:
 * it answers "where does this conversation's work physically happen," which is
 * orthogonal to loop autonomy (read-only / default / yolo). So you can run a
 * worktree with ANY strategy — the two are independent selections.
 *
 * It demonstrates the one new core primitive this needs:
 * `this.bindWorkspace(sourceRoot, workspaceRoot)` (SDK: `juggler/ops` →
 * `bindWorkspace`), which redirects a conversation's file/shell/search/tree ops
 * on a path under `sourceRoot` into `workspaceRoot`. Core knows nothing about
 * git worktrees; all of that policy lives here.
 *
 * Selecting the "Worktree" environment makes the conversation work inside a
 * dedicated `git worktree` (branch `juggler/conv-<id>`) for EVERY git repository
 * under the project — the root repo plus any nested repos/submodules. Binding one
 * source→workspace pair per repo is what lets a single conversation span more
 * than one repository, each in its own worktree; a single session cwd cannot.
 */

import EnvironmentType from 'juggler/environment-type';
import { shell } from 'juggler/ops';

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
  // Best-effort teardown: remove each per-conversation worktree that is clean
  // (no --force, so worktrees holding uncommitted work are kept).
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

class WorktreeEnvironmentType extends EnvironmentType {
  static MANIFEST = {
    id: 'worktree',
    name: 'Worktree',
    version: '0.1.0',
    description:
      'Work in a dedicated git worktree per repo under the project, so parallel conversations never clobber each other.',
    author: 'Juggler community',
    icon: '🌳'
  };

  /**
   * Ensure a worktree exists for every repo under the project and bind each, so
   * every file/shell/search/tree op in this conversation runs in the matching
   * worktree. Paths are still validated against the real project root.
   * @returns {Promise<void>}
   */
  async onActivate() {
    const convShort = String(this.messageThread.conversationId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';
    let pairs = [];
    try {
      const res = await shell({ command: ensureWorktreesScript(convShort), timeout: 120000 });
      if (!res || res.success === false) return;
      pairs = String(res.stdout || '')
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('\t')).filter((p) => p.length === 2 && p[0] && p[1]);
    } catch {
      return; // fall back to the project checkout
    }
    for (const [sourceRoot, worktreeRoot] of pairs) {
      await this.bindWorkspace(sourceRoot, worktreeRoot);
    }
  }

  /**
   * On conversation delete, unbind and best-effort remove the clean worktrees.
   * @returns {Promise<void>}
   */
  async onTeardown() {
    const convShort = String(this.messageThread.conversationId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';
    try {
      await shell({ command: removeWorktreesScript(convShort), timeout: 60000 });
    } catch {
      // best effort — leave worktrees for manual `git worktree prune`
    }
    await this.unbindWorkspace();
  }
}

export default WorktreeEnvironmentType;
