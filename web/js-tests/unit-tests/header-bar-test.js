//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The header bar's button row, asserted against the markup index.html really
 * serves rather than a hand-copied fixture, so a test cannot keep passing
 * against a button the page no longer has.
 *
 * The real header is fetched and parsed inert; each case clones just the part
 * it needs into an `.app-header` wrapper in this lane, where the app's own
 * stylesheets (loaded by the headless page) style it exactly as they do the
 * live header.
 *
 *   1–2. Toggles show their CURRENT state through the glyph alone — never a
 *        tint or a dimmed icon that only the pressed state gets.
 *   3. The network button carries the count of other connected clients, in
 *      its badge and its accessible name; the project chip carries none.
 *   4. Undo/redo act on the conversation, so they sit beside the project chip,
 *      and join the button row on a phone. The chip is a read-only label: no
 *      button, no chevron, and part of a desktop window's drag region.
 *   5. The app-wide controls come in groups (network, view, app, panel) whose
 *      spacing grows with the header; with room, the network count is a label.
 *   6. Below 900px, help and zoom fold into a "…" menu that offers them back,
 *      with their shortcuts. A Windows or Linux desktop window shows "…" at any
 *      width: there it is the app menu, ending in Exit (Windows) or Quit (Linux).
 *   7. Tooltips name shortcuts, and never restore a title that changed under them.
 *   8. Under en-XA the network button's title and accessible name are translated.
 *   9. A window on a server the app did not start names that server's host
 *      inside the network button, which leads the button row.
 *  10. A frameless Windows or Linux window's caption buttons stay inside it at
 *      every header width — on Windows flush to the top-right corner.
 *  11. The condensed header shrinks the wordmark only a little, and keeps it
 *      as far from the left edge as the full-width header does.
 *  12. The +/- zoom scales the whole header as one — its height, padding,
 *      buttons, glyphs, badge and gaps — so nothing in it shifts against the rest.
 * @module unit-tests/header-bar-test
 */

import { assert, styledProbeFrame } from '../utilities/test-helpers.js';
import { serverPath } from '../../js/utils/api-url.js';
import { bindNetworkClients } from '../../js/components/header-controls.js';
import { externalServerHost } from '../../js/utils/project-open-mode.js';
import { setupHeaderOverflowMenu } from '../../js/utils/header-overflow-menu.js';
import { headerOverflowItems } from '../../js/utils/header-overflow-items.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import tooltipManager from '../../js/services/tooltip-manager.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The header exactly as index.html serves it, parsed into an inert document
 * (nothing upgrades or runs there).
 * @returns {Promise<HTMLElement>} The served `.app-header`.
 */
async function servedHeader() {
  const res = await fetch(serverPath('/'));
  assert(res.ok, `precondition: index.html is served (HTTP ${res.status})`);
  // A document with no browsing context: its scripts never run and its custom
  // elements never upgrade.
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = await res.text();
  const header = /** @type {HTMLElement|null} */ (doc.querySelector('header.app-header'));
  assert(!!header, 'precondition: index.html has a header.app-header');
  return /** @type {HTMLElement} */ (header);
}

/**
 * Mount copies of some served header buttons in a live `.app-header >
 * header-actions`, so the header stylesheets select them as they do in the app.
 * @param {HTMLElement} served - The parsed header from servedHeader().
 * @param {string[]} ids - Ids of the buttons to copy.
 * @returns {{root: HTMLElement, get: (id: string) => HTMLElement}} The mounted
 *   wrapper and a lookup for the copies.
 */
function mountButtons(served, ids) {
  const root = document.createElement('header');
  root.className = 'app-header';
  const actions = document.createElement('header-actions');
  root.appendChild(actions);
  for (const id of ids) {
    const button = served.querySelector(`#${id}`);
    assert(!!button, `precondition: the served header has #${id}`);
    actions.appendChild(document.importNode(/** @type {Element} */ (button), true));
  }
  document.body.appendChild(root);
  return {
    root,
    get: (id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`)),
  };
}

/**
 * The whole served header, laid out in a child document of a chosen width
 * that wears the app's stylesheets — the only way to measure the breakpoint
 * layouts, since a lane's own width varies by platform. The child document has
 * its own element registry, so the header's custom elements stay inert.
 * @param {HTMLElement} served - The parsed header from servedHeader().
 * @param {number} width - The frame's width in px.
 * @returns {Promise<{doc: Document, frame: HTMLIFrameElement, el: (sel: string) => HTMLElement, box: (sel: string) => DOMRect}>}
 *   The child document, its frame, and lookups for elements and their boxes.
 */
async function framedHeader(served, width) {
  const { doc, frame } = await styledProbeFrame(width);
  doc.body.appendChild(doc.importNode(served, true));
  const el = (/** @type {string} */ sel) => {
    const found = doc.querySelector(sel);
    assert(!!found, `precondition: the framed header has ${sel}`);
    return /** @type {HTMLElement} */ (found);
  };
  return { doc, frame, el, box: (sel) => el(sel).getBoundingClientRect() };
}

/**
 * @param {Element} button - A header button holding one or more SVG glyphs.
 * @returns {SVGElement[]} The glyphs CSS is currently showing.
 */
function shownGlyphs(button) {
  return /** @type {SVGElement[]} */ ([...button.querySelectorAll('svg')])
    .filter((svg) => getComputedStyle(svg).display !== 'none');
}

/**
 * Run the header bar suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const served = await servedHeader();

  // --- 1: the grouping toggle's glyph shows the current state, untinted ---
  try {
    const { root, get } = mountButtons(served, ['tool-grouping-button', 'bell-button']);
    try {
      const button = get('tool-grouping-button');
      const reference = /** @type {SVGElement} */ (get('bell-button').querySelector('svg'));

      /**
       * @param {boolean} on - Whether grouping is on.
       * @returns {SVGElement} The one glyph shown in that state.
       */
      const glyphFor = (on) => {
        button.classList.toggle('is-active', on);
        const shown = shownGlyphs(button);
        assert(shown.length === 1, `exactly one glyph shows with grouping ${on ? 'on' : 'off'}, got ${shown.length}`);
        return shown[0];
      };

      // Grouping on means the transcript IS folded, so the folded glyph shows;
      // off, the rows stand individually and the unfolded one does.
      assert(glyphFor(true).classList.contains('tool-grouping-fold'),
        'with grouping on the button shows the folded glyph — the state the transcript is in');
      assert(glyphFor(false).classList.contains('tool-grouping-unfold'),
        'with grouping off it shows the unfolded glyph');

      // The glyph change is the whole signal. Both states paint exactly like an
      // untoggled header icon: no accent tint on, no dimming off.
      const ref = getComputedStyle(reference);
      for (const on of [true, false]) {
        const style = getComputedStyle(glyphFor(on));
        assert(style.fill === ref.fill,
          `grouping ${on ? 'on' : 'off'}: glyph fill ${style.fill} must match a plain header icon's ${ref.fill}`);
        assert(style.opacity === ref.opacity,
          `grouping ${on ? 'on' : 'off'}: glyph opacity ${style.opacity} must match a plain header icon's ${ref.opacity}`);
      }
    } finally {
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`grouping toggle state: ${msg(e)}`); }

  // --- 2: the pinboard toggle's glyph shows whether the board is open ---
  try {
    const { root, get } = mountButtons(served, ['pinboard-header-button']);
    try {
      const button = get('pinboard-header-button');
      button.hidden = false;

      /**
       * @param {boolean} open - Whether the board is open.
       * @returns {SVGElement} The one glyph shown in that state.
       */
      const glyphFor = (open) => {
        // pinboard-shell reflects the board's state in aria-expanded alone.
        button.setAttribute('aria-expanded', String(open));
        const shown = shownGlyphs(button);
        assert(shown.length === 1, `exactly one glyph shows with the board ${open ? 'open' : 'closed'}, got ${shown.length}`);
        return shown[0];
      };

      assert(glyphFor(true).classList.contains('pinboard-glyph-open'),
        'with the board open the toggle shows the filled-panel glyph');
      assert(glyphFor(false).classList.contains('pinboard-glyph-closed'),
        'with the board closed it shows the outline glyph');
    } finally {
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`pinboard toggle state: ${msg(e)}`); }

  // --- 3: the network button carries the connected-clients count ---
  try {
    assert(!served.querySelector('#project-clients-indicator, project-path-display [class*="clients"]'),
      'the project chip carries no clients indicator — the count lives on the network button');

    const { root, get } = mountButtons(served, ['network-button']);
    /** @type {Map<string, Set<(data: any) => void>>} */
    const listeners = new Map();
    // A private event source: the lane's real socket hears every other lane
    // join and leave, which would move the count under the assertions.
    const events = {
      on: (/** @type {string} */ type, /** @type {(data: any) => void} */ fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(fn);
      },
      off: (/** @type {string} */ type, /** @type {(data: any) => void} */ fn) => { listeners.get(type)?.delete(fn); },
    };
    // `count` windows of their own, plus `popOuts` pinboards detached from one
    // of them — which the server counts like any viewer and names the owner of.
    const clientsChanged = (/** @type {number} */ count, popOuts = 0) => {
      const clients = [
        ...Array.from({ length: count }, (_, i) => ({ id: `c${i}`, viewerId: `v${i}` })),
        ...Array.from({ length: popOuts }, (_, i) => ({ id: `p${i}`, viewerId: `pv${i}`, ownerViewerId: 'v0' })),
      ];
      for (const fn of listeners.get('clients-changed') || []) fn({ count: clients.length, clients });
    };
    const binding = bindNetworkClients(get('network-button'), { events, seed: async () => 2 });
    try {
      const button = get('network-button');
      const clients = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__clients'));
      assert(!!clients, 'the network button has a clients element');
      const shown = () => !!clients && getComputedStyle(clients).display !== 'none';
      const count = () => button.querySelector('.network-button__count')?.textContent;

      await binding.ready;
      assert(shown() && count() === '1',
        `the seeded total of 2 shows one OTHER client, got shown=${shown()} count=${count()}`);

      clientsChanged(1);
      assert(!shown(), 'alone, the button shows no count');
      assert(button.title === 'Network settings' && button.getAttribute('aria-label') === 'Network settings',
        `alone, the button is plain "Network settings", got "${button.title}"`);
      const aloneWidth = button.getBoundingClientRect().width;

      clientsChanged(4);
      assert(shown() && count() === '3', `four connected shows 3 others, got shown=${shown()} count=${count()}`);
      assert(button.title === 'Network settings — 3 other clients connected',
        `the title names the count, got "${button.title}"`);
      assert(button.getAttribute('aria-label') === button.title, 'the accessible name says the same');
      assert(clients?.textContent === '3 connected', `the label reads "3 connected", got "${clients?.textContent}"`);
      assert(button.classList.contains('has-clients'), 'the button is marked as carrying a count');
      assert(button.getBoundingClientRect().width === aloneWidth,
        `the badge sits over the icon, never widening the button (${aloneWidth} → ${button.getBoundingClientRect().width})`);

      clientsChanged(2);
      assert(button.title === 'Network settings — 1 other client connected',
        `one other client reads in the singular, got "${button.title}"`);

      clientsChanged(1);
      assert(!shown() && button.title === 'Network settings' && !button.classList.contains('has-clients'),
        'the count goes away when the others leave');

      // A detached pinboard is this window's own, not somebody else sharing it.
      clientsChanged(1, 2);
      assert(!shown(), `popped-out pinboards are not other clients, got shown=${shown()} count=${count()}`);
      clientsChanged(2, 3);
      assert(shown() && count() === '1', `pop-outs leave the real others counted, got count=${count()}`);
      clientsChanged(1);

      binding.dispose();
      clientsChanged(5);
      assert(!shown(), 'a disposed binding stops listening');
    } finally {
      binding.dispose();
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`network clients: ${msg(e)}`); }

  // --- 4: undo/redo sit with the project, not with the app-wide controls ---
  try {
    const history = served.querySelector('.header-history');
    assert(!!history, 'the header has a .header-history group');
    assert(history?.previousElementSibling?.tagName === 'PROJECT-PATH-DISPLAY',
      'it follows the project chip directly');
    assert(!!history?.querySelector('#control-undo-button') && !!history?.querySelector('#control-redo-button'),
      'it holds undo and redo');
    assert(!served.querySelector('header-actions #control-undo-button, header-actions #control-redo-button'),
      'and the app-wide cluster no longer does');

    // Wide: the free space opens AFTER undo/redo, so they hug the chip.
    const wide = await framedHeader(served, 1400);
    try {
      const chip = wide.box('project-path-display');
      const undo = wide.box('#control-undo-button');
      const redo = wide.box('#control-redo-button');
      const actions = wide.box('header-actions');
      assert(undo.left - chip.right < 40,
        `undo sits beside the chip (${Math.round(undo.left - chip.right)}px away)`);
      assert(actions.left - redo.right > 200,
        `the open space is between redo and the app-wide controls (${Math.round(actions.left - redo.right)}px)`);

      // Window mode: the header is a drag region, and the group must opt out.
      wide.doc.body.classList.add('window-mode');
      const drag = wide.doc.defaultView?.getComputedStyle(wide.el('#control-undo-button'))
        .getPropertyValue('--wails-draggable').trim();
      assert(drag === 'no-drag', `undo is clickable in a desktop window, not a drag handle (got "${drag}")`);
      // The project path is a label, so it drags the window like the rest of
      // the title bar; the new-window button welded to it does not.
      const dragOf = (/** @type {string} */ sel) => wide.doc.defaultView?.getComputedStyle(wide.el(sel))
        .getPropertyValue('--wails-draggable').trim();
      assert(dragOf('#project-path-chip') !== 'no-drag',
        `the project path is part of the drag region (got "${dragOf('#project-path-chip')}")`);
      assert(dragOf('#project-new-window-button') === 'no-drag',
        `the new-window button is clickable in a desktop window (got "${dragOf('#project-new-window-button')}")`);
      wide.doc.body.classList.remove('window-mode');

      // A session stays on its project, so its path is read-only: a label with
      // nothing to click, not a button that leads somewhere.
      const path = wide.el('#project-path-chip');
      assert(path.tagName !== 'BUTTON' && !path.classList.contains('btn-ghost') && !path.hasAttribute('aria-haspopup'),
        `the project path is not a button (got <${path.tagName.toLowerCase()} class="${path.className}">)`);
      assert(!path.querySelector('.ppd-chevron'), 'the project path carries no chevron');
      assert(wide.doc.defaultView?.getComputedStyle(path).cursor !== 'pointer',
        'the project path has no pointer cursor');

      // A detached board window keeps none of the opener's conversation controls.
      wide.doc.documentElement.dataset.view = 'pinboard';
      assert(wide.doc.defaultView?.getComputedStyle(wide.el('.header-history')).display === 'none',
        'a detached board window has no undo/redo');
    } finally {
      wide.frame.remove();
    }

    // Phone: the chip keeps row 1; undo/redo join the button row beneath it.
    const phone = await framedHeader(served, 400);
    try {
      const chip = phone.box('project-path-display');
      const undo = phone.box('#control-undo-button');
      const settings = phone.box('#settings-button');
      const middle = (/** @type {DOMRect} */ r) => r.top + r.height / 2;
      assert(undo.top >= chip.bottom - 1,
        `undo drops below the chip on a phone (undo top ${Math.round(undo.top)}, chip bottom ${Math.round(chip.bottom)})`);
      assert(Math.abs(middle(undo) - middle(settings)) < 2,
        `undo shares the button row with settings (${Math.round(middle(undo))} vs ${Math.round(middle(settings))})`);
      assert(undo.right <= 400 && settings.right <= 400, 'nothing spills off the right edge');
    } finally {
      phone.frame.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`history group: ${msg(e)}`); }

  // --- 5: the app-wide controls are grouped, and the groups spread with room ---
  try {
    /** @type {Record<string, string[]>} */
    const expected = {
      network: ['network-button'],
      view: ['tool-grouping-button', 'zoom-out-button', 'zoom-in-button', 'theme-button', 'bell-button'],
      app: ['help-button', 'settings-button'],
      panel: ['pinboard-header-button'],
    };
    const groups = [...served.querySelectorAll('.header-actions-controls > .header-group')];
    assert(groups.map((g) => g.className).join() === Object.keys(expected).map((k) => `header-group header-group--${k}`).join(),
      `the controls are grouped network, view, app, panel — got ${groups.map((g) => g.className).join(' | ')}`);
    for (const [name, ids] of Object.entries(expected)) {
      const got = [...served.querySelectorAll(`.header-group--${name} button`)].map((b) => b.id);
      assert(got.filter((id) => ids.includes(id)).join() === ids.join(),
        `the ${name} group holds ${ids.join(', ')} in order, got ${got.join(', ')}`);
    }

    /**
     * @param {number} width - Header width to lay out at.
     * @returns {Promise<{between: number, within: number}>} The gap between two
     *   groups (bell → help) and between two buttons of one group (theme → bell).
     */
    const gapsAt = async (width) => {
      const f = await framedHeader(served, width);
      try {
        return {
          between: f.box('#help-button').left - f.box('#bell-button').right,
          within: f.box('#bell-button').left - f.box('#theme-button').right,
        };
      } finally {
        f.frame.remove();
      }
    };
    const narrow = await gapsAt(1000);
    const roomy = await gapsAt(2000);
    for (const [label, g] of /** @type {const} */ ([['1000px', narrow], ['2000px', roomy]])) {
      assert(Math.round(g.within) === 4, `${label}: buttons within a group sit 4px apart, got ${g.within}`);
      assert(g.between > g.within * 2, `${label}: groups sit visibly further apart (${g.between}px) than their buttons (${g.within}px)`);
    }
    assert(roomy.between > narrow.between + 6,
      `the gap between groups grows with the header (${narrow.between}px at 1000 → ${roomy.between}px at 2000)`);

    // With room to spare the network count reads as a label, not a badge.
    for (const [width, label] of /** @type {const} */ ([[2000, true], [1000, false]])) {
      const f = await framedHeader(served, width);
      try {
        const button = f.el('#network-button');
        f.el('.network-button__clients').hidden = false;
        f.el('.network-button__count').textContent = '2';
        button.classList.add('has-clients');
        const view = /** @type {Window} */ (f.doc.defaultView);
        const suffixShown = view.getComputedStyle(f.el('.network-button__suffix')).display !== 'none';
        assert(suffixShown === label,
          `${width}px: "connected" ${label ? 'is' : 'is not'} spelled out (shown=${suffixShown})`);
        if (label) {
          // The same small print as a remote window's host, one line or two.
          const size = parseFloat(view.getComputedStyle(f.el('.network-button__clients')).fontSize);
          assert(size < 12, `${width}px: the label is small print, got ${size}px`);
        }
        const w = button.getBoundingClientRect().width;
        assert(label ? w > 60 : Math.round(w) === 32,
          `${width}px: the button is ${label ? 'widened to hold the label' : 'icon-sized'}, got ${w}px`);
      } finally {
        f.frame.remove();
      }
    }
    passed++;
  } catch (e) { failed++; errors.push(`grouped controls: ${msg(e)}`); }

  // --- 6: below 900px the rarely-used controls fold into a "…" menu ---
  try {
    const folded = ['#help-button', '#zoom-out-button', '#zoom-in-button'];
    for (const [width, overflowing] of /** @type {const} */ ([[1200, false], [800, true], [400, true]])) {
      const f = await framedHeader(served, width);
      try {
        // Rendered, not merely un-hidden itself: what folds is a wrapper, and a
        // button inside a hidden wrapper still reports its own display.
        const displayed = (/** @type {string} */ sel) => f.el(sel).getClientRects().length > 0;
        assert(displayed('#header-overflow-button') === overflowing,
          `${width}px: the "…" button is ${overflowing ? 'shown' : 'not shown'}`);
        for (const sel of folded) {
          assert(displayed(sel) === !overflowing,
            `${width}px: ${sel} is ${overflowing ? 'folded into the menu' : 'in the row'}`);
        }
        assert(displayed('#settings-button') && displayed('#network-button') && displayed('#theme-button'),
          `${width}px: settings, network and theme always stay in the row`);
      } finally {
        f.frame.remove();
      }
    }

    // A Windows or Linux desktop window has no menu bar, so the "…" menu is its
    // app menu and is there at any width. A Mac window has the menu bar and a
    // browser tab has the browser's, so both keep "…" for the narrow header.
    for (const [platform, windowMode, shown] of /** @type {const} */ ([
      ['windows', true, true], ['linux', true, true], ['mac', true, false], ['windows', false, false],
    ])) {
      const f = await framedHeader(served, 1200);
      const where = `1200px, ${platform}${windowMode ? ' desktop window' : ', not a desktop window'}`;
      try {
        f.doc.documentElement.dataset.windowPlatform = platform;
        if (windowMode) {
          f.doc.documentElement.dataset.windowMode = '1';
          f.doc.body.classList.add('window-mode');
        }
        const displayed = (/** @type {string} */ sel) => f.el(sel).getClientRects().length > 0;
        assert(displayed('#header-overflow-button') === shown,
          `${where}: the "…" button is ${shown ? 'shown' : 'not shown'}`);
        for (const sel of folded) {
          assert(displayed(sel), `${where}: ${sel} stays in the row`);
        }
      } finally {
        f.frame.remove();
      }
    }

    // The menu offers exactly what the row gave up, each with its shortcut.
    const { root, get } = mountButtons(served, ['header-overflow-button']);
    const button = get('header-overflow-button');
    /** @type {string[]} */
    const ran = [];
    const menu = setupHeaderOverflowMenu(button, [
      { label: 'Decrease font size', shortcutId: 'zoom-out', run: () => ran.push('zoom-out') },
      { label: 'Increase font size', shortcutId: 'zoom-in', run: () => ran.push('zoom-in') },
      { label: 'Tips & keyboard shortcuts', shortcutId: 'show-shortcuts', run: () => ran.push('help') },
    ]);
    try {
      const surface = () => document.querySelector('.header-overflow-menu');
      assert(!surface() && button.getAttribute('aria-expanded') === 'false', 'the menu starts closed');

      button.click();
      const rows = [...(surface()?.querySelectorAll('.menu-item') || [])];
      assert(rows.length === 3, `three rows, got ${rows.length}`);
      assertMenuShape(surface(), 'header overflow menu');
      assert(button.getAttribute('aria-expanded') === 'true', 'the button says the menu is open');
      const labelOf = (/** @type {Element} */ r) => r.querySelector('.menu-item-name')?.textContent;
      const keysOf = (/** @type {Element} */ r) => r.querySelector('.menu-item-shortcut')?.textContent;
      assert(rows.map(labelOf).join('|') === 'Decrease font size|Increase font size|Tips & keyboard shortcuts',
        `the rows are labelled for what they do, got ${rows.map(labelOf).join('|')}`);
      for (const [i, id] of ['zoom-out', 'zoom-in', 'show-shortcuts'].entries()) {
        assert(keysOf(rows[i]) === keyShortcutManager.formatBinding(id) && !!keysOf(rows[i]),
          `row ${i} shows its shortcut ${keyShortcutManager.formatBinding(id)}, got "${keysOf(rows[i])}"`);
      }

      /** @type {HTMLElement} */ (rows[1]).click();
      assert(ran.join() === 'zoom-in', `choosing a row runs its action and only its action, got [${ran}]`);
      assert(!surface() && button.getAttribute('aria-expanded') === 'false', 'choosing a row closes the menu');

      button.click();
      assert(!!surface(), 'the button opens it again');
      button.click();
      assert(!surface(), 'and a second click on the button closes it');
      assert(ran.join() === 'zoom-in', 'without running anything');
    } finally {
      menu.dispose();
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`overflow menu: ${msg(e)}`); }

  // --- 6b: in a Windows or Linux desktop window "…" is the app menu ---
  try {
    const { root, get } = mountButtons(served, ['header-overflow-button']);
    const button = get('header-overflow-button');
    const surface = () => document.querySelector('.header-overflow-menu');
    /**
     * Open a menu of `items`, check its shape, and read it back: each item's
     * label, each separator as '—'.
     * @param {import('../../js/utils/header-overflow-menu.js').HeaderOverflowItem[]} items
     * @param {string} where - Names the menu in a failure.
     * @returns {{rows: string, menu: HTMLElement, dispose: () => void}} The rows
     *   joined by '|', the open menu, and a way to close and unwire it.
     */
    const openMenu = (items, where) => {
      const wired = setupHeaderOverflowMenu(button, items);
      button.click();
      const menu = assertMenuShape(surface(), where);
      const rows = [...menu.children].map((child) => (child.getAttribute('role') === 'separator'
        ? '—'
        : child.querySelector('.menu-item-name')?.textContent)).join('|');
      return { rows, menu, dispose: wired.dispose };
    };
    try {
      // Separators belong between rows: one that leads, trails or doubles up
      // once omitted rows are gone is dropped. A row needs no shortcut.
      const sparse = openMenu([
        { separator: true },
        { label: 'A', run: () => {} },
        { separator: true },
        { label: 'B', run: () => {}, omit: () => true },
        { separator: true },
        { label: 'C', shortcutId: 'zoom-in', run: () => {} },
        { separator: true },
      ], 'sparse menu');
      try {
        assert(sparse.rows === 'A|—|C', `separators collapse around omitted rows, got ${sparse.rows}`);
        assert(!sparse.menu.children[0].querySelector('.menu-item-shortcut'), 'a row with no shortcut shows none');
      } finally {
        sparse.dispose();
      }

      /** @type {string[]} */
      const posted = [];
      const compose = (/** @type {'windows'|'linux'|null} */ platform, folded = false, touch = false) =>
        headerOverflowItems({ platform, folded: () => folded, touch: () => touch, post: (action) => posted.push(action) });
      const head = 'New Tab|New Window|—|Open...|Connect to Server...';
      const tail = 'Settings|About Juggler';
      const foldedRows = 'Decrease font size|Increase font size|Tips & keyboard shortcuts';
      for (const [platform, folded, touch, want] of /** @type {const} */ ([
        ['windows', false, false, `${head}|—|${tail}|—|Exit`],
        ['windows', true, false, `${head}|—|${foldedRows}|—|${tail}|—|Exit`],
        ['windows', true, true, `${head}|—|Decrease font size|Increase font size|—|${tail}|—|Exit`],
        ['linux', false, false, `${head}|—|${tail}|—|Quit`],
        // Anywhere else "…" shows only on a narrow header, and offers back
        // exactly what the row gave up.
        [null, true, false, foldedRows],
        [null, true, true, 'Decrease font size|Increase font size'],
      ])) {
        const where = `${platform ?? 'no app menu'}${folded ? ', folded' : ''}${touch ? ', touch' : ''}`;
        const opened = openMenu(compose(platform, folded, touch), where);
        try {
          assert(opened.rows === want, `${where}: rows are ${opened.rows}, want ${want}`);
        } finally {
          opened.dispose();
        }
      }

      const app = openMenu(compose('windows'), 'windows app menu');
      try {
        const named = (/** @type {string} */ label) => /** @type {HTMLElement} */ ([...app.menu.querySelectorAll('.menu-item')]
          .find((row) => row.querySelector('.menu-item-name')?.textContent === label));
        const keysOf = (/** @type {string} */ label) => named(label).querySelector('.menu-item-shortcut')?.textContent;
        assert(keysOf('New Window') === keyShortcutManager.formatBinding('new-window') && !!keysOf('New Window'),
          `New Window shows its shortcut, got "${keysOf('New Window')}"`);
        assert(!keysOf('Open...'), 'Open... names no shortcut');
        named('Exit').click();
        assert(posted.join() === 'quit', `Exit asks the app to quit, posted [${posted}]`);
        assert(!surface(), 'choosing Exit closes the menu');
      } finally {
        app.dispose();
      }

      // Under en-XA every row is translated, the Go menu's strings included.
      await underPseudoLocale('test-header-app-menu', () => {
        const opened = openMenu(compose('windows', true), 'en-XA app menu');
        try {
          assertPseudoLocalized(opened.menu, { skip: '.menu-item-shortcut', atLeast: 10, where: 'Windows app menu' });
        } finally {
          opened.dispose();
        }
        const linux = openMenu(compose('linux'), 'en-XA linux app menu');
        try {
          assertPseudoLocalized(linux.menu, { skip: '.menu-item-shortcut', atLeast: 7, where: 'Linux app menu' });
        } finally {
          linux.dispose();
        }
      });
    } finally {
      root.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`app menu: ${msg(e)}`); }

  // --- 7: tooltips carry shortcuts, and follow a title that changes under them ---
  try {
    assert(served.querySelector('#help-button')?.getAttribute('data-shortcut-id') === 'show-shortcuts',
      'the help button names its shortcut, so its tooltip shows it');

    // A header title can change while its tooltip is up — undo going busy
    // under the pointer. Leaving must not put the stale text back.
    const button = document.createElement('button');
    button.title = 'Undo';
    document.body.appendChild(button);
    try {
      tooltipManager.showFor(button);
      assert(!button.hasAttribute('title'), 'precondition: the tooltip has taken the native title');
      button.title = 'Unavailable while the agent is running';
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      assert(button.title === 'Unavailable while the agent is running',
        `the title set while the tooltip was up survives it, got "${button.title}"`);
    } finally {
      button.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`tooltips: ${msg(e)}`); }

  // --- 8: under en-XA the network button's name is translated, count and all ---
  try {
    const { root, get } = mountButtons(served, ['network-button']);
    /** @type {Set<(data: any) => void>} */
    const heard = new Set();
    const events = {
      on: (/** @type {string} */ _type, /** @type {(data: any) => void} */ fn) => { heard.add(fn); },
      off: (/** @type {string} */ _type, /** @type {(data: any) => void} */ fn) => { heard.delete(fn); },
    };
    const clientsChanged = (/** @type {number} */ count) => {
      const clients = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, viewerId: `v${i}` }));
      for (const fn of [...heard]) fn({ count, clients });
    };
    /** @type {string[]} */
    const shown = [];
    try {
      await underPseudoLocale('test-header-bar', async () => {
        // A seed that cannot be read leaves the starting name to the binding.
        const binding = bindNetworkClients(get('network-button'), { events, seed: async () => null });
        try {
          await binding.ready;
          const button = get('network-button');
          shown.push(button.title, String(button.getAttribute('aria-label')));
          for (const total of [1, 2, 4]) {
            clientsChanged(total);
            shown.push(button.title, String(button.getAttribute('aria-label')));
          }
          // The "N connected" label is one sentence, the count inside it.
          for (const total of [2, 4]) {
            clientsChanged(total);
            const label = button.querySelector('.network-button__clients')?.textContent ?? '';
            assert(label.includes(String(total - 1)), `the label keeps its count: ${JSON.stringify(label)}`);
            assert(button.querySelector('.network-button__count')?.textContent === String(total - 1),
              `the badge still holds the bare count: ${JSON.stringify(label)}`);
            shown.push(label);
          }
        } finally {
          binding.dispose();
        }
      });
    } finally {
      root.remove();
    }
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA (network button): ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) { failed++; errors.push(`network button en-XA: ${msg(e)}`); }

  // --- 9: a window on another server names it in the network button ---
  try {
    // Only the external-server flag makes a host worth naming.
    const html = document.createElement('html');
    assert(externalServerHost(html, { host: 'devbox:8080' }) === '',
      'a window on a server the app started has no remote host');
    html.dataset.externalServer = '1';
    assert(externalServerHost(html, { host: 'devbox:8080' }) === 'devbox:8080',
      'a window on a server by URL is named by its host');

    // One place for what the network is doing: no second badge by the project.
    assert(!served.querySelector('project-path-display [id*="remote"], project-path-display [class*="remote"]'),
      'the project chip carries no server indicator — the host lives in the network button');

    /** @type {Set<(data: any) => void>} */
    const heard = new Set();
    const events = {
      on: (/** @type {string} */ _type, /** @type {(data: any) => void} */ fn) => { heard.add(fn); },
      off: (/** @type {string} */ _type, /** @type {(data: any) => void} */ fn) => { heard.delete(fn); },
    };
    const clientsChanged = (/** @type {number} */ count) => {
      const clients = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, viewerId: `v${i}` }));
      for (const fn of [...heard]) fn({ count, clients });
    };

    for (const width of [1000, 2000]) {
      const f = await framedHeader(served, width);
      try {
        const view = /** @type {Window} */ (f.doc.defaultView);
        const button = f.el('#network-button');
        const host = f.el('.network-button__host');
        const hostShown = () => view.getComputedStyle(host).display !== 'none';

        /**
         * Where the count badge lands on the "lan" glyph, as fractions of the
         * glyph's box. Its ink leaves the top-right corner bare — right of the
         * top box (x 640 of the 960 viewBox) and above the crossbar (y 440) —
         * and the badge belongs in that corner.
         * @param {string} where - Label for the assertion.
         */
        const assertBadgeClearsGlyph = (where) => {
          const glyph = view.getComputedStyle(button, '::before');
          const b = button.getBoundingClientRect();
          const size = parseFloat(glyph.width);
          // Positioned in the padding box, inside the button's border.
          const left = b.left + button.clientLeft + parseFloat(glyph.left) - size / 2;
          const top = b.top + button.clientTop + parseFloat(glyph.top) - size / 2;
          const badge = f.el('.network-button__clients').getBoundingClientRect();
          const x = (badge.left - left) / size;
          const y = (badge.bottom - top) / size;
          assert(x >= 640 / 960 - 0.01 && y <= 440 / 960 + 0.01,
            `${where}: the badge sits in the glyph's bare top-right corner, clear of its ink (left edge at ${x.toFixed(2)} of the glyph, needs ≥ 0.67; bottom at ${y.toFixed(2)}, needs ≤ 0.46)`);
        };

        // This computer's own server: the icon alone, as ever.
        const local = bindNetworkClients(button, { events, seed: async () => 1, host: '' });
        await local.ready;
        assert(!hostShown(), `${width}px: a local window names no host`);
        assert(Math.round(button.getBoundingClientRect().width) === 32,
          `${width}px: a local window's button is icon-sized, got ${button.getBoundingClientRect().width}px`);
        if (width === 1000) {
          clientsChanged(3);
          assertBadgeClearsGlyph(`${width}px, local`);
        }
        local.dispose();

        const remote = bindNetworkClients(button, { events, seed: async () => 1, host: 'devbox:8080' });
        try {
          await remote.ready;
          assert(hostShown() && host.textContent === 'devbox:8080',
            `${width}px: a remote window's button reads the host, got shown=${hostShown()} "${host.textContent}"`);
          const b = button.getBoundingClientRect();
          const h = host.getBoundingClientRect();
          assert(h.left >= b.left && h.right <= b.right + 0.5,
            `${width}px: the host sits inside the button (${Math.round(h.left)}–${Math.round(h.right)} in ${Math.round(b.left)}–${Math.round(b.right)})`);
          assert(button.title.includes('devbox:8080') && button.getAttribute('aria-label') === button.title,
            `${width}px: the title and accessible name name the server, got "${button.title}"`);
          assert(b.right <= f.box('#tool-grouping-button').left,
            `${width}px: the network button leads the button row`);
          // Small print, so a long host does not make the button a slab.
          const hostSize = parseFloat(view.getComputedStyle(host).fontSize);
          assert(hostSize < 12, `${width}px: the host is small print, under 12px, got ${hostSize}px`);

          clientsChanged(3);
          assert(button.title.includes('devbox:8080') && button.title.includes('2'),
            `${width}px: the title names the server and the other clients, got "${button.title}"`);
          const count = f.el('.network-button__count');
          assert(view.getComputedStyle(f.el('.network-button__clients')).display !== 'none' && count.textContent === '2',
            `${width}px: the count still shows beside the host`);
          // Measured afresh: the row is right-aligned, so a button that grows
          // to hold a label moves its left edge.
          const c = count.getBoundingClientRect();
          const at = button.getBoundingClientRect();
          if (width === 1000) {
            // Narrow, the count is the badge, and it stays on the icon rather
            // than drifting to the end of a now-wider button.
            assert(c.left < at.left + 32,
              `${width}px: the badge sits over the icon (badge at ${Math.round(c.left - at.left)}px into the button)`);
            assertBadgeClearsGlyph(`${width}px, remote`);
            const badge = f.el('.network-button__clients').getBoundingClientRect();
            assert(badge.right <= host.getBoundingClientRect().left + 0.5,
              `${width}px, remote: the badge stops short of the host (badge right ${Math.round(badge.right - at.left)}px, host left ${Math.round(host.getBoundingClientRect().left - at.left)}px)`);
          } else {
            // Wide, the "N connected" label is a second line under the host
            // rather than a second run of text beside it, so the button only
            // ever grows to its longer line, and the two lines fit the
            // header's 32px row.
            const now = host.getBoundingClientRect();
            const label = f.el('.network-button__clients').getBoundingClientRect();
            assert(label.top >= now.bottom - 0.5,
              `${width}px: the label sits under the host (label top ${Math.round(label.top - at.top)}px, host bottom ${Math.round(now.bottom - at.top)}px)`);
            assert(Math.abs(label.left - now.left) < 1,
              `${width}px: the two lines share a left edge (${Math.round(label.left - at.left)} vs ${Math.round(now.left - at.left)}px)`);
            assert(now.top >= at.top - 0.5 && label.bottom <= at.bottom + 0.5 && Math.round(at.height) === 32,
              `${width}px: both lines fit a 32px button (button ${Math.round(at.height)}px, lines ${Math.round(now.top - at.top)}–${Math.round(label.bottom - at.top)}px)`);
            assert(parseFloat(view.getComputedStyle(f.el('.network-button__clients')).fontSize) === hostSize,
              `${width}px: both lines are set at one size`);
          }
        } finally {
          remote.dispose();
        }
      } finally {
        f.frame.remove();
      }
    }

    const { root, get } = mountButtons(served, ['network-button']);
    /** @type {string[]} */
    const shown = [];
    try {
      await underPseudoLocale('test-header-bar-remote', async () => {
        const binding = bindNetworkClients(get('network-button'), { events, seed: async () => null, host: '9:9' });
        try {
          await binding.ready;
          for (const total of [1, 2, 4]) {
            clientsChanged(total);
            shown.push(get('network-button').title, String(get('network-button').getAttribute('aria-label')));
          }
        } finally {
          binding.dispose();
        }
      });
    } finally {
      root.remove();
    }
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA (remote network button): ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) { failed++; errors.push(`remote host in the network button: ${msg(e)}`); }

  // --- 10: the caption buttons of a frameless window stay inside it ---
  try {
    // Every header layout (wide, the tightened padding under 64rem, the
    // wrapped phone rows), and a zoomed root font-size, which scales the
    // header's padding the caption strip has to cancel.
    for (const [platform, width, rootFontSize] of /** @type {const} */ ([
      ['windows', 1400, ''], ['windows', 800, ''], ['windows', 400, ''], ['windows', 1400, '20px'],
      ['linux', 1400, ''], ['linux', 800, ''], ['linux', 400, ''],
    ])) {
      const f = await framedHeader(served, width);
      const where = `${platform}, ${width}px${rootFontSize ? `, root font ${rootFontSize}` : ''}`;
      try {
        const root = f.doc.documentElement;
        root.dataset.windowPlatform = platform;
        root.dataset.windowMode = '1';
        root.style.fontSize = rootFontSize;
        f.doc.body.classList.add('window-mode');
        // The element stays inert in the frame, so give it the buttons it draws.
        const controls = f.el('window-caption-controls');
        for (const kind of ['minimise', 'maximise', 'close']) {
          const b = f.doc.createElement('button');
          b.className = `window-caption-btn window-caption-btn--${kind}`;
          controls.appendChild(b);
        }
        const header = f.box('.app-header');
        const close = f.box('.window-caption-btn--close');
        const box = controls.getBoundingClientRect();
        assert(close.width > 0 && close.right <= header.right + 0.5 && close.right <= width + 0.5,
          `${where}: close sits inside the window (right edge ${close.right}, header ${header.right})`);
        assert(box.left >= header.left - 0.5 && box.top >= header.top - 0.5,
          `${where}: the caption buttons sit inside the header (top ${box.top - header.top}px)`);
        if (platform === 'windows') {
          assert(Math.abs(close.right - header.right) < 0.5 && Math.abs(box.top - header.top) < 0.5,
            `${where}: the caption strip is flush to the top-right corner (${header.right - close.right}px from the right, ${box.top - header.top}px from the top)`);
        }
      } finally {
        f.frame.remove();
      }
    }
    passed++;
  } catch (e) { failed++; errors.push(`caption buttons: ${msg(e)}`); }

  // --- 11: the condensed header shrinks the wordmark, but not too far ---
  try {
    /**
     * @param {number} width - Header width to lay out at.
     * @returns {Promise<{height: number, clearance: number}>} The wordmark's
     *   height and its distance from the header's left edge.
     */
    const wordmarkAt = async (width) => {
      const f = await framedHeader(served, width);
      try {
        const logo = f.el('.logo');
        return {
          height: parseFloat(/** @type {Window} */ (f.doc.defaultView).getComputedStyle(logo, '::before').height),
          clearance: logo.getBoundingClientRect().left - f.box('.app-header').left,
        };
      } finally {
        f.frame.remove();
      }
    };
    const wide = await wordmarkAt(1400);
    const condensed = await wordmarkAt(800);
    assert(condensed.height < wide.height,
      `the condensed header still shrinks the wordmark (${condensed.height}px vs ${wide.height}px)`);
    assert(condensed.height >= wide.height * 0.8,
      `the condensed wordmark keeps at least 80% of its size (${condensed.height}px of ${wide.height}px)`);
    assert(Math.abs(condensed.clearance - wide.clearance) < 0.5,
      `the condensed wordmark keeps the full header's left clearance (${condensed.clearance}px vs ${wide.clearance}px)`);
    passed++;
  } catch (e) { failed++; errors.push(`condensed wordmark: ${msg(e)}`); }

  // --- 12: the +/- zoom scales the whole header as one ---
  try {
    /**
     * The header's geometry at one root font-size, in a frame widened in step
     * with it, so every breakpoint lands on the same side at both sizes.
     * @param {string} rootFontSize - The root font-size the zoom would set.
     * @param {number} width - The frame's width in px.
     * @returns {Promise<Record<string, number>>} Each measure, in px.
     */
    const geometryAt = async (rootFontSize, width) => {
      const f = await framedHeader(served, width);
      try {
        f.doc.documentElement.style.fontSize = rootFontSize;
        const view = /** @type {Window} */ (f.doc.defaultView);
        f.el('.network-button__clients').hidden = false;
        f.el('.network-button__count').textContent = '2';
        const update = f.el('update-button');
        update.hidden = false;
        const pill = f.doc.createElement('button');
        pill.className = 'update-btn';
        pill.textContent = 'Update';
        update.appendChild(pill);
        return {
          'header height': f.box('.app-header').height,
          'wordmark clearance': f.box('.logo').left - f.box('.app-header').left,
          'icon button': f.box('#theme-button').width,
          'icon glyph': f.box('#theme-button svg').width,
          'network glyph': parseFloat(view.getComputedStyle(f.el('#network-button'), '::before').width),
          'client badge': f.box('.network-button__clients').height,
          'gap within a group': f.box('#bell-button').left - f.box('#theme-button').right,
          'undo button': f.box('#control-undo-button').height,
          'update pill': f.box('.update-btn').height,
        };
      } finally {
        f.frame.remove();
      }
    };
    const plain = await geometryAt('', 1200);
    const zoomed = await geometryAt('20px', 1500);
    const off = Object.keys(plain).filter((k) => Math.abs(zoomed[k] / plain[k] - 1.25) > 0.04)
      .map((k) => `${k} ${Math.round(plain[k] * 10) / 10}px → ${Math.round(zoomed[k] * 10) / 10}px`);
    assert(off.length === 0, `at 125% zoom every header measure grows by 125%, but: ${off.join(', ')}`);
    passed++;
  } catch (e) { failed++; errors.push(`zoomed header: ${msg(e)}`); }

  return { passed, failed, errors };
}
