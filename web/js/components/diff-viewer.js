//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { regroupHunks } from '../lib/diff-utils.js';
import { cachedSnapshot, requestSnapshot } from '../lib/diff-snapshot-client.js';
import {
  DIFF_VIEW_PREFS_EVENT, CONTEXT_CHOICES, WHOLE_FILE,
  contextLabel, contextToRender, defaultDiffView, defaultDiffContext,
} from '../utils/diff-view-prefs.js';
import { escapeHtml, escapeAttr } from '../../sdk/lib/html.js';
import { registerContextMenuProvider, codeReferenceMenuItem } from '../services/context-menu-service.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { isAbsolutePath } from '../utils/code-selection.js';
import { t, formatDate, formatNumber, numberFormatter, markForTranslation } from '../../sdk/lib/i18n.js';
import { errorText } from '../../sdk/lib/error-utils.js';

/** @typedef {import('../lib/diff-types.js').DiffHunk} DiffHunk */
/** @typedef {import('../lib/diff-types.js').DiffLine} DiffLine */
/** @typedef {import('../lib/diff-types.js').DiffPatch} DiffPatch */
/** @typedef {import('../lib/diff-types.js').DiffAnnotation} DiffAnnotation */
/** @typedef {import('../lib/diff-snapshot.js').Snapshot} Snapshot */
/** @typedef {import('../lib/diff-snapshot.js').SnapshotInput} SnapshotInput */
/** @typedef {{oldLine: number|null, newLine: number|null, side: 'old'|'new', text: string}} DiffRow */
/** @typedef {{kind: string, text: string, detail?: string}} DiffNotice */
/** @typedef {'stage'|'unstage'|'discard'} StageVerb */
/**
 * Which commit last changed each line of the new side: `lines[n - 1]` is the
 * index in `commits` of line n's, and a commit with `sha` '' holds lines nobody
 * has committed.
 * @typedef {{commits: {sha: string, author: string, date: number, summary: string}[], lines: number[]}} DiffBlame
 */
/**
 * A run of one hunk's rows drawn as one element: rows `from` to `to` (exclusive)
 * of the hunk's rows in the layout in force, with the hunk's header when it
 * starts the hunk, and how many comments hang from its rows.
 * @typedef {{hunk: number, from: number, to: number, header: boolean, last: boolean, comments: number}} DiffBlock
 */
/**
 * The body as blocks: each hunk's rows (its lines, or its paired rows in two
 * columns), the blocks cut from them, and the first block of each hunk.
 * @typedef {{view: 'inline'|'split', rows: any[][], blocks: DiffBlock[], hunkFirst: number[], windowed: boolean}} DiffLayout
 */
/**
 * A windowed body.
 * @typedef {object} DiffWindow
 * @property {DiffLayout} layout - The blocks it draws from.
 * @property {DiffHunk[]} hunks - The hunks the layout was cut from.
 * @property {HTMLElement} body - The `diff-body` it draws into.
 * @property {HTMLElement} top - The spacer standing for the blocks above those drawn.
 * @property {HTMLElement} bottom - The spacer standing for the blocks below.
 * @property {HTMLElement[]} gaps - Spacers between drawn blocks that are not adjacent.
 * @property {Float64Array} heights - Each block's height, once measured.
 * @property {Uint8Array} measured - Which blocks have been measured.
 * @property {Float64Array|null} sums - Where each block starts, estimated where unmeasured; null when stale.
 * @property {Map<number, HTMLElement>} drawn - The blocks drawn, by index.
 * @property {HTMLElement|null} scroller - What scrolls the body, once found.
 */

/**
 * Rows up to which the whole body is drawn. Below it every line is in the
 * document, so find-in-page and a selection across the file work as they always
 * have; above it only the rows the scroller can show are, between spacers that
 * stand in for the rest, so what a render costs tracks the window and not the
 * patch. A diff row is five or six elements, and this many is drawn and laid
 * out in a few tens of milliseconds; the server's cap (20,000 lines) is twenty
 * times that.
 */
const EAGER_ROW_LIMIT = 1000;

/**
 * Rows to a block of a windowed body. The block, not the row, is what is drawn,
 * measured and dropped, so the prefix sum the window is found by has a few
 * hundred entries rather than twenty thousand, and a row whose comments make it
 * taller than the rest is measured as part of its block, not guessed at.
 */
const BLOCK_ROWS = 25;

/** Rows' worth of height drawn beyond each edge of the view, so a small scroll draws nothing. */
const OVERSCAN_ROWS = 20;

/** How line numbers read: localised digits, never grouped (see lineNumber). */
const LINE_NUMBER_FORMAT = { useGrouping: false };

/**
 * Stands for the line number in a comment anchor's label while the label is
 * formatted once per render; private-use, so no message or path contains it.
 */
const NUMBER_SLOT = '\uE000';

/**
 * The block at a height: the last whose top is at or above it.
 * @param {Float64Array} sums - Each block's top, and the total last.
 * @param {number} px - A height within the body.
 * @returns {number} The block's index.
 */
function blockAt(sums, px) {
  let lo = 0;
  let hi = sums.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (/** @type {number} */ (sums[mid]) <= px) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * How many columns a line's text takes, tabs at the default tab stop of eight.
 * @param {string} text - The line.
 * @returns {number} Its width, in `ch`.
 */
function columnsOf(text) {
  let tabs = 0;
  for (let at = text.indexOf('\t'); at >= 0; at = text.indexOf('\t', at + 1)) tabs++;
  return text.length + tabs * 7;
}

/**
 * How wide the viewer must be before it will draw two columns, in rem.
 *
 * Measured rather than assumed: this component is mounted in a properties panel,
 * a docked Pinboard and a detached window, and only the last of those is reliably
 * wide. Two columns in 20rem is two columns of nothing — every line wrapped to
 * four, which is harder to read than the one column it replaced. Below this the
 * split preference is honoured by ignoring it.
 *
 * Each half spends about 4.25rem of its share on the line-number gutter and the
 * +/- column, so this leaves roughly thirty characters a side before wrapping
 * begins — which is narrow, but narrow and side by side is still the comparison
 * the reader asked for.
 *
 * In rem, so it moves with the zoom preference: what matters is how many
 * characters fit, and zoom changes that without changing any pixel count.
 *
 * Exported because it is a fact about the component that a host laying one out
 * may want: it is the width at which a panel starts being able to offer the
 * two-column layout at all.
 */
export const SPLIT_MIN_REM = 40;

/**
 * Why the layout switch is refusing, for the reader hovering the control it
 * refused. Said as what would make it work rather than as what went wrong: the
 * panel is theirs to widen, and a diff in the Pinboard docked at 20rem is the
 * common way to meet this.
 */
const SPLIT_TOO_NARROW = markForTranslation('Two columns need a wider panel.');

/** What a hunk's staging button says when no line of it is picked, by verb. */
const STAGE_HUNK_LABELS = {
  stage: markForTranslation('Stage hunk'),
  unstage: markForTranslation('Unstage hunk'),
  discard: markForTranslation('Discard hunk'),
};

/** What a hunk's staging button says when lines of it are picked, by verb. */
const STAGE_LINES_LABELS = {
  stage: markForTranslation('Stage {count, plural, one {# line} other {# lines}}'),
  unstage: markForTranslation('Unstage {count, plural, one {# line} other {# lines}}'),
  discard: markForTranslation('Discard {count, plural, one {# line} other {# lines}}'),
};

/**
 * Where a changed line lives, as a key: a removal by its old-side number, an
 * addition by its new-side number. The key is the line's coordinate in the file,
 * so it names the same line however the hunks around it are grouped.
 * @param {DiffLine} line - The line.
 * @returns {string|null} `old:<n>` or `new:<n>`, or null for an unchanged line
 *   or one without a number on its side.
 */
function stageKey(line) {
  if (line.type === 'remove') return line.oldLineNum === null ? null : `old:${line.oldLineNum}`;
  if (line.type === 'add') return line.newLineNum === null ? null : `new:${line.newLineNum}`;
  return null;
}

/**
 * The coordinate a key stands for, as a staging request names it.
 * @param {string} key - A key from {@link stageKey}.
 * @returns {{old?: number, new?: number}} The coordinate.
 */
function stageCoordinate(key) {
  const number = Number(key.slice(key.indexOf(':') + 1));
  return key.startsWith('old:') ? { old: number } : { new: number };
}

/**
 * The keys of a hunk's changed lines, in file order.
 * @param {DiffHunk} hunk - The hunk.
 * @returns {string[]} The keys.
 */
function changedKeys(hunk) {
  /** @type {string[]} */
  const keys = [];
  for (const line of hunk.lines) {
    const key = stageKey(line);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/**
 * The root font size, which the zoom preference sets.
 * @returns {number} Pixels per rem.
 */
function remInPx() {
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/** How a file with no text patch to show says so, by the status git gave it. */
const STATUS_NOTICES = {
  binary: markForTranslation('Binary file. No text diff.'),
  conflicted: markForTranslation('Unresolved merge conflict.'),
  truncated: markForTranslation('This patch was cut short; the counts cover the whole file.'),
  large: markForTranslation('This file is too large to diff here.'),
};

/**
 * One hunk of a server patch in the renderer's own shape. The server counts
 * lines from one and names its sides `old`/`new`; the client diff numbers lines
 * the same way, so the two inputs meet here and part of the renderer beyond this
 * point knows which produced them.
 * @param {any} hunk - A hunk as the git tool's diff returned it.
 * @returns {DiffHunk} The hunk to render.
 */
function hunkFromPatch(hunk) {
  const lines = (Array.isArray(hunk?.lines) ? hunk.lines : []).map((/** @type {any} */ line) => /** @type {DiffLine} */ ({
    type: line?.kind === 'add' ? 'add' : (line?.kind === 'remove' ? 'remove' : 'equal'),
    content: typeof line?.text === 'string' ? line.text : '',
    oldLineNum: typeof line?.oldLine === 'number' ? line.oldLine : null,
    newLineNum: typeof line?.newLine === 'number' ? line.newLine : null,
  }));
  return /** @type {DiffHunk} */ ({
    oldStart: Number(hunk?.oldStart) || 0,
    oldCount: Number(hunk?.oldLines) || 0,
    newStart: Number(hunk?.newStart) || 0,
    newCount: Number(hunk?.newLines) || 0,
    heading: typeof hunk?.heading === 'string' ? hunk.heading : '',
    lines,
  });
}

/**
 * Pair a hunk's lines into rows, for drawing the two sides beside each other.
 *
 * An unchanged line is one row holding itself twice — it is the same line in both
 * files. A block of change is a run of removals followed by a run of additions
 * (the order both `computeDiff` and git write), and its rows pair the two runs off
 * one for one: the first removal beside the first addition, so a line and the line
 * that replaced it are read across rather than down. Whichever run is shorter
 * leaves the rows past its end with nothing on that side, which is what says the
 * change was not a replacement but an insertion or a deletion.
 *
 * Pairing by position claims nothing about the lines themselves. It is the whole
 * of what a two-column diff asserts, and it is why this is a rendering decision
 * and not a diffing one.
 * @param {DiffLine[]} lines - The hunk's lines, in file order.
 * @returns {{old: DiffLine|null, new: DiffLine|null}[]} The rows to draw.
 */
function splitRows(lines) {
  /** @type {{old: DiffLine|null, new: DiffLine|null}[]} */
  const rows = [];
  let at = 0;
  while (at < lines.length) {
    const line = /** @type {DiffLine} */ (lines[at]);
    if (line.type === 'equal') {
      rows.push({ old: line, new: line });
      at++;
      continue;
    }
    /** @type {DiffLine[]} */
    const removed = [];
    /** @type {DiffLine[]} */
    const added = [];
    while (at < lines.length && /** @type {DiffLine} */ (lines[at]).type === 'remove') {
      removed.push(/** @type {DiffLine} */ (lines[at]));
      at++;
    }
    while (at < lines.length && /** @type {DiffLine} */ (lines[at]).type === 'add') {
      added.push(/** @type {DiffLine} */ (lines[at]));
      at++;
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ old: removed[k] ?? null, new: added[k] ?? null });
    }
  }
  return rows;
}

/**
 * The blame gutter's cell for a new-side line: the commit's short id and author
 * on the first line of a run from one commit, blank on the rest, and the
 * commit's subject and date as its title. A committed line's cell is a button
 * that names the commit; a line with no blame — a removal, or one the blame
 * does not reach — is an empty cell, which keeps the columns aligned.
 * @param {DiffBlame|null} blame - The blame, null while it is being read.
 * @param {number|null} number - The line's new-side number.
 * @param {boolean} first - Whether it starts a run.
 * @returns {string} The cell as HTML.
 */
function blameCell(blame, number, first) {
  const at = blame && number !== null ? blame.lines[number - 1] : undefined;
  const commit = at === undefined ? undefined : blame?.commits[at];
  if (!commit) return '<span class="line-blame" aria-hidden="true"></span>';
  if (!commit.sha) {
    const label = first ? escapeHtml(t('Not committed')) : '';
    return `<span class="line-blame line-blame--uncommitted" title="${escapeAttr(t('Not committed yet'))}">${label}</span>`;
  }
  const title = t('{summary} — {author}, {date}', {
    summary: commit.summary, author: commit.author,
    date: formatDate(new Date(commit.date * 1000), { dateStyle: 'medium' }),
  });
  const label = first ? `<span class="line-blame-sha">${escapeHtml(commit.sha.slice(0, 7))}</span> ${escapeHtml(commit.author)}` : '';
  return `<button type="button" class="line-blame" data-sha="${escapeAttr(commit.sha)}" title="${escapeAttr(title)}">${label}</button>`;
}

/**
 * One line-number gutter cell.
 *
 * The two sides are written out rather than interpolated so the class list stays
 * a literal: `scripts/css-markup-model` reads these template literals to learn
 * which tag a class lands on, and a class it can only see as `${…}` is one it has
 * to treat as able to land on anything.
 * @param {'old'|'new'} side - Which file's numbering.
 * @param {string} shown - The line's number there as it reads, or '' when it has none.
 * @returns {string} The gutter cell as HTML.
 */
function lineNumberCell(side, shown) {
  return side === 'old'
    ? `<span class="line-num old">${shown}</span>`
    : `<span class="line-num new">${shown}</span>`;
}

/**
 * A line number inside a sentence: localised digits, but never grouped, since a
 * line number is read as a name rather than as a quantity.
 * @param {number} line - The line number.
 * @returns {string} The number as it reads in a label.
 */
function lineNumber(line) {
  return formatNumber(line, { useGrouping: false });
}

/**
 * How one side of a hunk reads aloud.
 * @param {'old'|'new'} side - Which file's numbering.
 * @param {number} start - First line covered.
 * @param {number} count - Lines covered.
 * @returns {string} A literal phrase for the hunk's accessible label.
 */
function sideRange(side, start, count) {
  if (count <= 0) return t('{side, select, old {no old lines} other {no new lines}}', { side });
  if (count === 1) {
    return t('{side, select, old {old line {start}} other {new line {start}}}', { side, start: lineNumber(start) });
  }
  return t('{side, select, old {old lines {start} to {end}} other {new lines {start} to {end}}}',
    { side, start: lineNumber(start), end: lineNumber(start + count - 1) });
}

/**
 * How a hunk reads aloud: what it covers in each file.
 * @param {DiffHunk} hunk - The hunk.
 * @returns {string} The hunk's accessible label.
 */
function hunkLabel(hunk) {
  return t('{oldRange}, {newRange}', {
    oldRange: sideRange('old', hunk.oldStart, hunk.oldCount),
    newRange: sideRange('new', hunk.newStart, hunk.newCount),
  });
}

/**
 * DiffViewer — one file, drawn either as a unified diff with both line-number
 * gutters or as the two sides beside each other.
 *
 * Which layout, and how many unchanged lines it shows around each change, start
 * from the reader's defaults (utils/diff-view-prefs.js) and can then be set on
 * this viewer alone. An override lives as long as the element and no longer: a
 * diff the reader has set for themselves stops following the default, and one
 * they have not follows it the moment it moves. Two columns are refused outright
 * where there is not the width for them, however the preference reads.
 *
 * Two inputs feed it and one renderer draws them. `setDiff` takes the whole of
 * each side, as a tool action persists them, and has the hunks computed by a job
 * that answers after the call returns, so `drawn` is what a caller awaits.
 * `setPatch` takes a patch the server already produced from git, and draws it
 * exactly as sent: recomputing it client-side would replace what git says the
 * change is with a guess made from two files it never returned.
 *
 * It knows about one file and no more. A file rail, a draft, and where comments
 * are kept belong to whatever mounts it; all it does for review is anchor them —
 * it offers a comment anchor per line when it is not read-only, reports the line
 * the reader chose, and draws the comments it is handed back. Staging is the same:
 * given a verb (`setStageable`), it lets the reader pick changed lines and asks
 * for them, by coordinate, to be staged, and leaves the staging to its host.
 * @class
 * @augments JugglerElement
 */
class DiffViewer extends JugglerElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.oldContent = '';
    /** @type {string} @private */
    this.newContent = '';
    /** @type {string} @private */
    this.filePath = '';
    /** @type {number} @private */
    this.startLineNumber = 1;
    // The snapshot drawn, and which input (by generation) and context width it
    // answers; a new input bumps the generation, so an answer for the old one is
    // recognisably not this one's.
    /** @type {number} @private */
    this._generation = 0;
    /** @type {Snapshot|null} @private */
    this._snapshot = null;
    /** @type {{generation: number, context: number}|null} @private */
    this._snapshotKey = null;
    /** @type {{generation: number, context: number, cancel: () => void}|null} @private */
    this._pending = null;
    /** @type {(() => void)[]} @private */
    this._drawnWaiters = [];
    /** @type {'snapshot'|'patch'|'loading'|'error'} @private */
    this.mode = 'snapshot';
    /** @type {DiffPatch|null} @private */
    this.patch = null;
    /** @type {string} @private */
    this.errorText = '';
    /** @type {DiffAnnotation[]} @private */
    this.annotations = [];
    /** @type {boolean} @private */
    this._readOnly = true;
    /** @type {DiffRow[]} @private */
    this._rows = [];
    /** @type {{side: 'old'|'new', line: number}|null} @private */
    this._anchor = null;
    // This viewer's own layout and context width, each null while it is still
    // following the reader's default.
    /** @type {'inline'|'split'|null} @private */
    this._view = null;
    /** @type {number|null} @private */
    this._context = null;
    // Whether there is room here for two columns.
    /** @type {boolean} @private */
    this._wide = false;
    // Whether anything has been drawn yet. A width that changes before a diff has
    // been given is a width nothing was decided from.
    /** @type {boolean} @private */
    this._rendered = false;
    // Staging: the verb the hunk buttons offer (null when the viewer offers no
    // staging), the changed lines the reader has picked, keyed by coordinate (see
    // stageKey), the patch revision they were picked in (null for a snapshot), and
    // the line a shift-click extends from. The hunks last drawn are kept because a
    // hunk button names a rendered hunk, which after regrouping is not necessarily
    // one the server sent.
    /** @type {StageVerb|null} @private */
    this._stageVerb = null;
    /** @type {Set<string>} @private */
    this._picked = new Set();
    /** @type {string|null} @private */
    this._pickRevision = null;
    /** @type {string|null} @private */
    this._pickAnchor = null;
    /** @type {DiffHunk[]} @private */
    this._drawnHunks = [];
    // Blame: whether the host can supply it (and so the toggle is offered),
    // whether the reader has it on, what the host gave for the file shown, and
    // the commit the last new-side line drawn came from, which is what says
    // where a run of one commit's lines starts.
    /** @type {boolean} @private */
    this._blameable = false;
    /** @type {boolean} @private */
    this._blameOn = false;
    /** @type {DiffBlame|null} @private */
    this._blame = null;
    /** @type {number|undefined} @private */
    this._blameRun = undefined;
    // Where the toolbar is drawn when the host has a bar for it (null: over the
    // diff), the hosts already listened to, and whether the counts are drawn.
    /** @type {HTMLElement|null} @private */
    this._controlsHost = null;
    /** @type {WeakSet<HTMLElement>} @private */
    this._wiredHosts = new WeakSet();
    /** @type {boolean} @private */
    this._statsShown = true;
    // What a render indexes once so that drawing a row costs the same however
    // long the diff is: every line the diff holds, by side and number, with
    // where it is; the comments that hang from each line; the comments set
    // aside as outdated; and each comment's place in the order it was given.
    /** @type {Map<string, {hunk: number, at: number}>} @private */
    this._lineIndex = new Map();
    /** @type {Map<string, DiffAnnotation[]>} @private */
    this._lineComments = new Map();
    /** @type {Set<DiffAnnotation>} @private */
    this._staleComments = new Set();
    /** @type {Map<DiffAnnotation, number>} @private */
    this._commentOrder = new Map();
    // The per-line words a render formats once: line numbers, and each side's
    // comment-anchor label around its number (null when formatted per line).
    /** @type {(value: number) => string} @private */
    this._formatLine = lineNumber;
    /** @type {{old: string[]|null, new: string[]|null}} @private */
    this._anchorLabels = { old: null, new: null };
    // The windowed body, null while every row is drawn.
    /** @type {DiffWindow|null} @private */
    this._win = null;
    // Heights learned from drawn rows, for the blocks not yet drawn: a row in
    // each layout, a hunk header, the gap after a hunk, and a comment. Kept
    // across renders, because the same component draws the same rows the same
    // height whichever patch it is showing.
    /** @private */
    this._metrics = { row: { inline: 0, split: 0 }, header: 0, gap: -1, comment: 0 };
    // A node of the host's hung under a line, or with the file's comments; see
    // setAttachment.
    /** @type {{node: HTMLElement, side: 'old'|'new'|'file', line: number|null}|null} @private */
    this._attachment = null;
    /**
     * @param {Event} event - A scroll or resize anywhere in the window.
     * @private
     */
    this._onScroll = (event) => {
      if (!this._win) return;
      // Captured at the window, so it hears whichever ancestor scrolls; one that
      // does not hold this viewer moved nothing it shows.
      const target = event.target;
      if (target instanceof Node && !target.contains(this)) return;
      this._drawWindow(false);
    };
    /** @private */
    this._onPrefsChanged = () => {
      // A viewer the reader has set for themselves has stopped following the
      // default, so a change to the default is not news to it.
      if (this._view === null || this._context === null) this.render();
    };
    this.addEventListener('click', (event) => this._onClick(event));
    this.addEventListener('change', (event) => this._onChange(event));
    this.addEventListener('keydown', (event) => this._onKeyDown(event));
  }

  connectedCallback() {
    // Two columns need room, and how much room there is is not knowable until the
    // element is in a document. Every host of this component fills it BEFORE
    // mounting it — see addDiffViewer in utils/properties-panel-helpers.js — so
    // the first render routinely happens at a width of zero, and mounting is the
    // moment that answer changes. Re-rendering here is therefore the normal path
    // and not a correction: leave it to the observer and its first callback finds
    // the measurement already taken and nothing to report, so a diff drawn while
    // detached stays as it was drawn — offering no layout at all, in a panel with
    // room for both.
    //
    // Only a CROSSING of the threshold re-renders, and only once something has
    // been drawn. The first is what keeps an observer from writing to the element
    // it is measuring on every frame of a column drag — the "ResizeObserver loop
    // completed with undelivered notifications" everyone meets once. The second is
    // what stops a viewer that has been given no diff yet from drawing the empty
    // one it does not have.
    const roomChanged = this._measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (this._measure() && this._rendered) this.render();
        else this._drawWindow(false);
      });
      observer.observe(this);
      this.addCleanup(() => observer.disconnect());
    }
    this.onWindow(DIFF_VIEW_PREFS_EVENT, this._onPrefsChanged);
    this.onWindow('scroll', this._onScroll, { capture: true, passive: true });
    this.onWindow('resize', this._onScroll);
    // A snapshot given while detached has had no job yet; mounting is when it
    // gets one, and the render that asks for it is the one a width change wants.
    if ((roomChanged && this._rendered) || !this._settled()) {
      this.render();
    } else if (this._win) {
      // A window drawn detached was drawn from no measurement and no scroller,
      // and a viewer moved to another host scrolls in another one.
      this._win.scroller = null;
      this._drawWindow(true);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // A viewer that has left the document no longer needs its diff. If it comes
    // back, mounting asks again, and a job that finished meanwhile is cached.
    this._dropRequest();
  }

  /**
   * Note whether there is room for two columns.
   * @returns {boolean} True when the answer changed.
   * @private
   */
  _measure() {
    const wide = this.clientWidth >= SPLIT_MIN_REM * remInPx();
    if (wide === this._wide) return false;
    this._wide = wide;
    return true;
  }

  /**
   * How this viewer is drawing the diff: its own choice, or the default, and
   * never two columns where they will not fit.
   * @returns {'inline'|'split'} The layout in force.
   * @private
   */
  effectiveView() {
    const wanted = this._view ?? defaultDiffView();
    return wanted === 'split' && this._wide ? 'split' : 'inline';
  }

  /**
   * How many unchanged lines this viewer shows around each change: its own
   * choice, or the default. Stored the way the preference stores it, with -1 for
   * the whole file.
   * @returns {number} The context width.
   * @private
   */
  effectiveContext() {
    return this._context ?? defaultDiffContext();
  }

  /**
   * How much of the file around each change this viewer wants, for whoever
   * fetches the patch it draws. A host asks the viewer rather than the preference
   * so there is one answer and not two — this viewer may have been set on its own.
   * @returns {number} The context width, -1 for the whole file.
   */
  get contextLines() {
    return this.effectiveContext();
  }

  /**
   * Draw this diff in a layout of its own, whatever the default is. Null gives it
   * back to the default.
   * @param {'inline'|'split'|null} view - The layout, or null to follow the default.
   * @returns {void}
   */
  setView(view) {
    this._view = view === 'inline' || view === 'split' ? view : null;
    this.render();
  }

  /**
   * Show this many unchanged lines around each change, whatever the default is.
   *
   * A snapshot diff is recomputed at the new width. A server patch can only be
   * narrowed here — the lines to widen it with were never sent — so the request
   * also goes out as a `diff-context-change` event, for a host that is able to ask
   * again. What is drawn in the meantime is the patch in hand, narrowed.
   * @param {number|null} lines - A width, -1 for the whole file, or null to follow
   *   the default.
   * @returns {void}
   */
  setContextLines(lines) {
    this._context = typeof lines === 'number' ? lines : null;
    this.render();
    this._emit('diff-context-change', { contextLines: this.effectiveContext() });
  }

  /**
   * Whether the diff offers comment anchors. Read-only is the default, because
   * every existing host of this component shows history rather than a review.
   * @returns {boolean} True when no anchors are offered.
   */
  get readOnly() {
    return this._readOnly;
  }

  /**
   * @param {boolean} value - False to offer comment anchors.
   */
  set readOnly(value) {
    const next = value !== false;
    if (next === this._readOnly) return;
    this._readOnly = next;
    this.render();
  }

  /**
   * Offer staging, or stop offering it. With a verb, every changed line can be
   * picked — a click toggles it, shift-click extends from the last line clicked,
   * Space toggles the focused one — and each hunk header carries a button that
   * dispatches a bubbling `diff-stage-request` whose detail is
   * `{verb, revision, context, lines}`: `lines` are the picked lines of that
   * rendered hunk, or every changed line of it when none is picked, each as
   * `{old: n}` for a removal or `{new: n}` for an addition; `revision` and
   * `context` are the patch's own. The viewer stages nothing itself, and keeps the
   * selection after a request; the host clears it, or a new revision does.
   * @param {StageVerb|null} verb - What the buttons offer, or null for no staging.
   *   Turning staging off drops the selection.
   * @returns {void}
   */
  setStageable(verb) {
    const next = verb === 'stage' || verb === 'unstage' || verb === 'discard' ? verb : null;
    if (next === this._stageVerb) return;
    this._stageVerb = next;
    if (next === null) this._clearPicks();
    this.render();
  }

  /**
   * Offer a blame gutter, or stop offering it. Offered, the toolbar has a Blame
   * toggle; turning it on or off dispatches a bubbling `diff-blame-toggle`
   * whose detail is `{on}`, and the host answers an `on` with `setBlame`.
   * While it is on, each new-side line has a cell naming the commit that last
   * changed it, and a click on one dispatches `diff-blame-select` with the
   * commit's `{sha}`. Withdrawn, the gutter goes too.
   * @param {boolean} offered - Whether the host can blame this file.
   * @returns {void}
   */
  setBlameable(offered) {
    const next = offered === true;
    if (next === this._blameable) return;
    this._blameable = next;
    if (!next) this._blame = null;
    this.render();
  }

  /**
   * Draw the toolbar (blame, layout, context) into an element of the host's
   * rather than over the diff — a host with a bar of its own above the diff
   * puts them there, so the file has one row of controls instead of two. The
   * element takes the `diff-viewer-controls` class, and the viewer answers
   * clicks and changes in it as it does its own. Null puts them back.
   * @param {HTMLElement|null} host - Where the controls go.
   * @returns {void}
   */
  setControlsHost(host) {
    if (host === this._controlsHost) return;
    this._controlsHost?.replaceChildren();
    this._controlsHost?.classList.remove('diff-viewer-controls');
    this._controlsHost = host;
    if (host) {
      host.classList.add('diff-viewer-controls');
      if (!this._wiredHosts.has(host)) {
        this._wiredHosts.add(host);
        host.addEventListener('click', (event) => { if (this._controlsHost === host) this._onClick(event); });
        host.addEventListener('change', (event) => { if (this._controlsHost === host) this._onChange(event); });
      }
    }
    if (this._rendered) this.render();
  }

  /**
   * Show the added and removed counts under the diff, or leave them to the host
   * (which says them beside the file's name).
   * @param {boolean} shown - Whether the viewer draws them.
   * @returns {void}
   */
  setStatsShown(shown) {
    const next = shown !== false;
    if (next === this._statsShown) return;
    this._statsShown = next;
    if (this._rendered) this.render();
  }

  /**
   * Whether the blame gutter is on: what a host asks before reading blame for
   * a file it has just shown.
   * @returns {boolean} True while the reader has it on.
   */
  get blameOn() {
    return this._blameable && this._blameOn;
  }

  /**
   * The blame of the file shown, or null to clear it. A patch for another file
   * clears it too.
   * @param {DiffBlame|null} blame - Which commit each new-side line came from.
   * @returns {void}
   */
  setBlame(blame) {
    this._blame = blame && Array.isArray(blame.lines) && Array.isArray(blame.commits) ? blame : null;
    this.render();
  }

  /**
   * The lines the reader has picked to stage, in file order.
   * @returns {{old?: number, new?: number}[]} Each picked line by its coordinate.
   */
  getStageSelection() {
    const drawn = this._drawnHunks.flatMap(changedKeys).filter((key) => this._picked.has(key));
    const inDiff = new Set(drawn);
    const undrawn = [...this._picked].filter((key) => !inDiff.has(key));
    return [...drawn, ...undrawn].map(stageCoordinate);
  }

  /**
   * Unpick every line.
   * @returns {void}
   */
  clearStageSelection() {
    this._clearPicks();
    this._paintStageMarks();
  }

  /** @private */
  _clearPicks() {
    this._picked.clear();
    this._pickAnchor = null;
  }

  /**
   * Draw the difference between two whole files.
   *
   * Nothing is diffed or highlighted in this call. What it draws at once is the
   * header and a loading notice, unless the same input has been drawn recently
   * and its result is cached; the diff itself follows from a job that starts once
   * the viewer is in a document, and is never started at all for a viewer that
   * leaves first or is given new input first. `drawn` says when it has arrived.
   * @param {string} oldContent
   * @param {string} newContent
   * @param {string} filePath
   * @param {number} [startLineNumber=1]
   */
  setDiff(oldContent, newContent, filePath, startLineNumber = 1) {
    this._clearPicks();
    this._pickRevision = null;
    this.mode = 'snapshot';
    this.patch = null;
    this.errorText = '';
    this.oldContent = oldContent || '';
    this.newContent = newContent || '';
    this.filePath = filePath || '';
    this.startLineNumber = startLineNumber;
    this._generation++;
    this._snapshot = null;
    this._snapshotKey = null;
    this.render();
  }

  /**
   * Draw a patch the server produced, hunk for hunk.
   * @param {any} patch - A {@link import('../lib/diff-types.js').FileDiff}, as its host hands it over.
   * @param {DiffAnnotation[]} [annotations] - The comments to draw against it:
   *   the same as calling `setAnnotations` straight after, in one render rather
   *   than two. Absent, the comments already given are kept.
   */
  setPatch(patch, annotations) {
    if (annotations !== undefined) this.annotations = Array.isArray(annotations) ? annotations : [];
    // A picked line is a coordinate in one revision of the diff; in another, the
    // same number may be a different line, or no change at all. A loading or
    // error state in between leaves the selection alone.
    const revision = typeof patch?.revision === 'string' ? patch.revision : '';
    if (revision !== this._pickRevision) this._clearPicks();
    this._pickRevision = revision;
    this.mode = 'patch';
    this.errorText = '';
    this.oldContent = '';
    this.newContent = '';
    this.startLineNumber = 1;
    const path = typeof patch?.path === 'string' ? patch.path : '';
    if (path !== this.filePath) this._blame = null;
    this.filePath = path;
    this.patch = /** @type {DiffPatch} */ ({
      repo: typeof patch?.repo === 'string' ? patch.repo : '',
      path: this.filePath,
      oldPath: typeof patch?.oldPath === 'string' ? patch.oldPath : '',
      status: typeof patch?.status === 'string' ? patch.status : '',
      binary: patch?.binary === true,
      conflicted: patch?.conflicted === true,
      truncated: patch?.truncated === true,
      added: Number(patch?.added) || 0,
      removed: Number(patch?.removed) || 0,
      revision: typeof patch?.revision === 'string' ? patch.revision : '',
      // The context width this patch was produced at, which is what says whether a
      // narrower view can be had from it alone. A patch from before the server
      // reported it is read as holding everything, which is the assumption that
      // regroups rather than the one that silently shows the wrong width.
      context: Number.isFinite(patch?.context) ? Number(patch.context) : Infinity,
      hunks: (Array.isArray(patch?.hunks) ? patch.hunks : []).map(hunkFromPatch),
    });
    this.render();
  }

  /** Show that a patch has been asked for and has not arrived. */
  setLoading() {
    this.mode = 'loading';
    this.errorText = '';
    this.render();
  }

  /**
   * Show that the patch could not be had, and what went wrong.
   * @param {unknown} error - The failure, whose own text is kept verbatim.
   */
  setError(error) {
    this.mode = 'error';
    this.errorText = error instanceof Error ? errorText(error) : String(error ?? '');
    this.render();
  }

  /**
   * Draw these comments against the diff. Each is anchored to a side and a line
   * of the patch it was written against; one whose revision has moved on, or
   * whose line this patch no longer holds, is set aside rather than attached to
   * whatever now occupies that number.
   * @param {DiffAnnotation[]} annotations - The comments to draw.
   */
  setAnnotations(annotations) {
    this.annotations = Array.isArray(annotations) ? annotations : [];
    this.render();
  }

  /**
   * Hang a node of the host's — a comment being written — under a line of the
   * diff, after the comments already there, or with the file's comments when it
   * is about the whole file or the line is not in the diff. The viewer puts it
   * back after every redraw, and in a windowed diff keeps the rows around that
   * line drawn however far the reader scrolls, so half-written words are where
   * they were left. The node stays the host's: the viewer never removes it, and
   * forgets it when given null.
   * @param {HTMLElement|null} node - The node, or null to stop hanging one.
   * @param {{side: 'old'|'new'|'file', line?: number}} [anchor] - Where.
   * @returns {void}
   */
  setAttachment(node, anchor) {
    const side = anchor?.side === 'old' || anchor?.side === 'new' ? anchor.side : 'file';
    const line = typeof anchor?.line === 'number' ? anchor.line : null;
    this._attachment = node ? { node, side, line } : null;
    // Drawing first, so a line that has to be pinned is in the document to hang from.
    this._drawWindow(false);
    this._hangAttachment();
  }

  /**
   * Put the host's node where setAttachment said, without moving it when it is
   * there already — moving a node takes the focus out of it.
   * @private
   */
  _hangAttachment() {
    const attachment = this._attachment;
    if (!attachment) return;
    const { node, side, line } = attachment;
    if (side !== 'file' && line !== null) {
      const drawn = this.querySelector(side === 'old' ? `.diff-line[data-old-line="${line}"]` : `.diff-line[data-new-line="${line}"]`);
      // In two columns the line is a cell of a row, and what hangs from it hangs
      // from the row, as its comments do.
      const row = drawn?.closest('.diff-row') || drawn;
      if (row) {
        const next = row.nextElementSibling;
        const after = next?.classList.contains('diff-comments') ? next : row;
        if (after.nextElementSibling !== node) after.after(node);
        return;
      }
    }
    const home = this.querySelector('diff-file-comments') || this.querySelector('diff-content') || this;
    if (node.parentNode !== home) home.append(node);
  }

  /**
   * Resolves once what is drawn is the diff for the current input — at once for
   * a patch, a loading or an error state, and for a snapshot once its job has
   * answered. A snapshot's job only runs while the viewer is in a document, so
   * this waits for a detached one to be mounted.
   * @returns {Promise<void>} Settles when the diff is drawn.
   */
  get drawn() {
    if (this._settled()) return Promise.resolve();
    return new Promise((resolve) => { this._drawnWaiters.push(resolve); });
  }

  /**
   * Whether the snapshot drawn is the one the current input and context ask for.
   * @returns {boolean} True when nothing is still to come.
   * @private
   */
  _settled() {
    if (this.mode !== 'snapshot') return true;
    const have = this._snapshotKey;
    return this._snapshot !== null && have !== null && have.generation === this._generation
      && have.context === contextToRender(this.effectiveContext());
  }

  /**
   * Make sure the snapshot the current input and context ask for is drawn, or on
   * its way: taken from the cache when it is known, asked for when the viewer is
   * in a document, and otherwise left until it is. A request for anything else is
   * cancelled first. Changing only the context keeps the snapshot already drawn
   * until its replacement arrives, so the reader keeps the diff they had rather
   * than a notice.
   *
   * A server patch is never sent here: it arrives already hunked, and is never
   * highlighted either — its hunks are snippets, and the lexical state that
   * decides whether a line is inside a block comment or a multiline string is in
   * the part of the file the patch left out.
   * @private
   */
  _syncSnapshot() {
    if (this.mode !== 'snapshot') {
      this._dropRequest();
      return;
    }
    const generation = this._generation;
    const context = contextToRender(this.effectiveContext());
    if (this._settled()) return;
    const pending = this._pending;
    if (pending && pending.generation === generation && pending.context === context) return;
    this._dropRequest();

    /** @type {SnapshotInput} */
    const input = {
      oldContent: this.oldContent,
      newContent: this.newContent,
      filePath: this.filePath,
      startLineNumber: this.startLineNumber,
      contextLines: context,
    };
    const known = cachedSnapshot(input);
    if (known) {
      this._snapshot = known;
      this._snapshotKey = { generation, context };
      return;
    }
    if (!this.isConnected) return;
    const cancel = requestSnapshot(input, (result) => {
      this._pending = null;
      this._snapshot = result;
      this._snapshotKey = { generation, context };
      this.render();
    });
    this._pending = { generation, context, cancel };
  }

  /**
   * Withdraw the request in flight, if there is one.
   * @private
   */
  _dropRequest() {
    this._pending?.cancel();
    this._pending = null;
  }

  /**
   * What to draw, from whichever input was given.
   * @returns {{hunks: DiffHunk[], notices: DiffNotice[], added: number, removed: number, drawable: boolean}}
   *   The hunks, what has to be said about them, and the counts to report.
   * @private
   */
  viewModel() {
    /** @type {DiffNotice[]} */
    const notices = [];

    if (this.mode === 'loading') {
      return { hunks: [], notices: [{ kind: 'loading', text: t('Loading…') }], added: 0, removed: 0, drawable: false };
    }
    if (this.mode === 'error') {
      notices.push({ kind: 'error', text: t("Couldn't load this diff."), detail: this.errorText });
      return { hunks: [], notices, added: 0, removed: 0, drawable: false };
    }

    const patch = this.patch;
    if (this.mode === 'patch' && patch) {
      if (patch.binary) notices.push({ kind: 'binary', text: t(STATUS_NOTICES.binary) });
      if (patch.conflicted) notices.push({ kind: 'conflicted', text: t(STATUS_NOTICES.conflicted) });
      if (patch.truncated) notices.push({ kind: 'truncated', text: t(STATUS_NOTICES.truncated) });
      // The patch was produced at some context width, and the reader may have
      // asked for a narrower one since. Regrouping gives them that immediately
      // and exactly; a wider one has to come from whoever fetched this, and until
      // it does, what is drawn is what we have. The counts are the patch's own
      // either way — narrowing the view of a change does not change the change.
      const context = contextToRender(this.effectiveContext());
      const hunks = context < (patch.context ?? Infinity)
        ? regroupHunks(patch.hunks, context)
        : patch.hunks;
      return { hunks, notices, added: patch.added, removed: patch.removed, drawable: !patch.binary };
    }

    // A snapshot is diffed by a job (lib/diff-snapshot-client.js), and until it
    // answers there is nothing to draw but the shell. The line diff refuses a
    // changed region past its own budget rather than run without end.
    const snapshot = this._snapshot;
    if (!snapshot) {
      return { hunks: [], notices: [{ kind: 'loading', text: t('Loading…') }], added: 0, removed: 0, drawable: false };
    }
    if (snapshot.hunks === null) {
      notices.push({ kind: 'large', text: t(STATUS_NOTICES.large) });
      return { hunks: [], notices, added: 0, removed: 0, drawable: false };
    }
    return { hunks: snapshot.hunks, notices, added: snapshot.added, removed: snapshot.removed, drawable: true };
  }

  /**
   * Draw everything: the shell, and either every row or — past EAGER_ROW_LIMIT —
   * the rows in view. What it costs past the indexing (a pass over the lines in
   * plain JavaScript, no DOM) is bounded by the window, not by the patch.
   * @private
   */
  render() {
    this._syncSnapshot();
    const model = this.viewModel();
    this.indexRows(model.hunks);
    this._drawnHunks = model.hunks;
    this._indexAnnotations();
    this._prepareLineText();

    const view = this.effectiveView();
    const layout = this._layOut(model.hunks, view);
    const bodyHTML = this.renderBody(layout, model.drawable);
    const controlsHTML = this.renderControls(view);
    const noticesHTML = model.notices.map((notice) => this.renderNotice(notice)).join('');
    const fileCommentsHTML = this.renderFileComments();
    const label = this.diffLabel();

    // The layout in force is on the element itself, so the stylesheet reads the
    // renderer's decision rather than making a second one of its own.
    this.dataset.view = view;
    if (this._stageVerb) this.dataset.stage = this._stageVerb;
    else delete this.dataset.stage;
    if (this.blameOn) this.dataset.blame = '';
    else delete this.dataset.blame;

    // The host's node goes out with the markup it is hung in; whatever had the
    // focus in it gets it back once the node is back.
    const attached = this._attachment?.node;
    const active = document.activeElement;
    const refocus = attached && active instanceof HTMLElement && attached.contains(active) ? active : null;
    const previous = this._win;
    this._win = null;

    const statsHTML = this._statsShown ? `
        <diff-stats>
          <span class="add-count">+${escapeHtml(formatNumber(model.added))}</span>
          <span class="remove-count">-${escapeHtml(formatNumber(model.removed))}</span>
        </diff-stats>` : '';
    if (this._controlsHost) this._controlsHost.innerHTML = controlsHTML;
    this.innerHTML = `
      <diff-content>
        <diff-header>
          ${escapeHtml(this.filePath || t('File diff'))}
        </diff-header>
        ${this._controlsHost ? '' : controlsHTML}
        ${noticesHTML}
        <diff-body role="group" aria-label="${escapeAttr(label)}">
          ${bodyHTML}
        </diff-body>
        ${fileCommentsHTML}
        ${statsHTML}
      </diff-content>
    `;
    this._rendered = true;
    if (layout.windowed) this._mountWindow(layout, previous);
    this._hangAttachment();
    if (refocus?.isConnected) refocus.focus({ preventScroll: true });
    if (this._settled() && this._drawnWaiters.length > 0) {
      const waiters = this._drawnWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * How this diff is drawn, offered to the reader.
   *
   * Drawn quiet and brought forward on hover, the way the comment anchors are: a
   * transcript can hold a hundred of these, and a control shouting from every one
   * of them would cost more than it is worth to the reader who wants it.
   *
   * Where there is no room for two columns the layout switch is disabled rather
   * than removed, and says why. Removing it would leave somebody who only ever
   * reads diffs in a narrow panel with no way of finding out the other layout
   * exists — a control that is absent and one that was never built look the same
   * from the outside.
   * @param {'inline'|'split'} view - The layout in force.
   * @returns {string} The controls as HTML.
   * @private
   */
  renderControls(view) {
    if (this.mode === 'loading' || this.mode === 'error') return '';

    const context = this.effectiveContext();
    const options = CONTEXT_CHOICES.map((lines) => {
      const selected = lines === context ? ' selected' : '';
      return `<option value="${lines}"${selected}>${escapeHtml(contextLabel(lines))}</option>`;
    }).join('');

    /**
     * @param {'inline'|'split'} which - The layout the button stands for.
     * @param {string} label - What it says.
     * @returns {string} The button as HTML.
     */
    const button = (which, label) => `<button type="button" class="btn btn-xs diff-view-btn"`
      + ` data-view="${which}" aria-pressed="${view === which}"`
      + `${this._wide ? '' : ' disabled'}>${escapeHtml(label)}</button>`;

    // On the group rather than on the buttons: a disabled button does not
    // reliably answer the pointer, so a title on one is a title nobody reads.
    const why = this._wide ? '' : ` title="${escapeAttr(t(SPLIT_TOO_NARROW))}"`;

    const blame = this._blameable
      ? `<button type="button" class="btn btn-xs diff-blame-btn" aria-pressed="${this.blameOn}"`
        + ` title="${escapeAttr(t('Show which commit last changed each line'))}">${escapeHtml(t('Blame'))}</button>`
      : '';

    return '<div class="diff-controls">'
      + blame
      + `<span class="diff-view-switch" role="group" aria-label="${escapeAttr(t('Diff layout'))}"${why}>`
      + button('inline', t('Unified', undefined, { context: 'diff layout' }))
      + button('split', t('Split', undefined, { context: 'diff layout' }))
      + '</span>'
      + `<label class="diff-context-picker">${escapeHtml(t('Context', undefined, { context: 'unchanged diff lines' }))}`
      + `<select class="diff-context-select field-input field-input-xs" aria-label="${escapeAttr(t('Unchanged lines to show around each change'))}">${options}</select>`
      + '</label>'
      + '</div>';
  }

  /**
   * Note every line the diff is about to draw, before any of it is drawn. The
   * comment layer asks whether a line is still in the diff, and a line further
   * down the file must not read as missing merely because the renderer has not
   * reached it yet.
   * @param {DiffHunk[]} hunks - What is about to be drawn.
   * @private
   */
  indexRows(hunks) {
    this._rows = [];
    this._lineIndex = new Map();
    for (const [hunk, { lines }] of (hunks || []).entries()) {
      for (const [at, line] of lines.entries()) {
        // A removal exists only in the old file and an addition only in the new,
        // so each anchors where it lives. A context line is in both: it anchors
        // to the new side, which is the file as it now stands.
        const side = /** @type {'old'|'new'} */ (
          line.type === 'remove' || line.newLineNum === null ? 'old' : 'new');
        this._rows.push({ oldLine: line.oldLineNum, newLine: line.newLineNum, side, text: line.content });
        if (line.oldLineNum !== null && !this._lineIndex.has(`old:${line.oldLineNum}`)) {
          this._lineIndex.set(`old:${line.oldLineNum}`, { hunk, at });
        }
        if (line.newLineNum !== null && !this._lineIndex.has(`new:${line.newLineNum}`)) {
          this._lineIndex.set(`new:${line.newLineNum}`, { hunk, at });
        }
      }
    }
  }

  /**
   * Sort the comments once for the render: each one that still holds is filed
   * under the line it hangs from, and each outdated one is set aside, so a row
   * asks a map rather than every comment and the file comments ask a set.
   * @private
   */
  _indexAnnotations() {
    this._lineComments = new Map();
    this._staleComments = new Set();
    this._commentOrder = new Map();
    for (const [order, annotation] of this.annotations.entries()) {
      this._commentOrder.set(annotation, order);
      if (this.outdated(annotation)) {
        this._staleComments.add(annotation);
        continue;
      }
      if (annotation.side === 'file') continue;
      const key = `${annotation.side === 'old' ? 'old' : 'new'}:${this.anchorLine(annotation)}`;
      const here = this._lineComments.get(key);
      if (here) here.push(annotation);
      else this._lineComments.set(key, [annotation]);
    }
  }

  /**
   * The comments hanging from a row, in the order they were given.
   * @param {number|null} oldLine - The row's old-side number, if it has one.
   * @param {number|null} newLine - Its new-side number, if it has one.
   * @returns {DiffAnnotation[]|null} The comments, or null for none.
   * @private
   */
  _commentsAt(oldLine, newLine) {
    if (this._lineComments.size === 0) return null;
    const old = oldLine === null ? undefined : this._lineComments.get(`old:${oldLine}`);
    const now = newLine === null ? undefined : this._lineComments.get(`new:${newLine}`);
    if (old && now) {
      const order = this._commentOrder;
      return [...old, ...now].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }
    return old || now || null;
  }

  /**
   * Format, once for the render, what every row would otherwise format for
   * itself: the line-number formatter, and each side's comment-anchor label
   * with a slot where the number goes. A label the slot does not come back from
   * intact is formatted per line instead.
   * @private
   */
  _prepareLineText() {
    this._formatLine = numberFormatter(LINE_NUMBER_FORMAT);
    if (this._readOnly) {
      this._anchorLabels = { old: null, new: null };
      return;
    }
    /**
     * @param {'old'|'new'} side - Which file.
     * @returns {string[]|null} The label's escaped text either side of the number.
     */
    const around = (side) => {
      const parts = this.anchorLabel(side, NUMBER_SLOT).split(NUMBER_SLOT);
      return parts.length === 2 ? parts.map((part) => escapeAttr(part)) : null;
    };
    this._anchorLabels = { old: around('old'), new: around('new') };
  }

  /**
   * A line number as the gutter shows it.
   * @param {number|null} number - The number, if there is one.
   * @returns {string} It formatted, or '' for none.
   * @private
   */
  _shownNumber(number) {
    return number === null || number === undefined ? '' : this._formatLine(number);
  }

  /**
   * Cut the hunks into the blocks the body is drawn in: one per hunk while the
   * diff is short enough to draw whole, and runs of BLOCK_ROWS rows when not.
   * @param {DiffHunk[]} hunks - What to draw.
   * @param {'inline'|'split'} view - The layout in force.
   * @returns {DiffLayout} The layout.
   * @private
   */
  _layOut(hunks, view) {
    /** @type {any[][]} */
    const rows = hunks.map((hunk) => (view === 'split' ? splitRows(hunk.lines) : hunk.lines));
    let total = 0;
    for (const list of rows) total += list.length;
    const windowed = total > EAGER_ROW_LIMIT;
    const size = windowed ? BLOCK_ROWS : Infinity;
    /** @type {DiffBlock[]} */
    const blocks = [];
    /** @type {number[]} */
    const hunkFirst = [];
    for (const [hunk, list] of rows.entries()) {
      hunkFirst.push(blocks.length);
      let from = 0;
      do {
        const to = Math.min(list.length, from + size);
        let comments = 0;
        if (windowed && this._lineComments.size > 0) {
          for (let at = from; at < to; at++) {
            const row = list[at];
            const old = view === 'split' ? row.old?.oldLineNum ?? null : row.oldLineNum;
            const now = view === 'split' ? row.new?.newLineNum ?? null : row.newLineNum;
            comments += this._commentsAt(old, now)?.length ?? 0;
          }
        }
        blocks.push({ hunk, from, to, header: from === 0, last: to === list.length, comments });
        from = to;
      } while (from < list.length);
    }
    return { view, rows, blocks, hunkFirst, windowed };
  }

  /**
   * What the diff as a whole is of.
   * @returns {string} The accessible name for the diff region.
   * @private
   */
  diffLabel() {
    const path = this.filePath;
    const named = path ? 'yes' : 'no';
    const from = this.patch?.oldPath;
    if (from && from !== path) {
      return t('{named, select, yes {Diff of {path}, renamed from {from}} other {Diff of this file, renamed from {from}}}',
        { named, path, from });
    }
    return t('{named, select, yes {Diff of {path}} other {Diff of this file}}', { named, path });
  }

  /**
   * @param {DiffNotice} notice - What has to be said.
   * @returns {string} The notice as HTML.
   * @private
   */
  renderNotice(notice) {
    const detail = notice.detail
      ? `<span class="diff-notice-detail">${escapeHtml(notice.detail)}</span>`
      : '';
    return `<diff-notice data-kind="${escapeAttr(notice.kind)}">${escapeHtml(notice.text)}${detail}</diff-notice>`;
  }

  /**
   * The body's markup, in either layout: every block when the diff is drawn
   * whole, and when it is windowed only the two spacers the window is drawn
   * between, which `_mountWindow` sizes and fills.
   * @param {DiffLayout} layout - The blocks.
   * @param {boolean} drawable - Whether a file with no hunks has nothing to show
   *   (rather than nothing showable, which the notices have already said).
   * @returns {string} The body as HTML.
   * @private
   */
  renderBody(layout, drawable) {
    if (layout.blocks.length === 0) {
      return drawable ? `<diff-no-changes>${escapeHtml(t('No changes'))}</diff-no-changes>` : '';
    }
    if (layout.windowed) {
      return '<div class="diff-spacer" aria-hidden="true"></div><div class="diff-spacer" aria-hidden="true"></div>';
    }
    let html = '';
    for (let index = 0; index < layout.blocks.length; index++) html += this.renderBlock(layout, index);
    return html;
  }

  /**
   * One block: a hunk, or in a windowed body a run of one. A run is its own
   * `diff-hunk` carrying the hunk's label, with the header only on the first
   * and the gap after a hunk only on the last (`data-continues` on the rest),
   * so the blocks of one hunk drawn together read as the hunk drawn whole.
   *
   * Each row is the same `.diff-line` either layout draws — in two columns each
   * half of a row is — so every other part of the component, the comment
   * anchors, the line the right button menu reports, which side a selection is
   * in, goes on reading them the way it already does.
   * @param {DiffLayout} layout - The blocks.
   * @param {number} index - Which block.
   * @returns {string} The block as HTML.
   * @private
   */
  renderBlock(layout, index) {
    const block = /** @type {DiffBlock} */ (layout.blocks[index]);
    const hunk = /** @type {DiffHunk} */ (this._drawnHunks[block.hunk]);
    const rows = /** @type {any[]} */ (layout.rows[block.hunk]);
    const label = escapeAttr(hunkLabel(hunk));
    let html = !layout.windowed
      ? `<diff-hunk class="diff-hunk" role="group" aria-label="${label}">`
      : `<diff-hunk class="diff-hunk" role="group" aria-label="${label}" data-block="${index}"${block.last ? '' : ' data-continues=""'}>`;
    if (block.header) html += this.renderHunkHeader(hunk, block.hunk);
    else this._blameRun = this._blameRunBefore(rows, block.from, layout.view);
    for (let at = block.from; at < block.to; at++) {
      html += layout.view === 'split' ? this.renderSplitRow(rows[at]) : this.renderRow(rows[at]);
    }
    return `${html}</diff-hunk>`;
  }

  /**
   * The commit the new-side line before a row came from, which is what decides
   * whether the row's blame cell names its commit or is blank — the state the
   * rows above it would have left, had they been drawn in the same pass.
   * @param {any[]} rows - The hunk's rows in the layout in force.
   * @param {number} from - The row a block starts at.
   * @param {'inline'|'split'} view - The layout.
   * @returns {number|undefined} The commit's index in the blame, if any.
   * @private
   */
  _blameRunBefore(rows, from, view) {
    if (!this.blameOn) return undefined;
    for (let at = from - 1; at >= 0; at--) {
      const line = view === 'split' ? rows[at].new : rows[at];
      const number = line?.newLineNum ?? null;
      if (number !== null) return this._blame ? this._blame.lines[number - 1] : undefined;
    }
    return undefined;
  }

  /**
   * Make the body a window: size the spacers, pin the horizontal extent, and
   * draw what is in view. Heights measured in the last render carry over when it
   * drew the same hunks in the same layout, which is what a comment, a blame or
   * a staging change re-renders with — so the window comes back where it was.
   *
   * The unified view's rows do not wrap and are as wide as the longest of them,
   * which a window would have be only as wide as the longest line it holds: the
   * horizontal scrollbar would change length as the reader scrolled down. So the
   * body is held at least as wide as the longest line in the whole diff, counted
   * in `ch` of the code font (tabs at eight), plus the gutters — see the
   * `--diff-viewer-widest` rule in diff-viewer.css. A line of wide characters
   * can still be wider than its count, and then the body grows to it once drawn.
   * Two columns wrap, so they need none of this.
   * @param {DiffLayout} layout - The blocks.
   * @param {DiffWindow|null} previous - The last render's window, if it had one.
   * @private
   */
  _mountWindow(layout, previous) {
    const body = /** @type {HTMLElement|null} */ (this.querySelector('diff-body'));
    const spacers = body?.querySelectorAll(':scope > .diff-spacer');
    const top = /** @type {HTMLElement|undefined} */ (spacers?.[0]);
    const bottom = /** @type {HTMLElement|undefined} */ (spacers?.[1]);
    if (!body || !top || !bottom) return;
    const count = layout.blocks.length;
    const same = previous !== null && previous.hunks === this._drawnHunks
      && previous.layout.view === layout.view && previous.layout.blocks.length === count;
    /** @type {DiffWindow} */
    const win = {
      layout,
      hunks: this._drawnHunks,
      body,
      top,
      bottom,
      gaps: [],
      heights: same ? previous.heights : new Float64Array(count),
      measured: same ? previous.measured : new Uint8Array(count),
      sums: null,
      drawn: new Map(),
      scroller: previous?.scroller?.isConnected && previous.scroller.contains(this) ? previous.scroller : null,
    };
    this._win = win;
    body.dataset.windowed = '';
    if (layout.view === 'inline') {
      let widest = 0;
      for (const hunk of this._drawnHunks) {
        for (const line of hunk.lines) widest = Math.max(widest, columnsOf(line.content));
      }
      body.style.setProperty('--diff-viewer-widest', `${widest}ch`);
    }
    // The whole height before anything is laid out, so the scroller keeps the
    // offset it had rather than clamping it to a body of two empty spacers.
    bottom.style.height = `${this._sums(win)[count]}px`;
    this._drawWindow(true);
  }

  /**
   * How tall a block is: as measured once it has been drawn, and until then from
   * the heights learned from the rows that have been — or the stylesheet's own
   * sizes, before anything has.
   * @param {DiffBlock} block - The block.
   * @param {'inline'|'split'} view - The layout.
   * @returns {number} Its height, in px.
   * @private
   */
  _estimate(block, view) {
    const rem = remInPx();
    const m = this._metrics;
    const row = m.row[view] || 1.5 * rem + 5;
    const header = block.header ? m.header || 2 * rem : 0;
    const gap = block.last ? (m.gap >= 0 ? m.gap : 0.5 * rem) : 0;
    return (block.to - block.from) * row + header + block.comments * (m.comment || 3 * rem) + gap;
  }

  /**
   * Where each block starts in the body, and the body's height last.
   * @param {DiffWindow} win - The window.
   * @returns {Float64Array} The prefix sum.
   * @private
   */
  _sums(win) {
    if (win.sums) return win.sums;
    const { blocks, view } = win.layout;
    const sums = new Float64Array(blocks.length + 1);
    for (let i = 0; i < blocks.length; i++) {
      const height = win.measured[i] ? /** @type {number} */ (win.heights[i]) : this._estimate(/** @type {DiffBlock} */ (blocks[i]), view);
      sums[i + 1] = /** @type {number} */ (sums[i]) + height;
    }
    win.sums = sums;
    return sums;
  }

  /**
   * The element that scrolls the body: this viewer when its own height is
   * capped, as it is in a transcript or the review panel, or the nearest
   * ancestor that is, as in a properties panel that lets it grow; null when the
   * page itself scrolls. Being overflow-scrollable is not enough — an element
   * whose height is unconstrained grows to fit rather than scrolling — so it has
   * to be shown to hold more than it shows.
   * @returns {HTMLElement|null} The scroller.
   * @private
   */
  _findScroller() {
    for (let node = /** @type {HTMLElement|null} */ (this); node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
      if (scrollable && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  /**
   * What of the body is in view, as heights within it, and where the view's top
   * edge is on screen. A viewer not in a document, or not laid out, is taken to
   * be looking at the top of the diff through a window-sized view.
   * @param {DiffWindow} win - The window.
   * @returns {{from: number, to: number, edge: number}} The view.
   * @private
   */
  _viewRange(win) {
    const fallback = window.innerHeight || 800;
    if (!this.isConnected) return { from: 0, to: fallback, edge: 0 };
    if (!win.scroller) win.scroller = this._findScroller();
    const scroller = win.scroller;
    const edge = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
    const height = (scroller ? scroller.clientHeight : window.innerHeight) || fallback;
    const from = edge - win.body.getBoundingClientRect().top;
    return { from, to: from + height, edge };
  }

  /**
   * Bring the windowed body into line with the view: draw the blocks in it and
   * OVERSCAN_ROWS rows' worth either side, keep those the host's attachment
   * hangs from and the one holding the focus, drop the rest, and stand spacers
   * in for what is not drawn. A block that stays is not touched, so the focus,
   * a hover or a selection in it survives. Every drawn block is then measured,
   * and the scroller moved by however much that shifted what the reader was
   * looking at, so a block above them arriving at its real height does not jump
   * the page.
   *
   * Synchronous, on the scroll event itself and in the render that made the
   * window: a scroll is never shown a gap, and nothing waits on a frame.
   * @param {boolean} force - Measure and lay out even when the same blocks are drawn.
   * @private
   */
  _drawWindow(force) {
    const win = this._win;
    if (!win || win.body !== this.querySelector('diff-body')) return;
    const { layout, body, drawn } = win;
    const count = layout.blocks.length;
    const view = this._viewRange(win);
    const overscan = OVERSCAN_ROWS * (this._metrics.row[layout.view] || 1.5 * remInPx() + 5);
    const sums = this._sums(win);
    const first = blockAt(sums, view.from - overscan);
    const last = blockAt(sums, view.to + overscan);
    /** @type {Set<number>} */
    const wanted = new Set();
    for (let i = first; i <= last && i < count; i++) wanted.add(i);
    for (const pinned of this._pinnedBlocks(win)) wanted.add(pinned);
    if (!force && wanted.size === drawn.size && [...wanted].every((i) => drawn.has(i))) return;

    // What the reader is looking at: the first drawn block reaching into view.
    /** @type {{el: HTMLElement, top: number}|null} */
    let anchor = null;
    for (const i of [...drawn.keys()].sort((a, b) => a - b)) {
      const el = /** @type {HTMLElement} */ (drawn.get(i));
      if (!wanted.has(i)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > view.edge) {
        anchor = { el, top: rect.top };
        break;
      }
    }

    for (const gap of win.gaps) gap.remove();
    win.gaps = [];
    for (const [i, el] of drawn) {
      if (wanted.has(i)) continue;
      el.remove();
      drawn.delete(i);
    }
    const order = [...wanted].sort((a, b) => a - b);
    const template = document.createElement('template');
    let before = win.bottom;
    for (let k = order.length - 1; k >= 0; k--) {
      const i = /** @type {number} */ (order[k]);
      let el = drawn.get(i);
      if (!el) {
        template.innerHTML = this.renderBlock(layout, i);
        el = /** @type {HTMLElement} */ (template.content.firstElementChild);
        body.insertBefore(el, before);
        drawn.set(i, el);
      }
      before = el;
    }
    this._hangAttachment();

    this._learnMetrics(win);
    for (const [i, el] of drawn) {
      const height = el.getBoundingClientRect().height;
      if (height <= 0) continue;
      const block = /** @type {DiffBlock} */ (layout.blocks[i]);
      win.heights[i] = height + (block.last ? Math.max(0, this._metrics.gap) : 0);
      win.measured[i] = 1;
    }
    win.sums = null;
    const next = this._sums(win);

    const start = /** @type {number} */ (order[0] ?? 0);
    const end = /** @type {number} */ (order[order.length - 1] ?? -1) + 1;
    win.top.style.height = `${next[start]}px`;
    win.bottom.style.height = `${/** @type {number} */ (next[count]) - /** @type {number} */ (next[end])}px`;
    for (let k = 1; k < order.length; k++) {
      const a = /** @type {number} */ (order[k - 1]);
      const b = /** @type {number} */ (order[k]);
      if (b === a + 1) continue;
      const gap = document.createElement('div');
      gap.className = 'diff-spacer';
      gap.setAttribute('aria-hidden', 'true');
      gap.style.height = `${/** @type {number} */ (next[b]) - /** @type {number} */ (next[a + 1])}px`;
      body.insertBefore(gap, /** @type {HTMLElement} */ (drawn.get(b)));
      win.gaps.push(gap);
    }

    if (anchor) {
      const moved = anchor.el.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) >= 1) {
        if (win.scroller) win.scroller.scrollTop += moved;
        else window.scrollBy(0, moved);
      }
    }
  }

  /**
   * The blocks a windowed body keeps drawn wherever the reader is: the one the
   * host's attachment hangs from, and the one holding the focus.
   * @param {DiffWindow} win - The window.
   * @returns {number[]} Their indices.
   * @private
   */
  _pinnedBlocks(win) {
    /** @type {number[]} */
    const pinned = [];
    const attachment = this._attachment;
    if (attachment && attachment.side !== 'file' && attachment.line !== null) {
      const at = this._blockOfLine(win.layout, attachment.side, attachment.line);
      if (at !== null) pinned.push(at);
    }
    const active = document.activeElement;
    const holder = active && win.body.contains(active) ? active.closest('[data-block]') : null;
    if (holder instanceof HTMLElement) pinned.push(Number(holder.dataset.block));
    return pinned;
  }

  /**
   * The block a line is drawn in.
   * @param {DiffLayout} layout - The blocks.
   * @param {'old'|'new'} side - Which file.
   * @param {number} line - Its number there.
   * @returns {number|null} The block, or null when the diff does not hold the line.
   * @private
   */
  _blockOfLine(layout, side, line) {
    const where = this._lineIndex.get(`${side}:${line}`);
    if (!where) return null;
    let row = where.at;
    if (layout.view === 'split') {
      const number = side === 'old' ? 'oldLineNum' : 'newLineNum';
      row = (layout.rows[where.hunk] || []).findIndex((pair) => pair[side]?.[number] === line);
      if (row < 0) return null;
    }
    const first = layout.hunkFirst[where.hunk];
    return first === undefined ? null : first + Math.floor(row / BLOCK_ROWS);
  }

  /**
   * Learn, from what has just been drawn, the heights the blocks not yet drawn
   * are estimated from: a row, a header, the gap after a hunk, a comment.
   * @param {DiffWindow} win - The window.
   * @private
   */
  _learnMetrics(win) {
    const m = this._metrics;
    const view = win.layout.view;
    const row = win.body.querySelector(view === 'split' ? '.diff-row' : '.diff-line');
    const rowHeight = row ? row.getBoundingClientRect().height : 0;
    if (rowHeight > 0) m.row[view] = rowHeight;
    const header = win.body.querySelector('diff-hunk-header');
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    if (headerHeight > 0) m.header = headerHeight;
    if (m.gap < 0) {
      const ending = win.body.querySelector('[data-block]:not([data-continues])');
      if (ending && ending.getBoundingClientRect().height > 0) m.gap = parseFloat(getComputedStyle(ending).marginBottom) || 0;
    }
    const comment = win.body.querySelector('.diff-comment');
    const commentHeight = comment ? comment.getBoundingClientRect().height : 0;
    if (commentHeight > 0) m.comment = commentHeight;
  }

  /**
   * A hunk's header: its range and heading, and when the viewer offers staging,
   * the button that stages it or the picked part of it.
   * @param {DiffHunk} hunk - The hunk.
   * @param {number} index - Its place among the hunks drawn.
   * @returns {string} The header as HTML.
   * @private
   */
  renderHunkHeader(hunk, index) {
    // Each hunk names its first line's commit again: the run above it is out of sight.
    this._blameRun = undefined;
    const heading = hunk.heading ? ` ${hunk.heading}` : '';
    const range = escapeHtml(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${heading}`);
    if (!this._stageVerb) return `<diff-hunk-header>${range}</diff-hunk-header>`;
    return `<diff-hunk-header>${range}`
      + `<button type="button" class="btn btn-xs btn-neutral diff-stage-btn" data-hunk="${index}">${escapeHtml(this.stageLabel(hunk))}</button>`
      + '</diff-hunk-header>';
  }

  /**
   * What a hunk's staging button says: the whole hunk, or how many of its lines
   * are picked.
   * @param {DiffHunk} hunk - The hunk.
   * @returns {string} The label, or nothing when the viewer offers no staging.
   * @private
   */
  stageLabel(hunk) {
    const verb = this._stageVerb;
    if (!verb) return '';
    const count = changedKeys(hunk).filter((key) => this._picked.has(key)).length;
    return count === 0 ? t(STAGE_HUNK_LABELS[verb]) : t(STAGE_LINES_LABELS[verb], { count });
  }

  /**
   * The attributes that make a changed line pickable, when the viewer offers
   * staging: a toggle button in the tab order, pressed when picked.
   * @param {DiffLine} line - The line.
   * @returns {string} The attributes, with a leading space, or nothing.
   * @private
   */
  stageAttributes(line) {
    if (!this._stageVerb) return '';
    const key = stageKey(line);
    if (key === null) return '';
    return ` role="button" tabindex="0" aria-pressed="${this._picked.has(key)}"`;
  }

  /**
   * One row of the two-column view: the old line, the new line, and whatever is
   * anchored under either of them.
   * @param {{old: DiffLine|null, new: DiffLine|null}} row - The paired lines.
   * @returns {string} The row as HTML.
   * @private
   */
  renderSplitRow(row) {
    const html = '<div class="diff-row">'
      + this.renderSplitCell(row.old, 'old')
      + this.renderSplitCell(row.new, 'new')
      + '</div>';
    // Comments hang from the row, not from a column: one written on a replaced
    // line is about the replacement, and splitting it between the two halves would
    // put half a conversation in each.
    return html + this.renderLineComments(/** @type {DiffLine} */ ({
      oldLineNum: row.old?.oldLineNum ?? null,
      newLineNum: row.new?.newLineNum ?? null,
    }));
  }

  /**
   * One half of a row. A side with no line for this row is a filler: it carries no
   * line number, no content and no anchor, because there is no line there to
   * number, read or comment on.
   * @param {DiffLine|null} line - The line on this side, if there is one.
   * @param {'old'|'new'} side - Which file this half is.
   * @returns {string} The cell as HTML.
   * @private
   */
  renderSplitCell(line, side) {
    if (!line) {
      return side === 'old'
        ? '<div class="diff-cell-filler old" aria-hidden="true"></div>'
        : '<div class="diff-cell-filler new" aria-hidden="true"></div>';
    }

    const kind = line.type === 'equal' ? 'equal' : line.type;
    const prefix = line.type === 'remove' ? '-' : (line.type === 'add' ? '+' : ' ');
    const number = side === 'old' ? line.oldLineNum : line.newLineNum;
    const data = number !== null ? ` data-${side}-line="${number}"` : '';

    let html = `<div class="diff-line ${kind} ${side}"${data}${this.stageAttributes(line)}>`;
    if (side === 'new') html += this.renderBlame(number);
    html += lineNumberCell(side, this._shownNumber(number));
    html += this.renderAnchor(side, number);
    html += `<span class="line-prefix">${prefix}</span>`;
    html += `<span class="line-content">${this.lineMarkup(line)}</span>`;
    html += '</div>';
    return html;
  }

  /**
   * One line of the diff, and whatever is anchored under it.
   * @param {DiffLine} line - The line.
   * @returns {string} The row as HTML.
   * @private
   */
  renderRow(line) {
    const kind = line.type === 'equal' ? 'equal' : line.type;
    const prefix = line.type === 'remove' ? '-' : (line.type === 'add' ? '+' : ' ');
    const side = /** @type {'old'|'new'} */ (
      line.type === 'remove' || line.newLineNum === null ? 'old' : 'new');

    const numbers = lineNumberCell('old', this._shownNumber(line.oldLineNum))
      + lineNumberCell('new', this._shownNumber(line.newLineNum));
    const data = [
      line.oldLineNum !== null ? ` data-old-line="${line.oldLineNum}"` : '',
      line.newLineNum !== null ? ` data-new-line="${line.newLineNum}"` : '',
    ].join('');

    let html = `<div class="diff-line ${kind}"${data}${this.stageAttributes(line)}>`;
    html += this.renderBlame(line.newLineNum);
    html += numbers;
    html += this.renderAnchor(side, side === 'old' ? line.oldLineNum : line.newLineNum);
    html += `<span class="line-prefix">${prefix}</span>`;
    html += `<span class="line-content">${this.lineMarkup(line)}</span>`;
    html += '</div>';
    return html + this.renderLineComments(line);
  }

  /**
   * A line's blame cell, while the gutter is on: nothing otherwise.
   * @param {number|null} number - Its new-side number, null for a removal.
   * @returns {string} The cell as HTML.
   * @private
   */
  renderBlame(number) {
    if (!this.blameOn) return '';
    const at = this._blame && number !== null ? this._blame.lines[number - 1] : undefined;
    const first = at !== undefined && at !== this._blameRun;
    if (number !== null) this._blameRun = at;
    return blameCell(this._blame, number, first);
  }

  /**
   * The control that asks for a comment on this line.
   * @param {'old'|'new'} side - Which file the line is in.
   * @param {number|null} number - Its line number there.
   * @returns {string} The button as HTML, or nothing when the diff is read-only.
   * @private
   */
  renderAnchor(side, number) {
    if (this._readOnly || number === null) return '';
    const shown = this._formatLine(number);
    const around = this._anchorLabels[side];
    const label = around ? around[0] + escapeAttr(shown) + around[1] : escapeAttr(this.anchorLabel(side, shown));
    return `<button type="button" class="btn btn-icon btn-icon-sm btn-primary diff-comment-btn" data-side="${side}" data-line="${number}"`
      + ` title="${label}" aria-label="${label}">+</button>`;
  }

  /**
   * What a comment anchor says.
   * @param {'old'|'new'} side - Which file the line is in.
   * @param {string} line - Its number, as it reads.
   * @returns {string} The label.
   * @private
   */
  anchorLabel(side, line) {
    return t('Add comment to {side, select, old {old} other {new}} line {line}{named, select, yes { in {path}} other {}}',
      { side, line, named: this.filePath ? 'yes' : 'no', path: this.filePath });
  }

  /**
   * The comments anchored to a line, drawn under it. They sit outside the code
   * row on purpose: the row is as wide as its longest line and scrolls sideways,
   * and a comment dragged off the side of the panel by someone reading the end of
   * a long line would be unreadable exactly when it is being written.
   * @param {DiffLine} line - The line.
   * @returns {string} The comment holder as HTML, or nothing when the line has none.
   * @private
   */
  renderLineComments(line) {
    const here = this._commentsAt(line.oldLineNum, line.newLineNum);
    if (!here) return '';
    const side = /** @type {'old'|'new'} */ (here[0]?.side === 'old' ? 'old' : 'new');
    const number = this.anchorLine(/** @type {DiffAnnotation} */ (here[0]));
    return `<div class="diff-comments" data-side="${side}" data-line="${number}">`
      + here.map((annotation) => this.renderComment(annotation, false)).join('')
      + '</div>';
  }

  /**
   * The comments that belong to the file rather than to a line of it: those
   * written about the whole file, and those whose anchor the file has since
   * moved out from under.
   * @returns {string} The section as HTML, or nothing when there is none.
   * @private
   */
  renderFileComments() {
    const whole = this.annotations.filter((a) => a.side === 'file' && !this.isStale(a));
    const stale = this.annotations.filter((a) => this.isStale(a));
    if (whole.length === 0 && stale.length === 0) return '';

    let html = '<diff-file-comments>';
    if (whole.length > 0) {
      html += '<div class="diff-file-comment-list">'
        + `<h4 class="diff-comment-heading">${escapeHtml(t('Comments on this file'))}</h4>`
        + whole.map((annotation) => this.renderComment(annotation, false)).join('')
        + '</div>';
    }
    if (stale.length > 0) {
      html += '<div class="diff-file-comment-list stale">'
        + `<h4 class="diff-comment-heading">${escapeHtml(t('Outdated comments'))}</h4>`
        + stale.map((annotation) => this.renderComment(annotation, true)).join('')
        + '</div>';
    }
    return `${html}</diff-file-comments>`;
  }

  /**
   * @param {DiffAnnotation} annotation - The comment.
   * @param {boolean} stale - Whether the diff has moved on from under it.
   * @returns {string} The comment as HTML.
   * @private
   */
  renderComment(annotation, stale) {
    const about = this.commentSubject(annotation);
    const quote = stale && Array.isArray(annotation.lineText) && annotation.lineText.length > 0
      ? `<pre class="diff-comment-quote">${escapeHtml(annotation.lineText.join('\n'))}</pre>`
      : '';
    const actions = this._readOnly ? '' : '<div class="diff-comment-actions">'
      + `<button type="button" class="diff-comment-edit" aria-label="${escapeAttr(t('Edit comment on {about, select, file {{named, select, yes {{path}} other {this file}}} other {{side, select, old {old} other {new}} {span, select, range {lines {start} to {line}} other {line {line}}} in {named, select, yes {{path}} other {this file}}}}', about))}">${escapeHtml(t('Edit'))}</button>`
      + `<button type="button" class="diff-comment-delete" aria-label="${escapeAttr(t('Delete comment on {about, select, file {{named, select, yes {{path}} other {this file}}} other {{side, select, old {old} other {new}} {span, select, range {lines {start} to {line}} other {line {line}}} in {named, select, yes {{path}} other {this file}}}}', about))}">${escapeHtml(t('Delete'))}</button>`
      + '</div>';
    const id = typeof annotation.id === 'string' ? annotation.id : '';
    const body = typeof annotation.body === 'string' ? annotation.body : '';
    return `<div class="diff-comment${stale ? ' stale' : ''}" data-id="${escapeAttr(id)}">`
      + quote
      + `<div class="diff-comment-body">${escapeHtml(body)}</div>`
      + actions
      + '</div>';
  }

  /**
   * What a comment is about, said literally enough for a label: the parameters
   * of the edit and delete buttons' messages.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {Record<string, string>} Whether it is on the file or a line, which
   *   side, whether a range, the lines, and the path.
   * @private
   */
  commentSubject(annotation) {
    const named = this.filePath ? 'yes' : 'no';
    const path = this.filePath;
    const line = this.anchorLine(annotation);
    if (annotation.side === 'file' || line === null) return { about: 'file', named, path };
    const start = annotation.startLine;
    return {
      about: 'line',
      side: annotation.side === 'old' ? 'old' : 'new',
      span: typeof start === 'number' && start !== line ? 'range' : 'one',
      start: typeof start === 'number' ? lineNumber(start) : '',
      line: lineNumber(line),
      named,
      path,
    };
  }

  /**
   * The line a comment hangs from: a range hangs from its last line, the way it
   * reads on the page.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {number|null} The line number, or null when it names none.
   * @private
   */
  anchorLine(annotation) {
    const line = typeof annotation.endLine === 'number' ? annotation.endLine : annotation.startLine;
    return typeof line === 'number' ? line : null;
  }

  /**
   * Whether a comment was set aside as outdated by this render.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {boolean} True when it can no longer be trusted to its line.
   * @private
   */
  isStale(annotation) {
    return this._staleComments.has(annotation);
  }

  /**
   * Whether the diff under a comment has changed since it was written. Silence
   * here would be the worst outcome of all: a line number that still exists in a
   * rewritten file would carry the comment onto code the reader never saw.
   * @param {DiffAnnotation} annotation - The comment.
   * @returns {boolean} True when it can no longer be trusted to its line.
   * @private
   */
  outdated(annotation) {
    if (annotation.stale === true) return true;
    const revision = this.patch?.revision;
    if (revision && annotation.revision && annotation.revision !== revision) return true;
    if (annotation.side === 'file') return false;
    const line = this.anchorLine(annotation);
    if (line === null) return true;
    return !this._lineIndex.has(`${annotation.side === 'old' ? 'old' : 'new'}:${line}`);
  }

  /**
   * The syntax-highlighted markup for a line, or its escaped text when the diff
   * is not being highlighted.
   * @param {DiffLine} line
   * @returns {string} Safe HTML for the line's content.
   * @private
   */
  lineMarkup(line) {
    return line.markup ?? escapeHtml(line.content);
  }

  /**
   * The text of the lines a side holds between two numbers, in file order. It is
   * what the reader is looking at, so it goes out with the request: a comment
   * keeps its quote even after the file it was about has moved on.
   * @param {'old'|'new'} side - Which file.
   * @param {number} start - First line.
   * @param {number} end - Last line.
   * @returns {string[]} The lines.
   * @private
   */
  quote(side, start, end) {
    return this._rows
      .filter((row) => {
        const number = side === 'old' ? row.oldLine : row.newLine;
        return number !== null && number >= start && number <= end;
      })
      .map((row) => row.text);
  }

  /**
   * Dispatch the clicks the review layer listens for. Delegated from the element
   * itself so a re-render never leaves a stale listener behind.
   * @param {MouseEvent} event - The click.
   * @private
   */
  _onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest('.diff-blame-btn')) {
      this._blameOn = !this._blameOn;
      this.render();
      this._emit('diff-blame-toggle', { on: this._blameOn });
      return;
    }

    const blamed = target.closest('.line-blame[data-sha]');
    if (blamed instanceof HTMLElement) {
      this._emit('diff-blame-select', { sha: blamed.dataset.sha || '' });
      return;
    }

    const layout = target.closest('.diff-view-btn');
    if (layout instanceof HTMLElement) {
      // Either button switches layout. Clicking the one already in force means
      // the other one — nobody clicks a control to be left where they are.
      const chosen = layout.dataset.view === 'split' ? 'split' : 'inline';
      const current = this.effectiveView();
      this.setView(chosen === current ? (current === 'split' ? 'inline' : 'split') : chosen);
      return;
    }

    const anchor = target.closest('.diff-comment-btn');
    if (anchor instanceof HTMLElement) {
      this._requestComment(anchor, event.shiftKey === true);
      return;
    }

    const stageButton = target.closest('.diff-stage-btn');
    if (stageButton instanceof HTMLElement) {
      this._requestStage(Number(stageButton.dataset.hunk));
      return;
    }

    const pickable = this._stageVerb ? target.closest('.diff-line[aria-pressed]') : null;
    if (pickable instanceof HTMLElement) {
      // A click that ends a drag across the text is the reader selecting it to
      // copy, not picking the line.
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed && selection.containsNode(pickable, true)) return;
      this._pickLine(pickable, event.shiftKey === true);
      return;
    }

    const comment = target.closest('.diff-comment');
    if (!(comment instanceof HTMLElement)) return;
    const id = comment.dataset.id || '';
    if (target.closest('.diff-comment-edit')) this._emit('diff-annotation-edit', { id });
    else if (target.closest('.diff-comment-delete')) this._emit('diff-annotation-delete', { id });
  }

  /**
   * The context picker moved. Delegated like the clicks, for the same reason: the
   * select the reader used is replaced by the re-render their choice causes.
   * @param {Event} event - The change.
   * @private
   */
  _onChange(event) {
    const target = event.target instanceof Element ? event.target : null;
    const select = target?.closest('.diff-context-select');
    if (!(select instanceof HTMLElement)) return;
    const lines = Number(/** @type {any} */ (select).value);
    this.setContextLines(Number.isFinite(lines) ? lines : WHOLE_FILE);
  }

  /**
   * Space on a focused pickable line toggles it, as a click would. Space is
   * the viewer's wherever it lands inside it — it toggles a line, presses a
   * button or scrolls the diff — so it goes no further, and a host's key
   * handler never acts on it as well. Every other key is left to the host: the
   * keys that move between files and act on them belong to whatever hosts the
   * viewer.
   * @param {KeyboardEvent} event - The key.
   * @private
   */
  _onKeyDown(event) {
    if (event.key !== ' ') return;
    event.stopPropagation();
    if (!this._stageVerb) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.diff-line[aria-pressed]')) return;
    event.preventDefault();
    this._pickLine(target, event.shiftKey === true);
  }

  /**
   * The key of the changed line an element draws.
   * @param {Element} element - A `.diff-line`.
   * @returns {string|null} Its key, or null when it is not a changed line.
   * @private
   */
  _lineKey(element) {
    if (!(element instanceof HTMLElement)) return null;
    if (element.classList.contains('remove') && element.dataset.oldLine) return `old:${element.dataset.oldLine}`;
    if (element.classList.contains('add') && element.dataset.newLine) return `new:${element.dataset.newLine}`;
    return null;
  }

  /**
   * Toggle a line, or — held with shift — set every changed line from the last
   * one clicked to this one, in file order, to the state the last one is in.
   * Marked in place rather than re-rendered, so the focus stays on the line.
   * @param {HTMLElement} element - The line clicked.
   * @param {boolean} extend - Whether shift was held.
   * @private
   */
  _pickLine(element, extend) {
    const key = this._lineKey(element);
    if (key === null) return;
    const order = this._drawnHunks.flatMap(changedKeys);
    const anchor = this._pickAnchor;
    const from = extend && anchor !== null ? order.indexOf(anchor) : -1;
    const to = order.indexOf(key);
    if (anchor !== null && from >= 0 && to >= 0) {
      const pick = this._picked.has(anchor);
      for (const each of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        if (pick) this._picked.add(each);
        else this._picked.delete(each);
      }
    } else if (this._picked.has(key)) {
      this._picked.delete(key);
    } else {
      this._picked.add(key);
    }
    this._pickAnchor = key;
    this._paintStageMarks();
  }

  /**
   * Bring what is drawn into line with the selection: each pickable line's
   * pressed state, and each hunk button's count.
   * @private
   */
  _paintStageMarks() {
    for (const line of this.querySelectorAll('.diff-line[aria-pressed]')) {
      const key = this._lineKey(line);
      line.setAttribute('aria-pressed', String(key !== null && this._picked.has(key)));
    }
    for (const button of this.querySelectorAll('.diff-stage-btn')) {
      const hunk = this._drawnHunks[Number(/** @type {HTMLElement} */ (button).dataset.hunk)];
      if (hunk) button.textContent = this.stageLabel(hunk);
    }
  }

  /**
   * Ask for a rendered hunk to be staged: the lines of it that are picked, or all
   * of its changed lines when none is.
   * @param {number} index - The hunk's place among those drawn.
   * @private
   */
  _requestStage(index) {
    const hunk = this._drawnHunks[index];
    const verb = this._stageVerb;
    if (!hunk || !verb) return;
    const all = changedKeys(hunk);
    const picked = all.filter((key) => this._picked.has(key));
    const context = this.patch?.context;
    this._emit('diff-stage-request', {
      verb,
      revision: this.patch?.revision ?? '',
      context: typeof context === 'number' && Number.isFinite(context) ? context : null,
      lines: (picked.length > 0 ? picked : all).map(stageCoordinate),
    });
  }

  /**
   * Ask for a comment on the line this anchor names, or — held with shift — on
   * everything from the last anchor to this one. A range only ever covers one
   * side: a span of old lines and new lines together is not a place a comment
   * could be put back.
   * @param {HTMLElement} anchor - The clicked anchor.
   * @param {boolean} extend - Whether shift was held.
   * @private
   */
  _requestComment(anchor, extend) {
    const side = anchor.dataset.side === 'old' ? 'old' : 'new';
    const line = Number(anchor.dataset.line);
    if (!Number.isFinite(line)) return;

    const from = extend && this._anchor?.side === side ? this._anchor.line : line;
    const startLine = Math.min(from, line);
    const endLine = Math.max(from, line);
    this._anchor = { side, line };
    this._emit('diff-comment-request', {
      repo: this.patch?.repo ?? '',
      path: this.filePath,
      revision: this.patch?.revision ?? '',
      side,
      startLine,
      endLine,
      lines: this.quote(side, startLine, endLine),
    });
  }

  /**
   * @param {string} type - Event name.
   * @param {object} detail - What happened.
   * @private
   */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

customElements.define('diff-viewer', DiffViewer);

/**
 * Which side of the diff a selection is wholly within, or undefined when it
 * covers both or neither. A span of removals is the old file and a span of
 * additions the new one; anything mixed has no one answer, and a reference that
 * picked a side would be naming lines in a file half of them are not in.
 * @param {Element} subject - The diff-viewer element.
 * @returns {'old'|'new'|undefined} The side, when there is exactly one.
 */
function selectedDiffSide(subject) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const touched = Array.from(subject.querySelectorAll('.diff-line'))
    .filter((line) => range.intersectsNode(line));
  if (touched.length === 0) return undefined;
  if (touched.every((line) => line.classList.contains('remove'))) return 'old';
  if (touched.every((line) => line.classList.contains('add'))) return 'new';
  return undefined;
}

// Right-click menu for diffs: copy the changed file's path, the line under the
// pointer and its new content, and paste a reference to the selection. Reads the
// DiffViewer instance's own fields (set via setDiff/setPatch). Offered here
// rather than left to the text-edit menu, which this provider is reached before
// and so would hide.
registerContextMenuProvider({
  match: (start) => start?.closest('diff-viewer') || null,
  build: (subject, event) => {
    const diffViewer = /** @type {any} */ (subject);
    const filePath = diffViewer.filePath || '';
    const newContent = diffViewer.newContent || '';
    const clicked = event?.target instanceof Element ? event.target.closest('.diff-line') : null;
    const lineText = clicked?.querySelector('.line-content')?.textContent || '';
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [{
      label: t('Copy file path'),
      disabled: !filePath,
      onClick: () => { void copyToClipboard(filePath).catch(() => {}); },
    }, {
      label: t('Copy line'),
      disabled: !lineText,
      onClick: () => { void copyToClipboard(lineText).catch(() => {}); },
    }, {
      label: t('Copy new content'),
      disabled: !newContent,
      onClick: () => { void copyToClipboard(newContent).catch(() => {}); },
    }];
    if (filePath) {
      const paste = codeReferenceMenuItem({
        path: filePath,
        outOfRoot: isAbsolutePath(filePath),
        side: selectedDiffSide(subject),
        within: subject,
      });
      if (paste) items.push(paste);
    }
    return items;
  },
});

/**
 * A diff viewer, ready to be given a patch or a pair of snapshots.
 *
 * The element is registered by importing this module, which is why a host that
 * wants one asks for it here rather than calling `document.createElement`: an
 * extension has no way of knowing whether anything else in the window has loaded
 * the component yet, and an unregistered custom element is an inert `<div>` that
 * silently ignores every method called on it.
 * @param {object} [options] - How the viewer should behave.
 * @param {boolean} [options.readOnly=true] - False to offer a comment anchor per
 *   line. An annotatable viewer reports the reader's choice as a bubbling
 *   `diff-comment-request` event and draws back whatever `setAnnotations` is
 *   given; it keeps no comments of its own.
 * @param {{verb: StageVerb}} [options.stage] - Offer line and hunk staging with
 *   this verb; the same as calling `setStageable(verb)`, which says what the
 *   viewer then does. Absent, nothing is pickable and no hunk has a button.
 * @param {boolean} [options.blame] - Offer a blame gutter; the same as calling
 *   `setBlameable(true)`, which says what the viewer then does.
 * @param {boolean} [options.fill] - Fill the container rather than stand in it
 *   as a box of its own: no border, shadow or height cap, and as a flex item it
 *   takes the room left and scrolls within it. For a host that frames the
 *   viewer itself (a pane given over to one diff).
 * @returns {DiffViewer} The element, not yet in the document.
 */
export function createDiffViewer({ readOnly = true, stage, blame = false, fill = false } = {}) {
  const viewer = /** @type {DiffViewer} */ (document.createElement('diff-viewer'));
  if (fill) viewer.classList.add('diff-viewer-fill');
  viewer.readOnly = readOnly;
  if (stage) viewer.setStageable(stage.verb);
  if (blame) viewer.setBlameable(true);
  return viewer;
}
