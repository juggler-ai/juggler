//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: send-time guard for an unavailable selected provider.
 *
 * Model selection is sticky and orthogonal to provider enablement: a
 * conversation can already be sitting on (say) a Claude Code model when the
 * user later disables that provider, and nothing retargets the existing
 * selection. The model picker blocks *selecting* a disabled provider, but only
 * on a click — so a stale selection would otherwise sail straight to the
 * backend, which rejects it with a developer string ("provider X is not
 * enabled"). Conversation.sendMessage preflights the selected provider against
 * providersCache and, when it is positively unavailable, refuses the turn and
 * surfaces the same fix the picker offers (auth hint + jump to settings).
 *
 * These tests drive that guard directly: the refusal path (disabled provider)
 * and the allow path (an available provider must NOT be false-refused).
 * @module integration-tests/model-availability-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * A turn whose selected model belongs to a disabled provider is refused at the
 * send site — no worker turn starts, the actionable dialog is shown, and the
 * user's message is preserved (sendMessage returns the refusal sentinel).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const sendRefusedWhenProviderDisabledTest = {
  name: 'send-refused-when-provider-disabled',
  description: 'Sending with a disabled-provider model is refused with the actionable dialog; no turn runs',
  fixture: 'unit-test-fixture',
  llmResponses: [],
  operations: [],

  /**
   * @param {any} conversation The conversation under test.
   * @param {{harness: any}} _ctx Unused harness context.
   */
  async customAssertions(conversation, _ctx) {
    const wsService = (await import('../../js/services/websocket.js')).default;
    const providersCache = (await import('../../js/services/providers-cache.js')).default;
    const recentModels = (await import('../../js/services/recent-models.js')).default;
    const { registerUiPort, uiPort } = await import('../../js/services/ui-port.js');
    const { registerSettingsOpener } = await import('../../js/services/settings-launcher.js');

    const prior = providersCache.get();
    const priorRecord = recentModels.record;

    /** @type {string[]} */
    const confirmMessages = [];
    let openSettingsCalls = 0;
    let recentRecordCalls = 0;
    const restorePort = registerUiPort({
      ...(uiPort() || /** @type {any} */ ({})),
      confirm: (/** @type {string} */ message) => {
        confirmMessages.push(message);
        return Promise.resolve(false); // user dismisses
      },
    });
    const restoreOpener = registerSettingsOpener(() => { openSettingsCalls++; });
    recentModels.record = /** @type {any} */ (() => {
      recentRecordCalls++;
      return Promise.resolve();
    });

    try {
      wsService._emit('providers-update', [
        {
          name: 'gone-co',
          displayName: 'Gone Co',
          authHint: 'Provider disabled',
          available: false,
          modelsWithContext: []
        }
      ]);
      conversation.setModelConfig({ provider: 'gone-co', model: 'gone-1' });

      const sinceTurns = conversation.completedTurns;
      const result = await conversation.sendMessage('please run something');

      if (result !== 'provider unavailable') {
        throw new Error(`expected sendMessage to refuse with 'provider unavailable'; got ${JSON.stringify(result)}`);
      }
      if (confirmMessages.length !== 1) {
        throw new Error(`expected exactly one selection-problem dialog; got ${confirmMessages.length}`);
      }
      if (!confirmMessages[0].includes('Gone Co') || !confirmMessages[0].includes('not available')) {
        throw new Error(`dialog must name the provider and say it is unavailable; got: ${confirmMessages[0]}`);
      }
      if (!confirmMessages[0].includes('Provider disabled')) {
        throw new Error(`dialog must surface the provider auth hint; got: ${confirmMessages[0]}`);
      }
      if (openSettingsCalls !== 0) {
        throw new Error('openSettings must not be called when the user dismisses the dialog');
      }
      if (conversation.completedTurns !== sinceTurns) {
        throw new Error(`no turn may run for a disabled provider; completedTurns moved ${sinceTurns} -> ${conversation.completedTurns}`);
      }
      if (conversation.isProcessing) {
        throw new Error('conversation must not enter processing when the send is refused');
      }
      if (recentRecordCalls !== 0) {
        throw new Error(`a refused send must not promote the selected model; got ${recentRecordCalls} calls`);
      }
    } finally {
      recentModels.record = priorRecord;
      restorePort();
      restoreOpener();
      wsService._emit('providers-update', prior);
    }
  }
};

/**
 * The guard must not false-refuse: a model whose provider is present and
 * available in the cache sends normally and the turn completes.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const sendAllowedWhenProviderAvailableTest = {
  name: 'send-allowed-when-provider-available',
  description: 'A model on an available provider is not false-refused; the turn completes',
  fixture: 'unit-test-fixture',
  llmResponses: [
    textResponse('it works now')
  ],
  operations: [],

  /**
   * @param {any} conversation The conversation under test.
   * @param {{harness: any}} ctx Harness context for driving the mock turn.
   */
  async customAssertions(conversation, ctx) {
    const harness = ctx.harness;
    const wsService = (await import('../../js/services/websocket.js')).default;
    const providersCache = (await import('../../js/services/providers-cache.js')).default;
    const recentModels = (await import('../../js/services/recent-models.js')).default;

    const prior = providersCache.get();
    const priorRecord = recentModels.record;
    /** @type {any[][]} */
    const recorded = [];
    recentModels.record = /** @type {any} */ ((...args) => {
      recorded.push(args);
      return Promise.resolve();
    });
    try {
      wsService._emit('providers-update', [
        {
          name: 'live-co',
          displayName: 'Live Co',
          available: true,
          modelsWithContext: [
            { id: 'live-1', contextWindow: 200000, maxOutputTokens: 8192, fromAPI: false }
          ]
        }
      ]);
      conversation.setModelConfig({ provider: 'live-co', model: 'live-1', thinking: 'high' });
      if (recorded.length !== 0) {
        throw new Error('selecting a model must not promote it before use');
      }

      const sinceTurns = conversation.completedTurns;
      harness.consumeResponse();
      const result = await conversation.sendMessage('go ahead');
      if (result) {
        throw new Error(`send must be allowed for an available provider; got refusal ${JSON.stringify(result)}`);
      }
      if (recorded.length !== 1 || recorded[0][0] !== 'live-co'
          || recorded[0][1] !== 'live-1' || recorded[0][2] !== 'high') {
        throw new Error(`accepted send must promote its exact model configuration; got ${JSON.stringify(recorded)}`);
      }
      await harness.awaitPendingSend();
      await harness.waitForTurnComplete(6000, sinceTurns);
      if (!(conversation.completedTurns > sinceTurns)) {
        throw new Error(`turn should complete for an available provider; completedTurns ${sinceTurns} -> ${conversation.completedTurns}`);
      }
    } finally {
      recentModels.record = priorRecord;
      wsService._emit('providers-update', prior);
    }
  }
};

export const tests = [
  sendRefusedWhenProviderDisabledTest,
  sendAllowedWhenProviderAvailableTest
];
