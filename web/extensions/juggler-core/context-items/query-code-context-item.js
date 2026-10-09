//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
// Aliased on import: this item exposes its own `grep`/`glob` helpers to sandboxed
// code (below), so the ops primitives are bound under distinct local names.
import { runInSandbox } from 'juggler/sandbox';
import { createLlmDescription } from 'juggler/ui';
import { gitignoreDisabled } from './path-approval.js';

/**
 * QueryCodeContextItem - Run JavaScript against a read-only filesystem SDK
 *
 * Collapses a multi-step query into a single tool call. Only the return
 * value enters context — intermediate reads, greps, and globs are discarded.
 * @class
 * @augments ContextItem
 */
class QueryCodeContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'search', icon: 'icon-play' };
  }

  static MANIFEST = {
    // Fixed, and deliberately unrelated to both the file name and the tool
    // name. This id is persisted in every user's enabled-plugin list, and is
    // the key `system-prompt-contribution.js` gates this tool's guidance on.
    // Changing it flips the plugin's enabled state for anyone whose plugin set
    // is not the default, and silently drops the tool's system-prompt section.
    id: 'explore-code',
    name: 'Query Code',
    version: '1.0.0',
    description: 'Run JavaScript against a read-only filesystem SDK to compute an answer in one call',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for query_code
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'query_code',
      category: 'read',
      description: 'Run JavaScript against a read-only view of the codebase. Collapses many reads, greps and globs into one call — only the value you return, plus anything you print with `console.log`, enters context.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript to execute (async/await OK; must return a value). Browser realm, NOT Node: no `process`/`require`/`Buffer`. In-scope bindings:\n- `fs` — read-only fs.promises subset\n- `path` — POSIX path (forward-slash, even on Windows)\n- `grep(pattern, {cwd?, glob?, maxResults?, ignoreCase?})` → [{file, line, content}]\n- `glob(pattern, {cwd?})` → string[]\n- `projectRoot` — absolute root of the tree you are working in (forward-slashed). `import()` any JavaScript/JSON module under it by absolute path (e.g. `${projectRoot}/src/foo.js`) to call its real exports.'
          },
          description: {
            type: 'string',
            description: 'Short user-facing description of what this query does.'
          },
          timeout: {
            type: 'number',
            description: 'Optional execution timeout in milliseconds (1000–600000, default 120000).'
          }
        },
        required: ['code']
      }
    }];
  }

  /**
   * Validate input parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (!toolInput.code) {
      return { valid: false, error: 'Missing required parameter: code' };
    }
    if (typeof toolInput.code !== 'string') {
      return { valid: false, error: 'Parameter "code" must be a string' };
    }
    if (toolInput.timeout !== undefined) {
      const timeout = Number(toolInput.timeout);
      if (isNaN(timeout) || timeout < 1000 || timeout > 600000) {
        return { valid: false, error: 'timeout must be between 1000 and 600000 ms' };
      }
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Execute the query script via the host sandbox (juggler/sandbox),
   * exposing a read-only filesystem plus grep/glob search to the code. The
   * sandbox also injects `path` and `projectRoot` — the root of the tree this
   * conversation works in. Only the script's return value and its console
   * output enter context. The output is kept as `console` (an array of lines)
   * beside `result`, and on failure it is appended to the error.
   *
   * The result also carries `filesRead` — path → contentHash for every file
   * the script's `fs.readFile` pulled — so the read-before-mutate freshness
   * guard (read-history.js) credits files the model's own script chose to
   * read. It is a plain object (not an array) so transcript storage keeps it
   * intact, and it is never rendered into the LLM-visible content (getSummary
   * stringifies only `result`). grep/glob results earn no credit: matched
   * fragments and names don't show the model the file.
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Script result
   */
  async execute(params) {
    const code = /** @type {string} */ (params.code);
    const timeoutMs = params.timeout ? Number(params.timeout) : 120000;

    // `projectRoot` is the one root the script is given rather than confined by:
    // its fs/grep/glob already follow this conversation's workspace, but the
    // paths the script BUILDS are only as right as this string. A binding that
    // cannot be resolved therefore refuses the run instead of falling back to
    // the project — the ops would refuse anyway, but a root is believed, and a
    // script told the wrong tree looks like a tool that worked.
    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot === null) {
      throw new Error(
        'Couldn\'t run: this conversation\'s workspace is unavailable — it is still being '
        + 'created, was closed, or its directory has gone.');
    }

    const fs = this.ops.readOnlyFileSystem();
    const { grep, glob } = this._createSearchHelpers();

    // The signal is what makes Escape mean anything here. Without it the script
    // is only bounded by its own timeout — up to ten minutes — and a cancel
    // leaves the tool sitting at `running` until that budget runs out.
    /** @type {string[]} */
    const consoleLines = [];
    let result;
    try {
      result = await runInSandbox(code, {
        capabilities: { fs, grep, glob },
        timeoutMs,
        projectRoot: workspaceRoot,
        signal: this.signal,
        onConsole: (line) => { consoleLines.push(line); },
      });
    } catch (err) {
      // What the script printed matters most when it failed, so it rides the
      // error. A cancel stays a bare AbortError: nobody is reading the output.
      if (consoleLines.length === 0 || (err instanceof Error && err.name === 'AbortError')) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(withConsole(message, consoleLines));
    }

    /** @type {Record<string, unknown>} */
    const out = { result: result === undefined ? null : result };
    if (consoleLines.length > 0) out.console = consoleLines;
    if (fs.filesRead.size > 0) {
      /** @type {Record<string, string|null>} */
      const filesRead = {};
      for (const [p, hash] of fs.filesRead) filesRead[p] = hash;
      out.filesRead = filesRead;
    }
    return out;
  }

  /**
   * Create grep and glob helper functions for the sandboxed script.
   * @returns {{grep: function(string, object=): Promise<Array<{file: string, line: number, content: string}>>, glob: function(string, object=): Promise<string[]>}} Search helpers
   * @private
   */
  _createSearchHelpers() {
    // Capture the action's abort signal in the closure: these helpers are
    // destructured off the returned object, so `this` is not the plugin when
    // they run. Forwarding the signal makes the sandbox's grep/glob calls
    // cancellable along with the rest of the query_code action.
    const signal = this.signal;
    const ops = this.ops;
    // The conversation's "search all files" toggle applies to the sandbox's
    // grep/glob delegates too (the raw `fs` helper stays unfiltered — direct
    // listing, same stance as the file panel).
    const noIgnore = gitignoreDisabled(this);
    return {
      /**
       * Search file contents (ripgrep-style).
       * @param {string} pattern - Regex pattern
       * @param {{cwd?: string, glob?: string, maxResults?: number, ignoreCase?: boolean}} [options] - Search options
       * @returns {Promise<Array<{file: string, line: number, content: string}>>} Matching lines
       */
      async grep(pattern, options) {
        /** @type {Record<string, unknown>} */
        const params = { pattern };
        if (options?.cwd) params.path = options.cwd;
        if (options?.glob) params.include = options.glob;
        if (options?.maxResults) params.maxResults = options.maxResults;
        if (options?.ignoreCase !== undefined) params.ignoreCase = options.ignoreCase;
        if (noIgnore) params.noIgnore = true;
        const result = await ops.grep(/** @type {any} */ (params), signal);
        return result.matches || [];
      },
      /**
       * Find files matching a glob pattern (Node.js fs.glob-style).
       * @param {string} pattern - Glob pattern
       * @param {{cwd?: string}} [options] - Options
       * @returns {Promise<string[]>} Matching file paths
       */
      async glob(pattern, options) {
        /** @type {Record<string, unknown>} */
        const params = { pattern };
        if (options?.cwd) params.path = options.cwd;
        if (noIgnore) params.noIgnore = true;
        const result = await ops.glob(/** @type {any} */ (params), signal);
        const files = result.files || [];
        if (!options?.cwd) return files;

        // Backend results are always forward-slashed, so the cwd being stripped
        // must be too — a native Windows cwd ("C:\proj") would otherwise match
        // no prefix and the caller would get absolute paths back.
        const cwd = String(options.cwd).replace(/\\/g, '/').replace(/\/+$|^\.\/$/g, '');
        if (!cwd || cwd === '.') return files;
        const prefix = cwd + '/';
        return files.map((file) => {
          const f = String(file);
          return f === cwd ? '.' : f.startsWith(prefix) ? f.slice(prefix.length) : f;
        });
      }
    };
  }

  /**
   * Format result for LLM
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'query_code execution failed');
    }

    const result = /** @type {Record<string, unknown>} */ (outcome.result);
    let content;

    if (result.result !== null && result.result !== undefined) {
      content = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);
    } else {
      content = '(no return value)';
    }
    if (Array.isArray(result.console)) content = withConsole(content, result.console);

    return this.successSummary(this.truncateForLLM(content));
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status config
   */
  getStatusUI(actionStatus, toolInput) {
    const desc = typeof toolInput?.description === 'string' && toolInput.description.trim()
      ? toolInput.description.trim()
      : '';

    return this.buildStatusUI(actionStatus, {
      typeName: 'Script',
      pending: () => (desc ? createLlmDescription(desc) : 'Running…'),
      success: () => (desc ? createLlmDescription(desc) : ''),
      failurePrefix: 'failed'
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Output';
  }

  /**
   * query_code returns a JSON-serialised value (the script's return), so the
   * Output section is highlighted as JSON.
   * @override
   * @param {string} _toolName
   * @returns {string} Prism language id
   */
  static resultSectionLanguage(_toolName) {
    return 'json';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    if (input.description) {
      helpers.addLlmDescription(wrapper, 'Description', String(input.description));
    }
    const rawCode = input.code !== null && input.code !== undefined ? String(input.code) : '';
    const code = QueryCodeContextItem._prettyPrintCode(rawCode);
    helpers.addSubsection(wrapper, 'Code', code, 'properties-panel-code', { language: 'javascript' });
  }

  /**
   * Best-effort pretty-print for display of a crammed, single-line query_code
   * script. This is deliberately NOT a real formatter — no parser, no
   * dependency. It only engages when the script has no line structure of its
   * own (already-multi-line scripts are returned untouched), inserts newlines
   * and indentation around top-level `{`/`}`/`;`, and skips over string,
   * template, comment and regex spans so it never breaks inside them. Object
   * literals (`{...}` in expression position, e.g. a `glob(p, {cwd})` argument)
   * stay inline. On any surprise it returns the original text, so the worst
   * case is "no change", never mangled code.
   * @param {string} src - Raw script text
   * @returns {string} Reformatted text, or the original when already multi-line or on failure
   */
  static _prettyPrintCode(src) {
    return prettyPrintQueryScript(src);
  }
}

/**
 * Append a script's console output to the text the model reads.
 * @param {string} text - The result or error text
 * @param {string[]} lines - Console lines, already capped by the sandbox
 * @returns {string} text, followed by the output when there is any
 */
function withConsole(text, lines) {
  return lines.length > 0 ? `${text}\n\nConsole output:\n${lines.join('\n')}` : text;
}

// Words after which a `{` opens an expression (object literal), not a block.
const EXPR_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'case'
]);
// Words after which a `{` opens a statement block.
const BLOCK_KEYWORDS = new Set(['else', 'try', 'finally', 'do']);
// After a `}` block close, these characters continue the same line (no break).
const CLOSE_CONTINUATIONS = ')];,.';
// After a `}` block close, these keywords stay on the same line (`} else {`).
const CLOSE_KEYWORD_RE = /^(else|catch|finally|while)\b/;

/**
 * @see QueryCodeContextItem._prettyPrintCode
 * @param {string} src - Raw script text
 * @returns {string} Reformatted text, or the original when already multi-line or on failure
 */
function prettyPrintQueryScript(src) {
  if (typeof src !== 'string' || src === '') return src;
  // Already multi-line → the model laid it out; leave it exactly as-is.
  if (src.split('\n').filter((l) => l.trim() !== '').length !== 1) return src;
  // Nothing structural to gain a line break from.
  if (!/[{};]/.test(src)) return src;

  try {
    const INDENT = '  ';
    const n = src.length;
    let out = '';
    let indent = 0;
    let parenDepth = 0; // () and []: suppress `;` breaks inside for(...)/[...]
    /** @type {Array<'block'|'obj'>} */
    const braceStack = [];
    let i = 0;

    const atLineStart = () => out === '' || out.endsWith('\n');
    const pushIndent = () => { if (atLineStart()) out += INDENT.repeat(Math.max(0, indent)); };
    const newline = () => { out = out.replace(/[ \t]+$/, ''); if (!atLineStart()) out += '\n'; };
    const lastSignificant = () => {
      for (let k = out.length - 1; k >= 0; k--) {
        const ch = out.charAt(k);
        if (!/\s/.test(ch)) return ch;
      }
      return '';
    };
    const lastWord = () => {
      let k = out.length - 1;
      while (k >= 0 && /\s/.test(out.charAt(k))) k--;
      const end = k;
      while (k >= 0 && /[A-Za-z0-9$_]/.test(out.charAt(k))) k--;
      return out.slice(k + 1, end + 1);
    };
    // Copy a quoted string / template verbatim (honouring escapes) so its
    // contents never drive indentation.
    const copyQuoted = (/** @type {string} */ quote) => {
      out += src[i]; i++;
      while (i < n) {
        const ch = src[i];
        out += ch;
        if (ch === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } i++; continue; }
        i++;
        if (ch === quote) break;
      }
    };

    while (i < n) {
      const c = src[i];
      const next = src[i + 1];

      if (c === '/' && next === '/') { // line comment
        pushIndent();
        while (i < n && src[i] !== '\n') { out += src[i]; i++; }
        continue;
      }
      if (c === '/' && next === '*') { // block comment
        pushIndent();
        out += '/*'; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i]; i++; }
        out += '*/'; i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { // string / template literal
        pushIndent();
        copyQuoted(c);
        continue;
      }
      if (c === '/') { // regex vs. division, by the previous token
        const p = lastSignificant();
        if (p === '' || '(,=:[!&|?{};+-*%^~<>'.includes(p)) {
          pushIndent();
          out += '/'; i++;
          let inClass = false;
          while (i < n) {
            const ch = src[i];
            out += ch;
            if (ch === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } i++; continue; }
            if (ch === '[') inClass = true;
            else if (ch === ']') inClass = false;
            else if (ch === '/' && !inClass) { i++; break; }
            i++;
          }
          while (i < n && /[a-z]/i.test(src.charAt(i))) { out += src.charAt(i); i++; } // flags
          continue;
        }
      }

      if (c === '{') {
        const p = lastSignificant();
        const w = lastWord();
        const isObject = EXPR_KEYWORDS.has(w) ? true
          : BLOCK_KEYWORDS.has(w) ? false
            : (!!p && '([,:=?|&!+-*/%^~<'.includes(p));
        pushIndent();
        out += '{';
        if (isObject) {
          braceStack.push('obj');
        } else {
          braceStack.push('block');
          indent++;
          newline();
        }
        i++;
        continue;
      }
      if (c === '}') {
        const kind = braceStack.pop() || 'block';
        if (kind === 'obj') { pushIndent(); out += '}'; i++; continue; }
        newline();
        indent = Math.max(0, indent - 1);
        pushIndent();
        out += '}';
        i++;
        let j = i;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        i = j;
        const rest = src.slice(i);
        if (CLOSE_KEYWORD_RE.test(rest)) {
          out += ' ';
        } else {
          const after = src[i];
          if (after && after !== '\n' && !CLOSE_CONTINUATIONS.includes(after)) newline();
        }
        continue;
      }
      if (c === '(' || c === '[') { pushIndent(); out += c; parenDepth++; i++; continue; }
      if (c === ')' || c === ']') { pushIndent(); out += c; parenDepth = Math.max(0, parenDepth - 1); i++; continue; }
      if (c === ';') {
        pushIndent();
        out += ';';
        i++;
        if (parenDepth === 0) newline();
        continue;
      }

      if (c === '\n' || c === '\r') { i++; continue; }
      if ((c === ' ' || c === '\t') && atLineStart()) { i++; continue; }

      pushIndent();
      out += c;
      i++;
    }

    const result = out
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Guard against a pathological transform (e.g. mismatched quotes swallowing
    // most of the text): fall back to the original rather than show garbage.
    if (!result || result.length < src.trim().length / 2) return src;
    return result;
  } catch {
    return src;
  }
}

export default QueryCodeContextItem;
