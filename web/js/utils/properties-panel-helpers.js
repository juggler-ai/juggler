//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Properties-panel rendering helpers.
 *
 * Plugin-neutral DOM utilities for building tool-action detail views.
 * Used by PropertiesPanel itself and by ContextItem.renderToolActionDetails
 * implementations in plugin classes — so plugins can render rich UI
 * without coupling to the PropertiesPanel component.
 */

import { revealLabel } from './reveal-label.js';
import { uiPort } from '../services/ui-port.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { registerContextMenuProvider, codeReferenceMenuItem } from '../services/context-menu-service.js';
import { isAbsolutePath } from './code-selection.js';
import { openPath, revealPath } from '../services/ops-api.js';
import { localFilePathFromHref } from '../../sdk/lib/window-control.js';
import pinboardView from '../services/pinboard-view.js';
import { OPEN_IN_NEW_SVG, PIN_SVG } from './icons.js';
import { applyAnsi, stripAnsi } from '../../sdk/lib/ansi.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { createCopyButton } from '../../sdk/lib/copy-button.js';
import { highlightCode } from '../../sdk/lib/syntax-highlight.js';
import { yGet } from '../model/item-accessor.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

// Re-exported so existing importers keep their `properties-panel-helpers`
// import path; the button itself is now a plugin-neutral primitive.
export { createCopyButton };

/**
 * Create a copyable text container with inline copy button.
 * @param {string} text - Text to copy
 * @param {string} [className] - CSS class for the text element
 * @param {{ansi?: boolean, language?: string}} [options] - When `ansi` is set,
 *   render the text as terminal output (parse ANSI colour codes into styled
 *   spans) and copy the escape-stripped visible text to the clipboard. When
 *   `language` is set (e.g. 'bash'), syntax-highlight the text via Prism; the
 *   copy button always yields the raw, un-highlighted text. `ansi` takes
 *   precedence over `language`.
 * @returns {HTMLElement} Wrapper element containing text and copy button
 */
export function createCopyableText(text, className = 'properties-panel-text', { ansi = false, language = '' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'properties-panel-copyable';

  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';

  copyHeader.appendChild(createCopyButton(() => (ansi ? stripAnsi(text) : text)));
  wrapper.appendChild(copyHeader);

  const textEl = document.createElement('pre');
  textEl.className = className;
  if (ansi) {
    applyAnsi(textEl, text);
  } else if (language) {
    textEl.classList.add('syntax-highlight', `language-${language}`);
    textEl.innerHTML = highlightCode(text, language);
  } else {
    textEl.textContent = text;
  }
  wrapper.appendChild(textEl);

  return wrapper;
}

/**
 * Add a labeled subsection containing copyable text.
 * @param {HTMLElement} wrapper
 * @param {string} label
 * @param {string} text
 * @param {string} [className]
 * @param {{ansi?: boolean, language?: string}} [options] - Forwarded to
 *   {@link createCopyableText} (e.g. `{ language: 'bash' }` to syntax-highlight).
 */
export function addSubsection(wrapper, label, text, className = 'properties-panel-code', options = {}) {
  const section = labeledSubsection(label);
  section.appendChild(createCopyableText(text, className, options));
  wrapper.appendChild(section);
}

/**
 * Build a `<properties-panel-subsection>` with a leading `.properties-panel-subtitle`
 * heading, ready for the caller to append its body.
 *
 * Shared scaffolding for the labeled-subsection variants here, and exported for
 * the panels whose body is an element rather than text — {@link addSubsection}
 * only takes a string, so anything richer would otherwise hand-roll this.
 * @param {string} label - Heading text
 * @returns {HTMLElement} The subsection element (label already appended).
 */
export function labeledSubsection(label) {
  const section = document.createElement('properties-panel-subsection');
  const labelEl = document.createElement('h4');
  labelEl.className = 'properties-panel-subtitle';
  labelEl.textContent = label;
  section.appendChild(labelEl);
  return section;
}

/**
 * Add a labeled subsection rendering LLM-provided descriptive text (e.g. a
 * tool call's `description` field) in the shared `.llm-description` style, so
 * the properties panel matches the italic-accent typography used for the same
 * text on the item tile — rather than boxing it as preformatted text.
 * @param {HTMLElement} wrapper
 * @param {string} label
 * @param {string} text
 */
export function addLlmDescription(wrapper, label, text) {
  const section = labeledSubsection(label);

  const textEl = document.createElement('div');
  textEl.className = 'llm-description';
  textEl.textContent = text;
  section.appendChild(textEl);

  wrapper.appendChild(section);
}

/**
 * Add a bare file path display (no heading) with the shared file-action buttons.
 * The path fills the full available width of its row, with the open, copy and
 * reveal buttons pinned to the right. If `info` is provided, it renders as a small
 * annotation (e.g. file size, line count) on its own line below the path row.
 *
 * `options.pin` adds a further button that pins the file to the Pinboard. It takes
 * the absolute path rather than a flag, because the path shown in the row is
 * often the one the model wrote — relative, and no use as a pin's identity. The
 * button is omitted entirely when nothing enabled can pin a file, so it is never
 * present and inert.
 * @param {HTMLElement} wrapper
 * @param {string} path
 * @param {string} [info] - Optional annotation (e.g. "1.2 KB | 42 lines")
 * @param {{pin?: string, directory?: boolean}} [options] - `pin` is the absolute
 *   path to pin; `directory` says the path names a folder.
 */
export function addFilePath(wrapper, path, info, options = {}) {
  const row = document.createElement('div');
  row.className = 'properties-panel-filepath-row';

  const el = document.createElement('div');
  el.className = 'properties-panel-filepath';
  el.textContent = path;
  // Expose the path for the right-click menu (Open / Reveal / Copy path) —
  // see the provider registered at the bottom of this module.
  if (path) el.dataset.filePath = path;
  row.appendChild(el);

  const actions = createFileActions(path, options);
  if (actions) row.appendChild(actions);

  wrapper.appendChild(row);

  if (info) {
    const infoEl = document.createElement('div');
    infoEl.className = 'properties-panel-filepath-info';
    infoEl.textContent = info;
    wrapper.appendChild(infoEl);
  }
}

/**
 * Hand a path to the host OS, and say so when it will not take it.
 *
 * Both of these fail invisibly: no window opens, nothing on screen changes, and
 * the button is indistinguishable from a dead one. The op's own text is the only
 * account of which operational reason it was — no handler for the file type, no
 * `xdg-open` installed, a path on a volume that has gone — so it is carried
 * through rather than replaced.
 * @param {string} path - Absolute path to open.
 * @returns {Promise<void>}
 */
async function openInHost(path) {
  try {
    await openPath({ path });
  } catch (err) {
    uiPort()?.notice(t("Couldn't open that file. {error}", { error: extractErrorMessage(err) }));
  }
}

/**
 * Show a path where it lives, and say so when that fails.
 * @param {string} path - Absolute path to reveal.
 * @returns {Promise<void>}
 */
async function showPath(path) {
  try {
    await revealPath({ path });
  } catch (err) {
    uiPort()?.notice(t("Couldn't show that file. {error}", { error: extractErrorMessage(err) }));
  }
}

/**
 * The row of icon buttons that act on a file: open it, copy its path, reveal it
 * in the file manager, and — when `options.pin` names an absolute path — pin it
 * to the Pinboard. Shared so that everywhere a path is shown offers the same
 * controls in the same order, whether that is a properties panel, a settings
 * tab, the Pinboard's own item toolbar, or a pin listing files of its own.
 * A directory takes the same row one button shorter: handing a folder to the OS
 * and showing it where it lives are the same act, so Open is left out rather than
 * offered twice under two names.
 * @param {string} path - The path to act on. An empty one yields no row at all.
 * @param {{pin?: string, directory?: boolean}} [options] - `pin` is the absolute
 *   path to pin; `directory` says the path names a folder.
 * @returns {HTMLElement|null} The actions container, or null with no path.
 */
export function createFileActions(path, options = {}) {
  if (!path) return null;

  const actions = document.createElement('div');
  actions.className = 'properties-panel-filepath-actions';

  if (!options.directory) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'properties-panel-filepath-btn';
    open.title = t('Open file');
    open.setAttribute('aria-label', t('Open file'));
    open.innerHTML = OPEN_IN_NEW_SVG;
    open.addEventListener('click', () => { void openInHost(path); });
    actions.appendChild(open);
  }

  actions.appendChild(createCopyButton(path, 'properties-panel-filepath-btn', t('Copy path to clipboard')));

  const reveal = document.createElement('reveal-button');
  reveal.setAttribute('path', path);
  actions.appendChild(reveal);

  const pinButton = options.pin
    ? createPinButton(fileSource(options.pin, options.directory === true))
    : null;
  if (pinButton) actions.appendChild(pinButton);

  return actions;
}

/** What pinning something is called, wherever it is offered. */
const PIN_LABEL = markForTranslation('Pin to Pinboard');

/**
 * What a path looks like to the Pinboard: the live file, whatever surface named
 * it, so the button and the menu row ask for one thing.
 * A folder is the same kind of source and a different thing to show — a listing
 * rather than contents — so it says which it is rather than leaving the pin to
 * guess from a path that looks like any other.
 * @param {string} path - The path to pin.
 * @param {boolean} [isDirectory] - Whether the path names a folder.
 * @returns {import('juggler/pinboard-item-type').PinSource} The source to pin.
 */
function fileSource(path, isDirectory = false) {
  return { kind: 'file', path, presentation: 'live', ...(isDirectory ? { isDirectory: true } : {}) };
}

/**
 * Put something on the Pinboard. The caller describes what it has — a file, the
 * current plan, the checklist — and the registry finds the type that wants it,
 * so no panel has to name a pin class.
 *
 * Pinning is a view, not a context change: the thing appears on the board and no
 * conversation is any the wiser. A type that is already on the board is revealed
 * rather than added twice.
 * @param {import('juggler/pinboard-item-type').PinSource} source - What to pin.
 * @returns {Promise<boolean>} True when something enabled took it.
 */
export async function pinSource(source) {
  if (!canPinSource(source)) return false;
  return !!(await pinboardView.addSource(source));
}

/**
 * Whether anything enabled would take this source — for a surface deciding
 * whether to offer to pin it at all.
 * @param {import('juggler/pinboard-item-type').PinSource} source - What would be pinned.
 * @returns {boolean} True when {@link pinSource} would put something on the board.
 */
export function canPinSource(source) {
  return !!source?.kind && pinboardView.canPin(source);
}

/**
 * Put a file on the Pinboard. Shared so that the button, the right-click row and
 * a listing that pins a file of its own all mean one thing.
 * @param {string} path - Absolute path to pin.
 * @returns {Promise<boolean>} True when something enabled took it.
 */
export async function pinFile(path) {
  if (!path) return false;
  return pinSource(fileSource(path));
}

/**
 * The button that puts something on the Pinboard, or null when nothing enabled
 * can take it — a button that does nothing when clicked is worse than no button,
 * so the surface asks first and leaves it out.
 * @param {import('juggler/pinboard-item-type').PinSource} source - What to pin.
 * @param {string} [className] - The button's class, for a surface whose icon
 *   buttons are styled differently from a file path row's.
 * @returns {HTMLElement|null} The button, or null to offer nothing.
 */
function createPinButton(source, className = 'properties-panel-filepath-btn') {
  if (!source?.kind) return null;
  if (!pinboardView.canPin(source)) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = t(PIN_LABEL);
  button.setAttribute('aria-label', t(PIN_LABEL));
  button.innerHTML = PIN_SVG;
  button.addEventListener('click', () => { void pinSource(source); });
  return button;
}

/**
 * The same action as a full-width labelled control, for the panel's controls
 * block — where it sits with Re-run and Delete rather than beside a path.
 *
 * A panel's controls are where an action on the whole item belongs; putting this
 * one in the body would push the thing being read down the panel to make room
 * for a button about it.
 * @param {import('juggler/pinboard-item-type').PinSource|null} source - What to pin.
 * @returns {HTMLElement|null} The control, or null to offer nothing.
 */
export function createPinControl(source) {
  if (!source) return null;
  const button = createPinButton(source, 'properties-panel-btn');
  if (button) button.innerHTML = `${PIN_SVG} ${escapeHtml(t(PIN_LABEL))}`;
  return button;
}

/** What revealing an existing pin is called, wherever it is offered. */
const SHOW_PIN_LABEL = markForTranslation('Show on Pinboard');

/**
 * A pin put on the board earlier, identified well enough to find it again or
 * put it back if the user has removed it since.
 * @typedef {object} PinRef
 * @property {string} pin - The pin's id.
 * @property {string} type - Its item-type id.
 * @property {Record<string, unknown>} config - Its config.
 */

/**
 * Open the Pinboard on a pin that was put there earlier.
 * @param {PinRef} ref - The pin to show.
 * @returns {Promise<boolean>} True when the board is now showing it.
 */
export async function showPin(ref) {
  if (!ref?.pin || !ref.type) return false;
  return pinboardView.show(ref.pin, ref.type, ref.config || {});
}

/**
 * The labelled control that opens the Pinboard on an existing pin, for the
 * panel's controls block beside Delete.
 * @param {PinRef|null} ref - The pin to show.
 * @returns {HTMLElement|null} The control, or null when there is no pin to show.
 */
export function createShowPinControl(ref) {
  if (!ref?.pin || !ref.type) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'properties-panel-btn';
  button.innerHTML = `${PIN_SVG} ${escapeHtml(t(SHOW_PIN_LABEL))}`;
  button.addEventListener('click', () => { void showPin(ref); });
  return button;
}

/**
 * A recorded before/after snapshot of a file, as a tool action's display data
 * carries it under `diffData`.
 * @typedef {object} DiffSnapshot
 * @property {string} oldContent - The file before.
 * @property {string} newContent - The file after.
 * @property {string} path - The file's path, or '' when the snapshot names none.
 * @property {number} startLineNumber - The first line's number, or 0 when unrecorded.
 */

/**
 * The diff snapshot in a tool action's display data, when both sides were recorded.
 * @param {unknown} displayData - The display data, plain.
 * @returns {DiffSnapshot|null} The snapshot, or null when there is none.
 */
function diffSnapshotOf(displayData) {
  if (!displayData || typeof displayData !== 'object' || !('diffData' in displayData)) return null;
  const d = displayData.diffData;
  if (!d || typeof d !== 'object' || !('oldContent' in d) || !('newContent' in d)) return null;
  if (typeof d.oldContent !== 'string' || typeof d.newContent !== 'string') return null;
  return {
    oldContent: d.oldContent,
    newContent: d.newContent,
    path: 'path' in d && typeof d.path === 'string' ? d.path : '',
    startLineNumber: 'startLineNumber' in d && typeof d.startLineNumber === 'number' ? d.startLineNumber : 0,
  };
}

/**
 * Append a diff viewer if the tool-action has a diffData snapshot.
 *
 * An empty side is a recorded snapshot like any other — it is what a file
 * created from nothing, or emptied out, looks like — so the test is that both
 * sides were recorded, not that both hold something. Only a snapshot with
 * nothing on either side has no diff to draw.
 * @param {HTMLElement} wrapper
 * @param {unknown} toolAction - Y.Map for the tool action
 * @param {string} fallbackPath
 * @returns {boolean} True if a diff viewer was added
 */
export function addDiffViewer(wrapper, toolAction, fallbackPath) {
  const diffData = diffSnapshotOf(yGet(toolAction, 'displayData'));
  if (!diffData) return false;
  if (diffData.oldContent === '' && diffData.newContent === '') return false;

  const diffViewer = /** @type {HTMLElement & {setDiff: (oldContent: string, newContent: string, filePath: string, startLineNumber?: number) => void}} */ (
    document.createElement('diff-viewer'));
  diffViewer.classList.add('properties-panel-diff');
  diffViewer.setDiff(
    diffData.oldContent,
    diffData.newContent,
    diffData.path || fallbackPath,
    diffData.startLineNumber || 1
  );
  wrapper.appendChild(diffViewer);
  return true;
}

/**
 * The file a right-clicked element is about: the path a `data-file-path` names,
 * or the on-disk file a link points at. An anchor is asked the same question the
 * click handler asks it (see link-guard), so the menu offers a file exactly when
 * clicking would open one — an external link, an in-page `#anchor` and a
 * non-web scheme are not files and yield nothing, leaving the right-click to the
 * text menu.
 * @param {Element} subject - The matched element.
 * @returns {string} The path, or '' when the element is not about a file.
 */
function fileMenuPath(subject) {
  if (subject.tagName === 'A') {
    const anchor = /** @type {HTMLAnchorElement} */ (subject);
    return localFilePathFromHref(anchor.getAttribute('href') || '', anchor.href) || '';
  }
  return subject.getAttribute('data-file-path') || '';
}

// Right-click menu for file references: pinned @files, read-file results, any
// path rendered via addFilePath, and links to project files in rendered
// markdown. Open / Reveal go through the host-OS `os` op; Copy path is local.
// When the path sits inside a removable context item that attached an unpin hook
// (see FileContentContextItem), a "Remove from context" row is appended.
registerContextMenuProvider({
  // The nearer of the two wins, so a link is about its own href and a file row
  // about its path. One provider rather than two because resolveMenu takes the
  // first that offers rows, which would leave the answer to module load order.
  // A <code-block> carrying a path is declined: its own provider (code-block.js)
  // is the more specific menu for it, and must not depend on load order either.
  match: (start) => {
    const subject = start?.closest('[data-file-path], a[href]') || null;
    return subject && subject.tagName === 'CODE-BLOCK' ? null : subject;
  },
  build: (subject) => {
    const path = fileMenuPath(subject);
    if (!path) return null;
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [
      { label: t('Open file'), onClick: () => { void openInHost(path); } },
      { label: revealLabel(), onClick: () => { void showPath(path); } },
      {
        label: t('Copy path'),
        // The menu row has no button to flash a tick on, so a clipboard the
        // browser refused would otherwise look exactly like one that worked.
        onClick: () => {
          void copyToClipboard(path).catch((err) => {
            uiPort()?.notice(t("Couldn't copy the path. {error}", { error: extractErrorMessage(err) }));
          });
        },
      },
    ];
    // A row whose path covers rendered content may have a selection in it to
    // reference.
    const paste = codeReferenceMenuItem({
      path,
      outOfRoot: isAbsolutePath(path),
      within: subject,
    });
    if (paste) items.push(paste);
    // Offered on the same terms as the pin button: asked first, left out when
    // nothing enabled would take it.
    if (pinboardView.canPin(fileSource(path))) {
      items.push({ label: t(PIN_LABEL), onClick: () => { void pinFile(path); } });
    }
    const host = subject.closest('[data-context-item-id]');
    const unpin = host && /** @type {Element & {_jugglerRemoveFromContext?: unknown}} */ (host)._jugglerRemoveFromContext;
    if (typeof unpin === 'function') {
      items.push({ separator: true });
      items.push({ label: t('Remove from context'), danger: true, onClick: () => unpin() });
    }
    return items;
  },
});
