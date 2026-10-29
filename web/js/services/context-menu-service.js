//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Right-click (context menu) service.
 *
 * One app-wide capture-phase `contextmenu` listener (module singleton — `import`
 * is the discovery mechanism, see CLAUDE.md "Frontend service style") that owns
 * every menu the app shows. The dispatch order on a right-click is:
 *
 *  1. **Registered juggler providers.** Components register providers
 *     ({@link registerContextMenuProvider}); the first that claims the target
 *     wins (code blocks, diffs, conversation tabs, file refs…). We render our
 *     own popup and suppress the native menu.
 *
 *  2. **Built-in text-edit menu.** Over an editable field we offer
 *     Cut/Copy/Paste/Select All; over a plain text selection, just Copy. We own
 *     these instead of delegating to the native WKWebView menu *on purpose*: in
 *     a non-`production` build WKWebView's native edit menu always carries
 *     "Inspect Element", and on macOS it also injects "Writing Tools" /
 *     "Look Up" / "Translate" / "Share". The page can only choose whether to
 *     show the native menu at all — it cannot strip individual items — so the
 *     only way to keep clean, relevant edit menus (and no Inspect Element over a
 *     read-only paragraph) is to render them ourselves. A touch long-press is
 *     the exception: it is a text selection starting, and the platform's own
 *     selection toolbar is left to serve it.
 *
 *  3. **Native fallback, dev-mode only.** When nothing juggler-specific applies
 *     and we're in runtime dev-mode (`window.JUGGLER_DEV_MODE`, injected by the
 *     index template from the server's `--dev`/`--assets-from-disk`/config flag), we let
 *     the event fall through so the native debug menu (Reload / Inspect Element)
 *     stays reachable by right-clicking any non-text region. We seed
 *     `window._wails.environment.Debug` from the same flag so the Wails runtime's
 *     own handler agrees and allows that native menu. Outside dev-mode we
 *     `preventDefault()` so the native menu never appears anywhere.
 *
 * Net effect: content menus are always juggler-owned, text menus are under a
 * mouse, and both stay tidy
 * regardless of build tag or dev-mode; the WKWebView debug menu shows only in a
 * real dev session and only over non-text areas.
 * @module services/context-menu-service
 */

/**
 * A single command row in a juggler context menu.
 * @typedef {object} ContextMenuItem
 * @property {string} [label] - Display text. Omit for a separator.
 * @property {boolean} [separator] - When true, render a divider (ignores other fields).
 * @property {boolean} [disabled] - When true, the row is shown greyed and not clickable.
 * @property {boolean} [danger] - When true, style as a destructive action.
 * @property {() => void} [onClick] - Invoked when the row is chosen.
 */

/**
 * A context-menu provider. `match` decides whether this provider owns the
 * right-clicked element (returning the "subject" element it cares about, or
 * null to decline); `build` turns that subject into the menu rows to show.
 * @typedef {object} ContextMenuProvider
 * @property {(start: Element|null, event: MouseEvent) => (Element|null)} match - Return the subject element this provider owns, or null to decline.
 * @property {(subject: Element, event: MouseEvent) => (ContextMenuItem[]|null)} build - Build the menu rows for a matched subject.
 */

import { copyToClipboard, readFromClipboard } from '../../sdk/lib/clipboard.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { attachMenuKeyboard } from '../utils/menu-roles.js';
import { resolveCodeSelection, proseReference } from '../utils/code-selection.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * The row that puts a reference to the selected file content into the prompt.
 * One spelling, shared by every surface that offers it — the text-edit menu here
 * and the code-block and diff-viewer providers, which are reached first and so
 * have to offer it themselves. English, for comparison: rows carry `t()` of it.
 */
export const PASTE_REFERENCE_LABEL = markForTranslation('Paste path and line number into prompt');

/** @type {ContextMenuProvider[]} @private */
const _providers = [];

/** @type {HTMLElement|null} @private */
let _openMenu = null;

/**
 * Releases this menu's open-state token (from markPopupOpen). Set while a menu
 * is open so the message input's Escape won't cancel a turn underneath it.
 * @type {(() => void)|null}
 * @private
 */
let _releaseOpenState = null;

/**
 * The element the open menu was opened on — the right-clicked target, or the
 * button an {@link openMenuAt} menu hangs off. Scroll dismissal is scoped to it.
 * @type {Element|null}
 * @private
 */
let _anchor = null;

/**
 * What had focus when the open menu opened, to have it back when the menu
 * closes having taken it.
 * @type {HTMLElement|null}
 * @private
 */
let _returnFocus = null;

/**
 * Register a juggler context-menu provider. Call once at module load from the
 * component that owns the relevant DOM + behaviour.
 * @param {ContextMenuProvider} provider
 */
export function registerContextMenuProvider(provider) {
  _providers.push(provider);
}

/**
 * Whether juggler is running in runtime dev-mode (server `--dev` /
 * `--assets-from-disk` / config). Drives the native debug-menu gate.
 * @returns {boolean} True when running in runtime dev-mode.
 */
export function isDevMode() {
  return !!(/** @type {any} */ (window).JUGGLER_DEV_MODE);
}

// Input types that carry editable text (so Cut/Copy/Paste/Select All apply).
// Excludes button/checkbox/radio/range/colour/file/etc.
const EDITABLE_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'email', 'tel', 'password', 'number', '',
]);

/**
 * Is this element an enabled, writable text field (input/textarea) we can edit?
 * @param {Element|null} el - Candidate element.
 * @returns {boolean} True for a focusable, non-readonly, non-disabled text field.
 * @private
 */
function isWritableField(el) {
  if (!el) return false;
  const input = /** @type {HTMLInputElement & HTMLTextAreaElement} */ (el);
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !input.disabled && !input.readOnly;
  if (tag === 'INPUT') {
    const type = (input.getAttribute('type') || '').toLowerCase();
    return EDITABLE_INPUT_TYPES.has(type) && !input.disabled && !input.readOnly;
  }
  return false;
}

/**
 * The nearest contentEditable host of an element, or null. Native
 * `isContentEditable` already walks ancestors, so we just confirm and return
 * the closest editable container.
 * @param {Element|null} el - Candidate element.
 * @returns {HTMLElement|null} The editable host, or null.
 * @private
 */
function contentEditableHost(el) {
  const node = /** @type {HTMLElement|null} */ (el);
  if (node && node.isContentEditable) {
    return /** @type {HTMLElement} */ (node.closest('[contenteditable]')) || node;
  }
  return null;
}

/**
 * Snapshot of the selection inside a text field at right-click time.
 * @param {HTMLInputElement|HTMLTextAreaElement} el - The field.
 * @returns {{start: number, end: number, text: string}} Selection range + text.
 * @private
 */
function fieldSelection(el) {
  const value = el.value || '';
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Write text to the clipboard, swallowing permission failures.
 * @param {string} text - Text to copy.
 * @private
 */
async function writeClipboard(text) {
  try { await copyToClipboard(text); } catch (e) { /* clipboard blocked */ }
}

/**
 * Read text from the clipboard, returning '' when unavailable/blocked.
 * @returns {Promise<string>} Clipboard text, or ''.
 * @private
 */
async function readClipboard() {
  return readFromClipboard();
}

/**
 * Replace the [start,end) range of a field's value with `text`, restore the
 * caret after the inserted text, and fire an `input` event so listeners
 * (autosize, Yjs draft sync, validation) react exactly as for typed input.
 * @param {HTMLInputElement|HTMLTextAreaElement} el - The field.
 * @param {number} start - Range start.
 * @param {number} end - Range end.
 * @param {string} text - Replacement text.
 * @private
 */
function spliceField(el, start, end, text) {
  const value = el.value || '';
  el.value = value.slice(0, start) + text + value.slice(end);
  const caret = start + text.length;
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch (e) { /* type doesn't support it */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Build the built-in edit menu for the right-clicked element. Captures the
 * selection snapshot now (at right-click time) so the actions still work after
 * the popup steals focus. Returns [] when the target is neither editable nor
 * carrying a usable selection — the caller then falls back to native (dev) or
 * suppression (non-dev).
 * @param {Element|null} start - The right-clicked element.
 * @returns {ContextMenuItem[]} Edit-menu rows (possibly empty).
 */
export function buildTextEditMenu(start) {
  const field = isWritableField(start)
    ? /** @type {HTMLInputElement|HTMLTextAreaElement} */ (start)
    : null;
  const editableHost = field ? null : contentEditableHost(start);
  const selectionText = (window.getSelection?.()?.toString()) || '';

  if (field) {
    const sel = fieldSelection(field);
    const hasSel = sel.text.length > 0;
    return [
      { label: t('Cut'), disabled: !hasSel, onClick: () => {
        writeClipboard(sel.text);
        spliceField(field, sel.start, sel.end, '');
      } },
      { label: t('Copy'), disabled: !hasSel, onClick: () => writeClipboard(sel.text) },
      { label: t('Paste'), onClick: async () => {
        const text = await readClipboard();
        if (text) spliceField(field, sel.start, sel.end, text);
      } },
      { separator: true },
      { label: t('Select All'), onClick: () => { field.focus(); field.select(); } },
    ];
  }

  if (editableHost) {
    const hasSel = selectionText.length > 0;
    return [
      { label: t('Cut'), disabled: !hasSel, onClick: () => {
        writeClipboard(selectionText);
        editableHost.focus();
        try { document.execCommand('delete'); } catch (e) { /* best effort */ }
      } },
      { label: t('Copy'), disabled: !hasSel, onClick: () => writeClipboard(selectionText) },
      { label: t('Paste'), onClick: async () => {
        const text = await readClipboard();
        if (!text) return;
        editableHost.focus();
        try { document.execCommand('insertText', false, text); } catch (e) { /* best effort */ }
      } },
    ];
  }

  // Non-editable element with a live selection: copy, and — over content that
  // says which file it is — put a reference to it in the prompt instead of
  // retyping where you mean. Code contributes line numbers; prose has none to
  // give, so the reference names the file alone.
  if (selectionText) {
    /** @type {ContextMenuItem[]} */
    const items = [{ label: t('Copy'), onClick: () => writeClipboard(selectionText) }];
    const reference = resolveCodeSelection(window.getSelection?.());
    // Offered only where there is a composer to put it in: a detached Pinboard
    // window has code to select and nothing to ask.
    if (reference && activeComposer()) {
      items.push({ label: t(PASTE_REFERENCE_LABEL), onClick: () => askAboutSelection(reference) });
    }
    return items;
  }

  return [];
}

/**
 * The composer of the conversation being looked at, or null when this window has
 * none.
 * @returns {any} The composer element, or null.
 * @private
 */
function activeComposer() {
  const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
  return tab?.getComposer?.() || null;
}

/**
 * Quote the current selection into the composer and put the cursor there. The
 * composer writes it (`insertCodeReference`), so the draft around it survives.
 * @param {import('../utils/code-selection.js').CodeSelection} reference - What to quote.
 * @private
 */
function askAboutSelection(reference) {
  const composer = activeComposer();
  if (!composer) return;
  if (composer.insertCodeReference(reference)) {
    composer.querySelector('textarea')?.focus();
  }
}

/**
 * The selected text, but only when the whole selection lies inside the element
 * the menu is about. A selection left behind somewhere else on the page is not
 * this file's content, and quoting it under this file's path would attribute
 * text to a file it was never in.
 * @param {Selection|null|undefined} selection - The document's selection.
 * @param {Element} [within] - The element the selection must be inside.
 * @returns {string} The selected text, or '' when it is elsewhere.
 * @private
 */
function selectionTextWithin(selection, within) {
  if (!selection || !within || selection.rangeCount === 0 || selection.isCollapsed) return '';
  const range = selection.getRangeAt(0);
  if (!within.contains(range.startContainer) || !within.contains(range.endContainer)) return '';
  return range.toString();
}

/**
 * The paste-reference row for the current selection, or null when there is
 * nothing to reference or nowhere to put it. For providers that match before the
 * text-edit menu is reached and so must offer the row themselves.
 *
 * A surface that renders numbered rows needs only `path`, since the line numbers
 * come from the rows; one that does not — a `<code-block>`, a diff — supplies
 * the path it knows, and the reference carries the selected text alone.
 * @param {object} [options] - The surface's own knowledge.
 * @param {string} [options.path] - Path to print when the DOM advertises none.
 * @param {boolean} [options.outOfRoot] - Whether that path is outside the project.
 * @param {'old'|'new'} [options.side] - Which side of a diff the lines are from.
 * @param {Element} [options.within] - The subject the selection must lie inside.
 * @returns {ContextMenuItem|null} The row, or null.
 */
export function codeReferenceMenuItem({ path = '', outOfRoot = false, side, within } = {}) {
  const selection = window.getSelection?.();
  const reference = resolveCodeSelection(selection)
    || proseReference(path, outOfRoot, selectionTextWithin(selection, within));
  if (!reference || !activeComposer()) return null;
  const full = side ? { ...reference, side } : reference;
  return { label: t(PASTE_REFERENCE_LABEL), onClick: () => askAboutSelection(full) };
}

/**
 * Run the registered providers against the right-clicked element. Pure w.r.t.
 * the DOM: returns the first non-empty menu (and its subject) or null. Exposed
 * for unit testing provider dispatch.
 * @param {Element|null} start - The right-clicked element (event target).
 * @param {MouseEvent} [event] - The originating event (passed through to providers).
 * @returns {{items: ContextMenuItem[], subject: Element}|null} The first matching menu, or null when no provider claims the element.
 */
export function resolveMenu(start, event) {
  const ev = /** @type {MouseEvent} */ (event || /** @type {any} */ ({}));
  for (const provider of _providers) {
    let subject = null;
    try {
      subject = provider.match(start, ev);
    } catch (e) {
      subject = null;
    }
    if (!subject) continue;
    let items = null;
    try {
      items = provider.build(subject, ev);
    } catch (e) {
      items = null;
    }
    const filtered = (items || []).filter(Boolean);
    if (filtered.length === 0) continue;
    return { items: filtered, subject };
  }
  return null;
}

/**
 * Open the context menu at viewport coordinates, for a gesture that stands in
 * for a right-click — a touch long-press, which raises no `contextmenu` event of
 * its own. It is the same menu the providers build: the same chrome, the same
 * outside-pointer and Escape/Back dismissal, the same viewport clamping, and the
 * same one-at-a-time rule. A button that opens a menu is not a context menu: it
 * presents one with `presentPopup` (utils/popup-surface.js), anchored to itself.
 * @param {ContextMenuItem[]} items - The rows to show.
 * @param {number} x - Viewport x to open at, where the gesture ended.
 * @param {number} y - Viewport y to open at.
 * @param {Element|null} [anchor] - What the menu was opened on. Pass it so a
 *   scroll that doesn't move it leaves the menu open.
 * @returns {void}
 */
export function openMenuAt(items, x, y, anchor) {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return;
  showMenu(rows, x, y, anchor);
}

/**
 * Align the Wails runtime's native-menu policy with juggler's runtime
 * dev-mode by seeding `window._wails.environment.Debug`. Idempotent.
 * @private
 */
function syncWailsDebugFlag() {
  const w = /** @type {any} */ (window);
  w._wails = w._wails || {};
  w._wails.environment = w._wails.environment || {};
  w._wails.environment.Debug = isDevMode();
}

/**
 * Close any open juggler menu and tear down its dismiss listeners.
 * @private
 */
function closeMenu() {
  if (_openMenu) {
    // A menu that took focus gives it back to what had it before it opened; a
    // control focused elsewhere since keeps it.
    const focused = document.activeElement;
    const tookFocus = focused === null || focused === document.body || _openMenu.contains(focused);
    _openMenu.remove();
    _openMenu = null;
    if (tookFocus && _returnFocus?.isConnected) _returnFocus.focus({ preventScroll: true });
  }
  _returnFocus = null;
  if (_releaseOpenState) {
    _releaseOpenState();
    _releaseOpenState = null;
  }
  _anchor = null;
  document.removeEventListener('pointerdown', _onOutside, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', _onScroll, true);
}

/**
 * Dismiss the menu on a scroll that moves what it was opened on.
 *
 * The listener is capture-phase on `window`, so it sees every scroller in the
 * document — including the conversation area and the properties panel, which
 * scroll themselves to follow each block of a streaming turn. The menu is
 * positioned in viewport coords and cannot track its anchor, so a scroll of an
 * ancestor scroller dismisses it; a scroll anywhere else leaves the anchor
 * exactly where it was and is ignored. An anchor a re-render has detached is
 * inside no scroller, so its menu survives — the rows captured what they act on
 * when they were built.
 * @param {Event} e - The scroll event.
 * @private
 */
function _onScroll(e) {
  const scroller = /** @type {any} */ (e.target);
  const scopedOut = _anchor && scroller && typeof scroller.contains === 'function'
    && !scroller.contains(_anchor);
  if (scopedOut) return;
  closeMenu();
}

/**
 * Dismiss the menu on a pointer-down outside it.
 * @param {PointerEvent} e - The pointer event.
 * @private
 */
function _onOutside(e) {
  const target = /** @type {globalThis.Node|null} */ (e.target);
  if (_openMenu && target && _openMenu.contains(target)) return;
  closeMenu();
}

/**
 * Render and position the juggler popup menu at viewport coords (x, y).
 *
 * It is built from the app's shared menu classes — a shown `.dropdown-menu` of
 * `.menu-item` rows, `.menu-divider` separators, `.danger` and `.unavailable`
 * variants — so it looks like every other menu. `.juggler-context-menu` adds
 * only the stacking layer (overlays-and-updates.css).
 * @param {ContextMenuItem[]} items
 * @param {number} x
 * @param {number} y
 * @param {Element|null} [anchor] - What the menu was opened on; scopes scroll dismissal.
 * @private
 */
function showMenu(items, x, y, anchor) {
  closeMenu();
  _returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu juggler-context-menu show';
  const list = document.createElement('menu');
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', t('Context menu'));
  menu.appendChild(list);

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('li');
      sep.className = 'menu-divider';
      sep.setAttribute('role', 'separator');
      list.appendChild(sep);
      continue;
    }
    const row = document.createElement('li');
    row.className = 'menu-item';
    if (item.danger) row.classList.add('danger');
    row.setAttribute('role', 'menuitem');
    row.textContent = item.label || '';
    if (item.disabled) {
      row.classList.add('unavailable');
      row.setAttribute('aria-disabled', 'true');
    } else {
      row.addEventListener('click', () => {
        closeMenu();
        try {
          item.onClick?.();
        } catch (e) {
          console.error('[ContextMenu] action failed:', e);
        }
      });
    }
    list.appendChild(row);
  }

  // Position off-screen first to measure, then clamp into the viewport.
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  _openMenu = menu;
  _anchor = anchor || null;
  // Escape and the browser/mobile Back button dismiss via popup-manager.
  _releaseOpenState = markPopupOpen(() => closeMenu());

  // Layout size, not getBoundingClientRect: the menu is already scaling up
  // through its entrance (popup-surface.css), and the clamp is for the size it
  // comes to rest at.
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const margin = 4;
  let left = x;
  let top = y;
  if (left + width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - width - margin);
  }
  if (top + height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // Grow out of the click point, wherever the clamp left it on the menu.
  const originX = Math.min(width, Math.max(0, x - left));
  const originY = Math.min(height, Math.max(0, y - top));
  menu.style.setProperty('--popup-origin', `${originX}px ${originY}px`);
  menu.style.visibility = '';
  // Arrows, Enter/Space and Tab; opened from the keyboard (the context-menu
  // key, Shift+F10) it takes focus now that it is shown.
  attachMenuKeyboard(list, { close: closeMenu });

  document.addEventListener('pointerdown', _onOutside, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', _onScroll, true);
}

/** @type {(() => boolean)[]} @private */
const _suppressors = [];

/**
 * Stand the menu down while some gesture owns the pointer. A long-press is how
 * Android asks for a context menu, and the same press is how a finger lifts a
 * row to reorder it: a strip that lifts on a hold registers its "is a hold in
 * progress?" here, and while it says yes a `contextmenu` opens nothing — native
 * or ours. The strip opens its own menu if the hold is let go where it was.
 * @param {() => boolean} isOwned - Whether a gesture currently owns the pointer.
 * @returns {void}
 */
export function registerContextMenuSuppressor(isOwned) {
  _suppressors.push(isOwned);
}

/** @type {string} @private The `pointerType` of the most recent `pointerdown`. */
let _lastPointerType = '';

/**
 * Whether a `contextmenu` came from a finger. The press that led to it decides
 * as much as the event does: a menu Chromium holds back to the release (a
 * long-press that began a touch drag, any long-press under WebView2) can carry
 * an empty or `mouse` `pointerType`, and a plain-MouseEvent engine carries none.
 * The cost is that a menu key pressed after a tap counts as touch, and gets the
 * platform's menu.
 * @param {MouseEvent} e - The contextmenu event.
 * @returns {boolean} True for a touch long-press.
 * @private
 */
function isTouchPress(e) {
  const any = /** @type {any} */ (e);
  return any.pointerType === 'touch'
    || any.sourceCapabilities?.firesTouchEvents === true
    || _lastPointerType === 'touch';
}

/**
 * Capture-phase `contextmenu` handler. Three-tier dispatch (see module doc):
 * registered providers → built-in text-edit menu → native fallback (dev only).
 * Any juggler menu suppresses the native one so its Inspect Element / Writing
 * Tools items never appear over our content.
 * @param {MouseEvent} e - The contextmenu event.
 * @private
 */
function onContextMenu(e) {
  if (_suppressors.some((isOwned) => isOwned())) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }

  // Only Element targets support closest()/matches() that providers rely on.
  const target = /** @type {any} */ (e.target);
  const start = target && typeof target.closest === 'function' ? /** @type {Element} */ (target) : null;

  // 1) Registered juggler providers.
  const resolved = resolveMenu(start, e);
  if (resolved) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(resolved.items, e.clientX, e.clientY, start);
    return;
  }

  // 2) Built-in edit menu for text fields / selections. Owning these means the
  //    native menu (Inspect Element in non-production builds; Writing Tools /
  //    Look Up on macOS) never shows over text — in any build or runtime mode.
  //    A finger is the exception: on Android the long-press that starts a
  //    selection fires `contextmenu` once the word is selected, and a menu
  //    opened under the finger covers the text it is about to drag. The
  //    platform's selection toolbar tracks the handles, so it is left to that.
  const textItems = buildTextEditMenu(start);
  if (textItems.length && isTouchPress(e)) return;
  if (textItems.length) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(textItems, e.clientX, e.clientY, start);
    return;
  }

  // 3) Nothing juggler-specific applies. In dev-mode let the native debug menu
  //    (Reload / Inspect Element) through on non-text regions; otherwise
  //    suppress the native menu entirely.
  if (isDevMode()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

// Seed the native-menu gate as early as this module loads, and again at the
// first right-click in case the runtime overwrote the environment object after
// load (the handler reads it live, so a late re-seed is harmless).
syncWailsDebugFlag();
window.addEventListener('pointerdown', (e) => {
  _lastPointerType = e.pointerType || '';
}, { capture: true, passive: true });
window.addEventListener('contextmenu', (e) => {
  syncWailsDebugFlag();
  onContextMenu(/** @type {MouseEvent} */ (e));
}, { capture: true });
