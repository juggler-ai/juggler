//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The diff worker: computes `<diff-viewer>` snapshots (lib/diff-snapshot.js)
 * off the page's thread, for lib/diff-snapshot-client.js.
 *
 * A classic worker, not a module one, because Prism is a classic script that
 * declares a global and its grammars are scripts that extend it — `importScripts`
 * is the only way to give them one global between them. The page names the
 * Prism scripts it loaded in its first message, so the worker highlights with
 * exactly the grammars the page has and no list of them is kept twice. The diff
 * code itself is an ES module, loaded with `import()`.
 *
 * Messages in: `{type: 'init', scripts}` once, then `{type: 'job', id, input}`.
 * Messages out: `{id, result}` or `{id, error}`.
 */

/**
 * The worker global as this file uses it: Prism's opt-out flag is a property
 * Prism reads off the global before it loads.
 * @typedef {object} DiffWorkerScope
 * @property {{ disableWorkerMessageHandler: boolean }} Prism - Prism's global, pre-seeded
 * @property {((event: MessageEvent) => void)|null} onmessage - Message handler
 * @property {(...urls: string[]) => void} importScripts - Classic-worker script loader
 * @property {(message: unknown) => void} postMessage - Reply to the page
 * @property {{href: string}} location - The worker script's location
 */

const scope = /** @type {DiffWorkerScope} */ (/** @type {unknown} */ (self));

// Prism, loaded into a worker, installs a message handler of its own that
// answers highlight requests; this worker's messages are not those.
scope.Prism = { disableWorkerMessageHandler: true };

/** @type {Promise<typeof import('../lib/diff-snapshot.js')>|null} */
let snapshotModule = null;

scope.onmessage = async (/** @type {MessageEvent} */ event) => {
  const data = event.data || {};
  if (data.type === 'init') {
    const scripts = Array.isArray(data.scripts) ? data.scripts : [];
    if (scripts.length > 0) scope.importScripts(...scripts);
    return;
  }
  if (data.type !== 'job') return;
  try {
    snapshotModule ??= import(new URL('../lib/diff-snapshot.js', scope.location.href).href);
    const { buildSnapshot } = await snapshotModule;
    scope.postMessage({ id: data.id, result: buildSnapshot(data.input) });
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : JSON.stringify(error) });
  }
};
