//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { REQUIRED_INFO_CARD_MANIFEST_FIELDS } from '../../sdk/info-card-type.js';
import { getExtensionCapabilities } from '../services/extensions.js';

/**
 * InfoCardRegistry — loads the "info card" plugins the sidebar rail renders
 * (Usage, Git status, …). Cards are viewer-only capabilities: they touch
 * the DOM and never run in the engine worker, so this registry is only ever
 * initialised in the viewer realm (see reload-registries.js).
 *
 * Like every registry it governs cards through the server-side disabled set
 * (gate 1, the Extensions catalog). A card is *shown* only when it is also not
 * per-viewer hidden (gate 2, the × / info-cards menu) — that second gate lives in
 * services/info-cards-manager.js, not here.
 * @augments {BaseRegistry<typeof import('juggler/info-card-type').default>}
 */
class InfoCardRegistry extends BaseRegistry {
  constructor() {
    super('InfoCardRegistry', REQUIRED_INFO_CARD_MANIFEST_FIELDS);

    /**
     * One lazily-created instance per registered card id, so a card's mount
     * closures and module state persist across rail reconciles. Cleared on
     * reset() so a hot-reloaded class is never served a stale instance.
     * @type {Map<string, InstanceType<typeof import('juggler/info-card-type').default>>}
     * @private
     */
    this._instances = new Map();
  }

  /**
   * Get info-card capability descriptors (implements abstract method).
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('info-card');
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
   * Return one instance per enabled (gate-1) card, sorted by descending
   * MANIFEST.priority — the order the rail stacks them (highest first, tail
   * dropped when the column is full). Instances are reused across calls.
   * @returns {InstanceType<typeof import('juggler/info-card-type').default>[]} Enabled card instances, highest priority first.
   */
  getEnabledCards() {
    return this.getAll()
      .map(({ id, class: CardClass }) => this._instance(id, CardClass))
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get (or lazily create) the singleton instance for a card id.
   * @param {string} id - Card id.
   * @param {typeof import('juggler/info-card-type').default} CardClass - The card class registered under that id.
   * @returns {InstanceType<typeof import('juggler/info-card-type').default>} The card instance.
   * @private
   */
  _instance(id, CardClass) {
    const existing = this._instances.get(id);
    if (existing) return existing;
    const created = new CardClass();
    this._instances.set(id, created);
    return created;
  }
}

// Create and export singleton registry instance
const infoCardRegistry = new InfoCardRegistry();

export default infoCardRegistry;
