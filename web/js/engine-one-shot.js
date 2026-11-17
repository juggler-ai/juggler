//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unattended runs, carried out inside the engine: a one-shot run (the CLI's
 * `run-one-shot`, answered by `one-shot-result`) and an agent run (`run-agent`,
 * answered by `agent-run-result`), both built on {@link runUnattended}.
 *
 * The server asks for these and the engine answers them because the engine is where a conversation can actually be
 * made: the system prompt, the strategy, the permission rules and the auto items
 * are written into the Yjs document by the model, not by the worker, so a
 * conversation created any other way starts with an empty system prompt and the
 * default strategy — and then runs, looks healthy, and answers nothing it was
 * asked. `Session.createConversation` is the one call that seeds all of it, and
 * it is already the call the new-conversation tool makes from here.
 *
 * Exactly one reply is sent, whatever happens, because the process on the other
 * end is blocked on it. Its words are for that process: the CLI prints
 * `errorText` inside its own English, so they are marked untranslated.
 * @module engine-one-shot
 */

import { extractErrorMessage } from '../sdk/lib/error-utils.js';
import { markUntranslated } from '../sdk/lib/i18n.js';
import { waitForTurnOutcome } from './model/turn-completion.js';
import wsService from './services/websocket.js';
import providersCache from './services/providers-cache.js';
import contextItemRegistry from './registries/context-item-registry.js';
import { yGet } from './model/item-accessor.js';
import { toolSummary } from './utils/conversation-markdown.js';

/**
 * How much longer than the caller's own deadline the engine waits.
 *
 * The wall clock belongs to the caller: a realm wedged badly enough to lose the
 * request is exactly the realm that cannot time itself out. This margin only
 * decides who reports first, and it must be the caller — so the engine's wait is
 * always the slower of the two.
 */
const ENGINE_PATIENCE_MARGIN_MS = 5000;

/** Fallback deadline for a request that names none. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run one prompt to completion and report what happened.
 *
 * `ready` is what separates a connected engine from a usable one. The server
 * dispatches this the moment the engine's WebSocket registers, but the realm
 * behind that socket cannot spawn a worker until its session has loaded and
 * initialised the worker manager — which takes an HTTP round-trip of its own.
 * Seeding a conversation in that gap throws about an uninitialised worker
 * manager, and the run reports that as its outcome: a caller who typed a prompt
 * is told nothing it can act on, having had nothing run. Waiting closes the gap,
 * and a realm that never becomes ready arrives here as a rejection carrying the
 * reason, which is a better answer than the one the spawn would have given.
 * @param {import('./model/session.js').default|null} session - The engine's live Session
 * @param {{requestId?: string, prompt?: string, strategyId?: string, name?: string, timeoutMs?: number}} request - The server's run-one-shot message
 * @param {Promise<void>} [ready] - Settles when the realm can spawn workers
 * @returns {Promise<void>} Resolves once the single result has been sent
 */
export async function runOneShot(session, request, ready) {
  const requestId = String(request?.requestId || '');
  const prompt = String(request?.prompt || '');
  const strategyId = String(request?.strategyId || 'yolo');
  const name = String(request?.name || markUntranslated('Run'));
  const timeoutMs = Number(request?.timeoutMs) || DEFAULT_TIMEOUT_MS;

  /** @type {{status: string, conversationId: string, turns: number, finalText: string, parkedTool: string, errorText: string}} */
  const result = {
    status: 'failed',
    conversationId: '',
    turns: 0,
    finalText: '',
    parkedTool: '',
    errorText: ''
  };

  try {
    // Before anything touches the session: the caller's own timeout is the only
    // clock on this wait, which is correct — a realm that is slow to come up is
    // indistinguishable from a run that is slow to finish, and both are the
    // caller's to give up on.
    if (ready) await ready;
    if (!session) throw new Error(markUntranslated('the engine has no session to run in'));
    if (!prompt.trim()) throw new Error(markUntranslated('there is no prompt to run'));

    const conversationId = await session.createConversation(name, { origin: 'one-shot-run' });
    result.conversationId = conversationId;
    const conversation = session.getConversation(conversationId);
    if (!conversation) throw new Error(markUntranslated(`conversation ${conversationId} was created but could not be opened`));

    const outcome = await runUnattended(conversation, {
      prompt,
      strategyId,
      timeoutMs: timeoutMs + ENGINE_PATIENCE_MARGIN_MS,
      label: markUntranslated('one-shot run')
    });
    result.status = outcome.status;
    result.turns = outcome.turns;
    result.finalText = outcome.text;
    result.parkedTool = outcome.parkedTool;
    result.errorText = outcome.errorText;
  } catch (err) {
    result.status = 'failed';
    result.errorText = extractErrorMessage(err);
    // The result carries the message alone; the stack goes to the run's log.
    console.error('[one-shot] run failed:', err);
  }

  wsService.sendOneShotResult({ requestId, ...result });
}

/**
 * @typedef {object} UnattendedOutcome
 * @property {'completed'|'parked'|'failed'} status - How the turn ended
 * @property {string} text - The last assistant message: the run's answer
 * @property {number} turns - Turns the conversation completed for this prompt
 * @property {string} parkedTool - The tool it parked on, when parked
 * @property {string} errorText - The error the turn recorded, when failed
 */

/**
 * Run one prompt to its end in a conversation nobody is watching: configure it
 * for that, send the prompt, and wait for the turn's durable outcome. The core
 * of a one-shot run and of an agent run alike.
 *
 * A prompt the conversation refused, a timeout and an abort all throw; what the
 * turn itself did — finished, parked, or recorded an error — is the outcome.
 * @param {import('./model/conversation.js').default} conversation - A freshly created conversation
 * @param {{prompt: string, strategyId: string, modelConfig?: import('./model/conversation.js').ModelConfig|null, timeoutMs: number, signal?: AbortSignal, label: string}} options -
 *   `modelConfig` replaces the conversation's model when given; `signal` ends
 *   the wait early; `label` names the run in its log and its errors
 * @returns {Promise<UnattendedOutcome>} How the turn ended
 */
async function runUnattended(conversation, { prompt, strategyId, modelConfig = null, timeoutMs, signal, label }) {
  if (modelConfig) conversation.setModelConfig(modelConfig);
  configureForUnattendedUse(conversation, strategyId);

  // Capture the turn epoch BEFORE sending: the worker is idle right now, and
  // an idle read after the send can be this same one rather than the turn's.
  const sinceTurn = conversation.completedTurns;

  const dropped = await conversation.sendMessage(prompt, null, conversation.rootMessageThread);
  if (dropped) {
    // What the refusal was judged on, for the run's log: a refusal that should
    // not have happened is a document or a provider list that had not arrived.
    console.error(`[${label}] ${conversation.id} refused its prompt (${dropped}):`, {
      modelConfig: conversation.modelConfig ?? null,
      hasItemsArray: conversation.hasRootItemsArray,
      providersReady: providersCache.isReady(),
      providers: providersCache.get().length
    });
    throw new Error(markUntranslated(`the prompt was not delivered: ${dropped}`));
  }

  const { parked, parkedTool } = await waitForTurnOutcome(conversation, { sinceTurn, timeoutMs, signal, label });

  /** @type {UnattendedOutcome} */
  const outcome = {
    status: 'completed',
    text: lastAssistantText(conversation),
    turns: Math.max(0, conversation.completedTurns - sinceTurn),
    parkedTool: '',
    errorText: ''
  };
  const failure = lastErrorText(conversation);
  if (parked) {
    outcome.status = 'parked';
    outcome.parkedTool = parkedTool;
  } else if (failure) {
    outcome.status = 'failed';
    outcome.errorText = failure;
  }
  return outcome;
}

/**
 * The agent runs this engine is carrying out, by run id: what a cancel needs to
 * reach one.
 * @type {Map<string, {controller: AbortController, conversation: import('./model/conversation.js').default|null, stoppedFor: ''|'cancelled'|'max-turns'}>}
 */
const agentRuns = new Map();

/**
 * Carry out one agent run (the server's `run-agent`) and report it with exactly
 * one `agent-run-result`.
 *
 * The run works in an ephemeral conversation the server owns and tears down,
 * so nothing here deletes it. While it runs, each tool call it makes is
 * reported as an `agent-run-progress` line, and each model response is counted
 * against `maxTurns`. The server keeps the run's clock; `timeoutMs` only stops
 * this engine watching a turn nobody is waiting for.
 * @param {import('./model/session.js').default|null} session - The engine's live Session
 * @param {{runId?: string, prompt?: string, strategyId?: string, modelConfig?: {provider?: string, model?: string, thinking?: string}, workspaceId?: string, maxTurns?: number, timeoutMs?: number, name?: string}} request - The run-agent frame
 * @param {Promise<void>} [ready] - Settles when the realm can spawn workers
 * @returns {Promise<void>} Resolves once the single result has been sent
 */
export async function runAgentRun(session, request, ready) {
  const runId = String(request?.runId || '');
  const prompt = String(request?.prompt || '');
  const strategyId = String(request?.strategyId || 'yolo');
  const name = String(request?.name || markUntranslated('Agent run'));
  const workspaceId = String(request?.workspaceId || '');
  const maxTurns = Math.max(0, Number(request?.maxTurns) || 0);
  const timeoutMs = Number(request?.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const model = request?.modelConfig;
  const modelConfig = model?.provider && model?.model
    ? { provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }
    : null;

  const result = {
    runId,
    status: 'failed',
    text: '',
    turns: 0,
    parkedTool: '',
    errorText: '',
    errorKind: '',
    conversationId: ''
  };
  if (!runId) {
    console.error('[agent-run] run-agent with no run id');
    return;
  }

  /** @type {{controller: AbortController, conversation: import('./model/conversation.js').default|null, stoppedFor: ''|'cancelled'|'max-turns'}} */
  const run = { controller: new AbortController(), conversation: null, stoppedFor: '' };
  agentRuns.set(runId, run);
  let stopWatching = () => {};

  try {
    if (ready) await ready;
    if (!session) throw new Error(markUntranslated('the engine has no session to run in'));
    if (!prompt.trim()) throw new Error(markUntranslated('there is no prompt to run'));
    if (run.controller.signal.aborted) throw new Error(markUntranslated('the run was stopped before it started'));

    const conversation = await session.createEphemeralConversation({ name, agentRun: runId, workspaceId });
    run.conversation = conversation;
    result.conversationId = conversation.id;
    if (run.controller.signal.aborted) throw new Error(markUntranslated('the run was stopped before it started'));

    stopWatching = watchAgentRun(conversation, {
      onToolCall: (progress) => wsService.sendAgentRunProgress({ runId, ...progress }),
      onTurns: (turns) => {
        result.turns = turns;
        if (maxTurns > 0 && turns > maxTurns && !run.stoppedFor) stopAgentRun(run, 'max-turns');
      }
    });

    const outcome = await runUnattended(conversation, {
      prompt,
      strategyId,
      modelConfig,
      timeoutMs: timeoutMs + ENGINE_PATIENCE_MARGIN_MS,
      signal: run.controller.signal,
      label: markUntranslated('agent run')
    });
    result.status = outcome.status;
    result.text = outcome.text;
    result.parkedTool = outcome.parkedTool;
    result.errorText = outcome.errorText;
  } catch (err) {
    result.status = 'failed';
    result.errorText = extractErrorMessage(err);
    if (!run.stoppedFor) console.error(`[agent-run] ${runId} failed:`, err);
  } finally {
    stopWatching();
    agentRuns.delete(runId);
  }

  // A stop decides the ending whichever way the wait came out: the turn may
  // have settled in the same beat the stop landed.
  if (run.stoppedFor === 'cancelled') {
    result.status = 'cancelled';
    result.errorText = '';
  } else if (run.stoppedFor === 'max-turns') {
    result.status = 'failed';
    result.errorKind = 'max-turns';
    result.errorText = markUntranslated(`the run needed more than its limit of ${maxTurns} turns`);
  }
  if (run.conversation) result.text ||= lastAssistantText(run.conversation);

  wsService.sendAgentRunResult(result);
}

/**
 * Stop an agent run the server says has ended (`cancel-agent-run`). A run this
 * engine does not hold — already finished, or never started here — is ignored.
 * @param {string} runId - The run to stop
 */
export function cancelAgentRun(runId) {
  const run = agentRuns.get(String(runId || ''));
  if (run && !run.stoppedFor) stopAgentRun(run, 'cancelled');
}

/**
 * End a run's wait and stop its conversation's work.
 * @param {{controller: AbortController, conversation: import('./model/conversation.js').default|null, stoppedFor: ''|'cancelled'|'max-turns'}} run - The run
 * @param {'cancelled'|'max-turns'} why - What stopped it
 */
function stopAgentRun(run, why) {
  run.stoppedFor = why;
  run.controller.abort();
  run.conversation?.stopProcessing(`agent-run-${why}`);
}

/**
 * Watch an agent run's root thread as the worker writes it: report each tool
 * call once, and the count of model responses so far.
 *
 * Every model response is its own LLM request, stamped with its own
 * transactionId on each item it produced — its text, its thinking and its tool
 * calls — so the distinct ids among those items are the responses.
 * @param {import('./model/conversation.js').default} conversation - The run's conversation
 * @param {{onToolCall: (progress: {toolUseId: string, toolName: string, summary: string}) => void, onTurns: (turns: number) => void}} handlers - Callbacks
 * @returns {() => void} Stop watching
 */
function watchAgentRun(conversation, { onToolCall, onTurns }) {
  /** @type {Set<string>} */
  const reported = new Set();
  /** @type {Set<string>} */
  const transactions = new Set();
  const scan = () => {
    const items = conversation.rootMessageThread.items || [];
    const before = transactions.size;
    for (const item of items) {
      const type = item?.get?.('type');
      if (type !== 'assistant' && type !== 'tool-action' && type !== 'thinking') continue;
      const txn = item.get('transactionId');
      if (typeof txn === 'string' && txn) transactions.add(txn);
      if (type !== 'tool-action') continue;
      const toolUseId = String(item.get('toolUseId') || '');
      // Reported once its input has landed, which is what its summary reads.
      if (!toolUseId || reported.has(toolUseId) || item.get('toolInput') === undefined || item.get('toolInput') === null) continue;
      reported.add(toolUseId);
      const toolName = String(item.get('toolName') || '');
      onToolCall({ toolUseId, toolName, summary: toolCallSummary(conversation, item, toolName) });
    }
    if (transactions.size !== before) onTurns(transactions.size);
  };
  const off = conversation.onDocumentChange(scan);
  scan();
  return off;
}

/**
 * One line saying what a tool call is doing, as its tile says it while it is
 * pending: the tool's type name and its summary. A tool whose summary is not
 * text (bash builds an element, which a realm with no document cannot) is
 * described from its input instead.
 * @param {import('./model/conversation.js').default} conversation - The run's conversation
 * @param {import('./vendor/yjs.mjs').Map} item - The tool-action item
 * @param {string} toolName - Its tool name
 * @returns {string} The summary line
 */
function toolCallSummary(conversation, item, toolName) {
  const input = yGet(item, 'toolInput');
  const ActionClass = toolName ? contextItemRegistry.getByToolName(toolName) : null;
  if (ActionClass) {
    try {
      const messageThread = conversation.rootMessageThread;
      const context = { conversation, messageThread, session: conversation.session, toolUseId: String(item.get('toolUseId') || '') };
      const instance = new ActionClass(/** @type {import('../sdk/context-item-types.js').ItemContext} */ (/** @type {unknown} */ ({ id: 'agent-run-progress', ...context })));
      const status = { pending: true, actionId: toolName.toLowerCase(), displayData: yGet(item, 'displayData'), state: item.get('state') };
      const config = instance.getStatusUI(/** @type {import('./services/action-executor.js').ActionStatus} */ (/** @type {unknown} */ (status)), /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {}), context);
      if (config && typeof config.summary === 'string' && config.summary.trim()) {
        return [config.typeName, config.summary].filter(Boolean).join(' ');
      }
    } catch {
      // A summary that cannot be built here falls back to the input's.
    }
  }
  const fromInput = toolSummary(item);
  return fromInput ? `${toolName} ${fromInput}` : toolName;
}

/**
 * Grant a conversation everything an unattended run needs, in all the layers
 * that can park a tool.
 *
 * Belt and braces on purpose: the strategy decides the default approval policy,
 * but a rule can still refuse, and a tool the strategy cannot auto-approve is a
 * hang rather than a prompt when there is nobody to ask. The execute grant is
 * conversation-scoped rather than session-scoped — a blanket session grant
 * outlives this conversation, and file edits only accept conversation scope
 * anyway.
 * @param {import('./model/conversation.js').default} conversation - The conversation to configure
 * @param {string} strategyId - Strategy to run under
 */
function configureForUnattendedUse(conversation, strategyId) {
  const thread = conversation.rootMessageThread;
  thread.setStrategy(strategyId);
  thread.addRule('write-file', { kind: 'boolean', value: true });
  thread.addRule('execute', { kind: 'glob', value: '*', scope: 'conversation' });
  conversation.setAutoApprove(true);
  // What none of the above can cover: a tool only a person can resolve (an
  // AskUserQuestion, a plan submit). Unattended, those are not offered, and one
  // that would still wait for a person is refused instead.
  conversation.setUnattended(true);
}

/**
 * The last thing the assistant said, which is the run's answer.
 * @param {import('./model/conversation.js').default} conversation - The conversation to read
 * @returns {string} The final assistant message, or '' if it never spoke
 */
function lastAssistantText(conversation) {
  const items = conversation.rootMessageThread.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.get?.('type') === 'assistant') return String(items[i].get('content') || '');
  }
  return '';
}

/**
 * The last error the turn recorded. The worker writes error items into the
 * document, so this is the account of the failure rather than a guess from the
 * absence of an answer.
 * @param {import('./model/conversation.js').default} conversation - The conversation to read
 * @returns {string} The error text, or '' when the turn recorded none
 */
function lastErrorText(conversation) {
  const items = conversation.rootMessageThread.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.get?.('type') !== 'error') continue;
    return String(item.get('message') || item.get('content') || markUntranslated('the turn ended in an error'));
  }
  return '';
}
