//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The read-before-mutate freshness guard, from the write side: the write tool's
 * exemption from it, and writes to one file that land within the same turn.
 *
 * What counts as having seen a file is `edit-staleness-guard`; the two share
 * `edit-staleness-helpers.js`, which says why they are two suites.
 * @module unit-tests/edit-staleness-guard-writes
 */

import { createTestConversation, assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile, readFile } from '../../../js/services/ops-api.js';
import { recordWrittenHash, __resetWrittenHashesForTest } from '../context-items/read-history.js';
import { handleNewToolAction } from '../../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../../sdk/lib/message.js';
import { BOGUS_HASH, makeGuardHarness } from './edit-staleness-helpers.js';

/**
 * States for the calls of a case that drives validate and execute itself. The
 * conversation's worker and engine are live, so a seeded call they would run —
 * an approved one, or one a reattach resets from running — races the case's
 * own execute and edits the file under it. The edit's own record only places
 * it in its turn, so it is terminal; the reads are parked, which nothing runs
 * and the deferred guard still counts as unfinished.
 */
const OWN_RECORD = TOOL_STATES.CANCELLED;
const UNRUN_READ = TOOL_STATES.PENDING;

/**
 * Append one call of a model turn: a tool-action stamped with the turn's
 * `transactionId`, as the worker writes a turn's calls. A `running` call gets
 * the claim stamp a real claim leaves, so nothing takes it for stuck.
 * @param {any} conversation - Conversation instance
 * @param {string} turn - The turn's transactionId
 * @param {string} toolUseId - The call's id
 * @param {string} toolName - The tool called
 * @param {Record<string, unknown>} toolInput - Its input
 * @param {import('../../../sdk/lib/message.js').ToolState} [state] - Its lifecycle state; absent means not yet evaluated
 * @returns {void}
 */
function addTurnCall(conversation, turn, toolUseId, toolName, toolInput, state) {
  conversation.rootMessageThread.addEvent({
    ...createToolActionMessage({ toolUseId, toolName, toolInput, ...(state ? { state } : {}) }),
    transactionId: turn,
    ...(state === TOOL_STATES.RUNNING ? { runningStartedAt: Date.now() } : {})
  });
}

/**
 * @typedef {import('./edit-staleness-helpers.js').TestResult} TestResult
 */

/**
 * Run the write-side freshness guard tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  const { session, EditClass, WriteClass, mkItem, seedSeen, test, results } = await makeGuardHarness();

  // =========================================================================
  // Write tool: a whole-file overwrite has no freshness precondition, so
  // neither a never-read file nor one whose bytes moved since the last read is
  // refused. The approval diff renders the file's CURRENT contents against the
  // proposed ones, so the user sees every byte the write destroys — the human
  // is the guard here. The edit tool keeps the guard because its approval UI
  // shows only the changed hunk.
  // =========================================================================
  await test('never-read overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-clobber.txt', content: 'precious\n' });

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber.txt', content: 'gone\n' });
    assert(res.valid === true, `never-read overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-clobber-stale.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-stale.txt', BOGUS_HASH);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-stale.txt', content: 'gone\n' });
    assert(res.valid === true, `stale overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('never-read overwrite still diffs against current bytes', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-clobber-diff.txt', content: 'precious\n' });

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-diff.txt', content: 'gone\n' });
    assert(res.valid === true, `never-read overwrite must be allowed, got ${JSON.stringify(res)}`);
    const approval = await write.getApprovalConfig(res.params || {});
    const diff = /** @type {any} */ (approval)?.display?.diffData;
    assert(diff?.oldContent === 'precious\n',
      `approval diff must show the bytes being destroyed, got ${JSON.stringify(diff?.oldContent)}`);
    assert(diff?.newContent === 'gone\n',
      `approval diff must show the replacement, got ${JSON.stringify(diff?.newContent)}`);
  });

  await test('new-file write allowed', async () => {
    const conversation = await createTestConversation(session);
    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-brand-new.txt', content: 'fresh\n' });
    assert(res.valid === true, `creating a new file must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('read-then-overwrite allowed', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-clobber-ok.txt', content: 'precious\n' });
    seedSeen(conversation, 'read', 'guard-clobber-ok.txt', writeRes.contentHash);

    const write = mkItem(WriteClass, conversation);
    const res = await write.validate({ file_path: 'guard-clobber-ok.txt', content: 'replaced\n' });
    assert(res.valid === true, `read-then-overwrite must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // In-flight sibling edits: when several edits to the same file execute within
  // one assistant turn, an earlier edit's completed tool-action (carrying its
  // post-edit hash) may not yet be visible in the durable transcript when the
  // next edit validates. recordWrittenHash captures that hash synchronously at
  // execute time, so the follow-up edit is NOT spuriously refused as stale —
  // while a genuine out-of-band change the edit cannot apply to (old_str no
  // longer present) still is.
  // =========================================================================
  await test('same-turn sibling edit passes via written-hash record', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    // The transcript only knows the v0 the model read.
    const v0 = await writeFile({ path: 'guard-sibling.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-sibling.txt', v0.contentHash);

    // An earlier edit this turn rewrote the file to v1, but its tool-action has
    // not surfaced in the transcript yet — only the in-memory record knows v1.
    const v1 = await writeFile({ path: 'guard-sibling.txt', content: 'hello there\n' });
    recordWrittenHash(conversation, session, 'guard-sibling.txt', v1.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-sibling.txt', old_string: 'there', new_string: 'everyone' });
    assert(res.valid === true, `sibling edit should pass once its hash is recorded, got ${JSON.stringify(res)}`);
  });

  await test('out-of-band change with a non-matching edit is still refused', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFile({ path: 'guard-oob.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-oob.txt', v0.contentHash);

    // The file changed on disk to bytes we never wrote and never recorded, and
    // the text the model wants to replace ('world') no longer exists in it.
    await writeFile({ path: 'guard-oob.txt', content: 'hello there\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-oob.txt', old_string: 'world', new_string: 'everyone' });
    assert(res.valid === false, `out-of-band change the edit can't apply to must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('written hash is isolated by conversation', async () => {
    __resetWrittenHashesForTest();
    const writerConversation = await createTestConversation(session);
    const otherConversation = await createTestConversation(session);
    const written = await writeFile({ path: 'guard-conversation-isolation.txt', content: 'private\n' });
    recordWrittenHash(
      writerConversation,
      session,
      'guard-conversation-isolation.txt',
      written.contentHash
    );

    const edit = mkItem(EditClass, otherConversation);
    const res = await edit.validate({
      file_path: 'guard-conversation-isolation.txt',
      old_string: 'private',
      new_string: 'clobbered'
    });
    assert(res.valid === false,
      `another conversation must not inherit write authorization, got ${JSON.stringify(res)}`);
    assert(/not been read this session/i.test(res.error || ''),
      `error should require a read in this conversation: ${res.error}`);
  });

  // =========================================================================
  // Parallel same-file batch: a single turn can dispatch several edits to ONE
  // file that all validate — freezing their expectedHash baseline against the
  // original bytes — before any executes. execute() serializes them per path
  // and re-bases each onto the prior sibling's committed bytes, so every edit
  // applies. Without that serialization the backend's expectedHash guard
  // rejects every sibling after the first ("changed on disk since the edit was
  // prepared"). This drives execute() end to end (not just validate()), which
  // is where the concurrency fix lives.
  // =========================================================================
  await test('parallel same-file edit batch all apply', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFile({ path: 'guard-parallel.txt', content: 'AAA\nBBB\nCCC\n' });
    seedSeen(conversation, 'read', 'guard-parallel.txt', v0.contentHash);

    // Three edits to distinct, non-overlapping regions.
    const specs = [
      { old_string: 'AAA', new_string: 'XXX' },
      { old_string: 'BBB', new_string: 'YYY' },
      { old_string: 'CCC', new_string: 'ZZZ' }
    ];
    const items = specs.map(() => mkItem(EditClass, conversation));

    // All validate first (against the original bytes) — the real batch shape.
    const validated = await Promise.all(items.map((it, i) =>
      it.validate({ file_path: 'guard-parallel.txt', ...specs[i] })));
    validated.forEach((res, i) =>
      assert(res.valid === true, `edit ${i} should validate, got ${JSON.stringify(res)}`));

    // Then execute concurrently — the failure mode this guards against.
    const results = await Promise.all(items.map((it, i) => it.execute(validated[i].params)));
    results.forEach((r, i) =>
      assert(r && /** @type {any} */ (r).success !== false,
        `edit ${i} should apply, got ${JSON.stringify(r)}`));

    const final = await readFile({ path: 'guard-parallel.txt' });
    assert(final.content === 'XXX\nYYY\nZZZ\n',
      `all three edits should be present, got ${JSON.stringify(final.content)}`);
  });

  await test('parallel same-file overwrite batch all apply', async () => {
    __resetWrittenHashesForTest();
    const conversation = await createTestConversation(session);
    const v0 = await writeFile({ path: 'guard-parallel-w.txt', content: 'v0\n' });
    seedSeen(conversation, 'read', 'guard-parallel-w.txt', v0.contentHash);

    const contents = ['one\n', 'two\n', 'three\n'];
    const items = contents.map(() => mkItem(WriteClass, conversation));

    const validated = await Promise.all(items.map((it, i) =>
      it.validate({ file_path: 'guard-parallel-w.txt', content: contents[i] })));
    validated.forEach((res, i) =>
      assert(res.valid === true, `overwrite ${i} should validate, got ${JSON.stringify(res)}`));

    const results = await Promise.all(items.map((it, i) => it.execute(validated[i].params)));
    results.forEach((r, i) =>
      assert(r && /** @type {any} */ (r).success !== false,
        `overwrite ${i} should apply, got ${JSON.stringify(r)}`));

    // Serialized in dispatch order, so the last overwrite wins.
    const final = await readFile({ path: 'guard-parallel-w.txt' });
    assert(final.content === 'three\n',
      `last overwrite should win, got ${JSON.stringify(final.content)}`);
  });

  // =========================================================================
  // Read then edit in ONE batch: every call of a turn is evaluated before any
  // runs, so the edit validates while its read is still unfinished. Validation
  // defers the guard to execute, which the worker holds until the read has
  // settled; there the guard applies against what the read actually did.
  // =========================================================================
  await test('a read earlier in the same turn lets the edit through evaluation', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-turn-eval.txt', content: 'hello world\n' });
    addTurnCall(conversation, 'turn-eval', 'turn-eval-read', 'read',
      { file_path: 'guard-turn-eval.txt' }, TOOL_STATES.RUNNING);
    addTurnCall(conversation, 'turn-eval', 'turn-eval-edit', 'edit',
      { file_path: 'guard-turn-eval.txt', old_string: 'world', new_string: 'there' });

    // The engine path, which is the one that must hand the call its id.
    const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;
    try {
      await handleNewToolAction(conversation.rootMessageThread, 'turn-eval-edit', conversation);
    } finally {
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
    }
    const ta = conversation.rootMessageThread.getToolAction('turn-eval-edit');
    const result = ta?.get('result');
    assert(!result, `the edit must not be refused at evaluation, got ${JSON.stringify(result)}`);
    assert(ta?.get('state') === TOOL_STATES.APPROVED || ta?.get('state') === TOOL_STATES.PENDING,
      `the edit should be awaiting its turn, got ${ta?.get('state')}`);
  });

  await test('the deferred guard applies at execute once the read has landed', async () => {
    const conversation = await createTestConversation(session);
    const v0 = await writeFile({ path: 'guard-turn-ok.txt', content: 'hello world\n' });
    addTurnCall(conversation, 'turn-ok', 'turn-ok-read', 'read',
      { file_path: 'guard-turn-ok.txt' }, UNRUN_READ);
    addTurnCall(conversation, 'turn-ok', 'turn-ok-edit', 'edit',
      { file_path: 'guard-turn-ok.txt', old_string: 'world', new_string: 'there' }, OWN_RECORD);

    const edit = mkItem(EditClass, conversation, 'turn-ok-edit');
    const res = await edit.validate({ file_path: 'guard-turn-ok.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `an edit behind a same-turn read must validate, got ${JSON.stringify(res)}`);

    conversation.rootMessageThread.completeToolAction('turn-ok-read', {
      content: 'read ok',
      isError: false,
      fullResult: { state: 'completed', success: true, result: { exists: true, contentHash: v0.contentHash } }
    });
    const out = await edit.execute(res.params);
    assert(out && /** @type {any} */ (out).success !== false, `the edit should apply, got ${JSON.stringify(out)}`);
    const final = await readFile({ path: 'guard-turn-ok.txt' });
    assert(final.content === 'hello there\n', `the edit should be on disk, got ${JSON.stringify(final.content)}`);
  });

  await test('the deferred guard refuses at execute when the read failed', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-turn-fail.txt', content: 'hello world\n' });
    addTurnCall(conversation, 'turn-fail', 'turn-fail-read', 'read',
      { file_path: 'guard-turn-fail.txt' }, UNRUN_READ);
    addTurnCall(conversation, 'turn-fail', 'turn-fail-edit', 'edit',
      { file_path: 'guard-turn-fail.txt', old_string: 'world', new_string: 'there' }, OWN_RECORD);

    const edit = mkItem(EditClass, conversation, 'turn-fail-edit');
    const res = await edit.validate({ file_path: 'guard-turn-fail.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `an edit behind a same-turn read must validate, got ${JSON.stringify(res)}`);

    conversation.rootMessageThread.completeToolAction('turn-fail-read', {
      content: 'Tool execution failed: denied',
      isError: true,
      fullResult: { state: 'error', success: false, error: 'denied' }
    });
    const out = /** @type {any} */ (await edit.execute(res.params));
    assert(out?.success === false && /has not been read/i.test(out?.message || ''),
      `an edit whose read failed must be refused, got ${JSON.stringify(out)}`);
    const final = await readFile({ path: 'guard-turn-fail.txt' });
    assert(final.content === 'hello world\n', `the file must be untouched, got ${JSON.stringify(final.content)}`);
  });

  await test('a read in another turn, or after the edit, does not count', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-turn-not.txt', content: 'hello world\n' });
    addTurnCall(conversation, 'turn-not-a', 'turn-not-read-a', 'read',
      { file_path: 'guard-turn-not.txt' }, UNRUN_READ);
    addTurnCall(conversation, 'turn-not-b', 'turn-not-edit', 'edit',
      { file_path: 'guard-turn-not.txt', old_string: 'world', new_string: 'there' }, OWN_RECORD);
    addTurnCall(conversation, 'turn-not-b', 'turn-not-read-b', 'read',
      { file_path: 'guard-turn-not.txt' }, UNRUN_READ);

    const edit = mkItem(EditClass, conversation, 'turn-not-edit');
    const res = await edit.validate({ file_path: 'guard-turn-not.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false && /has not been read/i.test(res.error || ''),
      `only an earlier read of the edit's own turn may defer the guard, got ${JSON.stringify(res)}`);
  });

  return results();
}
