//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { extractErrorMessage } from './error-utils.js';
import { serverPath } from '../../js/utils/api-url.js';

/**
 * Host sandbox service: execute an untrusted JavaScript string in an isolated
 * iframe and return its result.
 *
 * The host page's CSP forbids 'unsafe-eval', so arbitrary code can't run here.
 * Instead we load `/sandbox` — a same-origin page with its own CSP — into a
 * hidden, `sandbox`ed iframe (`allow-scripts` without `allow-same-origin`, so
 * the frame has an opaque origin and no DOM/storage/cookie access to this
 * page). The code runs inside that frame; the only channel out is a
 * MessagePort over which the frame's capability calls are forwarded back here,
 * so it never touches the privileged backend directly.
 *
 * A module singleton: there is one logical sandbox frame per page, lazily
 * created and reused across calls.
 */

/** @type {Promise<HTMLIFrameElement>|null} */
let _sandboxFramePromise = null;

/**
 * Forward-slash a root for the sandbox's `projectRoot` binding.
 *
 * The roots a caller has to hand are OS-native (backslash-separated on Windows),
 * because the rest of the client compares them against other native paths. The
 * binding is contracted to be POSIX-style — the `path` built-in beside it is
 * POSIX, and `glob({cwd})` relativizes its results (which the backend always
 * returns forward-slashed) by stripping that `cwd` as a prefix. A native Windows
 * root would never match, so the model would get absolute paths back from a
 * `{cwd: projectRoot}` glob.
 *
 * Exported because the boot-time roots are seeded on another path entirely — the
 * engine's global, from the env var or the sandbox HTML template — and the two
 * have to agree on the form. The Go seams that fill those apply the same
 * normalization.
 * @param {string} [root] - A root in OS-native form
 * @returns {string} The root with forward slashes ("" for none)
 */
export function toSandboxRoot(root) {
  return (root || '').replace(/\\/g, '/');
}

/**
 * How long the frame has to signal readiness before the attempt is abandoned.
 *
 * Generous, because this runs on a main thread that is allowed to be throttled:
 * the engine's WebView is hidden and `KeepRunningWhenHidden` is disabled, so the
 * thread booting this iframe may be scheduled sparsely. The number only has to
 * be small enough that a failed boot surfaces as an error the caller can report
 * instead of a promise nobody ever settles.
 */
const SANDBOX_READY_TIMEOUT_MS = 15000;

/**
 * Lazily create the hidden sandbox iframe and resolve once it has signalled
 * readiness. Cached across calls so subsequent runs reuse the same frame.
 *
 * Only a SUCCESSFUL frame is cached. Caching the promise unconditionally makes
 * one bad boot permanent: every later call would await the same rejected
 * promise, so a single missed `sandbox-ready` would disable query_code for the
 * life of the realm.
 * @returns {Promise<HTMLIFrameElement>} The ready iframe
 */
function getSandboxFrame() {
  if (_sandboxFramePromise) return _sandboxFramePromise;
  const attempt = new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('hidden', '');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.display = 'none';
    iframe.src = serverPath('/sandbox');

    let settled = false;
    /** @type {any} */
    let readyTimer = null;
    /** @param {Error} [err] - Rejection cause; resolves with the frame when absent */
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      window.removeEventListener('message', onReady);
      if (!err) { resolve(iframe); return; }
      iframe.remove();
      reject(err);
    };
    /** @param {MessageEvent} e */
    const onReady = (e) => {
      if (e.source !== iframe.contentWindow) return;
      if (!e.data || e.data.type !== 'sandbox-ready') return;
      settle();
    };
    window.addEventListener('message', onReady);
    iframe.addEventListener('error', () => settle(new Error('sandbox iframe failed to load')));
    readyTimer = setTimeout(
      () => settle(new Error(`sandbox iframe never signalled ready within ${SANDBOX_READY_TIMEOUT_MS}ms`)),
      SANDBOX_READY_TIMEOUT_MS
    );
    document.body.appendChild(iframe);
  });
  _sandboxFramePromise = attempt;
  // Drop a failed attempt from the cache so the next call builds a fresh frame.
  // The caller's own await is what reports the failure; this handler exists only
  // to clear the cache (and to keep the rejection from going unobserved when
  // there is no caller left to see it).
  attempt.catch(() => {
    if (_sandboxFramePromise === attempt) _sandboxFramePromise = null;
  });
  return attempt;
}

/**
 * @typedef {object} RunInSandboxOptions
 * @property {Record<string, object|Function>} [capabilities] - Bindings exposed
 *   to the sandboxed code by name. A function is invoked directly
 *   (`name(...args)`); any other object is a namespace whose method calls are
 *   forwarded (`name.method(...args)`). Every call is serviced here, on the
 *   host side of the MessagePort. Names must be valid JS identifiers. The
 *   sandbox also injects the built-ins `path` and `projectRoot`.
 * @property {number} [timeoutMs] - Reject if the code runs longer than this
 *   (default 30000).
 * @property {string} [projectRoot] - The root the code is working in, exposed as
 *   the `projectRoot` built-in. Normalized to POSIX form here. When omitted, the
 *   realm falls back to its own live root (the engine's global) and then to the
 *   frozen serve-time template value — so a caller that has a root of its own,
 *   such as a tool running in a conversation's workspace, must pass it rather
 *   than say nothing.
 * @property {AbortSignal} [signal] - Cancellation. Aborting settles this call
 *   with an AbortError at once and terminates the sandboxed run: whichever host
 *   holds the run's Worker tears it down, so a script cannot go on calling its
 *   capabilities after the caller has stopped listening. Escape has to mean
 *   both.
 * @property {(line: string) => void} [onConsole] - Receives each line the code
 *   writes through `console.*`, as it is written, so output printed before a
 *   throw, a timeout or an abort still arrives. A line is the call's arguments
 *   joined by spaces (non-strings JSON-encoded), prefixed `[warn] ` or
 *   `[error] ` for those levels. The output is capped inside the sandbox, so a
 *   print loop cannot flood the channel: 200 lines, 20000 characters in all,
 *   2000 per line. If it has to cut, it sends one last line saying so. Both
 *   sandbox workers (sandbox.html, engine-sandbox-worker.mjs) implement this,
 *   and must agree. Without this option the output is discarded.
 */

/**
 * Execute `code` in the sandbox iframe and resolve with its return value.
 * @param {string} code - JavaScript source. Runs as an async ES module body;
 *   may `await` and `return` a value, and `import()` absolute project paths.
 * @param {RunInSandboxOptions} [options] - Capabilities and timeout.
 * @returns {Promise<unknown>} The code's return value (null if it returned
 *   undefined).
 */
export async function runInSandbox(code, { capabilities = {}, timeoutMs = 30000, projectRoot = undefined, signal = undefined, onConsole = undefined } = {}) {
  // One normalization for both realms, so a caller passing a native root cannot
  // hand the sandbox a `projectRoot` its own `path` and `glob` disagree with.
  const root = projectRoot === undefined ? undefined : toSandboxRoot(projectRoot);
  // Every exit below races against this, so an abort settles the caller even
  // when the run it is waiting on cannot be reached to be stopped.
  const cancelled = signal
    ? new Promise((_r, reject) => {
      if (signal.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true }
      );
    })
    : null;
  /**
   * @param {Promise<any>} p - The promise to bound by the caller's cancellation
   * @returns {Promise<any>} p, or a rejection the moment the signal aborts
   */
  const withCancel = (p) => (cancelled ? Promise.race([p, cancelled]) : p);

  // Engine worker: no `document`, so this realm can't create the isolation
  // iframe. Delegate to the main-thread host (engine-worker-main), which runs
  // the SAME iframe sandbox and forwards each capability call back here to be
  // serviced — the untrusted code still executes only in the opaque-origin
  // iframe, never in the worker. The hook lives on globalThis (not a module
  // export) so it is shared regardless of how many sandbox-runner instances the
  // worker-module loader materialises.
  if (typeof document === 'undefined') {
    const delegate = /** @type {any} */ (globalThis).__hostSandboxDelegate;
    if (typeof delegate !== 'function') {
      throw new Error('runInSandbox: no host sandbox delegate registered (engine worker)');
    }
    return withCancel(delegate(code, capabilities, timeoutMs, root, { signal, onConsole }));
  }

  const iframe = await withCancel(getSandboxFrame());
  const channel = new MessageChannel();
  const port = channel.port1;

  const done = new Promise((resolve, reject) => {
    port.onmessage = async (e) => {
      const msg = e.data || {};
      if (msg.kind === 'result') {
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || 'sandbox script error'));
        port.close();
        return;
      }
      if (msg.kind === 'console') {
        onConsole?.(String(msg.text));
        return;
      }
      // RPC: a capability call from the sandboxed code. path methods are pure
      // string ops handled inside the iframe and never reach here.
      const { kind, method, args, id } = msg;
      try {
        const cap = /** @type {any} */ (capabilities)[kind];
        if (cap === undefined) throw new Error(`unknown capability: ${kind}`);
        let value;
        if (typeof cap === 'function') {
          value = await cap(...(args || []));
        } else {
          if (typeof cap[method] !== 'function') throw new Error(`${kind}.${method} is not a function`);
          value = await cap[method](...(args || []));
        }
        port.postMessage({ kind: 'reply', id, ok: true, value });
      } catch (err) {
        port.postMessage({ kind: 'reply', id, ok: false, error: extractErrorMessage(err) });
      }
    };
  });

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const contentWindow = iframe.contentWindow;
  if (!contentWindow) throw new Error('sandbox iframe has no contentWindow');
  const descriptors = Object.entries(capabilities).map(([name, cap]) => ({ name, callable: typeof cap === 'function' }));
  contentWindow.postMessage({ type: 'sandbox-execute', code, timeoutMs, capabilities: descriptors, projectRoot: root }, '*', [channel.port2]);

  // Only the frame holds the run's Worker, so stopping it takes a message. The
  // caller has already been answered by `cancelled`; this is the teardown.
  const onAbort = () => {
    try { port.postMessage({ kind: 'abort' }); } catch { /* port already closed: the run is over */ }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const outcome = Promise.race([done, timer]);
  outcome.catch(() => {}).finally(() => signal?.removeEventListener('abort', onAbort));

  return withCancel(outcome);
}
