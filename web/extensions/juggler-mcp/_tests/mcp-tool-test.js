//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP tool bridge's pure decision logic: LLM tool naming,
 * read/write category mapping from the read-only annotation, description
 * fallback/truncation, the escalating approval-suggestion ladder, and the
 * rule-matching that auto-approves calls. The live stdio round-trip (discovery,
 * tools/call, crash/restart) is covered by the Go manager tests.
 * @module unit-tests/mcp-tool-test
 */

import { assert, createTestSession, createTestConversation, initializeRegistries } from '../../../js-tests/utilities/test-helpers.js';
import {
  mcpLLMName,
  buildToolDefinition,
  mcpRuleValues,
  mcpApprovalSuggestions,
  mcpIsPermitted,
  storeMcpImages
} from '../context-items/mcp-tool-context-item.js';
import McpToolContextItem from '../context-items/mcp-tool-context-item.js';
import McpCommandType from '../commands/mcp-command-type.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import {
  isPseudoLocalized, registerCatalog, messageKey, pseudoLocalize, PSEUDO_LOCALE,
} from '../../../sdk/lib/i18n.js';

/** This extension's English for what the en-XA case draws, standing in for its catalogue. */
const MCP_TEXT = [
  'MCP', 'MCP tool', 'Calling {label}…', '{label} — tool reported an error', '{label} failed',
  'Result', 'Server', 'Tool', 'Arguments', 'MCP: {server} / {tool}', 'tool',
  '{description}\n\nArguments:\n\n{arguments}', 'Arguments:\n\n{arguments}',
  'all read-only tools on "{server}"', 'all tools on "{server}" (trust this server)',
  'Usage: /mcp {subcommand} <server>', 'MCP "{server}" recent output:\n\n{log}',
  'No recent output for "{server}".',
  'Unknown subcommand "{subcommand}". Try: /mcp, /mcp start|stop|restart <server>, /mcp reload, /mcp logs <server>',
  'MCP command failed: {error}',
  'No MCP servers configured. Add them to ~/.juggler/mcp.json or <project>/.juggler/mcp.json.',
  'MCP servers:',
  '• {server} — {status}{version} · {count, plural, one {{count} tool} other {{count} tools}}',
  '• {server} — {status}{version} · {count, plural, one {{count} tool} other {{count} tools}} · ~{tokens} tokens/request',
  'running', 'starting', 'stopped', 'failed', 'disabled',
];

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

  /**
   * @param {boolean} ro - Read-only flag
   * @returns {import('../context-items/mcp-tool-context-item.js').McpToolInfo} A discovered-tool fixture
   */
  const tool = (ro) => ({
    server: 'github', name: 'create_issue', title: 'Create Issue',
    description: 'Create a GitHub issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    readOnly: ro, destructive: !ro, schemaTokens: 10
  });

  await run('/mcp states schema tokens as it always has in English', () => {
    for (const [n, want] of [[500, '500'], [1000, '1.0k'], [1234, '1.2k'], [12345, '12.3k'], [1234567, '1234.6k']]) {
      const got = McpCommandType.__fmtTokensForTests(/** @type {number} */ (n));
      assert(got === want, `${n}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  });

  await run('llm name is mcp__server__tool', () => {
    assert(mcpLLMName('github', 'create_issue') === 'mcp__github__create_issue', 'unexpected name');
  });

  await run('read-only tool maps to read category', () => {
    const def = buildToolDefinition(tool(true));
    assert(def.category === 'read', `want read, got ${def.category}`);
    assert(def.name === 'mcp__github__create_issue', 'name mismatch');
    assert(def.input_schema.type === 'object', 'schema not passed through');
  });

  await run('mutating tool maps to write category (destructive-by-default)', () => {
    assert(buildToolDefinition(tool(false)).category === 'write', 'want write');
  });

  await run('missing schema defaults to an object schema', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: '', description: 'd', inputSchema: null, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.input_schema && def.input_schema.type === 'object', 'no default schema');
  });

  await run('empty description falls back to a synthesized one', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: 'T', description: '', inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.description.includes('via MCP server "s"'), `weak fallback: ${def.description}`);
  });

  await run('overlong description is truncated with an ellipsis', () => {
    const def = buildToolDefinition({ server: 's', name: 't', title: 'T', description: 'x'.repeat(5000), inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 0 });
    assert(def.description.endsWith('…'), 'not truncated');
    assert(def.description.length <= 1100, `too long: ${def.description.length}`);
  });

  await run('approval ladder: read-only tool offers exact → readonly → server', () => {
    const s = mcpApprovalSuggestions({ server: 'github', tool: 'get_issue', readOnly: true });
    assert(s.length === 3, `want 3 tiers, got ${s.length}`);
    assert(s.every((x) => x.itemType === 'mcp-tool'), 'wrong itemType');
    const values = s.map((x) => x.rules?.[0]?.value);
    assert(values[0] === 'github/get_issue', 'exact tier wrong');
    assert(values.includes('github/#readonly'), 'missing readonly tier');
    assert(values.includes('github/*'), 'missing server-wide tier');
  });

  await run('approval ladder: mutating tool omits the readonly tier', () => {
    const s = mcpApprovalSuggestions({ server: 'github', tool: 'create_issue', readOnly: false });
    assert(s.length === 2, `want 2 tiers, got ${s.length}`);
    const values = s.map((x) => x.rules?.[0]?.value);
    assert(!values.includes('github/#readonly'), 'readonly tier should be absent');
  });

  await run('each suggestion, once applied, makes isPermitted true (the contract)', () => {
    const target = { server: 'github', tool: 'get_issue', readOnly: true };
    for (const s of mcpApprovalSuggestions(target)) {
      const values = new Set((s.rules ?? []).map((r) => String(r.value)));
      assert(mcpIsPermitted(values, target), `suggestion ${[...values]} did not permit the call`);
    }
  });

  await run('isPermitted: exact and server-wide grants approve; readonly gated by annotation', () => {
    const rv = mcpRuleValues('github', 'create_issue');
    assert(mcpIsPermitted(new Set([rv.exact]), { server: 'github', tool: 'create_issue', readOnly: false }), 'exact should approve');
    assert(mcpIsPermitted(new Set([rv.all]), { server: 'github', tool: 'create_issue', readOnly: false }), 'server-wide should approve');
    // #readonly grant must NOT approve a non-read-only tool.
    assert(!mcpIsPermitted(new Set([rv.readonly]), { server: 'github', tool: 'create_issue', readOnly: false }), 'readonly grant leaked to a mutating tool');
    // ...but does approve a read-only one.
    assert(mcpIsPermitted(new Set([rv.readonly]), { server: 'github', tool: 'create_issue', readOnly: true }), 'readonly grant should approve a read-only tool');
    // Empty grants never approve.
    assert(!mcpIsPermitted(new Set(), { server: 'github', tool: 'create_issue', readOnly: true }), 'empty set should not approve');
    // A grant for a different server must not approve.
    assert(!mcpIsPermitted(new Set(['other/*']), { server: 'github', tool: 'create_issue', readOnly: false }), 'cross-server leak');
  });

  await run('isPermitted: a pre-approved server needs no grant', () => {
    assert(mcpIsPermitted(new Set(), { server: 'github', tool: 'create_issue', readOnly: false, autoApprove: true }), 'autoApprove should approve with no rules');
    assert(!mcpIsPermitted(new Set(), { server: 'github', tool: 'create_issue', readOnly: false, autoApprove: false }), 'no autoApprove, no rules: ask');
  });

  // The setting reaches the item through the snapshot the Go manager serves, so
  // a fresh copy of the module loads a stubbed one: one tool of a pre-approved
  // server and one of a server that still asks.
  await run('a tool whose snapshot says autoApprove is permitted without a rule', async () => {
    const originalFetch = window.fetch;
    try {
      window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
        const { operation } = JSON.parse(init.body);
        if (!String(url).includes('/ops/call') || operation !== 'snapshot') throw new Error(`unexpected fetch in test: ${url} ${operation}`);
        const t = (/** @type {string} */ server, /** @type {boolean} */ autoApprove) => ({
          server, name: 'act', title: '', description: '', inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 1, autoApprove
        });
        return { ok: true, status: 200, json: async () => ({ success: true, data: { complete: true, tools: [t('pre', true), t('ask', false)] } }) };
      });
      const url = new URL('../context-items/mcp-tool-context-item.js', import.meta.url);
      url.search = '?auto-approve';
      /** @type {any} */
      const fresh = await import(url.href);
      const Cls = fresh.default;
      await Cls.prepareToolDefinitions();
      assert(Cls.getToolDefinitions().length === 2, 'the stubbed snapshot did not load');
      const stubSession = { platform: 'darwin', home: '/1', projectPath: '/2' };
      const thread = { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] };
      const make = (/** @type {string} */ toolName) => new Cls({
        id: 'x', session: stubSession, conversation: { id: 'c', session: stubSession }, messageThread: thread, toolName
      });
      assert(make('mcp__pre__act').isPermitted({}) === true, 'a pre-approved server\'s tool should be permitted');
      assert(make('mcp__ask__act').isPermitted({}) === false, 'a server without autoApprove should still ask');
    } finally {
      window.fetch = originalFetch;
    }
  });

  // "Don't ask again" on an MCP call saves its suggestion with no scope of its
  // own, so the scope is the item type's default. Like a shell pattern, the
  // grant belongs to the project: a new conversation must not ask again.
  await run('a grant saved without a scope lasts for every conversation of the project', async () => {
    await initializeRegistries();
    const session = await createTestSession();
    const a = await createTestConversation(session);
    const b = await createTestConversation(session);
    a.rootMessageThread.clearRules('mcp-tool');
    const [, trust] = mcpApprovalSuggestions({ server: 'github', tool: 'create_issue', readOnly: false });
    const rule = trust?.rules?.[0];
    if (!trust?.itemType || !rule) throw new Error(`want a server-wide suggestion with one rule, got ${JSON.stringify(trust)}`);
    const created = a.rootMessageThread.addRule(trust.itemType, { ...rule });
    assert(created.scope === 'session', `want session scope, got ${created.scope}`);
    const seen = b.rootMessageThread.getRulesFor('mcp-tool').find((r) => r.value === 'github/*');
    assert(!!seen, 'a second conversation does not see the grant');
    a.rootMessageThread.clearRules('mcp-tool');
  });

  await run('permission popup lists MCP grants, toggles their scope and deletes them', async () => {
    await initializeRegistries();
    const session = await createTestSession();
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('mcp-tool');
    assert(McpToolContextItem.getPermissionSection(mt) === null, 'no grants: no section');
    const all = mt.addRule('mcp-tool', { kind: 'glob', value: 'github/*' });
    mt.addRule('mcp-tool', { kind: 'glob', value: 'github/#readonly' });
    mt.addRule('mcp-tool', { kind: 'glob', value: 'linear/get_issue' });
    const section = /** @type {any} */ (McpToolContextItem.getPermissionSection(mt));
    try {
      assert(section && section.id === 'mcp-tool', 'section missing');
      document.body.appendChild(section.element);
      const texts = () => Array.from(section.element.querySelectorAll('.pattern-text')).map((el) => el.textContent);
      assert(JSON.stringify(texts()) === JSON.stringify(['github: all tools', 'github: all read-only tools', 'linear: get_issue']), `rows: ${JSON.stringify(texts())}`);
      const scopeBtn = /** @type {HTMLElement} */ (section.element.querySelector(`.rule-scope-btn[data-rule-id="${all.id}"]`));
      assert(scopeBtn.dataset.scope === 'session', `want session, got ${scopeBtn.dataset.scope}`);
      scopeBtn.click();
      assert(mt.getRulesFor('mcp-tool').find((r) => r.id === all.id)?.scope === 'conversation', 'scope toggle did not move the rule');
      /** @type {HTMLElement} */ (section.element.querySelector(`.pattern-delete-btn[data-rule-id="${all.id}"]`)).click();
      assert(!mt.getRulesFor('mcp-tool').some((r) => r.id === all.id), 'delete did not remove the rule');
      assert(texts().length === 2, `after delete: ${JSON.stringify(texts())}`);
    } finally {
      section?.dispose?.();
      section?.element?.remove();
      mt.clearRules('mcp-tool');
    }
  });

  // An MCP server's image (a screenshot tool's) reaches the model as an image
  // part, as a read image does, and its bytes never sit in the document.
  await run('image blocks are stored as attachments; no block keeps its bytes', async () => {
    /** @type {any[]} */
    const uploads = [];
    const upload = async (/** @type {string} */ conv, /** @type {string} */ data, /** @type {string} */ mime) => {
      uploads.push([conv, data, mime]);
      if (data === 'ZmFpbA==') throw new Error('disk full');
      return { id: 'a'.repeat(64), mime, bytes: 4, width: 2, height: 2 };
    };
    const { blocks, images } = await storeMcpImages([
      { type: 'text', text: 'here' },
      { type: 'image', mimeType: 'image/png', data: 'cG5n' },
      { type: 'image', mimeType: 'image/svg+xml', data: 'c3Zn' },
      { type: 'image', mimeType: 'image/png', data: 'ZmFpbA==' },
      { type: 'audio', mimeType: 'audio/wav', data: 'd2F2' },
    ], { upload, conversationId: 'conv-1' });
    assert(images.length === 1 && images[0]?.id === 'a'.repeat(64), `one image stored: ${JSON.stringify(images)}`);
    assert(uploads.length === 2 && uploads[0][0] === 'conv-1' && uploads[0][2] === 'image/png', `only supported images are uploaded: ${JSON.stringify(uploads)}`);
    assert(blocks.every((b) => !('data' in b)), `no block keeps its bytes: ${JSON.stringify(blocks)}`);
    assert(blocks[0]?.text === 'here' && blocks[1]?.attached === 'a'.repeat(64), `blocks: ${JSON.stringify(blocks)}`);
    assert(/not a type/.test(String(blocks[2]?.note)) && /disk full/.test(String(blocks[3]?.note)), `why one was not attached: ${JSON.stringify(blocks)}`);
    const none = await storeMcpImages([{ type: 'image', mimeType: 'image/png', data: 'cG5n' }], { upload, conversationId: undefined });
    const [onlyBlock] = none.blocks;
    assert(none.images.length === 0 && onlyBlock !== undefined && !('data' in onlyBlock), 'with no conversation, nothing is stored and the bytes still go');
  });

  await run('an attached image rides the summary and is named in its text', async () => {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const item = new McpToolContextItem({ id: 'mcp-tool', session, conversation, messageThread: conversation.rootMessageThread });
    const ref = { id: 'b'.repeat(64), mime: 'image/png', bytes: 4, width: 3, height: 4 };
    const summary = /** @type {any} */ (item.getSummary({
      success: true,
      result: { text: 'took a screenshot', isError: false, images: [ref],
        content: [{ type: 'text', text: 'took a screenshot' }, { type: 'image', mimeType: 'image/png', attached: ref.id }] }
    }));
    assert(summary.attachments?.length === 1 && summary.attachments[0].id === ref.id, `attachments: ${JSON.stringify(summary.attachments)}`);
    assert(String(summary.summary) === 'took a screenshot\n[image: image/png, 3×4, attached below]', `text: ${summary.summary}`);
  });

  // Under en-XA everything the user reads is translated: the rows, the details
  // labels, the approval text and buttons, and every /mcp message. What the
  // model reads stays English. Server and tool names are digits, so they read
  // as data inside a message. A fresh copy of the module loads a stubbed
  // snapshot, so the known-tool branches run without a real MCP server.
  await run('en-XA: rows, labels, approval text and /mcp messages are translated; the model reads English', async () => {
    const originalFetch = window.fetch;
    try {
      await underPseudoLocale('mcp-tool-test', async () => {
        // The `k` message has a context, which the plain-source list above cannot
        // carry, so the extension's stand-in catalogue is registered again with it.
        registerCatalog('@juggler/mcp', PSEUDO_LOCALE, {
          ...Object.fromEntries(MCP_TEXT.map((s) => [s, pseudoLocalize(s)])),
          [messageKey('{n}k', 'thousands, in a compact count')]: pseudoLocalize('{n}k'),
        });
        /** @type {Record<string, string>} */
        const shown = {};
        let failOp = '';
        /** @type {any[]} */
        let servers = [];
        let log = '';
        /**
         * @param {any} data
         * @returns {any} A stub fetch response carrying it
         */
        const reply = (data) => ({ ok: true, status: 200, json: async () => data });
        window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
          const u = String(url);
          if (!u.includes('/ops/call')) throw new Error(`unexpected fetch in test: ${u}`);
          const { operation } = JSON.parse(init.body);
          if (operation === failOp) return reply({ success: false, error: '7' });
          switch (operation) {
            case 'snapshot':
              return reply({ success: true, data: { complete: true, tools: [{
                server: '1', name: '2', title: '', description: '5', inputSchema: {},
                readOnly: true, destructive: false, schemaTokens: 1
              }] } });
            case 'listServers':
            case 'serverControl':
              return reply({ success: true, data: { servers } });
            case 'getLog':
              return reply({ success: true, data: { log } });
          }
          throw new Error(`unexpected op in test: ${operation}`);
        });

        const url = new URL('../context-items/mcp-tool-context-item.js', import.meta.url);
        url.search = '?en-xa';
        /** @type {any} */
        const fresh = await import(url.href);
        const Cls = fresh.default;
        await Cls.prepareToolDefinitions();
        assert(Cls.getToolDefinitions().length === 1, 'the stubbed snapshot did not load');

        const stubSession = { platform: 'darwin', home: '/1', projectPath: '/2' };
        const thread = { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] };
        const make = (/** @type {string} */ toolName) => new Cls({
          id: 'x', session: stubSession, conversation: { id: 'c', session: stubSession }, messageThread: thread, toolName
        });
        const item = make('mcp__1__2');
        const row = (/** @type {string} */ name, /** @type {any} */ ui) => {
          shown[`${name} row`] = String(ui?.summary);
          shown[`${name} type name`] = String(ui?.typeName);
        };
        row('pending', item.getStatusUI({ pending: true }, {}));
        row('tool reported an error', item.getStatusUI({ success: true, result: { isError: true } }, {}));
        row('failed', item.getStatusUI({ success: false, error: '9' }, {}));
        row('cancelled', item.getStatusUI({ cancelled: true }, {}));
        row('pending, no tool name', make('').getStatusUI({ pending: true }, {}));
        shown['getTypeName'] = Cls.getTypeName();
        shown['result section'] = Cls.getResultSectionLabel('mcp__1__2');

        /** @type {string[]} */
        const labels = [];
        item.renderToolActionDetails(document.createElement('div'), {
          input: { 3: 4 }, toolName: 'mcp__1__2',
          helpers: { addSubsection: (/** @type {any} */ _w, /** @type {string} */ label) => labels.push(label) }
        });
        assert(labels.length === 3, `details labels: ${JSON.stringify(labels)}`);
        labels.forEach((l, i) => { shown[`details label ${i}`] = l; });

        const approval = await item.getApprovalConfig({ 3: 4 });
        shown['approval title'] = String(approval?.title);
        shown['approval message'] = String(approval?.message);
        const bare = await make('').getApprovalConfig({});
        shown['approval title, unknown tool'] = String(bare?.title);
        shown['approval message, no description'] = String(bare?.message);
        const suggestions = item.getApprovalSuggestions({});
        assert(suggestions.length === 3, `suggestions: ${JSON.stringify(suggestions)}`);
        suggestions.forEach((/** @type {any} */ s, /** @type {number} */ i) => { if (s.label) shown[`suggestion ${i}`] = s.label; });

        // The model's side stays English.
        const failedSummary = item.getSummary({ success: false });
        assert(String(failedSummary.summary) === 'MCP tool call failed', `failure summary: ${failedSummary.summary}`);
        const empty = item.getSummary({ success: true, result: { content: [], text: '', isError: false } });
        assert(String(empty.summary) === '(no content)', `empty summary: ${empty.summary}`);
        const invalid = await make('mcp__9__9').validate({});
        assert(String(invalid.error).startsWith('Unknown MCP tool "mcp__9__9"'), `validate error: ${invalid.error}`);
        const def = fresh.buildToolDefinition({ server: '1', name: '2', title: '', description: '', inputSchema: {}, readOnly: false, destructive: true, schemaTokens: 0 });
        assert(def.description === '2 (via MCP server "1")', `tool description: ${def.description}`);

        const cmd = new McpCommandType(/** @type {any} */ ({ messageThread: {} }));
        const say = async (/** @type {string} */ name, /** @type {string[]} */ args) => {
          shown[name] = String((await cmd.execute(args))?.message);
        };
        await say('/mcp, no servers', []);
        servers = [
          { name: '1', status: 'running', serverName: '3', serverVersion: '4', toolCount: 1, schemaTokens: 500 },
          { name: '2', status: 'failed', toolCount: 2, error: '6\n7' },
          { name: '8', status: 'stopped', toolCount: 0 },
          // Past a thousand the count carries a `k`, which is translated too.
          { name: '5', status: 'running', toolCount: 3, schemaTokens: 1234 },
        ];
        const list = String((await cmd.execute(['restart', '1']))?.message);
        // Each line is its own message; the error line under a server is data.
        list.split('\n').forEach((line, i) => { if (/[A-Za-z]/.test(line)) shown[`/mcp list line ${i}`] = line; });
        assert(list.split('\n').length === 6, `list: ${JSON.stringify(list)}`);
        await say('/mcp start, no server', ['start']);
        await say('/mcp logs, no server', ['logs']);
        // The subcommand is the identifier the user typed, inserted as data.
        for (const [name, sub] of /** @type {Array<[string, string]>} */ ([['/mcp start, no server', 'start'], ['/mcp logs, no server', 'logs']])) {
          const text = shown[name] ?? '';
          assert(text.includes(` ${sub} `), `${name}: ${text}`);
          shown[name] = text.replace(` ${sub} `, ' ');
        }
        log = '8';
        await say('/mcp logs', ['logs', '1']);
        log = '';
        await say('/mcp logs, empty', ['logs', '1']);
        await say('/mcp, unknown subcommand', ['9']);
        failOp = 'serverControl';
        await say('/mcp, failed', ['reload']);

        const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
        if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
      }, { '@juggler/mcp': MCP_TEXT });
    } finally {
      window.fetch = originalFetch;
    }
  });

  return { passed, failed, errors };
}
