//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Context Item Display Utilities
 *
 * Common utilities for formatting and displaying context item content.
 * Shared across all context item types.
 */

import { createCopyButton } from './copy-button.js';
import { renderMarkdown, decorateCodeBlocks } from './markdown.js';
import { highlightCode } from './syntax-highlight.js';
import { renderLineNumberedCode } from './code-lines.js';
import { injectStylesOnce } from './inject-styles.js';

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB")
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes === null || bytes === undefined) return '—';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);

  if (i === 0) {
    return `${bytes} B`;
  }

  return `${size.toFixed(1)} ${units[i]}`;
}

/**
 * Format path for display with "./" prefix for relative paths
 * App-wide policy: relative paths get "./" prefix, absolute paths shown as-is
 * @param {string} path - File path
 * @returns {string} Formatted path for display
 */
export function formatDisplayPath(path) {
  if (!path) return '';
  // Absolute paths (start with /) are shown as-is
  if (path.startsWith('/')) return path;
  // Paths already starting with ./ are shown as-is
  if (path.startsWith('./')) return path;
  // Windows absolute paths are shown as-is: a drive-letter path (`C:\…` or
  // `C:/…`) or a UNC path (`\\server\share`). Without this they'd get a `./`
  // prefix and render as `./C:\build.bat` — reading as project-relative exactly
  // when the user most needs to see it isn't.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path;
  // Relative paths get ./ prefix
  return `./${path}`;
}

/**
 * Format a filesystem path for a compact status summary: strip the project-root
 * prefix to a relative path, then truncate very long paths from the START so the
 * meaningful tail (the filename) survives, with a leading ellipsis cut at a clean
 * path separator.
 * @param {string} path - The raw path
 * @param {string} [projectPath] - Project root prefix to strip
 * @param {number} [maxLen=40] - Max length before truncation kicks in
 * @returns {string} Formatted path for display
 */
export function formatPathForStatus(path, projectPath, maxLen = 40) {
  let p = path;

  // Strip project root to get a relative path. Strip either separator so a
  // native Windows project path leaves no leading `\`.
  if (projectPath && p.startsWith(projectPath)) {
    p = p.slice(projectPath.length).replace(/^[/\\]+/, '');
  }

  // Truncate long paths from the start, preserving the tail
  if (p.length > maxLen) {
    // Find a path separator near the truncation point to cut cleanly (either
    // `/` or a Windows `\`).
    const tail = p.slice(p.length - maxLen);
    const sepIdx = tail.search(/[/\\]/);
    p = '\u2026/' + (sepIdx >= 0 ? tail.slice(sepIdx + 1) : tail);
  }

  return p;
}

/**
 * Return the final segment (filename or folder name) of a path for display.
 * Handles both POSIX (`/`) and Windows (`\`) separators — the backend reports
 * native OS paths, so titles must strip either — and trims trailing separators
 * so a directory path yields its own name rather than an empty string.
 * @param {string} path - File or directory path
 * @returns {string} Last path segment, or '' if the path is empty
 */
export function basename(path) {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * How many lines a quote carries before the rest is elided. A quote is a
 * reminder of which code is meant, not a copy of it: the range printed above it
 * is the precise part, and the reader it is sent to can open the file.
 */
const QUOTE_MAX_LINES = 3;

/** Column at which a quoted line is cut. */
const QUOTE_MAX_COLUMNS = 120;

/**
 * Write one reference to code, as a block of text for a reader.
 *
 * This is the app's one way of saying "this code, here" to the agent, and it is
 * deliberately the convention the default system prompt already asks for in the
 * other direction — `file_path:line_number`. Review comments and a selection
 * quoted out of a file both come through here, so the agent meets one format
 * rather than two.
 *
 * The block is a header naming the file and lines, the quoted source beneath it,
 * and then whatever the reader has to say:
 *
 * ```text
 * ./web/js/app.js:60-62 (new)
 * > const hunks = computeDiff(a, b);
 * > render(hunks);
 * Split this into two methods.
 * ```
 *
 * Nothing in it is hidden and nothing is parsed back: it is text, and the person
 * sending it may edit it first. With no `body` the block ends in a newline, so a
 * caret placed after it lands on the empty line the format leaves for one.
 * @param {object} [reference] - The reference to write.
 * @param {string} [reference.path] - The file, project-relative unless `outOfRoot`.
 * @param {boolean} [reference.outOfRoot] - True to print the path as-is, for a file outside the project.
 * @param {number} [reference.startLine] - First line, 1-indexed; omit for a whole-file reference.
 * @param {number} [reference.endLine] - Last line, inclusive; omit or repeat `startLine` for one line.
 * @param {'old'|'new'} [reference.side] - Which side of a diff, where that disambiguates. Anything else is dropped.
 * @param {string[]} [reference.lines] - The source of the full span, quoted and bounded here.
 * @param {string} [reference.body] - The reader's words.
 * @returns {string} The reference block.
 */
export function formatCodeReference({
  path = '', outOfRoot = false, startLine, endLine, side, lines = [], body = '',
} = {}) {
  let header = outOfRoot ? path : formatDisplayPath(path);

  const start = Number(startLine);
  if (Number.isFinite(start) && start > 0) {
    const end = Number(endLine);
    const last = Number.isFinite(end) && end > start ? end : start;
    header += last > start ? `:${start}-${last}` : `:${start}`;
  }
  // Only where it tells the reader something. A context line whose old and new
  // numbers are equal has one truthful line number, and a marker there is noise.
  if (side === 'old' || side === 'new') header += ` (${side})`;

  return `${[header, ...quoteSource(lines)].join('\n')}\n${body || ''}`;
}

/**
 * The quoted-source lines of a reference block, bounded in both directions.
 * @param {string[]} lines - The full span's source.
 * @returns {string[]} Quote lines, each already carrying its `>` marker.
 * @private
 */
function quoteSource(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const shown = source.length > QUOTE_MAX_LINES ? source.slice(0, QUOTE_MAX_LINES - 1) : source;
  const quoted = shown.map(quoteSourceLine);
  if (shown.length < source.length) quoted.push('> …');
  return quoted;
}

/**
 * Quote one line of source: verbatim, trailing whitespace gone, cut at a column
 * bound. A line that already begins with `>` simply gains another, and a blank
 * one is a bare marker rather than a marker and a space.
 * @param {string} line - The source line.
 * @returns {string} The quote line.
 * @private
 */
function quoteSourceLine(line) {
  let text = String(line ?? '').replace(/\s+$/, '');
  if (text.length > QUOTE_MAX_COLUMNS) {
    text = `${text.slice(0, QUOTE_MAX_COLUMNS).replace(/\s+$/, '')}…`;
  }
  return text === '' ? '>' : `> ${text}`;
}

/**
 * Create an empty state element
 * @param {string} message - Empty state message
 * @param {string} [icon=''] - Optional icon
 * @returns {HTMLElement} Empty state element
 */
export function createEmptyState(message, icon = '') {
  const container = document.createElement('div');
  container.className = 'context-item-empty';

  if (icon) {
    const iconDiv = document.createElement('div');
    iconDiv.className = 'context-item-empty-icon';
    iconDiv.textContent = icon;
    container.appendChild(iconDiv);
  }

  const messageDiv = document.createElement('div');
  messageDiv.textContent = message;
  container.appendChild(messageDiv);

  return container;
}

/**
 * @typedef {object} FileContentParams
 * @property {string} content - File content
 * @property {string} path - File path
 * @property {number} [lineOffset=1] - Starting line number (1-indexed)
 * @property {number} [lineCount] - Number of lines the reader believes it holds. Ignored: the footer is computed from the lines this block actually renders, which is the only count the model can act on.
 * @property {number} [totalLines] - Total lines in file
 * @property {string} [readMode] - Human-readable read mode (e.g., "First 50 lines", "Lines 10-20")
 * @property {number} [maxChars] - Character budget for the whole block. Lines past it are left for the next read rather than cut out of this one.
 */

/**
 * How many of these lines fit `maxChars` once the tag, the closer and the
 * footer are paid for. Always at least one line: a read that returns nothing
 * teaches the model only that the file is unreadable.
 * @param {string[]} lines - The block's lines
 * @param {{path: string, lineOffset: number, numWidth: number, effectiveTotal: number, maxChars?: number}} opts - Rendering context
 * @returns {number} Number of leading lines to render
 */
function linesWithinBudget(lines, opts) {
  const { path, lineOffset, numWidth, effectiveTotal, maxChars } = opts;
  if (!maxChars || maxChars <= 0) return lines.length;

  // Reserve the longest footer this block could end up carrying, so choosing
  // fewer lines can never make the result overflow.
  const lastPossible = lineOffset + lines.length - 1;
  const footer = `(Showing lines ${lineOffset}-${lastPossible} of ${effectiveTotal}. Use offset=${lastPossible + 1} to read more.)`;
  let used = `<file path="${path}">\n`.length + '\n</file>\n'.length + footer.length;

  for (let i = 0; i < lines.length; i++) {
    // Number, tab, the line itself, newline.
    const cost = numWidth + 1 + String(lines[i]).length + 1;
    if (used + cost > maxChars && i > 0) return i;
    used += cost;
  }
  return lines.length;
}

/**
 * Format file content for LLM context with line numbers and XML wrapper.
 *
 * The block and its footer are decided together: whatever bounds the content —
 * the caller's line range or `maxChars` — the footer names the run that is
 * actually present and where to resume. A reader that follows it sees every
 * line of the file exactly once.
 * @param {FileContentParams} params - File content parameters
 * @returns {string} Formatted file content with line numbers and XML wrapper
 */
export function formatFileContentForLLM(params) {
  const { content, path, lineOffset = 1, totalLines, maxChars } = params;

  // Empty file warning
  if (!content || content.trim() === '') {
    return `<system-reminder>WARNING: File ${path} exists but is empty. Do not attempt to read it again.</system-reminder>`;
  }

  // Add line numbers with cat -n style format (variable-width, right-aligned, tab separator)
  const lines = content.split('\n');
  const maxLineNum = lineOffset + lines.length - 1;
  const numWidth = String(maxLineNum).length;

  // The file's length as this block can attest to it. A trailing newline renders
  // one line more than the backend counted, and a footer must never claim fewer
  // lines than it has just printed.
  const effectiveTotal = Math.max(Number(totalLines) || 0, maxLineNum);

  const kept = linesWithinBudget(lines, { path, lineOffset, numWidth, effectiveTotal, maxChars });
  const deliveredEnd = lineOffset + kept - 1;

  const contentWithLineNumbers = lines.slice(0, kept).map((line, idx) => {
    const lineNum = lineOffset + idx;
    const paddedNum = String(lineNum).padStart(numWidth, ' ');
    return `${paddedNum}\t${line}`;
  }).join('\n');

  // Build simple XML tag with just path attribute
  const fileTag = `<file path="${path}">\n${contentWithLineNumbers}\n</file>`;

  // Something is still unread - say what arrived and where to pick it up
  if (deliveredEnd < effectiveTotal) {
    return fileTag + '\n' +
      `(Showing lines ${lineOffset}-${deliveredEnd} of ${effectiveTotal}. Use offset=${deliveredEnd + 1} to read more.)`;
  }

  // Full file or single chunk - show total
  if (totalLines) {
    return fileTag + '\n' + `(${effectiveTotal} lines total)`;
  }

  return fileTag;
}

/**
 * One piece of a parsed `<file>` block: a run of consecutively numbered lines,
 * or the prose between and after them (a truncation gap, a footer).
 * @typedef {{kind: 'lines', lineOffset: number, content: string} | {kind: 'note', text: string}} FileContentPart
 */

/**
 * Read a {@link formatFileContentForLLM} block back into the text it was made
 * from — its inverse, kept beside it so the two cannot drift.
 *
 * The block may since have been cut by a line-based truncation (a head/tail
 * split with a marker in the middle, a note appended), so the numbered lines come
 * back as runs: a new run starts wherever the numbering breaks, and anything that
 * is not a numbered line becomes a note in its place. Line numbers are
 * recognisable because every body line carries one, so a file line that itself
 * reads `</file>` or `12\tfoo` arrives prefixed and is not mistaken for structure.
 * @param {string} text - A formatted block, possibly truncated
 * @returns {{path: string, parts: FileContentPart[]} | null} The path and parts,
 *   or null when the text is not a file block with at least one numbered line.
 */
export function parseFileContentForLLM(text) {
  const lines = String(text || '').split('\n');
  const open = /^<file path="(.*)">$/.exec(lines[0] || '');
  if (!open) return null;

  /** @type {FileContentPart[]} */
  const parts = [];
  /** @type {{lineOffset: number, next: number, lines: string[]} | null} */
  let run = null;
  /** @type {string[]} */
  let note = [];
  let inBody = true;

  const flushRun = () => {
    if (run) parts.push({ kind: 'lines', lineOffset: run.lineOffset, content: run.lines.join('\n') });
    run = null;
  };
  const flushNote = () => {
    const joined = note.join('\n').trim();
    if (joined) parts.push({ kind: 'note', text: joined });
    note = [];
  };

  for (let i = 1; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    if (inBody && line === '</file>') {
      inBody = false;
      continue;
    }
    const numbered = inBody ? /^ *(\d+)\t([\s\S]*)$/.exec(line) : null;
    if (!numbered) {
      flushRun();
      note.push(line);
      continue;
    }
    const n = Number(numbered[1]);
    if (!run || n !== run.next) {
      flushRun();
      flushNote();
      run = { lineOffset: n, next: n, lines: [] };
    }
    run.lines.push(/** @type {string} */ (numbered[2]));
    run.next = n + 1;
  }
  flushRun();
  flushNote();

  if (!parts.some(p => p.kind === 'lines')) return null;
  return { path: /** @type {string} */ (open[1]), parts };
}

/**
 * Create a text block element for rendering markdown content.
 *
 * Carries the standard hover-reveal copy button, which yields the markdown
 * source rather than the rendered text — what the block shows is text someone
 * will want to take elsewhere (a plan, a system prompt, a `.md` file), and the
 * source is the form that survives the trip.
 * @param {string} content - Markdown content to render
 * @returns {HTMLElement} Text block element with rendered markdown
 */
export function createTextBlock(content) {
  const textBlock = document.createElement('div');
  textBlock.className = 'ci-text-block properties-panel-copyable';

  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';
  copyHeader.appendChild(createCopyButton(() => content || ''));
  textBlock.appendChild(copyHeader);

  const markdownDiv = document.createElement('div');
  markdownDiv.className = 'markdown';
  markdownDiv.innerHTML = renderMarkdown(content || '');
  decorateCodeBlocks(markdownDiv);

  textBlock.appendChild(markdownDiv);
  return textBlock;
}

/**
 * @typedef {object} CodeBlockOptions
 * @property {string|Node} content - Code content (string or DOM node)
 * @property {string} [language='text'] - Language for syntax highlighting
 * @property {number} [lineNumberStart] - Starting line number (enables line numbers)
 * @property {boolean} [bordered=false] - Wrap in bordered container
 * @property {boolean} [header=false] - Show language/range header (implies bordered)
 * @property {string} [range] - Range label for header (e.g. "Lines 10-50")
 */

/**
 * Create a code block element with proper structure for scrolling.
 *
 * A line-numbered block long enough to be windowed carries a `destroy` method,
 * which a caller with a teardown seam should call when it drops the element.
 * @param {CodeBlockOptions} options - Code block configuration
 * @returns {HTMLElement} Code block element with nested structure
 */
export function createCodeBlock(options) {
  const opts = options;
  const content = opts.content;
  const language = opts.language || 'text';
  const lineNumberStart = opts.lineNumberStart;
  const bordered = opts.header || opts.bordered || false;

  const codeBlock = document.createElement('div');
  codeBlock.className = bordered ? 'ci-code-block' : 'ci-code-block ci-code-block-borderless';

  // Optional header (language badge + range)
  if (opts.header) {
    const headerDiv = document.createElement('div');
    headerDiv.className = 'ci-code-header';

    const langSpan = document.createElement('span');
    langSpan.className = 'ci-code-language';
    langSpan.textContent = language;
    headerDiv.appendChild(langSpan);

    if (opts.range) {
      const rangeSpan = document.createElement('span');
      rangeSpan.className = 'ci-code-range';
      rangeSpan.textContent = opts.range;
      headerDiv.appendChild(rangeSpan);
    }

    codeBlock.appendChild(headerDiv);
  }

  const codeContent = document.createElement('div');
  codeContent.className = 'ci-code-content';

  const pre = document.createElement('pre');
  const code = document.createElement('code');

  // Determine if we're dealing with a Node or string content
  const isNode = typeof content === 'object' && content !== null && 'nodeType' in content;
  const isNumbered = lineNumberStart !== undefined && lineNumberStart !== null;

  // If content is a DOM node (HTMLElement or DocumentFragment), append it directly to code
  if (isNode) {
    // Still set pre className for consistent styling (font-size, etc.)
    pre.className = language ? `language-${language}` : '';
    code.appendChild(content);
  } else {
    // Otherwise, treat as code text with a language class and syntax-highlight
    // through the shared engine. `highlightCode` degrades to escaped plain text
    // when the grammar isn't bundled, so an unknown/`text` language renders as
    // plain text. A line-numbered block highlights per line below, so
    // skip the throwaway full-block highlight here.
    pre.className = `language-${language}`;
    code.className = `language-${language}`;
    if (isNumbered) code.textContent = content || '';
    else code.innerHTML = highlightCode(content || '', language);
  }

  pre.appendChild(code);
  codeContent.appendChild(pre);

  // Add line numbers if lineNumberStart is provided
  if (isNumbered) {
    // Get text content regardless of whether content is a Node or string
    const text = isNode ? (content.textContent || '') : (content || '');
    const lines = text.split('\n');

    // Replace pre>code with one block per line inside code. A long file is
    // rendered a window at a time; `destroy` unsubscribes it, for callers that
    // have a teardown seam to hang it on.
    const destroy = renderLineNumberedCode(code, lines, language, lineNumberStart);
    if (destroy) /** @type {any} */ (codeBlock).destroy = destroy;
  }

  codeBlock.appendChild(codeContent);

  return codeBlock;
}

/**
 * Render pinned/tool file content for the properties panel: markdown files go
 * through the standard markdown formatter ({@link createTextBlock}); everything
 * else through the syntax-highlighted {@link createCodeBlock}. Single source of
 * truth for the read/write/dropped/pinned file items so the markdown special
 * case stays consistent across all of them.
 * @param {object} [options]
 * @param {string} [options.content] - File body
 * @param {string} [options.language='text'] - Detected language identifier
 * @param {number} [options.lineNumberStart] - First line number (code blocks only)
 * @returns {HTMLElement} A text block for markdown, else a code block
 */
export function createFileContentBlock({ content = '', language = 'text', lineNumberStart } = {}) {
  if (language === 'markdown') {
    return createTextBlock(content || '');
  }
  return createCodeBlock({ content: content || '', language, lineNumberStart });
}

/**
 * Normalize the file_path → path alias that LLMs sometimes emit.
 * Mutates params in place and returns it for convenience.
 * @param {Record<string, any>} params
 * @returns {Record<string, any>} The same params object with path normalised
 */
export function normalizeFilePath(params) {
  if (params.file_path && !params.path) {
    params.path = params.file_path;
  }
  return params;
}

/**
 * Inject shared .file-content-* CSS into the document once.
 * Safe to call from multiple modules — guarded by style ID.
 */
export function injectFileContentStyles() {
  injectStylesOnce('file-content-ci-styles', `
.file-content-collapsed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 0.25rem;
  padding: 0.625rem;
  height: 100%;
}
.file-content-filename {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}
.file-content-meta {
  font-size: 0.625rem;
  font-family: var(--font-mono, 'Courier New', monospace);
  opacity: 0.7;
}
.file-content-expanded {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.file-content-warning {
  padding: 0.5rem;
  font-size: 0.75rem;
  background: rgb(from var(--accent-yellow) r g b / 15%);
  border: 1px solid var(--accent-yellow);
  border-radius: 0.25rem;
  color: var(--accent-yellow);
}
.file-content-not-found {
  padding: 0.5rem;
  font-size: 0.75rem;
  background: rgb(from var(--accent-red) r g b / 15%);
  border: 1px solid var(--accent-red);
  border-radius: 0.25rem;
  color: var(--accent-red);
}
`);
}
