//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The server's jobs as this window follows them: work of any kind — a git
 * write is one — that a feature's own route starts and the server runs on its
 * own time.
 *
 * A route that starts a job answers at once with the job, and the server says
 * how it went only on the socket, in job events sent to the connections
 * subscribed to the job's workspace (the `jobs` topic,
 * {@link module:services/topics}). So `follow` holds a subscription to the
 * job's workspace for as long as any job of it is out, and settles each one on
 * the event that ends it.
 *
 * An event can be missed twice over, and both are covered by reading the job
 * back. Right after the POST: the subscription was named to the server over
 * the socket and the start went over HTTP, so a quick job can end before the
 * server heard of the subscription. And on every new connection: events sent
 * while the window was cut off went nowhere.
 *
 * Which workspace an unnamed call is about is decided when it is made: the
 * visible conversation's ({@link module:services/visible-workspace}). A job
 * already out belongs to the workspace it was started in whatever the user
 * looks at next.
 * @module services/jobs-service
 */

import api from './api.js';
import { subscribe } from './topics.js';
import { visibleWorkspaceId } from './visible-workspace.js';
import wsService from './websocket.js';

/** @typedef {import('../protocol/server-wire-types.gen.js').Job} Job */
/** @typedef {import('../protocol/server-wire-types.gen.js').JobEvent} JobEvent */

/**
 * A job `follow` is waiting on.
 * @typedef {object} Pending
 * @property {string} workspace - Its workspace.
 * @property {(job: Job) => void} resolve - Settle with the ended job.
 */

/** @type {Map<string, Pending>} The jobs `follow` is waiting on, by id. */
const _pending = new Map();

/**
 * Jobs that ended while a start was still out, by id: their event can arrive
 * before the answer that names them.
 * @type {Map<string, Job>}
 */
const _early = new Map();

/** How many starts are out, so `_early` is kept only while one may claim it. */
let _starting = 0;

/**
 * This service's subscription to each workspace's jobs, held while it has a job
 * out there or a listener for that workspace's jobs.
 * @type {Map<string, {holds: number, unsubscribe: () => void}>}
 */
const _subscriptions = new Map();

/** @type {Map<string, Set<(job: Job) => void>>} Job listeners, by workspace. */
const _listeners = new Map();

/** States a job does not leave. */
const FINAL_JOB_STATES = new Set(['done', 'failed', 'cancelled']);

/**
 * The workspace a call is about: the one it named, or the one in view.
 * @param {string|undefined} named - The workspace the caller named, if any.
 * @returns {string} The workspace id, '' for the project.
 */
function workspaceOf(named) {
  return named || visibleWorkspaceId();
}

/**
 * Hold this service's subscription to a workspace's jobs.
 * @param {string} workspace - The workspace.
 */
function hold(workspace) {
  const held = _subscriptions.get(workspace);
  if (held) {
    held.holds++;
    return;
  }
  const unsubscribe = subscribe('jobs', workspace, (data) => {
    const event = /** @type {JobEvent} */ (data);
    if (event?.type === 'job') take(event.workspace || event.job?.workspace || '', event.job);
  });
  _subscriptions.set(workspace, { holds: 1, unsubscribe });
}

/**
 * Let go of one hold on a workspace's subscription, ending it with the last.
 * @param {string} workspace - The workspace.
 */
function release(workspace) {
  const held = _subscriptions.get(workspace);
  if (!held) return;
  if (--held.holds > 0) return;
  _subscriptions.delete(workspace);
  held.unsubscribe();
}

/**
 * Take what is now known of a job — from an event, or a read of it — to its
 * listeners and to the `follow` waiting on it.
 * @param {string} workspace - Its workspace.
 * @param {Job} job - The job as it now stands.
 */
function take(workspace, job) {
  if (!job || typeof job.id !== 'string') return;
  for (const listener of [...(_listeners.get(workspace) || [])]) {
    try {
      listener(job);
    } catch (err) {
      console.error('[Jobs] Job listener failed:', err);
    }
  }
  if (!FINAL_JOB_STATES.has(job.state)) return;
  const pending = _pending.get(job.id);
  if (!pending) {
    if (_starting > 0) _early.set(job.id, job);
    return;
  }
  _pending.delete(job.id);
  release(pending.workspace);
  pending.resolve(job);
}

/**
 * Read one job back, for an event that may have been missed. A failed read
 * leaves the job waiting on its event.
 * @param {string} workspace - Its workspace.
 * @param {string} id - The job.
 * @returns {Promise<void>} Settles when the read has been taken.
 */
async function readBack(workspace, id) {
  try {
    const data = await api.getJobs(workspace, id);
    if (data?.job) take(workspace, data.job);
  } catch (err) {
    console.warn('[Jobs] Could not read a job back:', err);
  }
}

// Events sent while the window was cut off went nowhere, so every job still
// out is read again. (services/topics.js names the subscribed workspaces again
// on the same event.)
wsService.on('open', () => {
  for (const [id, pending] of [..._pending]) void readBack(pending.workspace, id);
});

/**
 * Finish ending a start that settled with no job to follow.
 * @param {string} workspace - The workspace it was held for.
 */
function startSettled(workspace) {
  release(workspace);
  if (--_starting === 0) _early.clear();
}

const jobsService = {
  /**
   * Start a job and wait for it to end, holding its workspace's subscription
   * meanwhile.
   * @param {string|undefined} workspace - The workspace `start` starts it in; '' or
   *   omitted for the one in view.
   * @param {() => Promise<Job|null>} start - Ask the server; null when it started nothing.
   * @returns {Promise<Job|null>} The job once it has ended, in whatever final
   *   state, or null. Rejects with `start`'s error.
   */
  async follow(workspace, start) {
    const tree = workspaceOf(workspace);
    hold(tree);
    _starting++;
    /** @type {Job|null} */
    let job;
    try {
      job = await start();
    } catch (err) {
      startSettled(tree);
      throw err;
    }
    if (!job) {
      startSettled(tree);
      return null;
    }
    const ended = _early.get(job.id);
    _early.delete(job.id);
    if (--_starting === 0) _early.clear();
    const first = ended || job;
    return new Promise((resolve) => {
      _pending.set(first.id, { workspace: tree, resolve });
      // The answer may already be final; otherwise read it back once, in case
      // it ends before the server knew this workspace was subscribed to.
      if (FINAL_JOB_STATES.has(first.state)) take(tree, first);
      else void readBack(tree, first.id);
    });
  },

  /**
   * Wait for a job already started to end.
   * @param {string} id - The job.
   * @param {string} [workspace] - Its workspace; '' or omitted for the one in view.
   * @returns {Promise<Job|null>} The job once it has ended, or null when the
   *   server has no such job.
   */
  async wait(id, workspace) {
    const tree = workspaceOf(workspace);
    return await jobsService.follow(tree, async () => {
      try {
        return (await api.getJobs(tree, id))?.job || null;
      } catch (/** @type {any} */ err) {
        if (err?.status === 404) return null;
        throw err;
      }
    });
  },

  /**
   * Hear of every state change of every job in a workspace, with its output as
   * it comes. The workspace is subscribed to while a listener remains.
   * @param {string|undefined} workspace - The workspace; '' or omitted for the one in view now.
   * @param {(job: Job) => void} listener - Called with each job as it now stands.
   * @returns {() => void} Stop listening. Safe to call twice.
   */
  onJob(workspace, listener) {
    const tree = workspaceOf(workspace);
    let set = _listeners.get(tree);
    if (!set) {
      set = new Set();
      _listeners.set(tree, set);
    }
    set.add(listener);
    hold(tree);
    let stopped = false;
    const mine = set;
    return () => {
      if (stopped) return;
      stopped = true;
      mine.delete(listener);
      if (mine.size === 0 && _listeners.get(tree) === mine) _listeners.delete(tree);
      release(tree);
    };
  },

  /**
   * Ask the server to stop a job. A `follow` waiting on it settles on the event
   * that says it stopped.
   * @param {string} id - The job.
   * @param {string} [workspace] - Its workspace; '' or omitted for the one in view.
   * @returns {Promise<Job>} The job as it stood once asked.
   */
  async cancel(id, workspace) {
    const tree = workspaceOf(workspace);
    const { job } = await api.cancelJob(id, tree);
    if (job) take(tree, job);
    return job;
  },

  /**
   * Answer the question a job is waiting on, or decline it. The answer is sent
   * and dropped: nothing here keeps or logs it.
   * @param {string} id - The job.
   * @param {{prompt: string, answer?: string, decline?: boolean}} reply - The question and its answer.
   * @param {string} [workspace] - Its workspace; '' or omitted for the one in view.
   * @returns {Promise<Job>} The job as it stood once answered.
   */
  async answer(id, reply, workspace) {
    const tree = workspaceOf(workspace);
    const { job } = await api.answerJob(id, reply, tree);
    if (job) take(tree, job);
    return job;
  },

  /**
   * A workspace's jobs: every one running and the last hundred ended, newest first.
   * @param {string} [workspace] - The workspace; '' or omitted for the one in view.
   * @returns {Promise<Job[]>} The jobs.
   */
  async list(workspace) {
    const data = await api.getJobs(workspaceOf(workspace));
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },
};

export default jobsService;
