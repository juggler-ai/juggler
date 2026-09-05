//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pinboard shell tests — the attached surface: the edge button, the overlay, the
 * tab strip, and the pin body an item type fills.
 *
 * The board is rendered against a **probe item type** registered only here. A
 * placeholder provider shipped in product UI would be a promise the app cannot
 * keep, and a test that renders nothing proves nothing about mounting, so the
 * probe lives in the test and nowhere else.
 *
 * `window.fetch` is stubbed for the whole suite against a fake server board that
 * really applies the operations it is sent, so add/remove/move are exercised end
 * to end rather than asserted as request shapes (pinboard-test already pins
 * those). Websocket pushes stand in for another viewer, as in pinboard-test.
 * @module unit-tests/pinboard-shell-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import pinboardStore from '../../js/services/pinboard-store.js';
import pinboardView from '../../js/services/pinboard-view.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import wsService from '../../js/services/websocket.js';
import { isMac } from '../../js/services/key-shortcut-manager.js';
import { REGISTRIES_RELOADED } from '../../js/registries/reload-registries.js';
import { __resetPopupManagerForTests, isAnyPopupOpen } from '../../js/utils/popup-manager.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-shell.js';
import { budgetFor } from '../utilities/test-deadline.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Mount/teardown tallies, so lifecycle can be asserted rather than inferred. */
const probeCalls = { mounts: 0, teardowns: 0, updates: 0 };

/** An ordinary item type: multiple instances, a describable config, a body. */
class ProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  describe(config) {
    return { title: config.label || 'Probe', subtitle: 'probe item', badge: config.badge };
  }

  mount(container, pinContext) {
    probeCalls.mounts++;
    container.textContent = `probe:${pinContext.pin.config.label || ''}`;
    return {
      update: () => { probeCalls.updates++; },
      teardown: () => { probeCalls.teardowns++; },
    };
  }

  static canPinSource(source) {
    return source.kind === 'probe';
  }

  static configFromSource(source) {
    return { label: source.label };
  }
}

/** What the ActionsPin's toolbar controls did, and what they should offer next. */
const actionCalls = { open: 0, refresh: 0, thrown: 0 };

/** Swapped by a test to make `getActions` itself misbehave. */
let actionsBehaviour = 'normal';

/** A type with toolbar actions: one primary, two in the overflow, one that fails. */
class ActionsPin extends PinboardItemType {
  static MANIFEST = {
    id: 'actions',
    name: 'Actions',
    version: '1.0.0',
    description: 'A pin that offers the toolbar something',
    instances: 'multiple',
  };

  mount(container) {
    container.textContent = 'actions body';
    return {
      teardown: () => {},
      getActions: () => {
        if (actionsBehaviour === 'throws') throw new Error('actions failure');
        if (actionsBehaviour === 'none') return [];
        if (actionsBehaviour === 'rubbish') {
          return /** @type {any} */ ([null, { label: 'no run' }, { run: () => {} }]);
        }
        return [
          { id: 'open', label: 'Open', primary: true, run: () => { actionCalls.open++; } },
          { id: 'refresh', label: 'Refresh', run: () => { actionCalls.refresh++; } },
          {
            id: 'copy-path',
            label: 'Copy path',
            run: () => { actionCalls.thrown++; throw new Error('clipboard said no'); },
          },
        ];
      },
    };
  }
}

/**
 * The PathPin's refresh, and the hook the test settles it by. The refresh is
 * deliberately left in flight, because what happens while it is in flight is the
 * thing being pinned.
 */
const pathCalls = { refreshes: 0, finish: /** @type {null|(() => void)} */ (null) };

/** A type that names a file: the toolbar is then a path and the host's controls. */
class PathPin extends PinboardItemType {
  static MANIFEST = {
    id: 'path',
    name: 'Path',
    version: '1.0.0',
    description: 'A pin that shows a file',
    instances: 'multiple',
  };

  describe(config) {
    // A subtitle as well, to pin that a path supersedes it rather than joining it.
    return { title: 'main.go', subtitle: 'never shown', path: config.path || '' };
  }

  mount(container) {
    container.textContent = 'path body';
    return {
      teardown: () => {},
      getActions: () => [
        {
          id: 'refresh',
          label: 'Refresh',
          icon: 'refresh',
          primary: true,
          run: () => {
            pathCalls.refreshes++;
            return new Promise((resolve) => { pathCalls.finish = () => resolve(undefined); });
          },
        },
        { id: 'later', label: 'Later', run: () => {} },
      ],
    };
  }
}

/** What the WatcherPin was told about files changing, and how it was mounted. */
const watcherCalls = { changes: /** @type {any[]} */ ([]), unsubscribes: 0 };

/** A type that subscribes to file changes, for the host's half of that service. */
class WatcherPin extends PinboardItemType {
  static MANIFEST = {
    id: 'watcher',
    name: 'Watcher',
    version: '1.0.0',
    description: 'A pin that watches files',
    // Registered third, and asks to be offered first — the two rules the add
    // picker's order has to keep apart.
    order: -1,
    addLabel: 'Watch something…',
  };

  mount(container, pinContext) {
    container.textContent = 'watching';
    const stop = pinContext.services.files.onChange((changes) => {
      watcherCalls.changes.push(...changes);
    });
    return {
      teardown: () => {
        watcherCalls.unsubscribes++;
        stop();
      },
    };
  }
}

/** A singleton type that refuses to mount, for the host's error shell. */
class BrokenPin extends PinboardItemType {
  static MANIFEST = {
    id: 'broken',
    name: 'Broken',
    version: '1.0.0',
    description: 'A pin that fails on purpose',
  };

  mount() {
    throw new Error('probe failure');
  }
}

/**
 * A fake server board that applies the operations it is sent, so a test can act
 * on the board the way a user does and read the result.
 * @param {any[]} pins - The board the server starts with.
 * @returns {{board: any[], restore: () => void, requests: number}} The fake and its restore.
 */
function stubServer(pins) {
  const state = { board: pins.map((p) => ({ ...p })), requests: 0, restore: () => {} };
  const original = window.fetch;
  state.restore = () => { window.fetch = original; };
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
    state.requests++;
    if (String(url).includes('/operations')) {
      for (const op of JSON.parse(opts.body).operations) applyOp(state.board, op);
    }
    return { ok: true, json: async () => ({ pins: state.board }) };
  });
  return state;
}

/**
 * The server's merge semantics, small enough to restate: every op names its pin
 * and is idempotent.
 * @param {any[]} board - The board to edit in place.
 * @param {any} op - One operation.
 * @returns {void}
 */
function applyOp(board, op) {
  const at = board.findIndex((p) => p.id === op.id);
  switch (op.op) {
    case 'add':
      if (at >= 0) return;
      board.splice(typeof op.index === 'number' ? op.index : board.length, 0,
        { id: op.id, type: op.type, config: op.config || {} });
      break;
    case 'remove':
      if (at >= 0) board.splice(at, 1);
      break;
    case 'move': {
      if (at < 0) return;
      const [pin] = board.splice(at, 1);
      board.splice(Math.max(0, Math.min(board.length, op.index)), 0, pin);
      break;
    }
    case 'update':
      if (at >= 0) board[at].config = op.config || {};
      break;
    default:
      break;
  }
}

/**
 * The listeners the fake session is holding, so a case can move the session the
 * way the app does. The shell drops its own on the way out of the document.
 * @type {Set<(event: any) => void>}
 */
const sessionListeners = new Set();

/** Whether the fake conversation's composer currently holds a draft. */
let composerHasText = false;

/** A session with just enough of one for the active-context snapshot and reveal guard. */
const fakeSession = {
  projectPath: '/tmp/probe-project',
  visibleConversationId: 'conversation-one',
  subscribe: (/** @type {(event: any) => void} */ fn) => {
    sessionListeners.add(fn);
    return () => sessionListeners.delete(fn);
  },
  emit: (/** @type {string} */ type) => {
    for (const fn of [...sessionListeners]) fn({ type });
  },
  getVisibleConversation: () => null,
  getConversation: (/** @type {string} */ id) => id === 'conversation-one'
    ? { getTabElement: () => ({ hasComposerText: () => composerHasText }) }
    : null,
  shouldFollowRequest(from) {
    if (!from || this.visibleConversationId !== from) return false;
    return !this.getConversation(from)?.getTabElement?.()?.hasComposerText?.();
  },
};

/**
 * Put a shell in the document showing this board.
 *
 * The toggle is the header bar's, not the shell's, so the fixture supplies the
 * one the shell adopts — the same id and markup index.html carries.
 * @param {any[]} pins - The board the fake server holds.
 * @returns {Promise<{shell: any, toggle: any, server: any, teardown: () => void}>} The mounted shell.
 */
async function mountShell(pins) {
  pinboardStore.reset();
  pinboardView.reset();
  const server = stubServer(pins);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'pinboard-header-button';
  toggle.className = 'u-btn-ghost u-btn-icon-header pinboard-header-button';
  toggle.title = 'Toggle Pinboard';
  toggle.setAttribute('aria-label', 'Toggle Pinboard');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.hidden = true;
  document.body.appendChild(toggle);
  const shell = /** @type {any} */ (document.createElement('pinboard-shell'));
  document.body.appendChild(shell);
  shell.setSession(fakeSession);
  await settle();
  return {
    shell,
    toggle,
    server,
    teardown: () => {
      shell.remove();
      toggle.remove();
      server.restore();
      pinboardStore.reset();
      pinboardView.reset();
    },
  };
}

/**
 * Let pending promises resolve. The board round-trips every edit, so a click's
 * consequences arrive a microtask or two later.
 * @returns {Promise<void>}
 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * The board's chord, as this platform delivers it.
 * @returns {KeyboardEvent} An ⌥⌘P / Ctrl+Alt+P keydown.
 */
function chord() {
  return new KeyboardEvent('keydown', {
    key: 'p',
    altKey: true,
    metaKey: isMac(),
    ctrlKey: !isMac(),
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Drag horizontally across an element with a finger, and let go. Positive is
 * rightward, the way the board leaves.
 * @param {HTMLElement} target - Element the drag starts on.
 * @param {number} dx - How far to travel, in px.
 */
function swipe(target, dx) {
  const start = { x: 200, y: 200 };
  const step = (/** @type {string} */ type, /** @type {number} */ at) => {
    target.dispatchEvent(new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      buttons: 1,
      clientX: start.x + at,
      clientY: start.y,
      bubbles: true,
      cancelable: true,
    }));
  };
  step('pointerdown', 0);
  step('pointermove', Math.sign(dx) * 15);
  step('pointermove', dx);
  step('pointerup', dx);
}

/**
 * @param {any} shell - The mounted shell.
 * @returns {string[]} The tab labels, in strip order.
 */
function tabLabels(shell) {
  return [...shell.querySelectorAll('.pinboard-tab__label')].map((el) => el.textContent);
}

/**
 * @param {any} shell - The mounted shell.
 * @returns {string} The active pin's body text.
 */
function bodyText(shell) {
  return shell.querySelector('.pinboard-content__body')?.textContent || '';
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

  // A lane reuses one JS realm across the suites it runs, so start from a known
  // popup registry and hand back a registry with no probe types in it.
  __resetPopupManagerForTests();
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(ProbePin, { extensionId: 'test' });
  pinboardItemRegistry.registerClass(BrokenPin, { extensionId: 'test' });
  pinboardItemRegistry.registerClass(ActionsPin, { extensionId: 'test' });
  pinboardItemRegistry.registerClass(PathPin, { extensionId: 'test' });
  pinboardItemRegistry.registerClass(WatcherPin, { extensionId: 'test' });

  try {
    await run('the header toggle opens and closes the board', async () => {
      const { shell, toggle, teardown } = await mountShell([]);
      try {
        assert(!toggle.hidden,
          'a usable board must show the header toggle, which starts hidden in the markup');
        assert(toggle.getAttribute('aria-label') === 'Toggle Pinboard',
          `the toggle's label stays literal, got "${toggle.getAttribute('aria-label')}"`);
        toggle.click();
        assert(shell.classList.contains('open'), 'a click must latch the board open');
        assert(toggle.getAttribute('aria-expanded') === 'true', 'the button must report the board open');
        assert(isAnyPopupOpen(), 'an open board holds a popup token, so Escape and Back reach it');
        toggle.click();
        assert(!shell.classList.contains('open'), 'a second click must close it');
        assert(toggle.getAttribute('aria-expanded') === 'false', 'and report it closed again');
        assert(!isAnyPopupOpen(), 'a closed board must release its popup token');
      } finally {
        teardown();
      }
    });

    await run('the shortcut opens the board and closes it again from inside', async () => {
      // The chord is dispatched by the shell precisely so it still fires over the
      // board's own popup token — the manager suppresses commands behind one.
      const { shell, teardown } = await mountShell([]);
      try {
        document.body.dispatchEvent(chord());
        assert(shell.classList.contains('open'), 'the chord must open the board');
        document.body.dispatchEvent(chord());
        assert(!shell.classList.contains('open'),
          'the chord must close the board it opened, not stand down behind it');
      } finally {
        teardown();
      }
    });

    await run('Escape and the scrim both close the board', async () => {
      const { shell, teardown } = await mountShell([]);
      try {
        pinboardView.open();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert(!shell.classList.contains('open'), 'Escape must dismiss the board through popup-manager');

        pinboardView.open();
        shell.querySelector('.pinboard-scrim').click();
        assert(!shell.classList.contains('open'), 'a click on the scrim must close the board');
      } finally {
        teardown();
      }
    });

    await run('the board can be swiped back off the edge it came in from', async () => {
      // The gesture itself is pinned by swipe-dismiss-test; what this pins is
      // the board's wiring of it — which way it goes, and what it concedes.
      const { shell, teardown } = await mountShell([{ id: 'pin_s', type: 'probe', config: { label: 'A' } }]);
      try {
        const panel = /** @type {HTMLElement} */ (shell.querySelector('.pinboard-panel'));
        const grip = /** @type {HTMLElement} */ (shell.querySelector('.pinboard-tab__grip'));
        assert(!!grip, 'the fixture needs a tab, to have a reorder grip to concede to');

        pinboardView.open();
        swipe(panel, 20);
        assert(pinboardView.isOpen(), 'a short drag is not a dismissal');

        swipe(panel, 120);
        assert(!pinboardView.isOpen(), 'a rightward drag past the threshold pushes the board away');

        pinboardView.open();
        swipe(panel, -120);
        assert(pinboardView.isOpen(), 'dragging the other way is dragging it further onto the screen');

        swipe(grip, 120);
        assert(pinboardView.isOpen(), 'a drag from a tab grip is that tab being reordered');
      } finally {
        teardown();
      }
    });

    await run('opening moves focus into the board and closing gives it back', async () => {
      const { shell, toggle, teardown } = await mountShell([]);
      try {
        toggle.focus();
        toggle.click();
        // The panel, not merely the shell: the scrim is in the shell too, so
        // `shell.contains` would pass without focus having moved at all.
        assert(shell.querySelector('.pinboard-panel').contains(document.activeElement),
          `focus must enter the board, went to ${/** @type {any} */ (document.activeElement)?.className}`);
        // And onto the body rather than a tab: WebKit rings a programmatically
        // focused control, so a tab would wear a focus ring on every open.
        assert(!(/** @type {any} */ (document.activeElement)?.closest?.('.pinboard-tab')),
          'opening the board must not select a tab, it must only put the keyboard in the board');
        toggle.click();
        assert(document.activeElement === toggle,
          'closing must return focus to what opened the board');
      } finally {
        teardown();
      }
    });

    await run('an empty board keeps its chrome and offers the same picker', async () => {
      const { shell, teardown } = await mountShell([]);
      try {
        pinboardView.open();
        assert(bodyText(shell).includes('Nothing pinned.'),
          `the empty state must say so, got "${bodyText(shell)}"`);
        assert(!!shell.querySelector('.pinboard-tabbar__add'),
          'the + stays where it is, so its position never depends on the board');
      } finally {
        teardown();
      }
    });

    await run('pins render as tabs, and the active one mounts its item type', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta', badge: '2' } },
      ]);
      try {
        pinboardView.open();
        assert(tabLabels(shell).join(',') === 'alpha,beta',
          `tabs take their labels from describe(), got ${tabLabels(shell).join(',')}`);
        assert(shell.querySelector('.pinboard-tab__badge:not([hidden])')?.textContent === '2',
          'a badge is shown when the item type supplies one');
        assert(bodyText(shell) === 'probe:alpha',
          `the first pin must be the one mounted, got "${bodyText(shell)}"`);

        const tabs = shell.querySelectorAll('.pinboard-tab__button');
        assert(tabs[0].getAttribute('aria-selected') === 'true' && tabs[0].tabIndex === 0,
          'the active tab is selected and holds the strip\'s only tab stop');
        assert(tabs[1].getAttribute('aria-selected') === 'false' && tabs[1].tabIndex === -1,
          'an inactive tab is out of the tab order (roving tabindex)');

        tabs[1].click();
        assert(bodyText(shell) === 'probe:beta', 'selecting a tab mounts its pin');
        assert(probeCalls.teardowns > 0, 'the pin being left must be torn down');
      } finally {
        teardown();
      }
    });

    // macOS sends a secondary click as button 0 with ctrl held, and the menu it
    // opens swallows the release. A reorder gesture started there has nothing
    // left to end it: the tab is armed, and the next movement of an empty hand
    // drags it.
    await run('ctrl-click on a tab opens a menu rather than arming a drag', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        const tabs = shell.querySelectorAll('.pinboard-tab__button');
        tabs[1].dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, ctrlKey: true, bubbles: true,
        }));
        document.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 1, buttons: 1, clientX: 400, clientY: 400, bubbles: true,
        }));
        const ghost = shell.querySelector('.drag-ghost');
        const placeholder = shell.querySelector('.drag-source');
        // Put away whatever did start, so its document listeners don't outlive
        // the test.
        document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
        assert(!ghost, 'a ctrl-click must not lift a tab off the strip');
        assert(!placeholder, 'a ctrl-click must not leave a tab standing as a placeholder');
      } finally {
        teardown();
      }
    });

    // A click goes to the common ancestor of the press and the release, and
    // pointer capture is what the release retargets to. So the element that
    // captures has to be the one listening for the click, or the click is
    // delivered somewhere above it and tabs stop selecting after a gesture.
    // Here that element is the wrapper. Synthetic pointers cannot really be
    // captured, so what is asserted is where the strip asks.
    await run('a tab drag captures the pointer where the click will land', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        const wrapper = shell.querySelector('.pinboard-tab');
        const button = wrapper.querySelector('.pinboard-tab__button');
        /** @type {string[]} */
        const captured = [];
        for (const [name, el] of [['wrapper', wrapper], ['button', button]]) {
          el.setPointerCapture = () => captured.push(name);
          el.releasePointerCapture = () => {};
        }

        const rest = button.getBoundingClientRect();
        const grabX = rest.left + rest.width / 2;
        const grabY = rest.top + rest.height / 2;
        button.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: grabX, clientY: grabY, bubbles: true,
        }));
        document.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 1, buttons: 1, clientX: grabX + 40, clientY: grabY, bubbles: true,
        }));
        document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
        assert(captured.join(',') === 'wrapper',
          `the strip must capture where the click lands, captured on ${captured.join(', ') || 'nothing'}`);
      } finally {
        teardown();
      }
    });

    // The grip is part of the tab, and looks like part of the tab. A click that
    // lands on it is aimed at the tab, so it has to select the tab — which it
    // does not if the only listener is on the button beside it.
    await run('clicking the grip selects the tab, as clicking anywhere else on it does', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        assert(bodyText(shell) === 'probe:alpha', 'the board starts on the first pin');
        const second = shell.querySelectorAll('.pinboard-tab')[1];
        second.querySelector('.pinboard-tab__grip').click();
        assert(bodyText(shell) === 'probe:beta',
          `a click on the grip must select its tab, still showing "${bodyText(shell)}"`);
      } finally {
        teardown();
      }
    });

    // Nothing else claims a touch on the strip, so a tab that made no claim of
    // its own had its gesture taken by the browser and cancelled. The grip is
    // where the claim is made (`touch-action: none`), and gating touch on it is
    // also what stops a tap that drifted five pixels from reordering the board.
    await run('a finger drags a tab from its grip, and from nowhere else', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();

        /**
         * Press with a finger and move far enough to pass the drag threshold,
         * reporting whether the tab came off the strip. Always cancels, so no
         * document listener outlives the case.
         * @param {any} from - The element the finger lands on.
         * @returns {boolean} Whether a drag started.
         */
        const swipe = (from) => {
          const rest = from.getBoundingClientRect();
          const x = rest.left + rest.width / 2;
          const y = rest.top + rest.height / 2;
          from.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, pointerType: 'touch', button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true,
          }));
          document.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1, buttons: 1, clientX: x + 60, clientY: y, bubbles: true,
          }));
          const lifted = !!shell.querySelector('.drag-ghost');
          document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
          return lifted;
        };

        const first = shell.querySelector('.pinboard-tab');
        assert(!swipe(first.querySelector('.pinboard-tab__button')),
          'a finger on the tab is a tap or a scroll; taking it for a reorder would move the board on every drifting tap');
        assert(swipe(first.querySelector('.pinboard-tab__grip')),
          'and on the grip it is a reorder — the one element that claims the gesture, and so the only one the browser does not cancel');
      } finally {
        teardown();
      }
    });

    await run('arrow keys move focus and Enter selects', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        const tabs = shell.querySelectorAll('.pinboard-tab__button');
        tabs[0].focus();
        tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert(document.activeElement === tabs[1],
          'ArrowRight moves focus along the strip without selecting');
        assert(bodyText(shell) === 'probe:alpha', 'focus alone must not change the mounted pin');
        tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert(bodyText(shell) === 'probe:beta', 'Enter activates the focused tab');
      } finally {
        teardown();
      }
    });

    await run('Alt+Arrow reorders the shared board', async () => {
      const { shell, server, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        const first = shell.querySelector('.pinboard-tab__button');
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
        await settle();
        assert(server.board.map((p) => p.id).join(',') === 'pin_b,pin_a',
          `the move must reach the shared board, got ${server.board.map((p) => p.id).join(',')}`);
        assert(tabLabels(shell).join(',') === 'beta,alpha', 'the strip must follow the board');
        assert(bodyText(shell) === 'probe:alpha', 'reordering must not change which pin is being read');
      } finally {
        teardown();
      }
    });

    await run('closing a tab removes the pin and lands on its neighbour', async () => {
      const { shell, server, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        shell.querySelector('.pinboard-tab__remove').click();
        await settle();
        assert(server.board.length === 1 && server.board[0].id === 'pin_b',
          'a tab close removes the pin from the shared board, not just this viewer');
        assert(pinboardView.getActivePinId() === 'pin_b',
          'the tab to the right takes over from the one that went');
        assert(bodyText(shell) === 'probe:beta', 'and its body is what is now mounted');
      } finally {
        teardown();
      }
    });

    await run('another viewer removing the active pin lands on the survivor', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.open();
        pinboardView.setActivePin('pin_b');
        wsService._emit('pinboard-changed',
          { board: 'main', pins: [{ id: 'pin_a', type: 'probe', config: { label: 'alpha' } }] });
        assert(pinboardView.getActivePinId() === 'pin_a',
          'a remote removal must select the nearest surviving tab, not the empty state');
        assert(bodyText(shell) === 'probe:alpha', 'and mount it');
      } finally {
        teardown();
      }
    });

    await run('an agent reveal opens the requested pin for a viewer following its conversation', async () => {
      const { teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        composerHasText = false;
        pinboardView.close();
        wsService._emit('pinboard-reveal',
          { board: 'main', pin: 'pin_b', from: 'conversation-one' });
        assert(pinboardView.isOpen(), 'the reveal should open the docked board');
        assert(pinboardView.getActivePinId() === 'pin_b', 'the reveal should select its pin');
      } finally {
        composerHasText = false;
        teardown();
      }
    });

    await run('an agent reveal does not interrupt another conversation or a draft', async () => {
      const { teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
        { id: 'pin_b', type: 'probe', config: { label: 'beta' } },
      ]);
      try {
        pinboardView.close();
        wsService._emit('pinboard-reveal',
          { board: 'main', pin: 'pin_b', from: 'conversation-two' });
        assert(!pinboardView.isOpen(), 'a different conversation must keep the board closed');

        composerHasText = true;
        wsService._emit('pinboard-reveal',
          { board: 'main', pin: 'pin_b', from: 'conversation-one' });
        assert(!pinboardView.isOpen(), 'a half-written message must keep the board closed');
      } finally {
        composerHasText = false;
        teardown();
      }
    });

    await run('a pin whose provider is gone keeps a closable placeholder', async () => {
      const { shell, server, teardown } = await mountShell([
        { id: 'pin_x', type: 'nobody/owns-this', config: { keep: 'me' } },
      ]);
      try {
        pinboardView.open();
        const text = bodyText(shell);
        assert(text.includes('Nothing provides "nobody/owns-this".'),
          `the placeholder must name what is missing, got "${text}"`);
        assert(text.includes('until you remove it'),
          'and say the config is kept — re-enabling the extension must lose nothing');
        assert(tabLabels(shell).join(',') === 'nobody/owns-this',
          'the tab stays, labelled with the type nothing provides');
        shell.querySelector('.pinboard-tab__remove').click();
        await settle();
        assert(server.board.length === 0, 'the placeholder tab is closable');
      } finally {
        teardown();
      }
    });

    await run('an item type that throws is shown in its own place, with its error', async () => {
      const { shell, teardown } = await mountShell([{ id: 'pin_e', type: 'broken', config: {} }]);
      try {
        pinboardView.open();
        const text = bodyText(shell);
        assert(text.includes("Couldn't show this pin."), `expected the host's lead, got "${text}"`);
        assert(text.includes('probe failure'),
          'the underlying error text is never dropped, only led into');
      } finally {
        teardown();
      }
    });

    await run('the add picker lists what can be added, and adding pins it', async () => {
      const { shell, server, teardown } = await mountShell([]);
      try {
        pinboardView.open();
        shell.querySelector('.pinboard-tabbar__add').click();
        const picker = document.querySelector('.pinboard-add-picker');
        assert(!!picker, 'the + must open the picker');
        const rows = [...picker.querySelectorAll('.pinboard-add-picker__item')];
        assert(rows.some((r) => r.dataset.typeId === 'probe'),
          `the picker must offer the enabled types, got ${rows.map((r) => r.dataset.typeId).join(',')}`);
        /** @type {any} */ (rows.find((r) => r.dataset.typeId === 'probe')).click();
        await settle();
        assert(server.board.length === 1 && server.board[0].type === 'probe',
          'picking a type adds a pin of it');
        assert(pinboardView.getActivePinId() === server.board[0].id,
          'and the new pin is the one revealed');
        assert(!document.querySelector('.pinboard-add-picker'), 'the picker closes behind the pick');
      } finally {
        document.querySelector('.pinboard-add-picker')?.remove();
        teardown();
      }
    });

    await run('the add picker is one list, in the order the types asked for', async () => {
      const { shell, teardown } = await mountShell([]);
      try {
        pinboardView.open();
        shell.querySelector('.pinboard-tabbar__add').click();
        const picker = /** @type {any} */ (document.querySelector('.pinboard-add-picker'));
        const headings = [...picker.querySelectorAll('.category-header')];
        assert(headings.length === 0,
          `nothing is written over the list: it is short, it hangs from the + that opened it, and a heading there is furniture, got ${headings.length}`);

        const rows = [...picker.querySelectorAll('.pinboard-add-picker__item')];
        assert(rows[0]?.dataset.typeId === 'watcher',
          `the type that asked for the top of the list gets it, whatever order the registry loaded them in, got ${rows.map((/** @type {any} */ r) => r.dataset.typeId).join(',')}`);
        assert(rows[0]?.querySelector('.menu-item-name')?.textContent === 'Watch something…',
          'and is named for what choosing it does, since choosing it asks a question rather than adding a pin');
        assert(rows[1]?.dataset.typeId === 'probe',
          `the rest keep registration order, got ${rows.map((/** @type {any} */ r) => r.dataset.typeId).join(',')}`);
      } finally {
        document.querySelector('.pinboard-add-picker')?.remove();
        teardown();
      }
    });

    // A board in a window of its own goes when the conversation it is a view of
    // goes. The docked panel is not that: it is a guest in the main window and
    // follows whatever conversation is up, so the same event must leave it alone
    // — asking that window to close would take the whole app with it.
    await run('the docked panel outlives the conversation it was showing', async () => {
      const { teardown } = await mountShell([]);
      const originalClose = window.close;
      let closes = 0;
      window.close = () => { closes += 1; };
      try {
        fakeSession.emit('conversation:deleted');
        assert(closes === 0, 'the window the docked panel is in is the app, and it stays');
      } finally {
        window.close = originalClose;
        teardown();
      }
    });

    await run('a type already on the board is offered as a row that cannot be picked', async () => {
      // 'broken' is a singleton, so one on the board is all there can be.
      const { shell, server, teardown } = await mountShell([{ id: 'pin_b', type: 'broken', config: {} }]);
      try {
        pinboardView.open();
        shell.querySelector('.pinboard-tabbar__add').click();
        const picker = /** @type {any} */ (document.querySelector('.pinboard-add-picker'));
        const row = /** @type {any} */ (picker.querySelector('[data-type-id="broken"]'));
        assert(!!row, 'the row stays, so the list is the same list every time it opens');
        assert(row.getAttribute('aria-disabled') === 'true' && row.classList.contains('unavailable'),
          'and is dead: a click on it could not add anything, and a row that looks live and does nothing is worse than one that says it is spent');
        assert(!row.querySelector('.pinboard-add-picker__note'),
          'with nothing written beside it — being dead already says it is on the board');

        row.click();
        await settle();
        assert(server.board.length === 1, 'and clicking it adds nothing');
      } finally {
        document.querySelector('.pinboard-add-picker')?.remove();
        teardown();
      }
    });

    await run('a source is pinned once, and asking again reveals it', async () => {
      const { shell, server, teardown } = await mountShell([]);
      try {
        const first = await pinboardView.addSource({ kind: 'probe', label: 'alpha' });
        assert(!!first && first.type === 'probe',
          'the registry resolves a source to whichever type accepts it');
        pinboardView.setActivePin(null);
        const second = await pinboardView.addSource({ kind: 'probe', label: 'alpha' });
        assert(server.board.length === 1, 'pinning the same thing twice must not add a second pin');
        assert(second?.id === first?.id && pinboardView.getActivePinId() === first?.id,
          'the second attempt reveals the pin that already says it');
        assert(bodyText(shell) === 'probe:alpha', 'and the revealed pin is mounted');
      } finally {
        teardown();
      }
    });

    await run("a failed edit says so and leaves the board alone", async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_a', type: 'probe', config: { label: 'alpha' } },
      ]);
      try {
        pinboardView.open();
        const original = window.fetch;
        window.fetch = /** @type {any} */ (async () => ({ ok: false, status: 500, json: async () => ({ error: 'server said no' }) }));
        try {
          await pinboardView.remove('pin_a');
        } finally {
          window.fetch = original;
        }
        const status = shell.querySelector('.pinboard-panel__status');
        assert(!status.hidden && status.textContent.startsWith("Couldn't remove that pin."),
          `expected a lead above the error, got "${status.textContent}"`);
        assert(status.textContent.length > "Couldn't remove that pin.".length,
          'the underlying error must survive the lead');
        assert(tabLabels(shell).join(',') === 'alpha', 'a failed remove must not remove anything');
      } finally {
        teardown();
      }
    });

    await run('the item toolbar offers what the pin says, and nothing when it says nothing', async () => {
      actionsBehaviour = 'normal';
      const { shell, teardown } = await mountShell([
        { id: 'pin_act', type: 'actions', config: {} },
        { id: 'pin_p', type: 'probe', config: { label: 'alpha' } },
      ]);
      try {
        pinboardView.open();
        const buttons = () => [...shell.querySelectorAll('.pinboard-item-toolbar__action')]
          .map((b) => b.textContent);
        assert(buttons().join(',') === 'Open',
          `only the primary action gets a button of its own, got "${buttons().join(',')}"`);
        assert(!!shell.querySelector('.pinboard-item-toolbar__more'),
          'the rest wait behind the overflow');

        // The probe offers no actions at all: the region must not merely be empty,
        // it must not be there — an empty control strip reads as a broken one.
        pinboardView.setActivePin('pin_p');
        await settle();
        assert(buttons().length === 0 && !shell.querySelector('.pinboard-item-toolbar__more'),
          'a type with no actions gets no controls');
        assert(shell.querySelector('.pinboard-item-toolbar__actions').hidden,
          'and the actions region is hidden rather than left as an empty gap');
      } finally {
        teardown();
      }
    });

    await run('a toolbar action runs, and a failing one is reported without the error being lost', async () => {
      actionsBehaviour = 'normal';
      actionCalls.open = 0;
      actionCalls.refresh = 0;
      actionCalls.thrown = 0;
      const { shell, teardown } = await mountShell([{ id: 'pin_act', type: 'actions', config: {} }]);
      try {
        pinboardView.open();
        shell.querySelector('.pinboard-item-toolbar__action').click();
        assert(actionCalls.open === 1, 'the primary button runs its action');

        shell.querySelector('.pinboard-item-toolbar__more').click();
        const menu = document.querySelector('.juggler-context-menu');
        assert(!!menu, 'the overflow opens the shared menu');
        const rows = [...menu.querySelectorAll('.juggler-context-menu-item')]
          .map((r) => r.textContent);
        assert(rows.join(',') === 'Refresh,Copy path',
          `the overflow holds the non-primary actions in order, got "${rows.join(',')}"`);

        /** @type {any} */ ([...menu.querySelectorAll('.juggler-context-menu-item')]
          .find((r) => r.textContent === 'Copy path')).click();
        assert(actionCalls.thrown === 1, 'an overflow row runs its action');
        const status = shell.querySelector('.pinboard-panel__status');
        assert(!status.hidden && status.textContent.startsWith("Couldn't copy path."),
          `an action that throws is led into, got "${status.textContent}"`);
        assert(status.textContent.includes('clipboard said no'),
          'and the underlying error survives the lead');
      } finally {
        document.querySelector('.juggler-context-menu')?.remove();
        teardown();
      }
    });

    await run('a pin that names a file is titled by the path, with the file controls beside it', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_path', type: 'path', config: { path: '/proj/src/main.go' } },
      ]);
      try {
        pinboardView.open();
        const title = shell.querySelector('.pinboard-item-toolbar__title');
        assert(title.textContent === '/proj/src/main.go',
          `the toolbar says the file, not a name above it, got "${title.textContent}"`);
        assert(title.classList.contains('pinboard-item-toolbar__title--path'),
          'and says it in the treatment a path gets');
        assert(title.querySelector('.pinboard-item-toolbar__name').textContent === 'main.go',
          'the name is its own element, so a narrow board ellipses the directories and not it');
        assert(title.querySelector('.pinboard-item-toolbar__dir').textContent === '/proj/src/',
          'and the directories are the part that may go');
        assert(title.dataset.filePath === '/proj/src/main.go',
          'the path is exposed for the app-wide right-click Open/Reveal/Copy menu');
        assert(shell.querySelector('.pinboard-item-toolbar__subtitle').hidden,
          'a described subtitle gives way to the path rather than sitting under it');

        // The same three controls, in the same order, as any path row elsewhere:
        // a pin that names a file should not have its own way of opening one.
        const group = shell.querySelector('.pinboard-item-toolbar__actions .properties-panel-filepath-actions');
        assert(!!group, 'the shared file controls are offered for a pin that names a path');
        const hasThree = group.querySelectorAll('.properties-panel-filepath-btn').length === 2
          && !!group.querySelector('reveal-button');
        assert(hasThree, `expected open, copy and reveal, got "${group.innerHTML}"`);
        assert(group.firstElementChild.getAttribute('aria-label') === 'Open file',
          `opening the file comes first, got "${group.firstElementChild.getAttribute('aria-label')}"`);
      } finally {
        teardown();
      }
    });

    // The whole failure mode the file buttons had: opening a file that nothing
    // can open changes nothing on screen, so a button that silently swallowed
    // the error was indistinguishable from a dead one. On Linux with no
    // xdg-open, that was every press.
    await run('a file action that the OS refuses says so, in its own words', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_path', type: 'path', config: { path: '/proj/src/main.go' } },
      ]);
      const realFetch = window.fetch;
      try {
        pinboardView.open();
        window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
          if (String(url).includes('/api/ops/call')) {
            return { ok: false, status: 500, text: async () => 'xdg-open: executable file not found' };
          }
          return realFetch(url, opts);
        });

        const openButton = shell.querySelector(
          '.pinboard-item-toolbar__actions .properties-panel-filepath-actions .properties-panel-filepath-btn'
        );
        assert(openButton.getAttribute('aria-label') === 'Open file', 'the first control opens the file');
        openButton.click();
        // The press hands the path to the op, hears the refusal and only then
        // raises the notice, so there is no single tick to wait for. A timeout
        // is swallowed so the assertion below reports the absent notice, which
        // says what was actually wanted.
        await waitFor(() => !!document.querySelector('modal-dialog'), {
          description: 'the refused open to be reported',
        }).catch(() => {});

        const notice = document.querySelector('modal-dialog');
        assert(!!notice, 'a refused open must be reported, not swallowed');
        const text = notice.textContent || '';
        assert(text.includes("Couldn't open that file."),
          `with a plain-English lead, got "${text}"`);
        // Never in place of it: the lead says what failed, and only the OS knows
        // why. Dropping its words leaves nobody able to act on the message.
        assert(text.includes('xdg-open'),
          `and the underlying error kept beneath it, got "${text}"`);
      } finally {
        window.fetch = realFetch;
        document.querySelector('modal-dialog')?.remove();
        teardown();
      }
    });

    await run('removing the last pin takes its name away with it', async () => {
      const { shell, teardown } = await mountShell([
        { id: 'pin_only', type: 'probe', config: { label: 'Only tab' } },
      ]);
      try {
        pinboardView.open();
        const toolbar = shell.querySelector('.pinboard-item-toolbar');
        const title = shell.querySelector('.pinboard-item-toolbar__title');
        const subtitle = shell.querySelector('.pinboard-item-toolbar__subtitle');
        assert(title.textContent === 'Only tab',
          `the toolbar should start out naming the pin, got "${title.textContent}"`);

        await pinboardView.remove('pin_only');
        await settle();

        assert(shell.querySelector('.pinboard-empty__line').textContent === 'Nothing pinned.',
          'an empty board shows the empty state');
        // Both halves matter. The toolbar carries an author `display: flex`, so
        // `hidden` alone leaves it on screen — name, divider and all — sitting
        // above the "Nothing pinned." it contradicts.
        assert(toolbar.hidden, 'the item toolbar is hidden once nothing is pinned');
        assert(getComputedStyle(toolbar).display === 'none',
          `and is actually off the screen, got display: ${getComputedStyle(toolbar).display}`);
        assert(toolbar.getBoundingClientRect().height === 0,
          `so it takes no room above the empty state, got ${toolbar.getBoundingClientRect().height}`);
        assert(title.textContent === '',
          `the removed pin's name must not be left behind, got "${title.textContent}"`);
        assert(subtitle.textContent === '',
          `nor its subtitle, got "${subtitle.textContent}"`);
        assert(!('filePath' in title.dataset),
          'nor its path, which would arm the right-click menu for a pin that has gone');
      } finally {
        teardown();
      }
    });

    await run('an icon action is a button of its own, and turns while it works', async () => {
      pathCalls.refreshes = 0;
      pathCalls.finish = null;
      const { shell, teardown } = await mountShell([
        { id: 'pin_path', type: 'path', config: { path: '/proj/src/main.go' } },
      ]);
      try {
        pinboardView.open();
        const button = shell.querySelector('.pinboard-item-toolbar__action--icon');
        assert(!!button, 'an action naming an icon is drawn as one');
        assert(button.textContent === '' && !!button.querySelector('svg'),
          `a glyph replaces the words rather than joining them, got "${button.textContent}"`);
        assert(button.getAttribute('aria-label') === 'Refresh' && button.title === 'Refresh',
          'the label stays, as the tooltip and to a screen reader');

        button.click();
        assert(pathCalls.refreshes === 1, 'the icon button runs its action');
        assert(button.classList.contains('is-spinning'),
          'and turns while it is running, since a card that has not changed yet looks identical');
        button.click();
        assert(pathCalls.refreshes === 1,
          'a second press while it is still working is ignored rather than queued');

        pathCalls.finish();
        await settle();
        assert(!button.classList.contains('is-spinning'), 'and it stops when the work does');

        // A picture in a menu of words says nothing, so an icon action is never
        // put behind the overflow — whatever it says about `primary`.
        shell.querySelector('.pinboard-item-toolbar__more').click();
        const rows = [...document.querySelectorAll('.juggler-context-menu-item')].map((r) => r.textContent);
        assert(rows.join(',') === 'Later',
          `the overflow holds only what has no picture, got "${rows.join(',')}"`);
      } finally {
        document.querySelector('.juggler-context-menu')?.remove();
        teardown();
      }
    });

    await run('a pin that cannot list its actions still shows its body', async () => {
      actionsBehaviour = 'throws';
      const { shell, teardown } = await mountShell([{ id: 'pin_act', type: 'actions', config: {} }]);
      try {
        pinboardView.open();
        assert(bodyText(shell) === 'actions body',
          `a broken toolbar must not cost the user the pin, got "${bodyText(shell)}"`);
        assert(shell.querySelectorAll('.pinboard-item-toolbar__action').length === 0,
          'and it simply offers no controls');

        // Half-built actions are dropped one at a time rather than taken as a set:
        // an action with no label or no behaviour is not a control.
        actionsBehaviour = 'rubbish';
        pinboardView.setActivePin(null);
        pinboardView.setActivePin('pin_act');
        await settle();
        const drawn = shell.querySelectorAll('.pinboard-item-toolbar__action').length;
        assert(drawn === 0 && !shell.querySelector('.pinboard-item-toolbar__more'),
          'an action missing a label or a run is not drawn');
      } finally {
        actionsBehaviour = 'normal';
        teardown();
      }
    });

    await run('the host tells a watching pin about file changes, in absolute paths', async () => {
      watcherCalls.changes.length = 0;
      watcherCalls.unsubscribes = 0;
      const { shell, teardown } = await mountShell([{ id: 'pin_w', type: 'watcher', config: {} }]);
      try {
        pinboardView.open();
        assert(bodyText(shell) === 'watching', 'the watching pin is mounted');

        // The watcher reports paths relative to the project it is rooted at.
        // Resolving that is the host's job: a pin holds a path and wants to know
        // whether it is the one that moved.
        wsService._emit('file-change', [
          { path: 'src/main.go', event: 'write' },
          { path: '/elsewhere/absolute.txt', event: 'remove' },
        ]);
        assert(watcherCalls.changes.length === 2,
          `the pin hears the batch, got ${watcherCalls.changes.length}`);
        assert(watcherCalls.changes[0].path === '/tmp/probe-project/src/main.go',
          `a project-relative path arrives absolute, got "${watcherCalls.changes[0].path}"`);
        assert(watcherCalls.changes[1].path === '/elsewhere/absolute.txt',
          'and one that was already absolute is left alone');
        assert(watcherCalls.changes[0].event === 'write', 'the event survives the resolution');

        // A pin that goes away stops hearing about files, whether or not it
        // remembered to unsubscribe.
        pinboardView.setActivePin(null);
        await settle();
        watcherCalls.changes.length = 0;
        wsService._emit('file-change', [{ path: 'src/main.go', event: 'write' }]);
        assert(watcherCalls.changes.length === 0,
          'a torn-down pin is not still listening');
      } finally {
        teardown();
      }
    });

    await run('the surface stays away until something can fill it', async () => {
      // Nothing provides a pin and nothing is pinned: a toggle that opens an
      // empty board offering nothing to put in it is worse than no toggle.
      pinboardItemRegistry.reset();
      const bare = await mountShell([]);
      try {
        assert(bare.shell.hidden, 'with no item type and no pins, the board offers no way in');
        assert(bare.toggle.hidden,
          'and the header toggle goes with it — it lives outside the shell, so it is told');
        pinboardItemRegistry.registerClass(ProbePin, { extensionId: 'test' });
        document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));
        assert(!bare.shell.hidden, 'enabling an item type brings the surface back');
        assert(!bare.toggle.hidden, 'and the toggle with it');
      } finally {
        bare.teardown();
      }

      // A pin whose extension is gone still counts: the board is the only way
      // back to it.
      pinboardItemRegistry.reset();
      const orphaned = await mountShell([{ id: 'pin_x', type: 'gone', config: {} }]);
      try {
        assert(!orphaned.shell.hidden,
          'a board holding pins nothing can render must still be reachable');
      } finally {
        orphaned.teardown();
        pinboardItemRegistry.registerClass(ProbePin, { extensionId: 'test' });
        pinboardItemRegistry.registerClass(BrokenPin, { extensionId: 'test' });
        pinboardItemRegistry.registerClass(ActionsPin, { extensionId: 'test' });
        pinboardItemRegistry.registerClass(WatcherPin, { extensionId: 'test' });
      }
    });

    await run('the phone breakpoint gives the board the whole width', async () => {
      // A lane is wider than 36rem, so the phone rules never render in the test
      // page itself. A child iframe narrow enough to match the query, wearing the
      // same stylesheets, is the only place that CSS can be measured.
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;height:480px;border:0';
      document.body.appendChild(frame);
      try {
        const doc = /** @type {Document} */ (frame.contentDocument);
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((l) => l.outerHTML).join('');
        doc.open();
        doc.write(`<!doctype html><html><head>${links}</head><body style="margin:0"></body></html>`);
        doc.close();
        // Both sheets, and not just the one the panel's own rules live in: the
        // drawer's scrim and the z-index tokens every layer is ordered by are in
        // styles.css, and measuring before it lands reads every one of them as
        // `auto`.
        const deadline = Date.now() + budgetFor(4000);
        const loaded = (/** @type {string} */ name) => [...doc.styleSheets]
          .some((s) => (s.href || '').includes(name));
        while (!(loaded('components.css') && loaded('styles.css'))) {
          // Say so rather than measuring on: every geometry assertion below
          // reads `auto` without these, and reports a z-index mismatch for
          // what is really a stylesheet that never arrived.
          if (Date.now() > deadline) {
            throw new Error(
              `the probe document's stylesheets never loaded (components.css: ${loaded('components.css')}, styles.css: ${loaded('styles.css')})`
            );
          }
          await new Promise((r) => { setTimeout(r, 20); });
        }

        // Plain elements wearing the classes, not the custom elements: a child
        // document has its own registry and would never upgrade them.
        const host = doc.createElement('div');
        host.style.cssText = 'position:relative;width:360px;height:480px';
        host.innerHTML = '<div class="pinboard-panel"></div>'
          + '<button class="u-btn-icon-header pinboard-header-button"></button>'
          + '<button class="u-btn-icon-header pinboard-header-button" hidden></button>';
        doc.body.appendChild(host);

        const panel = /** @type {HTMLElement} */ (host.querySelector('.pinboard-panel'));
        const buttons = host.querySelectorAll('.pinboard-header-button');
        assert(Math.round(panel.getBoundingClientRect().width) === 360,
          `the phone board is full width, got ${panel.getBoundingClientRect().width}px`);
        assert(doc.defaultView?.getComputedStyle(buttons[0]).display !== 'none',
          'the toggle is the way in at every width, phone included');
        assert(doc.defaultView?.getComputedStyle(buttons[1]).display === 'none',
          'and [hidden] still puts it away, over .u-btn-icon-header’s own display');

        // The open drawer's scrim must cover the board. On a phone the board is
        // the full width of .app-main, so a scrim beneath it is a scrim nobody
        // can reach — and tapping "outside" the drawer lands on the board, which
        // has no way to dismiss it.
        const layers = doc.createElement('div');
        layers.className = 'app-main';
        layers.style.cssText = 'position:relative;width:360px;height:480px';
        layers.innerHTML = '<div class="sidebar-backdrop"></div><div class="pinboard-shell-stub"></div>';
        doc.body.classList.add('sidebar-open');
        doc.body.appendChild(layers);
        // A stand-in for <pinboard-shell>, which a child document never upgrades:
        // the same layer, declared after the scrim exactly as index.html does.
        const stub = /** @type {HTMLElement} */ (layers.querySelector('.pinboard-shell-stub'));
        stub.style.cssText = 'position:absolute;inset:0;z-index:var(--z-controls)';
        const backdrop = /** @type {HTMLElement} */ (layers.querySelector('.sidebar-backdrop'));
        const view = /** @type {Window} */ (doc.defaultView);
        const scrimZ = Number(view.getComputedStyle(backdrop).zIndex);
        const boardZ = Number(view.getComputedStyle(stub).zIndex);
        assert(scrimZ > boardZ,
          `an open drawer's scrim must sit above the board, got ${scrimZ} against ${boardZ}`);
      } finally {
        frame.remove();
      }
    });
  } finally {
    pinboardItemRegistry.reset();
    pinboardStore.reset();
    pinboardView.reset();
    __resetPopupManagerForTests();
  }

  return { passed, failed, errors };
}
