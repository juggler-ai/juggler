//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

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
 * @typedef {object} ScoreResult
 * @property {number} score - Score from 0.0 to 1.0
 * @property {string} details - Scoring details
 * @property {number} [testsPassed] - Number of tests passed
 * @property {number} [testsTotal] - Total number of tests
 */

/**
 * @typedef {object} StateObject
 * @property {number|null} checkInterval - Check interval ID
 * @property {number|null} timeout - Timeout ID
 * @property {number|null} [connectionTimeout] - Connection timeout ID
 */

/**
 * @typedef {object} TaskDefinition
 * @property {string} id - Task identifier
 * @property {string} category - Task category (e.g., "simple-bug-fixes")
 * @property {string} description - Human-readable description
 * @property {string} fixture - Fixture name (directory in tests/benchmarks/fixtures/)
 * @property {string} prompt - Prompt to send to LLM
 * @property {string} [strategy] - Optional strategy to use (default, read-only, yolo)
 * @property {object} scoring - Scoring configuration
 * @property {string} scoring.type - Scoring type (file_contains, test_pass, etc.)
 * @property {number} [scoring.timeout] - Optional timeout in seconds for scoring operations (test execution, not conversation)
 * @property {object} [metadata] - Optional metadata (difficulty, tags, etc.)
 */

/**
 * NOTE: Tests no longer have a timeout - they run until the agent naturally completes
 * or hits the max iteration limit (15). This ensures we're testing the production behavior.
 */

/**
 * Test Executor - Runs individual test tasks using real Juggler APIs
 * @class
 */

import TestScorer from './test-scorer.js';
import logger from './test-logger.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import providersCache from '../../js/services/providers-cache.js';
import { apiUrl } from '../../js/utils/api-url.js';


/**
 * Select a default provider/model for a conversation when none is set.
 * Test-only helper: fetches from the config API and falls back to the first
 * available provider with a model. (Production code never auto-selects here —
 * the UI drives model selection.)
 * @param {any} conversation - Conversation to configure
 * @returns {Promise<void>}
 */
async function selectDefaultProvider(conversation) {
  // Skip if already configured
  if (conversation.modelConfig) {
    return;
  }

  // Try to get from config first
  try {
    const configResponse = await fetch(apiUrl('/config'));
    if (configResponse.ok) {
      const config = await configResponse.json();
      const modelStr = config.model || '';

      // Parse model string (format: "provider/model-name"). The model part may
      // itself contain "/", so split on the first slash only.
      if (modelStr) {
        const i = modelStr.indexOf('/');
        if (i > 0 && i < modelStr.length - 1) {
          conversation.setModelConfig({
            provider: modelStr.slice(0, i),
            model: modelStr.slice(i + 1)
          });
          return;
        }
      }
    }
  } catch (error) {
    console.warn(`[ESSENTIAL] [TestExecutor] Failed to fetch config: ${error}`);
  }

  // Fall back to first available provider
  try {
    const providers = providersCache.hasReceived()
      ? providersCache.get()
      : await providersCache.waitForFirst();

    const availableProvider = providers.find(/**
                                              * @param {any} p
                                              * @returns {boolean} True if provider is available
                                              */
      (p) => p.available);
    if (availableProvider && availableProvider.modelsWithContext && availableProvider.modelsWithContext.length > 0) {
      conversation.setModelConfig({
        provider: availableProvider.name,
        model: availableProvider.modelsWithContext[0]?.id
      });
      return;
    }
  } catch (error) {
    console.warn(`[ESSENTIAL] [TestExecutor] Failed to read providers: ${error}`);
  }

  throw new Error('No provider/model available');
}


class TestExecutor {
  /**
   * @param {TaskDefinition} taskDef - Task definition
   * @param {string|null} provider - Optional provider to use (anthropic, gemini, zai)
   * @param {string|null} model - Optional model name to use
   */
  constructor(taskDef, provider = null, model = null) {
    /** @type {TaskDefinition} @private */
    this.task = taskDef;

    /** @type {string|null} @private */
    this.provider = provider;

    /** @type {string|null} @private */
    this.model = model;

    /** @type {import('../../model/session.js').default|null} @private */
    this.session = null;

    /** @type {import('../../model/conversation.js').default|null} @private */
    this.conversation = null;

    /** @type {string|null} @private */
    this.fixtureDir = null;

    /** @type {number} @private */
    this.startTime = 0;
  }

  /**
   * Execute the test task
   * @returns {Promise<TestResult>} The test result with score and details
   */
  async execute() {
    this.startTime = Date.now();

    try {
      // Initialize registries (context items, actions, strategies) before creating session
      // This is required because sessions load conversations that need strategy support
      if (!contextItemRegistry.isInitialized()) {
        await contextItemRegistry.init();
      }
      if (!contextItemRegistry.isInitialized()) {
        await contextItemRegistry.init();
      }
      if (!strategyRegistry.isInitialized()) {
        await strategyRegistry.init();
      }

      // projectPath is provided by the Go test runner (juggler-test)
      const urlParams = new URLSearchParams(window.location.search);
      const projectPath = urlParams.get('projectPath');

      if (!projectPath) {
        throw new Error('projectPath URL parameter is required. Tests must be run via juggler-test.');
      }

      // Use pre-created fixture directory from Go test runner
      logger.info(`Using pre-created fixture: ${projectPath}`);
      this.fixtureDir = projectPath;

      // Create session for this test
      logger.info(`Creating test session for ${this.fixtureDir}`);
      await this.createTestSession();

      // 3. Create conversation
      logger.info('Creating conversation');
      await this.createConversation();

      // 4. Send test prompt and wait for completion
      // Note: Session automatically creates context items (tree, etc.) during load()
      logger.info(`[TestExecutor] Using LLM: provider=${this.conversation?.modelConfig?.provider || 'unknown'}, model=${this.conversation?.modelConfig?.model || 'unknown'}`);
      logger.info('Sending prompt and waiting for response');
      await this.sendPromptAndWait();

      // 6. Score the results
      logger.info('Scoring results');
      const scoreResult = await this.scoreResults();

      const duration = (Date.now() - this.startTime) / 1000;
      const testsPassed = scoreResult.testsPassed ?? 0;
      const testsTotal = scoreResult.testsTotal ?? 0;

      // Pass only if ALL tests pass (no partial credit)
      const passed = testsTotal > 0
        ? testsPassed === testsTotal
        : scoreResult.score === 1.0;

      return {
        taskId: this.task.id,
        category: this.task.category,
        score: scoreResult.score,
        passed: passed,
        details: scoreResult.details,
        duration: duration,
        testsPassed: testsPassed,
        testsTotal: testsTotal
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Test execution error for ${this.task.id}: ${errorMessage}`);
      console.error(`Full error: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`);

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
      // 7. Cleanup
      await this.cleanup();
    }
  }

  /**
   * Create mock services for test session
   * @returns {Promise<import('../../model/session.js').ConversationServices>} Mock services object
   * @private
   */
  async _createMockServices() {
    const { default: LLMState } = await import('../../js/services/llm-state.js');

    if (!LLMState) {
      throw new Error('Failed to import required services');
    }

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
        cancelAllActions: () => {}
      },
      wsService: {
        sendCancel: () => {},
        on: () => {},
        off: () => {}
      }
    });
  }

  /**
   * Connect WebSocket to a session
   * @param {any} wsService - WebSocket service
   * @returns {Promise<void>} Resolves when connected
   * @private
   */
  async _connectWebSocket(wsService) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsService.off('open', onOpen);
        wsService.off('error', onError);
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      const onOpen = () => {
        clearTimeout(timeout);
        wsService.off('open', onOpen);
        wsService.off('error', onError);
        resolve();
      };

      const onError = () => {
        clearTimeout(timeout);
        wsService.off('open', onOpen);
        wsService.off('error', onError);
        reject(new Error('WebSocket connection error'));
      };

      wsService.on('open', onOpen);
      wsService.on('error', onError);
      wsService.connect();
    });
  }

  /**
   * Load an existing session (used when Go runner pre-creates the session)
   * @private
   */
  async loadExistingSession() {
    console.warn(`[ESSENTIAL] [Test] loadExistingSession called`);

    // Import API service
    const apiServiceModule = await import('../../js/services/api.js');
    const apiService = apiServiceModule.default;

    if (!apiService) {
      throw new Error('Failed to import API service');
    }

    // Import Session class
    const SessionModule = await import('../../js/model/session.js');
    const Session = SessionModule.default;

    if (!Session) {
      throw new Error('Could not import Session class');
    }

    /** @type {any} */
    const typedApiService = apiService;
    this.session = new Session(typedApiService);

    // Set up mock services
    const services = await this._createMockServices();
    this.session.setServices(services);

    // Connect WebSocket before loading
    const wsServiceModule = await import('../../js/services/websocket.js');
    const wsService = wsServiceModule.default;
    console.warn(`[ESSENTIAL] [Test] Before connect: isConnected=${wsService.isConnected()}`);
    if (!wsService.isConnected()) {
      console.warn(`[ESSENTIAL] [Test] Calling _connectWebSocket...`);
      await this._connectWebSocket(wsService);
      console.warn(`[ESSENTIAL] [Test] WebSocket connected! isConnected=${wsService.isConnected()}`);
    }

    // Load the session
    console.warn(`[ESSENTIAL] [Test] About to call session.load()`);
    await this.session.load();

    logger.debug(`Session loaded`);
  }

  /**
   * Create a test session using real Session API
   * @private
   */
  async createTestSession() {
    // Import API service - it exports a singleton instance
    const apiServiceModule = await import('../../js/services/api.js');
    const apiService = apiServiceModule.default;

    if (!apiService) {
      throw new Error('Failed to import API service');
    }

    // Import Session class
    const SessionModule = await import('../../js/model/session.js');
    const Session = SessionModule.default;

    if (!Session) {
      throw new Error('Could not import Session class');
    }

    /** @type {any} */
    const typedApiService = apiService;
    this.session = new Session(typedApiService);

    // CRITICAL: Set services BEFORE loading
    // Session requires services for conversation management, but tests don't need UI updates
    const services = await this._createMockServices();
    this.session.setServices(services);

    // Connect WebSocket BEFORE loading session
    // Session.load() spawns workers which send messages via WebSocket
    const wsServiceModule = await import('../../js/services/websocket.js');
    const wsService = wsServiceModule.default;
    console.warn(`[ESSENTIAL] [Test] WebSocket isConnected=${wsService.isConnected()}`);
    if (!wsService.isConnected()) {
      console.warn(`[ESSENTIAL] [Test] Calling _connectWebSocket...`);
      await this._connectWebSocket(wsService);
      console.warn(`[ESSENTIAL] [Test] WebSocket connected! isConnected=${wsService.isConnected()}`);
    }

    // Set up worker message routing (normally done by app.js)
    const { default: workerManager } = await import('../../js/services/worker-manager.js');
    wsService.on('message', (/** @type {any} */ data) => {
      if (data.type === 'worker-message') {
        workerManager.handleWorkerMessageFromWS(data);
      }
    });

    // Load session data
    await this.session.load();

    logger.debug(`Session created`);
  }

  /**
   * Create conversation in the session
   * @private
   */
  async createConversation() {
    if (!this.session) {
      throw new Error('Session not initialized');
    }

    // Create a new conversation
    const convId = await this.session.createConversation('');
    this.conversation = this.session.conversations.get(convId) || null;

    if (!this.conversation) {
      throw new Error('Failed to create conversation');
    }

    // Point the session's "conversation on screen" at the one under test.
    // createConversation() doesn't activate what it creates, so without this the
    // session still considers the bootstrap tab visible and the session-wide
    // paths that act on the visible conversation — the watcher fan-out that
    // refreshes its context items (Session.setServices) and the
    // activeConversationId the session persists — would target the wrong
    // conversation. It has no bearing on tool approval: that is decided by the
    // rules and the auto-approve flag set below.
    this.session._setSelection({ kind: 'conversation', id: convId });

    // Enable all permissions for headless test execution (no user to click approve)
    // writeFile permission covers write-file and replace-text actions
    this.conversation.rootMessageThread.addRule('write-file', { kind: 'boolean', value: true });
    // Universal wildcard '*' matches any shell command. Conversation-scoped:
    // a session-scoped blanket grant would leak into every other lane's
    // shared session metadata and silently auto-approve their pending tools.
    this.conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: '*', scope: 'conversation' });
    // Auto-approve all actions (needed for claudecode's tool_use_request flow)
    this.conversation.setAutoApprove(true);

    // If a specific strategy was requested in the task definition, set it
    const taskDef = /** @type {TaskDefinition & {strategy?: string}} */ (this.task);
    if (taskDef.strategy && strategyRegistry.has(taskDef.strategy)) {
      this.conversation.rootMessageThread.setStrategy(taskDef.strategy);
      logger.info(`Using task-specified strategy: ${taskDef.strategy}`);
    }

    // If a specific provider/model was requested, set it explicitly
    if (this.provider || this.model) {
      const providers = providersCache.hasReceived()
        ? providersCache.get()
        : await providersCache.waitForFirst();

      // Find the requested provider
      /**
       * @param {{name: string}} p
       * @returns {boolean} Whether the provider matches the requested name
       */
      const providerMatcher = p => p.name === this.provider;
      /** @type {{name: string, modelsWithContext: Array<{id: string}>, available: boolean}|undefined} */
      const requestedProvider = providers.find(providerMatcher);
      if (!requestedProvider) {
        /**
         * @param {{name: string}} p
         * @returns {string} The provider name
         */
        const providerNameGetter = p => p.name;
        throw new Error(`Provider '${this.provider}' not found. Available providers: ${providers.map(providerNameGetter).join(', ')}`);
      }
      if (!requestedProvider.available) {
        throw new Error(`Provider '${this.provider}' is not available (missing API key?)`);
      }

      // Set provider and model
      const modelId = this.model || (requestedProvider.modelsWithContext && requestedProvider.modelsWithContext.length > 0 ? requestedProvider.modelsWithContext[0].id : '');
      this.conversation.setModelConfig({
        provider: requestedProvider.name,
        model: modelId
      });
      logger.info(`Conversation created: ${convId} with REQUESTED provider: ${this.conversation.modelConfig.provider}, model: ${this.conversation.modelConfig.model}`);
    } else {
      // Select a default provider/model (test-only helper)
      await selectDefaultProvider(this.conversation);
      logger.info(`Conversation created: ${convId} with DEFAULT provider: ${this.conversation.modelConfig?.provider}, model: ${this.conversation.modelConfig?.model}`);
    }
  }

  /**
   * Send prompt and wait for completion
   * @returns {Promise<string>} Resolves with 'complete' when conversation finishes
   * @private
   */
  async sendPromptAndWait() {
    // Import wsService before creating Promise
    const wsServiceModule = await import('../../js/services/websocket.js');
    /** @type {any} */
    const wsService = wsServiceModule.default;

    return new Promise((resolve, reject) => {
      /** @type {StateObject} */
      const state = {
        checkInterval: null,
        timeout: null,
        connectionTimeout: null
      };

      // No overall timeout - let the agent run to natural completion
      // The agent has a max iteration limit (15) as a safety valve

      if (!wsService) {
        reject(new Error('WebSocket service not available'));
        return;
      }

      if (!this.session) {
        reject(new Error('Session not initialized'));
        return;
      }

      // Ensure WebSocket is connected to this session
      if (!wsService.isConnected()) {
        logger.debug('Connecting WebSocket to test session');

        // Disconnect existing connection if any
        if (wsService.isConnected()) {
          wsService.disconnect();
        }

        // Set up connection listener BEFORE connecting
        /** @type {ReturnType<typeof setTimeout>|null} */
        let connectionTimeout = null;

        const onOpen = () => {
          wsService.off('open', onOpen);
          wsService.off('error', onError);
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          logger.debug('WebSocket connected successfully');
          this.sendMessageToLLM(wsService, state, resolve, reject);
        };

        const onError = () => {
          wsService.off('open', onOpen);
          wsService.off('error', onError);
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          reject(new Error('WebSocket connection error'));
        };

        wsService.on('open', onOpen);
        wsService.on('error', onError);

        // Start connection
        wsService.connect();

        // Timeout after 5 seconds
        connectionTimeout = setTimeout(() => {
          wsService.off('open', onOpen);
          wsService.off('error', onError);
          if (!wsService.isConnected()) {
            reject(new Error('Failed to connect WebSocket (timeout)'));
          }
        }, 5000);
      } else {
        // Already connected to correct session
        this.sendMessageToLLM(wsService, state, resolve, reject);
      }
    });
  }

  /**
   * Send message to LLM and poll for response
   * @param {any} wsService - WebSocket service
   * @param {StateObject} state - State object with timeout and interval
   * @param {(value: string) => void} resolve - Promise resolve
   * @param {(reason: Error) => void} reject - Promise reject
   * @private
   */
  async sendMessageToLLM(wsService, state, resolve, reject) {
    try {
      if (!this.conversation) {
        reject(new Error('Conversation not initialized'));
        return;
      }

      // Track accumulated response for token counting (no longer used - chunks go directly to worker)
      const accumulatedResponse = '';
      let lastTokenCount = 0;

      // Set up message routing - forward WebSocket messages to conversation
      // Must match the format in app.js _handleServerMessage
      /** @param {any} data */
      const messageHandler = async (data) => {
        if (this.conversation && data.conversationId === this.conversation.id) {
          // Route message based on type (same logic as app.js)
          if (data.type === 'tool_use_request') {
            // Tool execution request from claudecode provider (executes tools via MCP)
            await this.conversation.handleToolUseRequest(data);
          } else if (data.type === 'tool_use_timeout') {
            // Backend timed out waiting for tool approval - dismiss dialog silently
            this.conversation.rootMessageThread.resolveApproval(data.toolUseId, 'cancel');
          } else if (data.type === 'should_continue_request') {
            // Iteration control callback from provider
            await this.conversation.handleShouldContinueRequest(data);
          } else if (data.error) {
            // Error response
            const errorMsg = typeof data.error === 'string' ? data.error : (data.message || 'Unknown error');
            this.conversation.handleError(errorMsg);
          } else if ('blocks' in data || 'inputTokens' in data) {
            // Final response - structured blocks with token counts
            this.conversation.handleResponse(this.conversation.rootMessageThread, {
              inputTokens: data.inputTokens || 0,
              outputTokens: data.outputTokens || 0,
              cachedTokens: data.cachedTokens || 0
            });
          }
        }
      };

      wsService.on('message', messageHandler);

      // Send message using conversation's method
      await this.conversation.sendMessage(this.task.prompt);

      // Poll for conversation completion (check if LLM processing is done)
      let pollCount = 0;
      let lastTransactionCount = 0;
      let transactionStartTime = Date.now();
      const runStartTime = Date.now();
      state.checkInterval = window.setInterval(() => {
        if (!this.conversation) {
          if (state.checkInterval !== null) window.clearInterval(state.checkInterval);
          wsService.off('message', messageHandler);
          reject(new Error('Conversation lost during processing'));
          return;
        }

        pollCount++;

        // Calculate approximate token count (simple word-based approximation)
        // Split on whitespace and count words as proxy for tokens
        const currentTokenCount = accumulatedResponse.length > 0
          ? accumulatedResponse.split(/\s+/).filter(s => s.length > 0).length
          : 0;

        // Count distinct transactions by walking root items (one per LLM round-trip).
        const seenTxns = new Set();
        for (const item of this.conversation.rootMessageThread.items) {
          const id = item.get?.('transactionId');
          if (id) seenTxns.add(id);
        }
        const txCount = seenTxns.size;

        // Log per-transaction timing when a new transaction completes
        if (txCount > lastTransactionCount) {
          const now = Date.now();
          const txDuration = ((now - transactionStartTime) / 1000).toFixed(1);
          const elapsed = ((now - runStartTime) / 1000).toFixed(1);
          const messages = this.conversation.rootMessageThread.getMessages();
          const lastMessage = messages[messages.length - 1];
          const lastType = lastMessage?.type || 'none';
          logger.essential(`[TestExecutor] Transaction ${txCount} complete (${txDuration}s, elapsed ${elapsed}s, lastType: ${lastType})`);
          lastTransactionCount = txCount;
          transactionStartTime = now;
        }

        // Log every 10 polls (1 second) with token count
        if (pollCount % 10 === 0) {
          const messages = this.conversation.rootMessageThread.getMessages();
          const lastMessage = messages[messages.length - 1];
          const lastType = lastMessage?.type || 'none';

          if (currentTokenCount > lastTokenCount) {
            logger.essential(`[TestExecutor] Receiving tokens... ${currentTokenCount} tokens (${accumulatedResponse.length} chars)`);
            lastTokenCount = currentTokenCount;
          } else {
            // Use Yjs metadata for accurate processing state (isProcessing relies on UI observer)
            const processingState = this.conversation.getMetadata('processingState');
            const status = processingState?.status || 'unknown';
            logger.debug(`[TestExecutor] Polling for completion... transactions: ${txCount}, status: ${status}, lastType: ${lastType}`);
          }
        }

        // Check if conversation is done processing
        // Use Yjs metadata directly - isProcessing relies on UI observer setup which doesn't exist in headless mode
        // Check processingState.status === 'idle' which is set by the worker when the strategy loop ends
        const processingState = this.conversation.getMetadata('processingState');
        const isIdle = processingState?.status === 'idle';

        if (txCount > 0 && isIdle) {
          const totalDuration = ((Date.now() - runStartTime) / 1000).toFixed(1);
          logger.info(`[TestExecutor] Conversation complete! ${txCount} transactions in ${totalDuration}s`);
          if (state.checkInterval !== null) window.clearInterval(state.checkInterval);
          wsService.off('message', messageHandler);
          // Return the full conversation messages for scoring
          resolve('complete');
        }
      }, 100);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Score the test results
   * @returns {Promise<ScoreResult>} The scoring result with score and details
   * @private
   */
  async scoreResults() {
    if (!this.fixtureDir) {
      throw new Error('Fixture directory not set');
    }
    if (!this.session) {
      throw new Error('Session not initialized');
    }
    const scorer = new TestScorer(this.task, this.fixtureDir);
    return await scorer.score();
  }

  /**
   * Cleanup test resources
   * Note: Fixture cleanup is handled by the Go test runner (juggler-test)
   * @returns {Promise<void>}
   * @private
   */
  async cleanup() {
    logger.info('Cleaning up...');

    // Disconnect WebSocket to avoid hanging connections
    try {
      const wsServiceModule = await import('../../js/services/websocket.js');
      const wsService = wsServiceModule.default;
      if (wsService && wsService.isConnected()) {
        logger.debug('Disconnecting WebSocket...');
        wsService.disconnect();
      }
    } catch (error) {
      console.warn('Failed to disconnect WebSocket:', error);
    }

    // Fixture cleanup is handled by the Go test runner
  }
}

export default TestExecutor;
