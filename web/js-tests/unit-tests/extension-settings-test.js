//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { pseudoLocalize } from '../../sdk/lib/i18n.js';
import {
  decodeExtensionSettingValue,
  ExtensionSettingsEditor,
} from '../../js/components/settings/extensions-settings.js';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => void|Promise<void>} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run('setting decoder validates typed values', () => {
    assert(decodeExtensionSettingValue({ key: 'n', type: 'number', label: 'Count' }, '2.5') === 2.5,
      'number was not decoded');
    assert(decodeExtensionSettingValue({ key: 'b', type: 'boolean', label: 'Enabled' }, true) === true,
      'boolean was not decoded');
    assert(decodeExtensionSettingValue({ key: 'e', type: 'enum', label: 'Mode', options: ['a', 'b'] }, 'b') === 'b',
      'enum was not decoded');
    assert(decodeExtensionSettingValue({ key: 'u', type: 'url', label: 'Host' }, '') === null,
      'blank optional URL should clear');
    let message = '';
    try {
      decodeExtensionSettingValue({ key: 'u', type: 'url', label: 'Host' }, 'not a url');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    assert(message.includes('absolute URL'), 'invalid URL should have a useful error');
  });

  await run('editor renders all field types and loads effective values safely', async () => {
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'text', type: 'string', label: 'Text', help: 'Helpful', required: true },
        { key: 'token', type: 'secret', label: 'Token' },
        { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
        { key: 'count', type: 'number', label: 'Count' },
        { key: 'mode', type: 'enum', label: 'Mode', options: ['fast', 'safe'] },
        { key: 'host', type: 'url', label: 'Host' },
      ],
    };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ text: 'hello', token: { __present: true }, enabled: true, count: 3, mode: 'safe' }),
      set: async () => ({}),
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(root.querySelectorAll('.extension-setting-field').length === 6, 'not every field rendered');
      assert(root.querySelector('input[type="text"]')?.value === 'hello', 'string value not loaded');
      assert(root.querySelector('input[type="checkbox"]')?.checked === true, 'boolean value not loaded');
      assert(root.querySelector('select')?.value === 'safe', 'enum value not loaded');
      const secret = /** @type {HTMLInputElement|null} */ (root.querySelector('input[type="password"]'));
      assert(secret?.value === '', 'secret value should never be rendered');
      assert(root.querySelector('.extension-secret-status')?.textContent === 'Set', 'secret presence not shown');
      assert(root.textContent?.includes('Helpful') && root.textContent?.includes('Default: true'),
        'help/default metadata not shown');
    } finally {
      root.remove();
    }
  });

  await run('editor saves typed values while preserving an unchanged secret', async () => {
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'token', type: 'secret', label: 'Token' },
        { key: 'count', type: 'number', label: 'Count' },
        { key: 'enabled', type: 'boolean', label: 'Enabled' },
      ],
    };
    const effective = { token: { __present: true }, count: 1, enabled: false };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => effective,
      set: async (params) => { request = params; return { ...effective, ...params.values }; },
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      /** @type {HTMLInputElement} */ (root.querySelector('input[type="number"]')).value = '7';
      /** @type {HTMLInputElement} */ (root.querySelector('input[type="checkbox"]')).checked = true;
      /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(request?.extId === '@test/settings' && request.scope === 'global', 'wrong save envelope');
      assert(request.values.count === 7 && request.values.enabled === true, 'typed values not saved');
      assert(request.values.token?.__present === true, 'unchanged secret was not preserved');
      assert(!!root.querySelector('.extension-settings-message')?.textContent,
        'success feedback missing');
    } finally {
      root.remove();
    }
  });

  await run('a text setting is a textarea that loads and saves multi-line values', async () => {
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [{ key: 'policy', type: 'text', label: 'Policy' }],
    };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ policy: 'one\ntwo' }),
      set: async (params) => { request = params; return params.values; },
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const textarea = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('textarea'));
      assert(textarea?.value === 'one\ntwo', 'multi-line value not loaded into a textarea');
      assert(!textarea.disabled, 'textarea left disabled after loading');
      textarea.value = 'three\nfour';
      /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(request?.values.policy === 'three\nfour', 'multi-line value not saved intact');
    } finally {
      root.remove();
    }
  });

  await run('a capability-scoped editor shows and saves only that capability\'s settings', async () => {
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'level', type: 'enum', label: 'Level', options: ['a', 'b'], capability: 'strategy:mine' },
        { key: 'other', type: 'string', label: 'Other' },
        { key: 'elsewhere', type: 'string', label: 'Elsewhere', capability: 'strategy:theirs' },
      ],
    };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ level: 'a', other: 'x', elsewhere: 'y' }),
      set: async (params) => { request = params; return params.values; },
    }, { capability: 'strategy:mine' });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const keys = [...root.querySelectorAll('.extension-setting-field')]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.settingKey);
      assert(keys.length === 1 && keys[0] === 'level', `expected only 'level', got ${JSON.stringify(keys)}`);
      /** @type {HTMLSelectElement} */ (root.querySelector('select')).value = 'b';
      /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      // A partial update: the extension's other settings are left as stored.
      assert(JSON.stringify(request?.values) === '{"level":"b"}',
        `expected only the shown setting saved, got ${JSON.stringify(request?.values)}`);
    } finally {
      root.remove();
    }
  });

  await run('a view previews a preset read-only, holds the real value, and seeds on unlock', async () => {
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [
        { key: 'level', type: 'enum', label: 'Level', options: ['strict', 'loose', 'custom'] },
        { key: 'policy', type: 'text', label: 'Policy' },
      ],
    };
    const PRESETS = /** @type {Record<string, string>} */ ({ strict: 'STRICT RULES', loose: 'LOOSE RULES' });
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ level: 'strict', policy: 'my own words' }),
      set: async (params) => { request = params; return { level: 'strict', policy: 'my own words', ...params.values }; },
    }, {
      view: (values) => (values.level === 'custom'
        ? { policy: { seed: 'SEED', note: 'yours' } }
        : { policy: { preview: PRESETS[String(values.level)] || PRESETS.strict, note: 'preset' } }),
    });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const select = /** @type {HTMLSelectElement} */ (root.querySelector('select'));
      const textarea = /** @type {HTMLTextAreaElement} */ (root.querySelector('textarea'));
      const note = /** @type {HTMLElement} */ (root.querySelector('.extension-setting-view-note'));
      const choose = (/** @type {string} */ level) => {
        select.value = level;
        select.dispatchEvent(new Event('change'));
      };

      assert(textarea.value === 'STRICT RULES' && textarea.readOnly, 'a preset should be previewed read-only');
      assert(!note.hidden && note.textContent === 'preset', 'the view note should show');

      choose('loose');
      assert(textarea.value === 'LOOSE RULES' && textarea.readOnly, 'the preview should follow the level');

      // The preview is display only: saving keeps the stored custom text.
      /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(request?.values.policy === 'my own words',
        `a preview must never be saved, got ${JSON.stringify(request?.values.policy)}`);
      assert(textarea.value === 'LOOSE RULES' && textarea.readOnly, 'the preview should survive the save');

      choose('custom');
      assert(textarea.value === 'my own words' && !textarea.readOnly,
        'unlocking should restore the held custom text');
      assert(note.textContent === 'yours', 'the note should follow the view');

      // With no custom text, unlocking starts from the preset just shown.
      textarea.value = '';
      choose('loose');
      choose('custom');
      assert(textarea.value === 'LOOSE RULES' && !textarea.readOnly,
        `a blank field should be seeded from the last preview, got ${JSON.stringify(textarea.value)}`);

      // ...but clearing it on purpose is not undone behind the user's back.
      textarea.value = '';
      textarea.dispatchEvent(new Event('change'));
      assert(textarea.value === '', 'a field cleared by the user must stay clear');
    } finally {
      root.remove();
    }
  });

  await run('a view that throws leaves a plain editable field', async () => {
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [{ key: 'policy', type: 'text', label: 'Policy' }],
    };
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ policy: 'kept' }),
      set: async () => ({}),
    }, { view: () => { throw new Error('boom'); } });
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const textarea = /** @type {HTMLTextAreaElement} */ (root.querySelector('textarea'));
      assert(textarea.value === 'kept' && !textarea.readOnly, 'a failing view must not disturb the field');
    } finally {
      root.remove();
    }
  });

  await run('secret save and clear use isolated partial updates', async () => {
    /** @type {any[]} */
    const requests = [];
    const manifest = {
      id: '@test/settings', name: 'Settings', version: '1.0.0',
      settings: [{ key: 'token', type: 'secret', label: 'Token' }],
    };
    let present = false;
    const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
      get: async () => ({ token: { __present: present } }),
      set: async (params) => {
        requests.push(params);
        present = params.values.token !== '';
        return { token: { __present: present } };
      },
    });
    // window.showModal is the presenter every dialog helper goes through, so
    // standing in for it answers the imported showConfirm too.
    const originalShowModal = /** @type {any} */ (window).showModal;
    /** @type {any} */ (window).showModal = async () => true;
    const root = editor.render();
    document.body.appendChild(root);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const input = /** @type {HTMLInputElement} */ (root.querySelector('input[type="password"]'));
      input.value = 'new-secret';
      const buttons = root.querySelectorAll('.extension-secret-actions button');
      /** @type {HTMLButtonElement} */ (buttons[0]).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(requests[0].values.token === 'new-secret', 'secret save did not send the new value');
      assert(input.value === '', 'secret input was not cleared after saving');
      /** @type {HTMLButtonElement} */ (buttons[1]).click();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(requests[1].values.token === '', 'secret clear did not send an empty value');
      assert(root.querySelector('.extension-secret-status')?.textContent === 'Not set', 'clear status not shown');
    } finally {
      /** @type {any} */ (window).showModal = originalShowModal;
      root.remove();
    }
  });

  // The editor's own words come from the core catalogue; the manifest's
  // name, labels, help and option labels from the extension's, registered
  // under its id. An option's label is translated, its stored value never is.
  // The URL field's placeholder is an example address and the <code> paths
  // are file names: neither is words.
  await run('under en-XA every string the editor shows is pseudo-localised, and values stay English', async () => {
    const manifestText = ['Sample', 'Text', 'Helpful', 'Token', 'Mode', 'fast', 'safe', 'Count', 'Host', 'Level'];
    /** @type {any} */
    let request = null;
    const manifest = {
      id: '@test/xa', name: 'Sample', version: '1.0.0',
      settings: [
        { key: 'text', type: 'string', label: 'Text', help: 'Helpful', required: true },
        { key: 'token', type: 'secret', label: 'Token', required: true },
        { key: 'mode', type: 'enum', label: 'Mode', options: ['fast', 'safe'], default: 'safe' },
        { key: 'count', type: 'number', label: 'Count', default: 3 },
        { key: 'host', type: 'url', label: 'Host' },
        { key: 'level', type: 'enum', label: 'Level', options: ['fast'], capability: 'strategy:mine' },
      ],
    };
    /** @type {HTMLElement[]} */
    const roots = [];
    try {
      await underPseudoLocale('extension-settings-test', async () => {
        const editor = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
          get: async () => ({ text: '1', token: { __present: false }, mode: 'fast', count: 3 }),
          set: async (params) => { request = params; return { text: '1', ...params.values }; },
        });
        const root = editor.render();
        roots.push(root);
        document.body.appendChild(root);
        await new Promise(resolve => setTimeout(resolve, 0));

        const select = /** @type {HTMLSelectElement} */ (root.querySelector('select'));
        const fast = /** @type {HTMLOptionElement} */ ([...select.options].find((o) => o.value === 'fast'));
        assert(fast && fast.textContent === pseudoLocalize('fast'),
          `an option's label should be translated, got ${JSON.stringify(fast?.textContent)}`);
        select.value = 'safe';
        /** @type {HTMLButtonElement} */ (root.querySelector('.extension-settings-save')).click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(request?.values.mode === 'safe',
          `the stored value must stay English, got ${JSON.stringify(request?.values.mode)}`);

        assertPseudoLocalized(root, { skip: 'input[type="url"], code', atLeast: 15 });

        // A capability's page explains itself differently.
        const scoped = new ExtensionSettingsEditor(/** @type {any} */ (manifest), {
          get: async () => ({}), set: async () => ({}),
        }, { capability: 'strategy:mine' });
        const scopedRoot = scoped.render();
        roots.push(scopedRoot);
        document.body.appendChild(scopedRoot);
        await new Promise(resolve => setTimeout(resolve, 0));
        assertPseudoLocalized(scopedRoot, { skip: 'code', where: 'capability page' });
      }, { '@test/xa': manifestText });
    } finally {
      for (const root of roots) root.remove();
    }
  });

  return { passed, failed, errors };
}
