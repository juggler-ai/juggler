//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI Operation Executor - maps test operations to real DOM interactions via UIDriver.
 * User-facing operations go through the UI; model-level operations pass to the inner harness.
 * @module test/utilities/ui-operation-executor
 */

import {
  normalizeDocumentSnapshot,
  assertDocumentGolden,
} from './golden-comparator.js';
import {
  assertTransactionMarkers,
  assertContextSnapshot,
  assertThreadContext,
} from './test-assertions.js';
import { threadRunSettled } from '../../js/model/run-records.js';
import { SecondViewer } from './second-viewer.js';
import { budgetFor } from './test-deadline.js';

/**
 * @typedef {import('./integration-test-runner.js').TestOperation} TestOperation
 * @typedef {import('./ui-test-harness.js').UITestHarness} UITestHarness
 */

/**
 * @typedef {object} SeenConfirmation
 * @property {string} title - The dialog's title text
 * @property {string} message - The dialog's body text
 * @property {string[]} buttons - Button labels, in DOM order
 */

/**
 * The confirmation armed by `expect-confirm`, awaited by `assert-confirm-shown`.
 *
 * Module scope because the two operations are separate steps of one test — and a
 * lane's realm is shared across every suite it runs, so an arm left watching the
 * DOM would click a dialog belonging to a later test. It is therefore cancelled
 * both when consumed and when superseded, and its watcher stops on the first of
 * those or its own deadline.
 * @type {{promise: Promise<SeenConfirmation>, cancel: () => void}|null}
 */
let armedConfirm = null;

/**
 * Why the armed confirmation watcher last stopped waiting, or null if it has
 * not.
 *
 * The operation that raises a dialog is blocked on the production confirm
 * promise, which resolves on a click and on nothing else — so a watcher that
 * gives up does not fail the test, it strands it, and the test dies later at
 * the runner's hard timeout naming only the operation it was in. Keeping the
 * give-up means that failure can say what actually happened.
 * @type {string|null}
 */
let confirmGiveUp = null;

/**
 * @returns {string|null} Why the armed confirmation watcher gave up, if it did.
 */
export function lastConfirmGiveUp() {
  return confirmGiveUp;
}

/** Stop watching for a confirmation, if one is armed. */
export function disarmConfirm() {
  armedConfirm?.cancel();
  armedConfirm = null;
}

/**
 * Resolve when a confirmation dialog is on screen carrying the button this test
 * means to click.
 *
 * Deliberately narrower than matching `modal-dialog`: that element is a reused
 * singleton which also presents alerts and notices, so "a dialog is showing" is
 * not "the confirmation is showing" — a warning notice raised by the operation
 * under test would otherwise be answered instead. Waiting for the button also
 * rules out clicking a footer that is still being built. Class changes are
 * observed as well as children, because the reused element gains `.show` by
 * attribute alone.
 * @param {string} buttonSelector - The button that must be present
 * @param {number} timeoutMs - Fail-fast deadline
 * @returns {{promise: Promise<{modal: HTMLElement, button: HTMLElement}>, cancel: () => void}} The wait and its off switch
 */
function waitForConfirmDialog(buttonSelector, timeoutMs) {
  const find = () => {
    const modal = /** @type {HTMLElement|null} */ (document.querySelector('modal-dialog.show:not(.is-notice)'));
    const button = /** @type {HTMLElement|null} */ (modal?.querySelector(buttonSelector) || null);
    return modal && button ? { modal, button } : null;
  };
  const found = find();
  if (found) return { promise: Promise.resolve(found), cancel: () => {} };
  /** @type {() => void} */
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const hit = find();
      if (hit) {
        stop();
        resolve(hit);
      }
    });
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    const timer = setTimeout(() => {
      stop();
      const shown = document.querySelector('modal-dialog.show');
      reject(new Error(
        `expect-confirm: no confirmation with a '${buttonSelector}' button appeared within ${timeoutMs}ms` +
				(shown ? ` (a dialog titled "${shown.querySelector('.modal-title')?.textContent || ''}" was showing)` : '')
      ));
    }, timeoutMs);
    cancel = () => {
      stop();
      reject(new Error('expect-confirm: superseded before the dialog appeared'));
    };
  });
  return { promise, cancel };
}

/**
 * Resolve when an element matching `selector` exists in the DOM, observing
 * mutations (no polling). Rejects on timeout. The timeout is fail-fast only.
 * @param {string} selector - CSS selector
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<HTMLElement>} Resolves with the matched element
 */
function waitForElement(selector, timeoutMs = 3000) {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(/** @type {HTMLElement} */ (existing));
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(/** @type {HTMLElement} */ (el));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElement: '${selector}' did not appear within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Resolve when no element matching `selector` exists in the DOM. Mutation-driven.
 * @param {string} selector - CSS selector
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<void>}
 */
function waitForElementGone(selector, timeoutMs = 3000) {
  if (!document.querySelector(selector)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElementGone: '${selector}' still present after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Execute a single test operation through the UI where possible.
 * @param {UITestHarness} harness - UI test harness
 * @param {TestOperation} op - Operation to execute
 * @returns {Promise<void>} Resolves when operation completes
 */
/**
 * Op types that only observe or assert — they never start a worker turn, so
 * they must not advance the fence baseline captured for `wait-for-idle`.
 */
const OBSERVE_ONLY_OPS = new Set([
  'wait-for-idle', 'wait-for-state', 'wait-for-approval', 'wait-for-thread-approval',
  'wait-for-progress', 'wait-for-action-output', 'wait-for-execution',
  'wait-for-mock-paused', 'wait-ms',
  'assert-document', 'assert-dom', 'assert-no-result', 'assert-input-warning',
  'assert-streaming-chunks', 'assert-transaction-markers', 'assert-thread-item-count',
  'assert-tool-exec-count', 'assert-spinner-was-visible', 'assert-tool-result-changed',
  'validate-context-snapshot', 'validate-thread-context',
  'start-capture-progress', 'start-tool-exec-counter', 'start-spinner-capture',
  'capture-tool-result'
]);

/**
 * The turn-epoch fence baseline for the harness's current conversation, as
 * captured before the most recent turn-triggering op. Never throws — during
 * teardown or before setup there is no conversation, in which case the fence
 * falls back to capture-at-wait-start.
 * @param {UITestHarness} harness
 * @returns {number|undefined} The captured turn-epoch baseline, or undefined.
 */
function fenceBaseline(harness) {
  try {
    return harness._turnEpochBaselines?.get(harness.conversation?.id);
  } catch {
    return undefined;
  }
}

/**
 * Execute a UI operation against the test harness, driving real DOM/UI
 * interactions through the harness's driver.
 * @param {UITestHarness} harness - The test harness driving the UI.
 * @param {TestOperation} op - The UI operation descriptor to perform.
 * @returns {Promise<void>}
 */
export async function executeUIOperation(harness, op) {
  const driver = harness.driver;

  // Capture the turn epoch BEFORE any op that can start a worker turn.
  // `wait-for-idle` fences on this baseline rather than on the epoch at its
  // own start: a fast turn triggered by the previous op (a 1ms mock turn
  // under load) can complete and sync before the wait begins, and a fence
  // captured then would demand a turn that will never come. Baselines are
  // per conversation — multi-conversation tests switch between convs, and a
  // baseline measured on one conv must never fence another.
  if (!OBSERVE_ONLY_OPS.has(op.type)) {
    try {
      const conv = harness.conversation;
      if (conv) {
        harness._turnEpochBaselines ??= new Map();
        harness._turnEpochBaselines.set(conv.id, conv.completedTurns);
      }
    } catch { /* conversation not initialised yet (first setup op) */ }
  }

  switch (op.type) {

    // =========================================================================
    // User-facing operations — routed through real UI
    // =========================================================================

    case 'send-message': {
      if (!op.message) {
        throw new Error('send-message operation requires message');
      }

      // Type into the real composer-box and submit via the UI path.
      await driver.typeAndSend(op.message);

      // Track response consumption
      harness.consumeResponse();

      // Await the sendMessage() promise that our event listener fired.
      await harness.awaitPendingSend();

      await harness.waitForTurnComplete(undefined, fenceBaseline(harness));
      await driver.waitForDOMStable();
      break;
    }

    case 'send-message-no-wait': {
      if (!op.message) {
        throw new Error('send-message-no-wait operation requires message');
      }

      // Type into the real composer-box and submit via the UI path.
      await driver.typeAndSend(op.message);

      // Track response consumption
      harness.consumeResponse();

      // Await the sendMessage() promise that our event listener fired.
      await harness.awaitPendingSend();

      // Deliberately do NOT call waitForTurnComplete — caller expects the
      // turn to be interrupted (e.g. by cancel) before it can complete.
      break;
    }

    case 'approve': {
      if (!op.toolUseId) {
        throw new Error('approve operation requires toolUseId');
      }

      // Wait for Yjs-level pending state first
      await harness.waitForApproval(op.toolUseId, op.timeoutMs || 3000);

      // Try to click the approval dialog in the DOM.
      // Some actions (e.g., AskUserQuestion) use custom form elements instead
      // of action-confirmation buttons — fall back to model-level approval.
      if (driver.hasApprovalDialog(op.toolUseId)) {
        await driver.clickApprove(op.toolUseId, op.response);
      } else {
        harness.resolveApprovalNoWait(op.toolUseId, op.response || 'approved');
      }

      await harness.waitForTurnComplete(undefined, fenceBaseline(harness));
      await driver.waitForDOMStable();
      break;
    }

    case 'approve-no-wait': {
      if (!op.toolUseId) {
        throw new Error('approve-no-wait operation requires toolUseId');
      }

      await harness.waitForApproval(op.toolUseId, op.timeoutMs || 3000);

      if (driver.hasApprovalDialog(op.toolUseId)) {
        await driver.clickApprove(op.toolUseId, op.response);
      } else {
        harness.resolveApprovalNoWait(op.toolUseId, op.response || 'approved');
      }
      break;
    }

    case 'deny': {
      if (!op.toolUseId) {
        throw new Error('deny operation requires toolUseId');
      }

      await harness.waitForApproval(op.toolUseId, op.timeoutMs || 3000);

      if (driver.hasApprovalDialog(op.toolUseId)) {
        await driver.clickDeny(op.toolUseId);
      } else {
        harness.resolveApprovalNoWait(op.toolUseId, 'denied');
      }

      await harness.waitForTurnComplete(undefined, fenceBaseline(harness));
      await driver.waitForDOMStable();
      break;
    }

    case 'wait-for-approval': {
      if (!op.toolUseId) {
        throw new Error('wait-for-approval operation requires toolUseId');
      }
      await harness.waitForApproval(op.toolUseId, op.timeoutMs || 3000);
      break;
    }

    case 'cancel': {
      // Unknown-vantage Escape (a bare Escape): interrupts the live sub-thread
      // without closing it, else stops the root turn. Dispatch the real keydown
      // (no-op when the tab UI isn't mounted) plus the authoritative model-level
      // fallback.
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      }));
      // Also call inner harness cancel as fallback
      await harness.cancelExecution();
      break;
    }

    case 'cancel-from-root': {
      // Root/parent vantage stop: Escape while focused on the root, or the root
      // footer Stop. Stops the in-flight turn AND settles every sub-thread run
      // still open under it.
      await harness.cancelFromRoot(op.timeoutMs);
      break;
    }

    case 'pause': {
      // Polite stop (Pause): non-destructive. Routes through the same model-level
      // entry the footer Pause button and shift+Escape use (requestPoliteStop) —
      // it only sends the `pause` message and flips the optimistic local cue. The
      // worker latches it and rests at idle at the next boundary; nothing is
      // cancelled, no approval is rejected, no run is settled.
      harness.conversation.requestPoliteStop();
      break;
    }

    case 'cancel-pause': {
      // Toggle Pause back off: cancel a pending polite stop. Routes through the
      // same model-level entry the footer Pause button's second click uses
      // (cancelPoliteStop) — it sends the `unpause` message and clears the local
      // pending cue, so the worker drops the latch and the turn continues to its
      // next boundary. A no-op unless a polite stop is actually pending.
      harness.conversation.cancelPoliteStop();
      break;
    }

    case 'wait-for-mock-paused': {
      // Wait for the worker to reach a paused mock response.
      // Deterministic: worker writes processingState.status='mock-paused' as
      // it enters the pause; observer fires the moment the doc syncs.
      await harness.waitForMockPaused(op.timeoutMs || 5000);
      break;
    }

    case 'release-mock': {
      // Release a paused mock response. After release, the worker resumes
      // the strategy loop (LLM response is delivered).
      harness.releaseMock();
      break;
    }

    // =========================================================================
    // Thread operations — UI for approval, model-level for messages
    // =========================================================================

    case 'send-thread-message': {
      if (!op.message) {
        throw new Error('send-thread-message operation requires message');
      }
      // Thread messages go through the inner harness (thread columns
      // require multi-column UI which is complex to set up in tests)
      await harness.sendThreadMessage(op.message);
      break;
    }

    case 'send-thread-message-no-wait': {
      if (!op.message) {
        throw new Error('send-thread-message-no-wait operation requires message');
      }
      // Like send-thread-message but does NOT wait for the turn to complete —
      // the caller expects to act while it is still in flight (e.g. pause at a
      // mock barrier, then assert what the column renders mid-run).
      await harness.sendThreadMessageNoWait(op.message);
      break;
    }

    case 'cancel-thread': {
      // Mirror the parent tile's Stop button (the parent-vantage stop): resolve
      // the running thread's Y.Map and call conversation.cancelThread, which
      // cancels the in-flight worker turn (worker truth) and settles the
      // thread's run as cancelled.
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      let threadYMap = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread' && !threadRunSettled(item)) {
          threadYMap = item;
        }
      }
      if (!threadYMap) {
        throw new Error('cancel-thread: no running thread found in root items');
      }
      await conversation.cancelThread(threadYMap);
      break;
    }

    case 'assert-input-warning': {
      // Assert a visible centered warning notice. Searched document-wide so it
      // is robust to which column owns the active composer.
      await driver.waitForDOMStable();
      const needle = op.textContains || '';
      /** @returns {{ warnings: Element[], match: Element | undefined }} All visible notices, and the first whose text contains the needle (if any). */
      const findMatch = () => {
        const warnings = Array.from(document.querySelectorAll('modal-dialog.is-notice.show'));
        return { warnings, match: warnings.find(w => (w.textContent || '').includes(needle)) };
      };

      if (op.absent) {
        const { match } = findMatch();
        if (match) {
          throw new Error(`assert-input-warning: expected no visible warning containing "${needle}", but found "${match.textContent}"`);
        }
        break;
      }

      // Presence: the notice is surfaced asynchronously by the cancel/command
      // flow (conversation.showWarning → app-level showNotice) and can land a
      // beat AFTER the triggering op's promise resolves — the composer may
      // still be (re)mounting, or the doc-stable point may precede the notice
      // under multi-lane load. A single check races that gap, so poll up to a
      // bounded deadline (mirroring the waitForDocumentMatch fence the runner
      // uses for final assertions). A genuinely-missing notice still fails —
      // just after the poll window rather than instantly.
      const deadline = Date.now() + 2000;
      let result = findMatch();
      while (!result.match && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
        result = findMatch();
      }
      if (!result.match) {
        throw new Error(
          `assert-input-warning: expected a visible warning containing "${needle}"; ` +
					`visible warnings: ${JSON.stringify(result.warnings.map(w => w.textContent))}`
        );
      }
      break;
    }

    case 'wait-for-thread-approval': {
      if (!op.toolUseId) {
        throw new Error('wait-for-thread-approval operation requires toolUseId');
      }
      // Fall back to model-level wait (thread UI is not mounted)
      await harness.waitForThreadApproval(op.toolUseId, op.timeoutMs);
      break;
    }

    case 'approve-thread-tool': {
      if (!op.toolUseId) {
        throw new Error('approve-thread-tool operation requires toolUseId');
      }
      await harness.resolveThreadApproval(op.toolUseId, op.response || 'approved');
      break;
    }

    case 'approve-thread-tool-no-wait': {
      if (!op.toolUseId) {
        throw new Error('approve-thread-tool-no-wait operation requires toolUseId');
      }
      harness.resolveThreadApprovalNoWait(op.toolUseId, op.response || 'approved');
      break;
    }

    case 'deny-thread-tool': {
      if (!op.toolUseId) {
        throw new Error('deny-thread-tool operation requires toolUseId');
      }
      await harness.resolveThreadApproval(op.toolUseId, 'denied');
      break;
    }

    // =========================================================================
    // Model-level operations — pass through to inner harness
    // =========================================================================

    case 'run-command': {
      if (!op.command) {
        throw new Error('run-command operation requires command');
      }
      await harness.runCommand(op.command, op.args);
      break;
    }

    case 'run-command-no-wait': {
      if (!op.command) {
        throw new Error('run-command-no-wait operation requires command');
      }
      await harness.runCommandNoWait(op.command, op.args);
      break;
    }

    case 'compact-up-to': {
      if (op.index === undefined) {
        throw new Error('compact-up-to operation requires index');
      }
      await harness.compactUpTo(op.index);
      break;
    }

    case 'simulate-disconnect': {
      await harness.simulateDisconnect(op.reconnectMs);
      break;
    }

    case 'wait-for-state': {
      if (!op.condition) {
        throw new Error('wait-for-state operation requires condition');
      }
      await harness.waitForState(op.condition, op.timeoutMs);
      break;
    }

    case 'wait-for-idle': {
      // Wait for the turn started by the most recent action op on the
      // CURRENT conversation to complete. Fences on the epoch captured
      // BEFORE that action (see the baseline capture above the switch) so a
      // turn that already finished still satisfies the wait.
      await harness.waitForTurnComplete(op.timeoutMs, fenceBaseline(harness));
      break;
    }

    case 'create-conversation': {
      op.resultId = await harness.createConversation(op.name, op.llmResponses);
      break;
    }

    case 'duplicate-conversation': {
      if (!op.sourceId) {
        throw new Error('duplicate-conversation operation requires sourceId');
      }
      op.resultId = await harness.duplicateConversation(op.sourceId);
      break;
    }

    case 'switch-conversation': {
      if (!op.conversationId) {
        throw new Error('switch-conversation operation requires conversationId');
      }
      harness.switchConversation(op.conversationId);
      break;
    }

    case 'delete-conversation': {
      if (!op.conversationId) {
        throw new Error('delete-conversation operation requires conversationId');
      }
      await harness.deleteConversation(op.conversationId);
      break;
    }

    case 'bin-conversation': {
      if (!op.conversationId) {
        throw new Error('bin-conversation operation requires conversationId');
      }
      // Routes through the real conversation-bar busy-guard; whether the
      // conversation actually moves to the bin is asserted in customAssertions.
      await harness.binConversationViaBar(op.conversationId);
      break;
    }

    case 'undo': {
      await harness.undo();
      break;
    }

    case 'redo': {
      await harness.redo();
      break;
    }

    case 'wait-ms': {
      await new Promise(r => setTimeout(r, op.ms ?? 300));
      break;
    }

    case 'write-fixture-file': {
      // Inline-write a file under the SessionManager's project root so the
      // CLAUDE.md / AGENTS.md window — when sibling tests' addAIAssistantFiles
      // could pick it up — is bounded to between two adjacent ops rather
      // than the whole test. Path is taken verbatim (no testDir prefix);
      // the caller is responsible for cleanup via delete-fixture-file.
      if (!op.path) throw new Error('write-fixture-file requires path');
      const { writeFileOp: _wff } = await import('../../js/services/ops-api.js');
      await _wff({ path: op.path, content: op.content ?? '' });
      break;
    }

    case 'delete-fixture-file': {
      // Paired with write-fixture-file. Goes through the test-only
      // /api/test/delete-file endpoint which handles missing files
      // gracefully and uses os.RemoveAll under the hood.
      if (!op.path) throw new Error('delete-fixture-file requires path');
      const fixtureDir = harness.innerHarness?._fixtureDir;
      if (!fixtureDir) throw new Error('delete-fixture-file: no fixtureDir on harness');
      const url = `/api/test/delete-file?dir=${encodeURIComponent(fixtureDir)}&path=${encodeURIComponent(op.path)}`;
      await fetch(url, { method: 'POST' });
      break;
    }

    case 'add-execute-pattern': {
      if (!op.pattern) {
        throw new Error('add-execute-pattern operation requires pattern');
      }
      // Conversation-scoped so the pattern only auto-approves this lane's tools,
      // not every other lane sharing the session metadata.
      harness.conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: op.pattern, scope: 'conversation' });
      break;
    }

    case 'set-strategy': {
      if (!op.strategy) {
        throw new Error('set-strategy operation requires strategy');
      }
      // Mid-loop strategy switch: a pure currentStrategyId metadata write (the
      // same path the strategy-selector UI takes). The worker observes it and
      // re-evaluates any tool parked awaiting approval under the new policy.
      harness.conversation.rootMessageThread.setStrategy(op.strategy);
      // setStrategy writes Yjs metadata synced to the worker async; ping so the
      // switch lands (and the worker's re-evaluation runs) before the next op.
      const { default: _wmStrat } = await import('../../js/services/worker-manager.js');
      await _wmStrat.ping(harness.conversation.id);
      break;
    }

    case 'set-model': {
      if (!op.provider || !op.model) {
        throw new Error('set-model operation requires provider and model');
      }
      harness.rootThread.modelConfig = {
        provider: op.provider,
        model: op.model
      };
      // The setter writes to Yjs metadata which fires a yjs-sync to the
      // worker async (not awaited by the observer). If the next op is
      // duplicate-conversation, it reads modelConfig from the worker's doc;
      // without a round-trip barrier the duplicate can race ahead of the
      // modelConfig sync and copy the previous (test-default) value. Ping
      // the worker so any in-flight syncs land before we return.
      const { default: _wmSet } = await import('../../js/services/worker-manager.js');
      await _wmSet.ping(harness.conversation.id);
      break;
    }

    case 'assert-document': {
      if (!op.expected) {
        throw new Error('assert-document operation requires expected');
      }
      const snapshot = normalizeDocumentSnapshot(harness.conversation);
      assertDocumentGolden(snapshot, op.expected, 'assert-document');
      break;
    }

    case 'assert-transaction-markers': {
      assertTransactionMarkers(harness.rootThread, op);
      break;
    }

    case 'validate-context-snapshot': {
      await assertContextSnapshot(harness.rootThread, harness.conversation.id, op);
      break;
    }

    case 'validate-thread-context': {
      await assertThreadContext(harness.rootThread, harness.conversation.id, op);
      break;
    }

    case 'start-capture-progress': {
      if (!op.toolUseId) {
        throw new Error('start-capture-progress operation requires toolUseId');
      }
      harness.startCapturingProgress(op.toolUseId);
      break;
    }

    // Waits for progress events, which is not the same as waiting for the tool
    // to have produced output: how many status and claim events precede the
    // first byte is the engine's business and may change. Use
    // 'wait-for-action-output' below when what you mean is "the tool has
    // written something".
    case 'wait-for-progress': {
      if (!op.toolUseId) {
        throw new Error('wait-for-progress operation requires toolUseId');
      }
      await harness.waitForProgress(op.toolUseId, op.minEvents || 1, op.timeoutMs);
      break;
    }

    case 'wait-for-action-output': {
      if (!op.toolUseId) {
        throw new Error('wait-for-action-output operation requires toolUseId');
      }
      if (!op.contains) {
        throw new Error('wait-for-action-output operation requires contains');
      }
      await harness.waitForActionOutput(op.toolUseId, op.contains, op.timeoutMs);
      break;
    }

    case 'assert-streaming-chunks': {
      if (!op.toolUseId) {
        throw new Error('assert-streaming-chunks operation requires toolUseId');
      }
      harness.assertStreamingChunks(op.toolUseId, op.minChunks || 2);
      break;
    }

    case 'assert-no-result': {
      if (!op.toolUseId) {
        throw new Error('assert-no-result operation requires toolUseId');
      }
      const items = harness.rootThread.items || [];
      const tool = items.find(i => i.get('toolUseId') === op.toolUseId);
      if (!tool) throw new Error(`Tool ${op.toolUseId} not found`);
      if (tool.get('result') !== null && tool.get('result') !== undefined) {
        throw new Error(`Expected no result for ${op.toolUseId}, but got result`);
      }
      const toolIndex = items.indexOf(tool);
      if (toolIndex < items.length - 1) {
        throw new Error(`LLM continued prematurely - items exist after tool ${op.toolUseId}`);
      }
      break;
    }

    case 'click-item': {
      // Simulate a real user click on a tool-action-message item: dispatches
      // a bubbling click on the element so conversation-area's wrapper
      // listener sees it and runs the navigation-click branch
      // (origin='user'). Used to test rule 2b's behaviour when the user
      // has manually pinned a selection before approving.
      if (!op.toolUseId) {
        throw new Error('click-item operation requires toolUseId');
      }
      const container = driver.getConversationArea() || driver.getContainer();
      const el = container.querySelector(`tool-action-message[data-tool-use-id="${op.toolUseId}"]`);
      if (!el) throw new Error(`click-item: no tool-action-message for toolUseId=${op.toolUseId}`);
      /** @type {HTMLElement} */ (el).click();
      await driver.waitForDOMStable();
      break;
    }

    case 'click-approval-shifted': {
      // Reproduce the layout-shift-during-click race: the user's mousedown
      // lands on an approval button, but the approval box moves (autoscroll
      // while streaming, or a pending re-render) before mouseup, so the native
      // click resolves onto the selectable item ABOVE. A correct selection
      // handler keys off where the press BEGAN (the button) and must not let
      // the shifted click select the neighbour.
      if (!op.toolUseId) {
        throw new Error('click-approval-shifted operation requires toolUseId');
      }
      const shiftContainer = driver.getConversationArea() || driver.getContainer();
      const shiftToolEl = shiftContainer.querySelector(`tool-action-message[data-tool-use-id="${op.toolUseId}"]`);
      if (!shiftToolEl) {
        throw new Error(`click-approval-shifted: no tool-action-message for toolUseId=${op.toolUseId}`);
      }
      const shiftButton = shiftToolEl.querySelector('.action-confirmation-button');
      if (!shiftButton) {
        throw new Error(`click-approval-shifted: no approval button for toolUseId=${op.toolUseId}`);
      }
      const shiftAbove = shiftContainer.querySelector(op.aboveSelector || 'assistant-message');
      if (!shiftAbove) {
        throw new Error(`click-approval-shifted: no element matching aboveSelector "${op.aboveSelector || 'assistant-message'}"`);
      }
      // Press begins on the approval button...
      shiftButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      // ...but the box shifted, so the click (mouseup) resolves onto the item above.
      shiftAbove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await driver.waitForDOMStable();
      break;
    }

    case 'click-dom': {
      // Simulate a real user click on an arbitrary element matched by CSS
      // selector within the conversation area. Optionally disambiguate by
      // visible text (op.text) or position (op.index). Used to drive custom
      // approval forms (e.g. AskUserQuestion option/submit buttons).
      if (!op.selector) {
        throw new Error('click-dom operation requires selector');
      }
      await driver.waitForDOMStable();
      // op.global searches the whole tab (all columns) rather than just the root
      // conversation-area — needed to reach an open thread column's elements.
      const clickContainer = op.global
        ? driver.getContainer()
        : (driver.getConversationArea() || driver.getContainer());
      const candidates = Array.from(clickContainer.querySelectorAll(op.selector));
      let clickEl;
      if (op.text !== undefined) {
        clickEl = candidates.find(c => (c.textContent || '').includes(op.text));
      } else {
        clickEl = candidates[op.index || 0];
      }
      if (!clickEl) {
        throw new Error(`click-dom: no element matching "${op.selector}"${op.text !== undefined ? ` with text "${op.text}"` : ''}`);
      }
      /** @type {HTMLElement} */ (clickEl).click();
      await driver.waitForDOMStable();
      break;
    }

    case 'expect-confirm': {
      // Answer the next confirmation dialog, driving the real <modal-dialog>
      // rather than standing in for the presenter — so the copy, the buttons
      // and the promise the caller is blocked on are all the production ones.
      //
      // Armed BEFORE the operation that raises the dialog, because that
      // operation is blocked on the answer and can never reach a later step:
      // the waiter runs in the background, clicks when the dialog mounts, and
      // `assert-confirm-shown` collects what it saw.
      const wanted = op.answer === false
        ? '.modal-button.secondary'
        : '.modal-button.danger, .modal-button.primary';
      // A previous test in this lane's realm may have died holding an arm; its
      // watcher must not answer this test's dialog.
      disarmConfirm();
      confirmGiveUp = null;
      // Rides the test's deadline rather than a bare nominal, and for a
      // sharper reason than the other waits: the watcher is armed before the
      // operation that raises the dialog, so its clock is already running
      // while that operation loads registries and cancels the live turn. A
      // watcher that gives up first cannot fail the test — nothing else will
      // ever answer the dialog, so the operation blocks until the runner kills
      // it. Patience here costs nothing, because the wait is in the background
      // and the test's own timeout is the real bound either way.
      const pending = waitForConfirmDialog(wanted, budgetFor(op.timeoutMs || 5000));
      const waiter = pending.promise
        .then(({ modal, button }) => {
          /** @type {SeenConfirmation} */
          const seen = {
            title: modal.querySelector('.modal-title')?.textContent || '',
            message: modal.querySelector('.modal-message')?.textContent || '',
            buttons: Array.from(modal.querySelectorAll('.modal-button'))
              .map(b => b.textContent || ''),
          };
          button.click();
          return seen;
        });
      // Awaited by assert-confirm-shown, which sees any rejection. Swallowed
      // here as well so a test that dies before consuming its arm fails on its
      // own error rather than on an unhandled rejection — but recorded on the
      // way past, because the operation this arm exists to answer is blocked on
      // a promise nothing else will settle. Being superseded is the ordinary
      // end of an arm and says nothing about a hang, so only a give-up counts.
      waiter.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('superseded')) confirmGiveUp = message;
      });
      armedConfirm = { promise: waiter, cancel: pending.cancel };
      break;
    }

    case 'assert-confirm-shown': {
      if (!armedConfirm) {
        throw new Error('assert-confirm-shown: nothing armed — put expect-confirm before the operation that raises the dialog');
      }
      const armed = armedConfirm.promise;
      armedConfirm = null;
      const seen = await armed;
      if (op.titleContains && !seen.title.includes(op.titleContains)) {
        throw new Error(`assert-confirm-shown: title "${seen.title}" does not contain "${op.titleContains}"`);
      }
      if (op.messageContains && !seen.message.includes(op.messageContains)) {
        throw new Error(`assert-confirm-shown: message "${seen.message}" does not contain "${op.messageContains}"`);
      }
      break;
    }

    case 'rerun-tool': {
      if (!op.toolUseId) {
        throw new Error('rerun-tool operation requires toolUseId');
      }
      await harness.rerunTool(op.toolUseId);
      break;
    }

    case 'rerun-tool-no-wait': {
      if (!op.toolUseId) {
        throw new Error('rerun-tool-no-wait operation requires toolUseId');
      }
      await harness.rerunToolNoWait(op.toolUseId);
      break;
    }

    case 'cancel-via-ui-flow': {
      // Trigger the same JS-side cancel path the Escape key invokes when
      // `isLLMActive()` is true — bypasses the conversation-tab keydown
      // handler so the test isn't coupled to the DOM gate, but exercises
      // `cancelLLMOperation`'s semantics. Used to test cancellation outside
      // an active LLM turn (e.g., during a rerun).
      await harness.cancelViaUIFlow(op.timeoutMs);
      break;
    }

    case 'copy-items-new-tab':
    case 'move-items-new-tab': {
      if (!Array.isArray(op.indices)) throw new Error(`${op.type}: requires indices array`);
      const source = op.from === 'thread'
        ? (() => {
          const t = (harness.rootThread.items || []).find((/** @type {any} */ i) => i.get?.('type') === 'thread');
          if (!t) throw new Error(`${op.type}: no thread in root items`);
          return harness.conversation.resolveMessageThread(t.get('itemId'));
        })()
        : harness.conversation.rootMessageThread;
      const newId = op.type === 'copy-items-new-tab'
        ? await harness.conversation.copyItemsToNewTab(source, op.indices, { activate: op.activate !== false, name: op.name })
        : await harness.conversation.moveItemsToNewTab(source, op.indices, { activate: op.activate !== false, name: op.name });
      if (!newId) throw new Error(`${op.type}: returned null`);
      const inner = harness.innerHarness || harness;
      const newConv = inner.session.getConversation(newId);
      if (newConv) {
        inner._conversations.set(newId, newConv);
        inner._conversationOrder.push(newId);
        if (op.activate !== false) inner.switchConversation(newId);
      }
      await driver.waitForDOMStable();
      break;
    }

    case 'promote-thread': {
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      const threadItems = rootItems.filter((/** @type {any} */ i) => i.get?.('type') === 'thread');
      const idx = op.threadIndex ?? 0;
      if (idx >= threadItems.length) {
        throw new Error(`promote-thread: threadIndex ${idx} out of range (${threadItems.length})`);
      }
      const newId = await conversation.promoteThreadToNewTab(threadItems[idx].get('itemId'), { activate: op.activate !== false });
      if (!newId) throw new Error('promote-thread: promote returned null');
      const inner = harness.innerHarness || harness;
      const newConv = inner.session.getConversation(newId);
      if (newConv) {
        inner._conversations.set(newId, newConv);
        inner._conversationOrder.push(newId);
        if (op.activate !== false) inner.switchConversation(newId);
      }
      inner._lastPromotedConversationId = newId;
      await driver.waitForDOMStable();
      break;
    }

    case 'expand-thread': {
      // Expand the first thread in root (or by index) back into its parent.
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      const threadItems = rootItems.filter((/** @type {any} */ i) => i.get?.('type') === 'thread');
      const idx = op.threadIndex ?? 0;
      if (idx >= threadItems.length) {
        throw new Error(`expand-thread: threadIndex ${idx} out of range (${threadItems.length})`);
      }
      conversation.expandThread(threadItems[idx].get('itemId'));
      await driver.waitForDOMStable();
      break;
    }

    case 'move-items':
    case 'copy-items': {
      if (!Array.isArray(op.indices)) {
        throw new Error(`${op.type}: requires indices array`);
      }
      const conversation = harness.conversation;
      /**
       * @param {string|undefined} which
       * @returns {any} The resolved message thread.
       */
      const resolveThread = (which) => {
        if (which === 'thread') {
          const rootItems = harness.rootThread.items || [];
          const t = rootItems.find((/** @type {any} */ i) => i.get?.('type') === 'thread');
          if (!t) throw new Error(`${op.type}: no thread in root items`);
          return conversation.resolveMessageThread(t.get('itemId'));
        }
        return conversation.rootMessageThread;
      };
      const source = resolveThread(op.from);
      const dest = resolveThread(op.to);
      if (op.type === 'move-items') {
        conversation.moveItems(source, op.indices, dest, op.position);
      } else {
        conversation.copyItems(source, op.indices, dest, op.position);
      }
      await driver.waitForDOMStable();
      break;
    }

    case 'set-dom-value': {
      // Set the value of an input/textarea matched by selector and dispatch an
      // 'input' event so listeners react. op.global searches the whole tab.
      if (!op.selector) {
        throw new Error('set-dom-value operation requires selector');
      }
      await driver.waitForDOMStable();
      const valueContainer = op.global
        ? driver.getContainer()
        : (driver.getConversationArea() || driver.getContainer());
      const field = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (
        valueContainer.querySelector(op.selector));
      if (!field) {
        throw new Error(`set-dom-value: no element matching "${op.selector}"`);
      }
      field.value = op.value ?? '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await driver.waitForDOMStable();
      break;
    }

    case 'start-tool-exec-counter': {
      if (!op.toolUseId) {
        throw new Error('start-tool-exec-counter operation requires toolUseId');
      }
      harness.startToolExecCounter(op.toolUseId);
      break;
    }

    case 'assert-tool-exec-count': {
      if (!op.toolUseId) {
        throw new Error('assert-tool-exec-count operation requires toolUseId');
      }
      if (typeof op.expectedCount !== 'number') {
        throw new Error('assert-tool-exec-count operation requires expectedCount (number)');
      }
      harness.assertToolExecCount(op.toolUseId, op.expectedCount);
      break;
    }

    case 'delete-last-item': {
      const items = harness.rootThread.items || [];
      if (items.length > 0) {
        harness.rootThread.deleteAt(items.length - 1);
      }
      break;
    }

    case 'delete-last-item-in-thread':
    case 'delete-first-item-in-thread':
    case 'delete-item-in-thread': {
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      let threadItemId = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread') {
          threadItemId = item.get('itemId');
        }
      }
      if (!threadItemId) {
        throw new Error(`${op.type}: no thread found in root items`);
      }
      const messageThread = conversation.resolveMessageThread(threadItemId);
      const allItems = messageThread.items;
      // Only operate on user-deletable items (excludes system-prompt, rules, etc.)
      const deletableItems = allItems.filter(i => !i.get('preventUserDeletion'));
      if (deletableItems.length === 0) {
        throw new Error(`${op.type}: thread has no deletable items`);
      }
      let targetItem;
      if (op.type === 'delete-last-item-in-thread') {
        targetItem = deletableItems[deletableItems.length - 1];
      } else if (op.type === 'delete-first-item-in-thread') {
        targetItem = deletableItems[0];
      } else {
        if (op.index === undefined) {
          throw new Error('delete-item-in-thread requires index');
        }
        if (op.index >= deletableItems.length) {
          throw new Error(`delete-item-in-thread: index ${op.index} out of range (${deletableItems.length} deletable items)`);
        }
        targetItem = deletableItems[op.index];
      }
      const rawIdx = allItems.indexOf(targetItem);
      messageThread.deleteAt(rawIdx);
      break;
    }

    case 'assert-thread-item-count': {
      if (op.count === undefined) {
        throw new Error('assert-thread-item-count requires count');
      }
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      let threadItemId = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread') {
          threadItemId = item.get('itemId');
        }
      }
      if (!threadItemId) {
        const rootTypes = rootItems.map(i => i.get?.('type') ?? '?').join(', ');
        throw new Error(`assert-thread-item-count: no thread found in root items (got ${rootItems.length}: [${rootTypes}])`);
      }
      const messageThread = conversation.resolveMessageThread(threadItemId);
      // Count only user-deletable items (excludes system-prompt, rules, etc.)
      const deletableCount = messageThread.items.filter(i => !i.get('preventUserDeletion')).length;
      if (deletableCount !== op.count) {
        const types = messageThread.items.map(i => `${i.get('type')}${i.get('preventUserDeletion') ? '(locked)' : ''}`).join(', ');
        throw new Error(`assert-thread-item-count: expected ${op.count} deletable items, got ${deletableCount} [${types}]`);
      }
      break;
    }

    case 'wait-for-execution': {
      if (!op.toolUseId) {
        throw new Error('wait-for-execution operation requires toolUseId');
      }
      await harness.waitForExecution(op.toolUseId, op.timeoutMs);
      break;
    }

    case 'continue': {
      // Click the continue button in the root conversation-area footer.
      const continueBtn = driver.getConversationArea()?.querySelector('.continue-btn');
      if (!continueBtn) throw new Error('continue: no .continue-btn found in root conversation-area');
      if (/** @type {HTMLElement} */ (continueBtn).classList.contains('hidden')) {
        throw new Error('continue: .continue-btn is hidden — canContinue is false');
      }
      /** @type {HTMLElement} */ (continueBtn).click();
      harness.consumeResponse();
      await harness.waitForTurnComplete(undefined, fenceBaseline(harness));
      await driver.waitForDOMStable();
      break;
    }


    case 'continue-sub-thread': {
      // Click the in-thread "Continue" button on a specific sub-thread (selected
      // by index among root's thread items, 0-based). Mirrors what the user
      // does when a sub-thread has stalled: open it, click Continue.
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      const threadItems = rootItems.filter(i => i.get && i.get('type') === 'thread');
      const idx = op.threadIndex ?? 0;
      if (idx >= threadItems.length) {
        throw new Error(`continue-sub-thread: threadIndex ${idx} out of range (${threadItems.length} thread items)`);
      }
      const threadItemId = threadItems[idx].get('itemId');
      const messageThread = conversation.resolveMessageThread(threadItemId);
      await messageThread.continue();
      await driver.waitForDOMStable(100, 3000);
      break;
    }

    case 'continue-in-new-thread': {
      // Find the last thread in root items and call continueInNewThread on it.
      const conversation = harness.conversation;
      const rootItems = harness.rootThread.items || [];
      let threadItem = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread') {
          threadItem = item;
        }
      }
      if (!threadItem) {
        throw new Error('continue-in-new-thread: no thread found in root items');
      }
      const threadItemId = threadItem.get('itemId');
      const messageThread = conversation.resolveMessageThread(threadItemId);
      // continueInNewThread internally awaits the new thread's result, so
      // by the time it resolves the worker has already reached idle and
      // incremented turnCounter. Do NOT call waitForTurnComplete after —
      // it would wait forever for a next idle transition that never comes.
      await messageThread.continueInNewThread();
      await driver.waitForDOMStable(100, 3000);
      break;
    }

    case 'assert-dom': {
      if (!op.selector) {
        throw new Error('assert-dom operation requires selector');
      }
      await driver.waitForDOMStable();
      const container = op.global
        ? driver.getContainer()
        : (driver.getConversationArea() || driver.getContainer());
      const el = container.querySelector(op.selector);
      if (op.absent) {
        if (el) {
          throw new Error(`assert-dom: expected no element matching "${op.selector}", but found one`);
        }
      } else {
        if (!el) {
          throw new Error(`assert-dom: expected element matching "${op.selector}", but none found`);
        }
        if (op.minCount !== undefined) {
          const count = container.querySelectorAll(op.selector).length;
          if (count < op.minCount) {
            throw new Error(`assert-dom: expected at least ${op.minCount} elements matching "${op.selector}", but found ${count}`);
          }
        }
      }
      break;
    }

    case 'start-spinner-capture': {
      harness.startSpinnerCapture(op.threadType || 'main');
      break;
    }

    case 'assert-spinner-was-visible': {
      await harness.assertSpinnerWasVisible();
      break;
    }

    case 'capture-tool-result': {
      if (!op.toolUseId) throw new Error('capture-tool-result requires toolUseId');
      if (!op.key) throw new Error('capture-tool-result requires key');
      const captureItems = harness.rootThread.items || [];
      const captureTool = captureItems.find(i => i.get('toolUseId') === op.toolUseId);
      if (!captureTool) throw new Error(`capture-tool-result: tool ${op.toolUseId} not found`);
      const captureResult = captureTool.get('result');
      const captureResultPlain = captureResult?.toJSON ? captureResult.toJSON() : captureResult;
      if (!harness._capturedResults) harness._capturedResults = {};
      harness._capturedResults[op.key] = captureResultPlain;
      break;
    }

    case 'assert-tool-result-changed': {
      if (!op.toolUseId) throw new Error('assert-tool-result-changed requires toolUseId');
      if (!op.key) throw new Error('assert-tool-result-changed requires key');
      if (!harness._capturedResults || !(op.key in harness._capturedResults)) {
        throw new Error(`assert-tool-result-changed: no captured result with key "${op.key}"`);
      }
      const assertItems = harness.rootThread.items || [];
      const assertTool = assertItems.find(i => i.get('toolUseId') === op.toolUseId);
      if (!assertTool) throw new Error(`assert-tool-result-changed: tool ${op.toolUseId} not found`);
      const assertResult = assertTool.get('result');
      const assertResultPlain = assertResult?.toJSON ? assertResult.toJSON() : assertResult;
      const before = JSON.stringify(harness._capturedResults[op.key]);
      const after = JSON.stringify(assertResultPlain);
      if (before === after) {
        throw new Error(
          `assert-tool-result-changed: result did not change after rerun.\n` +
				`Before: ${before}\nAfter: ${after}`
        );
      }
      break;
    }

    case 'add-context-item-to-sub-thread': {
      // Add a context item to a sub-thread, exercising the same routing the
      // footer's "Add Context Item" menu performs: resolve the sub-thread by
      // its thread item id and executeContextItem there (mirrors the menu
      // handler's `threadItemId ? resolveMessageThread(id) : root` branch).
      // Uses file-content (the canonical user-addable context item) pinned to
      // a fixture file — type-agnostic for the add/remove/undo assertions that
      // follow, which key on item count and id, not data.
      const rootItems = harness.rootThread.items || [];
      let addCiThreadItemId = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread') {
          addCiThreadItemId = item.get('itemId');
        }
      }
      if (!addCiThreadItemId) {
        throw new Error('add-context-item-to-sub-thread: no thread found in root items');
      }

      const subThread = harness.conversation.resolveMessageThread(addCiThreadItemId);
      if (!subThread) {
        throw new Error('add-context-item-to-sub-thread: could not resolve sub-thread');
      }
      await subThread.executeContextItem('file-content', { path: 'README.md' });
      await driver.waitForDOMStable(0, 3000);
      break;
    }

    case 'add-context-item-to-root': {
      // Pin a NON-foundational context item onto ROOT, mid-conversation: a
      // plain file-content that is neither preventUserDeletion (system prompt /
      // project memory) nor part of the leading agents-file run. A sub-thread
      // turn must NOT inherit it — only the basic starting items (system
      // prompt, agents files, project memory) cross the thread boundary.
      // Inserts at the end of root's items (after the existing conversation),
      // so the leading-context run has already ended by construction.
      await harness.rootThread.executeContextItem('file-content', { path: 'README.md' });
      await driver.waitForDOMStable(0, 3000);
      break;
    }

    case 'add-ai-files-to-sub-thread': {
      // Simulate clicking "Add Context Item" → "AI assistant files" from a sub-thread's footer.
      // Spins up a real UIEventManager with the test session so _handleContextItemAddRequested runs.
      // RED: _addAIAssistantFiles() ignores threadItemId and calls session.addAIAssistantFiles(conversation)
      // which hardcodes rootMessageThread — file-content item lands in root.
      const rootItems = harness.rootThread.items || [];
      let addAIThreadItemId = null;
      for (const item of rootItems) {
        if (item.get && item.get('type') === 'thread') addAIThreadItemId = item.get('itemId');
      }
      if (!addAIThreadItemId) throw new Error('add-ai-files-to-sub-thread: no thread found in root items');

      const { default: UIEventManagerAI } = await import('../../js/services/ui-event-manager.js');
      const uiemAI = new UIEventManagerAI({
        onSendMessage: () => {},
        onContextItemAction: async () => {}
      });
      uiemAI.setSession(harness.innerHarness.session);
      uiemAI.setupAll();

      const fakeBtnAI = document.createElement('button');
      fakeBtnAI.style.cssText = 'position:fixed;top:100px;left:100px;width:60px;height:30px;z-index:9999';
      document.body.appendChild(fakeBtnAI);
      try {
        document.dispatchEvent(new CustomEvent('context-item-add-requested', {
          bubbles: true,
          detail: { button: fakeBtnAI, threadItemId: addAIThreadItemId }
        }));
        await waitForElement('.context-item-add-dropdown .menu-item');
        const menuItemsAI = Array.from(document.querySelectorAll('.context-item-add-dropdown .menu-item'));
        const aiFilesItem = /** @type {HTMLElement|undefined} */ (menuItemsAI.find(el => el.textContent.trim() === 'AI assistant files'));
        if (!aiFilesItem) throw new Error(`add-ai-files-to-sub-thread: "AI assistant files" menu item not found (found: ${menuItemsAI.map(el => el.textContent.trim()).join(', ')})`);
        aiFilesItem.click();
        await waitForElementGone('.context-item-add-dropdown');
        await driver.waitForDOMStable(0, 3000);
      } finally {
        fakeBtnAI.remove();
        uiemAI.destroy();
      }
      break;
    }

    case 'remove-context-item-from-sub-thread': {
      // Simulate the context-item-action "remove" event as properties-panel dispatches it.
      // onContextItemAction mirrors the BUGGY app.js (ignores threadItemId, uses rootMessageThread).
      // RED: rootMessageThread.removeContextItem throws "not found" — item stays in sub-thread.
      const removeConversation = harness.conversation;
      const removeRootItems = harness.rootThread.items || [];
      let removeThreadItemId = null;
      for (const item of removeRootItems) {
        if (item.get && item.get('type') === 'thread') removeThreadItemId = item.get('itemId');
      }
      if (!removeThreadItemId) throw new Error('remove-context-item-from-sub-thread: no thread found in root items');

      const removeThread = removeConversation.resolveMessageThread(removeThreadItemId);
      const contextItemYMap = removeThread.items.find(/** @type {function(any): boolean} */ (i) => !i.get('preventUserDeletion') && i.get('itemId'));
      if (!contextItemYMap) throw new Error('remove-context-item-from-sub-thread: no deletable context item in sub-thread');
      const contextItemId = contextItemYMap.get('itemId');

      const { default: UIEventManagerRM } = await import('../../js/services/ui-event-manager.js');
      const uiemRM = new UIEventManagerRM({
        onSendMessage: () => {},
        // Mirrors app.js _handleContextItemAction: resolves correct thread via threadItemId
        onContextItemAction: async (detail) => {
          const { action, itemId, threadItemId } = /** @type {any} */ (detail);
          const conv = harness.innerHarness.session.getVisibleConversation();
          if (!conv) return;
          if (action === 'remove' || action === 'delete') {
            const mt = threadItemId ? conv.resolveMessageThread(threadItemId) : conv.rootMessageThread;
            try { mt?.removeContextItem(itemId); } catch { /* not deletable */ }
          }
        }
      });
      uiemRM.setSession(harness.innerHarness.session);
      uiemRM.setupAll();

      try {
        document.dispatchEvent(new CustomEvent('context-item-action', {
          bubbles: true,
          detail: { action: 'remove', itemId: contextItemId, threadItemId: removeThreadItemId }
        }));
        await driver.waitForDOMStable(100, 3000);
      } finally {
        uiemRM.destroy();
      }
      break;
    }

    case 'at-mention-file': {
      if (!op.path) throw new Error('at-mention-file operation requires path');
      const atPath = op.path;
      const atComposer = driver.getComposer();
      if (!atComposer) throw new Error('at-mention-file: composer-box not found');
      const atTextarea = /** @type {HTMLTextAreaElement|null} */ (atComposer.querySelector('textarea'));
      if (!atTextarea) throw new Error('at-mention-file: textarea not found');

      const atIb = /** @type {any} */ (atComposer);

      // composer-box.render() defers setupListeners() into requestAnimationFrame
      // to give child custom elements a chance to finish their own connected
      // callbacks. In tests, the rAF may not have fired by the time the test
      // reaches this op; force-init in that window. (Production also benefits
      // when a user types fast enough to race the rAF — see send-message.)
      if (!atIb._completions && typeof atIb.setupListeners === 'function') {
        atIb.setupListeners();
      }
      if (!atIb._completions) {
        throw new Error('at-mention-file: composer-box._completions not initialised');
      }

      // Set up the textarea with "@path" text and position the cursor at the end,
      // exactly as it would be after the user has typed @path and completions resolved.
      atTextarea.value = '@' + atPath;
      atTextarea.selectionStart = atTextarea.selectionEnd = atTextarea.value.length;

      // Set completions state to match what _open() would have set, including
      // the active provider (normally chosen by handleInput → detect) so
      // accept() knows how to splice the mention in.
      atIb._completions._provider =
        atIb._completions._providers.find((/** @type {any} */ p) => p.id === 'file-mention');
      atIb._completions._anchorPos = 0;
      atIb._completions._items = [atPath];
      atIb._completions._index = 0;
      atIb._completions._active = true;

      // Accept the completion. Await any resulting promise.
      atIb._completions.accept();
      if (atIb._lastMentionPromise) await atIb._lastMentionPromise;

      await driver.waitForDOMStable();
      break;
    }

    case 'open-second-viewer': {
      // Attach a SECOND real WebSocket client (distinct server clientId) to an
      // existing conversation, simulating two tabs on one conversation — the
      // production multi-tab case the iframe pool otherwise never exercises.
      const convId = op.conversationId
        ? harness.innerHarness._resolveConversationId(op.conversationId)
        : harness.conversation.id;
      if (!harness._secondViewers) harness._secondViewers = new Map();
      const sv = new SecondViewer(convId);
      await sv.open();
      harness._secondViewers.set(convId, sv);
      break;
    }

    case 'assert-second-viewer-converges': {
      // Assert the independent second-viewer client converges to viewer-1's
      // CURRENT doc state. Comparing to the live primary (not a hardcoded
      // shape) is the true convergence property and sidesteps guessing undo
      // granularity. Viewer-1 is already settled here: send-message awaits
      // waitForTurnComplete and undo awaits the worker ack + flush.
      const convId = op.conversationId
        ? harness.innerHarness._resolveConversationId(op.conversationId)
        : harness.conversation.id;
      const sv = harness._secondViewers && harness._secondViewers.get(convId);
      if (!sv) {
        throw new Error(`assert-second-viewer-converges: no second viewer open for ${convId} (call open-second-viewer first)`);
      }
      // Project viewer-1's items to the {type, content} shape SecondViewer
      // exposes, reading its doc directly (matches SecondViewer.items()).
      const primaryJson = harness.conversation._doc.toJSON();
      const expected = (Array.isArray(primaryJson.items) ? primaryJson.items : [])
        .map((/** @type {any} */ it) => ({ type: it.type, content: it.content }));
      await sv.waitForConverge(expected, { timeoutMs: op.timeoutMs || 5000 });
      break;
    }

    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}
