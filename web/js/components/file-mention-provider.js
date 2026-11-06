//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { fetchFileCompletions, fetchPathCompletions, fetchExistingPaths } from '../services/completions-api.js';
import { longestCommonPrefix } from './completion-menu.js';
import { markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * The `@` file-mention completion source for {@link CompletionMenu}, plus the
 * send-time path-extraction helpers ({@link extractFileMentions},
 * {@link extractFileMentionsAsync}) the composer uses to turn typed mentions
 * into file-content context items.
 * @module components/file-mention-provider
 */

/**
 * Decide whether an `@` at position `atIdx` in `textBefore` is a file-mention
 * trigger (vs. an `@` embedded in a string, email, decorator, stack trace, etc).
 *
 * Rule: the char immediately before the `@` must be start-of-text, ASCII
 * whitespace, or a newline. Everything else (letter, digit, quote, paren,
 * punctuation) means the user is typing `@` as part of some other token.
 * @param {string} textBefore - All text from start of textarea up to the cursor
 * @param {number} atIdx - Index of the `@` in `textBefore`
 * @returns {boolean} True if the `@` is a mention trigger
 */
function isMentionBoundary(textBefore, atIdx) {
  if (atIdx <= 0) return true;
  const prev = textBefore.charAt(atIdx - 1);
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r';
}

/**
 * Escape spaces in a path so it inserts as a single unquoted mention token.
 *
 * The mention is re-detected on every keystroke by the unquoted regex, whose
 * terminator is an UNescaped space. Emitting `my\ dir/` (rather than the
 * quoted `"my dir/`) means a later space the user types as prose falls outside
 * the token and dismisses the menu — a quoted token left unterminated would
 * instead swallow all following spaces and newlines.
 * @param {string} path
 * @returns {string} Path with spaces backslash-escaped
 */
function escapeMentionPath(path) {
  return path.replace(/ /g, '\\ ');
}

/**
 * Build the `@` file-mention completion provider for one composer.
 *
 * It lists the tree the composer's conversation works in, because a mention
 * becomes a file-content item that reads from exactly that tree: a menu listing
 * the project would offer files the read cannot find and hide the ones it can.
 * The id is read per fetch, so a tab that acquires its binding on first send,
 * or a composer that switches threads, is followed without rebuilding the menu.
 * @param {() => string} [getWorkspaceId] - The conversation's working workspace id, '' for the project
 * @returns {import('./completion-menu.js').CompletionProvider} The provider
 */
export function createFileMentionProvider(getWorkspaceId = () => '') {
  return {
    ...fileMentionProviderBase,
    async fetch(/** @type {string} */ query) {
      const workspaceId = getWorkspaceId() || '';
      // Absolute / home-relative paths bypass the tree-restricted completer —
      // otherwise typing "~" or "/" produces zero results and the dropdown
      // collapses mid-keystroke.
      const isAbsolute = query.startsWith('/') || query.startsWith('~');
      return isAbsolute
        ? (await fetchPathCompletions(query, workspaceId)) ?? []
        : await fetchFileCompletions(query, workspaceId);
    },
  };
}

/**
 * Everything about the `@` provider except where it looks.
 * @type {Omit<import('./completion-menu.js').CompletionProvider, 'fetch'>}
 */
const fileMentionProviderBase = {
  id: 'file-mention',
  emptyLabel: markForTranslation('No matches'),

  detect(textBefore) {
    // Quoted path: @"..." — handles spaces.
    let match = textBefore.match(/@"([^"]*)$/);
    if (match && isMentionBoundary(textBefore, /** @type {number} */ (match.index))) {
      return {
        anchorPos: /** @type {number} */ (match.index),
        query: /** @type {string} */ (match[1]),
        meta: { quoted: true },
      };
    }

    // Unquoted path: backslash-space sequences are treated as literal spaces.
    match = textBefore.match(/@((?:\\ |[^\s@])*)$/);
    if (match && isMentionBoundary(textBefore, /** @type {number} */ (match.index))) {
      return {
        anchorPos: /** @type {number} */ (match.index),
        query: /** @type {string} */ (match[1]).replace(/\\ /g, ' '),
        meta: { quoted: false },
      };
    }

    return null;
  },

  renderItem(path) {
    const li = document.createElement('li');
    li.className = 'menu-item' + (path.endsWith('/') ? ' dir' : '');
    li.dataset.path = path;

    const icon = document.createElement('span');
    icon.className = path.endsWith('/') ? 'menu-item-icon icon-folder' : 'menu-item-icon icon-file';
    li.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'menu-item-path';
    label.textContent = path;
    li.appendChild(label);

    return li;
  },

  insert(path) {
    return '@' + escapeMentionPath(path);
  },

  reopenAfterAccept(path) {
    return path.endsWith('/');
  },

  expandForward(path) {
    return path.endsWith('/');
  },

  closeOnBareEnter(_meta, query) {
    return query?.endsWith('/') ?? false;
  },

  tabCompleteReplacement(items, query) {
    const lcp = longestCommonPrefix(items);
    return lcp.length > query.length ? '@' + escapeMentionPath(lcp) : null;
  },

  navigateParent(query) {
    let q = query || '';
    if (q.endsWith('/')) q = q.slice(0, -1);
    const lastSlash = q.lastIndexOf('/');
    if (lastSlash < 0) return null;
    const parent = q.slice(0, lastSlash + 1);
    return '@' + escapeMentionPath(parent);
  },
};

/** A fence opener or closer: up to three spaces, then a run of ``` or ~~~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blank out Markdown code — fenced blocks and inline code spans — so the
 * mention scan never sees an `@` that is quoted rather than meant. Follows
 * CommonMark where it matters here: a fence closes on a line of at least as
 * many of the same character and nothing else, an unclosed fence runs to the
 * end of the text, and a span opened by N backticks closes on a run of exactly
 * N. Code is replaced by a space, so the text on either side stays apart.
 * @param {string} text
 * @returns {string} The text with every code region replaced by a space
 */
function stripCode(text) {
  /** @type {string|null} */
  let fence = null;
  const prose = text.split('\n').map((line) => {
    const m = FENCE_RE.exec(line);
    const run = m?.[1] ?? '';
    if (fence === null) {
      if (m) fence = run;
      return m ? ' ' : line;
    }
    if (m && run[0] === fence[0] && run.length >= fence.length && line.slice(m[0].length).trim() === '') {
      fence = null;
    }
    return ' ';
  }).join('\n');
  return prose.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

/**
 * Extract all file-mention paths from a message string.
 *
 * Gates that filter out stray `@`s (pasted plans, crash dumps, email
 * addresses, decorators, scoped npm packages, …):
 *
 *  1. **Code** — an `@` inside a code span or fenced block is quoted text,
 *     never a mention.
 *  2. **Boundary** — the `@` must be at start-of-text or directly after
 *     whitespace. `"foo"@bar`, `email@host`, `a@b` are skipped.
 *  3. **Existence** — the path must exist in the tree it will be read from.
 *     That check is async, so callers use {@link extractFileMentionsAsync}
 *     to apply it.
 * @param {string} text
 * @returns {string[]} Unique candidate paths in order of first appearance
 */
function extractFileMentions(text) {
  const seen = new Set();
  const paths = [];
  text = stripCode(text);

  // Boundary char preceding `@` must be start-of-text or whitespace.
  // We use lookbehind to keep the match.index aligned with the `@`.
  const quotedRe = /(?:^|(?<=\s))@"([^"]+)"/g;
  let m;
  while ((m = quotedRe.exec(text)) !== null) {
    const p = m[1];
    if (p && !seen.has(p)) { seen.add(p); paths.push(p); }
  }

  const unquotedRe = /(?:^|(?<=\s))@((?:\\ |[^\s@"])+)/g;
  while ((m = unquotedRe.exec(text)) !== null) {
    const p = /** @type {string} */ (m[1]).replace(/\\ /g, ' ').replace(/[.,;:!?)\]]+$/, '');
    if (p && !seen.has(p)) { seen.add(p); paths.push(p); }
  }

  return paths;
}

/**
 * Like {@link extractFileMentions} but additionally drops candidates that do
 * not exist on disk. This is the form the send pipeline should use. A mention
 * is frozen at send, so one naming a missing path could only ever hand the
 * model "File does not exist" — and a slash is no evidence of a path:
 * `@scope/package` has one too.
 *
 * "On disk" means in the tree the mentions will be read from, so callers pass
 * the conversation's working workspace — the one its file-content items resolve
 * against. When that tree cannot be asked, a candidate with a `/` is kept (the
 * likelier reading) and a bare word (`@TODO`, `@param`) is dropped.
 * @param {string} text
 * @param {string} [workspaceId] - The tree the mentions will be read from, '' for the project
 * @param {Parameters<typeof fetchExistingPaths>[2]} [options] - Passed to the existence check
 * @returns {Promise<string[]>} Unique verified paths in order
 */
export async function extractFileMentionsAsync(text, workspaceId = '', options = {}) {
  const candidates = extractFileMentions(text);
  if (candidates.length === 0) return [];

  const existing = await fetchExistingPaths(candidates, workspaceId, options);
  if (existing === null) return candidates.filter(p => p.includes('/'));
  return candidates.filter(p => existing.has(p));
}
