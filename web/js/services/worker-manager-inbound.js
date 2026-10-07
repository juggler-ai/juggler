//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The inbound half of the worker protocol: what a client does with each
 * message a conversation worker sends it.
 *
 * {@link INBOUND_HANDLERS} has one entry per wire type, and that table is the
 * whole vocabulary. A type that is not in it is reported as unknown, except
 * `debug-*`, which workers send for tracing and nobody consumes. Each handler
 * takes `(wm, conversationId, data)`. A handler may return a promise, and
 * {@link routeWorkerMessage} reports its rejection under the message's type,
 * so no handler carries its own guard. The engine-side request handlers live
 * in `worker-manager-protocols.js`, and their entries here only adapt
 * arguments.
 *
 * A handler reaches the manager only through its public surface (`session`,
 * `loader`, `sendToWorker`, `markReady`, `failPendingReady`, `workerState`,
 * `settleThreadRequest`, `settleAck`). The manager owns its bookkeeping, and
 * this module decides what a message means for it.
 * @module services/worker-manager-inbound
 */

import * as protocols from './worker-manager-protocols.js';
import { bytesToBase64, base64ToBytes } from '../utils/base64.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { setBootstrapSummarizationPrompt } from '../utils/compaction-utils.js';

/**
 * @typedef {import('./worker-manager.js').WorkerManager} WorkerManager
 * @typedef {import('./worker-manager.js').WorkerMessage} WorkerMessage
 * @typedef {(wm: WorkerManager, conversationId: string, data: WorkerMessage) => (void|Promise<unknown>)} InboundHandler
 */

/**
 * The conversation a message is about, if this client holds it.
 * @param {WorkerManager} wm - The manager
 * @param {string} conversationId - Conversation ID
 * @returns {import('../model/conversation.js').default|undefined} The conversation
 */
function conversationOf(wm, conversationId) {
  return wm.session?.conversations.get(conversationId);
}

/**
 * Decode a base64 byte field Go marshalled from a `[]byte`.
 * @param {unknown} field - The field as it arrived
 * @returns {Uint8Array|null} The bytes, or null when the field is absent
 */
function bytesField(field) {
  return field ? base64ToBytes(/** @type {string} */ (field)) : null;
}

/** @type {InboundHandler} */
function onReady(wm, conversationId, data) {
  // The worker owns the canonical summarization prompt and ships it with
  // every "ready" (server-wide constant, independent of this entry).
  if (data.summarizationPrompt) {
    setBootstrapSummarizationPrompt(data.summarizationPrompt);
  }
  const took = wm.markReady(conversationId, data.metadata ?? null);
  if (!took) return;
  // Activate bidirectional sync. Skip the initial state broadcast for
  // load-from-disk: the worker already has the full state and
  // encoding+broadcasting it back blocks the main thread for hundreds of ms on
  // large docs. New conversations have local additions that still need the
  // broadcast.
  conversationOf(wm, conversationId)?.activateYjsSync({ broadcastInitialState: !took.loadFromDisk });
}

/** @type {InboundHandler} */
function onYjsSync(wm, conversationId, data) {
  // All sync goes through YjsConversationSync.
  if (!data.bytes) {
    console.warn(`[WorkerManager] Missing bytes for yjs-sync`);
    return;
  }
  const conversation = conversationOf(wm, conversationId);
  if (!conversation) {
    // Auto-load is engine-only: the engine is the single execution
    // place — it needs every conversation loaded so it can execute
    // tools and run worker-dispatched strategy hooks regardless of which
    // viewer created the conv. Viewers must NOT auto-load: a viewer
    // shows only the conversations the user explicitly opened and runs no
    // session-wide flow, so loading siblings' convs would be pure waste.
    if (isEngine()) {
      wm.loader.autoLoad(conversationId, /** @type {string} */ (/** @type {unknown} */ (data.bytes)));
    }
    return;
  }
  conversation.handleYjsSyncMessage(/** @type {Uint8Array} */ (bytesField(data.bytes)));
}

/** @type {InboundHandler} */
function onResyncOffer(wm, conversationId) {
  // The worker telling a freshly attached engine that this conversation
  // is loaded on the server. It carries no state, because what is needed
  // depends on what this engine already has — and only this engine knows
  // that.
  //
  // The realm outlives the socket, so after a link drop the document is
  // usually still here and the answer is the ordinary delta handshake.
  // After a real restart there is nothing here, and the conversation is
  // loaded the ordinary way instead, which arrives at full state through
  // init. A worker that exists but is not ready yet needs neither: its
  // init is already in flight and carries whatever state it lacks.
  if (!isEngine()) return;
  const state = wm.workerState(conversationId);
  if (state === 'absent') {
    wm.loader.autoLoad(conversationId);
    return;
  }
  if (state !== 'ready') return;
  const conversation = conversationOf(wm, conversationId);
  if (!conversation) return;
  try {
    wm.sendToWorker(conversationId, {
      type: 'resync-request',
      stateVector: bytesToBase64(conversation.getYjsStateVector())
    });
  } catch (err) {
    console.warn(`[WorkerManager] Couldn't answer the resync offer for ${conversationId}:`, err);
  }
}

/** @type {InboundHandler} */
function onResyncResponse(wm, conversationId, data) {
  // The worker's answer to our reconnect resync-request: the ops we are
  // missing, plus the worker's state vector. Apply its ops, then send back
  // exactly the ops it lacks — the edits made here while the socket was
  // down, which the transport discarded on the floor. Both directions are
  // deltas; neither side ever ships full state on this path.
  const conversation = conversationOf(wm, conversationId);
  if (!conversation) return;
  const delta = bytesField(data.bytes);
  const workerVector = bytesField(data.stateVector);
  if (!workerVector) {
    // No vector, no diff to compute — apply what we were given and stop.
    if (delta) conversation.handleYjsSyncMessage(delta);
    return;
  }
  const update = conversation.applyResyncResponse(delta, workerVector);
  if (update) {
    wm.sendToWorker(conversationId, {
      type: 'yjs-sync',
      bytes: bytesToBase64(update)
    });
  }
}

/** @type {InboundHandler} */
function onCancelStrategyExecution(wm, conversationId) {
  // Worker cancelled — abort engine-driven strategy execution (plan
  // driver) by firing the conversation's stop handlers.
  conversationOf(wm, conversationId)?.cancelStrategyExecution?.();
}

/** @type {InboundHandler} */
function onCreateThreadResponse(wm, _conversationId, data) {
  /** @type {{error: string, cancelled: boolean}|{threadItemId: string, result: string}} */
  const outcome = data.error
    ? { error: String(data.error), cancelled: !!data.cancelled }
    : {
      threadItemId: /** @type {string} */ (/** @type {any} */ (data).threadItemId),
      result: /** @type {string} */ (data.result)
    };
  wm.settleThreadRequest(/** @type {string} */ (data.requestId), outcome);
}

/** @type {InboundHandler} */
function onError(wm, conversationId, data) {
  console.error(`[WorkerManager] Worker error for ${conversationId}:`, data.message, data.stack);
  // An error arriving before ready IS the answer to the init: the worker
  // could not load the conversation and will send nothing further. Fail
  // the waiters now so the panel offers Retry, instead of leaving them to
  // time out a minute later on a spinner that was never going to end.
  // After ready, the conversation carries its own errors through Yjs.
  wm.failPendingReady(conversationId, data.message ? String(data.message) : `Worker error for ${conversationId}`);
}

/** @type {InboundHandler} */
function onValidationError(wm, conversationId, data) {
  // Show validation error in composer warning
  if (!data.message) return;
  const conversation = conversationOf(wm, conversationId);
  if (!conversation) {
    console.warn(`[WorkerManager] No conversation found for ${conversationId}`);
    return;
  }
  conversation.showWarning(data.message);
  conversation.restorePendingMessage();
}

/** @type {InboundHandler} */
function onStatus(wm, conversationId) {
  // Processing state syncs via Yjs metadata (doc.metadata.processingState),
  // which LLMState observes directly — this message carries nothing of its
  // own. What it is, is the worker announcing a state transition, and the
  // write it announces is sitting in the inbound sync batch behind a 50ms
  // timer. Everything that asks "is this conversation busy" reads that
  // metadata (llmState, the bin guard, the attention edges), so applying
  // the batch here is what keeps those answers from being one window out
  // of date. Transitions only — the streaming firehose stays batched.
  conversationOf(wm, conversationId)?.flushPendingSyncs?.();
}

/** @type {InboundHandler} */
function onAck(wm, _conversationId, data) {
  if (data.ackId) wm.settleAck(data.ackId, data.result);
}

/** @type {InboundHandler} */
function onSaveError(_wm, conversationId, data) {
  console.error(`[WorkerManager] Save failed for ${conversationId}:`, data.error);
}

/**
 * Every message type a worker sends, and what this client does with it.
 *
 * The engine-only entries (`render-context-items-request`,
 * `build-subthread-spec`, the two hook runners and the three tool commands)
 * run async and reply for themselves, or not at all: the worker re-drives tool
 * commands from document state, so a command that could not act leaves its
 * tool where it was. Their rejections are reported by the router.
 * @type {ReadonlyMap<string, InboundHandler>}
 */
export const INBOUND_HANDLERS = new Map(/** @type {Array<[string, InboundHandler]>} */ ([
  ['ready', onReady],
  ['yjs-sync', onYjsSync],
  ['resync-offer', onResyncOffer],
  ['resync-response', onResyncResponse],
  ['render-context-items-request', (wm, id, data) => protocols.handleRenderContextItemsRequest(wm, id, data)],
  ['request-tools', (wm, id, data) => protocols.handleRequestTools(wm, id, data)],
  ['build-subthread-spec', (wm, id, data) => protocols.handleBuildSubthreadSpec(wm, id, data)],
  ['approval-request', (wm, id, data) => protocols.handleApprovalRequest(wm, id, data)],
  ['run-strategy-hook', (wm, id, data) => protocols.handleRunStrategyHook(wm, id, data)],
  ['run-context-hook', (wm, id, data) => protocols.handleRunContextHook(wm, id, data)],
  ['evaluate-tool', (wm, id, data) => protocols.handleEvaluateTool(wm, id, /** @type {string} */ (data.toolUseId))],
  ['execute-tool', (wm, id, data) => protocols.handleExecuteTool(wm, id, /** @type {string} */ (data.toolUseId))],
  ['cancel-tool', (wm, id, data) => protocols.handleCancelTool(wm, id, /** @type {string} */ (data.toolUseId), data.runningEpoch)],
  ['cancel-strategy-execution', onCancelStrategyExecution],
  ['create-thread-response', onCreateThreadResponse],
  ['error', onError],
  ['validation-error', onValidationError],
  ['status', onStatus],
  ['ack', onAck],
  ['save-error', onSaveError],
]));

/**
 * Hand one worker message to its handler.
 *
 * A handler that throws synchronously throws to the caller, as any message
 * listener would. One that returns a promise is not awaited, so its rejection
 * is reported here under the message's type rather than going unhandled.
 * @param {WorkerManager} wm - The manager the message arrived on
 * @param {string} conversationId - Conversation the message is about
 * @param {WorkerMessage} data - The message
 * @returns {void}
 */
export function routeWorkerMessage(wm, conversationId, data) {
  const handler = INBOUND_HANDLERS.get(data.type);
  if (!handler) {
    if (!data.type?.startsWith('debug-')) {
      console.warn(`[WorkerManager] Unknown message from worker ${conversationId}:`, data.type);
    }
    return;
  }
  const outcome = handler(wm, conversationId, data);
  if (outcome && typeof outcome.then === 'function') {
    outcome.then(undefined, (err) => {
      console.error(`[WorkerManager] ${data.type} failed:`, err);
    });
  }
}
