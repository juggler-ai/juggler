//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';
import { paintThreadSummary, paintThreadStatusText } from '../utils/thread-display.js';
import { countGroupRows, getGroupStatus } from '../utils/item-grouping.js';

/**
 * Stacked-layers glyph: several rows folded into one. Matches the header
 * toggle's meaning ("these rows are collapsed").
 */
const GROUP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="currentColor"><path d="M480-80 120-280v-80l360 200 360-200v80L480-80Zm0-160L120-440v-80l360 200 360-200v80L480-240Zm0-166L146-590l334-184 334 184-334 184Z"/></svg>';

const FAMILY_COLORS = new Set([
  'read', 'search', 'web', 'edit', 'memory', 'execute',
  'plan', 'meta', 'ask', 'thread',
]);

const PRESET_COLORS = new Set([
  'slate', 'blue', 'indigo', 'purple', 'magenta', 'pink', 'red',
  'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'brown', 'stone', 'zinc', 'crimson',
]);

/**
 * Canonical colour family for a plugin badge. The SDK permits arbitrary strings,
 * but a group cannot safely interpolate one into a custom-property name;
 * unsupported names therefore take the neutral unresolved-tool fallback.
 * @param {string} color - Badge colour name.
 * @returns {string} A supported colour name.
 */
function canonicalBadgeColor(color) {
  if (FAMILY_COLORS.has(color) || PRESET_COLORS.has(color)) return color;
  return 'slate';
}

/**
 * @param {string} color - Canonical badge colour name.
 * @returns {string} A CSS variable expression.
 */
function badgeColorValue(color) {
  const canonical = canonicalBadgeColor(color);
  if (FAMILY_COLORS.has(canonical)) {
    return `var(--ci-family-badge-${canonical}, var(--ci-family-${canonical}))`;
  }
  return `var(--ci-preset-badge-${canonical}, var(--ci-preset-${canonical}))`;
}

/**
 * Summarise a folded run as proportional, hard-edged colour bands. Families are
 * combined even when their tools were interleaved, while first appearance keeps
 * a little of the run's chronology. Deleted Y.Maps are omitted just as they are
 * from the group's count and text summary.
 * @param {any[]} members - Tool-action Y.Maps, live or stale.
 * @returns {string} A solid CSS colour or linear-gradient.
 */
export function groupBadgeBackground(members) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const member of members) {
    if (member?.get?.('type') !== 'tool-action') continue;
    const color = canonicalBadgeColor(iconOptionsForItem(member).color || 'slate');
    counts.set(color, (counts.get(color) || 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (!total) return badgeColorValue('slate');
  if (counts.size === 1) return badgeColorValue(/** @type {string} */ (counts.keys().next().value));

  let used = 0;
  const stops = [];
  for (const [color, count] of counts) {
    const start = (used / total) * 100;
    used += count;
    const end = (used / total) * 100;
    const value = badgeColorValue(color);
    stops.push(`${value} ${start}%`, `${value} ${end}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * ToolGroupMessage — the collapsed tile for a run of adjacent tool uses.
 *
 * Purely presentational: it stands in for items that still exist unchanged in
 * the document, and selecting it opens those items in the next column.
 *
 * The face is built from the two shared pieces every comparable row already
 * uses, so it needs no styling of its own:
 *   - the composition summary ("3× Read File, 2× Grep") is the tile's TITLE,
 *     painted into the standard `.message-text` slot — the same slot, band and
 *     typography as every other item's title, which is what lines it up with
 *     the icon and lozenge beside it;
 *   - the status line below it is the sub-thread status block, so a group
 *     holding a pending approval turns the same orange as a sub-thread would
 *     and the route from the tab to the action stays unbroken when folded.
 */
class ToolGroupMessage extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../utils/item-grouping.js').ItemGroup|null} @private */
    this._group = null;
    /** @type {import('../utils/thread-display.js').ThreadLiveStatus|null} @private */
    this._live = null;
    /**
     * Structural-mode key: the status block is repainted only when this
     * changes, so the spinner element survives in-place text updates and its
     * CSS animation doesn't restart on every tick. Mirrors thread-message.
     * @type {string|null} @private
     */
    this._mode = null;
    /**
     * Content signature of the last paint. The column rebroadcasts live status
     * to every tile roughly once a second; this skips the repaint when nothing
     * visible changed.
     * @type {string|null} @private
     */
    this._paintedKey = null;
    /** @type {HTMLElement|null} @private - The tile face, built once and kept. */
    this._article = null;
    /** @type {HTMLElement|null} @private - Title row: the composition summary. */
    this._title = null;
    /** @type {HTMLElement|null} @private - Status block beneath the title. */
    this._status = null;
    /** @type {HTMLElement|null} @private - The group icon's coloured box. */
    this._icon = null;
    /** @type {HTMLElement|null} @private - "N tools" lozenge beside the icon. */
    this._badge = null;
  }

  connectedCallback() {
    this.render();
  }

  /**
   * Update from the group entry (called by the render diff and by
   * _notifyChangedElements when a member's state changes).
   * @param {import('../utils/item-grouping.js').ItemGroup} group - The group entry.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Live LLM status.
   */
  updateFromItem(group, live) {
    this._group = group;
    if (live !== undefined) this._live = live;
    this.render();
  }

  /**
   * Refresh from a new live-status snapshot without changing the group.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} live - Live LLM status.
   */
  setLiveStatus(live) {
    this._live = live;
    if (this._group) this.render();
  }

  /**
   * The tile renders its own status block, so the column footer must not
   * duplicate it — same contract as a sub-thread tile.
   * @returns {null} Always null.
   */
  getBusyState() {
    return null;
  }

  /**
   * Build the tile face: icon, lozenge, title row and an empty status block.
   * Done once — every later update repaints the text in place, leaving the icon
   * box (and so its pulse animation) untouched.
   *
   * The title is a bare `.message-text` directly inside `.message-content-box`,
   * which is precisely what the shared title-row rule in styles.css selects:
   * that rule gives it the icon-row band height and centres it, so the summary
   * lands on the icon/lozenge baseline the same way every other item's title
   * does. The status block is a sibling beneath it, so the two stack without
   * either one owning the other's alignment.
   * @param {number} count - Number of members, for the lozenge.
   * @private
   */
  _build(count) {
    const article = document.createElement('article');
    article.className = 'tool-group-item';

    const title = document.createElement('span');
    title.className = 'message-text';

    // The lozenge counts what's inside, so the row reads as one unit ("5
    // tools") rather than borrowing any single member's type name.
    const wrapper = wrapWithIcon(title, {
      color: 'slate',
      iconSvg: GROUP_ICON_SVG,
      badge: `${count} tools`,
    });

    const status = document.createElement('div');
    wrapper.querySelector('.message-content-box')?.appendChild(status);
    article.appendChild(wrapper);

    this._article = article;
    this._title = title;
    this._status = status;
    this._icon = /** @type {HTMLElement|null} */ (article.querySelector('.message-icon-box'));
    this._badge = /** @type {HTMLElement|null} */ (article.querySelector('.context-item-type-badge'));
    this._mode = null;
    this._paintedKey = null;
    this.replaceChildren(article);
  }

  render() {
    const members = this._group?.members || [];
    const status = members.length ? getGroupStatus(members, this._live) : null;
    // Counted the same way the summary counts, so the lozenge and the kinds
    // listed beneath it always describe the same set of rows.
    const count = countGroupRows(members);
    const badgeBackground = groupBadgeBackground(members);

    // Only LIVE work pulses the icon: a member is running, or one is parked on
    // an approval. 'errored' and 'idle' are both terminal — the run is over,
    // however it ended — so a finished run sits still. (A run that merely
    // contains a failed tool is finished, and must not read as busy.)
    const processing = !!status && (status.kind === 'running' || status.kind === 'paused');

    // Structural key: which elements the status block is made of — just the
    // status line, which a run with nothing to report omits entirely (a live run
    // says nothing the footer below isn't already saying, and a settled one has
    // its badge). Its appearing or disappearing needs a repaint of the block;
    // anything else is a text update.
    const mode = status ? `status:${status.message ? '1' : '0'}` : 'empty';

    // Content signature of this tick — row count included, since the lozenge
    // shows it and a run grows as the turn streams in.
    const key = status
      ? `${status.kind}:${status.goal}:${status.message}:${count}:${badgeBackground}`
      : `empty:${count}:${badgeBackground}`;

    if (!this._article || this._article.parentNode !== this) this._build(count);
    const article = /** @type {HTMLElement} */ (this._article);

    // Toggled as an attribute rather than by rebuilding the tile: re-setting an
    // attribute to the value it already holds leaves the running animation
    // alone, whereas replacing the icon box restarts the pulse from frame zero —
    // which, across a run of quick tool calls, reads as no pulse at all.
    if (processing) article.setAttribute('data-processing', 'true');
    else article.removeAttribute('data-processing');

    if (this._mode !== mode) {
      this._mode = mode;
      this._paintedKey = key;
      this._paintTitle(status);
      this._paintStatus(status);
      this._paintBadge(count, badgeBackground);
      return;
    }

    if (this._paintedKey === key) return;
    this._paintedKey = key;
    this._paintTitle(status);
    if (status?.message) paintThreadStatusText(/** @type {HTMLElement} */ (this._status), status);
    this._paintBadge(count, badgeBackground);
  }

  /**
   * Write the composition summary into the title row. Plain text: the summary
   * is built from manifest names and counts, never from model output, so there
   * is nothing to render as markdown.
   * @param {import('../utils/thread-display.js').ThreadStatus|null} status - Current classification.
   * @private
   */
  _paintTitle(status) {
    const text = status?.goal || '';
    if (this._title && this._title.textContent !== text) this._title.textContent = text;
  }

  /**
   * Paint the status line beneath the title, through the shared thread-status
   * painter so a paused group inherits the sub-thread tile's approval highlight.
   * The painter never renders the goal, which the title row above already
   * carries, so this block is only ever the one status line.
   *
   * A run with nothing to report leaves the block empty AND classless, so it
   * contributes no box, padding or column gap of its own.
   * @param {import('../utils/thread-display.js').ThreadStatus|null} status - Current classification.
   * @private
   */
  _paintStatus(status) {
    const el = /** @type {HTMLElement} */ (this._status);
    if (!el) return;
    if (!status?.message) {
      el.replaceChildren();
      el.className = '';
      delete el.dataset.kind;
      return;
    }
    paintThreadSummary(el, '', { status });
  }

  /**
   * Keep the lozenge and its composition colours in step with the run.
   * @param {number} count - Number of members.
   * @param {string} background - Solid or proportional family background.
   * @private
   */
  _paintBadge(count, background) {
    const text = `${count} tools`;
    if (this._badge && this._badge.textContent !== text) this._badge.textContent = text;
    for (const element of [this._icon, this._badge]) {
      if (element && element.style.background !== background) element.style.background = background;
    }
  }
}

customElements.define('tool-group-message', ToolGroupMessage);
