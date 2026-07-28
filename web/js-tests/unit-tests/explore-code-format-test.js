//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for ExploreCodeContextItem._prettyPrintCode — the best-effort,
 * dependency-free display formatter for crammed single-line explore_code
 * scripts. It must: leave already-multi-line scripts untouched, break a
 * single-line script into indented statements, keep object-literal args and
 * string/regex content intact, and fall back to the original on anything odd.
 * @module unit-tests/explore-code-format-test
 */

import ExploreCodeContextItem from '../../extensions/juggler-core/context-items/explore-code-context-item.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0; const errors = [];
  const fmt = (s) => ExploreCodeContextItem._prettyPrintCode(s);
  const check = (label, fn) => {
    try { fn(); passed++; } catch (e) { failed++; errors.push(`${label}: ${e.message}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // Already multi-line input is returned byte-for-byte unchanged.
  check('multiline untouched', () => {
    const src = "const a = 1;\nif (a) {\n  return a;\n}";
    assert(fmt(src) === src, `expected identity, got:\n${fmt(src)}`);
  });

  // Trivial one-liners with no structural chars are left alone.
  check('no structure untouched', () => {
    const src = "return grep('foo')";
    assert(fmt(src) === src, `expected identity, got:\n${fmt(src)}`);
  });

  // Non-string / empty inputs are safe no-ops.
  check('non-string safe', () => {
    assert(fmt('') === '', 'empty string should pass through');
    // @ts-expect-error intentional wrong type
    assert(fmt(null) === null, 'null should pass through');
    // @ts-expect-error intentional wrong type
    assert(fmt(undefined) === undefined, 'undefined should pass through');
  });

  // A crammed single line becomes indented statements.
  check('single line expands', () => {
    const out = fmt("const out = []; for (const f of files) { out.push(f); } return out;");
    const lines = out.split('\n');
    assert(lines.length >= 4, `expected multiple lines, got:\n${out}`);
    assert(out.includes('\n  out.push(f);'), `expected indented body, got:\n${out}`);
    assert(/\nreturn out;$/.test(out), `expected return on its own line, got:\n${out}`);
  });

  // Object-literal arguments stay inline (not exploded like a block).
  check('object arg stays inline', () => {
    const out = fmt("const files = await glob('**/*.js', {cwd: projectRoot}); return files;");
    assert(out.includes("{cwd: projectRoot}"), `object arg should stay inline, got:\n${out}`);
    assert(/\nreturn files;$/.test(out), `expected return on own line, got:\n${out}`);
  });

  // A brace inside a string must not trigger a block break.
  check('brace in string ignored', () => {
    const out = fmt("const s = 'a{b}c'; return s;");
    assert(out.includes("'a{b}c'"), `string contents must survive, got:\n${out}`);
    assert(!out.includes("'a{\n"), `must not break inside string, got:\n${out}`);
  });

  // Semicolons inside for(...) headers must not break the line.
  check('for-header semicolons kept', () => {
    const out = fmt("for (let i = 0; i < n; i++) { acc += i; } return acc;");
    assert(out.includes('for (let i = 0; i < n; i++) {'), `for header must stay one line, got:\n${out}`);
  });

  // Regex literal contents (which contain { and /) must be preserved.
  check('regex preserved', () => {
    const out = fmt("const re = /a{2,3}\\/b/g; return re.test(x);");
    assert(out.includes('/a{2,3}\\/b/g'), `regex literal must survive intact, got:\n${out}`);
  });

  // `} else {` continuation stays on one line rather than splitting.
  check('else continuation inline', () => {
    const out = fmt("if (a) { x(); } else { y(); }");
    assert(out.includes('} else {'), `expected '} else {' inline, got:\n${out}`);
  });

  return { passed, failed, errors };
}
