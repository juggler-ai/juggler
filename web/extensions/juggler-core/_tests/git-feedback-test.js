//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin feedback tests — how the pin says what happened (pins/git/toast's
 * rules): the toast's three kinds and how long each stays, its timer stopping
 * under the pointer, a failure outliving a success that lands after it, Show
 * log, a failed push from Refs offering what the head's would, a failed
 * commit's output said once, and a dialog that keeps a wrong answer open with
 * the reason under the field. The fake services are git-pin-helpers'.
 * @module _tests/git-feedback-test
 */

import GitPin from '../pins/git-pin.js';
import { createToast, __holdToasts } from '../pins/git/toast.js';
import { injectGitClientStyles } from '../pins/git/styles.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf, confirmPop, mountPin, refsOf } from './git-pin-helpers.js';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {{teardown: () => void}[]} */
  const mounts = [];

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
      while (mounts.length) mounts.pop()?.teardown();
    }
  }

  const pin = new GitPin();
  const OLD = 'aaaaaaa000000000000000000000000000000000';

  /**
   * A bare toast in a stand-in pin, so the pin's stylesheet reaches it.
   * @param {Parameters<typeof createToast>[0]} [options] - The toast's options.
   * @returns {{toast: import('../pins/git/toast.js').PinToast, el: HTMLElement}} The toast, placed.
   */
  const placedToast = (options) => {
    injectGitClientStyles();
    const host = document.createElement('div');
    host.className = 'git-pin';
    host.style.cssText = 'position:absolute;left:-9999px;width:40rem;height:10rem';
    document.body.append(host);
    const toast = createToast(options);
    host.append(toast.element);
    mounts.push({ teardown: () => host.remove() });
    return { toast, el: toast.element };
  };
  /**
   * @param {HTMLElement} el - The toast.
   * @param {string} part - 'text', 'action', 'undo' or 'close'.
   * @returns {HTMLElement} That part.
   */
  const part = (el, part) => /** @type {HTMLElement} */ (el.querySelector(`.git-pin__toast-${part}`));
  /**
   * A colour, as the document resolves it there.
   * @param {Element} within - Where the tokens are defined.
   * @param {string} colour - A token ('--danger') or an expression of tokens.
   * @returns {string} The computed colour.
   */
  const tokenColour = (within, colour) => {
    const probe = document.createElement('span');
    probe.style.color = colour.startsWith('--') ? `var(${colour})` : colour;
    within.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };

  /**
   * The kind's colour shows: on the border, the glyph and the action.
   * @param {HTMLElement} el - The toast.
   * @param {string} token - The kind's token.
   * @param {string} glyph - Its glyph.
   * @param {string} what - The kind, for the message.
   */
  const coloured = (el, token, glyph, what) => {
    const border = getComputedStyle(el).borderTopColor;
    const expected = tokenColour(el, `color-mix(in srgb, var(${token}) 45%, transparent)`);
    assert(border === expected, `${what}'s border is not its colour: ${border}, not ${expected}`);
    const icon = part(el, 'icon');
    assert(icon.textContent === glyph && getComputedStyle(icon).color === tokenColour(el, token),
      `${what}'s glyph: "${icon.textContent}" in ${getComputedStyle(icon).color}`);
    assert(getComputedStyle(el).backgroundColor !== tokenColour(el, '--bg-raised'), `${what}'s surface is not tinted`);
  };

  await test('the three kinds: a success is one line; a warning and a failure wrap, stay, and close', async () => {
    __holdToasts(true);
    /** @type {string[]} */
    const shown = [];
    const { toast, el } = placedToast({ showLog: () => shown.push('log') });
    toast.show('Staged 2 files');
    assert(!el.hidden && el.dataset.kind === 'info' && el.getAttribute('role') === 'status', `a success: ${el.className} ${el.getAttribute('role')}`);
    assert(part(el, 'text').classList.contains('text-truncate') && part(el, 'close').hidden === true && part(el, 'action').hidden === true,
      'a success is one line, with nothing to close and nothing offered');
    coloured(el, '--success', '✓', 'a success');

    toast.warn('Stopped with conflicts to resolve.\nTwo files.', { label: 'Show them', run: () => shown.push('them') });
    assert(el.classList.contains('git-pin__toast--warn') && !el.classList.contains('git-pin__toast--error') && el.getAttribute('role') === 'status',
      `a warning: ${el.className}`);
    assert(!part(el, 'text').classList.contains('text-truncate') && getComputedStyle(part(el, 'text')).whiteSpace === 'pre-wrap',
      'a warning is not cut to a line');
    assert(!part(el, 'close').hidden && part(el, 'action').textContent === 'Show them', 'a warning closes, and offers its own action');
    coloured(el, '--warning', '!', 'a warning');
    assert(getComputedStyle(part(el, 'action')).color === tokenColour(el, '--warning'), 'a warning\u2019s action is not in its colour');
    part(el, 'close').click();
    assert(el.hidden === true, '✕ closes it');

    toast.error('git: index.lock exists');
    assert(el.classList.contains('git-pin__toast--error') && el.getAttribute('role') === 'alert', `a failure: ${el.className}`);
    coloured(el, '--danger', '✕', 'a failure');
    assert(part(el, 'action').textContent === 'Show log', `a failure with nothing to offer offers the log: ${part(el, 'action').textContent}`);
    part(el, 'action').click();
    assert(shown.join() === 'log' && el.hidden === true, `Show log opened the log and closed the toast: ${shown.join()}`);
  });

  await test('a warning or failure stays through a later success, and goes when the user starts another write', async () => {
    __holdToasts(false);
    const { toast, el } = placedToast();
    toast.error('push failed');
    toast.show('Fetched');
    assert(!el.hidden && part(el, 'text').textContent === 'push failed', `a success replaced the failure: ${part(el, 'text').textContent}`);
    toast.warn('Stopped with conflicts to resolve.');
    assert(part(el, 'text').textContent === 'Stopped with conflicts to resolve.', 'a warning replaces a failure');
    toast.userActed();
    assert(el.hidden === true, 'starting another write left the warning up');
    toast.show('Staged 1 file');
    toast.userActed();
    assert(!el.hidden && part(el, 'text').textContent === 'Staged 1 file', 'starting a write took a success away');
  });

  await test('a success hides itself, but not while the pointer or focus is on it', async () => {
    __holdToasts(false);
    // The timer is driven by hand: the toast's wall-clock spans are seconds.
    const realSet = window.setTimeout;
    const realClear = window.clearTimeout;
    /** @type {Map<number, {fn: () => void, ms: number}>} */
    const timers = new Map();
    let ids = 0;
    /** @type {any} */ (window).setTimeout = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      timers.set(++ids, { fn, ms });
      return ids;
    };
    /** @type {any} */ (window).clearTimeout = (/** @type {number} */ id) => { timers.delete(id); };
    try {
      const { toast, el } = placedToast();
      toast.show('Committed abc1234 to develop', () => {});
      assert(timers.size === 1 && [...timers.values()][0]?.ms === 8000, `one with Undo is up for 8s: ${JSON.stringify([...timers.values()].map((x) => x.ms))}`);
      el.dispatchEvent(new PointerEvent('pointerenter'));
      assert(timers.size === 0, 'the pointer on it did not stop its timer');
      el.dispatchEvent(new PointerEvent('pointerleave'));
      const left = [...timers.values()];
      assert(left.length === 1 && (left[0]?.ms || 0) > 0 && (left[0]?.ms || 0) <= 8000, `leaving it starts what was left: ${JSON.stringify(left.map((x) => x.ms))}`);
      part(el, 'undo').dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
      assert(timers.size === 0, 'focus on it did not stop its timer');
      part(el, 'undo').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
      assert(timers.size === 1, 'focus leaving did not start it again');
      [...timers.values()][0]?.fn();
      assert(el.hidden === true, 'the timer did not hide it');

      toast.show('Copied abc1234');
      assert([...timers.values()].at(-1)?.ms === 4000, 'a plain success is up for 4s');
      timers.clear();
      toast.error('push failed');
      assert(timers.size === 0, 'a failure set a timer');
    } finally {
      /** @type {any} */ (window).setTimeout = realSet;
      /** @type {any} */ (window).clearTimeout = realClear;
    }
  });

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement|null} The toast, while it is up.
   */
  const toastOf = (m) => m.body.querySelector('.git-pin__toast:not([hidden])');

  await test('in the pin, a failed write\u2019s toast outlives a success that lands after it, and Show log opens the log at it', async () => {
    const files = [
      { path: 'a.js', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } },
      { path: 'b.js', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } },
    ];
    const m = mountPin(pin, { place: 'changes', changes: changesOf(files) });
    mounts.push(m);
    await waitFor(() => m.body.querySelector('.git-changes__row[data-key="changes:b.js"]'), 'the rows');
    m.holdRuns(true);
    // A discard, still out, and then a stage that fails.
    m.body.querySelector('.git-changes__row[data-key="changes:a.js"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => m.body.querySelector('.git-changes__crumb-discard'), 'the detail');
    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__crumb-discard')).click();
    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__row[data-key="changes:b.js"] .git-changes__st')).click();
    await waitFor(() => m.runs().length === 2, 'both writes');
    const failure = m.failRun(1, { message: 'fatal: Unable to create index.lock: File exists.' });
    m.emitJob({ ...m.runs()[1].job, commands: [['add', '--', 'b.js']] });
    await waitFor(() => toastOf(m)?.classList.contains('git-pin__toast--error'), 'the failure');
    m.finishRun(0, { result: { discard: 'd1' } });
    for (let i = 0; i < 6; i++) await nextTask();
    assert((toastOf(m)?.textContent || '').includes('index.lock'), `the discard's success replaced the failure: ${toastOf(m)?.textContent}`);

    const toggle = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__log-toggle'));
    assert(toggle.dataset.state === 'failed' && toggle.querySelector('.git-pin__log-failed')?.textContent === '✗',
      `the closed log does not mark the failed command: ${toggle.textContent}`);
    const showLog = /** @type {HTMLElement} */ (toastOf(m)?.querySelector('.git-pin__toast-action:not([hidden])'));
    assert(showLog?.textContent === 'Show log', `the failure offers ${showLog?.textContent}`);
    showLog.click();
    assert(toggle.getAttribute('aria-expanded') === 'true', 'Show log did not open the log');
    const entry = m.body.querySelector(`.git-pin__log-entry[data-job="${failure.job?.id || m.runs()[1].job.id}"]`);
    assert(entry?.getAttribute('data-state') === 'failed' && (entry.textContent || '').includes('index.lock'),
      `the failed command is not in the open log: ${m.body.querySelector('.git-pin__log-list')?.textContent}`);
  });

  await test('a push from Refs that the remote turns down offers Pull or a forced push, with git\u2019s words whole', async () => {
    const m = mountPin(pin, {
      place: 'refs',
      changes: changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }),
      refs: refsOf({
        branches: [{ name: 'develop', sha: OLD, subject: 'Tip', date: 0, ahead: 1, behind: 0, upstream: 'origin/develop', worktree: '/tmp/proj', head: true }],
        remotes: [{ name: 'origin', branches: [{ name: 'develop', sha: OLD, subject: 'Theirs', date: 0 }] }],
      }),
    });
    mounts.push(m);
    const row = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-refs__row[data-key="br:develop"]'), 'the branch'));
    row.click();
    const pushTo = /** @type {HTMLElement} */ (await waitFor(() => [...m.body.querySelectorAll('.git-refs__detail .git-refs__act')]
      .find((b) => (b.textContent || '').startsWith('Push to')), 'Push to…'));
    pushTo.click();
    const field = /** @type {HTMLInputElement} */ (await waitFor(() => document.querySelector('.git-ask-dialog.is-open .git-pop__input'), 'the question'));
    field.value = 'origin/develop';
    m.holdRuns(true);
    /** @type {HTMLElement} */ (document.querySelector('.git-ask-dialog.is-open .git-pop__ok')).click();
    await waitFor(() => m.runs().length === 1, 'the push');
    const said = "To example.com:me/repo.git\n ! [rejected]        develop -> develop (fetch first)\nerror: failed to push some refs";
    m.failRun(0, { kind: 'rejected', message: said, job: { rejected: ['refs/heads/develop'], reason: 'fetch first' } });
    await waitFor(() => document.querySelector('.git-pop__choice'), 'the choices');
    const choices = [...document.querySelectorAll('.git-pop__choice')].map((b) => /** @type {HTMLElement} */ (b).dataset.choice);
    assert(choices.join(',') === 'pull,force', `choices: ${choices.join(',')}`);
    const detail = /** @type {HTMLElement|null} */ (document.querySelector('.git-pop .git-pop__detail'));
    assert(detail?.textContent === said, `git's words are not shown whole: ${detail?.textContent}`);
    assert(getComputedStyle(/** @type {HTMLElement} */ (detail)).whiteSpace === 'pre-wrap', 'git\u2019s lines are run together');
    assert(!toastOf(m), `a toast said it too: ${toastOf(m)?.textContent}`);

    /** @type {HTMLElement} */ (document.querySelector('.git-pop__choice[data-choice="force"]')).click();
    await waitFor(() => document.querySelector('.git-pop .git-pop__ok'), 'the force confirm');
    assert(confirmPop().includes('aaaaaaa'), 'the force confirm does not name the sha it would replace');
    await waitFor(() => m.runs().length === 2, 'the forced push');
    const forced = m.runs()[1].op;
    assert(forced.kind === 'push' && forced.force === true && forced.expectSha === OLD
      && forced.branch === 'develop' && forced.remote === 'origin' && forced.name === 'develop',
    `the forced push is not the one turned down, leased: ${JSON.stringify(forced)}`);
  });

  await test('a failed commit shows the hooks\u2019 output, and git\u2019s reason only when the output has not said it', async () => {
    const m = mountPin(pin, { place: 'changes', changes: changesOf([{ path: 'a.js', index: 'M', worktree: '.', staged: { added: 1, removed: 0 } }]) });
    mounts.push(m);
    const box = /** @type {HTMLTextAreaElement} */ (await waitFor(() => m.body.querySelector('.git-commit__msg'), 'the commit box'));
    await waitFor(() => m.body.querySelector('.git-changes__row[data-key="staged:a.js"]'), 'the staged file');
    const output = () => m.body.querySelector('.git-commit__output')?.textContent || '';
    for (const [hooks, reason, expected] of [
      ['running lint…\nlint: 2 errors', 'lint: 2 errors', 'running lint…\nlint: 2 errors'],
      ['running lint…', 'The pre-commit hook failed.', 'running lint…\nThe pre-commit hook failed.'],
    ]) {
      box.value = 'Did a thing';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      m.holdRuns(true);
      /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__go')).click();
      await waitFor(() => m.runs().some((/** @type {any} */ r) => !r.settled), 'the commit');
      m.failRun(undefined, { message: reason, job: { output: hooks } });
      await waitFor(() => output(), 'the output');
      assert(output() === expected, `the commit box says ${JSON.stringify(output())}, not ${JSON.stringify(expected)}`);
      assert(!toastOf(m), `a toast said it too: ${toastOf(m)?.textContent}`);
    }
  });

  await test('Add remote with no URL keeps the dialog open and says so under the URL', async () => {
    const m = mountPin(pin, { place: 'refs', refs: refsOf({ remotes: [{ name: 'origin', branches: [] }] }) });
    mounts.push(m);
    await waitFor(() => m.body.querySelector('.git-pin__more'), 'the head');
    m.holdRuns(true);
    /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__more')).click();
    const add = /** @type {HTMLElement|undefined} */ ([...document.querySelectorAll('.juggler-context-menu .menu-item')].find((el) => el.textContent === 'Add remote…'));
    assert(Boolean(add), 'the ⋯ menu offers Add remote…');
    add?.click();
    const name = /** @type {HTMLInputElement} */ (await waitFor(() => document.querySelector('.git-ask-dialog.is-open .git-pop__input:not(.git-pop__input--secondary)'), 'the question'));
    name.value = 'fork';
    /** @type {HTMLElement} */ (document.querySelector('.git-ask-dialog.is-open .git-pop__ok')).click();
    await nextTask();
    const dialog = document.querySelector('.git-ask-dialog.is-open');
    const url = /** @type {HTMLInputElement|null|undefined} */ (dialog?.querySelector('.git-pop__input--secondary'));
    const problem = /** @type {HTMLElement|null|undefined} */ (dialog?.querySelector('.git-pop__problem'));
    const said = problem?.querySelector('.git-pop__problem-text')?.textContent;
    assert(Boolean(dialog) && said === 'A remote needs a URL.' && !problem?.hidden, `the dialog says: ${said ?? '(closed)'}`);
    assert(url?.getAttribute('aria-invalid') === 'true' && url.closest('.git-pop__label')?.nextElementSibling === problem,
      'the reason is not under the URL');
    assert(m.runs().length === 0 && !toastOf(m), 'it ran something, or toasted');
    if (url) url.value = 'git@example.com:me/fork.git';
    url?.dispatchEvent(new Event('input', { bubbles: true }));
    assert(problem?.hidden === true, 'typing in the field did not clear the reason');
    /** @type {HTMLElement} */ (document.querySelector('.git-ask-dialog.is-open .git-pop__ok')).click();
    await waitFor(() => m.runs().length === 1, 'the remote added');
    assert(m.runs()[0].op.kind === 'remote-add' && m.runs()[0].op.url === 'git@example.com:me/fork.git', `add: ${JSON.stringify(m.runs()[0].op)}`);
  });

  await test('a read that failed is one inline line tinted as a warning, with Retry that reads again', async () => {
    let failing = true;
    const m = mountPin(pin, { place: 'changes', changes: () => (failing ? new Error('fatal: not a git repository') : changesOf([])) });
    mounts.push(m);
    const line = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-changes__error.git-inline-error'), 'the inline error'));
    assert((line.textContent || '').includes('not a git repository'), `it says: ${line.textContent}`);
    const icon = /** @type {HTMLElement} */ (line.querySelector('.git-inline-error__icon'));
    assert(getComputedStyle(icon).color === tokenColour(line, '--warning'), `its glyph's colour: ${getComputedStyle(icon).color}`);
    assert(getComputedStyle(line).borderTopColor === tokenColour(line, 'color-mix(in srgb, var(--warning) 40%, transparent)'),
      `its border: ${getComputedStyle(line).borderTopColor}`);
    const asked = m.changesAsked().length;
    failing = false;
    /** @type {HTMLElement} */ (line.querySelector('.git-inline-error__retry')).click();
    await waitFor(() => m.changesAsked().length > asked && !m.body.querySelector('.git-inline-error'), 'Retry to read again');
    assert((m.body.textContent || '').includes('Working tree clean'), 'the read after Retry was not drawn');
  });

  __holdToasts(false);
  return { passed, failed, errors };
}
