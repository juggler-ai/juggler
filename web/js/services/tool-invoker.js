//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The tool invoker: how a program tool's `tools.*` calls run.
 *
 * A sub-call is not a tool-action. Nothing is written to the transcript; the
 * engine runs the tool here, through the same execute path a tool-action takes
 * (`actionExecutor.execute`), and the program's own item keeps a bounded record
 * of what was called. Every call is first put to the real approval decision
 * (`decideToolCall`), so the user's rules, hooks and strategy rule on it as
 * they would on the model's own call:
 *   - "approve" runs it;
 *   - "park" holds the call for the user (`waitForUser`): the program's item
 *     waits on them with the call's own approval form, as a parked call does,
 *     while the program lives on, waiting on that call (services/held-calls.js).
 *     Their answer runs it; an answer that was not theirs to give it (the item
 *     was reset and approved on its own account) puts it to the decision
 *     again. Holds take turns, so the item asks one thing at a time. Without
 *     `waitForUser` a park refuses, as a deny does;
 *   - "deny" (a hook said no) refuses, and the program ends;
 *   - "invalid" is an error the program may catch.
 *
 * The rules the invoker keeps:
 *   - Admission. A call to a tool the thread was not offered, or to one that
 *     stays native (it delegates, writes the thread, or is bookkeeping the model
 *     should do in the open), is refused before anything runs, in the worker's
 *     own words for a tool the model was not given.
 *   - Order. Calls keep the program's order the way a turn's calls do
 *     (cmd/juggler/worker/tool_ordering.go): reads overlap, and any other call
 *     waits for every earlier call and holds back every later one. The worker's
 *     gate sees only tool-actions, so it cannot do this for sub-calls.
 *   - A limit on calls in flight, so `Promise.all` over a list runs a few at a
 *     time instead of all at once.
 *   - Cancellation. When the program's signal aborts, every running call is
 *     cancelled through the executor and every queued call is refused.
 *   - Output. A call answers with its result text whole, not cut to the
 *     model's budget (PROGRAM_RESULT_BUDGET).
 *   - The record: name, clipped args, status, duration, error and — for calls
 *     that change something — a one-line effect. Never a result: hiding results
 *     is the point. It is bounded, and gives up reads before effects, because
 *     the effects are what the model is always told.
 * @module services/tool-invoker
 */

import actionExecutor, { toolResultContent } from './action-executor.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isComposableTool } from './composable-tools.js';
import { INTERACTION_KIND } from '../../sdk/context-item.js';
import { holdForUser, releaseHold } from './held-calls.js';

/** @typedef {import('./ops-api.js').AssetRef} AssetRef */

/** A tool ran and failed, or could not be run. A program may catch it. */
export class ToolError extends Error {
  /** @param {string} message - What went wrong */
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * The user's gate said no, or the program was interrupted. The program ends: it
 * may not catch a refusal and route around it with a variant of the call.
 */
export class ToolRefused extends Error {
  /** @param {string} message - Why the program was stopped */
  constructor(message) {
    super(message);
    this.name = 'ToolRefused';
  }
}

/**
 * What a held call needs to be put to the user: the program's item shows it in
 * its approval card, and its buttons are the sub-tool's own.
 * @typedef {object} HoldRequest
 * @property {string} name - The held tool
 * @property {Record<string, unknown>} input - Its arguments, as the program passed them
 * @property {string} reason - What it waits on, in the decision's words
 * @property {Record<string, any>} approvalOptions - Its approval form; every
 *   "don't ask again" button names the rule it saves for the sub-tool
 * @property {unknown} [displayData] - Its preview (an edit's diff)
 * @property {string} [note] - A line for the card, when a hook is holding it
 * @property {(import('../model/conversation-tool-actions.js').ReviewableCall & {label: string|null})|null} [review] -
 *   The call as the strategy's reviewer is handed it, when one may be
 *   (conversation-tool-actions.js reviewForHold); `label` marks the
 *   hold as under review when the strategy has a reviewer
 */

/**
 * Keep the buttons of an approval form that are safe on a program's card: all
 * but a "don't ask again" that names nothing to save. The program's item is
 * what the user answers, so a bare one would save a grant for the program tool
 * (saveAutoApprovalPermission's fallback) rather than for the sub-tool.
 * @param {Array<Record<string, any>>} options - The sub-tool's buttons
 * @returns {Array<Record<string, any>>} Those that remain
 */
function keepNamedGrants(options) {
  return options.filter((o) => !(typeof o.value === 'string' && o.value.startsWith('yes-always'))
    || (o.rules && o.itemType)
    || (Array.isArray(o.allowedPaths) && o.allowedPaths.length > 0));
}

/**
 * The character budget a call's output is cut to for a program, in place of
 * the conversation's. The conversation's is sized for the model's context; a
 * program reads the output to work on it, and only what it returns reaches the
 * model. Still bounded, because the program's journal holds every answer in
 * memory while it waits on the user; past it, the output ends with the usual
 * "(Output truncated …)" note, so a program can tell.
 */
const PROGRAM_RESULT_BUDGET = 2_000_000;

/** Calls running at once, by default. */
const DEFAULT_LIMIT = 4;
/** Calls kept in the record, by default. */
const DEFAULT_MAX_RECORDS = 200;
/** Longest string kept in a recorded argument. */
const MAX_ARG_CHARS = 500;
/** Longest effect line. */
const MAX_EFFECT_CHARS = 200;

/**
 * The offered tools a program may call, with each tool's class consulted.
 * @param {Array<Record<string, any>>} offered - The thread's offered tools
 * @returns {Array<Record<string, any>>} The composable subset, in the same order
 */
export function composableTools(offered) {
  return offered.filter((def) => isComposableTool(/** @type {any} */ (def), contextItemRegistry.getByToolName(def.name) || null));
}

/**
 * Clip a value for the record: strings to MAX_ARG_CHARS, nested values by the
 * same rule, so the record stays small whatever the program passed.
 * @param {unknown} value - An argument value
 * @param {number} [depth] - Nesting depth reached
 * @returns {unknown} The clipped copy
 */
function clipArg(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_ARG_CHARS ? value.slice(0, MAX_ARG_CHARS) + '…' : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '…';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => clipArg(v, depth + 1));
    return value.length > 20 ? [...head, `…${value.length - 20} more`] : head;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clipArg(v, depth + 1);
  return out;
}

/**
 * A tool name without the `mcp__<server>__` prefix a provider may list it under
 * (Claude Code lists Juggler's tools as `mcp__juggler__<name>`), so a program
 * that calls a tool by the name in the model's tool list reaches it. Only ever
 * tried when the name as given is not a tool, so a tool whose own name has that
 * shape (an MCP server's) is found as it is. run_code's describeTool looks
 * tools up by the same rule (render-sdk.js toolOwnName).
 * @param {string} name - A tool name as a program called it
 * @returns {string} The name after the prefix, or the name unchanged
 */
function unprefixed(name) {
  const match = /^mcp__.+?__(.+)$/.exec(name);
  return match ? /** @type {string} */ (match[1]) : name;
}

/**
 * The one-line effect of a call that changes something: the command it ran, or
 * the path it acted on, or failing both, its arguments in brief.
 * @param {string} name - Tool name
 * @param {Record<string, unknown>} args - Its arguments
 * @returns {string} The effect line
 */
function effectLine(name, args) {
  const pick = (/** @type {string[]} */ keys) => {
    for (const k of keys) {
      const v = args?.[k];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  };
  const target = pick(['command', 'file_path', 'path', 'url', 'name']) || JSON.stringify(args ?? {});
  const line = `${name}: ${target.replace(/\s+/g, ' ').trim()}`;
  return line.length > MAX_EFFECT_CHARS ? line.slice(0, MAX_EFFECT_CHARS) + '…' : line;
}

/**
 * @typedef {object} NestedCall
 * @property {string} name - Tool name as the program called it
 * @property {unknown} args - Its arguments, clipped
 * @property {'queued'|'running'|'ok'|'error'|'refused'|'cancelled'|'held'} status - Where it got to
 * @property {number} [durationMs] - How long it ran
 * @property {string} [error] - Why it failed or was refused
 * @property {string} [effect] - What it changed, for a call that changes things
 */

/**
 * @typedef {object} NestedCallRecord
 * @property {NestedCall[]} calls - The calls kept, in the order they were made
 * @property {number} omitted - Calls dropped to stay within the bound
 * @property {number} omittedEffects - Of those, how many changed something
 */

/**
 * @typedef {object} InvokerDeps
 * @property {() => Promise<Array<Record<string, any>>>} offeredTools - The thread's composable offered tools
 * @property {(call: {toolName: string, toolInput: Record<string, unknown>, toolUseId: string}) => Promise<{verdict: string, reason: string}>} decide - The approval decision
 * @property {(call: {toolName: string, input: Record<string, unknown>, toolUseId: string}) => Promise<{success: boolean, cancelled?: boolean, content: string, error?: string, attachments?: AssetRef[]}>} run - Run the tool
 * @property {(toolUseId: string) => void} cancel - Cancel a running call
 * @property {(call: {name: string, args: Record<string, unknown>}, decision: any) => Promise<HoldRequest>} holdRequest - A parked call, as the user is asked about it
 * @property {(toolName: string, input: Record<string, unknown>, response: string) => Record<string, unknown>} answer - Fold the user's answer into an elicitation's input
 * @property {(request: HoldRequest, signal: AbortSignal) => Promise<import('./held-calls.js').HeldAnswer>} hold - Hold a parked call for the user, until they answer or `signal` aborts
 * @property {() => void} release - Put the program's item back to running once the program has ended with a call held
 */

/**
 * The real seams: the thread's inventory, the engine's decision and executor.
 * Imported lazily, because the decision lives in the model layer, which loads
 * the executor that installs this module.
 * @param {any} conversation - The conversation
 * @param {any} messageThread - The thread the program runs in
 * @param {string} parentToolUseId - The program's own tool-action, which holds its calls
 * @returns {InvokerDeps} The seams
 */
function defaultDeps(conversation, messageThread, parentToolUseId) {
  return {
    offeredTools: async () => {
      const { buildToolInventory } = await import('./thread-tool-inventory.js');
      return composableTools((await buildToolInventory(messageThread)).offered);
    },
    decide: async (call) => {
      const { decideToolCall } = await import('../model/conversation-tool-actions.js');
      return decideToolCall({ messageThread, conversation, ...call });
    },
    run: async ({ toolName, input, toolUseId }) => {
      const ItemClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      const result = await actionExecutor.execute(ItemClass?.MANIFEST?.id || toolName, input, {
        session: conversation.session ?? conversation._session,
        conversation,
        messageThread,
        toolUseId,
        toolName,
        truncationBudget: PROGRAM_RESULT_BUDGET,
        _approvalHandled: true
      });
      // A tool's images ride its summary as asset refs, as they reach the
      // model's tool_result; the caller asks for them (invoke's withAttachments).
      const attachments = Array.isArray(result.formatted?.attachments)
        ? result.formatted.attachments.filter((/** @type {any} */ a) => a && a.id)
        : [];
      return {
        success: !!result.success,
        cancelled: !!result.cancelled,
        content: toolResultContent(result.formatted) || result.error || '',
        error: result.error,
        attachments
      };
    },
    cancel: (toolUseId) => {
      actionExecutor.cancelByToolUseId(toolUseId, conversation?.id);
    },
    // Built as the evaluate path builds a parked call's form
    // (conversation-tool-actions.js), from the decision's own action.
    holdRequest: async ({ name, args }, decision) => {
      const { buildApprovalOptions } = await import('./response-handler-actions.js');
      const { reviewForHold } = await import('../model/conversation-tool-actions.js');
      const built = buildApprovalOptions(decision.action, decision.prepared);
      return {
        name,
        input: args,
        review: reviewForHold(messageThread, decision, name, args),
        reason: decision.reason,
        approvalOptions: { ...built, options: keepNamedGrants(built.options || []) },
        displayData: decision.prepared?.displayData,
        note: decision.hookAsks ? decision.reason : undefined
      };
    },
    // As resolveFinalToolInput does for a tool-action: a gate's response is a
    // bare verdict, an elicitation's is the answer.
    answer: (toolName, input, response) => {
      const ItemClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      if (ItemClass?.interactionKind?.() !== INTERACTION_KIND.ELICITATION) return input;
      return ItemClass.applyApprovalResponse(input, response);
    },
    hold: (request, signal) => holdForUser({ conversation, messageThread, toolUseId: parentToolUseId, request, signal }),
    release: () => releaseHold(messageThread, parentToolUseId),
  };
}

/**
 * @typedef {object} InvokeHow
 * @property {boolean} [withAttachments] - Resolve `{content, attachments}`, the
 *   asset refs of any images the call produced, rather than the content alone.
 *   The record never holds either.
 * @property {unknown} [tag] - Handed to `beforeHold` if the call is held
 * @property {string} [answer] - The user's answer to this very call, already
 *   given on its card (a held call made again by a program resumed after its
 *   engine was lost): the call is run with it rather than put to the decision
 */

/**
 * Create the invoker for one run of a program.
 * @param {object} opts
 * @param {string} opts.parentToolUseId - The program's own tool-use id, the stem of its sub-calls' ids
 * @param {AbortSignal} [opts.signal] - The program's signal; aborting it cancels every call
 * @param {(err: ToolRefused) => void} [opts.onRefused] - Told once, when a refusal ends the program
 * @param {boolean} [opts.waitForUser] - Hold a call the decision parks for the
 *   user, with the program waiting on it. Without it, a park refuses.
 * @param {(request: HoldRequest, tag: unknown) => Promise<void>|void} [opts.beforeHold] -
 *   Awaited before each hold is put to the user, with the `tag` its call was
 *   made with (invoke's `how.tag`)
 * @param {() => void} [opts.afterHold] - Told when each hold has ended, answered or not
 * @param {any} [opts.conversation] - The conversation (for the default seams)
 * @param {any} [opts.messageThread] - The thread the program runs in (for the default seams)
 * @param {number} [opts.limit] - Calls running at once
 * @param {number} [opts.maxRecords] - Calls kept in the record
 * @param {Partial<InvokerDeps>} [opts.deps] - Seams to replace, for tests
 * @returns {{invoke: (name: string, args: Record<string, unknown>, how?: InvokeHow) => Promise<any>, record: NestedCallRecord, offered: () => Promise<Map<string, Record<string, any>>>, end: () => void}} The invoker
 */
export function createToolInvoker(opts) {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const maxRecords = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  const deps = { ...defaultDeps(opts.conversation, opts.messageThread, opts.parentToolUseId), ...(opts.deps || {}) };
  /** Ends every hold: the program's signal, or the program ending (end()). */
  const holds = new AbortController();
  /** The hold before the next, which waits its turn behind it. */
  let lastHold = Promise.resolve();
  /** Whether a call has been held, so the program's item may need releasing. */
  let everHeld = false;

  /** @type {NestedCallRecord} */
  const record = { calls: [], omitted: 0, omittedEffects: 0 };
  /** @type {Promise<Map<string, Record<string, any>>>|null} */
  let offeredPromise = null;
  /** @type {ToolRefused|null} */
  let refusal = null;
  let ordinal = 0;

  /**
   * @typedef {object} Pending
   * @property {string} name - Tool name
   * @property {Record<string, unknown>} args - Its arguments, unclipped
   * @property {string} toolUseId - The id it runs under in the executor
   * @property {boolean} alongside - A read: may overlap its neighbours
   * @property {{response: string}|null} approval - The user's answer it was made with (invoke's `how.answer`)
   * @property {unknown} tag - What the caller made it with (beforeHold is handed it)
   * @property {NestedCall} entry - Its record entry
   * @property {'queued'|'running'|'done'} phase - Where it is in its life
   * @property {(v: {content: string, attachments: AssetRef[]}) => void} resolve - Settles the program's await with a value
   * @property {(e: Error) => void} reject - Settles the program's await with an error
   */
  /** @type {Pending[]} */
  const calls = [];

  /**
   * Keep a call in the record, giving up a read before an effect once full.
   * @param {NestedCall} entry - The call
   */
  const keep = (entry) => {
    if (record.calls.length < maxRecords) {
      record.calls.push(entry);
      return;
    }
    record.omitted++;
    if (entry.effect === undefined) return;
    const evict = record.calls.findIndex((c) => c.effect === undefined);
    if (evict < 0) {
      record.omittedEffects++;
      return;
    }
    record.calls.splice(evict, 1);
    record.calls.push(entry);
  };

  /**
   * Settle a call, finishing its record entry.
   * @param {Pending} call
   * @param {NestedCall['status']} status
   * @param {{value?: {content: string, attachments: AssetRef[]}, error?: Error, startedAt?: number, ran?: boolean}} how -
   *   `ran`: the tool itself was run, past its decision
   */
  const settle = (call, status, how) => {
    call.phase = 'done';
    call.entry.status = status;
    if (how.startedAt !== undefined) call.entry.durationMs = Date.now() - how.startedAt;
    // A call that never ran changed nothing. One that ran keeps its effect even
    // when it failed or was interrupted: a command that exits non-zero, or is
    // stopped halfway, may still have changed the world.
    if (!how.ran) delete call.entry.effect;
    if (how.error) {
      call.entry.error = how.error.message;
      call.reject(how.error);
    } else {
      call.resolve(/** @type {{content: string, attachments: AssetRef[]}} */ (how.value));
    }
    pump();
  };

  /**
   * End the program: refuse every call not yet finished, cancel the running ones.
   * @param {ToolRefused} err - Why
   * @param {NestedCall['status']} queuedStatus - What a call that never ran is recorded as
   */
  const stopAll = (err, queuedStatus) => {
    if (!refusal) refusal = err;
    for (const call of calls) {
      if (call.phase === 'queued') {
        settle(call, queuedStatus, { error: err });
      } else if (call.phase === 'running') {
        deps.cancel(call.toolUseId);
      }
    }
  };

  /**
   * Run one call that the order and the limit have released.
   * @param {Pending} call
   * @returns {Promise<void>}
   */
  const start = async (call) => {
    call.phase = 'running';
    call.entry.status = 'running';
    const startedAt = Date.now();
    let ran = false;
    try {
      const decide = () => deps.decide({ toolName: call.name, toolInput: call.args, toolUseId: call.toolUseId });
      // A call made with the user's answer was decided by them: it is not put
      // to the decision again.
      let decision = call.approval ? { verdict: 'approve', reason: '' } : await decide();
      let response = call.approval?.response;
      while (decision.verdict === 'park' && opts.waitForUser && !refusal) {
        const answer = await holdCall(call, decision);
        if (answer.redecide) {
          decision = await decide();
        } else {
          response = answer.response;
          decision = { verdict: 'approve', reason: '' };
        }
      }
      if (refusal) {
        settle(call, 'cancelled', { error: refusal, startedAt });
        return;
      }
      if (decision.verdict === 'invalid') {
        settle(call, 'error', { error: new ToolError(`Couldn't run ${call.name}: ${decision.reason}`), startedAt });
        return;
      }
      if (decision.verdict !== 'approve') {
        const reason = decision.verdict === 'park'
          ? `${decision.reason}, so call it directly.`
          : decision.reason;
        const err = new ToolRefused(`Couldn't run ${call.name}: ${reason}`);
        // Stop first, as a hold does, so settling this call releases
        // nothing queued behind it.
        const first = !refusal;
        if (first) refusal = err;
        settle(call, 'refused', { error: err, startedAt });
        stopAll(err, 'refused');
        if (first) opts.onRefused?.(err);
        return;
      }
      const input = response !== undefined ? deps.answer(call.name, call.args, response) : call.args;
      ran = true;
      const result = await deps.run({ toolName: call.name, input, toolUseId: call.toolUseId });
      if (result.cancelled || refusal) {
        settle(call, 'cancelled', { error: refusal || new ToolRefused(`Couldn't finish ${call.name}: it was interrupted.`), startedAt, ran });
      } else if (!result.success) {
        settle(call, 'error', { error: new ToolError(result.content || result.error || `${call.name} failed`), startedAt, ran });
      } else {
        settle(call, 'ok', { value: { content: result.content, attachments: result.attachments ?? [] }, startedAt, ran });
      }
    } catch (err) {
      if (err instanceof ToolRefused) {
        // A hold that ended unanswered: the user declined, or the program
        // ended under it. The program ends as a refusal ends it.
        const first = !refusal;
        if (first) refusal = err;
        settle(call, first ? 'refused' : 'cancelled', { error: /** @type {ToolRefused} */ (refusal), startedAt });
        stopAll(/** @type {ToolRefused} */ (refusal), first ? 'refused' : 'cancelled');
        if (first) opts.onRefused?.(err);
        return;
      }
      settle(call, 'error', { error: new ToolError(extractErrorMessage(err)), startedAt, ran });
    }
  };

  /**
   * Hold a parked call for the user, once every hold before it has ended, and
   * wait for their answer. While it is held the call is recorded as waiting,
   * and with no effect: it has not run, and may never.
   * @param {Pending} call - The parked call
   * @param {any} decision - The decision that parked it
   * @returns {Promise<import('./held-calls.js').HeldAnswer>} The answer
   * @throws {ToolRefused} When the hold ends unanswered
   */
  const holdCall = async (call, decision) => {
    const request = await deps.holdRequest({ name: call.name, args: call.args }, decision);
    const before = lastHold;
    /** @type {() => void} */
    let done = () => {};
    lastHold = new Promise((resolve) => { done = () => resolve(undefined); });
    try {
      await before;
      if (refusal) throw refusal;
      everHeld = true;
      const effect = call.entry.effect;
      delete call.entry.effect;
      call.entry.status = 'held';
      try {
        await opts.beforeHold?.(request, call.tag);
        if (refusal) throw refusal;
        return await deps.hold(request, holds.signal);
      } catch (err) {
        throw err instanceof ToolRefused ? err : new ToolRefused(extractErrorMessage(err));
      } finally {
        call.entry.status = 'running';
        if (effect !== undefined) call.entry.effect = effect;
        opts.afterHold?.();
      }
    } finally {
      done();
    }
  };

  /** Release every queued call the order and the limit now allow. */
  function pump() {
    if (refusal) return;
    let running = calls.filter((c) => c.phase === 'running').length;
    let unsettled = false;
    let unsettledBarrier = false;
    for (const call of calls) {
      if (call.phase === 'queued' && running < limit
          && !unsettledBarrier && (call.alongside || !unsettled)) {
        running++;
        void start(call);
      }
      if (call.phase === 'done') continue;
      unsettled = true;
      if (!call.alongside) unsettledBarrier = true;
    }
  }

  opts.signal?.addEventListener('abort', () => {
    stopAll(new ToolRefused('The program was interrupted.'), 'cancelled');
    holds.abort();
    // A running call whose cancel lands is recorded as cancelled when it returns.
    for (const call of calls) if (call.phase === 'running') call.entry.status = 'cancelled';
  }, { once: true });

  /**
   * Call one tool from the program.
   * @param {string} name - Tool name
   * @param {Record<string, unknown>} args - Its arguments
   * @param {InvokeHow} [how] - How to make it
   * @returns {Promise<any>} What the tool returned: its content, or with its attachments
   */
  async function invoke(name, args, how = {}) {
    const input = (args && typeof args === 'object') ? args : {};
    const approval = typeof how.answer === 'string' ? { response: how.answer } : null;
    /** @type {NestedCall} */
    const entry = { name, args: clipArg(input), status: 'queued' };
    if (refusal || opts.signal?.aborted) {
      entry.status = refusal ? 'refused' : 'cancelled';
      keep(entry);
      throw refusal || new ToolRefused('The program was interrupted.');
    }
    const admitted = await offered();
    const def = admitted.get(name) ?? admitted.get(unprefixed(name));
    if (!def) {
      entry.status = 'error';
      entry.error = `Couldn't run ${name}: it wasn't available in this thread.`;
      keep(entry);
      throw new ToolError(entry.error);
    }
    // Run, decided and recorded under the tool's own name.
    const tool = /** @type {string} */ (def.name);
    entry.name = tool;
    const alongside = def.category === 'read' || def.category === 'meta';
    if (!alongside) entry.effect = effectLine(tool, input);
    keep(entry);
    /** @type {Promise<{content: string, attachments: AssetRef[]}>} */
    const settled = new Promise((resolve, reject) => {
      calls.push({
        name: tool, args: input, alongside, entry, phase: 'queued', resolve, reject, approval, tag: how.tag,
        toolUseId: `code_${opts.parentToolUseId}_${++ordinal}`,
      });
      if (refusal) {
        settle(/** @type {Pending} */ (calls[calls.length - 1]), 'refused', { error: refusal });
        return;
      }
      pump();
    });
    const value = await settled;
    return how.withAttachments ? value : value.content;
  }

  /**
   * The tools a call is admitted to, by name: the thread's offered tools that a
   * program may call. Built once per program, so admission and anything that
   * describes the admitted set (a program's own listing) cannot disagree.
   * @returns {Promise<Map<string, Record<string, any>>>} The admitted tools
   */
  function offered() {
    if (!offeredPromise) {
      offeredPromise = deps.offeredTools().then((defs) => new Map(
        defs.filter((d) => isComposableTool(/** @type {any} */ (d))).map((d) => [d.name, d])
      ));
    }
    return offeredPromise;
  }

  /**
   * The program has ended: refuse whatever is still waiting on the user, and
   * put the program's item back to running if a call was held. Not for a
   * program whose item was cancelled, whose state is the canceller's.
   */
  function end() {
    if (!refusal) refusal = new ToolRefused('The program ended before this call was answered.');
    holds.abort();
    if (everHeld) deps.release();
  }

  return { invoke, record, offered, end };
}

/**
 * Install the host binding the SDK reaches the invoker through
 * (`ContextItem#createToolInvoker`), so an extension's tool never imports this
 * module. Wherever the executor loads — every engine host — the binding exists.
 */
/** @type {any} */ (globalThis).__hostToolInvoker = createToolInvoker;
