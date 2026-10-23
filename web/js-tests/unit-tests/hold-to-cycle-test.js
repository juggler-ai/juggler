//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * HoldToCycleController phase-machine unit tests.
 *
 * Drives the shared hold-to-cycle gesture (idle → active) with synthetic
 * KeyboardEvents dispatched on document — the controller's own capture-phase
 * listeners receive them — and records every config callback in an ordered log.
 * The trigger is the real `strategy-switch` binding (Shift+Tab, modifier-less so
 * the same synthetic events match on every platform) with `shouldHandle: () =>
 * true` to bypass the composer-focus gate, which is asserted separately via the
 * exported {@link defaultShouldHandle}.
 *
 * The gesture is now single-phase-open: the first press opens the popup at the
 * current value (no hop, no long-press timer to trap), each re-press previews
 * the next value, releasing the modifier commits, and Escape cancels. app.js is
 * not loaded in the harness page, so no production controller instance is
 * listening — every reaction to these events is the instance under test.
 * @module unit-tests/hold-to-cycle-test
 */

import { assert } from '../utilities/test-helpers.js';
import HoldToCycleController, { defaultShouldHandle } from '../../js/services/hold-to-cycle.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Create a controller wired so every config callback appends its name to a
 * shared ordered log, and attach its document listeners. Uses the
 * `strategy-switch` shortcut (Shift+Tab) as the trigger with
 * `modifierKeys: ['Shift']` — callers must destroy() the controller.
 * @param {object} [overrides] - HoldToCycleConfig overrides (e.g. canCycle).
 * @returns {{controller: HoldToCycleController, calls: string[]}} The live
 *   controller and its ordered callback log.
 */
function makeHarness(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  const controller = new HoldToCycleController({
    shortcutId: 'strategy-switch',
    modifierKeys: ['Shift'],
    shouldHandle: () => true,
    onGestureStart: () => calls.push('start'),
    onCycle: () => calls.push('cycle'),
    onCommit: () => calls.push('commit'),
    onCancel: () => calls.push('cancel'),
    ...overrides,
  });
  controller.init();
  return { controller, calls };
}

/**
 * Dispatch the trigger keydown (Shift+Tab) on document.
 * @returns {boolean} True when the controller consumed it (preventDefault).
 */
function pressTrigger() {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  return !document.dispatchEvent(e);
}

/**
 * Dispatch an Escape keydown on document (Shift still held, as mid-gesture).
 * @returns {void}
 */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }));
}

/**
 * Dispatch a keyup for the given key on document.
 * @param {string} key - `KeyboardEvent.key` value, e.g. 'Shift'.
 * @returns {void}
 */
function releaseKey(key) {
  document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
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

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('the first trigger keydown opens the gesture at the current value without cycling', () => {
    const { controller, calls } = makeHarness();
    try {
      const prevented = pressTrigger();
      assert(prevented, 'the starting keydown must be preventDefault-ed');
      assert(calls.join(',') === 'start',
        `the first press must open only, applying no hop — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('each re-press cycles once without restarting the gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      assert(pressTrigger(), 're-press must be consumed too');
      assert(pressTrigger(), 'third press must be consumed too');
      assert(calls.join(',') === 'start,cycle,cycle',
        `start opens; each re-press adds one cycle — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('release from an active gesture commits the landing selection', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      assert(pressTrigger(), 'trigger must cycle while active');
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,commit',
        `modifier release must commit — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('the first press flags the pointer idle; pointer motion clears it', () => {
    const { controller } = makeHarness();
    try {
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'the pointer must not be flagged idle before the gesture starts');
      pressTrigger();
      assert(document.body.classList.contains('hud-pointer-idle'),
        'opening the HUD must flag the pointer idle so its hover is suppressed');
      document.dispatchEvent(new Event('pointermove', { bubbles: true }));
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'the first real pointer motion must clear the idle flag');
    } finally {
      controller.destroy();
    }
  });

  await run('committing on modifier release clears the pointer-idle flag', () => {
    const { controller } = makeHarness();
    try {
      pressTrigger();
      assert(document.body.classList.contains('hud-pointer-idle'), 'sanity: gesture start flags idle');
      releaseKey('Shift');
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'ending the gesture must clear the idle flag');
    } finally {
      controller.destroy();
    }
  });

  await run('Escape clears the pointer-idle flag along with cancelling', () => {
    const { controller } = makeHarness();
    try {
      pressTrigger();
      pressEscape();
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'Escape must clear the idle flag along with cancelling the gesture');
    } finally {
      controller.destroy();
    }
  });

  await run('a press then immediate release is a commit-only peek', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      releaseKey('Shift');
      assert(calls.join(',') === 'start,commit',
        `a press then release with no re-press applies no hop — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('Escape cancels without committing; a later modifier release is inert', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      pressEscape();
      assert(calls.join(',') === 'start,cancel',
        `Escape must cancel without committing — got ${calls.join(',')}`);
      // The gesture is over: the (still-held) modifier's release does nothing.
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cancel',
        `post-Escape modifier release must be inert — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('Escape re-arms the controller for a fresh gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      pressEscape();
      assert(calls.join(',') === 'start,cancel',
        `Escape cancels without commit — got ${calls.join(',')}`);
      // A fresh gesture starts cleanly afterwards.
      pressTrigger();
      assert(pressTrigger(), 're-press must cycle in the fresh gesture');
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cancel,start,cycle,commit',
        `the next gesture must run a full start/cycle/commit — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('canCycle() === false lets the trigger fall through untouched', () => {
    const { controller, calls } = makeHarness({ canCycle: () => false });
    try {
      const prevented = pressTrigger();
      assert(!prevented, 'an inapplicable trigger must NOT be preventDefault-ed');
      assert(calls.length === 0, `no callback may fire — got ${calls.join(',')}`);
      releaseKey('Shift');
      assert(calls.length === 0, 'no gesture started, so keyup must be inert');
    } finally {
      controller.destroy();
    }
  });

  await run('shouldHandle false leaves the event alone', () => {
    const { controller, calls } = makeHarness({ shouldHandle: () => false });
    try {
      const prevented = pressTrigger();
      assert(!prevented && calls.length === 0, 'gated trigger must fall through with no callbacks');
    } finally {
      controller.destroy();
    }
  });

  await run('releasing a non-configured key does not end the gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      releaseKey('Alt'); // not in modifierKeys — must be ignored
      assert(!calls.includes('commit'), 'a non-modifier keyup must not commit');
      assert(pressTrigger(), 'the gesture must still be live and cycling');
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,commit',
        `only the configured modifier ends the gesture — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('onGestureStart fires again for each new gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      pressTrigger();
      releaseKey('Shift');
      pressTrigger();
      releaseKey('Shift');
      assert(calls.join(',') === 'start,commit,start,commit',
        `two peek taps are two full gestures — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  // ── Trigger mode: no shortcutId, presses arrive through press() ─────────────
  // The shape of Ctrl+Tab in the desktop app: the native window claims the Tab
  // press and re-raises it as an event, while the Control key's own keydown and
  // keyup still reach the page.

  /**
   * A trigger-mode controller (Control as the held modifier) whose callbacks
   * log their step. Callers must destroy() it.
   * @param {object} [overrides] - HoldToCycleConfig overrides.
   * @returns {{controller: HoldToCycleController, calls: string[]}} The live controller and its log.
   */
  const makeTriggerHarness = (overrides = {}) => {
    /** @type {string[]} */
    const calls = [];
    const controller = new HoldToCycleController({
      modifierKeys: ['Control'],
      shouldHandle: () => true,
      // `:tap` marks a gesture the controller says will not stay open.
      onGestureStart: (step, open) => calls.push(`start:${step}${open ? '' : ':tap'}`),
      onCycle: (step) => calls.push(`cycle:${step}`),
      onCommit: () => calls.push('commit'),
      onCancel: () => calls.push('cancel'),
      ...overrides,
    });
    controller.init();
    return { controller, calls };
  };
  /** @param {string} key */
  const holdKey = (key) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  await run('trigger mode: a press while the modifier is held opens, re-presses cycle with their step, release commits', () => {
    const { controller, calls } = makeTriggerHarness();
    try {
      holdKey('Control');
      assert(controller.press(1) === true, 'a press that starts a gesture reports it acted');
      controller.press(1);
      controller.press(-1);
      assert(calls.join(',') === 'start:1,cycle:1,cycle:-1',
        `the opening press carries its step, and so does each re-press — got ${calls.join(',')}`);
      releaseKey('Control');
      assert(calls.join(',') === 'start:1,cycle:1,cycle:-1,commit',
        `releasing the held modifier commits — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('trigger mode: a press that arrives after the modifier was released commits at once', () => {
    const { controller, calls } = makeTriggerHarness();
    try {
      // A quick tap: the keyup overtook the native round-trip carrying the press.
      holdKey('Control');
      releaseKey('Control');
      controller.press(1);
      assert(calls.join(',') === 'start:1:tap,commit',
        `a press with nothing held is a whole gesture in one go, and says so at its start — got ${calls.join(',')}`);
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'a gesture that is already over leaves no pointer-idle flag behind');
      controller.press(1);
      assert(calls.join(',') === 'start:1:tap,commit,start:1:tap,commit',
        `and the next one is a fresh gesture — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('trigger mode: losing the window forgets the held modifier', () => {
    const { controller, calls } = makeTriggerHarness();
    try {
      holdKey('Control');
      // Released in another app: this window never hears the keyup.
      window.dispatchEvent(new Event('blur'));
      controller.press(1);
      assert(calls.join(',') === 'start:1:tap,commit',
        `with the hold forgotten, a press commits at once rather than waiting on a keyup that is not coming — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('trigger mode: keydowns never start a gesture, and Escape still cancels', () => {
    const { controller, calls } = makeTriggerHarness();
    try {
      holdKey('Control');
      const tab = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true });
      assert(document.dispatchEvent(tab), 'a keydown is not the trigger, so it is left alone');
      assert(calls.length === 0, `no callback for a keydown — got ${calls.join(',')}`);
      controller.press(1);
      pressEscape();
      releaseKey('Control');
      assert(calls.join(',') === 'start:1,cancel',
        `Escape cancels, and the release after it is inert — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('commit() and cancel() end a live gesture as release and Escape would, and are inert otherwise', () => {
    const { controller, calls } = makeTriggerHarness();
    try {
      controller.commit();
      controller.cancel();
      assert(calls.length === 0, `between gestures both are no-ops — got ${calls.join(',')}`);

      holdKey('Control');
      controller.press(1);
      controller.commit();
      releaseKey('Control');
      assert(calls.join(',') === 'start:1,commit',
        `commit() ends the gesture, so the release after it is inert — got ${calls.join(',')}`);

      holdKey('Control');
      controller.press(1);
      controller.cancel();
      releaseKey('Control');
      assert(calls.join(',') === 'start:1,commit,start:1,cancel',
        `cancel() ends it without committing, and the release after it is inert — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('trigger mode: an inapplicable press reports it did nothing', () => {
    const { controller, calls } = makeTriggerHarness({ canCycle: () => false });
    try {
      holdKey('Control');
      assert(controller.press(1) === false, 'press() is false when the gesture cannot start');
      releaseKey('Control');
      assert(calls.length === 0, `no callback may fire — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('defaultShouldHandle gates on a composer textarea with no modal open', () => {
    const box = document.createElement('composer-box');
    const textarea = document.createElement('textarea');
    box.appendChild(textarea);
    const bare = document.createElement('textarea');
    const div = document.createElement('div');
    box.appendChild(div);
    assert(defaultShouldHandle(/** @type {any} */ ({ target: textarea })) === true,
      'textarea inside composer-box should be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: bare })) === false,
      'a textarea outside composer-box should not be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: div })) === false,
      'a non-textarea inside composer-box should not be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: null })) === false,
      'a non-element target should not be handled');
  });

  return { passed, failed, errors };
}
