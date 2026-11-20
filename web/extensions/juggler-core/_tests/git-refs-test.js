//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin Refs place tests — the sections, the actions a branch, remote
 * branch and stash offer and the ops they send, the undo toasts, the inline
 * confirm and choice, and the re-read a refs change causes. The fake services
 * are git-pin-helpers'.
 * @module _tests/git-refs-test
 */

import GitPin from '../pins/git-pin.js';
import { isolateFocus } from '../../../js-tests/utilities/isolate-focus.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf, confirmPop, mountPin, refsOf, treeOf } from './git-pin-helpers.js';

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
    } finally {
      for (const pop of document.querySelectorAll('.git-pop')) pop.remove();
    }
  }

  const pin = new GitPin();
  const SHA = 'aaaaaaa000000000000000000000000000000000';
  const main = treeOf({ path: '/tmp/proj', main: true, current: true, branch: 'develop', tree: '' });
  const other = treeOf({ path: '/tmp/wt-feat', branch: 'feat', tree: 'wt:feat' });
  const refs = refsOf({
    branches: [
      { name: 'develop', sha: SHA, subject: 'Tip', date: 0, ahead: 0, behind: 0, worktree: '/tmp/proj', head: true },
      { name: 'feat', sha: SHA, subject: 'Feat', date: 0, ahead: 0, behind: 0, worktree: '/tmp/wt-feat' },
      { name: 'old', sha: SHA, subject: 'Old', date: 0, ahead: 0, behind: 0 },
    ],
    remotes: [
      { name: 'origin', branches: [{ name: 'feature', sha: SHA, subject: 'Remote', date: 0 }] },
      { name: 'upstream', branches: [{ name: 'main', sha: SHA, subject: 'Up', date: 0 }] },
    ],
    tags: [{ name: 'v1', sha: 'bbbbbbb', target: SHA, annotated: false, subject: 'Tag', date: 0 }],
    stashes: [{ sha: 'ccccccc', message: 'WIP on develop: thing', date: 0 }],
  });

  /**
   * Mount in the Refs place and wait for both its reads to be drawn: the
   * stash (refs) and the second tree (worktrees).
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (options = {}) => {
    const m = mountPin(pin, { place: 'refs', refs, worktrees: { repo: '', trees: [main, other] }, ...options });
    await waitFor(() => m.body.querySelector('.git-refs__row[data-key="st:ccccccc"]')
      && m.body.querySelector('.git-refs__row[data-key="wt:/tmp/wt-feat"]'), 'the refs and worktrees to be drawn');
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement|null} The Undo on the toast, once one is up.
   */
  const undoButton = (m) => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo');

  /**
   * Select a row, which draws its detail.
   * @param {any} m - The mounted pin.
   * @param {string} key - The row's key.
   */
  const pick = (m, key) => {
    const row = /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-refs__row[data-key="${CSS.escape(key)}"]`));
    if (!row) {
      const keys = [...m.body.querySelectorAll('.git-refs__row')].map((r) => r.getAttribute('data-key'));
      throw new Error(`no row ${key}: ${JSON.stringify(keys)}`);
    }
    row.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {string} label - The start of a detail button's label.
   * @returns {HTMLButtonElement} That button.
   */
  const action = (m, label) => {
    const buttons = /** @type {HTMLButtonElement[]} */ ([...m.body.querySelectorAll('.git-refs__detail .git-refs__act')]);
    const found = buttons.find((b) => (b.textContent || '').startsWith(label));
    if (!found) throw new Error(`no action "${label}": ${JSON.stringify(buttons.map((b) => b.textContent))}`);
    return found;
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The toast's text, '' when none is up.
   */
  const toastText = (m) => m.body.querySelector('.git-pin__toast:not([hidden])')?.textContent || '';
  /**
   * @param {string} selector - Within the open popover.
   * @returns {HTMLElement} The element.
   */
  const inPop = (selector) => {
    // A question for words is a form dialog; anything else, a popover.
    const found = /** @type {HTMLElement|null} */ (document.querySelector(`.git-pop ${selector}, .git-ask-dialog.is-open ${selector}`));
    if (!found) throw new Error(`no ${selector} in a popover: ${document.querySelector('.git-pop, .git-ask-dialog.is-open')?.textContent ?? '(none open)'}`);
    return found;
  };

  await test('the sections come in order: worktrees, branches, each remote, tags, stashes', async () => {
    const m = await mounted();
    const sections = [...m.body.querySelectorAll('.git-refs__sect')].map((s) => s.getAttribute('data-section'));
    assert(JSON.stringify(sections) === JSON.stringify(['worktrees', 'branches', 'remote:origin', 'remote:upstream', 'tags', 'stashes']),
      `sections: ${JSON.stringify(sections)}`);
    const titles = m.body.querySelector('[data-section="remote:origin"]')?.textContent || '';
    assert(titles.includes('Remote · origin'), `a remote is named: ${titles}`);
    m.teardown();
  });

  await test('a section folds away to its header, and stays folded when the pin is mounted again', async () => {
    const m = await mounted();
    const fold = /** @type {HTMLElement} */ (m.body.querySelector('[data-section="tags"] .git-refs__fold'));
    assert(fold.getAttribute('aria-expanded') === 'true' && Boolean(m.body.querySelector('[data-key="tg:v1"]')), 'tags start open');
    fold.click();
    assert(!m.body.querySelector('[data-key="tg:v1"]'), 'a folded section drops its rows');
    assert(m.body.querySelector('[data-section="tags"] .git-refs__fold')?.getAttribute('aria-expanded') === 'false',
      'and its header says it is folded');
    assert(Boolean(m.body.querySelector('[data-key="st:ccccccc"]')), 'the other sections are left alone');
    const saved = m.configWrites().at(-1);
    assert(saved?.options.inPlace === true && JSON.stringify(saved.config.folded) === '["tags"]',
      `which sections are folded is written down, in place: ${JSON.stringify(saved)}`);
    m.teardown();

    const again = await mounted({ config: saved.config });
    assert(Boolean(again.body.querySelector('[data-section="tags"]')) && !again.body.querySelector('[data-key="tg:v1"]'),
      'mounted again from it, the section is still folded');
    /** @type {HTMLElement} */ (again.body.querySelector('[data-section="tags"] .git-refs__fold')).click();
    assert(Boolean(again.body.querySelector('[data-key="tg:v1"]')), 'and opens again on a click');
    assert(!('folded' in (again.configWrites().at(-1)?.config || {})), 'with nothing folded, nothing is written');
    again.teardown();
  });

  await test('/ filters the rows by name: sections left empty go, j walks what is shown, Esc brings all back', async () => {
    const focus = isolateFocus();
    try {
      const m = await mounted();
      const keys = () => [...m.body.querySelectorAll('.git-refs__row')].map((r) => r.getAttribute('data-key'));
      const sections = () => [...m.body.querySelectorAll('.git-refs__sect')].map((s) => s.getAttribute('data-section'));
      const selectedKey = () => m.body.querySelector('.git-refs__row[aria-selected="true"]')?.getAttribute('data-key');
      const press = (/** @type {string} */ key) => {
        m.body.querySelector('.git-pin').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      };
      const all = keys();
      const allSections = sections();
      const filter = /** @type {HTMLInputElement|null} */ (m.body.querySelector('.git-refs .git-list-filter__input'));
      assert(Boolean(filter?.closest('.git-list-filter')?.hasAttribute('hidden')), 'the filter is hidden until asked for');
      press('/');
      assert(focus.asked(/** @type {HTMLInputElement} */ (filter)), '/ focuses the filter');
      assert(!filter?.closest('.git-list-filter')?.hasAttribute('hidden'), '/ shows the filter');
      /** @type {HTMLInputElement} */ (filter).value = 'FEAT';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      assert(JSON.stringify(keys()) === JSON.stringify(['wt:/tmp/wt-feat', 'br:feat', 'rm:origin/feature']),
        `narrowed by name, case-insensitively: ${JSON.stringify(keys())}`);
      assert(JSON.stringify(sections()) === JSON.stringify(['worktrees', 'branches', 'remote:origin']),
        `a section with nothing shown has no header: ${JSON.stringify(sections())}`);
      press('j');
      press('j');
      assert(selectedKey() === 'br:feat', `j walks the rows shown: ${selectedKey()}`);
      press('j');
      assert(selectedKey() === 'rm:origin/feature', `j skips br:old: ${selectedKey()}`);
      /** @type {HTMLInputElement} */ (filter).value = 'nothing-is-called-this';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      assert(keys().length === 0 && (m.body.querySelector('.git-refs__scroll')?.textContent || '').includes('Nothing matches'),
        `nothing shown says so: ${m.body.querySelector('.git-refs__scroll')?.textContent}`);
      /** @type {HTMLInputElement} */ (filter).value = 'feat';
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
      assert(selectedKey() === 'rm:origin/feature', `filtering keeps the selection: ${selectedKey()}`);
      filter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(JSON.stringify(keys()) === JSON.stringify(all), `Esc brings every row back: ${JSON.stringify(keys())}`);
      assert(JSON.stringify(sections()) === JSON.stringify(allSections), `and every section: ${JSON.stringify(sections())}`);
      assert(filter?.value === '' && Boolean(filter.closest('.git-list-filter')?.hasAttribute('hidden')), 'Esc clears and hides the filter');
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('a branch out in another tree offers Go to worktree, and Delete is disabled with why', async () => {
    const m = await mounted();
    pick(m, 'br:feat');
    const del = action(m, 'Delete');
    assert(del.disabled && (del.title || '').includes('in wt-feat'), `delete disabled with its reason: ${del.disabled} ${del.title}`);
    action(m, 'Go to worktree “wt-feat”').click();
    await waitFor(() => m.configs().at(-1)?.workspace === 'wt:feat', 'the pin to move to that tree');
    m.teardown();
  });

  await test('the branch out here is Checked out here, disabled', async () => {
    const m = await mounted();
    pick(m, 'br:develop');
    assert(action(m, 'Checked out here').disabled, 'disabled');
    m.teardown();
  });

  /**
   * The question a delete asks, once the read of what it would strand has answered.
   * @param {any} m - The mounted pin.
   * @returns {Promise<string>} Its words.
   */
  const deleteQuestion = async (m) => {
    await waitFor(() => document.querySelector('.git-pop .git-pop__ok'), 'the question');
    assert(!m.runs().length, 'nothing is deleted before the answer');
    return document.querySelector('.git-pop .git-pop__text')?.textContent || '';
  };

  await test('delete asks first, sends expectSha, and Undo restores the ref at the old tip', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'br:old');
    action(m, 'Delete').click();
    const asked = await deleteQuestion(m);
    const read = m.reads().find((/** @type {any} */ r) => r.kind === 'stranded');
    assert(read?.options.ref === 'refs/heads/old', `asks what only the branch reaches: ${JSON.stringify(read?.options)}`);
    assert(asked.includes('stays reachable'), `says nothing is lost: ${asked}`);
    inPop('.git-pop__ok').click();
    const op = m.runs()[0]?.op;
    // Nothing else is lost, which the user has been told: git's own merged
    // check, which knows only HEAD and the upstream, is not asked again.
    assert(op?.kind === 'branch-delete' && op.branch === 'old' && op.expectSha === SHA && op.force === true, `op ${JSON.stringify(op)}`);
    m.finishRun(0, { result: { sha: SHA } });
    await waitFor(() => toastText(m).includes('Deleted old'), 'the Deleted toast');
    /** @type {HTMLElement} */ (undoButton(m)).click();
    const undo = m.runs()[1]?.op;
    assert(undo?.kind === 'ref-restore' && undo.ref === 'refs/heads/old' && undo.sha === SHA, `undo ${JSON.stringify(undo)}`);
    m.teardown();
  });

  await test('a branch whose commits nothing else reaches says how many before it is deleted', async () => {
    const m = await mounted({ stranded: (/** @type {string} */ ref) => ({ ref, count: 3 }) });
    m.holdRuns(true);
    pick(m, 'br:old');
    action(m, 'Delete').click();
    const asked = await deleteQuestion(m);
    assert(asked.includes('3 commits will be unreachable'), `names the loss: ${asked}`);
    inPop('.git-pop__ok').click();
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'branch-delete' && op.force === true && op.expectSha === SHA, `forced ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('when what a delete strands can’t be read, git’s unmerged check still asks before forcing', async () => {
    const m = await mounted({ stranded: () => { throw new Error('no answer'); } });
    m.holdRuns(true);
    pick(m, 'br:old');
    action(m, 'Delete').click();
    const asked = await deleteQuestion(m);
    assert(asked.includes('Couldn’t tell') || asked.includes("Couldn't tell"), `says it couldn't tell: ${asked}`);
    inPop('.git-pop__ok').click();
    assert(m.runs()[0]?.op.force !== true, `unforced: ${JSON.stringify(m.runs()[0]?.op)}`);
    m.failRun(0, { kind: 'unmerged', message: 'not fully merged' });
    await waitFor(() => document.querySelector('.git-pop .git-pop__ok'), 'the unmerged question');
    inPop('.git-pop__ok').click();
    const op = m.runs()[1]?.op;
    assert(op?.kind === 'branch-delete' && op.force === true && op.expectSha === SHA, `forced ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('deleting a tag asks first, saying whether its commit becomes unreachable', async () => {
    for (const [count, words] of /** @type {const} */ ([[0, 'stays reachable'], [1, 'that commit will be unreachable']])) {
      const m = await mounted({ stranded: (/** @type {string} */ ref) => ({ ref, count }) });
      m.holdRuns(true);
      pick(m, 'tg:v1');
      action(m, 'Delete tag').click();
      const asked = await deleteQuestion(m);
      assert(m.reads().find((/** @type {any} */ r) => r.kind === 'stranded')?.options.ref === 'refs/tags/v1', 'asks about the tag');
      assert(asked.includes(words) && asked.includes(SHA.slice(0, 7)), `${count}: ${asked}`);
      inPop('.git-pop__ok').click();
      const op = m.runs()[0]?.op;
      assert(op?.kind === 'tag-delete' && op.name === 'v1' && op.expectSha === 'bbbbbbb', `op ${JSON.stringify(op)}`);
      m.teardown();
    }
  });

  await test('a write from Refs is read again by every place, not Refs alone', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'tg:v1');
    action(m, 'Delete tag').click();
    await deleteQuestion(m);
    inPop('.git-pop__ok').click();
    const changesBefore = m.changesAsked().length;
    m.setRefs(refsOf({ ...refs, tags: [] }));
    m.finishRun(0, { result: { sha: 'bbbbbbb' } });
    await waitFor(() => !m.body.querySelector('.git-refs__row[data-key="tg:v1"]'), 'the deleted tag to go from Refs');
    await waitFor(() => m.changesAsked().length > changesBefore,
      'Changes, which the head is drawn from, to be read again after the write');
    m.teardown();
  });

  await test('checkout on a dirty tree asks: carry or stash, and sends that', async () => {
    const files = [{ path: 'a.js', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } }];
    const m = await mounted({ changes: changesOf(files) });
    await waitFor(() => (m.body.querySelector('.git-pin__dirty .git-pin__stat-num')?.textContent || '') === '1', 'the changes to be read');
    m.holdRuns(true);
    for (const choice of ['carry', 'stash']) {
      pick(m, 'br:old');
      action(m, 'Checkout').click();
      inPop(`[data-choice="${choice}"]`).click();
      const op = m.runs().at(-1)?.op;
      assert(op?.kind === 'switch' && op.branch === 'old' && op.dirty === choice, `${choice}: ${JSON.stringify(op)}`);
      const refsReads = () => m.reads().filter((/** @type {any} */ r) => r.kind === 'refs').length;
      const before = refsReads();
      m.finishRun(m.runs().length - 1);
      await waitFor(() => refsReads() > before, 'the refs read after the switch');
    }
    m.teardown();
  });

  await test('a remote branch checks out as a local tracking branch', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'rm:origin/feature');
    action(m, 'Checkout as local branch').click();
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'switch' && op.branch === 'feature' && op.rev === 'origin/feature' && op.track === true, `op ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('New worktree from branch… opens the git-worktree setup with the branch', async () => {
    const m = await mounted();
    pick(m, 'br:old');
    action(m, 'New worktree from branch…').click();
    const call = await waitFor(() => m.workspaceCalls().find((/** @type {any} */ c) => c.call === 'create'), 'the setup to open');
    assert(call && call.args[0].providerId === 'git-worktree' && call.args[0].values?.branch === 'old',
      `create ${JSON.stringify(m.workspaceCalls())}`);
    m.teardown();
  });

  await test('a tag offers Push tag, which sends push-tag with its name to the branch’s remote, or origin', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'tg:v1');
    action(m, 'Push tag').click();
    assert(!m.runs().length, 'a push asks first');
    assert(confirmPop().includes('to origin'), 'and says where to');
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'push-tag' && op.name === 'v1' && op.remote === 'origin', `op ${JSON.stringify(op)}`);
    m.teardown();
    const upstreamed = refsOf({
      ...refs,
      branches: refs.branches.map((/** @type {any} */ b) => (b.name === 'develop' ? { ...b, upstream: 'upstream/main' } : b)),
    });
    const n = await mounted({ refs: upstreamed });
    n.holdRuns(true);
    pick(n, 'tg:v1');
    action(n, 'Push tag').click();
    confirmPop();
    const pushed = n.runs()[0]?.op;
    assert(pushed?.kind === 'push-tag' && pushed.name === 'v1' && pushed.remote === 'upstream', `upstream ${JSON.stringify(pushed)}`);
    n.teardown();
  });

  /**
   * @param {any} m - The mounted pin.
   * @param {string} section - A section's id.
   * @param {string} label - One of its header's buttons.
   * @returns {HTMLButtonElement} That button.
   */
  const sectAct = (m, section, label) => {
    const buttons = /** @type {HTMLButtonElement[]} */ ([...m.body.querySelectorAll(`.git-refs__sect[data-section="${CSS.escape(section)}"] .git-refs__sect-act`)]);
    const found = buttons.find((b) => b.textContent === label);
    if (!found) throw new Error(`no "${label}" on ${section}: ${JSON.stringify(buttons.map((b) => b.textContent))}`);
    return found;
  };
  /**
   * Choose one of a section's actions from its header's ⋯ menu.
   * @param {any} m - The mounted pin.
   * @param {string} section - A section's id.
   * @param {string} label - The action.
   */
  const sectMenu = (m, section, label) => {
    const more = /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-refs__sect[data-section="${CSS.escape(section)}"] .git-refs__sect-more`));
    if (!more) throw new Error(`no ⋯ on ${section}`);
    more.click();
    const items = [...document.querySelectorAll('.juggler-context-menu .menu-item')];
    const found = /** @type {HTMLElement|undefined} */ (items.find((el) => el.textContent === label));
    if (!found) throw new Error(`no "${label}" in ${section}'s menu: ${JSON.stringify(items.map((el) => el.textContent))}`);
    found.click();
  };
  /**
   * Answer the open question for words.
   * @param {string} value - The first field's.
   * @param {{secondary?: string, check?: boolean}} [more] - The second field's, and the checkbox.
   */
  const answer = (value, more = {}) => {
    /** @type {HTMLInputElement} */ (inPop('.git-pop__input:not(.git-pop__input--secondary)')).value = value;
    if (more.secondary !== undefined) /** @type {HTMLInputElement} */ (inPop('.git-pop__input--secondary')).value = more.secondary;
    if (more.check !== undefined) /** @type {HTMLInputElement} */ (inPop('.git-pop__check input')).checked = more.check;
    inPop('.git-pop__ok').click();
  };

  await test('a merge can be made a merge commit always; a squash stages and says so', async () => {
    const m = await mounted();
    m.holdRuns(true);
    for (const noFF of [false, true]) {
      pick(m, 'br:old');
      action(m, 'Merge into develop').click();
      const box = /** @type {HTMLInputElement} */ (inPop('.git-pop__check input'));
      assert(!box.checked, 'no-fast-forward starts unticked');
      if (noFF) box.click();
      inPop('.git-pop__ok').click();
      const op = m.runs().at(-1)?.op;
      assert(op?.kind === 'merge' && op.rev === 'old' && op.mode === (noFF ? 'no-ff' : undefined), `merge (no-ff ${noFF}): ${JSON.stringify(op)}`);
    }
    pick(m, 'br:old');
    action(m, 'Squash into develop…').click();
    assert(confirmPop().includes('staged'), 'the squash says it only stages');
    const squash = m.runs().at(-1)?.op;
    assert(squash?.kind === 'merge' && squash.rev === 'old' && squash.mode === 'squash', `squash: ${JSON.stringify(squash)}`);
    m.finishRun(m.runs().length - 1);
    await waitFor(() => toastText(m).includes('Commit them to finish'), 'the squash toast');
    m.teardown();
  });

  await test('Push to… sends the branch to the remote and branch typed, tracking only when asked', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'br:old');
    action(m, 'Push to…').click();
    const field = /** @type {HTMLInputElement} */ (inPop('.git-pop__input'));
    assert(field.value === 'origin/old', `starts at the obvious remote: ${field.value}`);
    assert(!(/** @type {HTMLInputElement} */ (inPop('.git-pop__check input'))).checked, 'tracking starts unticked');
    answer('upstream/review/one');
    let op = m.runs().at(-1)?.op;
    assert(op?.kind === 'push' && op.branch === 'old' && op.remote === 'upstream' && op.name === 'review/one' && !op.track, `push: ${JSON.stringify(op)}`);

    action(m, 'Push to…').click();
    answer('origin/old', { check: true });
    op = m.runs().at(-1)?.op;
    assert(op?.remote === 'origin' && op.name === 'old' && op.track === true, `tracked push: ${JSON.stringify(op)}`);

    const before = m.runs().length;
    action(m, 'Push to…').click();
    answer('nowhere/old');
    // Said in the question, which stays open to correct it — not in a toast
    // after it has gone.
    const problem = inPop('.git-pop__problem');
    assert(!problem.hidden && (problem.textContent || '').includes('is not a remote and a branch'), `the refusal: ${problem.textContent}`);
    assert(Boolean(document.querySelector('.git-ask-dialog.is-open')), 'the question closed on a target it refused');
    assert(inPop('.git-pop__input:not(.git-pop__input--secondary)').getAttribute('aria-invalid') === 'true', 'the field is not marked');
    assert(!toastText(m), `a toast said it too: ${toastText(m)}`);
    assert(m.runs().length === before, 'an unknown remote ran nothing');
    // The dialog's OK is busy until the refused answer has been handled.
    await nextTask();
    answer('upstream/fixed');
    op = m.runs().at(-1)?.op;
    assert(m.runs().length === before + 1 && op?.remote === 'upstream' && op.name === 'fixed', `the corrected push: ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('Tags push all; a remote is edited, removed, or added and fetched', async () => {
    const withUrls = refsOf({ ...refs, remotes: refs.remotes.map((/** @type {any} */ r) => ({ ...r, url: `https://example.com/${r.name}.git` })) });
    const m = await mounted({ refs: withUrls });
    m.holdRuns(true);
    sectAct(m, 'tags', 'Push all').click();
    assert(confirmPop().includes('to origin'), 'says where the tags go');
    let op = m.runs().at(-1)?.op;
    assert(op?.kind === 'push-tags' && op.remote === 'origin', `push-tags: ${JSON.stringify(op)}`);

    sectMenu(m, 'remote:upstream', 'Edit…');
    assert((/** @type {HTMLInputElement} */ (inPop('.git-pop__input--secondary'))).value === 'https://example.com/upstream.git', 'the URL is shown to edit');
    answer('up', { secondary: 'https://example.com/moved.git' });
    op = await waitFor(() => m.runs().at(-1)?.op.kind === 'remote-set-url' && m.runs().at(-1)?.op, 'the URL set');
    assert(op.remote === 'upstream' && op.url === 'https://example.com/moved.git', `set-url: ${JSON.stringify(op)}`);
    m.finishRun(m.runs().length - 1);
    op = await waitFor(() => m.runs().at(-1)?.op.kind === 'remote-rename' && m.runs().at(-1)?.op, 'the rename after it');
    assert(op.remote === 'upstream' && op.name === 'up', `rename: ${JSON.stringify(op)}`);
    m.finishRun(m.runs().length - 1);

    sectMenu(m, 'remote:origin', 'Remove…');
    assert(confirmPop().includes('Nothing on the remote itself changes'), 'says the remote itself is untouched');
    op = m.runs().at(-1)?.op;
    assert(op?.kind === 'remote-remove' && op.remote === 'origin', `remove: ${JSON.stringify(op)}`);
    m.finishRun(m.runs().length - 1);

    /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__more')).click();
    const add = /** @type {HTMLElement|undefined} */ ([...document.querySelectorAll('.juggler-context-menu .menu-item')].find((el) => el.textContent === 'Add remote…'));
    assert(Boolean(add), 'the ⋯ menu offers Add remote…');
    add?.click();
    answer('fork', { secondary: 'git@example.com:me/fork.git' });
    op = m.runs().at(-1)?.op;
    assert(op?.kind === 'remote-add' && op.name === 'fork' && op.url === 'git@example.com:me/fork.git', `add: ${JSON.stringify(op)}`);
    m.finishRun(m.runs().length - 1);
    op = await waitFor(() => m.runs().at(-1)?.op.kind === 'fetch' && m.runs().at(-1)?.op, 'a fetch of the new remote');
    m.teardown();
  });

  await test('dropping a stash can be undone with stash-store', async () => {
    const m = await mounted();
    m.holdRuns(true);
    pick(m, 'st:ccccccc');
    action(m, 'Drop').click();
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'stash-drop' && op.stash === 'ccccccc', `op ${JSON.stringify(op)}`);
    m.finishRun(0, { result: { stash: 'ccccccc', message: 'WIP on develop: thing' } });
    /** @type {HTMLElement} */ (await waitFor(() => undoButton(m), 'the Dropped toast')).click();
    const undo = m.runs()[1]?.op;
    assert(undo?.kind === 'stash-store' && undo.stash === 'ccccccc' && undo.message === 'WIP on develop: thing', `undo ${JSON.stringify(undo)}`);
    m.teardown();
  });

  await test('a right-click on a row selects it and opens its menu', async () => {
    const m = await mounted();
    const row = /** @type {HTMLElement} */ (m.body.querySelector('.git-refs__row[data-key="br:old"]'));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    try {
      const labels = [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent);
      assert(labels[0] === 'Checkout' && labels.includes('Rename…'), `the branch's menu: ${JSON.stringify(labels)}`);
      assert(m.body.querySelector('.git-refs__row[data-key="br:old"]')?.getAttribute('aria-selected') === 'true', 'the row is selected');
    } finally {
      for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();
      m.teardown();
    }
  });

  await test('a refs change reads the refs again', async () => {
    const m = await mounted();
    const before = m.reads().filter((/** @type {any} */ r) => r.kind === 'refs').length;
    assert(before > 0, 'read on show');
    m.emitChange([{ path: '', kinds: ['refs'] }]);
    await waitFor(() => m.reads().filter((/** @type {any} */ r) => r.kind === 'refs').length > before, 'the refs to be read again');
    m.teardown();
  });

  await test('Refs off screen reads nothing on a change, and reads once when shown again', async () => {
    const m = await mounted();
    /** @param {string} place - A place's id. */
    const tab = (place) => {
      /** @type {HTMLElement} */ (m.body.querySelector(`.git-pin__place-btn[data-place="${place}"]`)).click();
    };
    // Beside Changes, in a pin too narrow for the sidebar: there, but not on screen.
    tab('changes');
    const before = m.reads().length;
    /** @returns {string[]} The kinds read since. */
    const since = () => m.reads().slice(before).map((/** @type {any} */ r) => r.kind)
      .filter((/** @type {string} */ k) => k === 'refs' || k === 'worktrees' || k === 'submodules');
    m.emitChange([{ path: '', kinds: ['refs', 'head'] }]);
    m.emitResync();
    await nextTask();
    await nextTask();
    assert(since().length === 0, `nothing read while off screen: ${JSON.stringify(since())}`);
    tab('refs');
    await waitFor(() => since().length >= 3, 'the refs to be read on show');
    await nextTask();
    assert(JSON.stringify(since().sort()) === JSON.stringify(['refs', 'submodules', 'worktrees']), `one read of each: ${JSON.stringify(since())}`);
    m.teardown();
  });

  return { passed, failed, errors };
}
