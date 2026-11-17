//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin commit-message generation: the Auto-generate menu and its sources,
 * Stop, the replace with Undo, the line under the field, Discuss, the `g` key,
 * and what a reply is cleaned into. The reads are git-pin-helpers' fakes; the
 * model calls are replaced through `__setModelCallsForTests`.
 * @module _tests/git-commit-generate-test
 */

import GitPin from '../pins/git-pin.js';
import { __setModelCallsForTests } from '../pins/git/commit-generate.js';
import { closePopover } from '../pins/git/popover.js';
import { assert, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf, mountPin } from './git-pin-helpers.js';

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
      closeMenu();
      closePopover();
    }
  }

  const pin = new GitPin();

  const staged = [
    { path: 'queue.go', index: 'A', worktree: '.', staged: { added: 40, removed: 0 } },
    { path: 'status.go', index: 'M', worktree: '.', staged: { added: 3, removed: 1 } },
    { path: 'README.md', index: 'M', worktree: '.', staged: { added: 1, removed: 0 } },
  ];
  const context = {
    repo: '', amend: false, files: [{ path: 'queue.go', status: 'A' }, { path: 'status.go', status: 'M' }, { path: 'README.md', status: 'M' }],
    stat: ' queue.go | 40 +\n 3 files changed', diff: 'diff --git a/queue.go b/queue.go\n+package gitops\n[… 30 more lines of this file\'s diff left out]',
    truncated: true, subjects: ['Added worktree status', 'Fixed the watcher'], rules: 'From AGENTS.md:\nOne line, past tense.', wrapsBody: true,
  };
  const attribution = {
    staged: 3,
    conversations: [
      { conv: 'c2', title: 'Queue writes', strong: 2, weak: 0, prior: 0, files: ['queue.go', 'status.go'] },
      { conv: 'c3', title: 'Docs pass', strong: 1, weak: 0, prior: 0, files: ['README.md'] },
    ],
  };

  /**
   * Mount in the Changes place with three staged files and wait for the read.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (options = {}) => {
    const m = mountPin(pin, { place: 'changes', changes: changesOf(staged), commitContext: context, attribution, ...options });
    for (let i = 0; i < 8; i++) await nextTask();
    return m;
  };

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLTextAreaElement} The commit message.
   */
  const message = (m) => m.body.querySelector('.git-commit__msg');
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement} The Auto-generate (or Stop) button.
   */
  const genButton = (m) => {
    const b = m.body.querySelector('.git-commit__gen');
    if (!b) throw new Error('no Auto-generate button');
    return b;
  };
  /** @returns {HTMLElement|null} The open source menu. */
  const menu = () => document.querySelector('.git-gen-menu');
  /** Close the source menu if a case left it open. */
  const closeMenu = () => {
    const open = menu();
    if (open) open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.git-gen-menu').forEach((el) => el.remove());
  };
  /** @returns {HTMLElement[]} The menu's rows, captions and loading row included. */
  const menuRows = () => [...(menu()?.querySelectorAll('.menu-item, .menu-header') || [])].map((el) => /** @type {HTMLElement} */ (el));
  /**
   * Pick a source from the open menu.
   * @param {string} source - The row's `data-source`, or `conv:<id>`.
   */
  const pick = (source) => {
    const row = /** @type {HTMLElement|null} */ (menu()?.querySelector(`[data-source="${source}"]`) || null);
    if (!row) throw new Error(`no ${source} row: ${menuRows().map((r) => r.textContent).join(' | ')}`);
    row.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The line under the field, '' when hidden.
   */
  const sourceLine = (m) => {
    const line = m.body.querySelector('.git-commit__source');
    return line && !line.hidden ? line.textContent || '' : '';
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {string} text - What to type.
   */
  const type = (m, text) => {
    message(m).value = text;
    message(m).dispatchEvent(new Event('input', { bubbles: true }));
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - The key.
   */
  const press = (m, key) => {
    m.body.querySelector('.git-pin').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  /**
   * A stand-in for `generateText` that records each call and answers with
   * `reply` (a string, an Error to reject with, or 'hold' to wait for abort).
   * @param {string|Error|'hold'} reply - The answer.
   * @returns {{calls: {params: any, signal: AbortSignal|undefined}[], restore: () => void}} The record.
   */
  const fakeText = (reply) => {
    /** @type {{params: any, signal: AbortSignal|undefined}[]} */
    const calls = [];
    const restore = __setModelCallsForTests({
      generateText: /** @type {any} */ ((/** @type {any} */ params, /** @type {AbortSignal|undefined} */ signal) => {
        calls.push({ params, signal });
        if (reply === 'hold') {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        }
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({ text: reply, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } });
      }),
    });
    return { calls, restore };
  };

  await test('the menu lists each attributing conversation with its share, then the other sources', async () => {
    const m = await mounted();
    m.holdReads('attribution', true);
    const button = genButton(m);
    assert(!button.disabled && /Auto-generate/.test(button.textContent || ''), `the button: ${button.textContent} disabled=${button.disabled}`);
    button.click();
    for (let i = 0; i < 8; i++) await nextTask();
    assert(!!menu()?.querySelector('.git-gen-menu__loading'), `a loading row while attribution is read: ${menuRows().map((r) => r.textContent).join(' | ')}`);
    const asked = m.reads().filter((/** @type {any} */ r) => r.kind === 'attribution');
    assert(asked.length === 1 && asked[0].options.amend === false && asked[0].options.conv === 'c1',
      `attribution asked once, for no amend, tie-broken by the visible conversation: ${JSON.stringify(asked.map((/** @type {any} */ r) => r.options))}`);
    m.releaseRead(0);
    for (let i = 0; i < 8; i++) await nextTask();
    const rows = menuRows().map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());
    assert(!menu()?.querySelector('.git-gen-menu__loading'), 'the loading row goes');
    const want = ['Queue writes', 'Docs pass', 'The staged diff alone', 'An agent that explores the changes', 'Discuss in a new conversation…'];
    const at = want.map((w) => rows.findIndex((r) => r.includes(w)));
    assert(at.every((i, k) => i >= 0 && (k === 0 || i > /** @type {number} */ (at[k - 1]))), `in order: ${JSON.stringify(rows)}`);
    assert(Boolean(rows[/** @type {number} */ (at[0])]?.includes('made 2 of 3 staged') && rows[/** @type {number} */ (at[1])]?.includes('made 1 of 3 staged')),
      `each says how much it made: ${JSON.stringify(rows)}`);
    m.teardown();
  });

  await test('with nothing staged the button is disabled, and says why', async () => {
    const m = await mounted({ changes: changesOf([{ path: 'b.js', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } }]) });
    const button = genButton(m);
    assert(button.disabled, 'disabled');
    assert(/stage/i.test(button.title || ''), `with a reason: "${button.title}"`);
    press(m, 'g');
    for (let i = 0; i < 8; i++) await nextTask();
    assert(!menu(), 'g opens nothing either');
    m.teardown();
  });

  await test('a generated message replaces the typed one, and Undo puts it back', async () => {
    const fake = fakeText('Queue writes per repository');
    try {
      const m = await mounted();
      type(m, 'my own words');
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(message(m).value === 'Queue writes per repository', `replaced: ${JSON.stringify(message(m).value)}`);
      assert(/Generated from the staged diff/.test(sourceLine(m)), `the line says where from: "${sourceLine(m)}"`);
      const undo = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo:not([hidden])'));
      assert(!!undo, 'the toast offers Undo');
      undo?.click();
      assert(message(m).value === 'my own words', `Undo restores the typed text: ${JSON.stringify(message(m).value)}`);
      // Generate again, then type: the line goes.
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(sourceLine(m) !== '', 'the line is back');
      type(m, 'edited');
      assert(sourceLine(m) === '', `typing clears the line: "${sourceLine(m)}"`);
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('the line under the field reopens the menu', async () => {
    const fake = fakeText('Queue writes');
    try {
      const m = await mounted();
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(!menu(), 'the menu closed on picking');
      /** @type {HTMLElement} */ (m.body.querySelector('.git-commit__source')).click();
      for (let i = 0; i < 8; i++) await nextTask();
      assert(!!menu(), 'clicking the line opens it again');
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('an empty field takes the message with no Undo to offer', async () => {
    const fake = fakeText('Queue writes');
    try {
      const m = await mounted();
      type(m, '');
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(message(m).value === 'Queue writes', `filled: ${JSON.stringify(message(m).value)}`);
      assert(!m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo:not([hidden])'), 'nothing to undo');
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('Stop aborts the call and leaves the text as it was', async () => {
    const fake = fakeText('hold');
    try {
      const m = await mounted();
      type(m, 'keep me');
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(fake.calls.length === 1, `one call: ${fake.calls.length}`);
      assert(/Stop/.test(genButton(m).textContent || ''), `the button became Stop: ${genButton(m).textContent}`);
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      assert(fake.calls[0]?.signal?.aborted === true, 'Stop aborts the call');
      assert(message(m).value === 'keep me', `untouched: ${JSON.stringify(message(m).value)}`);
      assert(/Auto-generate/.test(genButton(m).textContent || ''), `the button is back: ${genButton(m).textContent}`);
      assert(!menu(), 'Stop opens no menu');
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('amending asks for the amend and puts HEAD\'s message in the prompt', async () => {
    const fake = fakeText('Queue writes, and list worktrees');
    try {
      const m = await mounted({
        commitContext: (/** @type {any} */ opts) => ({ ...context, amend: Boolean(opts.amend), headMessage: opts.amend ? 'Queue writes per repository' : undefined }),
      });
      const amend = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-commit__amend'));
      amend.checked = true;
      amend.dispatchEvent(new Event('change', { bubbles: true }));
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      const attributionAsk = m.reads().find((/** @type {any} */ r) => r.kind === 'attribution');
      assert(attributionAsk?.options.amend === true, `attribution scored for the amend: ${JSON.stringify(attributionAsk?.options)}`);
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      const contextAsk = m.reads().find((/** @type {any} */ r) => r.kind === 'commit-context');
      assert(contextAsk?.options.amend === true, `the context is read for the amend: ${JSON.stringify(contextAsk?.options)}`);
      const call = fake.calls[0]?.params;
      assert(call?.prompt.includes('Queue writes per repository'), `HEAD's message is in the prompt: ${call?.prompt}`);
      assert(/amend/i.test(call?.system || ''), 'the system prompt speaks of the amend');
      assert(call?.model === 'cheap', `the cheap model: ${JSON.stringify(call?.model)}`);
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('a conversation source sends its digest of the files it made', async () => {
    const fake = fakeText('Queue writes per repository');
    try {
      const m = await mounted({
        digest: { conv: 'c2', title: 'Queue writes', userMessages: ['Two writes at once corrupt the index; queue them.'], turns: [{ user: 'queue them', closing: 'Added queue.go.', files: ['queue.go'] }], truncated: false },
      });
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('conv:c2');
      for (let i = 0; i < 8; i++) await nextTask();
      const asked = m.digests();
      assert(asked.length === 1 && asked[0].conv === 'c2' && JSON.stringify(asked[0].paths) === '["queue.go","status.go"]',
        `the digest of the files it made: ${JSON.stringify(asked)}`);
      const prompt = fake.calls[0]?.params?.prompt || '';
      assert(prompt.includes('corrupt the index') && prompt.includes('Added queue.go.') && prompt.includes('diff --git'),
        `the why, the turns and the diff: ${prompt}`);
      assert(/Generated from “Queue writes”/.test(sourceLine(m)), `the line names it: "${sourceLine(m)}"`);
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('the exploring agent shows its progress and runs the commit-message strategy', async () => {
    /** @type {any[]} */
    const runs = [];
    /** @type {(r: any) => void} */
    let finish = () => {};
    const restore = __setModelCallsForTests({
      runAgent: /** @type {any} */ ((/** @type {any} */ request, /** @type {AbortSignal|undefined} */ signal) => {
        runs.push({ request, signal });
        request.onProgress?.({ toolUseId: 't1', toolName: 'read', summary: 'Read README.md' });
        return new Promise((resolve) => { finish = resolve; });
      }),
    });
    try {
      const m = await mounted();
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('explore');
      for (let i = 0; i < 8; i++) await nextTask();
      const request = runs[0]?.request;
      assert(request?.strategy === 'subagent-commit-message' && request.model === 'cheap', `the run: ${JSON.stringify(request)}`);
      assert(request?.prompt.includes('/tmp/proj') && request.prompt.includes('Added worktree status'),
        `names the repository and the house style: ${request?.prompt}`);
      assert(typeof request?.name === 'string' && request.name.length > 0, 'a name for the run');
      assert(sourceLine(m).includes('Read README.md'), `progress under the field: "${sourceLine(m)}"`);
      finish({ status: 'completed', text: 'Queue writes per repository', errorText: '', errorKind: '' });
      for (let i = 0; i < 8; i++) await nextTask();
      assert(message(m).value === 'Queue writes per repository', `filled: ${JSON.stringify(message(m).value)}`);
      assert(/Generated from an exploring agent/.test(sourceLine(m)), `the line: "${sourceLine(m)}"`);
      m.teardown();
    } finally {
      restore();
    }
  });

  await test('Discuss opens a conversation seeded with the context and leaves the field alone', async () => {
    const fake = fakeText('never');
    try {
      const m = await mounted();
      type(m, 'mine');
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('discuss');
      for (let i = 0; i < 8; i++) await nextTask();
      const started = m.workspaceCalls().filter((/** @type {any} */ c) => c.call === 'startConversation');
      assert(started.length === 1, `one conversation: ${JSON.stringify(m.workspaceCalls())}`);
      const request = started[0].args[0];
      assert(/commit message/i.test(request.message) && request.message.includes('diff --git') && request.message.includes('/tmp/proj'),
        `seeded with the context: ${request.message}`);
      assert(message(m).value === 'mine', `the field is untouched: ${JSON.stringify(message(m).value)}`);
      assert(fake.calls.length === 0, 'no model call of its own');
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('g opens the menu', async () => {
    const m = await mounted();
    press(m, 'g');
    for (let i = 0; i < 8; i++) await nextTask();
    assert(!!menu(), 'g opens it');
    m.teardown();
  });

  await test('a fenced, hard-wrapped reply comes out clean and unwrapped', async () => {
    const fake = fakeText('```text\r\nQueue writes per repository\r\n\r\nTwo writes at once could corrupt the\r\nindex, so each repository now has a\r\nqueue.\r\n\r\n- one queue per\r\n  common dir\r\n```');
    try {
      const m = await mounted();
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      const want = 'Queue writes per repository\n\nTwo writes at once could corrupt the index, so each repository now has a queue.\n\n- one queue per common dir';
      assert(message(m).value === want, `clean: ${JSON.stringify(message(m).value)}`);
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  await test('a failure leaves the text and says so quietly, busy saying to try again', async () => {
    const busy = /** @type {any} */ (new Error('pool full'));
    busy.status = 429;
    let fake = fakeText(busy);
    try {
      const m = await mounted();
      type(m, 'keep');
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(message(m).value === 'keep', `untouched: ${JSON.stringify(message(m).value)}`);
      assert(/Couldn.t generate/.test(sourceLine(m)) && /busy, try again/.test(sourceLine(m)), `busy: "${sourceLine(m)}"`);
      fake.restore();
      fake = fakeText(new Error('model not configured'));
      genButton(m).click();
      for (let i = 0; i < 8; i++) await nextTask();
      pick('diff');
      for (let i = 0; i < 8; i++) await nextTask();
      assert(/Couldn.t generate/.test(sourceLine(m)) && sourceLine(m).includes('model not configured'), `other: "${sourceLine(m)}"`);
      assert(message(m).value === 'keep', 'still untouched');
      m.teardown();
    } finally {
      fake.restore();
    }
  });

  return { passed, failed, errors };
}
