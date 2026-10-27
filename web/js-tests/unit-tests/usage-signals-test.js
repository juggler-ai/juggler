//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The usage-signal store (`services/guidance/usage-signals.js`): the one
 * record of what a person has done, which every piece of guidance reads.
 *
 *   1. Counting: a count per event, saturating at a cap so a held key stops
 *      writing once nothing can depend on a bigger number.
 *   2. First use is stamped once, and distinct local days are counted.
 *   3. Event names are a closed set: an unknown one throws in a strict store.
 *   4. Nothing is written before the stored state has been read — an event
 *      recorded early is replayed onto what was stored rather than replacing it.
 *   5. A store's state survives a JSON round trip (it lives in a preference).
 *   6. The legacy tips and word-of-mouth preferences seed the first state, and
 *      their existence marks the person as a returning user.
 * @module unit-tests/usage-signals-test
 */

import { createUsageStore, migrateLegacyUsage, isUsageEvent } from '../../js/services/guidance/usage-signals.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  /**
   * A store over an in-memory preference, already loaded.
   * @param {{initial?: any, clock?: {t: number}}} [opts]
   * @returns {{store: ReturnType<typeof createUsageStore>, saved: any[], clock: {t: number}}} The store and what it wrote.
   */
  const make = ({ initial = null, clock = { t: Date.UTC(2026, 9, 1, 12) } } = {}) => {
    /** @type {any[]} */
    const saved = [];
    const store = createUsageStore({
      save: (state) => { saved.push(JSON.parse(JSON.stringify(state))); },
      now: () => clock.t,
      strict: true,
    });
    store.hydrate(initial);
    return { store, saved, clock };
  };

  await run('1: counts per event, and saturates', () => {
    const { store, saved } = make();
    eq(store.count('slash:compact'), 0, 'an event never recorded');
    store.record('slash:compact');
    store.record('slash:compact');
    eq(store.count('slash:compact'), 2, 'two records');
    eq(store.count('slash:handoff'), 0, 'another event is untouched');
    eq(store.any('slash:'), true, 'a prefix with a recorded event');
    eq(store.any('shortcut:'), false, 'a prefix with none');
    for (let i = 0; i < 500; i++) store.record('slash:compact');
    const writes = saved.length;
    store.record('slash:compact');
    eq(saved.length, writes, 'a saturated count on a known day writes nothing');
    if (store.count('slash:compact') > 100) throw new Error(`count should saturate, got ${store.count('slash:compact')}`);
  });

  await run('2: first use stamped once; distinct days counted', () => {
    const { store, clock } = make();
    const t0 = clock.t;
    store.record('composer:send');
    clock.t += 60_000;
    store.record('composer:send');
    eq(store.first('composer:send'), t0, 'first use is the first record');
    eq(store.days('composer:send'), 1, 'two sends one day');
    clock.t += 24 * 3600_000;
    store.record('composer:send');
    eq(store.days('composer:send'), 2, 'a send the next day');
    eq(store.first('composer:never'), null, 'an unrecorded event has no first use');
  });

  await run('3: event names are a closed set', () => {
    eq(isUsageEvent('slash:compact'), true, 'slash:<id>');
    eq(isUsageEvent('shortcut:next-tab'), true, 'shortcut:<id>');
    eq(isUsageEvent('composer:send'), true, 'a fixed event');
    eq(isUsageEvent('made-up'), false, 'an unknown name');
    eq(isUsageEvent('slash:'), false, 'a prefix with no id');
    const { store } = make();
    let threw = false;
    try { store.record('made-up'); } catch { threw = true; }
    eq(threw, true, 'a strict store throws on an unknown name');
  });

  await run('4: nothing is written before the stored state is read', () => {
    /** @type {any[]} */
    const saved = [];
    const store = createUsageStore({ save: (s) => { saved.push(s); }, now: () => 1000, strict: true });
    store.record('slash:compact');
    eq(saved.length, 0, 'no write before hydrate');
    eq(store.count('slash:compact'), 1, 'but the record is visible at once');
    store.hydrate({ v: 1, since: 5, e: { 'slash:compact': { n: 3, f: 5, d: 1, ld: '1970-01-01' } } });
    eq(store.count('slash:compact'), 4, 'the early record is replayed onto the stored count');
    eq(store.first('slash:compact'), 5, 'and keeps the stored first use');
    eq(saved.length, 1, 'one write after hydrate');
  });

  await run('5: state survives a JSON round trip', () => {
    const { store, saved } = make();
    store.record('shortcut:next-tab');
    store.record('composer:send');
    const again = make({ initial: saved[saved.length - 1] }).store;
    eq(again.count('shortcut:next-tab'), 1, 'shortcut count');
    eq(again.count('composer:send'), 1, 'send count');
  });

  await run('6: legacy preferences seed the first state', () => {
    const fresh = migrateLegacyUsage({ tips: null, wordOfMouth: null }, 77);
    eq(fresh.veteran, undefined, 'nothing stored before: a new user');
    eq(fresh.since, 77, 'since is now');

    const day = Date.UTC(2026, 8, 1, 12);
    const old = migrateLegacyUsage({
      tips: { seen: ['next-tab', 'cycle-model'], off: true },
      wordOfMouth: { first: day, days: ['2026-09-01', '2026-09-03'] },
    }, 99);
    eq(old.veteran, true, 'legacy prefs mark a returning user');
    const store = make({ initial: old }).store;
    eq(store.count('shortcut:next-tab'), 1, 'a seen tip becomes a recorded shortcut');
    eq(store.count('shortcut:cycle-model'), 1, 'every seen tip');
    eq(store.first('composer:send'), day, 'word-of-mouth first send');
    eq(store.days('composer:send'), 2, 'word-of-mouth days');
    eq(store.isVeteran(), true, 'the store reports it');
  });

  // The app's own store, fed by the real dispatchers. Neither shortcut handlers
  // nor commands report their own use, so if these move, the choke point did it.
  await run('7: the shortcut dispatcher and the slash handler report use', async () => {
    const { usageCount } = await import('../../js/services/guidance/usage-signals.js');
    const { default: keyShortcutManager } = await import('../../js/services/key-shortcut-manager.js');
    const { default: slashCommandHandler } = await import('../../js/services/slash-command-handler.js');
    const { default: commandRegistry } = await import('../../js/registries/command-registry.js');

    const appHandler = keyShortcutManager._handlers.get('move-tab-up');
    let acted = true;
    const unregister = keyShortcutManager.register('move-tab-up', () => acted);
    const before = usageCount('shortcut:move-tab-up');
    /** @returns {void} */
    const press = () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true, bubbles: true, cancelable: true }));
    };
    try {
      press();
      eq(usageCount('shortcut:move-tab-up'), Math.min(before + 1, 50), 'a shortcut that acted is counted');
      acted = false;
      const after = usageCount('shortcut:move-tab-up');
      press();
      eq(usageCount('shortcut:move-tab-up'), after, 'a press its handler declined is not');
    } finally {
      unregister();
      if (appHandler) keyShortcutManager._handlers.set('move-tab-up', appHandler);
    }

    await slashCommandHandler.init();
    const realLookup = commandRegistry.getByNameOrAlias;
    class ProbeCommand {
      static MANIFEST = { id: 'usage-probe' };
      /** @returns {Promise<{handled: boolean}>} Handled. */
      async execute() { return { handled: true }; }
    }
    commandRegistry.getByNameOrAlias = (/** @type {string} */ name) => (name === 'usage-probe' ? ProbeCommand : realLookup.call(commandRegistry, name));
    try {
      const ran = usageCount('slash:usage-probe');
      await slashCommandHandler.execute('/usage-probe');
      eq(usageCount('slash:usage-probe'), Math.min(ran + 1, 50), 'a command that ran is counted');
      await slashCommandHandler.execute('/no-such-command-here');
      eq(usageCount('slash:no-such-command-here'), 0, 'an unknown command is not');
    } finally {
      commandRegistry.getByNameOrAlias = realLookup;
    }
  });

  return { passed, failed, errors };
}
