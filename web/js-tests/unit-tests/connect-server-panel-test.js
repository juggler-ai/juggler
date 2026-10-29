//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the "Connect to a server" panel.
 *
 * It hands what was typed to the desktop app and gets out of the way; when the
 * app refuses the address, the reason stays in the panel beside the field, and
 * the field stays filled to fix. It is offered only where it can work: never in
 * a browser tab, and in a window already on a server by URL it says where to
 * connect from instead of taking an address the app will refuse.
 *
 * This page has no native host, so the panel is opened with one declared and a
 * stub standing in for the app.
 * @module unit-tests/connect-server-panel-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { closePopupById } from '../../js/utils/popup-manager.js';
import { canConnectToServer, openConnectServerPanel } from '../../js/components/connect-server-panel.js';

/** @returns {HTMLElement|null} The panel, while it is presented. */
const panelEl = () => /** @type {HTMLElement|null} */ (document.querySelector('.pp-panel-popup[aria-label]'));

/** @returns {HTMLInputElement} The address field of the presented panel. */
const addressEl = () => /** @type {HTMLInputElement} */ (panelEl()?.querySelector('.pp-address-input'));

/** @returns {HTMLButtonElement} The panel's Connect button. */
const connectBtn = () => /** @type {HTMLButtonElement} */ (panelEl()?.querySelector('.pp-btn-open'));

/**
 * Type into the address field as a person would, so its input listener runs.
 * @param {string} value
 * @returns {void}
 */
function type(value) {
  const el = addressEl();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Let a resolved-promise chain off a stub land. No timer, so nothing to size
 * against a deadline.
 * @returns {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/**
 * A stand-in for the app's connect action, recording what it was asked for and
 * answering however the case needs.
 * @param {(address: string) => Promise<unknown>} [answer]
 * @returns {{asked: string[], connect: (address: string) => Promise<unknown>}} The stub and its record
 */
function stubApp(answer = async () => true) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    connect: (address) => {
      asked.push(address);
      return answer(address);
    },
  };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const root = document.documentElement;
  const hadExternal = root.dataset.externalServer;

  // The header's read-only project path, which the panel is placed under: the
  // panel is opened from a menu, so the path is where it sits, not its trigger.
  const chip = document.createElement('span');
  chip.id = 'project-path-chip';
  chip.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(chip);

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      delete root.dataset.externalServer;
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      closePopupById('connect-server');
      // Each presentation unregisters only once its dismissal has settled.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  try {
    await run('offered only in a desktop window on its own server', async () => {
      assert(canConnectToServer(true), 'a desktop window on its own server should be able to connect');
      assert(!canConnectToServer(false), 'a browser tab has no app to open a window');
      root.dataset.externalServer = '1';
      assert(!canConnectToServer(true), 'a window on a server by URL is refused by the app, so must not offer it');
    });

    await run('a browser tab is offered nothing', async () => {
      const app = stubApp();
      await openConnectServerPanel({ connect: app.connect, nativeHost: false });
      assert(!panelEl(), 'a panel was presented with no native host to connect through');
    });

    await run('the typed address goes to the app, and the panel gets out of the way', async () => {
      const app = stubApp();
      await openConnectServerPanel({ connect: app.connect, nativeHost: true });
      const panel = panelEl();
      assert(!!panel, 'the panel never presented');
      assert(panel?.getAttribute('role') === 'dialog' && !!panel?.getAttribute('aria-label'),
        'the panel is a named dialog');
      assert(!chip.hasAttribute('aria-expanded'), 'the read-only path it sits under is marked as its trigger');
      assert(connectBtn().disabled, 'Connect was enabled with nothing typed');

      type('  devbox:8080 ');
      assert(!connectBtn().disabled, 'Connect stayed disabled with an address typed');
      addressEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();

      assert(JSON.stringify(app.asked) === '["devbox:8080"]', `the app was asked for ${JSON.stringify(app.asked)}`);
      assert(!panelEl(), 'the panel stayed up after the app took the request');
    });

    await run('a refused address stays in the field, with the reason beside it', async () => {
      const app = stubApp(async () => {
        throw new Error('HTTP 400: That is not a server address. Enter one like http://devbox:3939.');
      });
      await openConnectServerPanel({ connect: app.connect, nativeHost: true });
      type('ftp://devbox');
      connectBtn().click();
      await settle();

      assert(app.asked.length === 1, `the app was asked ${app.asked.length} times`);
      assert(!!panelEl(), 'the panel closed on a refusal, losing what was typed');
      assert(addressEl().value === 'ftp://devbox', `the field was changed to "${addressEl().value}"`);
      const status = /** @type {HTMLElement} */ (panelEl()?.querySelector('.pp-status'));
      assert(status.textContent === 'That is not a server address. Enter one like http://devbox:3939.',
        `the reason shown was "${status.textContent}"`);
      assert(status.classList.contains('pp-status--invalid'), 'the reason is not marked as a problem');
      assert(!connectBtn().disabled, 'Connect stayed disabled, so the corrected address cannot be sent');

      type('devbox:8080');
      assert(status.textContent === '', 'the old reason outlived the edit that answers it');
    });

    await run('a window on a server by URL is told where to connect from', async () => {
      root.dataset.externalServer = '1';
      const app = stubApp();
      const opening = openConnectServerPanel({ connect: app.connect, nativeHost: true });
      await settle();
      const modal = /** @type {HTMLElement|null} */ (document.querySelector('modal-dialog'));
      assert(!!modal, 'no explanation was shown');
      const message = modal?.querySelector('.modal-message')?.textContent || '';
      assert(message.includes('new window'), `the explanation does not say where to go: "${message}"`);
      assert(!panelEl(), 'a field was offered that the app would refuse');
      /** @type {HTMLElement|null} */ (modal?.querySelector('.modal-button') ?? null)?.click();
      await opening;
      assert(app.asked.length === 0, 'the app was asked anyway');
    });

    await run('everything it says is translated', async () => {
      await underPseudoLocale('test-connect-server', async () => {
        await openConnectServerPanel({ connect: stubApp(async () => { throw new Error('1'); }).connect, nativeHost: true });
        const panel = /** @type {HTMLElement} */ (panelEl());
        assert(!!panel, 'the panel never presented');
        // The field's placeholder included.
        /** @type {string[]} */
        const raw = shownStrings(panel, '').filter((s) => !isPseudoLocalized(s));
        type('2');
        connectBtn().click();
        // What the status says while the app has the request.
        const pending = /** @type {HTMLElement} */ (panel.querySelector('.pp-status')).textContent || '';
        if (!isPseudoLocalized(pending)) raw.push(`pending: ${pending}`);
        await settle();
        closePopupById('connect-server');
        await new Promise((resolve) => setTimeout(resolve, 0));

        root.dataset.externalServer = '1';
        const opening = openConnectServerPanel({ nativeHost: true });
        await settle();
        const modal = /** @type {HTMLElement|null} */ (document.querySelector('modal-dialog'));
        assert(!!modal, 'no explanation was shown');
        for (const s of shownStrings(/** @type {HTMLElement} */ (modal), '')) {
          if (!isPseudoLocalized(s)) raw.push(`refusal: ${s}`);
        }
        /** @type {HTMLElement|null} */ (modal?.querySelector('.modal-button') ?? null)?.click();
        await opening;

        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    });
  } finally {
    closePopupById('connect-server');
    chip.remove();
    if (hadExternal === undefined) delete root.dataset.externalServer;
    else root.dataset.externalServer = hadExternal;
  }

  return { passed, failed, errors };
}
