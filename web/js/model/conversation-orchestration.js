//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy/LLM orchestration entry points for a Conversation. Free functions
 * taking the conversation as their first arg so `Conversation` itself stays
 * focused on Yjs document ownership and state accessors; orchestration is its
 * own concern.
 *
 * Public Conversation methods delegate here so external callers
 * (`conversation.continueThread(...)`) are unchanged.
 * @module model/conversation-orchestration
 */

import workerManager from '../services/worker-manager.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * Wait for user to approve/deny a tool use.
 * @param {import('./conversation.js').default} conversation
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @returns {Promise<string>} 'yes', 'no', 'yes-always', or 'cancel'
 */
export async function waitForApproval(conversation, messageThread, toolUseId) {
  if (conversation._autoApprove) return 'yes';

  while (true) {
    const message = messageThread.getToolAction(toolUseId);

    if (!message) return 'cancel';

    if (message.get('state') !== TOOL_STATES.PENDING && messageThread.hasToolResult(toolUseId)) {
      const response = message.get('approvalResponse');
      if (response) return response;
      if (message.get('state') === TOOL_STATES.RUNNING || message.get('state') === TOOL_STATES.COMPLETED) return 'yes';
      return 'cancel';
    }

    await conversation._waitForStateChange();
  }
}

/**
 * Continue the conversation without a user message.
 *
 * The guards below make this a no-op whenever something else is already driving
 * the conversation — which is why `beforeContinue` exists. A caller that has to
 * change the transcript to make its continue meaningful (the error item's Retry,
 * which deletes the dead error so it is never sent to the model) cannot do that
 * work up front: it would land even when the continue turns out to be a no-op,
 * leaving the user with neither the error nor a retry. Nor can it do the work
 * afterwards, since by then the worker may already have built the request. So it
 * hands the work to us and we run it here, past the guards and before the worker
 * is told.
 * @param {import('./conversation.js').default} conversation
 * @param {import('./message-thread.js').default} messageThread
 * @param {(() => void)} [beforeContinue] - Run only if the continue is going ahead.
 * @returns {Promise<boolean>} True when a continue was actually started.
 */
export async function continueThread(conversation, messageThread, beforeContinue) {
  const { default: actionExecutor } = await import('../services/action-executor.js');

  // Asked of THIS thread, not the whole conversation: a sibling being driven is
  // no reason to refuse a continue here — the worker admits an idle thread while
  // others run.
  if (messageThread.isProcessing || actionExecutor.hasRunningActions() || messageThread.hasBusyItems()) {
    return false;
  }

  messageThread.cancelPendingApprovals();
  beforeContinue?.();

  conversation.announceTurnRequested();

  if (workerManager.isWorkerReady(conversation.id)) {
    workerManager.continue(conversation.id, messageThread.threadItemId);
    return true;
  }

  // Turns are driven exclusively by the Go worker; there is no viewer-side loop.
  // If the worker isn't up yet (still starting, or spawn failed), refuse rather
  // than running anything on the main thread.
  conversation.showWarning('Still connecting to the engine — try again in a moment.', 5000);
  return false;
}
