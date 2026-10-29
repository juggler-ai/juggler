//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the properties-panel helpers (`utils/properties-panel-helpers.js`):
 * every text the helpers draw on their own — the file-path row's buttons (file
 * and folder), the Pin and Show-on-Pinboard controls, the file right-click menu
 * and the notices its actions raise when the OS or the clipboard refuses —
 * follows the UI language.
 *
 * The `os` op is answered by a fetch stub with a failure, and the clipboard by
 * stubs that refuse, so nothing is opened, revealed, copied or pinned.
 * @module unit-tests/properties-panel-helpers-test
 */

import {
  addFilePath, createFileActions, createPinControl, createShowPinControl,
} from '../../js/utils/properties-panel-helpers.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import { clipboardUnavailableMessage } from '../../sdk/lib/clipboard.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * A stand-in pin type that takes any file, so the Pin button, control and menu
 * row are offered. Never mounted, and never asked to pin: nothing here clicks Pin.
 */
class TakesFiles {
  static MANIFEST = {
    id: 'pph-test-file',
    name: 'Files, for testing',
    version: '1.0.0',
    description: 'Takes any file so the Pin controls are offered',
  };

  /**
   * @param {{kind?: string, path?: string}} source - The source offered.
   * @returns {boolean} True for a file with a path.
   */
  static canPinSource(source) {
    return source?.kind === 'file' && !!source.path;
  }

  /**
   * @param {{path?: string}} source - The source offered.
   * @returns {{path: string}} The config to pin it with.
   */
  static configFromSource(source) {
    return { path: source.path || '' };
  }
}

/** Close and remove every `<modal-dialog>`, so the next notice is the only one. */
function clearDialogs() {
  document.querySelectorAll('modal-dialog').forEach((el) => {
    /** @type {any} */ (el).close?.(null);
    el.remove();
  });
}

/**
 * Wait for the notice an action raises, then read and dismiss it. The notice
 * fills its title and message in the same call that marks it a notice.
 * @param {string} what - The action that should have raised.
 * @returns {Promise<string[]>} What the notice shows.
 */
async function noticeStrings(what) {
  const notice = await waitFor(() => document.querySelector('modal-dialog.is-notice'), `a notice after ${what}`);
  const shown = shownStrings(notice);
  clearDialogs();
  return shown;
}

/**
 * Run the properties-panel-helpers test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('en-XA: the helpers draw no plain English in any state', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    pinboardItemRegistry.reset();
    pinboardItemRegistry.registerClass(TakesFiles, { extensionId: 'test' });
    const originalFetch = window.fetch;
    const clip = /** @type {any} */ (navigator.clipboard);
    clearDialogs();
    try {
      await underPseudoLocale('properties-panel-helpers-test', async () => {
        // Every `os` op fails, with a reason that has no letters in it.
        window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
          if (String(input).includes('/ops/call')) {
            return new window.Response(JSON.stringify({ success: false, error: '9' }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          }
          return originalFetch(input, init);
        });

        /** @type {{where: string, text: string}[]} */
        const shown = [];
        const collect = (/** @type {string} */ where, /** @type {string[]} */ strings) => {
          for (const text of strings) shown.push({ where, text });
        };

        // The file-path row, with a pin button. The path and its annotation are
        // data standing alone, so they are skipped.
        const row = document.createElement('div');
        host.appendChild(row);
        addFilePath(row, '/1/2', '3', { pin: '/1/2' });
        assert(!!row.querySelector('.properties-panel-filepath-actions button[title]'), 'the file row drew no buttons');
        collect('file row', shownStrings(row, '.properties-panel-filepath, .properties-panel-filepath-info'));

        // The same row for a folder: no Open, still a pin.
        const folder = createFileActions('/1', { pin: '/1', directory: true });
        assert(!!folder, 'a folder drew no actions');
        if (folder) {
          host.appendChild(folder);
          collect('folder row', shownStrings(folder));
        }

        // The panel controls: pin, and show an existing pin.
        const pinControl = createPinControl({ kind: 'file', path: '/1/2', presentation: 'live' });
        assert(!!pinControl, 'no Pin control was drawn');
        if (pinControl) collect('pin control', shownStrings(pinControl));
        const showControl = createShowPinControl({ pin: '4', type: 'pph-test-file', config: {} });
        assert(!!showControl, 'no Show-on-Pinboard control was drawn');
        if (showControl) collect('show-pin control', shownStrings(showControl));

        // The right-click menu on a file inside a removable context item.
        const item = document.createElement('div');
        item.setAttribute('data-context-item-id', '5');
        /** @type {any} */ (item)._jugglerRemoveFromContext = () => {};
        const fileRow = document.createElement('div');
        fileRow.setAttribute('data-file-path', '/1/2');
        item.appendChild(fileRow);
        host.appendChild(item);
        const menu = resolveMenu(fileRow);
        assert(!!menu, 'the file row raised no menu');
        const rows = (menu?.items || []).filter((i) => !i.separator);
        assert(rows.length === 5, `expected open/reveal/copy/pin/remove, got ${JSON.stringify(rows.map((i) => i.label))}`);
        collect('file menu', rows.map((i) => i.label || ''));

        // Every failure notice: the row's Open button, the reveal button, and
        // the menu's Open / Reveal / Copy path rows.
        const open = /** @type {HTMLButtonElement|null} */ (row.querySelector('.properties-panel-filepath-btn'));
        assert(!!open, 'no Open button');
        open?.click();
        collect('open button notice', await noticeStrings('Open'));

        const reveal = /** @type {HTMLButtonElement|null} */ (row.querySelector('reveal-button button'));
        assert(!!reveal, 'no reveal button');
        reveal?.click();
        collect('reveal button notice', await noticeStrings('Reveal'));

        rows[0].onClick?.();
        collect('menu open notice', await noticeStrings('menu Open'));
        rows[1].onClick?.();
        collect('menu reveal notice', await noticeStrings('menu Reveal'));

        // The clipboard refuses by both routes; its own explanation is not this
        // file's text, so it is replaced by a digit before the check.
        if (clip) clip.writeText = async () => { throw new Error('refused'); };
        document.execCommand = () => false;
        rows[2].onClick?.();
        const reason = clipboardUnavailableMessage();
        collect('menu copy notice', (await noticeStrings('menu Copy path')).map((s) => s.replace(reason, '9')));

        const raw = shown.filter((s) => !isPseudoLocalized(s.text));
        assert(shown.length >= 15, `expected at least 15 strings, found ${shown.length}`);
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      window.fetch = originalFetch;
      if (Object.prototype.hasOwnProperty.call(document, 'execCommand')) delete /** @type {any} */ (document).execCommand;
      if (clip && Object.prototype.hasOwnProperty.call(clip, 'writeText')) delete clip.writeText;
      clearDialogs();
      host.remove();
      pinboardItemRegistry.reset();
    }
  });

  return { passed, failed, errors };
}
