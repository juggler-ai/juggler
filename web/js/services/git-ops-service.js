//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The git writes this window starts — staging, discarding, committing,
 * fetching and pushing — each one a job on the server.
 *
 * The server answers a write at once with the job it started, and says how it
 * ended only on the socket, in a git-job frame sent to the connections watching
 * that tree ({@link module:services/git-watch}). So `run` holds a watch of the
 * job's tree for as long as any job of that tree is out, and settles each one on
 * the frame that ends it.
 *
 * A frame can be missed twice over, and both are covered by reading the job
 * back. Right after the POST: the watch was named to the server over the socket
 * and the write went over HTTP, so a quick job can end before the server heard
 * the tree was watched. And on every new connection: frames sent while the
 * window was cut off went nowhere.
 *
 * Which tree an unnamed call is about is decided when it is made: the visible
 * conversation's ({@link module:services/git-workspace}). A job already out
 * belongs to the tree it was started in whatever the user looks at next.
 * @module services/git-ops-service
 */

import { serverText, t } from '../../sdk/lib/i18n.js';
import api from './api.js';
import { watchGit } from './git-watch.js';
import { gitWorkspaceId } from './git-workspace.js';
import wsService from './websocket.js';

/** @typedef {import('./api.js').GitJob} GitJob */
/** @typedef {import('./api.js').GitOp} GitOp */

/**
 * A job's end as a rejection: the job itself, which of the server's refusals it
 * was, and the message to show.
 * @typedef {Error & {job: GitJob, kind: string}} GitJobError
 */

/**
 * A job `run` is waiting on.
 * @typedef {object} Pending
 * @property {string} workspace - Its tree.
 * @property {(job: GitJob) => void} resolve - Settle the run with the finished job.
 * @property {(err: Error) => void} reject - Settle it with the job's failure.
 */

/** @type {Map<string, Pending>} The jobs `run` is waiting on, by id. */
const _pending = new Map();

/**
 * Jobs that ended while a POST was still out, by id: their frame can arrive
 * before the 202 that names them.
 * @type {Map<string, GitJob>}
 */
const _early = new Map();

/** How many POSTs are out, so `_early` is kept only while one may claim it. */
let _posting = 0;

/**
 * This service's watch of each tree, held while it has a job out there or a
 * listener for that tree's jobs.
 * @type {Map<string, {holds: number, unwatch: () => void}>}
 */
const _watches = new Map();

/** @type {Map<string, Set<(job: GitJob) => void>>} Job listeners, by tree. */
const _listeners = new Map();

/** States a job does not leave. */
const FINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * The tree a call is about: the one it named, or the one in view.
 * @param {string|undefined} named - The workspace the caller named, if any.
 * @returns {string} The workspace id, '' for the project.
 */
function treeOf(named) {
  return named || gitWorkspaceId();
}

/**
 * Hold this service's watch of a tree.
 * @param {string} workspace - The tree.
 */
function hold(workspace) {
  const held = _watches.get(workspace);
  if (held) {
    held.holds++;
    return;
  }
  const unwatch = watchGit(workspace, (frame) => {
    if (frame.type === 'git-job') take(frame.workspace || frame.job?.workspace || '', frame.job);
  });
  _watches.set(workspace, { holds: 1, unwatch });
}

/**
 * Let go of one hold on a tree's watch, ending it with the last.
 * @param {string} workspace - The tree.
 */
function release(workspace) {
  const held = _watches.get(workspace);
  if (!held) return;
  if (--held.holds > 0) return;
  _watches.delete(workspace);
  held.unwatch();
}

/**
 * The rejection a job that did not finish settles its run with.
 * @param {GitJob} job - The failed or cancelled job.
 * @returns {GitJobError} The error.
 */
function jobError(job) {
  const english = job.error || (job.state === 'cancelled' ? 'The git command was cancelled.' : 'The git command failed.');
  const fallback = job.state === 'cancelled' ? t('The git command was cancelled.') : t('The git command failed.');
  const err = /** @type {GitJobError} */ (new Error(job.errorMessage
    ? serverText(job.errorMessage, english)
    : (job.error || fallback)));
  err.job = job;
  err.kind = job.errorKind || '';
  return err;
}

/**
 * Take what is now known of a job — from a frame, or a read of it — to its
 * listeners and to the run waiting on it.
 * @param {string} workspace - Its tree.
 * @param {GitJob} job - The job as it now stands.
 */
function take(workspace, job) {
  if (!job || typeof job.id !== 'string') return;
  for (const listener of [...(_listeners.get(workspace) || [])]) {
    try {
      listener(job);
    } catch (err) {
      console.error('[GitOps] Job listener failed:', err);
    }
  }
  if (!FINAL.has(job.state)) return;
  const pending = _pending.get(job.id);
  if (!pending) {
    if (_posting > 0) _early.set(job.id, job);
    return;
  }
  _pending.delete(job.id);
  release(pending.workspace);
  if (job.state === 'done') pending.resolve(job);
  else pending.reject(jobError(job));
}

/**
 * Read one job back, for a frame that may have been missed. A failed read
 * leaves the job waiting on its frame.
 * @param {string} workspace - Its tree.
 * @param {string} id - The job.
 * @returns {Promise<void>} Settles when the read has been taken.
 */
async function readBack(workspace, id) {
  try {
    const data = await api.getGitJobs(workspace, id);
    if (data?.job) take(workspace, data.job);
  } catch (err) {
    console.warn('[GitOps] Could not read a job back:', err);
  }
}

// Frames sent while the window was cut off went nowhere, so every job still
// out is read again. (git-watch names the watched trees again on the same event.)
wsService.on('open', () => {
  for (const [id, pending] of [..._pending]) void readBack(pending.workspace, id);
});

/**
 * Start a job and wait for it to end, holding its tree's watch meanwhile.
 * @param {string} workspace - The tree.
 * @param {() => Promise<GitJob|null>} start - Ask the server; null when it started nothing.
 * @returns {Promise<GitJob|null>} The job once done, or null. Rejects with a
 *   {@link GitJobError} when it failed or was cancelled, or with `start`'s error.
 */
async function follow(workspace, start) {
  hold(workspace);
  _posting++;
  /** @type {GitJob|null} */
  let job;
  try {
    job = await start();
  } catch (err) {
    release(workspace);
    if (--_posting === 0) _early.clear();
    throw err;
  }
  if (!job) {
    release(workspace);
    if (--_posting === 0) _early.clear();
    return null;
  }
  const ended = _early.get(job.id);
  _early.delete(job.id);
  if (--_posting === 0) _early.clear();
  const first = ended || job;
  return new Promise((resolve, reject) => {
    _pending.set(first.id, { workspace, resolve, reject });
    // The answer may already be final; otherwise read it back once, in case
    // it ends before the server knew this tree was watched.
    if (FINAL.has(first.state)) take(workspace, first);
    else void readBack(workspace, first.id);
  });
}

const gitOpsService = {
  /**
   * Run one git write and wait for it to end.
   * @param {GitOp} op - The write.
   * @param {{workspace?: string}} [options] - The tree to write in; omitted, the
   *   visible conversation's, as it is when this is called.
   * @returns {Promise<GitJob>} The job, once done. Rejects with a
   *   {@link GitJobError} when it failed or was cancelled, and with the
   *   request's own error when the server refused to start it.
   */
  async run(op, options = {}) {
    const workspace = treeOf(options.workspace);
    const job = await follow(workspace, async () => {
      const started = (await api.runGit(op, workspace))?.job;
      if (!started || typeof started.id !== 'string') throw new Error(t('The server did not say which git job it started.'));
      return started;
    });
    // `start` never answers null, so neither does this.
    return /** @type {GitJob} */ (job);
  },

  /**
   * Ask for the fetch made the first time a repository is shown, and wait for
   * it to end. The server makes one per repository per session; a repository
   * fetched this way before answers null at once.
   * @param {string} [repo] - The repository within the tree.
   * @param {{workspace?: string}} [options] - The tree; omitted, the one in view.
   * @returns {Promise<GitJob|null>} The fetch, once done, or null. Rejects as
   *   {@link gitOpsService.run} does.
   */
  async fetchOnShow(repo = '', options = {}) {
    const workspace = treeOf(options.workspace);
    return await follow(workspace, async () => {
      const answer = await api.gitFetchOnShow(repo, workspace);
      return answer?.job && typeof answer.job.id === 'string' ? answer.job : null;
    });
  },

  /**
   * Hear of every state change of every job in a tree, with its hooks' output as
   * it comes — for a command log, or a commit's hooks shown live. The tree is
   * watched while a listener remains.
   * @param {string|undefined} workspace - The tree; '' or omitted for the one in view now.
   * @param {(job: GitJob) => void} listener - Called with each job as it now stands.
   * @returns {() => void} Stop listening. Safe to call twice.
   */
  onJob(workspace, listener) {
    const tree = treeOf(workspace);
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
   * Ask the server to stop a job. Its run, if this window is waiting on one,
   * settles on the frame that says it stopped.
   * @param {string} id - The job.
   * @param {string} [workspace] - Its tree; '' or omitted for the one in view.
   * @returns {Promise<GitJob>} The job as it stood once asked.
   */
  async cancel(id, workspace) {
    const tree = treeOf(workspace);
    const { job } = await api.cancelGitJob(id, tree);
    if (job) take(tree, job);
    return job;
  },

  /**
   * Answer the question a job is waiting on, or decline it. The answer is sent
   * and dropped: nothing here keeps or logs it.
   * @param {string} id - The job.
   * @param {{prompt: string, answer?: string, decline?: boolean}} reply - The question and its answer.
   * @param {string} [workspace] - Its tree; '' or omitted for the one in view.
   * @returns {Promise<GitJob>} The job as it stood once answered.
   */
  async answer(id, reply, workspace) {
    const tree = treeOf(workspace);
    const { job } = await api.answerGitJob(id, reply, tree);
    if (job) take(tree, job);
    return job;
  },

  /**
   * A tree's jobs: every one running and the last hundred finished, newest first.
   * @param {string} [workspace] - The tree; '' or omitted for the one in view.
   * @returns {Promise<GitJob[]>} The jobs.
   */
  async jobs(workspace) {
    const data = await api.getGitJobs(treeOf(workspace));
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },
};

export default gitOpsService;
