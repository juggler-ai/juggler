//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tool-action helpers extracted from Conversation. Pure-function helpers that
 * take the Conversation instance (`c`) as their first argument; the class
 * methods become one-line delegators.
 *
 * The tool lifecycle is command-driven: the Go worker observes every doc
 * update and drives each tool-action by commanding the engine
 * (`evaluate-tool` → `handleNewToolAction`, `execute-tool` →
 * `claimRunning` + `executeToolAction`, `cancel-tool`). The engine has no
 * reactive tool reducer.
 * @module model/conversation-tool-actions
 */

import {
  isToolActionMessage,
  TOOL_STATES,
} from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import toolExecutor from '../services/tool-executor.js';
import { resolveToolName } from '../services/tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isViewer } from '../../sdk/lib/client-role.js';
import { plain, yGet } from './item-accessor.js';
import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
import { INTERACTION_KIND } from '../../sdk/context-item.js';
import { runBeforeToolHooks } from '../services/hook-runtime.js';

/** @typedef {import('../../sdk/lib/message.js').Message} Message */

/**
 * Framework-owned, strategy-agnostic label for the review indicator shown while
 * a strategy's `onToolPending` promise is in flight. Derived from the strategy's
 * own manifest so no strategy-specific string leaks into the core: an explicit
 * `static REVIEW_LABEL` wins, else "<name> reviewing…", else a generic fallback.
 * @param {any} strategy - The message thread's strategy instance
 * @returns {string} Human-readable review label
 */
function reviewLabelFor(strategy) {
  const override = strategy?.constructor?.REVIEW_LABEL;
  if (override) return override;
  const name = strategy?.constructor?.MANIFEST?.name;
  return name ? `${name} reviewing…` : 'Reviewing…';
}

/**
 * Cap on a strategy-authored review note. The note is arbitrary text from a
 * strategy (typically an LLM reviewer's own words), so the framework bounds what
 * it will write into the doc rather than trusting the caller.
 * @type {number}
 */
const MAX_REVIEW_NOTE_CHARS = 240;

/**
 * Write the transient `reviewStatus` field of a parked tool-action — the state
 * behind the approval card's review indicator. Two shapes are written: a busy
 * status while a strategy's `onToolPending` reviewer holds the call (stamped by
 * the parking transaction itself, so the call never reads as awaiting the user
 * while a reviewer might still take it), and a non-busy status carrying the
 * strategy's closing note once it settles. `null` clears the field.
 *
 * Only ever writes while the tool is still PENDING. On the allow path the tool
 * has already transitioned to APPROVED and the approval surface is gone, so
 * there is nothing to annotate; the stale field is harmless and we leave it
 * untouched rather than write onto a resolved item.
 *
 * Written as an engine-derived update so the worker's UndoManager skips it,
 * matching the sibling approvalOptions/displayData writes.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {{busy: boolean, label: string}|null} status - The status to write, or null to clear
 */
function writeReviewStatus(messageThread, toolUseId, status) {
  const conversation = messageThread.conversation;
  if (!conversation?._doc) return;
  conversation.engineDerivedUpdate(() => {
    const items = messageThread.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
        if (item.get('state') === TOOL_STATES.PENDING) {
          messageThread.updateItemField(i, 'reviewStatus', status);
        }
        break;
      }
    }
  });
}

/**
 * Turn a settled `onToolPending` result into the closing review status. A
 * strategy may resolve with `{note}` to leave a short explanation in the
 * approval card (e.g. why its reviewer declined to approve); anything else —
 * `undefined`, a non-string note, an empty one — simply clears the indicator.
 * The note is trimmed, flattened to one line, and capped; it is displayed as
 * text, never markup.
 * @param {any} result - Whatever the hook's promise resolved with
 * @returns {{busy: boolean, label: string}|null} The status to write, or null to clear
 */
function closingReviewStatus(result) {
  const note = typeof result?.note === 'string' ? result.note.replace(/\s+/g, ' ').trim() : '';
  if (!note) return null;
  return { busy: false, label: note.slice(0, MAX_REVIEW_NOTE_CHARS) };
}

/**
 * The approval-card line for a call a hook is holding for the user.
 * @param {import('../services/hook-runtime.js').HookRecord} record - The hook that asked
 * @returns {string} The line
 */
function hookHoldNote(record) {
  return `Held for you by hook "${record.name}"` + (record.reason ? `: ${record.reason}` : '');
}

/**
 * Execute a tool action that has been approved (state='running').
 * Called by the items observer when it detects a running tool without a result.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {any} conversation - Conversation instance
 */
export async function executeToolAction(messageThread, toolUseId, conversation) {
  const toolAction = messageThread.getToolAction(toolUseId);
  if (!toolAction || toolAction.get('state') !== TOOL_STATES.RUNNING) {
    return;
  }

  const toolName = toolAction.get('toolName');

  // Worker-managed tools: execution handled by Go worker, skip browser-side execution
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (ActionClass?.MANIFEST?.workerManaged) {
    return;
  }
  const toolInput = toolAction.get('toolInput');

  try {
    const toolCall = {
      id: toolUseId,
      name: toolName,
      input: plain(toolInput)
    };

    await toolExecutor.executeToolCall(toolCall, conversation._responseHandler, messageThread);
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    console.error(`[ToolExec] Error: ${toolName} (${toolUseId}): ${errorMessage}`);
    messageThread.completeToolAction(toolUseId, {
      content: `Tool execution failed: ${errorMessage}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
  }
}

/**
 * Evaluations running now, by conversation and toolUseId. The worker re-sends an
 * `evaluate-tool` that has gone unanswered for its re-drive interval, and a
 * second evaluation started beside a first that is still waiting on a hook
 * would run every hook twice. A re-sent command joins the one in flight instead.
 * @type {Map<string, Promise<void>>}
 */
const evaluationsInFlight = new Map();

/**
 * Handle a newly created tool-action with undefined state.
 * Checks plugin manifest to determine if approval is needed.
 * Called by the items observer when a new tool-action is inserted.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {any} conversation
 * @param {any} [existingYMap]
 * @returns {Promise<void>}
 */
export function handleNewToolAction(messageThread, toolUseId, conversation, existingYMap = null) {
  if (isViewer()) return Promise.resolve();
  const key = `${conversation?.id}\u0000${toolUseId}`;
  const inFlight = evaluationsInFlight.get(key);
  if (inFlight) return inFlight;
  const evaluation = evaluateNewToolAction(messageThread, toolUseId, conversation, existingYMap)
    .finally(() => evaluationsInFlight.delete(key));
  evaluationsInFlight.set(key, evaluation);
  return evaluation;
}

/**
 * The body of {@link handleNewToolAction}, run once per evaluation.
 * @param {import('./message-thread.js').default} messageThread
 * @param {string} toolUseId
 * @param {any} conversation
 * @param {any} existingYMap
 * @returns {Promise<void>}
 */
async function evaluateNewToolAction(messageThread, toolUseId, conversation, existingYMap) {

  const toolAction = existingYMap || messageThread.getToolAction(toolUseId);
  if (!toolAction) return;

  const toolName = toolAction.get('toolName');
  const toolInputPlain = yGet(toolAction, 'toolInput');
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (!ActionClass) {
    messageThread.completeToolAction(toolUseId, {
      content: `Unknown tool: ${toolName}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: `Unknown tool: ${toolName}` }
    });
    return;
  }

  // Worker-managed tools: execution handled by Go worker, skip browser-side
  // execution. Stamp executor='worker' authoritatively (this is where the plugin
  // manifest is actually known) so the worker's tool-execution-report liveness
  // rule can skip tools it executes itself — the engine's executor is not their
  // liveness oracle and they never appear in a report. Additive field, written
  // as an engine-derived update like every other derivation here so undo skips it.
  if (ActionClass.MANIFEST?.workerManaged) {
    if (toolAction.get('executor') !== 'worker') {
      conversation.engineDerivedUpdate(() => {
        toolAction.set('executor', 'worker');
      });
    }
    return;
  }

  const action = new ActionClass({
    id: ActionClass.MANIFEST?.id || 'unknown',
    session: conversation._session,
    conversation,
    messageThread,
    // Lets a multi-tool class (e.g. the MCP bridge) route validate/approval to
    // the invoked tool. Omitting it makes such a class validate with an empty
    // name and reject its own call — the "Unknown MCP tool """ failure.
    toolName: resolveToolName(toolName)
  });

  let prepared;
  try {
    prepared = await action.prepare(toolInputPlain);
  } catch (err) {
    const errorMessage = extractErrorMessage(err);
    messageThread.completeToolAction(toolUseId, {
      content: `Action preparation failed: ${errorMessage}`,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
    return;
  }

  if (!prepared.valid) {
    const errorMessage = prepared.error || 'Validation failed';
    messageThread.completeToolAction(toolUseId, {
      content: errorMessage,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage }
    });
    return;
  }

  // Whether this specific call may be SILENTLY auto-approved by an unattended
  // path. Defaults to true; an action returns false for a call that must always
  // reach a human even in auto-approve mode (a plan submit; a recursive delete
  // of the project root or home). It gates the silent/default paths (the blanket
  // auto-approve toggle and its out-of-band reviewer) and is passed to the
  // strategy's getApprovalPolicy so a blanket auto-approve (YOLO) declines it
  // too. A saved rule and an explicit human approval are unaffected.
  const autoApprovable = action.autoApprovable?.(toolInputPlain) ?? true;

  // Is this call already covered by a saved permission rule? Computed once and
  // reused for both the approval decision and the provenance stamp below.
  const permitted = action.isPermitted(toolInputPlain);

  // Tool hooks rule before the strategy does (services/hook-runtime.js). A deny
  // ends the call here; an ask and an allow feed the decision below. They are
  // awaited — the one wait on this path besides prepare() — and bounded well
  // under the worker's re-drive interval, so the evaluate is answered in time.
  const hookOutcome = await runBeforeToolHooks({
    messageThread,
    conversationId: conversation.id,
    threadId: messageThread.threadItemId || conversation.id,
    toolUseId,
    toolName,
    toolInput: toolInputPlain || {},
  });
  // Another evaluation may have settled the call while the hooks ran (a reset
  // and re-evaluation, a cancel). Only a call still unevaluated is ours to rule on.
  if (hookOutcome.records.length && (toolAction.get('state') || '') !== '') return;
  if (hookOutcome.verdict === 'deny') {
    const denier = /** @type {import('../services/hook-runtime.js').HookRecord} */ (hookOutcome.decidedBy);
    const errorMessage = `Blocked by hook "${denier.name}"` + (denier.reason ? `: ${denier.reason}` : '.');
    messageThread.completeToolAction(toolUseId, {
      content: errorMessage,
      isError: true,
      resultType: 'action',
      fullResult: { state: 'error', success: false, error: errorMessage },
      hooks: hookOutcome.records
    });
    return;
  }

  // The action's own default decision: needs approval unless it never requires
  // it, or is already permitted by a rule, or the conversation is in the blanket
  // auto-approve toggle AND this call is auto-approvable. A non-auto-approvable
  // call ignores the blanket toggle and still parks for a human.
  const defaultApproval = action.requiresApproval() &&
                          !permitted &&
                          (!conversation._autoApprove || !autoApprovable);

  // The strategy has master control over approval (YOLO approves everything,
  // read-only auto-approves read/meta tools).
  // Consult it exactly as response-handler._determineApprovalNeeded does, so a
  // live strategy switch takes effect for every tool evaluated afterwards — the
  // metadata observer rebuilds messageThread.strategy on the switch, so this
  // reads the current policy with no extra plumbing.
  const toolDefs = ActionClass.getToolDefinitions?.() || [];
  const toolDef = toolDefs.find((/** @type {{name: string}} */ t) => t.name === toolName);
  const strategyPolicy = messageThread.strategy?.getApprovalPolicy?.({
    toolName,
    toolInput: toolInputPlain,
    category: toolDef?.category,
    defaultApproval,
    // The parked-state kind (gate vs elicitation). Lets a policy decline to
    // stand in for the user on an elicitation (e.g. AskUserQuestion), whose
    // resolution IS the user's typed answer — so a blanket auto-approve (YOLO)
    // never silently answers a question. Same discriminant the gate-only
    // onToolPending dispatch keys off below.
    interactionKind: action.interactionKind(),
    // Whether this specific call may be silently auto-approved. False for a
    // deliberate human checkpoint (a plan submit; a catastrophic delete), which
    // must reach a human even under a blanket auto-approve — so YOLO returns
    // DEFAULT for it and it parks, the same floor the auto-approve reviewer honours.
    autoApprovable
  });

  // A hook's allow stands where a saved permission rule would: it waives the
  // action's own default, never a strategy that requires approval, and never a
  // call that must reach a human (an elicitation, a non-auto-approvable checkpoint).
  const hookAllows = hookOutcome.verdict === 'allow'
    && autoApprovable
    && action.interactionKind() === INTERACTION_KIND.GATE;
  const hookAsks = hookOutcome.verdict === 'ask';

  let needsApproval;
  if (hookAsks) {
    // A hook that asks wins over everything but a deny: the user decides this
    // call, whatever the strategy or the saved rules would have done.
    needsApproval = true;
  } else if (strategyPolicy === APPROVAL_POLICY.APPROVE) {
    // A force-approve strategy (YOLO) has returned APPROVE for this call. Its
    // own getApprovalPolicy already excludes the calls that must still reach a
    // human — elicitations and non-auto-approvable checkpoints both come back as
    // DEFAULT, not APPROVE — so an APPROVE here is a genuine grant to skip the gate.
    needsApproval = false;
  } else if (strategyPolicy === APPROVAL_POLICY.REQUIRE_APPROVAL) {
    needsApproval = true;
  } else {
    needsApproval = defaultApproval && !hookAllows;
  }
  const approvedByHook = hookAllows && !needsApproval && defaultApproval
    && strategyPolicy !== APPROVAL_POLICY.APPROVE;

  // Is a strategy reviewer about to be handed this call (see the onToolPending
  // dispatch below)? Decided here, before the park is written, because the park
  // is the moment the conversation announces that it wants the user: the
  // attention alert fires from the very transaction that commits PENDING. A
  // call a reviewer may yet approve without the user is not that news, so it
  // parks already marked as under review and the alert waits for the review to
  // end and leave it parked. `onToolPending` always exists — StrategyType
  // defines the no-op — so the question is whether this strategy overrides it.
  // Not when a hook asked: that hook wants the user, not a stand-in for them.
  const strategyReviews = needsApproval
    && !hookAsks
    && action.interactionKind() === INTERACTION_KIND.GATE
    && typeof messageThread.strategy?.onToolPending === 'function'
    && messageThread.strategy.onToolPending !== StrategyType.prototype.onToolPending;

  // All writes below are pure derivations of the just-observed tool-action
  // (toolName + toolInput + plugin manifest), so they go through
  // engineDerivedUpdate and the worker's UndoManager skips them — otherwise
  // undo of the tool-action's insert would only pop these derivations and the
  // engine would immediately re-derive on the next observer tick.
  conversation.engineDerivedUpdate(() => {
    if (needsApproval) {
      const approvalOptions = conversation._responseHandler.buildApprovalOptions(action, prepared);
      // CAS guard: only write pending if still unstarted (ifState: '').
      // A concurrent handleNewToolAction call that beat us to APPROVED would
      // have the tool executing; don't reset it to pending.
      messageThread.updateToolActionState(toolUseId, TOOL_STATES.PENDING, { ifState: '' });
      const items = messageThread.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
          messageThread.updateItemField(i, 'approvalOptions', approvalOptions);
          messageThread.updateItemField(i, 'displayData', prepared.displayData);
          // Parked under review: written here rather than after the hook is
          // dispatched so it is already true when this transaction commits.
          // The CAS above can have declined to park a call another observer got
          // to first, so only mark one that actually reached PENDING.
          if (strategyReviews && item.get('state') === TOOL_STATES.PENDING) {
            messageThread.updateItemField(i, 'reviewStatus', {
              busy: true,
              label: reviewLabelFor(messageThread.strategy)
            });
          } else if (hookAsks && item.get('state') === TOOL_STATES.PENDING) {
            // Say in the approval card which hook is holding the call, and why.
            messageThread.updateItemField(i, 'reviewStatus', closingReviewStatus({
              note: hookHoldNote(/** @type {any} */ (hookOutcome.decidedBy))
            }));
          }
          if (hookOutcome.records.length) {
            messageThread.updateItemField(i, 'hooks', hookOutcome.records);
          }
          break;
        }
      }
    } else {
      // Set state to 'approved' — the worker observes this and commands the
      // engine to execute (`execute-tool` → claimRunning atomically claims
      // approved → running, then executeToolAction launches the work).
      // Writing 'running' directly would skip the claim.
      // CAS guard: only write approved if still unstarted (ifState: '').
      // Prevents a late-arriving duplicate handleNewToolAction call from
      // resetting RUNNING → APPROVED and triggering a second execution.
      messageThread.updateToolActionState(toolUseId, TOOL_STATES.APPROVED, { ifState: '' });
      // Stamp approval provenance for the UI, naming the approving body. A saved
      // permission rule permitted it → `rule`. Otherwise the active strategy
      // approved it without individual confirmation — a force-approve strategy
      // (YOLO / read-only for read+meta tools), or the headless auto-approve
      // test flag → `strategy`. The value names WHO approved, not the mechanism.
      // A hook's allow that waived the gate names the hook as the approver.
      const approvalSource = permitted ? 'rule' : approvedByHook ? 'hook' : 'strategy';
      const items = messageThread.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
          messageThread.updateItemField(i, 'approvalSource', approvalSource);
          if (hookOutcome.records.length) {
            messageThread.updateItemField(i, 'hooks', hookOutcome.records);
          }
          break;
        }
      }
    }
  });

  // The tool has now parked awaiting approval (state=PENDING committed above).
  // Notify the strategy so out-of-band approval automation (e.g. a cheap-model
  // auto-approve classifier) can review it and resolve via resolveApproval.
  //
  // GATE INTERACTIONS ONLY. An elicitation (e.g. AskUserQuestion) parks with an
  // approval surface that is a user-input form, not a go/no-go gate — its
  // resolution IS the user's answer, which no proxy can supply. Handing it to a
  // reviewer could only produce a resolution that silently answers for the
  // user, so the dispatch simply never fires for elicitations: there is no code
  // path by which approval automation can resolve one. onToolPending's contract
  // (see StrategyType) is therefore gate-only, and strategies need no per-call
  // guard.
  //
  // Fire-and-forget by contract: this whole function is engine-only (viewers
  // returned at the top), so the hook runs exactly once per park — no viewer
  // election. We deliberately do NOT await it: getApprovalPolicy above is the
  // synchronous decision, and blocking the gate on an async classifier would
  // stall the evaluate-tool ack. A throw or a rejected promise is swallowed
  // here so it never becomes an unhandled rejection; the tool simply stays
  // PENDING for the human (fail-closed).
  //
  // Never for a call a hook asked the user about: that hook wants the human,
  // and a reviewer approving it would be exactly the stand-in it ruled out.
  if (needsApproval && !hookAsks && action.interactionKind() === INTERACTION_KIND.GATE) {
    try {
      const pendingResult = messageThread.strategy?.onToolPending?.({
        toolUseId,
        toolName,
        toolInput: toolInputPlain,
        category: toolDef?.category,
        // The action's permission key (e.g. 'write-file' for every edit-family
        // tool). Lets a strategy tell apart classes of parked call that share a
        // category — edits and shell commands are both category 'write', but
        // only edits report the 'write-file' key — so e.g. auto-approve can
        // defer all file edits to the deterministic file-editing toggle.
        permissionKey: action.getPermissionKey(toolInputPlain),
        // Whether this call may be silently auto-approved. A reviewer must not
        // resolve a call that is false here (a plan submit, a project-root
        // deletion) — it stays parked for a human.
        autoApprovable
      });
      if (pendingResult && typeof pendingResult.then === 'function') {
        // The hook returned a still-pending promise: the strategy is reviewing
        // this parked call out-of-band, which is what the call parked marked as
        // (the "reviewing…" indicator is already showing, and the approval
        // buttons are fully live beside it — the indicator is purely additive).
        //
        // When it settles, a resolved `{note}` replaces the spinner with that
        // message and leaves it in the card, so a call still sitting there says
        // why (e.g. the reviewer declined, and its reason); anything else clears
        // the indicator as if it had never run. A note is display only — it
        // cannot resolve the tool, which still waits for the human. Either way
        // the settling write is what lets the call read as awaiting the user,
        // and the alert it was holding back fires from it.
        pendingResult
          .then((/** @type {unknown} */ result) => {
            writeReviewStatus(messageThread, toolUseId, closingReviewStatus(result));
          })
          .catch((/** @type {unknown} */ err) => {
            console.error('[handleNewToolAction] onToolPending rejected:', err);
            writeReviewStatus(messageThread, toolUseId, null);
          });
      } else if (strategyReviews) {
        // The hook returned without a promise, so no review is in flight after
        // all: drop the mark the park applied. The call is now plainly waiting
        // for the user, and this write is the edge that says so.
        writeReviewStatus(messageThread, toolUseId, null);
      }
    } catch (err) {
      console.error('[handleNewToolAction] onToolPending threw:', err);
      if (strategyReviews) writeReviewStatus(messageThread, toolUseId, null);
    }
  }
}

/**
 * Atomically transition a tool-action from APPROVED → RUNNING. Returns
 * true iff this caller made the transition (i.e., "claimed" the execution).
 * The compare-and-set is safe because Yjs observer callbacks are synchronous:
 * no other observer can interleave between the read and the write inside
 * the same transact() block.
 * @param {any} c - Conversation instance
 * @param {any} ymap - Tool-action Y.Map
 * @returns {boolean} True if this caller transitioned APPROVED → RUNNING
 */
export function claimRunning(c, ymap) {
  let claimed = false;
  // APPROVED → RUNNING is a pure derivation of the previously-approved
  // state, so it goes through engineDerivedUpdate and the worker's
  // UndoManager doesn't see it as a separate undoable step.
  c.engineDerivedUpdate(() => {
    if (ymap.get('state') === TOOL_STATES.APPROVED) {
      ymap.set('state', TOOL_STATES.RUNNING);
      // Stamp the moment execution actually starts so the properties
      // panel's "Running… Xs" elapsed digit anchors to *this* run, not
      // the tool-action's original creation timestamp. Crucial for
      // re-runs of old tool-actions — without it the elapsed time would
      // read "50 hours" against the original timestamp.
      ymap.set('runningStartedAt', Date.now());
      // runningEpoch is the immutable per-incarnation execution generation.
      // Bump it on every claim so a cancel signal (or liveness evidence) can
      // be scoped to the exact execution it was issued against: a re-run of
      // the same toolUseId claims a strictly higher epoch, so a stale cancel
      // meant for the previous execution mismatches and is ignored. Unlike
      // runningStartedAt (a wall-clock stamp that two claims can share within a
      // millisecond, and which the reset paths clear), the epoch is a
      // monotonic counter that survives reattach resets — the next claim
      // increments past it — so it is a true generation identity.
      ymap.set('runningEpoch', (Number(ymap.get('runningEpoch')) || 0) + 1);
      claimed = true;
    }
  });
  return claimed;
}

/**
 * Re-stamp RUNNING onto a tool-action this engine is already executing but whose
 * doc state has fallen back to APPROVED. Returns true iff it repaired the doc.
 *
 * claimRunning's compare-and-set keeps a re-driven `execute-tool` harmless only
 * while the `running` it wrote stays in the doc: driveToolActions selects on doc
 * state, so `running` is what stops it re-driving. If that write is lost — a
 * replica reloaded under the execution, or a merge that reverts `state` — the
 * worker re-drives and the CAS legitimately succeeds a second time, running the
 * tool twice. handleExecuteTool declines the second run; this repairs the doc so
 * the worker stops re-driving, rather than re-driving to its attempt cap and
 * escalating a tool that is still genuinely executing to a terminal error.
 *
 * The stamps come from the in-flight execution, NOT from a fresh claim:
 * runningEpoch is the incarnation identity a later cancel-tool must match, so
 * re-asserting has to restore it rather than bump it.
 * @param {any} c - Conversation instance
 * @param {any} ymap - Tool-action Y.Map
 * @param {{runningEpoch: number|undefined, runningStartedAt: number|undefined}} execution -
 *   The in-flight execution's stamps (ActionExecutor.runningActionFor)
 * @returns {boolean} True if the doc read APPROVED and was repaired to RUNNING
 */
export function reassertRunning(c, ymap, execution) {
  let repaired = false;
  c.engineDerivedUpdate(() => {
    if (ymap.get('state') !== TOOL_STATES.APPROVED) return;
    ymap.set('state', TOOL_STATES.RUNNING);
    if (execution.runningStartedAt) ymap.set('runningStartedAt', execution.runningStartedAt);
    if (execution.runningEpoch) ymap.set('runningEpoch', execution.runningEpoch);
    repaired = true;
  });
  return repaired;
}

/**
 * Persist the auto-approval grant for a 'yes-always' response. Every grant flows
 * through the plugin's `getApprovalSuggestions` pipeline: a suggestion button
 * carries its exact rules/paths on the tool-action (the common case), and a bare
 * 'yes-always' derives the grant from the plugin's narrowest suggestion (or a
 * framework boolean default). There is no separate per-plugin save method.
 * @param {any} c - Conversation instance
 * @param {any} ymap - The tool-action Y.Map
 * @param {import('./message-thread.js').default} messageThread
 */
export function saveAutoApprovalPermission(c, ymap, messageThread) {
  // Preferred path: the approval button carried the exact rules the chosen
  // suggestion should persist (escalating breadth the user selected). Add
  // them verbatim under the suggestion's itemType — no re-derivation, so the
  // saved permission can't drift from what the button promised.
  const approvalRules = ymap.get('approvalRules');
  const approvalItemType = ymap.get('approvalItemType');
  if (approvalRules && approvalItemType) {
    const rules = plain(approvalRules);
    for (const r of rules) {
      messageThread.addRule(approvalItemType, { kind: r.kind, value: r.value, scope: r.scope });
    }
    return;
  }

  // Path-grant suggestion: the chosen button promised to add folders to the
  // conversation's allowed-paths list (the framework-generic FS roots), not a
  // plugin rule. Add them verbatim — after which isPermitted re-passes the
  // command without any command-shape wildcard.
  const approvalAllowedPaths = ymap.get('approvalAllowedPaths');
  if (approvalAllowedPaths) {
    const paths = plain(approvalAllowedPaths);
    for (const p of paths) {
      messageThread.addAllowedPath(p, { scope: 'conversation' });
    }
    return;
  }

  // Bare 'yes-always' (no button-carried rules — e.g. a programmatic approval
  // that didn't go through the escalating-suggestion buttons): derive the grant
  // from the plugin's own suggestion pipeline. The narrowest suggestion is the
  // default remembered grant (its rules make isPermitted true by construction);
  // a plugin that offers none gets a framework boolean default under its
  // permission key. This is the single approval-persistence system — there is no
  // separate per-plugin save path.
  const toolName = ymap.get('toolName');
  const toolInput = yGet(ymap, 'toolInput') || {};
  const ActionClass = contextItemRegistry.getByToolName(toolName);
  if (!ActionClass) return;
  const actionId = /** @type {any} */ (ActionClass).MANIFEST?.id || toolName;
  const action = new ActionClass({
    id: actionId,
    session: c._session,
    conversation: c,
    messageThread
  });
  const suggestions = action.getApprovalSuggestions?.(toolInput) || [];
  const grant = suggestions[0] || {
    itemType: action.getPermissionKey(toolInput),
    rules: [{ kind: 'boolean', value: true, scope: 'conversation' }],
  };
  if (grant.itemType && grant.rules) {
    for (const r of grant.rules) {
      messageThread.addRule(grant.itemType, { kind: r.kind, value: r.value, scope: r.scope ?? 'conversation' });
    }
  }
  if (grant.allowedPaths) {
    for (const p of grant.allowedPaths) {
      messageThread.addAllowedPath(p, { scope: 'conversation' });
    }
  }
}

/**
 * Re-check all currently pending approvals against the conversation's latest
 * permission rules, approving any that the owning plugin now permits.
 *
 * This is intentionally keyed off the central permission metadata observer
 * rather than individual approval buttons, so rules added from any surface
 * ("yes-always", permission popup, sync from another client, tests) have the
 * same effect.
 * @param {any} c - Conversation instance
 * @param {{allowViewer?: boolean, itemTypes?: string[]}} [options] Filter/recheck options
 */
export function approvePermittedPendingApprovals(c, options = {}) {
  const opts = /** @type {{allowViewer?: boolean, itemTypes?: string[]}} */ (options);
  if (isViewer() && !opts.allowViewer) return;
  for (const messageThread of c.getAllMessageThreads()) {
    const pending = messageThread.getPendingApprovalMessages();
    for (const toolAction of pending) {
      const toolUseId = toolAction.get('toolUseId');
      const toolName = toolAction.get('toolName');
      const toolInputPlain = yGet(toolAction, 'toolInput');
      const ActionClass = contextItemRegistry.getByToolName(toolName);
      if (!ActionClass) continue;

      const actionId = /** @type {any} */ (ActionClass).MANIFEST?.id || toolName;
      if (opts.itemTypes && !opts.itemTypes.includes(actionId)) continue;
      const action = new ActionClass({
        id: actionId,
        session: c._session,
        conversation: c,
        messageThread
      });

      try {
        if (action.isPermitted(toolInputPlain || {})) {
          // A saved permission rule now covers this call — provenance `rule`
          // (a prior explicit grant), so the UI leaves it un-flagged.
          messageThread.resolveApproval(toolUseId, 'yes', { source: 'rule' });
        }
      } catch (err) {
        console.error(`[Conversation] re-check approval ${toolUseId}:`, err);
      }
    }
  }
}
