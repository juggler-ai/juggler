//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath, formatFileSize, formatFileSizeForDisplay, formatFileContentForLLM, normalizeFilePath, injectFileContentStyles, basename } from 'juggler/item-utils';
import { addFilePath } from 'juggler/ui';
import { fileSourceFromReadResult } from 'juggler/file-source';
import { extractFileSource } from 'juggler/registry';
import { toolInputPath, dirname, isPathAllowed, folderGrantSuggestions, stripInjectedApprovalFlags, absolutePathKey } from './path-approval.js';
import { creditProgramRead } from './read-history.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { inputText, toolActionResultField, toolActionResultValue } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

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
 * @property {string} [contentHash] - Hash of the file's whole content, as read
 * @property {string} readMode - Read mode description
 * @property {number} lineOffset - Starting line number (1-indexed)
 * @property {number} lineCount - Number of lines in content
 * @property {string|null} [warning] - Warning carried by results persisted before viewers owned the explanation
 * @property {boolean} [isImage] - True when the file is a supported image within the inline size cap
 * @property {string} [mime] - Mime type reported by the read op ('' when unknown)
 * @property {boolean} [isBinary] - Byte-sniff observation; advisory, not a verdict on displayability
 * @property {import('juggler/file-viewer').ExtractResult} [extracted] - What the file's viewer produced for the model (see execute)
 * @property {import('../../../js/services/ops-api.js').AssetRef} [attachment] - Stored asset ref for the image (set after snapshot)
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
    // Reads are approval-gated, but only OUT-OF-ROOT ones ever prompt: isPermitted
    // auto-approves any read inside the project or a granted allowed path, so the
    // common case is silent. A read outside those roots (a sibling repo, an
    // absolute path) prompts once — offering to grant the folder — instead of
    // hard-failing the model, which otherwise routes around the block via `cat`.
    requiresApproval: true
  };

  /**
   * Get tool definitions for Read action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: markUntranslated('The absolute path to the file to read')
        },
        offset: {
          type: 'number',
          description: markUntranslated('The line number to start reading from (1-indexed). Only provide if the file is too large to read at once.')
        },
        limit: {
          type: 'number',
          description: markUntranslated('The number of lines to read. Only provide if the file is too large to read at once.')
        }
      },
      required: ['file_path']
    };

    const description = markUntranslated('Reads a local file, returned in <file> tags with cat -n line numbers. A file too large to return at once arrives a page at a time: the footer names the lines returned and the offset the next page starts at, so following it reads the whole file without gaps. Use offset and limit to choose a range yourself.');

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

    // The backend escape-hatch flags are set by execute() alone, past the
    // approval gate — never trusted from raw LLM input. See path-approval.js.
    stripInjectedApprovalFlags(params);

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
   * A read is auto-approved (no prompt) when its target resolves inside the
   * project root or a granted allowed path — the overwhelming common case. Only
   * an out-of-root read requires approval. A read with no readable path is
   * treated as permitted so validate() can surface the real "missing path" error
   * instead of a spurious approval prompt.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {boolean} True if the read is auto-approved
   */
  isPermitted(toolInput) {
    if (!this.messageThread) return false;
    const path = toolInputPath(toolInput, true);
    if (!path) return true;
    return isPathAllowed(this, path);
  }

  /**
   * Offer a "don't ask again" grant for an out-of-root read: the file's parent
   * folder. Returns `[]` when the read is already permitted or the folder isn't
   * safely grantable (the user still gets a one-shot Yes / No then).
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions
   */
  getApprovalSuggestions(toolInput) {
    if (!this.messageThread || this.isPermitted(toolInput)) return [];
    const path = toolInputPath(toolInput, true);
    return folderGrantSuggestions(dirname(path), this.session?.home || '');
  }

  /**
   * Execute the read file action.
   *
   * Reaching execute() means the read is either in-root (isPermitted) or was
   * explicitly approved (an out-of-root read only gets here past the approval
   * gate). For the out-of-root case, mark `outOfRootApproved` so the backend's
   * containment check admits this one read — mirroring EditBase._authorizeWrite.
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<ReadFileResult>} Action result
   */
  async execute(params) {
    const readParams = /** @type {ReadFileParams & {outOfRootApproved?: boolean}} */ ({ ...params });
    if (readParams.path && !isPathAllowed(this, readParams.path)) {
      readParams.outOfRootApproved = true;
    }
    const result = /** @type {ReadFileResult & {imageBase64?: string}} */ (
      await this.ops.readFile(readParams, this.signal)
    );

    // Extraction runs HERE rather than in getSummary because getSummary is
    // synchronous (action-executor calls it directly) while extract() is async —
    // and because the image asset upload happens here too, so both finish at the
    // same point relative to result persistence.
    if (result && result.exists !== false) {
      // A program reading through this tool saw the bytes, as through its `fs`.
      creditProgramRead(this.conversation, this.toolUseId, readParams.path, result.contentHash);
      const conversationId = this.conversation?.id;
      const source = fileSourceFromReadResult(
        result,
        this.getAbsolutePath(result.path || readParams.path || ''),
        // An out-of-root read reached here only past the approval gate, so the
        // viewer's byte transport may resolve it on the same footing the read
        // itself did — otherwise a viewer could never see the file it is being
        // asked to extract.
        { conversationId, access: { outOfRootApproved: !!readParams.outOfRootApproved } }
      );
      const outcome = await extractFileSource(source, {
        maxChars: this.truncationBudget(),
        signal: this.signal,
        conversationId,
      });

      // An attachment (image pixels) is promoted onto the result so it persists
      // at the item level and rides getSummary's `attachments`.
      if (outcome.attachments?.length) {
        result.attachment = outcome.attachments[0];
      }
      // Stash the outcome for getSummary. `text` is deliberately dropped when
      // the body is already on the result: it is derivable from `content`, and
      // persisting both would double every read's footprint in the document.
      // A viewer that produces text from bytes (a PDF) has no `content`, so its
      // text IS stored — it is the only copy.
      const stashed = { ...outcome };
      delete stashed.attachments;
      if (stashed.text && result.content) delete stashed.text;
      if (Object.keys(stashed).length > 0) result.extracted = stashed;
    }

    // The inline pixels have served their purpose (extraction uploaded them to
    // the asset store); drop them so they never reach the document.
    delete result.imageBase64;
    return result;
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
      return this.failureSummary(outcome.error || `Failed to read ${path}`);
    }

    // Handle file doesn't exist - put full message in summary for tool_result
    if (result && result.exists === false) {
      return this.successSummary(
        `File does not exist: ${path}. Do not attempt to read it again.`,
        { icon: '✗' }
      );
    }

    // Handle image result: the actual pixels are attached to the tool_result as
    // an image part (the AssetRef in `attachments`), so the LLM-facing text is a
    // short description rather than file content.
    if (result && result.attachment) {
      const ref = result.attachment;
      const dims = (ref.width && ref.height) ? `${ref.width}\u00d7${ref.height}` : 'image';
      const size = ref.bytes ? `, ${formatFileSize(ref.bytes)}` : '';
      return this.successSummary(
        `Read image ${formatDisplayPath(path)} (${dims}${size}). The image is attached below.`,
        { attachments: [ref] }
      );
    }

    // Nothing could be extracted (a binary format no viewer claims). The
    // explanation comes from the viewer layer, not from the backend's read op.
    const warning = result?.extracted?.warning || result?.warning;
    if (warning) {
      return this.successSummary(markUntranslated(`${formatDisplayPath(path)} (${warning})`), {
        details: `**WARNING**: ${warning}`,
        icon: '⚠'
      });
    }

    // The viewer's extracted text when it produced any (a PDF's body), else the
    // standard formatting of the content the read carried.
    // At this point result must exist since outcome.success is true
    const formattedContent = result?.extracted?.text
      || this._formatFileContent(/** @type {ReadFileResult} */ (result));

    return this.successSummary(this.truncateForLLM(formattedContent));
  }

  /**
   * Format file content with line numbers for LLM.
   *
   * The character budget is spent here rather than on the finished string: the
   * formatter drops whole lines off the end and says so in its footer, where a
   * later squeeze would take the middle out of a block whose footer had already
   * described it.
   * @param {ReadFileResult} result - Read result from backend
   * @returns {string} Formatted file content
   * @private
   */
  _formatFileContent(result) {
    return formatFileContentForLLM({
      content: result.content || '',
      path: result.path,
      lineOffset: result.lineOffset || 1,
      totalLines: result.totalLines,
      readMode: result.readMode,
      maxChars: this.truncationBudget()
    });
  }

  /**
   * Get the full absolute path by resolving relative paths against the project
   * root. Delegates to the shared canonicaliser so display and the
   * read-history freshness guard agree on one form per file.
   * @param {string} path - File path
   * @returns {string} Absolute file path
   */
  getAbsolutePath(path) {
    return absolutePathKey(this.session, path);
  }

  /**
   * Create properties panel view for read-file results.
   * Caller must set `this.data` to a ReadFileResult before calling.
   * @override
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const data = /** @type {ReadFileResult} */ (this.data);
    const absolutePath = this.getAbsolutePath(data.path);

    // The path row is the panel's own rather than the view's, so it can carry
    // the Pinboard button beside copy and reveal. Pinning is a live path, not
    // these bytes: the pin shows the file as it is now, which is a different
    // thing from what this read recorded and is meant to be.
    const container = document.createElement('div');
    container.className = 'file-content-expanded';
    const info = (data.exists !== false && data.size)
      ? [formatFileSizeForDisplay(data.size), data.totalLines ? t('{count, plural, one {{count} line} other {{count} lines}}', { count: data.totalLines }) : ''].filter(Boolean).join(' | ')
      : undefined;
    addFilePath(container, absolutePath || data.path || t('No file'), info, { pin: absolutePath });

    const view = /** @type {any} */ (document.createElement('file-view'));
    view.showPath = false;
    // A persisted result does not record how its read was authorised, but a
    // recorded read of an out-of-root path is by construction one the user
    // approved — so the panel may re-read it on the same footing.
    const outOfRootApproved = !!this.messageThread && !isPathAllowed(this, data.path || '');
    view.setSource(fileSourceFromReadResult(data, absolutePath, {
      conversationId: this.conversation?.id,
      access: { outOfRootApproved },
    }));
    container.appendChild(view);
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
    const path = /** @type {string} */ (toolInput?.file_path || toolInput?.path) || t('unknown');
    // Get just the filename for display
    const filename = basename(path) || path;

    return this.buildStatusUI(actionStatus, {
      typeName: t('Read'),
      pending: `${filename}...`,
      success: () => {
        const result = /** @type {ReadFileResult} */ (actionStatus?.result);
        if (!result) return filename;
        // A missing file is a successful call with a failed read — the only
        // success branch that styles itself as an error.
        if (result.exists === false) {
          return { summary: t('File not found: {filename}', { filename }), status: /** @type {const} */ ('error') };
        }
        if (result.attachment) {
          const ref = result.attachment;
          return (ref.width && ref.height)
            ? t('{filename} ({width}×{height})', { filename, width: ref.width, height: ref.height })
            : t('{filename} (image)', { filename });
        }
        // The warning is the viewer layer's own text, shown as data.
        const warning = result.extracted?.warning || result.warning;
        if (warning) return `${filename} (${warning})`;

        const lineOffset = result.lineOffset || 1;
        const endLine = lineOffset + (result.lineCount || 0) - 1;
        const isFullFile = lineOffset === 1 && endLine === result.totalLines;
        return isFullFile
          ? t('{filename} ({count, plural, one {{count} line} other {{count} lines}})', { filename, count: result.totalLines })
          : t('{filename} (lines {start}-{end} of {total})', { filename, start: lineOffset, end: endLine, total: result.totalLines });
      },
      failurePrefix: `'${path}'`
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return t('Content');
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {boolean} Always true: a read hands back the file itself
   */
  static resultIsFileContent(_toolName) {
    return true;
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
    const fullResult = toolActionResultField(toolAction, 'fullResult');
    const actionData = fullResult?.success ? fullResult.result : null;
    const error = toolActionResultValue(toolAction, 'error');
    const cancelled = toolActionResultField(toolAction, 'cancelled');

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

    helpers.addFilePath(wrapper, inputText(input, 'file_path') || inputText(input, 'path'));
  }
}

export default ReadFileContextItem;
