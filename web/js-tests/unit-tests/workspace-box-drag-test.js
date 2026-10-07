//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a whole workspace box to a new place in the strip.
 *
 * A box keeps a place of its own — the conversation it sits behind, stored on
 * its workspace row — so moving one writes that field and moves no
 * conversation. The assertions here are about what the drop is allowed to
 * write: the place it landed at, and nothing else at all.
 *
 * A box travels among the tabs and boxes of the strip and never into another
 * box. A workspace does not live in a workspace, so the containment question a
 * tab drag has to answer does not arise.
 * @module unit-tests/workspace-box-drag-test
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
 * Mount a bar drawing the given workspaces and bindings, over a session stub
 * that records the block moves it is asked for and applies them, so the order
 * it is left holding can be asserted on.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, calls: any[][], order: () => string, teardown: () => void}} The mounted bar and what to read afterwards.
 */
function mountBar(workspaces, bindings) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);

  /** @type {any[][]} */
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
     * Apply the arrangement the drop is reporting, the way the real session
     * does: each box takes the place the strip gives it, and the conversation
     * order is rebuilt. Only the changes are recorded, so a gesture that moved
     * nothing is visible as having written nothing.
     * @param {{order: string[], places: Map<string, string>, moved?: string}} arrangement - The strip as the drop found it.
     * @returns {boolean} Whether anything moved.
     */
    applyStripArrangement({ order, places }) {
      for (const [workspaceId, place] of places) {
        const row = workspaces.find((ws) => ws.id === workspaceId);
        if (!row || row.place === place) continue;
        calls.push(['box', workspaceId, place]);
        row.place = place;
      }
      const before = [...session.conversations.keys()].join(',');
      if (order.join(',') !== before) {
        calls.push(['order', order.join(',')]);
        const rebuilt = new Map();
        for (const id of order) rebuilt.set(id, session.conversations.get(id));
        session.conversations = rebuilt;
      }
      return calls.length > 0;
    }
  };
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }

  bar._session = session;
  bar.render();
  return {
    bar,
    session,
    calls,
    order: () => [...session.conversations.keys()].join(','),
    teardown: () => host.remove()
  };
}

/**
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {HTMLElement} The box element.
 */
function boxFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`));
}

/**
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose tab.
 * @returns {HTMLElement} The tab element.
 */
function tabFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-tab[data-conversation-id="${id}"]`));
}

/**
 * Press a box by the middle of its header, and say how far the middle of the
 * box sits below that pointer. A drop is read from the middle of what is being
 * carried, so that distance is what turns a height the box should reach into
 * where the pointer has to go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} box - The box to press.
 * @returns {{x: number, below: number}} The pointer's x, and how far below it the box's middle rides.
 */
function pressBox(bar, box) {
  const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
  /** @type {any} */ (header).setPointerCapture = () => {};
  /** @type {any} */ (header).releasePointerCapture = () => {};
  /** @type {any} */ (box).setPointerCapture = () => {};
  /** @type {any} */ (box).releasePointerCapture = () => {};
  const from = header.getBoundingClientRect();
  const whole = box.getBoundingClientRect();
  const x = from.left + 10;
  const pressY = from.top + from.height / 2;
  bar._startBoxDrag({ clientX: x, clientY: pressY, pointerId: 1 }, box);
  return { x, below: whole.top + whole.height / 2 - pressY };
}

/**
 * Press a box's header, drag it until its middle is at a height, and let go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} box - The box to drag.
 * @param {number} middleY - Where the box's middle is let go.
 * @returns {void}
 */
function dragBoxToY(bar, box, middleY) {
  const { x, below } = pressBox(bar, box);
  const clientY = middleY - below;
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
}

/**
 * Press a box's header and drag it until its middle is at a height, without
 * letting go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} box - The box to drag.
 * @param {number} middleY - Where to bring the box's middle.
 * @returns {() => void} Let go.
 */
function holdBoxAtY(bar, box, middleY) {
  const { x, below } = pressBox(bar, box);
  const clientY = middleY - below;
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  return () => document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
}

/**
 * Press something the way a finger or a mouse would, and report whether the box
 * took it for a grab.
 *
 * Through the real `pointerdown` listener, deliberately: the drags above call
 * `_startBoxDrag` directly, so they say nothing about what is allowed to start
 * one. That gate is the whole of what a touch runs into.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} target - What the pointer goes down on.
 * @param {string} pointerType - 'touch', 'pen' or 'mouse'.
 * @returns {boolean} Whether a box drag was started.
 */
function pressStartsDrag(bar, target, pointerType) {
  const started = [];
  const real = bar._startBoxDrag;
  bar._startBoxDrag = (/** @type {any} */ e, /** @type {any} */ box) => started.push(box);
  try {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, button: 0, buttons: 1, pointerType, bubbles: true, composed: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    }));
  } finally {
    bar._startBoxDrag = real;
  }
  return started.length > 0;
}

/**
 * Run the workspace box drag tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('a box being dragged comes off the strip, the way a tab does', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const release = holdBoxAtY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().bottom + 40);

      // The clone is not a box — prepareGhost takes the id off it — so it is
      // found by the class the drag put there.
      const ghost = /** @type {HTMLElement|null} */ (
        bar.querySelector('.conversation-box.drag-ghost'));
      assert(!!ghost, 'the box being dragged is drawn as a clone that follows the pointer');
      assert(getComputedStyle(/** @type {HTMLElement} */ (ghost)).position === 'fixed',
        'floating free of the list it came from, so it can travel the whole height of the sidebar '
        + `rather than being clipped at the short list's edge, got ${getComputedStyle(/** @type {HTMLElement} */ (ghost)).position}`);
      assert(getComputedStyle(box).visibility === 'hidden',
        'and the box it was lifted out of stands in as the placeholder the rest shift around, '
        + `got ${getComputedStyle(box).visibility}`);

      release();
      assert(getComputedStyle(box).visibility !== 'hidden', 'which it stops being once let go');
      assert(!bar.querySelector('.drag-ghost'), 'and the clone goes with the gesture');
    } finally {
      teardown();
    }
  });

  check('a box dragged above every tab comes to sit at the head of the bar', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a'], ['c3', 'ws_a']]
    );
    try {
      assert(order() === 'c1,c2,c3', `the strip starts with the flat tab on top, got ${order()}`);
      const first = tabFor(bar, 'c1').getBoundingClientRect();
      dragBoxToY(bar, boxFor(bar, 'ws_a'), first.top + 1);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_a', 'head'], ['order', 'c2,c3,c1']]),
        `dropped in front of everything, the box has nothing left to sit behind: ${JSON.stringify(calls)}`);
      assert(order() === 'c2,c3,c1',
        'and its own conversations came with it: the order is the strip read top to bottom, and they are '
        + `drawn inside the box that moved, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box dragged past the end of the strip sits behind the last tab', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c3', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().bottom + 60);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_a', 'c1'], ['order', 'c1,c2,c3']]),
        `the end of the bar is behind the last conversation that is not its own: ${JSON.stringify(calls)}`);
      assert(order() === 'c1,c2,c3',
        `and its members followed it past the flat tab, got ${order()}`);
    } finally {
      teardown();
    }
  });

  check('a box let go where it already is writes nothing', () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a')],
      [['c2', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const rect = box.getBoundingClientRect();
      dragBoxToY(bar, box, rect.top + 2);

      assert(calls.length === 0,
        `a gesture that ends where it began has moved nothing, and must not say it has: ${JSON.stringify(calls)}`);
    } finally {
      teardown();
    }
  });

  check('an empty box commits its place like any other', () => {
    const { bar, calls, order, teardown } = mountBar(
      [workspace('ws_empty')],
      [['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_empty');
      dragBoxToY(bar, box, tabFor(bar, 'c1').getBoundingClientRect().top + 1);

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_empty', 'head']]),
        `a box's place is its own, so one with nothing in it is moved and kept like any other: ${JSON.stringify(calls)}`);
      assert(order() === 'c1',
        `and the conversation it was dragged past stays where it is, got ${order()}`);
    } finally {
      teardown();
    }
  });

  // The tabs a box has shifted past do not arrive instantly: each is inverted
  // to where it was and released to animate to where it now is. A pointer
  // reports faster than that animation finishes, so the next move is read while
  // the tab it is being measured against is still drawn over the box's own
  // placeholder — and the box is sent to the far end of the strip by a
  // correction that never left it.
  check('a box is not moved again by a pointer resting inside it', () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', ''], ['c2', 'ws_a']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const above = tabFor(bar, 'c1').getBoundingClientRect().top + 1;

      const { x, below } = pressBox(bar, box);
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY: above - below, bubbles: true
      }));
      // Where the box now is — it is the one thing a shift does not animate — so
      // this is the box's middle inside its own placeholder, asking for the
      // place the box already has.
      const resting = box.getBoundingClientRect();
      const inside = resting.bottom - 2 - below;
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 1, buttons: 1, pointerType: 'touch',
        clientX: x, clientY: inside, bubbles: true
      }));
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: inside, bubbles: true
      }));

      assert(JSON.stringify(calls) === JSON.stringify([['box', 'ws_a', 'head'], ['order', 'c2,c1']]),
        `the box was dropped where it was already shown, at the head of the bar: ${JSON.stringify(calls)}`);
    } finally {
      teardown();
    }
  });

  check('the row that makes a workspace stays the last thing in the strip, whatever is dropped at the end', () => {
    // A drop past the last box is a drop at the end of the strip, and the end
    // of the strip is in front of that row — never after it. Dropping the last
    // box back where it was changes nothing in the session, so no render comes
    // along to tidy up after it: the drop itself has to land in the right place.
    const { bar, teardown } = mountBar(
      [workspace('ws_a'), workspace('ws_b')],
      [['c1', 'ws_a'], ['c2', 'ws_b']]
    );
    try {
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const isLast = () => /** @type {Element} */ (menu.lastElementChild).classList.contains('conversation-box-new');
      assert(isLast(), 'precondition: the row starts last');

      const last = boxFor(bar, 'ws_b');
      dragBoxToY(bar, last, last.getBoundingClientRect().bottom + 40);
      assert(isLast(), `dropping the last box back at the end leaves the row last, got ${menu.lastElementChild?.className}`);

      const first = boxFor(bar, 'ws_a');
      dragBoxToY(bar, first, boxFor(bar, 'ws_b').getBoundingClientRect().bottom + 40);
      assert(isLast(), `moving a box to the end puts it in front of the row, got ${menu.lastElementChild?.className}`);
    } finally {
      teardown();
    }
  });

  check('nothing in the sidebar carries a grip', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a'], ['c2', '']]
    );
    try {
      assert(!bar.querySelector('.drag-grip'),
        'a finger lifts a row by holding it and a mouse drags it from anywhere, so no row needs a handle');
    } finally {
      teardown();
    }
  });

  check('a finger begins a hold anywhere on a box header, and a mouse drags from there as before', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a']]
    );
    try {
      const header = /** @type {HTMLElement} */ (boxFor(bar, 'ws_a').querySelector('.conversation-box-header'));
      assert(pressStartsDrag(bar, header, 'touch'),
        'a finger on the header begins the gesture: the hold, not a handle, tells a drag from a scroll');
      assert(pressStartsDrag(bar, header, 'mouse'), 'a mouse still drags a box from anywhere on its header');
    } finally {
      teardown();
    }
  });

  /**
   * Hold a row with a finger and let go where it was, through the real
   * listener and the real gesture, with the hold taken down to nothing.
   * @param {any} bar - The mounted bar.
   * @param {HTMLElement} target - What the finger is on.
   * @param {HTMLElement} row - The row that takes the pointer.
   * @returns {Element[]} What the bar was asked to open a menu for.
   */
  const holdAndLetGo = (bar, target, row) => {
    for (const el of [target, row]) {
      /** @type {any} */ (el).setPointerCapture = () => {};
      /** @type {any} */ (el).releasePointerCapture = () => {};
    }
    /** @type {Element[]} */
    const menus = [];
    bar._touchHoldMs = 0;
    bar._openMenuFromHold = (/** @type {Element} */ subject) => menus.push(subject);
    const rect = target.getBoundingClientRect();
    const at = { pointerId: 4, pointerType: 'touch', button: 0, bubbles: true, composed: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
    return menus;
  };

  check('a box held and let go where it was opens its menu, and is not clicked', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
      const menus = holdAndLetGo(bar, header, box);
      assert(menus.length === 1 && box.contains(menus[0]),
        `a long-press is how a finger asks for the box's menu, got ${menus.length} menu(s)`);
      assert(bar._dragJustOccurred === true, 'and the click that follows the release is not a selection');
    } finally {
      teardown();
    }
  });

  check('a tab held and let go where it was opens its menu, and is not clicked', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws_a')],
      [['c1', 'ws_a']]
    );
    try {
      const tab = tabFor(bar, 'c1');
      const name = /** @type {HTMLElement} */ (tab.querySelector('.conversation-tab-name'));
      const menus = holdAndLetGo(bar, name, tab);
      assert(menus.length === 1 && tab.contains(menus[0]),
        `a long-press is how a finger asks for a tab's menu, got ${menus.length} menu(s)`);
      assert(bar._dragJustOccurred === true, 'and the click that follows the release does not switch to it');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
