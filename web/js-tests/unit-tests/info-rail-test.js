//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two ways the sidebar's cards-win layout fails without anyone noticing.
 * Deliberately not a full description of the layout: dead space and a card that
 * doesn't appear are on screen the moment the app opens, and a test that repeats
 * what the first glance tells you is upkeep with no cover. These two are not
 * visible from a normal-sized window:
 *
 *   1. The rail never takes more than the share CSS caps it at, however many
 *      cards want in — the surplus is dropped from the tail. Left unguarded,
 *      cards eat a short column and the conversation list goes with it.
 *   2. Room that comes back is used: a card dropped in a short column returns
 *      when the column grows. The rail cannot get this right by measuring
 *      itself — its own height is its content, so it would only ever re-confirm
 *      the cards already up, and a card dropped once would stay dropped for the
 *      rest of the session.
 *
 * Reconciles are driven by calling `_reconcile()` directly, never by waiting on
 * the component's ResizeObserver: the hidden test page defers the "update the
 * rendering" step indefinitely under load (the same thing that put code-lines.js
 * on a timer chain), so an observer-driven assertion would be flaky by
 * construction on CI rather than by accident.
 * @module unit-tests/info-rail-test
 */

import InfoCardType from 'juggler/info-card-type';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { pseudoLocalize, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import infoCardRegistry from '../../js/registries/info-card-registry.js';
import '../../js/components/info-rail.js';
import '../../js/components/conversation-bar.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Height of each stub card's content region, so every card is the same size. */
const CARD_CONTENT_PX = 36;

/**
 * A stand-in info card of a fixed height. Ids are namespaced so they can never
 * collide with a real card, or with a hidden-set entry another suite persisted to
 * the localStorage key this origin shares between lanes.
 * @param {number} n - Which stub, highest priority first.
 * @returns {typeof InfoCardType} A registrable card class.
 */
function stubCard(n) {
  return class TestCard extends InfoCardType {
    static MANIFEST = {
      id: `test-rail-card-${n}`,
      name: `Test card ${n}`,
      version: '1.0.0',
      description: 'Stand-in card of a fixed height.',
      eyebrow: `STUB ${n}`,
      priority: 100 - n,
    };

    /**
     * @param {HTMLElement} contentEl - The content region to fill.
     * @returns {() => void} Teardown.
     */
    mount(contentEl) {
      contentEl.style.height = `${CARD_CONTENT_PX}px`;
      return () => {};
    }
  };
}

/**
 * Put `count` stub cards in the registry, replacing whatever it holds. Reset
 * first as well as after: a lane shares one realm across the suites it runs, so
 * the registry may arrive with another suite's cards (or the real ones) in it.
 * @param {number} count - How many stubs to register.
 * @returns {void}
 */
function registerStubs(count) {
  infoCardRegistry.reset();
  for (let n = 1; n <= count; n++) infoCardRegistry.registerClass(stubCard(n));
}

/**
 * Mount a sidebar column: the real element names and classes, so the real
 * stylesheet applies, sized by the host rather than by the 15rem the sheet gives
 * a live sidebar.
 *
 * Off-screen but genuinely laid out — every assertion here is a measurement.
 * @param {{height: number, tabs: number}} opts - Column height in px, and how many tabs to fill it with.
 * @returns {{nav: HTMLElement, tabs: HTMLElement, rail: any, bin: HTMLElement, cards: () => HTMLElement[], resize: (h: number) => void, teardown: () => void}} The mounted column.
 */
function mountColumn({ height, tabs }) {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-9999px;top:0;width:240px;height:${height}px;`;
  document.body.appendChild(host);

  const bar = document.createElement('conversation-bar');
  bar.style.cssText = 'position:absolute;inset:0;width:240px;height:100%;';
  host.appendChild(bar);

  const tabMarkup = Array.from({ length: tabs }, (_, i) => `
    <li class="conversation-bar-tab" data-conversation-id="c${i}">
      <button class="conversation-bar-tab-button"><span class="conversation-bar-tab-name">Tab ${i}</span></button>
    </li>`).join('');

  // Stands in for conversation-bar.render()'s output: the column, the scrolling
  // tab list in its viewport, the rail, and the Bin that pins the bottom.
  bar.innerHTML = `
    <nav class="conversation-bar">
      <div class="conversation-tabs-viewport">
        <menu class="conversation-tabs">${tabMarkup}</menu>
      </div>
      <info-rail></info-rail>
      <button class="conversation-bin" style="height:28px;flex:0 0 auto;">Bin</button>
    </nav>`;

  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (bar.querySelector(sel));
  const rail = /** @type {any} */ (q('info-rail'));
  return {
    nav: q('nav.conversation-bar'),
    tabs: q('menu.conversation-tabs'),
    rail,
    bin: q('.conversation-bin'),
    cards: () => /** @type {HTMLElement[]} */ (Array.from(rail.querySelectorAll('.info-card'))),
    resize: (h) => { host.style.height = `${h}px`; rail._reconcile(); },
    teardown: () => host.remove(),
  };
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

  try {
    await run('a short column keeps its share for the tabs and drops cards from the tail', () => {
      registerStubs(3);
      const col = mountColumn({ height: 220, tabs: 12 });
      try {
        col.rail._reconcile();
        const ids = col.cards().map((c) => c.dataset.cardId);
        assert(ids.length < 3, `a 220px column cannot hold all three, got ${ids.length}`);
        assert(ids.every((id, i) => id === `test-rail-card-${i + 1}`),
          `what is kept is the top of the stack, got ${ids.join(', ') || '(none)'}`);
        assert(col.rail.offsetHeight <= col.nav.clientHeight / 2 + 1,
          `the rail never takes more than half (${col.nav.clientHeight / 2}px), got ${col.rail.offsetHeight}px`);
        assert(col.tabs.clientHeight >= col.nav.clientHeight / 2 - col.bin.offsetHeight - 1,
          `so the list keeps the rest, got ${col.tabs.clientHeight}px`);
      } finally {
        col.teardown();
      }
    });

    await run('room that comes back is used', () => {
      registerStubs(3);
      const col = mountColumn({ height: 220, tabs: 12 });
      try {
        col.rail._reconcile();
        const cramped = col.cards().length;
        assert(cramped < 3, `starts cramped, got ${cramped} cards`);

        col.resize(900);
        assert(col.cards().length === 3,
          `a taller column takes the dropped cards back, got ${col.cards().length}`);

        col.resize(220);
        assert(col.cards().length === cramped,
          `and gives them up again, got ${col.cards().length}`);
      } finally {
        col.teardown();
      }
    });

    await run('a card that comes and goes is re-asked when it says its answer changed', () => {
      // The rail never polls, and a card with nothing to show is never mounted —
      // so without watchContent a card hidden at startup could never appear.
      let showing = false;
      /** @type {(() => void)|null} */
      let notify = null;
      let watching = 0;
      /** @type {any[]} */
      const sessions = [];
      infoCardRegistry.reset();
      infoCardRegistry.registerClass(class ComesAndGoesCard extends InfoCardType {
        static MANIFEST = {
          id: 'test-rail-comes-and-goes',
          name: 'Comes and goes',
          version: '1.0.0',
          description: 'Stand-in card with content only sometimes.',
          eyebrow: 'STUB',
          priority: 100,
        };

        /**
         * @param {any} session - The rail's session.
         * @returns {boolean} Whether there is anything to show.
         */
        hasContent(session) {
          sessions.push(session);
          return showing;
        }

        /**
         * @param {any} _session - The rail's session.
         * @param {() => void} onChange - Ask the rail to re-ask.
         * @returns {() => void} Stop watching.
         */
        watchContent(_session, onChange) {
          watching++;
          notify = onChange;
          return () => { watching--; notify = null; };
        }

        /**
         * @param {HTMLElement} contentEl - The content region.
         * @returns {() => void} Teardown.
         */
        mount(contentEl) {
          contentEl.style.height = `${CARD_CONTENT_PX}px`;
          return () => {};
        }
      });
      const col = mountColumn({ height: 600, tabs: 1 });
      try {
        const session = { id: 'stand-in session' };
        col.rail.setSession(session);
        assert(col.cards().length === 0, 'nothing to show, so nothing mounted');
        assert(watching === 1, `the rail watches the unmounted card, got ${watching} watches`);
        assert(sessions.at(-1) === session, 'and asks it about the rail\u2019s own session');

        showing = true;
        /** @type {any} */ (notify)?.();
        assert(col.cards().length === 1, `the card appears when it says so, got ${col.cards().length}`);

        showing = false;
        /** @type {any} */ (notify)?.();
        assert(col.cards().length === 0, `and goes again, got ${col.cards().length}`);
        assert(watching === 1, `one watch throughout, got ${watching}`);
      } finally {
        col.teardown();
      }
      assert(watching === 0, `leaving the page stops the watch, got ${watching}`);
    });

    await run('en-XA: a card\u2019s eyebrow is translated in the catalogue of the extension that ships it', async () => {
      // A stand-in extension id, so only the card's own catalogue can supply it.
      const extensionId = '@test/info-rail-eyebrow';
      infoCardRegistry.reset();
      infoCardRegistry.registerClass(class EyebrowCard extends InfoCardType {
        static MANIFEST = {
          id: 'test-rail-eyebrow-card',
          name: 'Eyebrow card',
          version: '1.0.0',
          description: 'Stand-in card with an eyebrow.',
          eyebrow: 'Stand-in eyebrow',
          priority: 100,
        };

        /** @returns {() => void} Teardown. */
        mount() { return () => {}; }
      }, { extensionId });
      await underPseudoLocale('info-rail-test', () => {
        const col = mountColumn({ height: 600, tabs: 1 });
        try {
          col.rail._reconcile();
          const eyebrow = col.rail.querySelector('.info-card__eyebrow')?.textContent;
          assert(eyebrow === pseudoLocalize('Stand-in eyebrow'),
            `expected the eyebrow in its extension's catalogue, got ${JSON.stringify(eyebrow)}`);
        } finally {
          col.teardown();
        }
      }, { [extensionId]: ['Stand-in eyebrow'] });
    });

    await run('en-XA: the rail\u2019s chrome and the info-cards menu, in every state, are translated', async () => {
      // A stand-in extension id, so the card's name can only come from its own catalogue.
      const extensionId = '@test/info-rail-chrome';
      infoCardRegistry.reset();
      infoCardRegistry.registerClass(class ChromeCard extends InfoCardType {
        static MANIFEST = {
          id: 'test-rail-chrome-card',
          name: 'Stand-in card',
          version: '1.0.0',
          description: 'Stand-in card for the chrome.',
          eyebrow: 'Stand-in eyebrow',
          priority: 100,
        };

        /** @returns {() => void} Teardown. */
        mount() { return () => {}; }
      }, { extensionId });
      /** @type {string[]} */
      const raw = [];
      /**
       * @param {string} where - The state drawn.
       * @param {string[]} shown - What it showed.
       */
      const collect = (where, shown) => {
        assert(shown.length > 0, `${where}: drew nothing`);
        for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
      };
      await underPseudoLocale('info-rail-test', () => {
        const col = mountColumn({ height: 600, tabs: 1 });
        /** @type {any} */
        let button = null;
        try {
          col.rail._reconcile();
          assert(col.cards().length === 1, `expected the stand-in card mounted, got ${col.cards().length}`);
          // The × is a glyph standing alone; its aria-label/title are checked on their own.
          collect('rail', shownStrings(col.rail, '.info-card__close'));
          const close = /** @type {HTMLElement} */ (col.rail.querySelector('.info-card__close'));
          assert(!!close, 'the card has no close button');
          collect('close button', [close.getAttribute('aria-label') || '', close.title].filter(Boolean));

          button = col.rail.querySelector('info-cards-button');
          assert(!!button, 'the rail has no info-cards button');
          button._openMenu();
          const menu = document.querySelector('.info-cards-menu');
          assert(!!menu, 'the info-cards menu did not open');
          collect('menu', shownStrings(/** @type {Element} */ (menu)));
          button._closeMenu();

          infoCardRegistry.reset();
          button._openMenu();
          const empty = document.querySelector('.info-cards-menu');
          assert(!!empty, 'the empty info-cards menu did not open');
          collect('empty menu', shownStrings(/** @type {Element} */ (empty)));
        } finally {
          button?._closeMenu();
          col.teardown();
        }
      }, { [extensionId]: ['Stand-in card', 'Stand-in eyebrow'] });
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
  } finally {
    // Realm-global: leave the registry as this suite found it, or the next suite
    // in this lane inherits stub cards.
    infoCardRegistry.reset();
  }

  return { passed, failed, errors };
}
