//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import HoldToCycleController, { popupAwareShouldHandle } from './hold-to-cycle.js';

/**
 * Popup id the strategy switcher OWNS — the strategy dropdown, the surface it
 * opens as its cycling HUD (registered under this id in strategy-selector.js).
 * Allow-listed in the gesture gate so the window-wide capture never stands the
 * gesture down for its own HUD.
 * @type {string[]}
 */
const OWN_POPUP_IDS = ['strategy-selector'];

/**
 * StrategySwitcher - Handles the strategy-switch keyboard shortcut (Shift+Tab by
 * default). Alt-tab UX: the first press opens the dropdown HUD highlighting the
 * CURRENT strategy (no hop); each further Tab (Shift still held) cycles to the
 * next; releasing Shift commits the highlighted strategy — or, with no Tab
 * pressed again, leaves the dropdown open as an ordinary menu.
 *
 * A thin client of the shared {@link HoldToCycleController}, which owns the
 * gesture mechanics (phase machine, capture-phase key listeners) and sources the
 * trigger binding from the KeyShortcutManager (id `strategy-switch`, marked
 * `external` there). This class supplies only the strategy-selector actions:
 * hops preview through a deferred write and the landing strategy is persisted
 * once on Shift release (see StrategySelector's CycleBuffer).
 * @class
 */
class StrategySwitcher {
  constructor() {
    /**
     * The selector this gesture is driving, snapshotted at gesture start from
     * the focused composer's column and held for the gesture's lifetime (null
     * between gestures). Caching it — rather than re-resolving on every hop —
     * pins one gesture to one thread even if focus drifts when the menu HUD
     * opens or a running turn rebuilds columns underneath us.
     * @type {import('../components/strategy-selector.js').StrategySelector|null} @private
     */
    this._activeSelector = null;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'strategy-switch',
      modifierKeys: ['Shift'],
      // Window-wide, same gate as the model/thinking cyclers: Shift+Tab must
      // cycle the strategy no matter where focus sits — the composer, a selected
      // context item, or a conversation column — standing down only for a
      // foreign overlay. Confining it to the composer textarea silently killed
      // the shortcut whenever focus was on a selected context item.
      shouldHandle: popupAwareShouldHandle(OWN_POPUP_IDS),
      // Resolve live here (no gesture is in flight yet) so the applicability
      // check reflects the column the user is actually focused in.
      canCycle: () => this._resolveActiveSelector() !== null,
      // Buffer the strategy write for the whole gesture: hops update the menu
      // HUD's highlight, but a running turn never sees an intermediate strategy
      // (the doc is written once, on commit). Snapshot the target selector here
      // so every subsequent hook drives the SAME thread's selector, enter its
      // deferred-write mode, and open the dropdown HUD — it's the surface from
      // the first press.
      onGestureStart: () => {
        this._activeSelector = this._resolveActiveSelector();
        this._activeSelector?.beginCycle();
        this._activeSelector?.open();
      },
      onCycle: () => { this._activeSelector?.cycleNext(); },
      onCommit: () => {
        this._activeSelector?.close();
        this._activeSelector?.commitCycle();
        this._activeSelector = null;
      },
      // Shift let go with no hop: the dropdown stays up as an ordinary menu on
      // the current strategy, for ↑↓ and ↵.
      onSettle: () => {
        const selector = this._activeSelector;
        this._activeSelector = null;
        selector?.commitCycle();
        selector?.takeKeyboard();
      },
      onCancel: () => {
        this._activeSelector?.close();
        this._activeSelector?.cancelCycle();
        this._activeSelector = null;
      },
    });
  }

  /**
   * Initialize the strategy switcher
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
   * Resolve the strategy selector this gesture should drive, preferring the
   * column the user is actually focused in. When focus IS in a composer textarea,
   * its enclosing `composer-box` identifies the intended thread — the root OR any
   * open sub-thread column, each of which has its own selector bound to its own
   * thread. The gesture fires window-wide, though, so focus may be outside any
   * composer (a selected context item, a conversation column); falling back to
   * the active tab's first selector (its root column's) covers that case.
   *
   * This replaces a plain `activeTab.querySelector('strategy-selector')`, which
   * returned the FIRST selector in DOM order — always the root column's — so
   * Shift+Tab silently drove the root conversation's strategy even when the
   * cursor sat in a sub-thread composer.
   *
   * Every lookup skips hidden selectors. A delegated sub-agent's column hides
   * its own (its strategy belongs to the tool that called it), and driving an
   * invisible control is worse than standing the gesture down: `canCycle` reads
   * this, so an unresolvable column simply declines the shortcut.
   * @returns {import('../components/strategy-selector.js').StrategySelector|null} The selector or null
   * @private
   */
  _resolveActiveSelector() {
    // Prefer the focused composer's own column.
    const focused = /** @type {HTMLElement|null} */ (document.activeElement);
    const box = focused && typeof focused.closest === 'function'
      ? focused.closest('composer-box')
      : null;
    if (box) {
      // A hidden selector here is an answer, not a miss: the user is typing in a
      // column whose strategy is not theirs to change, so the gesture stands
      // down rather than falling through and driving the ROOT column's.
      const owned = box.querySelector('strategy-selector');
      if (owned) {
        return /** @type {HTMLElement} */ (owned).hidden
          ? null
          : /** @type {import('../components/strategy-selector.js').StrategySelector} */ (owned);
      }
    }

    // Fallback: the active conversation tab's (root column's) selector.
    const activeTab = document.querySelector('conversation-tab.active');
    if (activeTab) {
      const selector = activeTab.querySelector('strategy-selector:not([hidden])');
      if (selector) {
        return /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector);
      }
    }

    // Last resort: any visible strategy selector.
    const selector = document.querySelector('strategy-selector:not([hidden])');
    return selector ? /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector) : null;
  }
}

export default StrategySwitcher;
