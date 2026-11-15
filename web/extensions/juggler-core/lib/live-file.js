//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a path off disk and showing it, for the surfaces that mean "this file,
 * as it is now" rather than "these bytes, as they were then".
 *
 * Two of those exist: the pinned file-content context item, whose panel and
 * every prompt it rides in resolve live, and the File pin on the pinboard. They
 * agree on what a live file is — the same directory probe, the same
 * `userInitiated` escape hatch, the same viewer for whatever is on disk — so they
 * share the reading and the rendering here. They share nothing else: a pin on the
 * board is not a context item, has no Yjs behind it, and is visible to nobody but
 * the person looking at it.
 * @module lib/live-file
 */

import { readFile, getTree } from 'juggler/ops';
import { formatFileSizeForDisplay, injectFileContentStyles } from 'juggler/item-utils';
import { fileSourceFromReadResult } from 'juggler/file-source';
import { createElement } from 'juggler/ui';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

injectFileContentStyles();

/**
 * What one live read found. Transient by construction: it is what disk said at
 * the moment it was asked, and it is never written to durable state anywhere.
 * @typedef {object} LiveFileResult
 * @property {string} path - Resolved (possibly absolute) path
 * @property {boolean} isDirectory - True if the path is a directory listing
 * @property {boolean} exists - False if the file/dir could not be read
 * @property {string} [error] - Why it could not be read, when the reason was
 *   anything other than nothing being there: a refused path, an unreadable file.
 *   Absent for a plain missing path.
 * @property {string} content - File body or rendered tree listing
 * @property {string} [language] - Detected language identifier for syntax highlight
 * @property {number} [size] - File size in bytes (files only)
 * @property {number} [totalLines] - Line count for files, entry count for dirs
 * @property {number} [lineOffset] - First line number of `content` (1-indexed)
 * @property {number} [lineCount] - Number of lines actually included in `content`
 * @property {string|null} [warning] - Backend warning (e.g. binary file)
 * @property {string} [readMode] - Human-readable read-mode description
 * @property {string} [mime] - Mime type reported by the read op ('' when unknown)
 * @property {boolean} [isBinary] - True when the bytes are not text; the file's viewer decides what to do with them
 */

/**
 * Read a path as it stands. Always resolves to a usable {@link LiveFileResult} —
 * a failure collapses to `exists: false` rather than throwing, because every
 * caller here has somewhere to show "not found" and nowhere to show a stack.
 *
 * `userInitiated` says the user named this path themselves — in a picker, an
 * `@`-mention, or by pinning it — and it is what lets the path resolve WITHOUT
 * the working-directory containment check, for a relative `../…` as much as for
 * an absolute one. It is the caller's to assert and is off unless the caller
 * says so: a path the agent chose is held to the project, and a path outside it
 * fails as "path is outside the working directory".
 *
 * Only the read op takes a signal; `getTree` does not, so a caller that
 * can be torn down mid-read must check its own signal before using what comes
 * back rather than assuming this rejected.
 *
 * A relative path is resolved by whoever performs the read, so `ops` decides
 * WHICH tree this is a live view of. A context item passes its own scoped ops
 * and gets its conversation's workspace; a pin passes none and gets the project,
 * which is what a pin is — board furniture showing the project, not a view into
 * whatever conversation happens to be open.
 * @param {string} path - File or directory path. A trailing "/" means directory.
 * @param {{signal?: AbortSignal, noIgnore?: boolean, head?: number, whole?: boolean,
 *   userInitiated?: boolean, ops?: import('juggler/ops').BoundOps}} [options] - Abort
 *   signal for the file read, whether a directory listing ignores .gitignore, a line
 *   ceiling for a caller showing a preview rather than the whole file, whether the
 *   path came from a user gesture, `whole` for a caller that wants every line, and
 *   the scope to read in. With neither of the line options the read op's own
 *   default cap applies, which is generous but is still a cap.
 * @returns {Promise<LiveFileResult>} What disk said; `exists: false` on any failure.
 */
export async function fetchLiveFile(path, options = {}) {
  if (!path) {
    return { path: '', isDirectory: false, exists: false, content: '' };
  }
  const userInitiated = options.userInitiated === true;
  // Both reads go through one scope, so the read that finds a folder cannot
  // answer for a different tree than the listing that follows it.
  const ops = options.ops || { readFile, getTree };

  // Completion paths conventionally carry a trailing slash for directories, but a
  // user may type or paste a directory path without one. The file read is asked
  // to report a folder rather than refuse it, so a file costs one request — each
  // is a round trip over a remote link — and a folder only the listing besides.
  /** @type {import('../../../js/services/ops-api.js').ReadFileLoadResult|null} */
  let read = null;
  if (!path.endsWith('/')) {
    try {
      /** @type {import('../../../js/services/ops-api.js').ReadFileLoadParams} */
      const readParams = { path, userInitiated, reportDirectory: true };
      if (options.head && options.head > 0) readParams.head = options.head;
      else if (options.whole) readParams.maxLines = 0;
      read = await ops.readFile(readParams, options.signal);
    } catch (err) {
      console.error(`[LiveFile] Couldn't load ${path}:`, err);
      return { path, isDirectory: false, exists: false, content: '', error: errorText(err) };
    }
  }

  if (!read || read.isDirectory === true) {
    try {
      const treeParams = /** @type {Record<string, unknown>} */ (
        { path, depth: 2, maxTokens: 4000, userInitiated });
      if (options.noIgnore) treeParams.noIgnore = true;
      const r = await ops.getTree(treeParams);
      return {
        path,
        isDirectory: true,
        exists: true,
        content: r.content || '',
        totalLines: (r.fileCount || 0) + (r.dirCount || 0),
        size: 0,
        language: '',
        lineOffset: 1,
        lineCount: 0,
        warning: null,
      };
    } catch (err) {
      console.error(`[LiveFile] Couldn't list directory ${path}:`, err);
      return { path, isDirectory: true, exists: false, content: '', error: errorText(err) };
    }
  }

  const r = read;
  return {
    path: r.path || path,
    isDirectory: false,
    exists: r.exists !== false,
    content: r.content || '',
    language: r.language || languageFromPath(r.path || path),
    size: r.size || 0,
    totalLines: r.totalLines || 0,
    lineOffset: r.lineOffset || 1,
    lineCount: r.lineCount || 0,
    warning: r.warning || null,
    // Carried, not interpreted: a binary file has no `content`, and both the
    // viewer and the LLM-side extraction need these to hand the file to the
    // right reader rather than treating it as an empty text file.
    mime: r.mime || '',
    isBinary: r.isBinary === true,
  };
}

/**
 * The words a failed read gave, for showing beside the path.
 * @param {unknown} err - What the op threw.
 * @returns {string} Its message, never empty.
 */
function errorText(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.trim() || t('unknown error');
}

/**
 * Build the FileSource for a live result, for either realm's use of it: a viewer
 * renders it, the LLM-side extraction pulls text out of it.
 *
 * The source carries the read's provenance: a read the user initiated says so,
 * or the viewer's byte transport refuses a file the user named from the
 * Desktop, having just been shown its contents. Like {@link fetchLiveFile}, it
 * is off unless the caller says so.
 * @param {LiveFileResult} result - A live read.
 * @param {string} absolutePath - The path to attribute the bytes to.
 * @param {{conversationId?: string, userInitiated?: boolean}} [options] - Conversation
 *   the bytes are for, and whether a user gesture approved paths outside the project.
 * @returns {import('juggler/file-source').FileSource} The file, ready to render or extract.
 */
export function liveFileSource(result, absolutePath, options = {}) {
  return fileSourceFromReadResult(result, absolutePath || result.path || '', {
    conversationId: options.conversationId,
    access: options.userInitiated === true ? { userInitiated: true } : {},
  });
}

/**
 * The one-line annotation that goes beside a path: how big, how many lines, how
 * many entries. Empty when there is nothing worth saying.
 * @param {LiveFileResult} result - A live read.
 * @returns {string} The annotation, or '' for none.
 */
export function liveFileInfo(result) {
  if (!result.exists) return '';
  if (result.isDirectory) {
    return result.totalLines ? t('{count, plural, one {{count} item} other {{count} items}}', { count: result.totalLines }) : '';
  }
  if (!result.size) return '';
  return t('{size} | {count, plural, one {{count} line} other {{count} lines}}',
    { size: formatFileSizeForDisplay(result.size), count: result.totalLines || 0 });
}

/**
 * Render a live read into a container, replacing whatever was there: the missing
 * path, the directory listing, or the file handed to whichever viewer claims it.
 *
 * The path is not repeated here — every caller has already said which file this
 * is, above — so `<file-view>` renders content alone.
 * @param {HTMLElement} container - The region to fill.
 * @param {LiveFileResult} result - A live read.
 * @param {{absolutePath?: string, conversationId?: string, userInitiated?: boolean,
 *   codeRefPath?: string, codeRefAbsolute?: boolean}} [options] - The path to
 *   attribute the bytes to, the conversation they are for, its path provenance,
 *   and the spelling a reference to a selection should print.
 * @returns {void}
 */
export function renderLiveFileBody(container, result, options = {}) {
  const absolutePath = options.absolutePath || result.path || '';
  container.replaceChildren();

  if (!result.exists) {
    // Only a read that found nothing there is "not found". Anything else names
    // its reason, or the user goes looking for a file that is plainly on disk.
    container.appendChild(createElement('div', 'file-content-not-found', result.error
      ? t("Couldn't read {path}: {error}", { path: absolutePath, error: result.error })
      : t('File not found: {path}', { path: absolutePath })));
    return;
  }

  if (result.isDirectory) {
    container.appendChild(createElement('pre', 'file-content-tree', result.content || t('(empty)')));
    return;
  }

  const view = /** @type {any} */ (document.createElement('file-view'));
  view.showPath = false;
  if (options.codeRefPath) {
    view.codeRefPath = options.codeRefPath;
    view.codeRefAbsolute = !!options.codeRefAbsolute;
  }
  view.setSource(liveFileSource(result, absolutePath, options));
  container.appendChild(view);
}

/**
 * Guess a language identifier from a path's extension, for syntax highlighting
 * when the read op did not name one itself.
 * @param {string} path - File path.
 * @returns {string} Language identifier, or the bare extension when unmapped.
 */
function languageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  /** @type {Record<string, string>} */
  const langMap = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash'
  };
  return langMap[ext] || ext;
}
