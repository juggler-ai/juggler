//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Client-side helpers for the per-thread `pendingRequests` Y.Array.
 * Strategies (running on any client) submit a request entry and await its
 * terminal status. The worker is the orchestrator — it observes pendingRequests
 * via `cmd/juggler/worker/pending_requests.go`, dispatches the underlying
 * operation (create-thread, continue), and writes the result back onto the entry.
 *
 * Storage is PER-THREAD (mirrors pending_items.go): the array hangs off the
 * submitting thread's own container — the doc root for the root thread, the
 * thread Y.Map for a sub-thread — so two threads' pending requests never collide
 * and a deleted thread's queue is removed with it. The Go worker reads the same
 * per-thread container.
 *
 * Why a Yjs-mediated trigger: routing the request through the doc makes its
 * state durable across a viewer reload — any client (or a rebuilt strategy
 * after reload) can re-attach an observer to the same entry and recover the
 * answer when it lands, rather than abandoning a per-client promise.
 */

import * as Y from '../vendor/yjs.mjs';

const PENDING_REQUESTS_KEY = 'pendingRequests';

/**
 * Ensure the pendingRequests Y.Array exists on the thread's own container (the
 * doc root for the root thread, the thread Y.Map for a sub-thread). Lazy-creating
 * it keeps the schema additive — pre-existing docs that have never used the array
 * gain it on first write. Per-thread storage mirrors the Go worker's
 * pendingParentMapLocked so both sides read/write the same container.
 * @param {import('../model/message-thread.js').default} thread
 * @returns {any} The Y.Array holding this thread's pending request entries.
 */
function ensurePendingRequests(thread) {
  const container = thread.container;
  let arr = container.get(PENDING_REQUESTS_KEY);
  if (!arr) {
    thread.conversation.atomicUpdate(() => {
      if (!container.get(PENDING_REQUESTS_KEY)) {
        container.set(PENDING_REQUESTS_KEY, new Y.Array());
      }
    });
    arr = container.get(PENDING_REQUESTS_KEY);
  }
  return arr;
}

/**
 * Find a request entry by its stable `id` field. O(n) on the array length;
 * `n` is the count of pending+recently-completed requests, typically <5.
 * @param {any} requests - The pendingRequests Y.Array.
 * @param {string} id - Request id.
 * @returns {any|null} The Y.Map entry, or null if not found.
 */
function findRequestEntry(requests, id) {
  for (let i = 0; i < requests.length; i++) {
    const entry = requests.get(i);
    if (entry && typeof entry.get === 'function' && entry.get('id') === id) {
      return entry;
    }
  }
  return null;
}

/**
 * Submit a request to the conversation's pendingRequests Y.Array and resolve
 * when the engine-side orchestrator writes a terminal status onto the entry.
 *
 * Caller controls only:
 *   - the request payload (via `fillRequest`)
 *   - the abort signal (typically a strategy's _abortController.signal, or
 *     a caller-passed AbortSignal). Abort flips `cancelRequested:true` on
 *     the entry; the orchestrator picks that up and aborts dispatch.
 * @param {import('../model/message-thread.js').default} thread - The submitting thread (owns the queue).
 * @param {'createThread'|'continue'|'deliverTaskOutput'} kind
 * @param {(reqMap: any) => void} fillRequest - Populates the entry's request Y.Map.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{threadItemId: string, result: string}>} Result payload (empty for `continue`).
 */
export function submitPendingRequest(thread, kind, fillRequest, signal) {
  const conversation = thread.conversation;
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const requests = ensurePendingRequests(thread);

  conversation.atomicUpdate(() => {
    const entry = new Y.Map();
    entry.set('id', id);
    entry.set('kind', kind);
    entry.set('status', 'requested');
    entry.set('claimedBy', null);
    entry.set('claimSession', null);
    entry.set('requestedBy', conversation.authorId);
    const reqMap = new Y.Map();
    fillRequest(reqMap);
    entry.set('request', reqMap);
    entry.set('result', null);
    entry.set('error', null);
    entry.set('cancelRequested', false);
    entry.set('createdAt', Date.now());
    entry.set('completedAt', null);
    requests.push([entry]);
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return true;
      settled = true;
      requests.unobserveDeep(check);
      signal?.removeEventListener('abort', onAbort);
      return false;
    };

    const check = () => {
      const entry = findRequestEntry(requests, id);
      if (!entry) return;
      const status = entry.get('status');
      if (status === 'completed') {
        const resultMap = entry.get('result');
        const threadItemId = resultMap?.get?.('threadItemId') ?? '';
        const result = resultMap?.get?.('result') ?? '';
        if (finish()) return;
        resolve({ threadItemId, result });
      } else if (status === 'error') {
        const msg = entry.get('error') || `${kind} failed`;
        if (finish()) return;
        reject(new Error(msg));
      } else if (status === 'cancelled') {
        const msg = entry.get('error') || 'Operation aborted';
        if (finish()) return;
        const err = new Error(msg);
        err.name = 'AbortError';
        reject(err);
      }
    };

    const onAbort = () => {
      const entry = findRequestEntry(requests, id);
      if (entry && !['completed', 'error', 'cancelled'].includes(entry.get('status'))) {
        conversation.atomicUpdate(() => {
          entry.set('cancelRequested', true);
        });
      }
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    requests.observeDeep(check);
    check();
  });
}

