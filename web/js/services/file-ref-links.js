//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * File-reference links — what activating a file reference in a reply does.
 *
 * References are inline code spans that utils/file-refs.js has confirmed name a
 * file in the conversation's tree. One delegated handler serves them all, so a
 * streaming reply that rebuilds its tail on every delta never has a listener to
 * re-attach. A click (or Enter/Space on a focused one) pins the file to the
 * Pinboard, which reveals the pin instead when it is already there; a Cmd/Ctrl
 * click opens it with the OS, as a link to a project file does (link-guard).
 * The right-click menu comes from the `data-file-path` the reference carries.
 * @module services/file-ref-links
 */

import { FILE_REF_CLASS } from '../utils/file-refs.js';
import { pinFile } from '../utils/properties-panel-helpers.js';
import { openPath } from './ops-api.js';

/**
 * @typedef {object} FileRefActions
 * @property {(path: string) => void} [pin] - Pin the file (default: pinFile).
 * @property {(path: string) => void} [open] - Open it with the OS (default: the os op).
 */

/**
 * The reference an event landed on, if any.
 * @param {Event} e - The event.
 * @returns {HTMLElement|null} The reference element.
 */
function refFor(e) {
  const target = /** @type {Element|null} */ (e.target);
  return /** @type {HTMLElement|null} */ (target?.closest?.(`code.${FILE_REF_CLASS}[data-file-path]`) ?? null);
}

/**
 * Whether the user has text selected inside `el` — the click that ends a drag
 * to copy a path must not also pin it.
 * @param {Element} el - The reference.
 * @returns {boolean} True when a non-empty selection touches it.
 */
function selectingIn(el) {
  const selection = el.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && selection.containsNode(el, true);
}

/**
 * Install the handler on a document.
 *
 * Runs in the bubble phase, leaving an event a nearer handler already claimed
 * alone, and claims the ones it acts on.
 * @param {Document} [doc] - Document to serve (defaults to the current one).
 * @param {FileRefActions} [actions] - Seams for tests.
 * @returns {() => void} Removes the handler again.
 */
export function installFileRefLinks(doc = document, actions = {}) {
  const {
    pin = (path) => { void pinFile(path); },
    open = (path) => { void openPath({ path }).catch(() => {}); },
  } = actions;

  /** @param {Event} e */
  const onClick = (e) => {
    const me = /** @type {MouseEvent} */ (e);
    if (me.defaultPrevented || me.button !== 0) return;
    const ref = refFor(me);
    if (!ref || selectingIn(ref)) return;
    me.preventDefault();
    const path = ref.getAttribute('data-file-path') || '';
    if (me.metaKey || me.ctrlKey) open(path);
    else pin(path);
  };

  /** @param {Event} e */
  const onKeyDown = (e) => {
    const ke = /** @type {KeyboardEvent} */ (e);
    if (ke.defaultPrevented || (ke.key !== 'Enter' && ke.key !== ' ')) return;
    const ref = refFor(ke);
    if (!ref) return;
    ke.preventDefault();
    pin(ref.getAttribute('data-file-path') || '');
  };

  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown);
  return () => {
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKeyDown);
  };
}
