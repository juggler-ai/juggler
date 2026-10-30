//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * File references in a conversation: inline code spans in rendered markdown,
 * and bare paths in text a surface opts in (terminal output, a command line, a
 * plain-text message), that name a file inside the conversation's tree.
 *
 * Deciding that is two questions of very different cost. Whether a span LOOKS
 * like a path is answered here, synchronously, by a few anchored regexes over
 * text marked has already isolated — cheap enough to ask on every re-parse of a
 * streaming reply. Whether the path EXISTS needs the server, so it is never
 * asked per re-parse: see createFileRefResolver, which batches and caches it.
 * @module utils/file-refs
 */

import { fetchExistingPaths } from '../services/completions-api.js';
import { t } from '../../sdk/lib/i18n.js';

/** Longer than this is prose or data in a code span, not a path someone typed. */
const MAX_LEN = 300;

/**
 * A URL scheme, `mailto:` included. Two characters at least before the colon,
 * so a Windows drive letter (`C:`) is not one.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/** A trailing `:line`, `:line:col` or `:line-line`; the capture is the line. */
const LINE_SUFFIX_RE = /:(\d+)(?::\d+|-\d+)?$/;

/** A Windows drive prefix, the one colon a path may keep after its line suffix. */
const DRIVE_RE = /^[a-z]:[\\/]/i;

/**
 * Characters a path in a reply is never written with: whitespace, quotes, glob
 * and shell metacharacters, call parentheses, assignment. Brackets and `@` stay
 * allowed, for route files like `[id].tsx` and scoped package directories.
 */
const NOT_PATH_CHAR_RE = /[\s*?<>|"'`(){}=,;$!#&^%]/;

/** A path with no separator: a name with an extension. */
const BARE_NAME_RE = /^[\w@+-][\w@+.-]*\.([a-z][a-z0-9]*)$/i;

/** A path with no separator: a dotfile, such as `.gitignore`. */
const DOTFILE_RE = /^\.[a-z][\w.-]*$/i;

/**
 * One-letter extensions real files carry. Any other single letter after a dot
 * (`a.b`, `x.y`) is far likelier to be a property access.
 */
const ONE_LETTER_EXTS = new Set(['c', 'h', 'm', 'r', 's', 'd', 'v']);

/**
 * Collapse `.`, `..` and empty segments of a forward-slashed absolute path.
 * `..` never climbs above the first segment (the drive, or the empty segment
 * before a leading `/`); containment in the root is checked afterwards.
 * @param {string} path - Absolute, forward-slashed path.
 * @returns {string} The normalised path, without a trailing slash.
 */
function normalise(path) {
  const parts = path.split('/');
  const head = parts[0];
  /** @type {string[]} */
  const out = [];
  for (const part of parts.slice(1)) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return [head, ...out].join('/');
}

/**
 * Whether the text of an inline code span names a path inside `root`, and if so
 * which. Purely syntactic: whether the file exists is not asked here.
 *
 * A relative path resolves against `root`; an absolute one is kept only when it
 * lies inside it, so a reply's mention of `/etc/hosts` is not offered as a link
 * into the project. A `:line` suffix is split off and returned beside the path.
 * @param {string} text - The code span's text.
 * @param {string} root - Absolute path of the conversation's working tree, in
 *   the platform's own separators; '' when it is not known.
 * @returns {{path: string, line?: number}|null} The absolute path, in the
 *   root's separators, and the line when one was given; null when the text is
 *   not taken for a path inside the root.
 */
export function fileRefCandidate(text, root) {
  if (!root) return null;
  let rest = text.trim();
  if (!rest || rest.length > MAX_LEN || SCHEME_RE.test(rest)) return null;

  /** @type {number|undefined} */
  let line;
  const suffix = LINE_SUFFIX_RE.exec(rest);
  if (suffix) {
    line = Number(suffix[1]);
    rest = rest.slice(0, suffix.index);
  }

  const drive = DRIVE_RE.test(rest);
  if (rest.includes(':', drive ? 2 : 0)) return null;
  if (NOT_PATH_CHAR_RE.test(rest) || rest.startsWith('~')) return null;

  const slashed = rest.replace(/\\/g, '/');
  if (slashed.includes('/')) {
    // Something between the separators has to be a name: rules out `/`, `./`,
    // `//` and the like, and a leading `//` (a comment, or a UNC share).
    if (slashed.startsWith('//') || !/[\w@-]/.test(slashed)) return null;
  } else {
    const ext = BARE_NAME_RE.exec(slashed)?.[1];
    const named = ext ? ext.length > 1 || ONE_LETTER_EXTS.has(ext.toLowerCase()) : DOTFILE_RE.test(slashed);
    if (!named) return null;
  }

  const windows = root.includes('\\') || DRIVE_RE.test(root);
  const base = normalise(root.replace(/\\/g, '/'));
  const absolute = slashed.startsWith('/') || drive;
  const resolved = normalise(absolute ? slashed : `${base}/${slashed}`);

  // A drive-letter tree is case-insensitive; a POSIX one is compared exactly.
  const inside = windows
    ? resolved.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    : resolved.startsWith(`${base}/`);
  if (!inside) return null;

  const path = windows ? resolved.replace(/\//g, '\\') : resolved;
  return line === undefined ? { path } : { path, line };
}

/** Paths per existence request: the check is a GET, and its URL has a length. */
const BATCH_MAX = 50;

/**
 * How long "missing" is believed. A reply often names a file the turn is about
 * to write, so the answer is asked again after this; "present" is kept for the
 * session, since a deleted file costs only a pin that says so.
 */
const MISSING_TTL_MS = 30_000;

/**
 * Wait for more paths before asking. A reply re-rendered from history, or a
 * sealed segment, yields its spans in one pass; this gathers those passes —
 * every message of a conversation opening at once — into one request.
 */
const DEBOUNCE_MS = 100;

/**
 * @typedef {object} FileRefResolver
 * @property {(workspaceId: string, path: string) => boolean|undefined} lookup -
 *   What is known about `path` now: true or false, or undefined when it has not
 *   been asked, is still being asked, or its "missing" answer has expired.
 *   Synchronous, so a re-render can apply a known answer without waiting.
 * @property {(workspaceId: string, paths: string[]) => Promise<void>} request -
 *   Ask about every path not already known or being asked, and settle once all
 *   of `paths` have an answer, or the asking failed. Never rejects.
 */

/**
 * The existence check behind file references, shared by every message.
 *
 * The number of requests follows the number of distinct paths, not the number
 * of renders: marked emits a code span only once its closing backtick has
 * arrived, so every candidate is final, and re-parsing a streaming tail asks
 * about the same paths again — which are known, or already on their way.
 * @param {object} [options] - Seams for tests.
 * @param {(paths: string[], workspaceId?: string) => Promise<Set<string>|null>} [options.fetchExisting]
 *   The server check; null means it could not be made, and nothing is cached.
 * @param {number} [options.debounceMs] - Wait before sending what has queued.
 * @param {() => number} [options.now] - Clock for the missing-path expiry.
 * @returns {FileRefResolver} The resolver.
 */
export function createFileRefResolver(options = {}) {
  const { fetchExisting = fetchExistingPaths, debounceMs = DEBOUNCE_MS, now = Date.now } = options;

  /**
   * Per workspace id ('' is the project): what is known, what is on its way,
   * and what is waiting to be sent.
   * @type {Map<string, {known: Map<string, {exists: boolean, at: number}>, asking: Map<string, Promise<void>>, queue: Map<string, () => void>, timer: ReturnType<typeof setTimeout>|0}>}
   */
  const trees = new Map();

  /**
   * @param {string} workspaceId - The tree.
   * @returns {NonNullable<ReturnType<typeof trees.get>>} Its state, created on first use.
   */
  const tree = (workspaceId) => {
    let state = trees.get(workspaceId);
    if (!state) {
      state = { known: new Map(), asking: new Map(), queue: new Map(), timer: 0 };
      trees.set(workspaceId, state);
    }
    return state;
  };

  /** @param {string} workspaceId - The tree whose queue to send. */
  const flush = async (workspaceId) => {
    const state = tree(workspaceId);
    state.timer = 0;
    const queued = [...state.queue];
    state.queue.clear();
    for (let i = 0; i < queued.length; i += BATCH_MAX) {
      const batch = queued.slice(i, i + BATCH_MAX);
      const paths = batch.map(([path]) => path);
      /** @type {Set<string>|null} */
      let existing = null;
      try {
        existing = await fetchExisting(paths, workspaceId);
      } catch {
        existing = null;
      }
      const at = now();
      for (const [path, settle] of batch) {
        if (existing) state.known.set(path, { exists: existing.has(path), at });
        state.asking.delete(path);
        settle();
      }
    }
  };

  /** @type {FileRefResolver['lookup']} */
  const lookup = (workspaceId, path) => {
    const entry = trees.get(workspaceId)?.known.get(path);
    if (!entry) return undefined;
    if (!entry.exists && now() - entry.at >= MISSING_TTL_MS) return undefined;
    return entry.exists;
  };

  /** @type {FileRefResolver['request']} */
  const request = (workspaceId, paths) => {
    const state = tree(workspaceId);
    /** @type {Promise<void>[]} */
    const waits = [];
    for (const path of paths) {
      if (lookup(workspaceId, path) !== undefined) continue;
      let asking = state.asking.get(path);
      if (!asking) {
        asking = new Promise((settle) => { state.queue.set(path, settle); });
        state.asking.set(path, asking);
      }
      waits.push(asking);
    }
    if (state.queue.size && !state.timer) {
      state.timer = setTimeout(() => { void flush(workspaceId); }, debounceMs);
    }
    return Promise.all(waits).then(() => {});
  };

  return { lookup, request };
}

/** The resolver every surface that decorates file references shares. */
const fileRefResolver = createFileRefResolver();

/** Class a confirmed reference carries; the click handler and CSS key on it. */
export const FILE_REF_CLASS = 'markdown-file-ref';

/** Marks a candidate whose existence is still being asked. */
const PENDING_ATTR = 'data-file-ref-pending';

/**
 * Turn an element into a reference to `path`. It carries `data-file-path`, so
 * the file context menu (properties-panel-helpers.js) offers itself on it too.
 * @param {Element} code - The inline code element, or the span around a bare path.
 * @param {{path: string, line?: number}} ref - What it names.
 */
function markRef(code, ref) {
  code.classList.add(FILE_REF_CLASS);
  code.setAttribute('data-file-path', ref.path);
  if (ref.line !== undefined) code.setAttribute('data-file-line', String(ref.line));
  code.setAttribute('role', 'link');
  code.setAttribute('tabindex', '0');
  code.setAttribute('title', t('Open on the Pinboard'));
}

/**
 * Make the inline code spans in freshly rendered markdown that name an existing
 * file inside `root` into references to it.
 *
 * Meant for a detached holder of one parsed segment (see the `decorate` option
 * of createStreamingMarkdown), so its cost follows the segment, not the reply.
 * A span whose answer is already known is marked at once; one that is not is
 * left as plain code, marked pending, and marked properly when the answer
 * arrives — wherever the element is by then. Fenced code and code inside a link
 * are left alone.
 * @param {ParentNode} holder - Rendered markdown.
 * @param {object} context - The tree the reply is about.
 * @param {string} context.root - Its absolute root; '' when unknown, which
 *   decorates nothing.
 * @param {string} context.workspaceId - Its workspace id, '' for the project.
 * @param {FileRefResolver} [context.resolver] - Where existence is asked.
 * @returns {Promise<void>|null} Settles once every pending span is answered;
 *   null when nothing was left pending.
 */
export function decorateFileRefs(holder, { root, workspaceId, resolver = fileRefResolver }) {
  if (!root) return null;
  /** @type {Array<[Element, {path: string, line?: number}]>} */
  const pending = [];
  for (const code of holder.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const ref = fileRefCandidate(code.textContent || '', root);
    if (!ref) continue;
    const known = resolver.lookup(workspaceId, ref.path);
    if (known === true) markRef(code, ref);
    else if (known === undefined) {
      code.setAttribute(PENDING_ATTR, '');
      pending.push([code, ref]);
    }
  }
  if (!pending.length) return null;

  return resolver.request(workspaceId, pending.map(([, ref]) => ref.path)).then(() => {
    for (const [code, ref] of pending) {
      code.removeAttribute(PENDING_ATTR);
      if (resolver.lookup(workspaceId, ref.path) === true) markRef(code, ref);
    }
  });
}

/**
 * The tree a message's file references resolve in: where its conversation
 * works. Root '' when the message is not yet attached to one, which decorates
 * nothing.
 * @param {{getWorkingRoot?: () => string|null}|null|undefined} messageThread - The
 *   thread the message is shown in.
 * @param {{workspaceId?: string}|null|undefined} conversation - Its conversation.
 * @returns {{root: string, workspaceId: string}} The context for the decorators.
 */
export function fileRefContext(messageThread, conversation) {
  return { root: messageThread?.getWorkingRoot?.() || '', workspaceId: conversation?.workspaceId || '' };
}

/**
 * Attribute opting an element's text into {@link decorateTextFileRefs}. It is
 * the whole contract with code that cannot import this module: a surface marks
 * the text that is worth scanning, and whoever paints it decorates the result.
 */
export const FILE_REFS_ATTR = 'data-file-refs';

/**
 * A path-shaped run of text: an optional drive, path characters, and an
 * optional `:line`, `:line:col` or `:line-line`. Deliberately loose — every
 * match is put to fileRefCandidate, which decides.
 */
const TEXT_TOKEN_RE = /(?:[a-z]:[\\/])?[\w@+./\\-]+(?::\d+(?::\d+|-\d+)?)?/gi;

/**
 * Characters that, just before a token, make it the tail of something that is
 * not a path in the tree: a home directory, a URL's host or port, a variable.
 */
const TOKEN_PREFIX_RE = /[~:$%]/;

/**
 * Distinct unknown paths one scan may ask about. Terminal output can name
 * thousands; the first few hundred are the ones anyone will click.
 */
const TEXT_SCAN_MAX = 200;

/**
 * Turn the bare paths in opted-in text — terminal output, a command line, a
 * message typed as plain text — that name an existing file inside `root` into
 * references to it.
 *
 * Scans the text of every element in `scope` carrying {@link FILE_REFS_ATTR},
 * `scope` included, leaving text already inside a reference alone, so decorating
 * the same element again adds nothing. Each hit is split out of its text node
 * into a span of its own, so the styling around it — an ANSI colour, a
 * highlighted argument — is kept. Paths already answered are applied at once;
 * the rest when their answer arrives, unless the text they were found in has
 * changed or gone by then.
 * @param {ParentNode & Node} scope - What to search for opted-in elements.
 * @param {object} context - The tree the text is about.
 * @param {string} context.root - Its absolute root; '' when unknown, which
 *   decorates nothing.
 * @param {string} context.workspaceId - Its workspace id, '' for the project.
 * @param {FileRefResolver} [context.resolver] - Where existence is asked.
 * @returns {Promise<void>|null} Settles once the asked-about paths are applied;
 *   null when everything was known and applied already.
 */
export function decorateTextFileRefs(scope, { root, workspaceId, resolver = fileRefResolver }) {
  if (!root) return null;
  /** @type {Element[]} */
  const opted = [...scope.querySelectorAll(`[${FILE_REFS_ATTR}]`)];
  if (scope instanceof Element && scope.hasAttribute(FILE_REFS_ATTR)) opted.unshift(scope);
  if (!opted.length) return null;

  /** @type {Array<{node: Text, data: string, hits: Array<{start: number, end: number, ref: {path: string, line?: number}}>}>} */
  const scanned = [];
  /** @type {Set<Text>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const unknown = new Set();
  let allKnown = true;

  for (const el of opted) {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = /** @type {Text|null} */ (walker.nextNode()); node; node = /** @type {Text|null} */ (walker.nextNode())) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.parentElement?.closest(`.${FILE_REF_CLASS}`)) continue;
      const data = node.data;
      const hits = [];
      for (const match of data.matchAll(TEXT_TOKEN_RE)) {
        const start = match.index ?? 0;
        if (start > 0 && TOKEN_PREFIX_RE.test(data[start - 1] || '')) continue;
        let token = match[0];
        if (!LINE_SUFFIX_RE.test(token)) token = token.replace(/\.+$/, '');
        const ref = fileRefCandidate(token, root);
        if (!ref) continue;
        const known = resolver.lookup(workspaceId, ref.path);
        if (known === false) continue;
        if (known === undefined) {
          if (!unknown.has(ref.path) && unknown.size >= TEXT_SCAN_MAX) continue;
          unknown.add(ref.path);
          allKnown = false;
        }
        hits.push({ start, end: start + token.length, ref });
      }
      if (hits.length) scanned.push({ node, data, hits });
    }
  }

  const apply = () => {
    for (const { node, data, hits } of scanned) {
      if (!node.parentNode || node.data !== data) continue;
      // Last hit first, so splitting off the tail leaves the earlier offsets valid.
      for (const { start, end, ref } of [...hits].reverse()) {
        if (resolver.lookup(workspaceId, ref.path) !== true) continue;
        const hit = node.splitText(start);
        hit.splitText(end - start);
        const span = node.ownerDocument.createElement('span');
        /** @type {ParentNode} */ (hit.parentNode).replaceChild(span, hit);
        span.appendChild(hit);
        markRef(span, ref);
      }
    }
  };

  if (allKnown) {
    apply();
    return null;
  }
  return resolver.request(workspaceId, [...unknown]).then(apply);
}
