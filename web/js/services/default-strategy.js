//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Default strategy for new tasks — the single source of truth for the
 * per-project "which strategy does a fresh task start on" preference.
 *
 * The stock behaviour is that a new task starts on the built-in `default`
 * strategy (a new conversation carries no `currentStrategyId`, so the thread
 * resolves to `'default'`). This service lets the operator pin a different
 * registered strategy as the seed instead, and resolves the effective seed so
 * a stale/disabled pin (e.g. the user disabled the strategy they had chosen, or
 * disabled `@juggler/core` entirely) degrades to a strategy that actually
 * exists rather than the inert fallback placeholder.
 * @module services/default-strategy
 */

import strategyRegistry from '../registries/strategy-registry.js';

/**
 * The built-in strategy id a new task uses when nothing else is configured.
 * Not registry-owned (it's the framework's baseline id), so it's safe to
 * reference directly here.
 * @type {string}
 */
export const BUILTIN_DEFAULT_STRATEGY_ID = 'default';

/**
 * Session-metadata key holding the per-project "default strategy for new tasks"
 * preference. Stored in `session.metadata` (the general-purpose frontend-flag
 * map), so it persists with the session and is shared across windows on the
 * same project. Absent unless the operator picks a non-default strategy.
 */
const DEFAULT_STRATEGY_META_KEY = 'defaultStrategyId';

/**
 * The operator's configured default-strategy id for new tasks, or null when
 * none is set (meaning: use the built-in `default`).
 * @param {{getMetadata?: (key: string) => any}|null|undefined} session - The active session.
 * @returns {string|null} The configured strategy id, or null when unset.
 */
export function getDefaultStrategyId(session) {
  const raw = session && session.getMetadata
    ? session.getMetadata(DEFAULT_STRATEGY_META_KEY)
    : null;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * Persist the per-project "default strategy for new tasks" preference. The
 * write is optimistic + broadcast through {@link session.patchMetadata}, so it
 * survives restarts and reaches other windows on the same project. Passing the
 * built-in `default` id (or a falsy value) clears the pin, restoring the stock
 * behaviour.
 * @param {{patchMetadata?: (patch: Record<string, any>) => any}|null|undefined} session - The active session.
 * @param {string|null|undefined} strategyId - The new default, or falsy/`default` to clear.
 * @returns {void}
 */
export function setDefaultStrategyId(session, strategyId) {
  if (!session || typeof session.patchMetadata !== 'function') return;
  const pin = strategyId && strategyId !== BUILTIN_DEFAULT_STRATEGY_ID ? strategyId : null;
  // null deletes the key (patchMetadata treats null/undefined as a delete),
  // so clearing the pin leaves no metadata behind.
  session.patchMetadata({ [DEFAULT_STRATEGY_META_KEY]: pin });
}

/**
 * Resolve the strategy id a new task should actually be seeded with, honouring
 * what is currently registered:
 *   1. the configured pin, if it's registered;
 *   2. else the built-in `default`, if it's registered;
 *   3. else the first strategy in display order (the registry's own ordering);
 *   4. else `default` as a last-resort string when nothing is registered
 *      (the caller won't write it, and createStrategy degrades to the inert
 *      fallback — the whole app is in no-strategy mode at that point).
 *
 * This is what makes disabling the built-in "Default strategy" behave sensibly:
 * rather than silently routing every new task through `'default'` (and landing
 * on the inert placeholder), the seed falls through to a strategy that is
 * actually enabled.
 * @param {{getMetadata?: (key: string) => any}|null|undefined} session - The active session.
 * @returns {string} A strategy id to seed a new task with.
 */
export function resolveDefaultStrategyId(session) {
  const configured = getDefaultStrategyId(session);
  if (configured && strategyRegistry.has(configured)) return configured;
  if (strategyRegistry.has(BUILTIN_DEFAULT_STRATEGY_ID)) return BUILTIN_DEFAULT_STRATEGY_ID;
  const first = strategyRegistry.getAllManifests()[0];
  return first ? first.id : BUILTIN_DEFAULT_STRATEGY_ID;
}
