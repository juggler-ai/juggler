//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI preference store unit test.
 *
 * services/prefs.js keeps a preference in one of six realms. Three of them are
 * server-side, because localStorage is partitioned by origin and a window's
 * origin is its port — which is not stable per project, so a relaunch onto
 * another port hands the window an empty store and every setting appears to have
 * reverted. What makes those three usable at render time is the rule this pins:
 * localStorage is a warm cache written on every set, the realm is the truth, and
 * a reader takes the cache now and reconciles when the realm answers.
 *
 * Also pinned here: which store wins for a desktop window and which for a remote
 * browser (a phone must not redecorate the desktop it dialled into), that a
 * value left behind in localStorage by an older build is adopted and promoted
 * exactly once, that a drag's worth of writes makes ONE request, and that a
 * remote viewer's refused write still leaves it its own copy.
 *
 * The machine realm shares the user realm's document but not its ranking: a
 * remote viewer's sound or Escape key is its own, and is never written back.
 *
 * The user realm has a second rule of its own: settings.json is one file for
 * every project's server, so a change made in another window has to reach a
 * window that read the document once at boot — without refetching it, and without
 * overtaking a write that is still on its way out.
 * @module unit-tests/prefs-test
 */

import { waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const prefs = await import('../../js/services/prefs.js');
  const {
    scopedKey, resolvePref,
    getDevicePref, setDevicePref,
    getWindowPref, setWindowPref, cachedWindowPref,
    getUserPref, setUserPref, cachedUserPref,
    adoptGlobalSettings,
    __resetPrefsForTests,
  } = prefs;

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  // A name no other lane uses: localStorage is shared by every document on the
  // origin, and these tests write to it.
  let seq = 0;
  const uniqueName = () => `juggler-test-pref-${Date.now().toString(36)}-${seq++}`;

  /** @type {Array<{url: string, method: string, body: any}>} */
  let calls = [];
  /** @type {(url: string, method: string) => {status: number, body: any}} */
  let respond = () => ({ status: 200, body: { ui: {} } });
  const realFetch = window.fetch;

  /**
   * Stand in for the server so the realms answer deterministically and nothing
   * a lane does reaches the session other lanes are sharing.
   * @param {any} url
   * @param {any} init
   * @returns {Promise<any>} The stubbed response: what services/http.js reads.
   */
  const stubFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const answer = respond(String(url), method);
    const text = JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: '',
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  const originalProjectKey = window.__projectKey;
  const originalWindowMode = document.documentElement.dataset.windowMode;
  const originalRemoteViewer = document.documentElement.dataset.remoteViewer;

  /**
   * Start each case from nothing: a fresh module cache, no recorded calls, and
   * a named client (desktop windows and remote browsers rank the realms
   * differently, so every case has to say which it is).
   * @param {boolean} desktop - A native desktop window rather than a browser tab.
   * @param {boolean} [remote] - Viewing a server on another machine.
   */
  const reset = (desktop = true, remote = !desktop) => {
    __resetPrefsForTests();
    calls = [];
    respond = () => ({ status: 200, body: { ui: {} } });
    if (desktop) document.documentElement.dataset.windowMode = '1';
    else delete document.documentElement.dataset.windowMode;
    if (remote) document.documentElement.dataset.remoteViewer = '1';
    else delete document.documentElement.dataset.remoteViewer;
  };

  try {
    window.fetch = stubFetch;
    window.__projectKey = 'testproject';

    // --- the scoping rule -------------------------------------------------

    await run('scopedKey namespaces by project', () => {
      window.__projectKey = 'abc123';
      eq(scopedKey('juggler-column-width'), 'juggler-column-width:abc123', 'scoped key');
    });

    await run('scopedKey separates two projects', () => {
      window.__projectKey = 'aaa';
      const first = scopedKey('juggler-column-width');
      window.__projectKey = 'bbb';
      if (first === scopedKey('juggler-column-width')) {
        throw new Error('two projects produced the same key, so their widths would collide');
      }
    });

    await run('scopedKey falls back to the bare key with no project', () => {
      window.__projectKey = '';
      eq(scopedKey('juggler-column-width'), 'juggler-column-width', 'no-project key');
    });

    await run('desktop takes the server realm first, remote its own device', () => {
      eq(resolvePref({ desktop: true, session: 130, device: 90, windowScoped: [70], fallback: 110 }),
        130, 'desktop resolved value');
      eq(resolvePref({ desktop: true, session: null, device: 90, windowScoped: [70], fallback: 110 }),
        70, 'seed outranks device on desktop');
      // The regression the rule exists for: zooming out on a phone must not come
      // home and shrink the desktop window it dialled into.
      eq(resolvePref({ desktop: false, session: 130, device: 70, fallback: 110 }),
        70, 'remote resolved value');
      eq(resolvePref({ desktop: false, session: 130, device: null, fallback: 110 }),
        130, 'a remote device with nothing of its own still starts from the project');
      eq(resolvePref({ desktop: false, session: null, device: null, fallback: 110 }),
        110, 'stock default');
      eq(resolvePref({ desktop: true, session: undefined, device: 90, fallback: 110 }),
        90, 'undefined is skipped like null');
    });

    window.__projectKey = 'testproject';

    // --- the synchronous realms -------------------------------------------

    await run('a device preference round-trips and is scoped', () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 42);
      eq(getDevicePref(name, null), 42, 'stored');
      eq(localStorage.getItem(scopedKey(name)), '42', 'stored under the scoped key');
    });

    await run('a corrupt stored value reads as the default', () => {
      reset();
      const name = uniqueName();
      localStorage.setItem(scopedKey(name), '{not json');
      eq(getDevicePref(name, 'fallback'), 'fallback', 'corrupt value');
    });

    // --- the asynchronous realms ------------------------------------------

    await run('a window preference is written to the cache at once and to the realm after', async () => {
      reset();
      const name = uniqueName();
      const done = setWindowPref(name, 31.5);
      // Synchronously, before the request has been made: this is what a render
      // reads, and why an async realm does not cost a flash of the default.
      eq(cachedWindowPref(name, null), 31.5, 'cached immediately');
      await done;
      const put = calls.filter((c) => c.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(put[0].body, { ui: { [name]: 31.5 } }, 'PUT body');
      if (!put[0].url.startsWith('/api/session/ui-prefs')) {
        throw new Error(`PUT went to ${put[0].url}`);
      }
    });

    await run('a burst of writes makes one request carrying the last value', async () => {
      reset();
      const name = uniqueName();
      setWindowPref(name, 20);
      setWindowPref(name, 30);
      await setWindowPref(name, 40);
      const put = calls.filter((c) => c.method === 'PUT');
      eq(put.length, 1, 'one PUT for a drag');
      eq(put[0].body, { ui: { [name]: 40 } }, 'the last value');
      eq(cachedWindowPref(name, null), 40, 'cache holds the last value');
    });

    await run('the realm outranks the cache in a desktop window', async () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 'stale');
      respond = () => ({ status: 200, body: { ui: { [name]: 'fresh' } } });
      eq(await getWindowPref(name, null), 'fresh', 'resolved value');
      eq(cachedWindowPref(name, null), 'fresh', 'cache reconciled to the realm');
    });

    await run('a remote viewer keeps its own value over the desktop\u2019s', async () => {
      reset(false);
      const name = uniqueName();
      setWindowPref(name, 'mine');
      respond = () => ({ status: 200, body: { ui: { [name]: 'the desktop\u2019s' } } });
      eq(await getWindowPref(name, null), 'mine', 'remote resolved value');
    });

    await run('a value left by an older build is adopted and promoted once', async () => {
      reset();
      const name = uniqueName();
      // How every one of these preferences is stored before this change: one
      // unscoped localStorage key, with nothing in the realm.
      localStorage.setItem(name, JSON.stringify('inherited'));
      eq(await getWindowPref(name, null), 'inherited', 'adopted');
      // The promotion rides the ordinary write queue, so it is on its way rather
      // than already sent.
      await waitFor(() => calls.some((c) => c.method === 'PUT'), {
        timeoutMs: budgetFor(2000),
        description: 'the adopted value to be promoted to the realm',
      });
      eq(calls.filter((c) => c.method === 'PUT')[0].body, { ui: { [name]: 'inherited' } }, 'promoted value');
      eq(await getWindowPref(name, null), 'inherited', 'still there');
      eq(calls.filter((c) => c.method === 'PUT').length, 1, 'and promoted only once');
    });

    // A caller's fallback is its default, not a choice. Cached as one, the next
    // read would take it for a value an older build left and write it up, so the
    // default would be pinned in the settings document as though chosen.
    await run('a fallback is neither cached nor written up, however often it is read', async () => {
      reset();
      const name = uniqueName();
      eq(await getUserPref(name, false), false, 'first read');
      eq(localStorage.getItem(name), null, 'the fallback was cached');
      eq(await getUserPref(name, false), false, 'second read');
      // A write of our own joins the realm's batch and resolves once that batch
      // is sent, so a promotion queued by either read went out with it or
      // before it: the PUTs then hold the control alone, with no sleep needed.
      const control = uniqueName();
      await setUserPref(control, 'sent');
      eq(calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ ui: { [control]: 'sent' } }], 'writes');
    });

    await run('the realm is asked for once however many preferences want it', async () => {
      reset();
      const [a, b, c] = [uniqueName(), uniqueName(), uniqueName()];
      await Promise.all([
        getWindowPref(a, null),
        getWindowPref(b, null),
        getWindowPref(c, null),
      ]);
      eq(calls.filter((x) => x.method === 'GET').length, 1, 'one GET for three reads');
    });

    await run('a refused write leaves the viewer its own copy', async () => {
      reset(false);
      const name = uniqueName();
      respond = (_url, method) => method === 'PUT'
        ? { status: 403, body: { error: 'UI preferences are per-device: a remote viewer keeps its own' } }
        : { status: 200, body: { ui: {} } };
      await setWindowPref(name, 'mine');
      eq(cachedWindowPref(name, null), 'mine', 'kept locally after the refusal');
    });

    await run('a user preference rides the settings document', async () => {
      reset();
      const name = uniqueName();
      await setUserPref(name, { seen: ['a'] });
      const put = calls.filter((x) => x.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(put[0].url, '/api/settings', 'to the settings route');
      eq(put[0].body, { ui: { [name]: { seen: ['a'] } } }, 'PUT body');
      eq(cachedUserPref(name, null), { seen: ['a'] }, 'cached');

      reset();
      respond = () => ({ status: 200, body: { ui: { [name]: { seen: ['b'] } } } });
      eq(await getUserPref(name, null), { seen: ['b'] }, 'read back from the realm');
    });

    await run('a user preference is cached unscoped, so it is warm in every project', async () => {
      reset();
      const name = uniqueName();
      await setUserPref(name, true);
      eq(localStorage.getItem(name), 'true', 'cached under the bare name');
    });

    // --- the machine realm ---------------------------------------------------
    //
    // The same settings document as the user realm, ranked like the session
    // realms: the desktop's windows share it, and a remote viewer keeps its own.
    // What it exists to stop is one phone muting the desktop it dialled into.

    await run('a machine preference rides the settings document from a desktop window', async () => {
      reset();
      const name = uniqueName();
      await prefs.setMachinePref(name, { sound: false });
      const put = calls.filter((x) => x.method === 'PUT');
      eq(put.length, 1, 'one PUT');
      eq(put[0].url, '/api/settings', 'to the settings route');
      eq(put[0].body, { ui: { [name]: { sound: false } } }, 'PUT body');
      eq(prefs.cachedMachinePref(name, null), { sound: false }, 'cached');
      eq(localStorage.getItem(name), '{"sound":false}', 'cached under the bare name, so it is warm on any port');
    });

    await run('a value the user realm stored is the machine realm\u2019s on the desktop', async () => {
      reset();
      const name = uniqueName();
      respond = () => ({ status: 200, body: { ui: { [name]: 'set before the realm existed' } } });
      eq(await prefs.reconcilePref('machine', name, 'juggler-test-pref-changed'), 'set before the realm existed', 'the stored value');
    });

    await run('a remote viewer\u2019s machine preference never reaches the server', async () => {
      reset(false);
      const name = uniqueName();
      await prefs.setMachinePref(name, 'muted on the phone');
      eq(calls.filter((c) => c.method === 'PUT').length, 0, 'no write');
      eq(prefs.cachedMachinePref(name, null), 'muted on the phone', 'kept on the device');
    });

    await run('a remote viewer keeps its machine preference across a reload and a broadcast', async () => {
      reset(false);
      const name = uniqueName();
      await prefs.setMachinePref(name, 'mine');
      // A fresh page: the module's cache is gone, and the desktop's document
      // arrives with its own value — which must not overwrite this device's.
      __resetPrefsForTests();
      respond = () => ({ status: 200, body: { ui: { [name]: 'the desktop\u2019s' } } });
      eq(await prefs.reconcilePref('machine', name, 'juggler-test-pref-changed'), 'mine', 'after the reload');
      eq(prefs.cachedMachinePref(name, null), 'mine', 'and synchronously');
      adoptGlobalSettings({ ui: { [name]: 'the desktop\u2019s, changed again' } });
      eq(prefs.cachedMachinePref(name, null), 'mine', 'after the desktop changed it');
      __resetPrefsForTests();
      eq(await prefs.reconcilePref('machine', name, 'juggler-test-pref-changed'), 'mine', 'and after another reload');
    });

    // The desktop app's Connect to Server window is a native window, but its
    // server is on another machine: every preference it changes belongs to the
    // computer in front of the user, not to the host it dialled into. Ranked as
    // the host's own window, it read back the host's value on every load and lost
    // its own; writing like one, it would redecorate the host.

    await run('a desktop window on another machine keeps its machine preference to itself', async () => {
      reset(true, true);
      const name = uniqueName();
      await prefs.setMachinePref(name, 'mine');
      eq(calls.filter((c) => c.method === 'PUT').length, 0, 'writes sent to the host');
      eq(localStorage.getItem(`${name}@viewer`), '"mine"', 'stored as this device\u2019s own copy');
      __resetPrefsForTests();
      respond = () => ({ status: 200, body: { ui: { [name]: 'the host\u2019s' } } });
      eq(await prefs.reconcilePref('machine', name, 'juggler-test-pref-changed'), 'mine', 'after a relaunch');
    });

    await run('a desktop window on another machine ranks its own window preference first', async () => {
      reset(true, true);
      const name = uniqueName();
      await setWindowPref(name, 'mine');
      eq(calls.filter((c) => c.method === 'PUT').length, 0, 'writes sent to the host');
      __resetPrefsForTests();
      respond = () => ({ status: 200, body: { ui: { [name]: 'the host\u2019s' } } });
      eq(await getWindowPref(name, null), 'mine', 'after a relaunch');
      eq(cachedWindowPref(name, null), 'mine', 'and synchronously');
    });

    await run('a remote viewer with nothing of its own starts from the desktop\u2019s', async () => {
      reset(false);
      const name = uniqueName();
      respond = () => ({ status: 200, body: { ui: { [name]: 'the desktop\u2019s' } } });
      eq(await prefs.reconcilePref('machine', name, 'juggler-test-pref-changed'), 'the desktop\u2019s', 'the starting value');
    });

    // --- a document written in another window ------------------------------
    //
    // settings.json is one file for every project's server, and the user realm is
    // read once per page — so without adoption a second window would hold its
    // boot-time copy for as long as it stayed open.

    await run('a document from another window reaches a preference already read', async () => {
      reset();
      const name = uniqueName();
      respond = () => ({ status: 200, body: { ui: { [name]: 'as it was' } } });
      eq(await getUserPref(name, null), 'as it was', 'the value this window loaded');

      const changed = adoptGlobalSettings({ ui: { [name]: 'as another window left it' } });
      eq(changed, [name], 'the names reported as changed');
      eq(cachedUserPref(name, null), 'as another window left it', 'the synchronous read');
      // The once-per-page read is memoised, so this is the assertion that the
      // adoption reached the resolved document rather than a copy beside it.
      eq(await getUserPref(name, null), 'as another window left it', 'the awaited read');
      eq(calls.filter((c) => c.method === 'GET').length, 1, 'and no refetch was needed');
    });

    await run('adopting reports only what moved', async () => {
      reset();
      const [stays, moves] = [uniqueName(), uniqueName()];
      respond = () => ({ status: 200, body: { ui: { [stays]: 1, [moves]: 1 } } });
      await getUserPref(stays, null);
      eq(adoptGlobalSettings({ ui: { [stays]: 1, [moves]: 2 } }), [moves], 'only the changed name');
      eq(adoptGlobalSettings({ ui: { [stays]: 1, [moves]: 2 } }), [], 'and a redundant document moves nothing');
    });

    await run('a preference the document has dropped is forgotten, mirror included', async () => {
      reset();
      const name = uniqueName();
      respond = () => ({ status: 200, body: { ui: { [name]: 'forgotten elsewhere' } } });
      await getUserPref(name, null);
      eq(localStorage.getItem(name), '"forgotten elsewhere"', 'mirrored while it was stored');
      adoptGlobalSettings({ ui: {} });
      // The mirror has to be cleared with the document: a cached read falls back
      // to it, so a stale mirror would keep answering with the forgotten value.
      eq(cachedUserPref(name, 'gone'), 'gone', 'forgotten');
    });

    await run('a write still waiting outranks the document it crosses', async () => {
      reset();
      const name = uniqueName();
      // Not awaited: the write is sitting on its batch timer, which is exactly
      // the window in which another window's document can arrive.
      const pending = setUserPref(name, 'mine, still going out');
      adoptGlobalSettings({ ui: { [name]: 'the older document' } });
      eq(cachedUserPref(name, null), 'mine, still going out', 'the newer local write survives');
      await pending;
    });

    await run('adopting announces the preference, so a live view re-syncs', async () => {
      reset();
      const name = uniqueName();
      const eventName = `juggler-test-pref-event-${seq++}`;
      let announced = 0;
      const onAnnounced = () => { announced++; };
      window.addEventListener(eventName, onAnnounced);
      try {
        // How every manager registers: the boot-time reconcile names the
        // preference and the event in one call, and that is the only thing that
        // teaches prefs.js what to fire.
        respond = () => ({ status: 200, body: { ui: { [name]: 'boot' } } });
        await prefs.reconcilePref('user', name, eventName);
        announced = 0;
        adoptGlobalSettings({ ui: { [name]: 'changed elsewhere' } });
        eq(announced, 1, 'announcements for a changed preference');
        adoptGlobalSettings({ ui: { [name]: 'changed elsewhere' } });
        eq(announced, 1, 'and none for a document that changed nothing');
      } finally {
        window.removeEventListener(eventName, onAnnounced);
      }
    });

    // While the socket is down no broadcast can arrive, and the document is read
    // once for the life of the page — so without an explicit re-read a window that
    // reconnected would hold whatever it had before the drop, indefinitely.
    await run('a reconnect re-reads the document and adopts what changed meanwhile', async () => {
      reset();
      const name = uniqueName();
      respond = () => ({ status: 200, body: { ui: { [name]: 'before the drop' } } });
      eq(await prefs.getGlobalSettings(), { ui: { [name]: 'before the drop' } }, 'the document as read');

      // The change nothing could tell this window about.
      respond = () => ({ status: 200, body: { ui: { [name]: 'changed while offline' } } });
      await prefs.resyncGlobalSettings();

      eq(cachedUserPref(name, null), 'changed while offline', 'the re-read was adopted');
      const doc = await prefs.getGlobalSettings();
      eq(doc.ui[name], 'changed while offline', 'and the document followers see');
    });

    await run('a follower is handed the whole document, not just its ui section', async () => {
      reset();
      respond = () => ({ status: 200, body: { ui: {}, network: { proxy: { mode: 'none' } } } });
      await prefs.getGlobalSettings();
      /** @type {any[]} */
      const seen = [];
      /** @param {any} s */
      const follower = (s) => { seen.push(s); };
      prefs.onGlobalSettings(follower);
      try {
        prefs.adoptGlobalSettings({ ui: {}, network: { proxy: { mode: 'manual', url: 'http://p:1' } } });
        eq(seen.length, 1, 'the follower was told once');
        eq(seen[0].network.proxy.mode, 'manual', 'and got the section it cares about');
      } finally {
        prefs.offGlobalSettings(follower);
      }
      prefs.adoptGlobalSettings({ ui: {} });
      eq(seen.length, 1, 'a removed follower is not told again');
    });

    await run('a realm that cannot be reached falls back rather than throwing', async () => {
      reset();
      const name = uniqueName();
      setDevicePref(name, 'cached');
      respond = () => ({ status: 500, body: { error: 'nope' } });
      eq(await getWindowPref(name, 'default'), 'cached', 'the cache carries it');
      eq(await getWindowPref(uniqueName(), 'default'), 'default', 'and nothing at all is the default');
    });
  } finally {
    window.fetch = realFetch;
    window.__projectKey = originalProjectKey;
    if (originalWindowMode === undefined) delete document.documentElement.dataset.windowMode;
    else document.documentElement.dataset.windowMode = originalWindowMode;
    if (originalRemoteViewer === undefined) delete document.documentElement.dataset.remoteViewer;
    else document.documentElement.dataset.remoteViewer = originalRemoteViewer;
    __resetPrefsForTests();
  }

  return { passed, failed, errors };
}
