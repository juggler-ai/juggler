//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { injectStylesOnce } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * One canvas per page, drawn lazily as it scrolls into view. The aspect-ratio
 * is set per page from its viewport, so the box is reserved before the page is
 * drawn and the column does not jump as pages fill in. Injected on first
 * render only: `extract()` runs in the engine, which has no DOM.
 */
const STYLES = `
.pdf-view-pages {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  min-width: 0;
}

.pdf-view-page {
  width: 100%;
  height: auto;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.pdf-view-pagecount {
  font-size: var(--font-size-2xs);
  font-family: var(--font-mono);
  opacity: 0.7;
}
`;

/**
 * Resolve a vendored asset next to this module. Static assets are served under a
 * versioned prefix (`/v<hash>/…`) for cache busting, so an absolute `/js/…` path
 * would 404 — everything must resolve RELATIVE to this module's own path.
 *
 * In the engine worker that path is not `import.meta.url`: modules there are
 * loaded through the server's `/worker-module?url=<path>` loader, so resolving
 * against the loader URL lands on an unversioned `/js/vendor/…` that 404s (and
 * PDF.js reports the missing worker as "Setting up fake worker failed"). There
 * the module's real path is the `url` parameter, which the loader may also have
 * stripped of its version prefix, so the realm's asset prefix is put back.
 * @param {string} rel - Path relative to this module
 * @returns {string} Absolute URL of the vendored asset
 */
function vendorURL(rel) {
  const here = new URL(import.meta.url);
  const modulePath = here.pathname.endsWith('/worker-module') ? here.searchParams.get('url') : null;
  if (!modulePath) return new URL(rel, here).href;
  const resolved = new URL(rel, new URL(modulePath, here.origin));
  const assetPrefix = /** @type {any} */ (globalThis).__assetPrefix || '';
  if (assetPrefix && !resolved.pathname.startsWith(`${assetPrefix}/`)) {
    resolved.pathname = assetPrefix + resolved.pathname;
  }
  return resolved.href;
}

/**
 * Load PDF.js on demand and point it at the vendored worker.
 *
 * The import is deliberately INSIDE the methods that need it: the library is
 * ~1.6 MB, and a realm that never opens a PDF (every engine worker that only
 * reads source files) must not pay for it. The specifier is a literal relative
 * path rather than a variable so the engine worker's module rewriter can
 * redirect it through the worker loader, which has no import map.
 * @returns {Promise<any>} The PDF.js module namespace
 */
async function loadPdfJs() {
  const pdfjs = await import('../../../js/vendor/pdf.min.mjs');
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = vendorURL('../../../js/vendor/pdf.worker.min.mjs');
  } catch {
    // Without a resolvable worker URL PDF.js falls back to its main-thread
    // "fake worker", which still parses and extracts — slower, but correct.
  }
  return pdfjs;
}

/**
 * Open a PDF, choosing the transport the source can actually serve.
 *
 * PDF.js streams from a URL — which is what makes Range-based incremental
 * loading of a large document possible — but its network layer only speaks
 * http(s). A source whose bytes arrive some other way (a `data:` URL, an
 * out-of-project file the content endpoint refuses) is handed the bytes
 * directly instead. Preferring `url()` and falling back to `bytes()` is the
 * same split the image viewer makes, and the reason a FileSource exposes both
 * rather than declaring one transport.
 *
 * Whether the URL was actually used is reported back, because a URL that looks
 * usable can still be refused at load time — the content route serves only
 * files inside the project root — and the caller then retries on bytes.
 * @param {any} pdfjs - The PDF.js module
 * @param {import('juggler/file-source').FileSource} source - The PDF
 * @param {boolean} [preferBytes] - Skip the URL transport (extraction never needs streaming)
 * @returns {Promise<{task: any, viaURL: boolean}>} A PDF.js loading task and the transport it used
 */
async function openDocument(pdfjs, source, preferBytes = false) {
  /** @type {Record<string, any>} */
  const params = {
    standardFontDataUrl: vendorURL('../../../js/vendor/pdf-standard-fonts/'),
    // The base-14 fonts are vendored, so a PDF that omits them still renders;
    // system fonts would vary the output per machine.
    useSystemFonts: false,
  };

  let url = '';
  if (!preferBytes) {
    try {
      url = source.url();
    } catch {
      url = '';
    }
  }
  const viaURL = !!url && /^https?:|^\//.test(url);
  if (viaURL) params.url = url;
  else params.data = await source.bytes();

  return { task: pdfjs.getDocument(params), viaURL };
}

/**
 * Read one page's text.
 *
 * Deliberately drives `streamTextContent()` with an explicit reader rather than
 * calling `getTextContent()`. The convenience method consumes that same stream
 * with `for await (… of stream)`, and **WebKit does not support async iteration
 * of a ReadableStream** — which is the engine Juggler's WebView actually runs,
 * so `getTextContent()` throws there. Pulling from the reader is the same public
 * API without the unsupported syntax, and turns PDF extraction from
 * unavailable-on-this-platform into working.
 * @param {any} page - A PDF.js page proxy
 * @returns {Promise<string>} The page's text
 */
async function readPageText(page) {
  if (typeof page.streamTextContent === 'function') {
    const reader = page.streamTextContent().getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value?.items || []) text += item.str ?? '';
    }
    return text;
  }
  const content = await page.getTextContent();
  return content.items.map((/** @type {any} */ item) => item.str ?? '').join('');
}

/**
 * PdfFileViewer — renders PDFs with Mozilla PDF.js, and extracts their text for
 * the model where the runtime allows it.
 *
 * Rendering goes to `<canvas>` rather than a native `<embed>`/`<iframe>`:
 * WebKitGTK ships no PDF viewer, so the native route would simply be broken on
 * Linux, and `object-src 'none'` already blocks `<embed>`/`<object>`. Canvas is
 * covered by the existing `img-src 'self' data: blob:`, and the same-origin
 * module worker passes `script-src 'self'`, so no CSP change is needed.
 * @augments FileViewer
 */
class PdfFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'pdf',
    name: 'PDF',
    version: '1.0.0',
    description: 'Renders PDF documents and extracts their text',
    mimeTypes: ['application/pdf'],
    extensions: ['pdf'],
    priority: 50,
    // PDF.js memory scales with the pages actually rendered rather than file
    // size, so this cap is really about what the content endpoint will stream.
    maxBytes: 100 << 20,
  };

  /**
   * Render pages into `host`, drawing each one only as it scrolls into view.
   * @param {import('juggler/file-source').FileSource} source - The PDF
   * @param {HTMLElement} host - Element to render into
   * @param {import('juggler/file-viewer').RenderContext} [ctx] - Header slot and abort signal
   * @returns {Promise<() => void>} Teardown that destroys the document and its worker
   */
  async render(source, host, ctx = {}) {
    injectStylesOnce('pdf-file-viewer-styles', STYLES);
    const pdfjs = await loadPdfJs();
    const opened = await openDocument(pdfjs, source);
    const viaURL = opened.viaURL;
    // Reassigned when a refused URL forces a second attempt on the bytes
    // transport; `teardown` below always destroys whichever task is current.
    let task = opened.task;

    /** @type {any} */
    let doc = null;
    let destroyed = false;
    /** @type {IntersectionObserver|null} */
    let observer = null;

    // Teardown must be safe to call at ANY point, including while the document
    // is still loading — the panel selection can change mid-load, and leaking a
    // PDF.js worker per selection is this viewer's obvious failure mode.
    // Destroying the LOADING TASK is the documented teardown and is what tears
    // down the worker; it covers both the loaded and still-loading cases.
    const teardown = () => {
      if (destroyed) return;
      destroyed = true;
      if (observer) observer.disconnect();
      void task.destroy();
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', teardown, { once: true });

    try {
      doc = await task.promise;
    } catch (err) {
      // A streaming URL that parsed as usable can still be refused at load time:
      // the content route serves only files inside the project root, so an
      // @-mentioned PDF anywhere else fails here with a 403. The bytes transport
      // resolves that same path through the read op's rules, so retry on it
      // rather than reporting the refusal as an undisplayable file.
      if (destroyed || !viaURL) {
        teardown();
        throw err;
      }
      void task.destroy();
      ({ task } = await openDocument(pdfjs, source, true));
      if (destroyed) {
        void task.destroy();
        return teardown;
      }
      try {
        doc = await task.promise;
      } catch (bytesErr) {
        teardown();
        throw bytesErr;
      }
    }
    if (destroyed) return teardown;

    const pages = document.createElement('div');
    pages.className = 'pdf-view-pages';
    host.appendChild(pages);

    if (ctx.header) {
      const meta = document.createElement('span');
      meta.className = 'pdf-view-pagecount';
      meta.textContent = t('{count, plural, one {{count} page} other {{count} pages}}', { count: doc.numPages });
      ctx.header.appendChild(meta);
    }

    /** @param {HTMLCanvasElement} canvas - The page canvas to draw into */
    const drawPage = async (canvas) => {
      const pageNumber = Number(canvas.dataset.page);
      if (destroyed || canvas.dataset.rendered === 'true') return;
      canvas.dataset.rendered = 'true';
      try {
        const page = await doc.getPage(pageNumber);
        if (destroyed) return;
        // Draw at device resolution so text stays sharp on a HiDPI display,
        // while CSS keeps the layout box at CSS pixels.
        const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
        const context = canvas.getContext('2d');
        if (!context) return;
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (err) {
        if (!destroyed) console.error('[pdf-file-viewer] page render failed:', err);
      }
    };

    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const canvas = /** @type {HTMLCanvasElement} */ (entry.target);
          observer?.unobserve(canvas);
          void drawPage(canvas);
        }
      }
    }, { rootMargin: '200px' });

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-view-page';
      canvas.dataset.page = String(pageNumber);
      pages.appendChild(canvas);
      observer.observe(canvas);
    }

    return teardown;
  }

  /**
   * Extract the document's text, stopping at a page boundary once `maxChars` is
   * reached so the model gets whole pages rather than a blob cut mid-word.
   *
   * PDF.js is **not usable in every engine realm**: it needs `DOMMatrix` and
   * `Path2D` at module scope, which a Node-based engine host does not provide
   * (its `legacy` build reaches for the native `@napi-rs/canvas` package to
   * polyfill them). Rather than bet on the realm, any failure to load or parse
   * degrades to a warning — the model then sees an explanation instead of the
   * nothing it saw before this viewer existed. In a browser realm extraction
   * genuinely works; see {@link readPageText} for the WebKit workaround that
   * makes it so.
   * @param {import('juggler/file-source').FileSource} source - The PDF
   * @param {import('juggler/file-viewer').ExtractContext} [ctx] - Character budget and abort signal
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} The document text, or why there isn't any
   */
  async extract(source, ctx = {}) {
    const maxChars = ctx.maxChars ?? Infinity;
    /** @type {any} */
    let task = null;
    try {
      const pdfjs = await loadPdfJs();
      // Extraction reads every page anyway, so there is nothing to gain from
      // range-streaming — and bytes() works in the engine realm, where url()
      // (viewer-only) does not.
      ({ task } = await openDocument(pdfjs, source, true));
      const doc = await task.promise;

      /** @type {string[]} */
      const parts = [];
      let total = 0;
      let truncated = false;

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        if (ctx.signal?.aborted) {
          truncated = true;
          break;
        }
        const page = await doc.getPage(pageNumber);
        const block = markUntranslated(`--- Page ${pageNumber} ---\n${await readPageText(page)}`);
        // Stop BEFORE adding a page that would blow the budget, so the result is
        // always a whole number of pages.
        if (total + block.length > maxChars && parts.length > 0) {
          truncated = true;
          break;
        }
        parts.push(block);
        total += block.length;
      }

      const text = `<file path="${source.path}">\n${parts.join('\n\n')}\n</file>` +
        markUntranslated(truncated ? `\n(Showing ${parts.length} of ${doc.numPages} pages.)` : `\n(${doc.numPages} pages total)`);
      return { text, truncated };
    } catch (err) {
      return {
        warning: markUntranslated(`PDF text extraction is not available: ${/** @type {any} */ (err)?.message || err}`),
      };
    } finally {
      // Always tear the worker down — an extraction that threw halfway would
      // otherwise leak one per read.
      if (task) void task.destroy();
    }
  }
}

export default PdfFileViewer;
