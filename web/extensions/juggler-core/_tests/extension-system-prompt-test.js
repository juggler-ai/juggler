//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Extension system-prompt contribution tests.
 *
 * Two layers:
 *  1. Gating purity — juggler-core's `system-prompt-contribution.js` default
 *     export is a pure function of the enabled-plugin set: a section appears
 *     iff its plugin id is in `enabledPluginIds`. Tested directly, so it needs
 *     no shared-config mutation (which would pollute sibling pool lanes).
 *  2. End-to-end reach — with explore-code/thread enabled (the default), the
 *     contribution flows through the shared builder into the assembled system
 *     prompt (the production path shares this same builder).
 * @module unit-tests/extension-system-prompt-test
 */

import systemPromptContribution from '../system-prompt-contribution.js';
import QueryCodeContextItem from '../context-items/query-code-context-item.js';
import { buildExtensionSystemPromptContributions } from '../../../js/services/extensions.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  buildContext,
  assert
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const EXPLORE_MARKER = '→ `query_code`';
// The plugin id the query_code tool ships under. Pinned as a literal on
// purpose: it is persisted in users' enabled-plugin lists, so it is a
// compatibility constant, not a name that may follow the tool or the file.
const QUERY_CODE_PLUGIN_ID = 'explore-code';
const THREAD_MARKER = '→ `create_thread`';
const NEW_CONV_MARKER = 'use new_conversation';
const ECONOMY_HEADING = '### Keeping intermediate work out of context';
const ECONOMY_RULE = 'computation, not judgement';

/**
 * Each context-economy mechanism, the plugin it ships under, and the marker of
 * its line in the section.
 * @type {Array<[string, string]>}
 */
const ECONOMY_LINES = [
  ['explore-code', EXPLORE_MARKER],
  ['explore-agent', '→ `Explore`'],
  ['research-agent', '→ `Research`'],
  ['web-fetch', '→ `WebFetch` with a `prompt`'],
  ['thread', THREAD_MARKER]
];

/**
 * Run extension system-prompt tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  // ---- Layer 0: the plugin id is a compatibility constant ----

  // The item's file, class, tool name and display name all say "query code";
  // its plugin id still says "explore-code", and must. The id is persisted in
  // users' enabled-plugin lists, so renaming it to match its neighbours flips
  // the plugin's enabled state for anyone whose plugin set is not the default.
  // Nothing else fails when it drifts — the gating tests below all pass their
  // own literals — so this is the only assertion standing between a tidy-up
  // rename and silently disabling a tool on upgrade.
  await test('the query_code plugin id is unchanged', () => {
    assert(QueryCodeContextItem.MANIFEST.id === QUERY_CODE_PLUGIN_ID,
      `the plugin id is persisted in users' enabled-plugin lists and must stay ${QUERY_CODE_PLUGIN_ID}, got ${QueryCodeContextItem.MANIFEST.id}`);
  });

  // ...and the section gates on THAT id. Pinning both ends together means a
  // coordinated rename of id + gate still trips the assertion above, while a
  // one-sided rename trips this one.
  await test('the query_code section gates on the plugin id the item declares', () => {
    const out = systemPromptContribution({ enabledPluginIds: [QueryCodeContextItem.MANIFEST.id] });
    assert(out.includes(EXPLORE_MARKER),
      'the system-prompt section must gate on the id the item actually declares');
  });

  // ---- Layer 1: gating purity (pure function, no session) ----

  await test('both sections present when both plugins enabled', () => {
    const out = systemPromptContribution({ enabledPluginIds: ['explore-code', 'thread', 'read-file'] });
    assert(out.includes(EXPLORE_MARKER), 'query_code section should be present');
    assert(out.includes(THREAD_MARKER), 'create_thread section should be present');
  });

  await test('query_code section absent when explore-code disabled', () => {
    const out = systemPromptContribution({ enabledPluginIds: ['thread'] });
    assert(!out.includes(EXPLORE_MARKER), 'query_code section must be gated out');
    assert(out.includes(THREAD_MARKER), 'create_thread section should remain');
  });

  await test('thread section absent when thread disabled', () => {
    const out = systemPromptContribution({ enabledPluginIds: ['explore-code'] });
    assert(out.includes(EXPLORE_MARKER), 'query_code section should remain');
    assert(!out.includes(THREAD_MARKER), 'create_thread section must be gated out');
  });

  // The context-economy section explains every tool whose point is doing work
  // without putting it in the transcript, in one place. Each line must follow
  // its own plugin, so the prompt never names a tool the user has disabled.
  await test('each context-economy line gates on its own plugin', () => {
    const allIds = ECONOMY_LINES.map(([id]) => id);
    for (const [id, marker] of ECONOMY_LINES) {
      assert(systemPromptContribution({ enabledPluginIds: [id] }).includes(marker),
        `the ${id} line must be present when ${id} is enabled`);
      const without = systemPromptContribution({ enabledPluginIds: allIds.filter((x) => x !== id) });
      assert(!without.includes(marker), `the ${id} line must be absent when ${id} is disabled`);
    }
  });

  await test('the context-economy section is one section, absent when none of its tools are', () => {
    const all = systemPromptContribution({ enabledPluginIds: ECONOMY_LINES.map(([id]) => id) });
    assert(all.split(ECONOMY_HEADING).length === 2, 'all five mechanisms must share one section');
    assert(!all.includes('### Querying across files') && !all.includes('### Delegating sub-tasks'),
      'the standalone query_code and create_thread sections must be folded into it');
    assert(!systemPromptContribution({ enabledPluginIds: ['read-file', 'memory'] }).includes(ECONOMY_HEADING),
      'no section when none of its tools are enabled');
  });

  await test('the computation-vs-judgement rule appears only when both sides do', () => {
    assert(systemPromptContribution({ enabledPluginIds: ['explore-code', 'explore-agent'] }).includes(ECONOMY_RULE),
      'query_code beside a sub-agent must get the rule that tells them apart');
    assert(!systemPromptContribution({ enabledPluginIds: ['explore-code'] }).includes(ECONOMY_RULE),
      'with no sub-agent there is nothing to tell query_code apart from');
    assert(!systemPromptContribution({ enabledPluginIds: ['explore-agent', 'thread'] }).includes(ECONOMY_RULE),
      'with no query_code there is no computation side');
  });

  await test('the create_thread line keeps its usage contract', () => {
    const out = systemPromptContribution({ enabledPluginIds: ['thread'] });
    assert(out.includes('`resultSpec`') && out.includes('`goal`') && out.includes('one task'),
      'create_thread still needs its goal/prompt/resultSpec and one-task rules');
  });

  await test('general working-style guidance is NOT extension-generated (moved to presets)', () => {
    // Tone/quality/loop/references are tool-independent and now live in the
    // editable prompt presets, never in the plugin-gated extension text.
    const out = systemPromptContribution({ enabledPluginIds: ['read-file', 'execute', 'memory', 'explore-code', 'thread'] });
    assert(!out.includes('## Tone'), 'tone must not be extension-generated');
    assert(!out.includes('## Code Quality'), 'code quality must not be extension-generated');
    assert(!out.includes('## Code References'), 'code references must not be extension-generated');
    assert(!out.includes('## Agentic Loop'), 'agentic loop must not be extension-generated');
  });

  await test('new_conversation section gates on the new-conversation plugin', () => {
    assert(!systemPromptContribution({ enabledPluginIds: ['thread'] }).includes(NEW_CONV_MARKER),
      'new_conversation section absent without the new-conversation plugin');
    const out = systemPromptContribution({ enabledPluginIds: ['new-conversation'] });
    assert(out.includes(NEW_CONV_MARKER), 'new_conversation section present with the plugin');
    assert(out.includes('new tab') && out.includes('new chat'),
      'new_conversation guidance equates new conversation / new tab / new chat');
  });

  await test('memory section is gated on the memory plugin', () => {
    assert(!systemPromptContribution({ enabledPluginIds: ['read-file'] }).includes('## Memory'), 'memory absent without memory plugin');
    const out = systemPromptContribution({ enabledPluginIds: ['memory'] });
    assert(out.includes('## Memory'), 'memory present with memory plugin');
    assert(out.includes('`remember`'), 'memory guidance names the remember action');
    assert(out.includes('`forget`'), 'memory guidance names the forget action');
  });

  await test('git workflow is never extension-generated (opinionated; removed)', () => {
    // Removed entirely — a git/commit convention is not neutral enough to ship.
    assert(!systemPromptContribution({ enabledPluginIds: ['execute'] }).includes('## Git Workflow'), 'git workflow must be gone even with execute');
    assert(!systemPromptContribution({ enabledPluginIds: ['execute', 'read-file', 'memory'] }).includes('Generated with Juggler'), 'commit-message template must be gone');
  });

  await test('prefer-specialized-tools lines gate on their own plugin', () => {
    const out = systemPromptContribution({ enabledPluginIds: ['read-file', 'execute'] });
    assert(out.includes('**read** for reading files'), 'read line present when read-file enabled');
    assert(!out.includes('**glob** for finding files'), 'glob line absent when glob disabled');
    // With execute present the framing is "prefer ... over bash".
    assert(out.includes('Prefer specialized tools over bash'), 'bash-preference framing when execute enabled');
  });

  await test('tolerates a missing/invalid enabledPluginIds without throwing', () => {
    // Everything in the contribution is plugin-gated now, so missing ids yield
    // no per-tool sections (memory/explore/thread/specialized) — just a string.
    const out1 = systemPromptContribution({});
    assert(typeof out1 === 'string', 'undefined ids → returns a string');
    assert(!out1.includes('## Memory'), 'undefined ids → no memory section');
    assert(!out1.includes(THREAD_MARKER), 'undefined ids → no thread section');
    const out2 = systemPromptContribution({ enabledPluginIds: null });
    assert(typeof out2 === 'string', 'null ids → returns a string');
  });

  // ---- Layer 2: end-to-end reach through the shared builder ----

  await test('aggregator includes core contribution when its plugins enabled', async () => {
    await initializeRegistries();
    const contrib = await buildExtensionSystemPromptContributions();
    assert(contrib.includes(EXPLORE_MARKER), 'aggregator should include query_code guidance');
    assert(contrib.includes(THREAD_MARKER), 'aggregator should include create_thread guidance');
  });

  await test('contribution reaches the assembled system prompt', async () => {
    await initializeRegistries();
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const context = await buildContext(conversation.rootMessageThread, session);
    const sysPrompt = /** @type {string} */ (context.systemPrompt || '');
    // explore-code and thread are enabled by default, so both markers must
    // be present — proving the extension hook → aggregator → builder path.
    assert(sysPrompt.includes(EXPLORE_MARKER), `system prompt should include query_code guidance; got head: ${sysPrompt.slice(0, 200)}`);
    assert(sysPrompt.includes(THREAD_MARKER), 'system prompt should include create_thread guidance');
  });

  await test('neutral global guidance reaches the prompt via the preset body, not the extension', async () => {
    await initializeRegistries();
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const context = await buildContext(conversation.rootMessageThread, session);
    const sysPrompt = /** @type {string} */ (context.systemPrompt || '');
    // The default preset body carries this guidance — and the
    // extension contribution must NOT (it is purely per-tool now).
    assert(sysPrompt.includes('## Code'), 'preset body guidance should reach the system prompt');
    const contrib = await buildExtensionSystemPromptContributions();
    assert(!contrib.includes('## Code'), 'extension contribution must not carry working-style guidance');
  });

  return { passed, failed, errors };
}
