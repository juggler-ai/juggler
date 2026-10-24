//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command editor tests — the model override, from file to picker and back.
 *
 * The dialog now hosts the same `<model-chip>` + `<model-picker>` pair the
 * composer and settings use, and a model reference is four fields, not one. The
 * failure worth guarding is invisible: a dial dropped between the picker and the
 * PUT leaves a command that reads correctly in the editor and runs at settings
 * nobody chose. So these assert the whole reference survives each hop — the
 * file's into the chip, the picker's into the request — and that overrides are
 * written only while the command still opens a thread.
 * @module unit-tests/command-editor-test
 */

import { assert, neutralizeStrayOverlays, waitFor } from '../utilities/test-helpers.js';
import { assertDialogPopover } from '../utilities/menu-assertions.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { openCommandEditor, openCommandManager } from '../../js/components/command-editor-dialog.js';
import { buildModelConfig } from '../../js/model/model-config.js';
import providersCache from '../../js/services/providers-cache.js';
import { fetchUserCommands, resetUserCommandsCache } from '../../js/services/user-commands.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import commandRegistry from '../../js/registries/command-registry.js';
import { reloadRegistries, whenRegistriesSettled, anyLocalConversationBusy } from '../../js/registries/reload-registries.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** One provider, one tiered thinking-capable model and one plain one. */
const PROVIDERS = [{
  name: 'p',
  displayName: 'Provider',
  available: true,
  modelsWithContext: [
    {
      id: 'm',
      displayName: 'Model',
      contextWindow: 1000,
      thinkingLevels: ['low', 'high'],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    },
    { id: 'other', displayName: 'Other', contextWindow: 1000 },
  ],
}];

/** A saved sub-thread command carrying a complete model reference. */
const DEF = {
  name: 'review',
  scope: /** @type {'project'} */ ('project'),
  path: '/x/.juggler/commands/review.md',
  frontmatter: {
    description: 'Review a PR',
    run: 'subthread',
    provider: 'p',
    model: 'm',
    thinking: 'high',
    serviceTier: 'priority',
    goal: 'PR review',
  },
  body: 'Review $1',
};

/**
 * A recorded request.
 * @typedef {{url: string, method: string, body: any}} Call
 */

/**
 * Record the command writes rather than sending them, and stand a provider list
 * in for the server-pushed one.
 *
 * Only `/api/user-commands` is answered here; everything else is passed to the
 * real fetch. Saving a command rebuilds the capability registries, and that
 * rebuild refetches the extension catalog: handed this stub's canned command
 * response instead, it caches an EMPTY catalog, and every registry in the lane's
 * shared realm is left empty and marked initialized for the suites that follow.
 * (The rebuild also outlives the save that started it — the suite runner waits
 * it out; see `whenRegistriesSettled`.)
 * @returns {{calls: Call[], restore: () => void}} The harness.
 */
function stubEnvironment() {
  /** @type {Call[]} */
  const calls = [];
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (!String(url).startsWith('/api/user-commands')) return originalFetch.call(window, url, init);
    return { ok: true, status: 200, json: async () => ({ name: DEF.name, scope: DEF.scope, path: DEF.path }) };
  });

  const realGet = providersCache.get;
  const realHasReceived = providersCache.hasReceived;
  providersCache.get = () => /** @type {any} */ (PROVIDERS);
  providersCache.hasReceived = () => true;

  return {
    calls,
    restore: () => {
      window.fetch = originalFetch;
      providersCache.get = realGet;
      providersCache.hasReceived = realHasReceived;
    },
  };
}

/**
 * Open the editor on {@link DEF} and hand back its parts.
 * @returns {{done: Promise<any>, overlay: any, chip: any, save: HTMLElement}} The open dialog.
 */
function openEditor() {
  const done = openCommandEditor({ def: /** @type {any} */ (DEF) });
  const overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
  assert(!!overlay, 'the editor must mount an overlay');
  return {
    done,
    overlay,
    chip: overlay.querySelector('#cmd-model'),
    save: overlay.querySelector('#cmd-save'),
  };
}

/**
 * The PUT the dialog sent.
 * @param {Call[]} calls
 * @returns {any} The request body.
 */
function putBody(calls) {
  const put = calls.find((c) => c.method === 'PUT');
  assert(!!put, `saving must PUT the command, got ${JSON.stringify(calls.map((c) => c.method + ' ' + c.url))}`);
  assert(put.url === '/api/user-commands/project/review', `PUT url = ${put.url}`);
  return put.body;
}

/**
 * @param {number} status
 * @param {any} data
 * @returns {Response} A JSON response.
 */
const jsonResponse = (status, data) => new window.Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

/**
 * A valid user-scope command as the server lists it.
 * @param {string} name
 * @returns {import('../../js/services/user-commands.js').UserCommandDef} The definition.
 */
const userDef = (name) => ({
  name, scope: 'user', path: `/home/.juggler/commands/${name}.md`, frontmatter: { description: `the ${name} command` }, body: 'hi',
});

/**
 * Answer `/api/user-commands` from `list()` (and accept any write), passing
 * everything else to the real fetch — the extension catalog included, since a
 * registry rebuild that read a canned answer for it would leave the lane's
 * registries empty.
 * @param {() => any[]} list - The command list the server reports right now.
 * @param {() => void} [onWrite] - Called on a PUT or DELETE.
 * @returns {() => void} Restores the real fetch.
 */
function serveUserCommands(list, onWrite = () => {}) {
  const originalFetch = window.fetch;
  window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    if (!String(input).startsWith('/api/user-commands')) return originalFetch.call(window, input, init);
    const method = init?.method || 'GET';
    if (method !== 'GET') {
      onWrite();
      return jsonResponse(200, {});
    }
    return jsonResponse(200, list());
  });
  return () => { window.fetch = originalFetch; };
}

/**
 * Run `body` while a conversation the registries can see is mid-turn — the state
 * a full registry rebuild waits out. The turn ends (and says so) afterwards.
 * @param {() => Promise<void>} body
 * @returns {Promise<void>}
 */
async function duringTurn(body) {
  const g = /** @type {any} */ (globalThis);
  const hadEngineApp = Object.prototype.hasOwnProperty.call(g, 'engineApp');
  const previousEngineApp = g.engineApp;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const turn = {
    processingState: { status: 'streaming' },
    isAwaitingApproval: () => false,
    onDocumentChange: (/** @type {() => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  g.engineApp = { getSession: () => ({ conversations: new Map([['conv-1', turn]]), events: { subscribe: () => () => {} } }) };
  try {
    assert(anyLocalConversationBusy(), 'precondition: the stand-in turn must count as running');
    await body();
  } finally {
    turn.processingState.status = 'idle';
    for (const fn of [...listeners]) fn();
    if (hadEngineApp) g.engineApp = previousEngineApp;
    else delete g.engineApp;
  }
}

/**
 * @param {string} name
 * @returns {boolean} Whether the slash menu offers `/name`.
 */
const offered = (name) => slashCommandHandler.getCommands().some((c) => c.name === name);

const STRATEGY_EXT = '@test/command-editor-strategies';
const STRATEGY_ID = 'stand-in-strategy';
const STRATEGY_NAME = 'Stand In Strategy';

/**
 * Data the dialogs show inside their messages — command names, template
 * syntax, paths — mapped to a digit so only the message's own words are judged.
 * @param {string} s
 * @returns {string} The string with its data replaced.
 */
const dataToDigits = (s) => String(s).replace(/\$ARGUMENTS|\$\$|\$[19]|qq|qr|zz|ok/g, '9');

/**
 * Walk every state the editor and the manager draw under en-XA, collecting what
 * each shows, and assert once at the end. Every collaborator the dialogs read
 * is stubbed for the walk only: the commands endpoint, the providers cache, the
 * built-in command list, the strategy registry (pinned to a stand-in strategy
 * under a stand-in extension) and the modal presenter.
 * @returns {Promise<void>}
 */
async function pseudoLocaleWalk() {
  /** @type {{where: string, text: string}[]} */
  const said = [];
  /**
   * @param {string} where
   * @param {Element} root
   * @param {string} [skip]
   */
  const collect = (where, root, skip) => {
    for (const text of shownStrings(root, skip)) said.push({ where, text });
  };
  /**
   * @param {string} where
   * @param {any} text
   */
  const note = (where, text) => { said.push({ where, text: String(text ?? '') }); };

  const originalFetch = window.fetch;
  const originalShowModal = /** @type {any} */ (window).showModal;
  const realGet = providersCache.get;
  const realHasReceived = providersCache.hasReceived;
  const realGetCommands = slashCommandHandler.getCommands;
  const realManifests = strategyRegistry.getAllManifests;
  const realExtensionId = strategyRegistry.getExtensionId;
  /** @type {any[]} */
  const modals = [];
  try {
    await underPseudoLocale('command-editor-test', async () => {
      const json = (/** @type {number} */ status, /** @type {any} */ data) => new window.Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
        const url = String(input);
        if (url.includes('/user-commands')) {
          if (init?.method === 'PUT') return json(500, {});
          if (!init?.method || init.method === 'GET') {
            return json(200, [
              { name: 'qq', scope: 'project', path: '/1', frontmatter: { description: '4' }, body: '' },
              { name: 'qr', scope: 'project', path: '/2', frontmatter: {}, body: '', error: '5' },
            ]);
          }
          return json(200, {});
        }
        return originalFetch(input, init);
      });
      providersCache.get = () => /** @type {any} */ (PROVIDERS);
      providersCache.hasReceived = () => true;
      slashCommandHandler.getCommands = /** @type {any} */ (() => [{ name: 'zz', userDefined: false }]);
      strategyRegistry.getAllManifests = /** @type {any} */ (() => [
        { id: STRATEGY_ID, manifest: { name: STRATEGY_NAME }, modulePath: '(test)', extensionId: STRATEGY_EXT },
      ]);
      strategyRegistry.getExtensionId = (id) => (id === STRATEGY_ID ? STRATEGY_EXT : null);
      /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { modals.push(options); return false; };
      resetUserCommandsCache();

      // ── a new command ─────────────────────────────────────────────────────
      const created = openCommandEditor({});
      let overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
      assert(!!overlay, 'the editor must mount an overlay');
      // The name field's placeholder is an example command name, an identifier.
      const skipNew = '.command-editor-slash, #cmd-name, #cmd-path-hint, #cmd-preview-out';
      collect('new', overlay, skipNew);
      const hint = overlay.querySelector('#cmd-path-hint').textContent;
      // A path is data, so only its placeholder words are judged: left in
      // English, the hint is reported with the rest.
      if (hint.includes('<project>') || hint.includes('/name.md')) note('path hint placeholders', hint);
      for (const value of ['send', 'draft', 'subthread']) {
        overlay.querySelector(`[data-run="${value}"]`).click();
        note(`run hint ${value}`, overlay.querySelector('#cmd-run-hint').textContent);
      }
      const nameInput = overlay.querySelector('#cmd-name');
      nameInput.value = 'Bad';
      nameInput.dispatchEvent(new Event('input'));
      note('bad name', overlay.querySelector('#cmd-name-error').textContent);
      nameInput.value = 'zz';
      nameInput.dispatchEvent(new Event('input'));
      note('reserved name', overlay.querySelector('#cmd-name-error').textContent);

      const chip = overlay.querySelector('#cmd-model');
      chip.dispatchEvent(new CustomEvent('chip-toggle'));
      const picker = /** @type {any} */ (document.querySelector('model-picker'));
      assert(!!picker, 'pressing the chip must open the picker');
      note('picker none label', picker.noneLabel);
      chip.dispatchEvent(new CustomEvent('chip-toggle'));

      nameInput.value = 'ok';
      nameInput.dispatchEvent(new Event('input'));
      overlay.querySelector('#cmd-save').click();
      const templateError = overlay.querySelector('[data-error-for="template"]');
      await waitFor(() => !!templateError.textContent, { description: 'the save failure' });
      note('save failed', templateError.textContent);
      overlay.querySelector('#cmd-close').click();
      await created;

      // ── an existing command ───────────────────────────────────────────────
      const edited = openCommandEditor({
        def: /** @type {any} */ ({ name: 'qq', scope: 'project', path: '/1', frontmatter: { description: '1', run: 'subthread', goal: '2' }, body: '3' }),
      });
      overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
      collect('edit', overlay, `${skipNew}, #cmd-template`);
      overlay.querySelector('#cmd-delete').click();
      await waitFor(() => modals.length === 1, { description: 'the delete confirmation' });
      overlay.querySelector('#cmd-close').click();
      await edited;

      // ── the manager ───────────────────────────────────────────────────────
      const managed = openCommandManager();
      overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
      await waitFor(() => overlay.querySelectorAll('.command-manager-row').length === 2, { description: 'the manager list' });
      collect('manager', overlay, 'code, .command-manager-desc, .command-manager-error');
      overlay.querySelector('.command-manager-delete').click();
      await waitFor(() => modals.length === 2, { description: 'the manager delete confirmation' });
      overlay.querySelector('#cmd-close').click();
      await managed;

      for (const [i, m] of modals.entries()) {
        for (const key of ['title', 'message', 'confirmText', 'cancelText']) note(`confirm ${i} ${key}`, m[key]);
      }
    }, { [STRATEGY_EXT]: [STRATEGY_NAME] });
  } finally {
    window.fetch = originalFetch;
    /** @type {any} */ (window).showModal = originalShowModal;
    providersCache.get = realGet;
    providersCache.hasReceived = realHasReceived;
    slashCommandHandler.getCommands = realGetCommands;
    strategyRegistry.getAllManifests = realManifests;
    strategyRegistry.getExtensionId = realExtensionId;
    resetUserCommandsCache();
  }

  assert(said.some(({ text }) => text.includes('9')), 'the walk must have shown its data');
  assert(said.length >= 30, `the dialogs drew too little: ${JSON.stringify(said)}`);
  const raw = said.filter(({ text }) => !isPseudoLocalized(dataToDigits(text)));
  assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
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
   * Run one test over a freshly stubbed environment, torn down either way.
   * @param {string} label - Test label.
   * @param {(calls: Call[]) => Promise<void>} fn - Test body, given the recorded requests.
   */
  const run = async (label, fn) => {
    const env = stubEnvironment();
    try {
      await fn(env.calls);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      env.restore();
      // Through the sweep, not by removing the element: the overlay holds a
      // popup-manager token that only its own close releases, and a token left
      // registered suppresses every shortcut for the rest of the lane.
      neutralizeStrayOverlays();
      document.querySelector('model-picker')?.remove();
    }
  };

  await run('the chip shows the model the file names', async () => {
    const { done, overlay, save, chip } = openEditor();
    assert(chip?.tagName?.toLowerCase() === 'model-chip', `the model field must be a chip, got ${chip?.tagName}`);
    const config = chip.config;
    assert(config?.provider === 'p' && config?.model === 'm',
      `the chip must show the file's model, got ${JSON.stringify(config)}`);
    assert(config.thinking === 'high' && config.serviceTier === 'priority',
      `the chip must carry both dials, got ${JSON.stringify(config)}`);
    assert((chip.querySelector('.model-name')?.textContent || '').includes('Model'),
      `the button must name the model, got ${JSON.stringify(chip.textContent)}`);
    /** @type {any} */ (save).click();
    await done;
    assert(!overlay.isConnected, 'saving must close the dialog');
  });

  await run('saving writes the whole model reference, dials included', async (calls) => {
    const { done, save } = openEditor();
    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.run === 'subthread', `run = ${body.run}`);
    assert(body.provider === 'p' && body.model === 'm',
      `provider/model = ${body.provider}/${body.model}`);
    assert(body.thinking === 'high', `thinking = ${JSON.stringify(body.thinking)}`);
    assert(body.serviceTier === 'priority', `serviceTier = ${JSON.stringify(body.serviceTier)}`);
  });

  await run('the picker replaces the reference it was opened on', async (calls) => {
    const { done, chip, save } = openEditor();
    chip.dispatchEvent(new CustomEvent('chip-toggle'));
    const picker = /** @type {any} */ (document.querySelector('model-picker'));
    assert(!!picker, 'pressing the chip must open the picker');
    assert(picker.value?.model === 'm', `the picker must open on the current model, got ${JSON.stringify(picker.value)}`);
    assertDialogPopover(picker, chip.button, 'command editor model picker');

    picker.dispatchEvent(new CustomEvent('change', { detail: buildModelConfig('p', 'other', '', '') }));
    assert(chip.button.getAttribute('aria-expanded') === 'false', 'the chip still says open after choosing a model');
    assert(chip.config?.model === 'other', `the chip must follow the picker, got ${JSON.stringify(chip.config)}`);

    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.model === 'other', `model = ${body.model}`);
    // The new model advertises neither dial, so both are cleared rather than
    // carried over from the model that did.
    assert(body.thinking === '' && body.serviceTier === '',
      `dials must not survive a model that lacks them, got ${JSON.stringify(body)}`);
  });

  await run('a command that no longer opens a thread writes no overrides', async (calls) => {
    const { done, overlay, save } = openEditor();
    const sendSegment = /** @type {HTMLElement} */ (overlay.querySelector('[data-run="send"]'));
    assert(!!sendSegment, 'the run mode must be a segmented control');
    sendSegment.click();
    assert(overlay.querySelector('#cmd-subthread-fields')?.classList.contains('hidden'),
      'leaving thread mode must hide the thread overrides');

    /** @type {any} */ (save).click();
    await done;
    const body = putBody(calls);
    assert(body.run === 'send', `run = ${body.run}`);
    assert(body.provider === '' && body.model === '' && body.thinking === '' && body.serviceTier === '',
      `overrides must be cleared with the thread, got ${JSON.stringify(body)}`);
    assert(body.goal === '' && body.strategy === '', `goal/strategy = ${body.goal}/${body.strategy}`);
  });

  // A radiogroup is one tab stop, and the arrows move the choice within it —
  // the keys a native radio set answers to.
  await run('the run mode is a radiogroup the arrow keys drive', async (calls) => {
    const { done, overlay, save } = openEditor();
    const group = /** @type {HTMLElement} */ (overlay.querySelector('#cmd-run'));
    const seg = (/** @type {string} */ v) => /** @type {HTMLElement} */ (group.querySelector(`[data-run="${v}"]`));
    const stops = () => ['send', 'draft', 'subthread'].map(v => seg(v).tabIndex).join(',');
    assert(stops() === '-1,-1,0', `only the checked segment is a tab stop, got ${stops()}`);

    const key = (/** @type {string} */ k) => /** @type {HTMLElement} */ (document.activeElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    seg('subthread').focus();
    key('ArrowRight');
    assert(seg('send').getAttribute('aria-checked') === 'true', 'ArrowRight from the last segment wraps to the first');
    assert(document.activeElement === seg('send'), 'the arrow moves focus with the choice');
    assert(stops() === '0,-1,-1', `the tab stop follows the choice, got ${stops()}`);
    assert(overlay.querySelector('#cmd-subthread-fields')?.classList.contains('hidden'),
      'a choice made from the keyboard reports like a click');
    key('ArrowLeft');
    assert(seg('subthread').getAttribute('aria-checked') === 'true', 'ArrowLeft from the first segment wraps to the last');

    key('ArrowUp');
    /** @type {any} */ (save).click();
    await done;
    assert(putBody(calls).run === 'draft', `run = ${putBody(calls).run}`);
  });

  // A save resets the catalog cache and starts a registry rebuild that outlives
  // it, so a catalog fetch can be in flight across the next reset. Landing after
  // that reset, it must not cache the list it read before it: the next reader —
  // the manager — would be served the stale list instead of re-reading.
  await run('a catalog fetch that straddles a reset does not refill the cache', async () => {
    const originalFetch = window.fetch;
    /** @type {(r: Response) => void} */
    let answerStale = () => {};
    const list = (/** @type {string[]} */ names) => new window.Response(JSON.stringify(
      names.map((name) => ({ name, scope: 'project', path: `/${name}`, frontmatter: {}, body: '' }))), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    try {
      resetUserCommandsCache();
      window.fetch = /** @type {any} */ (() => new Promise((resolve) => { answerStale = resolve; }));
      const stale = fetchUserCommands();
      resetUserCommandsCache();
      window.fetch = /** @type {any} */ (async () => list(['fresh']));
      answerStale(list(['stale']));
      await stale;
      const names = (await fetchUserCommands()).map((d) => d.name);
      assert(JSON.stringify(names) === '["fresh"]', `the read after the reset must be fresh, got ${JSON.stringify(names)}`);
    } finally {
      window.fetch = originalFetch;
      resetUserCommandsCache();
    }
  });

  /**
   * Run one test against the real environment: it stubs only what it needs, and
   * puts the registries back as the server describes them when it is done.
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const runLive = async (label, fn) => {
    try {
      await whenRegistriesSettled();
      await slashCommandHandler.init();
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      neutralizeStrayOverlays();
      await whenRegistriesSettled();
      resetUserCommandsCache();
      await reloadRegistries();
    }
  };

  // A turn holds back the full registry rebuild until it ends, so the tools and
  // strategies it is using never change under it. Nothing in a turn reads the
  // command list, so a command saved mid-turn is offered at once.
  await runLive('a command saved during a turn is offered before the turn ends', async () => {
    let saved = false;
    const restore = serveUserCommands(() => (saved ? [userDef('mid-turn')] : []), () => { saved = true; });
    try {
      await duringTurn(async () => {
        const done = openCommandEditor({ name: 'mid-turn', scope: 'user' });
        const overlay = /** @type {any} */ (document.querySelector('.command-editor-overlay'));
        assert(!!overlay, 'the editor must mount an overlay');
        overlay.querySelector('#cmd-description').value = 'the mid-turn command';
        overlay.querySelector('#cmd-template').value = 'hi';
        overlay.querySelector('#cmd-name').dispatchEvent(new Event('input'));
        overlay.querySelector('#cmd-save').click();
        await done;
        assert(saved, 'saving must write the command');
        await waitFor(() => offered('mid-turn'), { description: 'the saved command in the slash menu while the turn runs' });
      });
    } finally {
      // A rebuild the turn's end released reads the stub too.
      await whenRegistriesSettled();
      restore();
    }
  });

  // A file the define_command tool or an editor writes reaches the viewer as a
  // plugin-changed broadcast, which the same refresh answers. Each refresh
  // replaces the set the last one registered, so a deleted command goes, a
  // repeat (or overlapping) refresh does not collide with itself, and a name a
  // built-in holds is refused for exactly as long as the file claims it.
  await runLive('refreshing user commands replaces the set it registered', async () => {
    const builtin = slashCommandHandler.getCommands().find((c) => !c.userDefined)?.name;
    assert(!!builtin, 'precondition: a built-in command to collide with');
    const BuiltinClass = commandRegistry.get(builtin);
    /** @type {any[]} */
    let listed = [userDef('alpha'), userDef('beta')];
    const restore = serveUserCommands(() => listed);
    const ownFailures = () => commandRegistry.getFailedModules().filter((f) => f.path.startsWith('user-command:'));
    try {
      await duringTurn(async () => {
        await Promise.all([commandRegistry.refreshUserCommands(), commandRegistry.refreshUserCommands()]);
        assert(offered('alpha') && offered('beta'), 'both commands must be offered');
        assert(ownFailures().length === 0, `a repeat refresh must not collide with itself: ${JSON.stringify(ownFailures())}`);

        listed = [userDef('beta')];
        await commandRegistry.refreshUserCommands();
        assert(!offered('alpha') && offered('beta'), 'a command whose file went must go with it');

        listed = [userDef('beta'), userDef(builtin)];
        await commandRegistry.refreshUserCommands();
        assert(commandRegistry.get(builtin) === BuiltinClass, `a user command must not shadow the built-in /${builtin}`);
        assert(ownFailures().length === 1, `the collision must be reported, got ${JSON.stringify(ownFailures())}`);

        listed = [];
        await commandRegistry.refreshUserCommands();
        assert(!offered('beta') && commandRegistry.get(builtin) === BuiltinClass, 'an empty list must leave only the built-ins');
        assert(ownFailures().length === 0, `a collision must clear once its file goes: ${JSON.stringify(ownFailures())}`);
      });
    } finally {
      restore();
    }
  });

  try {
    await pseudoLocaleWalk();
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: every state of the editor and the manager is translated: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    neutralizeStrayOverlays();
    document.querySelector('model-picker')?.remove();
  }

  return { passed, failed, errors };
}
