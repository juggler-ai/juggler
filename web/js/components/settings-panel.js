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

import { markPopupOpen } from '../utils/popup-manager.js';
import { fetchJson } from '../services/http.js';
import { registerSettingsOpener } from '../services/settings-launcher.js';
import { showAlert } from './modal-dialog.js';
import providersCache from '../services/providers-cache.js';
import { ProvidersTab } from './settings/providers-tab.js';
import { DefaultsTab } from './settings/defaults-tab.js';
import { ConnectivityTab } from './settings/connectivity-tab.js';
import { NotificationsTab } from './settings/notifications-tab.js';
import { ShortcutsTab } from './settings/shortcuts-tab.js';
import { LogsTab } from './settings/logs-tab.js';
import { McpTab, AcpTab } from './settings/subprocess-tabs.js';
import { SkillsTab } from './settings/skills-tab.js';
import { UpdatesTab } from './settings/updates-tab.js';

/**
 * Longest the first load will wait for the server's provider list to settle
 * before rendering whatever the REST snapshot held. The server's first refresh
 * normally lands within a second or so of the port opening, so this ceiling is
 * only reached when the settled push never arrives at all (e.g. a dead
 * WebSocket), where rendering the empty snapshot is the old behaviour anyway.
 */
const PROVIDERS_READY_TIMEOUT_MS = 5000;

/**
 * The shared payload the shell's loadConfig() fans out to every tab.
 * @typedef {object} LoadedSettings
 * @property {object} config - The /api/config result.
 * @property {any[]} providers - The sorted /api/providers list.
 * @property {{provider: string, model: string, explicit?: boolean}} defaultModel - The /api/default-model result.
 * @property {{provider?: string, model?: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} [cheapModel] - The /api/cheap-model result.
 * @property {object} connectivity - The /api/connectivity result.
 */

/**
 * The interface each settings tab implements. Every method is optional; the shell
 * dispatches through the tab registry generically, so a tab only implements what
 * it needs. DOM queries are scoped to the tab's own `#tab-<name>` section.
 * @typedef {object} SettingsTabController
 * @property {() => void} [render] - Build static DOM / wire persistent listeners (called from the shell's render()).
 * @property {(data: LoadedSettings, renderFields: boolean) => void} [onConfigLoaded] - Receive the shared loadConfig() payload.
 * @property {() => void} [show] - Tab became visible: fetch own data / arm pollers.
 * @property {() => void} [hide] - Tab hidden: stop pollers.
 * @property {() => void} [close] - Panel closed: stop pollers, drop transient form state.
 * @property {() => void} [dispose] - Element disconnected: remove global/ws listeners.
 */

/**
 * SettingsPanel - Configuration panel
 *
 * A thin shell around a registry of per-tab controllers (one module each under
 * `settings/`). The shell owns the tab chrome, tab switching, first-load gating,
 * and the shared config fetch; each tab owns its own DOM, state, and pollers.
 */
class SettingsPanel extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.currentTab = 'providers';
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {boolean} @private */
    this._hasLoadedOnce = false;
    /** @type {HTMLElement|null} @private - The horizontally-scrollable tab strip; watched to drive its edge-fade affordance. */
    this._tabScrollEl = null;
    /** @type {(() => void)|null} @private */
    this._onTabScroll = null;
    /** @type {ResizeObserver|null} @private */
    this._tabResizeObserver = null;

    // The tab registry: one controller per tab (Extensions gets none — its
    // section just hosts <plugin-catalog>). switchTab / loadConfig / close /
    // disconnectedCallback dispatch through this generically.
    /** @type {Record<string, SettingsTabController>} @private */
    this._tabs = {
      providers: new ProvidersTab(this),
      defaults: new DefaultsTab(this),
      connectivity: new ConnectivityTab(this),
      mcp: new McpTab(this),
      acp: new AcpTab(this),
      skills: new SkillsTab(this),
      notifications: new NotificationsTab(this),
      shortcuts: new ShortcutsTab(this),
      logs: new LogsTab(this),
      updates: new UpdatesTab(this),
    };
  }

  connectedCallback() {
    this.render();
    this.setupListeners();
  }

  disconnectedCallback() {
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    // Each tab removes its own global/ws listeners and stops its pollers.
    for (const tab of Object.values(this._tabs)) {
      if (tab.dispose) tab.dispose();
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
                <button class="close-button" id="settings-close" title="Close" aria-label="Close"><span class="icon-close"></span></button>
                <nav class="settings-tabs">
                    <div class="settings-tabs-scroll">
                        <button class="settings-tab active" data-tab="providers">Provider API Keys</button>
                        <button class="settings-tab" data-tab="defaults">Defaults</button>
                        <button class="settings-tab" data-tab="connectivity">Connectivity</button>
                        <button class="settings-tab" data-tab="extensions">Extensions</button>
                        <button class="settings-tab" data-tab="skills">Skills</button>
                        <button class="settings-tab" data-tab="mcp">MCP servers</button>
                        <button class="settings-tab" data-tab="acp">ACP agents</button>
                        <button class="settings-tab" data-tab="notifications">Notifications</button>
                        <button class="settings-tab" data-tab="shortcuts">Keyboard shortcuts</button>
                        <button class="settings-tab" data-tab="logs">Logs</button>
                        <button class="settings-tab" data-tab="updates">Updates</button>
                    </div>
                </nav>

                <div class="settings-loading" id="settings-loading">
                    <juggler-spinner style="--size: 2.5rem"></juggler-spinner>
                    <div class="settings-loading-text">Loading settings...</div>
                </div>

                <main class="settings-content">
                    <section class="settings-tab-content active" id="tab-providers">
                        <p class="settings-description">
                            Provider keys are stored in <code id="credentials-path">~/.juggler/credentials.json</code>.
                        </p>

                        <div class="settings-form" id="provider-form">
                            <div id="provider-fields-container"></div>
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-defaults">
                        <div class="settings-section-heading">New conversation defaults</div>
                        <div class="settings-form" id="new-conversation-defaults-form">
                            <div class="settings-card">
                                <div id="default-model-field-container"></div>
                                <div id="new-conversation-defaults-fields"></div>
                            </div>
                        </div>

                        <div class="settings-section-heading">Cheap model</div>
                        <div class="settings-form" id="cheap-model-form">
                            <div id="cheap-model-field-container"></div>
                        </div>

                        <div class="settings-section-heading">Conversation auto-naming</div>
                        <div class="settings-form" id="auto-name-form"></div>

                        <div class="settings-form" id="global-settings"></div>
                    </section>

                     <section class="settings-tab-content" id="tab-extensions">
                          <plugin-catalog></plugin-catalog>
                     </section>

                      <section class="settings-tab-content" id="tab-skills">
                          <p class="settings-description">
                              Discover and install Agent Skills from external registries, or manage
                              the ones you have. Installing downloads and writes files &mdash; it never
                              runs anything; a skill's scripts run later only under normal approval.
                          </p>
                          <div class="skills-tab" id="skills-tab-root"></div>
                      </section>

                    <section class="settings-tab-content" id="tab-mcp">
                        <p class="settings-description">
                            Connect external tools via the Model Context Protocol. Servers run as
                            local subprocesses; their tools appear to the assistant with approval.
                        </p>
                        <div class="settings-form" id="mcp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-acp">
                        <p class="settings-description">
                            Drive external agents that speak the Agent Client Protocol (e.g. Gemini
                            CLI, Zed agents). Each runs as a local subprocess and appears as a model
                            in the picker under the ACP provider. The agent runs its own tool loop.
                        </p>
                        <div class="settings-form" id="acp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-connectivity">
                        <p class="settings-description">
                            Control who can reach this Juggler instance.
                        </p>
                        <div class="settings-form" id="connectivity-form">
                        </div>
                        <div class="settings-section-heading">Proxy Settings</div>
                        <div class="settings-form" id="proxy-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-notifications">
                        <div class="settings-form" id="notifications-form"></div>
                        <div class="settings-section-heading">Tabs</div>
                        <div class="settings-form" id="tab-behaviour-form"></div>
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

                    <section class="settings-tab-content" id="tab-updates">
                        <p class="settings-description">
                            Control whether Juggler checks for and downloads new versions, and
                            check for one now. A check sends this build's version, OS and
                            architecture, and counts each install once a day.
                        </p>
                        <div class="settings-form" id="updates-form"></div>
                    </section>
                </main>
            </modal-panel>
        `;
    // Let each tab build its static DOM / wire its persistent listeners. The
    // eager tabs (Notifications, Shortcuts, Info cards) render their forms here
    // with no server fetch (per-window prefs / the shortcut manager); the Logs
    // tab wires its persistent picker listener. Data-driven tabs render later
    // from loadConfig() / show().
    for (const tab of Object.values(this._tabs)) {
      if (tab.render) tab.render();
    }
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
   * Switch to a different tab. Toggles the button/section active classes, then
   * hands off pollers by hiding the previous tab and showing the new one — each
   * tab arms/disarms its own poll in show()/hide().
   * @param {string|undefined} tabName - The tab to switch to
   * @private
   */
  switchTab(tabName) {
    if (!tabName) return;

    // Back-compat: the Extensions tab was historically the "context-items" tab
    // (it hosts <plugin-catalog>), and the Defaults tab was the "default-model"
    // tab. Accept the old ids so any saved/deep-linked caller still lands on the
    // right tab.
    if (tabName === 'context-items') tabName = 'extensions';
    if (tabName === 'default-model') tabName = 'defaults';

    const prevTab = this.currentTab;
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

    // Per-tab background pollers move with visibility: stop the tab we're leaving,
    // then show the one being revealed. Each tab's show()/hide() owns its own
    // poll, so nothing polls while its tab is hidden. Connectivity self-gates its
    // show() on having been loaded (the shared config fetch); the Logs/MCP/ACP
    // tabs fetch their own data, so they work even when opened directly.
    if (prevTab && this._tabs[prevTab]) this._tabs[prevTab].hide?.();
    this._tabs[tabName]?.show?.();
  }

  /**
   * Open the settings panel
   * @param {string} [tab] - Optional tab to switch to on open
   * @param {{capability?: {itemType: string, id: string}, mcpServer?: string, conversationLog?: string}} [options] - Optional target to reveal inside the tab
   */
  async open(tab, options = {}) {
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

    if (options.capability) {
      this._revealCapability(options.capability);
    }

    if (options.mcpServer) {
      this._revealMcpServer(options.mcpServer);
    }

    if (options.conversationLog) {
      this._revealConversationLog(options.conversationLog);
    }

    // Load config (only fetches from API on first load). The first-load latch is
    // set only when the load actually succeeded: a failed load leaves the panel
    // with nothing rendered, so latching it would make that emptiness permanent
    // for the life of the window. Reveal the content pane either way, so a
    // failure leaves a dismissable panel rather than an endless spinner.
    if (isFirstLoad) {
      const loaded = await this.loadConfig();
      this._hasLoadedOnce = loaded;
      this.classList.add('loaded');
    }
  }

  /**
   * Deep-link into the Extensions tab's catalog: select one capability's entry.
   * The catalog fetches its own data, so the target is handed over and applied
   * by the component once it is ready — this open() must not wait on it.
   * @param {{itemType: string, id: string}} capability - Capability type + registry id
   * @private
   */
  _revealCapability(capability) {
    const catalog = /** @type {any} */ (this.querySelector('plugin-catalog'));
    Promise.resolve(catalog?.revealCapability?.(capability.itemType, capability.id))
      .catch((error) => console.error('Failed to reveal capability in the extensions catalog:', error));
  }

  /**
   * Deep-link into the MCP tab: open one server's edit form. The tab fetches its
   * own config, so like the catalog it is handed the target and applies it when
   * that fetch lands — open() must not wait on it.
   * @param {string} name - MCP server name
   * @private
   */
  _revealMcpServer(name) {
    Promise.resolve(/** @type {any} */ (this._tabs.mcp)?.revealEntry?.(name))
      .catch((error) => console.error('Failed to reveal the MCP server in settings:', error));
  }

  /**
   * Deep-link into the Logs tab: select one conversation's log. Like the two
   * above, the tab fetches its own list, so it is handed the id and applies it
   * once that lands. A conversation with no log file yet simply leaves the tab
   * on its default selection.
   * @param {string} conversationId - Conversation whose log to show
   * @private
   */
  _revealConversationLog(conversationId) {
    Promise.resolve(/** @type {any} */ (this._tabs.logs)?.revealEntry?.(conversationId))
      .catch((error) => console.error('Failed to reveal the conversation log in settings:', error));
  }

  /**
   * Close the settings panel
   */
  close() {
    this.classList.remove('show');
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }

    // Stop each tab's poll and drop any in-progress add/edit form and open
    // log/error so a reopen starts fresh — the generic text-input clear below
    // would otherwise blank a config form's fields while leaving its working
    // state set.
    for (const tab of Object.values(this._tabs)) {
      if (tab.close) tab.close();
    }

    // Clear any unsaved secret input fields (API keys) and update buttons.
    // .settings-value-input marks NON-secret persisted values (gateway base URL,
    // custom headers, Ollama host, Claude Code path, stream idle timeout): those
    // must stay visible across a panel close/reopen, since open() only re-fetches
    // and re-renders on first load — blanking them here would leave them empty
    // forever and make a saved value look lost.
    const inputs = this.querySelectorAll('input[type="text"]:not(.settings-value-input)');
    inputs.forEach(input => {
      /** @type {HTMLInputElement} */ (input).value = '';
    });
    /** @type {any} */ (this._tabs.providers).updateAllButtons();
  }

  /**
   * Resolve the provider list to render from the /api/providers payload.
   *
   * That endpoint serves a cache the server fills asynchronously *after* it
   * starts listening, so for the first moments of a launch it answers 200 with
   * an empty list and `ready: false`. An empty list is otherwise
   * indistinguishable from a genuine "no providers configured", and rendering it
   * leaves the panel blank for as long as it stays open — so an unsettled empty
   * snapshot waits for the settled providers-update instead (providersCache
   * mirrors that push and resolves immediately once it has arrived).
   *
   * A non-empty list is a real answer whatever the flag says, which also keeps
   * servers and test fixtures that never send `ready` on the fast path.
   * @param {any} payload - The decoded /api/providers response.
   * @returns {Promise<any[]>} The provider list to render.
   * @private
   */
  async _settledProviders(payload) {
    const list = payload?.providers || [];
    if (payload?.ready === true || list.length > 0) return list;

    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    try {
      const settled = await Promise.race([
        providersCache.waitForReady(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), PROVIDERS_READY_TIMEOUT_MS);
        }),
      ]);
      return settled || list;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Load current configuration from backend and fan it out to every tab.
   * @param {boolean} [renderFields=true] - Whether to render form fields (false when just updating status)
   * @returns {Promise<boolean>} True if the load succeeded; false if it failed and should be retried.
   * @private
   */
  async loadConfig(renderFields = true) {
    try {
      // Load config, providers, the default model, and connectivity state.
      // Config and providers are required — a failure aborts the whole load;
      // the other three fall back to the tab's current value, so a blip leaves
      // the already-rendered picker alone rather than blanking it.
      const [config, providersData, defaultModel, cheapModel, connectivity] = await Promise.all([
        fetchJson('/api/config', { errorPrefix: 'Failed to load config' }),
        fetchJson('/api/providers', { errorPrefix: 'Failed to load providers' }),
        fetchJson('/api/default-model', { fallback: /** @type {any} */ (this._tabs.defaults).defaultModel }),
        fetchJson('/api/cheap-model', { fallback: /** @type {any} */ (this._tabs.defaults).cheapModel }),
        fetchJson('/api/connectivity', { fallback: /** @type {any} */ (this._tabs.connectivity).connectivity }),
      ]);

      // Show the platform-correct credentials location (XDG on Linux,
      // ~/.juggler on macOS/Windows) rather than the hardcoded literal.
      const credsPathEl = this.querySelector('#credentials-path');
      if (credsPathEl && config.configDir) {
        credsPathEl.textContent = `${config.configDir}/credentials.json`;
      }

      // Copied before sorting: an unsettled snapshot resolves to providersCache's
      // own array, which is shared with every other reader of the push.
      const providers = [...await this._settledProviders(providersData)].sort(
        (/** @type {any} */ a, /** @type {any} */ b) => a.displayName.localeCompare(b.displayName)
      );

      /** @type {LoadedSettings} */
      const data = { config, providers, defaultModel, cheapModel, connectivity };
      for (const tab of Object.values(this._tabs)) {
        if (tab.onConfigLoaded) tab.onConfigLoaded(data, renderFields);
      }
      return true;
    } catch (error) {
      console.error('Failed to load config:', error);
      await showAlert('Failed to load configuration', 'Error');
      return false;
    }
  }

}

customElements.define('settings-panel', SettingsPanel);

/**
 * Present the settings panel, creating it on first use.
 * @param {string} [tab] - Tab id to open on
 * @param {import('../services/settings-launcher.js').OpenSettingsOptions} [options] - What to reveal
 * @returns {void}
 */
function presentSettings(tab, options) {
  let panel = document.querySelector('settings-panel');
  if (!panel) {
    panel = document.createElement('settings-panel');
    document.body.appendChild(panel);
  }
  // @ts-ignore - open method exists on SettingsPanel custom element
  panel.open(tab, options);
}

// Everything in-app opens settings through services/settings-launcher.js; the
// window alias remains for extensions.
registerSettingsOpener(presentSettings);
// @ts-ignore - Adding custom property to window
window.openSettings = presentSettings;
