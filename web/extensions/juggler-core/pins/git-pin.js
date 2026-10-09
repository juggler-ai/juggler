//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { createElement, createFileActions, createReviewPanel, injectStylesOnce } from 'juggler/ui';
import { pinEmpty } from '../lib/pin-empty.js';
import {
  branchPhrase,
  divergencePhrase,
  fileCode,
  fileStatusWords,
  fileTone,
  repoLabel,
  truncationNote,
} from '../lib/git-status.js';

injectStylesOnce('git-pin-styles', `
.git-pin {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.git-pin__quiet {
  color: var(--text-tertiary);
}
.git-pin__error {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
`);

/** What this pin compares, said once, at the top, in words. */
const SCOPE_LABEL = 'Working tree against HEAD';

/**
 * The scope line for one review. A workspace's tree is named in it: the pin
 * follows the visible conversation, so the same pin shows the project one moment
 * and a worktree the next, and without the name the two read identically.
 * @param {import('juggler/pinboard-item-type').PinGitReview} review - What the server reported.
 * @returns {string} e.g. 'Working tree of feat/tunnels against HEAD'.
 */
function scopeLabel(review) {
  return review.workspace ? `Working tree of ${review.workspace} against HEAD` : SCOPE_LABEL;
}

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
 * A repository's second line: where its HEAD is and how far that has drifted
 * from what it tracks. The rail has one row per file under it, so this is the
 * only place the repository itself gets to say anything.
 * @param {import('juggler/pinboard-item-type').PinGitReviewRepo} repo - The repository.
 * @returns {string} The phrase, e.g. 'develop · 2 ahead · abcdef1'.
 */
function repoDetail(repo) {
  /** @type {string[]} */
  const parts = [branchPhrase(repo)];
  if (repo.upstream) parts.push(`→ ${repo.upstream}`);
  const divergence = divergencePhrase(repo);
  if (divergence) parts.push(divergence);
  else if (repo.upstream) parts.push('Up to date');
  if (repo.initial) parts.push('No commits yet');
  else if (repo.head) parts.push(repo.head.slice(0, 7));
  if (repo.stashes > 0) parts.push(`${repo.stashes} ${repo.stashes === 1 ? 'stash' : 'stashes'}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * What could not be read here, in git's own words. Listing a repository with its
 * complaint is the whole point of listing it: dropping it would turn "I could
 * not read this" into "there is nothing here".
 * @param {import('juggler/pinboard-item-type').PinGitReviewRepo} repo - The repository.
 * @returns {string} The note, or '' when there is nothing to say.
 */
function repoNote(repo) {
  return [repo.error || '', truncationNote(repo)].filter(Boolean).join(' ');
}

/**
 * Whether a file is still on disk. A deletion is reviewable from its committed
 * side, but Open and Reveal would be pointing at nothing.
 * @param {import('juggler/pinboard-item-type').PinGitFile} file - The file.
 * @returns {boolean} True when the working tree still holds it.
 */
function stillOnDisk(file) {
  return file.index !== 'D' && file.worktree !== 'D';
}

/**
 * The review manifest as the panel takes it: groups and files, already worded.
 * The panel knows nothing about git, so everything git-shaped is said here.
 * @param {import('juggler/pinboard-item-type').PinGitReview} review - What the server reported.
 * @returns {any} The manifest.
 */
function toManifest(review) {
  const repos = review.repos || [];
  // Only a lone repo at the project root goes unnamed; anything else is one of
  // several, and an unlabelled block would not say which.
  const showNames = !(repos.length === 1 && !repos[0]?.path);
  return {
    scope: scopeLabel(review),
    complete: review.complete === true,
    warnings: review.warnings || [],
    groups: repos.map((repo) => ({
      key: repo.path || '',
      name: showNames ? repoLabel(review.root, repo.path) : '',
      detail: repoDetail(repo),
      note: repoNote(repo),
      files: (repo.files || []).map((file) => {
        const absolute = absoluteFilePath(review.root, repo.path, file.path);
        const onDisk = stillOnDisk(file);
        return {
          repo: repo.path || '',
          path: file.path,
          oldPath: file.oldPath,
          code: fileCode(file),
          tone: fileTone(file),
          status: file.conflicted ? 'Conflicted' : fileStatusWords(file),
          added: file.added,
          removed: file.removed,
          filePath: onDisk ? absolute : undefined,
          actions: onDisk ? () => createFileActions(absolute, { pin: absolute }) : undefined,
        };
      }),
    })),
  };
}

/**
 * GitPin — the project's working tree, in the space to review it in.
 *
 * The info card beside it answers "is there anything uncommitted"; this answers
 * "what, exactly, and what is wrong with it". The complete tree against `HEAD`,
 * a file at a time, with comments written onto the lines they are about and sent
 * to the conversation as one ordinary message.
 *
 * Git is the authority here, and nothing is attributed to anyone. A transcript
 * cannot establish what changed — shell commands, formatters, generators and
 * hand edits all miss it — so the question this answers is the one git can
 * answer: what am I currently going to commit?
 *
 * The manifest is a deliberate read, not a poll: the file watcher never reports
 * anything under `.git`, so `Refresh` is how the user asks again. Only the file
 * being read is fetched as a patch, because a dirty tree of four hundred files
 * is not four hundred diffs.
 * @class
 * @augments PinboardItemType
 */
class GitPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'git',
    name: 'Git',
    version: '1.0.0',
    description: "Review the working tree against HEAD — the project's, or the visible conversation's workspace — and comment on the changes",
    order: 40,
    defaultPin: true,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a project whose tree to read.
   */
  canAdd(active) {
    return active?.project?.path ? true : 'No project';
  }

  /**
   * The title and what the pin is for. `describe` is called during layout and
   * may not do work, so it cannot read the tree — the branch and the counts are
   * in the body, which has the service.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe() {
    return { title: this.name, subtitle: 'Review changes' };
  }

  /**
   * The Git status info card offers to open this, and asks the registry rather
   * than naming this class.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What the user asked to pin.
   * @returns {boolean} True for the git working tree.
   */
  static canPinSource(source) {
    return source?.kind === 'git';
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - What the user asked to pin.
   * @returns {Record<string, any>|null} The config, which for a singleton is empty.
   */
  static configFromSource(source) {
    return GitPin.canPinSource(source) ? {} : null;
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'git-pin');
    container.replaceChildren(body);

    /** @type {import('juggler/pinboard-item-type').PinGitReview|null} */
    let review = null;
    /** @type {any} */
    let drawn = null;
    let error = '';
    let live = true;
    let generation = 0;

    // Everything the panel is given goes through the context the pin currently
    // holds rather than the one it was built with, so a context update reaches
    // it without the panel being rebuilt around the new services.
    const panel = createReviewPanel({
      scopeLabel: SCOPE_LABEL,
      loadPatch: (file, options) => context.services.git.diff(file.repo, file.path, options),
      review: {
        draft: () => context.services.review.draft(),
        onChange: (/** @type {() => void} */ listener) => context.services.review.onChange(listener),
        save: (/** @type {any} */ next) => context.services.review.save(next),
        clear: () => context.services.review.clear(),
        compose: () => context.services.review.compose(),
      },
    });

    const render = () => {
      if (!review) {
        // Nothing read yet is not the same as no repository, and saying the
        // wrong one of those is worse than saying neither.
        const parts = [createElement('div', 'git-pin__quiet', 'Checking…')];
        if (error) {
          parts.push(createElement('div', 'git-pin__error', `Couldn't read the working tree. ${error}`));
        }
        body.replaceChildren(...parts);
        return;
      }

      if ((review.repos || []).length === 0) {
        // Already the whole answer: the tab says what the pin is for, and this
        // says why there is none of it. Centred like every other empty card.
        body.replaceChildren(pinEmpty(review.workspace ? `No git repository in ${review.workspace}.` : 'No git repository.'));
        return;
      }

      if (panel.element.parentNode !== body) body.replaceChildren(panel.element);
      if (drawn !== review) {
        drawn = review;
        panel.setManifest(toManifest(review));
      }
      // A failed refresh keeps the last good review on screen and says so
      // underneath: blanking the panel loses more than the staleness costs.
      panel.setError(error ? `Couldn't refresh. ${error}` : '');
    };

    const refresh = async () => {
      const mine = ++generation;
      try {
        const next = await context.services.git.review();
        if (!live || mine !== generation) return;
        review = next;
        error = '';
      } catch (e) {
        if (!live || mine !== generation) return;
        error = e instanceof Error ? e.message : String(e ?? '');
      }
      render();
    };

    render();
    void refresh();

    return {
      update: (next) => {
        context = next;
        render();
      },
      focus: () => panel.focus(),
      teardown: () => {
        live = false;
        panel.destroy();
      },
      getActions: () => [
        {
          id: 'refresh',
          label: 'Refresh',
          icon: 'refresh',
          primary: true,
          run: () => refresh(),
        },
      ],
    };
  }
}

export default GitPin;
