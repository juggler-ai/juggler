//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { createTodoBlock } from '../lib/task-lists.js';
import { mountTaskListPin } from '../lib/task-list-pin.js';
import { translator, markForTranslation } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * TodoPin — the current checklist, kept where it can be watched.
 *
 * Like the plan, the todo list draws no standing card in the transcript, so this
 * pin is the only place it holds still. It resolves the same way: the list of the
 * thread being read, else the nearest ancestor's, named whenever it is not the
 * reader's own — a sub-thread keeps its own checklist, and showing a parent's as
 * though it were this thread's would misreport whose work is outstanding.
 *
 * Read-only, and for a sharper reason than the plan: the `todo` tool replaces the
 * list wholesale, so ticking one box here would mean writing back a list the
 * assistant may already have rewritten. That needs concurrency and undo designed
 * first, and a checkbox is not the place to discover it wasn't.
 * @class
 * @augments PinboardItemType
 */
class TodoPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'todo',
    name: 'Todos',
    version: '1.0.0',
    description: 'Follows the current checklist',
    order: 20,
    defaultPin: true,
    needsConversation: true,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a conversation to read a list from.
   */
  canAdd(active) {
    return active?.conversation ? true : t('No active conversation');
  }

  /**
   * The checklist itself, wherever it is shown — the `todo` tool-action row's
   * properties panel being the only place a user meets one, since the item draws
   * no transcript card.
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {boolean} True for the current checklist.
   */
  static canPinSource(source) {
    return source?.kind === 'todo';
  }

  /**
   * There is one checklist per conversation and the pin resolves it on mount, so
   * a request to show it carries nothing: an empty config is the whole of it.
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
      itemType: 'todo',
      itemsOf: (data) => data?.todos || [],
      render: (_data, todos) => createTodoBlock(todos),
      empty: markForTranslation('If the conversation contains a TODO list, this shows its current state'),
    });
  }
}

export default TodoPin;
