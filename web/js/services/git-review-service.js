//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The deliberate read of the project's working tree: the manifest a review is
 * worked from, and one file's patch at a time.
 *
 * Separate from {@link module:services/git-status-cache} on purpose, because the
 * two ask different questions. That one is ambient — a small, bounded,
 * best-effort answer polled for a number in the corner of a window — and this one
 * is what the user reads before telling the agent what to fix, where a file left
 * out is a change nobody reviews. Sharing state between them would make one of
 * the two wrong: either the card pays for a full review every twenty seconds, or
 * a review shows only what the card could cheaply reach.
 *
 * Nothing is retained. A manifest and a patch are live answers about a tree that
 * changes under them, and one kept here would be handed to the next surface as
 * though it were current; the surface showing one already holds what it drew, and
 * it knows when it last asked. So this module holds exactly two things: the
 * request currently out for each scope, so that two surfaces asking the same
 * question at once run git once, and
 * which tree the questions are about — the project, or the visible
 * conversation's workspace — so that an answer arriving after that changed is
 * refused instead of shown.
 *
 * It never polls. A review happens because someone asked for one.
 * @module services/git-review-service
 */

import api from './api.js';
import { gitWorkspaceId, onGitWorkspaceChange } from './git-workspace.js';
import wsService from './websocket.js';

/** @typedef {import('./api.js').GitReview} GitReview */
/** @typedef {import('./api.js').GitReviewRepo} GitReviewRepo */
/** @typedef {import('./api.js').GitFileDiff} GitFileDiff */

/**
 * Bumped whenever the tree these questions are about changes — a project switch,
 * or the user moving to a conversation that works somewhere else. An answer that
 * comes back after its generation has passed describes a tree nobody is looking
 * at, so it is refused rather than handed over.
 */
let _generation = 0;

/**
 * The reviews currently out, by scope, each shared by the callers asking that
 * scope's question. Two pins reviewing different scopes ask different questions
 * and must not be handed each other's answer.
 * @type {Map<string, Promise<any>>}
 */
const _inFlight = new Map();

/** @returns {Error} The refusal a stale answer gets. */
function staleError() {
  return new Error('The tree changed while git was being read.');
}

/** @returns {DOMException} The rejection a caller that cancelled gets. */
function cancelledError() {
  return new DOMException('The read was cancelled.', 'AbortError');
}

/**
 * Hand one caller the shared answer, or its own cancellation — whichever comes
 * first.
 *
 * A cancellation belongs to the caller that asked for it and to nobody else: the
 * request is shared, so aborting it would cancel a review another surface is
 * still waiting for. The request therefore runs to its end however many callers
 * walk away from it, which costs one bounded read of a tree we were asked about.
 * @template T
 * @param {Promise<T>} promise - The shared request.
 * @param {AbortSignal} [signal] - This caller's signal, if it brought one.
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
 * The manifest as a caller may rely on it. `complete` is the field a review
 * turns on, so it is true only when the server said so: silence is not a claim
 * of completeness, and a body that made no claim must not be drawn as the whole
 * working tree.
 * @param {any} data - What the endpoint answered with.
 * @returns {GitReview} The manifest, with every list present.
 */
function asReview(data) {
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  return {
    root: String(data?.root || ''),
    ...(data?.workspace ? { workspace: String(data.workspace) } : {}),
    ...(data?.scope ? { scope: data.scope } : {}),
    complete: data?.complete === true,
    warnings: Array.isArray(data?.warnings) ? data.warnings.map(String) : [],
    repos: repos.map((/** @type {any} */ repo) => ({
      ...repo,
      complete: repo?.complete === true,
      files: Array.isArray(repo?.files) ? repo.files : [],
    })),
  };
}

/**
 * One file's patch as a caller may rely on it.
 * @param {any} data - What the endpoint answered with.
 * @returns {GitFileDiff} The patch, with its hunks present.
 */
function asDiff(data) {
  if (!data) throw new Error('Git said nothing about that file.');
  return { ...data, hunks: Array.isArray(data.hunks) ? data.hunks : [] };
}

const gitReviewService = {
  /**
   * Read the manifest. Concurrent callers share one request, so a board and a
   * detached window opening on the same moment cost one review and not two; each
   * of them may still cancel its own wait without disturbing the other's.
   * @param {{signal?: AbortSignal, scope?: string}} [options] - Cancellation, and
   *   what to compare ('' or omitted for the working tree against HEAD).
   * @returns {Promise<GitReview>} The manifest, as the server described it.
   */
  async review(options = {}) {
    const generation = _generation;
    const scope = options.scope || '';
    let pending = _inFlight.get(scope);
    if (!pending) {
      const request = api.getGitReview({ workspaceId: gitWorkspaceId(), scope }).finally(() => {
        // Only if it is still ours: a project switch in between has already let
        // go of this one, and clearing unconditionally would discard the request
        // that replaced it.
        if (_inFlight.get(scope) === request) _inFlight.delete(scope);
      });
      _inFlight.set(scope, request);
      pending = request;
    }
    const data = await forCaller(pending, options.signal);
    if (generation !== _generation) throw staleError();
    return asReview(data);
  },

  /**
   * Read one file's change within a scope, by default its working-tree change
   * against HEAD.
   *
   * Not shared and not kept: a patch is one surface's answer about one file, so
   * the caller's signal goes straight to the request and cancelling it cancels
   * the read — which is what stops a user clicking down a file list from leaving
   * a queue of patches nobody will look at behind them.
   * @param {string} repo - Repository relative to the project root, '' for the root repo.
   * @param {string} path - File relative to that repository.
   * @param {{signal?: AbortSignal, contextLines?: number, scope?: string}} [options] - Cancellation,
   *   and how much of the file around each change to ask for (-1 for the whole
   *   file). The reader chooses that, so it belongs to the request and not to the
   *   endpoint; the patch says which width it came back at. `scope` is what to
   *   compare, as for `review`, and must be the one the manifest was read with.
   * @returns {Promise<GitFileDiff>} The patch and what happened to the file.
   */
  async diff(repo, path, options = {}) {
    const generation = _generation;
    const data = await api.getGitDiff(repo, path, {
      signal: options.signal, workspaceId: gitWorkspaceId(), contextLines: options.contextLines,
      scope: options.scope || undefined,
    });
    if (generation !== _generation) throw staleError();
    return asDiff(data);
  },

  /**
   * Stop expecting answers about the tree we were looking at, as a project
   * switch or a move to a differently-bound conversation does. Anything still out is left to arrive and be refused.
   *
   * Exported for tests as well, which cannot otherwise get back to the initial
   * state — and cannot use the broadcast, since the session answers that one by
   * reloading the window.
   * @returns {void}
   */
  reset() {
    _generation++;
    _inFlight.clear();
  },
};

// A project switch replaces the tree every one of these questions was about.
wsService.on('project-changed', () => {
  gitReviewService.reset();
});

// And so does moving to a conversation that works in a different one. The
// manifest a board is holding, and any patch still out against it, describe a
// tree nobody is looking at any more.
onGitWorkspaceChange(() => {
  gitReviewService.reset();
});

export default gitReviewService;
