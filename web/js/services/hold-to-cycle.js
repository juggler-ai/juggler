//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import keyShortcutManager, { eventMatchesBinding } from './key-shortcut-manager.js';
import { markSeen } from './tips-manager.js';
import { isForeignPopupOpen } from '../utils/popup-manager.js';

/**
 * HoldToCycleController — the shared "Alt-Tab" gesture behind the strategy,
 * model, and thinking-level shortcuts. One two-phase machine drives them all:
 *
 *   idle → (trigger keydown: open the popup at the CURRENT value) → active
 *        → (trigger re-press while held: apply the next hop)
 *        → (modifier release: commit) | (Escape: cancel) → idle
 *
 * The popup is the surface the whole time: it opens on the very first press
 * showing the current selection highlighted, then each re-press previews the
 * next value — so there is no press-vs-hold distinction and no open delay. The
 * first press applies no hop, so a press-and-release with no re-press is a pure
 * peek. Nothing is persisted until the modifiers are released — every hop only
 * previews (the client buffers its doc write), and the landing value is
 * committed on release (or discarded on Escape).
 *
 * The trigger binding is looked up live from the KeyShortcutManager by
 * `shortcutId` (the definition is marked `external` there), so a future user
 * rebinding is honoured without touching this controller. Clients supply only
 * the actions; all key listening (capture phase, so the gesture wins over
 * component-level handlers) lives here.
 *
 * A trigger the page never sees as a keydown — Ctrl+Tab, which the desktop
 * app's native window claims and re-raises as an event — drives the same
 * machine through {@link HoldToCycleController#press}: leave `shortcutId` out
 * and no keydown starts or cycles a gesture. The modifier's own keydown and
 * keyup still reach the page, so release still commits. Because the press
 * travels by another route it can arrive after that release; the controller
 * keeps track of which modifiers are down, and a press with them already up is
 * a whole gesture at once — opened and committed in one task, so nothing paints.
 * @typedef {object} HoldToCycleConfig
 * @property {string} [shortcutId] - KeyShortcutManager definition id of the
 *   trigger. Omitted for a trigger that arrives through `press()` instead.
 * @property {string[]} modifierKeys - `KeyboardEvent.key` names of the binding's
 *   modifiers (e.g. `['Shift']` or `['Meta', 'Alt']`); releasing any of them
 *   commits the gesture. Callers must resolve the platform meaning of `mod`
 *   themselves ('Meta' on macOS, 'Control' elsewhere — see `isMac()`).
 * @property {(e: KeyboardEvent|null) => boolean} [shouldHandle] - Focus/context
 *   gate for starting a gesture; given null for a `press()`, which has no event.
 *   Defaults to the composer rule the strategy switcher always used: focus in a
 *   textarea inside `composer-box`, no modal dialog open.
 * @property {() => boolean} [canCycle] - Whole-gesture applicability. When it
 *   returns false the trigger press falls through untouched (no preventDefault),
 *   so an inapplicable shortcut is a transparent no-op. Defaults to always-on.
 * @property {(step: number, open: boolean) => void} onGestureStart - Called once
 *   per gesture, on the idle → active transition. The hook to snapshot frozen
 *   state (e.g. the recents list), enter the client's deferred-write mode, and
 *   open the popup HUD at the current selection — the popup is up for the whole
 *   gesture now, and no hop is applied until the first re-press. `step` is the
 *   opening press's direction: always 1 for a keydown trigger, as given for
 *   `press()`. `open` is false for a `press()` that found the modifiers already
 *   released, whose onCommit follows at once: a client may skip the popup.
 * @property {(step: number) => void} onCycle - Preview the next item (or, for
 *   a negative step, the previous one). Called on every trigger re-press while
 *   the gesture is active — NOT on the initial press, which only opens the
 *   popup at the current value. Buffers rather than persists — see onCommit.
 * @property {() => void} onCommit - Gesture ended by modifier release: close the
 *   popup and persist the landing selection (flush the buffered write, record to
 *   recents). Not called on Escape.
 * @property {() => void} [onCancel] - Gesture ended by Escape: close the popup
 *   and discard the preview, restoring what was committed before the gesture.
 *   Optional; never runs on a modifier-release commit.
 * @class
 */
class HoldToCycleController {
  /**
   * @param {HoldToCycleConfig} config
   */
  constructor(config) {
    /** @type {HoldToCycleConfig} @private */
    this._config = config;
    /** @type {'idle'|'active'} @private */
    this._phase = 'idle';
    /**
     * The configured modifiers currently down, as their keydown/keyup report
     * them. Only {@link press} reads it: a keydown trigger carries its own
     * modifier state.
     * @type {Set<string>} @private
     */
    this._held = new Set();

    // Bind handlers to preserve 'this' context
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleKeyUp = this._handleKeyUp.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
    this._handleBlur = this._handleBlur.bind(this);
  }

  /**
   * Attach the capture-phase keyboard listeners.
   */
  init() {
    document.addEventListener('keydown', this._handleKeyDown, { capture: true });
    document.addEventListener('keyup', this._handleKeyUp, { capture: true });
    window.addEventListener('blur', this._handleBlur);
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    document.removeEventListener('keydown', this._handleKeyDown, { capture: true });
    document.removeEventListener('keyup', this._handleKeyUp, { capture: true });
    window.removeEventListener('blur', this._handleBlur);
    this._endPointerIdle();
  }

  /**
   * A trigger press that arrived by some route other than a keydown here — the
   * desktop app's native Ctrl+Tab, re-raised as an event. Starts a gesture, or
   * cycles the one in progress. A press that finds the modifiers already
   * released (the keyup overtook it on the way) opens and commits at once.
   * @param {number} [step] - 1 to move forward, -1 to move back.
   * @returns {boolean} True when the press started or cycled a gesture; false
   *   when the gate or `canCycle` declined it.
   */
  press(step = 1) {
    if (this._phase === 'active') {
      this._config.onCycle(step);
      return true;
    }
    if (!this._shouldHandle(null)) return false;
    if (this._config.canCycle && !this._config.canCycle()) return false;

    const held = this._config.modifierKeys.every((key) => this._held.has(key));
    this._config.onGestureStart(step, held);
    if (!held) {
      this._config.onCommit();
      return true;
    }
    this._phase = 'active';
    this._beginPointerIdle();
    return true;
  }

  /**
   * End the active gesture now, as releasing the modifiers would — for a pick
   * made another way (a click on a row). The release that follows is inert. A
   * no-op between gestures.
   */
  commit() {
    if (this._phase !== 'active') return;
    this._phase = 'idle';
    this._endPointerIdle();
    this._config.onCommit();
  }

  /**
   * End the active gesture now without committing, as Escape would — for a HUD
   * closed from outside (another popup opening). A no-op between gestures.
   */
  cancel() {
    if (this._phase !== 'active') return;
    this._phase = 'idle';
    this._endPointerIdle();
    if (this._config.onCancel) this._config.onCancel();
  }

  /**
   * Handle keydown events
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyDown(e) {
    if (this._config.modifierKeys.includes(e.key)) this._held.add(e.key);

    // A press()-driven gesture: no keydown is its trigger, and Escape is the
    // only key it answers while active.
    const shortcutId = this._config.shortcutId;
    if (!shortcutId) {
      if (this._phase === 'active' && e.key === 'Escape') this._cancel(e);
      return;
    }

    const binding = keyShortcutManager.getBinding(shortcutId);
    if (!binding) return;

    // Phase: IDLE — waiting for the trigger combination.
    if (this._phase === 'idle') {
      if (!eventMatchesBinding(binding, e)) return;
      if (!this._shouldHandle(e)) return;
      // Inapplicable right now (no selector, nothing to cycle) — fall through
      // untouched so the keystroke keeps whatever native meaning it has.
      if (this._config.canCycle && !this._config.canCycle()) return;

      e.preventDefault();
      e.stopPropagation();

      // Open the popup and enter deferred-write mode — the popup is the surface
      // from the very first press, showing the CURRENT selection highlighted. No
      // hop is applied yet: the first onCycle fires on the next re-press, so a
      // press-and-release with no re-press is a pure peek that changes nothing.
      this._config.onGestureStart(1, true);

      // Learn-by-doing: engaging the gesture retires its onboarding tip. The tip
      // id equals the shortcut id for every cycler (cycle-model / cycle-thinking
      // / strategy-switch), and we're past the canCycle gate, so this only fires
      // on a real, applicable use. Idempotent; a no-op for ids with no tip.
      markSeen(shortcutId);

      this._phase = 'active';
      this._beginPointerIdle();
      return;
    }

    // Phase: ACTIVE — the trigger key cycles again; Escape cancels the whole
    // gesture without committing.
    if (e.key === 'Escape') {
      this._cancel(e);
      return;
    }
    // The modifiers are necessarily still held (their release ends the gesture
    // in keyup), so a re-press of the trigger key satisfies the full binding
    // again — matched the same way as the initial press so the macOS
    // Option-glyph fallback in eventMatchesBinding applies here too.
    if (eventMatchesBinding(binding, e)) {
      e.preventDefault();
      e.stopPropagation();
      this._config.onCycle(1);
    }
  }

  /**
   * End the active gesture on Escape, without committing.
   * @param {KeyboardEvent} e
   * @private
   */
  _cancel(e) {
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  }

  /**
   * Handle keyup events — releasing any configured modifier commits the gesture:
   * close the popup, then persist the landing selection.
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyUp(e) {
    if (!this._config.modifierKeys.includes(e.key)) return;
    this._held.delete(e.key);
    this.commit();
  }

  /**
   * The window lost focus, and with it every keyup that happens elsewhere: a
   * modifier released in another app is never reported here. Forget what was
   * held rather than believe it still is, so the next {@link press} does not
   * open a popup that waits for a release that already happened.
   * @private
   */
  _handleBlur() {
    this._held.clear();
  }

  /**
   * The popup just opened as a HUD under a held modifier — and the OS has hidden
   * the pointer because the user is "typing". Flag the pointer as idle so the
   * menu's hover/click styling is suppressed (see the `body.hud-pointer-idle`
   * CSS): an item happening to sit under the stationary invisible cursor must
   * not light up as if hovered. The flag is cleared on the first real pointer
   * motion, at which point normal hover resumes.
   * @private
   */
  _beginPointerIdle() {
    document.body.classList.add('hud-pointer-idle');
    document.addEventListener('pointermove', this._handlePointerMove, { capture: true });
  }

  /**
   * Clear the pointer-idle flag and stop listening for motion. Idempotent — the
   * class removal and listener removal are both no-ops when never armed, so it
   * is safe to call on every gesture-end path.
   * @private
   */
  _endPointerIdle() {
    document.body.classList.remove('hud-pointer-idle');
    document.removeEventListener('pointermove', this._handlePointerMove, { capture: true });
  }

  /**
   * First pointer motion after the HUD opened: the cursor is live again, so
   * restore normal hover/click on the menu.
   * @private
   */
  _handlePointerMove() {
    this._endPointerIdle();
  }

  /**
   * Check if a gesture may start on this event — the config's gate, defaulting
   * to {@link defaultShouldHandle}.
   * @param {KeyboardEvent|null} e - Null for a {@link press}.
   * @returns {boolean} True if the gesture should start
   * @private
   */
  _shouldHandle(e) {
    return (this._config.shouldHandle || defaultShouldHandle)(e);
  }
}

/**
 * The default gesture gate, extracted verbatim from the original
 * StrategySwitcher: only handle when focus is in the main composer textarea
 * (inside `composer-box`) and no modal dialog is open. A {@link
 * HoldToCycleController#press} has no event, so this gate never lets one through.
 * @param {KeyboardEvent|null} e
 * @returns {boolean} True if the gesture may start.
 */
export function defaultShouldHandle(e) {
  // Only handle when focus is in the main input textarea (inside composer-box)
  const target = e?.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  // Must be a textarea inside composer-box
  if (target.tagName !== 'TEXTAREA' || !target.closest('composer-box')) {
    return false;
  }

  // Don't handle if a modal dialog is open
  const modalOpen = document.querySelector('modal-dialog.show');
  if (modalOpen) {
    return false;
  }

  return true;
}

/**
 * The window-wide gesture gate, shared by every hold-to-cycle client that must
 * fire from ANYWHERE in the window rather than only the composer — the strategy,
 * model, and thinking cyclers all use it, so their focus behaviour stays
 * identical instead of diverging per client. Focus is intentionally ignored: the
 * client's own target resolver finds the selector to drive no matter where focus
 * sits (composer, a selected context item, a conversation column), so the gate's
 * only job is to keep the chord from leaking to a FOREIGN overlay that owns the
 * keyboard. It stands down while any modal or other component's popup/dropdown is
 * open, but never for the gesture's OWN HUD popups, whose ids are allow-listed
 * (holding to open the cycler's menu, or a re-press to keep cycling, must not be
 * gated out by the very popup the gesture just opened).
 * @param {string[]} [ownPopupIds] - Popup ids that are this gesture's own HUD and
 *   therefore do NOT count as foreign.
 * @returns {(e: KeyboardEvent|null) => boolean} A `shouldHandle` gate for the config.
 */
export function popupAwareShouldHandle(ownPopupIds = []) {
  return () => !isForeignPopupOpen(ownPopupIds);
}

export default HoldToCycleController;
