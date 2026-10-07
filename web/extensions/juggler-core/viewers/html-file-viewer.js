//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { createFileContentBlock, formatFileContentForLLM } from 'juggler/item-utils';
import { injectStylesOnce } from 'juggler/ui';

/**
 * What the preview frame may do. Scripts, forms and dialogs run; sharing the
 * app's origin never does. The page is served from Juggler's own origin, so
 * `allow-same-origin` here would hand whatever the file contains the API token
 * and the whole `/api` surface. Without it the page gets an opaque origin of
 * its own and can reach nothing of the app's.
 */
const SANDBOX = 'allow-scripts allow-forms allow-modals';

/** Injected on first render only: `extract()` runs in the engine, which has no DOM. */
const STYLES = `
.html-view-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
}
.html-view-toggle {
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border-color, currentColor);
  border-radius: 0.25rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.html-view-note {
  font-size: 0.6875rem;
  color: var(--text-tertiary);
  margin-bottom: 0.375rem;
}
.html-view-frame {
  display: block;
  width: 100%;
  height: 70vh;
  min-height: 20rem;
  border: 1px solid var(--border-color, transparent);
  border-radius: 0.25rem;
  background: #fff;
}
`;

/**
 * The URL a preview can load, or why there isn't one. Decided from what the
 * source is rather than what the file says: a page that merely looks broken
 * standalone is still previewed, and the toggle is there for it.
 * @param {import('juggler/file-source').FileSource} source - The file
 * @returns {{url: string}|{reason: string}} A loadable URL, or why not
 */
function previewTarget(source) {
  // The URL serves the whole file as it is on disk, so a read of part of it
  // would be shown as something it is not.
  const offset = source.lineOffset || 1;
  if (offset > 1 || (source.lineCount && source.totalLines && source.lineCount < source.totalLines)) {
    return { reason: 'Part of the file, so shown as source.' };
  }
  // pageURL where there is one: it puts the page in its own directory, so the
  // images, styles and scripts it links relatively load from beside it. url()
  // would serve the page alone, and every relative link would miss.
  let url = '';
  try { url = source.pageURL?.() || source.url(); } catch { url = ''; }
  // Same-origin paths only. A text-backed source's URL is a data: stub, which
  // frame-src refuses and which would render as plain text if it did not.
  if (!/^\/(?!\/)/.test(url)) {
    return { reason: 'Nothing to load it from, so shown as source.' };
  }
  return { url };
}

/**
 * Ask the server whether it will serve the URL before framing it. A sandboxed
 * frame's load cannot be inspected, so a refused path (outside the project, say)
 * would otherwise be framed as an error page.
 * @param {string} url - Same-origin URL
 * @param {AbortSignal} [signal] - Abort signal
 * @returns {Promise<string>} '' when it will be served, else why not
 */
async function probe(url, signal) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    void res.body?.cancel();
    return res.ok ? '' : `Couldn’t load the page (HTTP ${res.status}), so shown as source.`;
  } catch (err) {
    return `Couldn’t load the page (${/** @type {any} */ (err)?.message || err}), so shown as source.`;
  }
}

/**
 * HtmlFileViewer — shows an HTML file as the page it describes, with its source
 * a click away. The model still reads the source: `extract()` is the text
 * viewer's, and only what the user sees differs.
 *
 * The page is loaded from the file tree route into a sandboxed frame, so its
 * scripts, styles, the files it links relatively and any libraries it pulls
 * from a CDN load as they would opened from its folder in a browser tab. It is shown as source instead wherever a preview would be
 * untrue or cannot load: a partial read, a source with no server URL, or a path
 * the server will not serve.
 * @augments FileViewer
 */
class HtmlFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'html',
    name: 'HTML',
    version: '1.0.0',
    description: 'Renders HTML files as a live page, with the source a click away',
    mimeTypes: ['text/html'],
    extensions: ['html', 'htm'],
    priority: 50,
  };

  /**
   * @param {import('juggler/file-viewer').FileDescriptor} descriptor - File metadata
   * @returns {boolean|undefined} False for binary content, otherwise no opinion
   */
  static claims(descriptor) {
    return descriptor.isBinary ? false : undefined;
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to render
   * @param {HTMLElement} host - Element to render into
   * @param {import('juggler/file-viewer').RenderContext} [ctx] - Header slot and abort signal
   * @returns {Promise<() => void>} Teardown
   */
  async render(source, host, ctx = {}) {
    injectStylesOnce('html-file-viewer-styles', STYLES);

    /** @type {Promise<string>|null} */
    let textPromise = null;
    const sourceText = () => {
      textPromise ??= typeof source.text === 'string'
        ? Promise.resolve(source.text)
        : source.bytes().then((bytes) => new TextDecoder().decode(bytes));
      return textPromise;
    };

    /** @type {(() => void)|null} */
    let destroyBlock = null;
    /** @type {HTMLIFrameElement|null} */
    let frame = null;
    let bar = /** @type {HTMLElement|null} */ (null);

    const clear = () => {
      destroyBlock?.();
      destroyBlock = null;
      if (frame) frame.src = 'about:blank';
      frame = null;
      host.replaceChildren();
    };

    /** @param {string} [note] - Why this is source rather than a preview */
    const showSource = async (note) => {
      const text = await sourceText();
      clear();
      if (note) {
        const el = document.createElement('div');
        el.className = 'html-view-note';
        el.textContent = note;
        host.appendChild(el);
      }
      const block = createFileContentBlock({
        content: text,
        language: 'html',
        lineNumberStart: source.lineOffset || 1,
      });
      host.appendChild(block);
      const destroy = /** @type {any} */ (block).destroy;
      destroyBlock = typeof destroy === 'function' ? destroy : null;
    };

    /** @param {string} url - Same-origin URL of the page */
    const showPreview = (url) => {
      clear();
      frame = document.createElement('iframe');
      frame.className = 'html-view-frame';
      frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('referrerpolicy', 'no-referrer');
      // aria-label, not title: the pointer spends its time inside the page, where
      // a title would hover as a tooltip over whatever the user is doing.
      frame.setAttribute('aria-label', source.path || 'HTML preview');
      frame.src = url;
      host.appendChild(frame);
    };

    const target = previewTarget(source);
    const refusal = 'url' in target ? await probe(target.url, ctx.signal) : target.reason;
    if (refusal || !('url' in target)) {
      await showSource(refusal);
    } else {
      const url = target.url;
      let previewing = true;
      showPreview(url);
      if (ctx.header) {
        bar = document.createElement('div');
        bar.className = 'html-view-bar';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'html-view-toggle';
        toggle.textContent = 'Source';
        toggle.setAttribute('aria-label', 'Show HTML source');
        toggle.addEventListener('click', () => {
          previewing = !previewing;
          toggle.textContent = previewing ? 'Source' : 'Preview';
          toggle.setAttribute('aria-label', previewing ? 'Show HTML source' : 'Show rendered page');
          if (previewing) showPreview(url);
          else void showSource();
        });
        bar.appendChild(toggle);
        // Above the content rather than after it: the header is the <file-view>
        // itself, which already holds the host.
        ctx.header.insertBefore(bar, host.parentNode === ctx.header ? host : null);
      }
    }

    return () => {
      clear();
      bar?.remove();
    };
  }

  /**
   * The model reads source, exactly as the text viewer would give it.
   * @param {import('juggler/file-source').FileSource} source - The file to extract
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} The model-facing text
   */
  async extract(source) {
    const text = source.text ?? new TextDecoder().decode(await source.bytes());
    return {
      text: formatFileContentForLLM({
        content: text,
        path: source.path,
        lineOffset: source.lineOffset || 1,
        lineCount: source.lineCount,
        totalLines: source.totalLines,
      }),
    };
  }
}

export default HtmlFileViewer;
