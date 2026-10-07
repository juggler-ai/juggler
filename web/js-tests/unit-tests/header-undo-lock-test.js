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
  assert
} from '../utilities/test-helpers.js';
import { pingWorker } from '../utilities/worker-test-hooks.js';
import { setupHeaderControls } from '../../js/utils/header-controls.js';

/**
 * Deterministic barrier — no sleep. One ping makes the worker force-close the
 * undo capture window and flush its Yjs batcher (undoState emitted before the
 * ack); flushing pending inbound updates then applies that undoState frame
 * synchronously, so canUndo() reads current state next line. Replaces a
 * load-bearing 100ms sleep that was too short on slow CI runners. See the
 * fuller explanation on undo-redo-test.js's waitForUndoStateSync.
 * @param {import('../../model/conversation.js').default} conversation
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
		<button id="project-path-chip"></button>
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

    setupHeaderControls(session);

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
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    root.remove();
  }

  return { passed, failed, errors };
}
