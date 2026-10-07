//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A bin is one transaction: nothing may put the conversation back.
 *
 * Binning removes the conversation locally and then tells the server. That
 * leaves a window in which the client has dropped it and the server has not yet
 * moved the folder — and a manifest read taken inside that window still lists
 * it. `Session.refreshFromServer` treats any id the manifest lists and the map
 * lacks as a conversation another viewer just created, loads it, and announces
 * it as `conversation:created`. The tab the user just threw away comes back.
 *
 * The window is real rather than theoretical: the server serializes session
 * state on one goroutine that drains reads ahead of queued writes, so a GET
 * issued after the bin POST can be answered before it. What the user sees
 * depends on where the server's `binned` broadcast lands relative to the
 * refresh's rebuild — a tab that flashes back and vanishes, or one that stays.
 *
 * The race is driven through the session's own apiService rather than by
 * timing, so it lands in the same place every run: the refresh is issued from
 * inside the bin request, while the folder is still where the manifest says it
 * is. The wrapper is per-session because the apiService module is a singleton
 * every lane in the pool shares.
 * @module unit-tests/bin-ghost-resurrection
 */

import {
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * Give this session its own apiService whose bin request runs a full refresh
 * first — the manifest read that beats the bin write. Everything else delegates
 * to the real service through the prototype chain.
 * @param {any} session - Session to wrap
 * @returns {any} The real apiService, to put back afterwards
 */
function refreshInsideBin(session) {
  const real = session._apiService;
  const wrapper = Object.create(real);
  wrapper.binConversation = async (/** @type {string} */ id) => {
    // Before the POST, so the conversation is still on disk and the manifest
    // still lists it — exactly what a read drained ahead of the bin write sees.
    await session.refreshFromServer();
    return real.binConversation(id);
  };
  session._apiService = wrapper;
  return real;
}

/**
 * Mount a conversation-bar rendering `session` without spinning up the
 * per-conversation host elements and workers `setSession` would. The bar is
 * driven by hand, as `test-harness.binConversationViaBar` does.
 * @param {any} session - Session the bar renders
 * @returns {{bar: any, container: HTMLElement}} The bar and its mount point
 */
function mountBar(session) {
  const container = document.createElement('div');
  container.id = 'bin-ghost-resurrection-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);
  bar._session = session;
  bar.render();
  return { bar, container };
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all bin-ghost-resurrection tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  // A refresh that overlaps a bin must not undo it. The doomed conversation is
  // created last so it is the visible one: binning the tab the user is looking
  // at is the path that also switches to a fallback and saves the session, and
  // that save is the second thing that can put a stale manifest on the wire.
  {
    /** @type {any} */
    let realApi = null;
    /** @type {any} */
    let mount = null;
    /** @type {string[]} */
    const created = [];
    /** @type {string|null} */
    let doomedId = null;
    try {
      const keeper = await createTestConversation(session);
      created.push(keeper.id);
      const doomed = await createTestConversation(session);
      doomedId = doomed.id;

      mount = mountBar(session);
      const tabOf = (/** @type {string} */ id) =>
        mount.bar.querySelector(`li.conversation-tab[data-conversation-id="${id}"]`);
      assert(!!tabOf(doomedId), 'the conversation to be binned has no tab to begin with');

      realApi = refreshInsideBin(session);
      await mount.bar._binConversation(doomedId);

      assert(!session.conversations.has(doomedId),
        'a refresh overlapping the bin put the conversation back in the map — the bin is not one transaction, and the tab the user threw away returns');
      assert(session.conversations.has(keeper.id),
        'the bin took a conversation with it that nobody asked to bin');

      mount.bar.render();
      assert(!tabOf(doomedId),
        'the binned conversation still has a tab in the bar after the bin settled');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a refresh overlapping a bin cannot resurrect it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (realApi) session._apiService = realApi;
      mount?.container.remove();
      // Whatever state the assertions left it in, the conversation is binned
      // server-side: empty it out rather than leaving it for the next lane.
      if (doomedId) {
        session.conversations.delete(doomedId);
        try {
          await session.bin.deletePermanently(doomedId);
        } catch {
          // Already gone, or never made it to the bin — nothing to clean up.
        }
      }
      for (const id of created) await session.deleteConversation(id);
    }
  }

  // Every affordance that bins stays live across the round-trip the bin takes,
  // so the same conversation can be binned twice before the first one lands.
  // The second attempt must find nothing to do: two teardowns of one
  // conversation, and a second request for a folder the first already moved.
  {
    /** @type {any} */
    let realApi = null;
    /** @type {any} */
    let mount = null;
    /** @type {string[]} */
    const created = [];
    /** @type {string|null} */
    let doomedId = null;
    try {
      const keeper = await createTestConversation(session);
      created.push(keeper.id);
      const doomed = await createTestConversation(session);
      doomedId = doomed.id;

      realApi = session._apiService;
      const wrapper = Object.create(realApi);
      let requests = 0;
      wrapper.binConversation = async (/** @type {string} */ id) => {
        requests++;
        return realApi.binConversation(id);
      };
      session._apiService = wrapper;

      mount = mountBar(session);
      // Started together, so the second lands while the first is still on the
      // wire — the window a user hits by double-clicking the bin button.
      await Promise.all([
        mount.bar._binConversation(doomedId),
        mount.bar._binConversation(doomedId)
      ]);

      assert(requests === 1,
        `binning one conversation twice sent ${requests} bin requests — the second tears down a conversation that is already gone and asks the server to move a folder it has already moved`);
      assert(!session.conversations.has(doomedId),
        'the conversation survived being binned twice');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`binning the same conversation twice bins it once: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (realApi) session._apiService = realApi;
      mount?.container.remove();
      if (doomedId) {
        session.conversations.delete(doomedId);
        try {
          await session.bin.deletePermanently(doomedId);
        } catch {
          // Already gone, or never made it to the bin — nothing to clean up.
        }
      }
      for (const id of created) await session.deleteConversation(id);
    }
  }

  return { passed, failed, errors };
}
