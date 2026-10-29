//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The name of the "reveal in file manager" action on this platform, for
 * `<reveal-button>` and every menu row that offers the same action.
 * @module utils/reveal-label
 */

import { t } from '../../sdk/lib/i18n.js';

/**
 * Platform-appropriate label for the "reveal in file manager" action. Prefers
 * the window's declared platform (set by the desktop app) and falls back to UA
 * sniffing for plain browser tabs.
 * @returns {string} e.g. "Reveal in Finder" / "Reveal in Explorer".
 */
export function revealLabel() {
  const platform = document.documentElement.dataset.windowPlatform;
  if (platform === 'windows') return t('Reveal in Explorer');
  if (platform === 'mac') return t('Reveal in Finder');
  const ua = navigator.userAgent || '';
  if (/Windows/.test(ua)) return t('Reveal in Explorer');
  if (/Macintosh|Mac OS X/.test(ua)) return t('Reveal in Finder');
  // Finder and Explorer are named because the platform names them. Everywhere
  // else there is no one answer — the file manager is whichever one the desktop
  // registered — so the label says the job rather than inventing a name.
  return t('Show in file manager');
}
