//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git status info card — a quiet, live summary of the working tree the
 * visible conversation works in, which is the project unless that conversation
 * is bound to a workspace, in which case the card names it first. When there's a
 * single repo at the root the line is
 * just the counts. With multiple repos, or a repo below the root, each line is
 * prefixed with the repo's location (the root repo by its folder name, nested
 * repos by their relative path).
 *
 * It is also the way in to the Git pin, which shows the same tree in the room to
 * read it: the card answers "is there anything uncommitted", and clicking it
 * opens the pin that answers "what". The card names a source kind and lets the
 * registry find the pin, so neither knows about the other — which is how an
 * ambient card and its pin should meet, rather than the card importing the pin.
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region.
 * The status itself comes from the shared host cache, which the Git pin reads
 * too — so having both open costs one poll, not two — and which holds the last
 * snapshot across remounts so this paints instantly. Not an ARIA live region:
 * the counts change quietly and the same information is available from git.
 * @module extensions/juggler-core/cards/git-status-card
 */

import InfoCardType from 'juggler/info-card-type';
import { translator } from 'juggler/i18n';
import { injectStylesOnce } from 'juggler/ui';
import gitStatusCache from '../../../js/services/git-status-cache.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { countsPhrase, repoLabel } from '../lib/git-status.js';

const t = translator('@juggler/core');

// Per-repo rows: a quiet name badge and the counts, the whole row in the mono
// face so path labels and counts share the tabular look of the working tree
// they describe. The badge is a barely-there fill and hairline, so the name
// reads as a tag without competing with the counts. The card's whole content is
// a button that opens the Git pin, and must not look like one: the card is
// ambient, so it is a bare region that reveals itself on hover. The review cue
// says that something can be done about the counts.
injectStylesOnce('git-status-card-styles', `
.git-status-card__line {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: var(--leading-normal);
}

.git-status-card__repo {
  flex-shrink: 0;
  padding: 0.0625rem var(--space-4);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
}

.git-status-card__counts {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.git-status-card__launch {
  display: block;
  width: 100%;
  margin: calc(-1 * var(--space-4));
  padding: var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.git-status-card__launch:hover {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}

.git-status-card__review {
  margin-top: var(--space-2);
  color: var(--accent-blue);
  font-size: var(--font-size-sm);
}
`);

/**
 * Make a body-styled line element. Used for the whole-card status messages
 * ("Checking…", "No changed files"), not the per-repo rows.
 * @param {string} text
 * @returns {HTMLParagraphElement} The populated line element.
 */
function line(text) {
  const p = document.createElement('p');
  p.className = 'info-card__body';
  p.textContent = text;
  return p;
}

/**
 * Make a per-repo status row: an optional subtle name badge followed by the
 * monospaced counts phrase. When `name` is null (the lone-repo-at-root case)
 * the row is just the counts, still in the mono face for a consistent read.
 * @param {string|null} name - Repo location label, or null to omit the badge.
 * @param {string} counts - The counts phrase (e.g. "2 changed, 1 staged").
 * @returns {HTMLDivElement} The populated row element.
 */
function repoLine(name, counts) {
  const row = document.createElement('div');
  row.className = 'git-status-card__line';
  if (name) {
    const badge = document.createElement('span');
    badge.className = 'git-status-card__repo';
    badge.textContent = name;
    row.appendChild(badge);
  }
  const countsEl = document.createElement('span');
  countsEl.className = 'git-status-card__counts';
  countsEl.textContent = counts;
  row.appendChild(countsEl);
  return row;
}

/**
 * Name the tree the card is describing, above whatever it says about it, when
 * that tree is a workspace rather than the project. The card follows the visible
 * conversation, so a tab switch can move it from the project to a worktree and
 * back; without this the two read identically, down to "No changed files".
 * @param {string} workspace - The workspace's name, '' for the project.
 * @param {HTMLElement[]} nodes - What the card says about the tree.
 * @returns {HTMLElement[]} The same, under the tree's name when it has one.
 */
function inTree(workspace, nodes) {
  if (!workspace) return nodes;
  const row = document.createElement('div');
  row.className = 'git-status-card__line';
  const badge = document.createElement('span');
  badge.className = 'git-status-card__repo';
  badge.textContent = workspace;
  badge.title = t('Workspace: {workspace}', { workspace });
  row.appendChild(badge);
  return [row, ...nodes];
}

/**
 * The working tree, as something the board can be asked to show. The card names
 * a kind rather than a pin class: the registry finds whichever item type accepts
 * it, so the card knows nothing about the Git pin and the pin knows nothing
 * about the card.
 * @type {import('juggler/pinboard-item-type').PinSource}
 */
const GIT_SOURCE = { kind: 'git' };

/**
 * Put the card's content inside a button that opens the pin, when there is a pin
 * to open. Gated on the registry, so an affordance that would do nothing is
 * absent rather than dead — the same gate the properties panels' pin buttons use.
 *
 * With changes waiting, the card says where they can be read and commented on,
 * because the counts alone do not suggest that anything can be done about them.
 * With none, it offers only to be looked at: inviting a review of nothing would
 * be an invitation to nothing.
 * @param {HTMLElement[]} nodes - The rendered content.
 * @param {boolean} [review] - Whether there is anything to review.
 * @returns {HTMLElement[]} The content, wrapped or not.
 */
function withLauncher(nodes, review = false) {
  if (!pinboardView.canPin(GIT_SOURCE)) return nodes;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'git-status-card__launch';
  button.setAttribute('aria-label', review ? t('Review changes in the Pinboard') : t('Open Git status in the Pinboard'));
  button.title = review ? t('Review changes') : t('Open in the Pinboard');
  button.append(...nodes);
  if (review) {
    const cue = document.createElement('div');
    cue.className = 'git-status-card__review';
    cue.textContent = t('Review changes →');
    button.appendChild(cue);
  }
  // addSource dedupes: the Git pin is a singleton, so a second click reveals the
  // pin that is already there rather than adding another.
  button.addEventListener('click', () => { void pinboardView.addSource(GIT_SOURCE); });
  return [button];
}

/**
 * Render the current snapshot into the content region.
 * @param {HTMLElement} contentEl
 * @returns {void}
 */
function render(contentEl) {
  const snap = gitStatusCache.get();
  if (snap === null) {
    // Nothing known and a reason why: the read is being refused rather than
    // taking its time, and "Checking…" would say that forever. The likeliest
    // reason is a conversation bound to a workspace that cannot be reached, and
    // the server's own words for that are better than any we would invent.
    const error = gitStatusCache.getError();
    contentEl.replaceChildren(...withLauncher([line(error || t('Checking…'))]));
    return;
  }
  const repos = snap.repos || [];
  if (repos.length === 0) {
    contentEl.replaceChildren(...withLauncher(inTree(snap.workspace, [line(t('No git repository'))])));
    return;
  }
  const dirty = repos.filter((r) => r.changed > 0 || r.staged > 0);
  if (dirty.length === 0) {
    contentEl.replaceChildren(...withLauncher(inTree(snap.workspace, [line(t('No changed files'))])));
    return;
  }
  // Only the lone-repo-at-root case hides its location; anything else labels.
  const showLabels = !(repos.length === 1 && !repos[0]?.path);
  const nodes = dirty.map((r) => {
    const counts = countsPhrase(r);
    return repoLine(showLabels ? repoLabel(snap.root, r.path) : null, counts);
  });
  contentEl.replaceChildren(...withLauncher(inTree(snap.workspace, nodes), true));
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
   * Paint whatever the cache already holds, then follow it. The polling, the
   * focus gate and the last-good-snapshot retention all belong to the cache, so
   * mounting a second surface onto the same status costs nothing.
   * @param {HTMLElement} contentEl
   * @returns {() => void} Teardown that stops watching.
   */
  mount(contentEl) {
    const stopWatching = gitStatusCache.subscribe(() => render(contentEl));
    render(contentEl);
    void gitStatusCache.refresh();
    return stopWatching;
  }
}
