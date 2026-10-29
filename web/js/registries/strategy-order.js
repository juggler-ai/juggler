//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @module registries/strategy-order
 *
 * Display ordering for the strategy selector and command-editor strategy list.
 *
 * Each strategy — built-in or 3rd-party — declares its own position via the
 * optional numeric `order` field on its manifest (lower = earlier). The
 * framework sorts by `order` ascending with a stable load-order tiebreak; it
 * has no knowledge of any specific strategy id, so it stays plugin-agnostic.
 * When no strategy sets `order`, the list stays in registry load order.
 *
 * `orderStrategies()` is pure and returns a new array; callers (the strategy
 * registry) apply it at the single chokepoint both UI consumers already use.
 */

/**
 * A strategy manifest entry as produced by the registry, narrowed to the
 * fields `orderStrategies` reads.
 * @typedef {object} StrategyOrderEntry
 * @property {string} id - Strategy id
 * @property {{ order?: number }} manifest - Strategy manifest (only `order` is read)
 */

/**
 * Order strategy manifest entries for display by `manifest.order` ascending,
 * with a stable load-order tiebreak.
 *
 * Disabled strategies are already filtered out upstream (the registry drops
 * them at load), so every entry passed in is enabled. Entries without a
 * numeric `order` are treated as +Infinity so they sort after any
 * hint-bearing entry while keeping their relative load order among
 * themselves. The input array's order is the registry's load order; this sort
 * is stable by construction (it never reorders two equal-priority entries),
 * so engines without a stable `Array#sort` still behave correctly.
 * @template {StrategyOrderEntry} E
 * @param {readonly E[]} manifests - Manifest entries in load order
 * @returns {E[]} A new array, ordered for display
 */
export function orderStrategies(manifests) {
  return [...manifests].sort((a, b) => {
    const ao = typeof a.manifest?.order === 'number' ? a.manifest.order : Infinity;
    const bo = typeof b.manifest?.order === 'number' ? b.manifest.order : Infinity;
    return ao - bo;
  });
}
