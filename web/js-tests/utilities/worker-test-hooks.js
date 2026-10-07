//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker messages only tests send: the drain barrier and the mock-LLM
 * controls. The worker answers them only on a test-mode server. They go
 * through the manager's ordinary `sendToWorker`/`sendWithAck`, so they are
 * ordered with every other message to the same conversation.
 * @module js-tests/utilities/worker-test-hooks
 */

import workerManager from '../../js/services/worker-manager.js';
import { recordTape } from '../../js/utils/event-tape.js';

/**
 * Synchronization barrier. The ack returns only after the worker has drained
 * its inbound queue (every prior message processed, every observer fired)
 * AND flushed its outbound Yjs batcher. Resolves on the next microtask so the
 * main-thread Yjs observers triggered by that final sync have a chance to run
 * before the caller's next line.
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<void>}
 */
export async function pingWorker(conversationId) {
  // Patient timeout: the barrier legitimately takes as long as the worker's
  // inbound queue is deep — under the 9-lane test pool a heavy undo storm
  // can push a full drain past the default 5s. The per-test hard timeout
  // remains the fail-fast bound for a genuinely wedged worker.
  await workerManager.sendWithAck(conversationId, { type: 'ping' }, 30000);
  await Promise.resolve();
}

/**
 * Set mock LLM responses. While set, the worker's callLLM() returns these
 * instead of calling a real LLM. Ack'd, so the worker has them before the test
 * sends its first message.
 * @param {string} conversationId - Conversation ID
 * @param {Array<{blocks: Array<{type: string, content?: string, text?: string, thinking?: string, toolUseId?: string, toolName?: string, toolInput?: object}>, stopReason: string, inputTokens?: number, outputTokens?: number}>} responses - Mock responses to inject
 * @returns {Promise<void>}
 */
export async function setMockResponses(conversationId, responses) {
  recordTape('mock-llm', conversationId, { action: 'set', count: responses.length });
  await workerManager.sendWithAck(conversationId, {
    type: 'set-mock-responses',
    responses
  }, 5000);
}

/**
 * Release a paused mock response. Worker uses MockResponse.PauseBeforeReturn
 * to hold a response between streaming and return — this releases that hold.
 * Idempotent: extra releases are coalesced by the worker's buffered channel.
 * @param {string} conversationId - Conversation ID
 * @returns {void}
 */
export function releaseMock(conversationId) {
  workerManager.sendToWorker(conversationId, { type: 'release-mock' });
}
