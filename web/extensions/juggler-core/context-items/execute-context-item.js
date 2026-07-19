//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { shell, shellStreaming, shellBackground, MAX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS } from 'juggler/ops';
import { smartTruncate, createHighlightedCode, createSummaryWithSubtitle } from 'juggler/ui';
import { isCommandAutoApproved, suggestApprovalPatterns, MAX_SUGGESTED_PATTERN_LENGTH } from './execute/command-approval.js';
import { renderExecutePermissionSection } from './execute/permission-section.js';

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
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const parts = [];
  if (mins > 0) parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  if (secs > 0 || mins === 0) parts.push(`${secs} second${secs === 1 ? '' : 's'}`);
  return parts.join(' ');
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
    return 'Bash';
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
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute'
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in 5-10 words'
        },
        timeout: {
          type: 'number',
          description: `Optional timeout in milliseconds (max ${MAX_EXEC_TIMEOUT_MS}). Default: ${DEFAULT_EXEC_TIMEOUT_MS} (${prettyTimeout(DEFAULT_EXEC_TIMEOUT_MS)}).`
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the command as a detached background process and return its task id immediately, instead of blocking for output. Use this when you want a durable process handle you manage yourself: a long-lived dev server you keep running while you work, or a long build/test you kick off then read once at the end. Read output with TaskOutput (which returns only NEW output since your last read, so polling is cheap) and stop it with TaskStop. For "wait until X is ready then tell me", prefer a foreground command with an `until … done` guard (one command that exits when the condition holds) or the Monitor tool (a filtered event stream) — do not spin-poll TaskOutput in a loop.'
        }
      },
      required: ['command']
    };

    const description = 'Executes a given bash command in a persistent shell session with optional timeout. Use this for terminal operations like git, npm, docker, etc.';

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
   * Pulls the user's enabled `glob` rules for this plugin and the
   * conversation's allowed-paths list, then defers to the static analyser in
   * `./execute/command-approval.js`.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {boolean} True if command is auto-approved
   */
  isPermitted(toolInput) {
    const command = /** @type {string} */ (toolInput.command || '');
    if (!command) return false;
    const mt = this.messageThread;
    if (!mt) return false;
    const patterns = mt.getRulesFor('execute')
      .filter(r => r.kind === 'glob')
      .map(r => /** @type {string} */ (r.value));
    return isCommandAutoApproved(command, {
      platform: this.conversation.session?.platform || 'darwin',
      home: this.conversation.session?.home || '',
      allowedRoots: mt.getAllowedPaths(),
      patterns,
      writeEnabled: ExecuteContextItem._isFileWritingEnabled(mt)
    });
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
   * Display an absolute path with the user's home dir collapsed to `~` — the
   * folder the "Yes + Don't Ask Again" button will add to the allowed-paths
   * list. Purely cosmetic (the persisted value is the absolute path).
   * @param {string} p - Absolute path
   * @param {string} home - Backend home dir (may be empty)
   * @returns {string} `~`-collapsed display path
   */
  static _tildeify(p, home) {
    if (!home) return p;
    const base = home.endsWith('/') ? home.slice(0, -1) : home;
    if (p === base) return '~';
    if (p.startsWith(base + '/')) return '~' + p.slice(base.length);
    return p;
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
        writeEnabled
      });
    };

    const tiers = suggestApprovalPatterns(command, { platform, home, allowedRoots, patterns, interpreters, writeEnabled });
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
              patterns: tier.allowedPaths.map(p => ExecuteContextItem._tildeify(p, home))
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
      return { valid: false, error: 'Missing required parameter: command' };
    }

    if (typeof params.command !== 'string') {
      return { valid: false, error: 'Parameter "command" must be a string' };
    }

    // Validate timeout if provided (max MAX_EXEC_TIMEOUT_MS = 20 minutes)
    if (params.timeout !== undefined) {
      const timeout = Number(params.timeout);
      if (isNaN(timeout) || timeout < 0 || timeout > MAX_EXEC_TIMEOUT_MS) {
        return { valid: false, error: `Parameter "timeout" must be a number between 0 and ${MAX_EXEC_TIMEOUT_MS}` };
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
    const description = params.description ? ` (${params.description})` : '';

    return {
      message: `Execute command${description}:\n\n${command}\n\nThis will run in the project directory.`
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
      const result = await shellBackground(
        this._withConv({
          command,
          timeout: params.timeout ? Number(params.timeout) : undefined,
          conv_id: this.conversation.id,
          tool_use_id: this.toolUseId
        })
      );

      // Return result indicating background execution
      return {
        command,
        task_id: result.task_id,
        stdout: `Background task started with ID: ${result.task_id}\nUse TaskOutput to check status and retrieve output.`,
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
        message: `Executing: ${command}`
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
          ? '… (truncated)\n' + this.output.slice(-DISPLAY_DATA_MAX)
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

    // Try streaming execution first, fall back to blocking if WebSocket unavailable
    try {
      const result = await shellStreaming(
        this._withConv(params),
        (chunk) => {
          // Check for cancellation during streaming
          if (this.signal?.aborted) {
            return;
          }

          // Status chunks (awaiting-permission / running) carry no output;
          // relay the explanatory hint through onProgress.
          if (chunk.status) {
            const hint = chunk.hint || (chunk.status === 'awaiting-permission'
              ? 'Waiting for filesystem-access permission — check for a system dialog'
              : 'Running… (no output yet)');
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

      return {
        command: result.command,
        stdout: result.stdout,
        stderr: '', // Merged into stdout
        exitCode: result.exitCode,
        success: result.success
      };
    } catch (streamError) {
      // Clean up throttle timer
      clearTimeout(displayDataTimer);

      // If streaming fails due to WebSocket issues, fall back to blocking execution
      if (streamError instanceof Error && streamError.message.includes('WebSocket')) {
        const result = await shell(this._withConv(params));

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
   * @returns {{summary: string, details: string, success: boolean, icon: string, exitCode?: number, feedbackForLLM?: string}} Formatted result for display
   */
  getSummary(outcome) {
    // Extract command from prepared params for denied/cancelled messages
    const prepared = outcome.prepared;
    const prepParams = /** @type {{command?: string}} */ (prepared?.params || {});
    const prepCommand = prepParams.command || '';
    const truncatedCmd = prepCommand.length > 60 ? prepCommand.substring(0, 60) + '...' : prepCommand;

    // Handle non-success cases
    if (outcome.cancelled) {
      const summary = truncatedCmd ? `Command cancelled: ${truncatedCmd}` : 'Command execution cancelled';
      return { summary, details: prepCommand ? `$ ${prepCommand}` : '', success: false, icon: '✗' };
    }
    if (!outcome.success) {
      return { summary: `Command execution failed: ${outcome.error}`, details: '', success: false, icon: '✗' };
    }

    // Success case - format command result
    const result = /** @type {{command?: string, exitCode: number, stdout?: string, stderr?: string}} */ (outcome.result);
    const command = result.command || '';
    const exitCode = result.exitCode;
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    const cmdSuccess = exitCode === 0;
    const icon = cmdSuccess ? '✓' : '✗';

    // Build summary for LLM (this is what goes in tool_result content)
    // Note: stderr is now merged into stdout at execution time
    let summary = stdout || '(no output)';
    if (!cmdSuccess) {
      summary += `\n\nexit code: ${exitCode}`;
    }

    // Apply smart truncation to large command outputs
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: truncatedSummary, truncated } = smartTruncate(summary, { maxChars: budget });
    if (truncated) {
      summary = truncatedSummary + `\n\n(Output truncated from ${summary.length} to ${truncatedSummary.length} chars)`;
    }

    // Details for UI display
    let details = `$ ${command}\n\n`;
    if (stdout) details += stdout;
    if (stderr) details += (stdout ? '\n\n' : '') + `stderr: ${stderr}`;
    if (!cmdSuccess) details += `\n\nexit code: ${exitCode}`;

    // Generate feedback for LLM (appended by response-handler)
    const feedbackForLLM = this._generateFeedbackForLLM(command, stdout, stderr, exitCode);

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
   * Generate feedback message for LLM based on command output
   * @param {string} _command - Command that was executed (unused)
   * @param {string} _stdout - Standard output (unused)
   * @param {string} _stderr - Standard error (unused)
   * @param {number} exitCode - Exit code
   * @returns {string|undefined} Feedback message or undefined
   * @private
   */
  _generateFeedbackForLLM(_command, _stdout, _stderr, exitCode) {
    // Only provide feedback for failed commands
    if (exitCode === 0) {
      return undefined;
    }
    return `Command failed with exit code ${exitCode}`;
  }

  /**
   * Build the tile summary for a background run: a distinctly-styled
   * "[background task]" tag before the command text, with the LLM-provided
   * description (unchanged) as the subtitle line when present. The task id is
   * intentionally omitted here — it lives in the properties panel.
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
    tag.textContent = 'Background';
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
        ? this._backgroundSummary(command, description)
        : createSummaryWithSubtitle(createHighlightedCode(command, 'bash'), description);
      status = 'running';
    } else if (result?.cancelled) {
      summary = `Command cancelled: ${command}`;
      status = 'cancelled';
    } else if (result?.success) {
      const rawResult = result.result || {};
      const exitCode = rawResult.exitCode ?? 0;
      if (backgroundRequested || rawResult.background) {
        summary = this._backgroundSummary(command, description);
        status = 'success';
      } else {
        summary = createSummaryWithSubtitle(createHighlightedCode(command, 'bash'), description);
        status = exitCode === 0 ? 'success' : 'error';
      }
    } else if (result) {
      summary = `${command} — failed`;
      status = 'error';
    } else {
      summary = createSummaryWithSubtitle(createHighlightedCode(command, 'bash'), description);
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
    return 'Output';
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
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    helpers.addSubsection(wrapper, 'Command', formatCommandForDisplay(input.command || ''), 'properties-panel-code', { language: 'bash' });
    if (input.description) {
      helpers.addLlmDescription(wrapper, 'Description', String(input.description));
    }
    const ms = input.timeout ?? DEFAULT_EXEC_TIMEOUT_MS;
    helpers.addSubsection(wrapper, 'Timeout', prettyTimeout(ms), 'properties-panel-code');

    // Background runs spawn a durable, addressable process. Surface its task id
    // as a first-class property so the user can find the handle to read
    // (TaskOutput) or kill (TaskStop) it — invisible before this row existed.
    if (input.run_in_background) {
      const taskId = ExecuteContextItem._backgroundTaskId(toolAction);
      helpers.addSubsection(wrapper, 'Background task', taskId || '(starting…)', 'properties-panel-code');
    }
  }

  /**
   * Resolve the background-task id from a tool-action's stored outcome. The id is
   * produced server-side by `shellBackground` and persisted under
   * `result.fullResult.result.task_id` (same plumbing Monitor reads).
   * @param {any} toolAction - The tool-action Y.Map.
   * @returns {string} The task id, or '' if not yet available.
   */
  static _backgroundTaskId(toolAction) {
    const resultMap = toolAction?.get?.('result');
    const plain = resultMap?.toJSON ? resultMap.toJSON() : resultMap;
    return String(plain?.fullResult?.result?.task_id || '');
  }
}

export { formatCommandForDisplay };

export default ExecuteContextItem;
