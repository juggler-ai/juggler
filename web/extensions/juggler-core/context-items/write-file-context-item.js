//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import EditBase from './edit-base.js';
import { readFile, writeFile } from 'juggler/ops';
import { formatDisplayPath, normalizeFilePath, createFileContentBlock, basename } from 'juggler/item-utils';

/** @type {Record<string, string>} */
const LANG_MAP = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', go: 'go', java: 'java', c: 'c', cpp: 'cpp', rs: 'rust',
  rb: 'ruby', php: 'php', html: 'html', css: 'css', json: 'json',
  yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'bash', sql: 'sql',
};

/**
 * @typedef {object} WriteFileParams
 * @property {string} path - File path relative to project root
 * @property {string} content - Complete file content to write
 */

/**
 * @typedef {object} WriteFileResult
 * @property {string} path - File path that was written
 * @property {boolean} created - True if file was created, false if updated
 * @property {number} size - File size in bytes
 */

/**
 * @typedef {object} ContentData
 * @property {string} content - File content to write
 * @property {string} path - File path
 * @property {string} language - Language for syntax highlighting
 * @property {boolean} fileExists - Whether file already exists
 */

/**
 * @typedef {object} BackendResult
 * @property {boolean} exists - Whether file exists
 */

/**
 * WriteFileContextItem - Create or overwrite files
 *
 * Executes file write operations via backend API.
 * Requires user approval by default.
 * @class
 * @augments EditBase
 */
class WriteFileContextItem extends EditBase {
  static MANIFEST = {
    id: 'write-file',
    name: 'Write File',
    version: '1.0.0',
    description: 'Create or overwrite files with new content',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'edit', icon: 'icon-edit-file' };
  }

  /**
   * Get tool definitions for Write action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write. Must be inside the working directory unless the user explicitly asked for a location outside it.'
        },
        content: {
          type: 'string',
          description: 'The content to write to the file'
        }
      },
      required: ['file_path', 'content']
    };

    const description = 'Writes a file to the local filesystem. This will overwrite the existing file if there is one.';

    return [
      {
        name: 'write',
        category: 'write',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Normalize parameter names to internal format
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {WriteFileParams} Normalized parameters
   * @private
   */
  _normalizeParams(toolInput) {
    const params = normalizeFilePath(/** @type {Record<string, unknown>} */ ({ ...toolInput }));
    return /** @type {WriteFileParams} */ (params);
  }

  /**
   * Validate and normalize parameters for execution.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = this._normalizeParams(toolInput);

    // Validation - accept both file_path and path
    const path = params.path;
    if (!path) {
      return { valid: false, error: 'Missing required parameter: file_path' };
    }
    if (params.content === undefined || params.content === null) {
      return { valid: false, error: 'Missing required parameter: content' };
    }
    if (typeof path !== 'string') {
      return { valid: false, error: 'Parameter "file_path" must be a string' };
    }
    if (typeof params.content !== 'string') {
      return { valid: false, error: 'Parameter "content" must be a string' };
    }

    // Load existing content (if any) so the approval UI can show a diff.
    /** @type {string|undefined} */
    let existingContent;
    try {
      const result = await readFile(this._withConv({ path }));
      if (result.exists && result.content !== undefined) {
        existingContent = result.content;
      }
    } catch {
      // No existing file to diff against; the approval UI shows a content preview.
    }

    // Pre-approval dry-run: ask the backend whether the write would actually
    // succeed (parent dir creatable, target writable, target not a directory,
    // …) before we ask the user to approve. If it can't, fail at validation
    // and skip the approval modal entirely — mirrors replace-text.
    try {
      await writeFile(this._withConv({ path, content: params.content, dryRun: true }));
    } catch (err) {
      return {
        valid: false,
        error: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
      };
    }

    return {
      valid: true,
      params: { ...params, _existingContent: existingContent }
    };
  }

  /**
   * Build approval UI configuration with diff or content preview.
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const path = /** @type {string} */ (params.path);
    const content = /** @type {string} */ (params.content);
    const existingContent = /** @type {string|undefined} */ (params._existingContent);

    // Make an out-of-project target unmistakable: full absolute path as the
    // title (not `./`-prefixed, which reads as project-relative) plus a warning.
    const outOfRoot = path && !this._isPathAllowed(path);
    const title = outOfRoot ? path : formatDisplayPath(path);
    const message = outOfRoot ? `⚠ Write outside the project folder: ${path}` : '';

    if (existingContent !== undefined) {
      // File exists - show diff
      const diffData = {
        oldContent: existingContent,
        newContent: content,
        path,
        startLineNumber: 1
      };
      return {
        title,
        message,
        display: { diffData }
      };
    }

    // File doesn't exist - show content preview
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const contentData = {
      content,
      path,
      language: LANG_MAP[ext] || 'text',
      fileExists: false
    };

    return {
      title,
      message,
      display: { contentData }
    };
  }

  /**
   * Execute the write file action
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<WriteFileResult>} Action result
   */
  async execute(params) {
    const writeParams = /** @type {WriteFileParams} */ (params);

    // Approval is enforced upstream by the JS action-executor flow. Carry the
    // standing allowed-paths grant, and mark an out-of-root target as
    // user-approved (only reachable here via an explicit modal approval), so the
    // backend's defence-in-depth check admits the write.
    const { params: sendParams, allowedPaths } = this._authorizeWrite(writeParams);
    const result = await writeFile(
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

    // Handle non-success cases (check !success first for type narrowing)
    if (!outcome.success) {
      if (outcome.cancelled) {
        return { summary: `Write file cancelled: ${prepPath}`, details: '', success: false, icon: '✗' };
      }
      return { summary: `Write file failed: ${outcome.error}`, details: '', success: false, icon: '✗' };
    }

    // Success case
    const result = /** @type {WriteFileResult} */ (outcome.result);
    const path = result.path;
    const action = result.created ? 'Created' : 'Updated';
    const size = result.size;

    // Generate feedback for LLM
    const feedbackForLLM = this._generateFeedbackForLLM(path);

    return {
      summary: `${action} file: ${path}`,
      details: `${action} ${path} (${size} bytes)`,
      success: true,
      icon: result.created ? '✓' : '↻',
      feedbackForLLM
    };
  }

  /**
   * Generate feedback for LLM based on file type
   * @param {string} path - File path
   * @returns {string|undefined} Feedback message or undefined
   * @private
   */
  _generateFeedbackForLLM(path) {
    const hints = [];

    // Suggest testing for source files
    if (/\.(js|ts|py|go|java|rb|php|cs|rs)$/.test(path)) {
      hints.push('Consider running tests to verify your changes');
    }

    // Warn about missing build for compiled languages
    if (/\.(go|java|cs|cpp|c|rs)$/.test(path)) {
      hints.push('Remember to rebuild before testing');
    }

    return hints.length > 0 ? hints.join('. ') : undefined;
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

    // Get display data from displayData (set during prepare)
    /** @type {any} */
    const displayData = actionStatus.displayData;
    /** @type {any} */
    const diffData = displayData?.diffData;
    /** @type {any} */
    const contentData = displayData?.contentData;

    /** @type {any} */
    const result = actionStatus.result || {};
    const path = result.path || toolInput?.file_path || toolInput?.path || contentData?.path || diffData?.path || 'unknown';
    // Get just the filename for display
    const filename = basename(path) || path;

    // Build summary
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;

    if (actionStatus.pending) {
      // Pending/approval state - use title from display data
      summary = displayData?.title || `${filename}`;
      status = 'running';
    } else if (actionStatus.success) {
      const action = result.created ? 'Created' : 'Updated';
      summary = `${action} ${filename}`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, filename, `cancelled: ${filename}`));
    }

    return { typeName: "Write", summary, status };
  }

  /**
   * Append an error or cancellation result banner above the content preview.
   * @param {HTMLElement} wrapper
   * @param {{isError?: boolean, cancelled?: boolean, fullResult?: {error?: string}, content?: string}} result
   * @private
   */
  _appendOutcomeBanner(wrapper, result) {
    const section = document.createElement('properties-panel-subsection');
    const label = document.createElement('h4');
    label.className = 'properties-panel-subtitle';
    label.textContent = 'Result';
    section.appendChild(label);
    const div = document.createElement('div');
    div.className = result.cancelled ? 'properties-panel-result cancelled' : 'properties-panel-result error';
    div.textContent = result.cancelled ? 'Cancelled' : (result.fullResult?.error || result.content || 'Error');
    section.appendChild(div);
    wrapper.appendChild(section);
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    const filePath = input.file_path || input.path || '';
    helpers.addFilePath(wrapper, filePath);

    // Show outcome (error/cancellation) first, then fall through to also show
    // what the LLM intended to write so the user can inspect it.
    const rawResult = toolAction.get('result');
    const result = rawResult?.toJSON ? rawResult.toJSON() : rawResult;
    if (result?.isError || result?.cancelled) {
      this._appendOutcomeBanner(wrapper, result);
    }

    if (!helpers.addDiffViewer(wrapper, toolAction, filePath) && input.content) {
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const section = document.createElement('div');
      section.className = 'context-item-expanded-content';
      section.appendChild(createFileContentBlock({
        content: input.content,
        language: LANG_MAP[ext] || 'text',
        lineNumberStart: 1,
      }));
      wrapper.appendChild(section);
    }

    // This plugin always owns its full display; suppress the generic result section.
    return { skipResultSection: true };
  }
}

export default WriteFileContextItem;
