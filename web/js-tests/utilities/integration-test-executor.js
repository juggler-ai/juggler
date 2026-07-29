//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Test Executor
 *
 * Browser-side orchestration for running integration tests.
 * Called by the test page to execute tests and report results.
 * @module integration/integration-test-executor
 */

import { runIntegrationTests } from './integration-test-runner.js';
import { tests as readFileTests } from '../integration-tests/read-file-tests.js';
import { tests as writeFileTests } from '../integration-tests/write-file-tests.js';
import { tests as approvalFlowTests } from '../integration-tests/approval-flow-tests.js';
import { tests as approvalWaitTests } from '../integration-tests/approval-wait-tests.js';
import { tests as executeTests } from '../integration-tests/execute-tests.js';
import { tests as globTests } from '../integration-tests/glob-tests.js';
import { tests as compactionTests } from '../integration-tests/compaction-tests.js';
import { tests as multiConversationTests } from '../integration-tests/multi-conversation-tests.js';
import { tests as errorRecoveryTests } from '../integration-tests/error-recovery-tests.js';
import { tests as streamingTests } from '../integration-tests/streaming-tests.js';
import { tests as cancellationTests } from '../integration-tests/cancellation-tests.js';
import { tests as politeStopTests } from '../integration-tests/polite-stop-tests.js';
import { tests as askUserQuestionTests } from '../integration-tests/ask-user-question-tests.js';
import { tests as exploreCodeTests } from '../integration-tests/explore-code-tests.js';
import { tests as threadTests } from '../integration-tests/thread-tests.js';
import { tests as threadContextModeTests } from '../integration-tests/thread-context-mode-tests.js';
import { tests as threadCancellationTests } from '../integration-tests/thread-cancellation-tests.js';
import { tests as moveCopyTests } from '../integration-tests/move-copy-tests.js';
import { tests as yoloStrategyTests } from '../integration-tests/yolo-strategy-tests.js';
import { tests as rerunTests } from '../integration-tests/rerun-tests.js';
import { tests as editTests } from '../integration-tests/edit-tests.js';
import { tests as selectionRuleTests } from '../integration-tests/selection-rule-tests.js';
import { tests as fileMentionTests } from '../integration-tests/file-mention-tests.js';
import { tests as footerCacheTests } from '../integration-tests/footer-cache-tests.js';
import { tests as imageAttachmentTests } from '../integration-tests/image-attachment-tests.js';
import { tests as continueBtnTests } from '../integration-tests/continue-btn-tests.js';
import { tests as commandApprovalTests } from '../integration-tests/bash-approval-tests.js';
import { tests as undoStateMachineTests } from '../integration-tests/undo-state-machine-tests.js';
import { tests as multiViewerTests } from '../integration-tests/multi-viewer-tests.js';
import { tests as clearTests } from '../integration-tests/clear-tests.js';
import { tests as recentsOrderTests } from '../integration-tests/recents-order-tests.js';
import { tests as inputBoxTurnGuardTests } from '../integration-tests/input-box-turn-guard-tests.js';
import { tests as queuedMessageTests } from '../integration-tests/queued-message-tests.js';
import { tests as monitorDeliveryTests } from '../integration-tests/monitor-delivery-tests.js';
import { tests as monitorKillTests } from '../integration-tests/monitor-kill-tests.js';
import { tests as largeOutputTests } from '../integration-tests/large-output-tests.js';
import { tests as memoryTests } from '../integration-tests/memory-tests.js';
import { tests as attentionAlertTests } from '../integration-tests/attention-alert-tests.js';
import { tests as binGuardTests } from '../integration-tests/bin-guard-tests.js';
import { tests as modelAvailabilityTests } from '../integration-tests/model-availability-tests.js';
import { runTests as runApprovalFlowTests } from '../unit-tests/approval-flow-test.js';
import { runTests as runContextItemPersistenceTests } from '../unit-tests/context-item-persistence-test.js';
import { runTests as runConversationNameTests } from '../unit-tests/conversation-name-persistence-test.js';
import { runTests as runDraftPersistenceTests } from '../unit-tests/draft-persistence-test.js';
import { runTests as runDroppedFileTests } from '../unit-tests/dropped-file-test.js';
import { runTests as runEditPermissionTests } from '../unit-tests/edit-permission-test.js';
import { runTests as runExecuteActionTests } from '../unit-tests/execute-action-test.js';
import { runTests as runFileSystemApiTests } from '../unit-tests/filesystem-api-test.js';
import { runTests as runGlobActionTests } from '../unit-tests/glob-action-test.js';
import { runTests as runAskUserQuestionDetailsTests } from '../unit-tests/ask-user-question-details-test.js';
import { runTests as runItemAccessorTests } from '../unit-tests/item-accessor-test.js';
import { runTests as runMessageTypeGuardTests } from '../unit-tests/message-type-guard-test.js';
import { runTests as runModelFilterTests } from '../unit-tests/model-filter-test.js';
import { runTests as runMonitorToolsTests } from '../unit-tests/monitor-tools-test.js';
import { runTests as runMcpToolTests } from '../unit-tests/mcp-tool-test.js';
import { runTests as runMcpApprovalToolNameTests } from '../unit-tests/mcp-approval-toolname-test.js';
import { runTests as runMcpSettingsTests } from '../unit-tests/mcp-settings-test.js';
import { runTests as runAcpSettingsTests } from '../unit-tests/acp-settings-test.js';
import { runTests as runMemoryFormatTests } from '../unit-tests/memory-format-test.js';
import { runTests as runMemoryItemTests } from '../unit-tests/memory-item-test.js';
import { runTests as runMemorySeedTests } from '../unit-tests/memory-seed-test.js';
import { runTests as runMemorySystemPromptTests } from '../unit-tests/memory-system-prompt-test.js';
import { runTests as runSkillItemTests } from '../unit-tests/skill-item-test.js';
import { runTests as runSystemPromptBuilderTests } from '../unit-tests/system-prompt-builder-test.js';
import { runTests as runSystemPromptContextItemTests } from '../unit-tests/system-prompt-context-item-test.js';
import { runTests as runSystemPromptRegistryTests } from '../unit-tests/system-prompt-registry-test.js';
import { runTests as runExtensionSystemPromptTests } from '../unit-tests/extension-system-prompt-test.js';
import { runTests as runExtensionsDisabledTests } from '../unit-tests/extensions-disabled-test.js';
import { runTests as runStrategyInjectionTests } from '../unit-tests/strategy-injection-test.js';
import { runTests as runObserverDecouplingTests } from '../unit-tests/observer-decoupling-test.js';
import { runTests as runToolPendingHookTests } from '../unit-tests/tool-pending-hook-test.js';
import { runTests as runAutoApproveReviewerTests } from '../unit-tests/auto-approve-reviewer-test.js';
import { runTests as runAutoApproveStrategyTests } from '../unit-tests/auto-approve-strategy-test.js';
import { runTests as runYoloStrategyUnitTests } from '../unit-tests/yolo-strategy-test.js';
import { runTests as runHandoffPromotionTests } from '../unit-tests/handoff-promotion-test.js';
import { runTests as runReadFileActionTests } from '../unit-tests/read-file-action-test.js';
import { runTests as runPathInputQuotesTests } from '../unit-tests/path-input-quotes-test.js';
import { runTests as runSearchActionTests } from '../unit-tests/search-action-test.js';
import { runTests as runToolCancellationTests } from '../unit-tests/tool-cancellation-test.js';
import { runTests as runToolExecutionOrderTests } from '../unit-tests/tool-execution-order-test.js';
import { runTests as runToolActionRenderTests } from '../unit-tests/tool-action-render-test.js';
import { runTests as runExploreCodeFormatTests } from '../unit-tests/explore-code-format-test.js';
import { runTests as runSubmitPlanActionTests } from '../unit-tests/submit-plan-action-test.js';
import { runTests as runPlanApprovalTests } from '../unit-tests/plan-approval-test.js';
import { runTests as runWebFetchTests } from '../unit-tests/test-webfetch.js';
import { runTests as runWebSearchTests } from '../unit-tests/test-websearch.js';
import { runTests as runThreadNestedArrayTests } from '../unit-tests/thread-nested-array-test.js';
import { runTests as runUndoRedoTests } from '../unit-tests/undo-redo-test.js';
import { runTests as runHeaderUndoLockTests } from '../unit-tests/header-undo-lock-test.js';
import { runTests as runWriteFileActionTests } from '../unit-tests/write-file-action-test.js';
import { runTests as runYjsCompatTests } from '../unit-tests/yjs-compat-test.js';
import { runTests as runRenderPerformanceTests } from '../unit-tests/render-performance-tests.js';
import { runTests as runThinkingStreamTests } from '../unit-tests/thinking-stream-test.js';
import { runTests as runMarkdownSanitizerTests } from '../unit-tests/markdown-sanitizer-test.js';
import { runTests as runUserMessageMarkdownTests } from '../unit-tests/user-message-markdown-test.js';
import { runTests as runExternalLinkTests } from '../unit-tests/external-link-test.js';
import { runTests as runAnsiTests } from '../unit-tests/ansi-test.js';
import { runTests as runBashHighlightTests } from '../unit-tests/bash-highlight-test.js';
import { runTests as runToolNameResolutionTests } from '../unit-tests/tool-name-resolution-test.js';
import { runTests as runCommandApprovalUnitTests } from '../unit-tests/bash-command-approval-unit-test.js';
import { runTests as runPermissionRulesTests } from '../unit-tests/permission-rules-test.js';
import { runTests as runNewTabUxTests } from '../unit-tests/new-tab-ux-test.js';
import { runTests as runMobileComposerTests } from '../unit-tests/mobile-composer-test.js';
import { runTests as runSlashCompletionTests } from '../unit-tests/slash-completion-test.js';
import { runTests as runUnclaimedConversationsTests } from '../unit-tests/unclaimed-conversations-test.js';
import { runTests as runThreadColumnSelectionTests } from '../unit-tests/thread-column-selection-test.js';
import { runTests as runTabHideFocusTests } from '../unit-tests/tab-hide-focus-test.js';
import { runTests as runNestedApprovalStatusTests } from '../unit-tests/nested-approval-status-test.js';
import { runTests as runBatchCoerceTests } from '../unit-tests/batch-coerce-test.js';
import { runTests as runChimeRecoveryTests } from '../unit-tests/chime-recovery-test.js';
import { runTests as runKeyShortcutManagerTests } from '../unit-tests/key-shortcut-manager-test.js';
import { runTests as runHoldToCycleTests } from '../unit-tests/hold-to-cycle-test.js';
import { runTests as runRecentModelsTests } from '../unit-tests/recent-models-test.js';
import { runTests as runThinkingCyclerTests } from '../unit-tests/thinking-cycler-test.js';
import { runTests as runThinkingChipTests } from '../unit-tests/thinking-chip-test.js';
import { runTests as runModelSelectorHudTests } from '../unit-tests/model-selector-hud-test.js';
import { runTests as runFindTests } from '../unit-tests/find-test.js';
import { runTests as runContextMenuTests } from '../unit-tests/context-menu-test.js';
import { runTests as runExtensionRegistryTests } from '../unit-tests/extension-registry-test.js';
import { runTests as runSdkFacadeParityTests } from '../unit-tests/sdk-facade-parity-test.js';
import { runTests as runExtensionCollisionTests } from '../unit-tests/extension-collision-test.js';
import { runTests as runExtensionCatalogTests } from '../unit-tests/extension-catalog-test.js';
import { runTests as runUserCommandFactoryTests } from '../unit-tests/user-command-factory-test.js';
import { runTests as runCloseCommandTests } from '../unit-tests/close-command-test.js';
import { runTests as runEngineApiVectorTests } from '../unit-tests/engineapi-vectors-test.js';
import { runTests as runStrategyFallbackTests } from '../unit-tests/strategy-fallback-test.js';
import { runTests as runStrategyOrderTests } from '../unit-tests/strategy-order-test.js';
import { runTests as runStrategyMenuRefreshTests } from '../unit-tests/strategy-menu-refresh-test.js';
import { runTests as runPermissionPopupRefreshTests } from '../unit-tests/permission-popup-refresh-test.js';
import { runTests as runClipboardTests } from '../unit-tests/clipboard-test.js';
import { runTests as runConnectivityTests } from '../unit-tests/connectivity-test.js';
import { runTests as runLogsTests } from '../unit-tests/logs-test.js';
import { runTests as runUpdatesSettingsTests } from '../unit-tests/updates-settings-test.js';
import { runTests as runNetworkSettingsTests } from '../unit-tests/network-settings-test.js';
import { runTests as runReconnectPolicyTests } from '../unit-tests/reconnect-policy-test.js';
import { runTests as runPopupBackButtonTests } from '../unit-tests/popup-back-button-test.js';
import { runTests as runModelDisplayTests } from '../unit-tests/model-display-test.js';
import { runTests as runEngineProjectSwitchTests } from '../unit-tests/engine-project-switch-test.js';
import './golden-comparator.js'; // Initialize window.__integrationTestHelpers
import logger from './test-logger.js';
import {
  installClaimAutoRegistration,
  snapshotOwnConversationIds,
  deleteOwnConversationsCreatedSince,
  setCurrentTestName
} from './conversation-claims.js';

// Action progress events fire in the engine WebviewWindow's document; without
// a bridge they are invisible to the test page. action-executor broadcasts
// them; re-dispatch on the test document so capture listeners see them.
//
// BroadcastChannel scopes to the whole browsing context (origin), so in the
// multi-iframe test pool every iframe receives every other iframe's events.
// We tag each detail with conversationId and only redispatch events whose
// conversation we host — otherwise sibling tests' tool executions would
// count toward this test's per-tool exec counters.
const __apChan = new BroadcastChannel('juggler-action-progress');
const __inIframePool = window.parent && window.parent !== window;
__apChan.onmessage = (/** @type {MessageEvent} */ e) => {
  const detail = e.data;
  // In the iframe pool, only redispatch events for conversations THIS
  // iframe owns — otherwise sibling test iframes' tool executions pile
  // onto this test's counters.
  if (__inIframePool && detail?.conversationId) {
    const owned = /** @type {any} */ (window).__ownConversationIds;
    if (!owned || !owned.has(detail.conversationId)) return;
  }
  document.dispatchEvent(new CustomEvent('action-progress', { detail }));
};

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory path
 */

/**
 * All available integration tests.
 * Add new test modules here.
 * Each test runs in its own isolated fixture directory, so order does not matter.
 */
const ALL_TESTS = [
  ...globTests,
  ...readFileTests,
  ...exploreCodeTests,
  ...writeFileTests,
  ...approvalFlowTests,
  ...approvalWaitTests,
  ...executeTests,
  ...streamingTests,
  ...cancellationTests,
  ...politeStopTests,
  ...compactionTests,
  ...multiConversationTests,
  ...errorRecoveryTests,
  ...askUserQuestionTests,
  ...threadTests,
  ...threadContextModeTests,
  ...threadCancellationTests,
  ...moveCopyTests,
  ...yoloStrategyTests,
  ...rerunTests,
  ...editTests,
  ...selectionRuleTests,
  ...fileMentionTests,
  ...footerCacheTests,
  ...imageAttachmentTests,
  ...continueBtnTests,
  ...commandApprovalTests,
  ...undoStateMachineTests,
  ...multiViewerTests,
  ...clearTests,
  ...recentsOrderTests,
  ...inputBoxTurnGuardTests,
  ...queuedMessageTests,
  ...monitorDeliveryTests,
  ...monitorKillTests,
  ...largeOutputTests,
  ...memoryTests,
  ...attentionAlertTests,
  ...binGuardTests,
  ...modelAvailabilityTests
].map(t => ({ ...t, name: `integration:${t.name}` }));

/**
 * All unit test suites — each runs in its own isolated browser tab.
 * Each entry is a { name, run } pair where run(ctx) returns { passed, failed, errors }.
 * Names appear as individual test entries in listTests() and are addressable via -run.
 */
const UNIT_TEST_SUITES = [
  { name: 'unit:approval-flow', run: runApprovalFlowTests },
  { name: 'unit:key-shortcut-manager', run: runKeyShortcutManagerTests },
  { name: 'unit:hold-to-cycle', run: runHoldToCycleTests },
  { name: 'unit:recent-models', run: runRecentModelsTests },
  { name: 'unit:thinking-cycler', run: runThinkingCyclerTests },
  { name: 'unit:thinking-chip', run: runThinkingChipTests },
  { name: 'unit:model-selector-hud', run: runModelSelectorHudTests },
  { name: 'unit:find', run: runFindTests },
  { name: 'unit:context-item-persistence', run: runContextItemPersistenceTests },
  { name: 'unit:conversation-name-persistence', run: runConversationNameTests },
  { name: 'unit:draft-persistence', run: runDraftPersistenceTests },
  { name: 'unit:dropped-file', run: runDroppedFileTests },
  { name: 'unit:edit-permission', run: runEditPermissionTests },
  { name: 'unit:execute-action', run: runExecuteActionTests },
  { name: 'unit:filesystem-api', run: runFileSystemApiTests },
  { name: 'unit:glob-action', run: runGlobActionTests },
  { name: 'unit:item-accessor', run: runItemAccessorTests },
  { name: 'unit:message-type-guard', run: runMessageTypeGuardTests },
  { name: 'unit:model-filter', run: runModelFilterTests },
  { name: 'unit:monitor-tools', run: runMonitorToolsTests },
  { name: 'unit:mcp-tool', run: runMcpToolTests },
  { name: 'unit:mcp-approval-toolname', run: runMcpApprovalToolNameTests },
  { name: 'unit:mcp-settings', run: runMcpSettingsTests },
  { name: 'unit:acp-settings', run: runAcpSettingsTests },
  { name: 'unit:memory-format', run: runMemoryFormatTests },
  { name: 'unit:memory-item', run: runMemoryItemTests },
  { name: 'unit:memory-seed', run: runMemorySeedTests },
  { name: 'unit:memory-system-prompt', run: runMemorySystemPromptTests },
  { name: 'unit:skill-item', run: runSkillItemTests },
  { name: 'unit:system-prompt-builder', run: runSystemPromptBuilderTests },
  { name: 'unit:system-prompt-context-item', run: runSystemPromptContextItemTests },
  { name: 'unit:system-prompt-registry', run: runSystemPromptRegistryTests },
  { name: 'unit:extension-system-prompt', run: runExtensionSystemPromptTests },
  { name: 'unit:extensions-disabled', run: runExtensionsDisabledTests },
  { name: 'unit:strategy-injection', run: runStrategyInjectionTests },
  { name: 'unit:observer-decoupling', run: runObserverDecouplingTests },
  { name: 'unit:tool-pending-hook', run: runToolPendingHookTests },
  { name: 'unit:auto-approve-reviewer', run: runAutoApproveReviewerTests },
  { name: 'unit:auto-approve-strategy', run: runAutoApproveStrategyTests },
  { name: 'unit:yolo-strategy', run: runYoloStrategyUnitTests },
  { name: 'unit:handoff-promotion', run: runHandoffPromotionTests },
  { name: 'unit:read-file-action', run: runReadFileActionTests },
  { name: 'unit:path-input-quotes', run: runPathInputQuotesTests },
  { name: 'unit:mobile-composer', run: runMobileComposerTests },
  { name: 'unit:slash-completion', run: runSlashCompletionTests },
  { name: 'unit:search-action', run: runSearchActionTests },
  { name: 'unit:tool-cancellation', run: runToolCancellationTests },
  { name: 'unit:tool-execution-order', run: runToolExecutionOrderTests },
  { name: 'unit:tool-action-render', run: runToolActionRenderTests },
  { name: 'unit:explore-code-format', run: runExploreCodeFormatTests },
  { name: 'unit:submit-plan-action', run: runSubmitPlanActionTests },
  { name: 'unit:plan-approval', run: runPlanApprovalTests },
  { name: 'unit:webfetch', run: runWebFetchTests },
  { name: 'unit:websearch', run: runWebSearchTests },
  { name: 'unit:thread-nested-array', run: runThreadNestedArrayTests },
  { name: 'unit:undo-redo', run: runUndoRedoTests },
  { name: 'unit:header-undo-lock', run: runHeaderUndoLockTests },
  { name: 'unit:write-file-action', run: runWriteFileActionTests },
  { name: 'unit:yjs-compat', run: runYjsCompatTests },
  { name: 'unit:render-performance', run: runRenderPerformanceTests },
  { name: 'unit:thinking-stream', run: runThinkingStreamTests },
  { name: 'unit:markdown-sanitizer', run: runMarkdownSanitizerTests },
  { name: 'unit:user-message-markdown', run: runUserMessageMarkdownTests },
  { name: 'unit:external-link', run: runExternalLinkTests },
  { name: 'unit:ansi', run: runAnsiTests },
  { name: 'unit:bash-highlight', run: runBashHighlightTests },
  { name: 'unit:tool-name-resolution', run: runToolNameResolutionTests },
  { name: 'unit:bash-command-approval', run: runCommandApprovalUnitTests },
  { name: 'unit:permission-rules', run: runPermissionRulesTests },
  { name: 'unit:new-tab-ux', run: runNewTabUxTests },
  { name: 'unit:unclaimed-conversations', run: runUnclaimedConversationsTests },
  { name: 'unit:thread-column-selection', run: runThreadColumnSelectionTests },
  { name: 'unit:tab-hide-focus', run: runTabHideFocusTests },
  { name: 'unit:nested-approval-status', run: runNestedApprovalStatusTests },
  { name: 'unit:batch-coerce', run: runBatchCoerceTests },
  { name: 'unit:chime-recovery', run: runChimeRecoveryTests },
  { name: 'unit:context-menu', run: runContextMenuTests },
  { name: 'unit:ask-user-question-details', run: runAskUserQuestionDetailsTests },
  { name: 'unit:extension-registry', run: runExtensionRegistryTests },
  { name: 'unit:sdk-facade-parity', run: runSdkFacadeParityTests },
  { name: 'unit:extension-collision', run: runExtensionCollisionTests },
  { name: 'unit:extension-catalog', run: runExtensionCatalogTests },
  { name: 'unit:user-command-factory', run: runUserCommandFactoryTests },
  { name: 'unit:close-command', run: runCloseCommandTests },
  { name: 'unit:engineapi-vectors', run: runEngineApiVectorTests },
  { name: 'unit:strategy-fallback', run: runStrategyFallbackTests },
  { name: 'unit:strategy-order', run: runStrategyOrderTests },
  { name: 'unit:strategy-menu-refresh', run: runStrategyMenuRefreshTests },
  { name: 'unit:permission-popup-refresh', run: runPermissionPopupRefreshTests },
  { name: 'unit:clipboard', run: runClipboardTests },
  { name: 'unit:connectivity', run: runConnectivityTests },
  { name: 'unit:logs', run: runLogsTests },
  { name: 'unit:updates-settings', run: runUpdatesSettingsTests },
  { name: 'unit:network-settings', run: runNetworkSettingsTests },
  { name: 'unit:reconnect-policy', run: runReconnectPolicyTests },
  { name: 'unit:popup-back-button', run: runPopupBackButtonTests },
  { name: 'unit:model-display', run: runModelDisplayTests },
  { name: 'unit:engine-project-switch', run: runEngineProjectSwitchTests },
];

/**
 * Run all integration tests sequentially.
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results
 */
export async function runTests(ctx) {
  installClaimAutoRegistration();
  await waitForEngineConnected();
  logger.essential(`Starting integration tests...`);
  logger.info(`Running ${ALL_TESTS.length} mock-LLM tests + ${UNIT_TEST_SUITES.length} unit suites`);
  logger.info(`Fixture: ${ctx.fixtureDir}`);

  /** @type {string[]} */
  const errors = [];

  const { passed, failed, results } = await runIntegrationTests(ALL_TESTS, ctx);

  for (const [name, result] of results) {
    if (!result.passed && result.error) {
      errors.push(`${name}: ${result.error}`);
    }
  }

  let unitPassed = 0;
  let unitFailed = 0;
  for (const suite of UNIT_TEST_SUITES) {
    const result = await runUnitSuiteWithConvCleanup(suite, /** @type {any} */ (ctx));
    unitPassed += result.passed;
    unitFailed += result.failed;
    errors.push(...result.errors);
  }

  return { passed: passed + unitPassed, failed: failed + unitFailed, errors };
}

/**
 * Run one unit suite, then permanently delete every conversation it created
 * (diffed via this lane's claim registry, which is lane-local and therefore
 * immune to sibling lanes' concurrent creations). Without this, unit tests
 * leak conversations into the SHARED pool session every run, marching it
 * toward MAX_CONVERSATIONS — the pressure that historically made make-room
 * deletes bulldoze live sibling conversations mid-turn.
 * @param {{name: string, run: function(any): Promise<{passed: number, failed: number, errors: string[]}>}} suite
 * @param {any} ctx
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Suite results after cleanup.
 */
async function runUnitSuiteWithConvCleanup(suite, ctx) {
  setCurrentTestName(suite.name);
  // Unit suites share one document, so a modal a prior suite left open leaks
  // into this one. The confirm/alert/notice host is a reused <modal-dialog>
  // singleton (see modal-dialog.js): showConfirm/showAlert only resolve on a
  // user click, so a suite that opens one without dismissing it leaves
  // `modal-dialog.show` in the DOM — and any later suite that consults it
  // globally (e.g. hold-to-cycle's defaultShouldHandle, which treats an open
  // modal as "don't handle") then fails. Neutralize stray modals both before
  // and after each suite so isolation holds regardless of neighbour order.
  neutralizeStrayModals();
  const before = snapshotOwnConversationIds();
  try {
    return await suite.run(ctx);
  } finally {
    neutralizeStrayModals();
    await deleteOwnConversationsCreatedSince(before, `unit-cleanup:${suite.name}`);
  }
}

/**
 * Close and remove any <modal-dialog> element left in the shared unit-test
 * document. close(null) removes the `show`/`is-notice` classes, releases the
 * popup-manager token, clears the notice timer, and resolves any pending
 * promise; removing the element then guarantees the next showConfirm/showAlert
 * lazily recreates a pristine singleton. Best-effort — a throw here must never
 * mask the suite's own result.
 */
function neutralizeStrayModals() {
  document.querySelectorAll('modal-dialog').forEach((modal) => {
    try {
      const m = /** @type {any} */ (modal);
      if (typeof m.close === 'function') m.close(null);
    } catch (_) { /* ignore — fall through to removal */ }
    modal.classList.remove('show');
    modal.remove();
  });
}

let _wsSetupDone = false;

/**
 * Set up WebSocket connection and worker message routing for unit tests.
 * Mirrors what app.js does normally; needed because headless-test.html doesn't load app.js.
 */
async function setupWebSocketForUnitTests() {
  if (_wsSetupDone) return;
  _wsSetupDone = true;

  const { default: wsService } = await import('../../js/services/websocket.js');
  const { default: workerManager } = await import('../../js/services/worker-manager.js');

  if (!wsService.isConnected()) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
      const onOpen = () => { clearTimeout(timeout); wsService.off('open', onOpen); wsService.off('error', onError); resolve(undefined); };
      const onError = () => { clearTimeout(timeout); wsService.off('open', onOpen); wsService.off('error', onError); reject(new Error('WebSocket error')); };
      wsService.on('open', onOpen);
      wsService.on('error', onError);
      wsService.connect();
    });
  }

  wsService.on('message', (/** @type {any} */ data) => {
    if (data.type === 'worker-message') {
      workerManager.handleWorkerMessageFromWS(data);
    }
  });
}

/**
 * Wait for the engine iframe to connect to the server.
 * Polls GET /api/engine/status until connected: true (timeout 30s).
 * @returns {Promise<void>}
 */
async function waitForEngineConnected() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch('/api/engine/status');
      if (resp.ok) {
        const data = await resp.json();
        if (data.connected) return;
      }
    } catch (_) { /* ignore fetch errors during polling */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Engine did not connect within 30s');
}

/**
 * Run a specific test by name — handles both integration tests and unit test suites.
 * @param {string} testName - Name of the test to run
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTestByName(testName, ctx) {
  installClaimAutoRegistration();
  await waitForEngineConnected();
  const names = testName.split(',').map(s => s.trim()).filter(Boolean);

  // Check if any name belongs to a unit test suite
  const unitSuite = names.length === 1 ? UNIT_TEST_SUITES.find(s => s.name === names[0]) : null;
  if (unitSuite) {
    await setupWebSocketForUnitTests();

    // Reset fixture before each unit suite so a prior test in this same
    // iframe lane (e.g. write-file-action) doesn't leak files into the
    // next run. SKIP in the iframe-pool topology, where N iframes share
    // one fixture dir — wiping it here would clobber a sibling lane's
    // in-flight test. The browser_suite_test.go `resetAllFixtures` hook
    // handles between-iteration cleanup in that topology instead. This
    // guard mirrors the same one in `runIntegrationTest` below.
    if (!window.parent || window.parent === window) {
      const resetUrl = `/api/test/reset-fixture?fixture=unit-test-fixture&dir=${encodeURIComponent(ctx.fixtureDir)}`;
      const resetResp = await fetch(resetUrl, { method: 'POST' });
      if (!resetResp.ok) {
        const errText = await resetResp.text();
        return { passed: 0, failed: 1, errors: [`Fixture reset failed: ${resetResp.status} ${errText}`] };
      }
    }

    const unitCtx = /** @type {any} */ (ctx);
    if (!unitCtx.readFile) {
      const { readFileLoad } = await import('../../js/services/ops-api.js');
      unitCtx.readFile = async (/** @type {string} */ relativePath) => {
        const result = await readFileLoad({ path: `${ctx.fixtureDir}/${relativePath}` });
        return (/** @type {any} */ (result)).content ?? '';
      };
    }
    return await runUnitSuiteWithConvCleanup(unitSuite, unitCtx);
  }

  /** @type {typeof ALL_TESTS} */
  const selected = [];
  for (const name of names) {
    const test = ALL_TESTS.find(t => t.name === name);
    if (!test) {
      return {
        passed: 0,
        failed: 1,
        errors: [`Test not found: ${name}`]
      };
    }
    selected.push(test);
  }

  const { passed, failed, results } = await runIntegrationTests(selected, ctx);

  /** @type {string[]} */
  const errors = [];
  for (const [name, result] of results) {
    if (!result.passed && result.error) {
      errors.push(`${name}: ${result.error}`);
    }
  }

  return { passed, failed, errors };
}

/**
 * List all available tests (integration + unit suites).
 * @returns {string[]} Test names
 */
export function listTests() {
  return [
    ...ALL_TESTS.map(t => t.name),
    ...UNIT_TEST_SUITES.map(s => s.name),
  ];
}

/**
 * List tests that write a fixed-name file to the shared fixture root which
 * production auto-detection scans (see `pollutesFixtureRoot` in the test
 * definition). The Go runner schedules these sequentially, isolated from all
 * other tests, so their transient files can't contaminate sibling lanes.
 * @returns {string[]} Names of fixture-root-polluting tests
 */
export function listPolluters() {
  return ALL_TESTS.filter(t => t.pollutesFixtureRoot).map(t => t.name);
}
