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
 *   2. The conversation bar's "+" always carries its name, is emphasised
 *      only while the list is empty, and is laid out as a row of the list —
 *      as is "New workspace or group", and both shorten rather than wrap in a
 *      narrow strip.
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
    const fullName = (/** @type {HTMLElement|null} */ b) => (b?.querySelector('.conversation-box-new-label-full')?.textContent || '').trim();
    assert(fullName(addBtn) === 'New conversation',
      `the empty sidebar's button should name itself, got "${fullName(addBtn)}"`);
    assert(addBtn?.classList.contains('conversation-add-labelled'),
      'the labelled button is missing the class that emphasises it');
    passed++;

    // --- 6: and keeps its name beside real tabs, losing only the emphasis ----
    bar._session.conversations.set('conv_a', { id: 'conv_a', name: 'First' });
    bar.render();

    const addAfter = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-add'));
    assert(addAfter === addBtn, 'the add button was rebuilt, dropping its click handler');
    assert(fullName(addAfter) === 'New conversation',
      `the button should keep its name beside real tabs, got "${fullName(addAfter)}"`);
    assert(!addAfter?.classList.contains('conversation-add-labelled'),
      'the empty-list emphasis outlived the empty list');
    passed++;

    // --- 7: both "+" rows are drawn as rows of the list they add to --------
    // "New conversation" and "New workspace or group" are laid out as tabs: no
    // outline of their own, the mark standing in the status circle's column and
    // the words starting where the names do, at a tab's height and type.
    // Measured against a real tab, so a rule that drifts on either side fails
    // here rather than on screen.
    const tab = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-tab'));
    const circle = /** @type {HTMLElement|null} */ (tab?.querySelector('.conversation-tab-status') ?? null);
    const tabName = /** @type {HTMLElement|null} */ (tab?.querySelector('.conversation-tab-name') ?? null);
    assert(!!tab && !!circle && !!tabName, 'no rendered tab to line the buttons up against');
    const circleRect = /** @type {HTMLElement} */ (circle).getBoundingClientRect();
    const nameLeft = /** @type {HTMLElement} */ (tabName).getBoundingClientRect().left;
    const tabHeight = /** @type {HTMLElement} */ (tab).getBoundingClientRect().height;
    const near = (/** @type {number} */ x, /** @type {number} */ y) => Math.abs(x - y) < 0.5;
    const newWs = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-box-new-button'));
    assert(!!newWs, 'no "New workspace or group" button in the rendered bar');
    for (const [what, button] of /** @type {Array<[string, HTMLElement]>} */ (
      [['New conversation', addAfter], ['New workspace or group', newWs]])) {
      const mark = /** @type {SVGElement|null} */ (button.querySelector('svg'));
      const label = /** @type {HTMLElement|null} */ (button.querySelector('.conversation-box-new-label'));
      assert(!!mark && !!label, `${what}: no "+" mark and label`);
      const markRect = /** @type {SVGElement} */ (mark).getBoundingClientRect();
      assert(near(markRect.left + markRect.width / 2, circleRect.left + circleRect.width / 2),
        `${what}: the "+" is not centred on the status circle's column: ${markRect.left}+${markRect.width}/2 vs ${circleRect.left}+${circleRect.width}/2`);
      const labelLeft = /** @type {HTMLElement} */ (label).getBoundingClientRect().left;
      assert(near(labelLeft, nameLeft), `${what}: the words do not start where tab names do: ${labelLeft} vs ${nameLeft}`);
      const height = button.getBoundingClientRect().height;
      assert(near(height, tabHeight), `${what}: the row is not a tab's height: ${height} vs ${tabHeight}`);
      const outline = getComputedStyle(button, '::before').maskImage;
      assert(!outline || outline === 'none', `${what}: still draws a dashed outline: "${outline}"`);
      assert(getComputedStyle(button).fontSize === getComputedStyle(/** @type {HTMLElement} */ (tabName)).fontSize,
        `${what}: the words are not set in the tab names' size`);
    }
    passed++;

    // --- 8: a narrow strip shortens the words, and never wraps them --------
    // Each row says the whole of what it makes while that fits on one line,
    // then the short form ("Conversation", "Workspace/Group"), and below even
    // that's width cuts it with an ellipsis as a tab's name is cut. Swept
    // across every width the panel can be dragged through, and measured
    // against the words' own width, so the switch can neither come too late
    // (full words cut off) nor much too early (short words with room to spare).
    const rows = /** @type {Array<[string, string, HTMLElement]>} */ (
      [['New conversation', 'Conversation', addAfter], ['New workspace or group', 'Workspace/Group', newWs]]);
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const shown = (/** @type {Element|null} */ el) => !!el && getComputedStyle(el).display !== 'none';
    /**
     * Width of `text` set as the row's words are, on one line.
     * @param {HTMLElement} button - The row's button, whose type the text takes.
     * @param {string} text - The words to measure.
     * @returns {number} Width in px.
     */
    const naturalWidth = (button, text) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
      probe.textContent = text;
      button.appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    const savedWidth = bar.style.width;
    try {
      for (let rem = 8; rem <= 20; rem += 0.25) {
        bar.style.width = `${rem}rem`;
        for (const [full, short, button] of rows) {
          const label = /** @type {HTMLElement} */ (button.querySelector('.conversation-box-new-label'));
          const fullEl = button.querySelector('.conversation-box-new-label-full');
          const shortEl = button.querySelector('.conversation-box-new-label-short');
          assert((shortEl?.textContent || '') === short, `${full}: the short form reads "${shortEl?.textContent}", not "${short}"`);
          assert(shown(fullEl) !== shown(shortEl), `${full} at ${rem}rem: shows ${shown(fullEl) ? 'both' : 'neither'} forms of its words`);
          const cs = getComputedStyle(button);
          const room = button.getBoundingClientRect().right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)
            - label.getBoundingClientRect().left;
          const fullWidth = naturalWidth(button, full);
          if (shown(fullEl)) {
            assert(fullWidth <= room + 0.5,
              `${full} at ${rem}rem: the full words (${fullWidth}px) are shown in ${room}px and cut off — the short form should be showing`);
          } else {
            assert(fullWidth > room - remPx,
              `${full} at ${rem}rem: the short form shows with ${room}px of room for ${fullWidth}px of full words`);
          }
          assert(near(button.getBoundingClientRect().height, tabHeight),
            `${full} at ${rem}rem: the row wrapped to ${button.getBoundingClientRect().height}px, a tab is ${tabHeight}px`);
          const ls = getComputedStyle(label);
          assert(ls.whiteSpace === 'nowrap' && ls.textOverflow === 'ellipsis' && ls.overflow === 'hidden',
            `${full}: words that still do not fit are not ellipsised (white-space ${ls.whiteSpace}, text-overflow ${ls.textOverflow}, overflow ${ls.overflow})`);
        }
      }
      // A new window's strip is wide enough for both rows in full.
      bar.style.width = '';
      for (const [full, , button] of rows) {
        assert(shown(button.querySelector('.conversation-box-new-label-full')),
          `${full}: the strip's default width (${bar.getBoundingClientRect().width}px) shows the short form`);
      }
    } finally {
      bar.style.width = savedWidth;
    }
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
