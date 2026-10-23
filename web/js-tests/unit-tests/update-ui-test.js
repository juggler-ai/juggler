//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the header update button and the update dialog draw their text
 * in the UI language.
 *
 * Both are driven with stand-in view-models: the button's two sources are set
 * on the instance (its seeding and frame-throttled render are replaced, so
 * nothing is fetched and no frame is awaited), and the dialog is opened
 * directly with each model. The updater itself is never reached.
 * @module unit-tests/update-ui-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/update-button.js';
import '../../js/components/update-notice.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * A view-model for the dialog, with every field the merged model carries.
 * @param {object} over - Fields that differ from an idle, absent updater.
 * @returns {any} The view-model.
 */
function vmOf(over) {
  return {
    present: false,
    updaterState: null,
    pct: null,
    error: null,
    errorStage: null,
    currentVersion: '',
    targetVersion: '',
    appVersion: null,
    appManagedServer: true,
    notice: null,
    serverUpdateAvailable: true,
    upToDate: false,
    ...over,
  };
}

/** An external download link whose label the manifest leaves out. */
const LINK = { url: 'https://juggler.studio/' };

/**
 * Every dialog state, with the selector for what it draws as data.
 * @type {Array<{where: string, vm: any, skip?: string}>}
 */
const NOTICE_STATES = [
  { where: 'up to date, version known', vm: vmOf({ upToDate: true, currentVersion: '9.8.7', serverUpdateAvailable: false }) },
  { where: 'up to date, version unknown', vm: vmOf({ upToDate: true, serverUpdateAvailable: false }) },
  { where: 'available, version known', vm: vmOf({ targetVersion: '9.8.7', notice: { id: '1', actions: [LINK] } }) },
  { where: 'available, version unknown', vm: vmOf({ notice: { id: '2', actions: [LINK] } }) },
  { where: 'available, required', vm: vmOf({ notice: { id: '3', severity: 'required' } }) },
  { where: 'manifest title', vm: vmOf({ notice: { id: '4', title: '1.2.3' } }), skip: '.update-notice__title' },
  {
    where: 'outside server',
    vm: vmOf({ present: true, updaterState: 'available', appManagedServer: false, appVersion: '9.8.7', currentVersion: '9.8.6', targetVersion: '9.8.7' }),
  },
  ...['check', 'download', 'verify', 'install', 'restart', null].flatMap((errorStage) => [
    { where: `error ${errorStage}`, vm: vmOf({ present: true, updaterState: 'error', errorStage, error: '42', notice: { id: '5', actions: [LINK] } }), skip: '.update-notice__status-detail' },
    { where: `error ${errorStage}, no detail`, vm: vmOf({ present: true, updaterState: 'error', errorStage }) },
  ]),
  { where: 'downloading 42%', vm: vmOf({ present: true, updaterState: 'downloading', pct: 42, targetVersion: '9.8.7' }) },
  { where: 'downloading, no percent', vm: vmOf({ present: true, updaterState: 'downloading' }) },
  { where: 'verifying', vm: vmOf({ present: true, updaterState: 'verifying' }) },
  { where: 'installing', vm: vmOf({ present: true, updaterState: 'installing' }) },
  { where: 'ready', vm: vmOf({ present: true, updaterState: 'ready', targetVersion: '9.8.7' }) },
  { where: 'idle updater', vm: vmOf({ present: true, updaterState: 'idle' }) },
  // The package manager's name is data, so digits stand in for it here.
  { where: 'managed install', vm: vmOf({ managedBy: '42', targetVersion: '9.8.7', notice: { id: '6', actions: [LINK] } }) },
];

/**
 * Every button state: the server notice alone, then each updater state.
 * @type {Array<{where: string, server: any, updater: any}>}
 */
const BUTTON_STATES = [
  { where: 'server notice', server: { updateAvailable: true, latestVersion: '9.8.7' }, updater: { present: false } },
  { where: 'available', server: {}, updater: { present: true, state: 'available', version: '9.8.7' } },
  { where: 'downloading', server: {}, updater: { present: true, state: 'downloading', written: 42, total: 100 } },
  { where: 'verifying', server: {}, updater: { present: true, state: 'verifying' } },
  { where: 'installing', server: {}, updater: { present: true, state: 'installing' } },
  { where: 'ready', server: {}, updater: { present: true, state: 'ready' } },
  { where: 'error, detail', server: {}, updater: { present: true, state: 'error', error: '42' } },
  { where: 'error, no detail', server: {}, updater: { present: true, state: 'error' } },
];

/**
 * An <update-button> that draws only when told to: no seeding, no scheduled
 * frame, no proactive kick and no dialog to keep in step.
 * @returns {any} The connected button.
 */
function quietButton() {
  const el = /** @type {any} */ (document.createElement('update-button'));
  el._seedServer = async () => {};
  el._seedUpdater = async () => {};
  el._scheduleRender = () => {};
  el._dialog = () => null;
  el._autoKicked = true;
  document.body.appendChild(el);
  return el;
}

/**
 * Draw the button in one state.
 * @param {any} el - A {@link quietButton}.
 * @param {{server: any, updater: any}} state
 */
function drawButton(el, state) {
  el._server = state.server;
  el._updater = state.updater;
  el.render();
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
   * @param {() => Promise<void>|void} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${/** @type {any} */ (e)?.message || e}\n${/** @type {any} */ (e)?.stack || ''}`);
    }
  };

  await test('English wording is unchanged', () => {
    const btn = quietButton();
    const notice = /** @type {any} */ (document.createElement('update-notice'));
    document.body.appendChild(notice);
    try {
      drawButton(btn, { server: {}, updater: { present: true, state: 'ready' } });
      const label = btn.querySelector('.update-btn__label').textContent;
      assert(label === 'Update & restart...', `ready label: ${JSON.stringify(label)}`);
      drawButton(btn, { server: {}, updater: { present: true, state: 'error' } });
      const title = btn.querySelector('.update-btn').title;
      assert(title === 'Update failed — click for details', `error title: ${JSON.stringify(title)}`);
      drawButton(btn, { server: {}, updater: { present: true, state: 'error', error: 'disk full' } });
      assert(btn.querySelector('.update-btn').title === 'disk full', 'the updater\'s own error is shown as given');

      notice.open(vmOf({ present: true, updaterState: 'downloading', pct: 41.6 }));
      const progress = notice.querySelector('.update-notice__status-text').textContent;
      assert(progress === 'Downloading update… 42%', `progress: ${JSON.stringify(progress)}`);
      notice.close();
      notice.open(vmOf({ present: true, updaterState: 'available', appManagedServer: false, appVersion: 'v2.0.0', currentVersion: 'v1.0.0' }));
      const skew = notice.querySelector('.update-notice__skew').textContent;
      assert(skew === "You're connected to a Juggler server started outside the app (v1.0.0). "
        + "Updating the app won't update that server — restart it to update.", `skew: ${JSON.stringify(skew)}`);
      notice.close();
      notice.open(vmOf({ present: true, updaterState: 'ready' }));
      const restart = [...notice.querySelectorAll('.update-notice__button')].map((b) => b.textContent);
      assert(JSON.stringify(restart) === JSON.stringify(['Later', 'Update & restart']), `ready buttons: ${JSON.stringify(restart)}`);
      notice.close();
      notice.open(vmOf({ notice: { id: 'm', title: 'Juggler 2 is here', actions: [{ label: 'Get it', url: 'https://juggler.studio/' }] } }));
      assert(notice.querySelector('.update-notice__title').textContent === 'Juggler 2 is here', 'the manifest title is drawn as given');
      const labels = [...notice.querySelectorAll('.update-notice__button')].map((b) => b.textContent);
      assert(labels.includes('Get it'), `the manifest's action label is drawn as given: ${JSON.stringify(labels)}`);
    } finally {
      notice.close();
      notice.remove();
      btn.remove();
    }
  });

  await test('a managed install points at its package manager and offers no install', () => {
    const btn = quietButton();
    const notice = /** @type {any} */ (document.createElement('update-notice'));
    document.body.appendChild(notice);
    try {
      // Even with an updater that thinks it could install, the server's word wins.
      btn._updater = { present: true, state: 'available', version: '9.8.7' };
      btn._server = { updateAvailable: true, latestVersion: '9.8.7', managedBy: 'Nix' };
      const vm = btn._viewModel();
      assert(vm.managedBy === 'Nix', `managedBy reaches the model: ${JSON.stringify(vm.managedBy)}`);
      assert(vm.present === false && vm.updaterState === null, `the updater is set aside: ${JSON.stringify(vm)}`);
      btn.render();
      assert(!btn.hidden, 'the button still says an update exists');

      notice.open(vmOf({
        managedBy: 'Nix',
        targetVersion: '9.8.7',
        notice: { id: 'm', severity: 'required', html: '<p><a href="https://x/">Download</a></p>', actions: [LINK] },
      }));
      const managed = notice.querySelector('.update-notice__managed');
      assert(managed && managed.textContent === 'Juggler is updated through Nix. Update it there to get this version.',
        `managed line: ${JSON.stringify(managed && managed.textContent)}`);
      assert(!notice.querySelector('.update-notice__body a'), 'the manifest\'s own download prose is not shown');
      const labels = [...notice.querySelectorAll('.update-notice__button')].map((b) => b.textContent);
      assert(JSON.stringify(labels) === JSON.stringify(['OK']), `managed buttons: ${JSON.stringify(labels)}`);
    } finally {
      notice.close();
      notice.remove();
      btn.remove();
    }
  });

  await test('en-XA: everything the button and dialog say is translated', async () => {
    /** @type {string[]} */
    const shown = [];
    const btn = quietButton();
    const notice = /** @type {any} */ (document.createElement('update-notice'));
    document.body.appendChild(notice);
    try {
      await underPseudoLocale('test-update-ui', () => {
        // A fresh button draws its template under the locale too.
        btn.remove();
        document.body.appendChild(btn);
        for (const state of BUTTON_STATES) {
          drawButton(btn, state);
          // The percentage stands alone in its own span: a number, not a message.
          // The updater's own error, as the title, is its text, not ours.
          const title = btn.querySelector('.update-btn').title;
          if (state.updater.error) assert(title === state.updater.error, `the updater's error is the title: ${JSON.stringify(title)}`);
          shown.push(...shownStrings(btn, '.update-btn__pct')
            .filter((s) => !state.updater.error || s !== state.updater.error)
            .map((s) => `button ${state.where}: ${s}`));
        }
        for (const { where, vm, skip } of NOTICE_STATES) {
          notice.open(vm);
          const strings = shownStrings(notice, skip);
          assert(strings.length >= 2, `the dialog drew its text (${where}), got ${JSON.stringify(strings)}`);
          shown.push(...strings.map((s) => `dialog ${where}: ${s}`));
          notice.close();
        }
      });
    } finally {
      notice.close();
      notice.remove();
      btn.remove();
    }
    const raw = shown.filter((s) => !isPseudoLocalized(s.slice(s.indexOf(': ') + 2)));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
