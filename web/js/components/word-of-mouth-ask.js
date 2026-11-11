//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The "spread the word" ask itself — the info rail's card body and the About
 * box's section (components/word-of-mouth.js decides when the card shows).
 * Kept apart from the card's bookkeeping, which reaches the info-card registry
 * and the SDK behind it: the About box loads this on the server's sessions
 * page too, which has no import map to resolve those.
 * @module components/word-of-mouth-ask
 */

import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { t } from '../../sdk/lib/i18n.js';

const JUGGLER_LINK = 'https://juggler.studio';

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
  copyButton.className = card ? 'word-of-mouth__copy' : 'btn btn-secondary word-of-mouth__copy';
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
  link.className = 'word-of-mouth__link field-input field-input-sm';
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
