//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-attachments — the composer's image, video and text-file staging,
 * for composer.js.
 *
 * Everything between a file arriving (drop, paste, picker, a restored draft)
 * and it being staged on the composer as a pending attachment or dropped-file
 * chip: the per-provider size gates, the video capability check, the upload,
 * the chip row, and the re-staging of a draft's saved references.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * Calls that reach BACK through the element (`composer._handleFiles`,
 * `composer._uploadAndAdd`) are deliberate: those two are the seam the
 * drop/paste tests stub on a mounted element, so they must stay dynamic.
 * @module components/composer-attachments
 */

import apiService from '../services/api.js';
import providersCache from '../services/providers-cache.js';
import { modelLabelFromList } from '../model/model-display.js';
import { videoMime } from '../utils/file-drop.js';
import { createImageThumb } from '../utils/image-lightbox.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t, formatNumber, markUntranslated } from '../../sdk/lib/i18n.js';
import { createFileSource, mimeForPath } from '../../sdk/file-source.js';
import fileViewerRegistry from '../registries/file-viewer-registry.js';
import { isStoredDrop, plainStoredDrop } from '../utils/attachments.js';

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

/** Reject a send whose image attachments sum past this aggregate (bytes). */
const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Fallback per-video byte ceiling: what the asset route accepts for a video
 * (`maxVideoUploadBytes`). A provider whose API documents a lower one gets an
 * entry in {@link PROVIDER_MAX_VIDEO_BYTES} alongside its video support.
 */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Per-provider limit on a single video's byte size, keyed like
 * {@link PROVIDER_MAX_IMAGE_BYTES}. Empty while no provider takes video.
 * @type {Record<string, number>}
 */
const PROVIDER_MAX_VIDEO_BYTES = {};

/**
 * The video types the asset store keeps (`videoAssetExts` server-side); any
 * other is refused at upload, so it is refused here first.
 */
const UPLOADABLE_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Reject any single dropped TEXT file larger than this (bytes). Much smaller
 * than the image cap: a dropped text file is inlined into the prompt as context
 * (not sent as an opaque asset), so the binding constraint is the context
 * window, not bandwidth — ~512 KB is already ~130k tokens. Enforced on
 * `file.size` BEFORE the file is read, so a multi-GB drop is rejected without
 * ever being allocated or decoded.
 */
const MAX_TEXT_DROP_BYTES = 512 * 1024;

/**
 * The most inline text a message's dropped files may sum to (bytes). A file
 * that would take the total past it is stored in the project instead.
 */
const MAX_TEXT_DROP_TURN_BYTES = 1024 * 1024;

/**
 * The largest request body the Direct P2P remote link carries
 * (maxRequestBodyBytes in tunnel/peer/bridge.go): it base64-encodes a body
 * whole, so a larger drop is refused here before the tab encodes it.
 */
const MAX_REMOTE_LINK_DROP_BYTES = 32 * 1024 * 1024;

/**
 * The largest drop this page's connection carries up front: the remote link's
 * cap when the page runs over it (its bootstrap publishes
 * `window.__jugglerStudio`), and otherwise no client-side bound — the server's
 * own cap answers a 413.
 * @returns {number} Bytes.
 */
function dropUploadLimit() {
  return /** @type {any} */ (window).__jugglerStudio ? MAX_REMOTE_LINK_DROP_BYTES : Infinity;
}

/**
 * The inline text a composer's staged dropped files already hold (bytes):
 * stored drops are not counted, since they are not inlined.
 * @param {any} composer - Composer instance
 * @returns {number} Bytes.
 */
function inlineTextTotal(composer) {
  return composer._pendingTextFiles.reduce(
    (/** @type {number} */ sum, /** @type {any} */ staged) => sum + (typeof staged.content === 'string' ? (staged.bytes || 0) : 0), 0);
}

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
  return PROVIDER_MAX_IMAGE_BYTES[sendTarget(composer).provider] || MAX_ATTACHMENT_BYTES;
}

/**
 * The model this composer will send to (thread override → conversation
 * default). Both are empty when the model is automatic: which one serves the
 * turn is decided server-side, so the browser cannot know it.
 * @param {any} composer - Composer instance
 * @returns {{provider: string, model: string}} The send target.
 */
function sendTarget(composer) {
  const cfg = composer._messageThread?.getEffectiveModelConfig?.()
    || composer._conversation?.modelConfig
    || null;
  return cfg && cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : { provider: '', model: '' };
}

/**
 * Whether a published model takes video input. Only a provider whose
 * converters send video publishes "video" (`PublishedInputModalities`
 * server-side), so this is exactly whether a staged video would reach it.
 * @param {any} model - A `modelsWithContext` entry
 * @returns {boolean} True when the model takes video.
 */
function takesVideo(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes('video');
}

/**
 * Why a video cannot be sent to this composer's model, as the notice to show,
 * or null when it can. The notice says what the file is, which model will not
 * take it (unless the model is automatic, when the browser cannot name it),
 * and what to do: switch to a model that takes video when one is available,
 * else attach screenshots.
 *
 * Unlike an image, a video's capability IS checked here: no model the user is
 * likely to be on takes video, so letting the provider refuse at send time
 * would make every video a failed turn — and leave it in the history to be
 * withheld on every turn after.
 * @param {any} composer - Composer instance
 * @param {string} name - The video's file name
 * @returns {string|null} The refusal, or null when the model takes video.
 */
function videoRefusal(composer, name) {
  const providers = providersCache.get();
  const { provider, model } = sendTarget(composer);
  if (provider) {
    const entry = providers.find((p) => p.name === provider)?.modelsWithContext?.find((m) => m.id === model);
    if (takesVideo(entry)) return null;
  }
  /** @type {string} */
  let alternative = '';
  for (const p of providers) {
    if (!p.available || p.decisionOnly) continue;
    const found = (p.modelsWithContext || []).find((m) => takesVideo(m) && !(/** @type {any} */ (m).hidden));
    if (found) {
      alternative = modelLabelFromList(providers, p.name, found.id);
      break;
    }
  }
  if (provider) {
    const label = modelLabelFromList(providers, provider, model);
    return alternative
      ? t('"{name}" is a video, and {model} doesn\'t accept video input. Switch to a model that does, such as {alternative}, to send it.',
        { name, model: label, alternative })
      : t('"{name}" is a video, and {model} doesn\'t accept video input. Attach screenshots of the moments that matter instead.',
        { name, model: label });
  }
  return alternative
    ? t('"{name}" is a video, and the automatic model choice may not accept video input. Choose a model that does, such as {alternative}, to send it.',
      { name, alternative })
    : t('"{name}" is a video, and none of the models available here accept video input. Attach screenshots of the moments that matter instead.',
      { name });
}

/**
 * Whether a staged attachment is a video.
 * @param {{mime?: string}} ref - A pending attachment
 * @returns {boolean} True for a video.
 */
function isVideoRef(ref) {
  return typeof ref.mime === 'string' && ref.mime.startsWith('video/');
}

/**
 * The refusal for the first staged video the current model would not be sent,
 * or null when every staged video can go. A send is blocked on it: the video
 * was staged for a model that took it, and the target has changed since.
 * @param {any} composer - Composer instance
 * @returns {string|null} The refusal to show, or null.
 */
export function stagedVideoRefusal(composer) {
  for (const a of composer._pendingAttachments) {
    if (!isVideoRef(a)) continue;
    const refusal = videoRefusal(composer, a.filename || t('video'));
    if (refusal) return refusal;
  }
  return null;
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
 * — that is never gated client-side for images; a model that can't accept
 * them rejects the request at send time. (Video is the exception, checked in
 * {@link handleVideoFiles}.) Image *size* IS gated here, to the send target's
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
    // Videos are bounded on their own (handleVideoFiles), so they are left out
    // of what the images may add up to.
    const pendingTotal = composer._pendingAttachments
      .filter((/** @type {any} */ a) => !isVideoRef(a))
      .reduce((/** @type {number} */ sum, /** @type {any} */ a) => sum + (a.bytes || 0), 0);
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
 * Stage a set of dropped/pasted/picked videos, for a model that takes video.
 *
 * The model is checked first, before any size or format, so a video the model
 * cannot be sent gets the one notice that says so ({@link videoRefusal}) at
 * any size, rather than a size limit that implies a smaller one would do.
 * Then the format (only those the asset store keeps), then the per-video size
 * limit, then the upload, through the same path as an image.
 * @param {any} composer - Composer instance
 * @param {FileList|File[]} fileList - Files {@link videoMime} names a video
 */
export function handleVideoFiles(composer, fileList) {
  for (const file of Array.from(fileList)) {
    const refusal = videoRefusal(composer, file.name);
    if (refusal) {
      composer.showWarning(refusal);
      continue;
    }
    const mime = videoMime(file);
    if (!UPLOADABLE_VIDEO_TYPES.has(mime)) {
      composer.showWarning(t('"{name}" is in a video format that can\'t be attached. Convert it to MP4, MOV or WebM.', { name: file.name }));
      continue;
    }
    const max = PROVIDER_MAX_VIDEO_BYTES[sendTarget(composer).provider] || MAX_VIDEO_BYTES;
    if (file.size > max) {
      composer.showWarning(t(
        '"{name}" is too large ({size} MB, max {max} MB per video for the current model).',
        { name: file.name, size: formatMegabytes(file.size), max: formatLimit(max / 1024 / 1024) }
      ));
      continue;
    }
    // A file handed over with no type is uploaded as the type its name gives,
    // which is what the asset route stores it by.
    composer._uploadAndAdd(file.type ? file : new window.File([file], file.name, { type: mime }));
  }
}

/**
 * Stage a set of dropped non-image files: inline as text snapshots where they
 * fit, and otherwise uploaded to the project ({@link stageStoredDrop}).
 *
 * Three gates send a file to the project instead of inlining it, in order:
 *  1. per-file size — checked on `file.size` BEFORE any read, so a multi-GB
 *     drop is never allocated or decoded here;
 *  2. aggregate size — the message's inline text may not sum past the
 *     per-message limit (counting already-staged files);
 *  3. binary — after decoding a known-small file, anything that looks binary
 *     rather than text ({@link looksBinary}).
 *
 * Inline survivors are pushed onto `_pendingTextFiles` and become
 * `dropped-file` context items at send time; stored drops join them there.
 * @param {any} composer - Composer instance
 * @param {FileList|File[]} fileList
 */
export function handleTextFiles(composer, fileList) {
  for (const file of Array.from(fileList)) {
    const Viewer = extractingViewer(file);
    if (Viewer) {
      void stageExtractedFile(composer, file, Viewer);
      continue;
    }
    // Gates 1 and 2: size, on metadata, before reading a single byte.
    if (file.size > MAX_TEXT_DROP_BYTES || inlineTextTotal(composer) + file.size > MAX_TEXT_DROP_TURN_BYTES) {
      void stageStoredDrop(composer, file);
      continue;
    }

    const reader = new window.FileReader();
    reader.onload = () => {
      // readAsText yields a string; guard the union type without String().
      const content = typeof reader.result === 'string' ? reader.result : '';
      // Gate 3: binary check (file is already known-small, so this is cheap).
      if (looksBinary(content)) {
        void stageStoredDrop(composer, file);
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
 * The file viewer that can turn a dropped binary file into text — a PDF — or
 * undefined for a file that is read as text (or not at all).
 *
 * Only a viewer that claims the file by its MIME type or extension counts: the
 * `matchAll` viewers (plain text, the binary fallback) are what every file falls
 * back to, and the text path already does their job. A viewer's `maxBytes` is
 * honoured by resolution, so an oversized PDF falls through to the text path's
 * size gate, and is stored in the project.
 * @param {File} file - The dropped file
 * @returns {typeof import('../../sdk/file-viewer.js').default|undefined} The viewer to extract with
 */
function extractingViewer(file) {
  if (file.type.startsWith('text/')) return undefined;
  const Viewer = fileViewerRegistry.resolve({
    path: file.name,
    mime: file.type || mimeForPath(file.name),
    size: file.size,
    isBinary: true,
  });
  return Viewer && !Viewer.MANIFEST?.matchAll ? Viewer : undefined;
}

/**
 * Stage a dropped binary file as the text its viewer extracts — what the model
 * would get from `@`-mentioning the same file. A drop carries bytes and no
 * path, so extraction runs here, on the bytes, in the realm that received
 * them; the result is a frozen snapshot like any dropped text file. The text is
 * held to the per-file text budget (the viewer stops at a page boundary) and
 * counts against the per-message one. A file that yields no text, or more than
 * the message has room for, is stored in the project instead.
 * @param {any} composer - Composer instance
 * @param {File} file - The dropped file
 * @param {typeof import('../../sdk/file-viewer.js').default} Viewer - The viewer that claims it
 * @returns {Promise<void>}
 */
async function stageExtractedFile(composer, file, Viewer) {
  const source = createFileSource({
    path: file.name,
    mime: file.type || mimeForPath(file.name),
    size: file.size,
    isBinary: true,
    // A dropped file has no server URL; extraction reads the bytes.
    url: () => '',
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  });
  /** @type {import('../../sdk/file-viewer.js').ExtractResult} */
  let result;
  try {
    result = await new Viewer().extract(source, { maxChars: MAX_TEXT_DROP_BYTES });
  } catch {
    result = {};
  }
  const content = result.text || '';
  // A viewer that claims the file and yields only a warning (audio, an image
  // format no model is given) has said it has no text, and one that failed
  // outright has none to give: either way the agent gets the bytes, on disk.
  if (!content || inlineTextTotal(composer) + content.length > MAX_TEXT_DROP_TURN_BYTES) {
    await stageStoredDrop(composer, file);
    return;
  }
  // `bytes` is what the snapshot inlines, which is what the budgets measure.
  composer._pendingTextFiles.push({ filename: file.name, content, bytes: content.length, extracted: true });
  renderAttachmentChips(composer);
  composer._persistDraft();
}

/**
 * Upload a dropped file to the project's `.juggler-drops/` and stage it as a
 * stored drop: the agent reads it there with its file tools, so no size is too
 * large to hand it and no format is refused. While the bytes upload, a dimmed
 * chip stands in for it (`_uploading`; removing it aborts the upload), and the
 * composer will not send (see Composer.sendMessage), so the message never
 * leaves without a file the user is waiting on.
 * @param {any} composer - Composer instance
 * @param {File} file - The dropped file
 * @returns {Promise<void>}
 */
async function stageStoredDrop(composer, file) {
  const convId = composer._conversation?.id;
  if (!convId) {
    composer.showWarning(t('Couldn\'t attach "{name}": no conversation is open.', { name: file.name }));
    return;
  }
  const limit = dropUploadLimit();
  if (file.size > limit) {
    composer.showWarning(t(
      '"{name}" is too large to send over this connection ({size} MB, max {max} MB).',
      { name: file.name, size: formatMegabytes(file.size), max: formatLimit(limit / 1024 / 1024) }
    ));
    return;
  }
  const controller = new AbortController();
  const placeholder = { filename: file.name, bytes: file.size, _uploading: true, _abort: () => controller.abort() };
  composer._pendingTextFiles.push(placeholder);
  renderAttachmentChips(composer);
  try {
    const ref = await apiService.uploadDrop(convId, file, { signal: controller.signal });
    const idx = composer._pendingTextFiles.indexOf(placeholder);
    // A chip removed mid-upload leaves the stored file unreferenced; it is
    // the same file a second drop of these bytes would reuse.
    if (idx === -1) return;
    composer._pendingTextFiles[idx] = plainStoredDrop({ ...ref, filename: ref.filename || file.name });
    renderAttachmentChips(composer);
    composer._persistDraft();
  } catch (err) {
    const idx = composer._pendingTextFiles.indexOf(placeholder);
    if (idx !== -1) composer._pendingTextFiles.splice(idx, 1);
    renderAttachmentChips(composer);
    if (controller.signal.aborted) return;
    // A 413 the server wrote names its own cap; one with no message of the
    // server's came from the link between (the P2P bridge, Cloudflare's edge).
    const e = /** @type {any} */ (err);
    composer.showWarning(e?.status === 413 && !e.serverMessage
      ? t('"{name}" is too large to send over this connection ({size} MB).', { name: file.name, size: formatMegabytes(file.size) })
      : t('Couldn\'t upload "{name}": {error}', { name: file.name, error: errorText(err) }));
  }
}

/**
 * Remove a staged dropped file and re-render the chip row, aborting its upload
 * when it is still in flight.
 * @param {any} composer - Composer instance
 * @param {{filename:string,bytes:number,_abort?:() => void}} entry
 */
function removeTextFile(composer, entry) {
  const idx = composer._pendingTextFiles.indexOf(entry);
  if (idx === -1) return;
  entry._abort?.();
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
  const isVideo = file.type.startsWith('video/');
  const convId = composer._conversation?.id;
  if (!convId) {
    composer.showWarning(isVideo
      ? t("Couldn't attach the video: no conversation is open.")
      : t("Couldn't attach the image: no conversation is open."));
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
    composer.showWarning(isVideo
      ? t('Video upload failed: {error}', { error: errorText(err) })
      : t('Image upload failed: {error}', { error: errorText(err) }));
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
 * @param {import('../utils/attachments.js').DroppedFileEntry[]} entries
 * @returns {number} Count of text files actually staged.
 */
export function stagePendingTextFiles(composer, entries) {
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry && (typeof (/** @type {any} */ (entry)).content === 'string' || isStoredDrop(entry)))
    : [];
  composer._pendingTextFiles = list.map((entry) => (isStoredDrop(entry)
    ? plainStoredDrop(entry)
    : {
      // The stored name becomes the dropped-file context item's `<file path=…>`
      // label, which the model reads.
      filename: entry.filename || markUntranslated('dropped file'),
      content: entry.content,
      bytes: entry.bytes || 0,
      ...(entry.extracted ? { extracted: true } : {})
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
    const isVideo = isVideoRef(ref);
    const chip = document.createElement('div');
    chip.className = 'attachment-chip' + (isVideo ? ' video' : '') + (ref._uploading ? ' uploading' : '');

    if (isVideo) {
      // A video gets a glyph: an <img> of it would draw as a broken image.
      const icon = document.createElement('span');
      icon.className = 'attachment-icon icon-play';
      chip.appendChild(icon);
    } else {
      // Click the thumbnail to preview the staged image full-size — the same
      // lightbox used for attachments inside a sent user-message item.
      const src = ref._previewURL || (ref.id && convId ? apiService.assetURL(convId, ref.id) : '');
      const thumb = createImageThumb({
        src,
        alt: ref.filename || '',
        className: src ? 'attachment-thumb clickable' : 'attachment-thumb',
      });
      chip.appendChild(thumb);
    }

    const name = document.createElement('span');
    name.className = 'attachment-name text-truncate';
    name.textContent = ref.filename || (isVideo ? t('video') : t('image'));
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

  // Dropped files: a document-icon chip (no image thumbnail), dimmed while a
  // stored drop's bytes upload.
  for (const entry of composer._pendingTextFiles) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip text-file' + (entry._uploading ? ' uploading' : '');
    if (entry._uploading) chip.title = t('Uploading "{name}"…', { name: entry.filename });
    else if (typeof entry.path === 'string') chip.title = entry.path;

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
