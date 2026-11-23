//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The head's one adaptive action, chosen by the state of the tree in view, and
 * the words for a network write's progress.
 *
 * In order: a question a network write waits on (sign in, or trust a host)
 * › an operation in progress: its conflicts while
 * any are left, then Continue — it offers no commit, which Continue makes,
 * and nothing that talks to a remote › something staged: Commit ›
 * a branch with no upstream: Publish › ahead and behind: Pull › ahead: Push ›
 * behind: Pull › Fetch, spinning while a fetch runs. A repository with no
 * remote stops at the commit button.
 *
 * A network write the user started does not take the button over: the action
 * stays where it is, spinning and held when it is the write running, and the
 * write rides along as `job`, for the head's Refresh to say how far it has
 * got and to stop it, which moves nothing the user might be about to press.
 *
 * Pure: it is told everything and decides only what the button says and does.
 * @module pins/git/primary
 */

import { markForTranslation, translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/** @typedef {import('../../lib/git-client.js').GitChanges} GitChanges */
/** @typedef {import('../../lib/git-client.js').GitJob} GitJob */

/** The kinds of write that talk to a remote: a submodule update may clone or fetch. */
export const NETWORK_KINDS = new Set(['fetch', 'pull', 'push', 'push-tag', 'push-tags', 'remote-branch-delete', 'submodule-update']);

/**
 * @param {GitJob|null|undefined} job - A job.
 * @returns {boolean} Whether it is a network write still running.
 */
export function isRunningNetworkJob(job) {
  return Boolean(job && job.state === 'running' && NETWORK_KINDS.has(job.kind));
}

/**
 * The phases of git's progress meter the pin says in the user's language. Any
 * other is shown as git said it.
 */
const PHASES = /** @type {Record<string, string>} */ ({
  'Enumerating objects': markForTranslation('Enumerating objects'),
  'Counting objects': markForTranslation('Counting objects'),
  'Compressing objects': markForTranslation('Compressing objects'),
  'Writing objects': markForTranslation('Writing objects'),
  'Receiving objects': markForTranslation('Receiving objects'),
  'Resolving deltas': markForTranslation('Resolving deltas'),
  'Unpacking objects': markForTranslation('Unpacking objects'),
  'Checking connectivity': markForTranslation('Checking connectivity'),
  'Updating files': markForTranslation('Updating files'),
  'Finding sources': markForTranslation('Finding sources'),
});

/**
 * A meter reading in words: the phase, translated when known, and how far.
 * @param {GitJob['progress']} progress - The reading.
 * @returns {string} e.g. 'Receiving objects 45% (450/1000), 2.00 MiB/s'; '' with none.
 */
export function progressText(progress) {
  if (!progress?.phase) return '';
  const known = PHASES[progress.phase];
  const phase = known ? t(known) : progress.phase;
  const said = progress.remote ? t('Remote: {phase}', { phase }) : phase;
  /** @type {string[]} */
  const parts = [];
  if (progress.percent >= 0 && progress.total) {
    parts.push(t('{phase} {percent}% ({done}/{total})', {
      phase: said, percent: progress.percent, done: progress.done, total: progress.total,
    }));
  } else {
    parts.push(t('{phase}: {done}', { phase: said, done: progress.done }));
  }
  if (progress.rate) parts.push(progress.rate);
  return parts.join(', ');
}

/**
 * The command a primary kind is, as a network write's kind; '' when it is none.
 * @param {string} kind - A primary's kind.
 * @returns {string} 'fetch', 'pull', 'push' or ''.
 */
export function commandOf(kind) {
  return kind === 'fetch' || kind === 'pull' || kind === 'push' ? kind : kind === 'publish' ? 'push' : '';
}

/**
 * What a running network write is doing, in a word or two with its percent.
 * @param {GitJob} job - The job.
 * @returns {string} e.g. 'Pushing 45%'.
 */
export function runningLabel(job) {
  const percent = job.progress && job.progress.percent >= 0 ? job.progress.percent : -1;
  // Every tag pushed reads as one tag pushed does.
  const kind = job.kind === 'push-tags' ? 'push-tag' : job.kind;
  if (percent < 0) {
    return t('{kind, select, fetch {Fetching…} pull {Pulling…} push {Pushing…} push-tag {Pushing…} submodule-update {Updating…} other {Deleting…}}', { kind });
  }
  return t('{kind, select, fetch {Fetching {percent}%} pull {Pulling {percent}%} push {Pushing {percent}%} push-tag {Pushing {percent}%} submodule-update {Updating {percent}%} other {Deleting {percent}%}}',
    { kind, percent });
}

/**
 * @typedef {object} PrimaryState
 * @property {GitChanges|null} read - The repository's last changes read.
 * @property {number} changed - Changed files.
 * @property {number} staged - Files with something staged.
 * @property {number} conflicts - Files still in conflict.
 * @property {boolean} committing - A commit is out.
 * @property {GitJob|null} job - A network write of the repository the user
 *   started, while it runs.
 * @property {boolean} fetching - A fetch nobody asked for (on first showing) is running.
 */

/**
 * @typedef {object} Primary
 * @property {'answer'|'resolve'|'continue'|'commit'|'publish'|'pull'|'push'|'fetch'|'none'} kind - What it does:
 *   'answer' asks again the question the running write waits on; 'resolve'
 *   shows the first file in conflict.
 * @property {string} label - Its words.
 * @property {'primary'|'ghost'} tone - How loud it is.
 * @property {boolean} disabled - Whether it can be pressed.
 * @property {boolean} [spin] - Whether it shows a spinner.
 * @property {'up'|'down'|'sync'|'lock'} [icon] - Its glyph.
 * @property {string} [title] - Its tooltip.
 * @property {GitJob} [job] - The network write the user started, while it
 *   runs: the head's Refresh says its progress, and stops it.
 */

/**
 * The head's primary action for this state.
 * @param {PrimaryState} state - The state.
 * @returns {Primary} The action.
 */
export function primaryOf(state) {
  const { read, changed, staged, conflicts, committing, job, fetching } = state;
  if (job && isRunningNetworkJob(job) && job.prompt) {
    return {
      kind: 'answer', label: t('{kind, select, confirm {Confirm…} other {Sign in…}}', { kind: job.prompt.kind }),
      tone: 'primary', disabled: false, icon: 'lock', title: job.prompt.text, job,
    };
  }
  if (job && isRunningNetworkJob(job)) {
    const action = primaryOf({ ...state, job: null });
    if (commandOf(action.kind) !== job.kind) return { ...action, job };
    return { ...action, disabled: true, spin: true, icon: 'sync', title: progressText(job.progress) || runningLabel(job), job };
  }
  if (read?.operation) {
    return conflicts > 0
      ? { kind: 'resolve', label: t('{count, plural, one {# conflict} other {# conflicts}}', { count: conflicts }),
        tone: 'primary', disabled: false, title: t('Show the first file in conflict') }
      : { kind: 'continue', label: t('Continue'), tone: 'primary', disabled: false,
        title: read.stopped?.between
          ? t('{kind, select, cherry-pick {Go on to the rest of the cherry-pick} other {Go on to the rest of the revert}}', { kind: read.operation })
          : t('{kind, select, merge {Commit the merge} rebase {Go on with the rebase} cherry-pick {Commit the cherry-pick} other {Commit the revert}}', { kind: read.operation }) };
  }
  /** @type {Primary} */
  const commitOrNothing = staged > 0
    ? { kind: 'commit', label: t('Commit {count}', { count: staged }), tone: 'primary', disabled: committing }
    : { kind: 'none', label: read && !changed ? t('Clean') : t('Nothing staged'), tone: 'ghost', disabled: true };
  if (!read || staged > 0 || !read.remotes) return commitOrNothing;
  if (read.branch && !read.upstream && !read.detached && !read.initial) {
    return { kind: 'publish', label: t('Publish'), tone: 'primary', disabled: false, icon: 'up',
      title: t('Push {branch} and track it', { branch: read.branch }) };
  }
  if (read.upstream && read.ahead && read.behind) {
    return { kind: 'pull', label: t('Pull'), tone: 'primary', disabled: false, icon: 'down',
      title: t('{branch} and {upstream} have both moved on', { branch: read.branch, upstream: read.upstream }) };
  }
  if (read.upstream && read.ahead) {
    return { kind: 'push', label: t('Push {count}', { count: read.ahead }), tone: 'primary', disabled: false, icon: 'up',
      title: t('Push to {upstream}', { upstream: read.upstream }) };
  }
  if (read.upstream && read.behind) {
    return { kind: 'pull', label: t('Pull {count}', { count: read.behind }), tone: 'primary', disabled: false, icon: 'down',
      title: t('Pull from {upstream}', { upstream: read.upstream }) };
  }
  return { kind: 'fetch', label: t('Fetch'), tone: 'ghost', disabled: fetching, spin: fetching, icon: 'sync',
    title: fetching ? t('Fetching…') : t('Fetch every remote') };
}
