//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { extractErrorMessage } from './error-utils.js';

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
 * Lazily create the hidden sandbox iframe and resolve once it has signalled
 * readiness. Cached across calls so subsequent runs reuse the same frame.
 * @returns {Promise<HTMLIFrameElement>} The ready iframe
 */
function getSandboxFrame() {
  if (_sandboxFramePromise) return _sandboxFramePromise;
  _sandboxFramePromise = new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('hidden', '');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.display = 'none';
    iframe.src = '/sandbox';

    let settled = false;
    /** @param {MessageEvent} e */
    const onReady = (e) => {
      if (settled) return;
      if (e.source !== iframe.contentWindow) return;
      if (!e.data || e.data.type !== 'sandbox-ready') return;
      settled = true;
      window.removeEventListener('message', onReady);
      resolve(iframe);
    };
    window.addEventListener('message', onReady);
    iframe.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onReady);
      reject(new Error('sandbox iframe failed to load'));
    });
    document.body.appendChild(iframe);
  });
  return _sandboxFramePromise;
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
 * @property {string} [projectRoot] - Override for the `projectRoot` built-in.
 *   When omitted, the iframe falls back to its serve-time template value. The
 *   engine passes its live root here so the binding tracks a runtime project
 *   switch instead of the frozen boot value.
 */

/**
 * Execute `code` in the sandbox iframe and resolve with its return value.
 * @param {string} code - JavaScript source. Runs as an async ES module body;
 *   may `await` and `return` a value, and `import()` absolute project paths.
 * @param {RunInSandboxOptions} [options] - Capabilities and timeout.
 * @returns {Promise<unknown>} The code's return value (null if it returned
 *   undefined).
 */
export async function runInSandbox(code, { capabilities = {}, timeoutMs = 30000, projectRoot = undefined } = {}) {
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
    return delegate(code, capabilities, timeoutMs);
  }

  const iframe = await getSandboxFrame();
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
  contentWindow.postMessage({ type: 'sandbox-execute', code, timeoutMs, capabilities: descriptors, projectRoot }, '*', [channel.port2]);

  return Promise.race([done, timer]);
}
