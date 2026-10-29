//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';

/**
 * PinboardItemRegistry — loads the "pinboard item" plugins the board renders as
 * tabs (File, Plan, Git status, …). Item types are viewer-only capabilities: they
 * touch the DOM and never run in the engine worker, so this registry is only ever
 * initialised in the viewer realm (see reload-registries.js).
 *
 * The registry holds item *types*; the pins themselves — which types are on the
 * board, in what order, configured how — are server-backed session state owned by
 * services/pinboard-store.js. That split is what lets a pin outlive its provider:
 * an extension the user has disabled leaves its pins in place, unrendered, until
 * they remove them.
 * @augments {BaseRegistry<typeof import('juggler/pinboard-item-type').default>}
 */
class PinboardItemRegistry extends BaseRegistry {
  constructor() {
    super('PinboardItemRegistry', ['id', 'name', 'version', 'description']);

    /**
     * One lazily-created instance per registered type id. A type is a renderer, not
     * a pin: the single instance serves every pin of its type, which is why the SDK
     * forbids per-pin state on the instance. Cleared on reset() so a hot-reloaded
     * class is never served a stale instance.
     * @type {Map<string, InstanceType<typeof import('juggler/pinboard-item-type').default>>}
     * @private
     */
    this._instances = new Map();
  }

  /**
   * Get pinboard-item capability descriptors (implements abstract method).
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('pinboard-item');
  }

  /**
   * Reset the registry, also clearing the per-id instance cache the base reset()
   * doesn't know about.
   */
  reset() {
    super.reset();
    this._instances.clear();
  }

  /**
   * The instance for one type id, or null when no enabled extension provides that
   * type. Null is an ordinary answer, not a failure: it is what the board sees for
   * a pin whose extension is disabled or uninstalled, and it renders a placeholder.
   * @param {string} typeId - The item-type id.
   * @returns {InstanceType<typeof import('juggler/pinboard-item-type').default>|null} The instance, or null.
   */
  getType(typeId) {
    const TypeClass = this.get(typeId);
    if (!TypeClass) return null;
    return this._instance(typeId, TypeClass);
  }

  /**
   * One instance per enabled type, in registration order — what the add picker
   * lists. Instances are reused across calls.
   * @returns {InstanceType<typeof import('juggler/pinboard-item-type').default>[]} Enabled item-type instances.
   */
  getEnabledTypes() {
    return this.getAll().map(({ id, class: TypeClass }) => this._instance(id, TypeClass));
  }

  /**
   * Find the enabled type that can pin a source descriptor, and the config to pin
   * it with. This is the indirection that keeps a file properties panel from having
   * to name the File pin class: the panel describes what it has, the registry finds
   * who wants it.
   *
   * First acceptor wins, but the types that claim a whole kind of source — the ones
   * marked `sourceFallback` — are asked only after every other type has declined.
   * Otherwise the answer would be settled by load order, and since builtins load
   * before extensions, the File pin (which accepts any live file) would take every
   * path an extension had a purpose-built type for.
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {{typeId: string, config: NonNullable<ReturnType<typeof import('juggler/pinboard-item-type').default.configFromSource>>}|null} The type and config, or null if nothing can pin it.
   */
  resolveSource(source) {
    const all = this.getAll();
    /**
     * @param {{id: string, class: typeof import('juggler/pinboard-item-type').default}} entry - A registered item type.
     * @returns {boolean} True when the type claims a whole kind of source.
     */
    const isFallback = (entry) => entry.class?.MANIFEST?.sourceFallback === true;
    const ordered = [...all.filter((entry) => !isFallback(entry)), ...all.filter(isFallback)];

    for (const { id, class: Type } of ordered) {
      let config = null;
      try {
        if (!Type.canPinSource?.(source)) continue;
        config = Type.configFromSource?.(source) ?? null;
      } catch (err) {
        console.error(`[PinboardItemRegistry] Item type "${id}" failed to resolve a source:`, err);
        continue;
      }
      if (config) return { typeId: id, config };
    }
    return null;
  }

  /**
   * Get (or lazily create) the singleton instance for a type id.
   * @param {string} id - Item-type id.
   * @param {typeof import('juggler/pinboard-item-type').default} TypeClass - The item-type class registered under that id.
   * @returns {InstanceType<typeof import('juggler/pinboard-item-type').default>} The instance.
   * @private
   */
  _instance(id, TypeClass) {
    const existing = this._instances.get(id);
    if (existing) return existing;
    const created = new TypeClass();
    this._instances.set(id, created);
    return created;
  }
}

// Create and export singleton registry instance
const pinboardItemRegistry = new PinboardItemRegistry();

export default pinboardItemRegistry;
