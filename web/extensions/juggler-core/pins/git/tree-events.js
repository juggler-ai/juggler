//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The one way the Git pin hears that a tree has changed.
 *
 * Every place — Changes (and the head drawn from it), Refs, History — and the
 * pin itself is handed the git service this makes, never the host's. Its
 * `watch` is one subscription per tree for the whole pin, fanned out to each
 * listener; its `run` is the host's. And it adds the one piece of news the
 * host's watch does not carry: **a write ending is a change.** When a job of the
 * tree reaches a final state — told by its `git-job` frame, or by its `run`
 * settling, whichever comes first — every listener is handed a `git-change`
 * naming the job's repository in every part. So whatever a write did, every
 * place reads it again at once, without waiting on the server's watcher to see
 * it on disk, and a place need not reread after its own writes.
 *
 * The watcher's own `git-change` for the same write still arrives a moment
 * later; the places' readers coalesce reads already out, so it costs at most
 * one more read.
 * @module pins/git/tree-events
 */

/**
 * @typedef {import('../../lib/git-client.js').GitClient} GitClient
 * @typedef {import('../../lib/git-client.js').GitWatchEvent} GitWatchEvent
 */

/** Every part of a repository a `git-change` can name: what a write may have touched. */
const ALL_KINDS = Object.freeze(['index', 'refs', 'head', 'worktree', 'operation']);

/** States a job does not leave. */
const FINAL = new Set(['done', 'failed', 'cancelled']);

/** How many ended jobs are remembered, so each is told once. */
const REMEMBERED = 256;

/**
 * @param {() => GitClient} host - The host's git service, as it now is.
 * @returns {{git: () => GitClient, stop: () => void}} The service to hand
 *   the places, and the end of every subscription it holds.
 */
export function createTreeEvents(host) {
  /** @type {Map<string, {listeners: Set<(event: GitWatchEvent) => void>, unwatch: (() => void)|undefined}>} By tree ('' for the one in view). */
  const trees = new Map();
  /** @type {Set<string>} Jobs whose end has been told. */
  const ended = new Set();

  /**
   * @param {string} tree - The tree.
   * @param {GitWatchEvent} event - What to tell its listeners.
   */
  const deliver = (tree, event) => {
    const entry = trees.get(tree);
    if (!entry) return;
    for (const listener of [...entry.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[GitPin] A place failed to handle a git event:', err);
      }
    }
  };

  /**
   * A job of the tree has ended: tell every listener its repository changed.
   * @param {string} tree - The tree it ran in, as the pin named it.
   * @param {string} id - The job, '' when there is none to tell apart.
   * @param {string} repo - Its repository.
   */
  const jobEnded = (tree, id, repo) => {
    if (id) {
      if (ended.has(id)) return;
      if (ended.size >= REMEMBERED) ended.clear();
      ended.add(id);
    }
    deliver(tree, /** @type {GitWatchEvent} */ ({ type: 'git-change', workspace: tree, repos: [{ path: repo || '', kinds: [...ALL_KINDS] }] }));
  };

  /** @type {GitClient['watch']} */
  const watch = (listener, options) => {
    const tree = options?.workspace || '';
    let entry = trees.get(tree);
    if (!entry) {
      const made = { listeners: new Set(), unwatch: /** @type {(() => void)|undefined} */ (undefined) };
      entry = made;
      trees.set(tree, made);
      made.unwatch = host().watch?.((event) => {
        deliver(tree, event);
        const job = /** @type {any} */ (event).job;
        if (event.type === /** @type {any} */ ('git-job') && job && FINAL.has(job.state)) jobEnded(tree, job.id || '', job.repo || '');
      }, options);
    }
    const mine = entry;
    mine.listeners.add(listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      mine.listeners.delete(listener);
      if (mine.listeners.size === 0 && trees.get(tree) === mine) {
        trees.delete(tree);
        mine.unwatch?.();
      }
    };
  };

  /** @type {GitClient['run']} */
  const run = (op, options) => {
    const tree = options?.workspace || '';
    const repo = op?.repo || '';
    return host().run(op, options).then((job) => {
      jobEnded(tree, job?.id || '', repo);
      return job;
    }, (/** @type {any} */ e) => {
      jobEnded(tree, e?.job?.id || '', repo);
      throw e;
    });
  };

  /** @type {WeakMap<object, GitClient>} The service made over each host service. */
  const made = new WeakMap();
  return {
    git: () => {
      const underlying = host();
      let service = made.get(underlying);
      if (!service) {
        service = { ...underlying, watch, run };
        made.set(underlying, service);
      }
      return service;
    },
    stop: () => {
      for (const entry of trees.values()) entry.unwatch?.();
      trees.clear();
    },
  };
}
