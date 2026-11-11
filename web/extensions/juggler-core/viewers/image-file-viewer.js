//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
import { uploadAssetBase64 } from 'juggler/ops';
import { createImageThumb, injectStylesOnce } from 'juggler/ui';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * Capped to the panel, since an image renders at its intrinsic size otherwise.
 * Injected on first render only: `extract()` runs in the engine, which has no DOM.
 */
const STYLES = `
.file-view-image {
  max-width: 100%;
  height: auto;
  align-self: flex-start;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: zoom-in;
}
`;

/**
 * Convert bytes to base64 without blowing the argument limit on a large image
 * (`String.fromCharCode(...bytes)` throws past ~100k arguments).
 * @param {Uint8Array} bytes - Raw bytes
 * @returns {string} Base64 encoding
 */
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * ImageFileViewer — renders images, and hands their pixels to the model.
 *
 * Rendering streams from `url()` rather than a base64 body carried through the
 * conversation document, which drops the 33% inflation every image read used to
 * pay. Extraction uploads the bytes to the conversation's content-addressed
 * asset store and returns an AssetRef as an *attachment* rather than text —
 * because what a multimodal model needs from an image is the pixels.
 *
 * That upload being viewer-owned rather than read-tool-owned is what lets a
 * *pinned* image reach the model too, which was not possible while the
 * behaviour lived inside the read tool.
 * @augments FileViewer
 */
class ImageFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'image',
    name: 'Image',
    version: '1.0.0',
    description: 'Displays images and attaches them for multimodal models',
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    priority: 50,
    // The smallest common provider ceiling (Anthropic's 5 MB per image), so an
    // image this viewer claims is one every provider will accept. A larger image
    // declines to the host's fallback rather than failing at request time.
    maxBytes: 5 << 20,
  };

  /**
   * @param {import('juggler/file-source').FileSource} source - The image
   * @param {HTMLElement} host - Element to render into
   * @returns {Promise<void>}
   */
  async render(source, host) {
    injectStylesOnce('image-file-viewer-styles', STYLES);
    const img = createImageThumb({
      src: source.url(),
      alt: source.path || t('image'),
      className: 'file-view-image',
    });
    // The streaming URL serves only files inside the project root, so an image
    // the user pointed at from anywhere else never loads from it. Recover on the
    // bytes transport — the same fallback the PDF viewer makes, for the same
    // reason — rather than leaving a broken image in the panel. `once` also
    // bounds it: if the blob fails too, there is no second attempt.
    img.addEventListener('error', () => {
      void (async () => {
        try {
          const bytes = /** @type {BlobPart} */ (/** @type {unknown} */ (await source.bytes()));
          const blob = new Blob([bytes], { type: source.mime || 'application/octet-stream' });
          const objectURL = URL.createObjectURL(blob);
          // Revoke once the pixels are decoded: the element holds the decoded
          // image from then on, so keeping the URL alive only leaks the blob.
          img.addEventListener('load', () => URL.revokeObjectURL(objectURL), { once: true });
          img.src = objectURL;
        } catch (err) {
          console.error('[image-file-viewer] bytes fallback failed:', err);
        }
      })();
    }, { once: true });
    host.appendChild(img);
  }

  /**
   * Store the image in the conversation asset store so the model receives the
   * actual pixels alongside the tool result.
   * @param {import('juggler/file-source').FileSource} source - The image
   * @param {import('juggler/file-viewer').ExtractContext} [ctx] - Conversation and abort signal
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} The attachment, or why there isn't one
   */
  async extract(source, ctx = {}) {
    if (!ctx.conversationId) {
      return { warning: 'Image could not be attached for viewing (no conversation context).' };
    }
    try {
      const base64 = toBase64(await source.bytes());
      const ref = await uploadAssetBase64(ctx.conversationId, base64, source.mime, ctx.signal);
      return { attachments: [ref] };
    } catch (err) {
      // The read itself succeeded — degrade to a note rather than failing it.
      return {
        warning: `Image could not be attached for viewing: ${/** @type {any} */ (err)?.message || err}`,
      };
    }
  }
}

export default ImageFileViewer;
