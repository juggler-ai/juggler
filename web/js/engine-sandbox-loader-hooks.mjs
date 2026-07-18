//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESM loader hooks for the explore_code sandbox worker (engine-sandbox-worker.mjs).
 *
 * User code in the sandbox may `import('<projectRoot>/rel/path')` to load a
 * project module. In the browser iframe those resolve against the server's http
 * origin and are fetched read-only from the static/sandbox-file routes; the
 * untrusted code runs in an opaque-origin worker with no filesystem access. The
 * Node sandbox mirrors that: engine-sandbox-worker.mjs rewrites every user
 * `import()` to a fully-qualified same-origin http(s) URL, and these hooks fetch
 * that URL over HTTP (with the API token) and hand Node the source. Node has no
 * built-in http(s) ESM loader, so without this hook such an import throws
 * ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * The resolve hook is the enforcement boundary: after registration it permits
 * only fully-qualified same-origin HTTP module URLs. The worker rewrites normal
 * user imports for useful diagnostics, but a source-transform miss (for example
 * inside a template interpolation) cannot resolve a Node builtin, a file URL, or
 * another origin.
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

export async function resolve(specifier, context, nextResolve) {
  let url = specifier;
  if (context.parentURL && context.parentURL.startsWith(origin + '/')) {
    try { url = new URL(specifier, context.parentURL).href; } catch { /* reject below */ }
  }
  if (origin && url.startsWith(origin + '/')) {
    return { url, shortCircuit: true };
  }
  throw new Error(`import of "${specifier}" is not allowed in the explore_code sandbox`);
}

/**
 * Fetch a same-origin HTTP module URL over HTTP and return its source.
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 * @returns {Promise<{format: string, source: string, shortCircuit?: boolean}>}
 */
export async function load(url, context, nextLoad) {
  if (origin && url.startsWith(origin + '/')) {
    const res = await fetch(url, token ? { headers: { 'X-Juggler-Token': token } } : undefined);
    if (!res.ok) {
      throw new Error(`explore_code import failed (${res.status}) for ${url}`);
    }
    const source = await res.text();
    const format = url.split('?')[0].endsWith('.json') ? 'json' : 'module';
    return { format, source, shortCircuit: true };
  }
  throw new Error(`sandbox loader refused non-origin URL: ${url}`);
}
