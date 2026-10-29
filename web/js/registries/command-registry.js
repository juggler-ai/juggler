//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { getRegisterableUserCommands, resetUserCommandsCache } from '../services/user-commands.js';
import { makeUserCommandClass } from '../plugins/user-command-factory.js';

/**
 * DOM event dispatched (viewer realm only) once a user-command pass has
 * registered a fresh list — after {@link CommandRegistry#refreshUserCommands}
 * and after a rebuild's own pass. Lets UI listing user commands follow a change
 * mid-turn, when the full rebuild's REGISTRIES_RELOADED is still waiting.
 */
export const USER_COMMANDS_REFRESHED = 'user-commands-refreshed';

/**
 * CommandRegistry - JavaScript-based command registry system
 *
 * Manages command plugin loading and lookup.
 * Commands are user-initiated operations (via /command or menu) that execute
 * immediately without LLM involvement or approval flows.
 * @augments {BaseRegistry<typeof import('juggler/command-type').default>}
 */
class CommandRegistry extends BaseRegistry {
  /**
   * Create a new command registry
   */
  constructor() {
    super('CommandRegistry', ['id', 'name', 'version', 'description']);

    /**
     * Map of alias to command ID
     * @type {Map<string, string>}
     * @private
     */
    this._aliasMap = new Map();

    /**
     * The ids the last user-command pass registered (or kept as disabled), and
     * the failed-module keys it recorded, so the next pass can replace exactly
     * that set and leave built-in and extension commands alone.
     * @type {{ids: Set<string>, failures: Set<string>}}
     * @private
     */
    this._userCommands = { ids: new Set(), failures: new Set() };

    /**
     * Numbers each user-command pass, so of passes whose fetches overlap only
     * the latest one applies its list.
     * @type {number}
     * @private
     */
    this._userCommandsPass = 0;

    /**
     * The latest user-command pass, which a superseded pass waits for so that
     * its caller still returns only once the newest list is registered.
     * @type {Promise<void>}
     * @private
     */
    this._userCommandsLatest = Promise.resolve();
  }

  /**
   * Get command capability descriptors (implements abstract method)
   *
   * Returns the command capabilities of every enabled extension — the
   * `@juggler/core` builtin extension and any user/project extensions. The ID is
   * extracted from each class's MANIFEST.id property.
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('command');
  }

  /**
   * Initialize the registry, building alias map
   *
   * After loading extension-provided command modules (the base `init`), the
   * declarative user-defined commands are synthesised and registered as a second
   * source. They register *after* extensions so a user command can never shadow
   * a built-in/extension command — `registerClass` refuses the collision and it
   * surfaces in the manager UI.
   * @returns {Promise<void>}
   */
  async init() {
    // Guard the whole override, not just super.init(): user commands are a
    // second registration source outside super's early-return, so without it
    // every repeat init() (e.g. the slash-command handler's own) would refetch
    // them. reset() clears this.initialized, so hot-reload still re-runs
    // everything; refreshUserCommands() is the way to re-read them alone.
    if (this.initialized) return;
    await super.init();
    await this._registerUserCommands();
    this._buildAliasMap();
  }

  /**
   * Commands are the one capability the user names themselves, so the collision
   * message is written to them: it says which of their commands was skipped and
   * what to do about it, in the `/name` vocabulary they typed.
   * @override
   * @param {string} id - The colliding command id
   * @returns {string} Explanation shown in the manager UI
   * @protected
   */
  collisionMessage(id) {
    return `A command named /${id} already exists (built-in or from an extension), ` +
      `so your custom /${id} was skipped. Rename your command to a name that isn't taken.`;
  }

  /**
   * Re-read the user-defined commands from the server and swap them in, without
   * the full registry rebuild and without waiting for a running turn to end.
   *
   * The full rebuild (reloadRegistries) defers to quiescence because strategies
   * and context items are what a running turn is using. Nothing in a turn reads
   * the command list — commands are run by the user, from the composer — so a
   * command saved mid-turn, by the editor or by the define_command tool, is
   * offered at once. Built-in and extension commands are untouched.
   *
   * While a load pass is under way this does nothing: that pass registers user
   * commands itself once the module-loaded set is in, from a fetch that starts
   * after this one.
   * @returns {Promise<void>} Resolves once the newest list is registered.
   */
  refreshUserCommands() {
    resetUserCommandsCache();
    return this._registerUserCommands();
  }

  /**
   * Fetch the registerable user-command definitions (valid, project-shadowed)
   * and replace the previously registered user commands with them. Failures are
   * non-fatal — a broken definition never blocks the built-in commands.
   *
   * Every pass replaces the set the last one registered, so passes that overlap
   * (a hot reload's init beside an editor save) converge on the newest list
   * rather than colliding with each other's registrations.
   * @returns {Promise<void>}
   * @private
   */
  _registerUserCommands() {
    const pass = ++this._userCommandsPass;
    const run = (async () => {
      /** @type {import('../services/user-commands.js').UserCommandDef[]} */
      let defs;
      try {
        defs = await getRegisterableUserCommands();
      } catch (err) {
        console.warn('[CommandRegistry] Failed to fetch user commands:', err);
        return;
      }
      if (pass !== this._userCommandsPass) {
        await this._userCommandsLatest;
        return;
      }
      // Not loaded (or reset since): registering now would let a user command
      // claim an id before the built-in that owns it arrives.
      if (!this.initialized) return;
      this._replaceUserCommands(defs);
      // The engine worker has no document; only a viewer has anything to repaint.
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent(USER_COMMANDS_REFRESHED));
      }
    })();
    this._userCommandsLatest = run;
    return run;
  }

  /**
   * Unregister the user commands the last pass registered and register `defs`
   * in their place. A definition colliding with a built-in or extension command
   * is refused and recorded as a failed module, as registerClass does.
   * @param {import('../services/user-commands.js').UserCommandDef[]} defs - Registerable definitions
   * @private
   */
  _replaceUserCommands(defs) {
    for (const id of this._userCommands.ids) {
      this.items.delete(id);
      this._disabledItems.delete(id);
      this.modulePaths.delete(id);
      this.itemExtensions.delete(id);
    }
    for (const key of this._userCommands.failures) this._failedModules.delete(key);
    this._userCommands = { ids: new Set(), failures: new Set() };

    for (const def of defs) {
      const modulePath = `user-command:${def.scope}/${def.name}`;
      const outcome = this.registerClass(makeUserCommandClass(def), { extensionId: null, modulePath });
      if (outcome.registered || outcome.disabled) this._userCommands.ids.add(def.name);
      else this._userCommands.failures.add(modulePath);
    }
    this._buildAliasMap();
  }

  /**
   * @override
   */
  reset() {
    super.reset();
    this._userCommands = { ids: new Set(), failures: new Set() };
  }

  /**
   * Build the alias map from registered commands
   * @private
   */
  _buildAliasMap() {
    this._aliasMap.clear();
    for (const { class: CommandClass } of this.getAll()) {
      const manifest = CommandClass.MANIFEST;
      if (manifest.alias) {
        this._aliasMap.set(manifest.alias.toLowerCase(), manifest.id);
      }
    }
  }

  /**
   * Get command class by name or alias
   *
   * Looks up a command by its ID or alias (case-insensitive).
   * @param {string} name - Command name or alias
   * @returns {typeof import('juggler/command-type').default|undefined} Command class or undefined
   */
  getByNameOrAlias(name) {
    const lower = name.toLowerCase();

    // Try direct ID first
    const cls = this.get(lower);
    if (cls) return cls;

    // Try alias
    const id = this._aliasMap.get(lower);
    if (id) return this.get(id);

    return undefined;
  }

  /**
   * Check if a command exists by name or alias
   * @param {string} name - Command name or alias
   * @returns {boolean} True if command exists
   */
  hasByNameOrAlias(name) {
    return this.getByNameOrAlias(name) !== undefined;
  }
}

// Create and export singleton registry instance
const commandRegistry = new CommandRegistry();

export default commandRegistry;
