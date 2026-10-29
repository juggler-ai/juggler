//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP tools' section of the permissions popup: one row per saved grant
 * (`server/tool`, `server/#readonly`, `server/*`), each with its scope — this
 * conversation or all of them — and a delete button. Grants are only ever
 * created from the approval dialog, so there is no add or edit here.
 *
 * The rows reuse the shell-pattern section's markup classes, so the two lists
 * look alike. The section observes the conversation's and the session's rule
 * stores and re-renders on any change.
 * @module juggler-mcp/context-items/permission-section
 */

import { translator } from 'juggler/i18n';

const t = translator('@juggler/mcp');

const ITEM_TYPE = 'mcp-tool';

/**
 * How a grant's rule value is named in the popup. Pure — exported for unit
 * testing.
 * @param {string} value - A glob rule value: `server/tool`, `server/#readonly` or `server/*`
 * @returns {string} The row label
 */
function mcpGrantLabel(value) {
  const slash = value.indexOf('/');
  if (slash < 0) return value;
  const server = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (rest === '*') return t('{server}: all tools', { server });
  if (rest === '#readonly') return t('{server}: all read-only tools', { server });
  return t('{server}: {tool}', { server, tool: rest });
}

/**
 * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread - Owning thread
 * @returns {{id: string, title: string, element: HTMLElement, dispose: () => void}|null} Permission section, or null with no grants
 */
export function renderMcpPermissionSection(messageThread) {
  const rules = () => messageThread.getRulesFor(ITEM_TYPE).filter((r) => r.kind === 'glob');
  if (!rules().length) return null;

  const section = document.createElement('section');
  section.className = 'permission-section permission-section-mcp';
  section.dataset.itemType = ITEM_TYPE;
  const list = document.createElement('div');
  list.className = 'patterns-list';
  section.appendChild(list);

  /** Rebuild the rows from the current rules. */
  function render() {
    list.replaceChildren();
    const current = rules();
    if (!current.length) {
      const empty = document.createElement('div');
      empty.className = 'no-patterns';
      empty.textContent = t('No MCP tools approved');
      list.appendChild(empty);
      return;
    }
    for (const r of current) {
      const scope = r.scope || 'conversation';
      const row = document.createElement('div');
      row.className = 'pattern-row';
      row.dataset.key = r.id;
      const text = document.createElement('span');
      text.className = 'pattern-text';
      text.textContent = mcpGrantLabel(String(r.value));
      const scopeBtn = document.createElement('button');
      scopeBtn.className = 'permission-scope-btn rule-scope-btn';
      scopeBtn.dataset.ruleId = r.id;
      scopeBtn.dataset.scope = scope;
      scopeBtn.textContent = scope === 'session' ? t('All conversations') : t('This conversation');
      const del = document.createElement('button');
      del.className = 'pattern-delete-btn icon-btn';
      del.dataset.ruleId = r.id;
      del.title = t('Delete');
      const icon = document.createElement('span');
      icon.className = 'icon-trashcan';
      del.appendChild(icon);
      row.append(text, scopeBtn, del);
      list.appendChild(row);
    }
  }

  list.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const scopeBtn = /** @type {HTMLElement|null} */ (target.closest('.rule-scope-btn'));
    if (scopeBtn?.dataset.ruleId) {
      e.stopPropagation();
      messageThread.setRuleScope(scopeBtn.dataset.ruleId, scopeBtn.dataset.scope === 'session' ? 'conversation' : 'session');
      render();
      return;
    }
    const del = /** @type {HTMLElement|null} */ (target.closest('.pattern-delete-btn'));
    if (del?.dataset.ruleId) {
      e.stopPropagation();
      messageThread.removeRule(del.dataset.ruleId);
      render();
    }
  });

  /** @param {{keysChanged: Set<string>}} event - The metadata map's change event */
  const observer = (event) => {
    if (event.keysChanged.has('permissionRules') || event.keysChanged.has('conversationPermissionRules')) render();
  };
  messageThread.conversation.observeMetadata(observer);
  const sessionUnsubscribe = messageThread.conversation.session?.subscribe?.((evt) => {
    if (evt.type === 'session:metadata-changed' && (evt.data?.keys || []).includes('sessionPermissionRules')) render();
  }) || null;

  render();
  return {
    id: ITEM_TYPE,
    title: t('MCP tools approved'),
    element: section,
    dispose: () => {
      messageThread.conversation.unobserveMetadata(observer);
      sessionUnsubscribe?.();
    }
  };
}
