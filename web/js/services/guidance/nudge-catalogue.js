//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The nudge catalogue — every piece of guidance the app can show, in one list.
 *
 * Guidance comes in four kinds, and the kind decides the rules the engine
 * ({@link module:services/guidance/nudge-engine}) applies:
 * - `tip` — a feature someone is unlikely to stumble on, in the rolling strip
 *   under a new conversation's starting hint. Every tip stays in the rotation;
 *   one whose `retireOn` usage has happened is just not opened on.
 * - `teach` — a hint about the person ("you haven't found X"). At most one new
 *   one a day, it lapses after a few days, never shown to someone who used the
 *   app before usage was recorded, and silenced by the off switch.
 * - `situational` — a hint about the state in front of them ("this conversation
 *   is long"). Useful to experts too, so the off switch only strips its copy and
 *   leaves its action buttons; `compactWhen` does the same for someone who
 *   plainly knows already.
 * - `offer` — the engine's own question, after two teaching hints have been
 *   closed, whether to switch them off.
 *
 * ## Adding guidance
 *
 * Add an entry here, and nothing anywhere else:
 * 1. Pick a `surface` (see {@link SURFACES}): where the user is when the hint
 *    is true, and where its action belongs.
 * 2. Write `when(ctx, usage, facts)` over what that surface passes in `ctx`
 *    (see {@link NudgeContext}), the read-only usage record and the page's
 *    facts (services/guidance/facts.js) — never a fetch, a DOM query or a timer
 *    of its own. A fact nothing reports yet is reported, once, by the code that
 *    already knows it, with `reportFact`.
 * 3. Name the usage that makes the hint redundant in `retireOn` — normally the
 *    very command or shortcut it suggests, so taking the hint's advice retires
 *    it with no code at all. If the usage you need is not recorded yet, add it at
 *    its choke point with `recordUsage` (services/guidance/usage-signals.js).
 * 4. Give it actions that do the thing: a `command` (run exactly as if typed,
 *    so it records its own use) or a `run` the view knows (see
 *    components/juggler-nudge.js).
 *
 * Feature code never shows, hides or retires guidance itself;
 * `TestGuidanceStaysCentral` (cmd/juggler/server) fails if it starts to.
 *
 * Strings are English and marked for translation; the view translates them.
 * @module services/guidance/nudge-catalogue
 */

import { markForTranslation } from '../../../sdk/lib/i18n.js';

/** Where guidance can be shown. Each is one `<juggler-nudge>` mount. */
export const SURFACES = Object.freeze([
  'empty-hint', // the starting hint of a conversation with no history yet
  'footer',     // the footer of a conversation's thread, beside the context meter
]);

/**
 * A conversation counts as long at this fraction of its context window, or at
 * {@link LONG_CONVERSATION_TOKENS}, whichever comes first: on a million-token
 * window 70% is 700k, far past where every turn has become slow and costly.
 */
export const LONG_CONVERSATION_FRACTION = 0.7;

/** A conversation this size counts as long whatever its window. */
export const LONG_CONVERSATION_TOKENS = 400_000;

/** The kinds of guidance; see the module header. */
export const KINDS = Object.freeze(['tip', 'teach', 'situational', 'offer']);

/**
 * What a surface tells the rules about where it is.
 * @typedef {object} NudgeContext
 * @property {string} [conversationId] - The conversation on screen.
 * @property {any} [thread] - Its MessageThread, which actions run against.
 * @property {boolean} [turnActive] - A turn is running there; nothing is shown.
 * @property {{total: number, budget: number}} [tokens] - The context meter's reading (footer).
 * @property {Record<string, any>} [facts] - Anything else the surface knows.
 */

/**
 * A button on a hint.
 * @typedef {object} NudgeAction
 * @property {string} label - English; the view translates it.
 * @property {string} [command] - A slash command id, run against `ctx.thread`.
 * @property {'turn-off-guidance'|'keep-guidance'|'dismiss'|'open-slash-menu'} [run] - A built-in action.
 */

/**
 * One entry.
 * @typedef {object} NudgeEntry
 * @property {string} id - Stable; the key its dismissal is stored under.
 * @property {'tip'|'teach'|'situational'|'offer'} kind - Which rules apply (see the module header).
 * @property {string} surface - One of {@link SURFACES}.
 * @property {string} [title] - English headline. A shortcut tip reads its title from the shortcut table.
 * @property {string} body - English, one or two sentences.
 * @property {string} [shortcutId] - For a tip teaching a key: the KeyShortcutManager id.
 * @property {string[]} [retireOn] - Usage events any of which retire it for good (`slash:*`: any command).
 * @property {(ctx: NudgeContext, usage: import('./usage-signals.js').UsageView, facts: import('./facts.js').FactsView) => boolean} [when] - Whether it applies now.
 * @property {(usage: import('./usage-signals.js').UsageView) => boolean} [compactWhen] - Show only the actions.
 * @property {'user'|'project'|'conversation'} [scope] - What a dismissal covers (default `user`).
 * @property {number} [cooldownMs] - A dismissal lapses after this long; absent, it is for good.
 * @property {NudgeAction[]} [actions] - Its buttons, in order.
 */

/**
 * A shortcut tip: title and key glyph come from the shortcut table, so they
 * cannot drift from the real (rebindable) binding; it is learnt by using it.
 * @param {string} id - The KeyShortcutManager id.
 * @param {string} body
 * @returns {NudgeEntry} The tip.
 */
function shortcutTip(id, body) {
  return { id, kind: 'tip', surface: 'empty-hint', shortcutId: id, body, retireOn: [`shortcut:${id}`] };
}

/**
 * Every entry. Order is priority: tips rotate in this order, and a surface
 * shows the first nudge whose rules allow it.
 *
 * Tips lead with what makes Juggler different (several conversations at once,
 * and moving between them), then the composer controls reached for every turn,
 * then the occasional ones. None repeats what the starting hint already says
 * above the strip (send, new line, @ to reference a file, / for commands,
 * drag-and-drop), and a pair of twin commands gets one tip, not two.
 * @type {ReadonlyArray<NudgeEntry>}
 */
export const NUDGES = Object.freeze([
  shortcutTip('new-conversation', markForTranslation('Spin up another conversation and switch to it — run several in parallel.')),
  shortcutTip('jump-to-attention', markForTranslation('Jump straight to whichever conversation is waiting on you, landing on its pending approval.')),
  shortcutTip('strategy-switch', markForTranslation('Flip the active strategy from the composer; hold to open the full strategy menu.')),
  shortcutTip('cycle-model', markForTranslation('Tap to flip back to your previous model; hold to open the full model menu — no mouse needed.')),
  {
    id: 'workspaces',
    kind: 'tip',
    surface: 'empty-hint',
    title: markForTranslation('Workspaces'),
    body: markForTranslation('A workspace is a custom environment for the LLM to work in — e.g. a git worktree, or a copy to try '
      + 'something risky in. Make one at the foot of the conversation list, then start '
      + 'conversations in it or drag them across.'),
  },
  shortcutTip('toggle-file-editing', markForTranslation('Flip between letting the agent edit files freely and asking you first.')),
  shortcutTip('pause-conversation', markForTranslation('Pause after the current step finishes — a non-destructive stop, instead of a hard cancel.')),
  shortcutTip('next-tab', markForTranslation('Step through your conversation list without leaving the keyboard; Previous conversation steps back.')),
  shortcutTip('cycle-thinking', markForTranslation('Nudge the current model\u2019s thinking level up or down; hold to open the level popover.')),
  shortcutTip('find-in-conversation', markForTranslation('Search the text of whatever you\u2019re reading — the conversation, a properties panel, a pin.')),
  {
    id: 'paste-images',
    kind: 'tip',
    surface: 'empty-hint',
    title: markForTranslation('Paste a screenshot'),
    body: markForTranslation('Paste an image straight into the composer to attach it to your prompt.'),
  },
  shortcutTip('rename-conversation', markForTranslation('Give the current conversation a memorable name, straight from the keyboard.')),
  shortcutTip('bin-conversation', markForTranslation('Clear a conversation out of the way — you can restore it from the Bin anytime.')),

  // A long conversation costs more every turn and the model reads it less
  // well, auto-compaction or not. About this conversation, so its dismissal is
  // too; never retired, because knowing about /compact does not make a
  // conversation short — once they have compacted or handed off, the buttons
  // stand alone. The root thread only: a hand-off takes the whole conversation.
  {
    id: 'long-conversation',
    kind: 'situational',
    surface: 'footer',
    scope: 'conversation',
    title: markForTranslation('This conversation is getting long.'),
    body: markForTranslation('Compact it to fold the older turns into a summary, or hand off to a new conversation that starts from one.'),
    when: (ctx) => !ctx.thread?.threadItemId && !!ctx.tokens
      && (ctx.tokens.total >= LONG_CONVERSATION_TOKENS
        || (ctx.tokens.budget > 0 && ctx.tokens.total / ctx.tokens.budget >= LONG_CONVERSATION_FRACTION)),
    compactWhen: (usage) => usage.count('slash:compact') > 0 || usage.count('slash:handoff') > 0,
    actions: [
      { label: markForTranslation('Compact'), command: 'compact' },
      { label: markForTranslation('Hand off'), command: 'handoff' },
    ],
  },

  // Someone who has been using the app for a while and has never once run a
  // command has not found the / menu. Any command at all retires it.
  {
    id: 'slash-commands',
    kind: 'teach',
    surface: 'footer',
    title: markForTranslation('Slash commands'),
    body: markForTranslation('Type / in the composer for commands: compact a long conversation, hand it off, start a sub-thread \u2014 or save a prompt you repeat as a command of your own.'),
    retireOn: ['slash:*'],
    when: (ctx, usage) => !ctx.thread?.threadItemId
      && usage.count('composer:send') >= 10 && usage.days('composer:send') >= 2,
    actions: [{ label: markForTranslation('Show commands'), run: 'open-slash-menu' }],
  },

  // A project with no agent instruction file at all (the seeder found none of
  // AGENTS.md, CLAUDE.md, …) is offered help writing one — not on someone's
  // first day, and "not for this project" means exactly that. Not retired by
  // /init: drafting one here says nothing about the next project.
  {
    id: 'instruction-file',
    kind: 'situational',
    surface: 'empty-hint',
    scope: 'project',
    title: markForTranslation('No AGENTS.md in this project.'),
    body: markForTranslation('An AGENTS.md tells the agent how this project builds, tests and is laid out, so you don\u2019t have to say it again in every conversation.'),
    when: (ctx, usage, facts) => facts.get('instruction-files', ctx.conversationId) === 0
      && usage.days('composer:send') >= 2,
    actions: [
      { label: markForTranslation('Draft one'), command: 'init' },
      { label: markForTranslation('Not for this project'), run: 'dismiss' },
    ],
  },

  {
    id: 'guidance-off-offer',
    kind: 'offer',
    surface: 'footer',
    title: markForTranslation('Fewer hints?'),
    body: markForTranslation('You\u2019ve closed a couple of hints. Switch them off? You can turn them back on in Settings \u203a Appearance.'),
    actions: [
      { label: markForTranslation('Switch hints off'), run: 'turn-off-guidance' },
      { label: markForTranslation('Keep them'), run: 'keep-guidance' },
    ],
  },
]);
