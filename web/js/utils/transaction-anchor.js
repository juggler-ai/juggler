//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Finding a thread's round-trips — its LLM calls — from the items they left.
 *
 * The worker stamps a round-trip's `transactionId` on every item produced
 * during it, and the transaction blob behind that id is what the footer meter,
 * the cache-bust detector and the tool-drift check read. Any of those items
 * names the same round-trip, so which one is read does not matter; what matters
 * is that every round-trip leaves one that is looked at.
 *
 * The anchors are the items a round-trip PRODUCED: its text, its reasoning and
 * its tool calls. A round-trip that only thinks and calls tools — most of them,
 * in an agentic run — writes no assistant message at all, so keying on
 * assistant messages alone skips straight past it to whichever older call last
 * wrote text, and the meter then reports that call's size for as long as the
 * run stays in tools. The user message that started a round-trip carries the
 * same id but sits on the input side, and is not an anchor.
 */

/**
 * A thread item, read through its `get` (a Y.Map, or a stand-in with one).
 * @typedef {{get?: (key: string) => unknown}|null|undefined} AnchorItem
 */

/** Item types a round-trip produces; see the module comment. */
const ROUND_TRIP_OUTPUT_TYPES = new Set(['assistant', 'thinking', 'tool-action']);

/**
 * The transactionId an item anchors, or '' when it is not a round-trip's output.
 * @param {AnchorItem} item
 * @returns {string} The round-trip's transactionId, or ''
 */
function anchoredTxnId(item) {
  const get = item?.get?.bind(item);
  const type = get?.('type');
  if (!get || typeof type !== 'string' || !ROUND_TRIP_OUTPUT_TYPES.has(type)) return '';
  return String(get('transactionId') || '');
}

/**
 * The transactionId of a thread's most recent round-trip.
 * @param {ReadonlyArray<AnchorItem>|null|undefined} items - Y.Array items (or empty)
 * @returns {string} transactionId, or '' if no round-trip has left an item
 */
export function findLastRoundTripTxnId(items) {
  return findRoundTripTxnIds(items, 1)[0] ?? '';
}

/**
 * The same anchors, newest first, stopping at `limit`.
 *
 * The most recent round-trip is not always one that can say what it sent — a
 * call stopped before its provider reported usage, or one that failed, writes a
 * blob with no input count. A consumer that needs a measurement rather than
 * simply the latest round-trip walks back from the newest until it finds one,
 * which is what the limit bounds: each step costs a blob read, and a
 * measurement many calls old describes a context that has since moved on.
 * @param {ReadonlyArray<AnchorItem>|null|undefined} items - Y.Array items (or empty)
 * @param {number} [limit] - How many to return at most
 * @returns {string[]} transactionIds, newest first; empty if the thread has none
 */
export function findRoundTripTxnIds(items, limit = 1) {
  /** @type {string[]} */
  const found = [];
  if (!items || limit <= 0) return found;
  for (let i = items.length - 1; i >= 0 && found.length < limit; i--) {
    const txnId = anchoredTxnId(items[i]);
    // One round-trip leaves several items, and they share its id.
    if (txnId && !found.includes(txnId)) found.push(txnId);
  }
  return found;
}

/**
 * The same anchor, named by item rather than by round-trip: the id of the most
 * recent item a round-trip produced — of `txnId`'s round-trip when one is given.
 * The transaction panel is a lens on a selected item, so anything wanting to
 * *open* a round-trip needs an item of it, not the blob id.
 * @param {ReadonlyArray<AnchorItem>|null|undefined} items - Y.Array items (or empty)
 * @param {string} [txnId] - The round-trip to name an item of; any when omitted
 * @returns {string} itemId, or '' if there is no such item
 */
export function findLastRoundTripItemId(items, txnId) {
  if (!items) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const anchored = anchoredTxnId(items[i]);
    if (!anchored || (txnId && anchored !== txnId)) continue;
    const itemId = String(items[i]?.get?.('itemId') || '');
    if (itemId) return itemId;
  }
  return '';
}
