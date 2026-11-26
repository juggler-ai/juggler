//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A strategy switch the user asked for, however they asked: the strategy
 * menu, the Shift+Tab hold-to-cycle gesture once it is released, or a link in
 * the approval card's hint. Each of them comes through {@link switchStrategy},
 * which does what a pick means beyond writing the id:
 *
 * - **It asks first when the switch would throw away a large cached
 *   context.** A strategy that offers a different tool set changes the
 *   request's `[tools]` block, so the next send re-reads everything cached
 *   after it — the whole conversation (see `context-cache-impact.js`). Once
 *   that is over the composer caution's floor, the user confirms the switch.
 * - **It brings the new strategy's identity and instruction files to a
 *   conversation that has not started** (`MANIFEST.defaultPreset` and
 *   `MANIFEST.projectInstructions`; `reseedIdentityForStrategy` and
 *   `reseedInstructionsForStrategy` in `model/conversation-seeder.js`).
 *
 * A switch made for the user rather than by them — creation's seed, an
 * unattended run, a test — calls `MessageThread.setStrategy` directly.
 * @module services/strategy-switch
 */

import strategyRegistry from '../registries/strategy-registry.js';
import { CONTEXT_CACHE_WARNING_TOKENS } from './context-cache-impact.js';
import { uiPort } from './ui-port.js';
import { reseedIdentityForStrategy, reseedInstructionsForStrategy } from '../model/conversation-seeder.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { isConversationalItemType, itemField } from '../../sdk/lib/message.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * A stable, order-independent signature of the tool set a strategy exposes:
 * the sorted tool names left after its filterTools runs over the full set.
 * @param {any} strategy - Strategy instance
 * @param {Array<{name: string}>} tools - Full generated tool definitions
 * @returns {string} Sorted, comma-joined tool-name signature
 */
export function toolsetSignature(strategy, tools) {
  const filtered = strategy?.filterTools ? strategy.filterTools(tools) : tools;
  return (filtered || []).map((/** @type {any} */ tool) => tool?.name || '').sort().join(',');
}

/**
 * Whether switching between two tool sets re-reads a large cached context.
 * A different tool set diverges the cached prefix at its head, so everything
 * after it is re-read: the last turn's whole input, which the anchor measures.
 * Nothing is cached before the conversation has a message.
 * @param {object} args
 * @param {ArrayLike<any>} args.items - The thread's items
 * @param {string} args.fromToolsetSig - The current strategy's tool-set signature
 * @param {string} args.toToolsetSig - The new strategy's tool-set signature
 * @param {number} args.anchorTokens - The last turn's input tokens (0 when none)
 * @returns {boolean} True when the switch is worth confirming
 */
export function strategySwitchRereadsContext({ items, fromToolsetSig, toToolsetSig, anchorTokens }) {
  if (fromToolsetSig === toToolsetSig) return false;
  if (!(anchorTokens >= CONTEXT_CACHE_WARNING_TOKENS)) return false;
  return Array.from(items || []).some((item) => isConversationalItemType(String(itemField(item, 'type') ?? '')));
}

/**
 * What the strategy selector last measured for each thread it is bound to,
 * keyed `conversationId::threadItemId`: the full tool set and the last turn's
 * input tokens. The selector keeps both for its cache caution, reading them
 * off the hot path; recording them here lets every route decide a pick in the
 * same task, without reading anything — a click never waits on the worker.
 * Kept for the {@link MEASURED_LIMIT} threads measured most recently: a thread
 * whose record has gone simply asks nothing until its selector measures it
 * again, and a long session's closed threads never pile up here.
 * @type {Map<string, {tools: Array<{name: string}>, anchorTokens: number}>}
 */
const measured = new Map();

/** How many threads' measurements {@link measured} keeps. */
const MEASURED_LIMIT = 64;

/**
 * The logical key of a thread: the same thread in a fresh wrapper keys alike.
 * @param {any} thread - The thread
 * @returns {string} Its key
 */
function threadKey(thread) {
  return `${thread?.conversationId ?? thread?.conversation?.id ?? ''}::${thread?.threadItemId ?? 'root'}`;
}

/**
 * Record what the strategy selector measured for a thread, so a switch picked
 * anywhere can be weighed without reading it again.
 * @param {any} thread - The thread the selector is bound to
 * @param {{tools: Array<{name: string}>, anchorTokens: number}} inputs - Its full tool set and the last turn's input tokens
 */
export function noteSwitchInputs(thread, inputs) {
  const key = threadKey(thread);
  // Re-inserted, so the Map's order is least recently measured first.
  measured.delete(key);
  measured.set(key, inputs);
  for (const oldest of measured.keys()) {
    if (measured.size <= MEASURED_LIMIT) break;
    measured.delete(oldest);
  }
}

/**
 * Whether switching a thread to a strategy would re-read a large cached
 * context, from what was recorded for it ({@link noteSwitchInputs}). A thread
 * with nothing recorded says no: the question is one to ask when it is known
 * to cost, never a reason to hold the switch up.
 * @param {any} thread - The thread being switched
 * @param {string} strategyId - The strategy it would switch to
 * @returns {boolean} True when the switch is worth confirming
 */
export function switchIsCostly(thread, strategyId) {
  const inputs = measured.get(threadKey(thread));
  if (!thread || !inputs) return false;
  try {
    const fromId = thread.currentStrategyId || thread.getEffectiveStrategyId?.() || 'default';
    return strategySwitchRereadsContext({
      items: thread.items || [],
      fromToolsetSig: toolsetSignature(strategyRegistry.createStrategy(fromId, thread), inputs.tools),
      toToolsetSig: toolsetSignature(strategyRegistry.createStrategy(strategyId, thread), inputs.tools),
      anchorTokens: inputs.anchorTokens
    });
  } catch (err) {
    console.warn('[StrategySwitch] Could not weigh the switch:', err);
    return false;
  }
}

/**
 * Ask the user whether to switch when it throws away the cached context.
 * With no dialog to ask through (a headless page), the switch goes ahead.
 * @param {string} strategyId - The strategy being switched to
 * @returns {Promise<boolean>} True to switch
 */
async function confirmCostlySwitch(strategyId) {
  const port = uiPort();
  if (!port) return true;
  const manifest = strategyRegistry.get(strategyId)?.MANIFEST;
  const name = capabilityLabel(manifest?.name || strategyId, strategyId, strategyRegistry);
  const answer = await port.confirm(
    t('{name} offers the model a different set of tools, so the next message re-reads this whole conversation instead of reusing its cache. That costs more and takes longer.', { name }),
    t('Switch to {name}?', { name }),
    { confirmText: t('Switch') }
  );
  return answer === true;
}

/**
 * Write the switch, then bring the new strategy's identity and instruction
 * files to a root thread whose conversation has not started.
 * @param {any} thread - The thread
 * @param {string} strategyId - The strategy
 * @returns {Promise<void>}
 */
async function applySwitch(thread, strategyId) {
  const from = thread.getEffectiveStrategyId?.() || thread.currentStrategyId || 'default';
  thread.setStrategy(strategyId);
  if (thread.threadItemId || !thread.conversation) return;
  await reseedIdentityForStrategy(thread.conversation);
  await reseedInstructionsForStrategy(thread.conversation, from);
}

/**
 * Switch a thread to a strategy because the user picked it. When the switch
 * would re-read a large cached context the user is asked first, and a no
 * leaves the strategy as it was.
 *
 * Whether it would is weighed from what the strategy selector recorded
 * ({@link switchIsCostly}), or taken from `costly` when the caller has just
 * weighed it. A switch that asks nothing is written before this returns, so
 * a display that repaints straight after sees it.
 * @param {any} thread - The thread being switched (a MessageThread)
 * @param {string} strategyId - The strategy picked
 * @param {{costly?: boolean}} [opts] - Whether the switch re-reads a large cached context, when the caller knows
 * @returns {Promise<boolean>} True when the switch was made (the identity re-seed included)
 */
export function switchStrategy(thread, strategyId, opts = {}) {
  if (!thread) return Promise.resolve(false);
  const costly = opts.costly ?? switchIsCostly(thread, strategyId);
  if (!costly) return applySwitch(thread, strategyId).then(() => true);
  return confirmCostlySwitch(strategyId).then(async (yes) => {
    if (!yes) return false;
    await applySwitch(thread, strategyId);
    return true;
  });
}
