//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { translator, markUntranslated } from 'juggler/i18n';
import { shellKill, MAX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS } from 'juggler/ops';
import { createHighlightedCode, createSummaryWithSubtitle, renderLiveTaskOutput, pinSource, canPinSource } from 'juggler/ui';
import { resolveAgainstCwd, posixNormalize, canonicalRoot, isGrantableRoot } from 'juggler/utils/path-containment';
import { isCommandAutoApproved, suggestApprovalPatterns, MAX_SUGGESTED_PATTERN_LENGTH } from './execute/command-approval.js';
import { isShellCommandPermitted, isShellCommandCatastrophic } from './execute/command-permission.js';
import { renderExecutePermissionSection } from './execute/permission-section.js';
import { homeBase, tildeify, untildeify } from './path-approval.js';

const t = translator('@juggler/core');

/**
 * Progress event emitted during execution.
 * @typedef {object} ProgressEvent
 * @property {'stdout'|'stderr'|'status'|'percent'} type - Type of progress event
 * @property {string} [content] - Content for stdout/stderr types
 * @property {string} [message] - Message for status type
 * @property {number} [percent] - Progress percentage (0-100) for percent type
 */

/**
 * Pretty-print a millisecond timeout as a human duration, e.g. "30 seconds",
 * "2 minutes", "1 minute 30 seconds".
 * @param {number} ms - Timeout in milliseconds
 * @returns {string} Human-readable duration
 */
function prettyTimeout(ms) {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return t('{seconds, plural, one {# second} other {# seconds}}', { seconds });
  if (seconds === 0) return t('{minutes, plural, one {# minute} other {# minutes}}', { minutes });
  return t('{minutes, plural, one {# minute} other {# minutes}} {seconds, plural, one {# second} other {# seconds}}',
    { minutes, seconds });
}

/**
 * The running tasks, as something the board can be asked to show. Named by kind, so this plugin never imports the pin that shows them.
 * @type {import('juggler/pinboard-item-type').PinSource}
 */
const TASKS_SOURCE = { kind: 'tasks' };

/**
 * Describe a background task's state for the live output section's status line.
 * A background run's exit is otherwise invisible: the tool-action's own outcome
 * froze at "started OK" the moment the process was spawned.
 * @param {import('../../../sdk/lib/live-task-output.js').TaskOutputState} state - Latest task state
 * @returns {string} One line of status
 */
function describeTaskStatus(state) {
  switch (state.status) {
    case 'running':
      return t('Running');
    case 'completed':
    case 'failed': {
      const code = Number(state.exitCode ?? 0);
      return state.error ? t('Exit {code} — {error}', { code, error: state.error }) : t('Exit {code}', { code });
    }
    case 'not_found':
      return t('Gone — reaped an hour after it ended, or lost to a server restart');
    default:
      return String(state.status || '');
  }
}

/**
 * Format a shell command for the properties panel by putting each chained
 * sub-command on its own line. Splits at top-level operators (those outside
 * quotes), with the newline placed according to the operator:
 *   - `&&` — the newline goes BEFORE the operator, so it starts the
 *     continuation line: `cd /foo && cat bar` → "cd /foo\n&& cat bar".
 *   - `;`  — the newline goes AFTER the operator, so the `;` stays at the end
 *     of its line: `make build; rm bar` → "make build;\nrm bar".
 * Operators inside a quoted string are left untouched. Commands without a
 * top-level `&&` or `;` are returned unchanged.
 * @param {string} command - The raw shell command
 * @returns {string} The command with chained sub-commands on separate lines
 */
function formatCommandForDisplay(command) {
  // Scan for top-level operators (those outside quotes), slicing the command
  // into segments. Each segment records the operator that PRECEDED it (null for
  // the first); a run like `;;` counts as a single boundary.
  /** @type {Array<{op: '&&'|';'|null, text: string}>} */
  const segments = [];
  let start = 0;
  /** @type {'&&'|';'|null} */
  let op = null;
  let quote = ''; // '', "'", '"', or '`'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    // A top-level `&&` (exactly two ampersands, not part of a longer run).
    if (ch === '&' && command[i + 1] === '&' && command[i - 1] !== '&' && command[i + 2] !== '&') {
      segments.push({ op, text: command.slice(start, i) });
      op = '&&';
      start = i + 2;
      i++; // skip the second '&' (the loop's i++ skips to `start`)
      continue;
    }
    // A top-level `;` (a run like `;;` is one boundary).
    if (ch === ';') {
      segments.push({ op, text: command.slice(start, i) });
      op = ';';
      while (command[i + 1] === ';') i++;
      start = i + 1;
    }
  }
  segments.push({ op, text: command.slice(start) });
  if (segments.length <= 1) return command;

  // Render each segment on its own line: `&&` prefixes its line, while `;`
  // suffixes the PREVIOUS line. Empty segments (surrounding whitespace or a
  // trailing operator) are dropped, so a dangling `;`/`&&` simply disappears.
  /** @type {string[]} */
  const lines = [];
  for (const { op: sep, text } of segments) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (sep === ';' && lines.length) lines[lines.length - 1] += ';';
    lines.push(sep === '&&' ? `&& ${trimmed}` : trimmed);
  }
  return lines.join('\n');
}

/**
 * Reduce a path to a comparable absolute form: relative paths resolve against
 * the working directory, `.`/`..` segments collapse, and on Windows the
 * backslash and case spellings of one directory fold together.
 * @param {string} p - Path to canonicalise
 * @param {string} cwd - Directory a relative path is relative to
 * @param {string} platform - 'darwin', 'linux', or 'windows'
 * @returns {string} Comparable path
 */
function comparableDir(p, cwd, platform) {
  const slashed = platform === 'windows' ? p.replace(/\\/g, '/') : p;
  const abs = posixNormalize(resolveAgainstCwd(slashed, cwd, platform));
  return platform === 'windows' ? abs.toLowerCase() : abs;
}

/**
 * Drop a leading `cd <project-directory> &&` from a command, for the one-line
 * summary on the item tile. The tile has a single line to spend and models
 * habitually open a command by changing to the directory the shell already
 * starts in, which pushes the part worth reading off the end.
 *
 * Only a `cd` that moves nowhere is dropped: the target must resolve to the
 * project directory itself. A `cd` into a subdirectory, out of the project, or
 * to a target this cannot resolve (a shell expansion) changes where the command
 * runs and stays on the tile. The `;` form is left alone too — the habit being
 * trimmed is `cd <project> && …`.
 *
 * Display only. The command is executed, approved, and shown in the properties
 * panel exactly as the model wrote it.
 * @param {string} command - The raw shell command
 * @param {{cwd?: string, home?: string, platform?: string}} [opts] - Project directory, user home (for `~`), and platform
 * @returns {string} The command without a redundant leading `cd`
 */
function stripLeadingProjectCd(command, opts = {}) {
  const { cwd = '', home = '', platform = '' } = opts;
  if (!cwd) return command;
  const match = /^\s*cd\s+(?:'([^']*)'|"([^"]*)"|((?:\\ |[^\s&|;<>'"])+))\s*&&\s*/.exec(command);
  if (!match) return command;
  const target = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\ /g, ' ');
  if (!target || target.includes('$') || target.includes('`')) return command;
  const to = comparableDir(untildeify(target, home), cwd, platform);
  return to === comparableDir(cwd, cwd, platform) ? command.slice(match[0].length) : command;
}

/**
 * ExecuteContextItem - Execute shell commands
 *
 * Executes shell commands via backend API.
 * Requires user approval by default.
 * Supports streaming output.
 * @class
 * @augments ContextItem
 */
class ExecuteContextItem extends ContextItem {
  static MANIFEST = {
    id: 'execute',
    name: 'Execute Command',
    version: '1.0.0',
    description: 'Execute shell commands',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'execute', icon: 'icon-terminal' };
  }

  /** @returns {string} Short type label shown on item cards and the permissions popup */
  static getTypeName() {
    return t('Bash');
  }

  /** @returns {boolean} Auto-select bash actions to show streaming output */
  static shouldAutoSelect() {
    return true;
  }

  /** @returns {{allowedScopes: Array<'session'|'conversation'>, defaultScope: 'session'|'conversation'}} Permission scope policy */
  static getPermissionScopePolicy() {
    return { allowedScopes: ['session', 'conversation'], defaultScope: 'session' };
  }

  /** @param {import('juggler/context-item').ItemContext & {signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void}} context */
  constructor(context) {
    super(context);
    // this.signal / this.onProgress are set by the base ContextItem constructor.
    /**
     * Accumulated output during streaming execution.
     * Read by the framework for progress events and cancellation recovery.
     * @type {string}
     */
    this.output = '';
  }

  // Unix shell interpreters - too dangerous to wildcard
  static UNIX_INTERPRETERS = new Set([
    'bash', 'sh', 'zsh', 'fish', 'csh', 'tcsh', 'ksh',
    'python', 'python3', 'python2',
    'node', 'nodejs', 'deno', 'bun',
    'ruby', 'perl', 'php',
    'lua', 'julia', 'r', 'rscript',
    'java', 'groovy', 'scala', 'kotlin',
    'osascript', 'expect', 'awk', 'sed',
    'eval', 'exec', 'source', '.'
  ]);

  // Windows interpreters - too dangerous to wildcard
  static WINDOWS_INTERPRETERS = new Set([
    'cmd', 'cmd.exe',
    'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
    'python', 'python.exe', 'python3', 'python3.exe',
    'node', 'node.exe', 'deno', 'deno.exe', 'bun', 'bun.exe',
    'ruby', 'ruby.exe', 'perl', 'perl.exe', 'php', 'php.exe',
    'java', 'java.exe', 'groovy', 'groovy.exe',
    'wscript', 'wscript.exe', 'cscript', 'cscript.exe'
  ]);

  /**
   * Shell operators that chain commands or enable injection.
   * Used to detect compound commands that should not be wildcarded.
   * @type {string[]}
   */
  static COMPOUND_OPERATORS = ['&&', '||', ';', '|', '$(', '`', '>', '<'];

  /**
   * Check if a command contains shell operators that chain or inject commands.
   * @param {string} command - Command to check
   * @returns {boolean} True if command contains compound operators
   */
  static containsCompoundOperators(command) {
    return ExecuteContextItem.COMPOUND_OPERATORS.some(op => command.includes(op));
  }

  /**
   * Extract a sensible default pattern for a command
   *
   * For interpreter commands (bash, python, node, etc.), returns the exact command
   * since wildcarding them would be dangerous.
   * For compound commands (containing &&, ||, ;, |, etc.), returns the exact command
   * since wildcarding would allow injection attacks.
   * For simple tool commands (npm, git, make, etc.), returns a wildcard pattern.
   * @param {string} command - The shell command
   * @param {string} platform - 'darwin', 'linux', or 'windows'
   * @returns {string} Pattern (exact command for interpreters/compound, wildcard for simple tools)
   */
  static extractDefaultPattern(command, platform) {
    const trimmedCommand = command.trim();
    const firstToken = /** @type {string} */ (trimmedCommand.split(/\s+/)[0]).toLowerCase(); // bounded: split always yields ≥1 element

    const interpreters = platform === 'windows'
      ? ExecuteContextItem.WINDOWS_INTERPRETERS
      : ExecuteContextItem.UNIX_INTERPRETERS;

    // For interpreters, use exact command (too dangerous to wildcard)
    if (interpreters.has(firstToken)) {
      return trimmedCommand;
    }

    // SECURITY: For compound commands, use exact pattern (not wildcard)
    // This prevents 'cd /path && rm -rf /' from creating 'cd *' pattern
    if (ExecuteContextItem.containsCompoundOperators(trimmedCommand)) {
      return trimmedCommand;
    }

    // For simple tool commands (npm, git, make, etc.), wildcard is safe
    const baseToken = trimmedCommand.split(/\s+/)[0]; // Preserve original case
    return `${baseToken} *`;
  }

  /**
   * Get tool definitions for Bash action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: markUntranslated('The command to execute')
        },
        description: {
          type: 'string',
          description: markUntranslated('Clear, concise description of what this command does in 5-10 words')
        },
        timeout: {
          type: 'number',
          description: markUntranslated(`Optional timeout in milliseconds (max ${MAX_EXEC_TIMEOUT_MS}). Default: ${DEFAULT_EXEC_TIMEOUT_MS} (${prettyTimeout(DEFAULT_EXEC_TIMEOUT_MS)}).`)
        },
        run_in_background: {
          type: 'boolean',
          description: markUntranslated('Run detached and return a task id immediately instead of blocking. Use for a durable process you manage yourself: a dev server kept running while you work, or a long build/test read once at the end. Read new output with TaskOutput; stop with TaskStop. For "wait until X is ready then tell me", prefer a foreground `until … done` command or the Monitor tool — do not spin-poll TaskOutput in a loop.')
        }
      },
      required: ['command']
    };

    const description = markUntranslated('Runs a bash command in a fresh shell rooted at the project directory (no `cd` needed). Nothing persists between calls; variables every command needs belong in `.juggler/env.local.json`, a JSON object of names to values.');

    return [
      {
        name: 'bash',
        category: 'write',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Get permission key for execute action
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input (unused)
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return 'execute';
  }

  /**
   * Check if this command is permitted by conversation permissions.
   *
   * Defers to the shared `execute`-domain check in
   * `./execute/command-permission.js` — the same one the Monitor tool uses, so
   * a grant given here covers the equivalent monitored command.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {boolean} True if command is auto-approved
   */
  isPermitted(toolInput) {
    const mt = this.messageThread;
    return isShellCommandPermitted(/** @type {string} */ (toolInput.command || ''), {
      messageThread: mt,
      session: this.conversation.session,
      writeEnabled: ExecuteContextItem._isFileWritingEnabled(mt)
    });
  }

  /**
   * A recursive/forced delete of a catastrophic radius — a tree this
   * conversation works in (its workspace, and the project it branched from), an
   * ancestor of one, the home dir, or a filesystem root — must never be silently
   * auto-approved: not by the conversation auto-approve toggle and not by a
   * strategy's out-of-band reviewer. Such a command still parks for an explicit
   * human decision (or YOLO). Every other command — including a routine
   * `rm -rf ./build` / `node_modules` / any genuine subdir or scratch tree —
   * stays auto-approvable and flows through the normal permission + reviewer
   * path. Session-sourced, mirroring {@link isPermitted}'s opts.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {boolean} False only for a catastrophic-radius recursive delete
   */
  autoApprovable(toolInput) {
    return !isShellCommandCatastrophic(
      /** @type {string} */ (toolInput?.command || ''),
      { messageThread: this.messageThread, session: this.conversation.session }
    );
  }

  /**
   * Is file-writing auto-approval enabled for this conversation?
   *
   * Reads the shared `write-file` permission the edit/write plugins own — an
   * enabled, non-session boolean `true` rule. When on, a bash redirect whose
   * target sits inside an allowed path is treated as a permitted output
   * destination (see the analyser's `isStrippableRedirectTarget`): the user has
   * already granted file writes there, so `cmd > allowed/path/log` need not
   * prompt purely for the redirect.
   * @param {import('../../../js/model/message-thread.js').MessageThread} mt - Owning thread
   * @returns {boolean} True if file-writing is auto-approved
   */
  static _isFileWritingEnabled(mt) {
    return (mt?.getRulesFor('write-file') || [])
      .some(r => r.kind === 'boolean' && r.value === true && r.scope !== 'session');
  }

  /**
   * Suggest escalating-breadth auto-approval rule-sets for this command.
   *
   * Defers to the analyser's {@link suggestApprovalPatterns}, which decomposes
   * the command (strip sinks + leading in-project `cd`, split on `&&`/`||`/`;`)
   * and, per rejected segment, derives the minimal glob(s) that would cover it —
   * exact text, then a command/subcommand wildcard, never wildcarding a shell
   * interpreter. Each breadth tier becomes one suggestion whose rules, once
   * added, make {@link isPermitted} true for the whole command.
   *
   * A leading in-project `cd` and write redirects to an allowed path (when file
   * writing is enabled) are stripped before analysis, so a build-with-logfile
   * command reduces to just its real command segments. When the command can't be
   * statically decomposed (command substitution, control flow, a write redirect
   * to a path outside the allowed list), the analyser returns nothing and we
   * fall back to a single exact-command rule via {@link extractDefaultPattern}.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
   */
  getApprovalSuggestions(toolInput) {
    const command = /** @type {string} */ (toolInput?.command || toolInput?.code || '');
    if (!command) return [];
    const mt = this.messageThread;
    const platform = this.conversation.session?.platform || 'darwin';
    const home = this.conversation.session?.home || '';
    const cwd = this.conversation.session?.projectPath || '';
    const interpreters = platform === 'windows'
      ? ExecuteContextItem.WINDOWS_INTERPRETERS
      : ExecuteContextItem.UNIX_INTERPRETERS;
    const allowedRoots = mt?.getAllowedPaths?.() || [];
    const patterns = (mt?.getRulesFor('execute') || [])
      .filter(r => r.kind === 'glob')
      .map(r => /** @type {string} */ (r.value));
    const writeEnabled = ExecuteContextItem._isFileWritingEnabled(mt);

    /**
     * Dry-run a prospective suggestion against the original command.
     * @param {{extraPatterns?: string[], extraAllowedRoots?: string[]}} [extras]
     * @returns {boolean} true if the added grant would approve the command
     */
    const approvesWith = (extras = {}) => {
      const extraPatterns = extras.extraPatterns || [];
      const extraAllowedRoots = extras.extraAllowedRoots || [];
      return isCommandAutoApproved(command, {
        platform,
        home,
        allowedRoots: [...allowedRoots, ...extraAllowedRoots],
        patterns: [...patterns, ...extraPatterns],
        writeEnabled,
        cwd
      });
    };

    const tiers = suggestApprovalPatterns(command, { platform, home, allowedRoots, patterns, interpreters, writeEnabled, cwd });
    if (tiers.length > 0) {
      /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
      const suggestions = [];
      for (const tier of tiers) {
        // A path-grant tier adds folders to the allowed-paths list (the right
        // fix for a read-only command that just reaches outside the roots);
        // a pattern tier adds glob rules. The analyser never mixes the two.
        if (tier.allowedPaths) {
          if (approvesWith({ extraAllowedRoots: tier.allowedPaths })) {
            suggestions.push({
              itemType: 'execute',
              allowedPaths: tier.allowedPaths,
              patterns: tier.allowedPaths.map(p => tildeify(p, home))
            });
          }
          continue;
        }
        const tierPatterns = tier.patterns || [];
        if (approvesWith({ extraPatterns: tierPatterns })) {
          suggestions.push({
            itemType: 'execute',
            rules: tierPatterns.map(p => ({ kind: 'glob', value: p, scope: 'conversation' })),
            patterns: tierPatterns
          });
        }
      }
      return suggestions;
    }

    // Undecomposable command: single exact-command rule, but only if a dry-run
    // proves the rule would actually approve this command.
    // Some rejects (for example unapproved write redirects) happen before glob
    // matching, so no command pattern can honestly fix them.
    const pattern = ExecuteContextItem.extractDefaultPattern(command, platform);
    if (pattern.length > MAX_SUGGESTED_PATTERN_LENGTH) return [];
    if (!approvesWith({ extraPatterns: [pattern] })) return [];
    return [{
      itemType: 'execute',
      rules: [{ kind: 'glob', value: pattern, scope: 'conversation' }],
      patterns: [pattern]
    }];
  }

  /**
   * Re-derive a single-pattern approval suggestion from the user's edited text.
   *
   * The framework's approval dialog lets the user edit one suggested pattern in
   * place — narrowing, widening, correcting a command glob, or retargeting a
   * folder grant — before "Yes + Don't Ask Again" remembers it. This hook is
   * the plugin's text↔rule bridge: it takes the raw edited text and returns a
   * fully-formed, dry-run-verified suggestion the framework persists verbatim.
   *
   * The shape is inferred from `original`: a suggestion carrying `allowedPaths`
   * is a folder grant (edit routes to {@link _reviseFolderGrant}); anything else
   * is a command glob ({@link _reviseCommandGlob}). Both reuse the exact
   * machinery {@link getApprovalSuggestions} does — the `isCommandAutoApproved`
   * dry-run — so an edited rule that wouldn't actually approve the command comes
   * back `valid: false` and the framework blocks saving it.
   * @param {{index: number, original: {rules?: Array<object>, allowedPaths?: string[]}, editedText: string, params: Record<string, unknown>}} args
   * @returns {{rules?: Array<object>, allowedPaths?: string[], patterns: string[], valid: boolean, notice?: string}} Re-derived suggestion
   */
  reviseApprovalSuggestion({ original, editedText, params }) {
    const command = /** @type {string} */ (params?.command || params?.code || '');
    const mt = this.messageThread;
    const platform = this.conversation.session?.platform || 'darwin';
    const home = this.conversation.session?.home || '';
    const cwd = this.conversation.session?.projectPath || '';
    const allowedRoots = mt?.getAllowedPaths?.() || [];
    const patterns = (mt?.getRulesFor('execute') || [])
      .filter(r => r.kind === 'glob')
      .map(r => /** @type {string} */ (r.value));
    const writeEnabled = ExecuteContextItem._isFileWritingEnabled(mt);

    /**
     * Dry-run the edited grant against the original command — the same guard
     * {@link getApprovalSuggestions} uses, so an edit is accepted only if it
     * would genuinely auto-approve the command in front of the user.
     * @param {{extraPatterns?: string[], extraAllowedRoots?: string[]}} [extras]
     * @returns {boolean} true if the added grant would approve the command
     */
    const approvesWith = (extras = {}) => isCommandAutoApproved(command, {
      platform,
      home,
      allowedRoots: [...allowedRoots, ...(extras.extraAllowedRoots || [])],
      patterns: [...patterns, ...(extras.extraPatterns || [])],
      writeEnabled,
      cwd
    });

    const text = typeof editedText === 'string' ? editedText.trim() : '';
    if (!command) return { valid: false, patterns: text ? [text] : [], notice: t('No command to approve') };

    const isPathGrant = Array.isArray(original?.allowedPaths) && original.allowedPaths.length > 0;
    return isPathGrant
      ? ExecuteContextItem._reviseFolderGrant(text, home, cwd, approvesWith)
      : ExecuteContextItem._reviseCommandGlob(text, approvesWith);
  }

  /**
   * Re-derive a command-glob suggestion from edited text. Blocks empty /
   * over-length text and any glob that wouldn't approve the command; warns
   * (but allows) when the glob is dangerously broad.
   * @param {string} text - Edited glob pattern (already trimmed)
   * @param {(extras?: {extraPatterns?: string[]}) => boolean} approvesWith - Dry-run guard
   * @returns {{rules?: Array<object>, patterns: string[], valid: boolean, notice?: string}} Re-derived suggestion
   */
  static _reviseCommandGlob(text, approvesWith) {
    if (!text) return { valid: false, patterns: [], notice: t('Enter a command pattern') };
    if (text.length > MAX_SUGGESTED_PATTERN_LENGTH) {
      return { valid: false, patterns: [text], notice: t('Pattern is too long') };
    }
    const rules = [{ kind: 'glob', value: text, scope: 'conversation' }];
    if (!approvesWith({ extraPatterns: [text] })) {
      return { rules, patterns: [text], valid: false, notice: t("This pattern wouldn't approve this command") };
    }
    const notice = ExecuteContextItem._broadGlobNotice(text);
    return notice
      ? { rules, patterns: [text], valid: true, notice }
      : { rules, patterns: [text], valid: true };
  }

  /**
   * Re-derive a folder-grant suggestion from edited text. Resolves to an
   * absolute path — `~` against the home dir, a relative path against the
   * directory the command runs in, so `web/js` means what the user expects —
   * requires a grantable root that actually covers the command, and warns (but
   * allows) when the granted tree is broad.
   * @param {string} text - Edited folder path (already trimmed, possibly tilde- or relative-form)
   * @param {string} home - Backend home dir
   * @param {string} cwd - Directory the command runs in
   * @param {(extras?: {extraAllowedRoots?: string[]}) => boolean} approvesWith - Dry-run guard
   * @returns {{allowedPaths?: string[], patterns: string[], valid: boolean, notice?: string}} Re-derived suggestion
   */
  static _reviseFolderGrant(text, home, cwd, approvesWith) {
    if (!text) return { valid: false, patterns: [], notice: t('Enter a folder path') };
    const abs = resolveAgainstCwd(untildeify(text, home), cwd);
    if (!abs || !abs.startsWith('/')) {
      return { valid: false, patterns: [text], notice: t('Not a valid folder') };
    }
    const root = canonicalRoot(abs, home);
    if (!root || !isGrantableRoot(root, home)) {
      return { allowedPaths: [abs], patterns: [tildeify(abs, home)], valid: false, notice: t('Not a grantable folder') };
    }
    const patterns = [tildeify(root, home)];
    if (!approvesWith({ extraAllowedRoots: [root] })) {
      return { allowedPaths: [root], patterns, valid: false, notice: t("This folder wouldn't cover this command") };
    }
    const notice = ExecuteContextItem._broadRootNotice(root, home);
    return notice
      ? { allowedPaths: [root], patterns, valid: true, notice }
      : { allowedPaths: [root], patterns, valid: true };
  }

  /**
   * Simple, explicit broadness heuristic for a command glob (only warns, never
   * blocks — so a rough rule is low-risk). Flags a bare `*`, a leading-`*`
   * pattern, and an interpreter wildcard (`bash *`, `python *`), which would
   * auto-approve arbitrary commands or scripts.
   * @param {string} pattern - The edited glob
   * @returns {string} A caution message, or '' if the glob is not obviously broad
   */
  static _broadGlobNotice(pattern) {
    const p = pattern.trim();
    if (!p) return '';
    if (p === '*' || p === '**' || p.startsWith('*')) return t('Very broad — approves many commands');
    const first = /** @type {string} */ (p.split(/\s+/)[0]).toLowerCase();
    const interpreters = new Set([
      ...ExecuteContextItem.UNIX_INTERPRETERS,
      ...ExecuteContextItem.WINDOWS_INTERPRETERS
    ]);
    if (interpreters.has(first) && p.includes('*')) return t('Very broad — approves many commands');
    return '';
  }

  /**
   * Simple, explicit broadness heuristic for a folder grant (only warns).
   * Flags a shallow root (two segments or fewer) or a direct child of the home
   * directory (`~/code`), both of which whitelist reads across a large tree.
   * @param {string} root - Canonical absolute root to grant
   * @param {string} home - Backend home dir
   * @returns {string} A caution message, or '' if the root is not obviously broad
   */
  static _broadRootNotice(root, home) {
    const segs = root.split('/').filter(Boolean);
    if (segs.length <= 2) return t('Broad — grants read access to a large tree');
    if (home) {
      const base = homeBase(home);
      const homeSegs = base.split('/').filter(Boolean);
      if (segs.length === homeSegs.length + 1 && root.startsWith(base + '/')) {
        return t('Broad — grants read access to a large tree');
      }
    }
    return '';
  }

  /**
   * Render the bash-plugin permission UI for the permission-controls popup.
   * The host shell calls this for every registered context-item class.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread
   * @returns {{id: string, title: string, element: HTMLElement, dispose: () => void}} Permission section
   */
  static getPermissionSection(messageThread) {
    return renderExecutePermissionSection(messageThread);
  }


  /**
   * Validate and normalize parameters for execution.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = toolInput;

    // Validation - must have command
    if (!params.command) {
      return { valid: false, error: markUntranslated('Missing required parameter: command') };
    }

    if (typeof params.command !== 'string') {
      return { valid: false, error: markUntranslated('Parameter "command" must be a string') };
    }

    // Validate timeout if provided (max MAX_EXEC_TIMEOUT_MS = 20 minutes)
    if (params.timeout !== undefined) {
      const timeout = Number(params.timeout);
      if (isNaN(timeout) || timeout < 0 || timeout > MAX_EXEC_TIMEOUT_MS) {
        return { valid: false, error: markUntranslated(`Parameter "timeout" must be a number between 0 and ${MAX_EXEC_TIMEOUT_MS}`) };
      }
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Build approval UI configuration with command preview.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const command = /** @type {string} */ (params.command);
    const description = params.description ? String(params.description) : '';

    return {
      message: description
        ? t('Execute command ({description}):\n\n{command}\n\nThis will run in the project directory.', { description, command })
        : t('Execute command:\n\n{command}\n\nThis will run in the project directory.', { command })
    };
  }

  /**
   * Execute the command with streaming output
   *
   * Uses WebSocket-based streaming to show output in real-time as it arrives.
   * Falls back to non-streaming execution if WebSocket is not available.
   * Supports cancellation via this.signal.
   * Supports background execution via run_in_background param.
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<Record<string, unknown>>} Command execution result with stdout, stderr, and exit code
   */
  async execute(params) {
    // Check if already cancelled
    if (this.signal?.aborted) {
      const error = new Error('Command execution cancelled');
      error.name = 'AbortError';
      throw error;
    }

    const command = /** @type {string} */ (params.command || '');
    const runInBackground = Boolean(params.run_in_background);

    // Handle background execution
    if (runInBackground) {
      const result = await this.ops.shellBackground(
        {
          command,
          timeout: params.timeout ? Number(params.timeout) : undefined,
          convId: this.conversation.id,
          threadId: this.messageThread?.threadItemId || '',
          toolUseId: this.toolUseId
        }
      );

      // Return result indicating background execution
      return {
        command,
        task_id: result.task_id,
        stdout: markUntranslated(`Background task started with ID: ${result.task_id}\nUse TaskOutput to check status and retrieve output.`),
        stderr: '',
        exitCode: 0,
        success: true,
        background: true,
        reconnectable: true
      };
    }

    // Emit progress event indicating execution started
    if (this.onProgress) {
      this.onProgress({
        type: 'status',
        message: t('Executing: {command}', { command })
      });
    }

    // Clear stale displayData from any previous run so the panel shows
    // "Running..." immediately instead of holding the old output.
    if (this.messageThread && this.toolUseId) {
      const clearItems = this.messageThread.items;
      for (let ci = 0; ci < clearItems.length; ci++) {
        if (clearItems[ci].get('toolUseId') === this.toolUseId) {
          this.messageThread.updateItemField(ci, 'displayData', { output: '' });
          break;
        }
      }
    }

    // Track accumulated output for cancellation recovery
    this.output = '';

    // Throttle Yjs displayData writes to avoid overwhelming observers.
    // Cap the preview to the last 100KB — full output is in this.output for the result.
    const DISPLAY_DATA_MAX = 100_000;
    let displayDataTimer = 0;
    let displayDataDirty = false;
    const flushDisplayData = () => {
      displayDataTimer = 0;
      displayDataDirty = false;
      if (this.messageThread && this.toolUseId) {
        const preview = this.output.length > DISPLAY_DATA_MAX
          ? t('… (truncated)') + '\n' + this.output.slice(-DISPLAY_DATA_MAX)
          : this.output;
        const items = this.messageThread.items;
        for (let i = 0; i < items.length; i++) {
          if (items[i].get('toolUseId') === this.toolUseId) {
            this.messageThread.updateItemField(i, 'displayData', { output: preview });
            break;
          }
        }
      }
    };

    // Tag the command with its owning conversation so the backend buckets any
    // full-output spill file under that conversation (deleted when it is), and
    // with the thread and tool call so the session's process list can lead back
    // to this action while it runs.
    const execParams = /** @type {import('../../../js/services/ops-api.js').ShellExecuteParams} */ ({
      ...params,
      convId: this.conversation.id,
      threadId: this.messageThread?.threadItemId || '',
      toolUseId: this.toolUseId
    });

    // Try streaming execution first, fall back to blocking if WebSocket unavailable
    try {
      const result = await this.ops.shellStreaming(
        execParams,
        (chunk) => {
          // Check for cancellation during streaming
          if (this.signal?.aborted) {
            return;
          }

          // Status chunks (awaiting-permission / running) carry no output;
          // relay the explanatory hint through onProgress.
          if (chunk.status) {
            const hint = chunk.hint || (chunk.status === 'awaiting-permission'
              ? t('Waiting for filesystem-access permission — check for a system dialog')
              : t('Running… (no output yet)'));
            if (this.onProgress) {
              this.onProgress({ type: 'status', message: hint });
            }
            return;
          }

          // Accumulate output immediately for cancellation recovery
          if (chunk.data) {
            this.output += chunk.data;
          }

          // Throttle Yjs displayData writes (max ~4/sec)
          displayDataDirty = true;
          if (!displayDataTimer) {
            displayDataTimer = setTimeout(flushDisplayData, 250);
          }

          // Stream output chunks to UI via onProgress
          if (chunk.data && this.onProgress) {
            this.onProgress({
              type: 'stdout',
              content: chunk.data
            });
          }
        },
        this.signal  // Pass abort signal for cancellation support
      );

      // Flush any pending displayData write
      clearTimeout(displayDataTimer);
      if (displayDataDirty) flushDisplayData();

      // Check if cancelled during execution (either via signal or result)
      if (this.signal?.aborted || result.cancelled) {
        const error = new Error('Command execution cancelled');
        error.name = 'AbortError';
        throw error;
      }

      // Canonical backend value replaces accumulated streaming chunks
      this.output = result.stdout;

      // The lower head+tail cap shrinks the human-visible final view, so when the
      // full output was spilled to a file, name it in the preview the user sees.
      if (result.truncated && result.outputFile) {
        this.output += `\n… full output saved to ${result.outputFile}`;
      }

      // `error` must travel with the result: it is the only statement of why a
      // command that never ran didn't run, and getSummary has nothing else to
      // tell the model apart from an exit code of 1.
      return {
        command: result.command,
        stdout: result.stdout,
        stderr: '', // Merged into stdout
        exitCode: result.exitCode,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        ...(result.blocked ? { blocked: true } : {}),
        ...(result.outputFile
          ? { outputFile: result.outputFile, outputBytes: result.outputBytes, truncated: result.truncated }
          : {})
      };
    } catch (streamError) {
      // The progress event is immediate but the durable Yjs preview is throttled.
      // Preserve chunks the user has already seen before cancellation or a
      // streaming transport failure unwinds this execution.
      clearTimeout(displayDataTimer);
      if (displayDataDirty) flushDisplayData();

      // If streaming fails due to WebSocket issues, fall back to blocking execution
      if (streamError instanceof Error && streamError.message.includes('WebSocket')) {
        const result = await this.ops.shell(execParams);

        if (this.signal?.aborted) {
          const error = new Error('Command execution cancelled');
          error.name = 'AbortError';
          throw error;
        }

        return result;
      }

      // Re-throw other errors
      throw streamError;
    }
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary & {exitCode?: number}} Formatted result for display, carrying the command's exit code
   */
  getSummary(outcome) {
    // Extract command from prepared params for denied/cancelled messages
    const prepared = outcome.prepared;
    const prepParams = /** @type {{command?: string}} */ (prepared?.params || {});
    const prepCommand = prepParams.command || '';
    const truncatedCmd = prepCommand.length > 60 ? prepCommand.substring(0, 60) + '...' : prepCommand;

    // Handle non-success cases
    // The summary is the model's tool result, so it stays English throughout.
    if (outcome.cancelled) {
      const summary = truncatedCmd
        ? markUntranslated(`Command cancelled: ${truncatedCmd}`)
        : markUntranslated('Command execution cancelled');
      return this.failureSummary(summary, { details: prepCommand ? `$ ${prepCommand}` : '' });
    }
    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Command execution failed: ${outcome.error}`));
    }

    // Success case - format command result
    const result = /** @type {{command?: string, exitCode: number, stdout?: string, stderr?: string, error?: string, blocked?: boolean}} */ (outcome.result);
    const command = result.command || '';
    const exitCode = result.exitCode;
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    // Set when the run itself went wrong rather than the command exiting
    // non-zero: refused before starting, an unusable cwd, a timeout, a kill.
    const runError = result.error || '';
    const blocked = Boolean(result.blocked);

    const cmdSuccess = exitCode === 0 && !runError;
    const icon = cmdSuccess ? '✓' : '✗';

    // The lead says which kind of non-completion this was; the server's own
    // text follows it verbatim, because that is the part that names the cause.
    const errorLead = blocked
      ? markUntranslated('Blocked by Juggler — the command never ran, so retrying it unchanged will do the same.')
      : markUntranslated("Couldn't run the command to completion.");

    // Build summary for LLM (this is what goes in tool_result content)
    // Note: stderr is merged into stdout at execution time
    let summary;
    if (runError) {
      summary = `${errorLead}\n\n${runError}`;
      if (stdout) summary += `\n\nOutput before it stopped:\n${stdout}`;
    } else {
      summary = stdout || markUntranslated('(no output)');
      if (!cmdSuccess) summary += `\n\nexit code: ${exitCode}`;
    }
    summary = this.truncateForLLM(summary);

    // Details for UI display
    let details = `$ ${command}\n\n`;
    if (runError) details += `${errorLead}\n\n${runError}\n\n`;
    if (stdout) details += stdout;
    if (stderr) details += (stdout ? '\n\n' : '') + `stderr: ${stderr}`;
    if (!cmdSuccess && !runError) details += `\n\nexit code: ${exitCode}`;

    // Generate feedback for LLM (appended by response-handler)
    const feedbackForLLM = this._generateFeedbackForLLM(exitCode, runError, blocked);

    return {
      summary,
      details,
      success: cmdSuccess,
      icon,
      exitCode,
      feedbackForLLM
    };
  }

  /**
   * Generate the feedback message for the LLM, appended to the action's summary
   * (response-handler-actions). It reads only the outcome — whether the command
   * ran, and how it ended — never the command or its output.
   * @param {number} exitCode - Exit code
   * @param {string} [runError] - Why the run itself did not complete, when it didn't
   * @param {boolean} [blocked] - Whether the command was refused and never ran
   * @returns {string|undefined} Feedback message or undefined
   * @private
   */
  _generateFeedbackForLLM(exitCode, runError, blocked) {
    // A command that never ran has no exit code worth reporting — say what
    // stopped it, so the next move is a different command rather than the
    // same one again.
    if (runError) {
      return blocked
        ? markUntranslated(`Juggler blocked this command before running it: ${runError}. Retrying it unchanged will be blocked again — rewrite it or ask the user to run it.`)
        : markUntranslated(`The command did not run to completion: ${runError}`);
    }

    // Only provide feedback for failed commands
    if (exitCode === 0) {
      return undefined;
    }
    return markUntranslated(`Command failed with exit code ${exitCode}`);
  }

  /**
   * Build the tile summary for a background run: a distinctly-styled
   * "[background task]" tag before the command text, with the LLM-provided
   * description (unchanged) as the subtitle line when present. The task id is
   * intentionally omitted here — it lives in the properties panel.
   *
   * On a selected card the tag opens the Running tasks pin. On an unselected
   * one it does nothing of its own, so the click selects the card like a click
   * anywhere else on it; that is also why the tag is a span and not a button,
   * which the conversation would treat as a control and select without
   * revealing. The tag's selected-card affordance is in `approvals.css`.
   * @param {string} command - The command that was launched
   * @param {string|undefined} description - Optional LLM description
   * @returns {HTMLElement} Summary element
   */
  _backgroundSummary(command, description) {
    const wrapper = document.createElement('span');
    wrapper.className = 'summary-with-subtitle';

    const mainEl = document.createElement('span');
    mainEl.className = 'summary-with-subtitle-main';
    const tag = document.createElement('span');
    tag.className = 'context-item-type-badge action-summary-background-tag';
    tag.textContent = t('Background');
    tag.addEventListener('click', (e) => {
      // The row's selection is read before the conversation's own click handler
      // runs, so this sees the state the user clicked on, not the one it makes.
      const row = tag.closest('[message-id]');
      if (!row?.classList.contains('selected') || !canPinSource(TASKS_SOURCE)) return;
      e.stopPropagation();
      void pinSource(TASKS_SOURCE);
    });
    mainEl.appendChild(tag);
    mainEl.appendChild(createHighlightedCode(command, 'bash'));
    wrapper.appendChild(mainEl);

    if (description) {
      const subEl = document.createElement('span');
      subEl.className = 'summary-with-subtitle-sub llm-description';
      subEl.textContent = description;
      wrapper.appendChild(subEl);
    }

    return wrapper;
  }

  /**
   * Get status UI configuration
   *
   * Provides command with expandable output for all execute results.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @param {{conversation?: unknown, session?: unknown, toolUseId?: string}} [_context] - Optional context (unused)
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput, _context) {
    // Cast to any to handle both ActionStatus and pending state object
    /** @type {any} */
    const result = actionStatus;
    // Get command and description from toolInput
    const params = toolInput || {};
    const command = /** @type {string} */ (params.command || '');
    const description = params.description ? String(params.description) : undefined;

    if (!command) {
      return null;
    }

    // The tile gets one line, so a `cd` to the directory the shell already
    // starts in is dropped from it. Execution, approval and the properties
    // panel all still see the command as written.
    const session = this.conversation?.session;
    const tileCommand = stripLeadingProjectCd(command, {
      cwd: session?.projectPath || '',
      home: session?.home || '',
      platform: session?.platform || ''
    });

    // Build summary and status based on result state
    /** @type {string|HTMLElement} */
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;

    // Background launches return immediately with success — mark the tile with a
    // "[background task]" tag before the command so it's visibly distinct from a
    // finished foreground run. The description is left untouched (shown as the
    // usual subtitle); the task id lives in the properties panel, not here.
    const backgroundRequested = Boolean(params.run_in_background);

    if (result?.pending) {
      summary = backgroundRequested
        ? this._backgroundSummary(tileCommand, description)
        : createSummaryWithSubtitle(createHighlightedCode(tileCommand, 'bash'), description);
      status = 'running';
    } else if (result?.cancelled) {
      summary = t('Command cancelled: {command}', { command: tileCommand });
      status = 'cancelled';
    } else if (result?.success) {
      const rawResult = result.result || {};
      const exitCode = rawResult.exitCode ?? 0;
      if (backgroundRequested || rawResult.background) {
        summary = this._backgroundSummary(tileCommand, description);
        status = 'success';
      } else {
        summary = createSummaryWithSubtitle(createHighlightedCode(tileCommand, 'bash'), description);
        status = exitCode === 0 ? 'success' : 'error';
      }
    } else if (result) {
      summary = t('{command} — failed', { command: tileCommand });
      status = 'error';
    } else {
      summary = createSummaryWithSubtitle(createHighlightedCode(tileCommand, 'bash'), description);
      status = 'running';
    }

    return { typeName: ExecuteContextItem.getTypeName(), summary, status };
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return t('Output');
  }

  /**
   * Bash output is raw terminal output — parse ANSI colour codes so the panel
   * shows colours instead of literal escape sequences.
   * @override
   * @returns {boolean} Always true for command execution
   */
  static rendersTerminalOutput() {
    return true;
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean, controls?: HTMLElement[] } | void} Render result; set
   *   skipResultSection when output is rendered inline, and a background run's
   *   control to show the Running tasks pin
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    helpers.addSubsection(wrapper, t('Command'), formatCommandForDisplay(input.command || ''), 'properties-panel-code', { language: 'bash' });
    if (input.description) {
      helpers.addLlmDescription(wrapper, t('Description'), String(input.description));
    }
    const ms = input.timeout ?? DEFAULT_EXEC_TIMEOUT_MS;
    helpers.addSubsection(wrapper, t('Timeout'), prettyTimeout(ms), 'properties-panel-code');

    if (!input.run_in_background) return;

    // Background runs spawn a durable, addressable process. Surface its task id
    // as a first-class property so the user can find the handle to read
    // (TaskOutput) or kill (TaskStop) it.
    const taskId = ExecuteContextItem._backgroundTaskId(toolAction);
    helpers.addSubsection(wrapper, t('Background task'), taskId || t('(starting…)'), 'properties-panel-code');

    // No task id means the launch itself failed or hasn't landed — leave the
    // generic result section to report it.
    if (!taskId) return;

    // The launch receipt stays beside the process output the user owns. Live
    // registry state overlays the durable snapshot while the process is reachable.
    const resultText = ExecuteContextItem._resultText(toolAction);
    if (resultText) helpers.addSubsection(wrapper, t('Result'), resultText, 'properties-panel-result');
    const displayData = toolAction?.get?.('displayData');
    const persistedTask = (displayData?.toJSON ? displayData.toJSON() : displayData)?.backgroundTask;
    // A background run has no delivery binding to cancel (the way Monitor does),
    // so the panel is the only place a user can reach the process: kill it
    // directly through the same op TaskStop calls.
    renderLiveTaskOutput(wrapper, {
      taskId,
      helpers,
      describeStatus: describeTaskStatus,
      initialState: persistedTask,
      convId: this.conversation.id,
      onStop: () => shellKill({ shellId: taskId, convId: this.conversation.id }),
      stopLabel: t('Stop task')
    });

    const showTasks = ExecuteContextItem._createShowTasksControl();
    return { skipResultSection: true, controls: showTasks ? [showTasks] : [] };
  }

  /**
   * The panel control that opens the Running tasks pin, for the controls
   * block at the top of a background run's panel. Null when nothing enabled
   * can show the tasks: a button that would do nothing is left out.
   * @returns {HTMLElement|null} The control, or null to offer nothing.
   */
  static _createShowTasksControl() {
    if (!canPinSource(TASKS_SOURCE)) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'properties-panel-btn';
    button.textContent = t('Show background tasks');
    button.addEventListener('click', () => { void pinSource(TASKS_SOURCE); });
    return button;
  }

  /**
   * A tool-action's stored outcome as a plain object (Y.Map or already-plain).
   * @param {any} toolAction - The tool-action Y.Map.
   * @returns {any} The plain outcome, or undefined when there is none.
   */
  static _resultPlain(toolAction) {
    const resultMap = toolAction?.get?.('result');
    return resultMap?.toJSON ? resultMap.toJSON() : resultMap;
  }

  /**
   * Resolve the background-task id from a tool-action's stored outcome. The id is
   * produced server-side by `shellBackground` and persisted under
   * `result.fullResult.result.task_id` (same plumbing Monitor reads).
   * @param {any} toolAction - The tool-action Y.Map.
   * @returns {string} The task id, or '' if not yet available.
   */
  static _backgroundTaskId(toolAction) {
    return String(ExecuteContextItem._resultPlain(toolAction)?.fullResult?.result?.task_id || '');
  }

  /**
   * The result text the LLM was handed, as the generic result section resolves it.
   * @param {any} toolAction - The tool-action Y.Map.
   * @returns {string} The result text, or '' when there is none.
   */
  static _resultText(toolAction) {
    const plain = ExecuteContextItem._resultPlain(toolAction);
    return String(plain?.content || plain?.output || '');
  }
}

export { formatCommandForDisplay, stripLeadingProjectCd, describeTaskStatus };

export default ExecuteContextItem;
