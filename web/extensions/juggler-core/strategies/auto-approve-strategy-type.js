//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { generateText } from 'juggler/ops';
import DefaultStrategyType from './default-strategy-type.js';
import { TOOL_STATES } from 'juggler/model';
import {
  POLICY_PROMPT,
  buildReviewerPrompt,
  parseReview,
  reviewFailureNote,
  isBusyRejection,
  busyRetryDelay,
  isTimeoutRejection,
  timeoutRetryDelay,
  REVIEW_TIMEOUT_MS
} from './auto-approve-reviewer.js';
import { WRITE_FILE_ITEM_TYPE, isFileEditingAllowed } from '../../../js/services/file-editing-permission.js';

/**
 * AutoApproveStrategyType - Default behavior plus an out-of-band safety reviewer
 * that silently approves parked tool calls it is confident are safe.
 *
 * This sits one rung more autonomous than Default on the autonomy axis
 * (Read-only → Default → Auto-approve → YOLO). It extends DefaultStrategyType,
 * so it inherits the full toolset and Default's approval policy unchanged: read
 * tools, allowlisted commands, and in-project edits are still auto-permitted by
 * the permission system before anything parks. Only the genuinely ambiguous
 * calls that *would* prompt you reach the `onToolPending` hook below.
 *
 * The design is **allow-only and fail-closed**. When a call parks, a cheap
 * out-of-band model classifies it and — only on a clean `allow` — resolves it.
 * Every other outcome (deny, a saturated/timed-out/errored `generateText`, a
 * malformed answer) does nothing, leaving the tool parked for the human exactly
 * as today. So this strategy can only ever *remove* an approval prompt you would
 * have granted; it can never block the model or auto-run something the reviewer
 * distrusts.
 *
 * The reviewer is shown only the user's own messages and the agent's raw tool
 * calls — never the agent's prose, never tool output (see
 * `auto-approve-reviewer.js`). In allow-only mode the only harmful mistake is a
 * wrong *allow*, and those are the two channels that manufacture one.
 *
 * **File edits are deliberately out of the reviewer's remit.** A file write only
 * reaches this hook when it has already parked, and an edit parks for exactly two
 * reasons: the conversation's file-editing toggle is off (the user asked to
 * eyeball every edit), or the write targets a path outside the project and
 * granted roots (the containment guard in `edit-base.js`, issues #23/#24). Both
 * are cases we want a human to decide, so the deterministic file-editing toggle
 * owns edits end to end and this reviewer never resolves a `write-file` action —
 * it only ever clears the routine *non-edit* prompts (allowlistable commands,
 * out-of-root reads). Approving edits wholesale is what YOLO is for.
 *
 * While `onToolPending`'s returned promise is in flight the framework surfaces a
 * transient "Auto-approve reviewing…" indicator in the approval card (label
 * derived from this manifest's `name`); the approval buttons stay fully live, so
 * the human can always decide instantly and race the reviewer. When the review
 * ends without approving, this hook resolves with a `note` and the framework
 * leaves that message in place of the spinner, so the card says why the call is
 * still sitting there instead of falling silent.
 *
 * Future (deliberately out of scope for v1): hard-deny with rationale fed back
 * to the model, a per-turn circuit breaker, and a per-strategy reviewer-model
 * setting UI.
 * @augments {DefaultStrategyType}
 */
export default class AutoApproveStrategyType extends DefaultStrategyType {
  /**
   * Strategy manifest describing capabilities and recommendations.
   *
   * MANIFEST is mandatory here even though we extend Default: static props are
   * inherited in JS, so omitting it would make this strategy report `id:
   * 'default'` and collide. (Yolo defines its own for the same reason.)
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'auto-approve',
    name: 'Auto-approve',
    version: '1.0.0',
    description: 'Like Default, but a cheap model auto-approves the routine prompts it is sure are safe — so you only get asked about the risky ones.',
    author: 'Juggler Team',
    color: 'var(--accent-green)',
    icon: 'icon-auto-awesome',
    order: 1,
    // Denied/unreviewed actions still park and use the permission toggles.
    showsApprovalControls: true,
    // Inherit Default's approval behaviour wholesale; Default ships no default
    // rules today, so there is nothing to copy.
    defaultRules: [],
    recommendations: {
      recommendedFor: [
        "Longer autonomous runs where you're semi-watching",
        'Cutting approval fatigue on routine edits and safe commands',
        'Trusted projects where most actions are benign'
      ],
      exampleTriggers: [
        "keep going without asking unless it's risky...",
        'auto-approve the safe stuff...',
        "don't stop for every little command..."
      ],
      approach: 'Auto-approve runs the same loop as Default, so the permission system still decides everything first: read tools, allowlisted commands, and in-project edits are approved automatically, and only the calls that would otherwise stop to ask you are handed off for review.\n\n'
        + 'Each parked call is checked by a cheap, fast model — the one set as your cheap model in settings — against a fixed safety policy. To keep that judgement trustworthy the reviewer sees only your own messages and the agent\'s raw tool calls; it never sees the agent\'s explanations or any tool output, so it cannot be argued into an approval or fed instructions hidden in a tool result.\n\n'
        + 'Alongside that it is given the facts of your setup as ground truth: the project root, your home directory, and the permissions you have already granted — whether file editing is on, which folders are allowed, which commands are allowlisted. Those come from your settings rather than the conversation, so the reviewer can tell routine work you have already sanctioned from something the agent decided on its own.\n\n'
        + 'The reviewer answers a simple allow or deny. A confident allow silently approves the call and the run continues. Anything else — a deny, an uncertain answer, a timeout, or an errored reviewer — leaves the call parked for you to decide, exactly as under Default, and the card tells you which it was.\n\n'
          + 'Reviews run on a small shared pool, so when a turn parks several calls at once they queue: a call refused a slot waits a moment and tries again for a few seconds before giving up and leaving itself parked. The approval buttons stay live throughout, so you can always decide instantly rather than wait.\n\n'
        + 'Because it only ever approves, the strategy can remove a prompt you would have granted but can never block the model or run something on its own that the reviewer distrusts.',
      tradeoffs: {
        pros: [
          'Fewer prompts for obviously-safe actions',
          'Can only remove prompts, never blocks or auto-runs something risky',
          'Uses a cheap/fast model, low cost per review'
        ],
        cons: [
          'Adds ~1–3s latency to a parked call while it reviews, longer when a batch of calls queues for the pool',
          'The reviewer is a probabilistic model and will sometimes leave a safe action parked',
          'Not a security boundary — for untrusted code use Read-only'
        ]
      }
    }
  };

  /**
   * Review a freshly-parked tool call out-of-band and silently approve it iff
   * the reviewer is confident it is safe and user-authorized.
   *
   * Fire-and-forget by contract (see StrategyType#onToolPending): the framework
   * does not await this, so any error just leaves the tool parked —
   * fail-closed. We only ever call `resolveApproval(_, 'yes')` on a clean
   * `allow`; for deny (or any failure) we resolve nothing and instead return a
   * `note`, which the framework leaves showing in the approval card so the human
   * knows why the call is still parked. The note is a report, not a decision —
   * returning one can never resolve, block, or change the parked call.
   * The framework only fires this hook for **gate** interactions (see
   * StrategyType#onToolPending / INTERACTION_KIND). Elicitations like
   * AskUserQuestion are never delivered here — their resolution is the user's
   * own input, which no reviewer can supply — so this method needs no guard
   * against auto-answering a question.
   * @override
   * @param {{toolUseId: string, toolName: string, toolInput: Record<string, unknown>, category: string|undefined, permissionKey: string, autoApprovable?: boolean}} info
   * @returns {Promise<{note: string}|undefined>} A note to leave in the approval card, or nothing
   */
  async onToolPending({ toolUseId, toolName, toolInput, category, permissionKey, autoApprovable }) {
    // `category` is unused in v1 but kept for future use (e.g. skipping review
    // for 'meta' tools). Reference it so the destructure isn't dead.
    void category;
    // A call the action marked non-auto-approvable (a plan submit, a recursive
    // delete of the project root or home) must never be resolved by the cheap
    // reviewer — it is a deliberate human checkpoint. Leave it parked. This is
    // the same seam the blanket auto-approve toggle honours in
    // handleNewToolAction; the reviewer is the other silent path, so it enforces
    // the seam too. (Only an explicit `false` bails — an absent field, e.g. from
    // an older caller, keeps today's behaviour.)
    if (autoApprovable === false) return;
    // File edits are never auto-approved by the reviewer — the deterministic
    // file-editing toggle owns them (see the class doc). Leave the write parked
    // for the human. Guarding on the permission key (not a tool-name list) keeps
    // every current and future edit-family plugin covered uniformly.
    if (permissionKey === WRITE_FILE_ITEM_TYPE) return;
    // Assembled once and reused across re-attempts: neither the parked call nor
    // the transcript it is judged against changes while we wait for a slot.
    // Non-throwing by construction (the builders swallow malformed input), so
    // this sits outside the attempt loop's error handling.
    //
    // Give the reviewer the real project root and home as ground truth, so a
    // delete/overwrite is judged against where it actually lands — not fooled
    // by a path substring (e.g. `tmp`) that reads as scratch. Additive signal
    // on the probabilistic path; it blocks nothing on its own.
    const prompt = buildReviewerPrompt(
      this.messageThread.items,
      { toolName, toolInput },
      { context: this._reviewContext() }
    );
    const model = /** @type {any} */ (this.state)?.reviewerModel ?? 'cheap';

    // Re-attempts are counted per cause. Being refused a slot and being answered
    // too slowly wait for different things and are worth different numbers of
    // tries, so one shared counter would let whichever failure came first spend
    // the other's schedule.
    let busyAttempts = 0;
    let timeoutAttempts = 0;

    for (;;) {
      try {
        // Budget: the verdict word plus a ~12-word reason. The verdict comes
        // first by prompt design, so even a truncated answer parses correctly.
        const { text } = await this._complete(
          { system: POLICY_PROMPT, prompt, model, maxTokens: 48, timeoutMs: REVIEW_TIMEOUT_MS },
          this._abortController?.signal
        );
        const { verdict, reason } = parseReview(text);
        if (verdict === 'allow') {
          // Provenance `strategy`: this strategy is the approving body. The value
          // names WHO approved (a strategy), not the process (an automatic review).
          this.messageThread.resolveApproval(toolUseId, 'yes', { source: 'strategy' });
          return;
        }
        // deny → resolve nothing; the tool stays parked for the human. Hand back
        // the reviewer's own words so the card explains the wait. A malformed or
        // reasonless answer yields no reason, so say only what we know.
        return {
          note: reason
            ? `Auto-approve declined: ${reason}`
            : 'Auto-approve declined — over to you'
        };
      } catch (err) {
        // A cancelled turn aborts the review in flight. That is not a reviewer
        // failure, and the user already knows they stopped it, so clear the
        // indicator rather than reporting their own cancel back at them.
        if (/** @type {any} */ (err)?.name === 'AbortError') return;

        // Two failures say "not now" rather than "no", and both are ordinary
        // conditions of a turn that parks several calls at once — every one of
        // them asks a four-slot pool for a review simultaneously.
        //
        //   429 — refused a slot. The model was never asked, so another go costs
        //         a moment. Treating this as fatal is what made the feature
        //         quietly stop working on any multi-tool turn.
        //   504 — asked, and slower than our bound. One more go, on its own
        //         shorter schedule, since this one costs the budget again.
        //
        // Give up once the relevant schedule is spent, or once the call is no
        // longer parked (the human beat us to it, so there is nothing to
        // approve and a re-attempt would spend a slot on a settled question).
        const delay = isBusyRejection(err)
          ? busyRetryDelay(busyAttempts++)
          : isTimeoutRejection(err)
            ? timeoutRetryDelay(timeoutAttempts++)
            : -1;
        if (delay >= 0 && this._stillParked(toolUseId)) {
          await this._wait(delay);
          continue;
        }

        // Fail-closed: the tool stays parked. Log for diagnosis; never rethrow.
        // The note names the actual cause — these failures need completely
        // different fixes, and a bare "unavailable" is both unactionable and
        // indistinguishable from a considered deny.
        console.error('[auto-approve] review failed, leaving parked:', err);
        return { note: reviewFailureNote(err) };
      }
    }
  }

  /**
   * The ground truth the reviewer judges the parked call against: where the
   * project and home actually are, and what the user has *already* authorized.
   *
   * The grants matter as much as the paths. The policy treats everything the
   * agent chose on its own as unauthorized until the user's own words cover it,
   * and a user who granted file editing or allowlisted `make *` authorized those
   * things by flipping a control rather than by typing a sentence — invisible in
   * a transcript of user messages. Without the grants the reviewer denies
   * ordinary in-project work (a `mkdir`, a redirect into the build dir) on the
   * grounds that nobody asked for it, which is exactly the routine prompt this
   * strategy exists to clear.
   *
   * Everything here is read from the conversation's own permission model, so it
   * is the user's authorization rather than the agent's assertion — nothing in
   * the transcript can forge it. Every read is guarded: a host that exposes its
   * thread differently degrades to omitting a line, never to a thrown review
   * (which would fail closed and silently disable the whole feature).
   * @returns {{projectRoot: string, home: string, fileEdits?: boolean, allowedPaths: string[], allowedCommands: string[]}} Environment + standing grants
   * @private
   */
  _reviewContext() {
    const mt = /** @type {any} */ (this.messageThread);
    const session = mt?.conversation?.session;
    const canReadRules = typeof mt?.getRulesFor === 'function';
    return {
      projectRoot: session?.projectPath || '',
      home: session?.home || '',
      // Left undefined (line omitted) when the rules cannot be read at all —
      // asserting either state on a guess would be worse than saying nothing.
      fileEdits: canReadRules ? isFileEditingAllowed(mt) : undefined,
      allowedPaths: mt?.getAllowedPaths?.() || [],
      // Mirrors the `execute` domain's own reading of its grants
      // (`execute/command-permission.js`): the glob rules, in order.
      allowedCommands: canReadRules
        ? mt.getRulesFor('execute')
          .filter((/** @type {any} */ r) => r.kind === 'glob' && typeof r.value === 'string')
          .map((/** @type {any} */ r) => r.value)
        : []
    };
  }

  /**
   * Thin seam around the out-of-band completion call, so tests can stub the LLM
   * without a network round-trip. Do not add logic here — it must stay a plain
   * pass-through to `generateText`.
   * @param {import('../../../js/services/ops-api.js').GenerateTextParams} params
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../../js/services/ops-api.js').GenerateTextResult>} The generated text and usage
   */
  async _complete(params, signal) {
    return generateText(params, signal);
  }

  /**
   * Thin seam around the retry backoff, so tests exercise the schedule without
   * real time passing. Do not add logic here.
   * @param {number} ms - Delay in milliseconds
   * @returns {Promise<void>} Resolves once the delay has elapsed
   */
  async _wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Whether the call is still awaiting a decision, i.e. whether re-attempting a
   * review is still worth anything. Once the human has approved or denied it
   * there is nothing left to resolve, so a pending re-attempt is abandoned
   * rather than spending a slot (and a provider call) on a settled question.
   *
   * Deliberately permissive in the other direction: when the state cannot be
   * read at all we assume it is still parked. A late review can only ever be
   * ignored — `resolveApproval` is itself guarded on PENDING — so guessing
   * "parked" risks nothing, while guessing "gone" would silently disable the
   * retry for any host that exposes its items differently.
   * @param {string} toolUseId - The parked call's id
   * @returns {boolean} True when a re-attempt is still worthwhile
   * @private
   */
  _stillParked(toolUseId) {
    const action = /** @type {any} */ (this.messageThread)?.getToolAction?.(toolUseId);
    if (!action) return true;
    const state = typeof action.get === 'function' ? action.get('state') : action.state;
    return state === undefined || state === TOOL_STATES.PENDING;
  }
}
