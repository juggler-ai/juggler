//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Git ops service tests — a write is a job of kind `git`, and `run` settles
 * when the job ends.
 *
 * Following a job is the jobs service's (jobs-service-test); what is asserted
 * here is git's part: done resolves and failed or cancelled reject with what
 * the server said, every job is handed out read flat — git's detail laid over
 * it — and which tree an unnamed run is about.
 * @module _tests/git-client-ops-test
 */

import { gitClient } from '../lib/git-client.js';
import { servicesFor } from '../../../js/services/extension-services.js';
import { setVisibleWorkspace } from '../../../js/services/visible-workspace.js';
import wsService from '../../../js/services/websocket.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';

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
  // The git client's writes, through a client of a surface that lives for the
  // whole run.
  const life = new AbortController();
  const client = gitClient(servicesFor(null, life.signal), life.signal);
  const gitOpsService = {
    run: client.run,
    onJob: (/** @type {string} */ workspace, /** @type {(job: any) => void} */ listener) => client.watch((event) => {
      if (event.type === 'git-job') listener(event.job);
    }, { workspace }),
  };
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
   * Stand in for the server: the git tool's run (POST /api/ops/client) starts a running git job,
   * GET /api/jobs?id= answers with the job as the server now has it, and the
   * jobs topic's subscriptions frame is recorded rather than sent.
   * @returns {any} The fake.
   */
  function stubServer() {
    const originalFetch = window.fetch;
    const originalSend = wsService.sendSubscriptions;
    const state = {
      /** @type {string[][]} */
      asked: [],
      /** @type {{url: string, body: any, workspace: string}[]} */
      posts: [],
      /** @type {string[]} */
      reads: [],
      /** @type {Map<string, any>} The jobs as the server has them, by id. */
      jobs: new Map(),
      next: 0,
    };
    window.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const call = url.includes('/api/ops/client') ? JSON.parse(init?.body || '{}') : null;
      if (call?.toolId === 'git' && call.operation === 'run') {
        const body = call.params?.op || {};
        const workspace = call.workspaceId || '';
        state.posts.push({ url, body, workspace });
        const job = {
          id: `job_${++state.next}`, kind: 'git', workspace, state: 'running', output: '', startedAt: 1,
          detail: { repo: body.repo || '', op: body.kind, commands: [] },
        };
        state.jobs.set(job.id, job);
        return new window.Response(JSON.stringify({ success: true, data: job }), { status: 200 });
      }
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
    if (!options.silently) socket()._emit('topic-event', { type: 'topic-event', topic: 'jobs', key: job.workspace, event: { type: 'job', workspace: job.workspace, job } });
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
    await waitFor(() => server.posts.length >= count, `${count} git runs`);
    await waitFor(() => server.reads.length >= count, () => `the read after each POST; ${server.reads.length} of ${count}`);
    await nextTask();
  }

  await test('run resolves with the job when its done frame arrives', async () => {
    const server = stubServer();
    const running = outcome(gitOpsService.run({ kind: 'stage', repo: '', paths: ['a.txt'] }));
    await posted(server, 1);
    assert(!running.done, 'run settled before the job ended');
    serverEnds(server, 'job_1', { state: 'done', detail: { repo: '', op: 'stage', commands: [['add', '--', 'a.txt']] }, result: { head: 'abc' } });
    await waitFor(() => running.done, 'run to settle on the done frame');
    assert(!running.error, `run rejected: ${running.error?.message}`);
    const job = running.value;
    assert(job?.id === 'job_1' && job.state === 'done' && job.kind === 'stage' && job.commands?.[0]?.[0] === 'add' && job.result?.head === 'abc' && job.errorKind === '',
      `run resolved with ${JSON.stringify(job)}, want it read flat`);
    assert(server.posts[0].body.kind === 'stage' && server.posts[0].body.paths[0] === 'a.txt',
      `the op went out as ${JSON.stringify(server.posts[0].body)}`);
  });

  await test('run rejects with the job\'s errorKind and message when it fails', async () => {
    const server = stubServer();
    const running = outcome(gitOpsService.run({ kind: 'commit', repo: '', message: 'x' }));
    await posted(server, 1);
    serverEnds(server, 'job_1', {
      state: 'failed',
      error: { kind: 'locked', message: 'index.lock exists', text: { key: 'Another git process holds {path}.', params: { path: '.git/index.lock' } } },
      detail: { repo: '', op: 'commit', commands: [], lockPath: '.git/index.lock' },
    });
    await waitFor(() => running.done, 'run to settle on the failed frame');
    const err = running.error;
    assert(err instanceof Error, `run resolved with ${JSON.stringify(running.value)} instead of rejecting`);
    assert(err.kind === 'locked', `the error's kind is ${JSON.stringify(err.kind)}, want "locked"`);
    assert(err.job?.id === 'job_1' && err.job.lockPath === '.git/index.lock', 'the error carries the job');
    assert(err.message.includes('.git/index.lock'), `the message is ${JSON.stringify(err.message)}`);
  });

  await test('a cancelled run rejects, and listeners hear only git jobs, read flat', async () => {
    const server = stubServer();
    /** @type {any[]} */
    const heard = [];
    const stop = gitOpsService.onJob('ws_ops', (job) => heard.push(job));
    const running = outcome(gitOpsService.run({ kind: 'fetch', repo: '' }, { workspace: 'ws_ops' }));
    await posted(server, 1);
    socket()._emit('topic-event', { type: 'topic-event', topic: 'jobs', key: 'ws_ops', event: { type: 'job', workspace: 'ws_ops', job: { id: 'other', kind: 'test', workspace: 'ws_ops', state: 'running', output: '', startedAt: 1 } } });
    serverEnds(server, 'job_1', {
      progress: { phase: 'Receiving objects', source: 'remote', percent: 50, done: 1, total: 2 },
      prompt: { id: 'ask_1', text: 'Password:', kind: 'secret' },
    });
    serverEnds(server, 'job_1', { state: 'cancelled', progress: undefined, prompt: undefined });
    await waitFor(() => running.done, 'the run to settle');
    stop();
    assert(running.error instanceof Error && /** @type {any} */ (running.error).job?.state === 'cancelled', 'a cancelled job rejects with the job');
    assert(heard.every((j) => j.id === 'job_1'), `a listener heard another kind's job: ${JSON.stringify(heard)}`);
    const asking = heard.find((j) => j.prompt);
    assert(asking?.progress?.remote === true && asking.progress.percent === 50 && !('source' in asking.progress) && asking.prompt.id === 'ask_1' && asking.kind === 'fetch',
      `the job asking was read as ${JSON.stringify(asking)}`);
  });

  await test('an unnamed run is about the tree in view when it is made', async () => {
    const server = stubServer();
    setVisibleWorkspace('ws_visible');
    const running = outcome(gitOpsService.run({ kind: 'stage-all', repo: '' }));
    await posted(server, 1);
    assert(server.posts[0].workspace === 'ws_visible', `the run went to ${server.posts[0].workspace}`);
    // Moving on does not move a job already out: its end is reported for its own tree.
    setVisibleWorkspace('');
    assert(JSON.stringify(server.asked.at(-1)) === '["ws_visible"]',
      `after the view moved the window asks for ${JSON.stringify(server.asked.at(-1))}`);
    serverEnds(server, 'job_1', { state: 'done' });
    await waitFor(() => running.done, 'the run to settle on its own tree\'s frame');
    assert(running.value?.state === 'done', 'and it resolved');
  });

  await test('a review read on a machine without git keeps the server\'s reason', async () => {
    // The pin's tests hand it a manifest directly, so only this sees what the
    // client lets through from the server.
    const gitMissing = { key: "Git isn't installed", params: { platform: 'darwin' } };
    const originalFetch = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const call = url.includes('/api/ops/client') ? JSON.parse(init?.body || '{}') : null;
      if (call?.toolId === 'git' && call.operation === 'review') {
        const data = { root: '/p', complete: false, warnings: [], gitMissing, repos: [{ path: '', error: 'git is not installed' }] };
        return new window.Response(JSON.stringify({ success: true, data }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    owed.push(() => { window.fetch = originalFetch; });
    const review = await client.review({ scope: '@uncommitted' });
    assert(JSON.stringify(review.gitMissing) === JSON.stringify(gitMissing),
      `the review came back as ${JSON.stringify(review)}`);
  });

  return { passed, failed, errors };
}
