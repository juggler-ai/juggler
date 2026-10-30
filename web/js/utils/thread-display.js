//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { renderAssistantContentWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripThinkingTags } from './content-utils.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { hasPendingApprovalInTree, hasUnsettledToolInTree } from '../model/thread-navigation.js';
import { canonicalThread, itemGoal, itemRunRecord, isTrailingViewOf } from '../model/thread-alias.js';
import { arrayItems } from '../model/item-accessor.js';
import { formatTokens } from './format.js';
import { decorateFileRefs } from './file-refs.js';
import { itemField } from '../../sdk/lib/message.js';
import { t } from '../../sdk/lib/i18n.js';

/** @typedef {import('yjs').Map<unknown>|import('../../sdk/lib/message.js').YMapItem} ThreadItem */
/** @typedef {import('yjs').Array<unknown>|ReadonlyArray<unknown>} SiblingArray */

/**
 * What a thread tile shows: the result of the ONE run that item stands for.
 *
 * A thread called more than once has one parent item per call (see
 * model/thread-alias.js), and each shows a single run's result: its own, frozen
 * when that run settled, so a later call can never rewrite what an earlier tile
 * says — or, for the last of them, whatever the session is doing now.
 * An item with no run selector falls back to the thread's `result`, its current
 * summary: a user-created thread, a fold, and every document written before
 * aliases record completion only there.
 *
 * Until the run has come to rest there is nothing worth showing on the tile.
 * Whatever live work is going on inside (streaming an assistant message,
 * awaiting tool approval) is visible only when the user drills into the
 * sub-thread itself — the tile face just shows a status block.
 * @param {ThreadItem} threadYMap - The thread item Y.Map (canonical or alias).
 * @param {SiblingArray} [siblingArray] - The array the item stands in.
 * @returns {{ text: string }} The summary, or '' when there is none.
 */
export function getThreadDisplayContent(threadYMap, siblingArray) {
  const record = itemRunRecord(threadYMap, siblingArray);
  if (record) return { text: record.result };
  const result = itemField(threadYMap, 'result');
  return { text: (typeof result === 'string') ? result : '' };
}

/**
 * @typedef {object} ThreadCostFigures
 * @property {number} context - Estimated size of the thread's own transcript.
 * @property {number} returned - Estimated size of the answer it handed back.
 * @property {string} text - The pair, for the resting tile.
 */

/**
 * What a sub-thread's own context came to, against what it handed back.
 *
 * The two are worth showing together because the ratio between them is the
 * whole economics of delegating: the child does not inherit the parent
 * transcript and returns one tool_result, so a child that reads a great many
 * files costs its caller the answer alone. Both figures are stamped on the
 * thread when a run settles, so a tile needs no fetch to show them — and an
 * alias reads them off the thread it is a view of, since they describe the
 * transcript rather than one call into it.
 *
 * Null until a run has settled: absent figures show nothing, never a zero.
 * @param {ThreadItem} threadYMap - The thread item Y.Map (canonical or alias).
 * @param {SiblingArray} [siblingArray] - The array the item stands in.
 * @returns {ThreadCostFigures|null} The pair, or null when there is none.
 */
export function threadCostFigures(threadYMap, siblingArray) {
  const thread = canonicalThread(threadYMap, siblingArray);
  const context = Number(itemField(thread, 'contextTokens')) || 0;
  const returned = Number(itemField(thread, 'resultTokens')) || 0;
  if (context <= 0 || returned <= 0) return null;
  return {
    context,
    returned,
    text: t('{used} used · {returned} returned', { used: formatTokens(context), returned: formatTokens(returned) }),
  };
}

/**
 * @typedef {'running'|'pending'|'paused'|'queued'|'errored'|'unfinished'|'idle'} ThreadStatusKind
 */

/**
 * @typedef {object} ThreadStatus
 * @property {ThreadStatusKind} kind - Which state the thread is in.
 * @property {string} goal - The thread's user-facing goal ("" if unset). The
 *   surface showing this status paints it as its own header; the status block
 *   itself never does.
 * @property {string} message - Status line to render beneath that header, in
 *   the UI language: drawn as given, never matched on (`kind` is the state).
 * @property {boolean} spinner - Whether the status block should show a spinner.
 * @property {boolean} [showSummary] - Paint the thread's summary instead of a
 *   status block. Set only when the thread is genuinely at rest, so the several
 *   surfaces that render a tile never re-derive "is it resting" and disagree.
 * @property {boolean} [openRun] - The run this item stands for was started and
 *   never settled, so the caller that made the call is still parked on it. Set
 *   only on the states that are at rest, where it is the difference between a
 *   thread nobody is waiting on and one whose caller cannot move until this run
 *   is settled by hand. Which state it came to rest in does not change that:
 *   what the tile offers follows the open run, not the label above it.
 */

/**
 * @typedef {object} ThreadLiveStatus
 * @property {Record<string, string>} byThread - Footer-style status message
 *   (e.g. "Streaming • 250 tokens") per RUNNING thread, keyed by thread item id
 *   (`''` for the root thread). A thread with no entry is not being driven.
 *   Several entries at once is ordinary — a parent and its read-only children
 *   run together — so a surface asks about the thread it is showing rather than
 *   comparing against a single live thread id.
 */

/**
 * The live status line for one thread, or '' when that thread is not running.
 * The one place the root thread's empty-string key is applied.
 * @param {ThreadLiveStatus|null|undefined} live - Live status snapshot.
 * @param {string|null|undefined} threadItemId - Thread item id (null for root).
 * @returns {string} That thread's status line, or ''.
 */
export function liveMessageForThread(live, threadItemId) {
  return live?.byThread?.[threadItemId || ''] || '';
}

/**
 * Whether anything at all is being driven in this conversation.
 * @param {ThreadLiveStatus|null|undefined} live - Live status snapshot.
 * @returns {boolean} True while at least one thread is running.
 */
export function anyThreadLive(live) {
  return Object.keys(live?.byThread || {}).length > 0;
}

/**
 * Classify a thread's current state for tile-face display. Pure function: the
 * caller passes in a `live` status snapshot (the same one the conversation
 * footer reads from `llmState`) so the tile mirrors footer wording.
 *
 * States enumerated (in precedence order):
 *   paused   — a tool-action anywhere in the subtree is pending approval.
 *   running  — worker is actively driving this thread.
 *   pending  — `needsStrategyRun` set but the worker hasn't picked it up yet.
 *   errored  — a nested item is an error message.
 *   queued   — other threads are running but this one has not been dispatched
 *              yet: it's waiting its turn.
 *   unfinished — this item's run was started, never settled, and nothing is
 *              driving it. Stopped mid-run: it moves again only if the user
 *              picks it up or settles it, and the caller stays parked until
 *              one of those happens.
 *   idle     — none of the above: nothing is actively driving this thread. It
 *              is stopped, which is a resting state, not a terminal one — it
 *              may never have started, or it may have run and come to rest
 *              carrying a summary. Either way it accepts a message and runs
 *              again; the tile face shows the summary when there is one.
 * @param {ThreadItem} threadYMap - The thread item Y.Map (canonical or alias).
 * @param {ThreadLiveStatus|null} [live] - Live LLM status snapshot from llmState.
 * @param {SiblingArray} [siblingArray] - The array the item stands in.
 * @returns {ThreadStatus} Classification + display fields.
 */
export function getThreadStatus(threadYMap, live, siblingArray) {
  // The transcript hangs off the canonical: an alias asks every subtree question
  // of the thread it is a view of.
  const thread = canonicalThread(threadYMap, siblingArray);
  // The goal THIS item's call named, not the session's current one: a tile
  // describes the call it was made by, and the thread's `goal` moves with the
  // latest call (see itemGoal in model/thread-alias.js).
  const goal = itemGoal(threadYMap, siblingArray);

  const items = itemField(thread, 'items');

  // Awaiting approval is a PURE FUNCTION of the current subtree and trumps
  // everything else — checked FIRST, before `result` and before the live
  // status. A tool-action awaiting approval ANYWHERE below this thread (direct
  // child or buried in a nested sub-thread) parks the whole branch: surface it
  // as 'paused' so this tile AND every ancestor tile turn orange, keeping the
  // visual route from the tab to the action unbroken regardless of nesting
  // depth. A thread can legitimately carry a summary while a descendant still
  // holds a live pending approval — the dynamic signal wins, we never bake
  // "has a pending child" into the data model. It trumps a settled run too: an
  // approval is a request for the user, and which call it arose under is no
  // reason to hide the route to it. Mirrors the tab's awaiting-trumps-everything
  // rule in conversation-bar._refreshTabStatus.
  if (hasPendingApprovalInTree(items)) {
    return { kind: 'paused', goal, message: t('Waiting for approval'), spinner: false };
  }

  // Is the worker driving this session right now? Keyed on the canonical,
  // because that is the thread the worker names when it reports what it is
  // driving — so every item referring to the session answers yes together.
  // Asked of THIS thread's own entry: siblings run alongside it, and their
  // work says nothing about this one.
  const storedId = itemField(thread, 'itemId');
  const itemId = typeof storedId === 'string' ? storedId : undefined;
  const liveMessage = liveMessageForThread(live, itemId);
  const isLive = !!liveMessage;

  // An item stamped with a run selector answers for ONE run. Once that run has
  // settled the tile is frozen: what a later call into the same thread does is
  // another item's business, and a historic tile that started spinning again
  // would be reporting work its own call never asked for.
  //
  // The tile at the end of the session is the one exception, and reads the run
  // the transcript is on rather than the one its call started (itemRunRecord).
  // Nothing stands behind it, so a child picked back up by hand spins here and
  // reports its answer here — which is the tile the person resuming is looking
  // at.
  //
  // Being frozen is about the RESULT, not about the spinner. A run whose result
  // has gone to the model may not have that result rewritten — it is committed
  // history, and moving it would cold-start a stateful provider — but a session
  // that is working again is presentation, costs the wire nothing, and is the
  // one thing the person looking at the tile wants to know. Freezing both left a
  // resumed child showing the previous run's result, with no spinner, for the
  // whole of the next run.
  //
  // So a settled record yields to the live run on the trailing view alone, which
  // is the same test itemRunRecord uses to decide which item reads the live run.
  // The result underneath is untouched: the tile simply stops claiming to be at
  // rest while it works.
  const record = itemRunRecord(threadYMap, siblingArray);
  if (record?.status && !(isLive && isTrailingViewOf(threadYMap, thread, siblingArray))) {
    return record.result
      ? { kind: 'idle', goal, message: '', spinner: false, showSummary: true }
      : { kind: 'idle', goal, message: t('Idle'), spinner: false };
  }

  if (isLive) {
    return { kind: 'running', goal, message: liveMessage, spinner: true };
  }

  if (itemField(thread, 'needsStrategyRun')) {
    return { kind: 'pending', goal, message: t('Waiting to start…'), spinner: false };
  }

  // At rest carrying a summary from an earlier run: nothing is driving it, so
  // the tile shows that summary instead of a status line. This sits BELOW the
  // live check — a thread being driven again reports 'running', so a resumed
  // thread shows its spinner rather than a stale summary — and ABOVE the error
  // and queued fall-throughs, which describe threads that never came to rest.
  //
  // "At rest" still has to be derived, never taken from the summary alone: a
  // thread mid-tool-use is working regardless of what text sits on it, so an
  // unsettled tool anywhere below keeps it out of this branch.
  //
  // Only threads with no run selector get here: an item that stands for one run
  // was answered above, and borrowing the thread's current summary for a run
  // still in flight would show it the previous call's reply.
  const result = !record ? itemField(thread, 'result') : '';
  if (typeof result === 'string' && result.length > 0 && !hasUnsettledToolInTree(items)) {
    return { kind: 'idle', goal, message: '', spinner: false, showSummary: true };
  }

  {
    const list = arrayItems(items);
    for (let i = list.length - 1; i >= 0; i--) {
      if (itemField(list[i], 'type') === 'error') {
        // An error is how the thread stopped, not whether anything is waiting on
        // it. A run left open behind one — a child stopped by a provider cap is
        // the ordinary case — still has its caller parked, and this tile is the
        // only place that parking can be ended.
        return { kind: 'errored', goal, message: t('Stopped (error)'), spinner: false, openRun: !!record && !record.status };
      }
    }
  }

  // Something is being driven, and it is not this thread: it carries no entry
  // of its own, so it has not been dispatched yet. That is a wait, not a stop —
  // the worker admits threads as capacity allows (read-only children run
  // alongside each other and their parent; a write-capable one waits for the
  // single writer slot), and this one's turn comes. A sibling actually running
  // returned 'running' above off its own entry, so it never reaches here. Once
  // nothing is running at all a still-unfinished thread falls through to 'idle'.
  if (anyThreadLive(live)) {
    return { kind: 'queued', goal, message: t('Waiting for its turn…'), spinner: false };
  }

  // A run was started for this call and never settled, and nothing is driving
  // it: the thread stopped mid-run and will not pick itself back up. This is
  // the state an own-vantage stop leaves behind — the worker turn is preempted
  // but no outcome is recorded, deliberately, so the run stays open and takes
  // work again (conversation.interruptThread).
  //
  // It is not 'idle', because an unsettled run is not a resting state: the
  // caller that made this call is parked on it, and while it stays open the
  // parent column has no Continue and the conversation cannot move on. The tile
  // carries the Stop that settles it — the only affordance the parent column
  // has in this state (see thread-message).
  if (record && !record.status) {
    return { kind: 'unfinished', goal, message: t('Unfinished'), spinner: false, openRun: true };
  }

  // "Idle", not "Stopped": with the conversation idle and no result, nothing is
  // driving this thread — but nothing necessarily stopped it either (it may
  // simply never have been started). "Stopped" wrongly implies an interruption.
  return { kind: 'idle', goal, message: t('Idle'), spinner: false };
}

/**
 * The states with work outstanding: this thread is being driven, or something
 * that is not the user will move it on — bar `paused`, which waits on the user
 * but is an open piece of work with a route to it, and is marked so that route
 * stays visible from the tab down.
 *
 * This is what a tile's icon pulse means, so the states left out are the ones it
 * would misdescribe: `errored` and `unfinished` stopped mid-run and will not
 * pick themselves back up, and `idle` is at rest. On any of those the pulse is
 * the only moving pixel in the state, and it says the opposite of the label
 * beside it.
 * @param {ThreadStatus|null|undefined} status - A getThreadStatus classification.
 * @returns {boolean} True when the thread has work outstanding.
 */
export function threadHasWorkOutstanding(status) {
  switch (status?.kind) {
    case 'running':
    case 'pending':
    case 'paused':
    case 'queued':
      return true;
    default:
      return false;
  }
}

/**
 * Paint a thread tile / properties-panel summary surface. Renders the
 * markdown summary when the thread is at rest and has one; otherwise renders a
 * structured status block (optional spinner + status line). Shared so the
 * in-conversation tile and the panel stay visually identical.
 *
 * The goal is never painted here. It is the header of whichever surface is
 * showing this body — the tile's badge row, the panel's section header, the
 * group tile's title — so each surface paints it there itself, and this stays
 * the body beneath it.
 *
 * With `opts.fileRefs`, the summary's inline code naming a file in that tree
 * becomes a reference to it (utils/file-refs.js); without it nothing is asked.
 * @param {HTMLElement} el - Element to populate.
 * @param {string} text - Summary text (only used when status.showSummary).
 * @param {{status?: ThreadStatus, fileRefs?: Parameters<typeof decorateFileRefs>[1]}} [opts]
 */
export function paintThreadSummary(el, text, opts) {
  const status = opts?.status;
  const showSummary = status ? !!status.showSummary : !!text;
  if (showSummary) {
    el.className = 'thread-summary';
    el.innerHTML = renderAssistantContentWrapped(stripThinkingTags(text));
    decorateCodeBlocks(el);
    if (opts?.fileRefs) void decorateFileRefs(el, opts.fileRefs);
    return;
  }

  if (!status) {
    el.className = 'thread-summary not-summarised';
    el.textContent = t('Thread not yet summarised');
    return;
  }

  el.className = 'thread-summary thread-status';
  el.dataset.kind = status.kind;
  const spinnerHTML = status.spinner
    ? '<juggler-spinner class="thread-status-spinner" style="--size: 0.9em"></juggler-spinner>'
    : '';
  // A status with nothing to say and no spinner renders no line at all, rather
  // than an empty one the column gap would still space out.
  el.innerHTML = (status.message || status.spinner)
    ? `<div class="thread-status-message">${spinnerHTML}<span>${escapeHtml(status.message || '')}</span></div>`
    : '';
}

/**
 * Update only the text of an already-painted status block. Leaves the
 * `<juggler-spinner>` element and the surrounding structure untouched so CSS
 * animations (spinner rotation, parent icon-box pulse) don't restart. Caller
 * must ensure the block was previously painted by `paintThreadSummary` with a
 * status of the same shape — one that painted a status block rather than a
 * summary, and whose message and spinner presence are unchanged. Anything else
 * changes which elements exist, so it needs a fresh `paintThreadSummary`
 * instead.
 * @param {HTMLElement} el - The `.thread-summary.thread-status` element.
 * @param {ThreadStatus} status - Current status.
 */
export function paintThreadStatusText(el, status) {
  el.dataset.kind = status.kind;
  const msgSpan = el.querySelector('.thread-status-message > span');
  if (msgSpan) msgSpan.textContent = status.message || '';
}
