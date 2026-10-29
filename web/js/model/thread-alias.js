//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread aliases.
 *
 * A thread a tool calls more than once gets ONE PARENT ITEM PER CALL. The first
 * call inserts the thread itself — the canonical item, which owns the
 * transcript. Every later call inserts an ALIAS: a thread item carrying no
 * transcript of its own, pointing at the canonical with `aliasOf`, and stamped
 * with a RUN SELECTOR (`runToolUseId`) naming the single run it stands for.
 *
 * Selecting either tile opens the same column — they are two views of one body
 * of content. But each tile carries a single run's result, so five calls into
 * one session read as five results down the parent transcript rather than one
 * tile whose text keeps being overwritten.
 *
 * WHICH run depends on where the item stands, and on whether the model has read
 * it. The LAST item referring to a session is its live view: it shows the run
 * the transcript is on now, whoever started it — including a run a human started
 * by typing into a stopped child, which no call named and which nothing else in
 * the parent stands for. Every earlier item stands for the one call it was made
 * by, frozen where that run settled, so a later result can never rewrite a tile
 * further up. An item whose result has gone to the model (`runResultFed`) is
 * frozen the same way, and a run arriving after that is appended as a RECEIPT: a
 * third kind of item, standing for a run nobody called, naming it by the message
 * that started it (`runItemId`) since there is no call to name it by.
 *
 * An alias and its canonical are always siblings: a session is scoped to the
 * thread that called it, so a resume can only be issued from the array the
 * thread already sits in. Mirrors worker/run_records.go (resolveAliasTarget,
 * runByToolUseID, itemRunSettled).
 */

import { threadRunSettled } from './run-records.js';
import { itemField } from '../../sdk/lib/message.js';

/**
 * Read a Y.Array, plain array, or nullish as a plain array.
 * @param {any} value - A Y.Array, plain array, or nothing.
 * @returns {Array<any>} The items, or an empty array.
 */
function asArray(value) {
  if (!value) return [];
  if (typeof value.toArray === 'function') return value.toArray();
  return Array.isArray(value) ? value : [];
}

/**
 * Whether this item is an alias: a second view of a thread standing elsewhere in
 * the same array.
 * @param {any} itemYMap - The item Y.Map.
 * @returns {boolean} True for an alias item.
 */
export function isAlias(itemYMap) {
  return !!itemYMap?.get?.('aliasOf');
}

/**
 * The canonical thread an alias names, from the array it stands in. Defaults to
 * the item's own containing Y.Array, which is that array by definition.
 * @param {any} itemYMap - The alias item Y.Map.
 * @param {any} [siblingArray] - The array the item stands in (Y.Array or array).
 * @returns {any|null} The canonical thread Y.Map, or null when it is gone.
 */
function resolveAliasTarget(itemYMap, siblingArray) {
  const targetId = itemYMap?.get?.('aliasOf');
  if (!targetId) return null;
  for (const item of asArray(siblingArray || itemYMap?.parent)) {
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') !== 'thread' || item.get('aliasOf')) continue;
    if (item.get('itemId') === targetId) return item;
  }
  return null;
}

/**
 * Whether this item is the LAST of the parent's items referring to a session —
 * the canonical and its aliases are the whole set, and they always stand in one
 * array.
 *
 * That item is the session's live view: it shows the run the transcript is on
 * now, whoever started it. Every earlier item is a receipt for the one call it
 * was made by. Mirrors isTrailingViewOf in worker/run_records.go.
 * @param {any} itemYMap - The item Y.Map (canonical or alias).
 * @param {any} canonical - The canonical thread Y.Map it refers to.
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {boolean} True when no later item refers to the same session.
 */
export function isTrailingViewOf(itemYMap, canonical, siblingArray) {
  const canonicalId = canonical?.get?.('itemId');
  if (!canonicalId) return false;
  const siblings = asArray(siblingArray || itemYMap?.parent);
  for (let i = siblings.length - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (typeof sibling?.get !== 'function' || sibling.get('type') !== 'thread') continue;
    const id = sibling.get('itemId');
    if (id !== canonicalId && sibling.get('aliasOf') !== canonicalId) continue;
    return id === itemYMap?.get?.('itemId');
  }
  return false;
}

/**
 * The outcome of the run a named message started, or null when that message is
 * no longer in the transcript.
 *
 * This is the selector for a run no call made (`runItemId`, carried by a
 * receipt). It walks the items directly rather than going through
 * threadRunRecords, whose "a record needs tool-use coordinates" guard is
 * load-bearing for the entries built per call — and a human-started run has no
 * coordinates at all. Mirrors runRecordByItemID in worker/run_records.go.
 * @param {any} threadYMap - The canonical thread Y.Map.
 * @param {string} itemId - The itemId of the message that started the run.
 * @returns {{status: string, result: string}|null} That run's outcome, or null.
 */
function runRecordByItemId(threadYMap, itemId) {
  if (!itemId) return null;
  for (const item of asArray(threadYMap?.get?.('items'))) {
    if (typeof item?.get !== 'function' || item.get('type') !== 'user') continue;
    if (item.get('itemId') !== itemId) continue;
    return { status: item.get('runStatus') || '', result: item.get('runResult') || '' };
  }
  return null;
}

/**
 * The outcome of the run a thread's transcript is currently on, or null when it
 * records none. An empty status means that run is still going.
 *
 * Reads the LAST user item rather than the run's invocation message: the worker
 * stamps the same outcome onto every message the run gathered, so the trailing
 * one always carries it, and it is the item threadRunSettled asks about. It
 * requires no run selector, which is the point — a run a human started by typing
 * into the thread is recorded on a plain user message, so threadRunRecords does
 * not see it. Mirrors trailingRunOutcome in worker/run_records.go.
 * @param {any} threadYMap - The canonical thread Y.Map.
 * @returns {{status: string, result: string}|null} That run's outcome, or null.
 */
function trailingRunOutcome(threadYMap) {
  const items = asArray(threadYMap?.get?.('items'));
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (typeof item?.get !== 'function' || item.get('type') !== 'user') continue;
    return { status: item.get('runStatus') || '', result: item.get('runResult') || '' };
  }
  return null;
}

/**
 * The thread whose transcript this item shows: the canonical for an alias, the
 * item itself for anything else. Every subtree question — what is running, what
 * is awaiting approval, which column to open — is a question about that thread.
 * An alias whose canonical is gone resolves to itself, so callers still have a
 * Y.Map to read; it simply has no items.
 * @param {any} itemYMap - The item Y.Map.
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {any} The thread Y.Map holding the transcript.
 */
export function canonicalThread(itemYMap, siblingArray) {
  if (!isAlias(itemYMap)) return itemYMap;
  return resolveAliasTarget(itemYMap, siblingArray) || itemYMap;
}

/**
 * The fields a thread item owns as ITSELF rather than as the thread: its
 * identity, and the run selector naming the one call it was made by. Promotion
 * moves everything else off the canonical and leaves these alone, so a promoted
 * view still answers for its own call and the wire emits the pairs it always
 * did.
 * @type {ReadonlySet<string>}
 */
const VIEW_OWN_FIELDS = new Set([
  'itemId', 'type', 'timestamp', 'aliasOf',
  'runToolUseId', 'runToolName', 'runToolInput', 'runGoal',
  'runItemId', 'runStatus', 'runResult', 'runResultFed'
]);

/**
 * Hand a thread's transcript to the next item that views it, for a canonical
 * about to be deleted.
 *
 * Deleting one tile removes one tile. A thread's other views are separate items
 * the user did not touch, so they cannot go with it — but the transcript has to
 * survive somewhere, or they become tiles with nothing to show and calls the
 * wire can only answer with an error. The oldest surviving view takes everything
 * the thread owned and stops being a view; the rest are re-pointed at it.
 *
 * What does NOT move is the promotee's own identity and run selector
 * (VIEW_OWN_FIELDS). Every tile still stands for the one call it was made by, so
 * each emits exactly the pair it emitted before and no tool-use id is duplicated
 * or lost — the only pair that goes is the deleted tile's own, which is the
 * point of deleting it.
 *
 * Y types are cloned rather than moved: a live shared type cannot be re-parented.
 * Item ids inside the transcript are plain data, so they survive the clone and
 * every DOM key and selector that names them still resolves.
 *
 * Caller wraps this in its own transaction, along with the delete it precedes.
 * @param {any} canonicalYMap - The canonical thread Y.Map about to be deleted.
 * @param {any} [siblingArray] - The array it stands in (Y.Array or array).
 * @returns {any|null} The promoted view, or null when nothing else views it.
 */
export function promoteThreadView(canonicalYMap, siblingArray) {
  const canonicalId = canonicalYMap?.get?.('itemId');
  if (!canonicalId || canonicalYMap.get('aliasOf')) return null;

  const siblings = asArray(siblingArray || canonicalYMap?.parent);
  const views = siblings.filter((/** @type {any} */ it) =>
    typeof it?.get === 'function' && it.get('aliasOf') === canonicalId);
  if (!views.length) return null;

  const promoted = views[0];
  for (const key of canonicalYMap.keys()) {
    if (VIEW_OWN_FIELDS.has(key)) continue;
    const value = canonicalYMap.get(key);
    promoted.set(key, typeof value?.clone === 'function' ? value.clone() : value);
  }
  promoted.delete('aliasOf');

  const promotedId = promoted.get('itemId');
  for (const view of views.slice(1)) view.set('aliasOf', promotedId);
  return promoted;
}

/**
 * The legacy `goal` a call recorded directly in its tool input. New documents
 * carry the resolved SubthreadSpec goal separately as `runGoal`, because a
 * delegating extension's detailed task field need not be named `goal`.
 * @param {any} input - A run's `runToolInput`.
 * @returns {string} The goal, or '' when the call named none.
 */
function goalOfToolInput(input) {
  const goal = itemField(input, 'goal');
  return typeof goal === 'string' ? goal : '';
}

/**
 * A thread's run records, in transcript order: the invocation messages standing
 * in it, plus the records carried by a fold that swallowed some. Mirrors
 * threadRunRecords in worker/llm_request.go, including its exclusions — a fold
 * has no runs of its own, and a nested thread item's coordinates are its own run
 * selector, not a call into the thread holding it.
 * @param {any} threadYMap - The canonical thread Y.Map.
 * @returns {Array<{toolUseId: string, goal: string, status: string, result: string}>} The runs.
 */
export function threadRunRecords(threadYMap) {
  if (threadYMap?.get?.('boundedCompaction') === true) return [];
  /** @type {Array<{toolUseId: string, goal: string, status: string, result: string}>} */
  const runs = [];
  const add = (/** @type {any} */ read) => {
    const toolUseId = read('runToolUseId');
    const input = read('runToolInput');
    if (!toolUseId || !read('runToolName') || input === null || input === undefined) return;
    runs.push({
      toolUseId,
      goal: read('runGoal') || goalOfToolInput(input),
      status: read('runStatus') || '',
      result: read('runResult') || ''
    });
  };
  for (const item of asArray(threadYMap?.get?.('items'))) {
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') === 'thread') {
      if (item.get('boundedCompaction') === true) {
        for (const folded of asArray(item.get('foldedRuns'))) {
          add((/** @type {string} */ key) => itemField(folded, key));
        }
      }
      continue;
    }
    add((/** @type {string} */ key) => item.get(key));
  }
  return runs;
}

/**
 * The goal THIS item stands for: the one its own call named.
 *
 * A thread's `goal` field is the session's header — it moves with the latest
 * call, so it describes the session as it stands rather than the call any one
 * tile was made by. Each call's resolved short label is on its item as
 * `runGoal`, stamped when the call was made and never rewritten. Older
 * create_thread records fall back to `runToolInput.goal`.
 *
 * Falls back to the item's `goal` field, then to the canonical's: a
 * user-created thread, a fold, and every document written before run selectors
 * carry their goal only there.
 * @param {any} itemYMap - The thread item Y.Map (canonical or alias).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {string} The goal to display for this item ('' when it has none).
 */
export function itemGoal(itemYMap, siblingArray) {
  if (itemYMap?.get?.('runToolUseId')) {
    const runGoal = itemYMap.get('runGoal');
    if (typeof runGoal === 'string' && runGoal) return runGoal;
    const goal = goalOfToolInput(itemYMap.get('runToolInput'));
    if (goal) return goal;
  }
  return itemYMap?.get?.('goal') || canonicalThread(itemYMap, siblingArray)?.get?.('goal') || '';
}

/**
 * @typedef {object} ItemRunRecord
 * @property {string} status - How the run settled ('' while it is still going).
 * @property {string} result - What it returned ('' while it is still going).
 * @property {number} call - Its 1-based call number in the thread.
 */

/**
 * The record of the run THIS item stands for, read off the transcript wherever
 * it now is. Null for an item with no run selector — a user- or
 * strategy-created thread, a fold, every document written before aliases — and
 * for a selector naming a run the transcript no longer holds.
 *
 * Which run that is depends on where the item stands, and on whether it has been
 * read. The LAST item referring to a session is its live view and answers for
 * the run the transcript is on now (isTrailingViewOf), so a session resumed by a
 * human — whose run no call named at all — reports to the item still waiting on
 * it. Every earlier item answers for the one run its selector names, frozen
 * where that run settled, so a session resumed by a later call reports to the
 * item that call appended. The live view borrows the OUTCOME only: its call
 * number stays its own, because it is still the parent's view of the call it
 * made.
 *
 * An item whose result has already gone to the model (`runResultFed`) is frozen
 * too, wherever it stands: the live view may absorb news the parent has not
 * heard, never correct something it has. A run arriving after that gets a
 * receipt item of its own, which selects it by the message that started it
 * (`runItemId`) because there is no call to name it by. Mirrors itemThreadRun in
 * worker/run_records.go.
 * @param {any} itemYMap - The thread item Y.Map (canonical, alias or receipt).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {ItemRunRecord|null} That run's record, or null.
 */
export function itemRunRecord(itemYMap, siblingArray) {
  const selector = itemYMap?.get?.('runToolUseId');
  const runItemId = itemYMap?.get?.('runItemId');
  if (!selector && !runItemId) return null;
  const canonical = isAlias(itemYMap) ? resolveAliasTarget(itemYMap, siblingArray) : itemYMap;
  if (!canonical) return null;
  const runs = threadRunRecords(canonical);
  if (!selector) {
    const record = runRecordByItemId(canonical, runItemId);
    // A run nobody called is numbered after the calls that are recorded: it is
    // not one of them, but it did happen after them.
    return record ? { ...record, call: runs.length + 1 } : null;
  }
  let call = 0;
  let matched = null;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i]?.toolUseId === selector) {
      call = i + 1;
      matched = runs[i];
      break;
    }
  }
  // A selector no record answers still stands for a call that was made, so it is
  // numbered after the ones that are recorded.
  const numbered = call || runs.length + 1;
  if (!itemYMap.get('runResultFed') && isTrailingViewOf(itemYMap, canonical, siblingArray)) {
    const trailing = trailingRunOutcome(canonical);
    if (trailing) return { ...trailing, call: numbered };
  }
  if (runItemId) {
    // The run this item absorbed while it was still unread (the worker names it
    // there when the run settles). Read once the item is frozen, so what it
    // reports is what it sent.
    const absorbed = runRecordByItemId(canonical, runItemId);
    if (absorbed) return { ...absorbed, call: numbered };
  }
  if (!matched) return null;
  return { status: matched.status, result: matched.result, call };
}

/**
 * Whether the run THIS item stands for is over — the "is this child finished?"
 * question, asked of one item rather than of the thread.
 *
 * An item carrying a run selector answers for its own run, so a caller waits on
 * the call it made rather than on whatever the thread most recently did. A
 * selector that resolves to nothing is over: the thread was deleted, or the run's
 * record was edited away, and there is nothing left to wait for. The exception is
 * a thread recording no run at all, which is one mid-creation.
 *
 * An item with no selector — a user-, strategy- or orchestrator-created thread, a
 * fold, every document written before aliases — answers from the thread itself.
 * An ALIAS with no selector stands for no run and is over: it owns no transcript
 * and no summary, so asking the thread question of it would answer "still
 * working" for as long as it exists. A RECEIPT is over by construction — it is
 * only ever appended for a run that has already settled, and nobody is waiting
 * on it. Mirrors itemRunSettled in worker/run_records.go.
 * @param {any} itemYMap - The item Y.Map (canonical, alias, receipt, or anything else).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {boolean} True when this item's run is over.
 */
export function itemRunSettled(itemYMap, siblingArray) {
  if (itemYMap?.get?.('type') === 'thread' && itemYMap.get('runToolUseId')) {
    const record = itemRunRecord(itemYMap, siblingArray);
    if (record) return !!record.status;
    const canonical = isAlias(itemYMap) ? resolveAliasTarget(itemYMap, siblingArray) : itemYMap;
    if (!canonical) return true; // the alias names a thread that is gone
    if (threadRunRecords(canonical).length > 0) return true; // the selector names a run the transcript no longer holds
    return threadRunSettled(canonical);
  }
  if (isAlias(itemYMap)) return true; // an alias with no selector stands for no run
  return threadRunSettled(itemYMap);
}
