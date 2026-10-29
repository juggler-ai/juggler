//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { resolveToolName } from '../services/tool-generator.js';

/**
 * ContextItemRegistry - JavaScript-based context item registry system
 *
 * Manages context item loading and lifecycle.
 * Context items are unified plugins that can be actions (one-shot operations)
 * or refreshable content providers (like documents, rules, etc.)
 * @augments {BaseRegistry<typeof import('juggler/context-item').default>}
 */
class ContextItemRegistry extends BaseRegistry {
  /**
   * Create a new context item registry
   */
  constructor() {
    super('ContextItemRegistry', ['id', 'name', 'version', 'description']);

    /**
     * Lazily-built tool-name → item-class map (see {@link getByToolName}).
     * `undefined` until first lookup; cleared by {@link invalidateCache} on
     * every init/reset so it never survives a plugin reload.
     * @type {Map<string, typeof import('juggler/context-item').default>|undefined}
     * @private
     */
    this._toolNameCache = undefined;
  }

  /**
   * Get context item capability descriptors (implements abstract method)
   *
   * Returns the context-item capabilities of every enabled extension — the
   * `@juggler/core` builtin extension and any user/project extensions. The ID is
   * extracted from each class's MANIFEST.id property.
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('context-item');
  }

  /**
   * Initialize the registry, clearing cached data
   * @returns {Promise<void>}
   */
  async init() {
    this.invalidateCache();
    return super.init();
  }

  /**
   * Reset the registry, also clearing the tool-name cache the base reset()
   * doesn't know about.
   */
  reset() {
    super.reset();
    this.invalidateCache();
  }

  /**
   * Get a context item class by its tool name
   *
   * Looks up an item by the tool name the LLM uses (e.g., 'write_file')
   * rather than the internal item ID (e.g., 'write-file').
   *
   * Callers pass names from two sources: live tool calls, and the `toolName`
   * persisted on a stored tool-action. A stored name is whatever was
   * advertised when the action ran, so resolving aliases here — rather than at
   * each call site — is what keeps a reloaded conversation's tiles bound to
   * their renderer after a tool is renamed.
   * @param {string} toolName - Tool name from LLM (e.g., 'write_file')
   * @returns {typeof import('juggler/context-item').default|undefined} Item class or undefined if not found
   */
  getByToolName(toolName) {
    // Build mapping if not cached
    if (!this._toolNameCache) {
      this._toolNameCache = new Map();
      for (const { class: ItemClass } of this.getAll()) {
        if (ItemClass.getToolDefinitions) {
          const tools = ItemClass.getToolDefinitions();
          for (const tool of tools) {
            this._toolNameCache.set(tool.name, ItemClass);
          }
        }
      }
    }
    // Exact match first, then the alias map, then a case-insensitive sweep.
    let result = this._toolNameCache.get(toolName);
    if (!result) {
      const resolved = resolveToolName(toolName);
      if (resolved !== toolName) result = this._toolNameCache.get(resolved);
    }
    if (!result) {
      const lowerName = toolName.toLowerCase();
      for (const [name, ItemClass] of this._toolNameCache) {
        if (name.toLowerCase() === lowerName) {
          result = ItemClass;
          break;
        }
      }
    }
    return result;
  }

  /**
   * Invalidate the tool name cache
   *
   * Should be called if plugins are hot-reloaded or re-registered
   * to ensure the cache reflects current state.
   */
  invalidateCache() {
    this._toolNameCache = undefined;
  }

  /**
   * Get all item IDs that require approval
   *
   * Returns an array of item IDs for items that require user approval
   * before execution. These are typically mutating items (write-file,
   * replace-text, execute) that should be blocked in plan mode.
   * @returns {string[]} Array of item IDs that require approval
   */
  getItemsThatRequireApproval() {
    return this.getAll()
      .filter(({ class: ItemClass }) => {
        const manifest = ItemClass.MANIFEST;
        return manifest?.requiresApproval === true;
      })
      .map(({ id }) => id);
  }

  /**
   * Create a context item instance from JSON data
   * @param {import('juggler/context-item').ItemJSON} json - Item data (plain object)
   * @param {import('../model/session.js').default} session - Session this item belongs to
   * @param {import('../model/conversation.js').default} conversation - Conversation this item belongs to
   * @param {import('../model/message-thread.js').default} messageThread - Message thread this item belongs to
   * @returns {import('juggler/context-item').default} Context item instance
   * @throws {Error} If item type not found
   */
  createItem(json, session, conversation, messageThread) {
    if (!json || !json.type) {
      throw new Error('Invalid item data: missing type');
    }

    if (!json.id || typeof json.id !== 'string') {
      throw new Error(`Invalid item data: missing or invalid id (type: ${json.type})`);
    }

    const itemId = json.type;
    const ItemClass = this.get(itemId);

    if (!ItemClass) {
      throw new Error(`No context item found for type: ${itemId}`);
    }

    // Create item instance with context object
    const item = new ItemClass({ id: json.id, type: json.type, session, conversation, messageThread });

    // Restore all properties from JSON
    item.fromJSON(json);

    return item;
  }
}

// Create and export singleton registry instance
const contextItemRegistry = new ContextItemRegistry();

export default contextItemRegistry;
