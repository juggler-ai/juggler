//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { formatRelativeDateTime, formatBytes } from '../utils/format.js';
import { BIN_LARGE_BYTES } from '../utils/constants.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { fadeOutScrims } from '../utils/modal-scrim.js';
import { presentPopup } from '../utils/popup-surface.js';
import { showAlert, showConfirm } from './modal-dialog.js';
import JugglerElement from './juggler-element.js';
import { UNTITLED_BASE } from '../model/conversation-naming.js';

/**
 * @typedef {object} BinnedConvRow
 * @property {string} id - Conversation ID (conv_*)
 * @property {string} name - Human-readable name from the folder
 * @property {string} lastModifiedAt - ISO 8601 of the conversation's last edit
 */

/**
 * Popup id for the Empty Bin menu (mutual exclusion).
 * @type {string}
 */
const EMPTY_MENU_POPUP_ID = 'bin-empty-menu';

/**
 * Age cutoffs the Empty Bin menu offers, in days.
 * @type {number[]}
 */
const EMPTY_CUTOFF_DAYS = [7, 30, 90];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * BinModal — popup listing binned conversations with Restore / Delete
 * actions plus an "Empty Bin" header button. Opened from the "Bin" button at
 * the bottom of the conversation bar. The bin is a permanent holding area:
 * items stay until the user restores them or empties the bin (nothing
 * auto-expires). Re-fetches the list every time it's opened; refreshes after
 * each user action so restore/delete results are immediately visible.
 *
 * Emptying is age-scoped: the header button opens a menu offering the whole bin
 * or only the conversations older than a cutoff. "Older" means last active —
 * the same date each row shows — not time served in the bin, which nothing
 * records (see BinnedConvInfo in core/session.go).
 */
class BinModal extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    // The rows the last refresh returned, so the Empty Bin menu can size each
    // cutoff without a second request.
    /** @type {BinnedConvRow[]} @private */
    this._binned = [];
    /** @type {HTMLElement|null} @private */
    this._emptyMenu = null;
    /** @type {(() => void)|null} @private */
    this._emptyMenuRelease = null;
  }

  /**
   * Open the modal for the given session.
   * @param {import('../model/session.js').default} session
   */
  async open(session) {
    this._session = session;
    this.render();
    this.classList.add('is-open');
    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this.close());
    }
    await this._refreshList({ onOpen: true });
  }

  close() {
    this._closeEmptyMenu();
    fadeOutScrims(this);
    this.classList.remove('is-open');
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
  }

  render() {
    this.innerHTML = `
      <modal-backdrop class="modal-backdrop-el bin-backdrop"></modal-backdrop>
      <modal-panel class="modal-container bin-panel">
        <header class="modal-header">
          <h2 class="modal-title">Bin</h2>
          <div class="bin-header-actions">
            <button class="bin-empty-now" type="button" disabled aria-haspopup="menu" aria-expanded="false">Empty Bin</button>
            <button class="bin-close" aria-label="Close" title="Close">×</button>
          </div>
        </header>
        <div class="modal-body bin-body">
            <div class="bin-empty hidden">The bin is empty.</div>
            <div class="bin-size-notice hidden" role="status"></div>
          <ul class="bin-list" role="list"></ul>
        </div>
      </modal-panel>
    `;
    const backdrop = this.querySelector('.bin-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }
    const closeBtn = this.querySelector('.bin-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    const emptyBtn = this.querySelector('.bin-empty-now');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => this._toggleEmptyMenu());
    }
  }

  /**
   * Re-fetch the binned list and re-render rows.
   * @param {{onOpen?: boolean}} [options] - `onOpen` marks the first refresh of
   *   a freshly opened modal, where an empty bin is a standing state rather than
   *   the result of something the user just did in here.
   * @private
   */
  async _refreshList({ onOpen = false } = {}) {
    if (!this._session) return;
    const list = /** @type {HTMLUListElement|null} */ (this.querySelector('.bin-list'));
    const empty = /** @type {HTMLElement|null} */ (this.querySelector('.bin-empty'));
    const emptyBtn = /** @type {HTMLButtonElement|null} */ (this.querySelector('.bin-empty-now'));
    const notice = /** @type {HTMLElement|null} */ (this.querySelector('.bin-size-notice'));
    if (notice) notice.classList.add('hidden');
    if (!list || !empty) return;

    /** @type {BinnedConvRow[]} */
    let binned = [];
    try {
      binned = await this._session.bin.list();
    } catch (e) {
      console.error('[BinModal] Failed to load binned list:', e);
      this._binned = [];
      empty.classList.remove('hidden');
      empty.textContent = 'Couldn’t load the bin.';
      list.innerHTML = '';
      if (emptyBtn) {
        emptyBtn.disabled = true;
        emptyBtn.textContent = 'Empty Bin';
      }
      return;
    }

    // Kept so the Empty Bin menu can size each cutoff against the current bin
    // without a second request.
    this._binned = binned;

    list.innerHTML = '';
    if (emptyBtn) {
      emptyBtn.disabled = binned.length === 0;
      // bin.list() refreshed bin.sizeBytes above; fold the
      // approximate folder size into the button so "Empty Bin (50 MB)" tells
      // the user how much they're about to reclaim.
      const sizeBytes = this._session.bin.sizeBytes || 0;
      emptyBtn.textContent = binned.length > 0 && sizeBytes > 0
        ? `Empty Bin (${formatBytes(sizeBytes)})`
        : 'Empty Bin';
    }
    if (binned.length === 0) {
      empty.classList.remove('hidden');
      // The wry reading only holds for a bin that was already empty when the
      // user got here. After they restore, delete, or empty something the
      // emptiness is their own doing, so it is stated plainly.
      empty.textContent = onOpen
        ? 'Empty. Either you’re very tidy or you’re new.'
        : 'The bin is empty.';
      return;
    }
    empty.classList.add('hidden');

    // A bin nothing ever empties on its own is worth naming once it is large:
    // the size alone reads as a label, and the second sentence is the part the
    // user cannot infer — that it will sit there until they act.
    const noticeBytes = this._session.bin.sizeBytes || 0;
    if (notice && noticeBytes >= BIN_LARGE_BYTES) {
      notice.textContent = `The bin is holding ${formatBytes(noticeBytes)}. Nothing here is deleted automatically.`;
      notice.classList.remove('hidden');
    }

    for (const row of binned) {
      const li = document.createElement('li');
      li.className = 'bin-row';
      li.dataset.conversationId = row.id;
      const { short: dateShort, full: dateFull } = formatRelativeDateTime(row.lastModifiedAt);
      li.innerHTML = `
        <div class="bin-row-info">
          <span class="bin-row-name"></span>
          <span class="bin-row-date"></span>
        </div>
        <div class="bin-row-actions">
          <button class="bin-action bin-restore" type="button">Restore</button>
          <button class="bin-action bin-delete" type="button">Delete</button>
        </div>
      `;
      const nameEl = li.querySelector('.bin-row-name');
      const dateEl = /** @type {HTMLElement|null} */ (li.querySelector('.bin-row-date'));
      if (nameEl) nameEl.textContent = row.name || UNTITLED_BASE;
      if (dateEl) {
        dateEl.textContent = dateShort;
        dateEl.title = dateFull;
      }
      const restoreBtn = /** @type {HTMLButtonElement} */ (li.querySelector('.bin-restore'));
      const deleteBtn = /** @type {HTMLButtonElement} */ (li.querySelector('.bin-delete'));
      restoreBtn.addEventListener('click', () => this._onRestore(row));
      deleteBtn.addEventListener('click', () => this._onDelete(row));
      list.appendChild(li);
    }
  }

  /**
   * @param {BinnedConvRow} row
   * @private
   */
  async _onRestore(row) {
    if (!this._session) return;
    try {
      await this._session.bin.restore(row.id);
    } catch (e) {
      console.error('[BinModal] restore failed:', e);
      await showAlert(
        `Couldn’t restore: ${/** @type {any} */ (e)?.message || e}`,
        'Restore failed'
      );
    }
    await this._refreshList();
  }

  /**
   * @param {BinnedConvRow} row
   * @private
   */
  async _onDelete(row) {
    if (!this._session) return;
    const confirmed = await showConfirm(
      `Permanently delete "${row.name || UNTITLED_BASE}"?\n\nThis cannot be undone.`,
      'Delete Conversation',
      { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;
    try {
      await this._session.bin.deletePermanently(row.id);
    } catch (e) {
      console.error('[BinModal] delete failed:', e);
      await showAlert(
        `Couldn’t delete: ${/** @type {any} */ (e)?.message || e}`,
        'Delete failed'
      );
    }
    await this._refreshList();
  }

  /**
   * Ids of the binned conversations last active more than `days` days ago —
   * exactly what an "Older than N days" empty would remove, computed from the
   * rows already on screen so the menu costs no extra request.
   * @param {number} days
   * @returns {string[]} matching conversation ids
   * @private
   */
  _idsOlderThan(days) {
    const cutoff = Date.now() - days * DAY_MS;
    return this._binned
      .filter((row) => {
        const t = Date.parse(row.lastModifiedAt);
        return Number.isFinite(t) && t < cutoff;
      })
      .map((row) => row.id);
  }

  /** @private */
  _toggleEmptyMenu() {
    if (this._emptyMenu) this._closeEmptyMenu();
    else this._openEmptyMenu();
  }

  /**
   * Open the age-scoped empty menu under the header button. Built detached —
   * presentPopup owns appending, placement (anchored dropdown or phone sheet)
   * and dismissal (Escape, outside-click, mutual exclusion).
   * @private
   */
  _openEmptyMenu() {
    const button = /** @type {HTMLButtonElement|null} */ (this.querySelector('.bin-empty-now'));
    if (this._emptyMenu || !button || button.disabled) return;

    const menu = document.createElement('nav');
    menu.className = 'dropdown-menu bin-empty-menu show';
    menu.setAttribute('role', 'menu');
    this._emptyMenu = menu;
    this._renderEmptyMenu();
    button.setAttribute('aria-expanded', 'true');

    this._emptyMenuRelease = presentPopup({
      surface: menu,
      anchor: button,
      id: EMPTY_MENU_POPUP_ID,
      onClose: () => this._closeEmptyMenu(),
      // The button sits at the right end of the header, so pin the right edges.
      align: 'right',
      gap: 6,
      insideSelectors: ['.bin-empty-menu', '.bin-empty-now'],
    });
  }

  /** @private */
  _closeEmptyMenu() {
    if (this._emptyMenuRelease) {
      this._emptyMenuRelease();
      this._emptyMenuRelease = null;
    }
    this._emptyMenu = null;
    const button = this.querySelector('.bin-empty-now');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  /**
   * Fill the open menu with one row per cutoff plus "Everything". A cutoff that
   * matches nothing is greyed out rather than relabelled: the row keeps saying
   * what it does, and whether it currently has anything to do is a matter of
   * enablement.
   * @private
   */
  _renderEmptyMenu() {
    if (!this._emptyMenu) return;
    const list = document.createElement('menu');

    for (const days of EMPTY_CUTOFF_DAYS) {
      const matches = this._idsOlderThan(days).length;
      const row = document.createElement('li');
      row.className = matches > 0 ? 'menu-item' : 'menu-item unavailable';
      row.setAttribute('role', 'menuitem');
      row.textContent = `Older than ${days} days`;
      if (matches > 0) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeEmptyMenu();
          this._emptyBin(days);
        });
      }
      list.appendChild(row);
    }

    const divider = document.createElement('li');
    divider.className = 'menu-divider';
    list.appendChild(divider);

    const everything = document.createElement('li');
    everything.className = 'menu-item danger';
    everything.setAttribute('role', 'menuitem');
    everything.textContent = 'Everything';
    everything.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeEmptyMenu();
      this._emptyBin(null);
    });
    list.appendChild(everything);

    this._emptyMenu.replaceChildren(list);
  }

  /**
   * Empty the bin — all of it, or only the conversations last active before a
   * cutoff — after a single confirmation.
   * @param {number|null} olderThanDays - Day cutoff, or null for the whole bin.
   * @private
   */
  async _emptyBin(olderThanDays) {
    if (!this._session) return;

    const doomed = olderThanDays ? this._idsOlderThan(olderThanDays) : null;
    if (doomed && doomed.length === 0) return;
    const confirmed = await showConfirm(
      doomed
        ? `Permanently delete ${doomed.length} conversation${doomed.length === 1 ? '' : 's'} last active over ${olderThanDays} days ago?\n\nThis cannot be undone.`
        : 'Permanently delete every conversation in the bin?\n\nThis cannot be undone.',
      'Empty Bin',
      { confirmText: doomed ? 'Delete' : 'Empty Bin', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;

    // Optimistically show the result right away. The server returns as soon as
    // it has moved the doomed folders aside (the actual OS-trash runs in the
    // background), so the request resolves quickly and the user never stares at
    // an untouched list. _refreshList below reconciles with the real state —
    // restoring the list if the request failed.
    const emptyBtn = /** @type {HTMLButtonElement|null} */ (this.querySelector('.bin-empty-now'));
    const list = /** @type {HTMLUListElement|null} */ (this.querySelector('.bin-list'));
    const empty = /** @type {HTMLElement|null} */ (this.querySelector('.bin-empty'));
    if (emptyBtn) {
      emptyBtn.disabled = true;
      emptyBtn.textContent = 'Emptying…';
    }
    if (doomed) {
      for (const id of doomed) {
        list?.querySelector(`.bin-row[data-conversation-id="${CSS.escape(id)}"]`)?.remove();
      }
    } else if (list) {
      list.innerHTML = '';
    }
    if (empty && !list?.children.length) {
      empty.classList.remove('hidden');
      empty.textContent = 'The bin is empty.';
    }

    try {
      await this._session.bin.empty(olderThanDays);
    } catch (e) {
      console.error('[BinModal] empty bin failed:', e);
      await showAlert(
        `Couldn’t empty the bin: ${/** @type {any} */ (e)?.message || e}`,
        'Empty Bin failed'
      );
    }
    await this._refreshList();
  }
}

customElements.define('bin-modal', BinModal);

export default BinModal;
