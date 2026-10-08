//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<model-picker>` — the popup for choosing a model, wherever a model is chosen.
 *
 * The element IS the popup surface: a host builds it detached, sets its
 * properties, and hands it to `presentPopup`, which owns the body-append,
 * anchored/sheet placement and dismissal. Nothing here knows about Yjs, threads
 * or settings files — the host supplies `value` and `providers`, and gets back a
 * `change` carrying a whole config (or null for the none row).
 *
 * Two columns on a desktop. The left one is a stack of labelled sections, each
 * closed by a hairline: the chosen model's card, its `<model-tuning>` dials, any
 * note the host wants read at the moment of choosing, Recent, and the host's
 * actions. The right one is the full list — every
 * provider under a header whose tri-state toggle cycles none / top / all, then
 * the host's none row ("No model", "Inherit from parent", "Automatic").
 *
 * The card also carries the chosen provider's quota meters, which are the one
 * thing the picker fetches for itself: usage is pull-based, no host has it to
 * hand, and the question is only worth asking while someone is looking at the
 * answer. The cache behind it debounces and de-dupes, so opening the picker over
 * and over costs one request every few minutes.
 *
 * Recent belongs beside the list rather than on top of it. It answers a
 * different question — "back to the one I was just on" against "what else is
 * there" — and as the list's first section it was indistinguishable from a
 * provider's. Pinned in the left column it stays put while the list scrolls, and
 * the actions sit below it: the list is what needs the height, and the dials
 * leave that space empty anyway. Below the phone breakpoint the grid collapses
 * to one column; the DOM order is the reading order, so nothing reshuffles.
 *
 * Typing filters. While the picker is open, printable keys go to the filter
 * rather than to whatever had focus, and a filter query expands every provider
 * to its full list — a match must be findable even inside a collapsed one.
 * Arrow keys walk the visible rows, Enter picks, Escape closes.
 * @module components/model-picker/model-picker
 */

import recentModels from '../../services/recent-models.js';
import usageStatsCache from '../../services/usage-stats-cache.js';
import { getRecommendedModels, sortModelsByVersion } from '../../utils/model-filter.js';
import { buildModelConfig, sameModelConfig } from '../../model/model-config.js';
import { modelLabel, modelLabelFromList } from '../../model/model-display.js';
import { formatTokens } from '../../utils/format.js';
import { renderUsageRow } from '../../utils/usage-renderer.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { CHECK_SVG } from '../../utils/icons.js';
import JugglerElement from '../juggler-element.js';
import { cachedUserPref, setUserPref } from '../../services/prefs.js';
import { openSettings } from '../../services/settings-launcher.js';
import providersCache from '../../services/providers-cache.js';
import { httpErrorText } from '../../services/http.js';
import './model-tuning.js';

/** The user preference holding the per-provider list view-state override map. */
const VIEW_STATE_PREF = 'juggler-model-view-state';

/** The list view-states a provider header toggle cycles through. */
const VIEW_STATES = ['none', 'top', 'all'];

/** How many Recent entries the list offers. */
const RECENT_LIMIT = 6;

/**
 * @typedef {object} PickerModel
 * @property {string} id - Model ID.
 * @property {number} [contextWindow] - Context window size.
 * @property {boolean} [windowAssumed] - The provider's window is a blanket fallback, not a reported or catalogued figure.
 * @property {number|null} [providerContextWindow] - The provider's own window, present only when the user overrode it.
 * @property {string} [displayName] - Provider-supplied human label.
 * @property {string[]} [thinkingLevels] - Reasoning tiers, in display order.
 * @property {string} [defaultThinkingLevel] - Level used when a turn carries none.
 * @property {{id: string, name?: string, description?: string}[]} [serviceTiers] - Non-standard serving classes.
 * @property {boolean} [hidden] - True when the user turned this model off in settings.
 * @typedef {object} PickerProvider
 * @property {string} name - Provider name (e.g. "anthropic").
 * @property {string} displayName - Display name (e.g. "Anthropic (API)").
 * @property {boolean} available - Whether provider credentials are configured.
 * @property {string} [authType] - Provider credential type.
 * @property {string} [authHint] - Provider auth/status hint.
 * @property {PickerModel[]} [modelsWithContext] - Models with context window info.
 * @typedef {{id: string, label: string, iconClass?: string}} PickerAction
 * @typedef {import('../../model/model-config.js').ModelConfigShape} ModelConfigShape
 */

/**
 * Read one of a row's stored dials, keeping the difference between a row that
 * says nothing about a dial and one that says the dial is off. `getAttribute`
 * answers null for both an absent attribute and — after `|| ''` — an empty one,
 * and here they are opposite requests: silence means "leave it as it is",
 * emptiness means "set it to none".
 * @param {Element} item - The row.
 * @param {string} name - Attribute name.
 * @returns {string|undefined} The stored value ('' for an explicit none), or
 *   undefined when the row carries no such attribute.
 */
function dialAttribute(item, name) {
  return item.hasAttribute(name) ? (item.getAttribute(name) || '') : undefined;
}

/**
 * The value a `change` carries when the optional Off row is chosen.
 *
 * A sentinel rather than null because null is already taken: the none row means
 * "you decide", and Off means "don't". A host that collapsed the two would
 * store one as the other, and since both name no model, nothing downstream
 * could tell them apart again. Hosts test it with `detail === MODEL_PICKER_OFF`
 * or `detail?.off`; a host that never sets `offLabel` never sees it.
 */
export const MODEL_PICKER_OFF = Object.freeze({ off: true });

class ModelPicker extends JugglerElement {
  constructor() {
    super();
    /** @type {PickerProvider[]} @private */
    this._providers = [];
    /** @type {ModelConfigShape} @private - The config currently in effect. */
    this._value = null;
    /** @type {string} @private - Label for the bottom row that selects nothing. */
    this._noneLabel = 'No model';
    /**
     * @type {string} @private - Label for the optional Off row. Empty (the
     * default) leaves the row out entirely, so only a host with a genuine
     * "none at all" state grows a third choice.
     */
    this._offLabel = '';
    /** @type {boolean} @private - True when Off is the state in effect. */
    this._off = false;
    /** @type {PickerAction[]} @private - Host-supplied footer actions. */
    this._footerActions = [];
    /** @type {boolean} @private - True while the provider list is still being fetched. */
    this._loading = false;
    /** @type {string} @private - The live type-to-filter query. */
    this._filter = '';
    /** @type {number} @private - Index into the visible rows of the keyboard cursor; -1 for none. */
    this._cursor = -1;
    /**
     * Per-provider list view state: how many of a provider's models the list
     * shows. Tri-state, cycled from the toggle in each provider's header: 'none'
     * (collapsed, no rows) → 'top' (recommended shortlist) → 'all' (full list).
     * Unset defaults to 'top' for providers with a shortlist, else 'all'. Kept
     * as a sparse map of user overrides against this person (services/prefs.js)
     * — untouched providers stay absent and fall back to the default.
     * @type {Record<string, 'none'|'top'|'all'>} @private
     */
    this._viewState = this._loadViewState();
    /**
     * A line the host wants read at the moment of choosing — the composer uses
     * it to say a change reaches the turn already running. Empty renders
     * nothing, so a picker with nothing to add costs no space.
     * @type {string} @private
     */
    this._note = '';
    /** @type {boolean} @private - Whether the first render has run. */
    this._rendered = false;
    /** @type {string|null} @private - Last row markup written, so an identical refresh leaves the scroll alone. */
    this._lastListHTML = null;
    /** @type {string|null} @private - Last detail-card markup written, for the same reason. */
    this._lastCardHTML = null;
    /** @type {string|null} @private - Last Recent-block markup written, for the same reason. */
    this._lastRecentHTML = null;
  }

  connectedCallback() {
    // The surface is relocated to <body> by presentPopup, which disconnects and
    // reconnects it — render once and keep the built DOM across the move.
    if (!this._rendered) this.render();
    // Capture, so the query is claimed before it reaches the composer textarea
    // or popup-manager's Escape → closeAllPopups (which would take a settings
    // modal down with it). Registered after hold-to-cycle's own capture
    // listener, so a cycle gesture's Escape still cancels the gesture first.
    // presentPopup's relocation disconnects and reconnects this element, so the
    // base class drains the listener on the way out and this re-registers it.
    this.onDocument('keydown', /** @type {EventListener} */ ((e) => this._onKey(/** @type {KeyboardEvent} */ (e))), true);
    // Opening the picker is the one moment the user is looking at the meters, so
    // it is the moment worth asking about them; the cache turns the repeats into
    // no-ops.
    void this._refreshUsage();
  }

  /**
   * Every setter here re-reads its own value before accepting it, and refreshes
   * only on a genuine change.
   *
   * The host pushes all four on every doc update — and a sub-thread column
   * rebuilds its bindings on every update, so an open picker is offered the same
   * state tens of times a second while a turn streams. A refresh that wrote DOM
   * regardless would be seen by `presentPopup`'s reposition observer, and
   * `positionDropdown` clears the surface's `max-height` to measure it: the list
   * loses its overflow for that instant, and with it the user's place in it.
   * @param {PickerProvider[]} providers - The provider list to offer.
   */
  set providers(providers) {
    const next = providers || [];
    if (next === this._providers) return;
    this._providers = next;
    if (this._rendered) this.refresh();
  }

  /** @returns {PickerProvider[]} The provider list. */
  get providers() {
    return this._providers;
  }

  /** @param {ModelConfigShape} value - The config currently in effect. */
  set value(value) {
    if (sameModelConfig(value, this._value)) return;
    const providerChanged = value?.provider !== this._value?.provider;
    this._value = value;
    if (this._rendered) this.refresh();
    // Switching provider puts a different account's quota under the card, and
    // that provider may never have been asked.
    if (providerChanged) void this._refreshUsage();
  }

  /** @returns {ModelConfigShape} The config currently in effect. */
  get value() {
    return this._value;
  }

  /** @param {string} label - Label for the bottom row that selects nothing. */
  set noneLabel(label) {
    if (label === this._noneLabel) return;
    this._noneLabel = label;
    if (this._rendered) this.refresh();
  }

  /** @returns {string} Label for the bottom row that selects nothing. */
  get noneLabel() {
    return this._noneLabel;
  }

  /**
   * @param {string} label - Label for the Off row; empty omits the row. Set it
   *   only where "no model at all" is a state the host can actually store,
   *   since offering it otherwise promises a choice that cannot be kept.
   */
  set offLabel(label) {
    const next = label || '';
    if (next === this._offLabel) return;
    this._offLabel = next;
    if (this._rendered) this.refresh();
  }

  /** @returns {string} Label for the Off row, or '' when there is none. */
  get offLabel() {
    return this._offLabel;
  }

  /**
   * @param {boolean} isOff - Whether Off is the state in effect. Kept apart
   *   from `value` because both Off and Automatic have no model, so the value
   *   alone cannot say which row wears the tick.
   */
  set off(isOff) {
    const next = !!isOff;
    if (next === this._off) return;
    this._off = next;
    if (this._rendered) this.refresh();
  }

  /** @returns {boolean} Whether Off is the state in effect. */
  get off() {
    return this._off;
  }

  /** @param {PickerAction[]} actions - Footer actions; empty collapses the footer. */
  set footerActions(actions) {
    this._footerActions = actions || [];
    if (this._rendered) this.render();
  }

  /** @param {string} note - A line to read under the dials; empty shows none. */
  set note(note) {
    const next = note || '';
    if (next === this._note) return;
    this._note = next;
    if (this._rendered) this._renderNote();
  }

  /** @returns {string} The host's note. */
  get note() {
    return this._note;
  }

  /** @param {boolean} loading - True while the provider list is still being fetched. */
  set loading(loading) {
    if (!!loading === this._loading) return;
    this._loading = !!loading;
    if (this._rendered) this.refresh();
  }

  // ── selection helpers ─────────────────────────────────────────────────────

  /**
   * The model entry a `{provider, model}` pair points at.
   * @param {string} providerName
   * @param {string} modelId
   * @returns {PickerModel|undefined} The advertised model entry.
   * @private
   */
  _entry(providerName, modelId) {
    return this._providers.find(p => p.name === providerName)
      ?.modelsWithContext?.find(m => m.id === modelId);
  }

  /**
   * A provider's models minus the ones the user has hidden in settings.
   *
   * The one exception is the model currently in effect: hiding a model must not
   * strip the label off a conversation already on it, leaving the picker reading
   * "No model" for something that is plainly running. That one comes through
   * flagged, and the row renders as such.
   * @param {PickerProvider} provider
   * @returns {PickerModel[]} The models this picker may show for the provider.
   * @private
   */
  _visibleModels(provider) {
    const models = provider.modelsWithContext || [];
    const ownsSelection = this._value?.provider === provider.name && !!this._value?.model;
    return models.filter(m => !m.hidden || (ownsSelection && m.id === this._value?.model));
  }

  /**
   * Announce a `{provider, model}` choice as a whole config.
   *
   * A tier asked for explicitly (a Recent row restoring the pair it recorded) is
   * honoured verbatim, the empty string included: the request names a whole
   * pair, so it can clear a tier as well as set one, and re-deriving it from the
   * catalog would discard a paid choice whenever the catalog is cold or the
   * model list came back as a fallback. With no tier requested the current one
   * is carried across a re-pick of the SAME model and dropped otherwise —
   * switching models must never silently start paying a premium rate the new
   * model was never chosen for. That the new model happens to sell one is not a
   * reason to buy it; only a click that says so is.
   *
   * The thinking level is re-derived rather than carried: a Recent entry may
   * name a level the model no longer supports, and falling back to the model's
   * default costs nothing.
   * @param {string} providerName
   * @param {string} modelId
   * @param {string} [thinking] - Requested level; absent means the model's default.
   * @param {string} [serviceTier] - Requested tier, '' for Standard; absent means
   *   carry the current one if this is the same model.
   * @private
   */
  _pick(providerName, modelId, thinking, serviceTier) {
    const entry = this._entry(providerName, modelId);
    const level = thinking && (entry?.thinkingLevels || []).includes(thinking) ? thinking : '';
    const sameModel = this._value?.provider === providerName && this._value?.model === modelId;
    const carried = this._value?.serviceTier;
    const tier = serviceTier !== undefined ? serviceTier : ((sameModel && carried) || '');
    this._emit(buildModelConfig(providerName, modelId, level, tier));
  }

  /**
   * Announce a config, the none row's null, or the Off row's sentinel.
   * @param {ModelConfigShape|typeof MODEL_PICKER_OFF} config
   * @private
   */
  _emit(config) {
    this.dispatchEvent(new CustomEvent('change', { detail: config }));
  }

  /**
   * Ask the host to dismiss the picker.
   * @private
   */
  _requestClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  // ── per-provider view state ───────────────────────────────────────────────

  /**
   * Read the persisted per-provider view-state overrides, tolerant of a missing
   * or corrupt blob. Only recognised states are kept, so a stale or hand-edited
   * value can never poison the map.
   * @returns {Record<string, 'none'|'top'|'all'>} provider name → view state.
   * @private
   */
  _loadViewState() {
    try {
      const raw = cachedUserPref(VIEW_STATE_PREF, {}) || {};
      /** @type {Record<string, 'none'|'top'|'all'>} */
      const clean = {};
      for (const [name, state] of Object.entries(raw)) {
        if (VIEW_STATES.includes(/** @type {string} */ (state))) {
          clean[name] = /** @type {'none'|'top'|'all'} */ (state);
        }
      }
      return clean;
    } catch {
      return {};
    }
  }

  /**
   * Persist the current per-provider view-state map, best-effort.
   * @private
   */
  _saveViewState() {
    void setUserPref(VIEW_STATE_PREF, this._viewState);
  }

  /**
   * Resolve a provider's effective list view state, applying the default when
   * nothing has been chosen yet. Providers with no meaningful shortlist (the
   * recommended subset equals the full list) skip the 'top' state, so an unset
   * or stale 'top' collapses to 'all' for them.
   * @param {string} providerName
   * @param {boolean} hasShortlist - Whether a recommended subset < full list exists.
   * @returns {'none'|'top'|'all'} The state to render.
   * @private
   */
  _resolveViewState(providerName, hasShortlist) {
    // A filter query overrides the stored state: a match hiding inside a
    // collapsed provider is a match the user cannot reach.
    if (this._filter) return 'all';
    const s = this._viewState[providerName];
    if (s === 'none' || s === 'all') return s;
    if (s === 'top') return hasShortlist ? 'top' : 'all';
    // Unset: default to the shortlist when there is one, else the full list.
    return hasShortlist ? 'top' : 'all';
  }

  /**
   * Advance a provider's list view to the next tri-state in the cycle
   * none → top → all → none (providers without a shortlist cycle none ↔ all).
   *
   * The toggle is a control the user presses repeatedly to find the state they
   * want, so it is held still across the rewrite: rows appear and disappear
   * beneath it while the button itself stays under the pointer.
   * @param {string} providerName
   * @private
   */
  _cycleProviderView(providerName) {
    const provider = this._providers.find(p => p.name === providerName);
    if (!provider) return;
    const all = this._visibleModels(provider);
    const hasShortlist = getRecommendedModels(all).length < all.length;
    const order = hasShortlist ? ['none', 'top', 'all'] : ['none', 'all'];
    const current = this._resolveViewState(providerName, hasShortlist);
    const next = order[(order.indexOf(current) + 1) % order.length];
    this._viewState[providerName] = /** @type {'none'|'top'|'all'} */ (next);
    this._saveViewState();
    this._renderListKeeping(`.provider-view-toggle[data-provider="${CSS.escape(providerName)}"]`);
  }

  /**
   * Rewrite the rows while holding one of them where it sits on screen, so a
   * control that rewrites the list stays under the pointer that pressed it.
   *
   * The row is pinned in VIEWPORT coordinates, not in the list's own, because
   * the surface moves too: it is placed against its anchor, so a list that stops
   * filling the space beside it is re-placed shorter. That re-placement is the
   * reposition observer's answer to this very rewrite, and its callback is
   * queued the instant the DOM changes — before the microtask below — so the
   * correction measures the geometry that survives rather than the one on its
   * way out.
   *
   * The correction is a scroll, so it can only hold what the list can reach: a
   * popup that grows and takes its whole box upwards moves rows above a scroll
   * offset of zero, and nothing scrolls back to that. Growing the surface is a
   * move the user can see and follow; the list silently dropping to its end is
   * not, which is what the padding below is for.
   * @param {string} selector - Selects the row to hold still, before and after.
   * @private
   */
  _renderListKeeping(selector) {
    const rows = /** @type {HTMLElement|null} */ (this.querySelector('.model-picker-rows'));
    const anchor = rows?.querySelector(selector);
    if (!rows || !anchor) {
      this._renderList();
      return;
    }
    const before = anchor.getBoundingClientRect().top;
    this._renderList();
    queueMicrotask(() => {
      const fresh = rows.isConnected ? rows.querySelector(selector) : null;
      if (!fresh) return;
      const wanted = rows.scrollTop + fresh.getBoundingClientRect().top - before;
      // Collapsing a section near the end takes away the very content the list
      // was scrolled through, so the scroll that would hold the row still is
      // past the end — the list drops to its end instead, and the row lands
      // wherever that leaves it. Extend the end by the shortfall and it has
      // somewhere to scroll to. Only while the list still overflows on its own:
      // a list that now fits should shrink to what it holds, not sit on a
      // cushion of nothing. The next rewrite clears it.
      const overshoot = wanted - (rows.scrollHeight - rows.clientHeight);
      if (overshoot > 0 && rows.scrollHeight > rows.clientHeight) {
        rows.style.paddingBottom = `${overshoot}px`;
      }
      rows.scrollTop = wanted;
    });
  }

  // ── markup ────────────────────────────────────────────────────────────────

  /**
   * Render a selectable row.
   * @param {{label: string, active: boolean, classes?: string, dataAttrs?: string}} opts
   * @returns {string} HTML
   * @private
   */
  _selectionItem({ label, active, classes = '', dataAttrs = '' }) {
    const selectedTick = active
      ? `<span class="model-selected-tick" aria-hidden="true">${CHECK_SVG}</span>`
      : '';
    return `
            <li class="menu-item model-selection-item ${active ? 'active' : ''} ${classes}" ${dataAttrs}>
                ${selectedTick}
                <span class="model-item-name">${label}</span>
            </li>
        `;
  }

  /**
   * @param {PickerProvider} provider
   * @returns {string} Unavailable provider hint.
   * @private
   */
  _unavailableHint(provider) {
    if (provider.authType === 'oauth_bearer') {
      return provider.authHint || 'Login required';
    }
    return provider.authHint || 'Provider not configured';
  }

  /**
   * Whether a label survives the current filter query. Matching is a plain
   * case-insensitive substring — a model id is not prose, and anything cleverer
   * would rank rather than filter.
   * @param {string} label
   * @returns {boolean} True when the row should be shown.
   * @private
   */
  _matches(label) {
    if (!this._filter) return true;
    return label.toLowerCase().includes(this._filter.toLowerCase());
  }

  /**
   * Render one provider's section: a header bar carrying the provider name and a
   * tri-state view toggle ("none"/"top"/"all"), followed by the model rows
   * dictated by the current view state. The header is always rendered — even in
   * the 'none' (collapsed) state, where no rows follow — so the toggle stays
   * reachable to re-expand the list. While a filter query is active a provider
   * with no surviving rows drops out entirely.
   * @param {PickerProvider} provider
   * @returns {string} HTML for the provider's header + model group.
   * @private
   */
  _providerSectionHTML(provider) {
    // Sort the full list newest-first: providers (notably OpenAI and Gemini)
    // return models in no meaningful order, so both the "all" view and the
    // shortlist derived from it should be version-ordered rather than API-ordered.
    // (Casts: the filter utils' generic Model typedef erases the richer
    // PickerModel shape, but they return the same objects they were given.)
    const allModels = /** @type {PickerModel[]} */ (sortModelsByVersion(this._visibleModels(provider)));
    const recommendedModels = /** @type {PickerModel[]} */ (getRecommendedModels(allModels));
    const hasShortlist = recommendedModels.length < allModels.length;
    const state = this._resolveViewState(provider.name, hasShortlist);

    // Rows shown depend on the state: none → empty, top → shortlist, all → full.
    let modelsToShow = state === 'none' ? [] : (state === 'all' ? allModels : recommendedModels);

    // In the shortlist view, always keep the model in effect visible even when
    // it isn't part of the recommended subset.
    if (state === 'top' && this._value?.provider === provider.name && this._value?.model) {
      const selectedModel = allModels.find(m => m.id === this._value?.model);
      if (selectedModel && !modelsToShow.find(m => m.id === this._value?.model)) {
        modelsToShow = [selectedModel, ...modelsToShow];
      }
    }

    modelsToShow = modelsToShow.filter(m => this._matches(modelLabel(m.displayName, m.id)));
    if (this._filter && modelsToShow.length === 0) return '';

    const recommendedIds = new Set(recommendedModels.map(m => m.id));
    const disabledNote = provider.available ? '' : this._unavailableHint(provider);

    const items = modelsToShow.map(model => {
      const displayName = modelLabel(model.displayName, model.id);
      const isCurrent = this._value?.provider === provider.name && this._value?.model === model.id;
      if (disabledNote) {
        return this._selectionItem({
          label: `${escapeHtml(displayName)} <span class="menu-item-note">${escapeHtml(disabledNote)}</span>`,
          active: isCurrent,
          classes: 'unavailable',
        });
      }
      // The only hidden model that reaches here is the one already in effect. Say
      // so, rather than showing it as an ordinary choice the picker would
      // otherwise never offer.
      const label = model.hidden
        ? `${escapeHtml(displayName)} <span class="menu-item-note">hidden</span>`
        : escapeHtml(displayName);
      return this._selectionItem({
        label,
        active: isCurrent,
        classes: recommendedIds.has(model.id) ? 'recommended' : '',
        dataAttrs: `data-provider="${escapeHtml(provider.name)}" data-model="${escapeHtml(model.id)}"`,
      });
    });

    const toggle = `<button type="button" class="provider-view-toggle" data-provider="${escapeHtml(provider.name)}" title="Toggle model list: none / top / all">${state}</button>`;
    const header = `<li class="menu-header provider-menu-header"><span class="menu-header-label">${escapeHtml(provider.displayName)}</span>${toggle}</li>`;
    const group = items.length ? `<menu class="menu-group">${items.join('')}</menu>` : '';
    return `${header}${group}`;
  }

  /**
   * Build the "Recent" block that sits in the left column: up to six
   * recently-used concrete model+dial pairs for quick switching. Entries are
   * distinct by provider+model+thinking+serviceTier, so the same model at two
   * levels (or two tiers) is two rows — the chips after the name differentiate
   * them. Includes the model
   * in effect when it is recent; hiding it makes a just-selected model look like
   * it was not recorded.
   *
   * Returns the empty string — not whitespace — when there is nothing recent, so
   * the container matches `:empty` and takes no room at all. An empty block that
   * still drew its own hairline would read as a section with nothing in it.
   * @returns {string} HTML for the Recent label + rows, or ''.
   * @private
   */
  _recentHTML() {
    const recents = recentModels.getAvailable(this._providers).slice(0, RECENT_LIMIT)
      .filter(r => this._matches(modelLabelFromList(this._providers, r.provider, r.model)));
    if (recents.length === 0) return '';
    const current = this._value;

    const items = recents.map(r => {
      const label = modelLabelFromList(this._providers, r.provider, r.model);
      const providerEntry = this._providers.find(p => p.name === r.provider);
      const providerLabel = providerEntry?.displayName || r.provider;
      const active = !!current && r.provider === current.provider && r.model === current.model
        && (r.thinking || '') === (current.thinking || '')
        && (r.serviceTier || '') === (current.serviceTier || '');
      // Both stored dials ride along as data attributes — always, an entry that
      // stored neither included — so a click restores the exact pair the row
      // displays. An empty attribute is the row saying "default level" and
      // "Standard serving" out loud, which is what lets a click here turn a dial
      // off; leaving it out would ask for the dial to be left alone instead. The
      // chips are display-only (the whole row is the target). Entries are
      // distinct by tier as well as level, so a row that dropped its tier chip
      // would be a second identical-looking row.
      const chip = r.thinking
        ? `<span class="recent-model-chip" title="Thinking: ${escapeHtml(r.thinking)}">${escapeHtml(r.thinking)}</span>`
        : '';
      // The provider's own name for the tier when the catalog still carries it,
      // otherwise the stored id verbatim — the row states what is stored.
      const tierName = r.serviceTier
        ? (this._entry(r.provider, r.model)?.serviceTiers || [])
          .find((/** @type {{id: string}} */ t) => t.id === r.serviceTier)?.name || r.serviceTier
        : '';
      const tierChip = tierName
        ? `<span class="recent-model-chip" title="Speed: ${escapeHtml(tierName)}">${escapeHtml(tierName)}</span>`
        : '';
      const thinkingAttr = ` data-thinking="${escapeHtml(r.thinking || '')}"`;
      const tierAttr = ` data-service-tier="${escapeHtml(r.serviceTier || '')}"`;
      return `
                <li class="menu-item recent-model${active ? ' active' : ''}" data-provider="${escapeHtml(r.provider)}" data-model="${escapeHtml(r.model)}"${thinkingAttr}${tierAttr}>
                    <span class="recent-model-name">${escapeHtml(label)}${chip}${tierChip}</span>
                    <span class="recent-model-provider">${escapeHtml(providerLabel)}</span>
                </li>`;
    }).join('');

    return `<div class="model-picker-recent-label">Recent</div><menu class="recent-model-list">${items}</menu>`;
  }

  /**
   * The scrolling list: a section per provider that has something to offer, then
   * the host's none row. Recent is not here — it is pinned in the left column.
   * @returns {string} HTML for the list column's rows.
   * @private
   */
  _listHTML() {
    if (this._loading) {
      return `
                <li class="menu-item unavailable">
                    <juggler-spinner style="--size: 0.875rem"></juggler-spinner>
                    <span>Loading providers…</span>
                </li>
            `;
    }

    let content = '';

    // Show providers that expose models. Available providers are selectable;
    // OAuth providers with a stale/missing external login remain visible but
    // disabled so the user can see what will unlock after logging in.
    const menuProviders = this._providers
      .filter(p => this._visibleModels(p).length > 0)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const sections = menuProviders.map(p => this._providerSectionHTML(p)).join('');

    if (menuProviders.length === 0) {
      // No usable provider — either the cache is empty or every provider is
      // missing credentials. Point at the footer action that fixes it.
      content += `
                <li class="menu-item menu-item-hint">
                    <span class="menu-hint-text">No providers yet.<br/>Choose "Manage LLM providers…" to add credentials.</span>
                </li>
            `;
    } else if (!sections && this._filter) {
      content += '<li class="menu-item menu-item-hint"><span class="menu-hint-text">Nothing.</span></li>';
    }
    content += sections;

    // Bottom-of-list escape hatch, labelled by the host: clear the selection
    // entirely. Styled as a plain selection row so it matches the model rows
    // above; active (✓) when nothing is currently selected. Never filtered out —
    // it is an action, not a model.
    content += '<li class="menu-divider"></li>';
    let escapeRows = this._selectionItem({
      label: escapeHtml(this._noneLabel),
      active: !this._value?.model && !this._off,
      classes: 'no-model',
      dataAttrs: 'data-none="true"',
    });
    // The optional third choice, for a host where having no model at all is a
    // real answer rather than the absence of one. Sits below the none row
    // because it is the more final of the two.
    if (this._offLabel) {
      escapeRows += this._selectionItem({
        label: escapeHtml(this._offLabel),
        active: this._off,
        classes: 'no-model off-model',
        dataAttrs: 'data-off="true"',
      });
    }
    content += `<menu class="menu-group">${escapeRows}</menu>`;

    return content;
  }

  /**
   * The chosen provider's quota meters, when it reports any.
   *
   * Silence is the empty state. A provider that reports no usage — or has not
   * answered yet, or answered with an error the sidebar's usage card already
   * spells out — leaves the card exactly as it was, rather than holding a block
   * of space open for something that may never arrive.
   * @param {string} providerName
   * @returns {string} HTML for the meters, or '' when there are none to show.
   * @private
   */
  _usageHTML(providerName) {
    const stats = usageStatsCache.get(providerName)?.stats || [];
    if (stats.length === 0) return '';
    return `
                <div class="model-current-usage">${stats.map(renderUsageRow).join('')}</div>`;
  }

  /**
   * Pull the current provider's usage, then repaint the card if anything landed.
   *
   * The cache debounces to one live fetch per provider per few minutes and shares
   * an in-flight one between callers, so opening the picker repeatedly — and the
   * reconnect `presentPopup` causes when it moves the surface to `<body>` — costs
   * a map lookup, not a request. Only the provider in effect is ever fetched:
   * asking a CLI-backed provider the user isn't on can provoke a login.
   * @private
   */
  async _refreshUsage() {
    const providerName = this._value?.provider;
    if (!providerName) return;
    await usageStatsCache.refresh(providerName);
    if (this._rendered) this.refresh();
  }

  /**
   * The detail column: the chosen model's identity card plus its dials.
   * @returns {string} HTML for the card; the `<model-tuning>` is wired separately.
   * @private
   */
  _detailCardHTML() {
    const cfg = this._value;
    if (!cfg?.provider || !cfg?.model) {
      return `
            <div class="model-current">
                <div class="model-current-label">Current model</div>
                <div class="model-current-name model-current-name--muted">No model selected</div>
            </div>`;
    }

    const providerEntry = this._providers.find(p => p.name === cfg.provider);
    const providerLabel = providerEntry?.displayName || cfg.provider;
    const entry = this._entry(cfg.provider, cfg.model);
    const ctx = entry?.contextWindow || 0;

    const subParts = [providerLabel];
    if (ctx > 0) subParts.push(`${formatTokens(ctx)} context`);

    // A window the server never reported is the provider's blanket fallback,
    // and it decides when the conversation compacts and how long a reply may
    // run. The marker says so and leads to the field that corrects it. A window
    // the user has overridden is theirs, whatever the provider's figure was.
    const assumed = ctx > 0 && entry?.windowAssumed
      && (entry.providerContextWindow === undefined || entry.providerContextWindow === null);
    const assumedHTML = assumed
      ? ` · <button type="button" class="model-window-assumed" data-provider="${escapeHtml(cfg.provider)}" data-model="${escapeHtml(cfg.model)}"
                    title="${escapeHtml(`The server didn't report this model's context window, so Juggler assumed ${formatTokens(ctx)}. Click to set the real size in Settings.`)}">assumed</button>`
      : '';

    return `
            <div class="model-current">
                <div class="model-current-label">Current model</div>
                <div class="model-current-name">${escapeHtml(modelLabel(entry?.displayName, cfg.model))}</div>
                <div class="model-current-sub">${escapeHtml(subParts.join(' · '))}${assumedHTML}</div>${this._switchHTML(providerEntry)}${this._usageHTML(cfg.provider)}
            </div>`;
  }

  /**
   * The offer to move to the provider the current one names as better suited
   * to its server (LocalAI pointed at LM Studio). The card is where the user
   * meets the assumed window that is the symptom, so it is where the cure is
   * offered too.
   * @param {any} providerEntry - The current model's provider, as published.
   * @returns {string} HTML for the offer, or '' when there is none.
   * @private
   */
  _switchHTML(providerEntry) {
    const target = providerEntry?.switchTo;
    if (!target?.provider) return '';
    return `
                <div class="model-current-switch" title="${escapeHtml(target.reason || '')}">
                    <span class="model-current-switch-text">${escapeHtml(target.displayName)} reads this server's real context windows.</span>
                    <button type="button" class="model-provider-switch" data-from="${escapeHtml(providerEntry.name)}" data-to="${escapeHtml(target.provider)}">Switch</button>
                </div>`;
  }

  /**
   * Switch providers, then move this conversation onto the same model under the
   * new one: the id is the server's own, so it names the same model either way.
   * Other conversations are left where they are (see switchProvider on the
   * server).
   * @param {HTMLButtonElement} button - The card's Switch button.
   * @returns {Promise<void>}
   * @private
   */
  async _switchProvider(button) {
    const from = button.getAttribute('data-from');
    const to = button.getAttribute('data-to');
    const model = this._value?.model;
    if (!from || !to || !model) return;
    button.disabled = true;
    try {
      const switched = await providersCache.switchProvider(from);
      this._pick(switched || to, model);
    } catch (err) {
      button.disabled = false;
      button.title = httpErrorText(err, "Couldn't switch provider");
    }
  }

  /**
   * The host-supplied actions that close the left column. Collapses to nothing
   * when the host offers none, so a picker with no actions has no empty bar.
   * @returns {string} HTML for the footer's rows.
   * @private
   */
  _footerHTML() {
    return this._footerActions.map(a => `
            <li class="menu-item" data-action="${escapeHtml(a.id)}">
                <span class="${escapeHtml(a.iconClass || 'menu-settings-icon')}"></span>
                <span>${escapeHtml(a.label)}</span>
            </li>`).join('');
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    this._rendered = true;
    this.classList.add('dropdown-menu', 'model-picker', 'show');
    // Seed the non-destructive-update caches with what we're about to write, so a
    // later refresh only rewrites what genuinely differs from this DOM.
    this._lastListHTML = this._listHTML();
    this._lastCardHTML = this._detailCardHTML();
    this._lastRecentHTML = this._recentHTML();
    // Four siblings, placed by the grid: the detail column, then Recent and the
    // actions stacked beneath it, and the list column beside all three spanning
    // the full height. DOM order is the phone's reading order, where the grid
    // collapses to a single stack — hence Recent ahead of the list, which is the
    // order a phone wants to read them in too.
    this.innerHTML = `
            <div class="model-picker-detail">
                ${this._lastCardHTML}
                <model-tuning></model-tuning>
                <div class="model-picker-note"${this._note ? '' : ' hidden'}>${escapeHtml(this._note)}</div>
            </div>
            <div class="model-picker-recent">${this._lastRecentHTML}</div>
            <div class="model-picker-list">
                <div class="model-picker-filter">
                    <input type="text" class="model-picker-filter-input" aria-label="Filter models" placeholder="Filter models" value="${escapeHtml(this._filter)}">
                </div>
                <menu class="model-picker-rows">${this._lastListHTML}</menu>
            </div>
            <menu class="model-picker-footer"${this._footerActions.length ? '' : ' hidden'}>${this._footerHTML()}</menu>
        `;

    this._syncTuning();
    this._wire();
    this._applyCursor();
  }

  /**
   * Refresh both columns in place. Used for every out-of-band change (a provider
   * push, a fresh recents list, a dial write) so the list's scroll position and
   * the filter input's contents survive.
   *
   * Every write here is compared first: an open picker is refreshed constantly,
   * and a rewrite that lands the same markup still counts as a content change to
   * the reposition observer watching this surface.
   */
  refresh() {
    const card = this.querySelector('.model-current');
    const cardHTML = this._detailCardHTML();
    if (card && cardHTML !== this._lastCardHTML) {
      this._lastCardHTML = cardHTML;
      card.outerHTML = cardHTML;
    }
    this._syncTuning();
    this._renderRecent();
    this._renderList();
  }

  /**
   * Show or hide the host's note. The element is always present and toggled
   * rather than rebuilt: an open picker is refreshed constantly, and adding or
   * removing a node is a resize the positioning observer has to answer.
   * @private
   */
  _renderNote() {
    const note = /** @type {HTMLElement|null} */ (this.querySelector('.model-picker-note'));
    if (!note) return;
    note.textContent = this._note;
    note.hidden = !this._note;
  }

  /**
   * Rewrite the left column's Recent block. Compared before writing for the same
   * reason the list is: picking a model both records a recent and refreshes the
   * picker, and everything in this column is pinned rather than scrolled, so an
   * identical rewrite would be a resize the positioning observer has to answer.
   * @private
   */
  _renderRecent() {
    const block = this.querySelector('.model-picker-recent');
    if (!block) return;
    const html = this._recentHTML();
    if (html === this._lastRecentHTML) return;
    this._lastRecentHTML = html;
    block.innerHTML = html;
    this._cursor = -1;
    this._applyCursor();
  }

  /**
   * Rewrite just the scrolling rows. The filter input lives outside them, so
   * typing never replaces the element being typed into.
   * @private
   */
  _renderList() {
    const rows = /** @type {HTMLElement|null} */ (this.querySelector('.model-picker-rows'));
    if (!rows) return;
    const html = this._listHTML();
    if (html === this._lastListHTML) return;
    this._lastListHTML = html;
    // Any room `_renderListKeeping` added at the end belonged to the list it is
    // replacing, so every rewrite starts from the list's own height.
    rows.style.removeProperty('padding-bottom');
    rows.innerHTML = html;
    this._cursor = -1;
    this._applyCursor();
  }

  /**
   * Point the `<model-tuning>` at the model in effect. It renders nothing when
   * that model advertises neither dial, so an untunable model costs no space.
   * @private
   */
  _syncTuning() {
    const tuning = /** @type {any} */ (this.querySelector('model-tuning'));
    if (!tuning) return;
    const cfg = this._value;
    tuning.modelEntry = cfg?.provider && cfg?.model ? this._entry(cfg.provider, cfg.model) : null;
    tuning.value = cfg || {};
  }

  /**
   * One delegated click listener for the whole surface, plus the filter input's
   * own wiring. Delegation survives the row rewrites `_renderList` performs.
   * @private
   */
  _wire() {
    const input = /** @type {HTMLInputElement|null} */ (this.querySelector('.model-picker-filter-input'));
    input?.addEventListener('input', () => {
      this._filter = input.value;
      this._renderRecent();
      this._renderList();
    });
    // The field fires a native `change` of its own when it is committed or blurred
    // — clicking anywhere off it, including the picker's own background. That
    // event carries no detail, so a host reading `detail` as the chosen config
    // would see the filter text land as "no model". The picker announces a choice
    // only through `_emit`, so nothing else leaves this element under that name.
    input?.addEventListener('change', e => e.stopPropagation());

    this.querySelector('model-tuning')?.addEventListener('change', (e) => {
      // Same rule: the dials' own event bubbles, and is a pair of levels rather
      // than a config. It is re-emitted below as a whole config; the original
      // goes no further.
      e.stopPropagation();
      const detail = /** @type {CustomEvent<{thinking: string, serviceTier: string}>} */ (e).detail;
      const cfg = this._value;
      if (!cfg?.provider || !cfg?.model) return;
      this._emit(buildModelConfig(cfg.provider, cfg.model, detail.thinking, detail.serviceTier));
    });

    this.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);

      const toggle = target.closest('.provider-view-toggle');
      if (toggle) {
        e.stopPropagation();
        const providerName = toggle.getAttribute('data-provider');
        if (providerName) this._cycleProviderView(providerName);
        return;
      }

      const switchButton = /** @type {HTMLButtonElement|null} */ (target.closest('.model-provider-switch'));
      if (switchButton) {
        e.stopPropagation();
        void this._switchProvider(switchButton);
        return;
      }

      const assumed = target.closest('.model-window-assumed');
      if (assumed) {
        e.stopPropagation();
        const provider = assumed.getAttribute('data-provider');
        const id = assumed.getAttribute('data-model');
        if (!provider || !id) return;
        // Leaves the way Escape does: the host tears the popup down, and settings
        // opens on the field rather than behind a picker still standing over it.
        this._requestClose();
        openSettings('providers', { model: { provider, id } });
        return;
      }

      const item = target.closest('.menu-item');
      if (!item) return;

      const action = item.getAttribute('data-action');
      if (action) {
        this.dispatchEvent(new CustomEvent('action', { detail: { id: action } }));
        return;
      }

      this._activate(item);
    });
  }

  /**
   * Act on a row: the none row clears the selection, the Off row asks for no
   * model at all, a model row picks it, and a row for an unconfigured provider
   * does nothing (its note already says why).
   * @param {Element} item
   * @private
   */
  _activate(item) {
    if (item.hasAttribute('data-off')) {
      this._emit(MODEL_PICKER_OFF);
      return;
    }
    if (item.hasAttribute('data-none')) {
      this._emit(null);
      return;
    }
    if (item.classList.contains('unavailable')) return;
    const providerName = item.getAttribute('data-provider');
    const modelName = item.getAttribute('data-model');
    if (!providerName || !modelName) return;
    // Recent rows carry their stored dials in data-thinking / data-service-tier
    // so the exact pair is restored, and an empty attribute is part of that pair:
    // it asks for the default level / Standard serving outright. Plain list rows
    // carry neither attribute, which is the different request — this model at its
    // default level, keeping the current tier only if the model hasn't changed.
    // So absence and emptiness must reach `_pick` as different things.
    this._pick(
      providerName,
      modelName,
      dialAttribute(item, 'data-thinking'),
      dialAttribute(item, 'data-service-tier'),
    );
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  /**
   * The rows the keyboard cursor walks — every pickable row, including the
   * left column's Recent rows and the none row, and nothing that isn't.
   *
   * `querySelectorAll` answers in document order, which is why Recent is written
   * ahead of the list: the cursor walks the two columns as one sequence, top to
   * bottom, and the none row stays what the first ArrowUp reaches.
   * @returns {HTMLElement[]} The navigable rows.
   * @private
   */
  _navRows() {
    return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll(
      '.model-picker-recent .menu-item,'
      + ' .model-picker-rows .menu-item:not(.unavailable):not(.menu-item-hint)'
    )));
  }

  /**
   * Paint the cursor onto the row it points at and bring it into view.
   * @private
   */
  _applyCursor() {
    const rows = this._navRows();
    rows.forEach((row, i) => row.classList.toggle('nav-active', i === this._cursor));
    const active = this._cursor >= 0 ? rows[this._cursor] : undefined;
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Move the cursor by `delta`, wrapping at both ends.
   * @param {number} delta
   * @private
   */
  _moveCursor(delta) {
    const rows = this._navRows();
    if (rows.length === 0) return;
    const next = this._cursor < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : (this._cursor + delta + rows.length) % rows.length;
    this._cursor = next;
    this._applyCursor();
  }

  /**
   * Whether a keypress is a plain character the filter should swallow — no
   * modifier chord, so a hold-to-cycle gesture driving this picker as its HUD
   * keeps every one of its own keystrokes.
   * @param {KeyboardEvent} e
   * @returns {boolean} True when the key is filter input.
   * @private
   */
  _isFilterKey(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  /**
   * The picker's keyboard contract, from a document-capture listener so it works
   * wherever focus happens to be — the composer textarea, a settings field, or
   * the filter input itself.
   * @param {KeyboardEvent} e
   * @private
   */
  _onKey(e) {
    const input = /** @type {HTMLInputElement|null} */ (this.querySelector('.model-picker-filter-input'));
    const typingInInput = !!input && document.activeElement === input;

    if (e.key === 'Escape') {
      // Stop the press dead: popup-manager's document-level Escape closes EVERY
      // open overlay, which would take a hosting settings modal down with this
      // picker.
      e.preventDefault();
      e.stopImmediatePropagation();
      this._requestClose();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._moveCursor(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter') {
      const rows = this._navRows();
      const row = rows[this._cursor];
      if (!row) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this._activate(row);
      return;
    }

    // The input handles its own editing natively once it has focus.
    if (typingInInput) return;

    if (e.key === 'Backspace') {
      if (!this._filter) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this._setFilter(this._filter.slice(0, -1));
      return;
    }

    if (this._isFilterKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._setFilter(this._filter + e.key);
    }
  }

  /**
   * Set the filter query from outside the input and keep the input showing it.
   * @param {string} query
   * @private
   */
  _setFilter(query) {
    this._filter = query;
    const input = /** @type {HTMLInputElement|null} */ (this.querySelector('.model-picker-filter-input'));
    if (input) input.value = query;
    this._renderRecent();
    this._renderList();
  }
}

customElements.define('model-picker', ModelPicker);

export default ModelPicker;
