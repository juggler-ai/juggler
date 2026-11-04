//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent's MCP server restart tool: when it is offered, what
 * a restart reports back for a server that came up and one that did not, and
 * which saved rules let it run without asking. The restart itself, and the
 * wait for its outcome, are covered by the Go manager tests.
 * @module unit-tests/mcp-server-restart-test
 */

import { assert, createTestSession, createTestConversation } from '../../../js-tests/utilities/test-helpers.js';
import McpServerRestartContextItem, {
  RESTART_TOOL_NAME,
  restartToolDefinitions,
  restartMcpServer,
  restartIsPermitted,
  restartApprovalSuggestions
} from '../context-items/mcp-server-restart-context-item.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** This item's English the en-XA case draws, standing in for its catalogue. */
const RESTART_TEXT = [
  'MCP', 'Restarting {server}…', 'Restarted {server}', '{server} did not come back ({status})',
  'Restarting {server} failed', 'Restart MCP server "{server}"',
  'Stops the server and starts it again with its current configuration. Juggler and your conversations keep running.',
  'restarting "{server}"', 'restarting any MCP server',
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
   * Ops doubles: a restart that settles the named server as `status`, and the
   * log a failed one would leave.
   * @param {{status: string, error?: string, toolCount?: number, serverName?: string, serverVersion?: string}} settled - The server's state once settled
   * @param {string} [log] - Its recent stderr
   * @returns {{calls: Array<Record<string, unknown>>, control: (p: any) => Promise<any>, log: (p: any) => Promise<{log: string}>}} Doubles and their calls
   */
  const fakeOps = (settled, log = '') => {
    /** @type {Array<Record<string, unknown>>} */
    const calls = [];
    return {
      calls,
      control: async (p) => {
        calls.push(p);
        return { servers: [{ name: 'other', status: 'running', toolCount: 9 }, { name: 'rea', enabled: true, toolCount: 0, ...settled }] };
      },
      log: async (p) => {
        calls.push({ log: p.server });
        return { log };
      }
    };
  };

  /** @returns {Promise<McpServerRestartContextItem>} An item in a fresh test conversation */
  const makeItem = async () => {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    return new McpServerRestartContextItem({ id: 'mcp-server-restart', session, conversation, messageThread: conversation.rootMessageThread });
  };

  await run('no tool is offered when no MCP server is configured', () => {
    assert(restartToolDefinitions([]).length === 0, 'a tool was offered with no servers');
  });

  await run('one write tool is offered once a server is configured, the same for any set of servers', () => {
    const one = restartToolDefinitions([{ name: 'rea' }]);
    const two = restartToolDefinitions([{ name: 'rea' }, { name: 'github' }]);
    assert(one.length === 1, `want one tool, got ${one.length}`);
    const def = /** @type {any} */ (one[0]);
    assert(def.name === RESTART_TOOL_NAME, `unexpected name ${def.name}`);
    assert(def.category === 'write', `want write, got ${def.category}`);
    assert(Array.isArray(def.input_schema.required) && def.input_schema.required.includes('server'), 'server is not required');
    // The definition rides the cached prompt prefix, so adding a server must not change it.
    assert(JSON.stringify(one) === JSON.stringify(two), 'the definition depends on which servers are configured');
  });

  await run('the description tells the model a restart needs no Juggler restart, and where env belongs', () => {
    const desc = /** @type {any} */ (restartToolDefinitions([{ name: 'rea' }])[0]).description;
    assert(/without restarting Juggler/i.test(desc), `missing the no-Juggler-restart fact: ${desc}`);
    assert(/"env"/.test(desc) && /mcp\.json/.test(desc), `missing where a server's variables belong: ${desc}`);
  });

  await run('a restart asks to be answered once the server has settled, and reports it running', async () => {
    const ops = fakeOps({ status: 'running', toolCount: 4, serverName: 'rea-mcp', serverVersion: '1.2.0' });
    const r = await restartMcpServer('rea', ops);
    const call = ops.calls[0] || {};
    assert(call.server === 'rea' && call.action === 'restart' && call.wait === true, `unexpected control call ${JSON.stringify(call)}`);
    assert(r.status === 'running' && r.toolCount === 4, `unexpected result ${JSON.stringify(r)}`);
    assert(!ops.calls.some((c) => 'log' in c), 'fetched the log of a server that came up');
  });

  await run('a restart that did not come up reports its error and recent output', async () => {
    const ops = fakeOps({ status: 'failed', error: 'connect: EOF' }, 'Error: JADX_JAR is not set\n');
    const r = await restartMcpServer('rea', ops);
    assert(r.status === 'failed', `want failed, got ${r.status}`);
    assert(r.error === 'connect: EOF', `error not carried: ${r.error}`);
    assert(String(r.log).includes('JADX_JAR is not set'), `log not carried: ${r.log}`);
  });

  await run('the summary of a failed restart is a failure the model can read the cause from', async () => {
    const item = await makeItem();
    const s = item.getSummary({ success: true, result: { server: 'rea', status: 'failed', error: 'connect: EOF', log: 'JADX_JAR is not set' } });
    assert(s.success === false, 'a failed restart summarised as success');
    assert(s.summary.includes('connect: EOF') && s.summary.includes('JADX_JAR is not set'), `cause missing: ${s.summary}`);
  });

  await run('the summary of a restart that came up says so', async () => {
    const item = await makeItem();
    const s = item.getSummary({ success: true, result: { server: 'rea', status: 'running', toolCount: 4 } });
    assert(s.success === true, 'a running restart summarised as failure');
    assert(s.summary.includes('rea') && s.summary.includes('running'), `unexpected summary: ${s.summary}`);
  });

  await run('a saved rule for the server, or for every server, lets it restart without asking', () => {
    assert(!restartIsPermitted(new Set(), 'rea'), 'permitted with no rules');
    assert(!restartIsPermitted(new Set(['github']), 'rea'), 'another server\'s rule permitted it');
    assert(restartIsPermitted(new Set(['rea']), 'rea'), 'its own rule did not permit it');
    assert(restartIsPermitted(new Set(['*']), 'rea'), 'the every-server rule did not permit it');
  });

  await run('every "don\'t ask again" choice is one its rule then permits', () => {
    for (const s of restartApprovalSuggestions('rea')) {
      const values = new Set((s.rules || []).map((/** @type {{value: unknown}} */ r) => String(r.value)));
      assert(restartIsPermitted(values, 'rea'), `suggestion ${JSON.stringify(s)} does not permit the call`);
    }
  });

  // Everything the user reads is translated; what the model reads stays English.
  // Server names and statuses are digits, so they read as data in a message.
  await run('en-XA: status rows, approval text and choices are translated; the model reads English', async () => {
    const item = await makeItem();
    await underPseudoLocale('mcp-server-restart-test', async () => {
      /** @type {string[]} */
      const shown = [];
      const input = { server: '1' };
      const pending = item.getStatusUI(/** @type {any} */ ({ pending: true }), input);
      const up = item.getStatusUI(/** @type {any} */ ({ success: true, result: { status: 'running' } }), input);
      const down = item.getStatusUI(/** @type {any} */ ({ success: true, result: { status: '2' } }), input);
      const broke = item.getStatusUI(/** @type {any} */ ({ success: false, error: '3' }), input);
      for (const s of [pending, up, down, broke]) shown.push(String(s?.summary ?? ''), String(s?.typeName ?? ''));
      const approval = await item.getApprovalConfig(input);
      shown.push(String(approval.title), String(approval.message));
      for (const s of restartApprovalSuggestions('1')) shown.push(String(s.label));
      const raw = shown.filter((s) => s && !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      const summary = item.getSummary({ success: true, result: { server: '1', status: 'running', toolCount: 2 } }).summary;
      assert(!isPseudoLocalized(summary) && /restarted/.test(summary), `the model's result was translated: ${summary}`);
    }, { '@juggler/mcp': RESTART_TEXT });
  });

  return { passed, failed, errors };
}
