//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * lint-css-in-js — stylelint for the CSS that JavaScript injects.
 *
 * A component that ships its own styles passes them to `injectStylesOnce(id,
 * css)` (web/sdk/lib/inject-styles.js). That CSS is a JS string, so the
 * whole-tree stylelint over CSS_DIRS never sees it. This reads each call's CSS
 * argument out of the source and lints it with stylelint and the SAME config
 * (tooling/.stylelintrc.json), under the JS file's own path, so every rule a
 * sheet is held to — the colour gate among them — holds for it too, and a
 * finding is reported at its line in the JS file.
 *
 * What the CSS argument may be: a string literal, a template literal, or an
 * identifier bound by a `const` in the same file to one of those. Anything else
 * (a call, a concatenation, a parameter) cannot be read without running the
 * code, so it is itself a finding: CSS that cannot be linted is not let in.
 *
 * A template's `${…}` is linted as a placeholder that fits where it stands
 * (see placeholder()) and names no colour, unit or selector a rule could object
 * to, so the lint judges the literal text around it and nothing the expression
 * might produce.
 *
 * Usage (prefer `make lint-css`, and `make lint-files` for a file list):
 *   node tooling/lint-css-in-js.js                 every .js file under CSS_IN_JS_DIRS
 *   node tooling/lint-css-in-js.js web/sdk/x.js …  just these
 *   node tooling/lint-css-in-js.js --fix [files…]   apply stylelint's fixes first (see fixSource)
 * Exit status 1 when anything is reported.
 */

import { log } from 'node:console';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import stylelint from 'stylelint';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const configFile = path.join(here, '.stylelintrc.json');

/** The directories whose JavaScript is searched when no files are named. */
export const CSS_IN_JS_DIRS = ['web/css', 'web/machine', 'web/extensions', 'web/sdk', 'web/js'];

/** Vendored code under those directories, which is not ours to lint. */
const FOREIGN = ['web/js/vendor/'];

/**
 * What a template's `${…}` is linted as, by where it stands: valid CSS of the
 * kind that position takes, and naming nothing a rule could object to.
 *   value                 `var(--js-expr)`, or `1` right before a unit (`${n}rem`)
 *   part of a selector    `_js-expr_` (`.chip-${kind}` → `.chip-_js-expr_`)
 *   a whole selector      `._js-expr_`
 * Anything else — a property name — is `_js-expr_` too, which
 * property-no-unknown refuses: a declaration whose property is not in the
 * source cannot be checked.
 * @param {string} before - The CSS so far.
 * @param {string} after - The template text that follows the `${…}`.
 * @returns {string} The placeholder.
 */
function placeholder(before, after) {
  const head = before.slice(Math.max(before.lastIndexOf('{'), before.lastIndexOf('}'), before.lastIndexOf(';')) + 1);
  const end = after.search(/[{};]/);
  const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
  // A selector runs up to the `{` that opens its block; a declaration ends at
  // a `;` or `}`, and its value is what follows its `:`.
  if (depth === 0 || after[end] === '{') return /(^|[\s,>+~&(])$/.test(before) ? '._js-expr_' : '_js-expr_';
  if (head.includes(':')) return /^[a-z%]/i.test(after) ? '1' : 'var(--js-expr)';
  return '_js-expr_';
}

/** The function whose CSS argument is linted. */
const INJECT = 'injectStylesOnce';

/**
 * One injected stylesheet, as stylelint will see it, and where it sits.
 * @typedef {object} Block
 * @property {string} css - The CSS text, each `${…}` replaced by its placeholder().
 * @property {number[]} at - For each index of css, and one past its end, the
 *   offset in the JS source it came from (see append()); a placeholder's
 *   characters all come from its `${`.
 */

/**
 * A finding, located in the JS file.
 * @typedef {object} Finding
 * @property {number} line - 1-based line.
 * @property {number} column - 1-based column.
 * @property {string} text - What is wrong.
 * @property {string} rule - The stylelint rule, or `lint-css-in-js` for an argument that cannot be read.
 */

/**
 * Every node of a tree, depth first.
 * @param {import('estree').Node} node - The root.
 * @param {(n: import('estree').Node) => void} visit - Called for each node.
 */
function walk(node, visit) {
  visit(node);
  for (const key of espree.VisitorKeys[node.type] ?? []) {
    /** @type {unknown} */
    const child = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[key];
    for (const c of Array.isArray(child) ? child : [child]) {
      if (c && typeof c === 'object' && typeof c.type === 'string') walk(/** @type {import('estree').Node} */ (c), visit);
    }
  }
}

/**
 * Whether a call is to injectStylesOnce, bare or as a member (`ui.injectStylesOnce`).
 * @param {import('estree').CallExpression} call - The call.
 * @returns {boolean} Whether it is.
 */
function isInject(call) {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name === INJECT;
  return callee.type === 'MemberExpression' && !callee.computed
    && callee.property.type === 'Identifier' && callee.property.name === INJECT;
}

/**
 * The injected stylesheets of one JS source, and the calls whose CSS cannot be read.
 * @param {string} source - The JS source.
 * @returns {{blocks: Block[], unreadable: Finding[]}} What it injects.
 */
export function extractStyles(source) {
  const ast = /** @type {import('estree').Program} */ (/** @type {unknown} */ (
    espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true })));
  /** @type {Map<string, import('estree').Expression[]>} */
  const consts = new Map();
  /** @type {import('estree').CallExpression[]} */
  const calls = [];
  walk(ast, (n) => {
    if (n.type === 'VariableDeclaration' && n.kind === 'const') {
      for (const d of n.declarations) {
        if (d.id.type === 'Identifier' && d.init) consts.set(d.id.name, [...(consts.get(d.id.name) ?? []), d.init]);
      }
    }
    if (n.type === 'CallExpression' && isInject(n)) calls.push(n);
  });

  /** @type {Block[]} */
  const blocks = [];
  /** @type {Finding[]} */
  const unreadable = [];
  for (const call of calls) {
    /** @type {import('estree').Node | undefined} */
    let arg = call.arguments[1];
    while (arg?.type === 'Identifier') {
      const bound = consts.get(arg.name);
      arg = bound?.length === 1 ? bound[0] : undefined;
    }
    if (arg?.type === 'TemplateLiteral') {
      /** @type {Block} */
      const block = { css: '', at: [] };
      // A text's range takes in its delimiters: the backtick or `}` before it,
      // and the `${` or backtick after it.
      const last = arg.quasis.length - 1;
      arg.quasis.forEach((q, i) => {
        const [start, end] = /** @type {[number, number]} */ (q.range);
        const from = start + 1;
        const to = end - (i === last ? 1 : 2);
        const text = q.value.cooked ?? q.value.raw;
        if (i > 0) {
          // An expression's placeholder maps to the `${` that opens it.
          const opens = /** @type {[number, number]} */ (arg.quasis[i - 1].range)[1] - 2;
          const p = placeholder(block.css, text);
          block.css += p;
          block.at.push(...Array(p.length).fill(opens));
        }
        append(block, source, text, from, to);
      });
      block.at.push(/** @type {[number, number]} */ (arg.range)[1] - 1);
      blocks.push(block);
    } else if (arg?.type === 'Literal' && typeof arg.value === 'string') {
      const [from, to] = /** @type {[number, number]} */ (arg.range);
      /** @type {Block} */
      const block = { css: '', at: [] };
      append(block, source, arg.value, from + 1, to - 1);
      block.at.push(to - 1);
      blocks.push(block);
    } else {
      const at = /** @type {import('estree').SourceLocation} */ ((call.arguments[1] ?? call).loc).start;
      unreadable.push({
        line: at.line,
        column: at.column + 1,
        rule: 'lint-css-in-js',
        text: `${INJECT}'s CSS must be a string or template literal, or a const in this file bound to one, so lint-css can lint it`,
      });
    }
  }
  return { blocks, unreadable };
}

/** One escape sequence of a string or template literal, at the start of the text. */
const ESCAPE = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/;

/**
 * Add one literal's text to a block, mapping each character to the start of
 * the source that produced it: itself, or the backslash of its escape sequence.
 * @param {Block} block - The block being built.
 * @param {string} source - The whole JS source.
 * @param {string} text - The literal's value.
 * @param {number} from - The source offset of its first character.
 * @param {number} to - The source offset just past its last.
 */
function append(block, source, text, from, to) {
  const start = block.at.length;
  for (let i = from; i < to;) {
    if (source[i] === '\r' && source[i + 1] === '\n') { block.at.push(i); i += 2; continue; }
    const escape = source[i] === '\\' ? ESCAPE.exec(source.slice(i, i + 12)) : null;
    if (!escape) { block.at.push(i); i++; continue; }
    const seq = escape[0];
    // A line continuation produces nothing; an astral \u{…} two UTF-16 units.
    const produced = /^\\[\r\n\u2028\u2029]/.test(seq) ? 0
      : /^\\u\{/.test(seq) && parseInt(seq.slice(3, -1), 16) > 0xFFFF ? 2 : 1;
    for (let k = 0; k < produced; k++) block.at.push(i);
    i += seq.length;
  }
  if (block.at.length - start !== text.length) {
    throw new Error(`lint-css-in-js: mapped ${block.at.length - start} characters of a ${text.length}-character literal at offset ${from}`);
  }
  block.css += text;
}

/**
 * The 1-based line and column of an offset into a text.
 * @param {string} text - The text.
 * @param {number} offset - The offset.
 * @returns {{line: number, column: number}} Where it is.
 */
function position(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}

/**
 * The offset into a text of a 1-based line and column.
 * @param {string} text - The text.
 * @param {number} line - The line.
 * @param {number} column - The column.
 * @returns {number} The offset.
 */
function offsetOf(text, line, column) {
  let offset = 0;
  for (let l = 1; l < line; l++) offset = text.indexOf('\n', offset) + 1;
  return Math.min(offset + column - 1, text.length);
}

/**
 * Lint the CSS one JS source injects, with the repo's stylelint config.
 * @param {string} source - The JS source.
 * @param {string} file - Its path, absolute or relative to the repo root; the config's per-path overrides see this.
 * @returns {Promise<Finding[]>} What is wrong, in file order.
 */
export async function lintSource(source, file) {
  const { blocks, unreadable } = extractStyles(source);
  const findings = [...unreadable];
  for (const block of blocks) {
    const { results: [res] } = await stylelint.lint({
      code: block.css, codeFilename: path.resolve(repo, file), configFile,
    });
    for (const w of [...res.invalidOptionWarnings.map((o) => ({ ...o, line: 1, column: 1, rule: 'config' })), ...res.warnings]) {
      const { line, column } = position(source, block.at[offsetOf(block.css, w.line ?? 1, w.column ?? 1)]);
      findings.push({ line, column, rule: w.rule, text: w.text });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Apply stylelint's fixes to the CSS one JS source injects. Only a block whose
 * CSS is its source text verbatim — no `${}`, no escape sequence, no CRLF — is
 * written back, as a plain replacement of that text; any other block is left
 * for `lintSource` to report. Nothing a fix writes can end the literal early:
 * stylelint's fixes add no backtick, `${`, quote or backslash.
 * @param {string} source - The JS source.
 * @param {string} file - Its path, absolute or relative to the repo root.
 * @returns {Promise<string>} The source with its fixable blocks fixed.
 */
export async function fixSource(source, file) {
  const { blocks } = extractStyles(source);
  let out = source;
  // Last block first, so each replacement leaves the earlier offsets valid.
  for (const block of [...blocks].sort((a, b) => b.at[0] - a.at[0])) {
    const start = block.at[0];
    const verbatim = block.css.length > 0 && block.at.every((at, i) => at === start + i)
      && source.slice(start, start + block.css.length) === block.css && !block.css.includes('\r');
    if (!verbatim) continue;
    const res = await stylelint.lint({
      code: block.css, codeFilename: path.resolve(repo, file), configFile, fix: true,
    });
    if (typeof res.code !== 'string' || /[`\\]|\$\{/.test(res.code) !== /[`\\]|\$\{/.test(block.css)) continue;
    out = out.slice(0, start) + res.code + out.slice(start + block.css.length);
  }
  return out;
}

/**
 * Whether a file is one this check lints: a .js file under CSS_IN_JS_DIRS, vendored code aside.
 * @param {string} rel - Its repo-relative path, forward-slashed.
 * @returns {boolean} Whether it is.
 */
export function inScope(rel) {
  return rel.endsWith('.js') && CSS_IN_JS_DIRS.some((d) => rel.startsWith(`${d}/`))
    && !FOREIGN.some((f) => rel.startsWith(f));
}

/**
 * Every file in scope, repo-relative.
 * @returns {string[]} The files, sorted.
 */
function filesInScope() {
  /** @type {string[]} */
  const out = [];
  for (const dir of CSS_IN_JS_DIRS) {
    for (const entry of readdirSync(path.join(repo, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = path.relative(repo, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      if (inScope(rel)) out.push(rel);
    }
  }
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fix = process.argv[2] === '--fix';
  const named = process.argv.slice(fix ? 3 : 2);
  // Named files (how lint-files calls it) are narrowed to the same scope the
  // whole-tree run covers, so both reach the same verdict for any file.
  const files = named.length > 0
    ? named.map((f) => path.relative(repo, path.resolve(repo, f)).split(path.sep).join('/')).filter(inScope)
    : filesInScope();
  let count = 0;
  for (const file of files) {
    let source = readFileSync(path.resolve(repo, file), 'utf8');
    if (!source.includes(INJECT)) continue;
    if (fix) {
      const fixed = await fixSource(source, file);
      if (fixed !== source) writeFileSync(path.resolve(repo, file), fixed);
      source = fixed;
    }
    for (const f of await lintSource(source, file)) {
      log(`${file}:${f.line}:${f.column}: ${f.text}${f.text.includes(`(${f.rule})`) ? '' : ` (${f.rule})`}`);
      count++;
    }
  }
  if (count > 0) {
    log(`lint-css-in-js: ${count} problem(s) in CSS passed to ${INJECT}()`);
    process.exit(1);
  }
}
