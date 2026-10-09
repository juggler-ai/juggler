//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Main-thread host for the engine. The engine itself — WebSocket transport, Yjs
 * sync, tool execution — runs in the module worker spawned below
 * (engine-worker-runtime.js, which boots the real EngineApp). This host exists
 * only to own that worker, mirror its readiness onto window.__engineReady, and
 * run the query_code sandbox iframe on the worker's behalf (a worker has no
 * document, so it delegates the iframe here).
 */

import { runInSandbox } from '../sdk/lib/sandbox-runner.js';

console.info('[EngineWorkerHost] Starting worker-backed engine');

const worker = new Worker(`${/** @type {any} */ (window).__assetPrefix || ''}/js/engine-worker-runtime.js`, { type: 'module' });

// ── Sandbox bridge ─────────────────────────────────────────────────────────
// The worker can't create the query_code isolation iframe (no document), so
// it asks us to run it here. We run the real iframe sandbox and forward each of
// the script's capability calls back to the worker (where fs/grep/glob live).
let capCallSeq = 0;
/** @type {Map<string, {runId: string, resolve: Function, reject: Function}>} */
const pendingCapCalls = new Map();
/**
 * One controller per run in flight, so the worker's `sandbox-abort` can reach
 * the iframe that holds the run's Worker.
 * @type {Map<string, AbortController>}
 */
const runControllers = new Map();

/**
 * Forward one capability call from the iframe back to the worker to service.
 * @param {string} id - Sandbox run id
 * @param {string} name - Capability name
 * @param {string|null} method - Method name (null for a callable capability)
 * @param {unknown[]} args - Call arguments
 * @returns {Promise<unknown>} The capability's return value
 */
function callWorkerCapability(id, name, method, args) {
  const callId = `cc_${++capCallSeq}`;
  return new Promise((resolve, reject) => {
    pendingCapCalls.set(callId, { runId: id, resolve, reject });
    worker.postMessage({ type: 'sandbox-cap', id, callId, name, method, args });
  });
}

/**
 * Settle and drop every capability call still outstanding for a finished run.
 *
 * A run that times out or throws abandons whatever calls the script had in
 * flight, and the worker will never answer them — so without this each one
 * leaves an entry holding the script's own resolve/reject closures for the life
 * of the page, and the sandboxed code's promise never settles.
 * @param {string} runId - Sandbox run that has finished
 */
function abandonCapCalls(runId) {
  for (const [callId, pending] of [...pendingCapCalls]) {
    if (pending.runId !== runId) continue;
    pendingCapCalls.delete(callId);
    pending.reject(new Error('sandbox run ended before this capability call was answered'));
  }
}

/**
 * Run a sandbox request from the worker in the iframe sandbox.
 * @param {{id: string, code: string, timeoutMs: number, descriptors: Array<{name: string, callable: boolean}>, projectRoot?: string}} data - Request
 */
function runSandboxForWorker(data) {
  /** @type {Record<string, any>} */
  const capabilities = {};
  for (const { name, callable } of data.descriptors) {
    capabilities[name] = callable
      ? (/** @type {unknown[]} */ ...args) => callWorkerCapability(data.id, name, null, args)
      : new Proxy({}, {
        get: (_t, /** @type {string} */ method) =>
          (/** @type {unknown[]} */ ...args) => callWorkerCapability(data.id, name, method, args)
      });
  }
  // Forward the engine's live project root (from the worker realm) so the
  // sandbox binding tracks a runtime project switch instead of the frozen
  // sandbox.html template value.
  const controller = new AbortController();
  runControllers.set(data.id, controller);
  runInSandbox(data.code, {
    capabilities,
    timeoutMs: data.timeoutMs,
    projectRoot: data.projectRoot,
    signal: controller.signal,
    onConsole: (text) => worker.postMessage({ type: 'sandbox-console', id: data.id, text })
  })
    .then((result) => worker.postMessage({ type: 'sandbox-result', id: data.id, ok: true, result }))
    .catch((err) => worker.postMessage({
      type: 'sandbox-result', id: data.id, ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .finally(() => {
      runControllers.delete(data.id);
      abandonCapCalls(data.id);
    });
}

worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const data = event.data || {};
  if (data.type === 'ready') {
    /** @type {any} */ (window).__engineReady = true;
    console.info('[EngineWorkerHost] Engine worker ready');
    return;
  }
  if (data.type === 'sandbox-run') {
    runSandboxForWorker(data);
    return;
  }
  if (data.type === 'sandbox-abort') {
    runControllers.get(data.id)?.abort();
    return;
  }
  if (data.type === 'sandbox-cap-reply') {
    const pending = pendingCapCalls.get(data.callId);
    if (pending) {
      pendingCapCalls.delete(data.callId);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error || 'capability error'));
    }
    return;
  }
  if (data.type === 'log') {
    const level = data.level || 'info';
    /** @type {any} */ (console)[level]?.('[EngineWorker]', ...data.args);
    return;
  }
  if (data.type === 'error') {
    console.error('[EngineWorker]', data.message, data.stack || '');
  }
};

worker.onerror = (/** @type {ErrorEvent} */ event) => {
  console.error('[EngineWorkerHost] Worker error:', event.message, event.filename, event.lineno);
};

// The worker builds its own WebSocket URL from self.location; pass the asset
// prefix, the base path the page was served under, and the per-instance API
// token so worker-side /api fetches reach this server and satisfy the
// production auth gate (the viewer gets the same token via index.html's fetch
// shim, but workers do not inherit that shim).
worker.postMessage({
  type: 'start',
  assetPrefix: /** @type {any} */ (window).__assetPrefix || '',
  apiBase: /** @type {any} */ (window).__jugglerBase || '',
  apiToken: /** @type {any} */ (window).__jugglerToken || ''
});

/** @type {any} */ (window).__jugglerEngineWorker = worker;

export {};
