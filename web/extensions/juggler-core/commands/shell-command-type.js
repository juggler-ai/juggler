//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * Shell command — `/shell <command>`, also typed as `! <command>`.
 *
 * Runs the command with no model call and adds its output to the conversation
 * as a `shell-output` context item, which the model reads with the user's next
 * message. The command only declares the run; the host performs it (it has the
 * socket the shell streams over, and the composer that shows it running).
 *
 * Deliberately neither `mutatesConversation` nor `rejectWhileBusy`: it never
 * stops a running turn, and output that finishes mid-turn is queued for the
 * next turn boundary like a message typed while busy.
 */
class ShellCommandType extends CommandType {
  static MANIFEST = {
    id: 'shell',
    name: 'Run Shell Command',
    version: '1.0.0',
    description: 'Run a shell command and add its output to the conversation, without asking the model (also: ! command)',
    icon: 'icon-terminal',
    argsHint: '<command>'
  };

  /**
   * @param {string[]} _args - Unused: the command line is taken verbatim
   * @param {string} [rest] - The command line as typed
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args, rest) {
    const command = (rest ?? '').trim();
    if (!command) {
      return {
        handled: true,
        message: t('Type the command to run after /shell or !, e.g. ! git status'),
        error: true
      };
    }
    return { handled: true, sideEffects: [{ type: 'runShell', data: { command } }] };
  }
}

export default ShellCommandType;
