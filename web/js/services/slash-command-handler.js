//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Slash Command Handler - Manages text-based slash commands
 * @module services/slash-command-handler
 */

import commandRegistry from '../registries/command-registry.js';
import { t } from '../../sdk/lib/i18n.js';
import { uiPort } from './ui-port.js';
import { recordUsage } from './guidance/usage-signals.js';

/**
 * @typedef {object} SlashCommandResult
 * @property {boolean} handled - Whether the command was recognized and executed
 * @property {string} [message] - Optional message to display to user
 * @property {boolean} [error] - Whether this was an error
 * @property {import('juggler/command-type').CommandSideEffect[]} [sideEffects] - Declarative side-effects
 */

/**
 * @typedef {object} SlashCommand
 * @property {string} name - Command name (without /)
 * @property {string} [label] - Display label for menu (defaults to capitalized name)
 * @property {string} description - Help text for the command
 * @property {boolean} [danger] - Whether this is a destructive action (for menu styling)
 * @property {string} [icon] - CSS class for menu icon (e.g. 'icon-trashcan')
 * @property {boolean} [userDefined] - Whether this is a user-defined (declarative) command
 * @property {string} [scope] - Provenance scope of a user command ('user' | 'project')
 * @property {string} [argsHint] - Ghost-text hint shown after accepting the command
 * @property {string} [extensionId] - Id of the extension that provides the command; its
 *   `label` and `description` are that extension's English, translated in its namespace
 */

/**
 * Split a typed invocation into the command name and its argument text.
 *
 * The name is the first whitespace-delimited token; everything after it is the
 * argument text, returned in both readings a command may want. `args` are its
 * whitespace-delimited tokens, feeding positional placeholders; `rest` is that
 * text exactly as typed, so line breaks, blank lines, indentation and fenced
 * code survive into a prompt template. Splitting the whole line into tokens and
 * re-joining them is what flattens a multi-line argument to one line.
 *
 * Pure function — the invocation grammar in one place, unit-tested.
 * @param {string} input - Full user input, leading `/` included
 * @returns {{name: string, args: string[], rest: string}} The parsed invocation
 */
export function parseInvocation(input) {
  const line = String(input).replace(/^\//, '');
  const [name = ''] = line.split(/\s/, 1);
  const rest = line.slice(name.length).replace(/^\s+/, '');
  return { name, rest, args: rest ? rest.split(/\s+/) : [] };
}

/**
 * Ask before a conversation-mutating command stops a turn that is still running.
 *
 * The cancel is not negotiable — see the invariant at the call site — but taking
 * a live turn down is the user's call, not ours, and the only signal they got
 * otherwise was a notice after the fact. Dismissing the dialog (Escape, backdrop,
 * Back) resolves null rather than false, so every falsy answer leaves the turn
 * alone.
 *
 * Asks through the UI port rather than importing the component, the same way
 * the model layer does: this service is imported by tests and by callers with no
 * UI mounted, and with no dialog to answer the invariant still has to hold, so
 * an absent presenter proceeds rather than blocking on a prompt nobody can see.
 * @param {string} commandName - Command name without the leading slash
 * @returns {Promise<boolean>} True when the turn may be stopped
 */
async function confirmStoppingTurn(commandName) {
  const dialogs = uiPort();
  if (!dialogs) {
    return true;
  }
  const answer = await dialogs.confirm(
    t('/{command} can\'t run while a turn is in flight. Running it now stops the turn.', { command: commandName }),
    t('Stop the current turn?'),
    { confirmText: t('Stop turn'), cancelText: t('Leave it running'), danger: true }
  );
  return !!answer;
}

/**
 * Handles slash command execution via plugin registry
 */
class SlashCommandHandler {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
  }

  /**
   * Initialize the command registry
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      return;
    }
    await commandRegistry.init();
    this._initialized = true;
  }

  /**
   * Execute a slash command from user input.
   * Commands receive only the messageThread — they operate exclusively via the Yjs document.
   * @param {string} input - Full user input (e.g. "/clear")
   * @param {import('../model/message-thread.js').MessageThread} [messageThread] - Column-scoped message thread
   * @returns {Promise<SlashCommandResult>} The result of command execution
   */
  async execute(input, messageThread) {
    await this.init();

    if (!/^\/[a-zA-Z]/.test(input)) {
      return { handled: false };
    }

    const { name: commandName, args, rest } = parseInvocation(input);
    const CommandClass = commandRegistry.getByNameOrAlias(commandName);

    if (!CommandClass) {
      return {
        handled: true,
        message: t('Unknown command: /{command}', { command: commandName }),
        error: true
      };
    }

    const conv = messageThread?.conversation;

    // Some mutations have no sensible mid-turn semantics. In particular, a
    // user-created thread cannot yet be queued like a regular message, so reject
    // it without interrupting the active agent. The UI mirrors this guard, but
    // enforcement belongs here so typed commands and other callers cannot bypass
    // it.
    if (CommandClass.MANIFEST?.rejectWhileBusy && conv?.isTurnActive()) {
      return {
        handled: true,
        message: t('Wait for the current turn to finish before creating a new thread.'),
        error: true
      };
    }

    // Architectural invariant: commands that will mutate the conversation
    // (snapshot/move/delete items, clear history, insert threads) must
    // never run while a turn is in flight. The handler is the single
    // chokepoint that enforces this — individual commands stay ignorant
    // of cancel/settle semantics. Without this, /compact firing during a
    // live bash action snapshots a `state: 'running'` item into the new
    // sub-thread where nothing will ever flip it to cancelled/completed.
    //
    // Which makes the cancel unavoidable, not automatic: ask before taking down
    // a turn the user is watching, and treat a refusal as the command being
    // handled — nothing ran, and they already know why.
    if (CommandClass.MANIFEST?.mutatesConversation && conv) {
      if (conv.isTurnActive() && !(await confirmStoppingTurn(commandName))) {
        return { handled: true };
      }
      await conv.cancelAndSettle('slash command');
    }

    // Every way a command runs — typed, picked from a menu, or a guidance
    // button — arrives here, so this is the one place its use is reported.
    if (CommandClass.MANIFEST?.id) recordUsage(`slash:${CommandClass.MANIFEST.id}`);

    const command = new CommandClass({
      messageThread: messageThread || undefined
    });

    // Close the worker UndoManager's capture window before the command
    // runs so its mutations (insertThread, etc.) form their own undo
    // group, separate from anything that happened in the prior 20 ms.
    // Commands that declare coalesceUndo want their whole (possibly async,
    // multi-step) mutation sequence to revert in a single undo — bracket
    // execute() with the worker's coalescing markers so every group it adds
    // collapses into one. The markers ride the same ordered worker channel
    // as the command's yjs-sync frames, so begin lands before the first
    // write and end after the last.
    const coalesceUndo = CommandClass.MANIFEST?.coalesceUndo && conv?.id;
    if (conv?.id) {
      const { default: workerManager } = await import('./worker-manager.js');
      workerManager.stopUndoCapturing(conv.id);
      if (coalesceUndo) await workerManager.beginUndoCoalescing(conv.id);
    }

    try {
      return await command.execute(args, rest);
    } finally {
      if (coalesceUndo) {
        const { default: workerManager } = await import('./worker-manager.js');
        await workerManager.endUndoCoalescing(conv.id);
      }
    }
  }

  /**
   * Get all registered commands (for menu UI and /help)
   * @returns {SlashCommand[]} Array of registered commands
   */
  getCommands() {
    if (!this._initialized) {
      return [];
    }

    return commandRegistry.getAll().map((/** @type {{id: string, class: any}} */ item) => {
      const manifest = item.class.MANIFEST;
      return {
        name: manifest.id,
        label: manifest.name,
        description: manifest.description,
        danger: manifest.danger || false,
        icon: manifest.icon || '',
        userDefined: manifest.userDefined || false,
        scope: manifest.scope || '',
        argsHint: manifest.argsHint || '',
        extensionId: commandRegistry.getExtensionId(item.id) || undefined
      };
    });
  }

  /**
   * Check if a command exists
   * @param {string} name - Command name or alias
   * @returns {boolean} True if command exists
   */
  hasCommand(name) {
    if (!this._initialized) {
      return false;
    }
    return commandRegistry.hasByNameOrAlias(name);
  }
}

// Export singleton instance
const slashCommandHandler = new SlashCommandHandler();
export default slashCommandHandler;
