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

import JugglerElement from './juggler-element.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { fadeOutScrims } from '../utils/modal-scrim.js';
import { trapFocus } from '../utils/dialog-a11y.js';
import * as settingsApi from '../services/settings-api.js';
import { getGlobalSettings, onGlobalSettings, offGlobalSettings } from '../services/prefs.js';
import { registerSettingsOpener } from '../services/settings-launcher.js';
import { showAlert } from './modal-dialog.js';
import providersCache from '../services/providers-cache.js';
import { ProvidersTab } from './settings/providers-tab.js';
import { DefaultsTab } from './settings/defaults-tab.js';
import { ConnectivityTab } from './settings/connectivity-tab.js';
import { AppearanceTab } from './settings/appearance-tab.js';
import { LanguageTab } from './settings/language-tab.js';
import { NotificationsTab } from './settings/notifications-tab.js';
import { ShortcutsTab } from './settings/shortcuts-tab.js';
import { LogsTab } from './settings/logs-tab.js';
import { McpTab, AcpTab } from './settings/subprocess-tabs.js';
import { SkillsTab } from './settings/skills-tab.js';
import { CommandsTab } from './settings/commands-tab.js';
import { UpdatesTab } from './settings/updates-tab.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { t, markUntranslated, htmlSlots, withHtml } from '../../sdk/lib/i18n.js';

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
 * @property {import('../services/settings-api.js').DefaultModelChoice} defaultModel - The /api/default-model result.
 * @property {import('../services/settings-api.js').ModelChoice|null} [cheapModel] - The /api/cheap-model result.
 * @property {import('../services/settings-api.js').ModelChoice|null} [decisionModel] - The /api/decision-model result.
 * @property {object} connectivity - The /api/connectivity result.
 */

/**
 * The interface each settings tab implements. Every method but dispose() is
 * optional; the shell dispatches through the tab registry generically, so a tab
 * only implements what it needs. dispose() is required so that a tab holding
 * nothing outside its own section has to say so, rather than leave it unasked.
 * DOM queries are scoped to the tab's own `#tab-<name>` section.
 * @typedef {object} SettingsTabController
 * @property {() => void} [render] - Build static DOM / wire persistent listeners (called once, from the shell's render()).
 * @property {(data: LoadedSettings, renderFields: boolean) => void} [onConfigLoaded] - Receive the shared loadConfig() payload.
 * @property {() => void} [show] - Tab became visible: fetch own data / arm pollers.
 * @property {() => void} [hide] - Tab hidden: stop pollers.
 * @property {() => void} [close] - Panel closed: stop pollers, drop transient form state.
 * @property {() => void} [connect] - Element connected: take global/ws listeners. Idempotent, since a
 *   tab may take them at construction or render.
 * @property {() => void} dispose - Element disconnected: release everything held outside the
 *   tab's own section — global/ws listeners, pollers, popups drawn into <body>. The next
 *   connect() takes the listeners again.
 * @property {(settings: any) => void} [onSettingsChanged] - The global settings document changed (here or in another window): adopt the sections this tab owns.
 */

/**
 * SettingsPanel - Configuration panel
 *
 * A thin shell around a registry of per-tab controllers (one module each under
 * `settings/`). The shell owns the tab chrome, tab switching, first-load gating,
 * and the shared config fetch; each tab owns its own DOM, state, and pollers.
 *
 * The shell is drawn once, on first connect, because what the tabs draw into it
 * is drawn once too: the data-driven fields come from the first config load and
 * nothing redraws them. A panel moved or put back keeps its DOM and takes its
 * listeners — its own, and each tab's through `connect()` — again.
 */
class SettingsPanel extends JugglerElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.currentTab = 'providers';
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {boolean} @private */
    this._hasLoadedOnce = false;
    /** @type {boolean} @private - Whether the shell has been drawn (see the class doc). */
    this._rendered = false;
    /** @type {HTMLElement|null} @private - The horizontally-scrollable tab strip; watched to drive its edge-fade affordance. */
    this._tabScrollEl = null;
    /**
     * Adoption of the global settings document, from the prefs store. A machine
     * runs one server per open project and they all share settings.json, so a
     * change made in another window — or by another project's server — has to
     * reach the controls here. Every tab is constructed and live whether or not it
     * is the visible one, so the document goes to all of them; each decides what
     * to write and what to leave under the user's hands.
     *
     * ProvidersTab implements nothing here on purpose: the settings it cares
     * about (hidden models, per-model limits) reach it pre-folded into the
     * provider catalogue, and its model rows keep their state in a closure, so the
     * only way to refresh them is to rebuild the fields — which would close every
     * open model list, clear its filter, and empty an API-key field mid-typing.
     * That change arrives through providers-update instead.
     * @type {(settings: any) => void} @private
     */
    this._onSettingsChanged = (settings) => {
      this._dispatchSettings(settings || {});
    };

    // The tab registry: one controller per tab (Extensions gets none — its
    // section just hosts <plugin-catalog>). switchTab / loadConfig / close /
    // connect and disconnect dispatch through this generically.
    /** @type {ProvidersTab} @private */
    this._providersTab = new ProvidersTab(this);
    /** @type {DefaultsTab} @private */
    this._defaultsTab = new DefaultsTab(this);
    /** @type {ConnectivityTab} @private */
    this._connectivityTab = new ConnectivityTab(this);
    /** @type {Record<string, SettingsTabController>} @private */
    this._tabs = {
      providers: this._providersTab,
      defaults: this._defaultsTab,
      connectivity: this._connectivityTab,
      mcp: new McpTab(this),
      acp: new AcpTab(this),
      commands: new CommandsTab(this),
      skills: new SkillsTab(this),
      appearance: new AppearanceTab(this),
      language: new LanguageTab(this),
      notifications: new NotificationsTab(this),
      shortcuts: new ShortcutsTab(this),
      logs: new LogsTab(this),
      updates: new UpdatesTab(this),
    };
  }

  connectedCallback() {
    if (!this._rendered) {
      this._rendered = true;
      this.render();
      this.setupListeners();
    }
    this._followTabStrip();

    // Each tab removes its own global/ws listeners and stops its pollers on the
    // way out, and takes the listeners again on the way back in.
    const tabs = Object.values(this._tabs);
    for (const tab of tabs) {
      if (tab.connect) tab.connect();
    }
    this.addCleanup(() => {
      for (const tab of tabs) tab.dispose();
    });
    this.addCleanup(() => {
      this._releasePopupOpen?.();
      this._releasePopupOpen = null;
    });

    // The settings document comes from the prefs store, which reads it once for
    // the page and keeps it current: the panel neither fetches it nor watches the
    // socket for it. A tab cannot tell — and has no reason to care — whether a
    // document arrived because this window asked or because another window changed
    // it, so both arrive by the same call.
    onGlobalSettings(this._onSettingsChanged);
    this.addCleanup(() => offGlobalSettings(this._onSettingsChanged));
    void getGlobalSettings().then(this._onSettingsChanged);
  }

  /**
   * Hand one settings document to every tab that reads one.
   * @param {any} settings - The whole document.
   * @private
   */
  _dispatchSettings(settings) {
    for (const tab of Object.values(this._tabs)) {
      if (tab.onSettingsChanged) tab.onSettingsChanged(settings);
    }
  }

  /**
   * Render the settings panel
   * @private
   */
  render() {
    const isMac = !!navigator.platform && /mac|iphone|ipad/i.test(navigator.platform);
    const credentials = { path: '<code id="credentials-path">~/.juggler/credentials.json</code>' };
    this.innerHTML = `
            <modal-backdrop class="settings-backdrop" id="settings-backdrop"></modal-backdrop>
            <modal-panel class="settings-container" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Settings'))}">
                <button class="close-button" id="settings-close" title="${escapeHtml(t('Close'))}" aria-label="${escapeHtml(t('Close'))}"><span class="icon-close"></span></button>
                <nav class="settings-tabs">
                    <div class="settings-tabs-scroll">
                        <!-- First, and marked by its icon: whoever needs this tab may not read the language the rest are in. -->
                        <button class="settings-tab settings-tab-language" data-tab="language"><span class="icon-language" aria-hidden="true"></span><span>${escapeHtml(t('Language'))}</span></button>
                        <button class="settings-tab active" data-tab="providers">${escapeHtml(t('Providers'))}</button>
                        <button class="settings-tab" data-tab="defaults">${escapeHtml(t('Defaults'))}</button>
                        <button class="settings-tab" data-tab="connectivity">${escapeHtml(t('Connectivity'))}</button>
                        <button class="settings-tab" data-tab="extensions">${escapeHtml(t('Extensions'))}</button>
                        <button class="settings-tab" data-tab="commands">${escapeHtml(t('Slash commands'))}</button>
                        <button class="settings-tab" data-tab="skills">${escapeHtml(t('Skills'))}</button>
                        <button class="settings-tab" data-tab="mcp">${escapeHtml(t('MCP servers'))}</button>
                        <button class="settings-tab" data-tab="acp">${escapeHtml(t('ACP agents'))}</button>
                        <button class="settings-tab" data-tab="appearance">${escapeHtml(t('Appearance'))}</button>
                        <button class="settings-tab" data-tab="notifications">${escapeHtml(t('Notifications'))}</button>
                        <button class="settings-tab" data-tab="shortcuts">${escapeHtml(t('Keyboard shortcuts'))}</button>
                        <button class="settings-tab" data-tab="logs">${escapeHtml(t('Logs'))}</button>
                        <button class="settings-tab" data-tab="updates">${escapeHtml(t('Updates'))}</button>
                    </div>
                </nav>

                <div class="settings-loading" id="settings-loading">
                    <juggler-spinner style="--size: 2.5rem"></juggler-spinner>
                    <div class="settings-loading-text">${escapeHtml(t('Loading settings...'))}</div>
                </div>

                <main class="settings-content">
                    <section class="settings-tab-content active" id="tab-providers">
                        <p class="settings-description">
                            ${withHtml(t('Provider keys are stored in {path}.', htmlSlots(credentials)), credentials)}
                        </p>

                        <div class="settings-form" id="provider-form">
                            <div id="provider-fields-container"></div>
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-defaults">
                        <div class="settings-section-heading">${escapeHtml(t('New conversation defaults'))}</div>
                        <div class="settings-form" id="new-conversation-defaults-form">
                            <div class="settings-card">
                                <div id="default-model-field-container"></div>
                                <div id="new-conversation-defaults-fields"></div>
                            </div>
                        </div>

                        <div class="settings-section-heading">${escapeHtml(t('Cheap model'))}</div>
                        <p class="settings-description">
                            ${escapeHtml(t('A small, fast model for the background jobs below. Extensions can use it too. Never used for your conversations.'))}
                        </p>
                        <div class="settings-form" id="cheap-model-form">
                            <div class="settings-card">
                                <div id="cheap-model-field-container"></div>
                                <div id="auto-name-form"></div>
                                <div id="reply-suggestions-field-container"></div>
                            </div>
                        </div>

                        <div class="settings-section-heading">${escapeHtml(t('Decision model'))}</div>
                        <p class="settings-description">
                            ${escapeHtml(t('A model that answers yes/no and multiple-choice questions with probabilities instead of writing text. Auto-approve uses it to judge tool calls. Add one in Providers; without one, the cheap model does the job.'))}
                        </p>
                        <div class="settings-form" id="decision-model-form">
                            <div class="settings-card">
                                <div id="decision-model-field-container"></div>
                            </div>
                        </div>

                        <div class="settings-form" id="global-settings"></div>
                    </section>

                     <section class="settings-tab-content" id="tab-extensions">
                          <plugin-catalog></plugin-catalog>
                     </section>

                      <section class="settings-tab-content" id="tab-commands">
                          <div class="command-page" id="commands-tab-root"></div>
                      </section>

                      <section class="settings-tab-content" id="tab-skills">
                          <p class="settings-description">
                              ${escapeHtml(t('Discover and install Agent Skills from external registries, or manage the ones you have. Installing downloads and writes files — it never runs anything; a skill\'s scripts run later only under normal approval.'))}
                          </p>
                          <div class="skills-tab" id="skills-tab-root"></div>
                      </section>

                    <section class="settings-tab-content" id="tab-mcp">
                        <p class="settings-description">
                            ${escapeHtml(t('Connect external tools via the Model Context Protocol. Servers run as local subprocesses; their tools appear to the assistant with approval.'))}
                        </p>
                        <div class="settings-form" id="mcp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-acp">
                        <p class="settings-description">
                            ${escapeHtml(t('Drive external agents that speak the Agent Client Protocol (e.g. Gemini CLI, Zed agents). Each runs as a local subprocess and appears as a model in the picker under the ACP provider. The agent runs its own tool loop.'))}
                        </p>
                        <div class="settings-form" id="acp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-connectivity">
                        <p class="settings-description">
                            ${escapeHtml(t('How other devices reach Juggler on this machine, who else is connected to this session, and the proxy Juggler uses to reach the internet.'))}
                        </p>
                        <div class="settings-form" id="connectivity-form">
                        </div>
                        <div class="settings-section-heading">${escapeHtml(t('Proxy Settings'))}</div>
                        <div class="settings-form" id="proxy-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-language">
                        <div class="settings-form" id="language-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-appearance">
                        <div class="settings-form" id="appearance-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-notifications">
                        <div class="settings-form" id="notifications-form"></div>
                        <div class="settings-section-heading">${escapeHtml(t('Tabs'))}</div>
                        <div class="settings-form" id="tab-behaviour-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-shortcuts">
                        <p class="settings-description">
                            ${escapeHtml(t('Keyboard shortcuts for common actions. Modifier keys are shown for {platform, select, mac {macOS} other {this platform}}.', { platform: isMac ? 'mac' : 'other' }))}
                        </p>
                        <div class="settings-form" id="shortcuts-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-logs">
                        <p class="settings-description">
                            ${escapeHtml(t('Logs for the current session. Pick a file to view it live — it updates as the app writes to it. To report a bug, reveal the file and zip its folder.'))}
                        </p>
                        <div class="settings-form" id="logs-form">
                            <div class="logs-empty" id="logs-empty">${escapeHtml(t('No log files yet.'))}</div>
                            <div class="logs-controls" id="logs-controls" hidden>
                                <label class="logs-picker-label" for="logs-picker">${escapeHtml(t('Log file'))}</label>
                                <select class="logs-picker" id="logs-picker"></select>
                            </div>
                            <div class="logs-filepath" id="logs-filepath"></div>
                            <pre class="logs-viewer surface-well" id="logs-viewer" tabindex="0" hidden></pre>
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-updates">
                        <p class="settings-description">
                            ${escapeHtml(t('Control whether Juggler checks for and downloads new versions, and check for one now. A check sends this build\'s version, OS and architecture, and the package manager that installed it, if any.'))}
                        </p>
                        <div class="settings-form" id="updates-form"></div>
                    </section>
                </main>
            </modal-panel>
        `;
    // Let each tab build its static DOM / wire its persistent listeners. The
    // eager tabs (Appearance, Notifications, Shortcuts, Info cards) render here
    // with no server fetch (per-window prefs / the shortcut manager); the Logs
    // tab wires its persistent picker listener. Data-driven tabs render later
    // from loadConfig() / show().
    for (const tab of Object.values(this._tabs)) {
      if (tab.render) tab.render();
    }
  }

  /**
   * Wire the shell's own controls. They are children drawn once with it, so the
   * listeners go with them and are bound once.
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

    this._tabScrollEl = /** @type {HTMLElement|null} */ (this.querySelector('.settings-tabs-scroll'));
  }

  /**
   * Drive the tab strip's edge-fade affordance from its actual scroll state,
   * so a left/right fade appears only when there really are tabs hidden past
   * that edge (see .settings-tabs-scroll in components/settings.css). The
   * ResizeObserver recomputes when the panel is first shown (0→real width) or
   * the viewport changes; the scroll listener handles swiping and
   * scrollIntoView jumps. Taken on every connect, released on disconnect.
   * @private
   */
  _followTabStrip() {
    const tabScroll = this._tabScrollEl;
    if (!tabScroll) return;
    this.on(tabScroll, 'scroll', () => this._updateTabOverflow(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => this._updateTabOverflow());
      resizeObserver.observe(tabScroll);
      this.addCleanup(() => resizeObserver.disconnect());
    }
    this._updateTabOverflow();
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
   * @param {import('../services/settings-launcher.js').OpenSettingsOptions} [options] - Optional target to reveal inside the tab
   */
  async open(tab, options = {}) {
    const isFirstLoad = !this._hasLoadedOnce;
    const wasOpen = this.classList.contains('show');

    // Show panel - only show loading state on first load
    this.classList.add('show');
    if (isFirstLoad) {
      this.classList.remove('loaded');
    }

    // Escape and the browser/mobile Back button dismiss via popup-manager, and
    // the open panel holds Tab; one release ends both.
    if (!this._releasePopupOpen) {
      const releasePopup = markPopupOpen(() => this.close());
      const releaseTrap = trapFocus(this);
      this._releasePopupOpen = () => { releasePopup(); releaseTrap(); };
    }

    // Switch to specified tab if provided (before loading so tab is ready).
    // Reopened on the tab it was left on, that tab is shown again: close()
    // stopped its poll. Already open, it is polling, and a second show()
    // would arm a second poll.
    if (tab) {
      this.switchTab(tab);
    } else if (!wasOpen) {
      this._tabs[this.currentTab]?.show?.();
    }

    if (options.capability) {
      this._revealCapability(options.capability);
    }

    if (options.newCommand) {
      this._revealNewCommand(options.newCommand.name);
    }

    if (options.mcpServer) {
      this._revealMcpServer(options.mcpServer);
    }

    if (options.conversationLog) {
      this._revealConversationLog(options.conversationLog);
    }

    if (options.model) {
      this._revealModel(options.model);
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
   * Deep-link into the Slash commands tab: open a new command's draft. The tab
   * reads its own lists, so it is handed the name and applies it once they land.
   * @param {string} [name] - Name to pre-fill
   * @private
   */
  _revealNewCommand(name) {
    Promise.resolve(/** @type {any} */ (this._tabs.commands)?.revealNewCommand?.(name))
      .catch((error) => console.error('Failed to open a new command in settings:', error));
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
   * Deep-link into the Providers tab: open one model's row and focus its Context
   * window field — where a window Juggler had to assume gets corrected. The tab
   * draws its fields once the panel's config load lands, so like the others it
   * is handed the target and applies it when that happens.
   * @param {{provider: string, id: string}} model - Provider name and model id
   * @private
   */
  _revealModel(model) {
    Promise.resolve(/** @type {any} */ (this._tabs.providers)?.revealModel?.(model.provider, model.id))
      .catch((error) => console.error('Failed to reveal the model in provider settings:', error));
  }

  /**
   * Close the settings panel
   */
  close() {
    fadeOutScrims(this);
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
    // forever and make a saved value look lost. The command editor's fields are
    // a draft the Slash commands tab keeps across a close, so they stay too.
    const inputs = this.querySelectorAll('input[type="text"]:not(.settings-value-input, .command-editor-input)');
    inputs.forEach(input => {
      /** @type {HTMLInputElement} */ (input).value = '';
    });
    this._providersTab.updateAllButtons();
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
      const held = this._defaultsTab.currentModelChoices();
      const [config, providersData, defaultModel, cheapModel, decisionModel, connectivity] = await Promise.all([
        // Both prefixes reach only the console: the catch below shows its own message.
        settingsApi.getConfig({ errorPrefix: markUntranslated("Couldn't load config") }),
        settingsApi.getProviders({ errorPrefix: markUntranslated('Failed to load providers') }),
        settingsApi.getDefaultModel({ fallback: held.defaultModel }),
        settingsApi.getCheapModel({ fallback: held.cheapModel }),
        settingsApi.getDecisionModel({ fallback: held.decisionModel }),
        settingsApi.getConnectivity({ fallback: this._connectivityTab.currentConnectivity() }),
      ]);

      // Show the platform-correct credentials location (XDG on Linux,
      // ~/.juggler on macOS/Windows) rather than the hardcoded literal.
      const credsPathEl = this.querySelector('#credentials-path');
      if (credsPathEl && config.configDir) {
        // i18n-ignore: a file path
        credsPathEl.textContent = `${config.configDir}/credentials.json`;
      }

      // Copied before sorting: an unsettled snapshot resolves to providersCache's
      // own array, which is shared with every other reader of the push.
      const providers = [...await this._settledProviders(providersData)].sort(
        (/** @type {any} */ a, /** @type {any} */ b) => a.displayName.localeCompare(b.displayName)
      );

      /** @type {LoadedSettings} */
      const data = { config, providers, defaultModel, cheapModel, decisionModel, connectivity };
      for (const tab of Object.values(this._tabs)) {
        if (tab.onConfigLoaded) tab.onConfigLoaded(data, renderFields);
      }
      return true;
    } catch (error) {
      console.error('Failed to load config:', error);
      await showAlert(t('Couldn\'t load configuration'), t('Error'));
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
