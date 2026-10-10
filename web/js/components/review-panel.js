//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The review panel: a file rail, one diff at a time, and the draft beneath it.
 *
 * The second of the two layers a review is built from. `diff-viewer` knows about
 * one file and draws it; this knows there are several, which one is being read,
 * where the comments are kept and where they go when they are sent. Neither can
 * absorb the other — multi-file navigation inside the custom element would put a
 * file rail into a properties panel showing one operation on one file, and
 * rebuilding the navigation per host is how four diff UIs drift apart.
 *
 * It knows nothing about git. It is handed a manifest of groups and files, each
 * already worded by whoever produced it, a loader that turns one of those files
 * into a patch, and a destination to keep the comments in. The Git pin is the
 * only host in this work; it is written as though there were a second, because
 * the alternative is discovering the coupling later with a shipped API.
 * @module components/review-panel
 */

import { createDiffViewer } from './diff-viewer.js';

/**
 * Scroll one box just far enough to show something inside it, and scroll
 * nothing else. The movement is a clamped `scrollTop` on the scroller itself,
 * never `Element.scrollIntoView`, whose ancestor-walking would move whatever is
 * holding the scroller — which for a pin is the workspace behind the board.
 * @param {HTMLElement} scroller - The box that may move.
 * @param {HTMLElement} target - What has to end up visible in it.
 * @returns {void}
 */
function revealInScroller(scroller, target) {
  const box = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  // Both rectangles carry any transform on the way to the viewport, so the
  // difference between them is unaffected by the board's slide.
  if (item.top < box.top) scroller.scrollTop -= box.top - item.top;
  else if (item.bottom > box.bottom) scroller.scrollTop += item.bottom - box.bottom;
}

/**
 * One file offered for review, worded by the host. The panel reads `repo` and
 * `path` as the file's address and shows the rest.
 * @typedef {object} ReviewFile
 * @property {string} repo - The group the file belongs to, '' for the first one
 * @property {string} path - The file's path within that group
 * @property {string} [oldPath] - Where it was, for a rename
 * @property {string} [code] - A short status code, drawn in the gutter of the rail
 * @property {'added'|'removed'|'modified'|'renamed'|'conflicted'} [tone] - What
 *   kind of change it is, which colours the row. Named rather than styled by the
 *   host: the panel owns its palette, and an unknown tone is simply not coloured.
 * @property {string} [status] - The same thing in words, for the accessible label
 * @property {number} [added] - Lines added
 * @property {number} [removed] - Lines removed
 * @property {string} [filePath] - Where the file is on disk, for the right-click
 *   menu every other surface showing a path offers. Omitted for a file that is
 *   no longer there.
 * @property {() => HTMLElement|null} [actions] - The file's controls, built on
 *   demand and shown above the diff. Omitted for a file that is no longer on disk.
 */

/**
 * One group of files — for Git, one repository.
 * @typedef {object} ReviewGroup
 * @property {string} key - Identifies the group; the files' own `repo`
 * @property {string} [name] - What to call it, '' for a lone unnamed group
 * @property {string} [detail] - A quieter second phrase, e.g. its branch
 * @property {string} [note] - What could not be read here, in the host's words
 * @property {ReviewFile[]} files - The changed files
 */

/**
 * What is under review.
 * @typedef {object} ReviewManifest
 * @property {boolean} complete - Whether everything was reached. A false here is
 *   drawn, never papered over: a partial list stays on screen, described as partial.
 * @property {string[]} warnings - What could not be reviewed, one sentence each
 * @property {ReviewGroup[]} groups - The groups, in the order to show them
 * @property {string} [scope] - What is being compared, when this manifest says
 *   more than the panel's `scopeLabel` — the tree it was read from, say. It rides
 *   the manifest so the words and the files they describe arrive together.
 * @property {string} [scopeKey] - Which comparison this is, for the comments: a
 *   comment is written in the manifest's scope, and only the comments written in
 *   it are drawn and counted here. '' or absent is the host's default comparison,
 *   which is also where every comment carrying no scope belongs. The others are
 *   kept — they go out with the rest — and the footer says how many there are.
 */

/** How wide a quoted line may be before the editor's label stops naming it. */
const LABEL_PATH_MAX = 80;

/** The kinds of change a row's code is coloured for; anything else is not. */
const TONES = new Set(['added', 'removed', 'modified', 'renamed', 'conflicted']);

/**
 * A file's address, as one string. Two `src/main.go` in two repositories are two
 * files, so the group is part of it.
 * @param {string} repo - The group.
 * @param {string} path - The path within it.
 * @returns {string} The key.
 */
function fileKey(repo, path) {
  return `${repo}\u0000${path}`;
}

/**
 * @param {number} count - How many.
 * @param {string} one - The singular noun.
 * @returns {string} e.g. '1 file', '7 files'.
 */
function plural(count, one) {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/**
 * An id no other comment in this draft will have.
 * @returns {string} The id.
 */
function commentId() {
  return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} tag - Element name.
 * @param {string} [className] - Its class.
 * @param {string} [text] - Its text.
 * @returns {HTMLElement} The element.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * What went wrong, in the words of whatever went wrong. Never replaced with a
 * summary: the lead above it is ours, the text is the system's.
 * @param {unknown} error - The failure.
 * @returns {string} Its message.
 */
function reason(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

/** The panel. Built by {@link createReviewPanel}. */
class ReviewPanel {
  /**
   * @param {object} options - How the panel behaves.
   * @param {string} options.scopeLabel - What is being compared, in words. Shown
   *   as the panel's first line, because a diff with no stated scope is a diff
   *   the reader has to guess the meaning of.
   * @param {(file: ReviewFile, options: {signal: AbortSignal}) => Promise<any>} options.loadPatch -
   *   One file's patch. Called when a file is selected, never in a loop over the
   *   manifest, and given a signal that is aborted when the reader moves on.
   * @param {any} options.review - Where the comments live: `draft`, `onChange`,
   *   `save`, `clear` and `compose`, as `services.review` provides them.
   */
  constructor({ scopeLabel, loadPatch, review }) {
    /** @type {string} @private */
    this._scopeLabel = scopeLabel || '';
    /** @type {(file: ReviewFile, options: {signal: AbortSignal, contextLines?: number}) => Promise<any>} @private */
    this._loadPatch = loadPatch;
    /** @type {any} @private */
    this._review = review;

    /** @type {ReviewManifest|null} @private */
    this._manifest = null;
    /** @type {string|null} @private */
    this._activeKey = null;
    /** @type {Map<string, any>} @private */
    this._patches = new Map();
    /** @type {AbortController|null} @private */
    this._request = null;
    /**
     * Which question the panel is currently asking. A patch that resolves after
     * the reader moved on is an answer to a question nobody is asking, and
     * drawing it would put one file's diff under another file's row.
     * @type {number} @private
     */
    this._generation = 0;
    /**
     * The context width every patch the panel holds was fetched at. Null until a
     * viewer has said what it wants; a change to it retires the lot, since each of
     * them was produced at the old width and only the server can widen one.
     * @type {number|null} @private
     */
    this._contextLines = null;
    /** @type {any} @private */
    this._editor = null;
    /** @type {string} @private */
    this._footerError = '';

    this.element = el('div', 'review-panel');
    /** @type {HTMLElement} @private */
    this._scopeEl = el('div', 'review-panel__scope');
    /** @type {HTMLElement} @private */
    this._scopeTextEl = el('span', 'review-panel__scope-text');
    this._scopeEl.append(this._scopeTextEl);
    /** @type {HTMLElement} @private */
    this._warningsEl = el('div', 'review-panel__warnings');
    /** @type {HTMLElement} @private */
    this._errorEl = el('div', 'review-panel__error');
    /** @type {HTMLElement} @private */
    this._mainEl = el('div', 'review-panel__main');
    /** @type {HTMLElement} @private */
    this._railEl = el('div', 'review-panel__rail');
    this._railEl.setAttribute('role', 'group');
    this._railEl.setAttribute('aria-label', 'Changed files');
    /** @type {HTMLElement} @private */
    this._diffEl = el('div', 'review-panel__diff');
    /** @type {HTMLElement} @private */
    this._footerEl = el('div', 'review-panel__footer');

    this._mainEl.append(this._railEl, this._diffEl);
    this.element.append(this._scopeEl, this._mainEl);

    this._railEl.addEventListener('keydown', (event) => this._onRailKey(event));
    this._diffEl.addEventListener('diff-comment-request', (event) => {
      this._onCommentRequest(/** @type {CustomEvent} */ (event).detail);
    });
    this._diffEl.addEventListener('diff-annotation-edit', (event) => {
      this._onAnnotationEdit(/** @type {CustomEvent} */ (event).detail?.id);
    });
    this._diffEl.addEventListener('diff-annotation-delete', (event) => {
      void this._deleteComment(/** @type {CustomEvent} */ (event).detail?.id);
    });
    // The reader asked for more or less of the file around each change. The viewer
    // has already narrowed what it holds if it could, which is instant; this is
    // what fetches the lines it could not have, and _loadActive decides whether
    // anything actually needs asking for.
    this._diffEl.addEventListener('diff-context-change', () => this._loadActive());

    /** @type {() => void} @private */
    this._stopWatching = typeof review?.onChange === 'function'
      ? review.onChange(() => this._onDraftChange())
      : () => {};

    this._renderScope();
    this._renderFooter();
  }

  /**
   * Show this manifest. The loaded patches go with the old one: they are answers
   * about a tree that has moved, and one kept here would be handed back as
   * though it were current. The file being read is kept if it is still there.
   * @param {ReviewManifest} manifest - What is under review now.
   */
  setManifest(manifest) {
    this._manifest = manifest;
    this._patches.clear();
    this._closeEditor();
    this._renderScope();
    this._renderWarnings();
    this._renderRail();

    const files = this._files();
    const wanted = files.some((file) => fileKey(file.repo, file.path) === this._activeKey)
      ? this._activeKey
      : (files[0] ? fileKey(files[0].repo, files[0].path) : null);
    this._activeKey = null;
    this._select(wanted, false);
    this._renderFooter();
  }

  /**
   * Say that the last read failed, under whatever is already on screen. A stale
   * review beats a blank one, so nothing is taken away — but it stops being
   * described as current.
   * @param {string} text - The whole line, lead and underlying error. '' clears it.
   */
  setError(text) {
    this._errorEl.textContent = text || '';
    this._show(this._errorEl, Boolean(text), this._mainEl);
  }

  /**
   * Put a section in the panel, or take it out. Out rather than hidden: a
   * section with nothing to say says nothing, and an empty box that is still
   * there reads as a thing that failed to load. Only the part that changed is
   * touched, so toggling the footer never blurs what the reader is typing into.
   * @param {HTMLElement} node - The section.
   * @param {boolean} on - Whether it has anything to say.
   * @param {HTMLElement|null} before - What it goes above, null to append.
   * @private
   */
  _show(node, on, before) {
    if (!on) {
      node.remove();
      return;
    }
    if (node.parentNode !== this.element) this.element.insertBefore(node, before);
  }

  /**
   * Put the host's own control for what is compared at the start of the scope
   * row, so the choice and the words describing its result read as one line —
   * and wrap to two when the panel is too narrow for that. The node is moved,
   * not copied: a host that shows it elsewhere while the panel is away takes it
   * back simply by appending it there.
   * @param {HTMLElement|null} node - The control, or null to take it out.
   */
  setScopeControl(node) {
    for (const child of Array.from(this._scopeEl.children)) {
      if (child !== this._scopeTextEl && child !== node) child.remove();
    }
    if (node && node.parentNode !== this._scopeEl) this._scopeEl.insertBefore(node, this._scopeTextEl);
  }

  /** Move focus to the file being read. */
  focus() {
    /** @type {HTMLElement|null} */
    const active = this._railEl.querySelector('.review-panel__file[aria-current="true"]');
    if (!active) return;
    // This panel is the body of a pin, and the board holding it is parked off
    // the right edge of the workspace by a transform until it has slid in. A
    // plain focus() there has the browser scroll every ancestor to reveal it,
    // and `.app-main` is a scroll box with the scrollbar taken away: the columns
    // lurch left, the sliding panel overshoots with them, and it all springs
    // back when the transform settles. So the reveal is done here instead, on
    // the one box that should move — clamped scrollTop on the rail, which can
    // neither overshoot nor drag an ancestor along.
    active.focus({ preventScroll: true });
    revealInScroller(this._railEl, active);
  }

  /** Stop watching the draft and cancel whatever is still being read. */
  destroy() {
    this._stopWatching();
    this._request?.abort();
    this._request = null;
  }

  // --- the manifest ---------------------------------------------------------

  /**
   * @returns {ReviewFile[]} Every file under review, in the order shown.
   * @private
   */
  _files() {
    return (this._manifest?.groups || []).flatMap((group) => group.files || []);
  }

  /**
   * @param {string|null} key - A file's address.
   * @returns {ReviewFile|null} That file, or null.
   * @private
   */
  _fileFor(key) {
    return this._files().find((file) => fileKey(file.repo, file.path) === key) || null;
  }

  /** @private */
  _renderScope() {
    const files = this._files();
    const added = files.reduce((total, file) => total + (file.added || 0), 0);
    const removed = files.reduce((total, file) => total + (file.removed || 0), 0);
    /** @type {string[]} */
    const parts = [this._manifest?.scope || this._scopeLabel];
    if (this._manifest) {
      // "so far" is the whole difference between a count and a claim. A review
      // that could not reach everything knows a floor, not a total.
      parts.push(plural(files.length, 'file') + (this._manifest.complete ? '' : ' so far'));
      if (added > 0 || removed > 0) parts.push(`+${added} −${removed}`);
    }
    this._scopeTextEl.textContent = parts.filter(Boolean).join(' · ');
  }

  /** @private */
  _renderWarnings() {
    const warnings = this._manifest?.warnings || [];
    this._warningsEl.replaceChildren();
    this._show(this._warningsEl, warnings.length > 0,
      this._errorEl.parentNode === this.element ? this._errorEl : this._mainEl);
    if (warnings.length === 0) return;
    this._warningsEl.append(el('div', 'review-panel__warnings-lead', 'Not everything could be reviewed:'));
    const list = el('ul', 'review-panel__warning-list');
    for (const warning of warnings) list.append(el('li', '', warning));
    this._warningsEl.append(list);
  }

  /** @private */
  _renderRail() {
    this._railEl.replaceChildren();
    for (const group of this._manifest?.groups || []) {
      const block = el('div', 'review-panel__group');
      const head = el('div', 'review-panel__group-head');
      if (group.name) head.append(el('span', 'review-panel__group-name', group.name));
      if (group.detail) head.append(el('span', 'review-panel__group-detail', group.detail));
      if (head.childNodes.length > 0) block.append(head);
      if (group.note) block.append(el('div', 'review-panel__group-note', group.note));

      const rows = el('div', 'review-panel__rows');
      for (const file of group.files || []) rows.append(this._buildRow(file));
      block.append(rows);
      this._railEl.append(block);
    }
  }

  /**
   * One file's row: a real button, naming the file and what happened to it.
   *
   * The rail is a bounded share of the panel and a path is not, so the two halves of one are
   * drawn as two things: the name, which is what the row is read for and is
   * never abbreviated away, and the directory, which qualifies it and gives up
   * its width first. The whole path is on the button's tooltip and in its label,
   * so an elided directory is still there to be read.
   * @param {ReviewFile} file - The file.
   * @returns {HTMLElement} The row.
   * @private
   */
  _buildRow(file) {
    const row = el('div', 'review-panel__row');
    const button = el('button', 'review-panel__file');
    /** @type {HTMLButtonElement} */ (button).type = 'button';
    button.dataset.key = fileKey(file.repo, file.path);
    // An attribute rather than a modifier class, and allow-listed: the tone
    // comes from a host, and the palette is the panel's to name. It sits on the
    // row because both the code and the name are coloured from it.
    if (TONES.has(file.tone || '')) button.dataset.tone = /** @type {string} */ (file.tone);
    button.tabIndex = -1;
    button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    // The same right-click menu as every other surface naming a file, so a row
    // that is not the one being read is still a row you can act on.
    if (file.filePath) button.dataset.filePath = file.filePath;
    button.append(el('span', 'review-panel__code', file.code || ''));
    const cut = file.path.lastIndexOf('/');
    const address = el('span', 'review-panel__path');
    address.append(el('span', 'review-panel__name', file.path.slice(cut + 1)));
    if (cut > 0) address.append(el('span', 'review-panel__dir', file.path.slice(0, cut)));
    button.append(address);
    const added = file.added || 0;
    const removed = file.removed || 0;
    if (added > 0 || removed > 0) {
      button.append(el('span', 'review-panel__stat', `+${added} −${removed}`));
    }
    button.append(el('span', 'review-panel__count', ''));
    button.addEventListener('click', () => this._select(fileKey(file.repo, file.path), true));
    row.append(button);
    this._labelRow(button, file);
    return row;
  }

  /**
   * What a row says aloud: its status, its whole path, where it came from if it
   * moved, the group it is in — so two files of the same name in two
   * repositories are not one row read twice — and how many comments are waiting
   * on it.
   * @param {HTMLElement} button - The row's button.
   * @param {ReviewFile} file - The file.
   * @private
   */
  _labelRow(button, file) {
    const count = this._commentsFor(file).length;
    /** @type {string[]} */
    const parts = [file.status || 'Changed', file.path];
    if (file.oldPath) parts.push(`from ${file.oldPath}`);
    if (file.repo) parts.push(`in ${file.repo}`);
    if (count > 0) parts.push(plural(count, 'comment'));
    button.setAttribute('aria-label', parts.join(', '));
    const badge = button.querySelector('.review-panel__count');
    if (badge) badge.textContent = count > 0 ? String(count) : '';
  }

  /**
   * The row for one file. Found by reading the keys rather than by selecting on
   * one: a key holds a path, and a path holds whatever the user called it.
   * @param {string|null} key - The file's address.
   * @returns {HTMLElement|null} Its button, or null.
   * @private
   */
  _rowButton(key) {
    if (!key) return null;
    return /** @type {HTMLElement|null} */ (
      Array.from(this._railEl.querySelectorAll('.review-panel__file'))
        .find((button) => /** @type {HTMLElement} */ (button).dataset.key === key) || null);
  }

  /** @private */
  _updateCounts() {
    for (const file of this._files()) {
      const button = this._rowButton(fileKey(file.repo, file.path));
      if (button) this._labelRow(button, file);
    }
  }

  // --- selection ------------------------------------------------------------

  /**
   * Read this file. Always reloads: the panel holds a patch only for as long as
   * the manifest it came with, so a selection landing back on a file already
   * read is served from that, and a refresh is not.
   * @param {string|null} key - The file's address, or null for none.
   * @param {boolean} focus - Whether to move focus to its row.
   * @private
   */
  _select(key, focus) {
    if (key === this._activeKey && this._patches.has(String(key))) {
      if (focus) this._focusRow(key);
      return;
    }
    this._closeEditor();
    this._activeKey = key;
    for (const button of Array.from(this._railEl.querySelectorAll('.review-panel__file'))) {
      const current = /** @type {HTMLElement} */ (button).dataset.key === key;
      if (current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      /** @type {HTMLElement} */ (button).tabIndex = current ? 0 : -1;
    }
    if (focus) this._focusRow(key);
    this._loadActive();
  }

  /**
   * @param {string|null} key - A file's address.
   * @private
   */
  _focusRow(key) {
    this._rowButton(key)?.focus();
  }

  /** @private */
  _loadActive() {
    this._request?.abort();
    this._request = null;
    const generation = ++this._generation;

    const file = this._fileFor(this._activeKey);
    if (!file) {
      this._diffEl.replaceChildren(el('div', 'review-panel__placeholder',
        this._manifest ? 'Nothing changed.' : ''));
      return;
    }

    const viewer = this._mountDiff(file);
    // How much of the file around each change to ask git for. The viewer is asked
    // rather than the preference, because a viewer the reader has set for
    // themselves is not following the preference any more.
    const contextLines = viewer.contextLines;
    if (contextLines !== this._contextLines) {
      this._contextLines = contextLines;
      this._patches.clear();
    }

    const key = fileKey(file.repo, file.path);
    const cached = this._patches.get(key);
    if (cached) {
      this._showPatch(file, cached);
      return;
    }

    viewer.setLoading();
    const request = new AbortController();
    this._request = request;
    void Promise.resolve(this._loadPatch(file, { signal: request.signal, contextLines })).then((patch) => {
      if (generation !== this._generation) return;
      this._patches.set(key, patch);
      this._showPatch(file, patch);
    }).catch((error) => {
      if (generation !== this._generation || request.signal.aborted) return;
      this._mountDiff(file).setError(error);
    });
  }

  /**
   * The diff area, headed by the file it is showing, its controls, and — where
   * there is somewhere to put one — a way to comment on the file rather than a
   * line of it, which is all a binary or conflicted file can offer.
   *
   * The controls live here rather than on the rail row because the rail has no
   * room for them: hover-revealed or not, they hold their width in every row,
   * and in a rail capped at 22rem it is the file's name that pays for them.
   * @param {ReviewFile} file - The file being read.
   * @returns {any} The viewer, mounted and empty.
   * @private
   */
  _mountDiff(file) {
    /** @type {any} */
    let viewer = this._diffEl.querySelector('diff-viewer');
    const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    const head = el('div', 'review-panel__diff-head');
    head.append(el('span', 'review-panel__diff-path', file.repo ? `${file.repo}/${path}` : path));
    const actions = file.actions?.();
    if (actions) head.append(actions);
    if (this._canComment()) {
      const whole = el('button', 'review-panel__file-comment', 'Comment on this file');
      /** @type {HTMLButtonElement} */ (whole).type = 'button';
      whole.addEventListener('click', () => this._openEditor({
        repo: file.repo,
        path: file.path,
        oldPath: file.oldPath,
        side: 'file',
        lines: [],
        revision: this._patches.get(fileKey(file.repo, file.path))?.revision || '',
      }));
      head.append(whole);
    }
    if (!viewer) {
      viewer = createDiffViewer({ readOnly: !this._canComment() });
      this._diffEl.replaceChildren(head, viewer);
    } else {
      viewer.readOnly = !this._canComment();
      this._diffEl.replaceChildren(head, viewer);
    }
    return viewer;
  }

  /**
   * @param {ReviewFile} file - The file it belongs to.
   * @param {any} patch - Its patch.
   * @private
   */
  _showPatch(file, patch) {
    const viewer = this._mountDiff(file);
    viewer.setPatch(patch);
    this._renderAnnotations();
  }

  // --- the keyboard ---------------------------------------------------------

  /**
   * Up/Down walk the files, Home/End reach the ends. Left and Right are left
   * alone on purpose: they change pins, and a rail that swallowed them would
   * trap the reader in this one.
   * @param {KeyboardEvent} event - The key.
   * @private
   */
  _onRailKey(event) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const files = this._files();
    if (files.length === 0) return;
    const at = files.findIndex((file) => fileKey(file.repo, file.path) === this._activeKey);
    let next = at;
    if (event.key === 'ArrowDown') next = Math.min(files.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else next = files.length - 1;
    if (next === at && at >= 0) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const file = files[next];
    if (file) this._select(fileKey(file.repo, file.path), true);
  }

  // --- comments -------------------------------------------------------------

  /**
   * @returns {any[]} The comments on the thread being read, whatever scope they
   *   were written in.
   * @private
   */
  _comments() {
    return this._review?.draft()?.comments || [];
  }

  /**
   * @returns {string} The scope a comment written now is written in.
   * @private
   */
  _scopeKey() {
    return this._manifest?.scopeKey || '';
  }

  /**
   * @param {any} comment - A comment.
   * @returns {boolean} Whether it was written in the scope on screen.
   * @private
   */
  _inScope(comment) {
    return (comment.scope || '') === this._scopeKey();
  }

  /**
   * Whether there is anywhere to keep a comment. A board with no conversation is
   * not a review with no comments: offering somewhere to write that quietly
   * discards is the one outcome worth going out of the way to prevent.
   * @returns {boolean} True when comments can be written.
   * @private
   */
  _canComment() {
    return Boolean(this._review) && this._review.draft() !== null;
  }

  /**
   * @param {ReviewFile} file - The file.
   * @returns {any[]} Its comments.
   * @private
   */
  _commentsFor(file) {
    return this._comments().filter((comment) => this._inScope(comment)
      && comment.repo === file.repo && comment.path === file.path);
  }

  /** @private */
  _renderAnnotations() {
    /** @type {any} */
    const viewer = this._diffEl.querySelector('diff-viewer');
    const file = this._fileFor(this._activeKey);
    if (!viewer || !file) return;
    viewer.setAnnotations(this._commentsFor(file).map((comment) => ({
      id: comment.id,
      side: comment.side,
      startLine: comment.startLine,
      endLine: comment.endLine,
      lineText: comment.lineText,
      body: comment.body,
      revision: comment.revision,
    })));
    this._placeEditor();
  }

  /**
   * @param {any} detail - The renderer's `diff-comment-request`.
   * @private
   */
  _onCommentRequest(detail) {
    const file = this._fileFor(this._activeKey);
    if (!file || !detail) return;
    this._openEditor({
      repo: file.repo,
      path: file.path,
      oldPath: file.oldPath,
      side: detail.side,
      startLine: detail.startLine,
      endLine: detail.endLine,
      lines: Array.isArray(detail.lines) ? detail.lines : [],
      revision: detail.revision || '',
    });
  }

  /**
   * @param {string} id - The comment to edit.
   * @private
   */
  _onAnnotationEdit(id) {
    const comment = this._comments().find((c) => c.id === id);
    if (!comment) return;
    this._openEditor({
      id: comment.id,
      repo: comment.repo,
      path: comment.path,
      oldPath: comment.oldPath,
      side: comment.side,
      startLine: comment.startLine,
      endLine: comment.endLine,
      lines: comment.lineText || [],
      revision: comment.revision || '',
      body: comment.body,
    });
  }

  /**
   * @param {string} id - The comment to delete.
   * @returns {Promise<void>} Resolved once the rest are written back.
   * @private
   */
  async _deleteComment(id) {
    const rest = this._comments().filter((comment) => comment.id !== id);
    if (rest.length === this._comments().length) return;
    if (this._editor?.anchor.id === id) this._closeEditor();
    try {
      await this._review.save({ comments: rest });
    } catch (error) {
      this._footerError = `Couldn't delete that comment. ${reason(error)}`;
      this._renderFooter();
    }
  }

  /**
   * What a comment being written is about, said the way the anchor that opened
   * it says it.
   * @param {any} anchor - The comment's address.
   * @returns {string} The label.
   * @private
   */
  _editorLabel(anchor) {
    const path = anchor.path.length > LABEL_PATH_MAX ? `…${anchor.path.slice(-LABEL_PATH_MAX)}` : anchor.path;
    if (anchor.side === 'file') return `Comment on ${path}`;
    const span = anchor.endLine > anchor.startLine
      ? `${anchor.side} lines ${anchor.startLine} to ${anchor.endLine}`
      : `${anchor.side} line ${anchor.startLine}`;
    return `Comment on ${span} in ${path}`;
  }

  /**
   * @param {any} anchor - Where the comment hangs, and what it quotes.
   * @private
   */
  _openEditor(anchor) {
    this._closeEditor();
    const box = el('div', 'review-panel__editor');
    const id = `review-comment-${Math.random().toString(36).slice(2, 8)}`;
    const label = el('label', 'review-panel__editor-label', this._editorLabel(anchor));
    /** @type {HTMLLabelElement} */ (label).htmlFor = id;
    const textarea = document.createElement('textarea');
    textarea.className = 'review-panel__editor-text';
    textarea.id = id;
    textarea.rows = 3;
    textarea.value = typeof anchor.body === 'string' ? anchor.body : '';
    const error = el('div', 'review-panel__editor-error');
    error.hidden = true;
    const actions = el('div', 'review-panel__editor-actions');
    // An edit replaces the comment it was opened on, so only a new one is
    // joining anything. Neither is sent: both end at the batch in the footer.
    const save = el('button', 'review-panel__save', anchor.id ? 'Save changes' : 'Add to feedback');
    /** @type {HTMLButtonElement} */ (save).type = 'button';
    const cancel = el('button', 'review-panel__cancel', 'Cancel');
    /** @type {HTMLButtonElement} */ (cancel).type = 'button';
    actions.append(save, cancel);
    box.append(label, textarea, error, actions);

    save.addEventListener('click', () => { void this._saveEditor(); });
    cancel.addEventListener('click', () => this._cancelEditor());
    box.addEventListener('keydown', (event) => {
      if (/** @type {KeyboardEvent} */ (event).key !== 'Escape') return;
      event.preventDefault();
      this._cancelEditor();
    });

    this._editor = { box, textarea, error, anchor };
    this._placeEditor();
    textarea.focus();
  }

  /**
   * Put the editor back where it belongs. The renderer rebuilds itself whenever
   * it is given anything, so the editor is a node this panel holds and re-hangs
   * rather than markup inside the diff — which is also what keeps half-written
   * words on screen when a save is refused.
   * @private
   */
  _placeEditor() {
    const editor = this._editor;
    if (!editor) return;
    /** @type {any} */
    const viewer = this._diffEl.querySelector('diff-viewer');
    if (!viewer) {
      this._diffEl.append(editor.box);
      return;
    }
    const anchor = editor.anchor;
    if (anchor.side !== 'file') {
      const attribute = anchor.side === 'old' ? 'data-old-line' : 'data-new-line';
      const line = viewer.querySelector(`.diff-line[${attribute}="${anchor.endLine}"]`);
      if (line) {
        const comments = line.nextElementSibling?.classList?.contains('diff-comments')
          ? line.nextElementSibling
          : line;
        comments.after(editor.box);
        return;
      }
    }
    (viewer.querySelector('diff-file-comments') || viewer.querySelector('diff-content') || viewer)
      .append(editor.box);
  }

  /** @private */
  _cancelEditor() {
    const anchor = this._editor?.anchor;
    this._closeEditor();
    if (!anchor || anchor.side === 'file') return;
    /** @type {HTMLElement|null} */
    const button = this._diffEl.querySelector(
      `.diff-comment-btn[data-side="${anchor.side}"][data-line="${anchor.endLine}"]`);
    button?.focus();
  }

  /** @private */
  _closeEditor() {
    this._editor?.box.remove();
    this._editor = null;
  }

  /**
   * @returns {Promise<void>} Resolved once the draft is written, or the refusal shown.
   * @private
   */
  async _saveEditor() {
    const editor = this._editor;
    if (!editor) return;
    const body = editor.textarea.value.trim();
    if (!body) {
      this._showEditorError('A comment with nothing in it says nothing.');
      return;
    }

    const anchor = editor.anchor;
    const now = Date.now();
    const comments = this._comments();
    /** @type {any} */
    const comment = {
      id: anchor.id || commentId(),
      repo: anchor.repo,
      path: anchor.path,
      side: anchor.side,
      lineText: anchor.lines || [],
      body,
      revision: anchor.revision || '',
      createdAt: now,
      updatedAt: now,
    };
    if (anchor.oldPath) comment.oldPath = anchor.oldPath;
    // An edit keeps the scope it was written in; a new comment takes the one on
    // screen, with its words as they read now, since `main` will move.
    const existing = comments.find((c) => c.id === comment.id);
    const scope = existing ? existing.scope : this._scopeKey();
    if (scope) {
      comment.scope = scope;
      const label = existing ? existing.scopeLabel : this._manifest?.scope;
      if (label) comment.scopeLabel = label;
    }
    if (anchor.side !== 'file' && typeof anchor.startLine === 'number') {
      comment.startLine = anchor.startLine;
      comment.endLine = anchor.endLine ?? anchor.startLine;
    }

    const at = comments.findIndex((existing) => existing.id === comment.id);
    const next = comments.slice();
    if (at >= 0) {
      comment.createdAt = comments[at].createdAt;
      next[at] = comment;
    } else {
      next.push(comment);
    }

    try {
      await this._review.save({ comments: next });
      this._closeEditor();
    } catch (error) {
      // The words are the user's own and are still in the box, which is the
      // whole reason the save refuses rather than trimming to fit.
      this._showEditorError(`Couldn't save that comment. ${reason(error)}`);
    }
  }

  /**
   * @param {string} text - What went wrong.
   * @private
   */
  _showEditorError(text) {
    if (!this._editor) return;
    this._editor.error.textContent = text;
    this._editor.error.hidden = false;
  }

  // --- the draft ------------------------------------------------------------

  /** @private */
  _onDraftChange() {
    this._updateCounts();
    this._renderAnnotations();
    this._renderFooter();
  }

  /** @private */
  _renderFooter() {
    this._footerEl.replaceChildren();

    if (!this._canComment()) {
      this._show(this._footerEl, true, null);
      this._footerEl.append(el('span', 'review-panel__footer-note',
        'No conversation open, so there is nowhere to put a comment.'));
      return;
    }

    const comments = this._comments();
    if (comments.length === 0) {
      this._show(this._footerEl, false, null);
      this._footerError = '';
      return;
    }

    this._show(this._footerEl, true, null);
    // Every comment goes out together, so the count is all of them; the ones
    // written in another scope are named, since they are not on screen here.
    const elsewhere = comments.filter((comment) => !this._inScope(comment)).length;
    this._footerEl.append(el('span', 'review-panel__draft-count',
      `${plural(comments.length, 'draft comment')}${elsewhere ? ` (${elsewhere} in another scope)` : ''}`));
    const discard = el('button', 'review-panel__discard', 'Discard');
    /** @type {HTMLButtonElement} */ (discard).type = 'button';
    discard.addEventListener('click', () => { void this._discard(); });
    const compose = el('button', 'review-panel__compose', 'Paste feedback into prompt');
    /** @type {HTMLButtonElement} */ (compose).type = 'button';
    compose.addEventListener('click', () => { void this._compose(); });
    this._footerEl.append(discard, compose);
    if (this._footerError) {
      this._footerEl.append(el('div', 'review-panel__footer-error', this._footerError));
    }
  }

  /**
   * @returns {Promise<void>} Resolved once the draft is gone, or the refusal shown.
   * @private
   */
  async _discard() {
    try {
      this._footerError = '';
      await this._review.clear();
    } catch (error) {
      this._footerError = `Couldn't discard. ${reason(error)}`;
      this._renderFooter();
    }
  }

  /**
   * @returns {Promise<void>} Resolved once the review is in the prompt, or the
   *   refusal shown.
   * @private
   */
  async _compose() {
    try {
      this._footerError = '';
      await this._review.compose();
    } catch (error) {
      // The comments are still here either way — handing them over does not
      // spend them — so this reports what went wrong and changes nothing else.
      this._footerError = `Couldn't put the feedback in the prompt. ${reason(error)}`;
      this._renderFooter();
    }
  }
}

/**
 * A review panel, ready to be given a manifest.
 * @param {object} options - How the panel behaves.
 * @param {string} options.scopeLabel - What is being compared, in words.
 * @param {(file: ReviewFile, options: {signal: AbortSignal}) => Promise<any>} options.loadPatch -
 *   One file's patch, on demand.
 * @param {any} options.review - Where the comments live, as `services.review`.
 * @returns {ReviewPanel} The panel. Append its `element`, feed it `setManifest`,
 *   and call `destroy` when the host goes away.
 */
export function createReviewPanel(options) {
  return new ReviewPanel(options);
}

export default ReviewPanel;
