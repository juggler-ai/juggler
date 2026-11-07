//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Undo/redo must be locked out while the conversation's LLM loop is running.
 *
 * The footer's Undo/Redo buttons (conversation-footer.js) and the Cmd/Ctrl+Z
 * shortcuts (header-controls.js) are both gated on the worker's authoritative
 * `processingState.status`: anything other than `idle` means a turn is in
 * flight (LLM call, tool execution, or an approval wait) and the worker is
 * actively mutating the same Yjs doc that undo/redo would rewind. Letting the
 * user undo into that write would tear the doc, so both the buttons and the
 * keyboard path must refuse until the worker idles.
 *
 * The buttons sit on the root thread's footer only, and only once there is
 * something to step through.
 *
 * The rest of the header controls are covered here too: the project chip and
 * the new-window button.
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
import { isPseudoLocalized, t } from '../../sdk/lib/i18n.js';
import { setupHeaderControls } from '../../js/components/header-controls.js';
import '../../js/components/conversation-footer.js';
import { sessionsPageUrl, SESSIONS_PAGE_TARGET } from '../../js/utils/project-open-mode.js';

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
 * @returns {{ root: HTMLElement }} The header root.
 */
function buildHeaderDom() {
  const root = document.createElement('div');
  root.innerHTML = `
		<div id="project-path-display"><span class="ppd-path" style="display: block; overflow: hidden; white-space: nowrap"></span></div>
		<span id="project-path-chip"></span>
		<button id="project-new-window-button"></button>
	`;
  document.body.appendChild(root);
  return { root };
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

  const { root } = buildHeaderDom();
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(footer);
  const undoBtn = /** @type {HTMLButtonElement} */ (footer.querySelector('.footer-history-undo'));
  const redoBtn = /** @type {HTMLButtonElement} */ (footer.querySelector('.footer-history-redo'));
  const history = /** @type {HTMLElement} */ (footer.querySelector('.footer-history'));
  const shownHistory = () => !!history && !history.classList.contains('hidden');

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

    // The root thread's footer, at rest. With nothing to step through, the
    // pair is still there — disabled, under its plain names — so it stays
    // where the eye learnt to find it and nothing beside it shifts.
    assert(!!undoBtn && !!redoBtn, 'the footer has undo and redo buttons');
    // Creation clears the undo stack it built, and that clear's undoState
    // frame may still be in flight when the conversation is handed back.
    await syncUndoState(conversation);
    footer.setMessageThread(conversation.rootMessageThread);
    footer.update({ isProcessing: false, canContinue: true, showHistory: true });
    assert(!conversation.canUndo() && !conversation.canRedo(),
      `precondition: a new conversation has nothing to undo or redo (canUndo=${conversation.canUndo()}, canRedo=${conversation.canRedo()})`);
    assert(shownHistory(), 'a footer with no history to step through still shows undo/redo');
    assert(undoBtn.disabled && redoBtn.disabled && undoBtn.title === 'Undo' && redoBtn.title === 'Redo',
      `with nothing to step through both are disabled under their plain names, got disabled=${undoBtn.disabled}/${redoBtn.disabled} "${undoBtn.title}"/"${redoBtn.title}"`);
    passed++;

    // Create a real undo group so canUndo() is true — otherwise "disabled"
    // would prove nothing (the button is disabled when there's nothing to
    // undo regardless of processing state).
    conversation.rootMessageThread.addEvent({ type: 'user', content: 'lock-test' });
    await syncUndoState(conversation);

    assert(conversation.canUndo(), 'precondition: conversation should have undo history');
    assert(!undoBtn.disabled, 'once there is history, Undo is enabled');
    // A sub-thread's footer does not: undo steps through the whole document,
    // and one pair of buttons per window is the honest number.
    footer.update({ isProcessing: false, canContinue: true, showHistory: false });
    assert(!shownHistory(), 'a footer not asked to show history shows none');
    footer.update({ isProcessing: false, canContinue: true, showHistory: true });
    passed++;

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
    undoBtn.click();
    assert(undoCalls === 2, "the footer's Undo button invokes undo");
    passed++;

    // --- Busy: button disabled, shortcut ignored -------------------------
    // Any non-idle status means a turn is in flight; the worker holds the
    // claim across the whole busy span (streaming + tool execution).
    conversation._doc.setMetadata('processingState', { status: 'streaming', turnCounter: 1 });
    assert(undoBtn.disabled, 'undo button must be disabled while the LLM loop is running');
    assert(shownHistory(), 'a busy lock disables the buttons; it does not hide them');
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

    // --- The chip shows the whole path where it fits, else the name --------
    // Following the header's width as it changes, both ways.
    {
      const savedPath = session.projectPath;
      try {
        session.projectPath = '/a/rather/long/parent/folder/leaf-project';
        /** @type {any} */ (headerListener)({ type: 'session:loaded' });
        root.style.width = '1200px';
        await waitFor(() => pathLabel.textContent === session.projectPath,
          { description: `the whole path in a wide header (shows "${pathLabel.textContent}")` });
        root.style.width = '60px';
        await waitFor(() => pathLabel.textContent === 'leaf-project',
          { description: `the folder's name in a narrow header (shows "${pathLabel.textContent}")` });
        root.style.width = '1200px';
        await waitFor(() => pathLabel.textContent === session.projectPath,
          { description: `the whole path again once there is room (shows "${pathLabel.textContent}")` });
      } finally {
        root.style.width = '';
        session.projectPath = savedPath;
        /** @type {any} */ (headerListener)({ type: 'session:loaded' });
      }
    }
    passed++;

    // --- In a browser the new-window button opens the server's page --------
    // A tab has no app to open a window, so the button is the way back to the
    // server's page from a session: in its own named tab, found again by a
    // second press.
    {
      const newWindowBtn = /** @type {HTMLButtonElement} */ (root.querySelector('#project-new-window-button'));
      /** @type {unknown[]} */
      const opened = [];
      const realOpen = window.open;
      const realNewWindow = apiService.newWindow;
      window.open = /** @type {any} */ ((/** @type {unknown[]} */ ...args) => { opened.push(args); return null; });
      apiService.newWindow = async () => { opened.push('newWindow'); };
      try {
        newWindowBtn.click();
        await Promise.resolve();
        await Promise.resolve();
        assert(JSON.stringify(opened) === JSON.stringify([[sessionsPageUrl(), SESSIONS_PAGE_TARGET]]),
          `the button in a browser opened ${JSON.stringify(opened)}, want the server's page in ${SESSIONS_PAGE_TARGET}`);
        assert(newWindowBtn.title === 'Open the server page' && newWindowBtn.getAttribute('aria-label') === 'Open the server page',
          `the button in a browser is named "${newWindowBtn.title}" / "${newWindowBtn.getAttribute('aria-label')}"`);
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
        assert(pathLabel.textContent === '/1/2', `the chip shows the project's whole path, with room for it, got "${pathLabel.textContent}"`);
        assert(pathChip.title.includes('/1/2'), `the chip's title gives the whole path, got "${pathChip.title}"`);
        // The switcher's key is no word: it is left out of what is judged.
        shown.push(...pathChip.title.split('\n').map((line) => line.replace(/⌘K|Ctrl\+K/, '')));
        // Named once, as the header is set up: the browser's name was asked
        // for in English then, so it is checked as a message here.
        shown.push(t('Open the server page'));

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
    footer.remove();
  }

  return { passed, failed, errors };
}
