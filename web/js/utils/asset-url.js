//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Asset URL resolution — the single rule for turning a server-relative module
 * URL into a fetchable one. Embedded builtin assets are served under a
 * version-prefixed path for cache busting (`window.__assetPrefix`); disk-served
 * extension paths bypass it. Both the registry module loader and the extension
 * system-prompt-contribution loader resolve URLs through here so they agree.
 * @module utils/asset-url
 */

import { serverPath } from './api-url.js';

/** URL prefixes whose files are served straight from disk (no cache-busting). */
const DISK_SERVED_PREFIXES = ['/user-extensions/'];

/**
 * Whether a served URL is delivered from disk (and so must skip cache-busting).
 * @param {string} url - Server-relative URL
 * @returns {boolean} True if the URL is served from disk
 */
function isDiskServedPath(url) {
  return DISK_SERVED_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Resolve a server-relative module URL to a fetchable one: embedded builtin
 * paths take the versioned asset prefix (cache busting, and already under the
 * page's base path), disk-served paths take the base path alone, and
 * already-absolute URLs are left untouched.
 * @param {string} url - Server-relative module URL (e.g. '/extensions/x/y.js')
 * @returns {string} The resolved URL to import/fetch
 */
export function resolveAssetUrl(url) {
  if (!url.startsWith('/')) return url;
  if (isDiskServedPath(url)) return serverPath(url);
  const assetPrefix = /** @type {typeof globalThis & {__assetPrefix?: string}} */ (globalThis).__assetPrefix;
  return assetPrefix ? assetPrefix + url : url;
}

/**
 * Dynamic-import a resolved module URL, routing through the server's
 * /worker-module loader when running without a document (the engine worker).
 * A module worker has no import map, so the bare `juggler/*` SDK specifiers
 * inside capability modules only resolve when the server rewrites them; the
 * loader does that rewrite. In the viewer/WebView (document present) the URL is
 * imported directly. Both registry and system-prompt capability loaders go
 * through here so plugins load identically on either thread.
 * @param {string} resolvedUrl - The asset-resolved module URL
 * @returns {Promise<{default?: unknown}>} The imported module namespace
 */
export function importModuleUrl(resolvedUrl) {
  if (typeof document === 'undefined') {
    // No base path: only the engine worker has no document, and the engine's
    // hidden webview loads /engine from its own server directly, never through
    // a proxy that mounts it under one.
    return import(/* @vite-ignore */ `/worker-module?url=${encodeURIComponent(resolvedUrl)}`);
  }
  return import(/* @vite-ignore */ resolvedUrl);
}
