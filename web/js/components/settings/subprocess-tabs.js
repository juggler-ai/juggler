//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

/**
 * The "MCP servers" and "ACP agents" settings tabs. Both manage the same shape —
 * a scope-keyed map of {command, args, env, enabled} subprocess entries — so they
 * share the generic {@link ConfigTabController} (from config-tab.js) and differ
 * only in a small per-tab spec plus a thin wrapper that owns lifecycle. The MCP
 * wrapper additionally live-refreshes off the `plugin-changed` broadcast while
 * visible; the ACP wrapper auto-enables the ACP provider after a successful save.
 * @module components/settings/subprocess-tabs
 */

import wsService from '../../services/websocket.js';
import { setProviderEnabled } from '../../services/settings-api.js';
import {
  mcpListServers,
  mcpGetConfig,
  mcpSetConfig,
  mcpServerControl,
  mcpTrustServer,
  mcpGetLog,
  mcpListTools,
  acpListAgents,
  acpGetConfig,
  acpSetConfig,
} from '../../services/ops-api.js';
import { ConfigTabController, makeNameValidator } from '../config-tab.js';
import { isMcpExtensionDisabled, MCP_DISABLED_NOTICE } from '../../services/mcp-availability.js';
import { t, markForTranslation, formatList } from '../../../sdk/lib/i18n.js';

/** Polling interval (ms) for refreshing the MCP servers tab while it's open. */
const MCP_POLL_MS = 2000;

/** Polling interval (ms) for refreshing the ACP agents tab while it's open. */
const ACP_POLL_MS = 3000;

/**
 * Format an MCP server's tool count and schema-token cost as a short one-liner,
 * e.g. "3 tools · ~1.2k tokens/request" or "1 tool". The token clause is dropped
 * when the server reports zero schema tokens (e.g. before discovery completes).
 * @param {{toolCount?: number, schemaTokens?: number}} status - A McpServerStatus
 * @returns {string} The formatted "N tools · ~Xk tokens/request" summary.
 */
export function formatMcpTokenCost(status) {
  const n = (status && status.toolCount) || 0;
  const schema = (status && status.schemaTokens) || 0;
  const tokens = schema >= 1000 ? `${(schema / 1000).toFixed(1)}k` : String(schema);
  return schema
    ? t('{count, plural, one {# tool} other {# tools}} · ~{tokens} tokens/request', { count: n, tokens })
    : t('{count, plural, one {# tool} other {# tools}}', { count: n });
}

/**
 * The MCP-only working-state fields the add/edit form carries alongside the
 * generic ones (command/args/url/…). Seeded by {@link mcpSeedFormExtra}.
 * @typedef {object} McpFormState
 * @property {string} [name] - Server name (set by the generic controller)
 * @property {string} [mode] - 'add' | 'edit' (set by the generic controller)
 * @property {string[]|null} toolAllow - Seeded allowlist, or null when none configured
 * @property {string[]} toolDeny - Seeded denylist
 * @property {string} defaultArgsText - Fixed-arguments JSON as edited text
 * @property {boolean} toolsLoaded - Whether the live tool list has been fetched
 * @property {boolean} toolsLoading - Whether a fetch is in flight
 * @property {string[]} toolNames - Discovered raw tool names (once loaded)
 * @property {Record<string, boolean>} toolChecked - Per-tool exposed/hidden state
 * @property {boolean} autoApprove - Whether the server's tool calls are pre-approved
 * @property {'global'|'project'} [scope] - Which mcp.json the entry lives in (set by the generic controller)
 */

/**
 * Whether a tool name is exposed under a {allow, deny} filter, mirroring the
 * Go `ToolFilter.allowsTool` semantics: a non-empty allow list is strict, then
 * deny subtracts. Pure — exported for unit testing.
 * @param {string} name - Raw MCP tool name
 * @param {{allow?: string[]|null, deny?: string[]}} filter - The filter
 * @returns {boolean} True when the tool is exposed
 */
export function mcpToolAllowed(name, filter) {
  const allow = filter && filter.allow;
  const deny = (filter && filter.deny) || [];
  if (Array.isArray(allow) && allow.length && !allow.includes(name)) return false;
  if (deny.includes(name)) return false;
  return true;
}

/**
 * Seed the MCP form's extra working state from a stored server entry. `toolAllow`
 * is null when no allowlist is configured (all tools exposed); `defaultArgsText`
 * is the pretty-printed JSON of the fixed arguments.
 * @param {import('../config-tab.js').SubprocessConfig} cfg - Stored entry (or {} when adding)
 * @returns {McpFormState} Extra working-state fields
 */
export function mcpSeedFormExtra(cfg) {
  const tools = (cfg && cfg.tools) || {};
  const args = (cfg && cfg.defaultArguments) || {};
  return {
    toolAllow: Array.isArray(tools.allow) ? tools.allow.slice() : null,
    toolDeny: Array.isArray(tools.deny) ? tools.deny.slice() : [],
    defaultArgsText: Object.keys(args).length ? JSON.stringify(args, null, 2) : '',
    toolsLoaded: false,
    toolsLoading: false,
    toolNames: [],
    toolChecked: {},
    autoApprove: !!(cfg && cfg.autoApprove),
  };
}

/**
 * Build the `{tools, defaultArguments, autoApprove}` keys to persist from the MCP
 * form's working state. When the live tool list was loaded, the checkbox state
 * drives an allowlist (omitted entirely when every tool is checked). When it was
 * never loaded (adding, or server offline), the seeded filter is preserved
 * verbatim so an unreachable server's config is never silently rewritten.
 * `autoApprove` is written for a global entry only: the Go manager ignores it in
 * a project's mcp.json. Throws on malformed fixed-arguments JSON. Pure —
 * exported for unit testing.
 * @param {McpFormState} f - The form working state
 * @returns {{tools?: {allow?: string[], deny?: string[]}, defaultArguments?: object, autoApprove?: true}} Extra entry keys
 */
export function mcpFormToConfigExtra(f) {
  /** @type {{tools?: {allow?: string[], deny?: string[]}, defaultArguments?: object, autoApprove?: true}} */
  const out = {};
  if (f.autoApprove && (f.scope || 'global') === 'global') out.autoApprove = true;

  if (f.toolsLoaded) {
    const checked = (f.toolNames || []).filter((n) => f.toolChecked[n]);
    if (checked.length < (f.toolNames || []).length) {
      out.tools = { allow: checked };
    }
    // Every tool checked ⇒ omit `tools` (expose all).
  } else {
    /** @type {{allow?: string[], deny?: string[]}} */
    const tools = {};
    if (Array.isArray(f.toolAllow)) tools.allow = f.toolAllow;
    if (Array.isArray(f.toolDeny) && f.toolDeny.length) tools.deny = f.toolDeny;
    if (Object.keys(tools).length) out.tools = tools;
  }

  const text = (f.defaultArgsText || '').trim();
  if (text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(t('Fixed arguments must be valid JSON.'));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(t('Fixed arguments must be a JSON object.'));
    }
    if (Object.keys(parsed).length) out.defaultArguments = parsed;
  }
  return out;
}

/**
 * Render the MCP-only form section: per-tool visibility checkboxes and a
 * fixed-arguments JSON field. Fetches the server's live tool list once (edit of a
 * running server); on add or when offline it shows a hint and leaves the seeded
 * filter untouched. Kept out of the generic controller via the renderFormExtra
 * spec hook. Exported for unit testing.
 * @param {McpFormState} f - Form working state
 * @param {HTMLElement} wrap - Form element to append to
 * @param {import('../config-tab.js').ConfigTabController} ctrl - Owning controller (for re-render)
 * @returns {void}
 */
export function renderMcpFormExtra(f, wrap, ctrl) {
  // --- Tools section ---
  const toolsField = document.createElement('div');
  toolsField.className = 'mcp-form-field';
  const toolsLabel = document.createElement('label');
  toolsLabel.className = 'mcp-field-label';
  toolsLabel.textContent = t('Tools');
  toolsField.appendChild(toolsLabel);

  if (f.mode === 'add' || !f.name) {
    toolsField.appendChild(mcpHint(t('Save the server first, then edit it to choose which tools are exposed. New servers expose all tools.')));
  } else if (f.toolsLoaded) {
    const names = f.toolNames || [];
    if (!names.length) {
      toolsField.appendChild(mcpHint(t('No tools discovered yet — the server may be stopped or still connecting. All tools stay exposed until you pick.')));
    } else {
      const enabled = names.filter((n) => f.toolChecked[n]).length;
      const summary = document.createElement('div');
      summary.className = 'mcp-field-hint';
      summary.textContent = t('{enabled} / {total} tools enabled. Unchecked tools are hidden from the model and cannot be called.', { enabled, total: names.length });
      toolsField.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'mcp-tool-filter-list';
      for (const name of names) {
        list.appendChild(mcpToolRow(f, name, ctrl));
      }
      toolsField.appendChild(list);

      // Warn about configured names no longer offered by the server.
      const configured = [...(f.toolAllow || []), ...(f.toolDeny || [])];
      const unknown = configured.filter((n) => !names.includes(n));
      if (unknown.length) {
        toolsField.appendChild(mcpHint(t('Config references tools not offered by this server: {names}. They will be dropped on save.', { names: formatList(unknown) })));
      }
    }
  } else {
    toolsField.appendChild(mcpHint(t('Loading tools…')));
    if (!f.toolsLoading) {
      f.toolsLoading = true;
      mcpListTools({ server: f.name })
        .then((res) => {
          if (ctrl.editing !== f) return; // form closed or switched
          const tools = Array.isArray(res && res.tools) ? res.tools : [];
          f.toolNames = tools.map((tool) => tool.name);
          f.toolChecked = {};
          for (const n of f.toolNames) {
            f.toolChecked[n] = mcpToolAllowed(n, { allow: f.toolAllow, deny: f.toolDeny });
          }
          f.toolsLoaded = true;
          f.toolsLoading = false;
          ctrl.render();
        })
        .catch(() => {
          if (ctrl.editing !== f) return;
          f.toolNames = [];
          f.toolsLoaded = true;
          f.toolsLoading = false;
          ctrl.render();
        });
    }
  }
  wrap.appendChild(toolsField);

  // --- Fixed arguments section ---
  const argsField = document.createElement('div');
  argsField.className = 'mcp-form-field';
  const argsLabel = document.createElement('label');
  argsLabel.className = 'mcp-field-label';
  argsLabel.textContent = t('Fixed arguments');
  argsField.appendChild(argsLabel);
  const ta = document.createElement('textarea');
  ta.className = 'mcp-input field-input field-input-sm mcp-default-args-input';
  ta.rows = 4;
  ta.placeholder = '{\n  "bank_id": "general"\n}'; // i18n-ignore: example JSON
  ta.value = f.defaultArgsText || '';
  ta.addEventListener('input', () => { f.defaultArgsText = ta.value; });
  argsField.appendChild(ta);
  argsField.appendChild(mcpHint(t('A JSON object merged into every call to this server and hidden from the model. The configured value overrides anything the model supplies — use it to fix routing keys.')));
  wrap.appendChild(argsField);

  // --- Pre-approval section ---
  // A project's mcp.json can come with a cloned repository, so the Go manager
  // honours this only from the global file. A project server gets a hint
  // instead of a checkbox that would be saved and never obeyed. While adding,
  // the scope selector (rendered above, in the same form) re-renders the form so
  // this follows it; mcpFormToConfigExtra drops the flag for a project entry
  // at save regardless.
  const scopeSelect = wrap.querySelector('.mcp-scope-input');
  if (scopeSelect && f.mode !== 'edit') {
    scopeSelect.addEventListener('change', () => {
      ctrl._syncFormState();
      ctrl.render();
    });
  }
  const approveField = document.createElement('div');
  approveField.className = 'mcp-form-field';
  const approveLabel = document.createElement('label');
  approveLabel.className = 'mcp-field-label';
  approveLabel.textContent = t('Approval');
  approveField.appendChild(approveLabel);
  if (f.scope === 'project') {
    approveField.appendChild(mcpHint(t('Every call asks first. Only a global server can be pre-approved, so a project’s own mcp.json cannot switch its approval off.')));
  } else {
    const row = document.createElement('label');
    row.className = 'mcp-tool-filter-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'mcp-auto-approve-input';
    cb.checked = !!f.autoApprove;
    cb.addEventListener('change', () => { f.autoApprove = cb.checked; });
    const text = document.createElement('span');
    text.textContent = t('Pre-approve this server’s tools');
    row.appendChild(cb);
    row.appendChild(text);
    approveField.appendChild(row);
    approveField.appendChild(mcpHint(t('Its tools run without asking, in every conversation. Global servers only.')));
  }
  wrap.appendChild(approveField);
}

/**
 * One tool checkbox row for the visibility filter.
 * @param {McpFormState} f - Form working state
 * @param {string} name - Raw tool name
 * @param {import('../config-tab.js').ConfigTabController} ctrl - Owning controller
 * @returns {HTMLElement} The row element
 */
function mcpToolRow(f, name, ctrl) {
  const row = document.createElement('label');
  row.className = 'mcp-tool-filter-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'mcp-tool-filter-cb';
  cb.checked = !!f.toolChecked[name];
  cb.addEventListener('change', () => {
    f.toolChecked[name] = cb.checked;
    ctrl.render(); // refresh the "N / M enabled" summary
  });
  const text = document.createElement('span');
  text.className = 'mcp-tool-filter-name';
  text.textContent = name;
  row.appendChild(cb);
  row.appendChild(text);
  return row;
}

/**
 * A small hint line reusing the form's hint styling.
 * @param {string} text - Hint text
 * @returns {HTMLElement} The hint element
 */
function mcpHint(text) {
  const hint = document.createElement('div');
  hint.className = 'mcp-field-hint';
  hint.textContent = text;
  return hint;
}

/**
 * How a status is named on a row's status dot, keyed by the status value the
 * MCP manager and ACP ops report. A value missing here is shown as it came.
 * @type {Record<string, string>}
 */
const STATUS_LABELS = {
  running: markForTranslation('running'),
  starting: markForTranslation('starting'),
  stopped: markForTranslation('stopped'),
  failed: markForTranslation('failed'),
  untrusted: markForTranslation('not trusted'),
  available: markForTranslation('available'),
  unavailable: markForTranslation('unavailable'),
  disabled: markForTranslation('disabled'),
};

/**
 * A status value as the dot's tooltip shows it.
 * @param {string} status - The reported status
 * @returns {string} Its translated name, or the value itself when unknown
 */
function statusLabel(status) {
  const label = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : '';
  return label ? t(label) : status;
}

/**
 * Validate a proposed MCP server name. Names become part of the LLM tool id
 * (`mcp__<name>__<tool>`), so "juggler" is reserved for the built-in CLI bridge.
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateMcpServerName = makeNameValidator({
  duplicateMsg: markForTranslation('A server named "{name}" already exists in this scope.'),
  reserved: 'juggler',
  reservedMsg: markForTranslation('"juggler" is reserved for the built-in tools.'),
});

/**
 * Validate a proposed ACP agent name. Names become the model id under the ACP
 * provider — not a tool prefix — so no word is reserved (unlike MCP).
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateAcpAgentName = makeNameValidator({
  duplicateMsg: markForTranslation('An agent named "{name}" already exists in this scope.'),
});

/**
 * Map an ACP agent's status string to the shared MCP status-dot CSS class
 * (reused for visual consistency): available→running (green), unavailable→
 * failed (red), disabled→stopped (grey).
 * @param {string} status
 * @returns {'running'|'failed'|'stopped'} The dot class suffix.
 */
export function acpDotClass(status) {
  if (status === 'available') return 'running';
  if (status === 'unavailable') return 'failed';
  return 'stopped';
}

/**
 * Best-effort: enable the "acp" provider so a newly-added agent shows up in the
 * picker immediately — the handler queues a provider recompute, whose
 * `providers-update` broadcast reaches every model selector. Failure is
 * non-fatal: the provider can still be toggled on manually in the Provider API
 * Keys tab.
 * @returns {Promise<void>}
 */
async function ensureAcpProviderEnabled() {
  try {
    await setProviderEnabled('acp', true);
  } catch {
    // Non-fatal: the ACP provider can still be enabled manually.
  }
}

/**
 * Spec for the "MCP servers" tab: a stdio MCP server is a managed subprocess,
 * so it reports live status, supports Restart and a stderr Log disclosure, and
 * its name is a tool prefix (reserved-word validated). See {@link ConfigTabController}.
 * @type {import('../config-tab.js').ConfigTabSpec}
 */
const MCP_SPEC = {
  id: 'mcp',
  formHostSelector: '#mcp-form',
  pollMs: MCP_POLL_MS,
  loadError: markForTranslation('Failed to load MCP servers.'),
  ops: {
    list: async () => (await mcpListServers()).servers || [],
    getConfig: () => mcpGetConfig(),
    setConfig: (scope, servers) => mcpSetConfig({ scope, servers }),
    restart: (name) => mcpServerControl({ server: name, action: 'restart' }),
    trust: (name) => mcpTrustServer({ server: name }),
    getLog: async (name) => (await mcpGetLog({ server: name })).log,
  },
  addLabel: markForTranslation('Add server'),
  emptyText: markForTranslation('No MCP servers yet. Add one to give the assistant extra tools — for example a filesystem, GitHub, or database server.'),
  // The rows below report the manager's view: servers run, discover tools, and
  // show green dots whether or not anything publishes those tools to the model.
  // With the extension off, every one of them is telling the truth and the whole
  // page is still wrong, so the page says which.
  notice: async () => (await isMcpExtensionDisabled() ? MCP_DISABLED_NOTICE : ''),
  // Importer seam: an "Import from…" button slots in next to Add later.
  toolbarExtra: (toolbar) => {
    const soon = document.createElement('span');
    soon.className = 'mcp-import-soon';
    soon.textContent = t('Importing from other apps is coming soon.');
    toolbar.appendChild(soon);
  },
  validateName: validateMcpServerName,
  dotClass: (s) => s.status || 'stopped',
  dotTitle: (s) => statusLabel(s.status || 'stopped'),
  identityExtras: (s) => {
    if (!s.serverName) return null;
    const impl = document.createElement('span');
    impl.className = 'mcp-impl';
    impl.textContent = s.serverVersion ? `(${s.serverName} ${s.serverVersion})` : `(${s.serverName})`;
    return impl;
  },
  describe: (s) => formatMcpTokenCost(s),
  rowError: (s) => {
    if (s.status === 'untrusted') return t("Not started: this command comes from the project's .juggler/mcp.json. Check it, then trust it to run it.");
    return (s.status === 'failed' && s.error) ? (String(s.error).split('\n')[0] || '') : '';
  },
  deleteConfirm: (name) => ({
    message: t('Remove the MCP server "{name}"? Its tools will disappear from conversations.', { name }),
    title: t('Remove server'),
  }),
  formAddTitle: markForTranslation('Add MCP server'),
  namePlaceholder: markForTranslation('name'),
  nameHintAdd: markForTranslation('A short id — becomes the tool prefix (mcp__<name>__…). No spaces or “/”.'),
  nameHintEdit: markForTranslation('Renaming means deleting and re-adding the server.'),
  scopeHintEdit: markForTranslation('Moving scope means deleting and re-adding the server.'),
  commandPlaceholder: 'npx', // i18n-ignore: a command name
  commandHint: markForTranslation('The executable to launch (stdio transport).'),
  argFirstPlaceholder: '-y', // i18n-ignore: an example argument
  argRestPlaceholder: '@modelcontextprotocol/server-github', // i18n-ignore: an example package
  envKeyPlaceholder: 'API_TOKEN', // i18n-ignore: an example variable name
  saveFailMsg: markForTranslation('Failed to save the server.'),
  // MCP servers can be local subprocesses (stdio) or remote endpoints (http/sse).
  supportsTransport: true,
  urlPlaceholder: 'https://example.com/mcp', // i18n-ignore: an example address
  urlHint: markForTranslation('The remote MCP endpoint URL (http/sse transport).'),
  headerKeyPlaceholder: 'Authorization', // i18n-ignore: an example header name
  // Per-server tool visibility filter + fixed arguments (MCP only).
  seedFormExtra: mcpSeedFormExtra,
  renderFormExtra: renderMcpFormExtra,
  formToConfigExtra: mcpFormToConfigExtra,
};

/**
 * Spec for the "ACP agents" tab: an ACP agent is spawned per-conversation with
 * no persistent process, so status is just PATH-resolvability (no Restart/Log),
 * its name is a model id (no reserved word), and a successful save auto-enables
 * the ACP provider. See {@link ConfigTabController}.
 * @type {import('../config-tab.js').ConfigTabSpec}
 */
const ACP_SPEC = {
  id: 'acp',
  formHostSelector: '#acp-form',
  pollMs: ACP_POLL_MS,
  loadError: markForTranslation('Failed to load ACP agents.'),
  ops: {
    list: async () => (await acpListAgents()).agents || [],
    getConfig: () => acpGetConfig(),
    setConfig: (scope, agents) => acpSetConfig({ scope, agents }),
  },
  addLabel: markForTranslation('Add agent'),
  emptyText: markForTranslation('No ACP agents yet. Add one — for example Gemini CLI in ACP mode — and it will appear as a model in the picker.'),
  validateName: validateAcpAgentName,
  dotClass: (s) => acpDotClass(s.status),
  dotTitle: (s) => statusLabel(s.status || 'unavailable'),
  describe: (s) => s.command || t('(no command)'),
  rowError: (s) => (s.status === 'unavailable' && s.error) ? s.error : '',
  deleteConfirm: (name) => ({
    message: t('Remove the ACP agent "{name}"? It will disappear from the model picker.', { name }),
    title: t('Remove agent'),
  }),
  formAddTitle: markForTranslation('Add ACP agent'),
  namePlaceholder: 'gemini', // i18n-ignore: an example agent name
  nameHintAdd: markForTranslation('A short id — becomes the model name in the picker. No spaces or “/”.'),
  nameHintEdit: markForTranslation('Renaming means deleting and re-adding the agent.'),
  scopeHintEdit: markForTranslation('Moving scope means deleting and re-adding the agent.'),
  commandPlaceholder: 'gemini', // i18n-ignore: a command name
  commandHint: markForTranslation('The agent executable to launch (resolved on PATH).'),
  argFirstPlaceholder: '--experimental-acp', // i18n-ignore: an example argument
  argRestPlaceholder: markForTranslation('value'),
  envKeyPlaceholder: 'API_KEY', // i18n-ignore: an example variable name
  saveFailMsg: markForTranslation('Failed to save the agent.'),
  // Provider AutoDetect is computed once at startup (sync.Once), so it won't
  // notice an agent added mid-session; enabling the provider closes that gap.
  // Only for an enabled agent — a disabled one adds nothing to the picker.
  onAfterSave: async ({ enabled }) => { if (enabled) await ensureAcpProviderEnabled(); },
};

/**
 * "MCP servers" tab: managed stdio subprocesses (Restart + Log). Wraps a
 * {@link ConfigTabController} and, while visible, live-refreshes off the
 * `plugin-changed` broadcast — every config write / lifecycle change
 * auto-reconciles Go-side and broadcasts it, which is what flips a server
 * starting→running without the user clicking (the 2 s poll is a backstop).
 */
export class McpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, MCP_SPEC);
    /** @type {boolean} @private - True while this tab is the visible one. */
    this._visible = false;
    /** @type {(() => void)|null} @private - Drops the plugin-changed subscription; null while not taken. */
    this._mcpChangedOff = null;
    this.connect();
  }

  /** Live refresh off the plugin-changed broadcast. Idempotent; taken again after dispose(). */
  connect() {
    if (this._mcpChangedOff) return;
    this._mcpChangedOff = wsService.on('plugin-changed', () => {
      if (this._visible) this.controller.refresh();
    });
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this._visible = true;
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this._visible = false;
    this.controller.stopPolling();
  }

  /**
   * Deep-link target: open the edit form for one server, so a tool elsewhere in
   * the UI can lead back to the server that provides it.
   * @param {string} name - MCP server name
   * @returns {Promise<boolean>} True if that server exists and its form opened
   */
  revealEntry(name) {
    return this.controller.revealEntry(name);
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this._visible = false;
    this.controller.close();
  }

  /** Element disconnected: drop the plugin-changed subscription and stop polling. */
  dispose() {
    this._mcpChangedOff?.();
    this._mcpChangedOff = null;
    this.controller.stopPolling();
  }
}

/**
 * "ACP agents" tab: per-conversation agents with no persistent process. A thin
 * {@link ConfigTabController} wrapper with no extra broadcast wiring.
 */
export class AcpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, ACP_SPEC);
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this.controller.stopPolling();
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this.controller.close();
  }

  /** Element disconnected: stop polling. */
  dispose() {
    this.controller.stopPolling();
  }
}
