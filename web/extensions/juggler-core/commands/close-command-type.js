//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Close command — close the current sub-thread with a generated summary,
 * optionally steered by the user's own words.
 *
 * A thread only closes when the model calls `return_result` (that call is what
 * writes the thread's `result`). A plain message into a thread never forces that
 * call, so "close this, noting X" just runs a normal turn and the thread stays
 * open. This command routes through `MessageThread.close(summaryText)`, which
 * appends the explicit return_result instruction (and preempts any in-flight
 * turn), so the close is reliable:
 *
 *   /close                        → auto-summary, same as the footer button
 *   /close <message>              → summary steered by <message>, e.g.
 *                                   "/close user says this was already checked,
 *                                    no findings, not worth fixing"
 *
 * The message is woven into the summarization prompt, not posted as a separate
 * turn, so the words end up reflected in the returned summary.
 */
class CloseCommandType extends CommandType {
  static MANIFEST = {
    id: 'close',
    name: 'Close thread with summary',
    version: '1.0.0',
    description: 'Close this thread with a generated summary (optionally steered by a message)',
    icon: 'icon-check',
    // Ghost-text hint; declaring it leaves the caret after accept so the user
    // can type the steering message inline.
    argsHint: '[message]'
  };

  /**
   * Execute the close command
   * @param {string[]} args - Optional steering message for the summary
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(args) {
    const mt = this.messageThread;
    // Root conversations have no threadItemId — there is nothing to return a
    // result to. close() would no-op silently, so say why instead.
    if (!mt?.threadItemId) {
      return { handled: true, message: '/close only works inside a sub-thread', error: true };
    }
    // close() weaves the message into the summary prompt and forces
    // return_result; empty args → plain auto-summary (the footer button's path).
    // It preempts any in-flight turn itself, so no mutatesConversation guard.
    await mt.close(args.join(' '));
    return { handled: true };
  }
}

export default CloseCommandType;
