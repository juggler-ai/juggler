//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop composer's layout. Inside the bubble, one row: the tool tray,
 * the Thread pill and Send. Under the bubble, the status line: strategy,
 * permissions and the model.
 *
 *   - The row never wraps; the status line never wraps.
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

  test('settings-under-the-box', '900px', (box) => {
    const line = part(box, 'composer-status-line');
    const homed = Array.from(line.children).map((el) => el.tagName.toLowerCase());
    assert(homed.join(' ') === 'strategy-selector permission-controls model-selector',
      `the status line must hold strategy, permissions and model in that order, got: ${homed.join(' ') || '(empty)'}`);
    assert(!box.querySelector('input-controls strategy-selector, input-controls permission-controls, input-controls model-selector'),
      'the controls row must hold none of the settings');
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
    assert(!!pill.getAttribute('title'), 'folded, the Thread pill must keep its tooltip');
  });

  return { passed, failed, errors };
}
