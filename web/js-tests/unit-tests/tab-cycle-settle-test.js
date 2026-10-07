//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Keyboard tab cycling (Page Up/Down, ⌥⌘↑/↓, Ctrl+Tab, ↑/↓ in the tab list)
 * moves the strip's highlight at once but shows the conversation only once the
 * keys have settled. Showing a conversation is the expensive half — its
 * transcript is laid out and every session listener runs — and paying that for
 * each tab a burst of presses merely passes through is what made rapid cycling
 * judder.
 *
 * The session is a stub that records switches, so what is pinned is when the
 * bar asks for one and for which conversation.
 * @module unit-tests/tab-cycle-settle-test
 */

import { assert } from '../utilities/test-helpers.js';
import { CYCLE_SETTLE_MS } from '../../js/components/conversation-bar.js';

/**
 * The session surface render() and a switch touch, over conversations a–d with
 * `a` on screen.
 * @returns {any} The stub, with a `switches` log.
 */
function stubSession() {
  const session = {
    workspaces: [],
    conversations: new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, name: id }])),
    bin: { count: 0, sizeBytes: 0 },
    selection: null,
    loadedConversationId: 'a',
    visibleConversationId: 'a',
    /** @type {string[]} */
    switches: [],
    switchConversation(/** @type {string} */ id) {
      session.switches.push(id);
      session.loadedConversationId = id;
      session.visibleConversationId = id;
      return true;
    },
  };
  return session;
}

/**
 * @param {number} ms
 * @returns {Promise<void>} Resolves after `ms`.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {any} bar
 * @returns {string|undefined} The conversation the strip marks as selected.
 */
const highlighted = (bar) =>
  /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-tab.active'))?.dataset.conversationId;

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // The bar's keyboard setup looks up <conversation-tabs-container/> in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  // Straight to the bar's handler for the `juggler:cycle-tab` event every cycle
  // key raises, so no other bar on the test page hears it.
  /**
   * @param {'next'|'prev'} direction
   * @returns {void}
   */
  const press = (direction) => bar._handleCycleTab(new CustomEvent('juggler:cycle-tab', { detail: { direction } }));

  /**
   * @param {string} label
   * @param {(session: any) => Promise<void>} fn
   */
  const run = async (label, fn) => {
    const session = stubSession();
    bar._session = session;
    bar.render();
    try {
      await fn(session);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      bar._cancelCycle?.();
    }
  };

  try {
    await run('a burst of cycle presses shows only the tab it lands on, once', async (session) => {
      for (let i = 0; i < 3; i++) {
        press('next');
      }
      assert(session.switches.length === 0,
        `nothing may be shown while the keys are still moving — got [${session.switches.join()}]`);
      assert(highlighted(bar) === 'd',
        `the strip must follow every press at once, landing on d — got ${highlighted(bar)}`);

      await sleep(CYCLE_SETTLE_MS + 150);
      assert(session.switches.join() === 'd',
        `once settled, exactly the landing tab is shown — got [${session.switches.join()}]`);
      assert(highlighted(bar) === 'd', `and the strip stays on it — got ${highlighted(bar)}`);
    });

    await run('stepping back from a pending tab is relative to the highlight, not the screen', async (session) => {
      press('next');
      press('next');
      press('prev');
      await sleep(CYCLE_SETTLE_MS + 150);
      assert(session.switches.join() === 'b', `a → c → b must show b — got [${session.switches.join()}]`);
    });

    await run('cycling follows the order the strip draws, boxes included', async (session) => {
      // w1 was bumped to the head of the flat order by activity, but it lives in
      // a box drawn after b, so the strip reads a, b, [w1, w2].
      session.workspaces = [{ id: 'ws', label: 'W', providerId: 'group', state: 'ready', place: 'b' }];
      session.conversations = new Map([
        ['w1', { id: 'w1', name: 'w1', workspaceId: 'ws' }],
        ['a', { id: 'a', name: 'a' }],
        ['b', { id: 'b', name: 'b' }],
        ['w2', { id: 'w2', name: 'w2', workspaceId: 'ws' }],
      ]);
      bar.render();
      const drawn = [...bar.querySelectorAll('.conversation-tab')]
        .map((tab) => /** @type {HTMLElement} */ (tab).dataset.conversationId).join();
      assert(drawn === 'a,b,w1,w2', `the strip must draw a,b,w1,w2 — got ${drawn}`);

      /** @type {string[]} */
      const visited = [];
      for (let i = 0; i < 4; i++) {
        press('next');
        visited.push(String(highlighted(bar)));
      }
      assert(visited.join() === 'b,w1,w2,a', `next from a must walk the strip b,w1,w2,a — got ${visited.join()}`);
      for (let i = 0; i < 4; i++) press('prev');
      assert(highlighted(bar) === 'a', `four prevs must come back to a — got ${highlighted(bar)}`);
      press('prev');
      assert(highlighted(bar) === 'w2', `prev from a wraps to the last drawn tab, w2 — got ${highlighted(bar)}`);
    });

    await run('a click mid-burst wins, and the burst does not land afterwards', async (session) => {
      press('next');
      bar._switchConversation('d');
      await sleep(CYCLE_SETTLE_MS + 150);
      assert(session.switches.join() === 'd',
        `the click is shown and the abandoned cycle target is not — got [${session.switches.join()}]`);
      bar.render();
      assert(highlighted(bar) === 'd', `the strip marks what was clicked — got ${highlighted(bar)}`);
    });
  } finally {
    bar._cancelCycle?.();
    container.remove();
  }

  return { passed, failed, errors };
}
