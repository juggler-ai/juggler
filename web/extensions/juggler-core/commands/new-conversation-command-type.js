//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from 'juggler/ui';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * New Conversation command — open a fresh, empty conversation and
 * switch to it.
 *
 * This is a session-level operation: it creates an independent conversation rather
 * than mutating the current one, so it deliberately does NOT set
 * `mutatesConversation` — opening a new conversation must never cancel a turn running in
 * the current conversation. Conversation management is a Session concern, so the command reaches
 * the session through `messageThread.conversation.session` (the same surface
 * the duplicate/compact-new commands use).
 */
class NewConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'new',
    name: 'New Conversation',
    version: '1.0.0',
    description: 'Open a new, empty conversation',
    icon: 'icon-document'
  };

  /**
   * Execute the new-conversation command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const session = this.messageThread?.conversation?.session;
    if (!session) {
      return { handled: true, message: t("Can't create a conversation: this conversation has no session."), error: true };
    }

    try {
      // Empty name → session assigns the canonical "Untitled N". activate switches
      // the new conversation into view immediately. It works in the project
      // folder, like the "+" button's blank tab.
      await session.createConversation('', { activate: true, origin: 'slash-command' });
      return { handled: true };
    } catch (error) {
      return {
        handled: true,
        message: t("Couldn't create the conversation: {error}", { error: extractErrorMessage(error) }),
        error: true
      };
    }
  }
}

export default NewConversationCommandType;
