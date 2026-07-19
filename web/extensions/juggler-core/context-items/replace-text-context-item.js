//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import EditBase from './edit-base.js';
import { editFile } from 'juggler/ops';
import { normalizeFilePath, basename } from 'juggler/item-utils';

/**
 * @typedef {object} ReplaceTextParams
 * @property {string} path - File path relative to project root
 * @property {string} old_str - Exact content to find and replace (aliases: oldContent, old, pattern, search)
 * @property {string} new_str - New content to replace with (aliases: newContent, new, replacement, replace)
 */

/**
 * @typedef {object} ReplaceTextResult
 * @property {string} path - Path of edited file
 * @property {string} [method] - Edit method used
 */

/**
 * ReplaceTextContextItem - Search and replace text in files with diff preview
 *
 * Superior to WriteFileContextItem for modifying existing files.
 * Shows a diff view in approval modal before applying changes.
 * @class
 * @augments EditBase
 */
class ReplaceTextContextItem extends EditBase {
  static MANIFEST = {
    id: 'replace-text',
    name: 'Replace Text',
    version: '1.0.0',
    description: 'Find and replace text in files',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'edit', icon: 'icon-edit-file' };
  }

  /**
   * Get tool definitions for Edit action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify. Must be inside the working directory unless the user explicitly asked for a location outside it.'
        },
        old_string: {
          type: 'string',
          description: 'The text to replace (must be different from new_string)'
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)'
        },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'Replace all occurrences of old_string (default false)'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    };

    const description = 'Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.';

    return [
      {
        name: 'edit',
        category: 'write',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Normalize parameter names to standard path/old_str/new_str
   * Handles current-style (file_path, old_string, new_string) and legacy style (old_str, new_str)
   * @param {Record<string, any>} params - Raw parameters from LLM
   * @returns {ReplaceTextParams & {replace_all?: boolean}} Normalized parameters
   * @private
   */
  _normalizeParams(params) {
    const normalized = normalizeFilePath({ ...params });

    // Handle current-style: old_string -> old_str
    if (normalized.old_string && !normalized.old_str) {
      normalized.old_str = normalized.old_string;
    }

    // Handle current-style: new_string -> new_str
    if (normalized.new_string && !normalized.new_str) {
      normalized.new_str = normalized.new_string;
    }

    // Use shared normalization utilities from EditBase as fallback
    if (!normalized.old_str) {
      normalized.old_str = EditBase._normalizeOldContent(params);
    }
    if (!normalized.new_str) {
      normalized.new_str = EditBase._normalizeNewContent(params);
    }

    return /** @type {ReplaceTextParams & {replace_all?: boolean}} */ (normalized);
  }

  /**
   * Validate and normalize parameters for execution.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // Normalize params before validation
    const params = this._normalizeParams(/** @type {Record<string, any>} */ (toolInput));

    // Validation - use current-style names in error messages
    if (params.path === undefined || params.path === null) {
      return { valid: false, error: 'Missing required parameter: file_path' };
    }
    if (typeof params.path !== 'string') {
      return { valid: false, error: 'Parameter "file_path" must be a string' };
    }
    if (params.old_str === undefined || params.old_str === null) {
      return { valid: false, error: 'Missing required parameter: old_string' };
    }
    if (typeof params.old_str !== 'string') {
      return { valid: false, error: 'Parameter "old_string" must be a string' };
    }
    if (params.new_str === undefined || params.new_str === null) {
      return { valid: false, error: 'Missing required parameter: new_string' };
    }
    if (typeof params.new_str !== 'string') {
      return { valid: false, error: 'Parameter "new_string" must be a string' };
    }

    // Call backend with dryRun to get complete file content for diff
    /** @type {import('../../../js/services/ops-api.js').ReadFileEditResult} */
    let result;
    try {
      result = await editFile(
        this._withConv({ ...params, dryRun: true })
      );
    } catch (err) {
      // If string not found, check if size was the likely cause and give helpful error
      const oldContentLines = params.old_str.split('\n').length;
      const oldContentChars = params.old_str.length;
      const MAX_LINES = 3;
      const MAX_CHARS = 150;

      if (oldContentLines > MAX_LINES || oldContentChars > MAX_CHARS) {
        return {
          valid: false,
          error: `The old_str is too large (${oldContentLines} lines, ${oldContentChars} characters). ` +
                        `replace-text only works reliably for tiny, surgical edits (≤${MAX_LINES} lines, ≤${MAX_CHARS} characters). ` +
                        `Use the write tool to rewrite the file instead.`
        };
      }
      // String was small enough but still didn't match - return validation error
      // (includes ambiguous matches, file not found, etc.)
      return {
        valid: false,
        error: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
      };
    }

    // The backend returns search-not-found / file-not-found / ambiguous-match
    // as `{ success: false, errorCode, ... }` data WITHOUT throwing, so the
    // try/catch above doesn't see them. Inspect the dryRun result here and
    // reject at validation time — otherwise the framework would proceed to
    // request approval for an edit that cannot apply, surfacing a useless
    // diff-less approval modal to the user before the action ultimately
    // fails at execute time.
    if (result && /** @type {any} */ (result).success === false) {
      const { llmMessage } = this.formatError(/** @type {any} */ (result), 'edit');
      return { valid: false, error: llmMessage };
    }

    // Cache dryRun result for getApprovalConfig()
    return {
      valid: true,
      params: { ...params, _dryRunResult: result }
    };
  }

  /**
   * Build approval UI configuration with diff preview.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const path = /** @type {string} */ (params.path);
    const result = /** @type {import('../../../js/services/ops-api.js').ReadFileEditResult} */ (params._dryRunResult);

    const diffData = {
      oldContent: result.oldContent || '',
      newContent: result.newContent || /** @type {string} */ (params.new_str),
      path,
      startLineNumber: 1
    };

    return this._buildApprovalConfig(path, diffData);
  }

  /**
   * Execute the replace text action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<ReplaceTextResult>} Action result
   */
  async execute(params) {
    // Normalize params (may have been passed raw toolInput)
    const normalizedParams = this._normalizeParams(/** @type {Record<string, any>} */ (params));

    // Carry the allowed-paths grant and mark an out-of-root target as approved so
    // the backend's defence-in-depth check admits the edit (see EditBase._authorizeWrite).
    const { params: sendParams, allowedPaths } = this._authorizeWrite(normalizedParams);

    // Call typed ops API
    const result = await editFile(
      this._withConv(sendParams),
      this.signal,
      allowedPaths
    );

    return result;
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    // Extract path from prepared params for cancelled messages
    const prepared = outcome.prepared;
    const prepParams = /** @type {{path?: string}} */ (prepared?.params || {});
    const prepPath = prepParams.path || 'unknown';

    // Handle non-success cases
    if (outcome.cancelled) {
      return { summary: `Replace text cancelled: ${prepPath}`, details: '', success: false, icon: '✗' };
    }
    if (!outcome.success) {
      // Check if we have structured error info from backend
      const result = /** @type {{success: boolean, errorCode: string, path: string, hasEscaping?: boolean, hasNearMatch?: boolean, nearMatchLine?: number, contextLines?: string}|undefined} */ (outcome.result);
      if (result && result.path) {
        const { userMessage, llmMessage } = this.formatError(result, 'edit');
        return {
          summary: `Replace text failed: ${userMessage}`,
          details: '',
          success: false,
          icon: '✗',
          feedbackForLLM: llmMessage
        };
      }
      return { summary: `Replace text failed: ${outcome.error}`, details: '', success: false, icon: '✗' };
    }

    // Success case
    const result = /** @type {ReplaceTextResult} */ (outcome.result);
    return this._formatEditResult(
      result.path,
      `Modified ${result.path} using ${result.method || 'edit'}`
    );
  }

  /**
   * Format structured error from backend into user and LLM messages.
   * Called when backend returns success: false with error diagnostics.
   * @param {object} result - Structured error result from backend
   * @param {boolean} result.success - Always false for errors
   * @param {string} result.errorCode - Error code (e.g., 'SEARCH_NOT_FOUND')
   * @param {string} result.path - File path
   * @param {boolean} [result.hasEscaping] - Whether escaping issues detected
   * @param {boolean} [result.hasNearMatch] - Whether similar content found nearby
   * @param {number} [result.nearMatchLine] - Line number of near match
   * @param {string} [result.contextLines] - Raw context lines for LLM
   * @param {string} _toolName - Name of the tool that failed
   * @returns {{userMessage: string, llmMessage: string}} Dual messages
   */
  formatError(result, _toolName) {
    // User-friendly message - short and clear with filename
    const filename = result.path ? basename(result.path) || result.path : 'unknown';
    const userMessage = `failed in ${filename}`;

    // LLM message with technical details for self-correction (built as array to avoid += lint rule)
    const llmParts = [`Search failed in '${result.path}'.`];
    if (result.hasEscaping) {
      llmParts.push("ESCAPING ERROR: old_str is LITERAL, don't escape backticks, ${}, (), [], {}.");
    }
    if (result.hasNearMatch && result.nearMatchLine) {
      llmParts.push(`Similar content near line ${result.nearMatchLine}.`);
    }
    if (result.contextLines) {
      llmParts.push(result.contextLines);
    }
    llmParts.push('Re-read file and use exact text including whitespace.');
    const llmMessage = llmParts.join(' ');

    return { userMessage, llmMessage };
  }

  /**
   * Get status UI configuration
   *
   * Provides status message with expandable diff view.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) {
      return null;
    }

    /** @type {any} */
    const displayData = actionStatus.displayData;

    /** @type {any} */
    const result = actionStatus.result || {};
    const path = result.path || toolInput?.file_path || toolInput?.path || 'unknown';
    // Get just the filename for display
    const filename = basename(path) || path;

    // Build summary
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;

    if (actionStatus.pending) {
      // Pending/approval state - use title from display data
      summary = displayData?.title || filename;
      status = 'running';
    } else if (actionStatus.success) {
      summary = filename;
      status = 'success';
    } else if (actionStatus.cancelled) {
      summary = `cancelled: ${filename}`;
      status = 'cancelled';
    } else {
      // When no path is available (e.g. validation rejected the call
      // before it ran), `failed in unknown` hides the actual reason —
      // surface the raw error message instead.
      const hasPath = result.path || toolInput?.file_path || toolInput?.path;
      summary = hasPath
        ? `failed in ${filename}`
        : (actionStatus.error || /** @type {any} */ (actionStatus).content || 'failed');
      status = 'error';
    }

    return { typeName: 'Replace', summary, status };
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    const filePath = input.file_path || input.path || '';
    helpers.addFilePath(wrapper, filePath);

    const result = toolAction.get('result');
    const isError = result
      ? (result.get ? result.get('isError') : result?.isError)
      : false;

    if (isError) {
      if (input.old_string !== undefined) {
        helpers.addSubsection(wrapper, 'Search', input.old_string, 'properties-panel-code');
      }
      if (input.new_string !== undefined) {
        helpers.addSubsection(wrapper, 'Replace', input.new_string, 'properties-panel-code');
      }
      const fullResult = result.get ? result.get('fullResult') : result?.fullResult;
      const fullObj = fullResult?.toJSON ? fullResult.toJSON() : fullResult;
      const errorText = fullObj?.llmFeedback || fullObj?.error || 'Edit failed';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'properties-panel-result error';
      errorDiv.textContent = errorText;
      wrapper.appendChild(errorDiv);
    } else if (!helpers.addDiffViewer(wrapper, toolAction, filePath)) {
      if (input.old_string !== undefined) {
        helpers.addSubsection(wrapper, 'Search', input.old_string, 'properties-panel-code');
      }
      if (input.new_string !== undefined) {
        helpers.addSubsection(wrapper, 'Replace', input.new_string, 'properties-panel-code');
      }
    }
    return { skipResultSection: true };
  }
}

export default ReplaceTextContextItem;
