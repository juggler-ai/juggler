//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * query_code sandbox worker for the Node engine host — the worker_threads twin
 * of sandbox.html's nested worker.
 *
 * The engine's query_code tool runs untrusted, LLM-authored JavaScript with NO
 * approval gate, so it must be a hard read-only boundary: it may search and read
 * through the injected capabilities (fs/grep/glob, which the main thread
 * services against the read-only, allowed-paths-enforcing filesystem) but must
 * not touch the filesystem or spawn processes directly. In the browser that
 * isolation is an opaque-origin iframe worker; here it is this worker_threads
 * Worker, hardened so user code cannot reach any Node built-in:
 *
 *   - `import()` is rewritten to sandboxImport, which rejects `node:`/built-in
 *     and cross-origin specifiers and resolves project paths to same-origin http
 *     URLs fetched read-only by engine-sandbox-loader-hooks.mjs. The lexer-based
 *     rewrite recognises comments and newlines between `import` and `(`, so no
 *     dynamic-import spelling can bypass it.
 *   - `process`, network APIs, and Node's other direct escape hatches are
 *     removed from the global scope before any user code runs; if `process`
 *     cannot be removed the run fails closed.
 *   - the only channel out is the capability RPC over parentPort; the main
 *     thread terminates this Worker on timeout or abort, giving true hang-parity
 *     with the iframe teardown.
 *
 * All run configuration arrives via workerData; results and capability calls
 * flow over parentPort.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'node:module';

const { origin, token, projectRoot, code: rawCode, timeoutMs, descriptors } = workerData;

// Register the http(s) import loader BEFORE any user import runs, so
// sandboxImport's origin URLs resolve. Runs on a dedicated loader thread.
register('./engine-sandbox-loader-hooks.mjs', import.meta.url, { data: { origin, token } });

/** post one message to the main thread. @param {any} msg */
const post = (msg) => parentPort.postMessage(msg);

// ── POSIX path (pure; mirrors web/js/services/path.js and sandbox.html) ──────
const path = buildPosixPath();

// ── Capability RPC: main thread owns the real fs/grep/glob closures ──────────
let nextId = 0;
/** @type {Map<number, {resolve: Function, reject: Function}>} */
const pending = new Map();
parentPort.on('message', (m) => {
  if (!m || m.kind !== 'reply') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error || 'capability error'));
});

/**
 * Forward one capability call to the main thread and await its reply.
 * @param {string} name - Capability name
 * @param {string} method - Method name ('' for a callable capability)
 * @param {unknown[]} args - Call arguments
 * @returns {Promise<unknown>} The capability's return value
 */
function rpc(name, method, args) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ kind: 'cap', id, name, method, args });
  });
}

/**
 * Resolve a user `import()` specifier to a same-origin http URL and import it,
 * or reject specifiers that would reach a Node built-in or another origin. This
 * is the sole import path for sandboxed code (see the file header).
 * @param {string} spec - The import specifier from user code
 * @returns {Promise<any>} The imported module namespace
 */
function sandboxImport(spec) {
  if (typeof spec !== 'string') return Promise.reject(new Error('import specifier must be a string'));
  if (/^node:/.test(spec) || isBuiltinName(spec)) {
    return Promise.reject(new Error(`import of "${spec}" is not allowed in the query_code sandbox`));
  }
  let url;
  if (/^[a-zA-Z]:[\\/]/.test(spec)) {
    // Windows absolute path: resolve against the origin like any project path.
    url = origin + '/' + spec.replace(/\\/g, '/');
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) {
    // Already has a scheme: only same-origin http(s) is allowed.
    if (!origin || !spec.startsWith(origin)) {
      return Promise.reject(new Error(`cross-origin import is not allowed in the sandbox: ${spec}`));
    }
    url = spec;
  } else if (spec.startsWith('/')) {
    url = origin + spec;
  } else {
    url = origin + '/' + spec.replace(/^\.\//, '');
  }
  return import(url);
}

/** @param {string} spec @returns {boolean} True for a bare Node built-in name. */
function isBuiltinName(spec) {
  return /^(assert|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\/|$)/.test(spec);
}

// ── Bindings injected into user code ─────────────────────────────────────────
/** @type {Record<string, any>} */
const bindings = { path, projectRoot, sandboxImport };
for (const d of descriptors || []) {
  bindings[d.name] = d.callable
    ? (/** @type {unknown[]} */ ...args) => rpc(d.name, '', args)
    : new Proxy({}, {
      get: (_t, /** @type {string} */ method) =>
        (/** @type {unknown[]} */ ...args) => rpc(d.name, method, args),
    });
}
const names = Object.keys(bindings);

// Route user import() through the resolver (workers have no import map; this is
// the runtime analog of the server's static rewrite for module workers). This
// small lexer deliberately skips strings, comments, and template literals while
// accepting every legal trivia spelling between `import` and `(`.
const code = rewriteDynamicImports(String(rawCode));

// Lock out every Node built-in and network escape hatch now that setup is
// complete. If the global `process` cannot be removed, fail closed rather than
// run porously.
if (!neuterEscapeHatches()) {
  post({ kind: 'result', ok: false, error: 'query_code sandbox could not be hardened (process global is not removable)' });
} else {
  captureConsole();
  runUserCode();
}

/**
 * Send the script's console output to the host, a line per call as it is
 * written — so what was printed before a throw, a timeout or a kill has already
 * arrived — capped here so a print loop cannot flood the channel. The format
 * and the caps are sandbox.html's; see `onConsole` in sandbox-runner.js.
 */
function captureConsole() {
  const MAX_LINES = 200;
  const MAX_CHARS = 20000;
  const MAX_LINE_CHARS = 2000;
  let lines = 0;
  let chars = 0;
  let cut = false;
  /** @param {unknown} a @returns {string} */
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  };
  /** @param {string} prefix @returns {(...args: unknown[]) => void} */
  const writer = (prefix) => (...args) => {
    if (cut) return;
    let text = prefix + args.map(fmt).join(' ');
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}…`;
    if (lines >= MAX_LINES || chars + text.length > MAX_CHARS) {
      cut = true;
      post({ kind: 'console', text: `… console output truncated (limit: ${MAX_LINES} lines, ${MAX_CHARS} characters)` });
      return;
    }
    lines++;
    chars += text.length;
    post({ kind: 'console', text });
  };
  const c = /** @type {any} */ (globalThis.console);
  for (const m of ['log', 'info', 'debug', 'trace', 'dir', 'table']) c[m] = writer('');
  c.warn = writer('[warn] ');
  c.error = writer('[error] ');
}

/** Run the compiled user code with an in-worker timeout and report the result. */
function runUserCode() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction(...names, code);
  } catch (err) {
    // Surface SyntaxErrors synchronously (e.g. redeclaring an injected binding)
    // instead of hanging to the timeout.
    post({ kind: 'result', ok: false, error: compileErrMsg(err) });
    return;
  }

  const run = Promise.resolve().then(() => fn(...names.map((n) => bindings[n])));
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  Promise.race([run, timeout]).then(
    (result) => {
      const value = result === undefined ? null : result;
      try {
        post({ kind: 'result', ok: true, result: value });
      } catch (err) {
        // postMessage structured-clones the value; a Promise (or other
        // non-cloneable) throws synchronously. Name the offending path.
        post({ kind: 'result', ok: false, error: returnValueErrMsg(err, value) });
      }
    },
    (err) => post({ kind: 'result', ok: false, error: errMsg(err) })
  );
}

/**
 * Remove Node's built-in-module escape hatches from the global scope. Returns
 * true only when the `process` global is gone afterward.
 * @returns {boolean}
 */
function neuterEscapeHatches() {
  const gt = /** @type {any} */ (globalThis);
  for (const name of [
    'process', 'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest',
    'navigator', 'Worker', 'SharedWorker',
  ]) {
    try { delete gt[name]; } catch { /* fall through to overwrite */ }
    if (gt[name] !== undefined) {
      try { gt[name] = undefined; } catch { /* non-writable */ }
    }
  }
  return gt.process === undefined;
}

/**
 * Rewrite dynamic import expressions outside JavaScript strings, comments, and
 * template literals. `import` may be separated from `(` by any whitespace or
 * comments, all of which are valid ECMAScript trivia. Static imports never occur
 * in AsyncFunction source, so an identifier followed by a parenthesis is the
 * only form that needs rewriting.
 * @param {string} source
 * @returns {string}
 */
function rewriteDynamicImports(source) {
  let out = '';
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === '\'' || c === '"' || c === '`') {
      const end = skipString(source, i, c);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      const next = end < 0 ? source.length : end;
      out += source.slice(i, next);
      i = next;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const next = end < 0 ? source.length : end + 2;
      out += source.slice(i, next);
      i = next;
      continue;
    }
    if (source.startsWith('import', i) && !isIdentifierPart(source[i - 1])) {
      const after = i + 'import'.length;
      const paren = skipTrivia(source, after);
      if (source[paren] === '(') {
        out += 'sandboxImport';
        i = after;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** @param {string | undefined} c */
function isIdentifierPart(c) { return !!c && /[A-Za-z0-9_$]/.test(c); }

/** Skip whitespace and line/block comments. @param {string} s @param {number} i */
function skipTrivia(s, i) {
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '/' && s[i + 1] === '/') {
      const end = s.indexOf('\n', i + 2);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Skip a quoted string or template literal, honouring escapes. @param {string} s @param {number} i @param {string} quote */
function skipString(s, i, quote) {
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === quote) return i + 1;
    i++;
  }
  return i;
}

// ── Error helpers (ported from sandbox.html) ─────────────────────────────────

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return 'sandbox error'; }
}

/**
 * Normalise the engine-specific "already declared" SyntaxError text so the
 * sandbox surfaces one stable message. V8 (Node) says "Identifier 'x' has
 * already been declared"; rewrite it to the wording the browser sandbox emits.
 * @param {unknown} e @returns {string}
 */
function compileErrMsg(e) {
  const m = errMsg(e);
  const v8 = m.match(/Identifier '([^']+)' has already been declared/);
  return v8 ? `Cannot declare a const variable twice: '${v8[1]}'.` : m;
}

/**
 * Walk a value for the first thenable and describe where it sits (e.g. .hits.foo
 * or [0]). Bounded and cycle-safe.
 * @param {unknown} root @returns {string}
 */
function findThenablePath(root) {
  const seen = new Set();
  const stack = [{ v: root, p: '' }];
  let budget = 20000;
  while (stack.length && budget-- > 0) {
    const { v, p } = stack.pop();
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) continue;
    if (typeof (/** @type {any} */ (v)).then === 'function') return p || '(the returned value)';
    if (typeof v === 'function' || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], p: `${p}[${i}]` });
    } else {
      for (const k of Object.keys(v)) stack.push({ v: /** @type {any} */ (v)[k], p: `${p}.${k}` });
    }
  }
  return '';
}

/**
 * Explain a non-cloneable return value — almost always an un-awaited Promise.
 * @param {unknown} e @param {unknown} value @returns {string}
 */
function returnValueErrMsg(e, value) {
  const at = findThenablePath(value);
  if (at) {
    return `Return value ${at} is a Promise that was never awaited. `
      + 'grep(), glob(), fs.*, and import() are async; await them before returning, '
      + 'e.g. return { x: await grep(...) } or await Promise.all([...]).';
  }
  return `Return value could not be serialised: ${errMsg(e)}`;
}

/**
 * Build the pure POSIX path helper exposed to sandboxed code.
 * @returns {Record<string, any>}
 */
function buildPosixPath() {
  const sep = '/';
  const delimiter = ':';
  /** @param {string} p */
  function normalise(p) {
    if (!p) return '.';
    const isAbs = p.startsWith(sep);
    const resolved = [];
    for (const part of p.split(sep)) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
        else if (!isAbs) resolved.push('..');
      } else { resolved.push(part); }
    }
    let result = resolved.join(sep);
    if (isAbs) result = sep + result;
    return result || (isAbs ? sep : '.');
  }
  /** @param {...string} segments */
  function join(...segments) { return normalise(segments.filter(Boolean).join(sep)); }
  /** @param {...string} segments */
  function resolvePath(...segments) {
    let r = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg) continue;
      r = r ? `${seg}${sep}${r}` : seg;
      if (seg.startsWith(sep)) break;
    }
    if (!r.startsWith(sep)) r = sep + r;
    return normalise(r);
  }
  /** @param {string} p */
  function dirname(p) {
    if (!p) return '.';
    const idx = p.lastIndexOf(sep);
    if (idx === -1) return '.';
    if (idx === 0) return sep;
    return p.slice(0, idx);
  }
  /** @param {string} p @param {string} [ext] */
  function basename(p, ext) {
    if (!p) return '';
    let base = p;
    if (base.endsWith(sep)) base = base.slice(0, -1);
    const idx = base.lastIndexOf(sep);
    if (idx !== -1) base = base.slice(idx + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  }
  /** @param {string} p */
  function extname(p) {
    const base = basename(p);
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx <= 0) return '';
    return base.slice(dotIdx);
  }
  /** @param {string} from @param {string} to */
  function relative(from, to) {
    const fromParts = normalise(from).split(sep).filter(Boolean);
    const toParts = normalise(to).split(sep).filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
    const parts = [];
    for (let i = 0; i < fromParts.length - common; i++) parts.push('..');
    parts.push(...toParts.slice(common));
    return parts.join(sep) || '.';
  }
  /** @param {string} p */
  function isAbsolute(p) { return typeof p === 'string' && p.startsWith(sep); }
  return { sep, delimiter, join, resolve: resolvePath, dirname, basename, extname, relative, isAbsolute, normalise, normalize: normalise };
}
