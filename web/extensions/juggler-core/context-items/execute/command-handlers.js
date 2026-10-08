//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-command safety policies for the shell auto-approval analyser.
 *
 * One class per head command, all registered in {@link COMMAND_HANDLERS}. The
 * segment analysis in `command-approval.js` looks a segment's head command up
 * here and asks the handler whether its arguments are safe — so supporting a
 * new command means adding a class and a registry entry, never extending a
 * god function. Handlers make no filesystem calls: every decision is static,
 * from the argument words plus the {@link ApprovalCtx} (platform, allowed
 * roots, home, write permission).
 * @module juggler-core/context-items/execute/command-handlers
 */

import { isPathInsideAllowedRoots, resolveAgainstCwd } from 'juggler/utils/path-containment';
import { checkedAt } from './shell-tokenizer.js';

/**
 * @typedef {import('./approval-types.js').ApprovalCtx} ApprovalCtx
 * @typedef {import('./approval-types.js').RedirectCfg} RedirectCfg
 */

/**
 * May this command read `p`? The one containment question every handler asks,
 * so every handler asks it the same way.
 *
 * Resolves the path against the command's working directory first (see
 * {@link resolveAgainstCwd}), which is what lets `../../js-tests` after a `cd`
 * be judged as the place it actually names instead of being refused for looking
 * like an escape. The working directory itself joins the allowed roots for the
 * check: a relative path was always judged readable when it didn't escape via
 * `..`, and that is exactly the grant the cwd-as-root carries over — nothing
 * wider. With no known cwd the call degrades to the plain containment check.
 * @param {string} p path argument
 * @param {ApprovalCtx | RedirectCfg} ctx approval context (roots + cwd + home + platform)
 * @returns {boolean} true if `p` resolves inside an allowed root
 */
export function pathAllowed(p, ctx) {
  const cwd = ctx.cwd || '';
  const roots = ctx.allowedRoots || [];
  return isPathInsideAllowedRoots(
    resolveAgainstCwd(p, cwd, ctx.platform || ''),
    cwd ? [...roots, cwd] : roots,
    ctx.home || '',
    ctx.platform || ''
  );
}

/**
 * The flag grammar of a getopt-shaped command, in the pieces {@link parseFlags}
 * needs to walk it. A flag that takes a value states the check its value must
 * pass, which is where a handler says "this one names a file I must contain"
 * or "this one is a count" — instead of a walker of its own to say it in.
 * @typedef {object} FlagGrammar
 * @property {string} [boolShort] cluster letters taking no value (`-lah`)
 * @property {Map<string, (value: string) => boolean>} [valueShort] cluster letters
 *   taking a value — glued (`-n5`) or the next word (`-n 5`) — and its check
 * @property {Set<string>} [boolLong] `--word` flags taking no value
 * @property {Map<string, (value: string) => boolean>} [valueLong] `--word` flags
 *   taking a value — `--word=v` or `--word v` — and its check
 * @property {Set<string>} [optionalValueLong] `--word[=v]` flags, whose value is
 *   glued when present, so the following word is never consumed
 * @property {boolean} [permute] keep reading flags after an operand, GNU-style
 *   (`du web -sh`); by default the first operand ends the flag prefix
 * @property {boolean} [unknownIsOperand] take an unrecognised flag word as the
 *   first operand rather than rejecting — for a command whose operand may itself
 *   start with `-` (a grep pattern in sink position)
 */

/**
 * A completed {@link parseFlags} walk.
 * @typedef {object} ParsedFlags
 * @property {string[]} operands the words after the flag prefix, in order
 * @property {Set<string>} flags the flags recognised on the way — a long flag as
 *   its `--word` (without any `=value`), a short one as its bare letter
 */

/** @type {Set<string>} */
const NO_FLAG_WORDS = new Set();
/** @type {Map<string, (value: string) => boolean>} */
const NO_VALUED_FLAGS = new Map();

/**
 * A context that contains nothing, for a sink parse: input arrives on the pipe,
 * so no flag value there may name a file whatever the roots are.
 * @type {ApprovalCtx}
 */
const NO_ROOTS_CTX = { platform: '', allowedRoots: [] };

/**
 * The value of a flag the command only ever treats as data — a separator, a
 * field list, a glob. Nothing to contain, so anything parses.
 * @returns {boolean} always true
 */
const anyValue = () => true;

/**
 * @param {string} value the flag's value
 * @returns {boolean} true when the value is a plain non-negative integer
 */
const numericValue = (value) => /^\d+$/.test(value);

/**
 * The value of a flag that names a file, in a position where no root can vouch
 * for it. Refusing is the only safe answer.
 * @returns {boolean} always false
 */
const rejectValue = () => false;

/**
 * Walk a getopt-shaped argument list: a prefix of flags, then the operands.
 *
 * One walker for every command of that shape, because the fiddly parts — `--`
 * ending the flag prefix, a lone `-` being an operand, a short value glued
 * (`-n5`) or in the next word (`-n 5`), a long value as `--key=v` or `--key v`
 * — are exactly what a per-command re-implementation gets subtly wrong, and
 * each of these decisions gates auto-approval.
 *
 * Null is the answer whenever the grammar doesn't recognise a flag, a
 * value-taking flag has no value, or a value fails its check: the command's
 * shape is then unsafe, so no path grant can rescue it.
 * @param {string[]} args the command's args, head command already removed
 * @param {FlagGrammar} grammar the command's flag grammar
 * @returns {ParsedFlags | null} the walk, or null when a flag or value is refused
 */
function parseFlags(args, grammar) {
  const boolShort = grammar.boolShort || '';
  const valueShort = grammar.valueShort || NO_VALUED_FLAGS;
  const boolLong = grammar.boolLong || NO_FLAG_WORDS;
  const valueLong = grammar.valueLong || NO_VALUED_FLAGS;
  const optionalValueLong = grammar.optionalValueLong || NO_FLAG_WORDS;
  /** @type {string[]} */
  const operands = [];
  /** @type {Set<string>} */
  const flags = new Set();
  let readingFlags = true;

  for (let i = 0; i < args.length; i++) {
    const a = checkedAt(args, i);
    if (!readingFlags || !a.startsWith('-') || a === '-') {
      operands.push(a);
      if (!grammar.permute) readingFlags = false;
      continue;
    }
    if (a === '--') { readingFlags = false; continue; }

    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const word = eq === -1 ? a : a.slice(0, eq);
      if (boolLong.has(word) || optionalValueLong.has(word)) { flags.add(word); continue; }
      const check = valueLong.get(word);
      if (!check) {
        if (!grammar.unknownIsOperand) return null;
        operands.push(a);
        readingFlags = false;
        continue;
      }
      let value;
      if (eq === -1) {
        if (i + 1 >= args.length) return null;
        value = checkedAt(args, ++i);
      } else {
        value = a.slice(eq + 1);
      }
      if (!check(value)) return null;
      flags.add(word);
      continue;
    }

    const cluster = a.slice(1);
    let consumedNext = false;
    let unknown = false;
    for (let k = 0; k < cluster.length; k++) {
      const ch = checkedAt(cluster, k);
      const check = valueShort.get(ch);
      if (check) {
        let value = cluster.slice(k + 1);
        if (!value) {
          if (i + 1 >= args.length) return null;
          value = checkedAt(args, i + 1);
          consumedNext = true;
        }
        if (!check(value)) return null;
        flags.add(ch);
        break;
      }
      if (!boolShort.includes(ch)) { unknown = true; break; }
      flags.add(ch);
    }
    if (unknown) {
      if (!grammar.unknownIsOperand) return null;
      operands.push(a);
      readingFlags = false;
      continue;
    }
    if (consumedNext) i++;
  }

  return { operands, flags };
}

/**
 * Base class for a per-command safety policy.
 *
 * Each subclass owns the policy for exactly one head command. Keep them
 * tiny: a class per command, registered in {@link COMMAND_HANDLERS}, is the
 * extension point — not a switch statement.
 */
export class CommandHandler {
  /** @type {string} command name */
  static commandName = '';

  /**
   * Safety as a top-level command (`<cmd> <args>`). Default: unsafe.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {boolean} true if these args are safe with this command
   */
  // eslint-disable-next-line no-unused-vars
  static isSafe(args, ctx) { return false; }

  /**
   * Safety as a pipeline sink (`... | <cmd> <args>`). Input comes from the
   * pipe, so no in-project-path arg is required. Default: not a sink.
   *
   * Override in commands that are unambiguously non-mutating and useful at
   * the end of a read-only pipeline (cat, head, tail, wc, grep, …). The
   * optional `cfg` carries the redirect policy (allowedRoots + writeEnabled +
   * home + platform) for the few sinks that WRITE (`tee`) and so must scope
   * their file operands; read-only sinks ignore it.
   * @param {string[]} args positional + flag args (no head command)
   * @param {RedirectCfg} [cfg] redirect policy (only needed by writing sinks)
   * @returns {boolean} true if these args are safe in sink position
   */
  // eslint-disable-next-line no-unused-vars
  static isSafeAsSink(args, cfg) { return false; }

  /**
   * Output-path domain of this command's stdout. Returns `'inProjectPath'`
   * when stdout is a list of in-project filesystem paths that may safely feed
   * a later path argument through a `NAME=$(cmd)` substitution; otherwise null
   * (stdout is opaque content/metadata, not paths). Only consulted for a
   * command that already auto-approves on its own. Default: null.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {'inProjectPath' | null} output-path domain, or null
   */
  // eslint-disable-next-line no-unused-vars
  static outputPathDomain(args, ctx) { return null; }

  /**
   * The filesystem-path arguments this command reads, which must lie inside the
   * allowed roots — i.e. the paths a folder grant would need to cover to make
   * the command auto-approve. Returns `null` when the command's flag/shape
   * grammar is itself unsafe or unparseable (so no path grant can rescue it),
   * and `[]` when the command reads no path arguments. Default: `null` (the
   * handler can't characterise its path arguments).
   *
   * A read-only file-reading handler overrides this; the base
   * {@link outOfRootPaths} then filters the result to the out-of-root subset.
   * The handler need NOT re-confirm full safety here — {@link segmentRemedies}
   * re-verifies the whole segment with the candidate roots granted, so any
   * non-path reason the command is unsafe still suppresses the grant.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {string[] | null} path arguments, or null if uncharacterised/unsafe
   */
  // eslint-disable-next-line no-unused-vars
  static pathArgs(args, ctx) { return null; }

  /**
   * Out-of-root path obstacles: this command's {@link pathArgs} filtered to the
   * subset that falls outside the allowed roots. When this is the ONLY reason a
   * command is rejected, granting these folders (adding them to the
   * allowed-paths list) makes it auto-approve — a far more useful "don't ask
   * again" than wildcarding the command. Returns `[]` when the shape itself is
   * unsafe (pathArgs → null) or no path argument is out of root.
   *
   * Derived from {@link pathArgs} so a handler only declares which arguments are
   * paths; this single implementation owns the out-of-root filtering.
   * @param {string[]} args positional + flag args (no head command)
   * @param {ApprovalCtx} ctx approval context
   * @returns {string[]} out-of-root path arguments, or [] if not a path obstacle
   */
  static outOfRootPaths(args, ctx) {
    const paths = this.pathArgs(args, ctx);
    if (paths === null) return [];
    return paths.filter(p => !pathAllowed(p, ctx));
  }

  /**
   * Suggest auto-approval glob patterns of increasing breadth that would let
   * a rejected segment with this head command pass the analyser's pattern
   * fallback. `words` is the normalised word list (head command first, after
   * sink/env stripping). The caller prepends the exact segment text as the
   * narrowest tier and dedupes, so handlers only return generalisations.
   *
   * Default: a single command-scoped wildcard (`<cmd> *`). Override in
   * commands with sub-structure worth a middle tier (see {@link GitHandler}).
   * @param {string[]} words segment words, head command first
   * @returns {string[]} generalisation patterns, narrowest→broadest
   */
  static suggestPatterns(words) {
    return [`${words[0]} *`];
  }
}

/** Commands that take no arguments at all. */
class NoArgsHandler extends CommandHandler {
  /** @type {string} command name */
  static commandName = '';
  /**
   * @param {string[]} args args
   * @returns {boolean} true if no args
   */
  static isSafe(args) { return args.length === 0; }
}

class PwdHandler extends NoArgsHandler { static commandName = 'pwd'; }
class WhoamiHandler extends NoArgsHandler { static commandName = 'whoami'; }
class IdHandler extends NoArgsHandler { static commandName = 'id'; }
class DateHandler extends NoArgsHandler { static commandName = 'date'; }
class TrueHandler extends NoArgsHandler { static commandName = 'true'; }
class FalseHandler extends NoArgsHandler { static commandName = 'false'; }
class ColonHandler extends NoArgsHandler { static commandName = ':'; }
class HostnameHandler extends NoArgsHandler { static commandName = 'hostname'; }
class UptimeHandler extends NoArgsHandler { static commandName = 'uptime'; }

/**
 * `sleep DURATION [DURATION...]` — pause for a fixed duration. Read-only,
 * no FS / network effects. Each duration must be numeric with an optional
 * single-letter suffix (`s`, `m`, `h`, `d`) per GNU coreutils. Reject
 * anything else so a shell-substituted duration can never slip through (the
 * tokenizer already bails on `$(…)` / backticks, but this is defense in
 * depth).
 */
class SleepHandler extends CommandHandler {
  static commandName = 'sleep';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    if (args.length === 0) return false;
    return args.every(a => /^\d+(?:\.\d+)?[smhd]?$/.test(a));
  }
}

class UnameHandler extends CommandHandler {
  static commandName = 'uname';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.every(a => /^-[amrsnpiov]+$/.test(a));
  }
}

class EchoHandler extends CommandHandler {
  static commandName = 'echo';
  // Backticks and `$(…)` substitution are rejected before we get here, and an
  // unquoted expansion routes the segment to pattern-only approval (see
  // isSegmentSafe) rather than to this handler; a quoted expansion is opaque
  // literal text. echo is read-only w.r.t. the filesystem, so any surviving
  // args are safe.
  /** @returns {boolean} safe */
  static isSafe() { return true; }
}

class PrintfHandler extends CommandHandler {
  static commandName = 'printf';
  /**
   * Same reasoning as echo — no FS effect; substitutions/backticks are rejected
   * earlier and unquoted expansions route to pattern-only approval.
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) { return args.length >= 1; }
}

class WhichHandler extends CommandHandler {
  static commandName = 'which';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length >= 1 && args.every(a => !a.startsWith('-'));
  }
}

class TypeHandler extends CommandHandler {
  static commandName = 'type';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length >= 1 && args.every(a => !a.startsWith('-'));
  }
}

class CommandBuiltinHandler extends CommandHandler {
  static commandName = 'command';
  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) {
    return args.length === 2 && checkedAt(args, 0) === '-v' && !checkedAt(args, 1).startsWith('-');
  }
}

/**
 * `cd <path>` — change directory. Safe as a segment anywhere in a sequence (not
 * just leading) when the single target path resolves inside an allowed root.
 * `cd` itself does nothing dangerous; the risk is that a *later* command's
 * relative paths resolve against the new cwd, but every later segment is
 * validated independently and its relative paths are rejected if they escape
 * via `..` — so a `cd` into the project can't widen what follows. Bare `cd`
 * (→ $HOME), `cd -` (→ $OLDPWD), and flag forms stay unrecognised (prompt),
 * since their destination isn't a known in-project path.
 */
class CdHandler extends CommandHandler {
  static commandName = 'cd';

  /**
   * The directory `cd` moves to. Declaring it makes an out-of-root target a
   * *path* obstacle, which is what it is: the fix is to grant that folder, and
   * the analyser withholds the `cd *` generalisation once a path is the sole
   * obstacle — a blanket `cd *` would auto-approve moving anywhere, dropping the
   * containment rule the command broke.
   *
   * Only `cd <path>` names a directory. A bare `cd` (→ $HOME), `cd -` (→ the
   * previous directory, unknowable here), and any longer form are shape
   * failures no grant can rescue, so they return null.
   * @param {string[]} args args
   * @returns {string[] | null} the target directory, or null if not `cd <path>`
   */
  static pathArgs(args) {
    if (args.length !== 1) return null;
    const target = checkedAt(args, 0);
    if (target.startsWith('-')) return null;
    return [target];
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    return args.length === 1
			&& !checkedAt(args, 0).startsWith('-')
			&& pathAllowed(checkedAt(args, 0), ctx);
  }
}

/**
 * Short single-letter flags common to read-only directory listings.
 * Any combination in a single `-XYZ` cluster is accepted. Adding a letter
 * here is the way to liberalise — no need to enumerate combinations.
 */
const LS_SHORT_FLAGS = 'aAbBcCdfFghHiklLmnopqrRsStuUvxX1';
const LS_LONG_FLAGS = new Set([
  '--all', '--almost-all', '--color', '--classify', '--directory',
  '--group-directories-first', '--human-readable', '--inode',
  '--reverse', '--recursive', '--size', '--sort'
]);

class LsHandler extends CommandHandler {
  static commandName = 'ls';

  /**
   * `ls [FLAGS] [FILE...]`, with flags and file operands freely interleaved
   * (`ls web -la` is as ordinary as `ls -la web`).
   * @returns {FlagGrammar} grammar
   */
  static grammar() {
    return { boolShort: LS_SHORT_FLAGS, boolLong: LS_LONG_FLAGS, permute: true };
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = LsHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Null when a flag is unrecognised — the command shape itself is unsafe, so
   * no path grant could rescue it.
   * @param {string[]} args args
   * @returns {string[] | null} positional paths, or null on an unsafe flag
   */
  static pathArgs(args) {
    const parsed = parseFlags(args, LsHandler.grammar());
    return parsed === null ? null : parsed.operands;
  }
}

/**
 * `du` — disk usage reporting. It is read-only, but every explicit path and
 * every flag-provided input file (currently `-X` / `--exclude-from`) must stay
 * inside the allowed roots. With no paths, `du` defaults to cwd, which is
 * treated as the conversation root and is safe.
 */
class DuHandler extends CommandHandler {
  static commandName = 'du';

  /**
   * `du [FLAGS] [PATH...]`, flags and paths interleaved. `-X` /
   * `--exclude-from` name a file du reads, so their values are contained like
   * any other read; `-d` / `--max-depth` must be a depth and not a path.
   * @param {ApprovalCtx} ctx ctx
   * @returns {FlagGrammar} grammar
   */
  static grammar(ctx) {
    return {
      boolShort: 'abcDhkHklLmsxP0',
      valueShort: new Map([
        ['d', numericValue], ['t', anyValue], ['B', anyValue], ['I', anyValue],
        ['X', (/** @type {string} */ value) => pathAllowed(value, ctx)]
      ]),
      boolLong: new Set([
        '--all', '--total', '--human-readable', '--summarize', '--separate-dirs',
        '--one-file-system', '--count-links', '--dereference', '--dereference-args',
        '--no-dereference', '--apparent-size', '--inodes', '--si', '--time',
        '--null', '--bytes', '--kilobytes'
      ]),
      valueLong: new Map([
        ['--max-depth', numericValue], ['--threshold', anyValue],
        ['--block-size', anyValue], ['--exclude', anyValue],
        ['--exclude-from', (/** @type {string} */ value) => pathAllowed(value, ctx)],
        ['--time-style', anyValue]
      ]),
      permute: true
    };
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = DuHandler.pathArgs(args, ctx);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Sink/xargs position: accept only flags, no pre-supplied paths. This keeps
   * `find … | xargs du -sh` useful while still preventing hidden path reads.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = DuHandler.pathArgs(args, NO_ROOTS_CTX);
    return paths !== null && paths.length === 0;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} positional paths, or null on unsafe flags/values
   */
  static pathArgs(args, ctx) {
    const parsed = parseFlags(args, DuHandler.grammar(ctx));
    return parsed === null ? null : parsed.operands;
  }
}
/**
 * Base for a read-only command shaped `<cmd> [FLAGS] [FILE...]` — a whitelisted
 * flag prefix followed by file operands that must lie inside the allowed roots.
 *
 * A subclass states its grammar in three pieces and inherits the rest:
 *   - {@link flagMatcher}  — which flag words are recognised at all
 *   - {@link valueFlags}   — which of those consume the NEXT word, and the
 *                            pattern that word must match
 *   - {@link maxOperands}  — an operand ceiling, for a command where a further
 *                            operand changes what it does (see
 *                            {@link XxdHandler}, whose second operand is an
 *                            output file)
 * Anything unrecognised returns null: the shape itself is unsafe, so no path
 * grant can rescue it.
 */
class FlaggedFileReader extends CommandHandler {
  /** @returns {(arg: string) => boolean} flag matcher */
  static flagMatcher() { return () => false; }

  /**
   * Flags that consume the following word as a value, mapped to the pattern
   * that value must match. A flag the matcher accepts but this map omits is
   * boolean — which is how `head -c 100` swallows the count while `wc -c file`
   * leaves the operand alone, though both spell the flag `-c`.
   * @returns {Map<string, RegExp>} value-taking flags
   */
  static valueFlags() { return new Map(); }

  /** @type {number} most file operands this command may carry */
  static maxOperands = Infinity;

  /**
   * Walk the flag prefix, then return the trailing operands — or null on an
   * unrecognised flag, a missing or ill-formed flag value, or more operands
   * than {@link maxOperands}. A `--` word ends the flag prefix; a lone `-` is
   * an operand (stdin), not a flag.
   * @param {string[]} args args
   * @returns {string[] | null} trailing operands, or null on reject
   */
  static operands(args) {
    const matcher = this.flagMatcher();
    const values = this.valueFlags();
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!matcher(a)) return null;
      const pattern = values.get(a);
      if (pattern) {
        if (i + 1 >= args.length || !pattern.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      i++;
    }
    const rest = args.slice(i);
    return rest.length > this.maxOperands ? null : rest;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional file paths, or null on reject
   */
  static pathArgs(args) { return this.operands(args); }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = this.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }
}

/**
 * A {@link FlaggedFileReader} that is also useful at the end of a pipeline.
 * Input arrives on the pipe, so sink position accepts the flag prefix alone; a
 * pre-supplied file operand there is refused, since it would be a read the
 * upstream segment never vouched for.
 */
class PipedFileReader extends FlaggedFileReader {
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = this.operands(args);
    return paths !== null && paths.length === 0;
  }
}

/**
 * A command whose operands are literal strings rather than paths: it computes
 * on the argument text and never opens what it is given (`basename`, `dirname`,
 * `seq`). Flags are still whitelisted, but there is nothing to contain, so the
 * operands are not path-checked and {@link pathArgs} is empty rather than null.
 */
class ArgOnlyHandler extends FlaggedFileReader {
  /**
   * @param {string[]} args args
   * @returns {string[] | null} [] when the flags parse, null when they don't
   */
  static pathArgs(args) {
    return this.operands(args) === null ? null : [];
  }
}

class TailHandler extends FlaggedFileReader {
  static commandName = 'tail';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-(?:n|c|C|f|q|v|\d+)$/.test(a) || /^-[fqv]+$/.test(a); }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-n', /^\d+$/], ['-c', /^\d+$/], ['-C', /^\d+$/]]); }
  /**
   * Safe as a sink with `-N`, `-n N`, `-c N`, or no args.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1) return /^-\d+$/.test(checkedAt(args, 0)) || /^-[fqv]+$/.test(checkedAt(args, 0));
    if (args.length === 2 && (checkedAt(args, 0) === '-n' || checkedAt(args, 0) === '-c') && /^\d+$/.test(checkedAt(args, 1))) return true;
    return false;
  }
}

class HeadHandler extends FlaggedFileReader {
  static commandName = 'head';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-(?:n|c|C|q|v|\d+)$/.test(a) || /^-[qv]+$/.test(a); }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-n', /^\d+$/], ['-c', /^\d+$/], ['-C', /^\d+$/]]); }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1) return /^-\d+$/.test(checkedAt(args, 0)) || /^-[qv]+$/.test(checkedAt(args, 0));
    if (args.length === 2 && (checkedAt(args, 0) === '-n' || checkedAt(args, 0) === '-c') && /^\d+$/.test(checkedAt(args, 1))) return true;
    return false;
  }
}

/**
 * `wc [-lwcmL] [FILE...]` — count lines, words, bytes. Every flag here selects
 * a column to print; none takes a value, so `wc -c README.md` counts bytes in
 * the file rather than reading `README.md` as a count.
 */
class WcHandler extends FlaggedFileReader {
  static commandName = 'wc';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-[lwcmL]+$/.test(a); }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    if (args.length === 0) return true;
    if (args.length === 1 && /^-[lwcmL]+$/.test(checkedAt(args, 0))) return true;
    return false;
  }
}

/**
 * `strings [-a] [-f] [-n N] [-t d|o|x] [-e ENC] [FILE...]` — print the printable
 * runs in a binary. Read-only. An `@FILE` operand (read further arguments from
 * a file) is refused: it names a file whose contents become arguments, which
 * the static analysis here cannot see.
 */
class StringsHandler extends PipedFileReader {
  static commandName = 'strings';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[afv]+$/.test(a) || /^-[nte]$/.test(a) || /^-\d+$/.test(a)
			|| /^--(?:all|print-file-name)$/.test(a) || /^--(?:bytes|radix|encoding)=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-n', /^\d+$/], ['-t', /^[doxs]$/], ['-e', /^[sSbBlL]$/]]); }
  /**
   * @param {string[]} args args
   * @returns {string[] | null} operands, or null when one is an `@FILE`
   */
  static operands(args) {
    const rest = super.operands(args);
    if (rest === null) return null;
    return rest.some(a => a.startsWith('@')) ? null : rest;
  }
}

/** `od [-abcdfiloxsvC] [-A RADIX] [-j N] [-N N] [-t TYPE] [-w N] [FILE...]` — dump. Read-only; no od flag writes. */
class OdHandler extends PipedFileReader {
  static commandName = 'od';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-[abcdfiloxsvC]+$/.test(a) || /^-[AjNtw]$/.test(a); }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() {
    return new Map([['-A', /^[doxn]$/], ['-j', /^\w+$/], ['-N', /^\w+$/], ['-t', /^[acdfoux]\w*$/], ['-w', /^\d+$/]]);
  }
}

/**
 * `xxd [-b|-p|-u|-r] [-c N] [-g N] [-l N] [-s SEEK] [FILE]` — hex dump.
 *
 * Read-only in the one-operand form ONLY: `xxd INFILE OUTFILE` WRITES its
 * second operand, so the operand ceiling is what keeps this command read-only
 * (and is what makes `-r`, which turns a dump back into binary, harmless — with
 * one operand it can only reach stdout).
 */
class XxdHandler extends PipedFileReader {
  static commandName = 'xxd';
  /** @type {number} a second operand would be an output file */
  static maxOperands = 1;
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-[bipruv]$/.test(a) || /^-[cgls]$/.test(a); }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() {
    return new Map([['-c', /^\d+$/], ['-g', /^\d+$/], ['-l', /^\d+$/], ['-s', /^[+-]?(?:0x)?[0-9a-fA-F]+$/]]);
  }
}

/**
 * `hexdump [-bcCdovx] [-n N] [-s SKIP] [FILE...]` — dump. The built-in display
 * forms only: `-e FORMAT` is a formatting mini-language and `-f FORMAT_FILE`
 * reads its format out of a file, so neither is whitelisted.
 */
class HexdumpHandler extends PipedFileReader {
  static commandName = 'hexdump';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => /^-[bcCdovx]+$/.test(a) || /^-[ns]$/.test(a); }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-n', /^\d+$/], ['-s', /^[+-]?(?:0x)?[0-9a-fA-F]+$/]]); }
}

/** `nl [-b STYLE] [-n FORMAT] [-w N] [-s SEP] [-v N] [-i N] [FILE...]` — number lines. Read-only. */
class NlHandler extends PipedFileReader {
  static commandName = 'nl';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-p$/.test(a) || /^-[bdfhinsvw]$/.test(a)
			|| /^--(?:body-numbering|number-format|number-width|number-separator|starting-line-number|line-increment)=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() {
    const style = /^(?:[atn]|p.*)$/;
    return new Map([
      ['-b', style], ['-f', style], ['-h', style],
      ['-d', /^.{1,2}$/], ['-n', /^(?:ln|rn|rz)$/], ['-s', /^.+$/],
      ['-i', /^\d+$/], ['-v', /^\d+$/], ['-w', /^\d+$/]
    ]);
  }
}

/** `tac [-b] [-r] [-s SEP] [FILE...]` — concatenate in reverse. Read-only. */
class TacHandler extends PipedFileReader {
  static commandName = 'tac';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[br]+$/.test(a) || a === '-s'
			|| /^--(?:before|regex)$/.test(a) || /^--separator=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-s', /^.+$/]]); }
}

/** `rev [FILE...]` — reverse each line's characters. Read-only, and takes no flags. */
class RevHandler extends PipedFileReader {
  static commandName = 'rev';
}

/** `fold [-b] [-s] [-w N] [FILE...]` — wrap lines. Read-only. */
class FoldHandler extends PipedFileReader {
  static commandName = 'fold';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[bs]+$/.test(a) || a === '-w' || /^-\d+$/.test(a)
			|| /^--(?:bytes|spaces)$/.test(a) || /^--width=\d+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-w', /^\d+$/]]); }
}

/** `expand [-i] [-t LIST] [FILE...]` — tabs to spaces. Read-only. */
class ExpandHandler extends PipedFileReader {
  static commandName = 'expand';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[it]$/.test(a) || a === '--initial' || /^--tabs=[\d,]+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-t', /^[\d,]+$/]]); }
}

/** `unexpand [-a] [--first-only] [-t LIST] [FILE...]` — spaces to tabs. Read-only. */
class UnexpandHandler extends PipedFileReader {
  static commandName = 'unexpand';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[at]$/.test(a) || /^--(?:all|first-only)$/.test(a) || /^--tabs=[\d,]+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-t', /^[\d,]+$/]]); }
}

/** `paste [-s] [-z] [-d LIST] [FILE...]` — merge lines. Read-only. */
class PasteHandler extends PipedFileReader {
  static commandName = 'paste';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[sz]+$/.test(a) || a === '-d'
			|| /^--(?:serial|zero-terminated)$/.test(a) || /^--delimiters=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-d', /^.+$/]]); }
}

/** `join [-1 N] [-2 N] [-a N] [-v N] [-e STR] [-t CHAR] [-o FMT] [-i] FILE1 FILE2` — relational join. Read-only. */
class JoinHandler extends PipedFileReader {
  static commandName = 'join';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[12aveto]$/.test(a) || a === '-i'
			|| /^--(?:header|ignore-case|check-order|nocheck-order)$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() {
    return new Map([
      ['-1', /^\d+$/], ['-2', /^\d+$/], ['-a', /^[12]$/], ['-v', /^[12]$/],
      ['-e', /^.*$/], ['-t', /^.$/], ['-o', /^(?:auto|[\d.,]+)$/]
    ]);
  }
}

/** `column [-t] [-x] [-c N] [-s SEP] [FILE...]` — columnate lists. Read-only. */
class ColumnHandler extends PipedFileReader {
  static commandName = 'column';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[tx]+$/.test(a) || /^-[cs]$/.test(a)
			|| a === '--table' || /^--(?:separator|output-width)=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-c', /^\d+$/], ['-s', /^.+$/]]); }
}

/**
 * `cksum` / `md5sum` / `sha1sum` / `sha256sum` / `sha512sum` / `shasum` — hash
 * file contents. Read-only throughout: the digest forms print, and `-c` VERIFIES
 * a checksum list, which is another read. Nothing in this family writes.
 */
class ChecksumHandler extends PipedFileReader {
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[bctwz]+$/.test(a) || a === '-a'
			|| /^--(?:binary|text|check|tag|warn|quiet|status|strict|zero)$/.test(a) || /^--algorithm=\d+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-a', /^\d+$/]]); }
}

class CksumHandler extends ChecksumHandler { static commandName = 'cksum'; }
class Md5sumHandler extends ChecksumHandler { static commandName = 'md5sum'; }
class Sha1sumHandler extends ChecksumHandler { static commandName = 'sha1sum'; }
class Sha256sumHandler extends ChecksumHandler { static commandName = 'sha256sum'; }
class Sha512sumHandler extends ChecksumHandler { static commandName = 'sha512sum'; }
class ShasumHandler extends ChecksumHandler { static commandName = 'shasum'; }

/** `comm [-123] [--output-delimiter=STR] FILE1 FILE2` — compare sorted files. Read-only. */
class CommHandler extends PipedFileReader {
  static commandName = 'comm';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[123z]+$/.test(a)
			|| /^--(?:check-order|nocheck-order|total|zero-terminated)$/.test(a) || /^--output-delimiter=.*$/.test(a);
  }
}

/** `cmp [-b] [-l] [-s] [-i N] [-n N] FILE1 [FILE2]` — compare byte by byte. Read-only. */
class CmpHandler extends PipedFileReader {
  static commandName = 'cmp';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[bls]+$/.test(a) || /^-[in]$/.test(a)
			|| /^--(?:print-bytes|verbose|quiet|silent)$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-i', /^\d+(?::\d+)?$/], ['-n', /^\d+$/]]); }
}

/**
 * `diff [FLAGS] FILE1 FILE2` — compare files. No diff flag writes; the format
 * flags only shape stdout. Two exclusions are deliberate:
 *   - `-l` pipes the output through `pr`, spawning another program.
 *   - `--exclude-from=FILE` / `--starting-file=FILE` name further files to read,
 *     which the positional operands cover without a value flag to police.
 */
class DiffHandler extends PipedFileReader {
  static commandName = 'diff';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[abBdEiNpqrstTuvwyZ]+$/.test(a) || /^-[CU]$/.test(a) || /^-\d+$/.test(a)
			|| /^--(?:brief|report-identical-files|recursive|new-file|text|ignore-case|ignore-all-space|ignore-blank-lines|ignore-space-change|ignore-trailing-space|ignore-tab-expansion|minimal|expand-tabs|initial-tab|side-by-side|suppress-common-lines|no-color|normal)$/.test(a)
			|| /^--(?:unified|context)(?:=\d+)?$/.test(a) || /^--color(?:=\w+)?$/.test(a) || /^--(?:exclude|label)=.*$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-C', /^\d+$/], ['-U', /^\d+$/]]); }
}

/**
 * `realpath [-emqsz] PATH...` — resolve paths to their canonical form. It reads
 * directory metadata and follows symlinks, so its operands are contained like
 * any other read. `--relative-to=DIR` / `--relative-base=DIR` carry a further
 * path and are left out rather than policed.
 */
class RealpathHandler extends FlaggedFileReader {
  static commandName = 'realpath';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[emqszLP]+$/.test(a)
			|| /^--(?:canonicalize-existing|canonicalize-missing|quiet|strip|no-symlinks|zero|logical|physical)$/.test(a);
  }
}

/**
 * `df [-hkmiaHlPT] [PATH...]` — filesystem usage. Reads mount metadata only; a
 * PATH operand names which filesystem to report on and is contained like any
 * other read. Bare `df` reports every mount and takes no operand at all. The
 * value-taking forms (`-B SIZE`, `-t TYPE`, `--output=LIST`) are left out to
 * keep the surface small.
 */
class DfHandler extends FlaggedFileReader {
  static commandName = 'df';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[hkmiaHlPT]+$/.test(a)
			|| /^--(?:human-readable|si|inodes|all|local|portability|print-type|total)$/.test(a);
  }
}

/**
 * `basename PATH [SUFFIX]` / `basename -a [-s SUF] PATH...` — strip directory
 * and suffix. Pure string manipulation: it never opens the path it is handed,
 * so its operands are not reads and are not contained.
 */
class BasenameHandler extends ArgOnlyHandler {
  static commandName = 'basename';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => /^-[az]+$/.test(a) || a === '-s'
			|| /^--(?:multiple|zero)$/.test(a) || /^--suffix=.+$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-s', /^.+$/]]); }
}

/** `dirname PATH...` — strip the last component. Pure string manipulation, like {@link BasenameHandler}. */
class DirnameHandler extends ArgOnlyHandler {
  static commandName = 'dirname';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() { return (/** @type {string} */ a) => a === '-z' || a === '--zero'; }
}

/**
 * `seq [-w] [-s STR] [-f FMT] [FIRST [INCR]] LAST` — print a number sequence.
 * No filesystem access at all. A negative bound looks like a flag, so the
 * matcher accepts one; either way the operands are numbers and nothing is
 * contained.
 */
class SeqHandler extends ArgOnlyHandler {
  static commandName = 'seq';
  /** @returns {(a: string) => boolean} flag matcher */
  static flagMatcher() {
    return (/** @type {string} */ a) => a === '-w' || /^-[sf]$/.test(a) || /^-\d+(?:\.\d+)?$/.test(a)
			|| a === '--equal-width' || /^--(?:separator|format)=.*$/.test(a);
  }
  /** @returns {Map<string, RegExp>} value-taking flags */
  static valueFlags() { return new Map([['-s', /^.*$/], ['-f', /^.+$/]]); }
}

/**
 * `sort` — order lines. Read-only except for the output / program flags, which
 * are rejected:
 *   - `-o FILE` / `--output=FILE`     — writes the result to a file.
 *   - `--compress-program=PROG`       — runs an arbitrary program.
 *   - `--random-source=FILE` / `--files0-from=F` — name files; excluded to keep
 *     the surface small (no legitimate need in an auto-approved read).
 * Everything else (`-u`, `-n`, `-r`, `-k`, `-t`, `-S`, `-T`, …) just reads and
 * sorts. As a sink the input is the pipe, so no file args are allowed.
 */
class SortHandler extends CommandHandler {
  static commandName = 'sort';

  /**
   * `sort [FLAGS] [FILE...]`. The output / program flags are simply absent from
   * the grammar, so they are rejected with everything else unrecognised; the
   * values that remain (`-k` keys, `-t` separators, buffer sizes) are data.
   * @returns {FlagGrammar} grammar
   */
  static grammar() {
    return {
      boolShort: 'bdfghiMnrRsuVcCz',
      valueShort: new Map([
        ['k', anyValue], ['t', anyValue], ['S', anyValue], ['T', anyValue]
      ]),
      boolLong: new Set([
        '--ignore-leading-blanks', '--dictionary-order', '--ignore-case',
        '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting',
        '--month-sort', '--numeric-sort', '--reverse', '--random-sort',
        '--stable', '--unique', '--version-sort', '--check', '--zero-terminated',
        '--debug'
      ]),
      valueLong: new Map([
        ['--key', anyValue], ['--field-separator', anyValue],
        ['--buffer-size', anyValue], ['--temporary-directory', anyValue]
      ])
    };
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = SortHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = SortHandler.pathArgs(args);
    return paths !== null && paths.length === 0;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional (input) file paths, or null on reject
   */
  static pathArgs(args) {
    const parsed = parseFlags(args, SortHandler.grammar());
    return parsed === null ? null : parsed.operands;
  }
}

/**
 * `uniq` — collapse / count adjacent duplicate lines. A read-only line filter.
 *
 * Every accepted flag is non-writing. The one hazard is uniq's positional
 * grammar `uniq [OPTION]... [INPUT [OUTPUT]]`: a SECOND positional names an
 * OUTPUT file that uniq overwrites. So we allow at most one positional (the
 * INPUT, which must be in-project) at top level, and none in sink position —
 * the output-file form can never be auto-approved.
 *
 * Value-taking flags are `-f N` / `--skip-fields=N` (skip fields), `-s N` /
 * `--skip-chars=N`, `-w N` / `--check-chars=N`, all numeric. `--all-repeated`
 * / `--group` take an OPTIONAL `=METHOD`; their short forms (`-D`, none) take
 * no value.
 */
class UniqHandler extends CommandHandler {
  static commandName = 'uniq';

  /**
   * `uniq [FLAGS] [INPUT [OUTPUT]]`. Every value-taking flag here counts fields
   * or characters, so every value must be numeric — a non-numeric one means the
   * args aren't the shape we think they are.
   * @returns {FlagGrammar} grammar
   */
  static grammar() {
    return {
      boolShort: 'cduizD',
      valueShort: new Map([
        ['f', numericValue], ['s', numericValue], ['w', numericValue]
      ]),
      boolLong: new Set([
        '--count', '--repeated', '--ignore-case', '--unique', '--zero-terminated'
      ]),
      valueLong: new Map([
        ['--skip-fields', numericValue], ['--skip-chars', numericValue],
        ['--check-chars', numericValue]
      ]),
      optionalValueLong: new Set(['--all-repeated', '--group'])
    };
  }

  /**
   * Top-level: at most one positional (the INPUT file), in-project. A second
   * positional is uniq's OUTPUT file (a write) and is rejected.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = UniqHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Sink: input from the pipe; no positionals (an INPUT positional would
   * shadow stdin, an OUTPUT positional would write a file).
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = UniqHandler.pathArgs(args);
    return paths !== null && paths.length === 0;
  }

  /**
   * Only the single INPUT positional is a readable path. A 2nd positional is an
   * OUTPUT file uniq overwrites — a write, never rescued by a read grant — so we
   * return null there (ungrantable shape).
   * @param {string[]} args args
   * @returns {string[] | null} the INPUT path, or null on reject / output-file form
   */
  static pathArgs(args) {
    const parsed = parseFlags(args, UniqHandler.grammar());
    if (parsed === null) return null;
    if (parsed.operands.length > 1) return null; // 2nd positional = output file (write)
    return parsed.operands;
  }
}

/**
 * `cut` — select columns / fields from each line. A read-only line filter.
 *
 * Unlike {@link UniqHandler}, cut has no output-file positional: every
 * positional is an INPUT file (`cut OPTION... [FILE]...`), so at top level they
 * must all be in-project, and in sink position there must be none (input comes
 * from the pipe). Value-taking flags (`-b/-c/-f LIST`, `-d DELIM`,
 * `--output-delimiter=STR`) carry only data, never a path or program, so their
 * values are accepted as-is — only the positional file args are path-checked.
 */
class CutHandler extends CommandHandler {
  static commandName = 'cut';

  /**
   * `cut OPTION... [FILE]...`. Every value here is a byte / character / field
   * list or a delimiter — data, never a path or a program — so the values are
   * taken as they come and only the operands are contained.
   * @returns {FlagGrammar} grammar
   */
  static grammar() {
    return {
      boolShort: 'snz',
      valueShort: new Map([
        ['b', anyValue], ['c', anyValue], ['d', anyValue], ['f', anyValue]
      ]),
      boolLong: new Set(['--complement', '--only-delimited', '--zero-terminated']),
      valueLong: new Map([
        ['--bytes', anyValue], ['--characters', anyValue], ['--delimiter', anyValue],
        ['--fields', anyValue], ['--output-delimiter', anyValue]
      ])
    };
  }

  /**
   * Top-level: positionals are INPUT files; all must be in-project.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = CutHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Sink: input from the pipe; no file positionals.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const paths = CutHandler.pathArgs(args);
    return paths !== null && paths.length === 0;
  }

  /**
   * @param {string[]} args args
   * @returns {string[] | null} positional (input) file paths, or null on reject
   */
  static pathArgs(args) {
    const parsed = parseFlags(args, CutHandler.grammar());
    return parsed === null ? null : parsed.operands;
  }
}

/**
 * `tr` — translate/delete/squeeze characters. The simplest filter of all: it
 * reads ONLY from stdin and writes ONLY to stdout — it never names, opens, or
 * writes a file. Its positionals are SET1 [SET2], pure character-set data (e.g.
 * `'\n' ' '`, `'a-z' 'A-Z'`), never filesystem paths.
 *
 * Because tr touches no files, top-level and sink safety are identical: validate
 * the flag prefix (reject anything unknown, conservatively) and accept any
 * positional sets. None of tr's flags take a value or write.
 */
class TrHandler extends CommandHandler {
  static commandName = 'tr';

  /**
   * `tr [FLAGS] SET1 [SET2]`. No flag takes a value, so the grammar is two
   * whitelists; the operands are character sets, pure data with nothing to
   * contain.
   * @returns {FlagGrammar} grammar
   */
  static grammar() {
    return {
      boolShort: 'cCdst',
      boolLong: new Set([
        '--complement', '--delete', '--squeeze-repeats', '--truncate-set1'
      ])
    };
  }

  /**
   * Validate the flag prefix — the only job, since an unrecognised flag is the
   * only way tr's args can be unsafe.
   * @param {string[]} args args
   * @returns {boolean} true if every flag is recognised
   */
  static _flagsOk(args) {
    return parseFlags(args, TrHandler.grammar()) !== null;
  }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe
   */
  static isSafe(args) { return TrHandler._flagsOk(args); }

  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) { return TrHandler._flagsOk(args); }
}

class CatHandler extends CommandHandler {
  // `cat` of arbitrary files is a leak risk for `.env`, `.git/config`, etc.
  // As a top-level command each file operand must be an in-project path. Bare
  // `cat` (no operand) is a pure stdin→stdout copy that touches no file, so it
  // is read-only and safe — this is the writer form `cat > <permitted> <<EOF`
  // reduces to once the heredoc body and the (separately gated) output redirect
  // are stripped. As a sink the input comes from the pipe, so we accept no args.
  static commandName = 'cat';
  /**
   * cat takes no value flags — every non-flag arg is a file path (`-` is stdin).
   * Any other flag (`-n`, `-A`, …) marks the shape unsafe (null). Zero args is a
   * distinct case (bare stdin→stdout) handled by the callers, not here.
   * @param {string[]} args args
   * @returns {string[] | null} file path args, or null on an unsafe flag / no args
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    for (const a of args) {
      if (a.startsWith('-') && a !== '-') return null;
    }
    return args;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    // Bare `cat` reads stdin and writes stdout — no path operand, nothing to
    // leak. It is read-only and safe on its own, and is what a permitted-target
    // writer (`cat > file`, `cat >> file`, heredoc/stdin in) reduces to after
    // the output redirect is stripped by isStrippableRedirectTarget.
    if (args.length === 0) return true;
    const paths = CatHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }
  /**
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) { return args.length === 0; }
}

/**
 * `tee [-a] [-i] [-p] [FILE...]` — copy stdin to stdout and to each FILE.
 *
 * Unlike the read-only file handlers, tee's operands are WRITE destinations, so
 * it is gated exactly like an output redirect (see {@link
 * isStrippableRedirectTarget}): safe only when file-writing is enabled for the
 * conversation AND every FILE resolves inside the allowed roots. This is the
 * pipe-sink twin of `cmd > <permitted>` — `make 2>&1 | tee build.log` writes
 * only where the LLM is already permitted to write. Bare `tee` (no FILE) writes
 * to stdout alone: a read-only stdin→stdout passthrough, safe on its own and as
 * a sink regardless of write permission.
 *
 * Only the boolean short flags `-a` (append), `-i` (ignore SIGINT), `-p`, their
 * `--append` / `--ignore-interrupts` long forms, and a `--` terminator are
 * recognised; any value-taking or unknown flag (e.g. `--output-error=MODE`)
 * marks the shape unsafe so nothing slips past as a filename.
 */
class TeeHandler extends CommandHandler {
  static commandName = 'tee';
  /**
   * Return tee's file operands (its write targets), or null on an unrecognised
   * flag. Every operand is a path; there are no positional non-path args.
   * @param {string[]} args args
   * @returns {string[] | null} file operands, or null on an unsafe flag
   */
  static pathArgs(args) {
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (a === '--append' || a === '--ignore-interrupts') { i++; continue; }
      if (!/^-[aip]+$/.test(a)) return null;
      i++;
    }
    return args.slice(i);
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx | RedirectCfg} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = TeeHandler.pathArgs(args);
    if (paths === null) return false;
    // Bare tee: stdin → stdout only, no file written. Read-only.
    if (paths.length === 0) return true;
    // Writing to files: gated on write-permission, and every target in-project
    // — the same policy the `>`/`>>` redirect strip enforces.
    if (!ctx || !ctx.writeEnabled) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }
  /**
   * As a pipe sink (`… | tee FILE`) tee still writes FILE, so the same
   * write-permission + in-project gating applies. `cfg` carries that policy.
   * @param {string[]} args args
   * @param {RedirectCfg} [cfg] redirect policy
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args, cfg) { return TeeHandler.isSafe(args, cfg || {}); }
}

/**
 * `grep` — read-only pattern matching. Reject anything that writes (none of
 * grep's flags write by default, but we still whitelist conservatively):
 *   - `-f FILE` (pattern from file) — value is a path; require in-project.
 *   - `--include`, `--exclude`, `-A`, `-B`, `-C` take a value.
 *   - All other flags must come from a short-letter whitelist.
 *
 * As a top-level command, requires at least one in-project path (or `-r` /
 * `-R` recursive starting at an in-project path). As a sink, just needs a
 * pattern.
 */
class GrepHandler extends CommandHandler {
  static commandName = 'grep';

  /**
   * grep's flag grammar. Three flags name a file grep opens — `-f` / `--file`
   * (patterns) and `--exclude-from` (a list of names to skip) — so their values
   * are contained like any other read. In sink position (`… | grep …`) the pipe
   * supplies the input and there is no vouched-for root to judge a filename
   * against, so those three are refused outright; and an unrecognised
   * dash-leading word there is grep's PATTERN (`grep -E "--- FAIL"`) rather than
   * a parse error.
   * @param {ApprovalCtx} ctx ctx
   * @param {boolean} [sink] true in pipeline-sink position
   * @returns {FlagGrammar} grammar
   */
  static grammar(ctx, sink) {
    const fileValue = sink ? rejectValue : (/** @type {string} */ value) => pathAllowed(value, ctx);
    return {
      boolShort: 'EFGPHhIilLnoqRrsvwxaczZ',
      // `-A`, `-B`, `-C`, `-m`, `-e`, `-f`, `-d` (--directories), `-D`
      // (--devices) take a value, attached (`-A3`) or as the next word.
      valueShort: new Map([
        ['A', anyValue], ['B', anyValue], ['C', anyValue], ['m', anyValue],
        ['e', anyValue], ['d', anyValue], ['D', anyValue], ['f', fileValue]
      ]),
      boolLong: new Set([
        '--basic-regexp', '--extended-regexp', '--fixed-strings', '--perl-regexp',
        '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp',
        '--line-regexp', '--count', '--files-with-matches', '--files-without-match',
        '--no-filename', '--with-filename', '--line-number', '--only-matching',
        '--quiet', '--silent', '--recursive', '--dereference-recursive',
        '--no-messages', '--null-data', '--null', '--text', '--binary-files',
        '--line-buffered', '--color', '--colour', '--no-color', '--no-colour',
        '--initial-tab', '--byte-offset'
      ]),
      valueLong: new Map([
        ['--after-context', anyValue], ['--before-context', anyValue],
        ['--context', anyValue], ['--max-count', anyValue], ['--regexp', anyValue],
        ['--file', fileValue], ['--exclude-from', fileValue],
        ['--include', anyValue], ['--exclude', anyValue],
        ['--exclude-dir', anyValue], ['--include-dir', anyValue],
        ['--label', anyValue], ['--devices', anyValue],
        ['--directories', anyValue], ['--group-separator', anyValue]
      ]),
      unknownIsOperand: sink === true
    };
  }

  /**
   * The words left after grep's flag prefix: the PATTERN (unless `-e` / `-f`
   * supplied it) followed by the search paths.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} positional args, or null on an unknown / unsafe flag
   */
  static _positionals(args, ctx) {
    const parsed = parseFlags(args, GrepHandler.grammar(ctx));
    return parsed === null ? null : parsed.operands;
  }

  /**
   * Top-level: `grep [flags] PATTERN [path-in-project ...]`. Pattern is
   * positional[0] unless supplied via `-e`/`-f`. We require at least one
   * in-project path, OR a recursive flag (`-r` / `-R` / `--recursive`).
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const isRecursive = args.some(a => a === '-r' || a === '-R' || a === '--recursive' || a === '--dereference-recursive' || (a.startsWith('-') && !a.startsWith('--') && /[rR]/.test(a)));
    const positionals = GrepHandler._positionals(args, ctx);
    if (positionals === null) return false;
    // A single path-looking positional is almost always a mistaken/file-intended
    // grep invocation (`grep /tmp/foo`). Treat it as a path obstacle for approval
    // rather than letting a broad `grep *` pattern bless it.
    if (positionals.length === 1 && (checkedAt(positionals, 0).startsWith('/') || checkedAt(positionals, 0).startsWith('~/'))) {
      return pathAllowed(checkedAt(positionals, 0), ctx);
    }
    // Drop the pattern (first positional) if present.
    const paths = positionals.slice(1);
    if (paths.length === 0) {
      // No paths supplied. Only safe if recursive (defaults to cwd, which
      // we treat as project) and a pattern was given.
      if (positionals.length === 0) return false;
      return isRecursive;
    }
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Sink: `... | grep [flags] PATTERN`. No input paths needed; still reject
   * `-f FILE` (pattern loaded from a file). A positional grep pattern may itself
   * start with `-` (for example `grep -E "--- FAIL|^ok"`); in sink position
   * that is still read-only, so an unrecognised dash-leading token is treated as
   * the pattern rather than as a fatal option parse error.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const parsed = parseFlags(args, GrepHandler.grammar(NO_ROOTS_CTX, true));
    if (parsed === null) return false;
    const sawPattern = parsed.flags.has('e') || parsed.flags.has('--regexp');
    return parsed.operands.length === (sawPattern ? 0 : 1);
  }

  /**
   * grep emits file PATHS only under `-l` / `-L`
   * (`--files-with-matches` / `--files-without-match`); without them it prints
   * matching lines (content), which are not paths. When listing files, isSafe
   * has already confirmed every searched location is in-project (explicit path
   * args in-project, or recursive over the project cwd), so the emitted paths
   * are in-project too.
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    const listsFiles = args.some(a =>
      a === '--files-with-matches' || a === '--files-without-match' ||
			(a.startsWith('-') && !a.startsWith('--') && a.length > 1 && /[lL]/.test(a.slice(1))));
    if (!listsFiles) return null;
    return GrepHandler.isSafe(args, ctx) ? 'inProjectPath' : null;
  }

  /**
   * grep's path arguments are its search paths (positionals after the pattern).
   * The flag prefix (including `-f FILE`) must parse cleanly first — a flag-level
   * reject is not a path grant. The recursive / no-path form has no search-path
   * argument, so it yields `[]` (not a path obstacle).
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {string[] | null} search paths, or null on an unsafe flag
   */
  static pathArgs(args, ctx) {
    const positionals = GrepHandler._positionals(args, ctx);
    if (positionals === null) return null;
    if (positionals.length === 1 && (checkedAt(positionals, 0).startsWith('/') || checkedAt(positionals, 0).startsWith('~/'))) {
      return [checkedAt(positionals, 0)];
    }
    return positionals.slice(1); // drop the pattern
  }
}

class FileHandler extends CommandHandler {
  static commandName = 'file';
  /**
   * Every non-flag arg is a path to inspect; any flag marks the shape unsafe.
   * @param {string[]} args args
   * @returns {string[] | null} path args, or null on an unsafe flag / no args
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    for (const a of args) {
      if (a.startsWith('-') && a !== '-') return null;
    }
    return args;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = FileHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }
}

class StatHandler extends CommandHandler {
  static commandName = 'stat';
  /**
   * Walk stat's flag prefix (`-f`/`-c FMT`, `--printf`/`--format`, and the
   * boolean `-LftxsZ` cluster), then return the trailing positional file paths,
   * or null on an unrecognised flag, a missing value, or no paths.
   * @param {string[]} args args
   * @returns {string[] | null} path args, or null on reject
   */
  static pathArgs(args) {
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '-') {
      const a = checkedAt(args, i);
      // `-f FMT` (BSD) / `-c FMT` (GNU) take a format string.
      if (a === '-f' || a === '-c') {
        if (i + 1 >= args.length) return null;
        i += 2;
        continue;
      }
      if (a.startsWith('--printf=') || a.startsWith('--format=')) { i++; continue; }
      if (a === '--printf' || a === '--format') {
        if (i + 1 >= args.length) return null;
        i += 2;
        continue;
      }
      if (!/^-[LftxsZ]+$/.test(a)) return null;
      i++;
    }
    const paths = args.slice(i);
    if (paths.length === 0) return null;
    return paths;
  }
  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = StatHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }
}

/**
 * `test` / `[` — POSIX conditional-expression evaluator.
 *
 * A pure predicate: it evaluates an expression and yields only an exit code. It
 * never writes and never spawns a subprocess (command substitution / backticks
 * already bail at tokenize time, so an operand can only be a literal). The one
 * residual concern is disclosure: a file-test operator (`-f`, `-x`, …) reveals
 * via its exit code whether a path exists or is readable. To stay consistent
 * with the read-only file handlers (`ls`, `cat`, `stat`, `file`), every path
 * operand must lie inside the allowed roots — so `test` can't be used as a
 * 1-bit oracle to probe `~/.ssh` or `/etc`.
 *
 * Deliberately conservative grammar — the primary expression forms only (no
 * `-a`/`-o` conjunction, no parenthesised groups), with an optional leading `!`:
 *   - 0 args                 → false (inert)
 *   - `STRING`               → string-non-empty test (no FS)
 *   - `-n`/`-z STRING`       → string-length test (no FS)
 *   - `<file-op> PATH`       → `-e -f -d -r -w -x -s …`; PATH must be in-project
 *   - `A = B` / `A != B`     → string comparison (no FS)
 *   - `A <int-op> B`         → `-eq … -ge`; both operands integers
 *   - `A <file-op2> B`       → `-nt -ot -ef`; both operands in-project paths
 *
 * The `[` form is the same grammar with a required trailing `]` (see
 * {@link BracketHandler}).
 */
class TestHandler extends CommandHandler {
  static commandName = 'test';

  /** Unary operators whose operand is a filesystem path (must be in-project). */
  static FILE_UNARY = new Set([
    '-e', '-f', '-d', '-r', '-w', '-x', '-s', '-L', '-h',
    '-b', '-c', '-p', '-S', '-g', '-u', '-k', '-O', '-G', '-N'
  ]);
  /** Unary operators whose operand is a plain string (no FS access). */
  static STRING_UNARY = new Set(['-n', '-z']);
  /** Binary operators comparing two filesystem paths (both must be in-project). */
  static FILE_BINARY = new Set(['-nt', '-ot', '-ef']);
  /** Binary operators comparing two integers. */
  static INT_BINARY = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
  /** Binary operators comparing two strings (no FS access). */
  static STR_BINARY = new Set(['=', '!=']);

  /**
   * Reduce raw args to the bare expression: `test` passes them through; `[`
   * overrides to require and drop a trailing `]`. Returns null on a malformed
   * bracket form.
   * @param {string[]} args args
   * @returns {string[] | null} expression words, or null if malformed
   */
  static expr(args) { return args; }

  /**
   * The expression with its bracket wrapper and a single leading `!` removed.
   * @param {string[]} args args
   * @returns {string[] | null} core expression words, or null if malformed
   */
  static _primary(args) {
    const e = this.expr(args);
    if (e === null) return null;
    return e[0] === '!' ? e.slice(1) : e;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const expr = this._primary(args);
    if (expr === null) return false;
    // 0 args (false) / 1 arg (string-non-empty) touch no filesystem.
    if (expr.length <= 1) return true;
    if (expr.length === 2) {
      const op = checkedAt(expr, 0);
      const operand = checkedAt(expr, 1);
      if (this.STRING_UNARY.has(op)) return true;
      if (this.FILE_UNARY.has(op)) return pathAllowed(operand, ctx);
      return false;
    }
    if (expr.length === 3) {
      const a = checkedAt(expr, 0);
      const op = checkedAt(expr, 1);
      const b = checkedAt(expr, 2);
      if (this.STR_BINARY.has(op)) return true;
      if (this.INT_BINARY.has(op)) return /^-?\d+$/.test(a) && /^-?\d+$/.test(b);
      if (this.FILE_BINARY.has(op)) {
        return pathAllowed(a, ctx) && pathAllowed(b, ctx);
      }
      return false;
    }
    return false;
  }

  /**
   * The path operands of file-test operators, so an out-of-root path yields a
   * folder-grant remedy (like `stat`/`file`) rather than a `test *` wildcard.
   * @param {string[]} args args
   * @returns {string[] | null} path operands, [] when none, or null if malformed
   */
  static pathArgs(args) {
    const expr = this._primary(args);
    if (expr === null) return null;
    if (expr.length === 2 && this.FILE_UNARY.has(checkedAt(expr, 0))) return [checkedAt(expr, 1)];
    if (expr.length === 3 && this.FILE_BINARY.has(checkedAt(expr, 1))) return [checkedAt(expr, 0), checkedAt(expr, 2)];
    return [];
  }
}

/**
 * `[ … ]` — the bracket spelling of {@link TestHandler}. Identical grammar with
 * a mandatory closing `]`.
 */
class BracketHandler extends TestHandler {
  static commandName = '[';
  /**
   * @param {string[]} args args
   * @returns {string[] | null} expression words without the `]`, or null if absent
   */
  static expr(args) {
    if (args.length === 0 || args[args.length - 1] !== ']') return null;
    return args.slice(0, -1);
  }
}

/**
 * `find` predicate-tree validator.
 *
 * Allows read-only traversal; rejects every action that runs a subprocess or
 * mutates the filesystem (`-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`,
 * `-fprint`, `-fprintf`, `-fls`). Predicates that take a value consume the
 * next token. Values containing `$`/backticks already bail at tokenize time.
 */
class FindHandler extends CommandHandler {
  static commandName = 'find';

  static FORBIDDEN = new Set([
    '-exec', '-execdir', '-ok', '-okdir',
    '-delete',
    '-fprint', '-fprintf', '-fls', '-fprint0'
  ]);

  /** Predicates that take exactly one following value argument. */
  static VALUE_PREDICATES = new Set([
    '-name', '-iname', '-lname', '-ilname',
    '-path', '-ipath', '-wholename', '-iwholename',
    '-regex', '-iregex', '-regextype',
    '-type', '-xtype',
    '-maxdepth', '-mindepth',
    '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin',
    '-newer', '-anewer', '-cnewer',
    '-user', '-group', '-uid', '-gid',
    '-perm', '-inum', '-links',
    '-context'
  ]);

  /**
   * GNU and BSD find generalise `-newer` to `-newerXY`, where X is the
   * timestamp compared on the candidate file and Y the reference — a file, or
   * with Y = `t` a literal time spec (`-newermt "2026-08-28"`) — each letter
   * drawn from `a` access, `B` birth, `c` status-change, `m` modification,
   * `t` time-spec. A 25-entry cross product of value-taking predicates, so it
   * is matched as a family rather than enumerated in
   * {@link FindHandler.VALUE_PREDICATES}.
   */
  static NEWERXY = /^-newer[aBcmt][aBcmt]$/;

  /** Standalone predicates / flags. */
  static FLAG_PREDICATES = new Set([
    '-print', '-print0', '-ls', '-prune', '-quit',
    '-empty', '-nouser', '-nogroup',
    '-readable', '-writable', '-executable',
    '-true', '-false',
    '-depth', '-follow', '-mount', '-xdev', '-noleaf',
    '-ignore_readdir_race', '-noignore_readdir_race'
  ]);

  /**
   * Boolean / grouping operators. Grouping parens must be quoted or
   * backslash-escaped on the command line (a bare `(` is subshell syntax the
   * tokenizer treats as a control operator), but either way they arrive here
   * as word tokens with the text `(` / `)`.
   */
  static BOOL_OPS = new Set([
    '-and', '-a', '-or', '-o', '-not', '!', '(', ')', ','
  ]);

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    if (args.length === 0) return false;

    // Leading global options: -H / -L / -P, plus -D X / -O N (rare).
    let i = 0;
    while (i < args.length && /^-[HLP]$/.test(checkedAt(args, i))) i++;
    if (i < args.length && (checkedAt(args, i) === '-D' || checkedAt(args, i) === '-O')) {
      if (i + 1 >= args.length) return false;
      i += 2;
    }

    // Starting-point paths (zero or more). All must be in-project.
    while (i < args.length && !checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '!' && checkedAt(args, i) !== '(') {
      if (!pathAllowed(checkedAt(args, i), ctx)) return false;
      i++;
    }

    // Predicate tree.
    while (i < args.length) {
      const tok = checkedAt(args, i);

      if (FindHandler.FORBIDDEN.has(tok)) return false;
      // Defensive: refuse any `-fprint*` / `-fls` variant we missed.
      if (tok.startsWith('-fprint') || tok === '-fls') return false;

      if (FindHandler.BOOL_OPS.has(tok)) { i++; continue; }
      if (FindHandler.FLAG_PREDICATES.has(tok)) { i++; continue; }
      if (FindHandler.VALUE_PREDICATES.has(tok) || FindHandler.NEWERXY.test(tok)) {
        if (i + 1 >= args.length) return false;
        i += 2;
        continue;
      }
      return false;
    }
    return true;
  }

  /**
   * find prints its matched PATHS by default, and isSafe has confirmed the
   * starting-point paths are in-project — so the output is in-project paths.
   * `-ls` switches to `ls -l`-style detail (not clean paths), so it's excluded
   * from path-domain use. (`-printf` / `-fprint*` are already rejected by
   * isSafe, so no custom format can reach here.)
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    if (args.some(a => a === '-ls')) return null;
    return FindHandler.isSafe(args, ctx) ? 'inProjectPath' : null;
  }

  /**
   * find's path arguments are its starting-point paths (parsed exactly as
   * isSafe parses them, before the predicate tree). segmentRemedies re-runs the
   * full safety check with these granted, so a forbidden predicate elsewhere
   * (`-exec`, `-delete`) still suppresses the grant.
   * @param {string[]} args args
   * @returns {string[] | null} starting-point paths, or null if unparseable
   */
  static pathArgs(args) {
    if (args.length === 0) return null;
    let i = 0;
    while (i < args.length && /^-[HLP]$/.test(checkedAt(args, i))) i++;
    if (i < args.length && (checkedAt(args, i) === '-D' || checkedAt(args, i) === '-O')) {
      if (i + 1 >= args.length) return null;
      i += 2;
    }
    /** @type {string[]} */
    const paths = [];
    while (i < args.length && !checkedAt(args, i).startsWith('-') && checkedAt(args, i) !== '!' && checkedAt(args, i) !== '(') {
      paths.push(checkedAt(args, i));
      i++;
    }
    return paths;
  }
}

/**
 * `sed` — stream editor restricted to print/extract operations.
 *
 * Allowed flags: `-n` (quiet), `-E` / `-r` (extended regex), `-s` (separate
 * files), `-l N` (line-wrap length). Rejected: `-i` (in-place edit, both GNU
 * and BSD forms), `-f` (script from file — leak risk).
 *
 * Scripts (positional arg or `-e ARG`) must be "print/extract only" per
 * {@link isSafeSedScript}: address + a single safe command from
 * `p/d/n/N/=/l/q/Q/h/H/g/G/x/y/s`. Any sed command that writes a file or
 * runs a shell command (`w`, `W`, `r`, `R`, `e`) is rejected.
 *
 * Trailing arguments must be in-project paths; reading stdin (no path arg)
 * is also allowed.
 */
class SedHandler extends CommandHandler {
  static commandName = 'sed';

  /** Top-level flags that take no value. */
  static BOOL_FLAGS = new Set(['-n', '-E', '-r', '-s', '--posix']);

  /**
   * Split top-level args into scripts + trailing file paths, validating the
   * flag grammar (reject `-i` in-place, `-f` script-from-file, unknown flags,
   * value flags missing their value). Returns null on any reject. Does NOT
   * validate the scripts' safety — that's {@link isSafe}'s job; pathArgs only
   * needs the file paths.
   * @param {string[]} args args
   * @returns {{scripts: string[], paths: string[]} | null} parsed parts, or null
   */
  static _parse(args) {
    /** @type {string[]} */
    const scripts = [];
    let i = 0;
    let sawScript = false;

    // Parse flags + scripts in any order until first positional path.
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-')) {
        // First bare arg: treat as the script if we haven't seen one
        // yet via `-e`, else as a file path.
        if (!sawScript) {
          scripts.push(a);
          sawScript = true;
          i++;
          continue;
        }
        break;
      }
      if (SedHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (a === '-e' || a === '--expression') {
        if (i + 1 >= args.length) return null;
        scripts.push(checkedAt(args, i + 1));
        sawScript = true;
        i += 2;
        continue;
      }
      if (a === '-l') {
        if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      // Reject -i (in-place), -f (script-from-file), anything else.
      return null;
    }

    if (!sawScript) return null;
    return { scripts, paths: args.slice(i) };
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const parsed = SedHandler._parse(args);
    if (parsed === null) return false;
    for (const s of parsed.scripts) {
      if (!isSafeSedScript(s)) return false;
    }
    // Remaining positionals are file paths — must be in-project.
    for (const p of parsed.paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * The trailing file-path positionals. The flag/script grammar must parse
   * cleanly first; segmentRemedies re-verifies script safety with the grant.
   * @param {string[]} args args
   * @returns {string[] | null} file paths, or null on reject
   */
  static pathArgs(args) {
    const parsed = SedHandler._parse(args);
    return parsed === null ? null : parsed.paths;
  }

  /**
   * Sink form: `... | sed [flags] SCRIPT`. Stdin supplies the input, so we
   * don't need file path args (and reject them if present — there's no
   * legitimate sink usage that names a file). Flag/script parsing mirrors
   * the top-level form; `-i` and `-f` are still rejected.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    /** @type {string[]} */
    const scripts = [];
    let i = 0;
    let sawScript = false;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (!a.startsWith('-')) {
        if (!sawScript) {
          scripts.push(a);
          sawScript = true;
          i++;
          continue;
        }
        return false; // no file args in sink form
      }
      if (SedHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (a === '-e' || a === '--expression') {
        if (i + 1 >= args.length) return false;
        scripts.push(checkedAt(args, i + 1));
        sawScript = true;
        i += 2;
        continue;
      }
      if (a === '-l') {
        if (i + 1 >= args.length || !/^\d+$/.test(checkedAt(args, i + 1))) return false;
        i += 2;
        continue;
      }
      return false;
    }
    if (!sawScript) return false;
    if (i !== args.length) return false;
    for (const s of scripts) {
      if (!isSafeSedScript(s)) return false;
    }
    return true;
  }
}

/**
 * Validate a sed script for print/extract-only safety.
 *
 * Single-pass scanner. The safety boundary is purely "no command can write to
 * the filesystem or shell out" — i.e. no `w`, `W`, `r`, `R`, `e` command, and
 * no `w` flag on `s///` / `y///`. Everything else (addresses, label/branch
 * targets, text-arg commands like `a/i/c`, malformed-but-non-destructive
 * syntax) is treated as opaque: if sed errors on it at runtime that's fine,
 * the script still couldn't have written anything.
 *
 * The scanner skips over delimited regions (regex addresses, `s///` /
 * `y///` bodies, label names, branch targets) so their contents can't be
 * mistaken for command letters. After that, finding a top-level `w/W/r/R/e`
 * rejects the script.
 * @param {string} script script body
 * @returns {boolean} true if the script is safe
 */
function isSafeSedScript(script) {
  const s = script;
  if (!s || !s.trim()) return false;
  let i = 0;
  let sawCmd = false; // require at least one real command

  while (i < s.length) {
    const ch = checkedAt(s, i);

    // Whitespace / separators / negation / blocks — skip.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' ||
			ch === '!' || ch === '{' || ch === '}') {
      i++;
      continue;
    }

    // Comment to end of line.
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }

    // `/regex/` address.
    if (ch === '/') {
      i++;
      while (i < s.length && s[i] !== '/') {
        if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
        i++;
      }
      if (i >= s.length) return false;
      i++;
      continue;
    }

    // `\Xregex X` alt-delimiter address.
    if (ch === '\\' && i + 1 < s.length) {
      const d = s[i + 1];
      i += 2;
      while (i < s.length && s[i] !== d) {
        if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
        i++;
      }
      if (i >= s.length) return false;
      i++;
      continue;
    }

    // `$`-expansions: `${…}`, `$((…))`, `$NAME`. These resolve to opaque
    // values before sed runs — the tokenizer already accepted them as
    // safe value substitutions and rejected command substitution — so
    // skip the whole expansion. A bare `$` not starting an expansion is
    // sed's last-line address.
    if (ch === '$') {
      const nx = s[i + 1];
      if (nx === '{') {
        const close = s.indexOf('}', i + 2);
        if (close === -1) return false;
        i = close + 1;
        continue;
      }
      if (nx === '(' && s[i + 2] === '(') {
        let depth = 0;
        let k = i + 1;
        for (; k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) return false;
        i = k + 1;
        continue;
      }
      if (nx && /[A-Za-z0-9_]/.test(nx)) {
        i += 2;
        while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
        continue;
      }
      i++; // bare `$` — last-line address
      continue;
    }

    // Address atoms: digits, `,`, GNU `~` / `+` step forms.
    if ((ch >= '0' && ch <= '9') || ch === ',' ||
			ch === '~' || ch === '+') {
      i++;
      continue;
    }

    // Forbidden commands — anything that touches the FS or shells out.
    if (ch === 'w' || ch === 'W' || ch === 'r' || ch === 'R' || ch === 'e') {
      return false;
    }

    // `s` / `y` with delimited body.
    if (ch === 's' || ch === 'y') {
      const delim = checkedAt(s, i + 1);
      if (!delim || delim === ' ' || delim === '\t' || delim === '\n' ||
				delim === ';' || delim === '\\') return false;
      let j = i + 2;
      let fields = 0;
      while (j < s.length && fields < 2) {
        if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
        if (s[j] === delim) { fields++; j++; continue; }
        j++;
      }
      if (fields < 2) return false;
      let flags = '';
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t' &&
				s[j] !== '\n' && s[j] !== ';' && s[j] !== '}') {
        flags += s[j++];
      }
      if (ch === 's') {
        if (!/^[gpimMI0-9]*$/.test(flags)) return false;
      } else if (flags !== '') {
        return false;
      }
      i = j;
      sawCmd = true;
      continue;
    }

    // `:label` definition.
    if (ch === ':') {
      i++;
      while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
      sawCmd = true;
      continue;
    }

    // Branch commands with optional label arg.
    if (ch === 'b' || ch === 't' || ch === 'T') {
      i++;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      while (i < s.length && /[A-Za-z0-9_]/.test(checkedAt(s, i))) i++;
      sawCmd = true;
      continue;
    }

    // Text-arg commands: `a`/`i`/`c` consume to end of line.
    if (ch === 'a' || ch === 'i' || ch === 'c') {
      i++;
      while (i < s.length && s[i] !== '\n') i++;
      sawCmd = true;
      continue;
    }

    // Simple commands with no arguments.
    if (ch === 'p' || ch === 'd' || ch === 'n' || ch === 'N' ||
			ch === '=' || ch === 'l' || ch === 'q' || ch === 'Q' ||
			ch === 'h' || ch === 'H' || ch === 'g' || ch === 'G' ||
			ch === 'x' || ch === 'P' || ch === 'D' || ch === 'F' ||
			ch === 'z') {
      i++;
      sawCmd = true;
      continue;
    }

    // Unrecognised character at this position — reject conservatively.
    return false;
  }
  return sawCmd;
}

/**
 * `awk` — pattern-action scripting language. Restricted to read-only scripts:
 * the script body must contain no I/O builtins (`system`, `getline`, `exec`,
 * `ENVIRON`) and no redirection operators (`>`, `>>`, or `|` other than the
 * logical `||`). String literals (`"…"`) and regex literals (`/…/`) are
 * stripped before the forbidden-token scan so a `>` or `|` *inside* a string
 * or regex doesn't trip the check. Flags: `-F sep` (field separator), `-v
 * name=value` (variable). `-f scriptfile` is rejected — same leak-risk
 * reasoning as `sed -f`. Trailing args are in-project file paths.
 */
class AwkHandler extends CommandHandler {
  static commandName = 'awk';

  /**
   * Parse leading flags and return `{scriptIdx, restStart}` or null on reject.
   * @param {string[]} args args
   * @returns {{scriptIdx: number, restStart: number} | null} parsed positions, or null on reject
   */
  static _parseFlags(args) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (a === '--') { i++; break; }
      if (a === '-F' || a === '-v') {
        if (i + 1 >= args.length) return null;
        if (a === '-v' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(checkedAt(args, i + 1))) return null;
        i += 2;
        continue;
      }
      if (a === '-f' || a === '--file') return null;
      if (a.startsWith('-F') && a.length > 2) { i++; continue; }
      if (a.startsWith('-v') && a.length > 2) {
        if (!/^-v[A-Za-z_][A-Za-z0-9_]*=/.test(a)) return null;
        i++;
        continue;
      }
      if (a.startsWith('-')) return null;
      return { scriptIdx: i, restStart: i + 1 };
    }
    return null;
  }

  /**
   * Input files: everything after the script operand. Null when the flags or
   * the script itself are unsafe, since no folder grant could rescue those.
   * @param {string[]} args args
   * @returns {string[] | null} input file paths, or null if the shape is unsafe
   */
  static pathArgs(args) {
    const parsed = AwkHandler._parseFlags(args);
    if (!parsed) return null;
    if (!isSafeAwkScript(checkedAt(args, parsed.scriptIdx))) return null;
    return args.slice(parsed.restStart);
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    const paths = AwkHandler.pathArgs(args);
    if (paths === null) return false;
    for (const p of paths) {
      if (!pathAllowed(p, ctx)) return false;
    }
    return true;
  }

  /**
   * Sink form: stdin supplies the input, so no trailing path args allowed.
   * @param {string[]} args args
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args) {
    const parsed = AwkHandler._parseFlags(args);
    if (!parsed) return false;
    if (parsed.restStart !== args.length) return false;
    return isSafeAwkScript(checkedAt(args, parsed.scriptIdx));
  }
}

/**
 * Validate an awk script body. Strips `"…"` strings (with `\"` escapes), `/…/`
 * regex literals, and `# … \n` comments — then scans the residue for tokens
 * that imply I/O or subprocess execution:
 *   - identifiers: `system`, `getline`, `exec`, `ENVIRON`
 *   - operators: `>` (and `>>`) other than the comparison `>=`, and `|` other
 *     than the logical `||`.
 *
 * Comparison operators (`<`, `<=`, `>=`), logical (`&&`, `||`), and numeric
 * arithmetic are all preserved. The whitelist is conservative — a script that
 * relies on bare `>` as numeric greater-than has to be rewritten to use `<`,
 * or the user can save it as a pattern. The trade is intentional.
 * @param {string} script script body
 * @returns {boolean} safe
 */
function isSafeAwkScript(script) {
  if (typeof script !== 'string' || script.length === 0) return false;
  let stripped = '';
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length) { i += 2; continue; }
        i++;
      }
      if (i < script.length) i++;
      stripped += '""';
      continue;
    }
    if (ch === '/') {
      i++;
      while (i < script.length && script[i] !== '/') {
        if (script[i] === '\\' && i + 1 < script.length) { i += 2; continue; }
        i++;
      }
      if (i < script.length) i++;
      stripped += '//';
      continue;
    }
    if (ch === '#') {
      while (i < script.length && script[i] !== '\n') i++;
      continue;
    }
    stripped += ch;
    i++;
  }
  if (/\b(?:system|getline|exec|ENVIRON)\b/.test(stripped)) return false;
  // `>` allowed only as `>=`; reject `>` and `>>` and any other `>`.
  if (/>(?!=)/.test(stripped)) return false;
  // `|` allowed only as `||`; reject single `|`.
  if (/(?<!\|)\|(?!\|)/.test(stripped)) return false;
  return true;
}

/**
 * `git` — read-only subcommands only.
 *
 * Top-level git options consumed first: `-C <in-project-path>`, `--no-pager`,
 * `--git-dir=<in-project>`. Rejects `-c name=value` (could disable safety
 * with e.g. `core.hooksPath`), `--exec-path=`, `--namespace=`, and unknown
 * top-level options.
 *
 * After options, the subcommand must be in {@link READ_ONLY_SUBCOMMANDS}.
 * For each subcommand, remaining args are validated per
 * {@link SAFE_FLAGS_BY_SUB}: an arg starting with `-` must match the
 * subcommand's flag whitelist; positionals must be a ref-shaped token or an
 * in-project path.
 */
class GitHandler extends CommandHandler {
  static commandName = 'git';

  static READ_ONLY_SUBCOMMANDS = new Set([
    'diff', 'log', 'show', 'status', 'branch', 'tag', 'rev-parse',
    'ls-files', 'ls-tree', 'cat-file', 'blame', 'describe',
    'shortlog', 'name-rev', 'reflog', 'whatchanged', 'grep', 'help',
    'version', 'config',
    'stash', 'remote', 'for-each-ref', 'rev-list',
    'submodule', 'worktree', 'merge-base', 'check-ignore',
    'count-objects', 'symbolic-ref'
  ]);

  /**
   * Per-subcommand whitelists for flags starting with `-`.
   * @type {Record<string, RegExp>}
   */
  static SAFE_FLAGS_BY_SUB = {
    diff: /^(?:--(?:name-only|name-status|stat|numstat|shortstat|summary|cached|staged|color(?:=[A-Za-z]+)?|no-color|patch|no-patch|unified=\d+|raw|word-diff(?:=[A-Za-z]+)?|ignore-all-space|ignore-space-change|ignore-space-at-eol|ignore-blank-lines|check|find-renames(?:=\d+%?)?|find-copies(?:=\d+%?)?|minimal|histogram|patience|no-prefix|src-prefix=[A-Za-z0-9_./-]+|dst-prefix=[A-Za-z0-9_./-]+|diff-filter=[A-Za-z*]+|exit-code|quiet|relative(?:=[A-Za-z0-9_./-]+)?|dirstat(?:=[A-Za-z0-9,=]+)?|text|full-index|ignore-submodules(?:=[a-z]+)?|submodule(?:=[a-z]+)?)|-U\d+|-w|-b|-W|-R|-M|-C|-r|-p|-s|-a|-q)$/,
    log: /^(?:--(?:oneline|graph|all|name-only|name-status|stat|numstat|shortstat|patch|no-patch|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ]+|pretty(?:=[A-Za-z0-9_:%\- ]+)?|author=[A-Za-z0-9_@.\- ]+|since=[A-Za-z0-9_.\- :]+|until=[A-Za-z0-9_.\- :]+|after=[A-Za-z0-9_.\- :]+|before=[A-Za-z0-9_.\- :]+|grep=[A-Za-z0-9_.\- :]+|max-count=\d+|reverse|merges|no-merges|first-parent|follow|abbrev-commit|date=[A-Za-z0-9-]+|topo-order|date-order|decorate(?:=[A-Za-z]+)?|pickaxe-regex|pickaxe-all|diff-filter=[A-Za-z*]+|regexp-ignore-case|left-right|boundary|cherry-mark|cherry-pick|left-only|right-only|tags(?:=[A-Za-z0-9_*.-]+)?|branches(?:=[A-Za-z0-9_*.-]+)?|remotes(?:=[A-Za-z0-9_*.-]+)?|glob=[A-Za-z0-9_*./^-]+|ancestry-path|full-history|all-match|invert-grep|no-walk(?:=[a-z]+)?|walk-reflogs|simplify-by-decoration|simplify-merges|full-diff|diff-merges=[a-z-]+)|-n\d+|-p|-\d+|-[SG].+|-i)$/,
    show: /^(?:--(?:stat|name-only|name-status|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ]+|pretty(?:=[A-Za-z0-9_:%\- ]+)?|abbrev-commit|patch|no-patch|raw|diff-filter=[A-Za-z*]+|unified=\d+|ignore-all-space|ignore-space-change)|-s|-p|-w|-b|-U\d+)$/,
    status: /^(?:--(?:short|porcelain(?:=[Av12]+)?|branch|long|untracked-files(?:=[a-z]+)?|ignored(?:=[a-z]+)?|column(?:=[A-Za-z]+)?|no-column|ahead-behind|no-ahead-behind)|-s|-b|-u(?:[a-z]+)?)$/,
    branch: /^(?:--(?:list|all|remotes|verbose|merged|no-merged|contains|no-contains|sort=[A-Za-z0-9_:-]+|color(?:=[A-Za-z]+)?|no-color|show-current|format=[%A-Za-z0-9_:\- ()]+)|-a|-r|-v|-vv|-l)$/,
    tag: /^(?:--(?:list|sort=[A-Za-z0-9_:-]+|contains|no-contains|merged|no-merged|color(?:=[A-Za-z]+)?|no-color|format=[%A-Za-z0-9_:\- ()]+)|-l|-n\d*)$/,
    'rev-parse': /^--[A-Za-z0-9][A-Za-z0-9=-]*$/,
    'ls-files': /^(?:--(?:cached|deleted|modified|others|ignored|stage|unmerged|directory|no-empty-directory|full-name|exclude-standard)|-c|-d|-m|-o|-i|-s|-u)$/,
    'ls-tree': /^(?:--(?:full-name|full-tree|name-only|name-status|abbrev(?:=\d+)?|long|object-only)|-r|-d|-l|-t|-z)$/,
    'cat-file': /^(?:--(?:batch(?:=[A-Za-z0-9_%\- ]+)?|batch-check(?:=[A-Za-z0-9_%\- ]+)?|allow-unknown-type)|-t|-s|-e|-p)$/,
    blame: /^(?:--(?:porcelain|incremental|line-porcelain|score-debug|root|date=[A-Za-z0-9-]+|color-lines|color-by-age|abbrev=\d+)|-L\d*(?:,\d+)?|-w|-f|-n|-s|-e|-p|-l|-t|-M|-C)$/,
    describe: /^(?:--(?:all|tags|contains|abbrev=\d+|candidates=\d+|exact-match|debug|long|match=[A-Za-z0-9_*.-]+|exclude=[A-Za-z0-9_*.-]+|always|first-parent|broken|dirty(?:=[A-Za-z0-9_-]+)?))$/,
    shortlog: /^(?:--(?:numbered|summary|email|format=[%A-Za-z0-9_:\- ]+|group=[A-Za-z]+)|-n|-s|-e)$/,
    'name-rev': /^(?:--(?:tags|refs=[A-Za-z0-9_*/-]+|all|stdin|name-only|no-undefined|always))$/,
    reflog: /^(?:--(?:all|date=[A-Za-z0-9-]+)|-n\d+)$/,
    whatchanged: /^(?:-p|--stat|--name-only|--name-status)$/,
    grep: /^(?:--(?:cached|untracked|no-index|recurse-submodules|fixed-strings|extended-regexp|basic-regexp|perl-regexp|invert-match|ignore-case|word-regexp|line-number|files-with-matches|count|color(?:=[A-Za-z]+)?|no-color|context=\d+|after-context=\d+|before-context=\d+)|-c|-i|-w|-n|-l|-L|-v|-E|-F|-G|-P|-A\d+|-B\d+|-C\d+)$/,
    help: /^.*$/,
    version: /^--build-options$/,
    // `git config --get NAME` only; --set / --unset / --add / --replace-all etc forbidden.
    config: /^--(?:get|get-all|get-regexp|list|name-only|show-origin|show-scope|local|global|system|worktree|file=.+|includes|no-includes|type=[A-Za-z]+)$/,
    // Purely read-only subcommands with their own flag whitelists.
    // (branch/tag/reflog/stash/remote/submodule/worktree/symbolic-ref are handled
    // specially above and never reach the generic flagRe path.)
    'for-each-ref': /^(?:--format=[%A-Za-z0-9_():.,/ -]+|--sort=[A-Za-z0-9_:,+-]+|--count=\d+|--(?:python|perl|tcl|shell|omit-empty|ignore-case))$/,
    'rev-list': /^(?:--(?:max-count=\d+|skip=\d+|since=[A-Za-z0-9_.\- :]+|until=[A-Za-z0-9_.\- :]+|after=[A-Za-z0-9_.\- :]+|before=[A-Za-z0-9_.\- :]+|all|branches(?:=[A-Za-z0-9_*.-]+)?|tags(?:=[A-Za-z0-9_*.-]+)?|remotes(?:=[A-Za-z0-9_*.-]+)?|glob=[A-Za-z0-9_*./^-]+|stdin|topo-order|date-order|reverse|ancestry-path|first-parent|merges|no-merges|min-parents=\d+|max-parents=\d+|count|abbrev(?:=\d+)?|oneline|header|parents|children|timestamps|left-right|boundary|cherry-mark|cherry-pick|left-only|right-only)|-n\d+|-\d+)$/,
    'merge-base': /^(?:--(?:all|octopus|independent|fork-point|is-ancestor))$/,
    'check-ignore': /^(?:--(?:verbose|non-matching|stdin|no-index|quiet)|-v|-n|-q|-z)$/,
    'count-objects': /^(?:--(?:verbose|human-readable)|-v|-H)$/
  };

  /**
   * The paths git is pointed at: the repository-location options (`-C`,
   * `--git-dir=`, `--work-tree=`) plus every positional the subcommand would
   * treat as a pathspec rather than a ref — anything after `--`, and anything
   * that doesn't look like a ref name ({@link REF_RE}), which is how
   * {@link isSafePositional} classifies it.
   *
   * Best-effort by design: this decides which arguments a folder grant would
   * have to cover, not whether the command is safe. A git invocation rejected
   * for any other reason (an unknown flag, a write subcommand) fails the
   * caller's re-check with those folders granted, so no grant is offered.
   * @param {string[]} args args
   * @returns {string[] | null} path arguments, or null if the shape is unsafe
   */
  static pathArgs(args) {
    /** @type {string[]} */
    const paths = [];
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      const a = checkedAt(args, i);
      if (a === '--no-pager' || a === '--paginate' || a === '--no-replace-objects' || a === '--bare') { i++; continue; }
      if (a === '-C') {
        if (i + 1 >= args.length) return null;
        paths.push(checkedAt(args, i + 1));
        i += 2;
        continue;
      }
      if (a.startsWith('--git-dir=')) { paths.push(a.slice('--git-dir='.length)); i++; continue; }
      if (a.startsWith('--work-tree=')) { paths.push(a.slice('--work-tree='.length)); i++; continue; }
      return null;
    }
    if (i >= args.length) return null;
    if (!GitHandler.READ_ONLY_SUBCOMMANDS.has(checkedAt(args, i++))) return null;
    let pathspecs = false;
    for (let j = i; j < args.length; j++) {
      const a = checkedAt(args, j);
      if (a === '--') { pathspecs = true; continue; }
      if (!pathspecs && (a.startsWith('-') || GitHandler.REF_RE.test(a))) continue;
      paths.push(a);
    }
    return paths;
  }

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    let i = 0;
    // Top-level options before the subcommand.
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      const a = checkedAt(args, i);
      if (a === '--no-pager' || a === '--paginate' || a === '--no-replace-objects' || a === '--bare') { i++; continue; }
      if (a === '-C') {
        if (i + 1 >= args.length) return false;
        if (!pathAllowed(checkedAt(args, i + 1), ctx)) return false;
        i += 2;
        continue;
      }
      if (a.startsWith('--git-dir=')) {
        if (!pathAllowed(a.slice('--git-dir='.length), ctx)) return false;
        i++;
        continue;
      }
      if (a.startsWith('--work-tree=')) {
        if (!pathAllowed(a.slice('--work-tree='.length), ctx)) return false;
        i++;
        continue;
      }
      // `-c name=value` could disable safety (e.g. core.hooksPath); reject.
      return false;
    }

    if (i >= args.length) return false;
    const sub = checkedAt(args, i++);
    if (!GitHandler.READ_ONLY_SUBCOMMANDS.has(sub)) return false;

    // `config` must be a read-only invocation. Reject any positional that
    // looks like a value (the writes are `git config NAME VALUE`).
    if (sub === 'config') {
      let sawGet = false;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a.startsWith('-')) {
          if (!/** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.config).test(a)) return false;
          if (/^--(get|get-all|get-regexp|list)/.test(a)) sawGet = true;
          continue;
        }
        // Bare positional: only allowed as the NAME for --get/--get-all/--get-regexp.
        if (!sawGet) return false;
      }
      return true;
    }

    // `branch` / `tag`: a bare positional without a consuming-flag context
    // would be a new branch or tag name (a write operation). Positionals are
    // only permitted as:
    //   - the ref value consumed by --contains/--no-contains/--merged/--no-merged
    //   - a glob pattern after --list/-l (filters the listing, never creates)
    if (sub === 'branch' || sub === 'tag') {
      const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB[sub]);
      const REF_CONSUMING = new Set(['--contains', '--no-contains', '--merged', '--no-merged']);
      let wantRef = false;
      let listMode = false;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a === '--') return false; // positionals after -- are branch/tag names
        if (a.startsWith('-')) {
          if (!flagRe.test(a)) return false;
          if (REF_CONSUMING.has(a)) { wantRef = true; continue; }
          if (a === '--list' || a === '-l') { listMode = true; continue; }
          continue;
        }
        if (wantRef) {
          if (!GitHandler.isSafePositional(a, ctx)) return false;
          wantRef = false;
          continue;
        }
        if (listMode) {
          // Glob pattern for --list (e.g. 'v1.*'): filters the listing, not a write.
          listMode = false;
          continue;
        }
        // No consuming-flag context: this positional is a new branch/tag name (write op).
        return false;
      }
      return true;
    }

    // `reflog`: the show/walk form is read-only; expire/delete/drop are destructive.
    if (sub === 'reflog') {
      const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.reflog);
      const DESTRUCTIVE_REFLOG = new Set(['expire', 'delete', 'drop']);
      let j = i;
      while (j < args.length && checkedAt(args, j).startsWith('-')) {
        if (!flagRe.test(checkedAt(args, j))) return false;
        j++;
      }
      if (j < args.length) {
        const first = checkedAt(args, j);
        if (DESTRUCTIVE_REFLOG.has(first)) return false;
        if (first === 'show') j++;
        for (let k = j; k < args.length; k++) {
          const a = checkedAt(args, k);
          if (a.startsWith('-')) {
            if (!flagRe.test(a)) return false;
          } else {
            if (!GitHandler.isSafePositional(a, ctx)) return false;
          }
        }
      }
      return true;
    }

    // `stash`: only 'list' and 'show' are read-only. Bare 'git stash' is
    // equivalent to 'stash push' and stashes working-tree changes (write op).
    if (sub === 'stash') {
      if (i >= args.length) return false;
      const stashSub = checkedAt(args, i++);
      if (stashSub === 'list') {
        for (let j = i; j < args.length; j++) {
          if (!/** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB.log).test(checkedAt(args, j))) return false;
        }
        return true;
      }
      if (stashSub === 'show') {
        const showFlags = /^(?:--(?:stat|numstat|shortstat|name-only|name-status|patch|no-patch|unified=\d+|diff-filter=[A-Za-z*]+|raw|color(?:=[A-Za-z]+)?|no-color)|-p|-U\d+|-s|-u|-w|-b)$/;
        for (let j = i; j < args.length; j++) {
          const a = checkedAt(args, j);
          if (a.startsWith('-')) {
            if (!showFlags.test(a)) return false;
          } else {
            if (!GitHandler.isSafePositional(a, ctx)) return false;
          }
        }
        return true;
      }
      return false; // push/pop/apply/drop/clear/branch → all write ops
    }

    // `remote`: only listing forms and two read queries are safe.
    if (sub === 'remote') {
      let j = i;
      if (j < args.length && (checkedAt(args, j) === '-v' || checkedAt(args, j) === '--verbose')) j++;
      if (j >= args.length) return true; // bare list or -v list
      const remoteSub = checkedAt(args, j++);
      if (remoteSub !== 'show' && remoteSub !== 'get-url') return false;
      for (let k = j; k < args.length; k++) {
        const a = checkedAt(args, k);
        if (a.startsWith('-')) return false;
        // Remote names are simple identifiers (no shell-special chars).
        if (!/^[A-Za-z0-9_.-]+$/.test(a)) return false;
      }
      return true;
    }

    // `submodule`: only 'status' and 'summary' are read-only.
    if (sub === 'submodule') {
      const smFlags = /^(?:--quiet|--recursive|-q)$/;
      let j = i;
      while (j < args.length && checkedAt(args, j).startsWith('-')) {
        if (!smFlags.test(checkedAt(args, j))) return false;
        j++;
      }
      if (j >= args.length) return false;
      const smSub = args[j++];
      if (smSub !== 'status' && smSub !== 'summary') return false;
      const smBodyFlags = /^(?:--recursive|--cached|--files|--summary-limit=\d+)$/;
      for (let k = j; k < args.length; k++) {
        const a = checkedAt(args, k);
        if (a.startsWith('-')) {
          if (!smBodyFlags.test(a)) return false;
        } else {
          if (!GitHandler.isSafePositional(a, ctx)) return false;
        }
      }
      return true;
    }

    // `worktree`: only 'list' is read-only.
    if (sub === 'worktree') {
      if (i >= args.length) return false;
      if (checkedAt(args, i++) !== 'list') return false;
      for (let j = i; j < args.length; j++) {
        if (!/^(?:--porcelain|-v|--verbose|-z)$/.test(checkedAt(args, j))) return false;
      }
      return true;
    }

    // `symbolic-ref`: the single-positional form reads a ref. Two positionals
    // is the write (set) form; --delete/-d is an explicit delete.
    if (sub === 'symbolic-ref') {
      const sfFlags = /^(?:--short|--quiet|-q)$/;
      let positionals = 0;
      for (let j = i; j < args.length; j++) {
        const a = checkedAt(args, j);
        if (a.startsWith('-')) {
          if (!sfFlags.test(a)) return false;
          continue;
        }
        if (++positionals > 1) return false; // two positionals = write form
      }
      return positionals === 1;
    }

    const flagRe = /** @type {RegExp} */ (GitHandler.SAFE_FLAGS_BY_SUB[sub]);
    if (!flagRe) return false;

    // Short flags that take a separate numeric value for select subcommands
    // (e.g. `git log -n 10`, `git diff -U 5`). Conservatively numeric so a
    // path can never be consumed as the value.
    const numericValueFlags = GitHandler.NUMERIC_VALUE_FLAGS_BY_SUB[sub] || null;

    let positionalsStart = false;
    for (let j = i; j < args.length; j++) {
      const a = checkedAt(args, j);
      if (a === '--') { positionalsStart = true; continue; }
      if (a.startsWith('-') && !positionalsStart) {
        if (numericValueFlags && numericValueFlags.has(a)) {
          if (j + 1 >= args.length || !/^\d+$/.test(checkedAt(args, j + 1))) return false;
          j++;
          continue;
        }
        if (!flagRe.test(a)) return false;
        continue;
      }
      if (!GitHandler.isSafePositional(a, ctx)) return false;
    }
    return true;
  }

  /**
   * git generalises in two tiers: subcommand-scoped (`git push *`) then
   * command-scoped (`git *`). The subcommand is the first token that isn't a
   * top-level option; if we can't find one, only the command-scoped tier is
   * offered.
   * @param {string[]} words segment words (`git` first)
   * @returns {string[]} generalisation patterns, narrowest→broadest
   */
  static suggestPatterns(words) {
    /** @type {string[]} */
    const out = [];
    let i = 1;
    // Skip a leading `-C <path>` pair and any other top-level options so the
    // subcommand is the first bare word we land on.
    while (i < words.length && checkedAt(words, i).startsWith('-')) {
      if (checkedAt(words, i) === '-C' && i + 1 < words.length) i += 2;
      else i++;
    }
    const sub = words[i];
    if (sub && !sub.startsWith('-')) out.push(`git ${sub} *`);
    out.push('git *');
    return out;
  }

  /**
   * Of the read-only subcommands, only `git ls-files` emits a list of
   * in-project repository paths; the others print content or metadata. isSafe
   * has already confirmed the invocation is read-only and in-project.
   * @param {string[]} args args (subcommand included)
   * @param {ApprovalCtx} ctx ctx
   * @returns {'inProjectPath' | null} output-path domain
   */
  static outputPathDomain(args, ctx) {
    if (!GitHandler.isSafe(args, ctx)) return null;
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      if (checkedAt(args, i) === '-C' && i + 1 < args.length) i += 2;
      else i++;
    }
    return checkedAt(args, i) === 'ls-files' ? 'inProjectPath' : null;
  }

  /** @type {Record<string, Set<string>>} */
  static NUMERIC_VALUE_FLAGS_BY_SUB = {
    log: new Set(['-n']),
    diff: new Set(['-U']),
    blame: new Set(['-L'])
  };

  /**
   * Ref-shaped tokens: `HEAD`, `main`, `v1.2.3`, `origin/main`, `abc123^`,
   * `stash@{0}`, `HEAD@{1}` (reflog selectors).
   */
  static REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}:-]*$/;

  /**
   * @param {string} arg arg
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe positional
   */
  static isSafePositional(arg, ctx) {
    // Ref ranges: `A..B`, `A...B`. Either side may be empty.
    const rangeMatch = arg.match(/^(.*?)(\.{2,3})(.*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[3])) {
      const [, left, , right] = rangeMatch;
      if (left && !GitHandler.REF_RE.test(left)) return GitHandler.isPathPositional(arg, ctx);
      if (right && !GitHandler.REF_RE.test(right)) return GitHandler.isPathPositional(arg, ctx);
      return true;
    }
    if (GitHandler.REF_RE.test(arg)) return true;
    return GitHandler.isPathPositional(arg, ctx);
  }

  /**
   * @param {string} arg arg
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} in-project path
   */
  static isPathPositional(arg, ctx) {
    return pathAllowed(arg, ctx);
  }
}

/**
 * `xargs <safe-command> [pre-args...]` — runs a read-only command on tokens
 * read from stdin. The stdin tokens become trailing positional args of the
 * sub-command, so we cannot path-validate them; instead we restrict the
 * sub-command to a fixed allowlist of read-only handlers and validate every
 * pre-arg through that handler's own `isSafe` (with a sentinel root that
 * tolerates the trailing stdin args). The expected pipeline shape is
 * `<safe-producer> | xargs <safe-reader>`, e.g. `find … | xargs grep -l …`.
 *
 * xargs's own flags are restricted to read-only quoting/parallelism options:
 * `-0`, `--null`, `-r`, `--no-run-if-empty`, `-t`, `-P N`, `-n N`, `-L N`,
 * `-I STR`, `-d C`. Reject `-a FILE` (alt input), `-s` (size), `-E` and
 * everything else.
 */
class XargsHandler extends CommandHandler {
  static commandName = 'xargs';

  /** Sub-commands xargs may invoke. Must be read-only and in the registry. */
  static SAFE_SUBCOMMANDS = new Set(['grep', 'head', 'tail', 'wc', 'cat', 'file', 'stat', 'sed', 'ls', 'du', 'echo', 'printf']);

  /** xargs flags that take no value. */
  static BOOL_FLAGS = new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive']);

  /** xargs flags that take exactly one value. Value is restricted per flag. */
  static VALUE_FLAGS = new Set(['-n', '-L', '-P', '-I', '-d']);

  /**
   * @param {string[]} args args
   * @param {ApprovalCtx} ctx ctx
   * @returns {boolean} safe
   */
  static isSafe(args, ctx) {
    let i = 0;
    while (i < args.length) {
      const a = checkedAt(args, i);
      if (XargsHandler.BOOL_FLAGS.has(a)) { i++; continue; }
      if (XargsHandler.VALUE_FLAGS.has(a)) {
        if (i + 1 >= args.length) return false;
        const v = checkedAt(args, i + 1);
        if (a === '-n' || a === '-L' || a === '-P') {
          if (!/^\d+$/.test(v)) return false;
        } else if (a === '-I') {
          if (!/^[A-Za-z_{}][A-Za-z0-9_{}]*$/.test(v)) return false;
        } else if (a === '-d') {
          if (v.length !== 1 && v !== '\\0' && v !== '\\n' && v !== '\\t') return false;
        }
        i += 2;
        continue;
      }
      // Anything else (including `-a FILE`, `-s N`, `-E STR`, unknown options) is rejected.
      if (a.startsWith('-')) return false;
      break;
    }

    if (i >= args.length) return false;
    const sub = checkedAt(args, i);
    if (!XargsHandler.SAFE_SUBCOMMANDS.has(sub)) return false;
    const subHandler = COMMAND_HANDLERS.get(sub);
    if (!subHandler) return false;

    // Validate the sub-command's pre-args. stdin-supplied args at runtime
    // are read-only filenames from the upstream segment (which we
    // validated independently), so we don't need to model them here —
    // but we must not let an injected `-f FILE` or out-of-project pre-arg
    // slip through. Use the sub-handler's own isSafe with the project ctx.
    const preArgs = args.slice(i + 1);
    return subHandler.isSafe(preArgs, ctx);
  }

  /**
   * xargs in sink position has the same rules.
   * @param {string[]} args args
   * @param {RedirectCfg} [cfg] redirect policy, forwarded to the sub-handler
   * @returns {boolean} safe sink
   */
  static isSafeAsSink(args, cfg) {
    // Approximate: when called as a sink we have no ctx for path checks.
    // Reject path-shaped pre-args by requiring every pre-arg either start
    // with `-` (matching the sub-handler's whitelist) or be a quoted
    // pattern with no `/`. The sub-handler's full validation runs at
    // top-level isSafe; here we accept the common pipeline shapes.
    let i = 0;
    while (i < args.length && checkedAt(args, i).startsWith('-')) {
      if (XargsHandler.BOOL_FLAGS.has(checkedAt(args, i))) { i++; continue; }
      if (XargsHandler.VALUE_FLAGS.has(checkedAt(args, i))) {
        if (i + 1 >= args.length) return false;
        i += 2;
        continue;
      }
      return false;
    }
    if (i >= args.length) return false;
    const sub = checkedAt(args, i);
    if (!XargsHandler.SAFE_SUBCOMMANDS.has(sub)) return false;
    const subHandler = COMMAND_HANDLERS.get(sub);
    if (!subHandler) return false;
    // Delegate to the sub-handler's own sink check so `-f FILE` etc. are
    // still rejected. Forward cfg so a writing sub-sink (`tee`) can scope its
    // file operands against the allowed roots.
    return subHandler.isSafeAsSink(args.slice(i + 1), cfg);
  }
}

/**
 * Key each handler by its own `commandName`. An unnamed handler, or two that
 * claim one name (a copied class that kept its parent's), throws at load
 * rather than leaving the later one silently shadowed.
 * @param {Array<typeof CommandHandler>} handlers - Every concrete handler class.
 * @returns {Map<string, typeof CommandHandler>} Handlers by command name.
 */
function registerHandlers(handlers) {
  /** @type {Map<string, typeof CommandHandler>} */
  const byName = new Map();
  for (const handler of handlers) {
    const name = handler.commandName;
    if (!name) throw new Error(`${handler.name} has no commandName`);
    const taken = byName.get(name);
    if (taken) throw new Error(`${taken.name} and ${handler.name} both claim "${name}"`);
    byName.set(name, handler);
  }
  return byName;
}

/**
 * Registry — add a class and list it here to support a new command.
 * `_tests/command-handlers-registry-test.js` fails on a named class left out.
 *
 * The list is cast rather than left to inference: handler subclasses narrow the
 * base signatures they override (a handler that ignores `ctx` declares one
 * parameter), so left to itself the checker hunts for a common supertype across
 * the union and settles on whichever handler comes first. Naming the element
 * type states the intent — every entry is a `CommandHandler` subclass — and
 * keeps that inference from turning on the order of this list.
 */
export const COMMAND_HANDLERS = registerHandlers(/** @type {Array<typeof CommandHandler>} */ ([
  PwdHandler, WhoamiHandler, IdHandler, DateHandler, TrueHandler, FalseHandler, ColonHandler,
  HostnameHandler, UptimeHandler, SleepHandler, UnameHandler, EchoHandler, PrintfHandler,
  WhichHandler, TypeHandler, CommandBuiltinHandler, CdHandler, LsHandler, DuHandler, TailHandler,
  HeadHandler, WcHandler, StringsHandler, OdHandler, XxdHandler, HexdumpHandler, NlHandler,
  TacHandler, RevHandler, FoldHandler, ExpandHandler, UnexpandHandler, PasteHandler, JoinHandler,
  ColumnHandler, CksumHandler, Md5sumHandler, Sha1sumHandler, Sha256sumHandler, Sha512sumHandler,
  ShasumHandler, CommHandler, CmpHandler, DiffHandler, RealpathHandler, DfHandler, BasenameHandler,
  DirnameHandler, SeqHandler, SortHandler, UniqHandler, CutHandler, TrHandler, CatHandler,
  TeeHandler, FileHandler, StatHandler, TestHandler, BracketHandler, FindHandler, GrepHandler,
  SedHandler, GitHandler, AwkHandler, XargsHandler
]));
