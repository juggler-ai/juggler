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
