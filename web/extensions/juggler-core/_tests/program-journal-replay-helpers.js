//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The program journal (context-items/code/program-journal.js) against random
 * programs: trees of sequential and concurrent capability calls, each call's
 * arguments built from the answers before it, so a replay that hands any
 * answer to the wrong call changes what the program asks next.
 *
 * Nothing here depends on time. Every capability call waits in a pending set,
 * and a scheduler seeded with the case's number picks which one answers next,
 * once every microtask has run — so one seed is one interleaving, on any
 * machine, and a failure names the seed that reproduces it.
 *
 * The program sits behind a stand-in for the sandbox boundary: each answer
 * reaches it as a task of its own, through one port, as the sandbox iframe's
 * replies do.
 *
 * Each case runs the program once uninterrupted, for reference. Then it runs
 * it as run_code does: its tool calls go through the real invoker, whose
 * order keeps every call behind a running write, and some are parked for the
 * user. A parked call is held while the program lives on, and the journal's
 * snapshot is taken as run_code takes it (beforeHold, after a turn of the
 * event loop). Then either the user answers and the program goes on in the
 * same run, or the engine dies: the run ends where it stands, answering
 * nothing more, and the next run replays from the snapshot, making the held
 * call with the user's answer — until a run finishes, or a replay diverges.
 *
 * Contract under test, for every case:
 *   1. No change (tools.write) ever happens twice, across all runs, and none
 *      happens that the uninterrupted run did not make.
 *   2. A run either finishes, returning what the uninterrupted run returned
 *      with every change made exactly once, or its replay diverges and stops.
 *      A replay never stalls.
 *   3. A program that makes one call at a time never diverges.
 *
 * The seeds are split across several suites (program-journal-replay-*-test.js),
 * each running one range through {@link runReplaySeeds}. The work is all task
 * hops, a few hundred thousand of them, and a lane's page runs at background
 * priority, so a range that takes under a second on an idle machine takes
 * twenty times that on a loaded one; one suite of every seed ran past its
 * budget there.
 * @module _tests/program-journal-replay-helpers
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { trackWait } from '../../../js-tests/utilities/test-patience.js';
import { journalCapabilities } from '../context-items/code/program-journal.js';
import { createToolInvoker } from '../../../js/services/tool-invoker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** Runs a case may take; in the last, the engine never dies. */
const MAX_RUNS = 6;

/** How often a tool call is parked for the user. */
const PARK = 0.3;

/** How often the engine dies while a call is held, rather than the user answering. */
const DIE = 0.6;

/**
 * The capabilities a program calls, weighted towards tool calls: only a tool
 * call waits on the user.
 */
const CAPS = ['fs.readFile', 'fs.readFile', 'grep', 'tools.read', 'tools.read', 'tools.write', 'tools.write', 'tools.write'];

/**
 * A seeded generator (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} Uniform in [0, 1)
 */
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A short, stable hash of a string.
 * @param {string} s - The string
 * @returns {string} Its hash, in hex
 */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * @typedef {{kind: 'call', cap: string, id: number}|{kind: 'seq'|'all', children: Node[]}} Node
 */

/**
 * A random program.
 * @param {() => number} rng - The generator
 * @returns {Node} Its tree
 */
function generate(rng) {
  let ids = 0;
  /**
   * @param {number} depth - How deep this node is
   * @returns {Node} The node
   */
  const node = (depth) => {
    if (depth >= 4 || (depth > 0 && rng() < 0.3)) {
      return { kind: 'call', cap: /** @type {string} */ (CAPS[Math.floor(rng() * CAPS.length)]), id: ids++ };
    }
    const n = 1 + Math.floor(rng() * 3);
    return { kind: rng() < 0.5 ? 'seq' : 'all', children: Array.from({ length: n }, () => node(depth + 1)) };
  };
  return node(0);
}

/**
 * Run a program over capabilities. A call's arguments are built from the
 * answer before it, and an answer that is a NotFound error is caught and
 * becomes part of what follows, as a program's own try/catch would.
 * @param {Node} tree - The program
 * @param {Record<string, any>} c - The capabilities it calls
 * @returns {Promise<string>} What it returns
 */
function runProgram(tree, c) {
  /**
   * @param {Node} n - The node
   * @param {string} acc - The answer before it
   * @returns {Promise<string>} Its answer
   */
  const run = async (n, acc) => {
    if (n.kind === 'call') {
      const arg = n.cap + '#' + n.id + '@' + hash(acc);
      try {
        if (n.cap === 'fs.readFile') return String(await c.fs.readFile(arg));
        if (n.cap === 'grep') return String(await c.grep(arg));
        if (n.cap === 'tools.read') return String(await c.tools.read({ path: arg }));
        return String(await c.tools.write({ path: arg }));
      } catch (e) {
        if (/** @type {Error} */ (e)?.name !== 'NotFound') throw e;
        return 'missing:' + /** @type {Error} */ (e).message;
      }
    }
    if (n.kind === 'seq') {
      let a = acc;
      for (const child of n.children) a = await run(child, a);
      return a;
    }
    const answers = await Promise.all(n.children.map((child) => run(child, acc)));
    return hash(answers.join(','));
  };
  return run(tree, '');
}

/** The one channel every settle crosses, and who is waiting on it, in order. */
const settler = new MessageChannel();
/** @type {Array<() => void>} */
const settling = [];
settler.port1.onmessage = () => { /** @type {() => void} */ (settling.shift())(); };

/**
 * Yield until every microtask queued so far, and every one they queue, has run.
 * @returns {Promise<void>}
 */
function settleMicrotasks() {
  return new Promise((resolve) => {
    settling.push(resolve);
    settler.port2.postMessage(0);
  });
}

/**
 * An error with a name, as a capability throws one.
 * @param {string} name - Its name
 * @param {string} message - Its message
 * @returns {Error} The error
 */
function named(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * The world one run runs against: capabilities whose calls wait to be
 * answered by the scheduler, behind the sandbox boundary; tool calls made
 * through the real invoker, as run_code makes them, some parked for the user;
 * and a write log shared across runs.
 * @param {object} opts
 * @param {string[]} opts.writes - Every change made, across runs
 * @param {{journal: any[], heldStep: number}|null} opts.saved - The snapshot this run resumes from
 * @param {() => number} opts.rng - The case's generator
 * @param {boolean} opts.last - The last run: the engine never dies
 * @returns {{wrapped: Record<string, any>, program: (c: Record<string, any>) => Record<string, any>, pending: Array<() => void>, delivering: () => boolean, dead: () => boolean, snapshot: () => {journal: any[], heldStep: number}|null, held: () => number, diverged: Error[], close: () => void}} The run's world
 */
function worldOf({ writes, saved, rng, last }) {
  /** @type {Array<() => void>} */
  const pending = [];
  /** Answers on their way to the program, in the order they were sent. */
  /** @type {Array<() => void>} */
  const inbox = [];
  const port = new MessageChannel();
  port.port1.onmessage = () => { /** @type {() => void} */ (inbox.shift())(); };
  /**
   * Send an answer across the boundary.
   * @param {() => void} hand - Hands it to the program
   */
  const deliver = (hand) => {
    inbox.push(hand);
    port.port2.postMessage(0);
  };
  let dead = false;
  let held = 0;
  /** Snapshots being taken, each waiting a turn of the event loop first. */
  let snapshotting = 0;
  /** @type {{journal: any[], heldStep: number}|null} */
  let lastSnapshot = null;
  /** @type {Error[]} */
  const diverged = [];

  /**
   * One fs or grep call: it waits its turn, then answers, or throws NotFound
   * for some arguments — the same for the same arguments on every run.
   * @param {string} key - The capability
   * @param {string} arg - Its argument
   * @returns {Promise<string>} Its answer
   */
  const answer = (key, arg) => new Promise((resolve, reject) => {
    pending.push(() => {
      if (parseInt(hash(arg), 16) % 5 === 0) reject(named('NotFound', 'no ' + arg));
      else resolve(key + ':' + hash(arg));
    });
  });

  /** @type {any} */
  let wrapped = null;
  const invoker = createToolInvoker({
    parentToolUseId: 'fuzz',
    waitForUser: true,
    beforeHold: async (_request, step) => {
      snapshotting++;
      try {
        await settleMicrotasks();
        lastSnapshot = { journal: wrapped.snapshot(), heldStep: /** @type {number} */ (step) };
      } finally {
        snapshotting--;
      }
    },
    deps: {
      offeredTools: async () => [{ name: 'read', category: 'read' }, { name: 'write', category: 'write' }],
      decide: async () => (rng() < PARK ? { verdict: 'park', reason: 'it needs your approval' } : { verdict: 'approve', reason: '' }),
      holdRequest: async (call) => ({ name: call.name, input: call.args, reason: '', approvalOptions: { options: [] } }),
      hold: () => new Promise((resolve) => {
        held++;
        pending.push(() => {
          if (!last && rng() < DIE) {
            // The engine dies: nothing it was running answers again.
            dead = true;
            pending.length = 0;
            return;
          }
          resolve({ response: 'yes' });
        });
      }),
      run: ({ toolName, input }) => new Promise((resolve) => {
        pending.push(() => {
          if (toolName === 'write') writes.push(String(input.path));
          resolve({ success: true, content: 'tools.' + toolName + ':' + hash(String(input.path)) });
        });
      }),
      cancel: () => {},
      release: () => {},
      answer: (_name, input) => input,
    },
  });

  /**
   * A tool call as run_code makes it: tagged with its journal step, and made
   * with the user's answer at the step the snapshot held.
   * @param {string} name - The tool
   * @param {{path: string}} a - Its arguments
   * @returns {Promise<string>} Its answer
   */
  const tool = (name, a) => {
    const step = wrapped.stepNow();
    return invoker.invoke(name, a, { tag: step, answer: saved && step === saved.heldStep ? 'yes' : undefined });
  };
  /** @type {Record<string, any>} */
  const caps = {
    fs: { readFile: (/** @type {string} */ p) => answer('fs.readFile', p) },
    grep: (/** @type {string} */ p) => answer('grep', p),
    tools: {
      read: (/** @type {{path: string}} */ a) => tool('read', a),
      write: (/** @type {{path: string}} */ a) => tool('write', a),
    },
  };
  wrapped = journalCapabilities(caps, { journal: saved ? [...saved.journal] : [], onDiverge: (e) => diverged.push(e) });

  /**
   * The program's side of the boundary: every answer reaches it as a task of
   * its own, and a dead engine's program makes no more calls.
   * @param {Record<string, any>} c - The capabilities the program is given
   * @returns {Record<string, any>} The same, across the boundary
   */
  const program = (c) => {
    /**
     * @param {(...args: any[]) => Promise<any>} fn - A capability
     * @returns {(...args: any[]) => Promise<any>} It, answering across the boundary
     */
    const g = (fn) => (...args) => (dead
      ? new Promise(() => {})
      : new Promise((resolve, reject) => {
        fn(...args).then((v) => { if (!dead) deliver(() => resolve(v)); }, (e) => { if (!dead) deliver(() => reject(e)); });
      }));
    return {
      fs: { readFile: g((p) => c.fs.readFile(p)) },
      grep: g((p) => c.grep(p)),
      tools: { read: g((a) => c.tools.read(a)), write: g((a) => c.tools.write(a)) },
    };
  };

  return {
    wrapped, program, pending, diverged,
    delivering: () => inbox.length > 0 || snapshotting > 0,
    dead: () => dead,
    snapshot: () => lastSnapshot,
    held: () => held,
    close: () => port.port1.close(),
  };
}

/**
 * The world the reference run runs against: every call answers, nothing waits
 * on the user.
 * @param {string[]} writes - Every change made
 * @returns {{caps: Record<string, any>, pending: Array<() => void>, delivering: () => boolean, close: () => void}} The world
 */
function referenceWorldOf(writes) {
  /** @type {Array<() => void>} */
  const pending = [];
  /** @type {Array<() => void>} */
  const inbox = [];
  const port = new MessageChannel();
  port.port1.onmessage = () => { /** @type {() => void} */ (inbox.shift())(); };
  /**
   * @param {string} key - The capability
   * @param {string} arg - Its argument
   * @param {boolean} [tool] - A tool call, which never throws NotFound
   * @returns {Promise<string>} Its answer, across the boundary
   */
  const call = (key, arg, tool = false) => new Promise((resolve, reject) => {
    pending.push(() => {
      /** @type {() => void} */
      let hand;
      if (!tool && parseInt(hash(arg), 16) % 5 === 0) {
        const e = named('NotFound', 'no ' + arg);
        hand = () => reject(e);
      } else {
        if (key === 'tools.write') writes.push(arg);
        const v = key + ':' + hash(arg);
        hand = () => resolve(v);
      }
      inbox.push(hand);
      port.port2.postMessage(0);
    });
  });
  return {
    caps: {
      fs: { readFile: (/** @type {string} */ p) => call('fs.readFile', p) },
      grep: (/** @type {string} */ p) => call('grep', p),
      tools: {
        read: (/** @type {{path: string}} */ a) => call('tools.read', a.path, true),
        write: (/** @type {{path: string}} */ a) => call('tools.write', a.path, true),
      },
    },
    pending,
    delivering: () => inbox.length > 0,
    close: () => port.port1.close(),
  };
}

/**
 * Drive one run: answer pending calls in the order the generator picks until
 * the program has ended and nothing is under way, or the engine has died.
 * @param {Promise<unknown>} program - The running program
 * @param {Array<() => void>} pending - Calls waiting to answer
 * @param {() => number} rng - Picks which answers next
 * @param {() => boolean} delivering - Whether answers are still crossing the boundary, or a snapshot is being taken
 * @param {() => boolean} dead - Whether the engine has died
 * @returns {Promise<{ok: boolean, value?: unknown, error?: Error, stall?: string, died?: boolean}>} How it ended
 */
async function drive(program, pending, rng, delivering, dead) {
  /** @type {{ok: boolean, value?: unknown, error?: Error}|null} */
  let outcome = null;
  program.then((value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
  for (;;) {
    await settleMicrotasks();
    if (dead()) return { ok: false, died: true };
    if (delivering()) continue;
    if (pending.length === 0) {
      if (outcome) return outcome;
      return { ok: false, stall: 'nothing pending, and the program has not ended' };
    }
    const [next] = pending.splice(Math.floor(rng() * pending.length), 1);
    /** @type {() => void} */ (next)();
  }
}

/**
 * Run the journal replay cases for one range of seeds.
 * @param {number} first - The first seed
 * @param {number} last - The last seed, included
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runReplaySeeds(first, last) {
  const cases = last - first + 1;
  /** Where the range has got to, for a timeout's report. */
  let now = 'starting';
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(name + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  /**
   * Whether a program makes one call at a time: no concurrent node with more
   * than one child.
   * @param {Node} n - The program
   * @returns {boolean} It is sequential
   */
  const sequential = (n) => n.kind === 'call'
    || ((n.kind === 'seq' || n.children.length < 2) && n.children.every(sequential));

  /**
   * One case: the reference run, then the runs.
   * @param {number} seed - The case
   * @returns {Promise<{deaths: number, answered: number, resumed: boolean, diverged: boolean}>} How often the
   *   engine died while a call was held, how often the user answered one, whether a replay finished, and whether
   *   one diverged
   */
  const runCase = async (seed) => {
    const rng = rngOf(seed);
    const tree = generate(rng);
    const where = 'seed ' + seed + ' (' + JSON.stringify(tree).slice(0, 300) + ')';

    /** @type {string[]} */
    const refWrites = [];
    const ref = referenceWorldOf(refWrites);
    const expected = await drive(runProgram(tree, ref.caps), ref.pending, rng, ref.delivering, () => false);
    ref.close();
    assert(expected.ok, where + ': the reference run must finish: ' + (expected.error?.message ?? expected.stall));
    const want = [...refWrites].sort();

    /** @type {{journal: any[], heldStep: number}|null} */
    let saved = null;
    /** @type {string[]} */
    const writes = [];
    let deaths = 0;
    let answered = 0;
    for (let run = 0; run < MAX_RUNS; run++) {
      const at = where + ', run ' + (run + 1);
      now = 'seed ' + seed + ', run ' + (run + 1);
      const world = worldOf({ writes, saved, rng, last: run === MAX_RUNS - 1 });
      const result = await drive(runProgram(tree, world.program(world.wrapped)), world.pending, rng, world.delivering,
        world.dead);
      world.close();
      const done = [...writes].sort();
      assert(new Set(done).size === done.length, at + ': a change was made twice: ' + JSON.stringify(done));
      assert(done.every((w) => want.includes(w)), at + ': a change the uninterrupted run never made: ' + JSON.stringify(done));
      assert(!result.stall, at + ': stalled: ' + result.stall);
      if (world.diverged.length > 0) {
        assert(!sequential(tree), at + ': a program that makes one call at a time diverged: ' + world.diverged[0]?.message);
        assert(!result.ok, at + ': a replay that diverged still finished');
        return { deaths, answered, resumed: false, diverged: true };
      }
      if (result.died) {
        deaths++;
        answered += world.held() - 1;
        saved = world.snapshot();
        assert(saved, at + ': the engine died holding a call, with no snapshot');
        continue;
      }
      answered += world.held();
      assert(result.ok, at + ': failed: ' + result.error?.message);
      assert(result.value === expected.value, at + ': returned ' + String(result.value) + ', uninterrupted ' + String(expected.value));
      assert(JSON.stringify(done) === JSON.stringify(want),
        at + ': each change once — made ' + JSON.stringify(done) + ', uninterrupted ' + JSON.stringify(want));
      return { deaths, answered, resumed: deaths > 0, diverged: false };
    }
    throw new Error(where + ': never finished in ' + MAX_RUNS + ' runs');
  };

  await test(`random programs (seeds ${first}–${last}) held live or lost and replayed never make a change twice, and finish or stop`, async () => {
    /** @type {string[]} */
    const failures = [];
    let deaths = 0;
    let multi = 0;
    let answered = 0;
    let resumed = 0;
    let diverged = 0;
    // Nothing here waits on anything outside the page, so the only wait is
    // the range itself; listing it lets a timeout name the seed it reached.
    const done = trackWait(() => `seeds ${first}–${last} to run, at ${now}`);
    try {
      for (let seed = first; seed <= last; seed++) {
        try {
          const r = await runCase(seed);
          deaths += r.deaths;
          answered += r.answered;
          if (r.resumed) resumed++;
          if (r.resumed && r.deaths > 1) multi++;
          if (r.diverged) diverged++;
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      done('satisfied');
    }
    assert(failures.length === 0, failures.length + ' of ' + cases + ' cases failed; first:\n' + failures.slice(0, 3).join('\n'));
    // Guard against a generator that stops making the cases worth having:
    // replays that finish, some through several deaths, holds answered live,
    // and divergence the exception rather than the rule. Each range of a
    // hundred clears every bar; the closest is seeds 201–300's 48 answered live.
    assert(deaths > cases / 2 && resumed > cases / 4 && multi > cases / 20 && answered > cases * 0.4 && diverged < resumed,
      'too few holds to test both paths: ' + deaths + ' deaths, ' + resumed + ' resumed, ' + multi
      + ' through several, ' + answered + ' answered live, ' + diverged + ' diverged');
  });

  return { passed, failed, errors };
}
