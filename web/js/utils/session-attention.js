//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the machine's sessions are doing, in words and numbers, for every place
 * that shows it — the session switcher (components/session-switcher.js) and
 * ⇧⌘J (services/attention-anywhere.js) — so they say it alike. Pure: each answer comes from the sessions as the
 * events stream sends them (services/sessions-feed.js) and the time it is
 * asked.
 * @module utils/session-attention
 */

import { t, formatRelativeTime } from '../../sdk/lib/i18n.js';

/**
 * @typedef {import('../services/sessions-feed.js').Session} Session
 * @typedef {import('../services/sessions-feed.js').AttentionItem} AttentionItem
 * @typedef {{s: Session, item: AttentionItem}} Need
 *   A conversation that needs the user, with the session it is in.
 */

/**
 * The last segment of a path, for a project's display name.
 * @param {string} p - A folder path, POSIX or Windows.
 * @returns {string} Its last segment (the path itself if it has none).
 */
export function baseName(p) {
  return p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;
}

/**
 * A distance in time, in the largest unit that keeps it whole enough to read.
 * @param {number} ms - Signed milliseconds from now (negative is past).
 * @returns {string} "5 minutes ago", "in 4 seconds", ….
 */
export function relative(ms) {
  const s = Math.round(ms / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return formatRelativeTime(s, 'second');
  if (abs < 3600) return formatRelativeTime(Math.round(s / 60), 'minute');
  if (abs < 86400) return formatRelativeTime(Math.round(s / 3600), 'hour');
  return formatRelativeTime(Math.round(s / 86400), 'day');
}

/**
 * Whether a session is between lives — starting, stopping or restarting —
 * which its tile shows with the spinner, never a colour.
 * @param {Session} s - The session.
 * @returns {boolean} True while it is.
 */
export function inLifecycle(s) {
  return s.state === 'starting' || s.state === 'stopping' || s.state === 'restarting';
}

/**
 * How many of a session's conversations wait on the user, are working, or
 * failed, as its child last reported. A busy session whose child has not
 * reported yet, or reports nothing, counts as one working.
 * @param {Session} s - The session.
 * @returns {{waiting: number, working: number, failed: number}} The counts.
 */
export function attentionCounts(s) {
  const a = s.attention;
  return {
    waiting: a?.waiting || 0,
    working: Math.max(a?.working || 0, s.busy ? 1 : 0),
    failed: a?.failed || 0,
  };
}

/**
 * A project's initials, as its tile shows them: the first letters of its
 * folder name's first two words, or the first two letters of a one-word name.
 * @param {string} name - The folder's name.
 * @returns {string} One or two characters.
 */
export function initials(name) {
  const [first = name, second = ''] = name.split(/[-_.\s]+/).filter(Boolean);
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return first.charAt(0).toUpperCase() + first.charAt(1);
}

/**
 * What a session between lives — starting, stopping or restarting — is doing,
 * in words; its state as it stands in any other.
 * @param {Session} s - The session.
 * @param {number} now - The time now, in ms.
 * @returns {string} Its status line.
 */
export function lifecycleText(s, now) {
  switch (s.state) {
    case 'starting':
      return t('Starting…');
    case 'stopping':
      return t('Stopping…');
    case 'restarting': {
      const when = s.nextRestartAt ? relative(Math.max(0, Date.parse(s.nextRestartAt) - now)) : '';
      const retry = when ? t('Crashed · restarting {when}', { when }) : t('Crashed · restarting');
      if (!s.restarts) return retry;
      return `${retry} · ${t('{count, plural, one {restarted # time} other {restarted # times}}', { count: s.restarts })}`;
    }
    default:
      return s.state;
  }
}

/**
 * Every conversation that needs the user, across the sessions: those waiting
 * first, then those that failed, each oldest first.
 * @param {Session[]} sessions - The sessions.
 * @returns {Need[]} The conversations, each with its session.
 */
export function needsAcross(sessions) {
  /** @type {Need[]} */
  const out = [];
  for (const s of sessions) {
    for (const item of s.attention?.items || []) out.push({ s, item });
  }
  /**
   * @param {AttentionItem} item
   * @returns {[number, number]} Its place: waiting before failed, then oldest first.
   */
  const place = (item) => [item.state === 'waiting' ? 0 : 1, Date.parse(item.since || '') || 0];
  return out.sort((a, b) => {
    const [pa, sa] = place(a.item);
    const [pb, sb] = place(b.item);
    return pa - pb || sa - sb;
  });
}
