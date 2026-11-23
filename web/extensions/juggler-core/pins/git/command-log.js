//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The command log: the exact git each action in the pin ran, newest last, with
 * what a failed one printed. Closed it is one line — the last command, marked
 * ✗ when it failed — and a click opens it; it starts from the tree's `jobs()` and is kept current by the
 * `git-job` events the pin hears. A network write shows its meter's last phase.
 * The jobs are the whole tree's, whichever repository the pin is showing, so
 * each command is prompted with the name of the repository it ran in.
 * @module pins/git/command-log
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';
import { progressText } from './primary.js';

const t = translator('@juggler/core');

/** How many jobs the log keeps. */
const KEEP = 100;

/**
 * @typedef {import('../../lib/git-client.js').GitJob} GitJob
 * @typedef {object} CommandLogOptions
 * @property {(repo: string) => string} repoName - A repository's name, by its
 *   path in the tree ('' for its root).
 * @typedef {object} CommandLog
 * @property {HTMLElement} element - The strip, to be placed in the pin.
 * @property {(jobs: GitJob[]) => void} setJobs - Start from these, newest first.
 * @property {(job: GitJob) => void} upsert - A job started or moved.
 * @property {() => void} toggle - Open or close it.
 * @property {() => void} reveal - Open it, with the newest failed command in view.
 * @property {() => boolean} isOpen - Whether it is open.
 */

/**
 * The state of a job in a word.
 * @param {string} state - The job's state.
 * @returns {string} Its word.
 */
function stateWord(state) {
  return t('{state, select, running {running} done {done} failed {failed} cancelled {cancelled} other {{state}}}', { state });
}

/**
 * @param {CommandLogOptions} options - How to name a job's repository.
 * @returns {CommandLog} A closed, empty log.
 */
export function createCommandLog({ repoName }) {
  const element = createElement('div', 'git-pin__log');
  const toggleButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__log-toggle text-truncate'));
  toggleButton.type = 'button';
  toggleButton.setAttribute('aria-expanded', 'false');
  const list = createElement('div', 'git-pin__log-list');
  list.hidden = true;
  element.append(toggleButton, list);

  /** @type {GitJob[]} Oldest first. */
  let jobs = [];

  /**
   * @param {GitJob} job - A job.
   * @returns {string[]} Its commands as typed, each at its repository's prompt.
   */
  const commandLines = (job) => {
    const prompt = `${repoName(job.repo || '')} $`;
    const commands = (job.commands || []).map((argv) => `${prompt} git ${argv.join(' ')}`);
    return commands.length ? commands : [`${prompt} ${job.kind}`];
  };

  const render = () => {
    const open = toggleButton.getAttribute('aria-expanded') === 'true';
    const last = jobs.at(-1);
    // Closed, the line says whether the last command failed: a ✗ before it.
    const lastFailed = last?.state === 'failed';
    toggleButton.replaceChildren(
      ...(lastFailed ? [createElement('span', 'git-pin__log-failed', '✗')] : []),
      document.createTextNode(last
        ? commandLines(last).at(-1) || ''
        : t('The git commands this pin runs appear here')),
    );
    if (lastFailed) toggleButton.dataset.state = 'failed';
    else delete toggleButton.dataset.state;
    toggleButton.title = open ? t('Hide the command log')
      : lastFailed ? t('The last git command failed. Show every git command this pin ran')
        : t('Show every git command this pin ran');
    list.hidden = !open;
    if (!open) return;
    list.replaceChildren(...jobs.map((job) => {
      const entry = createElement('div', 'git-pin__log-entry');
      entry.dataset.state = job.state;
      entry.dataset.job = job.id;
      entry.append(createElement('div', 'git-pin__log-cmd', commandLines(job).join('\n')));
      entry.append(createElement('div', 'git-pin__log-state', stateWord(job.state)));
      const progress = progressText(job.progress);
      if (progress) entry.append(createElement('div', 'git-pin__log-progress', progress));
      if (job.state === 'failed' && (job.output || job.error)) {
        entry.append(createElement('pre', 'git-pin__log-output', [job.output, job.error].filter(Boolean).join('\n')));
      }
      return entry;
    }));
  };

  toggleButton.addEventListener('click', () => api.toggle());

  const api = {
    element,
    setJobs: (/** @type {GitJob[]} */ newestFirst) => {
      jobs = [...newestFirst].reverse().slice(-KEEP);
      render();
    },
    upsert: (/** @type {GitJob} */ job) => {
      const at = jobs.findIndex((j) => j.id === job.id);
      if (at >= 0) jobs[at] = job;
      else jobs.push(job);
      if (jobs.length > KEEP) jobs = jobs.slice(-KEEP);
      render();
    },
    toggle: () => {
      toggleButton.setAttribute('aria-expanded', String(toggleButton.getAttribute('aria-expanded') !== 'true'));
      render();
    },
    reveal: () => {
      toggleButton.setAttribute('aria-expanded', 'true');
      render();
      const failed = [...list.querySelectorAll('.git-pin__log-entry[data-state="failed"]')].at(-1)
        || list.lastElementChild;
      failed?.scrollIntoView({ block: 'nearest' });
    },
    isOpen: () => toggleButton.getAttribute('aria-expanded') === 'true',
  };
  render();
  return api;
}
