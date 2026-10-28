//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop composer's controls row as a design: three outlined shapes — the
 * settings bar (strategy | permissions | model), the tool tray and the Thread
 * pill — then Send.
 *
 *   - Every control on the row is the same height, outer edge to outer edge.
 *   - The three outlined shapes share one border, fill and end radius.
 *   - Every settings segment shows a ▾, so none of them reads as a status line.
 *   - In a narrow column the Thread pill folds to a round icon of that height.
 *
 * Geometry is read from layout (getBoundingClientRect / getComputedStyle),
 * which a lane performs even though it seldom paints. The touch layout is
 * asserted in `unit:mobile-composer`.
 * @module unit-tests/composer-row-test
 */

import { initializeRegistries, createTestSession, createTestConversation, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * Mount a desktop composer-box in a container of the given width, its
 * permissions segment bound to a thread (unbound, it renders nothing).
 * @param {string} width - CSS width of the container.
 * @param {any} thread - The message thread to bind the permissions segment to.
 * @returns {{box: HTMLElement, container: HTMLElement}} The mounted box and its container.
 */
function mountComposer(width, thread) {
  const container = document.createElement('div');
  container.style.cssText = `position:absolute;left:-9999px;top:-9999px;width:${width};height:600px;`;
  const box = /** @type {any} */ (document.createElement('composer-box'));
  box.isCoarsePointer = () => false;
  container.appendChild(box);
  document.body.appendChild(container);
  /** @type {any} */ (box.querySelector('permission-controls')).setMessageThread(thread);
  return { box, container };
}

/**
 * @param {HTMLElement} box
 * @param {string} selector
 * @returns {HTMLElement} The element, asserted present.
 */
function part(box, selector) {
  const el = /** @type {HTMLElement|null} */ (box.querySelector(selector));
  assert(!!el, `the composer must render ${selector}`);
  return /** @type {HTMLElement} */ (el);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const thread = conversation.rootMessageThread;

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {string} width
   * @param {(box: HTMLElement) => void} fn
   */
  const test = (name, width, fn) => {
    const { box, container } = mountComposer(width, thread);
    try {
      fn(box);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      container.remove();
    }
  };

  test('one-height', '900px', (box) => {
    const shapes = {
      'settings bar': part(box, 'input-controls-config'),
      'tool tray': part(box, 'input-controls-actions'),
      'Thread pill': part(box, '.new-thread-btn'),
      'Send': part(box, '#send-button'),
    };
    const heights = Object.entries(shapes).map(([name, el]) => [name, el.getBoundingClientRect().height]);
    const first = /** @type {number} */ (heights[0][1]);
    assert(first > 0, 'the settings bar must be laid out');
    const off = heights.filter(([, h]) => Math.abs(/** @type {number} */ (h) - first) > 0.5);
    assert(off.length === 0,
      `every control on the row must be the same height: ${heights.map(([n, h]) => `${n} ${h}px`).join(', ')}`);

    // The controls inside the bar and the tray fill them rather than float.
    const bar = shapes['settings bar'].getBoundingClientRect();
    assert(part(box, 'input-controls-config .permission-btn').getBoundingClientRect().width > 0,
      'the permissions segment must be on the bar');
    for (const btn of box.querySelectorAll('input-controls-config .input-ctrl-btn, input-controls-actions .input-ctrl-btn')) {
      const r = btn.getBoundingClientRect();
      if (r.width === 0) continue; // hidden on desktop (⋮, expand)
      assert(Math.abs(r.height - (bar.height - 2)) <= 0.5,
        `${btn.className.split(' ')[0]} must fill its shape's inner height (${r.height}px in a ${bar.height}px shape)`);
    }
  });

  test('one-chrome', '900px', (box) => {
    const shapes = [
      part(box, 'input-controls-config'),
      part(box, 'input-controls-actions'),
      part(box, '.new-thread-btn'),
    ];
    const chrome = shapes.map((el) => {
      const cs = getComputedStyle(el);
      return [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, cs.backgroundColor,
        cs.borderTopLeftRadius, cs.borderBottomRightRadius].join(' | ');
    });
    assert(new Set(chrome).size === 1,
      `the bar, the tray and the Thread pill must share one outline, fill and radius:\n  ${chrome.join('\n  ')}`);
    assert(getComputedStyle(shapes[0]).borderTopStyle === 'solid',
      'the shared chrome must have a visible outline at rest');
  });

  test('segments-show-a-chevron', '900px', (box) => {
    for (const sel of ['.strategy-selector-button', '.permission-btn', '.model-selector-button']) {
      const btn = part(box, `input-controls-config ${sel}`);
      const content = getComputedStyle(btn, '::after').content;
      assert(content !== 'none' && content !== 'normal',
        `${sel} must draw a ▾ after its label, got content ${content}`);
    }
  });

  // Inside an outlined bar any slack is visible, so every segment hugs its
  // label: a short model name leaves no empty run after its ▾.
  test('segments-fit-their-labels', '900px', (box) => {
    for (const [sel, label] of [['.model-selector-button', '.model-name'], ['.strategy-selector-button', '.strategy-name']]) {
      const btn = part(box, `input-controls-config ${sel}`);
      /** @type {HTMLElement} */ (part(box, `input-controls-config ${sel} ${label}`)).textContent = 'Flash';
      const last = /** @type {HTMLElement} */ (btn.lastElementChild).getBoundingClientRect();
      const slack = btn.getBoundingClientRect().right - last.right;
      // What legitimately follows the last child: the gap, the ▾ and its
      // margin, then the padding and border. Anything past that is slack.
      const cs = getComputedStyle(btn);
      const chev = getComputedStyle(btn, '::after');
      const expected = [cs.columnGap, chev.width, chev.marginLeft, cs.paddingRight, cs.borderRightWidth]
        .reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
      assert(slack <= expected + 3,
        `${sel} must end just past its label and ▾: ${Math.round(slack)}px after its last child, ${Math.round(expected)}px expected`);
    }
  });

  test('bar-ends-follow-visible-segments', '900px', (box) => {
    const radius = (/** @type {string} */ sel) => {
      const cs = getComputedStyle(part(box, `input-controls-config ${sel}`));
      return { left: parseFloat(cs.borderTopLeftRadius), right: parseFloat(cs.borderTopRightRadius) };
    };
    const strategy = radius('.strategy-selector-button');
    const perm = radius('.permission-btn');
    const model = radius('.model-selector-button');
    assert(strategy.left > 0 && strategy.right === 0, `strategy opens the bar: ${JSON.stringify(strategy)}`);
    assert(perm.left === 0 && perm.right === 0, `permissions sits mid-bar: ${JSON.stringify(perm)}`);
    assert(model.left === 0 && model.right > 0, `model closes the bar: ${JSON.stringify(model)}`);

    // A delegated thread hides the strategy: permissions now opens the bar, and
    // it draws no stray divider before the model's.
    /** @type {HTMLElement} */ (box.querySelector('strategy-selector')).hidden = true;
    const permHidden = radius('.permission-btn');
    assert(permHidden.left > 0 && permHidden.right === 0,
      `with the strategy hidden, permissions must open the bar: ${JSON.stringify(permHidden)}`);
  });

  test('attach-ends-the-tray', '900px', (box) => {
    const attach = part(box, '#attach-button');
    const tray = part(box, 'input-controls-actions');
    assert(attach.parentElement === tray && attach === tray.lastElementChild,
      `the attach button must be the tray's last button, got parent ${attach.parentElement?.tagName}`);
    assert(attach.getBoundingClientRect().width > 0, 'the attach button must be displayed on desktop');
  });

  test('thread-pill-labelled', '900px', (box) => {
    const label = part(box, '.new-thread-btn .new-thread-label');
    assert(label.getBoundingClientRect().width > 0, 'a wide row must show the Thread pill\'s word');
  });

  // Folded (the row too narrow for one line), the bar takes a line of its own,
  // but at its own width: an outline running on past the model segment reads
  // as a stretched, empty control.
  test('folded-bar-hugs-its-segments', '40rem', (box) => {
    const bar = part(box, 'input-controls-config').getBoundingClientRect();
    const tray = part(box, 'input-controls-actions').getBoundingClientRect();
    assert(tray.top >= bar.bottom, 'at 40rem the row must fold, the tray on the line below the bar');
    const last = part(box, 'input-controls-config > model-selector').getBoundingClientRect();
    assert(bar.right - last.right <= 1.5,
      `the folded bar must end at its last segment, not stretch past it (bar ends ${Math.round(bar.right)}, model ends ${Math.round(last.right)})`);
  });

  // Narrowing the column changes one thing at a time. Just past the width where
  // the row stops fitting one line, the tools wrap to the next line and nothing
  // else changes: the bar keeps the width it had on one line, and the Thread
  // pill keeps its word — there is a whole line for it.
  {
    /** @type {Record<string, number>} */
    const wide = {};
    test('wide-reference', '900px', (box) => {
      wide.bar = part(box, 'input-controls-config').getBoundingClientRect().width;
    });
    // 44rem: room for the bar on a line of its own, not for the tools beside it.
    test('wrapping-changes-nothing-else', '44rem', (box) => {
      const bar = part(box, 'input-controls-config').getBoundingClientRect();
      const tray = part(box, 'input-controls-actions').getBoundingClientRect();
      assert(tray.top >= bar.bottom, 'at 44rem the tools must have wrapped below the bar');
      assert(Math.abs(bar.width - wide.bar) <= 1,
        `wrapping must not shrink the bar: ${Math.round(bar.width)}px wrapped vs ${Math.round(wide.bar)}px on one line`);
      assert(part(box, '.new-thread-btn .new-thread-label').getBoundingClientRect().width > 0,
        'with a line of its own, the Thread pill must keep its word');
    });
  }

  test('thread-pill-folds-narrow', '20rem', (box) => {
    const pill = part(box, '.new-thread-btn');
    const label = part(box, '.new-thread-btn .new-thread-label');
    assert(label.getBoundingClientRect().width === 0, 'a narrow row must drop the Thread pill\'s word');
    const r = pill.getBoundingClientRect();
    const send = part(box, '#send-button').getBoundingClientRect();
    assert(Math.abs(r.width - r.height) <= 0.5 && Math.abs(r.height - send.height) <= 0.5,
      `folded, the Thread pill must be a circle the row's height (${r.width}x${r.height}, Send ${send.height})`);
    assert(!!pill.getAttribute('title'), 'folded, the Thread pill must keep its tooltip');
  });

  return { passed, failed, errors };
}
