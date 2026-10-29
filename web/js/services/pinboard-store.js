//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client mirror of this document's pinboard composition — which pins are on the
 * board, in what order, configured how. The board is server-backed session
 * state, so this module owns exactly one thing: keeping the local copy true.
 *
 * One document reads exactly one board, named in its URL and fixed for its life:
 * the Juggler shell reads the shared one behind the docked panel, and a detached
 * window reads its own. So this stays a singleton, and the board it is a mirror
 * of is decided once, at load, by {@link module:utils/view-mode}. Every request
 * names it and every broadcast is checked against it, because the server tells
 * every viewer about every board — it has no way to know which one any of them
 * is showing.
 *
 * What is deliberately NOT here: whether the board is open, which tab is active,
 * how wide the panel is, where each pin was scrolled to. That is per-viewer
 * presentation, and a laptop and a detached display must not fight over it.
 *
 * Edits are semantic operations, not whole-board writes, and the server merges
 * them on its session actor — so there is no revision, no conflict response, and
 * no rebase. Two viewers editing at the same instant both land. Each op names its
 * pin and is idempotent, so a retry after a dropped response cannot duplicate one.
 *
 * Every edit round-trips before the local board changes. The alternative —
 * applying optimistically and reconciling — would mean a second implementation of
 * the merge semantics living in the client, free to disagree with the server's.
 * The request is to a loopback server; correctness is worth more than the
 * milliseconds.
 *
 * Registers its websocket listeners at module-evaluation time, which precedes the
 * app's `connect()` — the same ordering `providers-cache.js` relies on.
 */

import wsService from './websocket.js';
import { fetchJson } from './http.js';
import { applyPinboardOperations } from './pinboard-operations-api.js';
import { boardId } from '../utils/view-mode.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * One pin: a configured instance of a pinboard item type.
 * @typedef {object} Pin
 * @property {string} id - Stable client-generated id
 * @property {string} type - Item-type id, e.g. 'file'
 * @property {Record<string, unknown>} config - Provider-owned configuration
 * @property {string} [addedAt] - RFC3339 timestamp the server stamped on the pin
 */

/**
 * One semantic edit. The server applies a batch in order and rejects it whole if
 * any op is malformed.
 * @typedef {object} PinboardOp
 * @property {'add'|'remove'|'move'|'update'} op - What to do
 * @property {string} id - The pin to act on
 * @property {string} [type] - add: the item-type id
 * @property {Record<string, unknown>} [config] - add, update: provider config
 * @property {number} [index] - add, move: target position (add appends when absent)
 */

/** @type {Pin[]} */
let _pins = [];

/** @type {boolean} */
let _loaded = false;

/** @type {Set<(pins: Pin[]) => void>} */
const _subscribers = new Set();

/**
 * Coerce a server payload into pins, dropping anything malformed. The board is
 * long-lived state written by many versions of many extensions, so nothing off
 * the wire is trusted to have the shape it should.
 * @param {unknown} raw - The `pins` value from a response or websocket event.
 * @returns {Pin[]} Well-formed pins, in order.
 */
function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Pin[]} */
  const pins = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, type, config, addedAt } = /** @type {any} */ (entry);
    if (typeof id !== 'string' || !id) continue;
    if (typeof type !== 'string' || !type) continue;
    /** @type {Pin} */
    const pin = {
      id,
      type,
      config: config && typeof config === 'object' ? config : {},
    };
    if (typeof addedAt === 'string') pin.addedAt = addedAt;
    pins.push(pin);
  }
  return pins;
}

/**
 * Adopt a new board and tell subscribers, unless it is what we already had. The
 * equality check matters: a board edit is broadcast to every viewer including the
 * one that made it, and re-notifying on an identical board would rebuild tabs and
 * lose the user's place for no reason.
 * @param {Pin[]} pins - The new board.
 * @returns {void}
 */
function adopt(pins) {
  const changed = !_loaded || JSON.stringify(pins) !== JSON.stringify(_pins);
  _pins = pins;
  _loaded = true;
  if (!changed) return;
  for (const fn of _subscribers) {
    try {
      fn(_pins);
    } catch (err) {
      console.error('[Pinboard] Subscriber failed:', err);
    }
  }
}

// Page-lifetime subscriptions, never released by design: the store is the
// page's one board, and lives exactly as long as the socket it listens to.
//
// The whole frame, not just its pins: a broadcast goes to every viewer of the
// project, and which board it is about is the only way to tell whether it is
// about this one.
wsService.on('pinboard-changed', (/** @type {any} */ data) => {
  const board = typeof data?.board === 'string' ? data.board : '';
  if (board && board !== boardId()) return;
  adopt(sanitize(data?.pins));
});

// A project switch replaces the session, and with it the board. Drop the old one
// rather than showing another project's pins until a reload happens to arrive.
wsService.on('project-changed', () => {
  _loaded = false;
  adopt([]);
  void pinboardStore.load().catch(() => {
    // The shell reports a board it can't load; a background refresh that fails
    // has nowhere useful to say so.
  });
});

/**
 * Send a batch of operations and adopt the board the server returns.
 * @param {PinboardOp[]} operations - The edits to apply.
 * @returns {Promise<Pin[]>} The resulting board.
 */
async function applyOperations(operations) {
  if (!operations.length) return _pins;
  const data = await applyPinboardOperations(boardId(), operations);
  const pins = sanitize(data?.pins);
  adopt(pins);
  return pins;
}

/**
 * Mint an id for a new pin. Client-generated on purpose: it is what makes a
 * retried add idempotent rather than a second pin.
 * @returns {string} A fresh pin id.
 */
function newPinId() {
  return `pin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mint an id for a new board, on the same reasoning as a pin's: a detach whose
 * response went missing can be retried without opening a second board for the
 * same window.
 * @returns {string} A fresh board id.
 */
function newBoardId() {
  return `board_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const pinboardStore = {
  /**
   * The current board. Synchronous, so a render never has to await; callers that
   * need the first real value should `load()` or subscribe.
   * @returns {Pin[]} The pins, in board order.
   */
  get() {
    return _pins;
  },

  /**
   * One pin off the current board, by id.
   * @param {string} pinId - The pin wanted.
   * @returns {Pin|null} The pin, or null when the board does not have it.
   */
  getPin(pinId) {
    return _pins.find((pin) => pin.id === pinId) || null;
  },

  /** @returns {boolean} True once a board has been read from the server. */
  isLoaded() {
    return _loaded;
  },

  /**
   * Subscribe to board changes. The callback fires only when the board actually
   * differs, so callers should seed themselves from `get()` first.
   * @param {(pins: Pin[]) => void} fn - Called with each new board.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  },

  /**
   * Fetch the board from the server.
   * @returns {Promise<Pin[]>} The pins, in board order.
   */
  async load() {
    const data = await fetchJson(apiUrl(`/session/pinboard?board=${encodeURIComponent(boardId())}`), {
      errorPrefix: '[Pinboard] Failed to load the pinboard',
    });
    const pins = sanitize(data?.pins);
    adopt(pins);
    return pins;
  },

  /**
   * Add a pin.
   * @param {string} type - Item-type id.
   * @param {Record<string, unknown>} [config] - Provider config.
   * @param {{index?: number}} [options] - Where to put it; appends by default.
   * @returns {Promise<Pin|null>} The new pin, or null if the server dropped it.
   */
  async add(type, config = {}, options = {}) {
    const id = newPinId();
    /** @type {PinboardOp} */
    const op = { op: 'add', id, type, config };
    if (typeof options.index === 'number') op.index = options.index;
    const pins = await applyOperations([op]);
    return pins.find((p) => p.id === id) || null;
  },

  /**
   * Add several pins as one batch, in the order given. One request and one
   * broadcast, so a board being furnished appears as a board rather than as six
   * tabs arriving one at a time.
   * @param {Array<{type: string, config?: Record<string, unknown>}>} entries - What to add.
   * @returns {Promise<Pin[]>} The resulting board.
   */
  async addAll(entries) {
    /** @type {PinboardOp[]} */
    const ops = entries.map(({ type, config }) => ({
      op: 'add',
      id: newPinId(),
      type,
      config: config || {},
    }));
    return applyOperations(ops);
  },

  /**
   * Ask whether this viewer is the one to lay out the board's starting tabs.
   *
   * The server answers yes at most once in a board's life, because the answer is
   * an instruction to write pins: every window reading this board asks as it
   * loads, and a second one told yes would lay out a second set on top of the
   * first. What the tabs are is not the server's business — a pin's type belongs
   * to an extension, and the session knows one only as an opaque string — so the
   * claim is all that crosses the wire and the caller holds the list.
   * @returns {Promise<boolean>} True when this viewer should furnish the board.
   */
  async claimSeed() {
    const data = await fetchJson(apiUrl(`/session/pinboard/seed?board=${encodeURIComponent(boardId())}`), {
      method: 'POST',
      errorPrefix: '[Pinboard] Could not ask whether to furnish the board',
    });
    return data?.seed === true;
  },

  /**
   * Remove a pin. Removing the panel never touches what it was *showing*: a Tasks
   * pin does not stop tasks it merely listed, a memory pin does not edit
   * MEMORY.md, a file pin does not delete a file.
   *
   * What a pin *started* is the other half of that line and belongs to the pin:
   * a type may define `willRemove` to release a server it launched, which
   * `pinboardView.remove` awaits on the way through. This is the low-level edit
   * and does not call it — a batch of operations is not a user removing a pin —
   * so anything that removes a pin on the user's behalf should go through the
   * view rather than here.
   * @param {string} pinId - The pin to remove.
   * @returns {Promise<Pin[]>} The resulting board.
   */
  async remove(pinId) {
    return applyOperations([{ op: 'remove', id: pinId }]);
  },

  /**
   * Move a pin to a new position in the shared board order.
   * @param {string} pinId - The pin to move.
   * @param {number} index - Target position.
   * @returns {Promise<Pin[]>} The resulting board.
   */
  async move(pinId, index) {
    return applyOperations([{ op: 'move', id: pinId, index }]);
  },

  /**
   * Replace a pin's config wholesale.
   * @param {string} pinId - The pin to reconfigure.
   * @param {Record<string, unknown>} config - The new config.
   * @returns {Promise<Pin[]>} The resulting board.
   */
  async updateConfig(pinId, config) {
    return applyOperations([{ op: 'update', id: pinId, config }]);
  },

  /**
   * Send several edits as one batch — one user action, applied or refused whole.
   * @param {PinboardOp[]} operations - The edits.
   * @returns {Promise<Pin[]>} The resulting board.
   */
  async applyOperations(operations) {
    return applyOperations(operations);
  },

  /**
   * The board this document is a view of.
   * @returns {string} The board id.
   */
  boardId() {
    return boardId();
  },

  /**
   * Mint an id for a board about to be detached into a window.
   * @returns {string} A fresh board id.
   */
  newBoardId() {
    return newBoardId();
  },

  // The three below are about boards as windows rather than about this
  // document's own composition, which is everything above. They are here because
  // this module owns the board's HTTP surface, and a second module reaching for
  // the same routes would be a second place for the shape to drift.

  /**
   * Record a board for a window being detached, seeded with the pins it should
   * open showing. Creating one that already exists returns it unchanged: a
   * detach whose response went missing is retried, and the retry must not wipe
   * the arrangement of the window that did open.
   * @param {string} boardID - The new board's id.
   * @param {string} conversationId - The conversation it is a view of.
   * @param {Pin[]} pins - What it starts with.
   * @returns {Promise<void>} Resolves once the server has it.
   */
  async createBoard(boardID, conversationId, pins) {
    await fetchJson(apiUrl('/session/pinboard/boards'), {
      method: 'POST',
      body: { id: boardID, conversation: conversationId, pins },
      errorPrefix: '[Pinboard] Could not record the board',
    });
  },

  /**
   * Forget a board and the frame of the window that held it — what closing that
   * window on purpose means.
   * @param {string} boardID - The board to forget.
   * @returns {Promise<void>} Resolves once it is gone.
   */
  async deleteBoard(boardID) {
    await fetchJson(apiUrl(`/session/pinboard/boards?board=${encodeURIComponent(boardID)}`), {
      method: 'DELETE',
      errorPrefix: '[Pinboard] Could not forget the board',
    });
  },

  /**
   * Ask for the detached boards left over from the last run of this server — the
   * windows that were open when Juggler was shut.
   *
   * The server answers once. The answer is an instruction to open windows, and
   * every main window of a project asks as soon as it has an address, so a
   * second asker is told nothing rather than opening a second copy of each.
   * @returns {Promise<Array<{id: string, conversation: string, pins: Pin[]}>>} The boards to reopen.
   */
  async claimDetachedBoards() {
    const data = await fetchJson(apiUrl('/session/pinboard/boards/restore'), {
      method: 'POST',
      errorPrefix: '[Pinboard] Could not ask which boards were open',
    });
    if (!Array.isArray(data?.boards)) return [];
    return data.boards
      .filter((/** @type {any} */ board) =>
        board && typeof board.id === 'string' && typeof board.conversation === 'string')
      .map((/** @type {any} */ board) => ({
        id: board.id,
        conversation: board.conversation,
        pins: sanitize(board.pins),
      }));
  },

  /**
   * Drop the local board without touching the server's. For tests and teardown.
   * @returns {void}
   */
  reset() {
    _pins = [];
    _loaded = false;
  },
};

export default pinboardStore;
