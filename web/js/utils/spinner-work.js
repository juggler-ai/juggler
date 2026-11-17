//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a live `<juggler-spinner>` standing for one thread's run is told about
 * that run (see the `live` attribute in components/juggler-spinner.js).
 *
 * One derivation for every spinner that stands for a thread — the column
 * footer's and the parent tile's — so a sub-thread's spinner on the tile and
 * in its own column juggle the same clubs at the same speed.
 */

import { runningToolsInTree } from '../model/thread-navigation.js';
import providersCache from '../services/providers-cache.js';

/**
 * @typedef {object} SpinnerWork
 * @property {number} runningTools - Tool calls executing in parallel, for the club count.
 * @property {number} throughput - Output tokens per second, 0 when nothing is streaming.
 * @property {number|null} toolWaitMs - How long the longest-running tool call has been
 *   running, or null when none is executing.
 */

/**
 * The work behind one thread's run, as a live spinner reports it.
 *
 * The club count and tool wait are read off `items`, which the caller scopes:
 * the thread's whole transcript (nested threads included), or the slice a
 * group column shows. The speed while streaming is the flow into THIS thread,
 * not the conversation's total.
 * @param {import('../model/conversation.js').default|null|undefined} conversation - The conversation the thread is in.
 * @param {string|null} threadItemId - The thread's item id (null for the root).
 * @param {unknown} items - The items to count running tools in (plain array or Y.Array).
 * @returns {SpinnerWork} The spinner's inputs.
 */
export function threadSpinnerWork(conversation, threadItemId, items) {
  const running = runningToolsInTree(items);
  // A running tool with no claim stamp yet counts as freshly started (0) rather
  // than as no tool at all — the wait is real, we just can't date it.
  const toolWaitMs = running.count > 0
    ? Math.max(0, running.oldestStart ? Date.now() - running.oldestStart : 0)
    : null;
  // Zero while parked on a tool call or waiting on the network — the truth of
  // those moments rather than a missing reading.
  const throughput = conversation?.llmState?.getThroughput?.(conversation.id, threadItemId) ?? 0;
  return { runningTools: running.count, throughput, toolWaitMs };
}

/**
 * The WS-pushed provider-list entry for a model config, or null when the
 * config names no model or the list does not carry it (yet).
 * @param {import('../model/conversation.js').ModelConfig|null|undefined} config - The model a thread runs.
 * @returns {import('../services/providers-cache.js').ModelWithContext|null} The model entry, or null.
 */
export function modelEntryFor(config) {
  if (!config?.provider || !config?.model) return null;
  const providerEntry = providersCache.get().find((p) => p?.name === config.provider);
  return providerEntry?.modelsWithContext?.find((m) => m?.id === config.model) || null;
}

/**
 * Feed a live spinner one reading of the run behind it. Free to call on every
 * tick — the spinner ignores an unchanged count and deadbands the rate — and
 * ignored outright by a spinner not marked `live`.
 * @param {Element|null} spinner - The `<juggler-spinner>`.
 * @param {SpinnerWork} work - What the run is doing.
 */
export function reportSpinnerWork(spinner, work) {
  if (!spinner) return;
  const live = /** @type {{clubs: number, report: (work: {throughput: number, toolWaitMs: number|null}) => void}} */ (
    /** @type {unknown} */ (spinner));
  live.clubs = work.runningTools;
  live.report({ throughput: work.throughput, toolWaitMs: work.toolWaitMs });
}
