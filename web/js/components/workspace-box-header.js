//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The top of a workspace's box in the tab bar: what the place is called.
 *
 * It is the workspace's own row, not any conversation's, and a name is nearly
 * all of what a strip two hundred pixels wide can say about a place. Everything
 * else true of the tree — where it is, how it is doing, and the ways of
 * finishing with it — is <workspace-panel>'s, shown when the box is selected,
 * where there is room to read it and to aim at it. A header carrying all of
 * that was a title, a status line and two buttons in the width of a tab.
 *
 * The one exception is uncommitted work, which stays here as a dot beside the
 * name: it is the state that decides whether an ending costs anything, it is
 * worth a mark rather than a word, and a mark fits. That is the whole reason
 * this still asks the provider anything.
 * @module components/workspace-box-header
 */

import JugglerElement from './juggler-element.js';
import { workspaceStatus } from '../services/workspace-provisioning.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * WorkspaceBoxHeader - a workspace, named above the conversations working in it.
 */
class WorkspaceBoxHeader extends JugglerElement {
  constructor() {
    super();

    /** @type {any} The session the workspace belongs to. */
    this._session = null;

    /** @type {any} The row this is the header for. */
    this._workspace = null;

    /** @type {any} What its provider last said about it. */
    this._status = null;

    /** @type {AbortController|null} The status read in flight, if there is one. */
    this._probe = null;
  }

  /**
   * Ask again about a workspace whose status read a disconnect abandoned. A box
   * the bar moves is not handed its context again until the bar next draws,
   * which on a quiet window may be never.
   */
  connectedCallback() {
    if (this._workspace && !this._status && !this._probe) void this.refreshStatus();
  }

  /**
   * Let go of the probe. The bar removes a box when its workspace stops being
   * one, which can happen with a question outstanding.
   */
  disconnectedCallback() {
    super.disconnectedCallback();
    this._probe?.abort();
    this._probe = null;
  }

  /**
   * Tell the header what it is about. Called on every render of the bar, so it
   * does as little as possible unless something has actually changed.
   * @param {{session: any, workspace: any}} context - The session and the row.
   */
  setContext({ session, workspace }) {
    const changed = this._workspace?.id !== workspace?.id;
    this._session = session;
    this._workspace = workspace;
    if (changed) this._status = null;
    this.render();
    // The row names the place but says nothing about the state of the tree, so
    // the first draw is followed by the question.
    //
    // Once, though, not once per render: the bar re-renders on every document
    // change — up to a hundred times a second while a turn streams — and each
    // of those would abort the probe the last one started, leaving a box that
    // never manages to say anything about itself for as long as work is going
    // on.
    if (changed || (!this._status && !this._probe)) void this.refreshStatus();
  }

  /**
   * Ask the workspace's provider how it is doing.
   *
   * Lazily, never on a timer: this is ambient information, and a sidebar
   * polling git for every workspace in every open window would be a cost nobody
   * asked for. It is read when the box is first drawn for a workspace, and when
   * the table moves.
   * @returns {Promise<void>} When there is an answer, or it has been abandoned.
   */
  async refreshStatus() {
    const workspace = this._workspace;
    this._probe?.abort();
    this._probe = null;
    if (!workspace || !this._session) return;

    const controller = new AbortController();
    this._probe = controller;
    const status = await workspaceStatus(this._session, workspace, controller.signal);
    // Both are worth asking: the answer may be to a question about a workspace
    // this header has since stopped being about.
    if (controller.signal.aborted || this._workspace?.id !== workspace.id) return;
    this._probe = null;
    this._status = status;
    this.render();
  }

  /**
   * What the header calls the place: the name on its row.
   *
   * The row is the only thing that names a workspace, and the status read above
   * is here for the dirty dot alone — a box that renamed itself when a git call
   * came back would move the name a user aims at in a strip they are reading.
   * @returns {string} The name.
   * @private
   */
  _label() {
    return this._workspace?.label || this._workspace?.root || '';
  }

  render() {
    if (!this._workspace) {
      this.replaceChildren();
      return;
    }

    if (!this.querySelector('.conversation-box-title')) this._build();

    const label = this._label();
    const dirty = this._status?.dirty === true;

    const name = this.querySelector('.conversation-box-label-text');
    if (name && name.textContent !== label) name.textContent = label;
    this.classList.toggle('is-dirty', dirty);
    // A tooltip repeating a name the lozenge shows in full says nothing, so the
    // header's own is only to put the dirty dot into words.
    if (dirty) this.title = t('Holding uncommitted work');
    else this.removeAttribute('title');
  }

  /**
   * Build the header's furniture, once. The name is written by {@link render},
   * which leaves these nodes where they are.
   * @private
   */
  _build() {
    const title = document.createElement('div');
    title.className = 'conversation-box-title';

    // The name is a lozenge (patterns/item-badge.css) filled with the box's
    // tint. Its text is an element of its own so that a long name ellipsises
    // inside the lozenge and leaves room for the uncommitted-work mark after it.
    const name = document.createElement('span');
    name.className = 'item-lozenge conversation-box-label';
    const text = document.createElement('span');
    text.className = 'conversation-box-label-text';
    // Cut short, the name is offered in full by the tooltip manager; when it
    // fits, the header's own title (the uncommitted-work note) stands.
    text.setAttribute('data-tooltip-overflow', '');
    name.appendChild(text);
    title.appendChild(name);

    this.replaceChildren(title);
  }
}

customElements.define('workspace-box-header', WorkspaceBoxHeader);
