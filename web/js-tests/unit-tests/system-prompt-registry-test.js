//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * System-prompt registry + preset-resolution tests.
 *
 * These cover the in-memory, per-iframe pieces only — the registry (built-in
 * catalog + user-preset merge) and the default-preset resolution — so they are
 * lane-safe: they never mutate the shared per-user preset store on the server
 * (which is load-modify-write and would race across pool lanes). Server
 * persistence is covered by Go unit tests (core/system_prompt_presets_test.go).
 * @module unit-tests/system-prompt-registry-test
 */

import {
  systemPromptRegistry,
  getDefaultIdentityText,
  BUILTIN_DEFAULT_ID
} from '../../sdk/lib/system-prompt-registry.js';
import {
  getDefaultPresetSeed,
  getDefaultPresetId,
  resolveDefaultPresetId
} from '../../js/services/system-prompt-presets.js';
import { presetSeedForStrategy } from '../../js/model/conversation-seeder.js';
import { extensionPresets } from '../../js/services/extensions.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passing assertions.
 * @property {number} failed - Number of failing assertions.
 * @property {string[]} errors - Collected error messages.
 */

/**
 * Run system-prompt registry tests.
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

  await test('built-in presets are registered with neutral default content', () => {
    const def = systemPromptRegistry.getPreset('default');
    assert(!!def, 'default preset must exist');
    assert(def.builtin === true, 'default must be marked builtin');
    assert(systemPromptRegistry.getPreset('minimal') !== undefined, 'minimal preset must exist');
    assert(systemPromptRegistry.getPreset('code-reviewer') !== undefined, 'code-reviewer preset must exist');
    // Pruned persona presets are gone.
    assert(systemPromptRegistry.getPreset('mentor') === undefined, 'mentor preset should be removed');
    assert(systemPromptRegistry.getPreset('pair-programmer') === undefined, 'pair-programmer preset should be removed');
    assert(systemPromptRegistry.getPreset('architect') === undefined, 'architect preset should be removed');
  });

  await test('default preset body is neutral (no opinionated guidance)', () => {
    const content = getDefaultIdentityText();
    assert(content.includes('## Responses'), 'default body should describe response formats');
    assert(content.includes('Markdown, HTML'), 'default body should permit HTML responses');
    assert(content.includes('## Code'), 'default body should carry working-style guidance');
    assert(content.includes('`file_path:line_number`'), 'default body should carry the code-reference convention');
    assert(!content.includes('Git Workflow'), 'default body must not carry git rules');
    assert(!content.includes('disagree when necessary'), 'default body must not carry opinionated tone');
    assert(!content.includes('No time estimates'), 'default body must not carry the time-estimate rule');
  });

  await test('getCategories reflects built-in categories', () => {
    const cats = systemPromptRegistry.getCategories();
    assert(cats.includes('general'), 'general category present');
    assert(cats.includes('specialized'), 'specialized category present');
  });

  await test('setUserPresets merges user presets under the user category and replaces prior set', () => {
    systemPromptRegistry.setUserPresets([
      { id: 'user-a', name: 'Alpha', content: 'A body' },
      { id: 'user-b', name: 'Beta', content: 'B body' }
    ]);
    let userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 2, `expected 2 user presets, got ${userPresets.length}`);
    assert(systemPromptRegistry.getPreset('user-a').category === 'user', 'user preset filed under user category');
    assert(systemPromptRegistry.getPreset('user-a').builtin === false, 'user preset marked non-builtin');

    // Built-ins survive a user-set replacement.
    assert(systemPromptRegistry.getPreset('default') !== undefined, 'built-ins must survive setUserPresets');

    // A second call replaces, not appends.
    systemPromptRegistry.setUserPresets([{ id: 'user-c', name: 'Gamma', content: 'C body' }]);
    userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 1 && userPresets[0].id === 'user-c', 'setUserPresets should replace the prior user set');
    assert(systemPromptRegistry.getPreset('user-a') === undefined, 'old user preset removed on replace');

    // Clearing removes all user presets, leaving built-ins.
    systemPromptRegistry.setUserPresets([]);
    assert(systemPromptRegistry.getPresetsByCategory('user').length === 0, 'empty setUserPresets clears user presets');
    assert(systemPromptRegistry.getPreset('default') !== undefined, 'built-ins remain after clear');
  });

  await test('setUserPresets ignores malformed entries', () => {
    systemPromptRegistry.setUserPresets([
      { id: 'user-ok', name: 'OK', content: 'body' },
      { id: '', name: 'no id', content: 'x' },
      { id: 'user-nocontent', name: 'no content', content: '' },
      null
    ]);
    const userPresets = systemPromptRegistry.getPresetsByCategory('user');
    assert(userPresets.length === 1 && userPresets[0].id === 'user-ok', 'only the well-formed user preset is registered');
    systemPromptRegistry.setUserPresets([]); // cleanup
  });

  await test('extension and user presets replace only their own source', () => {
    systemPromptRegistry.setExtensionPresets([
      { id: '@probe/ext/one', name: 'One', content: 'one body', extensionId: '@probe/ext', extensionName: 'Probe' }
    ]);
    systemPromptRegistry.setUserPresets([{ id: 'user-x', name: 'X', content: 'x body' }]);
    try {
      const ext = systemPromptRegistry.getPreset('@probe/ext/one');
      assert(!!ext, 'an extension preset must survive setUserPresets');
      assert(ext.source === 'extension', `extension preset source is "${ext?.source}"`);
      assert(ext.builtin === false, 'an extension preset is not builtin');
      assert(systemPromptRegistry.getPreset('default')?.source === 'builtin', 'built-ins carry source builtin');
      assert(systemPromptRegistry.getPreset('user-x')?.source === 'user', 'user presets carry source user');

      systemPromptRegistry.setExtensionPresets([]);
      assert(systemPromptRegistry.getPreset('@probe/ext/one') === undefined, 'setExtensionPresets replaces the extension set');
      assert(!!systemPromptRegistry.getPreset('user-x'), 'a user preset must survive setExtensionPresets');
      assert(!!systemPromptRegistry.getPreset('default'), 'built-ins must survive setExtensionPresets');
    } finally {
      systemPromptRegistry.setExtensionPresets([]);
      systemPromptRegistry.setUserPresets([]);
    }
  });

  await test('a repeated extension preset id keeps the first, with a warning', () => {
    /** @type {string[]} */
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
      systemPromptRegistry.setExtensionPresets([
        { id: '@probe/ext/one', name: 'First', content: 'first body', extensionId: '@probe/ext' },
        { id: '@probe/ext/one', name: 'Second', content: 'second body', extensionId: '@probe/ext' }
      ]);
      const kept = systemPromptRegistry.getPreset('@probe/ext/one');
      assert(kept?.content === 'first body', `the later entry replaced the first: kept "${kept?.name}"`);
      assert(warnings.some((w) => w.includes('@probe/ext/one')), `no warning names the repeated id: ${JSON.stringify(warnings)}`);
    } finally {
      console.warn = realWarn;
      systemPromptRegistry.setExtensionPresets([]);
    }
  });

  await test('an extension id seen twice contributes only its first copy\'s presets, with a warning', () => {
    /**
     * @param {string} id - The preset id
     * @returns {{id: string, url: string, name: string, content: string}} A preset as the server serves it
     */
    const preset = (id) => ({ id, url: `/x/${id}.md`, name: id, content: 'body' });
    /** @type {string[]} */
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
      const extensions = [
        { manifest: { id: '@juggler/chat', name: 'Chat' }, capabilities: { systemPromptPresets: [preset('@juggler/chat/assistant')] } },
        { manifest: { id: '@probe/off', name: 'Off' }, capabilities: { systemPromptPresets: [preset('@probe/off/off')] } },
        { manifest: { id: '@probe/broken', name: 'Broken' }, error: 'bad', capabilities: { systemPromptPresets: [preset('@probe/broken/broken')] } },
        { manifest: { id: '@juggler/chat', name: 'Shadow' }, capabilities: { systemPromptPresets: [preset('@juggler/chat/assistant'), preset('@juggler/chat/extra')] } }
      ];
      const presets = extensionPresets(/** @type {any} */ (extensions), new Set(['@probe/off']));
      const ids = presets.map((p) => p.id);
      assert(JSON.stringify(ids) === JSON.stringify(['@juggler/chat/assistant']),
        `want only the first @juggler/chat's preset, got ${JSON.stringify(ids)}`);
      assert(presets[0]?.extensionName === 'Chat', `the first copy names the group: "${presets[0]?.extensionName}"`);
      assert(warnings.some((w) => w.includes('@juggler/chat')), `no warning names the repeated extension: ${JSON.stringify(warnings)}`);
    } finally {
      console.warn = realWarn;
    }
  });

  await test('preset groups are ordered built-in, extension, user whatever order they load in', () => {
    try {
      // The user set lands first, as it does when its fetch wins the race.
      systemPromptRegistry.setUserPresets([{ id: 'user-z', name: 'Z', content: 'z body' }]);
      systemPromptRegistry.setExtensionPresets([
        { id: '@probe/ext/one', name: 'One', content: 'one body', extensionId: '@probe/ext', extensionName: 'Probe' }
      ]);
      const cats = systemPromptRegistry.getCategories();
      const ext = cats.indexOf('extension:@probe/ext');
      const user = cats.indexOf('user');
      const general = cats.indexOf('general');
      assert(general === 0, `built-in groups first: ${JSON.stringify(cats)}`);
      assert(ext >= 0 && user >= 0 && ext < user, `extension group before user: ${JSON.stringify(cats)}`);
    } finally {
      systemPromptRegistry.setExtensionPresets([]);
      systemPromptRegistry.setUserPresets([]);
    }
  });

  await test('a default naming an extension preset falls back once the extension is gone', () => {
    systemPromptRegistry.setExtensionPresets([
      { id: '@probe/ext/one', name: 'One', content: 'one body', extensionId: '@probe/ext', extensionName: 'Probe' }
    ]);
    try {
      assert(resolveDefaultPresetId('@probe/ext/one') === '@probe/ext/one', 'a present extension preset can be the default');
      systemPromptRegistry.setExtensionPresets([]);
      assert(resolveDefaultPresetId('@probe/ext/one') === BUILTIN_DEFAULT_ID, 'a vanished extension default falls back to the built-in');
    } finally {
      systemPromptRegistry.setExtensionPresets([]);
    }
  });

  await test('seeding uses the initial strategy\'s defaultPreset, else the user default', () => {
    class PresetProbeStrategy {
      static MANIFEST = { id: 'preset-probe', name: 'Probe', version: '1.0.0', description: 'probe', defaultPreset: '@probe/ext/one' };
    }
    const registration = strategyRegistry.registerClass(/** @type {any} */ (PresetProbeStrategy));
    systemPromptRegistry.setExtensionPresets([
      { id: '@probe/ext/one', name: 'One', content: 'one body', extensionId: '@probe/ext', extensionName: 'Probe' }
    ]);
    try {
      assert(registration.registered, `registerClass refused the probe: ${registration.reason}`);
      const seed = presetSeedForStrategy('preset-probe');
      assert(seed.id === '@probe/ext/one' && seed.content === 'one body', `strategy preset not seeded: ${seed.id}`);

      const plain = presetSeedForStrategy('default');
      assert(plain.id === getDefaultPresetId(), 'a strategy naming no preset seeds the user default');

      systemPromptRegistry.setExtensionPresets([]);
      const gone = presetSeedForStrategy('preset-probe');
      assert(gone.id === getDefaultPresetId(), 'a strategy naming a missing preset seeds the user default');
    } finally {
      strategyRegistry.items.delete('preset-probe');
      systemPromptRegistry.setExtensionPresets([]);
    }
  });

  await test('default preset resolution falls back to the built-in default', () => {
    // With no explicit server-side default set in this lane, resolution lands
    // on the built-in default.
    assert(getDefaultPresetId() === BUILTIN_DEFAULT_ID, 'default id resolves to built-in default');
    const seed = getDefaultPresetSeed();
    assert(seed.id === BUILTIN_DEFAULT_ID, 'seed id is the built-in default');
    assert(seed.content === getDefaultIdentityText(), 'seed content is the built-in default body');
    assert(seed.content.includes('## Code'), 'seed body carries the neutral guidance');
  });

  return { passed, failed, errors };
}
