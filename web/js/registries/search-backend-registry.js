//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { validateSearchBackendManifest } from 'juggler/search-backend';

/**
 * SearchBackendRegistry - the services the WebSearch tool can search with.
 *
 * Filled from the `searchBackends` capability of every enabled extension. Which
 * of them WebSearch asks, and in what order, is the user's Web search setting
 * (services/web-search-backends.js), not registry order.
 *
 * Initialised in both realms: the viewer's settings and catalog list the
 * backends, and the engine, where WebSearch runs, calls them.
 * @augments {BaseRegistry<typeof import('juggler/search-backend').default>}
 */
class SearchBackendRegistry extends BaseRegistry {
  constructor() {
    super('SearchBackendRegistry', ['id', 'name', 'version', 'description']);
  }

  /**
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Backend capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('search-backend');
  }

  /**
   * @override
   * @param {unknown} BackendClass - Class to validate
   * @protected
   */
  validateClass(BackendClass) {
    super.validateClass(BackendClass);
    validateSearchBackendManifest(/** @type {typeof import('juggler/search-backend').default} */ (BackendClass));
  }
}

const searchBackendRegistry = new SearchBackendRegistry();

export default searchBackendRegistry;
