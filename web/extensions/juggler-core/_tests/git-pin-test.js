//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests — the board's review of the working tree: what it draws, one
 * file at a time, refresh, the keyboard, and comments. The draft they make,
 * the scope, and the pin under en-XA are git-pin-draft-test's; the fixtures
 * both mount with are git-pin-helpers'.
 * @module _tests/git-pin-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { isolateFocus } from '../../../js-tests/utilities/isolate-focus.js';
import { repo, manifestOf, patchOf, mountPin, mountedPin } from './git-pin-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Git pin tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const pin = new GitPin();
  /**
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {any} The mounted pin.
   */
  const mount = (options = {}) => mountPin(pin, options);
  /**
   * @param {object} [options] - Passed to `mountedPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = (options = {}) => mountedPin(pin, options);

  // --- the manifest and its gates ------------------------------------------

  await test('the git pin is pinned once per scope', () => {
    assert(pin.allowsMultiple, 'a branch review and an uncommitted one can sit side by side');
    assert(pin.isSameConfig(pin.normalizeConfig({}), pin.normalizeConfig({ scope: '@uncommitted' })),
      'no scope is the default scope, so the two are one pin');
    assert(pin.isSameConfig(pin.normalizeConfig({ scope: ' main...HEAD ' }), pin.normalizeConfig({ scope: 'main...HEAD' })),
      'whitespace does not make a different scope');
    assert(!pin.isSameConfig(pin.normalizeConfig({}), pin.normalizeConfig({ scope: 'main...HEAD' })),
      'a different scope is a different pin');
  });

  await test('a git pin needs a project, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '' }, conversation: null }));
    assert(reason === 'No project', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true,
      'a project is all it needs — a git pin does not need a conversation');
  });

  await test('the tab says Git and the body says what it is for', () => {
    const described = pin.describe();
    assert(described.title === 'Git', `expected 'Git', got ${described.title}`);
    assert(described.subtitle === 'Review changes',
      `the pin is the review surface and should say so, got ${JSON.stringify(described.subtitle)}`);
    // The branch would be the obvious badge, and describe gets no services to
    // find it with. Plan and Todo hit the same wall; the body says it instead.
    assert(!described.badge, 'a badge would need the service, which describe is not given');
  });

  await test('the git working tree is a pinnable source, and nothing else is', () => {
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'git' })) === true, 'git should be pinnable');
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'file', path: '/p/a.js' })) === false,
      'a file belongs to the File pin, not this one');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'git' })) !== null,
      'a git source should produce a config');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'file' })) === null,
      'a source it rejects should produce no config');
  });

  // --- what it draws --------------------------------------------------------

  await test('nothing read yet is not no repository', () => {
    const m = mount({ manifest: manifestOf([]) });
    assert(m.text().trim() === 'Checking…', `expected 'Checking…', got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a project without git says so plainly', async () => {
    const m = await mounted({ manifest: { root: '/tmp/proj', complete: true, warnings: [], repos: [] } });
    assert(m.text().trim() === 'No git repository.', `got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a clean tree shows its branch and says nothing changed', async () => {
    const m = await mounted({ manifest: manifestOf([], { repos: [repo({ branch: 'main' })] }) });
    const text = m.text();
    assert(text.includes('main'), `branch missing:\n${text}`);
    assert(text.includes('Nothing changed.'), `expected the clean state:\n${text}`);
    assert(m.rows().length === 0, 'a clean tree has no file rows');
    assert(m.diffs().length === 0, 'and nothing to ask for a patch of');
    m.teardown();
  });

  await test('the scope is named, and never left to be guessed at', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.', added: 3, removed: 1 }]),
    });
    const scope = m.body.querySelector('.review-panel__scope');
    assert(scope?.textContent?.includes('Working tree against HEAD'),
      `the one comparison this ships with has to be named:\n${scope?.textContent}`);
    assert(scope?.textContent?.includes('1 file'), `the file count is missing:\n${scope?.textContent}`);
    assert(!scope?.textContent?.includes('so far'),
      `a complete review states a total, not a floor:\n${scope?.textContent}`);
    m.teardown();
  });

  // The pin follows the visible conversation, so the same pin shows the project
  // and then a worktree. The tree's name comes with the review it describes.
  await test('a workspace tree is named in the scope, and the project is not', async () => {
    const files = [{ path: 'a.js', index: 'M', worktree: '.', added: 1, removed: 0 }];
    const tree = await mounted({ manifest: manifestOf(files, { workspace: 'feat/tunnels' }) });
    const treeScope = tree.body.querySelector('.review-panel__scope')?.textContent || '';
    assert(treeScope.includes('Working tree of feat/tunnels against HEAD'),
      `a worktree's review must say whose tree it is:\n${treeScope}`);
    tree.teardown();

    const empty = await mounted({ manifest: { root: '/tmp/wt', workspace: 'scratch', complete: true, warnings: [], repos: [] } });
    assert(empty.text().trim() === 'No git repository in scratch.', `got ${JSON.stringify(empty.text())}`);
    empty.teardown();

    const project = await mounted({ manifest: manifestOf(files) });
    const projectScope = project.body.querySelector('.review-panel__scope')?.textContent || '';
    assert(projectScope.includes('Working tree against HEAD') && !projectScope.includes(' of '),
      `the project's review names no workspace:\n${projectScope}`);
    project.teardown();
  });

  // --- one file at a time ---------------------------------------------------

  await test('mounting asks for a review and loads only the first file', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
        { path: 'c.js', index: '.', worktree: '?' },
      ]),
    });
    assert(m.reviews() === 1, `expected one review on mount, got ${m.reviews()}`);
    assert(m.rows().length === 3, `expected three file rows, got ${m.rows().length}`);
    assert(m.diffs().length === 1,
      `a dirty tree must not build a diff per file, got ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[0].path === 'a.js', `expected the first file, got ${m.diffs()[0].path}`);
    assert(m.active()?.textContent?.includes('a.js'), 'the first file should be the selected one');
    assert(m.viewer(), `a selected file should be drawn:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('selecting another file loads that one, and only then', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await nextTask();
    assert(m.diffs().length === 2, `expected a second request, got ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[1].path === 'b.js', `expected b.js, got ${m.diffs()[1].path}`);
    assert(m.active()?.textContent?.includes('b.js'), 'the clicked row should become current');
    assert(m.text().includes('b.js'), `the diff should name the file it drew:\n${m.text()}`);
    m.teardown();
  });

  await test('a large dirty tree draws one diff, however much of it is walked', async () => {
    // The request count is the cheap half of this and is covered above. This is
    // the other half: the rail can be arbitrarily long, but the DOM holds one
    // patch at a time, and walking the rail reuses that one rather than leaving
    // a viewer behind at every file visited.
    const files = Array.from({ length: 40 }, (_, at) => ({
      path: `src/dir${at}/file${at}.js`,
      index: 'M',
      worktree: '.',
    }));
    const m = await mounted({ manifest: manifestOf(files) });
    assert(m.rows().length === 40, `expected a row per file, got ${m.rows().length}`);
    assert(m.viewers().length === 1,
      `a dirty tree must not build a diff per file, got ${m.viewers().length}`);

    for (const at of [7, 19, 39]) {
      m.rows()[at].click();
      await nextTask();
    }
    assert(m.viewers().length === 1,
      `walking the rail must reuse the one viewer, got ${m.viewers().length}`);
    assert(m.active()?.textContent?.includes('file39.js'), 'the last file walked to should be current');
    assert(m.diffs().length === 4,
      `expected one request per file visited, got ${JSON.stringify(m.diffs().map((d) => d.path))}`);
    m.teardown();
  });

  await test('a file is named by its repository as well as its path', async () => {
    const m = await mounted({
      manifest: {
        root: '/tmp/proj',
        complete: true,
        warnings: [],
        repos: [
          repo({ path: '', changed: 1, total: 1, files: [{ path: 'src/main.go', index: 'M', worktree: '.' }] }),
          repo({
            path: 'vendor/lib',
            branch: 'main',
            changed: 1,
            total: 1,
            files: [{ path: 'src/main.go', index: 'M', worktree: '.' }],
          }),
        ],
      },
    });
    assert(m.rows().length === 2, `both files should be listed, got ${m.rows().length}`);
    m.rows()[1].click();
    await nextTask();
    assert(m.diffs().length === 2, `expected the second repo's file to be asked for: ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[1].repo === 'vendor/lib' && m.diffs()[1].path === 'src/main.go',
      `two src/main.go are two files, not one: ${JSON.stringify(m.diffs()[1])}`);
    const labels = m.rows().map((/** @type {any} */ r) => r.getAttribute('aria-label') || '');
    assert(labels[0] !== labels[1],
      `two rows reading identically are indistinguishable aloud: ${JSON.stringify(labels)}`);
    assert(labels[1].includes('vendor/lib'), `the nested repo belongs in the label: ${labels[1]}`);
    m.teardown();
  });

  await test('a patch that outlived its selection is not drawn', async () => {
    const m = mount({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.holdDiffs(true);
    await nextTask();
    m.rows()[1].click();
    await nextTask();
    assert(m.pending().length === 2, `expected both reads out, got ${m.pending().length}`);
    // The first file's patch lands last. It is an answer to a question nobody is
    // asking any more, and drawing it would show b.js's row over a.js's diff.
    m.pending()[1].resolve(patchOf('b.js'));
    await nextTask();
    m.pending()[0].resolve(patchOf('a.js'));
    await nextTask();
    assert(m.viewer()?.textContent?.includes('b.js'),
      `the selected file's diff should stand:\n${m.viewer()?.textContent}`);
    assert(!m.viewer()?.textContent?.includes('a.js'),
      `a stale answer must not replace it:\n${m.viewer()?.textContent}`);
    m.teardown();
  });

  await test('a file whose patch fails says so and keeps the rail', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      patch: () => new Error('git: index locked'),
    });
    const text = m.text();
    assert(text.includes("Couldn't load this diff."), `expected the plain-English lead:\n${text}`);
    assert(text.includes('git: index locked'), `the underlying error must survive:\n${text}`);
    assert(m.rows().length === 1, 'the file list is still worth showing');
    m.teardown();
  });

  // --- refresh --------------------------------------------------------------

  await test('refresh asks again and keeps the file that was being read', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await nextTask();
    const actions = m.controller.getActions();
    assert(actions.some((/** @type {any} */ a) => a.id === 'refresh'),
      `Refresh is how the user asks again, got ${actions.map((/** @type {any} */ a) => a.id).join(', ')}`);
    await actions.find((/** @type {any} */ a) => a.id === 'refresh').run();
    await nextTask();
    assert(m.reviews() === 2, `expected a second review, got ${m.reviews()}`);
    assert(m.active()?.textContent?.includes('b.js'),
      'a refresh that moved the selection would lose the reader\'s place');
    const last = m.diffs()[m.diffs().length - 1];
    assert(last.path === 'b.js', `and the patch is re-read, not reused: ${JSON.stringify(m.diffs())}`);
    m.teardown();
  });

  await test('a file that went away takes the selection with it', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await nextTask();
    m.setManifest(manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]));
    await m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh').run();
    await nextTask();
    assert(m.rows().length === 1, `expected the one remaining file, got ${m.rows().length}`);
    assert(m.active()?.textContent?.includes('a.js'),
      'with the read file gone, the first one is the only honest selection');
    m.teardown();
  });

  await test('a failed refresh keeps the last good review on screen', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.failReview(new Error('network error'));
    await m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh').run();
    await nextTask();
    const text = m.text();
    assert(text.includes('a.js'), `blanking the panel loses more than staleness costs:\n${text}`);
    assert(text.includes("Couldn't refresh.") && text.includes('network error'),
      `and it says why it is stale, with the error intact:\n${text}`);
    m.teardown();
  });

  await test('a first read that fails says so instead of claiming a clean tree', async () => {
    // Armed before the mount, because the pin asks the moment it is mounted.
    const m = await mounted({ reviewError: new Error('git: command not found') });
    const text = m.text();
    assert(!text.includes('Nothing changed.'),
      `a failure is not a clean tree, and must never be drawn as one:\n${text}`);
    assert(text.includes("Couldn't read the working tree.") && text.includes('git: command not found'),
      `expected the lead and the underlying error:\n${text}`);
    m.teardown();
  });

  await test('an incomplete review says what it could not reach', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }], {
        complete: false,
        warnings: ['0 of 431 changed files listed in vendor/lib.'],
      }),
    });
    const text = m.text();
    assert(text.includes('0 of 431 changed files listed in vendor/lib.'),
      `the server's own words are the warning, verbatim:\n${text}`);
    const warnings = m.body.querySelector('.review-panel__warnings');
    assert(warnings, `an incomplete review has to say so prominently:\n${m.body.innerHTML}`);
    assert(text.includes('1 file so far'),
      `and the count it does show is a floor, not a total:\n${text}`);
    m.teardown();
  });

  await test('a repository git could not read is listed with its reason', async () => {
    const m = await mounted({
      manifest: {
        root: '/tmp/proj',
        complete: false,
        warnings: [],
        repos: [repo({
          path: 'vendor/lib',
          complete: false,
          error: 'fatal: not a git repository',
        })],
      },
    });
    assert(m.text().includes('fatal: not a git repository'),
      `dropping it would turn "I could not read this" into "there is nothing here":\n${m.text()}`);
    m.teardown();
  });

  // --- keyboard -------------------------------------------------------------

  await test('the file rail moves under the arrow keys', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
        { path: 'c.js', index: '.', worktree: '?' },
      ]),
    });
    const rows = m.rows();
    // Focus is observed rather than read back from the window. The lanes in one
    // window share a single focused frame, so a sibling lane focusing anything
    // takes this document's active element to its body — which makes reading it
    // back a measure of what else is running (isolateFocus).
    const focus = isolateFocus();
    const lastFocused = () => focus.requests[focus.requests.length - 1]?.element;

    /**
     * @param {any} row - The row to send the key to.
     * @param {string} key - The key.
     * @returns {Promise<void>} Resolved once the selection has moved.
     */
    const press = async (row, key) => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await nextTask();
    };

    try {
      await press(rows[0], 'ArrowDown');
      focus.steal();
      assert(m.active() === rows[1], `Down should move to the next file, got ${m.active()?.textContent}`);
      assert(lastFocused() === rows[1], 'and focus should go with it');
      assert(rows[1].tabIndex === 0 && rows[0].tabIndex === -1 && rows[2].tabIndex === -1,
        `Tab should reach the row being read and no other, got ${rows.map((/** @type {any} */ r) => r.tabIndex)}`);

      await press(rows[1], 'End');
      assert(m.active() === rows[2], `End should reach the last file, got ${m.active()?.textContent}`);
      await press(rows[2], 'Home');
      assert(m.active() === rows[0], `Home should come back to the first, got ${m.active()?.textContent}`);
    } finally {
      focus.restore();
      m.teardown();
    }
  });

  await test('the rail leaves Left and Right to the Pinboard', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    m.rows()[0].dispatchEvent(event);
    assert(!event.defaultPrevented,
      'Left and Right change pins; a rail that swallowed them would trap the reader in one');
    m.teardown();
  });

  // --- comments -------------------------------------------------------------

  await test('an anchor opens an editor that saves a comment where it was written', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    const anchor = m.viewer().querySelector('.diff-comment-btn[data-line="85"]');
    assert(anchor, `an annotatable diff offers an anchor per line:\n${m.viewer().innerHTML}`);
    anchor.click();
    await nextTask();
    const editor = m.editor();
    assert(editor, `clicking an anchor should open an editor:\n${m.body.innerHTML}`);
    const textarea = editor.querySelector('textarea');
    assert(textarea, 'and the editor has a labelled textarea');
    assert(editor.textContent.includes('new line 85'),
      `the editor says what it is about:\n${editor.textContent}`);

    textarea.value = 'Split this into two methods.';
    editor.querySelector('.review-panel__save').click();
    await nextTask();

    const saved = m.saves();
    assert(saved.length === 1, `expected one save, got ${saved.length}`);
    const comment = saved[0].comments[0];
    assert(comment.body === 'Split this into two methods.', `body missing: ${JSON.stringify(comment)}`);
    assert(comment.side === 'new' && comment.startLine === 85 && comment.endLine === 85,
      `the anchor is the comment's address: ${JSON.stringify(comment)}`);
    assert(comment.path === 'a.js' && comment.repo === '', `the file is part of it: ${JSON.stringify(comment)}`);
    assert(comment.revision === 'rev1',
      `without the revision nothing can tell later that the file moved on: ${JSON.stringify(comment)}`);
    assert(comment.lineText.join('\n').includes('this.renderComments(hunks);'),
      `the quote is what is left once the file changes: ${JSON.stringify(comment.lineText)}`);
    assert(!m.editor(), 'a saved comment closes its editor');
    m.teardown();
  });

  await test('a refused save keeps the words on screen and says why', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.failSave(new Error('A comment holds at most 8000 characters; this one has 9001.'));
    m.viewer().querySelector('.diff-comment-btn[data-line="85"]').click();
    await nextTask();
    const textarea = m.editor().querySelector('textarea');
    textarea.value = 'Too long, apparently.';
    m.editor().querySelector('.review-panel__save').click();
    await nextTask();

    assert(m.editor(), 'the editor stays open — the text has nowhere else to be');
    assert(m.editor().querySelector('textarea').value === 'Too long, apparently.',
      'and the words are still there');
    assert(m.editor().textContent.includes('this one has 9001'),
      `with the underlying reason intact:\n${m.editor().textContent}`);
    m.teardown();
  });

  await test('Escape abandons a comment and gives the anchor back', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    const anchor = m.viewer().querySelector('.diff-comment-btn[data-line="85"]');
    anchor.click();
    await nextTask();
    // Observed, not read back from the window: see the rail's own keyboard case
    // for why that is a measure of the other lanes.
    const focus = isolateFocus();
    try {
      const textarea = m.editor().querySelector('textarea');
      textarea.value = 'Never mind.';
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      focus.steal();
      await nextTask();
      assert(!m.editor(), 'Escape should close the editor');
      assert(m.saves().length === 0, 'and write nothing');
      assert(focus.asked(anchor), 'and focus belongs back on the anchor it came from');
    } finally {
      focus.restore();
      m.teardown();
    }
  });

  await test('a saved comment is drawn against its line and counted on its row', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'a.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: ['this.renderComments(hunks);'],
          body: 'Keep annotation state outside the renderer.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    assert(m.viewer().textContent.includes('Keep annotation state outside the renderer.'),
      `the comment belongs against the line it is about:\n${m.viewer().textContent}`);
    const counts = m.rows().map((/** @type {any} */ r) => r.querySelector('.review-panel__count')?.textContent || '');
    assert(counts[0] === '1', `the file with the comment should count it, got ${JSON.stringify(counts)}`);
    assert(counts[1] === '', 'and the file without one should say nothing');
    assert(m.rows()[0].getAttribute('aria-label')?.includes('1 comment'),
      `the count has to be readable aloud too: ${m.rows()[0].getAttribute('aria-label')}`);
    m.teardown();
  });

  await test('a comment on another file is not drawn over this one', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'b.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: [],
          body: 'Belongs to b.js alone.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    assert(!m.viewer().textContent.includes('Belongs to b.js alone.'),
      `a.js is the file on screen:\n${m.viewer().textContent}`);
    m.teardown();
  });

  await test('deleting a comment writes the rest back', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [
          {
            id: 'c_1',
            repo: '',
            path: 'a.js',
            side: 'new',
            startLine: 85,
            endLine: 85,
            lineText: [],
            body: 'First.',
            revision: 'rev1',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'c_2',
            repo: '',
            path: 'a.js',
            side: 'file',
            lineText: [],
            body: 'Second.',
            revision: 'rev1',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    });
    m.viewer().querySelector('.diff-comment[data-id="c_1"] .diff-comment-delete').click();
    await nextTask();
    const saved = m.saves();
    assert(saved.length === 1, `expected the remainder written back, got ${saved.length}`);
    assert(saved[0].comments.length === 1 && saved[0].comments[0].id === 'c_2',
      `only the deleted one should go: ${JSON.stringify(saved[0].comments.map((/** @type {any} */ c) => c.id))}`);
    m.teardown();
  });

  await test('editing a comment reopens it with its own words', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'a.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: ['this.renderComments(hunks);'],
          body: 'First thought.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    m.viewer().querySelector('.diff-comment[data-id="c_1"] .diff-comment-edit').click();
    await nextTask();
    const textarea = m.editor()?.querySelector('textarea');
    assert(textarea?.value === 'First thought.',
      `an edit starts from what is there, got ${JSON.stringify(textarea?.value)}`);
    textarea.value = 'Second thought.';
    m.editor().querySelector('.review-panel__save').click();
    await nextTask();
    const comments = m.saves()[0].comments;
    assert(comments.length === 1 && comments[0].id === 'c_1',
      `an edit replaces the comment rather than adding one: ${JSON.stringify(comments)}`);
    assert(comments[0].body === 'Second thought.', `the new words should stick: ${JSON.stringify(comments[0])}`);
    assert(comments[0].createdAt === 1, 'and it is still the comment it was');
    m.teardown();
  });

  await test('a file with no lines to comment on can still be commented on', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'logo.png', index: 'M', worktree: '.' }]),
      patch: () => patchOf('logo.png', { binary: true, hunks: [], added: 0, removed: 0 }),
    });
    assert(m.viewer().textContent.includes('Binary file'),
      `it should say why there are no lines:\n${m.viewer().textContent}`);
    const whole = m.body.querySelector('.review-panel__file-comment');
    assert(whole, `a file with no line to hang a comment on still needs one:\n${m.body.innerHTML}`);
    whole.click();
    await nextTask();
    m.editor().querySelector('textarea').value = 'Is this meant to be here?';
    m.editor().querySelector('.review-panel__save').click();
    await nextTask();
    const comment = m.saves()[0].comments[0];
    assert(comment.side === 'file' && comment.startLine === undefined,
      `a whole-file comment names no line: ${JSON.stringify(comment)}`);
    m.teardown();
  });

  await test('a conflicted file stays selectable and says what it is', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'U', worktree: 'U', conflicted: true }]),
      patch: () => patchOf('a.js', { conflicted: true, status: 'conflicted' }),
    });
    assert(m.rows().length === 1 && m.viewer(), 'a conflict is still worth reading');
    assert(m.viewer().textContent.includes('Unresolved merge conflict'),
      `and it should say so:\n${m.viewer().textContent}`);
    m.teardown();
  });

  await test('each row is coloured by what happened to the file', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'src/kept.js', index: 'M', worktree: '.' },
        { path: 'src/new.js', index: 'A', worktree: '.' },
        { path: 'src/gone.js', index: 'D', worktree: '.' },
        { path: 'src/loose.js', index: '.', worktree: '?' },
        { path: 'src/moved.js', oldPath: 'src/was.js', index: 'R', worktree: '.' },
        { path: 'src/clash.js', index: 'U', worktree: 'U', conflicted: true },
      ]),
    });
    const tones = m.rows().map((/** @type {any} */ row) => row.dataset.tone || '');
    assert(JSON.stringify(tones) === JSON.stringify(
      ['modified', 'added', 'removed', 'added', 'renamed', 'conflicted']),
    `each kind of change is marked as its own: ${JSON.stringify(tones)}`);
    // Two tones, two colours, in both the places a row shows one: the marks are
    // painted, not merely recorded.
    const colour = (/** @type {number} */ at, /** @type {string} */ part) =>
      getComputedStyle(m.rows()[at].querySelector(`.review-panel__${part}`)).color;
    assert(colour(1, 'code') !== colour(2, 'code'),
      `added and removed letters must not read alike: ${colour(1, 'code')}`);
    assert(colour(1, 'name') !== colour(2, 'name'),
      `nor their names: ${colour(1, 'name')}`);
    assert(colour(1, 'name') !== colour(1, 'dir'),
      `and the tint is on the name, the directory staying quiet: ${colour(1, 'name')}`);
    m.teardown();
  });

  await test('a renamed file is read under its new name and says where it came from', async () => {
    const m = await mounted({
      manifest: manifestOf([{
        path: 'web/js/components/review-panel.js',
        oldPath: 'web/js/components/changed-files.js',
        index: 'R',
        worktree: '.',
      }]),
    });
    const row = m.rows()[0];
    assert(row.querySelector('.review-panel__code')?.textContent === 'R ',
      `git's own letter for a rename: ${JSON.stringify(row.querySelector('.review-panel__code')?.textContent)}`);
    assert(row.querySelector('.review-panel__name')?.textContent === 'review-panel.js',
      `a row is read for where the file is now: ${row.querySelector('.review-panel__name')?.textContent}`);
    // Both names, because "Renamed" without the old one does not say from what.
    assert(row.getAttribute('aria-label')?.includes('from web/js/components/changed-files.js'),
      `the row should say where it moved from: ${row.getAttribute('aria-label')}`);
    assert(row.title === 'web/js/components/changed-files.js → web/js/components/review-panel.js',
      `and show both on hover: ${JSON.stringify(row.title)}`);
    const head = m.body.querySelector('.review-panel__diff-path');
    assert(head?.textContent === 'web/js/components/changed-files.js → web/js/components/review-panel.js',
      `the diff names the move it is showing: ${JSON.stringify(head?.textContent)}`);
    m.teardown();
  });

  return { passed, failed, errors };
}
