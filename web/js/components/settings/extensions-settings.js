//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extensionConfigGet, extensionConfigSet } from '../../services/ops-api.js';
import { showConfirm } from '../modal-dialog.js';
import { t, htmlSlots, withHtml } from '../../../sdk/lib/i18n.js';
import { errorText } from '../../../sdk/lib/error-utils.js';

/** @typedef {import('../../services/extensions.js').ExtensionSetting} ExtensionSetting */

/**
 * Validate and decode one setting control's raw value for extensionConfigSet.
 * Optional blank URL, number, and enum controls clear the stored value.
 * @param {ExtensionSetting} setting
 * @param {string|boolean} rawValue
 * @param {string} [namespace] - The extension id, whose catalogue translates the label.
 * @returns {string|number|boolean|null} Decoded value suitable for the config operation
 */
export function decodeExtensionSettingValue(setting, rawValue, namespace) {
  if (setting.type === 'boolean') return !!rawValue;
  const value = String(rawValue);
  const label = t(setting.label, undefined, { namespace });
  if (setting.required && value.trim() === '') {
    throw new Error(t('{label} is required.', { label }));
  }
  if (setting.type === 'number') {
    if (value.trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(t('{label} must be a finite number.', { label }));
    return number;
  }
  if (setting.type === 'url') {
    if (value.trim() === '') return null;
    try {
      const url = new URL(value);
      if (!url.protocol || !url.host) throw new Error();
    } catch {
      throw new Error(t('{label} must be an absolute URL.', { label }));
    }
  }
  if (setting.type === 'enum') {
    if (value === '') return null;
    if (!setting.options?.includes(value)) {
      throw new Error(t('{label} must be one of the available options.', { label }));
    }
  }
  return value;
}

/**
 * What a capability wants a `text` setting to show for the form's current
 * values (see {@link ExtensionSettingsEditor}'s `view` option):
 *   - `preview` — show this text read-only in place of the setting's value,
 *     because the value is not in effect (e.g. the built-in policy a preset
 *     uses). The stored value is kept aside, untouched, and is what gets saved.
 *   - `seed` — when the field is editable and blank, start it from this text.
 *     A field that was just showing a preview is seeded from that preview
 *     instead, so switching from a preset to "custom" starts from that preset.
 *   - `note` — one line shown under the field.
 * @typedef {{preview?: string, seed?: string, note?: string}} SettingView
 */

/**
 * Generic manifest-driven settings editor embedded in an extension's catalog
 * detail. The injected operations keep the DOM behavior unit-testable without
 * writing the user's real configuration.
 */
export class ExtensionSettingsEditor {
  /**
   * @param {import('../../services/extensions.js').ExtensionManifest} manifest
   * @param {{get?: typeof extensionConfigGet, set?: typeof extensionConfigSet}} [operations]
   * @param {{capability?: string, view?: (values: Record<string, unknown>) => Record<string, SettingView>|null|undefined}} [options] -
   *   `capability` (`<itemType>:<id>`) limits the editor to the settings
   *   declared for that capability, for its own page; omitted, every setting of
   *   the extension is shown. `view` is consulted whenever a value changes and
   *   says what each `text` setting should show (a capability's static
   *   `settingsView`).
   */
  constructor(manifest, operations = {}, options = {}) {
    this.manifest = manifest;
    this.getConfig = operations.get || extensionConfigGet;
    this.setConfig = operations.set || extensionConfigSet;
    this.capability = options.capability || '';
    this.view = options.view || null;
    /**
     * The real values of fields currently showing a read-only preview.
     * @type {Record<string, string>}
     */
    this.held = {};
    /**
     * The last preview each field showed, to seed it when it becomes editable.
     * @type {Record<string, string>}
     */
    this.lastPreview = {};
    /** @type {ExtensionSetting[]} */
    this.settings = (manifest.settings || [])
      .filter((setting) => !this.capability || setting.capability === this.capability);
    /** @type {HTMLElement|null} */
    this.root = null;
    /** @type {Record<string, HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>} */
    this.controls = {};
    /** @type {Record<string, boolean>} */
    this.secretPresence = {};
  }

  /**
   * Text the manifest supplied — its name, a setting's label, help or option —
   * translated by this extension's own catalogue first, then core's, never
   * another extension's.
   * @param {string} text - The English.
   * @returns {string} The text in the UI language.
   * @private
   */
  _text(text) {
    return t(text, undefined, { namespace: this.manifest.id });
  }

  /**
   * @returns {HTMLElement} The settings section
   */
  render() {
    const section = document.createElement('section');
    section.className = 'plugin-section extension-settings';
    this.root = section;

    const header = document.createElement('header');
    header.className = 'plugin-section-header';
    const title = document.createElement('h5');
    title.className = 'plugin-section-title';
    title.textContent = t('Settings');
    const explanation = document.createElement('div');
    explanation.className = 'plugin-section-explanation';
    // The paths are file names, not words, so they sit in slots as <code>.
    const markup = {
      configDir: '<code>~/.juggler/extension-config</code>',
      credentials: '<code>~/.juggler/credentials.json</code>',
    };
    explanation.innerHTML = this.capability
      ? withHtml(t('Global settings, stored with the {name} extension\'s settings under {configDir}.',
        htmlSlots(markup, { name: this.manifest.name ? this._text(this.manifest.name) : this.manifest.id })), markup)
      : withHtml(t('Global settings for this extension. Non-secret values are stored under {configDir}; secrets are stored masked in {credentials} and are never shown here.',
        htmlSlots(markup)), markup);
    header.append(title, explanation);
    section.appendChild(header);

    const form = document.createElement('form');
    form.className = 'extension-settings-form';
    form.noValidate = true;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._saveNonSecrets();
    });
    for (const setting of this.settings) {
      form.appendChild(this._renderField(setting));
    }

    const actions = document.createElement('div');
    actions.className = 'extension-settings-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-sm btn-primary extension-settings-save';
    save.textContent = t('Save settings');
    actions.appendChild(save);
    form.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'extension-settings-message';
    status.setAttribute('role', 'status');
    form.appendChild(status);
    section.appendChild(form);
    this._setBusy(true);
    this._load();
    return section;
  }

  /**
   * @param {ExtensionSetting} setting - Field descriptor
   * @returns {HTMLElement} Rendered field row
   */
  _renderField(setting) {
    const row = document.createElement('div');
    row.className = `extension-setting-field surface-card extension-setting-${setting.type}`;
    // A multi-line value needs the row's full width.
    if (setting.type === 'text') row.classList.add('extension-setting-wide');
    row.dataset.settingKey = setting.key;

    const info = document.createElement('div');
    info.className = 'extension-setting-info';
    const label = document.createElement('label');
    label.className = 'extension-setting-label';
    label.htmlFor = this._inputId(setting.key);
    label.textContent = this._text(setting.label);
    if (setting.required) {
      const required = document.createElement('span');
      required.className = 'extension-setting-required';
      required.textContent = t('required');
      label.appendChild(required);
    }
    info.appendChild(label);
    if (setting.help) {
      const help = document.createElement('div');
      help.className = 'extension-setting-help';
      help.textContent = this._text(setting.help);
      info.appendChild(help);
    }
    if (Object.hasOwn(setting, 'default')) {
      const defaultText = document.createElement('div');
      defaultText.className = 'extension-setting-default';
      // An enum default is one of the options, shown by its label like the rest.
      const value = setting.type === 'enum' ? this._text(String(setting.default)) : String(setting.default);
      defaultText.textContent = t('Default: {value}', { value });
      info.appendChild(defaultText);
    }
    row.appendChild(info);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'extension-setting-control';
    const control = this._createControl(setting);
    this.controls[setting.key] = control;
    controlWrap.appendChild(control);
    if (setting.type === 'secret') this._appendSecretControls(setting, controlWrap, control);
    if (this.view) {
      control.addEventListener('change', () => this._refreshViews(false));
      if (setting.type === 'text') {
        const note = document.createElement('div');
        note.className = 'extension-setting-help extension-setting-view-note';
        note.hidden = true;
        controlWrap.appendChild(note);
      }
    }
    row.appendChild(controlWrap);
    return row;
  }

  /**
   * @param {ExtensionSetting} setting - Field descriptor
   * @returns {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} Input for the field type
   */
  _createControl(setting) {
    if (setting.type === 'text') {
      const textarea = document.createElement('textarea');
      textarea.id = this._inputId(setting.key);
      textarea.className = 'settings-input field-input extension-setting-input extension-setting-textarea';
      textarea.spellcheck = false;
      textarea.rows = 6;
      textarea.required = !!setting.required;
      return textarea;
    }
    if (setting.type === 'enum') {
      const select = document.createElement('select');
      select.className = 'settings-select field-input extension-setting-input';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = setting.required ? t('Choose an option') : t('Use default');
      select.appendChild(blank);
      for (const option of setting.options || []) {
        const el = document.createElement('option');
        // The value is what is stored; only the label shown follows the language.
        el.value = option;
        el.textContent = this._text(option);
        select.appendChild(el);
      }
      select.id = this._inputId(setting.key);
      select.required = !!setting.required;
      return select;
    }

    const input = document.createElement('input');
    input.id = this._inputId(setting.key);
    input.className = 'settings-input field-input extension-setting-input';
    input.required = !!setting.required;
    input.autocomplete = 'off';
    if (setting.type === 'boolean') {
      input.type = 'checkbox';
      input.className = 'extension-setting-checkbox';
    } else if (setting.type === 'number') {
      input.type = 'number';
      input.step = 'any';
    } else if (setting.type === 'url') {
      input.type = 'url';
      input.placeholder = 'https://example.com'; // i18n-ignore: an example address
      input.spellcheck = false;
    } else if (setting.type === 'secret') {
      input.type = 'password';
      input.placeholder = t('Enter a new value');
      input.autocomplete = 'new-password';
      input.spellcheck = false;
    } else {
      input.type = 'text';
    }
    return input;
  }

  /**
   * @param {ExtensionSetting} setting
   * @param {HTMLElement} wrap
   * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} control
   */
  _appendSecretControls(setting, wrap, control) {
    const status = document.createElement('span');
    status.className = 'extension-secret-status';
    status.textContent = t('Not set');
    wrap.appendChild(status);

    const buttons = document.createElement('div');
    buttons.className = 'extension-secret-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-sm btn-primary';
    save.textContent = t('Save');
    save.addEventListener('click', () => this._saveSecret(setting, String(control.value)));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-sm btn-danger extension-secret-clear';
    clear.textContent = t('Clear');
    clear.disabled = !!setting.required;
    if (setting.required) clear.title = t('Required settings cannot be cleared');
    clear.addEventListener('click', () => this._saveSecret(setting, ''));
    buttons.append(save, clear);
    wrap.appendChild(buttons);
  }

  async _load() {
    try {
      const values = await this.getConfig({ extId: this.manifest.id });
      this._applyValues(values || {});
      this._message('');
    } catch (error) {
      this._message(this._errorMessage(error, t('Failed to load extension settings.')), true);
    } finally {
      this._setBusy(false);
    }
  }

  /** @param {Record<string, any>} values */
  _applyValues(values) {
    // Freshly loaded values replace whatever was held behind a preview.
    this.held = {};
    for (const setting of this.settings) {
      const control = this.controls[setting.key];
      if (!control) continue;
      if (setting.type === 'text') /** @type {HTMLTextAreaElement} */ (control).readOnly = false;
      const value = values[setting.key];
      if (setting.type === 'secret') {
        const present = !!value?.__present;
        this.secretPresence[setting.key] = present;
        control.value = '';
        const row = control.closest('.extension-setting-field');
        const status = row?.querySelector('.extension-secret-status');
        if (status) status.textContent = present ? t('Set') : t('Not set');
        const clear = /** @type {HTMLButtonElement|null} */ (row?.querySelector('.extension-secret-clear'));
        if (clear && !setting.required) clear.disabled = !present;
      } else if (setting.type === 'boolean') {
        /** @type {HTMLInputElement} */ (control).checked = value === true;
      } else {
        control.value = value === undefined || value === null ? '' : String(value);
      }
    }
    this._refreshViews(true);
  }

  /**
   * The form's values as the user currently has them — a field showing a
   * preview contributes its held real value, never the preview text.
   * @returns {Record<string, unknown>} Values keyed by setting key (secrets omitted)
   */
  _currentValues() {
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const setting of this.settings) {
      const control = this.controls[setting.key];
      if (!control || setting.type === 'secret') continue;
      if (Object.hasOwn(this.held, setting.key)) values[setting.key] = this.held[setting.key];
      else if (setting.type === 'boolean') values[setting.key] = /** @type {HTMLInputElement} */ (control).checked;
      else values[setting.key] = control.value;
    }
    return values;
  }

  /**
   * Apply the `view` hook's answer to every `text` field: swap a preview in
   * (holding the real value aside) or out (restoring it, or seeding a blank
   * one), and show its note. A throwing hook leaves the form as it is — it is
   * a display aid, and the plain editable field is always a correct fallback.
   * @param {boolean} [loaded] - The values were just loaded, so blank fields may be seeded
   */
  _refreshViews(loaded = false) {
    if (!this.view) return;
    /** @type {Record<string, SettingView>} */
    let views;
    try {
      views = this.view(this._currentValues()) || {};
    } catch (error) {
      console.warn('[extension-settings] settings view failed:', error);
      return;
    }
    for (const setting of this.settings) {
      if (setting.type !== 'text') continue;
      const control = /** @type {HTMLTextAreaElement|undefined} */ (this.controls[setting.key]);
      if (!control) continue;
      const view = views[setting.key] || {};
      const previewing = Object.hasOwn(this.held, setting.key);
      if (typeof view.preview === 'string') {
        if (!previewing) this.held[setting.key] = control.value;
        control.value = view.preview;
        control.readOnly = true;
        this.lastPreview[setting.key] = view.preview;
      } else {
        if (previewing) {
          control.value = this.held[setting.key] ?? '';
          delete this.held[setting.key];
          control.readOnly = false;
        }
        // Seed only as the field opens up (on load, or leaving a preview) — a
        // user who clears it on purpose must not have it refilled under them.
        if ((previewing || loaded) && control.value.trim() === '') {
          control.value = this.lastPreview[setting.key] ?? view.seed ?? '';
        }
      }
      const note = /** @type {HTMLElement|null} */ (control.parentElement?.querySelector('.extension-setting-view-note'));
      if (note) {
        note.textContent = view.note || '';
        note.hidden = !view.note;
      }
    }
  }

  async _saveNonSecrets() {
    /** @type {Record<string, string|number|boolean|null|{__present: true}>} */
    const values = {};
    try {
      for (const setting of this.settings) {
        const control = this.controls[setting.key];
        if (!control) continue;
        if (setting.type === 'secret') {
          values[setting.key] = this.secretPresence[setting.key] ? { __present: true } : '';
          continue;
        }
        // A field showing a preview saves the value held behind it — the
        // preview is display only and must never become the stored value.
        const raw = Object.hasOwn(this.held, setting.key)
          ? this.held[setting.key] ?? ''
          : setting.type === 'boolean'
            ? /** @type {HTMLInputElement} */ (control).checked
            : control.value;
        values[setting.key] = decodeExtensionSettingValue(setting, raw, this.manifest.id);
      }
    } catch (error) {
      this._message(this._errorMessage(error, t('Check the highlighted settings.')), true);
      return;
    }
    await this._save(values, t('Settings saved.'));
  }

  /**
   * @param {ExtensionSetting} setting - Secret field descriptor
   * @param {string} value - New secret, or blank to clear it
   */
  async _saveSecret(setting, value) {
    const label = this._text(setting.label);
    if (value === '' && !this.secretPresence[setting.key]) {
      this._message(t('{label} is not set.', { label }), true);
      return;
    }
    if (value === '' && setting.required) {
      this._message(t('{label} is required and cannot be cleared.', { label }), true);
      return;
    }
    if (value === '') {
      const confirmed = await showConfirm(t('Clear {label}?', { label }), t('Clear extension secret'), { danger: true });
      if (!confirmed) return;
    }
    await this._save({ [setting.key]: value }, value ? t('{label} saved.', { label }) : t('{label} cleared.', { label }));
  }

  /**
   * @param {Record<string, any>} values - Partial values to update
   * @param {string} successMessage - Feedback shown after the update
   */
  async _save(values, successMessage) {
    this._setBusy(true);
    this._message(t('Saving…'));
    try {
      const result = await this.setConfig({ extId: this.manifest.id, values, scope: 'global' });
      this._applyValues(result || {});
      this._message(successMessage);
    } catch (error) {
      this._message(this._errorMessage(error, t('Failed to save extension settings.')), true);
    } finally {
      this._setBusy(false);
    }
  }

  /** @param {boolean} busy */
  _setBusy(busy) {
    this.root?.querySelectorAll('input, select, textarea, button').forEach((element) => {
      /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement} */ (element).disabled = busy;
    });
    if (!busy) {
      for (const setting of this.settings) {
        if (setting.type !== 'secret' || setting.required) continue;
        const control = this.controls[setting.key];
        const clear = /** @type {HTMLButtonElement|null} */ (control?.closest('.extension-setting-field')?.querySelector('.extension-secret-clear'));
        if (clear) clear.disabled = !this.secretPresence[setting.key];
      }
    }
  }

  /**
   * @param {string} message - Status text
   * @param {boolean} [error] - Whether to use error styling
   */
  _message(message, error = false) {
    const el = this.root?.querySelector('.extension-settings-message');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', error);
  }

  /**
   * @param {unknown} error - Caught operation error
   * @param {string} fallback - Message for non-Error failures
   * @returns {string} Useful user-facing message
   */
  _errorMessage(error, fallback) {
    return error instanceof Error && error.message ? errorText(error) : fallback;
  }

  /**
   * @param {string} key - Manifest setting key
   * @returns {string} DOM-safe input id
   */
  _inputId(key) {
    return `extension-setting-${this.manifest.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${key}`;
  }
}
