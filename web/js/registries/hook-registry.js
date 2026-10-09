//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { fetchUserHooks } from '../services/user-hooks.js';
import { makeUserHookClass } from '../plugins/user-hook-factory.js';
import { validateHookManifest } from 'juggler/hook-type';

/**
 * HookRegistry - the tool hooks that run around every tool call.
 *
 * Two sources, in this order: the `hooks` capability of every enabled
 * extension, then the hook files in `~/.juggler/hooks/`. Files register second,
 * through `registerClass`, so a file can never shadow an extension's hook of the
 * same id — the collision is reported in the catalog instead. Registry order is
 * the order hooks run in and the order their notes appear.
 *
 * Initialised in both realms, because the catalog lists hooks in the viewer; only
 * the engine's hook runtime (services/hook-runtime.js) ever calls one.
 * @augments {BaseRegistry<typeof import('juggler/hook-type').default>}
 */
class HookRegistry extends BaseRegistry {
  constructor() {
    super('HookRegistry', ['id', 'name', 'version', 'description']);
  }

  /**
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Hook capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('hook');
  }

  /**
   * @override
   * @param {any} HookClass - Class to validate
   * @protected
   */
  validateClass(HookClass) {
    super.validateClass(HookClass);
    validateHookManifest(HookClass);
  }

  /**
   * Load extension hooks, then register the hook files. Guarded as a whole —
   * the file pass sits outside super's early return, and a repeat init would
   * otherwise collide every file hook with its own first registration.
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) return;
    await super.init();
    await this._registerUserHooks();
  }

  /**
   * Register a class for every valid hook file. A file the server flagged is
   * recorded as a failed module under its `user-hook:<name>` path, exactly as a
   * class that fails validation here (a bad regular expression) or collides is,
   * so the catalog lists every hook that is present but not running, and why.
   * One broken file never stops the others.
   * @returns {Promise<void>}
   * @private
   */
  async _registerUserHooks() {
    let defs;
    try {
      defs = await fetchUserHooks();
    } catch (err) {
      console.warn('[HookRegistry] Failed to fetch user hooks:', err);
      return;
    }
    for (const def of defs) {
      const modulePath = `user-hook:${def.name}`;
      if (def.error) {
        this._failedModules.set(modulePath, `${def.path}: ${def.error}`);
        continue;
      }
      this.registerClass(makeUserHookClass(def), { extensionId: null, modulePath });
    }
  }
}

const hookRegistry = new HookRegistry();

export default hookRegistry;
