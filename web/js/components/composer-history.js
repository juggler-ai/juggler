//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-history — the composer's prompt-history popup, for composer.js.
 *
 * The history button opens the session's prompt history (the list ArrowUp
 * walks) under a heading: oldest at the top, newest at the bottom beside the
 * box it came from, and a filter field under them all. An entry is a whole
 * message — text and image attachments — and moves as one:
 *   • picking it (click, Enter) puts it in the box in place of what is there,
 *     which is parked in history first, as a rewind's restore does;
 *   • Shift-picking it inserts its text at the caret and adds its images to the
 *     staged ones, leaving the draft where it is;
 *   • its delete button, or Delete / Backspace on the row, takes it out of the
 *     history, for text that should not have been kept.
 *
 * A row shows the first few lines of its entry, and says how many more there
 * are; composer.css clamps a line that wraps. The popup itself may grow large,
 * so a long prompt is readable without being picked.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring composer-schedule.js.
 * @module components/composer-history
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';
import { applyMenuRoles, focusMenuItem } from '../utils/menu-roles.js';
import { whenRevealed } from '../utils/popup-surface.js';
import { BIN_SVG, PAPERCLIP_SVG } from '../utils/icons.js';
import { renderAttachmentChips } from './composer-attachments.js';
import { t } from '../../sdk/lib/i18n.js';

/** Lines of an entry a row shows before saying how many more there are. */
const PREVIEW_LINES = 4;

/**
 * Characters of an entry a row draws at most. A row shows four lines, so
 * this only keeps a pasted log of one enormous line from being laid out whole.
 */
const PREVIEW_CHARS = 2000;

/**
 * What a row shows of an entry: its first lines, with runs of blank lines
 * closed up, and how many lines are left out.
 * @param {string} content - The entry's text.
 * @returns {{text: string, hidden: number}} The preview, and the count of lines not in it.
 */
function previewOf(content) {
  const lines = String(content || '').replace(/\n{3,}/g, '\n\n').split('\n');
  const text = lines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
  return { text, hidden: Math.max(0, lines.length - PREVIEW_LINES) };
}

/**
 * Build the history popup. Presented by the composer's `_historyPopup`, which
 * gives the inner list the menu keyboard.
 * @param {any} composer - Composer instance.
 * @returns {HTMLElement} The detached surface.
 */
export function buildHistoryMenu(composer) {
  const surface = document.createElement('div');
  surface.className = 'dropdown-menu history-menu';
  surface.id = 'history-menu';

  // Says what the list is, for someone who opened it to find out.
  const heading = document.createElement('div');
  heading.className = 'menu-header menu-header-plain caps-label';
  heading.textContent = t('Prompt history');
  surface.appendChild(heading);

  // The menu is the list alone: the filter field under it is not an item.
  const list = document.createElement('menu');
  list.className = 'history-menu-list';
  surface.appendChild(list);

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'history-menu-filter field-input field-input-sm';
  filter.placeholder = t('Filter prompts');
  filter.setAttribute('aria-label', t('Filter prompts'));
  surface.appendChild(filter);

  /** @type {Array<{entry: import('../model/session.js').HistoryMessage, row: HTMLElement}>} */
  let shown = [];

  /** Keep the newest prompts, at the bottom, in view. */
  const scrollToNewest = () => { list.scrollTop = list.scrollHeight; };

  /** Draw the rows the filter leaves standing, oldest first. */
  const render = () => {
    /** @type {import('../model/session.js').HistoryMessage[]} */
    const entries = composer.session?.messageHistory || [];
    const needle = filter.value.trim().toLowerCase();
    const matching = needle ? entries.filter((e) => e.content.toLowerCase().includes(needle)) : [...entries];
    filter.hidden = entries.length === 0;
    list.replaceChildren();
    shown = matching.map((entry) => ({ entry, row: buildRow(entry) }));
    for (const { row } of shown) list.appendChild(row);
    if (!shown.length) list.appendChild(emptyRow(entries.length > 0));
    applyMenuRoles(list, t('Prompt history'));
    scrollToNewest();
  };

  /**
   * Take an entry out of the history and redraw, keeping the keyboard on the
   * row that moved into its place. A row deleted by its button keeps the
   * list where it was scrolled to, rather than jumping back to the newest.
   * @param {import('../model/session.js').HistoryMessage} entry
   */
  const remove = (entry) => {
    const at = shown.findIndex((s) => s.entry === entry);
    const hadFocus = !!shown[at]?.row.contains(document.activeElement);
    const scrolled = list.scrollTop;
    composer.session?.removeMessageFromHistory(entry);
    composer.resetHistoryNavigation();
    render();
    list.scrollTop = scrolled;
    if (!hadFocus) return;
    const next = shown[Math.min(at, shown.length - 1)]?.row;
    if (next) focusMenuItem(list, next);
    else filter.focus();
  };

  /**
   * One entry's row.
   * @param {import('../model/session.js').HistoryMessage} entry
   * @returns {HTMLElement} The row.
   */
  const buildRow = (entry) => {
    const row = document.createElement('li');
    row.className = 'menu-item history-menu-item';

    const { text, hidden } = previewOf(entry.content);
    const body = document.createElement('div');
    body.className = 'history-menu-text';
    body.textContent = text;
    row.appendChild(body);

    const count = entry.attachments?.length || 0;
    if (hidden > 0 || count > 0) {
      const meta = document.createElement('div');
      meta.className = 'history-menu-meta';
      if (hidden > 0) {
        const more = document.createElement('span');
        more.className = 'history-menu-more';
        more.textContent = t('{count, plural, one {+# more line} other {+# more lines}}', { count: hidden });
        meta.appendChild(more);
      }
      if (count > 0) {
        const images = document.createElement('span');
        images.className = 'history-menu-attachments';
        images.innerHTML = PAPERCLIP_SVG;
        images.append(t('{count, plural, one {# image} other {# images}}', { count }));
        meta.appendChild(images);
      }
      row.appendChild(meta);
    }

    // Out of the tab order and hidden from the accessibility tree: the row is
    // the menu item, and Delete on it does the same.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-menu-delete btn-ghost';
    del.tabIndex = -1;
    del.setAttribute('aria-hidden', 'true');
    del.title = t('Remove from history');
    del.innerHTML = BIN_SVG;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      remove(entry);
    });
    row.appendChild(del);

    row.addEventListener('click', (e) => pickHistoryEntry(composer, entry, { insert: e.shiftKey }));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(entry);
      } else if (e.key === 'Enter' && e.shiftKey) {
        // Ahead of the menu keyboard's Enter, which would click without Shift.
        e.preventDefault();
        e.stopImmediatePropagation();
        pickHistoryEntry(composer, entry, { insert: true });
      }
    });
    return row;
  };

  filter.addEventListener('input', render);
  // The filter sits under the newest prompt: ArrowUp climbs into the list from
  // it, and Enter picks the newest prompt the filter left standing.
  filter.addEventListener('keydown', (e) => {
    const newest = shown[shown.length - 1];
    if (e.key === 'ArrowUp' && newest) {
      e.preventDefault();
      focusMenuItem(list, newest.row);
    } else if (e.key === 'Enter' && newest) {
      e.preventDefault();
      pickHistoryEntry(composer, newest.entry, { insert: e.shiftKey });
    }
  });

  render();
  // Once on screen, where a scroll position means something: open on the
  // newest prompts, and give the filter the keyboard — typing is how a long
  // history is meant to be searched (a hidden field cannot take it).
  whenRevealed(filter, () => {
    scrollToNewest();
    if (!filter.hidden) filter.focus();
  });
  return surface;
}

/**
 * The row standing in for an empty list: an empty history says how it fills,
 * a filter that matched nothing says so.
 * @param {boolean} filtered - Whether there are entries the filter hid.
 * @returns {HTMLElement} The row.
 */
function emptyRow(filtered) {
  const row = document.createElement('li');
  row.className = 'menu-item menu-item-hint history-menu-empty';
  row.textContent = filtered
    ? t('No prompt matches that.')
    : t('No prompts yet. Sent prompts, and drafts set aside with {shortcut}, appear here.',
      { shortcut: keyShortcutManager.formatBinding('save-and-clear-prompt') });
  return row;
}

/**
 * Put a history entry in the box: in place of what is there (which is parked
 * in history first), or with `insert`, at the caret, its images added to the
 * staged ones. Either way the popup closes and the box takes the keyboard.
 * @param {any} composer - Composer instance.
 * @param {import('../model/session.js').HistoryMessage} entry
 * @param {{insert?: boolean}} [opts]
 */
function pickHistoryEntry(composer, entry, { insert = false } = {}) {
  composer._historyPopup.close();
  if (insert) {
    insertHistoryEntry(composer, entry);
  } else {
    composer.restoreMessage({ content: entry.content, attachments: entry.attachments || [] });
  }
  // Parking the draft reordered the history ArrowUp walks, and the box now
  // holds a live draft of its own.
  composer.resetHistoryNavigation();
}

/**
 * Insert an entry's text at the caret as an undoable edit (⌘Z takes it back
 * out), and stage its images after the ones already there.
 * @param {any} composer - Composer instance.
 * @param {import('../model/session.js').HistoryMessage} entry
 */
function insertHistoryEntry(composer, entry) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return;
  textarea.focus();
  const before = textarea.value;
  const start = textarea.selectionStart ?? before.length;
  const end = textarea.selectionEnd ?? start;
  const expected = before.slice(0, start) + entry.content + before.slice(end);
  // insertText keeps the edit on the native undo stack and fires the input the
  // box listens on. Its result is not trusted; the fallback writes the value.
  document.execCommand('insertText', false, entry.content);
  if (textarea.value !== expected) {
    textarea.value = expected;
    textarea.selectionStart = textarea.selectionEnd = start + entry.content.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const staged = new Set(composer._pendingAttachments.map((/** @type {{id: string}} */ a) => a.id));
  const added = (entry.attachments || [])
    .filter((r) => r && r.id && !staged.has(r.id))
    .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
  if (added.length) {
    // Appended in place, so an image still uploading keeps its chip.
    composer._pendingAttachments.push(...added);
    renderAttachmentChips(composer);
  }
  composer._persistDraft();
}
