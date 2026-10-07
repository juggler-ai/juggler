//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * FileSource — the descriptor a {@link import('./file-viewer.js').default} is
 * handed. It decouples *how the bytes travelled* from *how they render*, so a
 * viewer works the same whether the body rode inside a tool result, sits on
 * disk, or lives in the conversation's asset store.
 * @module sdk/file-source
 */

import { apiUrl } from '../js/utils/api-url.js';

/**
 * @typedef {object} FileSource
 * @property {string} path - Path as the producer spelled it (display + language detection). Usually project-relative, but a live read reports the absolute one — treat it as either.
 * @property {string} absPath - Absolute path (content endpoint + dedupe key)
 * @property {string} mime - Server-reported mime ('' when unknown)
 * @property {number} size - Bytes on disk
 * @property {boolean} isBinary - Server's byte-sniff result (advisory, NOT a verdict)
 * @property {string} [text] - Body, when the transport already carried it
 * @property {string} [language] - Server-detected language, when the transport carried one
 * @property {number} [lineOffset] - 1-indexed first line of `text`
 * @property {number} [totalLines] - Total lines in the whole file
 * @property {number} [lineCount] - Lines present in `text`
 * @property {boolean} [exists] - False when the path did not resolve to a file
 * @property {string} [warning] - Pre-existing explanation carried by a persisted result
 * @property {FileAccess} [access] - How the server may resolve this path (see {@link fetchFileBytes})
 * @property {() => string} url - Streaming URL (viewer realm only)
 * @property {() => string} [pageURL] - URL that also serves the files beside this one, so a page loaded from it resolves its relative links (viewer realm only; absent when the file is not on disk in the project)
 * @property {() => Promise<Uint8Array>} bytes - Raw bytes (either realm)
 */

/**
 * Why a path outside the project root is legitimately readable. The producer of
 * a FileSource is what knows: a pin is user-initiated, an out-of-root `read`
 * reaches its viewer only past the approval gate. This is the same vocabulary
 * the read op takes, travelling to the same place over the same
 * header-authenticated channel — so a viewer sees exactly the files the read
 * that produced it could see, and nothing more.
 * @typedef {object} FileAccess
 * @property {boolean} [userInitiated] - The user chose this path (@-mention, file picker)
 * @property {boolean} [outOfRootApproved] - The user approved this specific out-of-root read
 */

/** Extension → mime, for the client-side fallback when the server reported none. */
const MIME_BY_EXT = /** @type {Record<string, string>} */ ({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
});

/**
 * @param {string} path - File path
 * @returns {string} Lower-cased extension without the leading dot ('' when none)
 */
export function extensionOf(path) {
  const base = String(path || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Best-effort mime for a path, used when the server reported none. Deliberately
 * small: it exists to keep *persisted* results (written before the server
 * reported `mime`) resolvable, not to be a full mime database.
 * @param {string} path - File path
 * @returns {string} A mime type, or '' when the extension is unknown
 */
export function mimeForPath(path) {
  return MIME_BY_EXT[extensionOf(path)] || '';
}

/**
 * The per-instance API token, when this realm has one.
 * @returns {string} The token, or '' when unavailable
 */
function apiToken() {
  return /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken || '';
}

/**
 * Build the streaming URL for an absolute path. The bytes are loaded by the
 * browser as an `<img src>` / `<canvas>` fetch / `<iframe>` load, none of which
 * can set a custom header, so the token rides as `?token=` exactly as the asset
 * route does.
 * @param {string} absPath - Absolute file path
 * @returns {string} Token-bearing content URL
 */
export function fileContentURL(absPath) {
  const url = apiUrl(`/session/files/content?path=${encodeURIComponent(absPath)}`);
  const token = apiToken();
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}

/**
 * Build a URL for an absolute path that, unlike {@link fileContentURL}, places
 * the file in its own directory: `/api/session/files/tree/<token>/<path>`. A
 * page framed from it resolves its relative links (`img.png`, `../style.css`)
 * to the files beside it, still under the route and still carrying the token —
 * which is why the token is a path segment rather than a query parameter a
 * relative URL would drop. The server holds it to the project root exactly as
 * it does the query route.
 * @param {string} absPath - Absolute file path (POSIX, or Windows with a drive letter)
 * @returns {string} Token-bearing tree URL, or '' when the path is not absolute
 */
export function fileTreeURL(absPath) {
  const p = String(absPath || '').replace(/\\/g, '/');
  if (!/^(\/|[A-Za-z]:\/)/.test(p)) return '';
  const segments = p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  // A placeholder keeps the URL's shape where a realm has no token (the test
  // server, which does not check one).
  const token = encodeURIComponent(apiToken() || '_');
  return apiUrl(`/session/files/tree/${token}/${segments}`);
}

/**
 * Build the GET URL that streams a stored conversation asset. Assets are
 * content-addressed and immutable, so unlike {@link fileContentURL} this URL is
 * stable forever for a given id. Token handling matches: an `<img src>` load
 * cannot set a header, so it rides as `?token=`.
 * @param {string} conversationId - Conversation that owns the asset
 * @param {string} sha - Asset id (content hash)
 * @returns {string} Token-bearing asset URL
 */
export function conversationAssetURL(conversationId, sha) {
  const url = apiUrl(`/session/conversations/${encodeURIComponent(conversationId)}/assets/${encodeURIComponent(sha)}`);
  const token = apiToken();
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/**
 * Decode base64 into bytes.
 * @param {string} base64 - Base64-encoded data
 * @returns {Uint8Array} The decoded bytes
 */
function decodeBase64(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fetch raw bytes for an absolute path. Works in either realm: the header is
 * set explicitly rather than relying on a realm-specific fetch shim.
 *
 * This POSTs rather than reusing {@link fileContentURL}'s GET, and the
 * difference is the whole point. The GET route's token can ride in the query
 * string, so it is contained to the project root and honours no escape hatch;
 * a POST carries the token in a header (and forces a CORS preflight), so the
 * server accepts the read op's `userInitiated` / `outOfRootApproved` vocabulary
 * in the body. That is what gives a viewer the bytes of a file the user pointed
 * at outside the project — a PDF on the Desktop — which the streaming URL can
 * only ever refuse.
 * @param {string} absPath - Absolute file path
 * @param {AbortSignal} [signal] - Abort signal
 * @param {FileAccess} [access] - Why an out-of-project path is readable
 * @returns {Promise<Uint8Array>} The file's bytes
 */
export async function fetchFileBytes(absPath, signal, access = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  const token = apiToken();
  if (token) headers['X-Juggler-Token'] = token;
  const response = await fetch(apiUrl('/session/files/bytes'), {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ path: absPath, ...access }),
  });
  if (!response.ok) {
    throw new Error(`Failed to read ${absPath} (HTTP ${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Build a {@link FileSource} from plain descriptor fields, attaching the two
 * lazy accessors. Every other builder in this module funnels through here.
 * @param {Partial<FileSource> & {path: string}} fields - Descriptor fields
 * @returns {FileSource} A complete file source
 */
export function createFileSource(fields) {
  const path = fields.path || '';
  const absPath = fields.absPath || path;
  const source = /** @type {FileSource} */ ({
    ...fields,
    path,
    absPath,
    mime: fields.mime || mimeForPath(path),
    size: fields.size ?? 0,
    isBinary: fields.isBinary ?? false,
    url: fields.url || (() => fileContentURL(absPath)),
    bytes: fields.bytes || (() => fetchFileBytes(absPath, undefined, fields.access)),
  });
  // Only a source streamed from disk has neighbours to serve. One whose url()
  // points elsewhere (an asset, a data: stub) keeps whatever pageURL it was given.
  if (!fields.pageURL && !fields.url && fileTreeURL(absPath)) {
    source.pageURL = () => fileTreeURL(absPath);
  }
  return source;
}

/**
 * Build a FileSource from a `read` tool result.
 *
 * **This function reads persisted documents.** `createPropertiesPanelElement`
 * renders from `this.data`, a ReadFileResult stored in the conversation's Yjs
 * doc, so conversations already on disk carry the *older* result shape: a
 * baked-in `warning` string, an `isImage` flag with an `attachment` AssetRef,
 * and no `mime`. Normalising both shapes here is the single compatibility shim
 * for that history — every viewer downstream sees one shape.
 * @param {Record<string, any>} result - A ReadFileResult (current or legacy shape)
 * @param {string} absPath - Absolute path resolved by the caller
 * @param {{assetURL?: (id: string) => string, conversationId?: string, access?: FileAccess}} [opts] - Asset URL builder (or the conversation whose assets to build against), plus why an out-of-project path is readable
 * @returns {FileSource} Normalised file source
 */
export function fileSourceFromReadResult(result, absPath, opts = {}) {
  const data = result || {};
  const path = data.path || '';

  // An image result carries its pixels in the conversation asset store rather
  // than on the content endpoint, so point url() at the stored asset. This
  // covers both the legacy persisted shape and a freshly-uploaded attachment.
  const asset = data.attachment?.id ? data.attachment : null;
  const buildAssetURL = opts.assetURL
    || (opts.conversationId ? (/** @type {string} */ id) => conversationAssetURL(/** @type {string} */ (opts.conversationId), id) : null);
  const assetURL = asset && buildAssetURL ? buildAssetURL(asset.id) : '';

  // The read op hands an approved image's pixels back inline (base64) rather
  // than making the browser re-fetch them, and that transport is the only way an
  // out-of-project approved read can reach its bytes — the content endpoint is
  // contained to the project root. Resolving it here keeps that detail inside
  // the compatibility shim instead of leaking into every viewer.
  const inlineBase64 = typeof data.imageBase64 === 'string' ? data.imageBase64 : '';

  return createFileSource({
    path,
    absPath,
    mime: data.mime || asset?.mime || mimeForPath(path),
    size: data.size ?? asset?.bytes ?? 0,
    // A legacy result has no isBinary field. An image one is binary by
    // construction; for anything else the baked-in warning is the only signal
    // the old shape carried that the body could not be shown as text.
    isBinary: data.isBinary ?? (!!asset || !!data.isImage || (data.exists !== false && !data.content && !!data.warning)),
    text: data.content,
    language: data.language,
    lineOffset: data.lineOffset,
    lineCount: data.lineCount,
    totalLines: data.totalLines,
    exists: data.exists,
    warning: data.warning || undefined,
    access: opts.access,
    ...(assetURL ? { url: () => assetURL } : {}),
    ...(inlineBase64 ? { bytes: async () => decodeBase64(inlineBase64) } : {}),
  });
}

/**
 * Build a FileSource for a file the browser holds in memory and the server has
 * never seen (a drag-and-dropped file). It is text-only by construction: there
 * is no path on disk to stream from, so `url()`/`bytes()` resolve against the
 * carried text rather than the content endpoint.
 * @param {{path: string, text: string, size?: number}} file - The dropped file
 * @returns {FileSource} A text-backed file source
 */
export function fileSourceFromText(file) {
  const text = file.text || '';
  return createFileSource({
    path: file.path,
    absPath: file.path,
    size: file.size ?? text.length,
    isBinary: false,
    text,
    exists: true,
    totalLines: text ? text.split('\n').length : 0,
    lineOffset: 1,
    url: () => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
    bytes: async () => new TextEncoder().encode(text),
  });
}

/**
 * Reduce a FileSource to the metadata the registry matches on.
 * @param {FileSource} source - The file source
 * @returns {import('./file-viewer.js').FileDescriptor} Descriptor for resolution
 */
export function toDescriptor(source) {
  return {
    path: source.path,
    mime: source.mime,
    size: source.size,
    isBinary: source.isBinary,
  };
}
