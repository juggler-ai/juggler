//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for Juggler's background-monitoring tools (Monitor / TaskOutput /
 * TaskStop). This suite pins:
 *   1. all three tools are registered and resolve by name (exact,
 *      case-insensitive, and through the `mcp__juggler__` prefix);
 *   2. they appear in generateToolDefinitions() with the expected schema;
 *   3. approval policy: Monitor (shell exec) requires approval; TaskOutput /
 *      TaskStop do not;
 *   4. Monitor shares the `execute` permission domain, so a grant already given
 *      to bash auto-approves the equivalent monitor without re-prompting;
 *   5. a persistent monitor asks for no deadline; a non-persistent one keeps
 *      its capped timeout.
 * @module unit-tests/monitor-tools
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { generateToolDefinitions, resolveToolName } from '../../js/services/tool-generator.js';
import { MAX_EXEC_TIMEOUT_MS } from '../../js/services/ops-api.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run monitor-tools tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: All three tools resolve by name (exact / case-insensitive / mcp).
  // =========================================================================
  try {
    assert(contextItemRegistry.getByToolName('Monitor') !== undefined, 'Monitor should be registered');
    assert(contextItemRegistry.getByToolName('TaskOutput') !== undefined, 'TaskOutput should be registered');
    assert(contextItemRegistry.getByToolName('TaskStop') !== undefined, 'TaskStop should be registered');
    // KillShell is an alias of TaskStop — same item, different name/param.
    assert(contextItemRegistry.getByToolName('KillShell') === contextItemRegistry.getByToolName('TaskStop'),
      'KillShell should resolve to the same item as TaskStop');

    // Case-insensitive fallback (model may lowercase).
    assert(contextItemRegistry.getByToolName('monitor') !== undefined, 'monitor (lowercase) should resolve');

    // The `mcp__juggler__` prefix the Claude CLI adds must strip back to the tool.
    assert(resolveToolName('mcp__juggler__Monitor') === 'Monitor', 'mcp prefix should strip to Monitor');
    assert(contextItemRegistry.getByToolName(resolveToolName('mcp__juggler__TaskOutput')) !== undefined,
      'prefixed TaskOutput should resolve after resolveToolName');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`tool resolution: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: generateToolDefinitions() includes all three with harness schema.
  // =========================================================================
  try {
    const tools = await generateToolDefinitions();
    const byName = new Map(tools.map(t => [t.name, t]));

    const monitor = byName.get('Monitor');
    assert(monitor !== undefined, 'Monitor should be in generated tool definitions');
    const props = /** @type {any} */ (monitor).input_schema.properties;
    assert(props.command && props.description && props.persistent && props.timeout_ms,
      'Monitor schema should expose command/description/persistent/timeout_ms');
    assert(JSON.stringify(/** @type {any} */ (monitor).input_schema.required) === JSON.stringify(['command', 'description']),
      'Monitor should require command + description');

    const taskOutput = byName.get('TaskOutput');
    assert(taskOutput !== undefined, 'TaskOutput should be in generated tool definitions');
    assert(/** @type {any} */ (taskOutput).input_schema.properties.task_id, 'TaskOutput should take task_id');

    const taskStop = byName.get('TaskStop');
    assert(taskStop !== undefined, 'TaskStop should be in generated tool definitions');
    assert(/** @type {any} */ (taskStop).input_schema.properties.task_id, 'TaskStop should take task_id');

    const killShell = byName.get('KillShell');
    assert(killShell !== undefined, 'KillShell should be in generated tool definitions');
    assert(/** @type {any} */ (killShell).input_schema.properties.shell_id, 'KillShell should take shell_id');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`tool definitions: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: Approval policy — Monitor requires approval, companions do not.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;

    const make = (/** @type {string} */ toolName) => {
      const Cls = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      return new Cls({ id: Cls.MANIFEST.id, session, conversation, messageThread: mt });
    };

    assert(make('Monitor').requiresApproval() === true, 'Monitor should require approval');
    assert(make('TaskOutput').requiresApproval() === false, 'TaskOutput should not require approval');
    assert(make('TaskStop').requiresApproval() === false, 'TaskStop should not require approval');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`approval policy: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: Monitor shares the `execute` permission domain.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const MonitorClass = /** @type {any} */ (contextItemRegistry.getByToolName('Monitor'));
    const monitor = new MonitorClass({ id: MonitorClass.MANIFEST.id, session, conversation, messageThread: mt });

    assert(monitor.getPermissionKey({}) === 'execute', 'Monitor should use the execute permission key');

    // A non-safelisted command on a fresh thread (no execute grant) → not
    // auto-approved. (`frobnicate` is not a read-only safe command.)
    mt.clearRules('execute');
    assert(monitor.isPermitted({ command: 'frobnicate --watch' }) === false,
      'Monitor should not be auto-approved without an execute grant');

    // An execute grant the user already gave bash auto-approves the monitor.
    mt.addRule('execute', { kind: 'glob', value: 'frobnicate *', scope: 'conversation' });
    assert(monitor.isPermitted({ command: 'frobnicate --watch' }) === true,
      'Monitor should auto-approve when the command is already permitted by an execute rule');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`shared permission domain: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 5: The timeout each kind of monitor asks the backend for. A persistent
  // monitor runs until TaskStop or the session ends, so it must ask for no
  // deadline (-1, the startBackground sentinel) — the 20-minute cap would kill
  // a long CI watch silently. A non-persistent one keeps its capped timeout.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const MonitorClass = /** @type {any} */ (contextItemRegistry.getByToolName('Monitor'));
    const monitor = new MonitorClass({ id: MonitorClass.MANIFEST.id, session, conversation, messageThread: mt });
    /** @type {Array<number|undefined>} */
    const asked = [];
    monitor._ops = {
      shellBackground: async (/** @type {any} */ p) => { asked.push(p.timeout); return { task_id: `t${asked.length}` }; }
    };
    mt.requestTaskOutputDelivery = () => {};

    const run = async (/** @type {Record<string, unknown>} */ params) => {
      await monitor.execute({ command: 'tail -f log', description: 'log', ...params });
      return asked[asked.length - 1];
    };

    const persistent = await run({ persistent: true });
    assert(persistent === -1, `a persistent monitor should ask for no deadline (-1), asked for ${persistent}`);
    const persistentIgnoresTimeout = await run({ persistent: true, timeout_ms: 5000 });
    assert(persistentIgnoresTimeout === -1, `a persistent monitor should ignore timeout_ms, asked for ${persistentIgnoresTimeout}`);
    const capped = await run({ timeout_ms: 99999999 });
    assert(capped === MAX_EXEC_TIMEOUT_MS, `a non-persistent monitor's timeout should be capped, asked for ${capped}`);
    const plain = await run({ timeout_ms: 5000 });
    assert(plain === 5000, `a non-persistent monitor should honour timeout_ms, asked for ${plain}`);
    const dflt = await run({});
    assert(dflt === undefined, `a non-persistent monitor without timeout_ms should take the backend default, asked for ${dflt}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`monitor timeouts: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
