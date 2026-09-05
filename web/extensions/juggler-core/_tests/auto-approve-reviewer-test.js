//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure `auto-approve` reviewer helpers — the transcript
 * builder and the verdict parser. No network, no message-thread mutation, so
 * these run entirely on fabricated Y.Map-like item stubs.
 *
 * The security-relevant assertions are: `buildReviewerPrompt` includes user
 * messages and agent tool calls but STRIPS assistant prose and tool results,
 * and `parseVerdict` is default-deny for anything that doesn't cleanly start
 * with `allow`.
 * @module unit-tests/auto-approve-reviewer-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import {
  POLICY_PROMPT,
  buildReviewerPrompt,
  parseReview,
  parseVerdict,
  describeReviewFailure,
  reviewFailureNote,
  isBusyRejection,
  busyRetryDelay,
  isTimeoutRejection,
  timeoutRetryDelay,
  REVIEW_TIMEOUT_MS
} from '../strategies/auto-approve-reviewer.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Build a Y.Map-like item stub: fields are read via `.get(field)`, exactly as
 * the real message-thread items are. `type` drives the isX type-guards.
 * @param {Record<string, any>} fields - Item fields (must include `type`)
 * @returns {{get: (k: string) => any}} A stub item
 */
function item(fields) {
  return { get: (k) => fields[k] };
}

const userItem = (content) => item({ type: 'user', content });
const toolItem = (toolName, toolInput) => item({ type: 'tool-action', toolName, toolInput });
const assistantItem = (content) => item({ type: 'assistant', content });
const toolResultItem = (content) => item({ type: 'tool-result', content });

/**
 * Run all auto-approve reviewer tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // =========================================================================
  // POLICY_PROMPT sanity
  // =========================================================================
  await run('POLICY_PROMPT is a non-trivial classifier prompt', () => {
    assert(typeof POLICY_PROMPT === 'string' && POLICY_PROMPT.length > 200,
      'POLICY_PROMPT should be a substantial string');
    assert(/allow/i.test(POLICY_PROMPT) && /deny/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should mention both allow and deny verdicts');
    // The verdict must lead the answer — that is what keeps parsing (and the
    // default-deny bias) correct even when the reason is cut off by maxTokens.
    assert(/reason/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should ask for a reason on deny');
    assert(/verdict/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should require the verdict word first');
    // The ENVIRONMENT block states standing grants; the policy must say they
    // count as the user's authorization, otherwise the "authorization only from
    // the user's own words" rule instructs the model to ignore the whole block.
    for (const line of ['FILE EDITS', 'ALLOWED PATHS', 'ALLOWLISTED COMMANDS']) {
      assert(POLICY_PROMPT.includes(line),
        `POLICY_PROMPT should explain the ${line} grant line`);
    }
    // ...and that the grants stop short of the dangerous categories.
    assert(/never authorize/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should bound what standing permissions authorize');
  });

  // =========================================================================
  // buildReviewerPrompt — inclusion
  // =========================================================================
  await run('includes user messages and agent tool calls', () => {
    const items = [
      userItem('please delete the temp files'),
      toolItem('bash', { command: 'rm -rf ./tmp' })
    ];
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: { command: 'ls' } });
    assert(out.includes('USER: please delete the temp files'),
      `expected user line in prompt, got:\n${out}`);
    assert(out.includes('TOOL_CALL bash: {"command":"rm -rf ./tmp"}'),
      `expected tool-call line with compact JSON, got:\n${out}`);
  });

  await run('appends the ACTION UNDER REVIEW block last with the action JSON', () => {
    const items = [userItem('hi'), toolItem('read', { file_path: '/a' })];
    const out = buildReviewerPrompt(items, { toolName: 'write', toolInput: { file_path: '/etc/x' } });
    const idx = out.indexOf('=== ACTION UNDER REVIEW ===');
    assert(idx !== -1, 'action delimiter must be present');
    assert(out.indexOf('USER: hi') < idx, 'context must come before the action block');
    const tail = out.slice(idx);
    assert(tail.includes('TOOL_CALL write: {"file_path":"/etc/x"}'),
      `action block must contain the action tool call, got:\n${tail}`);
    // Action block is genuinely last (nothing after it but the action line).
    assert(out.trim().endsWith('{"file_path":"/etc/x"}'),
      `action must be the final content, got:\n${out}`);
  });

  await run('handles empty / non-array items — still emits the action block', () => {
    const out = buildReviewerPrompt([], { toolName: 'bash', toolInput: { command: 'echo hi' } });
    assert(out.startsWith('=== ACTION UNDER REVIEW ==='),
      `empty history should still yield the action block, got:\n${out}`);
    const out2 = buildReviewerPrompt(/** @type {any} */ (null), { toolName: 'bash', toolInput: {} });
    assert(out2.includes('=== ACTION UNDER REVIEW ==='), 'null items must not throw');
  });

  await run('emits a leading ENVIRONMENT ground-truth block when context is given', () => {
    const items = [userItem('clean up the tmp dir')];
    const out = buildReviewerPrompt(
      items,
      { toolName: 'bash', toolInput: { command: 'rm -rf /home/crem/tmp/juggler' } },
      { context: { projectRoot: '/home/crem/tmp/juggler', home: '/home/crem' } }
    );
    const envIdx = out.indexOf('=== ENVIRONMENT (ground truth) ===');
    assert(envIdx === 0, `ENVIRONMENT block must lead the prompt, got:\n${out}`);
    assert(out.includes('PROJECT ROOT: /home/crem/tmp/juggler'), 'project root must be stated verbatim');
    assert(out.includes('HOME: /home/crem'), 'home must be stated verbatim');
    // Ordering: environment → history → action.
    assert(envIdx < out.indexOf('USER: clean up the tmp dir'), 'environment must precede history');
    assert(out.indexOf('USER: clean up the tmp dir') < out.indexOf('=== ACTION UNDER REVIEW ==='),
      'history must precede the action block');
  });

  await run('omits the ENVIRONMENT block when no context paths are supplied', () => {
    const out = buildReviewerPrompt([userItem('hi')], { toolName: 'bash', toolInput: {} }, { context: {} });
    assert(!out.includes('=== ENVIRONMENT'), 'no env paths → no environment block');
  });

  await run('states the standing permission grants in the ENVIRONMENT block', () => {
    // The grants are the user's authorization for work they approved with a
    // control rather than a sentence — without them the policy's "unauthorized
    // until the user's words cover it" rule denies routine in-project writes.
    const out = buildReviewerPrompt(
      [userItem('carry on')],
      { toolName: 'bash', toolInput: { command: 'mkdir -p build' } },
      {
        context: {
          projectRoot: '/home/crem/proj',
          home: '/home/crem',
          fileEdits: true,
          allowedPaths: ['/home/crem/proj', '/home/crem/scratch'],
          allowedCommands: ['make *', 'git status']
        }
      }
    );
    const env = out.slice(0, out.indexOf('USER: carry on'));
    assert(/FILE EDITS: allowed/.test(env), `edits-on must be stated, got:\n${env}`);
    assert(env.includes('ALLOWED PATHS: /home/crem/proj, /home/crem/scratch'),
      `allowed paths must be listed verbatim, got:\n${env}`);
    assert(env.includes('ALLOWLISTED COMMANDS: make *, git status'),
      `allowlisted commands must be listed verbatim, got:\n${env}`);
  });

  await run('states edits-off explicitly, and omits the line when unknown', () => {
    // `false` is signal in its own right: the user asked to see every write, so
    // the reviewer should deny file-touching commands rather than clear them.
    const off = buildReviewerPrompt([], { toolName: 'bash', toolInput: {} },
      { context: { projectRoot: '/p', fileEdits: false } });
    assert(/FILE EDITS: must be approved individually/.test(off),
      `edits-off must be stated, got:\n${off}`);
    // Absent flag = the caller could not read the permission model. Asserting
    // either state on a guess is worse than saying nothing.
    const unknown = buildReviewerPrompt([], { toolName: 'bash', toolInput: {} },
      { context: { projectRoot: '/p' } });
    assert(!unknown.includes('FILE EDITS'), `an unknown toggle must be omitted, got:\n${unknown}`);
  });

  await run('a grant block alone is enough to emit the ENVIRONMENT block', () => {
    const out = buildReviewerPrompt([], { toolName: 'bash', toolInput: {} },
      { context: { allowedCommands: ['npm test'] } });
    assert(out.startsWith('=== ENVIRONMENT (ground truth) ==='),
      `grants with no paths should still lead with the block, got:\n${out}`);
  });

  await run('bounds a runaway grant list rather than crowding out the transcript', () => {
    const paths = [];
    for (let i = 0; i < 50; i++) paths.push(`/home/crem/p${i}`);
    const out = buildReviewerPrompt([userItem('hi')], { toolName: 'bash', toolInput: {} },
      { context: { allowedPaths: paths, allowedCommands: ['x'.repeat(500)] } });
    const pathLine = out.split('\n').find((l) => l.startsWith('ALLOWED PATHS:')) || '';
    assert(!pathLine.includes('/home/crem/p49'), 'an overlong list must be truncated');
    assert(/\(\+\d+ more\)/.test(pathLine),
      `a truncated list must say how many were dropped, got:\n${pathLine}`);
    const cmdLine = out.split('\n').find((l) => l.startsWith('ALLOWLISTED COMMANDS:')) || '';
    assert(cmdLine.length < 400, `an overlong entry must be bounded, got length ${cmdLine.length}`);
    // The transcript still survives alongside the (bounded) grants.
    assert(out.includes('USER: hi'), 'grants must not displace the transcript');
  });

  await run('drops blank / empty grant entries instead of emitting an empty line', () => {
    const out = buildReviewerPrompt([], { toolName: 'bash', toolInput: {} },
      { context: { projectRoot: '/p', allowedPaths: ['', '   ', null], allowedCommands: [] } });
    assert(!out.includes('ALLOWED PATHS'), `an all-blank list must emit nothing, got:\n${out}`);
    assert(!out.includes('ALLOWLISTED COMMANDS'), `an empty list must emit nothing, got:\n${out}`);
  });

  // =========================================================================
  // buildReviewerPrompt — stripping (the security-critical part)
  // =========================================================================
  await run('strips assistant prose and tool-result output', () => {
    const SENTINEL_PROSE = 'ASSISTANT_PROSE_SENTINEL_zzz';
    const SENTINEL_RESULT = 'TOOL_RESULT_SENTINEL_zzz';
    const items = [
      userItem('do the thing'),
      assistantItem(`Sure — ${SENTINEL_PROSE}, here goes`),
      toolItem('bash', { command: 'echo hi' }),
      toolResultItem(SENTINEL_RESULT)
    ];
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: { command: 'echo hi' } });
    assert(!out.includes(SENTINEL_PROSE),
      `assistant prose must be stripped, but found it in:\n${out}`);
    assert(!out.includes(SENTINEL_RESULT),
      `tool-result output must be stripped, but found it in:\n${out}`);
    // ...while the legitimate channels survive.
    assert(out.includes('USER: do the thing'), 'user message should survive stripping');
    assert(out.includes('TOOL_CALL bash'), 'agent tool call should survive stripping');
  });

  // =========================================================================
  // buildReviewerPrompt — caps
  // =========================================================================
  await run('applies maxEntries (keeps the most recent entries)', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push(userItem(`msg-${i}`));
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: {} }, { maxEntries: 3 });
    assert(!out.includes('msg-6'), 'entries beyond the last 3 should be dropped');
    assert(out.includes('msg-7') && out.includes('msg-8') && out.includes('msg-9'),
      `the last 3 entries should survive, got:\n${out}`);
  });

  await run('applies maxEntryChars (truncates a long entry, keeps head+tail)', () => {
    const long = 'HEAD' + 'x'.repeat(500) + 'TAIL';
    const out = buildReviewerPrompt([userItem(long)], { toolName: 'bash', toolInput: {} },
      { maxEntryChars: 40 });
    const userLine = out.split('\n').find((l) => l.startsWith('USER:')) || '';
    assert(userLine.length <= 40 + 'USER: '.length + 2,
      `entry should be truncated to ~40 chars, got length ${userLine.length}`);
    assert(userLine.includes(' … '), 'truncated entry should elide the middle with " … "');
    assert(userLine.includes('HEAD') && userLine.includes('TAIL'),
      `truncation should keep head and tail, got:\n${userLine}`);
  });

  await run('applies maxTotalChars (drops oldest entries first)', () => {
    const items = [];
    // 20 entries of ~100 chars each ≈ 2000 chars total.
    for (let i = 0; i < 20; i++) items.push(userItem(`entry-${i}-` + 'y'.repeat(90)));
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: {} },
      { maxTotalChars: 400 });
    assert(!out.includes('entry-0-'), 'oldest entries should be dropped under the total cap');
    assert(out.includes('entry-19-'), 'the newest entry should survive the total cap');
    // The action block is never dropped by the total cap.
    assert(out.includes('=== ACTION UNDER REVIEW ==='), 'action block must always remain');
  });

  // =========================================================================
  // parseVerdict — default-deny bias
  // =========================================================================
  await run('parseVerdict: allow-ish strings resolve to allow', () => {
    for (const t of ['allow', ' Allow.', 'ALLOW', '`allow`', '  allow\n']) {
      assert(parseVerdict(t) === 'allow', `expected 'allow' for ${JSON.stringify(t)}`);
    }
  });

  await run('parseVerdict: everything else resolves to deny (default-deny)', () => {
    for (const t of ['deny', '', '   ', 'I think this is fine', 'allowing? no',
      'allowed', 'yes', undefined, null]) {
      assert(parseVerdict(/** @type {any} */ (t)) === 'deny',
        `expected 'deny' for ${JSON.stringify(t)}`);
    }
  });

  // =========================================================================
  // parseReview — the deny reason surfaced in the approval card
  // =========================================================================
  await run('parseReview: extracts the reason after a deny verdict', () => {
    const cases = [
      'deny: force-pushes over shared history',
      'deny — force-pushes over shared history',
      'deny - force-pushes over shared history',
      'Deny: force-pushes over shared history',
      '`deny`: force-pushes over shared history',
      'deny:\n  force-pushes over   shared history  '
    ];
    for (const t of cases) {
      const { verdict, reason } = parseReview(t);
      assert(verdict === 'deny', `expected deny for ${JSON.stringify(t)}, got ${verdict}`);
      assert(reason === 'force-pushes over shared history',
        `expected the flattened reason for ${JSON.stringify(t)}, got ${JSON.stringify(reason)}`);
    }
  });

  await run('parseReview: allow never carries a reason', () => {
    for (const t of ['allow', 'allow: looks fine to me', ' Allow.']) {
      const { verdict, reason } = parseReview(t);
      assert(verdict === 'allow', `expected allow for ${JSON.stringify(t)}`);
      assert(reason === '', `allow must carry no reason, got ${JSON.stringify(reason)}`);
    }
  });

  await run('parseReview: a verdictless or bare answer denies with no reason', () => {
    // A model that never states a verdict is malformed, not a rationale — we
    // deny, but we do not quote its confusion back at the user.
    for (const t of ['', '   ', 'I think this is fine', 'allowing? no', 'denying this one',
      undefined, null]) {
      const { verdict, reason } = parseReview(/** @type {any} */ (t));
      assert(verdict === 'deny', `expected deny for ${JSON.stringify(t)}`);
      assert(reason === '', `expected no reason for ${JSON.stringify(t)}, got ${JSON.stringify(reason)}`);
    }
    assert(parseReview('deny').reason === '', 'a bare deny carries no reason');
  });

  await run('parseReview: a runaway reason is capped', () => {
    const { reason } = parseReview(`deny: ${'x'.repeat(1000)}`);
    assert(reason.length <= 200, `reason should be capped, got length ${reason.length}`);
    assert(reason.endsWith('…'), `a truncated reason should be elided, got ${JSON.stringify(reason.slice(-5))}`);
  });

  await run('parseReview: strips a quoted reason', () => {
    assert(parseReview('deny: "reads your ssh keys"').reason === 'reads your ssh keys',
      'surrounding quotes should be stripped');
  });

  // =========================================================================
  // describeReviewFailure — a broken reviewer must say what broke
  // =========================================================================
  await run('describeReviewFailure: surfaces the message and strips the HTTP prefix', () => {
    assert(describeReviewFailure(new Error('HTTP 400: no cheap model available'))
      === 'no cheap model available', 'the HTTP prefix should be stripped');
    assert(describeReviewFailure(new Error('Too many concurrent completions, try again'))
      === 'Too many concurrent completions, try again', 'the message should survive intact');
    // Structured errors (a raw {error} body) must not render as [object Object].
    assert(describeReviewFailure({ error: 'no cheap model available' })
      === 'no cheap model available', 'a structured error should yield its message');
  });

  await run('describeReviewFailure: always yields something actionable-looking', () => {
    for (const e of [undefined, null, '', '   ', new Error('')]) {
      const out = describeReviewFailure(e);
      assert(typeof out === 'string' && out.length > 0 && !/\[object/.test(out),
        `expected a non-empty plain description for ${JSON.stringify(e)}, got ${JSON.stringify(out)}`);
    }
  });

  // =========================================================================
  // busy-pool retry — keyed on status, never on message text
  // =========================================================================
  await run('isBusyRejection: recognises 429 and nothing else', () => {
    const busy = /** @type {any} */ (new Error('Too many concurrent completions, try again'));
    busy.status = 429;
    assert(isBusyRejection(busy) === true, 'a 429 is the retryable busy rejection');
    // The identifying signal is the status. A message that merely *reads* busy
    // is not a contract, and a real failure must never be retried into silence.
    assert(isBusyRejection(new Error('Too many concurrent completions, try again')) === false,
      'message text alone must not mark an error retryable');
    for (const s of [400, 401, 500, 502, undefined]) {
      const e = /** @type {any} */ (new Error('nope'));
      e.status = s;
      assert(isBusyRejection(e) === false, `status ${s} must not be retryable`);
    }
    assert(isBusyRejection(undefined) === false, 'a missing error is not retryable');
  });

  await run('busyRetryDelay: bounded, non-decreasing schedule that terminates', () => {
    // Deterministic RNG endpoints: the whole band must stay positive and ordered.
    for (const rnd of [() => 0, () => 0.999]) {
      /** @type {number[]} */
      const schedule = [];
      for (let a = 0; ; a++) {
        const d = busyRetryDelay(a, rnd);
        if (d < 0) break;
        schedule.push(d);
        assert(a < 10, 'the schedule must terminate, not retry forever');
      }
      assert(schedule.length >= 2, `expected a few re-attempts, got ${JSON.stringify(schedule)}`);
      assert(schedule.every((d) => d > 0), `every delay must be positive, got ${JSON.stringify(schedule)}`);
      for (let i = 1; i < schedule.length; i++) {
        assert(schedule[i] >= schedule[i - 1], `schedule should not shrink: ${JSON.stringify(schedule)}`);
      }
      const total = schedule.reduce((n, d) => n + d, 0);
      assert(total <= 6000, `the whole schedule must stay within a few seconds, got ${total}ms`);
    }
  });

  await run('busyRetryDelay: jitter actually spreads collided retries', () => {
    // Without jitter every reviewer refused at the same instant would return to
    // the pool together and collide again, which is the whole failure being
    // fixed — so the same attempt must NOT always yield the same delay.
    const lo = busyRetryDelay(0, () => 0);
    const hi = busyRetryDelay(0, () => 0.999);
    assert(hi > lo, `attempt 0 should span a range, got ${lo}..${hi}`);
    assert(lo > 0, 'even the lowest jitter must still wait');
  });

  // =========================================================================
  // slow-model retry — a bound that elapsed is not a broken reviewer
  // =========================================================================
  await run('isTimeoutRejection: recognises 504 and nothing else', () => {
    const slow = /** @type {any} */ (new Error("The model didn't answer in time"));
    slow.status = 504;
    assert(isTimeoutRejection(slow) === true, 'a 504 is the retryable timeout rejection');
    // The two retryable failures must stay distinct: they wait for different
    // things and are worth different numbers of attempts.
    assert(isBusyRejection(slow) === false, 'a timeout must not read as a busy pool');
    for (const s of [400, 429, 500, 502, undefined]) {
      const e = /** @type {any} */ (new Error('nope'));
      e.status = s;
      assert(isTimeoutRejection(e) === false, `status ${s} must not read as a timeout`);
    }
    assert(isTimeoutRejection(undefined) === false, 'a missing error is not a timeout');
  });

  await run('timeoutRetryDelay: terminates, and far sooner than the busy schedule', () => {
    for (const rnd of [() => 0, () => 0.999]) {
      /** @type {number[]} */
      const schedule = [];
      for (let a = 0; ; a++) {
        const d = timeoutRetryDelay(a, rnd);
        if (d < 0) break;
        schedule.push(d);
        assert(a < 10, 'the schedule must terminate, not retry forever');
      }
      // Re-attempting a timeout costs the whole bound again, so the schedule is
      // deliberately shorter than the busy one, where the model was never asked.
      assert(schedule.length >= 1, 'a slow model deserves at least one more go');
      assert(schedule.length < 3, `a timeout must not be retried repeatedly, got ${JSON.stringify(schedule)}`);
      assert(schedule.every((d) => d > 0), `every delay must be positive, got ${JSON.stringify(schedule)}`);
    }
    assert(timeoutRetryDelay(0, () => 0.999) > timeoutRetryDelay(0, () => 0),
      'collided timeouts must be spread by jitter, exactly as busy ones are');
  });

  await run('the whole review budget still fits inside one old-style attempt', () => {
    // The retry is not extra patience: the reviewer asks for a shorter bound and
    // spends the same wall-clock as two tries instead of one long wait. If this
    // ever exceeds the server default a slow review would hold a shared pool slot
    // for longer than it did before the retry existed.
    let backoff = 0;
    for (let a = 0; ; a++) {
      const d = timeoutRetryDelay(a, () => 0.999);
      if (d < 0) break;
      backoff += d;
    }
    const attempts = 2;
    const total = attempts * REVIEW_TIMEOUT_MS + backoff;
    assert(REVIEW_TIMEOUT_MS > 5000, `the bound must leave a cheap model room to answer, got ${REVIEW_TIMEOUT_MS}ms`);
    assert(total <= 32000, `the whole budget must stay near the 30s it replaced, got ${total}ms`);
  });

  // =========================================================================
  // reviewFailureNote — the line left on the approval card
  // =========================================================================
  await run('reviewFailureNote: names the failure, distinctly per cause', () => {
    const withStatus = (/** @type {number} */ status) => {
      const e = /** @type {any} */ (new Error('server prose'));
      e.status = status;
      return e;
    };
    const busy = reviewFailureNote(withStatus(429));
    const slow = reviewFailureNote(withStatus(504));
    const dead = reviewFailureNote(new Error('HTTP 400: no cheap model available'));
    for (const note of [busy, slow, dead]) {
      assert(/^Auto-approve couldn't run/.test(note), `every note names the feature, got ${JSON.stringify(note)}`);
    }
    assert(/too many reviews/i.test(busy), `a busy pool should describe the queue, got ${JSON.stringify(busy)}`);
    assert(/too long/i.test(slow), `a timeout should say it was slow, got ${JSON.stringify(slow)}`);
    // No Go internals on an approval card: "context deadline exceeded" is what
    // this whole classification exists to stop leaking into the UI.
    assert(!/context deadline|deadline exceeded/i.test(slow),
      `a timeout must read as English, got ${JSON.stringify(slow)}`);
    assert(busy !== slow, 'the two retryable failures must not read identically');
    assert(dead.includes('no cheap model available'),
      `an unclassified failure must keep its cause, got ${JSON.stringify(dead)}`);
  });

  await run('describeReviewFailure: caps a runaway body (e.g. an HTML error page)', () => {
    const out = describeReviewFailure(new Error('<html>' + 'x'.repeat(5000)));
    assert(out.length <= 120, `expected a capped description, got length ${out.length}`);
    assert(out.endsWith('…'), 'a truncated description should be elided');
  });

  return { passed, failed, errors };
}
