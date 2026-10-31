//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Connectivity tab — how other devices get in, and who already has.
 *
 * LAN access and tunnels belong to the machine server, and a viewer on this
 * machine switches them here, through the session's /api/connectivity/lan and
 * /api/connectivity/tunnel. Each way in, once open, shows its addresses as
 * cards: a scannable QR, the address as a link, and a copy button — this
 * session's link with the QR, and the machine's sessions page under it, where
 * the machine server names the session there. A viewer
 * off this machine, or a session with no machine server (`exposure: false`),
 * sees only the other clients and the proxy box. The component is driven
 * through its own refresh path against a stubbed fetch.
 * @module unit-tests/connectivity-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** A QR drawing as the server sends one (internal/qrsvg). */
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><g fill="currentColor"><rect x="0" y="0" width="7" height="1"/></g></svg>';

/** The QR of a session's own link, told apart from the machine's by its size. */
const SESSION_QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><g fill="currentColor"><rect x="1" y="1" width="5" height="1"/></g></svg>';
const SESSION_QR_BOX = '0 0 25 25';

/**
 * Which drawing a QR box holds: its SVG's viewBox.
 * @param {Element|null|undefined} box - A .connectivity-qr.
 * @returns {string|null|undefined} The viewBox.
 */
const qrOf = (box) => box?.querySelector('svg')?.getAttribute('viewBox');

/**
 * A LAN address as the machine server names it to a session that asked about
 * itself: the machine's root, and the session there.
 * @param {string} root - The machine's address.
 * @returns {any} The URL entry.
 */
const lanURL = (root) => ({ url: root, interface: 'en0', qr: QR, session: { url: `${root}s/abc123/`, qr: SESSION_QR } });

/**
 * A stand-in for the session's connectivity routes, recording each call.
 * @param {{exposure: boolean, lan?: any, tunnel?: any, launch?: any, holdLaunchRead?: Promise<void>, onLaunchRead?: (v?: any) => void, fail?: string}} state -
 *   What the routes answer; `fail` names a path whose PUT fails, `holdLaunchRead` holds each launch read's
 *   answer, and `onLaunchRead` is told when one is asked.
 * @returns {{restore: () => void, calls: {method: string, url: string, body: any}[], state: any}} Handle.
 */
function installConnectivityFetch(state) {
  const orig = window.fetch;
  /** @type {{method: string, url: string, body: any}[]} */
  const calls = [];
  const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    if (method === 'PUT' && u === state.fail) {
      return {
        ok: false, status: 502, statusText: 'Bad Gateway',
        text: async () => JSON.stringify({ error: 'cloudflared is not installed' }),
        json: async () => ({ error: 'cloudflared is not installed' }),
      };
    }
    if (u === '/api/connectivity') {
      return ok({ clientCount: 1, clients: [], exposure: state.exposure });
    }
    if (u === '/api/connectivity/lan') {
      if (method === 'PUT') {
        state.lan = body.enabled
          ? { enabled: true, urls: [lanURL('http://192.168.1.4:3939/'), lanURL('http://10.0.0.7:3939/')] }
          : { enabled: false, urls: [] };
      }
      return ok(state.lan);
    }
    if (u === '/api/connectivity/launch') {
      if (method === 'PUT') {
        state.launch = { ...state.launch, ...body };
        return ok(state.launch);
      }
      // A read held by the test answers with what was saved when it was asked.
      const asked = { lanOnLaunch: false, wanOnLaunch: '', ...state.launch };
      state.onLaunchRead?.();
      if (state.holdLaunchRead) await state.holdLaunchRead;
      return ok(asked);
    }
    if (u === '/api/connectivity/server') {
      return ok(state.server || { status: 'ok', pid: 4242, addr: '127.0.0.1:3939', appStarted: true });
    }
    if (u === '/api/connectivity/tunnel') {
      if (method === 'PUT') {
        state.tunnel = {
          ...state.tunnel,
          running: body.mode
            ? { mode: body.mode, url: 'https://quiet-fox.trycloudflare.com/', relay: true, qr: QR, session: { url: 'https://quiet-fox.trycloudflare.com/s/abc123/', qr: SESSION_QR } }
            : null,
        };
      }
      return ok(state.tunnel);
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/**
 * The tunnel modes a build registered, as the machine server describes them.
 * @returns {any} A tunnel state with nothing running.
 */
const tunnelModes = () => ({
  modes: [
    { mode: 'p2p', available: true, title: 'Direct P2P', description: 'Peer to peer.', startLabel: 'Start Direct P2P' },
    { mode: 'cloudflared', available: true, title: 'Cloudflare Tunnel relay', description: 'Relayed.', startLabel: 'Start relay', relayNote: 'Traffic is relayed through Cloudflare.' },
    { mode: 'other', available: false, title: 'Other', description: 'Elsewhere.', unavailableHint: 'Install the other thing.' },
  ],
  running: null,
});

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>|void} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Mount a settings-panel, render the connectivity fields, and let the tab
   * load its state from the stubbed routes.
   * @param {object} connectivity - The seeded connectivity state.
   * @returns {Promise<{el: any, tab: any}>} The mounted element (caller removes it) and its tab.
   */
  const mountWith = async (connectivity) => {
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    const tab = el._tabs.connectivity;
    tab.connectivity = connectivity;
    tab.renderConnectivityFields();
    await tab.refreshConnectivity();
    return { el, tab };
  };

  /**
   * Run fn with the routes stubbed by state, restoring fetch after.
   * @param {any} state - The stand-in's state.
   * @param {(api: ReturnType<typeof installConnectivityFetch>) => Promise<void>} fn
   */
  const withRoutes = async (state, fn) => {
    const api = installConnectivityFetch(state);
    try {
      await fn(api);
    } finally {
      api.restore();
    }
  };

  const self = wsService.clientId || 'self-client';
  const now = Date.now();
  /**
   * What the API reports: this client and three others, one of them a tunnel's
   * caller its transport named.
   * @returns {object} The connectivity state.
   */
  const withClients = () => ({
    clientCount: 4,
    exposure: false,
    clients: [
      { id: self, origin: 'local', detail: '', userAgent: '', connectedAt: now - 60_000 },
      { id: 'c-lan', origin: 'lan', detail: '192.168.1.9', userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1', connectedAt: now - 30_000 },
      { id: 'c-remote', origin: 'remote', detail: 'Direct P2P', userAgent: '', connectedAt: now - 10_000 },
      { id: 'c-named', origin: 'remote', detail: 'Direct P2P', name: 'Alice', userAgent: '', connectedAt: now - 5_000 },
    ],
  });

  /**
   * The buttons in a section, by label.
   * @param {Element|null} scope
   * @param {string} label
   * @returns {HTMLButtonElement|undefined} The button.
   */
  const button = (scope, label) => /** @type {HTMLButtonElement|undefined} */ (
    [...(scope?.querySelectorAll('button') || [])].find((b) => b.textContent === label));

  await run('Start LAN access turns it on, and each address is a card for this session, with the machine\'s sessions beside it', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: { modes: [], running: null } }, async (api) => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        const section = el.querySelector('#connectivity-lan-section');
        assert(!section?.querySelector('input[role=switch], .toggle-switch'), 'LAN access is a switch, unlike the tunnel rows');
        const start = button(section, 'Start LAN access');
        assert(!!start, 'no Start LAN access button');
        assert(el.querySelectorAll('.connectivity-address').length === 0, 'addresses shown while LAN access is off');

        /** @type {HTMLButtonElement} */ (start).click();
        await tab.pending;
        const put = api.calls.find((c) => c.method === 'PUT');
        assert(put?.url === '/api/connectivity/lan' && put.body.enabled === true, `start sent ${JSON.stringify(put)}`);

        const cards = [...el.querySelectorAll('#connectivity-lan-section .connectivity-address')];
        assert(cards.length === 2, `${cards.length} address cards, want 2`);
        // What a phone scans is this session; the machine's sessions page is
        // the second link, for a device that wants the others too.
        const links = /** @type {HTMLAnchorElement[]} */ ([...cards[0].querySelectorAll('a')]);
        assert(JSON.stringify(links.map((a) => a.getAttribute('href'))) === JSON.stringify(['http://192.168.1.4:3939/s/abc123/', 'http://192.168.1.4:3939/']),
          `card links ${JSON.stringify(links.map((a) => a.getAttribute('href')))}, want this session then the machine`);
        assert(links.every((a) => a.target === '_blank' && a.textContent === a.getAttribute('href')), 'an address is not a link that opens apart');
        assert(cards[0].querySelectorAll('.copy-button').length === 2, 'each address on the card does not have its copy button');
        const qrs = cards[0].querySelectorAll('.connectivity-qr');
        assert(qrs.length === 1 && qrOf(qrs[0]) === SESSION_QR_BOX, 'the card\'s one QR is not this session\'s link');
        const labels = [...cards[0].querySelectorAll('.connectivity-address-label')].map((l) => l.textContent);
        assert(JSON.stringify(labels) === JSON.stringify(['This session', 'All sessions on this machine']), `card labels ${JSON.stringify(labels)}`);
        assert(!(cards[0].textContent || '').includes('en0'), `the card shows its interface name: ${cards[0].textContent}`);
        assert((cards[0].textContent || '').includes('same network') && (cards[0].textContent || '').includes('this session'),
          `the card does not say how to use it: ${cards[0].textContent}`);

        const stop = button(el.querySelector('#connectivity-lan-section'), 'Stop LAN access');
        assert(!!stop, 'no Stop LAN access button once it is on');
        /** @type {HTMLButtonElement} */ (stop).click();
        await tab.pending;
        assert(api.calls.filter((c) => c.method === 'PUT').at(-1)?.body.enabled === false, 'stop did not turn it off');
        assert(el.querySelectorAll('.connectivity-address').length === 0, 'the cards outlived LAN access');
      } finally {
        el.remove();
      }
    });
  });

  await run('the tab says whether the app or a terminal started the machine server, to a viewer on this machine only', async () => {
    const terminal = { status: 'ok', pid: 4242, addr: '127.0.0.1:3939', appStarted: false };
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: { modes: [], running: null }, server: terminal }, async (api) => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        /** @returns {string} What the server's row says. */
        const said = () => el.querySelector('#connectivity-server-section .connectivity-server')?.textContent || '';
        assert(said().includes('from a terminal') && said().includes('4242') && said().includes('127.0.0.1:3939'),
          `a terminal's server: ${JSON.stringify(said())}`);
        api.state.server = { status: 'ok', pid: 77, addr: '127.0.0.1:3939', appStarted: true };
        await tab.refreshConnectivity();
        assert(said().includes('Juggler app') && !said().includes('terminal'), `the app's server: ${JSON.stringify(said())}`);
      } finally {
        el.remove();
      }
    });
    await withRoutes({ exposure: false, server: terminal }, async (api) => {
      const { el } = await mountWith({ clientCount: 1, clients: [], exposure: false });
      try {
        assert(!el.querySelector('.connectivity-server'), 'who started the server was shown to a viewer off this machine');
        assert(!api.calls.some((c) => c.url === '/api/connectivity/server'), 'the tab asked a viewer off this machine for the server');
      } finally {
        el.remove();
      }
    });
  });

  await run('an address the machine server names no session at is a card for the machine alone', async () => {
    await withRoutes({ exposure: true, lan: { enabled: true, urls: [{ url: 'http://192.168.1.4:3939/', interface: 'en0', qr: QR }] }, tunnel: { modes: [], running: null } }, async () => {
      const { el } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        const card = el.querySelector('#connectivity-lan-section .connectivity-address');
        const hrefs = [...(card?.querySelectorAll('a') || [])].map((a) => a.getAttribute('href'));
        assert(JSON.stringify(hrefs) === '["http://192.168.1.4:3939/"]', `card links ${JSON.stringify(hrefs)}`);
        assert(qrOf(card?.querySelector('.connectivity-qr')) === '0 0 21 21', 'the card does not draw the machine\'s address');
        assert(!card?.querySelector('.connectivity-address-label'), 'a lone address is labelled');
      } finally {
        el.remove();
      }
    });
  });

  await run('LAN access on with no address says so', async () => {
    await withRoutes({ exposure: true, lan: { enabled: true, urls: [] }, tunnel: { modes: [], running: null } }, async () => {
      const { el } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        const text = el.querySelector('#connectivity-lan-section')?.textContent || '';
        assert(text.includes('no address on a network'), `no "no address" line: ${text}`);
      } finally {
        el.remove();
      }
    });
  });

  await run('a failed switch says why, and the button shows what is', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: { modes: [], running: null }, fail: '/api/connectivity/lan' }, async () => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        /** @type {HTMLButtonElement} */ (button(el.querySelector('#connectivity-lan-section'), 'Start LAN access')).click();
        await tab.pending;
        const err = el.querySelector('#connectivity-lan-section .connectivity-error');
        assert(!!err && !(/** @type {HTMLElement} */ (err)).hidden && (err.textContent || '').includes('could not be switched'), `error line: ${err?.textContent}`);
        assert((err?.textContent || '').includes('cloudflared is not installed'), `the server's reason is missing: ${err?.textContent}`);
        const shown = button(el.querySelector('#connectivity-lan-section'), 'Start LAN access');
        assert(!!shown && !shown.disabled, 'Start is gone, or held, after the switch failed');
      } finally {
        el.remove();
      }
    });
  });

  await run('each tunnel mode starts from its own row, and the open one shows its card and Stop', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: tunnelModes() }, async (api) => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        const section = /** @type {HTMLElement} */ (el.querySelector('#connectivity-tunnel-section'));
        assert(!!section && !section.hidden, 'no tunnel section with modes registered');
        const text = section.textContent || '';
        for (const want of ['Direct P2P', 'Cloudflare Tunnel relay', 'Install the other thing.']) {
          assert(text.includes(want), `tunnel section lacks "${want}": ${text}`);
        }
        assert(!section.querySelector('.settings-section-heading'), 'the modes sit under a heading of their own');
        const rows = [...section.querySelectorAll('.provider-field')];
        assert(rows.length === 3 && rows.every((r) => (r.querySelector('.provider-info')?.textContent || '').includes('no password')),
          'a mode row does not warn, in its own words, that the link has no password');
        const start = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Start relay');
        assert(!!start, 'no Start relay button');
        /** @type {HTMLButtonElement} */ (start).click();
        await tab.pending;
        const put = api.calls.find((c) => c.method === 'PUT');
        assert(put?.url === '/api/connectivity/tunnel' && put.body.mode === 'cloudflared', `start sent ${JSON.stringify(put)}`);

        const card = section.querySelector('.connectivity-address');
        const hrefs = [...(card?.querySelectorAll('a') || [])].map((a) => a.getAttribute('href'));
        assert(JSON.stringify(hrefs) === JSON.stringify(['https://quiet-fox.trycloudflare.com/s/abc123/', 'https://quiet-fox.trycloudflare.com/']),
          `tunnel card links ${JSON.stringify(hrefs)}, want this session then the machine`);
        assert(card?.querySelectorAll('.copy-button').length === 2, 'tunnel card lacks a copy button');
        assert(qrOf(card?.querySelector('.connectivity-qr')) === SESSION_QR_BOX, 'the tunnel card\'s QR is not this session\'s link');
        assert((section.textContent || '').includes('Traffic is relayed through Cloudflare.'), 'no relay note');
        assert(![...section.querySelectorAll('button')].some((b) => b.textContent === 'Start Direct P2P'),
          'another mode offers Start while a tunnel is open');

        const stop = button(section, 'Stop Cloudflare Tunnel relay');
        assert(!!stop, 'no way to close the open tunnel');
        /** @type {HTMLButtonElement} */ (stop).click();
        await tab.pending;
        const close = api.calls.filter((c) => c.method === 'PUT').at(-1);
        assert(close?.body.mode === '', `stop sent ${JSON.stringify(close)}`);
        assert(!section.querySelector('.connectivity-address'), 'the card outlived the tunnel');
      } finally {
        el.remove();
      }
    });
  });

  /**
   * A row's "start whenever Juggler starts" checkbox.
   * @param {Element} el - The panel.
   * @param {string} which - 'lan', or a tunnel mode id.
   * @returns {HTMLInputElement|null} The checkbox.
   */
  const launchBox = (el, which) => /** @type {HTMLInputElement|null} */ (el.querySelector(which === 'lan'
    ? '#connectivity-lan-section .connectivity-launch input[type=checkbox]'
    : `#connectivity-tunnel-section .connectivity-launch input[data-mode="${which}"]`));

  // What opens at start is the machine server's, read and saved through the
  // session's /api/connectivity/launch — never the session's settings document.
  await run('each way in can be saved to start whenever Juggler starts; only one tunnel can', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: tunnelModes(), launch: { lanOnLaunch: false, wanOnLaunch: 'cloudflared' } }, async (api) => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        assert(api.calls.some((c) => c.method === 'GET' && c.url === '/api/connectivity/launch'), 'the tab never read what opens at start');
        for (const [which, want] of /** @type {[string, boolean][]} */ ([['lan', false], ['p2p', false], ['cloudflared', true], ['other', false]])) {
          const box = launchBox(el, which);
          assert(!!box, `no start-with-Juggler checkbox for ${which}`);
          assert(box?.checked === want, `${which} checkbox is ${box?.checked}, want ${want}`);
        }
        assert((el.querySelector('#connectivity-lan-section .connectivity-launch')?.textContent || '').includes('whenever Juggler starts'),
          'the LAN checkbox does not say what it does');

        /** @type {HTMLInputElement} */ (launchBox(el, 'lan')).click();
        await tab.pending;
        let put = api.calls.filter((c) => c.method === 'PUT').at(-1);
        assert(put?.url === '/api/connectivity/launch' && JSON.stringify(put.body) === '{"lanOnLaunch":true}', `LAN checkbox sent ${JSON.stringify(put)}`);
        assert(!!launchBox(el, 'lan')?.checked, 'the LAN checkbox did not stay ticked');

        /** @type {HTMLInputElement} */ (launchBox(el, 'p2p')).click();
        await tab.pending;
        put = api.calls.filter((c) => c.method === 'PUT').at(-1);
        assert(put?.url === '/api/connectivity/launch' && JSON.stringify(put.body) === '{"wanOnLaunch":"p2p"}', `p2p checkbox sent ${JSON.stringify(put)}`);
        assert(!!launchBox(el, 'p2p')?.checked && !launchBox(el, 'cloudflared')?.checked, 'two tunnels ticked to start at once');

        /** @type {HTMLInputElement} */ (launchBox(el, 'p2p')).click();
        await tab.pending;
        put = api.calls.filter((c) => c.method === 'PUT').at(-1);
        assert(put?.body.wanOnLaunch === '', `unticking p2p sent ${JSON.stringify(put)}`);
        assert(!launchBox(el, 'p2p')?.checked, 'p2p stayed ticked');
        assert(!api.calls.some((c) => c.url === '/api/settings'), `the tab used the settings document: ${JSON.stringify(api.calls.filter((c) => c.url === '/api/settings'))}`);

        // The sessions page, or another session, changed them: the next poll shows it.
        api.state.launch = { lanOnLaunch: false, wanOnLaunch: 'cloudflared' };
        await tab.refreshConnectivity();
        assert(!launchBox(el, 'lan')?.checked && !!launchBox(el, 'cloudflared')?.checked, 'a change from elsewhere is not shown');

        // The settings document saying otherwise changes nothing here.
        tab.onSettingsChanged({ connectivity: { lanOnLaunch: true, wanOnLaunch: 'p2p' } });
        assert(!launchBox(el, 'lan')?.checked && !!launchBox(el, 'cloudflared')?.checked, 'the settings document drove the start-with-Juggler boxes');
      } finally {
        el.remove();
      }
    });
  });

  await run('a refused start-with-Juggler choice says why and shows what is saved', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: tunnelModes(), fail: '/api/connectivity/launch' }, async () => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        /** @type {HTMLInputElement} */ (launchBox(el, 'lan')).click();
        await tab.pending;
        assert(!launchBox(el, 'lan')?.checked, 'the checkbox stayed ticked after the save failed');
        const err = el.querySelector('#connectivity-lan-section .connectivity-error');
        assert(!!err && !(/** @type {HTMLElement} */ (err)).hidden && (err.textContent || '').includes('could not be saved'), `error line: ${err?.textContent}`);
      } finally {
        el.remove();
      }
    });
  });

  await run('a poll asked before a start-with-Juggler choice was saved does not put it back', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: tunnelModes() }, async (api) => {
      const { el, tab } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        /** @type {() => void} */
        let answer = () => {};
        api.state.holdLaunchRead = new Promise((resolve) => { answer = resolve; });
        const asked = new Promise((resolve) => { api.state.onLaunchRead = () => resolve(true); });
        const poll = tab.refreshConnectivity();
        // The poll has asked what opens at start before the box is ticked.
        assert(await Promise.race([asked, poll.then(() => false)]), 'the poll never asked what opens at start');
        /** @type {HTMLInputElement} */ (launchBox(el, 'lan')).click();
        await tab.pending;
        answer();
        await poll;
        assert(!!launchBox(el, 'lan')?.checked, 'a poll answered with what was saved before the choice unticked it');
      } finally {
        el.remove();
      }
    });
  });

  await run('who is connected comes first, and every row is the same distance from the next', async () => {
    await withRoutes({ exposure: true, lan: { enabled: true, urls: [lanURL('http://192.168.1.4:3939/')] }, tunnel: tunnelModes() }, async () => {
      const { el } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        el.classList.add('show');
        el.switchTab('connectivity');
        const rows = [...el.querySelectorAll('#connectivity-form .provider-field')];
        assert(rows[0]?.id === 'connectivity-clients-section', `the first row is ${rows[0]?.id || rows[0]?.textContent}`);
        assert(rows.length === 6, `${rows.length} rows, want clients, the server, LAN and 3 modes`);
        assert(rows[1]?.classList.contains('connectivity-server'), `the second row is ${rows[1]?.textContent}, want the server`);
        const boxes = rows.map((r) => r.getBoundingClientRect());
        assert(boxes.every((b) => b.height > 0), 'the rows were never laid out');
        const gaps = boxes.slice(1).map((b, i) => Math.round(b.top - boxes[i].bottom));
        assert(gaps.every((g) => g === gaps[0] && g > 0), `uneven gaps between rows: ${JSON.stringify(gaps)}`);
      } finally {
        el.remove();
      }
    });
  });

  await run('a build with no tunnel modes shows no tunnel section', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: { modes: [], running: null } }, async () => {
      const { el } = await mountWith({ clientCount: 1, clients: [], exposure: true });
      try {
        const section = /** @type {HTMLElement|null} */ (el.querySelector('#connectivity-tunnel-section'));
        assert(!section || section.hidden, 'a tunnel section with no modes');
      } finally {
        el.remove();
      }
    });
  });

  await run('a viewer that may not switch exposure sees only who is connected', async () => {
    await withRoutes({ exposure: false }, async (api) => {
      const { el } = await mountWith(withClients());
      try {
        for (const id of ['#connectivity-lan-section', '#connectivity-tunnel-section']) {
          const s = /** @type {HTMLElement|null} */ (el.querySelector(id));
          assert(!s || s.hidden, `${id} shown with exposure off`);
        }
        assert(!api.calls.some((c) => c.url.startsWith('/api/connectivity/')), 'asked for LAN or tunnel state it may not have');
        assert(!!el.querySelector('#connectivity-clients-section'), 'the clients box is missing');
      } finally {
        el.remove();
      }
    });
  });

  await run('the clients box lists the other clients, oldest first', async () => {
    await withRoutes({ exposure: false }, async () => {
      const { el, tab } = await mountWith(withClients());
      try {
        tab.connectivity = withClients();
        tab._refreshClientsSection();
        const rows = [...el.querySelectorAll('#connectivity-clients-section .connectivity-client')]
          .map((r) => r.textContent || '');
        assert(rows.length === 3, `${rows.length} rows, want the 3 other clients: ${JSON.stringify(rows)}`);
        assert(rows[0].includes('LAN · 192.168.1.9') && rows[0].includes('iPhone'), `first row: ${rows[0]}`);
        assert(rows[1].includes('Direct P2P'), `second row: ${rows[1]}`);
        assert(rows[2].includes('Alice · Direct P2P'), `a named caller is shown by name and transport: ${rows[2]}`);
      } finally {
        el.remove();
      }
    });
  });

  // LAN access and tunnels are switched from the sessions page and from every
  // session's Settings too, so an open Connectivity tab polls to follow them.
  // It must poll however it came to be open: shown before the panel's first
  // load lands (opened straight onto it), and shown again when the panel is
  // reopened on it without naming a tab.
  await run('an open Connectivity tab polls, however the panel came to show it', async () => {
    await withRoutes({ exposure: true, lan: { enabled: false, urls: [] }, tunnel: { modes: [], running: null } }, async () => {
      const el = /** @type {any} */ (document.createElement('settings-panel'));
      document.body.appendChild(el);
      const tab = el._tabs.connectivity;
      try {
        tab.show();
        tab.onConfigLoaded({ connectivity: { clientCount: 1, clients: [], exposure: true } }, true);
        assert(tab._connectivityPollId !== undefined, 'opened straight onto the tab, it never polls once the load lands');

        el._hasLoadedOnce = true;
        el.switchTab('connectivity');
        el.close();
        assert(tab._connectivityPollId === undefined, 'a closed panel still polls');
        await el.open();
        assert(tab._connectivityPollId !== undefined, 'reopened on the tab, it does not poll');
      } finally {
        el.close();
        el.remove();
      }
    });
  });

  await run('the tab speaks the UI language', async () => {
    await underPseudoLocale('connectivity-test', async () => {
      await withRoutes({ exposure: true, lan: { enabled: true, urls: [] }, tunnel: { modes: [], running: null } }, async () => {
        const { el } = await mountWith({ clientCount: 1, clients: [], exposure: true });
        try {
          assertPseudoLocalized(/** @type {Element} */ (el.querySelector('#connectivity-lan-section')), { atLeast: 2, where: 'the LAN section' });
          const box = el.querySelector('#connectivity-clients-section');
          assert(!!box?.querySelector('.connectivity-clients-empty'), 'no "none connected" line');
          assertPseudoLocalized(/** @type {Element} */ (box), { atLeast: 2, where: 'the clients box' });
        } finally {
          el.remove();
        }
      });
    });
  });

  return { passed, failed, errors };
}
