//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The nudge engine (`services/guidance/nudge-engine.js`): every rule deciding
 * whether a hint is shown, driven here over a fake catalogue, a fake clock and
 * fake usage counts so each rule is seen on its own.
 *
 *   1. Retirement: an entry whose `retireOn` usage has happened never shows.
 *   2. One at a time: a surface gets the first eligible entry, nothing during a
 *      running turn, and only entries for that surface.
 *   3. Dismissal, by scope: user (everywhere), project (this project only),
 *      conversation (this conversation, this page) — and a cooldown that lets a
 *      dismissed entry come back.
 *   4. The teaching budget: one new teaching hint a day, and a started one
 *      lapses after its lifetime.
 *   5. Returning users are never taught.
 *   6. Back-off: two dismissed teaching hints bring the offer to switch them off.
 *   7. The off switch silences tips and teaching, and leaves situational hints
 *      as their bare actions.
 *   8. The off state migrates from the legacy tips preference.
 *   9. The real catalogue is well-formed: unique ids, usage events the record
 *      accepts, commands that exist. (Its kinds and surfaces are `NudgeEntry`'s
 *      types, so the type checker holds those.)
 * @module unit-tests/nudge-engine-test
 */

import { createNudgeEngine, migrateLegacyGuidance, TEACH_GAP_MS, TEACH_LIFETIME_MS } from '../../js/services/guidance/nudge-engine.js';
import { NUDGES } from '../../js/services/guidance/nudge-catalogue.js';
import { isUsageEvent } from '../../js/services/guidance/usage-signals.js';

/**
 * What a nudge's `retireOn` may name: an event the usage record keeps, or
 * `prefix:*` for any event under a prefix it keeps — the form the engine
 * reads as "any of them".
 * @param {string} pattern - One `retireOn` entry
 * @returns {boolean} Whether the record could ever retire it
 */
function isUsagePattern(pattern) {
  return pattern.endsWith(':*') ? isUsageEvent(`${pattern.slice(0, -1)}any`) : isUsageEvent(pattern);
}

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

  const HOUR = 3600_000;

  /** @type {any[]} */
  const CATALOGUE = [
    { id: 'tip-a', kind: 'tip', surface: 'empty-hint', title: 'A', body: 'a', retireOn: ['shortcut:a'] },
    { id: 'situ', kind: 'situational', surface: 'footer', title: 'Long', body: 'long', scope: 'conversation',
      when: (/** @type {any} */ ctx) => ctx.long === true, compactWhen: (/** @type {any} */ u) => u.any('slash:compact'),
      actions: [{ label: 'Compact', command: 'compact' }] },
    { id: 'proj', kind: 'situational', surface: 'empty-hint', title: 'P', body: 'p', scope: 'project',
      when: () => true, actions: [{ label: 'Do', command: 'compact' }] },
    { id: 'teach-1', kind: 'teach', surface: 'footer', title: 'T1', body: 't1', retireOn: ['slash:x'],
      when: () => true, actions: [] },
    { id: 'teach-2', kind: 'teach', surface: 'footer', title: 'T2', body: 't2', retireOn: ['slash:y'],
      when: () => true, actions: [] },
    { id: 'offer', kind: 'offer', surface: 'footer', title: 'Off?', body: 'off?',
      actions: [{ label: 'Turn off', run: 'turn-off-guidance' }, { label: 'Keep', run: 'keep-guidance' }] },
    { id: 'cooled', kind: 'situational', surface: 'side', title: 'C', body: 'c', scope: 'user', cooldownMs: 10 * HOUR,
      when: () => true, actions: [] },
  ];

  /**
   * A fresh engine over in-memory state.
   * @param {{counts?: Record<string, number>, veteran?: boolean, user?: any, project?: any}} [opts]
   * @returns {{engine: ReturnType<typeof createNudgeEngine>, clock: {t: number}, counts: Record<string, number>, store: {user: any, project: any}}} The rig.
   */
  const make = ({ counts = {}, veteran = false, user = null, project = null } = {}) => {
    const clock = { t: Date.UTC(2026, 9, 1, 9) };
    const store = { user, project };
    const usage = {
      count: (/** @type {string} */ e) => counts[e] ?? 0,
      any: (/** @type {string} */ p) => Object.entries(counts).some(([k, n]) => k.startsWith(p) && n > 0),
      isVeteran: () => veteran,
    };
    const engine = createNudgeEngine({
      catalogue: CATALOGUE,
      usage,
      now: () => clock.t,
      user: { load: () => store.user, save: (/** @type {any} */ s) => { store.user = JSON.parse(JSON.stringify(s)); } },
      project: { load: () => store.project, save: (/** @type {any} */ s) => { store.project = JSON.parse(JSON.stringify(s)); } },
    });
    return { engine, clock, counts, store };
  };

  /**
   * @param {any} n - What nudgeFor returned.
   * @returns {string|null} Its id, or null.
   */
  const id = (n) => n?.id ?? null;

  await run('1: retirement', () => {
    const { engine, counts } = make();
    eq(engine.isTipLearnt('tip-a'), false, 'an unlearnt tip');
    counts['shortcut:a'] = 1;
    eq(engine.isTipLearnt('tip-a'), true, 'its shortcut used');
    eq(id(engine.nudgeFor('footer', {})), 'teach-1', 'the first teaching hint');
    counts['slash:x'] = 1;
    eq(id(engine.nudgeFor('footer', {})), 'teach-2', 'teach-1 retired by its usage, the next one is up');
  });

  await run('2: one per surface, none mid-turn, priority order', () => {
    const { engine } = make();
    eq(id(engine.nudgeFor('footer', { long: true })), 'situ', 'the first eligible entry wins');
    eq(engine.nudgeFor('footer', { long: true, turnActive: true }), null, 'nothing while a turn runs');
    eq(id(engine.nudgeFor('empty-hint', {})), 'proj', 'tips are not nudges; the empty hint gets its situational');
    eq(engine.nudgeFor('nowhere', {}), null, 'an unknown surface');
  });

  await run('3: dismissal by scope, and cooldown', () => {
    const rig = make();
    rig.engine.dismiss('situ', { conversationId: 'c1' });
    eq(id(rig.engine.nudgeFor('footer', { long: true, conversationId: 'c1' })), 'teach-1', 'dismissed in c1');
    eq(id(rig.engine.nudgeFor('footer', { long: true, conversationId: 'c2' })), 'situ', 'but not in c2');
    eq(rig.store.user?.dismissed?.situ, undefined, 'a conversation dismissal is not persisted');

    rig.engine.dismiss('proj', {});
    eq(rig.engine.nudgeFor('empty-hint', {}), null, 'a project dismissal holds');
    eq(typeof rig.store.project?.dismissed?.proj, 'number', 'and is stored in the project realm');
    eq(rig.store.user?.dismissed?.proj, undefined, 'not the user realm');

    rig.engine.dismiss('cooled', {});
    eq(rig.engine.nudgeFor('side', {}), null, 'cooling down');
    rig.clock.t += 11 * HOUR;
    eq(id(rig.engine.nudgeFor('side', {})), 'cooled', 'back after its cooldown');
  });

  await run('4: one new teaching hint a day; a started one lapses', () => {
    const { engine, clock, counts } = make();
    eq(id(engine.nudgeFor('footer', {})), 'teach-1', 'first');
    engine.noteShown('teach-1');
    counts['slash:x'] = 1; // learnt it
    eq(id(engine.nudgeFor('footer', {})), null, 'teach-2 waits for the gap');
    clock.t += TEACH_GAP_MS + 1;
    eq(id(engine.nudgeFor('footer', {})), 'teach-2', 'after the gap');
    engine.noteShown('teach-2');
    clock.t += TEACH_LIFETIME_MS + 1;
    eq(engine.nudgeFor('footer', {}), null, 'a hint shown past its lifetime lapses');
  });

  await run('5: returning users are not taught', () => {
    const { engine } = make({ veteran: true });
    eq(engine.nudgeFor('footer', {}), null, 'no teaching');
    eq(id(engine.nudgeFor('footer', { long: true })), 'situ', 'situational still shows');
  });

  await run('6: two teaching dismissals bring the offer', () => {
    const { engine, clock } = make();
    engine.noteShown('teach-1');
    engine.dismiss('teach-1', {});
    clock.t += TEACH_GAP_MS + 1;
    eq(id(engine.nudgeFor('footer', {})), 'teach-2', 'one dismissal: carry on');
    engine.noteShown('teach-2');
    engine.dismiss('teach-2', {});
    eq(id(engine.nudgeFor('footer', {})), 'offer', 'two: offer to switch off');
    engine.runAction({ run: 'keep-guidance' });
    eq(engine.nudgeFor('footer', {}), null, 'kept: the offer goes, and is not made again');
    eq(engine.shown(), true, 'guidance still on');
  });

  await run('7: the off switch', () => {
    const { engine } = make();
    engine.setShown(false);
    eq(engine.shown(), false, 'off');
    eq(engine.nudgeFor('footer', {}), null, 'no teaching');
    const n = engine.nudgeFor('footer', { long: true });
    eq(id(n), 'situ', 'situational still there');
    eq(n?.compact, true, 'as bare actions');
    engine.setShown(true);
    eq(engine.nudgeFor('footer', { long: true })?.compact, false, 'on again: with its copy');
  });

  await run('7b: compactWhen drops the copy for someone who knows', () => {
    const { engine } = make({ counts: { 'slash:compact': 1 } });
    eq(engine.nudgeFor('footer', { long: true })?.compact, true, 'they have compacted before');
  });

  await run('8: legacy off migrates', () => {
    eq(migrateLegacyGuidance({ off: true, seen: [] })?.off, true, 'off carried over');
    eq(migrateLegacyGuidance({ seen: ['x'] })?.off, undefined, 'on stays on');
    eq(migrateLegacyGuidance(null), null, 'nothing to migrate');
    const { engine } = make({ user: migrateLegacyGuidance({ off: true }) });
    eq(engine.shown(), false, 'an engine over migrated state is off');
  });

  /**
   * An engine over the real catalogue.
   * @param {{counts?: Record<string, number>, days?: Record<string, number>, veteran?: boolean, facts?: Record<string, Record<string, any>>}} [opts]
   * @returns {ReturnType<typeof createNudgeEngine>} The engine.
   */
  const real = ({ counts = {}, days = {}, veteran = false, facts = {} } = {}) => {
    /** @type {any} */
    let user = null;
    /** @type {any} */
    let project = null;
    return createNudgeEngine({
      catalogue: NUDGES,
      usage: {
        count: (e) => counts[e] ?? 0,
        any: (p) => Object.entries(counts).some(([k, n]) => k.startsWith(p) && n > 0),
        isVeteran: () => veteran,
        days: (/** @type {string} */ e) => days[e] ?? 0,
      },
      facts: { get: (name, key) => (key === undefined ? undefined : facts[name]?.[key]) },
      user: { load: () => user, save: (s) => { user = s; } },
      project: { load: () => project, save: (s) => { project = s; } },
    });
  };
  const root = { threadItemId: null, conversation: { id: 'c1' } };
  const sub = { threadItemId: 'msg_1', conversation: { id: 'c1' } };

  await run('10: long-conversation', () => {
    const e = real();
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 75_000, budget: 100_000 } })), 'long-conversation', 'at 75%');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 50_000, budget: 100_000 } })), null, 'not at 50%');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 450_000, budget: 1_000_000 } })), 'long-conversation',
      'at 450k of a million: long whatever the fraction');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 350_000, budget: 1_000_000 } })), null, 'not at 350k of a million');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 75_000, budget: 0 } })), null, 'not with no known window');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: sub, tokens: { total: 75_000, budget: 100_000 } })), null, 'not on a sub-thread');
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, turnActive: true, tokens: { total: 75_000, budget: 100_000 } })), null, 'not mid-turn');
    const n = e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 75_000, budget: 100_000 } });
    eq(n?.actions.map((a) => a.command), ['compact', 'handoff'], 'compact and hand off');
    eq(n?.compact, false, 'with its copy, for someone who has not compacted');
    eq(real({ counts: { 'slash:handoff': 1 } }).nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 75_000, budget: 100_000 } })?.compact,
      true, 'buttons only once they have');
    e.dismiss('long-conversation', { conversationId: 'c1' });
    eq(id(e.nudgeFor('footer', { conversationId: 'c1', thread: root, tokens: { total: 75_000, budget: 100_000 } })), null, 'dismissed for c1');
    eq(id(e.nudgeFor('footer', { conversationId: 'c2', thread: root, tokens: { total: 75_000, budget: 100_000 } })), 'long-conversation', 'not for c2');
  });

  await run('11: slash-commands', () => {
    const used = { counts: { 'composer:send': 12 }, days: { 'composer:send': 3 } };
    eq(id(real(used).nudgeFor('footer', { conversationId: 'c1', thread: root })), 'slash-commands', 'a regular who has never used one');
    eq(id(real({ counts: { 'composer:send': 3 }, days: { 'composer:send': 1 } }).nudgeFor('footer', { thread: root })), null, 'not on the first day');
    eq(id(real({ ...used, counts: { ...used.counts, 'slash:clear': 1 } }).nudgeFor('footer', { thread: root })), null, 'retired by any command');
    eq(id(real({ ...used, veteran: true }).nudgeFor('footer', { thread: root })), null, 'never for a returning user');
  });

  await run('12: instruction-file', () => {
    const regular = { days: { 'composer:send': 2 } };
    const none = { 'instruction-files': { c1: 0 } };
    eq(id(real({ ...regular, facts: none }).nudgeFor('empty-hint', { conversationId: 'c1', thread: root })), 'instruction-file', 'none found');
    eq(id(real({ ...regular, facts: { 'instruction-files': { c1: 1 } } }).nudgeFor('empty-hint', { conversationId: 'c1', thread: root })), null, 'one found');
    eq(id(real({ ...regular }).nudgeFor('empty-hint', { conversationId: 'c1', thread: root })), null, 'not before the seeder has looked');
    eq(id(real({ days: { 'composer:send': 1 }, facts: none }).nudgeFor('empty-hint', { conversationId: 'c1', thread: root })), null, 'not on the first day');
    const e = real({ ...regular, facts: none });
    const n = e.nudgeFor('empty-hint', { conversationId: 'c1', thread: root });
    eq(n?.actions.map((a) => a.command ?? a.run), ['init', 'dismiss'], 'create one, or not for this project');
    e.dismiss('instruction-file', {});
    eq(id(e.nudgeFor('empty-hint', { conversationId: 'c1', thread: root })), null, 'dismissed for the project');
  });

  await run('9: the real catalogue is well-formed', async () => {
    const ids = new Set();
    const { default: slashCommandHandler } = await import('../../js/services/slash-command-handler.js');
    const { default: commandRegistry } = await import('../../js/registries/command-registry.js');
    await slashCommandHandler.init();
    for (const entry of NUDGES) {
      if (ids.has(entry.id)) throw new Error(`duplicate id ${entry.id}`);
      ids.add(entry.id);
      for (const ev of entry.retireOn ?? []) {
        if (!isUsagePattern(ev)) throw new Error(`${entry.id}: retireOn ${ev} is not a usage event`);
      }
      if (entry.kind !== 'tip' && entry.kind !== 'offer' && typeof entry.when !== 'function') {
        throw new Error(`${entry.id}: a nudge needs a when()`);
      }
      for (const action of entry.actions ?? []) {
        if (action.command && !commandRegistry.getByNameOrAlias(action.command)) {
          throw new Error(`${entry.id}: action runs /${action.command}, which is not a command`);
        }
      }
    }
    if (!NUDGES.some((e) => e.kind === 'offer')) throw new Error('the catalogue needs the off-switch offer');
  });

  return { passed, failed, errors };
}
