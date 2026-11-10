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
import { apiUrl } from './utils/api-url.js';

/**
 * The globals engine.html templates onto this window, and the two this host
 * publishes back onto it.
 * @typedef {object} EngineHostGlobals
 * @property {string} [__assetPrefix] - Version-prefixed asset base
 * @property {string} [__jugglerBase] - Base path the page was served under
 * @property {string} [__jugglerToken] - Per-instance API token
 * @property {boolean} [__engineReady] - Set once the worker reports ready
 * @property {Worker} [__jugglerEngineWorker] - The engine worker
 */

/**
 * Everything the engine worker posts to this host.
 * @typedef {{type: 'ready'}
 *   | {type: 'pong'}
 *   | {type: 'fetch-start', id: number, url: string, method: string}
 *   | {type: 'fetch-end', id: number}
 *   | import('./engine-worker-sandbox.js').SandboxHostMessage
 *   | {type: 'log', level?: 'debug'|'info'|'log'|'warn'|'error', args: string[]}
 *   | {type: 'error', message: string, stack?: string}} EngineWorkerOutbound
 */

const hostGlobals = /** @type {EngineHostGlobals} */ (/** @type {unknown} */ (window));

console.info('[EngineWorkerHost] Starting worker-backed engine');

const worker = new Worker(`${hostGlobals.__assetPrefix || ''}/js/engine-worker-runtime.js`, { type: 'module' });

// ── Sandbox bridge ─────────────────────────────────────────────────────────
// The worker can't create the query_code isolation iframe (no document), so
// it asks us to run it here. We run the real iframe sandbox and forward each of
// the script's capability calls back to the worker (where fs/grep/glob live).
let capCallSeq = 0;
/** @type {Map<string, {runId: string, resolve: (value: unknown) => void, reject: (reason: unknown) => void}>} */
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
  /** @type {import('./engine-worker-sandbox.js').SandboxCapabilities} */
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
  // sandbox binding follows the loaded session rather than the frozen
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

// ── Worker watchdog ────────────────────────────────────────────────────────
// The server evicts an engine whose worker goes quiet (engine_liveness.go), but
// from there it cannot tell a worker that stopped from a page that stopped, nor
// say what the worker was waiting on. This host can: it pings the worker, keeps
// the fetches the worker has in flight and its last console warnings, and
// reports all of it to the app log when the worker stops answering. No report
// beside an eviction means this thread stopped too.

/** How often the host pings the worker. */
const WATCHDOG_TICK_MS = 5_000;
/** How long the worker may go unheard before it is reported: inside the server's 30s eviction window, so the report lands first. */
const WORKER_SILENCE_REPORT_MS = 20_000;
/** How many of the worker's console warnings and errors the report carries. */
const RECENT_LOG_LINES = 20;

let lastWorkerMessageAt = Date.now();
let lastTickAt = Date.now();
let silenceReported = false;
/** @type {Map<number, {url: string, method: string, at: number}>} */
const inFlightFetches = new Map();
/** @type {string[]} */
const recentLogs = [];

/**
 * Post a report to the app log. Errors are dropped: there is nowhere else to
 * put them.
 * @param {string} event - 'error' logs at Error, anything else at Info
 * @param {string} message - The report
 */
function reportToServer(event, message) {
  fetch(apiUrl('/client/report'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Juggler-Token': hostGlobals.__jugglerToken || '' },
    body: JSON.stringify({ source: 'engine-host', event, message })
  }).catch(() => {});
}

/**
 * What the worker was doing when it went quiet.
 * @param {number} now - Current time
 * @returns {string} The fetches it had in flight and its recent console lines
 */
function describeWorkerState(now) {
  const fetches = [...inFlightFetches.values()]
    .map((f) => `  ${f.method} ${f.url} (${Math.round((now - f.at) / 1000)}s)`);
  return `in-flight fetches: ${fetches.length ? `\n${fetches.join('\n')}` : 'none'}\n` +
    `recent worker console: ${recentLogs.length ? `\n${recentLogs.join('\n')}` : 'none'}`;
}

setInterval(() => {
  const now = Date.now();
  // A gap between ticks means this thread was not running either, so the
  // worker's silence over it is no evidence against the worker: start over.
  if (now - lastTickAt > 2 * WATCHDOG_TICK_MS) lastWorkerMessageAt = now;
  lastTickAt = now;
  const silentFor = now - lastWorkerMessageAt;
  if (!silenceReported && silentFor >= WORKER_SILENCE_REPORT_MS) {
    silenceReported = true;
    reportToServer('error', `worker silent for ${Math.round(silentFor / 1000)}s while this thread runs; ` +
      describeWorkerState(now));
  }
  worker.postMessage({ type: 'ping' });
}, WATCHDOG_TICK_MS);

window.addEventListener('error', (event) => {
  reportToServer('error', `host error: ${event.message} (${event.filename}:${event.lineno})`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportToServer('error', `host unhandledrejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const data = /** @type {EngineWorkerOutbound} */ (event.data || {});
  const now = Date.now();
  if (silenceReported) {
    silenceReported = false;
    reportToServer('info', `worker answered again after ${Math.round((now - lastWorkerMessageAt) / 1000)}s`);
  }
  lastWorkerMessageAt = now;
  if (data.type === 'pong') return;
  if (data.type === 'fetch-start') {
    inFlightFetches.set(data.id, { url: data.url, method: data.method, at: now });
    return;
  }
  if (data.type === 'fetch-end') {
    inFlightFetches.delete(data.id);
    return;
  }
  if (data.type === 'ready') {
    hostGlobals.__engineReady = true;
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
    console[level]?.('[EngineWorker]', ...data.args);
    recentLogs.push(`  [${new Date(now).toISOString()}] ${level}: ${data.args.join(' ').slice(0, 300)}`);
    if (recentLogs.length > RECENT_LOG_LINES) recentLogs.shift();
    return;
  }
  if (data.type === 'error') {
    console.error('[EngineWorker]', data.message, data.stack || '');
  }
};

worker.onerror = (/** @type {ErrorEvent} */ event) => {
  console.error('[EngineWorkerHost] Worker error:', event.message, event.filename, event.lineno);
  reportToServer('error', `worker error event: ${event.message} (${event.filename}:${event.lineno})`);
};

// The worker builds its own WebSocket URL from self.location; pass the asset
// prefix, the base path the page was served under, and the per-instance API
// token so worker-side /api fetches reach this server and satisfy the
// production auth gate (the viewer gets the same token via index.html's fetch
// shim, but workers do not inherit that shim).
worker.postMessage({
  type: 'start',
  assetPrefix: hostGlobals.__assetPrefix || '',
  apiBase: hostGlobals.__jugglerBase || '',
  apiToken: hostGlobals.__jugglerToken || ''
});

hostGlobals.__jugglerEngineWorker = worker;

export {};
