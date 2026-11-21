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

import * as settingsApi from '../../services/settings-api.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { t } from '../../../sdk/lib/i18n.js';

/** The ages offered by name, in days. Anything else is Custom. */
const PRESET_DAYS = [7, 30, 90];

/** The longest age the server accepts (core.MaxTransactionMaxAgeDays). */
const MAX_DAYS = 3650;

/**
 * The transaction records row of the Project files tab: how many days a
 * conversation's transaction records are kept before they are deleted
 * (`projects.transactionMaxAgeDays` in settings.json; 0 keeps them). A picker
 * offers Never, 7, 30 and 90 days, and Custom, which reveals a days field that
 * saves on Enter or blur. The owning tab draws it into its container and
 * forwards the settings document to it.
 */
export class TransactionRecordsSetting {
  constructor() {
    /** @type {number} @private — the age as last stored, in days; 0 keeps records. */
    this._days = 0;
    /** @type {HTMLSelectElement|null} @private */
    this._select = null;
    /** @type {HTMLInputElement|null} @private */
    this._input = null;
    /** @type {HTMLElement|null} @private */
    this._customRow = null;
    /** @type {HTMLElement|null} @private */
    this._status = null;
  }

  /**
   * Draw the row into container.
   * @param {Element} container - Where the row goes.
   */
  render(container) {
    const box = document.createElement('div');
    box.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = t('Delete old transaction records');
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = t('Juggler keeps a record of each request it sends to the model: the reply, token counts, timing and the model used, and for recent requests the full request itself. The transaction view in the Properties panel shows them. Deleting old records frees disk space, but those requests can no longer be inspected and their token counts no longer show. Your conversations are not affected: every message stays, and the newest record of each thread is always kept. Applies when a conversation is opened.');
    info.append(name, desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'settings-select field-input';
    select.setAttribute('aria-label', t('Delete old transaction records'));
    const options = [
      { value: '0', label: t('Never') },
      ...PRESET_DAYS.map((days) => ({
        value: String(days),
        label: t('{days, plural, one {Older than # day} other {Older than # days}}', { days }),
      })),
      { value: 'custom', label: t('Custom…') },
    ];
    for (const { value, label } of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => void this._onPick());
    ctrl.appendChild(select);

    const customRow = document.createElement('div');
    customRow.className = 'txn-age-custom-row';
    customRow.hidden = true;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(MAX_DAYS);
    input.step = '1';
    input.className = 'field-input field-input-sm';
    input.placeholder = t('Days');
    input.setAttribute('aria-label', t('Delete records older than this many days'));
    // Committed on Enter or blur, so a number half typed is not saved per key.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this._commitCustom(); }
    });
    input.addEventListener('blur', () => void this._commitCustom());
    customRow.appendChild(input);
    ctrl.appendChild(customRow);
    // Outside the Custom row: a preset that fails to save reports here too.
    const status = document.createElement('div');
    status.className = 'provider-description txn-age-status';
    ctrl.appendChild(status);

    box.append(info, ctrl);
    container.appendChild(box);

    this._select = select;
    this._input = input;
    this._customRow = customRow;
    this._status = status;
    this._reflect();
  }

  /**
   * The settings document arrived or changed, here or in another window. The
   * controls are left alone while one of them has focus, so a number being
   * typed is not taken away; the stored value is kept for the next reflect.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    this._days = Number(settings?.projects?.transactionMaxAgeDays) || 0;
    const active = document.activeElement;
    if (active && (active === this._select || active === this._input)) return;
    this._reflect();
  }

  /**
   * Show the stored age: a preset by name, anything else as Custom with its
   * number in the field.
   * @private
   */
  _reflect() {
    if (!this._select || !this._input) return;
    const preset = this._days === 0 || PRESET_DAYS.includes(this._days);
    this._select.value = preset ? String(this._days) : 'custom';
    this._input.value = preset ? '' : String(this._days);
    this._setStatus('');
    this._syncCustomRow();
  }

  /** @private */
  _syncCustomRow() {
    if (this._customRow && this._select) this._customRow.hidden = this._select.value !== 'custom';
  }

  /**
   * A pick on the picker: a preset saves at once; Custom reveals the field
   * and saves once it holds a usable number.
   * @private
   */
  async _onPick() {
    this._syncCustomRow();
    if (!this._select) return;
    if (this._select.value === 'custom') {
      this._input?.focus();
      return;
    }
    await this._save(Number(this._select.value));
  }

  /**
   * Save the Custom field, if it holds a whole number of days in range.
   * @private
   */
  async _commitCustom() {
    if (!this._select || !this._input || this._select.value !== 'custom') return;
    const raw = this._input.value.trim();
    if (raw === '') return;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      this._setStatus(t('Enter a whole number of days from 1 to {max}.', { max: MAX_DAYS }));
      return;
    }
    if (days === this._days) return;
    await this._save(days);
  }

  /**
   * Persist the age, putting the controls back as they were stored on failure.
   * @private
   * @param {number} days - Days to keep records; 0 keeps them for good.
   */
  async _save(days) {
    const prev = this._days;
    this._days = days;
    try {
      const data = await settingsApi.updateSettings({ projects: { transactionMaxAgeDays: days } });
      this._days = Number(data?.projects?.transactionMaxAgeDays) || 0;
      this._reflect();
    } catch (err) {
      this._days = prev;
      this._reflect();
      this._setStatus(t('Couldn’t save the setting ({error}).', { error: errorText(err) }));
    }
  }

  /**
   * @private
   * @param {string} text
   */
  _setStatus(text) {
    if (this._status) this._status.textContent = text;
  }
}
