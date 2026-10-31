//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Slash commands settings tab — one page listing the user's own commands and the
 * built-ins, editing the first and pointing the second at its extension.
 *
 * The collaborators the page reads are stood in for: the commands endpoint, the
 * slash handler's command list, the user-command refresh a save triggers, the
 * settings opener and the confirm dialog. The extension catalog is the real
 * one, which only names extensions here.
 * @module unit-tests/commands-tab-test
 */

import { assert, neutralizeStrayOverlays, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { CommandsTab } from '../../js/components/settings/commands-tab.js';
import { resetUserCommandsCache } from '../../js/services/user-commands.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import commandRegistry, { USER_COMMANDS_REFRESHED } from '../../js/registries/command-registry.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * A user command as the server lists it.
 * @param {string} name
 * @param {'user'|'project'} scope
 * @param {string} [error] - Set for a broken file
 * @returns {import('../../js/services/user-commands.js').UserCommandDef} The definition.
 */
const userDef = (name, scope, error) => ({
  name,
  scope,
  path: `/${scope}/${name}.md`,
  frontmatter: error ? {} : { description: `the ${name} command` },
  body: `Do ${name}`,
  ...(error ? { error } : {}),
});

/** Built-ins as the slash handler reports them. */
const BUILTINS = [
  { name: 'clear', label: 'Clear', description: 'Clear the conversation', userDefined: false, scope: '', argsHint: '', extensionId: '@juggler/core', danger: false, icon: '' },
  { name: 'alpha', label: 'Alpha', description: 'First letter', userDefined: false, scope: '', argsHint: '<x>', extensionId: '@juggler/core', danger: false, icon: '' },
  { name: 'mine', label: 'Mine', description: 'the mine command', userDefined: true, scope: 'project', argsHint: '', extensionId: undefined, danger: false, icon: '' },
];

/**
 * @typedef {object} Harness
 * @property {any} tab - The mounted tab
 * @property {HTMLElement} root - Its root element
 * @property {{url: string, method: string, body: any}[]} writes - PUTs and DELETEs sent
 * @property {any[]} opened - Calls the settings opener received
 * @property {any[]} confirms - Confirm dialogs shown
 * @property {(list: any[]) => void} setList - Change what the server lists
 * @property {(answer: boolean) => void} answerConfirms - What every confirm answers
 */

/**
 * Mount a Commands tab over stood-in collaborators, run `body`, and take it all
 * down again.
 * @param {(h: Harness) => Promise<void>} body
 * @param {{list?: any[]}} [opts]
 * @returns {Promise<void>}
 */
async function withTab(body, opts = {}) {
  let list = opts.list ?? [userDef('mine', 'project'), userDef('broken', 'project', 'missing description'), userDef('everywhere', 'user')];
  /** @type {Harness['writes']} */
  const writes = [];
  /** @type {any[]} */
  const opened = [];
  /** @type {any[]} */
  const confirms = [];
  let confirmAnswer = false;

  const originalFetch = window.fetch;
  const originalShowModal = /** @type {any} */ (window).showModal;
  const realInit = slashCommandHandler.init;
  const realGetCommands = slashCommandHandler.getCommands;
  const realRefresh = commandRegistry.refreshUserCommands;

  window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/api/user-commands')) return originalFetch.call(window, input, init);
    const method = init?.method || 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new window.Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new window.Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { confirms.push(options); return confirmAnswer; };
  slashCommandHandler.init = /** @type {any} */ (async () => {});
  slashCommandHandler.getCommands = /** @type {any} */ (() => BUILTINS);
  // What a save's refresh does that the page hears: the cache dropped, then the
  // event every client's page re-reads on.
  commandRegistry.refreshUserCommands = async () => {
    resetUserCommandsCache();
    document.dispatchEvent(new CustomEvent(USER_COMMANDS_REFRESHED));
  };
  const restoreOpener = registerSettingsOpener((tab, options) => { opened.push({ tab, options }); });
  resetUserCommandsCache();

  const host = document.createElement('div');
  host.innerHTML = '<section id="tab-commands"><div class="command-page" id="commands-tab-root"></div></section>';
  document.body.appendChild(host);
  const tab = /** @type {any} */ (new CommandsTab(host));
  try {
    tab.render();
    tab.connect();
    await tab.reload();
    await body({
      tab,
      root: /** @type {HTMLElement} */ (host.querySelector('#commands-tab-root')),
      writes,
      opened,
      confirms,
      setList: (next) => { list = next; },
      answerConfirms: (answer) => { confirmAnswer = answer; },
    });
  } finally {
    tab.dispose();
    host.remove();
    restoreOpener();
    window.fetch = originalFetch;
    /** @type {any} */ (window).showModal = originalShowModal;
    slashCommandHandler.init = realInit;
    slashCommandHandler.getCommands = realGetCommands;
    commandRegistry.refreshUserCommands = realRefresh;
    resetUserCommandsCache();
    neutralizeStrayOverlays();
    document.querySelector('model-picker')?.remove();
  }
}

/**
 * The keys of the listed rows, group by group.
 * @param {HTMLElement} root
 * @returns {string[][]} One array of keys per group
 */
const groupKeys = (root) => Array.from(root.querySelectorAll('.command-page-group')).map((g) =>
  Array.from(g.querySelectorAll('.command-page-row')).map((r) => /** @type {HTMLElement} */ (r).dataset.key || ''));

/**
 * @param {HTMLElement} root
 * @param {string} key
 * @returns {HTMLElement} The row with that key, asserted present
 */
function row(root, key) {
  const el = /** @type {HTMLElement|null} */ (root.querySelector(`.command-page-row[data-key="${key}"]`));
  assert(!!el, `no row ${key}; listed ${JSON.stringify(groupKeys(root))}`);
  return /** @type {HTMLElement} */ (el);
}

/**
 * @param {HTMLElement} root
 * @param {string} sel
 * @returns {any} The detail pane's element matching `sel`
 */
const detail = (root, sel) => root.querySelector(`#command-page-detail ${sel}`);

/**
 * Type into an editor field the way a user does.
 * @param {HTMLElement} root
 * @param {string} sel
 * @param {string} value
 */
function type(root, sel, value) {
  const input = detail(root, sel);
  assert(!!input, `no editor field ${sel}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  await run('the list holds the user\'s commands by scope, then the built-ins', () => withTab(async ({ root }) => {
    const groups = groupKeys(root);
    assert(JSON.stringify(groups) === JSON.stringify([
      ['user:project:mine', 'user:project:broken'],
      ['user:user:everywhere'],
      ['builtin:alpha', 'builtin:clear'],
    ]), `groups = ${JSON.stringify(groups)}`);
    // A user command is listed once, under where it is saved, even though the
    // slash handler reports it beside the built-ins.
    assert(!root.querySelector('[data-key="builtin:mine"]'), 'a user command must not be listed as a built-in');
    const broken = row(root, 'user:project:broken');
    assert(broken.classList.contains('is-broken'), 'a broken file must be marked');
    assert((broken.textContent || '').includes('missing description'), `a broken file must show its error, got ${broken.textContent}`);
    assert(!!detail(root, '.command-page-intro'), 'with nothing selected the pane must introduce the page');

    // The name is the row's title: flush with the row, while the description
    // is indented under it and fainter. Inline code's own padding must not
    // push the name past its description.
    const name = getComputedStyle(/** @type {Element} */ (row(root, 'user:project:mine').querySelector('.command-page-row-name')));
    const desc = getComputedStyle(/** @type {Element} */ (row(root, 'user:project:mine').querySelector('.command-page-row-desc')));
    assert(parseFloat(name.paddingLeft) === 0, `the name must sit flush, padding-left = ${name.paddingLeft}`);
    assert(parseFloat(desc.paddingLeft) > 0, `the description must be indented, padding-left = ${desc.paddingLeft}`);
    assert(name.color !== desc.color, 'the description must be a different (fainter) colour from the name');
  }));

  // A live refresh can land while a load is in flight. The overtaken load must
  // not resolve on a page nobody drew: a deep-link awaiting it would act on an
  // empty list.
  await run('a load overtaken by a refresh resolves on a drawn page', () => withTab(async ({ tab, root }) => {
    root.querySelector('#command-page-list')?.replaceChildren();
    tab.loaded = false;
    const first = tab.reload();
    document.dispatchEvent(new CustomEvent(USER_COMMANDS_REFRESHED));
    await first;
    assert(groupKeys(root).length === 3, `the page must be drawn when the load resolves, got ${JSON.stringify(groupKeys(root))}`);
  }));

  await run('the filter narrows every group', () => withTab(async ({ root }) => {
    const filter = /** @type {HTMLInputElement} */ (root.querySelector('#command-page-filter'));
    filter.value = 'LETTER';
    filter.dispatchEvent(new Event('input'));
    assert(JSON.stringify(groupKeys(root)) === JSON.stringify([[], [], ['builtin:alpha']]),
      `a filter must match descriptions, case-insensitively, got ${JSON.stringify(groupKeys(root))}`);
    const empty = /** @type {HTMLElement|null} */ (root.querySelector('.command-page-empty'));
    assert(empty?.textContent === 'No matches', `an emptied group must say so, without a full stop, got ${JSON.stringify(empty?.textContent)}`);
    const align = getComputedStyle(/** @type {HTMLElement} */ (empty)).textAlign;
    assert(align === 'center', `empty-group text must be centred, got ${align}`);
  }));

  await run('a built-in shows what it does and leads to its own entry in Extensions', () => withTab(async ({ root, opened }) => {
    row(root, 'builtin:alpha').click();
    await waitFor(() => !!detail(root, '.command-page-builtin'), { description: 'the built-in detail' });
    assert(row(root, 'builtin:alpha').classList.contains('selected'), 'the row must carry the selection');
    assert(row(root, 'builtin:alpha').getAttribute('aria-current') === 'true', 'the selected row must say so to assistive tech');
    const heading = detail(root, 'h2')?.textContent;
    assert(heading === '/alpha <x>', `the heading must spell the command as typed, got ${heading}`);
    assert((detail(root, '.command-page-builtin-desc')?.textContent || '') === 'First letter', 'the description must be shown');
    assert(!detail(root, '#cmd-name'), 'a built-in must not open the editor');

    detail(root, '[data-action="show-extension"]').click();
    assert(JSON.stringify(opened) === JSON.stringify([{ tab: 'extensions', options: { capability: { itemType: 'command', id: 'alpha' } } }]),
      `Show in Extensions must open the Extensions tab on the command itself, got ${JSON.stringify(opened)}`);
  }));

  await run('a user command opens in the editor, and saving keeps it selected', () => withTab(async ({ root, writes, setList }) => {
    row(root, 'user:project:mine').click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the editor' });
    assert(detail(root, '#cmd-name').value === 'mine', 'the editor must hold the selected command');
    assert(detail(root, '#cmd-template').value === 'Do mine', 'the editor must hold its template');

    type(root, '#cmd-description', 'a better description');
    setList([userDef('mine', 'project'), userDef('broken', 'project', 'missing description'), userDef('everywhere', 'user')]);
    detail(root, '#cmd-save').click();
    await waitFor(() => writes.length === 1, { description: 'the save' });
    assert(writes[0]?.method === 'PUT' && writes[0]?.url === '/api/user-commands/project/mine', `wrote ${JSON.stringify(writes[0])}`);
    assert(writes[0]?.body.description === 'a better description', `description = ${writes[0]?.body.description}`);
    await waitFor(() => row(root, 'user:project:mine').classList.contains('selected') && !!detail(root, '#cmd-name'),
      { description: 'the saved command, still selected' });
  }));

  await run('renaming moves the selection to the new file', () => withTab(async ({ root, writes, setList }) => {
    row(root, 'user:project:mine').click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the editor' });
    type(root, '#cmd-name', 'renamed');
    detail(root, '[data-scope="user"]').click();
    setList([userDef('renamed', 'user'), userDef('broken', 'project', 'missing description'), userDef('everywhere', 'user')]);
    detail(root, '#cmd-save').click();
    await waitFor(() => writes.length === 2, { description: 'the write and the old file\'s delete' });
    assert(writes[0]?.method === 'PUT' && writes[0]?.url === '/api/user-commands/user/renamed', `wrote ${JSON.stringify(writes[0])}`);
    assert(writes[1]?.method === 'DELETE' && writes[1]?.url === '/api/user-commands/project/mine', `then ${JSON.stringify(writes[1])}`);
    await waitFor(() => !!root.querySelector('.command-page-row.selected[data-key="user:user:renamed"]'),
      { description: 'the renamed command, selected' });
  }));

  await run('"New command…" and the deep-link both open a draft', () => withTab(async ({ root, tab }) => {
    /** @type {HTMLElement} */ (root.querySelector('.command-page-new')).click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the draft' });
    assert(detail(root, '#cmd-name').value === '', 'a pressed New command must start empty');
    assert(detail(root, '#cmd-delete').classList.contains('hidden'), 'a draft has nothing to delete');

    const revealed = await tab.revealNewCommand('standup');
    assert(revealed === true, 'an untouched draft must give way to the deep-link');
    assert(detail(root, '#cmd-name').value === 'standup', `the deep-link must pre-fill the name, got ${detail(root, '#cmd-name').value}`);
  }));

  await run('the settings panel routes a new-command target to the tab', async () => {
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    /** @type {any[]} */
    const seen = [];
    panel._tabs.commands = { revealNewCommand: (/** @type {string} */ name) => { seen.push(name); return Promise.resolve(true); }, dispose() {} };
    panel._revealNewCommand('standup');
    assert(JSON.stringify(seen) === '["standup"]', `the name must reach the tab, got ${JSON.stringify(seen)}`);
  });

  await run('leaving an edited command asks first, and keeping it stays put', () => withTab(async ({ root, confirms, answerConfirms }) => {
    row(root, 'user:project:mine').click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the editor' });
    row(root, 'builtin:clear').click();
    await waitFor(() => !!detail(root, '.command-page-builtin'), { description: 'an unedited command giving way' });
    assert(confirms.length === 0, 'an unedited command must give way without asking');

    row(root, 'user:project:mine').click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the editor again' });
    type(root, '#cmd-template', 'edited');
    answerConfirms(false);
    row(root, 'builtin:clear').click();
    await waitFor(() => confirms.length === 1, { description: 'the discard question' });
    assert(detail(root, '#cmd-template')?.value === 'edited', 'keeping the edit must leave the editor as it was');
    assert(row(root, 'user:project:mine').classList.contains('selected'), 'keeping the edit must keep the selection');

    answerConfirms(true);
    row(root, 'builtin:clear').click();
    await waitFor(() => !!detail(root, '.command-page-builtin'), { description: 'the discarded edit giving way' });
    assert(confirms.length === 2, `discarding must have asked once more, asked ${confirms.length}`);
  }));

  await run('a change made elsewhere re-reads the list, and an edit in progress survives it', () => withTab(async ({ root, setList }) => {
    row(root, 'user:project:mine').click();
    await waitFor(() => !!detail(root, '#cmd-name'), { description: 'the editor' });
    type(root, '#cmd-template', 'mid-edit');
    setList([userDef('mine', 'project'), userDef('arrived', 'user')]);
    await commandRegistry.refreshUserCommands();
    await waitFor(() => !!root.querySelector('[data-key="user:user:arrived"]'), { description: 'the new command in the list' });
    assert(!root.querySelector('[data-key="user:project:broken"]'), 'a command whose file went must leave the list');
    assert(detail(root, '#cmd-template')?.value === 'mid-edit', 'the edit in progress must survive the re-read');
  }));

  await run('a draft survives the panel closing', async () => {
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(panel);
    try {
      const nameField = /** @type {HTMLInputElement} */ (document.createElement('input'));
      nameField.type = 'text';
      nameField.className = 'field-input command-editor-input';
      nameField.value = 'draft-name';
      const secret = /** @type {HTMLInputElement} */ (document.createElement('input'));
      secret.type = 'text';
      secret.value = 'sk-123';
      panel.querySelector('#commands-tab-root').append(nameField, secret);
      panel.close();
      assert(secret.value === '', 'precondition: the panel blanks an ordinary text field on close');
      assert(nameField.value === 'draft-name', 'the command editor\'s fields must be left as typed');
    } finally {
      panel.remove();
    }
  });

  await run('a delete from the editor clears the selection', () => withTab(async ({ root, writes, setList, answerConfirms }) => {
    row(root, 'user:user:everywhere').click();
    await waitFor(() => !!detail(root, '#cmd-delete'), { description: 'the editor' });
    answerConfirms(true);
    setList([userDef('mine', 'project')]);
    detail(root, '#cmd-delete').click();
    await waitFor(() => writes.length === 1, { description: 'the delete' });
    assert(writes[0]?.method === 'DELETE' && writes[0]?.url === '/api/user-commands/user/everywhere', `sent ${JSON.stringify(writes[0])}`);
    await waitFor(() => !!detail(root, '.command-page-intro'), { description: 'the pane with nothing selected' });
    assert(!root.querySelector('[data-key="user:user:everywhere"]'), 'the deleted command must leave the list');
  }));

  await run('en-XA: the page draws no plain English', () => underPseudoLocale('commands-tab-test', () => withTab(async ({ root }) => {
    /** @type {{where: string, text: string}[]} */
    const said = [];
    // Command names, descriptions and errors are data the stand-ins supplied.
    const data = '.command-page-row, #command-page-detail h2, .command-page-builtin-label, .command-page-builtin-desc, .command-page-builtin-ext';
    const collect = (/** @type {string} */ where) => {
      for (const text of shownStrings(root, data)) said.push({ where, text });
    };
    collect('list + intro');
    const filter = /** @type {HTMLInputElement} */ (root.querySelector('#command-page-filter'));
    filter.value = 'zzzz';
    filter.dispatchEvent(new Event('input'));
    collect('filtered to nothing');
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    row(root, 'builtin:alpha').click();
    await waitFor(() => !!detail(root, '.command-page-builtin'), { description: 'the built-in detail' });
    collect('built-in');
    // The extension's name is data, the sentence around it is not.
    assert(!!detail(root, '.command-page-builtin-source .command-page-builtin-ext'), 'the built-in must name its extension');

    assert(said.length >= 6, `the page drew too little: ${JSON.stringify(said)}`);
    const raw = said.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  })));

  return { passed, failed, errors };
}
