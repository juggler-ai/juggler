//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Commands manager - open the Slash commands settings page.
 *
 * The page lists every slash command — the user's own, by where they are saved,
 * then the built-ins — and edits, deletes and creates the user's own. It is a
 * host UI surface, so this command only declares the intent via a side effect.
 */
class CommandsCommandType extends CommandType {
  static MANIFEST = {
    id: 'commands',
    name: 'Manage Commands',
    version: '1.0.0',
    description: 'Browse slash commands, and create or edit your own',
    icon: 'icon-slash',
  };

  /**
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute() {
    return { handled: true, sideEffects: [{ type: 'openCommandManager' }] };
  }
}

export default CommandsCommandType;
