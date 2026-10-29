//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Find (⌘F) unit tests.
 *
 * Covers five layers: the framework-free {@link FindController} match engine
 * (case-sensitivity, whole-word, next/prev wrap-around, empty queries, what
 * counts as searchable text, and post-mutation refresh), the
 * `find-in-conversation` shortcut definition in the shared
 * {@link keyShortcutManager} table, the singleton {@link findBar}'s DOM
 * interaction (open/focus, debounced typing → counter, Enter/Shift+Enter
 * navigation, whole-word toggle, Escape-to-close focus restoration, keys that
 * must not escape to the document, and the streaming live-recount), the panels
 * other than the conversation that offer somewhere to search and how
 * {@link findPanelFor} picks between them, and revealing the active match — the
 * {@link expandCollapsibleContaining} auto-open helper and the geometry that
 * puts the match itself on screen.
 *
 * The bar knows no panel by name: each says where to search through its own
 * `getFindTarget()`. So the panel fixtures here are skeletons wearing the REAL
 * method of the element they stand for, which is what keeps them from drifting
 * into a contract nothing ships.
 *
 * The count and the reveal are two halves of one guarantee: every match the
 * counter claims is one the user can be shown. So the engine tests pin down both
 * sides of the visibility line — text hidden from view is not counted, text
 * merely clipped is — and the reveal tests assert on real layout.
 *
 * The CSS Custom Highlight paint is feature-detected and may be absent in the
 * headless engine, so only one test touches `CSS.highlights` (the re-use of
 * one registered Highlight per name, skipped where the API is absent); the rest
 * assert on `total`/`current`, the counter text, the DOM, and (in the reveal
 * section) measured rects. All fixtures attach to `document.body` and are torn down (and
 * the bar closed) in `finally` blocks so no state leaks into sibling suites.
 * @module unit-tests/find-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import FindController from '../../js/services/find-controller.js';
import findBar, { findPanelFor } from '../../js/components/find-bar.js';
import keyShortcutManager, { formatBindingLabel, isMac } from '../../js/services/key-shortcut-manager.js';
import { expandCollapsibleContaining } from '../../js/utils/collapsible.js';
// Defines <pinboard-content>, whose getFindTarget() the pinboard fixtures wear.
// The conversation column and properties panel are already loaded by the page.
import '../../js/components/pinboard-content.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Wait for the bar's counter in `host` to read something other than `from`:
 * the debounced search (or the debounced MutationObserver refresh) has run and
 * redrawn it. The caller then asserts exactly what it reads.
 * @param {HTMLElement} host - The panel the bar is mounted in.
 * @param {string} from - The counter text before the change.
 * @param {string} what - What the redraw follows from.
 * @returns {Promise<string>} The new counter text.
 */
function counterChanged(host, from, what) {
  return waitFor(() => (counterText(host) !== from ? counterText(host) : ''),
    () => `the counter to redraw after ${what} (still "${counterText(host)}")`);
}

/**
 * Build a detached fixture, fill it with `html`, attach it to the document (so
 * layout, focus, scroll, and observers behave), and return it.
 * @param {string} html - Inner HTML for the fixture.
 * @returns {HTMLElement} The attached fixture element.
 */
function attach(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/**
 * Build the column skeleton `<conversation-area>.getFindTarget()` describes — a
 * positioned `conversation-message-list-wrapper` around a `#message-list`, plus
 * the `composer-box textarea` focus is restored to on close — attach it, and
 * return the column element.
 *
 * The fixture is a plain element wearing the column's REAL `getFindTarget`,
 * bound to itself. That exercises the shipped descriptor — the selectors, the
 * mount, the focus restore — without booting a whole `<conversation-area>` and
 * the session it expects, and it fails the moment the two drift apart.
 * @param {string} messagesHtml - Inner HTML for the `#message-list`.
 * @returns {HTMLElement} The attached column element.
 */
function attachColumn(messagesHtml) {
  const col = document.createElement('div');
  col.innerHTML = `
    <conversation-message-list-wrapper style="position:relative;display:block">
      <section id="message-list">${messagesHtml}</section>
    </conversation-message-list-wrapper>
    <composer-box><textarea></textarea></composer-box>`;
  wearFindTarget(col, 'conversation-area');
  document.body.appendChild(col);
  return col;
}

/**
 * Build the properties-panel skeleton its `getFindTarget()` describes — the
 * stable `properties-panel-content` wrapping the per-render
 * `properties-panel-section` that does the scrolling — wearing the panel's real
 * implementation. Pass null for the panel's empty state, which has no section
 * at all.
 * @param {string|null} sectionHtml - Inner HTML for the section, or null for an empty panel.
 * @returns {HTMLElement} The attached panel element.
 */
function attachPropertiesPanel(sectionHtml) {
  const panel = document.createElement('div');
  panel.style.position = 'relative';
  panel.innerHTML = sectionHtml === null
    ? '<properties-panel-content><properties-panel-empty>Select an item</properties-panel-empty></properties-panel-content>'
    : `<properties-panel-content><properties-panel-section>${sectionHtml}</properties-panel-section></properties-panel-content>`;
  wearFindTarget(panel, 'properties-panel');
  document.body.appendChild(panel);
  return panel;
}

/**
 * Build the pinboard skeleton `<pinboard-content>.getFindTarget()` describes —
 * the toolbar, the `.pinboard-content__body` scroller under it, and the slot one
 * mounted pin fills — wearing the element's real implementation, inside an outer
 * shell standing in for `<pinboard-shell>`. Pass null for a board with nothing
 * mounted.
 *
 * `focusBody` is stubbed because the descriptor's focus restore calls it and the
 * real one drives an item type's controller, which a fixture has no business
 * having.
 * @param {string|null} pinHtml - Inner HTML for the mounted slot, or null for no pin.
 * @returns {{shell: HTMLElement, content: HTMLElement}} The attached shell and its content element.
 */
function attachPinboard(pinHtml) {
  const shell = document.createElement('div');
  const content = document.createElement('div');
  content.style.position = 'relative';
  content.tabIndex = -1;
  const slot = pinHtml === null ? '' : `<div class="pinboard-content__slot">${pinHtml}</div>`;
  content.innerHTML = `
    <div class="pinboard-item-toolbar"></div>
    <div class="pinboard-content__body">${slot}</div>`;
  /** @type {any} */ (content).focusBody = () => content.focus();
  wearFindTarget(content, 'pinboard-content');
  shell.appendChild(content);
  document.body.appendChild(shell);
  return { shell, content };
}

/**
 * Give a fixture the `getFindTarget` of a real panel element, bound to the
 * fixture. The bar only ever duck-types the protocol, so a fixture carrying the
 * shipped method IS the panel as far as the bar is concerned.
 * @param {HTMLElement} el - The fixture to dress.
 * @param {string} tagName - The custom element whose implementation to borrow.
 * @returns {void}
 */
function wearFindTarget(el, tagName) {
  const ctor = customElements.get(tagName);
  if (!ctor) throw new Error(`<${tagName}> is not defined — the harness never loaded it`);
  const impl = /** @type {any} */ (ctor.prototype).getFindTarget;
  if (typeof impl !== 'function') throw new Error(`<${tagName}> has no getFindTarget()`);
  /** @type {any} */ (el).getFindTarget = impl.bind(el);
}

/** Three messages: "needle" appears standalone twice and once inside "needles". */
const NEEDLE_MESSAGES = `
  <div class="msg">the needle in the haystack</div>
  <div class="msg">found a needle again</div>
  <div class="msg">needles and pins</div>`;

/**
 * The bar is a singleton that retains its query and toggles across opens; reset
 * them (safe only while closed) so each interaction test starts from a clean,
 * order-independent state.
 * @returns {void}
 */
function resetBarState() {
  findBar._query = '';
  findBar._caseSensitive = false;
  findBar._wholeWord = false;
}

/**
 * @param {HTMLElement} col
 * @returns {string} The live counter's text.
 */
function counterText(col) {
  const c = col.querySelector('.find-bar__counter');
  return c ? (c.textContent || '') : '';
}

/**
 * @param {HTMLElement} col
 * @returns {number} The total from a "current of total" counter (0 otherwise).
 */
function counterTotal(col) {
  const m = counterText(col).match(/of\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {HTMLElement} col
 * @returns {number} The current index from a "current of total" counter (0 otherwise).
 */
function counterCurrent(col) {
  const m = counterText(col).match(/^\s*(\d+)\s+of/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── A. Engine (FindController) ──────────────────────────────────────

  await run('engine: search counts every occurrence, active is 1-based', () => {
    const root = attach('the cat sat on the mat, the cat ran');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const r = fc.search('cat');
      assert(r.total === 2, `expected total 2, got ${r.total}`);
      assert(r.current === 1, `expected current 1, got ${r.current}`);
      assert(fc.total === 2 && fc.current === 1, 'getters mirror the result');
    } finally {
      root.remove();
    }
  });

  await run('engine: case-insensitive by default, case-sensitive on request', () => {
    const root = attach('Cat cat CAT');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 3, 'default search is case-insensitive (3 matches)');
      assert(fc.search('cat', { caseSensitive: true }).total === 1,
        'case-sensitive search matches only the exact-case "cat"');
    } finally {
      root.remove();
    }
  });

  await run('engine: whole-word matches only the standalone token', () => {
    const root = attach('cat category cats scatter');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 4,
        'plain search finds "cat" inside category/cats/scatter too (4)');
      assert(fc.search('cat', { wholeWord: true }).total === 1,
        'whole-word matches only the standalone "cat" (1)');
    } finally {
      root.remove();
    }
  });

  await run('engine: next()/prev() wrap around the match list', () => {
    const root = attach('the cat sat on the mat, the cat ran');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').current === 1, 'starts at match 1');
      assert(fc.next().current === 1, 'the first next() reveals match 1 rather than stepping past it');
      assert(fc.next().current === 2, 'next → 2');
      assert(fc.next().current === 1, 'next wraps 2 → 1');
      assert(fc.prev().current === 2, 'prev wraps 1 → 2');
    } finally {
      root.remove();
    }
  });

  await run('engine: empty/whitespace query yields no matches and clear() resets', () => {
    const root = attach('the cat sat');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 1, 'baseline has a match');
      let r = fc.search('');
      assert(r.total === 0 && r.current === 0, 'empty query → 0/0');
      r = fc.search('   ');
      assert(r.total === 0 && r.current === 0, 'whitespace query → 0/0');
      fc.search('cat');
      fc.clear();
      assert(fc.total === 0 && fc.current === 0, 'clear() resets total/current');
    } finally {
      root.remove();
    }
  });

  await run('engine: text hidden from view is not counted', () => {
    // The message list permanently carries hidden chrome — the footer's
    // Stop/Undo/Pause controls, the thread column actions — and counting text
    // nobody can see makes the total disagree with the highlights.
    const root = attach(
      '<div class="msg">visible needle</div>'
      + '<div class="hidden">class-hidden needle</div>'
      + '<div style="display:none">inline-hidden needle</div>'
      + '<div hidden>attribute-hidden needle</div>'
      + '<div aria-hidden="true">aria-hidden needle</div>');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const r = fc.search('needle');
      assert(r.total === 1, `only the visible needle should count, got ${r.total}`);
    } finally {
      root.remove();
    }
  });

  await run('engine: clipped-but-real text is still counted', () => {
    // A "Show more" clamp is not hidden — it is conversation text the user can be
    // taken to, so it must stay findable. Revealing it is #scrollToCurrent's job
    // (section D).
    const root = attach(
      '<div class="collapsible is-collapsed">clamped needle</div>'
      + '<div>a plain needle</div>');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const r = fc.search('needle');
      assert(r.total === 2, `clipped text should still count, got ${r.total}`);
    } finally {
      root.remove();
    }
  });

  await run('engine: refresh() picks up text appended after a search', () => {
    const root = attach('the cat sat');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const before = fc.search('cat').total;
      assert(before === 1, `expected 1 match before mutation, got ${before}`);
      root.appendChild(document.createTextNode(' and another cat too'));
      const after = fc.refresh().total;
      assert(after === before + 1, `refresh should add one match (before ${before}, after ${after})`);
    } finally {
      root.remove();
    }
  });

  await run('engine: a narrowed query repaints through the same registered Highlight', () => {
    // WebKit does not repaint when a registry name is re-set to a NEW Highlight:
    // typing "co" then "cor" left every "co" still painted. Each search must
    // mutate the one Highlight already registered, so its old ranges are
    // invalidated as they are removed.
    if (typeof Highlight === 'undefined' || !CSS.highlights) return;
    const registry = /** @type {any} */ (CSS.highlights);
    const root = attach('core cord copy cot');
    const fc = new FindController();
    try {
      fc.setRoot(root);
      fc.search('co');
      const all = registry.get('find-match');
      const current = registry.get('find-match-current');
      assert(all && all.size === 4, `"co" should paint 4 ranges, got ${all && all.size}`);
      fc.search('cor');
      assert(registry.get('find-match') === all, 'the full-set Highlight is re-used, not replaced');
      assert(registry.get('find-match-current') === current, 'the active Highlight is re-used, not replaced');
      assert(all.size === 2, `"cor" should leave 2 painted ranges, got ${all.size}`);
      fc.clear();
      assert(all.size === 0 && current.size === 0, 'clear() empties both Highlights');
    } finally {
      fc.clear();
      root.remove();
    }
  });

  // ── B. Shortcut definition ──────────────────────────────────────────

  await run('shortcut: find-in-conversation binds Mod+F', () => {
    const b = keyShortcutManager.getBinding('find-in-conversation');
    assert(b && b.mod === true, 'binding uses the command modifier');
    assert(b.key === 'f', `binding key should be "f", got "${b && b.key}"`);
  });

  await run('shortcut: def is in the Search category and allowed in inputs', () => {
    const def = keyShortcutManager.all().find((d) => d.id === 'find-in-conversation');
    assert(!!def, 'find-in-conversation is present in all()');
    assert(def.category === 'Search', `category should be "Search", got "${def.category}"`);
    assert(def.allowInInput === true, 'find-in-conversation is allowed while typing');
  });

  // ── C. Find-bar interaction (singleton) ─────────────────────────────

  await run('find-bar: open mounts and focuses the query input', () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      assert(findBar.isOpen() === true, 'bar reports open');
      const input = col.querySelector('.find-bar__input');
      assert(!!input, 'the find input is mounted in the column');
      assert(document.activeElement === input, 'the find input is focused');
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: typing runs a debounced search and updates the counter', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(col, '', 'typing');
      assert(counterTotal(col) === 3, `expected "of 3", counter was "${counterText(col)}"`);
      assert(counterCurrent(col) === 1, `expected current 1, counter was "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: Enter advances and Shift+Enter steps back', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(col, '', 'typing');
      assert(counterCurrent(col) === 1, 'starts at match 1');
      // Typing doesn't scroll (it would yank the view on every keystroke), so
      // the first Enter shows match 1 where it lies instead of stepping off it.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert(counterCurrent(col) === 1, `the first Enter should reveal match 1, got "${counterText(col)}"`);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert(counterCurrent(col) === 2, `Enter should advance to 2, got "${counterText(col)}"`);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      assert(counterCurrent(col) === 1, `Shift+Enter should step back to 1, got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: whole-word toggle activates and re-counts', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(col, '', 'typing');
      assert(counterTotal(col) === 3, `plain search should find 3, got "${counterText(col)}"`);
      const wordBtn = /** @type {HTMLElement} */ (col.querySelector('.find-bar__word'));
      assert(!!wordBtn, 'whole-word toggle button exists');
      wordBtn.click(); // click handler re-runs the search synchronously
      assert(wordBtn.getAttribute('aria-pressed') === 'true', 'toggle sets aria-pressed=true');
      assert(wordBtn.classList.contains('is-active'), 'toggle gains is-active');
      assert(counterTotal(col) === 2, `whole-word should drop "needles", got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: Escape closes and restores composer focus', () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(findBar.isOpen() === false, 'bar reports closed');
      assert(col.querySelector('.find-bar') === null, 'bar element is removed from the DOM');
      assert(document.activeElement === col.querySelector('composer-box textarea'),
        'focus returns to the composer textarea');
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: a handled key never reaches the document', () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    /** @type {string[]} */
    const seen = [];
    /**
     * @param {Event} e - A keydown that reached the document.
     * @returns {void}
     */
    const spy = (e) => {
      seen.push(/** @type {KeyboardEvent} */ (e).key);
    };
    document.addEventListener('keydown', spy);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The bar can float inside an overlay holding a popup token (the pinboard
      // does), and popup-manager's document handler dismisses every popup on
      // Escape — so a key the bar has answered must not bubble that far.
      assert(seen.length === 0, `document saw keys the bar handled: ${seen.join(', ')}`);
      assert(findBar.isOpen() === false, 'Escape still closed the bar');
    } finally {
      document.removeEventListener('keydown', spy);
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: live recount picks up a streamed-in message', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(col, '', 'typing');
      const before = counterTotal(col);
      assert(before === 3, `expected 3 before append, got ${before}`);
      const list = /** @type {HTMLElement} */ (col.querySelector('#message-list'));
      const added = document.createElement('div');
      added.className = 'msg';
      added.textContent = 'another needle here';
      const shownBefore = counterText(col);
      list.appendChild(added);
      await counterChanged(col, shownBefore, 'a message streamed in');
      assert(counterTotal(col) === before + 1,
        `observer should recount to ${before + 1}, got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  // ── D. Panels other than the conversation ───────────────────────────

  await run('properties: the bar opens on the panel and says which panel it is in', async () => {
    resetBarState();
    const panel = attachPropertiesPanel(NEEDLE_MESSAGES);
    try {
      findBar.open(panel);
      const input = /** @type {HTMLInputElement} */ (panel.querySelector('.find-bar__input'));
      assert(!!input, 'the bar mounts inside the properties panel');
      assert(input.getAttribute('aria-label') === 'Find in properties',
        `expected the panel's own label, got "${input.getAttribute('aria-label')}"`);
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(panel, '', 'typing');
      assert(counterTotal(panel) === 3, `expected 3 matches, got "${counterText(panel)}"`);
    } finally {
      findBar.close();
      panel.remove();
    }
  });

  await run('properties: an empty panel has nothing to find', () => {
    resetBarState();
    const panel = attachPropertiesPanel(null);
    try {
      findBar.open(panel);
      // No section means no scroller and no content: the bar declines, and the
      // shortcut falls through to the browser's own find.
      assert(findBar.isOpen() === false, 'the bar stays closed');
      assert(panel.querySelector('.find-bar') === null, 'nothing was mounted');
    } finally {
      findBar.close();
      panel.remove();
    }
  });

  await run('properties: a re-rendered section is re-rooted, not left counting dead nodes', async () => {
    resetBarState();
    const panel = attachPropertiesPanel(NEEDLE_MESSAGES);
    try {
      findBar.open(panel);
      const input = /** @type {HTMLInputElement} */ (panel.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(panel, '', 'typing');
      assert(counterTotal(panel) === 3, `expected 3 before the re-render, got "${counterText(panel)}"`);

      // What the panel does on every render: throw the whole section away and
      // build a new one. The bar is mounted on the panel, not in the section,
      // so it survives — but its root has just been detached under it.
      const content = /** @type {HTMLElement} */ (panel.querySelector('properties-panel-content'));
      const shownBefore = counterText(panel);
      content.innerHTML =
        '<properties-panel-section><div>one needle</div><div>needle two</div></properties-panel-section>';
      await counterChanged(panel, shownBefore, 'the section was re-rendered');

      assert(findBar.isOpen() === true, 'the bar survives the re-render');
      assert(counterTotal(panel) === 2, `expected 2 after the re-render, got "${counterText(panel)}"`);
    } finally {
      findBar.close();
      panel.remove();
    }
  });

  await run('pinboard: the bar opens on the mounted pin and says which panel it is in', async () => {
    resetBarState();
    const { shell, content } = attachPinboard(NEEDLE_MESSAGES);
    try {
      findBar.open(content);
      const input = /** @type {HTMLInputElement} */ (content.querySelector('.find-bar__input'));
      assert(!!input, 'the bar mounts inside pinboard-content, above the body it searches');
      assert(input.getAttribute('aria-label') === 'Find in pinboard',
        `expected the board's own label, got "${input.getAttribute('aria-label')}"`);
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await counterChanged(content, '', 'typing');
      assert(counterTotal(content) === 3, `expected 3 matches, got "${counterText(content)}"`);
    } finally {
      findBar.close();
      shell.remove();
    }
  });

  await run('pinboard: a board with nothing mounted has nothing to find', () => {
    resetBarState();
    const { shell, content } = attachPinboard(null);
    try {
      findBar.open(content);
      assert(findBar.isOpen() === false, 'the bar stays closed');
    } finally {
      findBar.close();
      shell.remove();
    }
  });

  await run('pinboard: closing the board closes the bar', () => {
    resetBarState();
    const { shell, content } = attachPinboard(NEEDLE_MESSAGES);
    try {
      findBar.open(content);
      assert(findBar.isOpen() === true, 'open to begin with');
      // What the shell does as the board slides away. Matches nobody can see
      // must not stay counted, and the bar must not go with the board's DOM.
      findBar.closeFor(shell);
      assert(findBar.isOpen() === false, 'the bar closed with the board');
      assert(content.querySelector('.find-bar') === null, 'and took its element with it');
    } finally {
      findBar.close();
      shell.remove();
    }
  });

  await run('pinboard: closing another panel leaves this bar alone', () => {
    resetBarState();
    const { shell, content } = attachPinboard(NEEDLE_MESSAGES);
    const elsewhere = attachPropertiesPanel(NEEDLE_MESSAGES);
    try {
      findBar.open(content);
      findBar.closeFor(elsewhere);
      assert(findBar.isOpen() === true, 'an unrelated panel closing is not this bar’s business');
    } finally {
      findBar.close();
      elsewhere.remove();
      shell.remove();
    }
  });

  await run('targeting: the panel is found from whatever holds focus', () => {
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      const textarea = /** @type {HTMLElement} */ (col.querySelector('composer-box textarea'));
      assert(findPanelFor(textarea) === col,
        'typing in the composer means ⌘F searches that composer’s own column');
      const msg = /** @type {HTMLElement} */ (col.querySelector('.msg'));
      assert(findPanelFor(msg) === col, 'so does clicking a message in it');
    } finally {
      col.remove();
    }
  });

  await run('targeting: a panel with nothing to search is stepped over', () => {
    const panel = attachPropertiesPanel(null);
    const loose = attach('<p class="loose">not in any panel</p>');
    try {
      const content = /** @type {HTMLElement} */ (panel.querySelector('properties-panel-content'));
      // It implements the protocol but answers null, which is the whole point of
      // being allowed to: ⌘F falls through to the browser's own find.
      assert(findPanelFor(content) === null, 'an empty properties panel is not a find target');
      assert(findPanelFor(loose.querySelector('.loose')) === null, 'nor is anything outside a panel');
      assert(findPanelFor(null) === null, 'nor is nothing at all');
    } finally {
      loose.remove();
      panel.remove();
    }
  });

  // ── E. Revealing the active match ────────────────────────────────────

  await run('reveal: navigating scrolls the match itself into view, not its block', () => {
    // A long paste is ONE text node in ONE box. Revealing the box (what
    // scrollIntoView does) centres the paste and parks a match near its end
    // off-screen, so the reveal has to work on the match's own rect.
    const root = attach('');
    try {
      root.style.height = '200px';
      root.style.overflow = 'auto';
      const block = document.createElement('div');
      block.style.whiteSpace = 'pre-wrap';
      const lines = [];
      for (let i = 0; i < 200; i++) lines.push(i === 180 ? 'here is the needle' : `filler line ${i}`);
      block.textContent = lines.join('\n');
      root.appendChild(block);
      assert(block.getBoundingClientRect().height > 600,
        'fixture block must be far taller than the scroller for this to mean anything');

      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('needle').total === 1, 'exactly one match in the fixture');
      fc.next(); // the first navigation reveals the active match

      const text = /** @type {Text} */ (block.firstChild);
      const at = (block.textContent || '').indexOf('needle');
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 'needle'.length);
      const match = range.getBoundingClientRect();
      const view = root.getBoundingClientRect();
      assert(match.top >= view.top - 1 && match.bottom <= view.bottom + 1,
        `match should sit inside the scroller (match ${match.top}–${match.bottom}, view ${view.top}–${view.bottom})`);
    } finally {
      root.remove();
    }
  });

  // ── F. Auto-expand a collapsed block around a match ──────────────────

  await run('auto-expand: expands the collapsed collapsible around a node', () => {
    const root = attach(
      '<section id="message-list">' +
        '<div class="collapsible is-collapsed"><span class="target">buried treasure</span></div>' +
        '<button class="collapsible-toggle" aria-expanded="false">Show more</button>' +
      '</section>');
    try {
      const target = /** @type {HTMLElement} */ (root.querySelector('.target'));
      const collapsible = /** @type {HTMLElement} */ (root.querySelector('.collapsible'));
      assert(expandCollapsibleContaining(target) === true, 'returns true when it expands something');
      assert(collapsible.classList.contains('is-expanded'), 'block is now expanded');
      assert(!collapsible.classList.contains('is-collapsed'), 'collapsed class removed');
    } finally {
      root.remove();
    }
  });

  await run('auto-expand: returns false outside any collapsed block', () => {
    const root = attach('<p class="loose">nothing collapsed here</p>');
    try {
      const p = /** @type {HTMLElement} */ (root.querySelector('.loose'));
      assert(expandCollapsibleContaining(p) === false, 'returns false with no collapsed ancestor');
    } finally {
      root.remove();
    }
  });

  await run('the buttons name their keys as every other key hint does, for this platform', async () => {
    resetBarState();
    const col = attachColumn('<div class="msg">111</div>');
    try {
      findBar.open(col);
      const mac = isMac();
      const title = (/** @type {string} */ sel) => col.querySelector(sel)?.getAttribute('title') || '';
      for (const [sel, binding] of /** @type {Array<[string, any]>} */ ([
        ['.find-bar__next', { key: 'Enter' }],
        ['.find-bar__prev', { key: 'Enter', shift: true }],
        ['.find-bar__close', { key: 'Escape' }],
      ])) {
        const keys = formatBindingLabel(binding, mac);
        assert(title(sel).includes(`(${keys})`), `${sel} title "${title(sel)}" does not name ${keys}`);
      }
    } finally {
      findBar.close();
      col.remove();
    }
  });

  // ── G. Every string the bar shows, under en-XA ──────────────────────

  await run('i18n: every state of the bar, on every panel, is translated under en-XA', async () => {
    // Digits only, so the search text and the counter's numbers are no English
    // of their own: "111" matches twice, "333" once, "999" nowhere.
    const DIGITS = `
      <div class="msg">111 222</div>
      <div class="msg">111</div>
      <div class="msg">333</div>`;
    /** @type {string[]} */
    const raw = [];
    /**
     * Record every plain-English string the bar shows. The close button's ✕ is a
     * glyph, so the button is skipped and its labels are read on their own.
     * @param {Element|null} bar
     * @param {string} where
     */
    const collect = (bar, where) => {
      assert(!!bar, `the bar is mounted (${where})`);
      const el = /** @type {Element} */ (bar);
      const shown = shownStrings(el, '.find-bar__close');
      assert(shown.length >= 8, `expected the bar's labels (${where}), found ${shown.length}`);
      for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
      const close = el.querySelector('.find-bar__close');
      for (const attr of ['aria-label', 'title']) {
        const v = close?.getAttribute(attr) || '';
        if (!isPseudoLocalized(v)) raw.push(`${where}: close ${attr} ${v}`);
      }
    };

    await underPseudoLocale('find-bar-test', async () => {
      resetBarState();
      const col = attachColumn(DIGITS);
      try {
        findBar.open(col);
        const bar = col.querySelector('.find-bar');
        const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
        assert(counterText(col) === '', 'an empty query shows no counter');
        collect(bar, 'empty');
        for (const [query, where] of [['111', 'matches'], ['333', 'single match'], ['999', 'no matches']]) {
          // Each query reads differently ("1 of 2", "1 of 1", "No results"), so
          // a redraw is a change of counter text.
          const shownBefore = counterText(col);
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await counterChanged(col, shownBefore, `searching for ${query}`);
          assert(counterText(col) !== '', `the counter shows something (${where})`);
          collect(bar, `${where}, counter ${counterText(col)}`);
        }
        /** @type {HTMLElement} */ (col.querySelector('.find-bar__case')).click();
        /** @type {HTMLElement} */ (col.querySelector('.find-bar__word')).click();
        collect(bar, 'both toggles on');
      } finally {
        findBar.close();
        col.remove();
      }

      // Each panel names its own search in the input's aria-label.
      const panel = attachPropertiesPanel(DIGITS);
      try {
        findBar.open(panel);
        collect(panel.querySelector('.find-bar'), 'properties panel');
      } finally {
        findBar.close();
        panel.remove();
      }
      const { shell, content } = attachPinboard(DIGITS);
      try {
        findBar.open(content);
        collect(content.querySelector('.find-bar'), 'pinboard');
      } finally {
        findBar.close();
        shell.remove();
      }
    });
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
