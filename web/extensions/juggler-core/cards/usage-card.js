//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Usage info card — a quiet, live summary of quota windows for the provider
 * the user is working with. It renders cache data immediately, keeps
 * the countdowns ticking whether or not the window is focused, and fetches fresh
 * data silently — on every tick while focused, on a slow beat and at the end of
 * each turn while not — preserving the existing meter nodes whenever their
 * generated HTML has not changed.
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region.
 * @module extensions/juggler-core/cards/usage-card
 */

import InfoCardType from 'juggler/info-card-type';
import { translator } from 'juggler/i18n';
import defaultModelCache from '../../../js/services/default-model-cache.js';
import providersCache from '../../../js/services/providers-cache.js';
import usageStatsCache from '../../../js/services/usage-stats-cache.js';
import { escapeHtml, injectStylesOnce } from 'juggler/ui';
import { formatPlan, renderUsageRow } from '../../../js/utils/usage-renderer.js';

const t = translator('@juggler/core');

// Active provider and optional plan above the shared usage meter rows; the
// stale note sits under meters kept from an earlier fetch after a later one
// failed.
injectStylesOnce('usage-card-styles', `
.usage-card__sub {
  font-size: var(--font-size-xs);
  line-height: var(--leading-tight);
  color: var(--text-secondary);
}

.usage-card__stale {
  padding-top: var(--space-6);
  font-size: var(--font-size-xs);
  line-height: var(--leading-tight);
  color: var(--text-tertiary);
}
`);

// Re-render/retry tick. Live network fetches are governed by the usage cache's
// own per-provider debounce (aligned to the upstream ~5-minute refresh), so this
// timer only needs to be frequent enough to pick up a fresh snapshot shortly
// after that window clears and to land each "resets in …" minute rollover close
// to the minute it happens — every tick before then is a cheap debounced no-op
// that renders identical HTML and so writes no DOM.
const REFRESH_MS = 10_000;

// Minimum gap between live fetches while the window is unfocused. Focused, the
// card asks on every tick and the usage cache's debounce decides what actually
// leaves the machine. Unfocused, it asks far less often — but it does keep
// asking: a run left working in the background is exactly when the numbers move,
// and a card frozen at the moment you looked away reads as broken rather than as
// restraint. The busy gap applies while any conversation is mid-turn; a turn
// ending asks immediately, so this only governs how a long run is sampled.
const BACKGROUND_BUSY_MS = 2 * 60 * 1000;
const BACKGROUND_IDLE_MS = 10 * 60 * 1000;

/**
 * The provider whose quota the card should be reporting.
 *
 * The card sits in the sidebar chrome rather than in a conversation panel, so it
 * is on screen in states no conversation is: selecting a workspace shows its
 * panel and leaves nothing visible to name a provider. Quota is an account-level
 * number, not a property of what happens to be on screen, so the card keeps
 * answering — with the conversation behind the panel, then with the provider a
 * new conversation would be seeded with. '' only when the account has none.
 * @param {import('../../../js/model/session.js').default|undefined} session
 * @returns {string} Provider name, or ''.
 */
function activeProvider(session) {
  const visible = session?.getVisibleConversation?.()?.modelConfig?.provider;
  if (visible) return visible;
  const behind = session?.conversations?.get?.(session?.loadedConversationId ?? '')?.modelConfig?.provider;
  if (behind) return behind;
  return defaultModelCache.get()?.provider || '';
}

/**
 * The provider's display name from the latest server-pushed provider list.
 * @param {string} providerName
 * @returns {string} Human-friendly provider label.
 */
function providerLabel(providerName) {
  return providersCache.get().find((provider) => provider.name === providerName)?.displayName || providerName;
}

/**
 * Keep the card's error state useful without pouring an upstream command line
 * into the sidebar. The full error remains available as a tooltip.
 * @param {string} error
 * @returns {string} Short user-facing error.
 */
function usageErrorLabel(error) {
  if (/sign-in not yet confirmed|not logged in/i.test(error)) return t('Not logged in');
  return t('Couldn’t get usage');
}

/**
 * The Usage info card.
 */
export default class UsageCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'usage',
    name: 'Usage',
    version: '1.0.0',
    description: 'Show your active model provider’s quota usage in the sidebar.',
    eyebrow: 'Usage',
    priority: 20,
  };

  /** @returns {boolean} Always renderable (it reports its own empty state). */
  hasContent() {
    return true;
  }

  /**
   * Paint cached usage immediately, keep it repainting on a timer, and silently
   * fetch fresh data — every tick while the window is active, on a slow beat and
   * at the end of each turn while it is not.
   * @param {HTMLElement} contentEl
   * @param {import('../../../js/model/session.js').default} [session]
   * @returns {() => void} Teardown that stops polling and listeners.
   */
  mount(contentEl, session = undefined) {
    let disposed = false;
    /** @type {string|null} */
    let lastHTML = null;
    let lastProvider = '';
    let lastFetchAt = 0;
    let wasBusy = false;

    const focused = () => typeof document === 'undefined' || document.hasFocus();
    // Session-wide on purpose: quota is an account-level number, so a turn
    // running in a tab the user isn't looking at burns it just the same.
    const busy = () => !!session?.getServices?.()?.llmState?.isActive;
    const render = () => {
      if (disposed) return;
      const providerName = activeProvider(session);
      const usage = usageStatsCache.get(providerName);
      const error = usageStatsCache.getError(providerName);
      const stats = usage?.stats || [];
      const hasStats = stats.length > 0;
      const subtitle = providerName
        ? `<div class="usage-card__sub">${escapeHtml(providerLabel(providerName))}${usage?.plan ? ` · ${escapeHtml(formatPlan(usage.plan))}` : ''}</div>`
        : '';
      // Meters kept from an earlier fetch are not current once a later one has
      // failed, so they carry a note saying so, with the error as its tooltip.
      const staleNote = hasStats && error
        ? `<div class="usage-card__stale" title="${escapeHtml(error)}">${escapeHtml(t('Couldn’t refresh — showing earlier figures'))}</div>`
        : '';
      const body = hasStats
        ? stats.map(renderUsageRow).join('') + staleNote
        : error
          ? `<p class="info-card__body" title="${escapeHtml(error)}">${escapeHtml(usageErrorLabel(error))}</p>`
          : `<p class="info-card__body">${escapeHtml(t('No usage data'))}</p>`;
      const html = `${subtitle}${body}`;
      if (html !== lastHTML) {
        contentEl.innerHTML = html;
        lastHTML = html;
      }
    };

    const refresh = async () => {
      if (disposed) return;
      // The paint is unconditional and the network call is not: a quota window
      // drains whether or not anyone is watching, so the countdown keeps moving
      // in an unfocused window, and the numbers behind it are still refreshed —
      // just on a much slower beat, slower again when nothing is running.
      // Only one provider is ever shown, so fetch just that one — never poll
      // providers the user isn't looking at.
      let providerName = activeProvider(session);
      if (!providerName) {
        // Nothing on screen or behind it names a provider — a session opened
        // straight onto a workspace panel, or one with no conversations at all.
        // Both are answered by the default, which the server resolves.
        await defaultModelCache.refresh();
        providerName = activeProvider(session);
      }
      if (providerName) {
        const now = Date.now();
        const gap = focused() ? 0 : (busy() ? BACKGROUND_BUSY_MS : BACKGROUND_IDLE_MS);
        if (now - lastFetchAt >= gap) {
          lastFetchAt = now;
          await usageStatsCache.refresh(providerName);
        }
      }
      render();
    };
    const onFocus = () => { refresh(); };
    const onSessionEvent = () => {
      const providerName = activeProvider(session);
      if (providerName !== lastProvider) {
        lastProvider = providerName;
        // A different provider means different numbers, so this one fetch is not
        // held behind the unfocused beat — otherwise the card sits on "No usage
        // data" for the rest of the gap.
        lastFetchAt = 0;
        render();
        refresh();
      }
    };
    const onStatusChange = () => {
      const nowBusy = busy();
      if (nowBusy === wasBusy) return;
      wasBusy = nowBusy;
      // The end of a turn is the one moment the numbers are known to have moved,
      // so ask then rather than waiting out the rest of the beat.
      if (!nowBusy) {
        lastFetchAt = 0;
        refresh();
      }
    };

    lastProvider = activeProvider(session);
    wasBusy = busy();
    render();
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    // A hidden window's timers are throttled, so catch the countdown up the
    // moment it comes back rather than waiting out the next tick.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onFocus);
    const unsubscribe = session?.subscribe?.(onSessionEvent);
    const unsubscribeStatus = session?.onLLMStatusChange?.(onStatusChange);

    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onFocus);
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof unsubscribeStatus === 'function') unsubscribeStatus();
    };
  }
}
