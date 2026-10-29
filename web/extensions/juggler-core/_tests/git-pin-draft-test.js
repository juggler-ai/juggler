//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests, continued: the draft a review's comments make and where it
 * goes, staying current, a narrow board, the scope, the real service, and the
 * pin under en-XA. One case goes through the real service to the real server,
 * which is what proves the two halves agree about the shape they pass. Split
 * from git-pin-test so each suite fits a unit suite's budget.
 * @module _tests/git-pin-draft-test
 */

import GitPin from '../pins/git-pin.js';
import gitReviewService from '../../../js/services/git-review-service.js';
import { assert, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { DEFAULT_SCOPE, SCOPE_PRESETS, SCOPE_SYNTAX } from '../lib/git-scope.js';
import { repo, manifestOf, mountedPin } from './git-pin-helpers.js';

/** `lib/git-status.js`'s English, for the en-XA case's stand-in catalogue. */
const GIT_STATUS_TEXT = [
  'repo', 'Detached head', 'No branch',
  '{ahead} ahead, {behind} behind', '{count} ahead', '{count} behind',
  'Untracked', 'Unchanged',
  '{status, select, modified {Modified} added {Added} deleted {Deleted} renamed {Renamed} copied {Copied} typechange {Type changed} other {Conflicted}}',
  '{status, select, modified {Modified and staged} added {Added and staged} deleted {Deleted and staged} renamed {Renamed and staged} copied {Copied and staged} typechange {Type changed and staged} other {Conflicted and staged}}',
  '{staged, select, modified {Modified} added {Added} deleted {Deleted} renamed {Renamed} copied {Copied} typechange {Type changed} other {Conflicted}} and staged, then {worktree, select, modified {modified} added {added} deleted {deleted} renamed {renamed} copied {copied} typechange {type changed} other {conflicted}} again',
  'First {shown} of {total} files.',
];

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
   * @param {object} [options] - Passed to `mountedPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = (options = {}) => mountedPin(pin, options);

  // --- the draft ------------------------------------------------------------

  await test('the footer counts the batch and offers the two things to do with it', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [
          {
            id: 'c_1', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
            lineText: [], body: 'One.', revision: 'rev1', createdAt: 1, updatedAt: 1,
          },
          {
            id: 'c_2', repo: '', path: 'a.js', side: 'file',
            lineText: [], body: 'Two.', revision: 'rev1', createdAt: 2, updatedAt: 2,
          },
        ],
      },
    });
    const footer = m.body.querySelector('.review-panel__footer');
    assert(footer?.textContent?.includes('2 draft comments'),
      `expected the batch counted, got ${JSON.stringify(footer?.textContent)}`);
    assert(footer.querySelector('.review-panel__compose') && footer.querySelector('.review-panel__discard'),
      `both buttons act on the draft, so they live with it:\n${footer.innerHTML}`);

    footer.querySelector('.review-panel__compose').click();
    await nextTask();
    assert(m.composes() === 1, `expected one hand-over, got ${m.composes()}`);
    // Handing the feedback over is not spending it: it is text in a box, which
    // the reader can still cut down or delete, so the batch is theirs until they
    // discard it.
    assert(m.draft().comments.length === 2, 'the comments stay on the draft');
    assert(m.body.querySelector('.review-panel__footer')?.textContent?.includes('2 draft comments'),
      'and the footer goes on counting them');
    m.teardown();
  });

  await test('the buttons say what they will do, and the primary one looks like one', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.viewer().querySelectorAll('.diff-comment-btn')[0].click();
    await nextTask();

    // "Save" says where the words go, which is the one thing a reader cannot
    // guess: a comment is kept on a batch and nothing is said to anyone yet.
    const save = m.editor().querySelector('.review-panel__save');
    assert(save.textContent === 'Add to feedback',
      `a new comment joins the batch: ${JSON.stringify(save.textContent)}`);

    // The primary action must not be drawn as the secondary one beside it.
    // Identical fills are what made this read as a disabled button.
    const cancel = m.editor().querySelector('.review-panel__cancel');
    const fill = (/** @type {Element} */ node) => getComputedStyle(node).backgroundColor;
    assert(fill(save) !== fill(cancel),
      `the accented button is drawn exactly like the one that cancels it: both ${fill(save)}`);
    assert(getComputedStyle(save).color !== getComputedStyle(cancel).color,
      'and carries its own text colour with it');

    m.editor().querySelector('textarea').value = 'A first thought.';
    m.editor().querySelector('.review-panel__save').click();
    await nextTask();

    // Editing one is not adding one — the comment is replaced in place — so the
    // button may not claim a second comment is about to appear.
    m.viewer().querySelector('.diff-comment-edit')?.click();
    await nextTask();
    const editing = m.editor()?.querySelector('.review-panel__save');
    assert(editing?.textContent === 'Save changes',
      `an edit replaces what is there: ${JSON.stringify(editing?.textContent)}`);
    m.teardown();
  });

  await test('the footer says where the feedback is going', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'One.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    // It lands in the prompt for the reader to read back and edit, so the label
    // has to promise that rather than an action that has already happened.
    const button = m.body.querySelector('.review-panel__compose');
    assert(button?.textContent === 'Paste feedback into prompt',
      `the footer must say where the batch goes: ${JSON.stringify(button?.textContent)}`);
    m.teardown();
  });

  await test('one comment is one comment', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Only.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    assert(m.body.querySelector('.review-panel__footer')?.textContent?.includes('1 draft comment'),
      `expected the singular, got ${JSON.stringify(m.body.querySelector('.review-panel__footer')?.textContent)}`);
    m.teardown();
  });

  await test('a hand-over that fails leaves every comment where it was', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Still unsaid.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    m.failCompose(new Error('worker rejected the message'));
    m.body.querySelector('.review-panel__compose').click();
    await nextTask();
    const text = m.text();
    assert(text.includes("Couldn't put the feedback in the prompt.") && text.includes('worker rejected the message'),
      `expected the lead and the underlying error:\n${text}`);
    assert(m.draft().comments.length === 1, 'and the comments are still there — they have not been said yet');
    assert(m.body.querySelector('.review-panel__footer'), 'so the footer stays too');
    m.teardown();
  });

  await test('Discard throws the batch away', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Wrong on reflection.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    m.body.querySelector('.review-panel__discard').click();
    await nextTask();
    assert(m.clears() === 1, `expected one clear, got ${m.clears()}`);
    assert(!m.body.querySelector('.review-panel__footer'), 'and nothing left to act on');
    m.teardown();
  });

  await test('a draft saved elsewhere shows up here', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    assert(!m.body.querySelector('.review-panel__footer'), 'nothing written yet');
    m.setDraft({
      version: 1,
      base: 'head',
      comments: [{
        id: 'c_9', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
        lineText: [], body: 'Written in the other window.', revision: 'rev1', createdAt: 1, updatedAt: 1,
      }],
    });
    await nextTask();
    assert(m.text().includes('Written in the other window.'),
      `a draft is one record, wherever it was written:\n${m.text()}`);
    m.teardown();
  });

  await test('an outdated comment is set aside, never moved', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
          lineText: ['the line as it was'], body: 'Written against the old file.',
          revision: 'rev0', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    const stale = m.viewer().querySelector('.diff-file-comment-list.stale');
    assert(stale, `a comment whose file moved on belongs under Outdated:\n${m.viewer().innerHTML}`);
    assert(stale.textContent.includes('the line as it was'),
      `with the code it was written about, which is all that is left of it:\n${stale.textContent}`);
    assert(!m.viewer().querySelector('.diff-comments .diff-comment[data-id="c_1"]'),
      'and never attached to whatever now occupies line 85');
    m.teardown();
  });

  await test('a board with no conversation says so rather than taking comments', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: null,
    });
    assert(m.viewer(), 'the tree is still worth reading without a conversation');
    assert(!m.viewer().querySelector('.diff-comment-btn'),
      'but there is nowhere to put a comment, so none is offered');
    assert(m.text().includes('No conversation open, so there is nowhere to put a comment.'),
      `and it says why, rather than leaving the reader to wonder:\n${m.text()}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('a new active context redraws in place rather than remounting', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.controller.update({
      pin: { id: 'pin_test', type: 'git', config: {} },
      active: { project: { path: '/tmp/proj', displayName: 'proj' }, conversation: null, thread: null },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    await nextTask();
    assert(m.rows().length === 1, `the review should survive a context update:\n${m.body.innerHTML}`);
    assert(m.reviews() === 1, `and not re-read the whole tree for it, got ${m.reviews()}`);
    m.teardown();
  });

  await test('teardown stops watching the draft', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.controller.teardown();
    m.setDraft({
      version: 1,
      base: 'head',
      comments: [{
        id: 'c_1', repo: '', path: 'a.js', side: 'file',
        lineText: [], body: 'After the end.', revision: 'rev1', createdAt: 1, updatedAt: 1,
      }],
    });
    await nextTask();
    assert(!m.text().includes('After the end.'),
      `a torn-down pin should not still be drawing:\n${m.text()}`);
    m.teardown();
  });

  // --- narrow -------------------------------------------------------------

  await test('a docked Pinboard stacks the rail above the diff', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.body.style.width = '20rem';
    const main = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__main'));
    const rail = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__rail'));
    const diff = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__diff'));
    assert(main && rail && diff, 'the panel should have a rail and a diff area');
    // A container query, not a media query: the Pinboard can be 20rem wide on a
    // desktop, so the viewport says nothing about the room this panel has.
    assert(rail.offsetWidth > diff.offsetWidth * 0.5,
      `at 20rem the rail should span the panel rather than share a row with the diff:`
      + ` rail ${rail.offsetWidth}, diff ${diff.offsetWidth}`);
    m.body.style.width = '60rem';
    assert(rail.offsetWidth < diff.offsetWidth,
      `and give way to the diff when there is room: rail ${rail.offsetWidth}, diff ${diff.offsetWidth}`);
    m.teardown();
  });

  await test('a long path costs a row no height, and the name survives it', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'x/a.js', index: 'M', worktree: '.', added: 126, removed: 43 },
        { path: 'web/js/components/review-panel.js', index: 'M', worktree: '.', added: 126, removed: 43 },
      ]),
    });
    // Both widths, because the rail is at its most cramped on a wide board:
    // there it is a bounded share of the panel, capped at 22rem however wide
    // the window is, and every fixed thing in a row is width the path loses.
    for (const width of ['60rem', '20rem']) {
      m.body.style.width = width;
      const rail = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__rail'));
      const rows = /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.review-panel__row')]);
      const paths = /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.review-panel__path')]);
      assert(rows.length === 2 && paths.length === 2, `expected two rows at ${width}`);
      assert(rows[1].offsetHeight === rows[0].offsetHeight,
        `a path too long for the rail must give way, not stack a character per line, at ${width}:`
        + ` short row ${rows[0].offsetHeight}, long row ${rows[1].offsetHeight}`);
      assert(paths[1].offsetWidth > rail.offsetWidth * 0.5,
        `a rail is read for its paths, so most of one belongs to them at ${width}:`
        + ` path ${paths[1].offsetWidth} of rail ${rail.offsetWidth}`);
    }
    // The directory is what gives way. The name is the part that identifies the
    // row, so it is the last thing that may be cut.
    const name = /** @type {HTMLElement} */ (m.body.querySelectorAll('.review-panel__name')[1]);
    assert(name && name.scrollWidth <= name.offsetWidth,
      `the file's own name must stay whole: ${name?.scrollWidth} of ${name?.offsetWidth}`);
    m.teardown();
  });

  // --- the scope ------------------------------------------------------------

  await test('en-XA: the scope presets, their descriptions and the expression syntax are translated where drawn', async () => {
    await underPseudoLocale('git-pin-test', async () => {
      const m = await mounted({ manifest: manifestOf([]) });
      /** @type {string[]} */
      const shown = [];
      const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
      for (const option of [...select.options].filter((o) => SCOPE_PRESETS.some((p) => p.id === o.value))) {
        shown.push(option.textContent || '', option.title);
      }
      shown.push(/** @type {HTMLInputElement} */ (m.body.querySelector('.git-pin__scope-input')).title);
      m.teardown();
      // A scoped tab names its preset; an expression is data, shown as typed.
      for (const preset of SCOPE_PRESETS.filter((p) => p.id !== DEFAULT_SCOPE)) {
        shown.push(String(pin.describe({ scope: preset.id }).subtitle));
      }
      assert(shown.length === SCOPE_PRESETS.length * 3, `expected every preset drawn, got ${JSON.stringify(shown)}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      const typed = pin.describe({ scope: 'main...HEAD' }).subtitle;
      assert(typed === 'main...HEAD', `an expression is shown as typed: ${typed}`);
    }, { '@juggler/core': [...SCOPE_PRESETS.flatMap((p) => [p.label, p.description]), SCOPE_SYNTAX] });
  });

  await test('a pin with no scope reviews the working tree against HEAD, as it always has', async () => {
    const m = await mounted({ manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]) });
    assert(m.reviewOptions()[0]?.scope === '@uncommitted',
      `expected the default scope, got ${JSON.stringify(m.reviewOptions())}`);
    assert(m.diffs()[0]?.options?.scope === '@uncommitted',
      `the patch must be read in the scope its row was listed in: ${JSON.stringify(m.diffs())}`);
    const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
    assert(select?.value === '@uncommitted', `the control should show the default, got ${select?.value}`);
    m.teardown();
  });

  await test('the scope in the pin config goes to the review and to every patch', async () => {
    const m = await mounted({
      config: { scope: 'main...HEAD' },
      manifest: manifestOf([{ path: 'a.js', index: '.', worktree: 'A' }]),
    });
    assert(m.reviewOptions()[0]?.scope === 'main...HEAD', `review asked ${JSON.stringify(m.reviewOptions())}`);
    assert(m.diffs()[0]?.options?.scope === 'main...HEAD', `diff asked ${JSON.stringify(m.diffs())}`);
    const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
    const input = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-pin__scope-input'));
    assert(select.value === 'custom' && !input.hidden && input.value === 'main...HEAD',
      `a custom scope shows as one: select ${select.value}, input ${input.hidden ? 'hidden' : input.value}`);
    m.teardown();
  });

  await test('choosing a preset saves it to the pin and reads the tree again in it', async () => {
    const m = await mounted({ manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]) });
    const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
    select.value = '@staged';
    select.dispatchEvent(new Event('change'));
    await nextTask();
    await nextTask();
    assert(m.configs().at(-1)?.scope === '@staged', `config saved: ${JSON.stringify(m.configs())}`);
    assert(m.reviewOptions().at(-1)?.scope === '@staged', `review asked ${JSON.stringify(m.reviewOptions())}`);
    assert(m.diffs().at(-1)?.options?.scope === '@staged', `diff asked ${JSON.stringify(m.diffs())}`);
    m.teardown();
  });

  await test('a custom expression is applied on Enter and remembered', async () => {
    const m = await mounted({ manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]) });
    const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
    select.value = 'custom';
    select.dispatchEvent(new Event('change'));
    await nextTask();
    assert(m.reviews() === 1, 'choosing Custom… asks for nothing until there is something to ask');
    const input = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-pin__scope-input'));
    assert(!input.hidden, 'Custom… shows the field');
    input.value = '  HEAD~3  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTask();
    await nextTask();
    const saved = m.configs().at(-1);
    assert(saved?.scope === 'HEAD~3', `config saved: ${JSON.stringify(saved)}`);
    assert(Array.isArray(saved?.recent) && saved.recent[0] === 'HEAD~3', `remembered: ${JSON.stringify(saved)}`);
    assert(m.reviewOptions().at(-1)?.scope === 'HEAD~3', `review asked ${JSON.stringify(m.reviewOptions())}`);
    const options = [...m.body.querySelectorAll('datalist option')].map((o) => /** @type {HTMLOptionElement} */ (o).value);
    assert(options.includes('HEAD~3'), `a recent expression is offered again: ${JSON.stringify(options)}`);
    m.teardown();
  });

  await test('a scope the server refuses says why, and leaves the control there to fix it', async () => {
    const m = await mounted({
      config: { scope: 'nosuch...HEAD' },
      reviewError: new Error('Unknown revision nosuch'),
    });
    assert(m.text().includes('Unknown revision nosuch'), `the reason is the server's:\n${m.text()}`);
    const input = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-pin__scope-input'));
    assert(input && !input.hidden && input.value === 'nosuch...HEAD',
      'the expression stays on screen, where it can be corrected');
    m.teardown();
  });

  await test('the scope line names the scope and the commits it came to', async () => {
    const m = await mounted({
      config: { scope: 'main...HEAD' },
      manifest: manifestOf([{ path: 'a.js', index: '.', worktree: 'A' }], {
        scope: { input: 'main...HEAD', kind: 'commits', label: 'main...HEAD' },
        repos: [repo({
          files: [{ path: 'a.js', index: '.', worktree: 'A' }], total: 1,
          base: 'aaaaaaa0000000000000000000000000000000000',
          target: 'bbbbbbb0000000000000000000000000000000000',
        })],
      }),
    });
    const scope = m.body.querySelector('.review-panel__scope')?.textContent || '';
    assert(scope.includes('main...HEAD') && scope.includes('aaaaaaa..bbbbbbb'),
      `the scope and its commits should both be named:\n${scope}`);
    m.teardown();
  });

  await test('a comment is written in the pin\'s scope, and another scope\'s are kept but not drawn here', async () => {
    const draftComment = (/** @type {string} */ id, /** @type {any} */ extra = {}) => ({
      id, repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
      lineText: ['this.renderComments(hunks);'], body: `Body ${id}`, revision: 'rev1',
      createdAt: 1, updatedAt: 1, ...extra,
    });
    const m = await mounted({
      config: { scope: '@staged' },
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }], {
        scope: { input: '@staged', kind: 'index', label: 'Staged against HEAD', labelMessage: { key: 'Staged against {revision}', params: { revision: '5' } } },
      }),
      draft: {
        version: 1, base: 'head', comments: [
          draftComment('tree'),
          draftComment('staged', { scope: '@staged', scopeLabel: 'Staged' }),
        ],
      },
    });
    const badge = m.rows()[0]?.querySelector('.review-panel__count')?.textContent;
    assert(badge === '1', `only this scope's comment counts against the row, got ${JSON.stringify(badge)}`);
    const drawnBodies = [...m.body.querySelectorAll('.diff-comment-body')].map((n) => n.textContent);
    assert(drawnBodies.length === 1 && drawnBodies[0]?.includes('Body staged'),
      `only this scope's comment is drawn on the diff: ${JSON.stringify(drawnBodies)}`);
    const footer = m.body.querySelector('.review-panel__footer')?.textContent || '';
    assert(footer.includes('2 draft comments') && footer.includes('1 in another scope'),
      `every comment still goes out together, and the footer says where they are: ${footer}`);

    const button = /** @type {HTMLElement|null} */ (m.body.querySelector('.diff-comment-btn[data-side="new"][data-line="85"]'));
    assert(button, 'expected a comment button on the added line');
    button?.click();
    const editor = m.editor();
    assert(editor, 'the button should open the editor');
    /** @type {HTMLTextAreaElement} */ (editor.querySelector('textarea')).value = 'A new one';
    /** @type {HTMLElement} */ (editor.querySelector('.review-panel__save')).click();
    await nextTask();
    const saved = m.saves().at(-1)?.comments?.find((/** @type {any} */ c) => c.body === 'A new one');
    assert(saved?.scope === '@staged' && typeof saved?.scopeLabel === 'string' && saved.scopeLabel.includes('Staged'),
      `a new comment carries the scope it was written in: ${JSON.stringify(saved)}`);
    m.teardown();
  });

  await test('the scope description sits beside the control, and wraps under it when there is no room', async () => {
    const m = await mounted({ manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.', added: 3, removed: 1 }]) });
    const row = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__scope'));
    const select = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__scope-select'));
    const text = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__scope-text'));
    assert(row && select && text && row.contains(select) && row.contains(text),
      'the control and the description should share the scope row');
    const overlaps = () => {
      const a = select.getBoundingClientRect();
      const b = text.getBoundingClientRect();
      return a.top < b.bottom && b.top < a.bottom;
    };
    assert(overlaps() && text.getBoundingClientRect().left > select.getBoundingClientRect().right,
      'on a wide board the description is to the right of the control');
    m.body.style.width = '20rem';
    assert(text.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
      `on a narrow board the description must not overflow the row: text ${text.getBoundingClientRect().right}, row ${row.getBoundingClientRect().right}`);
    m.teardown();
  });

  await test('a scope the server refuses keeps the control above the message, outside any panel', async () => {
    const m = await mounted({ config: { scope: 'nosuch' }, reviewError: new Error('Unknown revision nosuch') });
    const select = m.body.querySelector('.git-pin__scope-select');
    assert(select && !select.closest('.review-panel'), 'with no review there is no panel to host the control');
    m.teardown();
  });

  await test('each preset is described once, in one vocabulary, beside its name', async () => {
    const base = 'abcdef0000000000000000000000000000000000';
    const target = 'bbbbbbb000000000000000000000000000000000';
    const cases = [
      { scope: '@uncommitted', label: 'Working tree against HEAD', repo: {}, want: 'Working tree against HEAD' },
      { scope: '@staged', label: 'Staged against HEAD', repo: { base }, want: 'Staged against HEAD (abcdef0)' },
      { scope: '@unstaged', label: 'Working tree against the index', repo: {}, want: 'Working tree against the index' },
      { scope: '@branch', label: 'Working tree against the merge-base with the default branch',
        repo: { base, baseName: 'main' }, want: 'Working tree against the merge-base with main (abcdef0)' },
      { scope: '@last', label: 'Last commit against its parent', repo: { base, target },
        want: 'Last commit against its parent · abcdef0..bbbbbbb' },
    ];
    for (const c of cases) {
      const m = await mounted({
        config: { scope: c.scope },
        manifest: manifestOf([{ path: 'a.js', index: '.', worktree: 'M' }], {
          scope: { input: c.scope, kind: 'worktree', label: c.label },
          repos: [repo({ files: [{ path: 'a.js', index: '.', worktree: 'M' }], total: 1, ...c.repo })],
        }),
      });
      const text = m.body.querySelector('.review-panel__scope-text')?.textContent || '';
      assert(text.startsWith(`${c.want} · `), `${c.scope}: expected ${JSON.stringify(c.want)}, got ${JSON.stringify(text)}`);
      assert(!/^(Staged|Unstaged|Branch|Last commit|Working tree|Uncommitted): /.test(text),
        `${c.scope}: the dropdown beside it already names the preset: ${JSON.stringify(text)}`);
      m.teardown();
    }
    const m = await mounted({ manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]) });
    const options = [...m.body.querySelectorAll('.git-pin__scope-select option')].map((o) => o.textContent);
    assert(options[0] === 'Working tree' && !options.some((o) => /uncommitted/i.test(o || '')),
      `the presets say "working tree", never "uncommitted": ${JSON.stringify(options)}`);
    assert(pin.describe(/** @type {any} */ ({ scope: '@uncommitted' })).subtitle === 'Review changes',
      'the default keeps its tab words');
    m.teardown();
  });

  await test('a scoped pin says its scope on its tab', () => {
    assert(pin.describe(/** @type {any} */ ({})).subtitle === 'Review changes', 'the default keeps its words');
    assert(pin.describe(/** @type {any} */ ({ scope: '@branch' })).subtitle === 'Branch', 'a preset by its name');
    assert(pin.describe(/** @type {any} */ ({ scope: 'main...HEAD' })).subtitle === 'main...HEAD',
      'an expression as typed');
  });

  // --- against the real service ---------------------------------------------

  await test('the real service hands the pin the shape it expects', async () => {
    const review = await gitReviewService.review();
    assert(review !== null, 'the server should answer a review request');
    assert(typeof review.root === 'string' && Array.isArray(review.repos),
      `expected {root, repos}, got ${JSON.stringify(review)}`);
    assert(typeof review.complete === 'boolean' && Array.isArray(review.warnings),
      `completeness must be stated, not implied: ${JSON.stringify(review)}`);
    for (const found of review.repos) {
      assert(typeof found.path === 'string', `repo.path missing: ${JSON.stringify(found)}`);
      assert(typeof found.branch === 'string' && typeof found.head === 'string',
        `HEAD state missing: ${JSON.stringify(found)}`);
      assert(typeof found.complete === 'boolean', `repo completeness missing: ${JSON.stringify(found)}`);
      assert(Array.isArray(found.files), `files missing: ${JSON.stringify(found)}`);
      for (const file of found.files) {
        assert(typeof file.path === 'string' && typeof file.index === 'string'
          && typeof file.worktree === 'string', `file shape wrong: ${JSON.stringify(file)}`);
      }
    }
    assert(review.scope?.input === '@uncommitted', `the default scope should be reported: ${JSON.stringify(review.scope)}`);

    const staged = await gitReviewService.review({ scope: '@staged' });
    assert(staged.scope?.input === '@staged' && staged.scope?.kind === 'index',
      `a scope should reach the server and come back named: ${JSON.stringify(staged.scope)}`);

    let refusal = '';
    try {
      await gitReviewService.review({ scope: '--output=/tmp/x' });
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    assert(refusal.includes('--output'), `an option the server will not pass to git is refused, naming it: ${refusal}`);
  });

  // --- en-XA ------------------------------------------------------------------

  await test('en-XA: every state the pin draws is translated, and a comment keeps its scope in English', async () => {
    // Data is digits throughout: refs, workspaces, branches, errors and commit
    // ids, so a translated message around them reads as pseudo text.
    const base = '1234567000000000000000000000000000000000';
    const target = '7654321000000000000000000000000000000000';
    /** @type {string[]} */
    const shown = [];
    /**
     * The panel's scope row is the pin's words, then the panel's own file count
     * and line totals (review-panel.js, a slice of its own) — kept off here.
     * @param {any} m - The mounted pin.
     * @returns {string} The pin's part of the row.
     */
    const scopeText = (m) => (m.body.querySelector('.review-panel__scope-text')?.textContent || '')
      .replace(/ · \d+ files?( so far)?( · \+\d+ −\d+)?$/, '');
    const file = { path: '1.js', index: 'M', worktree: '.' };
    /**
     * Mount a review in one scope and return what its scope row says.
     * @param {string} scope - The pin's scope.
     * @param {any} [overrides] - Manifest overrides.
     * @param {any} [repoOverrides] - What the repository resolved to.
     * @returns {Promise<string>} The pin's part of the scope row.
     */
    const scopeLine = async (scope, overrides = {}, repoOverrides = {}) => {
      const m = await mounted({
        config: scope === DEFAULT_SCOPE ? {} : { scope },
        manifest: manifestOf([file], {
          repos: [repo({ files: [file], total: 1, ...repoOverrides })],
          ...overrides,
        }),
      });
      const text = scopeText(m);
      m.teardown();
      return text;
    };
    let commentLabel = '';

    await underPseudoLocale('git-pin-test', async () => {
      // The controls, with an expression in force so the field and its button are drawn.
      const m = await mounted({ config: { scope: '1..2' }, manifest: manifestOf([file], {
        scope: { input: '1..2', kind: 'commits', label: '1..2' },
      }) });
      const select = /** @type {HTMLSelectElement} */ (m.body.querySelector('.git-pin__scope-select'));
      const input = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-pin__scope-input'));
      const apply = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__scope-apply'));
      const custom = [...select.options].find((o) => o.value === 'custom');
      shown.push(select.getAttribute('aria-label') || '', custom?.textContent || '',
        input.getAttribute('aria-label') || '', apply.textContent || '');
      assert(input.placeholder === 'main...HEAD', `the placeholder is an expression, shown as typed: ${input.placeholder}`);
      // A refresh that fails keeps the review and says so under it.
      m.failReview(new Error('3'));
      await m.controller.getActions()[0].run();
      shown.push(m.body.querySelector('.review-panel__error')?.textContent || '');
      shown.push(...m.controller.getActions().map((/** @type {any} */ a) => a.label));
      m.teardown();

      // Nothing read yet, and a read that failed, in the default scope and another.
      for (const config of [{}, { scope: '1..2' }]) {
        const failed = await mounted({ config, reviewError: new Error('3') });
        shown.push(failed.body.querySelector('.git-pin__quiet')?.textContent || '',
          failed.body.querySelector('.git-pin__error')?.textContent || '');
        failed.teardown();
      }

      // No repository, in the project and in a workspace's tree.
      for (const workspace of ['', '4']) {
        const empty = await mounted({ manifest: manifestOf([], { repos: [], workspace }) });
        shown.push(empty.body.querySelector('.pin-empty')?.textContent || '');
        empty.teardown();
      }

      // The scope line: the default, a preset the server named in its words, the
      // branch's merge-base, an expression; with and without a workspace, and
      // with one commit, two, or none resolved.
      shown.push(await scopeLine(DEFAULT_SCOPE));
      shown.push(await scopeLine(DEFAULT_SCOPE, { workspace: '4' }));
      shown.push(await scopeLine('@staged', { scope: { input: '@staged', kind: 'index', label: 'Staged against HEAD', labelMessage: { key: 'Staged against {revision}', params: { revision: '5' } } } }));
      shown.push(await scopeLine('@staged',
        { scope: { input: '@staged', kind: 'index', label: 'Staged against HEAD', labelMessage: { key: 'Staged against {revision}', params: { revision: '5' } } }, workspace: '4' }, { base }));
      shown.push(await scopeLine('@branch',
        { scope: { input: '@branch', kind: 'worktree', label: 'Working tree against the merge-base with the default branch', labelMessage: { key: 'Working tree against the merge-base with the default branch' } } },
        { base, baseName: '9' }));
      shown.push(await scopeLine('@last',
        { scope: { input: '@last', kind: 'commits', label: 'Last commit against its parent', labelMessage: { key: 'Last commit against its parent' } }, workspace: '4' },
        { base, target }));
      // An expression's label is the server's own words for it — here a range,
      // which is data: only the words around it are the pin's.
      const range = await scopeLine('1..2', { scope: { input: '1..2', kind: 'commits', label: '1..2' } }, { base, target });
      shown.push(range);
      assert(range.includes('1..2') && range.includes('1234567..7654321'), `the range and its commits are named: ${range}`);
      // An expression the server put into words sends them as a message too.
      shown.push(await scopeLine('--merge-base 1', { scope: {
        input: '--merge-base 1', kind: 'worktree', label: 'Working tree against the merge-base with 1',
        labelMessage: { key: 'Working tree against the merge-base with {revision}', params: { revision: '1' } },
      } }, { base }));

      // A warning the server sent with its message.
      const warned = await mounted({ manifest: manifestOf([file], {
        complete: false,
        warnings: ['Couldn\'t compare the project repository: 3'],
        warningMessages: [{
          key: 'Couldn\'t compare {where, select, root {the project repository} other {{repo}}}: {detail}',
          params: { where: 'root', repo: '', detail: '3' },
        }],
      }) });
      shown.push(warned.body.querySelector('.review-panel__warning-list li')?.textContent || '');
      warned.teardown();

      // A repository's details: an upstream it is level with, stashes, a
      // repository with no commits, a detached head, no branch, and a branch
      // ahead, behind, and both. The branch, upstream and HEAD are data.
      const detailed = await mounted({ manifest: manifestOf([file], { repos: [
        repo({ path: '5', branch: '6', upstream: '7', stashes: 2, files: [file], total: 1 }),
        repo({ path: '8', branch: '6', initial: true, stashes: 1, files: [file], total: 1 }),
        repo({ path: '9', detached: true, files: [file], total: 1 }),
        repo({ path: '10', branch: '', files: [file], total: 1 }),
        repo({ path: '11', branch: '6', upstream: '7', ahead: 2, behind: 3, files: [file], total: 1 }),
        repo({ path: '12', branch: '6', upstream: '7', ahead: 1, files: [file], total: 1 }),
        repo({ path: '13', branch: '6', upstream: '7', behind: 1, files: [file], total: 1 }),
      ] }) });
      for (const detail of detailed.body.querySelectorAll('.review-panel__group-detail')) {
        shown.push(...(detail.textContent || '').split(' · ').filter((part) => !/^(\d+|→ \d+)$/.test(part)));
      }
      detailed.teardown();

      // A list the server cut short says how much of it there is; a repository
      // at a root with no folder name is still named.
      const truncated = await mounted({ manifest: manifestOf([file], {
        root: '',
        repos: [repo({ files: [file], total: 9, truncated: true }), repo({ path: '5', files: [file], total: 1 })],
      }) });
      shown.push(truncated.body.querySelector('.review-panel__group-note')?.textContent || '');
      shown.push(truncated.body.querySelector('.review-panel__group-name')?.textContent || '');
      truncated.teardown();

      // Every file status, one side at a time and both, in its row's label.
      const statusFiles = [...'MADRCTU'].flatMap((letter, i) => [
        { path: `${i}0.js`, index: '.', worktree: letter },
        { path: `${i}1.js`, index: letter, worktree: '.' },
      ]).concat([
        { path: '80.js', index: 'A', worktree: 'M' },
        { path: '81.js', index: 'R', worktree: 'T' },
        { path: '82.js', index: '?', worktree: '?' },
        { path: '83.js', index: '.', worktree: '.' },
      ]);
      const statuses = await mounted({ manifest: manifestOf(statusFiles) });
      // The label is the panel's message around the status; its path is data.
      for (const row of statuses.rows()) shown.push((row.getAttribute('aria-label') || '').replace(/, \d+\.js/, ''));
      statuses.teardown();

      // A conflicted file names itself so in its row's label. The rest of that
      // label is the panel's (review-panel.js).
      const conflicted = await mounted({
        manifest: manifestOf([{ path: '1.js', index: 'U', worktree: 'U', conflicted: true }]),
      });
      shown.push((conflicted.rows()[0]?.getAttribute('aria-label') || '').split(', ')[0] || '');
      conflicted.teardown();

      // The tab's words and the add picker's reason. The tab's title is the
      // manifest name, which `describePin` translates in its owner's catalogue.
      shown.push(String(pin.describe({}).subtitle));
      shown.push(String(pin.canAdd(/** @type {any} */ ({ project: { path: '' } }))));
      assert(pin.describe({}).title === GitPin.MANIFEST.name, 'the title is the manifest name, for describePin to translate');

      // A comment is stored with the scope's words, and they reach the model in
      // the review message: those stay English while the row above is translated.
      const scoped = await mounted({
        config: { scope: '@staged' },
        manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }], {
          scope: { input: '@staged', kind: 'index', label: 'Staged against HEAD', labelMessage: { key: 'Staged against {revision}', params: { revision: '5' } } },
          repos: [repo({ files: [{ path: 'a.js', index: 'M', worktree: '.' }], total: 1, base })],
        }),
      });
      const button = /** @type {HTMLElement|null} */ (scoped.body.querySelector('.diff-comment-btn[data-side="new"][data-line="85"]'));
      assert(button, 'expected a comment button on the added line');
      button?.click();
      const editor = scoped.editor();
      /** @type {HTMLTextAreaElement} */ (editor.querySelector('textarea')).value = 'A new one';
      /** @type {HTMLElement} */ (editor.querySelector('.review-panel__save')).click();
      await nextTask();
      commentLabel = scoped.saves().at(-1)?.comments?.find((/** @type {any} */ c) => c.body === 'A new one')?.scopeLabel || '';
      scoped.teardown();
    }, { '@juggler/core': [
      ...SCOPE_PRESETS.flatMap((p) => [p.label, p.description]), SCOPE_SYNTAX,
      'Compare', 'Custom…', 'Git diff expression', 'Show', 'Checking…', 'Refresh', 'Review changes', 'No project',
      "Couldn't read the working tree. {error}", "Couldn't compare {scope}. {error}", "Couldn't refresh. {error}",
      'No git repository.', 'No git repository in {workspace}.',
      'Working tree against HEAD', 'Working tree of {workspace} against HEAD',
      'Working tree against the merge-base with {base}', '{label} in {workspace}',
      '{label} · {base}..{target}', '{label} ({base})',
      'Up to date', 'No commits yet', '{count, plural, one {{count} stash} other {{count} stashes}}', 'Conflicted',
      ...GIT_STATUS_TEXT,
    ] });

    assert(shown.length === 53, `expected every state drawn, got ${shown.length}: ${JSON.stringify(shown)}`);
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    assert(commentLabel === 'Staged against HEAD (1234567)',
      `a comment's scope is read by the model, so it stays English: ${JSON.stringify(commentLabel)}`);
  });

  return { passed, failed, errors };
}
