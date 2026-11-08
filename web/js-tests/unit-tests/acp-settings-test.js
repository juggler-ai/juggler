//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for what the ACP agents Settings tab decides for itself: the
 * agent-name rules that differ from MCP's, and the status→dot-class mapping.
 * The shared config-tab helpers (form → config, the whole-scope-map producers,
 * scope-of) and the shared name rules are pinned in `unit:mcp-settings`; the
 * live round-trip (config write, agent resolution, availability) is covered by
 * the Go acp config/ops tests.
 * @module unit-tests/acp-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  validateAcpAgentName,
  acpDotClass,
  AcpTab,
} from '../../js/components/settings/subprocess-tabs.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // --- validateAcpAgentName -------------------------------------------------

  await run('name validation: rejects slash (would break the model id)', () => {
    assert(validateAcpAgentName('a/b', []) !== '', 'slash accepted');
  });

  await run('name validation: does NOT reserve "juggler" (unlike MCP)', () => {
    assert(validateAcpAgentName('juggler', []) === '', 'agent names are model ids, not tool prefixes');
  });

  // --- acpDotClass ----------------------------------------------------------

  await run('dot class: maps status to the shared MCP dot classes', () => {
    assert(acpDotClass('available') === 'running', 'available should be green (running)');
    assert(acpDotClass('unavailable') === 'failed', 'unavailable should be red (failed)');
    assert(acpDotClass('disabled') === 'stopped', 'disabled should be grey (stopped)');
    assert(acpDotClass('anything-else') === 'stopped', 'unknown should default to stopped');
  });

  // --- en-XA: everything the ACP agents tab draws is a translated message -----
  // The real tab with its ops stubbed and its post-save hook (which enables the
  // ACP provider on the server) replaced, so nothing reaches the real server.
  // Agent names and agent errors are digit-only data, skipped where they stand
  // alone; example commands and env keys in placeholders are not messages.

  await run('en-XA: every state of the ACP agents tab is translated', async () => {
    await underPseudoLocale('acp-settings-test', async () => {
      const originalModal = /** @type {any} */ (window).showModal;
      const host = document.createElement('div');
      const formHost = document.createElement('div');
      formHost.id = 'acp-form';
      host.appendChild(formHost);
      document.body.appendChild(host);
      const tab = new AcpTab(host);
      const ctrl = tab.controller;
      const skip = [
        '.mcp-entry-name', '.provider-info > .mcp-error-hint', '.mcp-remove-row', '.mcp-reveal-btn',
        '.acp-name-input', '.acp-command-input', '.acp-arg-input', '.acp-env-key',
      ].join(', ');
      /** @param {string} where */
      const check = (where) => { assertPseudoLocalized(formHost, { skip, where }); };
      /**
       * @param {string} selector
       * @param {string} what
       */
      const translated = (selector, what) => {
        const el = formHost.querySelector(selector);
        assert(el, `nothing drawn for ${what}`);
        assert(isPseudoLocalized(el.textContent || ''), `${what}: ${JSON.stringify(el?.textContent)}`);
      };
      const formError = (/** @type {string} */ what) => translated('.mcp-form > .mcp-error-hint', what);
      const banner = (/** @type {string} */ what) => translated(':scope > .mcp-error-hint', what);
      try {
        /** @type {any[]} */
        let items = [];
        /** @type {any} */
        let config = { global: {}, project: {}, hasProject: true };
        let failList = false;
        let failSet = false;
        // Non-Error rejections reach the controller's own fallback messages.
        ctrl.spec = {
          ...ctrl.spec,
          ops: {
            list: async () => { if (failList) throw 'down'; return items; },
            getConfig: async () => config,
            setConfig: async (/** @type {any} */ _scope, /** @type {any} */ map) => {
              if (failSet) throw 'refused';
              config = { ...config, global: map };
            },
          },
          onAfterSave: async () => {},
        };

        await ctrl.refresh();
        assert(formHost.querySelector('.mcp-empty'), 'empty state not drawn');
        check('empty list');

        // Every status; no agent has a command, so each row says so.
        items = [
          { name: '1', status: 'available', enabled: true },
          { name: '2', status: 'unavailable', error: '9' },
          { name: '3', status: 'disabled', enabled: false },
          { name: '4' },
        ];
        config = { global: { 1: {}, 2: {}, 3: { enabled: false } }, project: { 4: {} }, hasProject: true };
        await ctrl.refresh();
        assert(formHost.querySelectorAll('.mcp-row').length === 4, 'rows not drawn');
        const rowErr = formHost.querySelector('.provider-info > .mcp-error-hint');
        assert(rowErr && rowErr.textContent === '9', `an agent's own error is data, was ${JSON.stringify(rowErr?.textContent)}`);
        check('populated list');

        failList = true;
        await ctrl.refresh();
        banner('load failure');
        failList = false;
        await ctrl.refresh();

        // A refresh is held off so an action's own error is what the banner shows.
        ctrl.busy = true;
        failSet = true;
        await ctrl._setEnabled('global', '1', false);
        ctrl.render();
        banner('toggle failure');

        /** @type {any} */
        let asked = null;
        /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked = options; return true; };
        await ctrl._confirmDelete('global', '1');
        assert(asked, 'no delete confirm');
        for (const key of ['title', 'message', 'confirmText']) {
          assert(isPseudoLocalized(String(asked[key] || '')), `delete confirm ${key}: ${JSON.stringify(asked[key])}`);
        }
        ctrl.render();
        banner('delete failure');
        ctrl.busy = false;
        failSet = false;
        await ctrl.refresh();

        // Add form with two argument rows (the second has its own placeholder)
        // and a variable row.
        ctrl.openForm('add');
        const [addArg, addEnv] = /** @type {HTMLElement[]} */ ([...formHost.querySelectorAll('.mcp-add-row')]);
        assert(addArg && addEnv, 'add-row buttons not drawn');
        addArg.click();
        addArg.click();
        addEnv.click();
        check('add form');
        const argInputs = /** @type {HTMLInputElement[]} */ ([...formHost.querySelectorAll('.acp-arg-input')]);
        assert(argInputs.length === 2, 'two argument rows expected');
        assert(isPseudoLocalized(argInputs[1].placeholder), `second argument placeholder: ${JSON.stringify(argInputs[1].placeholder)}`);
        const iconButtons = formHost.querySelectorAll('.mcp-remove-row, .mcp-reveal-btn');
        assert(iconButtons.length === 4, `expected 4 icon buttons, found ${iconButtons.length}`);
        for (const btn of iconButtons) {
          const label = btn.getAttribute('aria-label') || '';
          assert(isPseudoLocalized(label), `icon button aria-label: ${JSON.stringify(label)}`);
        }

        const field = (/** @type {string} */ cls) => /** @type {HTMLInputElement} */ (formHost.querySelector(`.acp-${cls}`));
        for (const [name, what] of [['', 'blank name'], ['a b', 'spaced name'], ['a/b', 'slashed name'], ['1', 'duplicate name']]) {
          field('name-input').value = name;
          await ctrl._save();
          formError(what);
        }
        field('name-input').value = '9';
        field('command-input').value = '';
        await ctrl._save();
        formError('missing command');
        field('command-input').value = '5';
        field('env-key').value = '';
        field('env-value').value = '5';
        await ctrl._save();
        formError('unnamed variable');
        field('env-value').value = '';
        failSet = true;
        await ctrl._save();
        formError('save failure');
        check('add form with an error');
        failSet = false;
        await ctrl._save();
        assert(!ctrl.editing, 'a valid save should close the form');

        ctrl.openForm('edit', { name: '1' });
        check('edit form');
      } finally {
        /** @type {any} */ (window).showModal = originalModal;
        tab.dispose();
        host.remove();
      }
    });
  });

  return { passed, failed, errors };
}
