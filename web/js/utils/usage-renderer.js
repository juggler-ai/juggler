//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Human-friendly "resets in …" string from an ISO reset timestamp.
 * @param {string|undefined} resetsAt
 * @returns {string} e.g. "Resets in 3h 12m", or '' when unknown.
 */
function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Resets now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `Resets in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days}d ${hours % 24}h`;
}

/**
 * Title-case a plan label ("pro" → "Pro").
 * @param {string} plan
 * @returns {string} Title-cased plan label.
 */
export function formatPlan(plan) {
  if (!plan) return '';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * Whether a stat's window has passed its reset time.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {boolean} True once `resetsAt` is in the past.
 */
function hasWindowRolledOver(stat) {
  if (!stat?.resetsAt) return false;
  const at = new Date(stat.resetsAt).getTime();
  return Number.isFinite(at) && at < Date.now();
}

/**
 * Share of the average rate the rest of the window can afford, at or below which
 * a meter warns: the user has to ease off by a tenth to last until the reset.
 */
const AFFORD_WARN = 0.9;

/** Share of the average rate at or below which a meter is red: ease off by a quarter. */
const AFFORD_HIGH = 0.75;

/**
 * How far through its window a stat is.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {number|null} Elapsed percentage, 0-100, or null when the stat
 *   carries no window (a balance, or a provider that reports no reset).
 */
function elapsedPercent(stat) {
  const windowSecs = Number(stat.windowSecs) || 0;
  if (!stat.resetsAt || windowSecs <= 0) return null;
  const windowMs = windowSecs * 1000;
  const msElapsed = windowMs - (new Date(stat.resetsAt).getTime() - Date.now());
  if (!Number.isFinite(msElapsed)) return null;
  return Math.max(0, Math.min(100, msElapsed / windowMs * 100));
}

/**
 * Warning level for a meter. What matters is not how much of the quota is gone
 * but whether it will last: a fill at or behind the elapsed fraction — the tick —
 * lasts until the reset at the average rate, so it never warns. Past the tick,
 * the overshoot is weighed against the time left to absorb it, as the share of
 * the average rate the remaining quota can sustain over the remaining window.
 * Ten points over with most of the window ahead asks for a small easing-off;
 * the same ten points near the reset asks for a large one. A stat with no window
 * has no pace to judge, and falls back to absolute thresholds.
 * @param {number} pct - Percentage of the quota used, 0-100.
 * @param {number|null} timePct - Percentage of the window elapsed, or null.
 * @returns {string} A modifier class for `.usage-stat-fill`, or '' for none.
 */
function usageLevel(pct, timePct) {
  if (timePct === null) return pct > 80 ? 'usage-high' : (pct > 60 ? 'usage-medium' : '');
  if (pct >= 100) return 'usage-high';
  if (pct <= timePct) return '';
  const affordable = (100 - pct) / (100 - timePct);
  return affordable <= AFFORD_HIGH ? 'usage-high' : (affordable <= AFFORD_WARN ? 'usage-medium' : '');
}

/**
 * Render one usage signal. A stat with a percentage renders as a labelled meter;
 * one without (for example, a raw balance) renders its absolute value instead.
 * @param {import('../services/usage-stats-cache.js').UsageStat} stat
 * @returns {string} HTML for one `.usage-stat` row.
 */
export function renderUsageRow(stat) {
  const reset = formatResetIn(stat.resetsAt);
  const resetRow = reset ? `<div class="usage-stat-reset">${escapeHtml(reset)}</div>` : '';
  const detail = stat.detail ? escapeHtml(stat.detail) : '';

  // A window past its reset has rolled over, so its percentage belongs to the
  // window before. Until a fetch reports the new one there is no current figure.
  const hasPct = stat.usedPercent !== null && stat.usedPercent !== undefined
    && Number.isFinite(Number(stat.usedPercent))
    && !hasWindowRolledOver(stat);
  if (!hasPct) {
    return `
            <div class="usage-stat usage-stat-value">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${detail || '—'}</span>
                </div>
                ${resetRow}
            </div>`;
  }

  const pct = Math.max(0, Math.min(100, Number(stat.usedPercent) || 0));
  const timePct = elapsedPercent(stat);
  const level = usageLevel(pct, timePct);
  const timeMarker = timePct === null ? ''
    : `<div class="usage-stat-time-marker" style="left:${timePct.toFixed(1)}%" aria-hidden="true"></div>`;

  return `
            <div class="usage-stat">
                <div class="usage-stat-top">
                    <span class="usage-stat-name">${escapeHtml(stat.name)}</span>
                    <span class="usage-stat-pct">${Math.round(pct)}%</span>
                </div>
                <div class="usage-stat-bar-wrap">
                    <div class="usage-stat-bar">
                        <div class="usage-stat-fill ${level}" style="width: ${pct}%;"></div>
                    </div>
                    ${timeMarker}
                </div>
                ${detail ? `<div class="usage-stat-detail">${detail}</div>` : ''}
                ${resetRow}
            </div>`;
}
