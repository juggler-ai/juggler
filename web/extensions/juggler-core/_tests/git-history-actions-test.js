//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin History place tests for what can be done at a commit — its ⋯ and
 * right-click menu and the detail's buttons, the ops they send, the hard
 * reset's question, the resets' Undo, and what a refusal offers next. The fake
 * services, and the synthetic history, are git-pin-helpers'.
 * @module _tests/git-history-actions-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { commitOf, confirmPop, historyOf, mountPin, refsOf, shaOf, treeOf } from './git-pin-helpers.js';

/** The commit the cases act on, and HEAD. */
const SHA = shaOf(3);
const HEAD = shaOf(0);

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
      for (const pop of document.querySelectorAll('.git-pop, .juggler-context-menu')) pop.remove();
    }
  }

  const pin = new GitPin();
  const onMain = {
    refs: refsOf({ branches: [{ name: 'main', sha: HEAD, subject: 'Tip', date: 0, ahead: 0, behind: 0, worktree: '/tmp/proj', head: true }] }),
    worktrees: { repo: '', trees: [treeOf({ main: true, current: true, branch: 'main', head: HEAD })] },
  };

  /**
   * Mount in the History place, on branch main at HEAD, and wait until the
   * refs and worktrees are read: the commit menu names the branch.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (options = {}) => {
    const m = mountPin(pin, {
      place: 'history',
      log: historyOf(40),
      commit: (/** @type {string} */ rev) => commitOf(rev),
      ...onMain,
      ...options,
    });
    await waitFor(() => rowAt(m, 3) && m.reads().some((/** @type {any} */ r) => r.kind === 'worktrees')
      && (rowAt(m, 0)?.querySelector('.git-history__chip')), 'the rows and their chips to be drawn');
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - A row's position.
   * @returns {HTMLElement|null} It, when drawn.
   */
  const rowAt = (m, index) => /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-history__row[data-index="${index}"]`));
  /**
   * Open a row's ⋯ menu.
   * @param {any} m - The mounted pin.
   * @param {number} index - The row.
   */
  const openMore = (m, index) => {
    const more = /** @type {HTMLElement|null} */ (rowAt(m, index)?.querySelector('.git-history__more') || null);
    if (!more) throw new Error(`row ${index} has no ⋯`);
    more.click();
  };
  /** @returns {HTMLElement[]} The open menu's rows. */
  const menuItems = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.juggler-context-menu .menu-item')]);
  /** @returns {string[]} Their words. */
  const menuLabels = () => menuItems().map((el) => el.textContent || '');
  /**
   * @param {string} label - The start of a menu row's words.
   */
  const choose = (label) => {
    const found = menuItems().find((el) => (el.textContent || '').startsWith(label));
    if (!found) throw new Error(`no menu row "${label}": ${JSON.stringify(menuLabels())}`);
    found.click();
  };
  /**
   * Select a row and wait for its commit to be read, which draws the detail
   * once more.
   * @param {any} m - The mounted pin.
   * @param {number} index - The row.
   */
  const open = async (m, index) => {
    /** @type {HTMLElement} */ (rowAt(m, index)).click();
    await waitFor(() => m.body.querySelector('.git-history__detail .git-history__message'), 'the commit to be read');
  };
  /**
   * One of the detail's actions: a button for the first group, otherwise a row
   * of the menu its ⋯ opens, which this opens.
   * @param {any} m - The mounted pin.
   * @param {string} label - The start of the action's words.
   * @returns {HTMLElement} That button or row.
   */
  const action = (m, label) => {
    const buttons = /** @type {HTMLButtonElement[]} */ ([...m.body.querySelectorAll('.git-history__detail .git-history__act')]);
    const button = buttons.find((b) => (b.textContent || '').startsWith(label));
    if (button) return button;
    const more = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-history__detail .git-history__act-more'));
    if (!more) throw new Error(`no action "${label}" and no ⋯: ${JSON.stringify(buttons.map((b) => b.textContent))}`);
    more.click();
    const row = menuItems().find((el) => (el.textContent || '').startsWith(label));
    if (!row) throw new Error(`no action "${label}": ${JSON.stringify([...buttons.map((b) => b.textContent), ...menuLabels()])}`);
    return row;
  };
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
  /**
   * Answer the open name question.
   * @param {string} value - The name.
   */
  const answer = (value) => {
    /** @type {HTMLInputElement} */ (inPop('.git-pop__input')).value = value;
    inPop('.git-pop__ok').click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The toast's words, '' when none is up.
   */
  const toastText = (m) => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-text')?.textContent || '';
  /**
   * @param {any} m - The mounted pin.
   * @param {string} cls - `undo` or `action`.
   * @returns {Promise<HTMLElement>} That button on the toast, once one is up with it.
   */
  const toastButton = (m, cls) => /** @type {Promise<HTMLElement>} */ (waitFor(
    () => m.body.querySelector(`.git-pin__toast:not([hidden]) .git-pin__toast-${cls}:not([hidden])`), `the toast's ${cls} button`));
  /**
   * @param {any} a - An op.
   * @param {Record<string, any>} b - What it should be.
   * @returns {boolean} Whether they hold the same fields, in any order.
   */
  const same = (a, b) => {
    /**
     * @param {any} o - An object.
     * @returns {string} Its fields, sorted.
     */
    const norm = (o) => JSON.stringify(Object.entries(o || {}).sort(([x], [y]) => x.localeCompare(y)));
    return norm(a) === norm(b);
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - Which run.
   * @returns {any} The op it sent.
   */
  const opAt = (m, index) => m.runs()[index]?.op;

  await test('a commit offers checkout, branch, tag, worktree, cherry-pick, revert, the rewrites, the resets and Copy SHA', async () => {
    const m = await mounted();
    openMore(m, 3);
    const want = [
      'Checkout (detached)', 'Branch here…', 'Tag here…', 'New worktree from here…',
      'Cherry-pick onto main', 'Revert',
      'Edit commit message…', 'Fix up with staged changes', 'Drop commit',
      'Reset main here — keep changes staged', 'Reset main here — keep changes', 'Reset main here — discard changes…',
      'Copy SHA',
    ];
    assert(JSON.stringify(menuLabels()) === JSON.stringify(want), `items: ${JSON.stringify(menuLabels())}`);
    assert(rowAt(m, 3)?.getAttribute('aria-selected') !== 'true', 'the ⋯ leaves the selection alone');
    for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();

    const row = /** @type {HTMLElement} */ (rowAt(m, 4));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    assert(menuLabels().length === want.length && menuLabels()[0] === 'Checkout (detached)', `right-click: ${JSON.stringify(menuLabels())}`);
    m.teardown();
  });

  await test('on a detached HEAD nothing is named after a branch', async () => {
    const m = mountPin(pin, {
      place: 'history',
      log: historyOf(40),
      commit: (/** @type {string} */ rev) => commitOf(rev),
      refs: refsOf(),
      worktrees: { repo: '', trees: [treeOf({ main: true, current: true, detached: true, branch: '', head: HEAD })] },
    });
    await waitFor(() => (rowAt(m, 0)?.textContent || '').includes('(detached)'), 'the detached HEAD to be marked');
    openMore(m, 3);
    const labels = menuLabels();
    assert(labels.includes('Checkout (detached)') && labels.includes('Revert') && labels.includes('Copy SHA'), `items: ${JSON.stringify(labels)}`);
    assert(!labels.some((l) => l.startsWith('Cherry-pick') || l.startsWith('Reset')), `nothing branch-named: ${JSON.stringify(labels)}`);
    m.teardown();
  });

  await test('a commit a branch stands at offers that branch\u2019s checkout ahead of the detached one', async () => {
    const branch = (/** @type {object} */ b) => ({ subject: '', date: 0, ahead: 0, behind: 0, ...b });
    const m = await mounted({
      refs: refsOf({
        branches: [
          branch({ name: 'main', sha: HEAD, worktree: '/tmp/proj', head: true }),
          branch({ name: 'topic', sha: SHA }),
          branch({ name: 'elsewhere', sha: SHA, worktree: '/tmp/other' }),
        ],
        remotes: [{ name: 'origin', branches: [
          { name: 'topic', sha: SHA, subject: '', date: 0 },
          { name: 'feature', sha: SHA, subject: '', date: 0 },
        ] }],
      }),
    });
    openMore(m, 3);
    const labels = menuLabels();
    const want = ['Checkout topic', 'Checkout origin/feature as local branch', 'Checkout (detached)'];
    assert(JSON.stringify(labels.slice(0, 3)) === JSON.stringify(want), `items: ${JSON.stringify(labels)}`);
    assert(!labels.some((l) => l.includes('elsewhere') || l.includes('origin/topic')),
      `a branch out in another tree, or a remote one with a local namesake, is offered: ${JSON.stringify(labels)}`);
    choose('Checkout topic');
    assert(same(opAt(m, 0), { repo: '', kind: 'switch', branch: 'topic' }), `checkout ${JSON.stringify(opAt(m, 0))}`);
    openMore(m, 3);
    choose('Checkout origin/feature');
    assert(same(opAt(m, 1), { repo: '', kind: 'switch', branch: 'feature', rev: 'origin/feature', track: true }), `tracking ${JSON.stringify(opAt(m, 1))}`);

    await open(m, 3);
    assert(action(m, 'Checkout topic').classList.contains('git-history__act'), 'the detail offers it as a button');
    openMore(m, 0);
    assert(!menuLabels().some((l) => l === 'Checkout main'), `the branch checked out here is offered: ${JSON.stringify(menuLabels())}`);
    m.teardown();
  });

  await test('each action sends its op for the commit', async () => {
    const m = await mounted();
    openMore(m, 3);
    choose('Checkout (detached)');
    assert(same(opAt(m, 0), { repo: '', kind: 'switch', rev: SHA, detach: true }), `checkout ${JSON.stringify(opAt(m, 0))}`);
    openMore(m, 3);
    choose('Branch here…');
    answer('topic');
    assert(same(opAt(m, 1), { repo: '', kind: 'branch-create', name: 'topic', rev: SHA }), `branch ${JSON.stringify(opAt(m, 1))}`);
    openMore(m, 3);
    choose('Tag here…');
    answer('v1');
    assert(same(opAt(m, 2), { repo: '', kind: 'tag-create', name: 'v1', rev: SHA }), `tag ${JSON.stringify(opAt(m, 2))}`);

    await open(m, 3);
    action(m, 'Cherry-pick onto main').click();
    assert(!opAt(m, 3), 'a cherry-pick asks first');
    assert(confirmPop().includes('onto main'), 'and names the branch it lands on');
    assert(same(opAt(m, 3), { repo: '', kind: 'cherry-pick', rev: SHA }), `pick ${JSON.stringify(opAt(m, 3))}`);
    action(m, 'Revert').click();
    assert(!opAt(m, 4), 'a revert asks first');
    confirmPop();
    assert(same(opAt(m, 4), { repo: '', kind: 'revert', rev: SHA }), `revert ${JSON.stringify(opAt(m, 4))}`);
    action(m, 'New worktree from here…').click();
    const call = await waitFor(() => m.workspaceCalls().find((/** @type {any} */ c) => c.call === 'create'), 'the setup to open');
    assert(call.args[0].providerId === 'git-worktree' && call.args[0].values?.base === SHA, `create ${JSON.stringify(call)}`);
    m.teardown();
  });

  await test('Tag here… asks for an optional message: empty makes a lightweight tag, filled sends it', async () => {
    const m = await mounted();
    openMore(m, 3);
    choose('Tag here…');
    const message = /** @type {HTMLTextAreaElement} */ (inPop('.git-pop__input--secondary'));
    assert((message.closest('label')?.textContent || '').includes('Message (optional — makes an annotated tag)'),
      `the message's label: ${message.closest('label')?.textContent}`);
    answer('v1');
    assert(same(opAt(m, 0), { repo: '', kind: 'tag-create', name: 'v1', rev: SHA }), `lightweight ${JSON.stringify(opAt(m, 0))}`);
    openMore(m, 3);
    choose('Tag here…');
    /** @type {HTMLTextAreaElement} */ (inPop('.git-pop__input--secondary')).value = '  Release one\n\nNotes  ';
    answer('v2');
    assert(same(opAt(m, 1), { repo: '', kind: 'tag-create', name: 'v2', rev: SHA, message: 'Release one\n\nNotes' }),
      `annotated ${JSON.stringify(opAt(m, 1))}`);
    m.teardown();
  });

  await test('a hard reset asks first, and its Undo resets back and writes the changes back', async () => {
    const m = await mounted();
    m.holdRuns(true);
    openMore(m, 3);
    choose('Reset main here — discard changes…');
    assert(m.runs().length === 0, 'nothing is sent before the answer');
    inPop('.git-pop__ok').click();
    const op = opAt(m, 0);
    assert(op?.kind === 'reset' && op.rev === SHA && op.mode === 'hard' && op.expectHead === HEAD, `reset ${JSON.stringify(op)}`);
    const saved = 'd'.repeat(40);
    m.finishRun(0, { result: { sha: HEAD, head: SHA, saved } });
    (await toastButton(m, 'undo')).click();
    const undo = opAt(m, 1);
    assert(same(undo, { repo: '', kind: 'reset', rev: HEAD, mode: 'hard', expectHead: SHA, discard: saved }),
      `undo ${JSON.stringify(undo)}`);
    m.teardown();
  });

  await test('the hard reset toast says Undo leaves the staging', async () => {
    const m = await mounted();
    m.holdRuns(true);
    openMore(m, 3);
    choose('Reset main here — discard changes…');
    inPop('.git-pop__ok').click();
    m.finishRun(0, { result: { sha: HEAD, head: SHA, saved: 'd'.repeat(40) } });
    await toastButton(m, 'undo');
    assert(toastText(m).includes('not what was staged'), `toast: ${toastText(m)}`);
    m.teardown();
  });

  await test('a soft reset needs no question, and its Undo resets back', async () => {
    const m = await mounted();
    m.holdRuns(true);
    openMore(m, 3);
    choose('Reset main here — keep changes staged');
    const op = opAt(m, 0);
    assert(same(op, { repo: '', kind: 'reset', rev: SHA, mode: 'soft', expectHead: HEAD }), `reset ${JSON.stringify(op)}`);
    m.finishRun(0, { result: { sha: HEAD, head: SHA } });
    (await toastButton(m, 'undo')).click();
    const undo = opAt(m, 1);
    assert(same(undo, { repo: '', kind: 'reset', rev: HEAD, mode: 'soft', expectHead: SHA }), `undo ${JSON.stringify(undo)}`);
    m.teardown();
  });

  await test('changes in the way of a revert offer to stash them and revert again', async () => {
    const m = await mounted();
    m.holdRuns(true);
    await open(m, 3);
    action(m, 'Revert').click();
    confirmPop();
    m.failRun(0, { kind: 'dirty', message: 'Local changes are in the way.' });
    const retry = await toastButton(m, 'action');
    assert(retry.textContent === 'Stash them, then revert', `the button: ${retry.textContent}`);
    retry.click();
    const again = opAt(m, 1);
    assert(same(again, { repo: '', kind: 'revert', rev: SHA, dirty: 'stash' }), `retry ${JSON.stringify(again)}`);
    m.teardown();
  });

  await test('Copy SHA copies the whole commit id', async () => {
    const before = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    /** @type {string[]} */
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (/** @type {string} */ text) => { copied.push(text); } } });
    try {
      const m = await mounted();
      openMore(m, 3);
      choose('Copy SHA');
      await waitFor(() => toastText(m).includes('Copied'), 'the Copied toast');
      assert(JSON.stringify(copied) === JSON.stringify([SHA]), `copied ${JSON.stringify(copied)}`);
      m.teardown();
    } finally {
      if (before) Object.defineProperty(navigator, 'clipboard', before);
      else delete (/** @type {any} */ (navigator)).clipboard;
    }
  });

  /** The pin's own words the case below draws, registered pseudo-localised. */
  const CORE_TEXT = [
    'Checkout (detached)', 'Branch here…', 'Tag here…', 'New worktree from here…', 'Cherry-pick onto {branch}', 'Revert',
    'Reset {branch} here — keep changes staged', 'Reset {branch} here — keep changes', 'Reset {branch} here — discard changes…',
    'Copy SHA', 'Cancel', 'Reset', 'Undo', 'Edit commit message…', 'Fix up with staged changes', 'Drop commit',
    'Fold what is staged into this commit', 'Take this commit out of the branch (undoable)',
    'Reset {branch} to {sha}, throwing away the changes to tracked files? They are saved first, so Undo can put them back.',
    'Reset {branch} to {sha}. Undo puts back your changes, but not what was staged.',
  ];

  await test('en-XA: what a commit offers, and what a hard reset says, speak the user\u2019s language', async () => {
    await underPseudoLocale('git-history-actions-test', async () => {
      const m = await mounted();
      m.holdRuns(true);
      await open(m, 3);
      const buttons = [...m.body.querySelectorAll('.git-history__detail .git-history__act')].map((b) => b.textContent || '');
      openMore(m, 3);
      const rows = menuLabels();
      const last = /** @type {HTMLElement} */ (menuItems().filter((el) => !el.classList.contains('menu-item-unavailable')).at(-2));
      last.click();
      const question = [...document.querySelectorAll('.git-pop .git-pop__text, .git-pop button')].map((el) => el.textContent || '');
      inPop('.git-pop__ok').click();
      m.finishRun(0, { result: { sha: HEAD, head: SHA, saved: 'd'.repeat(40) } });
      await toastButton(m, 'undo');
      const toast = [...m.body.querySelectorAll('.git-pin__toast-text, .git-pin__toast-undo')].map((el) => el.textContent || '');
      const shown = [...buttons, ...rows, ...question, ...toast];
      // The branch's name and the commits' short ids are data, not words.
      const data = /\bmain\b|\b[a-f0-9]{7}\b/g;
      const raw = shown.map((x) => x.trim()).filter((x) => x && !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
      assert(buttons.length >= 4 && rows.length >= 9 && question.length >= 3 && toast.length >= 2, `expected text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
