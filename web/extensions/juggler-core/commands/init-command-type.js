//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * What /init asks the agent to do. The model reads it, so it is English; the
 * user sees it too, as the message they sent, so it says plainly what it asks.
 */
export const INIT_PROMPT = markUntranslated(
  'Survey this project and draft an AGENTS.md at its root: the instructions an AI coding agent '
  + 'needs to work here without being told again in every conversation. Read the build files, '
  + 'CI configuration, README and a sample of the code first. Then cover how to build, test and '
  + 'lint it (the exact commands, and which to run while iterating and which before finishing), '
  + 'how the code is laid out, and the conventions a newcomer would get wrong. Keep it short and '
  + 'specific to this project, with no generic advice. If an AGENTS.md or CLAUDE.md already '
  + 'exists, improve it rather than replacing it.');

/**
 * Init command — have the agent draft an AGENTS.md for the project.
 *
 * It sends {@link INIT_PROMPT} as an ordinary user turn on this thread, so the
 * file is written the way any other is: by the agent, under the conversation's
 * own file-editing permission, where the user can see and approve it.
 */
class InitCommandType extends CommandType {
  static MANIFEST = {
    id: 'init',
    name: 'Draft an AGENTS.md',
    version: '1.0.0',
    description: 'Have the agent survey this project and draft an AGENTS.md for it',
    icon: 'icon-document',
  };

  /**
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute() {
    const thread = this.messageThread;
    if (!thread) return { handled: true, error: true, message: t('No conversation is open.') };
    await thread.conversation.sendMessage(INIT_PROMPT, thread.threadItemId ?? null, thread);
    return { handled: true };
  }
}

export default InitCommandType;
