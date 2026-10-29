//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dialog accessibility — the one place a modal panel is announced as a dialog
 * and keeps the keyboard inside it.
 *
 * {@link markDialog} (or {@link dialogAttributes} for a panel built from an
 * HTML string) gives a `<modal-panel>` `role="dialog"`, `aria-modal="true"` and
 * an accessible name: `aria-labelledby` its visible title where it has one,
 * `aria-label` where it does not.
 *
 * {@link trapFocus} cycles Tab and Shift+Tab among the visible, focusable
 * descendants of an open dialog. Modals stack — a confirm over the bin, a skill
 * preview over settings — so traps form a stack too and only the most recently
 * opened one still showing something to focus acts. It handles only an
 * unmodified Tab whose
 * default nothing has already prevented, so a menu that closes on Tab, an
 * autocomplete that accepts on Tab, arrow navigation and Enter all keep working.
 * @module utils/dialog-a11y
 */

let titleIdCounter = 0;

/**
 * A document-unique id for a dialog's title element.
 * @returns {string} The id.
 */
export function newDialogTitleId() {
  titleIdCounter += 1;
  return `dialog-title-${titleIdCounter}`;
}

/**
 * The dialog attributes for a panel written as an HTML string, naming it by the
 * title element that carries `titleId`.
 * @param {string} titleId - The id the title element is given.
 * @returns {string} Attribute markup for the panel's opening tag.
 */
export function dialogAttributes(titleId) {
  return `role="dialog" aria-modal="true" aria-labelledby="${titleId}"`;
}

/**
 * Mark a panel as a modal dialog named by `name`: its visible title element
 * (given an id if it has none), or a label string when it shows no title.
 * @param {Element|null} panel - The dialog's panel.
 * @param {Element|string|null} name - The title element, or the label.
 */
export function markDialog(panel, name) {
  if (!panel) return;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (typeof name === 'string') {
    panel.removeAttribute('aria-labelledby');
    panel.setAttribute('aria-label', name);
  } else if (name) {
    if (!name.id) name.id = newDialogTitleId();
    panel.removeAttribute('aria-label');
    panel.setAttribute('aria-labelledby', name.id);
  }
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/**
 * The elements Tab can reach inside `root`, in order. An element that lays out
 * no box (`display: none` on it or an ancestor) or is invisible is skipped.
 * @param {Element} root - The dialog root.
 * @returns {HTMLElement[]} The tab stops.
 */
function tabStops(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE))).filter((el) =>
    el.tabIndex >= 0
    && el.getClientRects().length > 0
    && !el.closest('[inert]')
    && getComputedStyle(el).visibility !== 'hidden');
}

/** @type {Element[]} - Open traps, most recently opened last. */
const traps = [];

/**
 * @param {KeyboardEvent} e
 */
function onKeydown(e) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  // The topmost trap with something to focus: one whose dialog was taken out
  // of the document or hidden without its release running cannot strand Tab.
  /** @type {Element|undefined} */
  let root;
  /** @type {HTMLElement[]} */
  let stops = [];
  for (let i = traps.length - 1; i >= 0 && !root; i--) {
    const candidate = /** @type {Element} */ (traps[i]);
    if (!candidate.isConnected) continue;
    stops = tabStops(candidate);
    if (stops.length > 0) root = candidate;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!root || !first || !last) return;

  const active = document.activeElement;
  const inside = !!active && root.contains(active);
  // Focus outside the dialog is pulled in when it is on the page underneath —
  // nothing, <body>, or an element earlier in the document, which is where the
  // app and any dialog opened before this one sit. An element later in the
  // document is a layer opened over the dialog (a menu, a picker) and keeps
  // its own keyboard.
  if (!inside && active && active !== document.body
    && (root.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING)) return;

  if (!inside) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  }
}

/**
 * Keep Tab and Shift+Tab inside `root` while it is the topmost open dialog.
 * Call when the dialog opens; the returned release is idempotent.
 * @param {Element} root - The dialog (or the element hosting it).
 * @returns {() => void} Release the trap.
 */
export function trapFocus(root) {
  if (traps.length === 0) document.addEventListener('keydown', onKeydown);
  traps.push(root);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = traps.lastIndexOf(root);
    if (at !== -1) traps.splice(at, 1);
    if (traps.length === 0) document.removeEventListener('keydown', onKeydown);
  };
}
