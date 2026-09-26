//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Static auto-approval analysis for shell commands.
 *
 * Decides whether a command is safe to run without prompting the user. The
 * decision is purely static — no filesystem syscalls, no execution. The
 * tokenizer is POSIX-shaped (sh / bash / zsh syntax); Windows is handled by
 * a shape-check that opts in for WSL- and git-bash-style commands and bails
 * on native cmd.exe / PowerShell.
 *
 * This module owns the segment/flow analysis and the public API. Its two
 * collaborators are `./shell-tokenizer.js` (step 1 below) and
 * `./command-handlers.js` (the per-command policies consulted in step 6);
 * shared shapes live in `./approval-types.js`.
 *
 * Pipeline:
 *   1. Tokenize. Bail on backticks, bare `$`/expansions, an unterminated
 *      heredoc, or unmatched quotes. An unquoted top-level newline is a
 *      sequential command separator (like `;`); a backslash-newline is a line
 *      continuation that joins the two lines. A terminated heredoc
 *      (`cmd <<DELIM … DELIM`) is stripped as an inert input redirect — the
 *      body is stdin data, so the command is judged by its words alone.
 *   2. On `platform === 'windows'`, require POSIX shape (no `\` paths,
 *      no `%VAR%`, no native cmd/PowerShell tokens, no standalone `&`).
 *   3. Repeatedly strip trailing read-only sinks: ` 2>&1`, ` >/dev/null`,
 *      ` 2>/dev/null`, ` >>/dev/null`, ` | <safe-sink>` where `<safe-sink>`
 *      is `cat`, `tail`, `head`, or `wc` with whitelisted args — or `tee`,
 *      whose file operands (write targets) are gated exactly like a write
 *      redirect (writeEnabled + inside an allowed path).
 *   4. Strip a leading `cd <path-inside-project> &&` if present.
 *   5. Split on top-level `&&`, `||`, `;` (not splitting inside `( … )` /
 *      `{ …; }` groups). Every sub-segment must be safe; a grouped segment is
 *      safe iff its interior — validated recursively as its own command
 *      sequence — is safe.
 *      Precedence-safe: every piece is validated independently, so no
 *      precedence quirk can let an unsafe piece through.
 *   6. A segment is safe iff (after stripping its own trailing sinks) it
 *      contains NO remaining operator tokens AND its head command is in
 *      the {@link COMMAND_HANDLERS} registry with arguments accepted by
 *      that handler — OR it matches one of the user's enabled glob
 *      patterns.
 *
 * SECURITY: write/append redirects (`>`, `>>`, `2>`) are stripped only when the
 * target is `/dev/null`, or — when file-writing is enabled for the conversation
 * (`writeEnabled`) — when the target resolves inside an allowed path. Any other
 * target leaves an op token in the segment, which triggers rejection. Stripping
 * a redirect only removes an output destination the LLM is already permitted to
 * write; the command words are still validated independently, so it can never
 * approve a command that would otherwise be rejected. A terminated heredoc
 * (`<<`) is stripped at tokenize time as an inert input redirect (its body is
 * stdin data); an unterminated one bails. Command substitution (`$(`,
 * backticks) and variable expansion (`$`) are rejected at tokenize time.
 * @module model/command-approval
 */

import {
  posixNormalize,
  isPathInsideAllowedRoots,
  resolveAgainstCwd,
  canonicalRoot,
  isGrantableRoot,
  windowsToComparable,
} from 'juggler/utils/path-containment';
import { checkedAt, tokenize, SUBST_SENTINEL, TOP_LEVEL_SPLIT_OPS } from './shell-tokenizer.js';
import { COMMAND_HANDLERS, pathAllowed } from './command-handlers.js';

// The path-containment helpers used to live in this file; they now live in the
// shared SDK module above so the file write/edit tools enforce containment with
// the exact same logic. Re-export the ones that were historically public here
// (bash-command-approval-unit-test.js and plugin code import them from this
// module) so those callers keep resolving — as is `tokenize`, which moved to
// ./shell-tokenizer.js.
export { posixNormalize, isPathInsideAllowedRoots, canonicalRoot, isGrantableRoot, tokenize };

/**
 * @typedef {import('./approval-types.js').WordToken} WordToken
 * @typedef {import('./approval-types.js').OpToken} OpToken
 * @typedef {import('./approval-types.js').ShellToken} ShellToken
 * @typedef {import('./approval-types.js').ApprovalCtx} ApprovalCtx
 * @typedef {import('./approval-types.js').VarProvenance} VarProvenance
 * @typedef {import('./approval-types.js').RedirectCfg} RedirectCfg
 */

/** Native Windows shell tokens we refuse outright. */
const WINDOWS_NATIVE_TOKENS = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'dir', 'copy', 'move', 'del', 'erase', 'rd', 'rmdir', 'md', 'mkdir',
  'cls', 'ren', 'rename', 'where',
  'wscript', 'wscript.exe', 'cscript', 'cscript.exe'
]);

/**
 * Normalise the effective working directory into the one spelling the rest of
 * the analyser resolves relative paths against: forward slashes, no trailing
 * separator. The caller's cwd comes from `session.projectPath`, which is
 * OS-native — backslash-separated on Windows — so it is folded there (only
 * there: a backslash is a legal, if perverse, character in a POSIX filename).
 * @param {string} [cwd] effective working directory, OS-native
 * @param {string} [platform] conversation platform
 * @returns {string} normalised cwd, or '' when unknown
 */
function normaliseCwd(cwd, platform = '') {
  if (!cwd) return '';
  const s = platform === 'windows' ? cwd.replace(/\\/g, '/') : cwd;
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * The working directory a `cd <target>` moves the shell to, given where it is
 * standing now. `~`/`~/x` expands against the known home (as the shell would);
 * everything else resolves against the current {@link ApprovalCtx.cwd}. Called
 * only for a target that has already passed the containment check, so the
 * result is a directory the command is allowed to be in.
 * @param {string} target the `cd` argument
 * @param {ApprovalCtx} ctx approval context (current cwd + home + platform)
 * @returns {string} the new working directory
 */
function cdTargetCwd(target, ctx) {
  let p = target;
  if (ctx.home) {
    const base = ctx.home.endsWith('/') ? ctx.home.slice(0, -1) : ctx.home;
    if (p === '~' || p === '~/') p = base;
    else if (p.startsWith('~/')) p = base + '/' + p.slice(2);
  }
  return normaliseCwd(resolveAgainstCwd(p, ctx.cwd || '', ctx.platform), ctx.platform);
}

// ============================================================================
// Glob matching
// ============================================================================

/**
 * Glob-match a command string against a pattern. `*` matches anything except
 * newlines; all other regex metacharacters are escaped.
 * @param {string} pattern glob pattern
 * @param {string} command command string
 * @returns {boolean} true on match
 */
export function matchesGlob(pattern, command) {
  if (pattern === '*') return true;
  if (pattern === command) return true;
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^\\n]*');
  try {
    return new RegExp('^' + re + '$').test(command);
  } catch {
    return false;
  }
}

// ============================================================================
// Sink stripping (read-only tails)
// ============================================================================

/**
 * Is a write/append redirect to `target` (`> target`, `>> target`, `2> target`)
 * safe to strip from a command for the purposes of static analysis?
 *
 * A redirect names an output *destination*; stripping it only removes where
 * output goes, never what the command does (the command words are still
 * validated independently). It is safe to strip when:
 *   - `target` is `/dev/null` — output is discarded; always inert; or
 *   - file-writing is enabled for this conversation (`writeEnabled`) AND
 *     `target` resolves inside an allowed path. This mirrors the write-file
 *     plugin (which grants writes when its permission is on) but is additionally
 *     path-scoped: a bash redirect may only write where the LLM is already
 *     allowed to write files.
 * @param {string} target the redirect target word
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {boolean} true if the redirect can be stripped
 */
function isStrippableRedirectTarget(target, cfg = {}) {
  if (target === '/dev/null') return true;
  return Boolean(cfg.writeEnabled) && pathAllowed(target, cfg);
}

/**
 * Is the token sequence `<cmd> <args...>` a safe end-of-pipeline sink?
 *
 * Delegates to {@link CommandHandler.isSafeAsSink} on the handler registered
 * for `<cmd>`. The base class defaults `isSafeAsSink` to false, so any
 * handler that wants to participate must explicitly opt in by overriding.
 * A sink stage may carry its own safe redirects (`… 2>/dev/null`, `… >>log`
 * when writing is permitted); those are stripped first so a stage like
 * `xargs grep -l X 2>/dev/null` is still recognised as a clean sink.
 * @param {ShellToken[]} tokens tokens of the would-be sink pipeline tail
 * @param {RedirectCfg} [cfg] redirect policy (for stripping the stage's own redirects)
 * @returns {boolean} true if the tail is a safe sink
 */
function isSafeSinkTail(tokens, cfg = {}) {
  if (tokens.length === 0) return false;
  tokens = stripInlineSafeRedirects(tokens, cfg);
  if (tokens.length === 0) return false;
  if (tokens.some(t => t.type === 'op')) return false;
  // A sink stage is stripped-and-discarded from the pipeline, so it must not
  // carry anything we can't statically vouch for. Reject the stage (leaving the
  // pipe unstripped, which fails the segment) if any token holds a command
  // substitution — `producer | grep $(curl evil)` would otherwise strip the
  // sink and approve only the producer, never vetting the substitution — or an
  // unquoted expansion, which can word-split a value into an extra argument
  // (e.g. `… | grep $x` where `$x` becomes `PATTERN /etc/passwd`, turning a
  // read-only filter into an out-of-project file read).
  if (tokens.some(t => t.type === 'word'
			&& (/** @type {WordToken} */ (t).subst || /** @type {WordToken} */ (t).unquotedVar))) return false;
  const head = /** @type {WordToken} */ (tokens[0]);
  const handler = COMMAND_HANDLERS.get(head.text);
  if (!handler) return false;
  const args = /** @type {WordToken[]} */ (tokens.slice(1)).map(t => t.text);
  return handler.isSafeAsSink(args, cfg);
}

/**
 * Strip read-only output sinks from the tail of the token stream until no
 * more can be removed. Sinks: `2>&1`, `> <strippable>`, `2> <strippable>`,
 * `>> <strippable>`, `| <safe-sink>`, where `<strippable>` is `/dev/null` or,
 * when write permission is on, a target inside an allowed path (see
 * {@link isStrippableRedirectTarget}).
 *
 * Write redirects to a target that is neither `/dev/null` nor an allowed
 * write destination are deliberately not stripped — they remain as op tokens
 * and the segment will be rejected.
 * @param {ShellToken[]} tokens tokens to strip from
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {ShellToken[]} stripped tokens
 */
function stripTrailingSafeSinks(tokens, cfg = {}) {
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const last = checkedAt(tokens, tokens.length - 1);

    if (last.type === 'op' && last.text === '2>&1') {
      tokens = tokens.slice(0, -1);
      changed = true;
      continue;
    }

    if (tokens.length >= 2) {
      const op = checkedAt(tokens, tokens.length - 2);
      const word = checkedAt(tokens, tokens.length - 1);
      if (op.type === 'op'
					&& (op.text === '>' || op.text === '2>' || op.text === '>>')
					&& word.type === 'word'
					&& isStrippableRedirectTarget(word.text, cfg)) {
        tokens = tokens.slice(0, -2);
        changed = true;
        continue;
      }
    }

    let pipeIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (checkedAt(tokens, i).type === 'op' && checkedAt(tokens, i).text === '|') { pipeIdx = i; break; }
    }
    if (pipeIdx !== -1 && isSafeSinkTail(tokens.slice(pipeIdx + 1), cfg)) {
      tokens = tokens.slice(0, pipeIdx);
      changed = true;
      continue;
    }
  }
  return tokens;
}

// ============================================================================
// Leading `cd <path> <sep>` stripping
// ============================================================================

/**
 * Strip a leading `cd <in-project-path> <sep>` — where `<sep>` is any top-level
 * command separator (`&&`, `||`, or `;`, the last also covering an unquoted
 * newline, which tokenises as `;`) — so the rest of the command is judged on its
 * own. All three separators are treated identically: a leading `cd <in-root>;`
 * (or newline-joined) `cd` is no less safe than the `&&` form, since every
 * segment is validated independently.
 *
 * The directory the `cd` moves to is recorded on `ctx` before the tokens are
 * dropped, because the segments that follow run there: `cd web/extensions &&
 * grep -rn X ../../js` reads a path inside the project, and only a cwd-aware
 * analysis can see that. {@link validateSegmentSequence} keeps that record up to
 * date for any further `cd` in the sequence.
 *
 * Returns `null` when a leading `cd` IS present but is not a cleanly-strippable
 * `cd <in-root> <sep>` — a bare `cd` (→ $HOME), `cd -`, or an out-of-root target.
 * `null` means "refuse": an out-of-project `cd` must never auto-approve, so the
 * approval path rejects outright.
 *
 * One of those refusals has an honest remedy, and `outGrantable` is how the
 * suggestion path asks for it. When the sole objection is that the target sits
 * outside the allowed roots AND that target is a grantable root, the folder
 * grant covering it is reported there along with the directory the rest of the
 * command runs in and the tokens that follow — enough for the caller to offer
 * "allow this folder" and analyse the remainder as it will actually run. That
 * grant is the narrow fix; it is emphatically not a `cd *` glob, which would
 * auto-approve `cd` to anywhere and is never suggested for a `cd` in any
 * position (see {@link CdHandler.pathArgs}). A refusal with no grantable target —
 * a bare `cd`, `cd -`, `cd ~`, a target carrying a shell expansion — leaves
 * `outGrantable` untouched, so the caller falls back to suggesting nothing.
 *
 * A non-`cd` leading token — or a `cd` too short to carry a separator — returns
 * the tokens unchanged for normal segmentation, where {@link CdHandler}
 * validates a lone `cd <path>` segment in any position.
 * @param {ShellToken[]} tokens tokens with a possible leading `cd X <sep>`
 * @param {ApprovalCtx} ctx approval context
 * @param {{grant?: string, cwd?: string, tokens?: ShellToken[]}} [outGrantable] if
 *   provided, receives `{grant, cwd, tokens}` when the refusal is solely an
 *   out-of-root target that a folder grant would fix
 * @returns {ShellToken[] | null} tokens with a clean leading `cd X <sep>` removed, unchanged when there is no leading `cd`, or null to refuse
 */
function stripLeadingSafeCd(tokens, ctx, outGrantable) {
  if (tokens.length < 3) return tokens;
  const t0 = checkedAt(tokens, 0);
  if (t0.type !== 'word' || t0.text !== 'cd') return tokens;
  const t1 = checkedAt(tokens, 1);
  const t2 = checkedAt(tokens, 2);
  if (t1.type !== 'word') return null;
  if (t2.type !== 'op' || !TOP_LEVEL_SPLIT_OPS.has(t2.text)) return null;
  // `cd -` moves to $OLDPWD, which this analysis cannot see — and it is not the
  // relative directory `./-` that the containment check would otherwise take it
  // for. Refuse, as {@link CdHandler.isSafe} does for a lone `cd -` segment.
  if (t1.text.startsWith('-')) return null;
  if (!pathAllowed(t1.text, ctx)) {
    if (outGrantable) {
      const target = cdTargetCwd(t1.text, ctx);
      const root = canonicalRoot(target, ctx.home);
      if (root) {
        outGrantable.grant = root;
        outGrantable.cwd = target;
        outGrantable.tokens = tokens.slice(3);
      }
    }
    return null;
  }
  ctx.cwd = cdTargetCwd(t1.text, ctx);
  return tokens.slice(3);
}

// ============================================================================
// Segmentation
// ============================================================================

/**
 * Split tokens at top-level operators in `splitOps`. Empty leading/trailing
 * segments are returned as empty arrays so callers can reject them.
 *
 * Group-aware: a separator INSIDE a subshell `( … )` or brace `{ …; }` group
 * does not split, so a whole group stays in one segment and the segment walker
 * can validate its interior recursively. Depth is tracked across `(`/`)` op
 * tokens and `{`/`}` word tokens.
 * @param {ShellToken[]} tokens tokens
 * @param {Set<string>} splitOps operators to split on
 * @param {string[]} [outOps] if provided, receives the operator text at each
 *   split boundary (length = returned segments − 1), so callers can tell which
 *   separator bounded an empty segment.
 * @returns {ShellToken[][]} segments
 */
function splitOnOps(tokens, splitOps, outOps) {
  /** @type {ShellToken[][]} */
  const out = [];
  let cur = /** @type {ShellToken[]} */ ([]);
  let depth = 0;
  for (const t of tokens) {
    if (groupOpenerText(t)) depth++;
    else if (groupCloserText(t) && depth > 0) depth--;

    if (depth === 0 && t.type === 'op' && splitOps.has(t.text)) {
      out.push(cur);
      if (outOps) outOps.push(t.text);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  out.push(cur);
  return out;
}

/**
 * Group-open token classifier: subshell `(` (op) or brace `{` (reserved word).
 * @param {ShellToken} t token
 * @returns {string|null} the opener char (`(` or `{`), or null if not an opener
 */
function groupOpenerText(t) {
  if (t.type === 'op' && t.text === '(') return '(';
  if (t.type === 'word' && t.text === '{') return '{';
  return null;
}

/**
 * Group-close token classifier: subshell `)` (op) or brace `}` (reserved word).
 * @param {ShellToken} t token
 * @returns {string|null} the closer char (`)` or `}`), or null if not a closer
 */
function groupCloserText(t) {
  if (t.type === 'op' && t.text === ')') return ')';
  if (t.type === 'word' && t.text === '}') return '}';
  return null;
}

/**
 * Given a segment whose first token opens a group, return the group's interior
 * token list — or `null` if it isn't a single balanced group occupying the
 * whole segment. The matching closer must be the LAST token (callers strip safe
 * trailing redirects/sinks first) and must be the right kind (`(`→`)`, `{`→`}`),
 * so a mismatched or trailing-junk group is rejected.
 * @param {ShellToken[]} tokens segment tokens (first token is a group opener)
 * @returns {ShellToken[] | null} interior tokens, or null
 */
function extractGroupInterior(tokens) {
  if (tokens.length === 0) return null;
  const opener = groupOpenerText(checkedAt(tokens, 0));
  if (!opener) return null;
  const wantCloser = opener === '(' ? ')' : '}';
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (groupOpenerText(checkedAt(tokens, i))) depth++;
    else if (groupCloserText(checkedAt(tokens, i))) {
      depth--;
      if (depth === 0) {
        if (i !== tokens.length - 1) return null; // trailing junk
        if (groupCloserText(checkedAt(tokens, i)) !== wantCloser) return null;
        return tokens.slice(1, i);
      }
    }
  }
  return null; // unbalanced
}

// ============================================================================
// Windows shape-check
// ============================================================================

/**
 * @param {ShellToken[]} tokens tokens
 * @returns {boolean} true if the tokens look POSIX-shaped on Windows
 */
function isWindowsPosixShaped(tokens) {
  for (const t of tokens) {
    if (t.type === 'op' && t.text === '&') return false;
    if (t.type === 'word') {
      if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(t.raw)) return false;
      if (/\\[A-Za-z0-9.\-_]/.test(t.raw) && !/^["'].*["']$/.test(t.raw)) return false;
    }
  }
  const firstWord = tokens.find(t => t.type === 'word');
  if (firstWord && WINDOWS_NATIVE_TOKENS.has(firstWord.text.toLowerCase())) return false;
  return true;
}

// ============================================================================
// Inline-redirect stripping (side-effect-free)
// ============================================================================

/**
 * Strip side-effect-free redirects from anywhere in the token stream:
 *   - `2>&1`                  — merge stderr into stdout
 *   - `> <strippable>`        — redirect stdout to /dev/null or an allowed path
 *   - `>> <strippable>`       — same, append
 *   - `2> <strippable>`       — redirect stderr to /dev/null or an allowed path
 *
 * `2>&1` never touches user-visible state. A `> FILE` redirect's only effect is
 * *where* output lands; it is stripped when the destination is inert
 * (`/dev/null`) or an allowed write target (see
 * {@link isStrippableRedirectTarget}). The command words themselves are still
 * validated separately, so stripping a redirect can never approve a command
 * that would otherwise be rejected — only relocate its output. Returns a new
 * token array.
 * @param {ShellToken[]} tokens tokens
 * @param {RedirectCfg} [cfg] redirect policy
 * @returns {ShellToken[]} tokens with safe redirects removed
 */
function stripInlineSafeRedirects(tokens, cfg = {}) {
  /** @type {ShellToken[]} */
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = checkedAt(tokens, i);
    if (t.type === 'op' && t.text === '2>&1') continue;
    if (t.type === 'op' && (t.text === '>' || t.text === '>>' || t.text === '2>')) {
      const next = checkedAt(tokens, i + 1);
      if (next && next.type === 'word' && isStrippableRedirectTarget(next.text, cfg)) {
        i++;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

// ============================================================================
// Segment validation
// ============================================================================

/**
 * @param {ShellToken[]} segTokens segment tokens
 * @returns {string} reconstructed segment text (raw)
 */
function reconstructSegment(segTokens) {
  let out = '';
  for (let i = 0; i < segTokens.length; i++) {
    const t = checkedAt(segTokens, i);
    const raw = t.type === 'word' ? t.raw : t.text;
    if (i > 0) out += ' ';
    out += raw;
  }
  return out;
}

/**
 * Env vars whose values can redirect or hijack command execution. Setting any
 * of these as an inline prefix (`VAR=value cmd ...`) is rejected — the cost of
 * being wrong is total: an attacker controls which binary actually runs.
 *
 * - `PATH` / `BASH_ENV` / `ENV` / `SHELLOPTS` — change command resolution.
 * - `LD_*` / `DYLD_*` — inject shared libraries at load time.
 * - `IFS` — change word-splitting of subsequent expansions.
 * - `NODE_OPTIONS` / `PYTHONSTARTUP` / `PERL5OPT` / `RUBYOPT` — interpreter-
 *   level code injection via flags or init files.
 * - `BASH_FUNC_*` — function-export smuggling (shellshock-shaped).
 * - `GLOBIGNORE` — alter pathname expansion semantics.
 */
const DANGEROUS_ENV_VAR_NAMES = new Set([
  'PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'NODE_OPTIONS',
  'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'GLOBIGNORE'
]);

/** Prefixes for env vars treated as dangerous (loader / function export). */
const DANGEROUS_ENV_VAR_PREFIXES = ['LD_', 'DYLD_', 'BASH_FUNC_'];

/**
 * Peel leading `NAME=value` env assignments off the segment. POSIX allows any
 * number of these before the command word. Returns null if any assignment
 * names a {@link DANGEROUS_ENV_VAR_NAMES} variable (or matches a dangerous
 * prefix) — the analyser refuses to reason about commands whose loader /
 * interpreter behaviour is being rewritten.
 * @param {ShellToken[]} segTokens segment tokens
 * @returns {ShellToken[] | null} tokens with env prefix stripped, or null if unsafe
 */
function stripEnvPrefix(segTokens) {
  let i = 0;
  while (i < segTokens.length) {
    const t = checkedAt(segTokens, i);
    if (t.type !== 'word') break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t.text);
    if (!m) break;
    const name = checkedAt(m, 1);
    if (DANGEROUS_ENV_VAR_NAMES.has(name)) return null;
    if (DANGEROUS_ENV_VAR_PREFIXES.some(p => name.startsWith(p))) return null;
    // `NAME=$(cmd) realcmd …` — an env-prefix value built from command
    // substitution. The substitution would run with the segment; we can't
    // vouch for it here (the pure-assignment path in validateSegmentSequence
    // is the only place a `NAME=$(…)` producer is vetted). Reject.
    if (/** @type {WordToken} */ (t).subst) return null;
    i++;
  }
  return i === 0 ? segTokens : segTokens.slice(i);
}

/**
 * If `text` is exactly a whole variable reference — `$NAME` or `${NAME}` with
 * nothing else — return NAME; else null. A partial reference (`pre$NAME`,
 * `$NAME.bak`) returns null: only a token that is ENTIRELY one variable can be
 * resolved to a single known value.
 * @param {string} text token text
 * @returns {string | null} the variable name, or null
 */
function wholeVarName(text) {
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  if (braced) return checkedAt(braced, 1);
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  return bare ? checkedAt(bare, 1) : null;
}

/**
 * Resolve an argument token to a concrete string using recorded provenance.
 * A whole-token `$NAME`/`${NAME}` with known provenance resolves to its literal
 * value, or — for an in-project-path producer — to a representative allowed
 * root (so the handler's in-project path check passes). Everything else (plain
 * text, unknown vars, partial references) returns the token's text unchanged.
 * @param {ShellToken} t token
 * @param {ApprovalCtx} ctx approval context
 * @returns {string} resolved argument text
 */
function resolveVarArg(t, ctx) {
  if (t.type !== 'word') return t.text;
  const name = wholeVarName(t.text);
  if (!name || !ctx.vars) return t.text;
  const prov = ctx.vars.get(name);
  if (!prov) return t.text;
  if (prov.kind === 'literal') return prov.value;
  if (prov.kind === 'inProjectPath' && Array.isArray(ctx.allowedRoots) && ctx.allowedRoots.length > 0) {
    return checkedAt(ctx.allowedRoots, 0);
  }
  return t.text;
}

/**
 * @param {ShellToken[]} segTokens segment tokens
 * @param {ApprovalCtx} ctx context
 * @returns {boolean} true if the segment is safe
 */
function isSegmentSafe(segTokens, ctx) {
  segTokens = stripInlineSafeRedirects(segTokens, ctx);
  segTokens = stripTrailingSafeSinks(segTokens, ctx);
  if (segTokens.length === 0) return false;
  const afterEnv = stripEnvPrefix(segTokens);
  if (afterEnv === null) return false;
  segTokens = afterEnv;
  if (segTokens.length === 0) return false;
  // Any leftover operator means the segment did something we didn't
  // understand (an unknown redirect, a pipe to something we don't trust,
  // a backgrounding `&`, ...). Reject.
  if (segTokens.some(t => t.type === 'op')) return false;

  // A command substitution `$(…)` survives here as a SUBST_SENTINEL in some
  // token's text plus a `subst` field. The ONLY position we vet a
  // substitution is the pure-assignment producer (`NAME=$(…)`), handled in
  // validateSegmentSequence before this function is ever reached. Any subst
  // reaching isSegmentSafe is therefore in an unvetted position — an argument
  // (`grep $(curl evil)`), the command head (`$(echo rm) -rf`), or an
  // env-prefix value — and must be rejected. Variable resolution of a *whole*
  // `$NAME` token (no subst field) is handled separately below.
  if (segTokens.some(t => t.type === 'word' && /** @type {WordToken} */ (t).subst)) return false;

  const head = /** @type {WordToken} */ (segTokens[0]);
  if (head.type !== 'word') return false;
  // An unquoted variable expansion in an ARGUMENT (`cmd $x`, `cmd a$x/b`) can
  // word-split and glob-expand at runtime into additional words or flags. The
  // builtin handlers below make fine-grained, value-specific decisions (which
  // paths are in-project, which flags are read-only), so a runtime value they
  // cannot see could subvert them — a handler must never approve a segment that
  // carries an unresolved unquoted expansion in its arguments. Such a segment
  // can still be approved by an explicit user glob pattern (below): a `<cmd> *`
  // grant is a deliberate blanket trust of that command, and word-splitting
  // stays within its arguments — it cannot change the literal command head or
  // inject a shell operator (both fixed at parse time, before expansion), so
  // matching the literal command text is sound. A double-quoted expansion
  // (`"$x"`) does not word-split and is NOT marked, so it still resolves through
  // the handler via recorded provenance.
  const hasUnquotedVarArg = segTokens.slice(1).some(
    t => t.type === 'word' && /** @type {WordToken} */ (t).unquotedVar);
  const handler = COMMAND_HANDLERS.get(head.text);
  if (handler && !hasUnquotedVarArg) {
    // Resolve whole-token variable references (`"$f"` → text `$f`, `"${f}"` →
    // `${f}`) in the ARGUMENTS against recorded provenance: a literal var
    // becomes its captured value; an in-project-path var becomes a
    // representative allowed root (so the handler's in-project path check
    // passes). The head is never resolved — a variable can't become the
    // command name. Unknown vars and partial references (`pre$f`) keep their
    // `$`-bearing text and are rejected by the handler's own path checks.
    const args = /** @type {WordToken[]} */ (segTokens.slice(1)).map(t => resolveVarArg(t, ctx));
    if (handler.isSafe(args, ctx)) return true;
    if (typeof handler.outOfRootPaths === 'function') {
      const outOfRoot = handler.outOfRootPaths(args, ctx);
      /** @type {string[]} */
      const roots = [];
      for (const p of outOfRoot) {
        // Against the working directory, so a path written `../../elsewhere`
        // is recognised as the out-of-root read it is — the same refusal the
        // absolute spelling of that path gets.
        const root = canonicalRoot(resolveAgainstCwd(p, ctx.cwd || '', ctx.platform), ctx.home);
        if (root) roots.push(root);
      }
      if (outOfRoot.length > 0 && roots.length === outOfRoot.length) {
        const augmented = { ...ctx, allowedRoots: [...(ctx.allowedRoots || []), ...roots] };
        if (handler.isSafe(args, augmented)) return false;
      }
    }
  }

  const cmdStr = reconstructSegment(segTokens);
  for (const p of ctx.patterns || []) {
    if (matchesGlob(p, cmdStr)) return true;
  }
  return false;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Decide whether `command` is safe to auto-approve.
 * @param {string} command command string
 * @param {object} [opts] options
 * @param {string} [opts.platform] 'darwin', 'linux', or 'windows' (default 'darwin')
 * @param {string[]} [opts.allowedRoots] filesystem roots the LLM may read under (default [])
 * @param {string} [opts.home] backend user-home dir for resolving `~/...` (default '')
 * @param {string[]} [opts.patterns] user-configured enabled glob patterns (default [])
 * @param {boolean} [opts.writeEnabled] file-writing permission is on for this conversation (default false)
 * @param {string} [opts.cwd] absolute directory the command runs in (default '')
 * @returns {boolean} true to auto-approve
 */
export function isCommandAutoApproved(command, opts = {}) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return false;

  const platform = opts.platform || 'darwin';
  const allowedRoots = opts.allowedRoots || [];
  const patterns = opts.patterns || [];
  const writeEnabled = Boolean(opts.writeEnabled);
  const home = opts.home || '';
  const cwd = normaliseCwd(opts.cwd, platform);

  if (platform === 'windows' && !isWindowsPosixShaped(tokens)) return false;

  const ctx = { platform, home, allowedRoots, patterns, writeEnabled, cwd, vars: new Map() };

  let working = stripTrailingSafeSinks(tokens, ctx);
  const afterCd = stripLeadingSafeCd(working, ctx);
  if (afterCd === null) return false;
  working = afterCd;
  if (working.length === 0) return false;

  /** @type {string[]} */
  const seps = [];
  const segments = splitOnOps(working, TOP_LEVEL_SPLIT_OPS, seps);
  // A dangling `&&`/`||` (empty operand on either side, e.g. `pwd &&`) is a
  // malformed compound command we can't fully reason about — reject it rather
  // than skip the empty segment. Empty segments bounded only by `;` (the
  // residue of comment/blank lines around a synthesized separator) stay benign
  // and are skipped by validateSegmentSequence.
  for (let k = 0; k < seps.length; k++) {
    const op = checkedAt(seps, k);
    if ((op === '&&' || op === '||')
        && (checkedAt(segments, k).length === 0 || checkedAt(segments, k + 1).length === 0)) {
      return false;
    }
  }
  return validateSegmentSequence(segments, ctx);
}

// ============================================================================
// Catastrophic-deletion floor (auto-approve blast-radius guard)
// ============================================================================

/**
 * Resolve a single `rm` target argument to a comparable absolute POSIX path, or
 * null when it cannot be pinned to a concrete location. `$HOME`/`${HOME}` is the
 * one expansion we resolve (a common, catastrophic-radius way to name the home
 * dir); every OTHER shell expansion (`$VAR`, `$(…)`, backticks) and every
 * unexpanded glob (`*`, `?`, `[`) returns null and is deliberately left to the
 * probabilistic reviewer rather than judged here. `~`/`~/x` expand against
 * `home`; a relative target resolves against the effective `cwd`; `.`/`./`
 * collapse to `cwd`.
 *
 * `fold` is applied after the expansions and before the rooted/relative
 * decision, so a Windows drive path is rooted by the time that decision is made
 * — and `$HOME` is still recognised in the spelling the shell would.
 * @param {string} text raw target token text
 * @param {{home: string, cwd: string, fold?: (p: string) => string}} ctx resolution context
 * @returns {string|null} normalised absolute path (POSIX, no trailing slash), or null
 */
function resolveDeletionTarget(text, { home, cwd, fold = (p) => p }) {
  if (!text) return null;
  let p = text;
  if (p === '$HOME' || p === '${HOME}') {
    if (!home) return null;
    p = home;
  } else if (p.includes('$') || p.includes('`') || p.includes(SUBST_SENTINEL)) {
    return null; // unresolved shell expansion — reviewer's call
  } else if (p.includes('*') || p.includes('?') || p.includes('[')) {
    return null; // unexpanded glob (`rm -rf *`) — explicitly out of floor scope
  }
  if (p === '~' || p === '~/') {
    if (!home) return null;
    p = home;
  } else if (p.startsWith('~/')) {
    if (!home) return null;
    p = (home.endsWith('/') ? home.slice(0, -1) : home) + '/' + p.slice(2);
  }
  p = fold(p);
  if (!p.startsWith('/')) {
    p = (cwd.endsWith('/') ? cwd.slice(0, -1) : cwd) + '/' + p;
  }
  return posixNormalize(p);
}

/**
 * Detect a recursive/forced `rm` whose resolved target is a *catastrophic
 * radius*: the project root itself, an ancestor of it, the user's home dir (or
 * an ancestor of it), or a filesystem root / bare top-level (`/`, `/usr`, …).
 *
 * This is the deterministic floor beneath the auto-approve reviewer. Such a
 * deletion is the one class that must never be *silently* auto-approved, so a
 * probabilistic "this looks like scratch" allow can't delete the project — or
 * more — out from under the user (the incident: `rm -fr /home/crem/tmp/juggler/`
 * read as safe because the path contained `tmp`). It only ever ADDS a human
 * prompt; a false positive costs one approval, and the human (or YOLO) can still
 * proceed.
 *
 * It is NOT a general destructive classifier. A recursive delete of a genuine
 * subdir, `node_modules`, `./build`, or any scratch tree resolves below the
 * project root, returns false, and flows through the reviewer exactly as before
 * — long unsupervised runs keep their `rm -rf` latitude. Unexpanded globs
 * (`rm -rf *`) and shell expansions other than `$HOME` are left unresolved (also
 * false), by design the reviewer's job.
 * @param {string} command the command string
 * @param {object} [opts] options
 * @param {string} [opts.platform] 'darwin' | 'linux' | 'windows' (default 'darwin')
 * @param {string} [opts.home] backend user-home dir
 * @param {string} [opts.projectRoot] absolute project root (the effective cwd)
 * @param {string} [opts.cwd] effective cwd override (default: projectRoot)
 * @returns {boolean} true if a recursive/forced delete targets a catastrophic radius
 */
export function isCatastrophicDeletion(command, opts = {}) {
  if (!command || typeof command !== 'string') return false;
  const platform = opts.platform || 'darwin';
  const home = opts.home || '';
  const projectRoot = opts.projectRoot || '';
  // Without a known project root there is no radius to protect — leave the whole
  // decision to the reviewer.
  if (!projectRoot) return false;

  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) return false;

  // Every Windows spelling of a directory — native `C:\proj`, forward-slash
  // `C:/proj`, MSYS `/c/proj` — folds to one comparable `/c/proj`, case included
  // (Windows filesystems are case-insensitive). Both sides go through it, so a
  // delete matches the tree it names however either was written, and a drive
  // path arrives rooted rather than looking relative.
  const fold = (/** @type {string} */ p) =>
    platform === 'windows' ? windowsToComparable(p) : p;
  const stripSlash = (/** @type {string} */ p) =>
    p.endsWith('/') && p !== '/' ? p.slice(0, -1) : p;
  const canon = (/** @type {string} */ p) => posixNormalize(stripSlash(fold(p)));
  const R = canon(projectRoot);
  const H = home ? canon(home) : '';

  /**
   * The paths a word could be naming. Ordinarily the one the shell will pass to
   * `rm` — but a POSIX shell eats an unquoted backslash, so on Windows
   * `rm -rf C:\proj` arrives here as the meaningless word `C:proj` and the tree
   * it plainly names would be measured against nothing. The word as written is
   * read as a second spelling, every `\` taken for a separator.
   *
   * The bias is the floor's: a spelling that was never a path costs one approval
   * prompt, and the model is told the project path in that native form, so it is
   * the spelling a delete of the project is most likely to arrive in.
   *
   * Order decides which reading a `cd` walks, so it goes by what the word opens
   * with. A drive letter makes it a path and nothing else — the shell's reading
   * of `C:\proj` is `C:proj`, which names nowhere. Anything else keeps the
   * shell's reading first: `my\ file` is an escaped space far more often than a
   * directory called `my/ file`.
   * @param {WordToken} w word token
   * @returns {string[]} the paths to judge this word as, best reading first
   */
  const spellingsOf = (w) => {
    if (platform !== 'windows' || !w.raw.includes('\\')) return [w.text];
    const written = w.raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
    return /^[A-Za-z]:[\\/]/.test(written) ? [written, w.text] : [w.text, written];
  };

  /**
   * Is `anc` at or above `desc` in the tree (equal, or a strict ancestor)?
   * @param {string} anc ancestor candidate
   * @param {string} desc descendant candidate
   * @returns {boolean} true if `desc` is `anc` or nested under it
   */
  const isAtOrAbove = (anc, desc) => desc === anc || desc.startsWith(anc + '/');

  const segments = splitOnOps(tokens, TOP_LEVEL_SPLIT_OPS);
  // Effective cwd, adjusted by a leading `cd` chain. Defaults to the project
  // root; an explicit `opts.cwd` overrides it.
  let cwd = opts.cwd ? canon(opts.cwd) : R;

  for (const seg of segments) {
    const words = /** @type {WordToken[]} */ (seg.filter((t) => t.type === 'word'));
    if (words.length === 0) continue;
    const head = checkedAt(words, 0).text;

    // Track `cd` so a relative `rm` target after `cd sub` resolves correctly.
    if (head === 'cd') {
      const arg = words.slice(1).find((w) => !w.text.startsWith('-'));
      if (arg) {
        for (const spelling of spellingsOf(arg)) {
          const resolved = resolveDeletionTarget(spelling, { home: H, cwd, fold });
          if (resolved) { cwd = resolved; break; }
        }
      }
      continue;
    }

    if (head !== 'rm') continue;

    // Recursive (-r/-R/--recursive) OR force (-f/--force) — either is enough; a
    // false positive only adds one approval prompt. Everything after `--` is a
    // target, not an option.
    let recursiveOrForce = false;
    let optionsEnded = false;
    /** @type {WordToken[]} */
    const targets = [];
    for (let k = 1; k < words.length; k++) {
      const word = checkedAt(words, k);
      const w = word.text;
      if (!optionsEnded && w === '--') { optionsEnded = true; continue; }
      if (!optionsEnded && w.startsWith('--')) {
        if (w === '--recursive' || w === '--force') recursiveOrForce = true;
        continue;
      }
      if (!optionsEnded && w.length > 1 && w.startsWith('-')) {
        if (/[rRf]/.test(w.slice(1))) recursiveOrForce = true;
        continue;
      }
      targets.push(word);
    }
    if (!recursiveOrForce) continue;

    for (const t of targets) {
      for (const spelling of spellingsOf(t)) {
        const T = resolveDeletionTarget(spelling, { home: H, cwd, fold });
        if (!T) continue;
        const segs = T.split('/').filter(Boolean);
        if (T.startsWith('/') && segs.length < 2) return true; // `/` or a bare top-level
        if (isAtOrAbove(T, R)) return true;      // project root or an ancestor of it
        if (H && isAtOrAbove(T, H)) return true; // home dir or an ancestor of it
      }
    }
  }
  return false;
}

/**
 * Upper bound on the length of a glob pattern we will *suggest*. Past this a
 * pattern is almost always the verbatim text of one long command — too
 * specific to ever match a future command, so offering it as "don't ask again"
 * is noise. The exact-segment tier is the only tier that can exceed this (the
 * `<cmd> *` / `git <sub> *` generalisations are always short), so the cap
 * simply drops the over-long exact tier and keeps the useful wildcard tiers.
 * It does not restrict what a user can save explicitly — only what we propose.
 */
export const MAX_SUGGESTED_PATTERN_LENGTH = 150;

/**
 * @typedef {object} SegmentRemedy
 * @property {string[]} globs glob patterns narrowest→broadest that cover the
 *   segment via the analyser's pattern fallback: the exact text, then handler
 *   generalisations / `<cmd> *` — EXCEPT the wildcard generalisations are
 *   withheld when an out-of-root path is the segment's sole obstacle (a wildcard
 *   would drop the in-root-path restriction that was violated), leaving exact only.
 * @property {string[]} paths absolute folders to grant (add to the allowed-paths
 *   list) that, by themselves, make the segment safe — empty when the segment is
 *   not rejected purely because of out-of-root path arguments.
 */

/**
 * Normalise a rejected segment exactly as {@link isSegmentSafe} does, then
 * derive the remedies that would make it pass: glob patterns (always) and, when
 * the segment is rejected purely because path arguments sit outside the allowed
 * roots, the folders to grant instead.
 *
 * The path-grant remedy is verified, not assumed: the head handler nominates
 * candidate out-of-root paths, they're resolved to absolute roots, and the
 * segment is re-checked with those roots added — only a segment that then
 * passes yields a grant. So a command rejected for any *other* reason (a
 * forbidden `find -exec`, an unparseable flag) gets globs only.
 *
 * Returns `null` when no remedy could ever cover the segment — a leftover
 * operator token (e.g. a non-`/dev/null` write redirect), a dangerous env
 * prefix, or an empty segment. The analyser rejects those before the glob
 * fallback runs, so no suggestion is honest.
 * @param {ShellToken[]} seg segment tokens
 * @param {Set<string>} interpreters heads that must never be wildcarded
 * @param {ApprovalCtx} cfg approval context (allowedRoots + writeEnabled + home)
 * @returns {SegmentRemedy | null} remedies, or null if uncoverable
 */
function segmentRemedies(seg, interpreters, cfg) {
  seg = stripInlineSafeRedirects(seg, cfg);
  seg = stripTrailingSafeSinks(seg, cfg);
  if (seg.length === 0) return null;
  const afterEnv = stripEnvPrefix(seg);
  if (afterEnv === null) return null;
  seg = afterEnv;
  if (seg.length === 0) return null;
  // A remedy can only cover a segment with no leftover operator tokens;
  // isSegmentSafe bails on those before ever consulting the pattern list.
  if (seg.some(t => t.type === 'op')) return null;

  const head = /** @type {WordToken} */ (checkedAt(seg, 0));
  if (head.type !== 'word') return null;

  const globs = [reconstructSegment(seg)];
  const handler = COMMAND_HANDLERS.get(head.text);

  // Path-grant remedy + sole-obstacle detection. Ask the handler which path
  // arguments are out-of-root, then grant exactly those (the raw paths) and
  // re-check: if the segment becomes safe, an out-of-root path is its SOLE
  // obstacle. That decides two things:
  //   - `paths`: when every such path ALSO canonicalises to a grantable root,
  //     offer a folder grant (the targeted fix). A non-grantable path (`/`, a
  //     bare top-level, the home dir) or a mix leaves paths empty, so the caller
  //     falls back to the exact-segment glob.
  //   - `pathIsSoleObstacle`: when true, the `<cmd> *` wildcard tier is withheld
  //     below — generalising the command would drop the very in-root-path
  //     restriction that was violated (and for a handler with its own safety
  //     grammar, e.g. find's -delete/-exec, a `find *` rule would blanket-approve
  //     the forms it forbids). The exact segment is still offered.
  // Anything else (a non-path obstacle — a forbidden predicate, an unparseable
  // flag) leaves both untouched, so the caller offers the usual glob tiers.
  /** @type {string[]} */
  let paths = [];
  let pathIsSoleObstacle = false;
  if (handler && typeof handler.outOfRootPaths === 'function') {
    const args = /** @type {WordToken[]} */ (seg.slice(1)).map(t => t.text);
    const candidates = handler.outOfRootPaths(args, cfg) || [];
    if (candidates.length > 0) {
      // Resolve against the working directory before granting anything: a grant
      // is stored as an absolute path, and `../../elsewhere` names a real folder
      // only once you know where the command is standing. The probe grants the
      // resolved form for the same reason — an escaping relative path can never
      // be a root, so probing with the raw argument would always fail and the
      // segment would be written off as unfixable by a grant.
      const resolved = candidates.map(p => resolveAgainstCwd(p, cfg.cwd || '', cfg.platform));
      const probe = { ...cfg, allowedRoots: [...(cfg.allowedRoots || []), ...resolved] };
      if (isSegmentSafe(seg, probe)) {
        pathIsSoleObstacle = true;
        const roots = /** @type {string[]} */ (resolved.map(p => canonicalRoot(p, cfg.home)).filter(Boolean));
        if (roots.length === resolved.length) paths = roots;
      }
    }
  }

  // Interpreters (bash, python, node, …) are too dangerous to wildcard — a
  // `bash *` rule would auto-approve arbitrary scripts. Offer the exact form
  // only, matching ExecuteContextItem.extractDefaultPattern's policy.
  if (interpreters.has(head.text)) return { globs, paths };

  // Out-of-root path is the sole obstacle: a `<cmd> *` wildcard is dishonest
  // (it drops the path restriction that was violated), so offer the exact
  // segment only — plus the folder grant above when one is grantable.
  if (pathIsSoleObstacle) return { globs, paths };

  const words = /** @type {WordToken[]} */ (seg).map(t => t.text);
  const generalisations = handler && typeof handler.suggestPatterns === 'function'
    ? handler.suggestPatterns(words)
    : [`${head.text} *`];
  for (const g of generalisations) {
    if (!globs.includes(g)) globs.push(g);
  }
  return { globs, paths };
}

/**
 * Suggest the minimal auto-approval remedies that would let `command`
 * auto-approve, as an ordered list of escalating-breadth choices.
 *
 * Reuses the {@link isCommandAutoApproved} decomposition: strips safe sinks and
 * a leading in-project `cd`, splits on top-level `&&`/`||`/`;`, and for each
 * segment the analyser would still reject derives its remedies (see
 * {@link segmentRemedies}). Two kinds of suggestion come out:
 *   - a single **path grant** (`{allowedPaths}`) — offered first, and only when
 *     EVERY rejected segment is rejected purely because path arguments fall
 *     outside the allowed roots. Granting those folders keeps the command-shape
 *     restriction while letting the command read where it needs to — the right
 *     answer for `grep -r … ~/elsewhere` / `find ~/elsewhere …`, far better than
 *     a `grep *` wildcard. A leading `cd` to a grantable folder outside the
 *     roots contributes its target to the same grant, so `cd ~/elsewhere && ls`
 *     offers the one folder that fixes it rather than nothing at all.
 *   - **glob patterns** (`{patterns}`) — escalating breadth, one pattern per
 *     rejected segment combined per tier, as before.
 *
 * Returns `[]` (caller should fall back to an exact whole-command rule) when:
 *   - the command already auto-approves — nothing to suggest;
 *   - it can't be statically decomposed into clean segments — command
 *     substitution, control flow, a dangerous env prefix, or a segment with a
 *     leftover operator;
 *   - a leading `cd` escapes the allowed roots to somewhere no folder grant can
 *     reach: a bare `cd` (→ $HOME), `cd -`, `cd ~`, or a target carrying a shell
 *     expansion.
 * @param {string} command command string
 * @param {object} [opts] options
 * @param {string} [opts.platform] 'darwin', 'linux', or 'windows' (default 'darwin')
 * @param {string[]} [opts.allowedRoots] filesystem roots the LLM may read under (default [])
 * @param {string} [opts.home] backend user-home dir for resolving `~/...` (default '')
 * @param {string[]} [opts.patterns] already-enabled glob patterns (default [])
 * @param {Set<string>|string[]} [opts.interpreters] heads that must never be wildcarded (default none)
 * @param {boolean} [opts.writeEnabled] file-writing permission is on for this conversation (default false)
 * @param {string} [opts.cwd] absolute directory the command runs in (default '')
 * @returns {Array<{patterns?: string[], allowedPaths?: string[]}>} escalating suggestions, narrowest first
 */
export function suggestApprovalPatterns(command, opts = {}) {
  if (!command || typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed) return [];

  const platform = opts.platform || 'darwin';
  const allowedRoots = opts.allowedRoots || [];
  const patterns = opts.patterns || [];
  const writeEnabled = Boolean(opts.writeEnabled);
  const home = opts.home || '';
  const cwd = normaliseCwd(opts.cwd, platform);
  const interpreters = opts.interpreters instanceof Set
    ? opts.interpreters
    : new Set(opts.interpreters || []);

  // Already approved → nothing to suggest.
  if (isCommandAutoApproved(trimmed, { platform, home, allowedRoots, patterns, writeEnabled, cwd })) return [];

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return [];
  if (platform === 'windows' && !isWindowsPosixShaped(tokens)) return [];
  // A command substitution has no honest minimal glob — its raw text carries a
  // SUBST_SENTINEL placeholder, and a variable it feeds resolves only at
  // analysis time. Bail so the caller falls back to an exact whole-command rule.
  if (tokens.some(t => t.type === 'word' && /** @type {WordToken} */ (t).subst)) return [];

  const ctx = { platform, home, allowedRoots, patterns, writeEnabled, cwd, vars: new Map() };

  let working = stripTrailingSafeSinks(tokens, ctx);
  // A leading `cd` to a grantable folder outside the roots is fixable by
  // granting that folder, so it is analysed rather than refused: the grant joins
  // the roots and the rest of the command is judged standing in that directory —
  // the state the command would run in once the user says yes. Every other
  // leading-`cd` refusal has no honest remedy, so there is nothing to suggest.
  /** @type {{grant?: string, cwd?: string, tokens?: ShellToken[]}} */
  const cdGrantable = {};
  const afterCd = stripLeadingSafeCd(working, ctx, cdGrantable);
  /** @type {string[]} folders the leading `cd` alone requires */
  const cdGrants = [];
  if (afterCd === null) {
    if (!cdGrantable.grant || !cdGrantable.tokens) return [];
    cdGrants.push(cdGrantable.grant);
    ctx.allowedRoots = [...allowedRoots, cdGrantable.grant];
    ctx.cwd = cdGrantable.cwd || ctx.cwd;
    working = cdGrantable.tokens;
  } else {
    working = afterCd;
  }
  if (working.length === 0) return [];

  const segments = splitOnOps(working, TOP_LEVEL_SPLIT_OPS);

  /** @type {SegmentRemedy[]} one remedy per rejected segment */
  const perSegment = [];
  for (const seg of segments) {
    // Empty segment (comment/blank line around a synthesized `;`): no command,
    // so no remedy to suggest — skip it rather than bailing to a whole-command
    // rule, so a leading/trailing comment doesn't coarsen the suggestion.
    if (seg.length === 0) continue;
    // Control flow and grouped commands are too complex to suggest
    // minimal patterns for; bail (caller falls back to an exact rule).
    const head = checkedAt(seg, 0);
    if (groupOpenerText(head)) return [];
    if (head.type === 'word'
				&& (FLOW_OPENERS.has(/** @type {WordToken} */ (head).text)
					|| FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (head).text))) {
      return [];
    }
    if (isSegmentSafe(seg, ctx)) continue;
    const rem = segmentRemedies(seg, interpreters, ctx);
    if (!rem) return [];
    perSegment.push(rem);
  }
  // Nothing left to fix and no folder to grant → nothing to suggest. A leading
  // `cd` grant counts on its own: once that folder is allowed, every segment
  // after it may well be safe already, and the grant IS the whole suggestion.
  if (perSegment.length === 0 && cdGrants.length === 0) return [];

  /** @type {Array<{patterns?: string[], allowedPaths?: string[]}>} */
  const suggestions = [];

  // Path-grant suggestion (narrowest, most targeted): only when EVERY rejected
  // segment is fixable purely by granting out-of-root folders, so one grant
  // makes the whole command pass while keeping its command-shape restriction.
  // Union the folders across segments, deduped, preserving first-seen order.
  if (perSegment.every(r => r.paths.length > 0)) {
    /** @type {string[]} */
    const allowedPaths = [];
    const within = new Set();
    for (const p of cdGrants) {
      if (!within.has(p)) { within.add(p); allowedPaths.push(p); }
    }
    for (const r of perSegment) {
      for (const p of r.paths) {
        if (!within.has(p)) { within.add(p); allowedPaths.push(p); }
      }
    }
    if (isCommandAutoApproved(trimmed, { platform, home, allowedRoots: [...allowedRoots, ...allowedPaths], patterns, writeEnabled, cwd })) {
      suggestions.push({ allowedPaths });
    }
  }

  // Glob-pattern suggestions: combine across segments into escalating tiers. At
  // tier t each segment contributes its tier-t glob (clamped to its broadest),
  // deduped within the suggestion; identical suggestions collapse.
  const perSegmentTiers = perSegment.map(r => r.globs);
  const maxTiers = Math.max(...perSegmentTiers.map(t => t.length));
  const seen = new Set();
  for (let t = 0; t < maxTiers; t++) {
    /** @type {string[]} */
    const combined = [];
    const within = new Set();
    for (const tiers of perSegmentTiers) {
      const p = checkedAt(tiers, Math.min(t, tiers.length - 1));
      if (!within.has(p)) { within.add(p); combined.push(p); }
    }
    // Skip a tier whose any pattern is too long to be a useful suggestion
    // (the verbatim exact-command tier). Broader tiers survive; a segment
    // whose every tier is over-long — e.g. a long interpreter command with
    // no wildcard generalisation — drops out entirely, leaving [].
    if (combined.some(p => p.length > MAX_SUGGESTED_PATTERN_LENGTH)) continue;
    const key = combined.join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isCommandAutoApproved(trimmed, { platform, home, allowedRoots, patterns: [...patterns, ...combined], writeEnabled, cwd })) continue;
    suggestions.push({ patterns: combined });
  }
  return suggestions;
}

/**
 * If `seg` is a single pure assignment word — `NAME=value` or `NAME=$(cmd)`
 * with nothing else in the segment — return its name and token. A segment like
 * `NAME=value cmd …` (assignment followed by a command) is NOT a pure
 * assignment: it's an env-prefixed command handled by {@link stripEnvPrefix}.
 * @param {ShellToken[]} seg segment tokens
 * @returns {{name: string, token: WordToken} | null} parsed assignment, or null
 */
function parsePureAssignment(seg) {
  if (seg.length !== 1) return null;
  const t = checkedAt(seg, 0);
  if (t.type !== 'word') return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t.text);
  if (!m) return null;
  return { name: checkedAt(m, 1), token: /** @type {WordToken} */ (t) };
}

/**
 * Determine the output-path domain of a command-substitution producer — the
 * inner command of a `NAME=$(inner)` assignment. Returns `'inProjectPath'` only
 * when BOTH hold:
 *   1. `inner` auto-approves on its own as a read-only, in-project command; and
 *   2. it decomposes to a single producing segment whose head handler declares
 *      (via {@link CommandHandler.outputPathDomain}) that its stdout is a list
 *      of in-project filesystem paths (`grep -l`, `git ls-files`, `find`).
 * Otherwise null — the substitution's output provenance is unknown, so the
 * variable it feeds must not satisfy a path argument. Pipelines / multi-segment
 * inners are conservatively rejected (we can't point at one producer).
 * @param {string} inner inner command text of the substitution
 * @param {ApprovalCtx} ctx approval context
 * @returns {'inProjectPath' | null} output domain, or null if unknown
 */
function substOutputDomain(inner, ctx) {
  const innerOpts = {
    platform: ctx.platform, home: ctx.home, allowedRoots: ctx.allowedRoots,
    patterns: ctx.patterns, writeEnabled: ctx.writeEnabled, cwd: ctx.cwd
  };
  if (!isCommandAutoApproved(inner, innerOpts)) return null;

  const tokens = tokenize(inner);
  if (!tokens || tokens.length === 0) return null;
  let working = stripTrailingSafeSinks(tokens, ctx);
  const afterCd = stripLeadingSafeCd(working, ctx);
  if (afterCd === null) return null;
  working = afterCd;
  const segs = splitOnOps(working, TOP_LEVEL_SPLIT_OPS).filter(s => s.length > 0);
  if (segs.length !== 1) return null; // single producer only

  let seg = stripInlineSafeRedirects(checkedAt(segs, 0), ctx);
  seg = stripTrailingSafeSinks(seg, ctx);
  const afterEnv = stripEnvPrefix(seg);
  if (afterEnv === null) return null;
  seg = afterEnv;
  if (seg.length === 0 || seg.some(t => t.type === 'op')) return null;

  const head = checkedAt(seg, 0);
  if (head.type !== 'word') return null;
  const handler = COMMAND_HANDLERS.get(/** @type {WordToken} */ (head).text);
  if (!handler || typeof handler.outputPathDomain !== 'function') return null;
  const args = /** @type {WordToken[]} */ (seg.slice(1)).map(t => t.text);
  return handler.outputPathDomain(args, ctx);
}

/**
 * Validate a single pure assignment (`NAME=value` / `NAME=$(cmd)`) and record
 * its provenance in `ctx.vars`. Rejects dangerous variable names (same policy
 * as {@link stripEnvPrefix}); for a substitution value, requires a single
 * whole-value `$(…)` whose producer has a known in-project output domain.
 * @param {{name: string, token: WordToken}} assign parsed assignment
 * @param {ApprovalCtx} ctx approval context
 * @returns {boolean} true if the assignment is safe and was recorded
 */
function recordAssignment(assign, ctx) {
  const { name, token } = assign;
  if (DANGEROUS_ENV_VAR_NAMES.has(name)) return false;
  if (DANGEROUS_ENV_VAR_PREFIXES.some(p => name.startsWith(p))) return false;
  const value = token.text.slice(name.length + 1);
  if (token.subst) {
    // Must be exactly `NAME=$(cmd)`: the value is the sentinel alone (no
    // literal text fused around it like `NAME=pre$(cmd)post`, whose result
    // we can't characterise) and exactly one substitution.
    if (value !== SUBST_SENTINEL || token.subst.length !== 1) return false;
    const domain = substOutputDomain(checkedAt(token.subst, 0), ctx);
    if (!domain) return false;
    if (!ctx.vars) ctx.vars = new Map();
    ctx.vars.set(name, { kind: domain });
    return true;
  }
  // Literal value (no substitution; the subst guard guarantees no sentinel).
  if (!ctx.vars) ctx.vars = new Map();
  ctx.vars.set(name, { kind: 'literal', value });
  return true;
}

/** Keywords that open a control-flow block ending in `done` or `fi`. */
const FLOW_OPENERS = new Set(['for', 'while', 'until', 'if']);

/** Body-introducer keywords stripped from the head of a body segment. */
const FLOW_BODY_INTRODUCERS = new Set(['do', 'then', 'else']);

/**
 * Walk a sequence of `;`/`&&`/`||`-separated segments with control-flow
 * awareness. Recognises POSIX `for VAR in WORDS; do …; done`, `while CMD; do
 * …; done`, `until CMD; do …; done`, and `if CMD; then …; [elif CMD; then …;]
 * [else …;] fi` blocks; the body is itself validated as a segment sequence
 * (so loops nest). Body segments may have a leading `do`/`then`/`else`
 * keyword which is peeled before validation.
 *
 * Any segment that doesn't open a block is validated as a normal command via
 * {@link isSegmentSafe}.
 *
 * A lone `cd <path>` segment moves the working directory recorded on `ctx`, so
 * the segments after it are judged where they will actually run (see
 * {@link applyCdSegment}). The walk assumes each `cd` it passes is reached and
 * succeeds — a static analyser cannot know whether the directory exists, and
 * that assumption is weaker than ones this containment check already makes: it
 * is lexical, so a symlink inside an allowed root already points wherever it
 * likes. A `cd` reached only through a `||` branch or a loop body is followed on
 * the same terms. The one construct whose directory change genuinely cannot
 * escape is a subshell, which is honoured below.
 * @param {ShellToken[][]} segments segments to validate
 * @param {ApprovalCtx} ctx context
 * @returns {boolean} true if every segment (and every body of every block) is safe
 */
function validateSegmentSequence(segments, ctx) {
  let i = 0;
  while (i < segments.length) {
    let seg = checkedAt(segments, i);
    // An empty segment carries no command to run — it is the residue of a
    // comment line or blank line around a synthesized `;` separator (or a
    // degenerate `;;` / `; ;`). Nothing to validate; skip it. It can never be
    // unsafe, so skipping (rather than rejecting) is security-neutral.
    if (seg.length === 0) { i++; continue; }

    // Peel leading body-introducer keyword (`do`, `then`, `else`) so the
    // segment that follows e.g. `do` can be validated as a normal command.
    if (checkedAt(seg, 0).type === 'word' && FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (checkedAt(seg, 0)).text)) {
      seg = seg.slice(1);
      if (seg.length === 0) { i++; continue; }
    }

    // Pure assignment (`NAME=value` / `NAME=$(cmd)`). Validate it and record
    // its provenance in ctx.vars so later segments can resolve `"$NAME"`.
    // This is the ONLY place a command substitution is vetted; isSegmentSafe
    // rejects subst everywhere else.
    const assign = parsePureAssignment(seg);
    if (assign) {
      if (!recordAssignment(assign, ctx)) return false;
      i++;
      continue;
    }

    // Grouped command: subshell `( … )` or brace `{ …; }`. Grouping confers
    // no new capability, so the group is safe iff its contents are. Strip
    // any safe trailing redirects/sinks (`( … ) >/dev/null`, `{ …; } 2>&1`),
    // then require the segment to be exactly one balanced group and validate
    // its interior as its own command sequence.
    //
    // A subshell runs in its own process: a `cd` (or an assignment) inside it
    // dies with the subshell, so its interior is validated against a copy of the
    // context and the segments after `( … )` still run in the directory the
    // group started from. A brace group runs in the current shell, where both do
    // persist, so it shares the context.
    const opener = groupOpenerText(checkedAt(seg, 0));
    if (opener) {
      let g = stripInlineSafeRedirects(seg, ctx);
      g = stripTrailingSafeSinks(g, ctx);
      const inner = extractGroupInterior(g);
      if (inner === null) return false;
      const innerSegs = splitOnOps(inner, TOP_LEVEL_SPLIT_OPS).filter(s => s.length > 0);
      if (innerSegs.length === 0) return false;
      const innerCtx = opener === '(' ? { ...ctx, vars: new Map(ctx.vars) } : ctx;
      if (!validateSegmentSequence(innerSegs, innerCtx)) return false;
      i++;
      continue;
    }

    const head = checkedAt(seg, 0);
    if (head.type === 'word' && FLOW_OPENERS.has(/** @type {WordToken} */ (head).text)) {
      const opener = /** @type {WordToken} */ (head).text;
      const terminator = opener === 'if' ? 'fi' : 'done';

      // Validate the opener's header.
      if (opener === 'for') {
        if (!validateForHeader(seg.slice(1))) return false;
      } else {
        // `while`/`until`/`if` take a command as the condition.
        const cond = seg.slice(1);
        if (cond.length === 0 || !isSegmentSafe(cond, ctx)) return false;
      }

      // Collect body segments up to the matching terminator. Track depth
      // across nested openers so an inner `done` doesn't close us.
      let depth = 1;
      let j = i + 1;
      /** @type {ShellToken[][]} */
      const body = [];
      while (j < segments.length && depth > 0) {
        const s = checkedAt(segments, j);
        // Look through any leading body-introducer to find the real
        // head when counting depth.
        let probe = s;
        if (probe.length > 0 && checkedAt(probe, 0).type === 'word' &&
					FLOW_BODY_INTRODUCERS.has(/** @type {WordToken} */ (checkedAt(probe, 0)).text)) {
          probe = probe.slice(1);
        }
        if (probe.length > 0 && checkedAt(probe, 0).type === 'word') {
          const t = /** @type {WordToken} */ (checkedAt(probe, 0)).text;
          if (FLOW_OPENERS.has(t)) depth++;
          else if (t === terminator || t === 'fi' || t === 'done') {
            // Any block terminator decrements; only ours closes.
            if (t === terminator) {
              depth--;
              if (depth === 0) break;
            } else {
              depth--;
            }
          }
        }
        body.push(s);
        j++;
      }
      if (depth !== 0) return false;
      if (!validateSegmentSequence(body, ctx)) return false;
      i = j + 1;
      continue;
    }

    if (!isSegmentSafe(seg, ctx)) return false;
    applyCdSegment(seg, ctx);
    i++;
  }
  return true;
}

/**
 * Follow a lone `cd <path>` segment, recording the directory it moves to so the
 * segments after it are judged there. Called only once the segment has been
 * accepted, so the target is already known to resolve inside an allowed root.
 * Anything that is not exactly `cd <path>` — a bare `cd`, `cd -`, a `cd` with
 * extra words — leaves the recorded directory alone.
 * @param {ShellToken[]} seg accepted segment tokens
 * @param {ApprovalCtx} ctx approval context, updated in place
 * @returns {void}
 */
function applyCdSegment(seg, ctx) {
  if (seg.length !== 2) return;
  const head = checkedAt(seg, 0);
  const target = checkedAt(seg, 1);
  if (head.type !== 'word' || head.text !== 'cd') return;
  if (target.type !== 'word') return;
  ctx.cwd = cdTargetCwd(/** @type {WordToken} */ (target).text, ctx);
}

/**
 * Validate the header of a `for` loop: `VAR in WORD WORD …`. `VAR` must be a
 * POSIX shell identifier; the word list may be empty (`for x in; do …; done`
 * is degenerate but harmless). Each list element must be a plain word — no
 * operators, no command substitutions (which the tokenizer would already
 * have rejected).
 * @param {ShellToken[]} toks header tokens after the `for` keyword
 * @returns {boolean} true if the header is safe
 */
function validateForHeader(toks) {
  if (toks.length < 2) return false;
  if (checkedAt(toks, 0).type !== 'word' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(/** @type {WordToken} */ (checkedAt(toks, 0)).text)) return false;
  if (checkedAt(toks, 1).type !== 'word' || /** @type {WordToken} */ (checkedAt(toks, 1)).text !== 'in') return false;
  for (let k = 2; k < toks.length; k++) {
    if (checkedAt(toks, k).type !== 'word') return false;
  }
  return true;
}
