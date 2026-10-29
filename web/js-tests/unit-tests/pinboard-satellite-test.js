//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Detached pinboard tests — a board in a window of its own, on the one
 * conversation it was opened for.
 *
 * The two halves of that are what most of these cases are about: what the board
 * shows comes from its own URL and its own session, so nothing outside it can
 * move it and its owner going away costs it nothing; and the one thing it does
 * send back — a reveal — carries that conversation, because the window it is
 * going to has very likely moved on.
 *
 * The mode is normally decided by the URL the document was loaded with, which a
 * test lane cannot choose, so `__setViewModeForTests` supplies the query string
 * instead. Every case restores it, because a lane that stayed in pinboard mode
 * would quietly reshape every suite that ran after it.
 *
 * The CSS half cannot be asserted in the lane either — `data-view` is on the
 * lane's own `<html>` and setting it there would restyle the harness — so the
 * layout rules are measured in a child iframe wearing the same stylesheets, the
 * way the shell suite measures the phone breakpoint.
 * @module unit-tests/pinboard-satellite-test
 */

import { assert, styledProbeFrame, waitFor, nextTask } from '../utilities/test-helpers.js';
import pinboardStore from '../../js/services/pinboard-store.js';
import pinboardView from '../../js/services/pinboard-view.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import wsService from '../../js/services/websocket.js';
import { ownerLink, satelliteLink, frameHintOf } from '../../js/services/pinboard-link.js';
import { isMac } from '../../js/services/key-shortcut-manager.js';
import { __resetPopupManagerForTests, isAnyPopupOpen } from '../../js/utils/popup-manager.js';
import {
  __setViewModeForTests, isPinboardView, ownerViewerId, initialPinId, boardConversationId,
  windowRole,
} from '../../js/utils/view-mode.js';
import { scopedKey, __resetPrefsForTests } from '../../js/services/prefs.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-shell.js';
import '../../js/components/conversation-bar.js';
import '../../js/components/conversation-tab.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { t, isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * A pin that exists only here, so the board has something it could show. Its tab
 * label names the conversation it was described against, which is how a case
 * proves the owner's snapshot reached the item type rather than stopping at the
 * panel.
 */
class SatelliteProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'satellite-probe',
    name: 'Satellite probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
    group: 'project',
  };

  describe(config, active) {
    return { title: `${config.label || 'Probe'}@${active?.conversation?.id || 'none'}` };
  }

  mount(container, pinContext) {
    container.textContent = `probe:${pinContext.pin.config.label || ''}`;
    lastPinContext = pinContext;
    return { teardown: () => {} };
  }
}

/**
 * A pin shaped like the Plan pin: it looks for a context item and offers an
 * action that is dim until it finds one. It exists to catch the toolbar going
 * stale — the body and the action are two views of the same lookup, and a board
 * window is where they come apart, because it mounts against a conversation this
 * viewer has never read.
 */
class RevealProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'reveal-probe',
    name: 'Reveal probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    group: 'project',
  };

  mount(container, pinContext) {
    /** @type {any} */
    let found = null;
    const render = () => {
      found = pinContext.services.contextItems.find('plan');
      container.textContent = found ? 'a plan' : 'no plan';
    };
    const stopWatching = pinContext.services.contextItems.onChange(render);
    render();
    return {
      teardown: () => stopWatching(),
      getActions: () => [{
        id: 'reveal',
        label: 'Reveal in conversation',
        primary: true,
        disabled: !found,
        run: () => pinContext.services.contextItems.reveal(found?.source?.threadId ?? null, found?.source?.itemId ?? null),
      }],
    };
  }
}

/**
 * The context the probe pin was last mounted with, so a case can call a host
 * service exactly as an item type would.
 * @type {any}
 */
let lastPinContext = null;

/**
 * A session with just enough of one for the board to come up, and a real
 * subscriber list so a case can move the conversation the way the app does.
 *
 * It knows more than one conversation, because that is the difference a
 * detached board turns on: the one it is a view of is not the one this viewer
 * has open.
 * @param {object} [options] - What this session should claim.
 * @param {any} [options.conversation] - The visible conversation.
 * @param {any[]} [options.conversations] - Others it holds but is not showing.
 * @param {(id: string) => Promise<void>} [options.load] - What `ensureConversationLoaded` waits on, per conversation.
 * @returns {any} The session, with its own spies.
 */
function makeSession({ conversation = null, conversations = [], load } = {}) {
  /** @type {Set<(event: any) => void>} */
  const subscribers = new Set();
  /** @type {Map<string, any>} */
  const known = new Map();
  for (const conv of [conversation, ...conversations]) {
    if (conv) known.set(conv.id, conv);
  }
  return {
    projectPath: '/tmp/satellite-project',
    visible: conversation,
    known,
    loaded: /** @type {string[]} */ ([]),
    switched: /** @type {string[]} */ ([]),
    subscribe(/** @type {(event: any) => void} */ fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit(/** @type {string} */ type) {
      for (const fn of [...subscribers]) fn({ type });
    },
    getVisibleConversation() {
      return this.visible;
    },
    getConversation(/** @type {string} */ id) {
      return this.known.get(id) || null;
    },
    async ensureConversationLoaded(/** @type {string} */ id) {
      this.loaded.push(id);
      if (load) await load(id);
    },
    switchConversation(/** @type {string} */ id) {
      this.switched.push(id);
      const conv = this.known.get(id);
      if (!conv) return false;
      this.visible = conv;
      this.emit('conversation:switched');
      return true;
    },
  };
}

/**
 * A conversation with the little of one the compose path needs: a thread to be
 * about, no tab in this window, and a record of what it was asked to send. No tab
 * is the interesting half — it is how the owner discovers it has no box to put the
 * text in, and the send it falls back to is then the observable thing.
 * @param {string} id - The conversation's id.
 * @returns {any} The conversation, with a `sent` list on it.
 */
function makeComposeConversation(id) {
  /** @type {{text: string, thread: string|null, options: any}[]} */
  const sent = [];
  const conversation = {
    id,
    name: 'Board conv',
    sent,
    sendMessage: async (/** @type {string} */ text, /** @type {string|null} */ thread,
      /** @type {any} */ _messageThread, /** @type {any} */ options) => {
      sent.push({ text, thread, options });
      return null;
    },
  };
  /** @type {any} */
  const root = { threadItemId: null, conversation };
  /** @type {any} */
  const child = { threadItemId: 'thread_7', conversation };
  return Object.assign(conversation, {
    rootMessageThread: root,
    resolveMessageThread: (/** @type {string|null} */ threadItemId) => {
      if (!threadItemId) return root;
      if (threadItemId === 'thread_7') return child;
      throw new Error(`no such thread: ${threadItemId}`);
    },
  });
}

/** The conversation a detached board in these cases is a view of. */
const BOARD_CONVERSATION = 'conv_board';

/** The board a detached window in these cases is — its own arrangement of tabs. */
const BOARD_ID = 'board_detached';

/**
 * That window's URL: the mode, the window to report to, the board it is, and
 * what it is a view of.
 */
const BOARD_SEARCH =
  `?view=pinboard&owner=v_owner&board=${BOARD_ID}&conversation=${BOARD_CONVERSATION}`;

/**
 * A session that holds the board's conversation without showing it — a board is
 * a second view of a conversation, never the session's own opinion of which one
 * is open.
 * @param {object} [options] - Passed through to makeSession.
 * @param {any} [options.conversation] - The visible conversation.
 * @param {(id: string) => Promise<void>} [options.load] - The load gate.
 * @returns {any} The session.
 */
function makeBoardSession({ conversation = null, load } = {}) {
  return makeSession({
    conversation,
    conversations: [{ id: BOARD_CONVERSATION, name: 'Board conversation' }],
    load,
  });
}

/**
 * A conversation with a context-item chain the case writes into, so it can say
 * when the transcript the board is reading gains a plan.
 * @param {string} id - The conversation's id.
 * @returns {any} The conversation, with an `addPlan`.
 */
function makeConversation(id) {
  /** @type {any[]} */
  const contextItems = [];
  return {
    id,
    name: id,
    addPlan() {
      contextItems.push({ id: 'ci_plan', type: 'plan', data: { title: 'Ship it', steps: [] } });
    },
    /**
     * @param {string|null} threadId - The thread wanted; only the root exists here.
     * @returns {any} That thread's items and context items.
     */
    resolveMessageThread(threadId) {
      if (threadId) throw new Error('not a thread item');
      return { contextItems, items: [] };
    },
  };
}

/**
 * Conversation loads the case decides when to finish, one per conversation, so
 * a case can state the order two of them come back in rather than hope for it.
 * @returns {{hold: (id: string) => Promise<void>, release: (id: string) => void}} The gates.
 */
function makeLoadGates() {
  /** @type {Map<string, () => void>} */
  const releases = new Map();
  return {
    hold: (id) => new Promise((resolve) => { releases.set(id, /** @type {any} */ (resolve)); }),
    release: (id) => { releases.get(id)?.(); },
  };
}

/**
 * Stand in for the relay: record everything this viewer sends, and let a case
 * deliver what the other end would have sent back.
 * @returns {{sent: {to: string, kind: string, body: any}[], deliver: (from: string, kind: string, body?: any) => void, restore: () => void}} The stub.
 */
function stubRelay() {
  const original = wsService.relayTo;
  /** @type {{to: string, kind: string, body: any}[]} */
  const sent = [];
  wsService.relayTo = /** @type {any} */ ((/** @type {string} */ to, /** @type {any} */ payload) => {
    sent.push({ to, kind: payload?.kind, body: payload?.body });
    return true;
  });
  return {
    sent,
    deliver: (from, kind, body) => {
      wsService._emit('viewer-relay', { from, payload: { channel: 'pinboard', kind, body } });
    },
    restore: () => { wsService.relayTo = original; },
  };
}

/**
 * Deliver the session frame that tells this viewer its own address, in the order
 * the transport does it: the id is recorded, then the frame is announced.
 *
 * This is the moment the real page always has and the tests otherwise never do —
 * a mounted board learning its id afterwards, rather than being handed one
 * before it was built.
 * @param {string} id - The id the server took, or '' for a viewer it would not address.
 * @returns {void}
 */
function announceViewerId(id) {
  wsService.viewerId = id;
  wsService._emit('session', { type: 'session', clientId: 'c_self', viewerId: id });
}

/**
 * Say whether this page is a native desktop-app window, the way the host does —
 * the flag it bakes onto <html> before the page paints. A test lane is a browser
 * tab, so anything gated on the desktop has to be told otherwise.
 * @param {boolean} on - Whether to be a desktop window.
 * @returns {void}
 */
function asDesktopWindow(on) {
  if (on) document.documentElement.dataset.windowMode = '1';
  else delete document.documentElement.dataset.windowMode;
}

/**
 * A conversation tab that records what it was asked to reveal, standing where
 * the real one stands so `document.querySelector` finds it. Its id is the one
 * the real tabs carry, so a reveal that waits for a conversation's column to
 * come up finds this one.
 * @param {string} [conversationId] - The conversation whose column this is.
 * @returns {{el: any, threads: (string|null)[], items: string[], remove: () => void}} The tab.
 */
function stubActiveTab(conversationId = 'conv_main') {
  const el = /** @type {any} */ (document.createElement('conversation-tab'));
  el.id = `conversation-tab-${conversationId}`;
  el.classList.add('active');
  /** @type {(string|null)[]} */
  const threads = [];
  /** @type {string[]} */
  const items = [];
  el.revealThread = (/** @type {string|null} */ id) => { threads.push(id); };
  el.revealItem = (/** @type {string} */ id) => { items.push(id); };
  document.body.appendChild(el);
  return { el, threads, items, remove: () => el.remove() };
}

/**
 * A fetch stub answering only the board's own URLs, and delegating everything
 * else — including the harness's result POST — to the real one.
 *
 * `left` is what the server says was open when it was last shut, and it is
 * handed over once: the real one answers the claim once too, because the answer
 * is an instruction to open windows and every main window asks.
 *
 * It answers this window's own preferences too, since a board window keeps which
 * tab it was showing there, and a case that fell through to the real server would
 * write that into the test server's session for the next suite to find. A read is
 * held until `prefsGate` settles, so a case can decide what arrives first.
 * @param {any[]} pins - The board the fake server holds.
 * @param {any[]} [left] - The detached boards outliving the last run.
 * @param {Record<string, any>} [prefs] - This window's stored preferences.
 * @param {Promise<void>} [prefsGate] - What a preferences read waits for.
 * @returns {{urls: string[], prefWrites: any[], restore: () => void}} The URLs
 *   asked for, the preference patches written, and its restore.
 */
function stubBoard(pins, left = [], prefs = {}, prefsGate = Promise.resolve()) {
  const original = window.fetch;
  /** @type {string[]} */
  const urls = [];
  /** @type {any[]} */
  const prefWrites = [];
  let claimed = false;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
    const asked = String(url);
    if (asked.includes('/api/session/ui-prefs')) {
      urls.push(asked);
      if (opts?.method === 'PUT') {
        const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
        prefWrites.push(body?.ui ?? {});
        return { ok: true, json: async () => ({}) };
      }
      await prefsGate;
      return { ok: true, json: async () => ({ ui: prefs }) };
    }
    if (asked.includes('/api/session/pinboard')) {
      urls.push(asked);
      if (asked.includes('/boards/restore')) {
        const boards = claimed ? [] : left;
        claimed = true;
        return { ok: true, json: async () => ({ boards }) };
      }
      return { ok: true, json: async () => ({ pins }) };
    }
    return original(url, opts);
  });
  return { urls, prefWrites, restore: () => { window.fetch = original; } };
}

/**
 * Put a shell in the document in one of the two modes, with the relay stubbed
 * and this viewer given an id something could address it by.
 *
 * Every piece of shared state this touches — the view mode, the two links, the
 * board, `fetch`, `wsService.viewerId` — is put back by the returned teardown,
 * which the caller must drain in a `finally`. A lane left in pinboard mode, or
 * holding a live `ownerLink` subscription, reshapes every suite that runs after
 * it.
 * @param {object} options - How to mount it.
 * @param {any[]} [options.pins] - The board the fake server holds.
 * @param {string} [options.search] - The query string deciding the mode.
 * @param {string} [options.viewerId] - What this viewer's own id is.
 * @param {any} [options.session] - The session to hand the shell.
 * @param {any[]} [options.left] - The detached boards the server says outlived the last run.
 * @param {Record<string, any>} [options.prefs] - This window's stored preferences.
 * @param {Promise<void>} [options.prefsGate] - What a read of them waits for.
 * @returns {Promise<{shell: any, panel: any, session: any, relay: any, board: any, teardown: () => void}>} The mounted shell.
 */
async function mountShell({
  pins = [], search = BOARD_SEARCH, viewerId = 'v_self', session, left, prefs, prefsGate,
} = {}) {
  pinboardStore.reset();
  pinboardView.reset();
  ownerLink.reset();
  satelliteLink.reset();
  forgetRememberedPins();
  __setViewModeForTests(search);
  const board = stubBoard(pins, left, prefs, prefsGate);
  const relay = stubRelay();
  const previousViewerId = wsService.viewerId;
  wsService.viewerId = viewerId;
  const theSession = session || makeBoardSession();
  const shell = /** @type {any} */ (document.createElement('pinboard-shell'));
  document.body.appendChild(shell);
  shell.setSession(theSession);
  await nextTask();
  return {
    shell,
    panel: shell.querySelector('pinboard-panel'),
    session: theSession,
    relay,
    board,
    teardown: () => {
      shell.remove();
      relay.restore();
      board.restore();
      wsService.viewerId = previousViewerId;
      ownerLink.reset();
      satelliteLink.reset();
      __setViewModeForTests();
      pinboardStore.reset();
      pinboardView.reset();
      forgetRememberedPins();
      lastPinContext = null;
    },
  };
}

/** The window preference a board window keeps its showing tab under. */
const ACTIVE_PREF = 'juggler-pinboard-active';

/**
 * Forget every window's remembered tab, in the prefs cache and in its
 * localStorage mirror, so no case opens on a tab an earlier one chose.
 * @returns {void}
 */
function forgetRememberedPins() {
  __resetPrefsForTests();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(ACTIVE_PREF)) localStorage.removeItem(key);
  }
}

/**
 * Put a shell in the document as a detached board.
 * @param {any[]} pins - The board the fake server holds.
 * @returns {Promise<{shell: any, teardown: () => void}>} The mounted shell.
 */
async function mountDetached(pins) {
  return mountShell({ pins });
}

/** A board with two probe pins on it, so a case can seed a detach with one. */
const PROBE_BOARD = [
  { id: 'pin_a', type: 'satellite-probe', config: { label: 'alpha' } },
  { id: 'pin_b', type: 'satellite-probe', config: { label: 'beta' } },
];

/** A board holding the pin that reads a context item and offers a way back to it. */
const REVEAL_BOARD = [{ id: 'pin_reveal', type: 'reveal-probe', config: {} }];

/**
 * Stand in for the browser's window opener, so a case can read the URL a detach
 * asked for — and how it asked — without anything appearing.
 * @param {object} [options] - How the browser behaves.
 * @param {boolean} [options.blocked] - Whether it refuses to open anything.
 * @returns {{urls: string[], calls: any[][], handles: any[], restore: () => void}} The stub.
 */
function stubWindowOpen({ blocked = false } = {}) {
  const original = window.open;
  /** @type {string[]} */
  const urls = [];
  /** @type {any[][]} */
  const calls = [];
  /** @type {any[]} */
  const handles = [];
  window.open = /** @type {any} */ ((/** @type {any} */ ...args) => {
    urls.push(String(args[0]));
    calls.push(args);
    if (blocked) return null;
    const handle = { closed: false, close() { this.closed = true; } };
    handles.push(handle);
    return handle;
  });
  return { urls, calls, handles, restore: () => { window.open = original; } };
}

/**
 * The tab labels the board is showing.
 * @param {any} shell - The mounted shell.
 * @returns {(string|null)[]} One label per tab.
 */
function tabLabels(shell) {
  return [...shell.querySelectorAll('.pinboard-tab__label')].map((/** @type {any} */ el) => el.textContent);
}

/**
 * Open the board in the ordinary view, with the overlay layer in a known state.
 *
 * An open board claims that layer, and a case that had one open earlier can
 * leave the layer still claimed — the pool shares one JS realm across a lane's
 * tests. Clearing it first, then letting the deferred sentinel release settle,
 * is what makes "the board is open" a fact this case established rather than one
 * the previous case is still undoing.
 * @returns {Promise<void>}
 */
async function openBoard() {
  __resetPopupManagerForTests();
  await nextTask();
  pinboardView.open();
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
 * A child document wearing the app's stylesheets, so layout rules keyed off
 * `data-view` can be measured without restyling the lane.
 * @param {number} width - The frame's width in px.
 * @returns {Promise<{doc: Document, frame: HTMLIFrameElement}>} The child document.
 */
async function styledFrame(width) {
  return styledProbeFrame(width, 600);
}

/**
 * Run the detached-board tests.
 * @returns {Promise<TestResult>} Tally of passed/failed tests.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What the case asserts.
   * @param {() => Promise<void>|void} fn - The case.
   * @returns {Promise<void>}
   */
  async function run(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Registries are shared across lanes, so the probe is registered against a
  // known-empty one rather than whatever the previous suite left behind.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(SatelliteProbePin, { extensionId: 'test' });
  pinboardItemRegistry.registerClass(RevealProbePin, { extensionId: 'test' });

  try {
    await run('the mode is read from the query, and junk ids are not ids', () => {
      try {
        __setViewModeForTests('?view=pinboard&owner=v_owner&pin=pin_seed&conversation=conv_seed');
        assert(isPinboardView(), 'view=pinboard is a pinboard view');
        assert(ownerViewerId() === 'v_owner', `owner read as ${ownerViewerId()}`);
        assert(initialPinId() === 'pin_seed', `pin read as ${initialPinId()}`);
        assert(boardConversationId() === 'conv_seed', `conversation read as ${boardConversationId()}`);

        __setViewModeForTests('?view=pinboard&owner=not%20an%20id&pin=../etc&conversation=../etc');
        assert(ownerViewerId() === '', 'an owner id that is not one is no owner at all');
        assert(initialPinId() === '', 'and the same for the pin');
        assert(boardConversationId() === '', 'and for the conversation');

        __setViewModeForTests('?view=something-else&conversation=conv_seed');
        assert(!isPinboardView(), 'an unknown view is the ordinary one');
        assert(ownerViewerId() === '', 'which has no owner');
        assert(boardConversationId() === '',
          'and is not stuck to a conversation: the ordinary window follows the user');

        __setViewModeForTests('');
        assert(!isPinboardView(), 'and so is no view at all');
      } finally {
        __setViewModeForTests();
      }
    });

    // A window's own preferences are kept under its role, so this string has to
    // be the one both Go sides use (core.WindowRolePinboardFor, and
    // windowOpts.role() in the desktop app). Get it wrong and a board writes its
    // preferences into one slot and reads another back, which is invisible until
    // the next launch.
    await run('a window knows which window it is', () => {
      try {
        __setViewModeForTests('');
        assert(windowRole() === 'main', `the ordinary window is ${windowRole()}`);

        __setViewModeForTests('?view=pinboard&board=board_a');
        assert(windowRole() === 'pinboard:board_a', `a board is ${windowRole()}`);

        __setViewModeForTests('?view=pinboard&board=board_b');
        assert(windowRole() === 'pinboard:board_b', 'two boards are two windows');

        __setViewModeForTests('?view=pinboard');
        assert(windowRole() === 'pinboard',
          'a board with no id named falls back to the shared slot rather than claiming the docked panel\u2019s');

        __setViewModeForTests('?view=pinboard&board=../etc');
        assert(windowRole() === 'pinboard', 'and so does one whose id is not an id');
      } finally {
        __setViewModeForTests();
      }
    });

    // Every document on the origin shares one localStorage, so a board that read
    // the same cell as the window it was opened from would keep being changed by
    // it. Desktop windows read the session first; this is what covers a board
    // opened as a browser tab, which has no session to write to.
    await run('a board caches its own window preferences, not the window\u2019s', () => {
      const previousProjectKey = window.__projectKey;
      try {
        window.__projectKey = 'proj1';
        __setViewModeForTests('');
        const main = scopedKey('juggler-pinboard-width');
        assert(main === 'juggler-pinboard-width:proj1',
          `the ordinary window keeps the plain key, got ${main}`);

        __setViewModeForTests('?view=pinboard&board=board_a');
        const boardA = scopedKey('juggler-pinboard-width');
        __setViewModeForTests('?view=pinboard&board=board_b');
        const boardB = scopedKey('juggler-pinboard-width');
        assert(boardA !== main, 'a board must not share the window\u2019s cell');
        assert(boardA !== boardB, `two boards shared one cell (${boardA})`);
      } finally {
        window.__projectKey = previousProjectKey;
        __setViewModeForTests();
      }
    });

    await run('a detached board is the panel and nothing else', async () => {
      const { shell, teardown } = await mountDetached([]);
      try {
        assert(shell.querySelector('pinboard-panel'), 'the panel is the whole point');
        assert(!shell.querySelector('.pinboard-scrim'),
          'there is no workspace behind it to dim');
        assert(!shell.querySelector('.pinboard-resize-handle'),
          'the window frame is the width control');
      } finally {
        teardown();
      }
    });

    await run('a detached board opens itself', async () => {
      const { teardown } = await mountDetached([]);
      try {
        assert(pinboardView.isOpen(), 'a window whose only content is closed shows nothing');
      } finally {
        teardown();
      }
    });

    await run('a detached board holds no popup token', async () => {
      __resetPopupManagerForTests();
      const { teardown } = await mountDetached([]);
      try {
        assert(pinboardView.isOpen(), 'the board is open');
        assert(!isAnyPopupOpen(),
          'an open detached board must not claim the popup layer: Escape would dismiss the window\u2019s only content');
      } finally {
        teardown();
        __resetPopupManagerForTests();
      }
    });

    await run('the chord does not toggle a detached board', async () => {
      const { teardown } = await mountDetached([]);
      try {
        document.dispatchEvent(chord());
        await nextTask();
        assert(pinboardView.isOpen(), 'the board that is the window stays');
      } finally {
        teardown();
      }
    });

    await run('a detached board builds no conversation tabs', async () => {
      const container = document.createElement('conversation-tabs-container');
      document.body.appendChild(container);
      const bar = /** @type {any} */ (document.createElement('conversation-bar'));
      try {
        __setViewModeForTests('?view=pinboard&owner=v_owner');
        bar._findTabsContainer();
        assert(bar._tabsContainer === null,
          'a detached board mirrors its owner\u2019s conversation; a tab here would be a second answer to which one that is');

        __setViewModeForTests();
        bar._findTabsContainer();
        assert(bar._tabsContainer === container,
          'and the ordinary view still finds the surface it builds tabs into');
      } finally {
        __setViewModeForTests();
        container.remove();
      }
    });

    await run('the reduced layout is CSS, so it lands on the first frame', async () => {
      const { doc, frame } = await styledFrame(900);
      try {
        doc.documentElement.dataset.view = 'pinboard';
        // Plain elements wearing the classes: a child document has its own
        // registry and would never upgrade the custom ones.
        const host = doc.createElement('div');
        host.style.cssText = 'position:relative;width:900px;height:600px';
        host.innerHTML = '<conversation-bar></conversation-bar>'
          + '<conversation-tabs-container></conversation-tabs-container>'
          + '<div class="pinboard-panel"></div>'
          + '<div class="pinboard-scrim"></div>'
          + '<header class="app-header">'
          + '<button class="sidebar-toggle-button"></button>'
          + '<div class="app-header__board-title">'
          + '<button class="app-header__board-conversation">Short</button>'
          + '<span class="app-header__board-kind">Pinboard</span>'
          + '</div>'
          + '<project-path-display></project-path-display>'
          + '<header-actions><update-button></update-button>'
          + '<div class="header-actions-controls">'
          // Grouped as index.html groups them, so hiding a control can never
          // be done by hiding the group the theme button shares.
          + '<div class="header-group header-group--view">'
          + '<button class="zoom-in-button"></button>'
          + '<button class="theme-button"></button>'
          + '</div>'
          + '<div class="header-group header-group--app">'
          + '<button class="settings-button"></button>'
          + '</div>'
          + '</div></header-actions>'
          + '</header>';
        doc.body.appendChild(host);

        const view = /** @type {Window} */ (doc.defaultView);
        const styleOf = (/** @type {string} */ sel) =>
          view.getComputedStyle(/** @type {Element} */ (host.querySelector(sel)));

        assert(styleOf('conversation-bar').display === 'none',
          'the conversation shell is not part of a detached board');
        assert(styleOf('.sidebar-toggle-button').display === 'none',
          'nor a toggle for a sidebar that is not there');
        assert(styleOf('project-path-display').display === 'none',
          'nor a project chip, since a board window navigates nothing');
        assert(styleOf('.settings-button').display === 'none'
          && styleOf('.zoom-in-button').display === 'none',
        'nor controls belonging to the window that opened it — even one grouped with the theme button');
        assert(styleOf('update-button').display === 'none',
          'nor an update pill, which is the app’s news and not this window’s');
        // Rendered, not merely un-hidden itself: a button whose group is hidden
        // still reports its own display.
        assert(/** @type {Element} */ (host.querySelector('.theme-button')).getClientRects().length > 0,
          'but the theme button stays: a board window is read where the window that opened it is not, and it is the one control that answers to that');
        assert(styleOf('.app-header').display !== 'none',
          'but the header itself stays: it is the window’s drag region, and on Windows and Linux it carries the only close button');
        assert(styleOf('.app-header__board-title').display === 'flex',
          'and what is left says what the window is and what it is showing, side by side');

        // The name is a control, and everything either side of it is the window's
        // drag region — so a short name must not leave a press of the empty
        // header landing on it.
        const boxOf = (/** @type {string} */ sel) =>
          /** @type {HTMLElement} */ (host.querySelector(sel)).getBoundingClientRect();
        const strip = boxOf('.app-header__board-title');
        const named = boxOf('.app-header__board-conversation');
        assert(named.width < strip.width / 2,
          `the name is as wide as the words, not as wide as the room: got ${Math.round(named.width)}px of ${Math.round(strip.width)}px`);
        assert(styleOf('conversation-tabs-container').display === 'none',
          'nor are its columns');
        assert(styleOf('.pinboard-scrim').display === 'none', 'nor the scrim');

        const panel = styleOf('.pinboard-panel');
        assert(panel.visibility === 'visible',
          'the panel is visible without the open class, because open is its only state');
        assert(panel.transform === 'none',
          'and it is not translated off the edge it no longer has');
        const width = /** @type {HTMLElement} */ (host.querySelector('.pinboard-panel'))
          .getBoundingClientRect().width;
        assert(Math.round(width) === 900, `the detached board takes the window, got ${width}px`);
      } finally {
        frame.remove();
      }
    });

    await run('a board window opens on the pin the user was reading', async () => {
      const { teardown } = await mountShell({
        pins: PROBE_BOARD,
        search: `${BOARD_SEARCH}&pin=pin_b`,
      });
      try {
        assert(pinboardView.getActivePinId() === 'pin_b',
          `the detach names the pin it was made from, and a board that never reads it opens on whichever tab comes first instead, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
      }
    });

    await run('a pin that has left the board since is a stale selection, not an error', async () => {
      const { teardown } = await mountShell({
        pins: PROBE_BOARD,
        search: `${BOARD_SEARCH}&pin=pin_since_removed`,
      });
      try {
        assert(pinboardView.getActivePinId() === 'pin_a',
          `the board is shared, so the pin can be gone by the time the window opens — the seed is advisory and the board falls back, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
      }
    });

    await run('the seed is spent on arrival, not held against a later board', async () => {
      const board = [
        ...PROBE_BOARD,
        { id: 'pin_c', type: 'satellite-probe', config: { label: 'gamma' } },
      ];
      const { teardown } = await mountShell({
        pins: board,
        search: `${BOARD_SEARCH}&pin=pin_c`,
      });
      try {
        assert(pinboardView.getActivePinId() === 'pin_c', 'the board opens where the user was reading');
        pinboardView.setActivePin('pin_a');

        // Someone else takes away the pin being read, the way a shared board does.
        wsService._emit('pinboard-changed',
          { board: BOARD_ID, pins: board.filter((pin) => pin.id !== 'pin_a') });
        await nextTask();
        assert(pinboardView.getActivePinId() === 'pin_b',
          `the tab that slid into its place — a seed still held would drag the user back to where the window opened, long after they had moved on, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
      }
    });

    // A board window reopened at launch is asked for with no pin, because the
    // window that reopens it has no idea what it was showing. The window does:
    // the tab is kept under its own role, the slot its frame and theme live in.
    await run('a reopened board window comes back on the tab it was showing', async () => {
      asDesktopWindow(true);
      const { panel, teardown } = await mountShell({
        pins: PROBE_BOARD,
        prefs: { [ACTIVE_PREF]: 'pin_b' },
      });
      try {
        await waitFor(() => pinboardView.getActivePinId() === 'pin_b',
          `the remembered tab, not the first one (got ${pinboardView.getActivePinId()})`);
        await waitFor(() => panel.textContent.includes('probe:beta'),
          'the panel to show the remembered pin');
      } finally {
        teardown();
        asDesktopWindow(false);
      }
    });

    await run('a board window remembers the tab the user moves to', async () => {
      asDesktopWindow(true);
      const { board, teardown } = await mountShell({ pins: PROBE_BOARD });
      try {
        await waitFor(() => pinboardView.getActivePinId() === 'pin_a', 'the board to open');
        pinboardView.setActivePin('pin_b');
        await waitFor(() => board.prefWrites.some((ui) => ui[ACTIVE_PREF] === 'pin_b'),
          `the choice to be written to this window's preferences, got ${JSON.stringify(board.prefWrites)}`);
        assert(board.urls.some((url) => url.includes(`role=${encodeURIComponent(`pinboard:${BOARD_ID}`)}`)),
          'under this board window\u2019s role, not the main window\u2019s');
      } finally {
        teardown();
        asDesktopWindow(false);
      }
    });

    await run('a board window opened on a pin shows that pin, whatever it remembers', async () => {
      asDesktopWindow(true);
      const { board, teardown } = await mountShell({
        pins: PROBE_BOARD,
        search: `${BOARD_SEARCH}&pin=pin_a`,
        prefs: { [ACTIVE_PREF]: 'pin_b' },
      });
      try {
        await waitFor(() => board.urls.some((url) => url.includes('/api/session/ui-prefs')),
          'the window to ask what it remembers');
        for (let i = 0; i < 5; i++) await nextTask();
        assert(pinboardView.getActivePinId() === 'pin_a',
          `a pop-out names the pin the user was reading, and that is newer than anything remembered, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
        asDesktopWindow(false);
      }
    });

    await run('a remembered tab that has left the board is a stale selection', async () => {
      asDesktopWindow(true);
      const { board, teardown } = await mountShell({
        pins: PROBE_BOARD,
        prefs: { [ACTIVE_PREF]: 'pin_since_removed' },
      });
      try {
        await waitFor(() => board.urls.some((url) => url.includes('/api/session/ui-prefs')),
          'the window to ask what it remembers');
        for (let i = 0; i < 5; i++) await nextTask();
        assert(pinboardView.getActivePinId() === 'pin_a',
          `the board falls back to its first tab, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
        asDesktopWindow(false);
      }
    });

    await run('a tab picked before the memory answers is not taken back', async () => {
      asDesktopWindow(true);
      /** @type {() => void} */
      let answer = () => {};
      const gate = new Promise((resolve) => { answer = () => resolve(undefined); });
      const { board, teardown } = await mountShell({
        pins: [...PROBE_BOARD, { id: 'pin_c', type: 'satellite-probe', config: { label: 'gamma' } }],
        prefs: { [ACTIVE_PREF]: 'pin_c' },
        prefsGate: /** @type {Promise<void>} */ (gate),
      });
      try {
        await waitFor(() => pinboardView.getActivePinId() === 'pin_a', 'the board to open');
        pinboardView.setActivePin('pin_b');
        answer();
        await waitFor(() => board.urls.some((url) => url.includes('/api/session/ui-prefs')),
          'the window to ask what it remembers');
        for (let i = 0; i < 5; i++) await nextTask();
        assert(pinboardView.getActivePinId() === 'pin_b',
          `a slow session must not move a user who has already chosen, got ${pinboardView.getActivePinId()}`);
      } finally {
        teardown();
        asDesktopWindow(false);
      }
    });

    await run('a board window says which conversation, and what kind of window it is', async () => {
      const slot = document.createElement('div');
      slot.id = 'board-title';
      document.body.appendChild(slot);
      /** @returns {string} The conversation the header names. */
      const shownConversation = () => slot.querySelector('.app-header__board-conversation')?.textContent || '';
      /** @returns {string} The tag the header names it with. */
      const nameTag = () => slot.querySelector('.app-header__board-conversation')?.tagName || '';
      asDesktopWindow(true);
      const { teardown, relay } = await mountShell({
        pins: PROBE_BOARD,
        search: `${BOARD_SEARCH}&pin=pin_a`,
      });
      try {
        // The board's own toolbar band does not say "Pinboard", so the header is
        // the one place saying what this window is — held at the far end, out of
        // the way of the name.
        assert(slot.querySelector('.app-header__board-kind')?.textContent === 'Pinboard',
          `the header must say what the window is, got ${JSON.stringify(slot.textContent)}`);
        await waitFor(() => shownConversation() === 'Board conversation',
          'the header to name the conversation this window is stuck to');
        assert(slot.firstElementChild?.className === 'app-header__board-conversation',
          'the conversation follows the logo: it is the window’s name, not a note beside a label');
        assert(slot.lastElementChild?.className === 'app-header__board-kind',
          'and what kind of window it is goes to the far end');

        // And it is the way back to that conversation: this window is a view of
        // it, and the whole of it is one window away.
        const name = /** @type {any} */ (slot.querySelector('.app-header__board-conversation'));
        assert(name.tagName === 'BUTTON',
          `the name is a control where there is an owner to ask, got <${name.tagName.toLowerCase()}>`);
        assert(name.getAttribute('aria-label') === 'Show this conversation in the main window',
          `whose label says which window it acts on, got ${JSON.stringify(name.getAttribute('aria-label'))}`);
        name.click();
        const sent = relay.sent.find((/** @type {any} */ m) => m.kind === 'select');
        assert(!!sent && sent.to === 'v_owner',
          `the ask goes to the window that opened this board, got ${JSON.stringify(relay.sent)}`);
        assert(sent.body?.conversation === BOARD_CONVERSATION,
          `naming this board's conversation, not whatever that window is showing, got ${JSON.stringify(sent.body)}`);

        // The name sits in the window's drag region, so it is one of the places
        // the window gets picked up by, and that drag ends in a click on it.
        /** @returns {number} How many asks have been sent. */
        const asks = () => relay.sent.filter((/** @type {any} */ m) => m.kind === 'select').length;
        name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, screenX: 200, screenY: 40 }));
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: 340, screenY: 96 }));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: 340, screenY: 96 }));
        name.click();
        assert(asks() === 1,
          `a window dragged across the screen by its name is not a press of it, got ${asks()} asks`);
        name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, screenX: 200, screenY: 40 }));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: 200, screenY: 40 }));
        name.click();
        assert(asks() === 2,
          `and the press after it, which stayed where it was, still is, got ${asks()} asks`);

        // Whether there is anywhere to send it is not known while the page is
        // parsing — the id arrives on the session frame — so the header is
        // written again when the answer comes, and a board that cannot be
        // addressed says the name rather than offering a control that would do
        // nothing.
        announceViewerId('');
        assert(nameTag() === 'SPAN',
          'a board that cannot be addressed says the name rather than offering a control that would do nothing');
        announceViewerId('v_self');
        assert(nameTag() === 'BUTTON',
          `and it is a control again when the address comes back, got <${nameTag().toLowerCase()}>`);

        // A board in a browser tab is addressable and gets nowhere: the ask
        // arrives in a tab the browser will not bring forward, so the user sees
        // nothing happen.
        asDesktopWindow(false);
        announceViewerId('v_self');
        assert(nameTag() === 'SPAN',
          `a board in a browser tab says the name: one tab cannot raise another, got <${nameTag().toLowerCase()}>`);
        asDesktopWindow(true);
        announceViewerId('v_self');

        pinboardView.setActivePin('pin_b');
        await nextTask();
        assert(!slot.querySelector('.app-header__board-name'),
          'the selected tab is not named up here — the tab strip below is already showing which one is up');
        assert(shownConversation() === 'Board conversation',
          'and the conversation stays exactly where it was: it is the one thing about this window that does not move');
      } finally {
        teardown();
        slot.remove();
        // The lane is a browser tab, and every suite after this one is entitled
        // to find it that way.
        asDesktopWindow(false);
      }
    });

    await run('the ordinary window is not renamed by the board in it', async () => {
      const slot = document.createElement('div');
      slot.id = 'board-title';
      slot.textContent = 'untouched';
      document.body.appendChild(slot);
      const { teardown } = await mountShell({ pins: PROBE_BOARD, search: '' });
      try {
        pinboardView.setActivePin('pin_a');
        await nextTask();
        assert(slot.textContent === 'untouched',
          'in the ordinary view the header is the app’s own and the board is a guest in it');
      } finally {
        teardown();
        slot.remove();
      }
    });

    await run('the bands the panel puts away are really put away', async () => {
      const { doc, frame } = await styledFrame(900);
      try {
        // Plain elements wearing the names and classes: a child document has its
        // own registry and would never upgrade the custom ones, and this is a
        // question about the cascade rather than about behaviour.
        const host = doc.createElement('div');
        host.innerHTML = '<pinboard-tabbar hidden></pinboard-tabbar>'
          + '<pinboard-content hidden></pinboard-content>'
          + '<div class="pinboard-placeholder" hidden></div>';
        doc.body.appendChild(host);

        const view = /** @type {Window} */ (doc.defaultView);
        for (const sel of ['pinboard-tabbar', 'pinboard-content', '.pinboard-placeholder']) {
          const display = view.getComputedStyle(/** @type {Element} */ (host.querySelector(sel))).display;
          assert(display === 'none',
            `${sel} sets its own display, and an author display beats the UA sheet’s [hidden] at any specificity — without a rule of its own the panel stacks the placeholder under the board it stands in for, got ${display}`);
        }
      } finally {
        frame.remove();
      }
    });

    await run('a board says what it is doing while its conversation opens', async () => {
      const gates = makeLoadGates();
      const { shell, teardown, relay } = await mountShell({
        pins: PROBE_BOARD,
        session: makeBoardSession({ load: gates.hold }),
      });
      try {
        assert(shell.querySelector('.pinboard-placeholder')?.textContent === 'Opening the conversation.',
          'a board that has not read its conversation yet must not claim to be looking at nothing');
        assert(tabLabels(shell).length === 0, 'and it draws no tabs against a transcript it has not read');
        assert(relay.sent.some((/** @type {any} */ m) => m.to === 'v_owner' && m.kind === 'hello'),
          'it introduces itself to the window it will send its reveals to');

        gates.release(BOARD_CONVERSATION);
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'the board to open once the conversation is really there');
        assert(!shell.querySelector('.pinboard-placeholder:not([hidden])'),
          'and the opening state to be gone');
      } finally {
        teardown();
      }
    });

    await run('a board is a view of the conversation its URL names', async () => {
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD });
      try {
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'the tab to be described against the conversation the board was opened for');
      } finally {
        teardown();
      }
    });

    await run('nothing can steer a board off its conversation', async () => {
      const { shell, teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`), 'the board to open');

        // Whatever anyone says to this board — its own owner included — the
        // conversation is the one in the URL. A board that could be moved from
        // outside is a board that cannot be left watching anything.
        relay.deliver('v_owner', 'context', { seq: 9, active: { conversation: { id: 'conv_elsewhere' } } });
        relay.deliver('v_owner', 'bye');
        relay.deliver('v_stranger', 'context', { seq: 9, active: { conversation: { id: 'conv_stranger' } } });
        await nextTask();

        assert(tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          `the board stays where it was opened, got ${JSON.stringify(tabLabels(shell))}`);
      } finally {
        teardown();
      }
    });

    await run('the conversation is loaded before the board reads it', async () => {
      const gates = makeLoadGates();
      const session = makeBoardSession({ load: gates.hold });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, session });
      try {
        await nextTask();
        assert(session.loaded.includes(BOARD_CONVERSATION),
          'getConversation answers with a live EMPTY conversation for one this viewer never opened, so the board must ask for it first');
        assert(tabLabels(shell).length === 0,
          'and must not read the transcript while that load is still out: an unhydrated conversation looks exactly like an empty one');
        gates.release(BOARD_CONVERSATION);
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'the board to open once the conversation is really there');
      } finally {
        teardown();
      }
    });

    await run('a board never rewrites which conversation the project opens on', async () => {
      const session = makeBoardSession();
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, session });
      try {
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`), 'the board to open');
        assert(session.switched.length === 0,
          'switchConversation saves the session, and the session\u2019s active conversation is what EVERY future viewer opens on');
      } finally {
        teardown();
      }
    });

    await run('a board whose conversation is gone says so', async () => {
      const { shell, teardown } = await mountShell({
        pins: PROBE_BOARD,
        // A session that has never heard of it: the conversation was deleted, or
        // this window's server has been pointed at another project since.
        session: makeSession(),
      });
      try {
        await waitFor(() => shell.querySelector('.pinboard-placeholder')?.textContent?.startsWith('This conversation is no longer available'),
          'the board to say what is missing');
        assert(tabLabels(shell).length === 0,
          'a board with no conversation to be a view of draws no tabs against one');
      } finally {
        teardown();
      }
    });

    // Deleting the conversation is meant to take its windows with it, and the
    // window it is meant to take is this one. It cannot be told to go: the app
    // that owns the frame hears nothing from the server, so the page in the
    // window is the only thing that knows both that the conversation has gone
    // and which window it is in.
    await run('a board whose conversation is deleted says which one and closes the window', async () => {
      const session = makeBoardSession();
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, session });
      const originalClose = window.close;
      let closes = 0;
      window.close = () => { closes += 1; };
      try {
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`), 'the board to open');

        // What a delete and a bin both look like from here: the conversation is
        // out of the session before the event announcing it arrives. The board
        // answers in the same turn, so nothing is waited for — a lane page is
        // hidden, where a browser clamps even a zero timer to a full second.
        session.known.delete(BOARD_CONVERSATION);
        session.emit('conversation:deleted');

        const placeholder = shell.querySelector('.pinboard-placeholder:not([hidden])');
        assert(placeholder?.textContent?.startsWith('\u201CBoard conversation\u201D has gone.'),
          `every board window is called Pinboard, so the one that has stopped working has to name the conversation it was a view of, got ${JSON.stringify(placeholder?.textContent)}`);
        assert(tabLabels(shell).length === 0,
          'and it stops showing a board over a transcript that is not there any more');
        assert(closes === 1,
          'and asks the window it is in to go: a board is a window onto one conversation, and that one has gone');
      } finally {
        window.close = originalClose;
        teardown();
      }
    });

    await run('a board sends its reveal instead of reaching for columns', async () => {
      const tab = stubActiveTab();
      const { teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        await waitFor(() => !!lastPinContext, 'the probe pin to mount');
        lastPinContext.services.contextItems.reveal('thread_7');
        lastPinContext.services.tasks.reveal('item_9');

        const reveals = relay.sent.filter((/** @type {any} */ m) => m.kind === 'reveal');
        assert(reveals.length === 2, `both reveals go back to the owner, got ${reveals.length}`);
        assert(reveals[0].to === 'v_owner' && reveals[0].body.kind === 'thread' && reveals[0].body.id === 'thread_7',
          'the thread reveal names its thread');
        assert(reveals[1].body.kind === 'item' && reveals[1].body.id === 'item_9',
          'and the item reveal names its item');
        assert(reveals.every((/** @type {any} */ m) => m.body.conversation === BOARD_CONVERSATION),
          'and both name this board\u2019s conversation, which the window they are going to may long since have left');
        assert(tab.threads.length === 0 && tab.items.length === 0,
          'a detached board has no columns of its own to move');
      } finally {
        teardown();
        tab.remove();
      }
    });

    await run('a board\u2019s toolbar keeps up with what its pin has found', async () => {
      const conversation = makeConversation(BOARD_CONVERSATION);
      const session = makeSession({ conversations: [conversation] });
      const { shell, teardown, relay } = await mountShell({ pins: REVEAL_BOARD, session });
      try {
        await waitFor(() => !!shell.querySelector('.pinboard-item-toolbar__action'),
          'the pin to mount and draw its action');

        const action = () => shell.querySelector('.pinboard-item-toolbar__action');
        assert(action().disabled === true,
          'the board mounts against a conversation whose transcript it has not read yet, so there is nothing to reveal');

        // What the load landing looks like from here: the transcript gains the
        // item, and the session says so.
        conversation.addPlan();
        session.emit('context-items:changed');
        await waitFor(() => (shell.querySelector('pinboard-content')?.textContent || '').includes('a plan'),
          'the pin to re-read and show the plan');
        assert(action().disabled === false,
          'the action is a view of the same lookup as the body, so a toolbar asked only at mount would stay dim over a plan that is plainly there');

        action().click();
        await nextTask();
        assert(relay.sent.some((/** @type {any} */ m) => m.kind === 'reveal' && m.to === 'v_owner'),
          'and it works: the reveal goes back to the window with the columns');
      } finally {
        teardown();
      }
    });

    await run('the owner records a board that says hello, and tells it nothing', async () => {
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { teardown, relay } = await mountShell({ search: '', session });
      try {
        relay.deliver('v_sat', 'hello');
        await nextTask();
        assert(ownerLink.satellites().includes('v_sat'),
          'a board that introduces itself is one whose reveals this window will carry out');
        assert(relay.sent.length === 0,
          `hello asks for nothing: a board reads its own conversation, got ${JSON.stringify(relay.sent)}`);
      } finally {
        teardown();
      }
    });

    await run('a window that moves on says nothing to the boards it opened', async () => {
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { teardown, relay } = await mountShell({ search: '', session });
      try {
        relay.deliver('v_sat', 'hello');
        await nextTask();

        session.visible = { id: 'conv_other', name: 'Other' };
        session.emit('conversation:switched');
        await nextTask();

        assert(relay.sent.length === 0,
          `a board is a view of one conversation, so this window moving is none of its business, got ${JSON.stringify(relay.sent)}`);
      } finally {
        teardown();
      }
    });

    await run('the owner switches to a board\u2019s conversation, then reveals in it', async () => {
      const tab = stubActiveTab('conv_other');
      const session = makeSession({
        conversation: { id: 'conv_main', name: 'Main' },
        conversations: [{ id: 'conv_other', name: 'Other' }],
      });
      const { teardown, relay } = await mountShell({ search: '', session });
      try {
        // A select first: the same journey with nothing to point at when it
        // arrives, which is what a board's header asks for.
        relay.deliver('v_stranger', 'select', { conversation: 'conv_other' });
        assert(session.switched.length === 0,
          'a viewer that never said hello cannot move the window a person is working in');

        relay.deliver('v_sat', 'hello');
        relay.deliver('v_sat', 'select', { conversation: 'conv_other' });
        await waitFor(() => session.switched.includes('conv_other'), 'the window to come to the conversation');
        assert(session.loaded.includes('conv_other'),
          'hydrated on the way, exactly as a reveal hydrates it');
        assert(tab.threads.length === 0 && tab.items.length === 0,
          `and nothing singled out, because nothing was named, got ${JSON.stringify(tab.threads)} and ${JSON.stringify(tab.items)}`);

        // Then a reveal, from the conversation the select left this window on.
        session.visible = { id: 'conv_main', name: 'Main' };
        relay.deliver('v_sat', 'reveal', { kind: 'thread', id: 'thread_7', conversation: 'conv_other' });
        await waitFor(() => tab.threads.length === 1, 'the reveal to be carried out');

        assert(session.switched.filter((/** @type {string} */ id) => id === 'conv_other').length === 2,
          'a board stays on its conversation while this window goes elsewhere, so being pointed at one of its threads is a request to come back to it');
        assert(tab.threads[0] === 'thread_7',
          `then the thread is revealed, got ${JSON.stringify(tab.threads)}`);
      } finally {
        teardown();
        tab.remove();
      }
    });

    await run('the owner carries out a board\u2019s reveal, and nobody else\u2019s', async () => {
      const tab = stubActiveTab();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { teardown, relay } = await mountShell({ search: '', session });
      try {
        relay.deliver('v_stranger', 'reveal', { kind: 'thread', id: 'thread_x', conversation: 'conv_main' });
        await nextTask();
        assert(tab.threads.length === 0,
          'a viewer that never said hello is not a board this window opened, and `from` cannot be forged');

        relay.deliver('v_sat', 'hello');
        relay.deliver('v_sat', 'reveal', { kind: 'thread', id: 'thread_7', conversation: 'conv_main' });
        relay.deliver('v_sat', 'reveal', { kind: 'item', id: 'item_9', conversation: 'conv_main' });
        await nextTask();
        assert(tab.threads.length === 1 && tab.threads[0] === 'thread_7',
          `the owner reveals the thread its board pointed at, got ${JSON.stringify(tab.threads)}`);
        assert(tab.items.length === 1 && tab.items[0] === 'item_9',
          `and the item, got ${JSON.stringify(tab.items)}`);
        assert(session.switched.length === 0,
          'and does not switch to a conversation it is already showing');
      } finally {
        teardown();
        tab.remove();
      }
    });

    await run('the owner comes to the board\u2019s conversation before putting its review in the prompt', async () => {
      const conversation = makeComposeConversation('conv_other');
      const session = makeSession({
        conversation: { id: 'conv_main', name: 'Main' },
        conversations: [conversation],
      });
      const { teardown, relay } = await mountShell({ search: '', session });
      try {
        relay.deliver('v_stranger', 'compose', {
          text: 'Review feedback:\n\nFrom nobody.', conversation: 'conv_other', thread: null,
        });
        await nextTask();
        assert(conversation.sent.length === 0 && session.switched.length === 0,
          'a viewer that never said hello cannot put words in the prompt of a window a person is working in');

        relay.deliver('v_sat', 'hello');
        relay.deliver('v_sat', 'compose', {
          text: 'Review feedback:\n\n./a.js:3 (new)\n>  x\nWrong.',
          conversation: 'conv_other',
          thread: 'thread_7',
        });
        // The owner hydrates, switches, then sends: which of those it reached
        // places a sighting where it stopped.
        await waitFor(() => conversation.sent.length === 1, () =>
          `the review to be handed over — the owner hydrated ${JSON.stringify(session.loaded)}, ` +
          `switched to ${JSON.stringify(session.switched)} (showing ${session.visible?.id ?? 'nothing'}), ` +
          `and sent ${conversation.sent.length} message(s)`);

        assert(session.switched.includes('conv_other'),
          'the conversation is shown first — text in a box nobody can see is worse than no text');
        assert(session.loaded.includes('conv_other'), 'hydrated on the way, exactly as a reveal hydrates it');
        const [handed] = conversation.sent;
        assert(handed.text.includes('Wrong.'), `carrying what the reader wrote:\n${handed.text}`);
        assert(handed.thread === 'thread_7',
          `onto the thread the board was reading, got ${JSON.stringify(handed.thread)}`);
        // This window has no box for that thread, so the owner sends rather than
        // drop the feedback — and a send nobody typed takes nothing from a
        // composer and gives nothing back to one.
        assert(handed.options?.consumeComposer === false && handed.options?.interpretCommands === false,
          `sent as generated text, got ${JSON.stringify(handed.options)}`);
      } finally {
        teardown();
      }
    });

    await run('a board carries on when the window that opened it has gone', async () => {
      const { shell, teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`), 'the board to open');

        // The window that opened it closes: it leaves the connected list, for good.
        wsService._emit('clients-changed', { count: 1, clients: [{ id: 'c1', viewerId: 'v_self' }] });
        await nextTask();

        assert(tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'a board reads its own conversation, so the window it came from closing takes nothing away \u2014 which is the whole reason to leave one open on work that is running');
        assert(!shell.querySelector('.pinboard-placeholder:not([hidden])'),
          'and there is nothing to announce');
        assert(relay.sent.some((/** @type {any} */ m) => m.kind === 'hello'),
          'the introduction stands; only the reveals it enables have nowhere to go');
      } finally {
        teardown();
      }
    });

    await run('a board asks the window it reports to to put its review in the prompt', async () => {
      const { teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        // A board window has no composer of its own, so this is the only way text
        // written on one reaches a prompt. The owner has to be known to be there:
        // the answer decides whether the board hands the review over or says it
        // itself, and it arrives with the viewer list on registration.
        wsService._emit('clients-changed', {
          count: 2,
          clients: [{ id: 'c1', viewerId: 'v_self' }, { id: 'c2', viewerId: 'v_owner' }],
        });
        await nextTask();

        const took = satelliteLink.compose('Review feedback:\n\n./a.js:3 (new)\n>  x\nWrong.',
          BOARD_CONVERSATION, 'thread_7');
        assert(took === true, 'a board with an owner present hands the review to it');
        const asked = relay.sent.filter((/** @type {any} */ m) => m.kind === 'compose');
        assert(asked.length === 1, `one hand-over is one message, got ${JSON.stringify(relay.sent)}`);
        assert(asked[0].to === 'v_owner', `addressed to the window that opened it, got ${asked[0].to}`);
        assert(asked[0].body.text.includes('Wrong.'), 'carrying what the reader wrote');
        assert(asked[0].body.conversation === BOARD_CONVERSATION && asked[0].body.thread === 'thread_7',
          `and which prompt it belongs in, got ${JSON.stringify(asked[0].body)}`);
      } finally {
        teardown();
      }
    });

    await run('a board with no window to report to refuses, so the review is not lost', async () => {
      const { teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        // The owner has closed. Saying "taken" here would be saying it of a
        // message nothing will ever receive, and the caller would stop looking
        // for somewhere else to put the feedback.
        wsService._emit('clients-changed', { count: 1, clients: [{ id: 'c1', viewerId: 'v_self' }] });
        await nextTask();

        assert(satelliteLink.compose('Review feedback:\n\nWrong.', BOARD_CONVERSATION, null) === false,
          'a board with nowhere to hand the review must say so');
        assert(relay.sent.every((/** @type {any} */ m) => m.kind !== 'compose'),
          `and ask nobody, got ${JSON.stringify(relay.sent)}`);
      } finally {
        teardown();
      }
    });

    await run('a board introduces itself again to a window that has come back', async () => {
      const { teardown, relay } = await mountShell({ pins: PROBE_BOARD });
      try {
        wsService._emit('clients-changed', { count: 1, clients: [{ id: 'c1', viewerId: 'v_self' }] });
        await nextTask();
        wsService._emit('clients-changed', {
          count: 2,
          clients: [{ id: 'c1', viewerId: 'v_self' }, { id: 'c2', viewerId: 'v_owner' }],
        });
        await nextTask();
        assert(relay.sent.filter((/** @type {any} */ m) => m.kind === 'hello').length >= 2,
          'a reloaded window has forgotten every board it opened, so a board that stayed quiet would find its reveals refused');
      } finally {
        teardown();
      }
    });

    await run('pop-out opens a board on the pin and the conversation being read', async () => {
      const opened = stubWindowOpen();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      try {
        pinboardView.setActivePin('pin_b');
        const popOut = shell.querySelector('.pinboard-toolbar__popout');
        assert(!!popOut, 'an attached board offers a window of its own');
        popOut.click();
        await nextTask();
        pinboardView.open();
        popOut.click();
        await nextTask();

        assert(opened.urls.length === 2, `a second pop-out is a second board, got ${opened.urls.length}`);
        const url = new URL(opened.urls[0]);
        assert(url.searchParams.get('view') === 'pinboard', 'the URL names the mode');
        assert(url.searchParams.get('owner') === 'v_self', 'and the viewer its reveals go back to');
        assert(url.searchParams.get('pin') === 'pin_b',
          `and the pin the user was reading, got ${url.searchParams.get('pin')}`);
        assert(url.searchParams.get('conversation') === 'conv_main',
          `and the conversation this window was showing at the moment of the click, which is what the new one is a view of from then on, got ${url.searchParams.get('conversation')}`);
        assert(!url.searchParams.has('nativeCtl'), 'and carries nothing of this window with it');

        // Each window is its own arrangement of tabs. Two windows naming one
        // composition would have each of them rearranging the other, which is
        // the whole reason a board has an id.
        const second = new URL(opened.urls[1]);
        const boards = [url.searchParams.get('board'), second.searchParams.get('board')];
        assert(boards.every((id) => typeof id === 'string' && id.startsWith('board_')),
          `each window names the board it is, got ${JSON.stringify(boards)}`);
        assert(boards[0] !== boards[1],
          'and a second pop-out is a second board, not the same one opened twice');
        assert(boards[0] !== 'main',
          'and never the docked panel, which is the one board that is not a window');
      } finally {
        teardown();
        opened.restore();
      }
    });

    // The windows open when Juggler was shut come back. It happens from the
    // page because a board is addressed to a viewer, and a viewer id lives in
    // sessionStorage: the owner saved with a board last run reaches nobody this
    // run, and only a live window knows its own.
    await run('the boards open at the last shutdown are reopened', async () => {
      const opened = stubWindowOpen();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, board, teardown } = await mountShell({
        pins: PROBE_BOARD,
        search: '',
        viewerId: '',
        session,
        left: [
          { id: 'board_one', conversation: 'conv_1', pins: PROBE_BOARD },
          { id: 'board_two', conversation: 'conv_2', pins: [] },
        ],
      });
      try {
        assert(opened.urls.length === 0,
          'nothing is opened before this viewer knows its own address, since a board opened then could answer to nobody');

        announceViewerId('v_self');
        await nextTask();

        assert(opened.urls.length === 2, `both boards come back, got ${opened.urls.length}`);
        const first = new URL(opened.urls[0]);
        assert(first.searchParams.get('board') === 'board_one',
          `each window comes back as the board it was, got ${first.searchParams.get('board')}`);
        assert(first.searchParams.get('conversation') === 'conv_1',
          `on the conversation it was a view of, got ${first.searchParams.get('conversation')}`);
        assert(first.searchParams.get('owner') === 'v_self',
          'and answering to the window that reopened it, which is the only owner that exists this run');
        assert(!first.searchParams.has('pin'),
          'the window reopening a board has no idea which tab it was showing — the board window remembers that itself');

        // The claim is spent, so a second window of the same project opens
        // nothing rather than a second copy of each.
        const claims = board.urls.filter((/** @type {string} */ url) => url.includes('/boards/restore'));
        assert(claims.length === 1, `the claim is made once, got ${claims.length}`);

        // A second announcement is a reconnect, not a second launch.
        announceViewerId('v_self');
        await nextTask();
        assert(opened.urls.length === 2,
          `a reconnect must not reopen everything again, got ${opened.urls.length}`);
        assert(!!shell.querySelector('pinboard-panel'), 'and the panel is undisturbed by any of it');
      } finally {
        teardown();
        opened.restore();
      }
    });

    // A board is a view of one conversation, fixed for its life. Detaching
    // without one would open a window only to say it has nothing to show.
    await run('a board with no conversation to be a view of is not detached', async () => {
      const opened = stubWindowOpen();
      const session = makeSession({});
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      try {
        await openBoard();
        shell.querySelector('.pinboard-toolbar__popout').click();
        await nextTask();
        assert(opened.urls.length === 0, `nothing must be opened, got ${opened.urls.length}`);
        const status = shell.querySelector('.pinboard-panel__status');
        assert(status?.textContent === "Couldn't detach the board. There's no conversation for it to be a view of.",
          `the status line says why, got ${status?.textContent}`);
        assert(pinboardView.isOpen(), 'and the board stays where it is');
      } finally {
        teardown();
        opened.restore();
        __resetPopupManagerForTests();
      }
    });

    await run('a browser board opens as a tab, not as a popup', async () => {
      const opened = stubWindowOpen();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      try {
        shell.querySelector('.pinboard-toolbar__popout').click();
        await nextTask();
        const [, target, features] = opened.calls[0];
        assert(target === '_blank', `a board opens in a new browsing context, got ${JSON.stringify(target)}`);
        assert(!features,
          `and as a tab: a tab is the thing the user can leave where it is, drag out into a window, or move to the other screen — a popup is a window chosen for them, got ${JSON.stringify(features)}`);
      } finally {
        teardown();
        opened.restore();
      }
    });

    // A pop-out is meant to read as the panel leaving the window rather than as
    // a new window appearing, so the panel's own rect goes with the request.
    // Only the desktop app can place a window, so what is asserted here is the
    // measurement it is placed from — the placement itself is the host's.
    await run('a pop-out is measured from the panel it came from', async () => {
      const hint = frameHintOf({
        getBoundingClientRect: () => ({ left: 700.4, top: 12.6, width: 544.2, height: 800.8 }),
      });
      // The page the measurement is taken in is named in the failure: a hint is
      // withheld from a page of no size, so a lane laid out in one fails this
      // as a measurement that did not happen rather than as a page that has
      // nothing to measure in.
      assert(hint?.x === 700 && hint?.y === 13,
        `the panel's place in this window is measured, got ${hint?.x},${hint?.y} in a page of ${window.innerWidth}x${window.innerHeight}`);
      assert(hint?.width === 544 && hint?.height === 801,
        `and the size of it, got ${hint?.width}x${hint?.height}`);
      assert(hint?.viewWidth === window.innerWidth && hint?.viewHeight === window.innerHeight,
        'and the page it was measured in, which is the only thing that gives those numbers a scale');
      assert(frameHintOf(null) === null,
        'nothing to measure is no hint at all rather than a frame of zeros');
      assert(frameHintOf({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }) === null,
        'and a panel with no size on screen would place a window nowhere');

      const opened = stubWindowOpen();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      const detach = ownerLink.detach;
      /** @type {any} */
      let sent = null;
      try {
        const panel = shell.querySelector('pinboard-panel');
        // The panel slides in and out, and a rect taken while it slides is a
        // sample of an animation rather than a place: the pool's window is
        // never shown, so a transition in flight advances at the whim of the
        // engine — WebKit leaves it at its first frame forever, Chromium runs
        // it to the end. Turning the slide off makes the panel's place a plain
        // layout fact, which is the only thing this case is about.
        panel.style.transition = 'none';
        await openBoard();
        await nextTask();
        ownerLink.detach = async (/** @type {any[]} */ ...args) => { sent = args[3]; return ''; };
        // Measured before the click: the handler measures the panel and then
        // awaits a detach that ends by putting the panel away, so a rect read
        // afterwards is of a panel already gone — where it went, not where it
        // was opened over.
        const rect = panel.getBoundingClientRect();
        assert(rect.width > 0 && rect.right <= window.innerWidth + 1,
          `the panel is open and in the page before it is measured, got ${JSON.stringify(rect.toJSON())} in ${window.innerWidth}x${window.innerHeight}`);
        shell.querySelector('.pinboard-toolbar__popout').click();
        await nextTask();
        assert(sent && sent.width === Math.round(rect.width) && sent.height === Math.round(rect.height),
          `the rect sent is the panel's, got ${JSON.stringify(sent)} for ${rect.width}x${rect.height}`);
        assert(sent.x === Math.round(rect.left) && sent.y === Math.round(rect.top),
          `and where the panel is, so the window can open over it, got ${sent.x},${sent.y} for ${rect.left},${rect.top}`);
      } finally {
        ownerLink.detach = detach;
        teardown();
        opened.restore();
        __resetPopupManagerForTests();
      }
    });

    await run('a blocked tab is reported rather than silently doing nothing', async () => {
      const opened = stubWindowOpen({ blocked: true });
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      try {
        await openBoard();
        shell.querySelector('.pinboard-toolbar__popout').click();
        await nextTask();
        const status = shell.querySelector('.pinboard-panel__status');
        assert(status?.textContent === "Couldn't open that board. The browser blocked the tab.",
          `the status line says what happened, got ${status?.textContent}`);
        assert(pinboardView.isOpen(),
          'a board that never opened is not one to put this one away for');
      } finally {
        teardown();
        opened.restore();
        __resetPopupManagerForTests();
      }
    });

    await run('a viewer nothing can address offers no Pop-out', async () => {
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', viewerId: '' });
      try {
        announceViewerId('');
        await nextTask();
        assert(shell.querySelector('.pinboard-toolbar__popout')?.hidden === true,
          'a peer-to-peer viewer has no id for a board to answer, so a Pop-out button could only open a board whose reveals go nowhere');
      } finally {
        teardown();
      }
    });

    await run('popping a board out puts the one it came from away', async () => {
      const opened = stubWindowOpen();
      const session = makeSession({ conversation: { id: 'conv_main', name: 'Main' } });
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', session });
      try {
        await openBoard();
        shell.querySelector('.pinboard-toolbar__popout').click();
        await nextTask();
        assert(opened.urls.length === 1, 'the board opened in a window of its own');
        assert(!pinboardView.isOpen(),
          'the board moved rather than being copied: leaving the overlay up would cover the workspace with a second view of what the new window is showing');

        // The overlay is shut, and this window still answers the boards it opened.
        const relayed = /** @type {any} */ (shell).querySelector('pinboard-panel');
        assert(!!relayed, 'the panel stays mounted, because it is what carries out their reveals');
      } finally {
        teardown();
        opened.restore();
        __resetPopupManagerForTests();
      }
    });

    await run('a board no relay can reach still shows its conversation', async () => {
      const { shell, teardown, relay } = await mountShell({ pins: PROBE_BOARD, viewerId: '' });
      try {
        announceViewerId('');
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'the board to open on the conversation its URL names');
        assert(relay.sent.length === 0,
          'a peer-to-peer viewer has no address, so there is nobody to introduce this board to — which costs it only its reveals');
      } finally {
        teardown();
      }
    });

    await run('Pop-out appears once this viewer learns its own address', async () => {
      const { shell, teardown } = await mountShell({ pins: PROBE_BOARD, search: '', viewerId: '' });
      try {
        const popOut = shell.querySelector('.pinboard-toolbar__popout');
        assert(!!popOut,
          'the button is built before the answer is in, because the board is static markup and upgrades while the page is still being parsed');
        assert(popOut.hidden, 'and stays out of sight while nothing can address this viewer');

        announceViewerId('v_self');
        await nextTask();
        assert(!popOut.hidden,
          'the session frame is the first moment a viewer knows its own id: a board that asked at build time would offer Pop-out to nobody, ever');
      } finally {
        teardown();
      }
    });

    await run('a board mounted before its own address arrives still finds its owner', async () => {
      const { shell, teardown, relay } = await mountShell({ pins: PROBE_BOARD, viewerId: '' });
      try {
        assert(relay.sent.length === 0, 'nothing is said to an owner this viewer could not be answered by');
        await waitFor(() => tabLabels(shell).includes(`alpha@${BOARD_CONVERSATION}`),
          'the board to open anyway: what it shows never depended on that answer');

        announceViewerId('v_self');
        await nextTask();
        assert(relay.sent.some((/** @type {any} */ m) => m.kind === 'hello' && m.to === 'v_owner'),
          `the board introduces itself as soon as it can be reached, got ${JSON.stringify(relay.sent)}`);
      } finally {
        teardown();
      }
    });

    await run('under en-XA the toolbar, the window header, the board\u2019s states and a failed add speak the user\u2019s language', async () => {
      /** @type {string[]} */
      const raw = [];
      const check = (/** @type {string} */ where, /** @type {string[]} */ shown, atLeast = 1) => {
        if (shown.length < atLeast) raw.push(`${where}: expected ${atLeast} strings, found ${shown.length}`);
        for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
      };
      const attr = (/** @type {Element|null|undefined} */ el, /** @type {string} */ name) => el?.getAttribute(name) || '';
      // Digits only: the conversation's name is data, and stands inside two of the messages.
      const named = () => makeSession({ conversations: [{ id: BOARD_CONVERSATION, name: '7' }] });
      const realGetType = pinboardItemRegistry.getType;
      const originalClose = window.close;
      const slot = document.createElement('div');
      slot.id = 'board-title';
      await underPseudoLocale('pinboard-satellite-test', async () => {
        // The docked board: its toolbar, and an add whose type refused.
        const docked = await mountShell({ pins: PROBE_BOARD, search: '' });
        try {
          const toolbar = docked.shell.querySelector('.pinboard-toolbar');
          assert(!!toolbar, 'the docked board has its toolbar');
          check('identity', [toolbar.querySelector('.pinboard-toolbar__identity')?.textContent || '']);
          const popOut = toolbar.querySelector('.pinboard-toolbar__popout');
          check('pop-out', [attr(popOut, 'title'), attr(popOut, 'aria-label'), popOut?.textContent || ''], 3);
          const close = toolbar.querySelector('.close-button');
          check('close', [attr(close, 'title'), attr(close, 'aria-label')], 2);

          pinboardItemRegistry.getType = /** @type {any} */ (() => ({
            configure: async () => { throw new Error('42'); },
          }));
          await docked.panel._add('i18n-refuses');
          const status = docked.shell.querySelector('.pinboard-panel__status')?.textContent
            || pinboardView.getStatus();
          if (!status.includes('42')) raw.push(`add failure keeps the error: ${status}`);
          check('add failure', [status.replace('42', '')]);
        } finally {
          pinboardItemRegistry.getType = realGetType;
          docked.teardown();
        }

        // A board window that can reach its owner: the header names the
        // conversation as a control, and says what kind of window this is.
        document.body.appendChild(slot);
        asDesktopWindow(true);
        const linked = await mountShell({ pins: PROBE_BOARD, session: named() });
        try {
          await waitFor(() => !!slot.querySelector('button.app-header__board-conversation'),
            'the header to name the conversation as a control', budgetFor(2000));
          const name = slot.querySelector('.app-header__board-conversation');
          check('header name control', [attr(name, 'title'), attr(name, 'aria-label')], 2);
          check('header kind', [slot.querySelector('.app-header__board-kind')?.textContent || '']);

          // Its conversation goes: the board names the one it has lost.
          window.close = () => {};
          linked.session.known.delete(BOARD_CONVERSATION);
          linked.session.emit('conversation:deleted');
          const gone = linked.shell.querySelector('.pinboard-placeholder:not([hidden])')?.textContent || '';
          if (!gone.includes('7')) raw.push(`the lost board keeps its name: ${gone}`);
          check('named conversation gone', [gone.replace('7', '')]);
        } finally {
          window.close = originalClose;
          linked.teardown();
          slot.remove();
          asDesktopWindow(false);
        }

        // Still opening its conversation.
        const gates = makeLoadGates();
        const opening = await mountShell({ pins: PROBE_BOARD, session: makeBoardSession({ load: gates.hold }) });
        try {
          check('opening', [opening.shell.querySelector('.pinboard-placeholder')?.textContent || '']);
        } finally {
          gates.release(BOARD_CONVERSATION);
          opening.teardown();
        }

        // A conversation this session never knew.
        const missing = await mountShell({ pins: PROBE_BOARD, session: makeSession() });
        try {
          await waitFor(() => !!missing.shell.querySelector('.pinboard-placeholder:not([hidden])')?.textContent,
            'the board to say what is missing', budgetFor(2000));
          check('unnamed conversation gone', [missing.shell.querySelector('.pinboard-placeholder')?.textContent || '']);
        } finally {
          missing.teardown();
        }
      });
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });

    await run('under en-XA a refused detach, a blocked tab, a failed board edit and an untitled conversation\u2019s name speak the user\u2019s language', async () => {
      /** @type {string[]} */
      const raw = [];
      const check = (/** @type {string} */ where, /** @type {string} */ s, data = '') => {
        if (data && !String(s).includes(data)) raw.push(`${where} keeps its data: ${s}`);
        const bare = data ? String(s).replace(data, '') : String(s);
        if (!s || !isPseudoLocalized(bare)) raw.push(`${where}: ${s}`);
      };
      /** @type {(() => void)[]} */
      const restores = [];
      const stub = (/** @type {any} */ obj, /** @type {string} */ key, /** @type {any} */ fn) => {
        const had = Object.prototype.hasOwnProperty.call(obj, key);
        const original = obj[key];
        obj[key] = fn;
        restores.push(() => { if (had) obj[key] = original; else delete obj[key]; });
      };
      // English first: an unnamed conversation is still '' to both readers.
      const unnamed = await mountShell({ pins: PROBE_BOARD, search: '', session: makeSession({ conversation: { id: 'conv_main', name: '' } }) });
      try {
        const title = unnamed.panel._activeContext().conversation?.title;
        assert(title === '', `an unnamed conversation hands pins no title, got ${JSON.stringify(title)}`);
      } finally {
        unnamed.teardown();
      }
      const label = /** @type {any} */ (document.createElement('pinboard-content'))._threadLabel({ name: '' }, null);
      assert(label === '', `an unnamed root thread has no label, got ${JSON.stringify(label)}`);

      const previousViewerId = wsService.viewerId;
      await underPseudoLocale('pinboard-satellite-test', async () => {
        // The name a pin is handed, and the root thread's label.
        const docked = await mountShell({ pins: PROBE_BOARD, search: '', session: makeSession({ conversation: { id: 'conv_main', name: 'Untitled 3' } }) });
        try {
          check('pin context title', docked.panel._activeContext().conversation?.title || '', '3');
        } finally {
          docked.teardown();
        }
        check('root thread label',
          /** @type {any} */ (document.createElement('pinboard-content'))._threadLabel({ name: 'Untitled 3' }, null), '3');

        __setViewModeForTests();
        try {
          // A detach refused before, and after, the board was asked for.
          wsService.viewerId = '';
          check('no address', await ownerLink.detach('', 'conv_1', []));
          wsService.viewerId = 'v_self';
          check('no conversation', await ownerLink.detach('', '', []));
          stub(pinboardStore, 'createBoard', async () => { throw new Error('42'); });
          check('create failed', await ownerLink.detach('', 'conv_1', []), '42');
          const opened = stubWindowOpen({ blocked: true });
          try {
            check('blocked tab', await ownerLink.openBoardWindow('b_1', '', 'conv_1'));
          } finally {
            opened.restore();
          }
          // The desktop branch cannot be reached here (no native host in a lane),
          // so its prefix and fallback are checked in the catalogue.
          check('native prefix', t("Couldn't open that board"));
          check('native fallback', t("Couldn't open that board."));

          // Every board edit that can fail, failing.
          const fail = async () => { throw new Error('42'); };
          stub(pinboardStore, 'getPin', () => null);
          stub(pinboardStore, 'get', () => []);
          stub(pinboardStore, 'add', fail);
          stub(pinboardStore, 'remove', fail);
          stub(pinboardStore, 'move', fail);
          stub(pinboardStore, 'applyOperations', fail);
          stub(pinboardStore, 'addAll', fail);
          stub(pinboardStore, 'claimSeed', async () => true);
          stub(pinboardItemRegistry, 'getType', () => null);
          stub(pinboardItemRegistry, 'getEnabledTypes', () => [
            { id: 'i18n-default', getManifest: () => ({ defaultPin: true, order: 0 }) },
          ]);
          /** @type {[string, () => Promise<any>][]} */
          const edits = [
            ['remove', () => pinboardView.remove('p_1')],
            ['move', () => pinboardView.move('p_1', 0)],
            ['add', () => pinboardView.add('i18n-type')],
            ['show', () => pinboardView.show('p_1', 'i18n-type', {})],
            ['furnish', () => pinboardView.furnish()],
            ['prune', async () => {
              pinboardStore.get = () => [{ id: 'p_2', type: 'changed-files', config: {} }];
              try { await pinboardView.prune(); } finally { pinboardStore.get = () => []; }
            }],
          ];
          for (const [where, edit] of edits) {
            pinboardView.setStatus('');
            await edit();
            check(where, pinboardView.getStatus(), '42');
          }
        } finally {
          for (const restore of restores.reverse()) restore();
          wsService.viewerId = previousViewerId;
          pinboardView.reset();
        }
      });
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
  } finally {
    __setViewModeForTests();
    ownerLink.reset();
    satelliteLink.reset();
    pinboardItemRegistry.reset();
    pinboardStore.reset();
    pinboardView.reset();
    __resetPopupManagerForTests();
    lastPinContext = null;
  }

  return { passed, failed, errors };
}
