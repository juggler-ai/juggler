//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-backed engine runtime.
 *
 * Boots the real EngineApp (web/js/engine-app.js) inside a module worker so the
 * engine's WebSocket and tool execution run off the main thread, immune to the
 * WebKit hidden/accessory main-thread throttling.
 *
 * The engine graph uses the public `juggler/*` SDK specifiers, and a module
 * worker has no import map to resolve them — so engine-app.js (and everything it
 * pulls in) is imported through the server's /worker-module loader, which
 * rewrites those specifiers to concrete URLs. This is the engine's sole runtime;
 * /engine boots it via engine-worker-main.js.
 */

import { createSandboxBridge } from './engine-worker-sandbox.js';
import { apiUrl, isApiUrl } from './utils/api-url.js';

// Mark this global BEFORE the engine graph loads so client-role.isEngine() makes
// the real wsService connect as role=engine from inside the worker. The import
// above are leaf modules with no bare specifiers and no load-time side effects,
// so hoisting it ahead of this assignment changes nothing; the engine graph
// itself still loads through the /worker-module loader below, which is what
// resolves its `juggler/*` specifiers.
globalThis.JUGGLER_ENGINE = true;

/**
 * The globals this realm publishes for the engine graph and sandbox-runner.js.
 * @typedef {object} EngineWorkerGlobals
 * @property {string} [__assetPrefix] - Version-prefixed asset base (utils/asset-url.js)
 * @property {string} [__jugglerBase] - Base path the page was served under (utils/api-url.js)
 * @property {string} [__jugglerToken] - Per-instance API token
 * @property {import('./engine-worker-sandbox.js').SandboxDelegate} [__hostSandboxDelegate] - query_code's host delegate
 * @property {() => void} [__onEngineReady] - Fired by engine-app.js once it has booted
 */

/**
 * The `start` message engine-worker-main.js posts once.
 * @typedef {{type: 'start', assetPrefix?: string, apiBase?: string, apiToken?: string}} EngineWorkerStartMessage
 */

/**
 * Everything the host posts to this worker.
 * @typedef {EngineWorkerStartMessage
 *   | ({type: 'sandbox-cap'} & import('./engine-worker-sandbox.js').SandboxCapMessage)
 *   | ({type: 'sandbox-result'} & import('./engine-worker-sandbox.js').SandboxResultMessage)
 *   | ({type: 'sandbox-console'} & import('./engine-worker-sandbox.js').SandboxConsoleMessage)} EngineWorkerInbound
 */

const engineGlobals = /** @type {EngineWorkerGlobals} */ (globalThis);

/**
 * Post server-visible startup telemetry. The engine runs in a worker inside the
 * hidden WebView, so its console is otherwise the only sink.
 * @param {string} event - 'ready' | 'error'
 * @param {Record<string, unknown>} [payload]
 */
function report(event, payload) {
  fetch(apiUrl('/client/report'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...payload })
  }).catch(() => {});
}

/**
 * How many uncaught faults this realm reports before it stops. A failure that
 * repeats in a loop would otherwise fill the app log with one shape of line, and
 * the twentieth copy says nothing the first did not.
 */
const MAX_FAULT_REPORTS = 20;
let faultReports = 0;

/**
 * Report an uncaught fault in this realm to the app log.
 *
 * Without this the engine's faults land nowhere at all: the worker runs inside a
 * hidden WebView whose console nothing captures, and the host's `worker.onerror`
 * only forwards to that same unread console. A rejection nobody handled is
 * exactly how an await that never settles comes about, so it is the first thing
 * an investigation wants and the one thing that used to leave no trace.
 * @param {string} kind - 'unhandledrejection' or 'error'
 * @param {unknown} reason - The rejection value or error
 */
function reportFault(kind, reason) {
  if (faultReports++ >= MAX_FAULT_REPORTS) return;
  const err = reason instanceof Error ? reason : null;
  const message = err ? err.message : String(reason);
  const stack = err?.stack;
  report('error', { message: `${kind}: ${message}`, stack });
  self.postMessage({ type: 'error', message: `${kind}: ${message}`, stack });
}

self.addEventListener('unhandledrejection', (event) => {
  reportFault('unhandledrejection', event.reason);
});
self.addEventListener('error', (event) => {
  reportFault('error', event.error ?? event.message);
});

/**
 * Install the same-origin /api token shim the viewer gets from index.html.
 * The engine's real runtime runs inside this module worker, where window.fetch's
 * shim is not inherited; without this, registry/config fetches fail with 401
 * before the bash tool is even registered. WebSocket dials pass the same token
 * as a query param from services/websocket.js.
 * @param {string} token
 */
function installAPITokenFetchShim(token) {
  if (!token || typeof globalThis.fetch !== 'function') return;
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    try {
      const request = typeof input !== 'string' && 'url' in input ? input : null;
      const url = typeof input === 'string' ? input : (request && request.url) || '';
      if (typeof url === 'string' && isApiUrl(url)) {
        init = { ...(init || {}) };
        const headers = new globalThis.Headers(
          init.headers ||
          (request && request.headers) ||
          undefined
        );
        headers.set('X-Juggler-Token', token);
        init.headers = headers;
      }
    } catch { /* fall through to the unmodified fetch */ }
    return origFetch(input, init);
  };
}

// ── Host-delegated sandbox (query_code) ──────────────────────────────────
// The bridge itself lives in engine-worker-sandbox.js; this file owns only the
// wiring to `self`. The delegate hook lives on globalThis (not a module export)
// so it is shared regardless of how many sandbox-runner instances the
// worker-module loader materialises.
const sandbox = createSandboxBridge({ post: (message) => self.postMessage(message) });
engineGlobals.__hostSandboxDelegate = sandbox.delegate;

self.onmessage = (event) => {
  const data = /** @type {EngineWorkerInbound} */ (event.data || {});

  if (data.type === 'sandbox-cap') {
    sandbox.handleCap(data);
    return;
  }
  if (data.type === 'sandbox-result') {
    sandbox.handleResult(data);
    return;
  }
  if (data.type === 'sandbox-console') {
    sandbox.handleConsole(data);
    return;
  }

  if (data.type !== 'start') return;
  engineGlobals.__assetPrefix = data.assetPrefix || '';
  engineGlobals.__jugglerBase = data.apiBase || '';
  engineGlobals.__jugglerToken = data.apiToken || '';
  installAPITokenFetchShim(engineGlobals.__jugglerToken);

  // The engine fires this optional hook once it has booted and begun
  // connecting (see engine-app.js setup()). Relay it to the host (for the
  // window.__engineReady mirror + logging) and the server (for observability).
  engineGlobals.__onEngineReady = () => {
    report('ready', {});
    self.postMessage({ type: 'ready' });
  };

  // Boot the real engine through the worker-module loader so its bare
  // juggler/* specifiers resolve. Top-level code in engine-app.js constructs
  // EngineApp and kicks off setup()/connect(). The URL is built as a variable
  // so it stays a runtime import (a literal would be statically resolved).
  const engineEntry = '/worker-module?url=' + encodeURIComponent('/js/engine-app.js');
  import(/* @vite-ignore */ engineEntry).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    report('error', { message, stack: error instanceof Error ? error.stack : undefined });
    self.postMessage({ type: 'error', message, stack: error instanceof Error ? error.stack : undefined });
  });
};

export {};
