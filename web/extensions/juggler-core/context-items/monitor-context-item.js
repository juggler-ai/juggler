//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { MAX_EXEC_TIMEOUT_MS } from 'juggler/ops';
import { createSummaryWithSubtitle, renderLiveTaskOutput, renderTaskDeliveryControl } from 'juggler/ui';
import { isShellCommandPermitted, isShellCommandCatastrophic } from './execute/command-permission.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { inputText } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * MonitorContextItem — start a long-running background command whose output is
 * streamed back into the conversation.
 *
 * The command runs in the background (via the same server-side shell registry as
 * `bash`'s `run_in_background`). The Go worker watches the task's stdout and
 * injects new lines into the conversation at the next turn boundary — the model
 * keeps working and the events surface when it next yields. Read the full
 * captured output any time with `TaskOutput`; stop a monitor with `TaskStop`.
 *
 * The command is expected to self-filter (e.g. `tail -f log | grep ERROR`): the
 * worker forwards whatever reaches stdout, line by line. Delivery is at turn
 * boundaries, NOT a mid-turn interrupt.
 * @class
 * @augments ContextItem
 */
class MonitorContextItem extends ContextItem {
  static MANIFEST = {
    id: 'monitor',
    name: 'Monitor',
    version: '1.0.0',
    description: 'Run a background command and stream its output into the conversation',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'execute', icon: 'icon-terminal' };
  }

  /** @returns {string} Short type label shown on item cards and the permissions popup */
  static getTypeName() {
    return t('Monitor');
  }

  /**
   * Get the Monitor tool definition.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: markUntranslated('Shell command whose stdout lines become events. Self-filter so only lines you would act on are emitted (e.g. `tail -f build.log | grep --line-buffered -E "ERROR|FAILED"`), and flush every pipe stage (grep --line-buffered, awk fflush()).')
        },
        description: {
          type: 'string',
          description: markUntranslated('Short human-readable description of what is being monitored (shown with each event).')
        },
        persistent: {
          type: 'boolean',
          description: markUntranslated('Keep the monitor running for the session\'s lifetime (for log tails watched indefinitely). When false (default) it ends when the command exits or times out.')
        },
        timeout_ms: {
          type: 'number',
          description: markUntranslated(`Kill the monitor after this many milliseconds. Larger values are capped at ${MAX_EXEC_TIMEOUT_MS}. Ignored when persistent is true.`)
        }
      },
      required: ['command', 'description']
    };

    const description = markUntranslated('Start a background command whose stdout lines stream into the conversation as events, surfacing when you next yield — they are not replies from the user. Use for "tell me when the build fails / the deploy finishes". Read full output with TaskOutput; stop with TaskStop.');

    return [
      {
        name: 'Monitor',
        category: 'write',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Share the `bash` permission domain — a monitored command is still just a
   * shell command, so a grant the user already gave `bash` (an exact command or
   * a `tail *` glob) auto-approves the equivalent monitor without re-prompting.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input (unused)
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return 'execute';
  }

  /**
   * Auto-approve when the command is already permitted by the conversation's
   * `execute` rules — the same shared check the bash tool runs, so a grant the
   * user gave `bash` covers the equivalent monitor.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {boolean} True if command is auto-approved
   */
  isPermitted(toolInput) {
    return isShellCommandPermitted(/** @type {string} */ (toolInput.command || ''), {
      messageThread: this.messageThread,
      session: this.conversation.session,
      // A monitor only tails output; it never redirects into the project, so a
      // write grant must not widen what it may run.
      writeEnabled: false
    });
  }

  /**
   * A monitored command is still a shell command, so it inherits the same
   * catastrophic-deletion floor as the bash tool: a recursive/forced delete of
   * a tree it works in, an ancestor, home, or a filesystem root is never silently
   * auto-approved (it parks for an explicit human decision or YOLO). Every
   * other command stays auto-approvable.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input with command
   * @returns {boolean} False only for a catastrophic-radius recursive delete
   */
  autoApprovable(toolInput) {
    return !isShellCommandCatastrophic(
      /** @type {string} */ (toolInput?.command || ''),
      { messageThread: this.messageThread, session: this.conversation.session }
    );
  }

  /**
   * Build approval UI with a command preview.
   * @override
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    const command = /** @type {string} */ (params.command);
    const description = params.description ? String(params.description) : '';
    return {
      message: description
        ? t('Start monitor ({description}):\n\n{command}\n\nThis runs in the background; its output streams into the conversation.', { description, command })
        : t('Start monitor:\n\n{command}\n\nThis runs in the background; its output streams into the conversation.', { command })
    };
  }

  /**
   * Validate and normalize parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = toolInput;
    if (!params.command) {
      return { valid: false, error: markUntranslated('Missing required parameter: command') };
    }
    if (typeof params.command !== 'string') {
      return { valid: false, error: markUntranslated('Parameter "command" must be a string') };
    }
    if (params.timeout_ms !== undefined) {
      const timeout = Number(params.timeout_ms);
      // Accept any non-negative value and clamp to the backend cap at execute
      // time (below) rather than rejecting, so a generous timeout_ms still runs
      // (capped) instead of failing validation.
      if (isNaN(timeout) || timeout < 0) {
        return { valid: false, error: markUntranslated('Parameter "timeout_ms" must be a non-negative number') };
      }
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Start the background command. The worker observes the resulting tool-action
   * (correlated by toolUseId) and starts streaming its output into the
   * conversation.
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<Record<string, unknown>>} Monitor task descriptor
   */
  async execute(params) {
    const command = /** @type {string} */ (params.command || '');
    const description = params.description ? String(params.description) : '';
    const persistent = Boolean(params.persistent);
    // A persistent monitor wants to run as long as possible; otherwise honour
    // the requested timeout (the backend caps both at MAX_EXEC_TIMEOUT_MS).
    const timeoutMs = persistent
      ? MAX_EXEC_TIMEOUT_MS
      : (params.timeout_ms !== undefined ? Math.min(Number(params.timeout_ms), MAX_EXEC_TIMEOUT_MS) : undefined);

    const result = await this.ops.shellBackground({
      command,
      timeout: timeoutMs,
      convId: this.conversation.id,
      threadId: this.messageThread?.threadItemId || '',
      toolUseId: this.toolUseId
    });

    // Ask the worker (via the generic task-output delivery binding) to stream
    // this task's stdout into the conversation. Fire-and-forget: the binding
    // outlives this tool call and ends when the task does. The label heads each
    // delivered message, which the model reads, so it stays English.
    const label = description ? markUntranslated(`monitor: ${description}`) : markUntranslated('monitor');
    this.messageThread?.requestTaskOutputDelivery({ taskId: result.task_id, label });

    return {
      command,
      description,
      persistent,
      task_id: result.task_id,
      status: 'running',
      success: true
    };
  }

  /**
   * Format the outcome for the LLM.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{command?: string}} */ (prepared?.params || {});
    const command = prepParams.command || '';

    if (outcome.cancelled) {
      return this.failureSummary(markUntranslated('Monitor cancelled'), { details: command ? `$ ${command}` : '' });
    }
    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Failed to start monitor: ${outcome.error}`));
    }

    const result = /** @type {{task_id?: string, persistent?: boolean}} */ (outcome.result);
    const taskId = result.task_id || '';
    const persistentNote = result.persistent
      ? markUntranslated(' It is persistent and runs until you call TaskStop or the session ends.')
      : '';
    const summary = markUntranslated(`Monitor started (task ${taskId}). Matching output lines will be delivered into this conversation as they arrive — you keep working and they surface when you next yield, so don't wait for them.${persistentNote} Read full output with TaskOutput(${taskId}); stop it with TaskStop(${taskId}).`);

    return this.successSummary(summary, { details: `$ ${command}` });
  }

  /**
   * Status UI for the tool-action card.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const command = String(toolInput?.command || '');
    if (!command) return null;
    const description = toolInput?.description ? String(toolInput.description) : undefined;
    /** @type {any} */
    const result = actionStatus;

    /** @type {string|HTMLElement} */
    const summary = createSummaryWithSubtitle(command, description);
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status = 'running';
    if (result?.cancelled) {
      status = 'cancelled';
    } else if (result && !result.pending && !result.success) {
      status = 'error';
    } else if (result?.success) {
      status = 'success';
    }
    return { typeName: MonitorContextItem.getTypeName(), summary, status };
  }

  /**
   * Resolve the background-task id for this tool-action from its stored result.
   * The task id is produced server-side by `shellBackground` and persisted on
   * the tool-action under `result.fullResult.result.task_id` (see
   * `execute()` → the action-executor's `fullResult.result` plumbing). The live
   * monitor status is NOT in this outcome — it joins to the binding by task id.
   * @param {any} toolAction - The tool-action Y.Map.
   * @returns {string} The task id, or '' if not yet available.
   */
  static _taskIdFromToolAction(toolAction) {
    const resultMap = toolAction?.get?.('result');
    const plain = resultMap?.toJSON ? resultMap.toJSON() : resultMap;
    return String(plain?.fullResult?.result?.task_id || '');
  }

  /**
   * Render the properties-panel detail view: Command, Description, and — driven
   * by the live `deliverTaskOutput` binding (NOT the tool-action's frozen
   * outcome) — the shared Monitor status row + Stop button (see
   * {@link renderTaskDeliveryControl}, also used on every output chunk this
   * monitor injects), followed by a live Output section.
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {void}
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction, messageThread } = ctx;
    helpers.addSubsection(wrapper, t('Command'), inputText(input, 'command'), 'properties-panel-code');
    if (input.description) {
      helpers.addLlmDescription(wrapper, t('Description'), String(input.description));
    }

    const taskId = MonitorContextItem._taskIdFromToolAction(toolAction);
    if (!taskId || !messageThread) return;

    // The status + Stop control is shared with the injected-chunk renderer so
    // the kill affordance is identical wherever the user clicks. The command is
    // already shown above, so no label line here.
    renderTaskDeliveryControl(wrapper, { messageThread, taskId });

    // --- Live "Output" section: parity with how bash shows captured output. ---
    // The monitor's stdout/stderr is NOT in the Yjs doc (the worker pump injects
    // it into the conversation as messages); the shell registry exposes the
    // accumulated buffer, which the shared section polls. A monitor's life is its
    // delivery binding, not the task's own status, so it keeps reading while the
    // binding is Active; the status is already on the control above, so no status
    // line here. Read-only: the poll mutates no durable state, only local DOM.
    renderLiveTaskOutput(wrapper, {
      taskId,
      helpers,
      convId: this.conversation.id,
      isRunning: () => messageThread.getTaskDeliveryStatus(taskId) === 'active'
    });
  }
}

export default MonitorContextItem;
