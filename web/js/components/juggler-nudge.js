//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <juggler-nudge surface="…"> — the one view for guidance. Wherever a surface
 * can carry a hint it mounts one of these and hands it a context
 * ({@link JugglerNudge#context}); the element asks the nudge engine
 * ({@link module:services/guidance/nudge-engine}) which hint, if any, belongs
 * there, and draws it: a title and a line of copy, the hint's action buttons,
 * and × to dismiss. A situational hint for someone who knows already (or with
 * hints switched off) is drawn as its buttons alone. With nothing to show the
 * element is `hidden`.
 *
 * Nothing about whether a hint shows is decided here — that is the engine's —
 * and a surface decides nothing either: it only says where it is. Actions run
 * the way the user would run them: a command is sent as if typed (so it records
 * its own use, and the hint that suggested it retires), the
 * command menu by asking the column's composer to open it, and the engine's own
 * actions through the engine.
 *
 * The context is set often (the footer re-sets it on every status tick), so the
 * element only rebuilds when the hint it shows changes: a button the user is
 * pressing must not be replaced under the pointer.
 *
 * Built with createElement/textContent (CSP-safe); English from the catalogue
 * is translated here. A status role, not a live region: a hint appearing is not
 * worth interrupting a screen reader for.
 * @module components/juggler-nudge
 */

import JugglerElement from './juggler-element.js';
import {
  nudgeFor, noteNudgeShown, dismissNudge, runGuidanceAction, GUIDANCE_CHANGED_EVENT,
} from '../services/guidance/nudge-engine.js';
import { USAGE_CHANGED_EVENT } from '../services/guidance/usage-signals.js';
import { FACTS_CHANGED_EVENT } from '../services/guidance/facts.js';
import { t } from '../../sdk/lib/i18n.js';

/** @typedef {import('../services/guidance/nudge-catalogue.js').NudgeContext} NudgeContext */
/** @typedef {import('../services/guidance/nudge-catalogue.js').NudgeAction} NudgeAction */
/** @typedef {import('../services/guidance/nudge-engine.js').Nudge} Nudge */

/**
 * Bubbled when a hint asks for the command menu; the conversation area hands
 * it to its composer.
 */
export const COMMAND_MENU_REQUESTED_EVENT = 'command-menu-requested';

/**
 * The part of the engine this view talks to.
 * @typedef {object} NudgeEngineView
 * @property {(surface: string, ctx: NudgeContext) => Nudge|null} nudgeFor - The hint for a surface.
 * @property {(id: string) => void} noteShown - A hint was drawn.
 * @property {(id: string, ctx: NudgeContext) => void} dismiss - The user closed it.
 * @property {(action: NudgeAction) => void} runAction - A built-in action.
 */

/** @type {NudgeEngineView} */
const APP_ENGINE = Object.freeze({
  nudgeFor,
  noteShown: noteNudgeShown,
  dismiss: dismissNudge,
  runAction: runGuidanceAction,
});

class JugglerNudge extends JugglerElement {
  constructor() {
    super();
    /** @type {NudgeContext} @private */
    this._context = {};
    /**
     * What is drawn: `${id}|${compact}`, '' for nothing, null before the first
     * refresh (which must always settle `hidden`, whatever the markup said).
     * @type {string|null}
     * @private
     */
    this._drawn = null;
    /** @type {Nudge|null} @private */
    this._nudge = null;
    /**
     * The engine asked. The app's own, unless a test hands over one built by
     * createNudgeEngine over a catalogue and state of its own.
     * @type {NudgeEngineView}
     */
    this.engine = APP_ENGINE;
  }

  connectedCallback() {
    this.setAttribute('role', 'status');
    this.onWindow(GUIDANCE_CHANGED_EVENT, () => this.refresh());
    this.onWindow(USAGE_CHANGED_EVENT, () => this.refresh());
    this.onWindow(FACTS_CHANGED_EVENT, () => this.refresh());
    this.refresh();
  }

  /** @returns {NudgeContext} What the surface last said about where it is. */
  get context() { return this._context; }

  /** @param {NudgeContext} ctx - Where the surface is: conversation, thread, turn state, readings. */
  set context(ctx) {
    this._context = ctx || {};
    this.refresh();
  }

  /** @returns {string} The surface this element is, from its attribute. */
  get surface() { return this.getAttribute('surface') || ''; }

  /** @returns {string|null} The id of the hint on show, or null. */
  get nudgeId() { return this._nudge?.id ?? null; }

  /**
   * Ask the engine again, and redraw only if the answer changed.
   * @returns {void}
   */
  refresh() {
    if (!this.isConnected) return;
    const nudge = this.engine.nudgeFor(this.surface, this._context);
    const key = nudge ? `${nudge.id}|${nudge.compact}` : '';
    if (key === this._drawn) return;
    this._drawn = key;
    this._nudge = nudge;
    if (!nudge) {
      this.hidden = true;
      this.replaceChildren();
      return;
    }
    this._build(nudge);
    this.hidden = false;
    this.engine.noteShown(nudge.id);
  }

  /**
   * @param {Nudge} nudge
   * @private
   */
  _build(nudge) {
    this.classList.toggle('juggler-nudge--compact', nudge.compact);
    this.dataset.nudgeId = nudge.id;
    /** @type {HTMLElement[]} */
    const parts = [];

    if (!nudge.compact) {
      const text = document.createElement('div');
      text.className = 'juggler-nudge__text';
      if (nudge.title) {
        const title = document.createElement('span');
        title.className = 'juggler-nudge__title';
        title.textContent = t(nudge.title);
        text.append(title, ' ');
      }
      const body = document.createElement('span');
      body.className = 'juggler-nudge__body';
      body.textContent = t(nudge.body);
      text.appendChild(body);
      parts.push(text);
    }

    const actions = document.createElement('div');
    actions.className = 'juggler-nudge__actions';
    for (const action of nudge.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'message-action-btn juggler-nudge__action';
      btn.textContent = t(action.label);
      btn.addEventListener('click', () => { void this._run(action); });
      actions.appendChild(btn);
    }
    if (!nudge.compact) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn-ghost juggler-nudge__dismiss';
      close.setAttribute('aria-label', t('Dismiss hint'));
      close.title = t('Dismiss hint');
      close.textContent = '\u00d7';
      close.addEventListener('click', () => this.engine.dismiss(nudge.id, this._context));
      actions.appendChild(close);
    }
    parts.push(actions);
    this.replaceChildren(...parts);
  }

  /**
   * Carry out one of the hint's actions.
   * @param {NudgeAction} action
   * @returns {Promise<void>}
   * @private
   */
  async _run(action) {
    if (action.command) {
      // Exactly as if typed: the conversation's send path runs the command,
      // shows its message and carries out its side effects.
      const thread = this._context.thread;
      await thread?.conversation?.sendMessage?.(`/${action.command}`, thread.threadItemId ?? null, thread);
      return;
    }
    switch (action.run) {
      case 'open-slash-menu':
        this.dispatchEvent(new CustomEvent(COMMAND_MENU_REQUESTED_EVENT, { bubbles: true }));
        return;
      case 'dismiss':
        if (this._nudge) this.engine.dismiss(this._nudge.id, this._context);
        return;
      default:
        this.engine.runAction(action);
    }
  }
}

customElements.define('juggler-nudge', JugglerNudge);
