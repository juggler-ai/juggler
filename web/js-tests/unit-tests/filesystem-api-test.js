//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * FileSystem API Test Suite
 *
 * Comprehensive tests for the FileSystem class (web/js/services/fs.js)
 * and path module (web/js/services/path.js) against the real Go backend.
 *
 * Write operations use a `_fs_test/` subdirectory to avoid polluting the fixture.
 * @module unit-tests/filesystem-api-test
 */

import { assert } from '../utilities/test-helpers.js';
import { FileSystem, ReadOnlyFileSystem, Dirent, Stats, FileSystemError } from '../../js/services/fs.js';
import path from '../../js/services/path.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Helper: assert that an async function throws a FileSystemError with given code.
 * @param {() => Promise<unknown>} fn - Async function to call
 * @param {string} expectedCode - Expected error code (e.g. 'ENOENT')
 * @param {string} msg - Description for assertion messages
 */
async function assertThrowsFsError(fn, expectedCode, msg) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    assert(e instanceof FileSystemError,
      `${msg}: expected FileSystemError, got ${e instanceof Error ? e.constructor.name : typeof e}`);
    assert(/** @type {FileSystemError} */ (e).code === expectedCode,
      `${msg}: expected code ${expectedCode}, got ${/** @type {FileSystemError} */ (e).code}`);
  }
  assert(threw, `${msg}: expected to throw but did not`);
}

/**
 * Run all filesystem API tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const fs = new FileSystem();

  /**
   * Run a single test case.
   * @param {string} name - Test name
   * @param {() => Promise<void>} fn - Test function
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ========================================================================
  // fs.readFile
  // ========================================================================

  await test('readFile: returns string content for existing file', async () => {
    const content = await fs.readFile('src/main.go');
    assert(typeof content === 'string', 'content should be a string');
    assert(content.includes('package main'), 'should contain package declaration');
    assert(content.includes('import "fmt"'), 'should contain import');
    assert(content.includes('func main()'), 'should contain main function');
    assert(content.includes('Hello, World!'), 'should contain Hello World');
    assert(content.includes('func add(a, b int) int'), 'should contain add function');
  });

  await test('readFile: preserves file structure (newlines, indentation)', async () => {
    const content = await fs.readFile('config.json');
    const parsed = JSON.parse(content);
    assert(parsed.name === 'test-project', 'JSON should parse correctly');
    assert(parsed.version === '1.0.0', 'version should match');
    assert(parsed.settings.debug === true, 'nested settings should parse');
    assert(parsed.settings.logLevel === 'info', 'logLevel should match');
  });

  await test('readFile: non-existent file throws ENOENT', async () => {
    await assertThrowsFsError(
      () => fs.readFile('does-not-exist.txt'),
      'ENOENT', 'readFile nonexistent'
    );
  });

  await test('readFile: deeply non-existent path throws ENOENT', async () => {
    await assertThrowsFsError(
      () => fs.readFile('no/such/dir/file.txt'),
      'ENOENT', 'readFile deep nonexistent'
    );
  });

  await test('readFile: offset and limit return partial content', async () => {
    // src/main.go line 5 is "func main() {"
    const content = await fs.readFile('src/main.go', { offset: 5, limit: 3 });
    assert(content.includes('func main()'), 'offset 5 should start at func main');
    // Lines 5-7 should not include line 1
    const lines = content.split('\n');
    assert(!lines[0].includes('package'), 'first returned line should not be package declaration');
  });

  await test('readFile: offset beyond file length returns empty content', async () => {
    // When offset is past EOF, the lineRange exceeds the file — backend may return
    // empty content or an error. Either way, we should handle it gracefully.
    try {
      const content = await fs.readFile('src/main.go', { offset: 9999, limit: 10 });
      // If it returns, content should be empty or very short
      assert(content.length < 50, `expected very short content, got ${content.length} chars`);
    } catch (_e) {
      // Backend error for invalid range is also acceptable
    }
  });

  await test('readFile: limit=1 returns one line of content', async () => {
    const content = await fs.readFile('src/main.go', { offset: 1, limit: 1 });
    assert(content.includes('package main'), 'first line should be package main');
    // Should be just the first line (plus possibly trailing newline)
    assert(!content.includes('import'), 'should not include import line');
  });

  await test('readFile: empty file returns empty string', async () => {
    const content = await fs.readFile('empty.txt');
    assert(content.trim() === '', 'empty file should have no content');
  });

  await test('readFile: large file (>2000 lines) is truncated by backend', async () => {
    // large-file.txt has 2999 lines, backend default limit is 2000
    const content = await fs.readFile('large-file.txt');
    const lines = content.split('\n');
    assert(lines.length <= 2001, `should be truncated, got ${lines.length} lines`);
  });

  await test('readFile: string encoding argument is accepted', async () => {
    // 'utf-8' is the only meaningful encoding but should not crash
    const content = await fs.readFile('src/main.go', 'utf-8');
    assert(content.includes('package main'), 'should still return content');
  });

  // ========================================================================
  // ReadOnlyFileSystem.readFile — raw reads for the explore_code sandbox.
  // Sandboxed code processes files programmatically (JSON.parse, hashing,
  // counting), so it must get the exact bytes, NOT the LLM-context view that
  // truncates long lines at MaxLineLength (appending a "[line truncated: ...]"
  // marker) and caps files at DefaultMaxLines (2000). Reading a minified JSON
  // file the LLM way cuts the single line and appends the marker, so JSON.parse
  // fails at the cut point.
  // ========================================================================

  const rofs = new ReadOnlyFileSystem();

  await test('ReadOnlyFileSystem.readFile: large file (>2000 lines) is NOT truncated', async () => {
    // large-file.txt has 2999 lines. The LLM-facing FileSystem caps it at 2000
    // (asserted above); the sandbox read must return every line.
    const content = await rofs.readFile('large-file.txt');
    const lines = content.split('\n');
    assert(lines.length > 2001, `raw read should return all ~2999 lines, got ${lines.length}`);
  });

  await test('ReadOnlyFileSystem.readFile: minified single-line JSON round-trips (JSON.parse works)', async () => {
    // A minified JSON object whose single line far exceeds MaxLineLength (10000).
    // The LLM read would truncate the line and append a "[line truncated: ...]"
    // marker, so JSON.parse would throw at the cut point. The raw sandbox read
    // must return the exact bytes so the parse succeeds.
    const big = 'z'.repeat(15000);
    const written = JSON.stringify({ data: big, n: 1 });
    assert(written.length > 10000 && !written.includes('\n'), 'fixture should be a long single line');
    await fs.writeFile('_fs_test/minified.json', written);

    const content = await rofs.readFile('_fs_test/minified.json');
    assert(content === written, `raw read must be byte-exact: got ${content.length} chars, want ${written.length}`);
    assert(!content.includes('...'), 'raw read must not inject a truncation ellipsis');
    const parsed = JSON.parse(content); // would throw on truncated content
    assert(parsed.data.length === 15000, 'parsed value should be intact');
    assert(parsed.n === 1, 'parsed trailing field should survive');
  });

  // ========================================================================
  // fs.writeFile
  // ========================================================================

  await test('writeFile: creates new file and readFile confirms', async () => {
    await fs.writeFile('_fs_test/new-file.txt', 'hello world');
    const content = await fs.readFile('_fs_test/new-file.txt');
    assert(content === 'hello world', 'written content should match');
  });

  await test('writeFile: overwrites existing content completely', async () => {
    await fs.writeFile('_fs_test/overwrite.txt', 'aaa');
    await fs.writeFile('_fs_test/overwrite.txt', 'bb');
    const content = await fs.readFile('_fs_test/overwrite.txt');
    assert(content === 'bb', 'should be fully overwritten, not appended');
  });

  await test('writeFile: creates parent directories automatically', async () => {
    await fs.writeFile('_fs_test/auto-mkdir/deep/nested/file.txt', 'deep');
    const content = await fs.readFile('_fs_test/auto-mkdir/deep/nested/file.txt');
    assert(content === 'deep', 'nested file should be readable');
  });

  await test('writeFile: handles empty string content', async () => {
    await fs.writeFile('_fs_test/empty-write.txt', '');
    const content = await fs.readFile('_fs_test/empty-write.txt');
    assert(content === '', 'empty content should round-trip');
  });

  await test('writeFile: handles multi-line content with special chars', async () => {
    const text = 'line 1\nline 2\n\ttabbed\n  spaced\n';
    await fs.writeFile('_fs_test/multiline.txt', text);
    const content = await fs.readFile('_fs_test/multiline.txt');
    assert(content === text, 'multiline content should round-trip exactly');
  });

  await test('writeFile: handles unicode content', async () => {
    const text = 'Hello \u4e16\u754c \ud83c\udf0d';
    await fs.writeFile('_fs_test/unicode.txt', text);
    const content = await fs.readFile('_fs_test/unicode.txt');
    assert(content === text, 'unicode content should round-trip');
  });

  // ========================================================================
  // fs.readdir
  // ========================================================================

  await test('readdir: returns array of name strings by default', async () => {
    const entries = /** @type {string[]} */ (await fs.readdir('src'));
    assert(Array.isArray(entries), 'should return array');
    assert(entries.length > 0, 'should have entries');
    assert(entries.includes('main.go'), 'should contain main.go');
    // Verify all entries are strings
    for (const e of entries) {
      assert(typeof e === 'string', `entry should be string: ${typeof e}`);
    }
  });

  await test('readdir: root directory has expected fixture files', async () => {
    const entries = /** @type {string[]} */ (await fs.readdir('.'));
    assert(entries.includes('src'), 'should have src directory');
    assert(entries.includes('config.json'), 'should have config.json');
    assert(entries.includes('README.md'), 'should have README.md');
  });

  await test('readdir: withFileTypes returns Dirent objects', async () => {
    const entries = /** @type {Dirent[]} */ (await fs.readdir('.', { withFileTypes: true }));
    assert(Array.isArray(entries), 'should return array');
    assert(entries.length > 0, 'should have entries');

    for (const entry of entries) {
      assert(entry instanceof Dirent, `${entry.name}: should be Dirent`);
      assert(typeof entry.name === 'string', 'name should be string');
      assert(typeof entry.isFile() === 'boolean', 'isFile should return boolean');
      assert(typeof entry.isDirectory() === 'boolean', 'isDirectory should return boolean');
      // Mutually exclusive
      assert(entry.isFile() !== entry.isDirectory(),
        `${entry.name}: isFile and isDirectory must be mutually exclusive`);
    }
  });

  await test('readdir: withFileTypes correctly identifies files vs dirs', async () => {
    const entries = /** @type {Dirent[]} */ (await fs.readdir('.', { withFileTypes: true }));
    const srcEntry = entries.find(e => e.name === 'src');
    assert(srcEntry !== undefined, 'should find src entry');
    assert(/** @type {Dirent} */ (srcEntry).isDirectory() === true, 'src should be directory');

    const configEntry = entries.find(e => e.name === 'config.json');
    assert(configEntry !== undefined, 'should find config.json entry');
    assert(/** @type {Dirent} */ (configEntry).isFile() === true, 'config.json should be file');
  });

  await test('readdir: withFileTypes=false returns strings', async () => {
    const entries = await fs.readdir('.', { withFileTypes: false });
    assert(Array.isArray(entries), 'should return array');
    for (const e of entries) {
      assert(typeof e === 'string', `entry should be string, got ${typeof e}`);
    }
  });

  // ========================================================================
  // fs.stat
  // ========================================================================

  await test('stat: file has correct properties', async () => {
    const stats = await fs.stat('src/main.go');
    assert(stats instanceof Stats, 'should return Stats instance');
    assert(stats.isFile() === true, 'isFile should be true');
    assert(stats.isDirectory() === false, 'isDirectory should be false');
    assert(typeof stats.size === 'number', 'size should be number');
    assert(stats.size > 0, 'size should be positive for non-empty file');
  });

  await test('stat: directory has correct properties', async () => {
    const stats = await fs.stat('src');
    assert(stats instanceof Stats, 'should return Stats instance');
    assert(stats.isDirectory() === true, 'isDirectory should be true');
    assert(stats.isFile() === false, 'isFile should be false');
  });

  await test('stat: non-existent path throws ENOENT', async () => {
    await assertThrowsFsError(
      () => fs.stat('nonexistent'),
      'ENOENT', 'stat nonexistent'
    );
  });

  await test('stat: mtime is a valid Date', async () => {
    const stats = await fs.stat('src/main.go');
    assert(stats.mtime instanceof Date, 'mtime should be Date');
    assert(!isNaN(stats.mtime.getTime()), 'mtime should be valid Date');
    assert(typeof stats.mtimeMs === 'number', 'mtimeMs should be number');
    assert(stats.mtimeMs > 0, 'mtimeMs should be positive');
    // mtime and mtimeMs should be consistent
    assert(stats.mtime.getTime() === stats.mtimeMs,
      'mtime.getTime() should equal mtimeMs');
  });

  await test('stat: size matches readFile content length', async () => {
    const stats = await fs.stat('config.json');
    const content = await fs.readFile('config.json');
    // Size is in bytes; for ASCII content, bytes === chars
    assert(stats.size === content.length,
      `stat size (${stats.size}) should match content length (${content.length})`);
  });

  await test('stat: isFile and isDirectory are mutually exclusive', async () => {
    const fileStats = await fs.stat('config.json');
    assert(fileStats.isFile() !== fileStats.isDirectory(), 'file: mutually exclusive');

    const dirStats = await fs.stat('src');
    assert(dirStats.isFile() !== dirStats.isDirectory(), 'dir: mutually exclusive');
  });

  await test('stat: works on newly written file', async () => {
    const text = 'stat test content';
    await fs.writeFile('_fs_test/stat-written.txt', text);
    const stats = await fs.stat('_fs_test/stat-written.txt');
    assert(stats.isFile() === true, 'newly written file isFile');
    assert(stats.size === text.length, 'size matches written content length');
  });

  // ========================================================================
  // fs.access
  // ========================================================================

  await test('access: resolves for existing file', async () => {
    await fs.access('src/main.go');
  });

  await test('access: resolves for existing directory', async () => {
    await fs.access('src');
  });

  await test('access: throws ENOENT for non-existent file', async () => {
    await assertThrowsFsError(
      () => fs.access('nonexistent.txt'),
      'ENOENT', 'access nonexistent file'
    );
  });

  await test('access: throws ENOENT for non-existent directory', async () => {
    await assertThrowsFsError(
      () => fs.access('no/such/dir'),
      'ENOENT', 'access nonexistent dir'
    );
  });

  await test('access: works on newly created file', async () => {
    await fs.writeFile('_fs_test/access-test.txt', 'exists');
    await fs.access('_fs_test/access-test.txt');
  });

  // ========================================================================
  // fs.mkdir
  // ========================================================================

  await test('mkdir: creates a single directory', async () => {
    await fs.mkdir('_fs_test/mkdir-single');
    const stats = await fs.stat('_fs_test/mkdir-single');
    assert(stats.isDirectory(), 'should be a directory');
  });

  await test('mkdir: created directory is listable', async () => {
    await fs.mkdir('_fs_test/mkdir-listable');
    await fs.writeFile('_fs_test/mkdir-listable/child.txt', 'hi');
    const entries = /** @type {string[]} */ (await fs.readdir('_fs_test/mkdir-listable'));
    assert(entries.includes('child.txt'), 'should contain child file');
  });

  await test('mkdir: recursive creates deeply nested directories', async () => {
    await fs.mkdir('_fs_test/mkdir-deep/a/b/c/d', { recursive: true });
    const stats = await fs.stat('_fs_test/mkdir-deep/a/b/c/d');
    assert(stats.isDirectory(), 'deeply nested directory should exist');
  });

  await test('mkdir: non-recursive fails for missing parents', async () => {
    let threw = false;
    try {
      await fs.mkdir('_fs_test/mkdir-nope/x/y/z');
    } catch (_e) {
      threw = true;
    }
    assert(threw, 'should throw for missing parent directories');
  });

  await test('mkdir: recursive with existing intermediate dirs succeeds', async () => {
    await fs.mkdir('_fs_test/mkdir-partial', { recursive: true });
    // Now create deeper with some parents already existing
    await fs.mkdir('_fs_test/mkdir-partial/sub/deep', { recursive: true });
    const stats = await fs.stat('_fs_test/mkdir-partial/sub/deep');
    assert(stats.isDirectory(), 'should create remaining directories');
  });

  // ========================================================================
  // Cross-method integration tests
  // ========================================================================

  await test('integration: write then stat then readdir', async () => {
    await fs.mkdir('_fs_test/integration', { recursive: true });
    await fs.writeFile('_fs_test/integration/a.txt', 'aaa');
    await fs.writeFile('_fs_test/integration/b.txt', 'bbb');

    const stats = await fs.stat('_fs_test/integration');
    assert(stats.isDirectory(), 'should be directory');

    const entries = /** @type {string[]} */ (await fs.readdir('_fs_test/integration'));
    assert(entries.includes('a.txt'), 'should list a.txt');
    assert(entries.includes('b.txt'), 'should list b.txt');
  });

  await test('integration: stat size consistent after write', async () => {
    const content = 'exactly 30 characters in here!';
    await fs.writeFile('_fs_test/exact-size.txt', content);
    const stats = await fs.stat('_fs_test/exact-size.txt');
    assert(stats.size === 30, `size should be 30, got ${stats.size}`);
  });

  await test('integration: access succeeds after mkdir', async () => {
    await fs.mkdir('_fs_test/access-after-mkdir', { recursive: true });
    await fs.access('_fs_test/access-after-mkdir');
  });

  // ========================================================================
  // path module
  // ========================================================================

  await test('path.join: concatenates segments', async () => {
    assert(path.join('a', 'b', 'c') === 'a/b/c', 'basic join');
    assert(path.join('/a', 'b', 'c') === '/a/b/c', 'absolute join');
  });

  await test('path.join: resolves . and ..', async () => {
    assert(path.join('a', '..', 'b') === 'b', '.. goes up');
    assert(path.join('a', '.', 'b') === 'a/b', '. is no-op');
    assert(path.join('/a', 'b', '..', 'c') === '/a/c', '.. in middle');
  });

  await test('path.join: handles empty segments', async () => {
    assert(path.join('a', '', 'b') === 'a/b', 'empty segment skipped');
    assert(path.join('', 'a') === 'a', 'leading empty');
  });

  await test('path.join: multiple .. at start', async () => {
    assert(path.join('..', '..', 'a') === '../../a', 'relative multiple ..');
  });

  await test('path.dirname: extracts directory', async () => {
    assert(path.dirname('/a/b/c') === '/a/b', 'absolute path');
    assert(path.dirname('/a') === '/', 'root child');
    assert(path.dirname('a') === '.', 'relative no dir');
    assert(path.dirname('') === '.', 'empty string');
    assert(path.dirname('a/b') === 'a', 'relative path');
  });

  await test('path.basename: extracts filename', async () => {
    assert(path.basename('/a/b/file.js') === 'file.js', 'absolute');
    assert(path.basename('file.js') === 'file.js', 'just filename');
    assert(path.basename('/a/b/file.js', '.js') === 'file', 'strip ext');
    assert(path.basename('/a/b/file.tar.gz', '.gz') === 'file.tar', 'strip last ext');
    assert(path.basename('/a/b/') === 'b', 'trailing slash');
  });

  await test('path.extname: extracts extension', async () => {
    assert(path.extname('file.js') === '.js', 'simple ext');
    assert(path.extname('file.tar.gz') === '.gz', 'double ext');
    assert(path.extname('file') === '', 'no ext');
    assert(path.extname('.hidden') === '', 'dotfile');
    assert(path.extname('.hidden.txt') === '.txt', 'dotfile with ext');
    assert(path.extname('/a/b/file.css') === '.css', 'with path');
  });

  await test('path.resolve: builds absolute paths', async () => {
    assert(path.resolve('/a', 'b') === '/a/b', 'abs + rel');
    assert(path.resolve('/a', '/b') === '/b', 'later abs wins');
    assert(path.resolve('a', 'b') === '/a/b', 'all relative gets / prefix');
    assert(path.resolve('/a', 'b', '..', 'c') === '/a/c', 'resolve with ..');
  });

  await test('path.relative: computes relative path', async () => {
    assert(path.relative('/a/b', '/a/b/c/d') === 'c/d', 'descend');
    assert(path.relative('/a/b/c', '/a/b') === '..', 'ascend one');
    assert(path.relative('/a/b', '/a/c') === '../c', 'sibling');
    assert(path.relative('/a/b/c', '/a/b/c') === '.', 'same path');
    assert(path.relative('/a/b/c', '/x/y') === '../../../x/y', 'unrelated');
  });

  await test('path.isAbsolute: detects absolute paths', async () => {
    assert(path.isAbsolute('/foo') === true, 'absolute');
    assert(path.isAbsolute('/') === true, 'root');
    assert(path.isAbsolute('foo') === false, 'relative');
    assert(path.isAbsolute('./foo') === false, 'dot relative');
    assert(path.isAbsolute('../foo') === false, 'dotdot relative');
    assert(path.isAbsolute('') === false, 'empty');
  });

  await test('path.normalise: cleans up paths', async () => {
    assert(path.normalise('/a//b/../c') === '/a/c', 'double slash and ..');
    assert(path.normalise('./a/./b') === 'a/b', 'dot segments');
    assert(path.normalise('/a/b/c/../../d') === '/a/d', 'multiple ..');
    assert(path.normalise('///') === '/', 'multiple slashes to root');
    assert(path.normalise('.') === '.', 'dot stays dot');
    assert(path.normalise('') === '.', 'empty becomes dot');
  });

  await test('path.normalize: is alias for normalise', async () => {
    assert(path.normalize === path.normalise, 'normalize should be alias');
  });

  await test('path.sep and path.delimiter', async () => {
    assert(path.sep === '/', 'sep is /');
    assert(path.delimiter === ':', 'delimiter is :');
  });

  // ========================================================================
  // Edge cases: classes
  // ========================================================================

  await test('FileSystemError: has code and message properties', async () => {
    const err = new FileSystemError('ENOENT', 'not found');
    assert(err.code === 'ENOENT', 'code property');
    assert(err.message.includes('ENOENT'), 'message includes code');
    assert(err.message.includes('not found'), 'message includes detail');
    assert(err instanceof Error, 'extends Error');
    assert(err instanceof FileSystemError, 'instanceof FileSystemError');
  });

  await test('FileSystemError: different codes', async () => {
    const e1 = new FileSystemError('EACCES', 'permission denied');
    assert(e1.code === 'EACCES', 'EACCES code');
    const e2 = new FileSystemError('EEXIST', 'already exists');
    assert(e2.code === 'EEXIST', 'EEXIST code');
  });

  await test('Stats: defaults for missing fields', async () => {
    const stats = new Stats({});
    assert(stats.size === 0, 'default size');
    assert(stats.isFile() === false, 'default isFile');
    assert(stats.isDirectory() === false, 'default isDirectory');
    assert(stats.mtimeMs === 0, 'default mtimeMs');
    assert(stats.mtime instanceof Date, 'mtime is still Date');
  });

  await test('Stats: preserves provided fields', async () => {
    const stats = new Stats({ size: 42, modified: 1700000000000, isFile: true, isDirectory: false });
    assert(stats.size === 42, 'size preserved');
    assert(stats.mtimeMs === 1700000000000, 'mtimeMs preserved');
    assert(stats.isFile() === true, 'isFile preserved');
    assert(stats.isDirectory() === false, 'isDirectory preserved');
  });

  await test('Dirent: file entry', async () => {
    const d = new Dirent('readme.md', false);
    assert(d.name === 'readme.md', 'name');
    assert(d.isFile() === true, 'isFile');
    assert(d.isDirectory() === false, 'isDirectory');
  });

  await test('Dirent: directory entry', async () => {
    const d = new Dirent('src', true);
    assert(d.name === 'src', 'name');
    assert(d.isFile() === false, 'isFile');
    assert(d.isDirectory() === true, 'isDirectory');
  });

  return { passed, failed, errors };
}
