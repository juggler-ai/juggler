//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-conversations-overlay> — full-area placeholder shown when a project is
 * loaded but no conversation is open.
 *
 * One route reaches it: binning the last conversation, which `binConversation`
 * deliberately allows (deleting the last one is refused instead). The session
 * re-seeds a conversation on its next load, so this is a live-session state
 * that ends the moment the user starts one — which is all this says.
 *
 * <no-project-overlay> handles the state before this one, and the two never
 * show together: that one needs a project absent, this one needs it present.
 */

import JugglerElement from './juggler-element.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

class NoConversationsOverlay extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {Function|null} @private */
    this._unsubscribe = null;
    /** @type {boolean} @private */
    this._rendered = false;
  }

  connectedCallback() {
    // Put back with the session it already has, which nobody hands it again:
    // take back the feed the disconnect dropped, and catch up on what it missed.
    if (this._session && !this._unsubscribe) {
      this._listen();
      this._refresh();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Re-assignable (setSession drops and re-takes it), so a field rather than
    // an addCleanup registration.
    this._stopListening();
  }

  /**
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    this._stopListening();
    this._session = session;
    this._refresh();
    if (this.isConnected) this._listen();
  }

  /** @private */
  _stopListening() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /**
   * Follow the events that can empty or fill the project. A no-op without a
   * session or while already listening.
   * @private
   */
  _listen() {
    const session = this._session;
    if (!session || this._unsubscribe) return;
    this._unsubscribe = session.subscribe((/** @type {{type: string}} */ event) => {
      if (
        event.type === 'session:loaded'
        || event.type === 'conversation:created'
        || event.type === 'conversation:deleted'
      ) {
        this._refresh();
      }
    });
  }

  /** @private */
  _refresh() {
    const session = this._session;
    const empty = !!session && !!session.projectPath && session.conversations.size === 0;

    // The tab column is hidden by one class on <body>, whose rule lives beside
    // <no-project-overlay>'s in the layout layer, for the reason given there.
    // The sidebar is NOT hidden: it holds the "+" this copy points at.
    document.body.classList.toggle('no-conversations', empty);

    if (!empty) {
      this.hidden = true;
      this._rendered = false;
      this.innerHTML = '';
      return;
    }

    this.hidden = false;

    if (!this._rendered) {
      this._rendered = true;
      this.render();
    }
  }

  /** Draw the element as its state stands. Repeatable. */
  render() {
    const product = 'Juggler'; // i18n-ignore: the product name, which the logo spells out
    this.innerHTML = `
      <section class="onboarding-panel" aria-label="${escapeHtml(t('No conversations'))}">
        <div class="onboarding-logo" role="img" aria-label="${escapeHtml(product)}"></div>
        <p>${escapeHtml(t('Click \'+ New conversation\' in the sidebar to start one.'))}</p>
      </section>
    `;
  }
}

customElements.define('no-conversations-overlay', NoConversationsOverlay);
