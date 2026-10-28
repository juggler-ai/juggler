//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop composer's layout as a design. Inside the bubble, one row: the
 * tool tray, the Thread pill and Send, all at the right-hand end. Under the
 * bubble, the status line: strategy and permissions from the left, the model
 * at the right end, as quiet text buttons.
 *
 *   - Every control on the row is the same height, outer edge to outer edge,
 *     and the tray and the Thread pill share one border, fill and end radius.
 *   - The row never wraps; the status line never wraps.
 *   - Every status-line control shows a ▾, so none of them reads as a label.
 *   - Narrowing sheds detail — the permission counts, then the strategy's
 *     name, the Thread pill's word — and never pushes a control past the edge.
 *
 * Geometry is read from layout (getBoundingClientRect / getComputedStyle),
 * which a lane performs even though it seldom paints. The touch layout is
 * asserted in `unit:mobile-composer`.
 * @module unit-tests/composer-row-test
 */

import { initializeRegistries, createTestSession, createTestConversation, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/** A realistic worst case for each status-line label. */
const LONG = {
  model: 'Claude Sonnet 4.5 (CLI)',
  strategy: 'Aprobación automática',
  detail: ' · 11 comandos · 4 rutas',
};

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
 * The left and right edges of an element's content box.
 * @param {HTMLElement} el
 * @returns {{left: number, right: number}} Content-box edges in viewport px.
 */
function contentEdges(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    left: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
    right: r.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0),
  };
}

/**
 * Give every status-line label its long form. Written straight into the
 * rendered labels: the layout is what is under test, not where the text came
 * from, and a re-render cannot intervene in a synchronous test.
 * @param {HTMLElement} box
 */
function fillLong(box) {
  part(box, 'composer-status-line .model-name').textContent = LONG.model;
  part(box, 'composer-status-line .strategy-name').textContent = LONG.strategy;
  const btn = part(box, 'composer-status-line .permission-btn');
  let detail = btn.querySelector('.permission-detail');
  if (!detail) {
    detail = document.createElement('span');
    detail.className = 'permission-detail';
    btn.appendChild(detail);
  }
  detail.textContent = LONG.detail;
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
      'tool tray': part(box, 'input-controls-actions'),
      'Thread pill': part(box, '.new-thread-btn'),
      'Send': part(box, '#send-button'),
    };
    const heights = Object.entries(shapes).map(([name, el]) => [name, el.getBoundingClientRect().height]);
    const first = /** @type {number} */ (heights[0][1]);
    assert(first > 0, 'the tool tray must be laid out');
    const off = heights.filter(([, h]) => Math.abs(/** @type {number} */ (h) - first) > 0.5);
    assert(off.length === 0,
      `every control on the row must be the same height: ${heights.map(([n, h]) => `${n} ${h}px`).join(', ')}`);

    // The tray's buttons fill it rather than float.
    for (const btn of box.querySelectorAll('input-controls-actions .input-ctrl-btn')) {
      const r = btn.getBoundingClientRect();
      if (r.width === 0) continue; // hidden on desktop (⋮, expand)
      assert(Math.abs(r.height - (first - 2)) <= 0.5,
        `${btn.className.split(' ')[0]} must fill the tray's inner height (${r.height}px in a ${first}px tray)`);
    }
  });

  test('one-chrome', '900px', (box) => {
    const shapes = [part(box, 'input-controls-actions'), part(box, '.new-thread-btn')];
    const chrome = shapes.map((el) => {
      const cs = getComputedStyle(el);
      return [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, cs.backgroundColor,
        cs.borderTopLeftRadius, cs.borderBottomRightRadius].join(' | ');
    });
    assert(new Set(chrome).size === 1,
      `the tray and the Thread pill must share one outline, fill and radius:\n  ${chrome.join('\n  ')}`);
    assert(getComputedStyle(shapes[0]).borderTopStyle === 'solid',
      'the shared chrome must have a visible outline at rest');
  });

  // The row is one right-aligned group: tray, Thread, Send, a gap apart, with
  // the free space all on the left.
  test('tools-sit-by-send', '900px', (box) => {
    const row = contentEdges(part(box, 'composer-box-wrapper'));
    const tray = part(box, 'input-controls-actions').getBoundingClientRect();
    const pill = part(box, '.new-thread-btn').getBoundingClientRect();
    const send = part(box, '#send-button').getBoundingClientRect();
    assert(Math.abs(send.right - row.right) <= 1,
      `Send must end the row (Send ends ${Math.round(send.right)}, row ends ${Math.round(row.right)})`);
    assert(pill.left - tray.right <= 12 && pill.left >= tray.right,
      `the tray must sit just before the Thread pill, ${Math.round(pill.left - tray.right)}px apart`);
    assert(tray.left - row.left > 200,
      `the free space must be left of the tray (tray starts ${Math.round(tray.left - row.left)}px into the row)`);
    assert(Math.abs(tray.top - send.top) <= 0.5 && Math.abs(pill.top - send.top) <= 0.5,
      'the tray, the Thread pill and Send must share one line');
  });

  test('settings-under-the-box', '900px', (box) => {
    const line = part(box, 'composer-status-line');
    const homed = Array.from(line.children).map((el) => el.tagName.toLowerCase());
    assert(homed.join(' ') === 'strategy-selector permission-controls model-selector',
      `the status line must hold strategy, permissions and model in that order, got: ${homed.join(' ') || '(empty)'}`);
    assert(!box.querySelector('input-controls strategy-selector, input-controls permission-controls, input-controls model-selector'),
      'the controls row must hold none of the settings');
    assert(line.getBoundingClientRect().top >= part(box, 'composer-box-wrapper').getBoundingClientRect().bottom - 0.5,
      'the status line must sit below the bubble');

    // Strategy opens the line at the left, the model closes it at the right.
    const edges = contentEdges(line);
    const strategy = part(box, 'composer-status-line .strategy-selector-button').getBoundingClientRect();
    const model = part(box, 'composer-status-line .model-selector-button').getBoundingClientRect();
    assert(Math.abs(strategy.left - edges.left) <= 1, 'the strategy must open the status line at its left edge');
    assert(Math.abs(model.right - edges.right) <= 1,
      `the model must close the status line at its right edge (model ends ${Math.round(model.right)}, line ends ${Math.round(edges.right)})`);
  });

  test('settings-show-a-chevron', '900px', (box) => {
    for (const sel of ['.strategy-selector-button', '.permission-btn', '.model-selector-button']) {
      const content = getComputedStyle(part(box, `composer-status-line ${sel}`), '::after').content;
      assert(content !== 'none' && content !== 'normal',
        `${sel} must draw a ▾ after its label, got content ${content}`);
    }
  });

  test('wide-keeps-every-label', '900px', (box) => {
    fillLong(box);
    for (const sel of ['.permission-detail', '.strategy-name', '.model-name']) {
      const el = part(box, `composer-status-line ${sel}`);
      assert(el.getBoundingClientRect().width > 0, `a wide column must show ${sel}`);
      assert(el.scrollWidth <= el.clientWidth + 1, `a wide column must show ${sel} whole, not ellipsised`);
    }
    assert(part(box, '.new-thread-btn .new-thread-label').getBoundingClientRect().width > 0,
      'a wide row must show the Thread pill\'s word');
  });

  // Every width a column can take, with every label at its longest: no control
  // on the row or the status line may lie past the edge it belongs inside,
  // and neither line may wrap — down to 20rem. Below that the row has less
  // room than its circles need, and Send may drop under the tray; the status
  // line still holds one line.
  for (const width of ['900px', '40rem', '32rem', '28rem', '24rem', '20rem', '12.5rem']) {
    const oneRow = width !== '12.5rem';
    test(`nothing-spills@${width}`, width, (box) => {
      fillLong(box);
      const row = contentEdges(part(box, 'composer-box-wrapper'));
      const line = contentEdges(part(box, 'composer-status-line'));
      /** @type {string[]} */
      const spilled = [];
      for (const [scope, edges] of /** @type {const} */ ([['input-controls', row], ['composer-status-line', line]])) {
        const visible = Array.from(box.querySelectorAll(`${scope} button`))
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0);
        for (const { el, rect } of visible) {
          if (rect.left < edges.left - 0.5 || rect.right > edges.right + 0.5) {
            spilled.push(`${el.className.split(' ')[0]} in ${scope} (${Math.round(rect.left)}–${Math.round(rect.right)}, edge ${Math.round(edges.left)}–${Math.round(edges.right)})`);
          }
        }
        const tops = new Set(visible.map(({ rect }) => Math.round(rect.top + rect.height / 2)));
        if (oneRow || scope === 'composer-status-line') {
          assert(tops.size <= 1, `${scope} must stay one line at ${width}, got ${tops.size}`);
        }
      }
      assert(spilled.length === 0, `at ${width} every control must stay inside its edge: ${spilled.join('; ')}`);
    });
  }

  // Narrowing sheds the permission counts first, and the model gives way
  // before the strategy loses its name.
  test('narrow-sheds-counts-first', '28rem', (box) => {
    fillLong(box);
    assert(part(box, 'composer-status-line .permission-detail').getBoundingClientRect().width === 0,
      'a narrow status line must drop the permission counts');
    assert(part(box, 'composer-status-line .model-name').getBoundingClientRect().width > 0,
      'the model must keep some of its name');
  });

  test('attach-ends-the-tray', '900px', (box) => {
    const attach = part(box, '#attach-button');
    const tray = part(box, 'input-controls-actions');
    assert(attach.parentElement === tray && attach === tray.lastElementChild,
      `the attach button must be the tray's last button, got parent ${attach.parentElement?.tagName}`);
    assert(attach.getBoundingClientRect().width > 0, 'the attach button must be displayed on desktop');
  });

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
