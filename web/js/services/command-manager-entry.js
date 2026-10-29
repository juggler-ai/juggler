//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two pinned buttons above a command list — "Edit custom slash commands…"
 * and "Browse built-in commands…" — shared by every surface that lists slash
 * commands: the typed-`/` completion menu, the composer's `/` button dropdown,
 * and the mobile actions sheet. The last two also share their command order and
 * row builder from here.
 *
 * That a user can write their own commands is not something a list of commands
 * conveys — `/commands` sitting among them reads as one more command to run, not
 * as the way in. Each surface therefore pins the editor as a button above its
 * list and drops the plain `/commands` row, since the button IS that command:
 * two rows for one action would be worse than none. The second button hands the
 * built-ins to the place that already documents every capability the app loads,
 * so neither list has to be two lists.
 * @module services/command-manager-entry
 */

import { markForTranslation, t } from '../../sdk/lib/i18n.js';

/** Id of the built-in command that opens the manager. */
export const MANAGER_COMMAND_ID = 'commands';

/** Label of the button opening the custom-command manager. */
const MANAGE_COMMANDS_LABEL = markForTranslation('Edit custom slash commands…');

/** Label of the button opening the built-ins in the Extensions settings. */
const BROWSE_COMMANDS_LABEL = markForTranslation('Browse built-in commands…');

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
 * The commands a button-opened list shows, in its order: the manager command
 * dropped (its pinned button stands in for it) and {@link MENU_ORDER} leading.
 * Shared by the composer's `/` dropdown and the mobile actions sheet, so the two
 * cannot list the same commands in different orders.
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
 * A command list with the manager command removed — for surfaces showing the
 * pinned button in its place.
 * @template {{name: string}} T
 * @param {T[]} commands - Commands to filter
 * @returns {T[]} The list without the manager command
 */
export function withoutManagerCommand(commands) {
  return commands.filter((c) => c.name !== MANAGER_COMMAND_ID);
}

/**
 * Build a pinned row: the label alone, with no `/` glyph. The other rows earn
 * their slash by being the command you type; these are buttons, and a bare `/`
 * beside "Edit custom slash commands…" only reads as a command name that went
 * missing. The caller owns the click wiring, since each surface dismisses itself
 * differently.
 * @param {string} label - Button text, as English source
 * @param {string} extraClass - Surface-specific class alongside the shared ones
 * @param {boolean} last - True for the final button of the pair, which carries
 *   the rule separating the pair from the commands below it
 * @returns {HTMLLIElement} The row element
 */
function buildPinnedRow(label, extraClass, last) {
  const row = document.createElement('li');
  row.className = ('menu-item slash-command-pinned ' + (last ? 'slash-command-pinned-last ' : '') + extraClass).trim();

  const text = document.createElement('span');
  text.className = 'slash-command-pinned-label';
  text.textContent = t(label);
  row.appendChild(text);

  return row;
}

/**
 * Build the "Edit custom slash commands…" row.
 * @param {string} [extraClass] - Surface-specific class alongside the shared ones
 * @returns {HTMLLIElement} The row element
 */
export function buildManageCommandsRow(extraClass = '') {
  const row = buildPinnedRow(MANAGE_COMMANDS_LABEL, extraClass, false);
  row.dataset.command = MANAGER_COMMAND_ID;
  return row;
}

/**
 * Build the "Browse built-in commands…" row.
 * @param {string} [extraClass] - Surface-specific class alongside the shared ones
 * @returns {HTMLLIElement} The row element
 */
export function buildBrowseCommandsRow(extraClass = '') {
  return buildPinnedRow(BROWSE_COMMANDS_LABEL, extraClass, true);
}
