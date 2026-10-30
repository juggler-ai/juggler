//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>` as the one renderer behind both diff sources.
 *
 * A tool snapshot arrives as two whole strings and is diffed here; a Git patch
 * arrives already hunked from the server and must be drawn exactly as sent. The
 * cases below pin the seam between those two inputs, the states a patch can be
 * in that no line of text can express, and the annotation layer the review panel
 * drives the renderer through.
 * @module unit-tests/diff-review-test
 */

import { assert, createTestSession, createTestConversation } from '../utilities/test-helpers.js';
import { uploadAssetText } from '../../js/services/ops-api.js';
import { diffSnapshotShape, loadDiffSides } from '../../js/utils/diff-snapshot-sides.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await import('../../js/components/diff-viewer.js');
  const { addDiffViewer } = await import('../../js/utils/properties-panel-helpers.js');

  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * @param {string} label - Case name
   * @param {() => (void|Promise<void>)} fn - Case body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      while (mounted.length > 0) mounted.pop()?.remove();
    }
  };

  /** @returns {any} A detached diff viewer */
  const viewer = () => /** @type {any} */ (document.createElement('diff-viewer'));

  /**
   * A viewer inside a box of a stated width, in the document, so the case can
   * ask the layout engine questions. Lanes do not reliably paint, but they do
   * lay out on demand, which is all `offsetWidth` needs.
   * @param {number} width - The box's width, in pixels.
   * @returns {{host: HTMLElement, el: any}} The box and the viewer inside it.
   */
  const mountedViewer = (width) => {
    const host = document.createElement('div');
    host.style.width = `${width}px`;
    host.style.position = 'absolute';
    host.style.left = '-9999px';
    const el = viewer();
    host.appendChild(el);
    document.body.appendChild(host);
    mounted.push(host);
    return { host, el };
  };

  /**
   * @param {HTMLElement} el - A rendered viewer
   * @returns {HTMLElement[]} Its code rows
   */
  const lines = (el) => [...el.querySelectorAll('.diff-line')].map((n) => /** @type {HTMLElement} */ (n));

  /**
   * @param {HTMLElement} el - A rendered viewer
   * @returns {string[]} Each code row as "oldNum|newNum|prefix|text"
   */
  const rows = (el) => lines(el).map((line) => [
    line.querySelector('.line-num.old')?.textContent ?? '',
    line.querySelector('.line-num.new')?.textContent ?? '',
    line.querySelector('.line-prefix')?.textContent ?? '',
    line.querySelector('.line-content')?.textContent ?? '',
  ].join('|'));

  /**
   * @param {HTMLElement} el - A rendered viewer
   * @returns {string} The text of every notice it is showing
   */
  const notices = (el) => [...el.querySelectorAll('diff-notice')].map((n) => n.textContent || '').join(' ');

  /**
   * A patch in the shape `GET /api/git/diff` answers with.
   * @param {object} [over] - Fields to override.
   * @returns {any} The patch.
   */
  const patch = (over = {}) => ({
    repo: '',
    path: 'web/js/app.js',
    status: 'modified',
    binary: false,
    truncated: false,
    added: 1,
    removed: 1,
    revision: 'r1',
    hunks: [{
      oldStart: 900,
      oldLines: 3,
      newStart: 940,
      newLines: 3,
      heading: 'function boot()',
      lines: [
        { kind: 'context', oldLine: 900, newLine: 940, text: 'const a = 1;' },
        { kind: 'remove', oldLine: 901, text: 'same();' },
        { kind: 'add', newLine: 941, text: 'same();' },
        { kind: 'context', oldLine: 902, newLine: 942, text: 'const b = 2;' },
      ],
    }],
    ...over,
  });

  /**
   * @param {any} el - A viewer
   * @param {string} type - Event name
   * @returns {any[]} The details of every such event, collected from now on.
   */
  const collect = (el, type) => {
    /** @type {any[]} */
    const seen = [];
    el.addEventListener(type, (/** @type {CustomEvent} */ e) => seen.push(e.detail));
    return seen;
  };

  await run('a server patch is drawn exactly as sent, without a client diff', async () => {
    const el = viewer();
    el.setPatch(patch());
    // The removed and added lines carry identical text: an LCS over the two
    // reconstructed sides would fold them into one unchanged line, so two rows
    // here is proof the server's hunk was rendered rather than recomputed.
    assert(rows(el).join('\n') === [
      '900|940| |const a = 1;',
      '901||-|same();',
      '|941|+|same();',
      '902|942| |const b = 2;',
    ].join('\n'), `wrong rows:\n${rows(el).join('\n')}`);
  });

  await run('a hunk header carries the server range and heading', async () => {
    const el = viewer();
    el.setPatch(patch());
    const header = el.querySelector('diff-hunk-header')?.textContent || '';
    assert(header.includes('@@ -900,3 +940,3 @@'), `wrong hunk range: ${header}`);
    assert(header.includes('function boot()'), `the heading was dropped: ${header}`);
  });

  await run('the counts come from the server, not from the rows drawn', async () => {
    const el = viewer();
    el.setPatch(patch({ added: 320, removed: 44, truncated: true }));
    assert(el.querySelector('.add-count')?.textContent === '+320', 'added count not the server\'s');
    assert(el.querySelector('.remove-count')?.textContent === '-44', 'removed count not the server\'s');
  });

  await run('a truncated patch says so', async () => {
    const el = viewer();
    el.setPatch(patch({ truncated: true }));
    assert(/cut short/i.test(notices(el)), `truncation unreported: ${notices(el)}`);
    assert(lines(el).length === 4, 'the part of the patch that did arrive should still draw');
  });

  await run('a binary file reports itself and invents no patch', async () => {
    const el = viewer();
    el.setPatch(patch({ binary: true, hunks: [], added: 0, removed: 0 }));
    assert(/binary/i.test(notices(el)), `binary unreported: ${notices(el)}`);
    assert(lines(el).length === 0, 'a binary file must not draw diff lines');
  });

  await run('a conflicted file reports itself', async () => {
    const el = viewer();
    el.setPatch(patch({ conflicted: true, status: 'conflicted' }));
    assert(/conflict/i.test(notices(el)), `conflict unreported: ${notices(el)}`);
  });

  await run('a patch with nothing in it says so', async () => {
    const el = viewer();
    el.setPatch(patch({ status: 'unchanged', hunks: [], added: 0, removed: 0 }));
    assert(el.querySelector('diff-no-changes') !== null, 'expected the no-changes state');
  });

  await run('loading and error are states of their own', async () => {
    const el = viewer();
    el.setPatch(patch());
    el.setLoading();
    assert(lines(el).length === 0, 'the previous patch should be cleared while loading');
    assert(/…/.test(notices(el)), `expected an ellipsis in the loading notice: ${notices(el)}`);
    el.setError('git exited with status 128: fatal: bad object HEAD');
    assert(notices(el).includes('fatal: bad object HEAD'), 'the underlying error text was dropped');
  });

  await run('a tool snapshot with an empty side is a real all-add diff', async () => {
    const added = mountedViewer(400).el;
    added.setDiff('', 'one\ntwo\n', '/src/new.js');
    await added.drawn;
    assert(lines(added).length > 0 && lines(added).every((l) => l.classList.contains('add')),
      'a created file should draw as all additions');

    const removed = mountedViewer(400).el;
    removed.setDiff('one\ntwo\n', '', '/src/gone.js');
    await removed.drawn;
    assert(lines(removed).length > 0 && lines(removed).every((l) => l.classList.contains('remove')),
      'a deleted file should draw as all removals');
  });

  await run('both gutters are drawn for a tool snapshot', async () => {
    const el = mountedViewer(400).el;
    el.setDiff('a\nb\n', 'a\nc\n', '/src/main.js');
    await el.drawn;
    const row = rows(el);
    assert(row.includes('1|1| |a'), `expected a numbered context line, got ${row.join(' / ')}`);
    assert(row.includes('2||-|b'), `a removal should number only the old side, got ${row.join(' / ')}`);
    assert(row.includes('|2|+|c'), `an addition should number only the new side, got ${row.join(' / ')}`);
  });

  await run('a small edit to a big file is diffed, however big the file', async () => {
    const el = mountedViewer(400).el;
    const body = Array.from({ length: 4000 }, (_, k) => `const x${k} = ${k};`);
    const edited = [...body];
    edited[2000] = 'const x2000 = CHANGED;';
    el.setDiff(`${body.join('\n')}\n`, `${edited.join('\n')}\n`, '/src/huge.js');
    await el.drawn;
    assert(notices(el) === '', `a one-line edit needs no notice, got ${notices(el)}`);
    const row = rows(el);
    assert(row.includes('2001||-|const x2000 = 2000;'), `expected the removal, got ${row.join(' / ')}`);
    assert(row.includes('|2001|+|const x2000 = CHANGED;'), `expected the addition, got ${row.join(' / ')}`);
    assert(row.length === 8, `only the change and its context should be drawn, got ${row.length} rows`);
  });

  await run('a changed region too large to diff here is refused, not attempted', async () => {
    const el = mountedViewer(400).el;
    const before = Array.from({ length: 2100 }, (_, k) => `was ${k}`).join('\n');
    const after = Array.from({ length: 2100 }, (_, k) => `now ${k}`).join('\n');
    el.setDiff(`${before}\n`, `${after}\n`, '/src/huge.js');
    await el.drawn;
    assert(/too large/i.test(notices(el)), `expected the size refusal: ${notices(el)}`);
    assert(lines(el).length === 0, 'nothing should be diffed past the budget');
  });

  await run('paths, source and comment text are inert', async () => {
    const el = viewer();
    el.setPatch(patch({
      path: '<img src=x onerror=1>.js',
      hunks: [{
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: 'add', newLine: 1, text: '<script>alert(1)</script>' }],
      }],
    }));
    el.readOnly = false;
    el.setAnnotations([{ id: 'c1', side: 'new', startLine: 1, endLine: 1, body: '<script>alert(2)</script>' }]);
    assert(el.querySelector('script') === null, 'a script element must never be created');
    assert(el.querySelector('img') === null, 'markup in a path must never be created');
    assert((el.textContent || '').includes('<script>alert(1)</script>'), 'the source should read back as text');
    assert((el.textContent || '').includes('<script>alert(2)</script>'), 'the comment should read back as text');
  });

  await run('read-only is the default and offers no comment anchors', async () => {
    const el = viewer();
    el.setPatch(patch());
    assert(el.readOnly === true, 'a diff viewer should start read-only');
    assert(el.querySelectorAll('.diff-comment-btn').length === 0, 'a read-only diff must not offer anchors');
  });

  await run('a tool action draws its diff through the shared renderer', async () => {
    // The properties panel owns no renderer of its own: it hands a recorded
    // snapshot to the same element the review panel drives, and takes the
    // read-only default. What it must never grow is the review panel's half —
    // a panel showing one operation on one file has nothing to navigate.
    const wrapper = document.createElement('div');
    const action = {
      get: (/** @type {string} */ key) => (key === 'displayData'
        ? { diffData: { oldContent: 'a\nb\n', newContent: 'a\nc\n', path: 'web/js/app.js' } }
        : undefined),
    };
    assert(addDiffViewer(wrapper, action, '') === true, 'a recorded snapshot should draw');
    document.body.appendChild(wrapper);
    mounted.push(wrapper);

    const el = /** @type {any} */ (wrapper.querySelector('diff-viewer'));
    assert(el, `the panel must draw through the shared element:\n${wrapper.innerHTML}`);
    await el.drawn;
    assert(el.classList.contains('properties-panel-diff'),
      'the panel keeps its own class on the shared element');
    const row = rows(el);
    assert(row.includes('1|1| |a') && row.includes('2||-|b') && row.includes('|2|+|c'),
      `the shared renderer should have drawn the snapshot, got ${row.join(' / ')}`);
    assert(el.readOnly === true, 'a tool-action diff should take the read-only default');
    assert(el.querySelectorAll('.diff-comment-btn').length === 0,
      'a tool-action diff must not offer comment anchors');
    assert(wrapper.querySelector('.review-panel__rail') === null,
      'a properties panel must never acquire a file rail');
  });

  /**
   * Draw a tool action's recorded diff the way the properties panel does, and
   * wait until it is drawn. A stored side is fetched through the same cached
   * request the panel made, so awaiting it here settles after the panel's own
   * handler has run.
   * @param {Record<string, unknown>} diffData - The recorded diff.
   * @param {string} conversationId - The conversation a stored side lives in.
   * @returns {Promise<any>} The drawn viewer.
   */
  const drawRecorded = async (diffData, conversationId) => {
    const wrapper = document.createElement('div');
    const action = { get: (/** @type {string} */ key) => (key === 'displayData' ? { diffData } : undefined) };
    assert(addDiffViewer(wrapper, action, '', conversationId) === true, 'a recorded diff should draw');
    document.body.appendChild(wrapper);
    mounted.push(wrapper);
    const shape = diffSnapshotShape({ diffData });
    if (shape) await loadDiffSides(conversationId, shape).catch(() => {});
    const el = /** @type {any} */ (wrapper.querySelector('diff-viewer'));
    await el.drawn;
    return el;
  };

  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 15\n', 'line fifteen\n');

  await run('a stored diff draws the same hunks as the same diff inline', async () => {
    const [oldRef, newRef] = await Promise.all([
      uploadAssetText(conversation.id, before), uploadAssetText(conversation.id, after),
    ]);
    const inline = rows(await drawRecorded({ oldContent: before, newContent: after, path: 'src/a.txt' }, conversation.id));
    const stored = rows(await drawRecorded({ oldRef: oldRef.id, newRef: newRef.id, path: 'src/a.txt' }, conversation.id));
    assert(inline.some((r) => r.endsWith('+|line fifteen')), `the inline diff should show the change, got ${inline.join(' / ')}`);
    assert(JSON.stringify(stored) === JSON.stringify(inline),
      `a stored diff should draw what the inline one does:\n stored ${stored.join(' / ')}\n inline ${inline.join(' / ')}`);
  });

  await run('a stored diff whose side cannot be fetched says so', async () => {
    const missing = 'f'.repeat(64);
    const el = await drawRecorded({ oldRef: missing, newRef: missing, path: 'src/gone.txt' }, conversation.id);
    assert(el.mode === 'error', `a failed fetch should leave the viewer in its error state, got ${el.mode}`);
    assert((el.textContent || '').includes("Couldn't load this diff."),
      `the viewer should say the diff could not be loaded, got ${el.textContent}`);
  });

  await run('an annotatable diff offers one literal anchor per line', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    const buttons = [...el.querySelectorAll('.diff-comment-btn')];
    assert(buttons.length === 4, `expected an anchor on every line, got ${buttons.length}`);
    const labels = buttons.map((b) => b.getAttribute('aria-label'));
    assert(labels.includes('Add comment to old line 901 in web/js/app.js'),
      `a removal should anchor to the old side, got ${labels.join(' / ')}`);
    assert(labels.includes('Add comment to new line 941 in web/js/app.js'),
      `an addition should anchor to the new side, got ${labels.join(' / ')}`);
  });

  await run('an anchor asks for a comment on the line it names', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    const asked = collect(el, 'diff-comment-request');
    /** @type {HTMLElement} */ (el.querySelectorAll('.diff-comment-btn')[1]).click();
    assert(asked.length === 1, `expected one request, got ${asked.length}`);
    const [first] = asked;
    assert(first.side === 'old' && first.startLine === 901 && first.endLine === 901,
      `wrong anchor: ${JSON.stringify(first)}`);
    assert(first.path === 'web/js/app.js' && first.repo === '', 'the request should name its file');
    assert(first.lines.join('') === 'same();', 'the request should quote the line');
  });

  await run('shift extends a request to a range on the same side', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch({
      hunks: [{
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 0,
        lines: [
          { kind: 'remove', oldLine: 10, text: 'a();' },
          { kind: 'remove', oldLine: 11, text: 'b();' },
          { kind: 'remove', oldLine: 12, text: 'c();' },
        ],
      }],
    }));
    const asked = collect(el, 'diff-comment-request');
    const buttons = [...el.querySelectorAll('.diff-comment-btn')];
    /** @type {HTMLElement} */ (buttons[0]).click();
    buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const last = asked[asked.length - 1];
    assert(last.startLine === 10 && last.endLine === 12, `wrong range: ${JSON.stringify(last)}`);
    assert(last.lines.join('') === 'a();b();c();', `wrong quote: ${last.lines.join('|')}`);
  });

  await run('anchors stay reachable without a pointer', async () => {
    const { el } = mountedViewer(600);
    el.readOnly = false;
    el.setPatch(patch());
    const button = /** @type {HTMLElement} */ (el.querySelector('.diff-comment-btn'));
    assert(button.tagName === 'BUTTON', 'an anchor must be a real button');
    assert(button.getAttribute('tabindex') !== '-1', 'an anchor must stay in the tab order');
    assert(button.getAttribute('aria-hidden') !== 'true', 'an anchor must stay in the accessibility tree');
    const style = getComputedStyle(button);
    assert(style.display !== 'none' && style.visibility !== 'hidden',
      `an anchor hidden this way is unreachable by keyboard: display=${style.display} visibility=${style.visibility}`);
    button.focus();
    assert(document.activeElement === button, 'an anchor must take focus');
  });

  await run('a comment renders below its line, outside the code row', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    el.setAnnotations([{ id: 'c1', side: 'new', startLine: 941, endLine: 941, body: 'Split this in two.', revision: 'r1' }]);
    const comment = /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"]'));
    assert(!!comment, 'the comment was not drawn');
    assert(comment.closest('.diff-line') === null, 'a comment must not live inside a code row');
    assert((comment.textContent || '').includes('Split this in two.'), 'the comment body was lost');
    const holder = /** @type {HTMLElement} */ (comment.closest('.diff-comments'));
    const anchored = holder.previousElementSibling;
    assert(anchored?.classList.contains('diff-line') && anchored.getAttribute('data-new-line') === '941',
      'the comment should follow the line it is anchored to');
  });

  await run('a comment offers edit and delete, and says which it is about', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    el.setAnnotations([{ id: 'c1', side: 'new', startLine: 941, endLine: 941, body: 'Look again.', revision: 'r1' }]);
    const edits = collect(el, 'diff-annotation-edit');
    const deletes = collect(el, 'diff-annotation-delete');
    /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"] .diff-comment-edit')).click();
    /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"] .diff-comment-delete')).click();
    assert(edits.length === 1 && edits[0].id === 'c1', 'edit did not name its comment');
    assert(deletes.length === 1 && deletes[0].id === 'c1', 'delete did not name its comment');
  });

  await run('a comment written against an older revision is set aside, never moved', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    el.setAnnotations([{
      id: 'c1', side: 'new', startLine: 941, endLine: 941,
      body: 'Still worth saying.', lineText: ['old();'], revision: 'r0',
    }]);
    const comment = /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"]'));
    assert(!!comment, 'an outdated comment must still be shown');
    assert(comment.closest('diff-file-comments') !== null, 'an outdated comment belongs in the file section');
    assert(comment.classList.contains('stale'), 'an outdated comment must be marked as such');
    assert((el.querySelector('diff-file-comments')?.textContent || '').includes('Outdated'),
      'the outdated section should say so');
    assert((comment.textContent || '').includes('old();'), 'the original quoted code should survive');
    const onTheLine = [...el.querySelectorAll('.diff-comments .diff-comment')];
    assert(onTheLine.length === 0, 'an outdated comment must never attach to a line');
  });

  await run('a comment whose line is no longer in the patch is outdated too', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    el.setAnnotations([{
      id: 'c1', side: 'new', startLine: 12, endLine: 12, body: 'Gone.', lineText: ['gone();'], revision: 'r1',
    }]);
    const comment = /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"]'));
    assert(comment?.closest('diff-file-comments') !== null, 'an unanchorable comment belongs in the file section');
  });

  await run('a whole-file comment sits in the file section, unstale', async () => {
    const el = viewer();
    el.readOnly = false;
    el.setPatch(patch());
    el.setAnnotations([{ id: 'c1', side: 'file', body: 'Rename this file.', revision: 'r1' }]);
    const comment = /** @type {HTMLElement} */ (el.querySelector('.diff-comment[data-id="c1"]'));
    assert(comment?.closest('diff-file-comments') !== null, 'a file comment belongs in the file section');
    assert(!comment.classList.contains('stale'), 'a file comment is not outdated by a new revision');
  });

  await run('the comment column is the panel, not the code scroller', async () => {
    const { host, el } = mountedViewer(320);
    el.readOnly = false;
    el.setPatch(patch({
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'context', oldLine: 1, newLine: 1, text: `const x = '${'wide '.repeat(120)}';` },
        ],
      }],
    }));
    el.setAnnotations([{ id: 'c1', side: 'new', startLine: 1, endLine: 1, body: 'Shorten this.', revision: 'r1' }]);
    const holder = /** @type {HTMLElement} */ (el.querySelector('.diff-comments'));
    const line = /** @type {HTMLElement} */ (el.querySelector('.diff-line'));
    assert(host.clientWidth > 0, 'the host box should have a width to measure against');
    assert(line.scrollWidth > el.clientWidth, 'the code row should be the thing that overflows');
    assert(Math.abs(holder.offsetWidth - el.clientWidth) <= 2,
      `the comment row should be the panel's width: ${holder.offsetWidth} vs ${el.clientWidth}`);
    assert(getComputedStyle(holder).position === 'sticky',
      'the comment row must stay put while the code scrolls under it');
  });

  await run('each input clears what the other left behind', async () => {
    const el = mountedViewer(400).el;
    el.setPatch(patch({ binary: true, hunks: [], added: 0, removed: 0 }));
    el.setDiff('a\n', 'b\n', '/src/main.js');
    await el.drawn;
    assert(!/binary/i.test(notices(el)), 'a tool snapshot should not inherit the patch\'s notices');
    assert(rows(el).includes('1||-|a') && rows(el).includes('|1|+|b'),
      `the snapshot should be diffed, got ${rows(el).join(' / ')}`);
    el.setPatch(patch());
    assert(el.filePath === 'web/js/app.js', 'the viewer should name the file the patch is about');
    assert(lines(el).length === 4, 'the patch should replace the snapshot');
  });

  return { passed, failed, errors };
}
