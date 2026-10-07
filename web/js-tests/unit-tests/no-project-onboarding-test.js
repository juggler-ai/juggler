//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: what an app window with no project loaded offers.
 *
 * This panel is the first thing a new user sees, and three of its claims are
 * load-bearing enough to pin:
 *
 *   1. The ways into a project are BUTTONS. The state it replaces was five
 *      paragraphs of prose with the only controls hidden inside sentences,
 *      which is the least discoverable form there is.
 *   2. The provider line tells the truth and keeps telling it. It is silent
 *      until a settled snapshot arrives (a line drawn from the pre-compute
 *      connect seed says "nothing connected" to someone with three providers),
 *      and it follows later pushes rather than freezing on the first.
 *   3. Someone with recents is not a first-timer. They get their list and lose
 *      the explanation, which is the whole difference between the two states.
 *   4. The new-folder panel it opens can be dismissed again. It carries no
 *      Cancel of its own, so Escape and the outside click are the only way out.
 *   5. Opening a project holds the window: an overlay says so, and nothing can
 *      start a second open until the first has failed or the page reloads.
 *
 * The session is a stub: this pins the panel's own rules, not the project
 * switch that ends the state.
 * @module unit-tests/no-project-onboarding-test
 */

import { assert } from '../utilities/test-helpers.js';
import { closePopupById } from '../../js/utils/popup-manager.js';
import apiService from '../../js/services/api.js';
import wsService from '../../js/services/websocket.js';
import providersCache from '../../js/services/providers-cache.js';
import '../../js/components/no-project-overlay.js';
import { endProjectOpen, isOpeningProject, openProjectInWindow } from '../../js/components/project-opening.js';

/**
 * Minimal stand-in for the session surface the overlay reads: a project path
 * and a subscription it re-checks itself on.
 * @param {string} projectPath - Loaded project, or '' for the no-project state
 * @returns {any} Stub session with an `emit(type)` to drive its listeners
 */
function createStubSession(projectPath) {
  /** @type {Array<(event: any) => void>} */
  const listeners = [];
  return {
    projectPath,
    /**
     * @param {(event: any) => void} fn - Listener
     * @returns {() => void} Unsubscribe
     */
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /** @param {string} type - Event type to deliver */
    emit(type) {
      for (const fn of [...listeners]) fn({ type });
    },
  };
}

/**
 * A provider shaped the way the status line reads one: available, and with at
 * least one usable model. Both halves matter — a provider with no models is
 * configured but cannot answer, and the line must not call that connected.
 * @param {string} displayName - What the line should name it
 * @param {boolean} available - Whether it is usable
 * @param {number} models - How many models it offers
 * @returns {any} A provider record
 */
function provider(displayName, available, models = 1) {
  return {
    name: displayName.toLowerCase(),
    displayName,
    available,
    modelsWithContext: Array.from({ length: models }, (_, i) => ({ id: `m${i}` })),
  };
}

/**
 * Let the overlay's async work (recents fetch, provider settle) land. Both are
 * resolved-promise chains off stubs, so a microtask drain is the whole wait —
 * no timer, and nothing to size against a deadline.
 * @returns {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
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
  container.id = 'no-project-onboarding-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  document.body.appendChild(container);

  // The overlay toggles a class on the real <body> (the sidebar it hides is a
  // sibling, not a child), so leave that class as it was found.
  const hadClass = document.body.classList.contains('no-project');

  // Everything the panel reaches for outside itself, stubbed and restored.
  const realGetRecents = apiService.getRecents;
  const realWaitForReady = providersCache.waitForReady;
  const realGet = providersCache.get;
  const realHasReceived = providersCache.hasReceived;

  /** @type {string[]} */
  let recents = [];
  /** @type {any[]} */
  let providers = [];
  let received = false;

  apiService.getRecents = async () => ({ paths: recents });
  providersCache.waitForReady = async () => {};
  providersCache.get = () => /** @type {any} */ (providers);
  providersCache.hasReceived = () => received;

  try {
    // --- 1: the empty state shows, and offers a way out of it ---------------
    const overlay = /** @type {any} */ (document.createElement('no-project-overlay'));
    container.appendChild(overlay);
    const noProject = createStubSession('');
    overlay.setSession(noProject);
    await settle();

    assert(overlay.hidden === false, 'the overlay stayed hidden with no project loaded');
    assert(document.body.classList.contains('no-project'),
      'body.no-project was not set, so the sidebar still takes the room');
    assert(!!overlay.querySelector('.onboarding-logo'), 'no logo in the panel');
    assert(!!overlay.querySelector('.np-open'), 'no "open a folder" button');
    assert(!!overlay.querySelector('.np-new'), 'no "new folder" button — the reason a beginner '
      + 'had to leave for the Finder, make a folder, and come back');
    passed++;

    // --- 2: first run explains itself ---------------------------------------
    // No recents means nobody has opened anything here, so the panel says what
    // a project folder is rather than assuming the reader knows.
    const explainer = /** @type {HTMLElement|null} */ (overlay.querySelector('.np-explainer'));
    assert(!!explainer && !explainer.hidden,
      'the first-run explanation was missing or hidden with no recents to suggest otherwise');
    assert((overlay.querySelector('.np-heading')?.textContent || '').includes('Welcome'),
      'the first-run heading should welcome, got '
      + `"${overlay.querySelector('.np-heading')?.textContent}"`);
    passed++;

    // --- 3: silent until the providers have settled -------------------------
    // The connect seed arrives before anything is computed. Drawing from it
    // would tell someone with three providers that they have none.
    const line = /** @type {HTMLElement} */ (overlay.querySelector('.np-provider'));
    assert(line.textContent === '',
      `the provider line spoke before a settled snapshot: "${line.textContent}"`);
    passed++;

    // --- 4: it names what is connected --------------------------------------
    received = true;
    providers = [provider('Claude Code', true), provider('Anthropic', true)];
    wsService._emit('providers-update', providers);
    assert((line.textContent || '').includes('Claude Code'),
      `the provider line did not name the connected provider: "${line.textContent}"`);
    assert(!line.classList.contains('np-provider--none'),
      'the line was marked as having no provider while two were connected');
    passed++;

    // --- 5: and follows a later push rather than freezing -------------------
    // The cache publishes no change event of its own, so the line rides the
    // same feed the cache does. If that subscription is missing, this is where
    // it shows: the panel would still be claiming a provider that has gone.
    providers = [provider('Claude Code', false)];
    wsService._emit('providers-update', providers);
    assert(line.classList.contains('np-provider--none'),
      'the line kept claiming a provider after the push that removed it');
    assert(!!overlay.querySelector('.np-connect'),
      'no way to connect a provider from the panel that just said there was none');
    passed++;

    // --- 6: an unavailable provider is not a connected one ------------------
    providers = [provider('Anthropic', true, 0)];
    wsService._emit('providers-update', providers);
    assert(line.classList.contains('np-provider--none'),
      'a provider with no usable models was reported as connected, which is a wall at '
      + 'the first message rather than a warning before it');
    passed++;

    // --- 7: a project retires the whole thing -------------------------------
    const loaded = createStubSession('/tmp/project');
    overlay.setSession(loaded);
    assert(overlay.hidden === true, 'the overlay stayed up after a project was loaded');
    assert(!document.body.classList.contains('no-project'),
      'body.no-project survived the load, so the sidebar stays hidden');
    assert((overlay.innerHTML || '').trim() === '',
      'the retired overlay kept its markup, which would paint over the restored sidebar');
    passed++;

    // --- 8: someone with recents is not a first-timer -----------------------
    recents = ['/code/alpha', '/code/beta', '/code/gamma'];
    const returning = /** @type {any} */ (document.createElement('no-project-overlay'));
    container.appendChild(returning);
    returning.setSession(createStubSession(''));
    await settle();

    const items = returning.querySelectorAll('.np-recent');
    assert(items.length === 3, `expected 3 recent entries, got ${items.length}`);
    assert(items[0].textContent === '/code/alpha',
      `recents are not most-recent-first: got "${items[0].textContent}"`);
    const returningExplainer = /** @type {HTMLElement|null} */ (returning.querySelector('.np-explainer'));
    assert(!!returningExplainer && returningExplainer.hidden,
      'a returning user was given the first-launch explanation again');
    const returningHeading = /** @type {HTMLElement|null} */ (returning.querySelector('.np-heading'));
    assert(!!returningHeading && returningHeading.hidden,
      'a returning user was given a heading: the welcome is for a first launch, and the '
      + 'empty window already says no project is open');
    passed++;

    // --- 9: a recent opens the project it names -----------------------------
    /** @type {string[]} */
    const openedWith = [];
    /** @type {(value: any) => void} */
    let finishOpen = () => {};
    const realOpen = apiService.openProject;
    apiService.openProject = (/** @type {string} */ path) => {
      openedWith.push(path);
      return new Promise((resolve) => { finishOpen = resolve; });
    };
    /** @returns {Element|null} The opening overlay, while it is up. */
    const openingOverlay = () => document.querySelector('.loading-overlay[data-loading-overlay="opening-project"]');
    try {
      items[1].click();
      await settle();
      assert(openedWith.length === 1 && openedWith[0] === '/code/beta',
        `clicking a recent opened ${JSON.stringify(openedWith)}, want ["/code/beta"]`);
      passed++;

      // --- 10: the window shows it is opening, and takes no second choice ---
      // A large project's open is seconds of server-side directory walking.
      // Without this the window looked untouched for all of it, and a second
      // project could be chosen before the first had arrived.
      assert(!!openingOverlay(), 'nothing on screen said a project was opening');
      assert(isOpeningProject(), 'the open in flight was not recorded');
      items[0].click();
      window.dispatchEvent(new CustomEvent('juggler:folder-dropped', { detail: { path: '/code/gamma' } }));
      await settle();
      assert(openedWith.length === 1,
        `a second project was opened while the first was in flight: ${JSON.stringify(openedWith)}`);

      // Success is followed by the page reloading, so the overlay stays up.
      finishOpen({ projectPath: '/code/beta' });
      await settle();
      assert(!!openingOverlay(), 'the overlay came down before the reload that ends the open');
      passed++;
    } finally {
      apiService.openProject = realOpen;
      endProjectOpen();
    }

    // --- 11: a failed open gives the window back ----------------------------
    let threw = false;
    try {
      await openProjectInWindow('/code/missing', () => Promise.reject(new Error('not found')));
    } catch {
      threw = true;
    }
    assert(threw, 'a failed open swallowed its error, so the caller could not report it');
    assert(!openingOverlay() && !isOpeningProject(),
      'a failed open left the window held under the opening overlay');
    passed++;

    // --- 12: it lets go of the provider feed when it goes ------------------
    // A detached element still holding a subscription re-renders markup nobody
    // can see, for as long as the page lives.
    returning.remove();
    assert(returning._providersUpdateHandler === null,
      'the overlay kept its providers-update subscription after being removed');
    passed++;

    // --- 13: the overlay owns the native drag hooks ------------------------
    // The native side hands a dropped folder to window._wails, and the Wails
    // runtime's own versions of those hooks cannot carry it: each ends in an RPC
    // to /wails/runtime, a route this page's server does not answer. So the
    // overlay's have to be the ones left standing.
    const w = /** @type {any} */ (window);
    const hookNames = ['handleDragEnter', 'handleDragLeave', 'handleDragOver', 'handlePlatformFileDrop'];
    w._wails = w._wails || {};
    /** @type {Record<string, any>} */
    const priorHooks = {};
    for (const name of hookNames) priorHooks[name] = w._wails[name];
    try {
      const runtimeDrop = () => {};
      w._wails.handlePlatformFileDrop = runtimeDrop;

      const dropper = /** @type {any} */ (document.createElement('no-project-overlay'));
      container.appendChild(dropper);
      dropper.setSession(createStubSession(''));
      await settle();

      assert(w._wails.handlePlatformFileDrop !== runtimeDrop,
        "the runtime's drop hook survived, so a dropped folder still goes nowhere");
      for (const name of hookNames) {
        assert(typeof w._wails[name] === 'function', `${name} was not installed`);
      }
      passed++;

      // --- 14: the window says so while a folder is over it ------------------
      w._wails.handleDragEnter();
      assert(dropper.classList.contains('folder-drop-active'),
        'a folder over the window left it unmarked, so the panel never outlines');
      w._wails.handleDragOver(1, 1);
      assert(dropper.classList.contains('folder-drop-active'),
        'the mark was dropped while the folder was still over the window');
      w._wails.handleDragLeave();
      assert(!dropper.classList.contains('folder-drop-active'),
        'the mark outlived the drag leaving the window');

      // Releasing it clears the mark too — the drag is over either way.
      w._wails.handleDragEnter();
      w._wails.handlePlatformFileDrop(['/code/alpha'], 10, 10);
      assert(!dropper.classList.contains('folder-drop-active'),
        'the mark outlived the drop it was announcing');
      passed++;

      // --- 15: a window showing a project takes no dropped folder ------------
      // Native drop is switched off for one, so this is belt and braces: acting
      // on it anyway would replace the project under someone on one gesture.
      w._wails.handleDragEnter();
      dropper.setSession(createStubSession('/code/alpha'));
      await settle();
      assert(dropper.hidden, 'the overlay stayed up for a window with a project');
      w._wails.handleDragEnter();
      assert(!dropper.classList.contains('folder-drop-active'),
        'a hidden overlay marked itself as holding a folder');
      passed++;

      // --- 16: it gives the hooks back when it goes --------------------------
      dropper.remove();
      for (const name of hookNames) {
        assert(!(name in w._wails), `${name} outlived the overlay that installed it`);
      }
      passed++;
    } finally {
      for (const name of hookNames) {
        if (priorHooks[name] === undefined) delete w._wails[name];
        else w._wails[name] = priorHooks[name];
      }
    }

    // --- 17: the new-folder panel can be got rid of again --------------------
    // It carries no Cancel button of its own, on purpose: dismissal belongs to
    // the popup surface. That only holds while the surface's `onClose` actually
    // tears the panel down — wire it to anything less and Escape, the outside
    // click and the sheet scrim all become dead gestures, leaving a panel on
    // screen that nothing can remove.
    const { openNewProjectPanel } = await import('../../js/components/project-picker.js');
    const chip = document.createElement('div');
    chip.id = 'project-path-chip';
    container.appendChild(chip);

    /** @returns {HTMLElement|null} The presented panel, while there is one. */
    const livePanel = () => /** @type {HTMLElement|null} */ (document.querySelector('.pp-panel-popup'));

    openNewProjectPanel([]);
    assert(!!livePanel(), 'the new-folder panel never presented');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!livePanel(), 'Escape left the new-folder panel on screen');
    passed++;

    // --- 18: and by clicking away from it ------------------------------------
    openNewProjectPanel([]);
    assert(!!livePanel(), 'the new-folder panel never presented on a second open');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(!livePanel(), 'a click outside left the new-folder panel on screen');
    passed++;
  } catch (error) {
    failed++;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    apiService.getRecents = realGetRecents;
    providersCache.waitForReady = realWaitForReady;
    providersCache.get = realGet;
    providersCache.hasReceived = realHasReceived;
    document.body.classList.toggle('no-project', hadClass);
    // The panel is hosted on <body>, so a failure part-way through the last two
    // cases would otherwise leave it there for every suite that follows.
    closePopupById('new-project');
    container.remove();
  }

  return { passed, failed, errors };
}
