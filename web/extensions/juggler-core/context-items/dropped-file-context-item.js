//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatFileContentForLLM, injectFileContentStyles } from 'juggler/item-utils';
import { fileSourceFromText } from 'juggler/file-source';
import { createElement, createFileView, addFilePath } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

injectFileContentStyles();

/**
 * What the drop upload saw of a stored file: its sniffed type; for text, its
 * line count and first lines; for an archive, its first entries and count.
 * @typedef {object} StoredDropPreview
 * @property {string} mime - Sniffed content type
 * @property {boolean} text - The head is UTF-8 text
 * @property {number} [lines] - A text file's line count
 * @property {string} [head] - A text file's first lines, bounded
 * @property {string[]} [entries] - An archive's first entry names
 * @property {number} [entryCount] - How many entries an archive has
 */

/**
 * Persisted Yjs shape for a dropped file: an inline text snapshot, or a file
 * too large or too binary for that, stored in the project's `.juggler-drops/`
 * (`path` set, `content` empty).
 * @typedef {object} DroppedFileData
 * @property {string} filename - Display name captured from the drop (File.name)
 * @property {string} content - Full text captured at drop time (the snapshot);
 *   empty for a stored drop
 * @property {string} [path] - A stored drop's project-relative path
 * @property {string} [absPath] - A stored drop's absolute path, which is what
 *   the model is given (a worktree conversation's shell runs outside the
 *   project root)
 * @property {number} [bytes] - A stored drop's size
 * @property {string} [sha256] - A stored drop's content hash
 * @property {StoredDropPreview} [preview] - What a stored drop holds, up front
 * @property {boolean} [extracted] - `content` is a file viewer's `extract()`
 *   output for a binary file (a PDF): already model-facing, `<file>` envelope
 *   included, so it is passed through rather than wrapped again
 * @property {boolean} [hidden] - Taken out of context by drop_context_items.
 *   The snapshot is kept, since nothing else holds it, and the item renders as
 *   a one-line placeholder naming restore_dropped_file
 */

/**
 * The model-facing text of a dropped file's snapshot: a line saying where it
 * came from, then the same `<file>`-wrapped, line-numbered form as an
 * `@`-mention or a `read`. The filename is only a label — there is no such path
 * on disk, and saying so stops the model reaching for it with a file tool.
 * Shared with restore_dropped_file so a restored file reads as it first did.
 * @param {DroppedFileData} data - The item's data
 * @returns {string} Formatted content ('' when the snapshot is empty)
 */
export function droppedFileText(data) {
  if (isStoredDrop(data)) return storedDropText(data);
  const content = data.content || '';
  if (!content) return '';
  const name = data.filename || markUntranslated('dropped file');
  const header = markUntranslated(`The user dropped the file "${name}" into the conversation. It is not on disk, so file tools cannot read it by that name.\n`);
  if (data.extracted) return header + content;
  const lineCount = content.split('\n').length;
  return header + formatFileContentForLLM({
    content,
    path: name,
    lineOffset: 1,
    lineCount,
    totalLines: lineCount
  });
}

/**
 * Whether a dropped file's data is a stored drop rather than inline text.
 * @param {DroppedFileData} data - The item's data
 * @returns {boolean} True when it names a path in the project.
 */
function isStoredDrop(data) {
  return typeof data.absPath === 'string' && data.absPath !== '' && !data.content;
}

/**
 * A byte count as the model reads it: English, one decimal place.
 * @param {number} bytes
 * @returns {string} e.g. "12.3 MB"
 */
function modelSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/**
 * The model-facing text of a stored drop: where it is, how to read it, and
 * what the upload saw of it, so the model can choose how to read it without
 * reading it whole. The path is absolute, since a worktree conversation's
 * shell does not run in the project root.
 * @param {DroppedFileData} data - The item's data
 * @returns {string} The text
 */
function storedDropText(data) {
  const name = data.filename || 'dropped file';
  const lines = [
    `The user dropped the file "${name}" (${modelSize(data.bytes || 0)}) into the conversation. It was too large or not text, so it is not included here: it was saved on disk at ${data.absPath} — read it there with the file tools (read with an offset and limit, grep, or the shell), taking only the parts you need.`
  ];
  const p = data.preview;
  if (p?.text) {
    lines.push(`It is text, ${(p.lines || 0).toLocaleString('en-US')} lines. Its first lines:`);
    if (p.head) lines.push(p.head.replace(/\n$/, ''));
  } else if (p?.entryCount) {
    const listed = p.entries || [];
    const rest = p.entryCount > listed.length ? ` (the first ${listed.length} shown)` : '';
    lines.push(`It is a zip archive of ${p.entryCount.toLocaleString('en-US')} entries${rest}:`, ...listed.map((e) => `- ${e}`));
  } else if (p?.mime) {
    lines.push(`Its content type is ${p.mime}.`);
  }
  return markUntranslated(lines.join('\n'));
}

// ============================================================================
// DroppedFileContextItem
// ============================================================================

/**
 * DroppedFileContextItem - inline snapshot of a text file dropped into the
 * composer.
 *
 * SEMANTICS (contrast with {@link FileContentContextItem}):
 *  - A browser file drop delivers the file's BYTES, never a filesystem path
 *    (WebKit does not populate a usable `File.path`, and a path would be
 *    meaningless for a remote viewer whose file lives on a different machine).
 *    So unlike a path-pin, there is nothing on disk to re-read: the captured
 *    `content` IS the source of truth and is persisted in Yjs verbatim.
 *  - The snapshot is FROZEN — it never re-reads and has no refresh affordance,
 *    matching what the user dropped at that moment.
 *  - Created only via the composer's drop handler
 *    (`executeContextItem('dropped-file', {filename, content})`); it is not
 *    user-addable through the picker and exposes no tool for the LLM.
 *  - Because nothing else holds the bytes, drop_context_items hides it rather
 *    than deleting it (`data.hidden`), and restore_dropped_file
 *    (restore-dropped-file-context-item.js) hands the content back.
 *  - A file too large or too binary to inline is uploaded by the composer to
 *    the project's `.juggler-drops/` first, and the item holds its path
 *    instead (`absPath`, with `content` empty): the model is told where it is
 *    and reads it with its file tools. Hidden, it still names that path.
 * @class
 * @augments ContextItem
 */
class DroppedFileContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'dropped-file',
    name: 'Dropped file',
    version: '1.0.0',
    description: 'File dropped into the composer (inline text snapshot, or a path in the project)',
    author: 'Juggler Team',
    idPrefix: 'DROP',
    userAddable: false,
    watchesFileChanges: false,
    // 'prefix': the drop is a frozen byte snapshot (never re-read), rendered
    // where it stands in the conversation, so it joins the cached prefix once
    // sent instead of being re-billed every turn.
    contextPosition: /** @type {const} */ ('prefix'),
    exampleData: {
      filename: 'notes.txt',
      content: 'hello world\n'
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-document' };
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // The snapshot lives entirely in `data`: filename + captured bytes.
    /** @type {DroppedFileData} */
    const defaults = { filename: '', content: '' };
    this.data = { ...defaults, ...this.data };
  }

  /**
   * Record the dropped file's snapshot. No disk access — the content arrives
   * inline from the drop handler and is stored as-is.
   * @param {string} _toolName - Unused (no LLM-facing tool)
   * @param {Record<string, any>} params - `{filename, content}`
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (typeof params.content !== 'string' && typeof params.absPath === 'string' && params.absPath) {
      // A stored drop: the upload already put the bytes in the project.
      this.data.content = '';
      this.data.path = typeof params.path === 'string' ? params.path : params.absPath;
      this.data.absPath = params.absPath;
      this.data.bytes = typeof params.bytes === 'number' ? params.bytes : 0;
      if (typeof params.sha256 === 'string') this.data.sha256 = params.sha256;
      if (params.preview && typeof params.preview === 'object') this.data.preview = params.preview;
      this.data.filename = typeof params.filename === 'string' && params.filename
        ? params.filename
        : markUntranslated('dropped file');
      return;
    }
    if (typeof params.content !== 'string') {
      // The thrown error is the item's outcome error, which stays English.
      throw new Error(markUntranslated('Missing required parameter: content'));
    }
    this.data.content = params.content;
    if (params.extracted === true) this.data.extracted = true;
    this.data.filename = typeof params.filename === 'string' && params.filename
      ? params.filename
      // Stored with the snapshot and used as the model's `<file>` label: data.
      : markUntranslated('dropped file');
  }

  /**
   * Status UI configuration. Sync — just the filename.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status UI config
   */
  getStatusUI() {
    const name = this.data.filename || t('Dropped file');
    return { typeName: t('Dropped file'), summary: name, status: 'success' };
  }

  /** @returns {string} Item title */
  getTitle() {
    return this.data.filename || t('Dropped file');
  }

  /** @returns {string} Brief summary for transaction display */
  getBriefSummary() {
    return this.data.filename ? t('Dropped file: {filename}', { filename: this.data.filename }) : t('Dropped file');
  }

  /**
   * Create context text for the LLM: the snapshot via {@link droppedFileText},
   * or, once drop_context_items has hidden the item, a one-line placeholder
   * that keeps the file findable. Extracted content (a dropped PDF) is already
   * in `<file>` form, as the viewer that read it produced it for an
   * `@`-mention too, so it goes through unwrapped.
   * @returns {Promise<string>} Formatted file content for LLM context
   */
  async createContextText() {
    if (isStoredDrop(this.data)) {
      if (!this.data.hidden) return storedDropText(this.data);
      const name = this.data.filename || markUntranslated('dropped file');
      return markUntranslated(`The dropped file "${name}" was removed from context. It is still on disk at ${this.data.absPath}.`);
    }
    if (!this.data.content) return '';
    if (this.data.hidden) {
      const name = this.data.filename || markUntranslated('dropped file');
      return markUntranslated(`The dropped file "${name}" was removed from context. It is not on disk; call restore_dropped_file with itemId "${this.id}" to see it again.`);
    }
    return droppedFileText(this.data);
  }

  /**
   * Properties panel: filename header plus the frozen snapshot content.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'file-content-expanded');

    if (this.id) {
      container.dataset.contextItemId = this.id;
    }

    // A stored drop: its path, and the first lines the upload saw, when it
    // is text. The whole file is in the project, for the file tree to open.
    if (isStoredDrop(this.data)) {
      addFilePath(container, this.data.path || this.data.absPath || '');
      const head = this.data.preview?.text ? this.data.preview.head || '' : '';
      if (head) {
        const view = /** @type {any} */ (createFileView());
        view.setSource(fileSourceFromText({ path: this.data.filename || t('Dropped file'), text: head }));
        container.appendChild(view);
      }
      return container;
    }

    const content = this.data.content || '';
    if (!content) {
      addFilePath(container, this.data.filename || t('Dropped file'));
      container.appendChild(createElement('div', 'file-content-loading', t('(empty)')));
      return container;
    }

    // A dropped file is never server-backed — there is no path on disk and no
    // server-detected language — so the source carries the text the drop
    // captured. Text extracted from a binary file is marked so, which keeps the
    // viewer for the file's own type from being handed it.
    const view = /** @type {any} */ (createFileView());
    view.setSource(fileSourceFromText({
      path: this.data.filename || t('Dropped file'),
      text: content,
      extracted: !!this.data.extracted,
    }));
    container.appendChild(view);
    return container;
  }
}

export default DroppedFileContextItem;
