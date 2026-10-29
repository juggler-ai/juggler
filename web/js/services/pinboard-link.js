//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The line between a viewer and the boards it has detached into windows of their
 * own — one module, so the two ends of it cannot drift apart.
 *
 * A detached board is a view of ONE conversation: the one that was on screen
 * when it was detached, named in its own URL. It does not follow the window that
 * opened it and does not end with it. That is what the thing is for — a board
 * left open on a conversation whose background task you want to watch is worth
 * nothing if it wanders off to whatever you opened next, and worth nothing if it
 * empties itself the moment you close the window you started from. So the board
 * reads the conversation named in its URL out of its own session, exactly as any
 * other viewer of that project would, and survives a reload of itself for the
 * same reason.
 *
 * What is left to say between the two ends is little, and all of it goes one way:
 *
 * - `hello` satellite → owner. "I am here." Registers the board, so anything
 *   else from it can be told apart from a message any other viewer of this
 *   session might send.
 * - `reveal` satellite → owner. Point at a thread or an item, in this board's
 *   conversation — which the owner switches to first, since a board on a
 *   conversation its owner has left is the ordinary case now rather than a
 *   mistake.
 * - `select` satellite → owner. Show this board's conversation, with nothing
 *   singled out in it. A reveal without anything to point at.
 * - `compose` satellite → owner. Put text the user assembled on the board — a
 *   review's feedback — in the prompt of the thread it is about, for them to read
 *   back and send. A board window has no composer, so this is the only way text
 *   written on one reaches a box; the owner decides what becomes of it, exactly as
 *   it does for a reveal, and sends it rather than dropping it when that thread
 *   has no box on screen.
 *
 * All of them travel over the addressed viewer relay ({@link module:services/websocket}'s
 * `relayTo`), which is best-effort and unqueued: a viewer that is not connected
 * never receives a message and nothing reports that. Nothing durable is agreed
 * here, and nothing needs to be — the board itself is server state and both ends
 * fetch it independently. An owner that has gone away is simply an owner no
 * reveal reaches.
 * @module services/pinboard-link
 */

import wsService from './websocket.js';
import api from './api.js';
import pinboardStore from './pinboard-store.js';
import { ownerViewerId, VIEW_PINBOARD } from '../utils/view-mode.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';

/** The relay envelope's tag, so nothing else's payload is ever mistaken for ours. */
const CHANNEL = 'pinboard';

/** Satellite → owner: I am here, and a reveal from me is one of yours. */
const HELLO = 'hello';

/** Satellite → owner: point at this, in this conversation. */
const REVEAL = 'reveal';

/** Satellite → owner: make this conversation the one you are showing. */
const SELECT = 'select';

/** Satellite → owner: put this text in the prompt, on this thread. */
const COMPOSE = 'compose';

/**
 * Whether this document can take part at all. A viewer the server could not
 * address — a P2P data-channel client, whose channel opens with no HTTP request
 * to carry an id — can neither own a board nor be one.
 * @returns {boolean} True when this viewer has an id the relay can reach.
 */
export function canLinkBoards() {
  return !!wsService.viewerId;
}

/**
 * Call back when this viewer learns whether it has an address at all.
 *
 * The id arrives on the server's session frame, which is always later than the
 * page building itself: the board is static markup, so its element upgrades
 * during parse, while the frame cannot be read until the call stack yields. A
 * surface that offers to detach, and a board looking for its owner, therefore
 * have to wait for the answer instead of sampling it once and getting the empty
 * one every time.
 * @param {(data: any) => void} listener - Called with each session frame.
 * @returns {() => void} Unsubscribe.
 */
export function onLinkAvailability(listener) {
  wsService.on('session', listener);
  return () => wsService.off('session', listener);
}

/**
 * Unwrap a `viewer-relay` event, or null when it is not one of ours.
 * @param {any} event - The `{from, payload}` the relay delivered.
 * @returns {{from: string, kind: string, body: any}|null} The message.
 */
function parse(event) {
  const payload = event?.payload;
  if (!payload || payload.channel !== CHANNEL || typeof payload.kind !== 'string') return null;
  const from = typeof event.from === 'string' ? event.from : '';
  if (!from) return null;
  return { from, kind: payload.kind, body: payload.body };
}

/**
 * Send one message to a viewer.
 * @param {string} to - The recipient's viewer id.
 * @param {string} kind - One of the kinds above.
 * @param {any} [body] - The message's payload.
 * @returns {boolean} True when the transport took it.
 */
function send(to, kind, body) {
  return wsService.relayTo(to, { channel: CHANNEL, kind, body });
}

/**
 * The address of a board detached from this viewer: the board it is, the
 * conversation it is a view of, the pin it opens on, and the viewer a reveal is
 * sent back to.
 *
 * The board and the conversation are what make the URL worth reloading — a
 * window that comes back up with its own tabs on the conversation it was opened
 * for is a window, and one that comes back up asking someone else what to show
 * is a guess.
 *
 * Still not shareable. It names a viewer on someone's screen as well as a
 * conversation, and hands the reveal to whoever holds that id.
 * @param {string} boardId - The board this window is.
 * @param {string} pinId - The pin to open on, or '' for none.
 * @param {string} conversationId - The conversation it is a view of, or '' for none.
 * @returns {string} An absolute URL.
 */
function detachedBoardURL(boardId, pinId, conversationId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', VIEW_PINBOARD);
  url.searchParams.set('owner', wsService.viewerId);
  url.searchParams.set('board', boardId);
  if (conversationId) url.searchParams.set('conversation', conversationId);
  if (pinId) url.searchParams.set('pin', pinId);
  return url.toString();
}

/**
 * Where a window opened from an element should start: the element's place in
 * this window, and the size of the page it was measured in — all in CSS pixels.
 * @typedef {object} FrameHint
 * @property {number} x - The element's left edge, from the left of the page.
 * @property {number} y - Its top edge, from the top of the page.
 * @property {number} width - How wide it is.
 * @property {number} height - How tall it is.
 * @property {number} viewWidth - The page's own width.
 * @property {number} viewHeight - The page's own height.
 */

/**
 * Measure an element for a window to be opened over it.
 *
 * The page's own size travels with the rect because a rect alone says nothing a
 * window can be placed by: the host knows where the window sits on the screen
 * and how big it is, and the page size is what turns one into the other. Sent as
 * a hint rather than a frame for the same reason — a page has no business
 * naming coordinates on a screen it cannot see.
 *
 * Null for anything that would place a window nowhere: no element, or one with
 * no size on screen.
 * @param {{getBoundingClientRect: () => {left: number, top: number, width: number, height: number}}|null} [element] -
 *   The element the window is opened from.
 * @returns {FrameHint|null} The measurement, or null when there is nothing to measure.
 */
export function frameHintOf(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const viewWidth = Math.round(window.innerWidth);
  const viewHeight = Math.round(window.innerHeight);
  if (!(viewWidth > 0) || !(viewHeight > 0)) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewWidth,
    viewHeight,
  };
}

/**
 * The owner's end: it opens boards, and carries out the reveals they send back.
 *
 * The list of boards is built from the messages that arrive rather than from the
 * windows this viewer opened, which is what makes it right after a board reloads
 * (same viewer id, new connection) and after this viewer reloads (the boards say
 * hello again, and the list rebuilds itself).
 */
export const ownerLink = {
  /** @type {Set<string>} @private Viewer ids of the boards that have said hello. */
  _satellites: new Set(),

  /** @type {((reveal: {kind: string, id: string|null, thread: string|null, conversation: string}) => void)|null} @private */
  _onReveal: null,

  /** @type {((conversationId: string) => void)|null} @private */
  _onSelect: null,

  /** @type {((compose: {text: string, conversation: string, thread: string|null}) => void)|null} @private */
  _onCompose: null,

  /** @type {(() => void)|null} @private Unsubscribe from boards' relayed messages. */
  _unsubscribeRelay: null,

  /**
   * Start answering boards. Idempotent — the second call replaces the handlers
   * rather than subscribing twice.
   * @param {object} handlers - What the owner can do.
   * @param {(reveal: {kind: string, id: string|null, thread: string|null, conversation: string}) => void} handlers.onReveal -
   *   Carry out a board's reveal in this window, in the conversation it names.
   * @param {(conversationId: string) => void} [handlers.onSelect] - Show the
   *   conversation a board names, without pointing at anything inside it.
   * @param {(compose: {text: string, conversation: string, thread: string|null}) => void} [handlers.onCompose] -
   *   Put a board's text in the prompt of the thread it names.
   * @returns {void}
   */
  serve({ onReveal, onSelect, onCompose }) {
    this._onReveal = onReveal;
    this._onSelect = onSelect || null;
    this._onCompose = onCompose || null;
    if (this._unsubscribeRelay) return;
    /** @param {any} event - A relayed frame */
    const handler = (event) => {
      const message = parse(event);
      if (!message) return;
      switch (message.kind) {
        case HELLO:
          this._satellites.add(message.from);
          break;
        case REVEAL:
          // Only a board that has introduced itself may move this window's
          // columns. `from` is taken from the sending connection and cannot be
          // forged, so this is a real check rather than a courtesy.
          if (!this._satellites.has(message.from)) return;
          this._onReveal?.({
            kind: String(message.body?.kind || ''),
            id: message.body?.id ?? null,
            thread: message.body?.thread ?? null,
            conversation: String(message.body?.conversation || ''),
          });
          break;
        case SELECT: {
          // Same guard as a reveal, and for the same reason: this moves the
          // window a person is working in.
          if (!this._satellites.has(message.from)) return;
          const conversation = String(message.body?.conversation || '');
          if (conversation) this._onSelect?.(conversation);
          break;
        }
        case COMPOSE: {
          // Same guard again, and most needed here: this one puts words in the
          // prompt of a window a person is working in.
          if (!this._satellites.has(message.from)) return;
          const text = typeof message.body?.text === 'string' ? message.body.text : '';
          const conversation = String(message.body?.conversation || '');
          if (text && conversation) {
            this._onCompose?.({ text, conversation, thread: message.body?.thread ?? null });
          }
          break;
        }
        default:
          break;
      }
    };
    this._unsubscribeRelay = wsService.on('viewer-relay', handler);
  },

  /**
   * Detach a board into a window of its own: a new composition of its own,
   * seeded with what the panel is showing and tied to the conversation it is a
   * view of.
   *
   * The board is recorded before the window is opened, because the window's
   * first act is to read it. A window that opened first would find nothing there
   * and draw an empty board over a full one.
   *
   * There is no limit and no deduplication: a second detach is a second board,
   * with its own tabs to arrange from then on.
   * @param {string} pinId - The pin the new window opens on, or '' for none.
   * @param {string} conversationId - The conversation it is a view of.
   * @param {import('./pinboard-store.js').Pin[]} pins - What it starts with.
   * @param {FrameHint|null} [frame] - Where the board is on screen now, for the
   *   window to open near.
   * @returns {Promise<string>} A complaint for the status line, or '' when it opened.
   */
  async detach(pinId, conversationId, pins, frame = null) {
    if (!canLinkBoards()) return t("Couldn't detach the board. This viewer has no address for one to answer.");
    // A board is a view of one conversation, fixed for its life. Without one
    // there is nothing for the window to be a view of, and it would open only to
    // say so.
    if (!conversationId) return t("Couldn't detach the board. There's no conversation for it to be a view of.");

    const board = pinboardStore.newBoardId();
    try {
      await pinboardStore.createBoard(board, conversationId, pins);
    } catch (err) {
      return t("Couldn't detach the board. {error}", { error: errorText(err) });
    }
    return this.openBoardWindow(board, pinId, conversationId, frame);
  },

  /**
   * Open the window for a board already recorded — a detach's second half, and
   * the whole of reopening one that outlived the last run.
   *
   * In a browser it opens a tab rather than a popup. A tab is the thing the
   * browser lets the user do everything with: leave it where it is, drag it out
   * into a window of its own, move it to the other screen. A popup is a window
   * they cannot make into a tab, chosen for them.
   *
   * A tab the browser declined to open, or a window the desktop app refused, is
   * reported: the caller puts the overlay away on success, so a failure kept to
   * the console reads as a button that does nothing. The app answers before it
   * builds the window, so this waits on the request and not on the window.
   * @param {string} boardId - The board the window is.
   * @param {string} pinId - The pin it opens on, or '' for none.
   * @param {string} conversationId - The conversation it is a view of.
   * @param {FrameHint|null} [frame] - Where the board is on screen now, for the
   *   window to open near.
   * @returns {Promise<string>} A complaint for the status line, or '' when it opened.
   */
  async openBoardWindow(boardId, pinId, conversationId, frame = null) {
    if (hasNativeHost()) {
      // The app opens it on this window's own server, which is what puts the
      // two on one project.
      try {
        await api.openPinboardWindow(wsService.viewerId, boardId, pinId, conversationId, frame);
      } catch (err) {
        // Already worded for the status line by the request's error prefix.
        return errorText(err) || t("Couldn't open that board.");
      }
      return '';
    }
    // A tab is opened where the browser opens tabs. The measurement is the
    // app's to use: sizing a tab is not a thing a page may do, and a popup that
    // could be sized is the window the user did not ask for.
    const opened = window.open(detachedBoardURL(boardId, pinId, conversationId), '_blank');
    if (!opened) return t("Couldn't open that board. The browser blocked the tab.");
    return '';
  },

  /**
   * Reopen the boards that were open when Juggler was last shut.
   *
   * Driven from here, in the page, because a board's owner is a viewer id minted
   * by the browser into sessionStorage: the one saved with a board last run
   * addresses nobody this run, and only a live window knows its own. So the
   * restore is the ordinary detach replayed — same route, same window, an owner
   * that exists — with the boards already recorded.
   *
   * Answered once by the server, so it is safe for every main window to ask.
   * @returns {Promise<number>} How many windows were asked for.
   */
  async restoreBoards() {
    if (!canLinkBoards()) return 0;
    let boards = [];
    try {
      boards = await pinboardStore.claimDetachedBoards();
    } catch (err) {
      console.error('[Pinboard] Could not ask which boards were open:', err);
      return 0;
    }
    for (const board of boards) {
      // No pin: this window doesn't know which tab the board was showing. The
      // board window stores that as its own preference and reopens on it.
      void this.openBoardWindow(board.id, '', board.conversation);
    }
    return boards.length;
  },

  /** @returns {string[]} The viewer ids of the boards that have said hello. */
  satellites() {
    return [...this._satellites];
  },

  /**
   * Drop the subscription and the list. For tests and teardown.
   * @returns {void}
   */
  reset() {
    this._unsubscribeRelay?.();
    this._unsubscribeRelay = null;
    this._onReveal = null;
    this._onSelect = null;
    this._onCompose = null;
    this._satellites.clear();
  },
};

/**
 * The board's end: it introduces itself to the window it was opened from, and
 * reports where the user pointed.
 *
 * That is the whole of it. What the board shows is its own business — the
 * conversation is in its URL and the pins are on the server — so nothing here
 * waits on an owner, and an owner that never answers costs the board nothing.
 */
export const satelliteLink = {
  /** @type {string} @private The owner named in this document's URL. */
  _owner: '',

  /** @type {(() => void)|null} @private Unsubscribe from the viewer list and the reconnects. */
  _unsubscribe: null,

  /** @type {(() => void)|null} @private Unsubscribe from the wait for this viewer's own id. */
  _addressWait: null,

  /** @type {boolean} @private Whether the owner was in the last list of viewers. */
  _present: false,

  /** @type {boolean} @private Whether this board has started introducing itself. */
  _started: false,

  /**
   * Start reporting to an owner. A URL naming none is a board that keeps its
   * reveals to itself, which costs it nothing else.
   *
   * Not knowing this viewer's own address yet is a different answer from not
   * having one: at the moment the board builds itself the session frame has
   * never arrived, so it waits for that rather than reading the empty id as a
   * verdict.
   * @returns {void}
   */
  start() {
    if (this._started || !ownerViewerId()) return;
    if (!canLinkBoards()) {
      this._awaitAddress();
      return;
    }
    this._dropAddressWait();
    this._started = true;
    this._owner = ownerViewerId();

    // Whether the owner is there to be introduced to. The list carries every
    // viewer's id, so this needs no traffic of its own. An owner that has just
    // arrived holds no record of the boards it opened — a reload is a fresh page
    // with an empty list of them — so this is also how a board that outlived its
    // owner's reload gets its reveals working again.
    const offClients = wsService.on('clients-changed', (/** @type {any} */ data) => {
      const present = (data?.clients || []).some(
        (/** @type {any} */ client) => client?.viewerId === this._owner,
      );
      if (!present) {
        this._present = false;
        return;
      }
      if (this._present) return;
      this._present = true;
      this.hello();
    });

    // A reconnect leaves the owner holding a board it is no longer talking to,
    // so introduce ourselves again rather than waiting for it to notice.
    const offOpen = wsService.on('open', () => this.hello());
    this._unsubscribe = () => { offClients(); offOpen(); };

    this.hello();
  },

  /**
   * Tell the owner this board is here.
   * @returns {void}
   */
  hello() {
    if (this._owner) send(this._owner, HELLO);
  },

  /**
   * Ask the owner to bring a thread's column into view, in this board's
   * conversation.
   * @param {string|null} threadId - The thread, null for the root.
   * @param {string} conversationId - The conversation it belongs to.
   * @returns {void}
   */
  revealThread(threadId, conversationId) {
    if (!this._owner) return;
    send(this._owner, REVEAL, { kind: 'thread', id: threadId ?? null, conversation: conversationId });
  },

  /**
   * Ask the owner to select one item wherever it lives, in this board's
   * conversation.
   * @param {string} itemId - The item to select.
   * @param {string} conversationId - The conversation it belongs to.
   * @returns {void}
   */
  revealItem(itemId, conversationId) {
    if (!this._owner || !itemId) return;
    send(this._owner, REVEAL, { kind: 'item', id: itemId, conversation: conversationId });
  },

  /**
   * Ask the owner to go to the row a tool call left, in whichever conversation
   * made it. The call is named rather than its row because the row is the
   * owner's to find: this board may never have loaded that conversation.
   * @param {string} toolUseId - The tool call.
   * @param {string|null} threadId - The thread it ran in, null for the root.
   * @param {string} conversationId - The conversation it belongs to.
   * @returns {void}
   */
  revealToolAction(toolUseId, threadId, conversationId) {
    if (!this._owner) return;
    if (!toolUseId) {
      this.revealThread(threadId, conversationId);
      return;
    }
    send(this._owner, REVEAL, { kind: 'tool', id: toolUseId, thread: threadId ?? null, conversation: conversationId });
  },

  /**
   * Ask the owner to show this board's conversation — the whole of it, with
   * nothing singled out inside it. What a board window's header offers when its
   * conversation is named there: the board is a view of that conversation, and
   * this is how the user gets to the rest of it.
   * @param {string} conversationId - The conversation to show.
   * @returns {void}
   */
  selectConversation(conversationId) {
    if (!this._owner || !conversationId) return;
    send(this._owner, SELECT, { conversation: conversationId });
  },

  /**
   * Ask the owner to put text in the prompt of one thread of this board's
   * conversation.
   *
   * The one message here whose refusal the caller has to know about: a board with
   * no owner to take the text has to do something else with it rather than lose
   * it. `_present` is the answer — the owner was in the last list of connected
   * viewers — and the list arrives on registration, so it is settled long before
   * anyone can press a button. Nothing is acknowledged beyond that, as with
   * everything else here.
   * @param {string} text - What to put in the prompt.
   * @param {string} conversationId - The conversation it belongs to.
   * @param {string|null} threadItemId - The thread within it, null for the root.
   * @returns {boolean} True when an owner was there and the relay took it.
   */
  compose(text, conversationId, threadItemId) {
    if (!this._owner || !this._present || !text || !conversationId) return false;
    return send(this._owner, COMPOSE, {
      text,
      conversation: conversationId,
      thread: threadItemId ?? null,
    });
  },

  /**
   * Hold until this viewer's own id arrives, then start for real. When the frame
   * carries no id — a peer-to-peer viewer, whose channel opens with no request
   * to carry one — nothing can address this board and there is nothing to wait
   * for; the board goes on showing its conversation regardless.
   * @private
   */
  _awaitAddress() {
    if (this._addressWait) return;
    this._addressWait = onLinkAvailability(() => {
      if (!canLinkBoards()) {
        this._dropAddressWait();
        return;
      }
      this.start();
    });
  },

  /**
   * Stop waiting for an address, whatever the outcome was.
   * @private
   */
  _dropAddressWait() {
    this._addressWait?.();
    this._addressWait = null;
  },

  /**
   * Drop every subscription and go back to the start. For tests and teardown.
   * @returns {void}
   */
  reset() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._dropAddressWait();
    this._owner = '';
    this._present = false;
    this._started = false;
  },
};
