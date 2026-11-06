//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: ⇧⌘J, the next conversation waiting on the user in any project
 * (services/attention-anywhere.js) — ⌘J's cross-project twin, and what the
 * header's pill does.
 *
 * It goes to the first of what needs the user, in the sessions page's order
 * (waiting oldest first, then failed), passing over the conversation already on
 * screen. One in this project is switched to in place and landed on as ⌘J
 * lands; one in another goes there (project-navigation). With nothing else
 * waiting it does nothing, and reports so, so the key falls through. While the
 * machine's feed is unavailable it is ⌘J.
 * @module unit-tests/jump-to-attention-anywhere-test
 */

import { assert } from '../utilities/test-helpers.js';
import { jumpToAttentionAnywhere } from '../../js/services/attention-anywhere.js';

/**
 * A need as the feed lists one.
 * @param {string} project - The project's folder name.
 * @param {string} id - The conversation.
 * @returns {any} The need.
 */
function need(project, id) {
  return {
    s: { id: `s-${project}`, project: `/work/${project}`, link: `/p/${project}-0123abcd/`, state: 'running' },
    item: { id, name: id, state: 'waiting' },
  };
}

/**
 * Stand-ins, each recording what it was asked.
 * @param {any[]} needs - What the feed lists.
 * @param {boolean} [available]
 * @returns {any} The world.
 */
function world(needs, available = true) {
  /** @type {any[]} */
  const log = [];
  const session = {
    visibleConversationId: 'b-here',
    conversations: new Map([['b-here', {}], ['b-two', {}]]),
    /** @param {string} id */
    switchConversation(id) { log.push(['switch', id]); session.visibleConversationId = id; },
  };
  return {
    log,
    session,
    deps: {
      feed: { available, needs },
      ownLink: '/p/beta-0123abcd/',
      /** @param {any} to */
      goTo: async (to) => { log.push(['go', to.link, to.conversation]); },
      /**
       * @param {any} _s
       * @param {string} id
       */
      reveal: async (_s, id) => { log.push(['reveal', id]); },
      fallback: () => { log.push(['cmd-j']); return true; },
    },
  };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void> | void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await test('the oldest wait in another project is gone to', async () => {
    const w = world([need('alpha', 'a-old'), need('beta', 'b-here'), need('beta', 'b-two')]);
    const acted = await jumpToAttentionAnywhere(w.session, w.deps);
    assert(acted, 'reported doing nothing');
    assert(JSON.stringify(w.log) === '[["go","/p/alpha-0123abcd/","a-old"]]', `log ${JSON.stringify(w.log)}`);
  });

  await test('the conversation on screen is passed over, and one in this project is switched to here', async () => {
    const w = world([need('beta', 'b-here'), need('beta', 'b-two'), need('alpha', 'a-new')]);
    const acted = await jumpToAttentionAnywhere(w.session, w.deps);
    assert(acted, 'reported doing nothing');
    assert(JSON.stringify(w.log) === '[["switch","b-two"],["reveal","b-two"]]', `log ${JSON.stringify(w.log)}`);
  });

  await test('with nothing else waiting it does nothing, and says so', async () => {
    const w = world([need('beta', 'b-here')]);
    const acted = await jumpToAttentionAnywhere(w.session, w.deps);
    assert(!acted && w.log.length === 0, `acted ${acted}, log ${JSON.stringify(w.log)}`);
  });

  await test('while the machine\'s feed is unavailable it is ⌘J', async () => {
    const w = world([need('alpha', 'a-old')], false);
    const acted = await jumpToAttentionAnywhere(w.session, w.deps);
    assert(acted && JSON.stringify(w.log) === '[["cmd-j"]]', `acted ${acted}, log ${JSON.stringify(w.log)}`);
  });

  return { passed, failed, errors };
}
