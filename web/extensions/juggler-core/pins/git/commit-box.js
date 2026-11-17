//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The commit box: one auto-growing textarea holding git's own shape of a
 * message (summary, blank line, body), the summary's length once it is long,
 * Amend, "Commit all changes" when nothing is staged, and a button that says
 * what it will do. It draws and reports; committing is its host's.
 *
 * While a commit runs the button spins and what the hooks print streams into a
 * small output area under it; a failure leaves the message exactly as typed
 * and the output on screen.
 *
 * Auto-generate, beside Commit, asks its host for a message (the host opens
 * the menu of sources); while one is being written it is Stop. The line under
 * the field says where the message came from, how the writing is going, or why
 * it failed; clicking it asks again, and typing clears it.
 *
 * While a merge, rebase, cherry-pick or revert is in progress the box stands
 * aside, saying so: the banner's Continue makes that commit, with the message
 * git prepared for it.
 * @module pins/git/commit-box
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';
import { summaryOf } from '../../lib/commit-message.js';
import { icon } from './icons.js';

const t = translator('@juggler/core');

/** The summary length past which the count is shown. */
const SUMMARY_SHOWN = 50;
/** The summary length past which the count is a warning. */
const SUMMARY_LIMIT = 72;

/**
 * What the box needs to know about the repository to draw itself.
 * @typedef {object} CommitBoxState
 * @property {string} branch - The branch, '' when detached.
 * @property {boolean} detached - Whether HEAD is detached.
 * @property {number} staged - Files staged.
 * @property {number} tracked - Tracked files with unstaged changes, for "Commit all".
 * @property {string} headMessage - The last commit's message, '' before the first.
 * @property {string} operation - The operation in progress, '' for none.
 */

/**
 * @typedef {object} CommitRequest
 * @property {string} message - The message as typed.
 * @property {boolean} amend - Whether to amend the last commit.
 * @property {boolean} all - Whether to commit every tracked change.
 */

/**
 * @typedef {object} CommitBox
 * @property {HTMLElement} element - The box.
 * @property {(state: CommitBoxState) => void} setState - Redraw for the repository as it now is.
 * @property {() => CommitRequest} request - What a commit now would send.
 * @property {(message: string) => void} setMessage - Replace the message (a draft coming back).
 * @property {(running: boolean) => void} setRunning - A commit started or ended.
 * @property {(output: string) => void} setOutput - What the hooks printed, '' to hide it.
 * @property {() => void} committed - The commit went through: clear the message and Amend.
 * @property {() => void} focus - Put the caret in the message.
 * @property {() => boolean} isExpanded - Whether the message has the whole list pane.
 * @property {() => boolean} canGenerate - Whether Auto-generate is enabled.
 * @property {HTMLButtonElement} generateButton - Auto-generate, to anchor its menu on.
 * @property {(generating: boolean) => void} setGenerating - A message started or stopped being written.
 * @property {(text: string, kind?: 'source'|'progress'|'error') => void} setSourceLine -
 *   Say where the message came from, how it is going or why it failed; '' hides it.
 * @property {(message: string) => void} replaceMessage - Put a message in as if typed.
 */

/**
 * @param {object} host - What the box reports to.
 * @param {() => void} host.onCommit - The user asked to commit.
 * @param {(message: string) => void} host.onInput - The message changed.
 * @param {(expanded: boolean) => void} host.onExpand - The expand button was pressed.
 * @param {(anchor: HTMLElement) => void} host.onGenerate - Auto-generate, or the line under the field, was pressed.
 * @param {() => void} host.onStopGenerating - Stop was pressed.
 * @returns {CommitBox} The box.
 */
export function createCommitBox(host) {
  const element = createElement('div', 'git-commit');
  const filesButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-commit__files btn btn-xs btn-neutral'));
  filesButton.type = 'button';
  filesButton.hidden = true;

  const wrap = createElement('div', 'git-commit__wrap');
  const field = /** @type {HTMLTextAreaElement} */ (createElement('textarea', 'git-commit__msg field-input field-input-sm'));
  field.rows = 1;
  field.spellcheck = true;
  field.setAttribute('aria-label', t('Commit message'));
  const expandButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-commit__expand btn btn-icon btn-xs'));
  expandButton.type = 'button';
  const length = createElement('span', 'git-commit__len');
  wrap.append(field, expandButton, length);

  const row = createElement('div', 'git-commit__row');
  const amendLabel = createElement('label', 'git-commit__option');
  const amend = /** @type {HTMLInputElement} */ (createElement('input', 'git-commit__amend'));
  amend.type = 'checkbox';
  amendLabel.title = t('Replace the last commit with this one');
  amendLabel.append(amend,
    createElement('span', 'git-commit__amend-long', t('Amend last commit')),
    createElement('span', 'git-commit__amend-short', t('Amend')));
  const allLabel = createElement('label', 'git-commit__option git-commit__all-wrap');
  const all = /** @type {HTMLInputElement} */ (createElement('input', 'git-commit__all'));
  all.type = 'checkbox';
  allLabel.title = t('Nothing is staged: commit every change to a tracked file');
  allLabel.append(all, createElement('span', '', t('Commit all changes')));
  const go = /** @type {HTMLButtonElement} */ (createElement('button', 'git-commit__go btn btn-sm btn-primary'));
  go.type = 'button';
  go.title = t('Commit (⌘↵)');
  const gen = /** @type {HTMLButtonElement} */ (createElement('button', 'git-commit__gen btn btn-sm'));
  gen.type = 'button';
  gen.setAttribute('aria-haspopup', 'menu');
  row.append(amendLabel, allLabel, gen, go);
  const sourceLine = /** @type {HTMLButtonElement} */ (createElement('button', 'git-commit__source'));
  sourceLine.type = 'button';
  sourceLine.hidden = true;

  const output = createElement('pre', 'git-commit__output');
  output.hidden = true;
  const operationLine = createElement('div', 'git-commit__op');
  operationLine.hidden = true;
  element.append(filesButton, operationLine, wrap, sourceLine, row, output);

  /** @type {CommitBoxState} */
  let state = { branch: '', detached: false, staged: 0, tracked: 0, headMessage: '', operation: '' };
  let running = false;
  let expanded = false;
  let generating = false;
  /** What was typed before Amend filled the box, or null when it filled nothing. */
  /** @type {string|null} */
  let beforeAmend = null;

  /** Grow the field to its content; the stylesheet caps how far. */
  const fit = () => {
    if (expanded || !field.value) {
      field.style.height = '';
      return;
    }
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + 2}px`;
  };

  const drawLength = () => {
    const n = summaryOf(field.value).length;
    length.textContent = n > SUMMARY_SHOWN ? `${n}/${SUMMARY_LIMIT}` : '';
    if (n > SUMMARY_LIMIT) length.dataset.over = 'true';
    else delete length.dataset.over;
  };

  const draw = () => {
    field.placeholder = state.detached
      ? t('Detached HEAD: make a branch first')
      : t('Message for {branch}: summary first, then the body', { branch: state.branch });
    amend.disabled = running || !state.headMessage && !amend.checked;
    allLabel.hidden = state.staged > 0 || amend.checked;
    if (allLabel.hidden) all.checked = false;
    const count = all.checked ? state.tracked : state.staged;
    let label;
    let can;
    if (amend.checked) {
      label = t('Amend last commit');
      can = true;
    } else if (count > 0) {
      label = t('Commit {count, plural, one {# file} other {# files}}', { count });
      can = true;
    } else {
      label = t('Nothing staged');
      can = false;
    }
    const standAside = Boolean(state.operation);
    operationLine.hidden = !standAside;
    operationLine.textContent = standAside
      ? t('{kind, select, merge {Continue, above, finishes the merge with git’s message.} rebase {Continue, above, goes on with the rebase.} cherry-pick {Continue, above, finishes the cherry-pick with git’s message.} other {Continue, above, finishes the revert with git’s message.}}', { kind: state.operation })
      : '';
    field.disabled = standAside;
    if (standAside) amend.disabled = true;
    go.disabled = running || state.detached || standAside || !can;
    go.replaceChildren(...(running ? [createElement('span', 'git-pin__spin', '◌')] : []), document.createTextNode(label));
    go.setAttribute('aria-busy', String(running));
    const canGenerate = !standAside && (state.staged > 0 || amend.checked);
    gen.disabled = !generating && (running || !canGenerate);
    gen.dataset.running = String(generating);
    gen.replaceChildren(document.createTextNode(generating ? t('Stop') : t('Auto-generate ▾')));
    gen.title = generating ? t('Stop generating')
      : canGenerate ? t('Generate the message: choose from what (g)')
        : t('Stage something first: the message describes what is staged');
    filesButton.hidden = !expanded;
    filesButton.textContent = t('{count, plural, one {# staged file} other {# staged files}} ▴', { count: state.staged });
    expandButton.replaceChildren(icon(expanded ? 'shrink' : 'expand'));
    expandButton.title = expanded ? t('Shrink the message') : t('Expand the message to the whole pane');
    expandButton.setAttribute('aria-label', expandButton.title);
    expandButton.setAttribute('aria-pressed', String(expanded));
    drawLength();
  };

  field.addEventListener('input', () => {
    if (!generating) sourceLine.hidden = true;
    fit();
    drawLength();
    host.onInput(field.value);
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      host.onCommit();
    }
  });
  amend.addEventListener('change', () => {
    if (amend.checked) {
      if (!field.value && state.headMessage) {
        beforeAmend = field.value;
        field.value = state.headMessage;
      }
    } else if (beforeAmend !== null) {
      field.value = beforeAmend;
      beforeAmend = null;
    }
    host.onInput(field.value);
    fit();
    draw();
  });
  all.addEventListener('change', draw);
  go.addEventListener('click', () => host.onCommit());
  gen.addEventListener('click', () => {
    if (generating) host.onStopGenerating();
    else host.onGenerate(gen);
  });
  sourceLine.addEventListener('click', () => {
    if (!generating && !gen.disabled) host.onGenerate(gen);
  });
  const setExpanded = (/** @type {boolean} */ next) => {
    expanded = next;
    host.onExpand(expanded);
    fit();
    draw();
    if (expanded) field.focus();
  };
  expandButton.addEventListener('click', () => setExpanded(!expanded));
  filesButton.addEventListener('click', () => setExpanded(false));

  draw();

  return {
    element,
    setState: (next) => {
      state = next;
      draw();
    },
    request: () => ({ message: field.value, amend: amend.checked, all: all.checked && !allLabel.hidden }),
    setMessage: (message) => {
      field.value = message;
      fit();
      drawLength();
    },
    setRunning: (next) => {
      running = next;
      field.readOnly = next;
      if (next) {
        output.textContent = '';
        output.hidden = true;
      }
      draw();
    },
    setOutput: (text) => {
      output.textContent = text;
      output.hidden = !text;
    },
    committed: () => {
      field.value = '';
      amend.checked = false;
      all.checked = false;
      beforeAmend = null;
      sourceLine.hidden = true;
      fit();
      draw();
    },
    focus: () => field.focus(),
    isExpanded: () => expanded,
    canGenerate: () => !gen.disabled && !generating,
    generateButton: gen,
    setGenerating: (next) => {
      generating = next;
      field.readOnly = next || running;
      draw();
    },
    setSourceLine: (text, kind = 'source') => {
      sourceLine.textContent = text;
      sourceLine.dataset.kind = kind;
      sourceLine.hidden = !text;
    },
    replaceMessage: (message) => {
      field.value = message;
      fit();
      drawLength();
      host.onInput(field.value);
    },
  };
}
