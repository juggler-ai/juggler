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

import { modelLabel, modelLabelFromList } from '../model/model-display.js';
import { formatBytes, formatTimeAgo } from '../utils/format.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { addFilePath } from '../utils/properties-panel-helpers.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import wsService from '../services/websocket.js';
import { allInfoCards, isCardEnabled, setCardEnabled, INFO_CARDS_CHANGED_EVENT } from '../services/info-cards-manager.js';
import {
  getAttentionPrefs,
  setSoundEnabled,
  setNotifyEnabled,
  setChimeParam,
  resetChimeParams,
  previewChime,
  ATTENTION_PREFS_EVENT,
} from '../utils/attention-manager.js';
import { chimePatterns, chimeSounds } from '../utils/chime-synth.js';
import {
  mcpListServers,
  mcpGetConfig,
  mcpSetConfig,
  mcpServerControl,
  mcpGetLog,
} from '../services/ops-api.js';

/** Polling interval (ms) for refreshing the Connectivity tab while it's open. */
const CONNECTIVITY_POLL_MS = 2000;

/** Polling interval (ms) for tailing the selected log while the Logs tab is open. */
const LOGS_POLL_MS = 2000;

/**
 * Cap on the characters kept in the log viewer. Incremental appends never stop,
 * so a chatty log tailed for a long sitting would grow the <pre> unbounded;
 * once past this we drop the oldest characters (a whole-line boundary) to keep
 * the DOM bounded. Decoupled from the byte offset (which tracks file position),
 * so trimming what's shown never affects tailing.
 */
const LOGS_VIEWER_MAX_CHARS = 512 * 1024;



/**
 * One WAN tunnel mode this server's build registered, as reported by
 * GET /api/connectivity `wanModes`. The Connectivity tab's WAN section is
 * rendered entirely from this list; an empty list means the build has no WAN
 * feature and the section is hidden.
 * @typedef {object} WANMode
 * @property {string} mode - Wire id sent to POST /api/connectivity/tunnel
 * @property {string} title - Short mode name, e.g. "Direct P2P"
 * @property {string} description - One-paragraph explanation of trade-offs
 * @property {string} startLabel - Start-button label
 * @property {string} relayNote - Optional note shown while active
 * @property {string} unavailableHint - Shown instead of Start when unavailable
 * @property {boolean} available - Whether the mode can start on this machine
 */

/**
 * One connected viewer client, as reported by GET /api/connectivity `clients`
 * and the clients-changed event. The `id` lets a client exclude itself.
 * @typedef {object} ClientDescriptor
 * @property {string} id - Server-assigned client id
 * @property {string} origin - "local" (same machine), "lan", or "remote"
 * @property {string} detail - LAN IP, or remote transport label; "" for local
 * @property {string} userAgent - Raw User-Agent, when the transport had one
 * @property {number} connectedAt - Connect time, unix milliseconds
 */

/**
 * Human label for a client's origin, e.g. "Same machine", "LAN · 192.168.1.4",
 * or the remote transport name ("Cloudflare Tunnel relay", "Peer-to-peer").
 * @param {ClientDescriptor} c
 * @returns {string} The origin label.
 */
function clientOriginLabel(c) {
  switch (c.origin) {
    case 'local': return 'Same machine';
    case 'lan': return c.detail ? `LAN · ${c.detail}` : 'LAN';
    case 'remote': return c.detail || 'Remote';
    default: return 'Connected';
  }
}

/**
 * Coarse "Browser · OS" label from a User-Agent, best-effort. Returns '' when
 * nothing recognisable is present (UA parsing is deliberately shallow).
 * @param {string} ua
 * @returns {string} A "Browser · OS" label, or '' when nothing is recognised.
 */
function clientDeviceLabel(ua) {
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return [br, os].filter(Boolean).join(' · ');
}

/**
 * Fetch a QR-code SVG for `url` from the server and inline it into `host`.
 * Inline (rather than <img>) so `fill="currentColor"` inherits the surrounding
 * text colour. The SVG is transparent (no background rect).
 * @param {HTMLElement} host
 * @param {string} url
 */
async function loadQRCodeSVG(host, url) {
  try {
    const res = await fetch(`/api/connectivity/qr?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    host.innerHTML = await res.text();
  } catch {
    // Network failure: leave the host empty rather than throwing.
  }
}

/** Polling interval (ms) for refreshing the MCP servers tab while it's open. */
const MCP_POLL_MS = 2000;

/**
 * One MCP server's config entry, as stored in a scope's mcp.json map.
 * @typedef {object} McpServerConfig
 * @property {string} command - Executable to launch (stdio transport)
 * @property {string[]} [args] - Command arguments (each may contain spaces)
 * @property {Record<string,string>} [env] - Environment variables (secret values)
 * @property {string} [transport] - Transport kind; defaults to stdio
 * @property {string} [url] - Endpoint URL for non-stdio transports
 * @property {boolean} [enabled] - Whether the manager should run this server
 * @property {boolean} [lazyTools] - Defer tool discovery until first use
 */

/**
 * Format an MCP server's tool count and schema-token cost as a short one-liner,
 * e.g. "3 tools · ~1.2k tokens/request" or "1 tool". The token clause is dropped
 * when the server reports zero schema tokens (e.g. before discovery completes).
 * @param {{toolCount?: number, schemaTokens?: number}} status - A McpServerStatus
 * @returns {string} The formatted "N tools · ~Xk tokens/request" summary.
 */
export function formatMcpTokenCost(status) {
  const n = (status && status.toolCount) || 0;
  const t = (status && status.schemaTokens) || 0;
  const tok = t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
  return `${n} tool${n === 1 ? '' : 's'}${t ? ` · ~${tok} tokens/request` : ''}`;
}

/**
 * Validate a proposed MCP server name. Names become part of the LLM tool id
 * (`mcp__<name>__<tool>`), so they must be non-empty, free of whitespace and
 * slashes, unique within their scope, and not collide with the built-in
 * `juggler` prefix used by the CLI bridge.
 * @param {string} name - The proposed name (already trimmed by the caller is fine)
 * @param {string[]} [existingNames] - Names already used in the target scope
 * @returns {string} An error message, or '' when the name is valid.
 */
export function validateMcpServerName(name, existingNames) {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'Name is required.';
  if (/\s/.test(trimmed)) return 'Name cannot contain spaces.';
  if (trimmed.includes('/')) return 'Name cannot contain "/".';
  if (trimmed === 'juggler') return '"juggler" is reserved for the built-in tools.';
  if ((existingNames || []).includes(trimmed)) return `A server named "${trimmed}" already exists in this scope.`;
  return '';
}

/**
 * Convert the add/edit form's working state into a clean server config entry:
 * empty `args`/`env` are omitted, arg strings are kept verbatim (never split on
 * spaces), blank env keys are dropped, and `enabled` is coerced to a boolean.
 * @param {{command?: string, args?: string[], env?: Record<string,string>, enabled?: boolean}} form - The form's working state
 * @returns {McpServerConfig} The config entry to persist under the server's name.
 */
export function mcpFormToConfig(form) {
  /** @type {McpServerConfig} */
  const entry = { command: (form.command || '').trim() };
  const args = (form.args || []).filter((a) => a !== '' && a !== null && a !== undefined);
  if (args.length) entry.args = args;
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(form.env || {})) {
    const key = (k || '').trim();
    if (key) env[key] = v === null || v === undefined ? '' : String(v);
  }
  if (Object.keys(env).length) entry.env = env;
  entry.enabled = form.enabled !== false;
  return entry;
}

/**
 * Produce the whole-scope map to write back after adding or replacing one
 * server. `mcpSetConfig` rewrites the entire file for a scope, so callers must
 * always send the full map — this clones the current one and sets one key.
 * @param {Record<string, McpServerConfig>} map - The current scope map
 * @param {string} name - Server name to add or replace
 * @param {McpServerConfig} entry - The server's config entry
 * @returns {Record<string, McpServerConfig>} A new map with `name` set to `entry`.
 */
export function mcpUpsertMap(map, name, entry) {
  return { ...(map || {}), [name]: entry };
}

/**
 * Produce the whole-scope map with one server removed.
 * @param {Record<string, McpServerConfig>} map - The current scope map
 * @param {string} name - Server name to delete
 * @returns {Record<string, McpServerConfig>} A new map without `name`.
 */
export function mcpDeleteMap(map, name) {
  const next = { ...(map || {}) };
  delete next[name];
  return next;
}

/**
 * Produce the whole-scope map with one server's `enabled` flag flipped, keeping
 * the rest of that server's config intact.
 * @param {Record<string, McpServerConfig>} map - The current scope map
 * @param {string} name - Server name to toggle
 * @param {boolean} enabled - Desired enabled state
 * @returns {Record<string, McpServerConfig>} A new map with the flag applied.
 */
export function mcpSetEnabledMap(map, name, enabled) {
  const src = map || {};
  return { ...src, [name]: /** @type {McpServerConfig} */ ({ ...(src[name] || {}), enabled }) };
}

/**
 * Which scope a listed server is edited in: "project" when a project-scope
 * entry of that name exists (project overrides global), else "global".
 * @param {{global?: object, project?: object}} config - The mcpGetConfig result
 * @param {string} name - Server name
 * @returns {'global'|'project'} The scope that owns this server's config.
 */
export function mcpScopeOf(config, name) {
  const proj = (config && config.project) || {};
  return Object.prototype.hasOwnProperty.call(proj, name) ? 'project' : 'global';
}

/**
 * SettingsPanel - Configuration panel
 *
 * Displays a tabbed interface: Provider API Keys, Connectivity, and
 * Extensions.
 */
class SettingsPanel extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.currentTab = 'providers';
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {boolean} @private */
    this._hasLoadedOnce = false;
    /** @type {number|undefined} @private */
    this._connectivityPollId = undefined;
    /** @type {number|undefined} @private - setInterval id for the Logs tab's tail poll. */
    this._logsPollId = undefined;
    /** @type {any[]} @private - Session log files reported by GET /api/logs. */
    this._logFiles = [];
    /** @type {string} @private - Absolute path of the log file shown in the viewer. */
    this._selectedLogPath = '';
    /** @type {number} @private - Byte offset already loaded into the viewer for the selected log. */
    this._logOffset = 0;
    /** @type {string} @private - Signature of the last-rendered picker file set (rebuild guard). */
    this._logFilesKey = '';
    /** @type {string} @private - Path the file-path control was last rendered for (rebuild guard). */
    this._filePathPath = '';
    /** @type {boolean} @private - True while a log tail fetch is in flight, so overlapping poll ticks don't double-append. */
    this._logTailBusy = false;
    /** @type {{lanEnabled: boolean, lanURLs: string[], tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, tunnelRelay: boolean, wanModes: WANMode[], clientCount: number, clients: ClientDescriptor[]}} @private */
    this.connectivity = { lanEnabled: false, lanURLs: [], tunnelEnabled: false, tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [], clientCount: 1, clients: [] };
    /** @type {((data: any) => void)|null} @private - Live update of the connected-client count while the panel is open. */
    this._onClientsChanged = null;
    /** @type {string} @private - Inline error from the most recent WAN action, set at the action site and cleared at the start of the next one. */
    this._wanError = '';
    /** @type {{provider: string, model: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {((e: Event) => void)|null} @private - Re-syncs the Notifications controls when prefs change elsewhere (e.g. the header bell). */
    this._onAttentionPrefs = null;
    /** @type {HTMLElement|null} @private - The horizontally-scrollable tab strip; watched to drive its edge-fade affordance. */
    this._tabScrollEl = null;
    /** @type {(() => void)|null} @private */
    this._onTabScroll = null;
    /** @type {ResizeObserver|null} @private */
    this._tabResizeObserver = null;
    /** @type {number|undefined} @private - setInterval id for the MCP tab's status poll. */
    this._mcpPollId = undefined;
    /** @type {import('../services/ops-api.js').McpServerStatus[]} @private - Live server status (source of truth for rows). */
    this._mcpServers = [];
    /** @type {{global: Record<string, McpServerConfig>, project: Record<string, McpServerConfig>, hasProject: boolean}} @private - Raw per-scope config maps (source of truth for editing). */
    this._mcpConfig = { global: {}, project: {}, hasProject: false };
    /** @type {any} @private - null = list view; an object = the add/edit form's working state. */
    this._mcpEditing = null;
    /** @type {string} @private - Name whose stderr-log disclosure is open ('' = none). */
    this._mcpLogFor = '';
    /** @type {string|null} @private - Cached stderr text for the open log disclosure; null = still loading. */
    this._mcpLogText = null;
    /** @type {boolean} @private - True while an MCP refresh fetch is in flight (overlap guard). */
    this._mcpBusy = false;
    /** @type {string} @private - Inline error from the most recent MCP action, cleared on the next refresh/action. */
    this._mcpError = '';
    /** @type {(() => void)|null} @private - Live refresh of the MCP tab off the plugin-changed broadcast. */
    this._onMcpChanged = null;
  }

  connectedCallback() {
    this.render();
    this.setupListeners();

    // Keep the Connectivity tab's connected-clients box live as viewers join or
    // leave, independent of the 2 s poll (which only runs while that tab is open).
    // Only the clients section re-renders — never the whole form — so open LAN/WAN
    // QR images and controls are left untouched.
    this._onClientsChanged = (/** @type {{count: number, clients: ClientDescriptor[]}} */ data) => {
      this.connectivity.clientCount = data.count;
      this.connectivity.clients = data.clients || [];
      if (this.currentTab === 'connectivity' && this._hasLoadedOnce) {
        this._refreshClientsSection();
      }
    };
    wsService.on('clients-changed', this._onClientsChanged);

    // Keep the MCP servers tab live: every config write / lifecycle change
    // auto-reconciles Go-side and broadcasts plugin-changed, so re-fetch and
    // re-render the list when that fires while the tab is open (this is what
    // flips a server starting→running without the user clicking). The 2 s poll
    // is a backstop for any missed broadcast.
    this._onMcpChanged = () => {
      if (this.currentTab === 'mcp' && this._hasLoadedOnce) {
        this._refreshMcpServers();
      }
    };
    wsService.on('plugin-changed', this._onMcpChanged);
  }

  disconnectedCallback() {
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    clearInterval(this._mcpPollId);
    this._mcpPollId = undefined;
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    if (this._onAttentionPrefs) {
      window.removeEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
      this._onAttentionPrefs = null;
    }
    if (this._onInfoCardsChanged) {
      window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
      this._onInfoCardsChanged = null;
    }
    if (this._onClientsChanged) {
      wsService.off('clients-changed', this._onClientsChanged);
      this._onClientsChanged = null;
    }
    if (this._onMcpChanged) {
      wsService.off('plugin-changed', this._onMcpChanged);
      this._onMcpChanged = null;
    }
    if (this._tabScrollEl && this._onTabScroll) {
      this._tabScrollEl.removeEventListener('scroll', this._onTabScroll);
    }
    this._onTabScroll = null;
    if (this._tabResizeObserver) {
      this._tabResizeObserver.disconnect();
      this._tabResizeObserver = null;
    }
    this._tabScrollEl = null;
  }

  /**
   * Render the settings panel
   * @private
   */
  render() {
    this.innerHTML = `
            <modal-backdrop class="settings-backdrop" id="settings-backdrop"></modal-backdrop>
            <modal-panel class="settings-container">
                <nav class="settings-tabs">
                    <div class="settings-tabs-scroll">
                        <button class="settings-tab active" data-tab="providers">Provider API Keys</button>
                        <button class="settings-tab" data-tab="default-model">Default model</button>
                        <button class="settings-tab" data-tab="connectivity">Connectivity</button>
                        <button class="settings-tab" data-tab="extensions">Extensions</button>
                        <button class="settings-tab" data-tab="mcp">MCP servers</button>
                        <button class="settings-tab" data-tab="notifications">Notifications</button>
                        <button class="settings-tab" data-tab="info-cards">Info cards</button>
                        <button class="settings-tab" data-tab="shortcuts">Keyboard shortcuts</button>
                        <button class="settings-tab" data-tab="logs">Logs</button>
                    </div>
                    <button class="close-button" id="settings-close" title="Close" aria-label="Close">×</button>
                </nav>

                <div class="settings-loading" id="settings-loading">
                    <juggler-spinner style="--size: 2.5rem"></juggler-spinner>
                    <div class="settings-loading-text">Loading settings...</div>
                </div>

                <main class="settings-content">
                    <section class="settings-tab-content active" id="tab-providers">
                        <p class="settings-description">
                            To set a new API key, enter it below and click "Save API Keys".
                            <br/>
                            These are stored in <code>~/.juggler/credentials.json</code>.
                        </p>

                        <div class="settings-form" id="provider-form">
                            <div id="provider-fields-container"></div>
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-default-model">
                        <p class="settings-description">
                            The model assigned to each new conversation when it is created.
                            Changing it never affects conversations that already exist.
                            <br/>
                            Stored in <code>~/.juggler/default-model.json</code>.
                        </p>

                        <div class="settings-form" id="default-model-form">
                            <div id="default-model-field-container"></div>
                        </div>
                    </section>

                     <section class="settings-tab-content" id="tab-extensions">
                         <plugin-catalog></plugin-catalog>
                    </section>

                    <section class="settings-tab-content" id="tab-mcp">
                        <p class="settings-description">
                            Connect external tools via the Model Context Protocol. Servers run as
                            local subprocesses; their tools appear to the assistant with approval.
                        </p>
                        <div class="settings-form" id="mcp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-connectivity">
                        <p class="settings-description">
                            Control who can reach this Juggler instance.
                        </p>
                        <div class="settings-form" id="connectivity-form">
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-notifications">
                        <div class="settings-form" id="notifications-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-info-cards">
                        <p class="settings-description">
                            Info cards fill the empty space above the Bin in the sidebar
                            when there's room. Choose which ones to show &mdash; the tabs
                            always take priority.
                        </p>
                        <div class="settings-form" id="info-cards-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-shortcuts">
                        <p class="settings-description">
                            Keyboard shortcuts for common actions. Modifier keys are shown
                            for ${navigator.platform && /mac|iphone|ipad/i.test(navigator.platform) ? 'macOS' : 'this platform'}.
                        </p>
                        <div class="settings-form" id="shortcuts-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-logs">
                        <p class="settings-description">
                            Logs for the current session. Pick a file to view it live &mdash; it
                            updates as the app writes to it. To report a bug, reveal the file and
                            zip its folder.
                        </p>
                        <div class="settings-form" id="logs-form">
                            <div class="logs-empty" id="logs-empty">No log files yet.</div>
                            <div class="logs-controls" id="logs-controls" hidden>
                                <label class="logs-picker-label" for="logs-picker">Log file</label>
                                <select class="logs-picker" id="logs-picker"></select>
                            </div>
                            <div class="logs-filepath" id="logs-filepath"></div>
                            <pre class="logs-viewer" id="logs-viewer" tabindex="0" hidden></pre>
                        </div>
                    </section>
                </main>
            </modal-panel>
        `;
    // Notifications needs no server fetch (per-window localStorage prefs), so
    // build it immediately rather than waiting on loadConfig like the other tabs.
    this.renderNotificationsForm();
    // Shortcuts are read straight from the KeyShortcutManager — no server fetch.
    this.renderShortcutsForm();
    // Info-card toggles are per-window prefs (localStorage) — no server fetch.
    this.renderInfoCardsForm();
  }

  /**
   * Setup event listeners
   * @private
   */
  setupListeners() {
    // Close button
    const closeButton = this.querySelector('#settings-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => this.close());
    }

    // Close on backdrop click
    const backdrop = this.querySelector('#settings-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }

    // Tab switching
    const tabButtons = this.querySelectorAll('.settings-tab');
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tab = /** @type {HTMLElement} */ (button).dataset.tab;
        this.switchTab(tab);
      });
    });

    // Logs tab: switch the viewer to whichever log the picker selects. The
    // <select> is persistent (only its <option>s are rebuilt), so this one
    // listener survives every list refresh.
    const logsPicker = this.querySelector('#logs-picker');
    if (logsPicker) {
      logsPicker.addEventListener('change', (e) =>
        this._selectLog(/** @type {HTMLSelectElement} */ (e.target).value));
    }

    // Drive the tab strip's edge-fade affordance from its actual scroll state,
    // so a left/right fade appears only when there really are tabs hidden past
    // that edge (see .settings-tabs-scroll in components.css). The ResizeObserver
    // recomputes when the panel is first shown (0→real width) or the viewport
    // changes; the scroll listener handles swiping and scrollIntoView jumps.
    const tabScroll = this.querySelector('.settings-tabs-scroll');
    if (tabScroll) {
      this._tabScrollEl = /** @type {HTMLElement} */ (tabScroll);
      this._onTabScroll = () => this._updateTabOverflow();
      tabScroll.addEventListener('scroll', this._onTabScroll, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        this._tabResizeObserver = new ResizeObserver(() => this._updateTabOverflow());
        this._tabResizeObserver.observe(tabScroll);
      }
      this._updateTabOverflow();
    }
  }

  /**
   * Toggle the tab strip's start/end edge fades to match what's scrolled out of
   * view, so hidden tabs past an edge are always signalled. Driven by the
   * strip's own scroll/resize events, never from a render path.
   * @private
   */
  _updateTabOverflow() {
    const el = this._tabScrollEl;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    el.classList.toggle('overflow-start', el.scrollLeft > 1);
    el.classList.toggle('overflow-end', el.scrollLeft < maxScroll - 1);
  }

  /**
   * Switch to a different tab
   * @param {string|undefined} tabName - The tab to switch to
   * @private
   */
  switchTab(tabName) {
    if (!tabName) return;

    // Back-compat: the Extensions tab was historically the "context-items" tab
    // (it hosts <plugin-catalog>). Accept the old id so any saved/deep-linked
    // caller still lands on the right tab.
    if (tabName === 'context-items') tabName = 'extensions';

    this.currentTab = tabName;

    // Update tab buttons
    const tabButtons = this.querySelectorAll('.settings-tab');
    tabButtons.forEach(button => {
      const htmlButton = /** @type {HTMLElement} */ (button);
      if (htmlButton.dataset.tab === tabName) {
        button.classList.add('active');
        // Bring an off-screen tab into the horizontally-scrollable strip (the
        // strip swipes on narrow screens). Guarded for jsdom, where
        // scrollIntoView is absent.
        htmlButton.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
      } else {
        button.classList.remove('active');
      }
    });

    // Update tab content
    const tabContents = this.querySelectorAll('.settings-tab-content');
    tabContents.forEach(content => {
      if (content.id === `tab-${tabName}`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    // Per-tab background pollers: stop whichever was running, then arm the one
    // for the tab being shown, so neither polls while its tab is hidden.
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    clearInterval(this._mcpPollId);
    this._mcpPollId = undefined;

    if (tabName === 'connectivity' && this._hasLoadedOnce) {
      this.refreshConnectivity();
      this._connectivityPollId = setInterval(() => this.refreshConnectivity(), CONNECTIVITY_POLL_MS);
    } else if (tabName === 'logs') {
      // The Logs tab fetches its own data (independent of loadConfig), so it
      // works even when opened directly on first load.
      this._openLogsTab();
      this._logsPollId = setInterval(() => this._pollLogTail(), LOGS_POLL_MS);
    } else if (tabName === 'mcp') {
      // The MCP tab fetches its own data (via ops), so it works when opened
      // directly. The poll catches starting→running/failed transitions even if
      // a plugin-changed broadcast is missed.
      this._refreshMcpServers();
      this._mcpPollId = setInterval(() => this._refreshMcpServers(), MCP_POLL_MS);
    }
  }

  /**
   * Open the settings panel
   * @param {string} [tab] - Optional tab to switch to on open
   */
  async open(tab) {
    const isFirstLoad = !this._hasLoadedOnce;

    // Show panel - only show loading state on first load
    this.classList.add('show');
    if (isFirstLoad) {
      this.classList.remove('loaded');
    }

    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this.close());
    }

    // Switch to specified tab if provided (before loading so tab is ready)
    if (tab) {
      this.switchTab(tab);
    }

    // Load config (only fetches from API on first load)
    if (isFirstLoad) {
      await this.loadConfig();
      this._hasLoadedOnce = true;
      this.classList.add('loaded');
    }
  }

  /**
   * Close the settings panel
   */
  close() {
    this.classList.remove('show');
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    clearInterval(this._mcpPollId);
    this._mcpPollId = undefined;
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }

    // Drop any in-progress MCP add/edit form and open log/error so a reopen
    // starts fresh at the list — the generic text-input clear below would
    // otherwise blank the form's fields while leaving its working state set.
    this._mcpEditing = null;
    this._mcpLogFor = '';
    this._mcpLogText = null;
    this._mcpError = '';

    // Clear any unsaved input fields and update buttons
    const inputs = this.querySelectorAll('input[type="text"]');
    inputs.forEach(input => {
      /** @type {HTMLInputElement} */ (input).value = '';
    });
    this.updateAllButtons();
  }

  /**
   * Load current configuration from backend
   * @param {boolean} [renderFields=true] - Whether to render form fields (false when just updating status)
   * @private
   */
  async loadConfig(renderFields = true) {
    try {
      // Load config, providers, the default model, and connectivity state
      const [configResponse, providersResponse, defaultModelResponse, connectivityResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/providers'),
        fetch('/api/default-model'),
        fetch('/api/connectivity'),
      ]);

      if (!configResponse.ok) {
        throw new Error('Failed to load config');
      }
      if (!providersResponse.ok) {
        throw new Error('Failed to load providers');
      }

      this.config = await configResponse.json();
      const providersData = await providersResponse.json();
      this.providers = (providersData.providers || []).sort((/** @type {any} */ a, /** @type {any} */ b) =>
        a.displayName.localeCompare(b.displayName)
      );
      if (defaultModelResponse.ok) {
        this.defaultModel = await defaultModelResponse.json();
      }
      if (connectivityResponse.ok) {
        this.connectivity = await connectivityResponse.json();
      }

      // Generate provider form fields dynamically (only on initial load)
      if (renderFields) {
        this.renderProviderFields();
        this.renderDefaultModelField();
        this.renderConnectivityFields();
      }

      // Update all buttons and placeholders
      this.updateAllButtons();
    } catch (error) {
      console.error('Failed to load config:', error);
      if (window.showAlert) {
        await window.showAlert('Failed to load configuration', 'Error');
      }
    }
  }

  /**
   * Render provider form fields dynamically based on available providers
   * @private
   */
  renderProviderFields() {
    const container = this.querySelector('#provider-fields-container');
    if (!container) return;

    // Clear existing fields
    container.innerHTML = '';

    // Generate a field for each provider
    for (const provider of this.providers) {
      if (provider.authType === 'oauth_bearer') {
        this._buildOAuthProviderField(provider, container);
        continue;
      }

      // Keyless provider (like Claude Code, Ollama) - show toggle instead of API key input
      if (provider.configKeyName === '') {
        this._buildKeylessProviderField(provider, container);
        continue;
      }

      // API key provider - show input field
      this._buildApiKeyProviderField(provider, container);
    }
  }

  /**
   * Build the field for an OAuth (bearer) provider: name, optional
   * description and a sign-in status line, with no API-key input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildOAuthProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = provider.available
      ? (provider.authHint || 'Signed in')
      : (provider.authHint || 'Sign in to continue');
    controlColumn.appendChild(status);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for a keyless provider (like Claude Code, Ollama): name,
   * optional description and an enable/disable toggle in place of an API-key
   * input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildKeylessProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'provider-toggle-wrapper';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `${provider.name}-toggle`;
    toggle.className = 'provider-toggle';
    toggle.checked = provider.available;

    const toggleLabel = document.createElement('label');
    toggleLabel.setAttribute('for', toggle.id);
    toggleLabel.className = 'toggle-switch';

    toggle.addEventListener('change', async () => {
      await this.toggleProviderEnabled(provider, toggle.checked);
    });

    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(toggleLabel);
    controlColumn.appendChild(toggleWrapper);

    // Ollama: expose the daemon host so users can point at a
    // non-default (LAN / remote) Ollama instance without
    // restarting the app. Saved as the `ollama_host` raw
    // credential; backend re-fetches the model list on change.
    if (provider.name === 'ollama') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'ollama-host-input',
        placeholder: 'http://localhost:11434',
        configField: 'ollamaHost',
        configKey: 'ollama_host',
        defaultLabel: 'http://localhost:11434',
      }));
    }

    // llama.cpp: expose the llama-server host so users can point at a
    // non-default (LAN / remote / custom port) instance without restarting
    // the app. Saved as the `llamacpp_host` raw credential; backend
    // re-fetches the model list (and its context window, queried live from
    // the server's /props) on change.
    if (provider.name === 'llamacpp') {
      controlColumn.appendChild(this._buildHostRow({
        inputId: 'llamacpp-host-input',
        placeholder: 'http://127.0.0.1:8080',
        configField: 'llamacppHost',
        configKey: 'llamacpp_host',
        defaultLabel: 'http://127.0.0.1:8080',
      }));
    }

    // Claude Code: let users point at the `claude` CLI explicitly for obscure
    // install locations auto-detection can't reach. Saved as the
    // `claudecode_binary_path` raw credential; a non-empty save also enables
    // the provider so it becomes selectable without restarting.
    if (provider.name === 'claudecode') {
      controlColumn.appendChild(this._buildClaudeBinaryRow(provider, toggle));
    }

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for an API-key provider: name, optional "Get API Key"
   * link, the key input with save/delete buttons, active badge and source
   * hint.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildApiKeyProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const fieldId = `${provider.name}-key`;
    const saveButtonId = `${provider.name}-save`;
    const deleteButtonId = `${provider.name}-delete`;

    const nameLabel = document.createElement('label');
    nameLabel.className = 'provider-name';
    nameLabel.setAttribute('for', fieldId);
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    // "Get API Key" link
    if (provider.apiKeyURL) {
      const keyLink = document.createElement('a');
      keyLink.href = provider.apiKeyURL;
      keyLink.target = '_blank';
      keyLink.rel = 'noopener noreferrer';
      keyLink.className = 'get-api-key-link';
      keyLink.textContent = 'Get API Key \u2192';
      infoColumn.appendChild(keyLink);
    }

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId;
    input.name = provider.configKeyName;
    input.placeholder = '...';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;

    const activeBadge = document.createElement('span');
    activeBadge.id = `${provider.name}-active-badge`;
    activeBadge.className = 'provider-active-badge';
    activeBadge.style.display = 'none';
    activeBadge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg><span>key is active</span>';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.id = saveButtonId;
    saveButton.className = 'settings-btn primary small';
    saveButton.textContent = 'Save';
    saveButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.id = deleteButtonId;
    deleteButton.className = 'settings-btn danger small';
    deleteButton.textContent = 'Delete';
    deleteButton.style.display = 'none';

    // Add input event listener to update buttons
    input.addEventListener('input', () => {
      this.updateAllButtons();
    });

    // Save button handler
    saveButton.addEventListener('click', async () => {
      await this.saveProviderKey(provider, input.value.trim());
    });

    // Delete button handler
    deleteButton.addEventListener('click', async () => {
      await this.deleteProviderKey(provider);
    });

    buttonGroup.appendChild(saveButton);
    buttonGroup.appendChild(deleteButton);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(activeBadge);
    inputWrapper.appendChild(buttonGroup);

    const sourceHint = document.createElement('div');
    sourceHint.id = `${provider.name}-source`;
    sourceHint.className = 'key-source-hint';
    sourceHint.style.display = 'none';

    controlColumn.appendChild(inputWrapper);
    controlColumn.appendChild(sourceHint);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Render the single "Default model" picker. The dropdown offers an
   * "Automatic" option (server picks a preferred available model) plus every
   * model grouped by provider. The current default is preselected; changing
   * it persists immediately via PUT /api/default-model.
   * @private
   */
  renderDefaultModelField() {
    const container = this.querySelector('#default-model-field-container');
    if (!container) return;
    container.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = 'New conversations use';
    infoColumn.appendChild(nameLabel);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'default-model-select';
    select.id = 'default-model-select';

    const current = this.defaultModel || { provider: '', model: '', explicit: false };
    const explicit = !!current.explicit;
    const currentValue = explicit && current.provider && current.model
      ? `${current.provider} ${current.model}`
      : '';
    let currentValueIsValid = false;

    // "Automatic" — clears the stored value; the server then picks the
    // preferred available model when seeding a new conversation.
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = 'Automatic';
    if (!explicit) autoOpt.selected = true;
    select.appendChild(autoOpt);

    for (const provider of this.providers) {
      if (!provider.modelsWithContext || provider.modelsWithContext.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = provider.available
        ? provider.displayName
        : `${provider.displayName} (no API key)`;
      for (const m of /** @type {Array<{id: string, displayName?: string}>} */ (provider.modelsWithContext)) {
        const opt = document.createElement('option');
        const val = `${provider.name} ${m.id}`;
        opt.value = val;
        opt.textContent = modelLabel(m.displayName, m.id);
        if (val === currentValue) {
          opt.selected = true;
          currentValueIsValid = true;
        }
        group.appendChild(opt);
      }
      select.appendChild(group);
    }

    // An explicitly-set model that is no longer in the provider list:
    // surface it as a selected "unavailable" option so the state is visible.
    if (currentValue && !currentValueIsValid) {
      const orphanGroup = document.createElement('optgroup');
      orphanGroup.label = 'Currently set (unavailable)';
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.selected = true;
      const refProvider = this.providers.find((/** @type {any} */ p) => p.name === current.provider);
      opt.textContent = `${refProvider ? modelLabelFromList(this.providers, refProvider.name, current.model) : `${current.provider} / ${current.model}`} — unavailable`;
      orphanGroup.appendChild(opt);
      select.insertBefore(orphanGroup, select.firstChild ? select.firstChild.nextSibling : null);
    }

    select.addEventListener('change', () => this._saveDefaultModel(select.value));

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = this._defaultModelStatusText(current);

    controlColumn.appendChild(select);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * @param {{provider: string, model: string, explicit?: boolean}} ref
   * @returns {string} short status describing the current default-model state
   * @private
   */
  _defaultModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      if (ref && ref.provider && ref.model) {
        return `Automatic — currently ${modelLabelFromList(this.providers, ref.provider, ref.model)}.`;
      }
      return 'Automatic — no provider is configured yet.';
    }
    const p = this.providers.find((/** @type {any} */ pp) => pp.name === ref.provider);
    if (!p) return 'Provider not registered.';
    if (!p.available) return p.authType === 'oauth_bearer'
      ? (p.authHint || 'Provider is unavailable. Sign in to continue.')
      : 'Provider is configured but has no API key.';
    const hasModel = p.modelsWithContext && p.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === ref.model);
    if (p.modelsWithContext && !hasModel) {
      return 'Model is not in the provider’s current model list.';
    }
    return 'Active.';
  }

  /**
   * Persist the chosen default model. An empty value clears it (Automatic).
   * @param {string} value - "<provider> <model>" or "" for Automatic
   * @private
   */
  async _saveDefaultModel(value) {
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
    }
    try {
      const response = await fetch('/api/default-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      // Reflect the saved state locally and re-render so the status hint
      // and selection update without a full reload.
      this.defaultModel = { provider: body.provider, model: body.model, explicit: !!(body.provider && body.model) };
      this.renderDefaultModelField();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      if (window.showAlert) {
        await window.showAlert('Failed to save default model.', 'Error');
      }
    }
  }

  /**
   * Build a host-URL input row for a keyless local-server provider (Ollama,
   * llama.cpp). Loads the current value from `this.config[configField]`;
   * saves via /api/config on blur or Enter. Empty value clears the override
   * (falls back to env var or the server-side default).
   * @param {{inputId: string, placeholder: string, configField: string, configKey: string, defaultLabel: string}} opts
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildHostRow({ inputId, placeholder, configField, configKey, defaultLabel }) {
    // Wrapper is a no-op fragment-like div so the caller can append a
    // single child; visual layout comes from the parent `.provider-control`
    // column (`flex-direction: column; gap: 0.375rem`).
    const row = document.createElement('div');

    // Reuse the same wrapper as API-key rows so the input picks up the
    // shared border / focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config)[configField] || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config)[configField] || '')) return;
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [configKey]: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config)[configField] = value;
        status.textContent = value
          ? `Saved. Pointing at ${value}.`
          : `Saved. Using default (${defaultLabel}).`;
      } catch (err) {
        console.error(`[SettingsPanel] Failed to save host for ${configField}:`, err);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    return row;
  }

  /**
   * Build the CLI binary-path input row for the Claude Code provider. Loads the
   * current value from `this.config.claudecodeBinaryPath`; saves via /api/config
   * on blur or Enter. Empty clears the override (falls back to JUGGLER_CLAUDE_PATH
   * then auto-detection on the server). A non-empty save also enables the
   * provider so it becomes selectable without a restart.
   * @param {any} provider - Provider info object (for the enable call)
   * @param {HTMLInputElement} toggle - The provider's enable checkbox, kept in sync
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildClaudeBinaryRow(provider, toggle) {
    const row = document.createElement('div');

    // Reuse the API-key row wrapper so the input inherits the shared border /
    // focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'claudecode-binary-input';
    input.placeholder = 'CLI path (leave blank for auto)';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).claudecodeBinaryPath || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).claudecodeBinaryPath || '')) return;
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claudecode_binary_path: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config).claudecodeBinaryPath = value;
        if (value) {
          // A user pointing us at a binary means "use Claude Code" — enable it
          // (and reflect that in the toggle) so the model is immediately
          // selectable without a separate click.
          if (!toggle.checked) {
            toggle.checked = true;
            await this.toggleProviderEnabled(provider, true);
          }
          status.textContent = `Saved. Using ${value}.`;
        } else {
          status.textContent = 'Saved. Auto-detecting the claude CLI.';
        }
      } catch (err) {
        console.error('[SettingsPanel] Failed to save Claude Code binary path:', err);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    return row;
  }

  /**
   * Toggle enabled state for a keyless provider
   * @param {any} provider - Provider info object
   * @param {boolean} enabled - Whether to enable or disable the provider
   * @private
   */
  async toggleProviderEnabled(provider, enabled) {
    try {
      const response = await fetch('/api/config/provider-enabled', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: provider.name,
          enabled: enabled
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update provider');
      }

      // Refresh model selector to pick up new provider
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to toggle provider:', error);
      // Revert toggle on error
      const toggle = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-toggle`));
      if (toggle) {
        toggle.checked = !enabled;
      }
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to update provider',
          'Error'
        );
      }
    }
  }

  /**
   * Update all provider buttons and placeholders based on current state
   * @private
   */
  updateAllButtons() {
    const configObj = /** @type {any} */ (this.config);

    for (const provider of this.providers) {
      const hasKey = configObj.keys?.[provider.name] || false;
      const input = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-key`));
      const saveButton = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-save`));
      const deleteButton = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-delete`));
      const sourceHint = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-source`));
      const activeBadge = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-active-badge`));

      const inputHasValue = !!(input && input.value.trim() !== '');

      // Update placeholder based on key source
      if (input) {
        if (provider.keySource === 'env') {
          input.placeholder = `using $${provider.envVarName}`;
          input.disabled = true;
        } else if (hasKey) {
          input.placeholder = '';
          input.disabled = false;
        } else {
          input.placeholder = 'enter a key';
          input.disabled = false;
        }
      }

      // Show "key is active" badge when a credentials-file key exists and the
      // input is empty (i.e. user isn't currently typing a replacement).
      if (activeBadge) {
        const showBadge = hasKey && provider.keySource !== 'env' && !inputHasValue;
        activeBadge.style.display = showBadge ? 'inline-flex' : 'none';
      }

      // Update source hint
      if (sourceHint) {
        if (provider.keySource === 'env') {
          sourceHint.textContent = `Using environment variable $${provider.envVarName}`;
          sourceHint.style.display = 'block';
        } else {
          sourceHint.textContent = '';
          sourceHint.style.display = 'none';
        }
      }

      // Show save button only if input has value and key is not from env var
      if (saveButton) {
        const hasInputValue = input && input.value.trim() !== '';
        saveButton.style.display = (hasInputValue && provider.keySource !== 'env') ? 'block' : 'none';
      }

      // Show delete button only if key exists in credentials file (not env var)
      if (deleteButton) {
        deleteButton.style.display = (hasKey && provider.keySource !== 'env') ? 'block' : 'none';
      }
    }
  }

  /**
   * Save API key for a specific provider
   * @param {any} provider - Provider info object
   * @param {string} apiKey - API key to save
   * @returns {Promise<void>} Completes when the API key is saved
   * @private
   */
  async saveProviderKey(provider, apiKey) {
    if (!apiKey) return;

    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          [provider.configKeyName]: apiKey
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save API key');
      }

      // Clear the input so the UI returns to the "key is active" state
      const input = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-key`));
      if (input) input.value = '';

      // Reload config from server to get actual state (don't re-render fields)
      await this.loadConfig(false);

      // Refresh model selector to pick up new provider
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to save API key:', error);
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to save API key',
          'Error'
        );
      }
    }
  }

  /**
   * Fetch current connectivity state and re-render the connectivity fields.
   * @param {boolean} [force=false] - Re-render even when the server state is
   *   unchanged. Action handlers pass true so a busy button resets and any
   *   inline error shows even on a no-op result; the background poll leaves it
   *   false so an unchanged tick is a no-op.
   * @private
   */
  async refreshConnectivity(force = false) {
    try {
      const res = await fetch('/api/connectivity');
      if (!res.ok) return;
      const next = await res.json();
      const prev = this.connectivity;
      this.connectivity = next;
      // The connected-clients section owns no inputs or QR images, so refresh it
      // every tick — that keeps the relative "connected N ago" times and the
      // membership current without a full-form rebuild.
      this._refreshClientsSection();
      // Skip the full re-render if nothing observable in the LAN/WAN form has
      // changed. Without this the 2 s poll wipes the connectivity form
      // (innerHTML = '') every tick, killing input focus and re-loading QR
      // images. The client list is excluded here — it's handled just above.
      const serialise = (/** @type {any} */ c) => JSON.stringify({
        lanEnabled: c.lanEnabled,
        lanURLs: c.lanURLs || [],
        tunnelEnabled: c.tunnelEnabled,
        tunnelURL: c.tunnelURL || '',
        tunnelMode: c.tunnelMode || '',
        tunnelRelay: !!c.tunnelRelay,
        wanModes: c.wanModes || [],
      });
      if (!force && prev && serialise(prev) === serialise(next)) return;
      this.renderConnectivityFields();
    } catch (e) {
      console.error('Failed to refresh connectivity:', e);
    }
  }

  /**
   * Render the Notifications tab: per-window attention prefs (sound, notify) plus
   * abstract rotary controls for the chime voice. Reads initial values from
   * {@link getAttentionPrefs} (localStorage, no server fetch) and keeps the
   * controls in sync with the header bell via {@link ATTENTION_PREFS_EVENT} — so
   * the sound toggle and the bell always reflect the same `sound` pref.
   * @private
   */
  renderNotificationsForm() {
    const container = this.querySelector('#notifications-form');
    if (!container) return;
    const prefs = getAttentionPrefs();

    container.innerHTML = '';

    // The conversation's tab in the bar ALWAYS flashes when it needs you — that's
    // not a setting. This toggle governs only the extra out-of-app signal, which
    // differs by mode: a Dock-icon bounce in the desktop app, or a marker on this
    // browser tab's title in a browser. The copy names whichever one applies.
    const desktopApp = document.documentElement.dataset.windowMode === '1';

    // ── On/off toggles ────────────────────────────────────────────────
    // The sound toggle is the same `sound` pref the header bell drives; flipping
    // either updates the other live via ATTENTION_PREFS_EVENT.
    const soundRow = this._buildAttentionToggleRow(
      'Play notification sounds',
      'Chime when a conversation you’re not viewing needs you. Also toggled by the header bell.',
      prefs.sound,
      (on) => setSoundEnabled(on),
    );
    const notifyRow = this._buildAttentionToggleRow(
      desktopApp ? 'Bounce the Dock icon' : 'Flash the browser tab',
      desktopApp
        ? 'When a conversation needs attention, bounce the app’s Dock icon.'
        : 'When a conversation needs attention, mark this browser tab’s title so you can spot it',
      prefs.notify,
      (on) => setNotifyEnabled(on),
    );
    container.appendChild(soundRow.row);
    container.appendChild(notifyRow.row);

    // ── Chime voice controls (abstract, 0..1) ──────────────────────────
    const chimeRow = this._buildChimeControlsRow(prefs.chime);
    container.appendChild(chimeRow.row);

    // Keep this tab's controls in sync when prefs change elsewhere (the header
    // bell, or another open settings panel). Registered once; removed in
    // disconnectedCallback.
    if (!this._onAttentionPrefs) {
      this._onAttentionPrefs = () => {
        const p = getAttentionPrefs();
        soundRow.input.checked = p.sound;
        notifyRow.input.checked = p.notify;
        chimeRow.controls.pattern.setValue(p.chime.pattern);
        chimeRow.controls.sound.setValue(p.chime.sound);
        chimeRow.controls.volume.setValue(p.chime.volume);
      };
      window.addEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
    }
  }

  /**
   * Render the Keyboard shortcuts tab: every command from the KeyShortcutManager,
   * grouped by category, each showing its current binding for this platform. The
   * manager is the single source of truth, so this needs no server fetch. Read-only
   * for now; each row's `.provider-control` is where a future "record binding"
   * affordance will live.
   * @private
   */
  renderShortcutsForm() {
    const container = this.querySelector('#shortcuts-form');
    if (!container) return;
    container.innerHTML = '';

    for (const group of keyShortcutManager.byCategory()) {
      const heading = document.createElement('h3');
      heading.className = 'settings-section-heading';
      heading.textContent = group.category;
      container.appendChild(heading);

      for (const def of group.shortcuts) {
        container.appendChild(this._buildShortcutRow(def));
      }
    }
  }

  /**
   * Render the Info cards tab: one enable/disable toggle per ambient sidebar card
   * (Tips, Git status, …), read from the InfoCardsManager. No server fetch — these
   * are per-window localStorage prefs. This is where the Tips toggle now lives
   * (moved out of Keyboard shortcuts).
   * @private
   */
  renderInfoCardsForm() {
    const container = this.querySelector('#info-cards-form');
    if (!container) return;
    container.innerHTML = '';

    for (const card of allInfoCards()) {
      const { row, input } = this._buildAttentionToggleRow(
        card.label,
        card.description,
        card.enabled,
        (on) => setCardEnabled(card.id, on),
      );
      input.dataset.cardId = card.id;
      container.appendChild(row);
    }

    // Keep the toggles in sync when a card is hidden/re-enabled elsewhere (the ×
    // on a sidebar card fires INFO_CARDS_CHANGED_EVENT). Rebind to the current
    // inputs; removed in disconnectedCallback.
    if (this._onInfoCardsChanged) window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
    this._onInfoCardsChanged = () => {
      container.querySelectorAll('input[data-card-id]').forEach((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        if (input.dataset.cardId) input.checked = isCardEnabled(input.dataset.cardId);
      });
    };
    window.addEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
  }

  /**
   * Build one shortcut row: label + description on the left, the current key on
   * the right as a `<kbd>`.
   * @param {import('../services/key-shortcut-manager.js').ShortcutDef} def - The shortcut definition.
   * @returns {HTMLElement} The row element.
   * @private
   */
  _buildShortcutRow(def) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field shortcut-row';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = def.label;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = def.description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control shortcut-control';
    const key = document.createElement('kbd');
    key.className = 'shortcut-keycap';
    key.textContent = keyShortcutManager.formatBinding(def.id);
    ctrl.appendChild(key);

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Build a labelled on/off toggle row matching the keyless-provider toggle
   * markup (`.provider-toggle-wrapper` > checkbox + `.toggle-switch` label).
   * @param {string} name - Control label.
   * @param {string} description - Sub-label hint.
   * @param {boolean} checked - Initial state.
   * @param {(on: boolean) => void} onChange - Called with the new state.
   * @returns {{row: HTMLElement, input: HTMLInputElement}} The row and its checkbox input.
   * @private
   */
  _buildAttentionToggleRow(name, description, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = name;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';
    const wrapper = document.createElement('div');
    wrapper.className = 'provider-toggle-wrapper';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'provider-toggle';
    input.id = `attention-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-toggle`;
    input.checked = checked;
    const label = document.createElement('label');
    label.setAttribute('for', input.id);
    label.className = 'toggle-switch';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.appendChild(input);
    wrapper.appendChild(label);
    ctrl.appendChild(wrapper);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, input };
  }

  /**
   * Build the chime customisation section: a Pattern popup and a Sound popup (the
   * curated menus), a Volume rotary, and the preview/reset buttons.
   * @param {import('../utils/chime-synth.js').ChimeParams} chime
   * @returns {{row: HTMLElement, controls: {pattern: {setValue: (v: string) => void}, sound: {setValue: (v: string) => void}, volume: {setValue: (v: number) => void}}}} The row and named controls.
   * @private
   */
  _buildChimeControlsRow(chime) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field chime-controls-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Chime';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Pick a pattern and sound, set the volume, and preview it.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control chime-controls';

    // The two curated popup menus (tune + timbre).
    const menus = document.createElement('div');
    menus.className = 'chime-menus';
    const pattern = this._buildChimeSelect('Pattern', chimePatterns(), chime.pattern, (v) => {
      setChimeParam('pattern', v);
      previewChime();
    });
    const sound = this._buildChimeSelect('Sound', chimeSounds(), chime.sound, (v) => {
      setChimeParam('sound', v);
      previewChime();
    });
    menus.appendChild(pattern.el);
    menus.appendChild(sound.el);
    ctrl.appendChild(menus);

    // The volume rotary sits with the preview/reset buttons on the action row.
    const actions = document.createElement('div');
    actions.className = 'chime-actions';
    const volume = this._buildChimeRotary('Volume', chime.volume, (v) => setChimeParam('volume', v), () => previewChime());
    actions.appendChild(volume.el);

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'settings-btn primary small chime-preview-btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => previewChime());
    actions.appendChild(previewBtn);

    // Reset every control to the default voice. The resulting prefs event
    // re-syncs the menus/rotary via _onAttentionPrefs, then we preview it.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'settings-btn small chime-reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      resetChimeParams();
      previewChime();
    });
    actions.appendChild(resetBtn);

    ctrl.appendChild(actions);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, controls: { pattern, sound, volume } };
  }

  /**
   * Build one labelled popup menu (a native `<select>`) for a curated chime list.
   * @param {string} name - Control label ('Pattern' | 'Sound').
   * @param {Array<{id: string, name: string}>} options - The menu entries.
   * @param {string} value - The currently selected id.
   * @param {(v: string) => void} onChange - Called with the new id on selection.
   * @returns {{el: HTMLElement, select: HTMLSelectElement, setValue: (v: string) => void}} The wrapper, select, and setter.
   * @private
   */
  _buildChimeSelect(name, options, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-select-field';

    const label = document.createElement('span');
    label.className = 'chime-select-label';
    label.textContent = name;

    const select = document.createElement('select');
    select.className = 'chime-select';
    select.setAttribute('aria-label', name);
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.name;
      select.appendChild(el);
    }
    const setValue = (/** @type {string} */ v) => {
      select.value = v;
      // A stored id no longer in the list (a removed entry) leaves value unset;
      // fall back to the first option so the menu always shows a real choice.
      if (!select.value && select.options.length) select.selectedIndex = 0;
    };
    setValue(value);
    select.addEventListener('change', () => onChange(select.value));

    wrap.appendChild(label);
    wrap.appendChild(select);
    return { el: wrap, select, setValue };
  }

  /**
   * Build one drag-up/down rotary chime control.
   * @param {string} name
   * @param {number} value
   * @param {(v: number) => void} onInput
   * @param {() => void} onRelease
   * @returns {{el: HTMLElement, input: HTMLInputElement, setValue: (v: number) => void}} The wrapper, hidden range input, and setter.
   * @private
   */
  _buildChimeRotary(name, value, onInput, onRelease) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-rotary';

    const knob = document.createElement('span');
    knob.className = 'chime-rotary-knob';
    const outer = document.createElement('span');
    outer.className = 'chime-rotary-outer';
    const inner = document.createElement('span');
    inner.className = 'chime-rotary-inner';
    const tick = document.createElement('span');
    tick.className = 'chime-rotary-tick';
    knob.appendChild(outer);
    knob.appendChild(inner);
    knob.appendChild(tick);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'chime-rotary-input';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(value);
    input.setAttribute('aria-label', name);
    input.setAttribute('orient', 'vertical');

    const label = document.createElement('span');
    label.className = 'chime-rotary-label';
    label.textContent = name;

    const setValue = (/** @type {number} */ v) => {
      const clamped = Math.max(0, Math.min(1, v));
      input.value = String(clamped);
      knob.style.setProperty('--angle', `${120 + (clamped * 300)}deg`);
    };

    let dragStartY = 0;
    let dragStartValue = 0;
    let dragging = false;
    /** @type {number | null} */
    let activePointerId = null;

    input.addEventListener('input', () => {
      setValue(Number(input.value));
      onInput(Number(input.value));
    });

    input.addEventListener('change', () => onRelease());

    // The move/end listeners live on window, not the knob, so a drag keeps
    // tracking the finger after it leaves the small dial — pointer capture is
    // unreliable in the mobile WebView, so we don't depend on it to hold.
    const onMove = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      const dy = dragStartY - e.clientY;
      if (Math.abs(dy) > 2) dragging = true;
      const next = dragStartValue + (dy / 140);
      setValue(next);
      onInput(Number(input.value));
    };
    const endDrag = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      if (knob.hasPointerCapture(activePointerId)) knob.releasePointerCapture(activePointerId);
      activePointerId = null;
      if (e.type === 'pointercancel') return;
      if (!dragging) input.focus();
      onRelease();
    };

    knob.addEventListener('pointerdown', (e) => {
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      dragging = false;
      dragStartY = e.clientY;
      dragStartValue = Number(input.value);
      try { knob.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });

    setValue(value);
    wrap.appendChild(knob);
    wrap.appendChild(input);
    wrap.appendChild(label);
    return { el: wrap, input, setValue };
  }

  /**
   * Render the Connectivity tab content.
   * @private
   */
  renderConnectivityFields() {
    const container = this.querySelector('#connectivity-form');
    if (!container) return;
    const c = this.connectivity;

    container.innerHTML = '';

    // ── Connected clients ─────────────────────────────────────────────
    // Lists the OTHER clients sharing this session (this window excluded). The
    // box IS the section element (a standard provider-field row) so it keeps the
    // normal inter-box gap; _refreshClientsSection rebuilds only its contents,
    // so live updates never touch the LAN/WAN form below.
    const clientsSection = document.createElement('div');
    clientsSection.id = 'connectivity-clients-section';
    clientsSection.className = 'settings-group provider-field connectivity-clients';
    container.appendChild(clientsSection);
    this._refreshClientsSection();

    // ── LAN access row ────────────────────────────────────────────────
    container.appendChild(this._buildLANAccessRow(c));

    // ── WAN access section (one block per server-registered mode) ─────
    // A build with no registered WAN modes reports an empty list and gets
    // no WAN section at all.
    if ((c.wanModes || []).length > 0) {
      container.appendChild(this._buildWANAccessRow(c));
    }
  }

  /**
   * (Re)build the connected-clients box contents in place: a "Connected clients"
   * label on the left, and on the right a list with one line per OTHER client
   * (this window is filtered out by id) — its origin, device, and how long it's
   * been connected — or a muted "none" line. Safe to call before the box exists
   * (no-op) and cheap to call on every poll tick (no inputs or QR images).
   * @private
   */
  _refreshClientsSection() {
    const section = this.querySelector('#connectivity-clients-section');
    if (!section) return;

    const all = this.connectivity.clients || [];
    // Exclude our own window by id. Before the session id is known (a brief
    // window at startup) nothing matches, so drop one entry so we never count
    // ourselves as an "other" client.
    const selfId = wsService.clientId;
    let others = selfId ? all.filter((c) => c.id !== selfId) : all.slice(1);
    // Oldest first, so the list order stays stable as clients join.
    others = others.slice().sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));

    section.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Connected clients';
    info.appendChild(name);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (others.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'connectivity-clients-empty';
      empty.textContent = 'No other clients connected';
      ctrl.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'connectivity-client-list';
      for (const c of others) {
        const li = document.createElement('li');
        li.className = 'connectivity-client';

        const dot = document.createElement('span');
        dot.className = `connectivity-client-dot origin-${c.origin || 'unknown'}`;
        li.appendChild(dot);

        const originEl = document.createElement('span');
        originEl.className = 'connectivity-client-origin';
        originEl.textContent = clientOriginLabel(c);
        li.appendChild(originEl);

        // Device + connected-since, muted. Either may be absent.
        const parts = [clientDeviceLabel(c.userAgent), formatTimeAgo(c.connectedAt)].filter(Boolean);
        if (parts.length) {
          const meta = document.createElement('span');
          meta.className = 'connectivity-client-meta';
          meta.textContent = parts.join(' — ');
          li.appendChild(meta);
        }

        list.appendChild(li);
      }
      ctrl.appendChild(list);
    }

    section.appendChild(info);
    section.appendChild(ctrl);
  }

  /**
   * Build the LAN access row: a Start/Stop control (matching the WAN mode
   * blocks) plus a URL/QR block per reachable LAN address when enabled.
   * @param {{lanEnabled: boolean, lanURLs: string[]}} c - Connectivity state
   * @returns {HTMLElement} The row element to append to the connectivity form.
   * @private
   */
  _buildLANAccessRow(c) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'LAN access';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Allow other devices on your local network to connect.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (c.lanEnabled) {
      if (c.lanURLs && c.lanURLs.length > 0) {
        // Lay the per-address URL/QR blocks out as a left-to-right flow that
        // wraps onto new lines, rather than a single stacked column. The LAN
        // URL is http://<ip>, which a native window's WebKit won't hand to the
        // system browser; the block routes clicks via the loopback opener.
        const list = document.createElement('div');
        list.className = 'connectivity-url-list';
        for (const url of c.lanURLs) {
          list.appendChild(this._buildConnectivityURLBlock(url));
        }
        ctrl.appendChild(list);
      } else {
        const hint = document.createElement('div');
        hint.className = 'key-source-hint';
        hint.style.display = 'block';
        hint.textContent = 'No LAN interfaces detected.';
        ctrl.appendChild(hint);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._setLAN(false);
      });
      ctrl.appendChild(stopBtn);
    } else {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = 'Start LAN access';
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._setLAN(true);
      });
      ctrl.appendChild(startBtn);
    }

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Enable or disable LAN access, then re-render from authoritative state.
   * @param {boolean} enabled
   * @private
   */
  async _setLAN(enabled) {
    try {
      await fetch('/api/connectivity/lan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (e) {
      console.error('Failed to set LAN access:', e);
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build the WAN access section: one block per WAN mode the server's build
   * registered, rendered entirely from the `wanModes` the connectivity API
   * reports. Only one tunnel is ever active; the active mode shows its URL/QR
   * and a Stop button. Driven purely from connectivity state — never from
   * optimistic local toggles.
   * @param {{tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, wanModes: WANMode[]}} c - Connectivity state
   * @returns {HTMLElement} The section element to append to the connectivity form.
   * @private
   */
  _buildWANAccessRow(c) {
    const section = document.createElement('div');
    section.className = 'connectivity-wan';

    const heading = document.createElement('div');
    heading.className = 'connectivity-wan-heading';
    heading.textContent = 'WAN access';
    section.appendChild(heading);

    const activeMode = c.tunnelEnabled ? (c.tunnelMode || '') : '';

    for (const mode of c.wanModes || []) {
      section.appendChild(this._buildWANModeBlock({
        mode: mode.mode,
        title: mode.title,
        description: mode.description,
        startLabel: mode.startLabel || `Start ${mode.title}`,
        available: !!mode.available,
        isActive: activeMode === mode.mode,
        url: activeMode === mode.mode ? c.tunnelURL : '',
        relayNote: mode.relayNote || '',
        unavailableHint: mode.unavailableHint || '',
      }));
    }

    if (this._wanError) {
      const err = document.createElement('div');
      err.className = 'key-source-hint connectivity-wan-error';
      err.style.display = 'block';
      err.textContent = this._wanError;
      section.appendChild(err);
    }

    return section;
  }

  /**
   * Build a single WAN-mode block: title + copy on the left, and on the right
   * either a Start button, or (when this mode is the active tunnel) its URL/QR
   * and a Stop button, or (when unavailable) the mode's install hint.
   * @param {{mode: string, title: string, description: string, startLabel: string, available: boolean, isActive: boolean, url: string, relayNote?: string, unavailableHint?: string}} opts
   * @returns {HTMLElement} The mode block element.
   * @private
   */
  _buildWANModeBlock(opts) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = opts.title;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = opts.description;
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (opts.isActive) {
      const statusHint = document.createElement('div');
      statusHint.className = 'key-source-hint';
      statusHint.style.display = 'block';
      statusHint.textContent = opts.url
        ? 'Open this URL in a remote browser to connect.'
        : 'Connecting…';
      ctrl.appendChild(statusHint);

      if (opts.url) {
        ctrl.appendChild(this._buildConnectivityURLBlock(opts.url));
      }

      if (opts.relayNote) {
        const note = document.createElement('div');
        note.className = 'key-source-hint';
        note.style.display = 'block';
        note.textContent = opts.relayNote;
        ctrl.appendChild(note);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._stopTunnel();
      });
      ctrl.appendChild(stopBtn);
    } else if (opts.available) {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = opts.startLabel;
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._startTunnel(opts.mode);
      });
      ctrl.appendChild(startBtn);
    } else {
      ctrl.appendChild(this._buildWANUnavailableHint(opts.unavailableHint || `${opts.title} is not available on this machine.`));
    }

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Render a WAN-mode unavailable hint as text, turning any http(s) URLs it
   * contains into external links so a plain-text hint from the server can still
   * point at install docs.
   * @param {string} text - The mode's unavailableHint
   * @returns {HTMLElement} The hint element.
   * @private
   */
  _buildWANUnavailableHint(text) {
    const hint = document.createElement('div');
    hint.className = 'key-source-hint';
    hint.style.display = 'block';
    for (const part of text.split(/(https?:\/\/[^\s]+)/)) {
      if (/^https?:\/\//.test(part)) {
        const link = document.createElement('a');
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'connectivity-url';
        link.textContent = part;
        hint.appendChild(link);
      } else if (part) {
        hint.appendChild(document.createTextNode(part));
      }
    }
    return hint;
  }

  /**
   * Start a WAN tunnel in the given mode. The backend auto-stops any other-mode
   * tunnel on an explicit different-mode start. Re-renders from authoritative
   * state afterwards.
   * @param {string} mode - A wire mode id from the server's wanModes list
   * @private
   */
  async _startTunnel(mode) {
    this._wanError = '';
    try {
      const res = await fetch('/api/connectivity/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, mode }),
      });
      const data = await res.json();
      if (!data.ok) this._wanError = data.error || 'Failed to start tunnel';
    } catch (e) {
      this._wanError = 'Failed to start tunnel';
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Stop whichever WAN tunnel is currently active.
   * @private
   */
  async _stopTunnel() {
    this._wanError = '';
    try {
      const res = await fetch('/api/connectivity/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const data = await res.json();
      if (!data.ok) this._wanError = data.error || 'Failed to stop tunnel';
    } catch (e) {
      this._wanError = 'Failed to stop tunnel';
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build a connectivity URL block: a clickable link (routed through the
   * loopback opener) alongside an inline QR code for the same URL.
   * @param {string} url - The URL to link to and encode as a QR code
   * @returns {HTMLElement} The URL block element to append to a control column.
   * @private
   */
  _buildConnectivityURLBlock(url) {
    const urlBlock = document.createElement('div');
    urlBlock.className = 'connectivity-url-block';
    const urlLink = document.createElement('a');
    urlLink.href = url;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.className = 'connectivity-url';
    urlLink.textContent = url;
    const qrHost = document.createElement('div');
    qrHost.className = 'connectivity-qr';
    qrHost.setAttribute('role', 'img');
    qrHost.setAttribute('aria-label', 'QR code');
    loadQRCodeSVG(qrHost, url);
    urlBlock.appendChild(urlLink);
    urlBlock.appendChild(qrHost);
    return urlBlock;
  }

  /**
   * Open (or re-open) the Logs tab: fetch the current session's log list,
   * populate the picker, and load the selected file's tail. Safe to call
   * repeatedly — it preserves the current selection across refreshes. Shares the
   * tail-busy guard with the poll so the two never overlap.
   * @private
   */
  async _openLogsTab() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      await this._refreshLogList();
      await this._fetchLogContent(true);
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Fetch the session log list and reconcile the UI: toggle the empty state,
   * keep (or default) the selection, and rebuild the picker only when the file
   * set actually changed so a 2s poll never disrupts an open dropdown.
   * @private
   */
  async _refreshLogList() {
    /** @type {any[]} */
    let files = [];
    try {
      const res = await fetch('/api/logs');
      if (res.ok) files = (await res.json()).files || [];
    } catch {
      // Treat a failed fetch as "no logs" and fall through to the empty state.
    }
    this._logFiles = files;

    const hasFiles = files.length > 0;
    const empty = this.querySelector('#logs-empty');
    const controls = this.querySelector('#logs-controls');
    const viewer = this.querySelector('#logs-viewer');
    if (empty) /** @type {HTMLElement} */ (empty).hidden = hasFiles;
    if (controls) /** @type {HTMLElement} */ (controls).hidden = !hasFiles;
    if (viewer) /** @type {HTMLElement} */ (viewer).hidden = !hasFiles;

    // Keep the current selection; if it vanished (log rotated away) or is unset,
    // default to server.log, then the first file.
    if (!files.some((f) => f.path === this._selectedLogPath)) {
      const preferred = files.find((f) => f.name === 'server.log') || files[0];
      this._selectedLogPath = preferred ? preferred.path : '';
      this._logOffset = 0;
    }

    // Rebuild the picker only when the set of files changed (added/removed),
    // and the path control only when the selection changed — so <reveal-button>
    // and the <option>s aren't recreated on every tick.
    const key = files.map((f) => f.path).join('\n');
    if (key !== this._logFilesKey) {
      this._logFilesKey = key;
      this._renderLogPicker();
    }
    if (this._selectedLogPath !== this._filePathPath) {
      this._filePathPath = this._selectedLogPath;
      this._updateLogFilePathControl();
    }
  }

  /**
   * Rebuild the picker's <option>s from this._logFiles, grouped by kind
   * (Server / Conversations / App) with a size hint per entry, reflecting the
   * current selection. The change listener lives on the persistent <select>
   * (see setupListeners), so it is not re-wired here.
   * @private
   */
  _renderLogPicker() {
    const picker = /** @type {HTMLSelectElement|null} */ (this.querySelector('#logs-picker'));
    if (!picker) return;
    picker.textContent = '';

    for (const group of [
      { key: 'server', label: 'Server' },
      { key: 'conversations', label: 'Conversations' },
      { key: 'app', label: 'App' },
    ]) {
      const inGroup = this._logFiles.filter((f) => f.group === group.key);
      if (inGroup.length === 0) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const file of inGroup) {
        const opt = document.createElement('option');
        opt.value = file.path;
        opt.textContent = `${file.name} — ${formatBytes(file.size)}`;
        if (file.path === this._selectedLogPath) opt.selected = true;
        optgroup.appendChild(opt);
      }
      picker.appendChild(optgroup);
    }
  }

  /**
   * Switch the viewer to a different log file: reset the tail offset, clear the
   * viewer, refresh the path control, and load the new file's tail.
   * @param {string} path - Absolute path of the newly-selected log
   * @private
   */
  _selectLog(path) {
    if (!path || path === this._selectedLogPath) return;
    this._selectedLogPath = path;
    this._logOffset = 0;
    const viewer = this.querySelector('#logs-viewer');
    if (viewer) viewer.textContent = '';
    this._filePathPath = path;
    this._updateLogFilePathControl();
    this._fetchLogContent(true);
  }

  /**
   * Render the standard file-path control (copy + reveal-in-Finder) for the
   * selected log into the #logs-filepath row, replacing any previous one.
   * @private
   */
  _updateLogFilePathControl() {
    const host = this.querySelector('#logs-filepath');
    if (!host) return;
    host.textContent = '';
    if (this._selectedLogPath) addFilePath(/** @type {HTMLElement} */ (host), this._selectedLogPath);
  }

  /**
   * Fetch the selected log from the current offset and render it. On `reset`
   * (file switch / first open) or a server-reported replaced window (initial
   * tail / rotation) the viewer content is replaced; otherwise the newly
   * appended bytes are appended. Autoscroll sticks to the bottom only when the
   * user was already there, so scrolling up to read history isn't interrupted.
   * @param {boolean} [reset=false]
   * @private
   */
  async _fetchLogContent(reset = false) {
    const path = this._selectedLogPath;
    const viewer = this.querySelector('#logs-viewer');
    if (!path || !viewer) return;

    const offset = reset ? 0 : this._logOffset;
    let data;
    try {
      const res = await fetch(`/api/logs/content?path=${encodeURIComponent(path)}&offset=${offset}`);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return; // Transient; the next poll retries.
    }
    // Drop a stale response for a file the user has since switched away from.
    if (path !== this._selectedLogPath) return;

    const pinned = this._isViewerAtBottom(/** @type {HTMLElement} */ (viewer));
    if (reset || data.replaced) {
      viewer.textContent = data.content;
    } else if (data.content) {
      viewer.appendChild(document.createTextNode(data.content));
    }
    this._trimViewer(/** @type {HTMLElement} */ (viewer));
    this._logOffset = data.size;
    if (reset || pinned) viewer.scrollTop = viewer.scrollHeight;
  }

  /**
   * Keep the viewer's text bounded (see LOGS_VIEWER_MAX_CHARS): when it grows
   * past the cap, drop the oldest characters, rounding forward to the next line
   * boundary so a partial first line isn't left dangling. No-op below the cap.
   * @param {HTMLElement} viewer
   * @private
   */
  _trimViewer(viewer) {
    const text = viewer.textContent || '';
    if (text.length <= LOGS_VIEWER_MAX_CHARS) return;
    let cut = text.length - LOGS_VIEWER_MAX_CHARS;
    const nl = text.indexOf('\n', cut);
    if (nl !== -1) cut = nl + 1;
    viewer.textContent = text.slice(cut);
  }

  /**
   * One tail poll while the Logs tab is open. Tails only the selected file's
   * newly-appended bytes — one cheap incremental read. The list is refreshed on
   * open (not every tick), so new files / size changes are picked up on reopen
   * rather than costing a second request per poll. The in-flight guard drops a
   * tick if the previous poll's fetch hasn't returned, so a slow response can't
   * double-append. When nothing is selected yet (opened before any log existed),
   * it keeps re-listing until a file appears.
   * @private
   */
  async _pollLogTail() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      if (this._selectedLogPath) {
        await this._fetchLogContent(false);
      } else {
        await this._refreshLogList();
        await this._fetchLogContent(true);
      }
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Whether the viewer is scrolled to (within a line or two of) the bottom —
   * the condition under which new log lines should keep it pinned there.
   * @param {HTMLElement} el
   * @returns {boolean} True when pinned to (or within a couple of lines of) the bottom.
   * @private
   */
  _isViewerAtBottom(el) {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  }

  /**
   * Delete API key for a specific provider
   * @param {any} provider - Provider info object
   * @private
   */
  async deleteProviderKey(provider) {
    try {
      // Send empty string to delete the key
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          [provider.configKeyName]: ''
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete API key');
      }

      // Reload config from server to get actual state (don't re-render fields)
      await this.loadConfig(false);

      // Refresh model selector to update available providers
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to delete API key:', error);
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to delete API key',
          'Error'
        );
      }
    }
  }

  // ==========================================================================
  // MCP servers tab
  // ==========================================================================

  /**
   * Fetch live status (source of truth for rows) and the raw per-scope config
   * (source of truth for editing) together, then re-render the list. Overlapping
   * poll/broadcast ticks are guarded; while the add/edit form is open the fetched
   * data is refreshed silently but the form is left untouched so a later Cancel
   * returns to a fresh list.
   * @private
   */
  async _refreshMcpServers() {
    if (this._mcpBusy) return;
    this._mcpBusy = true;
    try {
      const [list, cfg] = await Promise.all([mcpListServers(), mcpGetConfig()]);
      this._mcpServers = (list && list.servers) || [];
      this._mcpConfig = {
        global: /** @type {Record<string, McpServerConfig>} */ ((cfg && cfg.global) || {}),
        project: /** @type {Record<string, McpServerConfig>} */ ((cfg && cfg.project) || {}),
        hasProject: !!(cfg && cfg.hasProject),
      };
      this._mcpError = '';
    } catch (e) {
      // Keep the last known state; surface an inline banner instead of throwing.
      this._mcpError = e instanceof Error ? e.message : 'Failed to load MCP servers.';
    } finally {
      this._mcpBusy = false;
    }
    if (!this._mcpEditing) this._renderMcpTab();
  }

  /**
   * Render the MCP tab: the add/edit form when one is open, else the list.
   * @private
   */
  _renderMcpTab() {
    const host = /** @type {HTMLElement|null} */ (this.querySelector('#mcp-form'));
    if (!host) return;
    host.innerHTML = '';
    if (this._mcpEditing) {
      host.appendChild(this._buildMcpForm());
      return;
    }
    if (this._mcpError) host.appendChild(this._buildMcpErrorBanner(this._mcpError));
    this._renderMcpList(host);
  }

  /**
   * Build a dismissible-looking inline error banner (styled like an error hint).
   * @param {string} message
   * @returns {HTMLElement} The banner element.
   * @private
   */
  _buildMcpErrorBanner(message) {
    const banner = document.createElement('div');
    banner.className = 'key-source-hint mcp-error-hint';
    banner.style.display = 'block';
    banner.textContent = message;
    return banner;
  }

  /**
   * Render the list view: a toolbar (Add server + importer seam), then either a
   * friendly empty state or one row per configured server.
   * @param {HTMLElement} host
   * @private
   */
  _renderMcpList(host) {
    const toolbar = document.createElement('div');
    toolbar.className = 'mcp-toolbar';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'settings-btn primary small';
    addBtn.textContent = 'Add server';
    addBtn.addEventListener('click', () => this._openMcpForm('add'));
    toolbar.appendChild(addBtn);
    // Importer seam: an "Import from…" button slots in here next to Add later.
    const soon = document.createElement('span');
    soon.className = 'mcp-import-soon';
    soon.textContent = 'Importing from other apps is coming soon.';
    toolbar.appendChild(soon);
    host.appendChild(toolbar);

    const servers = this._mcpServers || [];
    const hasAny = servers.length
      || Object.keys(this._mcpConfig.global).length
      || Object.keys(this._mcpConfig.project).length;
    if (!hasAny) {
      const hint = document.createElement('div');
      hint.className = 'key-source-hint mcp-empty';
      hint.style.display = 'block';
      hint.textContent = 'No MCP servers yet. Add one to give the assistant extra tools — for example a filesystem, GitHub, or database server.';
      host.appendChild(hint);
      return;
    }

    const list = document.createElement('div');
    list.className = 'mcp-list';
    for (const s of servers) this._buildMcpRow(s, list);
    host.appendChild(list);
  }

  /**
   * Build one server row (status dot, name, tokens, scope chip, controls) and
   * append it to `list`; when this server's log disclosure is open, a stderr
   * <pre> is appended right after it.
   * @param {import('../services/ops-api.js').McpServerStatus} status
   * @param {HTMLElement} list
   * @private
   */
  _buildMcpRow(status, list) {
    const name = status.name;
    const scope = mcpScopeOf(this._mcpConfig, name);
    const enabled = status.enabled !== false;

    const row = document.createElement('div');
    row.className = 'settings-group provider-field mcp-row';
    if (!enabled) row.classList.add('mcp-row-disabled');

    // Left: status + identity + token cost.
    const info = document.createElement('div');
    info.className = 'provider-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'provider-name mcp-name-row';
    const dot = document.createElement('span');
    dot.className = `mcp-status-dot status-${status.status || 'stopped'}`;
    dot.title = status.status || 'stopped';
    nameRow.appendChild(dot);
    const nameText = document.createElement('span');
    nameText.textContent = name;
    nameRow.appendChild(nameText);
    if (status.serverName) {
      const impl = document.createElement('span');
      impl.className = 'mcp-impl';
      impl.textContent = status.serverVersion ? `(${status.serverName} ${status.serverVersion})` : `(${status.serverName})`;
      nameRow.appendChild(impl);
    }
    const chip = document.createElement('span');
    chip.className = 'mcp-scope-chip';
    chip.textContent = scope === 'project' ? 'project' : 'global';
    nameRow.appendChild(chip);
    info.appendChild(nameRow);

    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = formatMcpTokenCost(status);
    info.appendChild(desc);

    if (status.status === 'failed' && status.error) {
      const err = document.createElement('div');
      err.className = 'key-source-hint mcp-error-hint';
      err.style.display = 'block';
      err.textContent = String(status.error).split('\n')[0] || '';
      info.appendChild(err);
    }

    // Right: enable toggle + action buttons.
    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control mcp-controls';

    const toggle = document.createElement('label');
    toggle.className = 'mcp-toggle-wrap';
    toggle.title = enabled ? 'Enabled' : 'Disabled';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'provider-toggle';
    cb.checked = enabled;
    cb.addEventListener('change', () => this._setMcpEnabled(scope, name, cb.checked));
    const sw = document.createElement('span');
    sw.className = 'toggle-switch';
    toggle.appendChild(cb);
    toggle.appendChild(sw);
    ctrl.appendChild(toggle);

    const btnRow = document.createElement('div');
    btnRow.className = 'mcp-btn-row';

    if (enabled) {
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'settings-btn small';
      restart.textContent = 'Restart';
      if (status.status === 'starting') restart.disabled = true;
      restart.addEventListener('click', () => this._restartMcpServer(name, restart));
      btnRow.appendChild(restart);
    }

    const logsBtn = document.createElement('button');
    logsBtn.type = 'button';
    logsBtn.className = 'settings-btn small';
    logsBtn.textContent = this._mcpLogFor === name ? 'Hide log' : 'Log';
    logsBtn.addEventListener('click', () => this._toggleMcpLog(name));
    btnRow.appendChild(logsBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'settings-btn small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => this._openMcpForm('edit', status));
    btnRow.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'settings-btn danger small';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => this._confirmDeleteMcpServer(scope, name));
    btnRow.appendChild(delBtn);

    ctrl.appendChild(btnRow);

    row.appendChild(info);
    row.appendChild(ctrl);
    list.appendChild(row);

    if (this._mcpLogFor === name) {
      const pre = document.createElement('pre');
      pre.className = 'mcp-log-view';
      pre.textContent = this._mcpLogText === null
        ? 'Loading…'
        : (this._mcpLogText || 'No output yet.');
      list.appendChild(pre);
    }
  }

  /**
   * Restart a server's process (transient lifecycle — distinct from the durable
   * enable/disable toggle), then refresh from authoritative state.
   * @param {string} name
   * @param {HTMLButtonElement} btn
   * @private
   */
  async _restartMcpServer(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    this._mcpError = '';
    try {
      await mcpServerControl({ server: name, action: 'restart' });
    } catch (e) {
      this._mcpError = e instanceof Error ? e.message : `Failed to restart "${name}".`;
    }
    await this._refreshMcpServers();
  }

  /**
   * Toggle a server's stderr-log disclosure. Opening fetches the recent stderr
   * once (bounded server-side) and renders it into a <pre>; re-opening closes it.
   * @param {string} name
   * @private
   */
  async _toggleMcpLog(name) {
    if (this._mcpLogFor === name) {
      this._mcpLogFor = '';
      this._mcpLogText = null;
      this._renderMcpTab();
      return;
    }
    this._mcpLogFor = name;
    this._mcpLogText = null; // loading
    this._renderMcpTab();
    try {
      const { log } = await mcpGetLog({ server: name });
      if (this._mcpLogFor === name) {
        this._mcpLogText = log || '';
        this._renderMcpTab();
      }
    } catch {
      if (this._mcpLogFor === name) {
        this._mcpLogText = '';
        this._renderMcpTab();
      }
    }
  }

  /**
   * Durable enable/disable: write the `enabled` flag into the scope map (whole
   * map rewritten) and let the manager reconcile. Not a lifecycle action.
   * @param {'global'|'project'} scope
   * @param {string} name
   * @param {boolean} enabled
   * @private
   */
  async _setMcpEnabled(scope, name, enabled) {
    this._mcpError = '';
    const src = scope === 'project' ? this._mcpConfig.project : this._mcpConfig.global;
    try {
      await mcpSetConfig({ scope, servers: mcpSetEnabledMap(src, name, enabled) });
    } catch (e) {
      this._mcpError = e instanceof Error ? e.message : `Failed to update "${name}".`;
    }
    await this._refreshMcpServers();
  }

  /**
   * Confirm, then delete a server from its scope map (whole map rewritten).
   * @param {'global'|'project'} scope
   * @param {string} name
   * @private
   */
  async _confirmDeleteMcpServer(scope, name) {
    const confirm = /** @type {any} */ (window).showConfirm;
    if (typeof confirm === 'function') {
      const ok = await confirm(`Remove the MCP server "${name}"? Its tools will disappear from conversations.`, 'Remove server', { confirmText: 'Remove', danger: true });
      if (!ok) return;
    }
    this._mcpError = '';
    const src = scope === 'project' ? this._mcpConfig.project : this._mcpConfig.global;
    try {
      await mcpSetConfig({ scope, servers: mcpDeleteMap(src, name) });
    } catch (e) {
      this._mcpError = e instanceof Error ? e.message : `Failed to remove "${name}".`;
    }
    if (this._mcpLogFor === name) { this._mcpLogFor = ''; this._mcpLogText = null; }
    await this._refreshMcpServers();
  }

  /**
   * Open the add/edit form by seeding `_mcpEditing` working state, then render.
   * @param {'add'|'edit'} mode
   * @param {import('../services/ops-api.js').McpServerStatus} [status] - The row's status (edit only)
   * @private
   */
  _openMcpForm(mode, status) {
    this._mcpError = '';
    if (mode === 'edit' && status) {
      const name = status.name;
      const scope = mcpScopeOf(this._mcpConfig, name);
      const cfg = /** @type {McpServerConfig} */ ((scope === 'project' ? this._mcpConfig.project : this._mcpConfig.global)[name] || {});
      this._mcpEditing = {
        mode: 'edit',
        scope,
        name,
        command: cfg.command || '',
        args: Array.isArray(cfg.args) ? cfg.args.slice() : [],
        envPairs: Object.entries(cfg.env || {}).map(([key, value]) => ({ key, value: String(value) })),
        enabled: cfg.enabled !== false,
        error: '',
      };
    } else {
      this._mcpEditing = {
        mode: 'add',
        scope: 'global',
        name: '',
        command: '',
        args: [],
        envPairs: [],
        enabled: true,
        error: '',
      };
    }
    this._renderMcpTab();
  }

  /**
   * Build the add/edit form element from `_mcpEditing`. Name and scope are
   * read-only when editing (rename/move = delete + add in v1). Arg and env rows
   * are repeatable; env values are masked with a per-field reveal toggle.
   * @returns {HTMLElement} The form element to mount in the tab.
   * @private
   */
  _buildMcpForm() {
    const f = this._mcpEditing;
    const wrap = document.createElement('div');
    wrap.className = 'mcp-form';

    const title = document.createElement('div');
    title.className = 'settings-section-heading';
    title.textContent = f.mode === 'edit' ? `Edit “${f.name}”` : 'Add MCP server';
    wrap.appendChild(title);

    // Name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'mcp-input mcp-name-input';
    nameInput.placeholder = 'name';
    nameInput.value = f.name;
    if (f.mode === 'edit') nameInput.readOnly = true;
    wrap.appendChild(this._mcpFormField('Name', nameInput,
      f.mode === 'edit' ? 'Renaming means deleting and re-adding the server.' : 'A short id — becomes the tool prefix (mcp__<name>__…). No spaces or “/”.'));

    // Scope
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'mcp-input mcp-scope-input';
    const optGlobal = document.createElement('option');
    optGlobal.value = 'global';
    optGlobal.textContent = 'Global (all projects)';
    scopeSelect.appendChild(optGlobal);
    if (this._mcpConfig.hasProject || f.scope === 'project') {
      const optProject = document.createElement('option');
      optProject.value = 'project';
      optProject.textContent = 'This project only';
      scopeSelect.appendChild(optProject);
    }
    scopeSelect.value = f.scope;
    if (f.mode === 'edit') scopeSelect.disabled = true;
    wrap.appendChild(this._mcpFormField('Scope', scopeSelect,
      f.mode === 'edit' ? 'Moving scope means deleting and re-adding the server.' : ''));

    // Command
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = 'mcp-input mcp-command-input';
    cmdInput.placeholder = 'npx';
    cmdInput.value = f.command;
    wrap.appendChild(this._mcpFormField('Command', cmdInput, 'The executable to launch (stdio transport).'));

    // Arguments
    const argsField = document.createElement('div');
    argsField.className = 'mcp-form-field';
    const argsLabel = document.createElement('label');
    argsLabel.className = 'mcp-field-label';
    argsLabel.textContent = 'Arguments';
    argsField.appendChild(argsLabel);
    const argsList = document.createElement('div');
    argsList.className = 'mcp-args-list';
    argsField.appendChild(argsList);
    const addArg = document.createElement('button');
    addArg.type = 'button';
    addArg.className = 'settings-btn small mcp-add-row';
    addArg.textContent = 'Add argument';
    addArg.addEventListener('click', () => {
      f.args = this._readMcpArgs();
      f.args.push('');
      this._renderMcpArgsList(argsList);
    });
    argsField.appendChild(addArg);
    wrap.appendChild(argsField);
    this._renderMcpArgsList(argsList);

    // Environment variables
    const envField = document.createElement('div');
    envField.className = 'mcp-form-field';
    const envLabel = document.createElement('label');
    envLabel.className = 'mcp-field-label';
    envLabel.textContent = 'Environment variables';
    envField.appendChild(envLabel);
    const envList = document.createElement('div');
    envList.className = 'mcp-env-list';
    envField.appendChild(envList);
    const addEnv = document.createElement('button');
    addEnv.type = 'button';
    addEnv.className = 'settings-btn small mcp-add-row';
    addEnv.textContent = 'Add variable';
    addEnv.addEventListener('click', () => {
      f.envPairs = this._readMcpEnvPairs();
      f.envPairs.push({ key: '', value: '' });
      this._renderMcpEnvList(envList);
    });
    envField.appendChild(addEnv);
    wrap.appendChild(envField);
    this._renderMcpEnvList(envList);

    // Enabled
    const enabledField = document.createElement('div');
    enabledField.className = 'mcp-form-field mcp-enabled-field';
    const enabledToggle = document.createElement('label');
    enabledToggle.className = 'mcp-toggle-wrap';
    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.className = 'provider-toggle mcp-enabled-input';
    enabledCb.checked = f.enabled !== false;
    const enabledSw = document.createElement('span');
    enabledSw.className = 'toggle-switch';
    enabledToggle.appendChild(enabledCb);
    enabledToggle.appendChild(enabledSw);
    const enabledText = document.createElement('span');
    enabledText.className = 'mcp-field-label';
    enabledText.textContent = 'Enabled';
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
    saveBtn.className = 'settings-btn primary small';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => this._saveMcpForm());
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'settings-btn small';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this._mcpEditing = null;
      this._renderMcpTab();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    wrap.appendChild(actions);

    return wrap;
  }

  /**
   * Build a stacked "label + control (+ hint)" form field.
   * @param {string} labelText
   * @param {HTMLElement} control
   * @param {string} [hintText]
   * @returns {HTMLElement} The field wrapper element.
   * @private
   */
  _mcpFormField(labelText, control, hintText) {
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
   * Rebuild the repeatable argument rows into `container` from `_mcpEditing.args`.
   * @param {HTMLElement} container
   * @private
   */
  _renderMcpArgsList(container) {
    container.innerHTML = '';
    /** @type {string[]} */
    const args = this._mcpEditing.args || [];
    args.forEach((arg, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'mcp-repeat-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mcp-input mcp-arg-input';
      input.placeholder = i === 0 ? '-y' : '@modelcontextprotocol/server-github';
      input.value = arg;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mcp-remove-row';
      remove.setAttribute('aria-label', 'Remove argument');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this._mcpEditing.args = this._readMcpArgs();
        this._mcpEditing.args.splice(i, 1);
        this._renderMcpArgsList(container);
      });
      rowEl.appendChild(input);
      rowEl.appendChild(remove);
      container.appendChild(rowEl);
    });
  }

  /**
   * Rebuild the repeatable env-var rows into `container` from
   * `_mcpEditing.envPairs`. Value inputs are masked, with a per-row reveal.
   * @param {HTMLElement} container
   * @private
   */
  _renderMcpEnvList(container) {
    container.innerHTML = '';
    /** @type {Array<{key: string, value: string}>} */
    const pairs = this._mcpEditing.envPairs || [];
    pairs.forEach((pair, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'mcp-repeat-row mcp-env-row';
      const key = document.createElement('input');
      key.type = 'text';
      key.className = 'mcp-input mcp-env-key';
      key.placeholder = 'API_TOKEN';
      key.value = pair.key;
      const value = document.createElement('input');
      value.type = 'password';
      value.className = 'mcp-input mcp-env-value';
      value.placeholder = 'value';
      value.value = pair.value;
      value.autocomplete = 'off';
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'mcp-reveal-btn';
      reveal.setAttribute('aria-label', 'Reveal value');
      reveal.textContent = '👁';
      reveal.addEventListener('click', () => {
        value.type = value.type === 'password' ? 'text' : 'password';
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mcp-remove-row';
      remove.setAttribute('aria-label', 'Remove variable');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this._mcpEditing.envPairs = this._readMcpEnvPairs();
        this._mcpEditing.envPairs.splice(i, 1);
        this._renderMcpEnvList(container);
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
   * @private
   */
  _readMcpArgs() {
    return Array.from(this.querySelectorAll('.mcp-arg-input'))
      .map((el) => /** @type {HTMLInputElement} */ (el).value);
  }

  /**
   * Read the current env key/value rows from the DOM.
   * @returns {Array<{key: string, value: string}>} The current env pairs in row order.
   * @private
   */
  _readMcpEnvPairs() {
    return Array.from(this.querySelectorAll('.mcp-env-row')).map((rowEl) => ({
      key: /** @type {HTMLInputElement} */ (rowEl.querySelector('.mcp-env-key')).value,
      value: /** @type {HTMLInputElement} */ (rowEl.querySelector('.mcp-env-value')).value,
    }));
  }

  /**
   * Validate the form, build the config entry, write the whole scope map back,
   * and (on success) return to a freshly-fetched list. On validation failure the
   * form stays open with an inline error.
   * @private
   */
  async _saveMcpForm() {
    const f = this._mcpEditing;
    if (!f) return;

    // Read every field from the DOM so nothing is lost between row rebuilds.
    const nameEl = /** @type {HTMLInputElement} */ (this.querySelector('.mcp-name-input'));
    const scopeEl = /** @type {HTMLSelectElement} */ (this.querySelector('.mcp-scope-input'));
    const cmdEl = /** @type {HTMLInputElement} */ (this.querySelector('.mcp-command-input'));
    const enabledEl = /** @type {HTMLInputElement} */ (this.querySelector('.mcp-enabled-input'));
    const name = f.mode === 'edit' ? f.name : (nameEl ? nameEl.value.trim() : '');
    const scope = f.mode === 'edit' ? f.scope : (scopeEl ? /** @type {'global'|'project'} */ (scopeEl.value) : 'global');
    const command = cmdEl ? cmdEl.value.trim() : '';
    const args = this._readMcpArgs();
    const envPairs = this._readMcpEnvPairs();
    const enabled = enabledEl ? enabledEl.checked : true;

    // Persist back into working state so a re-render (on error) keeps input.
    f.command = command;
    f.args = args;
    f.envPairs = envPairs;
    f.enabled = enabled;
    if (f.mode !== 'edit') { f.name = name; f.scope = scope; }

    // Validate.
    if (f.mode !== 'edit') {
      const targetMap = scope === 'project' ? this._mcpConfig.project : this._mcpConfig.global;
      const err = validateMcpServerName(name, Object.keys(targetMap || {}));
      if (err) { f.error = err; this._renderMcpTab(); return; }
    }
    if (!command) { f.error = 'Command is required.'; this._renderMcpTab(); return; }
    for (const p of envPairs) {
      if (!p.key.trim() && p.value) { f.error = 'Every environment variable needs a name.'; this._renderMcpTab(); return; }
    }

    /** @type {Record<string, string>} */
    const env = {};
    for (const p of envPairs) { const k = p.key.trim(); if (k) env[k] = p.value; }
    const entry = mcpFormToConfig({ command, args, env, enabled });

    const src = scope === 'project' ? this._mcpConfig.project : this._mcpConfig.global;
    try {
      await mcpSetConfig({ scope, servers: mcpUpsertMap(src, name, entry) });
    } catch (e) {
      f.error = e instanceof Error ? e.message : 'Failed to save the server.';
      this._renderMcpTab();
      return;
    }
    this._mcpEditing = null;
    await this._refreshMcpServers();
  }

}

customElements.define('settings-panel', SettingsPanel);

// Global helper to open settings panel
// @ts-ignore - Adding custom property to window
window.openSettings = function(tab) {
  let panel = document.querySelector('settings-panel');
  if (!panel) {
    panel = document.createElement('settings-panel');
    document.body.appendChild(panel);
  }
  // @ts-ignore - open method exists on SettingsPanel custom element
  panel.open(tab);
};
