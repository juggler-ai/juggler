//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Formatting utilities for displaying numbers, sizes, durations and times.
 *
 * Every function here formats through `Intl` in the UI's formatting locale
 * (`formattingLocale()` in sdk/lib/i18n.js): the runtime's own default until a
 * UI language is chosen, so output is what the platform would produce, and the
 * chosen language's conventions after. The token suffixes (`k`, `M`) and the
 * size units (`KB`, `MB`) are messages around pre-formatted digits, so a
 * catalogue can re-word or re-place them; in English they read as the bare
 * symbols. `formatNumber`'s SI suffixes are the exception and stay symbols.
 */

import {
  t, formatNumber as formatLocaleNumber, formatDate, formatRelativeTime, formattingLocale,
} from '../../sdk/lib/i18n.js';
import { SIZE_UNITS, sizeWithUnit } from '../../sdk/lib/unit-messages.js';

/**
 * Plain digits in the formatting locale, without thousands grouping: for a
 * number that already carries a unit and should read as one token.
 * @param {number} value
 * @param {number} [maxFraction=20] - The most fraction digits to show.
 * @returns {string} The formatted digits.
 */
function digits(value, maxFraction = 20) {
  return formatLocaleNumber(value, { useGrouping: false, maximumFractionDigits: maxFraction });
}

/**
 * Format a number with SI suffixes (k, M, B, T)
 * @param {number} num - Number to format
 * @param {number} [decimals=1] - Number of decimal places
 * @returns {string} - Formatted number (e.g., "1.2k", "3.4M")
 */
export function formatNumber(num, decimals = 1) {
  if (num === 0) return digits(0);
  if (num < 1000) return digits(num);

  const units = ['', 'k', 'M', 'B', 'T'];
  const tier = Math.floor(Math.log10(Math.abs(num)) / 3);
  const unit = units[tier] || units[units.length - 1];
  const scaled = num / Math.pow(1000, tier);

  // At most `decimals` fraction digits, and none that are trailing zeros.
  return digits(scaled, decimals) + unit;
}

/**
 * Format a byte count as a short human-readable size (e.g. "0 B", "9.4 KB",
 * "12 MB", "3.2 GB"). Values below 10 keep one decimal; larger values round.
 * Returns '' for an invalid/negative input so callers can omit the field.
 * @param {number} bytes
 * @returns {string} The formatted size, or '' for invalid input.
 */
export function formatBytes(bytes) {
  const size = byteSize(bytes);
  return size ? sizeWithUnit(size.figure, size.unit) : '';
}

/**
 * {@link formatBytes} with the unit always the English symbol: for a size inside
 * text that is parsed back, or read by the model, rather than only shown.
 * @param {number} bytes
 * @returns {string} The formatted size, or '' for invalid input.
 */
export function formatBytesUntranslated(bytes) {
  const size = byteSize(bytes);
  return size ? `${size.figure} ${size.unit}` : '';
}

/**
 * The figure and unit {@link formatBytes} shows for a byte count.
 * @param {number} bytes
 * @returns {{figure: string, unit: typeof SIZE_UNITS[number]}|null} Null for invalid input.
 */
function byteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return { figure: digits(bytes), unit: 'B' };
  let val = bytes / 1024;
  let i = 1;
  while (val >= 1024 && i < SIZE_UNITS.length - 1) {
    val /= 1024;
    i++;
  }
  const figure = val < 10
    ? formatLocaleNumber(val, { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : digits(Math.round(val));
  return { figure, unit: SIZE_UNITS[i] ?? 'TB' };
}

/**
 * Short relative "N ago" string from a unix-ms timestamp: "just now", "5 min
 * ago", "2 hrs ago", "3 days ago". Messages rather than
 * `Intl.RelativeTimeFormat`'s short style, whose abbreviations vary by runtime
 * and locale ("5 min. ago", "2 hr. ago") — a catalogue translates them.
 * @param {number} ms - Unix-ms timestamp in the past
 * @returns {string} A short "N min ago"-style string, or '' for a falsy input.
 */
export function formatTimeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 45000) return t('just now');
  const count = Math.round(diff / 60000);
  if (count < 60) return t('{count, plural, one {# min ago} other {# min ago}}', { count });
  const hrs = Math.round(count / 60);
  if (hrs < 24) return t('{count, plural, one {# hr ago} other {# hrs ago}}', { count: hrs });
  return t('{count, plural, one {# day ago} other {# days ago}}', { count: Math.round(hrs / 24) });
}

/**
 * Compact token count for UI labels: a million or more collapses to "NM" with
 * at most one decimal, 2000+ to "Nk", below that the exact count with thousands
 * separators. Both tiers floor, so a count never reads higher than it is.
 * Shared by the footer token pill, thinking-message summaries, and the model
 * selector so token counts read consistently everywhere.
 * @param {number} n - Token count
 * @returns {string} Formatted count, e.g. "1.5M", "272k" or "1,500"
 */
export function formatTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1000000) {
    return t('{n}M', { n: digits(Math.floor(v / 100000) / 10) }, { context: 'millions, in a compact count' });
  }
  if (v >= 2000) return t('{n}k', { n: digits(Math.floor(v / 1000)) }, { context: 'thousands, in a compact count' });
  return formatLocaleNumber(v);
}

/**
 * `Intl.DurationFormat` in its narrow style, or null where the runtime lacks it
 * or the value is not a whole number of seconds (it accepts integers only).
 * @param {number} seconds
 * @returns {string|null} The formatted duration, spaces made non-breaking.
 */
function formatDurationIntl(seconds) {
  const DurationFormat = /** @type {typeof Intl & {DurationFormat?: new (locale: string|undefined, options: {style: string}) => {format: (parts: Record<string, number>) => string}}} */ (Intl).DurationFormat;
  if (typeof DurationFormat !== 'function' || !Number.isInteger(seconds) || seconds < 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  // The same units the fallback shows: seconds alone under a minute, minutes
  // and seconds under an hour, hours and minutes beyond — zero parts dropped.
  /** @type {Record<string, number>} */
  const parts = hours > 0 ? { hours, minutes } : minutes > 0 ? { minutes, seconds: secs } : { seconds: secs };
  for (const key of Object.keys(parts)) if (parts[key] === 0 && Object.keys(parts).length > 1) delete parts[key];
  try {
    const formatter = new DurationFormat(formattingLocale(), { style: 'narrow' });
    return formatter.format(parts).replace(/ /g, '\u00A0');
  } catch {
    return null;
  }
}

/**
 * Format a duration in seconds as a compact string ("3s", "1m 23s", "2h 5m").
 * A zero lower unit is dropped ("2h", not "2h 0m"). The two parts are joined
 * with a non-breaking space so a pair like "10m 7s" never wraps across lines.
 * App-wide canonical duration formatter — route elapsed/duration labels through
 * this so they read consistently everywhere.
 * @param {number} seconds Duration in seconds.
 * @returns {string} Formatted duration.
 */
export function formatDuration(seconds) {
  const viaIntl = formatDurationIntl(seconds);
  if (viaIntl !== null) return viaIntl;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m\u00A0${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h\u00A0${remainMins}m` : `${hours}h`;
}

/** @type {Intl.DateTimeFormatOptions} */
const TIME_24H = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

/**
 * Upper-case a phrase's first letter, for a word `Intl` returns in running-text
 * case ("yesterday") that is shown here at the start of a label.
 * @param {string} text
 * @returns {string} The text with its first character upper-cased.
 */
function sentenceCase(text) {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * Format a date/time as a compact relative string with a longer
 * tooltip-friendly absolute string. App-wide canonical relative
 * date-time formatter — keep all UI date rendering routed through this
 * so labels stay consistent. Today → "HH:MM:SS"; yesterday →
 * "Yesterday, HH:MM:SS"; otherwise "Mon D, HH:MM:SS".
 * @param {number|string|Date} input - Unix ms, ISO string, or Date
 * @returns {{short: string, full: string}} compact label + full absolute label for tooltips
 */
export function formatRelativeDateTime(input) {
  const date = input instanceof Date
    ? input
    : typeof input === 'number'
      ? new Date(input)
      : new Date(String(input));
  if (isNaN(date.getTime())) {
    const raw = String(input);
    return { short: raw, full: raw };
  }
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const timeStr = formatDate(date, TIME_24H);
  const full = formatDate(date, { month: 'short', day: 'numeric', ...TIME_24H });
  if (isToday) return { short: timeStr, full };
  const day = isYesterday
    ? sentenceCase(formatRelativeTime(-1, 'day', { numeric: 'auto' }))
    : formatDate(date, { month: 'short', day: 'numeric' });
  return { short: t('{day}, {time}', { day, time: timeStr }), full };
}
