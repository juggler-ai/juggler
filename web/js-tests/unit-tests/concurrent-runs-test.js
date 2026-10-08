//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Several threads running at once, as the viewer sees it.
 *
 * The worker admits any number of read-only children beside one write-capable
 * run, so `processingState.runs` routinely holds more than one entry — each
 * describing its own thread's work. Everything here is a consequence of that:
 * two columns spin at once, each counting from its own start, and a thread
 * holding no run is idle no matter how busy its siblings are.
 *
 * Driven through the real LLMState with hand-built worker frames rather than a
 * live conversation: the frames ARE the contract between the worker and the
 * viewer, and writing them out makes the multi-run shape explicit instead of
 * hoping a scheduler produces it.
 * @module unit-tests/concurrent-runs-test
 */

import { assert } from '../utilities/test-helpers.js';
import LLMState from '../../js/services/llm-state.js';
import { getThreadStatus } from '../../js/utils/thread-display.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A conversation stub with just the surface LLMState uses: an id, a metadata
 * observer, and a metadata read. Enough to drive the real state machine.
 * @param {string} id
 * @returns {any} the stub
 */
function stubConversation(id) {
  /** @type {((event: any) => void)[]} */
  const observers = [];
  /** @type {Map<string, any>} */
  const metadata = new Map();
  return {
    id,
    observeMetadata: (/** @type {any} */ fn) => observers.push(fn),
    unobserveMetadata: (/** @type {any} */ fn) => {
      const i = observers.indexOf(fn);
      if (i >= 0) observers.splice(i, 1);
    },
    getMetadata: (/** @type {string} */ key) => metadata.get(key),
    /**
     * Publish a processingState frame the way the worker's Yjs write does.
     * @param {any} state
     */
    publish(state) {
      metadata.set('processingState', state);
      for (const fn of [...observers]) fn({ keysChanged: new Set(['processingState']) });
    },
  };
}

/**
 * Build a worker frame from a set of runs, projecting one of them at the top
 * level exactly as the worker does (see cmd/juggler/worker/activity_state.go).
 * @param {Array<{threadItemId: string, status: string, startedAt: number, outputTokens?: number, inputTokens?: number, cachedTokens?: number}>} runs
 * @param {number} projected - Index of the run the projection names
 * @returns {any} A processingState frame
 */
function frame(runs, projected = 0) {
  /** @type {Record<string, any>} */
  const byKey = {};
  for (const run of runs) {
    byKey[run.threadItemId || 'root'] = { ...run, activity: 'calling_llm', claimedAt: run.startedAt };
  }
  const lead = runs[projected];
  return {
    ...lead,
    activity: 'calling_llm',
    claimedAt: lead.startedAt,
    runs: byKey,
  };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const now = Date.now();

  // --- 1: two runs at once → two spinners, each with its own elapsed digit ---
  // The root has been going a minute; a read-only child started five seconds
  // ago. Each column counts from ITS OWN start, so the two status lines differ.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-two-live');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 65000, outputTokens: 120 },
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 5000, outputTokens: 7 },
    ]));

    const live = llm.getLiveThreadMessages(conv.id);
    assert(Object.keys(live).length === 2,
      `two runs must produce two live status lines; got ${JSON.stringify(live)}`);
    assert(!!live[''] && !!live['child-a'],
      `both the root and the child must have a line of their own; got ${JSON.stringify(live)}`);
    assert(live[''] !== live['child-a'],
      `each run must report its own work, not a shared conversation line; both said '${live['']}'`);
    assert(live[''].includes('120') && live['child-a'].includes('7'),
      `each line must carry its own token count; got '${live['']}' and '${live['child-a']}'`);
    // The elapsed digit rides the same line, off each run's own startedAt.
    assert(live[''].includes('1m') || live[''].includes('65'),
      `the minute-old run must show its own elapsed time; got '${live['']}'`);
    assert(live['child-a'].includes('5s'),
      `the five-second-old run must show its own elapsed time; got '${live['child-a']}'`);

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`two live runs each report themselves: ${msg(e)}`);
  }

  // --- 2: the busy barrier is per thread ---
  // A send goes to ONE thread. While two others run, a third is idle and its
  // send must not be queued behind them — the worker would take it.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-barrier');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 1000 },
      { threadItemId: 'child-a', status: 'processing_tools', startedAt: now - 1000 },
    ]));

    assert(llm.isConversationProcessing(conv.id) === true,
      'the conversation is busy while any of its threads is running');
    assert(llm.isThreadProcessing(conv.id, null) === true,
      'the root holds a run, so it reports busy');
    assert(llm.isThreadProcessing(conv.id, 'child-a') === true,
      'the running child reports busy');
    assert(llm.isThreadProcessing(conv.id, 'child-b') === false,
      'a thread holding no run is idle, however busy its siblings are — this is the barrier a send asks');

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`per-thread busy barrier: ${msg(e)}`);
  }

  // --- 3: one run resting leaves its siblings alone ---
  // The child settles while the root streams on. Only the child's spinner goes;
  // the root keeps its line, its tokens and its anchor.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-sibling-rest');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 30000, outputTokens: 400 },
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 2000, outputTokens: 9 },
    ]));
    const before = llm.getThreadStatusMessage(conv.id, null);

    // The child's entry is gone; the projection falls back to the root.
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 30000, outputTokens: 400 },
    ]));

    assert(llm.isThreadProcessing(conv.id, 'child-a') === false,
      'the settled child must stop reporting a run');
    assert(llm.isThreadProcessing(conv.id, null) === true,
      'the root was never asked to stop and must still be running');
    assert(llm.getThreadStatusMessage(conv.id, null) === before,
      `the root's line must survive a sibling settling; was '${before}', now '${llm.getThreadStatusMessage(conv.id, null)}'`);
    assert(llm.isConversationProcessing(conv.id) === true,
      'the conversation is still busy while the root streams');

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a sibling resting leaves the others running: ${msg(e)}`);
  }

  // --- 4: token flow and live usage are per thread ---
  // Two runs streaming report separate totals; asking one never returns the
  // other's.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-flow');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 1000, inputTokens: 5000, cachedTokens: 4000, outputTokens: 10 },
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 1000, inputTokens: 90, outputTokens: 3 },
    ]));

    const rootUsage = llm.getLiveInputUsage(conv.id, null);
    const childUsage = llm.getLiveInputUsage(conv.id, 'child-a');
    assert(rootUsage?.inputTokens === 5000 && rootUsage?.cachedTokens === 4000,
      `the root's meter must read the root's own usage; got ${JSON.stringify(rootUsage)}`);
    assert(childUsage?.inputTokens === 90 && childUsage?.cachedTokens === null,
      `the child's meter must read the child's own usage, with no cache figure reported; got ${JSON.stringify(childUsage)}`);
    assert(llm.getLiveInputUsage(conv.id, 'child-b') === null,
      'a thread with no run has no live usage to report');

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`per-thread token flow: ${msg(e)}`);
  }

  // --- 5: the whole conversation resting clears every run ---
  // The last idle frame carries no runs at all, and nothing is left spinning.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-rest');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: '', status: 'streaming', startedAt: now - 1000 },
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 1000 },
    ]));
    conv.publish({ status: 'idle', message: '', threadItemId: 'child-a' });

    assert(llm.isConversationProcessing(conv.id) === false,
      'an idle frame with no runs must leave nothing processing');
    assert(Object.keys(llm.getLiveThreadMessages(conv.id)).length === 0,
      'no thread may keep a status line once every run is released');
    assert(llm.getStatusThreadId(conv.id) === null,
      'a conversation at rest names no live column for the readers that act on one');

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`resting clears every run: ${msg(e)}`);
  }

  // --- 6: the tile face agrees with the footer, thread by thread ---
  // The same snapshot drives a column footer and the tiles inside it, so a
  // running child's tile spins while a not-yet-dispatched sibling's says it is
  // waiting. This is the end the user actually sees.
  try {
    const Y = await import('../../js/vendor/yjs.mjs');
    const llm = new LLMState();
    const conv = stubConversation('conv-tiles');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 3000, outputTokens: 12 },
      { threadItemId: 'child-b', status: 'streaming', startedAt: now - 3000, outputTokens: 34 },
    ]));
    const live = { byThread: llm.getLiveThreadMessages(conv.id) };

    const doc = new Y.Doc();
    const root = doc.getArray('items');
    /**
     * @param {string} itemId
     * @returns {any} a Y.Map shaped like a thread item
     */
    const thread = (itemId) => {
      const m = new Y.Map();
      m.set('type', 'thread');
      m.set('itemId', itemId);
      m.set('items', new Y.Array());
      return m;
    };
    doc.transact(() => { root.insert(0, [thread('child-a'), thread('child-b'), thread('child-c')]); });

    const a = getThreadStatus(root.get(0), live);
    const b = getThreadStatus(root.get(1), live);
    const c = getThreadStatus(root.get(2), live);
    assert(a.kind === 'running' && b.kind === 'running',
      `both running children must show a spinner; got '${a.kind}' and '${b.kind}'`);
    assert(a.message === llm.getThreadStatusMessage(conv.id, 'child-a'),
      `a tile must say exactly what that thread's own footer says; got '${a.message}'`);
    assert(a.message !== b.message,
      `two running tiles must not share one line; both said '${a.message}'`);
    assert(c.kind === 'queued',
      `a sibling with no run of its own is still waiting its turn; got '${c.kind}'`);

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`tiles agree with footers per thread: ${msg(e)}`);
  }

  // --- 7: a run's last word is an error, and that is a rest ---
  // A terminal error releases the claim, so the worker's frame carries no run at
  // all and the top-level fields are the failing run's own last word (see
  // statusHoldsClaim, cmd/juggler/worker/activity_state.go). Nothing follows it:
  // there is no idle frame behind a frame that already dropped the run. So this
  // frame has to settle the conversation by itself, or the spinner it leaves
  // running is the last thing the worker ever says about it.
  try {
    const llm = new LLMState();
    const conv = stubConversation('conv-terminal-error');
    llm.registerConversation(conv);
    conv.publish(frame([
      { threadItemId: 'child-a', status: 'streaming', startedAt: now - 4000, outputTokens: 51 },
    ]));
    assert(llm.isThreadProcessing(conv.id, 'child-a') === true, 'the child is streaming before it fails');

    conv.publish({
      activity: 'none', threadItemId: 'child-a', status: 'error',
      message: 'The provider has reached its usage limit.', runs: {},
    });

    assert(llm.isThreadProcessing(conv.id, 'child-a') === false,
      'a thread whose run ended on an error is stopped — the error is the end of the run, not a phase of it');
    assert(llm.isConversationProcessing(conv.id) === false,
      'and with nothing else running the conversation is at rest');
    assert(llm.getStatusThreadId(conv.id) === null,
      'nothing names a live column any more: a bare Escape must not be handed a thread that has stopped');

    llm.unregisterConversation(conv.id);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a terminal error settles the conversation: ${msg(e)}`);
  }

  return { passed, failed, errors };
}
