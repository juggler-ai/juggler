//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Drawing a workspace as a box with its conversations inside it.
 *
 * The tab bar is one strip of tabs with a second thing in it now, and the
 * assertions here are about what that costs. A tab belongs inside the box of
 * the workspace it works in; the project's tabs stay flat, unboxed and where
 * they were; a box outlives the conversations that were started in it, which is
 * the whole reason for drawing one; and a render that changes nothing moves
 * nothing — the reconciliation pass is load-bearing for the tab pulse, which a
 * re-inserted node restarts.
 * @module unit-tests/workspace-boxes-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import {
  workspaceFinishActor,
  placeForNewConversation,
  placementForNewConversation
} from '../../js/services/workspace-provisioning.js';
import Conversation from '../../js/model/conversation.js';
import '../../js/components/conversation-bar.js';

/**
 * A provider with something to say about a tree and two ways of finishing with
 * it — enough for a header to draw and a menu to be read.
 */
class BoxFixtureProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'box-fixture-workspace-provider',
    name: 'worktree',
    version: '1.0.0',
    description: 'Says a fixed thing about a tree so a header can draw it'
  };

  /**
   * @param {any} workspace - The row being reported on.
   * @returns {Promise<any>} What the header shows.
   */
  async status(workspace) {
    void workspace;
    return { detail: 'branch onboarding · 2 changed', dirty: true };
  }

  /**
   * @returns {any[]} One ending that keeps the workspace, one that removes it.
   */
  finishOptions() {
    return [
      { id: 'commit', label: 'Commit the changes', keepsWorkspace: true, description: 'Commits everything here.' },
      { id: 'discard', label: 'Delete this workspace', danger: true, description: 'Removes the tree.' }
    ];
  }
}

/**
 * A workspace row as the session holds one.
 * @param {string} id - The workspace id.
 * @param {string} label - What the header calls it.
 * @param {object} [overrides] - What makes it unusable, where it is not ready.
 * @returns {any} The row.
 */
function workspace(id, label, overrides = {}) {
  return {
    id,
    root: `/tmp/${id}`,
    label,
    state: 'ready',
    available: true,
    providerId: BoxFixtureProvider.MANIFEST.id,
    ...overrides
  };
}

/**
 * The session surface render() touches. Conversations are bare records — no
 * `llmState`, so every tab reads as idle.
 * @param {any[]} workspaces - The workspace table.
 * @param {[string, string][]} bindings - `[conversation id, workspace id]`, in tab-bar order.
 * @returns {any} The stub.
 */
function stubSession(workspaces, bindings) {
  return {
    workspaces,
    conversations: new Map(bindings.map(([id, workspaceId]) => [id, { id, name: id, workspaceId }])),
    binnedCount: 0,
    binSizeBytes: 0,
    selection: null,
    loadedConversationId: null
  };
}

/**
 * The strip as it is drawn: each top-level entry, and what is inside a box.
 *
 * The two pieces of chrome pinned into the list — the "+" rows that make a
 * conversation at the top and a workspace at the bottom — are not entries and
 * are left out.
 * @param {any} bar - The mounted bar.
 * @returns {string} e.g. `ws_a{c1,c2} c3`.
 */
function strip(bar) {
  const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
  return Array.from(menu.children)
    .filter(child => !child.classList.contains('conversation-add-item')
      && !child.classList.contains('conversation-box-new'))
    .map(child => {
      if (child.classList.contains('conversation-tab')) {
        return /** @type {HTMLElement} */ (child).dataset.conversationId;
      }
      const inside = Array.from(child.querySelectorAll('.conversation-tab'))
        .map(tab => /** @type {HTMLElement} */ (tab).dataset.conversationId);
      return `${/** @type {HTMLElement} */ (child).dataset.workspaceId}{${inside.join(',')}}`;
    })
    .join(' ');
}

/**
 * Whether a computed colour hides what is behind it.
 *
 * Handles both serialisations a colour can arrive in: the legacy `rgba()` form,
 * and the `color()` form with a slashed alpha that a wide-gamut space uses.
 * @param {string} colour - A computed colour value.
 * @returns {boolean} True if it is fully opaque.
 */
function isOpaque(colour) {
  const alpha = /\/\s*([\d.]+)\s*\)\s*$/.exec(colour)?.[1]
    ?? /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(colour)?.[1];
  return alpha === undefined || Number(alpha) === 1;
}

/**
 * A conversation as `WorkerManager._doCreateNew` builds one: the real class,
 * carrying the workspace it was created for and nothing of its own yet.
 *
 * The real class rather than a record, because what is being asserted is what a
 * conversation reports about itself between being created and being initialised
 * — a window the strip draws twice, and which a record made to the right shape
 * would assume away. The constructor touches its session only as a name cache
 * and stores its services without calling them, so both can be this small.
 * @param {string} id - The conversation id.
 * @param {string} workspaceId - The tree it was created to work in.
 * @returns {any} The conversation, as the session's map would hold it.
 */
function createdConversation(id, workspaceId) {
  /** @type {Map<string, string>} */
  const names = new Map();
  const host = {
    getConversationName: (/** @type {string} */ key) => names.get(key),
    setConversationName: (/** @type {string} */ key, /** @type {string} */ value) => names.set(key, value)
  };
  return new Conversation(id, id, /** @type {any} */ (host), /** @type {any} */ ({}), {
    skipBuiltInContextItems: true,
    workspaceId
  });
}

/**
 * Put a conversation into a session's map at an index, leaving the rest of the
 * order alone — `Session._placeNewConversation`, which rebuilds the map.
 * @param {any} session - The session to place it in.
 * @param {number} index - Where in the flat order it goes.
 * @param {any} conversation - The conversation being placed.
 */
function placeAt(session, index, conversation) {
  const order = [...session.conversations];
  order.splice(index, 0, [conversation.id, conversation]);
  session.conversations = new Map(order);
}

/**
 * The conversation order the server stores for a create, as
 * `SessionManager.CreateConversationAt` builds it: at the head, at the end, or
 * immediately behind the anchor it was given — and at the head when that anchor
 * is one the server has never heard of.
 * @param {string[]} existing - The ids already in the order.
 * @param {string} id - The id being created.
 * @param {{where: string, after: string}} placement - Where the create asked to go.
 * @returns {string[]} The stored order.
 */
function serverOrderForCreate(existing, id, placement) {
  const order = [...existing];
  if (placement.where === 'end') return [...order, id];
  const at = placement.where === 'after' ? order.indexOf(placement.after) : -1;
  if (at === -1) return [id, ...order];
  order.splice(at + 1, 0, id);
  return order;
}

/**
 * Re-slot a session's conversations into a server-sent order — the pass in
 * `Session#refreshFromServer` that a `session-changed` broadcast triggers, and
 * which has the last word over anything the client placed itself.
 * @param {any} session - The session to re-slot.
 * @param {string[]} order - The server's order.
 */
function reslotToServerOrder(session, order) {
  session.conversations = new Map(
    order.filter(id => session.conversations.has(id))
      .map(id => [id, session.conversations.get(id)])
  );
}

/**
 * Run the workspace-boxes tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.id = 'workspace-boxes-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  // Registered rather than reset into place: a reset would take the real
  // providers out from under whatever else is on this page, and an id nobody
  // else uses needs no room made for it.
  workspaceProviderRegistry.registerClass(BoxFixtureProvider, { extensionId: 'test', modulePath: '(test)' });

  /**
   * @param {string} name - What is being checked.
   * @param {() => void|Promise<void>} body - The check.
   * @returns {Promise<void>} When it has run.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    await check('a bound conversation is drawn inside its workspace, and the project stays flat', () => {
      // setSession() would spin up per-conversation <conversation-tab> panels
      // and their workers; the strip needs none of that, so the session is
      // attached directly and the bar re-rendered against it.
      bar._session = stubSession(
        [workspace('ws_a', 'feature/auth')],
        [['c1', 'ws_a'], ['c2', 'ws_a'], ['c3', '']]
      );
      bar.render();

      assert(strip(bar) === 'ws_a{c1,c2} c3',
        `both conversations working in the tree belong inside its box, and the project's stays in the strip, got "${strip(bar)}"`);

      const label = bar.querySelector('.conversation-box[data-workspace-id="ws_a"] .conversation-box-label');
      assert(label?.textContent === 'feature/auth',
        `the box is named by the workspace it draws, got ${JSON.stringify(label?.textContent)}`);
    });

    await check('a render that changes nothing moves nothing', () => {
      // Re-inserting a node restarts the CSS animations on it — the tab status
      // pulse — so the reconciliation may only touch what is out of place. The
      // observer sees a move as a removal and an addition of the same node.
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const observer = new MutationObserver(() => {});
      observer.observe(menu, { childList: true, subtree: true });
      try {
        bar.render();
        const moved = observer.takeRecords().flatMap(record => [...record.addedNodes, ...record.removedNodes]);
        assert(moved.length === 0,
          `a second render of the same session should move nothing, but it touched ${moved.length} node(s)`);
      } finally {
        observer.disconnect();
      }
    });

    await check('the box stays when the last conversation in it goes', () => {
      // A box's place is its row's, and the server keeps that row naming a
      // conversation that is still there — a workspace whose anchor is binned
      // inherits that conversation's neighbour (see `reanchorBoxesAt`). So
      // binning the last conversation in one changes what is inside the box,
      // and not where the box is.
      const row = bar._session.workspaces.find((/** @type {any} */ ws) => ws.id === 'ws_a');
      row.place = 'head';
      bar._session.conversations.delete('c1');
      bar._session.conversations.delete('c2');
      bar.render();

      assert(strip(bar) === 'ws_a{} c3',
        `the tree is still there to be worked in or finished with, so its box is too, got "${strip(bar)}"`);
      const empty = /** @type {HTMLElement|null} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"] .conversation-box-empty'));
      assert(empty?.hidden === false && empty?.textContent?.trim() === '(empty)',
        `an empty box says so rather than collapsing to a line, got ${JSON.stringify(empty?.textContent)} hidden=${empty?.hidden}`);
      assert(empty && getComputedStyle(empty).textAlign === 'center',
        `centred in the box, since it stands in for its contents rather than starting a list, got ${empty && getComputedStyle(empty).textAlign}`);
    });

    await check('an empty box is a grip all over, to a mouse', () => {
      // There is nothing inside it to aim at, so the whole card answers the
      // mouse the way its name does. A band of dead space around one short
      // line of text is a box that looks draggable and is not.
      //
      // To a mouse. A finger is held to the grip here as everywhere, because an
      // empty box is a full-width card in a list that scrolls vertically, and a
      // card that took a touch anywhere on itself would be a card you cannot
      // scroll past.
      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const empty = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-empty'));

      /** @type {string[]} */
      const selected = [];
      const selectWas = bar._session.selectWorkspace;
      bar._session.selectWorkspace = (/** @type {string} */ id) => { selected.push(id); return true; };
      /** @type {any[]} */
      const dragged = [];
      const dragWas = bar._startBoxDrag;
      bar._startBoxDrag = (/** @type {any} */ _event, /** @type {any} */ target) => { dragged.push(target); };
      // A tab's own drag is stubbed out too. What is being checked here is which
      // presses reach the box, and a real tab drag started by one of them would
      // hold the strip open — a drag claims it from the press and only lets go on
      // release, so the renders after this check would all be deferred.
      const tabDragWas = bar._startDrag;
      bar._startDrag = () => {};
      try {
        empty.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert(selected.join(',') === 'ws_a',
          `clicking the line inside an empty box selects its workspace, got ${JSON.stringify(selected)}`);

        empty.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerType: 'mouse'
        }));
        assert(dragged.length === 1 && dragged[0] === box,
          `and pressing there takes hold of the box itself, got ${dragged.length} drag(s)`);

        empty.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerType: 'touch'
        }));
        assert(dragged.length === 2 && dragged[1] === box,
          'and a finger there begins the same gesture, which the hold then decides is a drag or a '
          + `scroll, got ${dragged.length} drag(s)`);

        // The "+" is a button, and a press on a button is a press on that
        // button — it must neither select the box nor start dragging it.
        const add = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-add'));
        add.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerType: 'mouse'
        }));
        assert(dragged.length === 2,
          `pressing the "+" does not drag the box, got ${dragged.length} drag(s)`);

        // And the moment the box has a tab in it, the tab is what a press there
        // is about: it selects that conversation, and dragging it moves it
        // between boxes. Only the name stays a grip on the box itself.
        bar._session.conversations.set('c9', { id: 'c9', name: 'c9', workspaceId: 'ws_a' });
        bar.render();
        const tab = /** @type {HTMLElement} */ (
          box.querySelector('.conversation-tab[data-conversation-id="c9"]'));
        tab.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerType: 'mouse'
        }));
        assert(dragged.length === 2,
          `a press on a tab does not take hold of the box around it, got ${dragged.length} drag(s)`);
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert(selected.join(',') === 'ws_a',
          `nor does clicking one select the workspace a second time, got ${JSON.stringify(selected)}`);

        // The name is still a grip, whatever is in the box.
        const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerType: 'mouse'
        }));
        assert(dragged.length === 3 && dragged[2] === box,
          `and the header still takes hold of it, got ${dragged.length} drag(s)`);

        bar._session.conversations.delete('c9');
        bar.render();
      } finally {
        bar._session.selectWorkspace = selectWas;
        bar._startBoxDrag = dragWas;
        bar._startDrag = tabDragWas;
      }
    });

    await check('the box carries a "+" that starts a conversation in its workspace', () => {
      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const add = /** @type {HTMLButtonElement} */ (box.querySelector('.conversation-box-add'));
      assert(add, 'an empty box offers the way to put something in it');
      // A drawn mark rather than a "+" character: a glyph sits wherever its
      // font's ascent and descent put it, which is not the middle of a circle.
      const mark = add.querySelector('svg');
      assert(mark, 'it is a drawn mark, not a character placed by font metrics');
      const ring = add.getBoundingClientRect();
      const drawn = mark.getBoundingClientRect();
      const off = Math.hypot(
        (drawn.left + drawn.width / 2) - (ring.left + ring.width / 2),
        (drawn.top + drawn.height / 2) - (ring.top + ring.height / 2));
      assert(drawn.width > 0 && off < 0.5,
        `and it is centred in its circle, got ${off.toFixed(2)}px out (${drawn.width}px wide)`);
      assert(add.getAttribute('aria-label') === 'New conversation in this workspace',
        `and says which workspace it means, got ${JSON.stringify(add.getAttribute('aria-label'))}`);

      // Outside the header element: `<workspace-box-header>` shows the name and
      // nothing else, so the one control the box carries is the box's own.
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
      assert(!header.contains(add),
        'the button belongs to the box, not to the header that names the place');

      /** @type {any[]} */
      const created = [];
      const createWas = bar._createConversation;
      bar._createConversation = async (/** @type {string} */ workspaceId) => { created.push(workspaceId); };
      try {
        add.click();
        assert(created.join(',') === 'ws_a',
          `pressing it starts a conversation in the workspace whose box it is, got ${JSON.stringify(created)}`);
      } finally {
        bar._createConversation = createWas;
      }
    });

    await check('a workspace finished with loses its box, and its conversations do not go with it', () => {
      bar._session = stubSession(
        [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2')],
        [['c1', 'ws_a'], ['c2', 'ws_b']]
      );
      bar.render();
      assert(strip(bar) === 'ws_a{c1} ws_b{c2}',
        `two workspaces, a box each, got "${strip(bar)}"`);

      bar._session.workspaces = [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2', { state: 'closed' })];
      bar.render();
      assert(strip(bar) === 'ws_a{c1} c2',
        `a closed workspace is nowhere to work, so it gets no box — and the conversation still bound to it is drawn flat rather than removed with it, got "${strip(bar)}"`);
    });

    await check('the box names the place, and marks it when the tree is dirty', async () => {
      bar._session = stubSession([workspace('ws_a', 'feature/auth')], [['c1', 'ws_a']]);
      bar.render();

      const header = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"] .conversation-box-header'));

      // The probe is a round trip to the provider, so the mark arrives after
      // the box does. One probe, for the workspace — not one per conversation
      // in it, which is what three tabs in one worktree used to cost.
      await waitFor(() => header.classList.contains('is-dirty'),
        { description: 'the box to hear that the tree is holding uncommitted work' });

      const label = /** @type {HTMLElement} */ (header.querySelector('.conversation-box-label'));
      assert(label.textContent === 'feature/auth',
        `the box names the place, got ${JSON.stringify(label.textContent)}`);
      assert(!header.textContent?.includes('worktree'),
        `and says no more than that: what kind of place it is wants room the strip has not got, so it is the panel's, got ${JSON.stringify(header.textContent)}`);
    });

    await check('a box has a surface of its own, and nothing else in the strip shares it', () => {
      bar._session = stubSession([workspace('ws_a', 'feature/auth')], [['c1', 'ws_a']]);
      bar.render();

      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const tab = /** @type {HTMLElement} */ (box.querySelector('.conversation-tab'));

      // Both themes, because the strip is drawn on the wrong side of a ramp in
      // exactly one of them: the box and the tabs in it were within a few
      // points of the page behind them in dark mode, which is a box you cannot
      // see and a tab you cannot see it holding. The colours are taste and are
      // not pinned here; that they are three different colours is not.
      const root = document.documentElement;
      const was = root.dataset.theme;
      try {
        for (const theme of ['dark', 'light']) {
          root.dataset.theme = theme;
          const strip = getComputedStyle(bar).backgroundColor;
          const fill = getComputedStyle(box).backgroundColor;
          const edge = getComputedStyle(box).borderTopColor;
          const card = getComputedStyle(tab).backgroundColor;

          assert(fill !== strip && fill !== 'rgba(0, 0, 0, 0)',
            `in ${theme}, a box is a tray and a tray is a surface: it cannot be the colour of the page it sits on, got ${fill} against ${strip}`);
          assert(card !== fill,
            `in ${theme}, a tab lying in the tray cannot be the colour of the tray, got ${card} against ${fill}`);
          assert(edge !== fill,
            `in ${theme}, and the tray has an edge to find, got ${edge} against ${fill}`);
        }
      } finally {
        if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
      }
    });

    await check('a tab keeps a fill of its own through every alert it wears', () => {
      bar._session = stubSession([workspace('ws_a', 'feature/auth')], [['c1', 'ws_a']]);
      bar.render();

      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const tab = /** @type {HTMLElement} */ (box.querySelector('.conversation-tab'));

      // The selected box is blue, and a tab's alert colours are yellow. Any
      // alpha in one of them mixes the two into a colour neither means: the
      // alert states were drawn against the page, and a box put a surface
      // between the tab and the page it was mixing with.
      box.classList.add('active');
      tab.classList.remove('active');
      // The tab eases its background over 150ms, and a value read inside that
      // window is an interpolation of the two colours rather than either of
      // them — which is opaque whatever the colour it is heading for. The
      // target is the thing under test, so the easing is turned off to see it.
      tab.style.transition = 'none';
      // Both themes, because a box's tint is one of the theme's hues and the
      // light theme's are translucent: a surface mixed from one is a glaze too.
      const root = document.documentElement;
      const was = root.dataset.theme;
      try {
        for (const theme of ['dark', 'light']) {
          root.dataset.theme = theme;
          tab.classList.add('needs-attention');
          const standing = getComputedStyle(tab).backgroundColor;
          assert(isOpaque(standing),
            `in ${theme}, the standing needs-attention tint must be a fill, not a glaze: `
            + `got ${standing}, which is the blue of the box it lies in showing through it`);

          // The flash's "off" frame is the tab as it would otherwise be, which
          // is a colour — reachable only by driving the animation to that frame.
          tab.classList.add('attention-flash');
          const flash = tab.getAnimations().find(a => /** @type {any} */ (a).animationName === 'tab-attention-flash');
          assert(flash !== undefined, 'precondition: the one-shot flash is running on the tab');
          /** @type {any} */ (flash).currentTime = 200;
          const off = getComputedStyle(tab).backgroundColor;
          assert(isOpaque(off),
            `in ${theme}, the dark half of the flash is the tab, not a hole through it: `
            + `got ${off} where the box behind it is ${getComputedStyle(box).backgroundColor} `
            + `(the standing tint measured ${standing})`);
          tab.classList.remove('needs-attention', 'attention-flash');
        }
      } finally {
        if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
        tab.classList.remove('needs-attention', 'attention-flash');
        box.classList.remove('active');
        // The next render keeps this tab, so its easing comes back only once it
        // has settled on its resting fill: restored in the same style change, it
        // would ease from the alert to transparent under the next case's reading.
        void getComputedStyle(tab).backgroundColor;
        tab.style.removeProperty('transition');
      }
    });

    await check('the box holds a name and nothing to press', () => {
      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));

      assert(!header.querySelector('button'),
        'a title, a status line and two buttons in the width of a tab is the thing the panel exists to undo');

      /** @type {string[]} */
      const selected = [];
      bar._session.selectWorkspace = (/** @type {string} */ id) => { selected.push(id); return true; };
      // Measuring this click alone, whatever an earlier case left behind.
      bar.classList.remove('tab-list-focused');
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      assert(selected.join(',') === 'ws_a',
        `clicking it selects the workspace, which is how everything else about the place is reached, got ${JSON.stringify(selected)}`);

      assert(!bar.classList.contains('tab-list-focused'),
        'and does nothing else: a box is a thing in the list, not the bare bar behind it, so selecting one must not '
        + 'also put the keyboard in the strip — that left the box wearing a focus ring no clicked tab ever wears');
    });

    await check('the focus ring marks a keyboard arrival in the strip, never a click on its background', () => {
      const box = /** @type {HTMLElement} */ (
        bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      box.classList.add('active');
      /**
       * @param {string} how - Which way in is being read, for the message.
       * @returns {boolean} Whether the bar is set to ring its active entry.
       */
      const ringed = (how) => {
        // :focus-within needs the document to hold focus, which a headless page
        // may not; the class is what the ring's rule keys on either way.
        const rule = bar.classList.contains('tab-list-ring');
        if (bar.matches(':focus-within')) {
          assert((getComputedStyle(box).outlineStyle !== 'none') === rule,
            `${how}: the ring's paint follows its class, got outline ${getComputedStyle(box).outlineStyle}`);
        }
        return rule;
      };
      try {
        bar.classList.remove('tab-list-focused', 'tab-list-ring');
        bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        assert(bar.classList.contains('tab-list-focused'),
          'a click on the bare bar still puts the keyboard in the strip, so ↑/↓ switch tabs');
        assert(!ringed('after a click'),
          'but the active entry wears no ring: the pointer is already on the strip, and the ring only distracts');

        bar._exitTabListFocus();
        document.dispatchEvent(new CustomEvent('juggler:focus-tab-list'));
        assert(bar.classList.contains('tab-list-focused') && ringed('after ←'),
          'arriving by ← from the conversation is the one way in that leaves no other mark of where the keys went');

        bar._exitTabListFocus();
        assert(!bar.classList.contains('tab-list-ring'), 'and leaving the strip takes the ring with it');
      } finally {
        bar._exitTabListFocus();
        box.classList.remove('active');
      }
    });

    await check('a box names itself on its top edge, over the column of its tabs\' circles', async () => {
      // The name is a lozenge standing on the box's border, the way a
      // fieldset's legend does: the box needs no header row of its own, and the
      // border runs out from the name to the "+" on the other corner. It stands
      // over the column the circles of its tabs are in, so a box reads as one
      // more row of the strip's left edge rather than as a caption above it.
      bar._session = stubSession([workspace('ws_a', 'feature/auth')], [['c1', 'ws_a'], ['c3', '']]);
      bar.render();

      const box = /** @type {HTMLElement} */ (bar.querySelector('.conversation-box[data-workspace-id="ws_a"]'));
      const label = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-label'));
      const add = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-add'));
      const circle = /** @type {HTMLElement} */ (box.querySelector('.conversation-tab .conversation-tab-status'));
      const edge = box.getBoundingClientRect().top + 0.5;
      const middle = (/** @type {Element} */ el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };

      assert(Math.abs(middle(label) - edge) < 1,
        `the name stands on the box's top edge, got its middle ${middle(label)}px against the edge at ${edge}px`);
      assert(Math.abs(middle(add) - edge) < 1,
        `and so does the "+", got its middle ${middle(add)}px against the edge at ${edge}px`);
      assert(Math.abs(label.getBoundingClientRect().left - circle.getBoundingClientRect().left) < 0.5,
        `it starts over the box's column of status circles, got ${label.getBoundingClientRect().left}px `
        + `against ${circle.getBoundingClientRect().left}px`);
      assert(label.getBoundingClientRect().bottom <= /** @type {Element} */ (box.querySelector('.conversation-tab')).getBoundingClientRect().top,
        'and clears the first tab below it');
      assert(getComputedStyle(/** @type {Element} */ (box.querySelector('.conversation-tab'))).backgroundColor === 'rgba(0, 0, 0, 0)',
        'a tab in a box has no fill of its own: the box\'s surface is its surface');

      assert(label.classList.contains('item-lozenge'), 'the name is the shared lozenge');
      const probe = document.createElement('span');
      probe.style.background = 'var(--workspace-tint)';
      box.appendChild(probe);
      const tint = getComputedStyle(probe).backgroundColor;
      probe.remove();
      assert(getComputedStyle(label).backgroundColor === tint,
        `filled with the box's own tint, got ${getComputedStyle(label).backgroundColor} against ${tint}`);
      assert(getComputedStyle(label).color === 'rgb(255, 255, 255)', 'and lettered in white');

      // The fixture provider reports the tree dirty: the mark for it is a dot in
      // the name, not a colour beside it.
      await waitFor(() => /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header')).classList.contains('is-dirty'),
        { description: 'the header to hear the tree is dirty' });
      assert(getComputedStyle(label, '::after').content !== 'none',
        'uncommitted work is marked inside the name');
      assert(label.querySelector('.conversation-box-label-text')?.textContent === 'feature/auth',
        `and the name's text is its own element, so a long one ellipsises before the mark, got `
        + `${JSON.stringify(label.querySelector('.conversation-box-label-text')?.textContent)}`);
    });

    await check('the strip ends with a row that makes a box', () => {
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const outlines = menu.querySelectorAll('.conversation-box-new');
      assert(outlines.length === 1,
        `there is one way to make a workspace in the strip, got ${outlines.length}`);
      assert(menu.lastElementChild === outlines[0],
        'and it is the last thing in the list, under the boxes it makes');

      const button = /** @type {HTMLElement} */ (outlines[0].querySelector('button'));
      const fullLabel = button.querySelector('.conversation-box-new-label-full')?.textContent;
      assert(fullLabel === 'New workspace or group',
        `it says what it makes, in the words the boxes above it are named by, got ${JSON.stringify(fullLabel)}`);
      assert(button.getAttribute('aria-label') === 'New workspace or group',
        'and is called that whichever form of the words a narrow strip shows');

      // A mark and a label, read as one phrase. The mark is drawn, not spelled:
      // a "+" in the text would be read out as one.
      const mark = /** @type {SVGElement} */ (button.querySelector('svg'));
      assert(mark?.getAttribute('aria-hidden') === 'true',
        'the mark is decoration beside the words, not part of what the button is called');
      const boxLabel = button.querySelector('.conversation-box-new-label');
      assert(button.firstElementChild === mark && !!boxLabel?.contains(button.querySelector('.conversation-box-new-label-full')),
        'it leads with the mark and follows with the label');

      // It is not one of the things the strip is a list of: a drag looks for
      // tabs and boxes, and this row is neither.
      const outline = /** @type {HTMLElement} */ (outlines[0]);
      const isTab = outline.classList.contains('conversation-tab');
      const isBox = outline.classList.contains('conversation-box');
      assert(!isTab && !isBox,
        'and is neither a tab nor a box, so nothing that walks either finds it');

      // The "+" is untouched by its arrival: two ways to make two different
      // things, and the one that makes a conversation stays where it was.
      assert(menu.firstElementChild?.classList.contains('conversation-add-item'),
        'the "+" still opens the list, making the commoner thing');

      /** @type {number} */
      let asked = 0;
      bar._createWorkspace = async () => { asked++; };
      button.click();
      assert(asked === 1,
        `pressing it asks what kind to make, got ${asked} call(s)`);
    });

    await check('the workspace row survives a render, and stays last', () => {
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const before = menu.querySelector('.conversation-box-new');
      bar.render();
      const after = menu.querySelector('.conversation-box-new');
      assert(before === after,
        'it is the same element across a render, like every other piece of the strip\'s chrome');
      assert(menu.querySelectorAll('.conversation-box-new').length === 1,
        'and there is still one of it');
      assert(menu.lastElementChild === after,
        'still at the end, after the pass that puts the boxes in order');
    });

    await check('both ways to make something stand aside for a drag, and come back after it', () => {
      // Neither end of the strip is a place a tab can land, so while one is in
      // the air both are only in the way. The workspace row is the last, so a tab
      // dragged to the foot of the bar has to be let go over something that will
      // not take it, and the drag's own placeholder ends up below it. The "+" is
      // the row the pointer crosses on the way there, and a pointer the gesture
      // has captured never tells it that it left — so a hover taken in passing
      // is a hover it keeps once the drag is over. One mark, both rows.
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const outline = /** @type {HTMLElement} */ (menu.querySelector('.conversation-box-new'));
      const plus = /** @type {HTMLElement} */ (menu.querySelector('.conversation-add-item'));
      /**
       * @param {HTMLElement} row - One of the two.
       * @returns {boolean} Whether it is standing aside.
       */
      const aside = (row) => row.classList.contains('stands-aside');

      /**
       * Take hold of something, move far enough for it to mean a drag, then
       * abandon the gesture — which lands nothing and writes nothing, so the
       * only thing left to read is what the drag itself did to the strip.
       * @param {HTMLElement} grip - What the pointer goes down on.
       * @param {(press: any) => void} start - The gesture to start with it.
       * @returns {boolean} Whether both rows stood aside mid-drag.
       */
      const duringDrag = (grip, start) => {
        /** @type {any} */ (grip).setPointerCapture = () => {};
        /** @type {any} */ (grip).releasePointerCapture = () => {};
        const from = grip.getBoundingClientRect();
        const x = from.left + 4;
        start({ clientX: x, clientY: from.top + from.height / 2, pointerId: 7 });
        document.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 7, buttons: 1, pointerType: 'touch',
          clientX: x, clientY: from.top + 60, bubbles: true
        }));
        const mid = aside(outline) && aside(plus);
        document.dispatchEvent(new PointerEvent('pointercancel', {
          pointerId: 7, pointerType: 'touch', bubbles: true
        }));
        return mid;
      };

      assert(!aside(outline) && !aside(plus), 'both rows are in the strip before anything is picked up');

      const tab = /** @type {HTMLElement} */ (menu.querySelector('.conversation-tab'));
      assert(duringDrag(tab, (press) => bar._startDrag(press, tab)),
        'a tab is dragged about a strip of places it can land, and neither the "+" nor the row that makes a '
        + 'box is one of them — so neither is in the way while one is in the air');
      assert(!aside(outline) && !aside(plus),
        'and both are back as soon as the gesture is over, abandoned or not');

      const box = /** @type {HTMLElement} */ (menu.querySelector('.conversation-box'));
      const header = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-header'));
      assert(duringDrag(header, (press) => bar._startBoxDrag(press, box)),
        'and the same while a whole box is being dragged past them');
      assert(!aside(outline) && !aside(plus), 'and back again after that one too');
    });

    await check('standing aside is a fade, and only the last row gives up its space', () => {
      // What the mark means, read with the transition suppressed: a test can be
      // running in a hidden WebView, where nothing is painted and no transition
      // ever advances, so the fade's end state is asked for directly.
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      const outline = /** @type {HTMLElement} */ (menu.querySelector('.conversation-box-new'));
      const plus = /** @type {HTMLElement} */ (menu.querySelector('.conversation-add-item'));

      for (const row of [outline, plus]) {
        assert(getComputedStyle(row).transitionProperty.includes('opacity'),
          'a row that left between two frames would read as the strip losing a row rather than as one '
          + 'getting out of the way, so both fade');
        row.style.transition = 'none';
        row.classList.add('stands-aside');
      }

      try {
        assert(Number(getComputedStyle(plus).opacity) === 0
          && Number(getComputedStyle(outline).opacity) === 0, 'and end the fade invisible');
        assert(getComputedStyle(plus).pointerEvents === 'none',
          'the "+" is out of the pointer\'s reach while it is aside, which is what keeps a tab dragged '
          + 'across it from leaving it lit');

        assert(getComputedStyle(outline).display === 'none',
          'the workspace row leaves the layout, so a drop past the last tab does not land a placeholder below '
          + 'a row that is still taking up the foot of the strip');
        assert(plus.getBoundingClientRect().height > 0,
          'the "+" keeps its space — it is the first row, and every tab below it would jump the moment '
          + 'a drag began');
      } finally {
        for (const row of [outline, plus]) {
          row.classList.remove('stands-aside');
          row.style.transition = '';
        }
      }
    });

    await check('a conversation started in a box is born bound to that workspace', async () => {
      /** @type {any[]} */
      const created = [];
      bar._session.createConversation = async (/** @type {any} */ name, /** @type {any} */ options) => {
        created.push({ name, options });
        return 'conv_new';
      };
      bar._lastCreateAt = 0;

      // The workspace panel's "New conversation in this workspace" asks the strip rather
      // than doing it, so the debounce and the conversation cap stay one set of
      // rules however many places carry the button.
      document.dispatchEvent(new CustomEvent('juggler:new-conversation-in-workspace', {
        detail: { workspaceId: 'ws_a' }
      }));
      await waitFor(() => created.length === 1, { description: 'the create to be asked for' });

      assert(created[0].options.workspaceId === 'ws_a',
        `it is born working where the box is, got ${JSON.stringify(created[0].options)}`);
      assert(created[0].options.origin === 'workspace-box',
        `attributed to the box it was started from, got ${JSON.stringify(created[0].options.origin)}`);
    });

    await check('the ending is carried out for the conversation you came from, or for nobody', () => {
      const session = stubSession(
        [workspace('ws_a', 'feature/auth')],
        [['c1', 'ws_a'], ['c2', 'ws_a'], ['c3', '']]
      );
      const ws = session.workspaces[0];

      // An ending is nearly always chosen from the workspace's own panel, by
      // which point no conversation is on screen — so the actor is the one the
      // panel was opened over.
      session.loadedConversationId = 'c2';
      assert(workspaceFinishActor(session, ws)?.id === 'c2',
        'the conversation the panel was opened over is the one an ending is being done for');

      session.loadedConversationId = 'c3';
      assert(workspaceFinishActor(session, ws) === null,
        'but not when it works somewhere else, and two candidates name neither: a message nobody asked for '
        + 'must not land in whichever tab happened to be first');

      session.conversations.delete('c2');
      assert(workspaceFinishActor(session, ws)?.id === 'c1',
        'with one conversation working here, it is unambiguous');

      session.conversations.delete('c1');
      assert(workspaceFinishActor(session, ws) === null,
        'and an empty box has nobody to name, which every provider already handles');
    });

    await check('a rebound conversation moves between boxes', () => {
      bar._session = stubSession(
        [workspace('ws_a', 'feature/auth'), workspace('ws_b', 'scratch-2')],
        [['c1', 'ws_a'], ['c2', 'ws_b']]
      );
      bar.render();

      const tab = bar.querySelector('.conversation-tab[data-conversation-id="c2"]');
      bar._session.conversations.get('c2').workspaceId = 'ws_a';
      bar.render();

      assert(strip(bar) === 'ws_a{c1,c2} ws_b{}',
        `it is drawn where it now works, and the box it left stays, got "${strip(bar)}"`);
      assert(bar.querySelector('.conversation-tab[data-conversation-id="c2"]') === tab,
        'the tab itself is the same element — a conversation that moved tree did not lose its tab');
    });

    await check('a conversation created in a box appears inside it, and moves nothing', () => {
      // The create, in the order the session does it: ask where the new tab
      // goes, build it, put it there. It is one transaction, and the strip it
      // leaves differs by the new tab and by nothing else — a workspace is a
      // place, and work starting in one is no reason for it to travel the
      // sidebar. What breaks that is the box being drawn from a binding the
      // conversation does not carry yet: it is drawn twice before the create
      // returns, and a box read as one member short moves both times.
      bar._session = stubSession(
        [workspace('ws_b', 'feature/pay')],
        [['c1', ''], ['c2', 'ws_b'], ['c3', '']]
      );
      bar.render();
      assert(strip(bar) === 'c1 ws_b{c2} c3',
        `the box starts with a conversation above it and one below, got "${strip(bar)}"`);

      const created = createdConversation('c4', 'ws_b');
      assert(created.workspaceId === 'ws_b',
        'a conversation built for a workspace says so from the moment it exists — its tab is drawn from this, '
        + `and drawn before the create has finished, got ${JSON.stringify(created.workspaceId)}`);

      placeAt(bar._session, placeForNewConversation(bar._session, 'ws_b'), created);
      bar.render();

      assert(strip(bar) === 'c1 ws_b{c4,c2} c3',
        `it goes to the top of its own box, and the box stays where it was, got "${strip(bar)}"`);
    });

    await check('the first conversation in an empty box does not drag the box up the strip', () => {
      // The same transaction against the other shape: a row with no place of
      // its own, drawn past everything for want of a member to fall back to.
      // Its first conversation belongs there too.
      bar._session = stubSession(
        [workspace('ws_c', 'scratch-3')],
        [['c1', ''], ['c2', '']]
      );
      bar.render();
      assert(strip(bar) === 'c1 c2 ws_c{}',
        `an empty box with nothing to fall back to is drawn after the conversations, got "${strip(bar)}"`);

      const created = createdConversation('c4', 'ws_c');
      placeAt(bar._session, placeForNewConversation(bar._session, 'ws_c'), created);
      bar.render();

      assert(strip(bar) === 'c1 c2 ws_c{c4}',
        `the box gains its first member without moving, and the project's tabs stay above it, got "${strip(bar)}"`);
    });

    await check('the order the server keeps is the order the tab was put in', () => {
      // Placing the tab locally is only half of a create: the server stores an
      // order of its own and broadcasts it, and refreshFromServer re-slots the
      // map into that order — so the server's answer is the one that survives,
      // and the one a restart reads back. Told nothing, it puts a new
      // conversation at the head of the bar, which takes the box it belongs to
      // up there with it. So the create carries the place with it.
      bar._session = stubSession(
        [workspace('ws_b', 'feature/pay')],
        [['c1', ''], ['c2', 'ws_b'], ['c3', '']]
      );
      bar.render();

      const created = createdConversation('c4', 'ws_b');
      const { where, after } = placementForNewConversation(bar._session, 'ws_b');
      assert(where === 'after' && after === 'c1',
        `the new conversation is to follow the tab above its box, got ${JSON.stringify({ where, after })}`);

      placeAt(bar._session, placeForNewConversation(bar._session, 'ws_b'), created);
      const existing = [...bar._session.conversations.keys()].filter(id => id !== created.id);
      reslotToServerOrder(bar._session, serverOrderForCreate(existing, created.id, { where, after }));
      bar.render();

      assert(strip(bar) === 'c1 ws_b{c4,c2} c3',
        `the strip the server's own order draws is the one the create drew, got "${strip(bar)}"`);
    });

    await check('a box drawn past everything says the end, rather than naming a tab', () => {
      // A row with no place of its own falls back to being drawn past every
      // conversation there is. "The end" is then what the create has to say:
      // naming the last tab this window holds is a different request, and one
      // the server answers against an order that may run further.
      bar._session = stubSession(
        [workspace('ws_c', 'scratch-3')],
        [['c1', ''], ['c2', '']]
      );
      bar.render();

      const created = createdConversation('c4', 'ws_c');
      const placement = placementForNewConversation(bar._session, 'ws_c');
      assert(placement.where === 'end' && placement.after === '',
        `the end of the bar is said as itself and needs no id, got ${JSON.stringify(placement)}`);

      placeAt(bar._session, placeForNewConversation(bar._session, 'ws_c'), created);
      reslotToServerOrder(bar._session, serverOrderForCreate(['c1', 'c2', 'c9'], created.id, placement));
      bar.render();

      assert(strip(bar) === 'c1 c2 ws_c{c4}',
        `so it lands past the conversation this window never loaded, not in front of it, got "${strip(bar)}"`);
    });

    await check('a box keeps its place when the server knows more tabs than this window', () => {
      // The client's tab list is not the server's: the order counts
      // conversations this window has never loaded, and a load can fail. A box
      // drawn in the middle of the strip has to still be there after the
      // create, and the only thing that survives the round trip is the
      // neighbour its own row names.
      bar._session = stubSession(
        [workspace('ws_c', 'scratch-3', { place: 'c1' })],
        [['c1', ''], ['c2', '']]
      );
      bar.render();
      assert(strip(bar) === 'c1 ws_c{} c2',
        `an empty box sits where its row says, which is behind c1, got "${strip(bar)}"`);

      const created = createdConversation('c4', 'ws_c');
      const placement = placementForNewConversation(bar._session, 'ws_c');
      assert(placement.where === 'after' && placement.after === 'c1',
        `its first conversation follows the conversation the box is anchored to, got ${JSON.stringify(placement)}`);

      placeAt(bar._session, placeForNewConversation(bar._session, 'ws_c'), created);
      // The server's order carries a conversation this window does not hold —
      // the case that "follow whichever tab I have last" gets wrong.
      reslotToServerOrder(bar._session, serverOrderForCreate(['c1', 'c2', 'c9'], created.id, placement));
      bar.render();

      assert(strip(bar) === 'c1 ws_c{c4} c2',
        `and it is still behind c1 once the server's own order comes back, got "${strip(bar)}"`);
    });

    await check('a conversation that belongs at the head still goes to the head', () => {
      // The anchor is where the box is, not a rule about boxes: the "+" at the
      // top of the strip makes a conversation of the project's, which belongs
      // at the head of the bar and is told to go there by having no anchor at
      // all. Same for a box already sitting at the top — there is nothing above
      // it to follow.
      bar._session = stubSession(
        [workspace('ws_d', 'feature/top')],
        [['c1', 'ws_d'], ['c2', '']]
      );
      bar.render();

      assert(placementForNewConversation(bar._session, '').where === 'head',
        'a conversation with no workspace goes to the head of the bar, as it always has');
      assert(placementForNewConversation(bar._session, 'ws_d').where === 'head',
        'and so does one born into the box that is already there');
      assert(placementForNewConversation(bar._session, 'ws_gone').where === 'head',
        'a workspace nobody can work in has no box to go to the top of, so its conversations go where the rest do');
    });

    await check('every box carries the colour its workspace is known by', () => {
      // Boxes are the same shape and near enough the same size, and the names
      // in them are branches that ellipsise. The hue is what is read first, so
      // it has to be on the element the frame is drawn from.
      bar._session = stubSession(
        [workspace('ws_one', 'feature/one'), workspace('ws_two', 'feature/two')],
        [['c1', 'ws_one'], ['c2', 'ws_two']]
      );
      bar.render();

      const tintOf = (/** @type {string} */ id) => /** @type {HTMLElement} */ (
        bar.querySelector(`.conversation-box[data-workspace-id="${id}"]`)).style.getPropertyValue('--workspace-tint');

      assert(/^var\(--workspace-tint-[1-8]\)$/.test(tintOf('ws_one')),
        `a box names one of the theme's tints rather than a colour of its own, got "${tintOf('ws_one')}"`);
      assert(tintOf('ws_one') !== tintOf('ws_two'),
        `and these two ids land on different ones, which is the whole point of drawing them, got "${tintOf('ws_one')}" twice`);

      const first = tintOf('ws_one');
      bar.render();
      assert(tintOf('ws_one') === first,
        `the colour is derived from the id and nothing else, so a redraw cannot change it, got "${tintOf('ws_one')}" after "${first}"`);
    });

    await check('the eight workspace tints are the panel\'s own presets', () => {
      // One palette for the chips and the item circles: a workspace's tint is
      // a preset fill, so the two read as one set and a theme change moves both.
      const presets = ['blue', 'teal', 'indigo', 'slate', 'brown', 'magenta', 'pink', 'purple'];
      const fill = (/** @type {string} */ css, /** @type {string} */ className = '') => {
        const probe = document.createElement('span');
        probe.className = className;
        if (css) probe.style.background = css;
        container.appendChild(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      };
      presets.forEach((preset, i) => {
        const tint = fill(`var(--workspace-tint-${i + 1})`);
        const circle = fill('', `message-icon-box color-${preset}`);
        assert(tint === circle,
          `--workspace-tint-${i + 1} is the ${preset} preset, got ${tint} against ${circle}`);
      });
    });
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
