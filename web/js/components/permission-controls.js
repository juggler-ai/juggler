//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE


import { presentInlineMenu } from '../utils/popup-surface.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { isFileEditingAllowed } from '../services/file-editing-permission.js';
import { CHECK_SVG, withClass } from '../utils/icons.js';
import './path-input.js';

const LOCK_ICON = `<svg class="shell-lock-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M240-640h360v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85h-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640Zm0 480h480v-400H240v400Zm296.5-143.5Q560-327 560-360t-23.5-56.5Q513-440 480-440t-56.5 23.5Q400-393 400-360t23.5 56.5Q447-280 480-280t56.5-23.5ZM240-160v-400 400Z"/></svg>`;
const CHECK_ICON = withClass(CHECK_SVG, 'shell-lock-icon');

/**
 * Permission Controls — host shell for plugin-supplied permission UI.
 *
 * This component owns:
 *   - The button that opens the popup. Its label is a live summary of the
 *     conversation's permission state (edits on/off, command + path counts)
 *     and updates in place on every `permissionRules` / `allowedPaths`
 *     change — the popup is never re-rendered for label updates.
 *   - The popup chrome (header, layout, dividers).
 *   - The generic "Allowed paths" section (filesystem roots the LLM may
 *     read/write under).
 *
 * Everything else — the per-plugin sections (shell command patterns, the
 * file-write toggle, future plugins' UI) — comes from each context-item
 * class's static `getPermissionSection(messageThread)`. Sections are
 * deduplicated by their `id`, so several plugins backing the same rule
 * (every edit-family plugin shares `write-file`) collapse into one card.
 * The card heading comes from `section.title`; sections may omit it when
 * a single control inside is self-describing. Plugins own their own event
 * wiring and Yjs observers; the host does not call back in.
 *
 * Visibility is gated by the current strategy's `showsApprovalControls`
 * manifest property.
 */
class PermissionControls extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this.messageThread = null;
    /** @type {boolean} @private */
    this.popupOpen = false;
    /**
     * The open popup's presentation handle (pending frame + popup release),
     * else null. Its `surface` is THIS control's own popup while open
     * (relocated to <body>) — instance-scoped so updates/teardown never touch a
     * sibling's surface: multiple controls coexist (root + each open sub-thread
     * column) and all share the `[data-permission-controls="true"]` attribute,
     * so a document-wide query would grab the wrong one.
     * @type {import('../utils/popup-surface.js').InlineMenu|null} @private
     */
    this._menu = null;
    /** @type {((event: any) => void)|null} @private */
    this.metadataObserver = null;
    /** @type {(() => void)|null} @private */
    this.sessionUnsubscribe = null;
    /** @type {string} @private - For inline allowed-path editing */
    this.editingPath = '';
    /** @type {boolean} @private */
    this.editingNewPath = false;
    /**
     * @type {boolean} @private
     * A Yjs allowedPaths change came in while an inline editor was open;
     * flush the deferred re-render through `_endPathEditing()`.
     */
    this._pathRenderPending = false;
    /** @type {Array<{element: HTMLElement, dispose?: () => void}>} @private */
    this._activeSections = [];
    /** @type {string[]} @private Stable allowed-path row order while popup is open */
    this._visiblePathOrder = [];
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this._menu?.close();
    this._menu = null;
    if (this.metadataObserver && this.messageThread) {
      this.messageThread.conversation.unobserveMetadata(this.metadataObserver);
      this.metadataObserver = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    this._disposeActiveSections();
  }

  /**
   * Set the message thread this component is bound to
   * @param {import('../model/message-thread.js').MessageThread|null} messageThread
   */
  setMessageThread(messageThread) {
    // No-op when the binding hasn't actually changed. The parent
    // (composer-box) re-calls this on every conversation-tab column rebuild,
    // i.e. on every message arrival. Re-rendering here would nuke the
    // popup DOM (and any focused input inside it) for no reason.
    if (this.messageThread === messageThread) return;

    if (this.metadataObserver && this.messageThread) {
      this.messageThread.conversation.unobserveMetadata(this.metadataObserver);
      this.metadataObserver = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }

    this.messageThread = messageThread;

    if (messageThread) {
      this.metadataObserver = (event) => {
        // Strategy change can flip showsApprovalControls visibility,
        // so it needs a full render (button + maybe-hidden popup).
        if (event.keysChanged.has('currentStrategyId')) {
          this.render();
          return;
        }
        // A conversation permission-rule change only affects the button
        // label summary; per-plugin sections inside the popup observe rules
        // themselves, so we never touch the popup here.
        if (event.keysChanged.has('conversationPermissionRules')) {
          this._renderButton();
        }
        if (event.keysChanged.has('conversationAllowedPaths')) {
          // conversationAllowedPaths affects both the button summary and the
          // generic "Allowed paths" section. Refresh the button
          // unconditionally; refresh the section only when no
          // inline editor is open — otherwise a concurrent peer
          // change would blow away the user's half-typed input.
          // The deferred section render flushes through
          // _endPathEditing().
          this._renderButton();
          if (this._isEditingPath()) {
            this._pathRenderPending = true;
          } else {
            this._renderAllowedPaths();
          }
        }
      };
      messageThread.conversation.observeMetadata(this.metadataObserver);
      const unsub = messageThread.conversation.session?.subscribe?.((/** @type {any} */ evt) => {
        if (evt.type !== 'session:metadata-changed') return;
        const keys = evt.data?.keys || [];
        if (!keys.includes('sessionPermissionRules') && !keys.includes('sessionAllowedPaths')) return;
        this._renderButton();
        if (keys.includes('sessionAllowedPaths')) {
          if (this._isEditingPath()) this._pathRenderPending = true;
          else this._renderAllowedPaths();
        }
      });
      this.sessionUnsubscribe = typeof unsub === 'function' ? /** @type {() => void} */ (unsub) : null;
    }

    this.render();
  }

  /**
   * @returns {boolean} true if the strategy permits the panel
   * @private
   */
  shouldShowControls() {
    if (!this.messageThread) return false;
    const strategy = this.messageThread.strategy;
    if (!strategy) return true;
    const manifest = strategy.getManifest();
    return manifest.showsApprovalControls !== false;
  }

  /** @private */
  togglePopup() {
    if (this.popupOpen) this.closePopup(); else this.openPopup();
  }

  /** @private */
  openPopup() {
    this.popupOpen = true;
    this.editingPath = '';
    this.editingNewPath = false;
    this.render();

    // presentInlineMenu owns the deferred relocation; presentPopup beneath it
    // owns body-append, dismissal wiring, the reposition observer, and the
    // anchored-vs-sheet decision.
    this._menu = presentInlineMenu({
      host: this,
      surfaceSelector: '.permissions-popup',
      anchorSelector: '.permission-btn',
      onClose: () => this.closePopup(),
      align: 'right',
    });
  }

  /** @private */
  closePopup() {
    if (!this.popupOpen) return;
    this.popupOpen = false;
    // Close cancels a pending relocation, then tears down the surface, scrim,
    // observer and dismissal wiring.
    this._menu?.close();
    this._menu = null;
    this.editingPath = '';
    this.editingNewPath = false;
    this._disposeActiveSections();
    this.render();
  }

  /**
   * Dispose every plugin section currently mounted in the popup. Plugins
   * register Yjs observers in their factory; their `dispose` is the
   * matching teardown. Called both on popup close and on repopulate.
   * @private
   */
  _disposeActiveSections() {
    if (!this._activeSections) return;
    for (const s of this._activeSections) {
      try { s.dispose?.(); } catch (e) {

        console.warn('permission-controls: section dispose threw', e);
      }
    }
    this._activeSections = [];
  }

  /**
   * @returns {boolean} true if an inline allowed-path editor is open
   * @private
   */
  _isEditingPath() {
    return this.editingPath !== '' || this.editingNewPath;
  }

  /**
   * Drop out of allowed-path edit mode and flush any deferred re-render.
   * Called from every code path that closes the path editor (save, cancel,
   * Escape, empty-save).
   * @private
   */
  _endPathEditing() {
    this.editingPath = '';
    this.editingNewPath = false;
    this._pathRenderPending = false;
    this._renderAllowedPaths();
  }

  render() {
    if (!this.shouldShowControls()) {
      this.innerHTML = '';
      this.style.display = 'none';
      return;
    }

    this.style.display = '';

    if (!this.messageThread) {
      this.innerHTML = '';
      return;
    }

    const existingPopup = this._menu?.surface ?? null;

    // While open, the popup has been relocated out of this element to <body>
    // (see openPopup) and positioned against our button. A re-render here —
    // e.g. a conversation-view column rebuild hands composer-box a fresh
    // MessageThread wrapper, which re-calls setMessageThread() — must NOT
    // clobber innerHTML: that recreates (detaches) the button the body-hosted
    // popup is anchored to, so the popup's reposition observer measures a
    // detached node (rect = 0) and the popup jumps to the top-left corner.
    // When the live surface and its anchor button both exist, update the
    // button IN PLACE and leave the open popup untouched.
    const liveButton = /** @type {HTMLElement|null} */ (this.querySelector('.permission-btn'));
    if (this.popupOpen && existingPopup && liveButton) {
      this._renderButton();
      return;
    }

    const includePopupHtml = this.popupOpen && !existingPopup;

    this.innerHTML = `
            <button class="permission-btn input-ctrl-btn ${this._buttonStateClass()} ${this.popupOpen ? 'open' : ''}" title="Manage auto-approval permissions" data-shortcut-id="toggle-file-editing">
                  ${this._buttonInnerHTML()}
              </button>
            ${includePopupHtml ? `<div class="dropdown-menu permissions-popup show"></div>` : ''}
        `;

    const btn = this.querySelector('.permission-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePopup();
      });
    }

    if (this.popupOpen) {
      const popup = existingPopup || this.querySelector('.permissions-popup');
      if (popup) this._populatePopup(/** @type {HTMLElement} */ (popup));
    }
  }

  /**
   * Update only the button — label, state class, open class — without
   * touching the popup. Called from the metadata observer when only the
   * permission summary changed, so an open popup keeps its focus, scroll,
   * and any half-typed inline editors intact.
   * @private
   */
  _renderButton() {
    if (!this.shouldShowControls() || !this.messageThread) return;
    const btn = /** @type {HTMLElement|null} */ (this.querySelector('.permission-btn'));
    if (!btn) return;
    btn.className = `permission-btn input-ctrl-btn ${this._buttonStateClass()} ${this.popupOpen ? 'open' : ''}`;
    btn.innerHTML = this._buttonInnerHTML();
  }

  /**
   * @returns {'allowed'|'ask'} state class driving the button's colour
   * @private
   */
  _buttonStateClass() {
    return this._editsAllowed() ? 'allowed' : 'ask';
  }

  /**
   * @returns {boolean} true if a boolean=true write-file rule is enabled
   * @private
   */
  _editsAllowed() {
    return isFileEditingAllowed(this.messageThread);
  }

  /**
   * Build the button's inner HTML — a compact live summary of the
   * conversation's permission state. Format:
   *   "✓ Edits on · 3 cmds · 2 paths"   when edits are enabled
   *   "🔒 Edits off · 3 cmds · 2 paths"  when edits are disabled
   * Counts are dropped when zero so the button never carries noise.
   * @returns {string} HTML for the button's inner content
   * @private
   */
  _buttonInnerHTML() {
    const mt = this.messageThread;
    if (!mt) return '';
    const allowed = this._editsAllowed();
    const cmdCount = mt.getRulesFor('execute').filter((/** @type {any} */ r) => r.kind === 'glob').length;
    const pathCount = mt.getAllowedPaths().length;
    const head = allowed
      ? `${CHECK_ICON} Edits on`
      : `${LOCK_ICON} Edits off`;
    // Counts live in a span so the touch composer can drop them (keeping just
    // "✓ Edits on") to fit the single-line control row; desktop shows them all.
    const detail = [];
    if (cmdCount > 0) detail.push(`${cmdCount} cmd${cmdCount === 1 ? '' : 's'}`);
    if (pathCount > 0) detail.push(`${pathCount} path${pathCount === 1 ? '' : 's'}`);
    const detailHtml = detail.length
      ? `<span class="permission-detail"> · ${detail.join(' · ')}</span>`
      : '';
    return head + detailHtml;
  }

  /**
   * Build the popup body: allowed-paths section followed by every plugin's
   * `getPermissionSection` contribution.
   * @param {HTMLElement} popup
   * @private
   */
  _populatePopup(popup) {
    // Dispose any sections from a previous open before rebuilding.
    this._disposeActiveSections();
    this._visiblePathOrder = [];

    popup.innerHTML = `
            <div class="allowed-paths-section" data-section="allowed-paths"></div>
            <div class="plugin-sections"></div>
        `;
    this._renderAllowedPaths(popup);

    const sections = /** @type {HTMLElement|null} */ (popup.querySelector('.plugin-sections'));
    if (!sections || !this.messageThread) return;

    // Each registered context-item class may contribute a permission
    // section; registry order gives a stable, learnable layout. Sections
    // are deduplicated by `section.id` (every edit-family plugin shares
    // `write-file`), and each `dispose` is collected into _activeSections
    // for teardown on close.
    const mt = this.messageThread;
    this._activeSections = [];
    /** @type {Set<string>} */
    const seenIds = new Set();
    /** @type {Array<{section: any, pluginId: string}>} */
    const collected = [];
    for (const { id, class: Klass } of contextItemRegistry.getAll()) {
      try {
        const section = /** @type {any} */ (Klass).getPermissionSection?.(mt);
        if (!section) continue;
        if (!section.id || seenIds.has(section.id)) {
          // Duplicate of an already-mounted group — tear it down
          // immediately so the plugin's observer doesn't leak.
          try { section.dispose?.(); } catch { /* ignore */ }
          continue;
        }
        seenIds.add(section.id);
        collected.push({ section, pluginId: id });
      } catch (e) {
        // A misbehaving plugin must not bring down the whole popup.
        // Log once; the user still sees the rest of the UI.

        console.warn(`permission-controls: plugin ${id} threw in getPermissionSection`, e);
      }
    }

    // Registry order is the default; an optional numeric `section.order`
    // (default 0) lets a plugin float its card up or down — e.g. the rarely
    // used .gitignore toggle uses a negative order to sit right under the
    // allowed-paths section. Array.sort is stable, so equal orders keep
    // registry order.
    collected.sort((a, b) => (a.section.order ?? 0) - (b.section.order ?? 0));

    for (const { section } of collected) {
      const wrapper = document.createElement('div');
      wrapper.className = 'plugin-section-wrapper';
      wrapper.dataset.sectionId = section.id;
      if (section.title) {
        const heading = document.createElement('h4');
        heading.className = 'plugin-section-heading';
        heading.textContent = section.title;
        wrapper.appendChild(heading);
      }
      wrapper.appendChild(section.element);
      sections.appendChild(wrapper);
      this._activeSections.push(section);
    }
  }

  /**
   * Render the allowed-paths editor in place. Called both on initial popup
   * build and on Yjs `allowedPaths` changes.
   * @param {HTMLElement} [popupArg]
   * @private
   */
  _renderAllowedPaths(popupArg) {
    const popup = popupArg || this._menu?.surface;
    if (!popup || !this.messageThread) return;
    const host = /** @type {HTMLElement|null} */ (popup.querySelector('[data-section="allowed-paths"]'));
    if (!host) return;

    const currentPathEntries = this.messageThread.getAllowedPathEntries ? this.messageThread.getAllowedPathEntries() : this.messageThread.getAllowedPaths().map((p) => ({ id: p, path: p, scope: 'conversation' }));
    const byId = new Map(currentPathEntries.map(entry => [entry.id, entry]));
    this._visiblePathOrder = this._visiblePathOrder.filter(id => byId.has(id));
    for (const entry of currentPathEntries) {
      if (!this._visiblePathOrder.includes(entry.id)) this._visiblePathOrder.push(entry.id);
    }
    const orderedEntries = /** @type {Array<{id: string, path: string, scope?: string, implicit?: boolean}>} */ (this._visiblePathOrder.map(id => byId.get(id)).filter(Boolean));
    // The implicit project root is always listed first.
    const pathEntries = [...orderedEntries.filter(e => e.implicit), ...orderedEntries.filter(e => !e.implicit)];

    // Build the static chrome (heading + list container + add button) once per
    // popup, wiring delegated listeners on the list. The host is recreated when
    // the popup reopens, so absence of `.paths-list` is the "needs building"
    // signal — no separate flag to reset.
    let listEl = /** @type {HTMLElement | null} */ (host.querySelector('.paths-list'));
    if (!listEl) {
      host.innerHTML = `
              <h4 class="plugin-section-heading">Allowed paths</h4>
              <div class="paths-list"></div>
              <div class="add-pattern-row">
                <button class="add-pattern-btn add-path-btn">+ Add path</button>
              </div>
        `;
      listEl = /** @type {HTMLElement} */ (host.querySelector('.paths-list'));
      listEl.addEventListener('click', (e) => this._onPathsListClick(e));
      listEl.addEventListener('keydown', (e) => this._onPathsListKeydown(/** @type {KeyboardEvent} */ (e)));
      const addBtn = host.querySelector('.add-path-btn');
      if (addBtn) addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingNewPath = true;
        this.editingPath = '';
        this._renderAllowedPaths();
      });
    }

    this._reconcilePathRows(listEl, pathEntries);

    if (this.editingPath || this.editingNewPath) {
      requestAnimationFrame(() => {
        const pi = /** @type {any} */ (host.querySelector('.path-edit-input'));
        if (pi && typeof pi.focus === 'function') pi.focus();
      });
    }
  }

  /**
   * The rows the paths list should currently show, in display order. Each
   * carries a stable `key` (path id, or a sentinel for the new-path editor) so
   * the reconciler can match it against the DOM already present.
   * @param {Array<{id: string, path: string, scope?: string, implicit?: boolean}>} pathEntries ordered entries
   * @returns {Array<{key: string, mode: 'implicit'|'display'|'edit'|'new', path?: string, scope?: string}>} descriptors
   * @private
   */
  _desiredPathRows(pathEntries) {
    const out = pathEntries.map(entry => {
      let mode = 'display';
      if (entry.implicit) mode = 'implicit';
      else if (this.editingPath === entry.id || this.editingPath === entry.path) mode = 'edit';
      return { key: entry.id, mode, path: entry.path, scope: entry.scope || 'conversation' };
    });
    if (this.editingNewPath) out.push({ key: '__newpath__', mode: 'new', path: '', scope: 'conversation' });
    return /** @type {Array<{key: string, mode: 'implicit'|'display'|'edit'|'new', path?: string, scope?: string}>} */ (out);
  }

  /**
   * Build a fresh path row for a descriptor. Listeners are delegated on the
   * list container, so the row carries none.
   * @param {{key: string, mode: string, path?: string, scope?: string}} d descriptor
   * @returns {HTMLElement} row element
   * @private
   */
  _buildPathRow(d) {
    const row = document.createElement('div');
    row.dataset.key = d.key;
    row.dataset.mode = d.mode;
    const p = d.path || '';
    if (d.mode === 'implicit') {
      // The implicit project root is shown but cannot be edited, re-scoped, or
      // removed — it applies to every conversation and never changes.
      row.className = 'pattern-row pattern-row-implicit';
      row.innerHTML = `
        <span class="pattern-text" data-path="${escapeHtml(p)}" title="Project root — available in every conversation">${escapeHtml(p)}</span>
        <span class="permission-scope-label" title="Project root — available in every conversation">All conversations</span>`;
    } else if (d.mode === 'edit') {
      row.className = 'pattern-row editing';
      row.innerHTML = `
        <path-input dirs-only class="path-edit-input" value="${escapeHtml(p)}" data-old-path="${escapeHtml(d.key)}" placeholder="${escapeHtml(p)}"></path-input>
        <button class="pattern-save-btn path-save-btn" data-old-path="${escapeHtml(d.key)}" title="Save">Save</button>
        <button class="pattern-cancel-btn path-cancel-btn" title="Cancel">Cancel</button>`;
    } else if (d.mode === 'new') {
      row.className = 'pattern-row editing';
      row.innerHTML = `
        <path-input dirs-only class="path-edit-input" placeholder="e.g., ~/code/juggler" data-old-path=""></path-input>
        <button class="pattern-save-btn path-save-btn" data-old-path="" title="Save">Save</button>
        <button class="pattern-cancel-btn path-cancel-btn" title="Cancel">Cancel</button>`;
    } else {
      row.className = 'pattern-row';
      row.innerHTML = `
        <span class="pattern-text path-text" data-path-id="${escapeHtml(d.key)}" data-path="${escapeHtml(p)}"></span>
        <button class="permission-scope-btn path-scope-btn" data-path-id="${escapeHtml(d.key)}" data-scope=""></button>
        <button class="pattern-delete-btn path-delete-btn icon-btn" data-path-id="${escapeHtml(d.key)}" title="Delete"><span class="icon-trashcan"></span></button>`;
      this._updatePathRow(row, d);
    }
    return row;
  }

  /**
   * Sync a display path row's mutable fields (path text, scope) in place,
   * leaving the node — and the scroll position — untouched. Editor rows hold
   * live user input and are never touched here.
   * @param {HTMLElement} row existing row element
   * @param {{mode: string, path?: string, scope?: string}} d descriptor
   * @private
   */
  _updatePathRow(row, d) {
    if (d.mode !== 'display') return;
    const p = d.path || '';
    const text = row.querySelector('.path-text');
    if (text) {
      if (text.textContent !== p) text.textContent = p;
      if (text.getAttribute('data-path') !== p) text.setAttribute('data-path', p);
    }
    const scopeBtn = row.querySelector('.path-scope-btn');
    if (scopeBtn) {
      const scope = d.scope || 'conversation';
      const label = scope === 'session' ? 'All conversations' : 'This conversation';
      if (scopeBtn.getAttribute('data-scope') !== scope) scopeBtn.setAttribute('data-scope', scope);
      if (scopeBtn.textContent !== label) scopeBtn.textContent = label;
    }
  }

  /**
   * Reconcile the rendered path rows against {@link _desiredPathRows} by key:
   * update rows whose data changed, insert new ones, remove deleted ones, and
   * reorder in place. Untouched rows keep their DOM nodes, so a one-row change
   * (scope toggle, delete, peer sync) never resets the list's scroll to top.
   * @param {HTMLElement} listEl the `.paths-list` container
   * @param {Array<{id: string, path: string, scope?: string, implicit?: boolean}>} pathEntries ordered entries
   * @private
   */
  _reconcilePathRows(listEl, pathEntries) {
    const desired = this._desiredPathRows(pathEntries);

    let placeholder = listEl.querySelector('.no-patterns');
    if (desired.length === 0) {
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'no-patterns';
        placeholder.textContent = 'No paths configured';
        listEl.appendChild(placeholder);
      }
    } else if (placeholder) {
      placeholder.remove();
    }

    /** @type {Map<string, HTMLElement>} */
    const existing = new Map();
    for (const el of Array.from(listEl.querySelectorAll('.pattern-row'))) {
      existing.set(/** @type {HTMLElement} */ (el).dataset.key || '', /** @type {HTMLElement} */ (el));
    }

    const seen = new Set();
    /** @type {ChildNode | null} */
    let cursor = null;
    for (const d of desired) {
      let row = existing.get(d.key);
      if (!row || row.dataset.mode !== d.mode) {
        const fresh = this._buildPathRow(d);
        if (row) row.replaceWith(fresh); else listEl.appendChild(fresh);
        row = fresh;
      } else {
        this._updatePathRow(row, d);
      }
      seen.add(d.key);
      /** @type {ChildNode | null} */
      const ref = cursor ? cursor.nextSibling : listEl.firstChild;
      if (ref !== row) listEl.insertBefore(row, ref);
      cursor = row;
    }
    for (const [key, el] of existing) {
      if (!seen.has(key)) el.remove();
    }
  }

  /**
   * Delegated click handler for the paths list container.
   * @param {Event} e click event
   * @private
   */
  _onPathsListClick(e) {
    const mt = this.messageThread;
    if (!mt) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const textEl = target.closest('.path-text');
    if (textEl) {
      e.stopPropagation();
      const id = textEl.getAttribute('data-path-id') || textEl.getAttribute('data-path') || '';
      this.editingPath = id;
      this.editingNewPath = false;
      this._renderAllowedPaths();
      return;
    }
    const delBtn = target.closest('.path-delete-btn');
    if (delBtn) {
      e.stopPropagation();
      const p = delBtn.getAttribute('data-path-id') || delBtn.getAttribute('data-path');
      if (p) mt.removeAllowedPath(p);
      return;
    }
    const scopeBtn = target.closest('.path-scope-btn');
    if (scopeBtn) {
      e.stopPropagation();
      const id = scopeBtn.getAttribute('data-path-id');
      const scope = scopeBtn.getAttribute('data-scope') === 'session' ? 'conversation' : 'session';
      if (id) mt.setAllowedPathScope(id, scope);
      return;
    }
    const saveBtn = target.closest('.path-save-btn');
    if (saveBtn) {
      e.stopPropagation();
      const row = saveBtn.closest('.pattern-row');
      const pathInput = /** @type {any} */ (row && row.querySelector('.path-edit-input'));
      if (!pathInput) return;
      const value = typeof pathInput.value === 'string' ? pathInput.value : '';
      this._saveAllowedPath(saveBtn.getAttribute('data-old-path') || '', value);
      return;
    }
    const cancelBtn = target.closest('.path-cancel-btn');
    if (cancelBtn) {
      e.stopPropagation();
      this._endPathEditing();
    }
  }

  /**
   * Delegated keydown handler for the inline path editor. Enter saves, Escape
   * cancels. When the `<path-input>` completion menu is open it consumes these
   * keys itself (accept/close) and calls `preventDefault`, so we skip those to
   * avoid saving mid-completion.
   * @param {KeyboardEvent} e keydown event
   * @private
   */
  _onPathsListKeydown(e) {
    if (e.defaultPrevented) return;
    const pathInput = /** @type {any} */ (/** @type {HTMLElement} */ (e.target).closest('.path-edit-input'));
    if (!pathInput) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = pathInput.closest('.pattern-row');
      const saveBtn = row && row.querySelector('.path-save-btn');
      const value = typeof pathInput.value === 'string' ? pathInput.value : '';
      this._saveAllowedPath(saveBtn ? saveBtn.getAttribute('data-old-path') || '' : '', value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._endPathEditing();
    }
  }

  /**
   * @param {string} oldPath
   * @param {string} value
   * @private
   */
  _saveAllowedPath(oldPath, value) {
    const mt = this.messageThread;
    if (!mt) return;
    const normalized = (value || '').trim();
    if (!normalized) {
      this._endPathEditing();
      return;
    }
    // Clear edit state *before* the Yjs write so the metadata observer's
    // re-render sees the post-edit state and rebuilds in display mode.
    this.editingPath = '';
    this.editingNewPath = false;
    this._pathRenderPending = false;
    if (oldPath) {
      mt.updateAllowedPath(oldPath, normalized);
    } else {
      mt.addAllowedPath(normalized, { scope: 'session' });
    }
    // The metadata observer's _renderAllowedPaths() already ran.
  }
}

customElements.define('permission-controls', PermissionControls);

export { PermissionControls };
