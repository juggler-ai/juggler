//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin Changes place tests — the list drawn from `git.changes()`, staging
 * with an optimistic model and its rollback, the reads that follow the watch,
 * line staging from the viewer, discard and its undo, the commit box, the keys
 * and stack mode. The fake services are git-pin-helpers'.
 * @module _tests/git-changes-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { isolateFocus } from '../../../js-tests/utilities/isolate-focus.js';
import { changesOf, historyOf, mountPin, shaOf } from './git-pin-helpers.js';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
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
   * Mount in the Changes place and wait for the first read.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (options = {}) => {
    const m = mountPin(pin, { place: 'changes', ...options });
    for (let i = 0; i < 6; i++) await nextTask();
    return m;
  };

  const partly = { path: 'a.js', index: 'M', worktree: 'M', staged: { added: 1, removed: 0 }, unstaged: { added: 2, removed: 1 } };
  const unstaged = { path: 'src/b.js', index: '.', worktree: 'M', unstaged: { added: 3, removed: 0 } };
  const untracked = { path: 'new.md', index: '?', worktree: '?' };

  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - `group:path`.
   * @returns {HTMLElement|null} That row.
   */
  const row = (m, key) => m.body.querySelector(`.git-changes__row[data-key="${CSS.escape(key)}"]`);
  /**
   * Click a part of a row, failing plainly when the row is not there.
   * @param {any} m - The mounted pin.
   * @param {string} key - The row's key.
   * @param {string} selector - The part.
   */
  const hit = (m, key, selector) => {
    const target = /** @type {HTMLElement|null} */ (row(m, key)?.querySelector(selector) || null);
    if (!target) throw new Error(`no ${selector} in row ${key}: ${JSON.stringify(keys(m))}`);
    target.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string[]} Every row's key, in order.
   */
  const keys = (m) => [...m.body.querySelectorAll('.git-changes__row')].map((r) => r.getAttribute('data-key'));
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The toast's text, '' when none is up.
   */
  const toastText = (m) => {
    const toast = m.body.querySelector('.git-pin__toast:not([hidden])');
    return toast ? toast.textContent || '' : '';
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLTextAreaElement} The commit message.
   */
  const message = (m) => m.body.querySelector('.git-commit__msg');
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - The key.
   * @param {object} [init] - Modifiers.
   */
  const press = (m, key, init = {}) => {
    m.body.querySelector('.git-pin').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  };

  await test('the groups render from a changes answer, a partly staged file in both', async () => {
    const m = await mounted({ changes: changesOf([partly, unstaged, untracked]) });
    const order = keys(m);
    assert(JSON.stringify(order) === JSON.stringify(['staged:a.js', 'changes:a.js', 'changes:src/b.js', 'untracked:new.md']),
      `rows in group order: ${JSON.stringify(order)}`);
    assert(!!(row(m, 'staged:a.js')?.querySelector('.git-changes__part') && row(m, 'changes:a.js')?.querySelector('.git-changes__part')),
      'a partly staged file is marked in both groups');
    const sects = [...m.body.querySelectorAll('.git-changes__sect')].map((s) => s.textContent || '');
    assert(sects.length === 3 && sects[0].includes('Staged') && sects[1].includes('Changes') && sects[2].includes('Untracked'),
      `section headers: ${JSON.stringify(sects)}`);
    const head = m.body.querySelector('.git-pin__head')?.textContent || '';
    assert(head.includes('develop') && head.includes('Commit 1'), `the head names the branch and the primary: ${head}`);
    m.teardown();
  });

  await test('a clean tree says so', async () => {
    const m = await mounted({ changes: changesOf([]) });
    assert(m.body.textContent.includes('Working tree clean'), `got ${m.body.textContent}`);
    m.teardown();
  });

  await test('clicking a letter stages at once, and a failed run puts the row back with the error', async () => {
    const m = await mounted({ changes: changesOf([unstaged]) });
    m.holdRuns(true);
    hit(m, 'changes:src/b.js', '.git-changes__st');
    const moved = row(m, 'staged:src/b.js');
    assert(!!(moved && !row(m, 'changes:src/b.js')), `the row moves at once: ${JSON.stringify(keys(m))}`);
    assert(!!(moved?.hasAttribute('data-pending')), 'and is marked pending');
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'stage' && op.repo === '' && JSON.stringify(op.paths) === '["src/b.js"]', `op ${JSON.stringify(op)}`);
    m.failRun(0, { message: 'index.lock exists', kind: 'locked' });
    for (let i = 0; i < 6; i++) await nextTask();
    assert(!!(row(m, 'changes:src/b.js') && !row(m, 'staged:src/b.js')), `rolled back: ${JSON.stringify(keys(m))}`);
    assert(toastText(m).includes('index.lock exists'), `the error shows: ${toastText(m)}`);
    m.teardown();
  });

  await test('a successful stage stays optimistic until a read that started after the job', async () => {
    const m = await mounted({ changes: changesOf([unstaged]) });
    m.holdRuns(true);
    m.holdChanges(true);
    hit(m, 'changes:src/b.js', '.git-changes__st');
    m.emitChange([{ path: '', kinds: ['index'] }]);
    for (let i = 0; i < 6; i++) await nextTask();
    const before = m.pendingChanges().length;
    assert(before === 1, `a read went out during the job: ${before}`);
    m.finishRun(0);
    for (let i = 0; i < 6; i++) await nextTask();
    // The read that started during the job answers with the tree as it was.
    m.releaseChanges(0, changesOf([unstaged]));
    for (let i = 0; i < 6; i++) await nextTask();
    assert(!!(row(m, 'staged:src/b.js')?.hasAttribute('data-pending')),
      `a read from before the job finished does not undo the move: ${JSON.stringify(keys(m))}`);
    const after = m.pendingChanges().filter((/** @type {any} */ p) => !p.settled);
    assert(after.length === 1, `one read follows the job: ${after.length}`);
    m.releaseChanges(after[0].index, changesOf([{ ...unstaged, index: 'M', worktree: '.', staged: { added: 3, removed: 0 }, unstaged: undefined }]));
    for (let i = 0; i < 6; i++) await nextTask();
    const adopted = row(m, 'staged:src/b.js');
    assert(!!(adopted && !adopted.hasAttribute('data-pending')), `the later read is adopted: ${JSON.stringify(keys(m))}`);
    m.teardown();
  });

  await test('a change during a read causes exactly one follow-up, and a stale read is dropped', async () => {
    const m = mountPin(pin, { place: 'changes', changes: changesOf([unstaged]) });
    m.holdChanges(true);
    for (let i = 0; i < 6; i++) await nextTask();
    // The mount's read went out before the hold; a resync starts one held.
    m.emitResync();
    for (let i = 0; i < 6; i++) await nextTask();
    const first = m.pendingChanges().length;
    m.emitChange([{ path: '', kinds: ['worktree'] }]);
    m.emitChange([{ path: '', kinds: ['index'] }]);
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.pendingChanges().length === first, 'changes during a read wait for it');
    m.releaseChanges(first - 1, changesOf([unstaged]));
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.pendingChanges().length === first + 1, `exactly one follow-up: ${m.pendingChanges().length - first}`);
    m.releaseChanges(first, changesOf([unstaged]));
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.pendingChanges().length === first + 1, 'and nothing after it');

    // A resync during a read starts a new one; the old answer is then stale.
    m.emitChange([{ path: '', kinds: ['index'] }]);
    for (let i = 0; i < 6; i++) await nextTask();
    const old = m.pendingChanges().length - 1;
    m.emitResync();
    for (let i = 0; i < 6; i++) await nextTask();
    const fresh = m.pendingChanges().length - 1;
    assert(fresh === old + 1, 'a resync reads again at once');
    m.releaseChanges(fresh, changesOf([untracked]));
    for (let i = 0; i < 6; i++) await nextTask();
    m.releaseChanges(old, changesOf([unstaged]));
    for (let i = 0; i < 6; i++) await nextTask();
    assert(JSON.stringify(keys(m)) === '["untracked:new.md"]', `the stale read was dropped: ${JSON.stringify(keys(m))}`);
    m.teardown();
  });

  await test('a stage request from the viewer sends stage-lines, and a stale refusal reads the diff again', async () => {
    const m = await mounted({ changes: changesOf([unstaged]) });
    hit(m, 'changes:src/b.js', '.git-changes__path');
    for (let i = 0; i < 6; i++) await nextTask();
    const asked = m.diffs().at(-1);
    assert(asked?.path === 'src/b.js' && asked.options?.scope === '@unstaged', `diff asked ${JSON.stringify(asked)}`);
    const viewer = m.body.querySelector('.git-changes__detail diff-viewer');
    assert(viewer, 'the detail draws the diff');
    m.holdRuns(true);
    viewer.dispatchEvent(new CustomEvent('diff-stage-request', {
      bubbles: true, detail: { verb: 'stage', revision: 'rev1', context: 3, lines: [{ new: 85 }] },
    }));
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'stage-lines' && op.path === 'src/b.js' && op.revision === 'rev1' && op.context === 3
      && JSON.stringify(op.lines) === '[{"new":85}]', `op ${JSON.stringify(op)}`);
    const diffsBefore = m.diffs().length;
    m.failRun(0, { kind: 'stale', message: 'The diff changed.' });
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.diffs().length > diffsBefore, 'the diff is read again');
    assert(m.body.querySelector('.git-changes__note')?.textContent, 'with a note saying why');
    m.teardown();
  });

  await test('discard toasts with Undo, and Undo restores the recovery point', async () => {
    const m = await mounted({ changes: changesOf([unstaged]) });
    hit(m, 'changes:src/b.js', '.git-changes__path');
    for (let i = 0; i < 6; i++) await nextTask();
    m.holdRuns(true);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__crumb-discard')).click();
    assert(!row(m, 'changes:src/b.js'), 'the row goes at once');
    assert(m.runs()[0]?.op?.kind === 'discard', `op ${JSON.stringify(m.runs()[0]?.op)}`);
    m.finishRun(0, { result: { discard: 'd1' } });
    for (let i = 0; i < 6; i++) await nextTask();
    const undo = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo'));
    assert(!!(undo && toastText(m).includes('b.js')), `a toast with Undo: ${toastText(m)}`);
    undo?.click();
    const op = m.runs()[1]?.op;
    assert(op?.kind === 'undo-discard' && op.discard === 'd1', `undo sent ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('commit sends the message with the body wrapped; a failed one keeps it and shows the output', async () => {
    const m = await mounted({ changes: changesOf([partly]) });
    const body = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ') + ' and more words to go past the edge';
    message(m).value = `Did a thing\n\n${body}`;
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
    m.holdRuns(true);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'commit' && !op.amend, `op ${JSON.stringify(op)}`);
    const lines = String(op.message).split('\n');
    assert(lines[0] === 'Did a thing' && lines.length > 3 && lines.slice(2).every((l) => l.length <= 72),
      `the body is wrapped: ${JSON.stringify(op.message)}`);
    m.emitJob({ ...m.runs()[0].job, output: 'running lint…' });
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.body.querySelector('.git-commit__output')?.textContent?.includes('running lint…'), 'hook output streams in');
    m.failRun(0, { message: 'The pre-commit hook failed.', job: { output: 'lint: 2 errors' } });
    for (let i = 0; i < 6; i++) await nextTask();
    assert(message(m).value === `Did a thing\n\n${body}`, 'the message is kept exactly as typed');
    assert(m.body.querySelector('.git-commit__output')?.textContent?.includes('lint: 2 errors'),
      `the hook output shows: ${m.body.querySelector('.git-commit__output')?.textContent}`);
    m.teardown();
  });

  await test('a successful commit clears the message and offers Undo', async () => {
    const m = await mounted({ changes: changesOf([partly]) });
    message(m).value = 'Did a thing';
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
    m.holdRuns(true);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
    m.finishRun(0, { result: { head: 'abcdef1234567' } });
    for (let i = 0; i < 6; i++) await nextTask();
    assert(message(m).value === '', 'cleared');
    assert(toastText(m).includes('abcdef1') && toastText(m).includes('develop'), `toast: ${toastText(m)}`);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__toast-undo')).click();
    const op = m.runs()[1]?.op;
    assert(op?.kind === 'undo-commit' && op.expectHead === 'abcdef1234567', `undo ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('a commit brings History forward with the new commit selected, though its list read before it', async () => {
    // As the server's session: what a list opened before the commit reads is the
    // history it opened on, until a read refreshes it or opens another.
    const before = historyOf(3);
    const after = historyOf(3, { top: 1, gen: 1 });
    let landed = false;
    let caught = false;
    const log = (/** @type {any} */ q) => {
      if (landed && (q.refresh || !q.graph)) caught = true;
      return (caught ? after : before)(q);
    };
    const m = mountPin(pin, { place: 'history', changes: changesOf([partly]), log });
    await waitFor(() => m.body.querySelector('.git-history__row'), 'History\u2019s list');
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__place-btn[data-place="changes"]')).click();
    await waitFor(() => message(m), 'the commit box');
    message(m).value = 'Did a thing';
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
    m.holdRuns(true);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
    landed = true;
    m.finishRun(0, { result: { head: shaOf(0, 'f') } });
    await waitFor(() => root.dataset.place === 'history', `History comes forward: ${root.dataset.place}`);
    const chosen = /** @type {HTMLElement} */ (await waitFor(
      () => m.body.querySelector('.git-history__row[aria-selected="true"]'), 'a selected row'));
    assert(chosen.dataset.sha === shaOf(0, 'f'), `the new commit is selected: ${chosen.dataset.sha}`);
    m.teardown();
  });

  await test('Skip hooks commits with noVerify, once: it is cleared when the commit lands', async () => {
    const m = await mounted({ changes: changesOf([partly]) });
    const skip = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-commit__no-verify'));
    assert(Boolean(skip) && !skip.checked, 'Skip hooks is there, unticked');
    m.holdRuns(true);
    message(m).value = 'Hooks skipped';
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
    skip.click();
    /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
    assert(m.runs()[0]?.op?.noVerify === true, `op ${JSON.stringify(m.runs()[0]?.op)}`);
    m.finishRun(0, { result: { head: 'abcdef1234567' } });
    await waitFor(() => message(m).value === '', 'the commit to land');
    assert(!skip.checked, 'Skip hooks still ticked after the commit');
    message(m).value = 'With hooks';
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
    /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
    assert(m.runs()[1]?.op && !('noVerify' in m.runs()[1].op), `the next commit runs its hooks: ${JSON.stringify(m.runs()[1]?.op)}`);
    m.teardown();
  });

  await test('amend prefills the last message and gives back what was typed when unchecked', async () => {
    const m = await mounted({ changes: changesOf([]) });
    const amend = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-commit__amend'));
    amend.checked = true;
    amend.dispatchEvent(new Event('change', { bubbles: true }));
    assert(message(m).value === 'Last commit', `prefilled: ${JSON.stringify(message(m).value)}`);
    const go = /** @type {HTMLButtonElement} */ (m.body.querySelector('.git-commit__go'));
    assert(!go.disabled && go.textContent?.includes('Amend last commit'), `the button: ${go.textContent}`);
    amend.checked = false;
    amend.dispatchEvent(new Event('change', { bubbles: true }));
    assert(message(m).value === '', `restored: ${JSON.stringify(message(m).value)}`);
    const hint = /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__hint'));
    assert(go.disabled && go.textContent === 'Commit', `nothing to commit: ${go.textContent}`);
    assert(!hint.hidden && hint.textContent === 'Nothing staged', `and says why: ${hint.hidden ? '(hidden)' : hint.textContent}`);
    m.holdRuns(true);
    amend.checked = true;
    amend.dispatchEvent(new Event('change', { bubbles: true }));
    go.click();
    assert(m.runs()[0]?.op?.amend === true && m.runs()[0]?.op?.message === 'Last commit', `op ${JSON.stringify(m.runs()[0]?.op)}`);
    m.teardown();
  });

  await test('the keys: ⌘↵ commits, c focuses the message, j moves and space stages', async () => {
    const focus = isolateFocus();
    try {
      const m = await mounted({ changes: changesOf([partly, unstaged]) });
      press(m, 'c');
      assert(focus.asked(message(m)), 'c focuses the message');
      press(m, 'j');
      assert(row(m, 'staged:a.js')?.getAttribute('aria-selected') === 'true', 'j selects the first row');
      press(m, 'j');
      press(m, 'j');
      assert(row(m, 'changes:src/b.js')?.getAttribute('aria-selected') === 'true', `j moves on: ${JSON.stringify(keys(m))}`);
      m.holdRuns(true);
      press(m, ' ');
      assert(m.runs()[0]?.op?.kind === 'stage' && m.runs()[0].op.paths[0] === 'src/b.js', `space stages ${JSON.stringify(m.runs()[0]?.op)}`);
      m.finishRun(0);
      for (let i = 0; i < 6; i++) await nextTask();
      message(m).value = 'Keys';
      message(m).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
      assert(m.runs()[1]?.op?.kind === 'commit' && m.runs()[1].op.message === 'Keys', `⌘↵ commits ${JSON.stringify(m.runs()[1]?.op)}`);
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('/ filters the rows by path: groups left empty go, j/k walk what is shown, Esc brings all back', async () => {
    const focus = isolateFocus();
    try {
      const doc = { path: 'docs/x.md', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } };
      const m = await mounted({ changes: changesOf([partly, doc, unstaged, untracked]) });
      const all = keys(m);
      assert(all.length === 5, `every row: ${JSON.stringify(all)}`);
      const filter = /** @type {HTMLInputElement|null} */ (m.body.querySelector('.git-changes .git-list-filter__input'));
      assert(Boolean(filter?.closest('.git-list-filter')?.hasAttribute('hidden')), 'the filter is hidden until asked for');
      press(m, '/');
      assert(focus.asked(/** @type {HTMLInputElement} */ (filter)), '/ focuses the filter');
      assert(!filter?.closest('.git-list-filter')?.hasAttribute('hidden'), '/ shows the filter');
      /** @type {HTMLInputElement} */ (filter).value = 'MD';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      assert(JSON.stringify(keys(m)) === JSON.stringify(['changes:docs/x.md', 'untracked:new.md']), `narrowed, case-insensitively: ${JSON.stringify(keys(m))}`);
      assert(!m.body.querySelector('.git-changes__sect[data-group="staged"]'), 'a group with nothing shown has no header');
      press(m, 'j');
      assert(row(m, 'changes:docs/x.md')?.getAttribute('aria-selected') === 'true', 'j selects the first row shown');
      press(m, 'j');
      assert(row(m, 'untracked:new.md')?.getAttribute('aria-selected') === 'true', 'j skips the rows filtered out');
      press(m, 'k');
      assert(row(m, 'changes:docs/x.md')?.getAttribute('aria-selected') === 'true', 'k skips them too');
      /** @type {HTMLInputElement} */ (filter).value = 'nothing-is-called-this';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      const text = m.body.querySelector('.git-changes__scroll')?.textContent || '';
      assert(keys(m).length === 0 && text.includes('Nothing matches') && !text.includes('Working tree clean'), `nothing shown says so: ${text}`);
      /** @type {HTMLInputElement} */ (filter).value = 'md';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      assert(row(m, 'changes:docs/x.md')?.getAttribute('aria-selected') === 'true', 'filtering keeps the selection');
      filter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(JSON.stringify(keys(m)) === JSON.stringify(all), `Esc brings every row back: ${JSON.stringify(keys(m))}`);
      assert(filter?.value === '' && Boolean(filter.closest('.git-list-filter')?.hasAttribute('hidden')), 'Esc clears and hides the filter');
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('in stack mode a file pushes the detail and Esc pops it', async () => {
    const m = await mounted({ changes: changesOf([unstaged]), width: '20rem', height: '30rem' });
    const root = m.body.querySelector('.git-pin');
    assert(root.getAttribute('data-mode') === 'stack', `narrow is stack: ${root.getAttribute('data-mode')}`);
    hit(m, 'changes:src/b.js', '.git-changes__path');
    for (let i = 0; i < 6; i++) await nextTask();
    assert(root.getAttribute('data-level') === 'detail', 'selecting a file pushes the detail');
    press(m, 'Escape');
    assert(root.getAttribute('data-level') === 'list', 'Esc pops it');
    m.teardown();
  });

  await test('a pin moved to another workspace watches and reads that tree', async () => {
    const m = await mounted({ changes: changesOf([unstaged]), config: { workspace: 'ws1' } });
    const before = m.watchOptions();
    assert(before.length > 0 && before.every((/** @type {any} */ o) => o.workspace === 'ws1'),
      `mounted watching ws1: ${JSON.stringify(before)}`);
    m.setChanges(changesOf([untracked]));
    const asked = m.changesAsked().length;
    m.reconfigure({ place: 'changes', workspace: 'ws2' });
    for (let i = 0; i < 6; i++) await nextTask();
    const after = m.watchOptions();
    assert(after.length === before.length && after.every((/** @type {any} */ o) => o.workspace === 'ws2'),
      `every watch follows the pin to ws2: ${JSON.stringify(after)}`);
    const reads = m.changesAsked().slice(asked);
    assert(reads.length > 0 && reads.every((/** @type {any} */ o) => o.workspace === 'ws2'),
      `the new tree is read: ${JSON.stringify(reads)}`);
    assert(JSON.stringify(keys(m)) === '["untracked:new.md"]', `and drawn: ${JSON.stringify(keys(m))}`);
    const changed = m.changesAsked().length;
    m.emitChange([{ path: '', kinds: ['worktree'] }], 'ws2');
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.changesAsked().length > changed && m.changesAsked().at(-1).workspace === 'ws2',
      'a change in the new tree reads it again');
    m.teardown();
    assert(m.watchers() === 0, `teardown leaves no watch behind: ${m.watchers()}`);
  });

  await test('a wide pin is split', async () => {
    const m = await mounted({ changes: changesOf([unstaged]) });
    assert(m.body.querySelector('.git-pin')?.getAttribute('data-mode') === 'split', 'wide is split');
    m.teardown();
  });

  return { passed, failed, errors };
}
