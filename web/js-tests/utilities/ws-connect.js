//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A lane's first connection to its server.
 * @module js-tests/utilities/ws-connect
 */

import { trackWait } from './test-patience.js';
import { deadlineTimer } from './test-deadline.js';
import workerManager from '../../js/services/worker-manager.js';

/**
 * How long a connect may take before it is reported as a wedge.
 *
 * The connect is decided by the socket's own `open` or `error`; this bound
 * is not a guess at how long a connect takes. It is there so a server that
 * never answers fails with this message rather than as a bare result-poll
 * timeout on the Go side (120s, `runOneBrowserTest`). It is a nominal that
 * follows the test's deadline while the runner moves it (`deadlineTimer`), so
 * a connect being served slowly on a slow core (`make check SLOW=20`) is not
 * cut off, and one nobody answers fails here.
 */
const CONNECT_WEDGE_MS = 60_000;

/** The socket services already catching up on their reconnects. */
const catchingUp = new WeakSet();

/**
 * Catch up after each reconnect of `wsService` as the app does
 * (`ConnectionManager._handleOpen`): the acks owed on the dropped link, which
 * the worker addressed to it and so can never arrive, and each ready
 * conversation's document. The page has no ConnectionManager, so without this
 * a reconnected lane waits out an ack timeout for a request the worker
 * answered. Once per socket service; the lanes of a window share one.
 * @param {any} wsService - The WebSocket service.
 * @param {{relinkPendingAcks: () => void, resyncReadyConversations: () => void}} manager - Whose acks and documents catch up.
 */
function catchUpOnReconnect(wsService, manager) {
  if (catchingUp.has(wsService)) return;
  catchingUp.add(wsService);
  let opened = wsService.isConnected();
  wsService.on('open', () => {
    if (!opened) {
      opened = true;
      return;
    }
    manager.relinkPendingAcks();
    manager.resyncReadyConversations();
  });
}

/**
 * Connect the lane's WebSocket service and wait for it to open.
 * @param {any} wsService - The WebSocket service.
 * @param {{relinkPendingAcks: () => void, resyncReadyConversations: () => void}} [manager] - Whose acks and documents catch up on a reconnect; the page's worker manager by default.
 * @returns {Promise<void>} Resolves once open; rejects on the socket's error, or if neither comes.
 */
export function connectTestWebSocket(wsService, manager = workerManager) {
  catchUpOnReconnect(wsService, manager);
  const close = trackWait('the lane\'s WebSocket to open');
  return new Promise((resolve, reject) => {
    const done = (/** @type {'satisfied'|'threw'} */ outcome) => {
      cancelWedge();
      wsService.off('open', onOpen);
      wsService.off('error', onError);
      close(outcome);
    };
    const onOpen = () => {
      done('satisfied');
      resolve();
    };
    const onError = (/** @type {unknown} */ err) => {
      done('threw');
      reject(err instanceof Error ? err : new Error('WebSocket connection error'));
    };
    const cancelWedge = deadlineTimer(() => {
      done('threw');
      reject(new Error(`WebSocket connection timeout: neither open nor error in ${CONNECT_WEDGE_MS / 1000}s with the test making no progress — the server is not answering, ask it from outside the page`));
    }, CONNECT_WEDGE_MS);
    wsService.on('open', onOpen);
    wsService.on('error', onError);
    wsService.connect();
  });
}
