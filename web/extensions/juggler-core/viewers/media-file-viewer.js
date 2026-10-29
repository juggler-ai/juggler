//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { extensionOf } from 'juggler/file-source';
import { formatFileSize } from 'juggler/item-utils';
import { createImageThumb, injectStylesOnce } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

/** Injected on first render only: `extract()` runs in the engine, which has no DOM. */
const STYLES = `
.media-view-player {
  display: block;
  max-width: 100%;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

video.media-view-player {
  max-height: 70vh;
}

audio.media-view-player {
  width: 100%;
  background: transparent;
}

.media-view-note {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
`;

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif'];

/**
 * Which element plays this file. The server's mime decides where it named one;
 * the extension covers a source that arrived without (a persisted result).
 * @param {import('juggler/file-source').FileSource} source - The file
 * @returns {'video'|'audio'|'image'} The kind of player
 */
function mediaKind(source) {
  const mime = (source.mime || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  const ext = extensionOf(source.path || source.absPath || '');
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'video';
}

/**
 * The streaming URL, when the server will actually serve it. A player's load
 * failure does not say *why* it failed, so a refused path (outside the project,
 * which the content route never serves) and an undecodable format would look
 * the same; asking first keeps the bytes fallback for the case it can fix.
 * @param {import('juggler/file-source').FileSource} source - The file
 * @param {AbortSignal} [signal] - Abort signal
 * @returns {Promise<string>} The URL, or '' when the bytes transport is needed
 */
async function streamURL(source, signal) {
  let url = '';
  try { url = source.url(); } catch { url = ''; }
  if (!/^\/(?!\/)/.test(url)) return '';
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    void res.body?.cancel();
    return res.ok ? url : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} text - What to say
 * @returns {HTMLElement} A note element
 */
function note(text) {
  const el = document.createElement('div');
  el.className = 'media-view-note';
  el.textContent = text;
  return el;
}

/**
 * MediaFileViewer — plays video and audio, and shows images the image viewer
 * does not take.
 *
 * Playback streams from `url()`, whose route answers Range requests, so seeking
 * a long recording fetches only what is played. A file that route refuses — it
 * serves the project root only — plays from a blob of `bytes()` instead, the
 * same fallback the image and PDF viewers make.
 *
 * Images are here for display only. The image viewer outranks this one for the
 * formats and sizes every provider accepts, because it is the viewer that hands
 * the model pixels; what reaches this one (a BMP, a HEIC, a PNG over the attach
 * ceiling) is shown to the user and described to the model.
 *
 * SVG is deliberately absent: it is text, and the model reads its source.
 * @augments FileViewer
 */
class MediaFileViewer extends FileViewer {
  /** @type {import('juggler/file-viewer').FileViewerManifest} */
  static MANIFEST = {
    id: 'media',
    name: 'Media',
    version: '1.0.0',
    description: 'Plays video and audio, and displays images',
    mimeTypes: [
      'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg',
      'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/aiff',
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon',
      'image/avif', 'image/tiff', 'image/heic', 'image/heif',
    ],
    extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS],
    // Below the image viewer, so an image a model can be given still goes there.
    priority: 40,
    // What the content route will stream in one response.
    maxBytes: 100 << 20,
  };

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to play
   * @param {HTMLElement} host - Element to render into
   * @param {import('juggler/file-viewer').RenderContext} [ctx] - Abort signal
   * @returns {Promise<(() => void)|void>} Teardown that stops playback and frees the blob
   */
  async render(source, host, ctx = {}) {
    injectStylesOnce('media-file-viewer-styles', STYLES);
    const kind = mediaKind(source);

    let objectURL = '';
    let src = await streamURL(source, ctx.signal);
    if (!src) {
      try {
        const bytes = /** @type {BlobPart} */ (/** @type {unknown} */ (await source.bytes()));
        objectURL = URL.createObjectURL(new Blob([bytes], { type: source.mime || 'application/octet-stream' }));
        src = objectURL;
      } catch (err) {
        host.appendChild(note(t('Couldn’t load this file: {error}', { error: String(/** @type {any} */ (err)?.message || err) })));
        return;
      }
    }
    if (ctx.signal?.aborted) {
      if (objectURL) URL.revokeObjectURL(objectURL);
      return;
    }

    /** @type {HTMLMediaElement|null} */
    let media = null;
    /** @type {HTMLElement} */
    let el;
    if (kind === 'image') {
      el = createImageThumb({ src, alt: source.path || t('image'), className: 'file-view-image' });
    } else {
      media = document.createElement(kind);
      media.className = 'media-view-player';
      media.controls = true;
      media.preload = 'metadata';
      if (kind === 'video') /** @type {HTMLVideoElement} */ (media).playsInline = true;
      media.setAttribute('aria-label', source.path || t('{kind, select, audio {audio} other {video}}', { kind }));
      media.src = src;
      el = media;
    }
    // A format this platform cannot decode (WebKitGTK and WebView2 differ from
    // macOS on HEVC, HEIC, TIFF…) says so rather than leaving a dead player.
    el.addEventListener('error', () => {
      el.replaceWith(note(kind === 'image'
        ? t('This image format can’t be displayed here.')
        : t('{kind, select, audio {This audio format can’t be played here.} other {This video format can’t be played here.}}', { kind })));
    }, { once: true });
    host.appendChild(el);

    return () => {
      if (media) {
        media.pause();
        media.removeAttribute('src');
        // Without load() the element keeps its network connection and decoder.
        media.load();
      }
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }

  /**
   * The model gets no text from a recording or a picture it cannot be given —
   * only what the file is.
   * @param {import('juggler/file-source').FileSource} source - The file
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} Why there is no text
   */
  async extract(source) {
    const kind = mediaKind(source);
    const ext = extensionOf(source.path || source.absPath || '');
    const what = [source.mime || (ext ? `.${ext}` : ''), source.size ? formatFileSize(source.size) : '']
      .filter(Boolean).join(', ');
    const detail = what ? ` (${what})` : '';
    if (kind === 'image') {
      return { warning: markUntranslated(`This image${detail} cannot be attached for viewing (unsupported format or too large), and cannot be read as text.`) };
    }
    return { warning: markUntranslated(`This is ${kind} content${detail}, which cannot be read as text.`) };
  }
}

export default MediaFileViewer;
