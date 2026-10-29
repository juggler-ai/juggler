//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * SystemPromptContextItem tests.
 *
 * Pins the env block's date to the conversation's creation timestamp so the
 * assembled system prompt is a pure function of durable conversation state. A
 * live clock would make a conversation resumed across midnight rebuild a
 * different prompt for the same meaningful state — a spurious cold start that
 * busts claudecode's warm prompt cache.
 * @module unit-tests/system-prompt-context-item-test
 */

import SystemPromptContextItem from '../context-items/system-prompt-context-item.js';
import { getDefaultIdentityText, systemPromptRegistry } from '../../../sdk/lib/system-prompt-registry.js';
import {
  groupToolsByOrigin, parseMcpToolName, formatToolDrift, toolDriftDetail, splitToolsByStrategy,
} from '../../../js/services/thread-tool-inventory.js';
import strategyRegistry from '../../../js/registries/strategy-registry.js';
import { MCP_DISABLED_NOTICE } from '../../../js/services/mcp-availability.js';
import { estimateValueTokens } from '../../../js/utils/token-estimate.js';
import { formatTokens } from '../../../js/utils/format.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** A stand-in extension and the strategy name its catalogue translates. */
const STANDIN_EXTENSION = 'test-i18n-strategies';
const STANDIN_STRATEGY_NAME = 'Stand-in strategy';

/** juggler-core's English for this item, standing in for its catalogue. */
const CORE_TEXT = [
  'System Prompt', 'System Prompt ({name})', 'System Prompt (Custom)',
  'Identity', 'Enter system prompt identity text...', 'Select a preset',
  'Environment info', 'Rules', 'Extension guidance', 'Loading…', 'Tools',
  "Couldn't read the tool list.\n\n{error}",
  '{count, plural, one {{count} tool available to the model · ~{tokens} tokens} other {{count} tools available to the model · ~{tokens} tokens}}',
  'Estimated tokens (~4 characters per token), sent on every turn.',
  '{changes} since the last turn — the model has not been offered this list yet.',
  '{title} · ~{tokens}', '{title} · ~{tokens} — {status}',
  '{state, select, running {MCP · {server} — running, tools not offered} none {MCP · {server} — not running} other {MCP · {server} — {status}}}{hasDetail, select, yes {: {detail}} other {}}',
  '{by, select, yes {Withheld by {strategy} — not offered to the model} other {Withheld — not offered to the model}}',
  '{by, select, yes {Withheld by {strategy} — the model cannot call this.} other {Withheld — the model cannot call this.}}',
  'Configure "{server}"', 'Show where this tool is defined',
  'running', 'starting', 'stopped', 'failed', 'disabled',
  // Core's MCP_DISABLED_NOTICE: the stand-in catalogues register core's en-XA
  // under the test's own namespace, which a scoped translator never searches.
  'The MCP extension is disabled, so no MCP tools reach the model. Turn "Juggler MCP" back on in Settings › Extensions.',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run system-prompt-context-item tests.
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

  // A fixed PAST creation timestamp: the env block's date must reflect this,
  // never the live clock, so the assembled prompt is byte-stable across turns
  // and across a resume that crosses midnight.
  const FIXED_CREATED = '2020-01-01T08:30:00.000Z';

  /**
   * Construct a SystemPromptContextItem against minimal fakes — the item only
   * reads session.projectPath/platform and conversation.created.
   * @param {string} [created] - Conversation creation ISO timestamp
   * @returns {SystemPromptContextItem} Item under test
   */
  function makeItem(created = FIXED_CREATED) {
    return new SystemPromptContextItem({
      id: 'SYSTEM_test',
      session: /** @type {any} */ ({ projectPath: '/proj', platform: 'darwin' }),
      conversation: /** @type {any} */ ({ created }),
      messageThread: /** @type {any} */ ({})
    });
  }

  await test('buildPrompt pins the env date to conversation.created (full prompt)', () => {
    const item = makeItem();
    const prompt = item.buildPrompt();
    // With no stored text, the body is the built-in default preset content;
    // derive it from the registry so this test tracks wording changes.
    const expected =
      getDefaultIdentityText() + '\n\n' +
			'<env>\n' +
			'Working directory: /proj\n' +
			'Platform: darwin\n' +
			"Today's date: 2020-01-01\n" +
			'</env>';
    assert(prompt === expected, `assembled prompt should pin the date to conversation.created:\n--- got ---\n${prompt}\n--- want ---\n${expected}`);
  });

  await test('buildPrompt does not leak the live clock date', () => {
    const item = makeItem();
    const prompt = item.buildPrompt();
    const todayLive = new Date().toISOString().split('T')[0];
    // The pinned date is in the distant past, so the live date cannot match it.
    assert(todayLive !== '2020-01-01', 'precondition: test must not be run on 2020-01-01');
    assert(!prompt.includes(`Today's date: ${todayLive}`), `live clock date must not appear in the prompt:\n${prompt}`);
  });

  await test('buildPrompt is byte-identical across successive calls', () => {
    const item = makeItem();
    const a = item.buildPrompt();
    const b = item.buildPrompt();
    assert(a === b, `two successive builds must be byte-identical:\n--- a ---\n${a}\n--- b ---\n${b}`);
  });

  await test('falls back to live date only when conversation.created is absent', () => {
    const item = new SystemPromptContextItem({
      id: 'SYSTEM_test_nocreated',
      session: /** @type {any} */ ({ projectPath: '/proj', platform: 'darwin' }),
      conversation: /** @type {any} */ ({}),
      messageThread: /** @type {any} */ ({})
    });
    const prompt = item.buildPrompt();
    const todayLive = new Date().toISOString().split('T')[0];
    assert(prompt.includes(`Today's date: ${todayLive}`), `with no conversation.created the fallback live date should appear:\n${prompt}`);
  });

  // ---- The Tools section states what the tool list costs ----

  // Everything the panel shows about size is an estimate of the SAME tool
  // objects the turn path sends, grouped by groupToolsByOrigin. These pin the
  // figure to that grouping rather than to a literal, so the panel cannot come
  // to state a number the turn does not send.

  /**
   * Render the Tools section against a fixed inventory, with no MCP servers,
   * no drift and no notice.
   * @param {Array<Record<string, any>>} offered - Tools the model is given
   * @param {Array<Record<string, any>>} [withheld] - Tools the strategy holds back
   * @returns {HTMLElement} The rendered section body
   */
  function renderTools(offered, withheld = []) {
    return makeItem().__buildToolInventoryViewForTests(
      { offered, withheld, strategyName: withheld.length ? 'Read-only' : '' },
      groupToolsByOrigin(offered),
      new Map(),
      parseMcpToolName,
      null,
      ''
    );
  }

  const TOOLS = [
    { name: 'read', category: 'read', description: 'Reads a file.', input_schema: { type: 'object' } },
    { name: 'bash', category: 'write', description: 'Runs a command.', input_schema: { type: 'object' } },
    { name: 'mcp__linear__list', category: 'read', description: 'Lists issues.', input_schema: { type: 'object' } }
  ];

  await test('the tool count line states what the list costs', () => {
    const view = renderTools(TOOLS);
    const line = view.querySelector('.system-prompt-tools-count');
    const total = TOOLS.reduce((sum, t) => sum + estimateValueTokens(t), 0);
    assert(!!line, 'the Tools section should render a count line');
    assert(/** @type {HTMLElement} */ (line).textContent.includes(`~${formatTokens(total)}`),
      `the count line should state the estimated cost of the whole list; got "${/** @type {HTMLElement} */ (line).textContent}"`);
  });

  await test('each group states its own cost, so a chatty MCP server is attributable', () => {
    const view = renderTools(TOOLS);
    const headings = [...view.querySelectorAll('.system-prompt-tools-group')]
      .map((h) => /** @type {HTMLElement} */ (h).textContent);
    for (const group of groupToolsByOrigin(TOOLS)) {
      assert(headings.some((h) => h.includes(group.title) && h.includes(`~${formatTokens(group.tokens)}`)),
        `the "${group.title}" heading should state its own cost; got ${JSON.stringify(headings)}`);
    }
  });

  await test('the stated cost counts only what the model is offered', () => {
    // A withheld tool is listed, struck through, below the offered groups. It
    // is not sent, so it must not be counted — otherwise switching to Read-only
    // would report a payload that grew.
    const offered = TOOLS.slice(0, 1);
    const withheld = TOOLS.slice(1, 2);
    const line = renderTools(offered, withheld).querySelector('.system-prompt-tools-count');
    const offeredOnly = estimateValueTokens(TOOLS[0]);
    const both = offeredOnly + estimateValueTokens(TOOLS[1]);
    const text = /** @type {HTMLElement} */ (line).textContent;
    assert(text.includes(`~${formatTokens(offeredOnly)}`),
      `the count line should state the offered cost; got "${text}"`);
    assert(offeredOnly === both || !text.includes(`~${formatTokens(both)}`),
      `the count line must not count withheld tools; got "${text}"`);
  });

  // ---- en-XA: every state the item draws is translated; the prompt is not ----

  await test('en-XA: title, panel, tool list states; the prompt stays English', async () => {
    const realGetPreset = systemPromptRegistry.getPreset;
    // The strategy registry is pinned: the stand-in strategy belongs to a
    // stand-in extension, whatever this lane has registered.
    const realGetExtensionId = strategyRegistry.getExtensionId;
    try {
      /** @type {any} */ (strategyRegistry).getExtensionId =
        (/** @type {string} */ id) => (id === 'test-i18n-standin' ? STANDIN_EXTENSION : null);
      await underPseudoLocale('system-prompt-context-item-test', async () => {
        /** @type {Record<string, string>} */
        const shown = {};
        /**
         * @param {string} where - The state the strings were drawn in
         * @param {string[]} strings - What it showed
         * @returns {void}
         */
        const collect = (where, strings) => strings.forEach((s, i) => { shown[`${where} ${i}`] = s; });

        // Title and row, in each variant. The preset list is pinned: a preset
        // name is data (digits here), the words around it are not.
        /** @type {any} */ (systemPromptRegistry).getPreset =
          (/** @type {string} */ id) => (id === '1' ? { id: '1', name: '2' } : realGetPreset.call(systemPromptRegistry, id));
        /** @type {Array<[string, Record<string, any>]>} */
        const variants = [
          ['default', { selectedPresetId: 'default', isModified: false }],
          ['preset', { selectedPresetId: '1', isModified: false }],
          ['custom', { selectedPresetId: '1', isModified: true }],
        ];
        for (const [name, data] of variants) {
          const item = makeItem();
          Object.assign(item.data, data);
          const ui = /** @type {any} */ (item.getStatusUI());
          shown[`type name ${name}`] = String(ui?.typeName);
          shown[`row ${name}`] = String(ui?.summary);
          shown[`title ${name}`] = item.getTitle();
        }
        assert((shown['title preset'] ?? '').includes('2'), `the preset's name should be in its title; got ${shown['title preset']}`);

        // The properties panel while its async sections are still loading. The
        // environment body is the prompt's own English text (asserted below).
        const panelItem = makeItem();
        /** @type {any} */ (panelItem)._fillExtensionGuidance = async () => {};
        /** @type {any} */ (panelItem)._fillToolInventory = async () => {};
        const panel = panelItem.createPropertiesPanelElement();
        collect('panel', shownStrings(panel, '[data-section-id="environment"] .system-prompt-section-body'));
        assert(!!panel.querySelector('[data-section-id="tools"]'), 'the panel should have a Tools section');

        // The tool list could not be read.
        const failing = new SystemPromptContextItem({
          id: 'SYSTEM_test_fail',
          session: /** @type {any} */ ({ projectPath: '/proj', platform: 'darwin' }),
          conversation: /** @type {any} */ ({ created: FIXED_CREATED }),
          messageThread: /** @type {any} */ ({ get strategy() { throw new Error('9'); } })
        });
        const host = document.createElement('div');
        const section = /** @type {any} */ (failing)._addPreviewSection(host, 'tools', '3', '4');
        await /** @type {any} */ (failing)._fillToolInventory(section);
        const errorText = section.querySelector('.system-prompt-section-body')?.textContent || '';
        assert(errorText.includes('9'), `the error should carry the failure; got ${JSON.stringify(errorText)}`);
        shown['tool list error'] = errorText.trim();

        // Empty, and one tool.
        for (const [name, offered] of /** @type {Array<[string, any[]]>} */ ([['empty', []], ['one', [{ name: '5', description: '' }]]])) {
          const view = makeItem().__buildToolInventoryViewForTests(
            { offered, withheld: [], strategyName: '' }, groupToolsByOrigin(offered), new Map(), parseMcpToolName, null, '');
          collect(`tools ${name}`, shownStrings(view, '.system-prompt-tool'));
        }

        // Everything at once: drift, MCP switched off, a server group with a
        // status, silent servers in each state, and tools withheld with and
        // without a strategy name.
        const offered = [{ name: '5', description: '' }, { name: 'mcp__6__7', description: '' }];
        const servers = new Map([
          ['6', { status: 'stopped' }],
          ['1', { status: 'running' }],
          ['2', { status: 'failed', error: '3\n4' }],
          ['8', {}],
        ]);
        const drift = { changes: formatToolDrift({ added: ['9'], removed: [] }), detail: toolDriftDetail({ added: ['9'], removed: [] }) };
        for (const strategyName of ['0', '']) {
          const view = makeItem().__buildToolInventoryViewForTests(
            { offered, withheld: [{ name: '9', description: '' }, { name: 'mcp__6__1', description: '' }], strategyName },
            groupToolsByOrigin(offered), servers, parseMcpToolName, drift, MCP_DISABLED_NOTICE);
          collect(`tools full ${strategyName || 'no strategy'}`, shownStrings(view, '.system-prompt-tool'));
          assert(view.querySelectorAll('.system-prompt-tools-silent').length === 3, 'three silent servers');
          assert(!!view.querySelector('.system-prompt-tools-notice'), 'the MCP-disabled notice should be drawn');
          // Tool rows show the tool's name (data); their tooltips are UI text.
          for (const row of view.querySelectorAll('.system-prompt-tool')) {
            String(row.getAttribute('title')).split('\n\n')
              .forEach((part, i) => { shown[`row title ${strategyName} ${row.textContent} ${i}`] = part; });
          }
        }

        // The withholding strategy's name, as the inventory reports it, is its
        // manifest name translated in its own extension's catalogue.
        class StandInStrategy {
          static MANIFEST = { id: 'test-i18n-standin', name: STANDIN_STRATEGY_NAME };
          /**
           * @param {any[]} tools - Every tool.
           * @returns {any[]} All but the first.
           */
          filterTools(tools) { return tools.slice(1); }
        }
        const split = splitToolsByStrategy([{ name: '5', description: '' }, { name: '9', description: '' }], new StandInStrategy());
        shown['strategy name'] = split.strategyName;
        const byStrategy = makeItem().__buildToolInventoryViewForTests(
          split, groupToolsByOrigin(split.offered), new Map(), parseMcpToolName, null, '');
        collect('tools withheld by stand-in', shownStrings(byStrategy, '.system-prompt-tool'));

        const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);

        // The model's text is English under any UI language.
        const prompt = makeItem().buildPrompt();
        const expected = getDefaultIdentityText() + '\n\n<env>\nWorking directory: /proj\nPlatform: darwin\nToday\'s date: 2020-01-01\n</env>';
        assert(prompt === expected, `the prompt changed under en-XA:\n${prompt}`);
        const envBody = panel.querySelector('[data-section-id="environment"] .system-prompt-section-body')?.textContent || '';
        assert(envBody.includes('Working directory: /proj'), `the environment preview is the prompt's English; got ${JSON.stringify(envBody)}`);
        assert(makeItem().createContextText(/** @type {any} */ ({})) === '', 'createContextText adds nothing');
      }, { '@juggler/core': CORE_TEXT, [STANDIN_EXTENSION]: [STANDIN_STRATEGY_NAME] });
    } finally {
      /** @type {any} */ (systemPromptRegistry).getPreset = realGetPreset;
      /** @type {any} */ (strategyRegistry).getExtensionId = realGetExtensionId;
    }
  });

  return { passed, failed, errors };
}
