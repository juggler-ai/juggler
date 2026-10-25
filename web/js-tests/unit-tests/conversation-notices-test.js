//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The refusals a conversation gives when a send or a continue cannot go
 * through (`model/conversation.js`, `model/conversation-orchestration.js`),
 * and three small messages shown beside them: the preset store's fallback
 * errors (`services/system-prompt-presets.js`), the clipboard's explanation
 * (`sdk/lib/clipboard.js`) and the window-title placeholder
 * (`utils/window-title.js`). Each must read exactly as before in English and
 * follow the UI language, with names, roots and hints carried through as data.
 *
 * The conversation is a stand-in carrying only what each refusal reads, and
 * every module-level table those refusals consult (strategies, providers, the
 * worker, the action executor, the preset API, the confirm dialog) is swapped
 * for the walk and put back after it.
 * @module unit-tests/conversation-notices-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import Conversation from '../../js/model/conversation.js';
import { continueThread } from '../../js/model/conversation-orchestration.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import providersCache from '../../js/services/providers-cache.js';
import workerManager from '../../js/services/worker-manager.js';
import actionExecutor from '../../js/services/action-executor.js';
import apiService from '../../js/services/api.js';
import {
  saveUserPreset, deleteUserPreset, updateUserPreset, setDefaultPreset,
} from '../../js/services/system-prompt-presets.js';
import { clipboardUnavailableMessage } from '../../sdk/lib/clipboard.js';
import { windowTitleForProject } from '../../js/utils/window-title.js';
import { registerUiPort, uiPort } from '../../js/services/ui-port.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Replace `obj[key]` for the walk; the returned function puts it back exactly,
 * deleting an own property that was not there before.
 * @param {any} obj
 * @param {string} key
 * @param {any} value
 * @returns {() => void} The restorer
 */
function swap(obj, key, value) {
  const own = Object.prototype.hasOwnProperty.call(obj, key);
  const prior = obj[key];
  obj[key] = value;
  return () => {
    if (own) obj[key] = prior;
    else delete obj[key];
  };
}

/** The `Can't send: …` tail every workspace refusal ends with. */
const BANNER = ' Choose where it should work in the banner above the transcript.';

/**
 * Every message the walk draws, in English, by where it was drawn. Data is
 * digits so it reads as data under en-XA.
 */
const ENGLISH = {
  'no strategy': "Can't start a conversation — the core Juggler extension is turned off. Re-enable it in Extensions settings to continue.",
  'no provider: message': 'No AI provider is configured yet — add an API key (or enable Claude Code) in Provider Settings to start chatting.',
  'no provider: title': 'No provider configured',
  'no provider: confirm': 'Go to provider settings',
  'no provider: cancel': 'Cancel',
  'unavailable with hint: message': "Can't send: 7 is not available — 8. Re-enable it in Provider Settings or pick another model.",
  'unavailable with hint: title': 'Model unavailable',
  'unavailable with hint: confirm': 'Go to provider settings',
  'unavailable with hint: cancel': 'Cancel',
  'unavailable without hint: message': "Can't send: 7 is not available. Re-enable it in Provider Settings or pick another model.",
  'unavailable without hint: title': 'Model unavailable',
  'unavailable without hint: confirm': 'Go to provider settings',
  'unavailable without hint: cancel': 'Cancel',
  'stranded, root known': "Can't send: 7 can only work on this computer, but this conversation works in /9. Pick a model that isn't tied to this computer.",
  'stranded, root unknown': "Can't send: 7 can only work on this computer, but this conversation works in a remote workspace. Pick a model that isn't tied to this computer.",
  'workspace unrecorded': "Can't send: Juggler has no record of this conversation's workspace." + BANNER,
  'workspace closed by someone': "Can't send: 6 closed the workspace 5." + BANNER,
  'workspace closed by a placeholder name': "Can't send: Untitled 3 closed the workspace 5." + BANNER,
  'workspace closed by nobody named': "Can't send: the workspace 5 was closed." + BANNER,
  'workspace closed, no label': "Can't send: this conversation's workspace was closed." + BANNER,
  'workspace moved, labelled': "Can't send: the folder for the workspace 5 can't be found." + BANNER,
  'workspace moved, by root': "Can't send: the folder for the workspace /4 can't be found." + BANNER,
  'workspace moved, no label': "Can't send: the folder for this conversation's workspace can't be found." + BANNER,
  'worker not ready': 'Still connecting to the engine — try again in a moment.',
  'worker lost after preempt': 'Still connecting to the engine — try again in a moment.',
  'continue, worker not ready': 'Still connecting to the engine — try again in a moment.',
  'turn cancelled': 'Stopped the turn that was running.',
  'preset save': "Couldn't save preset",
  'preset delete': "Couldn't delete preset",
  'preset update': "Couldn't update preset",
  'preset default': "Couldn't set default preset",
  'clipboard insecure': "Couldn't copy: browsers only allow clipboard access on secure (https://) pages, localhost, or the Juggler desktop app — and this page is served over plain http (1.2.3.4:5). Open Juggler in the desktop app, or browse over https/localhost, to copy.",
  'clipboard insecure, no host': "Couldn't copy: browsers only allow clipboard access on secure (https://) pages, localhost, or the Juggler desktop app — and this page is served over plain http (this page). Open Juggler in the desktop app, or browse over https/localhost, to copy.",
  'clipboard blocked': "Couldn't copy: this browser blocked clipboard access. Make sure the page has focus and that clipboard permissions aren't denied for 1.2.3.4:5.",
  'clipboard blocked, no host': "Couldn't copy: this browser blocked clipboard access. Make sure the page has focus and that clipboard permissions aren't denied for this page.",
  'window title, no project': 'Juggler - New Window',
};

/** Data each en-XA message must still carry. */
const CARRIES = /** @type {Record<string, string>} */ ({
  'unavailable with hint: message': '8',
  'stranded, root known': '/9',
  'workspace closed by someone': '6',
  'workspace moved, by root': '/4',
  'clipboard insecure': '1.2.3.4:5',
  'clipboard blocked': '1.2.3.4:5',
});

/**
 * A conversation stand-in for `sendMessage`'s refusals: the real prototype,
 * with the getters it consults pinned on the instance.
 * @param {object} state
 * @param {any} [state.modelConfig]
 * @param {string} [state.workspaceId]
 * @param {string|null} [state.workspaceRoot]
 * @param {boolean} [state.hostsLocal]
 * @param {any} [state.workspace] - What the session's table answers for the id.
 * @param {string[]} shown - Where `showWarning` writes.
 * @returns {any} The stand-in
 */
function standIn({ modelConfig = null, workspaceId = '', workspaceRoot = null, hostsLocal = true, workspace = null }, shown) {
  const conv = Object.create(Conversation.prototype);
  const pin = (/** @type {string} */ key, /** @type {any} */ value) =>
    Object.defineProperty(conv, key, { value, writable: true, configurable: true });
  pin('id', `CONV_NOTICES_${Math.random().toString(36).slice(2)}`);
  pin('modelConfig', modelConfig);
  pin('workspaceId', workspaceId);
  pin('workspaceRoot', workspaceRoot);
  pin('workspaceHostsLocalProviders', hostsLocal);
  pin('_session', { getWorkspace: () => workspace });
  pin('_workerManager', workerManager);
  pin('showWarning', (/** @type {string} */ m) => { shown.push(m); });
  return conv;
}

/**
 * Walk every refusal and message once, with every table it reads swapped, and
 * return what each drew.
 * @returns {Promise<{texts: Record<string, string>, returns: Record<string, any>}>} Drawn text and status returns
 */
async function walk() {
  /** @type {Record<string, string>} */
  const texts = {};
  /** @type {Record<string, any>} */
  const returns = {};

  let hasStrategy = true;
  let received = true;
  let settled = true;
  let anyAvailable = true;
  /** @type {any[]} */
  let providers = [];
  /** @type {(id: string) => boolean} */
  let workerReady = () => false;
  /** @type {any[]} */
  const confirms = [];

  const restorers = [
    swap(strategyRegistry, 'hasAnyStrategy', () => hasStrategy),
    swap(providersCache, 'hasReceived', () => received),
    swap(providersCache, 'isReady', () => settled),
    swap(providersCache, 'hasAvailableProvider', () => anyAvailable),
    swap(providersCache, 'get', () => providers),
    swap(workerManager, 'isWorkerReady', (/** @type {string} */ id) => workerReady(id)),
    swap(actionExecutor, 'hasRunningActionsFor', () => false),
    registerUiPort({
      ...(uiPort() || /** @type {any} */ ({})),
      confirm: async (/** @type {string} */ message, /** @type {string|undefined} */ title, /** @type {any} */ opts) => {
        confirms.push({ message, title, confirmText: opts?.confirmText, cancelText: opts?.cancelText });
        return false;
      },
    }),
    swap(apiService, 'saveSystemPromptPreset', async () => ({ success: false })),
    swap(apiService, 'deleteSystemPromptPreset', async () => ({ success: false })),
    swap(apiService, 'updateSystemPromptPreset', async () => ({ success: false })),
    swap(apiService, 'setDefaultSystemPromptPreset', async () => ({ success: false })),
  ];

  /**
   * Send '1' from a stand-in and record what it said.
   * @param {string} where
   * @param {any} state
   * @param {any} [options]
   * @param {(conv: any) => void} [prepare]
   */
  const send = async (where, state, options = {}, prepare) => {
    /** @type {string[]} */
    const shown = [];
    const conv = standIn(state, shown);
    prepare?.(conv);
    returns[where] = await conv.sendMessage('1', null, undefined, { interpretCommands: false, consumeComposer: false, ...options });
    texts[where] = shown.join(' | ');
  };

  /**
   * Send into a refusal answered by the confirm dialog, recording all four of its parts.
   * @param {string} where
   * @param {any} state
   */
  const sendToConfirm = async (where, state) => {
    confirms.length = 0;
    await send(`${where}: message`, state);
    const asked = confirms[0] || {};
    texts[`${where}: message`] = asked.message;
    texts[`${where}: title`] = asked.title;
    texts[`${where}: confirm`] = asked.confirmText;
    texts[`${where}: cancel`] = asked.cancelText;
  };

  try {
    hasStrategy = false;
    await send('no strategy', {});
    hasStrategy = true;

    received = true;
    anyAvailable = false;
    await sendToConfirm('no provider', {});
    // The connect seed: a list has arrived, but not the settled one, so its
    // emptiness says nothing about what is configured yet.
    settled = false;
    await send('no provider, list not yet settled', {});
    settled = true;
    anyAvailable = true;

    const model = { provider: 'p7', model: 'm7' };
    providers = [{ name: 'p7', displayName: '7', available: false, authHint: '8' }];
    await sendToConfirm('unavailable with hint', { modelConfig: model });
    providers = [{ name: 'p7', displayName: '7', available: false, authHint: '  ' }];
    await sendToConfirm('unavailable without hint', { modelConfig: model });

    providers = [{ name: 'p7', displayName: '7', available: true, spawnsLocalProcess: true }];
    await send('stranded, root known', { modelConfig: model, hostsLocal: false, workspaceRoot: '/9' });
    await send('stranded, root unknown', { modelConfig: model, hostsLocal: false, workspaceRoot: null });
    providers = [];

    const bound = (/** @type {any} */ workspace) => ({ workspaceId: 'w1', workspaceRoot: null, workspace });
    await send('workspace unrecorded', bound(null));
    await send('workspace closed by someone', bound({ state: 'closed', label: '5', meta: { closedBy: '6' } }));
    await send('workspace closed by a placeholder name', bound({ state: 'closed', label: '5', meta: { closedBy: 'Untitled 3' } }));
    await send('workspace closed by nobody named', bound({ state: 'closed', label: '5', meta: {} }));
    await send('workspace closed, no label', bound({ state: 'closed', meta: { closedBy: '' } }));
    await send('workspace moved, labelled', bound({ state: 'active', label: '5' }));
    await send('workspace moved, by root', bound({ state: 'active', root: '/4' }));
    await send('workspace moved, no label', bound({ state: 'active' }));

    workerReady = () => false;
    await send('worker not ready', {});

    // Ready for the first look, gone by the time the preempting cancel is over.
    let looks = 0;
    workerReady = () => looks++ === 0;
    await send('worker lost after preempt', {}, { preemptProcessing: true }, (conv) => {
      conv.cancelAndSettle = async () => {};
      conv.isThreadProcessing = () => false;
      conv._targetThreadId = () => null;
      conv.ensureInitialised = async () => {};
      conv.announceTurnRequested = () => {};
      conv.restorePendingMessage = () => {};
    });
    workerReady = () => false;

    {
      /** @type {string[]} */
      const shown = [];
      const conv = { id: 'CONV_NOTICES_CONTINUE', announceTurnRequested: () => {}, showWarning: (/** @type {string} */ m) => { shown.push(m); } };
      const thread = { isProcessing: false, hasBusyItems: () => false, cancelPendingApprovals: () => {}, threadItemId: null };
      returns['continue, worker not ready'] = await continueThread(/** @type {any} */ (conv), /** @type {any} */ (thread));
      texts['continue, worker not ready'] = shown.join(' | ');
    }

    {
      /** @type {string[]} */
      const shown = [];
      const conv = standIn({}, shown);
      let active = 1;
      conv.isTurnActive = () => active-- > 0;
      conv.stopProcessing = () => {};
      await conv.cancelAndSettle('test');
      texts['turn cancelled'] = shown.join(' | ');
    }

    /**
     * @param {string} where
     * @param {() => Promise<any>} call
     */
    const failure = async (where, call) => {
      try {
        await call();
        texts[where] = '(did not throw)';
      } catch (e) {
        texts[where] = e instanceof Error ? e.message : String(e);
      }
    };
    await failure('preset save', () => saveUserPreset('1', '2'));
    await failure('preset delete', () => deleteUserPreset('1'));
    await failure('preset update', () => updateUserPreset('1', '2', '3'));
    await failure('preset default', () => setDefaultPreset('1'));

    const page = (/** @type {boolean} */ secure, /** @type {string} */ host) =>
      /** @type {any} */ ({ isSecureContext: secure, location: { host, protocol: secure ? 'https:' : 'http:' } });
    texts['clipboard insecure'] = /** @type {any} */ (clipboardUnavailableMessage)(page(false, '1.2.3.4:5'));
    texts['clipboard insecure, no host'] = /** @type {any} */ (clipboardUnavailableMessage)(page(false, ''));
    texts['clipboard blocked'] = /** @type {any} */ (clipboardUnavailableMessage)(page(true, '1.2.3.4:5'));
    texts['clipboard blocked, no host'] = /** @type {any} */ (clipboardUnavailableMessage)(page(true, ''));

    texts['window title, no project'] = windowTitleForProject('');
    texts['window title, a project'] = windowTitleForProject('/1/2');
  } finally {
    for (const restore of restorers.reverse()) restore();
  }
  return { texts, returns };
}

/** The status each refusal returns: identifiers, the same in every language. */
const RETURNS = {
  'no strategy': 'no strategy enabled',
  'no provider: message': 'no provider configured',
  'no provider, list not yet settled': 'worker not ready',
  'unavailable with hint: message': 'provider unavailable',
  'stranded, root known': 'provider cannot reach this workspace',
  'workspace unrecorded': 'workspace cannot be worked in',
  'workspace moved, no label': 'workspace cannot be worked in',
  'worker not ready': 'worker not ready',
  'worker lost after preempt': 'worker not ready',
  'continue, worker not ready': false,
};

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
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
    const priorWarn = console.warn;
    console.warn = () => {};
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      console.warn = priorWarn;
    }
  };

  await run('English: every refusal and message reads as it always has', async () => {
    const { texts, returns } = await walk();
    /** @type {string[]} */
    const problems = [];
    for (const [where, expected] of Object.entries(ENGLISH)) {
      if (texts[where] !== expected) problems.push(`${where}: got ${JSON.stringify(texts[where])}`);
    }
    if (texts['window title, a project'] !== 'Juggler - 2') {
      problems.push(`window title, a project: got ${JSON.stringify(texts['window title, a project'])}`);
    }
    for (const [where, expected] of Object.entries(RETURNS)) {
      if (returns[where] !== expected) problems.push(`${where} returned ${JSON.stringify(returns[where])}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await run('en-XA: every refusal and message follows the UI language', async () => {
    /** @type {{texts: Record<string, string>, returns: Record<string, any>}} */
    let result = { texts: {}, returns: {} };
    await underPseudoLocale('conversation-notices-test', async () => {
      result = await walk();
    });
    const { texts, returns } = result;
    /** @type {string[]} */
    const problems = [];
    for (const where of Object.keys(ENGLISH)) {
      const text = texts[where];
      if (typeof text !== 'string' || !text) { problems.push(`${where}: nothing drawn`); continue; }
      const carried = CARRIES[where];
      if (carried && !text.includes(carried)) problems.push(`${where}: lost ${carried}: ${JSON.stringify(text)}`);
      // The host is data with letters in it once mapped; take it out before judging.
      const judged = carried ? text.split(carried).join('0') : text;
      if (!isPseudoLocalized(judged)) problems.push(`${where}: plain English: ${JSON.stringify(text)}`);
    }
    if (/Untitled/.test(texts['workspace closed by a placeholder name'] || '')) {
      problems.push(`the placeholder name was drawn in English: ${JSON.stringify(texts['workspace closed by a placeholder name'])}`);
    }
    // The title is one message, product name and separator included, so a
    // translation may reorder it; only the project's directory name is fixed.
    const projectTitle = texts['window title, a project'] || '';
    if (!isPseudoLocalized(projectTitle.split('2').join('0')) || !projectTitle.includes('2')) {
      problems.push(`window title, a project: got ${JSON.stringify(projectTitle)}`);
    }
    for (const [where, expected] of Object.entries(RETURNS)) {
      if (returns[where] !== expected) problems.push(`${where} returned ${JSON.stringify(returns[where])}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  return { passed, failed, errors };
}
