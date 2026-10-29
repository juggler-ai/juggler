//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<model-chip>` — the button that shows which model is in effect and opens the
 * picker.
 *
 * A pure function of (config, providers): the model's display label, a thinking
 * pill, a serving-tier pill, an override dot, and the unavailable/empty states.
 * It reads nothing and writes nothing — the host supplies the config and the
 * placeholder to show when there is none ("Select Model" in the composer,
 * "Automatic" in settings), and receives `chip-toggle` when the button is
 * pressed.
 *
 * Two configs, not one. `config` is what the BUTTON shows and `liveConfig` is
 * what the mini popover edits; they differ only during a hold-to-cycle gesture,
 * where the button stays frozen on the committed choice while the popover HUD
 * tracks each previewed hop. Hosts with no gesture set only `config`.
 *
 * The thinking pill is a click target of its own: it opens `<model-tuning>` in a
 * mini popover so the level can be changed without the full picker. That popover
 * is also the thinking cycler's HUD, which is why the chip node is updated in
 * place (`updateChipInPlace`) rather than replaced — swapping the node would
 * orphan the popover's anchor.
 * @module components/model-picker/model-chip
 */

import JugglerElement from '../juggler-element.js';
import { presentPopup } from '../../utils/popup-surface.js';
import { modelLabelFromList } from '../../model/model-display.js';
import { buildModelConfig } from '../../model/model-config.js';
import keyShortcutManager from '../../services/key-shortcut-manager.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { t } from '../../../sdk/lib/i18n.js';
import './model-tuning.js';

/**
 * @typedef {import('../../model/model-config.js').ModelConfigShape} ModelConfigShape
 * @typedef {import('./model-tuning.js').TuningModelEntry} TuningModelEntry
 */

class ModelChip extends JugglerElement {
  constructor() {
    super();
    /** @type {any[]} @private - The provider list the label and pills resolve against. */
    this._providers = [];
    /** @type {ModelConfigShape} @private - What the button displays. */
    this._config = null;
    /** @type {ModelConfigShape|undefined} @private - What the mini popover edits; undefined ⇒ follow `config`. */
    this._liveConfig = undefined;
    /** @type {string} @private - Label shown when no model is in effect. */
    this._placeholder = t('Select Model');
    /** @type {import('../../services/connection-status.js').ConnectionStatus} @private */
    this._connectionState = null;
    /** @type {boolean} @private - Whether an empty selection should pulse for attention. */
    this._pulseWhenEmpty = false;
    /** @type {string} @private - The button's tooltip. */
    this._buttonTitle = t('LLM Model');
    /** @type {(() => void)|null} @private - presentPopup release for the mini popover. */
    this._miniRelease = null;
    /** @type {HTMLElement|null} @private - The mini popover's surface while open. */
    this._miniSurface = null;
    /** @type {boolean} @private - True while `update()` is applying a batch, so setters don't each repaint. */
    this._batching = false;
    /** @type {string|null} @private - Last button content, used to preserve unchanged child nodes. */
    this._renderedContentHTML = null;
    /** @type {boolean} @private - Whether the host's picker is open (see `expanded`). */
    this._expanded = false;
  }

  connectedCallback() {
    // In place once the button exists, for the reason _update gives: a host
    // that re-parents its chip keeps the node its open picker is anchored to.
    this._update();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // The popover lives on document.body, so it outlives this element unless
    // released here.
    this.closeMini();
  }

  /**
   * Repaint after a property change. In place whenever the button already
   * exists: it anchors an open picker and its pill anchors the mini popover, so
   * a full render would leave both floating against dead nodes.
   * @private
   */
  _update() {
    if (this._batching) return;
    if (this.button) this.refreshButton(); else this.render();
  }

  /**
   * Apply several properties and repaint once. The host syncs the whole set on
   * every document change, and each setter would otherwise rebuild the button —
   * which happens on every streamed delta.
   * @param {object} props - Property names to values.
   */
  update(props) {
    this._batching = true;
    try {
      Object.assign(this, props);
    } finally {
      this._batching = false;
    }
    this._update();
  }

  /** @param {any[]} providers - The provider list to resolve labels and pills against. */
  set providers(providers) {
    this._providers = providers || [];
    this._update();
  }

  /** @returns {any[]} The provider list. */
  get providers() {
    return this._providers;
  }

  /** @param {ModelConfigShape} config - What the button displays. */
  set config(config) {
    this._config = config;
    this._update();
  }

  /** @returns {ModelConfigShape} What the button displays. */
  get config() {
    return this._config;
  }

  /** @param {ModelConfigShape|undefined} config - What the mini popover edits; undefined follows `config`. */
  set liveConfig(config) {
    this._liveConfig = config;
  }

  /** @returns {ModelConfigShape} What the mini popover edits. */
  get liveConfig() {
    return this._liveConfig === undefined ? this._config : this._liveConfig;
  }

  /** @param {string} label - Label shown when no model is in effect. */
  set placeholder(label) {
    this._placeholder = label;
    this._update();
  }

  /** @returns {string} Label shown when no model is in effect. */
  get placeholder() {
    return this._placeholder;
  }

  /** @param {import('../../services/connection-status.js').ConnectionStatus} state - Fault to show instead of the model. */
  set connectionState(state) {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this._update();
  }

  /** @returns {import('../../services/connection-status.js').ConnectionStatus} The connection fault, if any. */
  get connectionState() {
    return this._connectionState;
  }

  /** @param {boolean} on - Whether an empty selection should pulse for attention. */
  set pulseWhenEmpty(on) {
    this._pulseWhenEmpty = !!on;
    this._update();
  }

  /** @param {string} title - The button's tooltip. */
  set buttonTitle(title) {
    this._buttonTitle = title;
    this._update();
  }

  /** @returns {HTMLElement|null} The button, for use as a popup anchor. */
  get button() {
    return /** @type {HTMLElement|null} */ (this.querySelector('.model-selector-button'));
  }

  /** @returns {boolean} True while the mini popover is open. */
  get miniOpen() {
    return !!this._miniRelease;
  }

  /**
   * The model entry a config points at, or undefined when the provider list
   * doesn't carry it.
   * @param {ModelConfigShape} config
   * @returns {TuningModelEntry|undefined} The advertised model entry.
   * @private
   */
  _entryFor(config) {
    if (!config?.provider || !config?.model) return undefined;
    return this._providers.find(p => p.name === config.provider)
      ?.modelsWithContext?.find((/** @type {{id: string}} */ m) => m.id === config.model);
  }

  /**
   * The button's display state: the label text plus the flags its state classes
   * key off.
   * @returns {{modelDisplay: string, noModelSelected: boolean, modelUnavailable: boolean}}
   *   The button's display state.
   * @private
   */
  _displayState() {
    const provider = this._config?.provider || '';
    const model = this._config?.model || '';

    // Show connection status when not connected, otherwise the model label.
    let modelDisplay;
    let modelUnavailable = false;

    if (this._connectionState === 'error') {
      modelDisplay = t('Connection Error');
    } else if (this._connectionState === 'disconnected') {
      modelDisplay = t('Disconnected');
    } else if (this._connectionState === 'connecting') {
      modelDisplay = t('Connecting...');
    } else if (!provider || provider === 'Loading...') { // i18n-ignore: a sentinel provider name, never drawn
      modelDisplay = this._placeholder;
    } else {
      modelDisplay = model ? modelLabelFromList(this._providers, provider, model) : provider;
    }

    // Flag when the selected model is absent from the current provider list.
    if (provider && model && this._providers.length > 0) {
      const prov = this._providers.find(p => p.name === provider);
      modelUnavailable = !prov || !prov.modelsWithContext
        || !prov.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === model);
    }

    return {
      modelDisplay,
      noModelSelected: modelDisplay === this._placeholder,
      modelUnavailable,
    };
  }

  /**
   * Compact thinking-level pill, always showing the EFFECTIVE level for a
   * thinking-capable selected model: an explicit config level the model
   * advertises ⇒ solid chip; otherwise the model's declared
   * `defaultThinkingLevel` (or "def" when none is declared) ⇒ hollow `.default`
   * variant. Non-thinking models get no chip, so the button never grows for
   * them. The chip is its own click target — it toggles the mini popover.
   * @returns {string} HTML for the chip, or ''.
   */
  thinkingChipHTML() {
    const modelEntry = this._entryFor(this._config);
    const levels = modelEntry?.thinkingLevels || [];
    if (levels.length === 0) return '';
    // An explicit level counts only when the model advertises it — a stale
    // stored level means the model's default, same as everywhere else.
    const explicit = this._config?.thinking;
    const level = explicit && levels.includes(explicit) ? explicit : '';
    const declaredDefault = modelEntry?.defaultThinkingLevel || '';
    const shown = level || declaredDefault || t('def', undefined, { context: 'short for the default thinking level, on a small pill' });
    // Cite the switch-thinking shortcut (⌥⌘T / Ctrl+Alt+T) live from the central
    // table, so the hint stays correct if it's ever rebound or left unbound.
    const cycleKey = keyShortcutManager.formatBinding('cycle-thinking');
    const params = {
      state: level ? 'explicit' : declaredDefault ? 'declared' : 'none',
      level: level || declaredDefault,
      key: cycleKey,
    };
    const title = cycleKey
      ? t('Thinking: {state, select, explicit {{level}} declared {{level} (default)} other {default}} — click to change ({key}, hold for menu)', params)
      : t('Thinking: {state, select, explicit {{level}} declared {{level} (default)} other {default}} — click to change', params);
    // A <span> (not <button>): the chip nests inside the model button, and a
    // button inside a button is invalid HTML the parser would eject.
    return `<span class="thinking-chip${level ? '' : ' default'}" role="button" aria-haspopup="dialog" aria-expanded="${!!this._miniRelease}" title="${escapeHtml(title)}">${escapeHtml(shown)}</span>`;
  }

  /**
   * Compact serving-tier pill, rendered only when an explicit tier the model
   * still advertises is in effect. Standard serving is the absence of a tier, so
   * there is no hollow "inherited" variant and the button is untouched for every
   * model and every turn that isn't buying one — it grows only where materially
   * more is being spent.
   *
   * The label is the provider's own name for the tier, verbatim: the ids and
   * labels come straight from the catalog, so nothing here may assume a tier
   * means "faster".
   *
   * Inert, unlike the thinking chip: it is not a click target of its own, so a
   * click falls through to the button and opens the picker, whose detail column
   * already carries the full Speed control.
   * @returns {string} HTML for the chip, or ''.
   */
  serviceTierChipHTML() {
    const wanted = this._config?.serviceTier;
    if (!wanted) return '';

    // A stored tier counts only when the model still advertises it — a stale id
    // means standard serving, the same gate the request path applies.
    const active = (this._entryFor(this._config)?.serviceTiers || []).find(t => t.id === wanted);
    if (!active) return '';

    const label = active.name || active.id;
    const title = active.description ? t('{label} — {description}', { label, description: active.description }) : label;
    return `<span class="service-tier-chip" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  /**
   * The button's inner markup: icon, label, thinking chip, serving-tier chip.
   * @param {{modelDisplay: string}} state - From `_displayState`.
   * @returns {string} HTML for the button's content.
   * @private
   */
  _contentHTML(state) {
    return `<span class="icon-auto-awesome"></span><span class="model-name">${escapeHtml(state.modelDisplay)}</span>${this.thinkingChipHTML()}${this.serviceTierChipHTML()}`;
  }

  /**
   * Refresh the button's content and state classes in place, keeping the
   * <button> element itself — it anchors an open picker, and its thinking pill
   * anchors the mini popover. Unchanged content keeps its existing child nodes.
   */
  refreshButton() {
    const button = this.button;
    if (!button) {
      this.render();
      return;
    }
    const state = this._displayState();
    button.classList.toggle('model-unavailable', state.modelUnavailable);
    button.classList.toggle('pulse', this._pulseWhenEmpty && state.noModelSelected);
    button.title = this._buttonTitle;
    const contentHTML = this._contentHTML(state);
    if (contentHTML !== this._renderedContentHTML) {
      button.innerHTML = contentHTML;
      this._renderedContentHTML = contentHTML;
      this._wireChip();
    }
  }

  /**
   * Update the thinking pill's classes/label without replacing the element — the
   * pill anchors the mini popover, and swapping the node out from under
   * presentPopup would orphan its positioning. Falls back to a full render when
   * the pill's very existence changed (it appeared or disappeared).
   * @private
   */
  _updatePillInPlace() {
    const chip = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-chip'));
    const html = this.thinkingChipHTML();
    if (!chip || !html) {
      if (!!chip !== !!html) this.render();
      return;
    }
    // Clone the freshly-generated pill's attributes/text onto the live node.
    const tmp = document.createElement('span');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
    chip.className = fresh.className;
    chip.setAttribute('title', fresh.getAttribute('title') || '');
    chip.textContent = fresh.textContent;
  }

  /**
   * Open the mini thinking popover anchored to the thinking pill. The pill
   * exists for every selected thinking-capable model, so failure means the
   * current model has no thinking control.
   * @returns {boolean} True when the popover is (now) open.
   */
  openMini() {
    if (this._miniRelease) return true;
    const chip = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-chip'));
    if (!chip) return false;

    const live = this.liveConfig;
    const modelEntry = this._entryFor(live);
    if ((modelEntry?.thinkingLevels || []).length === 0) return false;

    // `show` up front: presentPopup owns placement, but display comes from the
    // base .dropdown-menu rule, which hides surfaces without it.
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu thinking-mini show';
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-label', t('Thinking'));
    const tuning = document.createElement('model-tuning');
    /** @type {any} */ (tuning).sections = 'thinking';
    /** @type {any} */ (tuning).modelEntry = modelEntry;
    /** @type {any} */ (tuning).value = live || {};
    tuning.addEventListener('change', (e) => {
      const detail = /** @type {CustomEvent<{thinking: string, serviceTier: string}>} */ (e).detail;
      this.closeMini();
      this._emitTuning(detail);
    });
    surface.appendChild(tuning);
    this._miniSurface = surface;

    this._miniRelease = presentPopup({
      surface,
      anchor: chip,
      id: 'thinking-mini',
      onClose: () => this.closeMini(),
      align: 'left',
      gap: 8,
      // The whole chip host counts as "inside" so a second pill click reaches the
      // toggle handler in render() instead of racing the capture-phase
      // outside-click dismissal (which runs before the pill's bubble handler).
      insideSelectors: ['model-chip', 'model-selector', '.thinking-mini'],
    });
    chip.setAttribute('aria-expanded', 'true');
    return true;
  }

  /**
   * Release the mini popover if open — tears down its surface, scrim, observer
   * and dismissal wiring via presentPopup's release. Idempotent.
   */
  closeMini() {
    if (this._miniRelease) {
      this._miniRelease();
      this._miniRelease = null;
    }
    this._miniSurface = null;
    this.querySelector('.thinking-chip')?.setAttribute('aria-expanded', 'false');
  }

  /**
   * Whether the picker this chip opens is open — the host owns the picker, so
   * it says so here, and the button announces it.
   * @param {boolean} open - Whether the host's picker is now open.
   */
  set expanded(open) {
    this._expanded = !!open;
    this.button?.setAttribute('aria-expanded', String(this._expanded));
  }

  /** @returns {boolean} Whether the host's picker is open. */
  get expanded() {
    return this._expanded;
  }

  /**
   * Push the current live config into an open mini popover and refresh the pill
   * in place — the thinking cycler's HUD update. No-op when the popover is shut.
   */
  refreshMini() {
    if (!this._miniSurface) return;
    const tuning = /** @type {any} */ (this._miniSurface.querySelector('model-tuning'));
    if (tuning) {
      const live = this.liveConfig;
      tuning.modelEntry = this._entryFor(live);
      tuning.value = live || {};
    }
    this._updatePillInPlace();
  }

  /**
   * Turn a tuning `{thinking, serviceTier}` pair into the full next config and
   * announce it. Rebuilt from the live pair, so the dial the popover doesn't
   * show still rides along.
   * @param {{thinking: string, serviceTier: string}} detail
   * @private
   */
  _emitTuning(detail) {
    const live = this.liveConfig;
    if (!live?.provider || !live?.model) return;
    this.dispatchEvent(new CustomEvent('change', {
      detail: buildModelConfig(live.provider, live.model, detail.thinking, detail.serviceTier),
    }));
  }

  /**
   * Attach the thinking pill's click handler: the pill is a click target of its
   * own — it toggles the mini popover and must never toggle the picker
   * underneath it. No-op when the button carries no pill.
   * @private
   */
  _wireChip() {
    const chip = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-chip'));
    if (!chip) return;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._miniRelease) {
        this.closeMini();
        return;
      }
      // A host with its own popup open must close it first — the pill promises
      // the mini, not the picker sitting over it. Hosts either do that in the
      // handler, or cancel the event and drive `openMini()` themselves.
      const request = new CustomEvent('mini-requested', { cancelable: true });
      this.dispatchEvent(request);
      if (!request.defaultPrevented) this.openMini();
    });
  }

  render() {
    // The pill (the popover's anchor) is about to be replaced — release the
    // popover first so it never floats against a dead anchor.
    this.closeMini();

    const state = this._displayState();
    const classes = ['model-selector-button', 'input-ctrl-btn'];
    if (state.modelUnavailable) classes.push('model-unavailable');
    if (this._pulseWhenEmpty && state.noModelSelected) classes.push('pulse');

    const contentHTML = this._contentHTML(state);
    this._renderedContentHTML = contentHTML;
    this.innerHTML = `
            <button class="${/* eslint-disable-line juggler/escape-html-interpolation -- literal class names, left bare so css-markup-model reads them */ classes.join(' ')}" id="model-button" type="button" title="${escapeHtml(this._buttonTitle)}" aria-haspopup="dialog" aria-expanded="${this._expanded ? 'true' : 'false'}">
                ${contentHTML}
            </button>
        `;

    const button = this.button;
    if (button) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('chip-toggle'));
      });
    }

    this._wireChip();
  }
}

customElements.define('model-chip', ModelChip);
