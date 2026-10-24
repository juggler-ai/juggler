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

import { extractHttpErrorDetail, extractHttpErrorParts, withApiToken } from './http.js';
import { apiUrl } from '../utils/api-url.js';

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
   * @param {number} [status] - HTTP status, when the error came from an HTTP response
   * @param {{code?: string, detail?: Record<string, unknown>, serverMessage?: import('./http.js').ServerMessage}} [coded] - The op's
   *   failure code and its detail, when it gave one, and the server's message for `message`, when it sent one
   */
  constructor(message, status, coded = {}) {
    super(message);
    this.name = 'OpsError';
    /**
     * The server's message for this failure, for the UI to show translated with
     * serverText() (errorText in juggler/ui does it); undefined when the server
     * sent English alone. `message` stays English: it is what a tool result
     * tells the model.
     * @type {import('./http.js').ServerMessage|undefined}
     */
    this.serverMessage = coded.serverMessage && typeof coded.serverMessage === 'object'
      && typeof coded.serverMessage.key === 'string' && coded.serverMessage.key !== ''
      ? coded.serverMessage : undefined;
    /**
     * The op's stable code for this kind of failure (e.g. `SEARCH_NOT_FOUND`,
     * an edit whose old_str matched nothing), or undefined for a failure with
     * no code. Branch on this, never on the message.
     * @type {string|undefined}
     */
    this.code = coded.code || undefined;
    /**
     * The values the op sent with the code, e.g. the file's current
     * `contentHash` for `SEARCH_NOT_FOUND`.
     * @type {Record<string, unknown>}
     */
    this.detail = coded.detail || {};
    /**
     * The HTTP status this error was reported with, when it came from an HTTP
     * response (undefined otherwise). Lets a caller branch on the KIND of
     * failure — notably 429, a fast "busy, try again" rejection that is meant to
     * be retried — without matching on the human-readable message, which is
     * prose for the user and not a stable contract.
     * @type {number|undefined}
     */
    this.status = status;
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
 * shell() here and the bash tool's validate() in execute-context-item.js.
 * The Go backend enforces the same cap (maxExecTimeoutMs in shell_ops.go).
 */
export const MAX_EXEC_TIMEOUT_MS = 1200000;

/**
 * Backstop deadline on a single `/api/ops/call` request.
 *
 * This is not a policy on how long an op may take — the server owns each op's
 * real budget, and several ops (grep, tree walks, an MCP tool call) deliberately
 * have none, being bounded by the work rather than by a clock. It exists because
 * `await fetch(…)` is otherwise unbounded in BOTH directions: nothing on the
 * route imposes a request deadline (no WriteTimeout, no TimeoutHandler), and a
 * request the transport loses without erroring never settles at all. Every
 * read/grep/glob/MCP/webfetch tool ends up here, and a tool awaiting a promise
 * that never settles is the one wedge nothing else in the system can see — it
 * holds the tool at `running` forever while the engine stays perfectly healthy.
 *
 * It sits AT the largest budget any op in the system is permitted
 * ({@link MAX_EXEC_TIMEOUT_MS}, the shell/python ceiling) precisely so it can
 * never pre-empt an op that is still legitimately working; a caller whose own
 * budget reaches that ceiling passes a longer one explicitly rather than tying
 * with it. Lowering it to something that feels reasonable for a file read would
 * break a large grep on a big repo and a slow MCP server, which is a worse
 * failure than the one being fixed.
 */
export const OP_CALL_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS;

/**
 * Headroom added to an op's OWN server-side budget when deriving its request
 * deadline, so the backstop always loses the race to the server's real timeout
 * and the caller gets the op's own error rather than this one.
 */
const OP_CALL_TIMEOUT_GRACE_MS = 30000;

/**
 * The live backstop, shortened by tests.
 * @type {number}
 */
let _opCallTimeoutMs = OP_CALL_TIMEOUT_MS;

/**
 * Test hook: shorten the request backstop so a deadline test need not wait out
 * the production one. Not used in production.
 * @param {number} [ms] - New backstop, or omit to restore the default
 */
export function __setOpCallTimeoutForTest(ms) {
  _opCallTimeoutMs = ms ?? OP_CALL_TIMEOUT_MS;
}

/**
 * Refuse a call missing a required parameter before it reaches the wire, so the
 * caller gets a TypeError naming the parameter rather than a backend error.
 * @param {object} params - The operation's parameters
 * @param {string} name - The parameter that must be present and non-empty
 * @param {string} [alias] - Another spelling the server also reads (the shell
 *   op's snake_case ids — see shellParamSpellings in ops/shell_ops.go)
 */
function requireParam(params, name, alias) {
  const p = /** @type {Record<string, unknown>} */ (params);
  if (!p[name] && !(alias && p[alias])) {
    throw new TypeError(`${name} is required`);
  }
}

/**
 * Read a rooted op's trailing arguments into the canonical
 * `(signal, allowedPaths, workspaceId)`, accepting the signal-less order
 * `(allowedPaths, workspaceId)` as well. That order is told apart by a grant (an
 * array) in the signal's place, or a workspace id (a string) in the grant's; the
 * canonical order never puts either there. These are public `juggler/ops`
 * exports called by position from extension code, so a call in the signal-less
 * order is honoured rather than sent with its grant as a workspace.
 * @param {any} signal - Second argument.
 * @param {any} allowedPaths - Third argument.
 * @param {any} workspaceId - Fourth argument.
 * @returns {[AbortSignal|undefined, string[]|undefined, string|undefined]} The canonical trio.
 */
function rootedArgs(signal, allowedPaths, workspaceId) {
  if (Array.isArray(signal) || typeof allowedPaths === 'string') {
    return [undefined, signal, allowedPaths];
  }
  return [signal, allowedPaths, workspaceId];
}

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
 * @property {string} [code] - Stable failure code, when the op gave its failure one (see OpsError#code)
 * @property {Record<string, unknown>} [detail] - Values that go with the code (see OpsError#detail)
 * @property {import('./http.js').ServerMessage} [message] - The error as a message for the UI to translate (see OpsError#serverMessage)
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
 * @property {number} [maxLines] - Line ceiling for a whole-file read; 0 means no ceiling. Omitted, the op's own default applies
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
 * @property {string} [mime] - Mime type of the file ('' when unknown)
 * @property {boolean} [isBinary] - True when the bytes are not text; reported, not judged — the file's viewer decides what can be shown
 */

/**
 * Parameters for writeFile operation
 * @typedef {object} ReadFileWriteParams
 * @property {string} path - File path (relative to project root, or absolute — JS approval is the gate)
 * @property {string} content - Content to write (max 10MB)
 * @property {boolean} [dryRun] - If true, validate path/parent/writability without modifying the file (used for pre-approval feasibility check)
 * @property {string} [expectedHash] - SHA-256 the existing file's bytes must still hash to; the write is refused if the file changed since the approved diff
 * @property {boolean} [outOfRootApproved] - Marks a write outside the project root + allowed paths as user-approved, satisfying the backend's defence-in-depth check (set only on the modal-approved execution path)
 */

/**
 * Result from writeFile operation
 * @typedef {object} ReadFileWriteResult
 * @property {string} path - File path that was written
 * @property {boolean} created - Whether file was newly created (would be created, for dryRun)
 * @property {number} size - File size after write (length of intended content, for dryRun)
 * @property {string} [contentHash] - SHA-256 of the written bytes (freshness baseline for follow-up mutations; absent for dryRun)
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
 * @property {string} [expectedHash] - SHA-256 the file's bytes must still hash to; the edit is refused if the file changed since the approved dryRun preview
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
 * @property {string} [contentHash] - SHA-256 of the file's bytes: current on-disk bytes for dryRun (staleness baseline), written bytes for a real edit
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
 * @property {string} [expectedHash] - SHA-256 the file's bytes must still hash to; the edit is refused if the file changed since the approved dryRun preview
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
 * @property {string} [contentHash] - SHA-256 of the file's bytes: current on-disk bytes for dryRun (staleness baseline), written bytes for a real edit
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
 * @property {boolean} [noIgnore] - Include files ignored by .gitignore (default false)
 * @property {boolean} [showAll] - Include hidden files and ignored files (implies noIgnore)
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
 * @property {boolean} [ignoreCase] - Case-insensitive search (default true)
 * @property {boolean} [noIgnore] - Include files ignored by .gitignore (default false)
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
 * @property {boolean} [noIgnore] - Include files ignored by .gitignore (default false)
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
 * @property {number} [timeout] - Timeout in milliseconds (default 30000, max 1200000).
 *   The -1 that {@link ShellStartBackgroundParams} reads as "no deadline" is refused
 *   here: a command whose caller waits for its output must have something that ends it.
 * @property {string} [cwd] - Working directory for command
 * @property {string} [convId] - Conversation that owns this command; buckets its full-output spill file
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
 * Call a backend operation with type safety and error handling.
 *
 * Every exported wrapper takes its trailing arguments in this function's order:
 * `(params, signal, allowedPaths, workspaceId)` for an op rooted in a tree, and
 * `(params, signal, workspaceId)` for the shell, which takes no grant. A wrapper
 * with nothing to cancel still keeps the `signal` slot, so the grant and the
 * workspace sit in the same place in every call.
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
 * @param {string} [workspaceId] - WHERE the operation runs: the id of the
 *   workspace the calling conversation is bound to, `''`/omitted for the
 *   project. Carried at the top level for the same reason as `allowedPaths`,
 *   and sent as an id rather than a root because the engine executes tool calls
 *   an LLM composed — an id only resolves to somewhere the user registered,
 *   where a raw path would let a prompt-injected model choose its own scope.
 *   The server refuses an id it cannot honour rather than falling back to the
 *   project (see handlers.OpsAPI.resolveWorkspace).
 * @param {number} [timeoutMs] - Backstop deadline for this request, overriding
 *   {@link OP_CALL_TIMEOUT_MS}. Passed by an op whose own server-side budget
 *   reaches that ceiling, so the backstop stays above the op's real timeout.
 * @returns {Promise<T>} Operation result of the specified type T
 * @throws {Error} If operation fails or parameters are invalid
 */
async function callOp(toolId, operation, params, signal, allowedPaths, workspaceId, timeoutMs = _opCallTimeoutMs) {
  /** @type {{toolId: string, operation: string, params: object, allowedPaths?: string[], workspaceId?: string}} */
  const requestBody = {
    toolId,
    operation,
    params
  };
  if (allowedPaths !== undefined) {
    requestBody.allowedPaths = allowedPaths;
  }
  // An empty id is the project, which is what the server assumes when the field
  // is absent — so it is left off the wire rather than sent as "".
  if (workspaceId) {
    requestBody.workspaceId = workspaceId;
  }

  const headers = withApiToken({ 'Content-Type': 'application/json' });

  // The deadline is delivered as an abort, so it must be told apart from the
  // caller's own cancellation: an expiry is an ordinary failure the tool reports,
  // while the caller's abort is an AbortError that must reach it unchanged (the
  // executor turns that into a cancelled result). The caller's signal is chained
  // onto ours so Escape still cancels the request — and unchained in `finally`,
  // because a turn hands one long-lived signal to every op it runs, and each
  // listener left on it would hold this request's controller for the turn.
  const deadline = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; deadline.abort(); }, timeoutMs);
  const onCallerAbort = () => deadline.abort();
  if (signal) {
    if (signal.aborted) deadline.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  /** @type {OpsResponse<T>} */
  let result;
  try {
    // The deadline covers the body too, not just the headers: a response whose
    // headers arrive and whose body then stalls hangs the caller just as
    // completely as one that never arrives.
    const response = await fetch(apiUrl('/ops/call'), {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: deadline.signal
    });

    // Check HTTP status
    if (!response.ok) {
      // A plain Error, not an OpsError: a request the server could not take is
      // not an op's operational feedback. It carries the server's detail and
      // message so the UI can show the detail translated (errorText).
      const { detail, serverMessage } = await extractHttpErrorParts(response);
      const failure = /** @type {Error & {detail?: string, serverMessage?: unknown}} */ (new Error(`HTTP ${response.status}: ${detail}`));
      failure.detail = detail;
      failure.serverMessage = serverMessage;
      throw failure;
    }
    result = await response.json();
  } catch (err) {
    if (expired) {
      throw new OpsError(`Couldn't finish ${toolId}.${operation}: the backend never answered, so it was given up on after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!result.success) {
    // All backend errors are operational feedback, not bugs
    throw new OpsError(result.error || 'Operation failed', undefined, {
      code: result.code, detail: result.detail, serverMessage: result.error ? result.message : undefined,
    });
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
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<ReadFileLoadResult>} File content and metadata
 */
export async function readFile(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'path');
  return callOp('read-file', 'loadFile', params, signal, allowedPaths, workspaceId);
}

/**
 * @typedef {object} AssetRef
 * @property {string} id - lowercase hex SHA-256 of the bytes
 * @property {string} mime - e.g. "image/png"
 * @property {string} [filename] - original/display filename
 * @property {number} bytes - size in bytes
 * @property {number} [width] - image width in px
 * @property {number} [height] - image height in px
 */

/**
 * Upload base64-encoded bytes to the conversation's content-addressed asset
 * store (the same endpoint the composer uses for pasted/dropped images) and
 * return the AssetRef. The read tool uses this to store an image it just read so
 * a multimodal model receives the actual pixels.
 * @param {string} convId - Conversation that owns the asset
 * @param {string} base64 - Base64-encoded asset bytes
 * @param {string} [mime] - Asset mime type (e.g. "image/png"); defaults to octet-stream
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<AssetRef>} The stored asset reference
 */
export async function uploadAssetBase64(convId, base64, mime, signal) {
  if (!convId) {
    throw new TypeError('convId is required');
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const headers = withApiToken({ 'Content-Type': mime || 'application/octet-stream' });
  const response = await fetch(
    apiUrl(`/session/conversations/${encodeURIComponent(convId)}/assets`),
    { method: 'POST', headers, body: bytes, signal }
  );
  if (!response.ok) {
    const detail = await extractHttpErrorDetail(response);
    throw new OpsError(`Failed to upload image (HTTP ${response.status}): ${detail}`);
  }
  return /** @type {Promise<AssetRef>} */ (response.json());
}

/**
 * The URL of a program's snapshot.
 * @param {string} convId - Conversation that owns the program
 * @param {string} toolUseId - The program's tool-use id
 * @returns {string} The URL
 */
function programSnapshotUrl(convId, toolUseId) {
  if (!convId || !toolUseId) {
    throw new TypeError('convId and toolUseId are required');
  }
  return apiUrl(`/session/conversations/${encodeURIComponent(convId)}/programs/${encodeURIComponent(toolUseId)}`);
}

/**
 * Keep the snapshot a program tool takes while one of its calls waits on the
 * user, beside its conversation and out of its document, replacing any earlier
 * one. Read back only by a program run again after its engine was lost.
 * @param {string} convId - Conversation that owns the program
 * @param {string} toolUseId - The program's tool-use id
 * @param {unknown} snapshot - Anything JSON can hold
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<void>}
 * @throws {OpsError} When it is not kept: too large (past 32 MiB), or the
 *   conversation is not this project's
 */
export async function saveProgramSnapshot(convId, toolUseId, snapshot, signal) {
  const response = await fetch(programSnapshotUrl(convId, toolUseId), {
    method: 'PUT',
    headers: withApiToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(snapshot),
    signal
  });
  if (!response.ok) {
    const detail = await extractHttpErrorDetail(response);
    throw new OpsError(`Failed to keep the program's snapshot (HTTP ${response.status}): ${detail}`);
  }
}

/**
 * A program's snapshot, if one was kept.
 * @param {string} convId - Conversation that owns the program
 * @param {string} toolUseId - The program's tool-use id
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<unknown|null>} The snapshot, or null when there is none
 */
export async function loadProgramSnapshot(convId, toolUseId, signal) {
  const response = await fetch(programSnapshotUrl(convId, toolUseId), {
    headers: withApiToken({}),
    signal
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await extractHttpErrorDetail(response);
    throw new OpsError(`Failed to read the program's snapshot (HTTP ${response.status}): ${detail}`);
  }
  return response.json();
}

/**
 * Drop a program's snapshot. One that is not there is not an error.
 * @param {string} convId - Conversation that owns the program
 * @param {string} toolUseId - The program's tool-use id
 * @returns {Promise<void>}
 */
export async function deleteProgramSnapshot(convId, toolUseId) {
  const response = await fetch(programSnapshotUrl(convId, toolUseId), {
    method: 'DELETE',
    headers: withApiToken({})
  });
  if (!response.ok) {
    const detail = await extractHttpErrorDetail(response);
    throw new OpsError(`Failed to drop the program's snapshot (HTTP ${response.status}): ${detail}`);
  }
}

/**
 * Write content to a file (creates or overwrites)
 * @param {ReadFileWriteParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level
 *   transport). The backend assembles it into the write op's PathScope so a
 *   user-granted out-of-project root counts as in-scope; combined with the
 *   `outOfRootApproved` param it forms the write defence-in-depth boundary.
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<ReadFileWriteResult>} Write operation result with path and metadata
 */
export async function writeFile(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'path');
  if (params.content === undefined || params.content === null) {
    throw new TypeError('content is required');
  }
  if (typeof params.content !== 'string') {
    throw new TypeError('content must be a string');
  }
  return callOp('read-file', 'writeFile', params, signal, allowedPaths, workspaceId);
}

/**
 * Edit file using search-and-replace
 * @param {ReadFileEditParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport; see writeFile)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<ReadFileEditResult>} Edit operation result with file metadata
 * @throws {OpsError} On failure. An old_str that matches nothing throws with
 *   code `SEARCH_NOT_FOUND`, and `detail.path` and `detail.contentHash` (the
 *   file's current bytes).
 */
export async function editFile(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'path');
  // Accept old_str or any alias (backend normalizes)
  if (!params.old_str && !params.oldContent && !params.old && !params.pattern && !params.search) {
    throw new TypeError('old_str (or alias: oldContent, old, pattern, search) is required');
  }
  // Accept new_str or any alias (backend normalizes)
  if (params.new_str === undefined && params.newContent === undefined && params.new === undefined && params.replacement === undefined && params.replace === undefined) {
    throw new TypeError('new_str (or alias: newContent, new, replacement, replace) is required');
  }
  return callOp('read-file', 'editFile', params, signal, allowedPaths, workspaceId);
}

/**
 * Edit file by replacing a line range
 * @param {ReadFileEditLinesParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport; see writeFile)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<ReadFileEditLinesResult>} Line edit operation result with file metadata
 */
export async function editFileLines(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'path');
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
  return callOp('read-file', 'editFileLines', params, signal, allowedPaths, workspaceId);
}

/**
 * Get file hash for staleness detection (lightweight, doesn't read full content)
 * @param {{path: string}} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<{path: string, exists: boolean, contentHash?: string, fileModifiedAt?: number}>} File hash and metadata for change detection
 */
export async function fileHash(params, signal, allowedPaths, workspaceId) {
  [signal, allowedPaths, workspaceId] = rootedArgs(signal, allowedPaths, workspaceId);
  requireParam(params, 'path');
  return callOp('read-file', 'getFileHash', params, signal, allowedPaths, workspaceId);
}

/**
 * Get file/directory metadata without reading content
 * @param {{path: string, userInitiated?: boolean}} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<{path: string, exists: boolean, isFile?: boolean, isDirectory?: boolean, size?: number, modified?: number}>} File/directory metadata
 */
export async function stat(params, signal, allowedPaths, workspaceId) {
  [signal, allowedPaths, workspaceId] = rootedArgs(signal, allowedPaths, workspaceId);
  requireParam(params, 'path');
  return callOp('read-file', 'stat', params, signal, allowedPaths, workspaceId);
}

/**
 * Create a directory
 * @param {{path: string, recursive?: boolean}} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<{path: string}>} Created directory path
 */
export async function mkdir(params, signal, allowedPaths, workspaceId) {
  [signal, allowedPaths, workspaceId] = rootedArgs(signal, allowedPaths, workspaceId);
  requireParam(params, 'path');
  return callOp('read-file', 'mkdir', params, signal, allowedPaths, workspaceId);
}

// ============================================================================
// tree Operations
// ============================================================================

/**
 * Get directory tree structure
 * @param {TreeGetTreeParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<TreeGetTreeResult>} Directory tree structure and metadata
 */
export async function getTree(params, signal, allowedPaths, workspaceId) {
  [signal, allowedPaths, workspaceId] = rootedArgs(signal, allowedPaths, workspaceId);
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
  return callOp('tree', 'getTree', params, signal, allowedPaths, workspaceId);
}

/**
 * Expand directory to show contents
 * @param {TreeExpandDirParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<TreeExpandDirResult>} Directory contents with file and folder items
 */
export async function expandDirectory(params, signal, allowedPaths, workspaceId) {
  [signal, allowedPaths, workspaceId] = rootedArgs(signal, allowedPaths, workspaceId);
  requireParam(params, 'path');
  return callOp('tree', 'expandDirectory', params, signal, allowedPaths, workspaceId);
}

/**
 * Parameters for glob operation
 * @typedef {object} TreeGlobParams
 * @property {string} pattern - Glob pattern (e.g., "src/*.js" or deep patterns)
 * @property {string} [path] - Directory to search in (default: project root)
 * @property {boolean} [noIgnore] - Include files ignored by .gitignore (default false)
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
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<TreeGlobResult>} Matching files sorted by modification time
 */
export async function glob(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'pattern');
  return callOp('tree', 'glob', params, signal, allowedPaths, workspaceId);
}

/**
 * Parameters for the copy operation
 * @typedef {object} TreeCopyParams
 * @property {string} [from] - The tree to copy, relative to the root; omit it to only delete
 * @property {string} to - Where to put it
 * @property {boolean} [respectIgnore] - Leave out what .gitignore leaves out (default true)
 * @property {string[]} [paths] - Copy only these, relative to `from` (default: all of it)
 * @property {string[]} [delete] - Remove these from `to` first, relative to `to`
 */

/**
 * Result from the copy operation
 * @typedef {object} TreeCopyResult
 * @property {number} copied - Files written
 * @property {number} deleted - Paths removed first
 * @property {number} skipped - Symlinks the platform refused to recreate
 * @property {number} bytes - Bytes written
 */

/**
 * Copy one tree onto another, and remove what it is told to remove first.
 *
 * A call with no `from` is a removal — the inverse of a copy, so that whatever
 * built a tree can unbuild it without reaching for a shell.
 *
 * Both ends are contained within the root, and the ignore rules are the ones
 * every other surface uses — read from `.gitignore` directly, so they hold on a
 * machine with no git at all. A destination inside the source is skipped rather
 * than descended into, which is what makes a copy into `.juggler/…` finite.
 * @param {TreeCopyParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<TreeCopyResult>} What was copied
 */
export async function copyTree(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'to');
  return callOp('tree', 'copy', params, signal, allowedPaths, workspaceId);
}

/**
 * Parameters for the compare operation
 * @typedef {object} TreeCompareParams
 * @property {string} left - One tree
 * @property {string} right - The other
 * @property {boolean} [respectIgnore] - Leave out what .gitignore leaves out (default true)
 */

/**
 * Result from the compare operation
 * @typedef {object} TreeCompareResult
 * @property {string[]} changed - Paths both hold and disagree about
 * @property {string[]} added - Paths only the right-hand tree holds
 * @property {string[]} removed - Paths only the left-hand tree holds
 * @property {boolean} truncated - Whether the lists were cut short
 */

/**
 * Say how two trees differ, by path.
 *
 * Same size and same modification time counts as unchanged, so comparing a tree
 * against a copy of it reads almost nothing; everything else is compared byte by
 * byte.
 * @param {TreeCompareParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<TreeCompareResult>} What differs
 */
export async function compareTrees(params, signal, allowedPaths, workspaceId) {
  if (!params.left || !params.right) {
    throw new TypeError('left and right are required');
  }
  return callOp('tree', 'compare', params, signal, allowedPaths, workspaceId);
}

// ============================================================================
// grep Operations
// ============================================================================

/**
 * Search for pattern in files
 * @param {GrepSearchParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<GrepSearchResult>} Search results with matching files and lines
 */
export async function grep(params, signal, allowedPaths, workspaceId) {
  requireParam(params, 'pattern');
  // Validate maxResults if provided
  if (params.maxResults !== undefined) {
    if (typeof params.maxResults !== 'number' || params.maxResults < 1 || params.maxResults > 1000) {
      throw new TypeError('maxResults must be a number between 1 and 1000');
    }
  }
  return callOp('grep', 'grep', params, signal, allowedPaths, workspaceId);
}

/**
 * Find symbol definition (function, class, etc.)
 * @param {GrepFindSymbolParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @param {string[]} [allowedPaths] - Standing allowed-paths grant (top-level transport)
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<GrepFindSymbolResult>} Symbol definitions found across files
 */
export async function findSymbol(params, signal, allowedPaths, workspaceId) {
  // (params, signal, workspaceId), which carried no grant, is honoured too.
  if (typeof allowedPaths === 'string') [allowedPaths, workspaceId] = [undefined, allowedPaths];
  requireParam(params, 'symbol');
  return callOp('grep', 'findSymbol', params, signal, allowedPaths, workspaceId);
}

// ============================================================================
// python (shell) Operations
// ============================================================================

/**
 * Execute shell command
 * @param {ShellExecuteParams} params
 * @param {AbortSignal} [signal] - Abort signal. Aborting it cancels the server's
 *   request context, and the backend kills the command's whole process group
 *   from there (`ops/shell_exec.go`, `killProcessGroup`) — so a caller that
 *   gives up on a long build stops the build, rather than stopping only its own
 *   waiting for it. Without one a command runs to completion whatever the
 *   caller does, which is indistinguishable from cancelling right up until the
 *   moment it writes something.
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp).
 *   This is the command's working directory as well as its containment boundary:
 *   the scope's root is what `ops.validateCwd` measures a requested cwd against.
 *   A shell takes no allowed-paths grant: its cwd is confined to that root.
 * @returns {Promise<ShellExecuteResult>} Command execution result with stdout, stderr, and exit code
 */
export async function shell(params, signal, workspaceId) {
  // (params, workspaceId, signal) is honoured too: a string never fills the
  // signal's place, nor an object the workspace's.
  if (typeof signal === 'string' || (typeof workspaceId === 'object' && workspaceId !== null)) {
    [signal, workspaceId] = [/** @type {any} */ (workspaceId), /** @type {any} */ (signal)];
  }
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
  // This op carries its own server-side budget, and at the ceiling that budget
  // equals the request backstop. Derive the deadline from it plus headroom so
  // the server's "command execution timeout" — which names the command and its
  // budget — always wins, and the backstop only ever catches a request that
  // never came back at all.
  const budget = params.timeout ?? DEFAULT_EXEC_TIMEOUT_MS;
  return callOp('python', 'execute', params, signal, undefined, workspaceId, budget + OP_CALL_TIMEOUT_GRACE_MS);
}

// ============================================================================
// Background Shell Operations (TaskOutput/KillShell)
// ============================================================================

/**
 * Parameters for starting a background shell
 * @typedef {object} ShellStartBackgroundParams
 * @property {string} command - The command to execute
 * @property {number} [timeout] - Optional timeout in milliseconds (max 1200000).
 *   Pass -1 for no deadline at all: the task then runs until {@link shellKill}
 *   stops it or the server goes away, which is what a long-lived local server —
 *   a dev server, a patch host an extension embeds — needs. Do not pass 0
 *   meaning "forever": 0 is a real duration and the task dies immediately.
 * @property {string} [convId] - Conversation ID for tracking ownership
 * @property {string} [toolUseId] - Tool use ID for frontend correlation
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
 *
 * Deliberately takes no `AbortSignal`, unlike {@link shell}. A background
 * shell owns its own cancellation (`shell.cancel`, `ops/shell_registry.go`) and
 * is meant to outlive the request that started it, so aborting that request
 * would abandon the reply without stopping the process — leaving a task running
 * that the caller no longer has the id of. Stopping one is `stop(taskId)`, which
 * is also what a provider pushes onto its compensation stack after starting one.
 * @param {ShellStartBackgroundParams} params
 * @param {string} [workspaceId] - Where to run it (top-level transport; see callOp)
 * @returns {Promise<ShellStartBackgroundResult>} Background task info
 */
export async function shellBackground(params, workspaceId) {
  requireParam(params, 'command');
  return callOp('shell', 'startBackground', params, undefined, undefined, workspaceId);
}

/**
 * Parameters for getting task output
 * @typedef {object} ShellGetOutputParams
 * @property {string} taskId - The task ID to get output from
 * @property {string} [convId] - The conversation the task belongs to. When given,
 *   the server refuses an id belonging to a different conversation; the project the
 *   task was started in is always checked whether this is given or not.
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
export async function shellOutput(params) {
  requireParam(params, 'taskId', 'task_id');
  return callOp('shell', 'getOutput', params);
}

/**
 * Get NEW output from a background task since the previous getOutputDelta call
 * for the same task (BashOutput semantics). Advances a per-task read cursor, so
 * repeated polling returns only unseen output — never the whole accumulated log
 * again. Used by the TaskOutput tool; the cumulative {@link shellOutput} is
 * left for consumers (the Monitor live-output panel) that keep their own cursor.
 * @param {ShellGetOutputParams} params
 * @returns {Promise<ShellGetOutputResult & {outputIsNew?: boolean}>} Delta output result
 */
export async function shellOutputDelta(params) {
  requireParam(params, 'taskId', 'task_id');
  return callOp('shell', 'getOutputDelta', params);
}

/**
 * Parameters for killing a shell
 * @typedef {object} ShellKillParams
 * @property {string} shellId - The shell ID to kill
 * @property {string} [convId] - The conversation the task belongs to. When given,
 *   the server refuses an id belonging to a different conversation; the project the
 *   task was started in is always checked whether this is given or not.
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
  requireParam(params, 'shellId', 'shell_id');
  return callOp('shell', 'kill', params);
}

/**
 * Parameters for a task liveness probe
 * @typedef {object} ShellTaskStatusParams
 * @property {string} convId - The conversation whose tasks these are. Required:
 *   there is no way to ask what tasks exist, only whether these ones are alive.
 * @property {string[]} taskIds - The task IDs to ask about
 */

/**
 * One task's liveness
 * @typedef {object} ShellTaskLiveness
 * @property {string} task_id - The task ID that was asked about
 * @property {string} status - "running" | "completed" | "failed" | "not_found"
 * @property {boolean} running - Whether it is still running
 */

/**
 * Ask which of these tasks are still running.
 *
 * Deliberately not an inventory: it answers only about ids the caller already
 * holds, and carries no output, command or exit code. A task belonging to
 * another conversation or another project answers exactly as an unknown id does,
 * so it can neither be enumerated nor confirmed to exist.
 * @param {ShellTaskStatusParams} params
 * @returns {Promise<{tasks: ShellTaskLiveness[]}>} One answer per requested ID
 */
export async function shellStatus(params) {
  requireParam(params, 'convId', 'conv_id');
  return callOp('shell', 'taskStatus', params);
}

// ============================================================================
// HTTP Operations
// ============================================================================

/**
 * Parameters for a generic server-side HTTP request.
 * @typedef {object} HTTPRequestParams
 * @property {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'} [method] - HTTP method (default GET)
 * @property {string} url - Absolute HTTP or HTTPS URL
 * @property {Record<string, string>} [headers] - Request headers
 * @property {string} [body] - Request body
 * @property {number} [timeoutMs] - Timeout in milliseconds (default 30000, max 120000)
 * @property {boolean} [followRedirects] - Follow redirects (default true)
 * @property {boolean} [allowPrivateHosts] - Permit private, loopback, and link-local targets (default false)
 */

/**
 * Result from a generic server-side HTTP request.
 * @typedef {object} HTTPRequestResult
 * @property {number} status - HTTP status code
 * @property {string} statusText - Standard HTTP status text
 * @property {Record<string, string>} headers - Response headers
 * @property {string} body - Response body, capped at 4 MiB
 * @property {boolean} truncated - Whether the response exceeded the body cap
 */

/**
 * Make a generic server-side HTTP request.
 * @param {HTTPRequestParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<HTTPRequestResult>} HTTP response
 */
export async function httpRequest(params, signal) {
  requireParam(params, 'url');
  return callOp('http', 'request', params, signal);
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
  requireParam(params, 'url');
  // prompt is optional: without it the op returns the raw page content.
  return callOp('webfetch', 'fetch', params, signal);
}

// ============================================================================
// WebSearch Operations
// ============================================================================

/**
 * Parameters for web search operation (backend CORS proxy)
 * @typedef {object} WebSearchParams
 * @property {string} url - The URL to fetch. Must be an absolute http/https URL
 *   on a public host; private, loopback and link-local targets are refused.
 * @property {string} [method] - HTTP method (GET or POST; nothing else)
 * @property {Record<string, string>} [form_data] - Form data for POST requests
 */

/**
 * Response from web search CORS proxy
 * @typedef {object} WebSearchProxyResponse
 * @property {string} url - The URL that was fetched
 * @property {string} content - Raw response content (HTML or JSON)
 * @property {number} status - HTTP status code
 * @property {boolean} [blocked] - The engine refused the request (202, 403 or
 *   429 — how a throttled client is turned away); worth retrying after a wait
 * @property {boolean} truncated - Whether the body was cut at the size cap
 */

/**
 * Search the web via backend CORS proxy
 * Backend fetches the URL and returns raw content for frontend to parse
 * @param {WebSearchParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<WebSearchProxyResponse>} Raw response from backend proxy
 */
export async function webSearch(params, signal) {
  requireParam(params, 'url');
  return callOp('websearch', 'search', params, signal);
}

// ============================================================================
// LLM Operations
// ============================================================================

/**
 * Parameters for an out-of-band text generation.
 * @typedef {object} GenerateTextParams
 * @property {string} prompt - The user content for the single-turn completion.
 * @property {string} [system] - Optional system prompt.
 * @property {('cheap'|'default'|{provider: string, model: string, thinking?: string})} [model]
 *   Which model to use. "cheap" (default) uses the resolved cheap model,
 *   "default" the default model, or an explicit {provider, model} pair.
 * @property {number} [maxTokens] - Output cap (server-clamped to a ceiling).
 * @property {number} [timeoutMs] - Wall-clock bound on the call. Omitted leaves
 *   the server's own default; a supplied value is clamped into a sane band. Ask
 *   for less when a late answer is worth nothing (the out-of-band pool is a few
 *   slots wide and shared, so a patient call is one another task cannot have).
 */

/**
 * Token accounting for a generateText call.
 * @typedef {object} GenerateTextUsage
 * @property {number} inputTokens - Total prompt tokens sent.
 * @property {number} outputTokens - Tokens generated.
 * @property {number} cachedTokens - Prompt tokens served from cache.
 */

/**
 * Result of an out-of-band text generation.
 * @typedef {object} GenerateTextResult
 * @property {string} text - The generated text (trimmed).
 * @property {GenerateTextUsage} usage - Token accounting.
 */

/**
 * Generate a short piece of text out-of-band — a single bounded LLM turn with
 * no tools, no conversation, and no persistence. Backed by /api/llm/complete
 * (see server/quick_complete.go): output is capped, wall-clock bounded, and
 * server-side concurrency-limited. Intended for micro-tasks (titles, labels,
 * one-line summaries), not for driving a conversation.
 *
 * A failure throws an `OpsError` carrying the HTTP status, and the status is
 * what to classify on: 429 the shared pool was momentarily saturated, 504 the
 * bound elapsed before the model answered, 400 the request or model was wrong,
 * 502 anything else. The first two are worth another attempt; the rest want a
 * human. Don't match on the message — it is prose, and it changes.
 * @param {GenerateTextParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<GenerateTextResult>} The generated text and usage
 */
export async function generateText(params, signal) {
  if (!params || !params.prompt) {
    throw new TypeError('prompt is required');
  }

  const headers = withApiToken({ 'Content-Type': 'application/json' });

  const body = {
    prompt: params.prompt,
    system: params.system,
    // Default to the cheap model when the caller doesn't specify one.
    model: params.model ?? 'cheap',
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs
  };

  const response = await fetch(apiUrl('/llm/complete'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const { detail, serverMessage } = await extractHttpErrorParts(response);
    throw new OpsError(detail, response.status, { serverMessage });
  }

  return response.json();
}

/**
 * One option of a choice question, or one level of a score question.
 * @typedef {object} DecisionOption
 * @property {string} [name] - Identifies a choice option in the answer. A score level has no name: its position in the list is its score, counting from zero.
 * @property {string} [description] - What the option means. Required for a score level; a choice option may leave it out and be understood from its name.
 */

/**
 * One question asked of a decision model.
 * @typedef {object} DecisionQuestion
 * @property {string} id - Names the question in the answers; chosen by the caller and never shown to the model.
 * @property {('yes-no'|'choice'|'score')} kind - The form of answer wanted: a probability, a pick from `options`, or a position on the ordered `options` scale.
 * @property {string} instructions - The question itself: the statement a yes-no question evaluates, or what a choice or score question decides.
 * @property {DecisionOption[]} [options] - The choices (1 to 255) or ordered score levels (2 to 10). A yes-no question has none.
 */

/**
 * Parameters for an out-of-band decision.
 * @typedef {object} DecideParams
 * @property {string} state - The text every question is asked about.
 * @property {DecisionQuestion[]} questions - At least one; all are answered about the same `state` in one call.
 * @property {('decision'|{provider: string, model: string})} [model]
 *   Which model to use. "decision" (default) uses the decision model chosen in
 *   Settings; an explicit {provider, model} pair names a decision model directly.
 * @property {number} [timeoutMs] - Wall-clock bound on the call, clamped into a
 *   sane band like generateText's.
 */

/**
 * A decision model's reply to one question. Which fields are set follows `kind`.
 * @typedef {object} DecisionAnswer
 * @property {('yes-no'|'choice'|'score')} kind - The form of this answer, matching its question's.
 * @property {number} [probability] - Chance the statement holds, 0 to 1 (yes-no).
 * @property {string} [choice] - The option picked (choice).
 * @property {number} [score] - Probability-weighted position on the scale (score).
 * @property {number} [confidence] - How settled the model is, 0 to 1 (choice, score).
 * @property {Record<string, number>} [probabilities] - Probability of each option, keyed by option name (choice) or level position (score).
 */

/**
 * Result of an out-of-band decision.
 * @typedef {object} DecideResult
 * @property {Record<string, DecisionAnswer>} answers - One answer per question, keyed by question id.
 * @property {{inputTokens: number, outputTokens: number}} usage - Token accounting.
 */

/**
 * Ask a decision model questions about some text — one bounded call that
 * answers with probabilities and picks instead of writing text. Backed by
 * /api/llm/decide (see server/quick_decide.go) and run in the same capped,
 * bounded, concurrency-limited pool as {@link generateText}. Use it where a
 * verdict would otherwise be parsed out of generated text.
 *
 * A failure throws an `OpsError` carrying the HTTP status, and the status is
 * what to classify on, as for generateText: 429 the shared pool was saturated,
 * 504 the bound elapsed (both worth another attempt), 400 the request or the
 * model was wrong, 502 anything else. One status is specific to this call: 409
 * means there is no decision model to ask — the user has chosen none, or the one
 * they chose cannot serve right now. A caller that can do without one (a task
 * that may run on the cheap model instead) treats it as "fall back", not as a
 * failure.
 * @param {DecideParams} params
 * @param {AbortSignal} [signal] - Abort signal for cancellation
 * @returns {Promise<DecideResult>} One answer per question, and token usage
 */
export async function decide(params, signal) {
  if (!params || !params.state) {
    throw new TypeError('state is required');
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    throw new TypeError('questions is required');
  }

  const headers = withApiToken({ 'Content-Type': 'application/json' });

  const body = {
    state: params.state,
    questions: params.questions,
    // Default to the chosen decision model when the caller doesn't specify one.
    model: params.model ?? 'decision',
    timeoutMs: params.timeoutMs
  };

  const response = await fetch(apiUrl('/llm/decide'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const { detail, serverMessage } = await extractHttpErrorParts(response);
    throw new OpsError(detail, response.status, { serverMessage });
  }

  return response.json();
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
export async function openPath(params) {
  requireParam(params, 'path');
  return callOp('os', 'open', params);
}

/**
 * Reveal a path in the host OS file manager (Finder / Explorer / file browser).
 * @param {{path: string}} params - The file or directory path to reveal.
 * @returns {Promise<OSLaunchResult>} Launch result.
 */
export async function revealPath(params) {
  requireParam(params, 'path');
  return callOp('os', 'reveal', params);
}

// ============================================================================
// Project Environment Operations
// ============================================================================

/**
 * One of the three files shell commands take variables from.
 * @typedef {object} ProjectEnvFile
 * @property {'user'|'project'|'local'} scope - Which file.
 * @property {string} path - Where it lives.
 * @property {boolean} exists - Whether it is there.
 * @property {Record<string, string>} env - Its variables, applied or not.
 * @property {string} [error] - Why it was skipped whole, when it was.
 * @property {boolean} approved - False only for a project file awaiting approval.
 */

/**
 * The variables shell commands get, and where each came from.
 * @typedef {object} ProjectEnvState
 * @property {Record<string, string>} env - The merged variables in effect.
 * @property {Record<string, 'user'|'project'|'local'>} sources - The file each came from.
 * @property {ProjectEnvFile[]} files - Every file, in merge order (user, project, local).
 * @property {boolean} pending - The project file holds variables not yet approved.
 */

/**
 * Read the environment variables shell commands get in this project.
 * @param {AbortSignal} [signal]
 * @returns {Promise<ProjectEnvState>} The files and their merged result.
 */
export async function projectEnvGet(signal) {
  return callOp('projectEnv', 'get', {}, signal);
}

/**
 * Approve the project's .juggler/env.json as it stands now. Until then, and
 * after any change to it, none of its variables apply.
 * @param {AbortSignal} [signal]
 * @returns {Promise<ProjectEnvState>} The state after approval.
 */
export async function projectEnvApprove(signal) {
  return callOp('projectEnv', 'approve', {}, signal);
}

/**
 * Replace one file's variables. An empty env removes the file. A project file
 * written here is approved as written.
 * @param {{scope: 'user'|'project'|'local', env: Record<string, string>}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<ProjectEnvState>} The state after the write.
 */
export async function projectEnvSet(params, signal) {
  requireParam(params, 'scope');
  return callOp('projectEnv', 'set', params, signal);
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
 * @property {boolean} [autoApprove] - The server is pre-approved in the global MCP config
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
 * `complete` reports whether every enabled server had published its tools, so a
 * caller that caches the result knows whether the list can still grow.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{tools: McpToolInfo[], complete: boolean}>} The current discovered-tool snapshot
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
 * Trust a project server's command (from the project's .juggler/mcp.json) as it
 * stands, and start it. A project stdio server never runs until this is called
 * or the user writes it through setConfig.
 * @param {{server: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{servers: McpServerStatus[]}>} Updated server list
 */
export async function mcpTrustServer(params, signal) {
  requireParam(params, 'server');
  return callOp('mcp', 'trustServer', params, signal);
}

/**
 * Recent stderr for a server (diagnostics).
 * @param {{server: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{log: string}>} Recent stderr
 */
export async function mcpGetLog(params, signal) {
  requireParam(params, 'server');
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
// Custom providers (the user's own named OpenAI-compatible endpoints)
// ============================================================================

/**
 * One configured custom endpoint, as its settings card needs it. Each registers
 * as its own provider, so `providerId` is the name conversations, the model
 * stores and the model picker all use — and the one thing about an endpoint that
 * can never change.
 * @typedef {object} CustomEndpoint
 * @property {string} id - The endpoint id, chosen once when it was added
 * @property {string} providerId - The provider id it registers under
 * @property {string} [displayName] - The label shown in the picker
 * @property {string} [url] - The configured base URL
 * @property {Record<string, string>} [headers] - Extra request headers
 * @property {boolean} enabled - Whether the user has it switched on
 * @property {boolean} registered - Whether it reached the provider registry, and so the picker
 * @property {string} [error] - Why an enabled endpoint did not register
 * @property {boolean} hasKey - Whether an API key is stored or in the environment
 * @property {''|'credentials'|'env'} [keySource] - Where that key comes from
 * @property {string} envVarName - The environment variable a key may come from instead
 */

/**
 * List every configured endpoint, switched on or off. Every mutation below
 * answers with the same list, so a card redraws from one round trip.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{endpoints: CustomEndpoint[]}>} The configured endpoints
 */
export async function customProvidersList(signal) {
  return callOp('customProviders', 'list', {}, signal);
}

/**
 * Write one endpoint — adding it when the id is new, editing it when it is not.
 * Only the fields sent are changed, so a card can save the one input the user
 * just left. Takes effect at once: the server reconciles the provider registry
 * before answering.
 * @param {{id: string, displayName?: string, url?: string, headers?: object, enabled?: boolean}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{endpoints: CustomEndpoint[]}>} Updated endpoint list
 */
export async function customProvidersSave(params, signal) {
  return callOp('customProviders', 'save', params, signal);
}

/**
 * Delete one endpoint, along with the hidden models, token limits and model
 * selections naming the provider id it registered under. Its API key stays in
 * the credentials store.
 * @param {{id: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{endpoints: CustomEndpoint[]}>} Updated endpoint list
 */
export async function customProvidersRemove(params, signal) {
  return callOp('customProviders', 'remove', params, signal);
}

/**
 * Store (or, with an empty string, clear) one endpoint's API key. The credential
 * key name is derived from the id server-side, so this works whether or not the
 * endpoint is currently registered.
 * @param {{id: string, apiKey: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<{endpoints: CustomEndpoint[]}>} Updated endpoint list
 */
export async function customProvidersSetKey(params, signal) {
  return callOp('customProviders', 'setKey', params, signal);
}

// ============================================================================
// Extension configuration
// ============================================================================

/**
 * Read effective extension settings. Secret values are represented by presence
 * markers and are never returned by this viewer-safe operation.
 * @param {{extId: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Effective values and secret presence markers
 */
export async function extensionConfigGet(params, signal) {
  if (!params?.extId) throw new TypeError('extId is required');
  return callOp('extconfig', 'get', params, signal);
}

/**
 * Update a subset of global extension settings.
 * @param {{extId: string, values: object, scope?: 'global'}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Effective viewer-safe values after the update
 */
export async function extensionConfigSet(params, signal) {
  if (!params?.extId) throw new TypeError('extId is required');
  if (!params.values || typeof params.values !== 'object') {
    throw new TypeError('values is required');
  }
  return callOp('extconfig', 'set', params, signal);
}

/**
 * Resolve effective extension settings for trusted extension execution,
 * including secret values.
 * @param {{extId: string}} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Full effective setting values
 */
export async function extensionConfigResolve(params, signal) {
  if (!params?.extId) throw new TypeError('extId is required');
  return callOp('extconfig', 'resolve', params, signal);
}
