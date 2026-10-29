//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Session-scoped server frames: the ones that carry no `conversationId`, and
 * so are dispatched before the conversation lookup in
 * `JugglerApp#_handleServerMessage`.
 *
 * {@link SESSION_MESSAGE_HANDLERS} has one entry per frame type, each typed
 * against that frame's shape (`ServerFrame`, websocket.js). Its keys are held
 * to the wire manifest's `handledBy: session-handlers` by
 * unit:wire-protocol-parity.
 * @module protocol/session-message-handlers
 */

import workerManager from '../services/worker-manager.js';
import { uiPort } from '../services/ui-port.js';
import { noticeText } from '../services/app-notices.js';

/**
 * @typedef {import('../services/websocket.js').ServerFrame} ServerFrame
 * @typedef {import('../model/session.js').default} Session
 */

/**
 * A handler for one session-scoped frame type, against that frame's shape.
 * @template {ServerFrame['type']} K
 * @typedef {(session: Session, data: Extract<ServerFrame, {type: K}>) => void} SessionHandlerFor
 */

/**
 * Session-scoped server frames, keyed by `type`.
 * @type {{[K in ServerFrame['type']]?: SessionHandlerFor<K>}}
 */
export const SESSION_MESSAGE_HANDLERS = {
  // Worker traffic is forwarded verbatim; workerManager owns its routing.
  'worker-message': (_session, data) => {
    workerManager.handleWorkerMessageFromWS(data);
  },

  // Op-tagged conversation-list diff from the server. The session's sync
  // reducer owns the op vocabulary and applies each one idempotently, so the
  // originator's echo is a no-op (model/conversation-sync-reducer.js).
  'conversations-changed': (session, data) => {
    void session.sync.apply(data);
  },

  // A server-side background task reporting something the user would
  // otherwise never see (an auto-name that gave up). Purely informational —
  // show it and move on. A page with no dialogs mounted has nowhere to show it.
  'notice': (_session, data) => {
    const text = noticeText(data);
    if (text) uiPort()?.notice(text);
  },

  // Targeted session metadata patch. Apply locally without a full
  // session refresh so permission changes sync instantly across conversations.
  'session-metadata-changed': (session, data) => {
    session.applySessionMetadataPatch(data.metadata || {}, { remote: true });
  },

  // Session-level metadata (messageHistory, metadata flags) updated
  // by another viewer's PUT /session. Conversation-list changes
  // travel via conversations-changed above; this is a small refresh.
  'session-changed': (session) => {
    session.persistence.refreshFromServer();
  }
};
