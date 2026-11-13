//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * File-viewer manifest — static metadata describing which files a viewer can
 * handle. Define this as a static MANIFEST property on your viewer class.
 *
 * `mimeTypes`, `extensions` and `matchAll` are the *declarative* match: the
 * registry reads them without importing or instantiating anything, so resolving
 * a viewer for a file never pulls a heavy module off the wire.
 * @typedef {object} FileViewerManifest
 * @property {string} id - Unique viewer identifier (kebab-case, e.g. 'pdf')
 * @property {string} name - Human-readable display name (shown in the extensions catalog)
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - Help text shown in the extensions catalog
 * @property {string[]} [mimeTypes] - Mime types this viewer claims, matched case-insensitively
 * @property {string[]} [extensions] - File extensions this viewer claims, without the leading dot
 * @property {boolean} [matchAll] - Candidate for every file regardless of mime/extension. Reserved for a genuine fallback (the text and binary viewers); defaults to false.
 * @property {number} [priority] - Higher wins when several viewers claim the same file. Defaults to 0, which is the text fallback's tier; negative sits below it, where the binary viewer waits.
 * @property {number} [maxBytes] - Decline files larger than this. Defaults to unbounded.
 */

/**
 * What the registry matches against. Deliberately narrower than
 * {@link FileSource}: resolution must be answerable from metadata alone, with no
 * transport and no bytes read.
 * @typedef {object} FileDescriptor
 * @property {string} path - Project-relative path
 * @property {string} mime - Server-reported mime type ('' when unknown)
 * @property {number} size - Bytes on disk
 * @property {boolean} isBinary - Server's byte-sniff observation (advisory, NOT a verdict)
 * @property {boolean} [extracted] - The content is text a viewer's `extract()`
 *   derived from the file, not the file's bytes. `path` and `mime` still name the
 *   original, so only `matchAll` viewers are candidates for it — the viewer for
 *   the file's own type would be handed text in a format it cannot parse.
 */

/**
 * What {@link FileViewer.extract} produces — the model-facing representation of
 * a file. Wider than a bare string so it can absorb the cases that already
 * exist: an image contributes pixels rather than text, and a file no viewer can
 * read contributes only an explanation.
 * @typedef {object} ExtractResult
 * @property {string} [text] - Body text to place in the tool result
 * @property {import('../js/services/ops-api.js').AssetRef[]} [attachments] - Stored assets to attach (image pixels for a multimodal model)
 * @property {string} [warning] - Why nothing could be extracted
 * @property {boolean} [truncated] - Set when `text` stops short of the whole file
 */

/**
 * Per-call extraction context.
 * @typedef {object} ExtractContext
 * @property {number} [maxChars] - Character budget. A viewer should stop at a natural boundary (a page, a record) rather than emit everything and let the caller cut it.
 * @property {AbortSignal} [signal] - Aborts a long extraction
 * @property {string} [conversationId] - Conversation whose asset store attachments are uploaded to
 */

/**
 * Per-call render context.
 * @typedef {object} RenderContext
 * @property {HTMLElement} [header] - Header region the viewer may add controls to (page count, zoom)
 * @property {AbortSignal} [signal] - Aborts a long render
 */

// ============================================================================
// FileViewer Base Class
// ============================================================================

/**
 * FileViewer — base class for Juggler "file viewer" plugins.
 *
 * A file viewer answers two questions about one file: **how does it look** and
 * **what does the model see**. It is the seam that replaces per-format special
 * cases scattered across the ops layer, the context items, and the renderers.
 *
 * ## Creating a viewer
 *
 * Viewers ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Add a file named `*-file-viewer.js` under
 * the extension's `viewers/` directory — the manifest's `provides.fileViewers`
 * glob registers it automatically.
 *
 * ```javascript
 * import FileViewer from 'juggler/file-viewer';
 *
 * export default class PdfFileViewer extends FileViewer {
 *   static MANIFEST = {
 *     id: 'pdf',
 *     name: 'PDF',
 *     version: '1.0.0',
 *     description: 'Renders PDF documents',
 *     mimeTypes: ['application/pdf'],
 *     extensions: ['pdf'],
 *     priority: 50,
 *   };
 *
 *   async render(source, host) {
 *     const { getDocument } = await import('/js/vendor/pdf.min.mjs');
 *     const doc = await getDocument(source.url()).promise;
 *     // …draw pages into `host`…
 *     return () => doc.destroy();
 *   }
 * }
 * ```
 *
 * ## Resolution
 *
 * The registry picks a viewer from static MANIFEST data alone — a viewer module
 * is imported only once it has *won*. Candidates are the viewers whose
 * `mimeTypes` or `extensions` match (or that set `matchAll`) and whose
 * `maxBytes` the file does not exceed; {@link FileViewer.claims} can then veto
 * or force-include. The highest `priority` wins, ties broken by extension load
 * order. When nothing claims the file, the host renders a "no viewer" fallback.
 *
 * ## Execution contexts
 *
 * Viewer code is loaded in **two** browser instances, and this class's two
 * methods split cleanly across them:
 *
 * | Method      | Context | Notes                                        |
 * |-------------|---------|----------------------------------------------|
 * | `render()`  | viewer  | Has DOM. Return a teardown function.          |
 * | `extract()` | engine  | No DOM — don't use `document.*` here          |
 *
 * `METHOD_CONTEXT` declares this, and in dev mode
 * (`window.__jugglerDevMode`) a method called in the wrong instance throws.
 *
 * A viewer with a heavy dependency must `import()` it **inside** the method
 * that needs it, so the engine worker never downloads a rendering library it
 * will not use.
 * @class
 * @abstract
 */
class FileViewer {
  /**
   * Viewer manifest (static property set by subclasses).
   * @type {FileViewerManifest}
   * @static
   */
  static MANIFEST;

  /**
   * Declares which execution context each overridable method runs in.
   *
   * - `'engine'`  — headless Chrome (no DOM)
   * - `'viewer'`  — user-facing browser (has DOM)
   * - `'shared'`  — runs in both (default for unlisted methods)
   * @type {Record<string, 'engine'|'viewer'|'shared'>}
   */
  static METHOD_CONTEXT = {
    render:  'viewer',
    extract: 'engine',
  };

  constructor() {
    if (new.target === FileViewer) {
      throw new Error('FileViewer is an abstract class and cannot be instantiated directly');
    }
  }

  /** @returns {FileViewerManifest} This viewer's manifest. */
  getManifest() {
    return /** @type {typeof FileViewer} */ (this.constructor).MANIFEST;
  }

  /** @returns {string} The viewer id (from MANIFEST). */
  get id() {
    return this.getManifest().id;
  }

  /** @returns {string} The viewer display name (from MANIFEST). */
  get name() {
    return this.getManifest().name;
  }

  /**
   * Override or veto the declarative match for cases `mimeTypes`/`extensions`
   * cannot express.
   *
   * Return `true` to claim a file the manifest would not have matched, `false`
   * to refuse one it would, and `undefined` to leave the declarative verdict
   * alone. This runs during resolution, so it must be cheap and synchronous and
   * must read nothing but the descriptor — the bytes have not been fetched.
   *
   * The text viewer uses the veto to decline binary files: that is how a binary
   * with no dedicated viewer falls past it to the binary viewer, which states
   * what it cannot show — all without `isBinary` becoming a verdict that
   * constrains any other viewer.
   * @param {FileDescriptor} descriptor - Metadata for the file being resolved
   * @returns {boolean|undefined} Claim, refuse, or defer
   */
  static claims(descriptor) {
    void descriptor;
    return undefined;
  }

  /**
   * Render the file into `host`. **Viewer realm** — the DOM is available.
   *
   * Return a teardown function when the render owns anything that outlives the
   * element: a worker, a timer, an observer, an object URL. The host element
   * calls it on disconnect, and a viewer that leaks one of those per panel
   * selection is the obvious failure mode.
   * @abstract
   * @param {FileSource} source - The file to render
   * @param {HTMLElement} host - Element to render into (already empty)
   * @param {RenderContext} [ctx] - Header slot and abort signal
   * @returns {Promise<(() => void)|void>} Optional teardown
   */
  async render(source, host, ctx) {
    void source;
    void host;
    void ctx;
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Produce the model-facing representation of the file. **Engine realm** —
   * there is no DOM.
   *
   * Respect `ctx.maxChars` by stopping at a natural boundary and setting
   * `truncated`, rather than returning everything and letting the caller cut it
   * mid-word.
   * @abstract
   * @param {FileSource} source - The file to extract from
   * @param {ExtractContext} [ctx] - Character budget and abort signal
   * @returns {Promise<ExtractResult>} What the model should see
   */
  async extract(source, ctx) {
    void source;
    void ctx;
    throw new Error('extract() must be implemented by subclass');
  }
}

/** @typedef {import('./file-source.js').FileSource} FileSource */

export default FileViewer;
