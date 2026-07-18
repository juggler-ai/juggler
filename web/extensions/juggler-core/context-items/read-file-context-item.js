//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { readFile } from 'juggler/ops';
import { formatDisplayPath, formatFileSize, formatFileContentForLLM, createFileContentBlock, normalizeFilePath, injectFileContentStyles, basename } from 'juggler/item-utils';
import { createElement } from 'juggler/ui';
import { addFilePath } from 'juggler/ui';
import { smartTruncate } from 'juggler/ui';

injectFileContentStyles();

/**
 * @typedef {object} ReadFileParams
 * @property {string} path - File path relative to project root (alias: file_path)
 * @property {number} [offset] - Line number to start reading from (1-indexed)
 * @property {number} [limit] - Number of lines to read
 * @property {number} [tail] - Read last N lines only
 * @property {number} [head] - Read first N lines only
 * @property {{line: number, context: number}} [around] - Read lines around specific line
 * @property {{start: number, end: number}} [lineRange] - Specific line range
 */

/**
 * @typedef {object} ReadFileResult
 * @property {string} content - File content
 * @property {string} path - File path
 * @property {string} language - File language/extension
 * @property {number} size - File size in bytes
 * @property {number} totalLines - Total lines in file
 * @property {boolean} exists - Whether file exists
 * @property {string} readMode - Read mode description
 * @property {number} lineOffset - Starting line number (1-indexed)
 * @property {number} lineCount - Number of lines in content
 * @property {string|null} [warning] - Warning message (e.g., for binary files)
 */

/**
 * ReadFileContextItem - Immutable record of a `read_file` tool call.
 *
 * SEMANTICS (see docs/extension_guide.md §"Pinned file content"):
 *  - Represents a historical agent perception: "at this turn, I read these
 *    bytes." The recorded bytes are FROZEN — they never re-read from disk,
 *    never reflect later edits, and have no refresh affordance.
 *  - For a live, user-pinned reference that always reflects current disk
 *    contents, use `FileContentContextItem` instead.
 * @class
 * @augments ContextItem
 */
class ReadFileContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-file-read' };
  }

  static MANIFEST = {
    id: 'read-file',
    name: 'Read File',
    version: '1.0.0',
    description: 'Read file content with support for full files, line ranges, tail/head modes',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for Read action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read'
        },
        offset: {
          type: 'number',
          description: 'The line number to start reading from (1-indexed). Only provide if the file is too large to read at once.'
        },
        limit: {
          type: 'number',
          description: 'The number of lines to read. Only provide if the file is too large to read at once.'
        }
      },
      required: ['file_path']
    };

    const description = 'Reads a file from the local filesystem. Returns content wrapped in <file> tags with line numbers in cat -n format. By default reads up to 2000 lines. Use offset and limit for pagination on large files.';

    return [
      {
        name: 'read',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Normalize parameter names to internal format
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {ReadFileParams} Normalized parameters
   * @private
   */
  _normalizeParams(toolInput) {
    const params = normalizeFilePath(/** @type {Record<string, unknown>} */ ({ ...toolInput }));

    // Convert offset/limit to lineRange for backend
    if (params.offset !== undefined || params.limit !== undefined) {
      const offset = /** @type {number|undefined} */ (params.offset) || 1;
      const limit = /** @type {number|undefined} */ (params.limit) || 2000;
      params.lineRange = { start: offset, end: offset + limit - 1 };
      delete params.offset;
      delete params.limit;
    }

    return /** @type {ReadFileParams} */ (params);
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // Validate offset/limit in the LLM-facing vocabulary BEFORE normalizing to
    // the backend's lineRange schema — otherwise a bad value surfaces as a
    // "lineRange requires valid 'start' and 'end'" error that references
    // parameter names the LLM was never told about.
    if (toolInput.offset !== undefined) {
      if (typeof toolInput.offset !== 'number' || !Number.isFinite(toolInput.offset) || toolInput.offset <= 0) {
        return { valid: false, error: 'Parameter "offset" must be a positive integer (1-indexed line number)' };
      }
    }
    if (toolInput.limit !== undefined) {
      if (typeof toolInput.limit !== 'number' || !Number.isFinite(toolInput.limit) || toolInput.limit <= 0) {
        return { valid: false, error: 'Parameter "limit" must be a positive integer (number of lines to read)' };
      }
    }

    const params = this._normalizeParams(toolInput);

    // Accept both file_path and path
    const path = params.path || /** @type {string|undefined} */ (toolInput.file_path);
    if (!path) {
      return { valid: false, error: 'Missing required parameter: file_path' };
    }
    if (typeof path !== 'string') {
      return { valid: false, error: 'Parameter "file_path" must be a string' };
    }

    return { valid: true, params };
  }

  /**
   * Execute the read file action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<ReadFileResult>} Action result
   */
  async execute(params) {
    const readParams = /** @type {ReadFileParams} */ (params);
    return await readFile(readParams, this.signal, this.getToolAllowedRoots());
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{path?: string}} */ (prepared?.params || {});
    const result = /** @type {ReadFileResult|undefined} */ (outcome.result);
    // Prefer result.path (from backend) over prepParams.path (from input)
    const path = result?.path || prepParams.path || 'unknown';

    if (!outcome.success) {
      return {
        summary: outcome.error || `Failed to read ${path}`,
        details: '',
        success: false,
        icon: '✗'
      };
    }

    // Handle file doesn't exist - put full message in summary for tool_result
    if (result && result.exists === false) {
      return {
        summary: `File does not exist: ${path}. Do not attempt to read it again.`,
        details: '',
        success: true,
        icon: '✗'
      };
    }

    // Handle warning (e.g., binary file)
    if (result && result.warning) {
      return {
        summary: `${formatDisplayPath(path)} (${result.warning})`,
        details: `**WARNING**: ${result.warning}`,
        success: true,
        icon: '⚠'
      };
    }

    // Format the file content for LLM - this goes in summary for tool_result
    // At this point result must exist since outcome.success is true
    const formattedContent = this._formatFileContent(/** @type {ReadFileResult} */ (result));

    // Apply smart truncation
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: truncatedContent, truncated } = smartTruncate(formattedContent, {
      maxChars: budget
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
   * Format file content with line numbers for LLM
   * @param {ReadFileResult} result - Read result from backend
   * @returns {string} Formatted file content
   * @private
   */
  _formatFileContent(result) {
    return formatFileContentForLLM({
      content: result.content || '',
      path: result.path,
      lineOffset: result.lineOffset || 1,
      lineCount: result.lineCount,
      totalLines: result.totalLines,
      readMode: result.readMode
    });
  }

  /**
   * Get the full absolute path by resolving relative paths against the project root
   * @param {string} path - File path
   * @returns {string} Absolute file path
   */
  getAbsolutePath(path) {
    if (!path) return '';
    if (path.startsWith('/')) return path;
    const root = this.session?.projectPath;
    if (root) return `${root.replace(/\/+$/, '')}/${path}`;
    return path;
  }

  /**
   * Create properties panel view for read-file results.
   * Caller must set `this.data` to a ReadFileResult before calling.
   * @override
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const data = /** @type {ReadFileResult} */ (this.data);
    const container = createElement('div', 'file-content-expanded');

    const absPath = this.getAbsolutePath(data.path);
    const info = (data.exists && data.size)
      ? `${formatFileSize(data.size)} | ${data.totalLines} lines`
      : undefined;
    addFilePath(container, absPath || 'No file', info);

    // Handle file not found
    if (data.exists === false) {
      const notFound = createElement('div', 'file-content-not-found',
        `File not found: ${data.path}`);
      container.appendChild(notFound);
      return container;
    }

    // Handle warning (e.g., binary file)
    if (data.warning) {
      const warning = createElement('div', 'file-content-warning', data.warning);
      container.appendChild(warning);
      return container;
    }

    container.appendChild(createFileContentBlock({
      content: data.content || '',
      language: data.language || 'text',
      lineNumberStart: data.lineOffset || 1,
    }));

    return container;
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

    const path = /** @type {string} */ (toolInput?.file_path || toolInput?.path) || 'unknown';
    // Get just the filename for display
    const filename = basename(path) || path;

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `${filename}...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {ReadFileResult} */ (actionStatus.result);
      if (!result) {
        summary = filename;
        status = 'success';
      } else if (result.exists === false) {
        summary = `File not found: ${filename}`;
        status = 'error';
      } else if (result.warning) {
        summary = `${filename} (${result.warning})`;
        status = 'success';
      } else {
        status = 'success';
        const lineOffset = result.lineOffset || 1;
        const endLine = lineOffset + (result.lineCount || 0) - 1;
        const isFullFile = lineOffset === 1 && endLine === result.totalLines;

        if (isFullFile) {
          summary = `${filename} (${result.totalLines} lines)`;
        } else {
          summary = `${filename} (lines ${lineOffset}-${endLine} of ${result.totalLines})`;
        }
      }
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, `'${path}'`));
    }

    return { typeName: "Read", summary, status };
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Content';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    // If we have a successful read with full action data, use the rich panel
    const result = toolAction.get('result');
    const fullResult = result?.get ? result.get('fullResult') : result?.fullResult;
    const fullResultObj = fullResult?.toJSON ? fullResult.toJSON() : fullResult;
    const actionData = fullResultObj?.success ? fullResultObj.result : null;
    const error = result?.get ? result.get('error') : result?.error;
    const cancelled = result?.get ? result.get('cancelled') : result?.cancelled;

    if (actionData && !error && !cancelled) {
      const instance = new (/** @type {any} */ (this.constructor))({
        id: ctx.selectedItemId || 'properties-panel',
        session: ctx.session,
        conversation: ctx.conversation,
        messageThread: ctx.messageThread,
      });
      instance.data = actionData;
      const panelEl = instance.createPropertiesPanelElement();
      const contentSection = document.createElement('div');
      contentSection.className = 'context-item-expanded-content';
      contentSection.appendChild(panelEl);
      wrapper.appendChild(contentSection);
      return { skipResultSection: true };
    }

    helpers.addFilePath(wrapper, input.file_path || input.path || '');
  }
}

export default ReadFileContextItem;
