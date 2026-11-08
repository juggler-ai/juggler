//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Transaction-view + header-token-chip render rules.
 *
 * The transaction view answers two questions in a fixed order: what did the
 * model say (output, first — it is the answer), and what was it given (input,
 * second — reference material). The input arrives as one row per message so
 * "what is eating the context" is readable at a glance, each row carrying its
 * estimated share; a row builds its body only when opened. Long strings render
 * as text, never as a JSON-escaped single line.
 *
 * The properties-panel header carries the item's own size in a standard slot.
 * It is an estimate unless the provider's reported output can only mean this
 * one item — provider counts are per round-trip, and a round-trip usually
 * produces several.
 *
 * The view itself is a lens on the properties column beside it: it follows the
 * selection rather than pinning one round-trip, and closes only when the chain
 * stops ending in a properties column.
 * @module unit-tests/transaction-panel-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { renderTransactionDetail } from '../../js/components/transaction-detail-renderer.js';
import { ColumnSelectionState } from '../../js/utils/column-selection.js';
import '../../js/components/properties-panel.js';
import { setLocale } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Open a row and wait for the body its `toggle` handler builds.
 *
 * The browser dispatches `toggle` on a task of its own, so there is no fixed
 * number of ticks that means "it has run" — under load the event arrives
 * several behind, and yielding a set number of times reads that as a body
 * that was never built.
 * @param {HTMLDetailsElement} row - The row to open.
 * @returns {Promise<void>} Resolves once the body is there, or gives up so the
 *   caller's assertion can report the absence itself.
 */
const openRow = async (row) => {
  row.open = true;
  await waitFor(() => !!row.querySelector('.tx-row-body'), {
    description: 'the opened row to build its body',
  }).catch(() => {});
};

/**
 * A round-trip blob with one of everything the view has to render.
 * @returns {any} Transaction blob.
 */
function makeBlob() {
  return {
    id: 'txn_test',
    duration: 1234,
    inputTokens: 1000,
    outputTokens: 42,
    stopReason: 'end_turn',
    modelConfig: { provider: 'mock', model: 'mock-model' },
    input: {
      systemPrompt: 'You are a code agent.\nYou read before you write.',
      tools: [{ name: 'read' }, { name: 'edit' }],
      messages: [
        { type: 'user', content: 'Fix the panel' },
        { type: 'tool-use', toolUseId: 't1', toolName: 'read', toolInput: { file_path: '/tmp/x.js' } },
        { type: 'tool-result', toolUseId: 't1', content: 'line one\nline two\n'.repeat(20) },
        { type: 'assistant', content: 'Done.' },
      ],
    },
    output: { blocks: [{ type: 'text', content: 'All fixed.\nReally.' }] },
  };
}

/**
 * Render a blob into a detached container.
 * @param {any} blob - Transaction blob.
 * @returns {HTMLElement} The container holding the rendered view.
 */
function render(blob) {
  const host = document.createElement('div');
  renderTransactionDetail(host, blob);
  return host;
}

/**
 * A stand-in conversation item with the given fields.
 * @param {Record<string, any>} fields - Item fields, read through `.get`.
 * @returns {any} Y.Map-shaped stub.
 */
function fakeItem(fields) {
  return { get: (/** @type {string} */ key) => fields[key] };
}

/**
 * A never-connected properties panel with the first of `fields` selected.
 * @param {Record<string, any>} fields - Fields of the selected item.
 * @param {Record<string, any>[]} [siblings] - Other items in the same thread.
 * @returns {any} The stubbed panel.
 */
function panelWithItem(fields, siblings = []) {
  const panel = /** @type {any} */ (document.createElement('properties-panel'));
  const items = [fakeItem({ itemId: 'item-1', ...fields })]
    .concat(siblings.map((f, i) => fakeItem({ itemId: `sibling-${i}`, ...f })));
  panel._selectedItemId = 'item-1';
  panel._messageThread = { items, getContextItem: () => undefined };
  return panel;
}

/**
 * Split a computed `rgb()`/`rgba()` colour into channels plus alpha.
 * @param {string} color - A computed colour string.
 * @returns {{r: number, g: number, b: number, a: number}} Channels 0..255 and alpha 0..1.
 */
function parseColor(color) {
  const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) || []).map(Number);
  return { r, g, b, a };
}

/**
 * Relative luminance of a computed colour, per WCAG. Alpha is ignored: a
 * see-through colour is judged on its own hue, and the caller checks
 * separately that there is any colour there at all.
 * @param {string} color - A computed colour string.
 * @returns {number} Relative luminance in 0..1.
 */
function luminance(color) {
  const { r, g, b } = parseColor(color);
  const channel = (/** @type {number} */ c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two computed colours.
 * @param {string} a - First colour.
 * @param {string} b - Second colour.
 * @returns {number} Contrast ratio, 1..21.
 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A stubbed conversation item as the column chain sees it.
 * @param {string} itemId - Item id.
 * @param {string} type - Item type.
 * @param {string} [transactionId] - Round-trip the item belongs to.
 * @returns {any} Y.Map-shaped stub.
 */
function chainItem(itemId, type, transactionId = '') {
  return fakeItem({ itemId, type, transactionId });
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('output comes first and the last-message duplicate is gone', () => {
    const host = render(makeBlob());
    const titles = Array.from(host.querySelectorAll('.properties-panel-subtitle'))
      .map((el) => el.textContent);
    assert(titles.length === 2, `expected 2 sections, got ${titles.length}: ${titles.join(', ')}`);
    assert(titles[0] === 'LLM Output', `output must come first, got "${titles[0]}"`);
    assert(titles[1] === 'LLM Input', `input must come second, got "${titles[1]}"`);
    assert(!host.textContent.includes('Last Message'),
      'the Last Message section duplicated the end of the input and must not return');
  });

  await run('input lists system prompt, tools and one row per message', () => {
    const host = render(makeBlob());
    const kinds = Array.from(host.querySelectorAll('.tx-row-kind')).map((el) => el.textContent);
    // Four wire messages, with the tool-result folded into its tool-use.
    assert(kinds.join('|') === 'system prompt|tools|user|tool-use|assistant',
      `unexpected rows: ${kinds.join('|')}`);
    const sizes = Array.from(host.querySelectorAll('.tx-row-size')).map((el) => el.textContent);
    assert(sizes.length === kinds.length, 'every row carries an estimated size');
    assert(sizes.every((s) => s.startsWith('~')), `estimates must be marked: ${sizes.join(', ')}`);
  });

  await run('the tool-use row is labelled with its tool and argument', () => {
    const host = render(makeBlob());
    const label = Array.from(host.querySelectorAll('.tx-row'))
      .find((row) => row.querySelector('.tx-row-kind').textContent === 'tool-use')
      .querySelector('.tx-row-label').textContent;
    assert(label === 'read · /tmp/x.js', `expected "read · /tmp/x.js", got "${label}"`);
  });

  await run('only the final message is open, and bodies are built on demand', async () => {
    const host = render(makeBlob());
    const rows = Array.from(host.querySelectorAll('.tx-row'));
    const open = rows.filter((r) => /** @type {HTMLDetailsElement} */ (r).open);
    assert(open.length === 1 && open[0] === rows[rows.length - 1],
      'the final message opens by default — it is what the round-trip answered');
    const collapsed = rows[0];
    assert(!collapsed.querySelector('.tx-row-body'),
      'a collapsed row must not build its body until it is opened');
    await openRow(/** @type {HTMLDetailsElement} */ (collapsed));
    assert(!!collapsed.querySelector('.tx-row-body'), 'opening a row builds its body');
  });

  await run('multi-line text renders as text, not as an escaped one-liner', async () => {
    const host = render(makeBlob());
    const systemRow = /** @type {HTMLDetailsElement} */ (host.querySelector('.tx-row'));
    await openRow(systemRow);
    const text = systemRow.querySelector('.tx-text');
    assert(!!text, 'the system prompt renders as a text block');
    assert(text.textContent.includes('\n'), 'its line breaks survive');
    assert(!text.textContent.includes('\\n'), 'and are not shown as escape sequences');
  });

  await run('output blocks render as their own kind', () => {
    const host = render(makeBlob());
    const kind = host.querySelector('.tx-out-kind');
    assert(kind?.textContent === 'text', `expected a text block, got "${kind?.textContent}"`);
    const body = host.querySelector('.tx-out-block .tx-text');
    assert(body.textContent === 'All fixed.\nReally.', 'output text keeps its line breaks');
  });

  await run('a missing blob says so without breaking', () => {
    const host = render(null);
    assert(host.textContent.trim() !== '', 'a missing blob renders nothing at all');
  });

  await run('an item that never had a round-trip says that instead', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, null, 'Not part of a round-trip.');
    assert(host.textContent.trim() === 'Not part of a round-trip.',
      `a missing blob and no blob to miss are different facts, got "${host.textContent}"`);
  });

  await run('a blob whose input was stripped still renders everything else', () => {
    // Binning a conversation drops the replayed history from its blobs — it is
    // ~99% of the bytes, and doc.yjs already holds every one of them — leaving
    // the rest. A restored conversation's round-trips are this shape, so they
    // have to stay readable without the input rather than fall back to the
    // missing-blob placeholder.
    const stripped = { ...makeBlob(), timestamp: Date.now() };
    delete stripped.input;
    const host = render(stripped);

    assert(host.textContent.includes('No input recorded.'),
      `expected the stripped input to say so, got "${host.textContent.slice(0, 120)}"`);
    assert(!host.textContent.includes('No transaction data.'),
      'a stripped blob is not a missing one');

    const chips = [...host.querySelectorAll('.meta-item')].map((c) => c.textContent);
    const expected = ['Tokens: 1k in → 42 out', 'Duration: 1.23s', 'Stop: end_turn', 'Model: mock-model'];
    for (const chip of expected) {
      assert(chips.includes(chip), `expected chip "${chip}", got ${JSON.stringify(chips)}`);
    }
    assert(chips.some((c) => c.startsWith('Time: ')), `expected a Time chip, got ${JSON.stringify(chips)}`);

    const body = host.querySelector('.tx-out-block .tx-text');
    assert(body?.textContent === 'All fixed.\nReally.',
      'the model output is what the strip keeps, and it still renders');
  });

  await run('the header chip estimates the selected item', () => {
    const panel = panelWithItem({ type: 'user', content: 'x'.repeat(400) });
    const chip = panel._buildTokenChip();
    assert(!!chip, 'an item with content gets a chip');
    assert(chip.textContent === '~100', `400 chars is ~100 tokens, got "${chip.textContent}"`);
    assert(!chip.classList.contains('token-high') && !chip.classList.contains('token-critical'),
      'an ordinary item stays neutral');
  });

  await run('a tool-action is measured by its arguments plus its result', () => {
    const panel = panelWithItem({
      type: 'tool-action',
      toolInput: { file_path: '/tmp/x.js' },
      result: { content: 'y'.repeat(200_000) },
    });
    const chip = panel._buildTokenChip();
    assert(chip.textContent === '~50k', `expected ~50k, got "${chip.textContent}"`);
    assert(chip.classList.contains('token-critical'),
      'an item this size earns the loudest chip');
  });

  await run('an item that contributes nothing carries no chip', () => {
    const panel = panelWithItem({ type: 'user', content: '' });
    assert(panel._buildTokenChip() === undefined, 'no text means no chip');
  });

  await run('the chip lands in the standard header slot', () => {
    const panel = panelWithItem({ type: 'assistant', content: 'z'.repeat(80) });
    const section = panel._createSectionWithControls('Assistant', { color: 'green' });
    const chip = section.querySelector('.properties-panel-header .properties-panel-token-chip');
    assert(!!chip, 'the header carries the chip for every item type');
    assert(chip.textContent === '~20', `80 chars is ~20 tokens, got "${chip.textContent}"`);
  });

  await run('a long header wraps inside a narrow properties column', () => {
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:12.5rem;padding:1rem;box-sizing:border-box;';
    const header = panel._createHeader(
      'A Needlessly Elaborate Property Panel Header',
      { color: 'slate' },
      panelWithItem({ type: 'assistant', content: 'z'.repeat(80) })._buildTokenChip()
    );
    host.appendChild(header);
    document.body.appendChild(host);
    try {
      const badge = /** @type {HTMLElement} */ (header.querySelector('.context-item-type-badge'));
      assert(header.scrollWidth <= header.clientWidth + 1,
        `header overflowed its ${header.clientWidth}px column to ${header.scrollWidth}px`);
      assert(badge.scrollWidth <= badge.clientWidth + 1,
        `badge text overflowed its ${badge.clientWidth}px box to ${badge.scrollWidth}px`);
      assert(badge.clientHeight > parseFloat(getComputedStyle(badge).lineHeight),
        `long badge stayed on one ${badge.clientHeight}px line instead of wrapping`);
    } finally {
      host.remove();
    }
  });

  await run('the reported count replaces the estimate for a lone output item', () => {
    const panel = panelWithItem(
      { type: 'assistant', content: 'z'.repeat(80), transactionId: 'txn-1' },
      // The user message that prompted the turn shares the id but sits on the
      // input side, so it does not make the output count ambiguous.
      [{ type: 'user', content: 'go', transactionId: 'txn-1' }]
    );
    panel._blobOutputTokens.set('txn-1', 1234);
    // Counts follow the UI's formatting locale, which otherwise defaults to the
    // machine's — a comma in en-US, nothing at all in the POSIX locale a bare CI
    // machine reports. Pinned here so the assertion can name the exact text.
    const previousLocale = setLocale('en-US');
    try {
      const chip = panel._buildTokenChip();
      assert(chip.textContent === '1,234',
        `the provider's own number, unmarked, got "${chip.textContent}"`);
      assert(chip.title.includes('reported by the provider'),
        `the tooltip must say whose number it is, got "${chip.title}"`);
      // A locale that groups differently proves the chip follows the setting
      // rather than happening to agree with the machine.
      setLocale('de-DE');
      const german = panel._buildTokenChip();
      assert(german.textContent === '1.234', `German grouping, got "${german.textContent}"`);
    } finally {
      setLocale(previousLocale);
    }
  });

  await run('a round-trip that produced more than one item keeps the estimate', () => {
    const panel = panelWithItem(
      { type: 'assistant', content: 'z'.repeat(80), transactionId: 'txn-1' },
      [{ type: 'tool-action', toolInput: { q: 'x' }, transactionId: 'txn-1' }]
    );
    panel._blobOutputTokens.set('txn-1', 1234);
    assert(panel._buildTokenChip().textContent === '~20',
      'the turn\'s output covers both items, so neither may claim it');
  });

  await run('a tool-action never takes the reported output count', () => {
    const panel = panelWithItem({
      type: 'tool-action',
      toolInput: { file_path: '/tmp/x.js' },
      result: { content: 'y'.repeat(800) },
      transactionId: 'txn-1',
    });
    panel._blobOutputTokens.set('txn-1', 1234);
    const chip = panel._buildTokenChip();
    assert(chip.textContent.startsWith('~'),
      `most of a tool-action's cost is its result, which no provider reports, got "${chip.textContent}"`);
  });

  await run('the transaction header reads in both themes', () => {
    const root = document.documentElement;
    const wasTheme = root.dataset.theme;
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    document.body.appendChild(panel);
    try {
      // An empty round-trip id renders wholly synchronously: no blob to fetch.
      panel.setTransaction('conv-1', '');
      const iconBox = panel.querySelector('.properties-panel-header .message-icon-box');
      const badge = panel.querySelector('.properties-panel-header .context-item-type-badge');
      assert(!!iconBox && !!badge, 'the transaction panel has its own header badge');

      const parts = /** @type {[string, Element][]} */ ([['icon', iconBox], ['lozenge', badge]]);
      for (const theme of ['dark', 'light']) {
        root.dataset.theme = theme;
        for (const [what, el] of parts) {
          const style = getComputedStyle(el);
          // A colour name with no `.color-*` preset behind it leaves the box
          // with no background at all, which no contrast ratio can catch: the
          // glyph is then white on whatever the panel happens to be.
          assert(parseColor(style.backgroundColor).a > 0,
            `the header ${what} has no background in ${theme} — its colour preset is missing`);
          const ratio = contrast(style.color, style.backgroundColor);
          assert(ratio >= 3,
            `the header ${what} is unreadable in ${theme}: ${style.color} on `
            + `${style.backgroundColor} is ${ratio.toFixed(2)}:1`);
        }
      }
    } finally {
      panel.remove();
      if (wasTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = wasTheme;
    }
  });

  await run('the transaction column follows the selection instead of closing', () => {
    const assistant = chainItem('a1', 'assistant', 'txn-1');
    const other = chainItem('a2', 'assistant', 'txn-2');
    const plain = chainItem('c1', 'context');
    const rootThread = { container: {}, items: [assistant, other, plain] };
    const isThread = () => false;

    const state = new ColumnSelectionState();
    state.selectItem(0, 'a1');
    state.openTransaction(1);

    let chain = state.resolveColumnChain(rootThread, isThread);
    assert(chain.length === 3 && chain[2].type === 'transaction',
      'opening it appends a transaction column after the properties panel');
    assert(chain[2].transactionId === 'txn-1', `got "${chain[2].transactionId}"`);

    state.selectItem(0, 'a2');
    chain = state.resolveColumnChain(rootThread, isThread);
    assert(chain.length === 3 && chain[2].transactionId === 'txn-2',
      'selecting another item re-targets the column rather than dropping it');

    state.selectItem(0, 'c1');
    chain = state.resolveColumnChain(rootThread, isThread);
    assert(chain.length === 3 && chain[2].transactionId === '',
      'an item belonging to no round-trip leaves the column open and empty');

    state.clearSelection(0);
    chain = state.resolveColumnChain(rootThread, isThread);
    assert(chain.length === 1 && !state.txnOpen,
      'losing the properties column is what closes it');
  });

  await run('closing returns focus to the panel that owns the toggle', () => {
    const state = new ColumnSelectionState();
    state.selectItem(0, 'a1');
    state.openTransaction(1);
    assert(state.activeColumnIndex === 2, 'opening focuses the new column so it scrolls into view');
    state.closeTransaction(1);
    assert(!state.txnOpen && state.activeColumnIndex === 1,
      'closing leaves focus on the properties panel, not past the shortened chain');
  });

  return { passed, failed, errors };
}
