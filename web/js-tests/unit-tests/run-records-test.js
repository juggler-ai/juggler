//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Browser-side run records.
 *
 * The worker settles the runs it drives; this module covers the one case it
 * cannot — a stop that reaches a thread the worker is not driving. Both halves
 * have a Go twin that must agree with them byte for byte, so both are pinned
 * here: which messages a settle stamps (openRunMessagesLocked) and what a
 * cancelled run hands back (resolveRunOutcome).
 *
 * The last case covers what the UI derives from the same record: the terminal
 * Result block belongs to the run that wrote the summary, so a thread running
 * again must not sit under one.
 * @module unit-tests/run-records-test
 */

import { assert } from '../utilities/test-helpers.js';
import { settleRunCancelled, threadRunSettled, RUN_CANCELLED_NOTE, RUN_STATUS_CANCELLED }
  from '../../js/model/run-records.js';
import { ensureThreadResult } from '../../js/components/conversation-area-rendering.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {Record<string, any>} fields
   * @returns {any} a Y.Map shaped like a conversation item
   */
  const item = (fields) => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    return m;
  };
  /**
   * Build a thread Y.Map holding the given items, live in its own doc so the
   * shared types accept writes.
   * @param {any[]} children
   * @returns {any} the thread Y.Map
   */
  const thread = (children) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const m = new Y.Map();
    doc.transact(() => {
      root.insert(0, [m]);
      m.set('type', 'thread');
      m.set('itemId', 'T1');
      const arr = new Y.Array();
      m.set('items', arr);
      arr.insert(0, children);
    });
    return m;
  };

  // --- 1: a settle stamps every message the run gathered ---
  // A human can type into a child while its delegated run is in flight; the
  // message is promoted mid-run and absorbed into that same run. Both ends of
  // that run must carry the outcome: the invocation message because the caller's
  // tool_result is paired by the coordinates it holds, and the trailing message
  // because that is where liveness is read — stamp one and not the other and
  // the caller either reads the pending placeholder as its answer or parks on a
  // run that already ended.
  try {
    const invocation = item({
      type: 'user', itemId: 'inv-1', content: 'find the auth bug',
      runToolUseId: 'tu-1', runToolName: 'Explore'
    });
    const interjection = item({ type: 'user', itemId: 'human-1', content: 'check the tests too' });
    const t = thread([
      invocation,
      item({ type: 'assistant', itemId: 'a-1', content: 'Looking.' }),
      interjection
    ]);

    assert(threadRunSettled(t) === false, 'a run with no recorded outcome must read as running');
    assert(settleRunCancelled(t) === true, 'an open run must settle');
    assert(invocation.get('runStatus') === RUN_STATUS_CANCELLED,
      `the invocation message must carry the outcome; got ${invocation.get('runStatus')}`);
    assert(interjection.get('runStatus') === RUN_STATUS_CANCELLED,
      'the message the run absorbed carries the same outcome, so the thread reads as finished');
    assert(threadRunSettled(t) === true, 'the settled run must read as finished');
    passed++;
  } catch (e) { failed++; errors.push(`settle stamps the run: ${msg(e)}`); }

  // --- 2: a human-driven run settles on its own trailing message ---
  // No coordinates anywhere, so the trailing user item IS the starter. This is
  // the case that must keep working: a user-created thread records completion
  // nowhere else, so failing to settle would park its column forever.
  try {
    const start = item({ type: 'user', itemId: 'u-1', content: 'do work' });
    const t = thread([start, item({ type: 'assistant', itemId: 'a-1', content: 'Working.' })]);
    assert(settleRunCancelled(t) === true, 'a human-driven run must settle');
    assert(start.get('runStatus') === RUN_STATUS_CANCELLED, 'its trailing user item is its starter');

    // Settling twice is a no-op: the worker usually gets there first.
    assert(settleRunCancelled(t) === false, 'a settled run must not be re-stamped');
    passed++;
  } catch (e) { failed++; errors.push(`human-driven run settles: ${msg(e)}`); }

  // --- 3: a cancelled run hands back what it produced, plus the reason ---
  // Mirrors resolveRunOutcome(cancelled) in worker/run_records.go. A stop that
  // lands after the child has already answered is worth more to the caller than
  // the bare note, and the two writers must compose it identically.
  try {
    const start = item({ type: 'user', itemId: 'u-1', content: 'do work' });
    const t = thread([start, item({ type: 'assistant', itemId: 'a-1', content: 'Got partway.' })]);
    settleRunCancelled(t);
    assert(start.get('runResult') === `Got partway.\n\n${RUN_CANCELLED_NOTE}`,
      `a cancelled run must return its trailing reply then the reason; got ${JSON.stringify(start.get('runResult'))}`);

    // A run stopped mid-tool has no clean reply, so the note stands alone —
    // trailing plumbing is never passed off as an answer.
    const midTool = item({ type: 'user', itemId: 'u-2', content: 'do work' });
    const t2 = thread([
      midTool,
      item({ type: 'assistant', itemId: 'a-2', content: 'Reading files.' }),
      item({ type: 'tool-action', itemId: 't-2', toolUseId: 'tu-2', state: 'running' })
    ]);
    settleRunCancelled(t2);
    assert(midTool.get('runResult') === RUN_CANCELLED_NOTE,
      `a run with no clean trailing reply returns the note alone; got ${JSON.stringify(midTool.get('runResult'))}`);
    passed++;
  } catch (e) { failed++; errors.push(`cancelled run keeps its output: ${msg(e)}`); }

  // --- 3b: a stop that settles a run the parent has already read appends ---
  // The worker does this for the runs it drives; a stop reaching a thread it is
  // not driving must reach the same shape, or the two writers disagree about
  // where a run reports and the parent's committed answer gets rewritten by the
  // browser instead. Mirrors reportRunToParentLocked in worker/run_records.go.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    const starter = item({ type: 'user', itemId: 'human-1', content: 'keep going' });
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'map auth');
      t.set('sessionName', 'hunt');
      t.set('runToolUseId', 'tu-1');
      t.set('runResultFed', true); // the parent has read this call's answer
      const arr = new Y.Array();
      t.set('items', arr);
      arr.insert(0, [
        item({
          type: 'user', itemId: 'inv-1', content: 'where is auth?',
          runToolUseId: 'tu-1', runToolName: 'Explore',
          runStatus: 'rest', runResult: 'Auth lives in auth.go.'
        }),
        starter
      ]);
    });

    let minted = 0;
    doc.transact(() => { settleRunCancelled(t, () => `msg-new-${++minted}`); });
    assert(t.get('runResultFed') === true && root.length === 2,
      `the read item must be left alone and a receipt appended; got ${root.length} items`);
    const receipt = root.get(1);
    assert(receipt.get('aliasOf') === 'T1' && receipt.get('runItemId') === 'human-1',
      `the receipt must select the run that just settled; got ${JSON.stringify(receipt.toJSON())}`);
    assert(receipt.get('sessionName') === 'hunt' && !receipt.get('runToolUseId'),
      'a receipt shows the session but claims no call');

    // A second stopped run, with that receipt still unread, follows it forward
    // rather than stacking another item.
    const again = item({ type: 'user', itemId: 'human-2', content: 'and the tests?' });
    doc.transact(() => {
      t.get('items').push([again]);
      settleRunCancelled(t, () => `msg-new-${++minted}`);
    });
    assert(root.length === 2 && root.get(1).get('runItemId') === 'human-2',
      `an unread receipt must follow the session forward; got ${root.length} items`);
    passed++;
  } catch (e) { failed++; errors.push(`browser settle reports to the parent: ${msg(e)}`); }

  // --- 3c: a run that came out as the one already shown appends nothing ---
  // A receipt earns its place by being news. A run whose status and result match
  // what the trailing item already shows is not news, and a tile standing next to
  // an identical tile tells the reader nothing while costing the parent a message
  // to read. Mirrors reportRunToParentLocked in worker/run_records.go.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'map auth');
      t.set('runToolUseId', 'tu-1');
      t.set('runResultFed', true); // the parent has read this call's answer
      const arr = new Y.Array();
      t.set('items', arr);
      arr.insert(0, [
        // The call was stopped having produced nothing — the bare note.
        item({
          type: 'user', itemId: 'inv-1', content: 'where is auth?',
          runToolUseId: 'tu-1', runToolName: 'Explore',
          runStatus: RUN_STATUS_CANCELLED, runResult: RUN_CANCELLED_NOTE
        }),
        item({ type: 'user', itemId: 'human-1', content: 'keep going' })
      ]);
    });

    doc.transact(() => { settleRunCancelled(t, () => 'msg-new-1'); });
    assert(root.length === 1,
      `a stop that came out as the stop the parent already reads must append nothing; got ${root.length} items`);

    // An outcome that differs at all is still news, and still gets its own item.
    doc.transact(() => {
      t.get('items').push([
        item({ type: 'user', itemId: 'human-2', content: 'and the tests?' }),
        item({ type: 'assistant', itemId: 'a-2', content: 'Tests in auth_test.go.' })
      ]);
      settleRunCancelled(t, () => 'msg-new-2');
    });
    assert(root.length === 2 && root.get(1).get('runItemId') === 'human-2',
      `a run that came out differently must still get its own item; got ${root.length} items`);
    passed++;
  } catch (e) { failed++; errors.push(`identical run appends no receipt: ${msg(e)}`); }

  // --- 3d: a read the parent never answered takes the next run itself ---
  // `runResultFed` is stamped as the wire is built, so a turn that read the
  // child's failure and then died on its own stamped it and committed nothing.
  // Nothing stands on that result — an error item says nothing to the provider —
  // so the retry reports to the item already waiting, rather than standing a
  // second tile beside it for the same call. Mirrors fedResultUnansweredLocked in
  // worker/run_records.go.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'map auth');
      t.set('runToolUseId', 'tu-1');
      t.set('runResultFed', true); // read as the wire was built…
      const arr = new Y.Array();
      t.set('items', arr);
      arr.insert(0, [
        item({
          type: 'user', itemId: 'inv-1', content: 'where is auth?',
          runToolUseId: 'tu-1', runToolName: 'Explore',
          runStatus: 'error', runResult: 'invalid request: bad model'
        }),
        item({ type: 'user', itemId: 'human-1', content: 'try again' })
      ]);
      // …by a turn that then died on an error of its own.
      root.push([item({ type: 'error', itemId: 'pe-1', content: 'invalid request: bad model' })]);
    });

    doc.transact(() => { settleRunCancelled(t, () => 'msg-new-1'); });
    assert(root.length === 2 && t.get('runItemId') === 'human-1',
      `a retry of a call nothing answered must report to the item standing for it; got ${root.length} items`);

    // Once the parent has actually answered, the freeze is real again.
    doc.transact(() => {
      root.push([item({ type: 'assistant', itemId: 'pa-1', content: 'Right — auth.go it is.' })]);
      t.get('items').push([
        item({ type: 'user', itemId: 'human-2', content: 'and the tests?' }),
        item({ type: 'assistant', itemId: 'a-2', content: 'Tests in auth_test.go.' })
      ]);
      settleRunCancelled(t, () => 'msg-new-2');
    });
    assert(root.length === 4 && root.get(3).get('runItemId') === 'human-2',
      `a run arriving after the parent answered must get its own item; got ${root.length} items`);
    passed++;
  } catch (e) { failed++; errors.push(`unanswered read takes the retry: ${msg(e)}`); }

  // --- 3e: a stop leaves an unread receipt recovering nothing ---
  // A receipt that recovers an error (recoversError) is the one the parent's
  // reducer takes up unasked: the parent read that the work failed, and the run
  // the receipt names is that work done. An unread receipt follows the session
  // forward, so when a stop moves it onto a cancelled run it must stop claiming
  // that, or the parent wakes for work that never finished. Mirrors
  // reportRunToParentLocked in worker/run_records.go.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'map auth');
      t.set('runToolUseId', 'tu-1');
      t.set('runResultFed', true); // the parent read the call's error…
      const arr = new Y.Array();
      t.set('items', arr);
      arr.insert(0, [
        item({
          type: 'user', itemId: 'inv-1', content: 'where is auth?',
          runToolUseId: 'tu-1', runToolName: 'Explore',
          runStatus: 'error', runResult: 'invalid request: bad model'
        }),
        item({ type: 'user', itemId: 'retry-1', content: 'try again', runStatus: 'rest', runResult: 'Auth lives in auth.go.' }),
        item({ type: 'user', itemId: 'human-2', content: 'and the tests?' })
      ]);
      root.push([
        item({ type: 'assistant', itemId: 'pa-1', content: 'The subthread failed.' }), // …and answered it
        item({ type: 'thread', itemId: 'R1', aliasOf: 'T1', runItemId: 'retry-1', recoversError: true })
      ]);
    });

    doc.transact(() => { settleRunCancelled(t, () => 'msg-new-1'); });
    const receipt = root.get(2);
    assert(root.length === 3 && receipt.get('runItemId') === 'human-2',
      `the unread receipt must follow the session forward; got ${root.length} items`);
    assert(!receipt.get('recoversError'),
      'a receipt moved onto a stopped run must not claim to recover the error');
    passed++;
  } catch (e) { failed++; errors.push(`stop clears a receipt's recovery: ${msg(e)}`); }

  // --- 4: the terminal Result block is a compaction fold's alone ---
  // A fold's transcript is folded away, so its summary stands nowhere else and
  // the block IS the column. Every other thread ends on the reply its last run
  // came to rest on and answers its caller through its run records, so it prints
  // no block whatever `result` happens to hold.
  try {
    /**
     * @param {any} t - The thread Y.Map to render for.
     * @returns {HTMLElement} The message list it was rendered into.
     */
    const render = (t) => {
      const messageList = document.createElement('div');
      const footer = document.createElement('conversation-footer');
      messageList.appendChild(footer);
      ensureThreadResult({ threadYMap: t, conversation: null }, messageList, footer);
      return messageList;
    };

    const rested = thread([
      item({ type: 'user', itemId: 'u-1', content: 'where is auth?' }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Auth lives in auth.go.' })
    ]);
    rested.set('result', 'Auth lives in auth.go.');
    assert(!render(rested).querySelector('.thread-result-final'),
      'a summary that IS the last message must not be printed again below it');

    // A summary the transcript no longer says — left by an earlier run, or
    // orphaned when the message it came from was edited — stays out of the
    // column too. The thread's tile still carries it.
    const stale = thread([
      item({ type: 'user', itemId: 'u-1', content: 'where is auth?' }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Cancelled before I got there.' })
    ]);
    stale.set('result', 'Auth lives in auth.go.');
    assert(!render(stale).querySelector('.thread-result-final'),
      'a summary the transcript has moved past is not printed under it');

    const delegated = thread([
      item({
        type: 'user', itemId: 'inv-1', content: 'where is auth?',
        runToolUseId: 'tu-1', runToolName: 'Explore', runToolInput: {},
        runStatus: 'rest', runResult: 'Auth lives in auth.go.'
      }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Auth lives in auth.go.' })
    ]);
    delegated.set('result', 'Auth lives in auth.go.');
    assert(!render(delegated).querySelector('.thread-result-final'),
      'a thread that records runs answers its callers through them, not through a block');

    const fold = thread([
      item({ type: 'user', itemId: 'u-1', content: 'summarise this' })
    ]);
    fold.set('boundedCompaction', true);
    fold.set('result', 'What the folded transcript said.');
    const foldList = render(fold);
    assert(!!foldList.querySelector('.thread-result-final'),
      'a fold has nothing but its summary — the block IS the column');
    assert(!!foldList.querySelector('.thread-result-resummarise-btn'),
      'and it carries the only way to write that summary again');

    // A fold whose summariser stopped without writing anything. This is the
    // state the block exists for: the parent shows nothing but this fold's
    // tile, so if the block hides itself for want of text, the Re-summarise
    // button goes with it and there is no route back to a summary anywhere.
    const unsummarized = thread([
      item({ type: 'user', itemId: 'u-1', content: 'summarise this' })
    ]);
    unsummarized.set('boundedCompaction', true);
    unsummarized.set('compactionUnsummarized', true);
    const unsummarizedList = render(unsummarized);
    const block = unsummarizedList.querySelector('.thread-result-final');
    assert(!!block, 'a fold with no summary still renders its block — it carries the only recovery route');
    assert(!!unsummarizedList.querySelector('.thread-result-resummarise-btn'),
      'and Re-summarise is exactly what that state needs to offer');
    assert(/** @type {HTMLElement} */ (block).dataset.resultState === 'unsummarized',
      'the rendered state is keyed separately from the text, so each can replace the other');

    // And a summary landing afterwards replaces the notice in place.
    // The worker deletes the marker in the same transaction that writes the
    // summary, so clear it the way production does.
    unsummarized.set('result', 'What the folded transcript said.');
    unsummarized.delete('compactionUnsummarized');
    ensureThreadResult({ threadYMap: unsummarized, conversation: null },
      unsummarizedList, /** @type {any} */ (unsummarizedList.querySelector('conversation-footer')));
    const settled = unsummarizedList.querySelector('.thread-result-final');
    assert(/** @type {HTMLElement} */ (settled).dataset.resultState === 'summary',
      'a summary arriving replaces the no-summary notice');
    assert(unsummarizedList.querySelector('.thread-result-label')?.textContent === 'Summary',
      'and the label follows it back');

    // A fold left with no summary and no marker — the shape any path that
    // commits the fold and then fails to summarise leaves behind, including
    // every one that never runs a summarizer at all. Nothing is driving it and
    // nothing is queued to, so the block is the only route out and must render
    // off the state itself rather than off a flag someone remembered to write.
    const stranded = thread([
      item({ type: 'user', itemId: 'u-1', content: 'summarise this' })
    ]);
    stranded.set('boundedCompaction', true);
    assert(!!render(stranded).querySelector('.thread-result-resummarise-btn'),
      'a fold with no summary and nothing coming must offer Re-summarise even with no marker set');

    // But not while a summary is genuinely on its way: a fold the pickup still
    // owes a run to says so on the thread itself.
    const queued = thread([
      item({ type: 'user', itemId: 'u-1', content: 'summarise this' })
    ]);
    queued.set('boundedCompaction', true);
    queued.set('needsStrategyRun', true);
    assert(!render(queued).querySelector('.thread-result-final'),
      'a fold still owed a summarization run must not offer to redo it');
    passed++;
  } catch (e) { failed++; errors.push(`Result block appears only where the summary is not: ${msg(e)}`); }

  // --- 5: the shared settle table ---
  // The same cases TestThreadRunSettledFixture asks of the worker, so the two
  // implementations of "is this child finished?" cannot drift apart.
  try {
    const res = await fetch(new URL('../fixtures/thread-run-settled.json', import.meta.url));
    if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
    const { cases } = await res.json();
    assert(Array.isArray(cases) && cases.length > 0, 'the fixture holds no cases');
    /**
     * @param {Record<string, any>} fields - A document item as stored.
     * @returns {any} its Y.Map, nested items as a Y.Array of Y.Maps
     */
    const toYMap = (fields) => {
      const m = new Y.Map();
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'items') {
          const arr = new Y.Array();
          arr.insert(0, v.map(toYMap));
          m.set(k, arr);
        } else {
          m.set(k, v);
        }
      }
      return m;
    };
    /** @type {string[]} */
    const wrong = [];
    for (const c of cases) {
      const doc = new Y.Doc();
      const m = toYMap(c.thread);
      doc.getArray('items').insert(0, [m]);
      const got = threadRunSettled(m);
      if (got !== c.settled) wrong.push(`${c.name}: got ${got}, want ${c.settled}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
    passed++;
  } catch (e) { failed++; errors.push(`shared settle table: ${msg(e)}`); }

  return { passed, failed, errors };
}
