//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extractErrorMessage } from '../sdk/lib/error-utils.js';

/**
 * The engine worker's half of the query_code sandbox bridge.
 *
 * query_code runs untrusted JS in an opaque-origin iframe, which needs a
 * `document` the worker does not have. The worker therefore delegates the iframe
 * to the main-thread host (engine-worker-main.js) and services the script's
 * capability calls (fs/grep/glob) back here, where their closures live. The
 * untrusted code never runs in the worker — only the capability servicing does.
 *
 * Split out from the worker bootstrap so its backstops can be exercised. A run
 * with a deadline has the timeout below; a run with none (timeoutMs 0) has only
 * its caller's signal. One or the other is all that stands between a host that
 * never answers and a tool that sits at `running` for the rest of the session.
 * @module engine-worker-sandbox
 */

/**
 * Headroom over the script's own budget before this realm gives up waiting for
 * the host to answer.
 *
 * The script's timeout is enforced on the OTHER side of a postMessage boundary,
 * on the main thread, and so is the wait for the sandbox iframe to boot — which
 * is why this realm needs a backstop at all. It must therefore exceed
 * SANDBOX_READY_TIMEOUT_MS in web/sdk/lib/sandbox-runner.js, or a first
 * query_code that merely waits out a slow frame boot would be failed here while
 * the host is still doing exactly what it should.
 *
 * The main thread it waits on is deliberately allowed to throttle — the engine's
 * WebView is hidden and KeepRunningWhenHidden is disabled — so the grace is
 * wide. It only has to be finite: without it, a host that never posts
 * `sandbox-result` (a wedged main thread, an iframe that never signals ready)
 * leaves the delegate's promise pending forever, with a live heartbeat and no
 * record anywhere that anything is wrong. A run with no deadline gets no grace
 * timer at all; its caller's signal is the backstop instead, and settles the run
 * here without waiting for the host.
 */
const SANDBOX_DELEGATE_GRACE_MS = 30000;

/**
 * @typedef {object} RunHooks
 * @property {AbortSignal} [signal] - Aborting settles the run at once and tells
 *   the host to terminate it
 * @property {(line: string) => void} [onConsole] - Receives each console line
 *   the script writes, relayed from the host as it is written
 */

/**
 * The bindings a query_code script is given, by name: each a function it calls
 * directly, or an object whose methods it calls by name.
 * @typedef {NonNullable<import('../sdk/lib/sandbox-runner.js').RunInSandboxOptions['capabilities']>} SandboxCapabilities
 */

/**
 * What the bridge posts to the main-thread host.
 * @typedef {{type: 'sandbox-run', id: string, code: string, timeoutMs: number,
 *   descriptors: Array<{name: string, callable: boolean}>, projectRoot: string|undefined}
 *   | {type: 'sandbox-abort', id: string}
 *   | {type: 'sandbox-cap-reply', id: string, callId: string, ok: true, value: unknown}
 *   | {type: 'sandbox-cap-reply', id: string, callId: string, ok: false, error: string}} SandboxHostMessage
 */

/**
 * A `sandbox-console` line from the host.
 * @typedef {{id: string, text: unknown}} SandboxConsoleMessage
 */

/**
 * A `sandbox-result` from the host.
 * @typedef {{id: string, ok: boolean, result?: unknown, error?: string}} SandboxResultMessage
 */

/**
 * A `sandbox-cap` call from the host's iframe: `method` is null for a callable
 * capability.
 * @typedef {{id: string, callId: string, name: string, method: string|null, args?: unknown[]}} SandboxCapMessage
 */

/**
 * The delegate sandbox-runner.js calls through `globalThis.__hostSandboxDelegate`.
 * @typedef {(code: string, capabilities: SandboxCapabilities, timeoutMs: number,
 *   callerRoot?: string, hooks?: RunHooks) => Promise<unknown>} SandboxDelegate
 */

/**
 * Build the worker-side sandbox bridge.
 * @param {object} opts - Bridge options
 * @param {(message: SandboxHostMessage) => void} opts.post - Post a message to the main-thread host
 * @param {number} [opts.graceMs] - Override for {@link SANDBOX_DELEGATE_GRACE_MS} (tests)
 * @param {(fn: () => void, ms: number) => ReturnType<typeof setTimeout>} [opts.setTimer] - Arms the
 *   backstop timer; `setTimeout` unless a test needs to see what is armed
 * @returns {{delegate: SandboxDelegate,
 *   handleResult: (data: SandboxResultMessage) => void, handleCap: (data: SandboxCapMessage) => Promise<void>,
 *   handleConsole: (data: SandboxConsoleMessage) => void,
 *   pendingCount: () => number}}
 *   The delegate to install on globalThis, and the inbound message handlers.
 */
export function createSandboxBridge({ post, graceMs = SANDBOX_DELEGATE_GRACE_MS, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let sandboxSeq = 0;
  /** @type {Map<string, {resolve: (value: unknown) => void, reject: (reason: unknown) => void, capabilities: SandboxCapabilities, timer: ReturnType<typeof setTimeout>|undefined, detach: () => void, onConsole?: (line: string) => void}>} */
  const pending = new Map();

  /**
   * Settle one pending run and drop its bookkeeping. Dropping matters as much as
   * settling: each entry retains the run's capability closures, and through them
   * the ReadOnlyFileSystem and its read history for the whole call.
   * @param {string} id - Sandbox run id
   * @param {boolean} ok - Whether the run produced a result
   * @param {unknown} value - The result, or the Error to reject with
   */
  function settle(id, ok, value) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.detach();
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  return {
    /**
     * Run one query_code script on the host's iframe sandbox.
     * @param {string} code - Untrusted JavaScript
     * @param {SandboxCapabilities} capabilities - Named fs/grep/glob closures
     * @param {number} timeoutMs - The script's own wall-clock budget, or 0 for
     *   none (the run then ends only through `hooks.signal`)
     * @param {string} [callerRoot] - The root the caller works in, POSIX-form
     * @param {RunHooks} [hooks] - The caller's abort signal and console sink
     * @returns {Promise<unknown>} The script's return value
     */
    delegate(code, capabilities, timeoutMs, callerRoot, { signal, onConsole } = {}) {
      const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
      if (signal?.aborted) return Promise.reject(abortError());
      const id = `sbx_${++sandboxSeq}`;
      const descriptors = Object.entries(capabilities).map(([name, cap]) => ({
        name,
        callable: typeof cap === 'function'
      }));
      // What the sandbox exposes as `projectRoot` is the caller's own root when
      // it has one — a tool's is its conversation's workspace, which is not
      // necessarily the project. A caller that names none falls back to the live
      // engine value (seeded from the session manifest — see
      // SessionPersistence), NOT the frozen sandbox.html template. This realm
      // (the engine worker) is where the session runs and keeps it current; the
      // main-thread iframe host can't read this worker's global, so pass it across.
      const projectRoot = callerRoot || /** @type {{__jugglerProjectRoot?: string}} */ (globalThis).__jugglerProjectRoot;
      return new Promise((resolve, reject) => {
        // A run with no deadline (timeoutMs 0) has no answer to give up on: its
        // caller ends it through the signal.
        const timer = timeoutMs > 0 ? setTimer(
          () => settle(id, false, new Error(
            `query_code: the sandbox host never answered within ${timeoutMs + graceMs}ms`)),
          timeoutMs + graceMs
        ) : undefined;
        // The run's Worker lives on the host, so stopping it takes a message.
        // Settle here without waiting for the host's reply: the caller asked to
        // stop, and a host that never answers must not hold it.
        const onAbort = () => {
          post({ type: 'sandbox-abort', id });
          settle(id, false, abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const detach = () => signal?.removeEventListener('abort', onAbort);
        pending.set(id, { resolve, reject, capabilities, timer, detach, onConsole });
        post({ type: 'sandbox-run', id, code, timeoutMs, descriptors, projectRoot });
      });
    },

    /**
     * Apply a `sandbox-console` line from the host to its run's console sink.
     * A line for a run that has already settled is dropped.
     * @param {SandboxConsoleMessage} data - The line and its run
     */
    handleConsole(data) {
      pending.get(data.id)?.onConsole?.(String(data.text));
    },

    /**
     * Apply a `sandbox-result` from the host.
     * @param {SandboxResultMessage} data - The run's outcome
     */
    handleResult(data) {
      if (data.ok) settle(data.id, true, data.result);
      else settle(data.id, false, new Error(data.error || 'sandbox script error'));
    },

    /**
     * Service one capability call requested by the host's sandbox iframe.
     * @param {SandboxCapMessage} data - The call
     * @returns {Promise<void>} Resolves once the reply has been posted
     */
    async handleCap(data) {
      const entry = pending.get(data.id);
      try {
        if (!entry) throw new Error(`no pending sandbox ${data.id}`);
        const cap = entry.capabilities[data.name];
        if (cap === undefined) throw new Error(`unknown capability: ${data.name}`);
        const args = data.args || [];
        let value;
        if (typeof cap === 'function') {
          value = await cap(...args);
        } else {
          const method = data.method === null ? undefined : /** @type {Record<string, unknown>} */ (cap)[data.method];
          if (typeof method !== 'function') throw new TypeError(`capability ${data.name} has no method ${data.method}`);
          value = await method.apply(cap, args);
        }
        post({ type: 'sandbox-cap-reply', id: data.id, callId: data.callId, ok: true, value });
      } catch (err) {
        post({
          type: 'sandbox-cap-reply', id: data.id, callId: data.callId, ok: false,
          error: extractErrorMessage(err)
        });
      }
    },

    /**
     * How many runs are outstanding. The leak witness: this must return to zero.
     * @returns {number} Outstanding run count
     */
    pendingCount() {
      return pending.size;
    }
  };
}
