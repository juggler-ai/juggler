//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <juggler-nudge> (`components/juggler-nudge.js`), the one view for guidance,
 * over an engine built here from a catalogue of its own:
 *   1. Nothing to show: the element is hidden and empty.
 *   2. A hint is drawn as its copy, its buttons and ×; drawing a teaching hint
 *      starts its clock.
 *   3. Re-handing the same context does not rebuild — a button being pressed
 *      must not be replaced under the pointer.
 *   4. × dismisses through the engine, and the hint goes.
 *   5. A command button runs that command through the slash-command handler,
 *      against the context's thread.
 *   6. A compact hint is its buttons alone.
 *   7. The command-menu button asks the column for it, by a bubbling event.
 *   8. Under en-XA a real catalogue hint shows no English.
 * @module unit-tests/juggler-nudge-test
 */

import { COMMAND_MENU_REQUESTED_EVENT } from '../../js/components/juggler-nudge.js';
import { createNudgeEngine } from '../../js/services/guidance/nudge-engine.js';
import { NUDGES } from '../../js/services/guidance/nudge-catalogue.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { waitFor } from '../utilities/test-helpers.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  /**
   * @param {boolean} cond
   * @param {string} what
   */
  const check = (cond, what) => { if (!cond) throw new Error(what); };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:800px;';
  document.body.appendChild(host);

  /** @type {any[]} */
  const CATALOGUE = [
    { id: 'teach', kind: 'teach', surface: 'test', title: 'Teach title', body: 'Teach body', when: (/** @type {any} */ c) => c.mode === 'teach',
      actions: [{ label: 'Open menu', run: 'open-slash-menu' }] },
    { id: 'situ', kind: 'situational', surface: 'test', title: 'Situ title', body: 'Situ body', scope: 'conversation',
      when: (/** @type {any} */ c) => c.mode === 'situ', compactWhen: (/** @type {any} */ u) => u.any('slash:'),
      actions: [{ label: 'Probe', command: 'nudge-probe' }] },
  ];

  /**
   * An element over a fresh engine, mounted.
   * @param {{counts?: Record<string, number>, user?: any, catalogue?: any[], surface?: string}} [opts]
   * @returns {{el: any, store: {user: any}}} The element and its engine's stored state.
   */
  const mount = ({ counts = {}, user = null, catalogue = CATALOGUE, surface = 'test' } = {}) => {
    const store = { user };
    const engine = createNudgeEngine({
      catalogue,
      usage: {
        count: (e) => counts[e] ?? 0,
        any: (p) => Object.entries(counts).some(([k, n]) => k.startsWith(p) && n > 0),
        isVeteran: () => false,
      },
      user: { load: () => store.user, save: (s) => { store.user = JSON.parse(JSON.stringify(s)); } },
      project: { load: () => null, save: () => {} },
    });
    const el = /** @type {any} */ (document.createElement('juggler-nudge'));
    el.setAttribute('surface', surface);
    el.engine = {
      nudgeFor: engine.nudgeFor,
      noteShown: engine.noteShown,
      dismiss: (/** @type {string} */ id, /** @type {any} */ ctx) => { engine.dismiss(id, ctx); el.refresh(); },
      runAction: engine.runAction,
    };
    host.appendChild(el);
    return { el, store };
  };

  try {
    await run('1: nothing to show', () => {
      const { el } = mount();
      el.context = { mode: 'none' };
      check(el.hidden === true, 'hidden');
      check(el.childElementCount === 0, 'and empty');
      check(el.getAttribute('role') === 'status', 'a status role');
    });

    await run('2: a hint drawn whole; a teaching one starts its clock', () => {
      const { el, store } = mount();
      el.context = { mode: 'teach' };
      check(el.hidden === false, 'shown');
      check(el.querySelector('.juggler-nudge__title')?.textContent === 'Teach title', 'title');
      check(el.querySelector('.juggler-nudge__body')?.textContent === 'Teach body', 'body');
      check(el.querySelectorAll('.juggler-nudge__action').length === 1, 'one action');
      check(!!el.querySelector('.juggler-nudge__dismiss'), 'a dismiss button');
      check(typeof store.user?.started?.teach === 'number', 'its clock started');
    });

    await run('3: the same context does not rebuild', () => {
      const { el } = mount();
      el.context = { mode: 'teach' };
      const btn = el.querySelector('.juggler-nudge__action');
      el.context = { mode: 'teach' };
      el.refresh();
      check(el.querySelector('.juggler-nudge__action') === btn, 'the button survives a re-hand');
    });

    await run('4: × dismisses', () => {
      const { el, store } = mount();
      el.context = { mode: 'teach' };
      /** @type {HTMLElement} */ (el.querySelector('.juggler-nudge__dismiss')).click();
      check(el.hidden === true, 'gone');
      check(typeof store.user?.dismissed?.teach === 'number', 'stored as dismissed');
    });

    await run('5: a command button sends the command as if typed, on the thread', async () => {
      /** @type {any[][]} */
      const sent = [];
      const thread = /** @type {any} */ ({ threadItemId: 'msg_7' });
      thread.conversation = { sendMessage: async (/** @type {any[]} */ ...args) => { sent.push(args); return null; } };
      const { el } = mount();
      el.context = { mode: 'situ', thread, conversationId: 'c1' };
      /** @type {HTMLElement} */ (el.querySelector('.juggler-nudge__action')).click();
      await waitFor(() => sent.length > 0, { description: 'the command to be sent' });
      check(sent.length === 1, 'sent once');
      check(sent[0][0] === '/nudge-probe', `as its slash command, got ${JSON.stringify(sent[0][0])}`);
      check(sent[0][1] === 'msg_7' && sent[0][2] === thread, 'on the context\u2019s thread');
    });

    await run('6: compact is buttons alone', () => {
      const { el } = mount({ counts: { 'slash:compact': 1 } });
      el.context = { mode: 'situ' };
      check(el.hidden === false, 'shown');
      check(!el.querySelector('.juggler-nudge__text'), 'no copy');
      check(!el.querySelector('.juggler-nudge__dismiss'), 'no ×');
      check(el.querySelectorAll('.juggler-nudge__action').length === 1, 'its button');
      check(el.classList.contains('juggler-nudge--compact'), 'marked compact');
    });

    await run('7: the command-menu button bubbles a request', () => {
      const { el } = mount();
      el.context = { mode: 'teach' };
      let asked = 0;
      const onAsk = () => { asked++; };
      host.addEventListener(COMMAND_MENU_REQUESTED_EVENT, onAsk);
      try {
        /** @type {HTMLElement} */ (el.querySelector('.juggler-nudge__action')).click();
      } finally {
        host.removeEventListener(COMMAND_MENU_REQUESTED_EVENT, onAsk);
      }
      check(asked === 1, 'one request reached the host');
    });

    await run('8: en-XA', async () => {
      await underPseudoLocale('juggler-nudge-test', async () => {
        // Two teaching dismissals bring the catalogue's own off-switch offer.
        const { el } = mount({ catalogue: [...NUDGES], user: { dismissed: {}, started: {}, teachDismissals: 2 }, surface: 'footer' });
        el.context = {};
        check(el.hidden === false, 'the offer is shown');
        // × is a glyph, not a word; its name is the aria-label checked below.
        assertPseudoLocalized(el, { skip: '.juggler-nudge__dismiss', atLeast: 3, where: 'nudge' });
        const label = el.querySelector('.juggler-nudge__dismiss')?.getAttribute('aria-label') ?? '';
        check(label !== 'Dismiss hint', `the dismiss label is translated: ${label}`);
      });
    });
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
