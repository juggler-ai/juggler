//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import HoldToCycleController, { popupAwareShouldHandle } from './hold-to-cycle.js';
import { isMac } from './key-shortcut-manager.js';
import recentModels from './recent-models.js';
import providersCache from './providers-cache.js';

/**
 * Hold-to-cycle clients for the model shortcuts: {@link ModelCycler}
 * (`cycle-model`, ⌥⌘M / Ctrl+Alt+M — Alt-Tab over the Recent models list) and
 * {@link ThinkingCycler} (`cycle-thinking`, ⌥⌘T / Ctrl+Alt+T — cycle the
 * current model's thinking level). Both own only the cycling logic; the
 * gesture mechanics live in the shared controller, and the applied state is
 * written through public ModelSelector methods that deliberately do NOT
 * record to recents — the landing pair is recorded once, on commit.
 * @module services/model-cycler
 */

/**
 * The `KeyboardEvent.key` name of the primary command modifier — resolves the
 * `mod` in the shortcut bindings the same way `eventMatchesBinding` does:
 * ⌘ (Meta) on macOS, Ctrl elsewhere.
 * @returns {string} 'Meta' on macOS, 'Control' elsewhere.
 */
function commandModifierKey() {
  return isMac() ? 'Meta' : 'Control';
}

/**
 * Get the model selector element the shortcut should act on: the one owned by
 * the column the user is focused in (so a sub-thread composer drives ITS model
 * selector), falling back to the active conversation tab's root selector, then
 * any visible one — mirrors StrategySwitcher's target resolution.
 *
 * The focus-first step matters because `querySelector` returns the first match
 * in DOM order — always the root column's selector — so without it the model /
 * thinking shortcuts silently drove the root conversation even when the cursor
 * sat in a sub-thread composer. These gestures fire window-wide, so focus may
 * be outside any composer; the fallbacks cover that.
 *
 * Exported because every model shortcut has to answer the same question — the
 * same chip+picker pair is hosted by the composer, the settings defaults tab and
 * the command editor, so "which one did they mean" cannot be a `querySelector`
 * at each call site.
 * @returns {any} The model-selector element, or null.
 */
export function getModelSelector() {
  // Prefer the focused composer's own column.
  const focused = /** @type {HTMLElement|null} */ (document.activeElement);
  const box = focused && typeof focused.closest === 'function'
    ? focused.closest('composer-box')
    : null;
  if (box) {
    const owned = box.querySelector('model-selector');
    if (owned) return owned;
  }

  const activeTab = document.querySelector('conversation-tab.active');
  if (activeTab) {
    const selector = activeTab.querySelector('model-selector');
    if (selector) return selector;
  }

  // Fallback: try to find any visible model selector
  return document.querySelector('model-selector');
}

/**
 * Popup ids the model shortcuts OWN — the model dropdown and the mini thinking
 * popover, both surfaces of the model-selector the cyclers drive. Allow-listed
 * in {@link modelGestureShouldHandle} so the window-wide gate never stands the
 * gesture down for its own cycling HUD.
 * @type {string[]}
 */
const OWN_POPUP_IDS = ['model-selector', 'thinking-mini'];

/**
 * The gesture gate for the model/thinking cyclers — the shared window-wide gate
 * ({@link popupAwareShouldHandle}) allow-listing the cyclers' own HUD popups.
 * The same gate drives the strategy switcher, so all three cyclers fire from
 * ANYWHERE in the window on one code path: their chords must reach the right
 * selector no matter where focus sits (composer, a selected context item, a
 * conversation column), and ⌥⌘M being lost to the OS when focus sits outside the
 * composer (bare ⌘M minimises the app) is the very bug this gate fixes. Target
 * resolution (`getModelSelector`) prefers the focused column's selector and
 * falls back to the active tab's root, so the gesture still reaches the right
 * thread; the whole-window capture just stops the keystroke leaking to a foreign
 * overlay (or the OS) first.
 * @type {(e: KeyboardEvent|null) => boolean}
 */
export const modelGestureShouldHandle = popupAwareShouldHandle(OWN_POPUP_IDS);

/**
 * ModelCycler - the `cycle-model` hold-to-cycle client. Alt-Tab semantics over
 * the Recent models list: the gesture snapshots the list once at gesture start
 * (frozen, minus entries whose provider is currently unavailable), so cycling
 * can never reorder the list it is walking; the first press opens the model menu
 * as a HUD showing the CURRENT pair highlighted (no hop), each further press
 * previews the next `{provider, model, thinking?}` pair; releasing the modifiers
 * commits the landing pair. The first
 * cycle (the first re-press) goes to snapshot index 1 — the previous pair —
 * since index 0 is the current one (or to index 0 when the current config isn't
 * in the snapshot at all). With fewer than two entries there is nothing to
 * switch between, so re-presses no-op while the menu still opens on the first
 * press.
 * @class
 */
class ModelCycler {
  constructor() {
    /** @type {import('./recent-models.js').RecentModel[]} @private - Frozen recents snapshot for the active gesture. */
    this._snapshot = [];
    /** @type {number} @private - Snapshot index of the last-applied pair; -1 = current pair absent from the snapshot. */
    this._cursor = -1;
    /**
     * The model selector this gesture drives, snapshotted at gesture start and
     * held for its lifetime so focus drift (menu HUD open, column rebuilds from
     * a running turn) can't retarget us to a different thread mid-cycle. Null
     * between gestures.
     * @type {any} @private
     */
    this._selector = null;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'cycle-model',
      modifierKeys: [commandModifierKey(), 'Alt'],
      // Window-wide: ⌥⌘M must not leak to the OS (bare ⌘M minimises) when focus
      // sits outside the composer — the target still resolves to the focused
      // column (or the active tab's root as fallback).
      shouldHandle: modelGestureShouldHandle,
      canCycle: () => getModelSelector() !== null,
      onGestureStart: () => { this._startGesture(); this._selector?.open(); },
      onCycle: () => this._cycle(),
      onCommit: () => { this._selector?.close(); this._commit(); },
      onCancel: () => { this._selector?.close(); this._cancel(); },
    });
  }

  /**
   * Initialize the model cycler
   * Attaches keyboard event listeners
   */
  init() {
    this._controller.init();
    // Pre-warm the recents cache that `_startGesture` snapshots SYNCHRONOUSLY.
    // Recents are otherwise loaded lazily on menu-open, so the very first ⌥⌘M
    // after a page load would snapshot an empty list and cycle over nothing
    // until a menu-open refresh populated it (repeated presses no-op, but the
    // long-press HUD still shows — "it appears but does nothing the first
    // time"). Best-effort: refresh() never rejects and leaves the cache empty
    // on failure, exactly as before.
    recentModels.refresh().catch(() => {});
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    this._controller.destroy();
  }

  /**
   * Freeze the gesture's working set: the recents list minus entries whose
   * provider is currently unavailable (those are skipped, per the design's
   * edge-case rules), and the cursor pointing at the current pair within it.
   * @private
   */
  _startGesture() {
    // Snapshot the target selector for the gesture's lifetime so every hook
    // drives the same thread even if focus drifts once the HUD opens.
    this._selector = getModelSelector();
    // Hold the model write until commit: hops update the selector's display and
    // its dropdown HUD, but a running turn never sees an intermediate model.
    this._selector?.beginCycle();
    this._snapshot = recentModels.getAvailable(providersCache.getChat());
    const current = this._selector?.currentConfigPair();
    this._cursor = current
      ? this._snapshot.findIndex(r => r.provider === current.provider
        && r.model === current.model && (r.thinking || '') === (current.thinking || '')
        && (r.serviceTier || '') === (current.serviceTier || ''))
      : -1;
  }

  /**
   * Apply the next snapshot pair (wrapping), skipping any that fail to apply
   * (e.g. a provider that lost availability mid-gesture).
   * @private
   */
  _cycle() {
    // 0/1-entry snapshot: nothing to switch between — taps no-op, but the
    // gesture stays engaged so a hold still opens the menu.
    if (this._snapshot.length < 2) return;
    const selector = this._selector;
    if (!selector) return;

    for (let i = 0; i < this._snapshot.length; i++) {
      const next = (this._cursor + 1 + i) % this._snapshot.length;
      if (next === this._cursor) break; // wrapped all the way around
      if (selector.applyConfigPair(this._snapshot[next])) {
        this._cursor = next;
        return;
      }
    }
  }

  /**
   * Commit the gesture's buffered landing model to the document.
   * @private
   */
  _commit() {
    this._selector?.commitCycle();
    this._snapshot = [];
    this._cursor = -1;
    this._selector = null;
  }

  /**
   * Abandon the gesture (Escape): drop the buffered model write so the doc
   * keeps its pre-gesture value, and clear the snapshot.
   * @private
   */
  _cancel() {
    this._selector?.cancelCycle();
    this._snapshot = [];
    this._cursor = -1;
    this._selector = null;
  }
}

/**
 * ThinkingCycler - the `cycle-thinking` hold-to-cycle client. Cycles the
 * CURRENT model's thinking level: Default → the supported levels in canonical
 * order → wrap. The first press opens the mini thinking popover anchored to the
 * button chip showing the CURRENT level (no hop); each further press previews
 * the next level, refreshing the level displays in place so the HUD visibly
 * tracks; releasing the modifiers commits the landing pair. On a model without
 * thinking levels the gesture is a transparent no-op (the press falls through).
 * @class
 */
class ThinkingCycler {
  constructor() {
    /**
     * The model selector this gesture drives, snapshotted at gesture start and
     * held for its lifetime so focus drift (mini popover open, column rebuilds
     * from a running turn) can't retarget us to a different thread mid-cycle.
     * Null between gestures.
     * @type {any} @private
     */
    this._selector = null;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'cycle-thinking',
      modifierKeys: [commandModifierKey(), 'Alt'],
      // Window-wide, same as ⌥⌘M — see modelGestureShouldHandle.
      shouldHandle: modelGestureShouldHandle,
      canCycle: () => {
        const selector = getModelSelector();
        return !!selector && !!selector.currentConfigPair()
          && selector.supportedThinkingLevels().length > 0;
      },
      // Snapshot the target selector so every hook drives the same thread, enter
      // deferred-write mode, and open the mini thinking popover as the HUD.
      onGestureStart: () => {
        this._selector = getModelSelector();
        this._selector?.beginCycle();
        this._selector?.openThinkingMini();
      },
      onCycle: () => this._cycle(),
      onCommit: () => { this._selector?.closeThinkingMini(); this._commit(); },
      onCancel: () => { this._selector?.closeThinkingMini(); this._cancel(); },
    });
  }

  /**
   * Initialize the thinking cycler
   * Attaches keyboard event listeners
   */
  init() {
    this._controller.init();
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    this._controller.destroy();
  }

  /**
   * Apply the next thinking level in the cycle Default → supported levels in
   * advertised order → wrap, then refresh the chip/popover so the HUD tracks.
   * @private
   */
  _cycle() {
    const selector = this._selector;
    if (!selector) return;
    const levels = selector.supportedThinkingLevels();
    if (levels.length === 0) return;

    // '' = Default first, then the supported levels in advertised order.
    const order = ['', ...levels];
    const current = selector.currentConfigPair()?.thinking || '';
    const next = order[(order.indexOf(current) + 1) % order.length];
    if (selector.applyThinkingLevel(next)) {
      selector.refreshThinkingDisplay();
    }
  }

  /**
   * Commit the gesture's buffered landing level to the document.
   * @private
   */
  _commit() {
    this._selector?.commitCycle();
    this._selector = null;
  }

  /**
   * Abandon the gesture (Escape): drop the buffered level write so the doc
   * keeps its pre-gesture value.
   * @private
   */
  _cancel() {
    this._selector?.cancelCycle();
    this._selector = null;
  }
}

export { ModelCycler, ThinkingCycler };
