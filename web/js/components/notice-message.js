//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage, { FINAL_ITEM_ATTR } from './base-message.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';
import { NOTICE_TYPE_NAME } from '../utils/item-badge.js';
import { openSettings } from '../services/settings-launcher.js';
import { t } from '../../sdk/lib/i18n.js';
import { formatTokens } from '../utils/format.js';

/**
 * Notice message component — a durable record of something that happened to a
 * turn and is worth reading after the fact: a provider rebuilding its context
 * cache, say. It stands in the transcript where the event occurred, so the
 * explanation is still there when the user gets round to looking at it.
 *
 * Amber triangle, and no action button unless the notice names a setting: a
 * notice reports, it does not ask. The row is one line — icon, a "Warning"
 * lozenge and a sentence saying what happened — because nothing failed and
 * nothing needs doing. The lozenge says only what kind of item this is; a
 * reader who cannot see why it is there has been told nothing, so the sentence
 * beside it carries the meaning. The rest (the measured values, the provider's
 * verbatim reason) is read by selecting the row, in the properties panel.
 *
 * The exceptions are notices that come with a fix. One whose cause is a setting
 * the user can correct — a context window Juggler had to assume — carries a
 * `notice-settings` target, and the row gains a single link to that field, so
 * the fix is one click from the explanation rather than a hunt through
 * Settings. One reporting a turn cut off at its Max output may carry
 * `notice-retry-max-output`, and while it is the thread's last item the row
 * offers to run that turn again, once, with Max output raised to that figure.
 */
class NoticeMessage extends BaseMessage {
  static get observedAttributes() {
    return ['notice-text', 'notice-settings', 'notice-retry-max-output', FINAL_ITEM_ATTR];
  }

  /** @returns {string} The notice's one-line explanation */
  get text() {
    return this.getAttribute('notice-text') || '';
  }

  /**
   * The setting this notice links to, when it names one Juggler knows how to
   * open. Only a model's Context window field is such a target today.
   * @returns {{provider: string, model: string}|null} The model whose window to open
   */
  get settingsTarget() {
    const raw = this.getAttribute('notice-settings');
    if (!raw) return null;
    try {
      const target = JSON.parse(raw);
      if (target?.tab === 'providers' && target.field === 'contextWindow'
        && typeof target.provider === 'string' && typeof target.model === 'string') {
        return { provider: target.provider, model: target.model };
      }
    } catch {
      // A malformed target is simply not a link.
    }
    return null;
  }

  /**
   * The Max output a retry of the cut-off turn would run at, or 0 when this
   * notice offers none.
   * @returns {number} Tokens
   */
  get retryMaxOutput() {
    const tokens = Number(this.getAttribute('notice-retry-max-output'));
    return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'notice-message-row';

    // A fixed lozenge and the explanation beside it, in the type-name/summary
    // shape every other one-line item uses — so the row is the same height as
    // its neighbours and the sentence truncates rather than wrapping.
    const body = renderResultStatusMessage({ typeName: t(NOTICE_TYPE_NAME), summary: this.text });

    // The `error` glyph is a warning triangle; amber rather than the error
    // component's red, and distinct from thinking's yellow.
    article.appendChild(wrapWithIcon(body, {
      color: 'amber',
      iconSvg: TYPE_ICONS.error
    }));

    const target = this.settingsTarget;
    const retryMaxOutput = this.isFinalItem ? this.retryMaxOutput : 0;
    if (retryMaxOutput) {
      const actions = document.createElement('div');
      actions.className = 'notice-message-actions message-row-body';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-secondary message-action-btn notice-retry-btn';
      button.textContent = t('Retry with {count} tokens', { count: formatTokens(retryMaxOutput) });
      button.title = t('Run this turn again once, with Max output raised to {count} tokens. Settings stay as they are.',
        { count: formatTokens(retryMaxOutput) });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = this.itemId;
        if (id) this._getMessageThread()?.retryTruncatedTurn(id);
      });
      actions.appendChild(button);
      article.appendChild(actions);
    } else if (target) {
      const actions = document.createElement('div');
      actions.className = 'notice-message-actions message-row-body';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-secondary message-action-btn notice-settings-btn';
      button.textContent = t('Set context window');
      button.title = t('Open {model}\'s Context window field in Settings → Providers', { model: target.model });
      button.addEventListener('click', (event) => {
        // The row is selectable; opening settings is not a selection.
        event.preventDefault();
        event.stopPropagation();
        openSettings('providers', { model: { provider: target.provider, id: target.model } });
      });
      actions.appendChild(button);
      article.appendChild(actions);
    }

    this.replaceChildren(article);
  }
}

customElements.define('notice-message', NoticeMessage);

export default NoticeMessage;
