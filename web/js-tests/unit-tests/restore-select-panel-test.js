//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: selecting a conversation whose panel host doesn't exist yet.
 *
 * The sidebar row and the panel are built by two different mechanisms —
 * `render()` paints a row for every `session.conversations` entry, while the
 * `<conversation-tab>` host is built from `conversation:created`. Anything that
 * seeds the map outside that notify — a session load's stubs, a worker-manager
 * hydration, a merge on refresh — leaves a clickable row whose host is absent.
 * Activating a missing host used to be a silent no-op that still hid every
 * other tab: a blank page with no way back but a reload.
 *
 * What must hold:
 *
 *   1. Selecting a mapped conversation with no host builds one, so something is
 *      always activated.
 *   2. That host shows the loading overlay rather than an empty panel, and the
 *      previously-visible tab is parked — the switch really happened.
 *   3. An `error` stub (a restore whose load failed and never notified) is
 *      selectable too, and offers its retry.
 *   4. The later `conversation:created` rebinds the existing host instead of
 *      leaking a second one into the container.
 *
 * The session and conversations are stubs: this pins the bar's own
 * row/host reconciliation, not the restore round-trip.
 * @module unit-tests/restore-select-panel-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';
import '../../js/components/conversation-tab.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * Minimal stand-in for a Conversation as `_createConversationTab` and
 * `setActive` see it: an identity, a load state, a session to subscribe to, and
 * a status feed.
 * @param {any} session - Owning stub session
 * @param {string} id - Conversation id
 * @param {string} name - Display name
 * @param {'unloaded'|'loading'|'loaded'|'error'} loadState - Lazy-load state
 * @returns {any} Stub conversation
 */
function createStubConversation(session, id, name, loadState) {
  return {
    id,
    name,
    session,
    loadState,
    startStatusObserver() {},
    /** @returns {() => void} Unsubscribe */
    onStatusChange() { return () => {}; }
  };
}

/**
 * @returns {any} Stub session exposing the map and subscribe() the bar needs.
 */
function createStubSession() {
  const session = {
    /** @type {Map<string, any>} */
    conversations: new Map(),
    bin: { count: 0, sizeBytes: 0 },
    /** @type {string|null} */
    visibleConversationId: null,
    /** @type {string[]} */
    retried: [],
    /**
     * @param {() => void} _fn - Event handler (never invoked by these tests)
     * @returns {() => void} Unsubscribe
     */
    subscribe(_fn) { return () => {}; },
    /** @param {string} id - Conversation whose load should be retried */
    retryConversationLoad(id) { session.retried.push(id); }
  };
  return session;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.id = 'restore-select-panel-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:800px;height:600px;';
  const tabsContainer = document.createElement('conversation-tabs-container');
  container.appendChild(tabsContainer);
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  try {
    const session = createStubSession();
    const staying = createStubConversation(session, 'conv_staying', 'Staying', 'loaded');
    session.conversations.set(staying.id, staying);
    session.visibleConversationId = staying.id;

    bar._session = session;
    bar._findTabsContainer();
    bar._initializeConversationTabs();

    const stayingTab = bar._tabElements.get('conv_staying');
    assert(!!stayingTab, 'the already-loaded conversation never got a host');
    assert(stayingTab.classList.contains('is-active'), 'the visible conversation was not activated');

    // --- 1: selecting a host-less mapped conversation builds its host -------
    // The stub is in the map (so the bar renders a row for it) but
    // `conversation:created` has not fired for it.
    const restored = createStubConversation(session, 'conv_restored', 'Restored', 'unloaded');
    session.conversations.set(restored.id, restored);
    session.visibleConversationId = restored.id;
    bar._showTab('conv_restored');

    const restoredTab = bar._tabElements.get('conv_restored');
    assert(!!restoredTab, 'selecting a restored conversation built no panel host — blank page');
    assert(restoredTab.parentElement === tabsContainer,
      'the host was built but never parented into the tabs container');
    assert(restoredTab.classList.contains('is-active'), 'the newly-built host was not activated');
    assert(restoredTab.getConversation() === restored, 'the host was not bound to its conversation');
    assert(bar.getTabElement('conv_restored') === restoredTab, 'the bar does not answer for the host it built');
    passed++;

    // --- 2: it shows the loading overlay, and the old tab is parked ---------
    assert(!!restoredTab.querySelector('.conversation-tab-loading-overlay'),
      'a still-loading conversation rendered an empty panel instead of the spinner');
    assert(!stayingTab.classList.contains('is-active') && stayingTab.classList.contains('hidden'),
      'the previously-visible tab was not parked by the switch');
    passed++;

    // --- 3: an error stub is selectable and offers its retry ----------------
    // A load that failed leaves loadState='error', and nothing further is coming
    // for it, so this row would otherwise be dead forever.
    const broken = createStubConversation(session, 'conv_broken', 'Broken', 'error');
    session.conversations.set(broken.id, broken);
    session.visibleConversationId = broken.id;
    bar._showTab('conv_broken');

    // A first activation paints the spinner up front and defers the resync a
    // macrotask, so the error state (and its Retry) arrives on the next tick.
    await new Promise(resolve => setTimeout(resolve, 0));

    const brokenTab = bar._tabElements.get('conv_broken');
    assert(!!brokenTab, 'a failed-load conversation could not be selected at all');
    const retry = /** @type {HTMLButtonElement|null} */ (
      brokenTab.querySelector('.conversation-tab-loading-retry')
    );
    assert(!!retry, 'the failed-load panel offered no way to retry');
    retry?.click();
    assert(session.retried.length === 1 && session.retried[0] === 'conv_broken',
      `Retry did not ask the session to reload: ${JSON.stringify(session.retried)}`);
    passed++;

    // --- 4: the later `conversation:created` rebinds, it doesn't duplicate --
    const before = tabsContainer.querySelectorAll('conversation-tab').length;
    restored.loadState = 'loaded';
    bar._handleConversationCreated(restored);
    assert(tabsContainer.querySelectorAll('conversation-tab').length === before,
      'the created event leaked a second host for an already-built conversation');
    assert(bar._tabElements.get('conv_restored') === restoredTab,
      'the created event replaced the live host instead of rebinding it');
    passed++;

    // Selecting something the session doesn't have must stay a no-op rather
    // than conjuring an empty panel.
    bar._showTab('conv_never_existed');
    assert(!bar._tabElements.has('conv_never_existed'),
      'an unknown conversation id built a host out of nothing');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`restore-select-panel: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    container.remove();
  }

  // --- en-XA: every loading-overlay state is translated --------------------
  // The overlay is drawn on a detached tab (no connectedCallback, no columns),
  // then moved under the document so its spinner connects and labels itself.
  // Retry still reaches the session's (stubbed) retry under en-XA.
  try {
    const session = createStubSession();
    /** @type {string[]} */
    const raw = [];
    /** @type {Record<string, number>} */
    const counts = {};
    await underPseudoLocale('restore-select-panel-test', () => {
      for (const state of /** @type {const} */ (['error', 'loading', 'unloaded'])) {
        const tab = /** @type {any} */ (document.createElement('conversation-tab'));
        tab._conversation = createStubConversation(session, `conv_${state}`, 'Overlay', state);
        tab._renderLoadingOverlay(state);
        const overlay = /** @type {HTMLElement|null} */ (tab.querySelector('.conversation-tab-loading-overlay'));
        assert(!!overlay, `no overlay drawn for loadState '${state}'`);
        const holder = document.createElement('div');
        document.body.appendChild(holder);
        try {
          holder.appendChild(/** @type {HTMLElement} */ (overlay));
          const shown = shownStrings(holder);
          counts[state] = shown.length;
          for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${state}: ${s}`);
          if (state === 'error') {
            /** @type {HTMLButtonElement|null} */ (holder.querySelector('.conversation-tab-loading-retry'))?.click();
          }
        } finally {
          holder.remove();
        }
      }
    });
    assert(counts.error >= 2 && counts.loading >= 1 && counts.unloaded >= 1,
      `expected shown text in every state, saw ${JSON.stringify(counts)}`);
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    assert(session.retried.length === 1 && session.retried[0] === 'conv_error',
      `Retry did not ask the session to reload under en-XA: ${JSON.stringify(session.retried)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`restore-select-panel en-XA overlay: ${/** @type {any} */ (e)?.message || e}`);
  }

  return { passed, failed, errors };
}
