//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A user's strategy switch (`services/strategy-switch.js`) and what a strategy
 * brings with it: its identity (`MANIFEST.defaultPreset`) and whether the
 * project's instruction files are seeded (`MANIFEST.projectInstructions`),
 * both in `model/conversation-seeder.js`.
 *
 * Both fail silently: a conversation that keeps the wrong identity still
 * answers, just as the wrong assistant, and a switch that throws away a large
 * cached context costs money with nothing on screen to say so. The
 * conversations here are stand-ins holding only what the seeder and the switch
 * read, so nothing touches the server's per-user preset store.
 * @module unit-tests/strategy-switch-test
 */

import { assert } from '../utilities/test-helpers.js';
import { systemPromptRegistry, BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';
import { ensureUserPresetsLoaded, getDefaultPresetId } from '../../js/services/system-prompt-presets.js';
import { seedCreationDefaults, presetSeedForStrategy, strategySeedsProjectInstructions } from '../../js/model/conversation-seeder.js';
import { joinInstructionPath } from '../../js/services/instruction-files.js';
import { applyChromeHide } from '../../js/utils/strategy-chrome.js';
import { toolGroupingFor, toolGroupingOverride } from '../../js/utils/tool-grouping-pref.js';
import { switchStrategy, strategySwitchRereadsContext, noteSwitchInputs, switchIsCostly } from '../../js/services/strategy-switch.js';
import StrategyType from '../../sdk/strategy-type.js';
import { registerUiPort } from '../../js/services/ui-port.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passing assertions.
 * @property {number} failed - Number of failing assertions.
 * @property {string[]} errors - Collected error messages.
 */

const PROBE_STRATEGY = 'switch-probe';
const PROBE_PRESET = '@probe/switch/voice';
const PROBE_BODY = 'You are the probe voice.';

const PROBE_ALL_TOOLS = 'switch-probe-all';

/**
 * A strategy naming the probe preset as its identity, offering only web search.
 */
class SwitchProbeStrategy extends StrategyType {
  static MANIFEST = { id: PROBE_STRATEGY, name: 'Switch probe', version: '1.0.0', description: 'probe', defaultPreset: PROBE_PRESET };

  /**
   * @param {import('../../sdk/strategy-type.js').ToolDefinition[]} tools - Every tool
   * @returns {import('../../sdk/strategy-type.js').ToolDefinition[]} Web search only
   */
  filterTools(tools) {
    return tools.filter((tool) => tool.name === 'WebSearch');
  }
}

/**
 * A strategy naming its own extension's preset by stem.
 */
class SwitchProbeRelativeStrategy extends StrategyType {
  static MANIFEST = { id: 'switch-probe-relative', name: 'Switch probe (relative)', version: '1.0.0', description: 'probe', defaultPreset: './voice' };
}

/**
 * A strategy naming a preset nobody ships.
 */
class SwitchProbeMissingStrategy extends StrategyType {
  static MANIFEST = { id: 'switch-probe-missing', name: 'Switch probe (missing)', version: '1.0.0', description: 'probe', defaultPreset: '@probe/nobody/none' };
}

/**
 * A strategy that leaves the project's instruction files out.
 */
class SwitchProbeNoProjectStrategy extends StrategyType {
  static MANIFEST = { id: 'switch-probe-no-project', name: 'Switch probe (no project)', version: '1.0.0', description: 'probe', projectInstructions: false };
}

/**
 * A strategy offering every tool, naming no identity.
 */
class SwitchProbeAllToolsStrategy extends StrategyType {
  static MANIFEST = { id: PROBE_ALL_TOOLS, name: 'Switch probe (all tools)', version: '1.0.0', description: 'probe' };
}

/**
 * A root thread and its conversation, holding a system-prompt item and
 * whatever items are given, on the built-in default strategy.
 * @param {object} [opts]
 * @param {Array<{type: string}>} [opts.items] - The thread's items
 * @param {Record<string, any>} [opts.prompt] - The system-prompt item's data
 * @param {Array<{id: string, type: string, data: Record<string, any>}>} [opts.context] - Context items beside the system prompt
 * @param {any} [opts.session] - The conversation's session, when the test needs one
 * @returns {{thread: any, conversation: any, prompt: () => Record<string, any>, contextIds: () => string[]}} The stand-in, a reader of the prompt's data, and of the context items' ids
 */
function standIn({ items = [], prompt = { text: '', selectedPresetId: 'default', isModified: false }, context = [], session = undefined } = {}) {
  /** @type {Array<{id: string, type: string, data: Record<string, any>}>} */
  const contextItems = [{ id: 'sp-1', type: 'system-prompt', data: { ...prompt } }, ...context];
  const conversation = /** @type {any} */ ({ id: 'conv-switch-probe', session });
  const thread = /** @type {any} */ ({
    threadItemId: undefined,
    conversation,
    items: [...contextItems, ...items],
    contextItems,
    strategyId: 'default',
    getEffectiveStrategyId() { return this.strategyId; },
    get currentStrategyId() { return this.strategyId; },
    /** @param {string} id */
    setStrategy(id) { this.strategyId = id; },
    /**
     * @param {string} id - The item
     * @param {{data: Record<string, any>}} patch - Its new data
     */
    updateContextItem(id, patch) {
      const item = contextItems.find((c) => c.id === id);
      if (item) item.data = { ...patch.data };
    },
    /** @param {string} id - The item to remove */
    removeContextItem(id) {
      const at = contextItems.findIndex((c) => c.id === id);
      if (at >= 0) contextItems.splice(at, 1);
    }
  });
  conversation.rootMessageThread = thread;
  return {
    thread,
    conversation,
    prompt: () => /** @type {any} */ (contextItems[0]).data,
    contextIds: () => contextItems.map((c) => c.id)
  };
}

/**
 * Run strategy-switch tests.
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

  // Load once up front, so the seeder's own load finds it done and does not
  // replace the probe preset with the real extension set mid-test.
  await ensureUserPresetsLoaded();
  const registration = strategyRegistry.registerClass(/** @type {any} */ (SwitchProbeStrategy));
  const registrationAll = strategyRegistry.registerClass(/** @type {any} */ (SwitchProbeAllToolsStrategy));
  const registrationRelative = strategyRegistry.registerClass(/** @type {any} */ (SwitchProbeRelativeStrategy), { extensionId: '@probe/switch' });
  const registrationMissing = strategyRegistry.registerClass(/** @type {any} */ (SwitchProbeMissingStrategy));
  const registrationNoProject = strategyRegistry.registerClass(/** @type {any} */ (SwitchProbeNoProjectStrategy));
  const withProbePreset = () => systemPromptRegistry.setExtensionPresets([
    { id: PROBE_PRESET, name: 'Voice', content: PROBE_BODY, extensionId: '@probe/switch', extensionName: 'Probe' }
  ]);
  const extensionSet = systemPromptRegistry.getAllPresets().filter((p) => p.source === 'extension')
    .map((p) => ({ ...p, extensionId: p.extensionId ?? '', extensionName: p.categoryLabel }));

  try {
    await test('the probe strategy registers', () => {
      assert(registration.registered, `registerClass refused the probe: ${registration.reason}`);
      assert(registrationAll.registered, `registerClass refused the all-tools probe: ${registrationAll.reason}`);
      assert(registrationRelative.registered, `registerClass refused the relative probe: ${registrationRelative.reason}`);
      assert(registrationMissing.registered, `registerClass refused the missing-preset probe: ${registrationMissing.reason}`);
      assert(registrationNoProject.registered, `registerClass refused the no-project probe: ${registrationNoProject.reason}`);
    });

    await test('a strategy declaring projectInstructions: false sheds only the project\'s seeded files on a switch', async () => {
      // A chat that cannot read the project must not be told how to build it,
      // and nothing on screen says it was: the files sit collapsed in context.
      assert(strategySeedsProjectInstructions('default') && !strategySeedsProjectInstructions('switch-probe-no-project'),
        'the manifest field is not what decides');
      const globalDir = '/probe-home/.claude';
      const context = () => [
        { id: 'global', type: 'file-content', data: { path: joinInstructionPath(globalDir, 'CLAUDE.md'), seeded: true } },
        { id: 'project', type: 'file-content', data: { path: 'AGENTS.md', seeded: true } },
        { id: 'pinned', type: 'file-content', data: { path: 'docs/notes.md' } }
      ];
      const session = { instructionDirs: [globalDir] };
      const fresh = standIn({ context: context(), session });
      await switchStrategy(fresh.thread, 'switch-probe-no-project', { costly: false });
      assert(JSON.stringify(fresh.contextIds()) === JSON.stringify(['sp-1', 'global', 'pinned']),
        `left ${JSON.stringify(fresh.contextIds())}, want the global file and the user's own kept`);

      const started = standIn({ items: [{ type: 'user' }], context: context(), session });
      await switchStrategy(started.thread, 'switch-probe-no-project', { costly: false });
      assert(started.contextIds().includes('project'), 'a conversation under way lost its instruction files');
    });

    await test('a ./stem defaultPreset names the strategy\'s own extension\'s preset', () => {
      withProbePreset();
      const seed = presetSeedForStrategy('switch-probe-relative');
      assert(seed.id === PROBE_PRESET && seed.content === PROBE_BODY, `seeded "${seed.id}", want ${PROBE_PRESET}`);
    });

    await test('a defaultPreset naming nothing registered seeds the user default, with one warning', () => {
      withProbePreset();
      /** @type {string[]} */
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
      try {
        const first = presetSeedForStrategy('switch-probe-missing');
        presetSeedForStrategy('switch-probe-missing');
        assert(first.id === getDefaultPresetId(), `seeded "${first.id}", want the user default`);
        const named = warnings.filter((w) => w.includes('@probe/nobody/none'));
        assert(named.length === 1, `warned ${named.length} time(s) naming the missing preset, want once: ${JSON.stringify(warnings)}`);
      } finally {
        console.warn = realWarn;
      }
    });

    await test('a creator that names the strategy seeds from it, not the session default', async () => {
      // An agent run is created knowing its strategy: a user whose default is
      // a chat must not hand every sub-agent the chat's identity.
      withProbePreset();
      const { conversation, thread, prompt } = standIn();
      const session = { getMetadata: (/** @type {string} */ key) => (key === 'defaultStrategyId' ? PROBE_STRATEGY : undefined) };
      await seedCreationDefaults(/** @type {any} */ (session), conversation, { strategyId: PROBE_ALL_TOOLS });
      assert(thread.strategyId === PROBE_ALL_TOOLS, `seeded strategy is "${thread.strategyId}"`);
      assert(prompt().selectedPresetId !== PROBE_PRESET,
        `seeded the session default strategy's identity "${prompt().selectedPresetId}"`);
    });

    await test('creation seeds the identity of the strategy it resolves for the session', async () => {
      withProbePreset();
      const { conversation, thread, prompt } = standIn();
      const session = { getMetadata: (/** @type {string} */ key) => (key === 'defaultStrategyId' ? PROBE_STRATEGY : undefined) };
      await seedCreationDefaults(/** @type {any} */ (session), conversation);
      assert(thread.strategyId === PROBE_STRATEGY, `seeded strategy is "${thread.strategyId}"`);
      assert(prompt().selectedPresetId === PROBE_PRESET && prompt().text === PROBE_BODY,
        `seeded identity is "${prompt().selectedPresetId}", want the strategy's ${PROBE_PRESET}`);
    });

    await test('switching a conversation with no history to a strategy re-seeds its identity', async () => {
      withProbePreset();
      const { thread, prompt } = standIn();
      await switchStrategy(thread, PROBE_STRATEGY, { costly: false });
      assert(prompt().selectedPresetId === PROBE_PRESET && prompt().text === PROBE_BODY,
        `after the switch the identity is "${prompt().selectedPresetId}", want ${PROBE_PRESET}`);
      assert(prompt().isModified === false, 'a re-seeded identity is not a user edit');

      // And back: a strategy naming no preset restores the user's default.
      await switchStrategy(thread, 'default', { costly: false });
      assert(getDefaultPresetId() === BUILTIN_DEFAULT_ID, 'this lane has no default of its own');
      assert(prompt().selectedPresetId === BUILTIN_DEFAULT_ID && prompt().text === '',
        `switching back left "${prompt().selectedPresetId}", want the built-in default`);
    });

    await test('an identity the user chose, or a conversation under way, survives a switch', async () => {
      withProbePreset();
      const cases = [
        { label: 'history', ...standIn({ items: [{ type: 'user' }] }) },
        { label: 'edited prompt', ...standIn({ prompt: { text: 'my own words', selectedPresetId: 'default', isModified: true } }) },
        { label: 'picked preset', ...standIn({ prompt: { text: 'minimal body', selectedPresetId: 'minimal', isModified: false } }) },
        // Picked by hand, though a seed could have put each there: what was
        // picked, not which preset it is, decides.
        { label: 'picked built-in default', ...standIn({ prompt: { text: 'default body', selectedPresetId: BUILTIN_DEFAULT_ID, isModified: false, seeded: false } }) },
        { label: 'picked a strategy\'s preset', ...standIn({ prompt: { text: PROBE_BODY, selectedPresetId: PROBE_PRESET, isModified: false, seeded: false } }) }
      ];
      for (const { label, thread, prompt } of cases) {
        const before = JSON.stringify(prompt());
        const to = prompt().selectedPresetId === PROBE_PRESET ? 'default' : PROBE_STRATEGY;
        await switchStrategy(thread, to, { costly: false });
        assert(thread.strategyId === to, `${label}: the switch itself did not happen`);
        assert(JSON.stringify(prompt()) === before, `${label}: identity rewritten to ${JSON.stringify(prompt())}`);
      }
    });

    await test('MANIFEST.ui is read from the conversation\'s strategy, and only accepted values apply', () => {
      /**
       * @param {any} ui - The `MANIFEST.ui` to declare
       * @returns {any} A strategy stand-in declaring it
       */
      const withUi = (ui) => /** @type {any} */ ({ getManifest: () => ({ id: `ui-probe-${JSON.stringify(ui)}`, ui }) });
      const rootUi = { hide: ['log', 'bogus'], strategySelector: 'chip', toolGrouping: 'never' };
      const { thread: root, conversation } = standIn();
      root.strategy = withUi(rootUi);
      // A sub-thread on a strategy of its own: the conversation's look is the root's.
      const sub = /** @type {any} */ ({ conversation, threadItemId: 'T1', strategy: withUi({ hide: ['commands'], toolGrouping: 'always' }) });
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        const host = document.createElement('div');
        applyChromeHide(host, sub);
        assert(host.getAttribute('data-chrome-hide') === 'log', `hide mark "${host.getAttribute('data-chrome-hide')}", want the root's known ids only`);
        assert(host.getAttribute('data-strategy-selector') === 'chip', 'the chip form did not apply');
        assert(toolGroupingFor(conversation) === false, '\'never\' did not override the toggle');

        root.strategy = withUi({ strategySelector: 'hidden', toolGrouping: true });
        applyChromeHide(host, sub);
        assert(toolGroupingOverride(conversation) === null, 'a non-string toolGrouping overrode the toggle');
        assert(!host.hasAttribute('data-chrome-hide') && !host.hasAttribute('data-strategy-selector'),
          'marks left behind, or an unknown value applied');
      } finally {
        console.warn = realWarn;
      }
    });

    await test('a switch that re-reads a large cached context asks first, and a no leaves the strategy', async () => {
      /** @type {string[]} */
      const asked = [];
      let answer = false;
      const restore = registerUiPort(/** @type {any} */ ({
        confirm: async (/** @type {string} */ message) => { asked.push(message); return answer; },
        alert: async () => {}, prompt: async () => null, choice: async () => null, notice: () => {}
      }));
      try {
        const { thread } = standIn({ items: [{ type: 'user' }] });
        const declined = await switchStrategy(thread, PROBE_STRATEGY, { costly: true });
        assert(asked.length === 1, `asked ${asked.length} time(s), want once`);
        assert(declined === false && thread.strategyId === 'default', `a declined switch still switched to "${thread.strategyId}"`);

        answer = true;
        const accepted = await switchStrategy(thread, PROBE_STRATEGY, { costly: true });
        assert(accepted === true && thread.strategyId === PROBE_STRATEGY, `an accepted switch left "${thread.strategyId}"`);

        asked.length = 0;
        await switchStrategy(thread, 'default', { costly: false });
        assert(asked.length === 0, 'a cheap switch asked');
      } finally {
        restore();
      }
    });

    await test('a switch is weighed from what the selector recorded for that thread', () => {
      const { thread } = standIn({ items: [{ type: 'user' }] });
      thread.conversationId = 'conv-weighed';
      thread.strategyId = PROBE_ALL_TOOLS;
      assert(!switchIsCostly(thread, PROBE_STRATEGY), 'a thread nothing was recorded for must not ask');
      const tools = [{ name: 'Bash' }, { name: 'WebSearch' }];
      noteSwitchInputs(thread, { tools, anchorTokens: 40000 });
      assert(switchIsCostly(thread, PROBE_STRATEGY), 'losing Bash over a 40k-token cache must ask');
      // The same thread in a fresh wrapper, as a sub-thread column hands over.
      const rewrapped = { ...thread, items: thread.items, getEffectiveStrategyId: () => PROBE_ALL_TOOLS };
      assert(switchIsCostly(rewrapped, PROBE_STRATEGY), 'a fresh wrapper of the same thread lost the record');
      noteSwitchInputs(thread, { tools, anchorTokens: 1000 });
      assert(!switchIsCostly(thread, PROBE_STRATEGY), 'a small cache must not ask');
    });

    await test('only a tool-set change over a large cached history counts as re-reading it', () => {
      const history = [{ type: 'system-prompt' }, { type: 'user' }, { type: 'assistant' }];
      const big = 40000;
      const cases = /** @type {Array<[string, boolean, Parameters<typeof strategySwitchRereadsContext>[0]]>} */ ([
        ['tools change, large cache', true, { items: history, fromToolsetSig: 'Bash,Read', toToolsetSig: 'WebSearch', anchorTokens: big }],
        ['same tools', false, { items: history, fromToolsetSig: 'Bash,Read', toToolsetSig: 'Bash,Read', anchorTokens: big }],
        ['small cache', false, { items: history, fromToolsetSig: 'Bash,Read', toToolsetSig: 'WebSearch', anchorTokens: 2000 }],
        ['no history', false, { items: [{ type: 'system-prompt' }], fromToolsetSig: 'Bash,Read', toToolsetSig: 'WebSearch', anchorTokens: big }]
      ]);
      for (const [label, want, args] of cases) {
        const got = strategySwitchRereadsContext(args);
        assert(got === want, `${label}: ${got}, want ${want}`);
      }
    });
  } finally {
    /** @type {any} */ (strategyRegistry).items.delete(PROBE_STRATEGY);
    /** @type {any} */ (strategyRegistry).items.delete(PROBE_ALL_TOOLS);
    /** @type {any} */ (strategyRegistry).items.delete('switch-probe-relative');
    /** @type {any} */ (strategyRegistry).items.delete('switch-probe-missing');
    /** @type {any} */ (strategyRegistry).items.delete('switch-probe-no-project');
    systemPromptRegistry.setExtensionPresets(extensionSet);
  }

  return { passed, failed, errors };
}
