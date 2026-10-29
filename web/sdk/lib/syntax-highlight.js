//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Syntax highlighting helpers — the single highlighting engine for item UIs.
 *
 * Every place that turns code + a language into coloured DOM funnels through
 * `highlightCode` here: tile summaries (`createHighlightedCode`), properties-
 * panel subsections (`createCopyableText({ language })`), the shared file-code
 * renderer (`createCodeBlock`), fenced blocks in rendered markdown, and the
 * `<code-block>` element. A surface that lays code out a line at a time — a
 * line-numbered grid, a diff row — uses `highlightCodeLines` instead. Add a new
 * highlighted surface by calling one of these — don't reach for a second
 * highlighter.
 *
 * Which grammar a file or fence resolves to is `./languages.js`; this module
 * only asks it to canonicalise whatever name it is handed.
 *
 * Thin wrapper over the vendored Prism.js loaded as a global (see index.html,
 * and the diff worker, which loads the same scripts into its own scope). We
 * read `globalThis.Prism` at call time — never import it — so this module stays
 * side-effect free and safe to load before Prism, and degrades to escaped plain
 * text when Prism or the requested grammar is unavailable (e.g. a worker that
 * did not load it, or a language whose component wasn't bundled).
 *
 * The tokens Prism emits carry `.token.<type>` classes; `css/vendor/prism-theme.css`
 * colours them, so any element produced here picks up the app theme for free.
 */

import { escapeHtml } from './html.js';
import { normalizeLanguageId } from './languages.js';

const BASH_SEGMENT_CLASS_COUNT = 6;
const BASH_OPERATOR_STARTS = new Set(['&', '|', ';', '<', '>', '\n']);
const BASH_THREE_CHAR_OPERATORS = new Set(['<<<', ';;&']);
const BASH_TWO_CHAR_OPERATORS = new Set(['&&', '||', '|&', ';;', ';&', '<<', '>>', '<&', '>&', '<>', '>|', '&>']);
const BASH_REDIRECT_OPERATORS = new Set(['<', '>', '<<', '>>', '<<<', '<&', '>&', '<>', '>|', '&>']);

/**
 * @typedef {{ kind: 'segment'|'operator'|'heredoc', text: string }} BashPiece
 */

/**
 * Highlight a code string, returning safe HTML.
 *
 * Prism escapes the source as it tokenises, so the returned string is safe to
 * assign to `innerHTML`. When Prism or the grammar is missing we fall back to
 * `escapeHtml`, so the return value is always insertion-safe.
 * @param {string} code - Source code to highlight
 * @param {string} language - Language id or alias (e.g. 'bash', 'json', 'py')
 * @returns {string} Highlighted (or escaped) HTML
 */
export function highlightCode(code, language) {
  const text = (code === null || code === undefined) ? '' : String(code);
  const id = normalizeLanguageId(language);
  if (id === 'bash') {
    return highlightBashCommand(text);
  }

  /** @type {{Prism?: {languages?: Record<string, object>, highlight: (text: string, grammar: object, language: string) => string}}} */
  const host = /** @type {object} */ (globalThis);
  const Prism = host.Prism;
  const grammar = Prism?.languages?.[id];
  if (Prism && grammar) {
    try {
      return Prism.highlight(text, grammar, id);
    } catch (error) {
      console.error('[syntax-highlight] highlighting failed:', error);
    }
  }
  return escapeHtml(text);
}

/**
 * Highlight a block and hand back one safe HTML string per source line.
 *
 * A surface that lays code out line by line — a line-numbered grid, a diff row —
 * cannot use one blob of markup, but highlighting each line separately gets the
 * tokens wrong: a block comment or a multi-line template literal is only
 * recognisable as a whole. So the block is highlighted once and the markup split
 * at newlines, closing every element still open at the end of a line and
 * reopening it on the next. Each line is therefore balanced markup on its own,
 * and their concatenation is the original block.
 * @param {string} code - Source code to highlight
 * @param {string} language - Language id or alias
 * @returns {string[]} One highlighted (or escaped) HTML string per line
 */
export function highlightCodeLines(code, language) {
  const text = (code === null || code === undefined) ? '' : String(code);
  return splitHighlightedLines(highlightCode(text, language));
}

/**
 * Matches one tag: the name, then attributes in which a quoted value may hold
 * any character, including `>`. Only ever run over markup produced by
 * `highlightCode` (Prism's `<span>`s, or `highlightBashCommand`'s), which is why
 * this is a scanner rather than a parser — it never sees caller HTML, comments,
 * CDATA or unquoted attribute values.
 */
const HIGHLIGHT_TAG_PATTERN = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/**
 * Split highlighted markup into per-line strings, re-balancing open elements.
 * @param {string} html - Markup from {@link highlightCode}
 * @returns {string[]} One balanced HTML string per line
 */
function splitHighlightedLines(html) {
  /** @type {string[]} */
  const lines = [];
  /**
   * Elements open at the current position, outermost first.
   * @type {{ tag: string, open: string }[]}
   */
  const open = [];
  let current = '';

  /** @param {string} chunk - Text (already escaped) between two tags. */
  const addText = (chunk) => {
    if (!chunk) return;
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        for (let j = open.length - 1; j >= 0; j--) current += `</${open[j]?.tag}>`;
        lines.push(current);
        current = open.map((entry) => entry.open).join('');
      }
      current += parts[i] ?? '';
    }
  };

  HIGHLIGHT_TAG_PATTERN.lastIndex = 0;
  let textFrom = 0;
  /** @type {RegExpExecArray|null} */
  let match;
  while ((match = HIGHLIGHT_TAG_PATTERN.exec(html)) !== null) {
    addText(html.slice(textFrom, match.index));
    textFrom = HIGHLIGHT_TAG_PATTERN.lastIndex;
    const tag = match[0];
    const name = match[2] || '';
    const attributes = match[3] || '';
    if (match[1]) {
      // A close with nothing open can only come from markup we did not emit;
      // drop it rather than unbalancing every line that follows.
      if (open.length === 0) continue;
      open.pop();
    } else if (!attributes.endsWith('/')) {
      open.push({ tag: name, open: tag });
    }
    current += tag;
  }
  addText(html.slice(textFrom));
  lines.push(current);

  return lines;
}

/**
 * Highlight shell commands for readability rather than language completeness.
 * The UI needs to show the top-level shape of long compound commands: sections,
 * connecting operators, the command word in each section, and its arguments.
 * @param {string} text - Bash command text
 * @returns {string} Safe highlighted HTML
 */
function highlightBashCommand(text) {
  const pieces = splitBashCommand(text);
  let segmentIndex = 0;
  let previousOperator = '';

  return pieces.map((piece) => {
    if (piece.kind === 'operator') {
      previousOperator = piece.text.trim();
      const redirectClass = isRedirectOperator(previousOperator) ? ' bash-command-redirect-operator' : '';
      return `<span class="token bash-command-operator${redirectClass}">${escapeHtml(piece.text)}</span>`;
    }

    if (piece.kind === 'heredoc') {
      // The body of a here-document is inert stdin data, not shell syntax:
      // render it verbatim as a string rather than splitting it into words.
      previousOperator = '';
      return `<span class="token bash-command-string bash-command-heredoc">${escapeHtml(piece.text)}</span>`;
    }

    const isRedirectTarget = isRedirectOperator(previousOperator);
    previousOperator = '';
    if (!piece.text.trim()) return escapeHtml(piece.text);

    const className = `token bash-command-segment bash-command-segment-${segmentIndex % BASH_SEGMENT_CLASS_COUNT}`;
    segmentIndex++;
    return `<span class="${className}">${highlightBashSegment(piece.text, isRedirectTarget)}</span>`;
  }).join('');
}

/**
 * Split a shell command at top-level operators, preserving quotes and common
 * substitutions well enough for display. This is a highlighter, not a shell
 * parser: incomplete syntax just remains part of the nearest text section.
 * @param {string} input
 * @returns {BashPiece[]} The command split into operator and text pieces.
 */
function splitBashCommand(input) {
  /** @type {BashPiece[]} */
  const pieces = [];
  let segmentStart = 0;
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let parenDepth = 0;
  let braceDepth = 0;
  /** @type {{ delimiter: string, dashStrip: boolean }[]} here-doc bodies pending at the next newline, FIFO */
  const pendingHeredocs = [];

  const pushSegment = (/** @type {number} */ end) => {
    if (end > segmentStart) pieces.push({ kind: 'segment', text: input.slice(segmentStart, end) });
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1] || '';

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (singleQuoted) {
      if (ch === "'") singleQuoted = false;
      i++;
      continue;
    }

    if (backtickQuoted) {
      if (ch === '`') backtickQuoted = false;
      i++;
      continue;
    }

    if (ch === "'" && !doubleQuoted) {
      singleQuoted = true;
      i++;
      continue;
    }

    if (ch === '`' && !doubleQuoted) {
      backtickQuoted = true;
      i++;
      continue;
    }

    if (ch === '"') {
      doubleQuoted = !doubleQuoted;
      i++;
      continue;
    }

    if (!doubleQuoted) {
      if (ch === '$' && next === '(') {
        parenDepth++;
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        braceDepth++;
        i += 2;
        continue;
      }
      if (parenDepth > 0 && ch === '(') {
        parenDepth++;
        i++;
        continue;
      }
      if (parenDepth > 0 && ch === ')') {
        parenDepth--;
        i++;
        continue;
      }
      if (braceDepth > 0 && ch === '}') {
        braceDepth--;
        i++;
        continue;
      }
    }

    if (!doubleQuoted && parenDepth === 0 && braceDepth === 0) {
      const operator = readBashOperator(input, i);
      if (operator) {
        pushSegment(i);
        pieces.push({ kind: 'operator', text: operator });
        i += operator.length;
        segmentStart = i;

        // A here-doc redirection (`<<` / `<<-`, but not the `<<<` here-string)
        // introduces a body that begins at the next newline: record its
        // delimiter so we can consume that body as inert text. The delimiter
        // word itself stays in the normal stream (rendered as the redirect
        // target); we only look ahead to learn how the body ends.
        if (operator === '<<') {
          const hd = scanHeredocDelimiter(input, i);
          if (hd) pendingHeredocs.push(hd);
        } else if (operator === '\n' && pendingHeredocs.length > 0) {
          const bodyEnd = consumeHeredocBodies(input, i, pendingHeredocs);
          if (bodyEnd > i) pieces.push({ kind: 'heredoc', text: input.slice(i, bodyEnd) });
          i = bodyEnd;
          segmentStart = i;
        }
        continue;
      }
    }

    i++;
  }

  pushSegment(input.length);
  return pieces;
}

/**
 * Scan the here-end delimiter of a here-doc redirection whose `<<` operator ends
 * at `j` (so `input[j]` is the character right after `<<`). Handles the optional
 * `-` (leading-tab-stripping) form and a delimiter word that is unquoted, single-
 * or double-quoted, or backslash-escaped. Quoting only governs body expansion,
 * which is irrelevant for display, so the unquoted delimiter text is recorded to
 * match the closing line. Returns null when no delimiter word follows.
 * @param {string} input
 * @param {number} j index just past the `<<` operator
 * @returns {{ delimiter: string, dashStrip: boolean } | null} The delimiter and whether the tab-stripping form was used, or null when no delimiter follows.
 */
function scanHeredocDelimiter(input, j) {
  let dashStrip = false;
  if (input[j] === '-') { dashStrip = true; j++; }
  while (input[j] === ' ' || input[j] === '\t') j++;
  let delimiter = '';
  let sawWord = false;
  while (j < input.length) {
    const c = input[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>' || c === '(' || c === ')') break;
    if (c === "'" || c === '"') {
      const end = input.indexOf(c, j + 1);
      if (end === -1) return null;
      delimiter += input.slice(j + 1, end);
      j = end + 1;
      sawWord = true;
      continue;
    }
    if (c === '\\') {
      if (j + 1 >= input.length) return null;
      delimiter += input[j + 1];
      j += 2;
      sawWord = true;
      continue;
    }
    delimiter += c;
    j++;
    sawWord = true;
  }
  if (!sawWord || delimiter === '') return null;
  return { delimiter, dashStrip };
}

/**
 * Consume the bodies of every queued here-doc, in FIFO order, starting at the
 * newline index `nlStart` (the `\n` that opens the first body). Each body runs
 * up to and including a line equal to its delimiter (with leading tabs stripped
 * for the `<<-` form); an un-terminated body runs to the end of input. The
 * queue is drained. Returns the end index of the consumed region, kept just
 * before the final trailing newline so that newline still splits the following
 * command from the here-doc block.
 * @param {string} input
 * @param {number} nlStart index of the `\n` beginning the first body
 * @param {{ delimiter: string, dashStrip: boolean }[]} pendingHeredocs drained in place
 * @returns {number} index just past the consumed here-doc region
 */
function consumeHeredocBodies(input, nlStart, pendingHeredocs) {
  let k = nlStart + 1; // step past the newline that opens the body
  while (pendingHeredocs.length > 0) {
    const hd = /** @type {{ delimiter: string, dashStrip: boolean }} */ (pendingHeredocs.shift());
    while (k < input.length) {
      const nl = input.indexOf('\n', k);
      const lineEnd = nl === -1 ? input.length : nl;
      let line = input.slice(k, lineEnd);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const candidate = hd.dashStrip ? line.replace(/^\t+/, '') : line;
      k = nl === -1 ? input.length : nl + 1;
      if (candidate === hd.delimiter || nl === -1) break;
    }
  }
  // Leave the closing newline as a separator operator for the next command.
  if (k > nlStart && input[k - 1] === '\n') k--;
  return k;
}

/**
 * @param {string} input
 * @param {number} i
 * @returns {string} The operator starting at `i`, or `''` if none starts there.
 */
function readBashOperator(input, i) {
  const ch = input[i] || '';
  if (!BASH_OPERATOR_STARTS.has(ch)) return '';
  if (isFileDescriptorDuplicationAt(input, i)) return '';

  const three = input.slice(i, i + 3);
  if (BASH_THREE_CHAR_OPERATORS.has(three)) return three;

  const fdRedirect = input.slice(i).match(/^\d*(?:>>?|<<?|<>|>&|<&)/);
  if (fdRedirect) return fdRedirect[0];

  const two = input.slice(i, i + 2);
  if (BASH_TWO_CHAR_OPERATORS.has(two)) return two;

  return ch;
}

/**
 * Treat compact fd duplication like `2>&1` or `1<&0` as an argument-shaped word.
 * Splitting inside it adds visual noise without helping users parse command flow.
 * @param {string} input
 * @param {number} i
 * @returns {boolean} True when the character at `i` is part of an fd duplication like `2>&1`.
 */
function isFileDescriptorDuplicationAt(input, i) {
  const ch = input[i];
  const prev = input[i - 1] || '';
  const prevPrev = input[i - 2] || '';
  const next = input[i + 1] || '';
  if ((ch === '>' || ch === '<') && next === '&') {
    return /\d/.test(prev) && /\d|-/.test(input[i + 2] || '');
  }
  if (ch === '&' && (prev === '>' || prev === '<')) {
    return /\d/.test(prevPrev) && /\d|-/.test(next);
  }
  return false;
}

/**
 * @param {string} operator
 * @returns {boolean} True when `operator` redirects a stream (e.g. `>`, `2>>`).
 */
function isRedirectOperator(operator) {
  return BASH_REDIRECT_OPERATORS.has(operator) || /^\d*(?:>>?|<<?|<>|>&|<&)$/.test(operator);
}

/**
 * Render one command section. The first non-assignment word is highlighted as
 * the command head, while later words are quieter arguments of the same hue.
 * @param {string} text
 * @param {boolean} isRedirectTarget
 * @returns {string} HTML for the segment, with command and argument spans.
 */
function highlightBashSegment(text, isRedirectTarget) {
  const tokens = splitBashWords(text);
  let commandSeen = false;

  return tokens.map((token) => {
    if (/^\s+$/.test(token)) return escapeHtml(token);

    const quotedClass = /^(['"])/.test(token) ? ' bash-command-string' : '';
    if (isRedirectTarget) {
      return `<span class="bash-command-redirect-target${quotedClass}">${escapeHtml(token)}</span>`;
    }
    if (!commandSeen && isAssignmentWord(token)) {
      return `<span class="bash-command-assignment${quotedClass}">${escapeHtml(token)}</span>`;
    }
    if (!commandSeen) {
      commandSeen = true;
      return `<span class="bash-command-head${quotedClass}">${escapeHtml(token)}</span>`;
    }
    return `<span class="bash-command-arg${quotedClass}">${escapeHtml(token)}</span>`;
  }).join('');
}

/**
 * Split a command segment into whitespace and word tokens, keeping quoted strings
 * as part of the word so command/argument styling preserves shell grouping.
 * @param {string} text
 * @returns {string[]} Alternating whitespace and word tokens, quotes preserved.
 */
function splitBashWords(text) {
  /** @type {string[]} */
  const tokens = [];
  let start = 0;
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;

  const push = (/** @type {number} */ end) => {
    if (end > start) tokens.push(text.slice(start, end));
  };

  while (i < text.length) {
    const ch = text[i] || '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (singleQuoted) {
      if (ch === "'") singleQuoted = false;
      i++;
      continue;
    }
    if (doubleQuoted) {
      if (ch === '"') doubleQuoted = false;
      i++;
      continue;
    }
    if (backtickQuoted) {
      if (ch === '`') backtickQuoted = false;
      i++;
      continue;
    }
    if (ch === "'") {
      singleQuoted = true;
      i++;
      continue;
    }
    if (ch === '"') {
      doubleQuoted = true;
      i++;
      continue;
    }
    if (ch === '`') {
      backtickQuoted = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      push(i);
      start = i;
      while (i < text.length && /\s/.test(text[i] || '')) i++;
      push(i);
      start = i;
      continue;
    }
    i++;
  }

  push(text.length);
  return tokens;
}

/**
 * @param {string} token
 * @returns {boolean} True when `token` is a `NAME=value` assignment word.
 */
function isAssignmentWord(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(token);
}

/**
 * Build an element containing highlighted code.
 *
 * The element carries `language-<id>` (so Prism's theme selectors match) plus
 * `syntax-highlight` (an integration hook for callers that need to tune
 * wrapping/sizing to their surrounding layout).
 * @param {string} code - Source code to highlight
 * @param {string} language - Prism language id (e.g. 'bash')
 * @param {string} [tag='code'] - Element tag to create
 * @returns {HTMLElement} Element with highlighted content
 */
export function createHighlightedCode(code, language, tag = 'code') {
  const el = document.createElement(tag);
  el.className = `syntax-highlight language-${language}`;
  el.innerHTML = highlightCode(code, language);
  return el;
}
