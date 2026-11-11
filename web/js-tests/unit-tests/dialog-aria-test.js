//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics and keyboard containment of the app's modal dialogs.
 *
 *   1. Every modal panel is a `dialog` with `aria-modal="true"` and an
 *      accessible name: `aria-labelledby` resolving to its visible title, or an
 *      `aria-label` where it shows none — the shared alert / confirm / prompt /
 *      choice dialog, about, bin, settings, the update dialog, the skill
 *      preview and the install-location picker.
 *   2. A notice is a status message, not a modal dialog.
 *   3. Tab on a dialog's last control wraps to its first and Shift+Tab on the
 *      first wraps to the last, the browser's own move prevented; Tab between
 *      the two is left to the browser. Only the topmost of stacked dialogs
 *      holds the keyboard, and closing it hands the trap back to the one below.
 *   4. The trap leaves the choice dialog's arrow keys alone.
 * @module unit-tests/dialog-aria-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { showAlert, showConfirm, showPrompt, showChoice, showNotice } from '../../js/components/modal-dialog.js';
import { skillPreviewShell } from '../../js/components/settings/skill-preview.js';
import { SkillsTab } from '../../js/components/settings/skills-tab.js';
import '../../js/components/about-modal.js';
import '../../js/components/bin-modal.js';
import '../../js/components/settings-panel.js';
import '../../js/components/update-notice.js';

/** Remove every dialog, answering any that is open so no caller is left waiting. */
function clearAllDialogs() {
  document.querySelectorAll('modal-dialog').forEach((el) => {
    /** @type {any} */ (el).close?.(null);
    el.remove();
  });
}

/**
 * Wait for the app's dialog to be on screen.
 * @returns {Promise<HTMLElement>} The open dialog's panel.
 */
async function openDialogPanel() {
  const sel = 'modal-dialog.is-open:not(.is-notice) .modal-container';
  await waitFor(() => !!document.querySelector(sel), { description: 'the dialog to open' });
  return /** @type {HTMLElement} */ (document.querySelector(sel));
}

/**
 * Assert a panel is a named modal dialog.
 * @param {Element|null} panel - The dialog panel.
 * @param {string} label - Assertion label.
 * @param {string} [title] - The visible title it must be named by; omitted
 *   when the dialog shows none and must carry an `aria-label` instead.
 */
function assertDialog(panel, label, title) {
  assert(!!panel, `${label}: no panel`);
  const p = /** @type {Element} */ (panel);
  assert(p.getAttribute('role') === 'dialog', `${label}: role is ${JSON.stringify(p.getAttribute('role'))}, not "dialog"`);
  assert(p.getAttribute('aria-modal') === 'true', `${label}: aria-modal is ${JSON.stringify(p.getAttribute('aria-modal'))}`);
  if (title === undefined) {
    assert(!!p.getAttribute('aria-label'), `${label}: no aria-label for a dialog with no title`);
    return;
  }
  const id = p.getAttribute('aria-labelledby');
  assert(!!id, `${label}: no aria-labelledby`);
  const named = document.getElementById(/** @type {string} */ (id));
  assert(!!named && p.contains(named), `${label}: aria-labelledby="${id}" does not resolve to an element in the panel`);
  const text = (named?.textContent || '').trim();
  assert(text === title, `${label}: named by ${JSON.stringify(text)}, expected the title ${JSON.stringify(title)}`);
  assert((named?.getClientRects().length ?? 0) > 0, `${label}: the title it is named by is not shown`);
}

/**
 * Dispatch a Tab keydown at `target`, as the browser would before moving focus.
 * @param {Element} target - The focused element.
 * @param {boolean} [shift] - Shift+Tab.
 * @returns {KeyboardEvent} The dispatched event.
 */
function tab(target, shift = false) {
  const e = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

/**
 * Assert Tab on `last` wraps to `first` and Shift+Tab on `first` back to `last`.
 * @param {HTMLElement} first - The first tab stop.
 * @param {HTMLElement} last - The last tab stop.
 * @param {string} label - Assertion label.
 */
function assertWraps(first, last, label) {
  last.focus();
  assert(document.activeElement === last, `${label}: could not focus the last control`);
  const forward = tab(last);
  assert(forward.defaultPrevented, `${label}: Tab on the last control was not prevented`);
  assert(document.activeElement === first,
    `${label}: Tab on the last control moved focus to ${describe(document.activeElement)}, not the first`);
  const back = tab(first, true);
  assert(back.defaultPrevented, `${label}: Shift+Tab on the first control was not prevented`);
  assert(document.activeElement === last,
    `${label}: Shift+Tab on the first control moved focus to ${describe(document.activeElement)}, not the last`);
}

/**
 * @param {Element|null} el
 * @returns {string} A short description for a failure message.
 */
function describe(el) {
  if (!el) return 'nothing';
  return `<${el.localName}${el.className ? ` class="${el.className}"` : ''}>${(el.textContent || '').trim().slice(0, 30)}`;
}

/**
 * Run the dialog ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    __resetPopupManagerForTests();
    clearAllDialogs();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearAllDialogs();
      __resetPopupManagerForTests();
    }
  };

  await run('the shared dialog is a named modal dialog in every interactive type', async () => {
    void showAlert('Something happened', 'Alert title');
    assertDialog(await openDialogPanel(), 'alert', 'Alert title');
    clearAllDialogs();

    void showConfirm('Sure?', 'Confirm title');
    assertDialog(await openDialogPanel(), 'confirm', 'Confirm title');
    clearAllDialogs();

    void showPrompt('Name?', '', 'Prompt title');
    assertDialog(await openDialogPanel(), 'prompt', 'Prompt title');
    clearAllDialogs();

    void showChoice('Which?', ['A', 'B'], 'Choice title');
    assertDialog(await openDialogPanel(), 'choice', 'Choice title');
  });

  await run('a notice is a status message, not a modal dialog, and does not hold Tab', async () => {
    showNotice('Saved', { duration: 0 });
    await waitFor(() => !!document.querySelector('modal-dialog.is-notice.is-open'), { description: 'the notice to show' });
    const panel = /** @type {HTMLElement} */ (document.querySelector('modal-dialog.is-notice .modal-container'));
    assert(panel.getAttribute('role') === 'status', `notice: role is ${JSON.stringify(panel.getAttribute('role'))}, not "status"`);
    assert(!panel.hasAttribute('aria-modal'), 'notice: it claims to be modal');
    assert(!panel.hasAttribute('aria-labelledby'), 'notice: it is named by a heading it does not show');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.focus();
      assert(!tab(outside).defaultPrevented, 'notice: Tab was held while only a notice was showing');
    } finally {
      outside.remove();
    }
  });

  await run('a dialog after a notice is a modal dialog again', async () => {
    // The singleton and a notice are separate elements, but a notice must not
    // leave its role behind on a reused element either.
    const el = /** @type {any} */ (document.createElement('modal-dialog'));
    document.body.appendChild(el);
    void el.show({ type: 'notice', message: 'x', duration: 0 });
    void el.show({ type: 'confirm', title: 'After', message: 'y' });
    assertDialog(el.querySelector('.modal-container'), 'confirm after notice', 'After');
    el.close(null);
    el.remove();
  });

  await run('about, bin, settings and the update dialog are named modal dialogs', async () => {
    const about = /** @type {any} */ (document.createElement('about-modal'));
    document.body.appendChild(about);
    try {
      about._version = '1.2.3';
      await about.open();
      assertDialog(about.querySelector('modal-panel'), 'about');
    } finally {
      about._close?.();
      about.remove();
    }

    const bin = /** @type {any} */ (document.createElement('bin-modal'));
    document.body.appendChild(bin);
    try {
      await bin.open({ bin: { sizeBytes: 0, count: 0, list: async () => [] } });
      assertDialog(bin.querySelector('modal-panel'), 'bin', 'Bin');
    } finally {
      bin.close();
      bin.remove();
    }

    const settings = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(settings);
    try {
      assertDialog(settings.querySelector('modal-panel'), 'settings');
    } finally {
      settings.remove();
    }

    const notice = /** @type {any} */ (document.createElement('update-notice'));
    document.body.appendChild(notice);
    try {
      notice.open({
        present: false, updaterState: null, pct: null, error: null, appManagedServer: true,
        notice: null, serverUpdateAvailable: true, currentVersion: '1.0.0', targetVersion: '2.0.0',
      });
      assertDialog(notice.querySelector('modal-panel'), 'update', 'Version 2.0.0 is available');
    } finally {
      notice.close();
      notice.remove();
    }
  });

  await run('the skill preview and the install-location picker are named modal dialogs', async () => {
    const host = document.createElement('div');
    host.className = 'skills-drawer';
    host.innerHTML = skillPreviewShell('my-skill', '<p>Body</p>');
    document.body.appendChild(host);
    try {
      assertDialog(host.querySelector('modal-panel'), 'skill preview', 'my-skill');
    } finally {
      host.remove();
    }

    const tabHost = document.createElement('div');
    tabHost.innerHTML = '<div id="skills-tab-root"></div>';
    document.body.appendChild(tabHost);
    try {
      const skills = /** @type {any} */ (new SkillsTab(tabHost));
      const picked = skills._promptInstallScope({ name: 'my-skill' });
      const picker = /** @type {HTMLElement} */ (document.querySelector('.skills-scope-dialog'));
      assert(!!picker, 'the install-location dialog did not open');
      const title = (picker.querySelector('.skills-scope-dialog-title')?.textContent || '').trim();
      assertDialog(picker.querySelector('modal-panel'), 'install location', title);
      // A transient modal holds Tab too.
      const stops = /** @type {HTMLElement[]} */ ([...picker.querySelectorAll('button')]);
      assertWraps(stops[0], stops[stops.length - 1], 'install location');
      /** @type {HTMLElement} */ (picker.querySelector('[data-scope-cancel]')).click();
      await picked;
    } finally {
      tabHost.remove();
    }
  });

  await run('Tab wraps inside a confirm, both ways', async () => {
    void showConfirm('Sure?', 'Confirm');
    const panel = await openDialogPanel();
    const [cancel, ok] = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.modal-footer button')]);
    // The dialog focuses its confirm button once shown; wait for that so it
    // cannot land in the middle of the checks.
    await waitFor(() => document.activeElement === ok, { description: 'the confirm button to take focus' });
    assertWraps(cancel, ok, 'confirm');
  });

  await run('Tab between a prompt\'s controls is the browser\'s, and Enter still answers', async () => {
    const answer = showPrompt('Name?', 'abc', 'Prompt');
    const panel = await openDialogPanel();
    const input = /** @type {HTMLInputElement} */ (panel.querySelector('.modal-input'));
    const [cancel, ok] = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.modal-footer button')]);
    await waitFor(() => document.activeElement === input, { description: 'the prompt field to take focus' });
    assert(!tab(input).defaultPrevented, 'prompt: Tab from the field to Cancel was prevented');
    assert(!tab(cancel).defaultPrevented, 'prompt: Tab from Cancel to OK was prevented');
    assertWraps(input, ok, 'prompt');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert(await answer === 'abc', 'prompt: Enter in the field did not answer with its value');
  });

  await run('focus left on the page underneath is pulled into the dialog', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind';
    document.body.prepend(outside);
    try {
      void showAlert('Hi', 'Alert');
      const panel = await openDialogPanel();
      const ok = /** @type {HTMLElement} */ (panel.querySelector('.modal-footer button'));
      outside.focus();
      const e = tab(outside);
      assert(e.defaultPrevented, 'Tab from the page underneath was not prevented');
      assert(document.activeElement === ok, `Tab from the page underneath went to ${describe(document.activeElement)}`);
    } finally {
      outside.remove();
    }
  });

  await run('the choice dialog keeps its arrow keys and wraps Tab', async () => {
    void showChoice('Which?', ['A', 'B'], 'Choice');
    const panel = await openDialogPanel();
    const buttons = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.modal-choice-button')]);
    await waitFor(() => document.activeElement === buttons[0], { description: 'the first choice to take focus' });
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert(document.activeElement === buttons[1], `ArrowDown moved focus to ${describe(document.activeElement)}`);
    assertWraps(buttons[0], buttons[buttons.length - 1], 'choice');
  });

  await run('only the topmost of stacked dialogs holds Tab', async () => {
    const bin = /** @type {any} */ (document.createElement('bin-modal'));
    document.body.appendChild(bin);
    const row = { id: 'conv_1', name: 'One', lastModifiedAt: new Date().toISOString() };
    try {
      await bin.open({ bin: { sizeBytes: 0, count: 1, list: async () => [row] } });
      const binStops = /** @type {HTMLElement[]} */ ([...bin.querySelectorAll('modal-panel button:not([disabled])')]);
      assert(binStops.length >= 2, `bin: expected several controls, found ${binStops.length}`);
      assertWraps(binStops[0], binStops[binStops.length - 1], 'bin alone');

      const answer = showConfirm('Delete?', 'Confirm');
      const panel = await openDialogPanel();
      const [cancel, ok] = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.modal-footer button')]);
      await waitFor(() => document.activeElement === ok, { description: 'the confirm button to take focus' });
      assertWraps(cancel, ok, 'confirm over the bin');
      // Focus left behind in the bin goes to the dialog on top, not round the bin.
      binStops[binStops.length - 1].focus();
      tab(binStops[binStops.length - 1]);
      assert(panel.contains(document.activeElement), `Tab in the covered bin moved focus to ${describe(document.activeElement)}`);

      cancel.click();
      await answer;
      assertWraps(binStops[0], binStops[binStops.length - 1], 'bin after the confirm closed');
    } finally {
      bin.close();
      bin.remove();
    }

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.focus();
      assert(!tab(outside).defaultPrevented, 'Tab was still held after every dialog closed');
    } finally {
      outside.remove();
    }
  });

  return { passed, failed, errors };
}
