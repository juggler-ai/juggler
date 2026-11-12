//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Zoom Manager - Handles UI zoom via root font-size scaling.
 *
 * The zoom is a window preference, exactly as the theme is (see
 * theme-manager.js and services/prefs.js): every window of every project keeps
 * its own, so zooming one window leaves every other window as it was. On the
 * server's own machine it is kept in the project's session under the window's
 * role; a viewer on another machine — a phone, or the desktop app's own window
 * on a server elsewhere — keeps its own copy and never writes back.
 *
 * It is applied before first paint (a font-size change reflows everything, so a
 * late correction is a visible jump), by index.html's pre-paint block from the
 * same sources this module reconciles: this window's zoom (window.__windowZoom,
 * server-injected) and cache, a ?zoom= seed from the window that opened this
 * one, and what an older build kept for the whole machine (window.__machineZoom)
 * or the project (window.__projectZoom), adopted once by a window that has none.
 * This module is the authoritative reconciler and owns persistence.
 *
 * One limitation, in the transport rather than here: a Cloudflare quick tunnel
 * hands out a fresh hostname every session, so a viewer reaching a project that
 * way gets an empty localStorage each time and opens at the host's zoom again.
 */

import { onDocumentReady } from './document-ready.js';
import { postWindowControl } from '../../sdk/lib/window-control.js';
import {
  isRemoteViewer, startingWindowPref, cachedWindowPref, setWindowPref, reconcilePref,
} from '../services/prefs.js';

/**
 * The zoom's name in the window realm. Not 'juggler-zoom', which is what an
 * older build kept for the whole machine in settings.json: that one is still
 * read, as a starting point for a window with none (serveIndex injects it).
 */
const ZOOM_PREF = 'juggler-window-zoom';
/** Announces that this window's stored zoom was learned late (see prefs.reconcilePref). */
const ZOOM_PREF_EVENT = 'juggler-window-zoom-pref-changed';
const ZOOM_STEP = 10;
const ZOOM_MIN = 60;
const ZOOM_MAX = 160;
const ZOOM_DEFAULT = 110;

/** The live applied zoom level, resolved at init and updated on every change. */
let current = ZOOM_DEFAULT;

/**
 * Clamp a level to the supported range.
 * @param {number} level - Raw zoom percentage.
 * @returns {number} Clamped percentage.
 */
function clamp(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

/**
 * A usable level from a stored, injected or URL value; null when it is absent
 * or not a positive number.
 * @param {unknown} raw - Candidate value.
 * @returns {number|null} A valid clamped level, or null.
 */
function parseLevel(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? clamp(n) : null;
}

/**
 * This window's own stored zoom, as known right now.
 * @returns {number|null} The stored level, or null.
 */
function storedZoom() {
  return parseLevel(cachedWindowPref(ZOOM_PREF, null));
}

/**
 * The inherited seed from the window that opened this one (a ?zoom= param the
 * native host bakes into the URL).
 * @returns {number|null} The seed level, or null.
 */
function seedZoom() {
  try {
    return parseLevel(new URL(window.location.href).searchParams.get('zoom'));
  } catch (_e) {
    return null;
  }
}

/**
 * Apply a zoom level to the document root.
 * @param {number} level - Zoom percentage.
 * @private
 */
function applyZoom(level) {
  document.documentElement.style.fontSize = level + '%';
}

/**
 * Report the current zoom to the native host so the next window it opens
 * inherits this (last-active) size. A no-op in a plain browser tab.
 * @param {number} level - Zoom percentage.
 * @private
 */
function reportToHost(level) {
  postWindowControl('zoom', '?zoom=' + level);
}

/**
 * The live applied zoom level.
 * @returns {number} Current zoom percentage.
 */
export function getCurrentZoom() {
  return current;
}

/**
 * Set this window's zoom level, apply, store it, and report to the native host
 * so the next window it opens starts at it. No other window follows; a viewer
 * on another machine keeps it on that device and the host is left alone.
 * @param {number} level - Zoom percentage (clamped to min/max).
 */
function setZoom(level) {
  current = clamp(level);
  applyZoom(current);
  void setWindowPref(ZOOM_PREF, current);
  reportToHost(current);
}

/**
 * Increase zoom by one step.
 */
export function zoomIn() {
  setZoom(current + ZOOM_STEP);
}

/**
 * Decrease zoom by one step.
 */
export function zoomOut() {
  setZoom(current - ZOOM_STEP);
}

/**
 * Adopt this window's stored zoom when, at boot, the realm knew something the
 * cache did not. Nothing announces another window's change: the window realm
 * is this window's alone.
 * @private
 */
function followStoredZoom() {
  const level = storedZoom();
  if (level === null || level === current) return;
  current = level;
  applyZoom(current);
}

/**
 * Initialize zoom on page load. Resolves the level the pre-paint block applied
 * (prefs.startingWindowPref), stores it when it was handed to this window
 * rather than chosen here — never the plain default — and reports it to the
 * host. What an older build kept for the machine or the project is offered
 * only on this machine: a viewer on another one starts from the host's but
 * keeps its own.
 * @private
 */
function initZoom() {
  const local = !isRemoteViewer();
  const injected = parseLevel(window.__windowZoom);
  const machine = parseLevel(window.__machineZoom);
  const start = startingWindowPref({
    own: local ? (injected ?? storedZoom()) : storedZoom(),
    inherited: local
      ? [seedZoom(), machine, parseLevel(window.__projectZoom)]
      : [seedZoom()],
    host: local ? null : (injected ?? machine),
    fallback: ZOOM_DEFAULT,
  });
  current = start.value;
  applyZoom(current);
  // Report to the host so its inheritance seed tracks this window's size.
  reportToHost(current);
  if (start.adopt) void setWindowPref(ZOOM_PREF, current);

  window.addEventListener(ZOOM_PREF_EVENT, followStoredZoom);
  void reconcilePref('window', ZOOM_PREF, ZOOM_PREF_EVENT);
}

// Auto-initialize when module loads. Zoom is a viewer affordance; onDocumentReady
// skips off the main thread (the engine worker has no document).
onDocumentReady(initZoom);
