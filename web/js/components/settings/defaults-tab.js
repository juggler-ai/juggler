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

import { modelLabelFromList } from '../../model/model-display.js';
import { buildModelConfig } from '../../model/model-config.js';
import { presentPopup } from '../../utils/popup-surface.js';
import { closePopupById } from '../../utils/popup-manager.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { buildToggleRow } from './notifications-tab.js';
import '../model-picker/model-chip.js';
import { MODEL_PICKER_OFF } from '../model-picker/model-picker.js';
import { isDefaultFileEditingOn, setDefaultFileEditingOn } from '../../services/file-editing-permission.js';
import { setAutoNameEnabledCached } from '../../services/auto-name-setting.js';
import defaultModelCache from '../../services/default-model-cache.js';
import { setReplySuggestionsEnabledCached } from '../../services/reply-suggestions-setting.js';
import strategyRegistry from '../../registries/strategy-registry.js';
import { getDefaultStrategyId, setDefaultStrategyId, BUILTIN_DEFAULT_STRATEGY_ID } from '../../services/default-strategy.js';
import {
  CONTEXT_CHOICES, contextLabel, defaultDiffView, setDefaultDiffView,
  defaultDiffContext, setDefaultDiffContext,
} from '../../utils/diff-view-prefs.js';
import * as settingsApi from '../../services/settings-api.js';
import { showAlert } from '../modal-dialog.js';
import { getAppSession } from '../../utils/app-session.js';
import { t } from '../../../sdk/lib/i18n.js';
import { providerAuthHint } from '../../utils/provider-text.js';

/**
 * Popup id shared by both model rows, so opening one row's picker closes the
 * other's — two pickers over one modal would be two answers to one question.
 */
const MODEL_PICKER_POPUP_ID = 'settings-model-picker';

/**
 * "Defaults" tab (id `defaults`): the default-model picker and new-conversation
 * defaults, the cheap-model section (the picker plus a row per background job
 * that spends it — naming conversations, suggesting replies), the decision-model
 * row, the global stream-idle-timeout field, and how diffs are drawn. Seeded
 * from the shared loadConfig() fetch; the pickers persist immediately via PUT
 * /api/default-model, PUT /api/cheap-model and PUT /api/decision-model, the
 * rest via PUT /api/config.
 *
 * The diff rows are the exception to that last clause: they are display
 * preferences nothing on the server reads, so they persist through
 * utils/diff-view-prefs.js (the `user` realm) rather than to credentials.json,
 * and they take effect in every diff already on screen rather than on the next
 * turn.
 */
export class DefaultsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {{provider: string, model: string, thinking?: string, serviceTier?: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. thinking empty ⇒ the model's default level, serviceTier empty ⇒ standard serving. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {{provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} @private - Cheap model for out-of-band micro-tasks. explicit=false means Auto; disabled=true means the user wants none, which Auto cannot express. */
    this.cheapModel = { explicit: false };
    /** @type {{provider?: string, model?: string, explicit?: boolean, available?: boolean}} @private - Decision model for tasks that want one, such as Auto-approve. explicit=false means none is chosen and the cheap model is used instead; available=false on an explicit choice means it cannot serve right now. */
    this.decisionModel = { explicit: false };
  }

  /**
   * Element disconnected: close the model picker if one is open. It is drawn
   * into <body>, not this tab's section, so it would outlive the panel; every
   * other listener this tab takes is on a control inside its own section.
   */
  dispose() {
    closePopupById(MODEL_PICKER_POPUP_ID);
  }

  /**
   * The three model choices this tab holds — what the panel's config load keeps
   * when a re-read of one fails, rather than blanking a picker already drawn.
   * @returns {{defaultModel: import('../../services/settings-api.js').ModelChoice, cheapModel: import('../../services/settings-api.js').ModelChoice, decisionModel: import('../../services/settings-api.js').ModelChoice}} The current choices.
   */
  currentModelChoices() {
    return { defaultModel: this.defaultModel, cheapModel: this.cheapModel, decisionModel: this.decisionModel };
  }

  /**
   * Receive the shared loadConfig() payload: store config/providers/defaultModel
   * and (on a full render) build the fields.
   * @param {{config: object, providers: any[], defaultModel: {provider: string, model: string, thinking?: string, serviceTier?: string, explicit?: boolean}, cheapModel?: {provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}|null, decisionModel?: {provider?: string, model?: string, explicit?: boolean, available?: boolean}|null}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    this.defaultModel = data.defaultModel;
    if (data.cheapModel) this.cheapModel = data.cheapModel;
    if (data.decisionModel) this.decisionModel = data.decisionModel;
    // Keep the client-side auto-naming cache in step with the server on every
    // config load, so the conversation bar's new-tab decision stays current even
    // when the settings panel isn't rendering fields.
    setAutoNameEnabledCached(!(/** @type {any} */ (this.config).autoNameDisabled));
    // The same for reply suggestions, which the server never reads back — this
    // load is how the browser learns the setting at all, and until it lands the
    // feature holds its tongue.
    setReplySuggestionsEnabledCached(!(/** @type {any} */ (this.config).replySuggestionsDisabled));
    if (renderFields) {
      this.renderGlobalSettings();
      this.renderDefaultModelField();
      this.renderCheapModelField();
      this.renderDecisionModelField();
      this.renderAutoNameSettings();
      this.renderReplySuggestionsSettings();
      this.renderNewConversationDefaults();
    }
  }

  /**
   * Render the "New conversation defaults" section's per-project fields: the strategy
   * a conversation starts on, and whether it starts with edits allowed instead of
   * asking. Persisted to session metadata, so they survive restarts and are shared
   * across windows on the same project. The section's other field, the default model,
   * is rendered separately by renderDefaultModelField() into a sibling container, since
   * it's a global setting rather than a per-project one.
   * @private
   */
  renderNewConversationDefaults() {
    const container = this.host.querySelector('#new-conversation-defaults-fields');
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(this._buildDefaultStrategyRow());

    const { row } = buildToggleRow(
      t('Allow file edits in new conversations'),
      t('Start each new conversation with file editing already allowed, so the agent can edit ' +
      'without asking first — handy when your project is in version control. Each conversation ' +
      'can still be toggled individually, and edits outside the project and allowed ' +
      'paths always prompt.'),
      isDefaultFileEditingOn(getAppSession()),
      (on) => setDefaultFileEditingOn(getAppSession(), on),
    );
    container.appendChild(row);
  }

  /**
   * Render the auto-naming row inside the cheap-model card: the global on/off
   * switch with an optional custom instruction stacked beneath it, shown only
   * while auto-naming is on. Both persist to credentials.json via PUT
   * /api/config; the server reads them live for the next naming attempt. When
   * on (the default), a new conversation keeps its "Untitled N" name and the composer takes
   * focus, and the cheap model derives a title after the first message; when
   * off, the new conversation opens its inline rename editor instead and no title is
   * auto-derived.
   * @private
   */
  renderAutoNameSettings() {
    const container = this.host.querySelector('#auto-name-form');
    if (!container) return;
    container.innerHTML = '';

    // The optional custom instruction, built first so the toggle's handler can
    // reveal or hide it. It shares the toggle's card (appended into the same
    // control column below), so the switch and the prompt it shapes read as one
    // grouped setting rather than two separate rows.
    const instruction = this._buildAutoNameInstructionControl();
    instruction.hidden = !!(/** @type {any} */ (this.config).autoNameDisabled);

    // On/off switch. Checked = enabled; we persist the *disabled* bool so the
    // stored key is absent by default (default-on).
    const { row, input: toggleInput } = buildToggleRow(
      t('Name new conversations'),
      t('Derives a tab title from your first message. Turn this off to name new ' +
      'conversations yourself.'),
      !(/** @type {any} */ (this.config).autoNameDisabled),
      async (on) => {
        const previous = toggleInput.checked;
        try {
          await settingsApi.setConfig('auto_name_disabled', !on);
          /** @type {any} */ (this.config).autoNameDisabled = !on;
          setAutoNameEnabledCached(on);
          // The instruction only shapes an auto-derived title, so hide it while
          // auto-naming is off; the stored value is kept and reappears on re-enable.
          instruction.hidden = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save auto-naming setting:', e);
          toggleInput.checked = !previous;
        }
      },
    );

    // Stack the instruction beneath the switch in the toggle's own control
    // column, so both controls live in a single card.
    row.querySelector('.provider-control')?.appendChild(instruction);
    container.appendChild(row);
  }

  /**
   * Render the "Suggest prompts" row inside the cheap-model card: the global
   * on/off switch for the few things you might say next, offered under a
   * finished turn, and for the starter prompts an empty conversation offers in
   * the same row. Persists to credentials.json via PUT /api/config like the
   * auto-naming switch, but only the browser reads it back — the suggestions
   * are generated client-side through /api/llm/complete, so the cached mirror
   * is what actually gates them.
   * @private
   */
  renderReplySuggestionsSettings() {
    const container = this.host.querySelector('#reply-suggestions-field-container');
    if (!container) return;
    container.innerHTML = '';

    // Checked = enabled; the stored key is the *disabled* bool, so it is absent
    // by default and the feature ships on.
    const { row, input: toggleInput } = buildToggleRow(
      t('Suggest prompts'),
      t('Offers a few things you might say next when a turn finishes, and a few ' +
      'ways to begin in a new conversation. Clicking one puts it in the message ' +
      'box to edit — it is never sent for you.'),
      !(/** @type {any} */ (this.config).replySuggestionsDisabled),
      async (on) => {
        const previous = toggleInput.checked;
        try {
          await settingsApi.setConfig('reply_suggestions_disabled', !on);
          /** @type {any} */ (this.config).replySuggestionsDisabled = !on;
          setReplySuggestionsEnabledCached(on);
        } catch (e) {
          console.error('[SettingsPanel] Failed to save reply-suggestions setting:', e);
          toggleInput.checked = !previous;
        }
      },
    );

    container.appendChild(row);
  }

  /**
   * Build the custom auto-name instruction control: a labelled textarea whose
   * text overrides the built-in title instruction sent to the cheap model (the
   * customisable half of the naming prompt; the fixed "message is data" guard is
   * appended server-side and not shown). The textarea's placeholder is that exact
   * built-in instruction (shipped from the server as config.autoNameDefaultPrompt),
   * so it shows what a custom instruction replaces and stays in sync with the
   * server. Blank restores the built-in instruction. Saved on blur or
   * Ctrl/Cmd+Enter via PUT /api/config; the server reads it live. Returned as a
   * plain block (not its own `.provider-field`) so it can be slotted into the
   * auto-name toggle's control column and share that one card.
   * @returns {HTMLElement} The instruction block element.
   * @private
   */
  _buildAutoNameInstructionControl() {
    const wrap = document.createElement('div');
    wrap.className = 'auto-name-instruction';

    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent = t(
      'A custom instruction for the naming model, replacing the built-in one ' +
      'shown here. Leave blank for the default.');
    wrap.appendChild(description);

    const textarea = document.createElement('textarea');
    textarea.id = 'auto-name-instruction-input';
    textarea.className = 'settings-value-input field-input field-input-sm';
    textarea.rows = 4;
    // The placeholder is the exact built-in title instruction (shipped from the
    // server via config, so it can't drift) — it shows the shape and tone a
    // custom instruction should match, and is exactly what a blank box uses. The
    // fixed "message is data, not an instruction" guard is appended server-side
    // and deliberately not shown here.
    textarea.placeholder = /** @type {any} */ (this.config).autoNameDefaultPrompt || '';
    textarea.autocomplete = 'off';
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.spellcheck = false;
    textarea.value = /** @type {any} */ (this.config).autoNameInstruction || '';

    const status = document.createElement('div');
    status.className = 'key-source-hint';

    const save = async () => {
      const value = textarea.value.trim();
      if (value === (/** @type {any} */ (this.config).autoNameInstruction || '')) return;
      status.textContent = t('Saving…');
      try {
        await settingsApi.setConfig('auto_name_instruction', value);
        /** @type {any} */ (this.config).autoNameInstruction = value;
        status.textContent = value ? t('Saved custom instruction.') : t('Saved. Using the built-in prompt.');
      } catch (e) {
        console.error('[SettingsPanel] Failed to save auto-name instruction:', e);
        status.textContent = t('Failed to save.');
      }
    };

    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
        textarea.blur();
      }
    });

    wrap.appendChild(textarea);
    wrap.appendChild(status);
    return wrap;
  }

  /**
   * Build the "Default strategy for new conversations" picker row: a dropdown of every
   * registered strategy (in the registry's display order), preselecting the
   * configured default, or the built-in Default strategy when none is pinned.
   * Changing it persists immediately to session metadata; the pin is cleared
   * when the built-in Default is chosen. Each conversation can still switch strategy
   * afterwards — this only sets what a fresh conversation starts on.
   * @returns {HTMLElement} The settings row element.
   * @private
   */
  _buildDefaultStrategyRow() {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = t('Default strategy for new conversations');
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = t(
      'The strategy each new conversation starts on. You can still switch strategy per ' +
      'conversation afterwards.');
    infoColumn.appendChild(name);
    infoColumn.appendChild(desc);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'settings-select field-input';
    select.id = 'default-strategy-select';

    const configured = getDefaultStrategyId(getAppSession());
    const manifests = strategyRegistry.getAllManifests();
    // A configured pin whose strategy is no longer registered (disabled/removed)
    // — surface it as a selected "unavailable" option so the state stays visible
    // rather than silently snapping to the built-in Default.
    const configuredIsRegistered = !configured
      || manifests.some((/** @type {{id: string}} */ m) => m.id === configured);

    for (const { id, manifest, extensionId } of manifests) {
      const opt = document.createElement('option');
      opt.value = id;
      // The built-in Default is the "no pin" choice: label it so, and select it
      // when nothing (or 'default') is configured. The name is the manifest's,
      // translated by its own extension's catalogue first.
      const name = t(manifest.name, undefined, { namespace: extensionId || undefined });
      opt.textContent = id === BUILTIN_DEFAULT_STRATEGY_ID
        ? t('{name} (built-in default)', { name })
        : name;
      if (configuredIsRegistered
        ? (configured ? id === configured : id === BUILTIN_DEFAULT_STRATEGY_ID)
        : false) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    if (!configuredIsRegistered && configured) {
      const opt = document.createElement('option');
      opt.value = configured;
      opt.textContent = t('{id} — unavailable', { id: configured });
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }

    select.addEventListener('change', () => {
      setDefaultStrategyId(getAppSession(), select.value);
    });

    controlColumn.appendChild(select);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    return row;
  }

  /**
   * Render global settings that apply across every provider, shown as a section
   * on the Defaults tab: the automatic-compaction on/off switch, the stream
   * idle timeout (the window a streaming provider waits for the next event
   * before declaring the connection dead, "stream stalled: no data for 3m0s";
   * raising it helps gateways whose cold starts exceed the 180s default), and
   * the two sub-agent limits: the per-run budget of a delegated child (weighted
   * input tokens, worker/run_budget.go) and the conversation spend ceiling (NEW
   * input tokens across all threads, worker/spend.go). All persist to
   * credentials.json via PUT /api/config; the server reads them live.
   * @private
   */
  renderGlobalSettings() {
    const container = this.host.querySelector('#global-settings');
    if (!container) return;
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading caps-label-lg';
    heading.textContent = t('Context');
    container.appendChild(heading);

    // Automatic compaction on/off. Checked = enabled; we persist the *disabled*
    // bool so the stored key is absent by default (default-on). The honest
    // second sentence discloses the "fully off" consequence to the person
    // deliberately flipping the switch.
    const { row: autoCompactRow, input: autoCompactInput } = buildToggleRow(
      t('Automatic compaction'),
      t('When a conversation nears the model\u2019s context limit, Juggler summarizes ' +
      'older turns to make room. Turn this off to keep full transcripts \u2014 long ' +
      'conversations may then hit the model\u2019s limit and error.'),
      !(/** @type {any} */ (this.config).autoCompactDisabled),
      async (on) => {
        const previous = autoCompactInput.checked;
        try {
          await settingsApi.setConfig('auto_compact_disabled', !on);
          /** @type {any} */ (this.config).autoCompactDisabled = !on;
        } catch (e) {
          console.error('[SettingsPanel] Failed to save automatic compaction setting:', e);
          autoCompactInput.checked = !previous;
        }
      },
    );
    container.appendChild(autoCompactRow);

    // How much of the conversation a fold keeps verbatim — automatic folds and
    // /compact alike (worker/compaction_tail.go owns the rule). Stored as a
    // whole percentage; blank is the worker's default.
    this._appendNumberField(container, {
      name: t('Keep recent conversation (%)'),
      description: t(
        'How much of the newest conversation compaction leaves word for word, as a ' +
        'percentage. The latest request is always kept, and a full conversation keeps ' +
        'at most half the context window. /compact all folds everything. ' +
        'Blank for the default (30), up to 60.'),
      inputId: 'compact-keep-recent-input',
      placeholder: '30',
      current: () => /** @type {any} */ (this.config).compactKeepRecentPercent || '',
      validate: (value) => (parseInt(value, 10) > 60 ? t('Must be 60 or less.') : ''),
      save: async (value) => {
        await settingsApi.setConfig('compact_keep_recent_percent', value);
        /** @type {any} */ (this.config).compactKeepRecentPercent = value;
        return value
          ? t('Saved. Compaction keeps the newest {value}%.', { value })
          : t('Saved. Using the default (30%).');
      },
      failureLog: 'keep-recent setting',
    });

    this._appendNumberField(container, {
      heading: t('Stream idle timeout'),
      name: t('Seconds to wait'),
      description: t(
        'Seconds to wait for the next stream event before treating the connection ' +
        'as dropped ("stream stalled"). Raise it for gateways with slow cold ' +
        'starts. Leave blank for the default (180).'),
      inputId: 'stream-idle-timeout-input',
      placeholder: '180',
      current: () => /** @type {any} */ (this.config).streamIdleTimeout || '',
      validate: (value) => (parseInt(value, 10) <= 0 ? t('Must be greater than zero.') : ''),
      save: async (value) => {
        await settingsApi.setConfig('stream_idle_timeout', value);
        /** @type {any} */ (this.config).streamIdleTimeout = value;
        return value ? t('Saved. Waiting up to {value}s.', { value }) : t('Saved. Using default (180s).');
      },
      failureLog: 'stream idle timeout',
    });

    // The two limits on delegated work: the per-run budget and the conversation
    // spend ceiling. Both are stored in tokens and shown in millions — the figure
    // people reason about is "twenty million", and a field asking them to count
    // zeroes invites the slip that switches the guard off.
    const limitsHeading = document.createElement('div');
    limitsHeading.className = 'settings-section-heading caps-label-lg';
    limitsHeading.textContent = t('Sub-agent limits');
    container.appendChild(limitsHeading);

    this._appendMillionTokensField(container, {
      name: t('Per run (million tokens)'),
      description: t(
        'How much input a sub-agent may use each time it is called before it has to ' +
        'stop and report. Input read from cache counts at a tenth, and a run also ends ' +
        'after 100 model calls per million. Only affects threads an agent started. ' +
        'Blank for the default (1), 0 for no limit.'),
      inputId: 'run-budget-input',
      defaultMillions: 1,
      configKey: 'runBudgetTokens',
      requestKey: 'run_budget_tokens',
      savedText: (value) => (value === '0'
        ? t('Saved. No per-run limit.')
        : t('Saved. Sub-agents report after {value}M per run.', { value })),
      defaultText: () => t('Saved. Using the default (1M).'),
      failureLog: 'run budget',
    });

    this._appendMillionTokensField(container, {
      name: t('Per conversation (million tokens)'),
      description: t(
        'Total new input a conversation may use across all its threads; input read ' +
        'from cache is not counted. Once it is reached, sub-agents are asked to report ' +
        'and no new ones can start. Your own turns keep running. ' +
        'Blank for the default (10), 0 for no limit.'),
      inputId: 'spend-limit-input',
      defaultMillions: 10,
      configKey: 'spendLimitTokens',
      requestKey: 'spend_limit_tokens',
      savedText: (value) => (value === '0'
        ? t('Saved. No conversation limit.')
        : t('Saved. Sub-agents stop past {value}M per conversation.', { value })),
      defaultText: () => t('Saved. Using the default (10M).'),
      failureLog: 'spend ceiling',
    });

    this._appendDiffSettings(container);
  }

  /**
   * Append a token limit shown in millions (decimals allowed) and stored in
   * tokens under a raw config key, where blank means the server's default and 0
   * means no limit.
   * @private
   * @param {Element} container
   * @param {object} opts
   * @param {string} opts.name - Short label for the value.
   * @param {string} opts.description - The explanatory line under the label.
   * @param {string} opts.inputId - DOM id for the input.
   * @param {number} opts.defaultMillions - The server default, shown as the placeholder.
   * @param {string} opts.configKey - Where loadConfig() puts the stored token string.
   * @param {string} opts.requestKey - The PUT /api/config key.
   * @param {(value: string) => string} opts.savedText - Status line for a saved non-blank value ('0' = off).
   * @param {() => string} opts.defaultText - Status line for a cleared field.
   * @param {string} opts.failureLog - What to call this setting in the console on failure.
   */
  _appendMillionTokensField(container, opts) {
    const config = /** @type {any} */ (this.config);
    this._appendNumberField(container, {
      name: opts.name,
      description: opts.description,
      inputId: opts.inputId,
      placeholder: String(opts.defaultMillions),
      decimal: true,
      current: () => {
        const tokens = parseInt(config[opts.configKey], 10);
        return Number.isFinite(tokens) ? String(Number((tokens / 1_000_000).toFixed(3))) : '';
      },
      validate: (value) => (Number(value) > 0 && Math.round(Number(value) * 1_000_000) < 1000
        ? t('Must be 0 or at least 0.001.') : ''),
      save: async (value) => {
        const tokens = value === '' ? '' : String(Math.round(Number(value) * 1_000_000));
        await settingsApi.setConfig(opts.requestKey, tokens);
        config[opts.configKey] = tokens;
        if (value === '') return opts.defaultText();
        return opts.savedText(tokens === '0' ? '0' : String(Number(value)));
      },
      failureLog: opts.failureLog,
    });
  }

  /**
   * How diffs are drawn, everywhere one is shown: the two-column layout, and how
   * much of the file to show around each change.
   *
   * These are what a NEW diff starts on. Any diff can be set on its own from the
   * controls on it, and while it is, it stops following these — so changing one
   * here moves every diff the reader has not already had an opinion about.
   *
   * Unlike everything above, they persist through the `user` preference realm
   * rather than PUT /api/config: nothing on the server reads them, and a display
   * choice belongs with the tips you have seen and the bell, not in
   * credentials.json beside the spend ceiling.
   * @param {Element} container - The form to append to.
   * @private
   */
  _appendDiffSettings(container) {
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading caps-label-lg';
    heading.textContent = t('Diffs');
    container.appendChild(heading);

    const { row: splitRow } = buildToggleRow(
      t('Side-by-side diffs'),
      t('Show the old and new file in two columns instead of one combined list. ' +
      'Needs a wide enough panel — a diff with no room for two columns shows the ' +
      'combined list whatever this says.'),
      defaultDiffView() === 'split',
      (on) => setDefaultDiffView(on ? 'split' : 'inline'),
    );
    container.appendChild(splitRow);

    const contextRow = document.createElement('div');
    contextRow.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = t('Lines of context');
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent = t(
      'Unchanged lines shown above and below each change, so you can see what it ' +
      'sits in. More is more to read; the whole file is every line of it.');
    info.appendChild(name);
    info.appendChild(description);

    const control = document.createElement('div');
    control.className = 'provider-control';
    const select = document.createElement('select');
    select.className = 'settings-select field-input';
    select.id = 'diff-context-select';
    const current = defaultDiffContext();
    for (const lines of CONTEXT_CHOICES) {
      const option = document.createElement('option');
      option.value = String(lines);
      option.textContent = contextLabel(lines);
      if (lines === current) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => setDefaultDiffContext(Number(select.value)));
    control.appendChild(select);

    contextRow.appendChild(info);
    contextRow.appendChild(control);
    container.appendChild(contextRow);
  }

  /**
   * Append one labelled number setting: heading, name, description, and a
   * text input that saves on blur and on Enter. Blank always means "use the
   * default", so every field built here can be cleared back to the shipped
   * behaviour without a separate control saying so.
   *
   * `current` is read rather than captured because the saved value is written
   * back onto `this.config`, and a re-render must show what was saved rather
   * than what was there when the field was built.
   * @private
   * @param {Element} container
   * @param {object} opts
   * @param {string} [opts.heading] - Section heading above the field; omitted when the field joins one already there.
   * @param {string} opts.name - Short label for the value itself.
   * @param {string} opts.description - The explanatory line under the label.
   * @param {string} opts.inputId - DOM id for the input.
   * @param {string} opts.placeholder - Shown when the field is blank (the default).
   * @param {boolean} [opts.decimal] - Accept a decimal number rather than only a whole one.
   * @param {() => string} opts.current - The currently saved value, as displayed.
   * @param {(value: string) => string} [opts.validate] - Returns an error message for a non-blank value, or ''.
   * @param {(value: string) => Promise<string>} opts.save - Persists the value; resolves with the status line to show.
   * @param {string} opts.failureLog - What to call this setting in the console on failure.
   */
  _appendNumberField(container, opts) {
    if (opts.heading) {
      const heading = document.createElement('div');
      heading.className = 'settings-section-heading caps-label-lg';
      heading.textContent = opts.heading;
      container.appendChild(heading);
    }

    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = opts.name;
    infoColumn.appendChild(nameLabel);
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent = opts.description;
    infoColumn.appendChild(description);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const row = document.createElement('div');
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper field-input';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = opts.inputId;
    // Non-secret persisted value: keep visible across close/reopen (see close()).
    input.className = 'settings-value-input';
    input.inputMode = opts.decimal ? 'decimal' : 'numeric';
    input.placeholder = opts.placeholder;
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = opts.current();
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === opts.current()) return;
      if (value !== '' && !(opts.decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(value)) {
        status.textContent = opts.decimal ? t('Enter a number.') : t('Enter a whole number.');
        return;
      }
      const invalid = value === '' ? '' : (opts.validate?.(value) || '');
      if (invalid) {
        status.textContent = invalid;
        return;
      }
      status.textContent = t('Saving…');
      try {
        status.textContent = await opts.save(value);
      } catch (e) {
        console.error(`[SettingsPanel] Failed to save ${opts.failureLog}:`, e);
        status.textContent = t('Failed to save.');
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

    controlColumn.appendChild(row);
    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Render the "Default model" row: the model new conversations are seeded
   * with. The chip opens the shared picker, whose bottom row ("Automatic")
   * clears the stored value and lets the server pick a preferred available
   * model. Every change persists immediately via PUT /api/default-model, and the
   * resolved choice is described in the status line under the chip.
   * @private
   */
  renderDefaultModelField() {
    this._renderModelRow({
      containerId: '#default-model-field-container',
      nameLabel: t('Default model for new conversations'),
      current: this.defaultModel || { provider: '', model: '', explicit: false },
      pickerProviders: this._chatProviders(),
      statusText: (ref) => this._defaultModelStatusText(ref),
      onSave: (config) => this._saveDefaultModel(config),
    });
  }

  /**
   * Render the "Cheap model" row: the picker at the head of the section's card,
   * above the rows for the jobs that spend it. "Automatic" clears the stored
   * value and derives one from the model in use. Persists via PUT
   * /api/cheap-model.
   *
   * The label is bare because the section heading and its description already
   * say what a cheap model is and what uses it; only the "Automatic" half needs
   * explaining on the row itself.
   * @private
   */
  renderCheapModelField() {
    this._renderModelRow({
      containerId: '#cheap-model-field-container',
      nameLabel: t('Cheap model'),
      description: t('"Automatic" derives one from the model in use.'),
      current: this.cheapModel || { explicit: false },
      pickerProviders: this._chatProviders(),
      // The one row with a third state. Turning it off is a real answer — the
      // tasks it runs are optional — and recording it is what stops the server
      // deriving a model anyway, and stops it mentioning that it can't.
      offLabel: t('Off — no cheap model'),
      statusText: (ref) => this._cheapModelStatusText(ref),
      onSave: (config) => this._saveCheapModel(config),
    });
  }

  /**
   * Render the "Decision model" row: the model that answers yes/no and choice
   * questions where a chat model would only be asked for a verdict. "Automatic"
   * means none is chosen, and the cheap model does the job as it did before
   * decision models existed. Persists via PUT /api/decision-model.
   *
   * The picker offers only providers that make decisions, and nothing is ever
   * derived: a decision model is a different kind of thing, billed to its own
   * account, so it is used only once the user has picked one.
   * @private
   */
  renderDecisionModelField() {
    this._renderModelRow({
      containerId: '#decision-model-field-container',
      nameLabel: t('Decision model'),
      description: t('"Automatic" uses the cheap model instead.'),
      current: this.decisionModel || { explicit: false },
      pickerProviders: this._decisionProviders(),
      statusText: (ref) => this._decisionModelStatusText(ref),
      onSave: (config) => this._saveDecisionModel(config),
    });
  }

  /**
   * The providers a chat model can be chosen from: every one that can hold a
   * conversation. A decision-only provider is left out of the default and cheap
   * pickers, whose models are used to write text.
   * @returns {any[]} The chat providers.
   * @private
   */
  _chatProviders() {
    return this.providers.filter((/** @type {any} */ p) => !p.decisionOnly);
  }

  /**
   * The providers a decision model can be chosen from.
   * @returns {any[]} The providers that make decisions.
   * @private
   */
  _decisionProviders() {
    return this.providers.filter((/** @type {any} */ p) => p.decisions);
  }

  /**
   * Shared renderer for the Default/Cheap/Decision model rows: a `<model-chip>` that
   * opens the same `<model-picker>` the composer uses, and a status line
   * describing the current (or auto-resolved) choice.
   *
   * The picker is the whole control here — model, thinking level and serving
   * speed all come back on one `change` as a complete config, so these rows
   * store exactly what a conversation stores.
   * @param {object} opts
   * @param {string} opts.containerId - CSS selector for the field container.
   * @param {string} opts.nameLabel - Field label text.
   * @param {string} [opts.description] - Optional description under the label.
   * @param {{provider?: string, model?: string, thinking?: string, serviceTier?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} opts.current
   * @param {string} [opts.offLabel] - Label for the picker's Off row; omitted leaves the row out.
   * @param {any[]} [opts.pickerProviders] - The providers the picker offers; defaults to every provider. The chip is always given the full list, so it can name a model the picker would not offer.
   * @param {(ref: any) => string} opts.statusText - Builds the status line.
   * @param {(config: import('../../model/model-config.js').ModelConfigShape) => void} opts.onSave - Persists the chosen config, or null for Automatic.
   * @private
   */
  _renderModelRow({ containerId, nameLabel, description, current, offLabel, pickerProviders, statusText, onSave }) {
    const container = this.host.querySelector(containerId);
    if (!container) return;
    container.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = nameLabel;
    infoColumn.appendChild(name);

    if (description) {
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = description;
      infoColumn.appendChild(desc);
    }

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const ref = current || { explicit: false };
    // Automatic is the ABSENCE of a config, which is exactly what the picker's
    // none row and the chip's placeholder already mean.
    const config = ref.explicit && ref.provider && ref.model
      ? buildModelConfig(ref.provider, ref.model, ref.thinking, ref.serviceTier)
      : null;
    const isOff = !!ref.disabled;

    const chip = /** @type {any} */ (document.createElement('model-chip'));
    chip.update({
      providers: this.providers,
      // Off has no config either, so without its own word on the chip it would
      // be indistinguishable from Automatic without opening the picker.
      placeholder: isOff ? t('Off') : t('Automatic'),
      buttonTitle: nameLabel,
      config,
    });
    chip.addEventListener('chip-toggle', () => this._openModelPicker(chip, config, onSave, { offLabel, isOff, pickerProviders }));
    // The pill promises its mini popover, so an open picker gets out of the way
    // first. Closing leaves the chip's DOM alone, so the pill is still the
    // anchor the popover then attaches to.
    chip.addEventListener('mini-requested', () => closePopupById(MODEL_PICKER_POPUP_ID));
    // The chip's own mini popover changes the thinking level without the picker.
    chip.addEventListener('change', (/** @type {Event} */ e) => {
      onSave(/** @type {CustomEvent} */ (e).detail);
    });

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = statusText(ref);

    controlColumn.appendChild(chip);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * Open the shared picker against one settings row.
   *
   * The settings panel is a modal, so two things matter here: the picker's own
   * Escape handling closes only the picker (popup-manager's Escape dismisses
   * every overlay, modal included), and one popup id across both rows means
   * opening the second row's picker closes the first.
   * @param {any} chip - The `<model-chip>` the picker anchors to.
   * @param {import('../../model/model-config.js').ModelConfigShape} value - The config in effect.
   * @param {(config: import('../../model/model-config.js').ModelConfigShape) => void} onSave
   * @param {{offLabel?: string, isOff?: boolean, pickerProviders?: any[]}} [opts] - The Off row, for a row that has one, and the providers to offer.
   * @private
   */
  _openModelPicker(chip, value, onSave, { offLabel, isOff, pickerProviders } = {}) {
    // Second press on the same chip dismisses rather than re-opening.
    if (closePopupById(MODEL_PICKER_POPUP_ID)) return;

    const picker = /** @type {any} */ (document.createElement('model-picker'));
    picker.providers = pickerProviders || this.providers;
    picker.value = value;
    picker.noneLabel = t('Automatic');
    if (offLabel) picker.offLabel = offLabel;
    picker.off = !!isOff;

    /** @type {(() => void)|null} */
    let release = null;
    const close = () => {
      chip.expanded = false;
      if (release) {
        release();
        release = null;
      }
    };

    picker.addEventListener('change', (/** @type {Event} */ e) => {
      close();
      onSave(/** @type {CustomEvent} */ (e).detail);
    });
    picker.addEventListener('close', close);

    release = presentPopup({
      surface: picker,
      anchor: chip.button || chip,
      id: MODEL_PICKER_POPUP_ID,
      onClose: close,
      insideSelectors: ['model-chip', '.model-picker'],
    });
    chip.expanded = true;
  }

  /**
   * The request body for a model row: the whole config, or the empty pair that
   * clears the stored value back to Automatic. Both dials ride along, since a
   * stored default that dropped one would seed something the user never chose.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @returns {{provider: string, model: string, thinking?: string, serviceTier?: string}} The PUT body.
   * @private
   */
  _modelRowBody(config) {
    if (!config?.provider || !config?.model) return { provider: '', model: '' };
    /** @type {{provider: string, model: string, thinking?: string, serviceTier?: string}} */
    const body = { provider: config.provider, model: config.model };
    if (config.thinking) body.thinking = config.thinking;
    if (config.serviceTier) body.serviceTier = config.serviceTier;
    return body;
  }

  /**
   * Persist the chosen cheap model: a config pins it, null is Automatic, and
   * the picker's Off sentinel records that the user wants none at all.
   *
   * Off is sent as its own flag rather than as the empty pair, because the
   * empty pair is Automatic — stored that way, "no cheap model" would be read
   * back as "pick me one", which is the opposite instruction.
   *
   * Applied optimistically — the row repaints before the request lands, and is
   * put back as it was if the save fails, so the chip never shows a choice the
   * server rejected.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @private
   */
  async _saveCheapModel(config) {
    const previous = this.cheapModel;
    const off = /** @type {any} */ (config) === MODEL_PICKER_OFF || !!(/** @type {any} */ (config)?.off);
    const body = off ? { provider: '', model: '', disabled: true } : this._modelRowBody(config);
    this.cheapModel = {
      provider: body.provider,
      model: body.model,
      thinking: /** @type {any} */ (body).thinking || '',
      serviceTier: /** @type {any} */ (body).serviceTier || '',
      explicit: !!(body.provider && body.model),
      disabled: off,
    };
    this.renderCheapModelField();
    try {
      await settingsApi.setCheapModel(body);
      // Cleared to Automatic: re-fetch so the auto-derived name in the status
      // line is the one the server actually resolved. Off needs no such trip —
      // there is nothing for the server to have derived.
      if (!off && (!body.provider || !body.model)) {
        this.cheapModel = await settingsApi.getCheapModel({ fallback: null }) || { explicit: false };
        this.renderCheapModelField();
      }
    } catch (err) {
      console.error('[SettingsPanel] Failed to save cheap model:', err);
      this.cheapModel = previous;
      this.renderCheapModelField();
      await showAlert(t('Couldn\'t save the cheap model.\n\n{error}', { error: errorText(err) }), t('Error'));
    }
  }

  /**
   * Persist the chosen decision model. A null config clears it (Automatic), so
   * the cheap model is used again.
   *
   * Applied optimistically, and put back as it was if the save fails — same
   * contract as the other model rows.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @private
   */
  async _saveDecisionModel(config) {
    const previous = this.decisionModel;
    const body = this._modelRowBody(config);
    this.decisionModel = {
      provider: body.provider,
      model: body.model,
      explicit: !!(body.provider && body.model),
    };
    this.renderDecisionModelField();
    try {
      // A decision model has no reasoning level or serving tier to send.
      await settingsApi.setDecisionModel({ provider: body.provider, model: body.model });
      // Re-read so the row reflects whether the server can actually serve the
      // pick, which only it knows.
      this.decisionModel = await settingsApi.getDecisionModel({ fallback: this.decisionModel }) || { explicit: false };
      this.renderDecisionModelField();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save decision model:', err);
      this.decisionModel = previous;
      this.renderDecisionModelField();
      await showAlert(t('Couldn\'t save the decision model.\n\n{error}', { error: errorText(err) }), t('Error'));
    }
  }

  /**
   * The decision row's status line. With nothing chosen it says what runs
   * instead, since "Automatic" here is not a model being derived but the cheap
   * model standing in.
   * @param {{provider?: string, model?: string, explicit?: boolean}} ref
   * @returns {string} short status describing the current decision-model state
   * @private
   */
  _decisionModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      return this._decisionProviders().some((/** @type {any} */ p) => p.available)
        ? t('Automatic — the cheap model is used.')
        : t('Automatic — the cheap model is used. Add a decision model in Providers.');
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * @param {{provider: string, model: string, explicit?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current default-model state
   * @private
   */
  _defaultModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      if (ref && ref.provider && ref.model) {
        return t('Auto — currently {model}.', { model: modelLabelFromList(this.providers, ref.provider, ref.model) });
      }
      return t('Auto — no provider is configured yet.');
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * The cheap row's status line, which has three states to tell apart and used
   * to have two. "Auto" with nothing resolved is the one that matters: it is a
   * provider offering no cheap tier, and while the row described that as a
   * model having been derived, the tasks were silently not running with nothing
   * on screen to suggest it.
   * @param {{provider?: string, model?: string, explicit?: boolean, disabled?: boolean, autoResolved?: {provider: string, model: string}}} ref
   * @returns {string} short status describing the current cheap-model state
   * @private
   */
  _cheapModelStatusText(ref) {
    if (ref && ref.disabled) return t('Off — background tasks won\'t run.');
    if (!ref || !ref.explicit) {
      const auto = ref && ref.autoResolved;
      if (auto && auto.provider && auto.model) {
        return t('Auto — currently {model}.', { model: modelLabelFromList(this.providers, auto.provider, auto.model) });
      }
      return t('Auto — nothing available for this provider.');
    }
    return this._explicitModelStatusText(ref);
  }

  /**
   * Status hint shared by both pickers for an explicitly-pinned model: reports
   * whether its provider is registered/available and the model still listed.
   * @param {{provider?: string, model?: string}} ref
   * @returns {string} the status hint for the pinned model
   * @private
   */
  _explicitModelStatusText(ref) {
    const p = this.providers.find((/** @type {any} */ pp) => pp.name === ref.provider);
    if (!p) return t('Provider not registered.');
    // authHint is the server's own wording for its sign-in state.
    if (!p.available) return p.authType === 'oauth_bearer'
      ? (providerAuthHint(p) || t('Provider is unavailable. Sign in to continue.'))
      : t('Provider is configured but has no API key.');
    const hasModel = p.modelsWithContext && p.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === ref.model);
    if (p.modelsWithContext && !hasModel) {
      return t('Model is not in the provider’s current model list.');
    }
    return t('Active.');
  }

  /**
   * Persist the chosen default model. A null config clears it (Automatic).
   *
   * Applied optimistically, and reverted if the save fails — same contract as
   * the cheap model's row.
   * @param {import('../../model/model-config.js').ModelConfigShape} config
   * @private
   */
  async _saveDefaultModel(config) {
    const previous = this.defaultModel;
    const body = this._modelRowBody(config);
    this.defaultModel = {
      provider: body.provider,
      model: body.model,
      thinking: body.thinking || '',
      serviceTier: body.serviceTier || '',
      explicit: !!(body.provider && body.model),
    };
    this.renderDefaultModelField();
    try {
      await settingsApi.setDefaultModel(body);
      // Displays that fall back to the default (the sidebar's Usage card, when
      // no conversation is on screen) read a cached copy of the server's answer.
      defaultModelCache.invalidate();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      this.defaultModel = previous;
      this.renderDefaultModelField();
      await showAlert(t('Couldn\'t save the default model.\n\n{error}', { error: errorText(err) }), t('Error'));
    }
  }
}
