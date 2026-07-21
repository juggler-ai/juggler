//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @module juggler-worktrees/worktree-strategy-type
 *
 * Reference extension for issue #51 — "worktrees as an extension, not baked
 * into the core app." It demonstrates the ONE new core primitive this needs:
 * `this.bindWorkspace(sourceRoot, workspaceRoot)` (SDK: `juggler/ops` →
 * `bindWorkspace`), which redirects a conversation's file/shell/search/tree ops
 * on a path under `sourceRoot` into `workspaceRoot`. Core knows nothing about
 * git worktrees; all of that policy lives here.
 *
 * Selecting the "Worktree" strategy makes the conversation work inside a
 * dedicated `git worktree` (branch `juggler/conv-<id>`) for EVERY git repository
 * found under the project — the root repo plus any nested repos/submodules — so
 * two conversations editing the same repos never clobber each other. Binding one
 * source→workspace pair per repo is what lets a single conversation span more
 * than one repository, each in its own worktree; t3code's single whole-session
 * cwd cannot express that.
 */

import StrategyType from 'juggler/strategy-type';
import { shell } from 'juggler/ops';

/**
 * Shell script that discovers every git repository under the project, ensures a
 * per-conversation worktree for each, and prints one `sourceRoot<TAB>worktree`
 * line per repo. Runs in the PROJECT root (no workspace is bound yet), so
 * discovery and `git worktree add` operate on the real repositories. Idempotent:
 * re-selecting the strategy (or a reload) reuses existing worktrees.
 * @param {string} convShort - Short conversation id (branch/dir suffix).
 * @returns {string} A `sh` script.
 */
function ensureWorktreesScript(convShort) {
  return `
set -e
proj=$(pwd)
# Discover repo toplevels under the project (root repo + nested repos/submodules),
# bounded in depth and pruned of heavy dirs. A .git entry (dir or file) marks a repo root.
find "$proj" -maxdepth 4 -name .git \\
  -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.juggler/*' 2>/dev/null \\
  | while IFS= read -r g; do dirname "$g"; done | sort -u \\
  | while IFS= read -r top; do
      [ -n "$top" ] || continue
      name=$(basename "$top")
      h=$(printf '%s' "$top" | cksum | cut -d' ' -f1)
      base="$HOME/.juggler/worktrees/$name-$h"
      wt="$base/conv-${convShort}"
      branch="juggler/conv-${convShort}"
      mkdir -p "$base"
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

class WorktreeStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'worktree',
    name: 'Worktree',
    version: '0.1.0',
    description:
      'Run this conversation in its own git worktree of every repo under the project, so parallel conversations never clobber each other.',
    author: 'Juggler community',
    icon: '🌳',
    // Autonomy is unchanged from Default — this strategy only relocates where
    // work happens, it does not change what gets auto-approved.
    showsApprovalControls: true
  };

  /**
   * When this strategy becomes active, ensure a dedicated git worktree exists for
   * every repository under the project and bind each one, so from here on every
   * file/shell/search/tree op in this conversation runs in the matching
   * worktree, while paths are still validated against the real project root.
   * @returns {Promise<void>}
   */
  async onActivate() {
    const convId = this.messageThread.conversationId;
    const convShort = String(convId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';

    let pairs = [];
    try {
      const res = await shell({ command: ensureWorktreesScript(convShort), timeout: 120000 });
      if (!res || res.success === false) {
        this.injectGuidance(
          `WORKTREE: could not set up git worktrees (${res?.error || res?.stderr || 'unknown error'}). ` +
            `Working directly in the project instead.`
        );
        return;
      }
      pairs = String(res.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split('\t'))
        .filter((parts) => parts.length === 2 && parts[0] && parts[1]);
    } catch (err) {
      this.injectGuidance(
        `WORKTREE: git worktree setup failed (${err instanceof Error ? err.message : String(err)}). ` +
          `Working directly in the project instead.`
      );
      return;
    }

    if (pairs.length === 0) return;

    const bound = [];
    for (const [sourceRoot, worktreeRoot] of pairs) {
      const res = await this.bindWorkspace(sourceRoot, worktreeRoot);
      if (res && res.ok) bound.push(sourceRoot);
    }

    if (bound.length > 0) {
      this.injectGuidance(
        `WORKTREE MODE: this conversation runs in isolated git worktrees on branch ` +
          `juggler/conv-${convShort} for ${bound.length} repo(s): ${bound.join(', ')}. ` +
          `Edits here don't touch other conversations' work. Merge a repo back with: ` +
          `git -C <repo> merge juggler/conv-${convShort}.`
      );
    }
  }
}

export default WorktreeStrategyType;
