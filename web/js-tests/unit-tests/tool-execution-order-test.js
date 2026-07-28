//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Default-mode tool scheduling tests.
 *
 * The `default` execution mode preserves the order the model emitted: runs of
 * consecutive read/meta calls fire in parallel, but a write flushes any pending
 * reads and runs sequentially — so a read the model placed *after* a write never
 * runs before it. These tests pin that contract by driving `executeToolCalls`
 * with stubbed category lookup + single-tool execution that records a start/end
 * event log, then asserting on that log.
 * @module unit-tests/tool-execution-order-test
 */

import { assert } from '../utilities/test-helpers.js';
import { toolExecutor } from '../../js/services/tool-executor.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Build a minimal tool call. The name doubles as the log label; `input` and `id`
 * are only present because `executeToolCalls` validates their shape.
 * @param {string} name
 * @returns {{id: string, name: string, input: object}} A minimal tool call.
 */
function call(name) {
  return { id: `id-${name}`, name, input: {} };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  // Stub the two collaborators executeToolCalls reaches for, on the shared
  // singleton, and restore them after the suite. `_buildCategoryMap` returns a
  // fixed name→category map; `_executeSingleTool` records a start/end event and
  // yields several microtasks between them so a genuinely-parallel sibling has a
  // chance to start before this one finishes.
  const origBuildCategoryMap = toolExecutor._buildCategoryMap;
  const origExecuteSingleTool = toolExecutor._executeSingleTool;

  /** @type {Map<string, string>} */
  const categories = new Map([
    ['read_a', 'read'],
    ['read_b', 'read'],
    ['read_c', 'read'],
    ['meta_m', 'meta'],
    ['write_x', 'write'],
    ['write_y', 'write'],
  ]);

  /** @type {string[]} */
  let log = [];

  // @ts-ignore - test stub
  toolExecutor._buildCategoryMap = async () => categories;
  // @ts-ignore - test stub
  toolExecutor._executeSingleTool = async (toolCall) => {
    log.push(`${toolCall.name}:start`);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    log.push(`${toolCall.name}:end`);
    return { toolName: toolCall.name, success: true, resultStatus: 'success' };
  };

  /**
   * Run a batch through the default scheduler and return the event log.
   * @param {string[]} names
   * @returns {Promise<{log: string[], outcomes: any[]}>} The event log and returned outcomes.
   */
  const schedule = async (names) => {
    log = [];
    const outcomes = await toolExecutor.executeToolCalls(
      names.map(call),
      /** @type {any} */ ({}),
      /** @type {any} */ ({}),
    );
    return { log, outcomes };
  };

  /**
   * Index of an event in the log (asserts it is present).
   * @param {string[]} events
   * @param {string} event
   * @returns {number} The index of the event in the log.
   */
  const idx = (events, event) => {
    const i = events.indexOf(event);
    assert(i !== -1, `expected event ${event} in log ${JSON.stringify(events)}`);
    return i;
  };

  try {
    await run('consecutive reads run in parallel', async () => {
      const { log: events } = await schedule(['read_a', 'read_b', 'read_c']);
      // All three start before any finishes → they overlapped.
      const lastStart = Math.max(idx(events, 'read_a:start'), idx(events, 'read_b:start'), idx(events, 'read_c:start'));
      const firstEnd = Math.min(idx(events, 'read_a:end'), idx(events, 'read_b:end'), idx(events, 'read_c:end'));
      assert(lastStart < firstEnd, `expected all reads to start before any ended, got ${JSON.stringify(events)}`);
    });

    await run('a read emitted after a write never starts before that write finishes', async () => {
      const { log: events } = await schedule(['write_x', 'read_a']);
      assert(idx(events, 'read_a:start') > idx(events, 'write_x:end'),
        `expected read to start only after write completed, got ${JSON.stringify(events)}`);
    });

    await run('reads before a write are flushed before the write starts', async () => {
      const { log: events } = await schedule(['read_a', 'read_b', 'write_x']);
      const readsDone = Math.max(idx(events, 'read_a:end'), idx(events, 'read_b:end'));
      assert(idx(events, 'write_x:start') > readsDone,
        `expected write to start only after preceding reads finished, got ${JSON.stringify(events)}`);
      // But the two reads still overlapped with each other.
      const lastStart = Math.max(idx(events, 'read_a:start'), idx(events, 'read_b:start'));
      const firstEnd = Math.min(idx(events, 'read_a:end'), idx(events, 'read_b:end'));
      assert(lastStart < firstEnd, `expected the two reads to run in parallel, got ${JSON.stringify(events)}`);
    });

    await run('writes run strictly one at a time in order', async () => {
      const { log: events } = await schedule(['write_x', 'write_y']);
      assert(idx(events, 'write_y:start') > idx(events, 'write_x:end'),
        `expected write_y to start only after write_x finished, got ${JSON.stringify(events)}`);
    });

    await run('interleaved batch preserves emitted order across the write boundary', async () => {
      // read_a,read_b (parallel) → write_x → read_c (must wait for write_x).
      const { log: events } = await schedule(['read_a', 'read_b', 'write_x', 'read_c']);
      const firstGroupDone = Math.max(idx(events, 'read_a:end'), idx(events, 'read_b:end'));
      assert(idx(events, 'write_x:start') > firstGroupDone,
        `expected write after first read group, got ${JSON.stringify(events)}`);
      assert(idx(events, 'read_c:start') > idx(events, 'write_x:end'),
        `expected trailing read after write, got ${JSON.stringify(events)}`);
    });

    await run('meta tools batch alongside reads', async () => {
      const { log: events } = await schedule(['read_a', 'meta_m']);
      const lastStart = Math.max(idx(events, 'read_a:start'), idx(events, 'meta_m:start'));
      const firstEnd = Math.min(idx(events, 'read_a:end'), idx(events, 'meta_m:end'));
      assert(lastStart < firstEnd, `expected read+meta to run in parallel, got ${JSON.stringify(events)}`);
    });

    await run('outcomes are returned in the original emitted order', async () => {
      const names = ['read_a', 'write_x', 'read_b', 'write_y', 'read_c'];
      const { outcomes } = await schedule(names);
      const returned = outcomes.map((/** @type {any} */ o) => o.toolName);
      assert(JSON.stringify(returned) === JSON.stringify(names),
        `expected outcomes in emitted order, got ${JSON.stringify(returned)}`);
    });
  } finally {
    toolExecutor._buildCategoryMap = origBuildCategoryMap;
    toolExecutor._executeSingleTool = origExecuteSingleTool;
  }

  return { passed, failed, errors };
}
