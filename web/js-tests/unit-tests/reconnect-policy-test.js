//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Reconnect-policy tests — the WebSocketService applies ONE generic reconnect
 * policy to every transport (WebSocket, WebRTC-LAN, juggler.studio): a dropped
 * link is detected, the service backs off, and it re-establishes via a single
 * transport-specific primitive (this._reestablish), looping until reconnected.
 *
 * These cases pin that uniformity directly on a throwaway WebSocketService:
 *   - any non-intentional transport death enters the shared backoff loop;
 *   - an intentional teardown or an expected failed-probe close does NOT;
 *   - an attempt abandoned mid-handshake cannot act on the link that replaced
 *     it, while one that fails as the current attempt still falls back;
 *   - the backoff timer fires whatever re-establish primitive the current
 *     transport installed (not a hardcoded socket reconnect);
 *   - studio's primitive reloads directly (its only recovery), throttled by
 *     the rate-limiter, and re-arms the same loop instead of storming when the
 *     reload is throttled or the link already recovered.
 *
 * The first half also pins how a dead link is NOTICED, which on a slow or mobile
 * link is most of the problem: a half-open connection is never closed by either
 * end, so the service beats on an idle link, drops one that has stopped
 * delivering, and retries at once when the page wakes rather than waiting out a
 * backoff measured against a network that has since changed.
 *
 * The second half pins what a recovered link MEANS, which is the expensive
 * question. A viewer's reconnect is decided by the boot id the server puts in
 * its session message: unchanged, the same process is still there and the page
 * catches up over the live document; changed, the page was served by a process
 * that is gone — its token is refused and its cache-busted module URLs 404 —
 * and only a reload recovers. Reloading is the exception, and every route to
 * one is pinned here, including the ones with no boot id to compare — as is the
 * link the watchdog condemns mid-handshake, which is a route to a retry.
 * @module unit-tests/reconnect-policy-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import wsService, { WebSocketService } from '../../js/services/websocket.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

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
   * @param {() => Promise<void>} fn
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
   * Capture the callback the next setTimeout schedules, without waiting on the
   * real backoff delay. Restores the global immediately so nothing else is
   * affected. Returns the captured callback (or null if none scheduled).
   * @param {() => void} fn - Code that is expected to schedule one setTimeout.
   * @returns {(() => void)|null} The captured callback, or null if none scheduled.
   */
  const captureScheduled = (fn) => {
    const orig = globalThis.setTimeout;
    /** @type {(() => void)|null} */
    let cb = null;
    // @ts-ignore - test stub
    globalThis.setTimeout = (/** @type {() => void} */ f) => { cb = f; return 0; };
    try {
      fn();
    } finally {
      globalThis.setTimeout = orig;
    }
    return cb;
  };

  /**
   * Count how many times a given wsService event fires while fn runs.
   * @param {WebSocketService} svc
   * @param {string} event
   * @param {() => void} fn
   * @returns {number} Number of times the event fired.
   */
  const countEvent = (svc, event, fn) => {
    let n = 0;
    const cb = () => { n++; };
    svc.on(/** @type {any} */ (event), cb);
    try {
      fn();
    } finally {
      svc.off(/** @type {any} */ (event), cb);
    }
    return n;
  };

  /**
   * A stand-in for the transport, carrying the four handlers
   * _configureTransport installs plus a record of having been closed.
   * @returns {any} Fake transport.
   */
  const makeTransport = () => ({
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    closed: false,
    /** @type {string[]} Outbound frames, so a test can see what was beaten. */
    frames: [],
    /** Record the close instead of touching a real socket. */
    close() { this.closed = true; },
    /**
     * Record the frame instead of putting it on a wire.
     * @param {string} payload - The serialized frame.
     */
    send(payload) { this.frames.push(payload); }
  });

  /**
   * A service whose link is up on a fake transport, with the reconnect loop
   * stubbed out so a test can drive the watchdog without opening real sockets.
   * @returns {{svc: WebSocketService, transport: any, attempts: () => number}} Service under test.
   */
  const live = () => {
    const svc = new WebSocketService();
    const transport = makeTransport();
    svc._transport = transport;
    svc._reestablish = () => {}; // never re-open anything from a unit test
    svc.connected = true;
    svc._lastInboundAt = Date.now();
    svc._lastOutboundAt = Date.now();
    let attempts = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    return { svc, transport, attempts: () => attempts };
  };

  /**
   * The frames a fake transport was sent, parsed.
   * @param {any} transport - A makeTransport() stub.
   * @returns {any[]} Parsed frames.
   */
  const framesOf = (transport) => transport.frames.map((/** @type {string} */ f) => JSON.parse(f));

  /**
   * A DataChannel stand-in: the transport stub plus the listener surface the
   * WebRTC handshake subscribes its open/error promise to.
   * @returns {any} Fake data channel.
   */
  const makeChannel = () => Object.assign(makeTransport(), {
    /** Ignore the open/error subscriptions — the handshake is driven directly. */
    addEventListener() {},
    /** Ignore removals, for the same reason. */
    removeEventListener() {}
  });

  /**
   * Start a real WebRTC attempt against a peer connection the test owns. The
   * offer settles only when the case fails it, so the attempt stays in flight
   * for exactly as long as the case needs it there — which is the window the
   * whole generation question lives in.
   *
   * There is no real RTCPeerConnection in a test lane, and the page is not
   * served over https, so both the constructor and the transport choice are
   * stood in for. The relay is counted rather than opened.
   * @param {WebSocketService} svc - The service to connect.
   * @returns {{channel: any, pc: any, sockets: () => number, fail: (error: Error) => void}} Handles on the attempt.
   */
  const startWebRtcAttempt = (svc) => {
    const channel = makeChannel();
    /** @type {(error: Error) => void} */
    let failOffer = () => {};
    const offer = new Promise((_resolve, reject) => { failOffer = reject; });
    const pc = {
      iceGatheringState: 'complete',
      closes: 0,
      /** @returns {any} The channel this attempt hands the service. */
      createDataChannel: () => channel,
      /** @returns {Promise<any>} An offer that hangs until the case fails it. */
      createOffer: () => offer,
      /** @returns {Promise<void>} */
      setLocalDescription: async () => {},
      /** Count the close, so a leaked peer connection is visible. */
      close() { this.closes++; },
      /** Ignore ICE-gathering subscriptions; gathering is already complete. */
      addEventListener() {},
      /** Ignore removals, for the same reason. */
      removeEventListener() {}
    };
    let sockets = 0;
    svc._shouldTryWebRTC = () => true;
    svc._connectWebSocket = () => { sockets++; };
    const g = /** @type {any} */ (globalThis);
    const had = Object.prototype.hasOwnProperty.call(g, 'RTCPeerConnection');
    const previous = g.RTCPeerConnection;
    Object.defineProperty(g, 'RTCPeerConnection', {
      configurable: true, writable: true, value: function () { return pc; }
    });
    try {
      // The handshake arms the channel's own open timeout synchronously.
      // Capture it, so nothing of this attempt rejects into a later case.
      captureScheduled(() => svc.connect());
    } finally {
      if (had) g.RTCPeerConnection = previous; else delete g.RTCPeerConnection;
    }
    svc._reestablish = () => {}; // never re-open anything from a unit test
    return { channel, pc, sockets: () => sockets, fail: failOffer };
  };

  /**
   * Stop the timers connect() started and put the service beyond caring, so a
   * case cannot outlive itself through the wake listeners or a pending backoff.
   * @param {WebSocketService} svc - The service under test.
   */
  const retire = (svc) => {
    svc._intentionalDisconnect = true;
    svc._stopLinkWatchdog();
  };

  /**
   * A WebRTC attempt that was condemned by the connect-stall check while it was
   * still handshaking, replaced by a live link, and only then rejected.
   * @returns {Promise<{svc: WebSocketService, replacement: any, channel: any, pc: any, sockets: () => number}>} The service and what it holds.
   */
  const abandonedWebRtcAttempt = async () => {
    const svc = new WebSocketService();
    const { channel, pc, sockets, fail } = startWebRtcAttempt(svc);
    // The handshake neither opens nor fails, so the watchdog condemns it and the
    // death path installs its replacement in the same turn.
    svc._connectStartedAt = Date.now() - 600000;
    svc._checkLink();
    const replacement = makeTransport();
    svc._transport = replacement;
    // Only now does the abandoned handshake give up.
    fail(new Error('ICE went nowhere'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { svc, replacement, channel, pc, sockets };
  };

  /**
   * A viewer service whose socket has just reopened after a genuine drop, with
   * the 'open' event still withheld pending the session message.
   * @param {string|null} recordedBootId - The boot id this page recorded on its first connection.
   * @returns {{svc: WebSocketService, transport: any, reloads: () => number, opens: () => number}} Service under test and its counters.
   */
  const reconnecting = (recordedBootId) => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true; // the throttle has its own cases
    let reloaded = 0;
    let opened = 0;
    svc._reloadPage = () => { reloaded++; };
    svc.on('open', () => { opened++; });
    svc.serverBootId = recordedBootId;
    const transport = makeTransport();
    svc._configureTransport(transport, 'WebSocket');
    svc._transport = transport;
    svc._reconnectAttempts = 3;
    transport.onopen(new Event('open'));
    return { svc, transport, reloads: () => reloaded, opens: () => opened };
  };

  /**
   * The session frame the server seeds every connection with.
   * @param {string} [bootId] - The server instance's boot id; omitted entirely when undefined.
   * @returns {string} Raw JSON frame.
   */
  const sessionFrame = (bootId) => JSON.stringify(
    bootId === undefined
      ? { type: 'session', clientId: 'client-1' }
      : { type: 'session', clientId: 'client-1', bootId }
  );

  await run('non-intentional transport death enters the shared reconnect loop', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._reestablish = () => {}; // socket primitive stub
    let attempts = 0;
    let closes = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    svc.on('close', () => { closes++; });
    // A real link drop with no intentional/suppress flags set.
    svc._onTransportClosed(new Event('close'), null);
    // Stop the pending backoff timer from firing the stub after the test.
    svc._intentionalDisconnect = true;
    assert(svc.connected === false, 'link marked down on close');
    assert(closes === 1, `close emitted once; got ${closes}`);
    assert(attempts === 1, `entered the backoff loop (reconnect-attempt emitted); got ${attempts}`);
  });

  await run('intentional disconnect does NOT enter the reconnect loop', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._intentionalDisconnect = true;
    const attempts = countEvent(svc, 'reconnect-attempt', () => {
      svc._onTransportClosed(new Event('close'), null);
    });
    assert(attempts === 0, `intentional disconnect must not reconnect; got ${attempts} attempts`);
    assert(svc.connected === false, 'still marked down');
  });

  await run('expected failed-probe close skips reconnect and clears the suppress flag', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._suppressNextCloseReconnect = true;
    const attempts = countEvent(svc, 'reconnect-attempt', () => {
      svc._onTransportClosed(new Event('close'), null);
    });
    assert(attempts === 0, `suppressed close must not reconnect; got ${attempts} attempts`);
    assert(svc._suppressNextCloseReconnect === false, 'suppress flag is consumed (one-shot)');
  });

  await run('backoff timer fires the current transport re-establish primitive', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    const cb = captureScheduled(() => svc._reconnect());
    assert(cb, 'a backoff timer was scheduled');
    assert(reestablished === 0, 're-establish is deferred to the timer, not called synchronously');
    cb?.();
    assert(reestablished === 1, `timer invoked the transport primitive; got ${reestablished}`);
  });

  await run('death handler routes into the same loop that fires the primitive (generic policy)', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    // Capture the timer scheduled by the death → _reconnect path.
    const cb = captureScheduled(() => svc._onTransportClosed(new Event('close'), null));
    assert(cb, 'transport death scheduled a backoff timer');
    cb?.();
    assert(reestablished === 1, `the death path drives the same re-establish primitive; got ${reestablished}`);
  });

  await run('one death arms one backoff loop, however often the transport announces it', async () => {
    const { svc, transport, attempts } = live();
    // A DataChannel fires both 'error' and 'close'; a link the watchdog drops
    // closes for real just after we handled it. Either way it is one death.
    svc._onTransportClosed(new Event('error'), transport);
    svc._onTransportClosed(new Event('close'), transport);
    svc._intentionalDisconnect = true;
    assert(attempts() === 1, `a repeated death must not arm a second loop; got ${attempts()} attempts`);
  });

  await run('the stall watchdog drops a link that has stopped delivering', async () => {
    const { svc, transport, attempts } = live();
    // Past every tolerance: on a healthy idle link the server's beat arrives
    // within ~20s, so this is several missed beats.
    svc._lastInboundAt = Date.now() - 600000;
    svc._checkLink();
    svc._intentionalDisconnect = true;
    assert(transport.closed === true, 'the dead transport is closed rather than waited on');
    assert(svc.connected === false, 'and the link is reported down');
    assert(attempts() === 1, `the drop routes through the normal death path; got ${attempts()} attempts`);
  });

  await run('an idle but beating link is left alone', async () => {
    const { svc, transport, attempts } = live();
    // One beat window of quiet, which is what a reading user looks like.
    svc._lastInboundAt = Date.now() - 20000;
    svc._checkLink();
    svc._intentionalDisconnect = true;
    assert(transport.closed === false, 'a quiet link is not a dead one — nobody may be dropped for reading');
    assert(svc.connected === true, 'the link stays up');
    assert(attempts() === 0, `and no reconnect is armed; got ${attempts()}`);
  });

  await run('a quiet link is beaten to so the server knows the viewer is there', async () => {
    const { svc, transport } = live();
    svc._lastOutboundAt = Date.now() - 20000;
    svc._checkLink();
    svc._intentionalDisconnect = true;
    const beats = framesOf(transport).filter((/** @type {any} */ f) => f.type === 'viewer-heartbeat');
    assert(beats.length === 1, `a viewer that says nothing gets closed server-side; got ${beats.length} beats`);
  });

  await run('a link with traffic on it costs no beat', async () => {
    const { svc, transport } = live();
    svc._lastOutboundAt = Date.now(); // just sent something real
    svc._checkLink();
    svc._intentionalDisconnect = true;
    assert(transport.frames.length === 0, `a busy link needs no beat; got ${transport.frames.length} frames`);
  });

  await run('a connection attempt that hangs is abandoned rather than waited out', async () => {
    const { svc, transport, attempts } = live();
    svc.connected = false;
    svc._connecting = true;
    svc._connectStartedAt = Date.now() - 600000; // opened into a network that is gone
    svc._checkLink();
    svc._intentionalDisconnect = true;
    assert(transport.closed === true, 'the stuck attempt is closed');
    assert(attempts() === 1, `and replaced with a fresh one; got ${attempts()} attempts`);
  });

  await run('the first retry is fast, and every tier is jittered', async () => {
    const svc = new WebSocketService();
    /**
     * Sample one tier repeatedly, so its spread is visible.
     * @param {number} attempt - 1-based attempt number.
     * @returns {number[]} Sampled delays in ms.
     */
    const spread = (attempt) => Array.from({ length: 40 }, () => svc._backoffDelay(attempt));

    const first = spread(1);
    assert(Math.max(...first) < 1000, `the first retry must beat the old 1s floor; got ${Math.max(...first)}ms`);
    assert(Math.min(...first) >= 100, `but not hammer the server either; got ${Math.min(...first)}ms`);

    // Jitter exists on every tier, so viewers of a restarted server do not come
    // back in lockstep.
    for (const attempt of [1, 2, 60, 200]) {
      const delays = spread(attempt);
      assert(new Set(delays).size > 1, `tier for attempt ${attempt} must be jittered, not fixed`);
    }

    // And the tiers still ease off for an outage that is clearly not ending.
    assert(Math.max(...spread(2)) < Math.min(...spread(60)), 'the 1s tier stays under the 2s tier');
    assert(Math.max(...spread(60)) < Math.min(...spread(200)), 'the 2s tier stays under the 5s tier');
  });

  await run('a link that opens and dies straight back does not stay pinned at the first tier', async () => {
    const svc = new WebSocketService();
    svc._reestablish = () => {};
    /** @type {number[]} */
    const delays = [];
    svc.on('reconnect-attempt', (/** @type {any} */ d) => { delays.push(d.delayMs); });

    // A flap: the handshake completes and the link settles, then the socket is
    // gone again before it has proven anything. Five in a row — a server that
    // accepts the upgrade and immediately drops it, which is what a restarting
    // one and a saturated test pool both look like from here.
    for (let i = 0; i < 5; i++) {
      svc._settleOpen(undefined);
      svc.connected = false;
      svc._reconnect();
    }
    svc._intentionalDisconnect = true;
    svc._stopLinkWatchdog();

    assert(delays.length === 5, `each flap arms exactly one retry; got ${delays.length}`);
    // The first tier is 300ms ±25%, so anything at or under 375ms is still it.
    const later = delays.slice(1);
    assert(
      Math.max(...later) > 375,
      `a link that keeps dying must ease off rather than reconnect at the first tier forever; delays were ${delays.join('ms, ')}ms`
    );
  });

  await run('a link that stays up long enough earns its fast first retry back', async () => {
    const svc = new WebSocketService();
    svc._reestablish = () => {};
    svc._reconnectAttempts = 7; // it took a while to get here
    svc._settleOpen(undefined);
    assert(
      svc._reconnectAttempts === 7,
      'settling alone proves nothing — a link that dies immediately would reset the backoff it earned'
    );
    svc._proveLinkStable();
    assert(
      svc._reconnectAttempts === 0,
      `a link that survives is a good one and starts fresh; got ${svc._reconnectAttempts}`
    );
    svc._intentionalDisconnect = true;
    svc._stopLinkWatchdog();
  });

  await run('a page that becomes visible retries at once instead of waiting out the backoff', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    svc.connected = false;
    // A backoff timer is already counting down when the page comes back.
    const pending = captureScheduled(() => svc._reconnect());
    assert(pending, 'the loop was armed');
    svc._wake('the page became visible');
    assert(reestablished === 1, `waking retries immediately; got ${reestablished}`);
    // A burst — 'online' and 'visibilitychange' arrive together — must not stack
    // attempts on top of each other.
    svc._wake('the browser says the network is back');
    svc._wake('the page became visible');
    assert(reestablished === 1, `a burst of wake signals starts one attempt; got ${reestablished}`);
    svc._intentionalDisconnect = true;
  });

  await run('a wake signal leaves a fresh connection attempt alone', async () => {
    const svc = new WebSocketService();
    const transport = makeTransport();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    svc._transport = transport;
    svc.connected = false;
    // The attempt the first signal of a burst started, still handshaking.
    svc._connecting = true;
    const startedAt = Date.now();
    svc._connectStartedAt = startedAt;
    svc._wake('the browser says the network is back');
    svc._intentionalDisconnect = true;
    assert(reestablished === 0, `a handshake under way is not raced by a second socket; got ${reestablished}`);
    assert(transport.closed === false, 'and is not condemned either');
    assert(svc._connectStartedAt === startedAt, 'the attempt keeps its own clock, so the grace cannot be renewed forever');
  });

  await run('a wake signal replaces a stale connection attempt instead of waiting for the watchdog', async () => {
    const svc = new WebSocketService();
    const transport = makeTransport();
    let reestablished = 0;
    let reloaded = 0;
    svc._reestablish = () => { reestablished++; };
    svc._reloadPage = () => { reloaded++; };
    svc._shouldReloadOnReconnect = () => true; // the throttle must not be what saves us here
    svc._transport = transport;
    svc.connected = false;
    // An attempt that opened before the page went under and parked waiting for a
    // session message that never came: outstanding, unanswered, and pointed at a
    // network that has since changed.
    svc._connecting = true;
    svc._connectStartedAt = Date.now() - 600000;
    svc._reconnectPending = true;
    const announced = countEvent(svc, 'reconnect-attempt', () => {
      svc._wake('the page became visible');
    });
    assert(transport.closed === true, 'the stale attempt is abandoned, not left for the connect-stall check');
    assert(announced === 1, `only the attempt made here is announced, not the backoff it replaced; got ${announced}`);
    assert(reestablished === 1, `and replaced in the same turn; got ${reestablished}`);
    assert(reloaded === 0, `a link we condemned says nothing about the server; got ${reloaded} reloads`);
    assert(svc._retryTimer === null, 'no backoff timer is left counting down behind the attempt that replaced it');
    assert(svc._reconnectAttempts === 1, `the abandoned attempt escalates the backoff; got ${svc._reconnectAttempts}`);
    // The replacement is itself a fresh attempt, so the rest of the burst leaves
    // it alone.
    svc._wake('the browser says the network is back');
    svc._intentionalDisconnect = true;
    assert(reestablished === 1, `the replacement gets the same grace; got ${reestablished}`);
  });

  await run('an abandoned WebRTC attempt cannot touch the link that replaced it', async () => {
    const { svc, replacement, pc, sockets } = await abandonedWebRtcAttempt();
    retire(svc);
    assert(svc._suppressNextCloseReconnect === false, 'a handshake nobody is waiting for may not suppress anything');
    assert(svc._transport === replacement, 'nor take away the transport its replacement installed');
    assert(sockets() === 0, `nor relay for a link that is not its own; got ${sockets()} sockets`);
    assert(pc.closes >= 1, 'and it still closes its own peer connection, condemned or not');
  });

  await run('a genuine death after an abandoned WebRTC attempt still reconnects', async () => {
    const { svc, replacement } = await abandonedWebRtcAttempt();
    // The suppress flag is a one-shot: armed by an attempt that no longer speaks
    // for anything, it would be spent on the next real death and leave the page
    // disconnected with nothing counting down.
    const attempts = countEvent(svc, 'reconnect-attempt', () => {
      svc._onTransportClosed(new Event('close'), replacement);
    });
    retire(svc);
    assert(attempts === 1, `the death of the replacement must arm the loop; got ${attempts} attempts`);
  });

  await run('a WebRTC probe that fails while it is still the current attempt falls back to the relay', async () => {
    const svc = new WebSocketService();
    const { pc, sockets, fail } = startWebRtcAttempt(svc);
    // Nothing condemned this one: it is simply a host that cannot be reached
    // directly, which is what the relay exists for.
    fail(new Error('ICE went nowhere'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(sockets() === 1, `a failed probe must be relayed over instead; got ${sockets()} sockets`);
    assert(svc._suppressNextCloseReconnect === true, 'and its own close is an expected one, not a link death');
    assert(pc.closes >= 1, 'the probe closes its peer connection');
    retire(svc);
  });

  await run('waking on a link that went quiet under us drops it rather than trusting it', async () => {
    const { svc, transport, attempts } = live();
    // The page believes it is connected because nothing was running to notice
    // otherwise — the socket died while the laptop was shut.
    svc._lastInboundAt = Date.now() - 120000;
    svc._wake('the page became visible');
    svc._intentionalDisconnect = true;
    assert(transport.closed === true, 'a link with no recent traffic is not taken on trust after a wake');
    assert(attempts() === 1, `and recovery starts immediately; got ${attempts()}`);
  });

  await run('waking on a live link leaves it alone', async () => {
    const { svc, transport, attempts } = live();
    svc._wake('the page became visible');
    svc._intentionalDisconnect = true;
    assert(transport.closed === false, 'a link that is plainly alive must survive a tab switch');
    assert(attempts() === 0, `and cost no reconnect; got ${attempts()}`);
  });

  await run('the browser reporting the network back drives the same retry', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    svc.connected = false;
    svc._installWakeListeners();
    globalThis.dispatchEvent(new Event('online'));
    svc._intentionalDisconnect = true;
    assert(reestablished === 1, `an 'online' event must retry at once; got ${reestablished}`);
  });

  await run('the page becoming visible drives the same retry', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    svc.connected = false;
    svc._installWakeListeners();
    // The pool's test lanes are never painted, so the page's real visibility is
    // not the state under test — the handler's reading of it is.
    const shown = { configurable: true, get: () => 'visible' };
    Object.defineProperty(document, 'visibilityState', shown);
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      // @ts-ignore - restoring the prototype's accessor
      delete document.visibilityState;
    }
    svc._intentionalDisconnect = true;
    assert(reestablished === 1, `becoming visible must retry at once; got ${reestablished}`);
  });

  await run('a hidden page is not woken by a visibilitychange', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    svc.connected = false;
    svc._installWakeListeners();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      // @ts-ignore - restoring the prototype's accessor
      delete document.visibilityState;
    }
    svc._intentionalDisconnect = true;
    assert(reestablished === 0, `going away is not waking up; got ${reestablished}`);
  });

  await run('studio re-establish reloads directly to recover (no health probe over the dead tunnel)', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true; // bypass the rate-limiter
    let reloaded = 0;
    let fetched = 0;
    svc._reloadPage = () => { reloaded++; };
    const origFetch = globalThis.fetch;
    // @ts-ignore - test stub: recovery must NOT depend on any fetch (it would be
    // tunneled through the dead DataChannel and 504 forever).
    globalThis.fetch = async () => { fetched++; return { ok: true }; };
    try {
      await svc._reloadWhenReachable();
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(reloaded === 1, `link death → reload to recover; got ${reloaded}`);
    assert(fetched === 0, `recovery must not probe the network (circular over studio); got ${fetched} fetches`);
  });

  await run('studio re-establish re-arms the loop instead of reloading when throttled', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => false; // rate-limiter says "too soon"
    let reloaded = 0;
    let rearmed = 0;
    svc._reloadPage = () => { reloaded++; };
    svc._reconnect = () => { rearmed++; };
    await svc._reloadWhenReachable();
    assert(reloaded === 0, 'must NOT reload while throttled (no reload storm)');
    assert(rearmed === 1, `throttled reload re-arms the same backoff loop; got ${rearmed}`);
  });

  await run('studio re-establish aborts cleanly if the link already recovered', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true;
    svc.connected = true; // link came back before the primitive ran
    let reloaded = 0;
    let rearmed = 0;
    svc._reloadPage = () => { reloaded++; };
    svc._reconnect = () => { rearmed++; };
    await svc._reloadWhenReachable();
    assert(reloaded === 0, 'no reload once the link is already back');
    assert(rearmed === 0, 'no needless re-arm once connected');
  });

  await run('a reconnect withholds open until the server says which server it is', async () => {
    const { svc, opens } = reconnecting('boot-1');
    assert(opens() === 0, `open is withheld while the server is unidentified; got ${opens()}`);
    assert(svc.connected === false, 'the link is not reported up while undecided');
  });

  await run('an unchanged boot id catches up: open is released and nothing reloads', async () => {
    const { svc, reloads, opens } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame('boot-1'));
    assert(reloads() === 0, `the same server must not cost a reload; got ${reloads()}`);
    assert(opens() === 1, `open released once the server matched; got ${opens()}`);
    assert(svc.connected === true, 'the link is up');
    // NOT reset here. Settling means the socket opened, which a server that is
    // restarting does on every attempt while dropping each one a moment later;
    // crediting the open itself pinned the backoff at its first tier and turned
    // that into three reconnects a second. The counter is forgiven by a link
    // that lasts (see the flap cases above), not by one that merely arrives.
    assert(svc._reconnectAttempts > 0, 'settling alone must not forgive the backoff');
    // 'open' IS the catch-up: ConnectionManager's open handler is what runs the
    // state-vector resync. The live case at the end of this file drives that
    // whole chain against the real server.
  });

  await run('a changed boot id reloads: the page belongs to a server that is gone', async () => {
    const { svc, reloads, opens } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame('boot-2'));
    assert(reloads() === 1, `a restarted server must reload the page; got ${reloads()}`);
    assert(opens() === 0, 'a page on its way out never reports the link up');
    assert(svc.connected === false, 'and never treats the link as usable');
  });

  await run('a reconnect with no boot id recorded reloads (nothing to compare against)', async () => {
    const { reloads, svc } = reconnecting(null);
    svc._handleMessageData(sessionFrame('boot-1'));
    assert(reloads() === 1, `an unverifiable reconnect must reload; got ${reloads()}`);
  });

  await run('a session that carries no boot id reloads (same reason)', async () => {
    const { reloads, svc } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame(undefined));
    assert(reloads() === 1, `a server that will not name itself must reload; got ${reloads()}`);
  });

  await run('a reconnect that dies before identifying the server reloads', async () => {
    const { svc, transport, reloads } = reconnecting('boot-1');
    let attempts = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    // The signature of a restarted server: it completes the upgrade, then closes
    // the socket because this page's token belongs to the process it replaced.
    transport.onclose(new Event('close'));
    assert(reloads() === 1, `an open that dies unidentified must reload; got ${reloads()}`);
    assert(attempts === 0, 'and must not also re-arm the loop it is reloading out of');
  });

  await run('a watchdog drop while the server is unidentified retries instead of reloading', async () => {
    const { svc, transport, reloads, opens } = reconnecting('boot-1');
    svc._reestablish = () => {}; // never re-open anything from a unit test
    let attempts = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    // The socket completed locally into a network that is not really there, so
    // the session message never arrives and the park never settles. The
    // connect-stall check is what bounds that.
    svc._connecting = true;
    svc._connectStartedAt = Date.now() - 600000;
    svc._checkLink();
    svc._intentionalDisconnect = true;
    assert(transport.closed === true, 'the stuck park is closed rather than waited on');
    assert(reloads() === 0, `a link we condemned says nothing about the server; got ${reloads()} reloads`);
    assert(opens() === 0, 'and nothing was cleared to carry on');
    assert(attempts === 1, `the backoff loop is re-armed instead; got ${attempts} attempts`);
    assert(svc._reconnectAttempts === 4, `and it escalates from where it was; got ${svc._reconnectAttempts}`);
    assert(svc._reconnectPending === false, 'the park is over either way');
  });

  await run('a death the far end caused during the same park still reloads', async () => {
    const { svc, transport, reloads } = reconnecting('boot-1');
    svc._reestablish = () => {};
    let attempts = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    // The control for the case above: same park, but the socket dies on its own
    // — the signature of a server that replaced the process this page belongs to.
    transport.onclose(new Event('close'));
    svc._intentionalDisconnect = true;
    assert(reloads() === 1, `an open that dies unidentified must still reload; got ${reloads()}`);
    assert(attempts === 0, 'and must not also re-arm the loop it is reloading out of');
  });

  await run('the self-inflicted mark is spent on one death, not the next', async () => {
    const { svc, reloads } = reconnecting('boot-1');
    svc._reestablish = () => {};
    svc._connecting = true;
    svc._connectStartedAt = Date.now() - 600000;
    svc._checkLink();
    assert(reloads() === 0, 'the drop we inflicted did not reload');

    // The retry opens a second socket, which parks the same way and is then
    // closed by the far end. That one is a restarted server and must reload.
    const next = makeTransport();
    svc._configureTransport(next, 'WebSocket');
    svc._transport = next;
    next.onopen(new Event('open'));
    assert(svc._reconnectPending === true, 'the fresh socket parks pending the session message');
    next.onclose(new Event('close'));
    svc._intentionalDisconnect = true;
    assert(reloads() === 1, `the mark must not have carried over and swallowed a real flap; got ${reloads()}`);
  });

  await run('a restart while throttled drops the link and re-arms the loop instead of storming', async () => {
    const { svc, transport, reloads, opens } = reconnecting('boot-1');
    svc._shouldReloadOnReconnect = () => false; // rate-limiter says "too soon"
    let rearmed = 0;
    svc._reconnect = () => { rearmed++; };
    svc._handleMessageData(sessionFrame('boot-2'));
    assert(reloads() === 0, 'must NOT reload while throttled (no reload storm)');
    assert(opens() === 0, 'and must not carry on against a server that knows nothing of this page');
    assert(transport.closed === true, 'the connection to the restarted server is dropped');
    assert(rearmed === 1, `the backoff loop is re-armed so the overlay keeps counting; got ${rearmed}`);
  });

  await run('the engine settles its reconnect at once (it has no page to go stale)', async () => {
    const g = /** @type {any} */ (globalThis);
    const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
    const previous = g.JUGGLER_ENGINE;
    g.JUGGLER_ENGINE = true;
    try {
      const svc = new WebSocketService();
      let reloaded = 0;
      let opened = 0;
      svc._reloadPage = () => { reloaded++; };
      svc._shouldReloadOnReconnect = () => true;
      svc.on('open', () => { opened++; });
      const transport = makeTransport();
      svc._configureTransport(transport, 'WebSocket');
      svc._reconnectAttempts = 3;
      transport.onopen(new Event('open'));
      assert(opened === 1, `the engine's open is released immediately; got ${opened}`);
      assert(reloaded === 0, 'the engine never reloads — resync is its only recovery');
      assert(svc.connected === true, 'the engine link is up straight away');
    } finally {
      if (had) g.JUGGLER_ENGINE = previous; else delete g.JUGGLER_ENGINE;
    }
  });

  // The whole policy against the real server, on this page's live socket: the
  // boot id it sends is stable across a reconnect, so the page stays and its
  // 'open' is released — which is what sets the resync off (ConnectionManager's
  // open handler; this page deliberately doesn't load app.js, so that handler
  // isn't here, and resync-offline-edit-test drives the recovery itself over
  // this same reconnect path). Everything above stubs the server; this is the
  // case that catches the two of them disagreeing.
  await run('a real reconnect to the same server carries on without reloading', async () => {
    const originalReload = wsService._reloadPage;
    let reloaded = 0;
    let opens = 0;
    const onOpen = () => { opens++; };
    wsService._reloadPage = () => { reloaded++; };
    wsService.on('open', onOpen);
    try {
      // The harness opens this page's socket by waiting on 'open', and the
      // session frame lands a turn later — so it can still be in flight when a
      // unit suite begins. Wait for the server to have named itself.
      await waitFor(
        () => typeof wsService.serverBootId === 'string' && wsService.serverBootId.length > 0,
        { timeoutMs: 5000, description: 'the server to name itself in the session message' }
      );
      const bootIdBefore = wsService.serverBootId;

      await wsService.simulateDisconnect();
      // simulateDisconnect is a clean teardown, so it leaves the attempt counter
      // at zero. A real drop does not — set it, so this reconnects as one.
      wsService._reconnectAttempts = 1;
      await wsService.reconnect();

      assert(reloaded === 0, `an unchanged boot id must not reload; got ${reloaded}`);
      assert(wsService.serverBootId === bootIdBefore, 'still talking to the same server');
      assert(wsService.connected === true, 'the link is up again');
      assert(opens === 1, `open released once the server matched, which is what runs the resync; got ${opens}`);
    } finally {
      wsService._reloadPage = originalReload;
      wsService.off('open', onOpen);
    }
  });

  return { passed, failed, errors };
}
