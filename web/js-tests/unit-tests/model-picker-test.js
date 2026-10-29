//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<model-picker>` contract tests.
 *
 * The picker is the one place a model is chosen, in the composer and in
 * settings alike, and it is deliberately ignorant of both: everything it knows
 * arrives as a property and everything it decides leaves as an event. Four
 * things about that contract are invisible by inspection:
 *
 *   1. The bottom row's label belongs to the HOST — "No model", "Inherit from
 *      parent" and "Automatic" are the same row meaning different things.
 *   2. A `change` carries a WHOLE config, and a serving tier does not survive a
 *      change to a DIFFERENT model — carrying it would start billing a premium
 *      rate the new model was never chosen for, and that the new model also
 *      offers one is not a decision to buy it. The tier is kept only across a
 *      re-pick of the model already in effect, whatever the catalog currently
 *      says. A Recent row is the exception on both counts: it restores the exact
 *      pair it displays, which includes clearing a tier back to Standard.
 *   3. Typing filters, and it expands collapsed providers while it does — a
 *      match hidden inside a collapsed provider is a match the user can't reach.
 *   4. Escape closes the picker and goes no further: popup-manager's Escape
 *      dismisses every overlay, which would take a hosting settings modal with
 *      it.
 *   5. The current-model card carries the provider's quota meters, which the
 *      picker pulls itself — and shows nothing at all when there are none, so a
 *      provider that never reports usage costs the card no empty space.
 *   6. A window the provider never reported is marked as assumed on the card,
 *      and the marker opens that model's Context window field in settings.
 * @module unit-tests/model-picker-test
 */

import { assert, styledProbeFrame, nextTask } from '../utilities/test-helpers.js';
import recentModels from '../../js/services/recent-models.js';
import { cachedMachinePref, setMachinePref } from '../../js/services/prefs.js';
import usageStatsCache from '../../js/services/usage-stats-cache.js';
import { SHEET_QUERY } from '../../js/utils/popup-surface.js';
import { presentPopup } from '../../js/utils/popup-surface.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import providersCache from '../../js/services/providers-cache.js';
import { formatTokens } from '../../js/utils/format.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { shownStrings, underPseudoLocale } from '../utilities/pseudo-locale.js';
import '../../js/components/model-picker/model-picker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

const FAST = { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' };

/**
 * The machine preference holding the per-provider list view-state override map.
 * Seeded through the pref API rather than localStorage: the preference belongs
 * to the machine realm, and localStorage is only that realm's cache — a write
 * straight to it is ignored the moment the realm answers.
 */
const VIEW_STATE_KEY = 'juggler-model-view-state';

/**
 * One provider offering a tiered model, a second tiered model, and a
 * standard-only one — enough to exercise the carry rule in both directions.
 * @returns {any[]} A fresh provider list.
 */
function providers() {
  return [{
    name: 'p',
    displayName: 'Provider',
    available: true,
    modelsWithContext: [
      { id: 'm', displayName: 'Model', contextWindow: 1000, serviceTiers: [FAST] },
      { id: 'other', displayName: 'Other', contextWindow: 1000, serviceTiers: [FAST] },
      { id: 'plain', displayName: 'Plain', contextWindow: 1000 },
    ],
  }];
}

/**
 * A provider with more models than any popup can show at once — enough that the
 * list has to scroll, which is the only state the view toggles are awkward in.
 * @param {string} name - Provider name, also the model-id prefix.
 * @returns {any} A provider entry.
 */
function crowdedProvider(name) {
  return {
    name,
    displayName: `Provider ${name.toUpperCase()}`,
    available: true,
    modelsWithContext: Array.from({ length: 30 }, (_, i) => ({
      id: `${name}-${i}`,
      displayName: `${name.toUpperCase()} model ${i}`,
      contextWindow: 1000,
    })),
  };
}

/**
 * Present a picker the way a host does — anchored to a button at the foot of the
 * window, so it opens upward and is re-placed as its content grows and shrinks.
 * @param {any[]} providerList - The providers to offer.
 * @returns {Promise<{picker: any, release: () => void}>} The placed picker and its teardown.
 */
async function presentAnchoredPicker(providerList) {
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));

  // Hold the picker in the wide layout. Under the phone breakpoint `presentPopup`
  // presents a bottom sheet instead, where the sheet is the one scroll container
  // and the model list is `overflow: visible` — so an anchored placement is never
  // made and the list it re-places against never scrolls. Which side of that
  // breakpoint a lane lands on is the platform's choice of test-window width, so
  // pin it rather than measure anchored placement on some machines and not others.
  const realMatchMedia = window.matchMedia.bind(window);
  /** @type {any} */ (window).matchMedia = (/** @type {string} */ q) => (q === SHEET_QUERY
    ? { matches: false, media: q, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia(q));

  const anchor = document.createElement('button');
  anchor.style.cssText = `position:fixed;left:1rem;top:${window.innerHeight - 40}px;width:6rem;height:1.5rem;`;
  document.body.appendChild(anchor);

  const picker = /** @type {any} */ (document.createElement('model-picker'));
  picker.providers = providerList;
  picker.value = null;

  const releasePopup = presentPopup({
    surface: picker,
    anchor,
    id: 'model-picker-test',
    onClose: () => {},
  });
  await nextTask(); // the placement frame
  // Web fonts land asynchronously and shift every row by a fraction of a line;
  // measurements taken across that are measuring the font, not the list.
  await document.fonts?.ready;
  await nextTask();

  return {
    picker,
    release: () => {
      releasePopup();
      anchor.remove();
      window.requestAnimationFrame = realRaf;
      /** @type {any} */ (window).matchMedia = realMatchMedia;
    },
  };
}

/**
 * Empty the recent-model cache so row counts are the provider list alone.
 * @returns {Promise<void>}
 */
async function clearRecents() {
  await seedRecents([]);
}

/**
 * Fill the recent-model cache without depending on the server.
 * @param {{provider: string, model: string, thinking?: string, serviceTier?: string}[]} models
 * @returns {Promise<void>}
 */
async function seedRecents(models) {
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ models }) }));
  try {
    await recentModels.refresh();
  } finally {
    window.fetch = originalFetch;
  }
}

/**
 * Fill the usage cache for one provider without depending on the server.
 *
 * The cache is a module singleton with a multi-minute per-provider debounce, so
 * the seed is forced and every caller uses a provider name of its own — a name
 * shared with another test would carry that test's meters into this one.
 * @param {string} provider - Provider name to seed.
 * @param {any[]} stats - The meters the fake server reports.
 * @returns {Promise<void>}
 */
async function seedUsage(provider, stats) {
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({
    ok: true,
    json: async () => ({ usage: [{ provider, updatedAt: new Date().toISOString(), stats }], errors: {} }),
  }));
  try {
    await usageStatsCache.refresh(provider, { force: true });
  } finally {
    window.fetch = originalFetch;
  }
}

/**
 * A picker showing one model belonging to `provider`, detached and rendered —
 * detached so connecting it can't set off a usage fetch of its own.
 * @param {string} provider - Provider name the single model belongs to.
 * @returns {any} The rendered picker.
 */
function pickerOnProvider(provider) {
  const el = /** @type {any} */ (document.createElement('model-picker'));
  el.providers = [{
    name: provider,
    displayName: 'Metered',
    available: true,
    modelsWithContext: [{ id: 'm', displayName: 'Model', contextWindow: 1000 }],
  }];
  el.value = { provider, model: 'm' };
  el.render();
  return el;
}

/**
 * Lay the picker's markup out as a phone bottom sheet and hand back its
 * sections' rendered boxes.
 *
 * The sheet rules live behind `@media (width <= 36rem)`, and a browser-test lane
 * is wider than that on macOS — so the phone layout never renders in the test
 * page itself, and two mobile layout bugs reached a phone unseen. A child iframe
 * narrow enough to match the query, wearing the same stylesheets, is the only
 * place that CSS can be measured.
 *
 * The custom elements do not upgrade in the child (its registry is its own), but
 * nothing here needs them to: the sheet rules select on classes, and the markup
 * is already rendered. `presentPopup` adds `.popup-sheet` and injects the
 * grabber, so both are reproduced.
 * @param {any} picker - A rendered picker, detached or not.
 * @returns {Promise<{sections: {name: string, top: number, bottom: number}[], cleanup: () => void}>}
 *   The sheet's visible sections in DOM order, each with its top and its PAINTED
 *   bottom, plus a cleanup that tears the iframe down.
 */
async function layOutAsPhoneSheet(picker) {
  // 360px is under the 36rem query, which resolves against the initial 16px
  // font size (576px) whatever the document's own root size is.
  // Short as well as narrow: the sheet caps at 85vh, and the overlap this
  // measures only appears once the content exceeds that cap and something has
  // to give. A tall viewport would let everything fit and prove nothing.
  const { doc, frame } = await styledProbeFrame(360, 480);

  // A plain <div> wearing the picker's classes and markup, NOT a cloneNode of
  // the element: cloning an autonomous custom element re-runs its constructor,
  // which resets the instance state its render() depended on and hands back a
  // subtree that no longer matches the live one (an empty Recent block, a
  // footer still carrying `hidden`). Every sheet rule selects on classes, so a
  // div carries the layout faithfully and carries no such baggage.
  const surface = doc.createElement('div');
  surface.className = `${picker.className} popup-sheet popup-sheet-modal`;
  surface.innerHTML = picker.innerHTML;
  const grabber = doc.createElement('div');
  grabber.className = 'popup-sheet-grabber';
  surface.insertBefore(grabber, surface.firstChild);
  doc.body.appendChild(surface);

  const named = [
    ['grabber', '.popup-sheet-grabber'],
    ['detail', '.model-picker-detail'],
    ['recent', '.model-picker-recent'],
    ['list', '.model-picker-list'],
    ['footer', '.model-picker-footer'],
  ];
  // The PAINTED extent, not the section's own box. A flex item that shrinks
  // below its content does not clip it — the box reports the shrunken height
  // while its rows carry on down the screen over whatever follows. Measuring the
  // box alone reports two tidy neighbours and misses the overlap entirely.
  const paintedBottom = (/** @type {Element} */ el) =>
    [el, ...el.querySelectorAll('*')].reduce(
      (lowest, node) => Math.max(lowest, node.getBoundingClientRect().bottom), -Infinity);

  // Filter on the rendered box, not `offsetParent`: the sheet is `position:
  // fixed`, which makes offsetParent null for its whole subtree.
  const sections = named
    .map(([name, sel]) => ({ name, el: surface.querySelector(sel) }))
    .filter(s => !!s.el && /** @type {HTMLElement} */ (s.el).getClientRects().length > 0)
    .map(s => ({
      name: s.name,
      top: /** @type {HTMLElement} */ (s.el).getBoundingClientRect().top,
      bottom: paintedBottom(/** @type {Element} */ (s.el)),
    }));

  return { sections, cleanup: () => frame.remove() };
}

/**
 * Build a rendered picker. Connected ones get the document-level key handling;
 * detached ones are enough for pure markup assertions.
 * @param {object} opts - Scenario knobs.
 * @param {any} [opts.value] - The config in effect.
 * @param {string} [opts.noneLabel] - Label for the bottom row.
 * @param {boolean} [opts.connect] - Append to `<body>` (needed for key tests).
 * @param {any[]} [opts.providers] - Override the provider list (e.g. a catalog
 *   carrying no tiers, which is what a cold or failed model-list fetch leaves).
 * @returns {any} The picker.
 */
function makePicker({ value, noneLabel, connect, providers: providerList } = {}) {
  const el = /** @type {any} */ (document.createElement('model-picker'));
  el.providers = providerList || providers();
  el.value = value || null;
  if (noneLabel) el.noneLabel = noneLabel;
  if (connect) document.body.appendChild(el); else el.render();
  return el;
}

/**
 * Click a model row by its wire id.
 * @param {any} picker
 * @param {string} modelId
 */
function clickModel(picker, modelId) {
  const row = picker.querySelector(`.menu-item[data-model="${modelId}"]`);
  assert(!!row, `no row for model "${modelId}"`);
  row.click();
}

/**
 * Click a model row in the scrolling list — a bare model name, carrying no
 * stored dials. Scoped to the list column on purpose: Recent is written first in
 * document order, so an unscoped lookup finds the Recent row for the same model
 * and tests the opposite rule.
 * @param {any} picker
 * @param {string} modelId
 */
function clickListModel(picker, modelId) {
  const row = picker.querySelector(`.model-picker-rows .menu-item[data-model="${modelId}"]`);
  assert(!!row, `no list row for model "${modelId}"`);
  row.click();
}

/**
 * Click a row in the Recent block.
 * @param {any} picker
 * @param {string} modelId
 */
function clickRecentModel(picker, modelId) {
  const row = picker.querySelector(`.model-picker-recent .menu-item[data-model="${modelId}"]`);
  assert(!!row, `no Recent row for model "${modelId}"`);
  row.click();
}

/**
 * Send a keydown the way the browser would — from whatever has focus, so the
 * picker's document-capture handler is what claims it.
 * @param {string} key
 * @returns {KeyboardEvent} The dispatched event.
 */
function press(key) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
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

  await clearRecents();
  // Pin every provider expanded: the tri-state view is persisted per provider,
  // and a leftover 'none' from another session would empty the list.
  const savedViewState = cachedMachinePref(VIEW_STATE_KEY, null);
  void setMachinePref(VIEW_STATE_KEY, { p: 'all' });

  try {
    await run('the bottom row wears the label the host gave it', () => {
      const none = makePicker({ noneLabel: 'Inherit from parent' }).querySelector('.no-model');
      assert(!!none, 'the picker always offers a row that selects nothing');
      assert((none.textContent || '').trim() === 'Inherit from parent',
        `the host owns the wording — got "${(none.textContent || '').trim()}"`);
    });

    await run('the bottom row is ticked only when nothing is selected', () => {
      assert(makePicker().querySelector('.no-model').classList.contains('active'),
        'no config ⇒ the none row is the active one');
      const withModel = makePicker({ value: { provider: 'p', model: 'm' } });
      assert(!withModel.querySelector('.no-model').classList.contains('active'),
        'a selected model must not leave the none row ticked as well');
    });

    await run('the bottom row emits null, not an empty config', () => {
      const picker = makePicker({ noneLabel: 'Automatic' });
      /** @type {any} */
      let seen = 'unset';
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      picker.querySelector('.no-model').click();
      assert(seen === null, `clearing the selection means null, got ${JSON.stringify(seen)}`);
    });

    await run('a model row emits a whole config', () => {
      const picker = makePicker();
      /** @type {any} */
      let seen = null;
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      clickModel(picker, 'm');
      assert(!!seen && seen.provider === 'p' && seen.model === 'm',
        `the pair must be named in full, got ${JSON.stringify(seen)}`);
      assert(!('thinking' in seen) && !('serviceTier' in seen),
        `unset dials are absent keys, not empty strings — got ${JSON.stringify(seen)}`);
    });

    await run('a serving tier is dropped by a model that advertises it too', () => {
      // The expensive half of the rule. That the model being switched TO also
      // sells a premium tier says nothing about whether this user wants to pay
      // for it on this model — only the click that bought it does.
      const picker = makePicker({ value: { provider: 'p', model: 'm', serviceTier: 'priority' } });
      /** @type {any} */
      let seen = null;
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      clickListModel(picker, 'other');
      assert(seen.model === 'other', `picked the wrong row: ${JSON.stringify(seen)}`);
      assert(!('serviceTier' in seen),
        `a bare name click must not carry a premium tier onto a different model — got ${JSON.stringify(seen)}`);
    });

    await run('a serving tier is dropped by a model that does not advertise it', () => {
      const picker = makePicker({ value: { provider: 'p', model: 'm', serviceTier: 'priority' } });
      /** @type {any} */
      let seen = null;
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      clickListModel(picker, 'plain');
      assert(seen.model === 'plain', `picked the wrong row: ${JSON.stringify(seen)}`);
      assert(!('serviceTier' in seen),
        `switching models must never start paying a premium the model was not chosen for — got ${JSON.stringify(seen)}`);
    });

    await run('re-picking the SAME model keeps a tier the catalog has forgotten', () => {
      // A provider list whose entry advertises nothing is the ordinary cold /
      // failed-fetch state. Clicking the row for the model already selected is
      // not a decision to stop paying for it.
      const cold = [{
        name: 'p',
        displayName: 'Provider',
        available: true,
        modelsWithContext: [{ id: 'm', displayName: 'Model', contextWindow: 1000 }],
      }];
      const picker = makePicker({ providers: cold, value: { provider: 'p', model: 'm', serviceTier: 'priority' } });
      /** @type {any} */
      let seen = null;
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      clickListModel(picker, 'm');
      assert(seen.serviceTier === 'priority',
        `re-picking the same model must not erase its tier, got ${JSON.stringify(seen)}`);
    });

    await run('a Recent row restores the tier it recorded', async () => {
      await seedRecents([{ provider: 'p', model: 'm', serviceTier: 'priority' }]);
      try {
        const picker = makePicker({ value: null });
        const row = picker.querySelector('.recent-model');
        assert(!!row, 'the seeded entry must render a Recent row');
        assert(row.getAttribute('data-service-tier') === 'priority',
          'the row carries its stored tier so a click can restore it');
        /** @type {any} */
        let seen = null;
        picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
        row.click();
        assert(seen.serviceTier === 'priority',
          `a Recent row re-applies the pair it recorded, got ${JSON.stringify(seen)}`);
      } finally {
        await clearRecents();
      }
    });

    await run('a Recent row recorded at Standard clears the tier in effect', async () => {
      // The row says Standard, so clicking it must MEAN Standard. A row that
      // stayed silent about having no tier would read as "leave the tier alone",
      // which is the one thing it cannot mean — the row is a whole pair.
      await seedRecents([{ provider: 'p', model: 'm' }]);
      try {
        const picker = makePicker({ value: { provider: 'p', model: 'm', serviceTier: 'priority' } });
        const row = picker.querySelector('.recent-model');
        assert(!!row, 'the seeded entry must render a Recent row');
        assert(row.getAttribute('data-service-tier') === '',
          `a Standard entry states its tier as empty, got ${JSON.stringify(row.getAttribute('data-service-tier'))}`);
        /** @type {any} */
        let seen = null;
        picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
        row.click();
        assert(!('serviceTier' in seen),
          `a Standard Recent row must clear the tier, not keep it — got ${JSON.stringify(seen)}`);
      } finally {
        await clearRecents();
      }
    });

    await run('the two row kinds differ: the list row clears what a Recent row sets', async () => {
      // Same model, same picker, opposite meanings — a bare name is "this model,
      // default dials", a Recent row is "this exact pair".
      await seedRecents([{ provider: 'p', model: 'other', serviceTier: 'priority' }]);
      try {
        const picker = makePicker({ value: { provider: 'p', model: 'm', serviceTier: 'priority' } });
        /** @type {any} */
        let seen = null;
        picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
        clickListModel(picker, 'other');
        assert(!('serviceTier' in seen),
          `the list row is a bare name and drops the tier, got ${JSON.stringify(seen)}`);
        clickRecentModel(picker, 'other');
        assert(seen.serviceTier === 'priority',
          `the Recent row restores the tier it displays, got ${JSON.stringify(seen)}`);
      } finally {
        await clearRecents();
      }
    });

    await run('being handed the same state again writes no DOM', () => {
      const picker = makePicker({ value: { provider: 'p', model: 'm' }, connect: true });
      /** @type {MutationRecord[]} */
      const records = [];
      const observer = new MutationObserver(rs => records.push(...rs));
      try {
        observer.observe(picker, {
          childList: true, subtree: true, characterData: true, attributes: true,
        });
        // What a host pushes on every document update, several updates' worth:
        // a rebuilt provider list and a rebuilt config naming the same selection.
        for (let i = 0; i < 3; i++) {
          picker.providers = providers();
          picker.value = { provider: 'p', model: 'm' };
          picker.noneLabel = 'No model';
          picker.loading = false;
        }
        records.push(...observer.takeRecords());
        assert(records.length === 0,
          `an unchanged push must leave the DOM alone — got ${records.length} mutation(s),`
          + ` first on <${records[0]?.target.nodeName.toLowerCase()}>`);
      } finally {
        observer.disconnect();
        picker.remove();
      }
    });

    await run('a state that did change is still written', () => {
      const picker = makePicker({ value: { provider: 'p', model: 'm' }, connect: true });
      try {
        picker.value = { provider: 'p', model: 'other' };
        const active = picker.querySelector('.menu-item.active[data-model]');
        assert(active?.getAttribute('data-model') === 'other',
          `the tick must follow a real change — got "${active?.getAttribute('data-model')}"`);
        assert((picker.querySelector('.model-current-name')?.textContent || '') === 'Other',
          'the card names the model in effect');
      } finally {
        picker.remove();
      }
    });

    await run('the card carries the chosen provider\'s usage meters', async () => {
      await seedUsage('metered-provider', [
        { name: 'Session (5h)', usedPercent: 42 },
        { name: 'Week (7d)', usedPercent: 8 },
      ]);
      const picker = pickerOnProvider('metered-provider');
      // Inside the card, not merely somewhere in the column: the meters describe
      // the model in effect, and the sections either side of it are their own
      // subjects.
      const meters = picker.querySelectorAll('.model-current .model-current-usage .usage-stat');
      assert(meters.length === 2, `expected both meters in the card — got ${meters.length}`);
      assert((meters[0].querySelector('.usage-stat-pct')?.textContent || '') === '42%',
        'the meter reports the percentage the provider gave');
    });

    await run('a provider with no usage to report leaves the card alone', () => {
      // Never seeded, so the cache has nothing for it. An empty state here would
      // be a block of space held open for something that may never come.
      const picker = pickerOnProvider('unmetered-provider');
      assert(!picker.querySelector('.model-current-usage'),
        'a provider that reports no usage must add nothing to the card');
      assert(!!picker.querySelector('.model-current-name'), 'the card itself still renders');
    });

    await run('clicking the picker\'s own background changes nothing', () => {
      const picker = makePicker({ value: { provider: 'p', model: 'm' }, connect: true });
      /** @type {any[]} */
      const seen = [];
      picker.addEventListener('change', (/** @type {any} */ e) => { seen.push(e.detail); });
      try {
        picker.querySelector('.model-picker-rows').click();
        picker.querySelector('.model-picker-detail').click();
        picker.click();
        assert(seen.length === 0,
          `empty space is not a row — got ${JSON.stringify(seen)}`);
      } finally {
        picker.remove();
      }
    });

    await run('the filter field\'s own change event never reads as a selection', () => {
      const picker = makePicker({ value: { provider: 'p', model: 'm' }, connect: true });
      /** @type {any[]} */
      const seen = [];
      picker.addEventListener('change', (/** @type {any} */ e) => { seen.push(e.detail); });
      try {
        const input = picker.querySelector('.model-picker-filter-input');
        input.value = 'ot';
        // What the browser sends when the field is committed or blurred — which a
        // click on the picker's background does.
        input.dispatchEvent(new Event('change', { bubbles: true }));
        assert(seen.length === 0,
          `only a picked row speaks for the picker — got ${JSON.stringify(seen)}`);
      } finally {
        picker.remove();
      }
    });

    await run('cycling a provider view leaves its toggle where it was pressed', async () => {
      // The real arrangement, because the movement comes from it: the picker
      // PLACED against a button near the foot of the window, four crowded
      // providers, and the LAST one's toggle parked near the top of the visible
      // box — collapsing it takes away the very rows the list was scrolled
      // through, so holding the toggle still means scrolling past the end.
      void setMachinePref(VIEW_STATE_KEY, { a: 'all', b: 'all', c: 'all', d: 'all' });
      const { picker, release } = await presentAnchoredPicker(['a', 'b', 'c', 'd'].map(crowdedProvider));
      try {
        const rows = picker.querySelector('.model-picker-rows');
        const toggleOf = (/** @type {string} */ name) =>
          picker.querySelector(`.provider-view-toggle[data-provider="${name}"]`);

        rows.scrollTop += toggleOf('d').getBoundingClientRect().top
          - rows.getBoundingClientRect().top - 24;
        assert(rows.scrollTop > 0, 'the list must be scrolled for this to mean anything');

        // A full cycle: the collapse that empties the end of the list, then the
        // two presses that fill it again.
        for (const step of ['all → none', 'none → top', 'top → all']) {
          const before = toggleOf('d').getBoundingClientRect().top;
          toggleOf('d').click();
          await nextTask();
          const after = toggleOf('d').getBoundingClientRect().top;
          assert(Math.abs(after - before) <= 4,
            `${step}: the toggle must stay under the pointer — moved ${Math.round(after - before)}px`);
        }
        assert(!rows.style.paddingBottom,
          `the room the collapse borrowed must go back when the rows do — left ${rows.style.paddingBottom}`);
      } finally {
        release();
        void setMachinePref(VIEW_STATE_KEY, { p: 'all' });
      }
    });

    await run('typing filters the model rows', () => {
      const picker = makePicker({ connect: true });
      try {
        press('o');
        press('t');
        const ids = [...picker.querySelectorAll('.menu-item[data-model]')]
          .map(r => r.getAttribute('data-model'));
        assert(ids.length === 1 && ids[0] === 'other',
          `"ot" must leave only Other, got ${JSON.stringify(ids)}`);
        assert(!!picker.querySelector('.no-model'),
          'the none row is an action, not a model — it is never filtered away');
      } finally {
        picker.remove();
      }
    });

    await run('backspace widens the filter again', () => {
      const picker = makePicker({ connect: true });
      try {
        press('o');
        press('t');
        press('Backspace');
        const ids = [...picker.querySelectorAll('.menu-item[data-model]')]
          .map(r => r.getAttribute('data-model'));
        assert(ids.length === 2 && ids.includes('other') && ids.includes('m'),
          `"o" matches Model and Other, got ${JSON.stringify(ids)}`);
      } finally {
        picker.remove();
      }
    });

    await run('a filter with no match says so rather than showing an empty box', () => {
      const picker = makePicker({ connect: true });
      try {
        press('z');
        assert((picker.querySelector('.menu-hint-text')?.textContent || '') === 'Nothing.',
          'an empty result is stated, not implied');
      } finally {
        picker.remove();
      }
    });

    await run('typing reaches a model inside a collapsed provider', () => {
      void setMachinePref(VIEW_STATE_KEY, { p: 'none' });
      const picker = makePicker({ connect: true });
      try {
        assert(picker.querySelectorAll('.menu-item[data-model]').length === 0,
          'the provider starts collapsed');
        press('p');
        press('l');
        const ids = [...picker.querySelectorAll('.menu-item[data-model]')]
          .map(r => r.getAttribute('data-model'));
        assert(ids.length === 1 && ids[0] === 'plain',
          `a query must expand the provider to reach its match, got ${JSON.stringify(ids)}`);
      } finally {
        picker.remove();
        void setMachinePref(VIEW_STATE_KEY, { p: 'all' });
      }
    });

    await run('arrows walk the rows and Enter picks the one under the cursor', () => {
      const picker = makePicker({ connect: true });
      /** @type {any} */
      let seen = null;
      picker.addEventListener('change', (/** @type {any} */ e) => { seen = e.detail; });
      try {
        press('ArrowDown');
        press('ArrowDown');
        const cursor = picker.querySelectorAll('.nav-active');
        assert(cursor.length === 1, `exactly one row carries the cursor, got ${cursor.length}`);
        assert(cursor[0].getAttribute('data-model') === 'other',
          `two steps lands on the second row, got "${cursor[0].getAttribute('data-model')}"`);
        press('Enter');
        assert(!!seen && seen.model === 'other', `Enter picks the cursor row, got ${JSON.stringify(seen)}`);
      } finally {
        picker.remove();
      }
    });

    await run('arrow keys wrap rather than running off the end', () => {
      const picker = makePicker({ connect: true });
      try {
        press('ArrowUp');
        const cursor = picker.querySelector('.nav-active');
        assert(!!cursor && cursor.classList.contains('no-model'),
          'the first ArrowUp lands on the last row, which is the none row');
      } finally {
        picker.remove();
      }
    });

    await run('Escape closes the picker and stops there', () => {
      const picker = makePicker({ connect: true });
      let closed = 0;
      let leaked = 0;
      const spy = () => { leaked++; };
      picker.addEventListener('close', () => { closed++; });
      document.addEventListener('keydown', spy);
      try {
        press('Escape');
        assert(closed === 1, `the picker asks its host to dismiss it, got ${closed} close events`);
        assert(leaked === 0,
          'the press must not reach document — popup-manager would dismiss a hosting modal too');
      } finally {
        document.removeEventListener('keydown', spy);
        picker.remove();
      }
    });

    await run('a modifier chord is left alone for the cycler holding it', () => {
      const picker = makePicker({ connect: true });
      try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'm', altKey: true, metaKey: true, bubbles: true, cancelable: true,
        }));
        const ids = [...picker.querySelectorAll('.menu-item[data-model]')]
          .map(r => r.getAttribute('data-model'));
        assert(ids.length === 3,
          `⌥⌘M drives the model cycler over this very HUD, so it must not filter — got ${JSON.stringify(ids)}`);
      } finally {
        picker.remove();
      }
    });

    await run('footer actions are announced by id, and absent ones leave no bar', () => {
      const bare = makePicker();
      assert(bare.querySelector('.model-picker-footer').hasAttribute('hidden'),
        'a host with no actions gets no footer');

      const picker = makePicker();
      picker.footerActions = [{ id: 'providers', label: 'Manage LLM providers…' }];
      /** @type {string|null} */
      let acted = null;
      picker.addEventListener('action', (/** @type {any} */ e) => { acted = e.detail.id; });
      picker.querySelector('.model-picker-footer .menu-item').click();
      assert(acted === 'providers', `the action's id is what leaves the picker, got ${acted}`);
    });

    // The picker's spacing is measured, not eyeballed, because two separate
    // regressions here were invisible to the markup: `.model-picker-rows` and
    // `.model-picker-footer` are both <menu> elements inside a `.dropdown-menu`,
    // so the UA-chrome reset `.dropdown-menu menu { margin: 0; padding: 0 }`
    // outranks a bare `.model-picker-*` selector on specificity AND order and
    // silently flattened their insets. Nothing about the DOM says so; only the
    // rendered box does. Both need a live layout, hence `connect: true`.

    /**
     * A picker on the page with one recent entry and one footer action, so every
     * inset the left column has to line up is actually present.
     * @returns {Promise<any>} The connected picker.
     */
    const laidOutPicker = async () => {
      await seedRecents([{ provider: 'p', model: 'm' }]);
      const p = makePicker({ connect: true, value: { provider: 'p', model: 'm' } });
      p.footerActions = [{ id: 'providers', label: 'Manage LLM providers…', iconClass: 'menu-settings-icon' }];
      return p;
    };

    await run('everything down the left column starts on one text line', async () => {
      const p = await laidOutPicker();
      try {
        const left = (/** @type {string} */ sel) => {
          const el = p.querySelector(sel);
          assert(!!el, `no element for "${sel}"`);
          return el.getBoundingClientRect().left;
        };
        // The card's heading is the line; the dials, Recent and the footer's icon
        // all have to agree with it. The footer's icon rather than its label:
        // the label sits past the icon, so the icon is what starts the row.
        const line = left('.model-current-label');
        // `.model-speed-label` rather than the thinking one: this fixture's model
        // advertises a serving tier and no thinking levels, so it is the dial
        // `<model-tuning>` actually renders here.
        for (const sel of ['.model-current-name', '.model-speed-label',
          '.model-picker-recent-label', '.recent-model .recent-model-name',
          '.model-picker-footer .menu-item > span']) {
          assert(Math.abs(left(sel) - line) < 1,
            `"${sel}" is ${(left(sel) - line).toFixed(1)}px off the column's text line`);
        }
      } finally {
        p.remove();
        await clearRecents();
      }
    });

    await run('as a phone sheet the sections stack without overlapping', async () => {
      // A crowded provider, so the list is far taller than the sheet's 85vh cap.
      // That pressure is the whole point: it is what forces a section that may
      // shrink below its content to do so.
      await seedRecents([{ provider: 'p', model: 'p-0' }]);
      const picker = /** @type {any} */ (document.createElement('model-picker'));
      picker.providers = [crowdedProvider('p')];
      picker.value = { provider: 'p', model: 'p-0' };
      picker.render();
      picker.footerActions = [{ id: 'providers', label: 'Manage LLM providers…', iconClass: 'menu-settings-icon' }];
      const { sections, cleanup } = await layOutAsPhoneSheet(picker);
      try {
        assert(sections.length >= 4,
          `expected the sheet's sections to lay out, got ${JSON.stringify(sections.map(s => s.name))}`);
        // Stacked, the sheet is the only scroller: each section takes its natural
        // height and follows the one before it. A section left free to shrink
        // below its content spills that content over its neighbour instead of
        // clipping it — which is how the actions ended up under the model list.
        for (let i = 1; i < sections.length; i++) {
          const prev = sections[i - 1];
          const next = sections[i];
          assert(next.top >= prev.bottom - 1,
            `"${next.name}" starts ${(prev.bottom - next.top).toFixed(1)}px inside "${prev.name}" — they overlap`);
        }
      } finally {
        cleanup();
        await clearRecents();
      }
    });

    // A window the server never reported looks exactly like one it did, and it
    // decides when the conversation compacts and how long a reply may run. The
    // card is where the size is shown, so it is where a guess has to say so —
    // and only a guess: a curated catalogue figure (fromAPI false, not assumed)
    // and a window the user already typed in are both real statements.
    await run('an assumed window says so on the card, and the marker opens that model\'s field', async () => {
      const card = (/** @type {any} */ entry) => {
        const el = /** @type {any} */ (document.createElement('model-picker'));
        el.providers = [{ name: 'local', displayName: 'Local', available: true, modelsWithContext: [entry] }];
        el.value = { provider: 'local', model: entry.id };
        el.render();
        return el;
      };

      const guessed = card({ id: 'guessed', contextWindow: 8192, windowAssumed: true });
      const marker = /** @type {HTMLElement|null} */ (guessed.querySelector('.model-window-assumed'));
      assert(!!marker, 'no assumed marker on a card whose window is the provider fallback');
      assert(/context/.test(guessed.querySelector('.model-current-sub')?.textContent || ''),
        'the card lost its context size');

      assert(!card({ id: 'catalogued', contextWindow: 128000, fromAPI: false }).querySelector('.model-window-assumed'),
        'a catalogued window was marked as assumed');
      assert(!card({ id: 'fixed', contextWindow: 256000, windowAssumed: true, providerContextWindow: 8192 })
        .querySelector('.model-window-assumed'),
      'a window the user overrode was marked as assumed');

      /** @type {Array<{tab: string|undefined, options: any}>} */
      const opened = [];
      const restore = registerSettingsOpener((tab, options) => { opened.push({ tab, options }); });
      try {
        marker?.click();
      } finally {
        restore();
      }
      assert(opened.length === 1, `the marker opened settings ${opened.length} times, want once`);
      assert(opened[0]?.tab === 'providers'
        && opened[0]?.options?.model?.provider === 'local' && opened[0]?.options?.model?.id === 'guessed',
      `the marker asked for ${JSON.stringify(opened[0])}, want the providers tab at local/guessed`);
    });

    await run('filled rows clear their own corner, and the list clears the scrollbar', async () => {
      const p = await laidOutPicker();
      try {
        // A row's rounded corner sweeps inward across its first line of text, so
        // padding under the radius leaves the text riding the curve. Worst on the
        // two-line Recent rows, whose text starts nearest the corner.
        for (const sel of ['.recent-model', '.model-picker-footer .menu-item']) {
          const cs = getComputedStyle(p.querySelector(sel));
          const pad = parseFloat(cs.paddingLeft);
          const radius = parseFloat(cs.borderTopLeftRadius);
          assert(pad >= radius,
            `"${sel}" pads ${pad}px inside a ${radius}px corner — the curve crops its text`);
        }

        // And the list's rows must not run into the scrollbar the stable gutter
        // reserves for them.
        const scroller = p.querySelector('.model-picker-rows');
        const row = p.querySelector('.model-picker-rows .menu-item');
        assert(!!row, 'expected at least one model row');
        const gap = scroller.getBoundingClientRect().left + scroller.clientWidth
          - row.getBoundingClientRect().right;
        assert(gap > 4, `only ${gap.toFixed(1)}px between a row's fill and the scrollbar`);
      } finally {
        p.remove();
        await clearRecents();
      }
    });
  } finally {
    void setMachinePref(VIEW_STATE_KEY, savedViewState);
  }

  // Every state the picker and its tuning dials draw, under en-XA. Model,
  // provider, level and tier names are data (digits here); the picker's own
  // words are not. Elements holding nothing but data are skipped, and the
  // messages nested in them (notes, chip titles, the context size) are read on
  // their own. The tables the picker draws from — recents, usage, the provider
  // switch — are stubbed, so nothing reaches the server.
  await run('en-XA: every picker and tuning state is translated', async () => {
    /**
     * Put a stubbed method back exactly as it was: an own property restored, an
     * inherited one uncovered.
     * @param {any} obj - The singleton.
     * @param {string} key - The method's name.
     * @returns {() => void} The restorer.
     */
    const saveMethod = (obj, key) => {
      const own = Object.prototype.hasOwnProperty.call(obj, key);
      const original = obj[key];
      return () => {
        if (own) obj[key] = original;
        else delete obj[key];
      };
    };
    const restorers = [
      saveMethod(usageStatsCache, 'refresh'),
      saveMethod(usageStatsCache, 'get'),
      saveMethod(providersCache, 'switchProvider'),
    ];
    /** @type {any} */
    let picker = null;
    /** @type {any} */
    let tuning = null;
    try {
      /** @type {any} */ (usageStatsCache).refresh = async () => {};
      /** @type {any} */ (usageStatsCache).get = () => null;
      /** @type {any} */ (providersCache).switchProvider = async () => { throw 'refused'; };
      await underPseudoLocale('model-picker-test', async () => {
        /** @type {string[]} */
        const shown = [];
        /**
         * @param {string} where - The state being drawn.
         * @param {string|null|undefined} s - What it showed.
         */
        const see = (where, s) => {
          assert(!!s, `${where}: nothing drawn`);
          shown.push(/** @type {string} */ (s));
        };
        // Elements whose whole text is data.
        const DATA = '.menu-header-label, .model-item-name, .recent-model-name, .recent-model-provider,'
          + ' .model-current-name, .model-current-sub, model-tuning';
        /**
         * Everything the picker shows outside the data elements.
         * @param {string} where - The state being drawn.
         */
        const seeAll = (where) => {
          const strings = shownStrings(picker, DATA);
          assert(strings.length > 0, `${where}: nothing drawn`);
          for (const s of strings) see(where, s);
        };

        /** @type {any} */
        const entry = { id: '7', displayName: '7', contextWindow: 1000, windowAssumed: true,
          thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high',
          serviceTiers: [{ id: '5', name: '5', description: '6' }] };
        const ready = { name: '4', displayName: '4', available: true,
          switchTo: { provider: '3', displayName: '3', reason: '' },
          modelsWithContext: [entry, { id: '8', displayName: '8', contextWindow: 1000, hidden: true }] };
        const login = { name: '2', displayName: '2', available: false, authType: 'oauth_bearer',
          modelsWithContext: [{ id: '1', displayName: '1' }] };
        const unset = { name: '0', displayName: '0', available: false,
          modelsWithContext: [{ id: '9', displayName: '9' }] };

        picker = /** @type {any} */ (document.createElement('model-picker'));
        picker.providers = [];
        picker.loading = true;
        picker.render();

        // Loading, then no providers at all (the none row and the empty card).
        seeAll('loading');
        see('picker aria-label', picker.getAttribute('aria-label'));
        picker.loading = false;
        seeAll('no providers');
        see('none row', picker.querySelector('.no-model .model-item-name')?.textContent);

        // Recents carrying a thinking level and a serving tier.
        const originalFetch = window.fetch;
        window.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({
          models: [{ provider: '4', model: '7', thinking: '1', serviceTier: '5' }] }) }));
        try {
          await recentModels.refresh();
        } finally {
          window.fetch = originalFetch;
        }

        // Every provider state: ready, login required, not configured.
        picker.providers = [ready, login, unset];
        picker.value = { provider: '4', model: '7' };
        picker.render();
        seeAll('providers');
        const notes = [...picker.querySelectorAll('.menu-item-note')];
        assert(notes.length === 2, `two unavailable-provider notes expected — got ${notes.length}`);
        for (const note of notes) see('unavailable note', note.textContent);
        const chips = [...picker.querySelectorAll('.recent-model-chip')];
        assert(chips.length === 2, `a thinking chip and a speed chip expected — got ${chips.length}`);
        for (const chip of chips) {
          const title = chip.getAttribute('title');
          see('recent chip title', title);
          assert(String(title).includes(chip.textContent || '?'), `the chip's value is kept — got "${title}"`);
        }
        const sub = picker.querySelector('.model-current-sub')?.firstChild?.textContent || '';
        see('context size', sub.split(' · ')[1]);
        const assumed = picker.querySelector('.model-window-assumed');
        assert(String(assumed?.getAttribute('title')).includes(formatTokens(1000)), 'the assumed size is kept');

        // Each list view, as the provider toggle names it.
        for (const state of ['none', 'top', 'all']) {
          picker._resolveViewState = () => state;
          picker.render();
          const toggle = picker.querySelector('.provider-view-toggle');
          see(`toggle ${state}`, toggle?.textContent);
          see(`toggle ${state} title`, toggle?.getAttribute('title'));
        }
        delete picker._resolveViewState;

        // The hidden model in use.
        picker.value = { provider: '4', model: '8' };
        picker.render();
        see('hidden note', picker.querySelector('.menu-item-note:not(.unavailable .menu-item-note)')?.textContent);

        // A provider switch that fails without saying why.
        picker.value = { provider: '4', model: '7' };
        picker.render();
        const switchButton = picker.querySelector('.model-provider-switch');
        await picker._switchProvider(switchButton);
        see('switch failure', switchButton?.getAttribute('title'));

        // Search: a match, then nothing.
        const input = /** @type {HTMLInputElement} */ (picker.querySelector('.model-picker-filter-input'));
        input.value = '7';
        input.dispatchEvent(new Event('input'));
        seeAll('search match');
        input.value = '6';
        input.dispatchEvent(new Event('input'));
        seeAll('search, no match');

        // The tuning dials: every known level, an unknown one (data), Standard,
        // and each form of Default.
        tuning = /** @type {any} */ (document.createElement('model-tuning'));
        tuning.modelEntry = { thinkingLevels: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', '9'],
          defaultThinkingLevel: 'high', serviceTiers: [{ id: '5', name: '5', description: '6' }] };
        for (const s of shownStrings(tuning, '[data-thinking-level="9"], [data-service-tier="5"]')) see('tuning', s);
        const unknown = tuning.querySelector('[data-thinking-level="9"]');
        assert(unknown?.textContent === '9', `an unknown level is shown as given — got "${unknown?.textContent}"`);
        tuning.modelEntry = { thinkingLevels: ['low'], defaultThinkingLevel: '' };
        see('bare default', tuning.querySelector('[data-thinking-level=""]')?.textContent);
        tuning.modelEntry = { thinkingLevels: ['low', '9'], defaultThinkingLevel: '9' };
        const unknownDefault = tuning.querySelector('[data-thinking-level=""]')?.textContent;
        see('unknown default', unknownDefault);
        assert(String(unknownDefault).includes('9'), `the default level is named — got "${unknownDefault}"`);

        const raw = shown.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      for (const restore of restorers) restore();
      picker?.remove();
      tuning?.remove();
      await clearRecents();
    }
  });

  return { passed, failed, errors };
}
