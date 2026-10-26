//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * held-send-flag — whether any thread of a conversation holds a held send
 * ("Send later"): a queued entry stamped with `notBefore` or `hold`. The
 * conversation bar paints a tab's clock from it.
 *
 * The bar asks on every render, and renders on every document change (~100 a
 * second while a turn streams), so the answer is cached. Finding it walks every
 * thread's queue; the walk runs only on the first read after a transaction that
 * could have changed it — one that touched a `pendingItems` array, an entry in
 * one, a map gaining or losing one, or an `items` array (a thread, and its
 * queue, coming or going). A streaming write touches none of these, so it costs
 * a look at the types the transaction changed and no walk.
 *
 * It reads the document, not the drafts or any client's state, so every client
 * of the conversation shows the same clock whoever scheduled the send.
 * @module model/held-send-flag
 */

import * as Y from '../vendor/yjs.mjs';

const PENDING_KEY = 'pendingItems';
const ITEMS_KEY = 'items';

/**
 * Whether a queue entry carries a hold.
 * @param {any} entry
 * @returns {boolean} True for a held entry.
 */
function isHeld(entry) {
  return entry instanceof Y.Map && (typeof entry.get('notBefore') === 'number' || !!entry.get('hold'));
}

/**
 * Whether the thread container `map`, or any thread below it, holds a held send.
 * @param {any} map - The doc root or a thread's item map.
 * @returns {boolean} True when some queue holds one.
 */
function holdsHeldSend(map) {
  const queue = map.get(PENDING_KEY);
  if (queue instanceof Y.Array && queue.toArray().some(isHeld)) return true;
  const items = map.get(ITEMS_KEY);
  if (!(items instanceof Y.Array)) return false;
  for (const child of items.toArray()) {
    if (child instanceof Y.Map && (child.has(ITEMS_KEY) || child.has(PENDING_KEY)) && holdsHeldSend(child)) return true;
  }
  return false;
}

/**
 * Whether a transaction may have changed what the queues hold.
 * @param {Y.Transaction} tr
 * @returns {boolean} True when the cached answer may be stale.
 */
function touchesQueues(tr) {
  for (const [type, keys] of tr.changed) {
    if (keys.has(PENDING_KEY) || keys.has(ITEMS_KEY)) return true;
    const key = type._item?.parentSub;
    if (type instanceof Y.Array && (key === PENDING_KEY || key === ITEMS_KEY)) return true;
    // A key of a queue entry: a hold stamped or dropped.
    if (type instanceof Y.Map && /** @type {any} */ (type._item?.parent)?._item?.parentSub === PENDING_KEY) return true;
  }
  return false;
}

export class HeldSendFlag {
  /**
   * @param {Y.Doc} doc - The conversation's document.
   * @param {any} root - Its root map, where the root thread's queue lives.
   */
  constructor(doc, root) {
    this._doc = doc;
    this._root = root;
    this._stale = true;
    this._value = false;
    /** How many times the queues were walked; read by tests. */
    this.walks = 0;
    this._onTransaction = (/** @type {Y.Transaction} */ tr) => {
      if (!this._stale && touchesQueues(tr)) this._stale = true;
    };
    doc.on('afterTransaction', this._onTransaction);
  }

  /**
   * Whether any thread holds a held send.
   * @returns {boolean} The cached answer, recomputed if a queue may have changed.
   */
  get value() {
    if (this._stale) {
      this._stale = false;
      this.walks++;
      this._value = holdsHeldSend(this._root);
    }
    return this._value;
  }

  /** Stop watching the document. */
  destroy() {
    this._doc.off('afterTransaction', this._onTransaction);
  }
}
