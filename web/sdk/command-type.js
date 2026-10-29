//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Command manifest - static metadata that describes a command plugin.
 * Define this as a static MANIFEST property on your command class.
 * @typedef {object} CommandManifest
 * @property {string} id - Unique command identifier (kebab-case, e.g., 'clear', 'compact')
 * @property {string} name - Human-readable display name (e.g., 'Clear Conversation')
 * @property {string} version - Semantic version (e.g., '1.0.0')
 * @property {string} description - Help text shown in menu/autocomplete
 * @property {boolean} [danger] - Whether this is a destructive action (for menu styling)
 * @property {string} [icon] - CSS class for menu icon (e.g., 'icon-trashcan')
 * @property {string} [alias] - Alternative command name (e.g., 'c' for 'compact')
 * @property {boolean} [mutatesConversation] - True if the command writes to the conversation's
 *   YArray in a way that would race a live turn (snapshot/move/delete items, etc.). When set,
 *   `SlashCommandHandler` awaits `conversation.cancelAndSettle()` before invoking `execute()`
 *   so the command never captures or overwrites mid-flight tool/LLM state. With a turn actually
 *   in flight it asks the user first, and abandons the command if they decline. Pure side-effect
 *   commands (`/help`, anything that only reads or only opens a UI panel) leave this unset.
 * @property {boolean} [rejectWhileBusy] - True if a mutating command must be rejected rather
 *   than cancel the active turn.
 * @property {boolean} [coalesceUndo] - True if every document mutation `execute()` makes
 *   (including async multi-step sequences like clear-then-re-seed) should collapse into a
 *   single undo group, so the whole command reverts in one undo. When set, `SlashCommandHandler`
 *   brackets `execute()` with the worker's undo-coalescing markers. Leave unset for commands
 *   whose individual steps are independently undoable.
 */

/**
 * Result returned by command execution.
 * @typedef {object} CommandResult
 * @property {boolean} handled - Whether the command was recognized and executed
 * @property {string} [message] - Optional message to display to user
 * @property {boolean} [error] - Whether this was an error
 * @property {CommandSideEffect[]} [sideEffects] - Declarative side-effects for the host to handle
 */

/**
 * A declarative side-effect that the host application handles after command execution.
 * Commands never perform these operations directly — they declare intent and the host dispatches.
 * @typedef {object} CommandSideEffect
 * @property {'openThread'|'setDraft'|'openCommandManager'|'openExportDialog'} type - Side effect type
 * @property {Record<string, unknown>} [data] - Side effect payload
 */

/**
 * Context object for CommandType constructor.
 * Subclasses receive this and pass it to super(context).
 * @typedef {object} CommandContext
 * @property {import('../js/model/message-thread.js').MessageThread} [messageThread] - Column-scoped message thread
 */

// ============================================================================
// CommandType Base Class
// ============================================================================

/**
 * CommandType - Base class for Juggler command plugins
 *
 * Commands are **user-initiated operations** invoked via `/command` or the menu.
 * Unlike actions, they have no LLM tool definitions and no approval flow.
 * Commands execute immediately when the user invokes them.
 *
 * ## Execution Flow
 *
 * 1. User types `/command args` or clicks menu item
 * 2. Handler looks up command in registry
 * 3. `execute(args)` is called on command instance
 * 4. Result message is shown to user
 *
 * ## Creating a Command
 *
 * Commands ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Scaffold one with `juggler ext init` and
 * link it with `juggler ext link`; see `docs/extension_guide.md`.
 *
 * 1. Add a file named `*-command-type.js` under the extension's `commands/`
 *    directory — the manifest's `provides` glob registers it automatically.
 * 2. Import and extend CommandType: `import CommandType from 'juggler/command-type';`
 * 3. Define static MANIFEST with required fields (id, name, version, description)
 * 4. Implement execute()
 * 5. Save — a linked extension hot-reloads in connected viewers; no restart.
 *
 * ## Execution Context
 *
 * Commands operate exclusively via `this.messageThread` (the Yjs document).
 * For side-effects that go beyond the document (opening a thread column,
 * creating a new conversation), return declarative `sideEffects` on the
 * CommandResult and the host application handles them.
 *
 * ## Quick Start
 *
 * ```javascript
 * import CommandType from 'juggler/command-type';
 *
 * class MyCommandType extends CommandType {
 *   static MANIFEST = {
 *     id: 'my-command',
 *     name: 'My Command',
 *     version: '1.0.0',
 *     description: 'Does something useful'
 *   };
 *
 *   async execute(args) {
 *     // Access the Yjs document via this.messageThread
 *     return { handled: true, message: 'Done!' };
 *   }
 * }
 *
 * export default MyCommandType;
 * ```
 * @class
 * @abstract
 */
class CommandType {
  /**
   * Command type manifest (static property set by subclasses)
   * @type {CommandManifest}
   * @static
   */
  static MANIFEST;

  /**
   * Create a new command instance
   * @param {CommandContext} context - Execution context
   */
  constructor(context) {
    if (new.target === CommandType) {
      throw new Error('CommandType is an abstract class and cannot be instantiated directly');
    }

    /**
     * Column-scoped message thread
     * @type {import('../js/model/message-thread.js').MessageThread|undefined}
     */
    this.messageThread = context.messageThread;

    // Validate manifest on construction
    validateManifest(this.constructor);
  }

  /**
   * The conversation's items, as **raw read-only Y.Map objects** (corrupt
   * non-Y.Map entries filtered out). Read fields with `item.get('itemId')` etc.;
   * **never mutate them** — the "never touch raw Yjs objects" rule applies. To
   * change the conversation, use the MessageThread `@plugin-api` methods
   * (`addEvent`, `deleteItemById`, `mutate`, …). This mirrors
   * `this.messageThread.items`; that surface is the documented one.
   *
   * The raw Y.Map shape is **outside the engineApi compat promise** — a narrow
   * read view is a candidate for a future SDK revision (§10.1).
   * @returns {Array<import('yjs').Map<unknown>>} Read-only Y.Map items (empty when no thread)
   */
  get items() {
    return this.messageThread?.items ?? [];
  }

  /**
   * Execute the command
   *
   * Override in subclasses to implement command behavior.
   *
   * `args` and `rest` are the text typed after the command name, read two ways:
   * the whitespace-delimited tokens, and that text verbatim. Take `rest` when
   * the argument is prose the user may have written across several lines.
   * @abstract
   * @param {string[]} args - Command arguments (parsed from user input)
   * @param {string} [rest] - The argument text as typed, line breaks intact
   * @returns {Promise<CommandResult>} Result with handled, message, error
   * @throws {Error} If not implemented
   * @example
   * async execute(args) {
   *   const target = args[0] || 'world';
   *   return { handled: true, message: `Hello, ${target}!` };
   * }
   */
  async execute(args, rest) {
    void args;
    void rest;
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Get command manifest
   * @returns {CommandManifest} Command manifest
   */
  getManifest() {
    const ctor = /** @type {typeof CommandType} */ (this.constructor);
    return ctor.MANIFEST;
  }
}

export default CommandType;
