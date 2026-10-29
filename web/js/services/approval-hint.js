//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The approval card's strategy hint. Someone approving call after call in one
 * turn is told, on the card in front of them, that a strategy would do the
 * approving for them, and offered it in one click.
 *
 * It appears only once they have already approved {@link HINT_AFTER_APPROVALS}
 * calls by hand in the current turn, so one approval in a turn never carries it.
 * It offers only the strategies that would ask less than the current one.
 * @module services/approval-hint
 */

/**
 * Approvals by hand, earlier in the same turn, before a card shows the hint.
 * Two means the hint first appears on the third card.
 */
export const HINT_AFTER_APPROVALS = 2;

/**
 * The strategies the hint may offer, least to most permissive. Each is offered
 * only when it is registered and visible, and only when it would ask less than
 * the current strategy.
 */
const HINT_STRATEGY_IDS = ['auto-approve', 'yolo'];

/**
 * Reads a field from a Y.Map item or from a plain object.
 * @param {any} item - The item
 * @param {string} key - The field
 * @returns {any} Its value
 */
function field(item, key) {
  return typeof item?.get === 'function' ? item.get(key) : item?.[key];
}

/**
 * The calls the user approved by hand in the turn that the card for `itemId`
 * belongs to, counted from the turn's user message up to that card. A
 * "don't ask again" approval counts too: it is still a click per call.
 * @param {ArrayLike<any>} items - The thread's items, in order
 * @param {string} itemId - The card's item id
 * @returns {number} How many earlier calls in the turn were approved by hand
 */
export function userApprovalsThisTurn(items, itemId) {
  let end = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (field(items[i], 'itemId') === itemId) { end = i; break; }
  }
  let count = 0;
  for (let i = end - 1; i >= 0; i--) {
    const type = field(items[i], 'type');
    if (type === 'user') break;
    if (type !== 'tool-action' || field(items[i], 'approvalSource') !== 'user') continue;
    const response = field(items[i], 'approvalResponse');
    if (response === 'yes' || response === 'yes-always') count++;
  }
  return count;
}

/**
 * The strategies the hint offers a thread running `currentId`. Nothing is
 * offered under the most permissive one. Under Auto-approve, only YOLO is.
 * @param {string} currentId - The thread's effective strategy
 * @param {Array<{id: string}>} available - The registered, visible strategies (strategyRegistry.getAllManifests())
 * @returns {string[]} The ids to offer, least permissive first
 */
export function hintStrategyIds(currentId, available) {
  const present = new Set(available.map((s) => s.id));
  const from = HINT_STRATEGY_IDS.indexOf(currentId) + 1;
  return HINT_STRATEGY_IDS.slice(from).filter((id) => present.has(id));
}
