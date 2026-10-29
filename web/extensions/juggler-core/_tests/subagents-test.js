//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shipped sub-agents, `Explore` and `Research`.
 *
 * A sub-agent is a delegating context item that owns a hidden strategy: the tool
 * call runs as a child thread under a tool filter, approval policy and brief the
 * item defines, and only the child's answer comes back.
 *
 * The load-bearing test here is the **no-hang invariant**. A sub-agent thread has
 * no human in it, and `APPROVAL_POLICY` has no DENY — so a tool the strategy
 * exposes but cannot auto-approve does not prompt anybody, it strands the
 * caller's tool_use forever. Every tool that survives `filterTools` must
 * therefore be either auto-approved by `getApprovalPolicy` or refused by
 * `onToolPending`. That is asserted below against the real core tool list.
 *
 * Both shipped sub-agents are descriptors over `SubagentContextItem`, so the
 * cases below run against each in turn: a third sub-agent should pass them by
 * existing, and any that starts failing marks behaviour that has drifted out of
 * the shared base.
 * @module _tests/subagents-test
 */

import { initializeRegistries, assert } from '../../../js-tests/utilities/test-helpers.js';
import strategyRegistry from '../../../js/registries/strategy-registry.js';
import { generateToolDefinitions } from '../../../js/services/tool-generator.js';
import { APPROVAL_POLICY } from '../../../sdk/strategy-type.js';
import ContextItem, { INTERACTION_KIND } from '../../../sdk/context-item.js';
import ExploreAgentContextItem from '../context-items/explore-agent-context-item.js';
import ResearchAgentContextItem from '../context-items/research-agent-context-item.js';
import SubagentContextItem from '../context-items/subagents/subagent-item.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

// Only the fields StrategyType's constructor dereferences.
const FAKE_MESSAGE_THREAD = /** @type {any} */ ({ conversation: { session: {} } });

/**
 * The two sub-agents, described by what each test needs to know about them.
 * Both take the same `task` argument: one concept, one name, whichever tool a
 * caller picks.
 * @type {Array<{label: string, Item: any, strategyId: string, toolName: string}>}
 */
const SUBAGENTS = [
  { label: 'Explore', Item: ExploreAgentContextItem, strategyId: 'subagent-explore', toolName: 'Explore' },
  { label: 'Research', Item: ResearchAgentContextItem, strategyId: 'subagent-research', toolName: 'Research' }
];

/**
 * Instantiate an item the way the engine does for one tool call.
 * @param {any} Item - The context-item class
 * @returns {any} An instance with the minimum context it needs
 */
function makeItem(Item) {
  return new Item({ id: 'tu-1', session: {}, conversation: {}, messageThread: FAKE_MESSAGE_THREAD });
}

/**
 * Run all sub-agent tests.
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
  // The generator's own typedef leaves `input_schema` as a bare object; what
  // it builds is the strategy SDK's ToolDefinition, which `filterTools` takes.
  const allTools = /** @type {import('../../../sdk/strategy-type.js').ToolDefinition[]} */ (await generateToolDefinitions());

  for (const { label, Item, strategyId, toolName } of SUBAGENTS) {
    await run(`${label}: owns exactly one hidden strategy`, () => {
      const classes = Item.getStrategies();
      assert(classes.length === 1, `expected 1 owned strategy, got ${classes.length}`);
      assert(classes[0].MANIFEST.id === strategyId,
        `owned strategy id = ${classes[0].MANIFEST.id}, want ${strategyId}`);
      assert(classes[0].MANIFEST.hidden === true, `${strategyId} must be hidden`);
      assert(strategyRegistry.has(strategyId),
        `${strategyId} must be registered (via the item's getStrategies hook)`);
    });

    await run(`${label}: declares one delegating tool`, () => {
      assert(Item.MANIFEST.delegatesToSubthread === true,
        `${label} must delegate — running a sub-agent inline defeats the point`);
      // Not merely "may delegate": there is no inline sub-agent, so the flag that
      // says so is what lets the worker withhold the tool on turns that cannot
      // delegate, rather than offering a call whose only outcome is an error.
      assert(Item.MANIFEST.requiresDelegation === true,
        `${label} has no inline path, so it must declare requiresDelegation`);
      const stamped = allTools.find(t => t.name === toolName);
      assert(stamped?.requiresDelegation === true,
        `${toolName}'s generated definition must carry requiresDelegation through to the worker`);
      // A sub-agent investigates and reports; if one of these ever gains a tool
      // that changes the working tree, this is the assertion that should stop it,
      // because the flag is what lets the reducer run a batch of them at once.
      assert(Item.MANIFEST.readOnlySubthread === true,
        `${label} only reads, so it must declare readOnlySubthread — that is what lets siblings run at once`);
      assert(stamped?.readOnlySubthread === true,
        `${toolName}'s generated definition must carry readOnlySubthread through to the worker`);
      const defs = Item.getToolDefinitions();
      assert(defs.length === 1 && defs[0].name === toolName,
        `expected one tool named ${toolName}`);
      assert(defs[0].input_schema.required.includes('goal'),
        `${toolName} must require a short user-facing goal separate from the task`);
      assert(defs[0].input_schema.required.includes('task'),
        `${toolName} must require "task" — the child sees nothing of the caller's conversation`);
      assert('session' in defs[0].input_schema.properties,
        `${toolName} must expose its returned session handle for follow-up calls`);
      assert(!('resultSpec' in defs[0].input_schema.properties),
        `${toolName} must not expose resultSpec: the pre-shaped return contract is what it adds over create_thread`);
    });

    await run(`${label}: routes as an action with execute() inherited`, () => {
      // The tool dispatcher splits actions from seeding items by asking whether
      // execute() is implemented. These items inherit theirs from the shared
      // base, so a check for an OWN execute would route them to onToolCall
      // instead — where the base no-ops, and the caller's tool call quietly
      // returns nothing at all.
      assert(Item.isActionItem(),
        `${label} must report as an action; it implements execute() through SubagentContextItem`);
    });

    await run(`${label}: inline fallthrough reports no invented cause`, async () => {
      let message = '';
      try {
        await makeItem(Item).execute({});
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      assert(message.includes(`${toolName} couldn't start a sub-agent`),
        `fallthrough must name ${toolName} and say no sub-agent started; got "${message}"`);
      assert(message.includes(Item.SUBAGENT.fallback),
        `fallthrough must preserve ${toolName}'s actionable fallback`);
      assert(!/engine|timed? out|in time/i.test(message),
        `fallthrough cannot claim an engine timeout it cannot prove; got "${message}"`);
    });

    await run(`${label}: its brief carries the rules every sub-agent needs`, () => {
      const guidance = /** @type {any} */ (strategyRegistry.get(strategyId)).GUIDANCE;
      assert(/refused/i.test(guidance),
        `${strategyId}'s brief must say approval-needing calls are refused — the agent cannot discover that from inside the run`);
      assert(/could not find/i.test(guidance),
        `${strategyId}'s brief must ask for honest gaps; the caller cannot see the evidence behind the answer`);
    });

    await run(`${label}: pins its own strategy on the delegated child`, async () => {
      const item = makeItem(Item);
      const spec = await item.buildSubthreadSpec({
        goal: 'Trace auth flow',
        task: 'where is auth handled?',
        session: 'auth-hunt'
      });
      assert(spec && spec.goal === 'Trace auth flow',
        'the short user-facing goal must stay separate from the detailed task');
      assert(spec && spec.prompt.includes('where is auth handled?'),
        'the spec must carry the caller-supplied task verbatim');
      assert(spec.resultSpec, 'a sub-agent synthesises its own resultSpec');
      assert(spec.sessionName === 'auth-hunt', 'the public session argument must pass through');
      assert(spec.strategyId === strategyId,
        `spec.strategyId = ${spec.strategyId}, want ${strategyId}`);
    });

    await run(`${label}: degrades instead of failing when its strategy is unregistered`, async () => {
      // The user disabled the extension's strategies. The tool must still work —
      // the child just runs under the caller's strategy instead of a filtered one.
      const saved = strategyRegistry.__itemsForTests().get(strategyId);
      strategyRegistry.__itemsForTests().delete(strategyId);
      try {
        const spec = await makeItem(Item).buildSubthreadSpec({ goal: 'Anything', task: 'anything' });
        assert(spec && !spec.strategyId,
          'with the strategy gone the spec must omit strategyId, not name a missing one');
      } finally {
        if (saved) strategyRegistry.__itemsForTests().set(strategyId, saved);
      }
    });

    await run(`${label}: nothing it exposes can park (the no-hang invariant)`, () => {
      const strategy = strategyRegistry.createStrategy(strategyId, FAKE_MESSAGE_THREAD);
      const exposed = strategy.filterTools(allTools);
      assert(exposed.length > 0, `${strategyId} filtered every tool away`);

      // AskUserQuestion has category 'read', so a naive read-only filter KEEPS
      // it — and as an elicitation it can be neither approved nor refused, which
      // makes it the one tool that would genuinely wedge a run.
      assert(!exposed.some(t => t.name === 'AskUserQuestion'),
        'AskUserQuestion must not survive the filter — nobody is there to answer it');
      for (const name of ['todo', 'plan', 'memory', 'define_command', 'new_conversation']) {
        assert(!exposed.some(t => t.name === name),
          `${name} steers the caller's session and must not survive the filter`);
      }
      // Delegation is disabled inside a delegated thread, so a tool with no
      // inline path could only ever fail here. Asserted by flag rather than by
      // name: this is the same test the worker applies, and a third-party
      // sub-agent must be covered by it without editing anything.
      for (const t of exposed) {
        assert(!t.requiresDelegation,
          `${t.name} cannot delegate from inside a sub-agent, so it must not be offered`);
      }
      for (const name of ['Explore', 'Research']) {
        assert(!exposed.some(t => t.name === name),
          `${name} is delegation-only and must not survive the filter`);
      }
      for (const t of exposed) {
        assert(t.category !== 'write' || t.name === 'bash',
          `${strategyId} exposes the write tool ${t.name}; a sub-agent changes nothing`);
      }

      // Every survivor: auto-approved when the permission system raised no
      // question, and refused (never left parked) when it did.
      for (const t of exposed) {
        const approved = strategy.getApprovalPolicy({
          toolName: t.name, toolInput: {}, category: t.category,
          defaultApproval: false, interactionKind: INTERACTION_KIND.GATE, autoApprovable: true
        });
        assert(approved === APPROVAL_POLICY.APPROVE,
          `${t.name} would not be auto-approved (${approved}) — it would park with nobody to approve it`);
      }

      // Typed by a cast rather than a declaration: the assignment happens in a
      // callback, which control-flow narrowing of a declared `null` cannot see.
      let refused = /** @type {{id: string, reason: string}|null} */ (null);
      let denied = false;
      const thread = /** @type {any} */ ({
        conversation: { session: {} },
        refuseApproval: (/** @type {string} */ id, /** @type {string} */ reason) => { refused = { id, reason }; return true; },
        resolveApproval: () => { denied = true; return true; }
      });
      const parking = strategyRegistry.createStrategy(strategyId, thread);
      parking.onToolPending({ toolUseId: 'tu-parked', toolName: 'bash', toolInput: {}, category: 'write', permissionKey: 'execute' });
      assert(refused !== null && refused.id === 'tu-parked',
        'a parked call must be refused outright, not left waiting for a human who is not there');
      assert(/bash/.test(refused?.reason ?? ''),
        'the refusal must name the call that failed, so the sub-agent can work around it');
      // A cancelled call is how a human denial is recorded, and the worker stops
      // the turn on one. Refusing that way would end the sub-agent's run at its
      // first awkward call rather than letting it carry on.
      assert(!denied,
        'a refusal must not go through resolveApproval — a cancelled call reads as a denial and stops the run');
    });
  }

  await run('a sub-agent with no descriptor fails by name, not by silently misbehaving', () => {
    class NamelessSubagent extends SubagentContextItem {}
    let message = '';
    try {
      NamelessSubagent.getToolDefinitions();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert(/NamelessSubagent/.test(message) && /SUBAGENT/.test(message),
      `a subclass without a descriptor must say which class and what is missing; got "${message}"`);
  });

  await run('isActionItem sees only an implemented execute()', () => {
    // The negative half of the routing check above: a seeding item must NOT be
    // dragged onto the action path by the abstract execute() every item inherits
    // from ContextItem.
    class SeedingItem extends ContextItem {}
    assert(!SeedingItem.isActionItem(),
      'an item that implements no execute() is not an action, whatever it inherits');
  });

  await run('the two sub-agents withhold what the other is for', () => {
    const explore = strategyRegistry.createStrategy('subagent-explore', FAKE_MESSAGE_THREAD).filterTools(allTools).map(t => t.name);
    const research = strategyRegistry.createStrategy('subagent-research', FAKE_MESSAGE_THREAD).filterTools(allTools).map(t => t.name);

    for (const name of ['WebSearch', 'WebFetch', 'exa_search']) {
      assert(!explore.includes(name), `Explore must withhold ${name} — the network is Research's job`);
    }
    assert(!research.includes('bash'), 'Research must withhold bash — it reads, it does not run things');
    assert(explore.includes('grep') && explore.includes('read') && explore.includes('query_code'),
      'Explore keeps the codebase search tools');
    assert(research.includes('read') && research.includes('grep'),
      'Research keeps enough local read access to check what is actually installed');
  });

  return { passed, failed, errors };
}
