//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0


/**
 * Bash plugin's permission-controls UI fragment.
 *
 * Returns a self-contained `<section>` element that lets the user manage the
 * conversation's shell command patterns. The section observes the
 * conversation's Yjs metadata directly and re-renders on rule changes —
 * the host shell wires nothing further.
 *
 * Rules with `itemType === 'execute'` and `kind === 'glob'` are presented as
 * a list with inline editing and a delete icon. A rule's mere presence means
 * it is active; to remove a pattern the user deletes it.
 * @module juggler-core/context-items/execute/permission-section
 */

import { translator } from 'juggler/i18n';
import { escapeHtml } from 'juggler/ui';

const t = translator('@juggler/core');

const ITEM_TYPE = 'execute';

/**
 * @param {import('../../../../js/model/message-thread.js').MessageThread} messageThread Owning thread
 * @returns {{id: string, title: string, element: HTMLElement, dispose: () => void}} Permission section
 */
export function renderExecutePermissionSection(messageThread) {
  const section = document.createElement('section');
  section.className = 'permission-section permission-section-execute';
  section.dataset.itemType = ITEM_TYPE;

  /** @type {string} */
  let editingId = '';     // id of the rule currently being edited, '' if none
  let editingNew = false; // true if the user is adding a brand-new rule
  /** @type {string[]} stable row order while this popup instance is mounted */
  let visibleOrder = [];

  /** @returns {boolean} true if an inline editor is currently open */
  function isEditing() {
    return editingId !== '' || editingNew;
  }

  /**
   * Drop out of editing mode and flush any deferred re-render. Call from
   * every code path that closes an editor (save, cancel, Escape, blur-save).
   */
  function endEditing() {
    editingId = '';
    editingNew = false;
    render();
  }

  /** @returns {import('../../../../js/model/message-thread-permissions.js').PermissionRule[]} Glob rules for this plugin */
  function rules() {
    const current = messageThread.getRulesFor(ITEM_TYPE).filter(r => r.kind === 'glob');
    const byId = new Map(current.map(r => [r.id, r]));
    visibleOrder = visibleOrder.filter(id => byId.has(id));
    for (const r of current) if (!visibleOrder.includes(r.id)) visibleOrder.push(r.id);
    return /** @type {import('../../../../js/model/message-thread-permissions.js').PermissionRule[]} */ (visibleOrder
      .map(id => byId.get(id))
      .filter((/** @type {any} */ r) => !!r));
  }

  /**
   * The rows the list should currently show, in display order. Each carries a
   * stable `key` (rule id, or a sentinel for the new-rule editor) so the
   * reconciler can match it against the DOM that's already there.
   * @returns {Array<{key: string, mode: 'display'|'edit'|'new', value?: string, scope?: string}>} ordered row descriptors
   */
  function desiredRows() {
    const out = rules().map(r => ({
      key: r.id,
      mode: editingId === r.id ? 'edit' : 'display',
      value: String(r.value),
      scope: r.scope || 'conversation'
    }));
    if (editingNew) out.push({ key: '__new__', mode: 'new', value: '', scope: 'conversation' });
    return /** @type {Array<{key: string, mode: 'display'|'edit'|'new', value?: string, scope?: string}>} */ (out);
  }

  /**
   * Build a fresh row element for a descriptor. Listeners are delegated on the
   * list container, so the row itself carries none.
   * @param {{key: string, mode: string, value?: string, scope?: string}} d descriptor
   * @returns {HTMLElement} row element
   */
  function buildRow(d) {
    const row = document.createElement('div');
    row.dataset.key = d.key;
    row.dataset.mode = d.mode;
    const saveHtml = escapeHtml(t('Save'));
    const cancelHtml = escapeHtml(t('Cancel'));
    if (d.mode === 'display') {
      row.className = 'pattern-row';
      row.innerHTML = `
        <span class="pattern-text" data-rule-id="${escapeHtml(d.key)}"></span>
        <button class="btn btn-xs btn-secondary permission-scope-btn rule-scope-btn" data-rule-id="${escapeHtml(d.key)}" data-scope=""></button>
        <button class="btn btn-icon btn-danger-quiet pattern-delete-btn" data-rule-id="${escapeHtml(d.key)}" title="${escapeHtml(t('Delete'))}"><span class="icon-trashcan"></span></button>`;
      updateRow(row, d);
    } else if (d.mode === 'edit') {
      row.className = 'pattern-row editing';
      row.innerHTML = `
        <input type="text" class="pattern-edit-input field-input field-input-sm" data-rule-id="${escapeHtml(d.key)}" autocorrect="off" autocapitalize="off" spellcheck="false">
        <button class="btn btn-xs btn-secondary pattern-save-btn" data-rule-id="${escapeHtml(d.key)}" title="${saveHtml}">${saveHtml}</button>
        <button class="btn btn-xs btn-secondary pattern-cancel-btn" title="${cancelHtml}">${cancelHtml}</button>`;
      /** @type {HTMLInputElement} */ (row.querySelector('.pattern-edit-input')).value = d.value || '';
    } else {
      // i18n-ignore: an example command pattern, not words
      const example = 'npm *';
      row.className = 'pattern-row editing';
      row.innerHTML = `
        <input type="text" class="pattern-edit-input field-input field-input-sm" placeholder="${escapeHtml(t('e.g., {example}', { example }))}" data-rule-id="" autocorrect="off" autocapitalize="off" spellcheck="false">
        <button class="btn btn-xs btn-secondary pattern-save-btn" data-rule-id="" title="${saveHtml}">${saveHtml}</button>
        <button class="btn btn-xs btn-secondary pattern-cancel-btn" title="${cancelHtml}">${cancelHtml}</button>`;
    }
    return row;
  }

  /**
   * Sync a display row's mutable fields (pattern text, scope) in place, leaving
   * the node — and the scroll position — untouched. Editor rows hold live user
   * input and are never touched here.
   * @param {HTMLElement} row existing row element
   * @param {{mode: string, value?: string, scope?: string}} d descriptor
   */
  function updateRow(row, d) {
    if (d.mode !== 'display') return;
    const text = row.querySelector('.pattern-text');
    if (text && text.textContent !== d.value) text.textContent = d.value || '';
    const scopeBtn = row.querySelector('.rule-scope-btn');
    if (scopeBtn) {
      const scope = d.scope || 'conversation';
      const label = scope === 'session' ? t('All conversations') : t('This conversation');
      if (scopeBtn.getAttribute('data-scope') !== scope) scopeBtn.setAttribute('data-scope', scope);
      if (scopeBtn.textContent !== label) scopeBtn.textContent = label;
    }
  }

  /**
   * Reconcile the rendered rows against {@link desiredRows} by key: update rows
   * whose data changed, insert new ones, remove deleted ones, and reorder in
   * place. Untouched rows keep their DOM nodes, so a one-row change (scope
   * toggle, delete, peer sync) never resets the list's scroll to the top.
   */
  function reconcileRows() {
    const listEl = /** @type {HTMLElement | null} */ (section.querySelector('.patterns-list'));
    if (!listEl) return;
    const desired = desiredRows();

    let placeholder = listEl.querySelector('.no-patterns');
    if (desired.length === 0) {
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'no-patterns';
        placeholder.textContent = t('No shell patterns configured');
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
        const fresh = buildRow(d);
        if (row) row.replaceWith(fresh); else listEl.appendChild(fresh);
        row = fresh;
      } else {
        updateRow(row, d);
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

  let skeletonBuilt = false;

  /** Build the static chrome (list container + add button) once and wire delegated listeners. */
  function buildSkeleton() {
    section.innerHTML = `
      <div class="patterns-list"></div>
      <div class="add-pattern-row">
        <button class="add-pattern-btn">${escapeHtml(t('+ Add pattern'))}</button>
      </div>
    `;
    const listEl = /** @type {HTMLElement} */ (section.querySelector('.patterns-list'));
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('keydown', onListKeydown);
    const addBtn = section.querySelector('.add-pattern-btn');
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editingId = '';
      editingNew = true;
      render();
    });
  }

  /**
   * Delegated click handler for the list container.
   * @param {Event} e click event
   */
  function onListClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const textEl = target.closest('.pattern-text');
    if (textEl) {
      e.stopPropagation();
      const id = textEl.getAttribute('data-rule-id');
      if (!id) return;
      editingId = id;
      editingNew = false;
      render();
      return;
    }
    const delBtn = target.closest('.pattern-delete-btn');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.getAttribute('data-rule-id');
      if (id) messageThread.removeRule(id);
      return;
    }
    const scopeBtn = target.closest('.rule-scope-btn');
    if (scopeBtn) {
      e.stopPropagation();
      const id = scopeBtn.getAttribute('data-rule-id');
      const scope = scopeBtn.getAttribute('data-scope') === 'session' ? 'conversation' : 'session';
      if (id) messageThread.setRuleScope(id, scope);
      return;
    }
    const saveBtn = target.closest('.pattern-save-btn');
    if (saveBtn) {
      e.stopPropagation();
      const id = saveBtn.getAttribute('data-rule-id') || '';
      const row = saveBtn.closest('.pattern-row');
      const input = /** @type {HTMLInputElement | null} */ (row && row.querySelector('.pattern-edit-input'));
      if (input) savePattern(id, input.value);
      return;
    }
    const cancelBtn = target.closest('.pattern-cancel-btn');
    if (cancelBtn) {
      e.stopPropagation();
      endEditing();
    }
  }

  /**
   * Delegated keydown handler for the inline editor input.
   * @param {KeyboardEvent} e keydown event
   */
  function onListKeydown(e) {
    const input = /** @type {HTMLInputElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.pattern-edit-input'));
    if (!input) return;
    if (e.key === 'Enter') savePattern(input.getAttribute('data-rule-id') || '', input.value);
    else if (e.key === 'Escape') endEditing();
  }

  /** Re-render the section in place via keyed row reconciliation. */
  function render() {
    if (!skeletonBuilt) { buildSkeleton(); skeletonBuilt = true; }
    reconcileRows();
    focusEditor();
  }

  /** Focus the inline editor input after a render that opened it. */
  function focusEditor() {
    if (!editingId && !editingNew) return;
    requestAnimationFrame(() => {
      const input = /** @type {HTMLInputElement | null} */ (section.querySelector('.pattern-edit-input'));
      if (input) { input.focus(); input.select(); }
    });
  }

  /**
   * @param {string} id Rule id, or '' to create a new rule
   * @param {string} value New pattern text
   */
  function savePattern(id, value) {
    const normalized = (value || '').trim();
    if (!normalized) {
      endEditing();
      return;
    }
    // Clear edit state *before* the Yjs write so the observer's re-render
    // (which fires synchronously inside the write) sees the post-edit state
    // and rebuilds the row in display mode rather than restoring the editor.
    editingId = '';
    editingNew = false;
    if (id) {
      messageThread.updateRule(id, { value: normalized });
    } else {
      messageThread.addRule(ITEM_TYPE, { kind: 'glob', value: normalized, scope: 'session' });
    }
    // The metadata observer's render() already ran.
  }

  // Observe Yjs metadata for external changes (peer sync, undo/redo). While
  // an inline editor is open we defer the re-render to endEditing(), so that
  // a concurrent peer change doesn't blow away the user's half-typed input.
  // Teardown is the host shell's responsibility via `dispose()` below.
  /** @param {any} event */
  const observer = (event) => {
    if (!event.keysChanged.has('permissionRules') && !event.keysChanged.has('conversationPermissionRules')) return;
    if (isEditing()) return; // defer; endEditing() re-renders on close
    render();
  };
  messageThread.conversation.observeMetadata(observer);
  const sessionUnsubscribe = messageThread.conversation.session?.subscribe?.((/** @type {any} */ evt) => {
    if (evt.type !== 'session:metadata-changed') return;
    const keys = evt.data?.keys || [];
    if (!keys.includes('sessionPermissionRules')) return;
    if (isEditing()) return; // defer; endEditing() re-renders on close
    render();
  }) || null;

  render();
  return {
    id: ITEM_TYPE,
    title: t('Shell command patterns'),
    element: section,
    dispose: () => {
      messageThread.conversation.unobserveMetadata(observer);
      sessionUnsubscribe?.();
    }
  };
}
