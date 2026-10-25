//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the strategy `onToolPending` hook — the sanctioned seam an
 * auto-approve strategy uses to review a parked tool with an out-of-band model
 * and then resolve it. Drives the real engine gate (`handleNewToolAction`)
 * directly with a stub strategy attached to the message thread, rather than the
 * worker-commanded path, so the hook contract is exercised in isolation.
 *
 * Contract under test:
 *   1. A tool that parks PENDING fires onToolPending exactly once, with the
 *      tool's id, name, input, and category.
 *   2. A tool the strategy auto-approves does NOT fire onToolPending (it never
 *      parked).
 *   3. Resolving from inside onToolPending (the auto-approve flow) transitions
 *      the parked tool PENDING → APPROVED.
 *   4. A throwing onToolPending is swallowed — the tool stays PENDING
 *      (fail-closed) and the gate still returns.
 *   5. An *elicitation* tool (AskUserQuestion) parks PENDING but does NOT fire
 *      the hook — the dispatch is gate-only, so approval automation can never
 *      resolve (and thereby silently answer) a user-input form.
 *   6. A still-pending onToolPending promise stamps `reviewStatus.busy` (+ a
 *      manifest-derived label) on the parked tool for the promise's lifetime,
 *      and clears it when the promise settles while the tool is still PENDING.
 *   7. A synchronous (non-thenable) hook leaves no `reviewStatus`.
 *   8. If the tool resolves before the promise settles (the allow path), the
 *      clear is a guarded no-op — it never writes onto the resolved item.
 *   9. A hook that resolves with `{note}` leaves a settled (non-busy)
 *      `reviewStatus` carrying that note, so a still-parked call says why; a
 *      rejected hook clears instead, and the note never resolves the tool.
 *  10. A hook that refuses the call (`refuseApproval`) settles it as a FAILED
 *      tool, not a cancelled one — the worker stops the turn on a cancelled
 *      tool, so a refusal recorded that way would end the run.
 *  11. A call under review never reads as awaiting the user while the reviewer
 *      holds it — not even in the transaction that parks it, which is the one
 *      the attention alert fires from — and does read that way the moment the
 *      review ends and leaves it parked.
 * @module unit-tests/tool-pending-hook-test
 */

import {
  initializeRegistries,
  createTestSession,
  createGateTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { handleNewToolAction } from '../../js/model/conversation-tool-actions.js';
import {
  hasPendingApprovalInTree,
  hasUnattendedPendingApprovalInTree
} from '../../js/model/thread-navigation.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Insert an unstarted (no-state) tool-action so the engine gate treats it as a
 * freshly-observed call and runs its approval logic (the CAS guards key off an
 * empty current state).
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @param {string} command - bash command to place in toolInput
 * @returns {string} The toolUseId, for convenience
 */
function insertUnstartedBash(conversation, toolUseId, command) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'bash',
    toolInput: { command }
  }));
  followStates(conversation, toolUseId);
  return toolUseId;
}

/**
 * Every state each tool-action in this suite has been through, from the moment
 * it was inserted, by toolUseId.
 * @type {Map<string, {conversation: any, seen: string[]}>}
 */
const stateTrails = new Map();

/** Whether a read has already printed the trails, so the rest stay one line. */
let trailsPrinted = false;

/**
 * Every state write that reached a call from outside this realm, as
 * `toolUseId → state`. The only writer out there is the pool's engine, acting
 * on the worker's `evaluate-tool` / `execute-tool` for a call it was sent.
 * @type {string[]}
 */
const remoteWrites = [];

/**
 * Start recording a just-inserted tool-action's state.
 * @param {any} conversation - The conversation it was inserted into.
 * @param {string} toolUseId - Its id.
 * @returns {void}
 */
function followStates(conversation, toolUseId) {
  const ta = conversation.rootMessageThread.getToolAction(toolUseId);
  const seen = [ta ? `inserted ${ta.get('state') ?? '(no state)'}` : 'NOT FOUND right after insert'];
  ta?.observe((/** @type {any} */ event) => {
    if (!event.keysChanged.has('state')) return;
    const state = String(ta.get('state') ?? '(cleared)');
    seen.push(event.transaction.local ? state : `${state} (remote)`);
    if (!event.transaction.local) remoteWrites.push(`${toolUseId} → ${state}`);
  });
  stateTrails.set(toolUseId, { conversation, seen });
}

/**
 * A tool-action's state, for an assertion's message. A state that never arrived
 * says which half was missing: the gate runs only as the engine
 * (`isViewer()` returns early), and only on a call it can find. The first such
 * read prints the history of every call in the suite, since one unread state
 * has been every case's at once.
 * @param {any} mt - The message thread it lives in.
 * @param {string} toolUseId - Its id.
 * @returns {string} The state, or an account of why there is none.
 */
function stateOf(mt, toolUseId) {
  const ta = mt.getToolAction(toolUseId);
  const state = ta?.get('state');
  if (state !== undefined) return String(state);
  const here = `undefined — ${ta ? 'found' : 'NOT found'} in a thread of ${(mt.items || []).length} items, ` +
    `JUGGLER_ENGINE=${String(/** @type {any} */ (globalThis).JUGGLER_ENGINE)} now`;
  if (trailsPrinted) return `${here} (state histories with the first such read)`;
  trailsPrinted = true;
  const trails = [...stateTrails].map(([id, { conversation, seen }]) => `${id}@${conversation.id}: ${seen.join(' → ')}`);
  return `${here}; every call's states since insert: [${trails.join('; ')}]`;
}

/**
 * One call's states since insert, for an assertion that failed on a state that
 * did arrive (stateOf prints the histories only for one that did not).
 * @param {string} toolUseId - Its id.
 * @returns {string} The history, `inserted … → …`.
 */
function trailOf(toolUseId) {
  const trail = stateTrails.get(toolUseId);
  return trail ? `states since insert: ${trail.seen.join(' → ')}` : 'no state history recorded';
}

/**
 * Insert an unstarted AskUserQuestion tool-action — an *elicitation*, whose
 * approval surface is a user-input form rather than a go/no-go gate.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @returns {string} The toolUseId, for convenience
 */
function insertUnstartedAsk(conversation, toolUseId) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' }
        ],
        multiSelect: false
      }]
    }
  }));
  followStates(conversation, toolUseId);
  return toolUseId;
}

/**
 * Run all onToolPending hook tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  stateTrails.clear();
  remoteWrites.length = 0;
  trailsPrinted = false;

  await initializeRegistries();
  const session = await createTestSession();

  // The gate returns early for viewers; run these as the engine so the approval
  // logic (and the hook) actually execute. Restore afterwards.
  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  try {
    // =======================================================================
    // Test 1: parking a tool fires onToolPending once, with the tool info
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      /** @type {any[]} */
      const calls = [];
      const toolUseId = insertUnstartedBash(conversation, 'pending-1', 'echo pending-hook');
      // Force the park with REQUIRE_APPROVAL rather than relying on the command
      // being unsafe — execute auto-permits safe commands like `echo`, which
      // would otherwise approve before parking. 'require-approval' models a
      // "review everything" strategy and makes the fire path deterministic.
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => { calls.push(info); }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING, `should park pending, got ${stateOf(mt, toolUseId)}`);
      assert(calls.length === 1, `onToolPending should fire exactly once, got ${calls.length}`);
      assert(calls[0].toolUseId === toolUseId, 'hook receives toolUseId');
      assert(calls[0].toolName === 'bash', `hook receives toolName, got ${calls[0].toolName}`);
      assert(calls[0].toolInput?.command === 'echo pending-hook', 'hook receives plain toolInput');
      assert(calls[0].category === 'write', `bash category should be write, got ${calls[0].category}`);
      // permissionKey lets a strategy tell edits apart from same-category shell
      // commands (both category 'write'); bash must NOT report the edit key.
      assert(typeof calls[0].permissionKey === 'string' && calls[0].permissionKey !== 'write-file',
        `hook receives a non-edit permissionKey for bash, got ${calls[0].permissionKey}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`fires on park: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 2: an auto-approved tool never parks, so the hook must NOT fire
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      /** @type {any[]} */
      const calls = [];
      const toolUseId = insertUnstartedBash(conversation, 'approved-1', 'echo no-hook');
      // YOLO-like: approve everything. needsApproval becomes false → APPROVED,
      // and onToolPending must not be called.
      mt.strategy = {
        getApprovalPolicy: () => 'approve',
        onToolPending: (/** @type {any} */ info) => { calls.push(info); }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.APPROVED, `should auto-approve, got ${stateOf(mt, toolUseId)}`);
      assert(calls.length === 0, `onToolPending must NOT fire for an auto-approved tool, got ${calls.length}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`skips when auto-approved: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 3: resolving from inside onToolPending approves the parked tool
    // (the auto-approve strategy's core flow)
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'resolve-1', 'echo resolved');
      // Force the park so this genuinely exercises the hook: without it firing,
      // the tool would stay PENDING and this test would fail — so a pass proves
      // the hook ran and resolved.
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => {
          // Classify → approve. The tool is PENDING at hook time, so this flips
          // it to APPROVED exactly as a real cheap-model verdict would.
          mt.resolveApproval(info.toolUseId, 'yes');
        }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.APPROVED,
        `resolving in the hook should approve the tool, got ${stateOf(mt, toolUseId)}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`resolve from hook: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 4: a throwing onToolPending is swallowed — the tool stays PENDING
    // (fail-closed) and the gate still completes.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'throws-1', 'echo boom');
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => { throw new Error('classifier exploded'); }
      };

      // Must not reject even though the hook throws.
      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING,
        `a throwing hook must leave the tool parked (fail-closed), got ${stateOf(mt, toolUseId)}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`throwing hook is fail-closed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 5: an elicitation (AskUserQuestion) parks but never fires the hook.
    // Even under a "review everything" strategy, a user-input form is not a
    // delegable gate — the dispatch must exclude it so no reviewer can resolve
    // (and thereby answer) it.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      /** @type {any[]} */
      const calls = [];
      const toolUseId = insertUnstartedAsk(conversation, 'elicit-1');
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => { calls.push(info); }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING,
        `an elicitation should still park pending, got ${stateOf(mt, toolUseId)}`);
      assert(calls.length === 0,
        `onToolPending must NOT fire for an elicitation, got ${calls.length}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`elicitation skips the hook: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 6: a still-pending onToolPending promise marks the parked tool with
    // reviewStatus.busy (+ a manifest-derived label); settling it clears the
    // field while the tool is still PENDING (the deny/leave-parked path).
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'review-1', 'echo reviewing');
      /** @type {() => void} */
      let releaseHook = () => {};
      const gate = new Promise((res) => { releaseHook = res; });
      // Class-based stub so reviewLabelFor reads a real static MANIFEST.name.
      class StubReviewStrategy {
        static MANIFEST = { name: 'Stub' };
        getApprovalPolicy() { return 'require-approval'; }
        onToolPending() { return gate; }
      }
      mt.strategy = new StubReviewStrategy();

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING, `should park pending, got ${stateOf(mt, toolUseId)}`);
      const rs = ta?.get('reviewStatus');
      const busy = rs && (rs.get ? rs.get('busy') : rs.busy);
      assert(busy === true, `reviewStatus.busy should be true during review, got ${busy}`);
      const label = rs && (rs.get ? rs.get('label') : rs.label);
      assert(label === 'Stub reviewing…', `label should come from the manifest, got ${label}`);

      // Settle the reviewer promise; the .catch().finally() chain clears on a
      // later task. Drain a macrotask so the clear has run.
      releaseHook();
      await gate;
      await new Promise((r) => setTimeout(r, 0));

      const rsAfter = ta?.get('reviewStatus');
      assert(rsAfter === null || rsAfter === undefined,
        `reviewStatus should be cleared after the promise settles, got ${JSON.stringify(rsAfter)}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`reviewStatus set-then-clear: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 7: a synchronous (non-thenable) onToolPending leaves no reviewStatus
    // — the indicator is tied to an in-flight promise, and there is none, so the
    // mark the park applied is dropped the moment the hook returns without one.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'review-sync-1', 'echo sync');
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        // Returns undefined — no promise, so no indicator.
        onToolPending: () => {}
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING, `should park pending, got ${stateOf(mt, toolUseId)}`);
      const rs = ta?.get('reviewStatus');
      assert(rs === null || rs === undefined,
        `reviewStatus must not be set for a synchronous hook, got ${JSON.stringify(rs)}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`synchronous hook sets no reviewStatus: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 8: if the tool is resolved (APPROVED) before the review promise
    // settles — the allow path — the clear is a guarded no-op: it must not
    // write onto the already-resolved item.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'review-approve-1', 'echo approve');
      /** @type {() => void} */
      let releaseHook = () => {};
      const gate = new Promise((res) => { releaseHook = res; });
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => gate
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      // Reviewer approved out-of-band before its promise settled.
      assert(mt.resolveApproval(toolUseId, 'yes') === true,
        `the parked call should take the approval, got ${stateOf(mt, toolUseId)} (${trailOf(toolUseId)})`);

      // What the clear may not do is write: no reviewStatus, no return to
      // pending.
      /** @type {string[]} */
      const clearWrites = [];
      const watchClear = (/** @type {any} */ event) => {
        if (event.keysChanged.has('reviewStatus')) clearWrites.push('reviewStatus');
        if (event.keysChanged.has('state') && ta?.get('state') === TOOL_STATES.PENDING) clearWrites.push('state → pending');
      };
      ta?.observe(watchClear);
      try {
        releaseHook();
        await gate;
        await new Promise((r) => setTimeout(r, 0));
      } finally {
        ta?.unobserve(watchClear);
      }

      assert(clearWrites.length === 0,
        `clear must not write onto a resolved tool, wrote [${clearWrites.join(', ')}] (${trailOf(toolUseId)})`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`clear is a no-op on a resolved tool: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 9: a hook resolving with {note} leaves a settled reviewStatus on the
    // still-parked tool (the "why is this still asking?" message), while a
    // rejecting hook clears the indicator entirely.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'review-note-1', 'echo note');
      /** @type {(v: any) => void} */
      let releaseHook = () => {};
      const gate = new Promise((res) => { releaseHook = res; });
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => gate
      };

      await handleNewToolAction(mt, toolUseId, conversation);
      releaseHook({ note: '  Auto-approve declined:\n force-pushes over shared history  ' });
      await gate;
      await new Promise((r) => setTimeout(r, 0));

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING,
        `a note must never resolve the tool, got ${stateOf(mt, toolUseId)}`);
      const rs = ta?.get('reviewStatus');
      const busy = rs && (rs.get ? rs.get('busy') : rs.busy);
      const label = rs && (rs.get ? rs.get('label') : rs.label);
      assert(busy === false, `a settled note must not stay busy, got ${JSON.stringify(busy)}`);
      // Flattened to one line and trimmed by the framework before it lands.
      assert(label === 'Auto-approve declined: force-pushes over shared history',
        `expected the flattened note, got ${JSON.stringify(label)}`);

      // A long note lands whole: the card is the only place it is ever shown.
      const longNote = `Auto-approve couldn't run — ${'the provider said something long. '.repeat(14).trim()}`;
      const longId = insertUnstartedBash(conversation, 'review-note-long', 'echo long');
      /** @type {(v: any) => void} */
      let releaseLong = () => {};
      const longGate = new Promise((res) => { releaseLong = res; });
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => longGate
      };
      await handleNewToolAction(mt, longId, conversation);
      releaseLong({ note: longNote });
      await longGate;
      await new Promise((r) => setTimeout(r, 0));
      const longRs = mt.getToolAction(longId)?.get('reviewStatus');
      const longLabel = longRs && (longRs.get ? longRs.get('label') : longRs.label);
      assert(longLabel === longNote,
        `a ${longNote.length}-char note should land whole, got ${JSON.stringify(longLabel)}`);

      // A rejecting hook reports nothing: the indicator clears.
      const failId = insertUnstartedBash(conversation, 'review-note-2', 'echo fail');
      /** @type {(e: any) => void} */
      let rejectHook = () => {};
      const failGate = new Promise((_res, rej) => { rejectHook = rej; });
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => failGate
      };

      await handleNewToolAction(mt, failId, conversation);
      rejectHook(new Error('reviewer exploded'));
      await failGate.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));

      const failTa = mt.getToolAction(failId);
      const failRs = failTa?.get('reviewStatus');
      assert(failRs === null || failRs === undefined,
        `a rejected hook must clear the indicator, got ${JSON.stringify(failRs)}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`settled note sticks, rejection clears: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 10: refusing a parked call settles it as a failed tool
    //
    // The worker reads a CANCELLED tool as a human denial and stops the turn
    // (anyBatchCancelled, thread_reducer.go). Automation declining on behalf of
    // an absent user means the opposite — "this one call didn't work, carry on"
    // — so refuseApproval completes the call with an error result instead. This
    // is what lets a sub-agent, which has no human to approve anything, refuse
    // a parked call without ending its own run.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'refused-1', 'echo refuse me');
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => {
          mt.refuseApproval(info.toolUseId, 'Refused: nobody here can approve that.');
        }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.COMPLETED,
        `a refusal must settle the call as completed, got ${stateOf(mt, toolUseId)}`);
      const result = ta?.get('result');
      /**
       * @param {string} k - Result field name
       * @returns {any} The field, read through Y.Map or plain object
       */
      const field = (k) => (result?.get ? result.get(k) : result?.[k]);
      assert(field('isError') === true,
        'a refused call must report as an error, so the model sees a tool that failed');
      assert(field('cancelled') !== true,
        'a refused call must NOT be flagged cancelled — the worker reads that as a denial and stops the turn');
      assert(String(field('content') || '').includes('Refused'),
        `the refusal reason must reach the model, got ${JSON.stringify(field('content'))}`);

      // Already settled: a second refusal writes nothing and says so.
      assert(mt.refuseApproval(toolUseId, 'again') === false,
        'refuseApproval must report false for a call that has already left PENDING');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`refusal completes rather than cancels: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 11: a call a reviewer holds is not awaiting the user
    //
    // The attention alert (chime, flash, dock bounce) is raised from inside the
    // transaction that parks a call, by walking the tree for a pending one —
    // so a call this hook is about to review has to be marked under review by
    // that same transaction, or the user is interrupted for a call the reviewer
    // then silently approves. The observations here are taken from the doc
    // change itself, which is the only place the difference is visible: by the
    // time the gate returns, the mark is present either way.
    // =======================================================================
    try {
      const conversation = await createGateTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'review-attention-1', 'echo attention');
      /** @type {(v?: any) => void} */
      let releaseHook = () => {};
      const gate = new Promise((res) => { releaseHook = res; });
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => gate
      };

      /** @type {Array<{parked: boolean, unattended: boolean}>} */
      const seen = [];
      const unsubscribe = session.subscribe((/** @type {any} */ e) => {
        if (e.type !== 'conversation:changed' || e.data?.conversationId !== conversation.id) return;
        seen.push({
          parked: hasPendingApprovalInTree(mt.items),
          unattended: hasUnattendedPendingApprovalInTree(mt.items)
        });
      });

      try {
        await handleNewToolAction(mt, toolUseId, conversation);

        // Guards the assertion below: it is only worth anything if the park was
        // actually observed as a doc change.
        assert(seen.some((o) => o.parked),
          'the park should have been observed as a change to this conversation');
        assert(!seen.some((o) => o.unattended),
          'a call under review was announced as awaiting the user — that is the false alarm');

        // The reviewer declines and leaves the call parked: now it IS the user's,
        // and the write that says so is a change the alert can fire from.
        seen.length = 0;
        releaseHook({ note: 'Declined' });
        await gate;
        await new Promise((r) => setTimeout(r, 0));

        assert(hasUnattendedPendingApprovalInTree(mt.items) === true,
          'a call left parked by a finished review must read as awaiting the user');
        assert(seen.some((o) => o.unattended),
          'the end of the review must itself be observable, or the held-back alert never fires');
      } finally {
        unsubscribe();
      }

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a reviewed call is not awaiting the user: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 12: nothing but this suite's own gate moved any call
    //
    // Every case above asserts what the gate it calls did. The pool's engine
    // runs the same gate, with the conversation's real policy, for any call the
    // worker sees — under which `echo` is a safe command, approved and run — so
    // a call that reached the worker could be decided twice, and whichever
    // evaluation got there first set the state the case then read.
    // =======================================================================
    try {
      assert(remoteWrites.length === 0,
        `a call's state was written from outside this lane, so the worker drove it: [${remoteWrites.join('; ')}]`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`only the suite's gate decides its calls: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
