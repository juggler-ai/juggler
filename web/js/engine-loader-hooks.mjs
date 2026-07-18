//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node ESM customization hooks for the Node engine host.
 *
 * Extensions load their tool/command modules at runtime through the engine's
 * asset-url loader (web/js/utils/asset-url.js importModuleUrl): with no
 * `document` it does `import('/worker-module?url=<extUrl>')`. In the webview
 * worker the module base is the server's http origin, so `/worker-module…`
 * resolves to a same-origin HTTP fetch and the server rewrites the module's
 * bare `juggler/*` SDK specifiers before returning it. Under Node the engine
 * graph is imported from disk (a file:// base), so `/worker-module…` would
 * resolve to a bogus filesystem path — the "Cannot find module '/worker-module'"
 * failure that otherwise kills every extension tool in node mode.
 *
 * These hooks make Node behave exactly like the worker: any server-absolute
 * `/worker-module…` specifier is redirected to the server's http origin and
 * loaded by fetching it over HTTP (with the API token), so the server does the
 * same specifier rewrite it does for the webview worker. Every module the server
 * returns already has its own imports rewritten to `/worker-module?url=…`
 * form, so nested extension imports flow back through these same hooks.
 *
 * Registered from engine-host-node.mjs via `module.registerHooks` before the engine
 * graph is imported. Hooks run on a dedicated loader thread; the server origin
 * and token arrive through the `initialize` data channel.
 */

/** @type {string} */ let origin = '';
/** @type {string} */ let token = '';

/**
 * Receive the server origin + API token from `module.registerHooks(...)`.
 * @param {{ origin?: string, token?: string }} [data]
 */
export async function initialize(data) {
  origin = (data && data.origin) || '';
  token = (data && data.token) || '';
}

/**
 * Redirect server-absolute `/worker-module…` specifiers to the server's http
 * origin so the load hook can fetch them. Everything else resolves normally
 * (relative and file:// specifiers in the on-disk snapshot).
 * @param {string} specifier
 * @param {object} context
 * @param {Function} nextResolve
 * @returns {Promise<{url: string, shortCircuit?: boolean}>}
 */
export async function resolve(specifier, context, nextResolve) {
  if (origin && specifier.startsWith('/worker-module')) {
    return { url: origin + specifier, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

/**
 * Load a `/worker-module…` URL by fetching it from the server over HTTP,
 * authenticated with the API token, and hand Node the returned source as an ES
 * module. All other URLs load normally (the snapshotted file:// graph).
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 * @returns {Promise<{format: string, source: string, shortCircuit?: boolean}>}
 */
export async function load(url, context, nextLoad) {
  if (origin && url.startsWith(origin + '/worker-module')) {
    const res = await fetch(url, token ? { headers: { 'X-Juggler-Token': token } } : undefined);
    if (!res.ok) {
      throw new Error(`engine-loader-hooks: worker-module fetch failed (${res.status}) for ${url}`);
    }
    const source = await res.text();
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
