//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Events the server pushes to the window, by topic and key.
 *
 * A topic is a kind of event a feature on the server publishes — `git` is the
 * git state of a tree, keyed by workspace id — and the server sends a key's
 * events only to the connections that subscribed to it. This module does the
 * subscribing for the whole window: every surface that wants a key's events
 * subscribes here, and the window names the keys of each topic to the server in
 * one subscriptions frame, again whenever they change and again on every new
 * connection (the server forgets a connection's subscriptions when it goes).
 *
 * Events sent while the window was cut off went nowhere. So each new connection
 * is also news for every subscriber: its `onResync` is called, and whatever it
 * read before it should read again.
 *
 * What an event holds is the topic's to say; this module hands it on as it came.
 * @module services/topics
 */

import wsService from './websocket.js';

/**
 * @typedef {object} TopicSubscribeOptions
 * @property {() => void} [onResync] - Called on every new connection while
 *   subscribed: events may have been missed, so read again what they would have
 *   said.
 */

/**
 * One subscriber.
 * @typedef {object} Subscriber
 * @property {(event: unknown) => void} listener - Handed each event.
 * @property {(() => void)|undefined} onResync - Told of each new connection.
 */

/** @type {Map<string, Map<string, Set<Subscriber>>>} Subscribers, by topic, then key. */
const _topics = new Map();

/**
 * Name every key of a topic to the server.
 * @param {string} topic - The topic.
 */
function sendKeys(topic) {
  wsService.sendSubscriptions(topic, [...(_topics.get(topic)?.keys() || [])].sort());
}

/**
 * Hear of every event of one key of a topic until the returned function is
 * called. Any number of subscribers may share a key; the server is asked for it
 * while one remains.
 * @param {string} topic - The topic, as the server names it.
 * @param {string} key - The key within it.
 * @param {(event: unknown) => void} listener - Called with each event.
 * @param {TopicSubscribeOptions} [options] - What else to be told.
 * @returns {() => void} Unsubscribe. Safe to call twice.
 */
export function subscribe(topic, key, listener, options = {}) {
  if (typeof topic !== 'string' || !topic || typeof key !== 'string') {
    throw new TypeError('subscribe needs a topic name and a string key');
  }
  let keys = _topics.get(topic);
  if (!keys) {
    keys = new Map();
    _topics.set(topic, keys);
  }
  let subscribers = keys.get(key);
  const isNew = !subscribers;
  if (!subscribers) {
    subscribers = new Set();
    keys.set(key, subscribers);
  }
  /** @type {Subscriber} */
  const me = { listener, onResync: options.onResync };
  subscribers.add(me);
  if (isNew) sendKeys(topic);

  let stopped = false;
  const mine = subscribers;
  return () => {
    if (stopped) return;
    stopped = true;
    mine.delete(me);
    if (mine.size > 0) return;
    const current = _topics.get(topic);
    if (current?.get(key) !== mine) return;
    current.delete(key);
    sendKeys(topic);
    if (current.size === 0) _topics.delete(topic);
  };
}

/**
 * Call one subscriber's function, so a throwing one cannot cost the others.
 * @param {(...args: any[]) => void} fn - The function.
 * @param {unknown[]} args - What to hand it.
 */
function call(fn, args) {
  try {
    fn(...args);
  } catch (err) {
    console.error('[Topics] Subscriber failed:', err);
  }
}

wsService.on('topic-event', (data) => {
  const frame = /** @type {import('../protocol/server-wire-types.gen.js').TopicEventFrame} */ (data);
  const subscribers = _topics.get(frame.topic)?.get(frame.key);
  if (!subscribers) return;
  for (const s of [...subscribers]) call(s.listener, [frame.event]);
});

// A new connection starts with no subscriptions on the server's side, and
// missed whatever was sent while there was none.
wsService.on('open', () => {
  for (const topic of _topics.keys()) sendKeys(topic);
  for (const keys of [..._topics.values()]) {
    for (const subscribers of [...keys.values()]) {
      for (const s of [...subscribers]) if (s.onResync) call(s.onResync, []);
    }
  }
});

/**
 * Hand one piece of news to an extension's function.
 * @callback TopicNotify
 * @param {(...args: any[]) => void} fn - The extension's function.
 * @param {any[]} args - What to hand it.
 * @param {string} what - What it is, for the log when it throws.
 * @returns {void}
 */

/** @type {TopicNotify} */
function notifyDirectly(fn, args, what) {
  try {
    fn(...args);
  } catch (err) {
    console.error(`[Topics] An extension failed to handle ${what}:`, err);
  }
}

/**
 * The topics service an extension is handed, bound to the lifetime of what it
 * was handed for: every subscription made through it ends when `signal` aborts,
 * whether or not it was ended first. Each event is a copy, so an extension
 * mutating what it was handed cannot reach another subscriber of the same key.
 * @param {AbortSignal} signal - The extension's lifetime (a pin's mount).
 * @param {{notify?: TopicNotify}} [options] - How to call the extension: the
 *   host's own wrapper, when it does more than catch a throw.
 * @returns {import('juggler/pinboard-item-type').PinTopicsService} The service.
 */
export function createTopicsService(signal, { notify = notifyDirectly } = {}) {
  return {
    subscribe(topic, key, listener, options = {}) {
      if (typeof listener !== 'function') throw new TypeError('subscribe needs a listener');
      if (signal.aborted) return () => {};
      const { onResync } = options;
      const stop = subscribe(topic, key,
        (event) => notify(listener, [event === undefined ? event : JSON.parse(JSON.stringify(event))], `a ${topic} event`),
        { onResync: onResync ? () => notify(onResync, [], `a ${topic} resync`) : undefined });
      const end = () => {
        signal.removeEventListener('abort', end);
        stop();
      };
      signal.addEventListener('abort', end, { once: true });
      return end;
    },
  };
}
