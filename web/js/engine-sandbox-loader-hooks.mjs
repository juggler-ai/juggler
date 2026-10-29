//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESM loader hooks for the query_code sandbox worker (engine-sandbox-worker.mjs).
 *
 * User code in the sandbox may `import('<projectRoot>/rel/path')` to load a
 * project module. In the browser iframe those resolve against the server's http
 * origin and are fetched read-only from the static/sandbox-file routes; the
 * untrusted code runs in an opaque-origin worker with no filesystem access. The
 * Node sandbox mirrors that: engine-sandbox-worker.mjs rewrites every user
 * `import()` to a fully-qualified same-origin http(s) URL, and these hooks fetch
 * that URL over HTTP and hand Node the source. Node has no built-in http(s) ESM
 * loader, so without this hook such an import throws
 * ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * The resolve hook is the enforcement boundary: after registration it permits
 * only fully-qualified same-origin HTTP module URLs, and never one on the
 * server's /api. The worker rewrites normal user imports for useful
 * diagnostics, but a source-transform miss (for example inside a template
 * interpolation) cannot resolve a Node builtin, a file URL, another origin, or
 * the API.
 *
 * The fetch carries no API token, as the browser sandbox's carries none: the
 * module route is authorised by the capability already in its path
 * (engine-sandbox-node.mjs), and a program has no business with what needs more.
 */

/** @type {string} */ let origin = '';

/**
 * Receive the server origin from `module.register(..., { data })`.
 * @param {{ origin?: string }} [data]
 */
export async function initialize(data) {
  origin = (data && data.origin) || '';
}

/**
 * Whether a URL addresses the server's /api, however its path is spelled:
 * percent-encoding and dot segments are undone as the server's router would
 * undo them, and case is ignored.
 * @param {string} url - A same-origin URL
 * @returns {boolean} True for /api and anything under it, or an unreadable path
 */
function reachesApi(url) {
  let path;
  try {
    path = new URL(decodeURIComponent(new URL(url).pathname), 'http://h').pathname;
  } catch {
    return true;
  }
  path = path.replace(/\/{2,}/g, '/').toLowerCase();
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Resolve an import to a same-origin module URL, or refuse it: nothing else
 * reaches Node's own resolver.
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} _nextResolve - Node's resolver, never consulted
 * @returns {Promise<{url: string, shortCircuit: boolean}>} The module URL
 */
export async function resolve(specifier, context, _nextResolve) {
  let url = specifier;
  if (context.parentURL && context.parentURL.startsWith(origin + '/')) {
    try { url = new URL(specifier, context.parentURL).href; } catch { /* reject below */ }
  }
  if (origin && url.startsWith(origin + '/') && !reachesApi(url)) {
    return { url, shortCircuit: true };
  }
  throw new Error(`import of "${specifier}" is not allowed in the query_code sandbox`);
}

/**
 * Fetch a same-origin HTTP module URL over HTTP and return its source.
 * @param {string} url
 * @param {object} _context
 * @param {Function} _nextLoad - Node's loader, never consulted
 * @returns {Promise<{format: string, source: string, shortCircuit?: boolean}>} The module's source and format
 */
export async function load(url, _context, _nextLoad) {
  if (origin && url.startsWith(origin + '/') && !reachesApi(url)) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`query_code import failed (${res.status}) for ${url}`);
    }
    const source = await res.text();
    const format = url.split('?')[0].endsWith('.json') ? 'json' : 'module';
    return { format, source, shortCircuit: true };
  }
  throw new Error(`sandbox loader refused URL: ${url}`);
}
