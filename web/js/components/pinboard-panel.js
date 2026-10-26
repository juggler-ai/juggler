//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-panel> — the board itself, in three bands: a toolbar that names the
 * surface, a strip of tabs, and the active pin. It is the only piece that reads
 * both the shared board and this viewer's view of it, and it routes every edit
 * through the host service rather than the store, so dedupe, reveal and the
 * status line all happen in one place.
 *
 * The panel also resolves the active-context snapshot — the project, the visible
 * conversation, the thread being read — and hands it down. Item types never walk
 * session internals to find that out for themselves.
 *
 * A detached board resolves the same snapshot from the same session, with one
 * substitution: the conversation is the one named in its URL rather than the one
 * this viewer happens to be showing, and the thread is that conversation's root.
 * A board is a window onto one conversation and stays there — which is what makes
 * it worth leaving open on work that takes a while — so nothing it shows depends
 * on the window it was detached from still existing, or still being anywhere near
 * the conversation it was detached from.
 * @module components/pinboard-panel
 */

import JugglerElement from './juggler-element.js';
import pinboardStore from '../services/pinboard-store.js';
import pinboardView from '../services/pinboard-view.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import { THREAD_FOCUS_CHANGED } from './conversation-tab.js';
import { isEditableTarget } from '../services/key-shortcut-manager.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { openAddPicker } from './pinboard-add-picker.js';
import { describePin, revealInConversation, composeForThread, showConversation } from './pinboard-content.js';
import { closeThisWindow, isDesktopWindow } from '../../sdk/lib/window-control.js';
import { ownerLink, satelliteLink, canLinkBoards, onLinkAvailability, frameHintOf } from '../services/pinboard-link.js';
import { isPinboardView, boardConversationId, ownerViewerId } from '../utils/view-mode.js';
import { dragGuard } from '../utils/drag-guard.js';
import { displayConversationName } from '../model/conversation-naming.js';
import { focusedThreadItemId } from '../services/nearest-context-item.js';
import './pinboard-tabbar.js';
import './pinboard-content.js';

/** @typedef {import('juggler/pinboard-item-type').PinActiveContext} PinActiveContext */

/** Material "open in new" icon, for the control that gives the board a window. */
const POPOUT_ICON_PATH = 'M120-120v-320h80v184l504-504H520v-80h320v320h-80v-184L256-200h184v80H120Z';

/**
 * The last segment of a path, whichever separator the platform uses.
 * @param {string} path - A project path.
 * @returns {string} The name to show.
 */
function baseName(path) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? /** @type {string} */ (parts[parts.length - 1]) : path;
}

class PinboardPanel extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {(() => void)|null} @private */
    this._unsubscribeSession = null;
    /** @type {any} @private */
    this._tabbar = null;
    /** @type {any} @private */
    this._content = null;
    /** @type {HTMLElement|null} @private */
    this._status = null;
    /** @type {(() => void)|null} @private The open add picker's close fn. */
    this._closePicker = null;
    /** @type {string} @private The last snapshot rendered, to spot a real change. */
    this._contextJson = '';
    /** @type {HTMLElement|null} @private Stands in for the board while there is none. */
    this._placeholder = null;
    /**
     * How far a detached board has got with the conversation named in its URL:
     * 'opening' until the session has been asked for it, then 'ready' or
     * 'missing'. A board that guessed instead of waiting would draw an empty
     * Plan, no changed files and no running tasks over a conversation that is
     * merely still loading — and would look right doing it.
     * @type {'opening'|'ready'|'missing'} @private
     */
    this._boardState = 'opening';
    /**
     * What the conversation this board is a view of was called, kept from the
     * last time there was one to ask. A deleted conversation cannot be asked its
     * name, and which one has gone is the whole of what the window can still
     * usefully say.
     * @type {string} @private
     */
    this._boardTitle = '';
    /** @type {HTMLButtonElement|null} @private Shown once this viewer has an address. */
    this._popOutButton = null;
    /** @type {string} @private What the window header was last told to say. */
    this._namedAs = '';
  }

  connectedCallback() {
    this._build();
    this.addCleanup(pinboardStore.subscribe(() => this.render()));
    this.addCleanup(pinboardView.subscribe(() => this.render()));
    // A hot-reloaded extension is a different class: everything mounted against
    // the old one has to come down before anything is mounted against the new.
    this.onDocument(REGISTRIES_RELOADED, () => this._remount());
    // Column selection is not session state, so this is the only notice the
    // board gets that the user has moved into or out of a sub-thread.
    this.onDocument(THREAD_FOCUS_CHANGED, () => this.render());
    // A board has no columns, so pointing at a thread is something it asks the
    // window it was detached from to do. That is all the link is for now, and it
    // is why a board with no owner left is a board that still works.
    if (isPinboardView()) {
      satelliteLink.start();
      // Whether this window can ask its owner anything is not known while the
      // page is being parsed — the id arrives on the session frame — and it is
      // what decides whether the conversation in the header is a control. So the
      // header is written again once the answer is in.
      this.addCleanup(onLinkAvailability(() => this._nameWindow(this._boardTitle)));
    } else {
      this._restoreBoards();
    }
    this.render();
  }

  /**
   * Reopen the boards that were open when Juggler was last shut.
   *
   * It happens here, in the page, because a board is opened by a viewer and
   * addressed to one. The viewer id is minted by the browser into sessionStorage
   * and does not outlive the process, so the owner recorded with a board last
   * run reaches nobody this run — and only a live window knows its own id.
   * Reopening from a window is therefore not a workaround: it is the only place
   * an owner exists at all.
   *
   * The id arrives on the session frame, always later than this element
   * upgrades, so this waits for it rather than sampling it once and getting the
   * empty answer every time. The server answers the claim once, so every main
   * window of a project can ask and only the first is given anything.
   * @private
   */
  _restoreBoards() {
    let asked = false;
    this.addCleanup(onLinkAvailability(() => {
      if (asked || !canLinkBoards()) return;
      asked = true;
      void ownerLink.restoreBoards();
    }));
  }

  /**
   * Read in the conversation this board is a view of.
   *
   * The await is load-bearing. `getConversation` answers with a live but empty
   * conversation for one this viewer has never opened, and an empty transcript
   * is indistinguishable from an empty conversation. `switchConversation` is
   * deliberately not how this is done: it saves the session, and the session's
   * active conversation is the one every future viewer of this project opens on
   * — a board is a second view of a conversation, not a vote for it.
   * @returns {Promise<void>}
   * @private
   */
  async _openBoardConversation() {
    const conversationId = boardConversationId();
    const session = /** @type {any} */ (this._session);
    if (!conversationId || !session) {
      this._boardState = 'missing';
      this.render();
      return;
    }
    if (typeof session.ensureConversationLoaded === 'function') {
      try {
        await session.ensureConversationLoaded(conversationId);
      } catch (err) {
        console.error('[Pinboard] Could not read the conversation this board is a view of:', err);
      }
    }
    this._boardState = session.getConversation?.(conversationId) ? 'ready' : 'missing';
    this.render();
  }

  /**
   * Give up the conversation this board was a view of.
   *
   * A board is a window onto one conversation, so a conversation that has been
   * deleted leaves this window nothing to show and nothing to become: it says
   * which one has gone and asks to be closed. The order matters — a window that
   * cannot be closed from script, a browser tab the user opened themselves,
   * keeps that message rather than a transcript that is no longer anywhere.
   * @private
   */
  _loseConversation() {
    this._boardState = 'missing';
    this.render();
    closeThisWindow();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._closePicker?.();
    this._closePicker = null;
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
  }

  /**
   * Supply the session the active-context snapshot is read from.
   * @param {import('../model/session.js').default} session - The viewer's session.
   * @returns {void}
   */
  setSession(session) {
    if (this._session === session) return;
    this._unsubscribeSession?.();
    this._session = session;
    this._content?.setSession(session);
    // The session arrives after the element is built, so this is the first
    // moment a board can go looking for the conversation it exists to show.
    if (isPinboardView() && session) void this._openBoardConversation();
    this._unsubscribeSession = session
      ? session.subscribe((event) => {
        switch (event.type) {
          case 'session:loaded':
          case 'conversation:switched':
          case 'conversation:renamed':
          case 'conversation:created':
            this.render();
            break;
          case 'conversation:deleted':
            // The session is asked rather than the event: deleting and binning
            // both arrive as this, and both have already taken the conversation
            // out of the session by the time they do. A board still opening, or
            // one that never found its conversation, has nothing to lose.
            if (isPinboardView() && this._boardState === 'ready'
              && !session.getConversation(boardConversationId())) {
              this._loseConversation();
              break;
            }
            this.render();
            break;
          default:
            break;
        }
      })
      : null;
    this.render();
  }

  /**
   * Move focus into the board, so Escape and the Back button have somewhere to
   * dismiss from and the keyboard is already here.
   *
   * The pin's body, not the selected tab. A tab is a control, and focusing one
   * rings it: WebKit treats a programmatic focus as keyboard-driven, so opening
   * the board with the pointer drew a focus ring nobody had asked for. The body
   * is a region — focusable, not a tab stop, and deliberately unringed — so
   * focus arrives with nothing selected, and Tab from there still reaches the
   * strip for anyone who wants it.
   * @returns {void}
   */
  focusInto() {
    this._content?.focusBody();
  }

  /**
   * The keys the board answers to while it has focus, and the rules about whose
   * they are.
   *
   * Three places a keystroke can come from, and the board owns less of the
   * keyboard the further in it is:
   *
   * - the region (the tab panel itself, which is where focus lands on opening):
   *   ←/→ step along the tabs, ↑/↓ and the Page/Home/End keys scroll the pin,
   *   Return goes into it. Nothing is being read or edited here, so the board
   *   may have the lot.
   * - inside the pin: the pin's, apart from ←/→ — a stepped-through pin that
   *   drew a list of buttons should not strand the reader on the last of them —
   *   and Escape, which is the way back out to the region. A pin that wants
   *   either says so by handling the key itself: this stands down for anything
   *   already handled, and for anything typed into a text field.
   * - the tab strip: its own, in full. It runs the ARIA tablist behaviour, and
   *   what reaches here from it is a key it did not want.
   *
   * Everything chorded belongs to the shell, which hears it wherever focus is.
   * @param {KeyboardEvent} e - The keydown.
   * @private
   */
  _onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const content = this._content;
    if (!content) return;
    const target = e.target;
    const inPin = content.isInsidePin(target);

    if (e.key === 'Escape') {
      // From the region, Escape is the board's own dismissal and is left to it.
      if (!inPin) return;
      content.focusRegion();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (isEditableTarget(target)) return;
    if (this._tabbar?.contains(/** @type {Node} */ (target))) return;
    const onRegion = target === content;
    if (!onRegion && !inPin) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const before = pinboardView.getActivePinId();
        const now = pinboardView.selectRelative(e.key === 'ArrowLeft' ? -1 : 1);
        // Showing another pin unmounts the one the keystroke came from, so focus
        // would fall to the document and the press after this would reach
        // nothing at all. It goes to the region and stops there: taking the new
        // pin's entry point would hand the next arrow to whatever that is.
        if (now !== before) content.focusRegion();
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        // Only from the region. Deeper in, the pin's own scroll box is an
        // ancestor of what is focused and the browser is already doing this.
        if (!onRegion || !content.scrollPin('line', e.key === 'ArrowUp' ? -1 : 1)) return;
        break;
      case 'PageUp':
      case 'PageDown':
        if (!onRegion || !content.scrollPin('page', e.key === 'PageUp' ? -1 : 1)) return;
        break;
      case 'Home':
      case 'End':
        // The ends of the pin, not the ends of the board: this is a scroll box
        // with focus in it, and the strip's own Home/End still name tabs.
        if (!onRegion || !content.scrollPin('edge', e.key === 'Home' ? -1 : 1)) return;
        break;
      case 'Enter':
        if (!onRegion || !content.enterPin()) return;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Build the three bands once.
   * @private
   */
  _build() {
    if (this._tabbar) return;

    // The toolbar names the surface and carries the controls that put it away.
    // A board window needs none of it: the window frame is the chrome, its own
    // header already says what is being shown, and both controls are
    // meaningless there — a board in a window has nothing to pop out of, and
    // closing it would leave an empty frame the window's own controls already
    // handle. Built here, the band would be a full-width strip reading
    // "Pinboard" directly beneath a header reading "Pinboard".
    const toolbar = isPinboardView() ? null : this._buildToolbar();

    const tabbar = document.createElement('pinboard-tabbar');
    const content = document.createElement('pinboard-content');

    const placeholder = document.createElement('div');
    placeholder.className = 'pinboard-placeholder';
    placeholder.hidden = true;

    const status = document.createElement('div');
    status.className = 'pinboard-panel__status';
    status.setAttribute('role', 'status');
    status.hidden = true;

    if (toolbar) this.append(toolbar);
    this.append(tabbar, content, placeholder, status);
    this._tabbar = tabbar;
    this._content = content;
    this._placeholder = placeholder;
    this._status = status;
    // setSession can land before this element is connected, so hand over
    // whatever is already held rather than relying on that call's own push.
    /** @type {any} */ (content).setSession(this._session);

    this.on(this, 'pinboard-select', (e) => {
      pinboardView.setActivePin(/** @type {CustomEvent} */ (e).detail.pinId);
    });
    this.on(this, 'pinboard-remove', (e) => {
      void pinboardView.remove(/** @type {CustomEvent} */ (e).detail.pinId, this._activeContext());
    });
    this.on(this, 'pinboard-move', (e) => {
      const { pinId, index } = /** @type {CustomEvent} */ (e).detail;
      const bounded = Math.max(0, Math.min(pinboardStore.get().length - 1, index));
      void pinboardView.move(pinId, bounded);
    });
    this.on(this, 'pinboard-add', () => this._openPicker());

    // On the panel rather than the document, which is the whole of how the board
    // and its pins share a keyboard: a pin's own handler sits deeper in the tree,
    // so it runs first and takes what it wants before this ever sees it.
    this.on(this, 'keydown', (e) => this._onKeyDown(/** @type {KeyboardEvent} */ (e)));

    // The other half of a detached board lives here: this viewer carries out the
    // reveals its boards send back. It is registered whether or not this
    // viewer's own board is open — a board has to keep working while the window
    // it was detached from has the overlay shut.
    if (!isPinboardView()) {
      ownerLink.serve({
        onReveal: (target) => { void this._revealForBoard(target); },
        onSelect: (conversationId) => { void this._showConversationForBoard(conversationId); },
        onCompose: (compose) => { void this._composeForBoard(compose); },
      });
    }
  }

  /**
   * Bring this window forward on the conversation a board named.
   *
   * A board stays on the conversation it was opened for while this window goes
   * wherever the user goes, so the two disagreeing is the ordinary case and not
   * a mistake to refuse.
   *
   * This is the one place a board may set which conversation is active, and it
   * is set here for the reason the rest of the file avoids doing it: the user
   * asked for this conversation, so recording it as the one they are on is what
   * they meant, not a side effect of a board having been opened.
   * @param {string} conversationId - The conversation the board is a view of.
   * @returns {Promise<boolean>} False when a switch was called for and did not
   *   happen, so there is no point going on to point at anything. A conversation
   *   this viewer does not have is not a failure — there was nothing to switch to.
   * @private
   */
  async _showConversationForBoard(conversationId) {
    return showConversation(this._session, conversationId);
  }

  /**
   * Carry out one board's reveal in this window's columns. Being pointed at
   * something is a request to go and look at it: show the conversation the board
   * names, then point.
   * @param {{kind: string, id: string|null, thread?: string|null, conversation: string}} target - What to reveal.
   * @returns {Promise<void>}
   * @private
   */
  async _revealForBoard(target) {
    if (!(await this._showConversationForBoard(target.conversation))) return;
    revealInConversation(target);
  }

  /**
   * Put a board's text in this window's prompt, on the thread it names.
   *
   * The conversation is shown first for the reason a reveal shows it: text in a
   * box nobody can see is worse than no text, and the box it goes in has to be the
   * one for the thread the board was reading — not whatever this window happened
   * to be looking at. {@link composeForThread} then does exactly what it does for
   * a board sharing a window, including sending the message when that thread has
   * no box on screen, so the feedback is never silently dropped.
   * @param {{text: string, conversation: string, thread: string|null}} compose - What to put where.
   * @returns {Promise<void>}
   * @private
   */
  async _composeForBoard({ text, conversation: conversationId, thread: threadItemId }) {
    if (!(await this._showConversationForBoard(conversationId))) return;
    const conversation = /** @type {any} */ (this._session)?.getConversation?.(conversationId);
    if (!conversation) return;
    let thread = null;
    try {
      thread = conversation.resolveMessageThread(threadItemId ?? null);
    } catch {
      // A thread id this window cannot resolve — the board is reading something
      // that has since gone. The root is still the right place for the words.
      thread = conversation.rootMessageThread;
    }
    if (!thread) return;
    try {
      await composeForThread(thread, text);
    } catch (err) {
      console.error('[Pinboard] Could not put a board\'s text in the prompt:', err);
      pinboardView.setStatus(t("Couldn't put the board's text in the prompt: {error}", { error: extractErrorMessage(err) }));
    }
  }

  /**
   * The board's top band, for a board sharing a window with everything else: it
   * names the surface, and holds the two controls that move or close it.
   * @returns {HTMLElement} The toolbar.
   * @private
   */
  _buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'pinboard-toolbar';

    const identity = document.createElement('span');
    identity.className = 'pinboard-toolbar__identity';
    identity.textContent = t('Pinboard');

    const controls = document.createElement('div');
    controls.className = 'pinboard-toolbar__controls';

    // A viewer nothing can address — a peer-to-peer one, whose channel opens
    // with no request to carry an id — could not be followed by the board it
    // opened. Whether this viewer has an address is not yet known here: the id
    // arrives on the session frame, and this runs while the page is still being
    // parsed. So the button is built now and shown once the answer is in,
    // rather than asked a question that only ever has one answer this early.
    const popOut = document.createElement('button');
    popOut.type = 'button';
    popOut.className = 'btn-ghost pinboard-toolbar__popout';
    popOut.title = t('Open this board in its own window');
    popOut.setAttribute('aria-label', t('Pop out Pinboard'));
    // eslint-disable-next-line juggler/escape-html-interpolation -- POPOUT_ICON_PATH is this module's constant path data
    popOut.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${POPOUT_ICON_PATH}"/></svg><span>${escapeHtml(t('Pop-out'))}</span>`;
    popOut.hidden = !canLinkBoards();
    this.on(popOut, 'click', () => { void this._popOut(); });
    controls.appendChild(popOut);
    this._popOutButton = popOut;
    this.addCleanup(onLinkAvailability(() => this._syncPopOut()));

    const close = document.createElement('button');
    close.type = 'button';
    // The app's close button, glyph and all: a surface that puts itself away
    // should not have a private way of saying so.
    close.className = 'close-button';
    close.title = t('Close Pinboard');
    close.setAttribute('aria-label', t('Close Pinboard'));
    close.innerHTML = '<span class="icon-close"></span>';
    this.on(close, 'click', () => pinboardView.close());
    controls.appendChild(close);

    toolbar.append(identity, controls);
    return toolbar;
  }

  /**
   * Say what this window is showing, in the strip the window frame leaves behind.
   *
   * Only a board window has anything to put there — in the ordinary view the
   * header is the app's own and the panel is a guest in it. The element lives
   * outside this component because it belongs to the window rather than to the
   * board, and the board is the only thing that knows which conversation and
   * which pin are up.
   *
   * Two parts, at the two ends. The conversation follows the logo, because it is
   * what this window is a view of and the one thing nothing else on screen says;
   * what kind of window it is sits away at the far end, where it is available to
   * be read and not in the way of the name. The selected tab is not named here —
   * the tab strip below is already showing which one is up.
   *
   * The name is a control when there is a window to send it to and that window
   * can be brought forward: this board is a view of that conversation, and the
   * whole of the conversation is one window away. Where there is no owner to ask
   * — a board restored after the window that opened it closed, or a viewer
   * nothing can address — or where these are browser tabs, which cannot raise
   * one another, it is the plain text it has always been, rather than a control
   * that quietly does nothing.
   * @param {string} conversationTitle - The conversation's name, or '' for none.
   * @private
   */
  _nameWindow(conversationTitle) {
    if (!isPinboardView()) return;
    const slot = document.getElementById('board-title');
    if (!slot) return;

    // Every render says what the window is showing, and nearly every render says
    // the same thing. Rebuilding regardless would throw away a control the user
    // may have keyboard focus on, to replace it with one exactly like it.
    // The desktop app raises the window it is pointed at; a browser tab can only
    // ask, and a browser declining to raise a tab nobody clicked on is within its
    // rights. So in a tab the ask lands somewhere the user cannot see it happen,
    // which is a control that does nothing as far as they are concerned.
    const linked = isDesktopWindow() && !!ownerViewerId() && canLinkBoards();
    const state = `${linked}\u0000${conversationTitle}`;
    if (state === this._namedAs) return;
    this._namedAs = state;

    /** @type {HTMLElement[]} */
    const parts = [];
    if (conversationTitle) {
      const conversation = document.createElement(linked ? 'button' : 'span');
      conversation.className = 'app-header__board-conversation';
      conversation.textContent = conversationTitle;
      if (linked) {
        const button = /** @type {HTMLButtonElement} */ (conversation);
        button.type = 'button';
        button.title = t('Show this conversation in the main window');
        button.setAttribute('aria-label', t('Show this conversation in the main window'));
        // Listeners rather than `this.on`: the node is replaced whenever the name
        // changes, and a per-render cleanup entry for a node already discarded
        // would be a list that only grows.
        //
        // The name sits in the window's drag region, so it is one of the places
        // the window gets picked up by — and the release that ends that drag is
        // delivered here as a click.
        const drag = dragGuard();
        button.addEventListener('pointerdown', drag.watch);
        button.addEventListener('click', () => {
          if (drag.dragged()) return;
          satelliteLink.selectConversation(boardConversationId());
        });
      }
      parts.push(conversation);
    }
    const kind = document.createElement('span');
    kind.className = 'app-header__board-kind';
    kind.textContent = t('Pinboard');
    parts.push(kind);
    slot.replaceChildren(...parts);
  }

  /**
   * Offer Pop-out exactly when a board opened from here could find its way back.
   * @private
   */
  _syncPopOut() {
    if (this._popOutButton) this._popOutButton.hidden = !canLinkBoards();
  }

  /**
   * Open this board again in a window of its own, on the pin being read and the
   * conversation being shown, and put the overlay away behind it.
   *
   * The conversation is taken here, at the moment of the click, and it is what
   * the new window is a view of from then on: this window is free to go
   * anywhere afterwards. A pop-out that did not happen leaves the board where it
   * was, with the complaint under it.
   * @private
   */
  async _popOut() {
    const active = this._activeContext();
    // Measured here, while the panel is still open and still where the user is
    // looking at it: this is what the window opens over, and the awaited detach
    // below ends with the panel put away.
    const frame = frameHintOf(this);
    // The new window starts as a copy of this panel, so detaching changes
    // nothing about what is on screen — it puts what is on screen into a window,
    // which is what the word says. The two go their own ways from there.
    const complaint = await ownerLink.detach(
      pinboardView.getActivePinId() || '',
      active.conversation?.id || '',
      pinboardStore.get(),
      frame,
    );
    pinboardView.setStatus(complaint);
    if (!complaint) pinboardView.close();
  }

  /**
   * Draw the board as it stands.
   */
  render() {
    if (!this._tabbar || !this._content) return;
    // A board window is the window, so it is on screen for as long as it
    // exists. The docked panel is put away with a transform and stays in the
    // document, and the pin mounted in it has no other way to be told.
    this._content.setVisible(isPinboardView() || pinboardView.isOpen());
    if (this._renderBoardState()) return;
    const pins = pinboardStore.get();
    const active = this._activeContext();
    // Kept while there is one to keep: this is the only place the name of the
    // conversation a board is a view of is ever in hand.
    if (isPinboardView()) this._boardTitle = active.conversation?.title || this._boardTitle;
    const json = JSON.stringify(active);
    const contextChanged = json !== this._contextJson;
    this._contextJson = json;

    const activeId = pinboardView.getActivePinId();
    this._tabbar.setTabs(
      pins.map((pin) => {
        const described = describePin(pin, active);
        return { id: pin.id, title: described.title, badge: described.badge };
      }),
      activeId,
    );

    const activePin = pins.find((pin) => pin.id === activeId) || null;
    this._nameWindow(active.conversation?.title || '');
    // A retained pin stays mounted while another tab is showing, so the board is
    // the only thing that can say it has gone. The board is shared: it may have
    // been removed by a viewer that is not this one.
    this._content.syncPins(pins);
    const mounted = this._content.setPin(activePin, active);
    // A pin that was already mounted takes the new snapshot in place; one that
    // has just been mounted was given it already.
    if (contextChanged && !mounted) this._content.setActiveContext(active);

    const status = pinboardView.getStatus();
    if (this._status) {
      this._status.textContent = status;
      this._status.hidden = !status;
    }
  }

  /**
   * Show a detached board's two other states in place of the board.
   *
   * A board still opening its conversation, or one whose conversation is not in
   * this project, is not an empty board — it is a board with nothing to be a
   * view of. Both say so rather than drawing tabs against a transcript nobody
   * can read.
   *
   * A board that has lost its conversation names it, when it was around long
   * enough to learn the name: this window is one of several, all of them called
   * Pinboard, and which one has stopped working is the question its user is
   * actually asking.
   * @returns {boolean} True when the board itself was not drawn.
   * @private
   */
  _renderBoardState() {
    const placeholder = this._placeholder;
    if (!placeholder) return false;
    const showing = isPinboardView() && this._boardState !== 'ready';

    placeholder.hidden = !showing;
    this._tabbar.hidden = showing;
    this._content.hidden = showing;
    if (!showing) return false;
    // Nothing may still be reading against a conversation this board cannot
    // show: a pin left mounted here would go on polling for one, and a tab left
    // standing would name it.
    this._contextJson = '';
    this._tabbar.setTabs([], null);
    this._content.setPin(null, this._activeContext());
    // Including the retained ones, which setPin only hides: a pin kept alive
    // here would go on running against a conversation this board can no longer
    // show, which is the very thing this branch exists to prevent.
    this._content.syncPins([]);
    // A board that cannot name its conversation yet says only what it is, so the
    // header holds no name from a conversation this window has stopped showing.
    this._nameWindow('');

    const gone = this._boardState === 'missing';
    const line = document.createElement('p');
    line.className = 'pinboard-placeholder__line';
    if (!gone) line.textContent = t('Opening the conversation.');
    else if (this._boardTitle) line.textContent = t('“{title}” has gone.', { title: this._boardTitle });
    else line.textContent = t('This conversation is no longer available.');
    placeholder.replaceChildren(line);
    return true;
  }

  /**
   * Tear every mounted pin down and build it again — what an extension reload
   * needs, since the class behind each pin has been replaced.
   * @private
   */
  _remount() {
    this._contextJson = '';
    this._content?.setPin(null, this._activeContext());
    // Retention must not survive a reload: the class behind a retained pin has
    // just been replaced, so keeping the old one alive would be keeping exactly
    // the thing the reload was meant to get rid of.
    this._content?.syncPins([]);
    this.render();
  }

  /**
   * The immutable snapshot every item type is rendered against.
   *
   * One substitution makes a detached board what it is: the conversation is the
   * one its URL names rather than the one this viewer is showing, and the thread
   * is that conversation's root. A board has no columns and follows no reader,
   * so there is no thread being looked at here to report — and a board that
   * reported this window's own visible conversation would be a second, quieter
   * view of whatever the app is doing, which is the one thing it must not be.
   * @returns {PinActiveContext} Project, conversation and thread as they stand.
   * @private
   */
  _activeContext() {
    // The name as it is drawn — a placeholder in the UI language — or '' for
    // a conversation that has none.
    const titleOf = (/** @type {any} */ conversation) =>
      (conversation.name ? displayConversationName(conversation.name) : '');
    const session = /** @type {any} */ (this._session);
    const path = session?.projectPath || '';
    const project = { path, displayName: baseName(path) };
    if (isPinboardView()) {
      const conversation = session?.getConversation?.(boardConversationId()) || null;
      return {
        project,
        conversation: conversation ? { id: conversation.id, title: titleOf(conversation) } : null,
        thread: conversation ? { id: null } : null,
      };
    }
    const conversation = session?.getVisibleConversation?.() || null;
    return {
      project,
      conversation: conversation ? { id: conversation.id, title: titleOf(conversation) } : null,
      thread: conversation ? { id: focusedThreadItemId() } : null,
    };
  }

  /**
   * Open the add picker against whichever control asked for it.
   * @private
   */
  _openPicker() {
    this._closePicker?.();
    const anchor = /** @type {HTMLElement|null} */ (this._tabbar?.getAddButton());
    if (!anchor) return;
    this._closePicker = openAddPicker({
      anchor,
      active: this._activeContext(),
      onPick: (typeId) => {
        this._closePicker = null;
        void this._add(typeId);
      },
    });
  }

  /**
   * Add a pin of a type, giving the item type its chance to ask for a config
   * first. A picker the user backed out of is not an error.
   * @param {string} typeId - The chosen item-type id.
   * @returns {Promise<void>}
   * @private
   */
  async _add(typeId) {
    const type = pinboardItemRegistry.getType(typeId);
    if (!type) return;
    /** @type {Record<string, any>|null} */
    let config = {};
    const abort = new AbortController();
    try {
      config = await type.configure({ active: this._activeContext(), signal: abort.signal });
    } catch (err) {
      pinboardView.setStatus(t("Couldn't add that pin. {error}", { error: extractErrorMessage(err) }));
      return;
    }
    if (config === null) return;
    await pinboardView.add(typeId, config);
  }
}

customElements.define('pinboard-panel', PinboardPanel);

export default PinboardPanel;
