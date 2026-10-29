//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import FallbackStrategy from './fallback-strategy.js';
import { orderStrategies } from './strategy-order.js';

/**
 * StrategyRegistry - JavaScript-based strategy registry system
 *
 * Manages strategy loading and lifecycle.
 * Strategies control how the LLM approaches tasks (loop behavior, context assembly,
 * sub-conversation spawning, etc.).
 * @augments {BaseRegistry<typeof import('juggler/strategy-type').default>}
 */
class StrategyRegistry extends BaseRegistry {
  /**
   * Create a new strategy registry
   */
  constructor() {
    super('StrategyRegistry', ['id', 'name', 'version', 'description']);

    /**
     * Whether we have already logged that no strategy is registered, so the
     * degraded-mode notice is emitted once per registry state — not once per
     * MessageThread construction (a conversation walk builds one strategy per
     * thread, which would otherwise flood the console). Cleared on reset().
     * @type {boolean}
     * @private
     */
    this._warnedNoStrategy = false;
  }

  /**
   * Whether any strategy is registered (enabled). When false the app is in the
   * degraded "no strategy" mode: every strategy ships in `@juggler/core` and the
   * user has disabled it (or all strategy plugins). Callers that start an LLM
   * turn use this to refuse and point the user at the Extensions settings rather
   * than silently running the inert fallback.
   * @returns {boolean} True if at least one strategy is registered
   */
  hasAnyStrategy() {
    return this.items.size > 0;
  }

  /**
   * Clear loaded strategies (and the one-shot no-strategy warning latch) so the
   * degraded-mode notice can fire again after a reload that is still empty.
   */
  reset() {
    super.reset();
    this._warnedNoStrategy = false;
  }

  /**
   * Get strategy capability descriptors (implements abstract method)
   *
   * Returns the strategy capabilities of every enabled extension — the
   * `@juggler/core` builtin extension and any user/project extensions. The ID is
   * extracted from each class's MANIFEST.id property.
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('strategy');
  }

  /**
   * Get all strategy manifests for system prompt
   *
   * The ENUMERATION accessor: manifest metadata for every registered strategy a
   * user may be offered, ordered for display: built-in strategies first in the
   * host's curated order, then any remaining strategies by their manifest
   * `order` hint (stable on ties). The strategy selector, the Shift+Tab cycle
   * ring, the default-strategy picker and the command-editor strategy list all
   * read from here, so this is the single chokepoint for both display ordering
   * and the `hidden` filter.
   *
   * A `hidden` strategy is excluded here and ONLY here: `get()` and
   * `createStrategy()` deliberately still resolve hidden ids, because a subagent
   * item pins its own hidden strategy on a delegated subthread and that thread
   * must be able to instantiate it. Filtering at this one chokepoint (rather
   * than at each call site) is also what keeps a hidden strategy out of the two
   * first-available fallbacks below — ordering is by `manifest.order` then load
   * order, so an unfiltered hidden strategy sorting first could silently become
   * a user's conversation default.
   * @returns {Array<{id: string, manifest: import('juggler/strategy-type').StrategyManifest, modulePath: string, extensionId: string|null}>} Array of strategy metadata
   */
  getAllManifests() {
    // Same shape the base builds (id/manifest/modulePath/extensionId) — every
    // registered strategy is guaranteed a MANIFEST by validateClass at load —
    // minus the hidden ones, then reordered for display.
    const visible = this.getManifests().filter(({ manifest }) => manifest.hidden !== true);
    return orderStrategies(visible);
  }

  /**
   * Create a strategy instance for a conversation
   *
   * All strategy methods are instance-based to enable per-conversation state.
   * Each conversation owns its own strategy instance.
   * @param {string} id - Strategy ID
   * @param {import('../model/message-thread.js').default} messageThread - Message thread
   * @returns {import('juggler/strategy-type').default} Strategy instance
   */
  createStrategy(id, messageThread) {
    let StrategyClass = this.get(id);

    // The requested id isn't registered — it was removed/renamed, or it (e.g. a
    // disabled 'default') has been turned off in the extension settings while
    // other strategies remain enabled. Resolve to a REAL registered strategy
    // rather than dropping to the inert fallback: prefer 'default' when it's
    // available, else the first strategy in display order. This is what makes
    // disabling the built-in "Default strategy" behave sensibly — a new task (or
    // a session pinned to 'default') lands on an enabled strategy instead of the
    // placeholder that runs no turn.
    if (!StrategyClass) {
      const fallbackId = this.has('default') ? 'default' : this.getAllManifests()[0]?.id;
      if (fallbackId && fallbackId !== id) {
        const fallback = this.get(fallbackId);
        if (fallback) {
          console.warn(`[StrategyRegistry] Strategy "${id}" not available, falling back to "${fallbackId}"`);
          StrategyClass = fallback;
        }
      }
    }

    if (!StrategyClass) {
      // No registered strategy at all — every strategy ships in `@juggler/core`
      // and it (or all strategy plugins) has been disabled. Use the framework's
      // built-in fallback (not a plugin, so it can't be disabled) instead of
      // throwing: a missing strategy must degrade gracefully, not brick session
      // load and lock the user out of the Extensions settings they need to
      // re-enable it. The fallback is inert (it never runs an LLM turn) — the
      // user is told to enable a strategy at the point they try to send. Log the
      // degraded mode once per registry state, not once per thread.
      if (!this._warnedNoStrategy) {
        console.warn('[StrategyRegistry] No strategy is registered (all strategy plugins disabled); using the inert built-in fallback. Enable a strategy in the Extensions settings.');
        this._warnedNoStrategy = true;
      }
      StrategyClass = FallbackStrategy;
    }

    return new StrategyClass({ messageThread });
  }
}

// Create and export singleton registry instance
const strategyRegistry = new StrategyRegistry();

export default strategyRegistry;
