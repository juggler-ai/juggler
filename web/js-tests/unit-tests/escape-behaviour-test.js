//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Escape-key behaviour — the configurable stop/prompt rungs of the Escape ladder.
 *
 * Drives the real handler (`handleEscapeKey`) against a stubbed app (`provideEscapeApp`), so
 * the assertions are about the DECISION each preset makes — hard cancel, polite
 * pause, arm, clear, or nothing — and the vantage it forwards. The rung above
 * (popup dismissal) is the callers' job and is not exercised here.
 *
 * The load-bearing invariant, asserted for every stopping preset: a press that
 * acts on a running turn never touches the prompt. Text typed mid-run is
 * normally a correction being drafted BECAUSE the turn is going wrong, so a stop
 * gesture that eats the draft is destructive exactly where the user is most
 * engaged.
 *
 * Marked needsExclusiveRun for the same reason as the tool-grouping suite: the
 * preference is one localStorage key on an origin every lane shares, so writing
 * it while a sibling handles a key would change that sibling's answer.
 * @module unit-tests/escape-behaviour-test
 */

import { assert } from '../utilities/test-helpers.js';
import { cachedMachinePref, setMachinePref } from '../../js/services/prefs.js';
import { markPopupOpen, isAnyPopupOpen } from '../../js/utils/popup-manager.js';
import {
  ESCAPE_PRESETS,
  ESCAPE_BEHAVIOUR_EVENT,
  getEscapePreset,
  setEscapePreset,
  describeEscapePreset,
  handleEscapeKey,
  __isDoublePressArmedForTests,
  __resetEscapeGestureForTests,
  buildEscapeBehaviourRow,
  watchTurnsForEscape,
  ESCAPE_QUIET_MS,
  __setEscapeHostForTests,
  provideEscapeApp,
} from '../../js/services/escape-behaviour.js';
import { isMac, formatBindingLabel } from '../../js/services/key-shortcut-manager.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The machine preference the module stores the chosen preset under. Seeded through
 * the pref API rather than localStorage, which is only that realm's cache.
 */
const PREF_KEY = 'juggler-escape-behaviour';

/**
 * A recording stand-in for the app singleton the handler acts through, plus the
 * composer it clears. `running` and `pausePending` are set per test to stage the
 * conversation state each preset branches on.
 * @returns {any} The stub, with the calls it recorded.
 */
function stubApp() {
  const calls = { stop: [], pause: [], cleared: 0 };
  const stub = {
    running: false,
    pausePending: false,
    draft: true,
    calls,
    shouldHandleEscape() { return stub.running; },
    getVisibleConversation() {
      return { politeStopState: () => (stub.pausePending ? 'pending' : 'none') };
    },
    /**
     * @param {string|null} threadId - Vantage the stop came from.
     * @param {{polite?: boolean}} [opts] - Stop options.
     */
    cancelLLMOperation(threadId, opts = {}) {
      if (opts.polite) calls.pause.push(threadId);
      else calls.stop.push(threadId);
    },
    composer: {
      clearTextUndoable() {
        if (!stub.draft) return false;
        calls.cleared++;
        stub.draft = false;
        return true;
      },
    },
  };
  return stub;
}

/**
 * A stand-in for the native window: a clock the test moves by hand, whether the
 * window is fullscreen, and a count of the times the page asked to leave it.
 * @returns {{t: number, fullscreen: boolean, left: number, now: () => number,
 *   isFullscreen: () => boolean, leaveFullscreen: () => void}} The host.
 */
function stubHost() {
  const host = {
    t: 10_000,
    fullscreen: false,
    left: 0,
    now: () => host.t,
    isFullscreen: () => host.fullscreen,
    leaveFullscreen: () => { host.left++; host.fullscreen = false; },
  };
  return host;
}

/**
 * Press Escape through the real handler.
 * @param {any} stub - The app stub whose composer/vantage to use.
 * @param {{shift?: boolean, repeat?: boolean, threadId?: string|null,
 *   canLeaveFullscreen?: boolean}} [opts] - Press options.
 * @returns {boolean} Whether the handler acted.
 */
function press(stub, { shift = false, repeat = false, threadId = null, canLeaveFullscreen = true } = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', shiftKey: shift, repeat });
  return handleEscapeKey(event, {
    focusedThreadId: threadId,
    getComposer: () => stub.composer,
    canLeaveFullscreen,
  });
}

/** @returns {Element|null} The armed-gesture cue, if one is showing. */
function cue() {
  return document.querySelector('.escape-arm-cue');
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // The suite stands in for the app and writes a shared pref; restore both whatever happens.
  const restoreApp = provideEscapeApp(null);
  const priorPref = cachedMachinePref(PREF_KEY, null);

  /** @type {any} */
  let app;
  /** @type {ReturnType<typeof stubHost>} */
  let host = stubHost();

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    app = stubApp();
    provideEscapeApp(app);
    host = stubHost();
    __setEscapeHostForTests(host);
    __resetEscapeGestureForTests();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      __resetEscapeGestureForTests();
    }
  };

  try {
    // ── The preference itself ──────────────────────────────────────────
    await run('defaults to the shipped stop-immediately preset', () => {
      void setMachinePref(PREF_KEY, null);
      assert(getEscapePreset().id === 'stop', 'missing pref must default to "stop"');
      // A retired or hand-edited id must not strand the key in a fallback loop.
      void setMachinePref(PREF_KEY, 'not-a-preset');
      assert(getEscapePreset().id === 'stop', 'unknown stored id must fall back to "stop"');
      setEscapePreset('not-a-preset');
      assert(getEscapePreset().id === 'stop', 'an unknown id must never be stored');
    });

    await run('every preset describes both Escape chords for this platform', () => {
      for (const preset of ESCAPE_PRESETS) {
        const text = describeEscapePreset(preset);
        assert(!text.includes('{esc}') && !text.includes('{shiftEsc}'),
          `${preset.id}: key placeholders must be substituted`);
        assert(text.length > 40, `${preset.id}: description should explain both chords`);
      }
    });

    await run('setting a preset notifies listeners', () => {
      setEscapePreset('stop');
      let fired = 0;
      const onChange = () => { fired++; };
      window.addEventListener(ESCAPE_BEHAVIOUR_EVENT, onChange);
      try {
        setEscapePreset('pause');
        assert(fired === 1, `expected one change event, got ${fired}`);
        assert(getEscapePreset().id === 'pause', 'the new preset should be active');
      } finally {
        window.removeEventListener(ESCAPE_BEHAVIOUR_EVENT, onChange);
      }
    });

    // ── stop (the default) ─────────────────────────────────────────────
    await run('stop: Escape hard-cancels from its vantage, Shift+Escape pauses', () => {
      setEscapePreset('stop');
      app.running = true;
      press(app, { threadId: 'thr_1' });
      assert(app.calls.stop.length === 1 && app.calls.stop[0] === 'thr_1',
        'plain Escape should hard-cancel from the pressing column\u2019s vantage');
      assert(app.calls.cleared === 0, 'a stopping press must not touch the prompt');
      press(app, { shift: true, threadId: null });
      assert(app.calls.pause.length === 1, 'Shift+Escape should request a polite pause');
    });

    await run('idle: Escape clears the prompt as an undoable edit', () => {
      setEscapePreset('stop');
      app.running = false;
      press(app);
      assert(app.calls.cleared === 1, 'an idle press should clear the composer');
      assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
        'an idle press must not cancel anything');
    });

    // ── pause ──────────────────────────────────────────────────────────
    await run('pause: the two chords trade places', () => {
      setEscapePreset('pause');
      app.running = true;
      press(app);
      assert(app.calls.pause.length === 1 && app.calls.stop.length === 0,
        'plain Escape should pause');
      press(app, { shift: true });
      assert(app.calls.stop.length === 1, 'Shift+Escape should hard-cancel');
      assert(app.calls.cleared === 0, 'neither chord may touch the prompt');
    });

    // ── two-step ───────────────────────────────────────────────────────
    await run('two-step: pauses first, then escalates while the pause is pending', () => {
      setEscapePreset('two-step');
      app.running = true;
      press(app);
      assert(app.calls.pause.length === 1 && app.calls.stop.length === 0,
        'the first press should pause');
      // The pending Pause IS the armed state — it is what the second press reads.
      app.pausePending = true;
      press(app);
      assert(app.calls.stop.length === 1, 'a second press should escalate to a hard cancel');
      assert(app.calls.cleared === 0, 'neither press may touch the prompt');
    });

    await run('two-step: Shift+Escape is the one-press escape hatch', () => {
      setEscapePreset('two-step');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.stop.length === 1 && app.calls.pause.length === 0,
        'Shift+Escape should hard-cancel on the first press');
    });

    // ── double-press ───────────────────────────────────────────────────
    await run('double-press: the first press arms and does nothing else', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
        'the first press must not stop anything');
      // The ambiguity this preset has to answer: a lone press does NOT fall
      // through to the idle behaviour, so a draft typed mid-run survives it.
      assert(app.calls.cleared === 0, 'the first press must not clear the prompt');
      assert(__isDoublePressArmedForTests(), 'the first press should arm the gesture');
      assert(cue(), 'an armed gesture should show its "press again" cue');
    });

    await run('double-press: the second press stops and disarms', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      press(app, { threadId: 'thr_2' });
      assert(app.calls.stop.length === 1 && app.calls.stop[0] === 'thr_2',
        'the second press should hard-cancel from its own vantage');
      assert(!__isDoublePressArmedForTests(), 'stopping should disarm the gesture');
      assert(!cue(), 'the cue should go with the gesture');
      assert(app.calls.cleared === 0, 'stopping must not touch the prompt');
    });

    await run('double-press: any other input disarms', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      assert(!__isDoublePressArmedForTests(), 'typing should disarm the gesture');
      assert(!cue(), 'the cue should be removed on disarm');
      press(app);
      assert(app.calls.stop.length === 0, 'a re-armed first press must not stop');
      assert(__isDoublePressArmedForTests(), 'the press after a disarm re-arms');
      document.dispatchEvent(new Event('pointerdown'));
      assert(!__isDoublePressArmedForTests(), 'a pointer press should disarm the gesture');
    });

    await run('double-press: a press racing the turn\u2019s end is swallowed, not a clear', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(__isDoublePressArmedForTests(), 'armed against the running turn');
      // The turn ends between the two presses: the second must NOT fall through
      // to the idle rung and wipe the draft — the very failure the preset exists
      // to prevent, arriving by the back door.
      app.running = false;
      const acted = press(app);
      assert(acted, 'the stale second press should be swallowed as handled');
      assert(app.calls.cleared === 0, 'a swallowed press must not clear the prompt');
      assert(!__isDoublePressArmedForTests(), 'the stale gesture should be dropped');
    });

    await run('switching preset mid-gesture drops the armed state', () => {
      setEscapePreset('double-press');
      app.running = true;
      press(app);
      assert(__isDoublePressArmedForTests(), 'armed before the switch');
      setEscapePreset('stop');
      assert(!__isDoublePressArmedForTests(), 'a preset switch must not strand an armed gesture');
      assert(!cue(), 'the cue should go with it');
    });

    // ── clear-only / inert ─────────────────────────────────────────────
    await run('clear-only: never stops, clears whether running or idle', () => {
      setEscapePreset('clear-only');
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 0, 'this preset must never hard-cancel on the plain key');
      // Stopping isn't bound to the key at all here, so clearing mid-run is
      // unambiguous rather than destructive.
      assert(app.calls.cleared === 1, 'a running press should clear the prompt');
      app.running = false;
      app.draft = true;
      press(app);
      assert(app.calls.cleared === 2, 'an idle press should clear the prompt');
      press(app, { shift: true });
      assert(app.calls.pause.length === 0, 'idle Shift+Escape has nothing to pause');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.pause.length === 1, 'Shift+Escape keeps a route to a clean stop');
    });

    await run('inert: leaves the turn and the prompt alone', () => {
      setEscapePreset('inert');
      app.running = true;
      press(app);
      app.running = false;
      press(app);
      assert(app.calls.stop.length === 0 && app.calls.cleared === 0,
        'this preset should do nothing on either rung');
      app.running = true;
      press(app, { shift: true });
      assert(app.calls.pause.length === 1, 'Shift+Escape still pauses');
    });

    // ── guard rails shared by every preset ─────────────────────────────
    await run('auto-repeat never fires the gesture', () => {
      for (const id of ['stop', 'two-step', 'double-press']) {
        setEscapePreset(id);
        app = stubApp();
        provideEscapeApp(app);
        app.running = true;
        press(app, { repeat: true });
        assert(app.calls.stop.length === 0 && app.calls.pause.length === 0,
          `${id}: a held Escape must not stop the turn`);
        assert(!__isDoublePressArmedForTests(), `${id}: a held Escape must not arm anything`);
      }
    });

    // ── leaving fullscreen: the rung below the ladder ──────────────────
    await run('fullscreen: a press with nothing to do leaves fullscreen', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      app.draft = false;
      const acted = press(app);
      assert(host.left === 1, 'an idle press on an empty prompt should leave fullscreen');
      assert(acted, 'leaving fullscreen is the press being acted on');
    });

    await run('fullscreen: a press that does anything else stays in fullscreen', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      press(app);
      assert(app.calls.cleared === 1 && host.left === 0,
        'clearing the draft is the whole press — it must not also leave fullscreen');
      host.t += ESCAPE_QUIET_MS + 1;
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 1 && host.left === 0,
        'stopping the turn is the whole press — it must not also leave fullscreen');
    });

    await run('fullscreen: only a plain, fresh press, and only where the caller allows', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      app.draft = false;
      press(app, { shift: true });
      host.t += ESCAPE_QUIET_MS + 1;
      press(app, { repeat: true });
      host.t += ESCAPE_QUIET_MS + 1;
      press(app, { canLeaveFullscreen: false });
      assert(host.left === 0, 'Shift+Escape, a held key and a declining caller must all stay put');
    });

    await run('fullscreen: mashing Escape never falls out of fullscreen', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      app.draft = false;
      // The first press went to something above the ladder (a menu it closed);
      // that press never reaches handleEscapeKey, but it is still a press.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      host.t += ESCAPE_QUIET_MS - 1;
      press(app);
      assert(host.left === 0, 'a press hard on the heels of another must not leave fullscreen');
      // Each press restarts the window, so a run of them stays put throughout.
      host.t += ESCAPE_QUIET_MS - 1;
      press(app);
      assert(host.left === 0, 'the run of presses keeps extending the window');
      host.t += ESCAPE_QUIET_MS + 1;
      press(app);
      assert(host.left === 1, 'a press after a pause is a fresh one again');
    });

    await run('fullscreen: a press that closes a menu or dialog stays in fullscreen, and so does the next', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      app.draft = false;
      let closed = 0;
      /** @type {() => void} */
      const release = markPopupOpen(() => { closed++; release(); });
      try {
        // The real dismissal path: popup-manager's document listener takes the
        // press and stops it, so handleEscapeKey never sees it.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert(closed === 1 && !isAnyPopupOpen(), 'Escape should close the popup');
        assert(host.left === 0, 'closing a popup is the whole press — it must not leave fullscreen');
        // A second press straight after, now with nothing open, is the user
        // still backing out of the popup.
        host.t += ESCAPE_QUIET_MS - 1;
        press(app);
        assert(host.left === 0, 'the press hard on the heels of a dismissal must not leave fullscreen');
        host.t += ESCAPE_QUIET_MS + 1;
        press(app);
        assert(host.left === 1, 'a deliberate press once things are quiet leaves fullscreen');
      } finally {
        release();
      }
    });

    await run('settle: the presses after a stop neither clear the draft nor leave fullscreen', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      app.running = true;
      press(app);
      assert(app.calls.stop.length === 1, 'the first press stops the turn');
      // The stop lands; the user is still hammering the key.
      app.running = false;
      host.t += ESCAPE_QUIET_MS - 1;
      press(app);
      assert(app.calls.cleared === 0, 'a press settling after a stop must not eat the draft');
      assert(host.left === 0, 'a press settling after a stop must not leave fullscreen');
      host.t += ESCAPE_QUIET_MS + 1;
      press(app);
      assert(app.calls.cleared === 1, 'once settled, Escape clears the draft as usual');
    });

    await run('settle: a turn ending on its own starts the same quiet period', () => {
      setEscapePreset('stop');
      host.fullscreen = true;
      /** @type {(id: string) => void} */
      let tick = () => {};
      const unwatch = watchTurnsForEscape({
        onLLMStatusChange: (/** @type {(id: string) => void} */ fn) => { tick = fn; return () => {}; },
      });
      try {
        app.running = true;
        tick('conv_1');
        // The turn finishes a moment before the press meant to stop it.
        app.running = false;
        tick('conv_1');
        host.t += ESCAPE_QUIET_MS - 1;
        press(app);
        assert(app.calls.cleared === 0, 'a press racing the turn\u2019s end must not eat the draft');
        assert(host.left === 0, 'a press racing the turn\u2019s end must not leave fullscreen');
      } finally {
        unwatch();
      }
    });

    // ── the settings control ───────────────────────────────────────────
    await run('the settings row reflects and writes the preference', () => {
      setEscapePreset('stop');
      const row = buildEscapeBehaviourRow();
      const select = /** @type {HTMLSelectElement} */ (row.querySelector('select'));
      const desc = /** @type {HTMLElement} */ (row.querySelector('.provider-description'));
      assert(select && select.options.length === ESCAPE_PRESETS.length,
        'every preset should be offered');
      assert(select.value === 'stop', 'the picker should open on the stored preset');
      select.value = 'two-step';
      select.dispatchEvent(new Event('change'));
      assert(getEscapePreset().id === 'two-step', 'choosing a preset should store it');
      assert(desc.textContent === describeEscapePreset(getEscapePreset()),
        'the description should follow the choice');
    });

    await run('a settings row that has been replaced stops listening for the preference', () => {
      const realAdd = window.addEventListener;
      const realRemove = window.removeEventListener;
      /** @type {Set<any>} */
      const live = new Set();
      window.addEventListener = /** @type {any} */ (function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) {
        if (type === ESCAPE_BEHAVIOUR_EVENT) live.add(fn);
        return realAdd.call(window, type, fn, opts);
      });
      window.removeEventListener = /** @type {any} */ (function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) {
        if (type === ESCAPE_BEHAVIOUR_EVENT) live.delete(fn);
        return realRemove.call(window, type, fn, opts);
      });
      /** @type {HTMLElement|null} */
      let kept = null;
      try {
        setEscapePreset('stop');
        for (let i = 0; i < 3; i++) {
          const gone = buildEscapeBehaviourRow();
          document.body.appendChild(gone);
          gone.remove();
        }
        kept = buildEscapeBehaviourRow();
        document.body.appendChild(kept);
        window.dispatchEvent(new Event(ESCAPE_BEHAVIOUR_EVENT));
        assert(live.size === 1, `${live.size} rows still listen after three were replaced (want 1)`);
        setEscapePreset('two-step');
        window.dispatchEvent(new Event(ESCAPE_BEHAVIOUR_EVENT));
        const select = /** @type {HTMLSelectElement} */ (kept.querySelector('select'));
        assert(select.value === 'two-step', 'the row on screen stopped following the preference');
      } finally {
        kept?.remove();
        window.dispatchEvent(new Event(ESCAPE_BEHAVIOUR_EVENT));
        window.addEventListener = realAdd;
        window.removeEventListener = realRemove;
      }
    });

    await run('en-XA: the settings row, every preset description and the armed cue are translated', async () => {
      await underPseudoLocale('escape-behaviour-test', async () => {
        const mac = isMac();
        // Key caps are data drawn by their own formatter: map them to a digit so
        // only the sentences around them are judged. Shift+Escape first, as it
        // contains the plain cap.
        const caps = [
          formatBindingLabel({ shift: true, key: 'Escape' }, mac),
          formatBindingLabel({ key: 'Escape' }, mac),
        ];
        /**
         * @param {string} s - A shown string.
         * @returns {string} It with every key cap replaced by a digit.
         */
        const uncapped = (s) => caps.reduce((acc, cap) => acc.replaceAll(cap, '1'), s);
        /** @type {string[]} */
        const shown = [];

        setEscapePreset('stop');
        const row = buildEscapeBehaviourRow();
        const select = /** @type {HTMLSelectElement} */ (row.querySelector('select'));
        const desc = /** @type {HTMLElement} */ (row.querySelector('.provider-description'));
        shown.push(...shownStrings(row));
        for (const preset of ESCAPE_PRESETS) {
          select.value = preset.id;
          select.dispatchEvent(new Event('change'));
          shown.push(desc.textContent || '');
        }

        setEscapePreset('double-press');
        app.running = true;
        press(app);
        const armed = cue();
        assert(armed, 'the double-press preset should show its cue');
        shown.push(armed?.textContent || '');
        __resetEscapeGestureForTests();

        assert(shown.length >= ESCAPE_PRESETS.length * 2 + 3, `expected the whole row, found ${shown.length}`);
        const raw = shown.map(uncapped).filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    });
  } finally {
    __resetEscapeGestureForTests();
    __setEscapeHostForTests(null);
    void setMachinePref(PREF_KEY, priorPref);
    restoreApp();
  }

  return { passed, failed, errors };
}
