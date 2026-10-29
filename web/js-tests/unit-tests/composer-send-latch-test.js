//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's send re-entrancy latch.
 *
 * sendMessage() reads the box, then awaits the thread's skill snapshot and any
 * `@`-mention/dropped-file reads before it dispatches `send-message`. The box is
 * only cleared downstream (by Conversation.sendMessage, in response to that
 * event), so for the width of those awaits the text is still in the textarea,
 * `is-empty` is still off, and the button and Enter are both live. Over a slow
 * link that window is seconds wide — long enough for a user who thinks the
 * button did nothing to press it again — and every press that gets through
 * becomes its own user message: the worker appends the first and queues the
 * rest in pendingItems, with no de-duplication anywhere on the path.
 *
 * These tests hold the skill snapshot open to stand in for that slow link, and
 * pin the three properties the latch has to have:
 *
 *   1. A second send during the window is refused, and exactly ONE send-message
 *      is dispatched.
 *   2. The latch is released once the send dispatches, so the next send works.
 *   3. The latch is released even when a lookup REJECTS — sendMessage() is
 *      called un-awaited from the click and keydown handlers, so a throw
 *      surfaces nowhere and a stuck latch would brick the box permanently.
 * @module unit-tests/composer-send-latch-test
 */

import { initializeRegistries, assert, nextTask } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';
import MessageThread from '../../js/model/message-thread.js';

/**
 * A stand-in for the Skills context item that getThreadSkillSnapshot() looks
 * for. It matches on `constructor.MANIFEST.id === 'skill'`, so the id has to
 * live on the class, not the instance.
 */
class FakeSkillItem {
  /** @param {Promise<any>} gate - Resolves (or rejects) to release the snapshot */
  constructor(gate) {
    this._gate = gate;
  }

  /** @returns {Promise<any[]>} The frozen snapshot rows, once the gate opens */
  async getSnapshotSkills() {
    await this._gate;
    return [];
  }
}
/** @type {{id: string}} */
FakeSkillItem.MANIFEST = { id: 'skill' };

/**
 * Mount a <composer-box> whose skill snapshot is held open by a gate the test
 * controls, reproducing the slow-lookup window without a network.
 *
 * render() runs synchronously in connectedCallback but DEFERS setupListeners()
 * to requestAnimationFrame, and the test-pool window is hidden so rAF may never
 * pump. Bind directly and neutralise the pending call, as mobile-composer-test
 * does.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, sent: Array<any>, thread: any, openGate: () => void}} The mounted box, its textarea, the container, captured send-message details, the stub message thread, and the gate release.
 */
function mountGatedComposer() {
  /** @type {() => void} */
  let openGate = () => {};
  const gate = new Promise((resolve) => {
    openGate = () => resolve(undefined);
  });

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  // The minimum MessageThread surface sendMessage() touches: the skill snapshot
  // (gated), the busy check, and the two context-item entry points a message
  // carrying an @-mention reaches. Returned so a test can swap in a read that
  // rejects.
  /** @type {any} */
  const thread = {
    getContextItems: () => [new FakeSkillItem(gate)],
    // Never queued; the real placement, so a stubbed writer below is the one it calls.
    sendWillQueue: false,
    addSendContext(/** @type {any} */ reads) { return MessageThread.prototype.addSendContext.call(this, reads); },
    executeContextItem: async () => {},
    executeContextItemIntoPending: async () => {},
  };
  /** @type {any} */ (box)._messageThread = thread;

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');

  /** @type {Array<any>} */
  const sent = [];
  container.addEventListener('send-message', (e) => sent.push(/** @type {CustomEvent} */ (e).detail));

  return { box, textarea, container, sent, thread, openGate };
}

/**
 * Run the composer send-latch test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: a repeat press during the lookup window sends only once ───────
  {
    const { box, textarea, container, sent, openGate } = mountGatedComposer();
    try {
      textarea.value = 'hello';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

      // First send parks on the gated snapshot. Deliberately not awaited: this
      // is the un-awaited call the click handler makes.
      const first = /** @type {any} */ (box).sendMessage();

      // The box still holds the text and the button is still live, so the
      // impatient second and third presses reach sendMessage() with identical
      // input — exactly what a user on a slow link produces.
      assert(textarea.value === 'hello',
        `the text must still be in the box during the lookup, got ${JSON.stringify(textarea.value)}`);
      const second = await /** @type {any} */ (box).sendMessage();
      const third = await /** @type {any} */ (box).sendMessage();

      assert(second === 'send already in flight',
        `a second press during the window must be refused, got ${JSON.stringify(second)}`);
      assert(third === 'send already in flight',
        `a third press during the window must be refused, got ${JSON.stringify(third)}`);
      assert(sent.length === 0,
        `nothing may dispatch while the lookup is outstanding, got ${sent.length}`);

      openGate();
      assert(await first === null, 'the first send must report success');
      await nextTask();

      assert(sent.length === 1,
        `three presses during one lookup must dispatch exactly one send-message, got ${sent.length}`);
      assert(sent[0].message === 'hello',
        `the dispatched message must be the typed text, got ${JSON.stringify(sent[0].message)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('repeat-press-sends-once: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 2: the latch releases, so the next send still works ──────────────
  {
    const { box, textarea, container, sent, openGate } = mountGatedComposer();
    try {
      textarea.value = 'first';
      openGate(); // no window this time — the snapshot is already settled
      await /** @type {any} */ (box).sendMessage();
      await nextTask();

      // Nothing clears the box here (that is Conversation.sendMessage's job,
      // and no conversation is wired up), so the text is still present and a
      // genuine second send must go through rather than hit a stuck latch.
      assert(/** @type {any} */ (box)._sending === false,
        'the latch must be clear once the send has dispatched');
      textarea.value = 'second';
      const result = await /** @type {any} */ (box).sendMessage();
      await nextTask();

      assert(result === null, `the follow-up send must succeed, got ${JSON.stringify(result)}`);
      assert(sent.length === 2,
        `two sequential sends must both dispatch, got ${sent.length}`);
      assert(sent[1].message === 'second',
        `the second dispatch must carry the second message, got ${JSON.stringify(sent[1].message)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('latch-releases-after-dispatch: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 3: a mention read that throws still releases the latch ───────────
  {
    const { box, textarea, container, sent, thread, openGate } = mountGatedComposer();
    const realFetch = window.fetch;
    try {
      openGate(); // the snapshot is not what fails here
      thread.executeContextItem = async () => {
        throw new Error('read exploded');
      };

      // The existence check admits the path, so the mention reaches
      // executeContextItem — the read is what fails, not the lookup.
      window.fetch = /** @type {any} */ (async () => ({
        ok: true, status: 200, json: async () => ({ existing: ['/tmp/gone.txt'] }),
      }));
      textarea.value = 'look at @/tmp/gone.txt';
      const first = /** @type {any} */ (box).sendMessage();
      // The click and keydown handlers never await this, so attach a sink of
      // our own rather than letting it surface as an unhandled rejection.
      const settled = first.then(() => 'resolved', () => 'rejected');

      assert(await settled === 'rejected', 'a failing mention read must propagate out of sendMessage');
      await nextTask();

      assert(/** @type {any} */ (box)._sending === false,
        'a mention read that throws must still release the latch, or the box is bricked');
      assert(sent.length === 0, `a failed read must dispatch nothing, got ${sent.length}`);

      // The box is usable again: a send with the mention removed goes through.
      textarea.value = 'plain text';
      assert(await /** @type {any} */ (box).sendMessage() === null,
        'the composer must accept a send after a failed one');
      passed++;
    } catch (e) {
      failed++;
      errors.push('latch-releases-on-throw: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      window.fetch = realFetch;
      container.remove();
    }
  }

  return { passed, failed, errors };
}
