//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A module worker that runs the PDF viewer's `extract()` the way the engine
 * does: with no document, the asset prefix set as engine-worker-runtime.js sets
 * it, and the viewer imported through the server's `/worker-module` loader (the
 * route `importModuleUrl` takes when there is no document). There
 * `import.meta.url` is the loader URL, not the module's own path, which is what
 * a viewer resolving its vendored assets has to get right.
 *
 * Message in: `{assetPrefix, viewerPath, path, bytes}`. Message out:
 * `{done: true, result}` or `{done: true, error}`. PDF.js's worker code posts a
 * `ready` message of its own when it loads in a worker scope; the `done` flag is
 * what tells the two apart.
 * @module js-tests/utilities/pdf-extract-worker
 */

self.onmessage = async (/** @type {MessageEvent} */ event) => {
  const { assetPrefix, viewerPath, path, bytes } = event.data;
  /** @type {any} */ (globalThis).__assetPrefix = assetPrefix;
  try {
    const { default: PdfFileViewer } = await import(`/worker-module?url=${encodeURIComponent(assetPrefix + viewerPath)}`);
    const data = new Uint8Array(bytes);
    const source = {
      path,
      absPath: path,
      mime: 'application/pdf',
      size: data.length,
      isBinary: true,
      url: () => { throw new Error('no URL transport in the engine'); },
      bytes: async () => data,
    };
    const result = await new PdfFileViewer().extract(source, {});
    self.postMessage({ done: true, result });
  } catch (err) {
    self.postMessage({ done: true, error: String(/** @type {any} */ (err)?.message || err) });
  }
};
