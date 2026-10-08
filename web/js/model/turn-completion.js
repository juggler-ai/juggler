//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * When a turn is over, and how to wait for that.
 *
 * The one correct way to wait for the worker: observe a DURABLE,
 * level-triggered terminal condition, never a transient state edge. The worker
 * bumps a monotonic counter in the durable `completedTurns` metadata key on
 * every idle transition (`cmd/juggler/worker/worker.go` sendStatus), and
 * `Conversation.completedTurns` exposes it. Fencing on that counter is immune to
 * Yjs sync batching — a fast turn whose busy→idle window coalesces into a single
 * broadcast still advances the counter — and to the stale-idle race, where the
 * idle being read is the one left over from the previous turn, in one condition.
 *
 * A turn that stops on a tool awaiting approval is terminal too, and the
 * distinction between that and a finished turn is the whole difference between a
 * result and a hang: interactively it is a question for the user, but nothing
 * unattended can answer it, so the outcome names the tool rather than reporting
 * success. Nothing here times anything out — a parked tool waits indefinitely by
 * design, so the deadline belongs to whoever started the turn.
 * @module model/turn-completion
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import { isRestingStatus } from './processing-status.js';

/**
 * Single-pass scan of the tool states the turn fence needs, so a wait walks the
 * item tree (including nested threads) once per observer fire rather than once
 * per question asked of it.
 * @param {any[]} items - Items to scan
 * @returns {{hasIncomplete: boolean, hasPending: boolean, pendingTool: string}} In-flight-result and pending-approval flags, plus the first tool awaiting approval
 */
export function scanToolStates(items) {
  let hasIncomplete = false;
  let hasPending = false;
  let pendingTool = '';
  const walk = (/** @type {any[]} */ list) => {
    if (!list) return;
    for (const item of list) {
      const type = item.get('type');
      if (type === 'tool-action') {
        const state = item.get('state');
        const result = item.get('result');
        if ((state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED) &&
          (result === undefined || result === null)) hasIncomplete = true;
        if (state === TOOL_STATES.PENDING) {
          hasPending = true;
          if (!pendingTool) pendingTool = String(item.get('toolName') || '');
        }
      } else if (type === 'thread') {
        const nested = item.get('items');
        if (nested) walk(nested.toArray ? nested.toArray() : []);
      }
    }
  };
  walk(items);
  return { hasIncomplete, hasPending, pendingTool };
}

/**
 * Whether a turn has reached a durable terminal state, and which one.
 *
 * Terminal, with no approved tool still executing, when EITHER a tool-action is
 * pending approval (the turn is parked for the user) OR the worker is at rest
 * (idle, or a terminal-error status; see `model/processing-status.js`) —
 * and, in **fence mode**, `completedTurns` has advanced past `sinceTurn`, so a
 * genuinely new turn finished rather than a stale idle being read.
 *
 * Pass `sinceTurn = conversation.completedTurns` captured *before* the action
 * that starts the turn (send / compact). Omit it for **settle mode**, where the
 * current turn just needs to quiesce and no new turn epoch is expected.
 * @param {any} conversation - Conversation instance
 * @param {any[]} items - The root thread's items
 * @param {{sinceTurn?: number}} [opts]
 * @returns {{done: boolean, parked: boolean, parkedTool: string}} Terminal state, and the tool parked on when there is one
 */
export function inspectTurn(conversation, items, { sinceTurn } = {}) {
  const notDone = { done: false, parked: false, parkedTool: '' };
  const { hasIncomplete, hasPending, pendingTool } = scanToolStates(items);
  // An approved tool is still running — hold, even if a sibling is pending.
  if (hasIncomplete) return notDone;
  // Parked for user input — terminal regardless of phase, because the worker
  // keeps its claim while it waits and so never reaches idle on its own.
  if (hasPending) return { done: true, parked: true, parkedTool: pendingTool };
  // Read processingState ONCE (the durable signal the worker writes) and derive
  // the phase from it. The top-level projection is the right read here: this
  // asks whether the CONVERSATION has quiesced, and the projection reports a
  // running status while any of its threads still holds a run. A frame with no
  // status yet is a dispatch about to start, so only a resting status settles.
  const ps = conversation.processingState;
  if (ps && !isRestingStatus(ps.status)) return notDone;
  // At rest. Fence mode additionally requires a NEW completed turn. The counter
  // lives in its own `completedTurns` metadata key (read via the getter), not
  // inside the ephemeral processingState blob.
  const fenced = typeof sinceTurn === 'number' ? conversation.completedTurns > sinceTurn : true;
  return fenced ? { done: true, parked: false, parkedTool: '' } : notDone;
}

/**
 * Resolve when `predicate(items, processingState)` is truthy, observing the
 * conversation until it is.
 *
 * The root map is observed deeply rather than `root.get('items')` directly: a
 * just-created conversation may not have its items array yet, and a deep root
 * observer both survives that and fires when the array appears and on every
 * nested change thereafter. The predicate is also evaluated once up front, so a
 * condition already satisfied resolves without waiting for a change that may
 * never come.
 * @param {any} conversation - Conversation instance
 * @param {(items: any[], ps: any) => boolean} predicate - Terminal condition
 * @param {{timeoutMs?: number, signal?: AbortSignal, label?: string}} [opts]
 * @returns {Promise<void>} Rejects on timeout, on abort, or if the predicate throws
 */
export function observeUntil(conversation, predicate, { timeoutMs = 5000, signal, label = '' } = {}) {
  const doc = conversation._doc;
  const metadata = doc.metadata;
  const root = doc.root;
  const suffix = label ? `: ${label}` : '';

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Aborted waiting for condition${suffix}`));
      return;
    }

    const cleanup = () => {
      metadata.unobserve(check);
      root.unobserveDeep(check);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error(`Aborted waiting for condition${suffix}`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for condition${suffix}`));
    }, timeoutMs);

    const check = () => {
      const items = conversation.rootMessageThread.items || [];
      const ps = metadata.get('processingState');
      let matched = false;
      try {
        matched = !!predicate(items, ps);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (matched) {
        cleanup();
        resolve();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    metadata.observe(check);
    root.observeDeep(check);
    check();
  });
}

/**
 * Wait for a turn to reach a durable terminal state and report which one.
 * @param {any} conversation - Conversation instance
 * @param {{sinceTurn?: number, timeoutMs?: number, signal?: AbortSignal, label?: string}} [opts]
 * @returns {Promise<{parked: boolean, parkedTool: string}>} How the turn ended; rejects on timeout or abort
 */
export async function waitForTurnOutcome(conversation, { sinceTurn, timeoutMs = 6000, signal, label = '' } = {}) {
  let outcome = { done: true, parked: false, parkedTool: '' };
  await observeUntil(conversation, (items) => {
    const state = inspectTurn(conversation, items, { sinceTurn });
    if (state.done) outcome = state;
    return state.done;
  }, { timeoutMs, signal, label: label || 'turn complete' });
  return { parked: outcome.parked, parkedTool: outcome.parkedTool };
}
