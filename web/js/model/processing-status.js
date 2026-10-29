//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a processingState status says about whether a turn is running.
 *
 * The worker writes the status and decides what it means: `statusHoldsClaim`
 * (`cmd/juggler/worker/activity_state.go`) treats `idle` and the
 * terminal-error status `validation-error` as resting, and every other status
 * as a phase of a turn still in flight. A frame can stay at `validation-error`
 * indefinitely: a send refused for want of a model writes `validation-error`
 * and returns without running anything. So every reader of the frame asks
 * here rather than comparing against `'idle'`.
 *
 * This answers for the frame only. The other questions a viewer asks about a
 * running conversation have their own owners:
 * - `Conversation.isTurnActive()`: the frame, plus any frontend tool action
 *   still running. What a refusal ("not while a turn runs") asks.
 * - `Conversation.isProcessing` / `isThreadProcessing(id)`: `LLMState`'s
 *   per-run status messages. What the spinner, the tab badge and a column's own
 *   controls ask.
 * - `MessageThread.hasBusyItems()`: the document. Tool actions approved or
 *   running, and sub-threads whose run has not settled. Work can be
 *   outstanding with no claim held, so this is asked alongside the others,
 *   never instead of them.
 *
 * A caller that combines them asks {@link busyState} instead, which names each
 * answer, so the call says which one it means.
 * @module model/processing-status
 */

/** The statuses the worker rests at. */
const RESTING_STATUSES = new Set(['idle', 'validation-error']);

/**
 * Whether a status is one the worker rests at.
 * @param {string|undefined} status - processingState.status.
 * @returns {boolean} True for idle and validation-error.
 */
export function isRestingStatus(status) {
  return status !== undefined && RESTING_STATUSES.has(status);
}

/**
 * Whether a status describes a turn in flight. No status at all is a frame
 * the worker has not described yet, which is not a turn.
 * @param {string|undefined} status - processingState.status.
 * @returns {boolean} True for every phase of a running turn.
 */
export function statusHoldsTurn(status) {
  return !!status && !RESTING_STATUSES.has(status);
}

/**
 * Every answer to "is this conversation busy?", each by name.
 *
 * The fields are read when asked for, not when the answer is made, so a caller
 * pays only for the ones it reads (`outstandingItems` and `awaitingApproval`
 * walk the document tree).
 * @typedef {object} BusyState
 * @property {string|undefined} status - The worker's processingState status, as written.
 * @property {boolean} turn - The worker's frame holds a turn ({@link statusHoldsTurn}).
 * @property {boolean} localActions - A frontend tool action of this conversation is running.
 * @property {boolean} turnActive - `turn` or `localActions`: what a refusal ("not while a turn runs") and a cancel-and-settle wait on (`Conversation.isTurnActive`).
 * @property {boolean} running - LLMState reports a run anywhere in the conversation: what the spinner and badge show (`Conversation.isProcessing`).
 * @property {boolean} outstandingItems - The document holds work not yet settled: tool actions approved or running, sub-threads whose run is open (`MessageThread.hasBusyItems` on the root).
 * @property {boolean} awaitingApproval - Parked on a tool approval anywhere in the tree — a turn that is doing nothing until the user answers.
 */

/**
 * The conversation's busy answers ({@link BusyState}). A conversation missing a
 * source — a stub, a stand-in — answers false for it.
 * @param {import('./conversation.js').default} conv - The conversation.
 * @returns {BusyState} Each answer by name.
 */
export function busyState(conv) {
  const c = conv;
  return {
    get status() { return c.processingState?.status; },
    get turn() { return statusHoldsTurn(c.processingState?.status); },
    get localActions() { return c.hasLocalActionsRunning?.() === true; },
    get turnActive() { return this.turn || this.localActions; },
    get running() { return c.isProcessing === true; },
    get outstandingItems() { return c.rootMessageThread?.hasBusyItems?.() === true; },
    get awaitingApproval() { return c.isAwaitingApproval?.() === true; },
  };
}
