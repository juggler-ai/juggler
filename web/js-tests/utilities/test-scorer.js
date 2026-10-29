//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import logger from './test-logger.js';
import { apiUrl } from '../../js/utils/api-url.js';

/**
 * @typedef {object} ScoreResult
 * @property {number} score - 0.0 to 1.0
 * @property {string} details - Details about the score
 * @property {number} [testsPassed] - Number of tests passed (for integration/unit tests)
 * @property {number} [testsTotal] - Total number of tests (for integration/unit tests)
 */

/**
 * @typedef {object} TaskScoring
 * @property {string} type - Scoring type (file_contains, test_pass, unit_test, etc.)
 * @property {string} [file_path] - File path for file-based scoring
 * @property {string[]} [contains_strings] - Required strings for file_contains
 * @property {string} [expected_content] - Expected content for file_exact_match
 * @property {string} [test_command] - Command for test_pass or compilation_success
 * @property {number} [timeout] - Timeout in seconds
 * @property {Array<{path: string, contains_strings?: string[], not_contains?: string[]}>} [files] - Files for multi_file_consistency
 * @property {string} [test_module] - Test module for unit_test scoring (relative to /js-tests/unit-tests/) or integration_test scoring (relative to /js-tests/utilities/)
 */

/**
 * @typedef {object} TaskDefinition
 * @property {string} id - Task identifier
 * @property {TaskScoring} scoring - Scoring configuration
 */

/**
 * Test Scorer - Implements scoring logic for different test types
 * Uses real Juggler context item APIs to check results
 * @class
 */
class TestScorer {
  /**
   * @param {TaskDefinition} taskDef - Task definition
   * @param {string} fixtureDir - Path to fixture directory
   */
  constructor(taskDef, fixtureDir) {
    /** @type {TaskDefinition} @private */
    this.task = taskDef;

    /** @type {string} @private */
    this.fixtureDir = fixtureDir;
  }

  /**
   * Score the task based on its scoring type
   * @returns {Promise<ScoreResult>} The scoring result with score and details
   */
  async score() {
    const scoringType = this.task.scoring.type;

    switch (scoringType) {
      case 'file_contains':
        return await this.scoreFileContains();

      case 'file_exact_match':
        return await this.scoreFileExactMatch();

      case 'test_pass':
        return await this.scoreTestPass();

      case 'compilation_success':
        return await this.scoreCompilationSuccess();

      case 'multi_file_consistency':
        return await this.scoreMultiFileConsistency();

      case 'unit_test':
        return await this.scoreUnitTest();

      case 'integration_test':
        return await this.scoreIntegrationTest();

      default:
        return {
          score: 0,
          details: `Unknown scoring type: ${scoringType}`
        };
    }
  }

  /**
   * Score: unit_test
   * Runs a JavaScript test module that exercises plugin lifecycle
   * @returns {Promise<ScoreResult>} The unit test scoring result
   * @private
   */
  async scoreUnitTest() {
    return this.scoreTestModule('unit-tests', 'unit test', 'tests');
  }

  /**
   * Score: integration_test
   * Runs integration tests that exercise the full pipeline with mock LLM responses
   * @returns {Promise<ScoreResult>} The integration test scoring result
   * @private
   */
  async scoreIntegrationTest() {
    return this.scoreTestModule('utilities', 'integration test', 'integration tests');
  }

  /**
   * Imports the task's `scoring.test_module` from `/js-tests/<dir>/` and
   * scores the share of its `runTests` that pass.
   * @param {string} dir - Directory under /js-tests/ the module is named relative to
   * @param {string} label - What the module is, for the log and error details
   * @param {string} unit - What it counts, for the details
   * @returns {Promise<ScoreResult>} The scoring result
   * @private
   */
  async scoreTestModule(dir, label, unit) {
    const testModule = this.task.scoring.test_module;

    if (!testModule) {
      return {
        score: 0,
        details: 'No test_module specified in scoring configuration'
      };
    }

    logger.info(`[TestScorer] Running ${label}: ${testModule}`);

    try {
      // Import the test module dynamically (with versioned prefix for cache busting)
      const prefix = /** @type {any} */ (window).__assetPrefix || '';
      const modulePath = `${prefix}/js-tests/${dir}/${testModule}`;
      const testMod = await import(modulePath);

      if (typeof testMod.runTests !== 'function') {
        return {
          score: 0,
          details: `Test module ${testModule} does not export runTests function`
        };
      }

      // Create test context with session, fixture, and utilities
      const testContext = {
        fixtureDir: this.fixtureDir,
        readFile: (/** @type {string} */ path) => this.readFile(path),
        executeCommand: (/** @type {string} */ cmd, /** @type {number} */ timeout) => this.executeCommand(cmd, timeout || 30)
      };

      // Run the tests
      const result = await testMod.runTests(testContext);

      // Result should be { passed: number, failed: number, errors: string[] }
      const total = result.passed + result.failed;
      const score = total > 0 ? result.passed / total : 0;

      let details;
      if (result.failed === 0) {
        details = `All ${result.passed} ${unit} passed`;
      } else {
        details = `${result.passed}/${total} ${unit} passed. Failures: ${result.errors.join('; ')}`;
        // Log failures for debugging - each error on its own line
        for (const err of result.errors) {
          logger.essential(`FAILURE: ${err}`);
        }
      }

      return { score, details, testsPassed: result.passed, testsTotal: total };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const what = label.charAt(0).toUpperCase() + label.slice(1);
      logger.error(`[TestScorer] ${what} error: ${errorMsg}`);
      return {
        score: 0,
        details: `${what} error: ${errorMsg}`
      };
    }
  }

  /**
   * Score: file_contains
   * Checks if file contains all required strings
   * @returns {Promise<ScoreResult>} The file contains scoring result
   * @private
   */
  async scoreFileContains() {
    const filePath = this.task.scoring.file_path;
    const requiredStrings = this.task.scoring.contains_strings || [];

    if (!filePath) {
      return {
        score: 0,
        details: 'No file path specified in scoring configuration'
      };
    }

    logger.info(`[TestScorer] Scoring file_contains: ${filePath} in fixture: ${this.fixtureDir}`);

    try {
      // Use real context item API to read file
      const content = await this.readFile(filePath);

      logger.debug(`[TestScorer] File content length: ${content.length} First 200 chars: ${content.substring(0, 200)}`);

      let found = 0;
      const missing = [];

      for (const str of requiredStrings) {
        if (content.includes(str)) {
          found++;
        } else {
          missing.push(str);
        }
      }

      const score = requiredStrings.length > 0 ? found / requiredStrings.length : 0;

      const details = score === 1.0
        ? `All ${found} required strings found`
        : `Found ${found}/${requiredStrings.length}. Missing: ${missing.join(', ')}`;

      logger.debug(`[TestScorer] Score: ${score} Details: ${details}`);

      return { score, details };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ESSENTIAL] [TestScorer] Failed to read file: ${errorMsg}`);
      console.error(`[ESSENTIAL] [TestScorer] Full error: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`);
      return {
        score: 0,
        details: `Failed to read file: ${errorMsg}`
      };
    }
  }

  /**
   * Score: file_exact_match
   * Checks if file content exactly matches expected
   * @returns {Promise<ScoreResult>} The file exact match scoring result
   * @private
   */
  async scoreFileExactMatch() {
    const filePath = this.task.scoring.file_path;
    const expectedContent = this.task.scoring.expected_content || '';

    if (!filePath) {
      return {
        score: 0,
        details: 'No file path specified in scoring configuration'
      };
    }

    try {
      const content = await this.readFile(filePath);

      if (content === expectedContent) {
        return {
          score: 1.0,
          details: 'File content matches exactly'
        };
      } else {
        // Calculate similarity for partial credit
        const similarity = this.calculateSimilarity(content, expectedContent);
        return {
          score: 0,
          details: `Content does not match (${(similarity * 100).toFixed(1)}% similar)`
        };
      }

    } catch (error) {
      return {
        score: 0,
        details: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Score: test_pass
   * Runs tests and checks if they pass
   * @returns {Promise<ScoreResult>} The test pass scoring result
   * @private
   */
  async scoreTestPass() {
    const testCommand = this.task.scoring.test_command;
    const timeout = this.task.scoring.timeout || 60;

    if (!testCommand) {
      return {
        score: 0,
        details: 'No test command specified in scoring configuration'
      };
    }

    try {
      // Use context item API to execute command
      const result = await this.executeCommand(testCommand, timeout);

      if (result.exitCode === 0) {
        return {
          score: 1.0,
          details: 'All tests passed'
        };
      } else {
        return {
          score: 0,
          details: `Tests failed: ${result.stderr || result.stdout}`
        };
      }

    } catch (error) {
      return {
        score: 0,
        details: `Failed to run tests: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Score: compilation_success
   * Checks if code compiles successfully
   * @returns {Promise<ScoreResult>} The compilation success scoring result
   * @private
   */
  async scoreCompilationSuccess() {
    const compileCommand = this.task.scoring.test_command;
    const timeout = this.task.scoring.timeout || 60;

    if (!compileCommand) {
      return {
        score: 0,
        details: 'No compile command specified in scoring configuration'
      };
    }

    try {
      const result = await this.executeCommand(compileCommand, timeout);

      if (result.exitCode === 0) {
        return {
          score: 1.0,
          details: 'Compilation successful'
        };
      } else {
        return {
          score: 0,
          details: `Compilation failed: ${result.stderr || result.stdout}`
        };
      }

    } catch (error) {
      return {
        score: 0,
        details: `Failed to compile: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Score: multi_file_consistency
   * Checks multiple files for expected content
   * @returns {Promise<ScoreResult>} The multi-file consistency scoring result
   * @private
   */
  async scoreMultiFileConsistency() {
    const fileChecks = this.task.scoring.files || [];

    let totalChecks = 0;
    let passedChecks = 0;
    const failures = [];

    for (const fileCheck of fileChecks) {
      try {
        const content = await this.readFile(fileCheck.path);

        // Check contains strings
        for (const str of (fileCheck.contains_strings || [])) {
          totalChecks++;
          if (content.includes(str)) {
            passedChecks++;
          } else {
            failures.push(`${fileCheck.path} missing: ${str}`);
          }
        }

        // Check not_contains strings
        for (const str of (fileCheck.not_contains || [])) {
          totalChecks++;
          if (!content.includes(str)) {
            passedChecks++;
          } else {
            failures.push(`${fileCheck.path} should not contain: ${str}`);
          }
        }

      } catch (error) {
        totalChecks++;
        failures.push(`Failed to read ${fileCheck.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const score = totalChecks > 0 ? passedChecks / totalChecks : 0;

    const details = score === 1.0
      ? `All ${totalChecks} file checks passed`
      : `Passed ${passedChecks}/${totalChecks} checks. Failures: ${failures.join('; ')}`;

    return { score, details };
  }

  /**
   * Read file using real context item API
   * @param {string} relativePath
   * @returns {Promise<string>} The file contents
   * @private
   */
  async readFile(relativePath) {
    // Note: Pass relative path only - backend ops.workingDir is already set to fixtureDir
    const response = await fetch(apiUrl('/ops/call'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolId: 'read-file',
        operation: 'loadFile',
        params: { path: relativePath }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.statusText}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to read file');
    }

    // API returns { success: true, data: { content: "...", exists: true, ... } }
    return result.data.content || '';
  }

  /**
   * Execute command using real context item API
   * @param {string} command
   * @param {number} timeout - Timeout in seconds (note: backend has 30s max limit)
   * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>} The command execution result
   * @private
   */
  async executeCommand(command, timeout) {
    // Use shell operations via python context item type (shell_ops.go)
    // Note: Backend currently has a hard-coded 30-second timeout
    const response = await fetch(apiUrl('/ops/call'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolId: 'python',
        operation: 'execute',
        params: {
          command: command,
          cwd: this.fixtureDir,
          timeout: timeout
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to execute command: ${response.statusText}`);
    }

    const result = await response.json();

    // Unwrap the response - backend wraps it in {success: true, data: {...}}
    const data = result.data || result;

    return {
      exitCode: data.exitCode !== undefined ? data.exitCode : 1,
      stdout: data.stdout || '',
      stderr: data.stderr || ''
    };
  }

  /**
   * Calculate similarity between two strings
   * @param {string} a
   * @param {string} b
   * @returns {number} - 0.0 to 1.0
   * @private
   */
  calculateSimilarity(a, b) {
    if (a === b) return 1.0;

    const linesA = a.split('\n');
    const linesB = b.split('\n');

    const maxLen = Math.max(linesA.length, linesB.length);
    if (maxLen === 0) return 1.0;

    let matchingLines = 0;
    for (let i = 0; i < Math.min(linesA.length, linesB.length); i++) {
      if (linesA[i] === linesB[i]) {
        matchingLines++;
      }
    }

    return matchingLines / maxLen;
  }
}

export default TestScorer;
