//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Hook runtime — runs the registered tool hooks (see `juggler/hook-type`) around
 * one tool call, and turns what they said into a record for the call.
 *
 * Two entry points, one per event, each called from exactly one place:
 * - {@link runBeforeToolHooks} from `handleNewToolAction`, between `prepare()`
 *   and the approval decision.
 * - {@link runAfterToolHooks} from `ActionExecutor.execute`, after the tool has
 *   run and before the execution leaves the executing set — so the hooks run
 *   while the call still reads as running, and the await-free region between
 *   that and the result write (INV-C) is untouched.
 *
 * Both are engine-only by construction: their callers run only in the engine.
 *
 * Every hook that matched leaves a {@link HookRecord}. The records are written to
 * the tool-action's `hooks` field; a record's `note` is sent to the model inside
 * the call's own tool_result (the worker's `toolResultHookNotes`), never as a
 * message of its own.
 * @module services/hook-runtime
 */

import hookRegistry from '../registries/hook-registry.js';
import { resolveToolName } from './tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isToolActionMessage } from '../../sdk/lib/message.js';
import { plain } from '../model/item-accessor.js';
import {
  DEFAULT_BEFORE_TOOL_TIMEOUT_MS,
  MAX_BEFORE_TOOL_TIMEOUT_MS,
  DEFAULT_AFTER_TOOL_TIMEOUT_MS,
  MAX_AFTER_TOOL_TIMEOUT_MS,
} from 'juggler/hook-type';

/**
 * What one hook did to one call. Stored on the tool-action's `hooks` field and
 * shown in its card.
 * @typedef {object} HookRecord
 * @property {string} id - The hook's MANIFEST id
 * @property {string} name - Its display name
 * @property {'extension'|'user'} source - An extension's hook, or a `~/.juggler/hooks` file
 * @property {'beforeTool'|'afterTool'} event - When it ran
 * @property {'deny'|'ask'|'allow'} [verdict] - Its ruling, if any
 * @property {string} [reason] - Why, for a ruling
 * @property {string} [note] - Text sent to the model inside this call's result
 * @property {boolean} [markError] - It reported the call as failed
 * @property {boolean} [repeatSuppressed] - It had a note, dropped as already said in this thread
 * @property {string} [error] - It threw or timed out
 * @property {number} ms - How long it took
 */

/**
 * Longest note a hook may add. A note is sent to the model on every later turn,
 * so the runtime bounds it rather than trusting the hook.
 * @type {number}
 */
const MAX_NOTE_CHARS = 4000;

/**
 * Longest reason a verdict may carry.
 * @type {number}
 */
const MAX_REASON_CHARS = 1000;

/**
 * Verdict precedence: a higher rank wins.
 * @type {Record<string, number>}
 */
const VERDICT_RANK = { allow: 1, ask: 2, deny: 3 };

/**
 * @param {HookRecord} record
 * @returns {number} Its verdict's rank (0 for none)
 */
function rankOf(record) {
  return (record.verdict && VERDICT_RANK[record.verdict]) || 0;
}

/**
 * One instance per hook class, so a hook may keep state across calls. Keyed by
 * class: a registry rebuild produces new classes, and the old instances go with
 * them.
 * @type {WeakMap<Function, any>}
 */
const instances = new WeakMap();

/**
 * @param {any} HookClass
 * @returns {any} The class's shared instance
 */
function instanceOf(HookClass) {
  let instance = instances.get(HookClass);
  if (!instance) {
    instance = new HookClass();
    instances.set(HookClass, instance);
  }
  return instance;
}

/**
 * Whether a hook's `match` covers a call. Every present field narrows; tool
 * names are compared both as the model wrote them and as resolved (so `Bash`
 * and `bash` are one tool); patterns are case-insensitive. A pattern that does
 * not compile matches nothing — validation rejects such a hook at load, so this
 * only guards against a manifest mutated afterwards.
 * @param {import('juggler/hook-type').HookMatch|undefined} match - The hook's match
 * @param {{toolName: string, toolInput: unknown, result?: {content: string, isError: boolean}}} call - The call
 * @returns {boolean} True when the hook should be offered the call
 */
export function matchesCall(match, call) {
  if (!match) return true;
  if (Array.isArray(match.tools) && match.tools.length) {
    const names = new Set([call.toolName, resolveToolName(call.toolName)]);
    if (!match.tools.some(t => names.has(t) || names.has(resolveToolName(t)))) return false;
  }
  if (match.input !== undefined && !testPattern(match.input, safeJSON(call.toolInput))) return false;
  if (match.result !== undefined && !testPattern(match.result, call.result?.content ?? '')) return false;
  if (match.isError !== undefined && (call.result?.isError ?? false) !== match.isError) return false;
  return true;
}

/**
 * @param {string} source - Regular expression source
 * @param {string} text - Text to test
 * @returns {boolean} Whether it matches (false for a pattern that does not compile)
 */
function testPattern(source, text) {
  try {
    return new RegExp(String(source), 'i').test(text);
  } catch {
    return false;
  }
}

/**
 * A copy of a call's input for a hook to read, so a hook that mutates what it is
 * handed changes nothing.
 * @param {unknown} input
 * @returns {Record<string, unknown>} A deep copy
 */
function copyInput(input) {
  try {
    return JSON.parse(JSON.stringify(input ?? {}));
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {string} JSON, or '' for a value that cannot be serialised
 */
function safeJSON(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}

/**
 * The hooks registered for an event, in registry order, with their provenance.
 * @param {'beforeTool'|'afterTool'} event
 * @returns {Promise<Array<{HookClass: any, manifest: any, source: 'extension'|'user'}>>} Candidate hooks
 */
async function hooksFor(event) {
  await hookRegistry.init();
  return hookRegistry.getManifests()
    .filter(({ manifest }) => /** @type {any} */ (manifest).events?.includes?.(event) === true)
    .map(({ id, manifest, modulePath }) => ({
      HookClass: hookRegistry.get(id),
      manifest: /** @type {any} */ (manifest),
      source: /** @type {'extension'|'user'} */ (modulePath.startsWith('user-hook:') ? 'user' : 'extension'),
    }));
}

/**
 * Run one hook method, bounded by a timeout and by the caller's signal.
 * @param {any} instance - The hook instance
 * @param {'beforeTool'|'afterTool'} method - The method to call
 * @param {object} ctx - Its context (a signal is added)
 * @param {number} timeoutMs - How long to wait
 * @param {AbortSignal} [outerSignal] - Aborts the wait (the call was cancelled)
 * @returns {Promise<any>} Whatever the hook returned
 */
async function callBounded(instance, method, ctx, timeoutMs, outerSignal) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {() => void} */
  let onOuterAbort = () => {};
  const stop = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    onOuterAbort = () => {
      controller.abort();
      reject(new Error('cancelled'));
    };
    if (outerSignal?.aborted) onOuterAbort();
    else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  });
  try {
    const run = Promise.resolve().then(() => instance[method]({ ...ctx, signal: controller.signal }));
    run.catch(() => {}); // a rejection after the race is decided is not unhandled
    return await Promise.race([run, stop]);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * @param {any} manifest - Hook manifest
 * @param {number} fallback - Default timeout
 * @param {number} ceiling - Maximum timeout
 * @returns {number} The timeout to use
 */
function timeoutFor(manifest, fallback, ceiling) {
  const asked = Number(manifest.timeoutMs);
  return Math.min(Number.isFinite(asked) && asked > 0 ? asked : fallback, ceiling);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string|undefined} A trimmed, bounded string, or undefined when empty
 */
function boundedText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Whether an earlier call in this thread already carries a note from this hook
 * — the `repeat: 'once-per-thread'` test. Read from the doc, not remembered, so
 * it holds across an engine reload and agrees with what the model was sent.
 * @param {any} messageThread - The call's thread
 * @param {string} hookId - The hook
 * @param {string} toolUseId - The call being decided (excluded)
 * @returns {boolean} True when the thread has heard from this hook already
 */
function threadHasNoteFrom(messageThread, hookId, toolUseId) {
  for (const item of messageThread?.items || []) {
    if (!isToolActionMessage(item) || item.get('toolUseId') === toolUseId) continue;
    const records = plain(item.get('hooks'));
    if (Array.isArray(records) && records.some(r => r?.id === hookId && r?.note)) return true;
  }
  return false;
}

/**
 * Turn what a hook returned into its record. Unknown fields and wrong types are
 * ignored; a verdict the event does not support is dropped.
 * @param {{manifest: any, source: 'extension'|'user'}} hook
 * @param {'beforeTool'|'afterTool'} event
 * @param {any} outcome - What the hook returned
 * @param {number} ms - How long it took
 * @returns {HookRecord} Its record
 */
function recordFor(hook, event, outcome, ms) {
  /** @type {HookRecord} */
  const record = { id: hook.manifest.id, name: hook.manifest.name, source: hook.source, event, ms };
  const note = boundedText(outcome?.note, MAX_NOTE_CHARS);
  if (note) record.note = note;
  if (event === 'beforeTool' && outcome?.verdict && VERDICT_RANK[outcome.verdict]) {
    record.verdict = outcome.verdict;
    const reason = boundedText(outcome.reason, MAX_REASON_CHARS);
    if (reason) record.reason = reason;
  }
  if (event === 'afterTool' && outcome?.markError === true) record.markError = true;
  return record;
}

/**
 * Drop the note of a `once-per-thread` hook the thread has already heard from.
 * @param {HookRecord} record
 * @param {any} manifest
 * @param {any} messageThread
 * @param {string} toolUseId
 */
function applyRepeat(record, manifest, messageThread, toolUseId) {
  if (record.note && manifest.repeat === 'once-per-thread' && threadHasNoteFrom(messageThread, record.id, toolUseId)) {
    delete record.note;
    record.repeatSuppressed = true;
  }
}

/**
 * Run every matching `beforeTool` hook on a call and merge their verdicts.
 *
 * Hooks run concurrently; records keep registry order. A hook that throws or
 * times out fails open (no opinion) unless its manifest says `onError:
 * 'closed'`, in which case it counts as an `ask` — the call waits for the user
 * rather than going ahead unexamined.
 * @param {{messageThread: any, conversationId: string, threadId: string, toolUseId: string, toolName: string, toolInput: Record<string, unknown>}} call - The call
 * @returns {Promise<{verdict: 'deny'|'ask'|'allow'|null, decidedBy: HookRecord|null, records: HookRecord[]}>} The merged ruling and every record
 */
export async function runBeforeToolHooks(call) {
  const hooks = (await hooksFor('beforeTool')).filter(h => matchesCall(h.manifest.match, call));
  if (!hooks.length) return { verdict: null, decidedBy: null, records: [] };

  const ctx = {
    toolName: call.toolName,
    toolInput: copyInput(call.toolInput),
    toolUseId: call.toolUseId,
    conversationId: call.conversationId,
    threadId: call.threadId,
  };
  const records = await Promise.all(hooks.map(async (hook) => {
    const started = Date.now();
    try {
      const outcome = await callBounded(instanceOf(hook.HookClass), 'beforeTool', ctx,
        timeoutFor(hook.manifest, DEFAULT_BEFORE_TOOL_TIMEOUT_MS, MAX_BEFORE_TOOL_TIMEOUT_MS));
      const record = recordFor(hook, 'beforeTool', outcome, Date.now() - started);
      applyRepeat(record, hook.manifest, call.messageThread, call.toolUseId);
      return record;
    } catch (err) {
      const message = extractErrorMessage(err);
      console.warn(`[hooks] beforeTool hook "${hook.manifest.id}" failed: ${message}`);
      /** @type {HookRecord} */
      const record = { id: hook.manifest.id, name: hook.manifest.name, source: hook.source,
        event: 'beforeTool', error: message, ms: Date.now() - started };
      if (hook.manifest.onError === 'closed') {
        record.verdict = 'ask';
        record.reason = `The hook failed (${message}), and it is set to hold the call for you when it does.`;
      }
      return record;
    }
  }));

  /** @type {HookRecord|null} */
  let decidedBy = null;
  for (const record of records) {
    if (record.verdict && (!decidedBy || rankOf(record) > rankOf(decidedBy))) {
      decidedBy = record;
    }
  }
  return { verdict: decidedBy?.verdict ?? null, decidedBy, records };
}

/**
 * Run every matching `afterTool` hook on a finished call. Always fails open: a
 * hook that throws or times out leaves an error in its record and nothing else.
 * @param {{messageThread: any, conversationId: string, threadId: string, toolUseId: string, toolName: string, toolInput: Record<string, unknown>, result: {content: string, isError: boolean}, signal?: AbortSignal}} call - The call and its result
 * @returns {Promise<{records: HookRecord[], markError: boolean}>} Every record, and whether any hook marked the call failed
 */
export async function runAfterToolHooks(call) {
  const hooks = (await hooksFor('afterTool')).filter(h => matchesCall(h.manifest.match, call));
  if (!hooks.length) return { records: [], markError: false };

  const ctx = {
    toolName: call.toolName,
    toolInput: copyInput(call.toolInput),
    toolUseId: call.toolUseId,
    conversationId: call.conversationId,
    threadId: call.threadId,
    result: { content: call.result.content, isError: call.result.isError },
  };
  const records = await Promise.all(hooks.map(async (hook) => {
    const started = Date.now();
    try {
      const outcome = await callBounded(instanceOf(hook.HookClass), 'afterTool', ctx,
        timeoutFor(hook.manifest, DEFAULT_AFTER_TOOL_TIMEOUT_MS, MAX_AFTER_TOOL_TIMEOUT_MS), call.signal);
      const record = recordFor(hook, 'afterTool', outcome, Date.now() - started);
      applyRepeat(record, hook.manifest, call.messageThread, call.toolUseId);
      return record;
    } catch (err) {
      const message = extractErrorMessage(err);
      console.warn(`[hooks] afterTool hook "${hook.manifest.id}" failed: ${message}`);
      return /** @type {HookRecord} */ ({ id: hook.manifest.id, name: hook.manifest.name, source: hook.source,
        event: 'afterTool', error: message, ms: Date.now() - started });
    }
  }));
  return { records, markError: records.some(r => r.markError) };
}
