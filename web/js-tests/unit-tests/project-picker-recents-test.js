//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: a single click on a recent entry in the path picker opens it,
 * through the same confirm action as the primary button, once the path checks
 * out — and does not open one that does not.
 * @module unit-tests/project-picker-recents-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { t, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import apiService from '../../js/services/api.js';
import { closePopupById } from '../../js/utils/popup-manager.js';
import { endProjectOpen, openProjectInWindow } from '../../js/components/project-opening.js';
import { buildPickerPanel, openProjectPicker, openNewProjectPanel } from '../../js/components/project-picker.js';

/**
 * Wait for a promise to settle, riding the test's deadline (`ms` is the
 * nominal), or report that it never did.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|'pending'>} The settled value, or 'pending'
 */
function settleWithin(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), budgetFor(ms)))]);
}

/**
 * Report whether a promise is still pending after a fixed `ms`.
 *
 * The one wait here that deliberately does not ride the deadline: it proves
 * something does NOT happen, so patience buys nothing — load can only make a
 * pending promise look more pending, never fail the check — and a budgeted
 * wait would spend up to six times its nominal on every passing run.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|'pending'>} The settled value, or 'pending'
 */
function pendingAfter(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), ms))]);
}

/**
 * @param {HTMLElement} panel
 * @param {string} path
 * @returns {void}
 */
function clickRecent(panel, path) {
  const item = [...panel.querySelectorAll('.pp-recent-item')].find((b) => b.textContent === path);
  assert(!!item, `no recent entry for ${path}`);
  /** @type {HTMLElement} */ (item).click();
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
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run('a click on a valid recent opens it', async () => {
    const { element, promise, cancel } = buildPickerPanel({
      recents: ['/work/alpha'],
      validate: async (p) => ({ valid: true, path: p }),
    });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/alpha');
      const got = await settleWithin(promise, 1000);
      assert(got === '/work/alpha', `picker resolved ${JSON.stringify(got)}, want "/work/alpha"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('Enter that takes a completion takes only the completion', async () => {
    // The field consumes an Enter that takes a highlighted path; the panel must
    // not also read that same press as "open". A file taken from the menu
    // closes the menu, so asking whether a menu is still showing gets it wrong.
    const { element, promise, cancel } = buildPickerPanel({ dirsOnly: false });
    document.body.appendChild(element);
    const field = /** @type {any} */ (element.querySelector('path-input'));
    try {
      const input = /** @type {HTMLInputElement} */ (field.querySelector('input'));
      field.value = '/work/a';
      field.dispatchEvent(new CustomEvent('path-change', { detail: { value: '/work/a' } }));
      field._openMenu(['/work/a.txt', '/work/b.txt']);
      field._highlight(0);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert(field.value === '/work/a.txt', `the Enter must take the completion, got ${JSON.stringify(field.value)}`);
      const got = await pendingAfter(promise, 200);
      assert(got === 'pending', `the same Enter also opened ${JSON.stringify(got)}`);

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const opened = await settleWithin(promise, 1000);
      assert(opened === '/work/a.txt', `the next Enter opens what was taken, got ${JSON.stringify(opened)}`);
    } finally {
      field._closeMenu?.();
      cancel();
      element.remove();
    }
  });

  await run('a click on an invalid recent stays open and says why', async () => {
    const { element, promise, cancel } = buildPickerPanel({
      recents: ['/work/gone'],
      validate: async () => ({ valid: false, error: 'No such folder' }),
    });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/gone');
      const got = await pendingAfter(promise, 300);
      assert(got === 'pending', `picker resolved ${JSON.stringify(got)} for an invalid path`);
      // The panel's delayed focus makes the field re-announce the value it
      // already holds. Delivered here every run, not left to when that timer
      // happens to fire: an unchanged path keeps the answer it already has.
      const field = /** @type {HTMLElement} */ (element.querySelector('path-input'));
      field.dispatchEvent(new CustomEvent('path-change', { bubbles: true, detail: { value: '/work/gone' } }));
      const status = element.querySelector('.pp-status')?.textContent || '';
      assert(status.includes('No such folder'), `status was "${status}"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('a click opens without a validator too', async () => {
    const { element, promise, cancel } = buildPickerPanel({ recents: ['/work/beta'] });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/beta');
      const got = await settleWithin(promise, 1000);
      assert(got === '/work/beta', `picker resolved ${JSON.stringify(got)}, want "/work/beta"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('markup in caller-supplied labels is shown as text', async () => {
    const { element, cancel } = buildPickerPanel({
      title: '<b>1</b>',
      subtitle: '<b>2</b>',
      placeholder: '"><b>3</b>',
      confirmLabel: '<b>4</b>',
      newWindowLabel: '<b>5</b>',
      onNewWindow: () => {},
    });
    try {
      assert(!element.querySelector('b'), `markup in a label became elements: ${element.innerHTML}`);
      const title = element.querySelector('.pp-title')?.textContent || '';
      assert(title === '<b>1</b>', `title read "${title}", want "<b>1</b>"`);
      const open = element.querySelector('.pp-btn-open')?.textContent || '';
      assert(open === '<b>4</b>', `confirm read "${open}", want "<b>4</b>"`);
      const placeholder = element.querySelector('path-input')?.getAttribute('placeholder');
      assert(placeholder === '"><b>3</b>', `placeholder read ${JSON.stringify(placeholder)}`);
    } finally {
      cancel();
    }
  });

  await run('a pre-filled path is the attribute value exactly, entities and all', async () => {
    const PATH = '/work/&amp;/<b>"x\'';
    const { element, cancel } = buildPickerPanel({ currentPath: PATH });
    try {
      assert(!element.querySelector('b'), `markup in the path became elements: ${element.innerHTML}`);
      const value = element.querySelector('path-input')?.getAttribute('value');
      assert(value === PATH, `value read ${JSON.stringify(value)}, want ${JSON.stringify(PATH)}`);
    } finally {
      cancel();
    }
  });

  await run('a new window opened on the current project is given its path, not the status line', async () => {
    /** @type {string[]} */
    const launched = [];
    const { element, promise, cancel } = buildPickerPanel({
      currentPath: '/work/here',
      confirmOpensNewWindow: true,
      onNewWindow: (p) => { launched.push(p); },
      validate: async () => ({ valid: true, current: true, path: '/work/here' }),
    });
    document.body.appendChild(element);
    try {
      const openBtn = /** @type {HTMLButtonElement} */ (element.querySelector('.pp-btn-open'));
      element.querySelector('path-input')?.dispatchEvent(new CustomEvent('path-change', { detail: { value: '/work/here' } }));
      await waitFor(() => !openBtn.disabled, 'the open button to enable', 3000);
      openBtn.click();
      await settleWithin(promise, 1000);
      assert(launched.length === 1 && launched[0] === '/work/here',
        `the new window was given ${JSON.stringify(launched)}, want ["/work/here"]`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('under en-XA every state the picker draws is translated', async () => {
    const root = document.documentElement;
    const hadWindowMode = root.dataset.windowMode;
    const hadExternal = root.dataset.externalServer;
    const real = {
      getRecents: apiService.getRecents,
      checkProject: apiService.checkProject,
      openProject: apiService.openProject,
      newWindow: apiService.newWindow,
      createProject: apiService.createProject,
    };
    const w = /** @type {any} */ (window);
    const realShowModal = w.showModal;
    /** @type {any[]} */
    const modals = [];
    const modalAnswer = true;
    const chip = document.createElement('button');
    chip.id = 'project-path-chip';
    chip.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    document.body.appendChild(chip);
    /** @type {(() => void)[]} */
    const cleanups = [];
    try {
      await underPseudoLocale('test-project-picker', async () => {
        /** @type {string[]} */
        const raw = [];
        /**
         * @param {Element} el
         * @param {string} where
         * @param {string} [skip]
         */
        const collect = (el, where, skip = '.pp-recent-item') => {
          const shown = shownStrings(el, skip);
          assert(shown.length >= 1, `nothing shown (${where})`);
          for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
        };
        /**
         * @param {unknown} s
         * @param {string} where
         */
        const check = (s, where) => {
          assert(typeof s === 'string' && s.length > 0, `nothing to check (${where})`);
          if (!isPseudoLocalized(/** @type {string} */ (s))) raw.push(`${where}: ${s}`);
        };
        w.showModal = async (/** @type {any} */ opts) => { modals.push(opts); return modalAnswer; };

        // --- the shared panel, every default, every status ---
        // The validator answers every call with the current step's result,
        // not just the call the click made. The panel focuses its path input
        // 50ms after it is built (focusWhenShown), and that focus re-emits
        // path-change, so a second, debounced validation can start mid-step;
        // a stub that answered only the click's call left that one pending
        // forever and the status stuck on "checking".
        /** @type {any} */
        let next;
        const { element, cancel } = buildPickerPanel({
          recents: ['/1/2'],
          onNewWindow: () => {},
          validate: async () => {
            await null;
            if (next instanceof Error) throw next;
            return next;
          },
        });
        document.body.appendChild(element);
        cleanups.push(() => { cancel(); element.remove(); });
        collect(element, 'defaults');
        const recent = /** @type {HTMLElement} */ (element.querySelector('.pp-recent-item'));
        const status = /** @type {HTMLElement} */ (element.querySelector('.pp-status'));
        /**
         * @param {any} result - What the validator answers, or a rejection.
         * @returns {Promise<string|null>} The status it settled on.
         */
        const statusFor = async (result) => {
          next = result;
          recent.click();
          check(status.textContent, 'checking');
          const before = status.className;
          await waitFor(() => status.className !== before, 'the status to settle', 3000);
          return status.textContent;
        };
        check(await statusFor({ valid: true, current: true }), 'current project');
        check(await statusFor({ valid: false }), 'invalid');
        check(await statusFor({ valid: false, error: 'path not found', errorMessage: { key: 'path not found' } }),
          'invalid, as the server worded it');
        check(await statusFor(new Error('1')), 'check failed');
        // The Browse… button draws only under a native host, which this page
        // never has; its label is checked from the catalogue.
        check(t('Browse…'), 'browse');

        // --- the project picker: switching in place, then busy, then a failed open ---
        delete root.dataset.windowMode;
        delete root.dataset.externalServer;
        apiService.getRecents = async () => ({ paths: ['/1/2'] });
        apiService.checkProject = async (/** @type {string} */ p) => ({ valid: true, path: p });
        apiService.openProject = () => Promise.reject(new Error('1'));
        const busySession = /** @type {any} */ ({ busyConversationNames: async () => ['1'] });
        const switching = openProjectPicker('/1', busySession);
        let popup = /** @type {HTMLElement|null} */ (document.querySelector('.pp-panel-popup'));
        assert(!!popup, 'the switching picker never presented');
        collect(/** @type {HTMLElement} */ (popup), 'switching');
        await waitFor(() => popup?.querySelector('.pp-recent-item'), 'the recents to draw', 3000);
        /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (popup).querySelector('.pp-recent-item')).click();
        await switching;
        endProjectOpen();
        const confirm = modals.find((m) => m.type === 'confirm');
        assert(!!confirm, 'switching with busy work asked nothing');
        check(confirm.title, 'busy title');
        check(confirm.message, 'busy message');
        check(confirm.confirmText, 'busy confirm');
        check(confirm.cancelText, 'busy cancel');
        const openAlert = modals.find((m) => m.type === 'alert');
        assert(!!openAlert, 'a failed open showed no alert');
        check(openAlert.title, 'open failed');
        modals.length = 0;

        // --- desktop, switching: a new window is the only way ---
        root.dataset.windowMode = '1';
        apiService.getRecents = async () => ({ paths: [] });
        void openProjectPicker('/1', null);
        popup = document.querySelector('.pp-panel-popup');
        assert(!!popup, 'the new-window picker never presented');
        collect(/** @type {HTMLElement} */ (popup), 'switching to a new window');
        closePopupById('project-picker');
        await new Promise((r) => setTimeout(r, 0));

        // --- desktop, empty window: both buttons, and a failed new window ---
        apiService.newWindow = () => Promise.reject(new Error('1'));
        void openProjectPicker('', null);
        popup = document.querySelector('.pp-panel-popup');
        assert(!!popup, 'the empty-window picker never presented');
        collect(/** @type {HTMLElement} */ (popup), 'empty window');
        const newWindowBtn = /** @type {HTMLButtonElement|null} */ (popup?.querySelector('.pp-btn-newwindow') ?? null);
        assert(!!newWindowBtn, 'the empty-window picker offered no new window');
        popup?.querySelector('path-input')?.dispatchEvent(new CustomEvent('path-change', { detail: { value: '/1' } }));
        await waitFor(() => newWindowBtn && !newWindowBtn.disabled, 'the new-window button to enable', 3000);
        /** @type {HTMLButtonElement} */ (newWindowBtn).click();
        await waitFor(() => modals.some((m) => m.type === 'alert'), 'an alert for the failed new window', 3000);
        check(modals.find((m) => m.type === 'alert').title, 'new window failed');
        modals.length = 0;
        closePopupById('project-picker');
        await new Promise((r) => setTimeout(r, 0));

        // --- the new-folder panel: defaults, both refusals, a failed create ---
        apiService.createProject = () => Promise.reject(new Error('1'));
        openNewProjectPanel([]);
        const made = /** @type {HTMLElement|null} */ (document.querySelector('.pp-panel-popup'));
        assert(!!made, 'the new-folder panel never presented');
        cleanups.push(() => closePopupById('new-project'));
        collect(/** @type {HTMLElement} */ (made), 'new folder');
        const nameEl = /** @type {HTMLInputElement} */ (made?.querySelector('.pp-name-input'));
        const madeStatus = /** @type {HTMLElement} */ (made?.querySelector('.pp-status'));
        for (const name of ['..', '1/2']) {
          nameEl.value = name;
          nameEl.dispatchEvent(new Event('input'));
          check(madeStatus.textContent, `folder name ${name}`);
        }
        nameEl.value = '1';
        nameEl.dispatchEvent(new Event('input'));
        /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (made).querySelector('.pp-btn-open')).click();
        await waitFor(() => modals.some((m) => m.type === 'alert'), 'an alert for the failed create', 3000);
        endProjectOpen();
        check(modals.find((m) => m.type === 'alert').title, 'create failed');

        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      for (const fn of cleanups) fn();
      closePopupById('project-picker');
      closePopupById('new-project');
      endProjectOpen();
      w.showModal = realShowModal;
      Object.assign(apiService, real);
      chip.remove();
      if (hadWindowMode === undefined) delete root.dataset.windowMode;
      else root.dataset.windowMode = hadWindowMode;
      if (hadExternal === undefined) delete root.dataset.externalServer;
      else root.dataset.externalServer = hadExternal;
    }
  });

  await run('under en-XA the opening overlay names the folder in the UI language', async () => {
    // The request is held open while the line is read, then refused, which
    // takes the overlay down without the reload a successful open schedules.
    /** @type {string} */
    let line = '';
    try {
      await underPseudoLocale('project-opening-test', async () => {
        await openProjectInWindow('/1/2/', async () => {
          const message = document.querySelector('.loading-overlay[data-loading-overlay="opening-project"] .loading-overlay__message');
          assert(!!message, 'the opening overlay is on screen while the request is in flight');
          line = message?.textContent || '';
          throw new Error('7');
        }).catch((/** @type {any} */ error) => {
          assert(error?.message === '7', `the refusal is rethrown, got ${JSON.stringify(error?.message)}`);
        });
      });
    } finally {
      endProjectOpen();
    }
    assert(line.includes('2') && !line.includes('1'), `the line names the folder, not its path, got ${JSON.stringify(line)}`);
    assert(isPseudoLocalized(line), `plain English under en-XA: ${JSON.stringify(line)}`);
  });

  await run('under en-XA the busy confirm names an untitled conversation in the UI language', async () => {
    const root = document.documentElement;
    const hadWindowMode = root.dataset.windowMode;
    const hadExternal = root.dataset.externalServer;
    const real = { getRecents: apiService.getRecents, checkProject: apiService.checkProject };
    const w = /** @type {any} */ (window);
    const realShowModal = w.showModal;
    /** @type {any[]} */
    const modals = [];
    const chip = document.createElement('button');
    chip.id = 'project-path-chip';
    chip.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    document.body.appendChild(chip);
    let message = '';
    try {
      await underPseudoLocale('test-project-picker-busy', async () => {
        // Declined, so nothing is opened.
        w.showModal = async (/** @type {any} */ opts) => { modals.push(opts); return false; };
        delete root.dataset.windowMode;
        delete root.dataset.externalServer;
        apiService.getRecents = async () => ({ paths: ['/1/2'] });
        apiService.checkProject = async (/** @type {string} */ p) => ({ valid: true, path: p });
        const busySession = /** @type {any} */ ({ busyConversationNames: async () => ['Untitled 3', '4'] });
        const switching = openProjectPicker('/1', busySession);
        const popup = /** @type {HTMLElement|null} */ (document.querySelector('.pp-panel-popup'));
        assert(!!popup, 'the switching picker never presented');
        await waitFor(() => popup?.querySelector('.pp-recent-item'), 'the recents to draw', 3000);
        /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (popup).querySelector('.pp-recent-item')).click();
        await switching;
        message = modals.find((m) => m.type === 'confirm')?.message || '';
      });
    } finally {
      closePopupById('project-picker');
      endProjectOpen();
      w.showModal = realShowModal;
      Object.assign(apiService, real);
      chip.remove();
      if (hadWindowMode === undefined) delete root.dataset.windowMode;
      else root.dataset.windowMode = hadWindowMode;
      if (hadExternal === undefined) delete root.dataset.externalServer;
      else root.dataset.externalServer = hadExternal;
    }
    assert(message.includes('3') && message.includes('4'), `the confirm lists both, got ${JSON.stringify(message)}`);
    assert(isPseudoLocalized(message), `plain English under en-XA: ${JSON.stringify(message)}`);
  });

  return { passed, failed, errors };
}
