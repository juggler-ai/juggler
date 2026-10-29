//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The pinboard as *this viewer* sees it: whether the board is open, which tab is
 * active, and what the last edit had to say for itself. None of that is shared —
 * {@link module:services/pinboard-store} holds the composition every viewer
 * agrees on, and a laptop and a detached display must not fight over which tab
 * either of them is reading.
 *
 * It is also the host service the rest of the UI calls to act on the board:
 * `toggle()`, `reveal()`, `addSource()`. A properties panel that wants to pin a
 * file describes the file and asks here; it never names a pin class, and it never
 * reaches into the board's components.
 *
 * The active pin is reconciled here rather than in the panel, because the board
 * changes for reasons this viewer had nothing to do with: another viewer removing
 * the pin you were reading must land you on its neighbour, not on the empty state.
 *
 * A board window also remembers its active pin across launches, as a preference
 * of that window ({@link ACTIVE_PREF}). The window that reopens it at launch
 * knows which board it was but not which tab it was showing.
 * @module services/pinboard-view
 */

import pinboardStore from './pinboard-store.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import { initialPinId, isPinboardView } from '../utils/view-mode.js';
import { cachedWindowPref, getWindowPref, setWindowPref } from './prefs.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';

/** @typedef {import('./pinboard-store.js').Pin} Pin */

/** @type {boolean} */
let _open = false;

/** @type {string|null} */
let _activePinId = null;

/**
 * Where the active pin sat in the board the last time it was there. The board is
 * shared, so the pin being read can be removed by someone else; this is what lets
 * the tab to its right take over instead of the selection collapsing.
 * @type {number}
 */
let _activeIndex = 0;

/**
 * Whether the pin a board window was opened on has had its chance. The seed is
 * spent on the first board that arrives, found or not: a board is shared, so a
 * pin that has been removed since the window opened is a stale selection like
 * any other, and holding the seed for a later load would jump the user back to
 * it long after they had moved on.
 * @type {boolean}
 */
let _seedSpent = false;

/**
 * The window preference a board window keeps its active pin under. It is kept
 * per window role, so each board window has its own. The docked panel does not
 * keep one: every Juggler window of a project shares the 'main' role, and they
 * would overwrite each other's.
 */
const ACTIVE_PREF = 'juggler-pinboard-active';

/**
 * Whether the active pin was chosen by something newer than the remembered one:
 * the pin a pop-out named, or the user picking a tab. Once true, the remembered
 * pin is not applied even if it arrives later.
 * @type {boolean}
 */
let _chosen = false;

/**
 * Whether the session has answered with the remembered pin. Until it does, the
 * first tab is only a placeholder and is not saved, because saving it would
 * overwrite the value that is still on its way.
 * @type {boolean}
 */
let _recalled = false;

/** @type {string|null} The pin last written to {@link ACTIVE_PREF}. */
let _remembered = null;

/**
 * Incremented on each {@link pinboardView.reset}. A session read started before
 * the reset compares against it and applies nothing to the new state.
 * @type {number}
 */
let _generation = 0;

/** @type {string} */
let _status = '';

/**
 * How long a pin's type is given to release what it started before the removal
 * goes ahead without it. Long enough for a local server to be asked to stop,
 * short enough that a click on Remove is still a click that removes something.
 * @type {number}
 */
const RELEASE_TIMEOUT_MS = 2000;

/** @type {Set<() => void>} */
const _subscribers = new Set();

/**
 * Tell everyone the view changed. Subscribers re-read state rather than being
 * handed it: there are three fields and they are always read together.
 * @returns {void}
 */
function notify() {
  rememberActive();
  for (const fn of _subscribers) {
    try {
      fn();
    } catch (err) {
      console.error('[Pinboard] View subscriber failed:', err);
    }
  }
}

/**
 * Settle the active pin against a board. Keeps the current pin if it survived;
 * otherwise takes the one that slid into its place, and failing that the last one.
 * @param {Pin[]} pins - The board.
 * @returns {boolean} True when the active pin changed.
 */
function reconcileActive(pins) {
  const index = pins.findIndex((p) => p.id === _activePinId);
  if (index >= 0) {
    _activeIndex = index;
    return false;
  }
  if (!pins.length) {
    const had = _activePinId !== null;
    _activePinId = null;
    _activeIndex = 0;
    return had;
  }
  // A board window opens on the pin it was popped out on, if any. Failing that,
  // it opens on the pin it remembers from its last run. Both seeds are used
  // once, when the first board arrives, and then discarded.
  if (!_seedSpent) {
    _seedSpent = true;
    recallActive();
    const seeded = pins.findIndex((p) => p.id === initialPinId());
    if (seeded >= 0) {
      _chosen = true;
      _activePinId = /** @type {Pin} */ (pins[seeded]).id;
      _activeIndex = seeded;
      return true;
    }
    const remembered = pins.findIndex((p) => p.id === rememberedPinId());
    if (remembered >= 0) {
      _activePinId = /** @type {Pin} */ (pins[remembered]).id;
      _activeIndex = remembered;
      return true;
    }
  }
  const next = Math.min(_activeIndex, pins.length - 1);
  _activePinId = /** @type {Pin} */ (pins[next]).id;
  _activeIndex = next;
  return true;
}

/**
 * The pin this board window remembers, read from cache without waiting for the
 * session. The cache is localStorage, which is keyed by port, so after a
 * relaunch on another port it may be empty; {@link recallActive} then supplies
 * the value from the session.
 * @returns {string} The pin id, or '' outside a board window or when none is known.
 */
function rememberedPinId() {
  if (!isPinboardView()) return '';
  const pinId = cachedWindowPref(ACTIVE_PREF, '');
  return typeof pinId === 'string' ? pinId : '';
}

/**
 * Ask the session which pin this board window remembers, and switch to it when
 * the answer arrives, unless the pin has been chosen since or is no longer on the
 * board.
 * @returns {void}
 */
function recallActive() {
  if (!isPinboardView()) return;
  const generation = _generation;
  void getWindowPref(ACTIVE_PREF, null).then((pinId) => {
    if (generation !== _generation) return;
    _recalled = true;
    if (typeof pinId === 'string') _remembered = pinId;
    if (_chosen || typeof pinId !== 'string' || pinId === _activePinId) {
      // The active pin may have changed while the read was in flight, and was
      // not saved because _recalled was still false. Save it now.
      rememberActive();
      return;
    }
    const index = pinboardStore.get().findIndex((p) => p.id === pinId);
    if (index < 0) {
      rememberActive();
      return;
    }
    _activePinId = pinId;
    _activeIndex = index;
    notify();
  });
}

/**
 * Save the active pin as this board window's preference, once it counts as a
 * choice (see {@link _chosen} and {@link _recalled}) and only if it changed.
 * @returns {void}
 */
function rememberActive() {
  if (!isPinboardView() || !(_chosen || _recalled)) return;
  if (!_activePinId || _activePinId === _remembered) return;
  _remembered = _activePinId;
  void setWindowPref(ACTIVE_PREF, _activePinId);
}

pinboardStore.subscribe((pins) => {
  if (reconcileActive(pins)) notify();
});

/**
 * The pin already on the board that a new one of this type and config would
 * duplicate, if any. A singleton type collides with itself whatever its config;
 * a multiple-instance type collides only with a pin describing the same thing.
 * @param {string} typeId - Item-type id.
 * @param {Record<string, unknown>} config - Normalized config for the new pin.
 * @returns {Pin|null} The existing pin to reveal instead, or null.
 */
function findDuplicate(typeId, config) {
  const type = pinboardItemRegistry.getType(typeId);
  for (const pin of pinboardStore.get()) {
    if (pin.type !== typeId) continue;
    // Without a provider there is no isSameConfig to ask, so fall back to the
    // same shallow comparison the SDK defaults to.
    if (!type) {
      if (JSON.stringify(pin.config) === JSON.stringify(config)) return pin;
      continue;
    }
    if (!type.allowsMultiple) return pin;
    try {
      if (type.isSameConfig(pin.config, config)) return pin;
    } catch (err) {
      console.error(`[Pinboard] Item type "${typeId}" failed to compare configs:`, err);
    }
  }
  return null;
}

/**
 * The one pin type a board is pruned of: `changed-files`, withdrawn once the Git
 * pin became the review surface for the whole working tree.
 *
 * Named exactly, never "any type the registry does not know". An unknown type is
 * ordinarily an extension that has not loaded yet or has been disabled, and the
 * host draws a placeholder for it on purpose; pruning on that rule would delete
 * a user's pins the first time an extension failed to load.
 */
const RETIRED_PIN_TYPE = 'changed-files';

/**
 * The types a board is furnished with when it is new, in the order their tabs
 * should sit in.
 *
 * `canAdd` is deliberately not consulted. It answers whether a type has anything
 * to show *now* — most of these want a conversation, and a project usually opens
 * without one — but the board is being arranged for the project's life, not for
 * this instant, and a tab that says what it is waiting for is more use than a tab
 * that was never placed.
 * @returns {Array<{id: string, order: number}>} Default types, in tab order.
 */
function defaultTypes() {
  /** @type {Array<{id: string, order: number}>} */
  const types = [];
  for (const type of pinboardItemRegistry.getEnabledTypes()) {
    let manifest;
    try {
      manifest = type.getManifest();
    } catch (err) {
      console.error(`[Pinboard] Item type "${type.id}" failed to describe itself:`, err);
      continue;
    }
    if (!manifest.defaultPin) continue;
    types.push({ id: type.id, order: Number.isFinite(manifest.order) ? Number(manifest.order) : 0 });
  }
  // Stable: Array.prototype.sort is, so equal orders keep registration order —
  // the same rule the add picker sorts by, so the two agree.
  return types.sort((a, b) => a.order - b.order);
}

/**
 * Run a board edit, reporting a failure as the panel's status line rather than
 * throwing at a click handler. A successful edit clears whatever the last one
 * left behind.
 * @param {(error: string) => string} failed - The whole status line for a
 *   failure, given the error's own text.
 * @param {() => Promise<any>} edit - The store call.
 * @returns {Promise<any>} What the edit returned, or null if it failed.
 */
async function attempt(failed, edit) {
  try {
    const result = await edit();
    pinboardView.setStatus('');
    return result;
  } catch (err) {
    pinboardView.setStatus(failed(errorText(err)));
    return null;
  }
}

/**
 * Offer a pin's type the moment before its pin goes, so it can release what that
 * pin created — a server it started, a connection it opened. What it was merely
 * looking at is not its to touch: removing a view is not an instruction to act
 * on the world it was a view of.
 *
 * Advisory in every direction. It is awaited, so a type that stops a process has
 * a chance to finish; a type that throws is logged and the removal goes ahead
 * regardless; and a type that takes longer than {@link RELEASE_TIMEOUT_MS} is
 * left to finish on its own while the removal goes ahead without it. A pin the
 * user has asked to be rid of goes whatever its extension thinks about it, and
 * a Remove button that can be made to hang is not a Remove button.
 * @param {Pin} pin - The pin about to be removed.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} [active] - The active snapshot.
 * @returns {Promise<void>} Resolves once the type has had its turn, or its time.
 */
async function releasePin(pin, active) {
  const type = pinboardItemRegistry.getType(pin.type);
  if (!type) return;
  let config = pin.config;
  try {
    config = type.normalizeConfig(pin.config) ?? config;
  } catch {
    // A type that cannot make sense of its own stored config is still owed the
    // chance to release what it started; the raw config is better than nothing.
  }
  /** @type {number|undefined} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = window.setTimeout(() => {
      console.error(`[Pinboard] Item type "${pin.type}" took too long to release its pin; removing it anyway.`);
      resolve(undefined);
    }, RELEASE_TIMEOUT_MS);
  });
  const released = (async () => {
    try {
      await type.willRemove(config, { active: active ?? null });
    } catch (err) {
      console.error(`[Pinboard] Item type "${pin.type}" failed to release its pin:`, err);
    }
  })();
  await Promise.race([released, expired]);
  window.clearTimeout(timer);
}

const pinboardView = {
  /**
   * Subscribe to view changes — open/closed, active pin, status. Fires after the
   * change, and callers should seed themselves from the getters first.
   * @param {() => void} fn - Called on every change.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  },

  /** @returns {boolean} True while the board is open in this viewer. */
  isOpen() {
    return _open;
  },

  /**
   * Open the board. Selects the last active pin if it is still there, otherwise
   * the first one.
   * @returns {void}
   */
  open() {
    const pins = pinboardStore.get();
    if (!pins.some((p) => p.id === _activePinId)) reconcileActive(pins);
    if (_open) return;
    _open = true;
    notify();
  },

  /**
   * Close the board. Pins are untouched: this is a viewer putting a panel away.
   * @returns {void}
   */
  close() {
    if (!_open) return;
    _open = false;
    notify();
  },

  /**
   * Toggle the board.
   * @returns {boolean} True if the board is now open.
   */
  toggle() {
    if (_open) this.close();
    else this.open();
    return _open;
  },

  /** @returns {string|null} The active pin's id, or null when nothing is active. */
  getActivePinId() {
    return _activePinId;
  },

  /**
   * Make a pin the active tab in this viewer, without opening the board.
   * @param {string|null} pinId - The pin to select.
   * @returns {void}
   */
  setActivePin(pinId) {
    _chosen = true;
    if (_activePinId === pinId) {
      rememberActive();
      return;
    }
    _activePinId = pinId;
    const index = pinboardStore.get().findIndex((pin) => pin.id === pinId);
    if (index >= 0) _activeIndex = index;
    notify();
  },

  /**
   * Move the selection one tab along the board — what every "next pin" key ends
   * up calling, wherever focus happens to be.
   *
   * It stops at the ends rather than wrapping, which is the rule the tab strip's
   * own arrows already follow. A board is a short row read left to right, and a
   * key held down to reach the far end should arrive there and stay, not set off
   * again from the beginning.
   * @param {number} delta - -1 for the tab to the left, 1 for the one to the right.
   * @returns {string|null} The pin now active, or null when the board is empty.
   */
  selectRelative(delta) {
    const pins = pinboardStore.get();
    if (!pins.length) return null;
    // The remembered index is the fallback for a board whose active pin has been
    // removed by another viewer between the keypress and here: stepping from
    // where that pin was is what the reader is looking at.
    const current = pins.findIndex((p) => p.id === _activePinId);
    const from = current >= 0 ? current : Math.min(_activeIndex, pins.length - 1);
    const to = Math.max(0, Math.min(pins.length - 1, from + delta));
    const pin = /** @type {Pin} */ (pins[to]);
    this.setActivePin(pin.id);
    return pin.id;
  },

  /**
   * Open the board on a particular pin.
   * @param {string} pinId - The pin to show.
   * @returns {void}
   */
  reveal(pinId) {
    this.setActivePin(pinId);
    this.open();
  },

  /**
   * Open the board on a pin put there earlier — by the agent, say — whose id
   * the caller kept. A pin the user has since removed is put back under the same
   * id and config, unless the board already shows the same thing under another,
   * in which case that one is revealed instead.
   * @param {string} pinId - The pin's id.
   * @param {string} typeId - Its item-type id, for putting it back.
   * @param {Record<string, unknown>} config - Its config, for putting it back.
   * @returns {Promise<boolean>} True when the board is now showing it.
   */
  async show(pinId, typeId, config) {
    if (!pinboardStore.getPin(pinId)) {
      const type = pinboardItemRegistry.getType(typeId);
      let normalized = config;
      try {
        normalized = type?.normalizeConfig(config) ?? config;
      } catch (err) {
        console.error(`[Pinboard] Item type "${typeId}" failed to normalize a config:`, err);
      }
      const existing = findDuplicate(typeId, normalized);
      if (existing) {
        this.reveal(existing.id);
        return true;
      }
      const pins = await attempt((error) => t("Couldn't put that pin back. {error}", { error }),
        () => pinboardStore.applyOperations([{ op: 'add', id: pinId, type: typeId, config }]));
      if (!pins?.some((/** @type {Pin} */ pin) => pin.id === pinId)) return false;
    }
    this.reveal(pinId);
    return true;
  },

  /** @returns {string} The last edit's complaint, or '' when there is nothing to say. */
  getStatus() {
    return _status;
  },

  /**
   * Set (or clear) the panel's status line.
   * @param {string} message - What to say; '' clears it.
   * @returns {void}
   */
  setStatus(message) {
    if (_status === message) return;
    _status = message;
    notify();
  },

  /**
   * Add a pin of a type, revealing the pin that already says the same thing
   * rather than adding a second one.
   * @param {string} typeId - Item-type id.
   * @param {Record<string, unknown>} [config] - Provider config.
   * @returns {Promise<Pin|null>} The pin now showing, or null if the add failed.
   */
  async add(typeId, config = {}) {
    const type = pinboardItemRegistry.getType(typeId);
    let normalized = config;
    if (type) {
      try {
        normalized = type.normalizeConfig(config) ?? config;
      } catch (err) {
        console.error(`[Pinboard] Item type "${typeId}" failed to normalize a config:`, err);
      }
    }
    const existing = findDuplicate(typeId, normalized);
    if (existing) {
      this.reveal(existing.id);
      return existing;
    }
    const pin = await attempt((error) => t("Couldn't add that pin. {error}", { error }),
      () => pinboardStore.add(typeId, normalized));
    if (pin) this.reveal(pin.id);
    return pin;
  },

  /**
   * Lay out a new board's starting tabs, so a project opens on something rather
   * than on an empty board and a `+` button.
   *
   * Done once in a board's life, and the server is the one that decides whose
   * turn it is — several windows of a project all reach here as they load. After
   * that the board is the user's: a starting tab they remove stays removed, and
   * an emptied board is left empty.
   *
   * Only the docked panel is furnished. A detached board is created carrying the
   * tabs of the panel it was detached from, so it has never been empty.
   * @returns {Promise<void>} Resolves once the board has been furnished, or once
   *   it is settled that this viewer is not the one to do it.
   */
  async furnish() {
    if (isPinboardView()) return;
    const types = defaultTypes();
    // Nothing to furnish it with, so nothing is claimed: spending the claim here
    // would leave a board that is never laid out at all, because the extension
    // that would have filled it arrives after the claim is gone.
    if (!types.length) return;
    let claimed = false;
    try {
      claimed = await pinboardStore.claimSeed();
    } catch (err) {
      // A board that cannot be furnished is an empty board, which is what the
      // user already has. The panel's status line is for edits they asked for.
      console.error('[Pinboard] Could not ask whether to furnish the board:', err);
      return;
    }
    if (!claimed) return;
    await attempt(
      (error) => t("Couldn't set the pinboard up. {error}", { error }),
      () => pinboardStore.addAll(types.map(({ id }) => ({ type: id }))),
    );
  },

  /**
   * Take the retired pin off this board, if it is on it.
   *
   * Every viewer runs this as its board loads, and runs it again next time the
   * app starts. Nothing records that it has been done, and nothing needs to:
   * once the pin is gone there is nothing left to match, so a second pass asks
   * for nothing. Two viewers pruning at the same moment are two removes of the
   * same id, which the server applies once.
   *
   * The store's op rather than {@link remove}: this is a batch of operations,
   * not the user removing a pin, and the type whose `willRemove` that would
   * offer is exactly the type that no longer exists.
   * @returns {Promise<void>} Resolves once the board has been pruned, or once
   *   it is settled that there was nothing to prune.
   */
  async prune() {
    const retired = pinboardStore.get().filter((pin) => pin.type === RETIRED_PIN_TYPE);
    if (!retired.length) return;
    await attempt(
      (error) => t("Couldn't tidy the pinboard. {error}", { error }),
      () => pinboardStore.applyOperations(retired.map((pin) => ({ op: 'remove', id: pin.id }))),
    );
  },

  /**
   * Whether anything enabled could pin this source. For a surface deciding
   * whether to offer the action at all: a "Pin to Pinboard" button that does
   * nothing when clicked is worse than no button, so ask first and leave it out.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What would be pinned.
   * @returns {boolean} True when some enabled item type would take it.
   */
  canPin(source) {
    return !!pinboardItemRegistry.resolveSource(source);
  },

  /**
   * Pin something the user pointed at elsewhere in the UI — a file in a
   * properties panel, say. The registry decides which enabled type can take it,
   * so the caller describes what it has instead of naming a provider.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What to pin.
   * @returns {Promise<Pin|null>} The pin now showing, or null if nothing could pin it.
   */
  async addSource(source) {
    const resolved = pinboardItemRegistry.resolveSource(source);
    if (!resolved) return null;
    return this.add(resolved.typeId, resolved.config);
  },

  /**
   * Remove a pin from the shared board. Removing the panel never touches what it
   * was showing — only what it started; see {@link releasePin}.
   * @param {string} pinId - The pin to remove.
   * @param {import('juggler/pinboard-item-type').PinActiveContext} [active] - The
   *   active-context snapshot, for the type's release hook. The panel has one to
   *   hand; nothing else that removes a pin needs to.
   * @returns {Promise<void>}
   */
  async remove(pinId, active) {
    const pin = pinboardStore.getPin(pinId);
    if (pin) await releasePin(pin, active);
    await attempt((error) => t("Couldn't remove that pin. {error}", { error }), () => pinboardStore.remove(pinId));
  },

  /**
   * Move a pin in the shared board order.
   * @param {string} pinId - The pin to move.
   * @param {number} index - Where to put it.
   * @returns {Promise<void>}
   */
  async move(pinId, index) {
    await attempt((error) => t("Couldn't move that pin. {error}", { error }), () => pinboardStore.move(pinId, index));
  },

  /**
   * Drop the view state without touching the board. For tests and teardown.
   * @returns {void}
   */
  reset() {
    _open = false;
    _activePinId = null;
    _activeIndex = 0;
    _seedSpent = false;
    _chosen = false;
    _recalled = false;
    _remembered = null;
    _generation++;
    _status = '';
  },
};

export default pinboardView;
