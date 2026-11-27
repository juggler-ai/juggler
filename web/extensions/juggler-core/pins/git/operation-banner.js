//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's Operation place: a banner under the head line, above every
 * place, while a merge, rebase, cherry-pick or revert is in progress in the
 * tree in view — what it is, how far it has got, how many files are still in
 * conflict, and whether the tree's changes are set aside until it ends — with
 * Continue, Skip (not for a merge, which has no commit to skip) and Abort.
 * While files are still in conflict, Continue is disabled and says so beside it.
 *
 * It is also the one place that says there are conflicts, for as long as there
 * are any — a toast saying it would hang over these buttons — so it shows for
 * files left in conflict with no operation in progress too (a stash that didn't
 * apply cleanly), offering Show them, which the head's primary offers during an
 * operation. Either way, beside the count, Resolve with an agent opens a new
 * conversation asked to resolve them.
 *
 * A pick or revert of several commits stopped between them — the commit it
 * stopped on committed by hand, the rest still waiting — is applying nothing,
 * yet git refuses to switch branch until it ends. It says so, and offers
 * Continue, for the rest, and Quit, which forgets them and changes nothing;
 * there is no commit to skip, and Abort would rewind to before the first.
 *
 * It draws what it is told and reports the buttons through `handlers`; the pin
 * runs the writes, and asks before an abort.
 * @module pins/git/operation-banner
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';

const t = translator('@juggler/core');

/** @typedef {import('../../lib/git-client.js').GitStopped} GitStopped */

/**
 * @typedef {object} BannerState
 * @property {GitStopped|null} stopped - The operation in progress; null for none.
 * @property {number} conflicts - Files still in conflict.
 * @property {string} head - HEAD's sha, named when the branch is detached.
 * @property {boolean} busy - One of its writes is out.
 */

/**
 * @typedef {object} BannerHandlers
 * @property {(anchor: HTMLElement) => void} continue - Continue.
 * @property {(anchor: HTMLElement) => void} skip - Skip.
 * @property {(anchor: HTMLElement) => void} abort - Abort.
 * @property {(anchor: HTMLElement) => void} quit - Quit: forget a pick or revert stopped between commits.
 * @property {(anchor: HTMLElement) => void} resolve - Open a new conversation asked to resolve the conflicts.
 * @property {(anchor: HTMLElement) => void} show - Show the first file in conflict.
 */

/**
 * @typedef {object} OperationBanner
 * @property {HTMLElement} element - The banner; hidden while nothing is in progress.
 * @property {BannerHandlers} handlers - What the buttons do; set by the pin.
 * @property {(state: BannerState) => void} update - Draw this.
 */

/**
 * @param {string} sha - A commit.
 * @returns {string} Its short form.
 */
const short = (sha) => (sha || '').slice(0, 7);

/**
 * The branch an operation changes, by name, or HEAD's sha when it is detached.
 * @param {GitStopped} stopped - The operation.
 * @param {string} head - HEAD's sha.
 * @returns {string} Its name.
 */
export function branchOf(stopped, head) {
  return stopped.branch || short(head);
}

/**
 * What the banner says, a part at a time: what is in progress, how far a rebase
 * has got, the conflicts left, and the changes set aside.
 * @param {GitStopped} stopped - The operation.
 * @param {number} conflicts - Files still in conflict.
 * @param {string} head - HEAD's sha.
 * @returns {string[]} The parts.
 */
function bannerParts(stopped, conflicts, head) {
  if (stopped.between) {
    const parts = [t('{kind, select, cherry-pick {A cherry-pick stopped between commits} other {A revert stopped between commits}}', { kind: stopped.kind })];
    if (stopped.left) parts.push(t('{count, plural, one {# more commit to go} other {# more commits to go}}', { count: stopped.left }));
    if (stopped.setAside) parts.push(t('your changes are set aside until it finishes'));
    return parts;
  }
  const parts = [t('{kind, select, rebase {Rebasing {branch} onto {other}} merge {Merging {other} into {branch}} cherry-pick {Cherry-picking {sha} “{subject}”} other {Reverting {sha} “{subject}”}}', {
    kind: stopped.kind,
    branch: branchOf(stopped, head),
    other: stopped.other || short(stopped.otherSha || ''),
    sha: short(stopped.commit?.sha || ''),
    subject: stopped.commit?.subject || '',
  })];
  if (stopped.kind === 'rebase' && stopped.steps) parts.push(t('commit {step} of {steps}', { step: stopped.step || 0, steps: stopped.steps }));
  if (conflicts) parts.push(t('{count, plural, one {# conflict} other {# conflicts}}', { count: conflicts }));
  if (stopped.setAside) parts.push(t('your changes are set aside until it finishes'));
  return parts;
}

/**
 * @returns {OperationBanner} A hidden banner.
 */
export function createOperationBanner() {
  const element = createElement('div', 'git-op');
  element.hidden = true;
  element.setAttribute('role', 'status');
  const text = createElement('span', 'git-op__text');
  /**
   * @param {string} cls - Its class.
   * @param {string} label - Its words.
   * @returns {HTMLButtonElement} A button.
   */
  const button = (cls, label) => {
    const b = /** @type {HTMLButtonElement} */ (createElement('button', `${cls} btn btn-xs`, label));
    b.type = 'button';
    return b;
  };
  const continueButton = button('git-op__continue btn-primary', t('Continue'));
  // Why Continue can't be pressed yet, said beside it rather than in a tooltip
  // nobody hovers a disabled button for.
  const hint = createElement('span', 'git-op__hint');
  const hintId = `git-op-hint-${Math.random().toString(36).slice(2, 8)}`;
  hint.id = hintId;
  hint.hidden = true;
  const skipButton = button('git-op__skip btn-neutral', t('Skip'));
  const abortButton = button('git-op__abort btn-danger-quiet', t('Abort'));
  const quitButton = button('git-op__quit btn-neutral', t('Quit'));
  quitButton.title = t('Forget the rest, and leave everything as it is');
  // What to do about the conflicts sits with the count, apart from what to do
  // about the operation.
  const showButton = button('git-op__show btn-neutral', t('Show them'));
  const resolveButton = button('git-op__resolve btn-neutral', t('Resolve with an agent'));
  resolveButton.title = t('Start a new conversation that resolves the conflicts');
  const fixes = createElement('span', 'git-op__fixes');
  fixes.append(showButton, resolveButton);
  const buttons = createElement('span', 'git-op__buttons');
  buttons.append(hint, continueButton, skipButton, quitButton, abortButton);
  element.append(text, fixes, buttons);

  /** @type {BannerHandlers} */
  const handlers = { continue: () => {}, skip: () => {}, abort: () => {}, quit: () => {}, resolve: () => {}, show: () => {} };
  continueButton.addEventListener('click', () => handlers.continue(continueButton));
  skipButton.addEventListener('click', () => handlers.skip(skipButton));
  abortButton.addEventListener('click', () => handlers.abort(abortButton));
  quitButton.addEventListener('click', () => handlers.quit(quitButton));
  showButton.addEventListener('click', () => handlers.show(showButton));
  resolveButton.addEventListener('click', () => handlers.resolve(resolveButton));

  return {
    element,
    handlers,
    update: ({ stopped, conflicts, head, busy }) => {
      element.hidden = !stopped && conflicts === 0;
      fixes.hidden = conflicts === 0;
      resolveButton.disabled = busy;
      if (!stopped) {
        if (!conflicts) return;
        // Files left in conflict with nothing in progress: nothing to continue
        // or abort, and no primary that shows them.
        delete element.dataset.kind;
        text.textContent = t('{count, plural, one {# file is in conflict} other {# files are in conflict}}', { count: conflicts });
        showButton.hidden = false;
        buttons.hidden = true;
        return;
      }
      showButton.hidden = true;
      buttons.hidden = false;
      element.dataset.kind = stopped.kind;
      text.textContent = bannerParts(stopped, conflicts, head).join(' · ');
      continueButton.disabled = busy || conflicts > 0;
      hint.textContent = conflicts > 0 ? t('Resolve the conflicts first') : '';
      hint.hidden = conflicts === 0;
      if (conflicts > 0) continueButton.setAttribute('aria-describedby', hintId);
      else continueButton.removeAttribute('aria-describedby');
      const between = Boolean(stopped.between);
      skipButton.hidden = stopped.kind === 'merge' || between;
      skipButton.disabled = busy;
      abortButton.hidden = between;
      abortButton.disabled = busy;
      quitButton.hidden = !between;
      quitButton.disabled = busy;
    },
  };
}
