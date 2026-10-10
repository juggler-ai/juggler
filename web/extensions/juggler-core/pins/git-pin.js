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
import {
  DEFAULT_SCOPE,
  SCOPE_PRESETS,
  SCOPE_SYNTAX,
  normalizeGitPinParameters,
  normalizeRecent,
  normalizeScope,
  scopeName,
  scopePreset,
} from '../lib/git-scope.js';

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
.git-pin__content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.git-pin__scope-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
  font-size: var(--font-size-sm);
}
.review-panel__scope .git-pin__scope-bar {
  margin-bottom: 0;
  flex: 0 1 auto;
  max-width: 100%;
}
.git-pin__scope-select,
.git-pin__scope-input,
.git-pin__scope-apply {
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 0.125rem 0.375rem;
}
.git-pin__scope-input {
  flex: 1 1 12rem;
  min-width: 8rem;
  font-family: var(--font-mono);
}
.git-pin__scope-apply {
  cursor: pointer;
}
`);

/** What a pin with the default scope compares, said once, at the top, in words. */
const SCOPE_LABEL = 'Working tree against HEAD';

/** The select's value for "type an expression". */
const CUSTOM = 'custom';

/**
 * A short object id, as a person reads one.
 * @param {string|undefined} id - The id.
 * @returns {string} Its first seven characters, or ''.
 */
function shortId(id) {
  return id ? id.slice(0, 7) : '';
}

/**
 * The repository a scope resolved the same way in everywhere — which is the
 * ordinary case, and the only one a single line can say honestly.
 * @param {import('juggler/pinboard-item-type').PinGitReview} review - What the server reported.
 * @returns {import('juggler/pinboard-item-type').PinGitReviewRepo|null} One of
 *   them, or null when they disagree or none resolved anything.
 */
function uniformResolution(review) {
  const repos = (review.repos || []).filter((repo) => repo.base);
  const first = repos[0];
  if (!first) return null;
  const same = repos.every((repo) => repo.base === first.base
    && repo.target === first.target && repo.baseName === first.baseName);
  return same ? first : null;
}

/**
 * The scope line for one review. A workspace's tree is named in it: the pin
 * follows the visible conversation, so the same pin shows the project one moment
 * and a worktree the next, and without the name the two read identically. Any
 * scope but the default is named as it was asked for, with the commits it came
 * to, since `main` today is not `main` yesterday.
 * @param {import('juggler/pinboard-item-type').PinGitReview} review - What the server reported.
 * @param {string} scope - The scope the review was asked for.
 * @returns {string} e.g. 'Working tree of feat/tunnels against HEAD'.
 */
function scopeLabel(review, scope) {
  if (scope === DEFAULT_SCOPE) {
    return review.workspace ? `Working tree of ${review.workspace} against HEAD` : SCOPE_LABEL;
  }
  // The dropdown beside this already names the preset, so the line says only
  // what it came to. A range is followed by its two commits; a comparison with
  // one commit by that commit, in brackets after the name it was asked by.
  const resolved = uniformResolution(review);
  let label = review.scope?.label || scope;
  if (scope === '@branch' && resolved?.baseName) {
    label = `Working tree against the merge-base with ${resolved.baseName}`;
  }
  if (review.workspace) label = `${label} in ${review.workspace}`;
  if (!resolved) return label;
  return resolved.target
    ? `${label} · ${shortId(resolved.base)}..${shortId(resolved.target)}`
    : `${label} (${shortId(resolved.base)})`;
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
 * @param {string} scope - The scope it was asked for.
 * @returns {any} The manifest.
 */
function toManifest(review, scope) {
  const repos = review.repos || [];
  // Only a lone repo at the project root goes unnamed; anything else is one of
  // several, and an unlabelled block would not say which.
  const showNames = !(repos.length === 1 && !repos[0]?.path);
  return {
    scope: scopeLabel(review, scope),
    scopeKey: scope === DEFAULT_SCOPE ? '' : scope,
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
 * Each pin keeps a scope in its config — the working tree against `HEAD` unless
 * it says otherwise, or what is staged, a branch, a commit range — so a board can
 * hold one pin per comparison, and the type is multiple-instance for that reason
 * alone: two pins with the same scope are one pin.
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
    description: "Review the working tree against HEAD, or any other comparison git can make — the project's, or the visible conversation's workspace — and comment on the changes",
    order: 40,
    defaultPin: true,
    instances: 'multiple',
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
   * in the body, which has the service. A scoped pin says its scope, which is
   * what tells two Git tabs apart.
   * @param {Record<string, any>} [config] - The pin's config.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe(config) {
    const scope = normalizeScope(config?.scope);
    return { title: this.name, subtitle: scope === DEFAULT_SCOPE ? 'Review changes' : scopeName(scope) };
  }

  /**
   * The scope, folded, and the expressions this pin remembers. Anything else a
   * config carries — `agentRequested`, say — is kept as it was.
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>} The normalized config.
   */
  normalizeConfig(config) {
    const { scope: _scope, recent: _recent, ...rest } = config && typeof config === 'object' ? config : {};
    const out = { ...rest, ...normalizeGitPinParameters(config || {}) };
    const recent = normalizeRecent(config?.recent);
    if (recent.length) out.recent = recent;
    return out;
  }

  /**
   * Two Git pins are the same pin when they compare the same thing.
   * @param {Record<string, any>} a - One config.
   * @param {Record<string, any>} b - The other.
   * @returns {boolean} True for the same scope.
   */
  isSameConfig(a, b) {
    return normalizeScope(a?.scope) === normalizeScope(b?.scope);
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
   * @returns {Record<string, any>|null} The config: the source's scope, if it named one.
   */
  static configFromSource(source) {
    if (!GitPin.canPinSource(source)) return null;
    return normalizeGitPinParameters(/** @type {any} */ (source));
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'git-pin');
    const content = createElement('div', 'git-pin__content');
    container.replaceChildren(body);

    /** @type {import('juggler/pinboard-item-type').PinGitReview|null} */
    let review = null;
    /** The scope `review` was read in, which every patch of it is read in too. */
    let reviewScope = DEFAULT_SCOPE;
    /** @type {any} */
    let drawn = null;
    let error = '';
    let live = true;
    let generation = 0;
    /** @type {Record<string, any>} The config as this pin last knew it. */
    let config = context.pin?.config || {};
    let scope = normalizeScope(config.scope);
    /**
     * Scope saves still on their way to the board. Until they land, a context
     * update carries the config from before them, and adopting its scope would
     * undo the choice the user just made.
     */
    let saving = 0;

    // Everything the panel is given goes through the context the pin currently
    // holds rather than the one it was built with, so a context update reaches
    // it without the panel being rebuilt around the new services.
    const panel = createReviewPanel({
      scopeLabel: SCOPE_LABEL,
      loadPatch: (file, options) => context.services.git.diff(file.repo, file.path, { ...options, scope: reviewScope }),
      review: {
        draft: () => context.services.review.draft(),
        onChange: (/** @type {() => void} */ listener) => context.services.review.onChange(listener),
        save: (/** @type {any} */ next) => context.services.review.save(next),
        clear: () => context.services.review.clear(),
        compose: () => context.services.review.compose(),
      },
    });

    // The scope control: the presets by name, and Custom… for an expression,
    // which is typed into a field that remembers what this pin was asked before.
    const bar = createElement('div', 'git-pin__scope-bar');
    const select = /** @type {HTMLSelectElement} */ (createElement('select', 'git-pin__scope-select'));
    select.setAttribute('aria-label', 'Compare');
    for (const preset of SCOPE_PRESETS) {
      const option = /** @type {HTMLOptionElement} */ (createElement('option', '', preset.label));
      option.value = preset.id;
      option.title = preset.description;
      select.append(option);
    }
    const customOption = /** @type {HTMLOptionElement} */ (createElement('option', '', 'Custom…'));
    customOption.value = CUSTOM;
    select.append(customOption);
    const listId = `git-pin-scopes-${Math.random().toString(36).slice(2, 8)}`;
    const recentList = createElement('datalist');
    recentList.id = listId;
    const input = /** @type {HTMLInputElement} */ (createElement('input', 'git-pin__scope-input'));
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'main...HEAD';
    input.title = SCOPE_SYNTAX;
    input.setAttribute('aria-label', 'Git diff expression');
    input.setAttribute('list', listId);
    const apply = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__scope-apply', 'Show'));
    apply.type = 'button';
    bar.append(select, input, apply, recentList);

    /** @returns {string[]} The expressions this pin remembers. */
    const recent = () => normalizeRecent(config.recent);

    const syncControls = () => {
      const custom = !scopePreset(scope);
      select.value = custom ? CUSTOM : scope;
      input.hidden = !custom;
      apply.hidden = !custom;
      if (custom) input.value = scope;
      recentList.replaceChildren(...recent().map((entry) => {
        const option = /** @type {HTMLOptionElement} */ (createElement('option'));
        option.value = entry;
        return option;
      }));
    };

    const render = () => {
      // The control is shown with whatever it governs, and with a failure it may
      // have caused — a scope the server refused has to be correctable from where
      // it is reported. It stays out of the way of a first read still under way.
      // With a review on screen the control sits in the panel's scope row,
      // beside the words describing what it chose; without one there is no row,
      // and it sits above the message it may have caused.
      const inPanel = Boolean(review && (review.repos || []).length > 0);
      if (inPanel) {
        body.replaceChildren(content);
        panel.setScopeControl(bar);
      } else {
        panel.setScopeControl(null);
        body.replaceChildren(...(error ? [bar, content] : [content]));
      }

      if (!review) {
        // Nothing read yet is not the same as no repository, and saying the
        // wrong one of those is worse than saying neither.
        const parts = [createElement('div', 'git-pin__quiet', 'Checking…')];
        if (error) {
          const lead = scope === DEFAULT_SCOPE ? "Couldn't read the working tree." : `Couldn't compare ${scopeName(scope)}.`;
          parts.push(createElement('div', 'git-pin__error', `${lead} ${error}`));
        }
        content.replaceChildren(...parts);
        return;
      }

      if ((review.repos || []).length === 0) {
        // Already the whole answer: the tab says what the pin is for, and this
        // says why there is none of it. Centred like every other empty card.
        content.replaceChildren(pinEmpty(review.workspace ? `No git repository in ${review.workspace}.` : 'No git repository.'));
        return;
      }

      if (panel.element.parentNode !== content) content.replaceChildren(panel.element);
      if (drawn !== review) {
        drawn = review;
        panel.setManifest(toManifest(review, reviewScope));
      }
      // A failed refresh keeps the last good review on screen and says so
      // underneath: blanking the panel loses more than the staleness costs.
      panel.setError(error ? `Couldn't refresh. ${error}` : '');
    };

    const refresh = async () => {
      const mine = ++generation;
      const asked = scope;
      try {
        const next = await context.services.git.review({ scope: asked });
        if (!live || mine !== generation) return;
        review = next;
        reviewScope = asked;
        error = '';
      } catch (e) {
        if (!live || mine !== generation) return;
        error = e instanceof Error ? e.message : String(e ?? '');
      }
      render();
    };

    /**
     * Review something else. A different scope is a different review, so what
     * was on screen goes rather than sitting under a control that no longer
     * describes it; the pin's config is what remembers the choice.
     * @param {string} raw - The scope as chosen or typed.
     */
    const choose = (raw) => {
      const next = normalizeScope(raw);
      if (next !== scope) {
        scope = next;
        review = null;
        drawn = null;
        error = '';
        const saved = { ...config };
        delete saved.scope;
        if (next !== DEFAULT_SCOPE) saved.scope = next;
        if (!scopePreset(next)) saved.recent = normalizeRecent([next, ...recent()]);
        config = saved;
        saving++;
        Promise.resolve(context.updateConfig?.(saved)).catch((/** @type {any} */ e) => {
          console.warn('[Git pin] Could not save the scope:', e);
        }).finally(() => { saving--; });
      }
      syncControls();
      render();
      void refresh();
    };

    select.addEventListener('change', () => {
      if (select.value === CUSTOM) {
        input.hidden = false;
        apply.hidden = false;
        input.value = scopePreset(scope) ? '' : scope;
        input.focus();
        return;
      }
      choose(select.value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (input.value.trim()) choose(input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        syncControls();
      }
    });
    apply.addEventListener('click', () => {
      if (input.value.trim()) choose(input.value);
    });

    syncControls();
    render();
    void refresh();

    return {
      update: (next) => {
        context = next;
        if (saving === 0) config = next.pin?.config || config;
        // Another window, or the agent, may have rescoped this pin.
        const configured = normalizeScope(config.scope);
        if (configured !== scope) {
          scope = configured;
          review = null;
          drawn = null;
          error = '';
          syncControls();
          render();
          void refresh();
          return;
        }
        syncControls();
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
