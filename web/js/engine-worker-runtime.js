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

// Mark this global BEFORE the engine graph loads so client-role.isEngine() makes
// the real wsService connect as role=engine from inside the worker.
globalThis.JUGGLER_ENGINE = true;

/**
 * Post server-visible startup telemetry. The engine runs in a worker inside the
 * hidden WebView, so its console is otherwise the only sink.
 * @param {string} event - 'ready' | 'error'
 * @param {Record<string, any>} [payload]
 */
function report(event, payload) {
  fetch('/api/client/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...payload })
  }).catch(() => {});
}

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
  const origin = globalThis.location?.origin || '';
  /**
   * @param {string} u
   * @returns {boolean} True when the URL targets the same-origin /api surface.
   */
  const isApi = (u) => typeof u === 'string' &&
    (u.startsWith('/api/') || Boolean(origin && u.startsWith(origin + '/api/')));
  globalThis.fetch = (input, init) => {
    try {
      const inputAny = /** @type {any} */ (input);
      const url = typeof input === 'string' ? input : (inputAny && inputAny.url) || '';
      if (isApi(url)) {
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

// ── Host-delegated sandbox (explore_code) ──────────────────────────────────
// explore_code runs untrusted JS in an opaque-origin iframe, which needs a
// `document` the worker doesn't have. We delegate the iframe to the main-thread
// host (engine-worker-main) and service the script's capability calls (fs/grep/
// glob) back here, where their closures live. The untrusted code never runs in
// the worker — only the capability servicing does.
let sandboxSeq = 0;
/** @type {Map<string, {resolve: Function, reject: Function, capabilities: Record<string, any>}>} */
const pendingSandbox = new Map();

/** @type {any} */ (globalThis).__hostSandboxDelegate = (
  /** @type {string} */ code,
  /** @type {Record<string, any>} */ capabilities,
  /** @type {number} */ timeoutMs
) => {
  const id = `sbx_${++sandboxSeq}`;
  const descriptors = Object.entries(capabilities).map(([name, cap]) => ({
    name,
    callable: typeof cap === 'function'
  }));
  // The project root the sandbox exposes as `projectRoot` comes from the live
  // engine value (updated on a runtime project switch — see session.js
  // _applyEngineProjectRoot), NOT the frozen sandbox.html template. This realm
  // (the engine worker) is where the session runs and keeps it current; the
  // main-thread iframe host can't read this worker's global, so pass it across.
  const projectRoot = /** @type {any} */ (globalThis).__jugglerProjectRoot;
  return new Promise((resolve, reject) => {
    pendingSandbox.set(id, { resolve, reject, capabilities });
    self.postMessage({ type: 'sandbox-run', id, code, timeoutMs, descriptors, projectRoot });
  });
};

/**
 * Service one capability call requested by the host's sandbox iframe.
 * @param {any} data - { id, callId, name, method, args }
 */
async function handleSandboxCap(data) {
  const entry = pendingSandbox.get(data.id);
  try {
    if (!entry) throw new Error(`no pending sandbox ${data.id}`);
    const cap = entry.capabilities[data.name];
    if (cap === undefined) throw new Error(`unknown capability: ${data.name}`);
    const value = typeof cap === 'function'
      ? await cap(...(data.args || []))
      : await cap[data.method](...(data.args || []));
    self.postMessage({ type: 'sandbox-cap-reply', id: data.id, callId: data.callId, ok: true, value });
  } catch (err) {
    self.postMessage({
      type: 'sandbox-cap-reply', id: data.id, callId: data.callId, ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

self.onmessage = (event) => {
  const data = event.data || {};

  if (data.type === 'sandbox-cap') {
    handleSandboxCap(data);
    return;
  }
  if (data.type === 'sandbox-result') {
    const entry = pendingSandbox.get(data.id);
    if (entry) {
      pendingSandbox.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || 'sandbox script error'));
    }
    return;
  }

  if (data.type !== 'start') return;
  /** @type {any} */ (globalThis).__assetPrefix = data.assetPrefix || '';
  /** @type {any} */ (globalThis).__jugglerToken = data.apiToken || '';
  installAPITokenFetchShim(/** @type {any} */ (globalThis).__jugglerToken);

  // The engine fires this optional hook once it has booted and begun
  // connecting (see engine-app.js setup()). Relay it to the host (for the
  // window.__engineReady mirror + logging) and the server (for observability).
  /** @type {any} */ (globalThis).__onEngineReady = () => {
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
