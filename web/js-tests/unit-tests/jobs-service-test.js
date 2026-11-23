//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Jobs service tests — `follow` settles when the job ends, whatever its kind.
 *
 * The server answers a start at once with the job and reports its end only on
 * the socket, and only to connections subscribed to that workspace's jobs. So
 * what is asserted here is the settling (on the event that ends the job, or an
 * end that came before the start's answer), the subscription that makes it
 * possible (held exactly while a job of the workspace is out), the recovery
 * when an event was missed across a reconnect, and which workspace an unnamed
 * call is about.
 * @module unit-tests/jobs-service-test
 */

import jobsService from '../../js/services/jobs-service.js';
import { setVisibleWorkspace } from '../../js/services/visible-workspace.js';
import wsService from '../../js/services/websocket.js';
import { assert, nextTask, waitFor } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * What a promise did, as data, so a case can look at it without awaiting it.
 * @param {Promise<any>} promise - The promise to watch.
 * @returns {{done: boolean, value: any, error: any}} Filled in as it settles.
 */
function outcome(promise) {
  /** @type {{done: boolean, value: any, error: any}} */
  const state = { done: false, value: null, error: null };
  promise.then(
    (value) => { state.value = value; state.done = true; },
    (error) => { state.error = error; state.done = true; }
  );
  return state;
}

/**
 * Run the jobs service tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {(() => void)[]} */
  const owed = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    } finally {
      while (owed.length) owed.pop()?.();
    }
  }

  /**
   * Stand in for the server: `start` makes a running job, GET /api/jobs?id=
   * answers with the job as the server now has it, and the jobs topic's
   * subscriptions frame is recorded rather than sent.
   * @returns {any} The fake.
   */
  function stubServer() {
    const originalFetch = window.fetch;
    const originalSend = wsService.sendSubscriptions;
    const state = {
      /** @type {string[][]} */
      asked: [],
      /** @type {string[]} */
      reads: [],
      /** @type {Map<string, any>} The jobs as the server has them, by id. */
      jobs: new Map(),
      next: 0,
      /**
       * Start a job in a workspace, as a kind's route would.
       * @param {string} workspace - The workspace.
       * @returns {any} The job as it starts.
       */
      start(workspace) {
        const job = { id: `job_${++state.next}`, kind: 'test', workspace, state: 'running', output: '', startedAt: 1 };
        state.jobs.set(job.id, job);
        return job;
      },
    };
    window.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/jobs')) {
        state.reads.push(url);
        const id = new URLSearchParams(url.split('?')[1] || '').get('id') || '';
        const job = state.jobs.get(id);
        if (!job) return new window.Response(JSON.stringify({ error: 'no such job' }), { status: 404 });
        return new window.Response(JSON.stringify({ job }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    wsService.sendSubscriptions = /** @type {any} */ ((/** @type {string} */ topic, /** @type {string[]} */ ids) => {
      if (topic !== 'jobs') return true;
      state.asked.push([...ids]);
      return true;
    });
    owed.push(() => {
      window.fetch = originalFetch;
      wsService.sendSubscriptions = originalSend;
      setVisibleWorkspace('');
    });
    setVisibleWorkspace('');
    return state;
  }

  /**
   * The socket service, with its emitter in reach.
   * @returns {any} The service.
   */
  function socket() {
    return /** @type {any} */ (wsService);
  }

  /**
   * The server changing a job and telling the subscribers of its workspace.
   * @param {any} server - The fake.
   * @param {string} id - The job.
   * @param {object} changes - What it looks like now.
   * @param {{silently?: boolean}} [options] - Whether the event is lost on the way.
   */
  function serverSays(server, id, changes, options = {}) {
    const job = { ...server.jobs.get(id), ...changes };
    server.jobs.set(id, job);
    if (!options.silently) {
      socket()._emit('topic-event', { type: 'topic-event', topic: 'jobs', key: job.workspace, event: { type: 'job', workspace: job.workspace, job } });
    }
  }

  /**
   * Wait for the follows' one read-back each, made after their start in case
   * the job ended before the server heard of the subscription.
   * @param {any} server - The fake.
   * @param {number} count - How many follows there should be.
   */
  async function started(server, count) {
    await waitFor(() => server.reads.length >= count, () => `the read after each start; ${server.reads.length} of ${count}`);
    await nextTask();
  }

  await test('follow resolves with the job on the event that ends it, failed or not', async () => {
    const server = stubServer();
    const done = outcome(jobsService.follow('', async () => server.start('')));
    const failing = outcome(jobsService.follow('', async () => server.start('')));
    await started(server, 2);
    assert(!done.done && !failing.done, 'a follow settled before its job ended');
    serverSays(server, 'job_1', { state: 'running', output: 'half' });
    await nextTask();
    assert(!done.done, 'a follow settled on an event that did not end the job');
    serverSays(server, 'job_1', { state: 'done', result: { n: 1 } });
    serverSays(server, 'job_2', { state: 'failed', error: { kind: 'refused', message: 'no' } });
    await waitFor(() => done.done && failing.done, 'both follows to settle');
    assert(done.value?.state === 'done' && done.value.result?.n === 1, `done resolved with ${JSON.stringify(done.value)}`);
    assert(failing.value?.state === 'failed' && failing.value.error?.kind === 'refused' && !failing.error,
      `a failed job resolves with it, it does not reject: ${JSON.stringify(failing.value || failing.error?.message)}`);
  });

  await test('a job that ended before its start was answered still settles its follow', async () => {
    const server = stubServer();
    /** @type {(job: any) => void} */
    let answer = () => {};
    const following = outcome(jobsService.follow('', () => new Promise((resolve) => { answer = resolve; })));
    const job = server.start('');
    serverSays(server, job.id, { state: 'done' });
    answer(job);
    await waitFor(() => following.done, 'the follow to settle on the early end');
    assert(following.value?.state === 'done', `settled as ${JSON.stringify(following.value)}`);
  });

  await test('a job whose end event was missed resolves after a reconnect', async () => {
    const server = stubServer();
    const following = outcome(jobsService.follow('', async () => server.start('')));
    await started(server, 1);
    const readsBefore = server.reads.length;
    serverSays(server, 'job_1', { state: 'done' }, { silently: true });
    await nextTask();
    assert(!following.done, 'the follow settled with no event and no read');
    socket()._emit('open', {});
    await waitFor(() => following.done, () => `the follow to settle after the reconnect (reads: ${JSON.stringify(server.reads.slice(readsBefore))})`);
    assert(following.value?.state === 'done', `settled as ${JSON.stringify(following.value)}`);
    assert(server.reads.slice(readsBefore).some((/** @type {string} */ u) => u.includes('id=job_1')), 'the job was not read again');
  });

  await test('the workspace is subscribed to while a job is out, and let go after', async () => {
    const server = stubServer();
    const first = outcome(jobsService.follow('ws_jobs', async () => server.start('ws_jobs')));
    const second = outcome(jobsService.follow('ws_jobs', async () => server.start('ws_jobs')));
    await started(server, 2);
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_jobs"]', `while jobs run the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    serverSays(server, 'job_1', { state: 'done' });
    await waitFor(() => first.done, 'the first job to settle');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_jobs"]', `one job still out, yet the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    serverSays(server, 'job_2', { state: 'cancelled' });
    await waitFor(() => second.done, 'the second job to settle');
    assert(JSON.stringify(server.asked.at(-1)) === '[]', `no job out, yet the window asks for ${JSON.stringify(server.asked.at(-1))}`);
  });

  await test('an unnamed follow is about the workspace in view when it is made', async () => {
    const server = stubServer();
    setVisibleWorkspace('ws_visible');
    const following = outcome(jobsService.follow(undefined, async () => server.start('ws_visible')));
    await started(server, 1);
    setVisibleWorkspace('');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_visible"]', `after the view moved the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    serverSays(server, 'job_1', { state: 'done' });
    await waitFor(() => following.done, 'the follow to settle on its own workspace\'s event');
  });

  await test('a listener hears each change until it stops, and wait answers null for no such job', async () => {
    const server = stubServer();
    /** @type {any[]} */
    const heard = [];
    const stop = jobsService.onJob('ws_l', (job) => heard.push(job));
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_l"]', 'a listener holds the subscription');
    const job = server.start('ws_l');
    serverSays(server, job.id, { output: 'a' });
    serverSays(server, job.id, { state: 'done' });
    assert(heard.length === 2 && heard[1].state === 'done', `heard ${JSON.stringify(heard)}`);
    stop();
    stop();
    assert(JSON.stringify(server.asked.at(-1)) === '[]', 'the last listener gone, the subscription is let go');
    assert(await jobsService.wait('nope', 'ws_l') === null, 'wait on an unknown job is null');
  });

  return { passed, failed, errors };
}
