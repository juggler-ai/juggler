//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<model-selector>` — the composer's host for the shared model UI.
 *
 * It owns none of the presentation: a `<model-chip>` child is the button and a
 * `<model-picker>` is the popup, both of them dumb and controlled. What lives
 * here is everything those two deliberately don't know — which conversation or
 * sub-thread is bound, how a choice is written into the Yjs document, how a
 * hold-to-cycle gesture buffers previews away from a running turn, and what the
 * composer's own footer actions do.
 *
 * The binding is thread-first: with a message thread set, the selection reads
 * and writes that thread's `modelConfig` (inheriting from its parent when it has
 * no override of its own); otherwise it is the conversation's default. That is
 * also why the picker's bottom row is labelled per binding — clearing a
 * sub-thread means inheriting from the parent, clearing the root means no model.
 * @module components/model-selector
 */

import { presentPopup } from '../utils/popup-surface.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import connectionStatus from '../services/connection-status.js';
import recentModels from '../services/recent-models.js';
import { buildModelConfig, sameModelConfig } from '../model/model-config.js';
import { modelLabel } from '../model/model-display.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import CycleBuffer from '../services/cycle-buffer.js';
import { showConfirm } from './modal-dialog.js';
import { openSettings } from '../services/settings-launcher.js';
import { tierIds } from './model-picker/model-tuning.js';
import './model-picker/model-chip.js';
import './model-picker/model-picker.js';

/**
 * @typedef {import('./model-picker/model-picker.js').PickerProvider} Provider
 * @typedef {import('./model-picker/model-picker.js').PickerModel} ModelInfo
 */

/**
 * What the picker says while the bound scope has a turn in flight.
 *
 * The model config is read from the document on every request build, never
 * captured at turn start, so a write lands on the running turn's next call.
 * Nothing in the picker was ever disabled mid-turn, but neither did anything
 * say so, and the safe reading of an undefined control is "stop the turn first"
 * — which costs the work already done.
 */
const RUNNING_TURN_NOTE = 'A turn is running. A change takes effect on its next request — no need to stop it.';

/**
 * Why a CLI provider is not offered to a conversation working in a workspace
 * with no directory on this machine. Juggler spawns such a provider as a
 * subprocess here, in a directory that would not be the one the turn's file
 * operations use — which goes wrong quietly, so it is refused loudly.
 */
export const WORKSPACE_ELSEWHERE_HINT = 'Runs on this machine; this conversation works elsewhere';

class ModelSelector extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.provider = 'Loading...';
    /** @type {string} @private */
    this.model = '';
    /** @type {Provider[]} @private */
    this.providers = [];
    /** @type {boolean} @private */
    this.dropdownOpen = false;
    /** @type {import('../services/connection-status.js').ConnectionStatus} @private */
    this.connectionStatus = null; // 'error', 'disconnected', 'connecting', or null for connected
    /** @type {(() => void)|null} @private - connectionStatus subscription. */
    this._connectionStatusOff = null;
    /** @type {boolean} @private */
    this.loadingProviders = false;
    /** @type {import('../model/conversation.js').default|null} @private */
    this.conversation = null;
    /**
     * The open picker element, else null. Instance-scoped so updates and
     * teardown never touch a sibling's surface: multiple selectors coexist (root
     * + each open sub-thread column) and all present `.model-picker` surfaces, so
     * a document-wide query would grab the wrong one.
     * @type {import('./model-picker/model-picker.js').default|null} @private
     */
    this._picker = null;
    /** @type {(() => void)|null} @private - presentPopup release for the open picker. */
    this._pickerRelease = null;
    /** @type {import('../services/websocket.js').WSEventCallback|null} @private */
    this._providersUpdateHandler = null;
    /** @type {import('../model/message-thread.js').default|null} @private */
    this._messageThread = null;
    /**
     * The LIVE model config: the committed selection normally, and the previewed
     * hop while a hold-to-cycle gesture is in progress. `this.provider`/`this.model`
     * track it too, so the picker/popover HUD shows the preview. The collapsed
     * BUTTON reads `_committed` instead while the gesture runs, so it stays frozen
     * until release.
     * @type {*} @private
     */
    this._currentConfig = null;
    /**
     * The button's frozen `{provider, model, config}` snapshot during a gesture,
     * taken at `beginCycle`; null when no gesture is running (the button then
     * reads the live fields).
     * @type {{provider: string, model: string, config: *}|null} @private
     */
    this._committed = null;
    /**
     * The shared display-defence lifecycle for the hold-to-cycle gesture: while
     * it runs the button is frozen at `_committed` and doc-sync is blocked; on
     * commit it pins the landing config against the post-commit sync bounce until
     * the running turn settles. It does not touch the doc. See `beginCycle` /
     * `commitCycle` and the CycleBuffer module doc.
     * @type {CycleBuffer<*>} @private
     */
    this._cycle = new CycleBuffer({
      isEqual: sameModelConfig,
      // Force a re-sync once the backstop releases a pin, in case the value we
      // masked reflected a genuine external change rather than the transient bounce.
      onRelease: () => this._syncModelDisplay(),
    });
  }

  connectedCallback() {
    // Seed before the first render, then follow: an instance created during an
    // outage (a tab opened while the socket is down) must show the fault too,
    // and every instance shows it — not just whichever one a document query
    // happened to reach first.
    this.connectionStatus = connectionStatus.get();
    this._connectionStatusOff = connectionStatus.subscribe(
      (status) => this.setConnectionStatus(status)
    );

    this.render();
    this.fetchProviders();

    // Listen for incremental provider updates from WebSocket
    this._providersUpdateHandler = (/** @type {unknown} */ data) => {
      this.providers = /** @type {Provider[]} */ (data);
      this._syncModelDisplay();
      // The button's label is resolved from the providers list (to map the model
      // id to its display name), so a push that first supplies those names must
      // refresh it — even when provider/model are unchanged. Without this,
      // setModel() short-circuits on the equal id and the button keeps showing
      // the raw model id from the pre-compute connect seed.
      this._pushToChip();
      this._picker?.refresh();
      if (this._picker) this._picker.providers = this.providers;
    };
    wsService.on('providers-update', this._providersUpdateHandler);
  }

  disconnectedCallback() {
    // Tear down the picker (and, through the chip, the mini popover), both of
    // which live on document.body.
    this.closeDropdown();
    if (this._providersUpdateHandler) {
      wsService.off('providers-update', this._providersUpdateHandler);
    }
    if (this._connectionStatusOff) {
      this._connectionStatusOff();
      this._connectionStatusOff = null;
    }
    // Drop any gesture/pin state (clears the pin's backstop timer).
    this._cycle.reset();
  }

  /**
   * @returns {any} The chip child, or null before the first render.
   * @private
   */
  get _chip() {
    return this.querySelector('model-chip');
  }

  /**
   * Set the message thread this model selector is bound to.
   * Updates display with the thread's effective model config.
   * @param {import('../model/message-thread.js').default|null} messageThread
   */
  setMessageThread(messageThread) {
    this._messageThread = messageThread;
    this._syncModelDisplay();
  }

  /**
   * Set the conversation this model selector is bound to
   * @param {import('../model/conversation.js').default|null} conversation
   */
  setConversation(conversation) {
    this.conversation = conversation;
    this._syncModelDisplay();
  }

  /**
   * Sync the model display with the current thread/conversation state.
   * @private
   */
  _syncModelDisplay() {
    // The CycleBuffer decides whether the doc may drive the display right now.
    // While a gesture buffers, it rejects the read so the previewed hop stays on
    // screen (re-reading the doc — e.g. from an async providers-update push the
    // HUD's own open→refresh triggers ~0.5-1s later — would clobber the preview
    // back to the original model). After a commit it rejects the transient
    // post-commit bounce until the running turn settles. Either way the open
    // picker still refreshes so updated availability shows.
    const config = this._getEffectiveConfig();
    if (!this._cycle.accepts(config)) {
      this._refreshPicker();
      return;
    }
    this._currentConfig = config;
    this.setModel(config?.provider || '', config?.model || '');
  }

  /**
   * Get the effective model config from thread or conversation
   * @returns {*} The active model config
   * @private
   */
  _getEffectiveConfig() {
    if (this._messageThread) {
      return this._messageThread.modelConfig;
    }
    if (this.conversation) {
      return this.conversation.modelConfig;
    }
    return null;
  }

  /** @private */
  async fetchProviders() {
    // If the cache already has data, use it synchronously to avoid a render with
    // the loading state. Otherwise show loading and wait for the first push.
    if (providersCache.hasReceived()) {
      this.providers = providersCache.get();
      this.loadingProviders = false;
      this._pushToChip();
      this._refreshPicker();
      return;
    }

    this.loadingProviders = true;
    this._refreshPicker();
    this.providers = await providersCache.waitForFirst();
    this.loadingProviders = false;
    this._pushToChip();
    this._refreshPicker();
  }

  /**
   * Re-sync from the cache. The WS push subscriber already keeps
   * `this.providers` fresh; this just covers the case where the cache was
   * populated after fetchProviders() ran but before the picker was opened.
   * @private
   */
  _refreshProvidersInBackground() {
    const fresh = providersCache.get();
    if (JSON.stringify(fresh) !== JSON.stringify(this.providers)) {
      this.providers = fresh;
      this._refreshPicker();
    }
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  setModel(provider, model) {
    if (this.provider === provider && this.model === model) {
      // The dials may still have moved under an unchanged pair, so keep the
      // dependent surfaces current before short-circuiting.
      this._pushToChip();
      this._refreshPicker();
      return;
    }
    this.provider = provider;
    this.model = model;
    this._pushToChip();
    this._refreshPicker();
  }

  /**
   * Set connection status to display. Driven by the connectionStatus
   * subscription; exposed for tests that want to force a state.
   * @param {import('../services/connection-status.js').ConnectionStatus} status - 'error', 'disconnected', 'connecting', or null for connected
   */
  setConnectionStatus(status) {
    if (this.connectionStatus === status) {
      return;
    }
    this.connectionStatus = status;
    this._pushToChip();
  }

  // ── the chip ──────────────────────────────────────────────────────────────

  /**
   * The config the BUTTON shows: the committed snapshot while a gesture cycles
   * (previewed hops belong to the HUD, not the button), else the live config.
   * @returns {*} The config to display.
   * @private
   */
  _displayConfig() {
    const frozen = this._cycle.buffering ? this._committed : null;
    if (frozen) return frozen.config;
    // Before the doc is bound there is no config, but `provider` still carries
    // the loading sentinel the chip turns into its placeholder.
    return this._currentConfig || (this.provider && this.provider !== 'Loading...'
      ? { provider: this.provider, model: this.model }
      : null);
  }

  /**
   * Push the current state onto the chip and repaint it in place. In-place
   * because the button anchors the open picker and the pill anchors the mini
   * popover — replacing either would orphan a live surface.
   * @private
   */
  _pushToChip() {
    this._chip?.update({
      providers: this.providers,
      liveConfig: this._currentConfig,
      connectionState: this.connectionStatus,
      config: this._displayConfig(),
    });
  }

  // ── the picker ────────────────────────────────────────────────────────────

  /**
   * The bottom row's label, which depends on what clearing the selection MEANS
   * here: a sub-thread with its own override reverts to the model it inherits,
   * the root conversation is left with none.
   * @returns {string} The none row's label.
   * @private
   */
  _noneLabel() {
    return this._messageThread?.threadItemId ? 'Inherit from parent' : 'No model';
  }

  /**
   * Push current state into an open picker. No-op when it is shut.
   * @private
   */
  _refreshPicker() {
    if (!this._picker) return;
    this._picker.providers = this._offerableProviders();
    this._picker.noneLabel = this._noneLabel();
    this._picker.loading = this.loadingProviders;
    this._picker.value = this._currentConfig;
    this._picker.note = this._turnNote();
  }

  /**
   * The provider list as this conversation may use it.
   *
   * The picker is deliberately told nothing about conversations — it renders
   * what it is handed — so a constraint that depends on where this conversation
   * works is applied here, on the way in. A provider Juggler spawns as a
   * subprocess would run on this machine while every file operation of the turn
   * ran somewhere else, so for a workspace that says it cannot host one
   * ({@link Session#workspaceHostsLocalProviders}) it is marked unavailable
   * with that reason, which the picker already knows how to render and how to
   * refuse.
   * @returns {Provider[]} What may be offered.
   * @private
   */
  _offerableProviders() {
    const conversation = this._messageThread?.conversation || this.conversation;
    if (!conversation || conversation.workspaceHostsLocalProviders !== false) return this.providers;
    return this.providers.map((provider) => (
      /** @type {any} */ (provider).spawnsLocalProcess
        ? { ...provider, available: false, authHint: WORKSPACE_ELSEWHERE_HINT }
        : provider
    ));
  }

  /**
   * The note the picker carries, which is a note only while the scope this
   * selector writes into is mid-turn. Judged thread-first, exactly as the write
   * is: a sub-thread's picker answers for that thread, and a busy sibling is
   * not this thread's turn.
   * @returns {string} The note, or '' when nothing is running.
   * @private
   */
  _turnNote() {
    const running = this._messageThread
      ? !!this._messageThread.isProcessing
      : !!this.conversation?.isTurnActive();
    return running ? RUNNING_TURN_NOTE : '';
  }

  /** @private */
  toggleDropdown() {
    if (this.dropdownOpen) {
      this.closeDropdown();
      return;
    }
    this.dropdownOpen = true;

    const picker = /** @type {any} */ (document.createElement('model-picker'));
    picker.providers = this._offerableProviders();
    picker.value = this._currentConfig;
    picker.noneLabel = this._noneLabel();
    picker.loading = this.loadingProviders;
    picker.note = this._turnNote();
    picker.footerActions = [
      { id: 'providers', label: 'Manage LLM providers…', iconClass: 'menu-settings-icon' },
      { id: 'defaults', label: 'Manage default models…', iconClass: 'menu-settings-icon' },
    ];
    picker.addEventListener('change', (/** @type {Event} */ e) => {
      this._onPickerChange(/** @type {CustomEvent} */ (e).detail);
    });
    picker.addEventListener('action', (/** @type {Event} */ e) => {
      this._onPickerAction(/** @type {CustomEvent<{id: string}>} */ (e).detail.id);
    });
    picker.addEventListener('close', () => this.closeDropdown());
    this._picker = picker;

    const anchor = this._chip?.button;
    this._pickerRelease = presentPopup({
      surface: picker,
      anchor: anchor || this,
      id: 'model-selector',
      onClose: () => this.closeDropdown(),
      insideSelectors: ['model-selector', '.model-picker'],
    });

    // Ask the server to re-check external provider state. This catches cases
    // like `codex login` completing while Juggler is already open; the fresh list
    // arrives asynchronously via providers-update.
    providersCache.refresh().catch(err => console.warn('[ModelSelector] Failed to refresh providers:', err));

    // Silently sync providers from cache in background (self-healing if the
    // initial fetch failed).
    this._refreshProvidersInBackground();

    // Reload server-persisted recent models, then refresh the list when the
    // fresh set arrives.
    recentModels.refresh().then(() => this._refreshPicker()).catch(() => {});
  }

  /** @private */
  closeDropdown() {
    if (!this.dropdownOpen) return;
    this.dropdownOpen = false;
    if (this._pickerRelease) {
      this._pickerRelease();
      this._pickerRelease = null;
    }
    this._picker = null;
  }

  /**
   * Apply a choice made in the picker. A whole config or null arrives; null
   * clears the bound scope, which at the root nulls the conversation default and
   * on a sub-thread reverts it to the model it inherits.
   * @param {*} config - The chosen config, or null for the none row.
   * @private
   */
  _onPickerChange(config) {
    if (!config) {
      if (this._messageThread) {
        this._messageThread.modelConfig = null;
      } else if (this.conversation) {
        this.conversation.setModelConfig(null);
      }
      this._syncModelDisplay();
      this.closeDropdown();
      return;
    }
    this.selectProviderAndModel(config.provider, config.model, config.thinking, config.serviceTier);
  }

  /**
   * Run one of the picker's footer actions. Both open the settings page that
   * owns what the action names — the picker chooses for this conversation, and
   * anything wider than this conversation is settled in settings.
   * @param {string} id - The action's id.
   * @private
   */
  _onPickerAction(id) {
    if (id === 'providers') {
      this.closeDropdown();
      openSettings('providers');
      return;
    }
    if (id === 'defaults') {
      this.closeDropdown();
      openSettings('defaults');
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /**
   * Write a thinking-level choice into the same scope the model selection writes
   * to. `level === ''` means Default → delete the `thinking` key (never store
   * `thinking: ''`). Rebuilds the whole config atomically (never mutate the
   * Y.Map field-by-field — see the race note in conversation.js). Shared by the
   * picker's dials, the chip's mini popover, and the cycle-thinking shortcut.
   * Pure write — the caller owns any re-render (see `refreshThinkingDisplay`).
   * @param {string} level - '' for Default, else a native provider level.
   * @returns {boolean} True when the level was written.
   */
  applyThinkingLevel(level) {
    const eff = this._currentConfig;
    if (!eff || !eff.provider || !eff.model) return false;

    // Carry the serving tier through untouched: the two dials are independent,
    // and dropping one here would quietly revert a paid choice.
    const next = buildModelConfig(eff.provider, eff.model, level, eff.serviceTier);

    if (!this._writeOrDefer(next)) return false;

    this._currentConfig = next;
    return true;
  }

  /**
   * Write a serving-tier choice into the same scope the model selection writes
   * to. `tier === ''` means Standard → delete the `serviceTier` key (never store
   * `serviceTier: ''`). Carries the thinking level through untouched, for the
   * same reason `applyThinkingLevel` carries the tier. Pure write — the caller
   * owns any re-render.
   * @param {string} tier - '' for Standard, else an advertised tier id.
   * @returns {boolean} True when the tier was written.
   */
  applyServiceTier(tier) {
    const eff = this._currentConfig;
    if (!eff || !eff.provider || !eff.model) return false;

    const next = buildModelConfig(eff.provider, eff.model, eff.thinking, tier);

    if (!this._writeOrDefer(next)) return false;

    this._currentConfig = next;
    return true;
  }

  /**
   * The serving tiers the currently selected model advertises, in the provider's
   * declared order. Empty for standard-only models (or when nothing is selected).
   * @returns {string[]} Advertised tier ids in advertised order.
   */
  supportedServiceTiers() {
    const prov = this.providers.find(p => p.name === this.provider);
    return tierIds(prov?.modelsWithContext?.find(m => m.id === this.model));
  }

  /**
   * The thinking levels the currently selected model advertises, in the
   * provider's declared order. Empty for non-thinking models (or when nothing is
   * selected).
   * @returns {string[]} Supported levels in advertised order.
   */
  supportedThinkingLevels() {
    const prov = this.providers.find(p => p.name === this.provider);
    const modelEntry = prov?.modelsWithContext?.find(m => m.id === this.model);
    return (modelEntry?.thinkingLevels || []).slice();
  }

  /**
   * The current effective `{provider, model, thinking?, serviceTier?}` pair. The
   * thinking level is normalised to what the model advertises, so an unsupported
   * stored level reads as the model's default — which is where the thinking
   * cycle starts from. The tier is reported as stored: the model cyclers use
   * this pair to find their place in the Recent list, and a tier normalised away
   * here would step past the entry the user is actually on.
   * @returns {{provider: string, model: string, thinking?: string, serviceTier?: string}|null} The
   *   pair, or null when no model is selected.
   */
  currentConfigPair() {
    const c = this._currentConfig;
    if (!c || !c.provider || !c.model) return null;
    const level = c.thinking && this.supportedThinkingLevels().includes(c.thinking) ? c.thinking : '';
    return buildModelConfig(c.provider, c.model, level, c.serviceTier);
  }

  /**
   * Ask the server to re-read external provider credentials and wait for the
   * refreshed list to arrive, then return the named provider's fresh entry. Lets
   * a just-completed external login (e.g. `codex login`) be picked up without
   * relaunching the app. Resolves with the latest known entry even if no push
   * arrives within the timeout, so the caller never hangs.
   * @param {string} providerName
   * @returns {Promise<Provider|undefined>} The provider's fresh entry, or undefined if absent.
   * @private
   */
  async _recheckProviderAvailability(providerName) {
    const next = /** @type {Promise<Provider[]>} */(new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      /** @param {unknown} data */
      const handler = (data) => {
        if (timer) clearTimeout(timer);
        wsService.off('providers-update', handler);
        resolve(Array.isArray(data) ? /** @type {Provider[]} */(data) : this.providers);
      };
      wsService.on('providers-update', handler);
      timer = setTimeout(() => {
        wsService.off('providers-update', handler);
        resolve(this.providers);
      }, 4000);
    }));
    try {
      await providersCache.refresh();
    } catch (err) {
      console.warn('[ModelSelector] Provider re-check refresh failed:', err);
    }
    const list = await next;
    return list.find(p => p.name === providerName);
  }

  /**
   * Explain why a model can't be selected and offer a path to fix it. Shows the
   * provider's user-actionable hint (e.g. "Run `codex login` first") verbatim
   * when present, else a generic message — never phrased as "not available".
   * Offers "Go to provider settings" / "Cancel".
   * @param {Provider} provider
   * @param {string} modelName
   * @private
   */
  async _showSelectionProblem(provider, modelName) {
    const modelEntry = provider.modelsWithContext?.find(m => m.id === modelName);
    const label = modelLabel(modelEntry?.displayName, modelName);
    const hint = (provider.authHint || '').trim();
    await this._offerProviderSettings(hint
      ? `Can't select ${label} yet: ${hint}`
      : `There was a problem selecting ${label}.`);
  }

  /**
   * Explain that the model's provider isn't there at all. A custom provider can
   * be deleted while conversations still name it, and a recent entry or a
   * keyboard cycle can still ask for one — so this is a state the user reaches
   * by ordinary means, not a broken call.
   * @param {string} providerName
   * @param {string} modelName
   * @private
   */
  async _showMissingProvider(providerName, modelName) {
    await this._offerProviderSettings(
      `Can't select ${modelName}: the provider ${providerName} is not configured.`);
  }

  /**
   * Present a selection problem and take the user to provider settings if they
   * want it. Offers "Go to provider settings" / "Cancel".
   * @param {string} message
   * @private
   */
  async _offerProviderSettings(message) {
    const goToSettings = await showConfirm(message, 'Problem selecting model', {
      confirmText: 'Go to provider settings',
      cancelText: 'Cancel',
    });
    if (goToSettings) {
      this.closeDropdown();
      openSettings('providers');
    }
  }

  /**
   * Select a model, optionally at an explicit thinking level and serving tier.
   * Model plus both dials is one identity. A thinking level is honoured only
   * when the model advertises it (a stale level from a recent entry falls back
   * to the model's default); the serving tier is stored exactly as asked, since
   * the catalog decides what is shown and sent, never what is kept.
   * @param {string} providerName
   * @param {string} modelName
   * @param {string} [thinking] Native provider thinking level; absent/empty means the model's default level.
   * @param {string} [serviceTier] Advertised tier id; absent/empty means standard serving.
   */
  async selectProviderAndModel(providerName, modelName, thinking, serviceTier) {
    let provider = this.providers.find(p => p.name === providerName);

    if (!provider) {
      // A deleted custom provider outlives itself in conversations, recent
      // models and cycler state. Saying nothing here leaves a click that does
      // nothing at all, with the reason only in a console the user cannot see.
      await this._showMissingProvider(providerName, modelName);
      return;
    }

    if (!provider.available) {
      // The cached availability may be stale — the user could have just added
      // credentials externally (e.g. `codex login`). Re-check against the live
      // server state so a fresh login is picked up without an app relaunch.
      const refreshed = await this._recheckProviderAvailability(providerName);
      if (refreshed) provider = refreshed;
    }

    if (!provider.available) {
      await this._showSelectionProblem(provider, modelName);
      return;
    }

    if (!this.conversation) {
      console.error('[ModelSelector] No conversation bound');
      this.closeDropdown();
      return;
    }

    const modelEntry = provider.modelsWithContext?.find(m => m.id === modelName);
    const level = thinking && (modelEntry?.thinkingLevels || []).includes(thinking) ? thinking : '';
    // The tier is stored as asked. Whoever chose it already decided it belongs
    // on this model (the picker's own rule for a model change), and the catalog
    // is not a reliable veto: it is empty until the first model-list fetch lands
    // and can come back as a fallback carrying no tiers at all. Re-deriving it
    // here would silently spend the user's paid choice on those states. What the
    // catalog does decide is what is DISPLAYED (model-chip) and what is SENT
    // (the provider drops an unadvertised tier on the wire).
    const tier = serviceTier || '';

    // Already selected at this exact level and tier — just close. Both dials are
    // part of the identity, so the same model at a different level or tier is a
    // real change and falls through.
    if (this.provider === providerName && this.model === modelName
      && (this._currentConfig?.thinking || '') === level
      && (this._currentConfig?.serviceTier || '') === tier) {
      this.closeDropdown();
      return;
    }

    // An explicit pick supersedes any in-flight post-commit pin.
    this._cycle.reset();

    const nextConfig = buildModelConfig(providerName, modelName, level, tier);

    // Write to thread if bound, otherwise the conversation.
    if (this._messageThread) {
      this._messageThread.modelConfig = nextConfig;
    } else {
      this.conversation.setModelConfig(nextConfig);
    }

    this._currentConfig = nextConfig;
    this.provider = providerName;
    this.model = modelName;
    this._pushToChip();

    this.closeDropdown();
  }

  /**
   * Persist a config into the bound scope — the conversation/thread Y.Map the
   * engine (and any running turn) reads. The single write path shared by
   * `applyConfigPair` and the dial writers.
   * @param {{provider: string, model: string, thinking?: string, serviceTier?: string}} config
   * @returns {boolean} True when written; false when there is nothing bound.
   * @private
   */
  _writeConfigToDoc(config) {
    if (this._messageThread) {
      this._messageThread.modelConfig = config;
      return true;
    }
    if (this.conversation) {
      this.conversation.setModelConfig(config);
      return true;
    }
    return false;
  }

  /**
   * Write `config` now, or — during a hold-to-cycle gesture (`beginCycle`) —
   * buffer it so a running turn never observes an intermediate hop; the local
   * fields and HUD still update on every hop, and `commitCycle` flushes the
   * landing value once. Returns false only when nothing is bound to write to, so
   * callers still reject an inapplicable pair identically in both modes.
   * @param {{provider: string, model: string, thinking?: string, serviceTier?: string}} config
   * @returns {boolean} True when the choice may be applied to the display.
   * @private
   */
  _writeOrDefer(config) {
    // During a gesture, preview only — no doc write (a running turn never sees an
    // intermediate config); the landing config is written once by commitCycle.
    if (this._cycle.buffering) {
      return !!(this._messageThread || this.conversation);
    }
    // A non-buffered write is an explicit choice (a picked model/level) — it
    // supersedes any in-flight post-commit pin so the pick shows immediately.
    this._cycle.reset();
    return this._writeConfigToDoc(config);
  }

  // ── hold-to-cycle ─────────────────────────────────────────────────────────

  /**
   * Open the picker if it isn't already open. Public entry point for the
   * hold-to-cycle model shortcut, which uses it as the gesture's HUD.
   */
  open() {
    if (!this.dropdownOpen) this.toggleDropdown();
  }

  /**
   * Close the picker. Idempotent.
   */
  close() {
    this.closeDropdown();
  }

  /**
   * Apply a `{provider, model, thinking?, serviceTier?}` pair WITHOUT recording
   * it to the Recent list — the write path for the hold-to-cycle model shortcut,
   * whose intermediate hops must not reorder the very list being cycled (the
   * landing pair is recorded on commit, by the document write). The thinking
   * level is honoured only when the model advertises it and the tier is stored
   * as asked, like every other write path. Unlike
   * `selectProviderAndModel` this never prompts about an unavailable provider
   * (cycling just skips it, so the caller gets `false`) and never closes the
   * picker, which the gesture keeps open as its HUD.
   * @param {{provider: string, model: string, thinking?: string, serviceTier?: string}} pair
   * @returns {boolean} True when the pair was applied.
   */
  applyConfigPair(pair) {
    const provider = this.providers.find(p => p.name === pair.provider);
    if (!provider || !provider.available) return false;

    const modelEntry = provider.modelsWithContext?.find(m => m.id === pair.model);
    const level = pair.thinking && (modelEntry?.thinkingLevels || []).includes(pair.thinking) ? pair.thinking : '';
    // Stored as asked, like every other write — the pair's tier was recorded
    // against this very model, so the catalog has no say in keeping it.
    const tier = pair.serviceTier || '';

    const nextConfig = buildModelConfig(pair.provider, pair.model, level, tier);

    if (!this._writeOrDefer(nextConfig)) return false;

    this._currentConfig = nextConfig;
    this.provider = pair.provider;
    this.model = pair.model;

    // The open picker is the gesture's HUD: refresh it and the button in place.
    this._pushToChip();
    this._refreshPicker();
    return true;
  }

  /**
   * Begin a hold-to-cycle gesture: snapshot the committed config so the button
   * stays frozen on it while the picker/popover previews hops, and freeze
   * doc-sync. Idempotent, so the model and thinking cyclers (which share this
   * selector) can both open a gesture without the second disturbing the first.
   */
  beginCycle() {
    this._committed = { provider: this.provider, model: this.model, config: this._currentConfig };
    this._cycle.begin();
  }

  /**
   * Commit the gesture (modifier released): the previewed config becomes the
   * selection. If it changed, write it to the doc exactly once — so a running
   * turn only ever sees the final choice — and pin it against the post-commit
   * sync bounce until the turn settles. Then repaint the button DIRECTLY (not
   * via the doc-sync path, which the pin may gate). A pure hold-to-peek that
   * landed back on the committed config writes nothing.
   */
  commitCycle() {
    const landing = this._currentConfig;
    const changed = !sameModelConfig(landing, this._committed?.config);
    this._committed = null;
    if (changed && landing) {
      this._cycle.pin(landing);
      this._writeConfigToDoc(landing);
    } else {
      this._cycle.end();
    }
    this._pushToChip();
  }

  /**
   * Abandon the gesture (Escape): nothing was written, so drop the preview and
   * restore the live fields (button + picker/popover) to the committed config.
   */
  cancelCycle() {
    if (this._committed) {
      this.provider = this._committed.provider;
      this.model = this._committed.model;
      this._currentConfig = this._committed.config;
    }
    this._committed = null;
    this._cycle.end();
    this._pushToChip();
    this._refreshPicker();
  }

  /**
   * Open the mini thinking popover anchored to the button's pill — the public
   * entry point for the hold-to-cycle thinking shortcut's HUD. The pill always
   * exists for a selected thinking-capable model, so failure means the current
   * model has no thinking control.
   * @returns {boolean} True when the popover is (now) open.
   */
  openThinkingMini() {
    // With the picker open, close it first — same rule as the pill's own click
    // handler; closing repaints the button, so re-resolve the pill afterwards.
    if (this.dropdownOpen) this.closeDropdown();
    return !!this._chip?.openMini();
  }

  /**
   * Close the mini thinking popover if open. Idempotent.
   */
  closeThinkingMini() {
    this._chip?.closeMini();
  }

  /**
   * Refresh everything displaying the current thinking level after an
   * out-of-band level change (the hold-to-cycle thinking shortcut). With the
   * mini popover open it is the gesture's HUD: its control and the anchor pill
   * are updated IN PLACE, because replacing the pill would close the popover.
   */
  refreshThinkingDisplay() {
    const chip = this._chip;
    if (chip?.miniOpen) {
      chip.liveConfig = this._currentConfig;
      chip.refreshMini();
      return;
    }
    this._pushToChip();
    this._refreshPicker();
  }

  render() {
    // Cite the switch-model shortcut (⌥⌘M / Ctrl+Alt+M) live from the central
    // table, so the tooltip stays correct if it's ever rebound or left unbound.
    const cycleModelKey = keyShortcutManager.formatBinding('cycle-model');
    const modelTitle = cycleModelKey ? `LLM Model (${cycleModelKey}, hold for menu)` : 'LLM Model';

    this.innerHTML = '<model-chip></model-chip>';
    const chip = this._chip;
    if (!chip) return;
    chip.update({ placeholder: 'Select Model', pulseWhenEmpty: true, buttonTitle: modelTitle });
    chip.addEventListener('chip-toggle', () => this.toggleDropdown());
    chip.addEventListener('mini-requested', () => {
      // The pill promises the mini popover, so the picker sitting over it goes
      // first. Closing leaves the chip's DOM alone, so the pill is still the
      // anchor the popover then attaches to.
      this.closeDropdown();
    });
    chip.addEventListener('change', (/** @type {Event} */ e) => {
      const config = /** @type {CustomEvent} */ (e).detail;
      if (this.applyThinkingLevel(config.thinking || '')) this._pushToChip();
    });
    this._pushToChip();
  }
}

customElements.define('model-selector', ModelSelector);
