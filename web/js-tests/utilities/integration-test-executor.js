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
import { destroyTrackedTestSessions, neutralizeStrayOverlays, waitFor } from './test-helpers.js';
import { __whenRegistriesSettledForTests } from '../../js/registries/reload-registries.js';
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
import { tests as scheduledSendTests } from '../integration-tests/scheduled-send-tests.js';
import { tests as monitorDeliveryTests } from '../integration-tests/monitor-delivery-tests.js';
import { tests as monitorKillTests } from '../integration-tests/monitor-kill-tests.js';
import { tests as largeOutputTests } from '../integration-tests/large-output-tests.js';
import { tests as backgroundOutputTests } from '../integration-tests/background-output-tests.js';
import { tests as memoryTests } from '../integration-tests/memory-tests.js';
import { tests as attentionAlertTests } from '../integration-tests/attention-alert-tests.js';
import { tests as binGuardTests } from '../integration-tests/bin-guard-tests.js';
import { tests as modelAvailabilityTests } from '../integration-tests/model-availability-tests.js';
import { tests as appPseudoLocaleWalkTests } from '../integration-tests/app-pseudo-locale-walk-tests.js';
import { runTests as runContextCacheImpactTests } from '../unit-tests/context-cache-impact-test.js';
import { runTests as runCacheBaselineAnchorTests } from '../unit-tests/cache-baseline-anchor-test.js';
import { runTests as codeLinesTests } from '../unit-tests/code-lines-test.js';
import { runTests as runCacheMissWarningTests } from '../unit-tests/cache-miss-warning-test.js';
import { runTests as runFileContentFreezeTests } from '../unit-tests/file-content-freeze-test.js';
import { runTests as runErrorRetryGateTests } from '../unit-tests/error-retry-gate-test.js';
import { runTests as runAuthErrorActionTests } from '../unit-tests/auth-error-action-test.js';
import { runTests as runAutoContinueErrorTests } from '../unit-tests/auto-continue-error-test.js';
import { runTests as runKeylessSignInStatusTests } from '../unit-tests/keyless-signin-status-test.js';
import { runTests as runTokenCacheUnknownTests } from '../unit-tests/token-cache-unknown-test.js';
import { runTests as runCompactionStatusTests } from '../unit-tests/compaction-status-test.js';
import { runTests as runStatusMessageFormatTests } from '../unit-tests/status-message-format-test.js';
import { runTests as runStatusMessageBuilderTests } from '../unit-tests/status-message-builder-test.js';
import { runTests as runConversationAreaRenderingTests } from '../unit-tests/conversation-area-rendering-test.js';
import { runTests as runConversationAreaTests } from '../unit-tests/conversation-area-test.js';
import { runTests as runTrailingTurnOutcomeTests } from '../unit-tests/trailing-turn-outcome-test.js';
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
import { runTests as runItemFieldTests } from '../unit-tests/item-field-test.js';
import { runTests as runMessageTypeGuardTests } from '../unit-tests/message-type-guard-test.js';
import { runTests as runModelFilterTests } from '../unit-tests/model-filter-test.js';
import { runTests as runMonitorToolsTests } from '../unit-tests/monitor-tools-test.js';
import { runTests as runToolSchemaTests } from '../unit-tests/tool-schema-test.js';
import { runTests as runToolListReadinessTests } from '../unit-tests/tool-list-readiness-test.js';
import { runTests as runTransactionToolListTests } from '../unit-tests/transaction-tool-list-test.js';
import { runTests as runThreadToolInventoryTests } from '../unit-tests/thread-tool-inventory-test.js';
import { runTests as runMcpEvaluateToolNameTests } from '../unit-tests/mcp-evaluate-toolname-test.js';
import { runTests as runMcpSettingsTests } from '../unit-tests/mcp-settings-test.js';
import { runTests as runAcpSettingsTests } from '../unit-tests/acp-settings-test.js';
import { runTests as runSystemPromptBuilderTests } from '../unit-tests/system-prompt-builder-test.js';
import { runTests as runSystemPromptRegistryTests } from '../unit-tests/system-prompt-registry-test.js';
import { runTests as runExtensionsDisabledTests } from '../unit-tests/extensions-disabled-test.js';
import { runTests as runRoundTripTimingTests } from '../unit-tests/roundtrip-timing-test.js';
import { runTests as runWorkerBroadcastTests } from '../unit-tests/worker-broadcast-test.js';
import { runTests as runWorkerInboundTests } from '../unit-tests/worker-inbound-test.js';
import { runTests as runRegistryInitRaceTests } from '../unit-tests/registry-init-race-test.js';
import { runTests as runStrategyInjectionTests } from '../unit-tests/strategy-injection-test.js';
import { runTests as runObserverDecouplingTests } from '../unit-tests/observer-decoupling-test.js';
import { runTests as runToolPendingHookTests } from '../unit-tests/tool-pending-hook-test.js';
import { runTests as runToolHooksTests } from '../unit-tests/tool-hooks-test.js';
import { runTests as runToolResultTerminalTests } from '../unit-tests/tool-result-terminal-test.js';
import { runTests as runToolCommandResyncTests } from '../unit-tests/tool-command-resync-test.js';
import { runTests as runToolCallDecisionTests } from '../unit-tests/tool-call-decision-test.js';
import { runTests as runToolInvokerTests } from '../unit-tests/tool-invoker-test.js';
import { runTests as runProgramChangeReportTests } from '../unit-tests/program-change-report-test.js';
import { runTests as runDenyCascadeTests } from '../unit-tests/deny-cascade-test.js';
import { runTests as runTokenMeterRecoveryTests } from '../unit-tests/token-meter-recovery-test.js';
import { runTests as runContextTurnHookTests } from '../unit-tests/context-turn-hook-test.js';
import { runTests as runHandoffPromotionTests } from '../unit-tests/handoff-promotion-test.js';
import { runTests as runReadFileActionTests } from '../unit-tests/read-file-action-test.js';
import { runTests as runReadTruncationTests } from '../unit-tests/read-truncation-test.js';
import { runTests as runPathInputQuotesTests } from '../unit-tests/path-input-quotes-test.js';
import { runTests as runPathInputMenuTests } from '../unit-tests/path-input-menu-test.js';
import { runTests as runPathContainmentTests } from '../unit-tests/path-containment-test.js';
import { runTests as runDebounceTests } from '../unit-tests/debounce-test.js';
import { runTests as runSearchActionTests } from '../unit-tests/search-action-test.js';
import { runTests as runToolCancellationTests } from '../unit-tests/tool-cancellation-test.js';
import { runTests as runUnboundedAwaitTests } from '../unit-tests/unbounded-await-test.js';
import { runTests as runModalSupersedeTests } from '../unit-tests/modal-supersede-test.js';
import { runTests as runModalDialogTests } from '../unit-tests/modal-dialog-test.js';
import { runTests as runHttpErrorsTests } from '../unit-tests/http-errors-test.js';
import { runTests as runOpsApiArgumentsTests } from '../unit-tests/ops-api-arguments-test.js';
import { runTests as runOpsApiSignalTests } from '../unit-tests/ops-api-signal-test.js';
import { runTests as runCancelSettleTests } from '../unit-tests/cancel-settle-test.js';
import { runTests as runItemsArrayWaitTests } from '../unit-tests/items-array-wait-test.js';
import { runTests as runSessionOwnershipTests } from '../unit-tests/session-ownership-test.js';
import { runTests as runBusyStateTests } from '../unit-tests/busy-state-test.js';
import { runTests as runUiPortTests } from '../unit-tests/ui-port-test.js';
import { runTests as runEventFeedsTests } from '../unit-tests/event-feeds-test.js';
import { runTests as runApprovalButtonsTests } from '../unit-tests/approval-buttons-test.js';
import { runTests as runApprovalHintTests } from '../unit-tests/approval-hint-test.js';
import { runTests as runResponseHandlerModelTextTests } from '../unit-tests/response-handler-model-text-test.js';
import { runTests as runCapabilityCatalogTests } from '../unit-tests/capability-catalog-test.js';
import { runTests as runSetupWizardTests } from '../unit-tests/setup-wizard-test.js';
import { runTests as runWarningFallbackTests } from '../unit-tests/warning-fallback-test.js';
import { runTests as runConversationReleaseTests } from '../unit-tests/conversation-release-test.js';
import { runTests as runLoadQueueRecycleTests } from '../unit-tests/load-queue-recycle-test.js';
import { runTests as runUnloadedTabHydrationTests } from '../unit-tests/unloaded-tab-hydration-test.js';
import { runTests as runRefreshMergeTests } from '../unit-tests/refresh-merge-test.js';
import { runTests as runWorkerInitDeclinedTests } from '../unit-tests/worker-init-declined-test.js';
import { runTests as runTabOrderMergeTests } from '../unit-tests/tab-order-merge-test.js';
import { runTests as runTabDragOrderTests } from '../unit-tests/tab-drag-order-test.js';
import { runTests as runTabKeyboardMoveTests } from '../unit-tests/tab-keyboard-move-test.js';
import { runTests as runTabDragAcrossWorkspaceTests } from '../unit-tests/tab-drag-across-workspace-test.js';
import {
  runTests as runTabDragWorkspaceOrderTests,
  runDropSweepTests as runTabDragWorkspaceDropSweepTests,
  runDropSweepMemberTests as runTabDragWorkspaceDropSweepMemberTests
} from '../unit-tests/tab-drag-workspace-order-test.js';
import { runTests as runToolActionRenderTests } from '../unit-tests/tool-action-render-test.js';
import { runTests as runComponentTeardownTests } from '../unit-tests/component-teardown-test.js';
import { runTests as runJugglerSpinnerLiveTests } from '../unit-tests/juggler-spinner-live-test.js';
import { runTests as runSubmitPlanActionTests } from '../unit-tests/submit-plan-action-test.js';
import { runTests as runPlanApprovalTests } from '../unit-tests/plan-approval-test.js';
import { runTests as runTodoActionTests } from '../unit-tests/todo-action-test.js';
import { runTests as runTodoNoApprovalTests } from '../unit-tests/todo-no-approval-test.js';
import { runTests as runThreadNestedArrayTests } from '../unit-tests/thread-nested-array-test.js';
import { runTests as runUndoRedoTests } from '../unit-tests/undo-redo-test.js';
import { runTests as runUndoRedoContextItemsTests } from '../unit-tests/undo-redo-context-items-test.js';
import { runTests as runUndoRedoToolsTests } from '../unit-tests/undo-redo-tools-test.js';
import { runTests as runUndoRedoDeletionTests } from '../unit-tests/undo-redo-deletion-test.js';
import { runTests as runUndoRedoDeletionEdgesTests } from '../unit-tests/undo-redo-deletion-edges-test.js';
import { runTests as runHeaderUndoLockTests } from '../unit-tests/header-undo-lock-test.js';
import { runTests as runHeaderBarTests } from '../unit-tests/header-bar-test.js';
import { runTests as runFooterMetaTests } from '../unit-tests/footer-meta-test.js';
import { runTests as runConversationMarkdownTests } from '../unit-tests/conversation-markdown-test.js';
import { runTests as runConversationHtmlTests } from '../unit-tests/conversation-html-test.js';
import { runTests as runWriteFileActionTests } from '../unit-tests/write-file-action-test.js';
import { runTests as runYjsCompatTests } from '../unit-tests/yjs-compat-test.js';
import { runTests as runBase64Tests } from '../unit-tests/base64-test.js';
import { runTests as runWSChunkTests } from '../unit-tests/ws-chunk-test.js';
import { runTests as runRenderScalingTests } from '../unit-tests/render-scaling-tests.js';
import { runTests as runTestBudgetTests } from '../unit-tests/test-budget-test.js';
import { runTests as runExclusiveTestFlagsTests } from '../unit-tests/exclusive-test-flags-test.js';
import { runTests as runSuiteVerdictTests } from '../unit-tests/suite-verdict-test.js';
import { runTests as runSuiteDocumentIsolationTests } from '../unit-tests/suite-document-isolation-test.js';
import { runTests as runWaitReportTests } from '../unit-tests/wait-report-test.js';
import { runTests as runIsolateFocusTests } from '../unit-tests/isolate-focus-test.js';
import { runTests as runHoldBroadcastsTests } from '../unit-tests/hold-broadcasts-test.js';
import { runTests as runSuitePopupIsolationTests } from '../unit-tests/suite-popup-isolation-test.js';
import { runTests as runEngineAutoloadTests } from '../unit-tests/engine-autoload-test.js';
import { runTests as runSyncBatchBackoffTests } from '../unit-tests/sync-batch-backoff-test.js';
import { runTests as runSyncFaultIsolationTests } from '../unit-tests/sync-fault-isolation-test.js';
import { runTests as runThinkingStreamTests } from '../unit-tests/thinking-stream-test.js';
import { runTests as runStreamingRowScopeTests } from '../unit-tests/streaming-row-scope-test.js';
import { runTests as runThinkingMessageTests } from '../unit-tests/thinking-message-test.js';
import { runTests as runStreamingMarkdownTests } from '../unit-tests/streaming-markdown-test.js';
import { runTests as runFileRefsTests } from '../unit-tests/file-refs-test.js';
import { runTests as runFileRefLinksTests } from '../unit-tests/file-ref-links-test.js';
import { runTests as runMarkdownSanitizerTests } from '../unit-tests/markdown-sanitizer-test.js';
import { runTests as runMarkdownScopedCssTests } from '../unit-tests/markdown-scoped-css-test.js';
import { runTests as runSelectionColourTests } from '../unit-tests/selection-colour-test.js';
import { runTests as runSelectionContainmentTests } from '../unit-tests/selection-containment-test.js';
import { runTests as runMarkdownTaskListTests } from '../unit-tests/markdown-task-list-test.js';
import { runTests as runUserMessageMarkdownTests } from '../unit-tests/user-message-markdown-test.js';
import { runTests as runLanguageCoverageTests } from '../unit-tests/language-coverage-test.js';
import { runTests as runHighlightLinesTests } from '../unit-tests/highlight-lines-test.js';
import { runTests as runMarkdownHighlightTests } from '../unit-tests/markdown-highlight-test.js';
import { runTests as runDiffAsyncTests } from '../unit-tests/diff-async-test.js';
import { runTests as runDiffHighlightTests } from '../unit-tests/diff-highlight-test.js';
import { runTests as runDiffReviewTests } from '../unit-tests/diff-review-test.js';
import { runTests as runDiffSplitTests } from '../unit-tests/diff-split-test.js';
import { runTests as runExternalLinkTests } from '../unit-tests/external-link-test.js';
import { runTests as runApiUrlTests } from '../unit-tests/api-url-test.js';
import { runTests as runLinkGuardTests } from '../unit-tests/link-guard-test.js';
import { runTests as runAnsiTests } from '../unit-tests/ansi-test.js';
import { runTests as runPrefsTests } from '../unit-tests/prefs-test.js';
import { runTests as runColumnWidthTests } from '../unit-tests/column-width-test.js';
import { runTests as runColumnFitTests } from '../unit-tests/column-fit-test.js';
import { runTests as runColumnEdgeTests } from '../unit-tests/column-edge-test.js';
import { runTests as runTabListEdgeTests } from '../unit-tests/tab-list-edge-test.js';
import { runTests as runTabListFocusTests } from '../unit-tests/tab-list-focus-test.js';
import { runTests as runThinScrollbarTests } from '../unit-tests/thin-scrollbar-test.js';
import { runTests as runContextPreviewAbsentTests } from '../unit-tests/context-preview-absent-test.js';
import { runTests as runModalShellTests } from '../unit-tests/modal-shell-test.js';
import { runTests as runButtonVariantsTests } from '../unit-tests/button-variants-test.js';
import { runTests as runBadgeTintsTests } from '../unit-tests/badge-tints-test.js';
import { runTests as runTextOnAccentTests } from '../unit-tests/text-on-accent-test.js';
import { runTests as runTypeScaleTests } from '../unit-tests/type-scale-test.js';
import { runTests as runWarningTextTests } from '../unit-tests/warning-text-test.js';
import { runTests as runSurfacesTests } from '../unit-tests/surfaces-test.js';
import { runTests as runLabelStylesTests } from '../unit-tests/label-styles-test.js';
import { runTests as runFocusRingsTests } from '../unit-tests/focus-rings-test.js';
import { runTests as runZIndexScaleTests } from '../unit-tests/z-index-scale-test.js';
import { runTests as runFocusModalityTests } from '../unit-tests/focus-modality-test.js';
import { runTests as runThemeToggleTests } from '../unit-tests/theme-toggle-test.js';
import { runTests as runAppearancePrefsTests } from '../unit-tests/appearance-prefs-test.js';
import { runTests as runToolNameResolutionTests } from '../unit-tests/tool-name-resolution-test.js';
import { runTests as runNewTabUxTests } from '../unit-tests/new-tab-ux-test.js';
import { runTests as runConversationWorkspaceTests } from '../unit-tests/conversation-workspace-test.js';
import { runTests as runConversationWorkspaceBindingTests } from '../unit-tests/conversation-workspace-binding-test.js';
import { runTests as runConversationWorkspaceProvisionTests } from '../unit-tests/conversation-workspace-provision-test.js';
import { runTests as runConversationWorkspacePanelTests } from '../unit-tests/conversation-workspace-panel-test.js';
import { runTests as runConversationWorkspaceMoveTests } from '../unit-tests/conversation-workspace-move-test.js';
import { runTests as runWorkspaceFinishDialogTests } from '../unit-tests/workspace-finish-dialog-test.js';
import { runTests as runWorkspaceGroupsTests } from '../unit-tests/workspace-groups-test.js';
import { runTests as runWorkspaceBoxesTests } from '../unit-tests/workspace-boxes-test.js';
import { runTests as runTruncatedNameTooltipTests } from '../unit-tests/truncated-name-tooltip-test.js';
import { runTests as runConversationTabStatusTests } from '../unit-tests/conversation-tab-status-test.js';
import { runTests as runReorderDragHoldTests } from '../unit-tests/reorder-drag-hold-test.js';
import { runTests as runWorkspaceCreateDialogTests } from '../unit-tests/workspace-create-dialog-test.js';
import { runTests as runWorkspaceBoxDragTests } from '../unit-tests/workspace-box-drag-test.js';
import { runTests as runWorkspaceSelectionTests } from '../unit-tests/workspace-selection-test.js';
import { runTests as runWorkspaceRenameTests } from '../unit-tests/workspace-rename-test.js';
import { runTests as runConversationRenameTests } from '../unit-tests/conversation-rename-test.js';
import { runTests as runWorkspacePanelTests } from '../unit-tests/workspace-panel-test.js';
import { runTests as runBinUndoToastTests } from '../unit-tests/bin-undo-toast-test.js';
import { runTests as runBinFooterTests } from '../unit-tests/bin-footer-test.js';
import { runTests as runConversationBarTests } from '../unit-tests/conversation-bar-test.js';
import { runTests as runBinGhostResurrectionTests } from '../unit-tests/bin-ghost-resurrection-test.js';
import { runTests as runBinEmptyMenuTests } from '../unit-tests/bin-empty-menu-test.js';
import { runTests as runBinSizeNoticeTests } from '../unit-tests/bin-size-notice-test.js';
import { runTests as runAboutMenuTests } from '../unit-tests/about-menu-test.js';
import { runTests as runUpdateUiTests } from '../unit-tests/update-ui-test.js';
import { runTests as runModalScrimTests } from '../unit-tests/modal-scrim-test.js';
import { runTests as runRestoreSelectPanelTests } from '../unit-tests/restore-select-panel-test.js';
import { runTests as runConversationFocusPolicyTests } from '../unit-tests/conversation-focus-policy-test.js';
import { runTests as runRenameErrorCodeTests } from '../unit-tests/rename-error-code-test.js';
import { runTests as runSessionManifestStateTests } from '../unit-tests/session-manifest-state-test.js';
import { runTests as runSessionPersistenceTests } from '../unit-tests/session-persistence-test.js';
import { runTests as runSessionEventsTests } from '../unit-tests/session-events-test.js';
import { runTests as runConversationSeederTests } from '../unit-tests/conversation-seeder-test.js';
import { runTests as runConversationBinTests } from '../unit-tests/conversation-bin-test.js';
import { runTests as runConversationSyncTests } from '../unit-tests/conversation-sync-test.js';
import { runTests as runConversationRegistryTests } from '../unit-tests/conversation-registry-test.js';
import { runTests as runModelViewBoundaryTests } from '../unit-tests/model-view-boundary-test.js';
import { runTests as runSendContextPlacementTests } from '../unit-tests/send-context-placement-test.js';
import { runTests as runCommandMenuOrderTests } from '../unit-tests/command-menu-order-test.js';
import { runTests as runMobileComposerTests } from '../unit-tests/mobile-composer-test.js';
import { runTests as runComposerSendLatchTests } from '../unit-tests/composer-send-latch-test.js';
import { runTests as runComposerAutoresizeDeferTests } from '../unit-tests/composer-autoresize-defer-test.js';
import { runTests as runComposerExpandTests } from '../unit-tests/composer-expand-test.js';
import { runTests as runComposerRestoreMessageTests } from '../unit-tests/composer-restore-message-test.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { runTests as runPendingMessageRestoreTests } from '../unit-tests/pending-message-restore-test.js';
import { runTests as runTurnActiveStatusTests } from '../unit-tests/turn-active-status-test.js';
import { runTests as runConversationErrorTests } from '../unit-tests/conversation-error-test.js';
import { runTests as runWindowResizeCursorTests } from '../unit-tests/window-resize-cursor-test.js';
import { runTests as runWindowEdgeResizeTests } from '../unit-tests/window-edge-resize-test.js';
import { runTests as runScheduledSendTests } from '../unit-tests/scheduled-send-test.js';
import { runTests as runQueuedActionsTests } from '../unit-tests/queued-actions-test.js';
import { runTests as runSidebarDrawerTests } from '../unit-tests/sidebar-drawer-test.js';
import { runTests as runSwipeDismissTests } from '../unit-tests/swipe-dismiss-test.js';
import { runTests as runInfoRailTests } from '../unit-tests/info-rail-test.js';
import { runTests as runTabDragGhostTests } from '../unit-tests/tab-drag-ghost-test.js';
import { runTests as runReorderDragTests } from '../unit-tests/reorder-drag-test.js';
import { runTests as runSlashCompletionTests } from '../unit-tests/slash-completion-test.js';
import { runTests as runShellCommandTests } from '../unit-tests/shell-command-test.js';
import { runTests as runSkillCompletionTests } from '../unit-tests/skill-completion-test.js';
import { runTests as runComposerMenuAriaTests } from '../unit-tests/composer-menu-aria-test.js';
import { runTests as runDialogAriaTests } from '../unit-tests/dialog-aria-test.js';
import { runTests as runSkillsAddSourceMenuAriaTests } from '../unit-tests/skills-add-source-menu-aria-test.js';
import { runTests as runMenuKeyboardTests } from '../unit-tests/menu-keyboard-test.js';
import { runTests as runPresetBrowserAriaTests } from '../unit-tests/preset-browser-aria-test.js';
import { runTests as runAutocompleteAriaTests } from '../unit-tests/autocomplete-aria-test.js';
import { runTests as runUnclaimedConversationsTests } from '../unit-tests/unclaimed-conversations-test.js';
import { runTests as runThreadColumnSelectionTests } from '../unit-tests/thread-column-selection-test.js';
import { runTests as runThreadSelectionPinTests } from '../unit-tests/thread-selection-pin-test.js';
import { runTests as runThreadPinSurvivesRevealTests } from '../unit-tests/thread-pin-survives-reveal-test.js';
import { runTests as runThreadStreamPinTests } from '../unit-tests/thread-stream-pin-test.js';
import { runTests as runArrowKeyThreadFocusTests } from '../unit-tests/arrow-key-thread-focus-test.js';
import { runTests as runParallelThreadSelectionTests } from '../unit-tests/parallel-thread-selection-test.js';
import { runTests as runPinboardThreadSourceTests } from '../unit-tests/pinboard-thread-source-test.js';
import { runTests as runPinboardTasksTests } from '../unit-tests/pinboard-tasks-test.js';
import { runTests as runPinboardTaskRevealTests } from '../unit-tests/pinboard-task-reveal-test.js';
import { runTests as runPinboardGitReviewTests } from '../unit-tests/pinboard-git-review-test.js';
import { runTests as runReviewDraftTests } from '../unit-tests/review-draft-test.js';
import { runTests as runReviewSendTests } from '../unit-tests/review-send-test.js';
import { runTests as runReviewPanelTests } from '../unit-tests/review-panel-test.js';
import { runTests as runDiffViewerTests } from '../unit-tests/diff-viewer-test.js';
import { runTests as runPinboardRetentionTests } from '../unit-tests/pinboard-retention-test.js';
import { runTests as runWsListenerIsolationTests } from '../unit-tests/ws-listener-isolation-test.js';
import { runTests as runIconsTests } from '../unit-tests/icons-test.js';
import { runTests as runPinboardSatelliteTests } from '../unit-tests/pinboard-satellite-test.js';
import { runTests as runScrollAwayAutofollowTests } from '../unit-tests/scroll-away-autofollow-test.js';
import { runTests as runScrollToTopTests } from '../unit-tests/scroll-to-top-test.js';
import { runTests as runAutoFollowHoldsTheEndTests } from '../unit-tests/auto-follow-holds-the-end-test.js';
import { runTests as runClickSelectHoldsPlaceTests } from '../unit-tests/click-select-holds-place-test.js';
import { runTests as runUserSendFollowTests } from '../unit-tests/user-send-follow-test.js';
import { runTests as runThreadColumnLandingTests } from '../unit-tests/thread-column-landing-test.js';
import { runTests as runJumpToAttentionRevealTests } from '../unit-tests/jump-to-attention-reveal-test.js';
import { runTests as runColumnBuilderTests } from '../unit-tests/column-builder-test.js';
import { runTests as runEmptyConversationHintTests } from '../unit-tests/empty-conversation-hint-test.js';
import { runTests as runEmptyHintTipsTests } from '../unit-tests/empty-hint-tips-test.js';
import { runTests as runUsageSignalsTests } from '../unit-tests/usage-signals-test.js';
import { runTests as runNudgeEngineTests } from '../unit-tests/nudge-engine-test.js';
import { runTests as runJugglerNudgeTests } from '../unit-tests/juggler-nudge-test.js';
import { runTests as runGuidanceSurfacesTests } from '../unit-tests/guidance-surfaces-test.js';
import { runTests as runNoConversationsOnboardingTests } from '../unit-tests/no-conversations-onboarding-test.js';
import { runTests as runConnectServerPanelTests } from '../unit-tests/connect-server-panel-test.js';
import { runTests as runProjectFixedTests } from '../unit-tests/project-fixed-test.js';
import { runTests as runMachineSessionsPageTests } from '../unit-tests/machine-sessions-page-test.js';
import { runTests as runProjectPickerRecentsTests } from '../unit-tests/project-picker-recents-test.js';
import { runTests as runStarterPromptsTests } from '../unit-tests/starter-prompts-test.js';
import { runTests as runColumnFileDropTests } from '../unit-tests/column-file-drop-test.js';
import { runTests as runComposerAttachButtonTests } from '../unit-tests/composer-attach-button-test.js';
import { runTests as runComposerRowTests } from '../unit-tests/composer-row-test.js';
import { runTests as runColumnNavigationTests } from '../unit-tests/column-navigation-test.js';
import { runTests as runDeleteSelectionNeighbourTests } from '../unit-tests/delete-selection-neighbour-test.js';
import { runTests as runRunningToolDeleteTests } from '../unit-tests/running-tool-delete-test.js';
import { runTests as runControlClickRevealTests } from '../unit-tests/control-click-reveal-test.js';
import { runTests as runTabHideFocusTests } from '../unit-tests/tab-hide-focus-test.js';
import { runTests as runImageLightboxTests } from '../unit-tests/image-lightbox-test.js';
import { runTests as runNewThreadFocusTests } from '../unit-tests/new-thread-focus-test.js';
import { runTests as runApprovalFocusReturnTests } from '../unit-tests/approval-focus-return-test.js';
import { runTests as runApprovalDraftFocusTests } from '../unit-tests/approval-draft-focus-test.js';
import { runTests as runNestedApprovalStatusTests } from '../unit-tests/nested-approval-status-test.js';
import { runTests as runConcurrentRunsTests } from '../unit-tests/concurrent-runs-test.js';
import { runTests as runThreadAliasTests } from '../unit-tests/thread-alias-test.js';
import { runTests as runThreadTileStateTests } from '../unit-tests/thread-tile-state-test.js';
import { runTests as runRunRecordsTests } from '../unit-tests/run-records-test.js';
import { runTests as runExpandFoldGuardTests } from '../unit-tests/expand-fold-guard-test.js';
import { runTests as runToolGroupingTests } from '../unit-tests/tool-grouping-test.js';
import { runTests as runChimeRecoveryTests } from '../unit-tests/chime-recovery-test.js';
import { runTests as runChimeVoiceTests } from '../unit-tests/chime-voice-test.js';
import { runTests as runTabBehaviourPrefsTests } from '../unit-tests/tab-behaviour-prefs-test.js';
import { runTests as runTabCycleSettleTests } from '../unit-tests/tab-cycle-settle-test.js';
import { runTests as runRecentTabSwitcherTests } from '../unit-tests/recent-tab-switcher-test.js';
import { runTests as runKeyShortcutManagerTests } from '../unit-tests/key-shortcut-manager-test.js';
import { runTests as runEscapeBehaviourTests } from '../unit-tests/escape-behaviour-test.js';
import { runTests as runHoldToCycleTests } from '../unit-tests/hold-to-cycle-test.js';
import { runTests as runRecentModelsTests } from '../unit-tests/recent-models-test.js';
import { runTests as runPinboardTests } from '../unit-tests/pinboard-test.js';
import { runTests as runPinboardShellTests } from '../unit-tests/pinboard-shell-test.js';
import { runTests as runUsageStatsCacheTests } from '../unit-tests/usage-stats-cache-test.js';
import { runTests as runUsageCardProviderTests } from '../unit-tests/usage-card-provider-test.js';
import { runTests as runUsageCardStaleTests } from '../unit-tests/usage-card-stale-test.js';
import { runTests as runUsageRendererTests } from '../unit-tests/usage-renderer-test.js';
import { runTests as runThinkingCyclerTests } from '../unit-tests/thinking-cycler-test.js';
import { runTests as runThinkingChipTests } from '../unit-tests/thinking-chip-test.js';
import { runTests as runServiceTierControlTests } from '../unit-tests/service-tier-control-test.js';
import { runTests as runServiceTierChipTests } from '../unit-tests/service-tier-chip-test.js';
import { runTests as runTransactionPanelTests } from '../unit-tests/transaction-panel-test.js';
import { runTests as runItemSelectionFollowUpsTests } from '../unit-tests/item-selection-follow-ups-test.js';
import { runTests as runModelSelectorHudTests } from '../unit-tests/model-selector-hud-test.js';
import { runTests as runModelPickerTests } from '../unit-tests/model-picker-test.js';
import { runTests as runCustomProvidersTests } from '../unit-tests/custom-providers-test.js';
import { runTests as runDefaultsModelHostTests } from '../unit-tests/defaults-model-host-test.js';
import { runTests as runDecisionProvidersTests } from '../unit-tests/decision-providers-test.js';
import { runTests as runDecideOpTests } from '../unit-tests/decide-op-test.js';
import { runTests as runReplySuggestionsTests } from '../unit-tests/reply-suggestions-test.js';
import { runTests as runCommandEditorTests } from '../unit-tests/command-editor-test.js';
import { runTests as runCommandsTabTests } from '../unit-tests/commands-tab-test.js';
import { runTests as runFindTests } from '../unit-tests/find-test.js';
import { runTests as runContextMenuTests } from '../unit-tests/context-menu-test.js';
import { runTests as runComposerSelectionQuoteTests } from '../unit-tests/composer-selection-quote-test.js';
import { runTests as runDisconnectionOverlayTests } from '../unit-tests/disconnection-overlay-test.js';
import { runTests as runServerLostTests } from '../unit-tests/server-lost-test.js';
import { runTests as runStartupOverlayTests } from '../unit-tests/startup-overlay-test.js';
import { runTests as runExtensionRegistryTests } from '../unit-tests/extension-registry-test.js';
import { runTests as runFileViewerRegistryTests } from '../unit-tests/file-viewer-registry-test.js';
import { runTests as runPdfViewerTests } from '../unit-tests/pdf-viewer-test.js';
import { runTests as runFileViewTests } from '../unit-tests/file-view-test.js';
import { runTests as runHtmlFileViewerTests } from '../unit-tests/html-file-viewer-test.js';
import { runTests as runBinaryViewerTests } from '../unit-tests/binary-viewer-test.js';
import { runTests as runMediaViewerTests } from '../unit-tests/media-viewer-test.js';
import { runTests as runSdkFacadeParityTests } from '../unit-tests/sdk-facade-parity-test.js';
import { runTests as runI18nTests } from '../unit-tests/i18n-test.js';
import { runTests as runI18nFormatParityTests } from '../unit-tests/i18n-format-parity-test.js';
import { runTests as runI18nPseudoParityTests } from '../unit-tests/i18n-pseudo-parity-test.js';
import { runTests as runWireProtocolParityTests } from '../unit-tests/wire-protocol-parity-test.js';
import { runTests as runFormatTimeAgoTests } from '../unit-tests/format-time-ago-test.js';
import { runTests as runFormatUnitsTests } from '../unit-tests/format-units-test.js';
import { runTests as runAppearanceTabTests } from '../unit-tests/appearance-tab-test.js';
import { runTests as runLanguageTabTests } from '../unit-tests/language-tab-test.js';
import { runTests as runUILocaleReloaderTests } from '../unit-tests/ui-locale-reloader-test.js';
import { runTests as runNotificationsTabTests } from '../unit-tests/notifications-tab-test.js';
import { runTests as runSettingsPanelTests } from '../unit-tests/settings-panel-test.js';
import { runTests as runSettingsApiTests } from '../unit-tests/settings-api-test.js';
import { runTests as runSettingsTabsTests } from '../unit-tests/settings-tabs-test.js';
import { runTests as runExtensionCatalogsTests } from '../unit-tests/extension-catalogs-test.js';
import { runTests as runSdkManifestValidationTests } from '../unit-tests/sdk-manifest-validation-test.js';
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
import { runTests as runCopyButtonTests } from '../unit-tests/copy-button-test.js';
import { runTests as runLiveTaskOutputTests } from '../unit-tests/live-task-output-test.js';
import { runTests as runComposerAttachmentsTests } from '../unit-tests/composer-attachments-test.js';
import { runTests as runComposerTests } from '../unit-tests/composer-test.js';
import { runTests as runCodeBlockTests } from '../unit-tests/code-block-test.js';
import { runTests as runWindowCaptionControlsTests } from '../unit-tests/window-caption-controls-test.js';
import { runTests as runUIEventManagerTests } from '../unit-tests/ui-event-manager-test.js';
import { runTests as runPropertiesPanelHelpersTests } from '../unit-tests/properties-panel-helpers-test.js';
import { runTests as runPropertiesPanelTests } from '../unit-tests/properties-panel-test.js';
import { runTests as runWorkspaceDialogsTests } from '../unit-tests/workspace-dialogs-test.js';
import { runTests as runContextItemBaseTests } from '../unit-tests/context-item-base-test.js';
import { runTests as runCapabilityNameReadersTests } from '../unit-tests/capability-name-readers-test.js';
import { runTests as runConnectivityTests } from '../unit-tests/connectivity-test.js';
import { runTests as runLogsTests } from '../unit-tests/logs-test.js';
import { runTests as runUpdatesSettingsTests } from '../unit-tests/updates-settings-test.js';
import { runTests as runSettingsFirstLoadTests } from '../unit-tests/settings-first-load-test.js';
import { runTests as runProxySettingsTests } from '../unit-tests/proxy-settings-test.js';
import { runTests as runModelLimitsTests } from '../unit-tests/model-limits-test.js';
import { runTests as runProviderSwitchTests } from '../unit-tests/provider-switch-test.js';
import { runTests as runReconnectPolicyTests } from '../unit-tests/reconnect-policy-test.js';
import { runTests as runResyncOfflineEditTests } from '../unit-tests/resync-offline-edit-test.js';
import { runTests as runOpenDuringLoadTests } from '../unit-tests/open-during-load-test.js';
import { runTests as runSessionLoadFailureTests } from '../unit-tests/session-load-failure-test.js';
import { runTests as runAppMessagesTests } from '../unit-tests/app-messages-test.js';
import { runTests as runPopupBackButtonTests } from '../unit-tests/popup-back-button-test.js';
import { runTests as runPopupSurfaceTests } from '../unit-tests/popup-surface-test.js';
import { runTests as runModelDisplayTests } from '../unit-tests/model-display-test.js';
import { runTests as runWindowTitleTests } from '../unit-tests/window-title-test.js';
import { runTests as runContextSyncWaitTests } from '../unit-tests/context-sync-wait-test.js';
import { runTests as runConversationNoticesTests } from '../unit-tests/conversation-notices-test.js';
import './golden-comparator.js'; // Initialize window.__integrationTestHelpers
import logger from './test-logger.js';
import {
  installClaimAutoRegistration,
  snapshotOwnConversationIds,
  deleteOwnConversationsCreatedSince,
  setCurrentTestName
} from './conversation-claims.js';
import { setTestDeadline, clearTestDeadline, moveTestDeadline, progressMark, caseMark } from './test-deadline.js';
import { waitsInFlightReport } from './test-patience.js';
import { watchForStall, watchWorkerProgress, awaitingServer, installFetchTracking } from './stall-watch.js';
import { __lastTapeTsForTests } from '../../js/utils/event-tape.js';
import { fetchProjectSize, projectSizeLines } from './project-size.js';
import { machineLoadReport } from './machine-load.js';
import { setReportedTest, reportTestProgress } from './progress-report.js';
import { connectTestWebSocket } from './ws-connect.js';
import wsService from '../../js/services/websocket.js';

// Action progress events fire in the engine, which has no document this page
// can listen on; the engine sends each one as an `engine-bridge` frame that the
// server relays to every viewer. Re-dispatch the frames THIS lane's socket
// receives on the test document, so capture listeners see them.
//
// Take them from the socket, never from the same-window BroadcastChannel that
// websocket.js also replays them onto: a BroadcastChannel never delivers a
// post to the context that made it, so on that path a lane hears its own
// progress only as its siblings' replays — none while every sibling is between
// tests or reloading, and none at all for a lane alone on its server — while
// its own tape shows the event arriving.
//
// The server relays every conversation's progress to every viewer, and
// toolUseIds like `call_1` repeat across sibling tests, so in the iframe pool
// only events for conversations THIS lane owns are re-dispatched — otherwise
// sibling tests' tool executions would count toward this test's captures.
const __inIframePool = window.parent && window.parent !== window;
wsService.on('engine-bridge', (/** @type {any} */ frame) => {
  if (frame?.channel !== 'juggler-action-progress') return;
  const detail = frame.payload;
  if (__inIframePool && detail?.conversationId) {
    const owned = /** @type {any} */ (window).__ownConversationIds;
    if (!owned || !owned.has(detail.conversationId)) return;
  }
  document.dispatchEvent(new CustomEvent('action-progress', { detail }));
});

/**
 * What each `contextmenu` a test left to the platform was sent at, since the
 * suite running began. See {@link takeContextMenusLeftToPlatform}.
 * @type {string[]}
 */
const _contextMenusLeftToPlatform = [];

// No `contextmenu` reaches WebKit's own menu in a lane: every one still
// uncancelled once its dispatch has run is cancelled here, and charged to the
// suite that sent it. WebCore builds its context menu for any uncancelled
// `contextmenu`, synthetic or not — no isTrusted check. Over editable text
// that menu has a Spelling submenu, and filling it in asks the UI process,
// synchronously, whether the Spelling panel is showing. AppKit answers by
// building the panel on the main thread: a nib and its string tables read
// from disk, which on a starved runner outlasted the main-thread watchdog and
// took the pool down with every lane in it.
//
// The check has to see the event after every other listener, so the capture
// listener (re)appends it as a bubble listener on `window`: added during the
// dispatch, it runs after any `window` listener registered before it, whoever
// loaded first. Removed first, so one an event stopped short of it is not left
// behind to run in the next. A non-bubbling event never gets back to `window`;
// none of the tests send one.
/**
 * @param {Event} e - The `contextmenu` event, at the end of its dispatch.
 * @returns {void}
 */
function cancelContextMenuLeftToPlatform(e) {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const target = /** @type {any} */ (e.target);
  _contextMenusLeftToPlatform.push(target instanceof Element ? `<${target.localName}>` : String(target));
}
window.addEventListener('contextmenu', () => {
  window.removeEventListener('contextmenu', cancelContextMenuLeftToPlatform);
  window.addEventListener('contextmenu', cancelContextMenuLeftToPlatform, { once: true });
}, { capture: true });

/**
 * Empty the record of `contextmenu` events left to the platform, returning
 * what it held.
 * @returns {string[]} What each was sent at, in order.
 */
function takeContextMenusLeftToPlatform() {
  return _contextMenusLeftToPlatform.splice(0);
}

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
  ...scheduledSendTests,
  ...monitorDeliveryTests,
  ...monitorKillTests,
  ...largeOutputTests,
  ...backgroundOutputTests,
  ...memoryTests,
  ...attentionAlertTests,
  ...binGuardTests,
  ...modelAvailabilityTests,
  ...appPseudoLocaleWalkTests
].map(t => ({ ...t, name: `integration:${t.name}` }));

/**
 * All unit test suites.
 * Each entry is a { name, run } pair where run(ctx) returns { passed, failed, errors }.
 * Names appear as individual test entries in listTests() and are addressable via -run.
 *
 * A suite does NOT get a realm to itself. A lane loads its page once and runs
 * suite after suite in it (`headless-test.html`, which reloads only every
 * LANE_RECYCLE_EVERY tests, to reclaim heap), so module-level state a suite
 * leaves behind — a registration, a singleton, a defined element — is there for
 * every suite that follows it and for a second run of the suite itself. A suite
 * that installs something global owns putting it back, or tolerates finding it
 * already there.
 *
 * An entry may also set `needsExclusiveRun: true`, which makes the Go runner
 * give it a window with no sibling lane in it. The commonest reason is a
 * suite asserting on `document.activeElement`: the lanes of a server are iframes
 * inside ONE window, and a window has exactly one focused frame, so any sibling calling
 * element.focus() takes frame focus away and blurs this lane's element to <body>
 * — the suite then fails on the pool's topology rather than on the code under
 * test. listExclusiveTests() lists the rest; the same flag carries them all.
 */
const UNIT_TEST_SUITES = [
  { name: 'unit:context-cache-impact', run: runContextCacheImpactTests },
  { name: 'unit:cache-baseline-anchor', run: runCacheBaselineAnchorTests },
  { name: 'unit:code-lines', run: codeLinesTests },
  { name: 'unit:cache-miss-warning', run: runCacheMissWarningTests },
  { name: 'unit:file-content-freeze', run: runFileContentFreezeTests },
  { name: 'unit:error-retry-gate', run: runErrorRetryGateTests },
  { name: 'unit:auth-error-action', run: runAuthErrorActionTests },
  { name: 'unit:auto-continue-error', run: runAutoContinueErrorTests },
  { name: 'unit:keyless-signin-status', run: runKeylessSignInStatusTests },
  { name: 'unit:token-cache-unknown', run: runTokenCacheUnknownTests },
  { name: 'unit:compaction-status', run: runCompactionStatusTests },
  { name: 'unit:status-message-format', run: runStatusMessageFormatTests },
  { name: 'unit:status-message-builder', run: runStatusMessageBuilderTests },
  { name: 'unit:conversation-area-rendering', run: runConversationAreaRenderingTests },
  { name: 'unit:conversation-area', run: runConversationAreaTests },
  { name: 'unit:trailing-turn-outcome', run: runTrailingTurnOutcomeTests },
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
  { name: 'unit:usage-card-provider', run: runUsageCardProviderTests },
  { name: 'unit:usage-card-stale', run: runUsageCardStaleTests },
  { name: 'unit:usage-renderer', run: runUsageRendererTests },
  { name: 'unit:thinking-cycler', run: runThinkingCyclerTests },
  { name: 'unit:thinking-chip', run: runThinkingChipTests },
  { name: 'unit:service-tier-control', run: runServiceTierControlTests },
  { name: 'unit:service-tier-chip', run: runServiceTierChipTests },
  { name: 'unit:transaction-panel', run: runTransactionPanelTests },
  { name: 'unit:item-selection-follow-ups', run: runItemSelectionFollowUpsTests },
  { name: 'unit:model-selector-hud', run: runModelSelectorHudTests },
  { name: 'unit:model-picker', run: runModelPickerTests },
  { name: 'unit:custom-providers', run: runCustomProvidersTests },
  { name: 'unit:defaults-model-host', run: runDefaultsModelHostTests },
  { name: 'unit:decision-providers', run: runDecisionProvidersTests },
  { name: 'unit:decide-op', run: runDecideOpTests },
  { name: 'unit:reply-suggestions', run: runReplySuggestionsTests },
  { name: 'unit:command-editor', run: runCommandEditorTests },
  { name: 'unit:commands-tab', run: runCommandsTabTests },
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
  { name: 'unit:item-field', run: runItemFieldTests },
  { name: 'unit:message-type-guard', run: runMessageTypeGuardTests },
  { name: 'unit:model-filter', run: runModelFilterTests },
  { name: 'unit:monitor-tools', run: runMonitorToolsTests },
  { name: 'unit:tool-schema', run: runToolSchemaTests },
  { name: 'unit:tool-list-readiness', run: runToolListReadinessTests },
  { name: 'unit:transaction-tool-list', run: runTransactionToolListTests },
  { name: 'unit:thread-tool-inventory', run: runThreadToolInventoryTests },
  { name: 'unit:mcp-evaluate-toolname', run: runMcpEvaluateToolNameTests },
  { name: 'unit:mcp-settings', run: runMcpSettingsTests },
  { name: 'unit:acp-settings', run: runAcpSettingsTests },
  { name: 'unit:system-prompt-builder', run: runSystemPromptBuilderTests },
  { name: 'unit:system-prompt-registry', run: runSystemPromptRegistryTests },
  { name: 'unit:extensions-disabled', run: runExtensionsDisabledTests },
  { name: 'unit:roundtrip-timing', run: runRoundTripTimingTests },
  { name: 'unit:worker-broadcast', run: runWorkerBroadcastTests },
  { name: 'unit:worker-inbound', run: runWorkerInboundTests },
  { name: 'unit:registry-init-race', run: runRegistryInitRaceTests },
  { name: 'unit:strategy-injection', run: runStrategyInjectionTests },
  { name: 'unit:observer-decoupling', run: runObserverDecouplingTests },
  { name: 'unit:tool-pending-hook', run: runToolPendingHookTests },
  { name: 'unit:tool-hooks', run: runToolHooksTests },
  { name: 'unit:tool-result-terminal', run: runToolResultTerminalTests },
  { name: 'unit:tool-command-resync', run: runToolCommandResyncTests },
  { name: 'unit:tool-call-decision', run: runToolCallDecisionTests },
  { name: 'unit:tool-invoker', run: runToolInvokerTests },
  { name: 'unit:program-change-report', run: runProgramChangeReportTests },
  { name: 'unit:deny-cascade', run: runDenyCascadeTests },
  { name: 'unit:token-meter-recovery', run: runTokenMeterRecoveryTests },
  { name: 'unit:context-turn-hook', run: runContextTurnHookTests },
  { name: 'unit:handoff-promotion', run: runHandoffPromotionTests },
  { name: 'unit:read-file-action', run: runReadFileActionTests },
  { name: 'unit:read-truncation', run: runReadTruncationTests },
  { name: 'unit:path-input-quotes', run: runPathInputQuotesTests },
  { name: 'unit:path-input-menu', run: runPathInputMenuTests, needsExclusiveRun: true },
  { name: 'unit:path-containment', run: runPathContainmentTests },
  { name: 'unit:debounce', run: runDebounceTests },
  { name: 'unit:mobile-composer', run: runMobileComposerTests },
  { name: 'unit:composer-send-latch', run: runComposerSendLatchTests },
  { name: 'unit:composer-autoresize-defer', run: runComposerAutoresizeDeferTests },
  { name: 'unit:composer-expand', run: runComposerExpandTests },
  { name: 'unit:composer-restore-message', run: runComposerRestoreMessageTests },
  { name: 'unit:pending-message-restore', run: runPendingMessageRestoreTests },
  { name: 'unit:turn-active-status', run: runTurnActiveStatusTests },
  { name: 'unit:conversation-error', run: runConversationErrorTests },
  { name: 'unit:window-resize-cursor', run: runWindowResizeCursorTests },
  { name: 'unit:window-edge-resize', run: runWindowEdgeResizeTests },
  { name: 'unit:scheduled-send', run: runScheduledSendTests },
  { name: 'unit:queued-actions', run: runQueuedActionsTests },
  { name: 'unit:sidebar-drawer', run: runSidebarDrawerTests },
  { name: 'unit:swipe-dismiss', run: runSwipeDismissTests },
  { name: 'unit:info-rail', run: runInfoRailTests },
  { name: 'unit:tab-drag-ghost', run: runTabDragGhostTests },
  { name: 'unit:reorder-drag', run: runReorderDragTests },
  { name: 'unit:slash-completion', run: runSlashCompletionTests },
  { name: 'unit:shell-command', run: runShellCommandTests },
  { name: 'unit:skill-completion', run: runSkillCompletionTests },
  { name: 'unit:composer-menu-aria', run: runComposerMenuAriaTests },
  { name: 'unit:dialog-aria', run: runDialogAriaTests, needsExclusiveRun: true },
  { name: 'unit:skills-add-source-menu-aria', run: runSkillsAddSourceMenuAriaTests },
  { name: 'unit:menu-keyboard', run: runMenuKeyboardTests, needsExclusiveRun: true },
  { name: 'unit:preset-browser-aria', run: runPresetBrowserAriaTests },
  { name: 'unit:autocomplete-aria', run: runAutocompleteAriaTests },
  { name: 'unit:search-action', run: runSearchActionTests },
  { name: 'unit:tool-cancellation', run: runToolCancellationTests },
  { name: 'unit:unbounded-await', run: runUnboundedAwaitTests },
  { name: 'unit:modal-supersede', run: runModalSupersedeTests },
  { name: 'unit:modal-dialog', run: runModalDialogTests },
  { name: 'unit:http-errors', run: runHttpErrorsTests },
  { name: 'unit:ops-api-arguments', run: runOpsApiArgumentsTests },
  { name: 'unit:ops-api-signal', run: runOpsApiSignalTests },
  { name: 'unit:cancel-settle', run: runCancelSettleTests },
  { name: 'unit:items-array-wait', run: runItemsArrayWaitTests },
  { name: 'unit:session-ownership', run: runSessionOwnershipTests },
  { name: 'unit:busy-state', run: runBusyStateTests },
  { name: 'unit:ui-port', run: runUiPortTests },
  { name: 'unit:event-feeds', run: runEventFeedsTests },
  { name: 'unit:approval-buttons', run: runApprovalButtonsTests },
  { name: 'unit:approval-hint', run: runApprovalHintTests },
  { name: 'unit:response-handler-model-text', run: runResponseHandlerModelTextTests },
  { name: 'unit:capability-catalog', run: runCapabilityCatalogTests },
  { name: 'unit:setup-wizard', run: runSetupWizardTests },
  { name: 'unit:warning-fallback', run: runWarningFallbackTests },
  { name: 'unit:conversation-release', run: runConversationReleaseTests },
  { name: 'unit:load-queue-recycle', run: runLoadQueueRecycleTests },
  { name: 'unit:unloaded-tab-hydration', run: runUnloadedTabHydrationTests },
  { name: 'unit:refresh-merge', run: runRefreshMergeTests },
  { name: 'unit:worker-init-declined', run: runWorkerInitDeclinedTests },
  { name: 'unit:tab-order-merge', run: runTabOrderMergeTests },
  { name: 'unit:tab-drag-order', run: runTabDragOrderTests },
  { name: 'unit:tab-keyboard-move', run: runTabKeyboardMoveTests },
  { name: 'unit:tab-drag-across-workspace', run: runTabDragAcrossWorkspaceTests },
  { name: 'unit:tab-drag-workspace-order', run: runTabDragWorkspaceOrderTests },
  { name: 'unit:tab-drag-workspace-drop-sweep', run: runTabDragWorkspaceDropSweepTests },
  { name: 'unit:tab-drag-workspace-drop-sweep-members', run: runTabDragWorkspaceDropSweepMemberTests },
  { name: 'unit:tool-action-render', run: runToolActionRenderTests },
  { name: 'unit:component-teardown', run: runComponentTeardownTests },
  { name: 'unit:juggler-spinner-live', run: runJugglerSpinnerLiveTests },
  { name: 'unit:submit-plan-action', run: runSubmitPlanActionTests },
  { name: 'unit:plan-approval', run: runPlanApprovalTests },
  { name: 'unit:todo-action', run: runTodoActionTests },
  { name: 'unit:todo-no-approval', run: runTodoNoApprovalTests },
  { name: 'unit:thread-nested-array', run: runThreadNestedArrayTests },
  { name: 'unit:undo-redo', run: runUndoRedoTests },
  { name: 'unit:undo-redo-context-items', run: runUndoRedoContextItemsTests },
  { name: 'unit:undo-redo-tools', run: runUndoRedoToolsTests },
  { name: 'unit:undo-redo-deletion', run: runUndoRedoDeletionTests },
  { name: 'unit:undo-redo-deletion-edges', run: runUndoRedoDeletionEdgesTests },
  { name: 'unit:header-undo-lock', run: runHeaderUndoLockTests },
  { name: 'unit:header-bar', run: runHeaderBarTests },
  { name: 'unit:footer-meta', run: runFooterMetaTests },
  { name: 'unit:conversation-markdown', run: runConversationMarkdownTests },
  { name: 'unit:conversation-html', run: runConversationHtmlTests },
  { name: 'unit:write-file-action', run: runWriteFileActionTests },
  { name: 'unit:yjs-compat', run: runYjsCompatTests },
  { name: 'unit:base64', run: runBase64Tests },
  { name: 'unit:ws-chunk', run: runWSChunkTests },
  { name: 'unit:render-scaling', run: runRenderScalingTests },
  { name: 'unit:test-budget', run: runTestBudgetTests },
  { name: 'unit:exclusive-test-flags', run: runExclusiveTestFlagsTests },
  { name: 'unit:suite-verdict', run: runSuiteVerdictTests },
  { name: 'unit:suite-document-isolation', run: runSuiteDocumentIsolationTests },
  { name: 'unit:wait-report', run: runWaitReportTests },
  { name: 'unit:isolate-focus', run: runIsolateFocusTests },
  { name: 'unit:hold-broadcasts', run: runHoldBroadcastsTests },
  { name: 'unit:suite-popup-isolation', run: runSuitePopupIsolationTests },
  { name: 'unit:engine-autoload', run: runEngineAutoloadTests },
  { name: 'unit:sync-batch-backoff', run: runSyncBatchBackoffTests },
  { name: 'unit:sync-fault-isolation', run: runSyncFaultIsolationTests },
  { name: 'unit:thinking-stream', run: runThinkingStreamTests },
  { name: 'unit:streaming-row-scope', run: runStreamingRowScopeTests },
  { name: 'unit:thinking-message', run: runThinkingMessageTests },
  { name: 'unit:streaming-markdown', run: runStreamingMarkdownTests },
  { name: 'unit:file-refs', run: runFileRefsTests },
  { name: 'unit:file-ref-links', run: runFileRefLinksTests },
  { name: 'unit:markdown-sanitizer', run: runMarkdownSanitizerTests },
  { name: 'unit:markdown-scoped-css', run: runMarkdownScopedCssTests },
  { name: 'unit:selection-colour', run: runSelectionColourTests },
  { name: 'unit:selection-containment', run: runSelectionContainmentTests },
  { name: 'unit:markdown-task-list', run: runMarkdownTaskListTests },
  { name: 'unit:user-message-markdown', run: runUserMessageMarkdownTests },
  { name: 'unit:language-coverage', run: runLanguageCoverageTests },
  { name: 'unit:highlight-lines', run: runHighlightLinesTests },
  { name: 'unit:markdown-highlight', run: runMarkdownHighlightTests },
  { name: 'unit:diff-async', run: runDiffAsyncTests },
  { name: 'unit:diff-highlight', run: runDiffHighlightTests },
  { name: 'unit:diff-review', run: runDiffReviewTests },
  { name: 'unit:diff-split', run: runDiffSplitTests },
  { name: 'unit:external-link', run: runExternalLinkTests },
  { name: 'unit:api-url', run: runApiUrlTests },
  { name: 'unit:link-guard', run: runLinkGuardTests },
  { name: 'unit:ansi', run: runAnsiTests },
  // Exclusive: it stubs window.fetch and writes localStorage keys, on an
  // origin every lane shares.
  { name: 'unit:prefs', run: runPrefsTests, needsExclusiveRun: true },
  // Exclusive for the same reason: it stands in for the server and writes
  // the localStorage cache behind the widths.
  { name: 'unit:column-width', run: runColumnWidthTests, needsExclusiveRun: true },
  { name: 'unit:column-fit', run: runColumnFitTests },
  { name: 'unit:column-edge', run: runColumnEdgeTests },
  { name: 'unit:tab-list-edge', run: runTabListEdgeTests },
  { name: 'unit:tab-list-focus', run: runTabListFocusTests, needsExclusiveRun: true },
  { name: 'unit:thin-scrollbar', run: runThinScrollbarTests },
  { name: 'unit:context-preview-absent', run: runContextPreviewAbsentTests },
  { name: 'unit:modal-shell', run: runModalShellTests },
  { name: 'unit:button-variants', run: runButtonVariantsTests },
  { name: 'unit:badge-tints', run: runBadgeTintsTests },
  { name: 'unit:text-on-accent', run: runTextOnAccentTests },
  { name: 'unit:type-scale', run: runTypeScaleTests },
  { name: 'unit:warning-text', run: runWarningTextTests },
  { name: 'unit:surfaces', run: runSurfacesTests },
  { name: 'unit:label-styles', run: runLabelStylesTests },
  { name: 'unit:focus-rings', run: runFocusRingsTests },
  { name: 'unit:z-index-scale', run: runZIndexScaleTests },
  { name: 'unit:focus-modality', run: runFocusModalityTests },
  // Exclusive: it repaints data-theme and stubs matchMedia for the length of a
  // case, both of which are document-wide.
  { name: 'unit:theme-toggle', run: runThemeToggleTests, needsExclusiveRun: true },
  // Exclusive: it stubs window.fetch, repaints the document and writes the
  // machine's theme and zoom cells, which are not scoped to anything.
  { name: 'unit:appearance-prefs', run: runAppearancePrefsTests, needsExclusiveRun: true },
  { name: 'unit:tool-name-resolution', run: runToolNameResolutionTests },
  { name: 'unit:new-tab-ux', run: runNewTabUxTests },
  // Exclusive: it builds real git repositories in the shared fixture root and
  // removes them again, which a sibling lane walking the project reads as it
  // goes — the same reason the git-worktree extension suite is exclusive.
  { name: 'unit:conversation-workspace', run: runConversationWorkspaceTests, needsExclusiveRun: true },
  { name: 'unit:conversation-workspace-binding', run: runConversationWorkspaceBindingTests, needsExclusiveRun: true },
  { name: 'unit:conversation-workspace-provision', run: runConversationWorkspaceProvisionTests, needsExclusiveRun: true },
  { name: 'unit:conversation-workspace-panel', run: runConversationWorkspacePanelTests, needsExclusiveRun: true },
  { name: 'unit:conversation-workspace-move', run: runConversationWorkspaceMoveTests, needsExclusiveRun: true },
  { name: 'unit:workspace-finish-dialog', run: runWorkspaceFinishDialogTests },
  { name: 'unit:workspace-create-dialog', run: runWorkspaceCreateDialogTests, needsExclusiveRun: true },
  { name: 'unit:workspace-groups', run: runWorkspaceGroupsTests },
  { name: 'unit:workspace-boxes', run: runWorkspaceBoxesTests },
  { name: 'unit:truncated-name-tooltip', run: runTruncatedNameTooltipTests },
  { name: 'unit:conversation-tab-status', run: runConversationTabStatusTests },
  { name: 'unit:reorder-drag-hold', run: runReorderDragHoldTests },
  { name: 'unit:workspace-box-drag', run: runWorkspaceBoxDragTests },
  { name: 'unit:workspace-selection', run: runWorkspaceSelectionTests },
  { name: 'unit:workspace-rename', run: runWorkspaceRenameTests },
  { name: 'unit:conversation-rename', run: runConversationRenameTests },
  { name: 'unit:workspace-panel', run: runWorkspacePanelTests },
  // Exclusive: it asserts on document.activeElement, which every lane in the
  // shared origin can move.
  { name: 'unit:bin-undo-toast', run: runBinUndoToastTests },
  { name: 'unit:bin-footer', run: runBinFooterTests },
  { name: 'unit:conversation-bar', run: runConversationBarTests },
  { name: 'unit:bin-ghost-resurrection', run: runBinGhostResurrectionTests },
  { name: 'unit:bin-empty-menu', run: runBinEmptyMenuTests },
  { name: 'unit:bin-size-notice', run: runBinSizeNoticeTests },
  { name: 'unit:about-menu', run: runAboutMenuTests },
  { name: 'unit:update-ui', run: runUpdateUiTests },
  { name: 'unit:modal-scrim', run: runModalScrimTests },
  { name: 'unit:restore-select-panel', run: runRestoreSelectPanelTests },
  { name: 'unit:conversation-focus-policy', run: runConversationFocusPolicyTests },
  { name: 'unit:rename-error-code', run: runRenameErrorCodeTests },
  { name: 'unit:session-manifest-state', run: runSessionManifestStateTests },
  { name: 'unit:session-persistence', run: runSessionPersistenceTests },
  { name: 'unit:session-events', run: runSessionEventsTests },
  { name: 'unit:conversation-seeder', run: runConversationSeederTests },
  { name: 'unit:conversation-bin', run: runConversationBinTests },
  { name: 'unit:conversation-sync', run: runConversationSyncTests },
  { name: 'unit:conversation-registry', run: runConversationRegistryTests },
  { name: 'unit:model-view-boundary', run: runModelViewBoundaryTests },
  { name: 'unit:send-context-placement', run: runSendContextPlacementTests },
  { name: 'unit:command-menu-order', run: runCommandMenuOrderTests },
  { name: 'unit:unclaimed-conversations', run: runUnclaimedConversationsTests },
  { name: 'unit:thread-column-selection', run: runThreadColumnSelectionTests },
  { name: 'unit:thread-selection-pin', run: runThreadSelectionPinTests },
  // Exclusive: it asserts on document.activeElement, which every lane in the
  // shared origin can move.
  { name: 'unit:thread-pin-survives-reveal', run: runThreadPinSurvivesRevealTests, needsExclusiveRun: true },
  { name: 'unit:thread-stream-pin', run: runThreadStreamPinTests },
  { name: 'unit:parallel-thread-selection', run: runParallelThreadSelectionTests },
  { name: 'unit:pinboard-thread-source', run: runPinboardThreadSourceTests },
  { name: 'unit:pinboard-tasks', run: runPinboardTasksTests },
  { name: 'unit:pinboard-task-reveal', run: runPinboardTaskRevealTests },
  { name: 'unit:pinboard-git-review', run: runPinboardGitReviewTests },
  { name: 'unit:review-draft', run: runReviewDraftTests },
  { name: 'unit:review-send', run: runReviewSendTests },
  { name: 'unit:review-panel', run: runReviewPanelTests },
  { name: 'unit:diff-viewer', run: runDiffViewerTests },
  { name: 'unit:pinboard-retention', run: runPinboardRetentionTests },
  { name: 'unit:ws-listener-isolation', run: runWsListenerIsolationTests },
  { name: 'unit:icons', run: runIconsTests },
  // Exclusive: it puts the whole document into pinboard mode for the length of
  // a case, and a suite sharing the lane would boot into the wrong shell.
  { name: 'unit:pinboard-satellite', run: runPinboardSatelliteTests, needsExclusiveRun: true },
  { name: 'unit:scroll-away-autofollow', run: runScrollAwayAutofollowTests },
  { name: 'unit:scroll-to-top', run: runScrollToTopTests },
  { name: 'unit:auto-follow-holds-the-end', run: runAutoFollowHoldsTheEndTests },
  { name: 'unit:click-select-holds-place', run: runClickSelectHoldsPlaceTests },
  { name: 'unit:user-send-follow', run: runUserSendFollowTests },
  { name: 'unit:thread-column-landing', run: runThreadColumnLandingTests },
  // Exclusive for the shared origin: it turns tool grouping on, and a sibling
  // drawing tool rows meanwhile finds them folded into a group.
  { name: 'unit:jump-to-attention-reveal', run: runJumpToAttentionRevealTests, needsExclusiveRun: true },
  { name: 'unit:column-builder', run: runColumnBuilderTests },
  { name: 'unit:empty-conversation-hint', run: runEmptyConversationHintTests },
  { name: 'unit:empty-hint-tips', run: runEmptyHintTipsTests },
  { name: 'unit:usage-signals', run: runUsageSignalsTests },
  { name: 'unit:nudge-engine', run: runNudgeEngineTests },
  { name: 'unit:juggler-nudge', run: runJugglerNudgeTests },
  { name: 'unit:guidance-surfaces', run: runGuidanceSurfacesTests },
  { name: 'unit:no-conversations-onboarding', run: runNoConversationsOnboardingTests },
  { name: 'unit:connect-server-panel', run: runConnectServerPanelTests },
  { name: 'unit:project-fixed', run: runProjectFixedTests },
  { name: 'unit:machine-sessions-page', run: runMachineSessionsPageTests },
  { name: 'unit:project-picker-recents', run: runProjectPickerRecentsTests },
  { name: 'unit:starter-prompts', run: runStarterPromptsTests },
  { name: 'unit:column-file-drop', run: runColumnFileDropTests },
  { name: 'unit:composer-attach-button', run: runComposerAttachButtonTests },
  { name: 'unit:composer-row', run: runComposerRowTests },
  // Exclusive: it asserts ⌥↑ leaves the composer focused, and a sibling lane
  // taking the window's focus mid-case blurs it whatever the code under test did.
  { name: 'unit:column-navigation', run: runColumnNavigationTests, needsExclusiveRun: true },
  // Exclusive for the shared origin: one case writes the tool-grouping
  // localStorage preference, which every lane's renderer reads.
  { name: 'unit:delete-selection-neighbour', run: runDeleteSelectionNeighbourTests, needsExclusiveRun: true },
  { name: 'unit:running-tool-delete', run: runRunningToolDeleteTests },
  { name: 'unit:control-click-reveal', run: runControlClickRevealTests },
  { name: 'unit:tab-hide-focus', run: runTabHideFocusTests },
  { name: 'unit:image-lightbox', run: runImageLightboxTests },
  { name: 'unit:new-thread-focus', run: runNewThreadFocusTests, needsExclusiveRun: true },
  { name: 'unit:arrow-key-thread-focus', run: runArrowKeyThreadFocusTests, needsExclusiveRun: true },
  { name: 'unit:approval-focus-return', run: runApprovalFocusReturnTests, needsExclusiveRun: true },
  { name: 'unit:approval-draft-focus', run: runApprovalDraftFocusTests, needsExclusiveRun: true },
  { name: 'unit:nested-approval-status', run: runNestedApprovalStatusTests },
  { name: 'unit:concurrent-runs', run: runConcurrentRunsTests },
  { name: 'unit:run-records', run: runRunRecordsTests },
  { name: 'unit:expand-fold-guard', run: runExpandFoldGuardTests },
  { name: 'unit:thread-alias', run: runThreadAliasTests },
  { name: 'unit:thread-tile-state', run: runThreadTileStateTests },
  // Exclusive not for focus but for the shared origin: this suite writes the
  // tool-grouping localStorage preference, which every lane's renderer reads.
  { name: 'unit:tool-grouping', run: runToolGroupingTests, needsExclusiveRun: true },
  { name: 'unit:chime-recovery', run: runChimeRecoveryTests },
  { name: 'unit:chime-voice', run: runChimeVoiceTests },
  // Exclusive for the shared origin: this suite writes the attention prefs, and
  // one of them (tabReorder) gates every lane's Session.bumpConversation.
  { name: 'unit:tab-behaviour-prefs', run: runTabBehaviourPrefsTests, needsExclusiveRun: true },
  { name: 'unit:tab-cycle-settle', run: runTabCycleSettleTests },
  { name: 'unit:recent-tab-switcher', run: runRecentTabSwitcherTests },
  { name: 'unit:context-menu', run: runContextMenuTests },
  // Drives the document's one live Selection, which every other suite shares.
  { name: 'unit:composer-selection-quote', run: runComposerSelectionQuoteTests, needsExclusiveRun: true },
  { name: 'unit:disconnection-overlay', run: runDisconnectionOverlayTests },
  { name: 'unit:server-lost', run: runServerLostTests },
  { name: 'unit:startup-overlay', run: runStartupOverlayTests },
  { name: 'unit:extension-registry', run: runExtensionRegistryTests },
  { name: 'unit:file-viewer-registry', run: runFileViewerRegistryTests },
  { name: 'unit:pdf-viewer', run: runPdfViewerTests },
  { name: 'unit:file-view', run: runFileViewTests },
  { name: 'unit:html-file-viewer', run: runHtmlFileViewerTests },
  { name: 'unit:binary-viewer', run: runBinaryViewerTests },
  { name: 'unit:media-viewer', run: runMediaViewerTests },
  { name: 'unit:sdk-facade-parity', run: runSdkFacadeParityTests },
  { name: 'unit:i18n', run: runI18nTests },
  { name: 'unit:i18n-format-parity', run: runI18nFormatParityTests },
  { name: 'unit:i18n-pseudo-parity', run: runI18nPseudoParityTests },
  { name: 'unit:wire-protocol-parity', run: runWireProtocolParityTests },
  { name: 'unit:format-time-ago', run: runFormatTimeAgoTests },
  { name: 'unit:format-units', run: runFormatUnitsTests },
  { name: 'unit:appearance-tab', run: runAppearanceTabTests },
  { name: 'unit:language-tab', run: runLanguageTabTests },
  { name: 'unit:ui-locale-reloader', run: runUILocaleReloaderTests },
  { name: 'unit:notifications-tab', run: runNotificationsTabTests },
  { name: 'unit:settings-panel', run: runSettingsPanelTests },
  { name: 'unit:settings-api', run: runSettingsApiTests },
  { name: 'unit:settings-tabs', run: runSettingsTabsTests },
  { name: 'unit:extension-catalogs', run: runExtensionCatalogsTests },
  { name: 'unit:sdk-manifest-validation', run: runSdkManifestValidationTests },
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
  { name: 'unit:copy-button', run: runCopyButtonTests },
  { name: 'unit:live-task-output', run: runLiveTaskOutputTests },
  { name: 'unit:composer-attachments', run: runComposerAttachmentsTests },
  { name: 'unit:composer', run: runComposerTests },
  { name: 'unit:code-block', run: runCodeBlockTests },
  { name: 'unit:window-caption-controls', run: runWindowCaptionControlsTests },
  { name: 'unit:ui-event-manager', run: runUIEventManagerTests },
  { name: 'unit:properties-panel-helpers', run: runPropertiesPanelHelpersTests },
  { name: 'unit:properties-panel', run: runPropertiesPanelTests },
  { name: 'unit:workspace-dialogs', run: runWorkspaceDialogsTests },
  { name: 'unit:context-item-base', run: runContextItemBaseTests },
  { name: 'unit:capability-name-readers', run: runCapabilityNameReadersTests },
  { name: 'unit:connectivity', run: runConnectivityTests },
  { name: 'unit:logs', run: runLogsTests },
  { name: 'unit:updates-settings', run: runUpdatesSettingsTests },
  { name: 'unit:settings-first-load', run: runSettingsFirstLoadTests },
  { name: 'unit:proxy-settings', run: runProxySettingsTests },
  { name: 'unit:model-limits', run: runModelLimitsTests },
  { name: 'unit:provider-switch', run: runProviderSwitchTests },
  { name: 'unit:reconnect-policy', run: runReconnectPolicyTests },
  { name: 'unit:resync-offline-edit', run: runResyncOfflineEditTests },
  { name: 'unit:open-during-load', run: runOpenDuringLoadTests },
  { name: 'unit:session-load-failure', run: runSessionLoadFailureTests },
  { name: 'unit:app-messages', run: runAppMessagesTests },
  { name: 'unit:popup-back-button', run: runPopupBackButtonTests },
  { name: 'unit:popup-surface', run: runPopupSurfaceTests, needsExclusiveRun: true },
  { name: 'unit:model-display', run: runModelDisplayTests },
  { name: 'unit:window-title', run: runWindowTitleTests },
  { name: 'unit:context-sync-wait', run: runContextSyncWaitTests },
  { name: 'unit:conversation-notices', run: runConversationNoticesTests },
];

/**
 * Extension-owned unit suites, discovered at runtime rather than hand-listed
 * here. Each extension declares its tests in its manifest (provides.tests); the
 * test harness resolves them and serves the list at /api/test/extension-tests.
 * Populated by ensureExtensionSuitesLoaded().
 * @type {{name: string, run: function(any): Promise<{passed: number, failed: number, errors: string[]}>}[]}
 */
let EXTENSION_SUITES = [];

/**
 * Extension-owned integration tests, discovered the same way from each
 * manifest's provides.integrationTests: every definition in each module's
 * `tests` export, named `integration:<name>` like ALL_TESTS. Populated by
 * ensureExtensionSuitesLoaded().
 * @type {typeof ALL_TESTS}
 */
let EXTENSION_INTEGRATION_TESTS = [];

/** @type {Promise<void>|null} Memoized loader promise; see ensureExtensionSuitesLoaded. */
let _extensionSuitesPromise = null;

/**
 * Build the EXTENSION_SUITES entry for one extension-owned test module. An
 * extension suite declares exclusivity by exporting `needsExclusiveRun`, the
 * internal suites' table not being somewhere it can reach, and this is where
 * that export becomes the table entry listExclusiveTests() reads.
 * @param {string} name - Suite name, e.g. "unit:git-worktree"
 * @param {{runTests: function(any): Promise<any>, needsExclusiveRun?: boolean}} mod - The imported test module
 * @returns {{name: string, run: function(any): Promise<any>, needsExclusiveRun: boolean}} Table entry
 */
export function extensionSuiteEntry(name, mod) {
  return { name, run: mod.runTests, needsExclusiveRun: mod.needsExclusiveRun === true };
}

/**
 * The EXTENSION_INTEGRATION_TESTS entries for one extension-owned integration
 * module: its `tests` export, each copied under the `integration:` prefix ALL_TESTS
 * uses, flags and all.
 * @param {string} path - The module's served path, for the error
 * @param {{tests?: unknown}} mod - The imported module
 * @returns {typeof ALL_TESTS} Its definitions, renamed
 * @throws {Error} When the module exports no `tests` array
 */
export function extensionIntegrationEntries(path, mod) {
  if (!Array.isArray(mod.tests)) throw new Error(`${path} has no tests export`);
  return mod.tests.map((/** @type {any} */ t) => ({ ...t, name: `integration:${t.name}` }));
}

/**
 * Names of the extension-owned integration tests, once loaded.
 * @returns {string[]} Test names
 */
export function listExtensionIntegrationTests() {
  return EXTENSION_INTEGRATION_TESTS.map(t => t.name);
}

/**
 * Every integration test: the shared pool's and the extensions'.
 * @returns {typeof ALL_TESTS} Test definitions
 */
function allIntegrationTests() {
  return [...ALL_TESTS, ...EXTENSION_INTEGRATION_TESTS];
}

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
      /** @type {string[]} */
      let integrationModules = [];
      try {
        const resp = await fetch(apiUrl('/test/extension-tests'));
        if (resp.ok) {
          const data = await resp.json();
          list = Array.isArray(data.tests) ? data.tests : [];
          integrationModules = Array.isArray(data.integrationModules) ? data.integrationModules : [];
        }
      } catch (_) { /* endpoint absent (e.g. no source checkout) — run internal suites only */ }
      /** @type {typeof EXTENSION_SUITES} */
      const suites = [];
      for (const entry of list) {
        if (!entry || !entry.name || !entry.path) continue;
        try {
          const mod = await import(prefix + entry.path);
          if (typeof mod.runTests === 'function') {
            suites.push(extensionSuiteEntry(entry.name, mod));
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
      /** @type {typeof ALL_TESTS} */
      const integration = [];
      for (const path of integrationModules) {
        if (typeof path !== 'string' || !path) continue;
        try {
          integration.push(...extensionIntegrationEntries(path, await import(prefix + path)));
        } catch (err) {
          // Its tests cannot be named without the module, so the failure is
          // reported under the module's own name instead.
          const name = `integration:${path.split('/').pop()?.replace(/\.js$/, '')}`;
          suites.push({
            name,
            run: async () => ({ passed: 0, failed: 1, errors: [`${name}: failed to load ${path}: ${err}`] }),
          });
        }
      }
      EXTENSION_SUITES = suites;
      EXTENSION_INTEGRATION_TESTS = integration;
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
  const integrationTests = allIntegrationTests();
  logger.info(`Running ${integrationTests.length} mock-LLM tests + ${UNIT_TEST_SUITES.length + EXTENSION_SUITES.length} unit suites`);
  logger.info(`Fixture: ${ctx.fixtureDir}`);

  /** @type {string[]} */
  const errors = [];

  const { passed, failed, results } = await runIntegrationTests(integrationTests, ctx);

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
 * How long a unit suite may make no progress at all — not how long it may run.
 *
 * Progress is an assertion evaluated, a wait satisfied, or this lane's event
 * tape advancing on the conversations it owns (`stall-watch.js`), so a suite
 * whose cases are passing is never cut off however slow its core is, and a
 * suite parked on something that will never come fails one window after it
 * last moved, naming the wait it is parked on.
 *
 * Forty-five seconds of silence is far past anything a healthy case does
 * between two assertions, and still leaves the failure reported HERE, naming
 * the suite, well inside the Go harness's own silence window (two minutes of
 * no progress reports, `pollResultWhileProgressing`, browser_suite_test.go).
 */
const UNIT_SUITE_STALL_WINDOW_MS = 45000;

/**
 * The longest a unit suite may go without finishing a case, however much
 * progress it reports.
 *
 * The stall window catches a wedge; this catches the one shape it cannot — a
 * case that keeps making progress and never finishes, a loop re-running its
 * own steps. Finishing a case is what such a loop cannot fake
 * (`noteCaseFinished`, test-deadline.js), so the bound re-arms every time a
 * case finishes: it bounds the gap between two finished cases, never the
 * suite, and a suite that is merely slow keeps finishing cases and is never
 * cut off by it. A suite that does not report its cases is one case from
 * start to end.
 *
 * The span is wall time by necessity — it is what "runaway" means — and is
 * not scaled for a slow core, because the page cannot see the slow-core
 * factor (it duty-cycles processes from the Go side) and because the Go
 * harness's own backstop for one browser subtest, `resultCeiling` (twelve
 * minutes, browser_suite_test.go), is not scaled either. Eight minutes leaves
 * four for this report to reach the Go side first.
 */
const UNIT_CASE_GAP_MS = 8 * 60_000;

/**
 * The document-wide state a suite can change for every suite after it: the
 * attributes of `<html>` and `<body>` (classes, `data-theme`, `data-view`,
 * inline style). Product CSS keys whole regions off them — `data-view`
 * restyles the layout — and a lane's page outlives every suite it runs,
 * so one left behind silently restyles the rest of the lane.
 * @returns {{html: Map<string, string>, body: Map<string, string>}} The attributes, by name.
 */
export function snapshotDocumentState() {
  /**
   * @param {Element} el - The element to read.
   * @returns {Map<string, string>} Its attributes, by name.
   */
  const attrs = (el) => new Map(Array.from(el.attributes, (a) => [a.name, a.value]));
  return { html: attrs(document.documentElement), body: attrs(document.body) };
}

/**
 * Put `<html>` and `<body>` back as {@link snapshotDocumentState} found them,
 * and say what had changed.
 * @param {{html: Map<string, string>, body: Map<string, string>}} before - The snapshot.
 * @returns {string[]} One line per attribute that differed; empty when none did.
 */
export function restoreDocumentState(before) {
  /** @type {string[]} */
  const leaks = [];
  for (const [tag, el, was] of /** @type {const} */ ([['html', document.documentElement, before.html], ['body', document.body, before.body]])) {
    const now = new Map(Array.from(el.attributes, (a) => [a.name, a.value]));
    for (const name of new Set([...was.keys(), ...now.keys()])) {
      // A class toggled off and back on returns at the end of the list: same
      // classes, so not a leak. An empty class or style attribute is none at
      // all (setting and then clearing an inline style leaves `style=""`).
      /**
       * @param {string|undefined} v - The attribute's value, or undefined when absent.
       * @returns {string|undefined} The value as compared.
       */
      const norm = (v) => {
        if (name === 'class') return classSet(v);
        if (name === 'style') return v || '';
        return v;
      };
      const same = norm(was.get(name)) === norm(now.get(name));
      if (same) continue;
      leaks.push(`left <${tag}> ${name}=${JSON.stringify(now.get(name) ?? null)} (was ${JSON.stringify(was.get(name) ?? null)})`);
      const value = was.get(name);
      if (value === undefined) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  }
  return leaks;
}

/**
 * @param {string|undefined} value - A class attribute, or undefined when absent.
 * @returns {string} Its classes, sorted and space-joined.
 */
function classSet(value) {
  return (value || '').split(/\s+/).filter(Boolean).sort().join(' ');
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
 * @returns {Promise<{passed: number, failed: number, errors: string[], budgetWarning?: string}>} Suite results after cleanup, with {@link suiteBudgetWarning}'s verdict on its time.
 */
async function runUnitSuiteWithConvCleanup(suite, ctx) {
  setCurrentTestName(suite.name);
  // Arm the deadline every wait in this suite rides, and bound the suite itself.
  //
  // Without the deadline, a unit suite's waits fall back to nominal timeouts
  // chosen when a lane had the pool to itself. Without the bound, a suite that
  // wedges never posts a result at all and the Go side reports a bare poll
  // timeout naming nothing; here it says which suite stopped, and where.
  setTestDeadline(Date.now() + UNIT_SUITE_STALL_WINDOW_MS, { shared: true });
  // Unit suites share one document AND one popup-manager registry, so an
  // overlay a prior suite left open leaks into this one. The confirm/alert host
  // is a reused <modal-dialog> singleton (see modal-dialog.js): showConfirm and
  // showAlert only resolve on a user click, so a suite that opens one without
  // dismissing it leaves `modal-dialog.show` in the DOM — and any later suite
  // that consults it globally (e.g. hold-to-cycle's defaultShouldHandle, which
  // treats an open modal as "don't handle") then fails. The open-state token is
  // worse, because it is invisible: `suppressedByOverlay()` reads it, so one
  // stray token disables every shortcut for the rest of the lane. Sweep both
  // before and after each suite so isolation holds regardless of neighbour
  // order — and, for a suite this function's own timeout abandons below, so
  // that it holds at all.
  neutralizeStrayOverlays();
  const before = snapshotOwnConversationIds();
  const documentBefore = snapshotDocumentState();
  takeContextMenusLeftToPlatform();
  try {
    // A stall is reported as a failed result rather than thrown, so one wedged
    // suite fails alone instead of ending the lane's whole run.
    //
    // The deadline moves with the suite's progress, and every wait inside it
    // follows (`deadlineMoves`, test-deadline.js), so a late case on a slow
    // core starts with a whole window rather than whatever was left of a
    // budget armed when the suite began.
    const startedAt = Date.now();
    const workers = watchWorkerProgress(() => Array.from(snapshotOwnConversationIds()));
    const watchdog = watchForStall({
      subject: `${suite.name}: unit suite`,
      windowMs: UNIT_SUITE_STALL_WINDOW_MS,
      unobservable: () => workers.unanswered() || awaitingServer(),
      stamp: () => `${progressMark()}|${__lastTapeTsForTests(Array.from(snapshotOwnConversationIds()))}|${workers.mark()}`,
      onExtend: (deadlineMs) => {
        moveTestDeadline(deadlineMs, { shared: true });
        reportTestProgress();
      }
    });
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let gapTimer;
    let casesAtArm = caseMark();
    /** @type {Promise<{stopped: string}>} */
    const runaway = new Promise((resolve) => {
      // Re-armed for a whole gap whenever a case finished during the last one.
      const check = () => {
        if (caseMark() !== casesAtArm) {
          casesAtArm = caseMark();
          arm();
          return;
        }
        resolve({
          stopped: `${suite.name}: unit suite finished no case for ${UNIT_CASE_GAP_MS / 60_000} minutes, though it kept reporting progress — a case is looping`
        });
      };
      const arm = () => {
        // A wall-clock span on purpose: a case still unfinished after this
        // long is what "runaway" means (UNIT_CASE_GAP_MS).
        gapTimer = setTimeout(check, UNIT_CASE_GAP_MS);
      };
      arm();
    });
    /** @type {{value: {passed: number, failed: number, errors: string[], budgetWarning?: string}} | {stopped: string}} */
    let settled;
    try {
      settled = await Promise.race([
        suite.run(ctx).then((value) => ({ value })),
        watchdog.stalled.catch((/** @type {unknown} */ e) => ({ stopped: e instanceof Error ? e.message : String(e) })),
        runaway
      ]);
    } finally {
      watchdog.stop();
      workers.stop();
      clearTimeout(gapTimer);
    }
    if ('stopped' in settled) {
      // Taken before anything else is awaited, so the waits it describes are
      // as they stood when the suite stopped.
      const parked = waitsInFlightReport();
      return {
        passed: 0,
        failed: 1,
        errors: [
          `${settled.stopped} — it never returned a result (${watchdog.stalls()}, ${Math.round((Date.now() - startedAt) / 1000)}s in all)`,
          ...parked,
          ...projectSizeLines(await fetchProjectSize()),
          ...await machineLoadReport()
        ]
      };
    }
    const result = settled.value;
    // Read before the cleanup below, which is the runner's time, not the suite's.
    result.budgetWarning = suiteBudgetWarning(suite.name, { wallMs: Date.now() - startedAt });
    // Checked before the cleanup below, so what it finds is the suite's own.
    const leaks = restoreDocumentState(documentBefore);
    if (leaks.length > 0) {
      result.failed++;
      result.errors = [...result.errors, `${suite.name}: ${leaks.join('; ')} — put back what it changes, or every suite after it on this lane runs under it`];
    }
    const leftToPlatform = takeContextMenusLeftToPlatform();
    if (leftToPlatform.length > 0) {
      result.failed++;
      result.errors = [...result.errors, `${suite.name}: left ${leftToPlatform.length} contextmenu event(s) uncancelled at the end of dispatch (sent at ${leftToPlatform.join(', ')}) — WebKit builds its own menu for one, synthetic or not, and over editable text that blocks the pool's main thread on AppKit building the Spelling panel. Read whether the app cancelled it from a listener on the target, then cancel it there`];
    }
    // Every lane shares one project, so how many conversations were in it is a
    // property of the run rather than of this suite — and a suite that fails
    // only under a full pool is the one case where that number is the evidence.
    // Integration tests carry the same two lines (see projectSizeLines).
    if (result.failed > 0) {
      result.errors = [
        ...result.errors,
        ...projectSizeLines(await fetchProjectSize()),
        ...await machineLoadReport()
      ];
    }
    return result;
  } finally {
    // Disarm before cleanup: the deadline belongs to the suite, and cleanup
    // running under an expired one would give every wait in it a zero budget.
    clearTestDeadline();
    neutralizeStrayOverlays();
    // Again for a suite the budget abandoned, which reported no result to
    // charge a leak to but must not hand one on either.
    restoreDocumentState(documentBefore);
    // A suite that saved a command, a skill or a plugin toggle left a registry
    // rebuild running behind it — those call sites deliberately don't await one
    // (see __whenRegistriesSettledForTests). The suites of a lane share one realm and
    // therefore one set of registries, so an outstanding rebuild is the next
    // suite's problem: it would find the registries reset and read an empty
    // one. Wait it out here, where the ownership boundary is. Best-effort — a
    // rebuild that rejects (a plugin whose init throws) must not mask the
    // suite's own result.
    await __whenRegistriesSettledForTests().catch(() => {});
    await deleteOwnConversationsCreatedSince(before, `unit-cleanup:${suite.name}`);
    // Client-side counterpart of the delete above: that frees the server's
    // copy, this frees ours. A Session the suite left alive holds a Yjs doc
    // per conversation in the shared project, and the lane page outlives
    // every suite it runs, so an unswept one is retained for the whole run.
    destroyTrackedTestSessions();
  }
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

  if (!wsService.isConnected()) await connectTestWebSocket(wsService);

  wsService.on('message', (/** @type {any} */ data) => {
    if (data.type === 'worker-message') {
      workerManager.handleWorkerMessageFromWS(data);
    }
  });
}

/**
 * How long the engine's handshake may sit on one step before the lane reports
 * it stuck. The bound is on a step, not on the whole connect: a handshake that
 * keeps moving — server answering, then socket open, then live — is being
 * served, however slowly, and a slow core takes its time over every step.
 */
const ENGINE_STEP_WINDOW_MS = 30_000;

/** The ceiling on the whole connect, for a handshake that flaps between steps forever. */
const ENGINE_CONNECT_CEILING_MS = 5 * 60_000;

/**
 * Wait for the engine iframe to connect to the server.
 * Polls GET /api/engine/status until connected: true, one request at a time.
 *
 * The handshake has three steps a poll can see — the server answering at all,
 * the engine's socket open (`socket`), and its realm heartbeating within the
 * liveness window (`connected`) — and each failure stops at a different one.
 * So the failure names every distinct step it saw, in order, with how long it
 * stayed there: "socket never opened" and "opened, then went silent for 30s"
 * are different faults.
 * @returns {Promise<void>}
 */
async function waitForEngineConnected() {
  const started = Date.now();
  /** @type {{step: string, detail: string, at: number}[]} */
  const steps = [];
  /**
   * @param {string} step - What this poll saw; a change of step starts a new entry.
   * @param {string} [detail] - Its latest reading, which may change from poll to poll.
   */
  const saw = (step, detail = '') => {
    const last = steps[steps.length - 1];
    if (last?.step === step) last.detail = detail;
    else steps.push({ step, detail, at: Date.now() - started });
  };
  let polls = 0;
  let connected = false;
  /** @type {Promise<void>|null} */
  let inFlight = null;
  const poll = async () => {
    polls++;
    try {
      const resp = await fetch(apiUrl('/engine/status'));
      if (resp.ok) {
        const data = await resp.json();
        if (data.connected) { connected = true; return; }
        if (data.socket) saw('socket open but not live', `silent ${data.silentFor ?? '?'}, ${data.queuedWrites ?? '?'} queued writes`);
        else saw('answered, no engine socket');
      } else {
        saw('status answered with an error', `HTTP ${resp.status}`);
      }
    } catch (e) {
      saw('status unanswered', e instanceof Error ? e.message : String(e));
    }
  };
  const render = (/** @type {{step: string, detail: string, at: number}} */ s) =>
    `+${(s.at / 1000).toFixed(1)}s ${s.step}${s.detail ? ` (${s.detail})` : ''}`;
  const account = () => {
    const last = steps[steps.length - 1];
    return `last step seen: ${last ? render(last) : 'none'}; ${polls} poll(s), every step: ${steps.map(render).join(' → ') || 'no poll completed'}`;
  };
  const watch = watchForStall({
    subject: 'Engine connect',
    windowMs: ENGINE_STEP_WINDOW_MS,
    stamp: () => `${steps.length}|${polls > 0}`,
    onExtend: () => {}
  });
  try {
    await Promise.race([
      waitFor(() => {
        if (connected) return true;
        inFlight ??= poll().finally(() => { inFlight = null; });
        return false;
      }, { timeoutMs: ENGINE_CONNECT_CEILING_MS, intervalMs: 200, description: () => `the engine to connect — ${account()}` }),
      watch.stalled
    ]);
  } catch (e) {
    throw new Error(`Engine did not connect: ${e instanceof Error ? e.message : String(e)} — ${account()}`, { cause: e });
  } finally {
    watch.stop();
  }
}

/**
 * Run a specific test by name — handles both integration tests and unit test suites.
 * @param {string} testName - Name of the test to run
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, errors: string[], budgetWarning?: string}>} Test results; a unit suite's carry its {@link suiteBudgetWarning}
 */
export async function runTestByName(testName, ctx) {
  installFetchTracking();
  setReportedTest(testName);
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
      const resetUrl = apiUrl(`/test/reset-fixture?fixture=unit-test-fixture&dir=${encodeURIComponent(ctx.fixtureDir)}`);
      const resetResp = await fetch(resetUrl, { method: 'POST' });
      if (!resetResp.ok) {
        const errText = await resetResp.text();
        return { passed: 0, failed: 1, errors: [`Fixture reset failed: ${resetResp.status} ${errText}`] };
      }
    }

    const unitCtx = /** @type {any} */ (ctx);
    if (!unitCtx.readFile) {
      const { readFile } = await import('../../js/services/ops-api.js');
      unitCtx.readFile = async (/** @type {string} */ relativePath) => {
        const result = await readFile({ path: `${ctx.fixtureDir}/${relativePath}` });
        return (/** @type {any} */ (result)).content ?? '';
      };
    }
    return await runUnitSuiteWithConvCleanup(unitSuite, unitCtx);
  }

  /** @type {typeof ALL_TESTS} */
  const selected = [];
  for (const name of names) {
    const test = allIntegrationTests().find(t => t.name === name);
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
 * Turn a test's counts into the verdict the Go runner receives.
 *
 * Zero passed and zero failed is a test that asserted nothing — a case table
 * that came out empty, a run() that returned before its first case — and it
 * fails, naming itself, rather than reading as a pass.
 * @param {string} name - The test's name, for the error line
 * @param {{passed: number, failed: number, errors?: string[]}} result - Its counts
 * @returns {{passed: boolean, errors: string[]}} The verdict and the errors to report
 */
export function suiteVerdict(name, result) {
  const errors = [...(result.errors || [])];
  if (result.failed === 0 && !(result.passed > 0)) {
    errors.push(`${name}: NO TESTS RAN — it reported 0 passed and 0 failed, so it asserted nothing`);
    return { passed: false, errors };
  }
  return { passed: result.failed === 0, errors };
}

/**
 * Own wall time past which a passing unit suite is flagged as due a split —
 * the size past which a suite is split rather than allowed to grow.
 */
const SUITE_SPLIT_MS = 10_000;

/**
 * The warning a passing unit suite earns by crossing {@link SUITE_SPLIT_MS}.
 *
 * A passing suite prints nothing, so without this the next suite to outgrow its
 * budget is found the way `run-code-program` was: by its sightings, as a suite
 * that "stopped making progress". The Go harness writes what this returns to
 * the file `check` and `test-all` report from, never as a failure.
 *
 * The time is wall time, and in a concurrent run — or on a slow core — a lane
 * costs several times its idle cost, so the reader weighs it against the run's
 * `machine:` line and times the suite alone before splitting anything.
 * @param {string} name - The suite.
 * @param {{wallMs: number}} timing - Its wall time.
 * @returns {string} The warning, or '' for a suite within the line.
 */
export function suiteBudgetWarning(name, { wallMs }) {
  if (wallMs <= SUITE_SPLIT_MS) return '';
  return `${name} ${(wallMs / 1000).toFixed(1)}s`;
}

/**
 * List all available tests (integration + unit suites).
 * @returns {string[]} Test names
 */
export function listTests() {
  return [
    ...allIntegrationTests().map(t => t.name),
    ...UNIT_TEST_SUITES.map(s => s.name),
    ...EXTENSION_SUITES.map(s => s.name),
  ];
}

/**
 * Collect the names of entries flagged `needsExclusiveRun` across any number of
 * suite tables. One flag, read the same way from every table — an integration
 * test, an internal unit suite and an extension suite all reach the Go runner
 * through here, and `unit:exclusive-test-flags` holds that open.
 * @param {...{name: string, needsExclusiveRun?: boolean}[]} tables - Suite tables to scan
 * @returns {string[]} Names of the flagged entries, in table order
 */
export function exclusiveNamesIn(...tables) {
  return tables.flat().filter(entry => entry.needsExclusiveRun).map(entry => entry.name);
}

/**
 * List tests the Go runner must schedule sequentially, with no sibling lane in
 * flight. Every reason is about state the lanes share and cannot namespace
 * per-test, and any kind of suite can have one:
 *
 *   - it writes a fixed-name file to the shared fixture root that production
 *     auto-detection scans (`CLAUDE.md`, `.juggler/MEMORY.md`), so while it
 *     exists a sibling lane's createConversation gains a phantom context item;
 *   - it builds and removes directories in that root, which a sibling lane
 *     walking the project reads while they come and go;
 *   - it asserts on `document.activeElement`, which a sibling lane invalidates
 *     by calling focus() — all lanes are iframes in one window, and only one
 *     frame holds focus at a time;
 *   - it writes a document-wide or origin-wide setting (`data-theme`, a
 *     localStorage preference key) for the length of a case;
 *   - it switches a plugin on or off in the project config, which changes the
 *     tools and system prompt every lane of that server is offered.
 *
 * Everything listed is shared by the lanes of one server and no further — each
 * server has its own window, fixture, origin and settings — so the Go runner
 * runs each of these in a server of its own while the rest of the pool carries
 * on: a solo window, one lane and no sibling, with a fixture reset before and
 * after (see TestBrowser and lanePool in tests/integration/browser). An
 * extension suite declares the flag by exporting `needsExclusiveRun`;
 * everything else declares it on its table entry.
 * @returns {string[]} Names of tests that must run in isolation
 */
export function listExclusiveTests() {
  return exclusiveNamesIn(allIntegrationTests(), UNIT_TEST_SUITES, EXTENSION_SUITES);
}
