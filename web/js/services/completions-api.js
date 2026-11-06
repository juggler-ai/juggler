//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';
import wsService from './websocket.js';

/** @type {AbortController|null} */
let _currentController = null;

/** @type {AbortController|null} */
let _pathController = null;

/**
 * The query-string suffix naming the tree a completion request is about. Only
 * the id travels — the server resolves it, refusing the ways every other
 * workspace-addressed request is refused — and '' (the project) sends nothing.
 * @param {string} [workspaceId] - Workspace id, '' or omitted for the project.
 * @returns {string} '' or '&workspace=<id>'.
 */
function workspaceParam(workspaceId) {
  return workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : '';
}

/**
 * Call `onDrop` once the link to the server is dead: at once if it is down
 * now, else when it closes. The socket's own watchdog declares a silent link
 * dead (LINK_STALL_MS, websocket.js), so this ends for a link that hangs as
 * well as one that fails.
 * @param {() => void} onDrop - Called once, when the link is dead
 * @returns {() => void} Stops watching
 */
function whenLinkDrops(onDrop) {
  if (!wsService.isConnected()) {
    onDrop();
    return () => {};
  }
  return wsService.on('close', () => onDrop());
}

/**
 * Check which of the given paths exist on disk. Resolves relative paths
 * against the workspace's root (the project when none is named); "~" is
 * expanded server-side.
 *
 * Runs on the send path, between the button press and the message going out.
 * It waits for as long as the link to the server lives, however slow the
 * answer: a clock would give up on a server that is merely slow and leave the
 * caller guessing. A link that drops, or a request that fails, yields null, so
 * the caller can tell "none exist" from "could not ask".
 * @param {string[]} paths - Candidate paths to check
 * @param {string} [workspaceId] - The tree to check in, '' for the project
 * @param {{whenLinkDrops?: (onDrop: () => void) => () => void}} [options] - What ends the wait (default {@link whenLinkDrops})
 * @returns {Promise<Set<string>|null>} The subset of inputs that exist, or null when the check failed
 */
export async function fetchExistingPaths(paths, workspaceId = '', options = {}) {
  if (!paths || paths.length === 0) return new Set();
  const { whenLinkDrops: watchLink = whenLinkDrops } = options;
  const qs = paths.map(p => `paths=${encodeURIComponent(p)}`).join('&');
  const controller = new AbortController();
  const stopWatching = watchLink(() => controller.abort());
  try {
    /** @type {{existing: string[]}|null} */
    const data = await fetchJson(apiUrl(`/completions/exists?${qs}${workspaceParam(workspaceId)}`), {
      fallback: null,
      signal: controller.signal,
    });
    return data ? new Set(data.existing || []) : null;
  } catch {
    // The link dropped under it: the abort fetchJson re-throws.
    return null;
  } finally {
    stopWatching();
  }
}

/**
 * Fetch file completions from the server for a given query prefix.
 * Aborts any in-flight request before issuing a new one.
 * Returns [] on error — completions are best-effort.
 * @param {string} query - Typed text after "@"
 * @param {string} [workspaceId] - The tree to list, '' for the project
 * @returns {Promise<Array<string>>} Matching paths (dirs have trailing "/")
 */
export async function fetchFileCompletions(query, workspaceId = '') {
  if (_currentController) {
    _currentController.abort();
  }
  const controller = new AbortController();
  _currentController = controller;

  try {
    const url = apiUrl(`/completions/files?q=${encodeURIComponent(query)}${workspaceParam(workspaceId)}`);
    /** @type {{results: Array<{path: string}>}|null} */
    const data = await fetchJson(url, { signal: controller.signal });
    return (data?.results || []).map(r => r.path);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return [];
    return [];
  } finally {
    // Only clear the shared controller if a newer request hasn't replaced it —
    // an unconditional null would clobber the in-flight successor's controller.
    if (_currentController === controller) _currentController = null;
  }
}

/**
 * Fetch absolute path completions from the server.
 * Unlike fetchFileCompletions, results are NOT restricted to the current project.
 * Aborts any in-flight request before issuing a new one.
 * Returns [] on error, null if the request was superseded by a newer one.
 * @param {string} query - Absolute path prefix (e.g. "/Users/alice/co" or "~/code/")
 * @param {string} [workspaceId] - The tree a "./" or "../" query is relative to, '' for the project
 * @returns {Promise<Array<string>|null>} Matching paths (dirs have trailing "/"), or null if aborted
 */
export async function fetchPathCompletions(query, workspaceId = '') {
  if (_pathController) {
    _pathController.abort();
  }
  const controller = new AbortController();
  _pathController = controller;

  try {
    const url = apiUrl(`/completions/path?q=${encodeURIComponent(query)}${workspaceParam(workspaceId)}`);
    /** @type {{results: Array<{path: string}>}|null} */
    const data = await fetchJson(url, { signal: controller.signal });
    return (data?.results || []).map(r => r.path);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return null;
    return [];
  } finally {
    if (_pathController === controller) _pathController = null;
  }
}
