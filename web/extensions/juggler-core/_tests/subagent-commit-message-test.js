//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the hidden `subagent-commit-message` strategy: a run that writes a
 * commit message for staged changes, with nobody attending and nothing but
 * read-only tools. Its `bash` is a whitelist enforced by `refuseToolCall`, so
 * most of what is here is that whitelist — the commands it must let through
 * for the job, and the ones that would write, publish or escape it.
 * @module _tests/subagent-commit-message-test
 */

import { initializeRegistries, assert } from '../../../js-tests/utilities/test-helpers.js';
import strategyRegistry from '../../../js/registries/strategy-registry.js';
import { generateToolDefinitions } from '../../../js/services/tool-generator.js';
import { APPROVAL_POLICY } from '../../../sdk/strategy-type.js';
import { INTERACTION_KIND } from '../../../sdk/context-item.js';
import CommitMessageSubagentStrategyType from '../strategies/subagent-commit-message-strategy-type.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

// Only the fields StrategyType's constructor dereferences.
const FAKE_MESSAGE_THREAD = /** @type {any} */ ({ conversation: { session: {} } });

/** Commands the run needs, which must get through. */
const ALLOWED = [
  'git diff --cached',
  'git diff --cached --stat',
  'git --no-pager diff --cached -- web/js/app.js',
  'git -C juggler diff --cached',
  'git -C "my repo" --no-pager log --oneline -20',
  'git log -5 --format=%s',
  'git show HEAD~1 --stat',
  'git status --short',
  'git blame -L 10,20 web/js/app.js',
  'git ls-files web/js',
  'git rev-parse --abbrev-ref HEAD',
  'git branch',
  'git branch --list',
  'git branch -a',
  'git tag -l',
  'git tag --list v1.*',
  'git log --oneline | head -20',
  'git diff --cached --name-only | wc -l',
  'git log -3 && git status',
  'git log -1 || git status',
  'git status; git diff --cached',
  'git log --format=%s -20\ngit diff --cached --stat',
  'cat README.md',
  'head -50 CHANGELOG.md',
  'tail -n 20 CHANGELOG.md',
  'ls -la web',
  'grep -rn "foo" web/js',
  'rg -n "a|b" web',
  "sed -n '1,40p' web/js/app.js",
  "awk '{print $1}' file.txt",
  'git log --format=%an | sort | uniq -c',
  'git log --grep="a > b"',
  "grep -n 'x && y; z' file.txt"
];

/**
 * Commands that must be refused, each with a fragment the refusal must name.
 * @type {Array<[string, string]>}
 */
const REFUSED = [
  ['git push origin main', 'git push origin main'],
  ['git commit -m "x"', 'git commit'],
  ['git checkout main', 'git checkout main'],
  ['git branch -D topic', 'git branch -D topic'],
  ['git branch newbranch', 'git branch newbranch'],
  ['git tag v9.9.9', 'git tag v9.9.9'],
  ['git -C juggler push', 'git -C juggler push'],
  ['git -C', 'git -C'],
  ['git', 'git'],
  ['rm -rf build', 'rm -rf build'],
  ['git status && rm -rf .git', 'rm -rf .git'],
  ['git log | sh', 'sh'],
  ['git log; curl https://example.com', 'curl https://example.com'],
  ['git log || git push', 'git push'],
  ['git diff --cached > out.txt', '>'],
  ['git log >> out.txt', '>'],
  ['cat < secret', '<'],
  ['cat $(git rev-parse --show-toplevel)/README', '$('],
  ['cat `pwd`/README', '`'],
  ['sed -i s/a/b/ file.txt', 'sed -i s/a/b/ file.txt'],
  ['sed s/a/b/ file.txt', 'sed s/a/b/ file.txt'],
  ["awk 'BEGIN { system(\"rm x\") }'", 'system'],
  ['git status &', 'git status &'],
  ['env git log', 'env git log'],
  ['FOO=1 git log', 'FOO=1 git log'],
  ['git diff --cached --output=patch.txt', '--output=patch.txt'],
  ['git -c core.pager=sh log', 'git -c core.pager=sh log'],
  ['sort -o out.txt in.txt', 'sort -o out.txt in.txt'],
  ['rg --pre ./x foo', 'rg --pre ./x foo'],
  ["sed -n 's/a/b/w out.txt' file.txt", 'sed -n'],
  ["awk '{ print > \"out.txt\" }' file.txt", 'awk']
];

/**
 * Run the commit-message strategy tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test name, used in the failure message
   * @param {() => void|Promise<void>} fn - The test body
   * @returns {Promise<void>} Resolves once the case has been recorded
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await initializeRegistries();
  const strategy = new CommitMessageSubagentStrategyType({ messageThread: FAKE_MESSAGE_THREAD });
  /**
   * @param {string} command - A bash command
   * @returns {string} The strategy's refusal, or ''
   */
  const refuse = (command) => strategy.refuseToolCall({ toolName: 'bash', toolInput: { command }, category: 'write' });

  await run('is hidden and registered', () => {
    const { id, hidden } = CommitMessageSubagentStrategyType.MANIFEST;
    assert(id === 'subagent-commit-message', `id = ${id}`);
    assert(hidden === true, 'the strategy must be hidden');
    assert(strategyRegistry.has(id), `${id} must be registered`);
    assert(!strategyRegistry.getAllManifests().some(m => m.id === id),
      `${id} must not appear in a user-facing strategy list`);
  });

  await run('filters to read, grep, glob and bash', async () => {
    const allTools = /** @type {import('../../../sdk/strategy-type.js').ToolDefinition[]} */ (await generateToolDefinitions());
    const names = strategy.filterTools(allTools).map((/** @type {{name: string}} */ t) => t.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(['bash', 'glob', 'grep', 'read']),
      `expected exactly bash, glob, grep, read; got ${names.join(', ')}`);
  });

  for (const command of ALLOWED) {
    await run(`allows ${JSON.stringify(command)}`, () => {
      const reason = refuse(command);
      assert(reason === '', `expected no refusal, got ${reason}`);
    });
  }

  for (const [command, named] of REFUSED) {
    await run(`refuses ${JSON.stringify(command)}`, () => {
      const reason = refuse(command);
      assert(reason !== '', 'expected a refusal');
      assert(reason.includes(named), `the refusal should name ${JSON.stringify(named)}, got ${reason}`);
    });
  }

  await run('refuses an empty or missing command', () => {
    assert(refuse('') !== '', 'an empty command must be refused');
    assert(strategy.refuseToolCall({ toolName: 'bash', toolInput: {}, category: 'write' }) !== '',
      'a missing command must be refused');
  });

  await run('lets its read tools through and refuses any other tool', () => {
    for (const toolName of ['read', 'grep', 'glob']) {
      const reason = strategy.refuseToolCall({ toolName, toolInput: {}, category: 'read' });
      assert(reason === '', `${toolName} should not be refused, got ${reason}`);
    }
    assert(strategy.refuseToolCall({ toolName: 'write', toolInput: {}, category: 'write' }) !== '',
      'a tool outside the four must be refused');
  });

  await run('approves read tools and whitelisted bash, and nothing else', () => {
    /**
     * @param {string} toolName - Tool
     * @param {Record<string, unknown>} toolInput - Input
     * @param {string} category - Category
     * @returns {string} The policy
     */
    const policy = (toolName, toolInput, category) => strategy.getApprovalPolicy({
      toolName, toolInput, category, defaultApproval: true,
      interactionKind: INTERACTION_KIND.GATE, autoApprovable: true
    });
    for (const toolName of ['read', 'grep', 'glob']) {
      assert(policy(toolName, {}, 'read') === APPROVAL_POLICY.APPROVE, `${toolName} must be approved`);
    }
    assert(policy('bash', { command: 'git diff --cached' }, 'write') === APPROVAL_POLICY.APPROVE,
      'whitelisted bash must be approved, whatever the permission system asked');
    assert(policy('bash', { command: 'git push' }, 'write') !== APPROVAL_POLICY.APPROVE,
      'bash outside the whitelist must never be approved');
    assert(policy('write', { file_path: '/tmp/x', content: '' }, 'write') !== APPROVAL_POLICY.APPROVE,
      'a write must never be approved');
  });

  await run('its brief asks for the commit message alone, in the expected shape', () => {
    const guidance = CommitMessageSubagentStrategyType.GUIDANCE;
    assert(/72/.test(guidance), 'the brief must state the 72-character summary limit');
    assert(/staged/i.test(guidance), 'the brief must say the message is for the staged changes');
    assert(/git diff --cached/.test(guidance), 'the brief must point at git diff --cached');
    assert(/code fence/i.test(guidance) && /preamble/i.test(guidance),
      'the brief must forbid a preamble and code fences');
  });

  return { passed, failed, errors };
}
