//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatPathForStatus } from 'juggler/item-utils';
import { translator, markUntranslated } from 'juggler/i18n';
import { toolInputPath, isPathAllowed, folderGrantSuggestions, stripInjectedApprovalFlags, gitignoreDisabled } from './path-approval.js';
import { buildGitignoreSection } from './search-scope-section.js';
import { formatGrepResults } from './search/grep-format.js';
import { inputText } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * @typedef {object} GrepParams
 * @property {string} pattern - Regex pattern to search for
 * @property {string} [path] - Directory to search in
 * @property {string} [glob] - Glob pattern to filter files
 * @property {string} [type] - File type filter (js, py, go, etc.)
 * @property {string} [output_mode] - Output mode: "content" | "files_with_matches" | "count"
 * @property {number} [head_limit] - Limit output to first N entries
 * @property {number} [offset] - Skip first N entries
 * @property {number} [contextAfter] - Number of lines to show after each match (grep -A)
 * @property {number} [contextBefore] - Number of lines to show before each match (grep -B)
 * @property {number} [contextLines] - Number of lines to show before and after (grep -C)
 * @property {boolean} [caseInsensitive] - Case insensitive search (grep -i)
 * @property {boolean} [showLineNumbers] - Show line numbers (grep -n, default true)
 * @property {boolean} [multiline] - Enable multiline mode
 * @property {number} [maxCount] - Maximum matches to return
 * @property {string} [include] - Glob pattern to filter files (alias for glob)
 * @property {boolean} [ignoreCase] - Ignore case when matching (alias for caseInsensitive)
 * @property {boolean} [noIgnore] - Search all files, ignoring .gitignore
 */

/**
 * @typedef {object} SearchMatch
 * @property {string} file - File path
 * @property {number} line - Line number
 * @property {string} content - Line content
 * @property {number} [column] - Column number
 */

/**
 * @typedef {object} SearchResult
 * @property {SearchMatch[]} matches - Array of search matches
 * @property {number} matchCount - Total number of matches
 * @property {number} fileCount - Number of files with matches
 * @property {boolean} [truncated] - Whether results were truncated
 */

/**
 * SearchContextItem - Search codebase for patterns
 *
 * Provides grep and find_symbol tools that return search results
 * directly in tool results.
 * @class
 * @augments ContextItem
 */
class SearchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'search',
    name: 'Search',
    version: '1.0.0',
    description: 'Search codebase for patterns and symbols',
    author: 'Juggler Team',
    // Approval-gated like read, but only an out-of-root NON-glob `path` prompts:
    // a search with no path (cwd) or a glob path is confined to the project by
    // the backend, so isPermitted auto-approves it and the common case is silent.
    requiresApproval: true
  };

  /**
   * Get tool definitions for Grep action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: markUntranslated('The regular expression pattern to search for in file contents')
        },
        path: {
          type: 'string',
          description: markUntranslated('File or directory to search in. Defaults to current working directory.')
        },
        glob: {
          type: 'string',
          description: markUntranslated('Glob pattern to filter files (e.g., "*.js", "*.{ts,tsx}")')
        },
        type: {
          type: 'string',
          description: markUntranslated('File type to search (e.g., js, py, go, rust). More efficient than glob for standard file types.')
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: markUntranslated('Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.')
        },
        '-A': {
          type: 'number',
          description: markUntranslated('Number of lines to show after each match. Requires output_mode: "content".')
        },
        '-B': {
          type: 'number',
          description: markUntranslated('Number of lines to show before each match. Requires output_mode: "content".')
        },
        '-C': {
          type: 'number',
          description: markUntranslated('Number of lines to show before and after each match. Requires output_mode: "content".')
        },
        '-i': {
          type: 'boolean',
          description: markUntranslated('Case insensitive search')
        },
        '-n': {
          type: 'boolean',
          description: markUntranslated('Show line numbers in output. Defaults to true.')
        },
        multiline: {
          type: 'boolean',
          description: markUntranslated('Enable multiline mode where patterns can span lines. Default: false.')
        },
        head_limit: {
          type: 'number',
          description: markUntranslated('Limit output to first N entries.')
        },
        offset: {
          type: 'number',
          description: markUntranslated('Skip first N entries before applying head_limit.')
        },
        noIgnore: {
          type: 'boolean',
          description: markUntranslated('Search files ignored by .gitignore too. Default false.')
        }
      },
      required: ['pattern']
    };

    const description = markUntranslated('A powerful search tool built on ripgrep. Supports full regex syntax, file filtering with glob or type, and multiple output modes. Results respect nested .gitignore files by default; pass noIgnore to include ignored files.');

    return [
      {
        name: 'grep',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Contribute the headerless .gitignore toggle (respect .gitignore) to the
   * permission popup. Deduplicated with Glob's identical section by the shared `id`.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread - Owning thread
   * @returns {{id: string, order: number, element: HTMLElement, dispose: () => void}} Permission section
   */
  static getPermissionSection(messageThread) {
    return buildGitignoreSection(messageThread);
  }

  /**
   * Normalize grep/ripgrep-style flag names to internal format
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {GrepParams} Normalized parameters
   * @private
   */
  _normalizeParams(toolInput) {
    const params = /** @type {Record<string, unknown>} */ ({ ...toolInput });

    // The backend escape-hatch flags are set by execute() alone, past the
    // approval gate — never trusted from raw LLM input. execute() also
    // whitelists the fields it forwards, so this is defence in depth. See
    // path-approval.js.
    stripInjectedApprovalFlags(params);

    // Handle grep-style dash params: -A, -B, -C, -i, -n
    if (params['-A'] !== undefined) {
      params.contextAfter = params['-A'];
      delete params['-A'];
    }
    if (params['-B'] !== undefined) {
      params.contextBefore = params['-B'];
      delete params['-B'];
    }
    if (params['-C'] !== undefined) {
      params.contextLines = params['-C'];
      delete params['-C'];
    }
    if (params['-i'] !== undefined) {
      params.ignoreCase = params['-i'];
      delete params['-i'];
    }
    if (params['-n'] !== undefined) {
      params.showLineNumbers = params['-n'];
      delete params['-n'];
    }

    // Handle glob -> include alias for backend
    if (params.glob && !params.include) {
      params.include = params.glob;
    }

    // Handle type -> filePattern for backend (convert type like "js" to "*.js")
    if (params.type && !params.include) {
      params.include = `*.${params.type}`;
    }

    return /** @type {GrepParams} */ (params);
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = this._normalizeParams(toolInput);

    if (!params.pattern) {
      return { valid: false, error: 'Missing required parameter: pattern' };
    }
    if (typeof params.pattern !== 'string') {
      return { valid: false, error: 'Parameter "pattern" must be a string' };
    }

    return { valid: true, params };
  }

  /**
   * Does this search `path` contain glob metacharacters? The backend routes such
   * a path through doublestar over DirFS(projectRoot), which cannot escape the
   * project — so a glob path is always in-root and never needs approval. Mirrors
   * the backend's containsGlobChars (`*?[`).
   * @param {string} p - The search path
   * @returns {boolean} True if `p` is a glob pattern
   * @private
   */
  static _isGlobPath(p) {
    return /[*?[]/.test(p);
  }

  /**
   * A search is auto-approved unless its `path` is a concrete directory/file
   * OUTSIDE the project root and every granted allowed path. No path (defaults to
   * cwd) and glob paths (confined to the project by the backend) are always
   * permitted, so the common case never prompts.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {boolean} True if the search is auto-approved
   */
  isPermitted(toolInput) {
    if (!this.messageThread) return false;
    const path = toolInputPath(toolInput);
    if (!path || SearchContextItem._isGlobPath(path)) return true;
    return isPathAllowed(this, path);
  }

  /**
   * Offer a "don't ask again" grant for an out-of-root search: the search
   * directory itself. Returns `[]` when already permitted or the directory isn't
   * safely grantable (the user still gets a one-shot Yes / No then).
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions
   */
  getApprovalSuggestions(toolInput) {
    if (!this.messageThread || this.isPermitted(toolInput)) return [];
    const path = toolInputPath(toolInput);
    return folderGrantSuggestions(path, this.session?.home || '');
  }

  /**
   * Execute the search action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<SearchResult>} Action result
   */
  async execute(params) {
    /** @type {Record<string, unknown>} */
    const searchParams = {
      pattern: params.pattern
    };

    // Add optional params
    if (params.path) searchParams.path = params.path;
    if (params.include) searchParams.include = params.include;
    if (params.maxCount) searchParams.maxCount = params.maxCount;
    if (params.ignoreCase !== undefined) searchParams.ignoreCase = params.ignoreCase;
    if (params.noIgnore !== undefined) searchParams.noIgnore = params.noIgnore;

    // Conversation-level "search all files" toggle: force noIgnore when this
    // conversation has gitignore filtering switched off (an explicit
    // model-passed noIgnore already flows above; forcing true merges cleanly).
    if (gitignoreDisabled(this)) searchParams.noIgnore = true;

    // Reaching execute() past the approval gate means an out-of-root non-glob
    // path was explicitly approved; mark it so the backend admits this one
    // search (mirrors the read/write tools' outOfRootApproved).
    const path = /** @type {string} */ (params.path) || '';
    if (path && !SearchContextItem._isGlobPath(path) && !isPathAllowed(this, path)) {
      searchParams.outOfRootApproved = true;
    }

    // @ts-ignore - params validated above
    return await this.ops.grep(searchParams, this.signal);
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {Record<string, unknown>} */ (prepared?.params || {});
    const pattern = /** @type {string} */ (prepParams.pattern) || 'unknown';

    if (!outcome.success) {
      return this.failureSummary(outcome.error || `Search failed for ${pattern}`);
    }

    const result = /** @type {SearchResult} */ (outcome.result);

    // Format the search results for LLM - this goes in summary for tool_result
    const formattedContent = formatGrepResults(result, prepParams);

    return this.successSummary(
      this.truncateForLLM(formattedContent, { keywords: [pattern] }),
      { icon: result.matchCount > 0 ? '✓' : '○' }
    );
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const pattern = String(toolInput?.pattern || t('unknown'));
    const path = toolInput?.path ? String(toolInput.path) : null;
    const shownPath = path ? formatPathForStatus(path, this.session?.projectPath) : '';

    return this.buildStatusUI(actionStatus, {
      typeName: t('Grep'),
      pending: shownPath ? t('{pattern} in {path}...', { pattern, path: shownPath }) : `${pattern}...`,
      success: () => {
        const result = /** @type {SearchResult|undefined} */ (actionStatus?.result);
        if (!result) return shownPath ? t('{pattern} in {path}', { pattern, path: shownPath }) : pattern;
        const counts = { pattern, matchCount: result.matchCount, fileCount: result.fileCount };
        return shownPath
          ? t('{pattern} in {path} ({matchCount, plural, one {{matchCount} match} other {{matchCount} matches}} in {fileCount, plural, one {{fileCount} file} other {{fileCount} files}})', { ...counts, path: shownPath })
          : t('{pattern} ({matchCount, plural, one {{matchCount} match} other {{matchCount} matches}} in {fileCount, plural, one {{fileCount} file} other {{fileCount} files}})', counts);
      },
      failurePrefix: shownPath ? t('failed in {path}', { path: shownPath }) : t('failed')
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return t('Matches');
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    helpers.addSubsection(wrapper, t('Pattern'), inputText(input, 'pattern'), 'properties-panel-code');

    // Show which paths the grep was looking in. An explicit `path` narrows the
    // search; otherwise the search spans the conversation's allowed roots.
    if (input.path) {
      helpers.addSubsection(wrapper, t('Searched in'), String(input.path), 'properties-panel-code');
    } else {
      const allowed = this.getAllowedPaths();
      if (allowed.length > 0) {
        helpers.addSubsection(wrapper, t('Searched in'), allowed.join('\n'), 'properties-panel-code');
      }
    }
  }
}

export default SearchContextItem;
