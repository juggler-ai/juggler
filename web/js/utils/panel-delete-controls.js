//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { busyState } from '../model/processing-status.js';
import { uiPort } from '../services/ui-port.js';

/**
 * Stop the conversation's running work before a delete, asking the user first.
 *
 * Shared by every button {@link appendDeleteControls} makes, so a delete asks
 * the same question whichever one was clicked. Work counts as running when a
 * turn holds the worker or a frontend action is live (`turnActive`), or when
 * the document still holds a tool approved or running, or a sub-thread whose
 * run is open (`outstandingItems`): a tool can be left running in the document
 * with no turn claimed, and deleting its item does not stop it — the tool
 * finishes into an item that is gone.
 *
 * A held turn is cancelled and waited out, so the delete never races items the
 * worker is still writing. Work with no turn behind it is cancelled without a
 * wait, as there is no turn to settle on. Dismissing the dialog answers null,
 * and every falsy answer leaves the work alone. With no dialog mounted the stop
 * goes ahead, as the slash-command gate's does.
 * @param {import('../model/conversation.js').default} conversation
 * @returns {Promise<boolean>} True when the delete may go ahead
 */
async function stopRunningWorkForDelete(conversation) {
  const busy = busyState(conversation);
  const turnActive = busy.turnActive;
  if (!turnActive && !busy.outstandingItems) return true;

  const dialogs = uiPort();
  if (dialogs) {
    const answer = await dialogs.confirm(
      t('This conversation is still working. Deleting now stops it.'),
      t('Stop the current turn?'),
      { confirmText: t('Stop and delete'), cancelText: t('Leave it running'), danger: true }
    );
    if (!answer) return false;
  }

  if (!turnActive) {
    conversation.stopProcessing('items deleted');
    return true;
  }
  try {
    await conversation.cancelAndSettle('items deleted');
    return true;
  } catch (err) {
    // A rejection means the turn may still be live, so deleting now would
    // race it.
    console.warn('[delete] the turn did not stop; nothing was deleted', err);
    conversation.showWarning(t('The turn did not stop, so nothing was deleted.'), 5000);
    return false;
  }
}

/**
 * Append standard Delete / Delete up to here / Delete from here buttons to a container.
 * Buttons use properties-panel-btn danger styling, matching other properties panels.
 *
 * All three are always enabled. While the conversation has work running, a
 * click asks before stopping it, and deletes only once it has stopped
 * ({@link stopRunningWorkForDelete}). The Delete/Backspace key works by
 * clicking the plain Delete button, so it asks the same way.
 *
 * The span deletes resolve the item to an index when the delete RUNS, not when
 * they are built or clicked. A properties panel is not rebuilt for changes to
 * items other than the one it describes, and the worker reorders items on its
 * own initiative (a tool action moves to the end of the list when its context
 * item changes), so an index captured earlier goes stale while these buttons
 * sit on screen or a confirmation is open — and a stale index deletes a row the
 * user never pointed at.
 *
 * Clicks stop propagating here, so a button sitting inside a selectable row or
 * tile acts only as a button.
 * @param {HTMLElement} container
 * @param {import('../model/message-thread.js').default} parentThread
 * @param {string} itemId - id of the item in parentThread these buttons act on
 * @param {() => void} onDelete - Performs the plain Delete, once any running work has stopped
 */
export function appendDeleteControls(container, parentThread, itemId, onDelete) {
  /**
   * @param {string} label
   * @param {() => void} action - The delete, run once running work has stopped
   * @returns {HTMLButtonElement} The button
   */
  const makeBtn = (label, action) => {
    const btn = document.createElement('button');
    btn.className = 'properties-panel-btn danger';
    btn.innerHTML = `<span class="icon-trashcan"></span> ${escapeHtml(label)}`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await stopRunningWorkForDelete(parentThread.conversation)) action();
    });
    return btn;
  };

  container.appendChild(makeBtn(t('Delete'), onDelete));

  // Both span deletes go through the conversation rather than straight to the
  // thread: a span delete has to cancel pending approvals and seal its undo
  // group, and it is what offers the footer's undo.
  if (parentThread.findIndexByItemId(itemId) > 0) {
    container.appendChild(makeBtn(t('Delete up to here'), () => {
      const index = parentThread.findIndexByItemId(itemId);
      if (index > 0) parentThread.conversation.deleteUpToWithCleanup(parentThread, index);
    }));
  }

  container.appendChild(makeBtn(t('Delete from here'), () => {
    const index = parentThread.findIndexByItemId(itemId);
    if (index >= 0) parentThread.conversation.deleteAfterWithCleanup(parentThread, index);
  }));
}
