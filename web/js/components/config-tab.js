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
 * Shared machinery for the settings tabs that manage a scope-keyed map of
 * named subprocess entries — {command, args, env, enabled} — persisted per
 * scope (global vs project). Both the "MCP servers" and "ACP agents" tabs are
 * this exact shape, so they share one controller (rendering, add/edit form,
 * repeatable arg/env rows, scope handling) and one set of pure config helpers;
 * only a small per-tab spec (ops adapters, labels, row hooks) differs.
 *
 * The DOM this builds intentionally reuses the `mcp-*` CSS classes for styling,
 * so both tabs look identical; per-tab input *hook* classes are prefixed with
 * the spec id (`mcp-name-input` / `acp-name-input`) so the form can read its
 * own fields back from the DOM unambiguously.
 * @module components/config-tab
 */

import { showConfirm } from './modal-dialog.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';
import { errorText } from '../../sdk/lib/error-utils.js';

// ---------------------------------------------------------------------------
// Pure config helpers (unit-tested directly — see mcp-settings-test.js / acp-settings-test.js)
// ---------------------------------------------------------------------------

/**
 * One subprocess entry as stored in a scope's config map. stdio entries carry
 * `command`/`args`/`env`; remote (http/sse) entries carry `transport`/`url` and
 * optional `headers` instead.
 * @typedef {object} SubprocessConfig
 * @property {string} [command] - Executable to launch (stdio transport)
 * @property {string[]} [args] - Command arguments (each may contain spaces)
 * @property {Record<string,string>} [env] - Environment variables
 * @property {string} [transport] - "stdio" (default), "http", or "sse"
 * @property {string} [url] - Endpoint URL (http/sse transports)
 * @property {Record<string,string>} [headers] - Extra request headers (http/sse transports)
 * @property {boolean} [enabled] - Whether the entry is active
 * @property {{allow?: string[], deny?: string[]}} [tools] - Per-server tool visibility filter (MCP only)
 * @property {Record<string, any>} [defaultArguments] - Fixed arguments merged into every call and hidden from the model (MCP only)
 * @property {boolean} [autoApprove] - Tool calls are pre-approved; honoured in the global file only (MCP only)
 */

/**
 * The transport kinds that connect to a remote URL rather than spawning a
 * subprocess. "streamable" is one of the aliases the server folds onto "http"
 * when it parses a config, and is accepted here so a form seeded from a value
 * this UI never wrote still opens on the remote field group.
 * @param {string} [transport]
 * @returns {boolean} True for http/streamable/sse.
 */
export function isRemoteTransport(transport) {
  return transport === 'http' || transport === 'streamable' || transport === 'sse';
}

/**
 * Convert the add/edit form's working state into a clean config entry. For a
 * remote (http/sse) transport the entry carries `transport`/`url` plus any
 * non-blank `headers`; otherwise it is an stdio entry with `command`/`args`/`env`
 * (empty `args`/`env` omitted, arg strings kept verbatim, blank keys dropped).
 * `enabled` is always coerced to a boolean.
 * @param {{command?: string, args?: string[], env?: Record<string,string>, transport?: string, url?: string, headers?: Record<string,string>, enabled?: boolean}} form
 * @returns {SubprocessConfig} The config entry to persist under the entry's name.
 */
export function configFormToConfig(form) {
  /** @type {SubprocessConfig} */
  const entry = {};
  if (isRemoteTransport(form.transport)) {
    entry.transport = form.transport;
    const url = (form.url || '').trim();
    if (url) entry.url = url;
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(form.headers || {})) {
      const key = (k || '').trim();
      if (key) headers[key] = v === null || v === undefined ? '' : String(v);
    }
    if (Object.keys(headers).length) entry.headers = headers;
  } else {
    entry.command = (form.command || '').trim();
    const args = (form.args || []).filter((a) => a !== '' && a !== null && a !== undefined);
    if (args.length) entry.args = args;
    /** @type {Record<string, string>} */
    const env = {};
    for (const [k, v] of Object.entries(form.env || {})) {
      const key = (k || '').trim();
      if (key) env[key] = v === null || v === undefined ? '' : String(v);
    }
    if (Object.keys(env).length) entry.env = env;
  }
  entry.enabled = form.enabled !== false;
  return entry;
}

/**
 * Produce the whole-scope map to write back after adding or replacing one
 * entry. setConfig rewrites the entire file for a scope, so callers must always
 * send the full map — this clones the current one and sets one key.
 * @param {Record<string, SubprocessConfig>} map - The current scope map
 * @param {string} name - Entry name to add or replace
 * @param {SubprocessConfig} entry - The config entry
 * @returns {Record<string, SubprocessConfig>} A new map with `name` set to `entry`.
 */
export function upsertConfigEntry(map, name, entry) {
  return { ...(map || {}), [name]: entry };
}

/**
 * Produce the whole-scope map with one entry removed.
 * @param {Record<string, SubprocessConfig>} map - The current scope map
 * @param {string} name - Entry name to delete
 * @returns {Record<string, SubprocessConfig>} A new map without `name`.
 */
export function deleteConfigEntry(map, name) {
  const next = { ...(map || {}) };
  delete next[name];
  return next;
}

/**
 * Produce the whole-scope map with one entry's `enabled` flag flipped, keeping
 * the rest of that entry's config intact.
 * @param {Record<string, SubprocessConfig>} map - The current scope map
 * @param {string} name - Entry name to toggle
 * @param {boolean} enabled - Desired enabled state
 * @returns {Record<string, SubprocessConfig>} A new map with the flag applied.
 */
export function setConfigEntryEnabled(map, name, enabled) {
  const src = map || {};
  return { ...src, [name]: /** @type {SubprocessConfig} */ ({ ...(src[name] || {}), enabled }) };
}

/**
 * Which scope a listed entry is edited in: "project" when a project-scope entry
 * of that name exists (project overrides global), else "global".
 * @param {{global?: object, project?: object}} config - The getConfig result
 * @param {string} name - Entry name
 * @returns {'global'|'project'} The scope that owns this entry's config.
 */
export function configScopeOf(config, name) {
  const proj = (config && config.project) || {};
  return Object.prototype.hasOwnProperty.call(proj, name) ? 'project' : 'global';
}

/**
 * Build a name validator. Names must be non-empty, free of whitespace and
 * slashes, unique within their scope, and (optionally) not collide with a
 * reserved word. The messages it returns are translated when it is called.
 * @param {{duplicateMsg: string, reserved?: string, reservedMsg?: string}} opts -
 *   `duplicateMsg` and `reservedMsg` are whole English messages (marked with
 *   `markForTranslation`); `duplicateMsg` takes the name as `{name}`.
 * @returns {(name: string, existingNames?: string[]) => string} Validator returning '' when valid.
 */
export function makeNameValidator({ duplicateMsg, reserved, reservedMsg }) {
  return (name, existingNames) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return t('Name is required.');
    if (/\s/.test(trimmed)) return t('Name cannot contain spaces.');
    if (trimmed.includes('/')) return t('Name cannot contain "/".');
    if (reserved && trimmed === reserved) return reservedMsg ? t(reservedMsg) : t('"{name}" is reserved.', { name: reserved });
    if ((existingNames || []).includes(trimmed)) return t(duplicateMsg, { name: trimmed });
    return '';
  };
}

/**
 * How a scope is named on an entry's chip, keyed by the scope value.
 * @type {{project: string, global: string}}
 */
const SCOPE_LABELS = {
  project: markForTranslation('project'),
  global: markForTranslation('global'),
};

// ---------------------------------------------------------------------------
// ConfigTabController — one instance per tab, driven by a spec
// ---------------------------------------------------------------------------

/**
 * The per-tab configuration a {@link ConfigTabController} is built from. Ops
 * adapters normalise each backend's differing param/response shapes to the
 * generic ones the controller uses; the row hooks handle the small visual
 * differences (status dot, description, per-row error, restart/log buttons).
 * @typedef {object} ConfigTabSpec
 * @property {string} id - Short id (also the input-hook class prefix), e.g. 'mcp'.
 * @property {string} formHostSelector - Selector of the tab's mount point, e.g. '#mcp-form'.
 * @property {number} pollMs - Background refresh interval while the tab is open.
 * @property {string} loadError - Fallback message when the initial fetch fails.
 *
 * Every English text field (`loadError`, `addLabel`, `emptyText`, the titles,
 * hints, placeholders and fallback messages) holds a `markForTranslation`
 * message, or an example value that translates to itself, and is passed to
 * `t()` where it is drawn; the function hooks return text already translated,
 * and `notice` returns a message for `t()`.
 * @property {{list: () => Promise<any[]>, getConfig: () => Promise<any>, setConfig: (scope: 'global'|'project', map: object) => Promise<any>, restart?: (name: string) => Promise<any>, trust?: (name: string) => Promise<any>, getLog?: (name: string) => Promise<string>}} ops - Backend adapters. `trust` answers a row whose status is 'untrusted': a project entry whose command the backend will not run until the user has seen and accepted it.
 * @property {string} addLabel - Toolbar add-button label.
 * @property {string} emptyText - Empty-state text.
 * @property {(toolbar: HTMLElement) => void} [toolbarExtra] - Append extra toolbar content.
 * @property {() => Promise<string>} [notice] - Best-effort line shown above a non-empty list, for a condition the rows themselves can't show (e.g. entries that run but reach nothing). '' for none; a rejection is treated as ''.
 * @property {(name: string, existingNames?: string[]) => string} validateName - Name validator.
 * @property {(status: any) => string} dotClass - Status-dot class suffix.
 * @property {(status: any) => string} dotTitle - Status-dot tooltip.
 * @property {(status: any) => (HTMLElement|null)} [identityExtras] - Node inserted after the name.
 * @property {(status: any) => string} describe - The row's description line.
 * @property {(status: any) => string} rowError - Inline per-row error ('' for none).
 * @property {(name: string) => {message: string, title: string}} deleteConfirm - Delete-confirm copy.
 * @property {string} formAddTitle - Add-form heading.
 * @property {string} namePlaceholder - Placeholder for the Name input.
 * @property {string} nameHintAdd - Name hint shown when adding.
 * @property {string} nameHintEdit - Name hint shown when editing (read-only).
 * @property {string} scopeHintEdit - Scope hint shown when editing (a move is a delete and re-add).
 * @property {string} commandPlaceholder - Placeholder for the Command input.
 * @property {string} commandHint - Hint shown under the Command input.
 * @property {string} argFirstPlaceholder - Placeholder for the first argument row.
 * @property {string} argRestPlaceholder - Placeholder for subsequent argument rows.
 * @property {string} envKeyPlaceholder - Placeholder for env-var key inputs.
 * @property {string} saveFailMsg - Fallback message when a save fails.
 * @property {boolean} [supportsTransport] - Offer a transport selector (stdio/http/sse) with URL + headers fields for remote servers.
 * @property {string} [urlPlaceholder] - Placeholder for the URL input (transport-capable tabs).
 * @property {string} [urlHint] - Hint shown under the URL input (transport-capable tabs).
 * @property {string} [headerKeyPlaceholder] - Placeholder for header-name inputs (transport-capable tabs).
 * @property {(ctx: {entry: object, enabled: boolean, scope: string, name: string}) => Promise<void>} [onAfterSave] - Best-effort hook after a successful save.
 * @property {(cfg: SubprocessConfig) => object} [seedFormExtra] - Map a stored entry to extra working-state fields when the add/edit form opens (edit gets the entry; add gets {}). Lets a tab carry fields the generic form doesn't know about.
 * @property {(f: any, wrap: HTMLElement, ctrl: ConfigTabController) => void} [renderFormExtra] - Append an extra form section (rendered just before the Enabled toggle).
 * @property {(f: any) => object} [formToConfigExtra] - Extra keys spread into the persisted entry on save. MUST re-emit any field {@link seedFormExtra} read, or it is dropped (configFormToConfig only keeps the generic fields).
 */

/**
 * Renders and drives one subprocess-config settings tab. State is owned here;
 * the host element is used only for scoped DOM queries and as the mount root.
 */
export class ConfigTabController {
  /**
   * @param {HTMLElement} root - The settings-panel element (DOM query scope).
   * @param {ConfigTabSpec} spec - Per-tab configuration.
   */
  constructor(root, spec) {
    this.root = root;
    this.spec = spec;
    /** @type {number|undefined} setInterval id for the status poll. */
    this.pollId = undefined;
    /** @type {any[]} Live status (source of truth for rows). */
    this.items = [];
    /** @type {{global: Record<string, SubprocessConfig>, project: Record<string, SubprocessConfig>, hasProject: boolean}} Raw per-scope config maps (source of truth for editing). */
    this.config = { global: {}, project: {}, hasProject: false };
    /** @type {any} null = list view; an object = the add/edit form's working state. */
    this.editing = null;
    /** @type {boolean} True while a refresh fetch is in flight (overlap guard). */
    this.busy = false;
    /** @type {string} Inline error from the most recent action. */
    this.error = '';
    /** @type {string} Line shown above the list from the spec's notice hook ('' = none). */
    this.notice = '';
    /** @type {Promise<void>|null} Resolves when the first refresh of this showing has landed. */
    this.ready = null;
    /** @type {string} Name whose log disclosure is open ('' = none); log-capable tabs only. */
    this.logFor = '';
    /** @type {string|null} Cached log text for the open disclosure; null = loading. */
    this.logText = null;
  }

  // --- lifecycle ------------------------------------------------------------

  /** Fetch immediately and arm the background poll. Called when the tab shows. */
  show() {
    this.ready = this.refresh();
    this.pollId = setInterval(() => this.refresh(), this.spec.pollMs);
  }

  /**
   * Open the edit form for a named entry, waiting for the config to arrive
   * first.
   *
   * A deep link lands here immediately after `show()`, whose refresh is
   * deliberately not awaited — so without this wait `openForm` would read an
   * empty `this.config` and present an Edit form with every field blank, which
   * looks exactly like a config that failed to load.
   * @param {string} name - Entry name to edit
   * @returns {Promise<boolean>} True if the entry existed and its form was opened
   */
  async revealEntry(name) {
    if (!name) return false;
    await this.ready;
    const known = this.items.some((i) => i.name === name)
      || !!this.config.global[name] || !!this.config.project[name];
    if (!known) return false;
    this.openForm('edit', { name });
    return true;
  }

  /** Stop the background poll (tab hidden / panel closing). */
  stopPolling() {
    clearInterval(this.pollId);
    this.pollId = undefined;
  }

  /**
   * Reset to a clean list view: stop polling and drop any in-progress add/edit
   * form and open log/error, so a reopen starts fresh.
   */
  close() {
    this.stopPolling();
    this.editing = null;
    this.logFor = '';
    this.logText = null;
    this.error = '';
  }

  /**
   * Fetch live status and the raw per-scope config together, then re-render.
   * Overlapping ticks are guarded; while the add/edit form is open the data
   * refreshes silently but the form is left untouched.
   */
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const [items, cfg, notice] = await Promise.all([
        this.spec.ops.list(),
        this.spec.ops.getConfig(),
        // Advisory only: a notice we can't fetch must never fail the refresh and
        // blank the list the user came here for.
        this.spec.notice ? this.spec.notice().catch(() => '') : Promise.resolve(''),
      ]);
      this.items = items || [];
      this.notice = notice || '';
      this.config = {
        global: (cfg && cfg.global) || {},
        project: (cfg && cfg.project) || {},
        hasProject: !!(cfg && cfg.hasProject),
      };
      this.error = '';
    } catch (e) {
      // Keep the last known state; surface an inline banner instead of throwing.
      this.error = e instanceof Error ? errorText(e) : t(this.spec.loadError);
    } finally {
      this.busy = false;
    }
    if (!this.editing) this.render();
  }

  // --- rendering ------------------------------------------------------------

  /** Render the tab: the add/edit form when one is open, else the list. */
  render() {
    const host = /** @type {HTMLElement|null} */ (this.root.querySelector(this.spec.formHostSelector));
    if (!host) return;
    host.innerHTML = '';
    if (this.editing) {
      host.appendChild(this._buildForm());
      return;
    }
    if (this.error) host.appendChild(this._errorBanner(this.error));
    this._renderList(host);
  }

  /**
   * @param {string} message
   * @returns {HTMLElement} The banner element.
   */
  _errorBanner(message) {
    const banner = document.createElement('div');
    banner.className = 'key-source-hint mcp-error-hint';
    banner.style.display = 'block';
    banner.textContent = message;
    return banner;
  }

  /**
   * Render the list view: a toolbar (Add + optional extras), then a friendly
   * empty state or one row per configured entry.
   * @param {HTMLElement} host
   */
  _renderList(host) {
    const toolbar = document.createElement('div');
    toolbar.className = 'mcp-toolbar';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = t(this.spec.addLabel);
    addBtn.addEventListener('click', () => this.openForm('add'));
    toolbar.appendChild(addBtn);
    if (this.spec.toolbarExtra) this.spec.toolbarExtra(toolbar);
    host.appendChild(toolbar);

    const items = /** @type {any[]} */ (this.items || []);
    const hasAny = items.length
      || Object.keys(this.config.global).length
      || Object.keys(this.config.project).length;
    if (!hasAny) {
      const hint = document.createElement('div');
      hint.className = 'key-source-hint mcp-empty';
      hint.style.display = 'block';
      hint.textContent = t(this.spec.emptyText);
      host.appendChild(hint);
      return;
    }

    // Above the rows, because it is about all of them: every row can read
    // "running" while nothing they serve arrives anywhere.
    if (this.notice) {
      const notice = document.createElement('div');
      notice.className = 'key-source-hint mcp-notice';
      notice.style.display = 'block';
      notice.textContent = t(this.notice);
      host.appendChild(notice);
    }

    const list = document.createElement('div');
    list.className = 'mcp-list';
    for (const item of items) this._buildRow(item, list);
    host.appendChild(list);
  }

  /**
   * Build one entry row (status dot, name, scope chip, description, controls)
   * and append it to `list`; for a log-capable tab whose disclosure is open, a
   * <pre> is appended right after it.
   * @param {any} status
   * @param {HTMLElement} list
   */
  _buildRow(status, list) {
    const spec = this.spec;
    const name = status.name;
    const scope = configScopeOf(this.config, name);
    const enabled = status.enabled !== false;

    const row = document.createElement('div');
    row.className = 'settings-group provider-field mcp-row';
    if (!enabled) row.classList.add('mcp-row-disabled');

    // Left: status + identity + description.
    const info = document.createElement('div');
    info.className = 'provider-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'provider-name mcp-name-row';
    const dot = document.createElement('span');
    dot.className = `mcp-status-dot status-${spec.dotClass(status)}`;
    dot.title = spec.dotTitle(status);
    nameRow.appendChild(dot);
    const nameText = document.createElement('span');
    nameText.className = 'mcp-entry-name';
    nameText.textContent = name;
    nameRow.appendChild(nameText);
    const extras = spec.identityExtras ? spec.identityExtras(status) : null;
    if (extras) nameRow.appendChild(extras);
    const chip = document.createElement('span');
    chip.className = 'mcp-scope-chip';
    chip.textContent = t(scope === 'project' ? SCOPE_LABELS.project : SCOPE_LABELS.global);
    nameRow.appendChild(chip);
    info.appendChild(nameRow);

    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = spec.describe(status);
    info.appendChild(desc);

    const rowErr = spec.rowError(status);
    if (rowErr) {
      const err = document.createElement('div');
      err.className = 'key-source-hint mcp-error-hint';
      err.style.display = 'block';
      err.textContent = rowErr;
      info.appendChild(err);
    }

    // Right: enable toggle + action buttons.
    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control mcp-controls';

    const toggle = document.createElement('label');
    toggle.className = 'mcp-toggle-wrap';
    toggle.title = enabled ? t('Enabled') : t('Disabled');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'provider-toggle u-visually-hidden';
    cb.checked = enabled;
    cb.addEventListener('change', () => this._setEnabled(scope, name, cb.checked));
    const sw = document.createElement('span');
    sw.className = 'toggle-switch';
    toggle.appendChild(cb);
    toggle.appendChild(sw);
    ctrl.appendChild(toggle);

    const btnRow = document.createElement('div');
    btnRow.className = 'mcp-btn-row';

    const untrusted = status.status === 'untrusted' && !!spec.ops.trust;
    if (enabled && untrusted) {
      const trust = document.createElement('button');
      trust.type = 'button';
      trust.className = 'btn btn-sm btn-secondary';
      trust.textContent = t('Trust and start');
      trust.addEventListener('click', () => this._confirmTrust(name, trust));
      btnRow.appendChild(trust);
    } else if (enabled && spec.ops.restart) {
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'btn btn-sm btn-secondary';
      restart.textContent = t('Restart');
      if (status.status === 'starting') restart.disabled = true;
      restart.addEventListener('click', () => this._restart(name, restart));
      btnRow.appendChild(restart);
    }

    if (spec.ops.getLog) {
      const logsBtn = document.createElement('button');
      logsBtn.type = 'button';
      logsBtn.className = 'btn btn-sm btn-secondary';
      logsBtn.textContent = this.logFor === name ? t('Hide log') : t('Log');
      logsBtn.addEventListener('click', () => this._toggleLog(name));
      btnRow.appendChild(logsBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm btn-secondary';
    editBtn.textContent = t('Edit');
    editBtn.addEventListener('click', () => this.openForm('edit', status));
    btnRow.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('Delete');
    delBtn.addEventListener('click', () => this._confirmDelete(scope, name));
    btnRow.appendChild(delBtn);

    ctrl.appendChild(btnRow);

    row.appendChild(info);
    row.appendChild(ctrl);
    list.appendChild(row);

    if (spec.ops.getLog && this.logFor === name) {
      const pre = document.createElement('pre');
      pre.className = 'mcp-log-view';
      pre.textContent = this.logText === null
        ? t('Loading…')
        : (this.logText || t('No output yet.'));
      list.appendChild(pre);
    }
  }

  // --- row actions ----------------------------------------------------------

  /**
   * Restart an entry's process (transient lifecycle — distinct from the durable
   * enable/disable toggle), then refresh from authoritative state.
   * @param {string} name
   * @param {HTMLButtonElement} btn
   */
  async _restart(name, btn) {
    const restart = this.spec.ops.restart;
    if (!restart) return;
    btn.disabled = true;
    btn.textContent = t('Restarting…');
    this.error = '';
    try {
      await restart(name);
    } catch (e) {
      this.error = e instanceof Error ? errorText(e) : t('Failed to restart "{name}".', { name });
    }
    await this.refresh();
  }

  /**
   * Show the user exactly what a project entry would run, and trust it only if
   * they say so. The command, arguments and environment all come from a file
   * that may have arrived with a cloned repository, so all three are shown.
   * @param {string} name
   * @param {HTMLButtonElement} btn
   */
  async _confirmTrust(name, btn) {
    const trust = this.spec.ops.trust;
    if (!trust) return;
    const cfg = /** @type {any} */ (this.config?.project?.[name]) || {};
    const command = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean).join(' ');
    const env = Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    const ok = await showConfirm(
      t('{hasEnv, select, yes {"{name}" comes from this project\'s .juggler/mcp.json and runs with your permissions: {command} (environment: {env}). Only trust it if you trust this project.} other {"{name}" comes from this project\'s .juggler/mcp.json and runs with your permissions: {command}. Only trust it if you trust this project.}}',
        { name, command, env, hasEnv: env ? 'yes' : 'no' }),
      t('Trust this MCP server?'),
      { confirmText: t('Trust and start') }
    );
    if (!ok) return;
    btn.disabled = true;
    this.error = '';
    try {
      await trust(name);
    } catch (e) {
      this.error = e instanceof Error ? errorText(e) : t('Failed to trust "{name}".', { name });
    }
    await this.refresh();
  }

  /**
   * Toggle an entry's log disclosure. Opening fetches the recent log once
   * (bounded server-side) and renders it into a <pre>; re-opening closes it.
   * @param {string} name
   */
  async _toggleLog(name) {
    const getLog = this.spec.ops.getLog;
    if (!getLog) return;
    if (this.logFor === name) {
      this.logFor = '';
      this.logText = null;
      this.render();
      return;
    }
    this.logFor = name;
    this.logText = null; // loading
    this.render();
    try {
      const log = await getLog(name);
      if (this.logFor === name) {
        this.logText = log || '';
        this.render();
      }
    } catch {
      if (this.logFor === name) {
        this.logText = '';
        this.render();
      }
    }
  }

  /**
   * Durable enable/disable: write the `enabled` flag into the scope map (whole
   * map rewritten) and refresh.
   * @param {'global'|'project'} scope
   * @param {string} name
   * @param {boolean} enabled
   */
  async _setEnabled(scope, name, enabled) {
    this.error = '';
    const src = scope === 'project' ? this.config.project : this.config.global;
    const nextMap = setConfigEntryEnabled(src, name, enabled);
    try {
      await this.spec.ops.setConfig(scope, nextMap);
      // Enabling a previously-disabled entry runs the same post-save hook as an
      // add — e.g. ACP enables its provider so the toggled-on agent shows up in
      // the picker without a restart (AutoDetect won't notice it mid-session).
      // Skip the hook when disabling; it only ever adds availability.
      if (enabled && this.spec.onAfterSave) {
        await this.spec.onAfterSave({ entry: nextMap[name] || {}, enabled, scope, name });
      }
    } catch (e) {
      this.error = e instanceof Error ? errorText(e) : t('Failed to update "{name}".', { name });
    }
    await this.refresh();
  }

  /**
   * Confirm, then delete an entry from its scope map (whole map rewritten).
   * @param {'global'|'project'} scope
   * @param {string} name
   */
  async _confirmDelete(scope, name) {
    const { message, title } = this.spec.deleteConfirm(name);
    const ok = await showConfirm(message, title, { confirmText: t('Remove'), danger: true });
    if (!ok) return;
    this.error = '';
    const src = scope === 'project' ? this.config.project : this.config.global;
    try {
      await this.spec.ops.setConfig(scope, deleteConfigEntry(src, name));
    } catch (e) {
      this.error = e instanceof Error ? errorText(e) : t('Failed to remove "{name}".', { name });
    }
    if (this.logFor === name) { this.logFor = ''; this.logText = null; }
    await this.refresh();
  }

  // --- add/edit form --------------------------------------------------------

  /**
   * Open the add/edit form by seeding working state, then render.
   * @param {'add'|'edit'} mode
   * @param {any} [status] - The row's status (edit only).
   */
  openForm(mode, status) {
    this.error = '';
    if (mode === 'edit' && status) {
      const name = status.name;
      const scope = configScopeOf(this.config, name);
      const cfg = /** @type {SubprocessConfig} */ ((scope === 'project' ? this.config.project : this.config.global)[name] || {});
      this.editing = {
        mode: 'edit',
        scope,
        name,
        transport: cfg.transport || 'stdio',
        url: cfg.url || '',
        headerPairs: Object.entries(cfg.headers || {}).map(([key, value]) => ({ key, value: String(value) })),
        command: cfg.command || '',
        args: Array.isArray(cfg.args) ? cfg.args.slice() : [],
        envPairs: Object.entries(cfg.env || {}).map(([key, value]) => ({ key, value: String(value) })),
        enabled: cfg.enabled !== false,
        error: '',
        ...(this.spec.seedFormExtra ? this.spec.seedFormExtra(cfg) : {}),
      };
    } else {
      this.editing = {
        mode: 'add',
        scope: 'global',
        name: '',
        transport: 'stdio',
        url: '',
        headerPairs: [],
        command: '',
        args: [],
        envPairs: [],
        enabled: true,
        error: '',
        ...(this.spec.seedFormExtra ? this.spec.seedFormExtra({}) : {}),
      };
    }
    this.render();
  }

  /**
   * Build the add/edit form from working state. Name and scope are read-only
   * when editing (rename/move = delete + add). Arg and env rows are repeatable;
   * env values are masked with a per-field reveal toggle.
   * @returns {HTMLElement} The form element to mount in the tab.
   */
  _buildForm() {
    const spec = this.spec;
    const f = this.editing;
    const wrap = document.createElement('div');
    wrap.className = 'mcp-form';

    const title = document.createElement('div');
    title.className = 'settings-section-heading caps-label-lg';
    title.textContent = f.mode === 'edit' ? t('Edit “{name}”', { name: f.name }) : t(spec.formAddTitle);
    wrap.appendChild(title);

    // Name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = `mcp-input field-input field-input-sm ${spec.id}-name-input`;
    nameInput.placeholder = t(spec.namePlaceholder);
    nameInput.value = f.name;
    if (f.mode === 'edit') nameInput.readOnly = true;
    wrap.appendChild(this._formField(t('Name'), nameInput, t(f.mode === 'edit' ? spec.nameHintEdit : spec.nameHintAdd)));

    // Scope
    const scopeSelect = document.createElement('select');
    scopeSelect.className = `mcp-input field-input field-input-sm ${spec.id}-scope-input`;
    const optGlobal = document.createElement('option');
    optGlobal.value = 'global';
    optGlobal.textContent = t('Global (all projects)');
    scopeSelect.appendChild(optGlobal);
    if (this.config.hasProject || f.scope === 'project') {
      const optProject = document.createElement('option');
      optProject.value = 'project';
      optProject.textContent = t('This project only');
      scopeSelect.appendChild(optProject);
    }
    scopeSelect.value = f.scope;
    if (f.mode === 'edit') scopeSelect.disabled = true;
    wrap.appendChild(this._formField(t('Scope'), scopeSelect,
      f.mode === 'edit' ? t(spec.scopeHintEdit) : ''));

    // Transport (transport-capable tabs only): switches between the stdio field
    // group (command/args/env) and the remote field group (url/headers).
    if (spec.supportsTransport) {
      const transportSelect = document.createElement('select');
      transportSelect.className = `mcp-input field-input field-input-sm ${spec.id}-transport-input`;
      /** @type {Array<[string, string]>} */
      const transportOptions = [
        ['stdio', t('Local process (stdio)')],
        ['http', t('Remote (HTTP)')],
        ['sse', t('Remote (SSE)')],
      ];
      for (const [val, label] of transportOptions) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        transportSelect.appendChild(opt);
      }
      transportSelect.value = isRemoteTransport(f.transport) ? f.transport : 'stdio';
      transportSelect.addEventListener('change', () => {
        // Persist visible fields before swapping the field group.
        this._syncFormState();
        f.transport = transportSelect.value;
        this.render();
      });
      wrap.appendChild(this._formField(t('Transport'), transportSelect,
        t('A local process (stdio) or a remote MCP endpoint (HTTP/SSE).')));
    }

    if (spec.supportsTransport && isRemoteTransport(f.transport)) {
      this._buildRemoteFields(f, wrap);
    } else {
      this._buildStdioFields(f, wrap);
    }

    // Tab-specific extra section (e.g. MCP tool filter + fixed arguments).
    if (spec.renderFormExtra) spec.renderFormExtra(f, wrap, this);

    // Enabled
    const enabledField = document.createElement('div');
    enabledField.className = 'mcp-form-field mcp-enabled-field';
    const enabledToggle = document.createElement('label');
    enabledToggle.className = 'mcp-toggle-wrap';
    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.className = 'provider-toggle u-visually-hidden';
    enabledCb.dataset.configField = `${spec.id}-enabled`;
    enabledCb.checked = f.enabled !== false;
    const enabledSw = document.createElement('span');
    enabledSw.className = 'toggle-switch';
    enabledToggle.appendChild(enabledCb);
    enabledToggle.appendChild(enabledSw);
    const enabledText = document.createElement('span');
    enabledText.className = 'mcp-field-label';
    enabledText.textContent = t('Enabled');
    enabledField.appendChild(enabledText);
    enabledField.appendChild(enabledToggle);
    wrap.appendChild(enabledField);

    // Inline error
    if (f.error) {
      const err = document.createElement('div');
      err.className = 'key-source-hint mcp-error-hint';
      err.style.display = 'block';
      err.textContent = f.error;
      wrap.appendChild(err);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'mcp-form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = t('Save');
    saveBtn.addEventListener('click', () => this._save());
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-sm btn-secondary';
    cancelBtn.textContent = t('Cancel');
    cancelBtn.addEventListener('click', () => {
      this.editing = null;
      this.render();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    wrap.appendChild(actions);

    return wrap;
  }

  /**
   * Append the stdio field group (Command, repeatable Arguments, repeatable
   * Environment variables) to the form.
   * @param {any} f - The form working state.
   * @param {HTMLElement} wrap - The form element to append to.
   */
  _buildStdioFields(f, wrap) {
    const spec = this.spec;

    // Command
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = `mcp-input field-input field-input-sm ${spec.id}-command-input`;
    cmdInput.placeholder = t(spec.commandPlaceholder);
    cmdInput.value = f.command;
    wrap.appendChild(this._formField(t('Command'), cmdInput, t(spec.commandHint)));

    // Arguments
    const argsField = document.createElement('div');
    argsField.className = 'mcp-form-field';
    const argsLabel = document.createElement('label');
    argsLabel.className = 'mcp-field-label';
    argsLabel.textContent = t('Arguments');
    argsField.appendChild(argsLabel);
    const argsList = document.createElement('div');
    argsList.className = 'mcp-args-list';
    argsField.appendChild(argsList);
    const addArg = document.createElement('button');
    addArg.type = 'button';
    addArg.className = 'btn btn-sm btn-secondary mcp-add-row';
    addArg.textContent = t('Add argument');
    addArg.addEventListener('click', () => {
      f.args = this._readArgs();
      f.args.push('');
      this._renderArgsList(argsList);
    });
    argsField.appendChild(addArg);
    wrap.appendChild(argsField);
    this._renderArgsList(argsList);

    // Environment variables
    const envField = document.createElement('div');
    envField.className = 'mcp-form-field';
    const envLabel = document.createElement('label');
    envLabel.className = 'mcp-field-label';
    envLabel.textContent = t('Environment variables');
    envField.appendChild(envLabel);
    const envList = document.createElement('div');
    envList.className = 'mcp-env-list';
    envField.appendChild(envList);
    const addEnv = document.createElement('button');
    addEnv.type = 'button';
    addEnv.className = 'btn btn-sm btn-secondary mcp-add-row';
    addEnv.textContent = t('Add variable');
    addEnv.addEventListener('click', () => {
      f.envPairs = this._readEnvPairs();
      f.envPairs.push({ key: '', value: '' });
      this._renderEnvList(envList);
    });
    envField.appendChild(addEnv);
    wrap.appendChild(envField);
    this._renderEnvList(envList);
  }

  /**
   * Append the remote (http/sse) field group (URL, repeatable Headers) to the
   * form.
   * @param {any} f - The form working state.
   * @param {HTMLElement} wrap - The form element to append to.
   */
  _buildRemoteFields(f, wrap) {
    const spec = this.spec;

    // URL
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = `mcp-input field-input field-input-sm ${spec.id}-url-input`;
    urlInput.placeholder = spec.urlPlaceholder || 'https://example.com/mcp'; // i18n-ignore: an example address
    urlInput.value = f.url || '';
    wrap.appendChild(this._formField(t('URL'), urlInput, spec.urlHint ? t(spec.urlHint) : t('The remote MCP endpoint URL.')));

    // Headers
    const headersField = document.createElement('div');
    headersField.className = 'mcp-form-field';
    const headersLabel = document.createElement('label');
    headersLabel.className = 'mcp-field-label';
    headersLabel.textContent = t('Headers');
    headersField.appendChild(headersLabel);
    const headersList = document.createElement('div');
    headersList.className = 'mcp-env-list';
    headersField.appendChild(headersList);
    const addHeader = document.createElement('button');
    addHeader.type = 'button';
    addHeader.className = 'btn btn-sm btn-secondary mcp-add-row';
    addHeader.textContent = t('Add header');
    addHeader.addEventListener('click', () => {
      f.headerPairs = this._readHeaderPairs();
      f.headerPairs.push({ key: '', value: '' });
      this._renderHeadersList(headersList);
    });
    headersField.appendChild(addHeader);
    wrap.appendChild(headersField);
    this._renderHeadersList(headersList);
  }

  /**
   * Build a stacked "label + control (+ hint)" form field.
   * @param {string} labelText
   * @param {HTMLElement} control
   * @param {string} [hintText]
   * @returns {HTMLElement} The field wrapper element.
   */
  _formField(labelText, control, hintText) {
    const field = document.createElement('div');
    field.className = 'mcp-form-field';
    const label = document.createElement('label');
    label.className = 'mcp-field-label';
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(control);
    if (hintText) {
      const hint = document.createElement('div');
      hint.className = 'mcp-field-hint';
      hint.textContent = hintText;
      field.appendChild(hint);
    }
    return field;
  }

  /**
   * Rebuild the repeatable argument rows into `container` from working state.
   * @param {HTMLElement} container
   */
  _renderArgsList(container) {
    const spec = this.spec;
    container.innerHTML = '';
    /** @type {string[]} */
    const args = this.editing.args || [];
    args.forEach((arg, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'mcp-repeat-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = `mcp-input field-input field-input-sm ${spec.id}-arg-input`;
      input.placeholder = t(i === 0 ? spec.argFirstPlaceholder : spec.argRestPlaceholder);
      input.value = arg;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-icon btn-icon-lg btn-secondary btn-danger-quiet mcp-remove-row';
      remove.setAttribute('aria-label', t('Remove argument'));
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.editing.args = this._readArgs();
        this.editing.args.splice(i, 1);
        this._renderArgsList(container);
      });
      rowEl.appendChild(input);
      rowEl.appendChild(remove);
      container.appendChild(rowEl);
    });
  }

  /**
   * Rebuild the repeatable env-var rows into `container` from working state.
   * Value inputs are masked, with a per-row reveal.
   * @param {HTMLElement} container
   */
  _renderEnvList(container) {
    const spec = this.spec;
    container.innerHTML = '';
    /** @type {Array<{key: string, value: string}>} */
    const pairs = this.editing.envPairs || [];
    pairs.forEach((pair, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = `mcp-repeat-row ${spec.id}-env-row`;
      const key = document.createElement('input');
      key.type = 'text';
      key.className = `mcp-input field-input field-input-sm ${spec.id}-env-key`;
      key.placeholder = spec.envKeyPlaceholder;
      key.value = pair.key;
      const value = document.createElement('input');
      value.type = 'password';
      value.className = `mcp-input field-input field-input-sm ${spec.id}-env-value`;
      value.placeholder = t('value');
      value.value = pair.value;
      value.autocomplete = 'off';
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'btn btn-icon btn-icon-lg btn-secondary mcp-reveal-btn';
      reveal.setAttribute('aria-label', t('Reveal value'));
      reveal.textContent = '👁';
      reveal.addEventListener('click', () => {
        value.type = value.type === 'password' ? 'text' : 'password';
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-icon btn-icon-lg btn-secondary btn-danger-quiet mcp-remove-row';
      remove.setAttribute('aria-label', t('Remove variable'));
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.editing.envPairs = this._readEnvPairs();
        this.editing.envPairs.splice(i, 1);
        this._renderEnvList(container);
      });
      rowEl.appendChild(key);
      rowEl.appendChild(value);
      rowEl.appendChild(reveal);
      rowEl.appendChild(remove);
      container.appendChild(rowEl);
    });
  }

  /**
   * Rebuild the repeatable header rows into `container` from working state.
   * Value inputs are masked, with a per-row reveal (headers such as
   * Authorization are secret-ish).
   * @param {HTMLElement} container
   */
  _renderHeadersList(container) {
    const spec = this.spec;
    container.innerHTML = '';
    /** @type {Array<{key: string, value: string}>} */
    const pairs = this.editing.headerPairs || [];
    pairs.forEach((pair, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = `mcp-repeat-row ${spec.id}-header-row`;
      const key = document.createElement('input');
      key.type = 'text';
      key.className = `mcp-input field-input field-input-sm ${spec.id}-header-key`;
      key.placeholder = spec.headerKeyPlaceholder || 'Authorization'; // i18n-ignore: an example header name
      key.value = pair.key;
      const value = document.createElement('input');
      value.type = 'password';
      value.className = `mcp-input field-input field-input-sm ${spec.id}-header-value`;
      value.placeholder = t('value');
      value.value = pair.value;
      value.autocomplete = 'off';
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'btn btn-icon btn-icon-lg btn-secondary mcp-reveal-btn';
      reveal.setAttribute('aria-label', t('Reveal value'));
      reveal.textContent = '👁';
      reveal.addEventListener('click', () => {
        value.type = value.type === 'password' ? 'text' : 'password';
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-icon btn-icon-lg btn-secondary btn-danger-quiet mcp-remove-row';
      remove.setAttribute('aria-label', t('Remove header'));
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.editing.headerPairs = this._readHeaderPairs();
        this.editing.headerPairs.splice(i, 1);
        this._renderHeadersList(container);
      });
      rowEl.appendChild(key);
      rowEl.appendChild(value);
      rowEl.appendChild(reveal);
      rowEl.appendChild(remove);
      container.appendChild(rowEl);
    });
  }

  /**
   * Read the current argument inputs from the DOM (source of truth between
   * add/remove operations).
   * @returns {string[]} The current argument values in row order.
   */
  _readArgs() {
    return Array.from(this.root.querySelectorAll(`.${this.spec.id}-arg-input`))
      .map((el) => /** @type {HTMLInputElement} */ (el).value);
  }

  /**
   * Read the current env key/value rows from the DOM.
   * @returns {Array<{key: string, value: string}>} The current env pairs in row order.
   */
  _readEnvPairs() {
    return Array.from(this.root.querySelectorAll(`.${this.spec.id}-env-row`)).map((rowEl) => ({
      key: /** @type {HTMLInputElement} */ (rowEl.querySelector(`.${this.spec.id}-env-key`)).value,
      value: /** @type {HTMLInputElement} */ (rowEl.querySelector(`.${this.spec.id}-env-value`)).value,
    }));
  }

  /**
   * Read the current header key/value rows from the DOM.
   * @returns {Array<{key: string, value: string}>} The current header pairs in row order.
   */
  _readHeaderPairs() {
    return Array.from(this.root.querySelectorAll(`.${this.spec.id}-header-row`)).map((rowEl) => ({
      key: /** @type {HTMLInputElement} */ (rowEl.querySelector(`.${this.spec.id}-header-key`)).value,
      value: /** @type {HTMLInputElement} */ (rowEl.querySelector(`.${this.spec.id}-header-value`)).value,
    }));
  }

  /**
   * Read every currently-rendered form field from the DOM into the working
   * state. Only one field group (stdio or remote) is mounted at a time, so each
   * read is guarded by the presence of its inputs; this lets the transport
   * selector swap groups and _save persist without losing values.
   */
  _syncFormState() {
    const spec = this.spec;
    const f = this.editing;
    if (!f) return;
    const q = (/** @type {string} */ cls) => this.root.querySelector(`.${spec.id}-${cls}`);
    if (f.mode !== 'edit') {
      const nameEl = /** @type {HTMLInputElement|null} */ (q('name-input'));
      if (nameEl) f.name = nameEl.value.trim();
      const scopeEl = /** @type {HTMLSelectElement|null} */ (q('scope-input'));
      if (scopeEl) f.scope = /** @type {'global'|'project'} */ (scopeEl.value);
    }
    const transportEl = /** @type {HTMLSelectElement|null} */ (q('transport-input'));
    if (transportEl) f.transport = transportEl.value;
    const cmdEl = /** @type {HTMLInputElement|null} */ (q('command-input'));
    if (cmdEl) f.command = cmdEl.value.trim();
    const urlEl = /** @type {HTMLInputElement|null} */ (q('url-input'));
    if (urlEl) f.url = urlEl.value.trim();
    if (this.root.querySelector(`.${spec.id}-arg-input`)) f.args = this._readArgs();
    if (this.root.querySelector(`.${spec.id}-env-row`)) f.envPairs = this._readEnvPairs();
    if (this.root.querySelector(`.${spec.id}-header-row`)) f.headerPairs = this._readHeaderPairs();
    const enabledEl = /** @type {HTMLInputElement|null} */ (this.root.querySelector(`[data-config-field="${spec.id}-enabled"]`));
    if (enabledEl) f.enabled = enabledEl.checked;
  }

  /**
   * Validate the form, build the config entry, write the whole scope map back,
   * and (on success) return to a freshly-fetched list. On validation failure the
   * form stays open with an inline error.
   */
  async _save() {
    const spec = this.spec;
    const f = this.editing;
    if (!f) return;

    // Read every field from the DOM so nothing is lost between row rebuilds.
    this._syncFormState();
    const name = f.name;
    const scope = /** @type {'global'|'project'} */ (f.scope || 'global');
    const remote = !!spec.supportsTransport && isRemoteTransport(f.transport);

    // Validate.
    if (f.mode !== 'edit') {
      const targetMap = scope === 'project' ? this.config.project : this.config.global;
      const err = spec.validateName(name, Object.keys(targetMap || {}));
      if (err) { f.error = err; this.render(); return; }
    }
    if (remote) {
      if (!f.url) { f.error = t('URL is required for a remote server.'); this.render(); return; }
      for (const p of (f.headerPairs || [])) {
        if (!p.key.trim() && p.value) { f.error = t('Every header needs a name.'); this.render(); return; }
      }
    } else {
      if (!f.command) { f.error = t('Command is required.'); this.render(); return; }
      for (const p of (f.envPairs || [])) {
        if (!p.key.trim() && p.value) { f.error = t('Every environment variable needs a name.'); this.render(); return; }
      }
    }

    /** @type {Record<string, string>} */
    const env = {};
    for (const p of (f.envPairs || [])) { const k = p.key.trim(); if (k) env[k] = p.value; }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const p of (f.headerPairs || [])) { const k = p.key.trim(); if (k) headers[k] = p.value; }
    /** @type {SubprocessConfig} */
    let entry = configFormToConfig({
      transport: f.transport, url: f.url, headers,
      command: f.command, args: f.args, env,
      enabled: f.enabled,
    });
    if (spec.formToConfigExtra) {
      // The hook may throw a validation error (e.g. malformed JSON) to keep the
      // form open with an inline message instead of persisting bad config.
      try {
        entry = { ...entry, ...spec.formToConfigExtra(f) };
      } catch (e) {
        f.error = e instanceof Error ? errorText(e) : t('Invalid field.');
        this.render();
        return;
      }
    }

    const src = scope === 'project' ? this.config.project : this.config.global;
    try {
      await spec.ops.setConfig(scope, upsertConfigEntry(src, name, entry));
    } catch (e) {
      f.error = e instanceof Error ? errorText(e) : t(spec.saveFailMsg);
      this.render();
      return;
    }
    this.editing = null;
    if (spec.onAfterSave) await spec.onAfterSave({ entry, enabled: f.enabled !== false, scope, name });
    await this.refresh();
  }
}
