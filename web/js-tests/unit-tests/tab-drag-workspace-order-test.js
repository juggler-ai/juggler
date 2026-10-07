//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a tab past a workspace box, and what the strip is left showing.
 *
 * The bar draws two things that each keep their own place: a conversation sits
 * where the flat order puts it, a box sits behind the conversation its row
 * names. The strip the user reads is the two merged, so a drop has to be right
 * in both at once — and the assertions here are on the merged result, the
 * sequence of tabs and boxes actually drawn, because that is the only thing the
 * user can see. A commit that names a defensible neighbour and still draws the
 * tab on the wrong side of a box has not done what was asked of it.
 *
 * Which is why the assertion this file is built around is a single sentence —
 * what a drag shows is what the drop writes. The strip under the pointer is
 * already the arrangement the user picked; every fault found here has been the
 * drop working that arrangement out a second time and getting a different
 * answer. Immediately above a box and immediately below it are different places
 * to land with the same conversation to land in front of; a box nobody touched
 * holds a place derived from a list the drop has just rewritten. Both are
 * invisible until the strip redraws from what was recorded.
 *
 * A real `Session` rather than a recording stub, so the reorder, the
 * re-anchoring and the grouping under test are the shipped ones, and what is
 * asserted is what they would draw.
 * @module unit-tests/tab-drag-workspace-order-test
 */

import { assert, trackTestSession, waitFor } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @param {string} [place] - 'head', or the conversation its box sits behind.
 * @returns {any} The row.
 */
function workspace(id, place) {
  const row = { id, root: `/tmp/${id}`, label: id, state: 'ready', available: true, providerId: '(none)' };
  return place ? { ...row, place } : row;
}

/**
 * Mount a bar over a real session holding the given table and bindings.
 *
 * The session is built and populated directly rather than loaded: `setSession`
 * would spin up a panel and a worker per conversation, and the strip needs
 * neither. Its api service answers the one call a reorder makes, so persisting
 * is a no-op instead of a fetch.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, teardown: () => void}} The mounted bar, its session, and a teardown.
 */
function mountBar(workspaces, bindings) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  host.appendChild(document.createElement('conversation-tabs-container'));
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  host.appendChild(bar);

  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
    /**
     * @returns {Promise<void>} Persisting is what the server does with an order, not what is under test here.
     */
    reorderConversations: async () => {}
  }))));
  session.workspaces = workspaces;
  session.projectPath = '/tmp/project';
  // A move brings what the conversation read out of its old tree up to date
  // with the new one, which reads files over the wire and is
  // conversation-workspace-move-test's subject. What is under test here is
  // where the tab is left, so the catch-up is answered rather than performed.
  session.seedConversationAutoItems = async () => {};
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }

  bar._session = session;
  bar.render();
  for (const tab of Array.from(bar.querySelectorAll('.conversation-tab'))) {
    /** @type {any} */ (tab).setPointerCapture = () => {};
    /** @type {any} */ (tab).releasePointerCapture = () => {};
  }
  return { bar, session, teardown: () => host.remove() };
}

/**
 * The strip as drawn, tabs and boxes in the order they appear.
 *
 * A box is written with what it holds, so a tab landing inside one instead of
 * beside it is legible in the failure rather than silently absent.
 * @param {any} bar - The mounted bar.
 * @returns {string} e.g. `a b [ws] c d`, or `a [ws:m] b` for a box with a member.
 */
function drawn(bar) {
  const menu = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-tabs'));
  if (!menu) return '(no strip)';
  return /** @type {HTMLElement[]} */ (Array.from(menu.children))
    .filter(child => child.classList.contains('conversation-tab')
      || child.classList.contains('conversation-box'))
    .map((child) => {
      if (child.classList.contains('conversation-tab')) return child.dataset.conversationId ?? '?';
      const held = /** @type {HTMLElement[]} */ (
        Array.from(child.querySelectorAll('.conversation-tab')))
        .map(tab => tab.dataset.conversationId ?? '?');
      return held.length ? `[${child.dataset.workspaceId}:${held.join(',')}]` : `[${child.dataset.workspaceId}]`;
    })
    .join(' ');
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
 * @param {any} bar - The mounted bar.
 * @param {string} id - Whose box.
 * @returns {HTMLElement} The box element.
 */
function boxFor(bar, id) {
  return /** @type {HTMLElement} */ (bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`));
}

/**
 * Drag one tab to a height in the strip and let go, then redraw.
 *
 * The bar holds its renders for the length of the gesture and is attached here
 * without its session listeners, so the redraw is asked for rather than waited
 * on: what it draws is a function of the session the drop just wrote, which is
 * the thing being asserted.
 * @param {any} bar - The mounted bar.
 * @param {string} id - The conversation to drag.
 * @param {number} clientY - Where to let go.
 * @returns {void}
 */
function dragToY(bar, id, clientY) {
  const tab = tabFor(bar, id);
  const from = tab.getBoundingClientRect();
  const x = from.left + 10;
  bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  bar.render();
}

/**
 * Move the pointer of a live drag, without ending it.
 * @param {number} clientX - Where the pointer is.
 * @param {number} clientY - Where the pointer is.
 * @returns {void}
 */
function movePointer(clientX, clientY) {
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX, clientY, bubbles: true
  }));
}

/** @returns {void} Let go of a live drag wherever it is. */
function releasePointer() {
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0, bubbles: true
  }));
}

/**
 * The top-level slots of the strip: its own tabs and the boxes, in order.
 * @param {any} bar - The mounted bar.
 * @returns {HTMLElement[]} The slots.
 */
function topSlots(bar) {
  const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
  return /** @type {HTMLElement[]} */ (Array.from(menu.children))
    .filter(child => child.classList.contains('conversation-tab')
      || child.classList.contains('conversation-box'));
}

/**
 * Drag one tab through a series of heights, letting go at the last.
 *
 * The moves arrive in a single frame, which is what a pointer reporting faster
 * than the screen redraws gives you — and what every drag looks like for the
 * length of the animation each shift starts.
 * @param {any} bar - The mounted bar.
 * @param {string} id - The conversation to drag.
 * @param {number[]} ys - The heights to visit, in order.
 * @returns {void}
 */
function dragThrough(bar, id, ys) {
  const tab = tabFor(bar, id);
  const from = tab.getBoundingClientRect();
  const x = from.left + 10;
  bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
  for (const y of ys) movePointer(x, y);
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY: ys[ys.length - 1], bubbles: true
  }));
  bar.render();
}

/**
 * Stand a fake server behind the session for the length of a test.
 *
 * It does the two things the real one does that matter here: it keeps the
 * workspace table in an array, applying a row's place and the table's order as
 * they are written — and it republishes the whole table after every edit, which
 * is what the client replaces its own copy with (`session.js`'s
 * `workspaces-changed` handler). A drop that records an arrangement only in the
 * client's copy is undone by that broadcast a moment later, and without a
 * server here to answer, a test cannot tell the two apart.
 * @param {any} session - The session under test.
 * @returns {{broadcast: () => void, wrote: string[], restore: () => void}} The
 *   broadcast every edit triggers, what the client sent, and the teardown.
 */
function withFakeServer(session) {
  const realFetch = window.fetch;
  /** @type {any[]} */
  let table = (session.workspaces ?? []).map((/** @type {any} */ row) => ({ ...row }));
  /** @type {string[]} */
  const wrote = [];

  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.includes('/workspaces/reorder')) {
      const wanted = /** @type {string[]} */ (Array.isArray(body.ids) ? body.ids : []);
      const named = wanted
        .map(id => table.find(row => row.id === id))
        .filter(Boolean);
      table = [...named, ...table.filter(row => !wanted.includes(row.id))];
      wrote.push(`reorder ${wanted.join(',')}`);
    } else if (path.includes('/workspaces/')) {
      const id = decodeURIComponent(path.split('/workspaces/')[1].split(/[/?]/)[0]);
      table = table.map(row => (row.id === id ? { ...row, ...body } : row));
      wrote.push(`place ${id}=${body.place}`);
    }
    return { ok: true, status: 200, json: async () => ({ workspaces: table }) };
  });

  return {
    broadcast: () => {
      session.workspaces = table.map(row => ({ ...row }));
      session._notify('session:workspaces-changed', session.workspaces);
    },
    wrote,
    restore: () => { window.fetch = realFetch; }
  };
}

/**
 * Answer the move dialog a drop across boxes raises, and wait for the move it
 * makes to land.
 *
 * A drop that changes where a conversation works asks before it moves
 * anything, so the gesture is only half over at the pointerup: the strip is
 * back where it started and what the drag drew is waiting on this answer.
 * @param {boolean} [yes] - Whether to move it, or to think better of it.
 * @returns {Promise<void>} When the dialog has gone and its work is done.
 */
async function answerMove(yes = true) {
  // Nothing is waited for on the way in: the drop opens the dialog in the same
  // breath it decides to ask, so a dialog that is not here now is not coming.
  // The newest one, and followed by identity — a dialog is asked over the top of
  // whatever is already on screen, so "no dialog anywhere" is not this question
  // being answered.
  const dialogs = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('.workspace-move-dialog')));
  const dialog = dialogs[dialogs.length - 1];
  assert(!!dialog, 'a drop that changes where a conversation works asks before it moves anything');
  /** @type {HTMLElement|null} */ (dialog.querySelector(
    yes ? '.workspace-move-commit' : '.workspace-move-cancel'))?.click();

  // One turn of the queue is the whole wait: the move is awaited, and closing
  // takes the dialog off the screen and resolves the question in the same
  // statement (`presentModal`, which animates nothing). The bounded wait after
  // it is a net, not the mechanism — a machine under load must not be able to
  // spend the suite's whole budget here.
  await new Promise(resolve => setTimeout(resolve, 0));
  await waitFor(() => !dialog.isConnected,
    { timeoutMs: 1000, description: 'the move dialog to close on the answer' });
}

/**
 * Shut everything a drop left on screen, so a check that threw mid-question —
 * or a drag whose release landed in a box on its way past — does not hand the
 * next check a dialog it never opened.
 * @returns {void}
 */
function closeDialogs() {
  for (const cancel of Array.from(document.querySelectorAll('.workspace-move-cancel'))) {
    /** @type {HTMLElement} */ (cancel).click();
  }
  /** @type {any} */ (document.querySelector('modal-dialog.is-notice'))?.close(null);
}

/**
 * Which workspace's box a tab is drawn in, or '' for the flat strip.
 * @param {HTMLElement|null} tab - The tab element.
 * @returns {string} The workspace id, or ''.
 */
function boxOf(tab) {
  return /** @type {HTMLElement|null} */ (tab?.closest('.conversation-box'))?.dataset.workspaceId ?? '';
}

/**
 * The gutter just above a box: outside it, so the drop is a move past the box
 * rather than a move into it.
 * @param {HTMLElement} box - The box.
 * @returns {number} A clientY in the gap above it.
 */
function justAbove(box) {
  return box.getBoundingClientRect().top - 2;
}

/**
 * The gutter just below a box, on the same terms.
 * @param {HTMLElement} box - The box.
 * @returns {number} A clientY in the gap below it.
 */
function justBelow(box) {
  return box.getBoundingClientRect().bottom + 2;
}

/**
 * Run the tab-past-a-box ordering tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void|Promise<void>} body - The check.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // A check that threw mid-gesture must not leave the drag's document
      // listeners running into the next one.
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0, bubbles: true
      }));
      closeDialogs();
    }
  };

  /**
   * The bar the reported fault was found in: an empty box with tabs either
   * side of it, sitting behind `b`.
   * @returns {{bar: any, session: any, teardown: () => void}} The mounted bar.
   */
  const barWithBoxInTheMiddle = () => mountBar(
    [workspace('ws', 'b')],
    [['a', ''], ['b', ''], ['c', ''], ['d', '']]
  );

  await check('a tab dragged up to the slot above a box is drawn above it', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      assert(drawn(bar) === 'a b [ws] c d', `the strip starts with the box in the middle, got "${drawn(bar)}"`);
      dragToY(bar, 'd', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a b d [ws] c',
        'a tab let go in the gap above a box belongs above it — the slot above and the slot below '
        + `are the same conversation to land in front of and different places to be, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab dragged down to the slot below a box is drawn below it', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'a', justBelow(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'b [ws] a c d',
        `the other half of the same gesture, and the one that already worked, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('the tabs a drag shoves aside slide, inside a box as much as outside one', async () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'head')],
      [['m1', 'ws'], ['m2', 'ws'], ['a', ''], ['b', ''], ['c', '']]
    );
    // shiftTo pins each displaced item at its old position with an inline
    // `transition: none`, then clears both a frame later so it travels to its
    // new slot. That frame is the one being measured, and the test window is
    // hidden, so rAF is put onto macrotasks the test can actually pump.
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
      /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
    try {
      assert(drawn(bar) === '[ws:m1,m2] a b c', `the strip starts with a box holding two, got "${drawn(bar)}"`);

      /** @type {string[]} */
      const snapped = [];
      for (const [where, dragged, onto] of [['in the strip', 'a', 'c'], ['inside a box', 'm1', 'm2']]) {
        const tab = tabFor(bar, dragged);
        /** @type {any} */ (tab).setPointerCapture = () => {};
        /** @type {any} */ (tab).releasePointerCapture = () => {};
        const from = tab.getBoundingClientRect();
        const x = from.left + 10;
        const home = from.top + from.height / 2;
        bar._startDrag({ clientX: x, clientY: home, pointerId: 1 }, tab);
        movePointer(x, tabFor(bar, onto).getBoundingClientRect().bottom - 2);
        // One turn for the inversion's frame, one for the transition to be what
        // the element is left carrying.
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));

        for (const other of /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll('.conversation-tab')))) {
          if (other.classList.contains('drag-source') || other.classList.contains('drag-ghost')) continue;
          const style = getComputedStyle(other);
          const animates = parseFloat(style.transitionDuration) > 0
            && /transform|all/.test(style.transitionProperty);
          if (!animates) {
            snapped.push(`  dragging ${dragged} ${where}: ${other.dataset.conversationId} sits under `
              + `"${style.transitionProperty} ${style.transitionDuration}"`);
          }
        }

        // Home again before letting go, so the measurement costs the strip
        // nothing and the next drag starts from the arrangement this one did.
        movePointer(x, home);
        releasePointer();
      }

      assert(snapped.length === 0,
        'a tab shoved aside by a drag travels to its new slot rather than jumping, and what gates that '
        + `is a class the stylesheet looks for on the strip:\n${snapped.join('\n')}`);
    } finally {
      window.requestAnimationFrame = realRaf;
      teardown();
    }
  });

  await check('a tab dragged above the tab above a box still lands there', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      const b = tabFor(bar, 'b').getBoundingClientRect();
      dragToY(bar, 'd', b.top + 1);

      assert(drawn(bar) === 'a d b [ws] c',
        `landing in front of a plain tab is untouched by any of this, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('dragging the tab a box sits behind moves the tab and not the box', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', justBelow(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a [ws] b c d',
        'the box is anchored to b, which is an ordinary tab with nothing to mark it as one — '
        + `dragging it past the box must move it alone, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a box keeps its place when its tab is dragged to the head of the bar', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', tabFor(bar, 'a').getBoundingClientRect().top + 1);

      assert(drawn(bar) === 'b a [ws] c d',
        'b leaves the top of the bar and the box stays where it was drawn, above c — a box '
        + `re-anchors to what its tab left behind rather than travelling with it, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a box keeps its place when its tab is dragged past the end of the bar', () => {
    const { bar, teardown } = barWithBoxInTheMiddle();
    try {
      dragToY(bar, 'b', tabFor(bar, 'd').getBoundingClientRect().bottom + 80);

      assert(drawn(bar) === 'a [ws] c d b',
        `the same on the way down: the tab goes to the end and the box does not follow, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab can be dropped above a box that sits at the head of the bar', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'head')],
      [['a', ''], ['b', ''], ['c', '']]
    );
    try {
      assert(drawn(bar) === '[ws] a b c', `the box starts at the top, got "${drawn(bar)}"`);
      dragToY(bar, 'c', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'c [ws] a b',
        'nothing can be drawn above a box anchored to the head unless the box gives the place up, '
        + `so the drop has to move it, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab dropped above a box with a conversation in it clears the box', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'b')],
      [['a', ''], ['b', ''], ['m', 'ws'], ['c', '']]
    );
    try {
      assert(drawn(bar) === 'a b [ws:m] c', `the box holds its member, got "${drawn(bar)}"`);
      dragToY(bar, 'c', justAbove(boxFor(bar, 'ws')));

      assert(drawn(bar) === 'a b c [ws:m]',
        'the tab lands above the box and the box keeps what is inside it — a drop beside a box '
        + `is not a drop into one, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  // Beside a box and inside it are adjacent positions and different acts — one
  // reorders a tab, the other asks to move a conversation to another tree. What
  // separated them was the box's own edge, which put the whole of "beside" in
  // the 0.375rem gap between one box and the next. A band below the top edge
  // takes that to something a hand can hit, out of the header — and out of the
  // header only, which is what the last two probes here are for: the band must
  // not be paid for by any row inside the box.
  await check('the strip above a box is wide enough to aim at', () => {
    /**
     * Pick a tab up and hold it at a height measured off the box, without
     * letting go: what the strip draws under the pointer is the question here,
     * and dropping it would raise the move dialog for every probe that lands
     * inside. A mount each, so every measurement is taken before anything has
     * been shifted out from under it.
     * @param {(rect: DOMRect) => number} at - The height to hold it at.
     * @returns {string} The strip as drawn under the pointer.
     */
    const holdingOverTheBox = (at) => {
      const { bar, teardown } = mountBar(
        [workspace('ws', 'b')],
        [['a', ''], ['b', ''], ['m', 'ws'], ['c', '']]
      );
      try {
        const rect = boxFor(bar, 'ws').getBoundingClientRect();
        const tab = tabFor(bar, 'c');
        const from = tab.getBoundingClientRect();
        const x = from.left + 10;
        bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
        movePointer(x, at(rect));
        return drawn(bar);
      } finally {
        releasePointer();
        teardown();
      }
    };

    const onTheHeader = holdingOverTheBox(rect => rect.top + 4);
    assert(onTheHeader === 'a b c [ws:m]',
      'a few pixels inside the top edge is the box\'s frame and the top of its header — a title, '
      + `never a slot — so it reads as the strip above the box, got "${onTheHeader}"`);

    const atTheFoot = holdingOverTheBox(rect => rect.bottom - 4);
    assert(atTheFoot === 'a b [ws:m,c]',
      'while the padding below the last tab is the end of the box and stays the end of the box: '
      + `the band comes out of the header, and is not paid for at this edge, got "${atTheFoot}"`);

    const inside = holdingOverTheBox(rect => (rect.top + rect.bottom) / 2);
    assert(inside === 'a b [ws:c,m]',
      'and the middle of a box is still somewhere a tab can be dropped into — the band must widen '
      + `the strip above the box, not eat the box, got "${inside}"`);
  });

  await check('a tab dropped past the end lands last, behind a box drawn there', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'c')],
      [['a', ''], ['b', ''], ['c', '']]
    );
    try {
      assert(drawn(bar) === 'a b c [ws]', `the box starts at the end, got "${drawn(bar)}"`);
      dragToY(bar, 'a', boxFor(bar, 'ws').getBoundingClientRect().bottom + 80);

      assert(drawn(bar) === 'b c [ws] a',
        `past the end of the strip is the end of the strip, box or no box, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab can be dropped between two boxes drawn side by side', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws1', 'a'), workspace('ws2', 'a')],
      [['a', ''], ['b', '']]
    );
    try {
      assert(drawn(bar) === 'a [ws1] [ws2] b', `two boxes sharing an anchor stack up, got "${drawn(bar)}"`);
      dragToY(bar, 'b', justAbove(boxFor(bar, 'ws2')));

      assert(drawn(bar) === 'a [ws1] b [ws2]',
        `the gap between two boxes is a place to land, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab let go where it was picked up moves nothing', () => {
    const { bar, session, teardown } = barWithBoxInTheMiddle();
    try {
      const before = drawn(bar);
      const place = session.getWorkspace('ws').place;
      const tab = tabFor(bar, 'd').getBoundingClientRect();
      dragToY(bar, 'd', tab.top + tab.height / 2);

      assert(drawn(bar) === before,
        `a gesture that ends where it began has moved nothing, got "${drawn(bar)}" from "${before}"`);
      assert(session.getWorkspace('ws').place === place,
        `and must not have rewritten the box's place either, got ${JSON.stringify(session.getWorkspace('ws').place)}`);
    } finally {
      teardown();
    }
  });

  await check('a second move in the same frame is read from where the tabs are now', () => {
    const { bar, teardown } = mountBar(
      [workspace('ws', 'b')],
      [['a', ''], ['b', '']]
    );
    try {
      assert(drawn(bar) === 'a b [ws]', `two tabs and a box below them, got "${drawn(bar)}"`);
      const wasB = tabFor(bar, 'b').getBoundingClientRect();

      // Down into the gap between b and the box — which puts a where b was —
      // and then a small correction back up, still within the slot a is now
      // drawn in. The second move is read before the shift has finished
      // animating, and what it must be read against is the strip as it stands.
      dragThrough(bar, 'a', [justAbove(boxFor(bar, 'ws')), wasB.top + 2]);

      assert(drawn(bar) === 'b a [ws]',
        'the pointer never left the tab it was dragging, so nothing more had moved by the time it '
        + `was let go — a correction read against the strip of a moment ago jumps a whole slot, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('a tab already drawn under the pointer is not moved again', () => {
    /**
     * Arrangements of the bar, each with an empty box somewhere in it: the
     * workspace whose conversations have all gone is the one that is all
     * gutter, and the one a tab has to be dragged past rather than into.
     * @type {[string, () => {bar: any, session: any, teardown: () => void}][]}
     */
    const arrangements = [
      ['a b [ws]', () => mountBar([workspace('ws', 'b')], [['a', ''], ['b', '']])],
      ['a b [ws] c', () => mountBar([workspace('ws', 'b')], [['a', ''], ['b', ''], ['c', '']])],
      ['[ws] a b c', () => mountBar([workspace('ws', 'head')], [['a', ''], ['b', ''], ['c', '']])],
      ['a b [ws:m] c', () => mountBar([workspace('ws', 'b')], [['a', ''], ['b', ''], ['m', 'ws'], ['c', '']])]
    ];
    /** @type {string[]} */
    const jumped = [];

    for (const [label, mount] of arrangements) {
      const scout = mount();
      const slots = topSlots(scout.bar);
      const ids = slots.filter(slot => slot.classList.contains('conversation-tab'))
        .map(slot => /** @type {string} */ (slot.dataset.conversationId));
      const top = slots[0].getBoundingClientRect().top;
      const bottom = slots[slots.length - 1].getBoundingClientRect().bottom;
      scout.teardown();

      for (const id of ids) {
        // Above the strip, through the middle of it, and past the end: three
        // shifts, each leaving the tabs animating from somewhere else.
        for (const first of [top - 6, (top + bottom) / 2, bottom + 30]) {
          const { bar, teardown } = mount();
          try {
            const tab = tabFor(bar, id);
            const from = tab.getBoundingClientRect();
            const x = from.left + 10;
            bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
            movePointer(x, first);

            // The dragged tab is the one thing the shift does not animate, so
            // this is where it really is. A pointer inside it is a pointer in
            // the slot the tab already occupies, and there is nowhere for it to
            // go from there.
            const shown = drawn(bar);
            const resting = tab.getBoundingClientRect();
            movePointer(x, resting.top + resting.height / 2);

            if (drawn(bar) !== shown) {
              jumped.push(`  ${label}, dragging ${id}: showed "${shown}", then moved to "${drawn(bar)}"`);
            }
          } finally {
            releasePointer();
            teardown();
          }
        }
      }
    }

    assert(jumped.length === 0,
      'a pointer resting in the tab it is dragging asks for the place that tab is already in, so the '
      + `strip must not move under it:\n${jumped.join('\n')}`);
  });

  // Two workspaces next to each other with the tabs below them: the bar as it
  // is left when a workspace's conversations are all binned, which is also when
  // its row loses the place it was anchored by. Dropping a tab into the gap
  // between the boxes used to land it past both of them — and dropping the
  // other one there moved the first tab as well, because the box left with no
  // place of its own was being positioned by a fallback that reads the
  // conversation list, and the list had just changed under it.
  await check('a tab dropped between two boxes lands between them', () => {
    const { bar, teardown } = mountBar(
      [workspace('w1'), workspace('w2')],
      [['a', ''], ['b', '']]
    );
    try {
      assert(drawn(bar) === 'a b [w1] [w2]', `the bar starts with the tabs above the boxes, got "${drawn(bar)}"`);
      dragToY(bar, 'a', justAbove(boxFor(bar, 'w2')));

      assert(drawn(bar) === 'b [w1] a [w2]',
        `the gap between two boxes is a place to be, and a tab let go in it stays there, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  await check('and it moves no other tab on the way', () => {
    const { bar, teardown } = mountBar(
      [workspace('w1'), workspace('w2')],
      [['a', ''], ['b', '']]
    );
    try {
      dragToY(bar, 'b', justAbove(boxFor(bar, 'w2')));

      assert(drawn(bar) === 'a [w1] b [w2]',
        `one tab was dragged, so one tab moved — a stays where it was, got "${drawn(bar)}"`);
    } finally {
      teardown();
    }
  });

  // Two boxes with no conversation between them sit in the same place, and the
  // only thing left to tell them apart is the order of the workspace table. So
  // a drag that swaps two empty boxes has nothing on either row to write, and
  // the table's order is what it writes instead — on the server, because the
  // client's copy of the table is replaced whole by the next broadcast, and
  // every workspace edit anywhere sends one.
  await check('two boxes with nothing between them keep the order the strip shows', async () => {
    const { bar, session, teardown } = mountBar(
      [workspace('w1', 'head'), workspace('w2', 'head')],
      [['a', ''], ['b', '']]
    );
    const server = withFakeServer(session);
    try {
      assert(drawn(bar) === '[w1] [w2] a b', `the two boxes start in table order, got "${drawn(bar)}"`);
      const box = boxFor(bar, 'w2');
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
      /** @type {any} */ (header).setPointerCapture = () => {};
      /** @type {any} */ (header).releasePointerCapture = () => {};
      const from = header.getBoundingClientRect();
      const x = from.left + 10;
      const pressY = from.top + from.height / 2;
      // The drop is read from the middle of the box being carried, which rides
      // below a pointer holding its header: put that middle just inside w1.
      const whole = box.getBoundingClientRect();
      const middleBelowPointer = whole.top + whole.height / 2 - pressY;
      const above = boxFor(bar, 'w1').getBoundingClientRect().top + 1 - middleBelowPointer;
      bar._startBoxDrag({ clientX: x, clientY: pressY, pointerId: 1 }, box);
      movePointer(x, above);
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: above, bubbles: true
      }));
      bar.render();

      assert(drawn(bar) === '[w2] [w1] a b',
        `a box dragged above the box beside it stays above it, got "${drawn(bar)}"`);

      await new Promise(resolve => setTimeout(resolve, 0));
      assert(server.wrote.includes('reorder w2,w1'),
        'and the move is sent, or nothing outside this window knows it happened — two empty boxes '
        + `have no row to write it on: ${JSON.stringify(server.wrote)}`);

      server.broadcast();
      bar.render();
      assert(drawn(bar) === '[w2] [w1] a b',
        `and it stays put when the server says what the table now is, got "${drawn(bar)}"`);
    } finally {
      server.restore();
      teardown();
    }
  });

  // A drop that changes where a conversation works asks before it moves
  // anything, and the question is only ever about the binding: where the tab
  // goes was settled by the gesture, which has already been made and drawn. The
  // two answers were being taken from different places — the binding from the
  // dialog, the position from whatever the rebinding happened to leave behind —
  // and a tab dragged out of a box duly landed somewhere nobody had dropped it.
  await check('a tab dragged out of its box lands where it was dropped', async () => {
    const { bar, session, teardown } = mountBar(
      [workspace('ws', 'head')],
      [['m', 'ws'], ['a', ''], ['b', '']]
    );
    const server = withFakeServer(session);
    try {
      assert(drawn(bar) === '[ws:m] a b', `the box starts at the head, holding m, got "${drawn(bar)}"`);

      const tab = tabFor(bar, 'm');
      const from = tab.getBoundingClientRect();
      const x = from.left + 10;
      const between = tabFor(bar, 'b').getBoundingClientRect().top - 2;
      bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
      movePointer(x, between);

      const shown = drawn(bar);
      assert(shown === '[ws] a m b',
        `the drag draws the tab out of the box and between the two flat ones, got "${shown}"`);
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: between, bubbles: true
      }));

      await answerMove(true);
      bar.render();
      assert(drawn(bar) === shown,
        `the answer was about where it works, not where it sits — it sits where it was dropped, got "${drawn(bar)}"`);
      assert(session.conversations.get('m').workspaceId === '',
        'and it works in the project folder now, which is the thing that was asked');

      server.broadcast();
      bar.render();
      assert(drawn(bar) === shown,
        `and it is still there once the server has said what the table now is, got "${drawn(bar)}"`);
    } finally {
      server.restore();
      releasePointer();
      teardown();
    }
  });

  await check('a move thought better of moves nothing at all', async () => {
    const { bar, session, teardown } = mountBar(
      [workspace('ws', 'head')],
      [['m', 'ws'], ['a', ''], ['b', '']]
    );
    const server = withFakeServer(session);
    try {
      const tab = tabFor(bar, 'm');
      const from = tab.getBoundingClientRect();
      const x = from.left + 10;
      const between = tabFor(bar, 'b').getBoundingClientRect().top - 2;
      bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
      movePointer(x, between);
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: between, bubbles: true
      }));

      await answerMove(false);
      bar.render();
      assert(drawn(bar) === '[ws:m] a b',
        `a question answered no leaves the strip exactly as it was, got "${drawn(bar)}"`);
      assert(session.conversations.get('m').workspaceId === 'ws',
        'and the conversation working where it was working');
      assert(server.wrote.length === 0,
        `with nothing sent about any of it: ${JSON.stringify(server.wrote)}`);
    } finally {
      server.restore();
      releasePointer();
      teardown();
    }
  });

  // The one assertion this file exists for. The strip a drag draws under the
  // pointer is computed from the geometry and is right; what the drop then
  // writes has, historically, been computed a second time from a single anchor
  // and been a slot out. So: drag every slot into every gap of every
  // arrangement, and require the strip after the drop to be the strip the
  // preview showed, character for character. Every reported fault in this file
  // is a special case of it, and so is every one nobody has reported yet.
  //
  // Including the drops that change where a conversation works, which are
  // answered as they come. Leaving them out is how one of those reported faults
  // got in: the question a rebinding asks was being answered and the drop's own
  // answer thrown away with it.
  await check('what a drag shows is what the drop writes, and what the server sends back', async () => {
    /**
     * Arrangements that have each broken something. A box with no `place` on
     * its row is the state a workspace is left in when the conversation it sat
     * behind is binned, and it is the one that moved tabs nobody dragged.
     * @type {[string, () => {bar: any, session: any, teardown: () => void}][]}
     */
    const fixtures = [
      ['two empty boxes below', () => mountBar(
        [workspace('w1', 'head'), workspace('w2', 'head')], [['a', ''], ['b', '']])],
      ['two empty boxes, no place recorded', () => mountBar(
        [workspace('w1'), workspace('w2')], [['a', ''], ['b', '']])],
      ['two boxes with members', () => mountBar(
        [workspace('w1', 'head'), workspace('w2', 'head')],
        [['m1', 'w1'], ['m2', 'w2'], ['a', ''], ['b', '']])],
      ['boxes with members, no place recorded', () => mountBar(
        [workspace('w1'), workspace('w2')],
        [['m1', 'w1'], ['m2', 'w2'], ['a', ''], ['b', '']])],
      ['a box between the tabs', () => mountBar(
        [workspace('ws', 'a')], [['a', ''], ['b', ''], ['c', '']])]
    ];

    /** @type {string[]} */
    const broken = [];
    for (const [label, mount] of fixtures) {
      // Every slot the user can pick up — tabs and whole boxes alike, because a
      // box is dragged around the same strip by the same rules — and every gap
      // in it, named by the slot below the gap, plus the end.
      //
      // Every tab means every tab, including the ones drawn inside a box. One
      // of those dragged out is the same gesture as any other with a question
      // in front of it, and leaving the whole class out is what let a tab
      // dropped out of a workspace land somewhere else entirely.
      const scout = mount();
      const slotCount = topSlots(scout.bar).length;
      const draggable = [
        ...(/** @type {HTMLElement[]} */ (Array.from(scout.bar.querySelectorAll('.conversation-tab'))))
          .map(tab => `tab:${tab.dataset.conversationId}`),
        ...topSlots(scout.bar)
          .filter(slot => slot.classList.contains('conversation-box'))
          .map(slot => `box:${slot.dataset.workspaceId}`)
      ];
      scout.teardown();

      for (const what of draggable) {
        for (let gap = 0; gap <= slotCount; gap++) {
          const { bar, session, teardown } = mount();
          const server = withFakeServer(session);
          try {
            const slots = topSlots(bar);
            // Above the slot at `gap`, or past the end of the strip.
            const target = gap < slots.length
              ? slots[gap].getBoundingClientRect().top - 2
              : slots[slots.length - 1].getBoundingClientRect().bottom + 30;

            const id = what.slice(4);
            const isTab = what.startsWith('tab:');
            const dragging = isTab ? tabFor(bar, id) : boxFor(bar, id);
            const grabbed = isTab
              ? dragging
              : /** @type {HTMLElement} */ (dragging.querySelector('.conversation-box-header'));
            /** @type {any} */ (grabbed).setPointerCapture = () => {};
            /** @type {any} */ (grabbed).releasePointerCapture = () => {};

            const startedIn = isTab ? boxOf(dragging) : '';
            const from = grabbed.getBoundingClientRect();
            const x = from.left + 10;
            const press = { clientX: x, clientY: from.top + from.height / 2, pointerId: 1 };
            if (isTab) bar._startDrag(press, dragging);
            else bar._startBoxDrag(press, dragging);
            movePointer(x, target);

            const shown = drawn(bar);
            // A drop that has left the box it was picked up from — or landed in
            // one — changes where the conversation works, and asks before it
            // does. Answering yes is the other half of that gesture: the
            // binding moves, and the tab with it, to where it was let go.
            const asks = isTab && boxOf(tabFor(bar, id)) !== startedIn;
            document.dispatchEvent(new PointerEvent('pointerup', {
              pointerId: 1, pointerType: 'touch', clientX: x, clientY: target, bubbles: true
            }));
            if (asks) await answerMove(true);
            bar.render();

            if (drawn(bar) !== shown) {
              broken.push(`  ${label}: dragging ${what} to gap ${gap} showed "${shown}", wrote "${drawn(bar)}"`);
              continue;
            }

            // And it holds once the server has said what it now thinks the
            // table is. An arrangement recorded only in this window's copy is
            // taken away by the next broadcast, which is every workspace edit
            // from anywhere — so a drop that is right until the round trip
            // lands is a drop that is wrong a moment later.
            await new Promise(resolve => setTimeout(resolve, 0));
            server.broadcast();
            bar.render();
            if (drawn(bar) !== shown) {
              broken.push(`  ${label}: dragging ${what} to gap ${gap} showed "${shown}", and the server `
                + `answered with "${drawn(bar)}" (wrote: ${server.wrote.join('; ') || 'nothing'})`);
            }
          } finally {
            server.restore();
            releasePointer();
            teardown();
          }
        }
      }
    }

    assert(broken.length === 0,
      'a drop writes the arrangement it was showing when it was let go, in every strip and every gap '
      + `of it:\n${broken.join('\n')}`);
  });

  return { passed, failed, errors };
}
