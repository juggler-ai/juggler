//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { grep } from 'juggler/ops';
import { formatPathForStatus } from 'juggler/item-utils';
import { smartTruncate } from 'juggler/ui';

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
    requiresApproval: false
  };

  /**
   * Get tool definitions for Grep action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for in file contents'
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to current working directory.'
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g., "*.js", "*.{ts,tsx}")'
        },
        type: {
          type: 'string',
          description: 'File type to search (e.g., js, py, go, rust). More efficient than glob for standard file types.'
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.'
        },
        '-A': {
          type: 'number',
          description: 'Number of lines to show after each match. Requires output_mode: "content".'
        },
        '-B': {
          type: 'number',
          description: 'Number of lines to show before each match. Requires output_mode: "content".'
        },
        '-C': {
          type: 'number',
          description: 'Number of lines to show before and after each match. Requires output_mode: "content".'
        },
        '-i': {
          type: 'boolean',
          description: 'Case insensitive search'
        },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in output. Defaults to true.'
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline mode where patterns can span lines. Default: false.'
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries.'
        },
        offset: {
          type: 'number',
          description: 'Skip first N entries before applying head_limit.'
        }
      },
      required: ['pattern']
    };

    const description = 'A powerful search tool built on ripgrep. Supports full regex syntax, file filtering with glob or type, and multiple output modes.';

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
   * Normalize grep/ripgrep-style flag names to internal format
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {GrepParams} Normalized parameters
   * @private
   */
  _normalizeParams(toolInput) {
    const params = /** @type {Record<string, unknown>} */ ({ ...toolInput });

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

    // @ts-ignore - params validated above
    return await grep(this._withConv(searchParams), this.signal, this.getToolAllowedRoots());
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
      return {
        summary: outcome.error || `Search failed for ${pattern}`,
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {SearchResult} */ (outcome.result);

    // Format the search results for LLM - this goes in summary for tool_result
    const formattedContent = this._formatSearchResults(result, prepParams);

    // Apply smart truncation with keyword context
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: truncatedContent, truncated } = smartTruncate(formattedContent, {
      maxChars: budget,
      keywords: [pattern]
    });

    return {
      summary: truncated
        ? truncatedContent + `\n\n(Output truncated from ${formattedContent.length} to ${truncatedContent.length} chars)`
        : formattedContent,
      details: '',
      success: true,
      icon: result.matchCount > 0 ? '✓' : '○'
    };
  }

  /**
   * Format search results for LLM based on output_mode
   * @param {SearchResult} result - Search result from backend
   * @param {Record<string, unknown>} params - Original params
   * @returns {string} Formatted search results
   * @private
   */
  _formatSearchResults(result, params) {
    const pattern = /** @type {string} */ (params.pattern) || 'unknown';
    const matches = result.matches || [];
    const outputMode = /** @type {string} */ (params.output_mode) || 'files_with_matches';
    const headLimit = /** @type {number|undefined} */ (params.head_limit);
    const offset = /** @type {number|undefined} */ (params.offset) || 0;

    if (matches.length === 0) {
      return `No matches found for pattern: ${pattern}`;
    }

    // Group by file for better readability
    const fileGroups = this._groupMatchesByFile(matches);
    const files = Object.keys(fileGroups);

    // Handle different output modes
    if (outputMode === 'count') {
      // Just show counts per file
      let results = '';
      let fileIndex = 0;
      let shownCount = 0;
      const totalFiles = files.length;

      for (const file of files) {
        if (fileIndex++ < offset) continue;
        if (headLimit && shownCount >= headLimit) break;

        const count = /** @type {SearchMatch[]} */ (fileGroups[file]).length; // bounded: file from Object.keys(fileGroups)
        results += `${file}:${count}\n`;
        shownCount++;
      }

      if (headLimit && shownCount < totalFiles - offset) {
        results += `\n(Showing ${shownCount} of ${totalFiles} files. Use offset=${offset + shownCount} to see more.)`;
      }

      return results.trim();
    }

    if (outputMode === 'files_with_matches') {
      // Just show file paths (default mode - most compact)
      let shownCount = 0;
      const totalFiles = files.length;
      /** @type {string[]} */
      const outputFiles = [];

      for (const [i, file] of files.entries()) {
        if (i < offset) continue;
        if (headLimit && shownCount >= headLimit) break;

        outputFiles.push(file);
        shownCount++;
      }

      let results = outputFiles.join('\n');

      if (headLimit && shownCount < totalFiles - offset) {
        results += `\n\n(Showing ${shownCount} of ${totalFiles} files. Use offset=${offset + shownCount} to see more.)`;
      }

      return results;
    }

    // outputMode === 'content' - show full matching lines
    let results = '';
    let entryIndex = 0;
    let shownCount = 0;
    const totalMatches = matches.length;

    for (const [file, fileMatches] of Object.entries(fileGroups)) {
      /** @type {string[]} */
      const fileLines = [];

      for (const match of fileMatches) {
        if (entryIndex++ < offset) continue;
        if (headLimit && shownCount >= headLimit) break;

        const line = match.line || '?';
        const content = match.content || '';
        fileLines.push(`${line}: ${content}`);
        shownCount++;
      }

      if (fileLines.length > 0) {
        results += `${file}:\n${fileLines.join('\n')}\n\n`;
      }

      if (headLimit && shownCount >= headLimit) break;
    }

    if (headLimit && shownCount < totalMatches - offset) {
      results += `(Showing ${shownCount} of ${totalMatches} matches. Use offset=${offset + shownCount} to see more.)`;
    }

    return results.trim();
  }

  /**
   * Group matches by file
   * @param {SearchMatch[]} matches - Array of match objects
   * @returns {Record<string, SearchMatch[]>} Matches grouped by file
   * @private
   */
  _groupMatchesByFile(matches) {
    /** @type {Record<string, SearchMatch[]>} */
    const groups = {};

    for (const match of matches) {
      const file = match.file || 'unknown';
      if (!groups[file]) {
        groups[file] = [];
      }
      groups[file].push(match);
    }

    return groups;
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) {
      return null;
    }

    const pattern = String(toolInput?.pattern || 'unknown');
    const path = toolInput?.path ? String(toolInput.path) : null;
    const pathSuffix = path ? ` in ${formatPathForStatus(path, this.session?.projectPath)}` : '';

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `${pattern}${pathSuffix}...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {SearchResult|undefined} */ (actionStatus.result);
      summary = result
        ? `${pattern}${pathSuffix} (${result.matchCount} matches in ${result.fileCount} files)`
        : `${pattern}${pathSuffix}`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, `failed${pathSuffix}`));
    }

    return { typeName: 'Grep', summary, status };
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Matches';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    helpers.addSubsection(wrapper, 'Pattern', input.pattern || '', 'properties-panel-code');

    // Show which paths the grep was looking in. An explicit `path` narrows the
    // search; otherwise the search spans the conversation's allowed roots.
    if (input.path) {
      helpers.addSubsection(wrapper, 'Searched in', String(input.path), 'properties-panel-code');
    } else {
      const allowed = this.getAllowedPaths();
      if (allowed.length > 0) {
        helpers.addSubsection(wrapper, 'Searched in', allowed.join('\n'), 'properties-panel-code');
      }
    }
  }
}

export default SearchContextItem;
