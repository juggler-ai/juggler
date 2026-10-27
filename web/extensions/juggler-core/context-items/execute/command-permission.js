//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The `execute` permission domain, shared by every plugin that runs a shell
 * command (the bash tool and the Monitor tool). Both ask the same two
 * questions of the same conversation state, so both ask them here rather than
 * hand-copying the wiring: which grants apply, and does the static analyser in
 * `./command-approval.js` accept the command under them.
 * @module juggler-core/context-items/execute/command-permission
 */

import { isCommandAutoApproved, isCatastrophicDeletion } from './command-approval.js';

/**
 * Is this shell command already permitted by the conversation's `execute`
 * rules? Pulls the user's enabled `glob` rules plus the conversation's
 * allowed-paths list and defers to the static analyser.
 * @param {string} command - The shell command to judge
 * @param {object} opts - Conversation state
 * @param {any} opts.messageThread - Owning message thread (source of rules + allowed paths)
 * @param {any} opts.session - Owning session (platform + home)
 * @param {boolean} [opts.writeEnabled] - Whether file-writing is auto-approved,
 *   which lets a redirect into an allowed path be stripped as a permitted
 *   output destination. Monitor never enables it: it only tails output.
 * @returns {boolean} True when the command auto-approves
 */
export function isShellCommandPermitted(command, { messageThread, session, writeEnabled = false }) {
  if (!command || !messageThread) return false;
  return isCommandAutoApproved(command, shellApprovalContext(messageThread, session, writeEnabled));
}

/**
 * What the analyser judges a command against, for this conversation: the one
 * reading of the conversation's state that permission, the "Don't ask again"
 * suggestions and the user's edits to them all share.
 *
 * They have to share it. A suggestion is only worth offering if adding it makes
 * {@link isShellCommandPermitted} true, and that is checked by a dry run of the
 * analyser — so a dry run fed a different directory or different roots proves
 * nothing about the check that will actually be made.
 * @param {any} messageThread - Owning message thread (source of rules, allowed paths, working root)
 * @param {any} session - Owning session (platform, home, project path)
 * @param {boolean} [writeEnabled] - Whether file-writing is auto-approved
 * @returns {{platform: string, home: string, cwd: string, allowedRoots: string[], patterns: string[], writeEnabled: boolean}} The analyser's options
 */
export function shellApprovalContext(messageThread, session, writeEnabled = false) {
  return {
    platform: session?.platform || 'darwin',
    home: session?.home || '',
    // The server runs every shell command at the scope ROOT, which is the
    // workspace root for a conversation bound to one and the project path for
    // one that is not. That is the directory a relative path — and a leading
    // `cd` — has to be judged against: named the project here, a bound
    // conversation's commands would be approved against a tree they will not
    // run in.
    cwd: workingRootOf(messageThread, session),
    allowedRoots: shellRoots(messageThread, session),
    patterns: (messageThread?.getRulesFor?.('execute') || [])
      .filter((/** @type {any} */ r) => r.kind === 'glob')
      .map((/** @type {any} */ r) => /** @type {string} */ (r.value)),
    writeEnabled
  };
}

/**
 * The directory the server will run this conversation's commands in.
 * @param {any} messageThread - Owning message thread
 * @param {any} session - Owning session
 * @returns {string} The working root, or '' when nothing can say
 */
export function workingRootOf(messageThread, session) {
  return messageThread?.getWorkingRoot?.() || session?.projectPath || '';
}

/**
 * The roots a command's paths are judged against, mirroring the scope the
 * server builds for the same request: rooted at the workspace, with the read
 * boundary widened by the project.
 *
 * The widening matters as much as the rooting. A conversation in a worktree
 * goes on reading the tree it branched from — the server allows it explicitly —
 * so leaving the project out would have it asking permission to read the main
 * tree from the moment it moved.
 * @param {any} messageThread - Owning message thread (source of allowed paths)
 * @param {any} session - Owning session (source of the project path)
 * @returns {string[]} Allowed roots
 */
function shellRoots(messageThread, session) {
  const roots = messageThread?.getAllowedPaths?.() || [];
  const projectPath = session?.projectPath || '';
  if (!projectPath || roots.includes(projectPath)) return roots;
  return [...roots, projectPath];
}

/**
 * Is this a recursive/forced delete of a catastrophic radius — a tree the
 * conversation works in, an ancestor of one, the home dir, or a filesystem
 * root? Such a command must never be silently auto-approved: not by the
 * conversation auto-approve toggle and not by a strategy's out-of-band
 * reviewer. Every other command — including a routine `rm -rf ./build` — stays
 * auto-approvable.
 *
 * TWO trees are protected for a conversation bound to a workspace, because it
 * can reach both and losing either is the same kind of bad day. The workspace
 * is where its commands run, so a delete aimed at the workspace root is the one
 * the analyser is most likely to be asked to wave through; the project is the
 * tree it branched from and every other conversation is still working in.
 * Protecting only the tree it happens to stand in would make moving a
 * conversation a way to make wiping the other one routine.
 *
 * The analyser guards one radius per call, so it is asked once per tree and the
 * answers are OR-ed. Both calls resolve relative targets against the directory
 * the command actually runs in.
 * @param {string} command - The shell command to judge
 * @param {object} opts - Conversation state
 * @param {any} opts.messageThread - Owning message thread (source of the working root)
 * @param {any} opts.session - Owning session (platform, home, project path)
 * @returns {boolean} True only for a catastrophic-radius recursive delete
 */
export function isShellCommandCatastrophic(command, { messageThread, session }) {
  if (!command) return false;
  const cwd = workingRootOf(messageThread, session);
  const base = {
    platform: session?.platform || 'darwin',
    home: session?.home || '',
    cwd
  };
  const projectPath = session?.projectPath || '';
  const roots = cwd && cwd !== projectPath ? [cwd, projectPath] : [projectPath];
  return roots.some(root => !!root && isCatastrophicDeletion(command, { ...base, projectRoot: root }));
}
