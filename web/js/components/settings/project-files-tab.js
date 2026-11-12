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
import { buildToggleRow } from './notifications-tab.js';

/**
 * Project files tab: the one switch that keeps each project's local state —
 * conversations, session, bash output, memory, sandboxes — outside the
 * project (`projects.stateOutside` in settings.json), and a line saying where
 * this project's state is. Placement only changes when a project's session
 * starts, so the line also says when the setting is waiting on a reopen.
 */
export class ProjectFilesTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {boolean} @private — the setting as last stored. */
    this._wanted = false;
    /** @type {HTMLInputElement|null} @private */
    this._input = null;
    /** @type {{stateDir: string, outside: boolean, outsideDir: string, byEnv: boolean}|null} @private */
    this._state = null;
  }

  /** Build the static tab DOM and wire its listener. */
  render() {
    const container = this.host.querySelector('#project-files-form');
    if (!container) return;
    container.innerHTML = '';
    const { row, input } = buildToggleRow(
      t('Keep project state outside the project'),
      t('Store conversations, bash output, memory and sandboxes in a folder of their own instead of the project’s .juggler folder. Files meant to be committed, like env.json, commands and skills, stay in the project.'),
      this._wanted,
      (on) => void this._setWanted(on),
    );
    this._input = input;
    container.appendChild(row);

    const where = document.createElement('div');
    where.className = 'settings-group provider-field';
    const info = document.createElement('div');
    info.className = 'provider-info';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.id = 'project-files-where';
    info.appendChild(desc);
    where.appendChild(info);
    container.appendChild(where);
  }

  /** Tab became visible: fetch where this project's state is. */
  show() {
    void this._loadState();
  }

  /** Nothing to release: its listener is on DOM that goes with the panel. */
  dispose() {}

  /**
   * The settings document changed, here or in another window.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    this._wanted = !!(settings.projects && settings.projects.stateOutside);
    if (this._input) this._input.checked = this._wanted;
    this._renderWhere();
  }

  /** @private */
  async _loadState() {
    this._state = await settingsApi.getProjectState({ fallback: null });
    this._renderWhere();
  }

  /**
   * Persist the switch, reverting it on failure.
   * @private
   * @param {boolean} on
   */
  async _setWanted(on) {
    const prev = this._wanted;
    this._wanted = on;
    this._renderWhere();
    try {
      const data = await settingsApi.updateSettings({ projects: { stateOutside: on } });
      this._wanted = !!(data && data.projects && data.projects.stateOutside);
    } catch (err) {
      this._wanted = prev;
      this._setWhere(t('Couldn’t save the setting ({error}).', { error: errorText(err) }));
      if (this._input) this._input.checked = prev;
      return;
    }
    if (this._input) this._input.checked = this._wanted;
    this._renderWhere();
  }

  /** @private */
  _renderWhere() {
    const s = this._state;
    if (!s) {
      this._setWhere('');
      return;
    }
    if (this._input) this._input.disabled = s.byEnv;
    if (s.byEnv) {
      this._setWhere(t('JUGGLER_STATE_DIR is set, so this project’s state is kept in {path}.', { path: s.outsideDir }));
      return;
    }
    if (s.outside === this._wanted) {
      this._setWhere(t('This project’s state is in {path}.', { path: s.stateDir }));
      return;
    }
    this._setWhere(this._wanted
      ? t('This project’s state moves to {path} the next time the project is opened.', { path: s.outsideDir })
      : t('This project’s state moves back into the project’s .juggler folder the next time the project is opened.'));
  }

  /**
   * @private
   * @param {string} text
   */
  _setWhere(text) {
    const el = this.host.querySelector('#project-files-where');
    if (el) el.textContent = text;
  }
}
