//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration test: stopping a live Monitor from the UI.
 *
 * The Monitor tool starts a long-running background command and binds its
 * output to the conversation via a `deliverTaskOutput` pendingRequests entry.
 * That entry's status in the doc is the LIVE monitor state (claimed → Active,
 * cancelled → Stopped) — decoupled from the Monitor tool-action's own outcome,
 * which only ever means "started OK".
 *
 * This drives the kill path end-to-end against a REAL background process: the
 * LLM calls Monitor with `sleep 30`; we fence (settleUntil — no sleeps) on the
 * binding becoming Active; we invoke `cancelTaskOutputDelivery` exactly as the
 * properties-panel Stop button's click handler does; then we fence on the
 * worker stamping the entry `cancelled` and assert the FULL entry state at each
 * step.
 * @module integration-tests/monitor-kill-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

const LABEL = 'monitor: long runner';

/**
 * The Monitor tool-action in the root thread, if present.
 * @param {any} conversation - The conversation under test.
 * @returns {any|null} The tool-action Y.Map, or null.
 */
function monitorAction(conversation) {
  const items = conversation.rootMessageThread.items;
  return items.find(it => it?.get?.('type') === 'tool-action' && it.get('toolName') === 'Monitor') || null;
}

/**
 * Background task id the Monitor tool-action started — persisted on the action
 * under `result.fullResult.result.task_id` (mirrors how the panel joins to its
 * binding). '' until the action's result has landed.
 * @param {any} action - The Monitor tool-action Y.Map (or null).
 * @returns {string} The task id, or ''.
 */
function taskIdOf(action) {
  if (!action) return '';
  const r = action.get('result');
  const plain = r?.toJSON ? r.toJSON() : r;
  return String(plain?.fullResult?.result?.task_id || '');
}

/**
 * Full snapshot of the deliverTaskOutput binding entry — every field that
 * encodes its lifecycle, so assertions check the WHOLE state, never one field.
 * @param {any} entry - The pendingRequests entry Y.Map (or null).
 * @returns {object|null} Plain snapshot, or null.
 */
function entrySnapshot(entry) {
  if (!entry) return null;
  const req = entry.get('request');
  return {
    kind: entry.get('kind'),
    status: entry.get('status'),
    cancelRequested: entry.get('cancelRequested'),
    taskId: req?.get?.('taskId'),
    label: req?.get?.('label')
  };
}

/**
 * Assert two values are deeply equal (JSON shape), throwing a labelled error.
 * @param {string} label - Step label for the error message.
 * @param {any} actual - Actual value.
 * @param {any} expected - Expected value.
 */
function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`[monitor-stop] ${label}: expected ${e}, got ${a}`);
}

/**
 * Start a long-running monitor, then stop it from the UI; the binding must go
 * Active → Stopped and the worker must stamp the entry `cancelled`.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const monitorStoppedFromPanelTest = {
  name: 'monitor-stopped-from-panel',
  description: 'Stopping a live monitor flips its binding to cancelled and ends the pump',
  fixture: 'unit-test-fixture',

  // 1 Monitor tool-use, then text turns: one after the tool returns. `sleep 30`
  // emits nothing, so there are no auto-wake injections — the conversation goes
  // idle and stays there until we kill the monitor. Spares are harmless.
  llmResponses: [
    toolUseResponse('call_1', 'Monitor', { command: 'sleep 30', description: 'long runner' }, 'Starting the monitor.'),
    textResponse('Monitor is running.'),
    textResponse('Idle.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'begin monitoring' }
  ],

  customAssertions: async (conversation, { harness }) => {
    const thread = conversation.rootMessageThread;

    // ── Phase 1: binding becomes Active ─────────────────────────────────
    // Deterministic fence (re-evaluated on each doc change, no sleep): the
    // action's task id has landed AND the worker has claimed the binding.
    await harness.waitForDocumentMatch(() => {
      const tid = taskIdOf(monitorAction(conversation));
      return !!tid && thread.getTaskDeliveryStatus(tid) === 'active';
    });

    const action = monitorAction(conversation);
    if (!action) throw new Error('[monitor-stop] Monitor tool-action is missing');
    const taskId = taskIdOf(action);
    if (!taskId) throw new Error('[monitor-stop] Monitor never recorded a task_id');

    // The Monitor tool-action's OWN outcome means "started OK" — assert it is
    // a successful `running` start, independent of the live binding below.
    const actionResult = action.get('result');
    const actionPlain = actionResult?.toJSON ? actionResult.toJSON() : actionResult;
    assertEqual('tool-action started state', {
      success: actionPlain?.fullResult?.result?.success,
      status: actionPlain?.fullResult?.result?.status
    }, { success: true, status: 'running' });

    // Full binding state while Active: claimed, not yet cancel-requested.
    assertEqual('binding @ active', entrySnapshot(thread.findTaskDeliveryEntry(taskId)), {
      kind: 'deliverTaskOutput',
      status: 'claimed',
      cancelRequested: false,
      taskId,
      label: LABEL
    });
    assertEqual('status lookup @ active', thread.getTaskDeliveryStatus(taskId), 'active');

    // ── Phase 2: drive the kill (what the Stop button's onclick does) ───
    const requested = thread.cancelTaskOutputDelivery(taskId);
    assertEqual('cancel requested', requested, true);

    // ── Phase 3: binding becomes Stopped ────────────────────────────────
    await harness.waitForDocumentMatch(() => thread.getTaskDeliveryStatus(taskId) === 'stopped');

    // Full binding state after the kill: worker stamped `cancelled`, the
    // cancelRequested flag we flipped is preserved, task id/label unchanged.
    assertEqual('binding @ stopped', entrySnapshot(thread.findTaskDeliveryEntry(taskId)), {
      kind: 'deliverTaskOutput',
      status: 'cancelled',
      cancelRequested: true,
      taskId,
      label: LABEL
    });
    assertEqual('status lookup @ stopped', thread.getTaskDeliveryStatus(taskId), 'stopped');

    // Cancelling a terminal binding is a no-op (already stopped).
    assertEqual('second cancel is no-op', thread.cancelTaskOutputDelivery(taskId), false);

    // The tool-action's frozen outcome is unchanged by the stop — its status
    // is still the "started OK" record, NOT the live binding state.
    const afterResult = monitorAction(conversation).get('result');
    const afterPlain = afterResult?.toJSON ? afterResult.toJSON() : afterResult;
    assertEqual('tool-action outcome unchanged by stop', {
      success: afterPlain?.fullResult?.result?.success,
      status: afterPlain?.fullResult?.result?.status
    }, { success: true, status: 'running' });
  }
};

/**
 * The first injected output chunk in the root thread carrying the monitor's
 * provenance ref, if present.
 * @param {any} conversation - The conversation under test.
 * @returns {any|null} The injected user message Y.Map, or null.
 */
function injectedChunkWithSource(conversation) {
  const items = conversation.rootMessageThread.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.get !== 'function') continue;
    if (it.get('type') !== 'user') continue;
    const src = it.get('taskSource');
    if (src && (src.get ? src.get('taskId') : src.taskId)) return it;
  }
  return null;
}

/**
 * Plain {taskId,label} from an injected chunk's `taskSource` Y.Map (or null).
 * @param {any} message - The injected user message Y.Map (or null).
 * @returns {{taskId: string, label: string}|null} The provenance, or null.
 */
function taskSourceOf(message) {
  if (!message) return null;
  const src = message.get('taskSource');
  if (!src) return null;
  const plain = src.toJSON ? src.toJSON() : src;
  return { taskId: String(plain?.taskId || ''), label: String(plain?.label || '') };
}

/**
 * Every output chunk a monitor posts is stamped with the originating task, so
 * the monitor can be stopped from any of those messages — not just its tool-
 * action. Drive the kill through an injected chunk's `taskSource` and assert the
 * binding goes Active → Stopped, exactly as the message's Stop button would.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const monitorStoppedFromOutputChunkTest = {
  name: 'monitor-stopped-from-output-chunk',
  description: 'A monitor can be stopped from one of its injected output messages via its taskSource',
  fixture: 'unit-test-fixture',

  // Emit one line, then hold open with a sleep: the chunk is injected (and
  // auto-wakes a turn) while the binding stays Active, so we can stop it from
  // that chunk. Spare text turns cover the wake(s); leftovers are harmless.
  llmResponses: [
    toolUseResponse('call_1', 'Monitor', { command: "sh -c 'echo MON_SRC_9Q2; sleep 30'", description: 'src runner' }, 'Starting the monitor.'),
    textResponse('Monitor is running.'),
    textResponse('Reacting to a monitor event.'),
    textResponse('Idle.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'begin monitoring' }
  ],

  customAssertions: async (conversation, { harness }) => {
    const thread = conversation.rootMessageThread;

    // ── Phase 1: a provenance-stamped chunk is injected while Active ────
    await harness.waitForDocumentMatch(() => {
      const chunk = injectedChunkWithSource(conversation);
      const src = taskSourceOf(chunk);
      return !!src && thread.getTaskDeliveryStatus(src.taskId) === 'active';
    });

    const chunk = injectedChunkWithSource(conversation);
    const src = taskSourceOf(chunk);
    if (!src) throw new Error('[monitor-chunk] no injected chunk carried a taskSource');

    // The chunk's provenance must point at the SAME task the tool-action
    // started — that join is what lets the panel offer the Stop button.
    const action = monitorAction(conversation);
    assertEqual('chunk taskSource matches the tool-action', src.taskId, taskIdOf(action));
    assertEqual('chunk label is the delivery label', src.label, 'monitor: src runner');
    assertEqual('status via chunk taskId @ active', thread.getTaskDeliveryStatus(src.taskId), 'active');

    // ── Phase 2: stop from the chunk (what its Stop button's onclick does) ─
    assertEqual('cancel requested via chunk', thread.cancelTaskOutputDelivery(src.taskId), true);

    // ── Phase 3: binding becomes Stopped ───────────────────────────────
    await harness.waitForDocumentMatch(() => thread.getTaskDeliveryStatus(src.taskId) === 'stopped');
    assertEqual('binding @ stopped', entrySnapshot(thread.findTaskDeliveryEntry(src.taskId)), {
      kind: 'deliverTaskOutput',
      status: 'cancelled',
      cancelRequested: true,
      taskId: src.taskId,
      label: 'monitor: src runner'
    });
  }
};

// Export all tests
export const tests = [
  monitorStoppedFromPanelTest,
  monitorStoppedFromOutputChunkTest
];
