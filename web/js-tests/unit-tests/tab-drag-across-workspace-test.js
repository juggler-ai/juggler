//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dragging a tab out of one workspace's box and into another's.
 *
 * Inside a box the gesture is a reorder, committed the moment it lands. Across
 * boxes it is not — the same eighth of a second would
 * otherwise move a running agent's working tree, and where a conversation's
 * files and commands happen is not a thing to change by slipping. So a
 * cross-box drop asks: the move dialog opens on the place it was dropped in,
 * with the question about work left behind that a drag cannot ask, and the tab
 * goes straight back to the box it came from until an answer moves it. A drop
 * that leaves it working in the same tree — into or out of a group, which is
 * rooted at the project — changes nothing the question is about, and is simply
 * made (see `moveNeedsConfirmation`).
 *
 * The question is about the binding alone. Where in the strip the tab lands was
 * settled by the gesture, and an answered move puts it exactly there — asserted
 * on the drawn strip in tab-drag-workspace-order-test, which is where what a
 * drop writes is compared with what it showed.
 *
 * The box with nothing in it is a drop target like any other. It is the case
 * the whole layout exists for — a tree that outlived its conversations — and
 * "put this one in there" is the obvious thing to want to do with it.
 *
 * A drop that cannot be honoured is answered rather than asked about. Being
 * made to confirm a move and then told it was never available is the question
 * and the answer in the wrong order.
 * @module unit-tests/tab-drag-across-workspace-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * A workspace row as the session holds one, ready to be worked in.
 * @param {string} id - The workspace id.
 * @param {string} label - What the box is named.
 * @returns {any} The row.
 */
function workspace(id, label) {
  return { id, root: `/tmp/${id}`, label, state: 'ready', available: true, providerId: '(none)' };
}

/**
 * A workspace rooted at the project itself, as a group is: a box in the strip
 * with no tree of its own behind it.
 * @param {string} id - The workspace id.
 * @param {string} label - What the box is named.
 * @returns {any} The row.
 */
function group(id, label) {
  return { ...workspace(id, label), root: '/tmp/project', providerId: 'group' };
}

/**
 * Mount a bar drawing the given workspaces and bindings, with a session stub
 * that records every reorder it is asked for.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {{bar: any, session: any, calls: any[][], teardown: () => void}} The bar, its session, the recorded calls, and a teardown.
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
     * @param {string} id - Which workspace, '' for the project.
     * @returns {string|null} The root to work in, or null when it cannot be.
     */
    workspaceRoot(id) {
      if (!id) return this.projectPath;
      const row = workspaces.find((one) => one.id === id);
      return row && row.available && row.state === 'ready' ? row.root : null;
    },
    /**
     * A drop hands over the whole strip as it stands, so what is recorded is
     * the arrangement: the conversation order, and where each box sits in it.
     * @param {{order: string[], places: Map<string, string>, moved?: string}} arrangement - The strip as the drop found it.
     * @returns {boolean} Always accepted.
     */
    applyStripArrangement({ order, places }) {
      calls.push(['arrangement', order.join(','),
        [...places].map(([id, place]) => `${id}=${place}`).join(' ')]);
      return true;
    }
  };
  // The dialog reaches back through the conversation to ask the session what
  // else is on the table, so the back-reference a real conversation carries has
  // to be there.
  for (const [id, workspaceId] of bindings) {
    session.conversations.set(id, { id, name: id, workspaceId, session });
  }

  // setSession() would spin up a panel and a worker per conversation; the strip
  // needs none of that, so the session is attached directly.
  bar._session = session;
  bar.render();
  for (const tab of Array.from(bar.querySelectorAll('.conversation-tab'))) {
    /** @type {any} */ (tab).setPointerCapture = () => {};
    /** @type {any} */ (tab).releasePointerCapture = () => {};
  }
  return { bar, session, calls, teardown: () => host.remove() };
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
 * Which workspace's box a tab is drawn in, or '' for the flat strip.
 * @param {HTMLElement} tab - The tab element.
 * @returns {string} The workspace id, or ''.
 */
function boxOf(tab) {
  return /** @type {HTMLElement|null} */ (tab.closest('.conversation-box'))?.dataset.workspaceId ?? '';
}

/**
 * Drag one tab onto a point inside another element, and let go.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} tab - The tab to drag.
 * @param {HTMLElement} onto - What to drop it on.
 * @returns {void}
 */
function dragOnto(bar, tab, onto) {
  const from = tab.getBoundingClientRect();
  const to = onto.getBoundingClientRect();
  bar._startDrag({ clientX: from.left + 10, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
  // Just inside the target's top edge, so it is the item the drop lands before.
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch',
    clientX: to.left + 10, clientY: to.top + 1, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: to.left + 10, clientY: to.top + 1, bubbles: true
  }));
}

/**
 * Drag one tab to a bare point in the bar, and let go. Unlike {@link dragOnto}
 * this lands nowhere in particular — which is the whole question: past the end
 * of the strip, or above the start of it, where the nearest tab is one drawn
 * inside a box the pointer never entered.
 * @param {any} bar - The mounted bar.
 * @param {HTMLElement} tab - The tab to drag.
 * @param {number} clientY - Where to let go.
 * @returns {void}
 */
function dragToY(bar, tab, clientY) {
  const from = tab.getBoundingClientRect();
  const x = from.left + 10;
  bar._startDrag({ clientX: x, clientY: from.top + from.height / 2, pointerId: 1 }, tab);
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
  }));
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
 * Shut whatever a drop put on screen — the move dialog, or the notice a refused
 * drop is answered with, which would otherwise sit out its five seconds over the
 * case after this one.
 */
function closeDialog() {
  /** @type {HTMLElement|null} */ (document.querySelector('.workspace-move-cancel'))?.click();
  /** @type {any} */ (document.querySelector('modal-dialog.is-notice'))?.close(null);
}

/**
 * What the notice on screen says, if there is one.
 * @returns {string} Its message, or '' when nothing is being said.
 */
function noticed() {
  return document.querySelector('modal-dialog.is-notice .modal-message')?.textContent ?? '';
}

/**
 * The place the open move dialog says the conversation is moving to.
 * @returns {string|null} That workspace's id, '' for the project folder, or
 *   null when no dialog is naming one.
 */
function destination() {
  const named = /** @type {HTMLElement|null} */ (
    document.querySelector('.workspace-move-dialog .workspace-move-to'));
  return named ? (named.dataset.workspaceId ?? null) : null;
}

/**
 * Run the cross-workspace tab drag tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => Promise<void>} body - The check.
   * @returns {Promise<void>} When it has run.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      closeDialog();
    }
  };

  await check('a drop in another box asks where the conversation should work, and reorders nothing', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2')],
      [['c1', 'ws_a'], ['c2', 'ws_b']]
    );
    try {
      const moving = tabFor(bar, 'c2');
      dragOnto(bar, moving, tabFor(bar, 'c1'));

      assert(calls.length === 0,
        `a drag across boxes moves the binding, which only the dialog does — it must not quietly reorder: ${JSON.stringify(calls)}`);
      await waitFor(() => !!document.querySelector('.workspace-move-dialog'),
        { description: 'the move dialog the drop asks through' });
      assert(destination() === 'ws_a',
        `it asks about the box the tab was dropped in, got ${JSON.stringify(destination())}`);
      assert(boxOf(tabFor(bar, 'c2')) === 'ws_b',
        'and the tab is back where it started until the answer moves it');
    } finally {
      teardown();
    }
  });

  await check('a conversation mid-turn is told it cannot move, not asked whether to', async () => {
    const { bar, session, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2')],
      [['c1', 'ws_a'], ['c2', 'ws_b']]
    );
    try {
      session.conversations.get('c2').isProcessing = true;
      dragOnto(bar, tabFor(bar, 'c2'), tabFor(bar, 'c1'));

      await waitFor(() => !!noticed(), { description: 'the drop to say why it went nowhere' });
      assert(/turn/i.test(noticed()),
        `a drop that cannot be honoured says so, got ${JSON.stringify(noticed())}`);
      assert(!document.querySelector('.workspace-move-dialog'),
        'and does not first ask whether to do the thing it is refusing to do');
      assert(calls.length === 0 && session.conversations.get('c2').workspaceId === 'ws_b',
        `with the conversation left where it was working: ${JSON.stringify(calls)}`);
      assert(boxOf(tabFor(bar, 'c2')) === 'ws_b',
        'and the tab back in its box, since nothing about it has changed');
    } finally {
      teardown();
    }
  });

  await check('a drop inside the same box is still just a reorder', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c1', 'ws_a'], ['c2', 'ws_a']]
    );
    try {
      dragOnto(bar, tabFor(bar, 'c2'), tabFor(bar, 'c1'));

      assert(JSON.stringify(calls) === JSON.stringify([['arrangement', 'c2,c1', 'ws_a=head']]),
        `nothing about where it works has changed, so the drop commits itself: ${JSON.stringify(calls)}`);
      assert(!document.querySelector('.workspace-move-dialog'),
        'and nothing is asked');
    } finally {
      teardown();
    }
  });

  await check('a box with nothing in it is somewhere to drop', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2')],
      [['c1', 'ws_a']]
    );
    try {
      const empty = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_b"] .conversation-box-empty'));
      assert(empty.hidden === false, 'the empty box says so, which is the thing being dropped on');
      dragOnto(bar, tabFor(bar, 'c1'), empty);

      assert(calls.length === 0, `nothing to reorder: ${JSON.stringify(calls)}`);
      await waitFor(() => !!document.querySelector('.workspace-move-dialog'),
        { description: 'the move dialog for a drop into the empty box' });
      assert(destination() === 'ws_b',
        `the tree that outlived its conversations is a place to move into, got ${JSON.stringify(destination())}`);
    } finally {
      teardown();
    }
  });

  await check('a tab dragged out to the flat strip is being moved to the project folder', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c3', ''], ['c1', 'ws_a']]
    );
    try {
      dragOnto(bar, tabFor(bar, 'c1'), tabFor(bar, 'c3'));

      assert(calls.length === 0, `leaving a workspace is a move, not a reorder: ${JSON.stringify(calls)}`);
      await waitFor(() => !!document.querySelector('.workspace-move-dialog'),
        { description: 'the move dialog for a drop in the strip' });
      assert(destination() === '',
        `the strip outside every box is the project folder, got ${JSON.stringify(destination())}`);
    } finally {
      teardown();
    }
  });

  await check('a move that leaves the conversation working in the same tree is not asked about', async () => {
    // A group is rooted at the project, so moving a conversation out of one —
    // or into one, or between two of them — changes which box it is drawn in
    // and nothing about where its files and commands are. The dialog exists to
    // stop that second thing happening by accident, so there is nothing to ask.
    const out = mountBar([group('ws_g', 'my group')], [['c3', ''], ['c1', 'ws_g']]);
    try {
      dragOnto(out.bar, tabFor(out.bar, 'c1'), tabFor(out.bar, 'c3'));
      await waitFor(() => out.session.conversations.get('c1').workspaceId === '',
        { description: 'the conversation to be moved into the project without a question' });
      assert(!document.querySelector('.workspace-move-dialog'),
        'out of a group into the project is not asked about');
      await waitFor(() => out.calls.length === 1,
        { description: 'the strip to be arranged where the drop put the tab' });
    } finally {
      out.teardown();
    }

    const into = mountBar([group('ws_g', 'my group'), group('ws_h', 'another group')],
      [['c1', 'ws_g'], ['c2', 'ws_h']]);
    try {
      dragOnto(into.bar, tabFor(into.bar, 'c2'), tabFor(into.bar, 'c1'));
      await waitFor(() => into.session.conversations.get('c2').workspaceId === 'ws_g',
        { description: 'a conversation to be moved between groups without a question' });
      assert(!document.querySelector('.workspace-move-dialog'),
        'and nor is from one group into another');
    } finally {
      into.teardown();
    }
  });

  await check('a move into a different tree is still asked about, whatever it is next to', async () => {
    // The other half of the rule: sharing nothing with the project, a tree of
    // its own is exactly the move the dialog is for.
    const { bar, session, teardown } = mountBar(
      [group('ws_g', 'my group'), workspace('ws_b', 'scratch-2')],
      [['c1', 'ws_g'], ['c2', 'ws_b']]
    );
    try {
      dragOnto(bar, tabFor(bar, 'c1'), tabFor(bar, 'c2'));
      await waitFor(() => !!document.querySelector('.workspace-move-dialog'),
        { description: 'the move dialog for a drop from a group into a tree of its own' });
      assert(session.conversations.get('c1').workspaceId === 'ws_g',
        'and nothing has moved while the question is open');
    } finally {
      teardown();
    }
  });

  await check('a drop below a box at the foot of the strip is not a drop into it', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c1', ''], ['c2', 'ws_a']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      assert(!!box, 'the box is drawn below the flat tab, which is the arrangement being tested');
      dragToY(bar, tabFor(bar, 'c1'), box.getBoundingClientRect().bottom + 40);

      assert(!document.querySelector('.workspace-move-dialog'),
        'the pointer was never inside the box, so nothing about where c1 works has been proposed');
      assert(JSON.stringify(calls) === JSON.stringify([['arrangement', 'c2,c1', 'ws_a=head']]),
        `past the end of the strip is the end of the strip, not the inside of the last box: ${JSON.stringify(calls)}`);
      assert(boxOf(tabFor(bar, 'c1')) === '',
        'and the tab is still drawn flat');
    } finally {
      teardown();
    }
  });

  await check('a drop above a box at the head of the strip is not a drop into it', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c2', 'ws_a'], ['c1', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      dragToY(bar, tabFor(bar, 'c1'), box.getBoundingClientRect().top - 10);

      assert(!document.querySelector('.workspace-move-dialog'),
        'above the first box is still outside it, however close the nearest tab inside it happens to be');
      assert(JSON.stringify(calls) === JSON.stringify([['arrangement', 'c1,c2', 'ws_a=c1']]),
        `landing in front of the box means landing in front of what the box holds: ${JSON.stringify(calls)}`);
      assert(boxOf(tabFor(bar, 'c1')) === '',
        'and the tab is still drawn flat');
    } finally {
      teardown();
    }
  });

  await check('a tab dragged out of its box and back into it has not been anywhere', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c1', 'ws_a'], ['c2', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      const list = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-tabs'));
      const tab = tabFor(bar, 'c1');
      const x = box.getBoundingClientRect().left + 10;
      const start = tab.getBoundingClientRect();
      /**
       * @param {number} clientY - Where the pointer has got to.
       * @returns {void}
       */
      const move = (clientY) => {
        document.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 1, buttons: 1, pointerType: 'touch', clientX: x, clientY, bubbles: true
        }));
      };

      bar._startDrag({ clientX: x, clientY: start.top + start.height / 2, pointerId: 1 }, tab);
      move(tabFor(bar, 'c2').getBoundingClientRect().bottom + 40);
      assert(boxOf(tabFor(bar, 'c1')) === '',
        'the tab is out of the box mid-drag, which is the half of the gesture the drop has to undo');

      // Back inside the box it came from, below the one tab it holds: the end of
      // that box, and the only place a single-conversation box has to land in.
      const home = box.getBoundingClientRect().bottom - 2;
      assert(bar._dropPlaceAt(x, home, tab).parent === list,
        'the drop is being read inside the box, or the rest of this proves nothing');
      move(home);
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: home, bubbles: true
      }));

      assert(calls.length === 0,
        `the end of a box is not the end of the strip — nothing moved, so nothing is written: ${JSON.stringify(calls)}`);
      assert(!document.querySelector('.workspace-move-dialog'),
        'and it landed in the workspace it started in, so nothing is asked');
      assert(boxOf(tabFor(bar, 'c1')) === 'ws_a',
        'and the tab is back in its box');
      assert(box.compareDocumentPosition(tabFor(bar, 'c2')) & Node.DOCUMENT_POSITION_FOLLOWING,
        'and the box is still drawn above the flat tab, where it was: a workspace does not move because a tab inside it was picked up');
    } finally {
      teardown();
    }
  });

  await check('a tab dropped at the foot of its box lands after the box, not after everything', async () => {
    const { bar, calls, teardown } = mountBar(
      [workspace('ws_a', 'feature/auth')],
      [['c1', 'ws_a'], ['c2', 'ws_a'], ['c3', '']]
    );
    try {
      const box = boxFor(bar, 'ws_a');
      dragToY(bar, tabFor(bar, 'c1'), box.getBoundingClientRect().bottom - 2);

      assert(JSON.stringify(calls) === JSON.stringify([['arrangement', 'c2,c1,c3', 'ws_a=head']]),
        `past the last tab in the box is the place the box ends, which is in front of whatever follows it: ${JSON.stringify(calls)}`);
      assert(!document.querySelector('.workspace-move-dialog'),
        'it never left the box, so nothing is asked');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
