//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the composer's button-opened menus: the commands (`/`)
 * menu and the skill (`$`) picker — and the send-later picker, which is a
 * dialog instead.
 *
 *   1. Each trigger announces itself as a menu button (`aria-haspopup="menu"`)
 *      and starts collapsed.
 *   2. Each surface is a `menu`: every row is a `menuitem`, a divider is a
 *      `separator`, and the empty-state hint is a disabled item.
 *   3. `aria-expanded` follows the menu: true while it is open, false again
 *      after a dismissal through the popup manager (the Escape / outside-click
 *      route) and after choosing a row.
 *
 * The row builders are shared with the `/` and `$` autocomplete, which is a
 * different widget, so the roles must be applied by the composer's menus and
 * must not leak into those builders.
 * @module unit-tests/composer-menu-aria-test
 */

import { assert } from '../utilities/test-helpers.js';
import { assertMenuShape, assertDialogPopover } from '../utilities/menu-assertions.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { buildCommandRow, buildCommandsSettingsRow } from '../../js/services/command-manager-entry.js';
import { renderSkillMenuItem } from '../../js/components/skill-mention-provider.js';
import '../../js/components/composer.js';

/** @type {import('../../js/services/skills.js').SkillMeta[]} */
const FIXTURE = /** @type {any} */ ([
  { name: 'tdd', description: 'Test-driven development workflow', scope: 'project', source: 'juggler', hasScripts: false },
  { name: 'research', description: 'Deep research and synthesis', scope: 'project', source: 'juggler', hasScripts: false },
]);

/**
 * Mount a <composer-box> and bind its listeners synchronously (render() defers
 * setupListeners() to rAF, which never pumps in the hidden test window).
 * @returns {{box: any, container: HTMLElement}} The mounted composer-box and its container.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:480px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  return { box, container };
}

/**
 * A stub message thread whose frozen skill snapshot is `skills`.
 * @param {import('../../js/services/skills.js').SkillMeta[]} skills - Snapshot it advertises.
 * @returns {any} The stub thread.
 */
function makeStubThread(skills) {
  const skillItem = {
    // Own `constructor` shadows Object's, so getThreadSkillSnapshot's id lookup
    // resolves to this manifest.
    constructor: { MANIFEST: { id: 'skill' } },
    getSnapshotSkills: async () => skills,
  };
  return {
    conversationId: 'c-test',
    threadItemId: null,
    hasBusyItems: () => false,
    getContextItems: () => [skillItem],
  };
}

/**
 * Assert a trigger button's menu-button attributes.
 * @param {HTMLElement|null} button - The trigger.
 * @param {'true'|'false'} expanded - The aria-expanded value expected.
 * @param {string} label - Assertion label.
 */
function assertTrigger(button, expanded, label) {
  assert(!!button, `${label}: no trigger button`);
  const b = /** @type {HTMLElement} */ (button);
  assert(b.getAttribute('aria-haspopup') === 'menu',
    `${label}: the trigger does not announce a menu (aria-haspopup=${JSON.stringify(b.getAttribute('aria-haspopup'))})`);
  assert(b.getAttribute('aria-expanded') === expanded,
    `${label}: aria-expanded should be ${expanded}, got ${JSON.stringify(b.getAttribute('aria-expanded'))}`);
}

/**
 * Assert a surface is a labelled menu whose rows are all menu items.
 * @param {HTMLElement|null} menu - The menu surface.
 * @param {string} label - Assertion label.
 */
function assertMenuSurface(menu, label) {
  assert(!!menu, `${label}: the menu did not open`);
  const m = /** @type {HTMLElement} */ (menu);
  assert(m.getAttribute('role') === 'menu', `${label}: the surface has role ${JSON.stringify(m.getAttribute('role'))}, not "menu"`);
  assert(!!m.getAttribute('aria-label'), `${label}: the menu has no accessible name`);
  const rows = /** @type {HTMLElement[]} */ ([...m.querySelectorAll('.menu-item')]);
  assert(rows.length > 0, `${label}: the menu has no rows`);
  const unroled = rows.filter((r) => r.getAttribute('role') !== 'menuitem').map((r) => (r.textContent || '').trim());
  assert(unroled.length === 0, `${label}: rows without role="menuitem": ${JSON.stringify(unroled)}`);
  const dividers = /** @type {HTMLElement[]} */ ([...m.querySelectorAll('.menu-divider')]);
  assert(dividers.every((d) => d.getAttribute('role') === 'separator'), `${label}: a divider is not a separator`);
  assertMenuShape(m, label);
}

/**
 * Run the composer menu ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // ── Test 1: the commands (`/`) menu ───────────────────────────────────────
  {
    __resetPopupManagerForTests();
    const { box, container } = mountComposer();
    try {
      const button = /** @type {HTMLElement|null} */ (box.querySelector('#commands-button'));
      assertTrigger(button, 'false', 'commands closed');

      await box._commandsPopup.open();
      assertMenuSurface(document.querySelector('#commands-menu'), 'commands menu');
      assertTrigger(button, 'true', 'commands open');

      // Escape and outside-click both reach the menu through the popup manager.
      closeAllPopups();
      assert(!document.querySelector('#commands-menu'), 'commands: the dismissed menu is still in the page');
      assertTrigger(button, 'false', 'commands dismissed');
      passed++;
    } catch (e) {
      failed++;
      errors.push('commands-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._commandsPopup.close();
      container.remove();
    }
  }

  // ── Test 2: the skill (`$`) picker, with skills and empty ─────────────────
  {
    __resetPopupManagerForTests();
    const { box, container } = mountComposer();
    try {
      const button = /** @type {HTMLElement|null} */ (box.querySelector('#skill-button'));
      assertTrigger(button, 'false', 'skills closed');

      box._messageThread = makeStubThread(FIXTURE);
      await box._skillPopup.open();
      const menu = /** @type {HTMLElement|null} */ (document.querySelector('#skill-menu'));
      assertMenuSurface(menu, 'skill menu');
      assert(!!menu?.querySelector('.menu-divider[role="separator"]'), 'skill menu: no separator before the footer');
      assertTrigger(button, 'true', 'skills open');

      // Choosing a row closes the menu, and the trigger must say so.
      const skillRow = /** @type {HTMLElement|null} */ (menu?.querySelector('.skill-mention-item') ?? null);
      assert(!!skillRow, 'skill menu: no skill row to choose');
      /** @type {HTMLElement} */ (skillRow).click();
      assert(!document.querySelector('#skill-menu'), 'skills: choosing a skill left the menu open');
      assertTrigger(button, 'false', 'skills after choosing');

      // Empty snapshot: the hint is an item, but one that does nothing.
      box._messageThread = makeStubThread([]);
      await box._skillPopup.open();
      const empty = /** @type {HTMLElement|null} */ (document.querySelector('#skill-menu'));
      assertMenuSurface(empty, 'empty skill menu');
      const hint = /** @type {HTMLElement|null} */ (empty?.querySelector('.menu-item-hint') ?? null);
      assert(hint?.getAttribute('aria-disabled') === 'true', 'empty skill menu: the hint is offered as a live choice');
      closeAllPopups();
      assertTrigger(button, 'false', 'empty skills dismissed');
      passed++;
    } catch (e) {
      failed++;
      errors.push('skill-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._skillPopup.close();
      container.remove();
    }
  }

  // ── Test 3: the schedule-send picker is a dialog, not a menu ──────────────
  // It holds preset chips, steppers and a confirm button, which a menu could not.
  {
    __resetPopupManagerForTests();
    const { box, container } = mountComposer();
    try {
      const button = /** @type {HTMLElement|null} */ (box.querySelector('.schedule-send-btn'));
      assert(button?.getAttribute('aria-expanded') === 'false', 'schedule: the clock button does not start collapsed');
      await box._schedulePopup.open();
      assertDialogPopover(document.querySelector('#schedule-send-menu'), button, 'schedule-send picker');
      closeAllPopups();
      assert(!document.querySelector('#schedule-send-menu'), 'schedule: the dismissed picker is still in the page');
      assert(button?.getAttribute('aria-expanded') === 'false', 'schedule: the clock button still says open after dismissal');
      passed++;
    } catch (e) {
      failed++;
      errors.push('schedule-send: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      container.remove();
    }
  }

  // ── Test 4: the shared row builders stay role-free ────────────────────────
  // The `/` and `$` autocomplete renders rows with the same builders, and it is
  // not a menu: a role baked into a builder would mislabel every one of them.
  {
    try {
      const rows = [
        buildCommandRow({ name: 'clear' }),
        buildCommandsSettingsRow('slash-command-item'),
        renderSkillMenuItem(FIXTURE[0]),
      ];
      const roled = rows.filter((r) => r.hasAttribute('role')).map((r) => r.className);
      assert(roled.length === 0, `shared row builders set a role of their own: ${JSON.stringify(roled)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('shared-builders-role-free: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  __resetPopupManagerForTests();
  return { passed, failed, errors };
}
