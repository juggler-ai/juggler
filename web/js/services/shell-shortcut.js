//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `! cmd` — how `/shell cmd` is typed. The command is posted to the
 * conversation as an ordinary bash tool call (Conversation's `runShell` side
 * effect; the worker's shell_command.go).
 * @module services/shell-shortcut
 */

/**
 * The command a `! cmd` message asks to run, or null when the message is not
 * one. A `!` with nothing after it is an ordinary message.
 * @param {string} text - The message as typed
 * @returns {string|null} The command line, trimmed, or null
 */
export function shellShortcutCommand(text) {
  const match = /^!\s*(\S[\s\S]*)$/.exec(String(text).trim());
  return match?.[1] ? match[1].trim() : null;
}

/**
 * The tool-use id prefix the worker gives a user's shell command
 * (userShellToolUseIDPrefix in shell_command.go) — the call's only mark.
 */
const USER_SHELL_TOOL_USE_ID_PREFIX = 'usershell_';

/**
 * The command a user's shell-command bash call runs, or null when the item is
 * not one.
 * @param {any} item - A conversation item Y.Map
 * @returns {string|null} The command line, or null
 */
export function userShellCommandOf(item) {
  if (item?.get?.('type') !== 'tool-action') return null;
  if (!String(item.get('toolUseId') ?? '').startsWith(USER_SHELL_TOOL_USE_ID_PREFIX)) return null;
  const input = item.get('toolInput');
  const command = (input?.toJSON ? input.toJSON() : input)?.command;
  return typeof command === 'string' ? command : null;
}
