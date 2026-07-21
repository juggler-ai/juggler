//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ops-api.js - Strictly Typed API for Backend Operations
 *
 * This module provides type-safe wrappers for all backend operations.
 * ALL code must use these functions instead of calling /api/ops/call directly.
 *
 * Benefits:
 * - Full type safety with JSDoc
 * - Autocomplete for all parameters
 * - Runtime parameter validation
 * - Centralized error handling
 * - Single source of truth for API contracts
 */

// ============================================================================
// OpsError - Backend Operation Errors (not bugs)
// ============================================================================

/**
 * OpsError represents any error returned by the backend ops layer.
 * These are normal operational feedback (file not found, path issues, search failures, etc.)
 * NOT bugs - they should not be logged with stack traces.
 */
export class OpsError extends Error {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'OpsError';
  }
}

/**
 * Default per-command timeout, applied when the bash tool is
 * invoked without an explicit `timeout`. Single source of truth for the
 * front-end: the tool's schema description and properties-panel display are
 * both derived from this. The Go backend applies the same default
 * (defaultExecTimeoutMs in shell_ops.go).
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;

/**
 * Hard cap on any requested shell/command timeout, in milliseconds.
 * Single source of truth for the front-end timeout bound, shared by
 * shellExecute() here and the bash tool's validate() in execute-context-item.js.
 * The Go backend enforces the same cap (maxExecTimeoutMs in shell_ops.go).
 */
export const MAX_EXEC_TIMEOUT_MS = 1200000;

// ============================================================================
// Type Definitions - Base Types
// ============================================================================

/**
 * Generic operation response wrapper
 * @template T
 * @typedef {object} OpsResponse
 * @property {boolean} success - Whether the operation succeeded
 * @property {T} [data] - Response data (present only if success=true)
 * @property {string} [error] - Error message (present only if success=false)
 */

// ============================================================================
// Type Definitions - read-file operations
// ============================================================================

/**
 * Parameters for loadFile operation
 * @typedef {object} ReadFileLoadParams
 * @property {string} path - File path relative to project root
 * @property {{start: number, end: number}} [lineRange] - Specific line range to read
 * @property {number} [tail] - Read last N lines
 * @property {number} [head] - Read first N lines
 * @property {{line: number, context: number}} [around] - Read lines around specific line
 * @property {boolean} [userInitiated] - If true (a user pin), paths outside the project root are allowed, relative or absolute
 */

/**
 * Result from loadFile operation
 * @typedef {object} ReadFileLoadResult
 * @property {string} content - File content
 * @property {string} path - File path
 * @property {string} language - Detected programming language
 * @property {boolean} exists - Whether file exists
 * @property {number} size - File size in bytes
 * @property {number} totalLines - Total lines in file
 * @property {string} readMode - Description of read mode used
 * @property {number} lineOffset - Starting line number (1-indexed)
 * @property {number} lineCount - Number of lines in returned content
 * @property {string} [contentHash] - SHA-256 hash of file to detect external changes
 * @property {string} [warning] - Warning message (e.g., binary file detected)
 */

/**
 * Parameters for writeFile operation
 * @typedef {object} ReadFileWriteParams
 * @property {string} path - File path (relative to project root, or absolute — JS approval is the gate)
 * @property {string} content - Content to write (max 10MB)
 * @property {boolean} [dryRun] - If true, validate path/parent/writability without modifying the file (used for pre-approval feasibility check)
 * @property {boolean} [outOfRootApproved] - Marks a write outside the project root + allowed paths as user-approved, satisfying the backend's defence-in-depth check (set only on the modal-approved execution path)
 */

/**
 * Result from writeFile operation
 * @typedef {object} ReadFileWriteResult
 * @property {string} path - File path that was written
 * @property {boolean} created - Whether file was newly created (would be created, for dryRun)
 * @property {number} size - File size after write (length of intended content, for dryRun)
 * @property {boolean} [dryRun] - Present and true when this result is from a dryRun call
 */

/**
 * Parameters for editFile operation (search and replace)
 * Standard names: old_str/new_str (industry standard from Anthropic)
 * Also accepts aliases: oldContent, old, pattern, search / newContent, new, replacement, replace
 * @typedef {object} ReadFileEditParams
 * @property {string} path - File path relative to project root
 * @property {string} [old_str] - Content to search for (standard name)
 * @property {string} [oldContent] - Content to search for (alias)
 * @property {string} [old] - Content to search for (short alias)
 * @property {string} [pattern] - Content to search for (common alias)
 * @property {string} [search] - Content to search for (alternative alias)
 * @property {string} [new_str] - Content to replace with (standard name)
 * @property {string} [newContent] - Content to replace with (alias)
 * @property {string} [new] - Content to replace with (short alias)
 * @property {string} [replacement] - Content to replace with (common alias)
 * @property {string} [replace] - Content to replace with (alternative alias)
 * @property {boolean} [dryRun] - If true, return full file content for diff preview without writing
 * @property {boolean} [replace_all] - If true, replace all exact occurrences of old_str
 * @property {boolean} [outOfRootApproved] - Marks an out-of-scope edit as user-approved for the backend defence-in-depth check (set only on the modal-approved execution path)
 */

/**
 * Result from editFile operation
 * @typedef {object} ReadFileEditResult
 * @property {string} path - File path that was edited
 * @property {string} [method] - Edit method used ("exact" or "fuzzy")
 * @property {string} [matchStrategy] - Matching strategy description
 * @property {number} [oldLines] - Number of lines in old content
 * @property {number} [newLines] - Number of lines in new content
 * @property {number} [size] - File size after edit
 * @property {string} [oldContent] - Full old file content (only in dryRun mode)
 * @property {string} [newContent] - Full new file content with edits (only in dryRun mode)
 * @property {boolean} [dryRun] - Whether this was a dry run
 */

/**
 * Single edit specification for batch editing
 * @typedef {object} EditSpec
 * @property {number} startLine - Starting line number (1-indexed)
 * @property {number} endLine - Ending line number (inclusive)
 * @property {string} [newText] - New content for line range
 * @property {string} [newContent] - Alias for newText
 * @property {string} [content] - Alias for newText
 * @property {string} [text] - Alias for newText
 */

/**
 * Parameters for editFileLines operation (replace line range)
 * @typedef {object} ReadFileEditLinesParams
 * @property {string} path - File path relative to project root
 * @property {number} [startLine] - Starting line number (1-indexed) - required for single edit
 * @property {number} [endLine] - Ending line number (inclusive) - required for single edit
 * @property {string} [newContent] - New content for line range - required for single edit
 * @property {EditSpec[]} [edits] - Array of edits for batch mode
 * @property {number} [contextLine] - Line number for context validation
 * @property {string} [contextText] - Expected text at context line
 * @property {boolean} [dryRun] - If true, validate but don't write (returns oldContent)
 * @property {boolean} [outOfRootApproved] - Marks an out-of-scope edit as user-approved for the backend defence-in-depth check (set only on the modal-approved execution path)
 */

/**
 * Result from editFileLines operation
 * @typedef {object} ReadFileEditLinesResult
 * @property {string} path - File path that was edited
 * @property {string} [oldContent] - Full old file content (only present when dryRun=true)
 * @property {string} [newContent] - Full new file content with edits applied (only present when dryRun=true)
 * @property {boolean} [dryRun] - Whether this was a dry run (only present when dryRun=true)
 * @property {string} [method] - Edit method ("line-range" or "line-range-multi") (not present when dryRun=true)
 * @property {number} [startLine] - Starting line number (single edit only, not present when dryRun=true)
 * @property {number} [endLine] - Ending line number (single edit only, not present when dryRun=true)
 * @property {number} [editCount] - Number of edits applied (batch mode only, not present when dryRun=true)
 * @property {number} [linesReplaced] - Number of lines replaced (not present when dryRun=true)
 * @property {number} [newLines] - Number of lines in new content (not present when dryRun=true)
 * @property {number} [size] - File size after edit (not present when dryRun=true)
 */

// ============================================================================
// Type Definitions - tree operations
// ============================================================================

/**
 * Parameters for getTree operation
 * @typedef {object} TreeGetTreeParams
 * @property {string} [path] - Directory path (defaults to project root)
 * @property {number} [depth] - Tree depth (1-5, default based on size)
 * @property {number} [maxTokens] - Max tokens for output (default 2000)
 * @property {string} [pattern] - Filter pattern (e.g., "*.js")
 * @property {'all'|'files'|'dirs'} [fileType] - Filter by type (default "all")
 * @property {boolean} [userInitiated] - If true (a user-pinned folder), paths outside the project root are allowed
 */

/**
 * Result from getTree operation
 * @typedef {object} TreeGetTreeResult
 * @property {string} content - Tree structure as text
 * @property {string} path - Tree directory path
 * @property {number} depth - Actual depth used
 * @property {number} fileCount - Number of files in tree
 * @property {number} dirCount - Number of directories in tree
 * @property {number} tokensUsed - Estimated tokens used
 * @property {number} maxTokens - Max tokens limit
 * @property {number} [totalSize] - Total size of all files (optional)
 * @property {string} [pattern] - Filter pattern if used
 * @property {string} [fileType] - File type filter if used
 * @property {boolean} [truncated] - Whether output was truncated
 */

/**
 * Parameters for expandDirectory operation
 * @typedef {object} TreeExpandDirParams
 * @property {string} path - Directory path to expand
 */

/**
 * Directory item in expandDirectory result
 * @typedef {object} TreeDirItem
 * @property {string} name - Item name
 * @property {boolean} isDir - Whether item is a directory
 * @property {string} path - Full path to item
 */

/**
 * Result from expandDirectory operation
 * @typedef {object} TreeExpandDirResult
 * @property {TreeDirItem[]} items - Directory contents
 * @property {string} path - Directory path that was expanded
 */

// ============================================================================
// Type Definitions - grep operations
// ============================================================================

/**
 * Parameters for grep operation
 * @typedef {object} GrepSearchParams
 * @property {string} pattern - Search pattern (regex supported)
 * @property {string} [path] - Directory path to search (default: project root)
 * @property {number} [maxResults] - Max results to return (default 100, max 1000)
 * @property {string} [filePattern] - File pattern filter (e.g., "*.js")
 * @property {boolean} [caseSensitive] - Case-sensitive search (default false)
 */

/**
 * Single match result from grep
 * @typedef {object} GrepMatch
 * @property {string} file - File path where match was found
 * @property {number} line - Line number (1-indexed)
 * @property {string} content - Line content with match
 */

/**
 * Result from grep operation
 * @typedef {object} GrepSearchResult
 * @property {string} pattern - Search pattern used
 * @property {GrepMatch[]} matches - Array of matches
 * @property {number} fileCount - Number of files with matches
 * @property {number} matchCount - Total number of matches
 * @property {boolean} [truncated] - Whether results were truncated
 */

/**
 * Parameters for findSymbol operation
 * @typedef {object} GrepFindSymbolParams
 * @property {string} symbol - Symbol name to find (function, class, etc.)
 */

/**
 * Single symbol result
 * @typedef {object} GrepSymbolResult
 * @property {string} file - File path where symbol was found
 * @property {number} line - Line number (1-indexed)
 * @property {string} content - Line content with symbol definition
 */

/**
 * Result from findSymbol operation
 * @typedef {object} GrepFindSymbolResult
 * @property {string} symbol - Symbol name searched
 * @property {GrepSymbolResult[]} results - Array of symbol definitions
 * @property {number} count - Number of results found
 */

// ============================================================================
// Type Definitions - python (shell) operations
// ============================================================================

/**
 * Parameters for execute operation (shell command or Python code)
 * @typedef {object} ShellExecuteParams
 * @property {string} [command] - Shell command to execute (max 10000 chars)
 * @property {string} [code] - Python code to execute (alternative to command)
 * @property {number} [timeout] - Timeout in milliseconds (default 30000, max 1200000)
 * @property {string} [cwd] - Working directory for command
 */

/**
 * Result from execute operation
 * @typedef {object} ShellExecuteResult
 * @property {string} command - Command that was executed
 * @property {string} stdout - Standard output
 * @property {string} stderr - Standard error output
 * @property {number} exitCode - Process exit code
 * @property {boolean} success - Whether command succeeded (exitCode === 0)
 */

// ============================================================================
// Core API Functions
// ============================================================================

/**
 * Call a backend operation with type safety and error handling
 * @template T
 * @param {string} toolId - Operation handler ID (e.g., "read-file")
 * @param {string} operation - Operation name (e.g., "loadFile")
 * @param {object} params - Operation parameters
 * @param {AbortSignal} [signal] - Abort signal; when aborted the fetch rejects
 *   with an AbortError and the server's request context is cancelled so the
 *   backend op can stop early. Long-running read tools (grep/glob/…) pass
 *   their action's signal so Escape stops the work instead of waiting it out.
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant. Carried at
 *   the TOP LEVEL of the request body (never inside params) so the server
 *   assembles it into a PathScope once, rather than re-reading it from the
 *   params map at each op callsite. Read/search/tree ops widen their
 *   containment boundary to these roots; ops that ignore it are unaffected.
 * @returns {Promise<T>} Operation result of the specified type T
 * @throws {Error} If operation fails or parameters are invalid
 */
async function callOp(toolId, operation, params, signal, allowedPaths) {
  // A conversationId injected into params (see ContextItem._withConv) is a
  // transport field, not an op parameter: lift it to the top level so the
  // backend can route the op into that conversation's bound workspace,
  // and strip it from the params the op handler sees.
  const { conversationId, ...opParams } = /** @type {Record<string, any>} */ (params || {});
  /** @type {{toolId: string, operation: string, params: object, allowedPaths?: string[], conversationId?: string}} */
  const requestBody = {
    toolId,
    operation,
    params: opParams
  };
  if (allowedPaths !== undefined) {
    requestBody.allowedPaths = allowedPaths;
  }
  if (conversationId) {
    requestBody.conversationId = conversationId;
  }

  const headers = /** @type {Record<string, string>} */ ({ 'Content-Type': 'application/json' });
  const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
  if (token) {
    headers['X-Juggler-Token'] = token;
  }

  const response = await fetch('/api/ops/call', {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal
  });

  // Check HTTP status
  if (!response.ok) {
    // Try to read error details from response body
    let errorDetail = response.statusText;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        // Try to parse as JSON first
        try {
          const errorJson = JSON.parse(errorBody);
          errorDetail = errorJson.error || errorBody;
        } catch {
          // Not JSON, use raw text
          errorDetail = errorBody;
        }
      }
    } catch {
      // If reading body fails, use statusText
    }
    throw new Error(`HTTP ${response.status}: ${errorDetail}`);
  }

  /** @type {OpsResponse<T>} */
  const result = await response.json();

  if (!result.success) {
    // All backend errors are operational feedback, not bugs
    throw new OpsError(result.error || 'Operation failed');
  }

  if (!result.data) {
    throw new Error('Missing data in successful response');
  }
  return result.data;
}

// Direct fetch() calls to /api/ops/call are forbidden by ESLint's
// no-restricted-syntax rule (see web/eslint.config.js).

// ============================================================================
// read-file Operations
// ============================================================================

/**
 * Load file content with optional line range/filtering
 * @param {ReadFileLoadParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<ReadFileLoadResult>} File content and metadata
 */
export async function readFileLoad(params, signal, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('read-file', 'loadFile', params, signal, allowedPaths);
}

/**
 * Write content to a file (creates or overwrites)
 * @param {ReadFileWriteParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level
 *   transport). The backend assembles it into the write op's PathScope so a
 *   user-granted out-of-project root counts as in-scope; combined with the
 *   `outOfRootApproved` param it forms the write defence-in-depth boundary.
 * @returns {Promise<ReadFileWriteResult>} Write operation result with path and metadata
 */
export async function writeFileOp(params, signal, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  if (params.content === undefined || params.content === null) {
    throw new TypeError('content is required');
  }
  if (typeof params.content !== 'string') {
    throw new TypeError('content must be a string');
  }
  return callOp('read-file', 'writeFile', params, signal, allowedPaths);
}

/**
 * Edit file using search-and-replace
 * @param {ReadFileEditParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport; see writeFileOp)
 * @returns {Promise<ReadFileEditResult>} Edit operation result with file metadata
 */
export async function readFileEdit(params, signal, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  // Accept old_str or any alias (backend normalizes)
  if (!params.old_str && !params.oldContent && !params.old && !params.pattern && !params.search) {
    throw new TypeError('old_str (or alias: oldContent, old, pattern, search) is required');
  }
  // Accept new_str or any alias (backend normalizes)
  if (params.new_str === undefined && params.newContent === undefined && params.new === undefined && params.replacement === undefined && params.replace === undefined) {
    throw new TypeError('new_str (or alias: newContent, new, replacement, replace) is required');
  }
  return callOp('read-file', 'editFile', params, signal, allowedPaths);
}

/**
 * Edit file by replacing a line range
 * @param {ReadFileEditLinesParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport; see writeFileOp)
 * @returns {Promise<ReadFileEditLinesResult>} Line edit operation result with file metadata
 */
export async function readFileEditLines(params, signal, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  if (params.edits !== undefined) {
    // Batch mode: validate the edits array, skip the single-edit fields.
    if (!Array.isArray(params.edits) || params.edits.length === 0) {
      throw new TypeError('edits must be a non-empty array');
    }
  } else {
    // Single-edit mode: startLine/endLine/newContent are required.
    if (typeof params.startLine !== 'number' || params.startLine < 1) {
      throw new TypeError('startLine must be a positive number');
    }
    if (typeof params.endLine !== 'number' || params.endLine < params.startLine) {
      throw new TypeError('endLine must be a number >= startLine');
    }
    if (params.newContent === undefined || params.newContent === null) {
      throw new TypeError('newContent is required');
    }
  }
  return callOp('read-file', 'editFileLines', params, signal, allowedPaths);
}

/**
 * Get file hash for staleness detection (lightweight, doesn't read full content)
 * @param {{path: string}} params
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<{path: string, exists: boolean, contentHash?: string, fileModifiedAt?: number}>} File hash and metadata for change detection
 */
export async function readFileGetHash(params, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('read-file', 'getFileHash', params, undefined, allowedPaths);
}

/**
 * Get file/directory metadata without reading content
 * @param {{path: string, userInitiated?: boolean}} params
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<{path: string, exists: boolean, isFile?: boolean, isDirectory?: boolean, size?: number, modified?: number}>} File/directory metadata
 */
export async function statOp(params, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('read-file', 'stat', params, undefined, allowedPaths);
}

/**
 * Create a directory
 * @param {{path: string, recursive?: boolean}} params
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<{path: string}>} Created directory path
 */
export async function mkdirOp(params, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('read-file', 'mkdir', params, undefined, allowedPaths);
}

// ============================================================================
// tree Operations
// ============================================================================

/**
 * Get directory tree structure
 * @param {TreeGetTreeParams} params
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<TreeGetTreeResult>} Directory tree structure and metadata
 */
export async function treeGetTree(params, allowedPaths) {
  // Validate depth if provided
  if (params.depth !== undefined) {
    if (typeof params.depth !== 'number' || params.depth < 1 || params.depth > 5) {
      throw new TypeError('depth must be a number between 1 and 5');
    }
  }
  // Validate fileType if provided
  if (params.fileType !== undefined) {
    if (!['all', 'files', 'dirs'].includes(params.fileType)) {
      throw new TypeError('fileType must be "all", "files", or "dirs"');
    }
  }
  return callOp('tree', 'getTree', params, undefined, allowedPaths);
}

/**
 * Expand directory to show contents
 * @param {TreeExpandDirParams} params
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<TreeExpandDirResult>} Directory contents with file and folder items
 */
export async function treeExpandDirectory(params, allowedPaths) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('tree', 'expandDirectory', params, undefined, allowedPaths);
}

/**
 * Parameters for glob operation
 * @typedef {object} TreeGlobParams
 * @property {string} pattern - Glob pattern (e.g., "src/*.js" or deep patterns)
 * @property {string} [path] - Directory to search in (default: project root)
 */

/**
 * Result from glob operation
 * @typedef {object} TreeGlobResult
 * @property {string[]} files - Matching file paths sorted by modification time
 * @property {string} pattern - Pattern that was used
 * @property {string} path - Search path used
 * @property {number} count - Number of files found
 * @property {boolean} truncated - Whether results were truncated
 */

/**
 * Find files matching a glob pattern
 * @param {TreeGlobParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<TreeGlobResult>} Matching files sorted by modification time
 */
export async function treeGlob(params, signal, allowedPaths) {
  if (!params.pattern) {
    throw new TypeError('pattern is required');
  }
  return callOp('tree', 'glob', params, signal, allowedPaths);
}

// ============================================================================
// grep Operations
// ============================================================================

/**
 * Search for pattern in files
 * @param {GrepSearchParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @returns {Promise<GrepSearchResult>} Search results with matching files and lines
 */
export async function grepSearch(params, signal, allowedPaths) {
  if (!params.pattern) {
    throw new TypeError('pattern is required');
  }
  // Validate maxResults if provided
  if (params.maxResults !== undefined) {
    if (typeof params.maxResults !== 'number' || params.maxResults < 1 || params.maxResults > 1000) {
      throw new TypeError('maxResults must be a number between 1 and 1000');
    }
  }
  return callOp('grep', 'grep', params, signal, allowedPaths);
}

/**
 * Find symbol definition (function, class, etc.)
 * @param {GrepFindSymbolParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<GrepFindSymbolResult>} Symbol definitions found across files
 */
export async function grepFindSymbol(params, signal) {
  if (!params.symbol) {
    throw new TypeError('symbol is required');
  }
  return callOp('grep', 'findSymbol', params, signal);
}

// ============================================================================
// python (shell) Operations
// ============================================================================

/**
 * Execute shell command
 * @param {ShellExecuteParams} params
 * @returns {Promise<ShellExecuteResult>} Command execution result with stdout, stderr, and exit code
 */
export async function shellExecute(params) {
  // Must have either command or code
  if (!params.command && !params.code) {
    throw new TypeError('command or code is required');
  }
  // Validate command if provided
  if (params.command) {
    if (typeof params.command !== 'string') {
      throw new TypeError('command must be a string');
    }
    if (params.command.length > 10000) {
      throw new TypeError('command must be less than 10000 characters');
    }
  }
  // Validate code if provided
  if (params.code) {
    if (typeof params.code !== 'string') {
      throw new TypeError('code must be a string');
    }
  }
  // Validate timeout if provided
  if (params.timeout !== undefined) {
    if (typeof params.timeout !== 'number' || params.timeout < 0 || params.timeout > MAX_EXEC_TIMEOUT_MS) {
      throw new TypeError(`timeout must be a number between 0 and ${MAX_EXEC_TIMEOUT_MS}`);
    }
  }
  return callOp('python', 'execute', params);
}

/**
 * Streaming shell output chunk
 * @typedef {object} ShellStreamChunk
 * @property {string} shellId - Shell execution ID
 * @property {string} data - Output data chunk
 * @property {boolean} done - Whether execution is complete
 * @property {number} [exitCode] - Exit code (only present when done=true)
 * @property {string} [error] - Error message (only present on failure)
 * @property {string} [status] - Liveness status for a silent command: "awaiting-permission" | "running" (non-done, empty data)
 * @property {string} [hint] - Human-readable explanation accompanying status
 */

/**
 * Streaming shell execution result
 * @typedef {object} ShellStreamResult
 * @property {string} command - Command that was executed
 * @property {string} stdout - Accumulated stdout (merged with stderr)
 * @property {number} exitCode - Process exit code
 * @property {boolean} success - Whether command succeeded (exitCode === 0)
 * @property {string} [error] - Error message if execution failed
 * @property {boolean} [cancelled] - Whether execution was cancelled via AbortSignal
 */

/**
 * Execute shell command with streaming output via WebSocket.
 * Output is streamed in real-time via the onOutput callback as chunks arrive.
 * Returns a promise that resolves when the command completes.
 * @param {ShellExecuteParams} params - Command parameters
 * @param {(chunk: ShellStreamChunk) => void} onOutput - Callback for each output chunk
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel the execution
 * @returns {Promise<ShellStreamResult>} Final result when command completes
 */
export async function shellExecuteStreaming(params, onOutput, signal) {
  // Import WebSocket service
  const wsServiceModule = await import('./websocket.js');
  const wsService = wsServiceModule.default;
  // Cache the singleton for the synchronous shellCancelStreaming below. Set
  // BEFORE shell-start is sent, so any shell that can be cancelled is
  // guaranteed to have populated the cache first.
  cachedWsService = wsService;

  // Validate parameters
  if (!params.command && !params.code) {
    throw new TypeError('command or code is required');
  }

  const command = params.command || params.code || '';

  // Generate unique shell ID
  const shellId = `shell-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  return new Promise((resolve, reject) => {
    // Accumulated merged stdout/stderr. Resolved values use trimEnd (not
    // trim): a trailing newline from the shell is noise, but leading
    // whitespace/blank lines are real output and must be preserved so the
    // properties panel shows the command's output verbatim.
    let stdout = '';
    let resolved = false;

    // Store abort handler reference for cleanup
    /** @type {(() => void)|null} */
    let abortHandler = null;

    // Safety-net client timeout: the backend already caps at the max exec
    // timeout, but if the worker crashes or the WS disconnects mid-stream we'd
    // otherwise leak the listener and the promise forever. Default to backend
    // cap + 30 s of slack so legitimate long-running commands still finish.
    const backendCapMs = MAX_EXEC_TIMEOUT_MS;
    const slackMs = 30_000;
    const timeoutMs = Math.max(params.timeout || backendCapMs, backendCapMs) + slackMs;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timeoutHandle = null;

    /**
     * Cleanup all listeners
     */
    const cleanup = () => {
      wsService.off('shell-output', handleOutput);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    /**
     * @param {unknown} data
     */
    const handleOutput = (data) => {
      const chunk = /** @type {ShellStreamChunk} */ (data);

      // Ignore events for other shells
      if (chunk.shellId !== shellId) return;

      // Accumulate output
      if (chunk.data) {
        stdout += chunk.data;
      }

      // Call user's callback for streaming display
      if (onOutput && !resolved) {
        onOutput(chunk);
      }

      // Handle completion
      if (chunk.done && !resolved) {
        resolved = true;
        cleanup();

        if (chunk.error) {
          // Error case - still resolve with result, let caller handle
          resolve({
            command,
            stdout: stdout.trimEnd(),
            exitCode: chunk.exitCode || 1,
            success: false,
            error: chunk.error
          });
        } else {
          resolve({
            command,
            stdout: stdout.trimEnd(),
            exitCode: chunk.exitCode || 0,
            success: (chunk.exitCode || 0) === 0
          });
        }
      }
    };

    // Handle abort signal for cancellation
    abortHandler = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        shellCancelStreaming(shellId);
        resolve({
          command,
          stdout: stdout.trimEnd(),
          exitCode: -1,
          success: false,
          cancelled: true
        });
      }
    };

    // Check if already aborted before starting
    if (signal?.aborted) {
      abortHandler();
      return;
    }

    // Listen for abort signal
    if (signal) {
      signal.addEventListener('abort', abortHandler);
    }

    // Register listener
    wsService.on('shell-output', handleOutput);

    // Arm safety-net timeout
    timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      shellCancelStreaming(shellId);
      resolve({
        command,
        stdout: stdout.trimEnd(),
        exitCode: -1,
        success: false,
        error: `shellExecuteStreaming hit client-side safety timeout after ${timeoutMs}ms (worker never sent done)`
      });
    }, timeoutMs);

    // Send shell-start request. A conversationId injected into params (see
    // ContextItem._withConv) routes the shell into that conversation's bound
    // workspace; undefined ⇒ the base project root.
    const sent = wsService.sendShellStart(
      shellId,
      command,
      params.cwd,
      params.timeout,
      /** @type {any} */ (params).conversationId
    );

    if (!sent) {
      resolved = true;
      cleanup();
      reject(new Error('WebSocket not connected, cannot execute streaming command'));
    }
  });
}

/**
 * The websocket.js singleton, cached by shellExecuteStreaming's dynamic import
 * so the synchronous shellCancelStreaming below can reach it without going
 * async. Never null by the time a cancel can legitimately fire: every
 * cancellable shell was started by shellExecuteStreaming, which populates this
 * before sending shell-start.
 *
 * REGRESSION HISTORY: this used to be read from `window.wsService`, which is
 * assigned nowhere — so every cancel silently no-opped, the server never got
 * the shell-cancel, and an interrupted command's process ran on until its
 * timeout reaped it (up to 20 minutes).
 * @type {import('./websocket.js').default|null}
 */
let cachedWsService = null;

/**
 * Cancel a running streaming shell command
 * @param {string} shellId - Shell ID to cancel
 * @returns {boolean} True if cancel request was sent
 */
export function shellCancelStreaming(shellId) {
  if (cachedWsService) {
    return cachedWsService.sendShellCancel(shellId);
  }
  return false;
}

// ============================================================================
// Background Shell Operations (TaskOutput/KillShell)
// ============================================================================

/**
 * Parameters for starting a background shell
 * @typedef {object} ShellStartBackgroundParams
 * @property {string} command - The command to execute
 * @property {number} [timeout] - Optional timeout in milliseconds (max 1200000)
 * @property {string} [conv_id] - Conversation ID for tracking ownership
 * @property {string} [tool_use_id] - Tool use ID for frontend correlation
 */

/**
 * Result from starting a background shell
 * @typedef {object} ShellStartBackgroundResult
 * @property {string} task_id - The task ID for tracking
 * @property {string} command - The command being executed
 * @property {string} status - Initial status ("running")
 */

/**
 * Start a command in the background
 * @param {ShellStartBackgroundParams} params
 * @returns {Promise<ShellStartBackgroundResult>} Background task info
 */
export async function shellStartBackground(params) {
  if (!params.command) {
    throw new TypeError('command is required');
  }
  return callOp('shell', 'startBackground', params);
}

/**
 * Parameters for getting task output
 * @typedef {object} ShellGetOutputParams
 * @property {string} task_id - The task ID to get output from
 * @property {boolean} [block] - Whether to wait for completion (not yet implemented)
 * @property {number} [timeout] - Max wait time in ms (not yet implemented)
 */

/**
 * Result from getting task output
 * @typedef {object} ShellGetOutputResult
 * @property {string} task_id - The task ID
 * @property {string} status - Task status: "running" | "completed" | "failed" | "not_found"
 * @property {string} [output] - Task output (stdout + stderr)
 * @property {number} [exitCode] - Exit code if completed
 * @property {string} [error] - Error message if failed
 */

/**
 * Get output from a background task
 * @param {ShellGetOutputParams} params
 * @returns {Promise<ShellGetOutputResult>} Task output result
 */
export async function shellGetOutput(params) {
  if (!params.task_id) {
    throw new TypeError('task_id is required');
  }
  return callOp('shell', 'getOutput', params);
}

/**
 * Get NEW output from a background task since the previous getOutputDelta call
 * for the same task (BashOutput semantics). Advances a per-task read cursor, so
 * repeated polling returns only unseen output — never the whole accumulated log
 * again. Used by the TaskOutput tool; the cumulative {@link shellGetOutput} is
 * left for consumers (the Monitor live-output panel) that keep their own cursor.
 * @param {ShellGetOutputParams} params
 * @returns {Promise<ShellGetOutputResult & {outputIsNew?: boolean}>} Delta output result
 */
export async function shellGetOutputDelta(params) {
  if (!params.task_id) {
    throw new TypeError('task_id is required');
  }
  return callOp('shell', 'getOutputDelta', params);
}

/**
 * Parameters for killing a shell
 * @typedef {object} ShellKillParams
 * @property {string} shell_id - The shell ID to kill
 */

/**
 * Result from killing a shell
 * @typedef {object} ShellKillResult
 * @property {string} shell_id - The shell ID
 * @property {boolean} killed - Whether the shell was successfully killed
 * @property {string} [error] - Error message if kill failed
 */

/**
 * Kill a background shell process
 * @param {ShellKillParams} params
 * @returns {Promise<ShellKillResult>} Kill result
 */
export async function shellKill(params) {
  if (!params.shell_id) {
    throw new TypeError('shell_id is required');
  }
  return callOp('shell', 'kill', params);
}

// ============================================================================
// WebFetch Operations
// ============================================================================

/**
 * Parameters for web fetch operation
 * @typedef {object} WebFetchParams
 * @property {string} url - The URL to fetch content from
 * @property {string} [prompt] - What to extract from the page. Optional: when
 *   omitted, the op returns the raw page content (the server treats prompt as
 *   optional). The web-fetch context item delegates to a sub-agent only when a
 *   prompt is present.
 */

/**
 * Result from web fetch operation
 * @typedef {object} WebFetchResult
 * @property {string} url - The URL that was fetched
 * @property {string} content - The extracted content (HTML converted to markdown)
 * @property {string} prompt - The prompt that was used
 * @property {boolean} cached - Whether the result was from cache
 * @property {boolean} [truncated] - Whether content was truncated
 * @property {boolean} [redirect] - Whether a redirect was detected
 * @property {string} [redirect_url] - The redirect URL if redirect is true
 * @property {string} [error] - Error message if redirect or failure
 */

/**
 * Fetch content from a URL and convert to markdown
 * @param {WebFetchParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<WebFetchResult>} Fetched content
 */
export async function webFetch(params, signal) {
  if (!params.url) {
    throw new TypeError('url is required');
  }
  // prompt is optional: without it the op returns the raw page content.
  return callOp('webfetch', 'fetch', params, signal);
}

// ============================================================================
// WebSearch Operations
// ============================================================================

/**
 * Parameters for web search operation (backend CORS proxy)
 * @typedef {object} WebSearchParams
 * @property {string} url - The URL to fetch
 * @property {string} [method] - HTTP method (GET or POST)
 * @property {Record<string, string>} [form_data] - Form data for POST requests
 */

/**
 * Response from web search CORS proxy
 * @typedef {object} WebSearchProxyResponse
 * @property {string} url - The URL that was fetched
 * @property {string} content - Raw response content (HTML or JSON)
 * @property {number} status - HTTP status code
 */

/**
 * Search the web via backend CORS proxy
 * Backend fetches the URL and returns raw content for frontend to parse
 * @param {WebSearchParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<WebSearchProxyResponse>} Raw response from backend proxy
 */
export async function webSearch(params, signal) {
  if (!params.url) {
    throw new TypeError('url is required');
  }
  return callOp('websearch', 'search', params, signal);
}

// ============================================================================
// OS Integration Operations
// ============================================================================

/**
 * Result of an OS open/reveal launch.
 * @typedef {object} OSLaunchResult
 * @property {boolean} opened - True when the handler was launched.
 * @property {boolean} reveal - True for a reveal-in-file-manager launch.
 * @property {string} path - The resolved absolute path that was acted on.
 */

/**
 * Open a path with the host OS's default handler (like double-clicking it).
 * @param {{path: string}} params - The file or directory path to open.
 * @returns {Promise<OSLaunchResult>} Launch result.
 */
export async function osOpenPath(params) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('os', 'open', params);
}

/**
 * Reveal a path in the host OS file manager (Finder / Explorer / file browser).
 * @param {{path: string}} params - The file or directory path to reveal.
 * @returns {Promise<OSLaunchResult>} Launch result.
 */
export async function osRevealPath(params) {
  if (!params.path) {
    throw new TypeError('path is required');
  }
  return callOp('os', 'reveal', params);
}

// ============================================================================
// MCP (Model Context Protocol) Operations
// ============================================================================

/**
 * A tool discovered on an MCP server, flattened for the engine.
 * @typedef {object} McpToolInfo
 * @property {string} server - Owning server name
 * @property {string} name - Raw MCP tool name
 * @property {string} title - Display title (falls back to name)
 * @property {string} description - Server-provided description
 * @property {object} inputSchema - JSON Schema for the tool's arguments
 * @property {boolean} readOnly - annotations.readOnlyHint
 * @property {boolean} destructive - annotations.destructiveHint (when !readOnly)
 * @property {number} schemaTokens - ~chars/4 estimate of the input schema
 */

/**
 * Status of one configured MCP server.
 * @typedef {object} McpServerStatus
 * @property {string} name - Configured server name
 * @property {'stopped'|'starting'|'running'|'failed'} status - Live lifecycle status
 * @property {string} [error] - Last error, when failed or restarting
 * @property {string} transport - Transport kind (stdio)
 * @property {boolean} enabled - Whether the server is enabled in config
 * @property {number} toolCount - Number of discovered tools
 * @property {number} schemaTokens - Estimated schema token cost across tools
 * @property {string} [serverName] - Server-reported implementation name
 * @property {string} [serverVersion] - Server-reported implementation version
 */

/**
 * One content block returned by an MCP tool call.
 * @typedef {object} McpContentBlock
 * @property {'text'|'image'|'audio'|'resource'|'resource_link'|'unknown'} type - Block kind
 * @property {string} [text] - Text content (type=text)
 * @property {string} [data] - base64 payload for image/audio
 * @property {string} [mimeType] - MIME type for image/audio/resource
 * @property {string} [uri] - Resource URI for resource/resource_link
 * @property {string} [name] - Resource name for resource_link
 * @property {string} [title] - Resource title for resource_link
 * @property {string} [description] - Resource description for resource_link
 */

/**
 * List configured MCP servers and their live status.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{servers: McpServerStatus[]}>} Configured servers and their status
 */
export async function mcpListServers(signal) {
  return callOp('mcp', 'listServers', {}, signal);
}

/**
 * List discovered tools, optionally scoped to one server.
 * @param {{server?: string}} [params]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{tools: McpToolInfo[]}>} Discovered tools
 */
export async function mcpListTools(params, signal) {
  return callOp('mcp', 'listTools', params || {}, signal);
}

/**
 * Fetch the full discovered-tool snapshot across all running servers. Reads the
 * manager's current cache (never blocks on a live handshake) and, as a side
 * effect, reconciles the manager to the active project so enabled servers start.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{tools: McpToolInfo[]}>} The current discovered-tool snapshot
 */
export async function mcpSnapshot(signal) {
  return callOp('mcp', 'snapshot', {}, signal);
}

/**
 * Invoke an MCP tool. Honors the abort signal (cancels the tools/call).
 * @param {{server: string, tool: string, args?: object}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{content: McpContentBlock[], isError: boolean}>} Tool result content blocks
 */
export async function mcpCallTool(params, signal) {
  if (!params.server || !params.tool) {
    throw new TypeError('server and tool are required');
  }
  return callOp('mcp', 'callTool', params, signal);
}

/**
 * Control a server's lifecycle.
 * @param {{server: string, action: 'start'|'stop'|'restart'|'reload'}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{servers: McpServerStatus[]}>} Updated server list
 */
export async function mcpServerControl(params, signal) {
  if (!params.server || !params.action) {
    throw new TypeError('server and action are required');
  }
  return callOp('mcp', 'serverControl', params, signal);
}

/**
 * Recent stderr for a server (diagnostics).
 * @param {{server: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{log: string}>} Recent stderr
 */
export async function mcpGetLog(params, signal) {
  if (!params.server) {
    throw new TypeError('server is required');
  }
  return callOp('mcp', 'getLog', params, signal);
}

/**
 * Read the merged MCP config plus the raw per-file server maps.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{merged: object, global: object, project: object, hasProject: boolean}>} Merged and per-file config
 */
export async function mcpGetConfig(signal) {
  return callOp('mcp', 'getConfig', {}, signal);
}

/**
 * Write servers to the global or project mcp.json and reconcile live.
 * @param {{scope?: 'global'|'project', servers: object}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{servers: McpServerStatus[]}>} Updated server list
 */
export async function mcpSetConfig(params, signal) {
  return callOp('mcp', 'setConfig', params, signal);
}

// ============================================================================
// ACP (Agent Client Protocol) agent configuration
// ============================================================================

/**
 * Status of one configured ACP agent. Agents are spawned per-conversation, so
 * there is no persistent process — "status" is whether the command resolves on
 * PATH right now.
 * @typedef {object} AcpAgentStatus
 * @property {string} name - Configured agent name (also its model id)
 * @property {'available'|'unavailable'|'disabled'} status - Resolvability/enabled state
 * @property {string} [error] - Why unavailable (missing/empty command)
 * @property {boolean} enabled - Whether the agent is enabled in config
 * @property {string} [command] - The configured launch command
 */

/**
 * List configured ACP agents and their live (PATH-resolvable) status.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{agents: AcpAgentStatus[]}>} Configured agents and their status
 */
export async function acpListAgents(signal) {
  return callOp('acp', 'listAgents', {}, signal);
}

/**
 * Read the merged ACP config plus the raw per-file agent maps.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{merged: object, global: object, project: object, hasProject: boolean}>} Merged and per-file config
 */
export async function acpGetConfig(signal) {
  return callOp('acp', 'getConfig', {}, signal);
}

/**
 * Write agents to the global or project acp.json. Takes effect on the next turn
 * (the provider reads config afresh when a conversation opens).
 * @param {{scope?: 'global'|'project', agents: object}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{agents: AcpAgentStatus[]}>} Updated agent list
 */
export async function acpSetConfig(params, signal) {
  return callOp('acp', 'setConfig', params, signal);
}

// ============================================================================
// Workspace binding — the extension-facing execution-root indirection
// ============================================================================

/**
 * POST a JSON body to a plain server endpoint (not the /api/ops/call router),
 * carrying the per-instance token. Shared by the workspace-binding calls.
 * @param {string} path - API path under /api (e.g. "/workspace/bind")
 * @param {object} body - JSON request body
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} On a non-OK HTTP status
 * @private
 */
async function postApi(path, body) {
  const headers = /** @type {Record<string, string>} */ ({ 'Content-Type': 'application/json' });
  const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
  if (token) {
    headers['X-Juggler-Token'] = token;
  }
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Bind a conversation's execution root to `root`. While bound, that
 * conversation's file/shell/search/tree ops run under `root` instead of the
 * project directory — with every path still validated in real-project space, so
 * the security boundary is unchanged.
 *
 * This is the core primitive that lets an EXTENSION add worktree-style workflows
 * without core knowing anything about them: the extension prepares an alternate
 * root by whatever means (a git worktree, a devcontainer mount, a sandbox),
 * then binds it here. See the worktrees extension for a worked example. Pair
 * with {@link unbindWorkspace} on teardown.
 * @param {string} conversationId - The conversation to bind.
 * @param {string} root - Absolute path of the alternate execution root.
 * @returns {Promise<{ok: boolean, root?: string, error?: string}>} Bind result.
 */
export async function bindWorkspace(conversationId, root) {
  return postApi('/workspace/bind', { conversationId, root });
}

/**
 * Clear a conversation's workspace binding; its ops revert to the project root.
 * @param {string} conversationId - The conversation to unbind.
 * @returns {Promise<{ok: boolean, error?: string}>} Unbind result.
 */
export async function unbindWorkspace(conversationId) {
  return postApi('/workspace/unbind', { conversationId });
}
