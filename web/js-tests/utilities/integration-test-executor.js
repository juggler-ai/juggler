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
import { destroyTrackedTestSessions } from './test-helpers.js';
import { whenRegistriesSettled } from '../../js/registries/reload-registries.js';
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
import { tests as queryCodeTests } from '../integration-tests/query-code-tests.js';
import { tests as threadTests } from '../integration-tests/thread-tests.js';
import { tests as threadContextModeTests } from '../integration-tests/thread-context-mode-tests.js';
import { tests as threadCancellationTests } from '../integration-tests/thread-cancellation-tests.js';
import { tests as moveCopyTests } from '../integration-tests/move-copy-tests.js';
import { tests as yoloStrategyTests } from '../integration-tests/yolo-strategy-tests.js';
import { tests as rerunTests } from '../integration-tests/rerun-tests.js';
import { tests as editTests } from '../integration-tests/edit-tests.js';
import { tests as selectionRuleTests } from '../integration-tests/selection-rule-tests.js';
import { tests as fileMentionTests } from '../integration-tests/file-mention-tests.js';
import { tests as linkClickTests } from '../integration-tests/link-click-tests.js';
import { tests as footerCacheTests } from '../integration-tests/footer-cache-tests.js';
import { tests as footerUndoOfferTests } from '../integration-tests/footer-undo-offer-tests.js';
import { tests as imageAttachmentTests } from '../integration-tests/image-attachment-tests.js';
import { tests as continueBtnTests } from '../integration-tests/continue-btn-tests.js';
import { tests as commandApprovalTests } from '../integration-tests/bash-approval-tests.js';
import { tests as undoStateMachineTests } from '../integration-tests/undo-state-machine-tests.js';
import { tests as multiViewerTests } from '../integration-tests/multi-viewer-tests.js';
import { tests as clearTests } from '../integration-tests/clear-tests.js';
import { tests as recentsOrderTests } from '../integration-tests/recents-order-tests.js';
import { tests as composerTurnGuardTests } from '../integration-tests/composer-turn-guard-tests.js';
import { tests as queuedMessageTests } from '../integration-tests/queued-message-tests.js';
import { tests as monitorDeliveryTests } from '../integration-tests/monitor-delivery-tests.js';
import { tests as monitorKillTests } from '../integration-tests/monitor-kill-tests.js';
import { tests as largeOutputTests } from '../integration-tests/large-output-tests.js';
import { tests as backgroundOutputTests } from '../integration-tests/background-output-tests.js';
import { tests as memoryTests } from '../integration-tests/memory-tests.js';
import { tests as attentionAlertTests } from '../integration-tests/attention-alert-tests.js';
import { tests as binGuardTests } from '../integration-tests/bin-guard-tests.js';
import { tests as modelAvailabilityTests } from '../integration-tests/model-availability-tests.js';
import { runTests as runContextCacheImpactTests } from '../unit-tests/context-cache-impact-test.js';
import { runTests as runCacheBaselineAnchorTests } from '../unit-tests/cache-baseline-anchor-test.js';
import { runTests as runCodeLinesTests } from '../unit-tests/code-lines-test.js';
import { runTests as runCacheMissWarningTests } from '../unit-tests/cache-miss-warning-test.js';
import { runTests as runErrorRetryGateTests } from '../unit-tests/error-retry-gate-test.js';
import { runTests as runAuthErrorActionTests } from '../unit-tests/auth-error-action-test.js';
import { runTests as runKeylessSignInStatusTests } from '../unit-tests/keyless-signin-status-test.js';
import { runTests as runTokenCacheUnknownTests } from '../unit-tests/token-cache-unknown-test.js';
import { runTests as runCompactionStatusTests } from '../unit-tests/compaction-status-test.js';
import { runTests as runStatusMessageFormatTests } from '../unit-tests/status-message-format-test.js';
import { runTests as runContextItemPersistenceTests } from '../unit-tests/context-item-persistence-test.js';
import { runTests as runContextItemSeedExecuteTests } from '../unit-tests/context-item-seed-execute-test.js';
import { runTests as runConversationNameTests } from '../unit-tests/conversation-name-persistence-test.js';
import { runTests as runConversationNamingTests } from '../unit-tests/conversation-naming-test.js';
import { runTests as runNewConversationSystemPromptTests } from '../unit-tests/new-conversation-system-prompt-test.js';
import { runTests as runOneShotRunTests } from '../unit-tests/one-shot-run-test.js';
import { runTests as runDraftPersistenceTests } from '../unit-tests/draft-persistence-test.js';
import { runTests as runDraftCloseFlushTests } from '../unit-tests/draft-close-flush-test.js';
import { runTests as runMessageHistoryTests } from '../unit-tests/message-history-test.js';
import { runTests as runPasteTokenTests } from '../unit-tests/paste-token-test.js';
import { runTests as runDraftTabSwitchTests } from '../unit-tests/draft-tab-switch-test.js';
import { runTests as runEditPermissionTests } from '../unit-tests/edit-permission-test.js';
import { runTests as runExecuteActionTests } from '../unit-tests/execute-action-test.js';
import { runTests as runFileSystemApiTests } from '../unit-tests/filesystem-api-test.js';
import { runTests as runGlobActionTests } from '../unit-tests/glob-action-test.js';
import { runTests as runItemAccessorTests } from '../unit-tests/item-accessor-test.js';
import { runTests as runMessageTypeGuardTests } from '../unit-tests/message-type-guard-test.js';
import { runTests as runModelFilterTests } from '../unit-tests/model-filter-test.js';
import { runTests as runMonitorToolsTests } from '../unit-tests/monitor-tools-test.js';
import { runTests as runToolSchemaTests } from '../unit-tests/tool-schema-test.js';
import { runTests as runToolListReadinessTests } from '../unit-tests/tool-list-readiness-test.js';
import { runTests as runTransactionToolListTests } from '../unit-tests/transaction-tool-list-test.js';
import { runTests as runThreadToolInventoryTests } from '../unit-tests/thread-tool-inventory-test.js';
import { runTests as runMcpApprovalToolNameTests } from '../unit-tests/mcp-approval-toolname-test.js';
import { runTests as runMcpEvaluateToolNameTests } from '../unit-tests/mcp-evaluate-toolname-test.js';
import { runTests as runMcpSettingsTests } from '../unit-tests/mcp-settings-test.js';
import { runTests as runAcpSettingsTests } from '../unit-tests/acp-settings-test.js';
import { runTests as runSystemPromptBuilderTests } from '../unit-tests/system-prompt-builder-test.js';
import { runTests as runSystemPromptRegistryTests } from '../unit-tests/system-prompt-registry-test.js';
import { runTests as runExtensionsDisabledTests } from '../unit-tests/extensions-disabled-test.js';
import { runTests as runStrategyInjectionTests } from '../unit-tests/strategy-injection-test.js';
import { runTests as runObserverDecouplingTests } from '../unit-tests/observer-decoupling-test.js';
import { runTests as runToolPendingHookTests } from '../unit-tests/tool-pending-hook-test.js';
import { runTests as runContextTurnHookTests } from '../unit-tests/context-turn-hook-test.js';
import { runTests as runHandoffPromotionTests } from '../unit-tests/handoff-promotion-test.js';
import { runTests as runReadFileActionTests } from '../unit-tests/read-file-action-test.js';
import { runTests as runPathInputQuotesTests } from '../unit-tests/path-input-quotes-test.js';
import { runTests as runSearchActionTests } from '../unit-tests/search-action-test.js';
import { runTests as runToolCancellationTests } from '../unit-tests/tool-cancellation-test.js';
import { runTests as runUnboundedAwaitTests } from '../unit-tests/unbounded-await-test.js';
import { runTests as runModalSupersedeTests } from '../unit-tests/modal-supersede-test.js';
import { runTests as runConversationReleaseTests } from '../unit-tests/conversation-release-test.js';
import { runTests as runLoadQueueRecycleTests } from '../unit-tests/load-queue-recycle-test.js';
import { runTests as runUnloadedTabHydrationTests } from '../unit-tests/unloaded-tab-hydration-test.js';
import { runTests as runRefreshMergeTests } from '../unit-tests/refresh-merge-test.js';
import { runTests as runTabOrderMergeTests } from '../unit-tests/tab-order-merge-test.js';
import { runTests as runTabDragOrderTests } from '../unit-tests/tab-drag-order-test.js';
import { runTests as runToolExecutionOrderTests } from '../unit-tests/tool-execution-order-test.js';
import { runTests as runToolActionRenderTests } from '../unit-tests/tool-action-render-test.js';
import { runTests as runJugglerSpinnerLiveTests } from '../unit-tests/juggler-spinner-live-test.js';
import { runTests as runSubmitPlanActionTests } from '../unit-tests/submit-plan-action-test.js';
import { runTests as runPlanApprovalTests } from '../unit-tests/plan-approval-test.js';
import { runTests as runTodoActionTests } from '../unit-tests/todo-action-test.js';
import { runTests as runTodoNoApprovalTests } from '../unit-tests/todo-no-approval-test.js';
import { runTests as runThreadNestedArrayTests } from '../unit-tests/thread-nested-array-test.js';
import { runTests as runUndoRedoTests } from '../unit-tests/undo-redo-test.js';
import { runTests as runHeaderUndoLockTests } from '../unit-tests/header-undo-lock-test.js';
import { runTests as runFooterMetaTests } from '../unit-tests/footer-meta-test.js';
import { runTests as runWriteFileActionTests } from '../unit-tests/write-file-action-test.js';
import { runTests as runYjsCompatTests } from '../unit-tests/yjs-compat-test.js';
import { runTests as runBase64Tests } from '../unit-tests/base64-test.js';
import { runTests as runWSChunkTests } from '../unit-tests/ws-chunk-test.js';
import { runTests as runRenderPerformanceTests } from '../unit-tests/render-performance-tests.js';
import { runTests as runTestBudgetTests } from '../unit-tests/test-budget-test.js';
import { runTests as runEngineAutoloadTests } from '../unit-tests/engine-autoload-test.js';
import { runTests as runSyncBatchBackoffTests } from '../unit-tests/sync-batch-backoff-test.js';
import { runTests as runSyncFaultIsolationTests } from '../unit-tests/sync-fault-isolation-test.js';
import { runTests as runThinkingStreamTests } from '../unit-tests/thinking-stream-test.js';
import { runTests as runStreamingRowScopeTests } from '../unit-tests/streaming-row-scope-test.js';
import { runTests as runStreamingMarkdownTests } from '../unit-tests/streaming-markdown-test.js';
import { runTests as runMarkdownSanitizerTests } from '../unit-tests/markdown-sanitizer-test.js';
import { runTests as runMarkdownScopedCssTests } from '../unit-tests/markdown-scoped-css-test.js';
import { runTests as runMarkdownTaskListTests } from '../unit-tests/markdown-task-list-test.js';
import { runTests as runUserMessageMarkdownTests } from '../unit-tests/user-message-markdown-test.js';
import { runTests as runExternalLinkTests } from '../unit-tests/external-link-test.js';
import { runTests as runLinkGuardTests } from '../unit-tests/link-guard-test.js';
import { runTests as runAnsiTests } from '../unit-tests/ansi-test.js';
import { runTests as runUIPrefScopeTests } from '../unit-tests/ui-pref-scope-test.js';
import { runTests as runToolNameResolutionTests } from '../unit-tests/tool-name-resolution-test.js';
import { runTests as runNewTabUxTests } from '../unit-tests/new-tab-ux-test.js';
import { runTests as runBinUndoToastTests } from '../unit-tests/bin-undo-toast-test.js';
import { runTests as runBinEmptyMenuTests } from '../unit-tests/bin-empty-menu-test.js';
import { runTests as runRestoreSelectPanelTests } from '../unit-tests/restore-select-panel-test.js';
import { runTests as runConversationFocusPolicyTests } from '../unit-tests/conversation-focus-policy-test.js';
import { runTests as runMobileComposerTests } from '../unit-tests/mobile-composer-test.js';
import { runTests as runComposerSendLatchTests } from '../unit-tests/composer-send-latch-test.js';
import { runTests as runScheduledSendTests } from '../unit-tests/scheduled-send-test.js';
import { runTests as runSidebarDrawerTests } from '../unit-tests/sidebar-drawer-test.js';
import { runTests as runSwipeDismissTests } from '../unit-tests/swipe-dismiss-test.js';
import { runTests as runInfoRailTests } from '../unit-tests/info-rail-test.js';
import { runTests as runTabDragGhostTests } from '../unit-tests/tab-drag-ghost-test.js';
import { runTests as runReorderDragTests } from '../unit-tests/reorder-drag-test.js';
import { runTests as runSlashCompletionTests } from '../unit-tests/slash-completion-test.js';
import { runTests as runSkillCompletionTests } from '../unit-tests/skill-completion-test.js';
import { runTests as runUnclaimedConversationsTests } from '../unit-tests/unclaimed-conversations-test.js';
import { runTests as runThreadColumnSelectionTests } from '../unit-tests/thread-column-selection-test.js';
import { runTests as runThreadSelectionPinTests } from '../unit-tests/thread-selection-pin-test.js';
import { runTests as runThreadPinSurvivesRevealTests } from '../unit-tests/thread-pin-survives-reveal-test.js';
import { runTests as runParallelThreadSelectionTests } from '../unit-tests/parallel-thread-selection-test.js';
import { runTests as runPinboardThreadSourceTests } from '../unit-tests/pinboard-thread-source-test.js';
import { runTests as runPinboardFileEditsTests } from '../unit-tests/pinboard-file-edits-test.js';
import { runTests as runPinboardTasksTests } from '../unit-tests/pinboard-tasks-test.js';
import { runTests as runPinboardRetentionTests } from '../unit-tests/pinboard-retention-test.js';
import { runTests as runPinboardSatelliteTests } from '../unit-tests/pinboard-satellite-test.js';
import { runTests as runScrollAwayAutofollowTests } from '../unit-tests/scroll-away-autofollow-test.js';
import { runTests as runScrollToTopTests } from '../unit-tests/scroll-to-top-test.js';
import { runTests as runAutoFollowHoldsTheEndTests } from '../unit-tests/auto-follow-holds-the-end-test.js';
import { runTests as runUserSendFollowTests } from '../unit-tests/user-send-follow-test.js';
import { runTests as runEmptyConversationHintTests } from '../unit-tests/empty-conversation-hint-test.js';
import { runTests as runColumnFileDropTests } from '../unit-tests/column-file-drop-test.js';
import { runTests as runColumnNavigationTests } from '../unit-tests/column-navigation-test.js';
import { runTests as runDeleteSelectionNeighbourTests } from '../unit-tests/delete-selection-neighbour-test.js';
import { runTests as runControlClickRevealTests } from '../unit-tests/control-click-reveal-test.js';
import { runTests as runTabHideFocusTests } from '../unit-tests/tab-hide-focus-test.js';
import { runTests as runNewThreadFocusTests } from '../unit-tests/new-thread-focus-test.js';
import { runTests as runApprovalFocusReturnTests } from '../unit-tests/approval-focus-return-test.js';
import { runTests as runApprovalDraftFocusTests } from '../unit-tests/approval-draft-focus-test.js';
import { runTests as runNestedApprovalStatusTests } from '../unit-tests/nested-approval-status-test.js';
import { runTests as runConcurrentRunsTests } from '../unit-tests/concurrent-runs-test.js';
import { runTests as runThreadAliasTests } from '../unit-tests/thread-alias-test.js';
import { runTests as runRunRecordsTests } from '../unit-tests/run-records-test.js';
import { runTests as runToolGroupingTests } from '../unit-tests/tool-grouping-test.js';
import { runTests as runChimeRecoveryTests } from '../unit-tests/chime-recovery-test.js';
import { runTests as runTabBehaviourPrefsTests } from '../unit-tests/tab-behaviour-prefs-test.js';
import { runTests as runKeyShortcutManagerTests } from '../unit-tests/key-shortcut-manager-test.js';
import { runTests as runEscapeBehaviourTests } from '../unit-tests/escape-behaviour-test.js';
import { runTests as runHoldToCycleTests } from '../unit-tests/hold-to-cycle-test.js';
import { runTests as runRecentModelsTests } from '../unit-tests/recent-models-test.js';
import { runTests as runPinboardTests } from '../unit-tests/pinboard-test.js';
import { runTests as runPinboardShellTests } from '../unit-tests/pinboard-shell-test.js';
import { runTests as runUsageStatsCacheTests } from '../unit-tests/usage-stats-cache-test.js';
import { runTests as runThinkingCyclerTests } from '../unit-tests/thinking-cycler-test.js';
import { runTests as runThinkingChipTests } from '../unit-tests/thinking-chip-test.js';
import { runTests as runServiceTierControlTests } from '../unit-tests/service-tier-control-test.js';
import { runTests as runServiceTierChipTests } from '../unit-tests/service-tier-chip-test.js';
import { runTests as runTransactionPanelTests } from '../unit-tests/transaction-panel-test.js';
import { runTests as runModelSelectorHudTests } from '../unit-tests/model-selector-hud-test.js';
import { runTests as runModelPickerTests } from '../unit-tests/model-picker-test.js';
import { runTests as runDefaultsModelHostTests } from '../unit-tests/defaults-model-host-test.js';
import { runTests as runCommandEditorTests } from '../unit-tests/command-editor-test.js';
import { runTests as runFindTests } from '../unit-tests/find-test.js';
import { runTests as runContextMenuTests } from '../unit-tests/context-menu-test.js';
import { runTests as runDisconnectionOverlayTests } from '../unit-tests/disconnection-overlay-test.js';
import { runTests as runExtensionRegistryTests } from '../unit-tests/extension-registry-test.js';
import { runTests as runFileViewerRegistryTests } from '../unit-tests/file-viewer-registry-test.js';
import { runTests as runPdfViewerTests } from '../unit-tests/pdf-viewer-test.js';
import { runTests as runFileViewTests } from '../unit-tests/file-view-test.js';
import { runTests as runSdkFacadeParityTests } from '../unit-tests/sdk-facade-parity-test.js';
import { runTests as runExtensionCollisionTests } from '../unit-tests/extension-collision-test.js';
import { runTests as runExtensionCatalogTests } from '../unit-tests/extension-catalog-test.js';
import { runTests as runExtensionReloadFailureTests } from '../unit-tests/extension-reload-failure-test.js';
import { runTests as runExtensionSettingsTests } from '../unit-tests/extension-settings-test.js';
import { runTests as runUserCommandFactoryTests } from '../unit-tests/user-command-factory-test.js';
import { runTests as runEngineApiVectorTests } from '../unit-tests/engineapi-vectors-test.js';
import { runTests as runDecodeHtmlEntitiesTests } from '../unit-tests/decode-html-entities-test.js';
import { runTests as runDiffUtilsTests } from '../unit-tests/diff-utils-test.js';
import { runTests as runStrategyFallbackTests } from '../unit-tests/strategy-fallback-test.js';
import { runTests as runStrategyHiddenTests } from '../unit-tests/strategy-hidden-test.js';
import { runTests as runStrategyHookThreadScopeTests } from '../unit-tests/strategy-hook-thread-scope-test.js';
import { runTests as runDelegatedSteeringTests } from '../unit-tests/delegated-thread-steering-test.js';
import { runTests as runStrategyOrderTests } from '../unit-tests/strategy-order-test.js';
import { runTests as runStrategyMenuRefreshTests } from '../unit-tests/strategy-menu-refresh-test.js';
import { runTests as runPermissionPopupRefreshTests } from '../unit-tests/permission-popup-refresh-test.js';
import { runTests as runClipboardTests } from '../unit-tests/clipboard-test.js';
import { runTests as runConnectivityTests } from '../unit-tests/connectivity-test.js';
import { runTests as runLogsTests } from '../unit-tests/logs-test.js';
import { runTests as runUpdatesSettingsTests } from '../unit-tests/updates-settings-test.js';
import { runTests as runSettingsFirstLoadTests } from '../unit-tests/settings-first-load-test.js';
import { runTests as runProxySettingsTests } from '../unit-tests/proxy-settings-test.js';
import { runTests as runReconnectPolicyTests } from '../unit-tests/reconnect-policy-test.js';
import { runTests as runResyncOfflineEditTests } from '../unit-tests/resync-offline-edit-test.js';
import { runTests as runPopupBackButtonTests } from '../unit-tests/popup-back-button-test.js';
import { runTests as runPopupSurfaceTests } from '../unit-tests/popup-surface-test.js';
import { runTests as runModelDisplayTests } from '../unit-tests/model-display-test.js';
import { runTests as runEngineProjectSwitchTests } from '../unit-tests/engine-project-switch-test.js';
import { runTests as runWindowTitleTests } from '../unit-tests/window-title-test.js';
import './golden-comparator.js'; // Initialize window.__integrationTestHelpers
import logger from './test-logger.js';
import {
  installClaimAutoRegistration,
  snapshotOwnConversationIds,
  deleteOwnConversationsCreatedSince,
  setCurrentTestName
} from './conversation-claims.js';
import { setTestDeadline, clearTestDeadline } from './test-deadline.js';
import { fetchProjectSize, projectSizeLines } from './project-size.js';

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
  ...queryCodeTests,
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
  ...linkClickTests,
  ...footerCacheTests,
  ...footerUndoOfferTests,
  ...imageAttachmentTests,
  ...continueBtnTests,
  ...commandApprovalTests,
  ...undoStateMachineTests,
  ...multiViewerTests,
  ...clearTests,
  ...recentsOrderTests,
  ...composerTurnGuardTests,
  ...queuedMessageTests,
  ...monitorDeliveryTests,
  ...monitorKillTests,
  ...largeOutputTests,
  ...backgroundOutputTests,
  ...memoryTests,
  ...attentionAlertTests,
  ...binGuardTests,
  ...modelAvailabilityTests
].map(t => ({ ...t, name: `integration:${t.name}` }));

/**
 * All unit test suites — each runs in its own isolated browser tab.
 * Each entry is a { name, run } pair where run(ctx) returns { passed, failed, errors }.
 * Names appear as individual test entries in listTests() and are addressable via -run.
 *
 * An entry may also set `needsExclusiveRun: true`, which makes the Go runner
 * schedule it alone with no sibling lane in flight. Set it when a suite asserts
 * on `document.activeElement`: every lane is an iframe inside ONE window, and a
 * window has exactly one focused frame, so any sibling calling element.focus()
 * takes frame focus away and blurs this lane's element to <body> — the suite
 * then fails on the pool's topology rather than on the code under test.
 */
const UNIT_TEST_SUITES = [
  { name: 'unit:context-cache-impact', run: runContextCacheImpactTests },
  { name: 'unit:cache-baseline-anchor', run: runCacheBaselineAnchorTests },
  { name: 'unit:code-lines', run: runCodeLinesTests },
  { name: 'unit:cache-miss-warning', run: runCacheMissWarningTests },
  { name: 'unit:error-retry-gate', run: runErrorRetryGateTests },
  { name: 'unit:auth-error-action', run: runAuthErrorActionTests },
  { name: 'unit:keyless-signin-status', run: runKeylessSignInStatusTests },
  { name: 'unit:token-cache-unknown', run: runTokenCacheUnknownTests },
  { name: 'unit:compaction-status', run: runCompactionStatusTests },
  { name: 'unit:status-message-format', run: runStatusMessageFormatTests },
  { name: 'unit:key-shortcut-manager', run: runKeyShortcutManagerTests },
  // Exclusive: the Escape preference is one localStorage key on an origin every
  // lane shares, so writing it mid-run would change a sibling's answer.
  { name: 'unit:escape-behaviour', run: runEscapeBehaviourTests, needsExclusiveRun: true },
  { name: 'unit:hold-to-cycle', run: runHoldToCycleTests },
  { name: 'unit:recent-models', run: runRecentModelsTests },
  { name: 'unit:pinboard', run: runPinboardTests },
  // Exclusive: it asserts where focus lands when the board opens and closes, and
  // a sibling lane calling focus() takes frame focus away mid-assertion.
  { name: 'unit:pinboard-shell', run: runPinboardShellTests, needsExclusiveRun: true },
  { name: 'unit:usage-stats-cache', run: runUsageStatsCacheTests },
  { name: 'unit:thinking-cycler', run: runThinkingCyclerTests },
  { name: 'unit:thinking-chip', run: runThinkingChipTests },
  { name: 'unit:service-tier-control', run: runServiceTierControlTests },
  { name: 'unit:service-tier-chip', run: runServiceTierChipTests },
  { name: 'unit:transaction-panel', run: runTransactionPanelTests },
  { name: 'unit:model-selector-hud', run: runModelSelectorHudTests },
  { name: 'unit:model-picker', run: runModelPickerTests },
  { name: 'unit:defaults-model-host', run: runDefaultsModelHostTests },
  { name: 'unit:command-editor', run: runCommandEditorTests },
  { name: 'unit:find', run: runFindTests },
  { name: 'unit:context-item-persistence', run: runContextItemPersistenceTests },
  { name: 'unit:context-item-seed-execute', run: runContextItemSeedExecuteTests },
  { name: 'unit:conversation-name-persistence', run: runConversationNameTests },
  { name: 'unit:conversation-naming', run: runConversationNamingTests },
  { name: 'unit:new-conversation-system-prompt', run: runNewConversationSystemPromptTests },
  { name: 'unit:one-shot-run', run: runOneShotRunTests },
  { name: 'unit:draft-persistence', run: runDraftPersistenceTests },
  { name: 'unit:draft-close-flush', run: runDraftCloseFlushTests },
  { name: 'unit:message-history', run: runMessageHistoryTests },
  { name: 'unit:paste-token', run: runPasteTokenTests },
  { name: 'unit:draft-tab-switch', run: runDraftTabSwitchTests },
  { name: 'unit:edit-permission', run: runEditPermissionTests },
  { name: 'unit:execute-action', run: runExecuteActionTests },
  { name: 'unit:filesystem-api', run: runFileSystemApiTests },
  { name: 'unit:glob-action', run: runGlobActionTests },
  { name: 'unit:item-accessor', run: runItemAccessorTests },
  { name: 'unit:message-type-guard', run: runMessageTypeGuardTests },
  { name: 'unit:model-filter', run: runModelFilterTests },
  { name: 'unit:monitor-tools', run: runMonitorToolsTests },
  { name: 'unit:tool-schema', run: runToolSchemaTests },
  { name: 'unit:tool-list-readiness', run: runToolListReadinessTests },
  { name: 'unit:transaction-tool-list', run: runTransactionToolListTests },
  { name: 'unit:thread-tool-inventory', run: runThreadToolInventoryTests },
  { name: 'unit:mcp-approval-toolname', run: runMcpApprovalToolNameTests },
  { name: 'unit:mcp-evaluate-toolname', run: runMcpEvaluateToolNameTests },
  { name: 'unit:mcp-settings', run: runMcpSettingsTests },
  { name: 'unit:acp-settings', run: runAcpSettingsTests },
  { name: 'unit:system-prompt-builder', run: runSystemPromptBuilderTests },
  { name: 'unit:system-prompt-registry', run: runSystemPromptRegistryTests },
  { name: 'unit:extensions-disabled', run: runExtensionsDisabledTests },
  { name: 'unit:strategy-injection', run: runStrategyInjectionTests },
  { name: 'unit:observer-decoupling', run: runObserverDecouplingTests },
  { name: 'unit:tool-pending-hook', run: runToolPendingHookTests },
  { name: 'unit:context-turn-hook', run: runContextTurnHookTests },
  { name: 'unit:handoff-promotion', run: runHandoffPromotionTests },
  { name: 'unit:read-file-action', run: runReadFileActionTests },
  { name: 'unit:path-input-quotes', run: runPathInputQuotesTests },
  { name: 'unit:mobile-composer', run: runMobileComposerTests },
  { name: 'unit:composer-send-latch', run: runComposerSendLatchTests },
  { name: 'unit:scheduled-send', run: runScheduledSendTests },
  { name: 'unit:sidebar-drawer', run: runSidebarDrawerTests },
  { name: 'unit:swipe-dismiss', run: runSwipeDismissTests },
  { name: 'unit:info-rail', run: runInfoRailTests },
  { name: 'unit:tab-drag-ghost', run: runTabDragGhostTests },
  { name: 'unit:reorder-drag', run: runReorderDragTests },
  { name: 'unit:slash-completion', run: runSlashCompletionTests },
  { name: 'unit:skill-completion', run: runSkillCompletionTests },
  { name: 'unit:search-action', run: runSearchActionTests },
  { name: 'unit:tool-cancellation', run: runToolCancellationTests },
  { name: 'unit:unbounded-await', run: runUnboundedAwaitTests },
  { name: 'unit:modal-supersede', run: runModalSupersedeTests },
  { name: 'unit:conversation-release', run: runConversationReleaseTests },
  { name: 'unit:load-queue-recycle', run: runLoadQueueRecycleTests },
  { name: 'unit:unloaded-tab-hydration', run: runUnloadedTabHydrationTests },
  { name: 'unit:refresh-merge', run: runRefreshMergeTests },
  { name: 'unit:tab-order-merge', run: runTabOrderMergeTests },
  { name: 'unit:tab-drag-order', run: runTabDragOrderTests },
  { name: 'unit:tool-execution-order', run: runToolExecutionOrderTests },
  { name: 'unit:tool-action-render', run: runToolActionRenderTests },
  { name: 'unit:juggler-spinner-live', run: runJugglerSpinnerLiveTests },
  { name: 'unit:submit-plan-action', run: runSubmitPlanActionTests },
  { name: 'unit:plan-approval', run: runPlanApprovalTests },
  { name: 'unit:todo-action', run: runTodoActionTests },
  { name: 'unit:todo-no-approval', run: runTodoNoApprovalTests },
  { name: 'unit:thread-nested-array', run: runThreadNestedArrayTests },
  { name: 'unit:undo-redo', run: runUndoRedoTests },
  { name: 'unit:header-undo-lock', run: runHeaderUndoLockTests },
  { name: 'unit:footer-meta', run: runFooterMetaTests },
  { name: 'unit:write-file-action', run: runWriteFileActionTests },
  { name: 'unit:yjs-compat', run: runYjsCompatTests },
  { name: 'unit:base64', run: runBase64Tests },
  { name: 'unit:ws-chunk', run: runWSChunkTests },
  { name: 'unit:render-performance', run: runRenderPerformanceTests },
  { name: 'unit:test-budget', run: runTestBudgetTests },
  { name: 'unit:engine-autoload', run: runEngineAutoloadTests },
  { name: 'unit:sync-batch-backoff', run: runSyncBatchBackoffTests },
  { name: 'unit:sync-fault-isolation', run: runSyncFaultIsolationTests },
  { name: 'unit:thinking-stream', run: runThinkingStreamTests },
  { name: 'unit:streaming-row-scope', run: runStreamingRowScopeTests },
  { name: 'unit:streaming-markdown', run: runStreamingMarkdownTests },
  { name: 'unit:markdown-sanitizer', run: runMarkdownSanitizerTests },
  { name: 'unit:markdown-scoped-css', run: runMarkdownScopedCssTests },
  { name: 'unit:markdown-task-list', run: runMarkdownTaskListTests },
  { name: 'unit:user-message-markdown', run: runUserMessageMarkdownTests },
  { name: 'unit:external-link', run: runExternalLinkTests },
  { name: 'unit:link-guard', run: runLinkGuardTests },
  { name: 'unit:ansi', run: runAnsiTests },
  { name: 'unit:ui-pref-scope', run: runUIPrefScopeTests },
  { name: 'unit:tool-name-resolution', run: runToolNameResolutionTests },
  { name: 'unit:new-tab-ux', run: runNewTabUxTests },
  { name: 'unit:bin-undo-toast', run: runBinUndoToastTests },
  { name: 'unit:bin-empty-menu', run: runBinEmptyMenuTests },
  { name: 'unit:restore-select-panel', run: runRestoreSelectPanelTests },
  { name: 'unit:conversation-focus-policy', run: runConversationFocusPolicyTests },
  { name: 'unit:unclaimed-conversations', run: runUnclaimedConversationsTests },
  { name: 'unit:thread-column-selection', run: runThreadColumnSelectionTests },
  { name: 'unit:thread-selection-pin', run: runThreadSelectionPinTests },
  // Exclusive: it asserts on document.activeElement, which every lane in the
  // shared origin can move.
  { name: 'unit:thread-pin-survives-reveal', run: runThreadPinSurvivesRevealTests, needsExclusiveRun: true },
  { name: 'unit:parallel-thread-selection', run: runParallelThreadSelectionTests },
  { name: 'unit:pinboard-thread-source', run: runPinboardThreadSourceTests },
  { name: 'unit:pinboard-file-edits', run: runPinboardFileEditsTests },
  { name: 'unit:pinboard-tasks', run: runPinboardTasksTests },
  { name: 'unit:pinboard-retention', run: runPinboardRetentionTests },
  // Exclusive: it puts the whole document into pinboard mode for the length of
  // a case, and a suite sharing the lane would boot into the wrong shell.
  { name: 'unit:pinboard-satellite', run: runPinboardSatelliteTests, needsExclusiveRun: true },
  { name: 'unit:scroll-away-autofollow', run: runScrollAwayAutofollowTests },
  { name: 'unit:scroll-to-top', run: runScrollToTopTests },
  { name: 'unit:auto-follow-holds-the-end', run: runAutoFollowHoldsTheEndTests },
  { name: 'unit:user-send-follow', run: runUserSendFollowTests },
  { name: 'unit:empty-conversation-hint', run: runEmptyConversationHintTests },
  { name: 'unit:column-file-drop', run: runColumnFileDropTests },
  { name: 'unit:column-navigation', run: runColumnNavigationTests },
  // Exclusive for the shared origin: one case writes the tool-grouping
  // localStorage preference, which every lane's renderer reads.
  { name: 'unit:delete-selection-neighbour', run: runDeleteSelectionNeighbourTests, needsExclusiveRun: true },
  { name: 'unit:control-click-reveal', run: runControlClickRevealTests },
  { name: 'unit:tab-hide-focus', run: runTabHideFocusTests },
  { name: 'unit:new-thread-focus', run: runNewThreadFocusTests, needsExclusiveRun: true },
  { name: 'unit:approval-focus-return', run: runApprovalFocusReturnTests, needsExclusiveRun: true },
  { name: 'unit:approval-draft-focus', run: runApprovalDraftFocusTests, needsExclusiveRun: true },
  { name: 'unit:nested-approval-status', run: runNestedApprovalStatusTests },
  { name: 'unit:concurrent-runs', run: runConcurrentRunsTests },
  { name: 'unit:run-records', run: runRunRecordsTests },
  { name: 'unit:thread-alias', run: runThreadAliasTests },
  // Exclusive not for focus but for the shared origin: this suite writes the
  // tool-grouping localStorage preference, which every lane's renderer reads.
  { name: 'unit:tool-grouping', run: runToolGroupingTests, needsExclusiveRun: true },
  { name: 'unit:chime-recovery', run: runChimeRecoveryTests },
  // Exclusive for the shared origin: this suite writes the attention prefs, and
  // one of them (tabReorder) gates every lane's Session.bumpConversation.
  { name: 'unit:tab-behaviour-prefs', run: runTabBehaviourPrefsTests, needsExclusiveRun: true },
  { name: 'unit:context-menu', run: runContextMenuTests },
  { name: 'unit:disconnection-overlay', run: runDisconnectionOverlayTests },
  { name: 'unit:extension-registry', run: runExtensionRegistryTests },
  { name: 'unit:file-viewer-registry', run: runFileViewerRegistryTests },
  { name: 'unit:pdf-viewer', run: runPdfViewerTests },
  { name: 'unit:file-view', run: runFileViewTests },
  { name: 'unit:sdk-facade-parity', run: runSdkFacadeParityTests },
  { name: 'unit:extension-collision', run: runExtensionCollisionTests },
  { name: 'unit:extension-catalog', run: runExtensionCatalogTests },
  { name: 'unit:extension-reload-failure', run: runExtensionReloadFailureTests },
  { name: 'unit:extension-settings', run: runExtensionSettingsTests },
  { name: 'unit:user-command-factory', run: runUserCommandFactoryTests },
  { name: 'unit:engineapi-vectors', run: runEngineApiVectorTests },
  { name: 'unit:decode-html-entities', run: runDecodeHtmlEntitiesTests },
  { name: 'unit:diff-utils', run: runDiffUtilsTests },
  { name: 'unit:strategy-fallback', run: runStrategyFallbackTests },
  { name: 'unit:strategy-hidden', run: runStrategyHiddenTests },
  { name: 'unit:strategy-hook-thread-scope', run: runStrategyHookThreadScopeTests },
  { name: 'unit:delegated-thread-steering', run: runDelegatedSteeringTests },
  { name: 'unit:strategy-order', run: runStrategyOrderTests },
  { name: 'unit:strategy-menu-refresh', run: runStrategyMenuRefreshTests },
  { name: 'unit:permission-popup-refresh', run: runPermissionPopupRefreshTests },
  { name: 'unit:clipboard', run: runClipboardTests },
  { name: 'unit:connectivity', run: runConnectivityTests },
  { name: 'unit:logs', run: runLogsTests },
  { name: 'unit:updates-settings', run: runUpdatesSettingsTests },
  { name: 'unit:settings-first-load', run: runSettingsFirstLoadTests },
  { name: 'unit:proxy-settings', run: runProxySettingsTests },
  { name: 'unit:reconnect-policy', run: runReconnectPolicyTests },
  { name: 'unit:resync-offline-edit', run: runResyncOfflineEditTests },
  { name: 'unit:popup-back-button', run: runPopupBackButtonTests },
  { name: 'unit:popup-surface', run: runPopupSurfaceTests, needsExclusiveRun: true },
  { name: 'unit:model-display', run: runModelDisplayTests },
  { name: 'unit:engine-project-switch', run: runEngineProjectSwitchTests },
  { name: 'unit:window-title', run: runWindowTitleTests },
];

/**
 * Extension-owned unit suites, discovered at runtime rather than hand-listed
 * here. Each extension declares its tests in its manifest (provides.tests); the
 * test harness resolves them and serves the list at /api/test/extension-tests.
 * Populated by ensureExtensionSuitesLoaded().
 * @type {{name: string, run: function(any): Promise<{passed: number, failed: number, errors: string[]}>}[]}
 */
let EXTENSION_SUITES = [];

/** @type {Promise<void>|null} Memoized loader promise; see ensureExtensionSuitesLoaded. */
let _extensionSuitesPromise = null;

/**
 * Discover and register extension-owned test suites, once. Fetches the
 * manifest-driven list from the test harness, dynamic-imports each module
 * (whose runTests export becomes a unit suite named e.g. "unit:exa-search"),
 * and memoizes the result so repeated calls are cheap. Idempotent and safe to
 * await from listTests()'s callers, runTests(), and runTestByName().
 * @returns {Promise<void>}
 */
export function ensureExtensionSuitesLoaded() {
  if (!_extensionSuitesPromise) {
    _extensionSuitesPromise = (async () => {
      const prefix = /** @type {any} */ (window).__assetPrefix || '';
      /** @type {{name: string, path: string}[]} */
      let list = [];
      try {
        const resp = await fetch('/api/test/extension-tests');
        if (resp.ok) {
          const data = await resp.json();
          list = Array.isArray(data.tests) ? data.tests : [];
        }
      } catch (_) { /* endpoint absent (e.g. no source checkout) — run internal suites only */ }
      /** @type {typeof EXTENSION_SUITES} */
      const suites = [];
      for (const entry of list) {
        if (!entry || !entry.name || !entry.path) continue;
        try {
          const mod = await import(prefix + entry.path);
          if (typeof mod.runTests === 'function') {
            suites.push({ name: entry.name, run: mod.runTests });
            continue;
          }
          throw new Error('module has no runTests export');
        } catch (err) {
          // A broken/unloadable extension test must fail loudly as its own
          // suite, never silently vanish from the run.
          suites.push({
            name: entry.name,
            run: async () => ({ passed: 0, failed: 1, errors: [`${entry.name}: failed to load ${entry.path}: ${err}`] }),
          });
        }
      }
      EXTENSION_SUITES = suites;
    })();
  }
  return _extensionSuitesPromise;
}

/**
 * Run all integration tests sequentially.
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results
 */
export async function runTests(ctx) {
  installClaimAutoRegistration();
  await waitForEngineConnected();
  await ensureExtensionSuitesLoaded();
  logger.essential(`Starting integration tests...`);
  logger.info(`Running ${ALL_TESTS.length} mock-LLM tests + ${UNIT_TEST_SUITES.length + EXTENSION_SUITES.length} unit suites`);
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
  for (const suite of [...UNIT_TEST_SUITES, ...EXTENSION_SUITES]) {
    const result = await runUnitSuiteWithConvCleanup(suite, /** @type {any} */ (ctx));
    unitPassed += result.passed;
    unitFailed += result.failed;
    errors.push(...result.errors);
  }

  return { passed: passed + unitPassed, failed: failed + unitFailed, errors };
}

/**
 * How long a unit suite may run for.
 *
 * The Go harness stops polling for this test's result at 60s, so the number to
 * pick is the largest that still leaves the failure reported HERE, naming the
 * suite, rather than there as a bare poll timeout naming nothing. 45s leaves
 * the result POST (itself retried for up to 10s) and the suite's conversation
 * cleanup room to finish inside that window.
 *
 * It buys nothing on a passing suite — the slowest of them is a couple of
 * seconds, and about six under a saturated machine.
 */
const UNIT_SUITE_BUDGET_MS = 45000;

/** Sentinel distinguishing "the budget expired" from a suite's own result. */
const SUITE_TIMED_OUT = Symbol('unit-suite-timed-out');

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
  // Arm the budget every wait in this suite rides, and bound the suite itself.
  //
  // Without the deadline, a unit suite's waits fall back to nominal timeouts
  // chosen when a lane had the pool to itself — the reason a full run kept
  // losing one arbitrary unit suite to load. Without the hard bound, a suite
  // that wedges never posts a result at all and the Go side reports a bare
  // "timeout polling /api/test/result after 1m0s" naming nothing; here it at
  // least says which suite stopped and when.
  setTestDeadline(Date.now() + UNIT_SUITE_BUDGET_MS);
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
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(SUITE_TIMED_OUT), UNIT_SUITE_BUDGET_MS);
    });
    // A timeout is reported as a failed result rather than thrown, so one
    // wedged suite fails alone instead of ending the lane's whole run.
    const outcome = await Promise.race([
      suite.run(ctx).finally(() => clearTimeout(timer)),
      timedOut
    ]);
    if (outcome === SUITE_TIMED_OUT) {
      return {
        passed: 0,
        failed: 1,
        errors: [
          `${suite.name}: unit suite timed out after ${UNIT_SUITE_BUDGET_MS}ms — it stopped making progress and never returned a result`,
          ...projectSizeLines(await fetchProjectSize())
        ]
      };
    }
    const result = /** @type {{passed: number, failed: number, errors: string[]}} */ (outcome);
    // Every lane shares one project, so how many conversations were in it is a
    // property of the run rather than of this suite — and a suite that fails
    // only under a full pool is the one case where that number is the evidence.
    // Integration tests carry the same two lines (see projectSizeLines).
    if (result.failed > 0) {
      result.errors = [...result.errors, ...projectSizeLines(await fetchProjectSize())];
    }
    return result;
  } finally {
    // Disarm before cleanup: the deadline belongs to the suite, and cleanup
    // running under an expired one would give every wait in it a zero budget.
    clearTestDeadline();
    neutralizeStrayModals();
    // A suite that saved a command, a skill or a plugin toggle left a registry
    // rebuild running behind it — those call sites deliberately don't await one
    // (see whenRegistriesSettled). The suites of a lane share one realm and
    // therefore one set of registries, so an outstanding rebuild is the next
    // suite's problem: it would find the registries reset and read an empty
    // one. Wait it out here, where the ownership boundary is. Best-effort — a
    // rebuild that rejects (a plugin whose init throws) must not mask the
    // suite's own result.
    await whenRegistriesSettled().catch(() => {});
    await deleteOwnConversationsCreatedSince(before, `unit-cleanup:${suite.name}`);
    // Client-side counterpart of the delete above: that frees the server's
    // copy, this frees ours. A Session the suite left alive holds a Yjs doc
    // per conversation in the shared project, and the lane page outlives
    // every suite it runs, so an unswept one is retained for the whole run.
    destroyTrackedTestSessions();
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
  await ensureExtensionSuitesLoaded();
  const names = testName.split(',').map(s => s.trim()).filter(Boolean);

  // Check if any name belongs to a unit test suite (internal or extension-owned)
  const unitSuite = names.length === 1
    ? [...UNIT_TEST_SUITES, ...EXTENSION_SUITES].find(s => s.name === names[0])
    : null;
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
    ...EXTENSION_SUITES.map(s => s.name),
  ];
}

/**
 * List tests the Go runner must schedule sequentially, with no sibling lane in
 * flight. Two independent reasons qualify, both about state the lanes share and
 * cannot namespace per-test:
 *
 *   - `pollutesFixtureRoot` (integration tests): writes a fixed-name file to
 *     the shared fixture root that production auto-detection scans, which a
 *     sibling lane's createConversation would pick up.
 *   - `needsExclusiveRun` (unit suites): asserts on `document.activeElement`,
 *     which a sibling lane can invalidate by calling focus() — all lanes are
 *     iframes in one window, and only one frame holds focus at a time.
 * @returns {string[]} Names of tests that must run in isolation
 */
export function listExclusiveTests() {
  return [
    ...ALL_TESTS.filter(t => t.pollutesFixtureRoot).map(t => t.name),
    ...UNIT_TEST_SUITES.filter(s => s.needsExclusiveRun).map(s => s.name),
  ];
}
