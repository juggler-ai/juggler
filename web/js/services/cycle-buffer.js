//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * CycleBuffer — the shared display-defence lifecycle behind every hold-to-cycle
 * selector (strategy, model, thinking). It does NOT touch the doc; it only
 * governs when the doc is allowed to drive the collapsed button, so the two
 * guards every selector needs live in one place rather than drifting apart
 * across hand-rolled copies:
 *
 *   1. **A frozen button during the gesture.** While the user holds the
 *      modifiers and cycles, the target is shown in the HUD (dropdown / popover)
 *      only — the collapsed button stays at the pre-gesture value. Nothing is
 *      written to the doc until release, so a running turn never sees an
 *      intermediate selection. While `buffering` is true the selector shows its
 *      committed snapshot on the button, and this buffer rejects every synced
 *      value so a mid-gesture rebuild can't move it.
 *
 *   2. **A short pin after commit.** On release the landing value X is written
 *      to the doc once and the button is repainted to X *directly*. But for a
 *      brief window afterwards the display can be shoved back to the PRE-gesture
 *      value by two things: a running turn's `yjs-sync` frames momentarily
 *      resolving `currentStrategyId`/`modelConfig` back before converging on X,
 *      and a rebuild that was constructed just before our write (so it still
 *      reads the old value) landing right after commit. Nothing ever writes the
 *      old value back — the doc always CONVERGES to X (see conversation-observers)
 *      — so this is purely a display concern: pin X and, for the pin's lifetime,
 *      accept ONLY a synced value equal to X (a harmless echo) while rejecting
 *      everything else as a stale bounce. The pin releases on a short timer, by
 *      which point the doc has settled on X, so a normal doc read then shows the
 *      right value with zero flicker. A genuine external change during the window
 *      is briefly masked and picked up when the pin releases (`onRelease`).
 *
 * The buffer is generic over the value type (a strategy-id string, a model
 * config object) via an `isEqual` comparator the caller supplies.
 * @module services/cycle-buffer
 */

/**
 * How long (ms) a post-commit pin defends the committed value against stale
 * post-commit rebuilds and the mid-turn sync bounce. It comfortably exceeds the
 * observed convergence window (~0.5-1s); once the doc has settled on the pinned
 * value, releasing is a no-op, and a genuine concurrent change is only masked
 * for this long before `onRelease` re-syncs.
 * @type {number}
 */
const PIN_BACKSTOP_MS = 2000;

/**
 * @template T
 * @typedef {object} CycleBufferConfig
 * @property {(a: T, b: T) => boolean} [isEqual] - Value equality; defaults to `===`.
 * @property {() => void} [onRelease] - Invoked when the wall-clock backstop
 *   force-releases a pin (never on the idle-driven release, which the caller's
 *   own sync path already observes). The hook to re-read the doc so a genuine
 *   external change the pin was masking is picked up.
 */

/**
 * @template T
 */
export default class CycleBuffer {
  /**
   * @param {CycleBufferConfig<T>} [config]
   */
  constructor({ isEqual, onRelease } = {}) {
    /** @type {(a: T, b: T) => boolean} @private */
    this._isEqual = isEqual || ((a, b) => a === b);
    /** @type {(() => void)|null} @private */
    this._onRelease = onRelease || null;
    /** @type {boolean} @private - A cycle gesture is in progress (button frozen, sync blocked). */
    this._active = false;
    /** @type {boolean} @private - A committed value is pinned against transient sync bounces. */
    this._pinned = false;
    /** @type {T|undefined} @private - The pinned value. */
    this._pinnedValue = undefined;
    /** @type {ReturnType<typeof setTimeout>|null} @private */
    this._timer = null;
  }

  /**
   * True while a gesture is in progress. The selector shows its committed
   * snapshot on the button (not the previewed hop) and skips doc writes while
   * this is set.
   * @returns {boolean} Whether a cycle gesture is currently in progress.
   */
  get buffering() {
    return this._active;
  }

  /**
   * Begin a gesture: freeze the button and block doc-sync, dropping any pin left
   * by a prior commit (a fresh gesture supersedes it). Idempotent — a second
   * begin while already active is a no-op, so two cyclers sharing one selector
   * can't disturb the in-flight gesture.
   */
  begin() {
    if (this._active) return;
    this._clearPin();
    this._active = true;
  }

  /**
   * End a gesture with nothing to defend (Escape, or a commit whose landing
   * value equals the pre-gesture value). Leaves no pin — the doc is immediately
   * authoritative again.
   */
  end() {
    this._active = false;
  }

  /**
   * End a gesture by committing a changed value: pin it against the post-commit
   * sync bounce until the running turn settles. The caller has already written
   * `value` to the doc and repainted the button to it.
   * @param {T} value - The committed value to defend.
   */
  pin(value) {
    this._active = false;
    this._pin(value);
  }

  /**
   * Gate an inbound synced value against the current gesture/pin state — the
   * single decision every selector's sync path defers to.
   *
   * - While a gesture is active, reject everything: the button is frozen at its
   *   committed snapshot and the HUD owns the preview.
   * - With no pin, accept: the doc is authoritative.
   * - With a pin, accept ONLY a value equal to the pinned one (a harmless echo)
   *   and reject everything else — the mid-turn bounce AND a stale rebuild
   *   constructed before our own commit write both surface here as a
   *   not-equal-to-pinned value, and must not be allowed to shove the button off
   *   the committed choice. The pin is NOT released on a match (the value can
   *   oscillate before settling); only its timer or a fresh gesture releases it.
   * @param {T} incoming - The value the doc would apply to the display.
   * @returns {boolean} True when `incoming` should be applied to the display.
   */
  accepts(incoming) {
    if (this._active) return false;
    if (!this._pinned) return true;
    return this._isEqual(incoming, /** @type {T} */(this._pinnedValue));
  }

  /**
   * Drop all gesture and pin state. Called when a fresh user intent supersedes
   * the last commit (an explicit pick) and on teardown.
   */
  reset() {
    this._active = false;
    this._clearPin();
  }

  /**
   * @param {T} value
   * @private
   */
  _pin(value) {
    this._clearPin();
    this._pinned = true;
    this._pinnedValue = value;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._pinned) return;
      this._pinned = false;
      this._pinnedValue = undefined;
      if (this._onRelease) this._onRelease();
    }, PIN_BACKSTOP_MS);
  }

  /** @private */
  _clearPin() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pinned = false;
    this._pinnedValue = undefined;
  }
}
