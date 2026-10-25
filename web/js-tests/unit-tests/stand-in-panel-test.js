//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the panel a stand-in window shows in place of the welcome.
 *
 * A desktop window that cannot show what it is for — a server by URL that does
 * not answer, a locked project — is an empty window's page, opened with
 * `?standIn=` (cmd/juggler-app/stand_in.go). What it pins:
 *
 *   1. A window that is no stand-in is the ordinary welcome, and never asks.
 *   2. A stand-in says what the app tells it, as the app's messages, with the
 *      two ways out as buttons, and never flashes the welcome first.
 *   3. "Try again" says it is trying, and, when it still cannot, says that and
 *      can be pressed again; when it can, it stays down while the real window
 *      takes this one's place.
 *   4. "Open a local window instead" leaves the ordinary welcome where the
 *      stand-in was.
 *   5. A window asked after it stopped standing in is the ordinary welcome.
 *   6. A locked project's explanation keeps its lines, and can be selected — it
 *      names a file the reader may have to delete.
 *   7. Under en-XA every state is translated.
 *
 * The app is a stub client handed to the overlay; the session is a stub too.
 * @module unit-tests/stand-in-panel-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import apiService from '../../js/services/api.js';
import providersCache from '../../js/services/providers-cache.js';
import '../../js/components/no-project-overlay.js';

// The app's messages, exactly as cmd/juggler-app writes them: the catalogue
// keys the page translates them by.
const UNREACHABLE_TITLE = "Can't reach the server";
const UNREACHABLE_MESSAGE = 'Juggler could not connect to {url}.\n\n'
  + 'Check that the server is running and that this computer can reach it. '
  + 'A server answers only on its own machine until LAN access is turned on in its Connectivity settings.';
const LOCKED_TITLE = 'Project locked';
const LOCKED_MESSAGE = 'This project is locked by another process, but Juggler could not connect to the session that holds it.\n\n'
  + 'The lock file is:\n{path}\n\n'
  + 'This usually clears by itself within a few seconds, while the previous session finishes shutting down — try again first. '
  + 'If it persists, and you are sure no other Juggler process is running for this project, delete that file and start again.';

/**
 * @param {string} url - The server it stands in for
 * @returns {import('../../js/services/stand-in.js').StandIn} What the app says for it
 */
function unreachable(url) {
  return { kind: 'unreachable', title: { key: UNREACHABLE_TITLE }, message: [{ key: UNREACHABLE_MESSAGE, params: { url } }] };
}

/**
 * @param {string} path - The lock file
 * @returns {import('../../js/services/stand-in.js').StandIn} What the app says for it
 */
function locked(path) {
  return { kind: 'locked', title: { key: LOCKED_TITLE }, message: [{ key: LOCKED_MESSAGE, params: { path } }] };
}

/**
 * A promise and the means to settle it, for a call the test answers when it
 * chooses.
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}} The promise and its resolver
 */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  const promise = /** @type {Promise<T>} */ (new Promise((r) => { resolve = r; }));
  return { promise, resolve };
}

/**
 * A stub of the app's side, counting what the panel asked of it.
 * @param {{requested?: boolean, standIn?: any}} [init] - What the app answers
 * @returns {any} The stub client
 */
function stubClient({ requested = true, standIn = unreachable('http://1:2') } = {}) {
  const client = {
    requested: () => requested,
    standIn,
    gets: 0,
    retries: 0,
    leaves: 0,
    /** @type {null | {promise: Promise<boolean>, resolve: (v: boolean) => void}} */
    retryAnswer: null,
    leaveAnswer: true,
    async get() {
      client.gets++;
      return client.standIn;
    },
    retry() {
      client.retries++;
      client.retryAnswer = deferred();
      return client.retryAnswer.promise;
    },
    async leave() {
      client.leaves++;
      if (client.leaveAnswer) client.standIn = { kind: '' };
      return client.leaveAnswer;
    },
  };
  return client;
}

/** @returns {any} A session with no project, as an empty window has. */
function emptySession() {
  return { projectPath: '', subscribe: () => () => {} };
}

/** @returns {Promise<void>} Once the overlay's promise chains off the stubs have run. */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.id = 'stand-in-panel-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  document.body.appendChild(container);
  const hadClass = document.body.classList.contains('no-project');

  const realGetRecents = apiService.getRecents;
  const realWaitForReady = providersCache.waitForReady;
  const realHasReceived = providersCache.hasReceived;
  apiService.getRecents = async () => ({ paths: [] });
  providersCache.waitForReady = async () => {};
  providersCache.hasReceived = () => false;

  /**
   * @param {any} client
   * @returns {Promise<any>} The overlay, mounted on an empty session.
   */
  const mount = async (client) => {
    const overlay = /** @type {any} */ (document.createElement('no-project-overlay'));
    overlay.standInClient = client;
    container.appendChild(overlay);
    overlay.setSession(emptySession());
    return overlay;
  };

  /**
   * @param {any} overlay - The mounted overlay
   * @returns {HTMLButtonElement|null} Its "Try again" button
   */
  const retryButton = (overlay) => overlay.querySelector('.np-stand-in-retry');

  try {
    // --- 1: no stand-in, no question ---------------------------------------
    {
      const client = stubClient({ requested: false });
      const overlay = await mount(client);
      await settle();
      assert(!!overlay.querySelector('.np-open'), 'a window that is no stand-in lost its welcome');
      assert(client.gets === 0, 'a window the app did not open as a stand-in asked whether it was one');
      overlay.remove();
    }
    passed++;

    // --- 2: a stand-in says what the app tells it ---------------------------
    {
      const client = stubClient({ standIn: unreachable('http://devbox:8080') });
      const overlay = await mount(client);
      assert(!overlay.querySelector('.np-open'),
        'the welcome was drawn before the app said what the window stands in for');
      await settle();
      const panel = overlay.querySelector('[data-stand-in="unreachable"]');
      assert(!!panel, `no unreachable-server panel was drawn: ${overlay.innerHTML}`);
      assert(!overlay.querySelector('.np-open'), 'a stand-in also offered the welcome');
      assert(!!overlay.querySelector('.onboarding-logo'), 'the stand-in panel lost the logo');
      assert(overlay.querySelector('h1')?.textContent === UNREACHABLE_TITLE,
        `heading = "${overlay.querySelector('h1')?.textContent}"`);
      const text = overlay.textContent || '';
      assert(text.includes('Juggler could not connect to http://devbox:8080.'),
        'the explanation does not name the server');
      assert(overlay.querySelectorAll('.np-stand-in-detail').length === 2,
        'each paragraph of the explanation should be its own');
      assert(retryButton(overlay)?.textContent === 'Try again', 'no "Try again" button');
      assert(overlay.querySelector('.np-stand-in-leave')?.textContent === 'Open a local window instead',
        'no way out to a local window');
      overlay.remove();
    }
    passed++;

    // --- 3: trying again ------------------------------------------------------
    {
      const client = stubClient();
      const overlay = await mount(client);
      await settle();
      const button = /** @type {HTMLButtonElement} */ (retryButton(overlay));
      button.click();
      assert(client.retries === 1, 'Try again did not ask the app');
      assert(button.disabled && button.textContent === 'Trying…',
        `while trying, the button should say so and be disabled; got "${button.textContent}" disabled=${button.disabled}`);
      button.click();
      assert(client.retries === 1, 'a second press while trying asked again');

      client.retryAnswer?.resolve(false);
      await settle();
      assert(!button.disabled && button.textContent === 'Try again', 'after a failed try the button stayed down');
      const status = /** @type {HTMLElement|null} */ (overlay.querySelector('.np-stand-in-status'));
      assert(!!status && !status.hidden && (status.textContent || '').includes('still'),
        `a failed try said nothing: "${status?.textContent}"`);

      button.click();
      assert(status?.hidden === true, 'the old verdict stayed up during the next try');
      client.retryAnswer?.resolve(true);
      await settle();
      assert(button.disabled, 'the button came back up while the real window takes this one\'s place');
      overlay.remove();
    }
    passed++;

    // --- 4: the way out -------------------------------------------------------
    {
      const client = stubClient();
      const overlay = await mount(client);
      await settle();
      /** @type {HTMLButtonElement} */ (overlay.querySelector('.np-stand-in-leave')).click();
      await settle();
      assert(client.leaves === 1, 'the way out did not ask the app');
      assert(!overlay.querySelector('[data-stand-in]'), 'the stand-in panel stayed after leaving');
      assert(!!overlay.querySelector('.np-open'), 'leaving did not leave the ordinary welcome');
      overlay.remove();
    }
    passed++;

    // --- 5: no longer one -----------------------------------------------------
    {
      const client = stubClient({ standIn: { kind: '' } });
      const overlay = await mount(client);
      await settle();
      assert(client.gets === 1, 'the app was not asked');
      assert(!!overlay.querySelector('.np-open'), 'a window no longer standing in did not get the welcome');
      overlay.remove();
    }
    passed++;

    // --- 6: a locked project ---------------------------------------------------
    {
      const client = stubClient({ standIn: locked('/p/.juggler/juggler.lock') });
      const overlay = await mount(client);
      await settle();
      assert(!!overlay.querySelector('[data-stand-in="locked"]'), 'no locked-project panel was drawn');
      assert(overlay.querySelector('h1')?.textContent === LOCKED_TITLE, 'wrong heading for a locked project');
      const details = [...overlay.querySelectorAll('.np-stand-in-detail')];
      assert(details.length === 3, `want three paragraphs, got ${details.length}`);
      assert(!!details[1].querySelector('br') && (details[1].textContent || '').includes('/p/.juggler/juggler.lock'),
        'the lock file should be on a line of its own');
      assert(getComputedStyle(details[1]).userSelect === 'text'
        || getComputedStyle(details[1]).webkitUserSelect === 'text',
      'the lock file path cannot be selected to copy');

      /** @type {HTMLButtonElement} */ (retryButton(overlay)).click();
      client.retryAnswer?.resolve(false);
      await settle();
      const status = overlay.querySelector('.np-stand-in-status')?.textContent || '';
      assert(status.includes('locked'), `a failed try on a locked project should say it still is: "${status}"`);
      overlay.remove();
    }
    passed++;

    // --- 7: en-XA --------------------------------------------------------------
    await underPseudoLocale('test-stand-in', async () => {
      /** @type {string[]} */
      const raw = [];
      /**
       * @param {Element} root
       * @param {string} where
       */
      const collect = (root, where) => {
        const shown = shownStrings(root, '.onboarding-logo, .np-stand-in-detail');
        assert(shown.length >= 1, `nothing shown (${where})`);
        for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
        // The explanation is one message drawn as several paragraphs, and the
        // pseudo-locale brackets the message, so it is judged whole.
        const explanation = [...root.querySelectorAll('.np-stand-in-detail')]
          .map((p) => p.textContent).join('\n\n');
        if (!isPseudoLocalized(explanation)) raw.push(`${where}, explanation: ${explanation}`);
      };
      for (const standIn of [unreachable('1'), locked('2')]) {
        const client = stubClient({ standIn });
        const overlay = await mount(client);
        await settle();
        collect(overlay, standIn.kind);
        /** @type {HTMLButtonElement} */ (retryButton(overlay)).click();
        collect(overlay, `${standIn.kind}, trying`);
        client.retryAnswer?.resolve(false);
        await settle();
        collect(overlay, `${standIn.kind}, still`);
        overlay.remove();
      }
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (error) {
    failed++;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    apiService.getRecents = realGetRecents;
    providersCache.waitForReady = realWaitForReady;
    providersCache.hasReceived = realHasReceived;
    document.body.classList.toggle('no-project', hadClass);
    container.remove();
  }

  return { passed, failed, errors };
}
