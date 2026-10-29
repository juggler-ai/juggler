//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node engine host's query_code sandbox delegate — the main-thread half of the
 * worker_threads sandbox.
 *
 * sandbox-runner.js (web/sdk/lib) calls `globalThis.__hostSandboxDelegate(code,
 * capabilities, timeoutMs, callerRoot, hooks)` when it has no `document`. In the
 * webview worker that delegate forwards to the main-thread iframe host; here —
 * the Node engine runs on this very thread, where the real fs/grep/glob closures
 * live — it spawns an isolated worker_threads Worker (engine-sandbox-worker.mjs)
 * to run the untrusted code, services each capability call the worker RPCs back,
 * and terminates the worker on timeout, if the run has one, or when the caller's
 * signal aborts — for a run with no deadline (timeoutMs 0), the signal is the
 * only end. The untrusted code never runs on this thread.
 */

import { createHmac } from 'node:crypto';

/**
 * Install the Node query_code sandbox delegate on globalThis, replacing the
 * boot-time "not supported" rejection.
 * The sandbox is given no API token. It loads project modules from beneath
 * `<origin>/sandbox-import/<capability>`, where the capability is derived from
 * the token here (sandboxImportCapability) and is good for nothing else.
 * @param {{ origin: string, projectRoot: string }} opts
 */
export function installNodeSandboxDelegate({ origin, projectRoot }) {
  /**
   * @param {string} code - Untrusted JavaScript to run
   * @param {Capabilities} capabilities - Named fs/grep/glob closures
   * @param {number} timeoutMs - Wall-clock budget, or 0 for none (the run then
   *   ends only through `hooks.signal`)
   * @param {string} [callerRoot] - The root the caller works in, POSIX-form
   * @param {RunHooks} [hooks] - The caller's abort signal and console sink
   * @returns {Promise<unknown>} The script's return value
   */
  globalThis.__hostSandboxDelegate = (code, capabilities, timeoutMs, callerRoot, hooks) =>
    runInWorkerSandbox(code, capabilities, timeoutMs, { origin, projectRoot }, callerRoot, hooks);
}

/**
 * The capability project-module imports carry: HMAC-SHA256 of the label
 * "juggler-sandbox-import" keyed by the API token, as hex — the same value as
 * sandboxImportCapability in web/sdk/lib/sandbox-runner.js and the server's in
 * cmd/juggler/server/sandbox_files.go, which answers only for it.
 * @param {string} apiToken - The per-instance API token
 * @returns {string} The capability, or "" with no token
 */
function sandboxImportCapability(apiToken) {
  if (!apiToken) return '';
  return createHmac('sha256', apiToken).update('juggler-sandbox-import').digest('hex');
}

/**
 * What a script may call: a function, or an object whose methods it calls.
 * @typedef {Record<string, Function | Record<string, Function>>} Capabilities
 */

/**
 * @typedef {object} RunHooks
 * @property {AbortSignal} [signal] - Aborting terminates the run's Worker
 * @property {(line: string) => void} [onConsole] - Receives each console line
 *   the script writes, as it is written
 */

/**
 * Run one query_code script in an isolated worker_threads Worker.
 * @param {string} code
 * @param {Capabilities} capabilities
 * @param {number} timeoutMs - Wall-clock budget, or 0 for none
 * @param {{ origin: string, projectRoot: string }} env
 * @param {string} [callerRoot]
 * @param {RunHooks} [hooks]
 * @returns {Promise<unknown>} The script's return value
 */
async function runInWorkerSandbox(code, capabilities, timeoutMs, env, callerRoot, { signal, onConsole } = {}) {
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  if (signal?.aborted) throw abortError();
  const { Worker } = await import('node:worker_threads');
  if (signal?.aborted) throw abortError();
  const descriptors = Object.entries(capabilities).map(([name, cap]) => ({
    name,
    callable: typeof cap === 'function',
  }));

  // The caller's own root when it named one — a tool's is its conversation's
  // workspace, which is not necessarily the project. Otherwise the LIVE project
  // root (kept current across a runtime project switch by session.js
  // _applyEngineProjectRoot), falling back to the boot value from the delegate
  // closure. The Node engine runs on this same thread, so the global is in step
  // with the loaded project.
  const liveProjectRoot =
    callerRoot || (globalThis.__jugglerProjectRoot ?? env.projectRoot);

  const importBase = `${env.origin}/sandbox-import/${
    sandboxImportCapability(globalThis.__jugglerToken || '') || '-'}`;
  const worker = new Worker(new URL('./engine-sandbox-worker.mjs', import.meta.url), {
    workerData: {
      origin: env.origin,
      importBase,
      projectRoot: liveProjectRoot,
      code,
      timeoutMs,
      descriptors,
    },
  });

  let settled = false;
  return new Promise((resolve, reject) => {
    // Backstop timeout: a synchronously-hanging script never lets the worker's
    // own timer fire, so terminate it from here. The +250ms grace lets the
    // worker's in-band timeout win (a cleaner message) when the hang is async.
    // None when the run has no deadline (timeoutMs 0): the signal ends it.
    const killTimer = timeoutMs > 0 ? setTimeout(() => {
      finish(reject, new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs + 250) : undefined;

    /**
     * Settle once, tearing the worker down.
     * @param {Function} done
     * @param {unknown} value
     */
    function finish(done, value) {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      done(value);
    }

    /**
     * Escape: kill the script, not just the wait for it. A run left alive
     * would go on servicing capability calls until its own timeout — and a run
     * with no deadline, for good.
     */
    function onAbort() {
      finish(reject, abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', async (msg) => {
      if (!msg) return;
      if (msg.kind === 'result') {
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || 'sandbox script error'));
        return;
      }
      if (msg.kind === 'console') {
        if (!settled) onConsole?.(String(msg.text));
        return;
      }
      if (msg.kind === 'cap') {
        if (settled) return;
        try {
          const cap = capabilities[msg.name];
          if (cap === undefined) throw new Error(`unknown capability: ${msg.name}`);
          const value = typeof cap === 'function'
            ? await cap(...(msg.args || []))
            : await cap[msg.method](...(msg.args || []));
          if (!settled) worker.postMessage({ kind: 'reply', id: msg.id, ok: true, value });
        } catch (err) {
          if (!settled) {
            worker.postMessage({
              kind: 'reply', id: msg.id, ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    });

    worker.on('error', (err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`query_code sandbox worker exited (${exitCode}) before returning a result`));
    });
  });
}
