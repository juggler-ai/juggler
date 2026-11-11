//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup } from '../utils/popup-surface.js';
import { caretViewportRect } from '../utils/textarea-caret.js';
import { applyListboxRoles, linkListbox, setActiveOption } from '../utils/listbox-roles.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * Returns the longest string that is a prefix of every element in strs.
 * @param {string[]} strs
 * @returns {string} Longest common prefix, or "" if none
 */
export function longestCommonPrefix(strs) {
  if (strs.length === 0) return '';
  let prefix = /** @type {string} */ (strs[0]); // bounded: length > 0 checked above
  for (let i = 1; i < strs.length; i++) {
    while (!(/** @type {string} */ (strs[i])).startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

/**
 * A completion provider describes ONE completion source (e.g. `@` file
 * mentions, `/` slash commands). The generic {@link CompletionMenu} owns the
 * popup, keyboard navigation and async fetch; the provider owns everything
 * source-specific behind this interface. Items are opaque to the menu — only
 * the provider's own methods interpret them.
 * @typedef {object} CompletionProvider
 * @property {string} id - Stable identifier (used by the test driver).
 * @property {(textBefore: string) => ({anchorPos: number, query: string, meta?: any}|null)} detect
 *   Given the text from start-of-textarea to the caret, decide whether a
 *   trigger is active. Return the anchor index (where the replacement begins),
 *   the current query string, and optional opaque `meta` passed back to the
 *   other methods; or null when this provider does not apply.
 * @property {(query: string, meta: any) => Promise<any[]>} fetch - Resolve the
 *   candidate items for a query. Items are opaque to the menu.
 * @property {(item: any) => HTMLLIElement} renderItem - Build the row element
 *   for one item. The menu adds the `menu-item` class and pointer wiring.
 * @property {(item: any, meta: any) => string} insert - The text that replaces
 *   the span from `anchorPos` to the caret when `item` is accepted.
 * @property {string} [emptyLabel] - Row text when there are no matches, as English
 *   source (`markForTranslation`); translated where the row is drawn.
 * @property {(item: any) => boolean} [reopenAfterAccept] - Re-run detection
 *   after accepting (e.g. stepping into a directory).
 * @property {(item: any) => boolean} [expandForward] - Whether ArrowRight on a
 *   highlighted item accepts it (e.g. entering a directory).
 * @property {(meta: any, query: string) => boolean} [closeOnBareEnter] - Whether
 *   Enter with nothing highlighted should just dismiss the menu (keeping the
 *   typed text) rather than fall through to the send handler.
 * @property {(item: any, meta: any) => boolean} [submitAfterAccept] - Whether
 *   accepting `item` should immediately submit the composer (via the menu's
 *   `onSubmit`) instead of leaving the spliced text for the user to extend. Use
 *   for a runnable-as-is completion (e.g. an argument-less slash command) so it
 *   fires on a single Enter rather than accept-then-send.
 * @property {(items: any[], query: string, meta: any) => (string|null)} [tabCompleteReplacement]
 *   Replacement text for a Tab press with no single match (longest common
 *   prefix completion), or null when Tab should do nothing.
 * @property {(query: string, meta: any) => (string|null)} [navigateParent] -
 *   Replacement text for ArrowLeft on a highlighted item (step to parent), or
 *   null when there is nowhere to go.
 */

/**
 * A caret-anchored completion dropdown for a textarea, shared by every
 * completion source. It owns the menu DOM, popup presentation, keyboard
 * navigation, highlight, and the debounced async fetch (with a generation
 * guard so a stale response can't overwrite a newer one). All source-specific
 * behaviour lives in the {@link CompletionProvider}s passed in; on each input
 * the first provider whose `detect` matches becomes active until close.
 */
export class CompletionMenu {
  /**
   * @param {object} opts
   * @param {HTMLTextAreaElement} opts.textarea
   * @param {() => HTMLElement|null} opts.getWrapper - returns the wrapper element for dropdown positioning
   * @param {() => void} opts.onResize - called after text is spliced into the textarea
   * @param {() => void} [opts.onSubmit] - called when an accepted item asks to
   *   submit immediately (provider's `submitAfterAccept`), e.g. an argument-less
   *   slash command that should run on a single Enter rather than accept-then-send.
   * @param {CompletionProvider[]} opts.providers - completion sources, tried in order
   */
  constructor({ textarea, getWrapper, onResize, onSubmit, providers }) {
    /** @private */ this._textarea = textarea;
    /** @private */ this._getWrapper = getWrapper;
    /** @private */ this._onResize = onResize;
    /** @type {(() => void)|undefined} @private */ this._onSubmit = onSubmit;
    /** @type {CompletionProvider[]} @private */ this._providers = providers;

    /** @type {CompletionProvider|null} @private */ this._provider = null;
    /** @type {HTMLElement|null} @private */ this._menu = null;
    /** @type {HTMLElement|null} @private */ this._caretAnchor = null;
    /** @type {boolean} @private */          this._active = false;
    /** @type {number} @private */            this._anchorPos = -1;
    /** @type {number} @private */            this._index = -1;
    /** @type {any[]} @private */             this._items = [];
    /** @type {string} @private */            this._query = '';
    /** @type {any} @private */               this._ctx = {};
    /** @type {Function|null} @private */     this._popupCleanup = null;
    /** @type {number|null} @private */       this._debounceId = null;
    /** @type {number} @private */            this._gen = 0;

    // A <textarea> cannot be a combobox; it can say it offers a list.
    textarea.setAttribute('aria-autocomplete', 'list');
  }

  /** @returns {boolean} Whether the completion menu is open */
  isActive() { return this._active; }

  /** @returns {boolean} Whether an item is highlighted */
  hasSelection() { return this._index >= 0; }

  /**
   * Detect whether the caret sits inside a trigger and show completions. Call
   * on every input/paste event. The first provider whose `detect` matches wins
   * and stays active for this session; if none match, the menu closes.
   */
  handleInput() {
    const cursor = this._textarea.selectionStart;
    const textBefore = this._textarea.value.substring(0, cursor);

    for (const provider of this._providers) {
      const hit = provider.detect(textBefore);
      if (hit) {
        this._provider = provider;
        this._anchorPos = hit.anchorPos;
        this._ctx = hit.meta ?? {};
        this._refresh(hit.query);
        return;
      }
    }

    this.close();
  }

  /**
   * Handle a keydown while the menu drives navigation. Returns true when the
   * menu consumed the event (the caller must then stop its own handling).
   * @param {KeyboardEvent} e
   * @returns {boolean} Whether the event was consumed.
   */
  handleKeydown(e) {
    if (!this._active || !this._provider) return false;
    const provider = this._provider;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        return true;
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        return true;
      case 'ArrowLeft':
        if (this.hasSelection() && provider.navigateParent) {
          e.preventDefault();
          this._navigateParent();
          return true;
        }
        return false;
      case 'ArrowRight':
        if (this.hasSelection() && provider.expandForward?.(this._items[this._index])) {
          e.preventDefault();
          this.accept();
          return true;
        }
        return false;
      case 'Enter':
        if (this.hasSelection()) {
          e.preventDefault();
          this.accept();
          return true;
        }
        if (provider.closeOnBareEnter?.(this._ctx, this._query)) {
          e.preventDefault();
          this.close();
          return true;
        }
        return false;
      case 'Tab':
        e.preventDefault();
        if (this.hasSelection()) {
          this.accept({ allowSubmit: false });
        } else {
          this.tabComplete();
        }
        return true;
      case 'Escape':
        e.preventDefault();
        this.close();
        return true;
      default:
        return false;
    }
  }

  /** @param {number} delta */
  move(delta) {
    const count = this._items.length;
    if (count === 0) return;
    this._index = (this._index + delta + count) % count;
    this._highlight();
  }

  /**
   * Accept the highlighted item: splice the provider's replacement text over
   * the span from the anchor to the caret, then close. If the provider marks the
   * item `submitAfterAccept` (e.g. an argument-less slash command) the composer
   * is submitted on this same keystroke; otherwise the provider may ask to
   * re-open (e.g. after stepping into a directory).
   * @param {object} [opts]
   * @param {boolean} [opts.allowSubmit] - Set false to splice the text and stop
   *   there, whatever `submitAfterAccept` says. Tab completes only: it fills in
   *   the text and leaves sending to the user's Enter.
   */
  accept({ allowSubmit = true } = {}) {
    const item = this._items[this._index];
    if (item === undefined || !this._provider) return;

    const textarea = this._textarea;
    const value = textarea.value;
    const anchorPos = this._anchorPos;
    const cursor = textarea.selectionStart;

    const replacement = this._provider.insert(item, this._ctx);
    textarea.value = value.substring(0, anchorPos) + replacement + value.substring(cursor);
    textarea.selectionStart = textarea.selectionEnd = anchorPos + replacement.length;
    this._onResize();

    // A runnable-as-is item (e.g. an argument-less slash command) submits on the
    // same Enter that accepted it — one keystroke, not accept-then-send. Checked
    // before reopen since submitting ends the interaction.
    const submit = allowSubmit && (this._provider.submitAfterAccept?.(item, this._ctx) ?? false);
    const reopen = !submit && (this._provider.reopenAfterAccept?.(item) ?? false);
    this.close();
    textarea.focus();

    if (submit) this._onSubmit?.();
    else if (reopen) this.handleInput();
  }

  /**
   * Tab: accept the sole match, or extend the query to the longest common
   * prefix of the matches (then re-detect from the updated textarea). Tab never
   * submits — it completes and hands the caret back.
   */
  tabComplete() {
    if (this._items.length === 0 || !this._provider) return;

    if (this._items.length === 1) {
      this._index = 0;
      this.accept({ allowSubmit: false });
      return;
    }

    const replacement = this._provider.tabCompleteReplacement?.(this._items, this._query, this._ctx);
    if (!replacement) return;
    this._spliceAndRedetect(replacement);
  }

  close() {
    this._gen++;
    if (this._debounceId !== null) {
      clearTimeout(this._debounceId);
      this._debounceId = null;
    }
    // Release tears down the surface, observer and dismissal wiring.
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    if (this._caretAnchor) {
      this._caretAnchor.remove();
      this._caretAnchor = null;
    }
    linkListbox(this._textarea, null);
    this._menu = null;
    this._provider = null;
    this._active = false;
    this._index = -1;
    this._items = [];
    this._anchorPos = -1;
  }

  /** @private */
  _navigateParent() {
    if (!this._provider?.navigateParent) return;
    const replacement = this._provider.navigateParent(this._query, this._ctx);
    if (!replacement) return;
    this._spliceAndRedetect(replacement);
  }

  /**
   * Replace the span from the anchor to the caret with `replacement`, then
   * re-run detection so the menu re-fetches for the updated token.
   * @param {string} replacement
   * @private
   */
  _spliceAndRedetect(replacement) {
    const textarea = this._textarea;
    const value = textarea.value;
    textarea.value = value.substring(0, this._anchorPos) + replacement + value.substring(textarea.selectionStart);
    textarea.selectionStart = textarea.selectionEnd = this._anchorPos + replacement.length;
    this.handleInput();
  }

  /**
   * @param {string} query
   * @private
   */
  _refresh(query) {
    this._query = query;
    const provider = /** @type {CompletionProvider} */ (this._provider);
    const gen = ++this._gen;
    if (this._debounceId !== null) {
      clearTimeout(this._debounceId);
    }
    this._debounceId = setTimeout(async () => {
      this._debounceId = null;
      const results = await provider.fetch(query, this._ctx);
      if (this._gen !== gen) return;
      this._open(results);
    }, 80);
  }

  /**
   * @param {any[]} results
   * @private
   */
  _open(results) {
    const provider = /** @type {CompletionProvider} */ (this._provider);
    this._items = results;
    this._index = -1;

    // Tear down any previous menu before building the next (this fires on every
    // keystroke that re-filters while the menu is already open).
    const refreshing = this._popupCleanup !== null;
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }

    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu completions-menu';
    // A re-filter is the same menu changing, not a new one opening: it skips
    // the entrance, or the menu would pop again on every keystroke.
    if (refreshing) menu.classList.add('completions-menu--refresh');

    if (results.length === 0) {
      const li = document.createElement('li');
      li.className = 'menu-item menu-item-empty';
      li.textContent = provider.emptyLabel ? t(provider.emptyLabel) : t('No matches');
      menu.appendChild(li);
    }

    results.forEach((item, i) => {
      const li = provider.renderItem(item);
      li.classList.add('menu-item');
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this._index = i;
        this.accept();
      });
      li.addEventListener('pointerover', () => {
        this._index = i;
        this._highlight();
      });
      menu.appendChild(li);
    });

    // A list the textarea drives, not a menu: focus stays in the textarea, and
    // the highlighted row is announced through it (see _highlight).
    applyListboxRoles(menu, t('Suggestions'));
    linkListbox(this._textarea, menu);
    setActiveOption(this._textarea, menu, -1);

    menu.classList.add('is-open');
    this._menu = menu;
    this._active = true;

    const wrapper = this._getWrapper();
    if (!wrapper) {
      // No anchor to position against; degrade gracefully without dismissal
      // wiring (the textarea handlers still drive accept/close).
      document.body.appendChild(menu);
      return;
    }

    // Non-modal: presentPopup docks this to the caret anchor (or to the bottom
    // as a scrim-less sheet on a phone) WITHOUT stealing focus from the
    // textarea, whose typing drives the completion. No outside-click selectors
    // — the textarea's own keydown/blur handlers own accept/close. Marking a
    // popup open for the duration still lets Escape dismiss the menu rather
    // than cancel a running turn.
    this._popupCleanup = presentPopup({
      surface: menu,
      anchor: this._caretAnchorEl(wrapper),
      id: 'input-completions',
      onClose: () => this.close(),
      align: 'left',
      gap: 8,
      modal: false,
    });
  }

  /**
   * A zero-width anchor pinned horizontally to the trigger char the user is
   * typing over, while spanning the wrapper vertically so the menu still opens
   * above/below the whole composer. Without this the dropdown anchors to the
   * wrapper's left edge and always sits in the top-left corner, far from the
   * caret.
   *
   * The element is reused across keystrokes (each re-fires `_open`) and removed
   * in {@link close}. On a phone the popup presents as a bottom sheet and
   * ignores the anchor, so the off-screen geometry there is harmless.
   * @param {HTMLElement} wrapper
   * @returns {HTMLElement} The caret-pinned anchor element.
   * @private
   */
  _caretAnchorEl(wrapper) {
    const caret = caretViewportRect(this._textarea, this._anchorPos);
    const wrapRect = wrapper.getBoundingClientRect();

    if (!this._caretAnchor) {
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.width = '0';
      el.style.pointerEvents = 'none';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
      this._caretAnchor = el;
    }
    this._caretAnchor.style.left = `${caret.left}px`;
    this._caretAnchor.style.top = `${wrapRect.top}px`;
    this._caretAnchor.style.height = `${wrapRect.height}px`;
    return this._caretAnchor;
  }

  /** @private */
  _highlight() {
    if (!this._menu) return;
    const items = this._menu.querySelectorAll('.menu-item');
    setActiveOption(this._textarea, this._menu, this._index);
    const item = items[this._index];
    if (this._index >= 0 && item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }
}
