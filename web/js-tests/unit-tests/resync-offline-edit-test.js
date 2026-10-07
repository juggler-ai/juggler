//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file An edit made while the socket is down must reach the server on reconnect.
 *
 * Outbound Yjs updates are discarded while the link is down — nothing queues
 * them — so an edit made during an outage exists only in this client's doc. The
 * reconnect resync is what recovers it: the worker's `resync-response` carries
 * its own state vector, and the client answers with exactly the ops that vector
 * does not cover.
 *
 * The test drives the real thing end to end — a real conversation, a real
 * worker, a real socket drop — and observes the SERVER's state through an
 * independent second client, so what it asserts is that the worker genuinely
 * holds the op, not that this client still remembers making it.
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import wsService from '../../js/services/websocket.js';
import SecondViewer from '../utilities/second-viewer.js';
import { plainToYMap } from '../../js/model/item-accessor.js';
import { createAssistantMessage } from '../../sdk/lib/message.js';

const ONLINE_MARKER = 'written while the link was up';
const OFFLINE_MARKER = 'written while the socket was down';

/**
 * Append an item to the root thread, exactly as a local edit does.
 * Assistant-typed: a trailing USER message would start a turn on the worker,
 * which has nothing to do with what is under test here.
 * @param {any} conversation - Conversation to write to.
 * @param {string} content - Item content.
 */
function appendLocalItem(conversation, content) {
  const thread = conversation.rootMessageThread;
  thread.insertAt(thread.length, plainToYMap(createAssistantMessage(content)));
}

/**
 * Whether a second client's independently-synced doc holds an item.
 * @param {any} viewer - SecondViewer instance.
 * @param {string} content - Item content to look for.
 * @returns {boolean} True if the item is present.
 */
function viewerHas(viewer, content) {
  return viewer.items().some((/** @type {any} */ it) => it.content === content);
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const convId = conversation.id;

  // An independent client on the same conversation: it reads the WORKER's
  // state over its own socket, which our disconnect never touches.
  const viewer = new SecondViewer(convId);
  await viewer.open();

  try {
    // Baseline, link up: a local edit reaches the worker and fans out. This is
    // what makes the "not there yet" check below mean something.
    appendLocalItem(conversation, ONLINE_MARKER);
    await waitFor(() => viewerHas(viewer, ONLINE_MARKER), {
      timeoutMs: 10000,
      description: 'the online edit to reach the worker'
    });
    passed++;

    // The link drops, and the user keeps working. The update this produces is
    // discarded by the transport — nothing queues it.
    await wsService.simulateDisconnect();
    appendLocalItem(conversation, OFFLINE_MARKER);

    // Come back as a genuine drop rather than a clean teardown: a reconnect is
    // the path gated on the server's boot id, and an unchanged one must leave a
    // link the resync below can actually run over.
    wsService._reconnectAttempts = 1;
    await wsService.reconnect();

    // Reconnecting alone recovers nothing: the frame is long gone.
    assert(!viewerHas(viewer, OFFLINE_MARKER),
      'the offline edit must not be at the worker before the resync (nothing replays the dropped frame)');
    passed++;

    // The reconnect handshake: state vectors both ways.
    workerManager.resyncReadyConversations();

    await waitFor(() => viewerHas(viewer, OFFLINE_MARKER), {
      timeoutMs: 10000,
      description: 'the offline edit to reach the worker after the resync'
    });
    passed++;

    // And the client is not left holding a doc it silently diverged from.
    assert(viewerHas(viewer, ONLINE_MARKER),
      'the pre-outage item must still be there — the resync exchanges deltas, it does not replace state');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`offline edit reaches the server after reconnect: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    viewer.close();
  }

  return { passed, failed, errors };
}
