//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_SCOPE, normalizeGitPinParameters, normalizeScope, treeKeyOf, turnConversation } from '../lib/git-scope.js';

/** @type {import('juggler/pinboard-item-type').PinAgentDescriptor} */
export default {
  id: 'git',
  description: 'The git working tree — branch, status, changed files — of the project, or of the workspace the visible conversation works in, for review. Optionally scoped to another comparison: staged changes, a branch, a commit range.',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description: 'What to compare. A preset — @uncommitted (default: working tree against HEAD), @staged, '
          + '@unstaged, @branch (working tree against where the branch left main/master), @last (the last commit), '
          + '@turn (working tree against the start of your current turn: what this turn changed) — '
          + 'or a git diff expression: main...HEAD, main..feature, HEAD~3, --merge-base main, --cached [rev], --worktree.',
      },
      workspace: {
        type: 'string',
        description: 'A workspace id whose tree to show. Omit it to follow the workspace the visible conversation works in.',
      },
    },
    required: [],
  },
  normalize: normalizeGitPinParameters,
  identity: (parameters) => {
    const scope = normalizeScope(parameters?.scope);
    const conv = turnConversation(parameters);
    const named = scope === DEFAULT_SCOPE ? '' : conv ? `${scope}\u0000${conv}` : scope;
    const tree = treeKeyOf(parameters);
    return tree ? `${tree}\u0000${named}` : named;
  },
};
