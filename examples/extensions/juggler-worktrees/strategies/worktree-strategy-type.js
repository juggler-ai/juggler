//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @module juggler-worktrees/worktree-strategy-type
 *
 * Reference extension for issue #51 — "worktrees as an extension, not baked
 * into the core app." It demonstrates the ONE new core primitive this needs:
 * `this.bindWorkspace(root)` (SDK: `juggler/ops` → `bindWorkspace`), which
 * redirects a conversation's file/shell/search/tree ops into an alternate
 * execution root the extension prepares. Core knows nothing about git worktrees;
 * all of that policy lives here.
 *
 * Selecting the "Worktree" strategy for a conversation makes that conversation
 * work inside its own dedicated `git worktree` on a `juggler/conv-<id>` branch,
 * so two conversations (side-tabs) editing the same repo never clobber each
 * other. The same primitive would let someone write a devcontainer, remote-dev,
 * or ephemeral-sandbox extension — the workflow the maintainer wanted to enable
 * without hard-coding worktrees.
 */

import StrategyType from 'juggler/strategy-type';
import { shell } from 'juggler/ops';

/**
 * Build the shell script that ensures a per-conversation worktree exists and
 * prints its absolute path on the last stdout line. Idempotent: re-selecting the
 * strategy (or a reload) reuses the existing worktree for this conversation.
 * @param {string} convShort - Short conversation id (branch/dir suffix).
 * @returns {string} A `sh` script.
 */
function ensureWorktreeScript(convShort) {
  // Runs in the PROJECT root (no workspace is bound yet), so `git worktree add`
  // operates on the main repository. A self-contained .juggler/.gitignore keeps
  // Juggler's own metadata out of the worktree's diff.
  return `
set -e
top=$(git rev-parse --show-toplevel)
name=$(basename "$top")
base="$HOME/.juggler/worktrees/$name"
wt="$base/conv-${convShort}"
branch="juggler/conv-${convShort}"
mkdir -p "$base"
if [ ! -d "$wt" ]; then
  if git -C "$top" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$top" worktree add "$wt" "$branch"
  else
    git -C "$top" worktree add -b "$branch" "$wt" HEAD
  fi
fi
mkdir -p "$wt/.juggler"
printf '*\\n' > "$wt/.juggler/.gitignore"
printf '%s\\n' "$wt"
`;
}

class WorktreeStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'worktree',
    name: 'Worktree',
    version: '0.1.0',
    description:
      'Run this conversation inside its own git worktree so parallel conversations never clobber each other.',
    author: 'Juggler community',
    icon: '🌳',
    // Autonomy is unchanged from Default — this strategy only relocates where
    // work happens, it does not change what gets auto-approved.
    showsApprovalControls: true
  };

  /**
   * When this strategy becomes active on a conversation, ensure a dedicated git
   * worktree exists and bind the conversation's execution root to it. From here
   * on every file/shell/search/tree op in this conversation runs in the
   * worktree, while paths are still validated against the real project root.
   * @returns {Promise<void>}
   */
  async onActivate() {
    const convId = this.messageThread.conversationId;
    const convShort = String(convId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';

    let worktreePath = '';
    try {
      const res = await shell({ command: ensureWorktreeScript(convShort), timeout: 60000 });
      if (!res || res.success === false) {
        this.injectGuidance(
          `WORKTREE: could not create a git worktree (${res?.error || res?.stderr || 'unknown error'}). ` +
            `Working directly in the project instead.`
        );
        return;
      }
      worktreePath = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    } catch (err) {
      this.injectGuidance(
        `WORKTREE: git worktree setup failed (${err instanceof Error ? err.message : String(err)}). ` +
          `Working directly in the project instead.`
      );
      return;
    }

    if (!worktreePath) return;

    const bound = await this.bindWorkspace(worktreePath);
    if (bound && bound.ok) {
      this.injectGuidance(
        `WORKTREE MODE: this conversation runs in an isolated git worktree at ${worktreePath} ` +
          `(branch juggler/conv-${convShort}). Edits here don't touch other conversations' work. ` +
          `Merge back with: git -C <repo> merge juggler/conv-${convShort}.`
      );
    }
  }
}

export default WorktreeStrategyType;
