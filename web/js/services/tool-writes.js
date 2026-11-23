//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Telling the server that a tool has just written a file, and on whose behalf.
 *
 * The server reads the file as it is on disk and keeps who wrote that version
 * (POST /api/tool-writes), which is how the views of a tree can say which
 * conversation made a change. This module imports nothing that needs a
 * document, since tools run in the engine's realms as well as the page.
 * @module services/tool-writes
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} ToolWrite
 * @property {string} workspaceId - The workspace the file was written in, '' for the project.
 * @property {string} path - The file as the tool named it: absolute, or relative to the tree's root.
 * @property {string} conv - The conversation that wrote it.
 * @property {string} thread - Its thread item, '' for the root thread.
 * @property {string} item - The tool use that wrote it.
 */

/**
 * Report one write. It never rejects: a write that landed is not undone by
 * the server failing to hear about it, so a failure is only logged.
 * @param {ToolWrite} write - Who wrote which file.
 * @returns {Promise<void>} Settles once the server has answered, or failed to.
 */
export async function reportToolWrite({ workspaceId, path, conv, thread, item }) {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
  try {
    await fetchJson(apiUrl(`/tool-writes${query}`), { method: 'POST', body: { path, conv, thread, item } });
  } catch (err) {
    console.warn('[tool-writes] not reported:', path, err);
  }
}
