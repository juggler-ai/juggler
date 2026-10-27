//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import FindController from '../services/find-controller.js';
import { isMac, formatBindingLabel } from '../services/key-shortcut-manager.js';
import { EXPAND_LESS_SVG, EXPAND_MORE_SVG } from '../utils/icons.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { debounce } from '../../sdk/lib/debounce.js';

/**
 * The presentational find (⌘F) bar. A panel-mounted singleton (module-level
 * instance + default export, in the same shape as `disconnection-overlay.js`)
 * that owns exactly one {@link FindController} and drives it — it never touches
 * highlighting itself.
 *
 * The bar knows nothing about the panel it is searching. A find-capable panel
 * implements `getFindTarget()` and answers with a {@link FindTarget} naming its
 * scroller, the positioned box to float the bar in, and where focus goes when
 * the bar closes; the bar asks for that descriptor afresh every time it needs
 * one, which is what lets it follow a panel that rebuilds its scroller under it
 * (the properties panel does exactly that on every render).
 *
 * It handles its OWN keydown (Enter / Shift+Enter / Escape / ⌘G / ⌘⇧G) directly
 * on its input — deliberately NOT via the global shortcut manager — and keeps
 * matches live during streaming with a debounced `MutationObserver`.
 * @module components/find-bar
 */

/** Debounce for the query input before running a search. */
const SEARCH_DEBOUNCE_MS = 120;
/** Debounce for the streaming MutationObserver before refreshing matches. */
const OBSERVER_DEBOUNCE_MS = 150;
/**
 * The longest a stream of mutations may hold that refresh off. A streaming turn
 * changes the panel faster than the debounce for as long as it streams, and the
 * counter should follow the new text, a second behind, rather than freeze.
 */
const OBSERVER_MAX_WAIT_MS = 1000;

/**
 * What a find-capable panel says about itself when the bar asks for somewhere to
 * search. Returned by the panel's `getFindTarget()`, or null when it currently
 * holds nothing worth searching (an empty properties panel, a board with no pin)
 * — in which case ⌘F falls through to the browser's own find.
 * @typedef {object} FindTarget
 * @property {Element} root - The panel's scrolling element. Both the search root
 *   and the box the controller scrolls to reveal a match, so it must be the one
 *   that actually scrolls.
 * @property {HTMLElement} mount - A positioned box (`position` other than
 *   `static`) to append the bar to. It floats above `root` rather than
 *   scrolling with it, so this is normally `root`'s parent, not `root`.
 * @property {Element} [watch] - A stable ancestor to observe for mutations,
 *   for panels that replace `root` as they re-render. Defaults to `root`.
 * @property {string} label - The query input's `aria-label`, already translated,
 *   e.g. "Find in conversation".
 * @property {() => void} [restoreFocus] - Where focus goes when the bar closes.
 *   Omitted means blur.
 */

/**
 * The nearest ancestor of `el` (itself included) with somewhere to search right
 * now: a panel implementing `getFindTarget()` that answers with a descriptor
 * rather than null. This is how ⌘F finds the panel the user is in — a composer
 * resolves to its own column, a clicked-into properties panel to itself — and
 * an empty panel is stepped over rather than opened on.
 * @param {EventTarget|Element|null} el - Where to start, normally `document.activeElement`.
 * @returns {HTMLElement|null} The panel to search, or null if there is none above `el`.
 */
export function findPanelFor(el) {
  let node = el instanceof Element ? el : null;
  while (node) {
    const get = /** @type {any} */ (node).getFindTarget;
    if (typeof get === 'function' && get.call(node)) return /** @type {HTMLElement} */ (node);
    node = node.parentElement;
  }
  return null;
}

/**
 * Singleton find bar. One instance (exported default) is shared across every
 * panel; `open(panelEl)` re-homes it onto the one being searched, so only one
 * find is ever live and closing it clears every highlight it left.
 */
class FindBar {
  constructor() {
    /** @type {HTMLElement|null} @private - The bar's root element while open. */
    this._element = null;
    /** @type {HTMLInputElement|null} @private - The query input. */
    this._input = null;
    /** @type {HTMLElement|null} @private - The `n of m` live counter. */
    this._counter = null;
    /** @type {HTMLElement|null} @private - The panel currently searched. */
    this._panelEl = null;
    /** @type {FindTarget|null} @private - That panel's descriptor as last resolved. */
    this._target = null;
    /** @type {FindController} @private - The one match engine this bar drives. */
    this._controller = new FindController();
    /** @type {MutationObserver|null} @private - Watches the panel while open. */
    this._observer = null;
    /** @type {number|null} @private - Pending search-debounce timer. */
    this._searchTimer = null;
    /**
     * The observer's coalesced refresh.
     * @private
     */
    this._observerRefresh = debounce(() => this._onPanelMutated(), OBSERVER_DEBOUNCE_MS, { maxWait: OBSERVER_MAX_WAIT_MS });
    /** @type {string} @private - Query retained across opens so ⌘F re-runs the last find. */
    this._query = '';
    /** @type {boolean} @private - Case-sensitive toggle, retained across opens. */
    this._caseSensitive = false;
    /** @type {boolean} @private - Whole-word toggle, retained across opens. */
    this._wholeWord = false;
  }

  /** @returns {boolean} Whether the bar is currently mounted. */
  isOpen() {
    return !!this._element;
  }

  /**
   * Open (or refocus) the bar on `panelEl`. Closed → mount, point the controller
   * at the panel's root, focus + select the input, start the observer, and
   * re-run any retained query. Already open on the SAME panel → just focus +
   * select-all (the "⌘F while open" behavior). Open on a DIFFERENT panel → move
   * the bar, re-point the controller, and re-run.
   * @param {HTMLElement} panelEl - A panel implementing `getFindTarget()`.
   * @returns {void}
   */
  open(panelEl) {
    if (!panelEl) return;

    if (this._element && this._panelEl === panelEl) {
      this._focusInput();
      return;
    }

    const target = this._resolve(panelEl);
    if (!target) return;

    if (this._element) {
      // Move the bar to a different panel without a full teardown.
      this._teardownObserver();
    } else {
      this._build();
    }
    if (!this._element) return;

    this._panelEl = panelEl;
    this._applyTarget(target);
    this._focusInput();
  }

  /**
   * Close the bar: clear the controller (removes highlights), stop the observer,
   * remove the element, and hand focus back to the panel.
   * @returns {void}
   */
  close() {
    if (!this._element) return;

    if (this._searchTimer !== null) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this._teardownObserver();
    this._controller.clear();

    const target = this._target;
    this._element.remove();
    this._element = null;
    this._input = null;
    this._counter = null;
    this._panelEl = null;
    this._target = null;

    this._restoreFocus(target);
  }

  /**
   * Close the bar if it is searching `panelEl` (or anything inside it), and
   * leave it alone otherwise. For a panel that is going away or hiding its
   * content: matches nobody can see must not stay counted.
   * @param {HTMLElement|null} panelEl - The panel closing down.
   * @returns {void}
   */
  closeFor(panelEl) {
    if (!panelEl || !this._panelEl) return;
    if (panelEl === this._panelEl || panelEl.contains(this._panelEl)) this.close();
  }

  /**
   * Open the bar (or refocus if already open on this panel) when closed; close
   * it when open. Suitable as the single ⌘F entry point.
   * @param {HTMLElement} panelEl - A panel implementing `getFindTarget()`.
   * @returns {void}
   */
  toggle(panelEl) {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open(panelEl);
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Ask a panel where to search, rejecting anything unusable: a panel that has
   * left the document, one that doesn't implement the protocol, and one that
   * says it has nothing to search right now.
   * @param {HTMLElement|null} panelEl - The panel to ask.
   * @returns {FindTarget|null} The descriptor, or null when there is nothing to search.
   * @private
   */
  _resolve(panelEl) {
    if (!panelEl || !panelEl.isConnected) return null;
    const get = /** @type {any} */ (panelEl).getFindTarget;
    if (typeof get !== 'function') return null;
    const target = /** @type {FindTarget|null} */ (get.call(panelEl));
    if (!target || !target.root || !target.mount) return null;
    return target;
  }

  /**
   * Point the bar and its controller at a freshly-resolved target: label the
   * input, mount into the target's positioned box, re-root the controller, watch
   * for mutations, and re-run the query.
   * @param {FindTarget} target - The panel's descriptor.
   * @returns {void}
   * @private
   */
  _applyTarget(target) {
    this._target = target;
    if (this._input) this._input.setAttribute('aria-label', target.label || t('Find'));
    if (this._element && this._element.parentElement !== target.mount) {
      target.mount.appendChild(this._element);
    }
    this._controller.setRoot(target.root);
    this._startObserver();
    this._runSearch();
  }

  /**
   * Build the bar element, wire its controls, and cache child references.
   * @returns {void}
   * @private
   */
  _build() {
    const el = document.createElement('div');
    el.className = 'find-bar';
    el.setAttribute('role', 'search');
    const findHtml = escapeHtml(t('Find'));
    const prevHtml = escapeHtml(t('Previous match'));
    const nextHtml = escapeHtml(t('Next match'));
    const matchCaseHtml = escapeHtml(t('Match case'));
    const wholeWordHtml = escapeHtml(t('Match whole word'));
    // The keys are named as every other key hint names them on this platform.
    const mac = isMac();
    const prevKeys = formatBindingLabel({ key: 'Enter', shift: true }, mac);
    const nextKeys = formatBindingLabel({ key: 'Enter' }, mac);
    const closeKey = formatBindingLabel({ key: 'Escape' }, mac);
    el.innerHTML = `
      <input type="text" class="find-bar__input field-input" aria-label="${findHtml}"
        placeholder="${findHtml}" spellcheck="false" autocomplete="off" />
      <span class="find-bar__counter" aria-live="polite"></span>
      <button type="button" class="find-bar__btn find-bar__prev" aria-label="${prevHtml}" title="${escapeHtml(t('Previous match ({keys})', { keys: prevKeys }))}">${EXPAND_LESS_SVG}</button>
      <button type="button" class="find-bar__btn find-bar__next" aria-label="${nextHtml}" title="${escapeHtml(t('Next match ({keys})', { keys: nextKeys }))}">${EXPAND_MORE_SVG}</button>
      <button type="button" class="find-bar__btn find-bar__toggle find-bar__case" aria-label="${matchCaseHtml}" aria-pressed="false" title="${matchCaseHtml}">${escapeHtml(t('Aa', undefined, { context: 'match-case toggle glyph' }))}</button>
      <button type="button" class="find-bar__btn find-bar__toggle find-bar__word" aria-label="${wholeWordHtml}" aria-pressed="false" title="${wholeWordHtml}">${escapeHtml(t('W', undefined, { context: 'whole-word toggle glyph' }))}</button>
      <button type="button" class="find-bar__btn find-bar__close" aria-label="${escapeHtml(t('Close find'))}" title="${escapeHtml(t('Close ({key})', { key: closeKey }))}">&#x2715;</button>
    `;

    const input = /** @type {HTMLInputElement} */ (el.querySelector('.find-bar__input'));
    const counter = /** @type {HTMLElement} */ (el.querySelector('.find-bar__counter'));
    const prevBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__prev'));
    const nextBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__next'));
    const caseBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__case'));
    const wordBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__word'));
    const closeBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__close'));

    input.value = this._query;
    this._reflectToggle(caseBtn, this._caseSensitive);
    this._reflectToggle(wordBtn, this._wholeWord);

    input.addEventListener('input', () => {
      this._query = input.value;
      this._scheduleSearch();
    });
    input.addEventListener('keydown', (e) => this._onKeydown(e));

    prevBtn.addEventListener('click', () => this._updateCounter(this._controller.prev()));
    nextBtn.addEventListener('click', () => this._updateCounter(this._controller.next()));
    caseBtn.addEventListener('click', () => {
      this._caseSensitive = !this._caseSensitive;
      this._reflectToggle(caseBtn, this._caseSensitive);
      this._runSearch();
      this._focusInput(false);
    });
    wordBtn.addEventListener('click', () => {
      this._wholeWord = !this._wholeWord;
      this._reflectToggle(wordBtn, this._wholeWord);
      this._runSearch();
      this._focusInput(false);
    });
    closeBtn.addEventListener('click', () => this.close());

    this._element = el;
    this._input = input;
    this._counter = counter;
  }

  /**
   * Reflect a toggle's pressed state via `aria-pressed` + the `is-active` class.
   * @param {HTMLElement} btn
   * @param {boolean} on
   * @returns {void}
   * @private
   */
  _reflectToggle(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
  }

  /**
   * The bar's own keyboard map (Enter / Shift+Enter / Escape / ⌘G / ⌘⇧G).
   *
   * A handled key is stopped dead — `preventDefault()` so native find/typeahead
   * never doubles up, and `stopPropagation()` so no document-level listener acts
   * on the same press. The Escape matters most: the bar can be floating inside
   * an overlay that holds a popup token (the pinboard does), and
   * `popup-manager`'s document handler dismisses every open popup on Escape, so
   * a key left to bubble would close the whole board along with the bar.
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _onKeydown(e) {
    const cmd = isMac() ? e.metaKey : e.ctrlKey;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this._updateCounter(e.shiftKey ? this._controller.prev() : this._controller.next());
      return;
    }
    if (cmd && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      e.stopPropagation();
      this._updateCounter(e.shiftKey ? this._controller.prev() : this._controller.next());
    }
  }

  /**
   * Debounce a search from the query input.
   * @returns {void}
   * @private
   */
  _scheduleSearch() {
    if (this._searchTimer !== null) clearTimeout(this._searchTimer);
    this._searchTimer = window.setTimeout(() => {
      this._searchTimer = null;
      this._runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Run the current query/options immediately and update the counter. Does NOT
   * auto-scroll — revealing the active match is reserved for Enter/next/prev.
   * @returns {void}
   * @private
   */
  _runSearch() {
    const query = this._input ? this._input.value : this._query;
    this._updateCounter(
      this._controller.search(query, {
        caseSensitive: this._caseSensitive,
        wholeWord: this._wholeWord,
      }),
    );
  }

  /**
   * Render the `{ total, current }` summary into the live counter: empty for an
   * empty query, "No results" for a non-empty query with no matches, else
   * "current of total".
   * @param {{ total: number, current: number }} result
   * @returns {void}
   * @private
   */
  _updateCounter(result) {
    if (!this._counter) return;
    const hasQuery = !!(this._input && this._input.value.trim());
    let text = '';
    let empty = false;
    if (!hasQuery) {
      text = '';
    } else if (result.total === 0) {
      text = t('No results');
      empty = true;
    } else {
      text = t('{current} of {total}', { current: result.current, total: result.total });
    }
    this._counter.textContent = text;
    this._counter.classList.toggle('find-bar__counter--empty', empty);
  }

  /**
   * Start the debounced MutationObserver so streamed/new text is re-matched and
   * the active match preserved. No-op if already observing.
   * @returns {void}
   * @private
   */
  _startObserver() {
    if (this._observer || !this._target) return;
    const target = this._target.watch || this._target.root;
    if (!target) return;
    this._observer = new MutationObserver(() => this._observerRefresh());
    this._observer.observe(target, { subtree: true, childList: true, characterData: true });
  }

  /**
   * Re-count after the panel changed under us. Three outcomes: the panel has
   * nothing left to search (it emptied, or it left the document) → close; it
   * rebuilt its scroller → re-root and re-run the query from scratch, since the
   * old matches point into detached nodes; otherwise the ordinary streaming
   * case → refresh, which preserves the active match by identity.
   * @returns {void}
   * @private
   */
  _onPanelMutated() {
    if (!this._element) return;

    const target = this._resolve(this._panelEl);
    if (!target) {
      this.close();
      return;
    }
    if (target.root !== (this._target && this._target.root)) {
      this._target = target;
      this._controller.setRoot(target.root);
      this._runSearch();
      return;
    }
    this._updateCounter(this._controller.refresh());
  }

  /**
   * Detach the observer and cancel any pending refresh.
   * @returns {void}
   * @private
   */
  _teardownObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._observerRefresh.cancel();
  }

  /**
   * Focus the query input, optionally selecting its text (default: select).
   * @param {boolean} [select=true]
   * @returns {void}
   * @private
   */
  _focusInput(select = true) {
    if (!this._input) return;
    this._input.focus();
    if (select) this._input.select();
  }

  /**
   * Hand focus back on close: to wherever the panel asked for it, else blur so
   * focus doesn't linger on a removed node.
   * @param {FindTarget|null} target - The descriptor the bar was working from.
   * @returns {void}
   * @private
   */
  _restoreFocus(target) {
    if (target && typeof target.restoreFocus === 'function') {
      target.restoreFocus();
      return;
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
}

/** The shared singleton instance. */
const findBar = new FindBar();

export default findBar;
