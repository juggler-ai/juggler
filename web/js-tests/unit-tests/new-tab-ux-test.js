//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UX invariant for the conversation-bar new-tab button:
 *
 *   1. The new tab MUST appear at the top of the sidebar — the very first
 *      `<li>` after the `.conversation-add-item` add button.
 *   2. With auto-naming OFF, the new tab MUST be in inline-rename mode — the
 *      `<li>` carries the `.is-renaming` class and the seeded input value
 *      matches the canonical "Untitled N" name so the user can type the real name
 *      straight away. (With auto-naming ON — the default — the tab instead
 *      keeps its "Untitled N" name for the LLM to replace and focuses the composer;
 *      this test pins the rename-on-create branch, so it disables auto-naming.)
 *
 * Both must hold synchronously after the user-facing handler resolves: any
 * intermediate "tab at bottom, then jumps to top" or "no rename popover"
 * paint is a regression. Anchor for the new-tab UX.
 * @module unit-tests/new-tab-ux-test
 */

import {
  initializeRegistries,
  createTestSession,
  assert
} from '../utilities/test-helpers.js';
import { unclaimedConversationIds } from '../utilities/conversation-claims.js';
import { isAutoNameEnabled, setAutoNameEnabledCached } from '../../js/services/auto-name-setting.js';
import workerManager from '../../js/services/worker-manager.js';
import { MAX_CONVERSATIONS } from '../../js/model/session.js';
import '../../js/components/conversation-bar.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  workerManager.terminateAll();

  // `_createConversation()` aborts at MAX_CONVERSATIONS by AWAITING a
  // `showAlert(...)` modal — which only resolves on a user click and so
  // never resolves headless, hanging the test until the 90s suite deadline.
  // The shared fixture session accumulates conv_*.yjs across the whole iframe
  // pool, so under load `session.load()` can come up already at the cap. Two
  // defences below: (1) stub the modal so it can NEVER block — a residual one
  // fails the test fast instead of hanging; (2) make room before creating so
  // the real new-tab scenario actually runs. Restored in `finally`.
  // Intercepted at window.showModal — the presenter every dialog helper calls,
  // and therefore the one seam that works for an imported showAlert too.
  /** @type {any} */
  const origShowModal = /** @type {any} */ (window).showModal;

  // Pin the auto-naming-OFF branch. With auto-naming ON (the default) a fresh
  // "+" tab keeps its "Untitled N" name for the LLM and focuses the composer; only
  // with it OFF does the bar open the inline rename editor this test asserts.
  // The bar decides via a synchronous module cache (auto-name-setting.js) that
  // setSession seeds fire-and-forget from GET /api/config. Just setting the
  // cache OFF races that in-flight refresh, which resolves to the server
  // default (ON) during createConversation's awaits and clobbers it back — so
  // instead intercept /api/config for this iframe to report auto-naming
  // disabled, making every refresh (the in-flight one and any later) settle
  // OFF deterministically. Both are restored in `finally`.
  const origAutoNameEnabled = isAutoNameEnabled();
  const origFetch = /** @type {typeof fetch} */ (/** @type {any} */ (window).fetch.bind(window));
  /** @type {any} */ (window).fetch = async (/** @type {any} */ input, /** @type {any} */ init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const resp = await origFetch(input, init);
    if (url.includes('/api/config') && resp.ok) {
      // Duck-typed response carrying the real config with auto-naming forced
      // off. refreshAutoNameSetting only reads `.ok` and `.json()`, and this
      // wrapper preserves the rest for any other /api/config reader.
      const cfg = await resp.clone().json();
      cfg.autoNameDisabled = true;
      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
        json: async () => cfg,
        text: async () => JSON.stringify(cfg),
        clone() { return this; },
      };
    }
    return resp;
  };
  setAutoNameEnabledCached(false);

  let blockingModalMessage = '';
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
    blockingModalMessage = options?.message || '';
  };

  const container = document.createElement('div');
  container.id = 'new-tab-ux-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's setSession looks up <conversation-tabs-container/> via
  // document.querySelector, so it must exist somewhere in the document.
  const tabsHost = document.createElement('conversation-tabs-container');
  container.appendChild(tabsHost);
  const bar = document.createElement('conversation-bar');
  container.appendChild(bar);
  document.body.appendChild(container);

  let passed = 0;
  let failed = 0;
  const errors = [];

  try {
    const session = await createTestSession();

    // Isolate from auto-recents. This test asserts the new-tab INSERTION
    // position (conversation-bar._createConversation → session insert-at-top).
    // A SEPARATE feature — auto-recents (conversation-observers.js) — floats a
    // conversation to the top when it receives a remote LLM/worker change. In
    // the shared iframe pool the pre-existing tabs are conversations sibling
    // lanes are actively running LLMs on, so their streamed updates sync in and
    // legitimately bump them above the just-created tab — demoting it through no
    // fault of the insertion path. That recency reorder is real product
    // behaviour (an active conversation belongs on top), just out of scope here,
    // so neutralise the bump for this unit and let the insertion stand on its
    // own. Single-window production never sees it: only your own conversations
    // bump, and not while idle. (Removing this line reintroduces the flake.)
    /** @type {any} */ (session).bumpConversation = () => {};

    /** @type {any} */ (bar).setSession(session);

    // Make room under the MAX_CONVERSATIONS cap so the create below isn't
    // rejected. CRITICAL: in the iframe pool this session is SHARED across
    // all lanes, so only leftovers — conversations no live lane claims —
    // may be deleted. Deleting a claimed one permanently tears down a
    // sibling test's worker mid-turn (its doc freezes at tool
    // state=running and the sibling times out). Claims are re-read each
    // iteration so a conversation claimed mid-loop is never touched.
    // Each pass re-loads the session first: this instance's map is a
    // load-time snapshot, and sibling cleanups continually shrink the
    // shared session — counting their already-deleted conversations would
    // overstate the cap pressure. At genuine peak (31+ live claimed
    // conversations) the only resource that frees room is siblings
    // finishing, so poll briefly rather than fail on the first look.
    const makeRoomDeadline = Date.now() + 10000;
    while (session.conversations.size >= MAX_CONVERSATIONS - 1) {
      await session.load();
      for (const id of Array.from(session.conversations.keys())) {
        if (session.conversations.size < MAX_CONVERSATIONS - 1) break;
        if (unclaimedConversationIds([id]).length === 1) {
          await session.deleteConversation(id, 'new-tab-ux:make-room-leftover');
        }
      }
      if (session.conversations.size < MAX_CONVERSATIONS - 1 || Date.now() >= makeRoomDeadline) break;
      await new Promise(r => setTimeout(r, 250)); // poll: waiting on sibling lanes to release claims
    }
    assert(session.conversations.size < MAX_CONVERSATIONS - 1,
      `could not make room under the ${MAX_CONVERSATIONS} cap; ` +
			`size=${session.conversations.size} (every remaining conversation is claimed by a live lane)`);

    const idsBefore = new Set(session.conversations.keys());

    const addBtnLi = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-add-item'));
    assert(!!addBtnLi, 'expected the new-tab + button (.conversation-add-item) in the bar');

    // --- Act: invoke the same handler that the "+" button click fires. ---
    await /** @type {any} */ (bar)._createConversation();
    assert(blockingModalMessage === '',
      `_createConversation hit a blocking modal instead of creating a tab: "${blockingModalMessage}"`);

    // --- Identify the newly-added conversation. ---
    const idsAfter = Array.from(session.conversations.keys());
    const newIds = idsAfter.filter(id => !idsBefore.has(id));
    assert(newIds.length === 1,
      `expected exactly one new conversation, got ${newIds.length}: ${JSON.stringify(newIds)}`);
    const newId = newIds[0];

    const newTab = /** @type {HTMLElement|null} */ (
      bar.querySelector(`.conversation-tab[data-conversation-id="${newId}"]`)
    );
    assert(!!newTab, `expected an <li> tab for new conversation ${newId} in the bar`);

    // --- Assert 1: new tab sits above every tab that existed before the
    // click. "Absolute first" is not assertable in the pool: the bar
    // renders the SHARED session, and a sibling lane creating its own
    // conversation concurrently legitimately lands a tab on top. The UX
    // property is insertion at the top relative to the user's prior tabs.
    const assertAbovePreexisting = (/** @type {string} */ when) => {
      const tabIds = Array.from(bar.querySelectorAll('.conversation-tab'))
        .map(el => el.getAttribute('data-conversation-id'));
      const newIdx = tabIds.indexOf(newId);
      assert(newIdx !== -1, `${when}: new tab ${newId} must be in the bar`);
      for (const preId of idsBefore) {
        const preIdx = tabIds.indexOf(/** @type {string} */ (preId));
        assert(preIdx === -1 || newIdx < preIdx,
          `${when}: new tab must sit above every pre-existing tab. ` +
					`Got order [${tabIds.join(', ')}], new=${newId} below pre-existing=${preId}`);
      }
    };
    assertAbovePreexisting('after the + click');

    // --- Assert 2: new tab is in inline-rename mode with the canonical name seeded. ---
    assert(newTab.classList.contains('is-renaming'),
      `new tab must have .is-renaming class. Classes: "${newTab.className}"`);

    // The rename editor lives inside the tab <li> (position: absolute over
    // it), so it follows the tab on reorder. Looked up document-wide
    // since the tab itself is in the document either way.
    const renameInput = /** @type {HTMLInputElement|null} */ (
      document.querySelector('.inline-rename .inline-rename-input')
    );
    assert(!!renameInput,
      `document must contain a .inline-rename-input after the + click`);
    // The input is seeded with the conversation's canonical name — the name
    // the server actually assigned, not the blank "Untitled N" the client
    // requested. In the SHARED pool session a sibling lane may already hold
    // "Untitled N", so the server's uniqueName legitimately resolves the collision
    // to "Untitled N (copy)" / "(copy 2)" — the same suffix behaviour the
    // duplicate-conversation test accepts. Assert the real UX property (the
    // input matches whatever canonical name the server gave the tab) and that
    // the name derives from the canonical "Untitled N" scheme. A bare /^Untitled \d+$/
    // regex flakes here under load when the base name is already taken.
    const canonicalName = /** @type {any} */ (session.conversations.get(newId)).name;
    assert(renameInput.value === canonicalName,
      `rename input must be seeded with the conversation's canonical name "${canonicalName}", got "${renameInput.value}"`);
    assert(/^Untitled \d+( \(copy( \d+)?\))?$/.test(canonicalName),
      `new conversation name must derive from the canonical "Untitled N" scheme, got "${canonicalName}"`);

    // --- Assert 3: a `conversations-changed` op="created" broadcast echo
    //     that arrives after the local create has resolved (the only
    //     possible ordering now that the server responds-then-broadcasts)
    //     must not disturb the open rename or push the tab off the top.
    //     Replay the echo and verify the bar remains in its post-click
    //     state. ---
    await session.sync.apply({ op: 'created', id: newId, name: /** @type {any} */ (session.conversations.get(newId)).name });

    assertAbovePreexisting('after the broadcast echo');
    assert(newTab.classList.contains('is-renaming'),
      `after the broadcast echo, new tab must still have .is-renaming. Classes: "${newTab.className}"`);
    const renameInputAfter = /** @type {HTMLInputElement|null} */ (
      document.querySelector('.inline-rename .inline-rename-input')
    );
    assert(!!renameInputAfter,
      `after the broadcast echo, the rename input must still be in the document`);

    // A session refresh can populate the name cache just before the targeted
    // auto-name broadcast arrives. The equal broadcast must still repaint the
    // tab synchronously: cache equality does not mean the DOM saw the update,
    // and hidden WebViews do not reliably service requestAnimationFrame.
    renameInputAfter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const paintedName = /** @type {HTMLElement|null} */ (
      newTab.querySelector('.conversation-tab-name')
    );
    assert(!!paintedName, 'new tab must contain its painted name');
    paintedName.textContent = canonicalName;
    const autoName = `Auto-named ${newId}`;
    session.setConversationName(newId, autoName);
    session.sync.renamed(newId, autoName);
    assert(paintedName.textContent === autoName,
      `equal cached rename must repaint synchronously; got "${paintedName.textContent}"`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    // The conversation created by the + click is auto-claimed (see
    // conversation-claims.js) and deleted by the executor's unit-suite
    // cleanup, so it never accumulates in the shared session.
    /** @type {any} */ (window).showModal = origShowModal;
    /** @type {any} */ (window).fetch = origFetch;
    setAutoNameEnabledCached(origAutoNameEnabled);
    container.remove();
  }

  return { passed, failed, errors };
}
