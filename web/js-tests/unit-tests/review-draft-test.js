//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a review's comments live while they are being written: on the thread
 * they will be sent to, in the conversation's own document.
 *
 * Two halves, because a draft is reached from two directions. The model half is
 * `MessageThread.gitReviewDraft` — the root's in conversation metadata, a
 * sub-thread's on its own container, the same split the composer draft uses and
 * for the same reason. The seam half is `services.review`, which is all a pin
 * ever sees: it reads and writes the draft belonging to whichever thread the
 * reader is in, and refuses when there is no conversation to hold one.
 *
 * The cases that matter are the ones where a draft must NOT be shared. Two
 * threads are two reviews; a conversation switch reveals the other
 * conversation's comments rather than retargeting these; and neither a
 * review-draft write nor a composer write may touch the other, because they are
 * neighbours in the same document and the composer's is the one the user would
 * notice losing.
 *
 * Driven through a probe item type registered only here, the same way
 * `unit:pinboard-git-review` is, because the thing under test is the context a
 * pin is handed.
 * @module unit-tests/review-draft-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import { normalizeReviewDraft, REVIEW_DRAFT_LIMITS } from '../../js/utils/review-draft.js';
import '../../js/components/pinboard-content.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class ReviewProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'review-draft-probe',
    name: 'Review draft probe',
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
    container.textContent = 'review draft probe';
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
  project: { path: '/tmp/review-draft', displayName: 'review-draft' },
  conversation: conversation ? { id: conversation.id, title: conversation.name } : null,
  thread: conversation ? { id: threadId } : null,
});

/**
 * Wait for something to become true, rather than for a length of time: a lane
 * shares one browser with every other, so a fixed delay is a coin toss.
 * @param {() => any} check - Returns something truthy once the wait is over.
 * @param {string|(() => string)} what - The complaint if it never happens.
 * @param {number} [timeout] - How long to give it.
 * @returns {Promise<any>} Whatever `check` returned.
 */
async function waitFor(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(typeof what === 'function' ? what() : what);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

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
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(ReviewProbePin, { extensionId: 'test' });
  probe.context = null;

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let other = null;
  /** @type {any} */
  let content = null;
  /** @type {any} */
  let board = null;

  try {
    session = await createTestSession();
    conversation = await createTestConversation(session);
    other = await createTestConversation(session);

    const root = conversation.rootMessageThread;
    const child = root.createSubThread({ goal: 'Look at the diff' }).threadId;
    const childThread = conversation.resolveMessageThread(child);

    // --- the model ------------------------------------------------------------

    await run('an empty thread reads as a well-formed empty draft', () => {
      const draft = root.gitReviewDraft;
      assert(draft.version === 1, `expected version 1, got ${JSON.stringify(draft.version)}`);
      assert(draft.base === 'head', `the only scope there is, got ${JSON.stringify(draft.base)}`);
      assert(Array.isArray(draft.comments) && draft.comments.length === 0,
        'comments is always an array, so nothing has to guard it');
    });

    await run('a comment written on the root comes back from the root', () => {
      root.gitReviewDraft = { comments: [comment('c1', 'This loop runs twice')] };
      const draft = root.gitReviewDraft;
      assert(draft.comments.length === 1, `expected the comment, got ${draft.comments.length}`);
      assert(draft.comments[0].body === 'This loop runs twice',
        `the reader's own words, got ${JSON.stringify(draft.comments[0].body)}`);
      assert(draft.comments[0].path === 'web/js/app.js', 'and the file it hangs on');
      assert(draft.comments[0].startLine === 12, 'and the line');
      assert(draft.comments[0].revision === 'sha256:9f1c',
        'and the fingerprint that decides whether it is still anchored');
    });

    await run('the root and a sub-thread are two different reviews', () => {
      childThread.gitReviewDraft = { comments: [comment('c2', 'Only the child said this')] };
      assert(root.gitReviewDraft.comments.length === 1, 'the root keeps its own');
      assert(root.gitReviewDraft.comments[0].id === 'c1',
        `the root's comment is the root's, got ${root.gitReviewDraft.comments[0].id}`);
      assert(childThread.gitReviewDraft.comments.length === 1, 'and the child keeps its own');
      assert(childThread.gitReviewDraft.comments[0].id === 'c2',
        `a sub-thread's review is its own, got ${childThread.gitReviewDraft.comments[0].id}`);
    });

    await run('a draft is a copy, not a handle on the document', () => {
      const draft = root.gitReviewDraft;
      draft.comments.push(comment('c-not-really', 'Written into the copy'));
      draft.comments[0].body = 'Rewritten in the copy';
      assert(root.gitReviewDraft.comments.length === 1,
        'pushing into what a read handed back must not reach the document');
      assert(root.gitReviewDraft.comments[0].body === 'This loop runs twice',
        `nor must editing it, got ${JSON.stringify(root.gitReviewDraft.comments[0].body)}`);
    });

    await run('a record made of junk normalises rather than throwing', () => {
      const draft = normalizeReviewDraft({
        version: 'no', base: 42, comments: [
          comment('good', 'Kept'),
          null,
          'not a comment',
          comment('', 'No id'),
          comment('no-path', 'No path', { path: '' }),
          comment('blank', '   '),
          comment('bad-side', 'Nonsense side', { side: 'sideways' }),
        ],
      });
      assert(draft.version === 1 && draft.base === 'head', 'the fixed fields are answered, not echoed');
      const ids = draft.comments.map((/** @type {any} */ c) => c.id);
      assert(JSON.stringify(ids) === JSON.stringify(['good']),
        `only a comment that could be drawn survives, got ${JSON.stringify(ids)}`);
    });

    await run('a comment keeps the scope it was written in, and the default is no scope', () => {
      const draft = normalizeReviewDraft({
        comments: [
          comment('scoped', 'On the branch', { scope: '  main...HEAD ', scopeLabel: 'main...HEAD · aaaaaaa..bbbbbbb' }),
          comment('default', 'In the tree', { scope: '@uncommitted', scopeLabel: 'Working tree against HEAD' }),
          comment('old', 'Written before scopes'),
          comment('junk', 'Junk scope', { scope: 42, scopeLabel: ['x'] }),
        ],
      });
      const [scoped, plain, old, junk] = draft.comments;
      assert(scoped.scope === 'main...HEAD' && scoped.scopeLabel === 'main...HEAD · aaaaaaa..bbbbbbb',
        `a scope and its words survive, folded: ${JSON.stringify(scoped)}`);
      assert(!('scope' in plain) && !('scopeLabel' in plain),
        `the default is stored as no scope at all: ${JSON.stringify(plain)}`);
      assert(!('scope' in old), 'a comment written before scopes is a comment in the default one');
      assert(!('scope' in junk) && !('scopeLabel' in junk), `a scope that is not a string is no scope: ${JSON.stringify(junk)}`);

      childThread.gitReviewDraft = { comments: [comment('round', 'Trip', { scope: '@staged', scopeLabel: 'Staged' })] };
      const back = childThread.gitReviewDraft.comments[0];
      assert(back.scope === '@staged' && back.scopeLabel === 'Staged',
        `the scope survives the document: ${JSON.stringify(back)}`);
      childThread.gitReviewDraft = null;
    });

    await run('a quoted line is clamped, and the words around it are not', () => {
      const long = 'x'.repeat(REVIEW_DRAFT_LIMITS.quoteColumns + 500);
      const many = Array.from({ length: REVIEW_DRAFT_LIMITS.quoteLines + 20 }, () => 'line');
      const body = 'y'.repeat(REVIEW_DRAFT_LIMITS.body - 1);
      const draft = normalizeReviewDraft({
        comments: [comment('c', body, { lineText: [long, ...many] })],
      });
      const kept = draft.comments[0];
      assert(kept.lineText.length === REVIEW_DRAFT_LIMITS.quoteLines,
        `a quote is a copy of code, so bounding it loses nothing: got ${kept.lineText.length}`);
      assert(kept.lineText[0].length === REVIEW_DRAFT_LIMITS.quoteColumns,
        `and so is one very long line of it: got ${kept.lineText[0].length}`);
      assert(kept.body === body, 'what the reader typed is never quietly shortened');
    });

    await run('clearing a draft leaves nothing behind on either kind of thread', () => {
      childThread.gitReviewDraft = null;
      assert(childThread.gitReviewDraft.comments.length === 0,
        'a cleared sub-thread draft reads as empty');
      assert(childThread.container.get('gitReviewDraft') === undefined,
        'and the field goes, rather than being left as an empty husk');
      root.gitReviewDraft = { comments: [] };
      assert(root.gitReviewDraft.comments.length === 0, 'a cleared root draft reads as empty too');
    });

    await run('a review draft and a composer draft do not touch each other', () => {
      root.draft = { text: 'half-written question' };
      root.gitReviewDraft = { comments: [comment('c3', 'A comment')] };
      assert(root.draft.text === 'half-written question',
        `writing a review must not disturb the composer, got ${JSON.stringify(root.draft.text)}`);
      root.draft = { text: 'still here' };
      assert(root.gitReviewDraft.comments.length === 1,
        'and writing the composer must not disturb the review');
      root.gitReviewDraft = null;
      assert(root.draft.text === 'still here',
        `nor must clearing one clear the other, got ${JSON.stringify(root.draft.text)}`);
      root.draft = null;
    });

    // --- the seam a pin is handed ---------------------------------------------

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);
    content.setPin({ id: 'pin_probe', type: 'review-draft-probe', config: {} },
      activeContext(conversation, null));
    await waitFor(() => probe.context, 'the probe pin never mounted');

    /** @returns {any} `services.review`, as a pin receives it. */
    const service = () => probe.context.services.review;

    await run('a pin reads and writes the thread the reader is in', async () => {
      await service().save({ comments: [comment('s1', 'Said through the service')] });
      const draft = service().draft();
      assert(draft.comments.length === 1, `expected the comment back, got ${draft.comments.length}`);
      assert(draft.comments[0].id === 's1', 'and it is the one that was saved');
      assert(root.gitReviewDraft.comments[0].id === 's1',
        'a service write lands on the thread itself, not beside it');
    });

    await run('what a pin is handed is a copy', () => {
      const draft = service().draft();
      draft.comments.length = 0;
      assert(service().draft().comments.length === 1,
        'emptying the copy must not empty the draft');
    });

    await run('a saved draft tells whoever is watching', async () => {
      let told = 0;
      const stop = service().onChange(() => { told++; });
      await service().save({ comments: [comment('s1', 'Edited'), comment('s2', 'And another')] });
      await waitFor(() => told > 0, 'nobody was told the draft changed');
      assert(service().draft().comments.length === 2, 'and the change is there to read');
      stop();
      await service().save({ comments: [comment('s1', 'Edited again')] });
      const after = told;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert(told === after, 'and unsubscribing stops it');
    });

    await run('moving to another thread reveals that thread\'s review', async () => {
      await service().save({ comments: [comment('s1', 'On the root')] });
      let told = 0;
      const stop = service().onChange(() => { told++; });
      content.setActiveContext(activeContext(conversation, child));
      await waitFor(() => told > 0, 'a pin was never told the thread it reads had changed');
      assert(service().draft().comments.length === 0,
        'the sub-thread has a review of its own, and it is empty');
      await service().save({ comments: [comment('s9', 'On the sub-thread')] });
      content.setActiveContext(activeContext(conversation, null));
      const back = service().draft();
      assert(back.comments.length === 1 && back.comments[0].id === 's1',
        `going back reveals the root's own comments, got ${JSON.stringify(back.comments.map((/** @type {any} */ c) => c.id))}`);
      stop();
    });

    await run('switching conversation reveals its draft rather than retargeting these', async () => {
      content.setActiveContext(activeContext(other, null));
      assert(service().draft().comments.length === 0,
        'another conversation has not been reviewed, so it has no comments');
      await service().save({ comments: [comment('o1', 'About the other one')] });
      content.setActiveContext(activeContext(conversation, null));
      assert(service().draft().comments[0].id === 's1',
        'and the first conversation\'s comments stayed where they were written');
      assert(other.rootMessageThread.gitReviewDraft.comments[0].id === 'o1',
        'while the other\'s went to the other');
    });

    await run('clearing empties the draft and says so', async () => {
      await service().clear();
      assert(service().draft().comments.length === 0, 'a cleared review has no comments');
      assert(root.gitReviewDraft.comments.length === 0, 'in the document as well as in the answer');
    });

    // --- what must be refused --------------------------------------------------

    await run('a board with no conversation has nowhere to keep a comment, and says so', async () => {
      content.setActiveContext(activeContext(null, null));
      assert(service().draft() === null,
        'null is "there is no conversation", which is different from "no comments yet"');
      const outcome = await settled(service().save({ comments: [comment('x', 'Nowhere to go')] }));
      assert(outcome.error, 'a save with no destination must reject rather than vanish');
      assert(String(outcome.error.message || '').toLowerCase().includes('conversation'),
        `and say why, got ${JSON.stringify(String(outcome.error.message))}`);
      content.setActiveContext(activeContext(conversation, null));
    });

    await run('more comments than a review can hold is refused, and nothing is written', async () => {
      await service().save({ comments: [comment('keep', 'The one already there')] });
      const tooMany = Array.from({ length: REVIEW_DRAFT_LIMITS.comments + 1 },
        (_, i) => comment(`c${i}`, 'One of far too many'));
      const outcome = await settled(service().save({ comments: tooMany }));
      assert(outcome.error, 'a draft over the ceiling must be refused');
      assert(String(outcome.error.message || '').includes(String(REVIEW_DRAFT_LIMITS.comments)),
        `naming the limit it broke, got ${JSON.stringify(String(outcome.error.message))}`);
      const kept = service().draft().comments;
      assert(kept.length === 1 && kept[0].id === 'keep',
        'and a refused save leaves what was there alone');
    });

    await run('a comment longer than the ceiling is refused rather than truncated', async () => {
      const outcome = await settled(service().save({
        comments: [comment('c', 'z'.repeat(REVIEW_DRAFT_LIMITS.body + 1))],
      }));
      assert(outcome.error, 'the alternative is silently eating the end of what someone wrote');
      assert(String(outcome.error.message || '').includes(String(REVIEW_DRAFT_LIMITS.body)),
        `naming the limit, got ${JSON.stringify(String(outcome.error.message))}`);
      assert(service().draft().comments[0].id === 'keep', 'and nothing was written');
    });

    // --- a second board on the same conversation ------------------------------

    await run('a detached board reads and writes the same durable draft', async () => {
      board = /** @type {any} */ (document.createElement('pinboard-content'));
      container.appendChild(board);
      board.setSession(session);
      board.setPin({ id: 'pin_board', type: 'review-draft-probe', config: {} },
        activeContext(conversation, null));
      await waitFor(() => probe.context?.pin?.id === 'pin_board', 'the board\'s pin never mounted');
      const detached = probe.context.services.review;
      assert(detached.draft().comments[0].id === 'keep',
        'a board reading the same conversation reads the same comments');
      await detached.save({ comments: [comment('keep', 'The one already there'), comment('b1', 'From the board')] });
      assert(root.gitReviewDraft.comments.length === 2,
        'and what it writes goes to the conversation, not to the window');
    });
  } finally {
    board?.remove();
    content?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    probe.context = null;
  }

  return { passed, failed, errors };
}
