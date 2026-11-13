//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatFileContentForLLM, injectFileContentStyles } from 'juggler/item-utils';
import { fileSourceFromText } from 'juggler/file-source';
import { createElement, addFilePath } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

injectFileContentStyles();

/**
 * Persisted Yjs shape for a dropped text file.
 * @typedef {object} DroppedFileData
 * @property {string} filename - Display name captured from the drop (File.name)
 * @property {string} content - Full text captured at drop time (the snapshot)
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
 * @class
 * @augments ContextItem
 */
class DroppedFileContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'dropped-file',
    name: 'Dropped file',
    version: '1.0.0',
    description: 'Text file dropped into the composer (inline content snapshot)',
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
    const view = /** @type {any} */ (document.createElement('file-view'));
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
