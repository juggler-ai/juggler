//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests the read-before-mutate freshness guard (Claude Code-style).
 *
 * The edit tool refuses to modify a file the model hasn't looked at this
 * session, or whose bytes changed on disk since the model last saw them. The
 * write tool is exempt — a whole-file overwrite shows the user a full
 * before/after diff at approval, so the loss is visible without a prior read.
 * Freshness is derived entirely from the durable conversation transcript
 * (context-items/read-history.js): successful read/write/edit/batch_read
 * tool-actions (whose recorded results carry the backend's contentHash) and
 * pinned/at-mentioned file-content items.
 *
 * These tests seed that transcript state directly rather than executing reads
 * in-process — which is also the point: freshness is doc-derived, so a read
 * persisted by a PRIOR app session or ANOTHER client is honored identically,
 * with no per-process record to lose on relaunch. The full real-pipeline path
 * (write-then-edit across turns) is covered by integration-tests/edit-tests.js.
 *
 * This suite is what counts as having seen a file. The write tool's exemption
 * and same-turn writes are `edit-staleness-guard-writes`; the two share
 * `edit-staleness-helpers.js`, which says why they are two suites.
 * @module unit-tests/edit-staleness-guard
 */

import { createTestConversation, assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile } from '../../../js/services/ops-api.js';
import { pathMatchKey, beginProgramReads } from '../context-items/read-history.js';
import { BOGUS_HASH, makeGuardHarness } from './edit-staleness-helpers.js';

/**
 * @typedef {import('./edit-staleness-helpers.js').TestResult} TestResult
 */

/**
 * Run read-before-mutate freshness guard tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  const { session, EditClass, mkItem, seedAction, seedSeen, test, results } = await makeGuardHarness();

  // =========================================================================
  // Never-seen: an edit to a file with no transcript record is REFUSED. The
  // file exists on disk (seeded via the ops layer, which leaves NO
  // tool-action), so only the read-before-edit guard can reject it.
  // =========================================================================
  await test('never-seen edit refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-never.txt', content: 'hello world\n' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-never.txt', old_string: 'world', new_string: 'there' });

    assert(res.valid === false, `never-seen edit must be refused, got ${JSON.stringify(res)}`);
    assert(/has not been read/i.test(res.error || ''),
      `error should tell the model to read first: ${res.error}`);
  });

  // =========================================================================
  // Seen without a hash: a read/write/edit record that carries no contentHash
  // (transcripts written before hashes were recorded) counts as
  // seen-but-unverifiable and ALLOWS the edit rather than forcing a re-read.
  // =========================================================================
  await test('hash-less read allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-read.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-read.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-read.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less write allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-write.txt', content: 'hello world\n' });
    seedSeen(conversation, 'write', 'guard-write.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-write.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `write-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('hash-less edit allows re-edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-reedit.txt', content: 'hello world\n' });
    seedSeen(conversation, 'edit', 'guard-reedit.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-reedit.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `re-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Pinned file-content items ALLOW the edit — pins are re-rendered into
  // context at send time, so they always count as fresh.
  // =========================================================================
  await test('pinned file allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-pin.txt', content: 'hello world\n' });
    await conversation.rootMessageThread.executeContextItem('file-content', { path: 'guard-pin.txt' });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-pin.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `pinned-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // An @-mention is a frozen snapshot with no recorded hash: it proves the file
  // was seen, so the edit is allowed as seen-but-unverifiable.
  await test('mentioned file allows edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-mention.txt', content: 'hello world\n' });
    await conversation.rootMessageThread.executeContextItem('file-content', { path: 'guard-mention.txt', frozen: true });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-mention.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `mentioned-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Staleness on EDIT is relaxed: a targeted replace applies whenever the file
  // was seen this session AND old_str is present verbatim in the file's CURRENT
  // bytes — even if the recorded hash is stale — because replacing present text
  // is lossless (any surrounding out-of-band change is preserved). This stops
  // needless re-read churn after the agent's own formatter/codegen edits a file.
  // It is refused ONLY when old_str is no longer in the current bytes (the model
  // is working from content that moved under it), with a re-read message.
  // =========================================================================
  await test('stale hash still allows a matching targeted edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-stale.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-stale.txt', BOGUS_HASH);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `stale-but-matching edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale file with a non-matching old_str is refused (re-read)', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-stale-miss.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', 'guard-stale-miss.txt', BOGUS_HASH);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-stale-miss.txt', old_string: 'GOODBYE', new_string: 'x' });
    assert(res.valid === false, `stale + non-matching edit must be refused, got ${JSON.stringify(res)}`);
    assert(/changed on disk/i.test(res.error || ''),
      `error should say the file changed: ${res.error}`);
  });

  await test('matching hash allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-fresh.txt', content: 'hello world\n' });
    assert(typeof writeRes.contentHash === 'string' && writeRes.contentHash,
      'writeFile should report the written contentHash');
    seedSeen(conversation, 'read', 'guard-fresh.txt', writeRes.contentHash);

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-fresh.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `fresh-hash edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // batch_read: a file read through the batch tool counts as seen via its
  // per-file result entry; an entry whose read FAILED proves nothing.
  // =========================================================================
  await test('batch_read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-batch.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-other.txt' }, { file_path: 'guard-batch.txt' }] },
      {
        _batchType: 'read',
        results: [
          { file: 'guard-other.txt', success: false, error: 'nope' },
          { file: 'guard-batch.txt', success: true, result: { exists: true, contentHash: writeRes.contentHash } }
        ]
      });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batch.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `batch_read-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('failed batch_read entry does not count', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-batchfail.txt', content: 'hello world\n' });
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchfail.txt' }] },
      { _batchType: 'read', results: [{ file: 'guard-batchfail.txt', success: false, error: 'denied' }] });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchfail.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === false, `failed batch entry must not count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // query_code: files the sandbox script fs.readFile-ed are recorded in the
  // result's filesRead map and earn full hash credit. As with any edit, a stale
  // recorded hash no longer blocks a targeted replace whose old_str matches the
  // current bytes.
  // =========================================================================
  await test('query_code read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-explore.txt', content: 'hello world\n' });
    seedAction(conversation, 'query_code',
      { code: 'return (await fs.readFile("guard-explore.txt")).length' },
      { result: 12, filesRead: { 'guard-explore.txt': writeRes.contentHash } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `query_code-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  await test('stale query_code read still allows a matching edit', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-explore-stale.txt', content: 'hello world\n' });
    seedAction(conversation, 'query_code',
      { code: 'return null' },
      { result: null, filesRead: { 'guard-explore-stale.txt': BOGUS_HASH } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore-stale.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `query_code-seen + matching edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // run_code: a running program's fs.readFile reads count for that program's
  // own tools.edit calls the moment they happen (its sub-calls run under
  // `code_<program>_<n>`), not for anything else, and not after it ends. Once
  // it completes, its stored filesRead credits the conversation like
  // query_code's.
  // =========================================================================
  /**
   * An edit item running as a sub-call of a program.
   * @param {any} conversation - Conversation instance
   * @param {string} toolUseId - The id the sub-call runs under
   * @returns {any} Item instance
   */
  const mkSubCallEdit = (conversation, toolUseId) => mkItem(EditClass, conversation, toolUseId);

  await test('a running program\'s live read allows its own edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-live.txt', content: 'hello world\n' });
    const live = new Map([['guard-live.txt', writeRes.contentHash]]);
    const end = beginProgramReads(conversation, 'prog1', live);
    try {
      const own = mkSubCallEdit(conversation, 'code_prog1_1');
      const res = await own.validate({ file_path: 'guard-live.txt', old_string: 'world', new_string: 'there' });
      assert(res.valid === true, `the program's own edit must be allowed, got ${JSON.stringify(res)}`);

      const other = mkItem(EditClass, conversation);
      const res2 = await other.validate({ file_path: 'guard-live.txt', old_string: 'world', new_string: 'there' });
      assert(res2.valid === false, `an edit outside the program must not borrow its reads, got ${JSON.stringify(res2)}`);
    } finally {
      end();
    }
    const after = mkSubCallEdit(conversation, 'code_prog1_2');
    const res3 = await after.validate({ file_path: 'guard-live.txt', old_string: 'world', new_string: 'there' });
    assert(res3.valid === false, `a finished program's live reads must lapse, got ${JSON.stringify(res3)}`);
  });

  await test('a running program without the read is refused', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-live-unread.txt', content: 'hello world\n' });
    const end = beginProgramReads(conversation, 'prog2', new Map());
    try {
      const own = mkSubCallEdit(conversation, 'code_prog2_1');
      const res = await own.validate({ file_path: 'guard-live-unread.txt', old_string: 'world', new_string: 'there' });
      assert(res.valid === false, `an unread file must be refused, got ${JSON.stringify(res)}`);
    } finally {
      end();
    }
  });

  await test('a completed run_code read allows edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-runcode.txt', content: 'hello world\n' });
    seedAction(conversation, 'run_code',
      { code: 'return 1' },
      { result: 1, filesRead: { 'guard-runcode.txt': writeRes.contentHash } });
    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-runcode.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `run_code-then-edit must be allowed, got ${JSON.stringify(res)}`);
  });

  // A tool-action persists the name it ran under, so a conversation recorded
  // before the script tool was advertised as `query_code` still holds
  // `explore_code`. The freshness scan reads that stored name straight off the
  // document, so it must credit both — otherwise reopening an old conversation
  // silently loses every read its scripts made.
  await test('read stored under the legacy script tool name still credits an edit', async () => {
    const conversation = await createTestConversation(session);
    const writeRes = await writeFile({ path: 'guard-explore-legacy.txt', content: 'hello world\n' });
    seedAction(conversation, 'explore_code',
      { code: 'return (await fs.readFile("guard-explore-legacy.txt")).length' },
      { result: 12, filesRead: { 'guard-explore-legacy.txt': writeRes.contentHash } });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-explore-legacy.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `a legacy-named script read must still count as seen, got ${JSON.stringify(res)}`);
  });

  await test('stripped batch_read results fall back to input list', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-batchbig.txt', content: 'hello world\n' });
    // Large batches have their per-file results replaced by a count in
    // storage; the input list still proves the read covered this file.
    seedAction(conversation, 'batch_read',
      { files: [{ file_path: 'guard-batchbig.txt' }] },
      { _batchType: 'read', resultsCount: 8 });

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-batchbig.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `stripped batch results must still count as seen, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Path forms: `./x`, `x`, and the absolute form all canonicalise to one key
  // (path-approval.js absolutePathKey), so a file seen by one form is editable
  // by another.
  // =========================================================================
  await test('path form variance still matches', async () => {
    const conversation = await createTestConversation(session);
    await writeFile({ path: 'guard-relform.txt', content: 'hello world\n' });
    seedSeen(conversation, 'read', './guard-relform.txt');

    const edit = mkItem(EditClass, conversation);
    const res = await edit.validate({ file_path: 'guard-relform.txt', old_string: 'world', new_string: 'there' });
    assert(res.valid === true, `./-prefixed read must cover the plain path, got ${JSON.stringify(res)}`);
  });

  // =========================================================================
  // Case-insensitive filesystems (macOS APFS/HFS+, Windows) resolve differently
  // cased spellings to ONE file, so the freshness guard's comparison key folds
  // case on those platforms and stays exact on case-sensitive ones (Linux). A
  // file read as `README.md` must then be editable as `readme.md` on macOS, but
  // remain a distinct file on Linux. Tested on pathMatchKey directly so the
  // assertion is deterministic regardless of the host the suite runs on.
  // =========================================================================
  await test('pathMatchKey folds case on macOS/Windows, not Linux', async () => {
    const mac = { projectPath: '/proj', platform: 'darwin' };
    const win = { projectPath: 'C:/proj', platform: 'windows' };
    const lin = { projectPath: '/proj', platform: 'linux' };

    assert(pathMatchKey(mac, 'README.md') === pathMatchKey(mac, 'readme.md'),
      'macOS should treat README.md and readme.md as one file');
    assert(pathMatchKey(win, 'SRC/App.JS') === pathMatchKey(win, 'src/app.js'),
      'Windows should fold case');
    assert(pathMatchKey(lin, 'README.md') !== pathMatchKey(lin, 'readme.md'),
      'Linux is case-sensitive: the two are distinct files');

    // Path-form variance still collapses regardless of platform.
    assert(pathMatchKey(lin, './src/a.js') === pathMatchKey(lin, 'src/a.js'),
      './-prefixed and plain forms must match on Linux too');
    // No path yields no key (never accidentally matches).
    assert(pathMatchKey(mac, '') === '' && pathMatchKey(mac, undefined) === '',
      'empty/undefined path yields empty key');
  });

  return results();
}
