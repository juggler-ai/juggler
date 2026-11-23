//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git status info card — a quiet, live summary of the working tree the
 * visible conversation works in, which is the project unless that conversation
 * is bound to a workspace, in which case the card names it first.
 *
 * Each repository with something uncommitted is one line: its branch, how far
 * that branch is from its upstream, and at the end a small count of the files
 * waiting, its dot coloured by the most pressing of them (a conflict, then a
 * change not staged, then only staged ones). The breakdown is the count's
 * tooltip. With a single repo at the root the line is unlabelled; with several,
 * or a repo below the root, each starts with its location (the root repo by its
 * folder name, nested repos by their relative path). A clean lone repo still
 * shows its branch, with a tick; a clean set of several says only that nothing
 * changed.
 *
 * It is also the way in to the Git pin, which shows the same tree in the room to
 * read it: the card answers "where am I, and is anything uncommitted", and
 * clicking it opens the pin; clicking a repository's badge opens it on that
 * repository (the source names it, and the pin takes it on if it is already
 * on the board). The card names a source kind and lets the registry
 * find the pin, so neither knows about the other — which is how an ambient card
 * and its pin should meet, rather than the card importing the pin.
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region.
 * The status itself comes from the host's git service, a shared cache which the Git pin reads
 * too — so having both open costs one poll, not two — and which holds the last
 * snapshot across remounts so this paints instantly. Not an ARIA live region:
 * the counts change quietly and the same information is available from git.
 * @module extensions/juggler-core/cards/git-status-card
 */

import InfoCardType from 'juggler/info-card-type';
import { translator, formatNumber, formatList } from 'juggler/i18n';
import { canPinSource, injectStylesOnce, pinSource } from 'juggler/ui';
import { branchPhrase, divergencePhrase, repoLabel } from '../lib/git-status.js';
import { icon } from '../pins/git/icons.js';
import { gitClientOf } from '../lib/git-client.js';

const t = translator('@juggler/core');

// The card is ambient and small: one line per repository, flat on the sidebar
// until the pointer is on it. The branch is the anchor (mono, primary text);
// the file count is the quietest thing that still reads at a glance — a dot in
// the colour of what is waiting and a number. The whole card is one button;
// the arrow at its right edge is the only thing that says so at rest.
//
// A repository's badge opens the pin on that repository, so it is a button of
// its own — and a button cannot hold another. So the card's button is a layer
// stretched under the content (positioned, so it is hit before the static
// content above it), and the badges are raised over it; the content itself
// takes no clicks.
injectStylesOnce('git-status-card-styles', `
.git-status-card__card {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--space-4);
  margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-4));
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  transition: background var(--transition-base);
}

.git-status-card__card:hover {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
}

.git-status-card__launch {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
}

.git-status-card__launch:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.git-status-card__card .git-status-card__summary {
  pointer-events: none;
}

.git-status-card__summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.git-status-card__go {
  display: flex;
  pointer-events: none;
  color: var(--text-tertiary);
  opacity: 0;
  transition: opacity var(--transition-base), color var(--transition-base);
}

.git-status-card__card:hover .git-status-card__go,
.git-status-card__launch:focus-visible ~ .git-status-card__go {
  opacity: 1;
  color: var(--accent-blue);
}

.git-status-card__line {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  font-size: var(--font-size-sm);
  line-height: var(--leading-normal);
}

.git-status-card__summary .git-pin__icon,
.git-status-card__go .git-pin__icon {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.git-status-card__branch-icon {
  display: flex;
  color: var(--text-tertiary);
}

.git-status-card__branch {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.git-status-card__branch--none {
  color: var(--warning);
  font-family: var(--font-ui);
}

.git-status-card__repo {
  flex: 0 1 auto;
  min-width: 2rem;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 var(--space-4);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  border: 1px solid transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: var(--leading-normal);
  white-space: nowrap;
}

button.git-status-card__repo {
  position: relative;
  z-index: var(--z-raised);
  pointer-events: auto;
  cursor: pointer;
  transition: background var(--transition-base), border-color var(--transition-base), color var(--transition-base);
}

button.git-status-card__repo:hover {
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent-blue) 45%, transparent);
  color: var(--accent-blue);
}

button.git-status-card__repo:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.git-status-card__sync {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.git-status-card__sync .git-pin__icon {
  width: 0.625rem;
  height: 0.625rem;
}

.git-status-card__files {
  --git-status-tone: var(--warning);

  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

button.git-status-card__files {
  position: relative;
  z-index: var(--z-raised);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  line-height: inherit;
  pointer-events: auto;
  cursor: pointer;
}

button.git-status-card__files:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-primary);
}

button.git-status-card__files:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.git-status-card__files::before {
  content: "";
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: var(--git-status-tone);
}

.git-status-card__files--staged {
  --git-status-tone: var(--success);
}

.git-status-card__files--conflicted {
  --git-status-tone: var(--danger);
}

.git-status-card__clean-tick {
  display: flex;
  margin-left: auto;
  color: var(--success);
}

.git-status-card__note {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--leading-normal);
}
`);

/**
 * @typedef {import('../lib/git-client.js').GitRepo} GitRepo
 */

/**
 * @param {string} tag - The element's tag.
 * @param {string} className - Its class.
 * @param {string} [text] - Its text.
 * @returns {HTMLElement} The element.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A line of words standing for the whole card ("Checking…", "No git
 * repository", "No changed files") rather than for one repository.
 * @param {string} text
 * @returns {HTMLParagraphElement} The populated line element.
 */
function note(text) {
  return /** @type {HTMLParagraphElement} */ (el('p', 'git-status-card__note', text));
}

/**
 * A badge naming a repository or workspace: data, so never translated.
 * @param {string} name - The name.
 * @returns {HTMLElement} The badge.
 */
function badge(name) {
  const b = el('span', 'git-status-card__repo', name);
  b.title = name;
  return b;
}

/**
 * A repository's badge. Where the Git pin can be opened, it opens it on this
 * repository; otherwise it is only a name.
 * @param {string} name - Its label.
 * @param {string} path - Its path in the tree, '' for the root repository.
 * @returns {HTMLElement} The badge.
 */
function repoBadge(name, path) {
  /** @type {import('../lib/git-client.js').GitPinSource} */
  const source = { ...GIT_SOURCE, repo: path };
  if (!canPinSource(source)) return badge(name);
  const b = /** @type {HTMLButtonElement} */ (el('button', 'git-status-card__repo', name));
  b.type = 'button';
  b.title = t('Open {repo} in Git', { repo: name });
  b.addEventListener('click', () => { void pinSource(source); });
  return b;
}

/**
 * @param {GitRepo} repo - A repo.
 * @returns {boolean} Whether it has anything uncommitted.
 */
const isDirty = (repo) => repo.changed > 0 || repo.staged > 0 || (repo.conflicted || 0) > 0;

/**
 * The files waiting in the repo, as a dot and a number: the dot says the most
 * pressing kind among them, the tooltip says how many of each. Raised over the
 * card's button so the tooltip can be had, it opens the pin on its repository,
 * as the badge does — where the Git pin can be opened at all.
 * @param {GitRepo} repo - A repo with something uncommitted.
 * @returns {HTMLElement} The count.
 */
function filesCount(repo) {
  const conflicted = repo.conflicted || 0;
  const tone = conflicted > 0 ? ' git-status-card__files--conflicted'
    : repo.changed > 0 ? '' : ' git-status-card__files--staged';
  const count = repo.total || Math.max(repo.changed, repo.staged);
  /** @type {import('../lib/git-client.js').GitPinSource} */
  const source = { ...GIT_SOURCE, repo: repo.path || '' };
  const clickable = canPinSource(source);
  const files = el(clickable ? 'button' : 'span', `git-status-card__files${tone}`, formatNumber(count));
  if (clickable) {
    /** @type {HTMLButtonElement} */ (files).type = 'button';
    files.addEventListener('click', () => { void pinSource(source); });
  }
  files.title = formatList([
    ...(conflicted > 0 ? [t('{count, plural, one {# conflict} other {# conflicts}}', { count: conflicted })] : []),
    ...(repo.changed > 0 ? [t('{count} changed', { count: repo.changed })] : []),
    ...(repo.staged > 0 ? [t('{count} staged', { count: repo.staged })] : []),
  ]);
  return files;
}

/**
 * One repository on one line: its label when it needs one, its branch, how far
 * that is from its upstream, and what is waiting — or a tick for nothing.
 * @param {GitRepo} repo - The repo.
 * @param {string|null} name - Its location label, or null when it needs none.
 * @returns {HTMLElement} The line.
 */
function repoLine(repo, name) {
  const row = el('div', 'git-status-card__line');
  if (name) row.append(repoBadge(name, repo.path || ''));
  const branchIcon = el('span', 'git-status-card__branch-icon');
  branchIcon.append(icon('branch'));
  const none = repo.detached || !repo.branch;
  row.append(branchIcon, el('span', `git-status-card__branch text-truncate${none ? ' git-status-card__branch--none' : ''}`, branchPhrase(repo)));
  const drift = divergencePhrase(repo);
  if (drift) {
    const sync = el('span', 'git-status-card__sync');
    sync.title = t('Upstream {upstream}: {divergence}', { divergence: drift, upstream: repo.upstream });
    if (repo.ahead > 0) sync.append(icon('up'), document.createTextNode(formatNumber(repo.ahead)));
    if (repo.behind > 0) sync.append(icon('down'), document.createTextNode(formatNumber(repo.behind)));
    row.append(sync);
  }
  if (isDirty(repo)) {
    row.append(filesCount(repo));
  } else {
    const tick = el('span', 'git-status-card__clean-tick');
    tick.title = t('No changed files');
    tick.setAttribute('role', 'img');
    tick.setAttribute('aria-label', t('No changed files'));
    tick.append(icon('check'));
    row.append(tick);
  }
  return row;
}

/**
 * Name the tree the card is describing, when that tree is a workspace rather
 * than the project: at the start of its first line, or on a line of its own
 * above a note. The card follows the visible conversation, so a tab switch can
 * move it from the project to a worktree and back; without this the two read
 * identically, down to "No changed files".
 * @param {string} workspace - The workspace's name, '' for the project.
 * @param {HTMLElement[]} nodes - What the card says about the tree.
 * @returns {HTMLElement[]} The same, naming the tree when it has a name.
 */
function inTree(workspace, nodes) {
  if (!workspace) return nodes;
  const b = badge(workspace);
  b.title = t('Workspace: {workspace}', { workspace });
  const first = nodes[0];
  if (first?.classList.contains('git-status-card__line')) {
    first.prepend(b);
    return nodes;
  }
  const row = el('div', 'git-status-card__line');
  row.append(b);
  return [row, ...nodes];
}

/**
 * The working tree, as something the board can be asked to show. The card names
 * a kind rather than a pin class: the registry finds whichever item type accepts
 * it, so the card knows nothing about the Git pin and the pin knows nothing
 * about the card.
 * @type {import('juggler/pinboard-item-type').PinSource}
 */
/** @type {import('../lib/git-client.js').GitPinSource} */
const GIT_SOURCE = { kind: 'git' };

/**
 * Lay a button that opens the pin under the card's content, when there is a pin
 * to open. Gated on the registry, so an affordance that would do nothing is
 * absent rather than dead — the same gate the properties panels' pin buttons use.
 * It opens the pin the same way in every state, on whichever repository it was
 * last showing: the pin is for the whole of the tree, not only for what is
 * uncommitted in it. A repository's badge, raised over it, opens it on that one.
 * @param {HTMLElement[]} nodes - The rendered content.
 * @returns {HTMLElement[]} The content, with its button or not.
 */
function withLauncher(nodes) {
  const summary = el('div', 'git-status-card__summary');
  summary.append(...nodes);
  if (!canPinSource(GIT_SOURCE)) return [summary];
  const card = el('div', 'git-status-card__card');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'git-status-card__launch';
  button.setAttribute('aria-label', t('Open Git in the Pinboard'));
  button.title = t('Open Git');
  // pinSource dedupes: the pin already on the board is revealed rather than
  // another added.
  button.addEventListener('click', () => { void pinSource(GIT_SOURCE); });
  const go = el('span', 'git-status-card__go');
  go.append(icon('forward'));
  card.append(button, summary, go);
  return [card];
}

/**
 * Render the current snapshot into the content region.
 * @param {HTMLElement} contentEl
 * @param {import('../lib/git-client.js').GitClient} git - The card's git client.
 * @returns {void}
 */
function render(contentEl, git) {
  const snap = git.status();
  if (snap === null) {
    // Nothing known and a reason why: the read is being refused rather than
    // taking its time, and "Checking…" would say that forever. The likeliest
    // reason is a conversation bound to a workspace that cannot be reached, and
    // the server's own words for that are better than any we would invent.
    const error = git.error();
    contentEl.replaceChildren(...withLauncher([note(error || t('Checking…'))]));
    return;
  }
  const repos = snap.repos || [];
  if (repos.length === 0) {
    contentEl.replaceChildren(...withLauncher(inTree(snap.workspace ?? '', [note(t('No git repository'))])));
    return;
  }
  // Only the lone-repo-at-root case hides its location; anything else labels.
  const lone = repos.length === 1 && !repos[0]?.path;
  const labelOf = (/** @type {GitRepo} */ r) => (lone ? null : repoLabel(snap.root, r.path));
  const dirty = repos.filter(isDirty);
  // A lone repo's line is worth a glance even when clean; several clean ones
  // are summed up in a note rather than listed.
  const only = repos.length === 1 ? repos[0] : undefined;
  const nodes = dirty.length ? dirty.map((r) => repoLine(r, labelOf(r)))
    : only ? [repoLine(only, labelOf(only))]
      : [note(t('No changed files'))];
  contentEl.replaceChildren(...withLauncher(inTree(snap.workspace ?? '', nodes)));
}

/**
 * The Git status info card.
 */
export default class GitStatusCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'git-status',
    name: 'Git status',
    version: '1.0.0',
    description: "Show a summary of the git working tree in the sidebar — the project's, or the visible conversation's workspace.",
    eyebrow: 'Git status',
    priority: 10,
  };

  /** @returns {boolean} Always renderable (it reports its own state). */
  hasContent() {
    return true;
  }

  /**
   * Paint whatever the host already holds, then follow it. The polling, the
   * focus gate and the last-good-snapshot retention all belong to the host, so
   * mounting a second surface onto the same status costs nothing.
   * @param {HTMLElement} contentEl
   * @param {unknown} _session - Unused: the status follows the visible conversation.
   * @param {import('juggler/info-card-type').InfoCardContext} context - The card's services.
   * @returns {() => void} Teardown that stops watching.
   */
  mount(contentEl, _session, context) {
    const git = gitClientOf(context.services, context.signal);
    const stopWatching = git.onChange(() => render(contentEl, git));
    render(contentEl, git);
    void git.refresh();
    return stopWatching;
  }
}
