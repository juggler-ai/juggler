//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Application-wide constants
 */

import { markForTranslation } from '../../sdk/lib/i18n.js';

// ===== Timing Constants =====

/** Debounce delay for session save operations (milliseconds) */
export const SAVE_DEBOUNCE_MS = 300;

// ===== Message History Constants =====

/** Maximum number of messages to keep in history */
export const MAX_MESSAGE_HISTORY = 100;

/**
 * Debounce delay for saving draft message in composer (milliseconds).
 *
 * This is how long freshly typed text exists only in the textarea, recoverable
 * by nothing — so it is a data-loss window, not just a tuning knob, and it is
 * kept near the shortest pause that still reads as "stopped typing" rather than
 * "mid-word". Its only cost is Yjs update chatter: each expiry rewrites the
 * whole draft record, and repeated writes to the same key merge cheaply.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 750;

/**
 * How long the close/quit handshake waits for one conversation's worker to
 * confirm a rescued draft reached disk (milliseconds). Deliberately short: the
 * native host is blocked on our reply and would rather quit with a draft in
 * flight than hang on a wedged worker.
 */
export const CLOSE_FLUSH_ACK_TIMEOUT_MS = 2500;

/**
 * How long a lookup on the send path may take before the composer gives up on
 * it and sends anyway (milliseconds).
 *
 * The skill snapshot and the `@`-mention existence check both run between the
 * user pressing Send and the message being dispatched, and `fetch` on its own
 * will wait out the browser's full network timeout. Over a slow tunnel or a
 * mobile link that turns Send into a control that appears to do nothing, so
 * these two calls give up and degrade instead: an unresolved `$name` stays as
 * prose, an unverified bareword `@foo` makes no context item, and the message
 * still goes. Generous enough for a remote-access round trip, short enough that
 * a dead link is over before the user reaches for the button again.
 */
export const SEND_LOOKUP_TIMEOUT_MS = 8000;

// ===== Yjs Sync Constants =====

/**
 * Shortest batching window for inbound Yjs sync updates (milliseconds), and the
 * one used whenever applying a batch is cheap — which is every case except a
 * long message streaming in.
 */
export const YJS_SYNC_BATCH_MS = 50;

/**
 * Longest the batching window is allowed to stretch to under load
 * (milliseconds). Applying a batch runs the whole UI fan-out synchronously, so
 * the window widens as that gets more expensive (see DocumentSyncManager); this
 * caps how far. Four frames a second still reads as live text arriving, and
 * leaves a wide margin under the browser suite's wait timeouts.
 */
export const YJS_SYNC_BATCH_MAX_MS = 250;

// ===== Conversation naming =====

/**
 * Maximum length (in characters) of a conversation / tab name. Enforced at the
 * UI level (the inline-rename input's `maxlength`), the data level
 * (`Session.renameConversation`), and for machine-derived names
 * (`uniqueSuffixedName`, which clips the base so "(copy)" / "(continued)"
 * fits), so it is the single source of truth for the limit. Kept just under the
 * server's filesystem-safety cap of 50 runes (`core.SanitizedNameMaxRunes`) so
 * a name we accept is never silently truncated when the folder is written to
 * disk.
 */
export const MAX_CONVERSATION_NAME_LENGTH = 48;

// ===== Workspace naming =====

/**
 * Maximum length (in characters) of a workspace's label — the name its box
 * carries in the tab strip. Enforced where the name is typed (the inline-rename
 * input's `maxlength`); the server's own limit (`core.MaxWorkspaceLabelLen`, 256)
 * is the backstop for anything that arrives another way.
 *
 * The same figure as a conversation's for the same reason: the two are read one
 * above the other in a column a few hundred pixels wide, where a name longer
 * than this is an ellipsis with a beginning attached.
 */
export const MAX_WORKSPACE_LABEL_LENGTH = 48;

// ===== Bin =====

/**
 * Bin size (bytes) past which the UI stops stating the number and starts
 * drawing attention to it.
 *
 * Nothing in the bin is ever removed on a timer or a threshold — a binned
 * conversation stays until the user empties it — so the only defence against a
 * bin quietly growing to gigabytes is that the user can see it has. Binning
 * strips each conversation's replayed transaction inputs, which is the bulk of
 * what a conversation costs, and what is left is mostly its transcript; a bin
 * this size is therefore a real pile of conversations rather than one long one,
 * and worth mentioning.
 */
export const BIN_LARGE_BYTES = 1024 * 1024 * 1024;

// ===== User-facing notices =====

/**
 * Notice shown when a user action (new thread, /compact, …)
 * preempts a live LLM turn by cancelling it first. Surfacing this keeps the
 * cancellation from being silent. Translated where it is shown.
 */
export const TURN_CANCELLED_NOTICE = markForTranslation('Stopped the turn that was running.');

/**
 * Notice shown when a duplication opts out of forking a running source (via
 * refuseWhileActive — only /handoff, whose follow-up LLM turn needs a settled
 * source, so it names the handoff). Plain duplicate/branch fork mid-turn
 * instead: the server snapshots the live doc and the clone loads stopped, so
 * they never show this. Translated where it is shown.
 */
export const HANDOFF_WHILE_ACTIVE_NOTICE =
  markForTranslation("Can't hand off while a turn is running — wait for it to finish, or stop it first.");

/**
 * Notice shown when a duplicate of a conversation is asked for while another
 * is still being made and the two can't share one copy — a fork, a handoff, or
 * a plain duplicate during either (see Session.duplicateConversation).
 * Translated where it is shown.
 */
export const DUPLICATE_IN_PROGRESS_NOTICE =
  markForTranslation('This conversation is already being duplicated — wait for the copy to finish.');
