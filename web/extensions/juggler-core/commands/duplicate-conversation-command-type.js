//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { translator } from 'juggler/i18n';
import { extractErrorMessage } from 'juggler/ui';

const t = translator('@juggler/core');

/**
 * Duplicate Conversation command — clone the current conversation into a new
 * conversation placed directly after the source, then switch to the clone. The source
 * is left intact.
 *
 * A running conversation is duplicated as it stands: the server snapshots the
 * live document and the clone loads stopped. Only `refuseWhileActive` callers
 * (/handoff) decline mid-turn. While a plain duplicate of the source is
 * already in flight, `Session.duplicateConversation` hands this command that
 * same copy rather than making a second; while a fork or handoff of it is, it
 * refuses. The session shows its own refusals as a warning, so this command
 * only adds its own message for genuine failures.
 *
 * Tab management is a Session concern, so the command reaches the session
 * through `messageThread.conversation.session`. "Duplicate then compact" is
 * `/duplicate` followed by `/compact`; there is no combined command.
 */
class DuplicateConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'duplicate',
    name: 'Duplicate Conversation',
    version: '1.0.0',
    description: 'Clone this conversation into a new one',
    icon: 'icon-box'
  };

  /**
   * Execute the duplicate command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const sourceConversation = this.messageThread?.conversation;
    const session = sourceConversation?.session;
    if (!session) {
      return { handled: true, message: t("Can't duplicate: no project is open."), error: true };
    }

    try {
      const newId = await session.duplicateConversation(sourceConversation.id);
      if (!newId) {
        // A null clone means the source vanished, or the session refused the
        // duplicate because a fork or handoff of it is in flight and has said
        // so itself. Treat as handled (not an error) so the slash handler stays
        // quiet.
        return { handled: true };
      }
      session.switchConversation(newId);
      return { handled: true };
    } catch (error) {
      return {
        handled: true,
        message: t("Couldn't duplicate: {error}", { error: extractErrorMessage(error) }),
        error: true
      };
    }
  }
}

export default DuplicateConversationCommandType;
