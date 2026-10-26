//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the approval card's strategy hint (services/approval-hint.js).
 * Someone who has approved calls by hand twice in one turn is offered, on the
 * third card, the strategies that would approve for them, and one click
 * switches to one.
 *
 * The card is drawn by `_appendApprovalButtons` against a fake thread, as
 * tool-action-render-test does, so no conversation is needed.
 * @module unit-tests/approval-hint
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { userApprovalsThisTurn, hintStrategyIds } from '../../js/services/approval-hint.js';
import '../../js/components/tool-action-message.js';
import '../../js/components/action-confirmation.js';

/**
 * @param {Record<string, any>} fields
 * @returns {{get: (k: string) => any}} A Y.Map-like item
 */
function fakeItem(fields) {
  const m = new Map(Object.entries(fields));
  return { get: (k) => m.get(k) };
}

/**
 * A turn: the user's message, then `approved` calls approved by hand, then the
 * card under test, parked.
 * @param {number} approved - Calls approved by hand before the card
 * @returns {Array<{get: (k: string) => any}>} The thread's items
 */
function turn(approved) {
  const items = [
    fakeItem({ itemId: 'old', type: 'tool-action', approvalSource: 'user', approvalResponse: 'yes' }),
    fakeItem({ itemId: 'u', type: 'user' })
  ];
  for (let i = 0; i < approved; i++) {
    items.push(fakeItem({ itemId: `a${i}`, type: 'tool-action', approvalSource: 'user', approvalResponse: i % 2 ? 'yes-always' : 'yes' }));
  }
  items.push(fakeItem({ itemId: 'by-rule', type: 'tool-action', approvalSource: 'rule', approvalResponse: 'yes' }));
  items.push(fakeItem({
    itemId: 'card', type: 'tool-action', toolUseId: 't-card', toolName: 'bash', state: 'pending',
    approvalOptions: { options: [{ label: 'Yes', value: 'yes', style: 'primary' }, { label: 'No', value: 'no', style: 'secondary' }] }
  }));
  return items;
}

/**
 * Draw the card's approval box for the last item of `items`.
 * @param {any[]} items - The thread's items
 * @param {string} strategyId - The thread's effective strategy
 * @returns {{container: HTMLElement, picked: string[]}} The box, and the strategies a click asked for
 */
function drawCard(items, strategyId) {
  /** @type {string[]} */
  const picked = [];
  const el = /** @type {any} */ (document.createElement('tool-action-message'));
  el._getMessageThread = () => ({
    items,
    conversation: {},
    getEffectiveStrategyId: () => strategyId,
    setStrategy: (/** @type {string} */ id) => { picked.push(id); }
  });
  el._hintStrategies = () => [
    { id: 'default', manifest: { name: 'Default' } },
    { id: 'auto-approve', manifest: { name: 'Auto-approve' } },
    { id: 'yolo', manifest: { name: 'YOLO' } }
  ];
  const container = document.createElement('div');
  container.className = 'action-approval-container';
  document.body.appendChild(container);
  el._appendApprovalButtons(container, items[items.length - 1]);
  return { container, picked };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {HTMLElement[]} */
  const made = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      made.splice(0).forEach((el) => el.remove());
    }
  };

  await run('only this turn\'s approvals by hand are counted', () => {
    const n = userApprovalsThisTurn(turn(2), 'card');
    assert(n === 2, `expected 2 (the earlier turn and the rule's approval are not counted), got ${n}`);
  });

  await run('the hint offers only strategies that ask less', () => {
    const all = [{ id: 'default' }, { id: 'auto-approve' }, { id: 'yolo' }];
    const cases = /** @type {Array<[string, any[], string[]]>} */ ([
      ['default', all, ['auto-approve', 'yolo']],
      ['plan', all, ['auto-approve', 'yolo']],
      ['auto-approve', all, ['yolo']],
      ['yolo', all, []],
      ['default', [{ id: 'default' }, { id: 'yolo' }], ['yolo']]
    ]);
    for (const [current, available, want] of cases) {
      const got = hintStrategyIds(current, available);
      assert(JSON.stringify(got) === JSON.stringify(want), `under ${current}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  });

  await run('no hint before the user has approved twice in the turn', () => {
    const { container } = drawCard(turn(1), 'default');
    made.push(container);
    assert(!container.querySelector('.approval-strategy-hint'), 'the hint showed after one approval');
    assert(!!container.querySelector('action-confirmation'), 'the buttons were not drawn');
  });

  await run('the third card offers the strategies, and a click switches', () => {
    const { container, picked } = drawCard(turn(2), 'default');
    made.push(container);
    const hint = container.querySelector('.approval-strategy-hint');
    assert(!!hint, 'no hint on the third card');
    const links = [...container.querySelectorAll('[data-strategy-id]')].map((a) => a.getAttribute('data-strategy-id'));
    assert(JSON.stringify(links) === JSON.stringify(['auto-approve', 'yolo']), `offered ${JSON.stringify(links)}`);
    const buttons = container.querySelector('action-confirmation');
    assert(!!buttons && !!(/** @type {Element} */ (hint).compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_PRECEDING),
      'the hint must sit below the buttons');
    /** @type {HTMLElement} */ (container.querySelector('[data-strategy-id="yolo"]')).click();
    assert(JSON.stringify(picked) === JSON.stringify(['yolo']), `the click asked for ${JSON.stringify(picked)}`);
  });

  await run('no hint under YOLO', () => {
    const { container } = drawCard(turn(3), 'yolo');
    made.push(container);
    assert(!container.querySelector('.approval-strategy-hint'), 'the hint showed under YOLO');
  });

  await run('under en-XA the hint shows only translated text', async () => {
    await underPseudoLocale('approval-hint-test', () => {
      const { container } = drawCard(turn(2), 'default');
      made.push(container);
      const hint = /** @type {Element} */ (container.querySelector('.approval-strategy-hint'));
      assert(!!hint, 'no hint to check');
      // The strategy names are their extensions' text, and the key is a key.
      assertPseudoLocalized(hint, { skip: '[data-strategy-id], kbd', where: 'strategy hint' });
    });
  });

  return { passed, failed, errors };
}
