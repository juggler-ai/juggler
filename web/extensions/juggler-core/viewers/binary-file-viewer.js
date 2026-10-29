//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import FileViewer from 'juggler/file-viewer';
// A viewer is handed a resolved file and has no conversation to scope by; it
// stats that path, with the access its source carries.
// eslint-disable-next-line no-restricted-imports
import { stat } from 'juggler/ops';
import { extensionOf } from 'juggler/file-source';
import { formatFileSizeForDisplay } from 'juggler/item-utils';
import { createElement, injectStylesOnce, formatRelativeDateTime } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

injectStylesOnce('binary-file-viewer-styles', `
.binary-file__note {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}

.binary-file__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.125rem 0.75rem;
  margin-top: 0.5rem;
  font-size: var(--font-size-sm);
}

.binary-file-fact {
  display: contents;
}

.binary-file-fact__label {
  color: var(--text-tertiary);
}

.binary-file-fact__value {
  color: var(--text-secondary);
  font-family: var(--font-mono, 'Courier New', monospace);
  word-break: break-all;
}
`);

/**
 * What to call a file whose bytes nothing here reads: the mime when the server
 * named one, else the extension, else the one thing we do know.
 * @param {import('juggler/file-source').FileSource} source - The file
 * @returns {string} A short description of the format
 */
function kindOf(source) {
  if (source.mime) return source.mime;
  const ext = extensionOf(source.path || source.absPath || '');
  if (ext) return t('.{ext} file', { ext });
  return source.isBinary ? t('Binary') : t('Unknown');
}

/**
 * When the file was last written, as disk says now rather than as the read that
 * produced this source said then. A size travels with a FileSource; an mtime
 * does not, so it costs a `stat` — cheap, local, and only for a file that has
 * nothing else to show.
 *
 * Failure is silent by design: the panel is worth drawing without this row, and
 * a path outside the project that no user gesture vouched for is *supposed* to
 * be refused here.
 * @param {import('juggler/file-source').FileSource} source - The file
 * @returns {Promise<number|null>} Unix ms, or null when disk would not say
 */
async function modifiedAt(source) {
  const path = source.absPath || source.path;
  if (!path) return null;
  try {
    const info = await stat({ path, userInitiated: source.access?.userInitiated === true });
    return info.exists && typeof info.modified === 'number' ? info.modified : null;
  } catch (err) {
    return null;
  }
}

/**
 * Add one label/value pair to the facts grid.
 * @param {HTMLElement} facts - The grid
 * @param {string} label - What the value is
 * @param {string} value - The value itself
 * @param {string} [title] - Longer form, for the hover
 * @returns {void}
 */
function addFact(facts, label, value, title) {
  const row = createElement('div', 'binary-file-fact');
  row.appendChild(createElement('span', 'binary-file-fact__label', label));
  const valueEl = createElement('span', 'binary-file-fact__value', value);
  if (title) valueEl.title = title;
  row.appendChild(valueEl);
  facts.appendChild(row);
}

/**
 * BinaryFileViewer — the viewer for files no viewer wants.
 *
 * It claims every file and wins none of them: `priority: -100` puts it below the
 * text viewer's fallback tier, so it is reached only once the text viewer has
 * vetoed the bytes as binary and no format-specific viewer has a claim — an
 * `.icns`, a `.o`, a zip, a PDF too large for the PDF viewer's `maxBytes`.
 *
 * What it renders is the small set of facts a panel can state about bytes it
 * cannot show: how big, what kind, when it last changed. That is worth more than
 * the bare "no viewer" line the host would otherwise draw, and the path row above
 * it already carries the open/reveal buttons that do the rest.
 *
 * `extract()` is the exception: the model gains nothing from a size, so what it
 * sees is what the host's own fallback says, unchanged.
 * @augments FileViewer
 */
class BinaryFileViewer extends FileViewer {
  /** @type {import('juggler/file-viewer').FileViewerManifest} */
  static MANIFEST = {
    id: 'binary',
    name: 'Binary',
    version: '1.0.0',
    description: 'Describes files nothing else can display: kind, size, last modified',
    matchAll: true,
    // Below the text viewer's fallback tier, so this viewer is the answer only
    // when there is no other answer at all.
    priority: -100,
  };

  /**
   * @param {import('juggler/file-source').FileSource} source - The file to describe
   * @param {HTMLElement} host - Element to render into
   * @returns {Promise<void>}
   */
  async render(source, host) {
    // Resolved before anything is appended so the block lands in one piece
    // rather than growing a row under the reader's eyes.
    const modified = await modifiedAt(source);

    host.appendChild(createElement('div', 'binary-file__note', t('No viewer for this file.')));

    const facts = createElement('div', 'binary-file__facts');
    addFact(facts, t('Kind'), kindOf(source));
    if (source.size) addFact(facts, t('Size'), formatFileSizeForDisplay(source.size));
    if (modified !== null) {
      const { short, full } = formatRelativeDateTime(modified);
      addFact(facts, t('Modified'), short, full);
    }
    host.appendChild(facts);
  }

  /**
   * @param {import('juggler/file-source').FileSource} source - The file
   * @returns {Promise<import('juggler/file-viewer').ExtractResult>} Why there is no text
   */
  async extract(source) {
    const kind = source.mime || (source.isBinary ? 'binary' : 'this');
    return { warning: markUntranslated(`No viewer is available for ${kind} content, so it cannot be read as text.`) };
  }
}

export default BinaryFileViewer;
