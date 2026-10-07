//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * SecondViewer — a test-only second client onto an EXISTING conversation.
 *
 * Opens its OWN real WebSocket to /api/ws?role=viewer (a distinct server-side
 * client id, separate from the harness's singleton wsService) and subscribes to
 * one conversation. Inbound `yjs-sync` broadcasts are applied into its own
 * ConversationDocument, so a test can assert this independent client converges
 * with viewer-1 after edits/undo.
 *
 * This is the only thing in the integration suite that puts TWO viewer clients
 * on the SAME conversation simultaneously — the production multi-tab case the
 * iframe pool otherwise never exercises (each lane owns its own conversation).
 * It drives the real per-worker broadcast fan-out (callbackRegistry.broadcast)
 * to multiple viewers — the path the ack-correlation and context-request races
 * lived on.
 *
 * Wire protocol (mirrors web/js/services/websocket.js + worker-manager.js):
 *  - dial: `${ws|wss}://${host}/api/ws?role=viewer`
 *  - subscribe + request state: send a worker-message envelope whose
 *    workerMsgType is 'init' and whose payload is an InitMessage with
 *    loadFromDisk:true and no stateVector. The Go manager registers THIS
 *    client's callback on the conversation's worker (manager.go
 *    mgrHandleMessage); because the worker is already initialized, handleInit
 *    takes its attach path, and the missing state vector is what asks for full
 *    state (message_handlers.go) — an init carrying one is answered with only
 *    the delta since it, addressed to the sender alone.
 *  - inbound: {type:'worker-message', conversationId, workerMsgType:'yjs-sync',
 *              payload:{type:'yjs-sync', bytes:'<base64 Yjs update>'}}
 *
 * Pure consumer: it never mutates its doc, so it needs no sync-broadcast wiring —
 * just Y.applyUpdate on each inbound update (ConversationDocument.applySyncUpdate).
 * @module utilities/second-viewer
 */

import ConversationDocument from '../../js/model/conversation-document.js';
import { wsUrl } from '../../js/utils/api-url.js';

/**
 * Normalize a doc's items to the [{type, content}] shape integration tests
 * assert against (mirrors how expectedItems read item fields).
 * @param {any} doc - ConversationDocument
 * @returns {Array<{type: string, content: string|undefined}>} Normalized snapshot items.
 */
function snapshotItems(doc) {
  const json = doc.toJSON();
  const items = Array.isArray(json.items) ? json.items : [];
  return items.map((/** @type {any} */ it) => ({ type: it.type, content: it.content }));
}

export class SecondViewer {
  /**
   * @param {string} conversationId - Existing conversation to open as a 2nd client
   */
  constructor(conversationId) {
    /** @type {string} */
    this.conversationId = conversationId;
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {any} */
    this._doc = new ConversationDocument(conversationId, 'second-viewer');
    this._doc.initializeAsClient();
    /** @type {boolean} */
    this._syncedOnce = false;
    /** @type {any} */
    this._beatTimer = null;
  }

  /**
   * Open the WebSocket and subscribe to the conversation. Resolves once the
   * connection is open and the subscribe/init envelope has been sent; the
   * first yjs-sync arrives asynchronously (await waitForConverge for state).
   * @returns {Promise<void>}
   */
  open() {
    this._ws = new WebSocket(wsUrl('role=viewer'));

    this._ws.onmessage = (/** @type {MessageEvent} */ event) => {
      if (!event.data || String(event.data).trim().length === 0) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== 'worker-message' || data.conversationId !== this.conversationId) {
        return;
      }
      let payload = data.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { return; }
      }
      if (!payload || payload.type !== 'yjs-sync' || !payload.bytes) return;
      // base64 → Uint8Array (mirror worker-manager-inbound.js onYjsSync)
      const binary = atob(payload.bytes);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      this._doc.applySyncUpdate(bytes);
      this._syncedOnce = true;
    };

    return new Promise((resolve, reject) => {
      const ws = /** @type {WebSocket} */ (this._ws);
      const timer = setTimeout(() => reject(new Error('SecondViewer: WS open timeout')), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({
          type: 'worker-message',
          conversationId: this.conversationId,
          workerMsgType: 'init',
          payload: {
            type: 'init',
            conversation: { id: this.conversationId, loadFromDisk: true },
            config: {}
          }
        }));
        // The server closes a viewer that says nothing for viewerSilenceWindow
        // (cmd/juggler/server/link_liveness.go), so keep this one's half of the
        // protocol like a real viewer does.
        this._beatTimer = setInterval(() => {
          try { ws.send(JSON.stringify({ type: 'viewer-heartbeat' })); } catch { /* closing */ }
        }, 15000);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('SecondViewer: WS error'));
      };
    });
  }

  /**
   * Current normalized item snapshot of this client's independently-synced doc.
   * @returns {Array<{type: string, content: string|undefined}>} Snapshot items.
   */
  items() {
    return snapshotItems(this._doc);
  }

  /**
   * Wait (bounded, value-independent) until this client's doc converges to
   * `expected`. Resolves when the snapshot matches; rejects on timeout with
   * both sides dumped so a genuine divergence is legible. Never passes on
   * timeout — a stuck/divergent peer fails the test.
   * @param {Array<{type: string, content?: string}>} expected - Expected items
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<void>}
   */
  async waitForConverge(expected, { timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const matches = () => {
      const got = this.items();
      if (got.length !== expected.length) return false;
      for (let i = 0; i < expected.length; i++) {
        if (got[i].type !== expected[i].type) return false;
        if (expected[i].content !== undefined && got[i].content !== expected[i].content) {
          return false;
        }
      }
      return true;
    };
    while (Date.now() < deadline) {
      if (matches()) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(
      `SecondViewer(${this.conversationId}) did not converge.\n` +
			`  expected: ${JSON.stringify(expected)}\n` +
			`  actual:   ${JSON.stringify(this.items())}\n` +
			`  syncedOnce: ${this._syncedOnce}`
    );
  }

  /**
   * Close the WebSocket (server unregisters this client's callbacks via
   * ClientDisconnected) and destroy the local doc. Idempotent.
   */
  close() {
    if (this._beatTimer) {
      clearInterval(this._beatTimer);
      this._beatTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch { /* already closing */ }
      this._ws = null;
    }
    if (this._doc) {
      try { this._doc.destroy(); } catch { /* already destroyed */ }
      this._doc = null;
    }
  }
}

export default SecondViewer;
