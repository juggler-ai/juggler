//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Telling the server which conversation wrote a file, so the git client can
 * say which conversation made the changes being committed.
 *
 * The server reads the file as it is on disk and records its git blob id
 * against the conversation (POST /api/git/attribute, gitattr). This module
 * imports nothing that needs a document, since tools run in the engine's
 * realms as well as the page.
 * @module services/git-attribution
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} GitAttribution
 * @property {string} workspaceId - The workspace the file was written in, '' for the project.
 * @property {string} path - The file as the tool named it: absolute, or relative to the tree's root.
 * @property {string} conv - The conversation that wrote it.
 * @property {string} thread - Its thread item, '' for the root thread.
 * @property {string} item - The tool use that wrote it.
 */

/**
 * Send one attribution. It never rejects: a write that landed is not undone
 * by the server failing to hear about it, so a failure is only logged.
 * @param {GitAttribution} attribution - Who wrote which file.
 * @returns {Promise<void>} Settles once the server has answered, or failed to.
 */
export async function sendGitAttribution({ workspaceId, path, conv, thread, item }) {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
  try {
    await fetchJson(apiUrl(`/git/attribute${query}`), { method: 'POST', body: { path, conv, thread, item } });
  } catch (err) {
    console.warn('[git-attribution] not recorded:', path, err);
  }
}
