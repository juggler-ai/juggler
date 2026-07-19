//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Auto-namer — give a fresh conversation a descriptive tab title as soon as its
 * opening exchange lands, the way t3.chat / t3code name a thread from its first
 * message. A brand-new conversation starts as "Task N"; once its first turn
 * comes to rest we send the opening prompt + reply to the backend, which runs a
 * short isolated completion (see cmd/juggler/server/name_gen.go) and returns a
 * title. We apply it through the normal rename path — but only while the tab is
 * still auto-named, so we never clobber a title the user typed.
 *
 * Trigger model mirrors {@link module:utils/attention-manager}: we observe the
 * shared LLMState status stream and act on the durable `completedTurns` edge
 * (never the transient `status`, which sync batching can swallow). Baselines are
 * seeded on first sight so we only name conversations whose first turn completes
 * live this session — never a retroactive rename storm on load.
 * @module services/auto-namer
 */

import apiService from './api.js';
import { MAX_CONVERSATION_NAME_LENGTH } from '../utils/constants.js';

/** @type {import('../model/session.js').default|null} */
let session = null;

/** Last observed completedTurns per conversation (baseline for edge detection). */
const prevTurns = new Map();

/** Conversations whose first turn we've already tried to name (permanent). */
const attempted = new Set();

/** Conversations with a naming request in flight (concurrency guard). */
const inFlight = new Set();

/**
 * Whether `name` is an auto-generated default the auto-namer is allowed to
 * replace. Only the names {@link Session#createConversation} assigns with no
 * user input qualify — "Task N" and the "Untitled" fallback. Any other name
 * (including one the user typed, or a name we already generated) is left alone.
 * @param {string} name
 * @returns {boolean} True if the name is an auto-generated default we may replace
 */
export function isAutoConversationName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return /^Task \d+$/.test(trimmed) || /^Untitled$/.test(trimmed);
}

/**
 * Pull the first user message and the first assistant reply (as plain text)
 * from a conversation's root thread — the material the title is generated from.
 * @param {import('../model/message-thread.js').MessageThread|null|undefined} messageThread
 * @returns {{ prompt: string, response: string }} First prompt and reply (either may be empty)
 */
export function extractFirstExchange(messageThread) {
  let prompt = '';
  let response = '';
  const items = messageThread?.getMessages?.() || [];
  for (const m of items) {
    const type = m?.get?.('type');
    const content = m?.get?.('content');
    if (typeof content !== 'string') continue;
    if (!prompt && type === 'user') {
      prompt = content.trim();
    } else if (prompt && !response && type === 'assistant') {
      response = content.trim();
      break;
    }
  }
  return { prompt, response };
}

/**
 * Normalise a model-suggested title for use as a tab name: collapse whitespace,
 * strip a single pair of surrounding quotes/backticks, and truncate to the
 * shared UI cap so the follow-up rename is never rejected for length. The server
 * already sanitizes for the filesystem; this is the client-facing tidy-up.
 * @param {string} raw
 * @returns {string} A tidied, length-capped tab name (may be empty)
 */
export function cleanClientName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/\s+/g, ' ').trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
      s = s.slice(1, -1).trim();
    }
  }
  if (s.length > MAX_CONVERSATION_NAME_LENGTH) {
    s = s.slice(0, MAX_CONVERSATION_NAME_LENGTH).trim();
  }
  return s;
}

/**
 * Generate and (conditionally) apply a name for one conversation. Best-effort:
 * any failure leaves the default name in place and does not throw.
 * @param {any} conv
 * @returns {Promise<void>}
 * @private
 */
async function maybeGenerateName(conv) {
  const id = conv?.id;
  if (!id || attempted.has(id) || inFlight.has(id)) return;
  if (!isAutoConversationName(conv.name)) return;

  const model = conv.modelConfig;
  if (!model || !model.provider || !model.model) return;

  const { prompt, response } = extractFirstExchange(conv.rootMessageThread);
  if (!prompt) return;

  inFlight.add(id);
  try {
    const result = await apiService.generateConversationName(id, {
      model: { provider: model.provider, model: model.model, thinking: model.thinking },
      prompt,
      response
    });
    // A real attempt was made — never retry, even if applying is skipped below.
    attempted.add(id);

    const finalName = cleanClientName(result?.name || '');
    // Re-check eligibility: the user may have renamed the tab during the await.
    if (finalName && isAutoConversationName(conv.name)) {
      await session?.renameConversation(id, finalName);
    }
  } catch (err) {
    // Best-effort. Leave `id` un-attempted so a later turn can retry; the
    // turn-edge trigger keeps retries naturally throttled.
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[auto-namer] name generation failed:', err);
    }
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Handle an LLMState status change for one conversation: fire naming on the
 * first completed turn once the conversation is idle.
 * @param {string} convId
 * @private
 */
function onStatus(convId) {
  const conv = session?.conversations.get(convId);
  if (!conv) return;

  const llm = /** @type {any} */ (conv)._llmState;
  const turns = conv.completedTurns;
  const processing = !!llm && llm.isConversationProcessing(convId);

  const hadTurns = prevTurns.get(convId);
  const seeded = hadTurns !== undefined;
  prevTurns.set(convId, turns);

  // Seed the baseline on first sight without acting, so a conversation loaded
  // from disk with turns already behind it is never retro-named.
  if (!seeded) return;

  // Act on the rising edge of completedTurns, once the turn has come to rest.
  const turnEdge = turns > /** @type {number} */ (hadTurns) && !processing;
  if (turnEdge && turns >= 1) {
    void maybeGenerateName(conv);
  }
}

/**
 * Wire the auto-namer to a session. Idempotent per session: subscribes to the
 * shared LLMState status stream (the one event that fires on every turn edge)
 * and re-wires as conversations arrive.
 * @param {import('../model/session.js').default} sess
 * @returns {void}
 */
export function initAutoNamer(sess) {
  session = sess;
  prevTurns.clear();
  attempted.clear();
  inFlight.clear();

  /** @type {(() => void)|null} */
  let unsub = null;
  const wire = () => {
    if (unsub) return;
    const anyConv = sess.conversations.values().next().value;
    const llm = /** @type {any} */ (anyConv)?._llmState;
    if (llm?.addStatusObserver) {
      unsub = llm.addStatusObserver((/** @type {string} */ id) => onStatus(id));
    }
  };
  wire();

  sess.subscribe(/** @param {{type: string}} e */ (e) => {
    if (e.type === 'conversation:created') wire();
  });
}
