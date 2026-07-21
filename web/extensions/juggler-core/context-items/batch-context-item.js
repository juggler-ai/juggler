//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { readFile, grep } from 'juggler/ops';
import { smartTruncate } from 'juggler/ui';

/**
 * @typedef {object} BatchReadFile
 * @property {string} file_path - Absolute file path
 * @property {number} [offset] - Line number to start reading from (1-indexed)
 * @property {number} [limit] - Number of lines to read
 */

/**
 * @typedef {object} BatchGrepSearch
 * @property {string} pattern - Regex pattern to search for
 * @property {string} [path] - Directory to search in
 * @property {string} [glob] - File glob filter
 * @property {string} [output_mode] - "content" | "files_with_matches" | "count"
 */

/**
 * BatchContextItem - Batch read and grep operations
 *
 * Provides batch_read and batch_grep tools that combine multiple operations
 * into a single tool call, reducing context overhead.
 * @class
 * @augments ContextItem
 */
class BatchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'batch',
    name: 'Batch Operations',
    version: '1.0.0',
    description: 'Batch read and grep operations for context efficiency',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for batch operations
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'batch_read',
        category: 'read',
        description: 'Read up to 10 files in a single call. Returns combined content with file separators. More efficient than multiple read calls.',
        input_schema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: 'Array of files to read (max 10)',
              items: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'Absolute file path'
                  },
                  offset: {
                    type: 'number',
                    description: 'Line number to start from (1-indexed)'
                  },
                  limit: {
                    type: 'number',
                    description: 'Number of lines to read'
                  }
                },
                required: ['file_path']
              },
              maxItems: 10
            }
          },
          required: ['files']
        }
      },
      {
        name: 'batch_grep',
        category: 'read',
        description: 'Run up to 10 grep searches in a single call. Returns combined results with search separators. More efficient than multiple grep calls.',
        input_schema: {
          type: 'object',
          properties: {
            searches: {
              type: 'array',
              description: 'Array of searches to run (max 10)',
              items: {
                type: 'object',
                properties: {
                  pattern: {
                    type: 'string',
                    description: 'Regex pattern to search for'
                  },
                  path: {
                    type: 'string',
                    description: 'Directory to search in'
                  },
                  glob: {
                    type: 'string',
                    description: 'File glob filter'
                  },
                  output_mode: {
                    type: 'string',
                    enum: ['content', 'files_with_matches', 'count'],
                    description: 'Output format (default: files_with_matches)'
                  }
                },
                required: ['pattern']
              },
              maxItems: 10
            }
          },
          required: ['searches']
        }
      }
    ];
  }

  /**
   * Coerce a value that should be an array. Some models double-encode array
   * arguments as a JSON string (e.g. searches: "[{...}]"); parse those back
   * into an array. Anything that isn't a JSON-string-of-an-array is returned
   * unchanged so the caller's array/length validation reports the real error.
   * @param {unknown} value - Raw argument value
   * @returns {unknown} The array if coercible, otherwise the original value
   * @private
   */
  static _coerceArray(value) {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }

  /**
   * Validate input parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // Determine which batch tool this is
    if (toolInput.files) {
      const files = /** @type {BatchReadFile[]} */ (BatchContextItem._coerceArray(toolInput.files));
      if (!Array.isArray(files) || files.length === 0) {
        return { valid: false, error: 'files must be a non-empty array' };
      }
      if (files.length > 10) {
        return { valid: false, error: 'Maximum 10 files per batch_read call' };
      }
      for (const f of files) {
        if (!f.file_path || typeof f.file_path !== 'string') {
          return { valid: false, error: 'Each file must have a file_path string' };
        }
      }
      return { valid: true, params: { _batchType: 'read', files } };
    }

    if (toolInput.searches) {
      const searches = /** @type {BatchGrepSearch[]} */ (BatchContextItem._coerceArray(toolInput.searches));
      if (!Array.isArray(searches) || searches.length === 0) {
        return { valid: false, error: 'searches must be a non-empty array' };
      }
      if (searches.length > 10) {
        return { valid: false, error: 'Maximum 10 searches per batch_grep call' };
      }
      for (const s of searches) {
        if (!s.pattern || typeof s.pattern !== 'string') {
          return { valid: false, error: 'Each search must have a pattern string' };
        }
      }
      return { valid: true, params: { _batchType: 'grep', searches } };
    }

    return { valid: false, error: 'Must provide either "files" (batch_read) or "searches" (batch_grep)' };
  }

  /**
   * Execute batch operation
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Combined results
   */
  async execute(params) {
    if (params._batchType === 'read') {
      return this._executeBatchRead(/** @type {BatchReadFile[]} */ (params.files));
    }
    return this._executeBatchGrep(/** @type {BatchGrepSearch[]} */ (params.searches));
  }

  /**
   * Execute batch file reads
   * @param {BatchReadFile[]} files - Files to read
   * @returns {Promise<Record<string, unknown>>} Combined results
   * @private
   */
  async _executeBatchRead(files) {
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          /** @type {Record<string, unknown>} */
          const readParams = { path: f.file_path };
          if (f.offset !== undefined || f.limit !== undefined) {
            const offset = f.offset || 1;
            const limit = f.limit || 2000;
            readParams.lineRange = { start: offset, end: offset + limit - 1 };
          }
          const result = await readFile(this._withConv(readParams), this.signal, this.getToolAllowedRoots());
          return { file: f.file_path, success: true, result };
        } catch (err) {
          return { file: f.file_path, success: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return { _batchType: 'read', results };
  }

  /**
   * Execute batch grep searches
   * @param {BatchGrepSearch[]} searches - Searches to run
   * @returns {Promise<Record<string, unknown>>} Combined results
   * @private
   */
  async _executeBatchGrep(searches) {
    const results = await Promise.all(
      searches.map(async (s) => {
        try {
          /** @type {Record<string, unknown>} */
          const searchParams = { pattern: s.pattern };
          if (s.path) searchParams.path = s.path;
          if (s.glob) searchParams.include = s.glob;
          const result = await grep(this._withConv(searchParams), this.signal, this.getToolAllowedRoots());
          return { pattern: s.pattern, success: true, result, outputMode: s.output_mode || 'files_with_matches' };
        } catch (err) {
          return { pattern: s.pattern, success: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return { _batchType: 'grep', results };
  }

  /**
   * Format batch results for LLM
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return {
        summary: outcome.error || 'Batch operation failed',
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {Record<string, unknown>} */ (outcome.result);
    let content;

    if (result._batchType === 'read') {
      content = this._formatBatchReadResults(/** @type {any[]} */ (result.results));
    } else {
      content = this._formatBatchGrepResults(/** @type {any[]} */ (result.results));
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
   * Format batch read results
   * @param {Array<{file: string, success: boolean, result?: any, error?: string}>} results
   * @returns {string} Formatted output
   * @private
   */
  _formatBatchReadResults(results) {
    /** @type {string[]} */
    const parts = [];
    for (const r of results) {
      parts.push(`=== file: ${r.file} ===`);
      if (!r.success) {
        parts.push(`Error: ${r.error}`);
      } else if (r.result.exists === false) {
        parts.push('File does not exist');
      } else if (r.result.warning) {
        parts.push(r.result.warning);
      } else {
        const content = r.result.content || '';
        const lineOffset = r.result.lineOffset || 1;
        const lines = content.split('\n');
        const maxLineNum = lineOffset + lines.length - 1;
        const numWidth = String(maxLineNum).length;
        const numbered = lines.map((/** @type {string} */ line, /** @type {number} */ idx) => {
          const lineNum = lineOffset + idx;
          return `${String(lineNum).padStart(numWidth, ' ')}  ${line}`;
        }).join('\n');
        parts.push(numbered);
      }
      parts.push('');
    }
    return parts.join('\n').trim();
  }

  /**
   * Format batch grep results
   * @param {Array<{pattern: string, success: boolean, result?: any, error?: string, outputMode?: string}>} results
   * @returns {string} Formatted output
   * @private
   */
  _formatBatchGrepResults(results) {
    /** @type {string[]} */
    const parts = [];
    for (const r of results) {
      parts.push(`=== grep: ${r.pattern} ===`);
      if (!r.success) {
        parts.push(`Error: ${r.error}`);
      } else {
        const matches = r.result.matches || [];
        if (matches.length === 0) {
          parts.push(`No matches found`);
        } else {
          const mode = r.outputMode || 'files_with_matches';
          if (mode === 'files_with_matches') {
            const files = [...new Set(matches.map((/** @type {{file: string}} */ m) => m.file))];
            parts.push(files.join('\n'));
          } else if (mode === 'count') {
            /** @type {Record<string, number>} */
            const counts = {};
            for (const m of matches) {
              counts[m.file] = (counts[m.file] || 0) + 1;
            }
            for (const [file, count] of Object.entries(counts)) {
              parts.push(`${file}:${count}`);
            }
          } else {
            // content mode
            /** @type {Record<string, any[]>} */
            const byFile = {};
            for (const m of matches) {
              let arr = byFile[m.file];
              if (!arr) { arr = []; byFile[m.file] = arr; }
              arr.push(m);
            }
            for (const [file, fileMatches] of Object.entries(byFile)) {
              parts.push(`${file}:`);
              for (const m of fileMatches) {
                parts.push(`${m.line}: ${m.content}`);
              }
            }
          }
        }
      }
      parts.push('');
    }
    return parts.join('\n').trim();
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

    const files = BatchContextItem._coerceArray(toolInput?.files);
    const searches = BatchContextItem._coerceArray(toolInput?.searches);
    const isBatchRead = Array.isArray(files);
    const count = isBatchRead
      ? /** @type {any[]} */ (files).length
      : /** @type {any[]} */ (Array.isArray(searches) ? searches : []).length;
    const typeName = isBatchRead ? 'BatchRead' : 'BatchGrep';

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;

    if (actionStatus.pending) {
      summary = `${count} ${isBatchRead ? 'files' : 'searches'}...`;
      status = 'running';
    } else if (actionStatus.success) {
      summary = `${count} ${isBatchRead ? 'files' : 'searches'} completed`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, 'failed'));
    }

    return { typeName, summary, status };
  }

  /**
   * @override
   * @param {string} toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(toolName) {
    if (toolName === 'batch_grep') return 'Matches';
    if (toolName === 'batch_read') return 'Content';
    return 'Result';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolName, input, helpers } = ctx;
    if (toolName === 'batch_grep') {
      const coerced = BatchContextItem._coerceArray(input.searches);
      const searches = /** @type {Array<{pattern?: string, path?: string, glob?: string}>} */ (Array.isArray(coerced) ? coerced : []);
      for (const s of searches) {
        helpers.addSubsection(wrapper, 'Pattern', s.pattern || '', 'properties-panel-code');
        if (s.path) helpers.addSubsection(wrapper, 'Path', s.path, 'properties-panel-code');
        if (s.glob) helpers.addSubsection(wrapper, 'Glob', s.glob, 'properties-panel-code');
      }
    } else if (toolName === 'batch_read') {
      const coerced = BatchContextItem._coerceArray(input.files);
      const files = /** @type {Array<{file_path?: string, offset?: number, limit?: number}>} */ (Array.isArray(coerced) ? coerced : []);
      for (const f of files) {
        let label = f.file_path || '';
        if (f.offset !== undefined || f.limit !== undefined) {
          const start = f.offset || 1;
          label += f.limit ? ` (lines ${start}–${start + f.limit - 1})` : ` (from line ${start})`;
        }
        helpers.addSubsection(wrapper, 'File', label, 'properties-panel-code');
      }
    }
  }
}

export default BatchContextItem;
