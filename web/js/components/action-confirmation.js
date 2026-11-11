//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { t, htmlSlots, withHtml, formatList } from '../../sdk/lib/i18n.js';

/**
 * Inline folder glyph prefixed to a folder-grant `<code>` span, so a grant
 * reads as a directory rather than a command pattern. `currentColor` makes it
 * inherit the span's accent colour; sized to sit on the text baseline.
 */
const FOLDER_ICON_SVG = '<svg class="pattern-folder-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z"/></svg>';

/**
 * Pencil glyph for the "edit this pattern" affordance. It sits quietly *inside*
 * the single-pattern "don't ask again" button (a low-opacity span pinned to the
 * right edge), staying out of the way since editing is rarely needed. The
 * delegated click handler recognises a click on the pencil and enters edit mode
 * instead of approving.
 */
const PENCIL_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T846-647L319-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>';

/** Debounce (ms) between a keystroke in the edit input and the revise call. */
const REVISE_DEBOUNCE_MS = 150;

/**
 * @typedef {object} ApprovalOption
 * @property {string} label - Button label
 * @property {string} value - Value returned when selected ('yes', 'yes-always', 'yes-always:N', 'no', 'cancel')
 * @property {string} style - Button style class (primary, primary-always, secondary, danger)
 * @property {string} [pattern] - Single pattern to display for "Don't ask again" options
 * @property {string[]} [patterns] - Multiple patterns to display, each as its own `<code>` span joined by a plain-font "or". Preferred over `pattern` when an option covers more than one pattern.
 * @property {Array<{kind: string, value: any}>} [rules] - Permission rules to persist when this "Don't ask again" option is chosen
 * @property {string[]} [allowedPaths] - Allowed-paths roots to add when this "Don't ask again" option is chosen (alternative to `rules`)
 * @property {string} [itemType] - Owning plugin id the `rules` belong to
 */

/**
 * @typedef {object} ActionConfirmationOptions
 * @property {string} [title] - Approval title (displayed by parent container)
 * @property {string} [message] - Approval message (displayed by parent container)
 * @property {ApprovalOption[]} options - The approval button options
 */

/**
 * ActionConfirmation - Inline approval buttons component
 *
 * Displays approval buttons for action confirmation with:
 * - Keyboard navigation (↑/↓/Enter/Esc)
 * - Pattern display for "Don't ask again" options
 * - "Enter to engage, Escape to disengage" widget mode
 *
 * The action details (diffs, commands, etc.) are displayed separately
 * by the parent container (tool-action-message).
 * @class
 * @augments JugglerElement
 */
class ActionConfirmation extends JugglerElement {
  constructor() {
    super();

    /** @type {ActionConfirmationOptions|null} @private */
    this._options = null;

    /** @type {((value: string) => void)|null} @private */
    this._resolveCallback = null;

    /** @type {number} @private */
    this._focusedIndex = 0;

    /**
     * Optional plugin bridge that re-derives a single-pattern suggestion from
     * the user's edited text. When null (the default) no pencil affordance is
     * rendered and the component behaves exactly as before.
     * @type {((index: number, editedText: string) => (import('juggler/context-item').RevisedApprovalSuggestion | null | Promise<import('juggler/context-item').RevisedApprovalSuggestion | null>))|null}
     * @private
     */
    this._onRevise = null;

    /**
     * Per-option monotonic request tokens: guards against a stale async revise
     * response resolving after a newer edit (last edit wins).
     * @type {Record<number, number>} @private
     */
    this._reviseTokens = {};

    /**
     * Per-option debounce timers for revise requests.
     * @type {Record<number, number>} @private
     */
    this._debounceTimers = {};

    /**
     * Per-option snapshot of the grant as it was when editing began, so Escape
     * can restore the button to exactly its pre-edit state. Keyed by option
     * index; present only while that option is being edited.
     * @type {Record<number, {rules?: any, allowedPaths?: string[], patterns?: string[], pattern?: string}>} @private
     */
    this._editSnapshots = {};

    /**
     * Times this widget has left the DOM; a focusout handler compares it
     * across a microtask to tell a move from a click-away.
     * @type {number} @private
     */
    this._disconnects = 0;
  }

  disconnectedCallback() {
    this._disconnects++;
    super.disconnectedCallback();
  }

  connectedCallback() {
    this.setAttribute('tabindex', '-1');
    // setOptions draws the buttons, so a connect only draws ones that never
    // were: a move keeps an edit in progress, its typed pattern and its focus
    // ring.
    if (!this.firstElementChild) this.render();
    this.on(this, 'click', (e) => this._handleButtonClick(/** @type {MouseEvent} */ (e)));
    this.on(this, 'keydown', (e) => this._handleKeyDown(/** @type {KeyboardEvent} */ (e)));
    this.on(this, 'focusout', (e) => this._handleFocusOut(/** @type {FocusEvent} */ (e)));
  }

  /**
   * Set confirmation options and promise resolver
   * @param {ActionConfirmationOptions} options - Button options
   * @param {(value: string) => void} resolve - Callback when user selects an option
   * @param {{onRevise?: (index: number, editedText: string) => (import('juggler/context-item').RevisedApprovalSuggestion | null | Promise<import('juggler/context-item').RevisedApprovalSuggestion | null>)}} [extra] - Optional plugin bridge for editable suggestions. When `onRevise` is supplied, single-pattern "don't ask again" options gain an inline pencil edit affordance.
   */
  setOptions(options, resolve, extra = {}) {
    this._options = options;
    this._resolveCallback = resolve;
    this._onRevise = extra.onRevise || null;
    this._focusedIndex = 0;
    this._reviseTokens = {};
    this._debounceTimers = {};
    this._editSnapshots = {};
    this.render();
  }

  /**
   * Is this option's suggestion editable in place? Editable requires a revise
   * bridge, a grant to remember, and exactly ONE pattern — multi-pattern
   * suggestions and the plain Yes/No buttons keep today's fixed rendering.
   * @param {ApprovalOption} opt
   * @returns {boolean} True if the option should show a pencil edit affordance
   * @private
   */
  _isEditable(opt) {
    if (!this._onRevise) return false;
    const hasGrant = (Array.isArray(opt.rules) && opt.rules.length > 0)
      || (Array.isArray(opt.allowedPaths) && opt.allowedPaths.length > 0);
    if (!hasGrant) return false;
    const patternCount = (opt.patterns && opt.patterns.length)
      ? opt.patterns.length
      : (opt.pattern ? 1 : 0);
    return patternCount === 1;
  }

  /**
   * The single pattern text pre-filled into an editable option's input.
   * @param {ApprovalOption} opt
   * @returns {string} The current pattern, or ''
   * @private
   */
  _currentPattern(opt) {
    if (opt.patterns && opt.patterns.length) return opt.patterns[0] || '';
    return opt.pattern || '';
  }

  /**
   * Render the approval buttons
   */
  render() {
    if (!this._options) {
      return;
    }

    const { options } = this._options;

    const optionsHTML = options.map((opt, index) => {
      const patternHtml = this._renderPatterns(opt);
      const descriptorHTML = patternHtml
        ? `<span class="option-descriptor">${patternHtml}</span>`
        : '';
      const editable = this._isEditable(opt);
      // The pencil lives INSIDE the button, pinned to its right edge — a
      // subtle span, not its own row, so an editable option is the same
      // height as any other. A span (not a nested <button>, which is invalid
      // HTML) that the delegated click handler routes to edit mode.
      const pencilHTML = editable
        ? `<span class="pattern-edit-btn" data-edit-index="${index}" role="button" title="${escapeHtml(t('Edit pattern'))}" aria-label="${escapeHtml(t('Edit pattern'))}">${PENCIL_ICON_SVG}</span>`
        : '';
      // The editor occupies the SAME slot as the button (only one is shown
      // at a time — see the `.editing` CSS), so entering edit mode swaps the
      // button for the input in place without changing the dialog's height.
      const editFieldHTML = editable
        ? `<div class="pattern-edit-field" hidden>
             <input type="text" class="pattern-edit-input field-input field-input-sm" data-edit-index="${index}" value="${escapeHtml(this._currentPattern(opt))}" aria-label="${escapeHtml(t('Edit approval pattern'))}" />
             <div class="pattern-edit-notice" hidden></div>
           </div>`
        : '';
      return `
        <div class="action-approval-option${editable ? ' editable' : ''}" data-index="${index}">
          <button
            class="action-confirmation-button ${escapeHtml(opt.style)}"
            data-value="${escapeHtml(opt.value)}"
            data-index="${index}"
          >${escapeHtml(t(opt.label))}${descriptorHTML}${pencilHTML}</button>
          ${editFieldHTML}
        </div>
      `;
    }).join('');

    this.innerHTML = `
      <div class="action-approval-buttons">
        ${optionsHTML}
      </div>
    `;

    this._wireEditInputs();
  }

  /**
   * Attach input + keydown listeners to each editable option's text input.
   * Called after every render; the previous render's nodes (and their
   * listeners) are discarded when innerHTML is replaced.
   * @private
   */
  _wireEditInputs() {
    if (!this._onRevise) return;
    this.querySelectorAll('.pattern-edit-input').forEach((el) => {
      const input = /** @type {HTMLInputElement} */ (el);
      const index = Number(input.dataset.editIndex);
      input.addEventListener('input', () => this._scheduleRevise(index, input.value));
      input.addEventListener('keydown', (e) =>
        this._handleInputKeyDown(/** @type {KeyboardEvent} */ (e), index));
    });
  }

  /**
   * Render the trailing descriptor of a "Don't ask again" button.
   *
   * Two shapes, deliberately worded apart so the user can never mistake one for
   * the other:
   *   - a **command-pattern** option reads `… for <code>git push *</code>` — the
   *     `<code>` is a shell command glob that will be auto-approved;
   *   - a **folder-grant** option (carries `allowedPaths`) reads
   *     `… and allow access to <folder-icon> ~/notes` — the
   *     `<code>` is a directory added to the allowed-reads list, NOT a command.
   * Each entry is its own `<code>` span; multiple are joined by a plain-font
   * "or" (Oxford-style commas for three or more).
   * @param {ApprovalOption} opt
   * @returns {string} HTML for the descriptor suffix, or '' if there is none
   * @private
   */
  _renderPatterns(opt) {
    const isPathGrant = Array.isArray(opt.allowedPaths) && opt.allowedPaths.length > 0;
    const parts = (opt.patterns && opt.patterns.length)
      ? opt.patterns
      : (opt.pattern ? [opt.pattern] : []);
    if (parts.length === 0) {
      return '';
    }
    const prefix = isPathGrant ? FOLDER_ICON_SVG : '';
    const cls = isPathGrant ? 'pattern-highlight path-highlight' : 'pattern-highlight';
    /** @type {Record<string, string>} */
    const spans = Object.fromEntries(parts.map((p, i) => [`p${i}`, `<code class="${cls}">${prefix}${escapeHtml(p)}</code>`]));
    // The list is formatted over slot stand-ins, so the language's own "or" is
    // escaped as text and the spans go in as markup.
    const slots = htmlSlots(spans);
    const joined = withHtml(formatList(Object.keys(spans).map((name) => String(slots[name])), { type: 'disjunction' }), spans);
    // A folder grant whitelists reads under a directory; word it so it reads as
    // access, not a command pattern.
    const slot = { patterns: joined };
    const descriptor = isPathGrant
      ? t('and allow access to {patterns}', htmlSlots(slot))
      : t('for {patterns}', htmlSlots(slot));
    return ` ${withHtml(descriptor, slot)}`;
  }

  /**
   * Drop the visual focus cursor when keyboard focus leaves the widget entirely
   * (click elsewhere, tab away, switch conversation). Without this the `.is-focused`
   * ring lingers on a button that no longer holds focus, falsely implying that
   * ↑/↓/Enter still act here — they don't until the widget is re-engaged. Focus
   * moving between this widget's own buttons is kept (relatedTarget is inside).
   * @param {FocusEvent} event
   * @private
   */
  _handleFocusOut(event) {
    // Click-away / tab-away while editing cancels the edit: restore the button
    // to its pre-edit state, discarding the typed text (mirrors Escape). Done
    // before the focus-ring cleanup below so it also fires when focus moves to
    // another control INSIDE this widget (e.g. clicking the No button). Enter
    // never reaches here — it approves and removes the widget's listeners first.
    //
    // Chromium (WebView2) also blurs a focused element as it is removed, so a
    // move sends this focusout from inside the removal, before the disconnect.
    // A move keeps the edit (see connectedCallback), so the cancel waits a
    // microtask and stands down if the widget was disconnected meanwhile.
    const losing = /** @type {HTMLElement|null} */ (event.target);
    if (losing && losing.classList && losing.classList.contains('pattern-edit-input')) {
      const disconnects = this._disconnects;
      queueMicrotask(() => {
        if (this._disconnects !== disconnects) return;
        const editingRow = losing.closest('.action-approval-option');
        if (editingRow && editingRow.classList.contains('editing')) {
          this._exitEditMode(Number(losing.dataset.editIndex), { revert: true });
        }
      });
    }
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (next && this.contains(next)) return;
    this.querySelectorAll('.action-confirmation-button').forEach(
      btn => btn.classList.remove('is-focused'),
    );
  }

  /**
   * Handle button click
   * @param {MouseEvent} event
   * @private
   */
  _handleButtonClick(event) {
    const target = /** @type {HTMLElement|null} */ (event.target);
    if (!target) {
      return;
    }

    // Pencil affordance: enter edit mode rather than approving. Handled first
    // so a click on the pencil never falls through to the approve button.
    const editBtn = target.closest('.pattern-edit-btn');
    if (editBtn) {
      event.preventDefault();
      this._enterEditMode(Number(/** @type {HTMLElement} */ (editBtn).dataset.editIndex));
      return;
    }

    const button = /** @type {HTMLButtonElement|null} */ (target.closest('.action-confirmation-button'));
    if (!button) {
      return;
    }
    // A button disabled by an invalid edit must not resolve.
    if (button.disabled) {
      return;
    }

    const value = button.dataset.value;
    if (value) {
      this._resolve(value);
    }
  }

  /**
   * Enter edit mode for one option: reveal its input (pre-filled with the
   * current pattern), hide the descriptor, focus the input, and run an initial
   * validation so any broadness caution shows immediately.
   * @param {number} index - Option index
   * @private
   */
  _enterEditMode(index) {
    const row = this.querySelector(`.action-approval-option[data-index="${index}"]`);
    if (!row) return;
    const field = /** @type {HTMLElement|null} */ (row.querySelector('.pattern-edit-field'));
    const input = /** @type {HTMLInputElement|null} */ (row.querySelector('.pattern-edit-input'));
    if (!field || !input) return;
    // Snapshot the pre-edit grant so a cancel (Escape / click-away) restores the
    // button to exactly what it showed before editing began.
    const opt = this._options?.options?.[index];
    this._editSnapshots[index] = opt
      ? { rules: opt.rules, allowedPaths: opt.allowedPaths, patterns: opt.patterns, pattern: opt.pattern }
      : {};
    const descriptor = row.querySelector('.option-descriptor');
    if (descriptor) descriptor.setAttribute('hidden', '');
    field.hidden = false;
    row.classList.add('editing');
    input.focus();
    input.select();
    // Validate the pre-filled value now (bypassing the debounce) so an
    // already-broad suggestion shows its caution the moment editing begins.
    this._runRevise(index, input.value);
  }

  /**
   * Leave edit mode for one option and put its button back in place — the exit
   * path for both Escape and click-away (never for a committed Enter, which
   * tears down the whole widget). With `revert`, the option's grant is restored
   * from the snapshot taken in {@link _enterEditMode}, discarding the typed
   * text; the descriptor is re-rendered either way. Idempotent: it no-ops unless
   * the option is currently editing, so the focus move it triggers can't
   * re-enter it.
   * @param {number} index - Option index
   * @param {{revert?: boolean}} [opts] - `revert: true` discards the edit
   * @returns {HTMLButtonElement|null} The restored approve button, or null
   * @private
   */
  _exitEditMode(index, { revert = false } = {}) {
    const row = this.querySelector(`.action-approval-option[data-index="${index}"]`);
    if (!row || !row.classList.contains('editing')) return null;
    // Clear editing state FIRST so the focus move below is a no-op re-entry.
    row.classList.remove('editing');
    const snapshot = this._editSnapshots[index];
    delete this._editSnapshots[index];
    // Cancel any pending/in-flight revise so a late response can't reapply to a
    // button that has left edit mode.
    clearTimeout(this._debounceTimers[index]);
    delete this._debounceTimers[index];
    this._reviseTokens[index] = (this._reviseTokens[index] || 0) + 1;

    const opt = this._options?.options?.[index];
    if (revert && snapshot && opt) {
      opt.rules = snapshot.rules;
      opt.allowedPaths = snapshot.allowedPaths;
      opt.patterns = snapshot.patterns;
      opt.pattern = snapshot.pattern;
    }

    const descriptor = row.querySelector('.option-descriptor');
    if (descriptor && opt) {
      descriptor.innerHTML = this._renderPatterns(opt);
      descriptor.removeAttribute('hidden');
    }
    const field = /** @type {HTMLElement|null} */ (row.querySelector('.pattern-edit-field'));
    if (field) field.hidden = true;
    const notice = /** @type {HTMLElement|null} */ (row.querySelector('.pattern-edit-notice'));
    if (notice) {
      notice.hidden = true;
      notice.textContent = '';
      notice.classList.remove('caution', 'error');
    }
    row.querySelector('.pattern-edit-input')?.removeAttribute('aria-invalid');
    const button = /** @type {HTMLButtonElement|null} */ (row.querySelector('.action-confirmation-button'));
    if (button) button.disabled = false;
    return button;
  }

  /**
   * Debounce a revise request for one option's edited text.
   * @param {number} index - Option index
   * @param {string} text - Current input text
   * @private
   */
  _scheduleRevise(index, text) {
    if (!this._onRevise) return;
    clearTimeout(this._debounceTimers[index]);
    this._debounceTimers[index] = /** @type {number} */ (/** @type {unknown} */ (
      setTimeout(() => this._runRevise(index, text), REVISE_DEBOUNCE_MS)
    ));
  }

  /**
   * Call the revise bridge for one option and apply the result — unless a newer
   * request superseded this one while it was in flight (stale-guard).
   * @param {number} index - Option index
   * @param {string} text - Edited text
   * @returns {Promise<void>}
   * @private
   */
  async _runRevise(index, text) {
    if (!this._onRevise) return;
    const token = (this._reviseTokens[index] || 0) + 1;
    this._reviseTokens[index] = token;
    let result = null;
    try {
      result = await this._onRevise(index, text);
    } catch {
      result = null;
    }
    if (this._reviseTokens[index] !== token) return; // superseded by a newer edit
    this._applyReviseResult(index, result);
  }

  /**
   * Apply a revise result to one option: update its live grant (when valid),
   * enable/disable the button, and render the notice (amber caution when valid,
   * red reason when not).
   * @param {number} index - Option index
   * @param {import('juggler/context-item').RevisedApprovalSuggestion | null} result
   * @private
   */
  _applyReviseResult(index, result) {
    const opt = this._options?.options?.[index];
    const row = this.querySelector(`.action-approval-option[data-index="${index}"]`);
    if (!opt || !row) return;
    const button = /** @type {HTMLButtonElement|null} */ (row.querySelector('.action-confirmation-button'));
    const notice = /** @type {HTMLElement|null} */ (row.querySelector('.pattern-edit-notice'));
    const valid = !!(result && result.valid);

    if (valid && result) {
      // A revised grant is one shape or the other, never both — clear the
      // opposite so `_renderPatterns` and persistence read consistently.
      if (result.rules) { opt.rules = result.rules; opt.allowedPaths = undefined; }
      if (result.allowedPaths) { opt.allowedPaths = result.allowedPaths; opt.rules = undefined; }
      if (result.patterns) { opt.patterns = result.patterns; opt.pattern = result.patterns[0]; }
      const descriptor = row.querySelector('.option-descriptor');
      if (descriptor) descriptor.innerHTML = this._renderPatterns(opt);
    }

    if (button) button.disabled = !valid;
    const input = row.querySelector('.pattern-edit-input');
    if (valid) input?.removeAttribute('aria-invalid');
    else input?.setAttribute('aria-invalid', 'true');

    if (notice) {
      const msg = (result && result.notice) ? result.notice : (valid ? '' : t('Invalid pattern'));
      if (msg) {
        notice.textContent = msg;
        notice.hidden = false;
        notice.classList.toggle('caution', valid);
        notice.classList.toggle('error', !valid);
      } else {
        notice.hidden = true;
        notice.textContent = '';
        notice.classList.remove('caution', 'error');
      }
    }
  }

  /**
   * Handle keyboard navigation.
   *
   * Only the bare keys belong to this widget. A modified chord (⌥⌘↑/↓ to switch
   * conversation, say) is an app command: this listener sits on the element, so
   * claiming it would stopPropagation() it before the document-level dispatcher
   * ever sees it, and the shortcut would silently do nothing whenever an
   * approval had focus.
   * @param {KeyboardEvent} event
   * @private
   */
  _handleKeyDown(event) {
    if (!this._options) {
      return;
    }

    const buttons = this.querySelectorAll('.action-confirmation-button');
    if (buttons.length === 0) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this._focusedIndex = Math.max(0, this._focusedIndex - 1);
        this._focusButton(this._focusedIndex);
        break;

      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this._focusedIndex = Math.min(buttons.length - 1, this._focusedIndex + 1);
        this._focusButton(this._focusedIndex);
        break;

      case 'Enter': {
        event.preventDefault();
        const enterButton = /** @type {HTMLElement} */ (buttons[this._focusedIndex]);
        if (enterButton) {
          enterButton.click();
        }
        break;
      }

      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this._disengage();
        break;
    }
  }

  /**
   * Keyboard handling while focus is inside an edit input.
   *   - Return → commit and approve with the edited grant (if the button is
   *     enabled); if the edit is invalid the button is disabled and nothing
   *     happens, mirroring a click.
   *   - ↑/↓ → caret movement; stop propagation so the widget's button
   *     navigation doesn't hijack the keystroke. Modified chords are left alone
   *     for the same reason as in {@link _handleKeyDown} — ⌥⌘↑/↓ is a
   *     conversation switch, not caret movement.
   *   - Escape → cancel the edit in place: restore the button to its pre-edit
   *     grant and refocus it. Propagation is stopped so the widget-level Escape
   *     does NOT also disengage the whole approval — cancelling an edit and
   *     dismissing the approval are distinct actions.
   * @param {KeyboardEvent} event
   * @param {number} index - Option index of the input
   * @private
   */
  _handleInputKeyDown(event, index) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const button = /** @type {HTMLButtonElement|null} */ (
        this.querySelector(`.action-confirmation-button[data-index="${index}"]`)
      );
      if (button && !button.disabled) button.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const button = this._exitEditMode(index, { revert: true });
      if (button) button.focus();
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.stopPropagation();
    }
  }

  /**
   * Enter widget mode — focuses the approval buttons for keyboard interaction.
   * Called externally (e.g. by conversation-tab) when Enter is pressed on a selected approval item.
   */
  engage() {
    this._focusButton(this._focusedIndex);
  }

  /**
   * Exit widget mode — blurs buttons, removes visual focus indicator,
   * and selects the parent item so keyboard navigation continues from here.
   * @private
   */
  _disengage() {
    const buttons = this.querySelectorAll('.action-confirmation-button');
    buttons.forEach(btn => btn.classList.remove('is-focused'));
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Select the parent message item so arrow keys work from this position
    const parentItem = this.closest('[message-id]');
    if (parentItem) {
      const itemId = parentItem.getAttribute('message-id');
      const column = this.closest('conversation-area');
      if (itemId && column) {
        /** @type {any} */ (column).selectItem(itemId);
      }
    }
  }

  /**
   * Focus a button by index
   * @param {number} index
   * @private
   */
  _focusButton(index) {
    const buttons = this.querySelectorAll('.action-confirmation-button');
    buttons.forEach((btn, i) => {
      const button = /** @type {HTMLElement} */ (btn);
      if (i === index) {
        button.classList.add('is-focused');
        button.focus();
      } else {
        button.classList.remove('is-focused');
      }
    });
  }

  /**
   * Resolve with user's selection
   * @param {string} value - Selected option value
   * @private
   */
  _resolve(value) {
    // Cancel any in-flight edit debounce so a late revise can't touch a
    // detached widget after we resolve.
    for (const key of Object.keys(this._debounceTimers)) {
      clearTimeout(this._debounceTimers[/** @type {any} */ (key)]);
    }
    this._debounceTimers = {};
    if (this._resolveCallback) {
      this._resolveCallback(value);
      this._resolveCallback = null;
    }
    // Stop listening now rather than at the disconnect below: handing the
    // keyboard back blurs a button, and the focusout must not reach a widget
    // that has already answered.
    this._runCleanups();
    // Hand the keyboard back before removing ourselves: one of these buttons
    // holds focus, and taking it out of the DOM would strand focus on <body>.
    // The owning tab decides where it lands (conversation-tab Rule 20), so
    // dispatch while still connected — after removal this would reach nobody.
    this.dispatchEvent(new CustomEvent('restore-input-focus', { bubbles: true, composed: true }));
    this.remove();
  }
}

customElements.define('action-confirmation', ActionConfirmation);

export default ActionConfirmation;
