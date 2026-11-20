//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A read that failed, said in the pane that could not read (pins/git/toast's
 * rule 3): one line in every place alike — the shared `git-inline-error` look,
 * tinted as a warning toast is — with Retry, which reads again.
 * @module pins/git/inline-error
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';

const t = translator('@juggler/core');

/**
 * @param {string} className - The place's own class for it, which it keeps.
 * @param {string} text - What could not be read, and git's reason.
 * @param {() => void} [retry] - Read again; without it there is no Retry.
 * @returns {HTMLElement} The line.
 */
export function inlineError(className, text, retry) {
  const line = createElement('div', `${className} git-inline-error`);
  const glyph = createElement('span', 'git-inline-error__icon', '!');
  glyph.setAttribute('aria-hidden', 'true');
  line.append(glyph, createElement('span', 'git-inline-error__text', text));
  if (retry) {
    const button = /** @type {HTMLButtonElement} */ (createElement('button', 'git-inline-error__retry btn btn-xs btn-neutral', t('Retry')));
    button.type = 'button';
    button.addEventListener('click', () => retry());
    line.append(button);
  }
  return line;
}
