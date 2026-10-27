//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Word of mouth — the personal "spread the word" ask: a one-time card the info
 * rail builds in (it is not an extension card, so the info-cards menu never
 * lists it), and its permanent section in the About box. It is the lowest card
 * in the rail and only takes a slot the extension cards leave free.
 *
 * The card appears once a week has passed since the first message the user
 * sent from a composer AND messages went out on three distinct local days —
 * both read from the usage record (services/guidance/usage-signals.js, event
 * `composer:send`), which is where every count of use is kept. The
 * first time it is mounted it is recorded as asked (a `User` preference, so
 * every project and window shares it): from then on it stays in that page until
 * hidden, and no other window or later launch shows it. × and Dismiss are the
 * rail's ordinary per-window hide; a successful copy hides it too, a beat after
 * saying so. Nothing is shown until the preferences have been read.
 * @module components/word-of-mouth
 */

import { getUserPref, cachedUserPref, setUserPref, reconcilePref, notifyPrefChanged } from '../services/prefs.js';
import { usageFirst, usageDays, USAGE_CHANGED_EVENT } from '../services/guidance/usage-signals.js';
import { INFO_CARDS_CHANGED_EVENT, hideCard } from '../services/info-cards-manager.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';

/** Epoch ms of the first time the card was put up, anywhere. */
const ASKED_PREF = 'juggler-word-of-mouth-asked';

const JUGGLER_LINK = 'https://juggler.studio';

const MIN_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_DISTINCT_DAYS = 3;

/** How long "Link copied" stays up before the card goes. */
const COPIED_ACK_MS = 1500;

/** True once the preferences have been read from the server. */
let loaded = false;
/** True once this page has put the card up. */
let shownHere = false;

/**
 * @param {number} now
 * @returns {boolean} Whether enough use has been seen to ask.
 */
function isEligible(now) {
  const first = usageFirst('composer:send');
  return first !== null && usageDays('composer:send') >= MIN_DISTINCT_DAYS && now - first >= MIN_ELAPSED_MS;
}

/**
 * Read the preferences, then let the card decide. Called once per window.
 * @returns {Promise<void>}
 */
export async function startWordOfMouth() {
  await getUserPref(ASKED_PREF);
  // Another window putting the card up re-syncs this window's rail.
  void reconcilePref('user', ASKED_PREF, INFO_CARDS_CHANGED_EVENT);
  loaded = true;
  notifyPrefChanged(INFO_CARDS_CHANGED_EVENT);
  // A send that makes the card eligible re-syncs the rail too.
  window.addEventListener(USAGE_CHANGED_EVENT, () => {
    if (!shownHere && isEligible(Date.now())) notifyPrefChanged(INFO_CARDS_CHANGED_EVENT);
  });
}

/** @returns {boolean} Whether the card should be in the rail. */
function shouldShowAsk() {
  if (!loaded) return false;
  if (shownHere) return true;
  return !cachedUserPref(ASKED_PREF, null) && isEligible(Date.now());
}

/**
 * The card has been put up: record it, so nothing else ever puts it up again.
 * @returns {void}
 */
function markAsked() {
  if (shownHere) return;
  shownHere = true;
  if (!cachedUserPref(ASKED_PREF, null)) void setUserPref(ASKED_PREF, Date.now());
}

/**
 * Build the ask: the card's body, signed off, with Copy and Dismiss; or About's
 * section, with a heading and Copy. Copy puts {@link JUGGLER_LINK} on the
 * clipboard and nothing else; if that fails the link is shown to select.
 * @param {object} opts
 * @param {'card'|'about'} opts.variant
 * @param {() => void} [opts.onCopied]
 * @param {() => void} [opts.onDismiss]
 * @returns {HTMLElement} The ask.
 */
export function buildWordOfMouthAsk({ variant, onCopied, onDismiss }) {
  const card = variant === 'card';
  const root = document.createElement('div');
  root.className = 'word-of-mouth';

  if (!card) {
    const heading = document.createElement('p');
    heading.className = 'about-description word-of-mouth__heading';
    heading.textContent = t('Tell someone about Juggler');
    root.appendChild(heading);
  }

  const body = document.createElement('p');
  body.className = card ? 'info-card__body' : 'about-description';
  body.textContent = t('If Juggler\u2019s been useful to you, I\u2019d really appreciate you mentioning it wherever you talk about coding. A few words about what you use it for would help other developers discover it.');
  if (card) {
    const signature = document.createElement('span');
    signature.className = 'word-of-mouth__signature';
    signature.textContent = t('Thanks! \u2014 Julian');
    body.append(' ', signature);
  }
  root.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'word-of-mouth__actions';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = card ? 'word-of-mouth__copy' : 'about-button btn-secondary word-of-mouth__copy';
  copyButton.textContent = t('Copy Juggler link');
  actions.appendChild(copyButton);
  if (card) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'word-of-mouth__dismiss';
    dismiss.textContent = t('Dismiss');
    dismiss.addEventListener('click', () => onDismiss?.());
    actions.appendChild(dismiss);
  }
  root.appendChild(actions);

  const fallback = document.createElement('p');
  fallback.className = 'word-of-mouth__fallback';
  fallback.hidden = true;
  fallback.textContent = t('Couldn\u2019t copy it here. Select the link to copy it yourself:');
  const link = document.createElement('input');
  link.className = 'word-of-mouth__link';
  link.readOnly = true;
  link.value = JUGGLER_LINK;
  link.setAttribute('aria-label', t('Juggler link'));
  link.addEventListener('focus', () => link.select());
  fallback.appendChild(link);
  root.appendChild(fallback);

  copyButton.addEventListener('click', async () => {
    try {
      await copyToClipboard(JUGGLER_LINK);
    } catch {
      fallback.hidden = false;
      return;
    }
    fallback.hidden = true;
    copyButton.textContent = t('Link copied');
    onCopied?.();
  });

  return root;
}

/**
 * The card, in the shape the info rail mounts. × and Dismiss are the rail's
 * ordinary per-window hide: no other window or later launch shows it anyway.
 */
export const WORD_OF_MOUTH_CARD = {
  id: 'word-of-mouth',
  name: markForTranslation('Spread the word'),
  eyebrow: markForTranslation('Spread the word'),
  hasContent: shouldShowAsk,
  /**
   * @param {HTMLElement} contentEl
   * @returns {() => void} Teardown.
   */
  mount(contentEl) {
    markAsked();
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    contentEl.appendChild(buildWordOfMouthAsk({
      variant: 'card',
      onCopied: () => { timer = setTimeout(() => hideCard('word-of-mouth'), COPIED_ACK_MS); },
      onDismiss: () => hideCard('word-of-mouth'),
    }));
    return () => { if (timer !== null) clearTimeout(timer); };
  },
};
