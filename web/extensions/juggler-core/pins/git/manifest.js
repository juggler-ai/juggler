//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git's files as the review panel takes them. The panel knows nothing about
 * git, so a file's status is worded here, and its path made absolute for Open
 * and Reveal when the working tree still holds it.
 * @module pins/git/manifest
 */

import { markUntranslated, translator } from 'juggler/i18n';
import { createFileActions } from 'juggler/ui';
import { fileCode, fileStatusWords, fileTone } from '../../lib/git-status.js';

const t = translator('@juggler/core');

/**
 * Absolute path of one repository-relative file.
 * @param {string} root - Project root.
 * @param {string} repoPath - Repository path relative to the project.
 * @param {string} filePath - File path relative to the repository.
 * @returns {string} Absolute file path.
 */
function absoluteFilePath(root, repoPath, filePath) {
  return [root.replace(/[/\\]+$/, ''), repoPath, filePath]
    .filter(Boolean)
    .join('/');
}

/**
 * Whether a file is still on disk. A deletion is reviewable from its committed
 * side, but Open and Reveal would be pointing at nothing.
 * @param {import('../../lib/git-client.js').GitFile} file - The file.
 * @returns {boolean} True when the working tree still holds it.
 */
function stillOnDisk(file) {
  return file.index !== 'D' && file.worktree !== 'D';
}

/**
 * The one letter a reviewed file shows, as the Changes list shows its letters:
 * `!` for a conflict, `?` for an untracked file, else what happened to it —
 * the staged side's letter when it has one, since the review compares from
 * HEAD and a file added then edited is still added.
 * @param {import('../../lib/git-client.js').GitFile} file - The file.
 * @returns {string} The letter.
 */
function reviewLetter(file) {
  if (file.conflicted || file.index === 'U' || file.worktree === 'U') return '!';
  if (file.worktree === '?') return '?';
  const side = (/** @type {string} */ letter) => (letter && letter !== '.' && letter !== ' ' ? letter : '');
  return side(file.index) || side(file.worktree) || fileCode(file).trim();
}

/**
 * One file as the panel's rail lists it.
 * @param {string} root - The tree's root.
 * @param {string} repoPath - Its repository, relative to the root.
 * @param {import('../../lib/git-client.js').GitFile} file - The file.
 * @returns {any} The panel's file.
 */
export function reviewFile(root, repoPath, file) {
  const absolute = absoluteFilePath(root, repoPath, file.path);
  const onDisk = stillOnDisk(file);
  return {
    repo: repoPath || '',
    path: file.path,
    oldPath: file.oldPath,
    code: reviewLetter(file),
    tone: file.worktree === '?' ? 'untracked' : fileTone(file),
    status: file.conflicted ? t('Conflicted') : fileStatusWords(file),
    added: file.added,
    removed: file.removed,
    filePath: onDisk ? absolute : undefined,
    actions: onDisk ? () => createFileActions(absolute, { pin: absolute }) : undefined,
  };
}

/**
 * One commit's files as a review of that commit: one unnamed group, in the
 * commit's own scope, so a comment written on it is kept apart from the
 * working tree's. The words a comment stores, which reach the model, stay
 * English.
 * @param {import('../../lib/git-client.js').GitCommit} commit - The commit.
 * @param {string} root - The tree's root.
 * @returns {any} The manifest.
 */
export function commitManifest(commit, root) {
  const sha = commit.sha.slice(0, 7);
  const more = commit.truncated ? commit.total - commit.files.length : 0;
  return {
    scope: t('Changes in {sha}', { sha }),
    commentScope: markUntranslated(`Changes in ${sha}`),
    scopeKey: commit.scope,
    complete: !commit.truncated,
    warnings: [],
    groups: [{
      key: commit.repo || '',
      name: '',
      note: more ? t('{count, plural, one {# more file is not listed.} other {# more files are not listed.}}', { count: more }) : '',
      files: commit.files.map((file) => reviewFile(root, commit.repo, file)),
    }],
  };
}
