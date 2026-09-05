//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { recordTape } from '../utils/event-tape.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { fetchJson } from './http.js';
import { WSChunkReassembler, WS_CHUNK_KIND_TEXT } from '../utils/ws-chunk.js';
import { viewerId } from '../utils/viewer-id.js';

const WEBRTC_CHUNK_TYPE = '__juggler_dc_chunk';
const WEBRTC_CHUNK_SIZE = 16 * 1024;

// Link liveness. The server sends a beat whenever it has had nothing to say for
// serverBeatInterval (cmd/juggler/server/link_liveness.go), and checks each link
// on a tick of a third of that — so on a healthy but idle link, the longest
// legitimate gap between inbound messages is one beat interval plus one tick:
// 20 seconds. Everything below is measured in that window.
//
// This matters because a link can die without either end being told. A half-open
// TCP connection — a laptop suspended mid-turn, a phone off wifi, a NAT dropping
// a mapping — has no RST to deliver, so the page sits on a socket that will never
// speak again until the kernel gives up minutes later.

/** How often the link is examined: inbound stall, outbound beat, stuck connect. */
const LINK_CHECK_MS = 5000;

/** How long this client may stay quiet before it says it is still here. Mirrors serverBeatInterval. */
const VIEWER_BEAT_MS = 15000;

/**
 * How long the link may produce nothing before it is presumed dead. Three beat
 * windows (60s vs the 20s worst-case gap), so two consecutive beats must go
 * missing before a link is dropped — a link that merely stalled for a few
 * seconds, or a page whose timers were starved by a busy main thread, is never
 * mistaken for a dead one. The server's own patience is longer still
 * (viewerSilenceWindow, 75s), so a viewer always heals its link before the
 * server gives up on it.
 */
const LINK_STALL_MS = 60000;

/**
 * How long a connection attempt may hang before it is abandoned. An attempt that
 * neither opens nor fails is the shape of a wake-from-sleep: the socket was
 * created into a network that is no longer there, and nothing will ever complete
 * or fail it. Generous, because a genuine handshake over a bad link is slow.
 */
const CONNECT_STALL_MS = 20000;

/**
 * How long a wake signal tolerates silence before dropping the link. A beat
 * should have landed within 20s, so nothing at 30s means the link did not
 * survive whatever the page just came back from — no reason to wait out the
 * full stall threshold.
 */
const WAKE_STALE_MS = 30000;

/**
 * How recently a connection attempt must have started for a wake signal to leave
 * it alone. Wake signals arrive in bursts, and the attempt the first one starts
 * is still handshaking when the rest land. Beyond that window the attempt is not
 * a live one but one that went under with the page — see
 * {@link WebSocketService#_retryNow}.
 */
const WAKE_ATTEMPT_GRACE_MS = 3000;

/**
 * First retry after a link drops. Most drops are momentary, and the old floor of
 * a full second was a second of nothing on every one of them.
 */
const RECONNECT_FIRST_DELAY_MS = 300;

/**
 * Fraction each backoff delay is spread by, in both directions. Several viewers
 * of one server all drop at the same instant when it restarts; without this they
 * would return in lockstep, every tier, for as long as the outage lasts.
 */
const RECONNECT_JITTER = 0.25;

/**
 * How long a link must stay up before the backoff it cost is forgiven.
 *
 * Opening is not the same as working. A server that accepts the upgrade and
 * drops the socket a moment later — restarting, overloaded, or refusing a token
 * it no longer recognises — produces an unbroken run of successful opens, and
 * crediting each of them resets the backoff to its first tier every time. The
 * viewer then reconnects three times a second for as long as the far end keeps
 * doing it, which is load applied exactly when the server can least afford it.
 *
 * Ten seconds is well past a handshake and well short of anything a user would
 * call a session, so a link that clears it has demonstrably carried traffic.
 */
const LINK_STABLE_AFTER_MS = 10000;

/**
 * @typedef {'open'|'close'|'error'|'message'|'session'|'file-change'|'project-changed'|'plugin-changed'|'retry'|'streaming-error'|'providers-update'|'providers-ready'|'shell-output'|'reconnect-attempt'|'engine-bridge'|'update-status'|'clients-changed'|'pinboard-changed'|'pinboard-reveal'|'viewer-relay'} WSEventType
 */

/**
 * @typedef {'text'|'thinking'|'redacted_thinking'|'tool_use'|'tool_result'|'citation'|'image'|'code'|'code_result'} ContentBlockType
 */

/**
 * @typedef {object} ContentBlock
 * @property {ContentBlockType} type - The type of content block
 * @property {string} [content] - The content of the block
 * @property {string} [text] - Text content (for text blocks from API)
 * @property {string} [thinking] - Thinking content (for thinking blocks from API)
 * @property {string} [signature] - Thinking signature (for thinking blocks from Anthropic)
 * @property {string} [id] - Tool use ID (API format)
 * @property {string} [name] - Tool name (API format)
 * @property {{[key: string]: unknown}} [input] - Tool input (API format)
 * @property {string} [toolUseId] - Tool use ID (internal format)
 * @property {string} [toolName] - Tool name (internal format)
 * @property {{[key: string]: unknown}} [toolInput] - Tool input parameters (internal format)
 * @property {{[key: string]: unknown}} [metadata] - Provider-specific metadata (citations, signatures, etc.)
 */

/**
 * @typedef {function(unknown): void} WSEventCallback
 */

/**
 * WebSocket service for real-time communication with Juggler backend
 * @class
 */
class WebSocketService {
  constructor() {
    /** @type {WebSocket|RTCDataChannel|null} @private */
    this._transport = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {string|null} - This client's server-assigned id, from the session message. Used to exclude self from the connected-clients list. */
    this.clientId = null;
    /** @type {string} - This viewer's own id as the server accepted it; '' when nothing can address this viewer. */
    this.viewerId = '';
    /**
     * The server instance this page belongs to, taken from the session message's
     * boot id. Recorded on the first session message and compared on every
     * reconnect — see {@link WebSocketService#_resolveReconnect}.
     * @type {string|null}
     */
    this.serverBootId = null;
    /**
     * Set while a viewer's reconnect waits for the session message that says
     * which server answered. The 'open' event is withheld for that window
     * (parked in {@link WebSocketService#_heldOpenEvent}), because everything
     * downstream of 'open' treats the link as one worth catching up over, and
     * against a restarted server it is not.
     * @type {boolean} @private
     */
    this._reconnectPending = false;
    /** @type {Event|undefined} @private - The withheld 'open' event, released once the server is identified. */
    this._heldOpenEvent = undefined;
    /** @type {string} @private - Name of the current transport, for the connected log line. */
    this._transportLabel = 'WebSocket';
    /** @type {number} @private */
    this._reconnectAttempts = 0;
    /** @type {boolean} @private */
    this._intentionalDisconnect = false;
    /** @type {boolean} @private */
    this._suppressNextCloseReconnect = false;
    /**
     * Which connection attempt is the current one. Every attempt captures this
     * as it starts, and an attempt whose captured value no longer matches has
     * been superseded or condemned: the transport, the suppress-reconnect flag
     * and the choice of what to fall back to all belong to the attempt that
     * replaced it, and a handshake that only settles afterwards may not write
     * over any of them. See {@link WebSocketService#_supersedeAttempt}.
     * @type {number} @private
     */
    this._attemptGeneration = 0;
    /**
     * Whether {@link WebSocketService#_reconnect} announces the countdown it is
     * arming. Cleared for the span of a drop whose timer is replaced by an
     * immediate attempt — see {@link WebSocketService#_retryNow}, whose own
     * announcement is the one listeners can act on.
     * @type {boolean} @private
     */
    this._announceReconnect = true;
    /**
     * One-shot mark, set by {@link WebSocketService#_dropLink} for the single
     * death it is about to hand to {@link WebSocketService#_onTransportClosed}
     * and consumed there. It separates a link we condemned from one the other
     * end closed, which is the whole of the difference between a bad link and a
     * server that restarted — see the unidentified-death branch of
     * _onTransportClosed.
     * @type {boolean} @private
     */
    this._selfInflictedDrop = false;
    /**
     * How to re-establish the CURRENT transport after the link drops. Set by
     * connect() to a transport-specific thunk so the backoff loop in
     * _reconnect() stays transport-agnostic: every transport drops into the
     * same detect → back off → re-establish → repeat policy, differing only in
     * this one primitive.
     *   - WebSocket / WebRTC-LAN: reopen the socket; its own open/close events
     *     re-drive the loop.
     *   - juggler.studio: reload the page (the only way to re-run the external
     *     bootstrap's WebRTC handshake), gated on a server reachability probe
     *     so a still-dead link can't cause a reload storm.
     * @type {(() => void)|null} @private
     */
    this._reestablish = null;
    /**
     * When a message last arrived on the transport, as epoch ms; 0 before the
     * first one. This is the only honest evidence the link is alive, so it is
     * stamped by EVERY inbound message rather than by the beat alone.
     * @type {number} @private
     */
    this._lastInboundAt = 0;
    /** @type {number} @private - When something was last handed to the transport, as epoch ms. */
    this._lastOutboundAt = 0;
    /** @type {number} @private - When the current connection attempt started, as epoch ms. */
    this._connectStartedAt = 0;
    /**
     * Set while a connection attempt is outstanding — from the moment the
     * transport primitive runs until the transport opens or dies. It is what
     * stops a burst of wake signals turning into a burst of parallel sockets.
     * @type {boolean} @private
     */
    this._connecting = false;
    /** @type {any} @private - The link watchdog's interval, or null while it is not running. */
    this._linkTimer = null;
    /** @type {any} @private - Pending timer that will forgive the backoff if this link lasts. */
    this._stabilityTimer = null;
    /** @type {any} @private - The pending backoff timer; at most one exists at a time. */
    this._retryTimer = null;
    /** @type {boolean} @private - Whether the visibility/online listeners are installed (once per service). */
    this._wakeListenersInstalled = false;
    /** @type {number} @private */
    this._dcChunkSeq = 0;
    /** @type {Map<string, {total: number, parts: string[], received: number}>} @private */
    this._dcIncomingChunks = new Map();
    /**
     * Reassembly for messages the server split because they were too large to
     * send whole (utils/ws-chunk.js). Unrelated to _dcIncomingChunks above,
     * which is the DataChannel's own 16 KiB chunker: the two never share a
     * connection, since one is what a WebSocket needs and the other is what
     * WebRTC needs.
     * @type {WSChunkReassembler} @private
     */
    this._wsChunks = new WSChunkReassembler();
    /** @type {Record<WSEventType, WSEventCallback[]>} @private */
    this._listeners = {
      open: [],
      close: [],
      error: [],
      message: [],
      session: [],
      'file-change': [],
      'project-changed': [],
      'plugin-changed': [],
      retry: [],
      'streaming-error': [],
      'providers-update': [],
      'providers-ready': [],
      'shell-output': [],
      'reconnect-attempt': [],
      'engine-bridge': [],
      'update-status': [],
      'clients-changed': [],
      'pinboard-changed': [],
      'pinboard-reveal': [],
      'viewer-relay': []
    };
  }

  /**
   * Take ownership of connection attempts away from whatever held it, and
   * return the token the new owner carries.
   *
   * Called from the three places ownership changes hands, which is every place
   * an attempt can be superseded or abandoned: connect() (a new attempt takes
   * over from any still in flight), _dropLink() (the current attempt or link is
   * condemned, and the death handler installs its replacement in the same turn)
   * and disconnect() (nothing speaks for this service again).
   *
   * Deliberately not called from _reestablishNow, which only ever reaches a new
   * attempt through connect() and is entered either from a death, whose attempt
   * is already over, or from _retryNow, which condemns a live attempt through
   * _dropLink first. Nor from _settleOpen or _onTransportClosed: a settled
   * attempt has nothing left to reject, and an attempt whose transport died
   * while it is still the current one is exactly the case that must go on to
   * suppress the reconnect and fall back to the relay.
   * @returns {number} The generation the caller's attempt carries.
   * @private
   */
  _supersedeAttempt() {
    return ++this._attemptGeneration;
  }

  /**
   * Whether a direct WebRTC transport is worth attempting: a viewer on a secure
   * origin — the LAN path the host serves over https — in a browser that has
   * peer connections. One seam for the choice, so it can be answered for a
   * service under test without a page served over https.
   * @param {string} role - 'viewer' or 'engine'.
   * @returns {boolean} True if the WebRTC probe should run.
   * @private
   */
  _shouldTryWebRTC(role) {
    return role === 'viewer'
      && globalThis.location.protocol === 'https:'
      && typeof globalThis.RTCPeerConnection !== 'undefined';
  }

  connect() {
    this._intentionalDisconnect = false;
    // Which attempt this is. An attempt condemned or replaced while its
    // handshake is still in flight carries a stale generation, and everything it
    // would do on the way out is then the replacement's business, not its own.
    const generation = this._supersedeAttempt();
    this._connecting = true;
    this._connectStartedAt = Date.now();
    this._installWakeListeners();
    this._startLinkWatchdog();

    const role = isEngine() ? 'engine' : 'viewer';

    // Default re-establish primitive for socket transports: reopen the socket.
    // Its open/close events feed the shared backoff loop. The studio branch
    // below overrides this with a reload-based primitive (its handshake lives in
    // an external bootstrap that only a full page reload can re-run).
    this._reestablish = () => this.connect();

    // juggler.studio remote path: the bootstrap page has already established a
    // WebRTC DataChannel and published window.__jugglerStudio, then injected
    // the app into this same page without navigating. Adopt that channel as the
    // realtime transport instead of opening our own. This MUST precede the
    // LAN-https WebRTC/WS branch below: studio is the remote transport and has
    // no WS-relay fallback (there is no relay reachable from a remote browser —
    // recovery is a full page reload, which re-runs bootstrap). The LAN/local
    // case keeps the _connectWebRTC → _connectWebSocket relay fallback intact.
    if (role === 'viewer' && typeof globalThis.window !== 'undefined' && /** @type {any} */ (window).__jugglerStudio) {
      this._adoptStudioChannel();
      return;
    }

    if (this._shouldTryWebRTC(role)) {
      this._connectWebRTC(role, generation).catch((error) => {
        // An attempt that was abandoned while this handshake was in flight has
        // nothing left to fall back to: the link it would have relayed for
        // belongs to whatever replaced it, and a second socket alongside that
        // one is exactly what the generation exists to prevent.
        if (generation !== this._attemptGeneration) {
          console.info('[WebSocket] Ignoring an abandoned WebRTC attempt:', error);
          return;
        }
        console.warn('[WebSocket] WebRTC direct transport failed; falling back to WebSocket relay:', error);
        if (!this.connected && !this._intentionalDisconnect) {
          this._connectWebSocket(role);
        }
      });
      return;
    }

    this._connectWebSocket(role);
  }

  /**
   * @param {string} role
   * @private
   */
  _connectWebSocket(role) {
    // globalThis.location works in both the window (Location) and a module
    // worker (WorkerLocation), so the engine can build its WS URL off-thread.
    const loc = globalThis.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    // Replay the per-instance session token (embedded in the served page) so the
    // server accepts the viewer upgrade (see cmd/juggler/server/api_auth.go). The
    // engine worker has no token global and is exempt server-side, so it simply
    // omits the param.
    const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    // A viewer names itself so another viewer can address it (see utils/viewer-id).
    // The engine needs no identity and sends none.
    const id = role === 'viewer' ? viewerId() : '';
    const viewerParam = id ? `&viewerId=${encodeURIComponent(id)}` : '';
    const wsUrl = `${protocol}//${loc.host}/api/ws?role=${role}${tokenParam}${viewerParam}`;
    this._transport = new WebSocket(wsUrl);
    this._configureTransport(this._transport, 'WebSocket');
  }

  /**
   * @param {string} role
   * @param {number} generation - The attempt this handshake belongs to, from _supersedeAttempt().
   * @returns {Promise<void>}
   * @private
   */
  async _connectWebRTC(role, generation) {
    const pc = new window.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    /** @type {RTCDataChannel|null} */
    let channel = null;
    try {
      const dc = pc.createDataChannel('juggler', { ordered: true });
      channel = dc;
      /** @type {RTCDataChannel & {__pc?: RTCPeerConnection}} */ (dc).__pc = pc;
      this._transport = /** @type {any} */ (dc);
      this._configureTransport(/** @type {any} */ (dc), 'WebRTC');

      const opened = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebRTC DataChannel open timeout')), 8000);
        dc.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
        dc.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('WebRTC DataChannel error'));
        }, { once: true });
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIceGathering(pc, 5000);

      const answer = await fetchJson('/api/webrtc/signal', {
        method: 'POST',
        body: { role, offer: pc.localDescription },
        errorPrefix: 'WebRTC signaling failed',
      });
      await pc.setRemoteDescription(answer.answer);
      await opened;
    } catch (error) {
      if (generation === this._attemptGeneration) {
        // Still the current attempt, so this is the ordinary shape of a host
        // that cannot be reached directly: the close pc.close() is about to
        // cause is an expected probe failure rather than a link death, and
        // connect()'s catch relays over a WebSocket instead.
        this._suppressNextCloseReconnect = true;
        this._transport = null;
      } else if (channel) {
        // Abandoned. Whoever condemned this attempt has already handled its
        // death and moved on, so mark the channel handled: its close must not
        // be read as the death of the link now standing in its place.
        /** @type {any} */ (channel).__jugglerDeathHandled = true;
      }
      pc.close();
      throw error;
    }
  }

  /**
   * Adopt the WebRTC DataChannel that the juggler.studio bootstrap page already
   * opened (published on window.__jugglerStudio), using it as the realtime
   * transport. The channel is already OPEN, so we mark connected synchronously
   * and fire the open path rather than waiting on an onopen event.
   * @private
   */
  _adoptStudioChannel() {
    /** @type {{dc: RTCDataChannel, sendFrame: (text: string) => void, setRealtimeHandler: (fn: (raw: string) => void) => void}} */
    const studio = /** @type {any} */ (window).__jugglerStudio;

    // Use a minimal send-adapter, NOT the raw RTCDataChannel, as this._transport.
    // studio.sendFrame already applies the __juggler_dc_chunk envelope, and
    // _sendTransport only chunks when this._transport is `instanceof RTCDataChannel` —
    // so routing through this plain object correctly skips our chunker and
    // avoids double-chunking the same payload.
    this._transport = /** @type {any} */ ({
      send: (/** @type {string} */ payload) => studio.sendFrame(payload),
      close: () => {}
    });

    // Inbound frames arrive already reassembled (chunks merged) and pre-filtered
    // (http/chunk frames removed) by bootstrap, so feed them straight in.
    studio.setRealtimeHandler((/** @type {string} */ raw) => this._handleMessageData(raw));

    // The channel is open at adoption time; settle it as a first connection.
    // There was no prior connection to compare servers against, so this never
    // takes the reconnect handshake in _configureTransport.
    this._transportLabel = 'studio';
    this._settleOpen(undefined);

    // Studio's only recovery lever is a full page reload (it re-runs the
    // external bootstrap's WebRTC handshake — app-side JS can't rebuild the
    // channel). Gate the reload on a server reachability probe so a still-dead
    // link can't reload-storm; see _reloadWhenReachable. This plugs into the
    // SAME backoff loop as every other transport via this._reestablish.
    this._reestablish = () => this._reloadWhenReachable();

    // Route channel death through the shared transport-death handler so studio
    // uses the identical reconnect policy as the socket transports. The death is
    // reported against the send-adapter rather than the channel, because that is
    // what the watchdog would drop — one object carries the handled-once marker
    // whichever of them notices first (see _onTransportClosed).
    const adapter = this._transport;
    const onDead = (/** @type {Event} */ event) => this._onTransportClosed(event, adapter);
    studio.dc.addEventListener('close', onDead);
    studio.dc.addEventListener('error', onDead);
  }

  /**
   * @param {RTCPeerConnection} pc
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   * @private
   */
  _waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(done, timeoutMs);
      /** Finish waiting for ICE gathering. */
      function done() {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }
      /** Resolve once browser ICE gathering completes. */
      function onState() {
        if (pc.iceGatheringState === 'complete') done();
      }
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  /**
   * @param {WebSocket|RTCDataChannel} transport
   * @param {string} label
   * @private
   */
  _configureTransport(transport, label) {
    this._transportLabel = label;
    // Chunk frames arrive as binary, and a Blob would make reading them
    // asynchronous — which would reorder them against the text messages either
    // side. Both transports default to 'arraybuffer' or accept it.
    transport.binaryType = 'arraybuffer';
    transport.onopen = (event) => {
      // A viewer's reconnect is not settled here. Which server answered decides
      // whether this page can carry on — the same instance means the outage was
      // a link blip and the Yjs resync repairs it — and that is only knowable
      // from the session message, so withhold 'open' until _resolveReconnect
      // reads it. The engine is exempt: it is a headless page with no token or
      // cache-busted asset URLs baked into it and no reload to fall back on, so
      // resync is its recovery either way.
      if (this._reconnectAttempts > 0 && !isEngine()) {
        this._reconnectPending = true;
        this._heldOpenEvent = event;
        // The attempt stays outstanding while the park lasts, so the watchdog's
        // connect-stall check bounds it: a socket that opens and then never
        // hears a session message is as stuck as one that never opened.
        return;
      }
      this._settleOpen(event);
    };

    transport.onclose = (/** @type {CloseEvent|Event} */ event) => this._onTransportClosed(event, transport);

    transport.onerror = (/** @type {Event} */ error) => {
      console.error(`[ESSENTIAL] [${label}] transport error (type=${error?.type})`, error);
      this._emit('error', error);
    };

    transport.onmessage = (event) => {
      this._handleMessageData(event.data);
    };
  }

  /**
   * Feed one received binary message to the chunk reassembler, and hand on
   * whatever it completes.
   *
   * Binary is not otherwise part of this protocol, so anything arriving that is
   * not a chunk frame is dropped rather than guessed at — and said out loud,
   * because a binary message nobody sent means the two ends disagree about the
   * wire format.
   * @param {ArrayBuffer} raw - The received binary message
   * @private
   */
  _handleBinaryMessage(raw) {
    const message = this._wsChunks.accept(raw);
    if (!message) return;
    if (message.kind === WS_CHUNK_KIND_TEXT) {
      this._handleMessageData(new TextDecoder().decode(message.bytes));
      return;
    }
    console.error(
      `[ESSENTIAL] [WebSocket] Dropped a reassembled message of kind ${message.kind}, which this client cannot read`
    );
  }

  /**
   * Single transport-death handler for EVERY transport (WebSocket, WebRTC-LAN,
   * juggler.studio). Marks the link down, notifies listeners, and — unless this
   * was an intentional teardown or an expected failed-probe close — enters the
   * shared backoff reconnect loop. The loop is transport-agnostic; HOW the link
   * is actually re-established is the per-transport this._reestablish thunk.
   * @param {CloseEvent|Event} event - The close/error event
   * @param {WebSocket|RTCDataChannel|null} [transport] - The dead transport (for PC cleanup)
   * @private
   */
  _onTransportClosed(event, transport) {
    // Spend the self-inflicted mark first, ahead of every early return below, so
    // it can never outlive the one death _dropLink set it for and be read as the
    // verdict on the next.
    const selfInflicted = this._selfInflictedDrop;
    this._selfInflictedDrop = false;
    // A transport can announce its death more than once: a DataChannel fires
    // both 'error' and 'close', and a link the watchdog drops closes for real a
    // moment after we have already handled it. Handle the first announcement and
    // ignore the rest — otherwise one death arms two backoff loops, which is two
    // sockets racing to reconnect.
    const dead = /** @type {any} */ (transport);
    if (dead) {
      if (dead.__jugglerDeathHandled) return;
      dead.__jugglerDeathHandled = true;
    }
    this.connected = false;
    this._connecting = false;
    // Frames of a message the dead socket never finished sending. The next
    // connection numbers its runs from one again, so keeping them would let a
    // fragment of the old link be spliced onto the new one.
    this._wsChunks.reset();
    // A reconnect whose socket opened and then died at the other end's hand
    // before the server ever said who it is. That is what a restarted server
    // looks like from here: it completes the upgrade and then closes the socket
    // because the token this page replays belongs to a process that is gone.
    // Left alone it flaps forever — every bogus open would reset the backoff —
    // so the page reloads, being exactly as stale as the token it sent.
    //
    // A drop we inflicted ourselves is not that. It says the link stopped
    // carrying traffic, which is evidence about the link and none at all about
    // which server is on the far end, and it is the ordinary shape of a laptop
    // waking onto a network that has moved. Reloading over it would cost a full
    // app boot plus a full-state resync of every conversation to every attached
    // client. Nor is there a flap to protect against: the park never settled, so
    // the backoff was never reset and the retry loop escalates as usual.
    const diedUnidentified = this._reconnectPending && !selfInflicted;

    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    this._emit('close', event);
    const pc = transport && /** @type {any} */ (transport).__pc;
    if (pc) pc.close();
    // Skip auto-reconnect for an intentional disconnect or an expected failed
    // WebRTC probe that is about to fall back to the WebSocket relay.
    if (this._suppressNextCloseReconnect) {
      this._suppressNextCloseReconnect = false;
      return;
    }
    if (diedUnidentified && this._reloadStalePage('the link opened and closed without the server identifying itself')) {
      return;
    }
    if (!this._intentionalDisconnect) {
      this._reconnect();
    }
  }

  /**
   * Inbound messages that are identified by their `type`, keyed by that type.
   * Each route translates one wire message into the service events subscribers
   * listen for, and is dispatched by {@link WebSocketService#_handleMessageData}
   * before the shape-matched cases (retry, streaming-error) and the generic
   * 'message' emit. Returning `false` declines the message so it falls through to
   * those cases — only engine-bridge does that, for a malformed channel.
   * @type {Record<string, (ws: WebSocketService, data: any) => boolean|void>}
   */
  static TYPED_MESSAGE_ROUTES = {
    [WEBRTC_CHUNK_TYPE]: (ws, data) => {
      ws._handleTransportChunk(data);
    },

    'file-change': (ws, data) => {
      ws._emit('file-change', data.changes);
    },

    // Project switch (server-side change of the loaded project)
    'project-changed': (ws, data) => {
      ws._emit('project-changed', { projectPath: data.projectPath || '' });
    },

    // Plugin file changes (hot reload)
    'plugin-changed': (ws, data) => {
      ws._emit('plugin-changed', data.path);
    },

    // One board's composition after a viewer edited it. The whole board rides
    // the event, so viewers converge without replaying ops — and the board it is
    // about rides with it, because a project has several and the server has no
    // way to know which one any viewer is reading.
    'pinboard-changed': (ws, data) => {
      ws._emit('pinboard-changed', {
        board: typeof data.board === 'string' ? data.board : '',
        pins: Array.isArray(data.pins) ? data.pins : [],
      });
    },

    // Advisory request to open one board on one pin. Composition arrives through
    // pinboard-changed first; the shell applies the per-viewer interruption guard.
    'pinboard-reveal': (ws, data) => {
      ws._emit('pinboard-reveal', {
        board: typeof data.board === 'string' ? data.board : '',
        pin: typeof data.pin === 'string' ? data.pin : '',
        from: typeof data.from === 'string' ? data.from : '',
      });
    },

    // A message another viewer addressed to this one. `from` is the sending
    // viewer's id as the server saw it, so it can be trusted and answered; the
    // payload is whatever the two viewers agreed between themselves.
    'viewer-relay': (ws, data) => {
      ws._emit('viewer-relay', { from: data.from || '', payload: data.payload });
    },

    'providers-update': (ws, data) => {
      ws._emit('providers-update', data.providers);
      // Whether this snapshot is the settled, post-compute list (true) or the
      // pre-compute connect seed (false). Emitted second so any 'providers-update'
      // listener has already applied the array before readiness is signalled.
      ws._emit('providers-ready', data.ready === true);
    },

    // Version/update-status pushes (server re-evaluated the remote version
    // manifest and the surfaced notice changed).
    'update-status': (ws, data) => {
      ws._emit('update-status', data);
    },

    // Connected-client changes (a viewer joined or left). `count` is the total
    // number of viewer clients (this one included); `clients` describes each, so
    // listeners can exclude self by id and show origin/connect-time.
    'clients-changed': (ws, data) => {
      ws._emit('clients-changed', { count: data.count, clients: data.clients || [] });
    },

    'shell-output': (ws, data) => {
      ws._emit('shell-output', data);
    },

    // Cross-origin engine→viewer event bridge. Each viewer's WS
    // sees this message exactly once, so emit it as a direct
    // wsService event for subscribers that prefer per-WS delivery
    // (e.g. the test harness's exec counter). The engine itself
    // both originated the message and skips its own replay.
    //
    // Also replay onto a same-window BroadcastChannel so existing
    // BC subscribers (action-progress, etc.) keep working. In the
    // multi-iframe test pool the BC path inherently fans the
    // event N-1 ways (sender doesn't get its own posts but every
    // sibling iframe does), which is why new test instrumentation
    // should subscribe to 'engine-bridge' on wsService instead.
    'engine-bridge': (ws, data) => {
      if (typeof data.channel !== 'string') return false;
      if (isEngine()) return true;
      // The engine has no tape of its own (separate window, no
      // BroadcastChannel reach), so its bridged events are the
      // only record of what it executed. Stamp them onto this
      // viewer's tape so a failure block shows the engine's
      // tool-exec timeline interleaved with local events.
      // Record a COMPACT summary, never the raw payload: progress
      // events carry the tool's accumulated output, and retaining
      // those strings in a 2000-entry ring across every iframe
      // turns a large-output tool run into a memory bomb.
      const p = /** @type {any} */ (data.payload) || {};
      recordTape('engine:' + data.channel.replace(/^juggler-/, ''),
        p.conversationId ?? null, {
          toolUseId: p.toolUseId,
          toolName: p.toolName,
          phase: p.phase,
          ok: p.ok,
          status: p.status,
          aborted: p.aborted,
          eventType: p.event?.type,
          contentLen: typeof p.event?.content === 'string' ? p.event.content.length : undefined,
          accumulatedLen: typeof p.accumulatedOutput === 'string' ? p.accumulatedOutput.length : undefined
        });
      ws._emit('engine-bridge', { channel: data.channel, payload: data.payload });
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const bc = new BroadcastChannel(data.channel);
          bc.postMessage(data.payload);
          bc.close();
        } catch (err) {
          console.error('[WebSocket] engine-bridge replay failed:', err);
        }
      }
      return true;
    },

    // The server's beat on an otherwise silent link (link_liveness.go). Its
    // arrival is the entire message: _handleMessageData has already stamped it,
    // which is what the stall watchdog reads. Routed rather than left to fall
    // through so it is not delivered to every 'message' subscriber.
    heartbeat: () => {}
  };

  /**
   * @param {any} rawData
   * @private
   */
  _handleMessageData(rawData) {
    // Any inbound byte proves the link still carries traffic, whatever it turns
    // out to say — so stamp before parsing, ahead of every early return below.
    // A chunk frame counts too, even though the message it belongs to may not
    // be complete for several more frames.
    this._lastInboundAt = Date.now();

    // The only binary this protocol carries is a message the server had to
    // split. It is held here until its last frame arrives, then re-enters as
    // the text it always was.
    if (rawData instanceof ArrayBuffer || ArrayBuffer.isView(rawData)) {
      this._handleBinaryMessage(/** @type {ArrayBuffer} */ (rawData));
      return;
    }

    // Ignore empty or whitespace-only messages (newlines from streaming)
    if (!rawData || String(rawData).trim().length === 0) {
      return;
    }

    try {
      const data = JSON.parse(String(rawData));

      // Messages identified by `type` route through the table above. A route
      // returning false declined the message (see engine-bridge), so it falls
      // through to the shape-matched cases below.
      const route = WebSocketService.TYPED_MESSAGE_ROUTES[data.type];
      if (route && route(this, data) !== false) return;

      // Handle retry notifications ONLY (has retry:true and attempt/maxRetries fields)
      if (data.retry === true && data.attempt !== undefined && data.maxRetries !== undefined) {
        this._emit('retry', data);
        return;
      }

      // Handle retryable error notifications - these are INFO, not fatal errors
      // Backend sends these when an error occurs but will retry
      // Emit as 'streaming-error' event so UI can show the actual error details
      if (data.error && data.message && !data.chunk && !data.response) {
        console.warn('[WebSocket] Streaming error received:', data.message);
        this._emit('streaming-error', data);
        return;
      }

      // Record every inbound WS message in the event tape so the
      // failure dump can correlate JS-side reception with worker-side
      // sends.
      recordTape('ws-in', /** @type {any} */ (data).conversationId || null, {
        type: data.type,
        workerMsgType: /** @type {any} */ (data).workerMsgType
      });

      // Handle session initialization message from server
      if (data.type === 'session') {
        // Remember our own server-assigned id so the connected-clients UI can
        // exclude this window from the list of other clients.
        if (data.clientId) this.clientId = data.clientId;
        // Our own id as the server took it: empty means this viewer sent none, or
        // sent one the server would not accept, and so cannot be addressed.
        this.viewerId = data.viewerId || '';
        // The boot id rides the same message, and on a reconnect it decides
        // whether this page carries on or reloads. A page on its way out has
        // nothing worth handing to listeners.
        if (this._resolveReconnect(data.bootId)) return;
        this._emit('session', data);
      } else {
        // All other messages go through normal message handler
        this._emit('message', data);
      }
    } catch (error) {
      console.error(`[ESSENTIAL] [WebSocket] Failed to parse message: ${error}`);
      console.error(`[ESSENTIAL] [WebSocket] Raw message data: ${rawData}`);
      console.error(`[ESSENTIAL] [WebSocket] Message length: ${rawData ? String(rawData).length : 0}`);
    }
  }

  /**
   * Send text over the selected transport. DataChannels are chunked because
   * SCTP implementations have much lower practical message-size ceilings than
   * WebSocket frames, and worker init can contain a large serialized document.
   * @param {string} payload
   * @private
   */
  _sendTransport(payload) {
    if (!this._transport) throw new Error('transport not connected');
    // Real traffic is a beat as far as the server is concerned, so record it and
    // spare the link a beat it does not need.
    this._lastOutboundAt = Date.now();
    // globalThis (not window): the engine runs in a Web Worker with no
    // `window`, and this send path runs for every outbound message. WebRTC
    // is viewer-only anyway, so RTCDataChannel is simply absent in the worker.
    const RTCDataChannelCtor = /** @type {any} */ (globalThis).RTCDataChannel;
    if (typeof RTCDataChannelCtor !== 'undefined' && this._transport instanceof RTCDataChannelCtor && payload.length > WEBRTC_CHUNK_SIZE) {
      const id = `${Date.now().toString(36)}-${(++this._dcChunkSeq).toString(36)}`;
      const total = Math.ceil(payload.length / WEBRTC_CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        this._transport.send(JSON.stringify({
          type: WEBRTC_CHUNK_TYPE,
          id,
          index: i,
          total,
          data: payload.slice(i * WEBRTC_CHUNK_SIZE, (i + 1) * WEBRTC_CHUNK_SIZE)
        }));
      }
      return;
    }
    this._transport.send(payload);
  }

  /**
   * Serialize `obj` and hand it to the transport, applying the uniform
   * connected-guard + try/catch that every send* method needs. `label` names
   * the message in the two error logs ("Not connected, cannot send <label>" /
   * "Failed to send <label>: <error>"). Pass `{silent: true}` for the
   * fire-and-forget senders (session-changed, engine-bridge, tool-started) that
   * must not log on a dead link.
   * @param {object} obj - Payload object to JSON-serialize and send
   * @param {string} label - Human name of the message for the error logs
   * @param {{silent?: boolean}} [opts]
   * @returns {boolean} True if handed to the transport; false on guard/serialize failure
   * @private
   */
  _sendJson(obj, label, opts = {}) {
    if (!this.connected || !this._transport) {
      if (!opts.silent) {
        console.error(`[ESSENTIAL] [WebSocket] Not connected, cannot send ${label}`);
      }
      return false;
    }
    try {
      this._sendTransport(JSON.stringify(obj));
      return true;
    } catch (error) {
      if (!opts.silent) {
        console.error(`[ESSENTIAL] [WebSocket] Failed to send ${label}: ${error}`);
      }
      return false;
    }
  }

  /**
   * @param {{id?: string, index?: number, total?: number, data?: string}} chunk
   * @private
   */
  _handleTransportChunk(chunk) {
    if (typeof chunk.id !== 'string' || typeof chunk.index !== 'number' || typeof chunk.total !== 'number' || typeof chunk.data !== 'string') {
      return;
    }
    if (chunk.total <= 0 || chunk.index < 0 || chunk.index >= chunk.total) return;
    let entry = this._dcIncomingChunks.get(chunk.id);
    if (!entry) {
      entry = { total: chunk.total, parts: new Array(chunk.total), received: 0 };
      this._dcIncomingChunks.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total) {
      this._dcIncomingChunks.delete(chunk.id);
      return;
    }
    if (entry.parts[chunk.index] === undefined) {
      entry.parts[chunk.index] = chunk.data;
      entry.received++;
    }
    if (entry.received === entry.total) {
      this._dcIncomingChunks.delete(chunk.id);
      this._handleMessageData(entry.parts.join(''));
    }
  }

  disconnect() {
    this._intentionalDisconnect = true;
    // Nothing that was still handshaking speaks for this service again.
    this._supersedeAttempt();
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    this._connecting = false;
    this._stopLinkWatchdog();
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._transport) {
      const pc = /** @type {any} */ (this._transport).__pc;
      this._transport.close();
      if (pc) pc.close();
      this._transport = null;
    }
    this.connected = false;
  }

  /**
   * @typedef {object} ToolDefinition
   * @property {string} name - Tool name
   * @property {string} description - Tool description
   * @property {object} input_schema - JSON Schema for parameters
   */

  /**
   * @typedef {object} ModelConfig
   * @property {string} [provider] - LLM provider name
   * @property {string} [model] - LLM model name
   */

  /**
   * Send an LLM request over the transport.
   * @param {string} systemPrompt - System prompt with instructions
   * @param {import('../../sdk/lib/message.js').Message[]} messages - Array of Message objects
   * @param {ToolDefinition[]} tools - Tool definitions for LLM to use
   * @param {string} conversationId - Conversation ID for routing responses
   * @param {ModelConfig} modelConfig - Model configuration (provider and model)
   * @param {string} [transactionId] - Transaction ID for tracking this LLM call
   * @returns {boolean} True if message sent successfully, false otherwise
   */
  send(systemPrompt, messages, tools, conversationId, modelConfig, transactionId = '') {
    if (!this.connected || !this._transport) {
      console.error(`[ESSENTIAL] [WebSocket] Not connected, cannot send message`);
      return false;
    }

    // Validate model configuration: a concrete (provider, model) pair must
    // be present.
    const hasConcrete = modelConfig && modelConfig.provider && modelConfig.model &&
            modelConfig.provider.trim() !== '' && modelConfig.model.trim() !== '';
    if (!modelConfig || !hasConcrete) {
      console.error(`[ESSENTIAL] [WebSocket] Cannot send message without valid model configuration`);
      return false;
    }

    return this._sendJson({
      systemPrompt,
      messages,
      tools,
      conversationId,
      modelConfig,
      transactionId: transactionId || '' // Ensure empty string if undefined/null
    }, 'message');
  }

  /**
   * Send a shell-start request to execute a command with streaming output
   * @param {string} shellId - Unique ID for this shell execution
   * @param {string} convId - Conversation that owns this shell (spill-file bucket); '' when unknown
   * @param {string} command - Shell command to execute
   * @param {string} [cwd] - Working directory (optional)
   * @param {number} [timeout] - Timeout in milliseconds (optional)
   * @returns {boolean} True if sent successfully
   */
  sendShellStart(shellId, convId, command, cwd, timeout) {
    return this._sendJson({
      type: 'shell-start',
      shellId,
      convId,
      command,
      cwd,
      timeout
    }, 'shell-start');
  }

  /**
   * Send a tool execution response back to the server (for claudecode provider)
   * @param {string} requestId - Request ID to correlate with request
   * @param {string} content - Tool result content
   * @param {'success'|'error'|'cancelled'} resultStatus - Outcome of tool execution
   * @param {string} [category] - Tool category: "read", "write", "meta"
   * @returns {boolean} True if sent successfully
   */
  sendToolResponse(requestId, content, resultStatus, category) {
    return this._sendJson({
      type: 'tool_use_response',
      requestId,
      content,
      resultStatus: resultStatus || 'success',
      category: category || ''
    }, 'tool response');
  }

  /**
   * Signal to server that the user approved a tool and execution is starting.
   * This allows the server to begin its execution timeout only from this point.
   * @param {string} requestId - Request ID from the tool_use_request
   */
  sendToolStarted(requestId) {
    this._sendJson({ type: 'tool_use_started', requestId }, 'tool_use_started', { silent: true });
  }

  /**
   * Send shouldContinue response back to server (iteration control callback)
   * @param {string} requestId - Request ID from server
   * @param {boolean} shouldContinue - Whether to continue the loop
   * @param {string} message - Message to inject if stopping
   * @returns {boolean} True if sent successfully
   */
  sendShouldContinueResponse(requestId, shouldContinue, message) {
    return this._sendJson({
      type: 'should_continue_response',
      requestId,
      shouldContinue,
      message
    }, 'should_continue response');
  }

  /**
   * Send a shell-cancel request to stop a running shell command
   * @param {string} shellId - ID of the shell to cancel
   * @returns {boolean} True if sent successfully
   */
  sendShellCancel(shellId) {
    return this._sendJson({ type: 'shell-cancel', shellId }, 'shell-cancel');
  }

  /**
   * Send a message to the worker via WebSocket
   * Wraps message in worker-message envelope for server routing
   * @param {string} conversationId - Conversation ID to route message to
   * @param {{type: string, [key: string]: unknown}} message - Message to send to worker
   * @returns {boolean} True if sent successfully
   */
  sendWorkerMessage(conversationId, message) {
    if (!this.connected || !this._transport) {
      // A dropped yjs-sync is recovered, so it is not an error: the ops stay in
      // this client's doc and the reconnect resync ships them to the worker as
      // the delta since its state vector (worker-manager.resyncReadyConversations).
      // Every other worker message is genuinely lost with nothing to replay it.
      const line = `[ESSENTIAL] [WebSocket] Not connected, cannot send worker message (type=${message?.type}, connected=${this.connected}, ws=${!!this._transport})`;
      if (message?.type === 'yjs-sync') {
        console.warn(line);
      } else {
        console.error(line);
      }
      return false;
    }

    if (!conversationId) {
      console.error(`[ESSENTIAL] [WebSocket] Cannot send worker message without conversationId`);
      return false;
    }

    const envelope = {
      type: 'worker-message',
      conversationId,
      workerMsgType: message.type,
      payload: message
    };
    recordTape('ws-out', conversationId, {
      workerMsgType: message.type,
      ackId: /** @type {any} */ (message).ackId
    });
    return this._sendJson(envelope, 'worker message');
  }

  /**
   * Notify other views that session state has changed.
   * The server broadcasts this to all other viewers in the same session.
   * @returns {boolean} Whether the message was sent
   */
  sendSessionChanged() {
    return this._sendJson({ type: 'session-changed' }, 'session-changed', { silent: true });
  }

  /**
   * Tell the server this engine's realm is still running.
   *
   * The server cannot infer that from the socket: in WebKit the WebSocket lives
   * in the network process, so a suspended or wedged engine keeps completing
   * handshakes and answering pings while executing nothing. This beat is sent
   * from the module worker — the realm a tool would actually run in — so it
   * cannot be answered on behalf of an engine that has stopped.
   *
   * Silent: a beat that misses because the link is down is not news, and the
   * reconnect path reports that already.
   * @returns {boolean} True if sent
   */
  sendEngineHeartbeat() {
    return this._sendJson({ type: 'engine-heartbeat' }, 'engine-heartbeat', { silent: true });
  }

  /**
   * Tell the server this viewer is still on the other end of the link.
   *
   * The server closes a viewer that has said nothing for viewerSilenceWindow
   * (link_liveness.go), because a socket held open by a machine that is never
   * coming back is indistinguishable from a quiet one until somebody says
   * otherwise. Sent only when there was nothing else to send — ordinary traffic
   * says the same thing.
   *
   * Silent: a beat that misses because the link is down is not news, and the
   * watchdog above is already dealing with it.
   * @returns {boolean} True if sent
   */
  sendViewerHeartbeat() {
    return this._sendJson({ type: 'viewer-heartbeat' }, 'viewer-heartbeat', { silent: true });
  }

  /**
   * Report an uncaught fault in this page to the app log.
   *
   * This window's console cannot be opened in a release build, so a fault that
   * reaches nothing but console.error reaches nobody: the UI misrenders or stops
   * updating, and the only log anyone can read shows a server behaving
   * perfectly. Sending it is what makes a viewer-side failure investigable at
   * all.
   *
   * Silent: a report that cannot be sent is not worth a second failure on top of
   * the one being reported, and it is already on the console.
   * @param {{source: string, message: string, stack?: string, convId?: string, detail?: string}} fault - The fault.
   * @returns {boolean} True if sent
   */
  sendViewerFault(fault) {
    return this._sendJson({ type: 'viewer-fault', ...fault }, 'viewer-fault', { silent: true });
  }

  /**
   * Report the outcome of the run the server asked this engine to make.
   *
   * Not silent: the process that asked is blocked on this message, so a send
   * that fails is the difference between a result and a run that never answers.
   * @param {{requestId: string, status: string, conversationId: string, turns: number, finalText: string, parkedTool: string, errorText: string}} result - The run's outcome
   * @returns {boolean} True if sent
   */
  sendOneShotResult(result) {
    return this._sendJson({ type: 'one-shot-result', ...result }, 'one-shot-result');
  }

  /**
   * Bridge a cross-window event from the engine to every viewer via the
   * server. Viewer-side WS handler replays the payload into a local
   * BroadcastChannel(channel) so in-page subscribers fire.
   * @param {string} channel - BroadcastChannel name (e.g. 'juggler-action-progress')
   * @param {unknown} payload - Payload to deliver to viewers
   * @returns {boolean} True if sent
   */
  sendEngineBridge(channel, payload) {
    return this._sendJson({ type: 'engine-bridge', channel, payload }, 'engine-bridge', { silent: true });
  }

  /**
   * Send a message to one other viewer of this project, addressed by the viewer
   * id it named itself by (see utils/viewer-id). The server routes it and reads
   * nothing inside the payload; the recipient sees it as a `viewer-relay` event
   * carrying this viewer's id as `from`.
   *
   * Delivery is best-effort and unqueued: a viewer that is not connected right
   * now never receives it, and nothing reports that. Anything two viewers must
   * agree on durably belongs in server state, not here.
   * @param {string} to - Recipient's viewer id
   * @param {unknown} payload - Opaque payload for the recipient
   * @returns {boolean} True if handed to the transport
   */
  relayTo(to, payload) {
    if (!to) return false;
    return this._sendJson({ type: 'viewer-relay', to, payload }, 'viewer-relay', { silent: true });
  }

  /**
   * Register an event listener
   * @param {WSEventType} event - Event type to listen for
   * @param {WSEventCallback} callback - Callback function
   */
  on(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event].push(callback);
    } else {
      console.error(`[ESSENTIAL] [WebSocket] Cannot register listener for unknown event '${event}'`);
    }
  }

  /**
   * @param {WSEventType} event
   * @param {WSEventCallback} callback
   */
  off(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Emit an event to all registered listeners
   * @param {WSEventType} event - Event type
   * @param {any} data - Event data
   * @private
   */
  _emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(callback => callback(data));
    }
  }

  /**
   * Mark the link up and release the 'open' event — the single place that does
   * either, for a first connection and for a reconnect cleared to carry on
   * alike.
   * @param {Event|undefined} event - The transport's open event.
   * @private
   */
  _settleOpen(event) {
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    // The backoff is forgiven by a link that LASTS, not by one that opens — see
    // _armStabilityCheck.
    this._armStabilityCheck();
    this._connecting = false;
    // A fresh link must not inherit the dead one's stamps, or the watchdog
    // condemns it on its first tick.
    this._lastInboundAt = Date.now();
    this._lastOutboundAt = Date.now();
    this._startLinkWatchdog();
    this.connected = true;
    console.info(`[WebSocket] Connected via ${this._transportLabel}`);
    this._emit('open', event);
  }

  /**
   * Read the session message's boot id and, on a reconnect, decide what the
   * outage meant.
   *
   * The boot id names the server process. Unchanged, it is the same server we
   * were talking to a moment ago: it still holds this project's workers, still
   * honours the token and the cache-busted asset URLs baked into this page, and
   * everything missed while the socket was down is recovered by the Yjs
   * state-vector resync that releasing 'open' sets off. Changed, the server
   * restarted: this page was served by a process that no longer exists, so its
   * token is refused, its `/v<version>/` module URLs 404, and its project may
   * not even be the same one. Nothing short of a reload recovers from that.
   *
   * A reconnect that arrives with no boot id to compare — the server sent none,
   * or this page never received a session message to record one from — is
   * treated as a restart. The comparison is the only evidence there is, and
   * without it carrying on would mean assuming the good case.
   * @param {string|undefined} bootId - The session message's boot id.
   * @returns {boolean} True if a reload was started, so nothing else matters.
   * @private
   */
  _resolveReconnect(bootId) {
    if (!this._reconnectPending) {
      // First connection of this page: nothing to compare against yet, so just
      // record which server it belongs to.
      if (bootId) this.serverBootId = bootId;
      return false;
    }
    if (bootId && bootId === this.serverBootId) {
      this._settleOpen(this._heldOpenEvent);
      return false;
    }
    const reason = `server instance changed (was ${this.serverBootId || 'unknown'}, now ${bootId || 'unknown'})`;
    if (this._reloadStalePage(reason)) return true;
    // Throttled — the server is restarting repeatedly, and one reload per
    // restart is a reload loop. Drop this connection rather than carry on
    // against a server whose workers know nothing of this page, and re-arm the
    // backoff loop that keeps the disconnection overlay counting down, so the
    // reload is retried as soon as the throttle allows one.
    this._suppressNextCloseReconnect = true;
    try {
      this._transport?.close();
    } catch {
      /* already closing */
    }
    this.connected = false;
    this._reconnect();
    return true;
  }

  /**
   * Reload because this page belongs to a server instance that is gone.
   * Throttled, so a crash-looping server cannot put the viewer in a reload
   * loop; the caller decides what to do with the link when it is refused.
   * @param {string} reason - What made the page stale, for the log line.
   * @returns {boolean} True if the reload was started.
   * @private
   */
  _reloadStalePage(reason) {
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    if (!this._shouldReloadOnReconnect()) return false;
    console.warn(`[ESSENTIAL] [WebSocket] Reloading: ${reason}`);
    this._reloadPage();
    return true;
  }

  /**
   * Gate a reload-to-recover so a flapping connection can't trigger a reload
   * storm. Returns true at most once per RELOAD_THROTTLE_MS (tracked in
   * sessionStorage so it survives the reload itself, per tab). When throttled,
   * the caller keeps trying to re-establish the link instead.
   * @returns {boolean} True if a reload-to-recover is allowed right now
   * @private
   */
  _shouldReloadOnReconnect() {
    const KEY = 'jugglerLastReconnectReload';
    const RELOAD_THROTTLE_MS = 60000;
    let last = 0;
    try {
      last = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
    } catch {
      // sessionStorage unavailable — fail open is unsafe (storm risk), so
      // fail closed: skip the reload, keep the live connection.
      return false;
    }
    const now = Date.now();
    if (now - last < RELOAD_THROTTLE_MS) {
      console.warn('[ESSENTIAL] [WebSocket] Skipping reload-on-reconnect (throttled) — link is flapping');
      return false;
    }
    try {
      sessionStorage.setItem(KEY, String(now));
    } catch {
      /* ignore write failure */
    }
    return true;
  }

  /**
   * Watch the link for the failures it cannot report itself: a connection that
   * has stopped delivering, and a connection attempt that will never complete.
   * Also the outbound half of the beat — a viewer that says nothing at all is
   * eventually closed by the server (link_liveness.go).
   *
   * Runs for every transport. All three conditions are properties of the link
   * rather than of how it was established, and each transport's death already
   * routes through the same _onTransportClosed, so the recovery is identical
   * whichever one is underneath.
   * @private
   */
  _startLinkWatchdog() {
    if (this._linkTimer) return;
    this._linkTimer = setInterval(() => this._checkLink(), LINK_CHECK_MS);
  }

  /** @private */
  _stopLinkWatchdog() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    this._linkTimer = null;
    this._cancelStabilityCheck();
  }

  /**
   * Start the clock on a newly settled link. If it is still up when the clock
   * runs out the link has proven itself and the backoff starts fresh; if it
   * dies first, the attempts it cost stand and the next retry eases off.
   * @private
   */
  _armStabilityCheck() {
    this._cancelStabilityCheck();
    this._stabilityTimer = setTimeout(() => {
      this._stabilityTimer = null;
      this._proveLinkStable();
    }, LINK_STABLE_AFTER_MS);
  }

  /** @private */
  _cancelStabilityCheck() {
    if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
    this._stabilityTimer = null;
  }

  /**
   * This link has lasted: forgive the backoff so the next drop, whenever it
   * comes, gets the fast first retry a one-off blip deserves.
   * @private
   */
  _proveLinkStable() {
    this._reconnectAttempts = 0;
  }

  /**
   * One watchdog tick.
   * @private
   */
  _checkLink() {
    if (this._intentionalDisconnect) return;
    const now = Date.now();

    if (!this.connected) {
      // Nothing to measure unless an attempt is outstanding: while the backoff
      // timer is counting down there is no link to have an opinion about.
      if (this._connecting && now - this._connectStartedAt > CONNECT_STALL_MS) {
        this._dropLink(`the connection attempt went unanswered for ${Math.round((now - this._connectStartedAt) / 1000)}s`);
      }
      return;
    }

    const quiet = now - this._lastInboundAt;
    if (this._lastInboundAt && quiet > LINK_STALL_MS) {
      this._dropLink(`nothing has arrived for ${Math.round(quiet / 1000)}s`);
      return;
    }

    // The engine keeps its own, faster beat from inside its module worker, which
    // proves something this one cannot (engine-app.js).
    if (!isEngine() && now - this._lastOutboundAt >= VIEWER_BEAT_MS) {
      this.sendViewerHeartbeat();
    }
  }

  /**
   * Declare the current link dead and start recovering, without waiting for the
   * transport to admit it.
   *
   * Routed through the ordinary death handler rather than reconnecting directly,
   * so the boot-id park, the 'close' event, the transport cleanup and the backoff
   * loop all behave as they do for a link that closed on its own. The transport's
   * real close event follows later and is ignored as a repeat (see
   * _onTransportClosed).
   *
   * The single distinction the handler draws is the mark set here. Condemning a
   * silent link is a statement about the link; it is not the restarted-server
   * flap that reloads the page, and must not be read as one.
   * @param {string} reason - What made the link look dead, for the log line.
   * @private
   */
  _dropLink(reason) {
    const dead = this._transport;
    console.warn(`[ESSENTIAL] [WebSocket] Dropping the link: ${reason}`);
    // Any handshake still in flight is condemned along with the link. The
    // replacement _onTransportClosed installs below owns the transport from
    // here, and an attempt that settles later must not write over it.
    this._supersedeAttempt();
    // Marked before the close, so a transport that answers close() by running its
    // handler there and then still reaches the death handler carrying the mark.
    this._selfInflictedDrop = true;
    try {
      dead?.close();
    } catch {
      /* already gone */
    }
    this._onTransportClosed(new Event('close'), dead);
  }

  /**
   * Listen for the two moments a suspended page comes back: the tab becoming
   * visible (laptop wake, phone unlock, tab switch) and the browser reporting the
   * network back. Both mean the answer to "is the link alive" has just changed,
   * and neither is worth waiting out a backoff tier to discover.
   *
   * Installed once, and only from connect() — a service nobody connected has
   * nothing to wake up. `document` is absent in the engine's module worker, so
   * the engine gets the 'online' half only.
   * @private
   */
  _installWakeListeners() {
    if (this._wakeListenersInstalled) return;
    this._wakeListenersInstalled = true;
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', () => this._wake('the browser says the network is back'));
    }
    const doc = /** @type {any} */ (globalThis).document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') this._wake('the page became visible');
      });
    }
  }

  /**
   * Act on a wake signal.
   *
   * A page that has been asleep believes whatever it believed when it went under.
   * If it thought it was connected, the socket it is holding may have died
   * silently while nothing was running to notice — so a link with no recent
   * traffic is dropped rather than trusted. If it thought it was disconnected,
   * the remaining backoff was measured against a network that has since changed,
   * so it is abandoned and the attempt made now.
   * @param {string} reason - What woke us, for the log line.
   * @private
   */
  _wake(reason) {
    if (this._intentionalDisconnect) return;
    if (this.connected) {
      const quiet = Date.now() - this._lastInboundAt;
      if (this._lastInboundAt && quiet > WAKE_STALE_MS) {
        this._dropLink(`${reason}, but nothing has arrived for ${Math.round(quiet / 1000)}s`);
      }
      return;
    }
    this._retryNow(reason);
  }

  /**
   * Retry the connection immediately instead of waiting out the pending backoff.
   *
   * At most one attempt is in flight when this returns, and the age of any
   * attempt already under way decides which one it is.
   *
   * Younger than WAKE_ATTEMPT_GRACE_MS, the attempt is genuinely handshaking and
   * is left to finish: wake signals arrive in bursts — 'online' and
   * 'visibilitychange' together — and each extra socket would be one more the
   * backoff loop has to reconcile. Older, it is not a live attempt at all but one
   * that went under with the page, opened into a network that has since changed
   * and will typically neither open nor fail; it is condemned here rather than
   * left to the watchdog's connect-stall check, whose patience is measured in the
   * tens of seconds this signal exists to save.
   *
   * Condemning it re-arms the backoff loop, as any death does. So the pending
   * timer is cleared after that drop and before this attempt takes its place —
   * whether it is the one the drop just armed or one already counting down, at
   * most one attempt and no timer survive this call.
   * @param {string} reason - Why we are retrying now, for the log line.
   * @private
   */
  _retryNow(reason) {
    if (this.connected || this._intentionalDisconnect) return;
    if (this._connecting) {
      const age = Date.now() - this._connectStartedAt;
      if (age < WAKE_ATTEMPT_GRACE_MS) return;
      // The drop re-arms the backoff loop as any death does, and the timer it
      // arms is cleared below in favour of the attempt made here. Announcing
      // that delay would put a countdown in front of the user that nothing is
      // waiting out, so the announcement this call makes is the only one.
      this._announceReconnect = false;
      try {
        this._dropLink(`${reason}, and the attempt under way is ${Math.round(age / 1000)}s old`);
      } finally {
        this._announceReconnect = true;
      }
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    console.info(`[WebSocket] Reconnecting now: ${reason}`);
    this._emit('reconnect-attempt', { attempt: this._reconnectAttempts, delayMs: 0 });
    this._reestablishNow();
  }

  /**
   * Run the current transport's re-establish primitive (set in connect()),
   * recording that an attempt is outstanding. Falls back to a plain reconnect if
   * connect() never ran.
   * @private
   */
  _reestablishNow() {
    this._connecting = true;
    this._connectStartedAt = Date.now();
    (this._reestablish || (() => this.connect()))();
  }

  /**
   * How long to wait before attempt number `attempt`.
   *
   * The tiers hold a reconnecting viewer at roughly one attempt a second for the
   * first minute, then ease off for an outage that is clearly not ending — but
   * the FIRST retry is fast, because the overwhelming majority of drops are a
   * blip and a second of blank screen is the whole cost of one. Every delay is
   * jittered so a server restart does not bring its viewers back in lockstep.
   * @param {number} attempt - 1-based attempt number.
   * @returns {number} Delay in milliseconds.
   * @private
   */
  _backoffDelay(attempt) {
    let base;
    if (attempt <= 1) {
      base = RECONNECT_FIRST_DELAY_MS;
    } else if (attempt <= 50) {
      base = 1000;
    } else if (attempt <= 100) {
      base = 2000;
    } else {
      base = 5000;
    }
    return Math.round(base * (1 - RECONNECT_JITTER + Math.random() * 2 * RECONNECT_JITTER));
  }

  _reconnect() {
    // Whatever link we had is gone, so it never earned its reprieve.
    this._cancelStabilityCheck();
    this._reconnectAttempts++;
    const delay = this._backoffDelay(this._reconnectAttempts);

    // Emit reconnect-attempt event with delay so UI can show countdown
    if (this._announceReconnect) {
      this._emit('reconnect-attempt', { attempt: this._reconnectAttempts, delayMs: delay });
    }

    // One pending attempt at a time. A drop that arrives while a timer is
    // already counting down replaces it rather than adding to it.
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.connected || this._intentionalDisconnect) return;
      this._reestablishNow();
    }, delay);
  }

  /**
   * Reload the page. A single overridable seam so both reload-to-recover paths
   * (the socket onopen reload-on-reconnect and the studio reachability reload)
   * go through one place, and tests can spy it without touching globals.
   * @private
   */
  _reloadPage() {
    globalThis.location.reload();
  }

  /**
   * Studio re-establish primitive: reload the page to re-run the external
   * bootstrap's WebRTC handshake. A reload is studio's sole recovery — app-side
   * JS cannot rebuild the DataChannel once it dies.
   *
   * We deliberately do NOT probe /api/health (or any other endpoint) first.
   * Over studio the service worker tunnels EVERY same-origin request from this
   * page — /api/health included — through the very DataChannel that just died,
   * so the probe can only ever return an instant 504. Gating the reload on it
   * therefore wedged the session in an endless health-check loop that never
   * recovered (the reachability signal it waited for was unreachable by
   * construction). There is no out-of-band path to juggler.studio from here to
   * probe instead, and a reload's success depends on the P2P host being
   * reachable — which cannot be known without redoing the handshake anyway.
   *
   * So reload directly, relying on two existing storm-guards: this loop is only
   * ever entered on a real link death, _shouldReloadOnReconnect throttles reloads
   * to once per 60s (sessionStorage-backed, survives the reload), and a reload
   * against a still-dead host ends on bootstrap's static "connection isn't
   * possible" panel (no auto-retry) — so it cannot storm. When throttled we
   * re-arm the shared backoff loop instead, keeping the disconnection overlay
   * countdown alive until a reload is allowed again.
   * @returns {Promise<void>}
   * @private
   */
  async _reloadWhenReachable() {
    if (this.connected || this._intentionalDisconnect) return;
    if (this._shouldReloadOnReconnect()) {
      this._reloadPage();
      return;
    }
    // Reload throttled (link is flapping) — re-arm the same backoff loop that
    // drives the disconnection overlay countdown rather than reload-storming.
    this._reconnect();
  }

  /**
   * Check if WebSocket is currently connected
   * @returns {boolean} True if connected, false otherwise
   */
  isConnected() {
    return this.connected;
  }

  // ============================================================================
  // Test Harness Methods
  // ============================================================================

  /**
   * Simulate WebSocket disconnection for testing.
   * Closes the connection without triggering auto-reconnect.
   * @returns {Promise<void>}
   */
  async simulateDisconnect() {
    this._intentionalDisconnect = true;
    if (this._transport) {
      this._transport.close();
    }
    this.connected = false;
    // Wait for close to complete
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  /**
   * Reconnect WebSocket for testing (after simulateDisconnect).
   * Re-establishes connection.
   * @returns {Promise<void>}
   */
  async reconnect() {
    // Reset intentional disconnect flag
    this._intentionalDisconnect = false;

    // Reconnect
    this.connect();

    // Wait for connection to establish
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Reconnect timeout'));
      }, 5000);

      const onOpen = () => {
        clearTimeout(timeout);
        this.off('open', onOpen);
        this.off('error', onError);
        resolve();
      };

      const onError = (/** @type {unknown} */ err) => {
        clearTimeout(timeout);
        this.off('open', onOpen);
        this.off('error', onError);
        reject(err);
      };

      this.on('open', onOpen);
      this.on('error', onError);
    });
  }
}

// Export singleton instance
const wsService = new WebSocketService();
export default wsService;

// Also export the class for isolated unit testing of the reconnect policy.
export { WebSocketService };
