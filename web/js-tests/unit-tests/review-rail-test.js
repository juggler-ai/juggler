//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The review panel's own cost is bounded by what is in view, not by the size of
 * the review: a manifest of the size the server caps a commit at draws a window
 * of rail rows, which the keyboard and `focus()` still walk end to end; a change
 * to the draft relabels the rows that are drawn and no others; and moving
 * between files keeps the one `<diff-viewer>` connected, building the file's
 * head once.
 *
 * Every step is synchronous — the rail draws in the call that changes it and on
 * the scroll event itself — because a test lane never paints. Structure is
 * asserted (rows drawn, labels written, nodes removed), never time.
 * @module unit-tests/review-rail-test
 */

import { assert } from '../utilities/test-helpers.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import { createReviewPanel } from '../../js/components/review-panel.js';

/** Files in the big manifest: the server's cap on a commit (`gitReviewMaxFiles`). */
const FILES = 5000;

/** The most rail rows a window may hold, whatever the manifest's size. */
const BOUND = 300;

/**
 * @param {string} repo - The group.
 * @param {number} count - How many files.
 * @returns {any[]} That many files, worded as a host would.
 */
function filesOf(repo, count) {
  return Array.from({ length: count }, (_, i) => ({
    repo,
    path: `src/dir-${i % 7}/file-${i}.js`,
    code: 'M',
    tone: 'modified',
    status: 'Modified',
    added: 1,
    removed: 1,
    filePath: `/repo/${repo}/src/dir-${i % 7}/file-${i}.js`,
  }));
}

/**
 * A draft that lives in memory, shaped like `services.review`.
 * @param {any[]} [comments] - The comments it starts with.
 * @returns {any} The draft, with `state` and `notify` for the test to steer.
 */
function fakeReview(comments = []) {
  const state = { comments: comments.slice(), /** @type {Set<() => void>} */ listeners: new Set() };
  const notify = () => { for (const listener of state.listeners) listener(); };
  return {
    state,
    notify,
    draft: () => ({ comments: state.comments }),
    /**
     * @param {() => void} listener - Called on every change.
     * @returns {() => void} Stops it.
     */
    onChange: (listener) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
    /** @param {{comments: any[]}} next - The whole draft. */
    save: async ({ comments: next }) => { state.comments = next; notify(); },
    clear: async () => { state.comments = []; notify(); },
    compose: async () => {},
  };
}

/**
 * @param {string} repo - The file's group.
 * @param {string} path - Its path.
 * @param {string} id - The comment's id.
 * @returns {any} A whole-file comment on it.
 */
const comment = (repo, path, id) => ({ id, group: repo, path, side: 'file', body: 'b', createdAt: 1, updatedAt: 1 });

/**
 * Let the stubs' promises, and the panel's awaits on them, run out. Every stub
 * resolves without a timer, so this is a fixed number of microtask turns.
 * @returns {Promise<void>}
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * @param {any} panel - The panel.
 * @returns {HTMLElement[]} The rail rows drawn now.
 */
const drawnRows = (panel) => /** @type {HTMLElement[]} */ ([...panel.element.querySelectorAll('.review-panel__file')]);

/**
 * @param {any} panel - The panel.
 * @param {string} path - A file's path.
 * @returns {HTMLElement|null} Its row, when drawn.
 */
const rowFor = (panel, path) => drawnRows(panel).find((row) => row.title === path) || null;

/**
 * @param {any} panel - The panel.
 * @param {string} key - The key to press on the rail.
 */
function press(panel, key) {
  const target = panel.element.querySelector('.review-panel__file[aria-current="true"]')
    || panel.element.querySelector('.review-panel__rail');
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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

  // A box of a pin's size: the panel fills it, so its rail scrolls.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /**
   * @param {any} [review] - The draft.
   * @returns {any} A panel, mounted.
   */
  const mount = (review = fakeReview()) => {
    const panel = createReviewPanel({ scopeLabel: 'HEAD', loadPatch: async () => /** @type {any} */ ({ hunks: [] }), review });
    container.appendChild(panel.element);
    return panel;
  };

  try {
    await test('a commit at the server\'s cap draws a window of rows, which the keyboard and focus() walk end to end', async () => {
      const panel = mount();
      const focus = isolateFocus();
      try {
        const files = filesOf('', FILES);
        panel.setManifest({ complete: true, warnings: [], groups: [{ key: '', files }] });
        await flush();

        const rail = /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__rail'));
        const rows = drawnRows(panel);
        assert(rows.length > 0 && rows.length < BOUND, `a window of rows, got ${rows.length} of ${FILES}`);
        assert(rail.scrollHeight > rail.clientHeight, 'the rail stands as tall as every file, so it scrolls');
        const first = rowFor(panel, files[0].path);
        assert(first?.getAttribute('aria-current') === 'true' && first.tabIndex === 0, 'the first file is current');
        assert(first?.dataset.filePath === files[0].filePath, 'a drawn row keeps its right-click path');
        assert(Boolean(first?.querySelector('.review-panel__stat')), 'a drawn row keeps its diffstat');

        press(panel, 'End');
        await flush();
        const last = rowFor(panel, files[FILES - 1].path);
        assert(Boolean(last), 'End draws the last file\'s row');
        assert(last?.getAttribute('aria-current') === 'true' && last.tabIndex === 0, 'End makes the last file current');
        assert(focus.asked(/** @type {HTMLElement} */ (last)), 'End moves focus to the last file\'s row');
        assert(panel.element.querySelectorAll('[aria-current="true"]').length === 1, 'one row is current');
        assert(drawnRows(panel).length < BOUND, `still a window after End, got ${drawnRows(panel).length}`);
        assert(panel.element.querySelector('.review-panel__diff-path')?.textContent === files[FILES - 1].path,
          'the last file is the one shown');

        press(panel, 'ArrowUp');
        await flush();
        assert(rowFor(panel, files[FILES - 2].path)?.getAttribute('aria-current') === 'true', 'ArrowUp steps back one');

        // Scroll the rail back to the top. The rows around the current one go,
        // but it stays — the rail's one tab stop — and focus() brings it back
        // into view and focuses it.
        rail.scrollTop = 0;
        rail.dispatchEvent(new Event('scroll'));
        assert(Boolean(rowFor(panel, files[0].path)), 'scrolled to the top, the first rows are drawn');
        assert(!rowFor(panel, files[FILES - 3].path), 'and those around the current row are not');
        const kept = rowFor(panel, files[FILES - 2].path);
        assert(kept?.tabIndex === 0, 'the current row is kept as the rail\'s tab stop');
        assert(drawnRows(panel).length < BOUND, `still a window at the top, got ${drawnRows(panel).length}`);
        focus.requests.length = 0;
        panel.focus();
        const again = rowFor(panel, files[FILES - 2].path);
        assert(Boolean(again && focus.asked(again)), 'focus() focuses the current row');
        assert(Boolean(rowFor(panel, files[FILES - 3].path)), 'and draws the rows around it');

        press(panel, 'Home');
        await flush();
        assert(rowFor(panel, files[0].path)?.getAttribute('aria-current') === 'true', 'Home returns to the first file');
      } finally {
        focus.restore();
        panel.destroy();
        panel.element.remove();
      }
    });

    await test('every group keeps its head and note while the rail is windowed', async () => {
      const panel = mount();
      const focus = isolateFocus();
      try {
        const groups = ['a', 'b', 'c'].map((key) => ({
          key, name: `repo-${key}`, detail: 'main', note: `note ${key}`, files: filesOf(key, 1500),
        }));
        panel.setManifest({ complete: true, warnings: [], groups });
        await flush();
        const names = [...panel.element.querySelectorAll('.review-panel__group-name')].map((n) => n.textContent);
        const notes = [...panel.element.querySelectorAll('.review-panel__group-note')].map((n) => n.textContent);
        assert(JSON.stringify(names) === JSON.stringify(['repo-a', 'repo-b', 'repo-c']), `every group head: ${JSON.stringify(names)}`);
        assert(JSON.stringify(notes) === JSON.stringify(['note a', 'note b', 'note c']), `every group note: ${JSON.stringify(notes)}`);
        assert(drawnRows(panel).length < BOUND, `a window of rows across groups, got ${drawnRows(panel).length}`);

        press(panel, 'End');
        await flush();
        const last = rowFor(panel, groups[2]?.files[1499]?.path || '');
        assert(last?.getAttribute('aria-current') === 'true', 'End reaches the last group\'s last file');
        assert(last?.closest('.review-panel__group')?.querySelector('.review-panel__group-name')?.textContent === 'repo-c',
          'drawn under its own group');
        assert(drawnRows(panel).length < BOUND, `still a window after End, got ${drawnRows(panel).length}`);
      } finally {
        focus.restore();
        panel.destroy();
        panel.element.remove();
      }
    });

    await test('a draft change relabels only the rows that are drawn', async () => {
      const files = filesOf('', FILES);
      const review = fakeReview([comment('', files[0].path, 'c0'), comment('', files[FILES - 1].path, 'cz')]);
      const panel = mount(review);
      const focus = isolateFocus();
      try {
        panel.setManifest({ complete: true, warnings: [], groups: [{ key: '', files }] });
        await flush();
        const badge = (/** @type {string} */ path) => rowFor(panel, path)?.querySelector('.review-panel__count')?.textContent;
        assert(badge(files[0].path) === '1', `the first file's count: ${badge(files[0].path)}`);

        let labels = 0;
        const label = /** @type {(...args: any[]) => void} */ (panel._labelRow);
        panel._labelRow = function (/** @type {any[]} */ ...args) {
          labels++;
          return label.apply(this, args);
        };
        review.state.comments = [...review.state.comments, comment('', files[1].path, 'c1'), comment('', files[1].path, 'c2')];
        review.notify();
        const drawn = drawnRows(panel).length;
        assert(labels > 0 && labels <= drawn && labels < BOUND, `relabelled ${labels} rows, with ${drawn} drawn of ${FILES}`);
        assert(badge(files[1].path) === '2', `a drawn row's count follows the draft: ${badge(files[1].path)}`);
        assert((rowFor(panel, files[1].path)?.getAttribute('aria-label') || '').includes('2 comments'),
          'and so does its spoken label');

        press(panel, 'End');
        await flush();
        assert(badge(files[FILES - 1].path) === '1', `a row drawn later is drawn with its count: ${badge(files[FILES - 1].path)}`);
      } finally {
        focus.restore();
        panel.destroy();
        panel.element.remove();
      }
    });

    await test('moving between files keeps the diff viewer connected and builds the head once', async () => {
      let built = 0;
      const files = filesOf('', 3).map((file) => ({
        ...file,
        actions: () => {
          built++;
          return document.createElement('span');
        },
      }));
      const panel = mount();
      try {
        panel.setManifest({ complete: true, warnings: [], groups: [{ key: '', files }] });
        await flush();
        const diff = /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__diff'));
        const viewer = diff.querySelector('diff-viewer');
        assert(Boolean(viewer), 'a viewer is shown');

        // connectedCallback is the one caller of onWindow, three times a mount,
        // so this counts the viewer being put back into the document.
        let connects = 0;
        const anyViewer = /** @type {any} */ (viewer);
        const onWindow = anyViewer.onWindow;
        anyViewer.onWindow = function (/** @type {any[]} */ ...args) {
          connects++;
          return onWindow.apply(this, args);
        };
        built = 0;
        /** @type {HTMLElement} */ (rowFor(panel, files[1].path)).click();
        await flush();
        assert(connects === 0, `the viewer was put back into the document ${connects / 3} time(s) for one selection`);
        assert(diff.querySelector('diff-viewer') === viewer && Boolean(viewer?.isConnected), 'the same viewer, still connected');
        assert(built === 1, `the file's controls are built once per selection, got ${built}`);
        assert(diff.querySelector('.review-panel__diff-path')?.textContent === files[1].path, 'the head names the new file');
        assert(diff.querySelectorAll('.review-panel__diff-head').length === 1, 'one head');
      } finally {
        panel.destroy();
        panel.element.remove();
      }
    });
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
