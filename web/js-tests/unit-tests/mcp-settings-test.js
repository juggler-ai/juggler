//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the MCP servers Settings tab's pure helpers: the token-cost
 * formatter, server-name validation, the form-state → ServerConfig builder, and
 * the whole-scope-map producers for add / edit / delete / enable-toggle plus the
 * scope-of-a-listed-server lookup. The live round-trip (config write, reconcile,
 * status) is covered by the Go MCP-manager tests; this pins the browser-side
 * decision logic the tab depends on.
 * @module unit-tests/mcp-settings-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import {
  configFormToConfig as mcpFormToConfig,
  upsertConfigEntry as mcpUpsertMap,
  deleteConfigEntry as mcpDeleteMap,
  setConfigEntryEnabled as mcpSetEnabledMap,
  configScopeOf as mcpScopeOf,
  isRemoteTransport,
  ConfigTabController,
} from '../../js/components/config-tab.js';
import {
  formatMcpTokenCost,
  validateMcpServerName,
  mcpToolAllowed,
  mcpSeedFormExtra,
  mcpFormToConfigExtra,
  renderMcpFormExtra,
} from '../../js/components/settings/subprocess-tabs.js';
import { mcpToolMissReason, MCP_DISABLED_NOTICE } from '../../js/services/mcp-availability.js';
import { McpTab } from '../../js/components/settings/subprocess-tabs.js';
import { resetExtensionsCache } from '../../js/services/extensions.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
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

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
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

  // --- formatMcpTokenCost ---------------------------------------------------

  await run('token cost: pluralizes tools and shows k-tokens', () => {
    assert(formatMcpTokenCost({ toolCount: 3, schemaTokens: 1234 }) === '3 tools · ~1.2k tokens/request', 'multi-tool format wrong');
  });

  await run('token cost: singular tool', () => {
    assert(formatMcpTokenCost({ toolCount: 1, schemaTokens: 400 }) === '1 tool · ~400 tokens/request', 'singular format wrong');
  });

  await run('token cost: drops the token clause when zero', () => {
    assert(formatMcpTokenCost({ toolCount: 0, schemaTokens: 0 }) === '0 tools', 'zero-token clause not dropped');
  });

  await run('token cost: tolerates missing fields', () => {
    assert(formatMcpTokenCost({}) === '0 tools', 'empty status not handled');
  });

  // --- validateMcpServerName ------------------------------------------------

  await run('name validation: accepts a normal name', () => {
    assert(validateMcpServerName('github', []) === '', 'valid name rejected');
  });

  await run('name validation: rejects blank', () => {
    assert(validateMcpServerName('   ', []) !== '', 'blank accepted');
  });

  await run('name validation: rejects whitespace', () => {
    assert(validateMcpServerName('my server', []) !== '', 'whitespace accepted');
  });

  await run('name validation: rejects slash', () => {
    assert(validateMcpServerName('a/b', []) !== '', 'slash accepted');
  });

  await run('name validation: rejects the reserved "juggler"', () => {
    assert(validateMcpServerName('juggler', []) !== '', 'reserved name accepted');
  });

  await run('name validation: enforces uniqueness within scope', () => {
    assert(validateMcpServerName('github', ['github', 'fs']) !== '', 'duplicate accepted');
    assert(validateMcpServerName('github', ['fs']) === '', 'non-duplicate rejected');
  });

  // --- mcpFormToConfig ------------------------------------------------------

  await run('form→config: trims command, keeps args verbatim, omits empties', () => {
    const entry = mcpFormToConfig({ command: '  npx ', args: ['-y', 'pkg with space'], env: {}, enabled: true });
    assert(entry.command === 'npx', 'command not trimmed');
    assert(Array.isArray(entry.args) && entry.args.length === 2, 'args count wrong');
    assert(entry.args[1] === 'pkg with space', 'arg with space was split/altered');
    assert(!('env' in entry), 'empty env should be omitted');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: omits empty args, includes non-empty env', () => {
    const entry = mcpFormToConfig({ command: 'run', args: [], env: { TOKEN: 'secret' }, enabled: false });
    assert(!('args' in entry), 'empty args should be omitted');
    assert(entry.env && entry.env.TOKEN === 'secret', 'env not preserved');
    assert(entry.enabled === false, 'enabled=false not coerced');
  });

  await run('form→config: drops blank env keys and filters blank args', () => {
    const entry = mcpFormToConfig({ command: 'run', args: ['a', '', 'b'], env: { '': 'x', OK: 'y' } });
    assert(entry.args.length === 2 && entry.args[0] === 'a' && entry.args[1] === 'b', 'blank arg not filtered');
    assert(entry.env && !('' in entry.env) && entry.env.OK === 'y', 'blank env key not dropped');
    assert(entry.enabled === true, 'enabled should default true');
  });

  await run('form→config: stdio omits transport/url/headers', () => {
    const entry = mcpFormToConfig({ command: 'run', enabled: true });
    assert(!('transport' in entry), 'stdio should not carry transport');
    assert(!('url' in entry), 'stdio should not carry url');
    assert(!('headers' in entry), 'stdio should not carry headers');
  });

  // --- isRemoteTransport ----------------------------------------------------

  await run('isRemoteTransport: http/streamable/sse are remote, stdio is not', () => {
    assert(isRemoteTransport('http'), 'http should be remote');
    assert(isRemoteTransport('streamable'), 'streamable should be remote');
    assert(isRemoteTransport('sse'), 'sse should be remote');
    assert(!isRemoteTransport('stdio'), 'stdio should not be remote');
    assert(!isRemoteTransport(undefined), 'undefined should not be remote');
  });

  // --- mcpFormToConfig (remote transports) ----------------------------------

  await run('form→config: http entry carries transport + url, omits command/args/env', () => {
    const entry = mcpFormToConfig({
      transport: 'http', url: '  https://scite.ai/mcp  ',
      command: 'ignored', args: ['x'], env: { A: 'b' }, enabled: true,
    });
    assert(entry.transport === 'http', 'transport not set');
    assert(entry.url === 'https://scite.ai/mcp', 'url not trimmed/set');
    assert(!('command' in entry), 'remote entry should not carry command');
    assert(!('args' in entry), 'remote entry should not carry args');
    assert(!('env' in entry), 'remote entry should not carry env');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: remote keeps non-blank headers, drops blank keys', () => {
    const entry = mcpFormToConfig({
      transport: 'sse', url: 'https://x/mcp',
      headers: { Authorization: 'Bearer t', '': 'skip' },
    });
    assert(entry.transport === 'sse', 'sse transport not set');
    assert(entry.headers && entry.headers.Authorization === 'Bearer t', 'header not preserved');
    assert(!('' in entry.headers), 'blank header key not dropped');
  });

  await run('form→config: remote omits empty headers and blank url', () => {
    const entry = mcpFormToConfig({ transport: 'http', url: '   ', headers: {} });
    assert(entry.transport === 'http', 'transport not set');
    assert(!('url' in entry), 'blank url should be omitted');
    assert(!('headers' in entry), 'empty headers should be omitted');
  });

  // --- whole-scope-map producers -------------------------------------------

  await run('upsert map: adds without touching siblings', () => {
    const src = { fs: { command: 'fs-server' } };
    const out = mcpUpsertMap(src, 'github', { command: 'gh' });
    assert(out.fs && out.fs.command === 'fs-server', 'sibling lost on add');
    assert(out.github && out.github.command === 'gh', 'new entry missing');
    assert(src.github === undefined, 'source mutated (not cloned)');
  });

  await run('upsert map: replaces an existing entry', () => {
    const src = { github: { command: 'old' } };
    const out = mcpUpsertMap(src, 'github', { command: 'new' });
    assert(out.github.command === 'new', 'entry not replaced');
  });

  await run('delete map: removes one, keeps the rest, clones', () => {
    const src = { fs: { command: 'fs' }, github: { command: 'gh' } };
    const out = mcpDeleteMap(src, 'github');
    assert(!('github' in out), 'target not deleted');
    assert(out.fs && out.fs.command === 'fs', 'sibling lost on delete');
    assert('github' in src, 'source mutated (not cloned)');
  });

  await run('set-enabled map: flips flag, preserves other config, clones', () => {
    const src = { github: { command: 'gh', args: ['-y'], enabled: true } };
    const out = mcpSetEnabledMap(src, 'github', false);
    assert(out.github.enabled === false, 'flag not applied');
    assert(out.github.command === 'gh' && out.github.args[0] === '-y', 'other config lost');
    assert(src.github.enabled === true, 'source mutated (not cloned)');
  });

  await run('set-enabled map: works for a name not yet in the map', () => {
    const out = mcpSetEnabledMap({}, 'new', true);
    assert(out.new && out.new.enabled === true, 'missing-key case not handled');
  });

  // --- mcpScopeOf -----------------------------------------------------------

  await run('scope-of: project overrides global', () => {
    const cfg = { global: { github: {} }, project: { github: {} } };
    assert(mcpScopeOf(cfg, 'github') === 'project', 'project override not detected');
  });

  await run('scope-of: falls back to global', () => {
    const cfg = { global: { github: {} }, project: {} };
    assert(mcpScopeOf(cfg, 'github') === 'global', 'global not detected');
  });

  await run('scope-of: unknown name defaults to global', () => {
    assert(mcpScopeOf({ global: {}, project: {} }, 'nope') === 'global', 'unknown should default global');
  });

  // --- mcpToolAllowed (mirrors Go ToolFilter.allowsTool) --------------------

  await run('tool filter: nil/empty allows all', () => {
    assert(mcpToolAllowed('anything', {}) === true, 'empty filter should allow');
    assert(mcpToolAllowed('anything', { allow: null }) === true, 'null allow should allow');
  });

  await run('tool filter: non-empty allow is strict', () => {
    assert(mcpToolAllowed('recall', { allow: ['recall', 'retain'] }) === true, 'allowed tool rejected');
    assert(mcpToolAllowed('delete_bank', { allow: ['recall', 'retain'] }) === false, 'unlisted tool allowed');
  });

  await run('tool filter: deny subtracts, including from allow', () => {
    assert(mcpToolAllowed('delete_bank', { deny: ['delete_bank'] }) === false, 'denied tool allowed');
    assert(mcpToolAllowed('retain', { allow: ['recall', 'retain'], deny: ['retain'] }) === false, 'deny should override allow');
  });

  // --- mcpSeedFormExtra -----------------------------------------------------

  await run('seed: extracts allow/deny and pretty-prints default args', () => {
    const seeded = mcpSeedFormExtra({ tools: { allow: ['recall'], deny: ['x'] }, defaultArguments: { bank_id: 'general' } });
    assert(Array.isArray(seeded.toolAllow) && seeded.toolAllow[0] === 'recall', 'allow not seeded');
    assert(seeded.toolDeny[0] === 'x', 'deny not seeded');
    assert(seeded.defaultArgsText.includes('bank_id'), 'default args not seeded');
    assert(seeded.toolsLoaded === false, 'should start not-loaded');
  });

  await run('seed: bare entry yields null allow and empty args', () => {
    const seeded = mcpSeedFormExtra({});
    assert(seeded.toolAllow === null, 'no allowlist should be null');
    assert(seeded.defaultArgsText === '', 'no args should be empty string');
  });

  // --- mcpFormToConfigExtra -------------------------------------------------

  await run('extra: loaded checkboxes drive an allowlist', () => {
    const out = mcpFormToConfigExtra({ toolsLoaded: true, toolNames: ['a', 'b', 'c'], toolChecked: { a: true, b: false, c: true }, defaultArgsText: '' });
    assert(out.tools && out.tools.allow.length === 2 && out.tools.allow[0] === 'a' && out.tools.allow[1] === 'c', 'allowlist wrong');
  });

  await run('extra: all tools checked omits the filter', () => {
    const out = mcpFormToConfigExtra({ toolsLoaded: true, toolNames: ['a', 'b'], toolChecked: { a: true, b: true }, defaultArgsText: '' });
    assert(!('tools' in out), 'fully-allowed server should omit tools');
  });

  await run('extra: offline edit preserves the seeded filter verbatim', () => {
    // The regression guard for the silent-wipe hazard: editing a server whose
    // tool list never loaded must NOT drop its tools/defaultArguments.
    const seeded = mcpSeedFormExtra({ tools: { allow: ['recall', 'retain'] }, defaultArguments: { bank_id: 'general' } });
    seeded.name = 'hindsight';
    seeded.mode = 'edit';
    const out = mcpFormToConfigExtra(seeded);
    assert(out.tools && out.tools.allow.length === 2, 'seeded allowlist was dropped');
    assert(out.defaultArguments && out.defaultArguments.bank_id === 'general', 'seeded default args were dropped');
  });

  await run('extra: parses fixed-arguments JSON object', () => {
    const out = mcpFormToConfigExtra({ toolsLoaded: false, defaultArgsText: '{"bank_id": "general", "tags": ["project:x"]}' });
    assert(out.defaultArguments.bank_id === 'general', 'scalar arg not parsed');
    assert(Array.isArray(out.defaultArguments.tags) && out.defaultArguments.tags[0] === 'project:x', 'array arg not parsed');
  });

  await run('extra: rejects malformed JSON', () => {
    let threw = false;
    try { mcpFormToConfigExtra({ toolsLoaded: false, defaultArgsText: '{not json}' }); } catch { threw = true; }
    assert(threw, 'malformed JSON should throw');
  });

  await run('extra: rejects a non-object JSON value', () => {
    let threw = false;
    try { mcpFormToConfigExtra({ toolsLoaded: false, defaultArgsText: '[1,2,3]' }); } catch { threw = true; }
    assert(threw, 'a JSON array should be rejected');
  });

  await run('extra: empty form yields no extra keys', () => {
    const out = mcpFormToConfigExtra({ toolsLoaded: false, toolAllow: null, toolDeny: [], defaultArgsText: '  ' });
    assert(!('tools' in out) && !('defaultArguments' in out), 'empty form should add nothing');
  });

  // --- pre-approval ---------------------------------------------------------
  // The Go manager ignores autoApprove in a project's mcp.json, so the form
  // writes it only into the global file and says so rather than offering a
  // checkbox that would be stored and never honoured.

  await run('pre-approval: seeded from the entry, off by default', () => {
    assert(mcpSeedFormExtra({ autoApprove: true }).autoApprove === true, 'seeded true');
    assert(mcpSeedFormExtra({}).autoApprove === false, 'default false');
  });

  await run('pre-approval: saved for a global server only', () => {
    const base = { toolsLoaded: false, toolAllow: null, toolDeny: [], defaultArgsText: '' };
    assert(mcpFormToConfigExtra({ ...base, autoApprove: true, scope: 'global' }).autoApprove === true, 'global: saved');
    assert(!('autoApprove' in mcpFormToConfigExtra({ ...base, autoApprove: true, scope: 'project' })), 'project: never written');
    assert(!('autoApprove' in mcpFormToConfigExtra({ ...base, autoApprove: false, scope: 'global' })), 'off: omitted');
  });

  await run('pre-approval: a checkbox for a global server, a hint for a project one', () => {
    const ctrl = /** @type {any} */ ({ editing: null, render: () => {} });
    const form = (/** @type {'global'|'project'} */ scope, /** @type {boolean} */ autoApprove) => {
      const f = { ...mcpSeedFormExtra({ autoApprove }), mode: 'add', name: '', scope };
      const wrap = document.createElement('div');
      renderMcpFormExtra(/** @type {any} */ (f), wrap, ctrl);
      return { f, cb: /** @type {HTMLInputElement|null} */ (wrap.querySelector('.mcp-auto-approve-input')), wrap };
    };
    const global = form('global', false);
    assert(!!global.cb && global.cb.checked === false, 'global: an unchecked checkbox');
    // A detached checkbox fires no change event in WebKit, so mount it.
    document.body.appendChild(global.wrap);
    try {
      global.cb.click();
    } finally {
      global.wrap.remove();
    }
    assert(global.f.autoApprove === true, 'checking it sets the form state');
    const project = form('project', false);
    assert(!project.cb, 'project: no checkbox');
    assert(/global/i.test(project.wrap.textContent || ''), `project: a hint naming the global scope: ${project.wrap.textContent}`);
  });

  // --- deep link: a tool leads back to the server that provides it -----------
  // The Tools list on the System Prompt item links each MCP tool to its server's
  // settings. `show()` fires its first refresh WITHOUT awaiting it, so the link
  // arrives before the config does — these pin that revealEntry waits, instead
  // of opening a form seeded from an empty config, which on screen is
  // indistinguishable from a config that failed to load.

  /**
   * A controller wired to a deliberately slow fake backend, reproducing the real
   * ordering: the deep link is requested immediately after show().
   * @param {number} delayMs - How long the fake config fetch takes
   * @returns {ConfigTabController} A shown controller (caller must stopPolling)
   */
  const shownController = (delayMs) => {
    const host = document.createElement('div');
    const config = {
      global: { linear: { transport: 'http', url: 'https://mcp.linear.app/mcp' } },
      project: {},
      hasProject: false,
    };
    const ctrl = new ConfigTabController(host, /** @type {any} */ ({
      id: 'mcp',
      noun: 'server',
      formHostSelector: '#mcp-form',
      pollMs: 100000,
      loadError: 'Failed to load MCP servers.',
      ops: {
        list: async () => [{ name: 'linear', status: 'running' }],
        getConfig: async () => {
          // eslint-disable-next-line juggler/no-private-test-wait -- the fake backend's slowness is the subject: the deep link must arrive before the config
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return config;
        },
      },
    }));
    ctrl.show();
    return ctrl;
  };

  await run('deep link: revealEntry waits for the config before seeding the form', async () => {
    const ctrl = shownController(20);
    try {
      assert(Object.keys(ctrl.config.global).length === 0, 'precondition: the config should not have landed yet');
      const ok = await ctrl.revealEntry('linear');
      assert(ok === true, 'revealEntry should report success for a known server');
      assert(ctrl.editing?.name === 'linear', `editing was ${JSON.stringify(ctrl.editing?.name)}`);
      assert(
        ctrl.editing?.transport === 'http',
        `form seeded with transport ${JSON.stringify(ctrl.editing?.transport)} — it did not wait for the config`
      );
      assert(ctrl.editing?.url === 'https://mcp.linear.app/mcp', 'the form did not carry the server url');
    } finally {
      ctrl.stopPolling();
    }
  });

  await run('deep link: an unknown server opens no form and says so', async () => {
    const ctrl = shownController(0);
    try {
      const ok = await ctrl.revealEntry('ghost');
      assert(ok === false, 'revealEntry should report failure for an unknown server');
      assert(!ctrl.editing, 'no form should open for a server that does not exist');
    } finally {
      ctrl.stopPolling();
    }
  });

  await run('deep link: an empty name is refused', async () => {
    const ctrl = shownController(0);
    try {
      assert(await ctrl.revealEntry('') === false, 'an empty name should be refused');
      assert(!ctrl.editing, 'no form should open');
    } finally {
      ctrl.stopPolling();
    }
  });

  // --- the notice line: a condition every row is blind to --------------------
  // With the MCP extension disabled, every server still starts, discovers its
  // tools, and reports "running" — and the model is offered none of them. Each
  // row is telling the truth and the page as a whole is wrong, so the notice
  // states it once, above the list.

  /**
   * A shown controller whose list renders into a real host, with a notice hook.
   * @param {() => Promise<string>} [notice] - The spec's notice hook
   * @returns {{ctrl: ConfigTabController, formHost: HTMLElement}} The controller and its mount point
   */
  const listController = (notice) => {
    const host = document.createElement('div');
    const formHost = document.createElement('div');
    formHost.id = 'notice-test-form';
    host.appendChild(formHost);
    const ctrl = new ConfigTabController(host, /** @type {any} */ ({
      id: 'mcp',
      noun: 'server',
      formHostSelector: '#notice-test-form',
      pollMs: 100000,
      loadError: 'Couldn\'t load MCP servers.',
      addLabel: 'Add server',
      emptyText: 'No MCP servers yet.',
      notice,
      ops: {
        list: async () => [{ name: 'linear', status: 'running', toolCount: 7 }],
        getConfig: async () => ({ global: { linear: { transport: 'http' } }, project: {}, hasProject: false }),
      },
      dotClass: () => 'running',
      dotTitle: () => 'running',
      describe: () => '7 tools',
      rowError: () => '',
      validateName: () => '',
    }));
    return { ctrl, formHost };
  };

  await run('notice: a disabled extension is stated above the rows', async () => {
    const { ctrl, formHost } = listController(async () => MCP_DISABLED_NOTICE);
    try {
      ctrl.show();
      await ctrl.ready;
      const notice = formHost.querySelector('.mcp-notice');
      assert(notice, 'no notice rendered');
      assert(notice.textContent === MCP_DISABLED_NOTICE, `notice was ${JSON.stringify(notice?.textContent)}`);
      const list = formHost.querySelector('.mcp-list');
      assert(list, 'the rows must still render');
      assert(
        notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
        'the notice must come before the rows it is about'
      );
    } finally {
      ctrl.stopPolling();
    }
  });

  // A project server from a cloned repository does not run until the user has
  // seen its command and trusted it, so its row offers that and nothing that
  // would pretend to start it.
  await run('trust: an untrusted project row offers Trust, not Restart', async () => {
    const host = document.createElement('div');
    const formHost = document.createElement('div');
    formHost.id = 'trust-test-form';
    host.appendChild(formHost);
    const ctrl = new ConfigTabController(host, /** @type {any} */ ({
      id: 'mcp',
      noun: 'server',
      formHostSelector: '#trust-test-form',
      pollMs: 100000,
      loadError: 'Failed to load MCP servers.',
      addLabel: 'Add server',
      emptyText: 'No MCP servers yet.',
      ops: {
        list: async () => [
          { name: 'repo', status: 'untrusted', enabled: true },
          { name: 'mine', status: 'running', enabled: true },
        ],
        getConfig: async () => ({
          global: { mine: { command: 'my-tool' } },
          project: { repo: { command: 'node', args: ['evil.js'] } },
          hasProject: true,
        }),
        restart: async () => {},
        trust: async () => {},
      },
      dotClass: (/** @type {any} */ s) => s.status,
      dotTitle: () => '',
      describe: () => '',
      rowError: () => '',
      validateName: () => '',
    }));
    try {
      ctrl.show();
      await ctrl.ready;
      const rows = [...formHost.querySelectorAll('.mcp-row')];
      /**
       * @param {string} name - Server name
       * @returns {string[]} The row's button labels
       */
      const buttons = (name) => {
        const row = rows.find((r) => r.querySelector('.mcp-entry-name')?.textContent === name);
        assert(row, `no row for ${name}`);
        return [...row.querySelectorAll('button')].map((b) => b.textContent || '');
      };
      const repo = buttons('repo');
      assert(repo.includes('Trust and start'), `untrusted row buttons: ${JSON.stringify(repo)}`);
      assert(!repo.includes('Restart'), `untrusted row must not offer Restart: ${JSON.stringify(repo)}`);
      const mine = buttons('mine');
      assert(mine.includes('Restart') && !mine.includes('Trust and start'), `running row buttons: ${JSON.stringify(mine)}`);
    } finally {
      ctrl.stopPolling();
    }
  });

  await run('notice: nothing to say means no line', async () => {
    const { ctrl, formHost } = listController(async () => '');
    try {
      ctrl.show();
      await ctrl.ready;
      assert(!formHost.querySelector('.mcp-notice'), 'an empty notice should render nothing');
      assert(formHost.querySelector('.mcp-list'), 'the rows must still render');
    } finally {
      ctrl.stopPolling();
    }
  });

  await run('notice: a failing hook never costs the user the list', async () => {
    const { ctrl, formHost } = listController(async () => { throw new Error('no config endpoint'); });
    try {
      ctrl.show();
      await ctrl.ready;
      assert(!formHost.querySelector('.mcp-notice'), 'a failed notice should render nothing');
      assert(formHost.querySelector('.mcp-list'), 'the rows must survive a failed notice');
      assert(ctrl.error === '', `a notice failure is not a load failure, error was ${JSON.stringify(ctrl.error)}`);
    } finally {
      ctrl.stopPolling();
    }
  });

  await run('notice: a tab with no notice hook behaves as before', async () => {
    const { ctrl, formHost } = listController(undefined);
    try {
      ctrl.show();
      await ctrl.ready;
      assert(!formHost.querySelector('.mcp-notice'), 'no hook should mean no notice');
      assert(formHost.querySelector('.mcp-list'), 'the rows must render');
    } finally {
      ctrl.stopPolling();
    }
  });

  // --- mcpToolMissReason ----------------------------------------------------
  // "No tool found" is one sentence for three different faults, and the model
  // reads it and tries again. These pin that each fault says which it is.

  await run('miss reason: a disabled extension is named as the cause', () => {
    const why = mcpToolMissReason({ server: 'linear', tool: 'create_issue', disabled: true, status: { status: 'running' } });
    assert(why === MCP_DISABLED_NOTICE, `reason was ${JSON.stringify(why)}`);
  });

  await run('miss reason: an unconfigured server says so', () => {
    const why = mcpToolMissReason({ server: 'ghost', tool: 'x', disabled: false, status: null });
    assert(why === 'No MCP server named "ghost" is configured.', `reason was ${JSON.stringify(why)}`);
  });

  await run('miss reason: a server switched off in settings says so', () => {
    const why = mcpToolMissReason({ server: 'linear', tool: 'x', disabled: false, status: { status: 'stopped', enabled: false } });
    assert(why.includes('turned off'), `reason was ${JSON.stringify(why)}`);
  });

  await run('miss reason: a failed server carries its own first error line', () => {
    const why = mcpToolMissReason({
      server: 'linear', tool: 'x', disabled: false,
      status: { status: 'failed', error: 'spawn ENOENT\nstack line that must not appear' },
    });
    assert(why.includes('is failed: spawn ENOENT'), `reason was ${JSON.stringify(why)}`);
    assert(!why.includes('stack line'), 'only the first line of the error belongs here');
  });

  // The case behind the report: everything healthy, tool still absent — because
  // it was hidden by a filter, or arrived after the turn was sent.
  await run('miss reason: a healthy server points at the filter and the timing', () => {
    const why = mcpToolMissReason({ server: 'linear', tool: 'create_issue', disabled: false, status: { status: 'running' } });
    assert(why.includes('is running'), `reason was ${JSON.stringify(why)}`);
    assert(why.includes('"create_issue"'), 'the tool that missed should be named');
    assert(why.includes('tool filter'), `reason was ${JSON.stringify(why)}`);
    assert(why.includes('after the turn was sent'), `reason was ${JSON.stringify(why)}`);
  });

  // --- en-XA: everything the MCP servers tab draws is a translated message ----
  // The real tab (its spec's copy, hooks and notice) with the backend stubbed:
  // ops through the spec, the extension config and listTools through fetch, so
  // nothing reaches the real server. Server names, tool names and server errors
  // are digit-only data, skipped where they stand alone.

  await run('en-XA: every state of the MCP servers tab is translated', async () => {
    await underPseudoLocale('mcp-settings-test', async () => {
      const originalFetch = window.fetch;
      const originalModal = /** @type {any} */ (window).showModal;
      const host = document.createElement('div');
      const formHost = document.createElement('div');
      formHost.id = 'mcp-form';
      host.appendChild(formHost);
      document.body.appendChild(host);
      const tab = new McpTab(host);
      const ctrl = tab.controller;
      // Data, or example values that are not messages.
      const skip = [
        '.mcp-entry-name', '.mcp-impl', '.provider-info > .mcp-error-hint',
        '.mcp-remove-row', '.mcp-reveal-btn',
        '.mcp-command-input', '.mcp-arg-input', '.mcp-env-key', '.mcp-url-input', '.mcp-header-key',
        '.mcp-default-args-input', '.mcp-tool-filter-name',
      ].join(', ');
      /** @param {string} where */
      const check = (where) => { assertPseudoLocalized(formHost, { skip, where }); };
      /**
       * @param {() => boolean} cond
       * @param {string} what
       */
      const until = async (cond, what) => {
        await waitFor(cond, { timeoutMs: 2000, intervalMs: 5, description: what });
      };
      /**
       * @param {string} selector
       * @param {string} what
       */
      const translated = (selector, what) => {
        const el = formHost.querySelector(selector);
        assert(el, `nothing drawn for ${what}`);
        assert(isPseudoLocalized(el.textContent || ''), `${what}: ${JSON.stringify(el?.textContent)}`);
      };
      const formError = (/** @type {string} */ what) => translated('.mcp-form > .mcp-error-hint', what);
      const banner = (/** @type {string} */ what) => translated(':scope > .mcp-error-hint', what);
      const field = (/** @type {string} */ cls) => /** @type {HTMLInputElement} */ (formHost.querySelector(`.mcp-${cls}`));
      try {
        resetExtensionsCache();
        window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
          const u = String(url);
          if (u.includes('/config/plugins')) {
            return { ok: true, status: 200, json: async () => ({ disabled: ['@juggler/mcp'] }) };
          }
          if (u.includes('/ops/call') && JSON.parse(init.body).operation === 'listTools') {
            const tools = JSON.parse(init.body).params.server === '1' ? [{ name: '1' }, { name: '2' }] : [];
            return { ok: true, status: 200, json: async () => ({ success: true, data: { tools } }) };
          }
          throw new Error(`unexpected fetch in test: ${u}`);
        });

        /** @type {any[]} */
        let items = [];
        /** @type {any} */
        let config = { global: {}, project: {}, hasProject: true };
        let failList = false;
        let failSet = false;
        /** @type {() => void} */
        let releaseLog = () => {};
        /** @type {() => void} */
        let releaseRestart = () => {};
        // Non-Error rejections reach the controller's own fallback messages.
        ctrl.spec = {
          ...ctrl.spec,
          ops: {
            list: async () => { if (failList) throw 'down'; return items; },
            getConfig: async () => config,
            setConfig: async (/** @type {any} */ _scope, /** @type {any} */ map) => {
              if (failSet) throw 'refused';
              config = { ...config, global: map };
            },
            restart: () => new Promise((_resolve, reject) => { releaseRestart = () => reject('busy'); }),
            getLog: () => new Promise((resolve) => { releaseLog = () => resolve(''); }),
          },
        };

        await ctrl.refresh();
        assert(formHost.querySelector('.mcp-empty'), 'empty state not drawn');
        check('empty list');

        // Populated: every status, a disabled entry, both scopes, the notice.
        items = [
          { name: '1', status: 'running', enabled: true, toolCount: 3, schemaTokens: 400, serverName: '7', serverVersion: '8' },
          { name: '2', status: 'starting', toolCount: 1 },
          { name: '3', status: 'stopped', enabled: false },
          { name: '4', status: 'failed', error: '9\nmore' },
        ];
        config = {
          global: { 1: { command: '5', tools: { allow: ['1', '3'] } }, 2: { command: '5' }, 3: { command: '5', enabled: false } },
          project: { 4: { transport: 'http', url: '6' } },
          hasProject: true,
        };
        await ctrl.refresh();
        assert(formHost.querySelector('.mcp-notice'), 'the disabled-extension notice was not drawn');
        assert(formHost.querySelectorAll('.mcp-row').length === 4, 'rows not drawn');
        const rowErr = formHost.querySelector('.provider-info > .mcp-error-hint');
        assert(rowErr && rowErr.textContent === '9', `a server's own error is data, was ${JSON.stringify(rowErr?.textContent)}`);
        check('populated list');

        failList = true;
        await ctrl.refresh();
        banner('load failure');
        failList = false;
        await ctrl.refresh();

        // Log disclosure: loading, then empty.
        const logOpen = ctrl._toggleLog('1');
        assert(formHost.querySelector('.mcp-log-view'), 'log view not drawn');
        check('log loading');
        releaseLog();
        await logOpen;
        check('log empty');
        await ctrl._toggleLog('1');

        // Actions with a refresh held off, so each action's own error is shown.
        const restartBtn = /** @type {HTMLButtonElement} */ (formHost.querySelector('.mcp-row .mcp-btn-row button'));
        assert(restartBtn, 'no restart button');
        ctrl.busy = true;
        const restarting = ctrl._restart('1', restartBtn);
        assert(isPseudoLocalized(restartBtn.textContent || ''), `restarting: ${JSON.stringify(restartBtn.textContent)}`);
        releaseRestart();
        await restarting;
        ctrl.render();
        banner('restart failure');

        failSet = true;
        await ctrl._setEnabled('global', '1', false);
        ctrl.render();
        banner('toggle failure');

        /** @type {any} */
        let asked = null;
        /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked = options; return true; };
        await ctrl._confirmDelete('global', '1');
        assert(asked, 'no delete confirm');
        for (const key of ['title', 'message', 'confirmText']) {
          assert(isPseudoLocalized(String(asked[key] || '')), `delete confirm ${key}: ${JSON.stringify(asked[key])}`);
        }
        ctrl.render();
        banner('delete failure');
        ctrl.busy = false;
        failSet = false;
        await ctrl.refresh();

        // Add form, stdio, with an argument and a variable row.
        ctrl.openForm('add');
        for (const btn of formHost.querySelectorAll('.mcp-add-row')) /** @type {HTMLElement} */ (btn).click();
        assert(formHost.querySelector('.mcp-arg-input') && formHost.querySelector('.mcp-env-row'), 'repeat rows not drawn');
        check('add form (stdio)');
        const iconButtons = formHost.querySelectorAll('.mcp-remove-row, .mcp-reveal-btn');
        assert(iconButtons.length === 3, `expected 3 icon buttons, found ${iconButtons.length}`);
        for (const btn of iconButtons) {
          const label = btn.getAttribute('aria-label') || '';
          assert(isPseudoLocalized(label), `icon button aria-label: ${JSON.stringify(label)}`);
        }

        for (const [name, what] of [['', 'blank name'], ['a b', 'spaced name'], ['a/b', 'slashed name'], ['juggler', 'reserved name'], ['1', 'duplicate name']]) {
          field('name-input').value = name;
          await ctrl._save();
          formError(what);
        }
        field('name-input').value = '9';
        field('command-input').value = '';
        await ctrl._save();
        formError('missing command');
        field('command-input').value = '5';
        field('env-key').value = '';
        field('env-value').value = '5';
        await ctrl._save();
        formError('unnamed variable');
        field('env-value').value = '';
        ctrl.editing.defaultArgsText = '{';
        await ctrl._save();
        formError('malformed fixed arguments');
        ctrl.editing.defaultArgsText = '[1]';
        await ctrl._save();
        formError('non-object fixed arguments');
        ctrl.editing.defaultArgsText = '';
        failSet = true;
        await ctrl._save();
        formError('save failure');
        check('add form with an error');
        failSet = false;

        // Remote transport, with a header row.
        const transport = /** @type {HTMLSelectElement} */ (formHost.querySelector('.mcp-transport-input'));
        transport.value = 'http';
        transport.dispatchEvent(new Event('change'));
        /** @type {HTMLElement} */ (formHost.querySelector('.mcp-add-row')).click();
        assert(formHost.querySelector('.mcp-url-input') && formHost.querySelector('.mcp-header-row'), 'remote fields not drawn');
        check('add form (remote)');
        for (const btn of formHost.querySelectorAll('.mcp-remove-row, .mcp-reveal-btn')) {
          const label = btn.getAttribute('aria-label') || '';
          assert(isPseudoLocalized(label), `header icon button aria-label: ${JSON.stringify(label)}`);
        }
        await ctrl._save();
        formError('missing URL');
        field('url-input').value = '6';
        field('header-key').value = '';
        field('header-value').value = '5';
        await ctrl._save();
        formError('unnamed header');
        field('header-value').value = '';
        await ctrl._save();
        assert(!ctrl.editing, 'a valid save should close the form');

        // Edit: tools loading, then the filter with a configured name the server
        // no longer offers, then a server offering none.
        ctrl.openForm('edit', { name: '1' });
        check('edit form, tools loading');
        await until(() => !!ctrl.editing?.toolsLoaded, 'the tool list');
        assert(formHost.querySelector('.mcp-tool-filter-list'), 'tool filter not drawn');
        check('edit form, tools loaded');
        ctrl.openForm('edit', { name: '2' });
        await until(() => !!ctrl.editing?.toolsLoaded, 'the empty tool list');
        check('edit form, no tools');
      } finally {
        window.fetch = originalFetch;
        /** @type {any} */ (window).showModal = originalModal;
        tab.dispose();
        host.remove();
        resetExtensionsCache();
      }
    });
  });

  return { passed, failed, errors };
}
