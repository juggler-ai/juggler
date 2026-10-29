//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// Shared helper for every capability in this extension. Its filename carries no
// capability suffix, so none of the manifest's globs match it and it is never
// registered as a capability — it is just a module the capabilities import.

import { readFile, writeFile, extensionConfigResolve } from 'juggler/ops';

/** The extension id. Must match `id` in juggler.extension.json exactly. */
const EXTENSION_ID = '@example/bookmarks';

/** Project-relative store. Ops resolve relative paths against the project root. */
const STORE_PATH = '.juggler/bookmarks.json';

/** Used when the setting is missing or unreadable. */
const DEFAULT_MAX = 50;

/**
 * One saved location.
 * @typedef {object} Bookmark
 * @property {string} name - Short label the user or model refers to it by
 * @property {string} path - Project-relative file path
 * @property {number} [line] - 1-indexed line number
 * @property {string} [note] - Why this place matters
 * @property {string} savedAt - ISO 8601 timestamp
 */

/**
 * Read every bookmark.
 *
 * A missing store is the normal state on first run, not an error — any read
 * failure yields an empty list, so no caller needs to distinguish "no file yet"
 * from "no bookmarks".
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<Bookmark[]>} The saved bookmarks, oldest first
 */
export async function loadBookmarks(signal) {
  try {
    const file = await readFile({ path: STORE_PATH }, signal);
    const parsed = JSON.parse(file.content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Overwrite the store.
 * @param {Bookmark[]} bookmarks - The full list to persist
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<void>} Resolves once written
 */
export async function saveBookmarks(bookmarks, signal) {
  await writeFile({ path: STORE_PATH, content: `${JSON.stringify(bookmarks, null, 2)}\n` }, signal);
}

/**
 * Resolve the configured cap.
 *
 * Settings are keyed by extension id, and `extensionConfigResolve` applies the
 * manifest's declared default for a value the user has never set — so this
 * returns 50 on a fresh install without the caller knowing that number.
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<number>} Maximum bookmarks to keep
 */
export async function maxBookmarks(signal) {
  try {
    const config = /** @type {{max_bookmarks?: unknown}} */ (
      await extensionConfigResolve({ extId: EXTENSION_ID }, signal)
    );
    const value = Number(config.max_bookmarks);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX;
  } catch {
    return DEFAULT_MAX;
  }
}

/**
 * Render bookmarks as one line each, for a tool result or a command message.
 * @param {Bookmark[]} bookmarks - Bookmarks to format
 * @returns {string} One line per bookmark
 */
export function formatBookmarks(bookmarks) {
  return bookmarks
    .map(b => `${b.name} — ${b.path}${b.line ? `:${b.line}` : ''}${b.note ? ` (${b.note})` : ''}`)
    .join('\n');
}
