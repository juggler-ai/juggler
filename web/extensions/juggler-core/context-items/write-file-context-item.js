//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import EditBase from './edit-base.js';
import { formatDisplayPath, normalizeFilePath, basename } from 'juggler/item-utils';
import { labeledSubsection } from 'juggler/ui';
import { fileSourceFromText } from 'juggler/file-source';
import { recordWrittenHash, restageBaseline, acquirePathLock } from './read-history.js';
import { absolutePathKey } from './path-approval.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { inputText, toolActionResult } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

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
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: markUntranslated('The absolute path to the file to write. Must be inside the working directory unless the user explicitly asked for a location outside it.')
        },
        content: {
          type: 'string',
          description: markUntranslated('The content to write to the file')
        }
      },
      required: ['file_path', 'content']
    };

    const description = markUntranslated('Writes a file to the local filesystem. This will overwrite the existing file if there is one.');

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
      return { valid: false, error: markUntranslated('Missing required parameter: file_path') };
    }
    if (params.content === undefined || params.content === null) {
      return { valid: false, error: markUntranslated('Missing required parameter: content') };
    }
    if (typeof path !== 'string') {
      return { valid: false, error: markUntranslated('Parameter "file_path" must be a string') };
    }
    if (typeof params.content !== 'string') {
      return { valid: false, error: markUntranslated('Parameter "content" must be a string') };
    }

    // Load existing content (if any) so the approval UI can show a diff, and
    // capture its content hash as the overwrite-freshness baseline.
    /** @type {string|undefined} */
    let existingContent;
    /** @type {string|undefined} */
    let existingHash;
    try {
      const result = await this.ops.readFile({ path });
      if (result.exists && result.content !== undefined) {
        existingContent = result.content;
      }
      if (result.exists && typeof (/** @type {any} */ (result).contentHash) === 'string') {
        existingHash = /** @type {any} */ (result).contentHash;
      }
    } catch {
      // No existing file to diff against; the approval UI shows a content preview.
    }

    // A whole-file write carries no read-before-overwrite precondition, unlike
    // the edit tool's guard in replace-text. The two differ in what their
    // approval UI shows: getApprovalConfig below diffs the file's CURRENT bytes
    // against the proposed ones, so the user sees every byte an overwrite
    // destroys and can judge the loss directly, whereas an edit's approval
    // shows only the changed hunk and reveals nothing about the rest of the
    // file. Requiring a read here would only make the model spend a round trip
    // restating content the human is about to see in full anyway; expectedHash
    // below still guards the window between that approval and the commit.

    // Pre-approval dry-run: ask the backend whether the write would actually
    // succeed (parent dir creatable, target writable, target not a directory,
    // …) before we ask the user to approve. If it can't, fail at validation
    // and skip the approval modal entirely — mirrors replace-text.
    try {
      await this.ops.writeFile({ path, content: params.content, dryRun: true });
    } catch (err) {
      return {
        valid: false,
        error: markUntranslated(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      };
    }

    return {
      valid: true,
      params: { ...params, _existingContent: existingContent, _existingHash: existingHash }
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
    const message = outOfRoot ? t('⚠ Write outside the project folder: {path}', { path }) : '';

    if (existingContent !== undefined) {
      // File exists - show diff
      const diffData = await this._storeDiffSnapshot(path, existingContent, content);
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
    const writeParams = /** @type {WriteFileParams & {_existingContent?: string, _existingHash?: string}} */ ({ ...params });

    // The diff baseline is validation-local: keep it off the wire, but carry
    // the existing file's hash as expectedHash so the backend refuses if the
    // file changed between the approved diff and this write.
    const existingHash = writeParams._existingHash;
    const existingContent = writeParams._existingContent;
    delete writeParams._existingContent;
    delete writeParams._existingHash;
    const anyWrite = /** @type {any} */ (writeParams);

    // Serialize writes to the SAME file: a single turn can dispatch several
    // mutations to one path concurrently, each having frozen its expectedHash
    // baseline at validation time — before any sibling wrote. Holding this
    // per-path lock across execute makes those siblings run one at a time, so
    // each re-bases onto the previous sibling's committed bytes below instead
    // of carrying a baseline the backend rejects as stale. Different files
    // never block.
    const lock = await acquirePathLock(this.session, anyWrite.path);
    try {
      if (existingHash) {
        // A same-turn sibling may have advanced the on-disk bytes past our
        // frozen baseline. Re-probe and re-base onto the current bytes when
        // they are our own just-written output (restageBaseline vets them via
        // the freshness guard); keep the frozen baseline for a genuine
        // out-of-band change so the backend still refuses it.
        let currentHash;
        try {
          const probe = await this.ops.readFile({ path: anyWrite.path });
          currentHash = /** @type {any} */ (probe)?.contentHash;
        } catch {
          // Unreadable here (e.g. removed out-of-band): let writeFile surface it.
        }
        anyWrite.expectedHash = restageBaseline(
          this.conversation, this.session, anyWrite.path, existingHash, currentHash
        );
      }

      // Approval is enforced upstream by the JS action-executor flow. Carry the
      // standing allowed-paths grant, and mark an out-of-root target as
      // user-approved (only reachable here via an explicit modal approval), so the
      // backend's defence-in-depth check admits the write.
      const sendParams = this._authorizeWrite(writeParams);
      const result = await this.ops.writeFile(
        /** @type {import('../../../js/services/ops-api.js').ReadFileWriteParams} */ (sendParams),
        this.signal
      );

      // Remember the post-write hash synchronously so a follow-up mutation of the
      // same file later in this turn passes the freshness guard even before this
      // write's tool-action lands in the durable transcript (see read-history.js).
      if (result && /** @type {any} */ (result).success !== false &&
          typeof (/** @type {any} */ (result).contentHash) === 'string') {
        recordWrittenHash(this.conversation, this.session, anyWrite.path, /** @type {any} */ (result).contentHash);
      }

      // Attach a line diffstat (added/removed vs the prior on-disk content) so
      // the status tile can show a `+A -B` indicator beside the filename. A new
      // file has no prior content, so every line counts as added.
      if (result && /** @type {any} */ (result).success !== false) {
        const stats = EditBase._lineStats(existingContent ?? '', /** @type {string} */ (anyWrite.content));
        if (stats) {
          /** @type {any} */ (result).linesAdded = stats.added;
          /** @type {any} */ (result).linesRemoved = stats.removed;
        }
      }

      return result;
    } finally {
      lock.release();
    }
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
        return this.failureSummary(markUntranslated(`Write file cancelled: ${prepPath}`));
      }
      return this.failureSummary(markUntranslated(`Write file failed: ${outcome.error}`));
    }

    // Success case
    const result = /** @type {WriteFileResult} */ (outcome.result);
    const path = result.path;
    const action = result.created ? 'Created' : 'Updated';
    const size = result.size;

    // Generate feedback for LLM
    const feedbackForLLM = this._generateFeedbackForLLM(path);

    return this.successSummary(markUntranslated(`${action} file: ${path}`), {
      details: markUntranslated(`${action} ${path} (${size} bytes)`),
      icon: result.created ? '✓' : '↻',
      feedbackForLLM
    });
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
      hints.push(markUntranslated('Consider running tests to verify your changes'));
    }

    // Warn about missing build for compiled languages
    if (/\.(go|java|cs|cpp|c|rs)$/.test(path)) {
      hints.push(markUntranslated('Remember to rebuild before testing'));
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
    // Get display data from displayData (set during prepare)
    /** @type {any} */
    const displayData = actionStatus?.displayData;
    /** @type {any} */
    const diffData = displayData?.diffData;
    /** @type {any} */
    const contentData = displayData?.contentData;

    /** @type {any} */
    const result = actionStatus?.result || {};
    const path = result.path || toolInput?.file_path || toolInput?.path || contentData?.path || diffData?.path || t('unknown');
    // Get just the filename for display
    const filename = basename(path) || path;

    return this.buildStatusUI(actionStatus, {
      typeName: t('Write'),
      // Pending/approval state - use title from display data
      pending: displayData?.title || `${filename}`,
      success: () => {
        const label = result.created ? t('Created {file}', { file: filename }) : t('Updated {file}', { file: filename });
        return EditBase._editStatSummary(label, EditBase._editStats(displayData, result));
      },
      failurePrefix: filename,
      cancelledMessage: t('cancelled: {file}', { file: filename })
    });
  }

  /**
   * Append an error or cancellation result banner above the content preview.
   * @param {HTMLElement} wrapper
   * @param {{isError?: boolean, cancelled?: boolean, fullResult?: {error?: string}, content?: string}} result
   * @private
   */
  _appendOutcomeBanner(wrapper, result) {
    const section = labeledSubsection(t('Result'));
    const div = document.createElement('div');
    div.className = result.cancelled ? 'properties-panel-result cancelled' : 'properties-panel-result error';
    // An error is the model's English, shown as it was.
    div.textContent = result.cancelled ? t('Cancelled') : (result.fullResult?.error || result.content || t('Error'));
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
    const filePath = inputText(input, 'file_path') || inputText(input, 'path');

    const result = toolActionResult(toolAction);
    const wrote = !result.isError && !result.cancelled;

    // Only a write that happened offers to pin what it wrote — and it pins the
    // path, canonicalised, not the content below, which is what the model
    // intended rather than what is on disk.
    helpers.addFilePath(wrapper, filePath, undefined,
      wrote ? { pin: absolutePathKey(ctx.session, filePath) } : {});

    // Show outcome (error/cancellation) first, then fall through to also show
    // what the LLM intended to write so the user can inspect it.
    if (!wrote) {
      this._appendOutcomeBanner(wrapper, result);
    }

    const content = inputText(input, 'content');
    if (!helpers.addDiffViewer(wrapper, toolAction, filePath, ctx.conversation?.id) && content) {
      // The content the model intended to write, not a file on disk — so the
      // source carries the text directly and resolves to the text viewer. The
      // path is already at the top of the wrapper, so the view omits its own.
      const section = document.createElement('div');
      section.className = 'context-item-expanded-content';
      const view = /** @type {any} */ (document.createElement('file-view'));
      view.showPath = false;
      view.setSource(fileSourceFromText({ path: filePath, text: content }));
      section.appendChild(view);
      wrapper.appendChild(section);
    }

    // This plugin always owns its full display; suppress the generic result section.
    return { skipResultSection: true };
  }
}

export default WriteFileContextItem;
