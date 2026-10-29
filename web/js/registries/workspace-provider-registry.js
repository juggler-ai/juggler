//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';

/**
 * WorkspaceProviderRegistry - the providers that can make a workspace
 *
 * A workspace provider owns the lifecycle of a place a conversation works in:
 * creating it, reporting on it, finishing with it, and cleaning up after a
 * provision that was interrupted.
 *
 * **Nothing resolves through this registry on the path that matters.** A
 * workspace's kind and root live on the session's own row, so a provider that is
 * disabled, uninstalled, or failing to load cannot strand a conversation bound
 * to a workspace it made. What it can do is leave that workspace without status,
 * without finish actions, and out of the reconcile pass — which is why every
 * caller here asks {@link WorkspaceProviderRegistry#get} and is expected to have
 * an answer for `undefined`, rather than treating a miss as impossible.
 * @augments {BaseRegistry<typeof import('juggler/workspace-provider').default>}
 */
class WorkspaceProviderRegistry extends BaseRegistry {
  /**
   * Create a new workspace provider registry
   */
  constructor() {
    super('WorkspaceProviderRegistry', ['id', 'name', 'version', 'description']);
  }

  /**
   * Get workspace provider capability descriptors (implements abstract method)
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('workspace-provider');
  }

  /**
   * Build a provider instance by id, or nothing when no such provider is
   * loaded.
   *
   * Returning `undefined` rather than throwing is the whole degradation
   * contract in one line: the common reason for a miss is an extension the user
   * disabled after making a workspace with it, and that must cost them the
   * provider's features rather than the workspace.
   * @param {string} id - The provider's MANIFEST id
   * @param {import('../model/session.js').default} [session] - The session, for what little a provider knows before a hook runs
   * @returns {import('juggler/workspace-provider').default|undefined} An instance, or nothing
   */
  createProvider(id, session) {
    const ProviderClass = this.get(id);
    if (!ProviderClass) return undefined;
    return new ProviderClass({ session });
  }
}

const workspaceProviderRegistry = new WorkspaceProviderRegistry();

export default workspaceProviderRegistry;
