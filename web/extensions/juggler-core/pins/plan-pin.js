//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { createPlanBlock } from '../lib/task-lists.js';
import { mountTaskListPin } from '../lib/task-list-pin.js';
import { translator, markForTranslation } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * PlanPin — the current plan, kept where it can be followed.
 *
 * The plan draws no standing card in the transcript: its tool-action rows show
 * each change as it happens, and a second transaction-less tile beside them was
 * only ever a duplicate. This pin is therefore the only place the plan stands
 * still, which is what makes getting its source right matter.
 *
 * A plan belongs to the thread that submitted it, and a sub-thread's plan is its
 * own. So the pin shows the plan of the thread being read, and failing that the
 * nearest ancestor with one — saying whose it is whenever it is not the reader's
 * own. It never merges several threads' plans into one list: no thread is making
 * that claim, so neither should the board.
 *
 * Read-only. The plan changes through the approval-gated `plan` tool, which is
 * where a step's status means something; a checkbox here would be a second,
 * quieter way to change a plan the user approved.
 * @class
 * @augments PinboardItemType
 */
class PlanPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'plan',
    name: 'Plan',
    version: '1.0.0',
    description: 'Follows the current plan and its progress',
    // What the agent is about to do, which is the first thing worth a glance.
    order: 10,
    defaultPin: true,
    needsConversation: true,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a conversation to read a plan from.
   */
  canAdd(active) {
    return active?.conversation ? true : t('No active conversation');
  }

  /**
   * The plan itself, wherever it is shown — the `plan` tool-action row's
   * properties panel being the only place a user meets one, since the item draws
   * no transcript card.
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {boolean} True for the current plan.
   */
  static canPinSource(source) {
    return source?.kind === 'plan';
  }

  /**
   * The pin walks to the plan it should show on mount, so a request to show it
   * carries nothing: an empty config is the whole of it.
   * @returns {Record<string, any>} The config.
   */
  static configFromSource() {
    return {};
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    return mountTaskListPin(container, pinContext, {
      itemType: 'plan',
      itemsOf: (data) => data?.steps || [],
      render: (data) => createPlanBlock(data),
      empty: markForTranslation('If the conversation contains a plan, this shows its current state'),
    });
  }
}

export default PlanPin;
