//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared test assertion functions.
 * Extracted from integration-test-runner.js to eliminate duplication
 * between the model-level and UI-level operation executors.
 * @module test/utilities/test-assertions
 */

import workerManager from '../../js/services/worker-manager.js';
import { recordTape } from '../../js/utils/event-tape.js';

/**
 * Build a diagnostic string for a blob assertion: which transactionId was
 * selected, every transactionId present on the scanned items (with owning
 * type), and the loaded blob's message roles/count. Appended to failure
 * messages and emitted to the tape so a got-0/got-2 flake is self-explanatory
 * (timing vs wrong-transaction-selection vs real content).
 * @param {string} selectedTxnId
 * @param {any[]} items - The items array that was scanned for a transactionId.
 * @param {{input?: {messages?: any[]}}} blob
 * @param {string} conversationId
 * @returns {string} Diagnostic suffix.
 */
function _blobDiag(selectedTxnId, items, blob, conversationId) {
  const available = items
    .filter(i => i.get?.('transactionId'))
    .map(i => `${i.get?.('type')}:${i.get?.('transactionId')}`);
  // The thread's OWN item contents (what the doc actually holds) — compare
  // against the blob to localize: if these match the expectation but the blob
  // is a different test's, the store served the wrong blob for the correct
  // (convId, txnId); if these ALSO are foreign, the harness resolved the wrong
  // conversation.
  const ownItems = items.map((/** @type {any} */ i) => {
    const t = i.get?.('type');
    const c = i.get?.('content');
    return `${t}:${(typeof c === 'string' ? c : '').slice(0, 30)}`;
  });
  const messages = blob.input?.messages || [];
  const roles = messages.map((/** @type {any} */ m) => {
    const role = m.role || m.type || '?';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `${role}:${(content || '').slice(0, 40)}`;
  });
  return ` [conv=${conversationId} selectedTxn=${selectedTxnId} available=[${available.join(', ')}] ` +
		`ownItems=[${ownItems.join(' | ')}] blobMsgCount=${messages.length} msgs=[${roles.join(' | ')}]]`;
}

/**
 * @typedef {import('./integration-test-runner.js').TestOperation} TestOperation
 */

/**
 * Map from Yjs item type to expected DOM tag name.
 * Used by both UIDriver (for selector generation) and DOM verification.
 * @type {Record<string, string>}
 */
export const ITEM_TYPE_TO_TAG = {
  'system-prompt': 'context-item-message',
  'user': 'user-message',
  'assistant': 'assistant-message',
  'thinking': 'thinking-message',
  'tool-action': 'tool-action-message',
  'error': 'error-message',
  'thread': 'thread-message',
  'context-item': 'context-item-message',
  'file-content': 'context-item-message',
  'memory': 'context-item-message',
};

/**
 * Generate a CSS selector matching all renderable message elements.
 * @returns {string} CSS selector string
 */
export function getMessageSelector() {
  const tags = [...new Set(Object.values(ITEM_TYPE_TO_TAG))];
  return tags.map(tag => `${tag}[message-id]`).join(', ');
}

/**
 * Find the most recent item that carries a transactionId in an items array.
 *
 * Walking backward picks the latest round-trip's blob — for a thread that
 * received a sub-thread's result, that's the continuation blob, which is
 * where you'd expect the propagated content to appear. For single-round-trip
 * threads first == last, so existing assertions remain stable.
 * @param {any[]} items - Y.Map items to scan
 * @returns {string|null} Transaction id, or null if no item is stamped.
 */
function lastTransactionId(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const txnId = items[i].get?.('transactionId');
    if (txnId) return txnId;
  }
  return null;
}

/**
 * Drill into the requested thread (or nested thread) and return its items.
 * @param {any[]} rootItems - Root items array
 * @param {number} threadIndex - 0-based thread index in rootItems
 * @param {number} [nestedThreadIndex] - 0-based thread index inside the outer thread
 * @returns {{thread: any, items: any[]}} Thread Y.Map and its items array
 */
function resolveThread(rootItems, threadIndex, nestedThreadIndex) {
  const threads = rootItems.filter(i => i.get?.('type') === 'thread');
  if (threadIndex >= threads.length) {
    throw new Error(`expected thread at index ${threadIndex}, but only ${threads.length} thread(s) found`);
  }
  let thread = threads[threadIndex];
  let nested = thread.get('items');
  if (!nested) throw new Error(`thread[${threadIndex}] has no nested items array`);

  if (nestedThreadIndex !== undefined) {
    const items = nested.toArray ? nested.toArray() : [];
    const nestedThreads = items.filter((/** @type {any} */ i) => i.get?.('type') === 'thread');
    if (nestedThreadIndex >= nestedThreads.length) {
      throw new Error(`expected nested thread at index ${nestedThreadIndex}, but only ${nestedThreads.length} nested thread(s) found`);
    }
    thread = nestedThreads[nestedThreadIndex];
    nested = thread.get('items');
    if (!nested) throw new Error(`nested thread[${nestedThreadIndex}] has no nested items array`);
  }

  return { thread, items: nested.toArray ? nested.toArray() : [] };
}

/**
 * Fetch the transaction blob for a given conversation/transactionId.
 * @param {string} conversationId
 * @param {string} transactionId
 * @returns {Promise<{input: {systemPrompt: string|null, messages: any[], tools: any[]}}>} The blob.
 */
async function loadBlob(conversationId, transactionId) {
  const blob = await workerManager.getTransaction(conversationId, transactionId);
  if (!blob) {
    throw new Error(`transaction blob ${transactionId} not on disk`);
  }
  return /** @type {{input: {systemPrompt: string|null, messages: any[], tools: any[]}}} */ (blob);
}

/**
 * Validate that a conversation has at least the expected number of LLM
 * round-trips, by counting distinct transactionIds stamped on root items.
 * @param {import('../../js/model/message-thread.js').default} rootThread - Root message thread
 * @param {TestOperation} op - Operation with `count` field
 */
export function assertTransactionMarkers(rootThread, op) {
  const seen = new Set();
  for (const item of rootThread.items) {
    const txnId = item.get?.('transactionId');
    if (txnId) seen.add(txnId);
  }
  if (op.count !== undefined && seen.size !== op.count) {
    throw new Error(`Expected ${op.count} distinct transactions, got ${seen.size}`);
  }
}

/**
 * Validate the LLM-input context blob from the most recent root-level
 * round-trip. Walks back from the end of root items to find one with a
 * transactionId, fetches the blob from disk, and asserts on input.messages.
 * @param {import('../../js/model/message-thread.js').default} rootThread - Root message thread
 * @param {string} conversationId - Conversation id (needed to fetch blob)
 * @param {TestOperation} op - Operation with assertion fields
 * @returns {Promise<void>} Resolves when assertion passes
 */
export async function assertContextSnapshot(rootThread, conversationId, op) {
  const items = rootThread.items;
  let txnId = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const id = items[i].get?.('transactionId');
    if (id) { txnId = id; break; }
  }
  if (!txnId) {
    throw new Error('validate-context-snapshot: no item carries a transactionId yet');
  }
  const blob = await loadBlob(conversationId, txnId);
  const diag = _blobDiag(txnId, items, blob, conversationId);
  recordTape('txn-blob', conversationId, { op: 'snapshot', selectedTxnId: txnId, msgCount: blob.input?.messages?.length ?? 0 });
  try {
    _assertBlobTools(`validate-context-snapshot[${txnId}]`, blob, op);
    _assertBlobMessages(`validate-context-snapshot[${txnId}]`, blob, op);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}${diag}`, { cause: e });
  }
}

/**
 * Validate the LLM-input context blob from a thread's first round-trip.
 * Walks the thread items, finds one with a transactionId, fetches the blob,
 * and asserts on input.messages.
 * @param {import('../../js/model/message-thread.js').default} rootThread - Root message thread
 * @param {string} conversationId - Conversation id (needed to fetch blob)
 * @param {TestOperation} op - Operation with assertion fields
 * @returns {Promise<void>} Resolves when assertion passes
 */
export async function assertThreadContext(rootThread, conversationId, op) {
  const { items } = resolveThread(rootThread.items || [], op.threadIndex ?? 0, op.nestedThreadIndex);

  const txnId = lastTransactionId(items);
  if (!txnId) {
    throw new Error('validate-thread-context: no thread item carries a transactionId yet');
  }
  const blob = await loadBlob(conversationId, txnId);
  const diag = _blobDiag(txnId, items, blob, conversationId);
  recordTape('txn-blob', conversationId, { op: 'thread', selectedTxnId: txnId, msgCount: blob.input?.messages?.length ?? 0 });
  try {
    _assertBlobTools('validate-thread-context', blob, op);
    _assertBlobMessages('validate-thread-context', blob, op);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}${diag}`, { cause: e });
  }
}

/**
 * Shared assertion helpers over a fetched transaction blob.
 * @param {string} label - Test label used in error messages.
 * @param {{input: {systemPrompt: string|null, messages: any[], tools: any[]}}} blob - Loaded transaction blob.
 * @param {TestOperation} op - Operation with assertion fields.
 */
function _assertBlobMessages(label, blob, op) {
  const messages = /** @type {Array<{role?: string, type?: string, content?: string}>} */ (blob.input?.messages || []);

  if (op.expectedMessageCount !== undefined && messages.length !== op.expectedMessageCount) {
    throw new Error(`${label}: expected ${op.expectedMessageCount} messages, got ${messages.length}`);
  }
  if (op.expectedMinMessageCount !== undefined && messages.length < op.expectedMinMessageCount) {
    throw new Error(`${label}: expected at least ${op.expectedMinMessageCount} messages, got ${messages.length}`);
  }

  if (op.expectedMessages) {
    for (const expected of op.expectedMessages) {
      const found = messages.some(m => {
        const role = m.role || m.type || '';
        const content = m.content || '';
        return role === expected.role && content.includes(expected.contentIncludes);
      });
      if (!found) {
        throw new Error(`${label}: expected message with role='${expected.role}' containing '${expected.contentIncludes}' not found`);
      }
    }
  }

  const systemPrompt = blob.input?.systemPrompt || '';
  const allContent = [systemPrompt, ...messages.map(m => m.content || '')].join('\n');
  if (op.expectedContent) {
    for (const expected of op.expectedContent) {
      if (!allContent.includes(expected)) {
        throw new Error(`${label}: expected content '${expected}' not found. spLen=${systemPrompt.length} msgs=${messages.length} spTail=${JSON.stringify(systemPrompt.slice(-300))} msgsContent=${JSON.stringify(messages.map(m => (m.content||'').slice(0,200)))}`);
      }
    }
  }
  if (op.unexpectedContent) {
    for (const unexpected of op.unexpectedContent) {
      if (allContent.includes(unexpected)) {
        throw new Error(`${label}: unexpected content '${unexpected}' found in messages`);
      }
    }
  }
}

/**
 * The tools the round trip offered, as sent: what the worker received from the
 * engine for this turn, after every filter. Checked before the messages,
 * because a tool that was never offered explains whatever the messages show.
 * @param {string} label - Test label used in error messages.
 * @param {{input: {tools: any[]}}} blob - Loaded transaction blob.
 * @param {TestOperation} op - Operation with assertion fields.
 */
function _assertBlobTools(label, blob, op) {
  if (!op.expectedTools) return;
  const tools = /** @type {Array<{name?: string, description?: string}>} */ (blob.input?.tools || []);
  for (const expected of op.expectedTools) {
    const tool = tools.find(t => t.name === expected.name);
    if (!tool) {
      throw new Error(`${label}: tool '${expected.name}' was not offered; offered: ${JSON.stringify(tools.map(t => t.name))}`);
    }
    if (expected.descriptionIncludes && !String(tool.description || '').includes(expected.descriptionIncludes)) {
      throw new Error(`${label}: tool '${expected.name}' description lacks '${expected.descriptionIncludes}': ${JSON.stringify(String(tool.description || '').slice(0, 600))}`);
    }
  }
}
