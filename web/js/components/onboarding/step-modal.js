//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Step Modal — a modal that moves between named screens.
 *
 * Built on `presentModal` rather than `modal-dialog.js` because this is a
 * transient overlay: created on demand, thrown away on close. That also keeps it
 * off the singleton `showModal` element, so a wizard cannot be clobbered by an
 * alert raised behind it, and gives it Escape and Back dismissal for free.
 *
 * Steps are named and looked up by name rather than held in an array, because
 * the flows that need this are branching rather than linear — "which screen
 * comes next" is a decision each step makes, not a position in a list. `back()`
 * walks the screens actually visited, so a branch never reverses into a screen
 * the user was never shown.
 * @module components/onboarding/step-modal
 */

import { escapeHtml } from '../../../sdk/lib/html.js';
import { t } from '../../../sdk/lib/i18n.js';
import { presentModal } from '../../utils/modal-surface.js';

/**
 * One screen's content, returned by a step function.
 * @typedef {object} StepView
 * @property {string} title - Plain text; escaped here.
 * @property {string} body - Trusted HTML for the body.
 * @property {StepAction[]} [actions] - Footer buttons, in display order.
 * @property {string} [note] - Small print under the actions. Plain text.
 * @property {(root: HTMLElement) => void} [onMount] - Called once the screen is
 *   in the DOM, for a body that carries its own controls. A step cannot wire
 *   those itself: its own code runs before this module paints what it returned.
 * @property {boolean} [hideBack] - Suppress the header's back control on a
 *   screen that has history behind it but should not be reversed into.
 */

/**
 * A footer button.
 * @typedef {object} StepAction
 * @property {string} label - Plain text; escaped here.
 * @property {'primary'|'secondary'} [kind] - Visual weight. Default secondary.
 * @property {string} [busyLabel] - Shown while an async `onSelect` runs. A step
 *   that reaches the network should set this, or the click looks ignored.
 * @property {(ctx: StepContext) => any} [onSelect] - Runs on click. Awaited, so
 *   it may be async; the buttons are disabled meanwhile.
 */

/**
 * Navigation handed to every step function and action.
 * @typedef {object} StepContext
 * @property {(name: string) => void} go - Show another step, remembering this
 *   one for `back()`.
 * @property {() => void} back - Return to the previously shown step.
 * @property {boolean} canGoBack - Whether anything is behind this step.
 * @property {(value?: any) => void} finish - Close, resolving the wizard with a
 *   value. Dismissal resolves `undefined` instead, so a caller can tell a
 *   completed flow from an abandoned one.
 * @property {() => void} close - Close without a result.
 * @property {() => void} rerender - Redraw the current step.
 */

/**
 * Present a multi-step modal.
 * @param {object} opts
 * @param {Record<string, (ctx: StepContext) => StepView|Promise<StepView>>} opts.steps
 *   Step functions by name. Each may be async — a step that has to ask the
 *   server what to show renders a spinner until it resolves.
 * @param {string} opts.start - Name of the first step.
 * @param {string} [opts.dismissLabel] - aria-label for the close button, already
 *   translated. Defaults to "Close".
 * @returns {Promise<any>} The value passed to `finish`, or `undefined` if the
 *   modal was dismissed.
 */
export function presentWizard({ steps, start, dismissLabel = t('Close') }) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    const history = [];
    let current = start;
    let finished = false;
    /** @type {any} */
    let outcome;
    /** @type {StepAction[]} */
    let actions = [];
    // Guards a render whose step function is still in flight when another
    // render starts: the slower one must not paint over the newer screen.
    let renderToken = 0;
    // Whether a screen has been drawn yet: only the first makes the entrance.
    let painted = false;

    const modal = presentModal({
      // Spelled out rather than taken as an option: the CSS architecture check
      // learns which element a class lands on by following it to the
      // createElement that made it, and it cannot follow one through a wrapper's
      // parameter. A second caller wanting its own class should pass a literal
      // here too, not reintroduce the option.
      className: 'onboarding-wizard',
      dismissSelectors: ['.onboarding-wizard-backdrop', '.onboarding-wizard-close'],
      onClose: () => resolve(finished ? outcome : undefined),
    });

    /** @type {StepContext} */
    const ctx = {
      go(name) {
        history.push(current);
        current = name;
        void render();
      },
      back() {
        if (!history.length) return;
        current = /** @type {string} */ (history.pop());
        void render();
      },
      get canGoBack() {
        return history.length > 0;
      },
      finish(value) {
        finished = true;
        outcome = value;
        modal.close();
      },
      close: () => modal.close(),
      rerender: () => void render(),
    };

    // Delegated once on the root, which survives every innerHTML replacement
    // below; re-binding per render is how a stale handler outlives its button.
    modal.root.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.closest('.onboarding-wizard-back')) {
        ctx.back();
        return;
      }
      const button = target.closest('[data-wiz-action]');
      if (!button) return;
      const action = actions[Number(/** @type {HTMLElement} */ (button).dataset.wizAction)];
      if (action) void runAction(action, /** @type {HTMLButtonElement} */ (button));
    });

    /**
     * Run an action's handler, holding the modal inert while it does. An action
     * that reaches the network is the normal case here, not the exception.
     * @param {StepAction} action
     * @param {HTMLButtonElement} button
     */
    async function runAction(action, button) {
      if (!action.onSelect) return;
      const token = renderToken;
      const buttons = /** @type {HTMLButtonElement[]} */ (
        Array.from(modal.root.querySelectorAll('[data-wiz-action]'))
      );
      buttons.forEach((b) => {
        b.disabled = true;
      });
      const restore = button.textContent;
      if (action.busyLabel) button.textContent = action.busyLabel;
      try {
        await action.onSelect(ctx);
      } finally {
        // Only undo what we did if the screen is still the one we disabled: a
        // handler that navigated has already replaced these buttons.
        if (!modal.closed && token === renderToken) {
          buttons.forEach((b) => {
            b.disabled = false;
          });
          button.textContent = restore;
        }
      }
    }

    /**
     * Draw the current step. A step function may be async — one that has to ask
     * the server what to show leaves the previous screen up until it resolves,
     * which beats flashing an empty panel.
     * @returns {Promise<void>} Resolves once the screen is painted, or skipped.
     */
    async function render() {
      const token = ++renderToken;
      const step = steps[current];
      if (!step) {
        modal.close();
        return;
      }

      const view = await step(ctx);
      // The step may have closed the modal or moved on while it was resolving.
      if (modal.closed || token !== renderToken) return;

      actions = view.actions ?? [];
      modal.root.innerHTML = shell(view, actions, dismissLabel, ctx.canGoBack && !view.hideBack);
      // Every screen is a fresh panel, but only the first is the wizard
      // opening: later ones swap in place rather than pop in again.
      if (painted) modal.root.querySelector('.onboarding-wizard-panel')?.classList.add('onboarding-wizard-panel--settled');
      painted = true;
      view.onMount?.(modal.root);
      focusPrimary(modal.root);
    }

    void render();
  });
}

/**
 * Build one screen's markup, in the app's standard backdrop + panel chrome.
 *
 * Back sits at the top-left of the header rather than among the footer buttons:
 * it moves between screens, where the footer commits to something, and putting
 * the two in one row invites a reader to answer with the one that undoes their
 * last answer. It is also where a wizard's back control is looked for.
 * @param {StepView} view - The screen to draw.
 * @param {StepAction[]} actions - Footer buttons, indexed by their click token.
 * @param {string} dismissLabel - aria-label for the close button.
 * @param {boolean} canGoBack - Whether to offer the header's back control.
 * @returns {string} The panel HTML, ready to assign to the overlay root.
 */
function shell(view, actions, dismissLabel, canGoBack) {
  const buttons = actions
    .map(
      (action, index) =>
        `<button type="button" class="onboarding-wizard-action${
          action.kind === 'primary' ? ' btn-primary' : ''
        }" data-wiz-action="${index}">${escapeHtml(action.label)}</button>`
    )
    .join('');
  return `
    <modal-backdrop class="onboarding-wizard-backdrop"></modal-backdrop>
    <modal-panel class="onboarding-wizard-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(view.title)}">
      <header class="onboarding-wizard-header">
        ${canGoBack ? `<button type="button" class="onboarding-wizard-back" aria-label="${escapeHtml(t('Back'))}">${escapeHtml(t('← Back'))}</button>` : ''}
        <h2 class="onboarding-wizard-title">${escapeHtml(view.title)}</h2>
        <button class="btn btn-icon btn-icon-lg btn-ghost onboarding-wizard-close" title="${escapeHtml(t('Close (Esc)'))}" aria-label="${escapeHtml(dismissLabel)}"><span class="icon-close"></span></button>
      </header>
      <div class="onboarding-wizard-body">${view.body}</div>
      ${buttons ? `<footer class="onboarding-wizard-footer">${buttons}</footer>` : ''}
      ${view.note ? `<p class="onboarding-wizard-note">${escapeHtml(view.note)}</p>` : ''}
    </modal-panel>
  `;
}

/**
 * Put the caret on the button the screen is steering towards, so the flow can be
 * driven from the keyboard without hunting for it.
 * @param {HTMLElement} root
 */
function focusPrimary(root) {
  const target = root.querySelector('.onboarding-wizard-action.btn-primary') ?? root.querySelector('.onboarding-wizard-action');
  if (target instanceof HTMLElement) target.focus();
}
