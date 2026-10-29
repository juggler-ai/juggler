//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Header undo/redo must be locked out while the visible conversation's LLM
 * loop is running.
 *
 * `header-controls.js` gates the buttons (and the Cmd/Ctrl+Z shortcuts) on the
 * worker's authoritative `processingState.status`: anything other than `idle`
 * means a turn is in flight (LLM call, tool execution, or an approval wait) and
 * the worker is actively mutating the same Yjs doc that undo/redo would rewind.
 * Letting the user undo into that write would tear the doc, so both the buttons
 * and the keyboard path must refuse until the worker idles.
 * @module unit-tests/header-undo-lock-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import { pingWorker } from '../utilities/worker-test-hooks.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { setupHeaderControls } from '../../js/components/header-controls.js';

/**
 * Deterministic barrier — no sleep. One ping makes the worker force-close the
 * undo capture window and flush its Yjs batcher (undoState emitted before the
 * ack); flushing pending inbound updates then applies that undoState frame
 * synchronously, so canUndo() reads current state next line. Replaces a
 * load-bearing 100ms sleep that was too short on slow CI runners. See the
 * fuller explanation on undo-redo-test.js's waitForUndoStateSync.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {Promise<void>}
 */
async function syncUndoState(conversation) {
  await pingWorker(conversation.id);
  conversation._doc.flushPendingUpdates();
}

/**
 * Build the minimal .app-header DOM that setupHeaderControls() queries by id.
 * @returns {{ root: HTMLElement, undoBtn: HTMLButtonElement, redoBtn: HTMLButtonElement }} The header root and its undo/redo buttons.
 */
function buildHeaderDom() {
  const root = document.createElement('div');
  root.innerHTML = `
		<button id="control-undo-button"></button>
		<button id="control-redo-button"></button>
		<div id="project-path-display"><span class="ppd-path"></span></div>
		<span id="project-path-chip"></span>
		<button id="project-new-window-button"></button>
	`;
  document.body.appendChild(root);
  return {
    root,
    undoBtn: /** @type {HTMLButtonElement} */ (root.querySelector('#control-undo-button')),
    redoBtn: /** @type {HTMLButtonElement} */ (root.querySelector('#control-redo-button'))
  };
}

/**
 * Dispatch a document-level Cmd/Ctrl+Z. Sets both metaKey and ctrlKey so the
 * platform-specific modifier check in header-controls fires regardless of the
 * test runner's navigator.platform.
 * @returns {void}
 */
function dispatchUndoShortcut() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    metaKey: true,
    ctrlKey: true,
    shiftKey: false,
    bubbles: true,
    cancelable: true
  }));
}

/**
 * Run the header undo-lock test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { root, undoBtn, redoBtn } = buildHeaderDom();

  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);

    // Keep hold of the header's session listener, so the en-XA case can redraw
    // the project chip without telling the session's other subscribers anything.
    /** @type {((event: {type: string}) => void)|null} */
    let headerListener = null;
    const realSubscribe = session.subscribe;
    session.subscribe = /** @type {any} */ ((/** @type {any} */ fn) => {
      headerListener = fn;
      return realSubscribe.call(session, fn);
    });
    try {
      setupHeaderControls(session);
    } finally {
      session.subscribe = realSubscribe;
    }

    // Create a real undo group so canUndo() is true — otherwise "disabled"
    // would prove nothing (the button is disabled when there's nothing to
    // undo regardless of processing state).
    conversation.rootMessageThread.addEvent({ type: 'user', content: 'lock-test' });
    await syncUndoState(conversation);

    assert(conversation.canUndo(), 'precondition: conversation should have undo history');

    // --- Idle: button enabled, shortcut performs undo --------------------
    conversation._doc.setMetadata('processingState', { status: 'idle', turnCounter: 1 });
    assert(!undoBtn.disabled, 'undo button must be enabled while idle with undo history');
    passed++;

    // Spy on undo so we can prove the keyboard path is (not) taken. The spy
    // also neuters the actual rewind, so the call count is the only
    // observable and the doc stays put under the assertions.
    let undoCalls = 0;
    conversation.undo = async () => { undoCalls++; };

    dispatchUndoShortcut();
    assert(undoCalls === 1, 'Cmd/Ctrl+Z while idle must invoke undo');
    passed++;

    // --- Busy: button disabled, shortcut ignored -------------------------
    // Any non-idle status means a turn is in flight; the worker holds the
    // claim across the whole busy span (streaming + tool execution).
    conversation._doc.setMetadata('processingState', { status: 'streaming', turnCounter: 1 });
    assert(undoBtn.disabled, 'undo button must be disabled while the LLM loop is running');
    assert(redoBtn.disabled, 'redo button must be disabled while the LLM loop is running');
    // A disabled button says why, when the reason is something other than an
    // empty history — otherwise it looks broken.
    assert(undoBtn.title === 'Unavailable while the agent is running'
      && redoBtn.title === 'Unavailable while the agent is running',
    `busy undo/redo explain themselves, got "${undoBtn.title}" / "${redoBtn.title}"`);
    passed++;

    const callsBeforeBusyShortcut = undoCalls;
    dispatchUndoShortcut();
    assert(
      undoCalls === callsBeforeBusyShortcut,
      'Cmd/Ctrl+Z must be ignored while the LLM loop is running'
    );
    passed++;

    // 'processing_tools' (between LLM calls, incl. awaiting approval) is also
    // busy — the lock must hold for the entire turn, not just streaming.
    conversation._doc.setMetadata('processingState', { status: 'processing_tools', turnCounter: 1 });
    assert(undoBtn.disabled, 'undo button must stay disabled during tool execution');
    passed++;

    // --- Back to idle: re-enables and the shortcut works again -----------
    conversation._doc.setMetadata('processingState', { status: 'idle', turnCounter: 2 });
    assert(!undoBtn.disabled, 'undo button must re-enable once the worker idles');
    assert(undoBtn.title === 'Undo', `idle undo is plain "Undo" again, got "${undoBtn.title}"`);
    // Redo is still disabled — nothing has been undone — but that is the
    // ordinary empty-history case, which needs no explanation.
    assert(redoBtn.disabled && redoBtn.title === 'Redo',
      `idle redo with nothing to redo is plain "Redo", got "${redoBtn.title}"`);
    passed++;

    const callsBeforeIdleShortcut = undoCalls;
    dispatchUndoShortcut();
    assert(
      undoCalls === callsBeforeIdleShortcut + 1,
      'Cmd/Ctrl+Z must work again once the worker idles'
    );
    passed++;

    // --- The project path is read-only ------------------------------------
    // A session stays on its project: the path names it and leads nowhere.
    assert(!!headerListener, 'precondition: the header subscribed to the session');
    const pathLabel = /** @type {HTMLElement} */ (root.querySelector('.ppd-path'));
    const pathChip = /** @type {HTMLElement} */ (root.querySelector('#project-path-chip'));
    const { default: apiService } = await import('../../js/services/api.js');
    {
      /** @type {unknown[]} */
      const opened = [];
      const realOpen = window.open;
      const realNewWindow = apiService.newWindow;
      window.open = /** @type {any} */ ((/** @type {unknown[]} */ ...args) => { opened.push(args); return null; });
      apiService.newWindow = async () => { opened.push('newWindow'); };
      try {
        pathChip.click();
        // chooseProject resolves its host before it opens anything.
        await Promise.resolve();
        assert(opened.length === 0, `clicking the project path opened ${JSON.stringify(opened)}`);
        assert(!pathChip.title.includes('\n') && !/click/i.test(pathChip.title),
          `the path's tooltip names the folder and offers no action, got "${pathChip.title}"`);
        assert(!pathChip.hasAttribute('aria-label'),
          `the path is named by its text, not an action label, got "${pathChip.getAttribute('aria-label')}"`);
      } finally {
        window.open = realOpen;
        apiService.newWindow = realNewWindow;
      }
    }
    passed++;

    // --- en-XA: every title and label the header controls draw -------------
    /** @type {string[]} */
    const shown = [];
    const savedPath = session.projectPath;
    const realNewWindow = apiService.newWindow;
    const realShowModal = /** @type {any} */ (window).showModal;
    try {
      await underPseudoLocale('test-header-controls', async () => {
        conversation._doc.setMetadata('processingState', { status: 'streaming', turnCounter: 3 });
        shown.push(undoBtn.title, redoBtn.title);
        conversation._doc.setMetadata('processingState', { status: 'idle', turnCounter: 4 });
        shown.push(undoBtn.title, redoBtn.title);

        // A path of digits, so the data cannot read as English.
        session.projectPath = '/1/2';
        /** @type {any} */ (headerListener)({ type: 'session:loaded' });
        assert(pathLabel.textContent === '/1/2', `the chip shows the path as given, got "${pathLabel.textContent}"`);
        shown.push(...pathChip.title.split('\n'));

        // A window that cannot be opened says so, under a translated title.
        /** @type {any[]} */
        const alerts = [];
        /** @type {any} */ (window).showModal = async (/** @type {any} */ opts) => { alerts.push(opts); };
        apiService.newWindow = async () => { throw new Error('1'); };
        window.dispatchEvent(new CustomEvent('juggler:new-window'));
        await waitFor(() => alerts.length > 0, { description: 'the new-window failure alert' });
        shown.push(alerts[0].title);
      });
    } finally {
      session.projectPath = savedPath;
      apiService.newWindow = realNewWindow;
      /** @type {any} */ (window).showModal = realShowModal;
      /** @type {any} */ (headerListener)({ type: 'session:loaded' });
    }
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA (header controls): ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  } finally {
    root.remove();
  }

  return { passed, failed, errors };
}
