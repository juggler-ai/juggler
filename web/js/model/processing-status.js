//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a processingState status says about whether a turn is running.
 *
 * The worker writes the status and decides what it means: `statusHoldsClaim`
 * (`cmd/juggler/worker/activity_state.go`) treats `idle` and the two
 * terminal-error statuses as resting, and every other status as a phase of a
 * turn still in flight. A frame can stay at a terminal-error status
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
 * @module model/processing-status
 */

/** The statuses the worker rests at. */
const RESTING_STATUSES = new Set(['idle', 'error', 'validation-error']);

/**
 * Whether a status is one the worker rests at.
 * @param {string|undefined} status - processingState.status.
 * @returns {boolean} True for idle and the terminal-error statuses.
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
