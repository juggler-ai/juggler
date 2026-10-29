//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * js-deadcode — the JavaScript twin of `make lint-deadcode`: code a root
 * reaches is live, and nothing else is.
 *
 * The roots are everything that loads a module without another module
 * importing it:
 * - the HTML documents: `<script type="module" src>`, the imports of inline
 *   module scripts, and the import maps;
 * - each extension manifest's `provides` globs, read for `default` (a `tests`
 *   module for `runTests` and `needsExclusiveRun`, an `integrationTests`
 *   module for `tests`);
 * - every Go string literal naming a file of the tree (`"/js/engine-app.js"`,
 *   `workerSDKImports`) — a test root when the Go file is a `_test.go`;
 * - the `.d.ts` files tsc includes, judged one declaration at a time: an
 *   ambient module by an import of its name, a global interface's member by a
 *   module naming it;
 * - the public SDK surface, `web/sdk/**`: everything exported there is API a
 *   third-party extension may import, so it is live by definition. That is the
 *   one carve-out, and it is by path.
 *
 * Liveness follows bindings, not just files, as Go's follows functions. A
 * reached module runs its top-level statements, so what they reference is
 * live; a top-level function, class or function-valued const is live when a
 * live binding or an import of its export references it. An import counts
 * only when its binding is live, and a namespace or `import()` result counts
 * for the members read of it (none, when an `import()` is a statement of its own
 * and its result is discarded; all of them, when it is used any other way).
 * Edges are static `import`/`export … from`, `import()`, `new Worker(…)`,
 * `register(…, import.meta.url)` (which reads a loader's hooks),
 * `new URL('…', import.meta.url)`, and the JSDoc types `import('…').Name` and
 * `@import`, which make the type they name live; a `@typedef`'s references
 * count only while it is live. A specifier that is not a literal is evaluated
 * (consts, concatenation, templates, `new URL`, the server's asset prefix and
 * `/worker-module?url=`); one that still cannot be is a finding unless
 * DYNAMIC_IMPORTS says what it loads, and an entry that matches no site is a
 * finding too, as is an import that resolves to no file.
 *
 * Two passes, as for the Go: a production pass from the production roots,
 * following production modules only, and a pass that adds the tests' roots and
 * modules (`web/js-tests/**`, any `_tests/`). They report:
 * - dead files and exports: nothing reaches them, not even a test — delete
 *   them, or, for an export its module's own live code uses, drop `export`;
 * - test-only files and code: only tests reach them — delete them or move them
 *   beside the tests. An export the module's production code also uses is not
 *   test-only: a test importing it is the in-package access a Go test has.
 *   Nor is a test hook as the `test-hooks-in-tests-only` ESLint rule defines
 *   one, an export named `__…`: it ships for tests to turn and that rule keeps
 *   the app off it, so a test is all that may reach it. Unused even by a test,
 *   it is dead like any other export;
 * - test utilities nothing reaches, and their exports no test imports.
 *
 * One check more rides on the same graph, over every module of the tree —
 * production, tests, and the Node tooling (`importsOnly`) whose liveness it
 * does not judge: each name a module imports must be one its target exports.
 * A static `import` (named or default), each member a namespace import reads
 * by name (`ns.x`, `ns['x']` — checked even where the namespace escapes, which
 * makes every export live), an `export … from`, a destructured or member-read
 * `import()` with a literal specifier, and a JSDoc type
 * (`import('…').Name`, `@import`) are followed through re-exports and
 * `export *`; a value import of a name the target declares only as a
 * `@typedef` is one too, since a type has no value. A broken one is reported
 * at its own site, so a re-export of a missing name is found where it is, not
 * at each importer of it. A `.d.ts` or CommonJS target is not judged.
 *
 * Run via `make lint-js-deadcode` (part of `make lint`); exits 1 on any
 * finding. There is no allowlist: a finding is fixed where it is.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import * as eslintScope from 'eslint-scope';

/** @typedef {import('estree').Node & {parent?: AnyNode, [key: string]: unknown}} AnyNode */
/** @typedef {'*'|Set<string>} Names */
/**
 * An edge out of a module. `owner` — `l:<binding>` or `e:<export>` of its own
 * module — makes it conditional on that being live; without one it is the
 * module's top level, live when the module is reached.
 * @typedef {{to: string, names: Names, owner?: string}} Edge
 */
/** @typedef {{file: string, line: number, message: string}} Problem */
/**
 * A name a module imports of another: `type` when only a JSDoc type reads it.
 * @typedef {{to: string, name: string, line: number, type: boolean}} NamedImport
 */
/**
 * A non-literal specifier DYNAMIC_IMPORTS resolves: `file` and `expr` (the
 * specifier's source text) name the site; `targets` are the files it loads
 * (tree paths, or a function of the tree), `names` what it reads of them.
 * @typedef {{file: string, expr: string, targets: string[]|((tree: Tree) => string[]), names: string[]|'*', why: string}} DynamicImport
 */
/**
 * @typedef {object} Config
 * @property {string[]} sources - Directories whose `.js`/`.mjs`/`.d.ts` files are the tree
 * @property {string[]} exclude - Path prefixes left out (vendored code)
 * @property {string[]} [importsOnly] - Directories whose modules are checked only for the names they import: Node tooling, which no root of the tree loads
 * @property {RegExp[]} tests - Paths of test code
 * @property {string[]} publicApi - Path prefixes whose every export is live: the SDK
 * @property {string} serverRoot - The directory a server path (`/js/x.js`) is served from
 * @property {string[]} html - HTML documents
 * @property {string[]} manifests - Extension manifests (`*` matches within one segment)
 * @property {string[]} goDirs - Directories whose Go string literals may name a file
 * @property {string} [jsconfig] - tsconfig-style file whose `paths` map bare specifiers
 * @property {DynamicImport[]} dynamic - Non-literal specifiers and what they load
 */
/**
 * One module: its exports (export name → local binding), re-exports, edges,
 * and how its top-level bindings reference each other.
 * @typedef {object} Module
 * @property {string} rel - Tree path (an inline HTML script's has `#n`)
 * @property {boolean} test - Whether it is test code
 * @property {boolean} public - Whether it is public SDK surface
 * @property {boolean} dts - Whether it is a `.d.ts`
 * @property {boolean} importsOnly - Whether only its imports are checked
 * @property {boolean} cjs - Whether it is CommonJS: no import or export, and `module.exports`
 * @property {NamedImport[]} imports - The names it imports
 * @property {Map<string, {line: number, local?: string, type?: boolean, ambient?: string, member?: string, tag?: boolean}>} exports - Its exports
 * @property {Map<string, {to: string, name: string, line: number}>} reexports - `export … from`
 * @property {string[]} stars - `export * from` sources
 * @property {Edge[]} edges - Its edges
 * @property {Map<string, Set<string>>} deps - Binding → the bindings its declaration references
 * @property {Set<string>} rootRefs - Bindings its top-level code references
 * @property {Map<string, number>} decls - Top-level function/class/variable bindings → line
 * @property {Set<string>} specs - Every specifier it names
 * @property {Set<string>} idents - Every identifier token
 * @property {string[]} strings - Every string and template token
 */
/** @typedef {{file: string, names: Names, test: boolean, why: string}} Root */
/**
 * The module graph of a tree, where liveness starts, and the problems met
 * building it.
 * @typedef {object} Tree
 * @property {string} root - Absolute root of the tree
 * @property {Config} config - Its configuration
 * @property {Map<string, Module>} modules - Tree path → module
 * @property {Root[]} roots - Where liveness starts
 * @property {Problem[]} problems - What could not be followed
 * @property {(tests: boolean) => string[]} manifestModules - The manifests' modules: the tests' entries, or the rest
 * @property {(file: string, key: string) => string[]} jsonPaths - Tree paths a JSON fixture lists under `key`
 */

/** What a manifest's `provides` key's modules are read for; any key not here, `default`. */
const MANIFEST_READS = /** @type {Record<string, string[]>} */ ({
  tests: ['runTests', 'needsExclusiveRun'], // integration-test-executor.js extensionSuiteEntry
  integrationTests: ['tests'], // extensionIntegrationEntries
});
/** `provides` keys that name no module. */
const MANIFEST_NOT_MODULES = new Set(['i18n']);
/** The hooks Node reads of a module given to `module.register`. */
const LOADER_HOOKS = ['initialize', 'resolve', 'load'];
/** Marks an unknown part of an evaluated specifier. */
const UNKNOWN = '\u0001';
/** Marks an evaluated specifier already resolved to a tree path. */
const RESOLVED = '\u0000';
const FUNCTION_LIKE = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression', 'FunctionDeclaration', 'ClassDeclaration']);

/**
 * The non-literal specifiers of this tree, and what each loads. Every one is
 * checked against its site on every run: a site with no entry, or an entry
 * with no site, fails.
 * @type {DynamicImport[]}
 */
const DYNAMIC_IMPORTS = [
  {
    file: 'web/js/utils/asset-url.js', expr: '`/worker-module?url=${encodeURIComponent(resolvedUrl)}`',
    targets: (tree) => tree.manifestModules(false), names: ['default'],
    why: 'the capability loader (base-registry, extensions, sdk/pinboard): the manifests\' modules, already roots',
  },
  {
    file: 'web/js/utils/asset-url.js', expr: 'resolvedUrl',
    targets: (tree) => tree.manifestModules(false), names: ['default'],
    why: 'the capability loader on a page: the manifests\' modules, already roots',
  },
  {
    file: 'web/js/engine-sandbox-worker.mjs', expr: 'url',
    targets: [], names: '*',
    why: 'the sandbox\'s import() of the user\'s own project files: never a module of this tree',
  },
  {
    file: 'web/js/engine-host-node.mjs', expr: 'engineEntry',
    targets: ['web/js/engine-app.js'], names: [],
    why: 'resolved from the engine snapshot\'s root, where engine_snapshot.go writes this file as engine-host.mjs',
  },
  {
    file: 'web/js/workers/diff-worker.js', expr: "new URL('../lib/diff-snapshot.js', scope.location.href).href",
    targets: ['web/js/lib/diff-snapshot.js'], names: '*',
    why: 'a classic worker resolves against its own location, which is this file',
  },
  {
    file: 'web/js-tests/utilities/integration-test-executor.js', expr: 'prefix + entry.path',
    targets: (tree) => tree.manifestModules(true), names: MANIFEST_READS.tests ?? [],
    why: 'the extensions\' unit suites, which /api/test/extension-tests lists from the manifests',
  },
  {
    file: 'web/js-tests/utilities/integration-test-executor.js', expr: 'prefix + path',
    targets: (tree) => tree.manifestModules(true), names: MANIFEST_READS.integrationTests ?? [],
    why: 'the extensions\' integration modules, which /api/test/extension-tests lists from the manifests',
  },
  {
    file: 'web/js-tests/unit-tests/sdk-facade-parity-test.js', expr: 'new URL(`../..${browser}`, import.meta.url).href',
    targets: (tree) => tree.jsonPaths('web/js-tests/fixtures/sdk-worker-twins.json', 'browser'), names: '*',
    why: 'the SDK façades sdk-worker-twins.json lists',
  },
  {
    file: 'web/js-tests/unit-tests/sdk-facade-parity-test.js', expr: 'new URL(`../..${worker}`, import.meta.url).href',
    targets: (tree) => tree.jsonPaths('web/js-tests/fixtures/sdk-worker-twins.json', 'worker'), names: '*',
    why: 'the SDK worker twins sdk-worker-twins.json lists',
  },
  {
    file: 'web/js-tests/utilities/test-scorer.js', expr: 'modulePath',
    targets: (tree) => benchmarkTestModules(tree.root), names: ['runTests'],
    why: 'the scoring.test_module a benchmark task (tests/benchmarks/tasks) names for unit_test or integration_test scoring',
  },
];

/** Where test-scorer.js resolves a benchmark task's `scoring.test_module`, by scoring type. */
const TEST_MODULE_DIRS = { unit_test: 'web/js-tests/unit-tests', integration_test: 'web/js-tests/utilities' };

/**
 * The modules the benchmark tasks have test-scorer.js import: each task JSON
 * under tests/benchmarks/tasks whose scoring type loads a `test_module`.
 * @param {string} root - Absolute root of the tree
 * @returns {string[]} Tree paths
 */
function benchmarkTestModules(root) {
  /** @type {string[]} */ const out = [];
  for (const rel of walkFiles(root, 'tests/benchmarks/tasks')) {
    if (!rel.endsWith('.json')) continue;
    const scoring = JSON.parse(readFileSync(path.join(root, rel), 'utf8')).scoring;
    const dir = scoring && TEST_MODULE_DIRS[/** @type {keyof typeof TEST_MODULE_DIRS} */ (scoring.type)];
    if (dir && typeof scoring.test_module === 'string') out.push(`${dir}/${scoring.test_module}`);
  }
  return out;
}

/**
 * The configuration for this tree.
 * @type {Config}
 */
export const TREE_CONFIG = {
  sources: ['web', 'examples/extensions'],
  exclude: ['web/js/vendor/'],
  importsOnly: ['tooling', 'tests'],
  tests: [/^web\/js-tests\//, /(^|\/)_tests\//],
  publicApi: ['web/sdk/'],
  serverRoot: 'web',
  html: ['web/index.html', 'web/engine.html', 'web/sandbox.html', 'web/machine/index.html', 'web/js-tests/headless-test.html'],
  manifests: ['web/extensions/*/juggler.extension.json', 'examples/extensions/*/juggler.extension.json'],
  goDirs: ['cmd', 'internal', 'web', 'tests'],
  jsconfig: 'tooling/jsconfig.json',
  dynamic: DYNAMIC_IMPORTS,
};

/**
 * Every file under `dir` (a tree path), recursively, as tree paths.
 * @param {string} root - Absolute root of the tree
 * @param {string} dir - Tree path of the directory
 * @returns {string[]} Tree paths
 */
function walkFiles(root, dir) {
  /** @type {string[]} */ const out = [];
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '3rdparty' || e.name.startsWith('.')) continue;
      out.push(...walkFiles(root, rel));
    } else out.push(rel);
  }
  return out;
}

/**
 * Expands a glob whose `*` matches within one path segment.
 * @param {string} root - Absolute root of the tree
 * @param {string} pattern - Tree-path glob
 * @returns {string[]} Matching tree paths
 */
function expandGlob(root, pattern) {
  const segs = pattern.split('/');
  /** @type {string[]} */ let found = [''];
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1;
    const re = new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    /** @type {string[]} */ const next = [];
    for (const base of found) {
      const abs = path.join(root, base);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (!re.test(e.name) || (last ? !e.isFile() : !e.isDirectory())) continue;
        next.push(base ? `${base}/${e.name}` : e.name);
      }
    }
    found = next;
  }
  return found.sort();
}

/**
 * Sets `parent` on every node below `node`.
 * @param {AnyNode} node - The root
 */
function setParents(node) {
  for (const key of espree.VisitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const c of Array.isArray(child) ? child : [child]) {
      if (c && typeof c.type === 'string') { c.parent = node; setParents(c); }
    }
  }
}

/**
 * Calls `visit` on every node below `node`.
 * @param {AnyNode} node - The root
 * @param {(n: AnyNode) => void} visit - The visitor
 */
function walk(node, visit) {
  for (const key of espree.VisitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const c of Array.isArray(child) ? child : [child]) {
      if (c && typeof c.type === 'string') { visit(c); walk(c, visit); }
    }
  }
}

/**
 * The names a binding pattern declares.
 * @param {AnyNode} pattern - An Identifier or destructuring pattern
 * @returns {AnyNode[]} Its identifiers
 */
function patternIds(pattern) {
  switch (pattern.type) {
    case 'Identifier': return [pattern];
    case 'ObjectPattern': return pattern.properties.flatMap((/** @type {AnyNode} */ p) => patternIds(p.type === 'RestElement' ? p.argument : p.value));
    case 'ArrayPattern': return pattern.elements.filter(Boolean).flatMap((/** @type {AnyNode} */ e) => patternIds(e));
    case 'RestElement': return patternIds(pattern.argument);
    case 'AssignmentPattern': return patternIds(pattern.left);
    default: return [];
  }
}

/**
 * @param {AnyNode} n - An Identifier or string Literal (a module export name)
 * @returns {string} The name
 */
const nameOf = (n) => (n.type === 'Identifier' ? n.name : String(n.value));

/**
 * The type names and references a JSDoc comment holds: the `@typedef` /
 * `@callback` names it declares, each `import('…')` / `@import` it makes, and
 * every word (a candidate reference to a typedef of its own module) — each
 * attributed to the typedef whose text it is in.
 * @param {string} text - The comment's text
 * @param {number} line - The line it starts on
 * @returns {{typedefs: {name: string, line: number}[], refs: {spec: string, names: Names, owner?: string, line: number}[], words: {word: string, owner?: string}[]}} What it declares and references
 */
function scanComment(text, line) {
  /** @type {{name: string, line: number, at: number, tag: number}[]} */ const typedefs = [];
  const tag = /@(typedef|callback)\b/g;
  for (let m; (m = tag.exec(text));) {
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] ?? '')) i++;
    if (m[1] === 'typedef' && text[i] === '{') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { i++; break; }
      }
      while (/[\s*]/.test(text[i] ?? '')) i++;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
    if (name) typedefs.push({ name, line: line + text.slice(0, m.index).split('\n').length - 1, at: i, tag: m.index });
  }
  /**
   * The typedef whose text an offset is in: the last one declared before it.
   * @param {number} at - An offset in the comment
   * @returns {string|undefined} Its name; none before the first typedef
   */
  const ownerAt = (at) => {
    let owner;
    for (const t of typedefs) if (t.tag <= at) owner = t.name;
    return owner;
  };
  /** @type {{spec: string, names: Names, owner?: string, line: number}[]} */ const refs = [];
  const lineOf = (/** @type {number} */ at) => line + text.slice(0, at).split('\n').length - 1;
  const imp = /\bimport\(\s*(['"])([^'"]+)\1\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  for (let m; (m = imp.exec(text));) {
    refs.push({ spec: m[2] ?? '', names: m[4] ? new Set([m[4]]) : '*', owner: ownerAt(m.index), line: lineOf(m.index) });
  }
  const tagImport = /@import\s+(\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s+from\s+(['"])([^'"]+)\2/g;
  for (let m; (m = tagImport.exec(text));) {
    const what = m[1] ?? '';
    /** @type {Names} */ let names = '*';
    if (what.startsWith('{')) {
      names = new Set(what.slice(1, -1).split(',').map((s) => s.trim().split(/\s+as\s+/)[0] ?? '').filter(Boolean));
    } else if (!what.startsWith('*')) names = new Set(['default']);
    refs.push({ spec: m[3] ?? '', names, owner: ownerAt(m.index), line: lineOf(m.index) });
  }
  /** @type {{word: string, owner?: string}[]} */ const words = [];
  const word = /[A-Za-z_$][\w$]*/g;
  const defAt = new Set(typedefs.map((t) => t.at));
  for (let m; (m = word.exec(text));) {
    if (defAt.has(m.index)) continue;
    words.push({ word: m[0], owner: ownerAt(m.index) });
  }
  return { typedefs: typedefs.map(({ name, line: l }) => ({ name, line: l })), refs, words };
}

/**
 * The binding a node's code belongs to, as `l:<name>`, or undefined when it
 * runs at module load: the top-level function, class or function-valued
 * variable it is inside. Anything else at the top level runs when the module
 * is loaded, initialisers included.
 * @param {AnyNode} node - Any node of the module
 * @returns {string|undefined} Its owner
 */
function ownerOf(node) {
  let stmt = node;
  while (stmt.parent && stmt.parent.type !== 'Program') stmt = stmt.parent;
  if (!stmt.parent) return undefined;
  let decl = stmt;
  if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) decl = stmt.declaration;
  if (stmt.type === 'ExportDefaultDeclaration') {
    const d = stmt.declaration;
    if (!FUNCTION_LIKE.has(d.type)) return undefined;
    return `l:${d.id?.name ?? 'default'}`;
  }
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') return `l:${decl.id.name}`;
  if (decl.type === 'VariableDeclaration') {
    const d = decl.declarations.find((/** @type {AnyNode} */ x) => x.range[0] <= node.range[0] && node.range[1] <= x.range[1]);
    if (!d || d.id.type !== 'Identifier' || !d.init || !FUNCTION_LIKE.has(d.init.type)) return undefined;
    if (!(d.init.range[0] <= node.range[0] && node.range[1] <= d.init.range[1])) return undefined;
    return `l:${d.id.name}`;
  }
  return undefined;
}

/**
 * Builds the module graph of the tree under `root`.
 * @param {string} root - Absolute root of the tree
 * @param {Config} config - What the tree's roots and conventions are
 * @returns {Tree} The graph, its roots, and the problems met building it
 */
function buildTree(root, config) {
  const isTest = (/** @type {string} */ rel) => config.tests.some((re) => re.test(rel));
  const isPublic = (/** @type {string} */ rel) => config.publicApi.some((p) => rel.startsWith(p));
  const excluded = (/** @type {string} */ rel) => config.exclude.some((p) => rel.startsWith(p));

  /** @type {Set<string>} */ const universe = new Set();
  /** @type {Set<string>} */ const importsOnly = new Set();
  for (const [dirs, only] of /** @type {[string[], boolean][]} */ ([[config.sources, false], [config.importsOnly ?? [], true]])) {
    for (const dir of dirs) {
      for (const rel of walkFiles(root, dir)) {
        if (excluded(rel) || !/\.(m?js|d\.ts)$/.test(rel)) continue;
        universe.add(rel);
        if (only) importsOnly.add(rel);
      }
    }
  }

  /** @type {Problem[]} */ const problems = [];

  // Bare specifiers and server paths, as the type checker maps them.
  /** @type {Map<string, string>} */ const bare = new Map();
  /** @type {Map<string, string>} */ const prefixes = new Map();
  if (config.jsconfig) {
    const jc = JSON.parse(readFileSync(path.join(root, config.jsconfig), 'utf8'));
    const base = path.posix.dirname(config.jsconfig);
    for (const [k, [v]] of Object.entries(jc.compilerOptions?.paths ?? {})) {
      const target = path.posix.normalize(path.posix.join(base, /** @type {string} */ (v)));
      if (k.endsWith('/*')) prefixes.set(k.slice(0, -1), target.slice(0, -1));
      else bare.set(k, target);
    }
  }

  /**
   * A server path with its template prefix (`{{.BasePath}}/v{{.StaticVersion}}`) removed.
   * @param {string} s - A URL as an HTML template writes it
   * @returns {string} The server path
   */
  const untemplate = (s) => s.replace(/^(\{\{[^}]*\}\})+(\/v\{\{[^}]*\}\})?/, '');

  /**
   * Where a specifier leads from `from`.
   * @param {string} spec - The specifier
   * @param {string} from - Tree path of the importing file
   * @returns {{rel?: string, external?: boolean}} The tree path, or external, or neither (unresolved)
   */
  const resolve = (spec, from) => {
    if (spec.startsWith(RESOLVED)) spec = spec.slice(1);
    else {
      const wm = /^\/worker-module\?url=(.*)$/.exec(spec);
      if (wm) spec = decodeURIComponent(wm[1] ?? '');
      spec = spec.replace(/[?#].*$/, '');
      if (spec.startsWith('./') || spec.startsWith('../')) spec = path.posix.join(path.posix.dirname(from), spec);
      else if (spec.startsWith('/')) {
        let mapped;
        for (const [k, v] of prefixes) if (spec.startsWith(k)) mapped = v + spec.slice(k.length);
        spec = mapped ?? path.posix.join(config.serverRoot, spec);
      } else if (bare.has(spec)) spec = /** @type {string} */ (bare.get(spec));
      else if (spec.startsWith('juggler/')) return {};
      else return { external: true };
    }
    spec = path.posix.normalize(spec);
    if (universe.has(spec)) return { rel: spec };
    if (excluded(spec) && existsSync(path.join(root, spec))) return { external: true };
    if (!/\.m?js$/.test(spec) && existsSync(path.join(root, spec))) return { external: true };
    return {};
  };

  /** @type {Map<string, Module>} */ const modules = new Map();
  /** @type {Root[]} */ const roots = [];
  /** @type {Map<string, DynamicImport>} */ const dynamicByKey = new Map();
  for (const d of config.dynamic) dynamicByKey.set(`${d.file}\u0000${d.expr}`, d);
  /** @type {Set<DynamicImport>} */ const dynamicUsed = new Set();
  /** @type {{mod: Module, d: DynamicImport, line: number, owner?: string}[]} */ const dynamicSites = [];

  /**
   * Parses one module (a file, or an HTML document's inline module script).
   * @param {string} rel - Its tree path (an inline script's is the document's, with `#n`)
   * @param {string} source - Its source
   * @param {string} resolveFrom - The tree path its specifiers resolve from
   * @param {boolean} test - Whether it is test code
   * @returns {Module} The module
   */
  const parseModule = (rel, source, resolveFrom, test) => {
    /** @type {Module} */
    const mod = {
      rel, test, public: isPublic(rel), dts: false, importsOnly: importsOnly.has(rel), cjs: false, imports: [],
      exports: new Map(), reexports: new Map(), stars: [], edges: [],
      deps: new Map(), rootRefs: new Set(), decls: new Map(),
      specs: new Set(), idents: new Set(), strings: [],
    };
    /** @type {import('eslint').AST.Program} */ let ast;
    try {
      ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true, comment: true, tokens: true });
    } catch (err) {
      problems.push({ file: rel, line: 0, message: `could not be parsed: ${/** @type {Error} */ (err).message}` });
      return mod;
    }
    setParents(ast);
    for (const t of ast.tokens ?? []) {
      if (t.type === 'Identifier' || t.type === 'Keyword') mod.idents.add(t.value);
      else if (t.type === 'String' || t.type === 'Template') mod.strings.push(t.value);
    }
    const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module', childVisitorKeys: espree.VisitorKeys });
    /** @type {Map<AnyNode, import('eslint').Scope.Reference>} */ const refByIdent = new Map();
    for (const s of scopeManager.scopes) for (const r of s.references) refByIdent.set(r.identifier, r);
    const moduleScope = scopeManager.scopes.find((/** @type {import('eslint').Scope.Scope} */ s) => s.type === 'module');

    /**
     * @param {string|undefined} owner - A binding, `l:<name>`, or none for the top level
     * @param {string} name - The binding it references
     */
    const dep = (owner, name) => {
      if (!owner) { mod.rootRefs.add(name); return; }
      if (owner === `l:${name}`) return;
      let set = mod.deps.get(owner);
      if (!set) mod.deps.set(owner, (set = new Set()));
      set.add(name);
    };

    // Which top-level bindings each binding's code references.
    for (const s of scopeManager.scopes) {
      for (const r of s.references) {
        const v = r.resolved;
        if (!v || v.scope !== moduleScope) continue;
        // A write — a declaration's initialiser included — is not a use.
        if (r.isWrite() && !r.isRead()) continue;
        if (r.identifier.parent?.type === 'ExportSpecifier') continue;
        dep(ownerOf(r.identifier), v.name);
      }
    }
    for (const v of moduleScope?.variables ?? []) {
      const def = v.defs[0];
      if (!def || def.type === 'ImportBinding') continue;
      mod.decls.set(v.name, def.name.loc.start.line);
    }

    /**
     * Adds an edge for a specifier, or a problem when it leads nowhere.
     * @param {string} spec - The specifier
     * @param {Names} names - What is read of the module
     * @param {number} line - Where
     * @param {string} [owner] - What the edge is conditional on
     */
    const edge = (spec, names, line, owner) => {
      mod.specs.add(spec.replace(RESOLVED, ''));
      const r = resolve(spec, resolveFrom);
      if (r.rel) mod.edges.push({ to: r.rel, names, owner });
      else if (!r.external) problems.push({ file: rel, line, message: `'${spec.replace(RESOLVED, '')}' resolves to no file of the tree` });
    };

    /**
     * Records a name imported of the file a specifier leads to, when it leads
     * to one.
     * @param {string} spec - The specifier
     * @param {string} name - The name imported
     * @param {number} line - Where
     * @param {boolean} type - Whether only a JSDoc type reads it
     */
    const named = (spec, name, line, type) => {
      const to = resolve(spec, resolveFrom).rel;
      if (to) mod.imports.push({ to, name, line, type });
    };

    /**
     * The value of a specifier expression, as far as it can be known: UNKNOWN
     * stands for each part that cannot, RESOLVED leads a path already resolved.
     * @param {AnyNode} node - The expression
     * @param {number} depth - Recursion guard
     * @returns {string} Its value
     */
    const evaluate = (node, depth = 0) => {
      if (depth > 8 || !node) return UNKNOWN;
      switch (node.type) {
        case 'Literal': return typeof node.value === 'string' ? node.value : UNKNOWN;
        case 'TemplateLiteral':
          return node.quasis.map((/** @type {AnyNode} */ q, /** @type {number} */ i) => q.value.cooked
            + (i < node.expressions.length ? evaluate(node.expressions[i], depth + 1) : '')).join('');
        case 'BinaryExpression': return node.operator === '+' ? evaluate(node.left, depth + 1) + evaluate(node.right, depth + 1) : UNKNOWN;
        case 'CallExpression':
          if (node.callee.type === 'Identifier' && node.callee.name === 'encodeURIComponent') return evaluate(node.arguments[0], depth + 1);
          return UNKNOWN;
        case 'MemberExpression': {
          if (!node.computed && node.property.name === 'href') {
            const v = evaluate(node.object, depth + 1);
            return v.startsWith(RESOLVED) ? v : UNKNOWN;
          }
          return UNKNOWN;
        }
        case 'NewExpression': {
          const [spec, base] = node.arguments;
          const metaUrl = base?.type === 'MemberExpression' && base.object.type === 'MetaProperty' && base.property.name === 'url';
          if (node.callee.type !== 'Identifier' || node.callee.name !== 'URL' || !metaUrl) return UNKNOWN;
          const v = evaluate(spec, depth + 1);
          if (v.includes(UNKNOWN) || !(v.startsWith('./') || v.startsWith('../'))) return UNKNOWN;
          return RESOLVED + path.posix.join(path.posix.dirname(resolveFrom), v.replace(/[?#].*$/, ''));
        }
        case 'Identifier': {
          const v = refByIdent.get(node)?.resolved;
          if (!v || v.defs.length !== 1) return UNKNOWN;
          const [def] = v.defs;
          if (def.type !== 'Variable' || def.node.id.type !== 'Identifier' || !def.node.init) return UNKNOWN;
          if (def.parent.kind !== 'const' && v.references.some((/** @type {import('eslint').Scope.Reference} */ r) => r.isWrite() && !r.init)) return UNKNOWN;
          return evaluate(def.node.init, depth + 1);
        }
        default: return UNKNOWN;
      }
    };

    /**
     * An evaluated specifier as one `resolve` can follow, or null.
     * @param {string} v - From `evaluate`
     * @returns {string|null} The specifier
     */
    const followable = (v) => {
      if (v.startsWith(RESOLVED)) return v;
      // The server's asset prefix (`${__assetPrefix}/js/x.js`) is the one
      // unknown a specifier may start with: what follows is a server path.
      let s = v.replace(new RegExp(`^${UNKNOWN}+`), '');
      const prefixed = s !== v;
      const wm = /^\/worker-module\?url=(.*)$/.exec(s);
      if (wm) s = decodeURIComponent(wm[1] ?? '');
      // A query or fragment (`?fresh=${Date.now()}`) does not change the file.
      s = s.replace(/[?#].*$/, '');
      if (s.includes(UNKNOWN) || !s) return null;
      if (prefixed && !s.startsWith('/')) return null;
      return s;
    };

    /**
     * @param {AnyNode} m - A MemberExpression on a module namespace
     * @returns {Names} The name it reads
     */
    const memberName = (m) => {
      if (!m.computed) return new Set([m.property.name]);
      if (m.property.type === 'Literal' && typeof m.property.value === 'string') return new Set([m.property.value]);
      return '*';
    };

    /**
     * @param {import('eslint').Scope.Variable} v - A variable bound to a module namespace
     * @returns {Names} The members its references read; all, when used any other way
     */
    const referenceNames = (v) => {
      /** @type {Set<string>} */ const names = new Set();
      for (const r of v.references) {
        if (r.init) continue;
        const id = r.identifier;
        const p = id.parent;
        if (p?.type !== 'MemberExpression' || p.object !== id) return '*';
        const n = memberName(p);
        if (n === '*') return '*';
        for (const x of n) names.add(x);
      }
      return names;
    };

    /**
     * The names a binding of a module namespace reads: a destructuring's
     * keys, or the member accesses of a variable's references.
     * @param {AnyNode} id - The binding pattern
     * @returns {Names} What is read
     */
    const bindingNames = (id) => {
      if (id.type === 'ObjectPattern') {
        /** @type {Set<string>} */ const names = new Set();
        for (const prop of id.properties) {
          if (prop.type === 'RestElement' || prop.computed) return '*';
          names.add(nameOf(prop.key));
        }
        return names;
      }
      if (id.type !== 'Identifier') return '*';
      const v = scopeManager.getDeclaredVariables(id.parent).find((/** @type {import('eslint').Scope.Variable} */ x) => x.name === id.name);
      return v ? referenceNames(v) : '*';
    };

    /**
     * The names read of the module a dynamic import's promise resolves to.
     * @param {AnyNode} node - The ImportExpression
     * @returns {Names} What is read
     */
    const dynamicNames = (node) => {
      const p = node.parent;
      // Loaded for what running it does, its result discarded: nothing is read.
      if (p?.type === 'ExpressionStatement') return new Set();
      if (p?.type === 'AwaitExpression') {
        const q = p.parent;
        if (q?.type === 'ExpressionStatement') return new Set();
        if (q?.type === 'MemberExpression' && q.object === p) return memberName(q);
        if (q?.type === 'VariableDeclarator' && q.init === p) return bindingNames(q.id);
        return '*';
      }
      if (p?.type === 'MemberExpression' && p.object === node && !p.computed && p.property.name === 'then') {
        const cb = p.parent?.type === 'CallExpression' ? p.parent.arguments[0] : null;
        if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && cb.params[0]) return bindingNames(cb.params[0]);
      }
      return '*';
    };

    /**
     * Records a specifier that may not be a literal: evaluated when it can
     * be, else looked up in DYNAMIC_IMPORTS.
     * @param {AnyNode} specNode - The specifier expression
     * @param {Names} names - What is read
     * @param {string} what - The kind of site, for the problem
     */
    const site = (specNode, names, what) => {
      const line = specNode.loc.start.line;
      const owner = ownerOf(specNode);
      const exprText = source.slice(specNode.range[0], specNode.range[1]);
      const d = dynamicByKey.get(`${rel}\u0000${exprText}`);
      if (d) { dynamicUsed.add(d); dynamicSites.push({ mod, d, line, owner }); return; }
      const v = followable(evaluate(specNode));
      if (v !== null) { edge(v, names, line, owner); return; }
      problems.push({ file: rel, line, message: `${what} \`${exprText}\` cannot be resolved: make it a literal, or say what it loads in DYNAMIC_IMPORTS` });
    };

    /**
     * Problem when an `export … from` names no file.
     * @param {AnyNode} stmt - The declaration
     * @returns {string|undefined} The file it re-exports
     */
    const reexportSource = (stmt) => {
      const spec = String(stmt.source.value);
      mod.specs.add(spec);
      const r = resolve(spec, resolveFrom);
      if (!r.rel && !r.external) problems.push({ file: rel, line: stmt.loc.start.line, message: `'${spec}' resolves to no file of the tree` });
      return r.rel;
    };

    for (const stmt of ast.body) {
      const line = stmt.loc.start.line;
      if (stmt.type === 'ImportDeclaration') {
        const spec = String(stmt.source.value);
        if (!stmt.specifiers.length) { edge(spec, new Set(), line); continue; }
        for (const s of stmt.specifiers) {
          const owner = `l:${s.local.name}`;
          if (s.type === 'ImportDefaultSpecifier') {
            edge(spec, new Set(['default']), line, owner);
            named(spec, 'default', line, false);
          } else if (s.type === 'ImportSpecifier') {
            edge(spec, new Set([nameOf(s.imported)]), line, owner);
            named(spec, nameOf(s.imported), line, false);
          } else {
            const v = scopeManager.getDeclaredVariables(s)[0];
            edge(spec, v ? referenceNames(v) : '*', line, owner);
            // Each member read by a name the code spells out must be an
            // export, however else the namespace is used.
            for (const r of v?.references ?? []) {
              const p = r.identifier.parent;
              if (p?.type !== 'MemberExpression' || p.object !== r.identifier) continue;
              const n = memberName(p);
              if (n !== '*') for (const x of n) named(spec, x, p.property.loc.start.line, false);
            }
          }
        }
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration) {
          const d = stmt.declaration;
          const ids = d.type === 'VariableDeclaration' ? d.declarations.flatMap((/** @type {AnyNode} */ x) => patternIds(x.id)) : [d.id];
          for (const id of ids) mod.exports.set(id.name, { line, local: id.name });
        } else if (stmt.source) {
          const to = reexportSource(stmt);
          for (const s of stmt.specifiers) {
            if (!to) continue;
            mod.reexports.set(nameOf(s.exported), { to, name: nameOf(s.local), line });
            mod.imports.push({ to, name: nameOf(s.local), line, type: false });
          }
        } else {
          for (const s of stmt.specifiers) mod.exports.set(nameOf(s.exported), { line, local: nameOf(s.local) });
        }
      } else if (stmt.type === 'ExportAllDeclaration') {
        const to = reexportSource(stmt);
        if (to && stmt.exported) mod.reexports.set(nameOf(stmt.exported), { to, name: '*', line });
        else if (to) mod.stars.push(to);
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const d = stmt.declaration;
        if (d.type === 'Identifier') mod.exports.set('default', { line, local: d.name });
        else if (FUNCTION_LIKE.has(d.type)) {
          mod.exports.set('default', { line, local: d.id?.name ?? 'default' });
          if (!d.id) mod.decls.set('default', line);
        } else mod.exports.set('default', { line });
      }
    }

    walk(ast, (node) => {
      if (node.type === 'ImportExpression') {
        const names = dynamicNames(node);
        site(node.source, names, 'import()');
        // The names a destructuring or a member read takes of the module a
        // specifier that evaluates leads to.
        const spec = followable(evaluate(node.source));
        if (spec !== null && names !== '*') for (const n of names) named(spec, n, node.loc.start.line, false);
      } else if (node.type === 'NewExpression' && node.callee.type === 'Identifier'
        && (node.callee.name === 'Worker' || node.callee.name === 'SharedWorker') && node.arguments[0]) {
        site(node.arguments[0], new Set(), `new ${node.callee.name}()`);
      } else if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL') {
        // A module URL made from this file's own is a reference to that file,
        // whatever is done with it; an import or a worker of it reads more.
        const v = evaluate(node);
        if (v.startsWith(RESOLVED) && /\.m?js$/.test(v)) edge(v, new Set(), node.loc.start.line, ownerOf(node));
      } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'register'
        && node.arguments[1]?.type === 'MemberExpression' && node.arguments[1].object.type === 'MetaProperty') {
        site(node.arguments[0], new Set(LOADER_HOOKS), 'register()');
      }
    });

    /** @type {{word: string, owner?: string}[]} */ const words = [];
    /**
     * The binding a comment's types belong to: that of the code it sits in,
     * or, at the top level, of the declaration it documents.
     * @param {{range: [number, number]}} c - The comment
     * @returns {string|undefined} Its owner; none for top-level code
     */
    const commentOwner = (c) => {
      /** @type {AnyNode} */ let inner = ast;
      for (let descended = true; descended;) {
        descended = false;
        for (const key of espree.VisitorKeys[inner.type] ?? []) {
          for (const ch of [inner[key]].flat()) {
            if (ch?.range && ch.range[0] <= c.range[0] && c.range[1] <= ch.range[1]) { inner = ch; descended = true; break; }
          }
          if (descended) break;
        }
      }
      if (inner !== ast) return ownerOf(inner);
      const next = ast.body.find((/** @type {AnyNode} */ s) => s.range[0] >= c.range[1]);
      if (!next || /\S/.test(source.slice(c.range[1], next.range[0]).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) return undefined;
      const decl = next.declaration ?? next;
      if (decl.type === 'VariableDeclaration') return decl.declarations.length === 1 && decl.declarations[0].init ? ownerOf(decl.declarations[0].init) : undefined;
      return FUNCTION_LIKE.has(decl.type) && decl.id ? `l:${decl.id.name}` : ownerOf(decl);
    };

    for (const c of ast.comments ?? []) {
      if (c.type !== 'Block' || !c.value.startsWith('*')) continue;
      const scan = scanComment(c.value, c.loc.start.line);
      const owner = commentOwner(c);
      for (const t of scan.typedefs) if (!mod.exports.has(t.name)) mod.exports.set(t.name, { line: t.line, local: t.name, type: true });
      for (const r of scan.refs) {
        edge(r.spec, r.names, c.loc.start.line, r.owner ? `l:${r.owner}` : owner);
        if (r.names !== '*') for (const n of r.names) named(r.spec, n, r.line, true);
      }
      words.push(...scan.words.map((w) => ({ word: w.word, owner: w.owner ? `l:${w.owner}` : owner })));
    }
    mod.cjs = !ast.body.some((/** @type {AnyNode} */ s) => s.type.startsWith('Import') || s.type.startsWith('Export')) && /\bmodule\.exports\b/.test(source);
    // A typedef's name in its own module's comments is a use of it.
    const typedefNames = new Set([...mod.exports].filter(([, e]) => e.type).map(([n]) => n));
    for (const w of words) if (typedefNames.has(w.word)) dep(w.owner, w.word);
    return mod;
  };

  for (const rel of [...universe].sort()) {
    const source = readFileSync(path.join(root, rel), 'utf8');
    modules.set(rel, rel.endsWith('.d.ts') ? parseDts(rel, source, isTest(rel), problems, resolve) : parseModule(rel, source, rel, isTest(rel)));
  }

  // HTML documents: module scripts by src, inline module scripts as modules, import maps.
  for (const doc of config.html) {
    // A comment may mention `<script src>`; blanked, keeping the line count.
    const text = readFileSync(path.join(root, doc), 'utf8').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
    const test = isTest(doc);
    let n = 0;
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const attrs = m[1] ?? '';
      const body = m[2] ?? '';
      const type = /\btype\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
      const src = /\bsrc\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
      const line = text.slice(0, m.index).split('\n').length;
      if (type === 'importmap') {
        const map = JSON.parse(body);
        for (const [k, v] of Object.entries(map.imports ?? {})) {
          const r = resolve(untemplate(/** @type {string} */ (v)), doc);
          if (r.rel) roots.push({ file: r.rel, names: new Set(), test, why: `${doc} import map` });
          else problems.push({ file: doc, line, message: `import map entry ${k} resolves to no file of the tree` });
        }
      } else if (type === 'module' && src) {
        const spec = untemplate(src);
        if (spec.startsWith('/wails/')) continue; // the Wails runtime, served by the Go server
        const r = resolve(spec, doc);
        if (r.rel) roots.push({ file: r.rel, names: new Set(), test: test || isTest(r.rel), why: `${doc} <script>` });
        else problems.push({ file: doc, line, message: `<script src="${src}"> resolves to no file of the tree` });
      } else if (type === 'module') {
        const rel = `${doc}#${++n}`;
        const source = '\n'.repeat(line - 1) + body.replace(/(['"])(\{\{[^}]*\}\})+(\/v\{\{[^}]*\}\})?\//g, '$1/');
        modules.set(rel, parseModule(rel, source, doc, test));
        roots.push({ file: rel, names: new Set(), test, why: `${doc} inline module` });
      }
    }
  }

  // Extension manifests.
  /** @type {{file: string, key: string}[]} */ const manifestEntries = [];
  for (const pattern of config.manifests) {
    for (const manifest of expandGlob(root, pattern)) {
      const dir = path.posix.dirname(manifest);
      const provides = JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).provides ?? {};
      for (const [key, value] of Object.entries(provides)) {
        if (MANIFEST_NOT_MODULES.has(key)) continue;
        for (const glob of Array.isArray(value) ? value : [value]) {
          for (const file of expandGlob(root, `${dir}/${glob}`)) {
            manifestEntries.push({ file, key });
            roots.push({ file, names: new Set(MANIFEST_READS[key] ?? ['default']), test: isTest(file) || key in MANIFEST_READS, why: `${manifest} provides.${key}` });
          }
        }
      }
    }
  }

  // Go string literals naming a file of the tree.
  for (const dir of config.goDirs) {
    for (const goFile of walkFiles(root, dir)) {
      if (!goFile.endsWith('.go')) continue;
      const text = readFileSync(path.join(root, goFile), 'utf8');
      const test = goFile.endsWith('_test.go');
      for (const m of text.matchAll(/"([^"\n\\]*\.m?js)"|`([^`\n]*\.m?js)`/g)) {
        const s = m[1] ?? m[2] ?? '';
        const candidates = s.startsWith('/') ? [path.posix.join(config.serverRoot, s)] : [s, path.posix.join(config.serverRoot, s)];
        for (const c of candidates) {
          const rel = path.posix.normalize(c);
          if (universe.has(rel)) { roots.push({ file: rel, names: new Set(), test: test || isTest(rel), why: `${goFile} names it` }); break; }
        }
      }
    }
  }

  // The public SDK surface: every file, every export.
  for (const rel of universe) if (isPublic(rel)) roots.push({ file: rel, names: '*', test: false, why: 'public SDK surface' });

  const tree = {
    root, config, modules, roots, problems,
    /**
     * @param {boolean} tests - The tests' entries, or the rest
     * @returns {string[]} The manifests' modules
     */
    manifestModules: (tests) => manifestEntries.filter((e) => (e.key in MANIFEST_READS) === tests).map((e) => e.file),
    /**
     * Tree paths a JSON fixture lists, as server paths under `key`.
     * @param {string} file - Tree path of the JSON
     * @param {string} key - The field of each listed object
     * @returns {string[]} Tree paths
     */
    jsonPaths: (file, key) => {
      const data = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      /** @type {string[]} */ const out = [];
      const visit = (/** @type {unknown} */ v) => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
          if (typeof v[key] === 'string') {
            const r = resolve(v[key], file);
            if (r.rel) out.push(r.rel);
            else problems.push({ file, line: 0, message: `'${v[key]}' resolves to no file of the tree` });
          }
          Object.values(v).forEach(visit);
        }
      };
      visit(data);
      return out;
    },
  };

  for (const { mod, d, line, owner } of dynamicSites) {
    const targets = typeof d.targets === 'function' ? d.targets(tree) : d.targets;
    for (const t of targets) {
      if (modules.has(t)) mod.edges.push({ to: t, names: d.names === '*' ? '*' : new Set(d.names), owner });
      else problems.push({ file: d.file, line, message: `DYNAMIC_IMPORTS names ${t}, which is no file of the tree` });
    }
  }
  for (const d of config.dynamic) {
    if (!dynamicUsed.has(d)) problems.push({ file: d.file, line: 0, message: `DYNAMIC_IMPORTS entry \`${d.expr}\` matches no site there — remove it` });
  }
  return tree;
}

/**
 * Reads a `.d.ts` file as declarations: each `declare module '…'` block, and
 * each member of a global `interface` (a `Window` property, a custom
 * element's tag). Anything else at its top level is a problem: this check
 * would not know what keeps it live.
 * @param {string} rel - Its tree path
 * @param {string} source - Its text
 * @param {boolean} test - Whether it is test code
 * @param {Problem[]} problems - Where to report
 * @param {(spec: string, from: string) => {rel?: string, external?: boolean}} resolve - The resolver
 * @returns {Module} The module
 */
function parseDts(rel, source, test, problems, resolve) {
  /** @type {Module} */
  const mod = {
    rel, test, public: false, dts: true, importsOnly: false, cjs: false, imports: [],
    exports: new Map(), reexports: new Map(), stars: [], edges: [],
    deps: new Map(), rootRefs: new Set(), decls: new Map(),
    specs: new Set(), idents: new Set(), strings: [],
  };
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
  const lineAt = (/** @type {number} */ i) => text.slice(0, i).split('\n').length;
  /**
   * @param {number} open - Offset of a `{`
   * @returns {number} Offset of its `}`
   */
  const closeOf = (open) => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return i;
    }
    return text.length;
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) { i += ws[0].length; continue; }
    const declMod = /^declare\s+module\s+(['"])([^'"]+)\1\s*\{/.exec(rest);
    const iface = /^interface\s+([\w$]+)\s*\{/.exec(rest);
    if (declMod) {
      mod.exports.set(`module '${declMod[2]}'`, { line: lineAt(i), ambient: declMod[2] });
      i = closeOf(i + declMod[0].length - 1) + 1;
    } else if (iface) {
      const open = i + iface[0].length - 1;
      const end = closeOf(open);
      const body = text.slice(open + 1, end);
      // A member starts a line at the interface's own depth, not inside a
      // nested type or a parameter list.
      /** @type {number[]} */ const depth = [];
      for (let d = 0, k = 0; k < body.length; k++) {
        depth.push(d);
        if ('{(['.includes(body[k] ?? '')) d++;
        else if ('})]'.includes(body[k] ?? '')) d--;
      }
      const member = /^[ \t]*(?:readonly\s+)?(['"]?)([\w$-]+)\1\??\s*[(:]/gm;
      /** @type {{name: string, at: number}[]} */ const members = [];
      for (let m; (m = member.exec(body));) if (depth[m.index] === 0) members.push({ name: m[2] ?? '', at: m.index });
      for (const [k, m] of members.entries()) {
        const name = `${iface[1]}.${m.name}`;
        const line = lineAt(open + 1 + m.at);
        mod.exports.set(name, { line, member: m.name, tag: iface[1] === 'HTMLElementTagNameMap' });
        const seg = body.slice(m.at, members[k + 1]?.at ?? body.length);
        for (const r of seg.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
          const res = resolve(r[2] ?? '', rel);
          if (res.rel) mod.edges.push({ to: res.rel, names: r[4] ? new Set([r[4]]) : '*', owner: `e:${name}` });
          else if (!res.external) problems.push({ file: rel, line, message: `'${r[2]}' resolves to no file of the tree` });
        }
      }
      i = end + 1;
    } else {
      problems.push({ file: rel, line: lineAt(i), message: `a top-level declaration this check cannot judge: ${rest.split('\n')[0]}` });
      const nl = rest.indexOf('\n');
      i += nl > 0 ? nl : rest.length;
    }
  }
  return mod;
}

/**
 * One pass: which files are reached and which exports and bindings are live,
 * from the roots it admits, following the modules it admits. Keys are
 * `e:<export>` (`e:*` for all of them) and `l:<binding>`.
 * @param {Tree} tree - The graph
 * @param {boolean} withTests - Whether the tests' roots and modules count
 * @param {{file: string, name: string}[]} [hooks] - Test hooks a test reads: in
 *   the production pass, the code they reach ships for tests and is not test-only
 * @returns {{reached: Set<string>, live: Map<string, Set<string>>}} What it reaches
 */
function solve(tree, withTests, hooks = []) {
  /** @type {Map<string, Module>} */ const modules = tree.modules;
  /** @type {Set<string>} */ const reached = new Set();
  /** @type {Map<string, Set<string>>} */ const live = new Map();
  /** @type {Array<() => void>} */ const work = [];
  const admits = (/** @type {string} */ rel) => !modules.get(rel)?.importsOnly && (withTests || !modules.get(rel)?.test);
  /**
   * Edges by owner, per module.
   * @type {Map<string, Map<string|undefined, Edge[]>>}
   */
  const byOwner = new Map();
  for (const [rel, mod] of modules) {
    /** @type {Map<string|undefined, Edge[]>} */ const m = new Map();
    for (const e of mod.edges) {
      const list = m.get(e.owner) ?? [];
      list.push(e);
      m.set(e.owner, list);
    }
    byOwner.set(rel, m);
  }

  /** @param {Edge} e - An edge whose source is reached and whose owner is live */
  const follow = (e) => {
    if (!admits(e.to)) return;
    reach(e.to);
    if (e.names === '*') mark(e.to, 'e:*');
    else for (const n of e.names) mark(e.to, `e:${n}`);
  };

  /**
   * @param {string} rel - A file
   * @param {string} key - `e:<export>`, `e:*` or `l:<binding>`
   */
  const mark = (rel, key) => {
    const mod = modules.get(rel);
    if (!mod) return;
    let set = live.get(rel);
    if (!set) live.set(rel, (set = new Set()));
    if (set.has(key)) return;
    set.add(key);
    work.push(() => {
      if (key === 'e:*') {
        for (const n of mod.exports.keys()) mark(rel, `e:${n}`);
        for (const n of mod.reexports.keys()) mark(rel, `e:${n}`);
        for (const s of mod.stars) mark(s, 'e:*');
      } else if (key.startsWith('e:')) {
        const name = key.slice(2);
        const own = mod.exports.get(name);
        const re = mod.reexports.get(name);
        if (own?.local) mark(rel, `l:${own.local}`);
        else if (re) mark(re.to, re.name === '*' ? 'e:*' : `e:${re.name}`);
        else if (!own) for (const s of mod.stars) if (name !== 'default') mark(s, key);
      } else {
        for (const d of mod.deps.get(key) ?? []) mark(rel, `l:${d}`);
      }
      if (reached.has(rel)) for (const e of byOwner.get(rel)?.get(key) ?? []) follow(e);
    });
  };

  /** @param {string} rel - A file a root or an edge reaches */
  const reach = (rel) => {
    if (reached.has(rel) || !admits(rel)) return;
    reached.add(rel);
    const mod = modules.get(rel);
    if (!mod) return;
    work.push(() => {
      // Loading a module loads what it re-exports from.
      for (const re of mod.reexports.values()) reach(re.to);
      for (const s of mod.stars) reach(s);
      for (const r of mod.rootRefs) mark(rel, `l:${r}`);
      if (mod.public) mark(rel, 'e:*');
      for (const [owner, edges] of byOwner.get(rel) ?? []) {
        if (owner === undefined || live.get(rel)?.has(owner)) for (const e of edges) follow(e);
      }
    });
  };

  const drain = () => { while (work.length) /** @type {() => void} */ (work.shift())(); };

  for (const r of tree.roots) {
    if (r.test && !withTests) continue;
    reach(r.file);
    if (r.names === '*') mark(r.file, 'e:*');
    else for (const n of r.names) mark(r.file, `e:${n}`);
  }
  drain();
  for (const h of hooks) if (reached.has(h.file)) mark(h.file, `e:${h.name}`);

  // A .d.ts declaration is live by what the reached modules say, and can
  // reach more modules through its own types, so the two settle together.
  for (let changed = true; changed;) {
    drain();
    changed = false;
    const reachedMods = [...reached].map((r) => modules.get(r)).filter((m) => m && !m.dts);
    for (const mod of modules.values()) {
      if (!mod.dts || !admits(mod.rel)) continue;
      for (const [name, decl] of mod.exports) {
        if (live.get(mod.rel)?.has(`e:${name}`)) continue;
        let used;
        if (decl.ambient) used = reachedMods.some((m) => m?.specs.has(/** @type {string} */ (decl.ambient)));
        else if (decl.tag) {
          const re = new RegExp(`(^|[^\\w-])${String(decl.member).replace(/[$]/g, '\\$')}($|[^\\w-])`);
          used = reachedMods.some((m) => m?.strings.some((s) => re.test(s)));
        } else used = reachedMods.some((m) => m?.idents.has(String(decl.member)));
        if (!used) continue;
        reached.add(mod.rel);
        mark(mod.rel, `e:${name}`);
        changed = true;
      }
    }
  }
  return { reached, live };
}

/**
 * @typedef {object} Findings
 * @property {Problem[]} problems - What the check cannot follow
 * @property {string[]} deadFiles - Files nothing reaches
 * @property {string[]} testOnlyFiles - Production files only tests reach
 * @property {{file: string, line: number, name: string, local: boolean}[]} deadExports - Exports nothing reads; `local` when the module's own live code uses the binding
 * @property {{file: string, line: number, name: string}[]} testOnlyExports - Exports only tests reach
 * @property {{file: string, line: number, name: string, testOnly: boolean}[]} deadBindings - Top-level bindings of reached modules that nothing live references
 * @property {Problem[]} badImports - Imports of a name the target does not export
 */

/**
 * Whether a module exports a name: its own export, a re-export (judged at
 * its own site), or, but for `default`, one of its `export *` sources'.
 * @param {Map<string, Module>} modules - The graph
 * @param {string} rel - The module
 * @param {string} name - The name
 * @param {boolean} type - Whether a typedef will do
 * @param {Set<string>} [seen] - Modules already asked, against `export *` cycles
 * @returns {'yes'|'no'|'type'} Exported; not; or only as a typedef, which `type` refuses
 */
function exportsName(modules, rel, name, type, seen = new Set()) {
  const mod = modules.get(rel);
  if (!mod || mod.dts || mod.cjs) return 'yes';
  if (seen.has(rel)) return 'no';
  seen.add(rel);
  const own = mod.exports.get(name);
  if (own) return own.type && !type ? 'type' : 'yes';
  if (mod.reexports.has(name)) return 'yes';
  /** @type {'no'|'type'} */ let found = 'no';
  if (name !== 'default') {
    for (const s of mod.stars) {
      const r = exportsName(modules, s, name, type, seen);
      if (r === 'yes') return r;
      if (r === 'type') found = r;
    }
  }
  return found;
}

/**
 * Every import of a name its target does not export, in every module.
 * @param {Map<string, Module>} modules - The graph
 * @returns {Problem[]} One per broken name
 */
function badImports(modules) {
  /** @type {Problem[]} */ const out = [];
  for (const [rel, mod] of modules) {
    for (const imp of mod.imports) {
      const r = exportsName(modules, imp.to, imp.name, imp.type);
      if (r === 'yes') continue;
      let message;
      if (r === 'type') message = `\`${imp.name}\` is only a typedef of ${imp.to} — a type has no value to import`;
      else if (imp.type) message = `${imp.to} declares no type \`${imp.name}\``;
      else if (imp.name === 'default') message = `${imp.to} has no default export`;
      else message = `${imp.to} exports no \`${imp.name}\``;
      out.push({ file: rel.replace(/#\d+$/, ''), line: imp.line, message });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Runs both passes over the tree under `root`.
 * @param {string} root - Absolute root of the tree
 * @param {Config} config - Its roots and conventions
 * @returns {Findings} The findings
 */
export function analyse(root, config) {
  const tree = buildTree(root, config);
  const all = solve(tree, true);
  /** Test hooks (`__name` exports of production modules) that some test reads. */
  const hooks = [];
  for (const [rel, mod] of tree.modules) {
    if (mod.test) continue;
    for (const name of mod.exports.keys()) {
      if (name.startsWith('__') && all.live.get(rel)?.has(`e:${name}`)) hooks.push({ file: rel, name });
    }
  }
  const prod = solve(tree, false, hooks);
  /** @type {Findings} */
  const f = { problems: [], deadFiles: [], testOnlyFiles: [], deadExports: [], testOnlyExports: [], deadBindings: [], badImports: badImports(tree.modules) };
  const sorted = /** @type {[string, Module][]} */ ([...tree.modules].sort(([a], [b]) => a.localeCompare(b)));
  for (const [rel, mod] of sorted) {
    if (rel.includes('#') || mod.importsOnly) continue;
    if (!all.reached.has(rel)) { f.deadFiles.push(rel); continue; }
    if (!mod.test && !prod.reached.has(rel)) { f.testOnlyFiles.push(rel); continue; }
    if (mod.public) continue;
    const liveAll = all.live.get(rel) ?? new Set();
    const liveProd = prod.live.get(rel) ?? new Set();
    const isLive = (/** @type {Set<string>} */ set, /** @type {string} */ name) => set.has(`e:${name}`) || set.has('e:*');
    /** Bindings an export's finding already covers. */
    const covered = new Set();
    /** @type {[string, {line: number, local?: string, type?: boolean}][]} */
    const exported = [...mod.exports, ...[...mod.reexports].map(([n, r]) => /** @type {[string, {line: number}]} */ ([n, { line: r.line }]))];
    for (const [name, e] of exported) {
      // Every typedef is exported, so one its own live code uses is simply live.
      if (e.type && liveAll.has(`l:${e.local}`) && (mod.test || liveProd.has(`l:${e.local}`))) continue;
      if (!isLive(liveAll, name)) {
        const local = !!e.local && liveAll.has(`l:${e.local}`);
        f.deadExports.push({ file: rel, line: e.line, name, local });
        if (e.local) covered.add(e.local);
        continue;
      }
      if (mod.test || name.startsWith('__')) continue;
      if (isLive(liveProd, name)) continue;
      // Read only by tests: test-only, unless production code of its own
      // module reaches the binding too.
      if (e.local && liveProd.has(`l:${e.local}`)) continue;
      f.testOnlyExports.push({ file: rel, line: e.line, name });
      if (e.local) covered.add(e.local);
    }
    for (const [name, line] of mod.decls) {
      if (covered.has(name)) continue;
      if (!liveAll.has(`l:${name}`)) f.deadBindings.push({ file: rel, line, name, testOnly: false });
      else if (!mod.test && !liveProd.has(`l:${name}`)) {
        // A binding test-only exports reach is part of their finding.
        f.deadBindings.push({ file: rel, line, name, testOnly: true });
      }
    }
  }
  f.problems = tree.problems.sort((/** @type {Problem} */ a, /** @type {Problem} */ b) => a.file.localeCompare(b.file) || a.line - b.line);
  return f;
}

/**
 * Prints the findings the way `make lint-deadcode` does: a heading per kind,
 * saying what to do, then one line each.
 * @param {Findings} f - The findings
 * @param {(s: string) => void} [write] - Where to print
 * @param {number} [limit] - How many of each kind to print
 * @returns {number} How many there are
 */
export function report(f, write = (s) => process.stdout.write(s), limit = Infinity) {
  const say = (/** @type {string} */ heading, /** @type {string[]} */ lines) => {
    if (!lines.length) return;
    const shown = lines.slice(0, limit);
    const more = lines.length > shown.length ? `  … and ${lines.length - shown.length} more\n` : '';
    write(`js-deadcode: (${lines.length}) ${heading}\n${shown.map((l) => `  ${l}\n`).join('')}${more}`);
  };
  say('these import a name their module does not export, so they fail when it loads — fix each where it is:',
    f.badImports.map((p) => `${p.file}:${p.line}: ${p.message}`));
  say('cannot follow these — fix each where it is:', f.problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ''}: ${p.message}`));
  say('nothing reaches these files, not even a test — delete them:', f.deadFiles);
  say('only tests reach these production files — delete them, or move them beside the tests that use them:', f.testOnlyFiles);
  say('nothing reads these exports, not even a test — delete them (where marked, the module\'s own code uses it: drop only `export`):',
    f.deadExports.map((e) => `${e.file}:${e.line}: ${e.name}${e.local ? '  (drop `export`)' : ''}`));
  say('only tests read these exports — delete them, move them beside the tests, or make a genuine seam a test hook (`__name`):',
    f.testOnlyExports.map((e) => `${e.file}:${e.line}: ${e.name}`));
  say('nothing live references these top-level bindings — delete them:',
    f.deadBindings.filter((b) => !b.testOnly).map((b) => `${b.file}:${b.line}: ${b.name}`));
  say('only test-only code references these top-level bindings — delete or move them with it:',
    f.deadBindings.filter((b) => b.testOnly).map((b) => `${b.file}:${b.line}: ${b.name}`));
  return f.badImports.length + f.problems.length + f.deadFiles.length + f.testOnlyFiles.length + f.deadExports.length
    + f.testOnlyExports.length + f.deadBindings.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const started = Date.now();
  // `--summary[=N]`: each kind's count and its first N findings (default 10).
  const summary = process.argv.find((a) => a.startsWith('--summary'));
  const limit = summary ? Number(summary.split('=')[1] ?? 10) : Infinity;
  const n = report(analyse(root, TREE_CONFIG), undefined, limit);
  if (n) {
    process.stdout.write(`js-deadcode: ${n} finding(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ js-deadcode (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
}
