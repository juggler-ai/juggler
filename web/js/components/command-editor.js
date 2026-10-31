//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command editor — the editing form for one user-defined slash command.
 *
 * Mounted into the detail pane of the Slash commands settings page
 * (`settings/commands-tab.js`), which owns the list and the selection. It writes
 * a `.juggler/commands/*.md` file via the backend (the same validation path
 * `define_command` uses) and re-reads the user commands so the command is in
 * the slash menu by the time the save resolves.
 * @module components/command-editor
 */

import { writeUserCommand, deleteUserCommand, USER_COMMAND_NAME_RE } from '../services/user-commands.js';
import { expandTemplate, resolveModelConfig } from '../plugins/user-command-factory.js';
import commandRegistry from '../registries/command-registry.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import strategyRegistry from '../registries/strategy-registry.js';
import providersCache from '../services/providers-cache.js';
import { buildModelConfig } from '../model/model-config.js';
import { presentPopup } from '../utils/popup-surface.js';
import { closePopupById } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';
import { showConfirm } from './modal-dialog.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { t, markForTranslation, htmlSlots, withHtml, serverText } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import './model-picker/model-chip.js';
import './model-picker/model-picker.js';

/**
 * Popup id for the editor's model picker, so a second press on the chip
 * dismisses the picker instead of stacking a second one over it.
 */
const MODEL_PICKER_POPUP_ID = 'command-editor-model-picker';

/**
 * Run modes, in the order the segmented control offers them.
 * @type {Record<string, string>}
 */
const RUN_MODES = {
  send: markForTranslation('Send immediately'),
  draft: markForTranslation('Insert as draft'),
  subthread: markForTranslation('Run in a thread'),
};

/**
 * What each run mode actually does, shown under the control for the selected
 * one. The three labels alone say what happens to the command, not what happens
 * to the conversation, which is the part worth knowing before choosing.
 * @type {Record<string, string>}
 */
const RUN_MODE_HINTS = {
  send: markForTranslation('Expands the template and sends it as your next message.'),
  draft: markForTranslation('Puts the expanded template in the composer so you can edit it first.'),
  subthread: markForTranslation('Runs the prompt in a separate thread; the result lands back here.'),
};

/** Save destinations, in the order the segmented control offers them. */
const SCOPES = {
  project: markForTranslation('This project'),
  user: markForTranslation('All my projects'),
};

/**
 * Set of built-in / extension command ids a user command may not shadow. User
 * commands are registered in the same registry, so they are filtered out —
 * a user command may collide with (overwrite) another user command, but never
 * a built-in.
 * @returns {Set<string>} Reserved command ids
 */
function builtinCommandIds() {
  const ids = new Set();
  for (const cmd of slashCommandHandler.getCommands()) {
    if (!cmd.userDefined) ids.add(cmd.name);
  }
  return ids;
}

/**
 * Apply a command write/delete to the slash menu once the file is on disk. Only
 * the user commands are re-read — not the full registry rebuild, which waits
 * for any running turn to end — so the change is live by the time the save
 * resolves, mid-turn or not. Other clients hear of it from the server's
 * plugin-changed broadcast.
 * @returns {Promise<void>}
 */
function refreshUserCommands() {
  return commandRegistry.refreshUserCommands();
}

/**
 * @typedef {object} CommandEditorOptions
 * @property {string} [name] - Initial command name (pre-fills the name field of a new command)
 * @property {'user'|'project'} [scope] - Initial scope
 * @property {import('../services/user-commands.js').UserCommandDef|null} [def] - Existing definition when editing
 */

/**
 * @typedef {object} CommandEditorCallbacks
 * @property {(name: string, scope: 'user'|'project') => void} [onSaved] - The file was written (and any old one removed)
 * @property {(name: string) => void} [onDeleted] - The edited command's file was deleted
 */

/**
 * @typedef {object} CommandEditorHandle
 * @property {() => boolean} isDirty - Whether the form differs from what it was mounted with
 * @property {() => void} focus - Focus the first field worth typing in
 * @property {() => void} dispose - Take down what the form holds outside its container (the model picker)
 */

/**
 * Mount the command editor form into `container`, replacing its contents.
 *
 * The form holds no list and no notion of selection: saving or deleting reports
 * through the callbacks, and the page that mounted it decides what to show next.
 * @param {HTMLElement} container - Where the form is drawn
 * @param {CommandEditorOptions} [options]
 * @param {CommandEditorCallbacks} [callbacks]
 * @returns {CommandEditorHandle} Handle for the mounting page
 */
export function mountCommandEditor(container, options = {}, callbacks = {}) {
  const def = options.def || null;
  const editing = !!def;
  const fm = def?.frontmatter || {};

  // The three choices the form holds outside the DOM: the two segmented
  // controls and the model override, none of which is a form field. A file may
  // name a run mode this build does not offer, which falls back to send rather
  // than leaving the control with nothing selected.
  let run = RUN_MODES[fm.run || ''] ? /** @type {string} */ (fm.run) : 'send';
  let scope = def?.scope === 'user' || options.scope === 'user' ? 'user' : 'project';
  let modelConfig = seedModelConfig(fm);
  // Whether the user has touched the model, so a late provider list refines
  // the seed without overwriting a choice they have already made.
  let modelTouched = false;
  let disposed = false;

  container.innerHTML = buildMarkup({
    editing,
    name: def?.name ?? options.name ?? '',
    scope,
    description: fm.description ?? '',
    argsHint: fm.argsHint ?? '',
    run,
    icon: fm.icon ?? '',
    goal: fm.goal ?? '',
    template: def?.body ?? '',
  });

  const $ = (/** @type {string} */ sel) => /** @type {any} */ (container.querySelector(sel));

  // Populate the strategy picker from the live registry.
  const strategySelect = $('#cmd-strategy');
  if (strategySelect) {
    for (const { id, manifest } of strategyManifests()) {
      const opt = document.createElement('option');
      opt.value = id;
      // A strategy's name is its manifest's, in its own extension's catalogue.
      opt.textContent = manifest?.name ? capabilityLabel(manifest.name, id, strategyRegistry) : id;
      if (id === fm.strategy) opt.selected = true;
      strategySelect.appendChild(opt);
    }
  }

  const nameInput = $('#cmd-name');
  const nameError = $('#cmd-name-error');
  const templateInput = $('#cmd-template');
  const previewArgs = $('#cmd-preview-args');
  const previewOut = $('#cmd-preview-out');
  const runHint = $('#cmd-run-hint');
  const subthreadFields = $('#cmd-subthread-fields');
  const modelChip = $('#cmd-model');
  const saveBtn = $('#cmd-save');
  const pathHint = $('#cmd-path-hint');

  const reserved = builtinCommandIds();

  /**
   * The file body the form currently describes. Overrides belong to the
   * thread, so a command that does not open one writes none of them. The model
   * ref is written whole: dropping a dial here would leave a command running at
   * settings the user never chose.
   * @returns {Parameters<typeof writeUserCommand>[2]} Body for the PUT
   */
  const currentBody = () => {
    const thread = run === 'subthread';
    return {
      description: $('#cmd-description').value.trim(),
      argsHint: $('#cmd-argshint').value.trim(),
      run,
      strategy: thread ? (strategySelect?.value || '') : '',
      provider: thread ? (modelConfig?.provider || '') : '',
      model: thread ? (modelConfig?.model || '') : '',
      thinking: thread ? (modelConfig?.thinking || '') : '',
      serviceTier: thread ? (modelConfig?.serviceTier || '') : '',
      icon: $('#cmd-icon').value.trim(),
      goal: thread ? $('#cmd-goal').value.trim() : '',
      template: templateInput.value,
    };
  };

  // What the form said when it was drawn, to tell an edit from a glance. The
  // model is compared as the user chose it rather than as resolved, so a late
  // provider list refining the seed is not mistaken for an edit.
  const snapshot = () => JSON.stringify({ name: nameInput.value.trim(), scope, body: currentBody(), modelTouched });
  const pristine = snapshot();

  // ── model override: the app's standard chip + picker ──────────────────────

  const syncChip = () => {
    modelChip.update({
      providers: providersCache.getChat(),
      config: modelConfig,
      placeholder: t('Inherit from parent'),
      buttonTitle: t('Model for the thread'),
    });
  };

  const setModelConfig = (/** @type {any} */ next) => {
    modelConfig = next;
    modelTouched = true;
    syncChip();
  };

  const openModelPicker = () => {
    // Second press on the chip dismisses rather than re-opening.
    if (closePopupById(MODEL_PICKER_POPUP_ID)) return;

    const picker = /** @type {any} */ (document.createElement('model-picker'));
    picker.providers = providersCache.getChat();
    picker.value = modelConfig;
    picker.noneLabel = t('Inherit from parent');
    picker.loading = !providersCache.hasReceived();

    /** @type {(() => void)|null} */
    let release = null;
    const closePicker = () => {
      modelChip.expanded = false;
      if (release) {
        release();
        release = null;
      }
    };

    picker.addEventListener('change', (/** @type {Event} */ e) => {
      closePicker();
      setModelConfig(/** @type {CustomEvent} */ (e).detail);
    });
    picker.addEventListener('close', closePicker);

    release = presentPopup({
      surface: picker,
      anchor: modelChip.button || modelChip,
      id: MODEL_PICKER_POPUP_ID,
      onClose: closePicker,
      insideSelectors: ['model-chip', '.model-picker'],
    });
    modelChip.expanded = true;
  };

  modelChip.addEventListener('chip-toggle', openModelPicker);
  // The pill promises its mini popover, so an open picker gets out of the way
  // first — same contract as the settings rows.
  modelChip.addEventListener('mini-requested', () => closePopupById(MODEL_PICKER_POPUP_ID));
  modelChip.addEventListener('change', (/** @type {Event} */ e) => {
    setModelConfig(/** @type {CustomEvent} */ (e).detail);
  });
  syncChip();

  // A form drawn before the first provider push shows the stored reference
  // verbatim; once the list lands the label resolves, and a reference whose
  // provider had to be inferred is re-seeded — unless the user has since
  // chosen something, which their choice must survive.
  if (!providersCache.hasReceived()) {
    providersCache.waitForFirst().then(() => {
      if (disposed || !container.isConnected) return;
      if (!modelTouched && modelConfig && !modelConfig.provider) modelConfig = seedModelConfig(fm);
      syncChip();
    });
  }

  const validateName = () => {
    const v = nameInput.value.trim();
    let msg = '';
    if (!v) msg = '';
    else if (!USER_COMMAND_NAME_RE.test(v)) msg = t('Lowercase letters, digits, and hyphens; must start with a letter.');
    else if (reserved.has(v)) msg = t('"/{name}" already exists as a built-in command.', { name: v });
    nameError.textContent = msg;
    const ok = !!v && !msg;
    saveBtn.disabled = !ok;
    return ok;
  };

  const updatePreview = () => {
    const rest = previewArgs.value.trim();
    previewOut.textContent = expandTemplate(templateInput.value, rest ? rest.split(/\s+/) : [], rest);
  };

  const updateRunUI = () => {
    subthreadFields.classList.toggle('hidden', run !== 'subthread');
    const hint = RUN_MODE_HINTS[run];
    runHint.textContent = hint ? t(hint) : '';
  };

  const updatePathHint = () => {
    // A path, so only the words standing in for the parts not yet known translate.
    const project = t('<project>', undefined, { context: 'stands for the project folder in a path' });
    const dir = scope === 'user' ? '~/.juggler/commands' : `${project}/.juggler/commands`; // i18n-ignore: a path
    const nm = nameInput.value.trim() || t('name', undefined, { context: 'stands for the command name in a file name' });
    pathHint.textContent = `${dir}/${nm}.md`; // i18n-ignore: a path
  };

  nameInput.addEventListener('input', () => { validateName(); updatePathHint(); });
  templateInput.addEventListener('input', updatePreview);
  previewArgs.addEventListener('input', updatePreview);
  wireSegmented($('#cmd-run'), 'run', (value) => { run = value; updateRunUI(); });
  wireSegmented($('#cmd-scope'), 'scope', (value) => { scope = value; updatePathHint(); });

  if (editing) {
    const del = $('#cmd-delete');
    del.classList.remove('hidden');
    del.addEventListener('click', async () => {
      const ok = await showConfirm(t('Delete the /{name} command?', { name: def?.name }), t('Delete command'),
        { danger: true, confirmText: t('Delete') });
      if (!ok) return;
      await deleteUserCommand(/** @type {any} */ (def?.scope), /** @type {any} */ (def?.name));
      await refreshUserCommands();
      callbacks.onDeleted?.(/** @type {string} */ (def?.name));
    });
  }

  saveBtn.addEventListener('click', async () => {
    if (!validateName()) return;
    clearFieldErrors(container);
    const name = nameInput.value.trim();
    const savedScope = /** @type {'user'|'project'} */ (scope);
    saveBtn.disabled = true;
    const res = await writeUserCommand(savedScope, name, currentBody());
    if (res.ok) {
      // If editing renamed/rescoped, remove the old file so we don't leave a dup.
      if (editing && def && (def.name !== name || def.scope !== savedScope)) {
        await deleteUserCommand(/** @type {any} */ (def.scope), def.name);
      }
      await refreshUserCommands();
      callbacks.onSaved?.(name, savedScope);
      return;
    }
    saveBtn.disabled = false;
    if (res.status === 400 && res.data?.errors) {
      showFieldErrors(container, res.data.errors);
    } else {
      showFieldErrors(container, { template: serverText(res.data?.message, res.data?.error) || t('Could not save command.') });
    }
  });

  // Initial state.
  updateRunUI();
  updatePreview();
  updatePathHint();
  validateName();

  return {
    isDirty: () => !disposed && snapshot() !== pristine,
    focus: () => {
      // A new command starts at its name; an existing one at what it says.
      const target = editing ? templateInput : nameInput;
      focusWhenShown(target, { delay: 50 });
    },
    dispose: () => {
      disposed = true;
      // The picker lives on document.body, so it outlives the form unless it is
      // taken down with it.
      closePopupById(MODEL_PICKER_POPUP_ID);
    },
  };
}

/**
 * @returns {Array<{id: string, manifest: any}>} Strategy manifests, or empty on error
 */
function strategyManifests() {
  try {
    return strategyRegistry.getAllManifests();
  } catch {
    return [];
  }
}

/**
 * Clear any inline field-error text in the dialog.
 * @param {HTMLElement} overlay
 */
function clearFieldErrors(overlay) {
  overlay.querySelectorAll('.command-editor-field-error').forEach((el) => { el.textContent = ''; });
}

/**
 * Render server-returned field errors inline beside their inputs.
 * @param {HTMLElement} overlay
 * @param {Record<string, string>} errors - field → message
 */
function showFieldErrors(overlay, errors) {
  for (const [field, message] of Object.entries(errors)) {
    const el = overlay.querySelector(`[data-error-for="${field}"]`);
    if (el) el.textContent = message;
  }
}

/**
 * The model config a command file describes, for the chip to show.
 *
 * Prefers the resolution the command will actually run with, and falls back to
 * the stored reference verbatim when nothing can be resolved — a dialog opened
 * before the first provider push must still show (and re-save) the model the
 * file names, rather than reporting it as inherited and quietly dropping it.
 * @param {import('../services/user-commands.js').UserCommandFrontmatter} fm
 * @returns {import('../model/model-config.js').ConcreteModelConfig|null} The config, or null for inherit
 */
function seedModelConfig(fm) {
  if (!fm.model) return null;
  return resolveModelConfig(fm)
    || buildModelConfig(fm.provider || '', fm.model, fm.thinking, fm.serviceTier);
}

/**
 * One segmented control: a radiogroup of buttons, the active one carrying the
 * selection. Values are ids from a fixed table, so they need no escaping; the
 * labels are the table's English, translated here.
 * @param {string} id - Element id
 * @param {string} ariaLabel - Group label, translated
 * @param {string} attr - Data attribute holding each option's value
 * @param {Record<string, string>} options - value → label
 * @param {string} current - The selected value
 * @returns {string} HTML
 */
function segmentedHTML(id, ariaLabel, attr, options, current) {
  const segments = Object.entries(options).map(([value, label]) => {
    const active = value === current;
    return `<button type="button" class="command-editor-seg${active ? ' active' : ''}" role="radio"`
      + ` aria-checked="${active}" tabindex="${active ? 0 : -1}" data-${attr}="${value}">${escapeHtml(t(label))}</button>`;
  }).join('');
  return `<div id="${id}" class="command-editor-segmented" role="radiogroup" aria-label="${escapeHtml(ariaLabel)}">${segments}</div>`;
}

/** Arrow keys that move a radiogroup's choice, and which way. */
const SEGMENT_STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Wire a segmented control as a radiogroup: one tab stop, the checked segment.
 * A press, or an arrow key (wrapping at either end), moves the choice across the
 * group, carries focus with it from the keyboard, and reports the new value.
 * @param {HTMLElement} group - The radiogroup element
 * @param {string} attr - Data attribute holding each option's value
 * @param {(value: string) => void} onChange - Called with the newly selected value
 */
function wireSegmented(group, attr, onChange) {
  const segments = /** @type {HTMLElement[]} */ (Array.from(group.querySelectorAll('.command-editor-seg')));
  /** @param {HTMLElement} chosen */
  const choose = (chosen) => {
    for (const seg of segments) {
      const active = seg === chosen;
      seg.classList.toggle('active', active);
      seg.setAttribute('aria-checked', String(active));
      seg.tabIndex = active ? 0 : -1;
    }
    onChange(chosen.dataset[attr] || '');
  };
  group.addEventListener('click', (e) => {
    const pressed = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.command-editor-seg'));
    if (!pressed || !group.contains(pressed)) return;
    choose(pressed);
  });
  group.addEventListener('keydown', (e) => {
    const step = SEGMENT_STEPS[/** @type {keyof typeof SEGMENT_STEPS} */ (e.key)];
    const from = segments.indexOf(/** @type {HTMLElement} */ (e.target));
    if (!step || from < 0) return;
    e.preventDefault();
    const next = /** @type {HTMLElement} */ (segments[(from + step + segments.length) % segments.length]);
    choose(next);
    next.focus();
  });
}

/**
 * Build the form markup.
 * @param {{editing: boolean, name: string, scope: string, description: string, argsHint: string, run: string, icon: string, goal: string, template: string}} v
 * @returns {string} HTML
 */
function buildMarkup(v) {
  const esc = (/** @type {string} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  // Template syntax is written as the command file reads it, in every language.
  const syntax = { first: '<code>$1</code>', last: '<code>$9</code>', args: '<code>$ARGUMENTS</code>', dollars: '<code>$$</code>' }; // i18n-ignore: template syntax
  // The name field's placeholder is an example command name, an identifier.
  return `
    <form class="command-editor" aria-label="${escapeHtml(t('Command editor'))}" novalidate>
      <header class="command-editor-header">
        <h2>${v.editing ? escapeHtml(t('Edit command')) : escapeHtml(t('New command'))}</h2>
      </header>
      <div class="command-editor-body">
        <div class="command-editor-row">
          <label class="command-editor-label command-editor-name-field">${escapeHtml(t('Name'))}
            <div class="command-editor-name-row"><span class="command-editor-slash">/</span>
              <input id="cmd-name" type="text" class="field-input command-editor-input" value="${esc(v.name)}"
                autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="review-pr" /></div>
          </label>
          <label class="command-editor-label">
            <span class="command-editor-label-text">${escapeHtml(t('Args hint'))} <span class="command-editor-optional">${escapeHtml(t('(optional)'))}</span></span>
            <input id="cmd-argshint" type="text" class="field-input command-editor-input" value="${esc(v.argsHint)}" placeholder="${escapeHtml(t('<pr-number>', undefined, { context: 'example arguments hint for a command' }))}" />
          </label>
        </div>
        <div id="cmd-name-error" class="command-editor-field-error" data-error-for="name"></div>

        <label class="command-editor-label">${escapeHtml(t('Description'))}
          <input id="cmd-description" type="text" class="field-input command-editor-input" value="${esc(v.description)}"
            placeholder="${escapeHtml(t('Shown in the slash menu'))}" />
          <div class="command-editor-field-error" data-error-for="description"></div>
        </label>

        <label class="command-editor-label">${escapeHtml(t('Prompt template'))}
          <textarea id="cmd-template" class="command-editor-textarea field-input" rows="10"
            placeholder="${escapeHtml(t('Review PR {first}. {rest}', { first: '$1', rest: '$ARGUMENTS' }))}">${esc(v.template)}</textarea>
          <div class="command-editor-field-error" data-error-for="template"></div>
          <div class="command-editor-hint">${withHtml(t('Placeholders: {first}…{last}, {args}, {dollars} for a literal $.', htmlSlots(syntax)), syntax)}</div>
        </label>

        <div class="command-editor-preview surface-well">
          <div class="command-editor-preview-head">
            <span class="command-editor-preview-title">${escapeHtml(t('Preview'))}</span>
            <input id="cmd-preview-args" type="text" class="field-input command-editor-input command-editor-preview-args"
              placeholder="${escapeHtml(t('sample args'))}" aria-label="${escapeHtml(t('Sample arguments for the preview'))}" />
          </div>
          <pre id="cmd-preview-out" class="command-editor-preview-out"></pre>
        </div>

        <div class="command-editor-field">
          <div class="command-editor-label-text">${escapeHtml(t('When invoked'))}</div>
          ${segmentedHTML('cmd-run', t('Run mode'), 'run', RUN_MODES, v.run)}
          <div id="cmd-run-hint" class="command-editor-run-hint"></div>
        </div>

        <div id="cmd-subthread-fields" class="command-editor-subthread hidden">
          <div class="command-editor-hint">${escapeHtml(t('Applied to the thread only. Anything left inherited follows this conversation.'))}</div>
          <label class="command-editor-label">${escapeHtml(t('Thread goal'))}
            <input id="cmd-goal" type="text" class="field-input command-editor-input" value="${esc(v.goal)}" placeholder="${escapeHtml(t('PR review'))}" />
          </label>
          <label class="command-editor-label">${escapeHtml(t('Strategy'))}
            <select id="cmd-strategy" class="command-editor-select field-input"><option value="">${escapeHtml(t('Inherit from parent'))}</option></select>
          </label>
          <div class="command-editor-label">
            <span class="command-editor-label-text">${escapeHtml(t('Model'))}</span>
            <model-chip id="cmd-model"></model-chip>
          </div>
        </div>

        <input id="cmd-icon" type="hidden" value="${esc(v.icon)}" />
      </div>
      <footer class="command-editor-footer">
        <div class="command-editor-target">
          ${segmentedHTML('cmd-scope', t('Where to save'), 'scope', SCOPES, v.scope === 'user' ? 'user' : 'project')}
          <div id="cmd-path-hint" class="command-editor-path"></div>
        </div>
        <div class="command-editor-actions">
          <button type="button" id="cmd-delete" class="modal-button btn-danger hidden">${escapeHtml(t('Delete'))}</button>
          <button type="button" id="cmd-save" class="modal-button btn-primary">${escapeHtml(t('Save'))}</button>
        </div>
      </footer>
    </form>
  `;
}
