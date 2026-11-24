//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin remote tests — the head's network side: the fetch made on first
 * showing a repository and its quiet indicator, a running push's progress and
 * cancel, and what a pull or push that can't go ahead offers instead (merge or
 * rebase, pull or force with a lease, which remote). The fake services are
 * git-pin-helpers'.
 * @module _tests/git-remote-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf, confirmPop, mountPin, refsOf } from './git-pin-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { isMac } from '../../../js/services/key-shortcut-manager.js';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {any[]} */
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
      while (mounts.length) mounts.pop().teardown();
    }
  }

  const pin = new GitPin();
  const OLD = 'aaaaaaa000000000000000000000000000000000';

  /**
   * Mount in the Changes place on a tracked branch and wait for its reads.
   * @param {any} [changes] - What the repository reads as.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (changes = changesOf([], { upstream: 'origin/develop', remotes: 1 }), options = {}) => {
    const m = mountPin(pin, { place: 'changes', changes, ...options });
    mounts.push(m);
    // The head draws its primary once Changes has read the repository — and
    // has asked for the first-show fetch by then, when there is a remote.
    await waitFor(() => m.body.querySelector('.git-pin__primary')?.dataset.kind, 'the head to draw its primary');
    return m;
  };

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement} The primary button.
   */
  const primary = (m) => m.body.querySelector('.git-pin__primary');
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement} Refresh, which says what a running network write is doing.
   */
  const refreshButton = (m) => m.body.querySelector('.git-pin__refresh');
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} What it says.
   */
  const jobText = (m) => refreshButton(m)?.title || '';
  /**
   * Press the primary for a push or pull, and answer the question it asks first.
   * @param {any} m - The mounted pin.
   * @returns {string} What it asked.
   */
  const press = (m) => {
    primary(m).click();
    assert(!m.runs().length, 'a push or pull asks before it runs');
    return confirmPop();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement|null} Refresh, while a click on it stops a write.
   */
  const cancelButton = (m) => {
    const b = refreshButton(m);
    return b?.classList.contains('git-pin__refresh--stop') ? b : null;
  };
  /** @returns {string[]} The open popover's choices, in order. */
  const choices = () => [...document.querySelectorAll('.git-pop__choice')].map((b) => /** @type {HTMLElement} */ (b).dataset.choice || '');
  /** @param {string} id - The choice. */
  const choose = (id) => {
    const b = /** @type {HTMLElement|null} */ (document.querySelector(`.git-pop__choice[data-choice="${id}"]`));
    if (!b) throw new Error(`no choice ${id} among ${choices().join(', ')}`);
    b.click();
  };
  /**
   * Wait for the nth run to have started.
   * @param {any} m - The mounted pin.
   * @param {number} n - How many runs.
   * @returns {Promise<any>} The last run's op.
   */
  const ran = async (m, n) => {
    await waitFor(() => m.runs().length >= n, () => `run ${n} (runs: ${JSON.stringify(m.runs().map((/** @type {any} */ r) => r.op))})`);
    return m.runs()[n - 1].op;
  };
  /**
   * Wait for a popover offering choices.
   * @returns {Promise<boolean>} Once there is one.
   */
  const offered = () => waitFor(() => choices().length > 0, 'a popover of choices');

  await test('the first showing of a repository fetches it once, and quietly says when it could not', async () => {
    const m = await mounted(undefined, { holdFetches: true });
    assert(m.fetches().length === 1, `fetchOnShow asked ${m.fetches().length} times on mount`);
    assert(m.fetches()[0].options.repo === '', 'the fetch names the repository shown');
    assert(refreshButton(m).getAttribute('aria-busy') === 'true' && /Fetching/.test(refreshButton(m).title),
      `Refresh does not turn while the first fetch runs: ${refreshButton(m).title}`);
    assert(!cancelButton(m), 'a click on Refresh would stop a fetch nobody asked for');
    assert(primary(m).disabled && /Fetch/.test(primary(m).textContent || ''), 'Fetch can be pressed while the first fetch runs');

    m.emitChange();
    for (let i = 0; i < 4; i++) await nextTask();
    assert(m.fetches().length === 1, 'a re-read fetched again');

    const offline = Object.assign(new Error('Could not resolve host: example.invalid'), { kind: '' });
    m.settleFetch(0, offline);
    await waitFor(() => m.body.querySelector('.git-pin__offline'), 'the offline mark');
    const mark = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-pin__offline'));
    assert(/Could not resolve host/.test(mark?.title || ""), 'a failed first fetch left no indicator with its reason');
    assert(refreshButton(m).getAttribute('aria-busy') !== 'true', 'Refresh still busy after the fetch');
    assert(!document.querySelector('.git-pop') && !m.body.querySelector('.git-pin__toast:not([hidden])'), 'a quiet fetch raised a popover or toast');

    primary(m).click();
    assert((await ran(m, 1)).kind === 'fetch', 'Fetch did not run a fetch');
    await waitFor(() => !m.body.querySelector('.git-pin__offline'), 'a fetch that worked to clear the offline mark');
  });

  await test('a push shows its progress, logs its phase, and can be cancelled', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 2, remotes: 1 }));
    m.holdRuns(true);
    assert(/Push 2/.test(primary(m).textContent || ''), `primary = ${primary(m).textContent}`);
    const asked = press(m);
    assert(asked.includes('2 commits') && asked.includes('origin/develop'), `the question says what goes where: ${asked}`);
    const push = await ran(m, 1);
    assert(push.kind === 'push' && push.repo === '', 'Push did not run a push');
    m.emitJob({ ...m.runs()[0].job, commands: [['push', '--porcelain', '--progress', 'origin', 'refs/heads/develop:refs/heads/develop']],
      progress: { phase: 'Writing objects', percent: 45, done: 45, total: 100, rate: '1.00 MiB/s' } });
    await waitFor(() => /Pushing 45%/.test(jobText(m)), () => `Pushing 45% (Refresh says: ${jobText(m)})`);
    assert(refreshButton(m).getAttribute('aria-busy') === 'true', 'Refresh is not busy while pushing');
    assert(/Writing objects 45% \(45\/100\)/.test(jobText(m)), `Refresh's title = ${jobText(m)}`);
    assert(!m.body.querySelector('.git-pin__bar [role="status"]:not(.git-pin__toast)'), 'the head grew a status beside the buttons');
    assert(/^Push 2$/.test(primary(m).textContent || '') && primary(m).disabled
      && primary(m).classList.contains('git-pin__primary--spin'), `the Push pressed spins in place: ${primary(m).textContent}`);
    /** @type {HTMLElement|null} */ (m.body.querySelector('.git-pin__log-toggle'))?.click();
    assert(/Writing objects 45%/.test(m.body.querySelector('.git-pin__log')?.textContent || ''), 'the command log does not show the phase');

    const x = cancelButton(m);
    assert(Boolean(x), 'Refresh does not stop a running push');
    x?.click();
    await waitFor(() => m.cancels().length > 0 && !cancelButton(m), 'the push cancelled');
    assert(m.cancels().length === 1 && m.cancels()[0].id === m.runs()[0].job.id, 'Refresh did not cancel the push');
    assert(!cancelButton(m), 'Refresh still stops a push that has ended');
  });

  await test('a push that ends is read again at once: the head moves on without waiting for the watch', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 2, remotes: 1 }));
    m.holdRuns(true);
    press(m);
    await ran(m, 1);
    m.setChanges(changesOf([], { upstream: 'origin/develop', ahead: 0, remotes: 1 }));
    m.finishRun(0);
    // No git-change is emitted: the job ending is news enough.
    await waitFor(() => primary(m).dataset.kind === 'fetch' && !primary(m).disabled,
      () => `the primary after the push: ${primary(m).dataset.kind} "${primary(m).textContent}"`);
    assert(Boolean(m.body.querySelector('.git-pin__sync-ok')), 'the head does not say it is up to date');
  });

  await test('a pull that cannot fast-forward offers the repository\'s way first, then runs it', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, behind: 1, remotes: 1 }));
    m.holdRuns(true);
    press(m);
    const pull = await ran(m, 1);
    assert(pull.kind === 'pull' && !pull.mode, 'Pull did not start as a fast-forward');
    m.failRun(0, { kind: 'diverged', message: 'develop and origin/develop have both moved on', job: { prefer: 'rebase' } });
    await offered();
    assert(choices().join(',') === 'rebase,merge', `choices = ${choices().join(',')}`);
    choose('merge');
    const merged = await ran(m, 2);
    assert(merged.kind === 'pull' && merged.mode === 'merge', 'choosing Merge did not pull with a merge');
  });

  await test('a rejected push offers a pull, or a forced push leased on the sha the remote was seen at', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }), {
      refs: refsOf({ remotes: [{ name: 'origin', branches: [{ name: 'develop', sha: OLD, subject: 'Theirs', date: 0 }] }] }),
    });
    m.holdRuns(true);
    press(m);
    await ran(m, 1);
    m.failRun(0, { kind: 'rejected', message: 'origin turned the push down (fetch first)', job: { rejected: ['refs/heads/develop'], reason: 'fetch first' } });
    await offered();
    assert(choices().join(',') === 'pull,force', `choices = ${choices().join(',')}`);
    choose('force');
    await waitFor(() => document.querySelector('.git-pop__ok'), 'the force confirm');
    const ok = /** @type {HTMLElement|null} */ (document.querySelector('.git-pop__ok'));
    assert(Boolean(ok) && /aaaaaaa/.test(document.querySelector('.git-pop__text')?.textContent || ''), 'the force confirm does not name the sha it would replace');
    ok?.click();
    const forced = await ran(m, 2);
    assert(forced?.kind === 'push' && forced.force === true && forced.expectSha === OLD, `forced push = ${JSON.stringify(forced)}`);

    m.failRun(1, { kind: 'rejected', message: 'again', job: { rejected: ['refs/heads/develop'], reason: 'fetch first' } });
    await offered();
    choose('pull');
    assert((await ran(m, 3)).kind === 'pull', 'choosing Pull did not pull');
  });

  await test('the push confirmation can force the push, leased on the sha the remote was seen at', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }), {
      refs: refsOf({ remotes: [{ name: 'origin', branches: [{ name: 'develop', sha: OLD, subject: 'Theirs', date: 0 }] }] }),
    });
    m.holdRuns(true);
    primary(m).click();
    const box = /** @type {HTMLInputElement|null} */ (await waitFor(() => document.querySelector('.git-pop .git-pop__check input'), 'the force checkbox'));
    const ok = /** @type {HTMLElement} */ (document.querySelector('.git-pop .git-pop__ok'));
    assert(Boolean(box) && !box?.checked && ok.textContent === 'Push', `unticked, OK = ${ok.textContent}`);
    box?.click();
    assert(ok.textContent === 'Force push' && ok.classList.contains('btn-danger'), `ticked, OK = ${ok.textContent} (${ok.className})`);
    ok.click();
    const forced = await ran(m, 1);
    assert(forced?.kind === 'push' && forced.force === true && forced.expectSha === OLD, `forced push = ${JSON.stringify(forced)}`);
  });

  await test('publishing with no obvious remote asks which', async () => {
    const m = await mounted(changesOf([], { upstream: '', remotes: 2 }));
    m.holdRuns(true);
    assert(/Publish/.test(primary(m).textContent || ''), `primary = ${primary(m).textContent}`);
    press(m);
    await ran(m, 1);
    m.failRun(0, { kind: 'remote', message: 'Which remote should this go to?', job: { remotes: ['fork', 'upstream'] } });
    await offered();
    assert(choices().join(',') === 'fork,upstream', `choices = ${choices().join(',')}`);
    choose('upstream');
    const published = await ran(m, 2);
    assert(published.kind === 'push' && published.remote === 'upstream', 'the chosen remote was not pushed to');
  });

  /**
   * Start a push and put a question on it, as the server's frame does.
   * @param {any} m - The mounted pin.
   * @param {{id: string, text: string, kind: string}} prompt - The question.
   * @returns {Promise<any>} The job, asking.
   */
  const asking = async (m, prompt) => {
    m.holdRuns(true);
    press(m);
    await ran(m, 1);
    const job = { ...m.runs()[0].job, prompt };
    m.emitJob(job);
    return job;
  };
  /** @returns {HTMLInputElement|null} The open question's input. */
  const promptInput = () => document.querySelector('modal-dialog.is-open .git-pop--prompt .git-pop__input');
  /**
   * The open question's dialog: a form when it asks for words, which says
   * git's question as its title, else a yes-or-no that says it as its text.
   * @returns {Element|null} It.
   */
  const promptPopover = () => document.querySelector('modal-dialog.is-open .git-pop--prompt')?.closest('modal-dialog') || null;
  const SECRET = 'Sentinel-Pa55word-9d1f';

  await test('a password a push waits on is asked for on the head, masked, and goes only to the answer', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }));
    const job = await asking(m, { id: 'ask_1', text: "Password for 'https://jules@example.com': ", kind: 'secret' });
    await waitFor(promptInput, 'the password popover');
    const input = /** @type {HTMLInputElement} */ (promptInput());
    assert(input.type === 'password', `the password is typed into a ${input.type} input`);
    assert(/Password for 'https:\/\/jules@example\.com'/.test(promptPopover()?.textContent || ''), 'the popover does not say what git asked');
    assert(/Sign in/.test(primary(m).textContent || ''), `primary while asked = ${primary(m).textContent}`);
    assert(Boolean(cancelButton(m)), 'nothing stops the push while it waits on a question');

    input.value = SECRET;
    /** @type {HTMLFormElement} */ (input.form).requestSubmit();
    await waitFor(() => m.answers().length === 1, 'the answer sent');
    const sent = m.answers()[0];
    assert(sent.id === job.id && sent.reply.prompt === 'ask_1' && sent.reply.answer === SECRET && !sent.reply.decline,
      `answer = ${JSON.stringify({ id: sent.id, prompt: sent.reply.prompt, decline: sent.reply.decline })}`);
    assert(!promptPopover(), 'the popover outlived the answer');
    assert(input.value === '', 'the password was left in its input');
    assert(!document.body.innerHTML.includes(SECRET), 'the password is somewhere in the page');
  });

  await test('dismissing a question keeps it; the primary asks it again, and Cancel declines it', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }));
    await asking(m, { id: 'ask_2', text: "Username for 'https://example.com': ", kind: 'text' });
    await waitFor(promptInput, 'the username popover');
    assert(promptInput()?.type === 'text', 'a username is not typed in the open');
    promptInput()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !promptPopover(), 'Escape to close the popover');
    assert(m.answers().length === 0, 'dismissing the popover answered the question');

    m.emitJob({ ...m.runs()[0].job, commands: [['push']], prompt: { id: 'ask_2', text: "Username for 'https://example.com': ", kind: 'text' } });
    await nextTask();
    assert(!promptPopover(), 'another frame of the same question opened it again unasked');

    primary(m).click();
    await waitFor(promptInput, 'the primary to ask again');
    /** @type {HTMLElement|null} */ (document.querySelector('.git-ask-dialog.is-open .git-pop__cancel'))?.click();
    await waitFor(() => m.answers().length === 1, 'the decline sent');
    assert(m.answers()[0].reply.decline === true && m.answers()[0].reply.prompt === 'ask_2', `decline = ${JSON.stringify(m.answers()[0].reply)}`);

    m.failRun(0, { kind: 'auth', message: 'The remote turned the sign-in down, or none was given.' });
    await waitFor(() => m.runs()[0].settled, 'the push to end');
    await nextTask();
    assert(!m.body.querySelector('.git-pin__toast:not([hidden])'), 'declining here was followed by a toast saying so');
  });

  await test('a question answered elsewhere closes its popover here', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }));
    const job = await asking(m, { id: 'ask_3', text: "Password for 'https://example.com': ", kind: 'secret' });
    await waitFor(promptInput, 'the password popover');
    m.emitJob({ ...job, prompt: undefined });
    await waitFor(() => !promptPopover(), 'the popover to close once answered elsewhere');
    assert(!/Sign in/.test(primary(m).textContent || ''), `primary after the answer = ${primary(m).textContent}`);
  });

  await test('a host key is a yes or no, and a sign-in the remote refused says so', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }));
    const text = "The authenticity of host 'example.com (192.0.2.1)' can't be established.\n" +
      'ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ';
    await asking(m, { id: 'ask_4', text, kind: 'confirm' });
    await waitFor(() => document.querySelector('.git-pop:has(.git-pop--prompt) .git-pop__ok'), 'the yes-or-no popover');
    assert(!promptInput(), 'a yes-or-no asked for typing');
    assert(/SHA256:abc/.test(promptPopover()?.textContent || ''), 'the fingerprint is not shown');
    /** @type {HTMLElement|null} */ (document.querySelector('.git-pop:has(.git-pop--prompt) .git-pop__ok'))?.click();
    await waitFor(() => m.answers().length === 1, 'the yes sent');
    assert(m.answers()[0].reply.answer === 'yes', `confirm answered ${JSON.stringify(m.answers()[0].reply)}`);

    m.failRun(0, { kind: 'auth', message: 'The remote turned the sign-in down, or none was given.' });
    await waitFor(() => m.body.querySelector('.git-pin__toast:not([hidden])'), 'a toast for the refused sign-in');
  });

  // --- en-XA ----------------------------------------------------------------

  /** The pin's own words the cases below draw, registered pseudo-localised. */
  const CORE_TEXT = [
    '{kind, select, confirm {Confirm…} other {Sign in…}}', 'Send', 'Cancel', 'Yes', 'No', 'Git asks', '{doing} — click to stop', 'More',
    'Switch worktree or branch', 'Up to date with {upstream}', 'Receiving objects', '{phase} {percent}% ({done}/{total})',
    '{kind, select, fetch {Fetching {percent}%} pull {Pulling {percent}%} push {Pushing {percent}%} push-tag {Pushing {percent}%} submodule-update {Updating {percent}%} other {Deleting {percent}%}}',
    '{count, plural, one {# changed file} other {# changed files}}', 'Repository',
  ];

  /**
   * Press the pin's Refresh or Fetch key, as this platform has it, in the pin.
   * @param {any} m - The mounted pin.
   * @param {boolean} fetch - The Fetch key, ⇧⌘R / Shift+F5; else Refresh, ⌘R / F5.
   * @returns {KeyboardEvent} The press, to ask whether the pin claimed it.
   */
  const pressKey = (m, fetch) => {
    const event = new KeyboardEvent('keydown', isMac()
      ? { key: fetch ? 'R' : 'r', metaKey: true, shiftKey: fetch, bubbles: true, cancelable: true }
      : { key: 'F5', shiftKey: fetch, bubbles: true, cancelable: true });
    m.body.querySelector('.git-pin').dispatchEvent(event);
    return event;
  };

  await test('the Refresh key reads again and never stops a write; the Fetch key fetches only where Fetch is offered', async () => {
    const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 2, remotes: 1 }));
    m.holdRuns(true);
    press(m);
    await ran(m, 1);
    assert(Boolean(cancelButton(m)), 'a click on Refresh would not stop the push');
    const asked = m.changesAsked().length;
    assert(pressKey(m, false).defaultPrevented, 'the Refresh key was left to the page, to reload it');
    await waitFor(() => m.changesAsked().length > asked, 'the Refresh key to read the repository again');
    assert(m.cancels().length === 0, 'the Refresh key stopped the running push');

    m.setChanges(changesOf([], { upstream: 'origin/develop', remotes: 1 }));
    m.finishRun(0);
    await waitFor(() => primary(m).dataset.kind === 'fetch' && !primary(m).disabled, 'Fetch offered once the push ends');
    assert(pressKey(m, true).defaultPrevented, 'the Fetch key was left to the page');
    assert((await ran(m, 2)).kind === 'fetch', 'the Fetch key did not run a fetch');
    assert(m.runs().length === 2, 'the Fetch key ran more than one write');

    const bare = await mounted(changesOf([], {}));
    const runs = bare.runs().length;
    assert(pressKey(bare, true).defaultPrevented, 'the Fetch key reloads the page where there is nothing to fetch');
    for (let i = 0; i < 4; i++) await nextTask();
    assert(bare.runs().length === runs, 'the Fetch key fetched a repository with no remotes');
  });

  await test('en-XA: a question and a network write\u2019s progress are in the user\u2019s language; git\u2019s own words are not', async () => {
    await underPseudoLocale('git-remote-test', async () => {
      const m = await mounted(changesOf([], { upstream: 'origin/develop', ahead: 1, remotes: 1 }));
      const job = await asking(m, { id: 'ask_x', text: "Password for 'https://example.com': ", kind: 'secret' });
      await waitFor(promptInput, 'the password popover');
      /** @type {string[]} */
      const shown = [primary(m).textContent || ''];
      // The title is git's question, which is git's to word.
      shown.push(...shownStrings(/** @type {Element} */ (promptPopover()), '.git-pop__label, .modal-title'));
      assert(/Password for/.test(promptPopover()?.textContent || ''), 'git\u2019s question was changed');

      m.emitJob({ ...job, prompt: { id: 'ask_y', text: 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ', kind: 'confirm' } });
      await waitFor(() => document.querySelector('.git-pop:has(.git-pop--prompt) .git-pop__ok'), 'the yes-or-no popover');
      shown.push(primary(m).textContent || '', ...shownStrings(/** @type {Element} */ (promptPopover()), '.git-pop__text'));

      m.emitJob({ ...job, prompt: undefined, progress: { phase: 'Receiving objects', percent: 45, done: 45, total: 100 } });
      await waitFor(() => !promptPopover() && /45/.test(jobText(m)), 'the push\u2019s progress');
      shown.push(jobText(m), refreshButton(m).getAttribute('aria-label') || '');

      const raw = shown.map((x) => x.trim()).filter((x) => x && !isPseudoLocalized(x));
      assert(shown.length >= 8, `expected the question and progress to show text, got ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
