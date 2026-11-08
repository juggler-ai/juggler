//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A file browser: a folder as a tree, with what each entry is and a pane that
 * shows whichever one is selected. The Project files pin is one of these rooted
 * at the project; a pinned folder is one rooted at that folder.
 *
 * **Reading.** One directory is read when it is opened, never before — a
 * project is a great many files, and a tree that read them all to draw its first
 * ten rows would pay for the whole repository to show the top of it. Each read
 * asks for detail (size, modified, permissions, link target, ignored), so a row
 * says what it is without being opened. Everything on disk is listed; hidden
 * and ignored entries are dimmed, and hiding them is a toggle here rather than a
 * decision the server made.
 *
 * **Selecting.** One click on a file shows it in the preview pane — the viewer
 * the File pin would use, so an image is an image and a page is a page — and one
 * on a folder opens or closes it. The arrows move the selection and the preview
 * follows. A double-click or Return pins a file as a tab of its own; ⌘/Ctrl-click
 * hands it to its application. Everything else a path offers is on the
 * preview's header, where the buttons are always in the same place, and on the
 * app's right-click menu, which every row answers because it carries
 * `data-file-path`.
 *
 * **Keeping its place.** What should survive a reload — open folders, sort,
 * whether hidden files and the preview are shown, where the divider is — is
 * written to the pin's config as it changes, in place, so the write does not
 * rebuild the browser it describes. What changes on every scroll tick — the
 * scroll, the selection, the file being previewed, the filter — comes back
 * through the board's view state when the pin is mounted again.
 * @module lib/file-browser
 */

// A browser belongs to a pin, and a pin to the project's board: it has no
// conversation, hence no workspace, to scope by.
// eslint-disable-next-line no-restricted-imports
import { expandDirectory, glob, openPath } from 'juggler/ops';
import { translator, formatDate, formatNumber, formatRelativeTime } from 'juggler/i18n';
import { formatFileSizeForDisplay } from 'juggler/item-utils';
import { canPinSource, createElement, createFileActions, errorText, injectStylesOnce, pinSource } from 'juggler/ui';
import { debounce } from 'juggler/utils/debounce';
import { reconcileRows, setText } from './reconcile.js';
import { fetchLiveFile, renderLiveFileBody } from './live-file.js';
import { KIND_LABELS, fileIconSvg, fileKind } from './file-kinds.js';

const t = translator('@juggler/core');

// One colour per kind, drawn in currentColor, and the page tinted with it.
injectStylesOnce('file-browser-icon-styles', `
.file-icon {
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.1;
  color: var(--text-tertiary);
}

.file-icon__page {
  fill: color-mix(in srgb, currentcolor 14%, transparent);
}

.file-icon__solid {
  fill: currentcolor;
  stroke: none;
}

.file-icon__faint {
  opacity: 0.7;
}

.file-icon[data-kind="dir"] {
  color: color-mix(in srgb, var(--accent-blue) 70%, var(--text-tertiary));
}

.file-icon[data-kind="code"] {
  color: var(--accent-blue);
}

.file-icon[data-kind="web"],
.file-icon[data-kind="archive"] {
  color: var(--accent-orange);
}

.file-icon[data-kind="doc"] {
  color: var(--accent-purple);
}

.file-icon[data-kind="data"] {
  color: var(--accent-yellow);
}

.file-icon[data-kind="image"],
.file-icon[data-kind="media"] {
  color: var(--accent-green);
}

.file-icon[data-kind="script"],
.file-icon[data-kind="program"] {
  color: var(--accent-red);
}
`);
injectStylesOnce('file-browser-styles', `
.file-browser {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.file-browser__bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.25rem;
  padding-bottom: 0.375rem;
}

.file-browser__filter {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 16rem;
  height: 1.625rem;
  padding: 0 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
}

.file-browser__bar-spacer {
  flex: 1 1 0;
}

.file-browser__tool {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 1.625rem;
  height: 1.625rem;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
}

.file-browser__tool:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-primary);
}

.file-browser__tool[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
  color: var(--accent-text);
}

.file-browser__tool svg {
  width: 0.9375rem;
  height: 0.9375rem;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.4;
}

.file-browser__split {
  --fb-split: 0.55;

  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.file-browser__tree {
  display: flex;
  flex: 0 0 calc(var(--fb-split) * 100%);
  flex-direction: column;
  min-width: 0;
  min-height: 4rem;
}

.file-browser.is-preview-off .file-browser__tree {
  flex: 1 1 auto;
}

.file-browser.is-preview-off .file-browser__divider,
.file-browser.is-preview-off .file-browser__preview {
  display: none;
}

.file-browser__head,
.file-browser__row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-right: 0.375rem;
}

.file-browser__head {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  font-size: var(--font-size-2xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.file-browser__sort {
  padding: 0.125rem 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
}

.file-browser__sort:hover {
  color: var(--text-primary);
}

.file-browser__sort[data-sorted]::after {
  content: " \\2193";
}

.file-browser__sort[data-sorted="asc"]::after {
  content: " \\2191";
}

.file-browser__head .file-browser__name-cell {
  padding-left: 0.5rem;
  text-align: left;
}

.file-browser__list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  padding: 0.125rem 0;
  overflow: auto;
}

.file-browser__row {
  flex-shrink: 0;
  min-height: 1.5rem;
  border-radius: var(--radius-md);
  line-height: 1.5;
  cursor: default;
  user-select: none;
}

.file-browser__row:hover {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
}

.file-browser__row[aria-selected="true"] {
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
}

.file-browser__list:focus-within .file-browser__row[aria-selected="true"] {
  background: color-mix(in srgb, var(--accent-blue) 26%, transparent);
}

.file-browser__row:focus-visible {
  outline-offset: calc(-1 * var(--focus-ring-width));
}

.file-browser__name-cell {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.3125rem;
  min-width: 0;
}

/* Drawn rather than written: a glyph would be at the mercy of whichever font the
   platform has. A file keeps the space so names a level down line up. */
.file-browser__caret {
  flex-shrink: 0;
  width: 0.4375rem;
  height: 0.4375rem;
  background: var(--text-tertiary);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  transition: transform var(--transition-base, 0.15s ease);
  visibility: hidden;
}

.file-browser__row.is-dir .file-browser__caret {
  visibility: visible;
}

.file-browser__row[aria-expanded="true"] .file-browser__caret {
  transform: rotate(90deg);
}

.file-browser__icon {
  display: flex;
  flex-shrink: 0;
}

.file-browser__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-browser__name mark {
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-yellow) 35%, transparent);
  color: inherit;
}

.file-browser__row.is-dir .file-browser__name {
  font-weight: var(--font-weight-medium);
}

.file-browser__row.is-link .file-browser__name {
  font-style: italic;
}

.file-browser__row.is-hidden .file-browser__name-cell,
.file-browser__row.is-ignored .file-browser__name-cell {
  opacity: 0.55;
}

.file-browser__where {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-browser__git {
  flex: 0 0 1rem;
  color: var(--accent-orange);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  text-align: center;
}

.file-browser__git[data-git="A"],
.file-browser__git[data-git="U"] {
  color: var(--accent-green);
}

.file-browser__git[data-git="D"],
.file-browser__git[data-git="!"] {
  color: var(--accent-red);
}

.file-browser__size,
.file-browser__modified {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.file-browser__size {
  flex: 0 0 4.5rem;
  text-align: right;
}

.file-browser__modified {
  flex: 0 0 5.75rem;
  text-align: right;
}

.file-browser__modified.is-recent {
  color: var(--accent-green);
}

/* Narrow boards keep the name and the size, which tells a file from a folder at
   a glance; when and the column headings come back as the board widens. */
@container (width < 22rem) {
  .file-browser__modified,
  .file-browser__head {
    display: none;
  }
}

.file-browser__row.is-changed {
  animation: file-browser-changed 1.6s ease-out;
}

@keyframes file-browser-changed {
  from { background: color-mix(in srgb, var(--accent-green) 30%, transparent); }
  to { background: transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .file-browser__row.is-changed {
    animation: none;
  }
}

.file-browser__note {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  line-height: 1.7;
}

.file-browser__foot,
.file-browser__status {
  flex-shrink: 0;
  padding: 0.125rem 0.375rem;
  color: var(--text-tertiary);
  font-size: var(--font-size-2xs);
}

.file-browser__status {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.file-browser__divider {
  position: relative;
  flex: 0 0 0.375rem;
  cursor: row-resize;
  touch-action: none;
}

.file-browser__divider::after {
  position: absolute;
  inset: 0.125rem 0;
  border-top: 1px solid var(--border-divider);
  content: "";
}

.file-browser__preview {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.file-browser__preview-head {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.25rem 0.125rem 0.375rem;
}

.file-browser__preview-head .file-icon {
  width: 1.25rem;
  height: 1.25rem;
}

.file-browser__preview-title {
  flex: 1 1 auto;
  min-width: 0;
}

.file-browser__preview-name {
  overflow: hidden;
  font-weight: var(--font-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-browser__preview-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.625rem;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
}

.file-browser__preview-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.125rem;
}

.file-browser__pin {
  height: 1.5rem;
  padding: 0 0.625rem;
  border: 1px solid var(--accent-blue);
  border-radius: var(--radius-md);
  background: var(--accent-blue);
  color: var(--text-on-accent);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.file-browser__pin:hover {
  filter: brightness(1.1);
}

.file-browser__preview-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.file-browser__placeholder {
  padding: 1rem;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  text-align: center;
}

.file-browser__summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
  padding: 0.5rem 0.25rem;
  font-size: var(--font-size-sm);
}

.file-browser__summary dt {
  color: var(--text-tertiary);
}

.file-browser__summary dd {
  margin: 0;
}

/* Wide enough for both side by side, the preview goes beside the tree. */
@container (width >= 40rem) {
  .file-browser__split {
    flex-direction: row;
  }

  .file-browser__tree {
    min-width: 12rem;
    min-height: 0;
  }

  .file-browser__divider {
    cursor: col-resize;
  }

  .file-browser__divider::after {
    inset: 0 0.125rem;
    border-top: none;
    border-left: 1px solid var(--border-divider);
  }
}
`);

/** How long a burst of file changes may take to finish before re-reading. */
const REFRESH_DEBOUNCE_MS = 150;

/** The longest a burst may hold the re-reads off, so a build is followed a second behind. */
const REFRESH_MAX_WAIT_MS = 1000;

/**
 * How long a folder may take to open before the tree admits it is reading. A
 * local directory comes back in about a millisecond, and a row saying so for
 * one frame is a flicker that moves every row beneath it twice.
 */
const LOADING_GRACE_MS = 200;

/** How long the arrow keys may rest on a row before its preview is read. */
const PREVIEW_SETTLE_MS = 120;

/** How long a row the watcher saw change stays marked as changed. */
const CHANGED_MARK_MS = 1600;

/** How recent a change is to be shown as recent: about as long as a turn. */
const RECENT_MS = 5 * 60 * 1000;

/** How many filter matches are drawn. More is a list nobody reads; type more. */
const FILTER_LIMIT = 200;

/** How far each level is indented, in rem. */
const INDENT_REM = 0.875;

/** The divider's resting place, as the tree's share of the split. */
const DEFAULT_SPLIT = 0.55;

/** The columns a tree can be sorted by. */
const SORT_KEYS = ['name', 'size', 'modified'];

/** The toolbar's glyphs, in the stroke style of the app's own icons. */
const ICONS = {
  hidden: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>',
  collapse: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 3 3 3-3M5 13l3-3 3 3"/></svg>',
  preview: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 9h12"/></svg>',
};

/**
 * One directory entry, as the browser draws it.
 * @typedef {object} Entry
 * @property {string} name - Its last segment.
 * @property {string} path - Absolute, in the root's spelling.
 * @property {boolean} isDir - Whether it opens like a folder (a link to one does).
 * @property {import('./file-kinds.js').FileKind} kind - What it is, for its icon.
 * @property {number|null} size - Bytes, for a file.
 * @property {number|null} modified - Unix ms.
 * @property {string} mode - Permissions, e.g. 'rw-r--r--'.
 * @property {boolean} hidden - A dot-file.
 * @property {boolean} ignored - Gitignored.
 * @property {boolean} link - A symbolic link.
 * @property {string} target - Where a link points.
 * @property {number|null} entries - How many entries a folder holds.
 * @property {boolean} more - It holds more than `entries`.
 * @property {string} [where] - For a filter match: the folder it is in, relative to the root.
 */

/**
 * One line of the flattened tree. A directory that is open but has nothing to
 * show contributes a `note` row, so an empty folder and one still being read
 * are told apart.
 * @typedef {object} TreeRow
 * @property {'item'|'note'} kind - Whether it stands for a path or speaks for one.
 * @property {string} key - Its identity in the list.
 * @property {number} depth - Levels below the root.
 * @property {Entry} [entry] - The entry, for an item row.
 * @property {string} [text] - What it says, for a note row.
 */

/**
 * What one directory read came back with.
 * @typedef {object} DirState
 * @property {Entry[]|null} items - Its contents, or null before a read lands or when it failed.
 * @property {string} error - Why there are no contents, or ''.
 * @property {boolean} loading - Whether a read is in flight.
 * @property {boolean} slow - Whether that read has been going long enough to say so.
 * @property {symbol|null} token - The read whose answer this entry will accept.
 */

/**
 * What the browser keeps in its pin's config. Only what differs from the
 * default is written, so a browser nobody has rearranged stores its open
 * folders and nothing else.
 * @typedef {object} BrowserConfig
 * @property {string[]} expanded - Open folders, relative to the root, forward-slashed.
 * @property {boolean} [hideHidden] - Hidden and ignored entries are left out.
 * @property {boolean} [preview] - False when the preview pane is closed.
 * @property {number} [split] - The tree's share of the split, 0.15–0.85.
 * @property {'size'|'modified'} [sort] - The column sorted by, when not the name.
 * @property {boolean} [desc] - Sorted in descending order.
 */

/**
 * Where the reader was, handed back through the board's view state.
 * @typedef {object} BrowserViewState
 * @property {number} [scrollTop] - The tree's scroll.
 * @property {string} [active] - The row the keyboard is on.
 * @property {string} [preview] - The entry being previewed.
 * @property {number} [previewScrollTop] - The preview's scroll.
 * @property {string} [filter] - What was typed in the filter.
 */

/**
 * @typedef {object} FileBrowserOptions
 * @property {string} root - The absolute directory to show.
 * @property {Record<string, unknown>} [config] - The stored config; the browser's
 *   fields are read out of it (see {@link normalizeBrowserConfig}).
 * @property {unknown} [viewState] - What {@link FileBrowser.saveViewState} last returned.
 * @property {(config: BrowserConfig) => void} persist - Write the browser's config
 *   down. Called as it changes; the caller merges it into the pin's own.
 * @property {() => import('juggler/pinboard-item-type').PinContext} context - The
 *   pin's current context, for its services, its signal and the active snapshot.
 * @property {boolean} [userInitiated] - The user named this folder, so it may be
 *   outside the project.
 * @property {string} [label] - What the tree is called to assistive technology.
 */

/**
 * @typedef {object} FileBrowser
 * @property {HTMLElement} element - The browser, to put in the pin's body.
 * @property {(root: string) => void} setRoot - Show a different folder, from the top.
 * @property {() => void} refresh - Read every folder on screen again, and the preview.
 * @property {() => void} focus - Put focus on the row the keyboard is on.
 * @property {() => BrowserViewState} saveViewState - Where the reader is, for the board to keep.
 * @property {() => void} teardown - Stop listening and reading.
 */

/**
 * The separator a path is spelled with. `expandDirectory` forward-slashes what it
 * returns, which would give a Windows child a different spelling from its
 * parent — and these paths are compared with the watcher's and handed to the OS,
 * so one spelling has to win. The root's is the one that does.
 * @param {string} path - Any path.
 * @returns {string} '\\' on a Windows-style path, '/' otherwise.
 */
function separator(path) {
  return path.includes('\\') ? '\\' : '/';
}

/**
 * @param {string} dir - The parent directory.
 * @param {string} name - A child's name, or a forward-slashed relative path.
 * @returns {string} The child's absolute path, in the parent's spelling.
 */
function childPath(dir, name) {
  const sep = separator(dir);
  const rest = sep === '/' ? name : name.replace(/\//g, sep);
  return dir.endsWith(sep) ? `${dir}${rest}` : `${dir}${sep}${rest}`;
}

/**
 * @param {string} path - Any path.
 * @returns {string} The directory holding it, or '' when it has no parent here.
 */
function parentDir(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? '' : path.slice(0, at);
}

/**
 * One remembered folder, as it is written down: relative to the root and
 * forward-slashed, whatever the platform spells paths with — the board outlives
 * the path, and a checkout moved elsewhere is the same tree to its reader.
 * @param {any} value - A stored entry, of no trustworthy type.
 * @returns {string} The cleaned relative path, or '' if it is not usable as one.
 */
function cleanRelative(value) {
  if (typeof value !== 'string') return '';
  const parts = value.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  // A remembered folder is somewhere inside the root. One that climbs out of it
  // is not one this browser ever offered, so it is dropped rather than resolved.
  if (parts.length === 0 || parts.includes('..')) return '';
  return parts.join('/');
}

/**
 * The browser's half of a stored config, read as a stranger wrote it: anything
 * unusable is dropped and the rest kept, never thrown for. Sorted, so two boards
 * in the same state hold the same config.
 * @param {Record<string, unknown>|null|undefined} config - A stored config.
 * @returns {BrowserConfig} Its browser fields, cleaned.
 */
export function normalizeBrowserConfig(config) {
  const stored = Array.isArray(config?.expanded) ? config.expanded : [];
  /** @type {BrowserConfig} */
  const clean = { expanded: [...new Set(stored.map(cleanRelative).filter(Boolean))].sort() };
  if (config?.hideHidden === true) clean.hideHidden = true;
  if (config?.preview === false) clean.preview = false;
  const split = Number(config?.split);
  if (Number.isFinite(split) && split !== DEFAULT_SPLIT && split >= 0.15 && split <= 0.85) {
    clean.split = Math.round(split * 100) / 100;
  }
  if (config?.sort === 'size' || config?.sort === 'modified') clean.sort = config.sort;
  if (config?.desc === true) clean.desc = true;
  return clean;
}

/** The config fields that are the browser's, as opposed to its pin's. */
const BROWSER_KEYS = ['expanded', 'hideHidden', 'preview', 'split', 'sort', 'desc'];

/**
 * The browser's fields of a pin config that may not have any — a File pin of a
 * file never does — cleaned, or nothing at all when there are none, so a pin
 * that never showed a browser does not acquire an empty one in its config.
 * @param {Record<string, unknown>|null|undefined} config - A stored config.
 * @returns {Partial<BrowserConfig>} The browser's fields, or {}.
 */
export function browserFieldsOf(config) {
  if (!config || !BROWSER_KEYS.some((key) => key in config)) return {};
  return normalizeBrowserConfig(config);
}

/**
 * A pin's config with the browser's half replaced: whatever of the old half
 * the new one leaves out is gone, not kept from before.
 * @param {Record<string, unknown>} config - The pin's config.
 * @param {BrowserConfig} browser - What the browser wrote.
 * @returns {Record<string, unknown>} The config to store.
 */
export function withBrowserConfig(config, browser) {
  const rest = Object.fromEntries(Object.entries(config || {}).filter(([key]) => !BROWSER_KEYS.includes(key)));
  return { ...rest, ...browser };
}

/**
 * A directory read's entry, from the op's item. The op names a child relative
 * to whatever was asked for, so the absolute path is built here, in the root's
 * spelling, rather than trusted.
 * @param {any} item - One of `expandDirectory`'s items.
 * @param {string} dir - The absolute directory it is in.
 * @returns {Entry} The entry.
 */
function toEntry(item, dir) {
  const name = String(item?.name ?? '');
  const linkDir = item?.linkDir === true;
  const isDir = item?.isDir === true || linkDir;
  return {
    name,
    path: childPath(dir, name),
    isDir,
    kind: fileKind(name, { isDir, kind: item?.kind, executable: item?.executable === true }),
    size: typeof item?.size === 'number' ? item.size : null,
    modified: typeof item?.modified === 'number' ? item.modified : null,
    mode: typeof item?.mode === 'string' ? item.mode : '',
    hidden: item?.hidden === true || name.startsWith('.'),
    ignored: item?.ignored === true,
    link: item?.kind === 'symlink',
    target: typeof item?.target === 'string' ? item.target : '',
    entries: typeof item?.entries === 'number' ? item.entries : null,
    more: item?.entriesTruncated === true,
  };
}

/**
 * A glob that matches `query` anywhere in a file's name, whatever its case.
 * The glob op is case-sensitive, so each letter becomes a class of both cases,
 * and anything the glob syntax would read is escaped.
 * @param {string} query - What was typed.
 * @returns {string} The pattern.
 */
function filterPattern(query) {
  const body = [...query].map((ch) => {
    if (/[*?[\]{}\\!]/.test(ch)) return `\\${ch}`;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    return lower === upper ? ch : `[${lower}${upper}]`;
  }).join('');
  return `**/*${body}*`;
}

/**
 * When something was last changed, in the fewest words that still say it.
 * @param {number|null} ms - Unix ms.
 * @returns {string} "3 min. ago", "yesterday", "12 Mar", or '' for unknown.
 */
function ageText(ms) {
  if (typeof ms !== 'number') return '';
  const ago = Date.now() - ms;
  if (ago < 45_000) return t('just now');
  const minutes = Math.round(ago / 60_000);
  if (minutes < 60) return formatRelativeTime(-minutes, 'minute', { style: 'short' });
  const hours = Math.round(ago / 3_600_000);
  if (hours < 24) return formatRelativeTime(-hours, 'hour', { style: 'short' });
  const days = Math.round(ago / 86_400_000);
  if (days < 7) return formatRelativeTime(-days, 'day', { numeric: 'auto', style: 'short' });
  const date = new Date(ms);
  return formatDate(date, date.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * @param {number|null} ms - Unix ms.
 * @returns {string} The whole date and time, for a tooltip; '' for unknown.
 */
function fullDate(ms) {
  return typeof ms === 'number'
    ? formatDate(new Date(ms), { dateStyle: 'medium', timeStyle: 'short' })
    : '';
}

/**
 * What the size column says: a file's size, or how much a folder holds — so a
 * folder and a file never read alike in it.
 * @param {Entry} entry - The entry.
 * @returns {string} The words, or '' when unknown.
 */
function sizeText(entry) {
  if (entry.isDir) {
    if (entry.entries === null) return '';
    return entry.more
      ? t('{count}+ items', { count: formatNumber(entry.entries) })
      : t('{count, plural, one {{count} item} other {{count} items}}', { count: entry.entries });
  }
  return entry.size === null ? '' : formatFileSizeForDisplay(entry.size);
}

/**
 * What a git status letter means, for the preview's header.
 * @param {string} letter - The letter the row shows.
 * @returns {string} The word.
 */
function gitWord(letter) {
  switch (letter) {
    case 'M': return t('Modified');
    case 'A': return t('Added');
    case 'D': return t('Deleted');
    case 'R': return t('Renamed');
    case 'U': return t('Untracked');
    case '!': return t('Conflicted');
    default: return t('Changed');
  }
}

/**
 * Write an attribute only when it differs. Pass null to remove it.
 * @param {HTMLElement} el - The element.
 * @param {string} name - The attribute.
 * @param {string|null} value - What it should be, or null for absent.
 * @returns {void}
 */
function setAttr(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * A toolbar button.
 * @param {string} act - What it does, as `data-act`.
 * @param {string} icon - Its glyph.
 * @param {string} label - What it is called.
 * @param {boolean|null} pressed - Its toggle state, or null for a plain button.
 * @returns {HTMLButtonElement} The button.
 */
function toolButton(act, icon, label, pressed) {
  const button = /** @type {HTMLButtonElement} */ (createElement('button', 'file-browser__tool'));
  button.type = 'button';
  button.dataset.act = act;
  button.title = label;
  button.setAttribute('aria-label', label);
  if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
  button.innerHTML = icon;
  return button;
}

/**
 * Build a file browser into a fresh element.
 * @param {FileBrowserOptions} options - What to show and how to keep it.
 * @returns {FileBrowser} The browser.
 */
export function createFileBrowser(options) {
  const context = options.context;
  const userInitiated = options.userInitiated === true;
  let root = options.root;
  const signal = context().signal;

  const stored = normalizeBrowserConfig(options.config);
  let hideHidden = stored.hideHidden === true;
  let previewOn = stored.preview !== false;
  let split = stored.split ?? DEFAULT_SPLIT;
  /** @type {string} */
  let sortKey = stored.sort ?? 'name';
  let desc = stored.desc === true;

  const element = createElement('div', 'file-browser');
  const bar = createElement('div', 'file-browser__bar');
  const filterInput = /** @type {HTMLInputElement} */ (createElement('input', 'file-browser__filter'));
  filterInput.type = 'search';
  filterInput.placeholder = t('Filter');
  filterInput.setAttribute('aria-label', t('Filter files by name'));
  filterInput.spellcheck = false;
  const hiddenTool = toolButton('hidden', ICONS.hidden, t('Hide hidden and ignored files'), hideHidden);
  const collapseTool = toolButton('collapse', ICONS.collapse, t('Close every folder'), null);
  const previewTool = toolButton('preview', ICONS.preview, t('Show the preview pane (Space)'), previewOn);
  bar.append(filterInput, createElement('span', 'file-browser__bar-spacer'), hiddenTool, collapseTool, previewTool);

  const splitBox = createElement('div', 'file-browser__split');
  const tree = createElement('div', 'file-browser__tree');
  const head = createElement('div', 'file-browser__head');
  const list = createElement('div', 'file-browser__list');
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', options.label || t('Files'));
  const foot = createElement('div', 'file-browser__foot');
  const status = createElement('div', 'file-browser__status');
  status.setAttribute('role', 'status');
  tree.append(head, list, foot);
  const divider = createElement('div', 'file-browser__divider');
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', t('Resize the preview'));
  const preview = createElement('div', 'file-browser__preview');
  const previewHead = createElement('div', 'file-browser__preview-head');
  const previewBody = createElement('div', 'file-browser__preview-body');
  preview.append(previewHead, previewBody);
  splitBox.append(tree, divider, preview);
  element.append(bar, splitBox);

  /**
   * Which directories are open, by absolute path.
   * @type {Set<string>}
   */
  const expanded = new Set(stored.expanded.map((relative) => childPath(root, relative)));
  /** @type {Map<string, DirState>} */
  const entries = new Map();
  /**
   * Every entry drawn or matched, by path, for the preview and the clicks.
   * @type {Map<string, Entry>}
   */
  const known = new Map();
  /** @type {TreeRow[]} */
  let rows = [];
  /** The row the arrow keys are on, by path. */
  let activePath = '';
  /** The entry the preview shows, by path. */
  let previewPath = '';
  /** The last thing that went wrong where there was no row to say so on. */
  let statusText = '';
  /** Bumped when every read in flight is answering a question nobody is asking. */
  let generation = 0;
  /** Directory reads not yet landed — the view state waits for the tree it describes. */
  let inFlight = 0;
  /** @type {Set<string>} */
  const pendingDirs = new Set();
  /**
   * Rows the watcher saw change, until when they say so.
   * @type {Map<string, number>}
   */
  const changed = new Map();
  /**
   * Git's letter for each changed file, and every folder above one.
   * @type {Map<string, string>}
   */
  const gitLetters = new Map();
  /** @type {Set<string>} */
  const gitDirs = new Set();
  /** @type {{query: string, items: Entry[]|null, error: string, more: boolean}|null} */
  let filter = null;
  let filterToken = 0;
  let previewToken = 0;
  let previewDirty = false;
  let tornDown = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let changedTimer = null;

  /** @type {BrowserViewState|null} Where to put the reader back, once the tree is there. */
  let pendingView = options.viewState && typeof options.viewState === 'object'
    ? /** @type {BrowserViewState} */ (options.viewState)
    : null;

  const live = () => !tornDown && !signal.aborted;

  /**
   * @param {string} absolute - A folder on screen.
   * @returns {string} How to write it down, or '' if it is not under the root.
   */
  const toRelative = (absolute) => {
    const sep = separator(root);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return absolute.startsWith(prefix) ? cleanRelative(absolute.slice(prefix.length)) : '';
  };

  /**
   * Write down how the reader has arranged the browser. Written the moment it
   * changes and never debounced: switching tabs tears the pin down, so any wait
   * is a window in which the last thing done is the one thing that does not
   * come back.
   * @returns {void}
   */
  const persist = () => {
    /** @type {BrowserConfig} */
    const config = { expanded: [...expanded].map(toRelative).filter(Boolean).sort() };
    if (hideHidden) config.hideHidden = true;
    if (!previewOn) config.preview = false;
    if (split !== DEFAULT_SPLIT) config.split = split;
    if (sortKey === 'size' || sortKey === 'modified') config.sort = sortKey;
    if (desc) config.desc = true;
    options.persist(config);
  };

  /**
   * A directory's contents in the order the tree shows them: folders first,
   * then files, each by the chosen column.
   * @param {Entry[]} items - The entries.
   * @returns {Entry[]} Sorted, and without what is hidden.
   */
  const arrange = (items) => {
    const shown = hideHidden ? items.filter((item) => !item.hidden && !item.ignored) : items.slice();
    const sign = desc ? -1 : 1;
    /**
     * @param {Entry} entry - An entry.
     * @returns {number} Its value in the sorted column.
     */
    const measure = (entry) => (sortKey === 'size'
      ? (entry.isDir ? (entry.entries ?? -1) : (entry.size ?? -1))
      : (entry.modified ?? 0));
    return shown.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const byKey = sortKey === 'name' ? 0 : measure(a) - measure(b);
      return sign * (byKey || a.name.localeCompare(b.name));
    });
  };

  /**
   * The open tree, flattened into the lines it draws as — or, while a filter is
   * typed, its matches. Flat on purpose: the list is reconciled by key, and the
   * arrow keys walk an array.
   * @returns {TreeRow[]} The visible lines, in order.
   */
  const visibleRows = () => {
    /** @type {TreeRow[]} */
    const out = [];
    if (filter) {
      if (filter.error) out.push({ kind: 'note', key: '\u0000filter-error', depth: 0, text: filter.error });
      else if (!filter.items) out.push({ kind: 'note', key: '\u0000filter-loading', depth: 0, text: t('Searching…') });
      else if (filter.items.length === 0) out.push({ kind: 'note', key: '\u0000filter-none', depth: 0, text: t('Nothing matches.') });
      for (const entry of filter.items || []) {
        if (hideHidden && entry.hidden) continue;
        out.push({ kind: 'item', key: `\u0000match\u0000${entry.path}`, depth: 0, entry });
      }
      return out;
    }
    /**
     * @param {string} dir - The directory to lay out.
     * @param {number} depth - Its children's depth.
     */
    const walk = (dir, depth) => {
      const state = entries.get(dir);
      if (!state) return;
      // Keyed with the directory, so two folders reading at once do not share a
      // row, and with a NUL, so a key can never collide with a real path.
      if (state.error) {
        out.push({ kind: 'note', key: `${dir}\u0000error`, depth, text: state.error });
        return;
      }
      if (!state.items) {
        if (state.slow) out.push({ kind: 'note', key: `${dir}\u0000loading`, depth, text: t('Reading…') });
        return;
      }
      const items = arrange(state.items);
      if (items.length === 0) {
        out.push({ kind: 'note', key: `${dir}\u0000empty`, depth, text: t('Empty') });
        return;
      }
      for (const entry of items) {
        out.push({ kind: 'item', key: entry.path, depth, entry });
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  };

  /**
   * Read one directory, and draw whatever came back. An answer is discarded if
   * the whole tree was refreshed since (`generation`) or this directory was
   * asked again (`token`) — which a change under an open folder does readily.
   * @param {string} dir - The absolute directory.
   * @param {boolean} [watched] - Read because the watcher saw it change, so
   *   whatever differs is marked as just changed.
   * @returns {Promise<void>} When it has been drawn, or discarded.
   */
  const readDirectory = async (dir, watched = false) => {
    const gen = generation;
    const token = Symbol('read');
    const previous = entries.get(dir);
    entries.set(dir, {
      items: previous?.items ?? null,
      error: previous?.error ?? '',
      loading: true,
      slow: false,
      token,
    });
    inFlight++;

    // Only a read that outlasts the grace period ever says it is reading.
    const admit = setTimeout(() => {
      const state = entries.get(dir);
      if (gen !== generation || !live()) return;
      if (state?.token !== token || !state.loading) return;
      entries.set(dir, { ...state, slow: true });
      render();
    }, LOADING_GRACE_MS);

    /** @param {DirState} next - What the read settled on. */
    const settle = (next) => {
      clearTimeout(admit);
      inFlight--;
      if (gen !== generation || !live()) return;
      if (entries.get(dir)?.token !== token) return;
      if (watched && previous?.items && next.items) {
        const before = new Map(previous.items.map((item) => [item.path, item]));
        const until = Date.now() + CHANGED_MARK_MS;
        for (const item of next.items) {
          const was = before.get(item.path);
          if (!was || was.modified !== item.modified || was.size !== item.size) changed.set(item.path, until);
        }
        scheduleChangedSweep();
      }
      for (const item of next.items || []) known.set(item.path, item);
      entries.set(dir, next);
      render();
    };

    try {
      const result = await expandDirectory({ path: dir, detail: true, ...(userInitiated ? { userInitiated: true } : {}) });
      settle({
        items: (result?.items || []).map((/** @type {any} */ item) => toEntry(item, dir)),
        error: '',
        loading: false,
        slow: false,
        token,
      });
    } catch (err) {
      // The op's own words are the only account of which of the many reasons
      // this was, so the plain-English lead goes above them, never instead.
      settle({
        items: null,
        error: t("Couldn't read this folder. {error}", { error: errorText(err) }),
        loading: false,
        slow: false,
        token,
      });
    }
  };

  /** Take the just-changed mark off rows whose moment has passed. */
  const scheduleChangedSweep = () => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      const now = Date.now();
      for (const [path, until] of changed) if (until <= now) changed.delete(path);
      if (changed.size) scheduleChangedSweep();
      if (live()) render();
    }, CHANGED_MARK_MS);
  };

  /**
   * Read git's status into a letter per changed file and a mark on every folder
   * above one. The status is of the project — or the workspace the board is
   * looking at — and a browser of somewhere else simply finds nothing in it.
   * @returns {void}
   */
  const readGit = () => {
    gitLetters.clear();
    gitDirs.clear();
    const snapshot = context().services?.git?.status?.();
    if (!snapshot?.root) return;
    for (const repo of snapshot.repos || []) {
      const repoRoot = repo.path ? childPath(snapshot.root, repo.path) : snapshot.root;
      for (const file of repo.files || []) {
        const letter = file.conflicted
          ? '!'
          : file.worktree === '?'
            ? 'U'
            : (file.worktree && file.worktree !== '.' ? file.worktree : file.index);
        if (!letter || letter === '.') continue;
        const path = childPath(repoRoot, file.path);
        gitLetters.set(path, letter);
        for (let dir = parentDir(path); dir && !gitDirs.has(dir); dir = parentDir(dir)) gitDirs.add(dir);
      }
    }
  };

  /**
   * @param {string} path - The directory to open or close.
   * @returns {void}
   */
  const toggle = (path) => {
    if (!expanded.delete(path)) {
      expanded.add(path);
      if (!entries.has(path)) void readDirectory(path);
    }
    persist();
    render();
  };

  /**
   * Hand a file to the application the OS opens it with.
   * @param {string} path - The file.
   * @returns {Promise<void>} When it opened, or said why not.
   */
  const openFile = async (path) => {
    try {
      await openPath({ path });
      statusText = '';
    } catch (err) {
      statusText = t("Couldn't open that file. {error}", { error: errorText(err) });
    }
    if (live()) render();
  };

  /**
   * Pin an entry as a tab of its own: a file as a File pin, a folder as a
   * browser of that folder.
   * @param {Entry} entry - What to pin.
   * @returns {void}
   */
  const pinEntry = (entry) => {
    void pinSource(sourceFor(entry));
  };

  /**
   * @param {Entry} entry - An entry.
   * @returns {import('juggler/pinboard-item-type').PinSource} What pinning it asks the board for.
   */
  const sourceFor = (entry) => ({
    kind: 'file',
    path: entry.path,
    presentation: 'live',
    ...(entry.isDir ? { isDirectory: true } : {}),
  });

  /**
   * The row standing for a path right now, or null when it is not on screen.
   * @param {string} path - The path.
   * @returns {HTMLElement|null} Its row.
   */
  const rowFor = (path) => {
    for (const child of Array.from(list.children)) {
      const el = /** @type {HTMLElement} */ (child);
      if (el.dataset.filePath === path) return el;
    }
    return null;
  };

  /**
   * The fixed half of a row: everything true of it for as long as it stands for
   * that key.
   * @param {TreeRow} row - The line to build for.
   * @returns {HTMLElement} The row.
   */
  const build = (row) => {
    if (row.kind !== 'item') return createElement('div', 'file-browser__note');
    const el = createElement('div', 'file-browser__row');
    el.setAttribute('role', 'treeitem');
    el.tabIndex = -1;
    const name = createElement('span', 'file-browser__name-cell');
    const caret = createElement('span', 'file-browser__caret');
    caret.setAttribute('aria-hidden', 'true');
    name.append(caret, createElement('span', 'file-browser__icon'), createElement('span', 'file-browser__name'),
      createElement('span', 'file-browser__where'));
    el.append(name, createElement('span', 'file-browser__git'), createElement('span', 'file-browser__size'),
      createElement('span', 'file-browser__modified'));
    return el;
  };

  /**
   * Draw a filter match's name with the typed part marked.
   * @param {HTMLElement} target - The name element.
   * @param {string} name - The name.
   * @param {string} query - What was typed.
   */
  const drawMatch = (target, name, query) => {
    const at = name.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0 || !query) {
      setText(target, name);
      return;
    }
    const mark = document.createElement('mark');
    mark.textContent = name.slice(at, at + query.length);
    target.replaceChildren(name.slice(0, at), mark, name.slice(at + query.length));
  };

  /**
   * @param {HTMLElement} el - The row for this line.
   * @param {TreeRow} row - The line.
   * @returns {void}
   */
  const fill = (el, row) => {
    // Every write is guarded: a render can be provoked several times a second,
    // and an assignment that changes nothing still invalidates the row's style.
    if (row.kind !== 'item' || !row.entry) {
      setAttr(el, 'style', `padding-left: ${0.5 + row.depth * INDENT_REM}rem`);
      setText(el, row.text || '');
      return;
    }
    const entry = row.entry;
    const nameCell = /** @type {HTMLElement} */ (el.firstElementChild);
    setAttr(nameCell, 'style', `padding-left: ${0.375 + row.depth * INDENT_REM}rem`);
    const matching = !!filter;
    const open = entry.isDir && !matching && expanded.has(entry.path);
    if (el.dataset.filePath !== entry.path) el.dataset.filePath = entry.path;
    if (el.dataset.dir !== (entry.isDir ? '1' : '')) el.dataset.dir = entry.isDir ? '1' : '';
    el.classList.toggle('is-dir', entry.isDir);
    el.classList.toggle('is-link', entry.link);
    el.classList.toggle('is-hidden', entry.hidden);
    el.classList.toggle('is-ignored', entry.ignored);
    el.classList.toggle('is-changed', changed.has(entry.path));
    setAttr(el, 'aria-level', String(row.depth + 1));
    setAttr(el, 'aria-expanded', entry.isDir && !matching ? String(open) : null);
    setAttr(el, 'aria-selected', entry.path === previewPath ? 'true' : null);
    setAttr(el, 'title', entry.link && entry.target ? `${entry.path} → ${entry.target}` : entry.path);
    // One stop on the way in, not one per file: Tab reaches the tree, and the
    // arrows move within it.
    const tab = entry.path === activePath ? 0 : -1;
    if (el.tabIndex !== tab) el.tabIndex = tab;

    const icon = /** @type {HTMLElement} */ (nameCell.children[1]);
    const iconKey = `${entry.kind}${open ? ':open' : ''}`;
    if (icon.dataset.icon !== iconKey) {
      icon.dataset.icon = iconKey;
      icon.innerHTML = fileIconSvg(entry.kind, open);
    }
    const nameEl = /** @type {HTMLElement} */ (nameCell.children[2]);
    if (matching && filter) drawMatch(nameEl, entry.name, filter.query);
    else setText(nameEl, entry.name);
    setText(/** @type {HTMLElement} */ (nameCell.children[3]),
      matching ? (entry.where || '') : (entry.link && entry.target ? `→ ${entry.target}` : ''));

    const letter = gitLetters.get(entry.path) || (entry.isDir && gitDirs.has(entry.path) ? '•' : '');
    const git = /** @type {HTMLElement} */ (el.children[1]);
    setText(git, letter);
    setAttr(git, 'data-git', letter || null);
    setAttr(git, 'title', letter ? (letter === '•' ? t('Has changes inside') : gitWord(letter)) : null);

    setText(/** @type {HTMLElement} */ (el.children[2]), sizeText(entry));
    const modified = /** @type {HTMLElement} */ (el.children[3]);
    setText(modified, ageText(entry.modified));
    setAttr(modified, 'title', fullDate(entry.modified) || null);
    modified.classList.toggle('is-recent', entry.modified !== null && Date.now() - entry.modified < RECENT_MS);
  };

  /** The column headings, drawn once and marked with the sort. */
  const drawHead = () => {
    if (!head.firstChild) {
      const nameCell = createElement('span', 'file-browser__name-cell');
      const sortName = createElement('button', 'file-browser__sort', t('Name'));
      sortName.dataset.sort = 'name';
      nameCell.appendChild(sortName);
      const sortSize = createElement('button', 'file-browser__sort file-browser__size', t('Size'));
      sortSize.dataset.sort = 'size';
      const sortModified = createElement('button', 'file-browser__sort file-browser__modified', t('Modified'));
      sortModified.dataset.sort = 'modified';
      head.append(nameCell, createElement('span', 'file-browser__git'), sortSize, sortModified);
    }
    for (const button of Array.from(head.querySelectorAll('.file-browser__sort'))) {
      const el = /** @type {HTMLElement} */ (button);
      setAttr(el, 'data-sorted', el.dataset.sort === sortKey ? (desc ? 'desc' : 'asc') : null);
    }
  };

  const render = () => {
    rows = root ? visibleRows() : [];
    const items = rows.filter((row) => row.kind === 'item');
    for (const row of items) if (row.entry) known.set(row.entry.path, row.entry);
    applyPendingView(items);
    // The active row may have been closed away or deleted since it was set.
    if (!items.some((row) => row.entry?.path === activePath)) activePath = items[0]?.entry?.path || '';

    reconcileRows(list, rows, (row) => row.key, build, fill);
    drawHead();

    const top = entries.get(root)?.items;
    if (filter || !top) {
      setText(foot, filter?.items
        ? (filter.more
          ? t('The first {count} matches', { count: formatNumber(filter.items.length) })
          : t('{count, plural, one {{count} match} other {{count} matches}}', { count: filter.items.length }))
        : '');
    } else {
      const left = hideHidden ? top.filter((item) => item.hidden || item.ignored).length : 0;
      setText(foot, left
        ? t('{count, plural, one {{count} item} other {{count} items}}, {hidden} hidden',
          { count: top.length - left, hidden: formatNumber(left) })
        : t('{count, plural, one {{count} item} other {{count} items}}', { count: top.length }));
    }

    if (statusText) {
      setText(status, statusText);
      if (status.parentNode !== tree) tree.appendChild(status);
    } else {
      status.remove();
    }
    element.classList.toggle('is-preview-off', !previewOn);
    splitBox.style.setProperty('--fb-split', String(split));
  };

  /**
   * Put the reader back where they were, once the tree that held it has been
   * read again: the folders reopen first, and a selection or scroll applied
   * before them would land on rows that are not there yet.
   * @param {TreeRow[]} items - The item rows about to be drawn.
   */
  const applyPendingView = (items) => {
    if (!pendingView || inFlight > 0) return;
    const view = pendingView;
    pendingView = null;
    const has = (/** @type {unknown} */ path) => typeof path === 'string'
      && items.some((row) => row.entry?.path === path);
    if (has(view.active)) activePath = /** @type {string} */ (view.active);
    if (typeof view.preview === 'string' && view.preview && (has(view.preview) || known.has(view.preview))) {
      previewPath = view.preview;
      void showPreview(typeof view.previewScrollTop === 'number' ? view.previewScrollTop : 0);
    }
    if (typeof view.scrollTop === 'number') {
      const scrollTop = view.scrollTop;
      // After this render has drawn the rows it scrolls over.
      queueMicrotask(() => { list.scrollTop = scrollTop; });
    }
  };

  /**
   * Put the arrow keys on a row and focus it, scrolling only the list: the
   * board this sits in may be sliding in under a transform, and a plain focus
   * would scroll every ancestor to reveal the row, workspace included.
   * @param {string} path - The row to move to.
   * @returns {void}
   */
  const moveTo = (path) => {
    if (!path) return;
    activePath = path;
    for (const child of Array.from(list.children)) {
      const el = /** @type {HTMLElement} */ (child);
      if (el.classList.contains('file-browser__row')) el.tabIndex = el.dataset.filePath === path ? 0 : -1;
    }
    const row = rowFor(path);
    if (!row) return;
    row.focus({ preventScroll: true });
    const box = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < box.top) list.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
  };

  /**
   * Select a row: the keyboard moves onto it and the preview shows it.
   * @param {string} path - The row.
   * @param {boolean} now - Show it at once (a click), or once the keys rest.
   * @returns {void}
   */
  const select = (path, now) => {
    moveTo(path);
    if (previewPath === path) return;
    previewPath = path;
    for (const child of Array.from(list.children)) {
      const el = /** @type {HTMLElement} */ (child);
      if (el.classList.contains('file-browser__row')) setAttr(el, 'aria-selected', el.dataset.filePath === path ? 'true' : null);
    }
    if (now) {
      settlePreview.cancel();
      void showPreview(0);
    } else {
      settlePreview();
    }
  };

  /**
   * Draw the preview's header: what the entry is, and everything a path offers,
   * always in the same place.
   * @param {Entry} entry - The entry.
   */
  const drawPreviewHead = (entry) => {
    const icon = createElement('span', 'file-browser__icon');
    icon.innerHTML = fileIconSvg(entry.kind, false);
    const title = createElement('div', 'file-browser__preview-title');
    title.appendChild(createElement('div', 'file-browser__preview-name', entry.name));
    const meta = createElement('div', 'file-browser__preview-meta');
    const size = sizeText(entry);
    if (size) meta.appendChild(createElement('span', '', size));
    meta.appendChild(createElement('span', '', t(KIND_LABELS[entry.kind])));
    if (entry.modified !== null) {
      meta.appendChild(createElement('span', '', t('Modified {when}', { when: fullDate(entry.modified) })));
    }
    if (entry.mode) meta.appendChild(createElement('span', '', entry.mode));
    const letter = gitLetters.get(entry.path);
    if (letter) meta.appendChild(createElement('span', '', gitWord(letter)));
    if (entry.ignored) meta.appendChild(createElement('span', '', t('Ignored by git')));
    if (entry.link && entry.target) meta.appendChild(createElement('span', '', `→ ${entry.target}`));
    title.appendChild(meta);

    const actions = createElement('div', 'file-browser__preview-actions');
    const source = sourceFor(entry);
    if (canPinSource(source)) {
      const pin = /** @type {HTMLButtonElement} */ (createElement('button', 'file-browser__pin', t('Pin')));
      pin.type = 'button';
      pin.title = entry.isDir ? t('Pin this folder as a tab of its own') : t('Pin this file as a tab of its own (Return)');
      pin.addEventListener('click', () => pinEntry(entry));
      actions.appendChild(pin);
    }
    const shared = createFileActions(entry.path, { directory: entry.isDir });
    if (shared) actions.appendChild(shared);
    previewHead.replaceChildren(icon, title, actions);
  };

  /**
   * What a folder's preview says: what the listing knows of it, and how much
   * of it git is waiting on.
   * @param {Entry} entry - The folder.
   * @returns {HTMLElement} The summary.
   */
  const folderSummary = (entry) => {
    const summary = createElement('dl', 'file-browser__summary');
    /**
     * @param {string} term - The label.
     * @param {string} value - What it says.
     */
    const add = (term, value) => {
      if (!value) return;
      summary.append(createElement('dt', '', term), createElement('dd', '', value));
    };
    add(t('Contains'), sizeText(entry));
    add(t('Modified'), fullDate(entry.modified));
    add(t('Permissions'), entry.mode);
    const sep = separator(entry.path);
    const inside = [...gitLetters.keys()].filter((path) => path.startsWith(`${entry.path}${sep}`)).length;
    add(t('Git'), inside ? t('{count, plural, one {{count} changed file} other {{count} changed files}}', { count: inside }) : '');
    return summary;
  };

  /**
   * Show the selected entry in the preview: a folder's summary, or the file
   * through the viewer the File pin uses.
   * @param {number} scrollTop - Where to leave the preview scrolled.
   * @returns {Promise<void>} When it is drawn, or superseded.
   */
  const showPreview = async (scrollTop) => {
    const token = ++previewToken;
    previewDirty = false;
    const entry = previewPath ? known.get(previewPath) : null;
    if (!entry) {
      previewHead.replaceChildren();
      previewBody.replaceChildren(createElement('div', 'file-browser__placeholder',
        t('Select a file to see it here. Double-click or press Return to pin it as a tab.')));
      return;
    }
    drawPreviewHead(entry);
    if (entry.isDir) {
      previewBody.replaceChildren(folderSummary(entry));
      return;
    }
    if (!previewBody.firstChild || previewBody.dataset.path !== entry.path) {
      previewBody.replaceChildren(createElement('div', 'file-content-loading', t('Loading…')));
    }
    const result = await fetchLiveFile(entry.path, { signal, userInitiated });
    if (token !== previewToken || !live()) return;
    const project = context().active?.project?.path || '';
    const sep = separator(project);
    const relative = project && entry.path.startsWith(`${project}${sep}`)
      ? entry.path.slice(project.length + 1).replace(/\\/g, '/')
      : '';
    // A re-read of the same file keeps the reader's place in it.
    const keep = previewBody.dataset.path === entry.path ? previewBody.scrollTop : scrollTop;
    renderLiveFileBody(previewBody, result, {
      absolutePath: entry.path,
      conversationId: context().active?.conversation?.id,
      userInitiated,
      codeRefPath: relative || entry.path,
      codeRefAbsolute: !relative,
    });
    previewBody.dataset.path = entry.path;
    const shown = result.lineCount || 0;
    const total = result.totalLines || 0;
    if (result.exists && shown && total > shown) {
      previewBody.appendChild(createElement('div', 'file-browser__placeholder',
        t('The first {shown} of {total} lines. Pin it to see the whole file.',
          { shown: formatNumber(shown), total: formatNumber(total) })));
    }
    previewBody.scrollTop = keep;
  };

  const settlePreview = debounce(() => { if (live()) void showPreview(0); }, PREVIEW_SETTLE_MS);

  /**
   * Run the filter: every file under the root whose name holds what was typed,
   * newest first, from the server's walk of the tree rather than only the
   * folders that happen to be open.
   * @returns {Promise<void>} When the matches are drawn.
   */
  const runFilter = async () => {
    const query = filterInput.value.trim();
    const token = ++filterToken;
    if (!query) {
      filter = null;
      render();
      return;
    }
    filter = { query, items: filter?.query === query ? filter.items : null, error: '', more: false };
    render();
    try {
      const result = await glob({
        pattern: filterPattern(query),
        path: root,
        ...(userInitiated ? { userInitiated: true } : {}),
      }, signal);
      if (token !== filterToken || !live()) return;
      const sep = separator(root);
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      const files = /** @type {string[]} */ (result?.files || []);
      const items = files.slice(0, FILTER_LIMIT).map((file) => {
        const path = sep === '/' ? file : file.replace(/\//g, sep);
        const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
        const inRoot = path.startsWith(prefix) ? path.slice(prefix.length) : path;
        const where = parentDir(inRoot).replace(/\\/g, '/');
        /** @type {Entry} */
        const entry = known.get(path) || toEntry({ name }, parentDir(path) || root);
        return { ...entry, path, where, hidden: entry.hidden || /(^|[/\\])\./.test(inRoot) };
      });
      filter = { query, items, error: '', more: files.length > FILTER_LIMIT || result?.truncated === true };
    } catch (err) {
      if (token !== filterToken || !live()) return;
      filter = { query, items: null, error: t("Couldn't search this folder. {error}", { error: errorText(err) }), more: false };
    }
    render();
  };

  const filterSoon = debounce(() => { void runFilter(); }, REFRESH_DEBOUNCE_MS);

  /**
   * Walking the tree with the keyboard. ←/→ are claimed rather than left to the
   * board, which otherwise uses them between tabs: they are every tree's open
   * and close keys, and Escape still takes a reader back out to the board. A
   * modified key goes straight past, so the board's chord is untouched.
   * @param {KeyboardEvent} event - The press.
   * @returns {void}
   */
  const onKeydown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 && event.key !== ' ') {
      // Typing in a tree is looking for something: the filter takes the key
      // that was pressed, and the ones after it.
      filterInput.focus();
      return;
    }
    const items = rows.filter((row) => row.kind === 'item');
    if (items.length === 0) return;
    const at = Math.max(0, items.findIndex((row) => row.entry?.path === activePath));
    const current = items[at]?.entry;
    /**
     * @param {number} index - Where to go.
     * @returns {void}
     */
    const go = (index) => select(items[Math.max(0, Math.min(items.length - 1, index))]?.entry?.path || '', false);

    switch (event.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(items.length - 1);
        break;
      case 'ArrowRight':
        // Open it, then step into it: two presses to the first child.
        if (current?.isDir && !filter && !expanded.has(current.path)) toggle(current.path);
        else if (current?.isDir && !filter) go(at + 1);
        break;
      case 'ArrowLeft':
        // Close it, or leave it for whatever holds it.
        if (current?.isDir && !filter && expanded.has(current.path)) toggle(current.path);
        else if (current && !filter) {
          const up = items.findIndex((row) => row.entry?.path === parentDir(current.path));
          if (up >= 0) go(up);
        }
        break;
      case 'Enter':
        if (current?.isDir && !filter) toggle(current.path);
        else if (current) pinEntry(current);
        break;
      case ' ':
        setPreviewOn(!previewOn);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /**
   * @param {boolean} on - Whether the preview pane is shown.
   */
  const setPreviewOn = (on) => {
    previewOn = on;
    previewTool.setAttribute('aria-pressed', String(on));
    persist();
    render();
    if (on) void showPreview(0);
  };

  list.addEventListener('keydown', onKeydown);
  list.addEventListener('click', (event) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.file-browser__row'));
    const entry = row?.dataset.filePath ? known.get(row.dataset.filePath) : null;
    if (!row || !entry) return;
    if ((event.metaKey || event.ctrlKey) && !entry.isDir) {
      void openFile(entry.path);
      return;
    }
    if (entry.isDir && !filter) toggle(entry.path);
    select(entry.path, true);
  });
  list.addEventListener('dblclick', (event) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.file-browser__row'));
    const entry = row?.dataset.filePath ? known.get(row.dataset.filePath) : null;
    // A folder's clicks are its own: each opens or closes it, and a reader who
    // double-clicks one meant that. A file's second click means Pin.
    if (!entry || entry.isDir) return;
    pinEntry(entry);
  });

  filterInput.addEventListener('input', () => filterSoon());
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && filterInput.value) {
      // Escape clears a filter before it does anything else; an empty one
      // leaves the key to the board.
      event.preventDefault();
      event.stopPropagation();
      filterInput.value = '';
      filterSoon.cancel();
      void runFilter();
      list.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const first = rows.find((row) => row.kind === 'item')?.entry?.path;
      if (first) select(first, false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filterSoon.cancel();
      void runFilter();
    }
  });

  head.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.file-browser__sort'));
    const key = button?.dataset.sort || '';
    if (!SORT_KEYS.includes(key)) return;
    // Newest and biggest are what anyone sorting by those columns is after.
    if (key === sortKey) desc = !desc;
    else desc = key !== 'name';
    sortKey = key;
    persist();
    render();
  });

  bar.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.file-browser__tool'));
    switch (button?.dataset.act) {
      case 'hidden':
        hideHidden = !hideHidden;
        hiddenTool.setAttribute('aria-pressed', String(hideHidden));
        persist();
        render();
        break;
      case 'collapse':
        expanded.clear();
        persist();
        render();
        break;
      case 'preview':
        setPreviewOn(!previewOn);
        break;
      default:
        break;
    }
  });

  divider.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    const across = getComputedStyle(splitBox).flexDirection === 'row';
    /** @param {PointerEvent} move - The drag. */
    const onMove = (move) => {
      const box = splitBox.getBoundingClientRect();
      const share = across ? (move.clientX - box.left) / box.width : (move.clientY - box.top) / box.height;
      split = Math.round(Math.max(0.15, Math.min(0.85, share)) * 100) / 100;
      splitBox.style.setProperty('--fb-split', String(split));
    };
    const onUp = () => {
      divider.removeEventListener('pointermove', onMove);
      persist();
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp, { once: true });
    divider.addEventListener('pointercancel', onUp, { once: true });
  });

  const rereadPending = debounce(() => {
    const dirs = [...pendingDirs];
    pendingDirs.clear();
    for (const dir of dirs) void readDirectory(dir, true);
    if (previewDirty) void showPreview(0);
    if (filter) void runFilter();
  }, REFRESH_DEBOUNCE_MS, { maxWait: REFRESH_MAX_WAIT_MS });

  // Only the directories on screen, and only when something in them moved: a
  // write to one file is one directory to re-read, not a tree.
  const services = context().services;
  const stopWatching = services?.files?.onChange?.((changes) => {
    for (const change of changes) {
      const dir = parentDir(change.path);
      if (dir && entries.has(dir)) pendingDirs.add(dir);
      if (change.path === previewPath) previewDirty = true;
    }
    if (pendingDirs.size === 0 && !previewDirty) return;
    rereadPending();
  }) || (() => {});

  const stopGit = services?.git?.onChange?.(() => {
    readGit();
    if (live()) render();
  }) || (() => {});
  readGit();

  /**
   * Read every directory on screen again, and the preview. The stale rows stay
   * up meanwhile, so a refresh is not a flash of nothing.
   * @returns {void}
   */
  const refreshAll = () => {
    generation++;
    for (const dir of [root, ...expanded]) {
      if (entries.has(dir)) void readDirectory(dir);
    }
    void services?.git?.refresh?.();
    if (previewPath) void showPreview(previewBody.scrollTop);
    if (filter) void runFilter();
  };

  /**
   * Read the root and every remembered folder at once rather than a level at a
   * time: they are already known to be wanted, and waiting for each to land
   * before asking for the one inside it would make coming back to the tab as
   * slow as its deepest branch.
   * @returns {void}
   */
  const start = () => {
    if (!root) return;
    void readDirectory(root);
    for (const dir of expanded) if (dir !== root) void readDirectory(dir);
  };

  start();
  if (pendingView && typeof pendingView.filter === 'string' && pendingView.filter) {
    filterInput.value = pendingView.filter;
    void runFilter();
  }
  render();
  void showPreview(0);

  return {
    element,
    setRoot: (next) => {
      if (next === root) return;
      // A different folder is a different tree; nothing about the old one means
      // anything here, and leaving it written down would reopen folders that
      // happened to share a name.
      root = next;
      generation++;
      expanded.clear();
      entries.clear();
      known.clear();
      pendingDirs.clear();
      activePath = '';
      previewPath = '';
      statusText = '';
      filter = null;
      filterInput.value = '';
      persist();
      start();
      render();
      void showPreview(0);
    },
    refresh: refreshAll,
    focus: () => moveTo(activePath),
    saveViewState: () => ({
      scrollTop: list.scrollTop,
      active: activePath,
      preview: previewPath,
      previewScrollTop: previewBody.scrollTop,
      filter: filterInput.value,
    }),
    teardown: () => {
      tornDown = true;
      rereadPending.cancel();
      settlePreview.cancel();
      filterSoon.cancel();
      if (changedTimer) clearTimeout(changedTimer);
      stopWatching();
      stopGit();
    },
  };
}
