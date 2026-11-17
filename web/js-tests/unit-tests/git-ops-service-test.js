//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Git ops service tests — a write is a job, and `run` settles when the job ends.
 *
 * The server answers a write at once with the job it started and reports the
 * job's end only on the socket, and only to connections watching that tree. So
 * what is asserted here is the settling (done resolves, failed and cancelled
 * reject with what the server said), the watching that makes the settling
 * possible (held exactly while a job of the tree is out), the recovery when a
 * frame was missed across a reconnect, and which tree an unnamed run is about.
 * @module unit-tests/git-ops-service-test
 */

import gitOpsService from '../../js/services/git-ops-service.js';
import { setGitWorkspace } from '../../js/services/git-workspace.js';
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
 * Run the git ops service tests.
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
   * Stand in for the server: POST /api/git/run starts a running job,
   * GET /api/git/jobs?id= answers with the job as the server now has it, and the
   * git-watch frame is recorded rather than sent.
   * @returns {any} The fake.
   */
  function stubServer() {
    const originalFetch = window.fetch;
    const originalSend = wsService.sendGitWatch;
    const state = {
      /** @type {string[][]} */
      asked: [],
      /** @type {{url: string, body: any}[]} */
      posts: [],
      /** @type {string[]} */
      reads: [],
      /** @type {Map<string, any>} The jobs as the server has them, by id. */
      jobs: new Map(),
      next: 0,
    };
    window.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/git/run')) {
        const body = JSON.parse(init?.body || '{}');
        state.posts.push({ url, body });
        const workspace = new URLSearchParams(url.split('?')[1] || '').get('workspace') || '';
        const job = {
          id: `job_${++state.next}`, workspace, repo: body.repo || '', kind: body.kind,
          commands: [], state: 'running', output: '', errorKind: '', result: {},
        };
        state.jobs.set(job.id, job);
        return new window.Response(JSON.stringify({ job }), { status: 202 });
      }
      if (url.includes('/api/git/jobs')) {
        state.reads.push(url);
        const id = new URLSearchParams(url.split('?')[1] || '').get('id') || '';
        const job = state.jobs.get(id);
        if (!job) return new window.Response(JSON.stringify({ error: 'no such job' }), { status: 404 });
        return new window.Response(JSON.stringify({ job }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    wsService.sendGitWatch = /** @type {any} */ ((/** @type {string[]} */ ids) => {
      state.asked.push([...ids]);
      return true;
    });
    owed.push(() => {
      window.fetch = originalFetch;
      wsService.sendGitWatch = originalSend;
      setGitWorkspace('');
    });
    setGitWorkspace('');
    return state;
  }

  /**
   * The socket service, with its emitter in reach: a test speaks for the server
   * by emitting what the socket would have.
   * @returns {any} The service.
   */
  function socket() {
    return /** @type {any} */ (wsService);
  }

  /**
   * The server ending a job and telling the watchers of its tree.
   * @param {any} server - The fake.
   * @param {string} id - The job.
   * @param {object} changes - What its end looks like.
   * @param {{silently?: boolean}} [options] - Whether the frame is lost on the way.
   */
  function serverEnds(server, id, changes, options = {}) {
    const job = { ...server.jobs.get(id), ...changes };
    server.jobs.set(id, job);
    if (!options.silently) socket()._emit('git-job', { type: 'git-job', workspace: job.workspace, job });
  }

  /**
   * Wait for the runs' POSTs to have been answered and their jobs entered as in
   * flight — which ends with the one read of each job the service makes after
   * the POST, in case the job ended before the server heard the tree was
   * watched.
   * @param {any} server - The fake.
   * @param {number} count - How many runs there should be.
   */
  async function posted(server, count) {
    await waitFor(() => server.posts.length >= count, `POST ${count} to /api/git/run`);
    await waitFor(() => server.reads.length >= count, () => `the read after each POST; ${server.reads.length} of ${count}`);
    await nextTask();
  }

  await test('run resolves with the job when its done frame arrives', async () => {
    const server = stubServer();
    const running = outcome(gitOpsService.run({ kind: 'stage', repo: '', paths: ['a.txt'] }));
    await posted(server, 1);
    assert(!running.done, 'run settled before the job ended');
    serverEnds(server, 'job_1', { state: 'done', commands: [['add', '--', 'a.txt']] });
    await waitFor(() => running.done, 'run to settle on the done frame');
    assert(!running.error, `run rejected: ${running.error?.message}`);
    assert(running.value?.id === 'job_1' && running.value.state === 'done',
      `run resolved with ${JSON.stringify(running.value)}`);
    assert(server.posts[0].body.kind === 'stage' && server.posts[0].body.paths[0] === 'a.txt',
      `the op went out as ${JSON.stringify(server.posts[0].body)}`);
  });

  await test('run rejects with the job\'s errorKind and message when it fails', async () => {
    const server = stubServer();
    const running = outcome(gitOpsService.run({ kind: 'commit', repo: '', message: 'x' }));
    await posted(server, 1);
    serverEnds(server, 'job_1', {
      state: 'failed', error: 'index.lock exists', errorKind: 'locked', lockPath: '.git/index.lock',
      errorMessage: { key: 'Another git process holds {path}.', params: { path: '.git/index.lock' } },
    });
    await waitFor(() => running.done, 'run to settle on the failed frame');
    const err = running.error;
    assert(err instanceof Error, `run resolved with ${JSON.stringify(running.value)} instead of rejecting`);
    assert(err.kind === 'locked', `the error's kind is ${JSON.stringify(err.kind)}, want "locked"`);
    assert(err.job?.id === 'job_1' && err.job.lockPath === '.git/index.lock', 'the error carries the job');
    assert(err.message.includes('.git/index.lock'), `the message is ${JSON.stringify(err.message)}`);
  });

  await test('a job whose end frame was missed resolves after a reconnect', async () => {
    const server = stubServer();
    const running = outcome(gitOpsService.run({ kind: 'unstage', repo: '', paths: ['b.txt'] }));
    await posted(server, 1);
    const readsBefore = server.reads.length;
    serverEnds(server, 'job_1', { state: 'done' }, { silently: true });
    await nextTask();
    assert(!running.done, 'run settled with no frame and no read');

    socket()._emit('open', {});
    await waitFor(() => running.done, () => `run to settle after the reconnect (reads: ${JSON.stringify(server.reads.slice(readsBefore))})`);
    assert(running.value?.state === 'done', `run settled as ${JSON.stringify(running.value || running.error?.message)}`);
    assert(server.reads.slice(readsBefore).some((/** @type {string} */ u) => u.includes('id=job_1')),
      `the job was not read again: ${JSON.stringify(server.reads.slice(readsBefore))}`);
  });

  await test('the tree is watched while a job runs, and let go after', async () => {
    const server = stubServer();
    const first = outcome(gitOpsService.run({ kind: 'stage', repo: '', paths: ['a'] }, { workspace: 'ws_ops' }));
    const second = outcome(gitOpsService.run({ kind: 'stage', repo: '', paths: ['b'] }, { workspace: 'ws_ops' }));
    await posted(server, 2);
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_ops"]',
      `while jobs run the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    assert(server.posts.every((/** @type {any} */ p) => p.url.includes('workspace=ws_ops')), 'the runs name their tree');

    serverEnds(server, 'job_1', { state: 'done' });
    await waitFor(() => first.done, 'the first job to settle');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_ops"]',
      `one job still out, yet the window asks for ${JSON.stringify(server.asked.at(-1))}`);

    serverEnds(server, 'job_2', { state: 'cancelled' });
    await waitFor(() => second.done, 'the second job to settle');
    assert(second.error instanceof Error, 'a cancelled job rejects');
    assert(JSON.stringify(server.asked.at(-1)) === '[]',
      `no job out, yet the window asks for ${JSON.stringify(server.asked.at(-1))}`);
  });

  await test('an unnamed run is about the tree in view when it is made', async () => {
    const server = stubServer();
    setGitWorkspace('ws_visible');
    const running = outcome(gitOpsService.run({ kind: 'stage-all', repo: '' }));
    await posted(server, 1);
    assert(server.posts[0].url.includes('workspace=ws_visible'), `the run went to ${server.posts[0].url}`);
    // Moving on does not move a job already out: its end is reported for its own tree.
    setGitWorkspace('');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_visible"]',
      `after the view moved the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    serverEnds(server, 'job_1', { state: 'done' });
    await waitFor(() => running.done, 'the run to settle on its own tree\'s frame');
    assert(running.value?.state === 'done', 'and it resolved');
  });

  return { passed, failed, errors };
}
