//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import slashCommandHandler from '../services/slash-command-handler.js';
import { longestCommonPrefix } from './completion-menu.js';
import { withoutManagerCommand, buildCommandsSettingsRow, commandText, COMMANDS_SETTINGS_TAB } from '../services/command-manager-entry.js';
import { openSettings } from '../services/settings-launcher.js';
import { markForTranslation, t } from '../../sdk/lib/i18n.js';

/**
 * The `/` slash-command completion source for {@link CompletionMenu}.
 *
 * Fires only when the message begins with `/` and the caret is still inside
 * that first command token (no space typed yet) — so it never competes with an
 * `@` mention or a `/` typed mid-sentence, and matches the "slash at the start
 * of the message" affordance. Accepting a command inserts its text (`/name `);
 * an argument-less command then runs on that same keystroke (see
 * `submitAfterAccept`), while a command declaring an `argsHint` leaves the caret
 * after `/name ` so the user can type its arguments before pressing Enter.
 *
 * User-defined commands appear alongside built-ins with a small provenance badge
 * ("user"/"project"). A pinned "New command…" row is offered last so that typing
 * a name that does not exist becomes the discovery path for creating one — but it
 * is suppressed when the query exactly names an existing command, since creating
 * a duplicate is impossible.
 *
 * A bare `/` also leads with the pinned "Browse/edit slash commands…" button,
 * standing in for the `/commands` row it replaces and opening the Slash
 * commands settings page. Opening the menu with nothing typed is the moment
 * someone is looking for what is there, and the one place a button costs no one
 * anything. Once a query is typed it is gone and `/commands` completes normally
 * — a permanently pinned row would take the first ArrowDown away from the first
 * real match, and would leave every single-match list two items long, which is
 * what Tab's auto-accept shortcut keys off.
 * @module components/slash-command-provider
 */

/**
 * The sentinel items accepted to open the Slash commands settings page, on a new
 * draft or on its list. Kept distinct from real commands (which have `name`) so
 * `accept`/`insert` can special-case them.
 * @type {{action: 'new-command', query: string}}
 */
const NEW_COMMAND_SENTINEL = { action: 'new-command', query: '' };

/** @type {{action: 'commands-settings'}} */
const COMMANDS_SETTINGS_SENTINEL = { action: 'commands-settings' };

/**
 * Whether an item is one of the synthetic rows rather than a real command. They
 * carry no `name`, so nothing that completes or runs text may include them.
 * @param {any} item - A fetched item
 * @returns {boolean} True for the synthetic rows
 */
function isSynthetic(item) {
  return item.action === 'new-command' || item.action === 'commands-settings';
}

/**
 * A user command's provenance badge: the word for where it is defined.
 * @param {string} scope - 'user' | 'project'
 * @returns {string} The badge text
 */
function scopeBadgeText(scope) {
  if (scope === 'user') return t('user', undefined, { context: 'command scope' });
  if (scope === 'project') return t('project', undefined, { context: 'command scope' });
  return scope;
}

/**
 * The `/` slash-command completion provider.
 * @type {import('./completion-menu.js').CompletionProvider}
 */
export const slashCommandProvider = {
  id: 'slash-command',
  emptyLabel: markForTranslation('No commands'),

  detect(textBefore) {
    // Start-anchored: the `/` must be the first character of the message and
    // everything up to the caret must still be command-name chars (no space —
    // once the user types an argument the command name is settled).
    const match = textBefore.match(/^\/([a-zA-Z][\w-]*)?$/);
    if (!match) return null;
    return { anchorPos: 0, query: match[1] ?? '' };
  },

  async fetch(query) {
    await slashCommandHandler.init();
    const q = query.toLowerCase();
    const commands = slashCommandHandler.getCommands();
    // Items are opaque to the menu, and the list mixes real commands with the
    // synthetic rows, so it is typed loosely.
    const listed = q === '' ? withoutManagerCommand(commands) : commands;
    const matches = /** @type {any[]} */ (listed
      .filter(c => c.name.toLowerCase().startsWith(q) || (c.label?.toLowerCase().startsWith(q) ?? false))
      .sort((a, b) => a.name.localeCompare(b.name)));
    // Lead a bare `/` with the button, in place of the `/commands` row just
    // dropped.
    if (q === '') matches.unshift({ ...COMMANDS_SETTINGS_SENTINEL });
    // Pin a "New command…" row at the end so an unmatched query (e.g. /standup)
    // becomes the create path. It carries the current query to pre-fill the name.
    // Suppress it when the query already names an existing command (built-in or
    // user) — creating a duplicate is impossible, so the row would be a dead end.
    const nameTaken = q !== '' && commands.some(c => c.name.toLowerCase() === q);
    if (!nameTaken) matches.push({ ...NEW_COMMAND_SENTINEL, query });
    return matches;
  },

  renderItem(cmd) {
    if (cmd.action === 'commands-settings') {
      return buildCommandsSettingsRow('slash-command-item');
    }

    if (cmd.action === 'new-command') {
      const li = document.createElement('li');
      li.className = 'menu-item slash-command-item slash-command-new';
      li.dataset.command = '__new__';
      const code = document.createElement('code');
      code.className = 'menu-item-command';
      code.textContent = cmd.query ? t('New command “/{name}”…', { name: cmd.query }) : t('New command…');
      li.appendChild(code);
      return li;
    }

    const li = document.createElement('li');
    li.className = 'menu-item slash-command-item' + (cmd.danger ? ' danger' : '');
    li.dataset.command = cmd.name;

    const code = document.createElement('code');
    code.className = 'menu-item-command';
    code.textContent = '/' + cmd.name;
    li.appendChild(code);

    // Provenance badge for user-defined commands (built-ins carry none).
    if (cmd.userDefined && cmd.scope) {
      const badge = document.createElement('span');
      badge.className = 'slash-command-scope-badge slash-command-scope-' + cmd.scope;
      badge.textContent = scopeBadgeText(cmd.scope);
      li.appendChild(badge);
    }

    const desc = document.createElement('span');
    desc.className = 'menu-item-desc';
    const own = cmd.description || cmd.label;
    desc.textContent = own ? commandText(cmd, own) : cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
    li.appendChild(desc);

    return li;
  },

  insert(cmd) {
    // Opening settings is a side effect; the accepted text is cleared so the
    // half-typed "/name" does not linger behind it.
    if (cmd.action === 'commands-settings') {
      openSettings(COMMANDS_SETTINGS_TAB);
      return '';
    }
    if (cmd.action === 'new-command') {
      openSettings(COMMANDS_SETTINGS_TAB, { newCommand: { name: cmd.query || '' } });
      return '';
    }
    return '/' + cmd.name + ' ';
  },

  submitAfterAccept(cmd) {
    // A command that takes no arguments is runnable the instant it is accepted,
    // so fire it on that same Enter/click rather than splicing "/name " and
    // waiting for a second Enter. Commands that declare an argsHint expect the
    // user to type arguments next, so those keep the accept-then-send flow. The
    // synthetic rows open settings (never submit the composer).
    return !isSynthetic(cmd) && !cmd.argsHint;
  },

  tabCompleteReplacement(items, query) {
    // Only real commands participate in prefix completion — the synthetic rows
    // carry no name to complete to.
    const names = items.filter(c => !isSynthetic(c)).map(c => c.name);
    const lcp = longestCommonPrefix(names);
    return lcp.length > query.length ? '/' + lcp : null;
  },
};
