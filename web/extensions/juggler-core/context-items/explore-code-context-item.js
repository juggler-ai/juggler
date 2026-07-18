//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { ReadOnlyFileSystem } from 'juggler/ops';
// Aliased on import: this item exposes its own `grep`/`glob` helpers to sandboxed
// code (below), so the ops primitives are bound under distinct local names.
import { grep as grepOp, glob as globOp } from 'juggler/ops';
import { runInSandbox } from 'juggler/sandbox';
import { smartTruncate, createLlmDescription } from 'juggler/ui';

/**
 * ExploreCodeContextItem - Execute JavaScript against a read-only filesystem SDK
 *
 * Collapses multi-step exploration into a single tool call. Only the return
 * value enters context — intermediate reads, greps, and globs are discarded.
 * @class
 * @augments ContextItem
 */
class ExploreCodeContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'explore-code',
    name: 'Explore Code',
    version: '1.0.0',
    description: 'Execute JavaScript against a read-only filesystem SDK for efficient exploration',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for explore_code
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'explore_code',
      category: 'read',
      description: 'Execute JavaScript for read-only filesystem exploration. Collapses multi-step exploration into one call — only the return value enters context.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript to execute (async/await OK; must return a value). Browser realm, NOT Node: no `process`/`require`/`Buffer`. In-scope bindings:\n- `fs` — read-only fs.promises subset\n- `path` — POSIX path (forward-slash, even on Windows)\n- `grep(pattern, {cwd?, glob?, maxResults?, ignoreCase?})` → [{file, line, content}]\n- `glob(pattern, {cwd?})` → string[]\n- `projectRoot` — absolute project root (forward-slashed). `import()` any JavaScript/JSON module in the project by absolute path (e.g. `${projectRoot}/src/foo.js`) to call its real exports.'
          },
          description: {
            type: 'string',
            description: 'Short human-readable description of what this exploration does (e.g. "find all files importing auth module"). Shown to the user in the conversation.'
          },
          timeout: {
            type: 'number',
            description: 'Optional execution timeout in milliseconds (1000–600000, default 120000).'
          }
        },
        required: ['code']
      }
    }];
  }

  /**
   * Validate input parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (!toolInput.code) {
      return { valid: false, error: 'Missing required parameter: code' };
    }
    if (typeof toolInput.code !== 'string') {
      return { valid: false, error: 'Parameter "code" must be a string' };
    }
    if (toolInput.timeout !== undefined) {
      const timeout = Number(toolInput.timeout);
      if (isNaN(timeout) || timeout < 1000 || timeout > 600000) {
        return { valid: false, error: 'timeout must be between 1000 and 600000 ms' };
      }
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Execute the exploration script via the host sandbox (juggler/sandbox),
   * exposing a read-only filesystem plus grep/glob search to the code. The
   * sandbox also injects `path` and `projectRoot`. Only the script's return
   * value enters context.
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Script result
   */
  async execute(params) {
    const code = /** @type {string} */ (params.code);
    const timeoutMs = params.timeout ? Number(params.timeout) : 120000;

    const fs = new ReadOnlyFileSystem(this.getToolAllowedRoots());
    const { grep, glob } = this._createSearchHelpers();

    const result = await runInSandbox(code, {
      capabilities: { fs, grep, glob },
      timeoutMs,
    });
    return { result: result === undefined ? null : result };
  }

  /**
   * Create grep and glob helper functions for the sandboxed script.
   * @returns {{grep: function(string, object=): Promise<Array<{file: string, line: number, content: string}>>, glob: function(string, object=): Promise<string[]>}} Search helpers
   * @private
   */
  _createSearchHelpers() {
    // Capture the action's abort signal in the closure: these helpers are
    // destructured off the returned object, so `this` is not the plugin when
    // they run. Forwarding the signal makes the sandbox's grep/glob calls
    // cancellable along with the rest of the explore_code action.
    const signal = this.signal;
    const allowedPaths = this.getToolAllowedRoots();
    return {
      /**
       * Search file contents (ripgrep-style).
       * @param {string} pattern - Regex pattern
       * @param {{cwd?: string, glob?: string, maxResults?: number, ignoreCase?: boolean}} [options] - Search options
       * @returns {Promise<Array<{file: string, line: number, content: string}>>} Matching lines
       */
      async grep(pattern, options) {
        /** @type {Record<string, unknown>} */
        const params = { pattern };
        if (options?.cwd) params.path = options.cwd;
        if (options?.glob) params.include = options.glob;
        if (options?.maxResults) params.maxResults = options.maxResults;
        if (options?.ignoreCase !== undefined) params.ignoreCase = options.ignoreCase;
        const result = await grepOp(/** @type {any} */ (params), signal, allowedPaths);
        return result.matches || [];
      },
      /**
       * Find files matching a glob pattern (Node.js fs.glob-style).
       * @param {string} pattern - Glob pattern
       * @param {{cwd?: string}} [options] - Options
       * @returns {Promise<string[]>} Matching file paths
       */
      async glob(pattern, options) {
        /** @type {Record<string, unknown>} */
        const params = { pattern };
        if (options?.cwd) params.path = options.cwd;
        const result = await globOp(/** @type {any} */ (params), signal, allowedPaths);
        const files = result.files || [];
        if (!options?.cwd) return files;

        const cwd = String(options.cwd).replace(/\/+$|^\.\/$/g, '');
        if (!cwd || cwd === '.') return files;
        const prefix = cwd + '/';
        return files.map((file) => {
          const f = String(file);
          return f === cwd ? '.' : f.startsWith(prefix) ? f.slice(prefix.length) : f;
        });
      }
    };
  }

  /**
   * Format result for LLM
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return {
        summary: outcome.error || 'explore_code execution failed',
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {Record<string, unknown>} */ (outcome.result);
    let content;

    if (result.result !== null && result.result !== undefined) {
      content = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);
    } else {
      content = '(no return value)';
    }

    // Apply smart truncation
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: truncated, truncated: wasTruncated } = smartTruncate(content, { maxChars: budget });

    return {
      summary: wasTruncated
        ? truncated + `\n\n(Output truncated from ${content.length} to ${truncated.length} chars)`
        : content,
      details: '',
      success: true,
      icon: '✓'
    };
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) return null;

    const desc = typeof toolInput?.description === 'string' && toolInput.description.trim()
      ? toolInput.description.trim()
      : '';

    /** @type {string|HTMLElement} */
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = desc ? createLlmDescription(desc) : 'Exploring...';
      status = 'running';
    } else if (actionStatus.success) {
      summary = desc ? createLlmDescription(desc) : '';
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, 'failed'));
    }

    return { typeName: 'Explore', summary, status };
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
   * explore_code returns a JSON-serialised value (the script's return), so the
   * Output section is highlighted as JSON.
   * @override
   * @param {string} _toolName
   * @returns {string} Prism language id
   */
  static resultSectionLanguage(_toolName) {
    return 'json';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    if (input.description) {
      helpers.addLlmDescription(wrapper, 'Description', String(input.description));
    }
    const code = input.code !== null && input.code !== undefined ? String(input.code) : '';
    helpers.addSubsection(wrapper, 'Code', code, 'properties-panel-code', { language: 'javascript' });
  }
}

export default ExploreCodeContextItem;
