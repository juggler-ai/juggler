//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The git client: everything the Git pin, the git status card and the git
 * worktree provider ask of the server's git tool, built on the services a
 * surface is mounted with — the git tool's operations through
 * `services.ops.client`, its writes as jobs through `services.jobs`, and the
 * server's pushes through `services.topics`.
 *
 * Make one per mounted surface with {@link gitClient}, from that surface's
 * services and lifetime. Its reads are cancelled when the surface goes away.
 *
 * The status is shared. One cache per window holds the ambient status of the
 * tree in view — what the card's counts and the pin's header both draw — and
 * it reads only while something watches it: the first watcher has the server
 * watch the tree (the `git` topic) and the last one to leave lets it go. It
 * is read when the server says the tree changed, on a new connection and when
 * the window gains focus; never on a clock. Moving to a conversation that works
 * in another tree keeps the last answer up until the new tree answers.
 *
 * Everything else is asked for and not kept: a review, a patch, a repository's
 * changes or any other read is a live answer about a tree that changes under
 * it. Concurrent reviews of the same question share one read. A read made of
 * the tree in view is refused as stale when the user moved to another tree
 * while it was out — even one they have since come back to, since what was
 * read meanwhile may describe neither.
 *
 * A write is a job of kind `git`. `run` starts it and settles when it ends;
 * `watch` hears it at every state change, read flat ({@link toGitJob}).
 * @module lib/git-client
 */

import { serverText, t } from 'juggler/i18n';

/** @typedef {import('juggler/services').Services} Services */
/** @typedef {import('juggler/services').Job} Job */
/** @typedef {import('../../../js/protocol/server-wire-types.gen.js').GitJobDetail} GitJobDetail */
/** @typedef {import('../../../js/protocol/server-wire-types.gen.js').GitChangeEvent} GitChangeEvent */

/** The kind of a git write's job. */
const GIT_JOB_KIND = 'git';

/**
 * A job's end as a rejection: the job itself, which of the server's refusals it
 * was, and the message to show.
 * @typedef {Error & {job: GitJob, kind: string}} GitJobError
 */

/**
 * What a failure says, in the user's language when the server sent its words.
 * @param {any} err - The failure.
 * @returns {string} Its text.
 */
function failureText(err) {
  const english = err instanceof Error ? err.message : String(err?.message ?? err ?? '');
  return err?.serverMessage ? serverText(err.serverMessage, english) : english;
}

/**
 * A git job as the git client reads it.
 * @param {Job} job - The job, of kind `git`.
 * @returns {GitJob} It flat, with git's detail laid over it.
 */
function toGitJob(job) {
  const detail = /** @type {Partial<GitJobDetail>} */ (job.detail || {});
  /** @type {any} */
  const flat = {
    id: job.id,
    workspace: job.workspace || '',
    state: job.state,
    output: job.output || '',
    repo: detail.repo || '',
    kind: detail.op,
    commands: Array.isArray(detail.commands) ? detail.commands : [],
    errorKind: job.error?.kind || '',
    result: job.result || {},
  };
  if (detail.auto) flat.auto = true;
  if (job.error) {
    flat.error = job.error.message;
    if (job.error.text) flat.errorMessage = job.error.text;
  }
  for (const key of /** @type {const} */ (['lockPath', 'branch', 'worktree', 'prefer', 'rejected', 'reason', 'remotes'])) {
    if (detail[key] !== undefined) flat[key] = detail[key];
  }
  if (job.progress) {
    const { source, ...reading } = job.progress;
    flat.progress = { ...reading, ...(source === 'remote' ? { remote: true } : {}) };
  }
  if (job.prompt) flat.prompt = { ...job.prompt };
  return flat;
}

/**
 * Whether a job is a git write.
 * @param {any} job - A job of any kind.
 * @returns {boolean} Whether it is git's.
 */
function isGitJob(job) {
  return job?.kind === GIT_JOB_KIND;
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
 * Settle a run with the job it followed: the job when done, a rejection otherwise.
 * @param {Job|null} job - The ended job, or null for none.
 * @returns {GitJob|null} The job, read flat.
 */
function settled(job) {
  if (!job) return null;
  const flat = toGitJob(job);
  if (job.state !== 'done') throw jobError(flat);
  return flat;
}

/**
 * One tree's status, read once. With no project open there is no repository to
 * report, which is not a failure.
 * @param {Services} services - The services to read with.
 * @param {string} workspace - The tree, '' for the project.
 * @param {AbortSignal} [signal] - Cancellation.
 * @returns {Promise<GitStatus>} The status.
 */
async function readStatus(services, workspace, signal) {
  try {
    const data = /** @type {any} */ (await services.ops.client('git', 'status', {}, { workspace, signal }));
    return {
      root: (data && data.root) || '',
      workspace: (data && typeof data.workspace === 'string' && data.workspace) || '',
      repos: data && Array.isArray(data.repos) ? data.repos : [],
    };
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'NO_PROJECT') return { root: '', workspace: '', repos: [] };
    throw err;
  }
}

// The window's status cache. Its watchers are keyed to the services of the
// surface that added them; whichever surface's services are still mounted
// keep the server's watch of the tree.

/** @type {GitStatus|null} The latest status; null until one has been read. */
let _snapshot = null;
/** The last read's failure, kept beside the last good status. */
let _error = '';
/** @type {Map<() => void, Services>} Every watcher, with its surface's services. */
const _watchers = new Map();
/** @type {Services|null} The services the server-side watch was made with. */
let _watchServices = null;
/** @type {(() => void)|null} Ends the server-side watch, while there is one. */
let _unwatch = null;
/** @type {(() => void)|null} Stops hearing the followed tree move. */
let _unfollow = null;
/** The tree the watch is of. */
let _watchedId = '';
/** @type {Promise<GitStatus|null>|null} The read out, shared by concurrent callers. */
let _inFlight = null;
/** Identifies the read out, so a finished one clears only its own slot. */
let _inFlightId = 0;
/** The tree changed while a read was out, so another follows it. */
let _dirty = false;
/**
 * Bumped when the tree in view changes: an answer from before — a status, a
 * review or any other read of the tree in view — is dropped.
 */
let _generation = 0;
/** What is held describes a tree other than the one in view, until it answers. */
let _foreign = false;
/** What was last announced, so an unchanged answer is not announced again. */
let _announced = '';

/** Tell every watcher, when what they would read has changed. */
function notifyIfChanged() {
  const next = JSON.stringify({ snapshot: _snapshot, error: _error });
  if (next === _announced) return;
  _announced = next;
  for (const listener of [..._watchers.keys()]) {
    try {
      listener();
    } catch (err) {
      console.error('[git-client] A status watcher failed:', err);
    }
  }
}

/** @returns {Services|null} The services of some surface still watching. */
function someServices() {
  for (const services of _watchers.values()) return services;
  return null;
}

/** Read again: now, or once the read out has answered. */
function readAgain() {
  if (_inFlight) {
    _dirty = true;
    return;
  }
  const services = someServices();
  if (services) void refreshStatus(services);
}

/** The followed tree may have moved: follow it if it did. */
function followIfMoved() {
  if (_watchServices && _watchServices.workspaces.followed() !== _watchedId) follow();
}

/**
 * Watch the tree in view, on the server and for reconnects and focus, exactly
 * while something watches the cache, with the services of a surface that is.
 */
function updateWatching() {
  const services = _watchServices && [..._watchers.values()].includes(_watchServices) ? _watchServices : someServices();
  if (!services) {
    _unwatch?.();
    _unfollow?.();
    _unwatch = null;
    _unfollow = null;
    _watchServices = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', readAgain);
    return;
  }
  const id = services.workspaces.followed();
  if (_unwatch && id === _watchedId && services === _watchServices) return;
  // The new watch is made before the old one is let go, so a tree the two
  // share is never dropped and taken up again on the server.
  const previous = _unwatch;
  const previousFollow = _unfollow;
  _watchedId = id;
  _watchServices = services;
  // Only a change is read: what a write does to the tree is pushed as one.
  _unwatch = services.topics.subscribe('git', id, (event) => {
    if (/** @type {{type?: string}} */ (event)?.type === 'git-change') readAgain();
  }, { onResync: readAgain });
  _unfollow = services.workspaces.onChange(followIfMoved);
  previous?.();
  previousFollow?.();
  if (!previous && typeof window !== 'undefined') window.addEventListener('focus', readAgain);
}

/**
 * Follow the user to a conversation in another tree without blanking first:
 * the last answer stays up while the new tree is read, and is dropped if that
 * read is refused.
 */
function follow() {
  _generation++;
  _inFlight = null;
  _dirty = false;
  _foreign = _snapshot !== null || _error !== '';
  updateWatching();
  const services = someServices();
  if (services) void refreshStatus(services);
}

/**
 * Read the tree in view now. Concurrent callers share one read. Never rejects.
 * @param {Services} services - The services to read with.
 * @returns {Promise<GitStatus|null>} The status after this read.
 */
function refreshStatus(services) {
  if (_inFlight) return _inFlight;
  const generation = _generation;
  const id = ++_inFlightId;
  const pending = (async () => {
    try {
      const status = await readStatus(services, services.workspaces.followed());
      if (generation !== _generation) return _snapshot;
      _snapshot = status;
      _error = '';
      _foreign = false;
    } catch (err) {
      if (generation !== _generation) return _snapshot;
      // A read cancelled because the surface that made it went away says
      // nothing about the tree.
      if (/** @type {any} */ (err)?.name !== 'AbortError') {
        _error = failureText(err);
        if (_foreign) _snapshot = null;
        _foreign = false;
      }
    } finally {
      if (_inFlightId === id) _inFlight = null;
    }
    notifyIfChanged();
    if (_dirty && _inFlightId === id && _watchers.size > 0) {
      _dirty = false;
      readAgain();
    }
    return _snapshot;
  })();
  _inFlight = pending;
  return pending;
}

/**
 * Forget the window's git state — its status, and any review still being
 * shared: for tests, which cannot otherwise get back to the start.
 * @returns {void}
 */
export function __resetGitStatus() {
  _reviews.clear();
  _generation++;
  _snapshot = null;
  _error = '';
  _foreign = false;
  _dirty = false;
  _inFlight = null;
  notifyIfChanged();
}

/** @returns {Error} The refusal a stale answer gets. */
function staleError() {
  return new Error('The tree changed while git was being read.');
}

/** @returns {DOMException} The rejection a caller that cancelled gets. */
function cancelledError() {
  return new DOMException('The read was cancelled.', 'AbortError');
}

/**
 * Hand one caller a shared answer, or its own cancellation: the request is
 * shared, so a caller walking away must not cancel it for the others.
 * @template T
 * @param {Promise<T>} promise - The shared request.
 * @param {AbortSignal} [signal] - This caller's signal.
 * @returns {Promise<T>} This caller's view of it.
 */
function forCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The manifest as a caller may rely on it: `complete` only when the server
 * said so, and every list present.
 * @param {any} data - What the tool answered.
 * @returns {GitReview} The manifest.
 */
function asReview(data) {
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  return {
    root: String(data?.root || ''),
    ...(data?.workspace ? { workspace: String(data.workspace) } : {}),
    ...(data?.scope ? { scope: data.scope } : {}),
    ...(data?.gitMissing ? { gitMissing: data.gitMissing } : {}),
    complete: data?.complete === true,
    warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
    repos: repos.map((/** @type {any} */ repo) => ({
      ...repo,
      complete: repo?.complete === true,
      files: Array.isArray(repo?.files) ? repo.files : [],
    })),
  };
}

/** @type {Map<string, Promise<any>>} The reviews out, by tree and question. */
const _reviews = new Map();

/**
 * A read's own parameters, as the git tool takes them.
 * @param {string} kind - Which read.
 * @param {any} options - The caller's options.
 * @returns {Record<string, any>} Its parameters, the empty ones left out.
 */
function readParams(kind, options) {
  const own = kind === 'log' ? options?.log
    : kind === 'commit' ? { commit: options?.commit }
      : kind === 'blame' ? { path: options?.blame?.path, rev: options?.blame?.rev }
        : kind === 'stranded' ? { ref: options?.ref }
          : kind === 'attribution' ? { amend: options?.amend, conv: options?.conv }
            : kind === 'commit-context' ? { amend: options?.amend } : undefined;
  /** @type {Record<string, any>} */
  const params = {};
  for (const [name, value] of Object.entries(own || {})) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params[name] = value;
  }
  return params;
}

/**
 * The git client of one mounted surface.
 * @param {Services} services - The surface's services.
 * @param {AbortSignal} signal - The surface's lifetime: its watches end with it.
 * @returns {GitClient} The client.
 */
export function gitClient(services, signal) {
  const followed = () => services.workspaces.followed();

  /**
   * End `stop` with the surface, as well as when called.
   * @param {() => void} stop - What ends the subscription.
   * @returns {() => void} The same, safe to call twice.
   */
  const tied = (stop) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', end);
      stop();
    };
    if (signal.aborted) end();
    else signal.addEventListener('abort', end);
    return end;
  };

  /**
   * A read of one repository of a tree, refused as stale when it was of the
   * tree in view and the user moved meanwhile.
   * @param {string} operation - The git tool's operation.
   * @param {Record<string, any>} params - Its parameters.
   * @param {{workspace?: string, signal?: AbortSignal}} [options] - The tree and cancellation.
   * @returns {Promise<any>} The answer.
   */
  const readOf = async (operation, params, options) => {
    const named = options?.workspace || '';
    const tree = named || followed();
    const generation = _generation;
    const data = /** @type {any} */ (await services.ops.client('git', operation, params, { workspace: tree, signal: options?.signal }));
    if (!named && (followed() !== tree || _generation !== generation)) throw staleError();
    if (!data) throw new Error('Git said nothing about that repository.');
    return data;
  };

  return {
    status: () => _snapshot,
    error: () => _error,
    onChange: (listener) => {
      if (_watchers.size === 0 && _snapshot !== null && followed() !== _watchedId) {
        // What is held is of a tree nobody has watched since the user moved.
        _generation++;
        _foreign = true;
      }
      const watcher = () => listener();
      _watchers.set(watcher, services);
      updateWatching();
      return tied(() => {
        _watchers.delete(watcher);
        updateWatching();
      });
    },
    refresh: async () => {
      await refreshStatus(services);
    },
    statusOf: (workspace, options) => readStatus(services, workspace || '', options?.signal),
    review: async (options) => {
      const named = options?.workspace || '';
      const tree = named || followed();
      const generation = _generation;
      const scope = options?.scope || '';
      const conv = options?.conv || '';
      const key = `${tree}\u0000${scope}\u0000${conv}`;
      let pending = _reviews.get(key);
      if (!pending) {
        const request = services.ops.client('git', 'review', { scope, conv }, { workspace: tree }).finally(() => {
          if (_reviews.get(key) === request) _reviews.delete(key);
        });
        _reviews.set(key, request);
        pending = request;
      }
      const data = await forCaller(pending, options?.signal);
      if (!named && (followed() !== tree || _generation !== generation)) throw staleError();
      return asReview(data);
    },
    diff: async (repo, path, options) => {
      const data = await readOf('diff', {
        repo, path, scope: options?.scope || '', conv: options?.conv || '',
        ...(typeof options?.contextLines === 'number' ? { context: String(options.contextLines) } : {}),
      }, options);
      return { ...data, hunks: Array.isArray(data.hunks) ? data.hunks : [] };
    },
    changes: async (options) => {
      const data = await readOf('read', { kind: 'changes', repo: options?.repo || '' }, options);
      return { ...data, files: Array.isArray(data.files) ? data.files : [] };
    },
    read: (kind, options) => readOf('read', { kind, repo: options?.repo || '', ...readParams(kind, options) }, options),
    digest: (conv, paths, options) => readOf('digest', { conv, repo: options?.repo || '', paths: [...paths] }, options),
    run: async (op, options) => {
      const tree = options?.workspace || followed();
      const started = /** @type {any} */ (await services.ops.client('git', 'run', { op }, { workspace: tree }));
      if (!started || typeof started.id !== 'string') throw new Error(t('The server did not say which git job it started.'));
      return /** @type {GitJob} */ (settled(await services.jobs.wait(started.id, { workspace: tree })));
    },
    fetchOnShow: async (options) => {
      const tree = options?.workspace || followed();
      const answer = /** @type {any} */ (await services.ops.client('git', 'fetchOnShow', { repo: options?.repo || '' }, { workspace: tree }));
      if (!answer?.job || typeof answer.job.id !== 'string') return null;
      return settled(await services.jobs.wait(answer.job.id, { workspace: tree }));
    },
    cancel: async (id, options) => toGitJob(await services.jobs.cancel(id, { workspace: options?.workspace || followed() })),
    answer: async (id, reply, options) => toGitJob(await services.jobs.answer(id, reply, { workspace: options?.workspace || followed() })),
    jobs: async (options) => (await services.jobs.list({ workspace: options?.workspace || followed() })).filter(isGitJob).map(toGitJob),
    watch: (listener, options) => {
      const named = options?.workspace || '';
      /** @type {(() => void)|null} */
      let unwatch = null;
      let tree = '';
      const deliver = (/** @type {any} */ event) => {
        try {
          listener(JSON.parse(JSON.stringify(event)));
        } catch (err) {
          console.error('[git-client] A git watcher failed:', err);
        }
      };
      const watchTree = () => {
        const next = named || followed();
        if (unwatch && next === tree) return;
        // The new tree is watched before the old one is let go.
        const previous = unwatch;
        tree = next;
        const changes = services.topics.subscribe('git', next, deliver, { onResync: () => deliver({ type: 'git-resync', workspace: tree }) });
        // A git write is a job: its events come on the jobs topic, read flat.
        const writes = services.topics.subscribe('jobs', next, (/** @type {any} */ event) => {
          if (event?.type === 'job' && isGitJob(event.job)) {
            deliver({ type: 'git-job', workspace: event.workspace || '', job: toGitJob(event.job) });
          }
        });
        unwatch = () => {
          changes();
          writes();
        };
        if (!previous) return;
        previous();
        deliver({ type: 'git-resync', workspace: next });
      };
      watchTree();
      const stopFollowing = named ? null : services.workspaces.onChange(watchTree);
      return tied(() => {
        stopFollowing?.();
        unwatch?.();
        unwatch = null;
      });
    },
  };
}

/** @type {(services: Services, signal: AbortSignal) => GitClient} How a surface's client is made. */
let makeClient = gitClient;

/**
 * The git client a mounted surface uses: the Git pin, the git status card, the
 * file browser and the git worktree provider all ask here, so a test can hand
 * each of them a scripted client in one place.
 * @param {Services} services - The surface's services.
 * @param {AbortSignal} signal - The surface's lifetime.
 * @returns {GitClient} Its client.
 */
export function gitClientOf(services, signal) {
  return makeClient(services, signal);
}

/**
 * Have every surface's client made by `factory` instead: for tests.
 * @param {(services: any, signal: AbortSignal) => GitClient} factory - How to make one.
 * @returns {() => void} Put back the one that was in place before.
 */
export function __scriptGitClients(factory) {
  const previous = makeClient;
  makeClient = factory;
  return () => {
    makeClient = previous;
  };
}

/**
 * A source that offers the Git pin: `kind: 'git'`, and the repository to open
 * at by its path in the tree ('' for the root one), when the surface offering
 * it names one.
 * @typedef {import('juggler/pinboard-item-type').PinSource & {kind: 'git', repo?: string}} GitPinSource
 */

// What the git client reads and writes, as the server's git tool answers.

/**
 * One file in a repository's working tree. `index` and `worktree` are git's own
 * status letters — 'M', 'A', 'D', 'R', '?' — where '.' means that side is
 * unmodified, so a file staged and then edited again reads 'M'/'M'.
 * @typedef {object} GitFile
 * @property {string} path - Path relative to its repository, forward-slashed
 * @property {string} [oldPath] - Former path for a rename or copy
 * @property {string} index - Staged status letter, '.' when unmodified
 * @property {string} worktree - Working-tree status letter, '?' for untracked
 * @property {boolean} [conflicted] - Whether this is an unmerged entry
 * @property {number} [added] - Added tracked text lines; absent for untracked/binary files
 * @property {number} [removed] - Removed tracked text lines; absent for untracked/binary files
 */

/**
 * One repository under the open project.
 * @typedef {object} GitRepo
 * @property {string} path - Location relative to the project root, '' for the root repo
 * @property {number} changed - Files with working-tree changes, untracked included
 * @property {number} staged - Files with staged changes
 * @property {number} conflicted - Files with unresolved merges
 * @property {number} total - Files git reported, listed in `files` or not. Not
 *   `changed + staged`: a file staged and then edited again is one file on both sides.
 * @property {number} added - Added tracked text lines relative to HEAD
 * @property {number} removed - Removed tracked text lines relative to HEAD
 * @property {string} branch - Current branch, '' on a detached head
 * @property {string} upstream - Tracking branch, '' when it has none
 * @property {string} head - Full HEAD object id, '' before the first commit
 * @property {boolean} initial - Whether the repository has no commits yet
 * @property {number} ahead - Commits this branch has that its upstream does not
 * @property {number} behind - Commits its upstream has that this branch does not
 * @property {number} stashes - Entries in the stash
 * @property {boolean} detached - Whether HEAD is on a commit rather than a branch
 * @property {GitFile[]} files - The changed files, bounded by the host
 * @property {boolean} truncated - True when the tree holds more files than `files` lists.
 *   The counts still describe the whole tree, so say "200 of 4000" rather than "200".
 */

/**
 * The working-tree state of every repository under the project — the root repo
 * and any nested repos or submodules, in a stable order.
 * @typedef {object} GitStatus
 * @property {string} root - Absolute path of the tree that was read: the project,
 *   or the workspace the visible conversation works in
 * @property {string} [workspace] - That workspace's name when the tree is not the
 *   project (a worktree, a copy, a subfolder). Absent for the project. Show it:
 *   counts from a worktree read exactly like counts from the project otherwise
 * @property {GitRepo[]} repos - Every repo found, empty when the project has no git
 */

/**
 * One repository in a review manifest: everything the card reports about it,
 * plus whether that is the whole story.
 *
 * A repository git could not read is listed all the same, with `error` carrying
 * git's own first line of complaint — an uninitialised submodule is the everyday
 * case, and a scope naming a branch this repository lacks another. Dropping it
 * would turn "I could not read this" into "there is nothing here", which is the
 * one thing a review may never say.
 *
 * For any scope but the default, `base` is the object id the old side resolved
 * to here, `target` the new side's when that is a commit rather than the working
 * tree or the index, and `baseName` the branch `@branch` settled on. In those
 * scopes `files` lists what the comparison covers, lettered on the side of the
 * two-letter code the comparison changes: the index side for `--cached`, the
 * working-tree side for everything else.
 * @typedef {GitRepo & {complete: boolean, error?: string, base?: string, target?: string, baseName?: string}} GitReviewRepo
 */

/**
 * What a review compares.
 * @typedef {object} GitScope
 * @property {string} input - The scope as asked for: a preset (`@uncommitted`,
 *   `@staged`, `@unstaged`, `@branch`, `@last`) or a small subset of `git diff`'s
 *   own arguments (`main`, `--merge-base main`, `--cached [rev]`, `--worktree`,
 *   `a..b`, `a...b`, `a b`)
 * @property {'worktree'|'index'|'unstaged'|'commits'} kind - Which two states it
 *   compares: the working tree, the index or a commit, against a commit or the index
 * @property {string} label - The comparison in words, in English
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [labelMessage] -
 *   The label as a server message, for `serverText()`; absent for a commit range,
 *   whose label is git's notation rather than words
 */

/**
 * The working tree as a review reads it: every repository under the project and
 * every changed file in each of them, asked for rather than polled.
 *
 * `complete` is the field this whole answer turns on, and the one a surface must
 * not paper over. Ceilings and failures are unavoidable; presenting what they
 * left behind as the whole working tree is not. Partial results are worth showing
 * — they are just not everything, and each gap names itself in `warnings`, in
 * sentences meant for the user rather than for a log.
 * @typedef {object} GitReview
 * @property {string} root - Absolute path of the tree that was read, as for
 *   {@link GitStatus}
 * @property {string} [workspace] - That tree's workspace name, as for {@link GitStatus}
 * @property {boolean} complete - Whether every repository and file was reached
 * @property {string[]} warnings - What could not be reviewed, one sentence each.
 *   Always an array; empty when nothing was missed.
 * @property {{key: string, params?: Record<string, unknown>, context?: string}[]} [warningMessages] -
 *   The same warnings, in the same order, as server messages for `serverText()`
 * @property {GitScope} [scope] - What was compared
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [gitMissing] -
 *   Set when repositories were found but the machine has no git to read them:
 *   what to install, as a server message for `serverText()`. Each repository is
 *   still listed, unread, with its `error`
 * @property {GitReviewRepo[]} repos - Every repository found, root repo first
 */

/**
 * One line of a hunk. `oldLine` and `newLine` are its number on each side, and
 * the side a line does not exist on has neither — an added line has no number in
 * the old file. `text` carries no leading +/-/space: which side a line is on is
 * `kind`'s job, not the text's.
 * @typedef {object} GitDiffLine
 * @property {string} kind - 'context', 'add' or 'remove'
 * @property {number} [oldLine] - Line number on the old side
 * @property {number} [newLine] - Line number on the new side
 * @property {string} text - The line itself
 */

/**
 * One run of changed lines and the context around it.
 * @typedef {object} GitDiffHunk
 * @property {number} oldStart - First line covered on the old side
 * @property {number} oldLines - Lines covered there
 * @property {number} newStart - First line covered on the new side
 * @property {number} newLines - Lines covered there
 * @property {string} [heading] - The section git names in the `@@` line, usually
 *   the enclosing function. Often absent.
 * @property {GitDiffLine[]} lines - The hunk's lines, in file order
 */

/**
 * One file's change within the scope asked for — by default its whole
 * working-tree change against `HEAD`, index and worktree folded together. Either
 * way it is the same comparison the file's line counts in the manifest come from,
 * so the two can never disagree.
 *
 * `revision` fingerprints every byte the answer describes, including any past a
 * ceiling that were never sent. It is what an anchor asks about: a comment left
 * on a line wants to know whether this is still the same file it was left on, and
 * `HEAD` cannot answer that, because almost every edit under review happens
 * without `HEAD` moving at all.
 * @typedef {object} GitDiff
 * @property {string} repo - Repository this file belongs to, '' for the root repo
 * @property {string} path - File path relative to that repository
 * @property {string} [oldPath] - Former path, for a rename or copy
 * @property {string} status - modified, added, deleted, renamed, copied,
 *   typechange, conflicted, untracked or unchanged
 * @property {boolean} binary - Whether git judged it binary. No patch text is
 *   invented for one: say that it changed and offer what a reader can do with it.
 * @property {boolean} [conflicted] - Whether the index holds unmerged stages for it
 * @property {boolean} truncated - Whether the patch was cut short. The counts
 *   still describe all of it, so say "the rest is not shown" rather than nothing.
 * @property {number} added - Added lines
 * @property {number} removed - Removed lines
 * @property {string} revision - Fingerprint of the change this describes
 * @property {number} context - Unchanged lines carried around each change, as the
 *   request asked for or the default. You can show less of the file than this from
 *   the patch alone; showing more takes another `diff()`.
 * @property {string} [oldMode] - Git's six-digit mode on the old side, when it moved
 * @property {string} [newMode] - Git's six-digit mode on the new side, when it moved
 * @property {GitDiffHunk[]} hunks - The patch, hunk by hunk. Empty for a pure
 *   rename, a mode change, or a binary file — all of which are still changes.
 */

/**
 * Which conversations made what is staged, best first: the `attribution` read.
 * Each lists the staged `files` it made, with the scores it was ranked by.
 * @typedef {object} GitAttribution
 * @property {number} staged - Files staged.
 * @property {{conv: string, title: string, strong: number, weak: number, prior: number, files: string[]}[]} conversations -
 *   The conversations, best first
 */

/**
 * What a commit message is written from: the `commit-context` read.
 * @typedef {object} GitCommitContext
 * @property {string} repo - The repository, '' for the root.
 * @property {boolean} amend - Whether it describes an amend of HEAD.
 * @property {string} [headMessage] - HEAD's message, when amending.
 * @property {{path: string, oldPath?: string, status: string}[]} files - The staged files.
 * @property {string} stat - `--stat` of the change.
 * @property {string} diff - The staged patch, cut to size, every cut marked.
 * @property {boolean} truncated - Whether anything was cut.
 * @property {string[]} subjects - Recent subjects, newest first.
 * @property {string} rules - What the project's instruction files say about commits.
 * @property {boolean} wrapsBody - Whether the repository's bodies are wrapped.
 */

/**
 * What deleting one ref would leave unreachable: the `stranded` read. Only
 * other refs and each tree's HEAD count as reaching a commit, not the reflogs.
 * @typedef {object} GitStranded
 * @property {string} ref - The full ref name asked about.
 * @property {number} count - The commits only it reaches, counted up to a ceiling.
 * @property {boolean} [more] - Whether there are more than `count`.
 */

/**
 * One conversation's account of why files changed: the `digest` read.
 * @typedef {object} GitDigest
 * @property {string} conv - The conversation.
 * @property {string} title - Its title.
 * @property {string[]} userMessages - Its user messages, oldest first.
 * @property {{user: string, closing: string, files: string[]}[]} turns - The turns that touched the files.
 * @property {boolean} truncated - Whether anything was cut.
 */

/**
 * The project's git working tree, and the writes that change it.
 *
 * There are three kinds of question here and they are not the same one.
 * `status` is ambient: small, bounded, best-effort, and shared with the info
 * card. `review`, `diff` and `changes` are the deliberate read — what the user
 * works from — and they are asked for, never on a timer. `run` is a write.
 *
 * Nothing here is polled. The server watches a tree's git state — index, refs,
 * HEAD, working files, an operation in progress — while a window asks it to, and
 * pushes a change when any of them moves. The ambient status re-reads itself on
 * those (`onChange` says a fresh answer arrived); a pin reading the deliberate
 * half hears them through `watch` and decides for itself what to read again.
 * Never poll: the push already covers it, and a timer would run git for nothing.
 *
 * A write is a **job**. `run` starts it on the server and settles when it ends;
 * meanwhile `watch` hands you the job at every state change, with what a
 * commit's hooks print as they print it. What the write did to the tree arrives
 * as a change like any other.
 * @typedef {object} GitClient
 * @property {() => GitStatus|null} status - The latest status, or null when
 *   nothing has been read yet. Null is not "no repositories": say you are still
 *   looking rather than claiming the project has no git.
 * @property {() => string} error - The last read's failure, or ''. The previous
 *   status is kept beside it, because a transient failure should not blank a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when a new
 *   status has arrived. Carries nothing: call `status()`. Returns an unsubscribe
 *   function; the host also drops the subscription when the pin is torn down.
 * @property {() => Promise<void>} refresh - Ask git now. Never rejects: a failure
 *   shows up on `error()`.
 * @property {(workspace: string, options?: {signal?: AbortSignal}) => Promise<GitStatus>} statusOf -
 *   The same bounded status, read once for the tree of one workspace ('' for the
 *   project) rather than the one in view, and shared with nothing. Rejects on a
 *   refusal or failure with the server's reason, and when cancelled.
 * @property {(options?: {signal?: AbortSignal, scope?: string, workspace?: string, conv?: string}) => Promise<GitReview>} review -
 *   Read the whole working tree for review: every repository, every changed file,
 *   nothing skipped for being expensive, and whatever could not be reached named
 *   in `warnings` rather than quietly left out. Ask when a review is opened or
 *   refreshed and not on a timer — concurrent callers share one read, so a second
 *   surface costs nothing, but a loop here runs git in a loop. Rejects if the read
 *   failed, if you cancelled it, or if the tree changed while it was out: an
 *   answer about a tree nobody is looking at is not an answer.
 *   `scope` is what to compare (see {@link GitScope}); omit it for the working
 *   tree against `HEAD`. A scope the host cannot read rejects, with the reason.
 *   `workspace` names the workspace whose tree to read; omit it for the tree
 *   of the workspace the visible conversation works in, or the project's.
 *   `conv` names the conversation whose turn the `@turn` scope compares against,
 *   and is required with it.
 * @property {(repo: string, path: string, options?: {signal?: AbortSignal, contextLines?: number, scope?: string, workspace?: string, conv?: string}) => Promise<GitDiff>} diff -
 *   One file's change, named the way the manifest names it: `repo` is the
 *   repository's path within the project ('' for the root repo) and `path` is the
 *   file's path within that repository. Asked for one file at a time, when
 *   something is about to show it — never in a loop over a manifest. Pass a signal
 *   and cancelling actually cancels the read, which is what keeps a user clicking
 *   down a file list from leaving a queue of patches behind them. The host also
 *   cancels everything this pin has out when the pin goes away.
 *   `contextLines` is how many unchanged lines to carry around each change, -1 for
 *   the whole file; omit it for the default. The patch reports the width it came
 *   back at, because you can draw less of it than that but not more.
 *   `scope` (and `conv`) must be the ones the manifest was read with, or the file may not be in it.
 * @property {(options?: {repo?: string, workspace?: string, signal?: AbortSignal}) => Promise<GitChanges>} changes -
 *   One repository's changes, every file with what is staged and what is not:
 *   what a list to stage, discard and commit from is drawn from. `repo` is the
 *   repository's path within the tree, '' or omitted for the root. Read it when
 *   the pin opens and again when `watch` says so, never on a timer. Rejects on a
 *   refusal or failure with the server's reason, if you cancelled it or the pin
 *   went away, and — when no `workspace` was named — if the tree in view changed
 *   while it was out.
 * @property {(kind: 'refs'|'worktrees'|'log'|'commit'|'submodules'|'blame'|'attribution'|'commit-context'|'stranded', options?: {repo?: string, workspace?: string, signal?: AbortSignal, log?: GitLogQuery, commit?: string, blame?: {path: string, rev?: string}, amend?: boolean, conv?: string, ref?: string}) => Promise<GitRefs|GitWorktrees|GitLog|GitCommit|GitSubmodules|GitBlame|GitAttribution|GitCommitContext|GitStranded>} read -
 *   One of the git client's other reads of one repository, read and refused as
 *   `changes` is: `refs` answers a {@link GitRefs}, `worktrees` a
 *   {@link GitWorktrees}, `log` one page of its history as `log` asks
 *   ({@link GitLog}), `commit` the commit `commit` names
 *   ({@link GitCommit}), `submodules` its submodules
 *   ({@link GitSubmodules}), and `blame` which commit last changed each
 *   line of the file `blame` names ({@link GitBlame}). `attribution` answers
 *   which conversations made what is staged, best first
 *   (`{staged, conversations: [{conv, title, strong, weak, prior, files}]}`),
 *   scored for an amend of HEAD when `amend` is set, with `conv` (the visible
 *   conversation) breaking ties; `commit-context` answers what a commit
 *   message is written from — the staged files, stat, diff cut to size,
 *   recent subjects and the project's commit rules — for an amend of HEAD
 *   when `amend` is set; `stranded` answers how many commits only the full
 *   ref `ref` names reaches — what deleting it would leave unreachable
 *   ({@link GitStranded}).
 * @property {(conv: string, paths: string[], options?: {repo?: string, workspace?: string, signal?: AbortSignal}) => Promise<GitDigest>} digest -
 *   One conversation's account of why files changed, for a commit message: its
 *   user messages, and the turns that touched `paths` with the agent's closing
 *   message of each. Read-only; a conversation the project lacks rejects.
 * @property {(op: GitOp, options?: {workspace?: string}) => Promise<GitJob>} run -
 *   Start one write and wait for it to end. Resolves with the job once it is
 *   done. Rejects, when it failed or was cancelled, with an Error whose `job` is
 *   the job, whose `kind` is `job.errorKind`, and whose message is the server's
 *   reason, ready to show. A write the server would not start at all rejects
 *   with the request's error, which has no `job`. Without a `workspace` it
 *   writes to the tree in view at the moment of the call; a job already out stays
 *   with its own tree, and runs to its end even if the pin goes away.
 * @property {(id: string, options?: {workspace?: string}) => Promise<GitJob>} cancel -
 *   Ask the server to stop a job, by `job.id`, in the tree it runs in. Resolves
 *   with the job as it stood once asked; a `run` waiting on it rejects once it
 *   has stopped.
 * @property {(options?: {workspace?: string}) => Promise<GitJob[]>} jobs -
 *   A tree's jobs: every one running and the last hundred finished, newest
 *   first. What a command log starts from before `watch` adds to it.
 * @property {(options?: {repo?: string, workspace?: string}) => Promise<GitJob|null>} fetchOnShow -
 *   The fetch a git client makes the first time it shows a repository: one per
 *   repository per server session, whichever of its trees or pins asks first.
 *   Resolves with the fetch once it is done, or null when the repository was
 *   fetched this way before. Rejects as `run` does; the fetch is `auto`, and
 *   never asks for credentials.
 * @property {(id: string, reply: {prompt: string, answer?: string, decline?: boolean}, options?: {workspace?: string}) => Promise<GitJob>} answer -
 *   Answer the question job `id` is waiting on — `prompt` is its `prompt.id` —
 *   with `answer` ('yes' for a confirm), or decline it. The first answer from
 *   any window is the one taken; one to a question already answered, or no
 *   longer asked, rejects. Resolves with the job as it then stands. The answer
 *   goes to git and nowhere else: no job, frame or log holds it.
 * @property {(listener: (event: GitWatchEvent) => void, options?: {workspace?: string}) => (() => void)} watch -
 *   Hear every git event of one tree: its changes, its jobs, and a resync when
 *   what you read may be stale with no change to say so. Without a `workspace`,
 *   the tree in view, moving with the user. Returns an unsubscribe function;
 *   the host also drops the subscription when the pin is torn down.
 */

/**
 * One side of one file's change, in lines.
 * @typedef {object} GitChangeStat
 * @property {number} added - Added lines
 * @property {number} removed - Removed lines
 */

/**
 * One changed file in {@link GitChanges}. `index` and `worktree` are git's
 * porcelain letters for each side — '.' for an unchanged side, '?' for an
 * untracked file — and a file staged and then edited again has both.
 * @typedef {object} GitChangedFile
 * @property {string} path - File path relative to the repository
 * @property {string} [oldPath] - Former path, for a rename or copy
 * @property {string} index - The staged side's letter
 * @property {string} worktree - The unstaged side's letter
 * @property {boolean} [conflicted] - Whether it is an unresolved merge
 * @property {boolean} [submodule] - Whether the path is a submodule
 * @property {boolean} [submoduleCommit] - A submodule checked out at another
 *   commit than the index records: the one part of its `worktree` change that
 *   staging takes
 * @property {boolean} [submoduleModified] - A submodule holding modified tracked
 *   files, which only a commit inside it takes
 * @property {boolean} [submoduleUntracked] - A submodule holding untracked files, likewise
 * @property {boolean} [binary] - Whether git judged it binary
 * @property {boolean} [lfs] - Whether it is stored in Git LFS
 * @property {GitChangeStat} [staged] - The index against HEAD; absent when
 *   that side has no line changes (a binary file never has one)
 * @property {GitChangeStat} [unstaged] - The working tree against the index; absent likewise
 */

/**
 * The operation in progress in a tree, as the Operation banner says it.
 * @typedef {object} GitStopped
 * @property {'merge'|'rebase'|'cherry-pick'|'revert'} kind - What it is
 * @property {string} [branch] - The branch it changes; for a rebase, the one being rebased
 * @property {string} [other] - The other side by name: the branch merged in or
 *   rebased onto; absent when no branch points there
 * @property {string} [otherSha] - The other side's commit
 * @property {{sha: string, subject: string}} [commit] - The commit being applied
 * @property {number} [step] - How far a rebase has got: the commit it is on
 * @property {number} [steps] - Of how many
 * @property {string} [from] - Where a rebase's branch was before it began, which aborting puts it back to
 * @property {string} [setAside] - The stash the tree's changes wait in until it ends
 * @property {boolean} [between] - A pick or revert of several commits stopped between them:
 *   no `commit` is being applied, and continuing goes on to the rest
 * @property {number} [left] - Commits of a pick or revert sequence still to come after this one
 */

/**
 * One repository's changes, as `changes()` reads them.
 * @typedef {object} GitChanges
 * @property {string} repo - The repository, '' for the root
 * @property {string} branch - Current branch, '' on a detached head
 * @property {string} upstream - Tracking branch, '' when there is none
 * @property {number} ahead - Commits this branch has that its upstream does not
 * @property {number} behind - Commits its upstream has that this branch does not
 * @property {boolean} detached - Whether HEAD is detached
 * @property {boolean} initial - Whether the repository has no commits yet
 * @property {{sha: string, message: string, pushed: boolean}} [head] - The commit
 *   HEAD names, absent before the first: what an amend starts from, and whether
 *   it has been pushed (and so is no longer the user's alone to undo)
 * @property {boolean} wrapsBody - Whether this repository's commit bodies are
 *   wrapped, so a commit box can follow suit
 * @property {string} [operation] - A merge, rebase or the like in progress
 * @property {GitStopped} [stopped] - That operation in full; absent when there is none
 * @property {number} remotes - How many remotes the repository has: fetching,
 *   pulling and pushing need one
 * @property {GitChangedFile[]} files - Every changed file
 * @property {boolean} truncated - Whether there are more files than listed
 */

/**
 * A repository's branches, its remotes' branches, its tags and its stashes —
 * the same for every worktree of it. Stashes are named by `sha`, never by
 * position. `fetchedAt` is when it last fetched (ms, 0 for never).
 * @typedef {object} GitRefs
 * @property {string} repo - The repository
 * @property {{name: string, sha: string, subject: string, date: number, upstream?: string, ahead: number, behind: number, gone?: boolean, worktree?: string, head?: boolean}[]} branches -
 *   Local branches; `worktree` is the tree that has one out, anywhere on disk,
 *   and `head` whether that is the tree read
 * @property {{name: string, url: string, branches: {name: string, sha: string, subject: string, date: number}[]}[]} remotes -
 *   Each remote, with where it fetches from ('' for nowhere set) and its branches named without it
 * @property {{name: string, sha: string, target: string, annotated: boolean, subject: string, date: number}[]} tags -
 *   Newest first; `sha` is the tag's object, `target` its commit
 * @property {{sha: string, message: string, date: number}[]} stashes - Newest first
 * @property {number} fetchedAt - When it last fetched
 * @property {boolean} truncated - Whether a section was cut short
 */

/**
 * One read of a repository's history. The server keeps the list a client is
 * reading as a graph session: the first read opens one (leave `graph` out)
 * and names it in its answer; pass that `graph` back for every later page of
 * the same list. One the server has dropped is opened again for the rest of
 * the query, under a new id — so a new id means the rows you hold are gone.
 * @typedef {object} GitLogQuery
 * @property {string} [graph] - The session an earlier read named
 * @property {'head'|'all'|'ref'|'reflog'} [scope] - What HEAD reaches (the default), every
 *   branch, remote branch, tag and worktree HEAD, what `ref` reaches, or where the
 *   tree's HEAD has been (its reflog, newest first, each commit once, flat)
 * @property {string} [ref] - The ref, for the `ref` scope
 * @property {string} [message] - Only commits whose message holds this text, any case
 * @property {string} [author] - Only commits whose author holds this text, any case
 * @property {string} [path] - Only commits that changed this path, followed across renames
 * @property {number} [offset] - The first row wanted
 * @property {number} [limit] - How many rows (200 when left out, at most 1000)
 * @property {boolean} [refresh] - Catch up with refs that moved first: new commits
 *   arrive on top, ones nothing reaches leave, and `gen` moves on
 * @property {string} [find] - A full commit id to find in the list (`found`)
 * @property {boolean} [worktree] - Show the working tree's changes as a row of the
 *   list, right above HEAD's (`GitLogRow.worktree`). Only a graph of what HEAD
 *   reaches or of every ref has one. It is taken when the session opens and on
 *   each `refresh`, so pass it on every read of a session
 */

/**
 * One commit of a history, and where the graph puts it: `lane` is its dot's
 * column, and `out` the column each of its parents continues in, in parent
 * order.
 * @typedef {object} GitLogRow
 * @property {string} sha - The commit
 * @property {string[]} parents - Its parents, first first
 * @property {string} author - Its author's name
 * @property {string} email - Its author's email
 * @property {number} date - Its author time, Unix seconds
 * @property {string} subject - Its message's first paragraph
 * @property {number} lane - Its dot's lane (0 in a flat list)
 * @property {number[]} out - Its parents' lanes (empty in a flat list)
 * @property {string} [reflog] - In the reflog scope, git's words for the entry
 *   ('commit: …', 'reset: moving to …'); `date` is then the entry's time
 * @property {boolean} [worktree] - The working tree's changes, as the commit they
 *   would make: `sha` is '', HEAD is its one parent (none while HEAD has no
 *   commit), and it is laid out with the rest, right above HEAD's row
 */

/**
 * One page of a history. Lanes never move: every lane in `lanes` other than a
 * row's own passes straight through it, and the lanes entering the next row
 * are these without the row's `lane`, with its `out` — so any page can be
 * drawn by itself. A list filtered by message, author or path is flat
 * (`graphed` false).
 * @typedef {object} GitLog
 * @property {string} graph - The session to pass back for the next page
 * @property {number} gen - Moves on whenever the rows moved under the session; rows of
 *   another generation are not where they were
 * @property {number} offset - The first row's position
 * @property {GitLogRow[]} rows - The rows
 * @property {number[]} lanes - The lanes occupied entering `rows[0]`, in order
 * @property {boolean} more - Whether there are rows past this page
 * @property {number} total - How many rows the list holds, -1 while counting
 * @property {boolean} graphed - Whether the rows carry lanes
 * @property {number} found - Where `find` is in the list, -1 if it is not
 */

/**
 * One commit as a history's detail shows it, and every file it changed
 * against its first parent (the tree of nothing, for a root commit). `scope`
 * is that comparison as a review scope (`<sha>^!`): pass it to `diff` for one
 * file's change. `files` are lettered as a review's are, the change on the
 * `worktree` side.
 * @typedef {object} GitCommit
 * @property {string} repo - The repository
 * @property {string} sha - The commit
 * @property {string[]} parents - Its parents, first first
 * @property {{name: string, email: string, date: number}} author - Who wrote it, and when (Unix seconds)
 * @property {{name: string, email: string, date: number}} committer - Who committed it, and when
 * @property {string} subject - Its message's first paragraph
 * @property {string} body - The rest of its message
 * @property {string} scope - The review scope its files compare
 * @property {string} base - The commit (or empty tree) it is compared against
 * @property {string} target - The commit itself
 * @property {GitFile[]} files - The files it changed, by path, up to a ceiling
 * @property {number} total - How many files it changed
 * @property {boolean} truncated - Whether `files` stops short of `total`
 */

/**
 * Every working tree of a repository, the main one first. `tree` is the id
 * that views one as a `workspace` option (null when it cannot be viewed: gone,
 * or bare), and `treeRepo` the repository to view within it, by its path there
 * (absent for its root: present when `tree` names the tree a nested
 * repository's checkout is in); `rows` the open workspace rows rooted there.
 * `dirty` is null when the tree's state could not be read.
 * @typedef {object} GitWorktrees
 * @property {string} repo - The repository
 * @property {{path: string, head: string, branch?: string, detached?: boolean, bare?: boolean, main?: boolean, current?: boolean, locked?: boolean, lockReason?: string, prunable?: boolean, pruneReason?: string, dirty: number|null, upstream?: string, ahead: number, behind: number, operation?: string, tree: string|null, treeRepo?: string, rows?: string[]}[]} trees -
 *   The trees
 */

/**
 * A repository's submodules: each one `.gitmodules` names and the index records
 * a commit for. `path` is relative to the repository; `recorded` is the commit
 * an update checks out, and `head` and `branch` what is checked out in it now
 * (absent when nothing is). `state` is 'current' (at the recorded commit),
 * 'moved' (at another), 'uninitialized' (not checked out) or 'conflicted' (a
 * merge left its commit in conflict).
 * @typedef {object} GitSubmodules
 * @property {string} repo - The repository
 * @property {{name: string, path: string, url: string, recorded: string, head?: string, branch?: string, state: 'current'|'moved'|'uninitialized'|'conflicted'}[]} submodules -
 *   The submodules, by path
 * @property {boolean} truncated - Whether there were more than are listed
 */

/**
 * Which commit last changed each line of a file: `lines[i]` is the index in
 * `commits` of line i+1's. `rev` is the revision blamed — a commit, '' for
 * the working tree, '@staged' for the index — and a commit with `sha` '' holds
 * the lines nobody has committed yet.
 * @typedef {object} GitBlame
 * @property {string} repo - The repository
 * @property {string} path - The file
 * @property {string} rev - The revision blamed
 * @property {{sha: string, author: string, date: number, summary: string}[]} commits -
 *   The commits, each once; `date` its author time, Unix seconds
 * @property {number[]} lines - Each line's commit, by index
 */

/**
 * One write, as `run` takes it. `kind` says what to do, and which other fields
 * matter is the kind's business; every path is relative to the repository.
 *
 * - `stage`, `unstage`, `discard`: `paths`. A discard is recoverable: the job's
 *   `result.discard` is what an `undo-discard` names in `discard`.
 * - `stage-all`, `unstage-all`: nothing more.
 * - `stage-lines`, `unstage-lines`, `discard-lines`: `path`, `lines`, and the
 *   `context` and `revision` of the diff the lines were chosen on — a different
 *   revision refuses the write, since the same numbers would be other lines.
 * - `ignore`: `paths[0]` and `pattern`.
 * - `commit`: `message`, `amend`, and `noVerify` to skip the pre-commit and
 *   commit-msg hooks. `result.head` is the new commit.
 * - `undo-commit`: `expectHead`, the commit it undoes.
 *
 * The Refs place's writes name a branch, tag or stash as the client saw it —
 * `expectSha` for a branch or tag, the stash's commit in `stash` — and one that
 * has moved since is refused as 'stale'. `dirty` says what to do with local
 * changes in the way: 'carry' them (refused as 'dirty' if git would overwrite
 * them) or 'stash' them first.
 *
 * - `branch-create`: `name`, `rev` (default HEAD), `switch`.
 * - `switch`: `branch`; with `track`, a new `branch` tracking `rev`; with
 *   `detach`, `rev`. `dirty`; `result.stash` is a stash it made.
 * - `branch-rename`: `branch` to `name`. `branch-upstream`: `branch` and
 *   `upstream` ('' unsets it).
 * - `branch-delete`: `branch`, `expectSha`, `force` for an unmerged one.
 *   `result.sha` is what a `ref-restore` names in `sha`.
 * - `merge`, `rebase`: `rev`, `dirty`. A merge's `mode` is 'no-ff' for a merge
 *   commit even where it could fast-forward, or 'squash' for `rev`'s changes
 *   staged and nothing committed — refused over local changes (set aside or
 *   not), and taken back and refused where it conflicts.
 * - `fast-forward`: `branch`, `expectSha`, `rev` (default its upstream).
 * - `ref-restore`: `ref` (refs/heads/… or refs/tags/…) and `sha`, only if
 *   the ref does not exist.
 * - `stash-save`: `message`, `untracked`. `stash-apply`, `stash-pop`,
 *   `stash-drop`: `stash`; a drop's `result.stash` and `result.message` are
 *   what `stash-store` takes back. `stash-branch`: `stash`, `name`.
 * - `tag-create`: `name`, `rev`, and `message` for an annotated tag.
 *   `tag-delete`: `name`, `expectSha`; `result.sha` as for a branch.
 * - `worktree-lock` (`reason`), `worktree-unlock`, `worktree-remove`
 *   (`force`; a dirty tree's changes are saved first, in `result.saved`):
 *   `worktree`, a path. `worktree-prune`: nothing more.
 * - `remote-add`: `name`, `url`. `remote-rename`: `remote` to `name`, its
 *   remote-tracking branches and the upstreams set to them with it.
 *   `remote-set-url`: `remote`, `url`. `remote-remove`: `remote`, taking its
 *   remote-tracking branches and the upstreams set to them with it.
 *
 * The History place's writes act on the current branch:
 *
 * - `cherry-pick`, `revert`: `rev` (a merge against its first parent),
 *   `dirty` as for a merge. One that would change nothing is refused.
 * - `reset`: the current branch, at `expectHead`, to `rev`; `mode` 'soft',
 *   'mixed', 'hard', or 'keep' (the files `rev` changes moved, local changes to
 *   the rest kept; refused as 'dirty' when they overlap). `result.sha` is its old tip, which resetting back
 *   names. A hard reset saves the changes it throws away first, in
 *   `result.saved`; a hard reset back naming that save in `discard` writes
 *   them back (not what was staged), refused as 'dirty' if the tree has changed.
 *
 * The rewrites act on the current branch at `expectHead`, on commits it holds.
 * `result.sha` is its old tip, which a `reset` back to undoes. Rewriting a
 * commit a remote-tracking branch has is refused as 'published' unless `force`.
 *
 * - `reword`: `rev`'s message to `message`. `squash`: the run of commits from
 *   `rev` to `sha` (either way round, no merge in it) into one, with their
 *   messages joined. Neither touches the index or the working tree.
 * - `fixup`: what is staged folded into `rev`; `drop`: `rev` taken out. Both
 *   rebase what follows, so `dirty` is as for a merge, they may stop as
 *   'conflicts', and a merge after `rev` is refused.
 *
 * The Operation place's writes act on the merge, rebase, cherry-pick or revert
 * in progress, named in `operation` as the client saw it ('stale' when another
 * is in progress). Each ends with `result.head`; one that ends the operation
 * puts back the changes a write set aside before it stopped, and a
 * `result.stash` is one that did not go back cleanly.
 *
 * - `operation-continue`: refused as 'conflicts' while anything is unmerged;
 *   a merge is committed with git's message, and the others go on, stopping as
 *   'conflicts' on the next commit that conflicts.
 * - `operation-skip`: drops the commit a rebase, pick or revert stopped on.
 * - `operation-abort`: back to where it started.
 * - `operation-quit`: a cherry-pick or revert forgotten, with the rest of its
 *   sequence; HEAD, the index and the working tree are left as they are.
 * - `resolve`: `path`'s conflict, by `mode` — 'ours' or 'theirs' takes that
 *   side's version (no file, for a side that deleted it), 'resolved' stages
 *   the file as it is, refused as 'markers' while it still has conflict
 *   markers unless `force`. The working file is saved first; `result.discard`
 *   names the save.
 * - `unresolve`: undoes a resolve while the operation is in progress — `path`
 *   conflicted again, and the save named in `discard` written back; 'stale'
 *   if the file has changed since.
 *
 * The writes that talk to a remote run one at a time per repository, beside
 * its local writes rather than queued behind them, and report their meter in
 * the job's `progress`.
 *
 * - `fetch`: every remote, pruned.
 * - `pull`: the current branch from its upstream, as a fast-forward; one that
 *   can't be is refused as 'diverged', and `mode` 'merge' or 'rebase' says how
 *   to bring it in instead. `dirty` as for a merge.
 * - `push`: `branch` (default the current one) to its upstream; one with none
 *   is published — pushed to `remote`, or the repository's obvious one, and
 *   tracked. With `name`, to the branch of that name on `remote` (or the obvious
 *   one) instead, whatever its upstream, made its upstream only with `track`.
 *   With `force`, only over `expectSha`, the remote sha the user saw.
 * - `push-tag`: tag `name`, to `remote` or the obvious one. `push-tags`: every
 *   tag, likewise; one the remote has at another commit is left and refused as
 *   'rejected', the rest pushed.
 * - `remote-branch-delete`: `ref`, a remote-tracking branch ('origin/feat'), at
 *   `expectSha`.
 * - `submodule-update`: the submodule at `path` checked out at the commit the
 *   repository records — cloned first if it never was, and that commit fetched
 *   if it lacks it. `result.sha` and `result.branch` are where its HEAD was
 *   ('' for one not checked out): a `switch` of the submodule's own repository
 *   back to them undoes it. Refused as 'dirty' when local changes are in the way.
 * @typedef {object} GitOp
 * @property {'stage'|'unstage'|'stage-all'|'unstage-all'|'stage-lines'|'unstage-lines'|'discard'|'discard-lines'|'undo-discard'|'ignore'|'commit'|'undo-commit'|'branch-create'|'switch'|'branch-rename'|'branch-upstream'|'branch-delete'|'merge'|'rebase'|'fast-forward'|'ref-restore'|'stash-save'|'stash-apply'|'stash-pop'|'stash-drop'|'stash-store'|'stash-branch'|'tag-create'|'tag-delete'|'worktree-lock'|'worktree-unlock'|'worktree-remove'|'worktree-prune'|'remote-add'|'remote-remove'|'remote-rename'|'remote-set-url'|'fetch'|'pull'|'push'|'push-tag'|'push-tags'|'remote-branch-delete'|'submodule-update'|'cherry-pick'|'revert'|'reset'|'reword'|'squash'|'fixup'|'drop'|'operation-continue'|'operation-skip'|'operation-abort'|'operation-quit'|'resolve'|'unresolve'} kind - What to do
 * @property {string} repo - The repository, '' for the root
 * @property {string[]} [paths] - The files
 * @property {string} [path] - The file, for the lines kinds
 * @property {{old?: number, new?: number}[]} [lines] - The chosen lines, by their number on each side
 * @property {string} [context] - The context the lines' diff was read at
 * @property {string} [revision] - That diff's revision
 * @property {'file'|'extension'|'folder'} [pattern] - What an ignore covers
 * @property {string} [message] - A commit's message
 * @property {boolean} [amend] - Whether a commit amends HEAD
 * @property {boolean} [noVerify] - Commit without the pre-commit and commit-msg hooks
 * @property {string} [expectHead] - The HEAD an undo-commit undoes, or a reset moves from
 * @property {string} [discard] - The discard an undo-discard restores, or the save a hard reset back or an unresolve writes back
 * @property {string} [branch] - The branch
 * @property {string} [name] - A new branch's, tag's or remote's name; the branch a push goes to
 * @property {string} [rev] - A revision: where to start, what to merge
 * @property {string} [upstream] - An upstream such as 'origin/main'
 * @property {string} [ref] - The ref a ref-restore restores
 * @property {string} [sha] - The object it restores it to; the other end of a squash
 * @property {string} [stash] - A stash, by its commit
 * @property {string} [worktree] - A worktree, by its path
 * @property {string} [reason] - Why a worktree is locked
 * @property {string} [expectSha] - Where the client saw the branch or tag
 * @property {'carry'|'stash'} [dirty] - What to do with local changes in the way
 * @property {boolean} [force] - Delete an unmerged branch; remove a dirty or locked worktree; mark a file with conflict markers resolved; rewrite a published commit
 * @property {boolean} [switch] - Switch to the branch made
 * @property {boolean} [track] - Make the branch track `rev`; make the branch a push with `name` goes to the upstream
 * @property {boolean} [detach] - Switch to `rev` detached
 * @property {boolean} [untracked] - Stash untracked files too
 * @property {string} [remote] - The remote a publish, a push with `name` or a tag goes to; the remote renamed, re-pointed or removed
 * @property {string} [url] - A remote's URL
 * @property {'merge'|'rebase'|'no-ff'|'squash'|'soft'|'mixed'|'hard'|'keep'|'ours'|'theirs'|'resolved'} [mode] - How a pull brings in what it can't fast-forward to; how a merge brings `rev` in; what a reset keeps; how a conflict is resolved
 * @property {'merge'|'rebase'|'cherry-pick'|'revert'} [operation] - The operation in progress the client saw
 */

/**
 * One write as the server reports it.
 * @typedef {object} GitJob
 * @property {string} id - Identifies it, for `cancel`
 * @property {string} workspace - The tree it runs in, '' for the project
 * @property {string} repo - The repository
 * @property {GitOp['kind']} kind - What it does
 * @property {string[][]} commands - Every git command run so far, as argv after `git`
 * @property {string} state - 'running', 'done', 'failed' or 'cancelled'
 * @property {string} output - The tail of what hooks printed
 * @property {string} [error] - Why it failed, in English
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [errorMessage] -
 *   The same, for `serverText()`
 * @property {string} errorKind - Which refusal it was: 'refused' (the write did
 *   not make sense), 'stale' (what it was chosen on has moved), 'locked'
 *   (another git holds the lock), 'dirty' (local changes are in the way),
 *   'unmerged' (a branch delete that needs `force`), 'checked-out' (the branch
 *   is out in `worktree`), 'conflicts' (it stopped on them), 'markers' (a file
 *   marked resolved still has conflict markers), 'diverged' (it
 *   can't fast-forward), 'rejected' (the remote turned a push down), 'remote'
 *   (a publish needs to be told which remote), 'auth' (the remote was not
 *   signed in to: a question declined, a password refused, no key it takes) or
 *   'published' (a rewrite of a commit a remote has, which needs `force`);
 *   '' for any other failure
 * @property {string} [lockPath] - The lock a 'locked' job was stopped by
 * @property {string} [branch] - The branch an 'unmerged' or 'checked-out' refusal is about
 * @property {string} [worktree] - The tree a 'checked-out' branch is out in
 * @property {boolean} [auto] - Started unasked, by `fetchOnShow`: its failure is quiet
 * @property {{phase: string, remote?: boolean, percent: number, done: number, total?: number, rate?: string, finished?: boolean}} [progress] -
 *   A network write's latest meter reading: git's English `phase` ('Receiving
 *   objects'), said by the remote end when `remote` is set, and how far
 *   through it (`percent` -1 when git gives only a count)
 * @property {string} [prefer] - The way into a 'diverged' pull the repository puts first, 'merge' or 'rebase'
 * @property {string[]} [rejected] - The remote refs a 'rejected' push was turned down for
 * @property {string} [reason] - Git's word for why ('fetch first', 'non-fast-forward', a hook's complaint)
 * @property {string[]} [remotes] - The remotes a 'remote' publish could go to
 * @property {{id: string, text: string, kind: string}} [prompt] -
 *   The question a network write is waiting on the user to answer — git's or
 *   ssh's own words in `text`: a username to type in the open ('text'), a
 *   password or passphrase to type masked ('secret'), or a yes or no
 *   ('confirm'). Answer it with `answer`. Gone once answered, from anywhere.
 * @property {{head?: string, discard?: string, sha?: string, stash?: string, message?: string, saved?: string, branch?: string}} result -
 *   What it left to know: the commit HEAD names after a commit or undo, a
 *   discard's recovery point, and what undoing a delete, drop or stash needs
 */

/**
 * What `watch` hands its listener, told apart by `type`:
 *
 * - `git-change`: some of the tree's git state moved. `repos` names each
 *   repository by its path in the tree ('' for the root) and which parts
 *   changed: 'index', 'refs', 'head', 'worktree', 'operation'. It carries no
 *   status; read again what those parts affect.
 * - `git-job`: a job in the tree changed state or printed output; `job` is it as
 *   it now stands.
 * - `git-resync`: anything read before may be stale with no change to say so —
 *   the watch moved to another tree, or the connection was re-established. Read
 *   everything again.
 * @typedef {GitChangeEvent
 *   | {type: 'git-job', workspace: string, job: GitJob}
 *   | {type: 'git-resync', workspace: string}} GitWatchEvent
 */
