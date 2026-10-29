//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Turn-completion synchronization for the test harnesses: the per-test deadline
 * policy, wrapped around the model's own turn fence.
 *
 * What "the turn is over" means lives in `model/turn-completion.js`, which the
 * engine's unattended runs wait on too — one definition, so a harness and a
 * `juggler run` cannot disagree about whether a turn finished. What lives here
 * is the part that is only a test's business: how patient to be, and the
 * abort/deadline wiring the runner drives it with.
 * @module test/utilities/turn-sync
 */

import { inspectTurn, observeUntil as observeUntilTerminal, scanToolStates } from '../../js/model/turn-completion.js';
import { threadRunSettled } from '../../js/model/run-records.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import { trackWait } from './test-patience.js';
import { deadlineTimer } from './test-deadline.js';

/**
 * Longer than any test runs. The model's own wait is handed this so its timer
 * never decides; the deadline-following timer below does.
 */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Recursively walk items (including thread nested arrays) looking for a match.
 * @param {any[]} items - Items to search
 * @param {(item: any) => boolean} predicate - Return true to match
 * @returns {boolean} True if predicate matched any item
 */
export function findItemRecursive(items, predicate) {
  if (!items) return false;
  for (const item of items) {
    if (predicate(item)) return true;
    if (item.get('type') === 'thread') {
      const nested = item.get('items');
      if (nested) {
        const nestedItems = nested.toArray ? nested.toArray() : [];
        if (findItemRecursive(nestedItems, predicate)) return true;
      }
    }
  }
  return false;
}

/**
 * True if any approved/running tool-action is still missing its result
 * (recursively). The worker can flip to idle before the frontend finishes
 * executing an approved tool, so this guards against resolving a wait while a
 * tool result is still in flight (which would race document assertions). Thin
 * view over scanToolStates.
 * @param {any[]} items - Items to search
 * @returns {boolean} True if an approved/running tool is still awaiting its result
 */
export function hasIncompleteApprovedTools(items) {
  return scanToolStates(items).hasIncomplete;
}

/**
 * What a harness wait on the turn last saw, for its failure line: the worker's
 * frame, the turn counter, every sub-thread with its run and whether the worker
 * is driving it, and every tool not yet done.
 *
 * Each of those is a different half that can fail to happen — a cancel the
 * worker never acted on, a thread whose run was never stamped, a tool whose
 * result never came back — and a bare "timed out waiting for idle" names none
 * of them.
 * @param {any} conversation - Conversation instance.
 * @returns {string} One line.
 */
function describeTurnState(conversation) {
  const ps = conversation.processingState;
  const frame = ps
    ? `status=${ps.status ?? '(none)'}${ps.threadId ? ` thread=${ps.threadId}` : ''}${ps.activity ? ` activity=${ps.activity}` : ''}`
    : 'no processingState';
  /** @type {string[]} */
  const threads = [];
  /** @type {string[]} */
  const tools = [];
  const walk = (/** @type {any[]} */ list) => {
    for (const item of list) {
      const type = item.get('type');
      if (type === 'tool-action') {
        const state = item.get('state');
        const result = item.get('result');
        const hasResult = result !== undefined && result !== null;
        if (!hasResult || state === TOOL_STATES.PENDING) {
          tools.push(`${item.get('toolName')}#${item.get('toolUseId')} ${state}${hasResult ? ' (has result)' : ''}`);
        }
      } else if (type === 'thread') {
        const id = item.get('itemId');
        threads.push(`${id} run=${threadRunSettled(item) ? 'settled' : 'open'} driven=${conversation.isThreadProcessing?.(id) === true}`);
        const nested = item.get('items');
        if (nested?.toArray) walk(nested.toArray());
      }
    }
  };
  walk(conversation.rootMessageThread?.items || []);
  return `${frame}, completedTurns=${conversation.completedTurns}, root driven=${conversation.isThreadProcessing?.(null) === true}; ` +
    `threads [${threads.join('; ')}]; tools not done [${tools.join('; ')}]`;
}

/**
 * The shared observe-until-predicate wait, carrying the harnesses' deadline
 * policy. Resolves when `predicate(items, ps)` is truthy (ps = raw metadata
 * processingState), rejects if the predicate throws (constraint-violation path),
 * on timeout, or on abort.
 *
 * Patience: a real future `deadlineMs` bounds the wait (+1s so the runner's hard
 * timeout fires first with the full op trace); a falsy deadline (0 sentinel /
 * undefined) falls back to `timeoutMs`. `signal` tears the wait down at the
 * per-test deadline. This is the ONLY place that deadline policy lives, so a
 * blanket change can't silently corrupt one caller.
 *
 * Every wait says what it last saw ({@link describeTurnState}): on its own
 * rejection, and in the runner's failure block while it is still open, where a
 * stall reports it ({@link trackWait}).
 * @param {any} conversation - Conversation instance
 * @param {(items: any[], ps: any) => boolean} predicate
 * @param {{deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function observeUntil(conversation, predicate, { deadlineMs, signal, timeoutMs = 5000, label = '' } = {}) {
  const effectiveTimeoutMs = deadlineMs
    ? Math.max(0, deadlineMs - Date.now() + 1000)
    : timeoutMs;
  const saw = () => {
    try { return describeTurnState(conversation); }
    catch (e) { return `(the state could not be read: ${e instanceof Error ? e.message : String(e)})`; }
  };
  const close = trackWait(() => `${label || 'a condition on the conversation'} — saw ${saw()}`);
  // The model's wait gets no timer of its own. Expiry is the
  // deadline-following timer's, which waits on as long as the runner keeps
  // moving the deadline for a test that is making progress.
  const stop = new AbortController();
  let expired = false;
  const onOuterAbort = () => stop.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (signal?.aborted) stop.abort();
  const cancelTimer = deadlineTimer(() => { expired = true; stop.abort(); }, effectiveTimeoutMs);
  try {
    await observeUntilTerminal(conversation, predicate, { timeoutMs: NO_TIMEOUT_MS, signal: stop.signal, label });
    close('satisfied');
  } catch (err) {
    close('threw');
    if (expired && err instanceof Error && /^Aborted waiting for condition/.test(err.message)) {
      err.message = err.message.replace(/^Aborted/, 'Timeout');
    }
    // The predicate's own throw is a constraint violation with its own words;
    // only the wait's timeout or abort is missing what it saw.
    if (err instanceof Error && /waiting for condition/.test(err.message)) {
      err.message = `${err.message} — saw ${saw()}`;
    }
    throw err;
  } finally {
    cancelTimer();
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Wait for a worker turn to reach a durable terminal state, as
 * `model/turn-completion.js` defines it: no approved tool still executing, and
 * either a tool-action parked for approval or an idle worker whose
 * `completedTurns` has advanced past `sinceTurn`.
 *
 * Pass `sinceTurn = conversation.completedTurns` captured *before* the action
 * that starts a new turn (send / compact). Omit it for **settle mode** (resume
 * /rerun paths) where the current turn just needs to quiesce and no new turn
 * epoch is expected.
 * @param {any} conversation - Conversation instance
 * @param {{sinceTurn?: number, deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export function waitForTurnComplete(conversation, { sinceTurn, deadlineMs, signal, timeoutMs = 6000, label = '' } = {}) {
  const fence = typeof sinceTurn === 'number';

  const terminal = (/** @type {any[]} */ items) => inspectTurn(conversation, items, { sinceTurn }).done;

  return observeUntil(conversation, terminal, {
    deadlineMs,
    signal,
    timeoutMs,
    label: `${label || 'turn complete'} (fence=${fence} sinceTurn=${sinceTurn})`
  });
}
