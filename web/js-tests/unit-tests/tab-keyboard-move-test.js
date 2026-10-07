//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ⇧Page Up/Down moves the visible conversation's tab one place, from the
 * keyboard.
 *
 * The tab steps past one neighbour in the list it is drawn in. Inside a
 * workspace box that is the box's own tabs; at the top level a whole box is one
 * neighbour. It never crosses a box edge — that is a rebinding, which a drag
 * asks about and a keystroke must not do — so a press at the edge of its list
 * moves nothing and writes nothing.
 *
 * Driven through the `juggler:move-tab` event the shortcut dispatches, against
 * a bar the real render() drew, with a session stub that records the
 * arrangement it is handed.
 * @module unit-tests/tab-keyboard-move-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function workspace(id) {
  return { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, providerId: '(none)' };
}

/**
 * Mount a bar drawing the given bindings, a box for each workspace they name,
 * and a session stub that records every arrangement it is asked to apply.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, calls: string[], teardown: () => void}} The bar, its session, the recorded orders, and a teardown.
 */
function mountBar(bindings) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);

  // Only the boxes something is bound to: an empty box is drawn too, and would
  // be one more neighbour at the top level.
  const workspaces = [...new Set(bindings.map(([, ws]) => ws).filter(Boolean))].map(workspace);
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const session = {
    workspaces,
    projectPath: '/tmp/project',
    bin: { count: 0, sizeBytes: 0 },
    visibleConversationId: null,
    conversations: new Map(),
    /**
     * @param {string} id - Which workspace.
     * @returns {any} The row, if the table holds it.
     */
    getWorkspace(id) { return workspaces.find((row) => row.id === id) || null; },
    /**
     * @param {string} id - Which workspace, '' for the project.
     * @returns {string|null} The root to work in.
     */
    workspaceRoot(id) {
      if (!id) return this.projectPath;
      return workspaces.find((row) => row.id === id)?.root ?? null;
    },
    /**
     * @param {{order: string[]}} arrangement - The strip as the move left it.
     * @returns {boolean} Always accepted.
     */
    applyStripArrangement({ order }) {
      calls.push(order.join(','));
      // Take the strip's word for it, as the real session does, so the next
      // render draws the order that was written.
      const next = new Map(order.map((id) => [id, this.conversations.get(id)]));
      this.conversations = next;
      return true;
    }
  };
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }
  bar._session = session;
  bar.render();
  return { bar, session, calls, teardown: () => host.remove() };
}

/**
 * The strip as drawn: tabs top to bottom, a box written as `[its tabs]`.
 * @param {any} bar - The mounted bar.
 * @returns {string} The drawn order.
 */
function drawn(bar) {
  const list = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
  return Array.from(list.children).map((child) => {
    const el = /** @type {HTMLElement} */ (child);
    if (el.classList.contains('conversation-tab')) return el.dataset.conversationId;
    if (el.classList.contains('conversation-box')) {
      const inner = Array.from(el.querySelectorAll('.conversation-tab'))
        .map((t) => /** @type {HTMLElement} */ (t).dataset.conversationId);
      return `[${inner.join(',')}]`;
    }
    return null;
  }).filter(Boolean).join(',');
}

/**
 * Show a conversation and press the move key for it.
 * @param {any} bar - The mounted bar.
 * @param {string} id - The conversation on screen.
 * @param {'up'|'down'} direction - Which way to move it.
 * @returns {void}
 */
function move(bar, id, direction) {
  bar._session.visibleConversationId = id;
  window.dispatchEvent(new CustomEvent('juggler:move-tab', { detail: { direction } }));
}

/**
 * Run a body with `prefers-reduced-motion` answering as given, whatever the
 * machine is set to — CI desktops commonly ask for reduced motion.
 * @param {boolean} reduce - Whether reduced motion is asked for.
 * @param {() => Promise<void>} fn - The body.
 * @returns {Promise<void>} Resolves when the body has run and matchMedia is back.
 */
async function withReducedMotion(reduce, fn) {
  const realMatchMedia = window.matchMedia;
  /** @type {any} */ (window).matchMedia = (/** @type {string} */ q) => (q === '(prefers-reduced-motion: reduce)'
    ? { matches: reduce, media: q, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, q));
  try {
    await fn();
  } finally {
    window.matchMedia = realMatchMedia;
  }
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the keyboard tab-move suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {[string, string][]} bindings - The strip to mount.
   * @param {(m: ReturnType<typeof mountBar>) => (void|Promise<void>)} fn - Test body.
   * @returns {Promise<void>} Resolves when the body has run and the bar is gone.
   */
  const run = async (label, bindings, fn) => {
    const mounted = mountBar(bindings);
    try {
      await fn(mounted);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      mounted.teardown();
    }
  };

  await run('a flat tab steps one place each way', [['a', ''], ['b', ''], ['c', '']], ({ bar, calls }) => {
    move(bar, 'b', 'up');
    assert(calls.at(-1) === 'b,a,c', `up should write b,a,c, wrote ${JSON.stringify(calls)}`);
    assert(drawn(bar) === 'b,a,c', `and draw it, drew ${drawn(bar)}`);
    move(bar, 'b', 'down');
    move(bar, 'b', 'down');
    assert(calls.at(-1) === 'a,c,b', `two downs should write a,c,b, wrote ${JSON.stringify(calls)}`);
  });

  await run('a press at the end of the list moves nothing and writes nothing', [['a', ''], ['b', '']], ({ bar, calls }) => {
    move(bar, 'a', 'up');
    move(bar, 'b', 'down');
    assert(calls.length === 0, `no wrap: ${JSON.stringify(calls)}`);
    assert(drawn(bar) === 'a,b', `the strip is unchanged, drew ${drawn(bar)}`);
  });

  await run('inside a box the tab moves among its own tabs and stops at the box edge',
    [['a', ''], ['x', 'ws'], ['y', 'ws'], ['b', '']], ({ bar, calls }) => {
      const before = drawn(bar);
      assert(before === 'a,[x,y],b', `fixture should draw a box between a and b, drew ${before}`);
      move(bar, 'y', 'up');
      assert(drawn(bar) === 'a,[y,x],b', `y should move above x in its box, drew ${drawn(bar)}`);
      const writes = calls.length;
      move(bar, 'y', 'up');
      assert(calls.length === writes && drawn(bar) === 'a,[y,x],b',
        `the top of the box is an edge, not a way out: drew ${drawn(bar)}`);
      move(bar, 'x', 'down');
      assert(calls.length === writes && drawn(bar) === 'a,[y,x],b',
        `so is the bottom: drew ${drawn(bar)}`);
    });

  await run('at the top level a whole box is one step', [['a', ''], ['x', 'ws'], ['b', '']], ({ bar }) => {
    move(bar, 'a', 'down');
    assert(drawn(bar) === '[x],a,b', `a should step over the box, not into it: drew ${drawn(bar)}`);
    move(bar, 'a', 'up');
    assert(drawn(bar) === 'a,[x],b', `and back over it: drew ${drawn(bar)}`);
  });

  // The swap is animated: without it two similar rows trade places between
  // frames and nothing on screen says which one moved.
  await withReducedMotion(false, () => run('the moved tab glides from where it was, lifted over the one it passes',
    [['a', ''], ['b', ''], ['c', '']], async ({ bar }) => {
      /**
       * @param {string} id - Whose tab.
       * @returns {HTMLElement} The tab.
       */
      const tab = (id) => /** @type {HTMLElement} */ (bar.querySelector(`.conversation-tab[data-conversation-id="${id}"]`));
      const aTopBefore = tab('a').getBoundingClientRect().top;
      const bTopBefore = tab('b').getBoundingClientRect().top;
      move(bar, 'b', 'up');
      /**
       * @param {HTMLElement} el - The tab.
       * @returns {Animation[]} Its keyboard-move glides.
       */
      const glides = (el) => el.getAnimations().filter((anim) => anim.id === 'tab-keyboard-glide');
      const moved = glides(tab('b'));
      const passed = glides(tab('a'));
      assert(moved.length === 1 && passed.length === 1,
        `both rows should glide, got ${moved.length} on the moved tab and ${passed.length} on its neighbour`);
      moved[0].pause();
      moved[0].currentTime = 0;
      assert(Math.abs(tab('b').getBoundingClientRect().top - bTopBefore) < 1,
        'the moved tab should start its glide where it was drawn before the press');
      passed[0].pause();
      passed[0].currentTime = 0;
      assert(Math.abs(tab('a').getBoundingClientRect().top - aTopBefore) < 1,
        'and so should the one it passed');
      assert(tab('b').classList.contains('keyboard-moving'), 'the moved tab is lifted while it glides');
      assert(!tab('a').classList.contains('keyboard-moving'), 'the one making way is not');
      moved[0].finish();
      await moved[0].finished;
      assert(!tab('b').classList.contains('keyboard-moving'), 'and set down when it lands');
    }));

  await withReducedMotion(true, () => run('under reduced motion the tab still moves, without a glide or a lift',
    [['a', ''], ['b', ''], ['c', '']], ({ bar, calls }) => {
      move(bar, 'b', 'up');
      assert(calls.at(-1) === 'b,a,c' && drawn(bar) === 'b,a,c',
        `the move itself is not motion: wrote ${JSON.stringify(calls)}, drew ${drawn(bar)}`);
      const tabs = /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll('.conversation-tab')));
      const gliding = tabs.filter((el) => el.getAnimations().some((anim) => anim.id === 'tab-keyboard-glide'));
      assert(gliding.length === 0, `nothing should glide, ${gliding.length} did`);
      assert(!tabs.some((el) => el.classList.contains('keyboard-moving')), 'nor be lifted');
    }));

  await run('nothing moves while a workspace panel is on screen', [['a', ''], ['b', '']], ({ bar, calls }) => {
    bar._session.visibleConversationId = null;
    window.dispatchEvent(new CustomEvent('juggler:move-tab', { detail: { direction: 'down' } }));
    assert(calls.length === 0, `no visible conversation, no move: ${JSON.stringify(calls)}`);
  });

  return { passed, failed, errors };
}
