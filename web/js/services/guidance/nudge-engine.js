//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The nudge engine — the only place that decides whether a piece of guidance
 * is shown. It reads the catalogue ({@link module:services/guidance/nudge-catalogue}),
 * the usage record ({@link module:services/guidance/usage-signals}) and its own
 * small state (dismissals, which teaching hints have started, the off switch),
 * and answers one question per surface: which hint, if any, goes here now.
 *
 * The rules, so that guidance helps a newcomer without nagging anyone else:
 * - **Retirement.** An entry whose `retireOn` usage has happened is done with —
 *   someone who uses the thing a hint suggests has learnt it. `slash:*` names
 *   any command at all.
 * - **One at a time.** A surface gets at most one hint, the first eligible in
 *   catalogue order, and nothing while a turn is running there.
 * - **Dismissal is per scope.** `user` (every project), `project` (this one —
 *   stored in the project realm, so "not for this project" means exactly that),
 *   or `conversation` (this conversation, this page — a hint about the state in
 *   front of you, which is no business of any other window). A `cooldownMs`
 *   makes a dismissal lapse.
 * - **The teaching budget.** A teaching hint starts at most once per
 *   {@link TEACH_GAP_MS} after another started, and lapses
 *   {@link TEACH_LIFETIME_MS} after it started.
 * - **Returning users are not taught.** Someone who used the app before the
 *   usage record began has used it in ways the record never saw.
 * - **Back-off.** After two teaching hints are dismissed the next thing on a
 *   teaching surface is the offer to switch them off, made once.
 * - **The off switch** (Settings › Appearance) silences tips and teaching, and
 *   leaves situational hints as their bare action buttons.
 *
 * Persisted state is the `User` preference `juggler-guidance`
 * (`{off?, dismissed, started, teachDismissals, offered?}`) and the `Project`
 * preference of the same name (`{dismissed}`).
 * @module services/guidance/nudge-engine
 */

import keyShortcutManager from '../key-shortcut-manager.js';
import {
  cachedUserPref, setUserPref, cachedProjectPref, setProjectPref, notifyPrefChanged, reconcilePref,
} from '../prefs.js';
import { NUDGES } from './nudge-catalogue.js';
import { usage } from './usage-signals.js';
import { facts as appFacts } from './facts.js';

/** @typedef {import('./nudge-catalogue.js').NudgeEntry} NudgeEntry */
/** @typedef {import('./nudge-catalogue.js').NudgeContext} NudgeContext */
/** @typedef {import('./nudge-catalogue.js').NudgeAction} NudgeAction */

/** The preference name, in both the user and the project realm. */
const PREF_NAME = 'juggler-guidance';

/** The preference an older build kept the tips switch in. */
const LEGACY_TIPS_PREF = 'juggler-tips';

/** Fired on `window` when guidance state changes, here or in another window. */
export const GUIDANCE_CHANGED_EVENT = 'juggler:guidance-changed';

/** The least time between two teaching hints starting. */
export const TEACH_GAP_MS = 24 * 60 * 60 * 1000;

/** How long a teaching hint stays up, from when it was first shown. */
export const TEACH_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

/** Teaching dismissals that bring the offer to switch them off. */
const BACK_OFF_AFTER = 2;

/**
 * @typedef {object} UserGuidanceState
 * @property {true} [off] - Tips and teaching hints are switched off.
 * @property {Record<string, number>} dismissed - id → when.
 * @property {Record<string, number>} started - teaching id → when first shown.
 * @property {number} teachDismissals - Teaching hints the user has closed.
 * @property {true} [offered] - The off-switch offer has been answered.
 */

/**
 * A hint to draw.
 * @typedef {object} Nudge
 * @property {string} id - The catalogue entry's id.
 * @property {NudgeEntry['kind']} kind - The entry's kind.
 * @property {string} [title] - English.
 * @property {string} body - English.
 * @property {NudgeAction[]} actions - Its buttons.
 * @property {boolean} compact - Draw only the actions.
 */

/**
 * @typedef {object} NudgeEngine
 * @property {(surface: string, ctx: NudgeContext) => Nudge|null} nudgeFor - The one hint for a surface now.
 * @property {(id: string) => void} noteShown - A view drew it: start a teaching hint's clock.
 * @property {(id: string, ctx: NudgeContext) => void} dismiss - The user closed it.
 * @property {(action: NudgeAction) => void} runAction - Carry out a built-in action.
 * @property {() => boolean} shown - Whether tips and teaching hints are on.
 * @property {(on: boolean) => void} setShown - Switch them on or off.
 * @property {(id: string) => boolean} isTipLearnt - Whether a tip has been learnt by doing.
 */

/**
 * @param {any} raw
 * @returns {UserGuidanceState} A well-formed state.
 */
function normaliseUser(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    ...(r.off === true ? { off: true } : {}),
    dismissed: r.dismissed && typeof r.dismissed === 'object' ? { ...r.dismissed } : {},
    started: r.started && typeof r.started === 'object' ? { ...r.started } : {},
    teachDismissals: Number(r.teachDismissals) || 0,
    ...(r.offered === true ? { offered: true } : {}),
  };
}

/**
 * The first guidance state for someone who had the older tips preference:
 * its off switch carries over (its seen set is the usage record's business).
 * @param {any} legacyTips - The raw `juggler-tips` value.
 * @returns {UserGuidanceState|null} The seeded state, or null with nothing to carry.
 */
export function migrateLegacyGuidance(legacyTips) {
  if (!legacyTips || typeof legacyTips !== 'object') return null;
  return normaliseUser(legacyTips.off === true ? { off: true } : {});
}

/**
 * An engine over a catalogue, usage and storage the caller supplies. The app
 * has one (the exports below); tests make their own.
 * @param {object} opts
 * @param {ReadonlyArray<NudgeEntry>} opts.catalogue
 * @param {{count: (e: string) => number, any: (p: string) => boolean, isVeteran: () => boolean}} opts.usage
 * @param {{load: () => any, save: (s: any) => void}} opts.user - The user-realm state.
 * @param {{load: () => any, save: (s: any) => void}} opts.project - The project-realm state.
 * @param {{get: (name: string, key: string|undefined) => any}} [opts.facts] - What the page has found out.
 * @param {() => number} [opts.now]
 * @param {() => void} [opts.onChange]
 * @returns {NudgeEngine} The engine.
 */
export function createNudgeEngine({ catalogue, usage: u, user, project, facts = { get: () => undefined }, now = Date.now, onChange = () => {} }) {
  /** Conversation-scoped dismissals: `${id}\n${conversationId}` → when. Page-lived. */
  const conversationDismissed = new Map();

  const readUser = () => normaliseUser(user.load());
  /** @returns {{dismissed: Record<string, number>}} The project state. */
  const readProject = () => {
    const raw = project.load();
    return { dismissed: raw && typeof raw.dismissed === 'object' && raw.dismissed ? { ...raw.dismissed } : {} };
  };
  /** @param {UserGuidanceState} s */
  const writeUser = (s) => { user.save(s); onChange(); };

  /**
   * @param {NudgeEntry} entry
   * @returns {boolean} Whether usage has retired it.
   */
  const retired = (entry) => (entry.retireOn ?? []).some((e) => (e.endsWith(':*') ? u.any(e.slice(0, -1)) : u.count(e) > 0));

  /**
   * @param {number|undefined} at - When it was dismissed.
   * @param {NudgeEntry} entry
   * @returns {boolean} Whether that dismissal still holds.
   */
  const holds = (at, entry) => typeof at === 'number' && (entry.cooldownMs === undefined || now() - at < entry.cooldownMs);

  /**
   * @param {NudgeEntry} entry
   * @param {NudgeContext} ctx
   * @param {UserGuidanceState} state
   * @returns {boolean} Whether a dismissal covers it here.
   */
  const dismissed = (entry, ctx, state) => {
    switch (entry.scope ?? 'user') {
      case 'conversation': return holds(conversationDismissed.get(`${entry.id}\n${ctx.conversationId ?? ''}`), entry);
      case 'project': return holds(readProject().dismissed[entry.id], entry);
      default: return holds(state.dismissed[entry.id], entry);
    }
  };

  /**
   * @param {NudgeEntry} entry
   * @param {boolean} compact
   * @returns {Nudge} What the view draws.
   */
  const materialise = (entry, compact) => ({
    id: entry.id,
    kind: entry.kind,
    ...(entry.title ? { title: entry.title } : {}),
    body: entry.body,
    actions: entry.actions ?? [],
    compact,
  });

  /**
   * @param {UserGuidanceState} state
   * @returns {boolean} Whether teaching is backing off for the offer.
   */
  const offerDue = (state) => state.teachDismissals >= BACK_OFF_AFTER && !state.offered && state.off !== true;

  /**
   * @param {NudgeEntry} entry
   * @param {UserGuidanceState} state
   * @returns {boolean} Whether the teaching rules let it show.
   */
  const teachable = (entry, state) => {
    if (state.off === true || u.isVeteran() || offerDue(state)) return false;
    const t = now();
    const started = state.started[entry.id];
    if (typeof started === 'number') return t - started <= TEACH_LIFETIME_MS;
    return !Object.entries(state.started).some(([id, at]) => id !== entry.id && t - at < TEACH_GAP_MS);
  };

  return {
    /**
     * The one hint for a surface now, or null.
     * @param {string} surface
     * @param {NudgeContext} ctx
     * @returns {Nudge|null} The hint to draw.
     */
    nudgeFor(surface, ctx) {
      if (ctx.turnActive) return null;
      const state = readUser();
      for (const entry of catalogue) {
        if (entry.surface !== surface || entry.kind === 'tip') continue;
        if (entry.kind === 'offer') {
          if (offerDue(state)) return materialise(entry, false);
          continue;
        }
        if (retired(entry) || dismissed(entry, ctx, state)) continue;
        if (entry.kind === 'teach' && !teachable(entry, state)) continue;
        if (!entry.when?.(ctx, /** @type {any} */ (u), facts)) continue;
        const compact = entry.kind === 'situational' && (state.off === true || entry.compactWhen?.(/** @type {any} */ (u)) === true);
        return materialise(entry, compact);
      }
      return null;
    },

    /**
     * A view drew this hint: start a teaching hint's clock.
     * @param {string} id
     * @returns {void}
     */
    noteShown(id) {
      const entry = catalogue.find((e) => e.id === id);
      if (entry?.kind !== 'teach') return;
      const state = readUser();
      if (typeof state.started[id] === 'number') return;
      state.started[id] = now();
      writeUser(state);
    },

    /**
     * The user closed this hint.
     * @param {string} id
     * @param {NudgeContext} ctx
     * @returns {void}
     */
    dismiss(id, ctx) {
      const entry = catalogue.find((e) => e.id === id);
      if (!entry) return;
      if (entry.kind === 'offer') {
        // Closing the offer is declining it: keep the hints, and ask no more.
        const state = readUser();
        state.offered = true;
        writeUser(state);
        return;
      }
      const scope = entry.scope ?? 'user';
      if (scope === 'conversation') {
        conversationDismissed.set(`${id}\n${ctx.conversationId ?? ''}`, now());
        onChange();
        return;
      }
      if (scope === 'project') {
        const p = readProject();
        p.dismissed[id] = now();
        project.save(p);
        onChange();
        return;
      }
      const state = readUser();
      state.dismissed[id] = now();
      if (entry.kind === 'teach') state.teachDismissals++;
      writeUser(state);
    },

    /**
     * Carry out a built-in action (the view runs commands itself).
     * @param {NudgeAction} action
     * @returns {void}
     */
    runAction(action) {
      if (action.run === 'turn-off-guidance') {
        const state = readUser();
        state.offered = true;
        state.off = true;
        writeUser(state);
      } else if (action.run === 'keep-guidance') {
        const state = readUser();
        state.offered = true;
        writeUser(state);
      }
    },

    /** @returns {boolean} Whether tips and teaching hints are on. */
    shown() { return readUser().off !== true; },

    /**
     * Switch tips and teaching hints on or off.
     * @param {boolean} on
     * @returns {void}
     */
    setShown(on) {
      const state = readUser();
      if (on) delete state.off; else state.off = true;
      writeUser(state);
    },

    /**
     * @param {string} id - A tip's id.
     * @returns {boolean} Whether it has been learnt by doing.
     */
    isTipLearnt(id) {
      const entry = catalogue.find((e) => e.id === id);
      return !!entry && retired(entry);
    },
  };
}

const appEngine = createNudgeEngine({
  catalogue: NUDGES,
  usage,
  facts: appFacts,
  user: {
    load: () => cachedUserPref(PREF_NAME, null) ?? migrateLegacyGuidance(cachedUserPref(LEGACY_TIPS_PREF, null)),
    save: (s) => { void setUserPref(PREF_NAME, s); },
  },
  project: {
    load: () => cachedProjectPref(PREF_NAME, null),
    save: (s) => { void setProjectPref(PREF_NAME, s); },
  },
  onChange: () => notifyPrefChanged(GUIDANCE_CHANGED_EVENT),
});

/**
 * @param {string} surface
 * @param {NudgeContext} ctx
 * @returns {Nudge|null} The one hint for that surface now.
 */
export function nudgeFor(surface, ctx) { return appEngine.nudgeFor(surface, ctx); }

/**
 * @param {string} id
 * @returns {void}
 */
export function noteNudgeShown(id) { appEngine.noteShown(id); }

/**
 * @param {string} id
 * @param {NudgeContext} ctx
 * @returns {void}
 */
export function dismissNudge(id, ctx) { appEngine.dismiss(id, ctx); }

/**
 * @param {NudgeAction} action
 * @returns {void}
 */
export function runGuidanceAction(action) { appEngine.runAction(action); }

/** @returns {boolean} Whether tips and teaching hints are on (Settings › Appearance). */
export function guidanceShown() { return appEngine.shown(); }

/**
 * @param {boolean} on
 * @returns {void}
 */
export function setGuidanceShown(on) { appEngine.setShown(on); }

/**
 * @param {string} id
 * @returns {boolean} Whether a tip has been learnt by doing.
 */
export function isTipLearnt(id) { return appEngine.isTipLearnt(id); }

/**
 * A tip ready for display.
 * @typedef {object} Tip
 * @property {string} id - The catalogue entry's id.
 * @property {'shortcut'|'feature'} kind - Shortcut tips render a live key glyph.
 * @property {string} title - English; the view translates it.
 * @property {string} body - English; the view translates it.
 * @property {string} [shortcutId] - The KeyShortcutManager id, formatted live by the view.
 */

/**
 * Every tip in priority order, with shortcut titles read live from the
 * shortcut table. A tip for a shortcut not bound on this platform is dropped:
 * it exists to teach a keystroke, and there is none to teach.
 * @returns {Tip[]} The tips.
 */
export function allTips() {
  /** @type {Tip[]} */
  const tips = [];
  for (const entry of NUDGES) {
    if (entry.kind !== 'tip') continue;
    if (!entry.shortcutId) {
      tips.push({ id: entry.id, kind: 'feature', title: entry.title ?? '', body: entry.body });
      continue;
    }
    const def = keyShortcutManager.all().find((d) => d.id === entry.shortcutId);
    if (!def || keyShortcutManager.getBindings(entry.shortcutId).length === 0) continue;
    tips.push({ id: entry.id, kind: 'shortcut', title: def.label, body: entry.body, shortcutId: entry.shortcutId });
  }
  return tips;
}

// Ask for this person's (and this project's) state at boot. Reads are
// synchronous from the cache by design: a hint drawn from slightly stale state
// costs less than one that cannot draw until a round trip finishes.
if (typeof document !== 'undefined') {
  void reconcilePref('user', PREF_NAME, GUIDANCE_CHANGED_EVENT);
  void reconcilePref('user', LEGACY_TIPS_PREF, GUIDANCE_CHANGED_EVENT);
  void reconcilePref('project', PREF_NAME, GUIDANCE_CHANGED_EVENT).catch(() => {});
}
