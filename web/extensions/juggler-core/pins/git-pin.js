//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { translator, formatNumber, markForTranslation, markUntranslated, serverText } from 'juggler/i18n';
import { createElement, createReviewPanel, errorText, injectStylesOnce } from 'juggler/ui';
import { pinEmpty } from '../lib/pin-empty.js';
import {
  branchPhrase,
  divergencePhrase,
  repoLabel,
  truncationNote,
} from '../lib/git-status.js';
import {
  DEFAULT_SCOPE,
  SCOPE_PRESETS,
  SCOPE_SYNTAX,
  TURN_SCOPE,
  normalizeGitPinParameters,
  isPinned,
  pinnedWorkspace,
  treeKeyOf,
  normalizeRecent,
  normalizeScope,
  scopeName,
  scopePreset,
  turnConversation,
} from '../lib/git-scope.js';
import { createActions } from './git/actions.js';
import { createChangesPlace } from './git/changes-place.js';
import { createCommandLog } from './git/command-log.js';
import { createHead } from './git/head.js';
import { createHistoryPlace } from './git/history-place.js';
import { createMenuSelect } from './git/menu-select.js';
import { measureMode } from './git/layout.js';
import { reviewFile } from './git/manifest.js';
import { branchOf, createOperationBanner } from './git/operation-banner.js';
import { askText, chooseAction, closePopover, confirmAction } from './git/popover.js';
import { NETWORK_KINDS, isRunningNetworkJob, primaryOf } from './git/primary.js';
import { createRefsPlace } from './git/refs-place.js';
import { applySplits, createSplitHandle, normalizeSplits } from './git/splitter.js';
import { createToast } from './git/toast.js';
import { injectGitClientStyles } from './git/styles.js';

const t = translator('@juggler/core');

injectStylesOnce('git-pin-styles', `
.git-pin__place--review {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--pane-inset) var(--pane-inset) 0;
}

.git-pin__place--review[hidden] {
  display: none;
}

.git-pin__quiet {
  color: var(--text-tertiary);
}

.git-pin__error {
  color: var(--text-tertiary);
  font-size: var(--font-size-meta);
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
  gap: var(--toolbar-gap);
  margin-bottom: var(--stack-gap);
  font-size: var(--font-size-meta);
}

.review-panel__scope .git-pin__scope-bar {
  margin-bottom: 0;
  flex: 0 1 auto;
  max-width: 100%;
}

/* The select and the input are .field-input .field-input-xs. */
.git-pin__scope-input {
  flex: 1 1 12rem;
  min-width: 8rem;
  font-family: var(--font-mono);
}

`);

/** What a pin with the default scope compares, said once, at the top, in words (English source text). */
const SCOPE_LABEL = markForTranslation('Working tree against HEAD');

/**
 * How a scope line is worded: `t` for the line on screen, {@link english} for
 * the words a comment stores.
 * @typedef {(source: string, params?: Record<string, unknown>) => string} Wording
 */

/**
 * A message in its English source, its `{params}` filled in. A comment stores
 * the scope line it was written under, and the review message hands it to the
 * model (`Comparing {scopeLabel}:`), so those words stay English whatever the
 * UI's language. The scope messages hold plain placeholders only.
 * @type {Wording}
 */
function english(source, params) {
  return markUntranslated(source.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? '')));
}

/** The places, in the switcher's order, with their names (English source text). */
const PLACES = /** @type {const} */ ([
  { id: 'changes', label: markForTranslation('Changes') },
  { id: 'history', label: markForTranslation('History') },
  { id: 'review', label: markForTranslation('Review') },
  { id: 'refs', label: markForTranslation('Refs') },
]);

/** @typedef {'changes'|'history'|'review'|'refs'} PlaceId */

/** @type {ReadonlySet<string>} The places a full-width pin shows the Refs list beside, as a sidebar. */
const BESIDE_SIDEBAR = new Set(['changes', 'history']);

/**
 * What the pin asks of each place.
 * @typedef {object} PinPlace
 * @property {HTMLElement} element - The place; its `data-level`, if any, says
 *   which pane a stack shows.
 * @property {() => void} shown - It was brought forward.
 * @property {() => void} refresh - Read again.
 * @property {() => void} setTree - The pin names another tree.
 * @property {(event: KeyboardEvent) => boolean} handleKey - A key outside a text field; true when used.
 * @property {() => void} focus - Focus it.
 * @property {() => void} teardown - Stop.
 */

/**
 * @param {unknown} value - A config's `place`.
 * @returns {value is PlaceId} Whether it names a place.
 */
function isPlace(value) {
  return PLACES.some((p) => p.id === value);
}

/**
 * The place a config asks for: Review for a pin scoped to something other than
 * the working tree (how the agent opens it on a commit or a range), else the
 * place last chosen, else Changes.
 * @param {Record<string, unknown>} config - The pin's config.
 * @returns {PlaceId} The place.
 */
function placeOf(config) {
  if (normalizeScope(config?.scope) !== DEFAULT_SCOPE) return 'review';
  return isPlace(config?.place) ? config.place : 'changes';
}

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
 * @param {Wording} say - `t` for the screen, {@link english} for a comment.
 * @returns {string} e.g. 'Working tree of feat/tunnels against HEAD'.
 */
function scopeLabel(review, scope, say) {
  if (scope === DEFAULT_SCOPE) {
    return review.workspace
      ? say(markForTranslation('Working tree of {workspace} against HEAD'), { workspace: review.workspace })
      : say(SCOPE_LABEL);
  }
  // The dropdown beside this already names the preset, so the line says only
  // what it came to. A range is followed by its two commits; a comparison with
  // one commit by that commit, in brackets after the name it was asked by.
  const resolved = uniformResolution(review);
  // The server's label is its English, and its message the same words for the
  // screen; a comment keeps the English. A range has no message: its label is
  // git's notation, shown as the server gave it.
  const named = review.scope?.label || scope;
  let label = say === english ? named : serverText(review.scope?.labelMessage, named);
  if (scope === '@branch' && resolved?.baseName) {
    label = say(markForTranslation('Working tree against the merge-base with {base}'), { base: resolved.baseName });
  }
  if (review.workspace) label = say(markForTranslation('{label} in {workspace}'), { label, workspace: review.workspace });
  if (!resolved) return label;
  return resolved.target
    ? say(markForTranslation('{label} · {base}..{target}'),
      { label, base: shortId(resolved.base), target: shortId(resolved.target) })
    : say(markForTranslation('{label} ({base})'), { label, base: shortId(resolved.base) });
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
  else if (repo.upstream) parts.push(t('Up to date'));
  if (repo.initial) parts.push(t('No commits yet'));
  else if (repo.head) parts.push(repo.head.slice(0, 7));
  if (repo.stashes > 0) {
    parts.push(t('{count, plural, one {{count} stash} other {{count} stashes}}', { count: repo.stashes }));
  }
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
    scope: scopeLabel(review, scope, t),
    commentScope: scopeLabel(review, scope, english),
    scopeKey: scope === DEFAULT_SCOPE ? '' : scope,
    complete: review.complete === true,
    warnings: review.warnings || [],
    warningMessages: review.warningMessages,
    groups: repos.map((repo) => ({
      key: repo.path || '',
      name: showNames ? repoLabel(review.root, repo.path) : '',
      detail: repoDetail(repo),
      note: repoNote(repo),
      files: (repo.files || []).map((file) => reviewFile(review.root, repo.path, file)),
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
    // Kept mounted across tab switches: the History session, the selections,
    // the open diff and every scroller's position are a reader's place that
    // config cannot rebuild, and the tree's watch keeps the pin current while
    // it is out of sight.
    retain: true,
    // The head line names the repository and branch and carries Refresh: a
    // board toolbar above it would be a second header saying less.
    toolbar: false,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a project whose tree to read.
   */
  canAdd(active) {
    return active?.project?.path ? true : t('No project');
  }

  /**
   * The title and what the pin is for. `describe` is called during layout and
   * may not do work, so it cannot read the tree — the branch and the counts are
   * in the body, which has the service. A scoped pin says its scope, which is
   * what tells two Git tabs apart. The title is the manifest name, which the
   * host translates in this extension's catalogue.
   * @param {Record<string, unknown>} [config] - The pin's config.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe(config) {
    const scope = normalizeScope(config?.scope);
    return { title: this.name, subtitle: scope === DEFAULT_SCOPE ? t('Review changes') : scopeName(scope) };
  }

  /**
   * The scope, folded, and the expressions this pin remembers. Anything else a
   * config carries — `agentRequested`, say — is kept as it was.
   * @param {Record<string, unknown>} config - The stored or supplied config.
   * @returns {Record<string, unknown>} The normalized config.
   */
  normalizeConfig(config) {
    const { scope: _scope, recent: _recent, place, repo, workspace: _workspace, follow: _follow, conv: _conv, splits, ...rest } = config && typeof config === 'object' ? config : {};
    const out = { ...rest, ...normalizeGitPinParameters(config || {}) };
    if (isPlace(place)) out.place = place;
    const moved = normalizeSplits(splits);
    if (Object.keys(moved).length) out.splits = moved;
    if (typeof repo === 'string' && repo) out.repo = repo;
    const recent = normalizeRecent(config?.recent);
    if (recent.length) out.recent = recent;
    return out;
  }

  /**
   * Two Git pins are the same pin when they compare the same thing.
   * @param {Record<string, unknown>} a - One config.
   * @param {Record<string, unknown>} b - The other.
   * @returns {boolean} True for the same scope of the same tree (and, for
   *   `@turn`, of the same conversation).
   */
  isSameConfig(a, b) {
    return normalizeScope(a?.scope) === normalizeScope(b?.scope) && treeKeyOf(a) === treeKeyOf(b)
      && turnConversation(a) === turnConversation(b);
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
   * @returns {Record<string, unknown>|null} The config: the source's scope, if it named one.
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
    injectGitClientStyles();
    const root = createElement('div', 'git-pin');
    root.tabIndex = 0;
    const body = createElement('div', 'git-pin__place git-pin__place--review');
    const content = createElement('div', 'git-pin__content');
    container.replaceChildren(root);

    /** @type {import('juggler/pinboard-item-type').PinGitReview|null} */
    let review = null;
    /** The scope `review` was read in, which every patch of it is read in too. */
    let reviewScope = DEFAULT_SCOPE;
    /** @type {any} */
    let drawn = null;
    let error = '';
    let live = true;
    let generation = 0;
    /** @type {Record<string, unknown>} The config as this pin last knew it. */
    let config = context.pin?.config || {};
    let scope = normalizeScope(config.scope);
    /**
     * The tree this pin is fixed to, as an option for the reads, or nothing for
     * a pin that follows the visible conversation.
     * @returns {{workspace?: string}} The option.
     */
    const workspaceOption = () => {
      return isPinned(config) ? { workspace: pinnedWorkspace(config) } : {};
    };
    /**
     * The conversation whose turn `@turn` compares: the one the pin was opened
     * for, else the visible one, '' with neither.
     * @returns {string} The conversation id.
     */
    const turnConv = () => turnConversation(config) || context.active?.conversation?.id || '';
    /** The conversation `review` was read for, '' unless it was read in `@turn`. */
    let reviewConv = '';
    /** The conversation the latest review was asked for, read or not. */
    let askedConv = '';
    // Every config this pin writes — its scope, its tree, its place — is one it
    // has already put on screen, so each is written in place: a write the board
    // took for a change made elsewhere would mount the pin afresh, losing the
    // repository picked, the selection and the History session.
    /**
     * Scope saves still on their way to the board. Until they land, a context
     * update carries the config from before them, and adopting its scope would
     * undo the choice the user just made.
     */
    let saving = 0;
    /**
     * Write a config this pin is already showing.
     * @param {Record<string, unknown>} saved - The config.
     * @param {string} what - What was chosen, for the warning if it can't be saved.
     */
    const writeInPlace = (saved, what) => {
      config = saved;
      saving++;
      Promise.resolve(context.updateConfig?.(saved, { inPlace: true })).catch((/** @type {any} */ e) => {
        console.warn(`[Git pin] Could not save the ${what}:`, e);
      }).finally(() => { saving--; });
    };

    // Everything a panel is given goes through the context the pin currently
    // holds rather than the one it was built with, so a context update reaches
    // it without the panel being rebuilt around the new services. Review's
    // panel and History's write their comments to the same draft.
    const reviewService = {
      draft: () => context.services.review.draft(),
      onChange: (/** @type {() => void} */ listener) => context.services.review.onChange(listener),
      save: (/** @type {any} */ next) => context.services.review.save(next),
      clear: () => context.services.review.clear(),
      compose: () => context.services.review.compose(),
    };
    const panel = createReviewPanel({
      scopeLabel: t(SCOPE_LABEL),
      loadPatch: (file, options) => context.services.git.diff(file.repo, file.path,
        { ...options, scope: reviewScope, ...(reviewConv ? { conv: reviewConv } : {}), ...workspaceOption() }),
      review: reviewService,
    });

    // The scope control: the presets by name, and Custom… for an expression,
    // which is typed into a field that remembers what this pin was asked before.
    const bar = createElement('div', 'git-pin__scope-bar');
    const select = createMenuSelect({
      className: 'git-pin__scope-select',
      label: t('Compare'),
      onChoose: (value) => {
        if (value === CUSTOM) {
          input.hidden = false;
          apply.hidden = false;
          input.value = scopePreset(scope) ? '' : scope;
          input.focus();
          return;
        }
        choose(value);
      },
    });
    const listId = `git-pin-scopes-${Math.random().toString(36).slice(2, 8)}`;
    const recentList = createElement('datalist');
    recentList.id = listId;
    const input = /** @type {HTMLInputElement} */ (createElement('input', 'git-pin__scope-input field-input field-input-xs'));
    input.type = 'text';
    input.spellcheck = false;
    // i18n-ignore: a git expression, shown as typed
    input.placeholder = 'main...HEAD';
    input.title = t(SCOPE_SYNTAX);
    input.setAttribute('aria-label', t('Git diff expression'));
    input.setAttribute('list', listId);
    const apply = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__scope-apply btn btn-xs btn-neutral', t('Show')));
    apply.type = 'button';
    bar.append(select.element, input, apply, recentList);

    /** @returns {string[]} The expressions this pin remembers. */
    const recent = () => normalizeRecent(config.recent);

    const syncControls = () => {
      // @turn compares a conversation's turn, so it is offered only when there is
      // one, and kept while the pin shows it so the control still names it.
      const offerTurn = Boolean(turnConv()) || scope === TURN_SCOPE;
      const custom = !scopePreset(scope);
      select.set([
        ...SCOPE_PRESETS.filter((preset) => offerTurn || preset.id !== TURN_SCOPE)
          .map((preset) => ({ value: preset.id, label: t(preset.label), title: t(preset.description) })),
        { value: CUSTOM, label: t('Custom…') },
      ], custom ? CUSTOM : scope);
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
        const parts = [createElement('div', 'git-pin__quiet', t('Checking…'))];
        if (error) {
          parts.push(createElement('div', 'git-pin__error', scope === DEFAULT_SCOPE
            ? t("Couldn't read the working tree. {error}", { error })
            : t("Couldn't compare {scope}. {error}", { scope: scopeName(scope), error })));
        }
        content.replaceChildren(...parts);
        return;
      }

      if ((review.repos || []).length === 0) {
        // Already the whole answer: the tab says what the pin is for, and this
        // says why there is none of it. Centred like every other empty card.
        content.replaceChildren(pinEmpty(review.workspace
          ? t('No git repository in {workspace}.', { workspace: review.workspace })
          : t('No git repository.')));
        return;
      }

      if (panel.element.parentNode !== content) content.replaceChildren(panel.element);
      if (drawn !== review) {
        drawn = review;
        panel.setManifest(toManifest(review, reviewScope));
      }
      // A failed refresh keeps the last good review on screen and says so
      // underneath: blanking the panel loses more than the staleness costs.
      panel.setError(error ? t("Couldn't refresh. {error}", { error }) : '');
    };

    const refresh = async () => {
      const mine = ++generation;
      const asked = scope;
      const conv = asked === TURN_SCOPE ? turnConv() : '';
      askedConv = conv;
      try {
        const next = await context.services.git.review({ scope: asked, ...(conv ? { conv } : {}), ...workspaceOption() });
        if (!live || mine !== generation) return;
        review = next;
        reviewScope = asked;
        reviewConv = conv;
        error = '';
      } catch (e) {
        if (!live || mine !== generation) return;
        error = e instanceof Error ? errorText(e) : String(e ?? '');
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
        // A turn chosen here is the visible conversation's, whichever that is.
        delete saved.conv;
        if (next !== DEFAULT_SCOPE) saved.scope = next;
        if (!scopePreset(next)) saved.recent = normalizeRecent([next, ...recent()]);
        writeInPlace(saved, 'scope');
      }
      syncControls();
      render();
      void refresh();
    };

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

    // --- the places -----------------------------------------------------
    // Review is read the first time it is shown: a pin opened in Changes does
    // not read the whole tree for a review nobody has looked at.
    let reviewRead = false;
    /** @type {import('juggler/pinboard-item-type').PinGitReview|null} The pinned tree's last repository list. */
    let pinnedReview = null;
    const toast = createToast();
    const log = createCommandLog();
    /** @returns {import('juggler/pinboard-item-type').PinGitStatus|null} The visible tree's status. */
    const status = () => {
      try {
        return context.services.git.status();
      } catch (_) {
        return null;
      }
    };
    const treeRoot = () => (isPinned(config) ? (pinnedReview?.root || review?.root) : status()?.root)
      || context.active?.project?.path || '';
    /** @returns {string} The tree's identity: the pinned workspace, or the one in view. */
    const treeKey = () => (isPinned(config) ? pinnedWorkspace(config) : status()?.workspace || '');
    const head = createHead();
    const banner = createOperationBanner();
    /** Whether one of the banner's writes is out. */
    let operationBusy = false;
    /** @type {Record<PlaceId, PinPlace>|null} Set once every place is built. */
    let places = null;
    /** Copy the shown place's level onto the root, where the stack layout reads it. */
    const syncLevel = () => {
      if (places) root.dataset.level = places[place].element.dataset.level || 'list';
    };
    /**
     * A read failed. When the pin is fixed to a tree and the server refused
     * the read, that tree has gone: follow the conversation's workspace again.
     * @param {any} e - The failure.
     * @returns {boolean} True when it was that, and is handled.
     */
    const treeGone = (e) => {
      if (!live || !isPinned(config) || e?.status !== 400) return false;
      setWorkspace(null);
      toast.show(t('That worktree is gone — following the conversation’s workspace again'));
      return true;
    };
    // --- the head: its primary action and the network writes -------------
    /** @type {import('./git/changes-place.js').ChangesState|null} What Changes last said of the repository in view. */
    let shownRepo = null;
    /** @type {Map<string, import('juggler/pinboard-item-type').PinGitJob>} The tree's running network writes, by id. */
    const netJobs = new Map();
    /** @type {{kind: string, repo: string}|null} A network write this pin asked for, until it ends. */
    let starting = null;
    /** @type {Map<string, {fetching: boolean, offline: string}>} The fetch on first showing, by tree and repository. */
    const firstFetches = new Map();
    /** @type {import('./git/primary.js').Primary|null} What the primary button does now. */
    let current = null;
    /** The last question this pin opened by itself, by id: each opens once, unasked. */
    let promptOpened = '';
    /** @type {HTMLElement|null} The open question's popover, while it is open. */
    let promptSurface = null;
    /** @type {Set<string>} Jobs whose question was declined here: their failure needs no toast. */
    const declinedHere = new Set();

    /**
     * @param {string} repo - A repository of the tree in view.
     * @returns {string} Its key among `firstFetches`.
     */
    const fetchKey = (repo) => `${treeKey()}\u0000${repo}`;

    /**
     * The network write the user started in a repository, while it runs.
     * @param {string} repo - The repository.
     * @returns {import('juggler/pinboard-item-type').PinGitJob|null} The newest, or null.
     */
    const runningJobOf = (repo) => {
      const mine = [...netJobs.values()].filter((j) => !j.auto && (j.repo || '') === repo);
      if (mine.length) return mine[mine.length - 1] || null;
      if (starting?.repo !== repo) return null;
      return /** @type {any} */ ({
        id: '', workspace: '', repo, kind: starting.kind, commands: [], state: 'running', output: '', errorKind: '', result: {},
      });
    };

    const renderHead = () => {
      if (!shownRepo) return;
      const { repo, repoName, read, changed, staged, conflicts, committing } = shownRepo;
      const first = firstFetches.get(fetchKey(repo));
      const fetching = Boolean(first?.fetching) || [...netJobs.values()].some((j) => j.auto && (j.repo || '') === repo);
      current = primaryOf({ read, changed, staged, conflicts, committing, job: runningJobOf(repo), fetching });
      head.update({ repoName, read, changed, primary: current, fetching, offline: first?.offline || '' });
      banner.update({ stopped: stoppedOf(read), conflicts, head: read?.head?.sha || '', busy: operationBusy });
      const prompt = current.kind === 'answer' ? current.job?.prompt : null;
      if (promptSurface && (!promptSurface.isConnected || promptSurface.dataset.prompt !== prompt?.id)) {
        // Answered — here or in another window — or no longer asked.
        if (promptSurface.isConnected) closePopover();
        promptSurface = null;
      }
      if (prompt && current.job && prompt.id !== promptOpened) {
        promptOpened = prompt.id;
        askPrompt(current.job);
      }
    };

    /**
     * Ask the question a network write is waiting on, on a popover off the
     * primary: a username in the open, a password masked, a host key as a yes
     * or no. Its Cancel declines; Escape or a click elsewhere only closes it,
     * and the primary asks it again. The answer goes to the server and is kept
     * nowhere here.
     * @param {import('juggler/pinboard-item-type').PinGitJob} job - The job asking.
     */
    const askPrompt = (job) => {
      const prompt = job.prompt;
      if (!prompt) return;
      /** @param {{answer?: string, decline?: boolean}} reply - The answer, or a decline. */
      const reply = (reply) => {
        if (reply.decline) declinedHere.add(job.id);
        context.services.git.answer?.(job.id, { prompt: prompt.id, ...reply }, workspaceOption())
          .catch((/** @type {any} */ e) => {
            // Answered first from somewhere else: nothing to say.
            if (e?.status !== 409) toast.error(errorText(e));
          });
      };
      promptSurface = prompt.kind === 'confirm'
        ? confirmAction(head.primaryButton, root, {
          text: prompt.text, title: t('Git asks'), ok: t('Yes'), cancel: t('No'), tone: 'primary',
          onConfirm: () => reply({ answer: 'yes' }),
          onCancel: () => reply({ decline: true }),
        })
        : askText(head.primaryButton, root, {
          label: prompt.text, ok: t('Send'), secret: prompt.kind !== 'text', allowEmpty: true,
          onSubmit: (value) => reply({ answer: value }),
          onCancel: () => reply({ decline: true }),
        });
      promptSurface.classList.add('git-pop--prompt');
      promptSurface.dataset.prompt = prompt.id;
    };

    /**
     * The first time this pin shows a repository with a remote, ask for the
     * fetch made on first showing — the server makes it once per repository,
     * whichever pin or tree asks. It is quiet: a failure is the head's offline
     * mark, never a toast.
     * @param {import('./git/changes-place.js').ChangesState} state - What is shown.
     */
    const fetchOnFirstShow = (state) => {
      if (!state.read?.remotes) return;
      const key = fetchKey(state.repo);
      if (firstFetches.has(key)) return;
      const entry = { fetching: true, offline: '' };
      firstFetches.set(key, entry);
      const asked = context.services.git.fetchOnShow?.({ repo: state.repo, ...workspaceOption() });
      if (!asked) {
        entry.fetching = false;
        return;
      }
      asked.then(() => {
        entry.fetching = false;
      }, (/** @type {any} */ e) => {
        entry.fetching = false;
        if (e?.job?.state !== 'cancelled') entry.offline = errorText(e);
      }).finally(() => { if (live) renderHead(); });
    };

    /**
     * Run a network write from the head, and offer what to do instead when it
     * can't go ahead.
     * @param {import('juggler/pinboard-item-type').PinGitOp} op - The write.
     */
    const runNetwork = async (op) => {
      starting = { kind: op.kind, repo: op.repo };
      renderHead();
      let id = '';
      try {
        const job = await context.services.git.run(op, workspaceOption());
        id = job?.id || '';
        if (op.kind === 'fetch') {
          const first = firstFetches.get(fetchKey(op.repo));
          if (first) first.offline = '';
        }
      } catch (/** @type {any} */ e) {
        id = e?.job?.id || '';
        if (live) networkFailed(op, e);
      } finally {
        starting = null;
        if (id) netJobs.delete(id);
        if (live) renderHead();
      }
    };

    /**
     * Fetch at once; ask before a push or pull, which change what others see
     * or the checked-out branch and offer no Undo, saying what moves where.
     * @param {'fetch'|'pull'|'push'} kind - Which.
     * @param {Element} anchor - What asked.
     */
    const askNetwork = (kind, anchor) => {
      const repo = shownRepo?.repo || '';
      if (kind === 'fetch') {
        void runNetwork({ kind, repo });
        return;
      }
      const read = shownRepo?.read;
      const branch = read?.branch || 'HEAD';
      const upstream = read?.upstream || '';
      const text = kind === 'push'
        ? (!upstream ? t('Publish {branch} to the remote, and track it there?', { branch })
          : read?.ahead ? t('Push {count, plural, one {# commit} other {# commits}} from {branch} to {upstream}?', { count: read.ahead, branch, upstream })
            : t('Push {branch} to {upstream}?', { branch, upstream }))
        : (read?.behind && upstream ? t('Pull {count, plural, one {# commit} other {# commits}} from {upstream} into {branch}?', { count: read.behind, branch, upstream })
          : upstream ? t('Pull {upstream} into {branch}?', { branch, upstream }) : t('Pull into {branch}?', { branch }));
      confirmAction(anchor, root, {
        text,
        ok: kind === 'push' ? (upstream ? t('Push') : t('Publish')) : t('Pull'),
        tone: 'primary',
        onConfirm: () => { void runNetwork({ kind, repo }); },
      });
    };

    /**
     * What a network write that failed offers instead, on a popover hung off the
     * primary button; anything else is a toast.
     * @param {import('juggler/pinboard-item-type').PinGitOp} op - The write.
     * @param {any} e - Its failure.
     */
    const networkFailed = (op, e) => {
      const job = e?.job;
      if (job?.state === 'cancelled') return;
      const anchor = head.primaryButton;
      const upstream = shownRepo?.read?.upstream || '';
      switch (e?.kind) {
        case 'diverged': {
          const ways = [
            { id: 'rebase', label: t('Rebase onto {upstream}', { upstream }) },
            { id: 'merge', label: t('Merge {upstream}', { upstream }) },
          ];
          if (job?.prefer !== 'rebase') ways.reverse();
          chooseAction(anchor, root, {
            title: errorText(e),
            choices: ways,
            onChoose: (mode) => { void runNetwork({ ...op, mode: /** @type {'merge'|'rebase'} */ (mode) }); },
          });
          return;
        }
        case 'dirty':
          chooseAction(anchor, root, {
            title: errorText(e),
            choices: [{ id: 'stash', label: t('Stash them first, then go on') }],
            onChoose: () => { void runNetwork({ ...op, dirty: 'stash' }); },
          });
          return;
        case 'rejected':
          chooseAction(anchor, root, {
            title: errorText(e),
            choices: [{ id: 'pull', label: t('Pull') }, { id: 'force', label: t('Force push with lease…') }],
            onChoose: (choice) => {
              if (choice === 'pull') void runNetwork({ kind: 'pull', repo: op.repo });
              else void forcePush(op);
            },
          });
          return;
        case 'remote':
          chooseAction(anchor, root, {
            title: errorText(e),
            choices: (job?.remotes || []).map((/** @type {string} */ r) => ({ id: r, label: r })),
            onChoose: (remote) => { void runNetwork({ ...op, remote }); },
          });
          return;
        case 'conflicts':
          toast.error(errorText(e));
          showPlace('changes', true);
          return;
        case 'auth':
          // Declined here: the user knows why it stopped.
          if (job && declinedHere.delete(job.id)) return;
          toast.error(errorText(e));
          return;
        default:
          toast.error(errorText(e));
      }
    };

    /**
     * Push over what the remote has, after saying what is replaced — and only
     * over that: the push is leased on the sha the remote was last seen at, so
     * one that has moved since is refused rather than overwritten.
     * @param {import('juggler/pinboard-item-type').PinGitOp} op - The push turned down.
     */
    const forcePush = async (op) => {
      const read = shownRepo?.read;
      const upstream = read?.upstream || '';
      let sha = '';
      try {
        const refsRead = /** @type {import('juggler/pinboard-item-type').PinGitRefs} */ (
          await context.services.git.read('refs', { repo: op.repo, ...workspaceOption() }));
        for (const remote of refsRead.remotes || []) {
          if (!upstream.startsWith(`${remote.name}/`)) continue;
          const branch = upstream.slice(remote.name.length + 1);
          sha = remote.branches.find((b) => b.name === branch)?.sha || sha;
        }
      } catch (/** @type {any} */ e) {
        toast.error(errorText(e));
        return;
      }
      if (!live) return;
      if (!sha) {
        toast.show(t("{upstream} hasn't been fetched: fetch it and look before forcing over it.", { upstream }));
        return;
      }
      confirmAction(head.primaryButton, root, {
        text: t('Replace {upstream} (at {sha}) with {branch}? Commits only {upstream} has are lost from it. If it has moved since, the push is refused.',
          { upstream, sha: sha.slice(0, 7), branch: read?.branch || '' }),
        ok: t('Force push'),
        onConfirm: () => { void runNetwork({ kind: 'push', repo: op.repo, force: true, expectSha: sha }); },
      });
    };

    // --- the operation in progress: the banner's writes --------------------
    /**
     * @param {import('juggler/pinboard-item-type').PinGitChanges|null|undefined} read - A changes read.
     * @returns {import('juggler/pinboard-item-type').PinGitStopped|null} The operation in progress in it.
     */
    const stoppedOf = (read) => read?.stopped || (read?.operation
      ? { kind: /** @type {import('juggler/pinboard-item-type').PinGitStopped['kind']} */ (read.operation) } : null);
    const showConflicts = () => {
      showPlace('changes', true);
      changes.showFirstConflict();
    };
    const operationActions = createActions({
      git: () => context.services.git,
      repo: () => shownRepo?.repo || '',
      workspaceOption,
      toast,
      element: root,
      live: () => live,
      reread: () => changes.refresh(),
      dirty: () => changes.dirtyCount() || 0,
      trees: () => [],
      viewTree: () => {},
      showChanges: showConflicts,
    });

    /**
     * Continue, skip, abort or quit the operation the banner shows, naming it
     * as it was seen; say so once it has ended.
     * @param {'continue'|'skip'|'abort'|'quit'} verb - Which.
     */
    const runOperation = async (verb) => {
      const stopped = stoppedOf(shownRepo?.read);
      if (!stopped || operationBusy) return;
      operationBusy = true;
      renderHead();
      const job = await operationActions.run({ kind: `operation-${verb}`, operation: stopped.kind });
      operationBusy = false;
      if (!live) return;
      renderHead();
      if (!job) return;
      if (verb === 'quit') {
        toast.show(t('{kind, select, cherry-pick {Cherry-pick forgotten — nothing else changed} other {Revert forgotten — nothing else changed}}', { kind: stopped.kind }));
        return;
      }
      toast.show(verb === 'abort'
        ? t('{kind, select, merge {Merge aborted — back where you started} rebase {Rebase aborted — back where you started} cherry-pick {Cherry-pick aborted — back where you started} other {Revert aborted — back where you started}}', { kind: stopped.kind })
        : t('{kind, select, merge {Merge finished} rebase {Rebase finished} cherry-pick {Cherry-pick finished} other {Revert finished}}', { kind: stopped.kind }));
    };

    banner.handlers.continue = () => { void runOperation('continue'); };
    // Quitting changes nothing in the tree, so it does not ask.
    banner.handlers.quit = () => { void runOperation('quit'); };
    // Skipping drops the commit the operation stopped on, so it asks too.
    banner.handlers.skip = (anchor) => {
      const stopped = stoppedOf(shownRepo?.read);
      if (!stopped) return;
      const sha = (stopped.commit?.sha || '').slice(0, 7);
      confirmAction(anchor || head.primaryButton, root, {
        text: sha
          ? t('Skip {sha}? Its change is left out, and the {kind, select, rebase {rebase} cherry-pick {cherry-pick} other {revert}} goes on with the next commit.', { sha, kind: stopped.kind })
          : t('Skip this commit? Its change is left out, and the {kind, select, rebase {rebase} cherry-pick {cherry-pick} other {revert}} goes on with the next commit.', { kind: stopped.kind }),
        title: t('Skip commit'),
        ok: t('Skip'),
        onConfirm: () => { void runOperation('skip'); },
      });
    };
    // The one step of an operation nothing undoes, so it asks.
    banner.handlers.abort = (anchor) => {
      const read = shownRepo?.read;
      const stopped = stoppedOf(read);
      if (!stopped) return;
      confirmAction(anchor, root, {
        text: t('{kind, select, rebase {Abort the rebase? Resolutions so far are lost; {branch} goes back to {sha}.} merge {Abort the merge? Resolutions so far are lost; {branch} goes back to {sha}.} cherry-pick {Abort the cherry-pick? Resolutions so far are lost; {branch} goes back to {sha}.} other {Abort the revert? Resolutions so far are lost; {branch} goes back to {sha}.}}', {
          kind: stopped.kind,
          branch: branchOf(stopped, read?.head?.sha || ''),
          sha: (stopped.from || read?.head?.sha || '').slice(0, 7),
        }),
        ok: t('Abort'),
        onConfirm: () => { void runOperation('abort'); },
      });
    };

    head.handlers.primary = () => {
      const repo = shownRepo?.repo || '';
      switch (current?.kind) {
        case 'answer': if (current.job) askPrompt(current.job); break;
        case 'resolve': showConflicts(); break;
        case 'continue': void runOperation('continue'); break;
        case 'commit': changes.commit(head.primaryButton); break;
        case 'publish': case 'push': askNetwork('push', head.primaryButton); break;
        case 'pull': askNetwork('pull', head.primaryButton); break;
        case 'fetch': void runNetwork({ kind: 'fetch', repo }); break;
        default: break;
      }
    };
    head.handlers.cancel = () => {
      const id = current?.job?.id;
      if (id) void context.services.git.cancel(id, workspaceOption()).catch((/** @type {any} */ e) => toast.error(errorText(e)));
    };

    const changes = createChangesPlace({
      git: () => context.services.git,
      workspaceOption,
      treeKey,
      root: treeRoot,
      pinId: context.pin?.id || '',
      rootElement: root,
      head,
      workspaces: () => context.services.workspaces,
      conversationId: () => context.active?.conversation?.id || '',
      treeGone: (e) => treeGone(e),
      toast,
      log,
      showChanges: () => showPlace('changes', true),
      showHistory: (target) => {
        showPlace('history', true);
        void history.reveal(target);
      },
      showFileHistory: (path) => {
        showPlace('history', true);
        history.showPath(path);
      },
      levelChanged: () => syncLevel(),
      initialRepo: typeof config.repo === 'string' ? config.repo : '',
      repoChanged: (repo) => {
        refs.setTree();
        history.setTree();
        if ((config.repo || '') !== repo) {
          const saved = { ...config };
          delete saved.repo;
          if (repo) saved.repo = repo;
          writeInPlace(saved, 'repository');
        }
      },
      stateChanged: (state) => {
        shownRepo = state;
        fetchOnFirstShow(state);
        renderHead();
        // The first state is told while the places are still being built.
        if (places) {
          drawCounts();
          history.dirtyChanged();
        }
      },
      jobChanged: (job) => {
        if (!NETWORK_KINDS.has(job.kind)) return;
        if (isRunningNetworkJob(job)) netJobs.set(job.id, job);
        else netJobs.delete(job.id);
        renderHead();
      },
      jobsLoaded: (jobs) => {
        netJobs.clear();
        for (const job of jobs) if (isRunningNetworkJob(job)) netJobs.set(job.id, job);
        renderHead();
      },
    });
    changes.element.classList.add('git-pin__place', 'git-pin__place--changes');

    /**
     * Fix the pin to a tree by hand, or (with null) follow the conversation's
     * workspace again, and read the tree it now names.
     * @param {string|null} id - The tree's id ('' for the project's), or null to follow.
     * @param {string} [repo] - The repository to open at, by its path in that
     *   tree; another tree otherwise opens at its root repository.
     */
    const setWorkspace = (id, repo = '') => {
      const saved = { ...config };
      delete saved.workspace;
      delete saved.follow;
      delete saved.repo;
      if (id !== null) Object.assign(saved, { workspace: id, follow: false });
      if (repo) saved.repo = repo;
      if (treeKeyOf(saved) === treeKeyOf(config)) return;
      writeInPlace(saved, 'tree');
      moveTree();
    };

    /**
     * Show a tree the worktree read listed, at the repository it names there.
     * The tree in view already is: picking it changes nothing, rather than
     * fixing the pin to where it already looks.
     * @param {import('./git/refs-model.js').TreeView} view - The tree.
     */
    const viewTree = (view) => {
      if (view.tree.current || typeof view.viewId !== 'string') return;
      setWorkspace(view.viewId, view.viewRepo);
    };

    /**
     * Bring Review forward on a scope another place chose: a stash, a range of
     * commits.
     * @param {string} next - The scope.
     */
    const showScope = (next) => {
      reviewRead = true;
      choose(next);
      showPlace('review', true);
    };

    const refs = createRefsPlace({
      git: () => context.services.git,
      workspaces: () => context.services.workspaces,
      workspaceOption,
      rootElement: root,
      toast,
      repo: () => changes.repo(),
      dirtyCount: () => changes.dirtyCount(),
      following: () => !isPinned(config),
      logOpen: () => log.isOpen(),
      toggleLog: () => log.toggle(),
      toggleFollow: () => {
        if (isPinned(config)) setWorkspace(null);
        else setWorkspace(context.services.workspaces?.followed?.() || '');
      },
      showRefs: () => showPlace('refs', true),
      network: (kind) => askNetwork(kind, head.primaryButton),
      folded: () => (Array.isArray(config.folded) ? config.folded.filter((id) => typeof id === 'string') : []),
      setFolded: (ids) => {
        const saved = { ...config };
        delete saved.folded;
        if (ids.length) saved.folded = ids;
        writeInPlace(saved, 'folded sections');
      },
      refreshAll: () => {
        changes.refresh();
        refs.refresh();
        history.refresh();
        void readRepos();
        if (reviewRead) void refresh();
      },
      viewTree,
      showScope,
      showHistory: (target) => {
        showPlace('history', true);
        void history.reveal(target);
      },
      showChanges: () => showPlace('changes', true),
      levelChanged: () => syncLevel(),
      treeGone: (e) => treeGone(e),
      sidebar: () => sidebarShown(),
      visible: () => place === 'refs' || sidebarShown(),
      showRepo: (repo) => changes.showRepo(repo),
    });
    refs.element.classList.add('git-pin__place', 'git-pin__place--refs');

    const history = createHistoryPlace({
      git: () => context.services.git,
      workspaces: () => context.services.workspaces,
      workspaceOption,
      root: treeRoot,
      review: reviewService,
      rootElement: root,
      repo: () => changes.repo(),
      toast,
      dirtyCount: () => changes.dirtyCount(),
      following: () => !isPinned(config),
      logOpen: () => log.isOpen(),
      showScope,
      viewTree,
      showChanges: () => showPlace('changes', true),
      levelChanged: () => syncLevel(),
      treeGone: (e) => treeGone(e),
    });
    history.element.classList.add('git-pin__place', 'git-pin__place--history');
    head.handlers.branch = (anchor) => refs.openSwitcher(anchor);
    head.handlers.more = (anchor) => refs.openMenu('repo', anchor);
    head.handlers.action = (action, anchor) => {
      if (action === 'fetch' || action === 'pull' || action === 'push') askNetwork(action, anchor);
      else refs.act(action, anchor);
    };
    // Every place, and the review once it has been read: what moved under the
    // pin may show in any of them.
    head.handlers.refresh = () => {
      changes.refresh();
      refs.refresh();
      history.refresh();
      return Promise.all([readRepos(), reviewRead ? refresh() : null]);
    };

    // The repositories the tree holds: the visible tree's status follows the
    // conversation, so a pin fixed to a workspace asks that tree's review.
    const readRepos = async () => {
      if (isPinned(config)) {
        try {
          pinnedReview = await context.services.git.review(workspaceOption());
          if (live) changes.setRepos(pinnedReview.repos || []);
        } catch (_) { /* the root repository is shown regardless */ }
      } else {
        changes.setRepos(status()?.repos || []);
      }
    };
    const unwatchStatus = context.services.git.onChange?.(() => {
      if (live && !isPinned(config)) changes.setRepos(status()?.repos || []);
    });
    const watchResync = () => context.services.git.watch?.((event) => {
      if (live && event.type === 'git-resync') void readRepos();
    }, workspaceOption());
    let unwatchResync = watchResync();
    /** The workspace the watches were taken out for. */
    let watchedWorkspace = treeKeyOf(config);

    /**
     * The config names another tree than the one watched: watch and read that
     * one, in every place, from the repository the config names in it.
     * @param {boolean} [rereview] - Read the review again too, if it was read;
     *   an update that moved the tree does that itself, with the scope.
     * @returns {boolean} Whether it had moved.
     */
    const moveTree = (rereview = true) => {
      if (treeKeyOf(config) === watchedWorkspace) return false;
      watchedWorkspace = treeKeyOf(config);
      unwatchResync?.();
      unwatchResync = watchResync();
      pinnedReview = null;
      netJobs.clear();
      starting = null;
      changes.setTree(typeof config.repo === 'string' ? config.repo : '');
      refs.setTree();
      history.setTree();
      void readRepos();
      if (rereview) {
        review = null;
        drawn = null;
        error = '';
        render();
        if (reviewRead) void refresh();
      }
      return true;
    };

    // The switcher's row: the tabs, and at its right end the toast — one
    // place for it whatever is shown, where it covers no action in any place.
    const switcher = createElement('div', 'git-pin__places');
    const tabList = createElement('div', 'git-pin__tabs');
    tabList.setAttribute('role', 'tablist');
    switcher.append(tabList, toast.element);
    /** @type {Record<string, HTMLButtonElement>} */
    const tabs = {};
    for (const p of PLACES) {
      const tab = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__place-btn'));
      tab.append(createElement('span', 'git-pin__place-label', t(p.label)));
      tab.type = 'button';
      tab.dataset.place = p.id;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => showPlace(p.id, true));
      tabs[p.id] = tab;
      tabList.append(tab);
    }
    // Changes says how many files are changed, as a count on its tab.
    const changesCount = createElement('span', 'git-pin__place-count');
    changesCount.hidden = true;
    tabs.changes?.append(changesCount);
    const drawCounts = () => {
      const count = shownRepo?.changed || 0;
      changesCount.hidden = !count;
      changesCount.textContent = count ? formatNumber(count) : '';
      tabs.changes?.setAttribute('aria-label', count
        ? t('Changes, {count, plural, one {# changed file} other {# changed files}}', { count })
        : t('Changes'));
    };
    /** @type {PlaceId} */
    let place = placeOf(config);
    places = {
      changes: { ...changes, shown: () => {} },
      history,
      review: {
        element: body,
        shown: () => {
          if (reviewRead) return;
          reviewRead = true;
          void refresh();
        },
        refresh: () => { void refresh(); },
        setTree: () => {},
        handleKey: () => false,
        focus: () => panel.focus(),
        teardown: () => panel.destroy(),
      },
      refs,
    };
    // The places sit in a row, so a full-width pin can show the Refs list as
    // a sidebar beside Changes or History.
    const main = createElement('div', 'git-pin__main');
    main.append(changes.element, history.element, body, refs.element);

    // The splits between each place's list and detail, and the sidebar's
    // width, as the user last left them.
    applySplits(root, normalizeSplits(config.splits));
    /** @param {import('./git/splitter.js').Splits} next - The splits. */
    const saveSplits = (next) => {
      const { splits: _old, ...rest } = config;
      writeInPlace(Object.keys(next).length ? { ...rest, splits: next } : rest, 'pane sizes');
    };
    /**
     * @param {HTMLElement|null} on - What the handle is placed in.
     * @param {import('./git/splitter.js').SplitName} name - The split.
     * @param {string} label - What it resizes.
     */
    const splitHandle = (on, name, label) => {
      if (!on) return;
      on.append(createSplitHandle({
        name, label, root, box: () => on.getBoundingClientRect(), splits: () => normalizeSplits(config.splits), onChange: saveSplits,
      }));
    };
    splitHandle(changes.element.querySelector('.git-changes__body'), 'changes', t('Resize the file list'));
    splitHandle(history.element.querySelector('.git-history__body'), 'history', t('Resize the commit list'));
    splitHandle(refs.element.querySelector('.git-refs__body'), 'refs', t('Resize the refs list'));
    splitHandle(refs.element, 'sidebar', t('Resize the sidebar'));
    root.append(head.element, banner.element, switcher, main);

    /**
     * Write the mode the pin's size puts it in onto the root, where tests and
     * the places' keys read it; the stylesheet decides the same with container
     * queries.
     */
    /** Whether the Refs list was on screen as the sidebar when last measured. */
    let sidebarWasShown = false;
    /** @returns {boolean} Whether the Refs list is on screen as the sidebar: a full pin, beside Changes or History. */
    const sidebarShown = () => measureMode(root) === 'full' && BESIDE_SIDEBAR.has(place);
    const syncMode = () => {
      const mode = measureMode(root);
      if (root.dataset.mode !== mode) root.dataset.mode = mode;
      // A chip has no switcher row: its toast goes over the head line instead.
      const toastHome = mode === 'chip' ? root : switcher;
      if (toast.element.parentElement !== toastHome) toastHome.append(toast.element);
      // The sidebar is read as the place is, the first time it comes on
      // screen; after that the place's watch keeps it current.
      const sidebar = mode === 'full' && BESIDE_SIDEBAR.has(place);
      if (sidebar && !sidebarWasShown) refs.shown();
      sidebarWasShown = sidebar;
    };
    const resizes = new ResizeObserver(() => {
      if (live) syncMode();
    });
    resizes.observe(root);

    /**
     * @param {PlaceId} next - The place to show.
     * @param {boolean} [save] - Whether the user chose it, so it is remembered.
     */
    const showPlace = (next, save = false) => {
      place = next;
      root.dataset.place = next;
      const table = /** @type {Record<PlaceId, PinPlace>} */ (places);
      // Refs is left unhidden beside Changes and History: the stylesheet shows
      // it there as a sidebar when the pin is full, and not at any other size.
      for (const [id, p] of Object.entries(table)) {
        p.element.hidden = id !== next && !(id === 'refs' && BESIDE_SIDEBAR.has(next));
      }
      for (const [id, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(id === next));
      syncLevel();
      syncMode();
      table[next].shown();
      if (save && config.place !== next) writeInPlace({ ...config, place: next }, 'place');
    };

    root.addEventListener('keydown', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.matches('input, textarea, select')) {
        if (event.key === 'Escape' && target.closest('.git-commit')) {
          event.preventDefault();
          target.blur();
          root.focus();
        }
        return;
      }
      if (target.closest('diff-viewer') && event.key === ' ') return;
      if (places?.[place].handleKey(event)) event.preventDefault();
    });

    syncControls();
    render();
    showPlace(place);
    drawCounts();
    void readRepos();

    return {
      update: (next) => {
        context = next;
        if (saving === 0) config = next.pin?.config || config;
        // A pin moved to another tree watches and reads that one; its review,
        // if read, is read again below with the scope.
        const movedTree = moveTree(false);
        // Another window, or the agent, may have rescoped this pin, which
        // brings Review forward; a place chosen elsewhere is followed too.
        const configured = normalizeScope(config.scope);
        const rescoped = configured !== scope;
        // An @turn pin not fixed to a conversation compares the visible one's
        // turn, so another conversation coming into view is another review.
        const turnMoved = !rescoped && scope === TURN_SCOPE && turnConv() !== askedConv;
        if (rescoped || movedTree || turnMoved) {
          scope = configured;
          review = null;
          drawn = null;
          error = '';
          syncControls();
          render();
          if (rescoped && configured !== DEFAULT_SCOPE && place !== 'review') showPlace('review');
          else if (reviewRead) void refresh();
          if (rescoped) return;
        }
        if (isPlace(config.place) && config.place !== place) showPlace(config.place);
        syncControls();
        render();
      },
      focus: () => {
        // Asked as the board opens, while it is still sliding in from past the
        // workspace's edge: a scrolling focus() would chase it there.
        if (place === 'review') panel.focus();
        else root.focus({ preventScroll: true });
      },
      // Out of sight, a popover or a toast hung off it would be left floating
      // over another tab; everything else carries on, watched as before.
      hide: () => {
        closePopover();
        toast.hide();
      },
      teardown: () => {
        live = false;
        resizes.disconnect();
        for (const p of Object.values(/** @type {Record<PlaceId, PinPlace>} */ (places))) p.teardown();
        unwatchStatus?.();
        unwatchResync?.();
      },
    };
  }
}

export default GitPin;
