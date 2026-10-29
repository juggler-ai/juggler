//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Run records.
 *
 * A thread is a sequence of RUNS over one accumulating transcript: a run is one
 * message appended to the thread, the tool loop that message drives, and the
 * rest at the end of it. The message that starts a run carries that run's
 * record — `runStatus`/`runResult` once it settles — and that record, not the
 * thread's `result`, is what tells a parked caller the run is over. (`result`
 * is the thread's current summary; it outlives the run that wrote it.)
 *
 * The worker settles the runs it drives. This covers the one case it cannot: a
 * stop that reaches a thread the worker is not driving — a child spawned but
 * never dispatched — which would otherwise leave its caller waiting for a run
 * that is never going to happen.
 *
 * Pure Y.Map/Y.Array walking; callers wrap the write in their own transaction.
 */

import { plainToYMap } from './item-accessor.js';

/**
 * Run status for a cancelled or interrupted run. Matches the Go spelling
 * (worker/run_records.go); the two writers must agree.
 * @type {string}
 */
export const RUN_STATUS_CANCELLED = 'cancelled';

/**
 * Run status for a run that came to rest on a clean reply. Matches the Go
 * spelling (worker/run_records.go).
 * @type {string}
 */
const RUN_STATUS_REST = 'rest';

/**
 * Run status for a run that stopped on an error item. Matches the Go spelling
 * (worker/run_records.go).
 * @type {string}
 */
const RUN_STATUS_ERROR = 'error';

/**
 * What a cancelled run reports to whoever called it.
 * @type {string}
 */
export const RUN_CANCELLED_NOTE = '[The run was cancelled before it finished.]';

/**
 * The messages of a thread's current run — the user items standing after the
 * last run to settle. Empty when that run has already settled, or the thread has
 * no message to stamp.
 *
 * A run is usually one message, but a human can type into a thread while its run
 * is in flight and the loop absorbs that message into the same run. The outcome
 * goes on all of them: the invocation message carries the tool-use coordinates
 * the caller's `tool_result` is paired by, and the trailing message is where
 * threadRunSettled asks whether the thread is still working. Mirrors
 * openRunMessagesLocked in worker/run_records.go.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {any[]} The open run's item Y.Maps, newest first.
 */
function openRunMessages(threadYMap) {
  const items = threadYMap?.get?.('items');
  if (!items || typeof items.toArray !== 'function') return [];
  const arr = items.toArray();
  const open = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') !== 'user') continue;
    if (item.get('runStatus')) break;
    open.push(item);
  }
  return open;
}

/**
 * Whether a thread's most recent run has settled — the "is this child
 * finished?" question, asked of the run rather than of `result`, which is the
 * thread's summary and outlives the run that wrote it. A thread whose
 * transcript records no run at all answers from `result` instead: a thread
 * summarised from the footer, and every document written before run records
 * existed, record completion only there.
 *
 * A compaction fold answers from `result` too: it is not a run but a container
 * of folded transcript, so run records found inside one belong to whatever it
 * swallowed, not to it. Mirrors threadRunSettled in worker/run_records.go.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {boolean} True when the thread's latest run is over.
 */
export function threadRunSettled(threadYMap) {
  if (threadYMap?.get?.('boundedCompaction') !== true) {
    const items = threadYMap?.get?.('items');
    const arr = items && typeof items.toArray === 'function' ? items.toArray() : [];
    let settled = false;
    let hasRuns = false;
    let seenStarter = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (typeof item?.get !== 'function') continue;
      const status = item.get('runStatus');
      // Only user items carry run records. A nested thread item carries the same
      // coordinates to name its own run (model/thread-alias.js), and counting
      // one would answer this thread's liveness with a question about a child's.
      if (item.get('type') === 'user' && (status || item.get('runToolUseId'))) hasRuns = true;
      if (!seenStarter && item.get('type') === 'user') {
        seenStarter = true;
        settled = !!status;
      }
      if (hasRuns && seenStarter) break;
    }
    if (hasRuns) return settled;
  }
  const result = threadYMap?.get?.('result');
  return typeof result === 'string' && result.length > 0;
}

/**
 * A run's trailing assistant text — what a cancelled run hands back alongside
 * the reason. Yields the content ONLY when the last item that encodes a state
 * transition is a non-empty assistant message; any trailing tool-action,
 * meta-tool-result, user or thread item means the run had no clean reply to
 * return. Mirrors selectThreadFallbackResult in worker/thread_reducer.go, whose
 * `effectiveItems` filter this list of types is.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {string} The trailing reply, or ''.
 */
function trailingReply(threadYMap) {
  const items = threadYMap?.get?.('items');
  if (!items || typeof items.toArray !== 'function') return '';
  const arr = items.toArray();
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function') continue;
    const type = item.get('type');
    if (type === 'assistant') return item.get('content') || '';
    if (type === 'user' || type === 'tool-action' || type === 'meta-tool-result' || type === 'thread') {
      return '';
    }
  }
  return '';
}

/**
 * Settle a thread's open run as cancelled, so nothing parked on it keeps
 * waiting. No-op when that run has already settled — the worker settles the run
 * it was driving itself, and it gets there first.
 *
 * What the run produced before it was stopped goes back with the reason
 * appended, exactly as the worker's own cancelled path composes it: a stopped
 * run that had already answered is worth more to its caller than the bare note.
 *
 * Writes no summary: the thread's own transcript shows what happened, and
 * passing a stop off as the thread's result would be a lie the tile repeats.
 * @param {any} threadYMap - The thread Y.Map.
 * @param {() => string} [mintItemId] - Mints an itemId, for the receipt this may
 *   have to append (see reportRunToParent). Omit only where the caller knows the
 *   thread has no parent item to report to.
 * @returns {boolean} True when a run was settled.
 */
export function settleRunCancelled(threadYMap, mintItemId) {
  const open = openRunMessages(threadYMap);
  if (!open.length) return false;
  const produced = trailingReply(threadYMap);
  const result = produced ? `${produced}\n\n${RUN_CANCELLED_NOTE}` : RUN_CANCELLED_NOTE;
  for (const item of open) {
    item.set('runStatus', RUN_STATUS_CANCELLED);
    item.set('runResult', result);
  }
  // openRunMessages walks backwards, so the last entry started this run.
  const starter = open[open.length - 1];
  if (mintItemId) {
    reportRunToParent(threadYMap, starter.get('itemId'), starter.get('runToolUseId') || '',
      mintItemId, RUN_STATUS_CANCELLED, result);
  }
  return true;
}

/**
 * The outcome a parent thread item currently displays, and whether the run it
 * names is still in the transcript: the run its `runItemId` names, or — when it
 * names none — the run its own call started. These are the two selectors
 * itemRunRecord reads for an item that has been frozen, so the answer here is
 * what that item's tile is saying now. Mirrors shownRunOutcomeLocked in
 * worker/run_records.go.
 * @param {any} threadYMap - The canonical thread Y.Map holding the transcript.
 * @param {string} runItemId - The itemId the parent item names, or ''.
 * @param {string} toolUseId - The tool-use id of the call it was made by, or ''.
 * @returns {{status: string, result: string}|null} That run's outcome, or null.
 */
function shownRunOutcome(threadYMap, runItemId, toolUseId) {
  if (!runItemId && !toolUseId) return null;
  const items = threadYMap?.get?.('items');
  const arr = typeof items?.toArray === 'function' ? items.toArray() : [];
  for (const item of arr) {
    if (typeof item?.get !== 'function' || item.get('type') !== 'user') continue;
    if (runItemId ? item.get('itemId') !== runItemId : item.get('runToolUseId') !== toolUseId) continue;
    return { status: item.get('runStatus') || '', result: item.get('runResult') || '' };
  }
  return null;
}

/**
 * Item types the worker's `itemWireMessages` emits nothing for, so a turn that
 * left only these produced nothing the model will ever read. Deliberately the
 * conservative subset of that projection: a type missing here is read as loud,
 * which costs a receipt rather than a rewrite.
 * @type {ReadonlySet<string>}
 */
const WIRE_SILENT_ITEM_TYPES = new Set(['error', 'notice']);

/**
 * Whether the parent took the trailing item's result in and produced nothing
 * from it: the turn that read it died, leaving an error item and no reply.
 *
 * `runResultFed` is stamped as the wire is BUILT, so it is stamped by a turn
 * that may then fail — and a turn that failed committed nothing. What the freeze
 * protects is a result the parent has ANSWERED; where no answer stands on it,
 * nothing slides and nothing is contradicted. The evidence is items, not their
 * absence: something must stand after the item, and all of it must be silent on
 * the wire. An item with nothing after it is the ordinary shape of a reply that
 * has not arrived yet.
 *
 * Mirrors fedResultUnansweredLocked in worker/run_records.go, less its
 * mid-request check: that one reads processingState, and this path settles a
 * thread nothing is driving.
 * @param {any[]} arr - The parent's items, in order.
 * @param {number} trailingIndex - Index of the item to report to.
 * @returns {boolean} True when the read produced no answer.
 */
function fedResultUnanswered(arr, trailingIndex) {
  let silent = false;
  for (let i = trailingIndex + 1; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item?.get !== 'function') continue;
    if (!WIRE_SILENT_ITEM_TYPES.has(item.get('type'))) return false;
    silent = true;
  }
  return silent;
}

/**
 * Give a settling run somewhere in the parent to report to, when the item that
 * would otherwise report it has already answered the model.
 *
 * The parent's last item referring to this thread is its live view, and absorbs
 * a run nobody called for as long as its own result is still unsent — nothing
 * has been read, so nothing moves. Once that item's result has gone to the model
 * (`runResultFed`) it is committed history: rewriting it would slide every
 * message after it and cold-start a stateful provider. So a further run is
 * appended as a RECEIPT of its own instead, selecting the run by the message
 * that started it. A result the parent read but never ANSWERED is the exception,
 * and it is the shape a failing child leaves — the turn that read the child's
 * error died on its own (fedResultUnanswered), committing nothing, so the item
 * still standing for the child reports the retry rather than a second one
 * appearing beside it. An unread receipt is re-pointed rather than joined by
 * another, so a child prompted six times leaves the parent one item to read. A
 * run that came out exactly as the one the trailing item already shows is
 * dropped for the same reason read the other way: it is not news, so there is
 * nothing for a receipt to carry, and appending one would stand a tile next to
 * an identical tile.
 *
 * Mirrors reportRunToParentLocked in worker/run_records.go. The worker does this
 * for every run it drives; this covers the runs it does not — a stop that
 * settles a thread the worker is not driving.
 * @param {any} threadYMap - The canonical thread Y.Map, whose run just settled.
 * @param {string} starterItemId - The itemId of the message that started it.
 * @param {string} starterCall - The tool-use id that message was called by, or ''.
 * @param {() => string} mintItemId - Mints the receipt's itemId.
 * @param {string} status - The status that run settled to.
 * @param {string} result - The text that run returns to its caller.
 * @returns {void}
 */
function reportRunToParent(threadYMap, starterItemId, starterCall, mintItemId, status, result) {
  const siblings = threadYMap?.parent;
  const canonicalId = threadYMap?.get?.('itemId');
  if (!starterItemId || !canonicalId || typeof siblings?.insert !== 'function') return;

  const arr = typeof siblings.toArray === 'function' ? siblings.toArray() : [];
  let trailing = null;
  let trailingIndex = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function' || item.get('type') !== 'thread') continue;
    const id = item.get('itemId');
    if (id !== canonicalId && item.get('aliasOf') !== canonicalId) continue;
    trailing = item;
    trailingIndex = i;
    break;
  }
  if (!trailing) return;

  const selector = trailing.get('runToolUseId') || '';
  const runItemId = trailing.get('runItemId');
  // A thread item with no run selector answers no call — a user- or
  // strategy-created thread — so it has no committed pair to protect.
  if (!selector && !runItemId) return;
  if (runItemId === starterItemId) return;

  const recovers = status === RUN_STATUS_REST && lastReadRunFailed(threadYMap, arr, canonicalId);
  if (!trailing.get('runResultFed') || fedResultUnanswered(arr, trailingIndex)) {
    // Unread, or read by a turn that produced nothing, so this item absorbs the
    // run — and now says which one, so the absorption survives being read (see
    // itemRunRecord). A call whose OWN run this is needs no such note.
    if (runItemId || starterCall !== selector) trailing.set('runItemId', starterItemId);
    // An unread receipt reports the run it now names, so whether it recovers an
    // error is that run's question too.
    if (!selector) {
      if (recovers) trailing.set('recoversError', true);
      else trailing.delete('recoversError');
    }
    return;
  }

  // Not news, nothing to carry: the run this item already shows came out the
  // same way, so a receipt would only repeat it.
  const shown = shownRunOutcome(threadYMap, runItemId, selector);
  if (shown && shown.status === status && shown.result === result) return;

  siblings.insert(siblings.length, [plainToYMap({
    type: 'thread',
    itemId: mintItemId(),
    timestamp: new Date().toISOString(),
    aliasOf: canonicalId,
    goal: threadYMap.get('goal') || '',
    sessionName: threadYMap.get('sessionName') || '',
    runItemId: starterItemId,
    ...(recovers ? { recoversError: true } : {})
  })]);
}

/**
 * Whether the last thing the parent read about a thread was a failure: the
 * latest of its items for that thread whose result has gone to the model shows
 * an error run. A run coming to rest after that is the work the parent was told
 * had not been done, which makes its receipt one the parent takes up unasked
 * (`recoversError`). Mirrors lastReadRunFailedLocked in worker/run_records.go.
 * @param {any} threadYMap - The canonical thread Y.Map holding the transcript.
 * @param {any[]} arr - The parent's items, in order.
 * @param {string} canonicalId - The thread's itemId.
 * @returns {boolean} True when the parent last read this thread failing.
 */
function lastReadRunFailed(threadYMap, arr, canonicalId) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function' || item.get('type') !== 'thread') continue;
    if (item.get('itemId') !== canonicalId && item.get('aliasOf') !== canonicalId) continue;
    if (!item.get('runResultFed')) continue;
    const shown = shownRunOutcome(threadYMap, item.get('runItemId') || '', item.get('runToolUseId') || '');
    return shown?.status === RUN_STATUS_ERROR;
  }
  return false;
}
