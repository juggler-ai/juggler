//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit + DOM tests for the right-click context-menu service.
 *
 * Covers:
 *  - provider dispatch (resolveMenu): first matching, non-empty provider wins,
 *    empty results are skipped, non-matching elements resolve to null;
 *  - the file-reference menu: which elements it claims (a `data-file-path`, a
 *    link to a project file) and which it leaves alone (an external link, an
 *    in-page anchor), and that the Pin row is offered only when something is
 *    enabled to take the file;
 *  - the built-in text-edit menu (buildTextEditMenu): Cut/Copy/Paste/Select All
 *    for writable fields, Copy-only for read-only selections, nothing for plain
 *    elements or read-only fields — this is what keeps the native menu (with its
 *    Inspect Element / Writing Tools items) from ever showing over text;
 *  - end-to-end wiring: a real `contextmenu` event opens the juggler popup,
 *    suppresses the native menu (preventDefault), and Escape dismisses it;
 *  - scroll dismissal scoped to the anchor: a scroller containing what the menu
 *    was opened on dismisses it, any other scroller — the conversation area or
 *    properties panel following a streaming turn — leaves it open.
 * @module unit-tests/context-menu-test
 */

import {
  buildTextEditMenu,
  resolveMenu,
  registerContextMenuProvider,
  PASTE_REFERENCE_LABEL,
  codeReferenceMenuItem,
} from '../../js/services/context-menu-service.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
// Imported for its registration: the file-reference menu is a side effect of
// loading the module that owns it, and these tests are about that menu.
import '../../js/utils/properties-panel-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
// Likewise the code-block provider, which claims a block before the text-edit
// menu is reached and so must offer the paste row itself.
import '../../js/components/code-block.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';

// Unique marker so our test provider never collides with real providers or
// real DOM. Real providers match code-block / diff-viewer / .conversation-tab /
// [data-file-path] and a[href]; none of those match this attribute.
const MARK = 'data-cm-unit-test';

let _providerRegistered = false;
/**
 *
 */
function ensureTestProvider() {
  if (_providerRegistered) return;
  registerContextMenuProvider({
    match: (start) => (start ? start.closest(`[${MARK}]`) : null),
    build: (subject) => {
      const kind = subject.getAttribute(MARK);
      if (kind === 'empty') return []; // exercise the "skip empty" path
      if (kind === 'variants') {
        return [
          { label: 'Plain', onClick: () => { /* no-op */ } },
          { label: 'Greyed', disabled: true },
          { separator: true },
          { label: 'Destroy', danger: true, onClick: () => { /* no-op */ } },
        ];
      }
      return [
        { label: 'Test Action', onClick: () => { /* no-op */ } },
      ];
    },
  });
  _providerRegistered = true;
}

/**
 * A stand-in pin type that takes any live file, so the menu's Pin row has
 * something to be offered by. It is never mounted: resolveSource asks the class,
 * not an instance.
 */
class TakesFiles {
  static MANIFEST = {
    id: 'cm-test-file',
    name: 'Files, for testing',
    version: '1.0.0',
    description: 'Takes any file so the Pin row has a taker',
  };

  /**
   * @param {{kind?: string, path?: string}} source - The source offered.
   * @returns {boolean} True for a file with a path.
   */
  static canPinSource(source) {
    return source?.kind === 'file' && !!source.path;
  }

  /**
   * @param {{path?: string}} source - The source offered.
   * @returns {{path: string}} The config to pin it with.
   */
  static configFromSource(source) {
    return { path: source.path || '' };
  }
}

/**
 * An anchor as rendered markdown would leave one: a real element in the
 * document, so its href resolves against this page the way a clicked one does.
 * @param {string} href - The href to set.
 * @returns {HTMLAnchorElement} The anchor, already in the document.
 */
function anchorWith(href) {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = 'a link';
  document.body.appendChild(anchor);
  return anchor;
}

/**
 * The press a real right-click or long-press begins with. The service reads the
 * last one to tell a finger from a mouse, and a lane shares one realm, so a
 * `contextmenu` sent without one inherits whatever an earlier suite pressed.
 * @param {Element} el - Where to press.
 * @param {string} pointerType - `mouse` or `touch`.
 * @returns {void}
 */
function press(el, pointerType) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType }));
}

/**
 * Send a `contextmenu` at `el` and report whether the service left it to the
 * platform: uncancelled once the service's capture listener has run. It is
 * cancelled after that reading all the same, at the target, so it never
 * reaches WebKit's own menu — which a synthetic event reaches as readily as a
 * real one, and which over editable text has AppKit build its Spelling panel
 * on the main thread (the harness fails any suite that lets one through).
 * @param {Element} el - Where to send it.
 * @param {MouseEvent} event - A bubbling, cancelable `contextmenu`.
 * @returns {boolean} True when the service did not cancel it.
 */
function leftToPlatform(el, event) {
  let leftAlone = false;
  /** @param {Event} e */
  const read = (e) => {
    leftAlone = !e.defaultPrevented;
    e.preventDefault();
  };
  el.addEventListener('contextmenu', read, { once: true });
  try {
    el.dispatchEvent(event);
  } finally {
    el.removeEventListener('contextmenu', read);
  }
  return leftAlone;
}

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Run the context-menu test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** @param {number} r */
  const tally = (r) => { if (r) passed += r; else failed += 1; };

  ensureTestProvider();

  const labelsOf = (/** @type {{label?: string, separator?: boolean}[]} */ items) =>
    items.filter(i => !i.separator).map(i => i.label);

  // === Provider dispatch (resolveMenu) ===
  const matchEl = document.createElement('div');
  matchEl.setAttribute(MARK, 'normal');
  const resolved = resolveMenu(matchEl);
  tally(check(!!resolved && resolved.items.length === 1 && resolved.items[0].label === 'Test Action',
    'resolveMenu: matching element should return the provider items', errors));
  tally(check(!!resolved && resolved.subject === matchEl,
    'resolveMenu: subject should be the matched element', errors));

  // closest() climbs: right-clicking a child resolves to the marked ancestor.
  const child = document.createElement('span');
  matchEl.appendChild(child);
  const resolvedChild = resolveMenu(child);
  tally(check(!!resolvedChild && resolvedChild.subject === matchEl,
    'resolveMenu: should climb to the nearest matching ancestor', errors));

  const emptyEl = document.createElement('div');
  emptyEl.setAttribute(MARK, 'empty');
  tally(check(resolveMenu(emptyEl) === null,
    'resolveMenu: provider returning no items should be skipped (null)', errors));

  const plainEl = document.createElement('div');
  tally(check(resolveMenu(plainEl) === null,
    'resolveMenu: unclaimed element should resolve to null', errors));

  tally(check(resolveMenu(null) === null,
    'resolveMenu: null target should resolve to null', errors));

  // === File references (data-file-path rows, links in rendered markdown) ===
  // A lane shares one realm, so the registry is emptied first: whatever an
  // earlier suite left registered would otherwise decide whether Pin is offered.
  pinboardItemRegistry.reset();

  const fileLink = anchorWith('docs/report.md');
  const externalLink = anchorWith('https://example.com/report.md');
  const inPageLink = anchorWith('#section');
  const fileRow = document.createElement('div');
  fileRow.setAttribute('data-file-path', '/a/b.txt');
  document.body.appendChild(fileRow);
  try {
    const linkMenu = resolveMenu(fileLink);
    const linkLabels = linkMenu ? labelsOf(linkMenu.items) : [];
    tally(check(!!linkMenu && linkMenu.subject === fileLink,
      'file menu: a link to a project file is claimed, and is its own subject', errors));
    tally(check(linkLabels.length === 3 && linkLabels[0] === 'Open file' && linkLabels[2] === 'Copy path',
      `file menu: a file link offers open/reveal/copy (got ${JSON.stringify(linkLabels)})`, errors));
    tally(check(!linkLabels.includes('Pin to Pinboard'),
      'file menu: with nothing enabled to take a file, Pin is left out rather than offered dead', errors));

    tally(check(resolveMenu(externalLink) === null,
      'file menu: an external link is not a file, and is left to the text menu', errors));
    tally(check(resolveMenu(inPageLink) === null,
      'file menu: an in-page #anchor is not a file either', errors));

    const rowMenu = resolveMenu(fileRow);
    tally(check(!!rowMenu && rowMenu.subject === fileRow && labelsOf(rowMenu.items).length === 3,
      'file menu: a data-file-path row still resolves to its own path', errors));

    // Both selectors in one provider: the nearer subject decides, so a link
    // inside a file row is about its own href.
    const nested = document.createElement('a');
    nested.setAttribute('href', 'docs/other.md');
    fileRow.appendChild(nested);
    tally(check(resolveMenu(nested)?.subject === nested,
      'file menu: a link inside a file row is about the link, not the row', errors));

    pinboardItemRegistry.registerClass(TakesFiles, { extensionId: 'test' });
    tally(check(labelsOf(resolveMenu(fileLink)?.items || []).includes('Pin to Pinboard'),
      'file menu: with something enabled to take it, a file link offers to pin it', errors));
    tally(check(labelsOf(resolveMenu(fileRow)?.items || []).includes('Pin to Pinboard'),
      'file menu: and so does a file row, matching the pin button beside it', errors));
  } finally {
    fileLink.remove();
    externalLink.remove();
    inPageLink.remove();
    fileRow.remove();
    pinboardItemRegistry.reset();
  }

  // === Built-in text-edit menu (buildTextEditMenu) ===
  // Writable textarea with a selection → full edit menu, Cut/Copy enabled.
  const ta = document.createElement('textarea');
  ta.value = 'hello world';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.setSelectionRange(0, 5);
    const taMenu = buildTextEditMenu(ta);
    tally(check(
      JSON.stringify(labelsOf(taMenu)) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All']),
      `text-edit: writable textarea menu labels (got ${JSON.stringify(labelsOf(taMenu))})`, errors));
    const cut = taMenu.find(i => i.label === 'Cut');
    const paste = taMenu.find(i => i.label === 'Paste');
    tally(check(cut && !cut.disabled, 'text-edit: Cut enabled when selection non-empty', errors));
    tally(check(paste && !paste.disabled, 'text-edit: Paste always enabled', errors));

    // Collapsed caret → Cut/Copy disabled, Paste still enabled.
    ta.setSelectionRange(2, 2);
    const taCollapsed = buildTextEditMenu(ta);
    const cut2 = taCollapsed.find(i => i.label === 'Cut');
    const copy2 = taCollapsed.find(i => i.label === 'Copy');
    tally(check(cut2?.disabled === true && copy2?.disabled === true,
      'text-edit: Cut/Copy disabled with no selection', errors));
  } finally {
    ta.remove();
  }

  // Read-only field → no edit menu (no clutter, no native Inspect/Writing Tools).
  const roField = document.createElement('input');
  roField.type = 'text';
  roField.value = 'locked';
  roField.readOnly = true;
  document.body.appendChild(roField);
  try {
    tally(check(buildTextEditMenu(roField).length === 0,
      'text-edit: read-only input yields no edit menu', errors));
  } finally {
    roField.remove();
  }

  // Non-editable element with a live text selection → Copy only.
  const para = document.createElement('p');
  para.textContent = 'selectable read-only text';
  document.body.appendChild(para);
  try {
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const paraMenu = buildTextEditMenu(para);
    tally(check(
      JSON.stringify(labelsOf(paraMenu)) === JSON.stringify(['Copy']),
      `text-edit: selected read-only text offers Copy only (got ${JSON.stringify(labelsOf(paraMenu))})`, errors));
    sel?.removeAllRanges();
  } finally {
    para.remove();
  }

  // === The paste-reference row, over a provider that matches first ===
  // A <code-block> is claimed by its own provider, which resolveMenu returns
  // before the text-edit menu is ever reached — so the row has to be offered
  // there too, or it silently disappears on every surface with a provider.
  const tab = document.createElement('conversation-tab');
  tab.className = 'active';
  const composerStub = document.createElement('div');
  composerStub.appendChild(document.createElement('textarea'));
  /** @type {any} */ (tab).getComposer = () => composerStub;
  document.body.appendChild(tab);

  const block = document.createElement('code-block');
  block.setAttribute('code', 'const x = 1;');
  block.setAttribute('data-file-path', 'web/js/app.js');
  document.body.appendChild(block);
  try {
    const selection = window.getSelection();
    selection?.removeAllRanges();

    // A block carrying a path is the code-block's own: the file-reference
    // provider declines it, whichever of the two registered first.
    const owned = resolveMenu(block);
    tally(check(owned?.subject === block && labelsOf(owned?.items || []).includes('Copy code'),
      `code-block: a block with a data-file-path gets its own menu (got ${JSON.stringify(labelsOf(owned?.items || []))})`, errors));

    const noSelection = labelsOf(resolveMenu(block)?.items || []);
    tally(check(!noSelection.includes(PASTE_REFERENCE_LABEL),
      `code-block: with nothing selected there is nothing to reference (got ${JSON.stringify(noSelection)})`, errors));

    const range = document.createRange();
    range.selectNodeContents(block);
    selection?.addRange(range);

    // The block's own provider answers, and offers the paste row itself.
    const selected = labelsOf(resolveMenu(block)?.items || []);
    tally(check(selected.includes(PASTE_REFERENCE_LABEL),
      `code-block: a selection offers the paste row (got ${JSON.stringify(selected)})`, errors));

    // A selection somewhere else entirely is not this block's content.
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'unrelated prose';
    document.body.appendChild(elsewhere);
    const strayRange = document.createRange();
    strayRange.selectNodeContents(elsewhere);
    selection?.removeAllRanges();
    selection?.addRange(strayRange);
    const stray = labelsOf(resolveMenu(block)?.items || []);
    tally(check(!stray.includes(PASTE_REFERENCE_LABEL),
      `code-block: a selection outside the block is not quoted under its path (got ${JSON.stringify(stray)})`, errors));
    elsewhere.remove();
    selection?.removeAllRanges();
  } finally {
    block.remove();
    tab.remove();
    composerStub.remove();
  }

  // Plain element, no selection → no menu at all.
  const bare = document.createElement('div');
  document.body.appendChild(bare);
  try {
    window.getSelection()?.removeAllRanges();
    tally(check(buildTextEditMenu(bare).length === 0,
      'text-edit: plain element with no selection yields no menu', errors));
  } finally {
    bare.remove();
  }

  // === End-to-end: contextmenu over a textarea opens the juggler edit menu ===
  const taHost = document.createElement('textarea');
  taHost.value = 'abc';
  document.body.appendChild(taHost);
  try {
    taHost.focus();
    taHost.setSelectionRange(0, 0);
    press(taHost, 'mouse');
    const ev = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 30, clientY: 30,
    });
    const notCancelled = taHost.dispatchEvent(ev);
    tally(check(notCancelled === false,
      'e2e: native menu suppressed over a text field (preventDefault)', errors));
    const editMenu = document.querySelector('.juggler-context-menu');
    const editLabels = editMenu
      ? Array.from(editMenu.querySelectorAll('.menu-item')).map(b => b.textContent)
      : [];
    tally(check(
      JSON.stringify(editLabels) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All']),
      `e2e: textarea right-click shows the edit menu (got ${JSON.stringify(editLabels)})`, errors));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    taHost.remove();
    const leftover = document.querySelector('.juggler-context-menu');
    if (leftover) leftover.remove();
  }

  // === A touch long-press over text belongs to the native selection ===
  // On Android the long-press that starts a selection also fires `contextmenu`,
  // after the word under the finger is already selected. Our Copy menu, opened
  // at the finger, would sit on the selection the user is about to drag; the
  // platform's own selection toolbar tracks the handles instead.
  {
    const touchPara = document.createElement('p');
    touchPara.textContent = 'text selected by a long-press';
    const touchField = document.createElement('textarea');
    touchField.value = 'typed text';
    const touchHost = document.createElement('div');
    touchHost.setAttribute(MARK, 'normal');
    document.body.append(touchPara, touchField, touchHost);
    const selection = window.getSelection();
    const selectPara = () => {
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(touchPara);
      selection?.addRange(range);
    };
    const menuOpen = () => document.querySelector('.juggler-context-menu') !== null;
    try {
      selectPara();
      press(touchPara, 'touch');
      const touchLeftAlone = leftToPlatform(touchPara, new PointerEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 20, pointerType: 'touch',
      }));
      tally(check(touchLeftAlone && !menuOpen(),
        `touch: a long-press over selected text opens no juggler menu and is not cancelled (cancelled=${!touchLeftAlone}, menu=${menuOpen()})`, errors));
      document.querySelector('.juggler-context-menu')?.remove();

      // A WebView whose `contextmenu` is a plain MouseEvent: the press that
      // started it says it was a finger.
      selectPara();
      press(touchPara, 'touch');
      const fallbackLeftAlone = leftToPlatform(touchPara, new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 20,
      }));
      tally(check(fallbackLeftAlone && !menuOpen(),
        'touch: a MouseEvent contextmenu after a touch pointerdown is left to the native selection too', errors));
      document.querySelector('.juggler-context-menu')?.remove();

      // A menu Chromium holds back to the release (a long-press that began a
      // touch drag; any long-press under WebView2) need not say `touch`: the
      // press that began it decides, whatever the event calls itself.
      for (const pointerType of ['', 'mouse']) {
        selectPara();
        press(touchPara, 'touch');
        const releaseLeftAlone = leftToPlatform(touchPara, new PointerEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 20, clientY: 20, pointerType,
        }));
        tally(check(releaseLeftAlone && !menuOpen(),
          `touch: a contextmenu with pointerType "${pointerType}" after a touch press is left to the native selection (cancelled=${!releaseLeftAlone}, menu=${menuOpen()})`, errors));
        document.querySelector('.juggler-context-menu')?.remove();
      }

      // A text field the same: the platform's toolbar has Paste and the handles.
      selection?.removeAllRanges();
      touchField.focus();
      touchField.setSelectionRange(0, 5);
      const fieldLeftAlone = leftToPlatform(touchField, new PointerEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 20, pointerType: 'touch',
      }));
      tally(check(fieldLeftAlone && !menuOpen(),
        'touch: a long-press in a text field is left to the native selection', errors));
      document.querySelector('.juggler-context-menu')?.remove();

      // Content menus are not text selection: a long-press still opens them.
      touchHost.dispatchEvent(new PointerEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 20, pointerType: 'touch',
      }));
      tally(check(menuOpen(), 'touch: a long-press on a claimed element still opens its menu', errors));
      document.querySelector('.juggler-context-menu')?.remove();

      // And a mouse right-click over the same selection keeps our Copy menu.
      selectPara();
      press(touchPara, 'mouse');
      const mouseCancelled = !touchPara.dispatchEvent(new PointerEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 20, clientY: 20, pointerType: 'mouse',
      }));
      tally(check(mouseCancelled && menuOpen(),
        'touch: a mouse right-click over selected text still opens the juggler Copy menu', errors));
    } finally {
      press(document.body, 'mouse');
      selection?.removeAllRanges();
      document.querySelector('.juggler-context-menu')?.remove();
      touchPara.remove();
      touchField.remove();
      touchHost.remove();
    }
  }

  // === End-to-end: contextmenu event opens + Escape dismisses ===
  const host = document.createElement('div');
  host.setAttribute(MARK, 'normal');
  document.body.appendChild(host);
  try {
    // Pre-condition: no menu open.
    const before = document.querySelector('.juggler-context-menu');
    tally(check(before === null, 'e2e: no juggler menu should exist before the event', errors));

    host.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20,
    }));

    const menu = document.querySelector('.juggler-context-menu');
    tally(check(menu !== null, 'e2e: contextmenu over a claimed element should open the juggler menu', errors));
    const rows = menu ? menu.querySelectorAll('.menu-item') : [];
    tally(check(rows.length === 1 && rows[0].textContent === 'Test Action',
      'e2e: menu should render the provider rows', errors));

    // Escape dismisses.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    tally(check(document.querySelector('.juggler-context-menu') === null,
      'e2e: Escape should dismiss the juggler menu', errors));
  } finally {
    host.remove();
    const leftover = document.querySelector('.juggler-context-menu');
    if (leftover) leftover.remove();
  }

  // === The right-click menu is the shared menu, not a look of its own ===
  // Same classes as every `.dropdown-menu`, so it takes the one menu style; and
  // the geometry a plain dropdown computes to, so no second copy of the CSS can
  // creep back in under the old class names.
  const variantsHost = document.createElement('div');
  variantsHost.setAttribute(MARK, 'variants');
  document.body.appendChild(variantsHost);
  const probe = document.createElement('nav');
  probe.className = 'dropdown-menu show';
  const probeList = document.createElement('menu');
  const probeRow = document.createElement('li');
  probeRow.className = 'menu-item';
  probeRow.textContent = 'Probe';
  probeList.append(probeRow);
  probe.append(probeList);
  document.body.appendChild(probe);
  try {
    variantsHost.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20,
    }));
    const menu = /** @type {HTMLElement|null} */ (document.querySelector('.juggler-context-menu'));
    tally(check(!!menu && menu.classList.contains('dropdown-menu') && menu.classList.contains('show'),
      `style: the right-click menu is a shown .dropdown-menu (got "${menu?.className}")`, errors));
    const rows = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
    tally(check(rows.length === 3 && rows.every((r) => r.classList.contains('menu-item')),
      `style: every row is a .menu-item (got ${JSON.stringify(rows.map((r) => r.className))})`, errors));
    tally(check(rows.map((r) => r.textContent).join('|') === 'Plain|Greyed|Destroy',
      `style: rows keep their labels (got ${JSON.stringify(rows.map((r) => r.textContent))})`, errors));
    const greyed = rows[1];
    tally(check(!!greyed && greyed.getAttribute('aria-disabled') === 'true'
      && greyed.classList.contains('unavailable') && /** @type {HTMLElement} */ (greyed).tabIndex !== 0,
    'style: a disabled row is aria-disabled, wears .unavailable and is never the tab stop', errors));
    tally(check(/** @type {HTMLElement} */ (rows[0]).tabIndex === 0,
      'style: the first enabled row is the keyboard\'s way in', errors));
    try {
      assertMenuShape(menu, 'right-click menu');
      tally(true);
    } catch (e) {
      tally(check(false, `aria: ${e instanceof Error ? e.message : String(e)}`, errors));
    }
    tally(check(!!rows[2]?.classList.contains('danger'),
      'style: a danger row wears .danger', errors));
    const sep = menu?.querySelector('[role="separator"]');
    tally(check(!!sep && sep.classList.contains('menu-divider'),
      `style: a separator is a .menu-divider (got "${sep?.className}")`, errors));
    tally(check(!menu?.querySelector('[class*="juggler-context-menu-"]'),
      'style: no row carries a private juggler-context-menu-* class', errors));

    if (menu && rows[0]) {
      const m = getComputedStyle(menu);
      const p = getComputedStyle(probe);
      const r = getComputedStyle(rows[0]);
      const pr = getComputedStyle(probeRow);
      for (const prop of ['borderTopLeftRadius', 'paddingTop', 'paddingLeft', 'boxShadow', 'backgroundColor']) {
        tally(check(m[prop] === p[prop],
          `style: menu ${prop} matches a dropdown (${m[prop]} vs ${p[prop]})`, errors));
      }
      for (const prop of ['borderTopLeftRadius', 'paddingTop', 'paddingLeft', 'fontSize', 'color']) {
        tally(check(r[prop] === pr[prop],
          `style: row ${prop} matches a dropdown row (${r[prop]} vs ${pr[prop]})`, errors));
      }
      // A right-click can start inside a modal or an open dropdown, so the menu
      // stacks above both, on the toast layer.
      const toast = getComputedStyle(document.documentElement).getPropertyValue('--z-toast').trim();
      tally(check(m.zIndex === toast && Number(m.zIndex) > Number(p.zIndex),
        `style: menu sits on the toast layer (z ${m.zIndex}, toast ${toast}, dropdown ${p.zIndex})`, errors));
    }
  } finally {
    variantsHost.remove();
    probe.remove();
    document.querySelector('.juggler-context-menu')?.remove();
  }

  // === Scroll dismissal is scoped to scrollers that move the anchor ===
  const scrollHost = document.createElement('div');
  scrollHost.setAttribute(MARK, 'normal');
  const elsewhere = document.createElement('div');
  document.body.appendChild(scrollHost);
  document.body.appendChild(elsewhere);
  try {
    scrollHost.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20,
    }));
    tally(check(document.querySelector('.juggler-context-menu') !== null,
      'scroll: menu should open on the anchor', errors));

    // A scroll elsewhere in the page — the conversation area or properties panel
    // following a streaming turn — leaves the anchor exactly where it was, so the
    // menu must survive it.
    elsewhere.dispatchEvent(new Event('scroll'));
    tally(check(document.querySelector('.juggler-context-menu') !== null,
      'scroll: a scroller that does not contain the anchor must not dismiss', errors));

    // A scroll that does move the anchor still dismisses: the menu is positioned
    // in viewport coords and cannot follow it.
    document.body.dispatchEvent(new Event('scroll'));
    tally(check(document.querySelector('.juggler-context-menu') === null,
      'scroll: a scroller containing the anchor should dismiss', errors));
  } finally {
    scrollHost.remove();
    elsewhere.remove();
    const leftover = document.querySelector('.juggler-context-menu');
    if (leftover) leftover.remove();
  }

  // === Everything the service's own menus show follows the UI language ===
  // Every built-in menu: a text field's (drawn for real, so the menu's own
  // aria-label is seen), a contentEditable's, a read-only selection's with the
  // paste-reference row, and the paste row a provider asks for. Fixture text is
  // digits, which are data.
  {
    /** @type {string[]} */
    const shown = [];
    const xaTab = document.createElement('conversation-tab');
    xaTab.className = 'active';
    const xaComposer = document.createElement('div');
    xaComposer.appendChild(document.createElement('textarea'));
    /** @type {any} */ (xaTab).getComposer = () => xaComposer;
    const field = document.createElement('input');
    field.type = 'text';
    field.value = '12';
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.textContent = '34';
    const code = document.createElement('div');
    code.setAttribute('data-code-ref-path', '5/6.7');
    code.textContent = '89';
    document.body.append(xaTab, field, editable, code);
    const selection = window.getSelection();
    const selectAllOf = (/** @type {Node} */ node) => {
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.addRange(range);
    };
    try {
      await underPseudoLocale('context-menu-test', async () => {
        // A writable field, through a real right-click.
        selection?.removeAllRanges();
        field.setSelectionRange(0, 2);
        press(field, 'mouse');
        field.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 20, clientY: 20,
        }));
        const menu = document.querySelector('.juggler-context-menu');
        if (!menu) throw new Error('a right-click on a text field opened no menu');
        const fieldRows = menu.querySelectorAll('.menu-item');
        if (fieldRows.length !== 4) throw new Error(`expected the field's four rows, got ${fieldRows.length}`);
        if (!menu.querySelector('[role="menu"][aria-label]')) throw new Error('the menu has no aria-label');
        shown.push(...shownStrings(menu));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        document.querySelector('.juggler-context-menu')?.remove();

        // A contentEditable host.
        selectAllOf(editable);
        const editRows = labelsOf(buildTextEditMenu(editable));
        if (editRows.length !== 3) throw new Error(`expected the editable's three rows, got ${JSON.stringify(editRows)}`);
        shown.push(...editRows.map(String));

        // A read-only selection over content naming its file: Copy plus the paste row.
        selectAllOf(code);
        const readRows = labelsOf(buildTextEditMenu(code));
        if (readRows.length !== 2) throw new Error(`expected Copy and the paste row, got ${JSON.stringify(readRows)}`);
        shown.push(...readRows.map(String));

        // The paste row a provider offers itself.
        const providerRow = codeReferenceMenuItem({ path: '5/6.7', within: code });
        if (!providerRow) throw new Error('codeReferenceMenuItem offered no row over a selection');
        shown.push(String(providerRow.label));
      });
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      tally(check(shown.length >= 11 && raw.length === 0,
        `en-XA: plain English in the service's own menus (${shown.length} shown): ${JSON.stringify(raw)}`, errors));
    } catch (e) {
      tally(check(false, `en-XA: ${e instanceof Error ? e.message : String(e)}`, errors));
    } finally {
      selection?.removeAllRanges();
      document.querySelector('.juggler-context-menu')?.remove();
      xaTab.remove();
      field.remove();
      editable.remove();
      code.remove();
    }
  }

  return { passed, failed, errors };
}
