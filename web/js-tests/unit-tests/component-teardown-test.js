//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a component leaves behind when it leaves the document, and what it
 * picks up again when it comes back.
 *
 * - A tool-action tile removed from its column on its own (thread navigation,
 *   a delete, tool grouping) must stop observing the thread's array. Its
 *   teardown used to find that array through `closest('conversation-area')`,
 *   which a removed element can no longer answer, so each such tile left an
 *   observer running on every change to the thread for as long as the
 *   conversation stayed open.
 * - A path completion that arrives after its field was closed or removed must
 *   not open a menu: the menu is portaled to <body> with window listeners of
 *   its own, and nothing would ever close it.
 * - A permission control moved to another parent (the composer re-parents it
 *   when the pointer type changes) must keep listening to its thread, which it
 *   stays bound to across the move. So must a strategy selector, which observes
 *   the conversation's metadata, the thread's items and its container, and
 *   hears a registry reload once wherever it is — and not at all once removed.
 * - A conversation tab moved or put back keeps its conversation's session and
 *   status feeds, which it takes when handed the conversation rather than on
 *   connect.
 * - The settings panel put back after a removal hears the socket again — its
 *   tabs are built once, with the panel, and give up their subscriptions on
 *   every disconnect — and still shows what it had drawn.
 * - A model selector moved or put back follows the provider list and the
 *   connection status exactly once.
 * - A properties panel follows the thread it was last handed — a reused column
 *   is handed a different one — and keeps that thread, its strategy feed and
 *   what it had drawn across a move or a put-back.
 * - A workspace panel moved or put back follows its session exactly once.
 * - So do the no-project and no-conversations overlays; the no-project one also
 *   holds the provider feed, the folder-drop listener and the native drag hooks
 *   while it is in the document and none of them once it has left.
 * - A conversation footer moved or put back follows its thread's session and
 *   status feeds exactly once, and keeps the status line it had drawn.
 * - A path field moved keeps what was typed in it and hears each key once.
 * - A workspace box header moved while its status read was outstanding asks
 *   again; one that already has its answer does not.
 * - The leaf components — reply suggestions, reveal button, model tuning,
 *   thread and tool-group tiles, code block, model chip — keep the nodes they
 *   drew across a move or a put-back and hear each click on them once.
 * - A token pill hears a click while it is in the document and not once it has
 *   left.
 * - A file view holds one mounted viewer while it is in the document and none
 *   once it has left.
 * - A dialog moved mid-question answers it and stops showing; put back, it
 *   asks the next one normally.
 * - An open update notice moved keeps its Escape/Back registration, gives it
 *   up when removed, and takes it back when reinserted.
 * - An approval widget moved mid-edit keeps the pattern being typed, and
 *   answers one click once.
 * - A composer moved or put back keeps its textarea and what was typed in it,
 *   hears each click and cache-impact event once, and follows its
 *   conversation's metadata exactly once — however many times its listeners
 *   were bound — and hears none of it once it has left.
 * - A conversation column moved or put back keeps the transcript it drew and
 *   the conversation, thread and thread context it was handed, follows each of
 *   them exactly once, hears each click and request once — and none of it once
 *   it has left.
 * @module unit-tests/component-teardown
 */

import wsService from '../../js/services/websocket.js';
import connectionStatus from '../../js/services/connection-status.js';
import { REGISTRIES_RELOADED } from '../../js/registries/reload-registries.js';
import '../../js/components/tool-action-message.js';
import '../../js/components/path-input.js';
import '../../js/components/permission-controls.js';
import '../../js/components/strategy-selector.js';
import '../../js/components/conversation-tab.js';
import '../../js/components/settings-panel.js';
import '../../js/components/model-selector.js';
import '../../js/components/properties-panel.js';
import '../../js/components/workspace-panel.js';
import '../../js/components/no-conversations-overlay.js';
import '../../js/components/no-project-overlay.js';
import '../../js/components/conversation-footer.js';
import '../../js/components/workspace-box-header.js';
import '../../js/components/reply-suggestions-row.js';
import '../../js/components/reveal-button.js';
import '../../js/components/model-picker/model-tuning.js';
import '../../js/components/model-picker/model-chip.js';
import '../../js/components/thread-message.js';
import '../../js/components/tool-group-message.js';
import '../../js/components/code-block.js';
import '../../js/components/token-display.js';
import '../../js/components/file-view.js';
import '../../js/components/modal-dialog.js';
import '../../js/components/update-notice.js';
import '../../js/components/action-confirmation.js';
import '../../js/components/composer.js';
import '../../js/components/conversation-area.js';
import { GUIDANCE_CHANGED_EVENT } from '../../js/services/guidance/nudge-engine.js';
import { CONTEXT_CACHE_IMPACT_CHANGED } from '../../js/services/context-cache-impact.js';
import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { closeAllPopups } from '../../js/utils/popup-manager.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A Y.Array stand-in that counts its deep observers.
 * @returns {{observeDeep: (fn: Function) => void, unobserveDeep: (fn: Function) => void, toArray: () => any[], observers: Set<Function>}} The stand-in, with its live observer set.
 */
function countingYArray() {
  const observers = new Set();
  return {
    observers,
    observeDeep: (fn) => { observers.add(fn); },
    unobserveDeep: (fn) => { observers.delete(fn); },
    toArray: () => [],
  };
}

/**
 * A tool-action tile whose column lookup answers as the real one does: through
 * `closest`, so only while the tile is inside its column.
 * @param {ReturnType<typeof countingYArray>} yarray
 * @returns {any} The tile, not yet connected.
 */
function tileFor(yarray) {
  const tile = /** @type {any} */ (document.createElement('tool-action-message'));
  tile.setAttribute('message-id', 'ta-1');
  const thread = { yarray, items: [] };
  tile._getConversation = function () { return this.closest('.teardown-column') ? {} : null; };
  tile._getMessageThread = function () { return this.closest('.teardown-column') ? thread : null; };
  tile.render = () => {};
  return tile;
}

/**
 * A completion response the test releases when it chooses.
 * @returns {{restore: () => void, release: (paths: string[]) => void}} Controls to answer the held request and to put fetch back.
 */
function heldCompletions() {
  const originalFetch = window.fetch;
  /** @type {(r: Response) => void} */
  let resolve = () => {};
  window.fetch = /** @type {any} */ (() => new Promise((r) => { resolve = r; }));
  return {
    restore: () => { window.fetch = originalFetch; },
    release: (paths) => resolve(new window.Response(JSON.stringify({ results: paths.map((path) => ({ path })) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })),
  };
}

/**
 * A message thread stand-in that counts metadata observers and session
 * subscribers.
 * @returns {any} The stand-in, with its live observer and subscriber sets.
 */
function countingThread() {
  const metadata = new Set();
  const session = new Set();
  return {
    metadata,
    session,
    strategy: null,
    conversation: {
      observeMetadata: (fn) => { metadata.add(fn); },
      unobserveMetadata: (fn) => { metadata.delete(fn); },
      session: {
        subscribe: (fn) => { session.add(fn); return () => session.delete(fn); },
      },
    },
  };
}

/**
 * How many listeners the socket holds for each of `events`.
 * @param {string[]} events
 * @returns {Record<string, number>} Listener count per event.
 */
function socketListeners(events) {
  const listeners = /** @type {any} */ (wsService)._listeners;
  return Object.fromEntries(events.map((e) => [e, listeners[e].length]));
}

/**
 * Each event's listener count above `baseline`, as one readable line.
 * @param {string[]} events
 * @param {Record<string, number>} baseline
 * @returns {string} e.g. "providers-update +1, clients-changed +0".
 */
function socketDelta(events, baseline) {
  const now = socketListeners(events);
  return events.map((e) => `${e} ${now[e] - baseline[e] >= 0 ? '+' : ''}${now[e] - baseline[e]}`).join(', ');
}

/**
 * How many `type` events reach `target` while `act` runs.
 * @param {EventTarget} target
 * @param {string} type
 * @param {() => void} act
 * @returns {number} The events heard.
 */
function countEvents(target, type, act) {
  let n = 0;
  const count = () => { n++; };
  target.addEventListener(type, count);
  try {
    act();
  } finally {
    target.removeEventListener(type, count);
  }
  return n;
}

/**
 * What `promise` has settled to by the next task, or `'pending'` — so a promise
 * nothing will ever settle fails the case instead of hanging the suite.
 * @param {Promise<any>} promise
 * @returns {Promise<any>} Its value, or 'pending'.
 */
function settledBy(promise) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), 0))]);
}

/**
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0;
  /** @type {string[]} */
  const errors = [];
  const column = document.createElement('div');
  column.className = 'teardown-column';
  document.body.appendChild(column);

  try {
    const yarray = countingYArray();
    const tile = tileFor(yarray);
    column.appendChild(tile);
    if (yarray.observers.size !== 1) throw new Error(`a mounted tile observes ${yarray.observers.size} times, want 1`);
    tile.remove();
    if (yarray.observers.size !== 0) {
      throw new Error(`a tile removed on its own still observes the thread (${yarray.observers.size} observer(s))`);
    }
    passed++;
  } catch (e) { failed++; errors.push(`tool-action tile removed alone: ${e.message}`); }

  try {
    const yarray = countingYArray();
    const tile = tileFor(yarray);
    column.appendChild(tile);
    const other = document.createElement('div');
    other.className = 'teardown-column';
    document.body.appendChild(other);
    other.appendChild(tile);
    other.remove();
    if (yarray.observers.size !== 0) throw new Error(`${yarray.observers.size} observer(s) left after a move and a removal`);
    passed++;
  } catch (e) { failed++; errors.push(`tool-action tile moved then removed: ${e.message}`); }

  for (const [label, end] of /** @type {Array<[string, (el: any) => void]>} */ ([
    ['removed', (el) => el.remove()],
    ['closed', (el) => el._closeMenu()],
  ])) {
    const held = heldCompletions();
    const el = /** @type {any} */ (document.createElement('path-input'));
    try {
      document.body.appendChild(el);
      const fetching = el._fetch('/');
      end(el);
      held.release(['/tmp/']);
      await fetching;
      const orphan = document.body.querySelector('.path-input-menu');
      if (orphan) {
        orphan.remove();
        throw new Error('a completion arriving after the field was ' + label + ' opened a menu on <body>');
      }
      passed++;
    } catch (e) { failed++; errors.push(`path-input fetch outliving a field ${label}: ${e.message}`); }
    finally {
      el._closeMenu?.();
      el.remove();
      held.restore();
    }
  }

  try {
    const thread = countingThread();
    const control = /** @type {any} */ (document.createElement('permission-controls'));
    control.render = () => {};
    control._renderButton = () => {};
    column.appendChild(control);
    control.setMessageThread(thread);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(control);
    try {
      if (thread.metadata.size !== 1 || thread.session.size !== 1) {
        throw new Error(`after a move it holds ${thread.metadata.size} metadata observer(s) and ${thread.session.size} session subscription(s), want 1 and 1`);
      }
      control.remove();
      if (thread.metadata.size !== 0 || thread.session.size !== 0) {
        throw new Error(`after removal it holds ${thread.metadata.size} metadata observer(s) and ${thread.session.size} session subscription(s), want none`);
      }
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`permission-controls re-parented: ${e.message}`); }

  try {
    const thread = countingThread();
    const yarray = countingYArray();
    const containerObservers = new Set();
    Object.assign(thread, {
      yarray,
      threadItemId: 'teardown-thread',
      currentStrategyId: 'default',
      container: {
        observe: (/** @type {Function} */ fn) => { containerObservers.add(fn); },
        unobserve: (/** @type {Function} */ fn) => { containerObservers.delete(fn); },
      },
    });
    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    let rebaselines = 0;
    selector.render = () => {};
    selector._refreshCacheInputs = async (/** @type {{rebaseline?: boolean}} */ opts) => {
      if (opts?.rebaseline) rebaselines++;
    };
    selector._recomputeImpact = () => {};
    let reloads = 0;
    selector.loadStrategies = () => { reloads++; };
    const heardReload = () => {
      const before = reloads;
      document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));
      return reloads - before;
    };
    column.appendChild(selector);
    selector.setMessageThread(thread);
    const settle = () => new Promise((r) => queueMicrotask(() => r(undefined)));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${thread.metadata.size} metadata, ${yarray.observers.size} items and ${containerObservers.size} container observer(s)`;
      const holdsOneOfEach = () => thread.metadata.size === 1 && yarray.observers.size === 1 && containerObservers.size === 1;
      const bound = rebaselines;
      elsewhere.appendChild(selector);
      await settle();
      if (!holdsOneOfEach()) throw new Error(`after a move it holds ${held()}, want 1 of each`);
      // A rebaseline captures the staged strategy as already cached, clearing a
      // cache-bust caution the user has not acted on yet.
      if (rebaselines !== bound) throw new Error(`a move rebaselined the cache-bust caution ${rebaselines - bound} time(s)`);
      let heard = heardReload();
      if (heard !== 1) throw new Error(`after a move a registry reload reached it ${heard} time(s), want 1`);
      selector.remove();
      await settle();
      if (thread.metadata.size !== 0 || yarray.observers.size !== 0 || containerObservers.size !== 0) {
        throw new Error(`after removal it holds ${held()}, want none`);
      }
      heard = heardReload();
      if (heard !== 0) throw new Error(`after removal a registry reload reached it ${heard} time(s), want none`);
      elsewhere.appendChild(selector);
      if (!holdsOneOfEach()) throw new Error(`reinserted after a removal it holds ${held()}, want 1 of each`);
      heard = heardReload();
      if (heard !== 1) throw new Error(`reinserted after a removal a registry reload reached it ${heard} time(s), want 1`);
      selector.remove();
      await settle();
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`strategy-selector re-parented: ${e.message}`); }

  try {
    const session = new Set();
    const status = new Set();
    const conversation = {
      id: 'teardown-conv',
      rootItems: [],
      llmState: null,
      startStatusObserver: () => {},
      onStatusChange: (/** @type {Function} */ fn) => { status.add(fn); return () => status.delete(fn); },
      session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } },
    };
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    column.appendChild(tab);
    tab.setConversation(conversation);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${session.size} session and ${status.size} status subscription(s)`;
      elsewhere.appendChild(tab);
      if (session.size !== 1 || status.size !== 1) throw new Error(`after a move it holds ${held()}, want 1 and 1`);
      tab.remove();
      if (session.size !== 0 || status.size !== 0) throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(tab);
      if (session.size !== 1 || status.size !== 1) throw new Error(`reinserted after a removal it holds ${held()}, want 1 and 1`);

      // Its document-level key handling comes back with it, once: a tab that
      // lost it would ignore the keyboard, and one that gained a second copy
      // would act twice on every key. The re-render a parked tab gets when it is
      // shown again must not add one either.
      let heard = 0;
      tab._onNavKeydown = () => { heard++; };
      tab.render();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      if (heard !== 1) throw new Error(`reinserted after a removal a key reached its handler ${heard} time(s), want 1`);
      tab.remove();
      heard = 0;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      if (heard !== 0) throw new Error(`removed, a key still reached its handler ${heard} time(s)`);
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`conversation-tab re-parented: ${e.message}`); }

  try {
    const events = ['providers-update', 'clients-changed', 'plugin-changed'];
    const baseline = socketListeners(events);
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const holdsOneOfEach = () => socketDelta(events, baseline) === events.map((e) => `${e} +1`).join(', ');
      column.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`a mounted panel holds ${socketDelta(events, baseline)}, want +1 of each`);
      const drawn = document.createElement('span');
      drawn.className = 'teardown-drawn';
      panel.querySelector('#provider-fields-container').appendChild(drawn);
      elsewhere.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`after a move it holds ${socketDelta(events, baseline)}, want +1 of each`);
      panel.remove();
      if (socketDelta(events, baseline) !== events.map((e) => `${e} +0`).join(', ')) {
        throw new Error(`after removal it holds ${socketDelta(events, baseline)}, want none`);
      }
      elsewhere.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`reinserted after a removal it holds ${socketDelta(events, baseline)}, want +1 of each`);
      // Nothing redraws a tab's fields after the first config load, so a reinsert
      // that re-rendered the shell would leave them empty for good.
      if (!panel.querySelector('.teardown-drawn')) throw new Error('reinserting the panel threw away the fields it had drawn');
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`settings-panel re-parented: ${e.message}`); }

  {
    const realSubscribe = connectionStatus.subscribe;
    let statusSubscribers = 0;
    connectionStatus.subscribe = (fn) => {
      statusSubscribers++;
      const off = realSubscribe.call(connectionStatus, fn);
      return () => { statusSubscribers--; off(); };
    };
    const baseline = socketListeners(['providers-update']);
    const selector = /** @type {any} */ (document.createElement('model-selector'));
    selector.fetchProviders = async () => {};
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${socketDelta(['providers-update'], baseline)} and ${statusSubscribers} status subscription(s)`;
      const holdsOne = () => held() === 'providers-update +1 and 1 status subscription(s)';
      column.appendChild(selector);
      elsewhere.appendChild(selector);
      if (!holdsOne()) throw new Error(`after a move it holds ${held()}, want +1 and 1`);
      selector.remove();
      if (held() !== 'providers-update +0 and 0 status subscription(s)') throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(selector);
      if (!holdsOne()) throw new Error(`reinserted after a removal it holds ${held()}, want +1 and 1`);
      selector.remove();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`model-selector re-parented: ${e.message}`);
    } finally {
      selector.remove();
      elsewhere.remove();
      connectionStatus.subscribe = realSubscribe;
    }
  }

  try {
    const session = new Set();
    const threadFor = () => ({
      container: countingYArray(),
      items: [],
      pendingItems: [],
      getContextItem: () => null,
      conversation: { session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } } },
    });
    const first = threadFor();
    const second = threadFor();
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    column.appendChild(panel);
    panel.setConversation({ id: 'teardown-conv' });
    panel.setMessageThread(first);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${first.container.observers.size} on the first thread, ${second.container.observers.size} on the second and ${session.size} session subscription(s)`;
      const onSecond = () => first.container.observers.size === 0 && second.container.observers.size === 1 && session.size === 1;
      // The column builder hands a reused column the thread to its left, which
      // changes when a different thread is opened beside it.
      panel.setMessageThread(second);
      if (!onSecond()) throw new Error(`handed another thread it holds ${held()}, want 0, 1 and 1`);
      // The column builder draws a panel only when its selection changes, so a
      // move that threw the drawing away would leave it blank.
      const drawn = document.createElement('span');
      drawn.className = 'teardown-drawn';
      panel.querySelector('properties-panel-content').appendChild(drawn);
      elsewhere.appendChild(panel);
      if (!onSecond()) throw new Error(`after a move it holds ${held()}, want 0, 1 and 1`);
      if (!panel.querySelector('.teardown-drawn')) throw new Error('a move threw away what the panel had drawn');
      panel.remove();
      if (second.container.observers.size !== 0 || session.size !== 0) throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(panel);
      if (!onSecond()) throw new Error(`reinserted after a removal it holds ${held()}, want 0, 1 and 1`);
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`properties-panel rebound and re-parented: ${e.message}`); }

  try {
    const subscribers = new Set();
    const session = { subscribe: (/** @type {Function} */ fn) => { subscribers.add(fn); return () => subscribers.delete(fn); } };
    const panel = /** @type {any} */ (document.createElement('workspace-panel'));
    column.appendChild(panel);
    panel.setSession(session);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      elsewhere.appendChild(panel);
      if (subscribers.size !== 1) throw new Error(`after a move it holds ${subscribers.size} session subscription(s), want 1`);
      panel.remove();
      if (subscribers.size !== 0) throw new Error(`after removal it holds ${subscribers.size} session subscription(s), want none`);
      elsewhere.appendChild(panel);
      if (subscribers.size !== 1) throw new Error(`reinserted after a removal it holds ${subscribers.size} session subscription(s), want 1`);
      panel.setSession(session);
      if (subscribers.size !== 1) throw new Error(`handed its session again it holds ${subscribers.size} session subscription(s), want 1`);
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
      document.body.classList.remove('workspace-selected');
    }
  } catch (e) { failed++; errors.push(`workspace-panel re-parented: ${e.message}`); }

  for (const tag of ['no-conversations-overlay', 'no-project-overlay']) {
    const hadClasses = ['no-project', 'no-conversations'].filter((c) => document.body.classList.contains(c));
    const subscribers = new Set();
    const session = {
      projectPath: '/teardown',
      conversations: new Map([['teardown-conv', {}]]),
      subscribe: (/** @type {Function} */ fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    };
    const overlay = /** @type {any} */ (document.createElement(tag));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(overlay);
      overlay.setSession(session);
      elsewhere.appendChild(overlay);
      if (subscribers.size !== 1) throw new Error(`after a move it holds ${subscribers.size} session subscription(s), want 1`);
      overlay.remove();
      if (subscribers.size !== 0) throw new Error(`after removal it holds ${subscribers.size} session subscription(s), want none`);
      elsewhere.appendChild(overlay);
      if (subscribers.size !== 1) throw new Error(`reinserted after a removal it holds ${subscribers.size} session subscription(s), want 1`);
      overlay.setSession(session);
      if (subscribers.size !== 1) throw new Error(`handed its session again it holds ${subscribers.size} session subscription(s), want 1`);
      overlay.remove();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${tag} re-parented: ${e.message}`);
    } finally {
      overlay.remove();
      elsewhere.remove();
      document.body.classList.remove('no-project', 'no-conversations');
      document.body.classList.add(...hadClasses);
    }
  }

  {
    const hadNoProject = document.body.classList.contains('no-project');
    const baseline = socketListeners(['providers-update']);
    const overlay = /** @type {any} */ (document.createElement('no-project-overlay'));
    let opened = 0;
    overlay._open = async () => { opened++; };
    const dropped = () => {
      const before = opened;
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/teardown' } }));
      return opened - before;
    };
    const hooked = () => /** @type {any} */ (window)._wails?.handleDragEnter !== undefined;
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${socketDelta(['providers-update'], baseline)}, ${dropped()} drop handler(s) and drag hooks ${hooked() ? 'installed' : 'absent'}`;
      const holdsOne = 'providers-update +1, 1 drop handler(s) and drag hooks installed';
      column.appendChild(overlay);
      elsewhere.appendChild(overlay);
      let now = held();
      if (now !== holdsOne) throw new Error(`after a move it holds ${now}, want +1, 1 and installed`);
      overlay.remove();
      now = held();
      if (now !== 'providers-update +0, 0 drop handler(s) and drag hooks absent') throw new Error(`after removal it holds ${now}, want none`);
      elsewhere.appendChild(overlay);
      now = held();
      if (now !== holdsOne) throw new Error(`reinserted after a removal it holds ${now}, want +1, 1 and installed`);
      overlay.remove();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`no-project-overlay window feeds re-parented: ${e.message}`);
    } finally {
      overlay.remove();
      elsewhere.remove();
      document.body.classList.toggle('no-project', hadNoProject);
    }
  }

  try {
    const session = new Set();
    const status = new Set();
    const thread = {
      container: countingYArray(),
      items: [],
      threadItemId: null,
      conversation: {
        id: 'teardown-conv',
        onStatusChange: (/** @type {Function} */ fn) => { status.add(fn); return () => status.delete(fn); },
        session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } },
      },
    };
    const footer = /** @type {any} */ (document.createElement('conversation-footer'));
    footer._updateTokenDisplay = () => {};
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${session.size} session and ${status.size} status subscription(s)`;
      // A column hands its footer the thread before mounting it.
      footer.setMessageThread(thread);
      column.appendChild(footer);
      if (session.size !== 1 || status.size !== 1) throw new Error(`a mounted footer holds ${held()}, want 1 and 1`);
      // Nothing redraws the status line until the next update, so a move that
      // rebuilt the markup would blank a running turn's status until then.
      footer.update({ isProcessing: true, canContinue: false, statusMessage: 'teardown-status' });
      elsewhere.appendChild(footer);
      if (session.size !== 1 || status.size !== 1) throw new Error(`after a move it holds ${held()}, want 1 and 1`);
      if (footer.querySelector('.llm-busy-text')?.textContent !== 'teardown-status') throw new Error('a move threw away the status line the footer had drawn');
      footer.remove();
      if (session.size !== 0 || status.size !== 0) throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(footer);
      if (session.size !== 1 || status.size !== 1) throw new Error(`reinserted after a removal it holds ${held()}, want 1 and 1`);
      footer.setMessageThread(thread);
      if (session.size !== 1 || status.size !== 1) throw new Error(`handed its thread again it holds ${held()}, want 1 and 1`);
      footer.remove();
      passed++;
    } finally {
      footer.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`conversation-footer re-parented: ${e.message}`); }

  try {
    const field = /** @type {any} */ (document.createElement('path-input'));
    let keydowns = 0;
    field._onKeydown = () => { keydowns++; };
    const heard = () => {
      const before = keydowns;
      field.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      return keydowns - before;
    };
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(field);
      field.value = '/teardown/typed';
      elsewhere.appendChild(field);
      // The permissions popup re-parents its fields, so a move that rebuilt the
      // inner input would put back the attribute's value over what was typed.
      if (field.value !== '/teardown/typed') throw new Error(`a move left the field holding "${field.value}", want what was typed`);
      let n = heard();
      if (n !== 1) throw new Error(`after a move a key reached it ${n} time(s), want 1`);
      field.remove();
      elsewhere.appendChild(field);
      n = heard();
      if (n !== 1) throw new Error(`reinserted after a removal a key reached it ${n} time(s), want 1`);
      field.remove();
      passed++;
    } finally {
      field._closeMenu?.();
      field.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`path-input re-parented: ${e.message}`); }

  try {
    const header = /** @type {any} */ (document.createElement('workspace-box-header'));
    let asked = 0;
    header.refreshStatus = async () => { asked++; };
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(header);
      header.setContext({ session: {}, workspace: { id: 'teardown-ws', label: 'teardown' } });
      if (asked !== 1) throw new Error(`a header handed a workspace asked ${asked} time(s) about it, want 1`);
      // The question the disconnect abandoned has to be asked again on the way
      // back: nothing else hands the header its context until the bar next draws.
      elsewhere.appendChild(header);
      if (asked !== 2) throw new Error(`after a move with no answer yet it asked ${asked - 1} more time(s), want 1`);
      header._status = { dirty: false };
      header.remove();
      elsewhere.appendChild(header);
      if (asked !== 2) throw new Error(`reinserted with its answer it asked ${asked - 2} more time(s), want none`);
      if (header.querySelector('.conversation-box-label-text')?.textContent !== 'teardown') throw new Error('a reinsert threw away the name the header had drawn');
      header.remove();
      passed++;
    } finally {
      header.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`workspace-box-header re-parented: ${e.message}`); }

  /**
   * Each leaf: how to make one that has drawn something, the node that drawing
   * lives in, and — where it has one to offer — a click with the number of
   * times it was heard.
   * @type {Array<{tag: string, setup: (el: any) => void, node: (el: any) => Element|null, click?: (el: any) => number}>}
   */
  const leaves = [
    {
      tag: 'reply-suggestions',
      setup: (el) => el.update(['teardown reply']),
      node: (el) => el.querySelector('.reply-suggestion'),
      click: (el) => countEvents(el, 'reply-suggestion-chosen', () => el.querySelector('.reply-suggestion').click()),
    },
    { tag: 'reveal-button', setup: (el) => { el.path = '/teardown'; }, node: (el) => el.querySelector('button') },
    {
      tag: 'model-tuning',
      setup: (el) => { el.modelEntry = { thinkingLevels: ['low', 'high'] }; },
      node: (el) => el.querySelector('.thinking-seg'),
      click: (el) => countEvents(el, 'change', () => el.querySelector('.thinking-seg').click()),
    },
    { tag: 'thread-message', setup: () => {}, node: (el) => el.querySelector('article') },
    { tag: 'tool-group-message', setup: () => {}, node: (el) => el.querySelector('article') },
    {
      tag: 'code-block',
      setup: (el) => { el.setAttribute('language', 'js'); el.setAttribute('code', 'const teardown = 1;'); },
      node: (el) => el.querySelector('pre'),
      click: (el) => {
        let n = 0;
        el.copyCode = () => { n++; };
        el.querySelector('.copy-btn').click();
        return n;
      },
    },
    {
      tag: 'model-chip',
      setup: (el) => { el.config = { provider: 'teardown', model: 'teardown-model' }; },
      node: (el) => el.button,
      click: (el) => countEvents(el, 'chip-toggle', () => el.button.click()),
    },
  ];
  for (const leaf of leaves) {
    const el = /** @type {any} */ (document.createElement(leaf.tag));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      try {
        leaf.setup(el);
        column.appendChild(el);
        const drawn = leaf.node(el);
        if (!drawn) throw new Error('a mounted one has drawn nothing');
        elsewhere.appendChild(el);
        if (leaf.node(el) !== drawn) throw new Error('a move redrew it');
        let n = leaf.click ? leaf.click(el) : 1;
        if (n !== 1) throw new Error(`after a move a click reached it ${n} time(s), want 1`);
        el.remove();
        elsewhere.appendChild(el);
        if (leaf.node(el) !== drawn) throw new Error('a put-back redrew it');
        n = leaf.click ? leaf.click(el) : 1;
        if (n !== 1) throw new Error(`reinserted after a removal a click reached it ${n} time(s), want 1`);
        passed++;
      } finally {
        el.remove();
        elsewhere.remove();
      }
    } catch (e) { failed++; errors.push(`${leaf.tag} re-parented: ${e.message}`); }
  }

  try {
    const pill = /** @type {any} */ (document.createElement('token-display'));
    pill.setUsage({ total: 1000 });
    const heard = () => countEvents(pill, 'token-display:show-transaction', () => pill.click());
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(pill);
      elsewhere.appendChild(pill);
      let n = heard();
      if (n !== 1) throw new Error(`after a move a click reached it ${n} time(s), want 1`);
      pill.remove();
      n = heard();
      if (n !== 0) throw new Error(`after removal a click still reached it ${n} time(s), want none`);
      elsewhere.appendChild(pill);
      n = heard();
      if (n !== 1) throw new Error(`reinserted after a removal a click reached it ${n} time(s), want 1`);
      passed++;
    } finally {
      pill.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`token-display re-parented: ${e.message}`); }

  {
    const registry = /** @type {any} */ (fileViewerRegistry);
    const realEnsure = registry.ensureInitialized;
    const realResolve = registry.resolve;
    let mounted = 0, torn = 0;
    registry.ensureInitialized = async () => {};
    registry.resolve = () => class { render() { mounted++; return () => { torn++; }; } };
    const view = /** @type {any} */ (document.createElement('file-view'));
    view.showPath = false;
    const live = async () => {
      await new Promise((r) => setTimeout(r, 0));
      return mounted - torn;
    };
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      view.setSource({ path: 'teardown.txt', exists: true, size: 1 });
      column.appendChild(view);
      let n = await live();
      if (n !== 1) throw new Error(`a mounted view holds ${n} live viewer(s), want 1`);
      elsewhere.appendChild(view);
      n = await live();
      if (n !== 1) throw new Error(`after a move it holds ${n} live viewer(s), want 1`);
      view.remove();
      n = await live();
      if (n !== 0) throw new Error(`after removal it holds ${n} live viewer(s), want none`);
      elsewhere.appendChild(view);
      n = await live();
      if (n !== 1) throw new Error(`reinserted after a removal it holds ${n} live viewer(s), want 1`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`file-view re-parented: ${e.message}`);
    } finally {
      view.remove();
      elsewhere.remove();
      delete registry.ensureInitialized;
      delete registry.resolve;
      if (registry.ensureInitialized !== realEnsure) registry.ensureInitialized = realEnsure;
      if (registry.resolve !== realResolve) registry.resolve = realResolve;
    }
  }

  try {
    const dialog = /** @type {any} */ (document.createElement('modal-dialog'));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(dialog);
      const asked = dialog.show({ type: 'confirm', title: 'Teardown', message: 'teardown?' });
      elsewhere.appendChild(dialog);
      const answer = await settledBy(asked);
      if (answer !== null) throw new Error(`a move left its question ${answer === 'pending' ? 'unanswered' : `answered ${answer}`}, want null`);
      // The connect rebuilds the panel empty, so a dialog still marked shown
      // would be a blank modal over the app that nothing is waiting on.
      if (dialog.classList.contains('show')) throw new Error('after a move it still shows a dialog nothing is asking');
      dialog.remove();
      elsewhere.appendChild(dialog);
      const next = dialog.show({ type: 'alert', message: 'teardown again' });
      if (!dialog.classList.contains('show')) throw new Error('reinserted after a removal it shows nothing when asked');
      dialog.querySelector('.modal-backdrop-el').click();
      const dismissed = await settledBy(next);
      if (dismissed !== null) throw new Error(`reinserted, a backdrop click answered ${dismissed}, want null`);
      passed++;
    } finally {
      dialog.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`modal-dialog re-parented: ${e.message}`); }

  try {
    const notice = /** @type {any} */ (document.createElement('update-notice'));
    const vm = {
      present: false, updaterState: null, pct: null, error: null, errorStage: null,
      currentVersion: '1.0.0', targetVersion: '9.9.9', appVersion: null,
      appManagedServer: true, notice: null, serverUpdateAvailable: true, upToDate: false,
    };
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(notice);
      notice.open(vm);
      elsewhere.appendChild(notice);
      if (!notice.isOpen()) throw new Error('a move closed it');
      // closeAllPopups is where Escape and Back both land.
      closeAllPopups();
      if (notice.isOpen()) throw new Error('after a move Escape no longer closes it');
      notice.open(vm);
      notice.remove();
      closeAllPopups();
      if (!notice.isOpen()) throw new Error('a removed notice still answered Escape');
      elsewhere.appendChild(notice);
      closeAllPopups();
      if (notice.isOpen()) throw new Error('reinserted after a removal Escape no longer closes it');
      passed++;
    } finally {
      notice.close();
      notice.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`update-notice re-parented: ${e.message}`); }

  try {
    const widget = /** @type {any} */ (document.createElement('action-confirmation'));
    /** @type {string[]} */
    const answers = [];
    widget.setOptions({
      options: [
        { label: 'Yes', value: 'yes', style: 'primary' },
        { label: "Yes, don't ask again", value: 'always', style: 'secondary', patterns: ['git push *'], rules: [{ tool: 'bash', pattern: 'git push *' }] },
      ],
    }, (/** @type {string} */ v) => answers.push(v), { onRevise: () => null });
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(widget);
      widget.querySelector('.pattern-edit-btn').click();
      const input = widget.querySelector('.pattern-edit-input');
      if (!input || !widget.querySelector('.action-approval-option.editing')) throw new Error('the pencil did not open the pattern editor');
      input.value = 'git pull *';
      elsewhere.appendChild(widget);
      if (widget.querySelector('.pattern-edit-input') !== input || input.value !== 'git pull *') {
        throw new Error('a move threw away the pattern being typed');
      }
      if (!widget.querySelector('.action-approval-option.editing')) throw new Error('a move ended the edit');
      // Chromium (WebView2) blurs a focused element as it is removed, so the
      // input's focusout arrives inside the move; WebKit sends none. Send it
      // by hand so every engine sees what Chromium does.
      input.dispatchEvent(new Event('focusout', { bubbles: true }));
      column.appendChild(widget);
      await Promise.resolve();
      if (!widget.querySelector('.action-approval-option.editing')) throw new Error('the focusout Chromium sends during a move ended the edit');
      // The same focusout with the widget left in place is a click-away.
      input.dispatchEvent(new Event('focusout', { bubbles: true }));
      await Promise.resolve();
      if (widget.querySelector('.action-approval-option.editing')) throw new Error('a click-away left the edit open');
      widget.remove();
      elsewhere.appendChild(widget);
      widget.querySelector('.action-confirmation-button[data-value="yes"]').click();
      if (answers.join(',') !== 'yes') throw new Error(`reinserted, one click answered ${JSON.stringify(answers)}, want ["yes"]`);
      passed++;
    } finally {
      widget.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`action-confirmation re-parented: ${e.message}`); }

  try {
    const metadata = new Set();
    const conversation = {
      processingState: null,
      isTurnActive: () => false,
      observeMetadata: (/** @type {Function} */ fn) => { metadata.add(fn); },
      unobserveMetadata: (/** @type {Function} */ fn) => { metadata.delete(fn); },
    };
    const box = /** @type {any} */ (document.createElement('composer-box'));
    box.isCoarsePointer = () => false;
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      column.appendChild(box);
      box.querySelector('model-selector').setConversation = () => {};
      box.setConversation(conversation);
      // render() defers this a frame, which a macOS or Linux lane never
      // delivers and a Windows one does — so a caller binding it as well must
      // still leave one set.
      box.setupListeners();
      box.setupListeners();
      let toggles = 0, impacts = 0;
      box._commandsPopup.toggle = () => { toggles++; };
      box._updateCacheWarningButton = () => { impacts++; };
      const heard = () => {
        const before = [toggles, impacts];
        box.querySelector('#commands-button').click();
        box.dispatchEvent(new CustomEvent(CONTEXT_CACHE_IMPACT_CHANGED, { detail: { busts: false } }));
        return `${toggles - before[0]} click(s), ${impacts - before[1]} cache event(s) and ${metadata.size} metadata observer(s)`;
      };
      const holdsOne = '1 click(s), 1 cache event(s) and 1 metadata observer(s)';
      let now = heard();
      if (now !== holdsOne) throw new Error(`a mounted box hears ${now}, want 1 of each`);
      const textarea = box.querySelector('textarea');
      textarea.value = 'teardown draft';
      elsewhere.appendChild(box);
      // The draft is restored into the box once per thread, so a move that
      // rebuilt the textarea would lose what was typed for good.
      if (box.querySelector('textarea') !== textarea || textarea.value !== 'teardown draft') {
        throw new Error('a move threw away the textarea and what was typed in it');
      }
      now = heard();
      if (now !== holdsOne) throw new Error(`after a move it hears ${now}, want 1 of each`);
      box.remove();
      now = heard();
      if (now !== '0 click(s), 0 cache event(s) and 0 metadata observer(s)') throw new Error(`after removal it hears ${now}, want none`);
      elsewhere.appendChild(box);
      now = heard();
      if (now !== holdsOne) throw new Error(`reinserted after a removal it hears ${now}, want 1 of each`);
      passed++;
    } finally {
      box.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`composer-box re-parented: ${e.message}`); }

  try {
    const metadata = new Set();
    const session = new Set();
    const threadMap = new Set();
    const container = countingYArray();
    const conversation = {
      id: 'teardown-area-conv',
      getMetadata: () => '',
      observeMetadata: (/** @type {Function} */ fn) => { metadata.add(fn); },
      unobserveMetadata: (/** @type {Function} */ fn) => { metadata.delete(fn); },
      onStatusChange: () => () => {},
      session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } },
    };
    const thread = {
      container,
      items: [],
      threadItemId: 'teardown-area-thread',
      conversation,
      isProcessing: false,
      lastActivityAt: 0,
      getMessages: () => [],
      hasBusyItems: () => false,
      getPendingApprovalMessages: () => [],
    };
    const threadYMap = {
      get: (/** @type {string} */ key) => (key === 'itemId' ? 'teardown-area-thread' : undefined),
      observe: (/** @type {Function} */ fn) => { threadMap.add(fn); },
      unobserve: (/** @type {Function} */ fn) => { threadMap.delete(fn); },
    };
    const area = /** @type {any} */ (document.createElement('conversation-area'));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      // The order the tab's column builder uses: mount, then configure.
      column.appendChild(area);
      area.setMessageThread(thread);
      area.conversation = conversation;
      area.setThreadContext(threadYMap);
      // Its footer and suggestions controller follow the same conversation, so
      // what a mounted column holds is the baseline rather than a constant.
      const mountedMetadata = metadata.size;
      const mountedSession = session.size;
      if (mountedMetadata === 0) throw new Error('a mounted column does not follow its conversation\'s metadata');
      if (mountedSession === 0) throw new Error('a mounted column does not follow its session');

      let selects = 0, hints = 0;
      area._selectItem = () => { selects++; };
      area._handleNewConversationHintChanged = () => { hints++; };
      const wrapper = area.querySelector('conversation-message-list-wrapper');
      const heard = () => {
        const before = [selects, hints];
        area.dispatchEvent(new CustomEvent('select-item-requested', { detail: { messageId: 'x' } }));
        window.dispatchEvent(new Event(GUIDANCE_CHANGED_EVENT));
        const background = countEvents(area, 'item-selected', () => {
          area.querySelector('conversation-message-list-wrapper')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        return `${selects - before[0]} selection request(s), ${hints - before[1]} tips change(s), `
          + `${background} background click(s), ${metadata.size}/${mountedMetadata} metadata, `
          + `${session.size}/${mountedSession} session, ${container.observers.size} container and ${threadMap.size} thread observer(s)`;
      };
      const holdsOne = `1 selection request(s), 1 tips change(s), 1 background click(s), `
        + `${mountedMetadata}/${mountedMetadata} metadata, ${mountedSession}/${mountedSession} session, 1 container and 1 thread observer(s)`;
      let now = heard();
      if (now !== holdsOne) throw new Error(`a mounted column hears ${now}, want ${holdsOne}`);

      elsewhere.appendChild(area);
      // The transcript is redrawn only when the tab hands the column new items,
      // so a move that rebuilt the markup would show an empty column until then.
      if (area.querySelector('conversation-message-list-wrapper') !== wrapper) {
        throw new Error('a move threw away the transcript the column had drawn');
      }
      if (area.conversation !== conversation) throw new Error('a move dropped the column\'s conversation');
      now = heard();
      if (now !== holdsOne) throw new Error(`after a move it hears ${now}, want ${holdsOne}`);

      area.remove();
      now = heard();
      const holdsNone = `0 selection request(s), 0 tips change(s), 0 background click(s), `
        + `0/${mountedMetadata} metadata, 0/${mountedSession} session, 0 container and 0 thread observer(s)`;
      if (now !== holdsNone) throw new Error(`after removal it hears ${now}, want ${holdsNone}`);

      elsewhere.appendChild(area);
      now = heard();
      if (now !== holdsOne) throw new Error(`reinserted after a removal it hears ${now}, want ${holdsOne}`);
      passed++;
    } finally {
      area.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`conversation-area re-parented: ${e.message}`); }

  column.remove();
  return { passed, failed, errors };
}
