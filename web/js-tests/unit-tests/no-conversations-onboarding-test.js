//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: what a project with no conversation open shows.
 *
 * Binning the last conversation is allowed (deleting it is not), and it used to
 * leave both the sidebar and the main area blank with no statement of what had
 * happened or what to do. Two things now fill that state, and both must hold:
 *
 *   1. <no-conversations-overlay> shows only when a project is loaded AND no
 *      conversation is open — never in the no-project state, which
 *      <no-project-overlay> owns, or the two would stack. It hides the tab
 *      column (via `body.no-conversations`) but NOT the sidebar, which holds
 *      the button it points at.
 *   2. The conversation bar's "+" always carries its name, and is emphasised
 *      only while the list is empty.
 *
 * Both sessions are stubs: this pins the two components' own show/hide rules,
 * not the bin round-trip that arrives at the state.
 * @module unit-tests/no-conversations-onboarding-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';
import '../../js/components/no-conversations-overlay.js';

/**
 * Minimal stand-in for the session surface the overlay reads: a project path,
 * the conversation map, and a subscription it re-checks itself on.
 * @param {string} projectPath - Loaded project, or '' for the no-project state
 * @param {string[]} conversationIds - Ids to seed the conversation map with
 * @returns {any} Stub session with an `emit(type)` to drive its listeners
 */
function createStubSession(projectPath, conversationIds) {
  /** @type {Array<(event: any) => void>} */
  const listeners = [];
  return {
    projectPath,
    conversations: new Map(conversationIds.map(id => [id, { id, name: id }])),
    binnedCount: 0,
    binSizeBytes: 0,
    visibleConversationId: null,
    /**
     * @param {(event: any) => void} fn - Listener
     * @returns {() => void} Unsubscribe
     */
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /** @param {string} type - Event type to deliver */
    emit(type) {
      for (const fn of [...listeners]) fn({ type });
    },
    /** @returns {number} Live listener count, for the teardown assertion */
    listenerCount() { return listeners.length; }
  };
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
  container.id = 'no-conversations-onboarding-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const overlay = /** @type {any} */ (document.createElement('no-conversations-overlay'));
  container.appendChild(overlay);
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  // The overlay toggles a class on the real <body> (the tab column it hides is
  // a sibling, not a child), so leave that class as it was found.
  const hadClass = document.body.classList.contains('no-conversations');

  try {
    // --- 1: a loaded project with nothing open shows it ---------------------
    const empty = createStubSession('/tmp/project', []);
    overlay.setSession(empty);

    assert(overlay.hidden === false, 'the overlay stayed hidden with no conversation open');
    assert(document.body.classList.contains('no-conversations'),
      'body.no-conversations was not set, so the empty tab column still takes the room');
    assert(!!overlay.querySelector('.onboarding-logo'),
      'no logo in the overlay — the blank panel it replaces was the whole complaint');
    const copy = (overlay.textContent || '').trim();
    assert(copy.includes('New conversation'),
      `the copy should point at the "+ New conversation" button, got "${copy}"`);
    passed++;

    // --- 2: it retires the moment a conversation exists ---------------------
    empty.conversations.set('conv_new', { id: 'conv_new', name: 'Untitled 1' });
    empty.emit('conversation:created');

    assert(overlay.hidden === true, 'the overlay stayed up after a conversation was created');
    assert(!document.body.classList.contains('no-conversations'),
      'body.no-conversations survived the create, so the tab column stays hidden');
    assert((overlay.innerHTML || '').trim() === '',
      'the retired overlay kept its markup, which would paint over the restored tab column');
    passed++;

    // --- 3: and comes back when that conversation is binned -----------------
    empty.conversations.delete('conv_new');
    empty.emit('conversation:deleted');
    assert(overlay.hidden === false, 'binning the last conversation did not bring the overlay back');
    passed++;

    // --- 4: never in the no-project state -----------------------------------
    // Both overlays key off an empty conversation map; only the project path
    // tells them apart. Showing both would stack two logos in one panel.
    const noProject = createStubSession('', []);
    overlay.setSession(noProject);
    assert(overlay.hidden === true,
      'the overlay showed with no project loaded, where <no-project-overlay> belongs');
    assert(!document.body.classList.contains('no-conversations'),
      'body.no-conversations was left set in the no-project state');
    passed++;

    // Re-pointing at another session must drop the first subscription, or a
    // stale session keeps deciding what this element shows.
    assert(empty.listenerCount() === 0,
      `setSession left ${empty.listenerCount()} listener(s) on the previous session`);
    passed++;

    // --- 5: the "+" says what it does while the list is empty ---------------
    // setSession() would spin up per-conversation <conversation-tab> elements
    // and their workers; the button needs none of that, so the session is
    // attached directly and the bar re-rendered against it.
    bar._session = createStubSession('/tmp/project', []);
    bar.render();

    const addBtn = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-add'));
    assert(!!addBtn, 'no add button in the rendered bar');
    assert((addBtn?.textContent || '').trim() === 'New conversation',
      `the empty sidebar's button should name itself, got "${(addBtn?.textContent || '').trim()}"`);
    assert(addBtn?.classList.contains('conversation-add-labelled'),
      'the labelled button is missing the class that emphasises it');
    passed++;

    // --- 6: and keeps its name beside real tabs, losing only the emphasis ----
    bar._session.conversations.set('conv_a', { id: 'conv_a', name: 'First' });
    bar.render();

    const addAfter = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-add'));
    assert(addAfter === addBtn, 'the add button was rebuilt, dropping its click handler');
    assert((addAfter?.textContent || '').trim() === 'New conversation',
      `the button should keep its name beside real tabs, got "${(addAfter?.textContent || '').trim()}"`);
    assert(!addAfter?.classList.contains('conversation-add-labelled'),
      'the empty-list emphasis outlived the empty list');
    passed++;

    // --- 7: and is drawn as the "New workspace or group" button is ---------
    // The two rows that make something in the strip are one style: the same
    // "+" mark before the words, the same dashed outline, corner, padding and
    // type. Compared as computed values, so a rule that drifts on one of them
    // fails here rather than on screen.
    const newWs = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-box-new-button'));
    assert(!!newWs, 'no "New workspace or group" button to compare against');
    assert(!!addAfter?.querySelector('svg'), 'the button has no "+" mark drawn before its words');
    // Every button fades its colour, and this one has just lost the empty
    // list's accent: read where it is going, not a frame of the fade.
    /** @type {HTMLElement} */ (addAfter).style.transition = 'none';
    const a = getComputedStyle(/** @type {HTMLElement} */ (addAfter));
    const w = getComputedStyle(/** @type {HTMLElement} */ (newWs));
    for (const prop of ['border-top-left-radius', 'padding-top', 'padding-left', 'font-size',
      'font-weight', 'color', 'background-color', 'column-gap', 'justify-content']) {
      assert(a.getPropertyValue(prop) === w.getPropertyValue(prop),
        `${prop}: new conversation "${a.getPropertyValue(prop)}", new workspace "${w.getPropertyValue(prop)}"`);
    }
    const aOutline = getComputedStyle(/** @type {HTMLElement} */ (addAfter), '::before').maskImage;
    const wOutline = getComputedStyle(/** @type {HTMLElement} */ (newWs), '::before').maskImage;
    assert(!!wOutline && wOutline !== 'none' && aOutline === wOutline,
      `the dashed outline differs: "${aOutline}" vs "${wOutline}"`);
    passed++;

  } catch (error) {
    failed++;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    document.body.classList.toggle('no-conversations', hadClass);
    container.remove();
  }

  return { passed, failed, errors };
}
