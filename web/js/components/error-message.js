//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage, { FINAL_ITEM_ATTR } from './base-message.js';
import { createErrorArticle } from '../utils/icon-message-renderer.js';
import { openSettings } from '../services/settings-launcher.js';
import { RETRY_SVG, CLOCK_SVG } from '../utils/icons.js';
import { formatClockTime } from './composer-schedule.js';
import { t, formatDate, markForTranslation } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * The message an Auto-continue sends when the cap lifts: what the user would
 * type to pick the turn up again. It goes to the model, not to the reader, so it
 * is the same in every locale.
 */
const AUTO_CONTINUE_MESSAGE = 'continue';

/**
 * Whether a thread's queue already holds a held send — a message waiting for a
 * time or for the run to end.
 * @param {any} thread - The message thread
 * @returns {boolean} True when one is waiting.
 */
function holdsHeldSend(thread) {
  const pending = thread?.pendingItems;
  if (!Array.isArray(pending)) return false;
  return pending.some((entry) => typeof entry?.get?.('notBefore') === 'number' || !!entry?.get?.('hold'));
}

/**
 * When a cap lifts, as the reader's clock says it: the time alone when that is
 * today, with the date before it otherwise.
 * @param {number} epochMs
 * @returns {string} The formatted time.
 */
function formatResetTime(epochMs) {
  if (new Date(epochMs).toDateString() === new Date().toDateString()) return formatClockTime(epochMs);
  return formatDate(epochMs, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * Signatures that identify an error as a failure to reach the provider at all,
 * rather than something the provider itself reported. Deliberately specific: a
 * bare "timeout" is not enough, because plenty of non-network failures say it.
 * @type {RegExp}
 */
const UNREACHABLE_SIGNATURE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection refused|connection reset|no such host|dial tcp|socket hang up|fetch failed|network error|tls handshake|getaddrinfo)\b/i;

/**
 * Plain-English lead for an unreachable provider. Rendered above the provider's
 * own text, never in place of it, so nothing needed to diagnose the failure is
 * lost. Translated where it is drawn.
 * @type {string}
 */
const UNREACHABLE_LEAD = markForTranslation('Couldn’t reach the model. Could be problems at their end, or your network.');


// Settings icon (Material "settings") — the same gear the header's Settings
// button and the model menu's settings items use, so the destination is
// recognisable before the label is read.
const SETTINGS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z"/></svg>';

// Swap icon (Material "swap_horiz") — exchanging one model for another.
const SWAP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M280-160 80-360l200-200 56 57-103 103h287v80H233l103 103-56 57Zm400-240-56-57 103-103H440v-80h287L624-743l56-57 200 200-200 200Z"/></svg>';

// The failure the worker classified as "the provider isn't authenticated", whose
// fix is never in this window.
const AUTH_ERROR_KIND = 'auth';

// The failure the worker classified as "the provider can't run on this machine"
// — a CLI it drives isn't installed. Fixable in settings, but just as often
// answered by using a different provider, which a new user who never chose this
// one needs to be shown.
const SETUP_ERROR_KIND = 'setup';

/**
 * Error message component - icon + error text with red icon, plus a Retry
 * action. Many LLM-loop errors (out-of-tokens for the window, a transient
 * network blip) are worth simply trying again, so the error item carries its
 * own retry affordance: clicking it deletes this error item and continues the
 * thread — the same continue the footer button triggers, minus the dead error.
 *
 * The button appears only while the error is the thread's LAST item. Continuing
 * always resumes from the end of the transcript, so on an error further back
 * there is no failed turn left to retry: pressing it would start an ordinary
 * continue and silently delete a piece of history on the way past. Anything
 * after the error is the answer to the question of what happened next, and it
 * already happened.
 *
 * A failure the worker classified as an authentication or setup problem also
 * carries a Provider settings action, at any position in the thread — unlike
 * Retry it can never do damage, and the fix for it is somewhere else entirely,
 * which is precisely what a first-time reader of one of these errors does not
 * know. A setup problem leads with Choose another model as well: a provider
 * that isn't installed is one the reader may never have meant to use.
 *
 * A usage cap the provider dated (`reset-at`) carries Auto-continue, ahead of
 * Retry and under the same last-item gate: a "continue" held until the reset,
 * exactly as if the user had typed it and scheduled it with Send later. The
 * worker fires it itself, with or without a window open. It is not offered once
 * the reset has passed (Retry does the same thing now), nor on a thread whose
 * queue already holds a send, which already says what happens next.
 */
class ErrorMessage extends BaseMessage {
  static get observedAttributes() {
    return ['content', 'error-kind', 'reset-at', FINAL_ITEM_ATTR];
  }

  /**
   * When the usage cap this error reports lifts, if the provider said.
   * @returns {number|null} Epoch ms, or null when no reset was stated.
   */
  get resetAt() {
    const value = Number(this.getAttribute('reset-at'));
    return this.hasAttribute('reset-at') && Number.isFinite(value) ? value : null;
  }

  /**
   * The worker's classification of this failure, when it made one. `auth` and
   * `setup` are acted on.
   * @returns {string} The error kind, or '' when unclassified.
   */
  get errorKind() {
    return this.getAttribute('error-kind') || '';
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = createErrorArticle(this.content);

    const contentBox = article.querySelector('.message-content-box');
    if (contentBox && this.content && UNREACHABLE_SIGNATURE.test(this.content)) {
      const leadEl = document.createElement('div');
      leadEl.className = 'error-message-lead';
      leadEl.textContent = t(UNREACHABLE_LEAD);
      contentBox.prepend(leadEl);
    }

    const isSetup = this.errorKind === SETUP_ERROR_KIND;
    const offersSettings = isSetup || this.errorKind === AUTH_ERROR_KIND;
    if (this.isFinalItem || offersSettings) {
      const actions = document.createElement('div');
      actions.className = 'error-message-actions message-row-body';

      // The way round a missing install reads first, so it isn't taken for
      // the only way forward.
      if (isSetup) {
        const modelBtn = document.createElement('button');
        modelBtn.type = 'button';
        modelBtn.className = 'message-action-btn error-model-btn';
        modelBtn.title = t('Pick a model from another provider');
        modelBtn.innerHTML = `${SWAP_SVG}${escapeHtml(t('Choose another model'))}`;
        modelBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._columnModelSelector()?.open();
        });
        actions.appendChild(modelBtn);
      }

      // Settings before Retry, so the action that fixes the cause reads before
      // the one that tries again. Retrying an expired sign-in only reproduces it.
      if (offersSettings) {
        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'message-action-btn error-settings-btn';
        settingsBtn.title = t('Open provider settings');
        settingsBtn.innerHTML = `${SETTINGS_SVG}${escapeHtml(t('Provider settings'))}`;
        settingsBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openSettings('providers');
        });
        actions.appendChild(settingsBtn);
      }

      const resetAt = this.resetAt;
      if (this.isFinalItem && resetAt !== null && resetAt > Date.now() && !holdsHeldSend(this._getMessageThread())) {
        const time = formatResetTime(resetAt);
        const autoBtn = document.createElement('button');
        autoBtn.type = 'button';
        autoBtn.className = 'message-action-btn error-autocontinue-btn';
        autoBtn.title = t('Send “continue” when the usage limit resets');
        autoBtn.innerHTML = `${CLOCK_SVG}${escapeHtml(t('Auto-continue at {time}', { time }))}`;
        autoBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._autoContinue(autoBtn, resetAt, time);
        });
        actions.appendChild(autoBtn);
      }

      if (this.isFinalItem) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'message-action-btn error-retry-btn';
        retryBtn.title = t('Delete this error and continue the conversation');
        // A circular arrow, distinct from the footer's Continue "play" glyph so
        // the affordance reads as "try that turn again".
        retryBtn.innerHTML = `${RETRY_SVG}${escapeHtml(t('Retry'))}`;
        retryBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._retry();
        });
        actions.appendChild(retryBtn);
      }
      article.appendChild(actions);
    }

    this.replaceChildren(article);
  }

  /**
   * The model selector that drives the thread this error belongs to: the
   * nearest one sharing an ancestor with this row, so an error in a sub-thread
   * column opens that column's picker rather than the root's. The search ends
   * at the row's own conversation tab, and never reaches <body>: any selector
   * beyond either drives some other conversation's model.
   * @returns {any} The model-selector element, or null.
   * @private
   */
  _columnModelSelector() {
    for (let el = this.parentElement; el && el !== document.body; el = el.parentElement) {
      const selector = el.querySelector('model-selector');
      if (selector) return selector;
      if (el.localName === 'conversation-tab') return null;
    }
    return null;
  }

  /**
   * Delete this error item, then continue the thread. Continue is the footer's
   * exact entry point (`MessageThread.continue()`), whose own guards make it a
   * safe no-op if the thread can't be continued — so we always try rather than
   * duplicating those checks here.
   *
   * The deletion rides along as `beforeContinue` so it happens only if the
   * continue does. Deleting first was not safe: while the conversation is busy
   * driving any thread — a parent that has already been handed this error as a
   * sub-thread's result, most often — the continue is a silent no-op, and the
   * error would be gone with nothing started in its place, taking the Retry
   * button with it.
   * @private
   */
  _retry() {
    const thread = this._getMessageThread();
    if (!thread) return;
    const id = this.itemId;
    thread.continue(() => {
      if (id) thread.removeItemById(id);
    });
  }

  /**
   * Schedule "continue" for the reset: the composer's Send later path, with the
   * message supplied here rather than typed, so the box and its draft are left
   * alone. The button stands down at once so a second press cannot queue a
   * second continue; a refused send gives it back.
   * @param {HTMLButtonElement} button - The pressed button
   * @param {number} resetAt - Epoch ms the send is held until
   * @param {string} time - The reset as the button showed it
   * @private
   */
  async _autoContinue(button, resetAt, time) {
    const thread = /** @type {any} */ (this._getMessageThread());
    if (!thread?.conversation || button.disabled) return;
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = `${CLOCK_SVG}${escapeHtml(t('Continues at {time}', { time }))}`;
    const refusal = await thread.conversation.sendMessage(AUTO_CONTINUE_MESSAGE, thread.threadItemId ?? null, thread, {
      consumeComposer: false,
      interpretCommands: false,
      schedule: { notBefore: resetAt },
    });
    if (refusal) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}

customElements.define('error-message', ErrorMessage);

export default ErrorMessage;
