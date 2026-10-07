//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the HTML file viewer, which shows an `.html` file as the page it
 * describes.
 *
 * The load-bearing assertion is the sandbox. The page is served from Juggler's
 * own origin, so a frame without `sandbox` — or with `allow-same-origin` — would
 * run whatever the file contains inside the app, where the API token and the
 * whole `/api` surface are in reach. Everything else here is about the preview
 * never claiming to be something it is not: a partial read, or a file with no
 * URL to load, is shown as source.
 * @module unit-tests/html-file-viewer-test
 */

import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { fetchJson } from '../../js/services/http.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { createBoundOps } from '../../sdk/ops.js';
import { createFileSource, fileSourceFromText, toDescriptor } from '../../sdk/file-source.js';
import HtmlFileViewer from '../../extensions/juggler-core/viewers/html-file-viewer.js';
import TextFileViewer from '../../extensions/juggler-core/viewers/text-file-viewer.js';

const PAGE = '<!DOCTYPE html>\n<html><body><h1>Report</h1><script>document.title = "x";</script></body></html>\n';

/**
 * A same-origin URL the server answers with 200, standing in for the file
 * content route: this module's own, which is served by definition. The frame
 * loading it is sandboxed, so what it holds is moot.
 */
const SERVED_URL = new URL(import.meta.url).pathname;

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
 * A whole-file source that has a URL to load, as a pin or a read of the whole
 * file would.
 * @param {Record<string, any>} [over] - Field overrides
 * @returns {import('juggler/file-source').FileSource} The source
 */
function servedSource(over = {}) {
  return createFileSource({
    path: 'report.html',
    absPath: '/project/report.html',
    size: PAGE.length,
    text: PAGE,
    exists: true,
    totalLines: PAGE.split('\n').length,
    lineCount: PAGE.split('\n').length,
    lineOffset: 1,
    url: () => SERVED_URL,
    ...over,
  });
}

/**
 * Render a source through the viewer into a detached host and header.
 * @param {import('juggler/file-source').FileSource} source - What to render
 * @returns {Promise<{host: HTMLElement, header: HTMLElement, teardown: (() => void)|void}>} The rendered parts
 */
async function render(source) {
  const header = document.createElement('div');
  const host = document.createElement('div');
  document.body.append(header, host);
  const teardown = await new HtmlFileViewer().render(source, host, {
    header,
    signal: new AbortController().signal,
  });
  return { host, header, teardown };
}

/**
 * @param {{host: HTMLElement, header: HTMLElement, teardown: (() => void)|void}} rendered - What render() returned
 */
function dispose(rendered) {
  if (typeof rendered.teardown === 'function') rendered.teardown();
  rendered.host.remove();
  rendered.header.remove();
}

/** A 4×3 image, written as text so `writeFileOp` can put it on disk. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3"/></svg>\n';

/**
 * A page that reports, once loaded, the natural width of each of its images.
 * The frame has an opaque origin, so the test cannot look inside it; the page
 * has to say what it got.
 */
const ASSET_PAGE = '<!doctype html><img src="beside.svg"><img src="../above.svg">'
  + '<script>addEventListener("load", () => parent.postMessage('
  + '{ htmlViewerImages: [...document.images].map((i) => i.naturalWidth) }, "*"));</script>\n';

/**
 * Wait for a framed page's image report (see {@link ASSET_PAGE}).
 * @param {HTMLElement} host - Where the viewer rendered its frame
 * @param {number} timeoutMs - How long to wait
 * @returns {Promise<number[]|null>} Each image's natural width, or null on timeout
 */
function imageReport(host, timeoutMs) {
  return new Promise((resolve) => {
    /** @param {MessageEvent} event - A message from some frame */
    const onMessage = (event) => {
      const frame = host.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow) return;
      if (!Array.isArray(event.data?.htmlViewerImages)) return;
      done(event.data.htmlViewerImages);
    };
    /** @param {number[]|null} result - What to resolve with */
    const done = (result) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener('message', onMessage);
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

  // An .html file is claimed by this viewer, not the text fallback.
  await fileViewerRegistry.ensureInitialized();
  const winner = fileViewerRegistry.resolve(toDescriptor(servedSource()));
  tally(check(/** @type {any} */ (winner)?.MANIFEST?.id === 'html',
    `an .html file should resolve to the html viewer, got ${/** @type {any} */ (winner)?.MANIFEST?.id}`, errors));

  // A whole file with a URL previews in a frame that cannot reach the app.
  const served = await render(servedSource());
  try {
    const frame = served.host.querySelector('iframe');
    tally(check(!!frame, 'a whole file with a URL should preview in an iframe', errors));
    const tokens = frame ? [...frame.sandbox] : [];
    tally(check(!!frame?.hasAttribute('sandbox'), 'the preview frame must be sandboxed', errors));
    tally(check(tokens.includes('allow-scripts'),
      `the preview should run the page's scripts, sandbox was ${JSON.stringify(tokens)}`, errors));
    tally(check(!tokens.includes('allow-same-origin'),
      `the preview must never share the app's origin, sandbox was ${JSON.stringify(tokens)}`, errors));
    tally(check(frame?.getAttribute('src') === SERVED_URL,
      `the frame should load the source's URL, got ${frame?.getAttribute('src')}`, errors));
    // The user's pointer lives inside the page, so a title would hover over it constantly.
    tally(check(!!frame && !frame.hasAttribute('title'),
      `the preview frame must not carry a title tooltip, got ${JSON.stringify(frame?.getAttribute('title'))}`, errors));
    tally(check(!!frame?.getAttribute('aria-label'),
      'the preview frame should still have an accessible name', errors));

    // The header toggle shows the markup instead, and back again.
    const toggle = /** @type {HTMLButtonElement|null} */ (served.header.querySelector('button'));
    tally(check(!!toggle, 'the header should carry a Source/Preview toggle', errors));
    toggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tally(check(!served.host.querySelector('iframe') && served.host.textContent?.includes('<h1>Report</h1>') === true,
      'Source should replace the preview with the markup', errors));
    toggle?.click();
    for (let i = 0; i < 50 && !served.host.querySelector('iframe'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    tally(check(!!served.host.querySelector('iframe'), 'Preview should bring the frame back', errors));
  } finally {
    dispose(served);
  }

  // A dropped file has no URL the server can serve, only a data: stub.
  const dropped = await render(fileSourceFromText({ path: 'dropped.html', text: PAGE }));
  try {
    tally(check(!dropped.host.querySelector('iframe'),
      'a text-backed source must not be framed through its data: stub', errors));
    tally(check(dropped.host.textContent?.includes('<h1>Report</h1>') === true,
      'a text-backed source should show its markup', errors));
  } finally {
    dispose(dropped);
  }

  // A windowed read is part of a file; the URL would show all of it.
  const windowed = await render(servedSource({ lineOffset: 2, lineCount: 1 }));
  try {
    tally(check(!windowed.host.querySelector('iframe'),
      'a partial read must not preview the whole file', errors));
  } finally {
    dispose(windowed);
  }

  // A URL the server refuses (outside the project root) falls back to source.
  const refused = await render(servedSource({ url: () => '/api/session/files/content?path=%2Fnowhere%2Fmissing.html' }));
  try {
    tally(check(!refused.host.querySelector('iframe'),
      'a URL the server refuses must fall back to source rather than frame the error', errors));
  } finally {
    dispose(refused);
  }

  // A page on disk loads what it links relatively — beside it and above it —
  // exactly as it would opened from a folder. The frame's URL has to put the
  // page in its own directory for that, or every relative link resolves against
  // the API route instead and comes back a 404.
  const stamp = Math.random().toString(36).slice(2, 8);
  const dir = `html-view-${stamp}`;
  const project = createBoundOps(() => ({ workspaceId: '' }));
  try {
    const root = String((await fetchJson(apiUrl('/session')))?.projectPath || '');
    tally(check(root.length > 0, 'the test server should report its project path', errors));
    await writeFileOp({ path: `${dir}/above.svg`, content: SVG });
    await writeFileOp({ path: `${dir}/page/beside.svg`, content: SVG });
    await writeFileOp({ path: `${dir}/page/index.html`, content: ASSET_PAGE });
    const absPath = `${root.replace(/[\\/]+$/, '')}/${dir}/page/index.html`;
    const host = document.createElement('div');
    document.body.append(host);
    const report = imageReport(host, 8000);
    const teardown = await new HtmlFileViewer().render(createFileSource({
      path: `${dir}/page/index.html`,
      absPath,
      size: ASSET_PAGE.length,
      exists: true,
    }), host, { signal: new AbortController().signal });
    try {
      const widths = await report;
      tally(check(widths !== null, 'the framed page should load and report its images', errors));
      tally(check(JSON.stringify(widths) === '[4,4]',
        `a sibling and a ../ image should both load, got natural widths ${JSON.stringify(widths)}`, errors));
    } finally {
      if (typeof teardown === 'function') teardown();
      host.remove();
    }
  } finally {
    await project.copyTree({ to: '.', delete: [dir] });
  }

  // What the model reads is exactly what the text viewer would have given it.
  const source = fileSourceFromText({ path: 'report.html', text: PAGE });
  const [html, text] = await Promise.all([
    new HtmlFileViewer().extract(source),
    new TextFileViewer().extract(source),
  ]);
  tally(check(!!html.text && html.text === text.text,
    'extract() must hand the model the same source text the text viewer does', errors));

  return { passed, failed, errors };
}
