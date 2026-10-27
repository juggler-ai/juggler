//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A lane's first connection to its server.
 * @module js-tests/utilities/ws-connect
 */

import { trackWait } from './test-patience.js';

/**
 * How long a connect may take before it is reported as a wedge.
 *
 * The connect is decided by the socket's own `open` or `error`; this bound
 * is not a guess at how long a connect takes. It is there so a server that
 * never answers fails with this message rather than as a bare result-poll
 * timeout on the Go side (120s, `runOneBrowserTest`). A fixed 5s used to sit
 * here. On a core twenty times slower than this one (`make check SLOW=20`),
 * every lane's first test failed with "WebSocket connection timeout" before
 * it ran a single op.
 */
const CONNECT_WEDGE_MS = 60_000;

/**
 * Connect the lane's WebSocket service and wait for it to open.
 * @param {any} wsService - The WebSocket service.
 * @returns {Promise<void>} Resolves once open; rejects on the socket's error, or if neither comes.
 */
export function connectTestWebSocket(wsService) {
  const close = trackWait('the lane\'s WebSocket to open');
  return new Promise((resolve, reject) => {
    const done = (/** @type {'satisfied'|'threw'} */ outcome) => {
      clearTimeout(wedge);
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
    const wedge = setTimeout(() => {
      done('threw');
      reject(new Error(`WebSocket connection timeout: neither open nor error in ${CONNECT_WEDGE_MS / 1000}s — the server is not answering, ask it from outside the page`));
    }, CONNECT_WEDGE_MS);
    wsService.on('open', onOpen);
    wsService.on('error', onError);
    wsService.connect();
  });
}
