//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Command-oriented bash highlighting unit tests.
 * @module unit-tests/bash-highlight-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { highlightCode } = await import('../../../sdk/lib/syntax-highlight.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {string} command
   * @returns {HTMLElement} A `<code>` element containing the highlighted command.
   */
  const render = (command) => {
    const code = document.createElement('code');
    code.innerHTML = highlightCode(command, 'bash');
    return code;
  };

  run('splits compound commands into coloured sections and operators', () => {
    const el = render('cd foo && make test && make build');
    assert(el.querySelectorAll('.bash-command-segment').length === 3, 'expected three command segments');
    assert(el.querySelectorAll('.bash-command-operator').length === 2, 'expected two operators');
    assert(el.querySelectorAll('.bash-command-head').length === 3, 'expected three command heads');
    assert([...el.querySelectorAll('.bash-command-head')].map(n => n.textContent).join(',') === 'cd,make,make', 'wrong command heads');
    assert(el.textContent === 'cd foo && make test && make build', 'render changed visible text');
  });

  run('renders command head more specifically than its arguments', () => {
    const el = render('git help branch');
    assert(el.querySelector('.bash-command-head')?.textContent === 'git', 'git should be command head');
    assert([...el.querySelectorAll('.bash-command-arg')].map(n => n.textContent).join('') === 'helpbranch', 'args should be highlighted separately');
  });

  run('does not split operators inside quoted strings', () => {
    const el = render('echo "a && b | c" && cat out.txt');
    assert(el.querySelectorAll('.bash-command-segment').length === 2, 'quoted operators should not split segments');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only top-level && should be an operator');
    assert(el.textContent === 'echo "a && b | c" && cat out.txt', 'render changed visible text');
  });

  run('highlights redirection operators and targets', () => {
    const el = render('make test > result.log');
    assert(el.querySelector('.bash-command-redirect-operator')?.textContent === '>', 'redirection operator not marked');
    assert(el.querySelector('.bash-command-redirect-target')?.textContent === 'result.log', 'redirection target not marked');
  });

  run('keeps command substitutions within their containing segment', () => {
    const el = render('echo $(printf "a && b") && wc -l');
    assert(el.querySelectorAll('.bash-command-segment').length === 2, 'substitution operator should stay inside segment');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only outer && should split');
  });

  run('keeps compact file descriptor duplication as command text', () => {
    const el = render('make test 2>&1 | tee build.log');
    assert(el.querySelectorAll('.bash-command-operator').length === 1, 'only the pipe should split the command');
    assert(el.textContent === 'make test 2>&1 | tee build.log', 'render changed visible text');
    assert(el.querySelector('.bash-command-arg')?.textContent === 'test', 'arguments should still be styled normally');
  });

  run('escapes unsafe HTML while highlighting', () => {
    const el = render('echo <script>alert(1)</script>');
    assert(el.querySelector('script') === null, 'unsafe script element was created');
    assert(el.textContent === 'echo <script>alert(1)</script>', 'visible text should preserve escaped shell text');
    assert(el.querySelectorAll('.bash-command-operator').length === 4, 'angle brackets should be shell operators');
  });

  run('treats a here-doc body as inert text, not shell syntax', () => {
    const cmd = [
      "cat > out.mjs <<'EOF'",
      "import { register } from 'node:module';",
      "console.log('registered ok');",
      'EOF',
      'node out.mjs 2>&1'
    ].join('\n');
    const el = render(cmd);
    // The whole body up to and including the closing delimiter is one inert block.
    const bodies = [...el.querySelectorAll('.bash-command-heredoc')];
    assert(bodies.length === 1, 'here-doc body should be a single inert block');
    assert(bodies[0]?.textContent === "import { register } from 'node:module';\nconsole.log('registered ok');\nEOF",
      'here-doc body (with closing delimiter) should be captured verbatim');
    // Body words must NOT be styled as commands; only cat/node are heads.
    assert([...el.querySelectorAll('.bash-command-head')].map(n => n.textContent).join(',') === 'cat,node',
      'only cat and node should be command heads');
    assert(el.textContent === cmd, 'render changed visible text');
  });

  run('resumes normal parsing after the here-doc terminator', () => {
    const el = render('cat <<EOF\nbody line\nEOF\necho done');
    assert(el.querySelector('.bash-command-heredoc')?.textContent === 'body line\nEOF', 'body should stop at the terminator');
    assert([...el.querySelectorAll('.bash-command-head')].map(n => n.textContent).join(',') === 'cat,echo',
      'echo after the terminator should be a command head');
  });

  run('does not treat the <<< here-string as a here-doc', () => {
    const el = render('grep x <<< "a && b"');
    assert(el.querySelectorAll('.bash-command-heredoc').length === 0, 'here-string is not a here-doc body');
    assert(el.querySelector('.bash-command-head')?.textContent === 'grep', 'grep should still be the command head');
  });

  run('consumes multiple queued here-doc bodies on one line', () => {
    const el = render('cat <<A <<B\nbody a; x > y\nA\nbody b | z\nB\necho done');
    const bodies = [...el.querySelectorAll('.bash-command-heredoc')];
    assert(bodies.length === 1, 'both bodies are consumed as one contiguous inert block');
    assert(bodies[0]?.textContent === 'body a; x > y\nA\nbody b | z\nB', 'both bodies through their terminators are inert');
    assert([...el.querySelectorAll('.bash-command-head')].map(n => n.textContent).join(',') === 'cat,echo',
      'operators inside the bodies must not create command heads');
  });

  // === formatCommandForDisplay: newline-splitting for the properties panel ===

  const ExecuteContextItem = (await import('../context-items/execute-context-item.js')).default;
  const { formatCommandForDisplay, stripLeadingProjectCd } = await import('../context-items/execute-context-item.js');

  /**
   * @param {string} label
   * @param {string} input
   * @param {string} expected
   */
  const check = (label, input, expected) => {
    run(label, () => {
      const got = formatCommandForDisplay(input);
      assert(got === expected, `input ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    });
  };

  // `&&` — newline goes BEFORE the operator, so it starts the continuation line.
  check('&& splits with newline before the operator',
    'cd /foo && cat bar', 'cd /foo\n&& cat bar');
  check('multiple && operators each start a new line',
    'a && b && c', 'a\n&& b\n&& c');

  // `;` — newline goes AFTER the operator, so the `;` stays at end of its line.
  check('; splits with newline after the operator',
    'make build; rm bar', 'make build;\nrm bar');
  check('multiple ; operators end their respective lines',
    'a; b; c', 'a;\nb;\nc');

  // `&&` and `;` can mix freely in the same command.
  check('mixed && and ; split at the right place for each',
    'cd /foo && cat bar; rm baz', 'cd /foo\n&& cat bar;\nrm baz');
  check('mixed ; and &&',
    'a; b && c', 'a;\nb\n&& c');

  // Operators inside quoted strings must NOT split.
  check('quoted && is not split',
    'echo "a && b"', 'echo "a && b"');
  check('quoted ; is not split',
    "echo 'a; b'", "echo 'a; b'");
  check('quoted && after a real && still splits only the real one',
    'echo "x && y" && cat out', 'echo "x && y"\n&& cat out');

  // A command with no top-level operator is returned unchanged.
  check('plain command is unchanged',
    'echo hello world', 'echo hello world');
  check('pipe-only command is unchanged',
    'make test 2>&1 | tail -40', 'make test 2>&1 | tail -40');

  // A trailing operator leaves an empty segment that is dropped.
  check('trailing && is dropped',
    'pwd &&', 'pwd');
  check('trailing ; is dropped',
    'pwd;', 'pwd');

  // === stripLeadingProjectCd: tile-only removal of a redundant leading `cd` ===

  const PROJECT = '/Users/dev/code/myapp';
  const HOME = '/Users/dev';

  /**
   * @param {string} label
   * @param {string} input
   * @param {string} expected
   * @param {{cwd?: string, home?: string, platform?: string}} [opts]
   */
  const tile = (label, input, expected, opts = { cwd: PROJECT, home: HOME }) => {
    run(label, () => {
      const got = stripLeadingProjectCd(input, opts);
      assert(got === expected, `input ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    });
  };

  // A `cd` to the project dir itself is a no-op — drop it and its operator.
  tile('drops a leading cd to the project directory',
    `cd ${PROJECT} && make check`, 'make check');
  tile('drops it with a trailing slash on the target',
    `cd ${PROJECT}/ && make check`, 'make check');
  tile('drops a quoted target',
    `cd "${PROJECT}" && ls`, 'ls');
  tile('drops a single-quoted target',
    `cd '${PROJECT}' && ls`, 'ls');
  tile('drops a ~-form target',
    'cd ~/code/myapp && ls', 'ls');
  tile('drops a relative no-op target',
    'cd . && ls', 'ls');
  tile('drops it regardless of spacing around the operator',
    `cd ${PROJECT}&&ls`, 'ls');
  tile('leaves the rest of the chain intact',
    `cd ${PROJECT} && make check && make build`, 'make check && make build');

  // Anything that actually moves the shell is information — keep it.
  tile('keeps a cd to a subdirectory',
    'cd juggler && make test', 'cd juggler && make test');
  tile('keeps a cd outside the project',
    'cd /tmp && ls', 'cd /tmp && ls');
  tile('keeps a cd whose target is an expansion',
    'cd "$PROJECT" && ls', 'cd "$PROJECT" && ls');
  tile('keeps a cd joined by ; rather than &&',
    `cd ${PROJECT}; ls`, `cd ${PROJECT}; ls`);
  tile('keeps a cd in a later segment',
    `make build && cd ${PROJECT} && ls`, `make build && cd ${PROJECT} && ls`);
  tile('keeps a command that merely starts with cd-like text',
    'cdk deploy && ls', 'cdk deploy && ls');
  tile('keeps everything when the project directory is unknown',
    `cd ${PROJECT} && ls`, `cd ${PROJECT} && ls`, { cwd: '', home: HOME });

  run('tile summary drops the redundant cd while the panel keeps it', () => {
    const command = `cd ${PROJECT} && make check`;
    // Bare stand-ins: the tile reads only the conversation's session paths.
    const item = new ExecuteContextItem(/** @type {import('juggler/context-item').ItemContext} */ ({
      id: 'bash-highlight-test-execute',
      session: {},
      conversation: { session: { projectPath: PROJECT, home: HOME, platform: 'darwin' } },
      messageThread: {}
    }));
    /** @type {import('../../../js/services/action-executor.js').ActionStatusSuccess} */
    const status = { actionId: 'execute', success: true, result: { exitCode: 0 }, formatted: { summary: '', success: true } };
    const ui = item.getStatusUI(status, { command });
    const summary = ui?.summary;
    const text = typeof summary === 'string' ? summary : (summary?.textContent || '');
    assert(text === 'make check', `tile summary should drop the cd, got ${JSON.stringify(text)}`);
    // The properties panel renders the command in full, cd included.
    assert(formatCommandForDisplay(command) === `cd ${PROJECT}\n&& make check`,
      'properties panel must show the command unchanged');
  });

  return { passed, failed, errors };
}
