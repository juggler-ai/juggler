//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Ephemeral agent runs, from the caller's side: a prompt carried out by a
 * strategy and a model in a conversation no tab ever shows, whose answer comes
 * back here and whose transcript is thrown away.
 *
 * The server keeps the run (cmd/juggler/server/agent_runs.go) and the engine
 * carries it out (engine-one-shot.js); this end starts it, hears its progress
 * and its single result over this realm's socket, and cancels it.
 * @module services/agent-runs
 */

import wsService from './websocket.js';
import { markUntranslated } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} AgentRunProgress
 * @property {string} toolUseId - The tool call
 * @property {string} toolName - The tool it called
 * @property {string} summary - What the call is doing, as a line a person can read
 */

/**
 * @typedef {object} AgentRunResult
 * @property {'completed'|'parked'|'failed'|'cancelled'|'timeout'} status - How the run ended
 * @property {string} text - The run's last assistant message: its answer
 * @property {number} turns - How many model responses the run took
 * @property {string} parkedTool - The tool it stopped on, when parked
 * @property {string} errorText - What went wrong, when it did
 * @property {string} errorKind - A failure a caller can act on: 'busy' (too many
 *   runs are going; try again later) or 'max-turns'
 * @property {string} conversationId - The conversation it worked in, already gone
 */

/**
 * @typedef {object} AgentRunRequest
 * @property {string} prompt - What to do
 * @property {string} [strategy] - The strategy to run under (default yolo)
 * @property {'cheap'|'default'|{provider: string, model: string, thinking?: string}} [model] - The model (default 'default')
 * @property {string} [workspaceId] - The workspace to work in ('' = the project)
 * @property {number} [maxTurns] - The most model responses it may take; 0 is no cap
 * @property {number} [timeoutMs] - Its deadline (the server's default when omitted)
 * @property {string} [name] - A label for its conversation, for logs
 * @property {(progress: AgentRunProgress) => void} [onProgress] - Called once per tool call
 */

/**
 * A frame field as text, '' when it is not text.
 * @param {unknown} value - The field
 * @returns {string} The text
 */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * A fresh run id.
 * @returns {string} The id
 */
function newRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run a prompt as an ephemeral agent and resolve with how it ended. It never
 * rejects: every way a run can end, refusals included, is a result.
 * @param {AgentRunRequest} request - The run
 * @param {AbortSignal} [signal] - Aborting it cancels the run
 * @returns {Promise<AgentRunResult & {runId: string}>} How the run ended
 */
export function runAgent(request, signal) {
  const { prompt, strategy = 'yolo', model, workspaceId = '', maxTurns = 0, timeoutMs = 0, name = '', onProgress } = request;
  const runId = newRunId();
  /**
   * @param {Partial<AgentRunResult>} fields - What is known of the end
   * @returns {AgentRunResult & {runId: string}} The whole result
   */
  const resultOf = (fields) => ({
    runId,
    status: 'failed',
    text: '',
    turns: 0,
    parkedTool: '',
    errorText: '',
    errorKind: '',
    conversationId: '',
    ...fields
  });

  if (signal?.aborted) return Promise.resolve(resultOf({ status: 'cancelled' }));

  return new Promise((resolve) => {
    /** @type {Array<() => void>} */
    const offs = [];
    /** @param {AgentRunResult & {runId: string}} result - The end */
    const finish = (result) => {
      for (const off of offs.splice(0)) off();
      resolve(result);
    };

    offs.push(wsService.on('agent-run-progress', (/** @type {any} */ data) => {
      if (data?.runId !== runId) return;
      try {
        onProgress?.({ toolUseId: text(data.toolUseId), toolName: text(data.toolName), summary: text(data.summary) });
      } catch (err) {
        console.error('[agent-run] progress callback failed:', err);
      }
    }));
    offs.push(wsService.on('agent-run-result', (/** @type {any} */ data) => {
      if (data?.runId !== runId) return;
      finish(resultOf({
        status: data.status,
        text: text(data.text),
        turns: Number(data.turns) || 0,
        parkedTool: text(data.parkedTool),
        errorText: text(data.errorText),
        errorKind: text(data.errorKind),
        conversationId: text(data.conversationId)
      }));
    }));
    // The server ends a run whose requester disconnects, and its result has
    // nowhere to go, so the end is decided here.
    offs.push(wsService.on('close', () => {
      finish(resultOf({ errorText: markUntranslated('the connection to the server closed before the run finished') }));
    }));
    if (signal) {
      // Cancelled by the server's own result, which follows the cancel.
      const onAbort = () => wsService.sendAgentRunCancel(runId);
      signal.addEventListener('abort', onAbort, { once: true });
      offs.push(() => signal.removeEventListener('abort', onAbort));
    }

    const sent = wsService.sendAgentRunStart({
      runId,
      prompt: String(prompt || ''),
      strategyId: strategy,
      ...(model ? { model } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(maxTurns > 0 ? { maxTurns } : {}),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(name ? { name } : {})
    });
    if (!sent) finish(resultOf({ errorText: markUntranslated('not connected to the server, so the run could not start') }));
  });
}
