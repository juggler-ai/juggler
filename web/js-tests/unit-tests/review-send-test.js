//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Sending a review: the message it becomes, and the send being nobody else's
 * business but the reviewer's.
 *
 * Two halves again. The first is `formatReviewMessage` — a draft written out as
 * one ordinary message, through the same `formatCodeReference` the context menu
 * quotes a selection with, so the agent meets one way of being told "this code,
 * here" rather than two. It is sorted rather than merely iterated, because an
 * unchanged draft has to produce a byte-identical message twice for the format
 * to be testable at all.
 *
 * The second is the hand-over. A review is not sent: it is put in the prompt of
 * the thread it is about, for the reviewer to read back and send themselves, so
 * what these cases pin is where it lands and what it leaves alone. A question
 * already half-written in the box keeps its place above it, with its pasted blobs
 * and its armed schedule; a review read on a sub-thread never lands in the root's
 * box, because that would put the reader's words about one thread into a message
 * to another.
 *
 * Only when there is no box for that thread at all — a board whose window has
 * closed — is the review sent, because feedback that cannot be handed over is
 * worth more said than dropped. That path keeps `consumeComposer: false` and
 * `interpretCommands: false`: the composer belongs to a message nobody has sent,
 * a later validation failure must not restore the review over it, and generated
 * text is an ordinary message even when it starts with a `/`.
 *
 * The rest is the promise the service makes about the comments themselves: they
 * are never cleared by handing them over — text in a box has not been said — and
 * they survive every refusal.
 * @module unit-tests/review-send-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import { formatReviewMessage } from '../../js/utils/review-message.js';
import { formatCodeReference } from '../../sdk/lib/context-item-utils.js';
import '../../js/components/pinboard-content.js';
import '../../js/components/conversation-tab.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class ReviewSendProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'review-send-probe',
    name: 'Review send probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    container.textContent = 'review send probe';
    return { teardown: () => {} };
  }
}

/**
 * One comment, as a pin would hand it over.
 * @param {string} id - The comment's id.
 * @param {string} body - What the reader wrote.
 * @param {Partial<any>} [extra] - Anything else to override.
 * @returns {any} The comment record.
 */
const comment = (id, body, extra = {}) => ({
  id,
  repo: '',
  path: 'web/js/app.js',
  side: 'new',
  startLine: 12,
  endLine: 12,
  lineText: ['  const x = 1;'],
  body,
  revision: 'sha256:9f1c',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...extra,
});

/**
 * The active-context snapshot the panel above hands the content band.
 * @param {any} conversation - The conversation on screen, or null for a board with none.
 * @param {string|null} threadId - The thread being read, null for the root.
 * @returns {any} The snapshot.
 */
const activeContext = (conversation, threadId) => ({
  project: { path: '/tmp/review-send', displayName: 'review-send' },
  conversation: conversation ? { id: conversation.id, title: conversation.name } : null,
  thread: conversation ? { id: threadId } : null,
});

/**
 * The user messages on a thread, queued ones included: a message parked behind a
 * live turn has been accepted, and counting only `items` would read it as lost.
 * @param {any} thread - The thread to read.
 * @returns {string[]} Each user message's content, in order.
 */
const userMessages = (thread) => [...thread.items, ...thread.pendingItems]
  .filter((item) => item.get('type') === 'user')
  .map((item) => String(item.get('content') ?? ''));

/**
 * What a promise did, without the throwing.
 * @param {Promise<any>} promise - The promise to watch.
 * @returns {Promise<{value: any, error: any}>} Its outcome as data.
 */
async function settled(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1400px;height:900px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(ReviewSendProbePin, { extensionId: 'test' });
  probe.context = null;

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let content = null;
  /** @type {any} */
  let board = null;
  /** @type {any} */
  let tab = null;

  // --- the message ----------------------------------------------------------

  await run('a review is a header and one block per comment', () => {
    const text = formatReviewMessage({
      comments: [comment('c1', 'Keep annotation state outside the renderer.', {
        path: 'web/js/components/diff-viewer.js',
        startLine: 85,
        lineText: ['  this._renderComments(hunks);'],
      })],
    });
    const expected = 'Review feedback:\n\n'
      + './web/js/components/diff-viewer.js:85 (new)\n'
      + '>   this._renderComments(hunks);\n'
      + 'Keep annotation state outside the renderer.';
    assert(text === expected, `expected the block format, got ${JSON.stringify(text)}`);
  });

  await run('comments from another scope are grouped under what they compared', () => {
    const text = formatReviewMessage({
      comments: [
        comment('b', 'On the branch', {
          path: 'b.js', scope: 'main...HEAD', scopeLabel: 'main...HEAD · aaaaaaa..bbbbbbb',
        }),
        comment('a', 'In the working tree', { path: 'a.js' }),
      ],
    });
    const blocks = text.split('\n\n');
    assert(blocks[0] === 'Review feedback:', `the header is unchanged: ${JSON.stringify(text)}`);
    assert(blocks[1] === 'Working tree against HEAD:', `the default scope goes first and is named: ${JSON.stringify(text)}`);
    assert(blocks[2]?.endsWith('In the working tree'), `then its comments: ${JSON.stringify(text)}`);
    assert(blocks[3] === 'Comparing main...HEAD · aaaaaaa..bbbbbbb:',
      `a scoped comment says what its line numbers are lines of: ${JSON.stringify(text)}`);
    assert(blocks[4]?.endsWith('On the branch'), `then its comments: ${JSON.stringify(text)}`);

    const alone = formatReviewMessage({ comments: [comment('a', 'Only', { scope: '@staged', scopeLabel: 'Staged against HEAD (abcdef0)' })] });
    assert(alone.startsWith('Review feedback:\n\nComparing Staged against HEAD (abcdef0):\n\n'),
      `one scope that is not the default is still named: ${JSON.stringify(alone)}`);
  });

  await run('the blocks are ordered, and the same draft writes the same message twice', () => {
    const draft = {
      comments: [
        comment('d', 'Fourth', { path: 'z.js', startLine: 5 }),
        comment('c', 'Third', { path: 'a.js', startLine: 40 }),
        comment('b', 'Second', { path: 'a.js', startLine: 9, side: 'old' }),
        comment('a', 'First', { path: 'a.js', side: 'file', startLine: undefined, endLine: undefined }),
        comment('e', 'Fifth', { repo: 'vendor/lib', path: 'a.js', startLine: 1 }),
      ],
    };
    const bodies = formatReviewMessage(draft).split('\n\n').slice(1).map((block) => block.split('\n').pop());
    const order = JSON.stringify(bodies);
    assert(order === JSON.stringify(['First', 'Second', 'Third', 'Fourth', 'Fifth']),
      `file before old before new, then line, then repository: got ${order}`);
    assert(formatReviewMessage(draft) === formatReviewMessage(draft),
      'an unchanged draft must write a byte-identical message');
  });

  await run('a comment about a file names no line and no side', () => {
    const text = formatReviewMessage({
      comments: [comment('f', 'This file is two files.', {
        repo: 'vendor/lib',
        path: 'src/main.go',
        side: 'file',
        startLine: undefined,
        endLine: undefined,
        lineText: [],
      })],
    });
    const lines = text.split('\n');
    assert(lines[2] === './vendor/lib/src/main.go',
      `a whole-file comment names the file and nothing else, got ${JSON.stringify(lines[2])}`);
    assert(lines[3] === 'This file is two files.', 'with the reader\'s words under it');
  });

  await run('a review with no comments is no message', () => {
    assert(formatReviewMessage({ comments: [] }) === '', 'there is nothing to say');
    assert(formatReviewMessage(null) === '', 'and nothing to say it about');
  });

  await run('a review comment and a quoted selection are the same block', () => {
    // The one assertion Step 8 had to leave unwritten: the second caller did not
    // exist yet. Both ends are compared here rather than at the textarea, which
    // `unit:composer-selection-quote` already owns — the risk this covers is the
    // two callers drifting apart about paths, ranges, sides and quote bounds.
    const lines = ['renderInlineView(hunks) {', '  const frag = document.createDocumentFragment();'];
    const quoted = formatCodeReference({
      path: 'web/js/components/diff-viewer.js',
      outOfRoot: false,
      startLine: 115,
      endLine: 116,
      side: 'new',
      lines,
    });
    const review = formatReviewMessage({
      comments: [comment('same', 'And this is what I think of it.', {
        path: 'web/js/components/diff-viewer.js',
        side: 'new',
        startLine: 115,
        endLine: 116,
        lineText: lines,
      })],
    });
    const block = review.slice('Review feedback:\n\n'.length);
    assert(block === `${quoted}And this is what I think of it.`,
      `one format, one function, two callers:\n  review:    ${JSON.stringify(block)}`
      + `\n  selection: ${JSON.stringify(quoted)}`);
  });

  // --- the send -------------------------------------------------------------

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);

    const root = conversation.rootMessageThread;
    const child = root.createSubThread({ goal: 'Look at the diff' }).threadId;
    const childThread = conversation.resolveMessageThread(child);

    // A real tab, for a real composer: what the send must leave alone is the box
    // the reviewer has a half-written question sitting in.
    tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();
    await waitFor(() => !!tab.querySelector('composer-box textarea'),
      { description: 'the root composer to build' });
    // Rebound rather than held, because a tab taken out of the page and put back
    // builds a new box: a case that kept the old reference would read an element
    // nobody can see and call the review lost.
    let composer = /** @type {any} */ (tab.querySelector('composer-box'));
    if (!composer._messageThread) composer.setMessageThread(root);

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);
    content.setPin({ id: 'pin_probe', type: 'review-send-probe', config: {} },
      activeContext(conversation, null));
    await waitFor(() => !!probe.context, { description: 'the probe pin to mount' });

    /** @returns {any} `services.review`, as a pin receives it. */
    const service = () => probe.context.services.review;

    /**
     * Wait for one more user message than there was, and return it.
     * @param {any} thread - The thread it should land on.
     * @param {number} before - How many there were.
     * @returns {Promise<string>} The new message's content.
     */
    const nextUserMessage = async (thread, before) => {
      await waitFor(() => userMessages(thread).length > before,
        { description: 'the review to arrive as a user message' });
      const found = userMessages(thread);
      assert(found.length === before + 1,
        `one send is one message: ${found.length - before} arrived`);
      return found[found.length - 1];
    };

    await run('a review goes into the prompt whole, and nothing is sent', async () => {
      composer.clearInput();
      await service().save({
        comments: [comment('c1', 'This loop runs twice'), comment('c2', 'And this name lies', {
          path: 'web/js/model/session.js',
          startLine: 40,
          endLine: 41,
          lineText: ['const a = 1;', 'const b = 2;'],
        })],
      });
      const before = userMessages(root).length;
      await service().compose();

      const text = composer.getText();
      assert(text.startsWith('Review feedback:'), `expected the review in the box, got ${JSON.stringify(text)}`);
      assert(text.includes('This loop runs twice') && text.includes('And this name lies'),
        'every comment goes, or the reviewer wrote something nobody will read');
      assert(text.includes('./web/js/model/session.js:40-41'), 'each with the code it is about');
      assert(userMessages(root).length === before,
        'and none of it is said yet — the last look at it belongs to the reader');
      assert(service().draft().comments.length === 2,
        'so the comments are still theirs to discard, having not been spent');
      composer.clearInput();
    });

    await run('it lands under the question already in the box, and takes nothing of it', async () => {
      // Without this the case could pass by there being no box to find: a
      // review that cannot find the composer disturbs nothing either.
      assert(conversation._getComposer() === composer,
        'precondition: THIS is the box the review will be put in');
      composer.setText('a half-written question');
      composer.flushDraft();
      composer._pasteBlobs.set('paste_1', { content: 'a pasted wall of text', bytes: 21 });
      // Armed the way the clock button arms it, schedule written onto the draft:
      // an in-memory target alone is reconciled away by the first draft save, so
      // asserting on one would be asserting on nothing.
      composer._scheduledSendAt = Date.now() + 600_000;
      composer._scheduledSendMode = 'delay';
      composer._persistDraft(undefined, { scheduleIsAuthoritative: true });

      await service().save({ comments: [comment('c1', 'Written while something else was being typed')] });
      const before = userMessages(root).length;
      await service().compose();

      const text = composer.getText();
      assert(text.startsWith('a half-written question\n'),
        `the question keeps its place above it, got ${JSON.stringify(text)}`);
      assert(text.includes('Written while something else was being typed'),
        'with the review under it, on a line of its own');
      assert(composer._pasteBlobs.size === 1, 'the blobs that draft refers to are left alone');
      assert(composer._scheduledSendAt !== null, 'and so is the send it has armed');
      assert(userMessages(root).length === before, 'and still nothing has been sent');
      composer.clearInput();
    });

    /**
     * Point the board back at the root, whatever the case before it left behind.
     * @returns {void}
     */
    const readRoot = () => { content.setActiveContext(activeContext(conversation, null)); };

    /**
     * The box bound to one thread, if this window has one open for it.
     * @param {string|null} threadItemId - The thread, null for the root.
     * @returns {any} The composer, or undefined.
     */
    const boxFor = (threadItemId) => [...tab.querySelectorAll('composer-box')]
      .find((box) => (box.threadItemId ?? null) === threadItemId);

    /**
     * Run `body` with this window's tab out of the document — a board whose owner
     * window has closed, and the only condition under which a review is sent
     * rather than put in a prompt.
     * @param {() => Promise<void>} body - The case's body.
     * @returns {Promise<void>}
     */
    const withNoPrompt = async (body) => {
      tab.remove();
      try {
        await body();
      } finally {
        container.appendChild(tab);
        tab.setActive();
        await waitFor(() => !!tab.querySelector('composer-box textarea'),
          { description: 'the root composer to be built again' });
        composer = /** @type {any} */ (tab.querySelector('composer-box'));
        if (!composer._messageThread) composer.setMessageThread(root);
      }
    };

    await run('a review read on a sub-thread never lands in the root\'s box', async () => {
      content.setActiveContext(activeContext(conversation, child));
      composer.clearInput();
      await service().save({ comments: [comment('t1', 'About the sub-thread')] });
      const rootBefore = userMessages(root).length;
      const childBefore = userMessages(childThread).length;
      await service().compose();

      // The root's box is never a substitute for the thread's own: putting it
      // there would hand the reader's words about one thread to a message
      // addressed to another. Where it does go depends on whether this window has
      // a column open for the sub-thread, and either is correct.
      assert(composer.getText() === '',
        `the root's box is not where this goes, got ${JSON.stringify(composer.getText())}`);
      const childBox = boxFor(child);
      if (childBox) {
        assert(String(childBox.getText?.() || '').includes('About the sub-thread'),
          `the sub-thread's own box should have it: ${JSON.stringify(childBox.getText?.())}`);
        childBox.clearInput?.();
      } else {
        const sent = await nextUserMessage(childThread, childBefore);
        assert(sent.includes('About the sub-thread'),
          'with no box of its own it is sent on that thread, rather than dropped');
      }
      assert(userMessages(root).length === rootBefore, 'and the root was left out of it either way');
      assert(service().draft().comments.length === 1, 'the comments stay here too');
      readRoot();
    });

    await run('a review with nowhere to put it is still accepted by a busy thread', async () => {
      readRoot();
      // Plant the status the client reads for "this thread is mid-turn". The
      // queueing itself is the worker's (integration:queue-drains-at-turn-
      // boundary pins that); what matters here is that the fallback send meets
      // the busy guard as a send to be queued rather than as one to refuse.
      conversation._llmState.updateStatus(conversation.id, 'custom', { message: 'Working' }, null);
      try {
        assert(conversation.isThreadProcessing(null), 'precondition: the root reads as busy');
        await service().save({ comments: [comment('q1', 'Said over the top of a live turn')] });
        await withNoPrompt(async () => {
          const before = userMessages(root).length;
          await service().compose();
          const sent = await nextUserMessage(root, before);
          assert(sent.includes('Said over the top of a live turn'), 'the review was accepted');
        });
      } finally {
        conversation._llmState.stop(conversation.id);
        composer.clearInput();
      }
    });

    // --- what must be refused -------------------------------------------------

    await run('an empty review is refused rather than pasted as a bare header', async () => {
      readRoot();
      composer.clearInput();
      await service().clear();
      const before = userMessages(root).length;
      const outcome = await settled(service().compose());
      assert(outcome.error, 'there is nothing to hand over');
      assert(composer.getText() === '', 'and nothing went in the box');
      assert(userMessages(root).length === before, 'nor anywhere else');
    });

    await run('a board with no conversation has nowhere to put a review, and says so', async () => {
      content.setActiveContext(activeContext(null, null));
      const outcome = await settled(service().compose());
      assert(outcome.error, 'a hand-over with no destination must reject rather than vanish');
      assert(String(outcome.error.message || '').toLowerCase().includes('conversation'),
        `and say why, got ${JSON.stringify(String(outcome.error.message))}`);
      readRoot();
    });

    await run('a refused send keeps the comments and reports what refused it', async () => {
      // On the fallback path, which is the only one that can be refused: putting
      // text in a box cannot fail, but the send a missing box falls back to can.
      readRoot();
      await service().save({ comments: [comment('r1', 'Written while the engine was away')] });
      await withNoPrompt(async () => {
        const before = userMessages(root).length;
        // The refusals sendMessage can return are all conditions of the machine
        // around it — an unreachable worker, a provider switched off. Standing one
        // up here would be testing that machinery; what this case is about is what
        // the service does with a reason when it gets one back.
        const realSend = conversation.sendMessage;
        conversation.sendMessage = async () => 'worker not ready';
        let outcome;
        try {
          outcome = await settled(service().compose());
        } finally {
          conversation.sendMessage = realSend;
        }
        assert(outcome.error, 'a refused send must reject');
        assert(String(outcome.error.message || '').includes('worker not ready'),
          `carrying the reason it was given, got ${JSON.stringify(String(outcome.error.message))}`);
        const kept = service().draft().comments;
        assert(kept.length === 1 && kept[0].id === 'r1',
          'and the comments stay, because they have not been said yet');
        assert(userMessages(root).length === before, 'with nothing sent');
      });
    });

    // --- a detached board -----------------------------------------------------

    await run('a board with no window of its own hands over into the box it can see', async () => {
      composer.clearInput();
      board = /** @type {any} */ (document.createElement('pinboard-content'));
      container.appendChild(board);
      board.setSession(session);
      board.setPin({ id: 'pin_board', type: 'review-send-probe', config: {} },
        activeContext(conversation, null));
      await waitFor(() => probe.context?.pin?.id === 'pin_board',
        { description: 'the board\'s pin to mount' });
      const detached = probe.context.services.review;
      await detached.save({ comments: [comment('b1', 'Written on the board')] });
      const before = userMessages(root).length;
      await detached.compose();
      assert(composer.getText().includes('Written on the board'),
        `a board needs no column of its own to reach the prompt: ${JSON.stringify(composer.getText())}`);
      assert(userMessages(root).length === before, 'and sends nothing doing it');
      assert(detached.draft().comments.length === 1, 'keeping the comments, as everywhere else');
      composer.clearInput();
    });

    await run('a board sends the review when the window that opened it has gone', async () => {
      // The case above still had the owner's tab — and its composer — in the same
      // document, so it proves a board needs no column of its own, not that it
      // survives the window it was opened from. This is the other half, and the
      // one place a review is sent rather than handed over: with the owner's
      // window gone there is no prompt anywhere to put it in, and feedback that
      // cannot be handed over is worth more said than lost.
      board?.remove();
      board = /** @type {any} */ (document.createElement('pinboard-content'));
      container.appendChild(board);
      board.setSession(session);
      board.setPin({ id: 'pin_orphan', type: 'review-send-probe', config: {} },
        activeContext(conversation, null));
      await waitFor(() => probe.context?.pin?.id === 'pin_orphan',
        { description: 'the orphaned board\'s pin to mount' });
      const orphan = probe.context.services.review;

      await withNoPrompt(async () => {
        await orphan.save({
          comments: [comment('o1', 'Still reviewable'), comment('o2', 'And still sendable')],
        });
        assert(orphan.draft().comments.length === 2,
          `a board writes its draft with no window above it, got ${orphan.draft().comments.length}`);

        await orphan.compose();
        // Waited for by its content rather than by a count: a message an earlier
        // case queued can still be draining onto this thread, and counting the
        // difference here would be counting someone else's traffic.
        await waitFor(() => userMessages(root).some((m) => m.includes('And still sendable')),
          { description: 'the review to be sent' });
        const sent = userMessages(root).find((m) => m.includes('And still sendable')) || '';
        assert(sent.includes('Still reviewable'),
          `the review still reaches its conversation whole:\n${sent}`);
        assert(orphan.draft().comments.length === 2,
          'and the comments stay here too — one rule, whichever way the review went');
      });

      // A send nobody typed is a send nobody gets back: the review must not be
      // restored into the box that came back with the window.
      conversation.restorePendingMessage();
      assert(composer.getText() === '',
        `the box is not where a programmatic send goes back to, got ${JSON.stringify(composer.getText())}`);
      composer.clearInput();
    });

    // Last, because the command it is proving inert would take the transcript —
    // and the sub-thread — with it if it ever ran.
    await run('generated text starting with a slash is an ordinary message', async () => {
      // Something for it to have wiped, since the cases above now mostly leave
      // the transcript empty — they put their reviews in the box instead.
      const planted = userMessages(root).length;
      await conversation.sendMessage('the message a /clear would take with it', null, root, {
        consumeComposer: false,
        interpretCommands: false,
      });
      await nextUserMessage(root, planted);

      const before = userMessages(root).length;
      const reason = await conversation.sendMessage('/clear', null, root, {
        consumeComposer: false,
        interpretCommands: false,
      });
      assert(reason === null, `expected the send to be accepted, got ${JSON.stringify(reason)}`);
      const sent = await nextUserMessage(root, before);
      assert(sent === '/clear', `the text goes as written, got ${JSON.stringify(sent)}`);
      assert(userMessages(root).some((m) => m.includes('a /clear would take with it')),
        'and the transcript it would have wiped is still here');
    });
  } finally {
    board?.remove();
    content?.remove();
    tab?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    probe.context = null;
  }

  return { passed, failed, errors };
}
