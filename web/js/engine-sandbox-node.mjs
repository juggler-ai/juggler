//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node engine host's explore_code sandbox delegate — the main-thread half of the
 * worker_threads sandbox.
 *
 * sandbox-runner.js (web/sdk/lib) calls `globalThis.__hostSandboxDelegate(code,
 * capabilities, timeoutMs)` when it has no `document`. In the webview worker that
 * delegate forwards to the main-thread iframe host; here — the Node engine runs
 * on this very thread, where the real fs/grep/glob closures live — it spawns an
 * isolated worker_threads Worker (engine-sandbox-worker.mjs) to run the untrusted
 * code, services each capability call the worker RPCs back, and terminates the
 * worker on timeout. The untrusted code never runs on this thread.
 */

/**
 * Install the Node explore_code sandbox delegate on globalThis, replacing the
 * boot-time "not supported" rejection.
 * @param {{ origin: string, token: string, projectRoot: string }} opts
 */
export function installNodeSandboxDelegate({ origin, token, projectRoot }) {
  /**
   * @param {string} code - Untrusted JavaScript to run
   * @param {Record<string, any>} capabilities - Named fs/grep/glob closures
   * @param {number} timeoutMs - Wall-clock budget
   * @returns {Promise<unknown>} The script's return value
   */
  /** @type {any} */ (globalThis).__hostSandboxDelegate = (code, capabilities, timeoutMs) =>
    runInWorkerSandbox(code, capabilities, timeoutMs, { origin, token, projectRoot });
}

/**
 * Run one explore_code script in an isolated worker_threads Worker.
 * @param {string} code
 * @param {Record<string, any>} capabilities
 * @param {number} timeoutMs
 * @param {{ origin: string, token: string, projectRoot: string }} env
 * @returns {Promise<unknown>}
 */
async function runInWorkerSandbox(code, capabilities, timeoutMs, env) {
  const { Worker } = await import('node:worker_threads');
  const descriptors = Object.entries(capabilities).map(([name, cap]) => ({
    name,
    callable: typeof cap === 'function',
  }));

  // Read the LIVE project root (kept current across a runtime project switch by
  // session.js _applyEngineProjectRoot), falling back to the boot value from the
  // delegate closure. The Node engine runs on this same thread, so the global is
  // in step with the loaded project.
  const liveProjectRoot = /** @type {any} */ (globalThis).__jugglerProjectRoot ?? env.projectRoot;

  const worker = new Worker(new URL('./engine-sandbox-worker.mjs', import.meta.url), {
    workerData: {
      origin: env.origin,
      token: env.token,
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
    const killTimer = setTimeout(() => {
      finish(reject, new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs + 250);

    /**
     * Settle once, tearing the worker down.
     * @param {Function} done @param {unknown} value
     */
    function finish(done, value) {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      worker.terminate();
      done(value);
    }

    worker.on('message', async (msg) => {
      if (!msg) return;
      if (msg.kind === 'result') {
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || 'sandbox script error'));
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
      reject(new Error(`explore_code sandbox worker exited (${exitCode}) before returning a result`));
    });
  });
}
