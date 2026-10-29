//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Does this path already name a location on its own? A leading `/` everywhere,
 * and on Windows a drive path (`C:\\…`, `C:/…`) or a UNC share
 * (`\\\\server\\share`).
 * @param {string} path - The path to judge.
 * @returns {boolean} True when the path names its own location.
 */
function isAbsolutePath(path) {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:([\\/]|$)/.test(path);
}

/**
 * Collapse a path to one spelling. Purely textual — there is no project root in
 * scope here, so a relative path stays relative.
 * @param {string} path - The path as it arrived.
 * @returns {string} The normalized path, or '' when there was nothing to normalize.
 */
function normalizePathText(path) {
  const trimmed = String(path || '').trim();
  if (!trimmed) return '';
  const absolute = trimmed.startsWith('/');
  /** @type {string[]} */
  const segments = [];
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last && last !== '..') {
        segments.pop();
        continue;
      }
      if (absolute) continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (absolute) return `/${joined}`;
  return joined;
}

/**
 * Validate and normalize the parameters that identify a File pin. This module is
 * DOM-free because both the viewer-side pin type and the engine-side pin tool use
 * the same spelling before config is persisted.
 * @param {Record<string, unknown>} parameters - The parameters to check.
 * @returns {{path: string, isDirectory?: boolean, agentRequested?: boolean}|null} Normalized config, or null.
 */
export function normalizeFilePinParameters(parameters) {
  const raw = typeof parameters?.path === 'string' ? parameters.path.trim() : '';
  if (!raw) return null;
  const path = normalizePathText(raw);
  if (!path) return null;
  const isDirectory = parameters?.isDirectory === true || (raw.length > 1 && raw.endsWith('/'));
  return {
    path,
    ...(isDirectory ? { isDirectory: true } : {}),
    ...(parameters?.agentRequested === true ? { agentRequested: true } : {}),
  };
}

/**
 * A File pin's path as stored. Config is persisted state, so a path that is not
 * a string reads as no path at all.
 * @param {Record<string, unknown>|null|undefined} config - The pin's config.
 * @returns {string} The path, or '' when there is none.
 */
export function filePinPath(config) {
  const path = config?.path;
  return typeof path === 'string' ? path : '';
}

/**
 * Resolve a File pin's path against the open project when it is relative.
 * @param {Record<string, unknown>} config - The pin's config.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} active - Active context.
 * @returns {string} An absolute path, or the config path without a project.
 */
export function absoluteFilePinPath(config, active) {
  const path = filePinPath(config);
  if (!path || isAbsolutePath(path)) return path;
  const root = (active?.project?.path || '').replace(/\/+$/, '');
  return root ? `${root}/${path}` : path;
}
