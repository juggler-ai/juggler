//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Multiple viewers on ONE conversation.
 *
 * The iframe pool puts N viewer WebSockets + 1 engine in flight, but each lane
 * owns its OWN conversation — so two *viewer* clients are never attached to the
 * SAME conversation at once. That's the production multi-tab case (one
 * conversation open in two tabs, each its own WS), and it's exactly the
 * broadcast-to-all-clients path the ack-correlation and context-request races
 * lived on. This suite closes that coverage gap.
 *
 * `open-second-viewer` opens a real second WebSocket (distinct server clientId)
 * subscribed to the active conversation; `assert-second-viewer-converges` waits
 * for that independent client's Yjs doc to match viewer-1's live state. See
 * web/js-tests/utilities/second-viewer.js.
 * @module integration-tests/multi-viewer-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * A second viewer on one conversation receives the full initial state, then
 * live broadcasts for a new turn, then an undo — converging with viewer-1 at
 * each step. Exercises real per-worker fan-out to multiple viewer clients.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const multiViewerConvergeTest = {
  name: 'multi-viewer-converge',
  description: 'A second viewer client on the same conversation converges via yjs-sync after a turn and an undo',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.'),
    textResponse('Hi again.')
  ],

  operations: [
    // Viewer-1 creates the conversation and runs one turn.
    { type: 'send-message', message: 'Hello' },
    // Attach a second real WS client to the same conversation; it must
    // receive the full state broadcast on subscribe.
    { type: 'open-second-viewer' },
    { type: 'assert-second-viewer-converges' },
    // Live broadcast: viewer-1 runs another turn; the second client must
    // receive the new items via fan-out.
    { type: 'send-message', message: 'Again' },
    { type: 'assert-second-viewer-converges' },
    // Undo on viewer-1 must also propagate to the second client.
    { type: 'undo' },
    { type: 'assert-second-viewer-converges' }
  ]
};

export const tests = [
  multiViewerConvergeTest
];
