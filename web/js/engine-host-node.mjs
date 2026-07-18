//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node-backed engine runtime — the Node twin of engine-worker-runtime.js.
 *
 * When Juggler can't host the engine inside a webview (a headless Linux box
 * with no display), the server snapshots the engine module graph to disk and
 * spawns `node engine-host.mjs --server <addr>` (see
 * cmd/juggler/server/engine_snapshot.go and cmd/juggler/app nodeHost). This
 * file is that entry: it installs the small set of browser globals the engine
 * graph expects, then imports the real EngineApp (web/js/engine-app.js) from
 * the snapshot beside it.
 *
 * It must stay skeletal and dependency-free (no static imports): everything the
 * engine needs it pulls in itself through the snapshotted, relative-path graph.
 */

// The server address the engine dials, and the per-instance API token. The
// address arrives on argv (`--server host:port`); the token arrives via env
// (JUGGLER_TOKEN) so it never appears in the process table.
const serverAddr = readServerAddr(process.argv);
const apiToken = process.env.JUGGLER_TOKEN || '';
const projectRoot = process.env.JUGGLER_PROJECT_ROOT || '';
const origin = `http://${serverAddr}`;

/**
 * Parse the `--server host:port` argument.
 * @param {string[]} argv
 * @returns {string}
 */
function readServerAddr(argv) {
  const i = argv.indexOf('--server');
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  throw new Error('engine-host-node: missing required --server <host:port> argument');
}

// Mark the engine global BEFORE the graph loads so client-role.isEngine() makes
// the real wsService connect as role=engine (mirrors engine-worker-runtime.js).
globalThis.JUGGLER_ENGINE = true;
globalThis.__assetPrefix = '';
globalThis.__jugglerToken = apiToken;
// Seed the live project root the explore_code sandbox delegate reads per run.
// The engine session keeps it current across a runtime project switch (see
// session.js _applyEngineProjectRoot); this boot value covers the window before
// the session loads.
globalThis.__jugglerProjectRoot = projectRoot;

// The engine graph reads globalThis.location to build the WebSocket URL
// (services/websocket.js: `${protocol}//${loc.host}/api/ws…`) and, via the
// fetch shim, to resolve same-origin /api URLs. A webview page has a real
// Location; Node does not, so synthesise the minimum surface the graph uses.
// location.reload() (a hard engine reset in the browser) exits the process —
// the Go host treats engine death as "tear the server down", the correct
// headless analogue of reloading the page.
globalThis.location = /** @type {any} */ ({
  protocol: 'http:',
  host: serverAddr,
  hostname: serverAddr.split(':')[0],
  origin,
  href: `${origin}/`,
  reload() { process.exit(0); },
});

installAPITokenFetchShim(apiToken);

// Register the ESM loader hooks BEFORE the engine graph is imported, so every
// later `import('/worker-module?url=…')` the engine's extension loader issues
// (utils/asset-url.js, when there is no document) is fetched from the server
// over HTTP instead of resolving to a bogus filesystem path. This is what makes
// extension-provided tools and commands load in node mode, matching the webview
// worker. Dynamic import of node:module keeps this file free of static engine
// imports (see the header note); the hooks file is copied to the snapshot root
// beside this one (cmd/juggler/server/engine_snapshot.go).
await installEngineLoaderHooks(origin, apiToken);

/**
 * Register the /worker-module ESM loader hooks (engine-loader-hooks.mjs) on the
 * main thread's module loader, passing the server origin + token to the hook
 * thread.
 * @param {string} serverOrigin
 * @param {string} token
 */
async function installEngineLoaderHooks(serverOrigin, token) {
  const { register } = await import('node:module');
  register('./engine-loader-hooks.mjs', import.meta.url, {
    data: { origin: serverOrigin, token },
  });
}

/**
 * Post server-visible startup telemetry (readiness parity with the worker
 * runtime's report()). The engine's console is otherwise the only sink.
 * @param {string} event - 'ready' | 'error'
 * @param {Record<string, any>} [payload]
 */
function report(event, payload) {
  fetch('/api/client/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...payload }),
  }).catch(() => {});
}

/**
 * Install the same-origin /api token shim, adapted for Node. Two divergences
 * from engine-worker-runtime.js's shim, both because Node's fetch (undici)
 * rejects relative URLs where a webview page would resolve them against its
 * origin: (1) relative "/…" URLs are made absolute against the server origin;
 * (2) the X-Juggler-Token header is added to same-origin /api requests, exactly
 * as the worker shim does.
 * @param {string} token
 */
function installAPITokenFetchShim(token) {
  const origFetch = globalThis.fetch.bind(globalThis);
  /**
   * @param {string} u
   * @returns {boolean} True when the URL targets the same-origin /api surface.
   */
  const isApi = (u) => typeof u === 'string' &&
    (u.startsWith('/api/') || u.startsWith(origin + '/api/'));
  globalThis.fetch = (input, init) => {
    try {
      const inputAny = /** @type {any} */ (input);
      let url = typeof input === 'string' ? input : (inputAny && inputAny.url) || '';
      const wantsToken = token && isApi(url);
      if (typeof input === 'string' && url.startsWith('/')) {
        input = origin + url; // absolutise for undici
      }
      if (wantsToken) {
        init = { ...(init || {}) };
        const headers = new globalThis.Headers(
          init.headers ||
          (typeof input !== 'string' && inputAny && inputAny.headers) ||
          undefined
        );
        headers.set('X-Juggler-Token', token);
        init.headers = headers;
      }
    } catch { /* fall through to the unmodified fetch */ }
    return origFetch(input, init);
  };
}

// explore_code delegates its untrusted-script iframe to a host with a document
// (engine-worker-main.js in the webview case). The Node host's equivalent is a
// worker_threads sandbox (engine-sandbox-node.mjs): untrusted code runs in an
// isolated worker with every Node built-in locked out, capability calls RPC back
// here, and the worker is terminated on timeout. Installed synchronously below
// so the delegate exists before the engine registers the explore_code tool.
await installSandboxDelegate(origin, apiToken, projectRoot);

/**
 * Install the worker_threads explore_code sandbox delegate on globalThis. Kept
 * as a dynamic import so this entry has no static engine imports.
 * @param {string} serverOrigin
 * @param {string} token
 * @param {string} root - Project root exposed to sandboxed code as projectRoot
 */
async function installSandboxDelegate(serverOrigin, token, root) {
  const { installNodeSandboxDelegate } = await import('./engine-sandbox-node.mjs');
  installNodeSandboxDelegate({ origin: serverOrigin, token, projectRoot: root });
}

// The engine fires this optional hook once it has booted and begun connecting
// (engine-app.js setup()). Relay it to the server for observability, matching
// the worker runtime.
/** @type {any} */ (globalThis).__onEngineReady = () => {
  report('ready', {});
};

// A crash anywhere in the engine must be loud: the Go host pipes our stderr to
// jlog and treats our exit as fatal, so surface the error and exit non-zero
// rather than dying silently or lingering.
process.on('uncaughtException', (err) => {
  console.error('[engine-node] uncaught exception:', err && err.stack ? err.stack : err);
  report('error', { message: String(err && err.message ? err.message : err) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[engine-node] unhandled rejection:', reason);
});

// Boot the real engine from the snapshot beside this file. Built as a runtime
// dynamic import (a variable specifier) so it is never statically pre-resolved,
// and so a load failure is catchable.
const engineEntry = './js/engine-app.js';
import(engineEntry).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[engine-node] failed to load engine-app.js:', error && error.stack ? error.stack : message);
  report('error', { message });
  process.exit(1);
});
