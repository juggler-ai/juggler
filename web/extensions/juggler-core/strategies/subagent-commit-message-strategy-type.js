//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { APPROVAL_POLICY } from 'juggler/strategy-type';
import { markUntranslated } from 'juggler/i18n';
import SubagentStrategyType from '../context-items/subagents/subagent-strategy.js';

/**
 * The shell tool, whose commands {@link CommitMessageSubagentStrategyType#refuseToolCall} whitelists.
 * @type {string}
 */
const SHELL_TOOL = 'bash';

/**
 * The tools a commit-message run may call.
 * @type {readonly string[]}
 */
const TOOLS = Object.freeze(['read', 'grep', 'glob', SHELL_TOOL]);

/**
 * The tools approved whatever their input.
 * @type {readonly string[]}
 */
const READ_TOOLS = Object.freeze(['read', 'grep', 'glob']);

/**
 * Git subcommands that only read the repository. `branch` and `tag` are not
 * here: each lists only under particular flags, and is checked on its own.
 * @type {ReadonlySet<string>}
 */
const GIT_READERS = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'ls-files', 'ls-tree', 'rev-parse',
  'cat-file', 'grep', 'shortlog', 'describe', 'merge-base'
]);

/**
 * The flags under which `git branch` only lists.
 * @type {ReadonlySet<string>}
 */
const BRANCH_LIST_FLAGS = new Set(['--list', '-a', '-r', '-v']);

/**
 * Readers allowed with any arguments {@link isReadOnlyReader} does not refuse.
 * @type {ReadonlySet<string>}
 */
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'sed', 'sort', 'uniq', 'awk']);

/**
 * A `sed -n` script that only prints: `;`-separated commands, each an optional
 * address or range (a line number, `$`, or a `/regex/` without a slash in it)
 * followed by `p`, `q` or `=`. Anything that could write (`w`, `s///w`) or run
 * (`e`) a command is outside it.
 */
const SED_PRINT_SCRIPT = /^\s*(?:(?:\d+|\$|\/[^/]*\/)(?:\s*,\s*(?:\d+|\$|\/[^/]*\/))?)?\s*[pq=]\s*(?:;\s*(?:(?:\d+|\$|\/[^/]*\/)(?:\s*,\s*(?:\d+|\$|\/[^/]*\/))?)?\s*[pq=]\s*)*;?\s*$/;

/**
 * One command of a shell line, between separators.
 * @typedef {object} Segment
 * @property {string} text - The segment as written, trimmed
 * @property {string[]} words - Its words, quotes removed
 * @property {boolean} redirects - Has an unquoted `>` or `<`
 * @property {boolean} substitutes - Has `$(` or a backtick, anywhere
 * @property {boolean} backgrounds - Has an unquoted lone `&`
 */

/**
 * Split a shell line into the commands between `|`, `||`, `&&`, `;` and
 * newlines, outside quotes. A deliberately small reading of the shell: single
 * and double quotes and backslash escapes, nothing else — anything it does not
 * understand is left in a word, where the whitelist then refuses it.
 * @param {string} command - The shell line
 * @returns {Segment[]} The non-empty segments, in order
 */
function splitShellLine(command) {
  /** @type {Segment[]} */
  const segments = [];
  /** @type {Segment} */
  let seg = { text: '', words: [], redirects: false, substitutes: false, backgrounds: false };
  let raw = '';
  let word = '';
  let inWord = false;
  /** @type {''|'"'|"'"} */
  let quote = '';

  const endWord = () => {
    if (inWord) seg.words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    seg.text = raw.trim();
    if (seg.text) segments.push(seg);
    seg = { text: '', words: [], redirects: false, substitutes: false, backgrounds: false };
    raw = '';
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === '`' || (c === '$' && next === '(')) seg.substitutes = true;

    if (quote === "'") {
      raw += c;
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (quote === '"') {
      raw += c;
      if (c === '"') quote = '';
      else if (c === '\\' && next !== undefined) { word += next; raw += next; i++; }
      else word += c;
      continue;
    }

    if (c === '\\' && next !== undefined) {
      raw += c + next;
      if (next !== '\n') { word += next; inWord = true; }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      raw += c;
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\n' || c === ';') { endSegment(); continue; }
    if (c === '|') { endSegment(); if (next === '|') i++; continue; }
    if (c === '&') {
      if (next === '&') { endSegment(); i++; continue; }
      seg.backgrounds = true;
    }
    if (c === '>' || c === '<') seg.redirects = true;
    raw += c;
    if (c === ' ' || c === '\t') endWord();
    else { word += c; inWord = true; }
  }
  endSegment();
  return segments;
}

/**
 * Whether a `git …` command only reads.
 * @param {string[]} words - The command's words, `git` first
 * @returns {boolean} True when it is a read-only git command
 */
function isReadOnlyGit(words) {
  let i = 1;
  while (i < words.length) {
    if (words[i] === '-C') {
      if (i + 1 >= words.length) return false;
      i += 2;
    } else if (words[i] === '--no-pager') {
      i++;
    } else {
      break;
    }
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  // A file written by --output, or a pager run by grep's -O, is a write or a
  // command in a reader's clothing.
  if (args.some(a => a.startsWith('--output') || a === '-O' || a.startsWith('--open-files-in-pager'))) return false;
  if (sub === 'branch') return args.every(a => BRANCH_LIST_FLAGS.has(a));
  if (sub === 'tag') {
    return args.some(a => a === '-l' || a === '--list')
      && args.every(a => a === '-l' || a === '--list' || !a.startsWith('-'));
  }
  return sub !== undefined && GIT_READERS.has(sub);
}

/**
 * Whether a reader command only reads.
 * @param {string[]} words - The command's words, the reader first
 * @returns {boolean} True when it is allowed
 */
function isReadOnlyReader(words) {
  const [name, ...args] = words;
  if (name === undefined || !READERS.has(name)) return false;
  switch (name) {
    case 'sort':
      return !args.some(a => a === '-o' || a.startsWith('--output') || /^-[^-]*o/.test(a));
    case 'rg':
      return !args.some(a => a === '--pre' || a.startsWith('--pre='));
    case 'sed': {
      if (args[0] !== '-n') return false;
      const rest = args.slice(1);
      if (rest.some(a => a.startsWith('-'))) return false;
      const script = rest[0];
      return script !== undefined && SED_PRINT_SCRIPT.test(script);
    }
    case 'awk':
    // The program may not run a command or write a file: no system(), and no
    // `|` or `>` at all (a comparison is refused with them, conservatively).
      if (args.some(a => a === '-f' || a.startsWith('-i') || a.startsWith('--'))) return false;
      return !args.some(a => /system|getline|[|>]/.test(a));
    default:
      return true;
  }
}

/**
 * The hidden strategy a commit-message run works under: it reads the staged
 * changes of one repository and answers with the commit message alone.
 *
 * Nobody attends the run, and nothing in it may change the repository, so its
 * `bash` is a whitelist: {@link refuseToolCall} lets through only read-only git
 * subcommands and a short list of readers, with no redirection, command
 * substitution or backgrounding, and denies everything else with a reason the
 * model can work around. `getApprovalPolicy` approves exactly what that lets
 * through, so no call it allows ever waits for a person.
 * @augments {SubagentStrategyType}
 */
export default class CommitMessageSubagentStrategyType extends SubagentStrategyType {
  /**
   * Strategy manifest.
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'subagent-commit-message',
    name: 'Commit message (sub-agent)',
    version: '1.0.0',
    description: 'Writes a commit message for staged changes, with read-only tools and read-only git.',
    author: 'Juggler Team',
    hidden: true,
    showsApprovalControls: false
  };

  /** @type {string} */
  static GUIDANCE = markUntranslated([
    'COMMIT MESSAGE: Write a commit message for the staged changes of the repository named in the user prompt.',
    '',
    'Explore with read-only tools only: `git diff --cached` (with `--stat` or `--name-only` for an overview), ' +
      '`git log` for the repository\'s message style, `git show`, and reading files for context. ' +
      'Nothing that changes the repository will run.',
    '',
    'Reply with the commit message and nothing else: a summary line of 72 characters or fewer, a blank line, ' +
      'then a body whose paragraphs are not hard-wrapped (one line per paragraph). Follow the repository ' +
      'conventions given in the prompt. No preamble, no explanation, no code fences.'
  ].join('\n'));

  /**
   * Only `read`, `grep`, `glob` and `bash`; `bash` is constrained by
   * {@link refuseToolCall}.
   * @override
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - All available tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]} The four tools
   */
  filterTools(tools) {
    return this.withoutWithheld(tools).filter(t => TOOLS.includes(t.name));
  }

  /**
   * Refuse every tool but the four, and any `bash` command that is not a
   * whitelisted read: each segment between `|`, `&&`, `||`, `;` and newlines
   * must be a read-only `git` subcommand (after any `-C <dir>` and
   * `--no-pager`) or one of the readers, with no redirection, `$(`, backtick
   * or `&`. The refusal names the first segment that failed.
   * @override
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined}} info - The call
   * @returns {string} The refusal, or '' to let the call through
   */
  refuseToolCall({ toolName, toolInput }) {
    if (READ_TOOLS.includes(toolName)) return '';
    if (toolName !== SHELL_TOOL) {
      return markUntranslated(`Refused: ${toolName} is not available here. Use read, grep, glob or read-only bash.`);
    }
    const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
    const segments = splitShellLine(command);
    if (segments.length === 0) return markUntranslated('Refused: the command is empty.');
    for (const seg of segments) {
      if (seg.substitutes) {
        return markUntranslated(`Refused: "${seg.text}" uses command substitution ($( or a backtick), which is not allowed here.`);
      }
      if (seg.redirects) {
        return markUntranslated(`Refused: "${seg.text}" redirects input or output (> or <), which is not allowed here.`);
      }
      if (seg.backgrounds) {
        return markUntranslated(`Refused: "${seg.text}" runs in the background (&), which is not allowed here.`);
      }
      const ok = seg.words[0] === 'git' ? isReadOnlyGit(seg.words) : isReadOnlyReader(seg.words);
      if (!ok) {
        return markUntranslated(`Refused: "${seg.text}" is not a read-only command allowed here. Only read-only git ` +
          '(log, show, diff, status, blame, ls-files, ls-tree, rev-parse, cat-file, grep, shortlog, describe, ' +
          'merge-base, branch listing, tag -l; optionally after -C <dir> and --no-pager) and the readers cat, ' +
          'head, tail, wc, ls, grep, rg, sed -n, sort, uniq and awk may run.');
      }
    }
    return '';
  }

  /**
   * Approve the read tools, and `bash` when {@link refuseToolCall} lets it
   * through. Anything else parks, for `onToolPending` to refuse — whatever the
   * permission system would have allowed, since a saved rule may permit a
   * command this run must not make.
   * @override
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean, interactionKind: string, autoApprovable: boolean}} info - Approval context
   * @returns {'approve'|'require-approval'|'default'} Approval policy
   */
  getApprovalPolicy({ toolName, toolInput, category, autoApprovable }) {
    if (autoApprovable !== false && TOOLS.includes(toolName)
        && this.refuseToolCall({ toolName, toolInput, category }) === '') {
      return APPROVAL_POLICY.APPROVE;
    }
    return APPROVAL_POLICY.REQUIRE_APPROVAL;
  }
}
