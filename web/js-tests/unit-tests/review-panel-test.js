//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The review panel's own words: the rail, the scope row's count, the rows'
 * spoken labels, the comment editor and the draft footer, in every state they
 * are drawn in. The diff it hosts is `diff-viewer`'s, and the words a host hands
 * it (scope, status, group names, warnings) are the host's — both kept out here.
 * @module unit-tests/review-panel-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized, setLocale } from '../../sdk/lib/i18n.js';
import { createReviewPanel } from '../../js/components/review-panel.js';

/**
 * A draft that lives in memory, shaped like `services.review`.
 * @param {{comments?: any[], open?: boolean}} [options] - The comments it starts
 *   with, and whether a conversation is open to keep them in.
 * @returns {any} The draft, with `state` for the test to read and steer.
 */
function fakeReview({ comments = [], open = true } = {}) {
  const state = {
    comments: comments.slice(),
    /** @type {any[][]} */
    saves: [],
    /** @type {Error|null} */
    fail: null,
    /** @type {Set<() => void>} */
    listeners: new Set(),
  };
  const notify = () => { for (const listener of state.listeners) listener(); };
  return {
    state,
    notify,
    draft: () => (open ? { comments: state.comments } : null),
    /**
     * @param {() => void} listener - Called on every change.
     * @returns {() => void} Stops it.
     */
    onChange: (listener) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
    /** @param {{comments: any[]}} next - The whole draft. */
    save: async ({ comments: next }) => {
      if (state.fail) throw state.fail;
      state.saves.push(next);
      state.comments = next;
      notify();
    },
    clear: async () => {
      if (state.fail) throw state.fail;
      state.comments = [];
      notify();
    },
    compose: async () => {
      if (state.fail) throw state.fail;
    },
  };
}

/**
 * Let the stubs' promises, and the panel's awaits on them, run out. Every stub
 * here resolves without a timer, so this is a fixed number of microtask turns
 * rather than a wait.
 * @returns {Promise<void>}
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const test = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  try {
    // --- en-XA ----------------------------------------------------------------

    await test('en-XA: every state the panel draws is translated, and a comment keeps its scope in English', async () => {
      // Data is digits throughout — paths, repositories, statuses, scopes,
      // errors — so a translated message around them reads as pseudo text.
      /** @type {string[]} */
      const shown = [];
      let commentScope = '';
      const loadPatch = async () => ({ hunks: [] });

      /**
       * The scope row's own words: the host's scope and the line totals are data.
       * @param {any} panel - The panel.
       * @returns {string[]} The rest of the row.
       */
      const scopeParts = (panel) => (panel.element.querySelector('.review-panel__scope-text')?.textContent || '')
        .split(' · ').filter((part) => !/^(\d+|\+\d+ −\d+)$/.test(part));
      /**
       * @param {any} panel - The panel.
       * @param {string} selector - What to read.
       * @returns {string} Its text.
       */
      const textOf = (panel, selector) => panel.element.querySelector(selector)?.textContent || '';

      await underPseudoLocale('review-panel-test', async () => {
        // No conversation and nothing read yet: the rail's name and the footer's note.
        const closed = fakeReview({ open: false });
        const idle = createReviewPanel({ scopeLabel: '1', loadPatch, review: closed });
        container.appendChild(idle.element);
        shown.push(idle.element.querySelector('.review-panel__rail')?.getAttribute('aria-label') || '');
        shown.push(textOf(idle, '.review-panel__footer-note'));
        // A review with nothing in it.
        idle.setManifest({ complete: true, warnings: [], groups: [] });
        shown.push(...scopeParts(idle));
        shown.push(textOf(idle, '.review-panel__placeholder'));
        idle.destroy();
        idle.element.remove();

        // A partial review, with warnings, every shape of row, and comments
        // 0, 1 and 2 to a row, plus one written in another scope.
        const comment = (/** @type {string} */ id, /** @type {string} */ repo, /** @type {string} */ path,
          /** @type {any} */ extra = {}) => ({ id, repo, path, side: 'file', body: '8', scope: '9', createdAt: 1, updatedAt: 1, ...extra });
        const review = fakeReview({ comments: [
          comment('c1', '', '3'),
          comment('c2', '6', '3', { side: 'old', startLine: 3, endLine: 5 }),
          comment('c3', '6', '3'),
          comment('c4', '', '1/2', { scope: '' }),
        ] });
        const panel = createReviewPanel({ scopeLabel: '1', loadPatch, review });
        container.appendChild(panel.element);
        panel.setManifest({
          complete: false,
          warnings: ['Couldn\'t compare the project repository: 8'],
          warningMessages: [{
            key: 'Couldn\'t compare {where, select, root {the project repository} other {{repo}}}: {detail}',
            params: { where: 'root', repo: '', detail: '8' },
          }],
          scope: '1',
          commentScope: 'Staged against HEAD',
          scopeKey: '9',
          groups: [
            { key: '', files: [
              { repo: '', path: '1/2', status: '' },
              { repo: '', path: '3', oldPath: '4', status: '5' },
            ] },
            { key: '6', name: '6', files: [
              { repo: '6', path: '3', status: '5' },
              { repo: '6', path: '7', oldPath: '4', status: '', added: 1, removed: 2 },
            ] },
          ],
        });
        await flush();
        shown.push(...scopeParts(panel));
        shown.push(textOf(panel, '.review-panel__warnings-lead'));
        shown.push(textOf(panel, '.review-panel__warning-list li'));
        for (const row of panel.element.querySelectorAll('.review-panel__file')) {
          shown.push(row.getAttribute('aria-label') || '');
        }
        shown.push(textOf(panel, '.review-panel__draft-count'));
        shown.push(textOf(panel, '.review-panel__discard'), textOf(panel, '.review-panel__compose'));

        // The footer's refusals.
        review.state.fail = new Error('7');
        /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__discard')).click();
        await flush();
        shown.push(textOf(panel, '.review-panel__footer-error'));
        /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__compose')).click();
        await flush();
        shown.push(textOf(panel, '.review-panel__footer-error'));
        const diff = /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__diff'));
        diff.dispatchEvent(new CustomEvent('diff-annotation-delete', { detail: { id: 'c1' } }));
        await flush();
        shown.push(textOf(panel, '.review-panel__footer-error'));
        review.state.fail = null;

        // The editor, for the whole file: its label, its buttons, and both refusals.
        const whole = /** @type {HTMLElement|null} */ (panel.element.querySelector('.review-panel__file-comment'));
        assert(whole, 'expected a way to comment on the whole file');
        shown.push(whole?.textContent || '');
        whole?.click();
        shown.push(textOf(panel, '.review-panel__editor-label'),
          textOf(panel, '.review-panel__save'), textOf(panel, '.review-panel__cancel'));
        /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__save')).click();
        await flush();
        shown.push(textOf(panel, '.review-panel__editor-error'));
        /** @type {HTMLTextAreaElement} */ (panel.element.querySelector('.review-panel__editor-text')).value = 'A new one';
        review.state.fail = new Error('7');
        /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__save')).click();
        await flush();
        shown.push(textOf(panel, '.review-panel__editor-error'));
        review.state.fail = null;
        /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__save')).click();
        await flush();
        commentScope = review.state.comments.find((/** @type {any} */ c) => c.body === 'A new one')?.scopeLabel || '';

        // The editor on one line, and on several (an existing comment, so it saves changes).
        diff.dispatchEvent(new CustomEvent('diff-comment-request',
          { detail: { side: 'new', startLine: 2, endLine: 2, lines: [] } }));
        shown.push(textOf(panel, '.review-panel__editor-label'));
        diff.dispatchEvent(new CustomEvent('diff-annotation-edit', { detail: { id: 'c2' } }));
        shown.push(textOf(panel, '.review-panel__editor-label'), textOf(panel, '.review-panel__save'));
        diff.dispatchEvent(new CustomEvent('diff-comment-request',
          { detail: { side: 'old', startLine: 2, endLine: 2, lines: [] } }));
        shown.push(textOf(panel, '.review-panel__editor-label'));
        diff.dispatchEvent(new CustomEvent('diff-comment-request',
          { detail: { side: 'new', startLine: 2, endLine: 4, lines: [] } }));
        shown.push(textOf(panel, '.review-panel__editor-label'));

        // A single comment, all in this scope, and a complete review of one file.
        review.state.comments = [comment('c1', '', '3')];
        review.notify();
        shown.push(textOf(panel, '.review-panel__draft-count'));
        panel.setManifest({ complete: true, warnings: [], scopeKey: '9', groups: [
          { key: '', files: [{ repo: '', path: '3', status: '5' }] },
        ] });
        shown.push(...scopeParts(panel));
        shown.push(panel.element.querySelector('.review-panel__file')?.getAttribute('aria-label') || '');
        panel.destroy();
        panel.element.remove();
      });

      assert(shown.length === 31, `expected every state drawn, got ${shown.length}: ${JSON.stringify(shown)}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      assert(commentScope === 'Staged against HEAD',
        `a comment's scope is read by the model, so it stays English: ${JSON.stringify(commentScope)}`);
    });

    await test('line totals and comment counts are in the UI language\'s digits', async () => {
      /**
       * @param {string} locale - The UI locale to draw under.
       * @returns {Promise<{scope: string, stat: string, badge: string}>} What the panel shows.
       */
      const drawn = async (locale) => {
        const previous = setLocale(locale);
        const review = fakeReview({ comments: [
          { id: 'c1', group: '', path: '7', side: 'file', body: '8', scope: '9', createdAt: 1, updatedAt: 1 },
        ] });
        const panel = createReviewPanel({ scopeLabel: '1', loadPatch: async () => ({ hunks: [] }), review });
        container.appendChild(panel.element);
        try {
          panel.setManifest({ complete: true, warnings: [], scope: '1', scopeKey: '9', groups: [
            { key: '', files: [{ repo: '', path: '7', status: '', added: 1234, removed: 2 }] },
          ] });
          await flush();
          const text = (/** @type {string} */ sel) => panel.element.querySelector(sel)?.textContent || '';
          return { scope: text('.review-panel__scope-text'), stat: text('.review-panel__stat'), badge: text('.review-panel__count') };
        } finally {
          setLocale(previous);
          panel.destroy();
          panel.element.remove();
        }
      };
      const en = await drawn('en');
      assert(en.stat === '+1,234 −2' && en.scope.endsWith(' · +1,234 −2') && en.badge === '1',
        `English figures: ${JSON.stringify(en)}`);
      const ar = await drawn('ar-EG');
      assert(ar.stat === '+١٬٢٣٤ −٢' && ar.scope.endsWith(' · +١٬٢٣٤ −٢') && ar.badge === '١',
        `Arabic figures: ${JSON.stringify(ar)}`);
    });
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
