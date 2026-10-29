//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit Test Executor - Runs plugin unit tests without LLM
 *
 * Unlike TestExecutor, this executor:
 * 1. Sets up fixture and session
 * 2. Runs the test module directly (no LLM prompt)
 * 3. Reports results
 *
 * Used for testing plugin lifecycle, registries, and utilities.
 */

import TestScorer from './test-scorer.js';
import logger from './test-logger.js';
import { connectTestWebSocket } from './ws-connect.js';

/**
 * @typedef {object} TestResult
 * @property {string} taskId - Task identifier
 * @property {string} category - Task category
 * @property {number} score - Score from 0.0 to 1.0
 * @property {boolean} passed - Whether all tests passed (score === 1.0)
 * @property {string} details - Details about the test result
 * @property {number} duration - Duration in seconds
 * @property {string} [error] - Error message if test failed
 * @property {number} [testsPassed] - Number of tests passed (for integration/unit tests)
 * @property {number} [testsTotal] - Total number of tests (for integration/unit tests)
 */

/**
 * @typedef {object} TaskDefinition
 * @property {string} id - Task identifier
 * @property {string} category - Task category
 * @property {string} description - Human-readable description
 * @property {string} fixture - Fixture name
 * @property {object} scoring - Scoring configuration
 * @property {string} scoring.type - Should be 'unit_test'
 * @property {string} scoring.test_module - Test module path
 */

/**
 * Unit Test Executor
 * @class
 */
class UnitTestExecutor {
  /**
   * @param {TaskDefinition} taskDef - Task definition
   */
  constructor(taskDef) {
    /** @type {TaskDefinition} @private */
    this.task = taskDef;

    /** @type {import('../../js/model/session.js').default|null} @private */
    this.session = null;

    /** @type {string|null} @private */
    this.fixtureDir = null;

    /** @type {number} @private */
    this.startTime = 0;
  }

  /**
   * Execute the unit test task
   * @returns {Promise<TestResult>} The test result
   */
  async execute() {
    this.startTime = Date.now();

    try {
      // projectPath is provided by the Go test runner (juggler-test)
      const urlParams = new URLSearchParams(window.location.search);
      const projectPath = urlParams.get('projectPath');

      if (!projectPath) {
        throw new Error('projectPath URL parameter is required. Tests must be run via juggler-test.');
      }

      logger.info(`Using pre-created fixture: ${projectPath}`);
      this.fixtureDir = projectPath;
      await this.createTestSession();

      // Run the unit tests directly (no LLM involved)
      logger.info('Running unit tests');
      const scoreResult = await this.runTests();

      const duration = (Date.now() - this.startTime) / 1000;
      const testsPassed = scoreResult.testsPassed ?? 0;
      const testsTotal = scoreResult.testsTotal ?? 0;

      return {
        taskId: this.task.id,
        category: this.task.category,
        score: scoreResult.score,
        passed: testsTotal > 0 && testsPassed === testsTotal,
        details: scoreResult.details,
        duration: duration,
        testsPassed: testsPassed,
        testsTotal: testsTotal
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Unit test error for ${this.task.id}: ${errorMessage}`);

      const duration = (Date.now() - this.startTime) / 1000;

      return {
        taskId: this.task.id,
        category: this.task.category,
        score: 0,
        passed: false,
        details: `Execution error: ${errorMessage}`,
        duration: duration,
        error: errorMessage
      };

    } finally {
      await this.cleanup();
    }
  }

  /**
   * Create a test session.
   * @private
   */
  async createTestSession() {
    // Initialize registries first (required for session/conversation creation)
    const { default: strategyRegistry } = await import('../../js/registries/strategy-registry.js');
    if (!strategyRegistry.isInitialized()) {
      await strategyRegistry.init();
    }

    const apiServiceModule = await import('../../js/services/api.js');
    const apiService = apiServiceModule.default;

    if (!apiService) {
      throw new Error('Failed to import API service');
    }

    const SessionModule = await import('../../js/model/session.js');
    const Session = SessionModule.default;

    if (!Session) {
      throw new Error('Could not import Session class');
    }

    /** @type {any} */
    const typedApiService = apiService;
    this.session = new Session(typedApiService);

    // Set up mock services (minimal - unit tests don't need UI)
    const services = await this._createMockServices();
    this.session.setServices(services);

    // CRITICAL: Connect WebSocket BEFORE loading session
    // session.persistence.load() spawns workers which send messages via WebSocket
    const wsServiceModule = await import('../../js/services/websocket.js');
    const wsService = wsServiceModule.default;
    if (!wsService.isConnected()) {
      await this._connectWebSocket(wsService);
    }

    // Set up worker message routing (normally done by app.js)
    const { default: workerManager } = await import('../../js/services/worker-manager.js');
    wsService.on('message', (/** @type {any} */ data) => {
      if (data.type === 'worker-message') {
        workerManager.handleWorkerMessageFromWS(data);
      }
    });

    await this.session.persistence.load();

    logger.debug(`Session created`);
  }

  /**
   * Connect WebSocket to a session
   * @param {any} wsService - WebSocket service
   * @returns {Promise<void>} Resolves when connected
   * @private
   */
  async _connectWebSocket(wsService) {
    return connectTestWebSocket(wsService);
  }


  /**
   * Create mock services for test session.
   * @returns {Promise<import('../../js/model/session.js').ConversationServices>} Mock services object
   * @private
   */
  async _createMockServices() {
    const { default: LLMState } = await import('../../js/services/llm-state.js');

    return /** @type {any} */ ({
      llmState: new LLMState(),
      animationService: {
        observeHeight: () => {},
        unobserveHeight: () => {},
        observeScrollPosition: () => {},
        animateThinking: () => {},
        stopThinking: () => {}
      },
      actionExecutor: {
        cancelAllActions: () => {},
        cancelConversationActions: () => 0,
        hasRunningActionsFor: () => false,
        onSettled: () => () => {}
      },
      workerManager: (await import('../../js/services/worker-manager.js')).default,
      wsService: {
        sendCancel: () => {},
        on: () => () => {},
        off: () => {}
      }
    });
  }

  /**
   * Run the unit tests.
   * @returns {Promise<{score: number, details: string, testsPassed?: number, testsTotal?: number}>} Score result
   * @private
   */
  async runTests() {
    if (!this.fixtureDir || !this.session) {
      throw new Error('Fixture or session not initialized');
    }

    const scorer = new TestScorer(this.task, this.fixtureDir);
    return await scorer.score();
  }

  /**
   * Cleanup test resources
   * Note: Fixture cleanup is handled by the Go test runner (juggler-test)
   * @private
   */
  async cleanup() {
    logger.info('Cleaning up...');

    // Disconnect WebSocket to allow clean reconnection on retry
    try {
      const wsServiceModule = await import('../../js/services/websocket.js');
      const wsService = wsServiceModule.default;
      if (wsService.isConnected()) {
        wsService.disconnect();
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    // Terminate any lingering workers
    try {
      const { default: workerManager } = await import('../../js/services/worker-manager.js');
      workerManager.terminateAll();
    } catch (e) {
      // Ignore cleanup errors
    }

    // Fixture cleanup is handled by the Go test runner
  }
}

export default UnitTestExecutor;
