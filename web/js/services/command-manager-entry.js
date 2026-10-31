//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The pinned "Browse/edit slash commands…" button above a command list, shared
 * by every surface that lists slash commands: the typed-`/` completion menu and
 * the composer's `/` button dropdown. The dropdown also takes its command order
 * and row builder from here.
 *
 * That a user can write their own commands is not something a list of commands
 * conveys — `/commands` sitting among them reads as one more command to run, not
 * as the way in. Each surface therefore pins the button above its list and
 * drops the plain `/commands` row, since the button IS that command: two rows
 * for one action would be worse than none. It opens the Slash commands settings
 * page, where the built-ins and the user's own are listed together.
 * @module services/command-manager-entry
 */

import { markForTranslation, t } from '../../sdk/lib/i18n.js';

/** Id of the built-in command that opens the Slash commands settings page. */
export const MANAGER_COMMAND_ID = 'commands';

/** Id of that settings page, for `openSettings`. */
export const COMMANDS_SETTINGS_TAB = 'commands';

/** Label of the button opening the Slash commands settings page. */
const COMMANDS_SETTINGS_LABEL = markForTranslation('Browse/edit slash commands…');

/**
 * A command's own text (its label or description) in the user's language. A
 * built-in's is its extension's English, looked up in that extension's
 * catalogue; a user-defined command's is whatever its author wrote, shown as
 * written.
 * @param {{userDefined?: boolean, extensionId?: string}} cmd - The command
 * @param {string} text - Its label or description
 * @returns {string} The text to show
 */
export function commandText(cmd, text) {
  return cmd.userDefined ? text : t(text, undefined, { namespace: cmd.extensionId });
}

/**
 * The fixed lead of the button-opened command lists: tab operations first (new,
 * duplicate), then thread, then conversation-history operations (clear,
 * compact). Everything else follows in the order it was registered.
 */
const MENU_ORDER = ['new', 'duplicate', 'thread', 'clear', 'compact'];

/**
 * The commands a button-opened list shows, in its order: `/commands` dropped
 * (its pinned button stands in for it) and {@link MENU_ORDER} leading.
 * The composer's `/` dropdown lists in this order.
 * @template {{name: string}} T
 * @param {T[]} commands - Commands as the handler reports them
 * @returns {T[]} A new, ordered list
 */
export function menuOrderedCommands(commands) {
  const rank = (/** @type {string} */ name) => {
    const i = MENU_ORDER.indexOf(name);
    return i === -1 ? MENU_ORDER.length : i;
  };
  return withoutManagerCommand(commands).sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * Build one command row of a button-opened list: the mono `/name`, then its
 * label (or the name capitalised). The caller owns the click wiring, since each
 * surface dismisses itself differently.
 * @param {{name: string, label?: string, danger?: boolean, userDefined?: boolean, extensionId?: string}} cmd - The command
 * @param {object} [opts]
 * @param {string} [opts.extraClass] - Surface-specific class alongside `menu-item`
 * @param {string} [opts.labelClass] - Class of the label span
 * @returns {HTMLLIElement} The row element
 */
export function buildCommandRow(cmd, { extraClass = '', labelClass = 'menu-item-desc' } = {}) {
  const row = document.createElement('li');
  row.className = ['menu-item', extraClass, cmd.danger ? 'danger' : ''].filter(Boolean).join(' ');
  row.dataset.command = cmd.name;

  const code = document.createElement('code');
  code.textContent = '/' + cmd.name;
  row.appendChild(code);

  const label = document.createElement('span');
  label.className = labelClass;
  label.textContent = cmd.label ? commandText(cmd, cmd.label) : cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
  row.appendChild(label);

  return row;
}

/**
 * A command list with `/commands` removed — for surfaces showing the pinned
 * button in its place.
 * @template {{name: string}} T
 * @param {T[]} commands - Commands to filter
 * @returns {T[]} The list without the manager command
 */
export function withoutManagerCommand(commands) {
  return commands.filter((c) => c.name !== MANAGER_COMMAND_ID);
}

/**
 * Build the "Browse/edit slash commands…" row: the label alone, with no `/`
 * glyph. The other rows earn their slash by being the command you type; this is
 * a button, and a bare `/` beside it only reads as a command name that went
 * missing. The caller owns the click wiring, since each surface dismisses itself
 * differently.
 * @param {string} [extraClass] - Surface-specific class alongside the shared ones
 * @returns {HTMLLIElement} The row element
 */
export function buildCommandsSettingsRow(extraClass = '') {
  const row = document.createElement('li');
  row.className = ('menu-item slash-command-pinned ' + extraClass).trim();
  row.dataset.command = MANAGER_COMMAND_ID;

  const text = document.createElement('span');
  text.className = 'slash-command-pinned-label';
  text.textContent = t(COMMANDS_SETTINGS_LABEL);
  row.appendChild(text);

  return row;
}
