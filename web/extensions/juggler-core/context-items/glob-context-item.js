//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatPathForStatus } from 'juggler/item-utils';
import { translator, markUntranslated } from 'juggler/i18n';
import { toolInputPath, isPathAllowed, folderGrantSuggestions, stripInjectedApprovalFlags, gitignoreDisabled } from './path-approval.js';
import { buildGitignoreSection } from './search-scope-section.js';
import { inputText } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * @typedef {object} GlobParams
 * @property {string} pattern - Glob pattern (e.g., "src/*.js" or deep patterns)
 * @property {string} [path] - Directory to search in (default: project root)
 * @property {boolean} [noIgnore] - Match files ignored by .gitignore too
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
    // Approval-gated like read: the `pattern` is confined to `path` by the
    // backend, so only an out-of-root search `path` prompts. No path (cwd) or an
    // in-project path is auto-approved, so the common case is silent.
    requiresApproval: true
  };

  /**
   * Get tool definitions for Glob action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: markUntranslated('The glob pattern to match files against')
        },
        path: {
          type: 'string',
          description: markUntranslated('The directory to search in. If not specified, the current working directory will be used.')
        },
        noIgnore: {
          type: 'boolean',
          description: markUntranslated('Match files ignored by .gitignore too. Default false.')
        }
      },
      required: ['pattern']
    };

    const description = markUntranslated('Fast file pattern matching tool that works with any codebase size. Returns matching file paths sorted by modification time. Results respect nested .gitignore files by default; pass noIgnore to include ignored files.');

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

    // The backend escape-hatch flags (outOfRootApproved/userInitiated) are set by
    // execute() alone, past the approval gate — never trusted from raw LLM input.
    // execute() spreads these params, so strip on a copy here. See path-approval.js.
    return { valid: true, params: stripInjectedApprovalFlags({ ...toolInput }) };
  }

  /**
   * A glob is auto-approved unless its `path` (the search directory — the glob
   * `pattern` is applied within it and cannot escape) is OUTSIDE the project root
   * and every granted allowed path. No path defaults to cwd and is permitted, so
   * the common case never prompts.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {boolean} True if the glob is auto-approved
   */
  isPermitted(toolInput) {
    if (!this.messageThread) return false;
    const path = toolInputPath(toolInput);
    if (!path) return true;
    return isPathAllowed(this, path);
  }

  /**
   * Offer a "don't ask again" grant for an out-of-root glob: the search
   * directory. Returns `[]` when already permitted or the directory isn't safely
   * grantable (the user still gets a one-shot Yes / No then).
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
   * Execute the glob action.
   *
   * Reaching execute() past the approval gate means an out-of-root `path` was
   * explicitly approved; mark it so the backend admits this one glob (mirrors the
   * read/search tools' outOfRootApproved).
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<GlobResult>} Action result
   */
  async execute(params) {
    const globParams = /** @type {GlobParams & {outOfRootApproved?: boolean}} */ ({ ...params });
    if (globParams.path && !isPathAllowed(this, globParams.path)) {
      globParams.outOfRootApproved = true;
    }
    // Conversation-level "search all files" toggle.
    if (gitignoreDisabled(this)) globParams.noIgnore = true;
    return await this.ops.glob(globParams, this.signal);
  }

  /**
   * Contribute the headerless .gitignore toggle (respect .gitignore) to the
   * permission popup. Deduplicated with Search's identical section by the shared `id`.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread - Owning thread
   * @returns {{id: string, order: number, element: HTMLElement, dispose: () => void}} Permission section
   */
  static getPermissionSection(messageThread) {
    return buildGitignoreSection(messageThread);
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
      return this.failureSummary(outcome.error || `Failed to glob ${pattern}`);
    }

    const result = /** @type {GlobResult} */ (outcome.result);

    // Format the file list for LLM, keeping windows around the pattern itself
    const formattedContent = this._formatGlobContent(result);

    return this.successSummary(
      this.truncateForLLM(formattedContent, { keywords: pattern ? [pattern] : [] })
    );
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
    const pattern = /** @type {string} */ (toolInput?.pattern) || t('unknown');
    const searchPath = /** @type {string|undefined} */ (toolInput?.path);
    const projectPath = /** @type {any} */ (context?.session)?.projectPath || this.session?.projectPath;
    const displayPattern = searchPath ? `${formatPathForStatus(searchPath, projectPath)}/${pattern}` : pattern;

    return this.buildStatusUI(actionStatus, {
      typeName: t('Glob'),
      pending: `${displayPattern}...`,
      success: () => {
        const result = /** @type {GlobResult} */ (actionStatus?.result);
        const count = result
          ? (result.count ?? /** @type {any} */ (result).filesCount ?? result.files?.length ?? 0)
          : 0;
        return t('{count, plural, one {{count} file matching {pattern}} other {{count} files matching {pattern}}}',
          { count, pattern: displayPattern });
      },
      failurePrefix: t('failed')
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
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    helpers.addSubsection(wrapper, t('Pattern'), inputText(input, 'pattern'), 'properties-panel-code');
    if (input.path) {
      helpers.addSubsection(wrapper, t('Path'), inputText(input, 'path'), 'properties-panel-code');
    }
  }
}

export default GlobContextItem;
