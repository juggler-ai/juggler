//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the PDF file viewer against the real vendored PDF.js.
 *
 * This is the standing answer to the "does PDF.js work here?" spike: rather than
 * asserting a conclusion, it loads the actual library in a real browser realm
 * and drives it. Covers:
 *  - `extract()` returning the document's text (the capability the model gains);
 *  - `render()` producing one canvas per page and a teardown that destroys the
 *    PDF.js document — a leaked worker per panel selection being this viewer's
 *    obvious failure mode;
 *  - teardown being safe to call twice.
 *
 * The fixture is utilities/pdf-fixture.js.
 * @module unit-tests/pdf-viewer-test
 */

import PdfFileViewer from '../../extensions/juggler-core/viewers/pdf-file-viewer.js';
import { createFileSource } from '../../sdk/file-source.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { budgetFor, deadlineTimer } from '../utilities/test-deadline.js';
import { PDF_BASE64, pdfBytes } from '../utilities/pdf-fixture.js';

/** The viewer's English messages, registered pseudo-localised under its extension id. */
const CORE_TEXT = ['{count, plural, one {{count} page} other {{count} pages}}'];

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * @returns {import('../../sdk/file-source.js').FileSource} A source backed by the inline fixture
 */
function pdfSource() {
  const bytes = pdfBytes();
  return createFileSource({
    path: 'docs/spike.pdf',
    absPath: '/proj/docs/spike.pdf',
    mime: 'application/pdf',
    size: bytes.length,
    isBinary: true,
    url: () => `data:application/pdf;base64,${PDF_BASE64}`,
    bytes: async () => bytes,
  });
}

/**
 * A source whose streaming URL is same-origin and well-formed but will be
 * refused at load time — the shape of an @-mentioned file outside the project
 * root, which the content route answers with a 403. Its bytes still resolve.
 * @returns {import('../../sdk/file-source.js').FileSource} A source with a dead URL
 */
function pdfSourceWithDeadURL() {
  const source = pdfSource();
  return createFileSource({
    ...source,
    url: () => '/api/session/files/content?path=%2Fnowhere%2Fout-of-project.pdf',
  });
}

/**
 * Run `extract()` on the fixture inside a module worker set up as the engine is
 * (see utilities/pdf-extract-worker.js).
 * @returns {Promise<{result?: any, error?: string}>} What the worker reported
 */
function extractInEngineWorker() {
  const worker = new Worker(new URL('../utilities/pdf-extract-worker.js', import.meta.url), { type: 'module' });
  const bytes = pdfBytes();
  return new Promise((resolve, reject) => {
    const cancel = deadlineTimer(() => {
      worker.terminate();
      reject(new Error('the engine-worker extraction never answered'));
    }, budgetFor(10000));
    worker.onmessage = (/** @type {MessageEvent} */ event) => {
      if (!event.data?.done) return;
      cancel();
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (/** @type {ErrorEvent} */ event) => {
      cancel();
      worker.terminate();
      reject(new Error(`worker error: ${event.message}`));
    };
    worker.postMessage({
      assetPrefix: /** @type {any} */ (globalThis).__assetPrefix || '',
      viewerPath: '/extensions/juggler-core/viewers/pdf-file-viewer.js',
      path: 'docs/spike.pdf',
      bytes: bytes.buffer,
    }, [bytes.buffer]);
  });
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  const viewer = new PdfFileViewer();

  // The manifest must actually claim PDFs, or none of this viewer runs.
  const manifest = /** @type {any} */ (PdfFileViewer).MANIFEST;
  tally(check(manifest.mimeTypes.includes('application/pdf') && manifest.extensions.includes('pdf'),
    'the PDF viewer should declaratively claim application/pdf and .pdf', errors));

  // Extraction — the outcome the spike was about.
  // Extraction must actually produce the document's text in a browser realm.
  // This is the regression guard for the WebKit gap the viewer works around:
  // PDF.js's own getTextContent() consumes its stream with `for await`, which
  // WebKit cannot do, so the viewer drives the reader explicitly. If that
  // workaround is ever removed, extract() silently degrades to a warning and
  // the model stops seeing PDFs — this assertion is what catches it.
  let extracted;
  let threw = null;
  try {
    extracted = await viewer.extract(pdfSource(), {});
  } catch (err) {
    threw = err;
    extracted = /** @type {any} */ ({});
  }
  tally(check(threw === null,
    `extract() must never throw, it degrades instead; threw: ${/** @type {any} */ (threw)?.message}`, errors));
  tally(check(!extracted.warning,
    `extract() should produce text in a browser realm, but degraded: ${extracted.warning}`, errors));
  tally(check(!!extracted.text && extracted.text.includes('Juggler PDF spike'),
    `extracted text should contain the document's text, got ${JSON.stringify(extracted.text)}`, errors));
  tally(check(!!extracted.text && extracted.text.includes('docs/spike.pdf'),
    'extracted text should be wrapped in a <file> tag naming the path', errors));
  tally(check(extracted.truncated === false,
    'a one-page document within budget should not report truncation', errors));

  // The same extraction in the realm that actually runs it: the engine is a
  // module worker that loads extensions through /worker-module, so the viewer's
  // import.meta.url is the loader URL. A vendored-asset URL resolved naively
  // against it drops the versioned prefix and 404s, and PDF.js reports that as
  // "Setting up fake worker failed" — the main-thread case above cannot see it.
  try {
    const inWorker = await extractInEngineWorker();
    tally(check(!inWorker.error && !inWorker.result?.warning,
      `extract() should produce text in the engine worker, but got: ${inWorker.error || inWorker.result?.warning}`, errors));
    tally(check(!!inWorker.result?.text && inWorker.result.text.includes('Juggler PDF spike'),
      `engine-worker extraction should contain the document's text, got ${JSON.stringify(inWorker.result?.text)}`, errors));
  } catch (err) {
    tally(check(false, `engine-worker extraction failed: ${/** @type {any} */ (err)?.message || err}`, errors));
  }

  // A budget smaller than the first page must still yield that whole page —
  // extraction stops at a page boundary rather than cutting mid-word.
  const tiny = await viewer.extract(pdfSource(), { maxChars: 1 });
  tally(check(!!tiny.text && tiny.text.includes('Juggler PDF spike'),
    'a tiny budget should still emit the first whole page', errors));

  // Rendering, in a detached-but-connected host so IntersectionObserver and
  // canvas sizing behave as they do in the panel.
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const header = document.createElement('div');
    const teardown = await viewer.render(pdfSource(), host, { header });

    const canvases = host.querySelectorAll('canvas.pdf-view-page');
    tally(check(canvases.length === 1,
      `render() should create one canvas per page, got ${canvases.length}`, errors));
    tally(check(header.textContent?.includes('1 page') === true,
      `the header should report the page count, got ${JSON.stringify(header.textContent)}`, errors));
    tally(check(typeof teardown === 'function',
      'render() must return a teardown so the PDF.js worker is destroyed', errors));

    // Teardown must be idempotent — <file-view> can call it on disconnect after
    // an abort has already fired.
    if (typeof teardown === 'function') {
      let threw = false;
      try {
        teardown();
        teardown();
      } catch {
        threw = true;
      }
      tally(check(!threw, 'teardown should be safe to call twice', errors));
    }
  } catch (err) {
    tally(check(false, `render() threw: ${/** @type {any} */ (err)?.message || err}`, errors));
  } finally {
    host.remove();
  }

  // A refused streaming URL must fall back to the bytes transport rather than
  // surfacing the HTTP status as "could not display this file". This is the
  // out-of-project case: the content route serves only files inside the project
  // root, so an @-mentioned PDF elsewhere can only ever render from bytes.
  const fallbackHost = document.createElement('div');
  document.body.appendChild(fallbackHost);
  try {
    const teardown = await viewer.render(pdfSourceWithDeadURL(), fallbackHost, {});
    const canvases = fallbackHost.querySelectorAll('canvas.pdf-view-page');
    tally(check(canvases.length === 1,
      `a refused URL should fall back to bytes and still render, got ${canvases.length} canvases`, errors));
    if (typeof teardown === 'function') teardown();
  } catch (err) {
    tally(check(false,
      `render() should recover from a refused URL, but threw: ${/** @type {any} */ (err)?.message || err}`, errors));
  } finally {
    fallbackHost.remove();
  }

  // Under en-XA the page count in the header is translated; what extract()
  // gives the model — page markers, the total, the degraded warning — stays
  // English. The canvases are the document's own content, so only the header
  // is walked.
  const xaHost = document.createElement('div');
  document.body.appendChild(xaHost);
  try {
    await underPseudoLocale('pdf-viewer-test', async () => {
      const header = document.createElement('div');
      const teardown = await viewer.render(pdfSource(), xaHost, { header });
      if (typeof teardown === 'function') teardown();
      const shown = shownStrings(header);
      if (shown.length !== 1) throw new Error(`expected the page count alone in the header, got ${JSON.stringify(shown)}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));

      const model = await viewer.extract(pdfSource(), {});
      const broken = await viewer.extract(createFileSource({
        path: '7.pdf', mime: 'application/pdf', size: 7, isBinary: true,
        bytes: async () => { throw new Error('7'); },
      }), {});
      const english = [
        model.text?.includes('--- Page 1 ---') ? '' : `page marker: ${JSON.stringify(model.text)}`,
        model.text?.includes('(1 pages total)') ? '' : `page total: ${JSON.stringify(model.text)}`,
        broken.warning === 'PDF text extraction is not available: 7' ? '' : `warning: ${JSON.stringify(broken.warning)}`,
      ].filter(Boolean);

      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(raw)}`);
      if (english.length) throw new Error(`model text must stay English under en-XA: ${english.join('; ')}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${/** @type {Error} */ (e).message}`);
  } finally {
    xaHost.remove();
  }

  return { passed, failed, errors };
}
