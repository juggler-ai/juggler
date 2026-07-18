//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { glob } from 'juggler/ops';
import { formatPathForStatus } from 'juggler/item-utils';
import { smartTruncate } from 'juggler/ui';

/**
 * @typedef {object} GlobParams
 * @property {string} pattern - Glob pattern (e.g., "src/*.js" or deep patterns)
 * @property {string} [path] - Directory to search in (default: project root)
 */

/**
 * @typedef {object} GlobResult
 * @property {string[]} files - Matching file paths sorted by modification time
 * @property {string} pattern - Pattern that was used
 * @property {string} path - Search path used
 * @property {number} count - Number of files found
 * @property {boolean} truncated - Whether results were truncated
 */

/**
 * GlobContextItem - Find files matching a glob pattern
 *
 * Returns matching file paths sorted by modification time.
 * Supports glob patterns like "src/*.js" or deep recursive patterns.
 * @class
 * @augments ContextItem
 */
class GlobContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'glob',
    name: 'Glob',
    version: '1.0.0',
    description: 'Fast file pattern matching tool that works with any codebase size',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for Glob action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against'
        },
        path: {
          type: 'string',
          description: 'The directory to search in. If not specified, the current working directory will be used.'
        }
      },
      required: ['pattern']
    };

    const description = 'Fast file pattern matching tool that works with any codebase size. Returns matching file paths sorted by modification time.';

    return [
      {
        name: 'glob',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {GlobParams} */ (toolInput);

    if (!params.pattern) {
      return { valid: false, error: 'Missing required parameter: pattern' };
    }
    if (typeof params.pattern !== 'string') {
      return { valid: false, error: 'Parameter "pattern" must be a string' };
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Execute the glob action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<GlobResult>} Action result
   */
  async execute(params) {
    const globParams = /** @type {GlobParams} */ (params);
    return await glob(globParams, this.signal, this.getToolAllowedRoots());
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{pattern?: string}} */ (prepared?.params || {});
    const pattern = prepParams.pattern || 'unknown';

    if (!outcome.success) {
      return {
        summary: outcome.error || `Failed to glob ${pattern}`,
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {GlobResult} */ (outcome.result);

    // Format the file list for LLM
    const formattedContent = this._formatGlobContent(result);

    // Apply smart truncation with pattern keyword
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const keywords = pattern ? [pattern] : [];
    const { content: truncatedContent, truncated } = smartTruncate(formattedContent, {
      maxChars: budget,
      keywords
    });

    return {
      summary: truncated
        ? truncatedContent + `\n\n(Output truncated from ${formattedContent.length} to ${truncatedContent.length} chars)`
        : formattedContent,
      details: '',
      success: true,
      icon: '✓'
    };
  }

  /**
   * Format glob result for LLM
   * @param {GlobResult} result - Glob result from backend
   * @returns {string} Formatted glob content
   * @private
   */
  _formatGlobContent(result) {
    const files = result.files || [];
    const count = result.count || files.length;
    const truncated = result.truncated || false;

    if (files.length === 0) {
      return `No files found matching pattern: ${result.pattern}`;
    }

    let content = files.join('\n');
    if (truncated) {
      content += `\n\n(Results truncated. Showing ${files.length} of ${count} matches)`;
    }

    return content;
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @param {{conversation?: unknown, session?: unknown, toolUseId?: string}} [context] - Optional context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput, context) {
    if (!actionStatus) {
      return null;
    }

    const pattern = /** @type {string} */ (toolInput?.pattern) || 'unknown';
    const searchPath = /** @type {string|undefined} */ (toolInput?.path);
    const projectPath = /** @type {any} */ (context?.session)?.projectPath || this.session?.projectPath;
    const displayPattern = searchPath ? `${formatPathForStatus(searchPath, projectPath)}/${pattern}` : pattern;

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `${displayPattern}...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {GlobResult} */ (actionStatus.result);
      const count = result
        ? (result.count ?? /** @type {any} */ (result).filesCount ?? result.files?.length ?? 0)
        : 0;
      summary = `${count} file${count === 1 ? '' : 's'} matching ${displayPattern}`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, 'failed'));
    }

    return { typeName: 'Glob', summary, status };
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
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    helpers.addSubsection(wrapper, 'Pattern', input.pattern || '', 'properties-panel-code');
    if (input.path) {
      helpers.addSubsection(wrapper, 'Path', input.path, 'properties-panel-code');
    }
  }
}

export default GlobContextItem;
