//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * One unattended run, carried out inside the engine.
 *
 * The server asks for this (`run-one-shot`) and the engine answers it
 * (`one-shot-result`) because the engine is where a conversation can actually be
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
 * @param {any} session - The engine's live Session
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

    configureForUnattendedUse(conversation, strategyId);

    // Capture the turn epoch BEFORE sending: the worker is idle right now, and
    // an idle read after the send can be this same one rather than the turn's.
    const sinceTurn = conversation.completedTurns;

    const dropped = await conversation.sendMessage(prompt, null, conversation.rootMessageThread);
    if (dropped) throw new Error(markUntranslated(`the prompt was not delivered: ${dropped}`));

    const { parked, parkedTool } = await waitForTurnOutcome(conversation, {
      sinceTurn,
      timeoutMs: timeoutMs + ENGINE_PATIENCE_MARGIN_MS,
      label: markUntranslated('one-shot run')
    });

    result.turns = Math.max(0, conversation.completedTurns - sinceTurn);
    result.finalText = lastAssistantText(conversation);
    const failure = lastErrorText(conversation);
    if (parked) {
      result.status = 'parked';
      result.parkedTool = parkedTool;
    } else if (failure) {
      result.status = 'failed';
      result.errorText = failure;
    } else {
      result.status = 'completed';
    }
  } catch (err) {
    result.status = 'failed';
    result.errorText = extractErrorMessage(err);
  }

  wsService.sendOneShotResult({ requestId, ...result });
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
 * @param {any} conversation - The conversation to configure
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
 * @param {any} conversation - The conversation to read
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
 * @param {any} conversation - The conversation to read
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
