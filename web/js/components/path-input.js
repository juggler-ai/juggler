//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <path-input> — a text input with filesystem path autocomplete.
 *
 * Shows a completion dropdown (reusing .dropdown-menu.completions-menu styles)
 * as the user types. Directories drill in on selection; files accept.
 *
 * Attributes:
 *   placeholder  — forwarded to the inner <input>
 *   dirs-only    — if present, only directory completions are shown
 *   project-relative — complete within the project, and answer in paths
 *                  relative to it, rather than anywhere on the machine
 *   value        — initial value (also readable/writable as a property)
 *
 * Events:
 *   path-change  — fired whenever the input value changes
 *                  detail: { value: string }
 *   input        — as any text control raises it: on typing (the inner field's
 *                  own event, bubbling out) and on a path taken from the menu
 */

import JugglerElement from './juggler-element.js';
import { fetchPathCompletions, fetchFileCompletions } from '../services/completions-api.js';
import { applyListboxRoles, linkListbox, setActiveOption } from '../utils/listbox-roles.js';
import { presentPopup } from '../utils/popup-surface.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * Matching quote pairs that can wrap a copied path. macOS Finder's "Copy as
 * Pathname" and a number of apps wrap a filename in quotes when it is pasted as
 * text; both straight and curly (smart-quote) variants show up depending on the
 * source app.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'], // “ ”
  ['\u2018', '\u2019'], // ‘ ’
];

/**
 * Strip a single matching pair of surrounding quotes (straight or curly, single
 * or double), along with surrounding whitespace, from a pasted path. Quotes in
 * the interior are left untouched, and unquoted text is only whitespace-trimmed.
 * @param {string} text - Raw pasted text
 * @returns {string} The path with any wrapping quotes removed
 */
export function stripSurroundingQuotes(text) {
  const trimmed = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmed.length >= open.length + close.length
        && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

class PathInput extends JugglerElement {
  constructor() {
    super();
    /** @type {HTMLInputElement|null} @private */
    this._input = null;
    /** @type {HTMLUListElement|null} @private */
    this._menu = null;
    /** @type {string[]} @private */
    this._items = [];
    /** @type {number} @private */
    this._index = -1;
    /** @type {ReturnType<typeof setTimeout>|null} @private */
    this._debounce = null;
    /**
     * Tears down the presented menu.
     * @type {(() => void)|null} @private
     */
    this._release = null;
    /**
     * Bumped by every close. A completion fetch notes it before awaiting and
     * opens nothing if it moved: the menu is presented on <body> as a popup,
     * and one opened for a field already closed or gone would never be closed.
     * @type {number} @private
     */
    this._closes = 0;
    /**
     * True when the field was seeded with an initial `value` (a programmatic
     * prefill, e.g. the current project path) that the user has not yet edited.
     * While set, focusing the field must NOT auto-open completions — that popup
     * should only appear once the user actually types. Cleared on the first real
     * user input.
     * @type {boolean} @private
     */
    this._pristinePrefill = false;
  }

  connectedCallback() {
    // The inner field is built once, on the first connect: a move (the
    // permissions popup re-parents its rows) keeps what was typed in it.
    if (!this._input) this._build();
    this.on(this, 'keydown', (e) => this._onKeydown(/** @type {KeyboardEvent} */ (e)), { capture: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._closeMenu();
  }

  /**
   * Write the inner field, seeded from the attributes, and wire it. Its own
   * listeners go with it, so they need no removing.
   * @private
   */
  _build() {
    const placeholder = this.getAttribute('placeholder') || '';
    const initial = this.getAttribute('value') || '';

    this.innerHTML = `<input class="path-input-field field-input field-input-sm" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
    this._input = /** @type {HTMLInputElement} */ (this.querySelector('.path-input-field'));
    this._input.placeholder = placeholder;
    this._input.value = initial;
    this._pristinePrefill = initial.length > 0;

    this._input.addEventListener('input', () => this._onInput());
    this._input.addEventListener('paste', (e) => this._onPaste(e));
    this._input.addEventListener('blur', () => {
      // Small delay so mousedown on a menu item fires first. Cleared by a
      // disconnect, which closes the menu itself.
      this.setTimeout(() => this._closeMenu(), 150);
    });
    this._input.addEventListener('focus', () => {
      // Don't auto-open completions when focusing a field that only holds an
      // untouched programmatic prefill — that dropdown is for user typing.
      if (this._pristinePrefill) return;
      this._onInput();
    });
  }

  /**
   * Before the element is in the document there is no inner field yet, so the
   * value lives on the attribute `connectedCallback` reads — which is what makes
   * a form that fills itself in while it is still detached work.
   * @returns {string} Current path value
   */
  get value() {
    return this._input ? this._input.value : (this.getAttribute('value') || '');
  }

  /** @param {string} v */
  set value(v) {
    if (this._input) this._input.value = v;
    else this.setAttribute('value', v);
    // Any explicit value change supersedes the initial-prefill suppression.
    this._pristinePrefill = false;
  }

  /** @returns {void} */
  focus() {
    this._input?.focus();
  }

  /**
   * Intercept paste so a path copied from Finder (or anywhere) that arrives
   * wrapped in quotes lands in the field unquoted. Only the pasted fragment is
   * dequoted, and only when it actually changes — otherwise the browser's
   * default paste runs untouched and we just refresh completions afterwards.
   * @param {ClipboardEvent} e
   * @private
   */
  _onPaste(e) {
    if (!this._input || !e.clipboardData) {
      setTimeout(() => this._onInput(), 0);
      return;
    }
    const raw = e.clipboardData.getData('text');
    const cleaned = stripSurroundingQuotes(raw);
    if (cleaned === raw) {
      setTimeout(() => this._onInput(), 0);
      return;
    }
    e.preventDefault();
    const input = this._input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(cleaned, start, end, 'end');
    this._onInput();
  }

  /** @private */
  _onInput() {
    // Real user input: the prefill is now "touched", so completions behave
    // normally from here on (including on subsequent focus).
    this._pristinePrefill = false;
    this._emitChange();
    const val = this._input?.value || '';
    if (this._debounce !== null) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this._fetch(val), 80);
  }

  /**
   * @param {string} query
   * @private
   */
  async _fetch(query) {
    const closes = this._closes;
    const dirsOnly = this.hasAttribute('dirs-only');
    // "Somewhere on this machine" and "somewhere in this project" are different
    // questions with different answers: the first completes anywhere and answers
    // with absolute paths, the second stays in the project and answers relative
    // to it, which is the form a project-relative field stores and shows.
    let results = this.hasAttribute('project-relative')
      ? await fetchFileCompletions(query)
      : await fetchPathCompletions(query);
    if (results === null) return; // aborted — a newer fetch is already in flight
    if (dirsOnly) {
      results = results.filter((p) => p.endsWith('/'));
    }
    if (!this._input || !this.isConnected || closes !== this._closes) return;
    this._openMenu(results);
  }

  /**
   * @param {string[]} items
   * @private
   */
  _openMenu(items) {
    const refreshing = this._menu !== null;
    this._closeMenuDOM();
    if (items.length === 0) return;

    this._items = items;
    this._index = -1;

    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu completions-menu path-input-menu is-open';
    // A re-filter replaces the open menu: it skips the entrance, or the menu
    // would pop again on every keystroke.
    if (refreshing) menu.classList.add('completions-menu--refresh');

    for (let i = 0; i < items.length; i++) {
      const path = /** @type {string} */ (items[i]); // bounded by i < items.length
      const li = document.createElement('li');
      li.className = 'menu-item' + (path.endsWith('/') ? ' dir' : '');
      li.dataset.index = String(i);

      const icon = document.createElement('span');
      icon.className = path.endsWith('/') ? 'menu-item-icon icon-folder' : 'menu-item-icon icon-file';
      li.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'menu-item-path';
      label.textContent = path;
      li.appendChild(label);

      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this._accept(path);
      });
      li.addEventListener('pointerover', () => this._highlight(i));

      menu.appendChild(li);
    }
    // A list the field drives, not a menu: focus stays in the field, and the
    // highlighted row is announced through it (see _highlight).
    applyListboxRoles(menu, t('Path suggestions'));
    if (this._input) linkListbox(this._input, menu);

    this._menu = menu;
    if (!this._input) {
      document.body.appendChild(menu);
      return;
    }

    // Presented on <body>, so the menu escapes every ancestor `overflow`
    // clipping context (the permissions popup wraps the field in scrolling
    // boxes), and followed as those boxes scroll. It never takes focus: the
    // field keeps it and drives the list. Nested, because the field usually
    // sits inside a popup of its own (the project picker), which must stay
    // open. No focus is restored on close: the menu closes when the field is
    // left, and refocusing the field would reopen it.
    menu.style.setProperty('--path-input-width', `${Math.round(this._input.getBoundingClientRect().width)}px`);
    this._release = presentPopup({
      surface: menu,
      anchor: this._input,
      id: 'path-input',
      onClose: () => this._closeMenu(),
      gap: 4,
      modal: false,
      nested: true,
      restoreFocus: false,
      followAnchor: true,
    });
  }

  /**
   * Remove the dropdown from the DOM without touching the debounce timer.
   * @private */
  _closeMenuDOM() {
    const release = this._release;
    this._release = null;
    if (release) release();
    if (this._menu) {
      this._menu.remove();
      this._menu = null;
    }
    if (this._input) linkListbox(this._input, null);
    this._items = [];
    this._index = -1;
  }

  /**
   * Close the dropdown and cancel any pending fetch debounce.
   * @private */
  _closeMenu() {
    this._closes++;
    if (this._debounce !== null) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
    this._closeMenuDOM();
  }

  /**
   * @param {number} idx
   * @private
   */
  _highlight(idx) {
    if (!this._menu) return;
    if (this._input) setActiveOption(this._input, this._menu, idx);
    this._index = idx;
  }

  /**
   * @param {string} path
   * @private
   */
  _accept(path) {
    if (!this._input) return;
    if (this._debounce !== null) { clearTimeout(this._debounce); this._debounce = null; }
    this._input.value = path;
    this._emitChange();
    // A path taken from the menu is a path the user entered, so the control
    // raises `input` for it as it does for a keystroke — typing raises it by
    // itself, on the inner field's way out, while an assigned value raises
    // nothing at all. Without this, a form watching the events a field raises
    // for itself hears about every half-typed prefix and never about the one
    // value it can be sure of. Raised on the element rather than the field, so
    // the handler that opens the menu does not run again behind it.
    this.dispatchEvent(new Event('input', { bubbles: true }));
    if (path.endsWith('/')) {
      // Directory: drill in immediately.
      this._fetch(path);
    } else {
      this._closeMenu();
    }
  }

  /**
   * @param {KeyboardEvent} e
   * @private
   */
  _onKeydown(e) {
    if (!this._menu) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._highlight(Math.min(this._index + 1, this._items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._highlight(Math.max(this._index - 1, 0));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (this._index >= 0 && this._index < this._items.length) {
        e.preventDefault();
        this._accept(/** @type {string} */ (this._items[this._index]));
      } else if (e.key === 'Tab' && this._items.length === 1) {
        e.preventDefault();
        this._accept(/** @type {string} */ (this._items[0])); // bounded: length === 1 checked above
      } else {
        this._closeMenu();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._closeMenu();
    }
  }

  /** @private */
  _emitChange() {
    this.dispatchEvent(new CustomEvent('path-change', {
      bubbles: true,
      detail: { value: this._input?.value || '' }
    }));
  }
}

customElements.define('path-input', PathInput);
export default PathInput;
