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
import { serverText } from '../../sdk/lib/i18n.js';
import { setBootstrapSummarizationPrompt } from '../utils/compaction-utils.js';

/**
 * @typedef {import('./worker-manager.js').WorkerManager} WorkerManager
 */

// ============================================================================
// The messages, one shape per wire type
// ============================================================================
//
// Each is the message as the worker's struct marshals it. The shapes are
// generated from cmd/juggler/worker (protocol/worker-wire-types.gen.js) and held
// to the structs by TestWireTypedefs, so a renamed or retyped field fails
// checkJs here. The conversation a message is about travels in the envelope
// around it, not in it. Go `[]byte` fields arrive as base64 strings.

/** @typedef {import('../protocol/worker-wire-types.gen.js').ReadyMessage} ReadyMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').YjsSyncMessage} YjsSyncMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').ResyncOfferMessage} ResyncOfferMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').ResyncResponseMessage} ResyncResponseMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').RenderContextItemsRequest} RenderContextItemsRequestMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').RequestToolsMessage} RequestToolsMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').BuildSubthreadSpecRequest} BuildSubthreadSpecMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').RunStrategyHookRequest} RunStrategyHookMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').RunContextHookRequest} RunContextHookMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').EvaluateToolMessage} EvaluateToolMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').ExecuteToolMessage} ExecuteToolMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').CancelToolMessage} CancelToolMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').CancelStrategyExecutionMessage} CancelStrategyExecutionMessage */
/** @typedef {import('../protocol/worker-wire-types.gen.js').CreateThreadResponse} CreateThreadResponseMessage */

/**
 * The worker's own error, or the one the server sends in a worker's place for
 * a conversation it declined to open — which carries its words as a message
 * too (`text`).
 * @typedef {import('../protocol/worker-wire-types.gen.js').ErrorMessage|import('../protocol/server-wire-types.gen.js').ErrorFrame} ErrorMessage
 */

/**
 * A transition of the worker's processing state, which itself syncs through
 * the document's metadata. The mock LLM's pause names no thread.
 * @typedef {import('../protocol/worker-wire-types.gen.js').StatusMessage|import('../protocol/worker-wire-types.gen.js').MockPausedStatusMessage} StatusMessage
 */

/** @typedef {import('../protocol/worker-wire-types.gen.js').AckMessage} AckMessage */

/**
 * Any message a worker sends a client, told apart by `type`.
 * @typedef {ReadyMessage|YjsSyncMessage|ResyncOfferMessage|ResyncResponseMessage
 *   |RenderContextItemsRequestMessage|RequestToolsMessage|BuildSubthreadSpecMessage
 *   |RunStrategyHookMessage|RunContextHookMessage
 *   |EvaluateToolMessage|ExecuteToolMessage|CancelToolMessage
 *   |CancelStrategyExecutionMessage|CreateThreadResponseMessage|ErrorMessage
 *   |StatusMessage|AckMessage} WorkerMessage
 */

/**
 * A handler, as the table holds it. Each is written against its own message's
 * shape and enters the table through {@link entry}, which checks that pairing.
 * @typedef {(wm: WorkerManager, conversationId: string, data: any) => (void|Promise<unknown>)} InboundHandler
 */

/**
 * A handler for one message type, against that type's shape.
 * @template {WorkerMessage['type']} K
 * @typedef {(wm: WorkerManager, conversationId: string, data: Extract<WorkerMessage, {type: K}>) => (void|Promise<unknown>)} HandlerFor
 */

/**
 * One table row: a type and the handler for it, checked against each other.
 * @template {WorkerMessage['type']} K
 * @param {K} type - The wire type
 * @param {HandlerFor<K>} handler - Its handler
 * @returns {[string, InboundHandler]} The row
 */
function entry(type, handler) {
  return [type, handler];
}

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

/** @type {HandlerFor<'ready'>} */
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

/** @type {HandlerFor<'yjs-sync'>} */
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
      wm.loader.autoLoad(conversationId, data.bytes);
    }
    return;
  }
  conversation.handleYjsSyncMessage(/** @type {Uint8Array} */ (bytesField(data.bytes)));
}

/** @type {HandlerFor<'resync-offer'>} */
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

/** @type {HandlerFor<'resync-response'>} */
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

/** @type {HandlerFor<'cancel-strategy-execution'>} */
function onCancelStrategyExecution(wm, conversationId) {
  // Worker cancelled — abort engine-driven strategy execution (plan
  // driver) by firing the conversation's stop handlers.
  conversationOf(wm, conversationId)?.cancelStrategyExecution?.();
}

/** @type {HandlerFor<'create-thread-response'>} */
function onCreateThreadResponse(wm, _conversationId, data) {
  /** @type {{error: string}|{threadItemId: string, result: string}} */
  const outcome = data.error
    ? { error: String(data.error) }
    : {
      threadItemId: /** @type {string} */ (data.threadItemId),
      result: /** @type {string} */ (data.result)
    };
  wm.settleThreadRequest(data.requestId, outcome);
}

/** @type {HandlerFor<'error'>} */
function onError(wm, conversationId, data) {
  console.error(`[WorkerManager] Worker error for ${conversationId}:`, data.message, 'stack' in data ? data.stack : '');
  // An error arriving before ready IS the answer to the init: the worker
  // could not load the conversation and will send nothing further. Fail
  // the waiters now so the panel offers Retry, instead of leaving them to
  // time out a minute later on a spinner that was never going to end.
  // After ready, the conversation carries its own errors through Yjs.
  // A server-built error carries its words as a message too (`text`).
  wm.failPendingReady(conversationId, data.message
    ? serverText('text' in data ? data.text : null, String(data.message))
    : `Worker error for ${conversationId}`);
}

/** @type {HandlerFor<'status'>} */
function onStatus(wm, conversationId, data) {
  // Processing state syncs via Yjs metadata (doc.metadata.processingState),
  // which LLMState observes directly — this message carries nothing of its
  // own. What it is, is the worker announcing a state transition, and the
  // write it announces is sitting in the inbound sync batch behind a 50ms
  // timer. Everything that asks "is this conversation busy" reads that
  // metadata (llmState, the bin guard, the attention edges), so applying
  // the batch here is what keeps those answers from being one window out
  // of date. Transitions only — the streaming firehose stays batched.
  const conversation = conversationOf(wm, conversationId);
  conversation?.flushPendingSyncs?.();
  // A validation-error is a notice as well as a rest, and this event is where
  // it is read: the frame can lose it to a sibling run (see
  // Conversation.handleValidationNotice).
  if (data.status === 'validation-error') conversation?.handleValidationNotice?.(data);
}

/** @type {HandlerFor<'ack'>} */
function onAck(wm, _conversationId, data) {
  if (data.ackId) wm.settleAck(data.ackId, data.result);
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
export const INBOUND_HANDLERS = new Map([
  entry('ready', onReady),
  entry('yjs-sync', onYjsSync),
  entry('resync-offer', onResyncOffer),
  entry('resync-response', onResyncResponse),
  entry('render-context-items-request', (wm, id, data) => protocols.handleRenderContextItemsRequest(wm, id, data)),
  entry('request-tools', (wm, id, data) => protocols.handleRequestTools(wm, id, data)),
  entry('build-subthread-spec', (wm, id, data) => protocols.handleBuildSubthreadSpec(wm, id, data)),
  entry('run-strategy-hook', (wm, id, data) => protocols.handleRunStrategyHook(wm, id, data)),
  entry('run-context-hook', (wm, id, data) => protocols.handleRunContextHook(wm, id, data)),
  entry('evaluate-tool', (wm, id, data) => protocols.handleEvaluateTool(wm, id, data.toolUseId)),
  entry('execute-tool', (wm, id, data) => protocols.handleExecuteTool(wm, id, data.toolUseId, bytesField(data.stateVector))),
  entry('cancel-tool', (wm, id, data) => protocols.handleCancelTool(wm, id, data.toolUseId, data.runningEpoch)),
  entry('cancel-strategy-execution', onCancelStrategyExecution),
  entry('create-thread-response', onCreateThreadResponse),
  entry('error', onError),
  entry('status', onStatus),
  entry('ack', onAck),
]);

/**
 * Hand one worker message to its handler.
 *
 * A handler that throws synchronously throws to the caller, as any message
 * listener would. One that returns a promise is not awaited, so its rejection
 * is reported here under the message's type rather than going unhandled.
 * @param {WorkerManager} wm - The manager the message arrived on
 * @param {string} conversationId - Conversation the message is about
 * @param {WorkerMessage|{type: string}} data - The message; a type outside the
 *   vocabulary is reported, not handled
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
