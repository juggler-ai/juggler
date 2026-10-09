//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * When a hook runs.
 * - `beforeTool` — after the call's input has validated, before the approval
 *   decision. May rule on the call, or add a note.
 * - `afterTool` — after the tool has run, before its result is written. May
 *   add a note for the model, or mark the call failed.
 * @typedef {'beforeTool'|'afterTool'} HookEvent
 */

/**
 * Which calls a hook is offered. Every field narrows; an absent field matches
 * everything. The runtime applies it before calling the hook, so a hook never
 * pays for, or sees, a call it did not ask for — and the catalog can show
 * exactly what each hook fires on.
 * @typedef {object} HookMatch
 * @property {string[]} [tools] - Tool names (as the model calls them, e.g. `bash`). Absent = every tool.
 * @property {string} [input] - JavaScript regular expression (source, case-insensitive) tested against the call's input as JSON.
 * @property {string} [result] - Regular expression tested against the result text the model would see. `afterTool` only.
 * @property {boolean} [isError] - Only failed (`true`) or only successful (`false`) calls. `afterTool` only.
 */

/**
 * Hook manifest — static metadata describing a hook plugin.
 * @typedef {object} HookManifest
 * @property {string} id - Unique hook identifier (kebab-case, e.g. 'nono-denial')
 * @property {string} name - Human-readable display name
 * @property {string} version - Semantic version
 * @property {string} description - What the hook does, in one sentence. Shown in the catalog and in every tool card it acts on.
 * @property {string} [author] - Who wrote it
 * @property {string[]} events - The events the hook implements, each a {@link HookEvent}.
 *   Typed as plain strings so an object literal type-checks without a cast;
 *   {@link validateHookManifest} rejects anything else at load.
 * @property {HookMatch} [match] - Which calls it is offered
 * @property {string} [repeat] - `'always'` or `'once-per-thread'`. `once-per-thread` drops the
 *   hook's note when an earlier call in the same thread already carries one from
 *   it, so standing guidance is said once rather than after every matching call.
 *   Verdicts are never deduplicated. Default `always`.
 * @property {number} [timeoutMs] - How long the runtime waits for the hook.
 *   Defaults: 2000 before a tool, 5000 after. Capped at {@link MAX_BEFORE_TOOL_TIMEOUT_MS}
 *   and {@link MAX_AFTER_TOOL_TIMEOUT_MS}.
 * @property {string} [onError] - `'open'` or `'closed'`: what a `beforeTool` hook that throws or
 *   times out means: `open` (default) lets the call proceed as if the hook had not
 *   run; `closed` parks it for the user, as an `ask` would. An `afterTool` hook
 *   always fails open — the call has already happened.
 */

/**
 * What a `beforeTool` hook is told.
 * @typedef {object} BeforeToolContext
 * @property {string} toolName - The tool being called
 * @property {Record<string, unknown>} toolInput - The call's input (a plain copy; changing it changes nothing)
 * @property {string} toolUseId - The call's id
 * @property {string} conversationId - The conversation it belongs to
 * @property {string} threadId - The thread it belongs to (the conversation id for the root thread)
 * @property {AbortSignal} signal - Aborted when the runtime stops waiting (timeout)
 */

/**
 * What a `beforeTool` hook may answer. Anything else (including nothing) means
 * "no opinion".
 * - `deny` — refuse the call. `reason` becomes the error result the model sees.
 * - `ask` — the user must approve this call, whatever the strategy or saved
 *   rules would have done. `reason` is shown in the approval card.
 * - `allow` — approve it without asking, as a saved permission rule would. Never
 *   overrides a strategy that requires approval, and never applies to a call that
 *   must reach a human (a question for the user, a plan submit, a catastrophic
 *   delete).
 *
 * When hooks disagree, deny beats ask beats allow.
 * @typedef {object} BeforeToolOutcome
 * @property {'deny'|'ask'|'allow'} [verdict] - The ruling, if any
 * @property {string} [reason] - Why, for a verdict
 * @property {string} [note] - Text added to this call's result for the model, if the call runs
 */

/**
 * What an `afterTool` hook is told.
 * @typedef {object} AfterToolContext
 * @property {string} toolName - The tool that ran
 * @property {Record<string, unknown>} toolInput - Its input
 * @property {string} toolUseId - The call's id
 * @property {string} conversationId - The conversation it belongs to
 * @property {string} threadId - The thread it belongs to
 * @property {{content: string, isError: boolean}} result - The result exactly as the model will see it, before any hook's note
 * @property {AbortSignal} signal - Aborted when the call is cancelled or the runtime stops waiting
 */

/**
 * What an `afterTool` hook may answer. Anything else (including nothing) means
 * the hook had nothing to add.
 * @typedef {object} AfterToolOutcome
 * @property {string} [note] - Text added to the result for the model, after the tool's own output
 * @property {boolean} [markError] - Report the call as failed (e.g. a linter rejected what was just written)
 */

/** @type {readonly HookEvent[]} */
export const HOOK_EVENTS = Object.freeze(['beforeTool', 'afterTool']);

/** @type {readonly string[]} */
export const HOOK_VERDICTS = Object.freeze(['deny', 'ask', 'allow']);

/**
 * Default and ceiling for how long a `beforeTool` hook is waited for. Kept well
 * under the worker's five-second re-drive of an unanswered tool command, so a
 * slow hook never makes the call be evaluated twice.
 */
export const DEFAULT_BEFORE_TOOL_TIMEOUT_MS = 2000;
export const MAX_BEFORE_TOOL_TIMEOUT_MS = 3000;

/**
 * Default and ceiling for how long an `afterTool` hook is waited for. The call
 * reads as still running meanwhile, so this is time the user watches.
 */
export const DEFAULT_AFTER_TOOL_TIMEOUT_MS = 5000;
export const MAX_AFTER_TOOL_TIMEOUT_MS = 30000;

/**
 * Check the hook-specific parts of a manifest, beyond the fields every
 * capability carries. Throws with a message naming the class.
 * @param {any} ctor - The hook class
 * @throws {Error} When the manifest cannot be acted on as written
 */
export function validateHookManifest(ctor) {
  validateManifest(ctor);
  const className = ctor?.name || 'Hook';
  /** @type {HookManifest} */
  const manifest = ctor.MANIFEST;
  const events = manifest.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`${className}.MANIFEST.events must list at least one of: ${HOOK_EVENTS.join(', ')}`);
  }
  for (const event of events) {
    if (!HOOK_EVENTS.includes(/** @type {HookEvent} */ (event))) {
      throw new Error(`${className}.MANIFEST.events has unknown event "${event}" (known: ${HOOK_EVENTS.join(', ')})`);
    }
    const method = /** @type {HookEvent} */ (event);
    if (typeof ctor.prototype[method] !== 'function' || ctor.prototype[method] === HookType.prototype[method]) {
      throw new Error(`${className} declares the "${event}" event but does not implement ${event}()`);
    }
  }
  const match = manifest.match || {};
  if (match.tools !== undefined && (!Array.isArray(match.tools) || match.tools.some(t => typeof t !== 'string' || !t))) {
    throw new Error(`${className}.MANIFEST.match.tools must be an array of tool names`);
  }
  for (const key of /** @type {const} */ (['input', 'result'])) {
    if (match[key] === undefined) continue;
    try {
      new RegExp(String(match[key]), 'i');
    } catch (err) {
      throw new Error(`${className}.MANIFEST.match.${key} is not a valid regular expression: ${/** @type {Error} */ (err).message}`, { cause: err });
    }
  }
  if ((match.result !== undefined || match.isError !== undefined) && !events.includes('afterTool')) {
    throw new Error(`${className}.MANIFEST.match.result and match.isError apply only to the afterTool event`);
  }
  if (manifest.repeat !== undefined && manifest.repeat !== 'always' && manifest.repeat !== 'once-per-thread') {
    throw new Error(`${className}.MANIFEST.repeat must be "always" or "once-per-thread"`);
  }
  if (manifest.onError !== undefined && manifest.onError !== 'open' && manifest.onError !== 'closed') {
    throw new Error(`${className}.MANIFEST.onError must be "open" or "closed"`);
  }
  if (manifest.timeoutMs !== undefined && !(Number.isFinite(manifest.timeoutMs) && manifest.timeoutMs > 0)) {
    throw new Error(`${className}.MANIFEST.timeoutMs must be a positive number of milliseconds`);
  }
}

// ============================================================================
// HookType Base Class
// ============================================================================

/**
 * HookType - base class for tool hooks.
 *
 * A hook is policy or observation that runs around every tool call, whichever
 * strategy is active and however many other hooks are installed. Strategies set
 * how autonomous the agent is; hooks say what is true regardless — "never touch
 * `migrations/` without asking", "when the sandbox refuses something, say how to
 * diagnose it".
 *
 * Hooks run only in the engine, where tools run — never in a viewer tab — once
 * per call. Everything a hook does is recorded on the call itself and shown in
 * its card, and a note it adds is sent inside that call's result, so the
 * transcript always holds exactly what the model was told.
 *
 * Declare the events you handle and which calls you want in `static MANIFEST`,
 * then implement the matching method(s). Both may be async; both are bounded by
 * a timeout and receive an AbortSignal.
 *
 * ```javascript
 * import HookType from 'juggler/hook-type';
 *
 * export default class NonoDenialHook extends HookType {
 *   static MANIFEST = {
 *     id: 'nono-denial',
 *     name: 'nono denial diagnostics',
 *     version: '1.0.0',
 *     description: 'Tells the model how to diagnose a nono sandbox denial',
 *     events: ['afterTool'],
 *     match: { result: 'Operation not permitted|EPERM|EACCES' },
 *     repeat: 'once-per-thread'
 *   };
 *
 *   afterTool({ toolName, result }) {
 *     return { note: 'The nono sandbox may have denied that. Run `nono why <path>` to check, ' +
 *       'and offer to update the profile if the access is needed.' };
 *   }
 * }
 * ```
 *
 * Method reference:
 * - `beforeTool(ctx: BeforeToolContext) → BeforeToolOutcome|void` (may be async)
 * - `afterTool(ctx: AfterToolContext) → AfterToolOutcome|void` (may be async)
 * @class
 * @abstract
 */
class HookType {
  /**
   * Hook manifest (static property set by subclasses)
   * @type {HookManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === HookType) {
      throw new Error('HookType is an abstract class and cannot be instantiated directly');
    }
    validateHookManifest(this.constructor);
  }

  /**
   * Called before a matching tool call is approved. Override when `events`
   * includes `beforeTool`.
   * @param {BeforeToolContext} _ctx - The call
   * @returns {BeforeToolOutcome|void|Promise<BeforeToolOutcome|void>} A ruling, a note, or nothing
   */
  beforeTool(_ctx) {}

  /**
   * Called after a matching tool call has run, before its result is written.
   * Override when `events` includes `afterTool`.
   * @param {AfterToolContext} _ctx - The call and its result
   * @returns {AfterToolOutcome|void|Promise<AfterToolOutcome|void>} A note, a failure mark, or nothing
   */
  afterTool(_ctx) {}
}

export default HookType;
