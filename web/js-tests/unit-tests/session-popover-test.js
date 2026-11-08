//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session switcher over a project page: ⌘K's hold-to-cycle gesture, as
 * Ctrl+Tab's recent-conversation switcher works, and the chip's popover that
 * stays open.
 *
 * ⌘K shows the list lit on this window: a tap leaves it up to stay, as a
 * click on the chip does, where ↑↓ and ↵ pick and Escape or a click outside
 * leaves the window exactly where it was. Holding ⌘, each further K lights the
 * next row, letting go goes there, Escape changes nothing, and a click picks a
 * row. The machine, the navigation and the relay are fakes
 * that record what was asked of them; the gesture is the real
 * HoldToCycleController on the real `switch-session` binding.
 * @module unit-tests/session-popover-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import { isMac } from '../../js/services/key-shortcut-manager.js';
import { markPopupOpen } from '../../js/utils/popup-manager.js';
import { SessionPopover, placePopover } from '../../js/components/session-popover.js';
import { openProjectCommand } from '../../js/components/header-controls.js';
import { isolateFocus } from '../utilities/isolate-focus.js';

const MOD = isMac() ? 'Meta' : 'Control';
const modFlag = isMac() ? { metaKey: true } : { ctrlKey: true };
const NOW = Date.now();

/**
 * @param {number} minutes
 * @returns {string} That long ago.
 */
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

/**
 * A running session.
 * @param {string} id
 * @param {object} [more]
 * @returns {any} It.
 */
function session(id, more = {}) {
  return { id, project: `/code/${id}`, link: `/p/${id}-0000/`, state: 'running', busy: false, startedAt: ago(600), ...more };
}

/**
 * The machine as this window, on `here`, sees it: here used last, then beta,
 * gamma and delta; one recent project.
 * @returns {any} The feed.
 */
function machine() {
  return {
    available: true,
    sessions: [
      session('here', { lastViewed: ago(1), viewers: 1 }),
      session('beta', { lastViewed: ago(10) }),
      session('gamma', { lastViewed: ago(20) }),
      session('delta', { lastViewed: ago(30) }),
    ],
    recents: { paths: ['/code/old'], links: { '/code/old': '/p/old-0000/' }, waiting: {}, used: {} },
    subscribe: () => () => {},
  };
}

/**
 * Dispatch a key event on the document, as a real keypress reaches it.
 * @param {'keydown'|'keyup'} type
 * @param {string} key
 * @param {object} [init]
 * @returns {KeyboardEvent} The event.
 */
const key = (type, key, init = {}) => {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
};

/** Hold the command modifier. */
const hold = () => { key('keydown', MOD, modFlag); };
/** @returns {KeyboardEvent} A K press while it is held. */
const pressK = () => key('keydown', 'k', modFlag);
/** Let the command modifier go. */
const release = () => { key('keyup', MOD); };

/**
 * A popover on a fake chip, recording every move.
 * @param {object} [o]
 * @param {(m: any) => void} [o.tweak] - Changes the machine first.
 * @param {'tab'|'url'|'local'} [o.surface]
 * @returns {{p: SessionPopover, calls: string[], chip: HTMLButtonElement, m: any, resolveOpen: (s: any) => void, done: () => void}} It.
 */
function mount({ tweak = () => {}, surface = 'local' } = {}) {
  const m = machine();
  tweak(m);
  /** @type {string[]} */
  const calls = [];
  const chip = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  chip.id = 'test-session-chip';
  document.body.append(chip);
  /** @type {(s: any) => void} */
  let resolveOpen = () => {};
  const p = new SessionPopover({
    chip,
    feed: m,
    ownLink: '/p/here-0000/',
    surface,
    go: async (to) => { calls.push(`go:${to.link || to.project}${to.newWindow ? ':new' : ''}`); },
    open: (project) => {
      calls.push(`open:${project}`);
      return new Promise((resolve) => { resolveOpen = resolve; });
    },
    stop: async (id) => { calls.push(`stop:${id}`); },
    createFolder: async (parent, name) => { calls.push(`mkdir:${parent}/${name}`); return `${parent}/${name}`; },
    pickFolder: async () => { calls.push('pick'); return null; },
    toServerPage: async () => { calls.push('server-page'); },
    showError: (message) => { calls.push(`error:${message}`); },
  });
  p.init();
  return {
    p,
    calls,
    chip,
    m,
    resolveOpen: (s) => resolveOpen(s),
    done: () => {
      p.destroy();
      chip.remove();
      release();
      document.body.classList.remove('hud-pointer-idle');
    },
  };
}

/** @returns {HTMLElement|null} The popover, if it is up. */
const popover = () => /** @type {HTMLElement|null} */ (document.querySelector('.ss--popover'));

/** @returns {string|undefined} The lit row's key. */
const lit = () => /** @type {HTMLElement|null} */ (popover()?.querySelector('.ss-row[aria-selected="true"]') ?? null)?.dataset.key;

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} label
   * @param {() => Promise<void>|void} fn
   */
  const test = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const el of document.querySelectorAll('.ss--popover')) el.remove();
    }
  };

  // Focus is lane-local in the cases that assert on it: a sibling lane's
  // focus() takes this frame's away, so each steals it after the action, and
  // the assertion reads where the code asked focus to go (isolateFocus).
  await test('a ⌘K tap opens the list to stay, lit on this window, and moves nothing', async () => {
    const focus = isolateFocus();
    const { calls, chip, done } = mount();
    try {
      hold();
      const e = pressK();
      assert(e.defaultPrevented, 'the press is taken');
      release();
      focus.steal();
      await nextTask();
      assert(calls.length === 0, `nothing moved — got ${calls.join()}`);
      const pop = popover();
      assert(!!pop && !pop.classList.contains('ss--gesture'), 'the list stays up, with its filter');
      const holder = (/** @type {Element|null} */ a) => (a ? `<${a.localName}${a.id ? `#${a.id}` : ''}${a.className && typeof a.className === 'string' ? `.${a.className.trim().split(/\s+/).join('.')}` : ''}>` : 'nothing');
      assert(document.activeElement === pop?.querySelector('.ss-input'),
        `the filter has the keyboard — held by ${holder(document.activeElement)}`);
      assert(chip.getAttribute('aria-expanded') === 'true', 'the chip says so');
      assert(lit() === 's:here', `this window is lit — got ${lit()}`);
      const input = /** @type {HTMLInputElement} */ (pop?.querySelector('.ss-input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      assert(lit() === 's:beta', `↓ moves on — got ${lit()}`);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await nextTask();
      assert(calls.join() === 'go:/p/beta-0000/' && !popover(), `↵ goes there — got ${calls.join()}`);
    } finally {
      done();
      focus.restore();
    }
  });

  await test('holding ⌘ shows the HUD at this window; each K walks on, and letting go goes there', async () => {
    const { calls, done } = mount();
    try {
      hold();
      pressK();
      const hud = popover();
      assert(!!hud, 'the list is up while ⌘ is held');
      assert(hud?.classList.contains('ss--gesture') === true, 'as a HUD');
      // The filter is there from the first frame, so settling into the list
      // a tap leaves up shifts nothing.
      assert(hud?.querySelector('.ss-search')?.checkVisibility() === true, 'with its filter, laid out from the start');
      assert(document.body.classList.contains('hud-pointer-idle'), 'rows ignore the pointer until it moves');
      assert(lit() === 's:here', `this window is lit — got ${lit()}`);
      pressK();
      assert(lit() === 's:beta', `the next K lights the session used before — got ${lit()}`);
      pressK();
      assert(lit() === 's:gamma', `got ${lit()}`);
      pressK();
      pressK();
      assert(lit() === 'r:/code/old', `the walk runs on into Recent — got ${lit()}`);
      pressK();
      assert(lit() === 's:here', `and wraps back to this window — got ${lit()}`);
      pressK();
      pressK();
      assert(calls.length === 0, 'nothing moves while ⌘ is held');
      release();
      await nextTask();
      assert(calls.join() === 'go:/p/gamma-0000/', `got ${calls.join()}`);
      assert(!popover(), 'and the HUD is gone');
    } finally {
      done();
    }
  });

  await test('a walk back round to this window and letting go stays put', async () => {
    const { calls, done } = mount();
    try {
      hold();
      for (let i = 0; i < 6; i++) pressK();
      assert(lit() === 's:here', `got ${lit()}`);
      release();
      await nextTask();
      assert(calls.length === 0, `nothing moved — got ${calls.join()}`);
      assert(!popover(), 'the HUD is gone');
    } finally {
      done();
    }
  });

  await test('Escape cancels the gesture, and the release after it goes nowhere', async () => {
    const { calls, done } = mount();
    try {
      hold();
      pressK();
      key('keydown', 'Escape', modFlag);
      assert(!popover(), 'Escape closes the HUD');
      release();
      await nextTask();
      assert(calls.length === 0, `got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('Escape after walking a few rows changes its mind: nothing moves, the window stays', async () => {
    const { calls, chip, done } = mount();
    try {
      hold();
      pressK();
      pressK();
      pressK();
      assert(lit() === 's:gamma', `the walk lit gamma — got ${lit()}`);
      const esc = key('keydown', 'Escape', modFlag);
      assert(esc.defaultPrevented, 'the Escape is taken');
      assert(!popover(), 'Escape with ⌘ still held closes the HUD');
      assert(chip.getAttribute('aria-expanded') === 'false', 'the chip says so');
      release();
      await nextTask();
      assert(calls.length === 0, `letting go of ⌘ after went nowhere — got ${calls.join()}`);
      assert(!popover(), 'and opened nothing again');
    } finally {
      done();
    }
  });

  await test('a click on a row picks it, and the release after it does nothing more', async () => {
    const { calls, done } = mount();
    try {
      hold();
      pressK();
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      assert(!document.body.classList.contains('hud-pointer-idle'), 'a moved pointer works the rows again');
      const row = /** @type {HTMLElement|null} */ (popover()?.querySelector('.ss-row[data-key="s:delta"]') ?? null);
      assert(!!row, 'delta has a row');
      row?.click();
      await nextTask();
      assert(calls.join() === 'go:/p/delta-0000/', `got ${calls.join()}`);
      release();
      await nextTask();
      assert(calls.join() === 'go:/p/delta-0000/', `the release adds nothing — got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('with nowhere else to go, ⌘K still opens the list, to open a folder', () => {
    const { done } = mount({ tweak: (m) => { m.sessions = [m.sessions[0]]; m.recents = { paths: [], links: {}, waiting: {}, used: {} }; } });
    try {
      hold();
      const e = pressK();
      assert(e.defaultPrevented && !!popover(), 'the list is up');
      assert(lit() === 's:here', `got ${lit()}`);
    } finally {
      done();
    }
  });

  await test('behind another popup ⌘K stands down', () => {
    const { done } = mount();
    const releaseForeign = markPopupOpen(() => {});
    try {
      hold();
      const e = pressK();
      assert(!e.defaultPrevented && !popover(), 'a foreign overlay owns the keyboard');
    } finally {
      releaseForeign();
      done();
    }
  });

  await test('a chip click opens the list to stay, lit on this window; Escape leaves everything as it was', async () => {
    const focus = isolateFocus();
    const { calls, chip, done } = mount();
    try {
      chip.click();
      focus.steal();
      const pop = popover();
      assert(!!pop && !pop.classList.contains('ss--gesture'), 'the popover is up, with its filter');
      assert(document.activeElement === pop?.querySelector('.ss-input'), 'the filter has the keyboard');
      assert(chip.getAttribute('aria-expanded') === 'true', 'the chip says so');
      assert(lit() === 's:here', `got ${lit()}`);
      const input = /** @type {HTMLInputElement} */ (pop?.querySelector('.ss-input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(!popover() && chip.getAttribute('aria-expanded') === 'false', 'Escape closes it');
      await nextTask();
      assert(calls.length === 0, `and nothing moved — got ${calls.join()}`);

      chip.click();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      assert(!popover(), 'a click outside closes it');
      await nextTask();
      assert(calls.length === 0, `and nothing moved — got ${calls.join()}`);
    } finally {
      done();
      focus.restore();
    }
  });

  // The chip is in the window's drag region: a window dragged by it ends in a
  // click on it, which is no press; a press that stays put, or the keyboard's,
  // still is.
  await test('a click that ends a window drag by the chip opens nothing', () => {
    const { chip, done } = mount();
    /**
     * Press the chip at one screen point and let go at another, then click.
     * @param {number} x - Where it is let go.
     */
    const pressAndRelease = (x) => {
      chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, screenX: 200, screenY: 40 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: x, screenY: 40 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: x, screenY: 40 }));
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    };
    try {
      pressAndRelease(420);
      assert(!popover(), 'a window dragged by the chip opened the list');
      pressAndRelease(201);
      assert(!!popover(), 'a press that stayed put did not open the list');
      pressAndRelease(201);
      assert(!popover(), 'a second press did not close it');
      pressAndRelease(420);
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
      assert(!!popover(), 'a click from the keyboard after a drag did not open the list');
    } finally {
      done();
    }
  });

  await test('↵ on this window stays put; on another moves the window there, and ⌘↵ asks for a new window', async () => {
    const { calls, chip, done } = mount();
    try {
      chip.click();
      const here = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      here.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await nextTask();
      assert(calls.length === 0 && !popover(), `↵ on this window closes the list and moves nothing — got ${calls.join()}`);
      chip.click();
      const input = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await nextTask();
      assert(calls.join() === 'go:/p/beta-0000/' && !popover(), `got ${calls.join()}`);
      chip.click();
      const again = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      again.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modFlag }));
      await nextTask();
      assert(calls.at(-1) === 'go:/p/beta-0000/:new', `got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('a recent project in a desktop window says Starting… while it opens, then the window goes there', async () => {
    const { calls, chip, resolveOpen, done } = mount();
    try {
      chip.click();
      const row = /** @type {HTMLElement} */ (popover()?.querySelector('.ss-row[data-key="r:/code/old"]') ?? document.createElement('div'));
      row.click();
      await nextTask();
      assert(calls.join() === 'open:/code/old', `got ${calls.join()}`);
      assert(!!popover(), 'the popover stays up while it starts');
      const sub = popover()?.querySelector('.ss-row[data-key="r:/code/old"] .ss-sub')?.textContent;
      assert(sub === 'Starting…', `got ${sub}`);
      resolveOpen(session('old', { project: '/code/old', link: '/p/old-0000/' }));
      await nextTask();
      assert(calls.join() === 'open:/code/old,go:/p/old-0000/', `got ${calls.join()}`);
      assert(!popover(), 'and closes as the window moves');
    } finally {
      done();
    }
  });

  await test('Escape while a recent project starts leaves the window where it was', async () => {
    const { calls, chip, resolveOpen, done } = mount();
    try {
      chip.click();
      /** @type {HTMLElement} */ (popover()?.querySelector('.ss-row[data-key="r:/code/old"]') ?? document.createElement('div')).click();
      await nextTask();
      const input = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      resolveOpen(session('old', { project: '/code/old', link: '/p/old-0000/' }));
      await nextTask();
      assert(calls.join() === 'open:/code/old', `got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('in a browser tab a recent project is its link', async () => {
    const { calls, chip, done } = mount({ surface: 'tab' });
    try {
      chip.click();
      /** @type {HTMLElement} */ (popover()?.querySelector('.ss-row[data-key="r:/code/old"]') ?? document.createElement('div')).click();
      await nextTask();
      assert(calls.join() === 'go:/p/old-0000/', `got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('stopping this window\'s own session moves the window to the server page', async () => {
    const { calls, chip, done } = mount();
    try {
      chip.click();
      const input = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      assert(lit() === 's:here', `got ${lit()}`);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true, ...modFlag }));
      await nextTask();
      await nextTask();
      assert(calls.join() === 'stop:here,server-page', `got ${calls.join()}`);
    } finally {
      done();
    }
  });

  await test('stopping another session leaves this window as it is', async () => {
    const { calls, chip, done } = mount();
    try {
      chip.click();
      const input = /** @type {HTMLInputElement} */ (popover()?.querySelector('.ss-input') ?? document.createElement('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true, ...modFlag }));
      await nextTask();
      assert(calls.join() === 'stop:beta', `got ${calls.join()}`);
      assert(!!popover(), 'the popover stays up');
    } finally {
      done();
    }
  });

  await test('the app\'s Open… (⌘O) while the popover is up is its Open folder…', async () => {
    // The window's own Open…, registered as the page does: at boot, before the
    // popover ever opens — so ahead of it at the window, in an engine that runs
    // a target's listeners in the order they were added.
    let heardElsewhere = false;
    const elsewhere = openProjectCommand(() => { heardElsewhere = true; });
    window.addEventListener('juggler:open-project', elsewhere);
    const { calls, chip, done } = mount();
    try {
      chip.click();
      window.dispatchEvent(new CustomEvent('juggler:open-project'));
      await nextTask();
      assert(calls.join() === 'pick', `got ${calls.join()}`);
      assert(!heardElsewhere, 'the window\'s own Open… does not run as well');
      done();
      window.dispatchEvent(new CustomEvent('juggler:open-project'));
      assert(heardElsewhere, 'with the popover down, Open… is the window\'s again');
    } finally {
      window.removeEventListener('juggler:open-project', elsewhere);
      done();
    }
  });

  await test('on a phone it is a sheet titled Switch to, whose Cancel closes it', () => {
    const { calls, chip, done } = mount();
    try {
      chip.click();
      const bar = popover()?.querySelector('.ss-sheetbar');
      assert(bar?.querySelector('.ss-sheet-title')?.textContent === 'Switch to', 'the sheet has its title');
      /** @type {HTMLElement} */ (bar?.querySelector('.ss-sheet-cancel') ?? document.createElement('button')).click();
      assert(!popover() && calls.length === 0, 'Cancel closes it, moving nothing');
    } finally {
      done();
    }
  });

  await test('the popover drops under the chip, left-aligned with it and kept inside the window', () => {
    const at = placePopover({ chipLeft: 200, chipBottom: 40, viewportWidth: 1200 });
    assert(at.left === 192 && at.top === 46 && at.width === 576, JSON.stringify(at));
    const right = placePopover({ chipLeft: 900, chipBottom: 40, viewportWidth: 1200 });
    assert(right.left === 1200 - 576 - 16, `kept inside on the right — ${JSON.stringify(right)}`);
    const narrow = placePopover({ chipLeft: 4, chipBottom: 40, viewportWidth: 400 });
    assert(narrow.left === 16 && narrow.width === 368, `kept inside on the left, narrowed — ${JSON.stringify(narrow)}`);
  });

  return { passed, failed, errors };
}
