//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * POSIX-shaped shell tokenizer for the auto-approval analyser
 * (`command-approval.js`, which owns the safety policy this feeds).
 *
 * Splits a command string into word and operator tokens, tracking quoting,
 * escapes, command substitution and heredocs. It fails closed: anything it
 * cannot bound precisely — backticks, a bare `$`, an unterminated heredoc,
 * unmatched quotes — makes {@link tokenize} return null so the caller rejects
 * the command rather than analysing a fragment.
 * @module juggler-core/context-items/execute/shell-tokenizer
 */

/**
 * @typedef {import('./approval-types.js').WordToken} WordToken
 * @typedef {import('./approval-types.js').ShellToken} ShellToken
 */

/**
 * Typed indexed access for bounds-checked array reads. Runtime behavior is the
 * same as `arr[i]`; the cast records the local invariant for the JS checker.
 * @template T
 * @param {ArrayLike<T>} arr array-like value
 * @param {number} i index
 * @returns {T} item
 */
export function checkedAt(arr, i) { return /** @type {T} */ (arr[i]); }

/**
 * Operators recognised at top level. Longer matches first so `&&` wins over
 * `&`, `||` over `|`, `2>&1` over `2>`, etc. Subshell-grouping parens `(` / `)`
 * are control operators too: as bare tokens they can only mean subshell
 * grouping (a literal paren in an argument arrives quoted or backslash-escaped,
 * so it's consumed as word text before the operator scan). Tokenising them as
 * ops lets the segment walker treat `( … )` as a group and validate its
 * interior recursively — so `(echo x)` is approved exactly when `echo x` is,
 * and `(echo x; rm y)` is rejected because `rm y` is. Brace groups `{ …; }`
 * use the reserved words `{` / `}`, which arrive as ordinary word tokens.
 */
const SHELL_OPERATORS = [
  '2>&1', '2>>', '||', '&&', ';;', '|&', '<&', '>&', '>>', '<<', '2>',
  ';', '|', '<', '>', '&', '(', ')'
];

/** Operators that split commands at top level. */
export const TOP_LEVEL_SPLIT_OPS = new Set(['&&', '||', ';']);

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * Placeholder a command substitution `$(…)` leaves in a word token's `text`.
 * The raw inner command is captured on the token's `subst` array instead. The
 * sentinel embeds NUL bytes so it can never match a real path, flag, or command
 * name — every downstream check that sees it fails closed. The ONLY code that
 * treats a `subst` token as anything but unsafe is the pure-assignment path
 * (`NAME=$(…)`), which independently re-validates the inner command.
 */
export const SUBST_SENTINEL = '\u0000SUBST\u0000';

/**
 * Scan a `$(…)` command substitution starting at `checkedAt(input, i)` (`checkedAt(input, i)` is `$`,
 * `input[i+1]` is `(`). Returns the inner command text and the index just past
 * the closing `)`, tracking paren depth across nested `$(…)`, single/double
 * quotes, and backslash escapes. Bails (returns null) on backticks or an
 * unterminated substitution — anything we can't bound precisely.
 * @param {string} input full command string
 * @param {number} i index of the `$`
 * @returns {{inner: string, end: number} | null} inner text + end index, or null
 */
function scanCommandSubst(input, i) {
  let j = i + 2;
  let depth = 1;
  while (j < input.length) {
    const c = input[j];
    if (c === '`') return null;
    if (c === '\\') { j += 2; continue; }
    if (c === "'") {
      const end = input.indexOf("'", j + 1);
      if (end === -1) return null;
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j++;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') { j += 2; continue; }
        if (input[j] === '`') return null;
        if (input[j] === '$' && input[j + 1] === '(') {
          const sub = scanCommandSubst(input, j);
          if (!sub) return null;
          j = sub.end;
          continue;
        }
        j++;
      }
      if (j >= input.length) return null;
      j++;
      continue;
    }
    if (c === '$' && input[j + 1] === '(') {
      const sub = scanCommandSubst(input, j);
      if (!sub) return null;
      j = sub.end;
      continue;
    }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      depth--;
      j++;
      if (depth === 0) return { inner: input.slice(i + 2, j - 1), end: j };
      continue;
    }
    j++;
  }
  return null;
}

/**
 * Scan a heredoc redirection (`<<` / `<<-`) starting at `input[i]` (`input[i]`
 * and `input[i+1]` are both `<`). Reads the optional `-` (leading-tab-stripping
 * form) and the here-end delimiter word, which may be unquoted, single- or
 * double-quoted, or backslash-escaped. Quoting only governs whether the body is
 * expanded — irrelevant here, since the body is inert stdin data — so we record
 * the unquoted delimiter text used to match the closing line. Returns the
 * delimiter, whether the tab-stripping form was used, and the index just past
 * the delimiter word. Returns null when no delimiter word is present — notably
 * the `<<<` here-string operator (a different construct), so it stays a bail.
 * @param {string} input full command string
 * @param {number} i index of the first `<`
 * @returns {{delimiter: string, dashStrip: boolean, end: number} | null} delimiter info, or null
 */
function scanHeredocDelimiter(input, i) {
  let j = i + 2;
  let dashStrip = false;
  if (input[j] === '-') { dashStrip = true; j++; }
  while (j < input.length && (input[j] === ' ' || input[j] === '\t')) j++;
  let delimiter = '';
  let sawWord = false;
  while (j < input.length) {
    const c = checkedAt(input, j);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>' || c === '(' || c === ')') break;
    if (c === "'") {
      const end = input.indexOf("'", j + 1);
      if (end === -1) return null;
      delimiter += input.slice(j + 1, end);
      j = end + 1;
      sawWord = true;
      continue;
    }
    if (c === '"') {
      const end = input.indexOf('"', j + 1);
      if (end === -1) return null;
      delimiter += input.slice(j + 1, end);
      j = end + 1;
      sawWord = true;
      continue;
    }
    if (c === '\\') {
      if (j + 1 >= input.length) return null;
      delimiter += checkedAt(input, j + 1);
      j += 2;
      sawWord = true;
      continue;
    }
    delimiter += c;
    j++;
    sawWord = true;
  }
  if (!sawWord || delimiter === '') return null;
  return { delimiter, dashStrip, end: j };
}

/**
 * Tokenise a POSIX-shaped shell command.
 *
 * Returns `null` if anything we can't reason about statically appears:
 * backticks, bare variable expansions, an unterminated heredoc, or unmatched
 * quotes. An unquoted top-level newline is emitted as a `;` separator operator
 * (so a multi-line script is validated segment-by-segment exactly like a
 * `;`-joined one); a backslash-newline is consumed as a line continuation. A
 * terminated heredoc (`cmd <<DELIM … DELIM`) is stripped as an inert input
 * redirect: the operator and the body up to the closing delimiter are consumed,
 * so the command is analysed by its words alone (the body is stdin data and
 * cannot introduce shell-level commands).
 * A command substitution `$(…)` is captured on the word token's `subst` field
 * (its text gets a {@link SUBST_SENTINEL} placeholder) so the segment layer can
 * either re-validate it (pure assignment) or reject it (any other position).
 * @param {string} input the command string
 * @returns {ShellToken[] | null} tokens, or null on bail
 */
export function tokenize(input) {
  /** @type {ShellToken[]} */
  const tokens = [];
  let i = 0;
  let cur = '';
  let curStart = -1;
  /** @type {string[]} command-substitution inner commands seen in the current word */
  let curSubst = [];
  /** @type {boolean} whether the current word contains an UNQUOTED expansion (`$NAME`, `${…}`, `$1`, `$@`, `$((…))`) that can word-split / glob at runtime */
  let curUnquotedVar = false;
  /** @type {Array<{delimiter: string, dashStrip: boolean}>} heredocs whose bodies are consumed at the next newline, FIFO */
  const pendingHeredocs = [];

  const flushWord = (/** @type {number} */ endIdx) => {
    if (curStart !== -1) {
      /** @type {WordToken} */
      const tok = {
        type: 'word',
        text: cur,
        raw: input.slice(curStart, endIdx),
        start: curStart,
        end: endIdx
      };
      if (curSubst.length > 0) tok.subst = curSubst;
      if (curUnquotedVar) tok.unquotedVar = true;
      tokens.push(tok);
      cur = '';
      curStart = -1;
      curSubst = [];
      curUnquotedVar = false;
    }
  };

  /**
   * Consume a `$(…)` command substitution at `checkedAt(input, i)`, appending a
   * {@link SUBST_SENTINEL} placeholder to the current word and recording the
   * inner command. Returns true on success (and advances `i`), false to bail.
   * @returns {boolean} true if captured, false if the caller must bail
   */
  const captureSubst = () => {
    const sub = scanCommandSubst(input, i);
    if (!sub) return false;
    if (curStart === -1) curStart = i;
    cur += SUBST_SENTINEL;
    curSubst.push(sub.inner);
    i = sub.end;
    return true;
  };

  /**
   * Advance one newline at `p` (which must point at `\n` or `\r`), handling a
   * `\r\n` pair as a single line break.
   * @param {number} p index of a newline character
   * @returns {number} index of the first character of the next line
   */
  const skipNewline = (p) => (input[p] === '\r' && input[p + 1] === '\n' ? p + 2 : p + 1);

  /**
   * Consume the bodies of all {@link pendingHeredocs} (FIFO), each running from
   * the line after `startIdx` up to and including a line equal to its delimiter
   * (leading tabs stripped first for the `<<-` form). Returns the index of the
   * newline that ends the last delimiter line (or end-of-input), or null if any
   * heredoc is never terminated.
   * @param {number} startIdx index of the newline that begins the first body
   * @returns {number | null} index just past the last delimiter line, or null
   */
  const consumeHeredocBodies = (startIdx) => {
    let pos = startIdx;
    while (pendingHeredocs.length > 0) {
      const hd = /** @type {{delimiter: string, dashStrip: boolean}} */ (pendingHeredocs.shift());
      for (;;) {
        if (pos >= input.length) return null;
        pos = skipNewline(pos);
        let lineEnd = pos;
        while (lineEnd < input.length && input[lineEnd] !== '\n' && input[lineEnd] !== '\r') lineEnd++;
        const line = input.slice(pos, lineEnd);
        const cmp = hd.dashStrip ? line.replace(/^\t+/, '') : line;
        if (cmp === hd.delimiter) {
          pos = lineEnd; // leave pos at the delimiter line's trailing newline (or EOF)
          break;
        }
        if (lineEnd >= input.length) return null; // EOF before the delimiter
        pos = lineEnd;
      }
    }
    return pos;
  };

  while (i < input.length) {
    const c = checkedAt(input, i);

    if (c === ' ' || c === '\t') { flushWord(i); i++; continue; }
    if (c === '\n' || c === '\r') {
      // An unquoted newline at top level is a sequential command
      // separator, exactly like `;` (quotes and `$(…)` consume their own
      // interior newlines before reaching here; a `\`-newline line
      // continuation is consumed by the `\\` branch below). Skip it when
      // the previous token is already an operator — the line ends with
      // `&&`/`||`/`|`/etc., a continuation — so we never synthesise an
      // empty segment from the line break.
      flushWord(i);
      // A pending heredoc body begins at this newline: consume it (and any
      // further queued heredocs) and resume after the closing delimiter, rather
      // than treating the line break as a command separator.
      if (pendingHeredocs.length > 0) {
        const after = consumeHeredocBodies(i);
        if (after === null) return null;
        i = after;
        continue;
      }
      const prev = tokens[tokens.length - 1];
      if (!prev || prev.type !== 'op') {
        tokens.push({ type: 'op', text: ';', start: i, end: i + 1 });
      }
      i++;
      continue;
    }
    if (c === '`') return null;
    if (c === '$') {
      // Bare (unquoted) `$(…)` command substitution: capture it structurally
      // (re-validated only in the pure-assignment path; rejected everywhere
      // else via its SUBST_SENTINEL).
      if (checkedAt(input, i + 1) === '(' && input[i + 2] !== '(') {
        if (!captureSubst()) return null;
        continue;
      }
      // Any OTHER unquoted expansion — `$NAME`, `${NAME}`, `$1`, `$$`, `$@`,
      // `$((expr))` — is kept as LITERAL word text and the word is marked
      // `unquotedVar`. Unlike a double-quoted expansion, an unquoted one can
      // word-split / glob-expand at runtime, so a marked word is never trusted
      // by a builtin handler (see isSegmentSafe / isSafeSinkTail); it can only
      // be approved by an explicit user glob pattern, whose match is on the
      // literal command text and is unaffected by word-splitting (the head and
      // operators are fixed at parse time, before expansion). This mirrors the
      // double-quoted `$`-handling below, minus the split-safety guarantee.
      const nx = checkedAt(input, i + 1);
      if (nx === '(' && input[i + 2] === '(') {
        // `$((expr))` arithmetic. Scan to the matching `))` by paren depth and
        // reject a smuggled command substitution / backtick in the body.
        let depth = 0;
        let k = i + 1;
        for (; k < input.length; k++) {
          const a = checkedAt(input, k);
          if (a === '(') depth++;
          else if (a === ')') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0 || k >= input.length || checkedAt(input, k) !== ')') return null;
        const arith = input.slice(i + 3, k - 1);
        if (arith.includes('`') || arith.includes('$(')) return null;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, k + 1);
        curUnquotedVar = true;
        i = k + 1;
        continue;
      }
      if (nx === '{') {
        const close = input.indexOf('}', i + 2);
        if (close === -1) return null;
        const body = input.slice(i + 2, close);
        // Same subscript grammar as the double-quoted `${…}` branch: a bare
        // name or a literal-number / `@` / `*` / identifier subscript is a pure
        // value read; anything else (notably a `$(…)` inside the subscript) bails.
        if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:[0-9]+|@|\*|[A-Za-z_][A-Za-z0-9_]*)\])?$/.test(body)) return null;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, close + 1);
        curUnquotedVar = true;
        i = close + 1;
        continue;
      }
      if (nx && /[A-Za-z_]/.test(nx)) {
        let k = i + 1;
        while (k < input.length && /[A-Za-z0-9_]/.test(checkedAt(input, k))) k++;
        if (curStart === -1) curStart = i;
        cur += input.slice(i, k);
        curUnquotedVar = true;
        i = k;
        continue;
      }
      if (nx && /[0-9$?!#*@]/.test(nx)) {
        // `$1`…`$9`, `$$`, `$?`, `$!`, `$#`, `$*`, `$@` — special parameters.
        if (curStart === -1) curStart = i;
        cur += checkedAt(input, i) + nx;
        curUnquotedVar = true;
        i += 2;
        continue;
      }
      // Literal `$` (before space / quote / operator / EOL): `$(` and backticks
      // were handled above, so this is a bare dollar with no expansion. Emit it
      // literally; it does NOT word-split, so the word is NOT marked.
      if (curStart === -1) curStart = i;
      cur += '$';
      i++;
      continue;
    }

    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) return null;
      if (curStart === -1) curStart = i;
      cur += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      if (curStart === -1) curStart = i;
      i++;
      while (i < input.length && checkedAt(input, i) !== '"') {
        const ch = checkedAt(input, i);
        if (ch === '`') return null;
        if (ch === '$') {
          // Inside `"..."`, `$NAME` / `${NAME}` / `$N` / `$$` / `$?`
          // / `$!` / `$#` / `$*` / `$@` are pure variable expansions
          // whose values become literal characters in the resulting
          // argument — they can't introduce new args, flags, or
          // commands. `$(...)` is command substitution; still reject.
          // A `$` NOT starting any of these (e.g. a regex end-anchor
          // `"FAIL$|…"`, or `$` before a space/quote) is a literal
          // dollar in POSIX double-quoting — emit it literally rather
          // than bail.
          const next = checkedAt(input, i + 1);
          if (next === '(' && input[i + 2] === '(') {
            // Arithmetic expansion `$((expr))`. The result is always a
            // numeric value, so it can't introduce new args, flags, or
            // commands. Scan to the matching `))` by paren depth, then
            // reject if the body smuggles a command substitution or
            // backtick (`$(( $(cmd) ))`).
            let depth = 0;
            let k = i + 1;
            for (; k < input.length; k++) {
              const a = checkedAt(input, k);
              if (a === '"') break; // can't cross the closing quote
              if (a === '(') depth++;
              else if (a === ')') { depth--; if (depth === 0) break; }
            }
            if (depth !== 0 || k >= input.length || checkedAt(input, k) !== ')') return null;
            const arith = input.slice(i + 3, k - 1);
            if (arith.includes('`') || arith.includes('$(')) return null;
            cur += input.slice(i, k + 1);
            i = k + 1;
            continue;
          }
          if (next === '(') {
            // Command substitution `"$(…)"` inside double quotes.
            // Capture it (the sentinel keeps the surrounding literal
            // text — e.g. `"prefix-$(cmd)"` — intact).
            if (!captureSubst()) return null;
            continue;
          }
          if (next === '{') {
            const close = input.indexOf('}', i + 2);
            if (close === -1) return null;
            const body = input.slice(i + 2, close);
            // `${NAME}` or `${NAME[idx]}`. An array subscript whose
            // index is a literal number (`${PIPESTATUS[0]}`), `@`/`*`
            // (whole array), or a bare identifier (`${arr[i]}`) is a
            // pure value read — it can't introduce new args/commands.
            // Anything else in the subscript (notably `$(...)`, which
            // bash arithmetic-evaluates) must still bail.
            if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:[0-9]+|@|\*|[A-Za-z_][A-Za-z0-9_]*)\])?$/.test(body)) return null;
            cur += input.slice(i, close + 1);
            i = close + 1;
            continue;
          }
          if (next && /[A-Za-z_]/.test(next)) {
            let k = i + 1;
            while (k < input.length && /[A-Za-z0-9_]/.test(checkedAt(input, k))) k++;
            cur += input.slice(i, k);
            i = k;
            continue;
          }
          if (next && /[0-9$?!#*@]/.test(next)) {
            cur += checkedAt(input, i) + checkedAt(input, i + 1);
            i += 2;
            continue;
          }
          // Literal `$` (not an expansion). `$(` and backticks were
          // already rejected above, so this can't be substitution.
          cur += '$';
          i++;
          continue;
        }
        if (ch === '\\') {
          if (i + 1 >= input.length) return null;
          // POSIX: inside double quotes `\` is special ONLY before
          // `$`, `` ` ``, `"`, `\`, or newline — there it escapes the
          // next char. Before anything else the backslash is literal
          // and BOTH characters survive (e.g. a grep pattern like
          // `"\-\-bg-\s*:"` must keep its backslashes, not collapse to
          // `--bg-s*:` which then looks like an unknown `--` flag).
          const n = checkedAt(input, i + 1);
          if (n === '$' || n === '`' || n === '"' || n === '\\' || n === '\n') {
            cur += n;
          } else {
            cur += ch + n;
          }
          i += 2;
          continue;
        }
        cur += ch;
        i++;
      }
      if (i >= input.length) return null;
      i++;
      continue;
    }

    if (c === '\\') {
      if (i + 1 >= input.length) return null;
      // `\`-newline is a line continuation: the shell removes both
      // characters and joins the lines, so consume them without emitting
      // anything (the current word, if any, keeps accumulating).
      if (checkedAt(input, i + 1) === '\n') { i += 2; continue; }
      if (checkedAt(input, i + 1) === '\r' && input[i + 2] === '\n') { i += 3; continue; }
      if (curStart === -1) curStart = i;
      cur += checkedAt(input, i + 1);
      i += 2;
      continue;
    }

    // An unquoted `#` at a word boundary begins a comment that runs to the end
    // of the line (POSIX). It is only a comment at the START of a word: a `#`
    // inside a word (`foo#bar`, `$VAR#`) is a literal character, so we require
    // `curStart === -1` (no word currently accumulating — quoted `#` never
    // reaches here, it is consumed inside the quote branches). The terminating
    // newline is left in place for the newline branch to handle as a normal
    // command separator, so a comment line behaves exactly like a blank line.
    if (c === '#' && curStart === -1) {
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
      continue;
    }

    let matched = null;
    for (const op of SHELL_OPERATORS) {
      if (input.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      if (matched === '<<') {
        // Heredoc: queue its delimiter and strip the operator. The body is
        // consumed at the next newline (see consumeHeredocBodies); the `<<<`
        // here-string and any other delimiter-less form yields null → bail.
        const hd = scanHeredocDelimiter(input, i);
        if (!hd) return null;
        flushWord(i);
        pendingHeredocs.push({ delimiter: hd.delimiter, dashStrip: hd.dashStrip });
        i = hd.end;
        continue;
      }
      flushWord(i);
      tokens.push({ type: 'op', text: matched, start: i, end: i + matched.length });
      i += matched.length;
      continue;
    }

    if (curStart === -1) curStart = i;
    cur += c;
    i++;
  }
  flushWord(i);
  // A heredoc whose delimiter line never arrived (e.g. `cat <<EOF` with no
  // body) is an incomplete command — bail rather than analyse a fragment.
  if (pendingHeredocs.length > 0) return null;
  return tokens;
}
