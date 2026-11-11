//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-attachments — the composer's image and text-file staging, for
 * composer.js.
 *
 * Everything between a file arriving (drop, paste, picker, a restored draft)
 * and it being staged on the composer as a pending attachment or dropped-file
 * chip: the per-provider size gates, the upload, the chip row, and the
 * re-staging of a draft's saved references.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * Calls that reach BACK through the element (`composer._handleFiles`,
 * `composer._uploadAndAdd`) are deliberate: those two are the seam the
 * drop/paste tests stub on a mounted element, so they must stay dynamic.
 * @module components/composer-attachments
 */

import apiService from '../services/api.js';
import { createImageThumb } from '../utils/image-lightbox.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t, formatNumber, markUntranslated } from '../../sdk/lib/i18n.js';

/**
 * Fallback per-image byte ceiling — a generous upload-safety limit used when
 * the send target's provider has no specific, documented image cap (see
 * {@link PROVIDER_MAX_IMAGE_BYTES}), or when the model is automatic and the
 * provider isn't known client-side.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Per-provider hard limit on a single image's byte size, keyed by the provider
 * `name` from the providers list. Each mirrors that vendor's documented API
 * ceiling. Enforced at drop/paste/pick time so an oversized image is rejected
 * locally instead of being uploaded, attached, and rejected by the provider at
 * send time — where, because the attachment is now part of the conversation
 * history, EVERY subsequent turn re-sends it and fails the same way ("image too
 * big") until the user rewinds past the message. This is purely a size gate;
 * model *capability* is still never gated client-side (an incapable model
 * rejects at send time). Providers absent here fall back to
 * {@link MAX_ATTACHMENT_BYTES}.
 * @type {Record<string, number>}
 */
const PROVIDER_MAX_IMAGE_BYTES = {
  anthropic: 5 * 1024 * 1024, // Claude API: 5 MB per image
  claudecode: 5 * 1024 * 1024, // Claude via Claude Code — same vision limit
  openai: 20 * 1024 * 1024, // OpenAI vision: 20 MB per image
  gemini: 20 * 1024 * 1024, // Gemini inline data: 20 MB request cap
};

/** Reject a send whose attachments sum past this aggregate (bytes). */
const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Reject any single dropped TEXT file larger than this (bytes). Much smaller
 * than the image cap: a dropped text file is inlined into the prompt as context
 * (not sent as an opaque asset), so the binding constraint is the context
 * window, not bandwidth — ~512 KB is already ~130k tokens. Enforced on
 * `file.size` BEFORE the file is read, so a multi-GB drop is rejected without
 * ever being allocated or decoded.
 */
const MAX_TEXT_DROP_BYTES = 512 * 1024;

/** Reject a drop whose text files sum past this aggregate (bytes). */
const MAX_TEXT_DROP_TURN_BYTES = 1024 * 1024;

/**
 * A file's size in megabytes, to one decimal place, for a refusal notice.
 * @param {number} bytes
 * @returns {string} The formatted number.
 */
function formatMegabytes(bytes) {
  return formatNumber(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
}

/**
 * A size limit (already in its unit) for a refusal notice.
 * @param {number} value
 * @returns {string} The formatted number.
 */
function formatLimit(value) {
  return formatNumber(value, { useGrouping: false });
}

/**
 * Heuristic: does a just-decoded string look like binary rather than text?
 *
 * `FileReader.readAsText` will happily decode a PDF or image into mojibake, so
 * we sample the decoded string for the two tells of a mis-decoded binary: NUL
 * bytes (never present in real text) and a high ratio of U+FFFD replacement
 * characters (what invalid UTF-8 sequences collapse to). Only the head is
 * sampled — enough to catch binaries cheaply without walking a large file.
 *
 * Shared with composer-paste-tokens.js: a large paste asks the same question of
 * a decoded string that a dropped file does.
 * @param {string} str - Decoded file contents
 * @returns {boolean} True if the content appears to be binary
 */
export function looksBinary(str) {
  if (!str) return false;
  const sample = str.length > 4096 ? str.slice(0, 4096) : str;
  let replacement = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;            // NUL — decisive
    if (code === 0xfffd) replacement++;     // U+FFFD replacement char
  }
  return replacement / sample.length > 0.1;
}

/**
 * The per-image byte ceiling for the model this composer will send to.
 * Resolves the effective provider (thread override → conversation default)
 * and returns its documented per-image limit ({@link PROVIDER_MAX_IMAGE_BYTES}),
 * falling back to {@link MAX_ATTACHMENT_BYTES} when the provider has no
 * specific limit or the model is automatic (provider unknown client-side).
 * @param {any} composer - Composer instance
 * @returns {number} Max bytes for a single image attachment.
 */
function maxImageBytes(composer) {
  const cfg = composer._messageThread?.getEffectiveModelConfig?.()
    || composer._conversation?.modelConfig
    || null;
  const provider = cfg && cfg.provider ? cfg.provider : '';
  return PROVIDER_MAX_IMAGE_BYTES[provider] || MAX_ATTACHMENT_BYTES;
}

/**
 * Fallback image paste for WebKit desktop windows (WebKitGTK/WKWebView, i.e.
 * the Wails app), whose synchronous `paste` event omits the image file and
 * exposes it only through the async Clipboard API. Materialises any image
 * entries as `File`s and routes them through the same {@link handleFiles}
 * path as sync paste / drop / picker. Best-effort: a missing API or a
 * clipboard with no image is a silent no-op, so it can only add successful
 * pastes, never break one.
 * @param {any} composer - Composer instance
 * @returns {Promise<void>}
 */
export async function pasteImagesFromAsyncClipboard(composer) {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== 'function') return;
  let clipboardItems;
  try {
    clipboardItems = await clipboard.read();
  } catch {
    return; // no permission, insecure context, or nothing readable
  }
  /** @type {File[]} */
  const files = [];
  for (const item of clipboardItems) {
    const type = Array.from(item.types || []).find((mime) => mime.startsWith('image/'));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const ext = type.split('/')[1] || 'png';
      files.push(new window.File([blob], `pasted-image-${files.length + 1}.${ext}`, { type }));
    } catch { /* skip an entry we can't materialise; keep any others */ }
  }
  if (files.length > 0) composer._handleFiles(files);
}

/**
 * Validate and upload a set of dropped/pasted/picked files, pushing each
 * successful upload onto _pendingAttachments. Non-image files are ignored;
 * oversized files (single or aggregate) are rejected with a warning.
 *
 * Image attachments are staged regardless of the current model's *capability*
 * — that is never gated client-side; a model that can't accept images rejects
 * the request at send time. Image *size* IS gated here, to the send target's
 * per-provider limit ({@link maxImageBytes}), so an image the provider would
 * reject never enters the conversation in the first place.
 * @param {any} composer - Composer instance
 * @param {FileList|File[]} fileList
 */
export function handleFiles(composer, fileList) {
  const files = Array.from(fileList).filter((f) => f.type && f.type.startsWith('image/'));
  if (files.length === 0) return;

  const maxPerImage = maxImageBytes(composer);

  for (const file of files) {
    if (file.size > maxPerImage) {
      composer.showWarning(t(
        '"{name}" is too large ({size} MB, max {max} MB per image for the current model).',
        { name: file.name, size: formatMegabytes(file.size), max: formatLimit(maxPerImage / 1024 / 1024) }
      ));
      continue;
    }
    const pendingTotal = composer._pendingAttachments.reduce(
      (/** @type {number} */ sum, /** @type {any} */ a) => sum + (a.bytes || 0), 0);
    if (pendingTotal + file.size > MAX_TURN_ATTACHMENT_BYTES) {
      composer.showWarning(t(
        'Attachments exceed the {max} MB per-message limit.',
        { max: formatLimit(MAX_TURN_ATTACHMENT_BYTES / 1024 / 1024) }
      ));
      break;
    }
    composer._uploadAndAdd(file);
  }
}

/**
 * Validate and stage a set of dropped non-image files as text snapshots.
 *
 * Three gates, in order:
 *  1. per-file size — checked on `file.size` BEFORE any read, so a multi-GB
 *     drop is rejected without ever being allocated or decoded;
 *  2. aggregate size — the drop's text files may not sum past the per-message
 *     limit (counting already-staged files);
 *  3. binary — after decoding a known-small file, reject anything that looks
 *     binary rather than text ({@link looksBinary}).
 *
 * Survivors are pushed onto `_pendingTextFiles` and become `dropped-file`
 * context items at send time.
 * @param {any} composer - Composer instance
 * @param {FileList|File[]} fileList
 */
export function handleTextFiles(composer, fileList) {
  for (const file of Array.from(fileList)) {
    // Gate 1: size, on metadata, before reading a single byte.
    if (file.size > MAX_TEXT_DROP_BYTES) {
      composer.showWarning(t(
        '"{name}" is too large to attach as text ({size} MB, max {max} KB).',
        { name: file.name, size: formatMegabytes(file.size), max: formatLimit(MAX_TEXT_DROP_BYTES / 1024) }
      ));
      continue;
    }
    // Gate 2: aggregate across already-staged text files.
    const stagedTotal = composer._pendingTextFiles.reduce(
      (/** @type {number} */ sum, /** @type {any} */ staged) => sum + (staged.bytes || 0), 0);
    if (stagedTotal + file.size > MAX_TEXT_DROP_TURN_BYTES) {
      composer.showWarning(t(
        'Dropped text files exceed the {max} MB per-message limit.',
        { max: formatLimit(MAX_TEXT_DROP_TURN_BYTES / 1024 / 1024) }
      ));
      break;
    }

    const reader = new window.FileReader();
    reader.onload = () => {
      // readAsText yields a string; guard the union type without String().
      const content = typeof reader.result === 'string' ? reader.result : '';
      // Gate 3: binary check (file is already known-small, so this is cheap).
      if (looksBinary(content)) {
        composer.showWarning(t('"{name}" doesn\'t look like a text file.', { name: file.name }));
        return;
      }
      composer._pendingTextFiles.push({ filename: file.name, content, bytes: file.size });
      renderAttachmentChips(composer);
      // Persist so the staged file survives a reload alongside the text.
      composer._persistDraft();
    };
    reader.onerror = () => composer.showWarning(t('Couldn\'t read "{name}".', { name: file.name }));
    reader.readAsText(file);
  }
}

/**
 * Remove a staged dropped text file and re-render the chip row.
 * @param {any} composer - Composer instance
 * @param {{filename:string,content:string,bytes:number}} entry
 */
function removeTextFile(composer, entry) {
  const idx = composer._pendingTextFiles.indexOf(entry);
  if (idx === -1) return;
  composer._pendingTextFiles.splice(idx, 1);
  renderAttachmentChips(composer);
  composer._persistDraft();
}

/**
 * Upload one image file to the conversation's asset store, showing an
 * "uploading" chip while in flight and replacing it with the resolved
 * AssetRef on success (or removing it on failure).
 * @param {any} composer - Composer instance
 * @param {File} file
 */
export async function uploadAndAdd(composer, file) {
  const convId = composer._conversation?.id;
  if (!convId) {
    composer.showWarning(t("Couldn't attach the image: no conversation is open."));
    return;
  }
  // Placeholder chip while the bytes upload. Carries a local preview URL so
  // the thumbnail shows immediately (the asset GET URL only works post-upload).
  const placeholder = {
    id: '', mime: file.type, filename: file.name, bytes: file.size,
    width: 0, height: 0, _uploading: true, _previewURL: URL.createObjectURL(file)
  };
  composer._pendingAttachments.push(placeholder);
  renderAttachmentChips(composer);

  try {
    const ref = await apiService.uploadAsset(convId, file);
    const idx = composer._pendingAttachments.indexOf(placeholder);
    if (idx !== -1) {
      // Carry the local preview URL onto the resolved ref so the thumbnail
      // doesn't flicker (revoked when the chip is removed / cleared).
      composer._pendingAttachments[idx] = { ...ref, _previewURL: placeholder._previewURL };
    } else if (placeholder._previewURL) {
      // Chip was removed mid-upload — drop the resolved ref and free the URL.
      URL.revokeObjectURL(placeholder._previewURL);
    }
    renderAttachmentChips(composer);
    // The attachment is now a resolved asset — fold it into the persisted
    // draft so it survives a reload alongside the text.
    composer._persistDraft();
  } catch (err) {
    const idx = composer._pendingAttachments.indexOf(placeholder);
    if (idx !== -1) composer._pendingAttachments.splice(idx, 1);
    if (placeholder._previewURL) URL.revokeObjectURL(placeholder._previewURL);
    renderAttachmentChips(composer);
    composer.showWarning(t('Image upload failed: {error}', { error: errorText(err) }));
  }
}

/**
 * Remove a staged attachment and re-render the chip row.
 * @param {any} composer - Composer instance
 * @param {{_previewURL?:string}} ref
 */
function removeAttachment(composer, ref) {
  const idx = composer._pendingAttachments.indexOf(/** @type {any} */ (ref));
  if (idx === -1) return;
  composer._pendingAttachments.splice(idx, 1);
  if (ref._previewURL) URL.revokeObjectURL(ref._previewURL);
  renderAttachmentChips(composer);
  // Persist the draft so the removal survives a reload too.
  composer._persistDraft();
}

/**
 * Replace the staged attachments with a restored set (used when a "rewind to
 * this message" puts an attachment-bearing user message back into the box for
 * editing/resend). Clones each ref down to the persistable AssetRef fields,
 * dropping any UI-only state (`_previewURL`/`_uploading`) from the source —
 * the restored chips render their thumbnails from the asset GET URL.
 *
 * Attachments are restored regardless of the current model — capability is
 * not gated client-side. A model that can't accept images rejects the
 * request at send time and that provider error surfaces as the turn error.
 * @param {any} composer - Composer instance
 * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
 * @returns {number} Count of attachments actually staged.
 */
export function setPendingAttachments(composer, refs) {
  const count = stagePendingAttachments(composer, refs);
  // This is a genuine draft change (rewind/restore-from-message) — persist
  // the whole draft so text + attachments survive a reload together.
  composer._persistDraft();
  return count;
}

/**
 * Replace the in-memory staged attachments and re-render the chip row WITHOUT
 * persisting. Used both by setPendingAttachments (which then persists) and by
 * the draft-restore path in setMessageThread (which is reading FROM the
 * persisted draft, so re-persisting would be redundant churn).
 * @param {any} composer - Composer instance
 * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
 * @returns {number} Count of attachments actually staged.
 */
export function stagePendingAttachments(composer, refs) {
  // Revoke any preview URLs on the outgoing pending set before replacing it.
  for (const a of composer._pendingAttachments) {
    if (a._previewURL) URL.revokeObjectURL(a._previewURL);
  }
  composer._pendingAttachments = [];

  const list = Array.isArray(refs) ? refs.filter((r) => r && r.id) : [];
  if (list.length === 0) {
    renderAttachmentChips(composer);
    return 0;
  }

  composer._pendingAttachments = list.map((r) => ({
    id: r.id,
    mime: r.mime,
    filename: r.filename,
    bytes: r.bytes,
    width: r.width,
    height: r.height
  }));
  renderAttachmentChips(composer);
  return composer._pendingAttachments.length;
}

/**
 * Replace the in-memory staged text files and re-render the chip row WITHOUT
 * persisting — the text-file counterpart to {@link stagePendingAttachments},
 * called from the draft-restore path that is reading FROM the persisted draft.
 * Clones down to the persistable fields so no stray UI state carries over.
 * @param {any} composer - Composer instance
 * @param {Array<{filename:string,content:string,bytes:number}>} entries
 * @returns {number} Count of text files actually staged.
 */
export function stagePendingTextFiles(composer, entries) {
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry && typeof entry.content === 'string')
    : [];
  composer._pendingTextFiles = list.map((entry) => ({
    // The stored name becomes the dropped-file context item's `<file path=…>`
    // label, which the model reads.
    filename: entry.filename || markUntranslated('dropped file'),
    content: entry.content,
    bytes: entry.bytes || 0
  }));
  renderAttachmentChips(composer);
  return composer._pendingTextFiles.length;
}

/**
 * Render the staged-attachment chip row from _pendingAttachments. Rebuilds
 * only its own container (never the textarea), so caret/focus are preserved.
 * @param {any} composer - Composer instance
 */
export function renderAttachmentChips(composer) {
  // An image staged with no text is a valid send, so the enabled state of the
  // send button depends on attachments too — refresh it on every attachment
  // mutation (this function is the single choke point for add/remove/stage).
  composer._updateSendButtonState();
  const container = composer.querySelector('composer-box-attachments');
  if (!container) return;
  container.innerHTML = '';
  if (composer._pendingAttachments.length === 0 && composer._pendingTextFiles.length === 0) {
    container.classList.remove('has-attachments');
    return;
  }
  container.classList.add('has-attachments');
  const convId = composer._conversation?.id;

  for (const ref of composer._pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip' + (ref._uploading ? ' uploading' : '');

    // Click the thumbnail to preview the staged image full-size — the same
    // lightbox used for attachments inside a sent user-message item.
    const src = ref._previewURL || (ref.id && convId ? apiService.assetURL(convId, ref.id) : '');
    const thumb = createImageThumb({
      src,
      alt: ref.filename || '',
      className: src ? 'attachment-thumb clickable' : 'attachment-thumb',
    });
    chip.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'attachment-name text-truncate';
    name.textContent = ref.filename || t('image');
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('Remove attachment'));
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => removeAttachment(composer, ref));
    chip.appendChild(remove);

    container.appendChild(chip);
  }

  // Dropped text files: a document-icon chip (no image thumbnail).
  for (const entry of composer._pendingTextFiles) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip text-file';

    const icon = document.createElement('span');
    icon.className = 'attachment-icon icon-document';
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'attachment-name text-truncate';
    name.textContent = entry.filename || t('text file');
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('Remove attachment'));
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => removeTextFile(composer, entry));
    chip.appendChild(remove);

    container.appendChild(chip);
  }
}
