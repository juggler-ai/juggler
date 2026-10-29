//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Quoting a code selection into the composer.
 *
 * Three things, in the order they happen: the format a reference is written in
 * ({@link formatCodeReference}), turning a DOM selection over line-numbered code
 * into one ({@link resolveCodeSelection}), and putting the result into the
 * composer without touching what was already being written
 * ({@link insertCodeReference}).
 *
 * The format is the part with a second caller — review feedback builds the same
 * block from a saved comment — so most of what is asserted here is about the
 * string, including that the `juggler/item-utils` worker facade serves the same
 * function rather than silently lacking it.
 * @module unit-tests/composer-selection-quote
 */

import { formatCodeReference } from '../../sdk/lib/context-item-utils.js';
import { formatCodeReference as workerFormatCodeReference } from '../../sdk/item-utils-worker.js';
import { resolveCodeSelection } from '../../js/utils/code-selection.js';
import { insertCodeReference } from '../../js/components/composer-paste-tokens.js';

/**
 * @param {boolean} cond - The condition under test.
 * @param {string} msg - What failed, if it did.
 * @param {string[]} errors - Where failures accumulate.
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * A line-numbered code block as `renderLineNumberedCode` leaves one, under a
 * host carrying the path a reference should print.
 * @param {string} path - The path to advertise.
 * @param {string[]} lines - One string per rendered row.
 * @param {{absolute?: boolean, firstLine?: number}} [options] - Whether the path
 *   is out of project root, and the line number of the first row.
 * @returns {HTMLElement} The host, already in the document.
 */
function buildCodeHost(path, lines, options = {}) {
  const host = document.createElement('div');
  host.setAttribute('data-code-ref-path', path);
  if (options.absolute) host.setAttribute('data-code-ref-absolute', '');

  const code = document.createElement('code');
  const first = options.firstLine ?? 1;
  lines.forEach((text, i) => {
    const row = document.createElement('span');
    row.className = 'ci-line';
    row.dataset.line = String(first + i);
    row.textContent = text;
    code.appendChild(row);
  });
  host.appendChild(code);
  document.body.appendChild(host);
  return host;
}

/**
 * Select from a character offset in one row to a character offset in another.
 * @param {HTMLElement} host - The code host.
 * @param {number} startRow - Index of the row the selection starts in.
 * @param {number} startOffset - Character offset within that row's text.
 * @param {number} endRow - Index of the row the selection ends in.
 * @param {number} endOffset - Character offset within that row's text.
 * @returns {Selection|null} The live selection.
 */
function selectRows(host, startRow, startOffset, endRow, endOffset) {
  const rows = host.querySelectorAll('.ci-line');
  const range = document.createRange();
  range.setStart(rows[startRow].firstChild || rows[startRow], startOffset);
  range.setEnd(rows[endRow].firstChild || rows[endRow], endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection;
}

/**
 * A stand-in composer: everything `insertAtCaret` and its settle step reach for,
 * and nothing else. A real `composer-box` needs a conversation behind it, and
 * what is under test here is where the text lands, not who owns the box.
 * @param {string} value - The draft already in the box.
 * @param {number} caret - Where the caret sits in it.
 * @returns {{composer: any, textarea: HTMLTextAreaElement, persisted: () => number}} The stand-in.
 */
function buildComposerStub(value, caret) {
  const host = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.value = value;
  host.appendChild(textarea);
  document.body.appendChild(host);
  textarea.setSelectionRange(caret, caret);

  let persists = 0;
  const composer = /** @type {any} */ (host);
  composer._pasteBlobs = new Map();
  composer._pasteLastValue = value;
  composer._pasteLastCaret = caret;
  composer.autoResize = () => {};
  composer._updateSendButtonState = () => {};
  composer._persistDraft = () => { persists++; };
  return { composer, textarea, persisted: () => persists };
}

/**
 * Run the selection-quote suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} r - 1 for a pass, 0 for a failure. */
  const tally = (r) => { if (r) passed += r; else failed += 1; };

  // === The reference format ===

  tally(check(
    formatCodeReference({ path: 'web/js/app.js', startLine: 60, lines: ['  doThing();'] })
      === './web/js/app.js:60\n>   doThing();\n',
    'format: a one-line reference is path:line, the quote, and a trailing newline', errors));

  tally(check(
    formatCodeReference({ path: 'web/js/app.js', startLine: 60, endLine: 62, lines: ['a', 'b', 'c'] })
      === './web/js/app.js:60-62\n> a\n> b\n> c\n',
    'format: a span names both ends', errors));

  tally(check(
    formatCodeReference({ path: 'web/js/app.js', startLine: 60, endLine: 60, lines: ['a'] })
      === './web/js/app.js:60\n> a\n',
    'format: a span of one line omits the range', errors));

  tally(check(
    formatCodeReference({ path: 'web/js/app.js', lines: ['a'] }) === './web/js/app.js\n> a\n',
    'format: a whole-file reference has no line part', errors));

  tally(check(
    formatCodeReference({ path: 'web/js/app.js', startLine: 85, side: 'new', lines: ['x();'] })
      === './web/js/app.js:85 (new)\n> x();\n',
    'format: a side marker follows the line part', errors));

  tally(check(
    !formatCodeReference({ path: 'a.js', startLine: 1, side: 'either', lines: ['x'] }).includes('('),
    'format: an unrecognised side is not printed', errors));

  tally(check(
    formatCodeReference({ path: '/etc/hosts', outOfRoot: true, startLine: 1, lines: ['x'] })
      === '/etc/hosts:1\n> x\n',
    'format: a path outside the project is absolute and unprefixed', errors));

  // The quote is a reminder; the range is the precise part. Bounding one must
  // never narrow the other.
  const bounded = formatCodeReference({
    path: 'a.js', startLine: 115, endLine: 121,
    lines: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
  });
  tally(check(bounded.startsWith('./a.js:115-121\n'),
    'format: a bounded quote still names the full span', errors));
  tally(check(bounded === './a.js:115-121\n> one\n> two\n> \u2026\n',
    'format: an elided quote ends in a single ellipsis line', errors));

  const wide = formatCodeReference({ path: 'a.js', startLine: 1, lines: ['x'.repeat(400)] });
  tally(check(wide.includes('\u2026\n') && wide.length < 200,
    'format: a very long line is cut at a column bound and marked', errors));

  tally(check(
    formatCodeReference({ path: 'a.js', startLine: 1, lines: ['> already quoted'] })
      === './a.js:1\n> > already quoted\n',
    'format: a quoted line that starts with > simply gains another', errors));

  tally(check(
    formatCodeReference({ path: 'a.js', startLine: 1, endLine: 2, lines: ['', 'x   '] })
      === './a.js:1-2\n>\n> x\n',
    'format: a blank line quotes as a bare marker and trailing space is stripped', errors));

  tally(check(
    formatCodeReference({ path: 'a.js', startLine: 1, lines: ['x'], body: 'Why this?' })
      === './a.js:1\n> x\nWhy this?',
    'format: the reader\u2019s words close the block, with no trailing newline', errors));

  // The worker twin is an explicit export list, so a helper added to the browser
  // facade is absent there until someone says so — and only fails inside an
  // engine plugin, at run time.
  const sameInput = { path: 'web/js/app.js', startLine: 7, endLine: 9, lines: ['a', 'b', 'c'] };
  tally(check(typeof workerFormatCodeReference === 'function',
    'facade: the worker item-utils facade exports formatCodeReference', errors));
  tally(check(workerFormatCodeReference(sameInput) === formatCodeReference(sameInput),
    'facade: both facades produce a byte-identical block from one input', errors));

  // === Resolving a selection ===

  const host = buildCodeHost('web/js/app.js', [
    'function a() {',
    '  return 1;',
    '}',
    'const b = 2;',
  ], { firstLine: 10 });
  try {
    selectRows(host, 0, 4, 1, 8);
    const midLine = resolveCodeSelection(window.getSelection());
    tally(check(!!midLine && midLine.startLine === 10 && midLine.endLine === 11,
      'selection: a selection starting and ending mid-line names both rows', errors));
    tally(check(!!midLine && midLine.lines.join('|') === 'function a() {|  return 1;',
      'selection: whole rows are quoted, not the selected characters', errors));
    tally(check(!!midLine && midLine.path === 'web/js/app.js' && midLine.outOfRoot === false,
      'selection: the host supplies the path to print', errors));

    // Dragging to the start of the next row is not a selection of that row.
    selectRows(host, 0, 0, 2, 0);
    const toRowStart = resolveCodeSelection(window.getSelection());
    tally(check(!!toRowStart && toRowStart.startLine === 10 && toRowStart.endLine === 11,
      'selection: a selection ending at the start of a row excludes that row', errors));

    selectRows(host, 1, 3, 1, 3);
    tally(check(resolveCodeSelection(window.getSelection()) === null,
      'selection: a collapsed selection is not a reference', errors));
  } finally {
    host.remove();
    window.getSelection()?.removeAllRanges();
  }

  const bare = buildCodeHost('', ['x']);
  bare.removeAttribute('data-code-ref-path');
  try {
    selectRows(bare, 0, 0, 0, 1);
    tally(check(resolveCodeSelection(window.getSelection()) === null,
      'selection: code with no advertised path yields no reference', errors));
  } finally {
    bare.remove();
    window.getSelection()?.removeAllRanges();
  }

  const outside = buildCodeHost('/tmp/notes.txt', ['hello'], { absolute: true });
  try {
    selectRows(outside, 0, 0, 0, 5);
    const ref = resolveCodeSelection(window.getSelection());
    tally(check(!!ref && ref.outOfRoot === true && ref.path === '/tmp/notes.txt',
      'selection: a host marked absolute reports an out-of-root path', errors));
  } finally {
    outside.remove();
    window.getSelection()?.removeAllRanges();
  }

  // Rendered prose — a markdown file, which is shown as formatted text and so
  // has no line rows to count. The file is still known, so the selection is
  // still a reference to it; only the line numbers are missing.
  const prose = document.createElement('div');
  prose.setAttribute('data-code-ref-path', 'docs/design.md');
  const para = document.createElement('p');
  para.textContent = 'The pinboard is shared between windows.';
  prose.appendChild(para);
  document.body.appendChild(prose);
  try {
    const range = document.createRange();
    range.setStart(para.firstChild || para, 4);
    range.setEnd(para.firstChild || para, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const ref = resolveCodeSelection(window.getSelection());
    tally(check(!!ref && ref.path === 'docs/design.md',
      'prose: a selection over rendered text still names its file', errors));
    tally(check(!!ref && ref.startLine === undefined && ref.endLine === undefined,
      'prose: text with no line rows claims no line numbers', errors));
    tally(check(!!ref && ref.lines.join('|') === 'pinboard',
      'prose: the selected text is quoted, there being no rows to widen it to', errors));
    tally(check(!!ref && formatCodeReference(ref) === './docs/design.md\n> pinboard\n',
      'prose: the reference formats as a path and a quote, with no line part', errors));
  } finally {
    prose.remove();
    window.getSelection()?.removeAllRanges();
  }

  // === Landing it in the composer ===

  {
    const { composer, textarea, persisted } = buildComposerStub('please look at ', 15);
    try {
      insertCodeReference(composer, { path: 'a.js', startLine: 1, lines: ['x'] });
      tally(check(textarea.value === 'please look at \n./a.js:1\n> x\n',
        'insert: an existing draft survives and the block starts on its own line', errors));
      tally(check(textarea.selectionStart === textarea.value.length,
        'insert: the caret lands on the empty line beneath the quote', errors));
      tally(check(persisted() > 0,
        'insert: the draft is persisted, as for any other composer edit', errors));
    } finally {
      composer.remove();
    }
  }

  {
    const { composer, textarea } = buildComposerStub('first line\n', 11);
    try {
      insertCodeReference(composer, { path: 'a.js', startLine: 1, lines: ['x'] });
      tally(check(textarea.value === 'first line\n./a.js:1\n> x\n',
        'insert: a caret already at the start of a line gains no extra blank line', errors));
    } finally {
      composer.remove();
    }
  }

  {
    const { composer, textarea } = buildComposerStub('tail', 0);
    try {
      insertCodeReference(composer, { path: 'a.js', startLine: 1, lines: ['x'] });
      tally(check(textarea.value === './a.js:1\n> x\ntail',
        'insert: an empty prefix needs no leading newline', errors));
    } finally {
      composer.remove();
    }
  }

  return { passed, failed, errors };
}
