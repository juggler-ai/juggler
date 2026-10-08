//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Freeze-at-first-transaction tests for FileContentContextItems.
 *
 * Two kinds of item share this class, and the split is `data.frozen`:
 *
 *  - A PIN (file picker, paperclip) is LIVE: it resolves from disk on every
 *    render, because a pin means "this file, kept current". These tests hold
 *    that behaviour down so the freeze below cannot quietly generalise onto it.
 *  - A FROZEN item snapshots once and holds that snapshot for the life of the
 *    conversation. Two things create one: an `@file` mention (the file as it
 *    stood when the message was sent), and a SEEDED item (the CLAUDE.md /
 *    AGENTS.md a session adds to itself, which carries `seeded` and implies
 *    `frozen`). Both ride `contextPosition:'prefix'`, so a live re-read would
 *    cold-start the whole conversation every time the agent edited the file it
 *    was handed — which is what it is usually handed it for.
 *
 * The snapshot is taken on the first REQUEST render, not at add-time: a
 * conversation can sit open for an hour before its first send, and what belongs
 * in context is what was true when work began. `contextParams.forRequest`
 * distinguishes the dispatch path (session-worker-callbacks.js) from a
 * properties-panel render (properties-panel.js), which must not freeze anything.
 *
 * Taking the snapshot is only half of it: an item instance is a transient
 * wrapper over a detached copy of the document's data, so a snapshot that is not
 * announced to the thread lasts exactly as long as the object that took it, and
 * the next turn reads the file again. Most cases here stub `_fetchLive` and
 * count announcements; the one that renders a real conversation's item through
 * two separate wrappers is what holds the guarantee itself down.
 * @module unit-tests/file-content-freeze-test
 */

import FileContentContextItem from '../../extensions/juggler-core/context-items/file-content-context-item.js';
import DroppedFileContextItem from '../../extensions/juggler-core/context-items/dropped-file-context-item.js';
import {
  assert,
  initializeRegistries,
  createTestSession,
  createTestConversation,
  releaseTestConversation,
  waitFor
} from '../utilities/test-helpers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { formatFileContentForLLM, parseFileContentForLLM } from '../../sdk/lib/context-item-utils.js';
import { smartTruncate } from '../../sdk/lib/smart-truncate.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Build a FileContentContextItem with stub dependencies and a mutable stubbed
 * `_fetchLive`, so a test can change what "disk" says between renders and count
 * reads. `fetches` records each call, and `announced` counts the times the item
 * told its thread that its data changed — the one channel by which anything it
 * writes into `data` reaches the document.
 * @param {string} body - Initial file body the stub serves
 * @returns {{item: any, fetches: string[], announced: () => number, setBody: (s: string) => void}} Item, call log, announcement count, and a disk-mutator
 */
function makeItem(body) {
  const item = new FileContentContextItem({
    id: 'FILE_1',
    type: 'file-content',
    session: /** @type {any} */ ({ projectPath: '/proj' }),
    conversation: /** @type {any} */ ({}),
    messageThread: /** @type {any} */ ({}),
  });
  let current = body;
  let announcements = 0;
  item.onContentChange = () => { announcements++; };
  /** @type {string[]} */
  const fetches = [];
  item._fetchLive = async () => {
    fetches.push(item.data.path || '');
    return {
      path: item.data.path || 'AGENTS.md',
      isDirectory: false,
      exists: true,
      content: current,
      language: 'markdown',
      size: current.length,
      totalLines: current.split('\n').length,
      lineOffset: 1,
      lineCount: current.split('\n').length,
      warning: null,
    };
  };
  return { item, fetches, announced: () => announcements, setBody: (s) => { current = s; } };
}

/** A render coming from the real dispatch path. */
const REQUEST = { forRequest: true };
/** A render coming from the properties panel — must never freeze. */
const PANEL = {};

/**
 * Run FileContentContextItem freeze tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => Promise<void>|void} fn - Assertions
   */
  async function test(name, fn) {
    try { await fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e?.message || e}`); }
  }

  // Manifest position is the source-of-truth for the worker's prefix/history
  // split, and the reason freezing the seeded items matters at all.
  await test('file-content manifest position is prefix', () => {
    assert(FileContentContextItem.MANIFEST.contextPosition === 'prefix',
      `expected 'prefix', got '${FileContentContextItem.MANIFEST.contextPosition}'`);
  });
  await test('dropped-file manifest position is prefix', () => {
    assert(DroppedFileContextItem.MANIFEST.contextPosition === 'prefix',
      `expected 'prefix', got '${DroppedFileContextItem.MANIFEST.contextPosition}'`);
  });

  // ---- USER PINS STAY LIVE (must keep passing) ----------------------------

  await test('user pin re-reads live on every request render', async () => {
    const { item, fetches, setBody } = makeItem('v1\n');
    await item.onToolCall('file-content', { path: 'src/main.go' });
    const t1 = await item.createContextText(REQUEST);
    assert(t1.includes('v1'), 'first render carries the current bytes');
    setBody('v2\n');
    const t2 = await item.createContextText(REQUEST);
    assert(t2.includes('v2'), 'a changed file renders its NEW bytes — a pin is kept current');
    assert(fetches.length >= 2, `pin reads live each render, got ${fetches.length}`);
  });

  await test('user pin persists no bytes in the document', async () => {
    const { item } = makeItem('v1\n');
    await item.onToolCall('file-content', { path: 'src/main.go' });
    await item.createContextText(REQUEST);
    assert(item.data.content === undefined,
      'a pin persists only its path; bytes must never enter Yjs');
  });

  // ---- SEEDED ITEMS FREEZE ------------------------------------------------

  await test('seeded item snapshots on its first request render', async () => {
    const { item, fetches } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    assert(item.data.seeded === true, 'seeded flag recorded on the item');
    assert(item.data.content === undefined, 'nothing frozen before the first request render');
    const text = await item.createContextText(REQUEST);
    assert(text.includes('rule one'), 'first render carries the file body');
    assert(typeof item.data.content === 'string' && item.data.content.length > 0,
      'first request render stores the snapshot');
    assert(item.data.content === text, 'the stored snapshot is exactly what was sent');
    assert(fetches.length === 1, `exactly one read to take the snapshot, got ${fetches.length}`);
  });

  await test('a dispatch render announces the snapshot it took', async () => {
    // An item instance is a transient wrapper and its `data` a detached copy of
    // what the document holds, so a snapshot that is written and not announced
    // lives exactly as long as the object that took it — and the next turn,
    // rendering a fresh wrapper, reads the file again. The announcement is the
    // whole of the freeze.
    const { item, announced } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    assert(announced() === 0, 'nothing announced before the first request render');

    await item.createContextText(REQUEST);
    assert(announced() === 1,
      `the render that takes the snapshot announces it, got ${announced()}`);

    // Every later render is served from the latch, so there is nothing to say.
    await item.createContextText(REQUEST);
    await item.createContextText(PANEL);
    assert(announced() === 1,
      `a snapshot already taken is announced once and never again, got ${announced()}`);
  });

  await test('a panel render announces nothing, because it wrote nothing', async () => {
    const { item, announced } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    await item.createContextText(PANEL);
    assert(announced() === 0,
      `looking at an item must not write to the conversation, got ${announced()}`);
  });

  await test('a user pin announces nothing on any render', async () => {
    const { item, announced } = makeItem('v1\n');
    await item.onToolCall('file-content', { path: 'src/main.go' });
    await item.createContextText(REQUEST);
    await item.createContextText(PANEL);
    assert(announced() === 0,
      `a pin persists no bytes, so it has nothing to announce, got ${announced()}`);
  });

  await test('seeded item serves the snapshot and never re-reads', async () => {
    const { item, fetches } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    const frozen = await item.createContextText(REQUEST);
    const after = fetches.length;

    // Make any live fetch explode: if a later render re-reads, this throws.
    item._fetchLive = async () => {
      throw new Error('a frozen seeded item must not re-read the file');
    };

    const t1 = await item.createContextText(REQUEST);
    const t2 = await item.createContextText(REQUEST);
    assert(t1 === frozen, 'later renders return the frozen snapshot');
    assert(t2 === frozen, 'the snapshot is byte-identical across turns');
    assert(fetches.length === after, 'no further reads after the snapshot');
  });

  await test('an edit to a seeded file does not change what the model sees', async () => {
    const { item, setBody } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    const frozen = await item.createContextText(REQUEST);
    // The agent rewrites AGENTS.md mid-conversation — the routine case that
    // would otherwise cold-start the whole prefix.
    setBody('rule one\nrule two\n');
    const next = await item.createContextText(REQUEST);
    assert(next === frozen, 'the prefix is byte-identical, so the cache still hits');
    assert(!next.includes('rule two'), 'the new bytes do not reach this conversation');
  });

  // ---- @-MENTIONS FREEZE --------------------------------------------------

  await test('a mention snapshots on its first request render and ignores later edits', async () => {
    const { item, setBody, announced } = makeItem('as mentioned\n');
    await item.onToolCall('file-content', { path: 'plan.md', frozen: true });
    assert(item.data.frozen === true, 'frozen flag recorded on the item');
    assert(item.data.seeded === undefined, 'a mention is not a seeded item');
    const sent = await item.createContextText(REQUEST);
    assert(sent.includes('as mentioned'), 'first render carries the file body');
    assert(item.data.content === sent, 'the stored snapshot is exactly what was sent');
    assert(announced() === 1, `the snapshot is announced once, got ${announced()}`);

    // The agent rewrites the file it was handed.
    setBody('rewritten\n');
    const next = await item.createContextText(REQUEST);
    assert(next === sent, 'the prefix is byte-identical, so the cache still hits');
    assert(!next.includes('rewritten'), 'the rewrite does not reach the mention');
  });

  await test('a frozen mention survives fromJSON', async () => {
    const { item } = makeItem('as mentioned\n');
    await item.onToolCall('file-content', { path: 'plan.md', frozen: true });
    const sent = await item.createContextText(REQUEST);

    const { item: reloaded } = makeItem('rewritten\n');
    reloaded.fromJSON({
      id: 'FILE_1',
      type: 'file-content',
      data: { path: 'plan.md', isDirectory: false, frozen: true, content: sent },
    });
    assert(reloaded.data.content === sent,
      'a mention\'s snapshot must not be stripped as a legacy field, or it silently turns live');
    assert(await reloaded.createContextText(REQUEST) === sent,
      'a reloaded mention still serves its snapshot');
  });

  await test('a mention of an unchanged snapshotted file reuses it', async () => {
    // The model already holds exactly these bytes; a second item would send them twice.
    const { item: earlier } = makeItem('v1\n');
    await earlier.onToolCall('file-content', { path: 'plan.md', frozen: true });
    await earlier.createContextText(REQUEST);
    const merged = await FileContentContextItem.mergeOrReplace({ path: 'plan.md', frozen: true }, [earlier]);
    assert(merged?.action === 'reuse' && merged.item === earlier,
      'a mention of a file whose snapshot still matches must reuse that snapshot');
  });

  await test('a mention of a file changed since its snapshot replaces that snapshot', async () => {
    // A later mention is the file as it stands at THAT send. A second item
    // beside the stale one would carry both copies on every turn from then on,
    // to tell the model something it should no longer believe.
    const { item: earlier, setBody, announced } = makeItem('v1\n');
    await earlier.onToolCall('file-content', { path: 'plan.md', frozen: true });
    await earlier.createContextText(REQUEST);
    setBody('v2\n');
    const merged = await FileContentContextItem.mergeOrReplace({ path: 'plan.md', frozen: true }, [earlier]);
    assert(merged?.action === 'reuse' && merged.item === earlier,
      'a mention of a changed file must reuse the existing snapshot, not add a second');
    // The orchestrator then re-runs the tool call on the reused item.
    await earlier.onToolCall('file-content', { path: 'plan.md', frozen: true });
    const sent = await earlier.createContextText(REQUEST);
    assert(sent.includes('v2') && !sent.includes('v1'), 'the reused item now serves the file as it stands');
    assert(earlier.data.content === sent, 'and stores what it serves');
    assert(announced() === 2, `the new snapshot is announced, got ${announced()} announcements`);
  });

  await test('a mention reuses a mention that has not snapshotted yet', async () => {
    // Both are the file as it stands at the next send, which is one snapshot.
    const { item: earlier } = makeItem('v1\n');
    await earlier.onToolCall('file-content', { path: 'plan.md', frozen: true });
    const merged = await FileContentContextItem.mergeOrReplace({ path: 'plan.md', frozen: true }, [earlier]);
    assert(merged?.action === 'reuse' && merged.item === earlier,
      'a mention must reuse an unlatched mention of the same file');
  });

  await test('a mention reuses a live pin without freezing it', async () => {
    // A pin already hands the model the file as it stands at every send.
    const { item: pin } = makeItem('v1\n');
    await pin.onToolCall('file-content', { path: 'plan.md' });
    const merged = await FileContentContextItem.mergeOrReplace({ path: 'plan.md', frozen: true }, [pin]);
    assert(merged?.action === 'reuse' && merged.item === pin, 'a mention of a pinned file must reuse the pin');
    // The orchestrator then re-runs the tool call on the reused item.
    await pin.onToolCall('file-content', { path: 'plan.md', frozen: true });
    assert(pin.data.frozen === undefined, 'reusing a pin for a mention must leave it live');
  });

  await test('a pin reuses a pin, but not a frozen item', async () => {
    const { item: mention } = makeItem('v1\n');
    await mention.onToolCall('file-content', { path: 'plan.md', frozen: true });
    const { item: pin } = makeItem('v1\n');
    await pin.onToolCall('file-content', { path: 'plan.md' });
    assert(await FileContentContextItem.mergeOrReplace({ path: 'plan.md' }, [mention]) === null,
      'pinning a file that was mentioned must add a live pin, not adopt the snapshot');
    const merged = await FileContentContextItem.mergeOrReplace({ path: 'plan.md' }, [pin]);
    assert(merged?.action === 'reuse' && merged.item === pin, 'pinning a pinned file reuses the pin');
  });

  await test('the panel says a mention was frozen when it was sent', async () => {
    const { item } = makeItem('as mentioned\n');
    await item.onToolCall('file-content', { path: 'plan.md', frozen: true });
    await item.createContextText(REQUEST);
    const panel = item.createPropertiesPanelElement();
    document.body.appendChild(panel);
    await new Promise(r => setTimeout(r, 0));
    assert(panel.textContent.includes('frozen'), 'the panel states that the mention is frozen');
    assert(!panel.textContent.includes('start of this conversation'),
      'and does not describe it as a file the session added to itself');
    panel.remove();
  });

  // ---- THE PANEL SHOWS WHAT THE MODEL READS -------------------------------

  await test('the panel shows the snapshot, not the file as it now stands', async () => {
    const { item, setBody } = makeItem('as mentioned\n');
    await item.onToolCall('file-content', { path: 'plan.md', frozen: true });
    await item.createContextText(REQUEST);
    setBody('since edited\n');
    const panel = item.createPropertiesPanelElement();
    document.body.appendChild(panel);
    try {
      await waitFor(() => (panel.textContent || '').includes('as mentioned'),
        { timeoutMs: 2000, description: 'the frozen panel to show the snapshot' });
      await new Promise(r => setTimeout(r, 0));
      assert(!(panel.textContent || '').includes('since edited'),
        'the frozen panel must not show the live file');
      assert(!(panel.textContent || '').includes('<file path='),
        'the snapshot is shown as the file, not as its model-facing wrapper');
    } finally {
      panel.remove();
    }
  });

  await test('a formatted file reads back as the text it was formatted from', () => {
    const cases = [
      { content: 'one\ntwo\n', lineOffset: 1, totalLines: 2 },
      { content: 'a\n\n\tindented\n12\tlooks numbered\n</file>\nlast', lineOffset: 1 },
      { content: 'middle\nof a file', lineOffset: 40, totalLines: 300 },
      { content: 'x', lineOffset: 9 },
    ];
    for (const c of cases) {
      const formatted = formatFileContentForLLM({ path: 'dir/some "file".js', ...c });
      const parsed = parseFileContentForLLM(formatted);
      assert(parsed, `a formatted block must parse: ${JSON.stringify(c)}`);
      const runs = parsed.parts.filter(p => p.kind === 'lines');
      assert(runs.length === 1, `one run expected, got ${runs.length}`);
      assert(runs[0].content === c.content,
        `content must round-trip: ${JSON.stringify(runs[0].content)} vs ${JSON.stringify(c.content)}`);
      assert(runs[0].lineOffset === c.lineOffset, `lineOffset must round-trip for ${c.lineOffset}`);
      assert(parsed.path === 'dir/some "file".js', `path must round-trip, got ${parsed.path}`);
    }
  });

  await test('a truncated snapshot reads back as its runs and the notes between them', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`);
    const formatted = formatFileContentForLLM({ path: 'big.txt', content: lines.join('\n'), totalLines: 2000 });
    const { content: bounded } = smartTruncate(formatted, { maxChars: 8000 });
    const parsed = parseFileContentForLLM(bounded + '\n\n(Truncated from a lot)');
    assert(parsed, 'a head/tail-truncated block must still parse');
    const kinds = parsed.parts.map(p => p.kind).join(',');
    assert(kinds === 'lines,note,lines,note', `expected run, gap, run, footer; got ${kinds}`);
    const [head, gap, tail, footer] = /** @type {any[]} */ (parsed.parts);
    assert(head.lineOffset === 1 && head.content.startsWith('line 1 '), 'the head starts at line 1');
    assert(gap.text.includes('lines omitted'), `the gap says what was left out, got ${gap.text}`);
    const headLines = head.content.split('\n').length;
    assert(tail.lineOffset > headLines + 1, 'the tail resumes past the gap');
    assert(tail.content.split('\n')[0] === lines[tail.lineOffset - 1],
      'and its first line is the line its number says');
    assert(footer.text.includes('2000 lines total') && footer.text.includes('Truncated from'),
      `the trailing notes are kept, got ${footer.text}`);
  });

  await test('text that is not a file block does not parse', () => {
    for (const text of [
      'Directory listing of src/:\nmain.go',
      'File does not exist: nope.md',
      formatFileContentForLLM({ path: 'empty.md', content: '' }),
      '<file path="x">\nno numbers here\n</file>',
    ]) {
      assert(parseFileContentForLLM(text) === null, `must not parse: ${JSON.stringify(text)}`);
    }
  });

  // ---- THE PANEL MUST NOT FREEZE ------------------------------------------

  await test('a properties-panel render does not take the snapshot', async () => {
    const { item, setBody } = makeItem('early\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    // The user opens the panel long before sending anything.
    const panelText = await item.createContextText(PANEL);
    assert(panelText.includes('early'), 'the panel shows live disk contents');
    assert(item.data.content === undefined,
      'opening the panel must not freeze the item');
    // Work actually begins later, against a file that has since changed.
    setBody('late\n');
    const sent = await item.createContextText(REQUEST);
    assert(sent.includes('late'),
      'the snapshot is taken at the first transaction, not when the panel was opened');
    assert(item.data.content === sent, 'and that is what gets stored');
  });

  // ---- THE SNAPSHOT MUST SURVIVE A RELOAD ---------------------------------

  await test('a frozen snapshot survives fromJSON', async () => {
    const { item } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    const frozen = await item.createContextText(REQUEST);

    // Round-trip through persistence, as a page reload does.
    const { item: reloaded } = makeItem('rule one\n');
    reloaded.fromJSON({
      id: 'FILE_1',
      type: 'file-content',
      data: { path: 'AGENTS.md', isDirectory: false, seeded: true, content: frozen },
    });
    assert(reloaded.data.content === frozen,
      'the snapshot must not be stripped as a legacy field, or the freeze silently degrades to live');

    reloaded._fetchLive = async () => {
      throw new Error('a reloaded frozen item must not re-read the file');
    };
    assert(await reloaded.createContextText(REQUEST) === frozen,
      'a reloaded item still serves its snapshot');
  });

  await test('an oversized seeded file is bounded before it enters the document', async () => {
    // A snapshot is replicated to every peer and kept for the conversation's
    // life, so it carries a far tighter ceiling than a pin's send-time bound.
    const { item } = makeItem('x'.repeat(400_000));
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    const text = await item.createContextText(REQUEST);
    assert(item.data.content.length < 300_000,
      `snapshot must be bounded, got ${item.data.content.length} chars`);
    assert(item.data.content === text,
      'the bound applies to what is SENT as well as what is stored, or turn 1 and turn 2 differ');
  });

  // ---- THE FREEZE HOLDS ACROSS WRAPPERS -----------------------------------

  await test('the snapshot the first turn takes is the one every later turn sends', async () => {
    // The cases above all hold one instance and ask it twice, which is not what
    // a conversation does. An item instance is a transient wrapper rebuilt on
    // every read of `contextItems`, and its `data` a detached copy of the
    // document's, so a snapshot that does not reach the document is gone by the
    // next turn and the file is read live again — the prefix re-priced by the
    // very edit the freeze exists to absorb. This case therefore renders a
    // conversation's own item, twice, through two different wrappers.
    await initializeRegistries();
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const stamp = Math.random().toString(36).slice(2, 8);
    const dir = `freeze-${stamp}`;
    const path = `${dir}/AGENTS.md`;
    const itemId = `FILE_FROZEN_${stamp}`;
    const project = createBoundOps(() => ({ workspaceId: '' }));
    /** @returns {any} The conversation's item as it stands now, never the one held before. */
    const fromDocument = () => conversation.rootMessageThread.contextItems.find(
      (/** @type {any} */ i) => i.id === itemId);

    try {
      await writeFileOp({ path, content: `# as it stood when work began ${stamp}\n` });
      conversation.rootMessageThread.addContextItem(contextItemRegistry.createItem({
        id: itemId,
        type: 'file-content',
        data: { path, isDirectory: false, seeded: true }
      }, session, conversation, conversation.rootMessageThread));

      const sent = await fromDocument().createContextText({ forRequest: true });
      assert(sent.includes(`as it stood when work began ${stamp}`),
        `the first turn sends the file as it stands, got ${JSON.stringify(sent)}`);

      // Item data reaches the document through a batch on a zero timeout, so
      // the barrier is the document holding it — not a wait long enough to
      // look like one.
      await waitFor(() => typeof fromDocument()?.data.content === 'string',
        { description: 'the snapshot to reach the document' });

      // The agent rewrites the instructions it was handed, which is the routine
      // case and the expensive one.
      await writeFileOp({ path, content: `# rewritten mid-conversation ${stamp}\n` });
      const later = await fromDocument().createContextText({ forRequest: true });
      assert(later === sent,
        `a later turn sends byte-identical bytes, so the cached prefix still hits, got ${JSON.stringify(later)}`);
      assert(!later.includes('rewritten mid-conversation'),
        'and the rewrite does not reach a conversation that was handed the file before it');
    } finally {
      await releaseTestConversation(session, conversation.id, 'file-content-freeze');
      await project.copyTree({ to: '.', delete: [dir] });
    }
  });

  // ---- THE REFRESH AFFORDANCE --------------------------------------------

  await test('the panel explains the freeze and offers an update once it matters', async () => {
    const { item, setBody } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    await item.createContextText(REQUEST);

    // Unchanged file: nothing to update to, so no control is offered.
    const same = item.createPropertiesPanelElement();
    document.body.appendChild(same);
    await new Promise(r => setTimeout(r, 0));
    assert(same.textContent.includes('frozen'), 'the panel states that the item is frozen');
    assert(!same.querySelector('.file-content-seeded-update'),
      'no update control while the file matches the snapshot');
    same.remove();

    // Changed file: the control appears, and states the cost.
    setBody('rule one\nrule two\n');
    const changed = item.createPropertiesPanelElement();
    document.body.appendChild(changed);
    await new Promise(r => setTimeout(r, 0));
    const btn = changed.querySelector('.file-content-seeded-update');
    assert(btn, 'an update control appears once the file has diverged');
    assert(changed.textContent.includes('re-reads the conversation once'),
      'the cost of updating is stated, not discovered afterwards');
    changed.remove();
  });

  await test('updating re-freezes to the current file', async () => {
    const { item, setBody } = makeItem('rule one\n');
    await item.onToolCall('file-content', { path: 'AGENTS.md', seeded: true });
    const first = await item.createContextText(REQUEST);
    setBody('rule one\nrule two\n');

    const panel = item.createPropertiesPanelElement();
    document.body.appendChild(panel);
    await new Promise(r => setTimeout(r, 0));
    /** @type {any} */ (panel.querySelector('.file-content-seeded-update'))?.click();
    await new Promise(r => setTimeout(r, 0));

    const after = await item.createContextText(REQUEST);
    assert(after !== first, 'the snapshot moved');
    assert(after.includes('rule two'), 'and moved to what the file now says');
    assert(item.data.content === after, 'the stored snapshot matches what is sent');
    panel.remove();
  });

  await test('a user pin still drops legacy persisted bytes', async () => {
    const { item } = makeItem('v1\n');
    // An old conversation persisted a snapshot back when pins froze at add-time.
    item.fromJSON({
      id: 'FILE_1',
      type: 'file-content',
      data: { path: 'src/main.go', isDirectory: false, content: 'stale bytes' },
    });
    assert(item.data.content === undefined,
      'a pin with no frozen flag keeps its bounded path-only footprint');
    const text = await item.createContextText(REQUEST);
    assert(text.includes('v1'), 'and renders live rather than serving the stale snapshot');
  });

  return { passed, failed, errors };
}
