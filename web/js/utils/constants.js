//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Application-wide constants
 */

// ===== Timing Constants =====

/** Debounce delay for session save operations (milliseconds) */
export const SAVE_DEBOUNCE_MS = 300;

// ===== Message History Constants =====

/** Maximum number of messages to keep in history */
export const MAX_MESSAGE_HISTORY = 100;

/** Debounce delay for saving draft message in input box (milliseconds) */
export const DRAFT_SAVE_DEBOUNCE_MS = 2000;

// ===== Yjs Sync Constants =====

/** Batching window for Yjs sync updates (milliseconds) */
export const YJS_SYNC_BATCH_MS = 50;

// ===== Conversation naming =====

/**
 * Maximum length (in characters) of a conversation / tab name. Enforced at
 * both the UI level (the inline-rename input's `maxlength`) and the data level
 * (`Session.renameConversation`), so it is the single source of truth for the
 * limit. Also the ceiling AI auto-naming truncates its suggestion to. Kept just
 * under the server's filesystem-safety cap of 74 runes
 * (`core.SanitizedNameMaxRunes`) so a name we accept is never silently
 * truncated when the folder is written to disk.
 */
export const MAX_CONVERSATION_NAME_LENGTH = 72;

// ===== User-facing notices =====

/**
 * Notice shown when a user action (new thread, /compact, close thread, …)
 * preempts a live LLM turn by cancelling it first. Surfacing this keeps the
 * cancellation from being silent.
 */
export const TURN_CANCELLED_NOTICE = 'Cancelled the active turn';

/**
 * Notice shown when duplication (Cmd-D, the tab context menu's "Duplicate",
 * branch-from-message, or `/duplicate`) is refused because the source
 * conversation has a turn in flight. A clone taken mid-turn would block on the
 * worker's flush until the turn ends (often visibly hanging), and the copy
 * would capture a `running` item no worker will ever resolve — so duplicating
 * is refused outright rather than silently cancelling the turn.
 */
export const DUPLICATE_WHILE_ACTIVE_NOTICE =
  "Can't duplicate while a turn is running — wait for it to finish, or cancel it first.";
