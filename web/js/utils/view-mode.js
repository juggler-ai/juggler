//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * View mode — which shell this document is, decided once from its own URL.
 *
 * There are two. `main` is Juggler: the header, the conversation bar, the
 * columns, and the pinboard behind the right edge. `pinboard` is a board that
 * has been detached from one of those windows into its own: the same app, the
 * same session and the same board, with the conversation shell left out.
 *
 * A detached board is a view of one conversation, named in the same URL. It does
 * not follow the window it was detached from and does not end with it: what it
 * shows is decided by its own address, which is what lets one be left open on a
 * conversation while the window that opened it goes elsewhere. The owner in the
 * URL is only where a reveal is sent — the board has no columns of its own, so
 * pointing at a thread is a thing it asks that window to do.
 *
 * The URL is still not worth sharing: it names a viewer on someone's screen as
 * well as a conversation, and hands the reveal to whoever holds that id.
 *
 * The paint-critical half of this is read in index.html's pre-paint block,
 * which sets `data-view` so the reduced layout lands on the first frame. This
 * module is the logic half, and the same split theme and zoom already use.
 * @module utils/view-mode
 */

/** The ordinary Juggler shell. */
const VIEW_MAIN = 'main';

/** A board detached into its own window or tab. */
export const VIEW_PINBOARD = 'pinboard';

/**
 * The board the docked panel shows — the one board that is not a window, and
 * the one every viewer of the project shares. Mirrors MainBoardID in
 * cmd/juggler/core/pinboard.go.
 */
const MAIN_BOARD_ID = 'main';

/**
 * The window role of the Juggler shell. Mirrors WindowRoleMain in
 * cmd/juggler/core/session.go.
 */
export const WINDOW_ROLE_MAIN = 'main';

/**
 * The window role of a detached board, before its board id is appended. Mirrors
 * WindowRolePinboard in cmd/juggler/core/session.go.
 */
const WINDOW_ROLE_PINBOARD = 'pinboard';

/**
 * The alphabet the server accepts for a viewer id (see sanitiseViewerID in
 * cmd/juggler/server/network.go). Applied to the ids in the URL too, so a junk
 * one yields nothing rather than something nothing can reach.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @type {string} */
let mode = VIEW_MAIN;
/** @type {string} */
let owner = '';
/** @type {string} */
let pin = '';
/** @type {string} */
let conversation = '';
/** @type {string} */
let board = '';

/**
 * Read the mode out of a query string.
 * @param {string} search - A `location.search`.
 * @returns {void}
 */
function readFrom(search) {
  const params = new URLSearchParams(search || '');
  mode = params.get('view') === VIEW_PINBOARD ? VIEW_PINBOARD : VIEW_MAIN;
  const rawOwner = params.get('owner') || '';
  owner = ID_PATTERN.test(rawOwner) ? rawOwner : '';
  const rawPin = params.get('pin') || '';
  pin = ID_PATTERN.test(rawPin) ? rawPin : '';
  const rawConversation = params.get('conversation') || '';
  conversation = ID_PATTERN.test(rawConversation) ? rawConversation : '';
  const rawBoard = params.get('board') || '';
  board = ID_PATTERN.test(rawBoard) ? rawBoard : '';
}

readFrom(globalThis.location?.search || '');

/**
 * Whether this document is a detached board rather than the Juggler shell.
 * @returns {boolean} True in a pinboard view.
 */
export function isPinboardView() {
  return mode === VIEW_PINBOARD;
}

/**
 * The viewer a detached board sends its reveals to — the one it was opened from.
 * @returns {string} The owner's viewer id, or '' when there is none.
 */
export function ownerViewerId() {
  return mode === VIEW_PINBOARD ? owner : '';
}

/**
 * The conversation a detached board is a view of. Fixed for the life of the
 * window: this is the whole of what stops a board from wandering off after the
 * one that opened it, and what a reload of the board restores it to.
 * @returns {string} The conversation id, or '' when none was named.
 */
export function boardConversationId() {
  return mode === VIEW_PINBOARD ? conversation : '';
}

/**
 * The pin this board opened on, so a detached board starts where the user was
 * looking rather than on whichever tab happens to come first. Advisory: a pin
 * that is no longer on the board is ignored, like any other stale selection.
 * @returns {string} The pin id, or '' when none was named.
 */
export function initialPinId() {
  return mode === VIEW_PINBOARD ? pin : '';
}

/**
 * The board this document is a view of — its tabs, in the order it arranged
 * them. A window has its own; the Juggler shell has the one every viewer of the
 * project shares, which is what makes the panel mean the same thing wherever it
 * is opened.
 *
 * Fixed for the life of the document, like the conversation, because it is the
 * arrangement this window keeps: a board that could change which composition it
 * showed would be a second answer to what the window is.
 * @returns {string} The board id, defaulting to the shared one.
 */
export function boardId() {
  return mode === VIEW_PINBOARD && board ? board : MAIN_BOARD_ID;
}

/**
 * Which of this project's windows this document is.
 *
 * The Juggler shell is 'main'; a detached board is 'pinboard:<board>', or plain
 * 'pinboard' when the URL named no usable board. This is the name a window's own
 * geometry and UI preferences are kept under, so it has to be the same string
 * the two Go sides use: WindowRolePinboardFor in cmd/juggler/core/session.go,
 * which names the slot the server keeps (and prunes) for a board, and role() in
 * cmd/juggler-app/window_opts.go, which the desktop app opens the window with.
 *
 * Note this reads the board straight out of the URL rather than through
 * boardId(), which answers with the shared board when none was named — a window
 * that named no board is not the docked panel's window.
 * @returns {string} The window role.
 */
export function windowRole() {
  if (mode !== VIEW_PINBOARD) return WINDOW_ROLE_MAIN;
  return board ? `${WINDOW_ROLE_PINBOARD}:${board}` : WINDOW_ROLE_PINBOARD;
}

/**
 * Re-read the mode from a query string of the test's choosing, since the real
 * one is fixed by the URL the lane was loaded with. Pass nothing to go back to
 * that URL.
 * @param {string} [search] - A query string, e.g. '?view=pinboard&owner=v_1&conversation=conv_1'.
 * @returns {void}
 */
export function __setViewModeForTests(search) {
  readFrom(search ?? (globalThis.location?.search || ''));
}
