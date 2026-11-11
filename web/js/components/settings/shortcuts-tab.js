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

import keyShortcutManager, { isMac } from '../../services/key-shortcut-manager.js';
import { buildEscapeBehaviourRow } from '../../services/escape-behaviour.js';
import { t } from '../../../sdk/lib/i18n.js';

/** Category the Escape-behaviour row is appended to (home of the Pause chord). */
const ESCAPE_ROW_CATEGORY = 'Conversations';

/**
 * Keyboard shortcuts tab: every command from the KeyShortcutManager, grouped by
 * category, each showing its current binding for this platform. The manager is
 * the single source of truth, so this needs no server fetch — it renders eagerly
 * from the shell's render() and has no pollers or listeners of its own. The
 * manager's labels, descriptions and categories are English source text (the
 * AboutJuggler corpus reads them as they are); they are translated here.
 */
export class ShortcutsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderShortcutsForm();
  }

  /**
   * Element disconnected: nothing to release. The rows are drawn once from the
   * shortcut manager and take no listeners, timers or subscriptions of their
   * own; the Escape row's controls are on elements inside `#shortcuts-form`.
   */
  dispose() {}

  /**
   * Render the Keyboard shortcuts tab: every command from the KeyShortcutManager,
   * grouped by category, each showing its current binding for this platform. The
   * manager is the single source of truth, so this needs no server fetch. Rows are
   * read-only for now; each one's `.provider-control` is where a future "record
   * binding" affordance will live.
   *
   * Escape is the exception, and isn't a manager command at all: it's a ladder of
   * meanings (dismiss ▸ cancel an edit ▸ stop the turn ▸ clear the prompt) rather
   * than one command, and its last two rungs are already configurable. Its row is
   * built by the module that owns that behaviour and joined onto the same category
   * as the Pause chord it trades places with.
   * @private
   */
  renderShortcutsForm() {
    const container = this.host.querySelector('#shortcuts-form');
    if (!container) return;
    container.innerHTML = '';

    for (const group of keyShortcutManager.byCategoryForPlatform(isMac())) {
      const heading = document.createElement('h3');
      heading.className = 'settings-section-heading caps-label-lg';
      heading.textContent = t(group.category);
      container.appendChild(heading);

      for (const def of group.shortcuts) {
        container.appendChild(this._buildShortcutRow(def));
      }

      if (group.category === ESCAPE_ROW_CATEGORY) container.appendChild(buildEscapeBehaviourRow());
    }
  }

  /**
   * Build one shortcut row: label + description on the left, the current key(s)
   * on the right as `<kbd>`s — a command with an alias (⌘N and ⌥N for a new
   * conversation) shows every key that triggers it, since the alias exists
   * precisely because the primary chord is unreachable on some surfaces.
   * @param {import('../../services/key-shortcut-manager.js').ShortcutDef} def - The shortcut definition.
   * @returns {HTMLElement} The row element.
   * @private
   */
  _buildShortcutRow(def) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field shortcut-row';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = t(def.label);
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = t(def.description);
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control shortcut-control';
    for (const combo of keyShortcutManager.formatBindings(def.id)) {
      const key = document.createElement('kbd');
      key.className = 'shortcut-keycap';
      key.textContent = combo;
      ctrl.appendChild(key);
    }

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }
}
