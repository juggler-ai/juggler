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

import TestExecutor from './test-executor.js';
import UnitTestExecutor from './unit-test-executor.js';
import { runTestByName, suiteVerdict } from './integration-test-executor.js';
import logger from './test-logger.js';
import providersCache from '../../js/services/providers-cache.js';
import { apiUrl } from '../../js/utils/api-url.js';

/**
 * Test Orchestrator - Coordinates test execution
 * @class
 */
class TestOrchestrator {
  constructor() {
    /**
     * @type {TestResult[]}
     * @private
     */
    this.results = [];

    /**
     * @type {boolean}
     * @private
     */
    this.running = false;

    /**
     * @type {boolean}
     * @private
     */
    this.shouldStop = false;
  }

  /**
   * Run all tests
   * @returns {Promise<void>}
   */
  async runAllTests() {
    if (this.running) {
      console.warn('[ESSENTIAL] Tests already running');
      return;
    }

    this.running = true;
    this.shouldStop = false;
    this.results = [];

    try {
       
      const urlParams = new URLSearchParams(window.location.search);

      // Single-test mode: Go runner navigates here per-test with ?test=<name>
      // Optional ?repeat=<N> runs the test N times in a row (flake hunting).
      const singleTestName = urlParams.get('test');
      if (singleTestName) {
        const projectPath = urlParams.get('projectPath');
        if (!projectPath) throw new Error('projectPath required for single-test mode');

        const repeat = parseInt(urlParams.get('repeat') || '1', 10);
        const ctx = { fixtureDir: projectPath };
        let totalPassed = 0;
        let totalFailed = 0;
        /** @type {string[]} */
        const allErrors = [];
        for (let i = 0; i < repeat; i++) {
          const { passed, failed, errors } = await runTestByName(singleTestName, ctx);
          totalPassed += passed;
          totalFailed += failed;
          if (failed > 0) {
            if (repeat > 1) {
              errors.forEach(e => allErrors.push(`run ${i + 1}: ${e}`));
            } else {
              allErrors.push(...errors);
            }
          }
          console.warn(`[ESSENTIAL] repeat ${i + 1}/${repeat}: ${failed === 0 ? 'PASS' : 'FAIL'}`);
        }
        const verdict = suiteVerdict(singleTestName, { passed: totalPassed, failed: totalFailed, errors: allErrors });

        const testResult = {
          taskId: 'single-test',
          category: 'integration-tests',
          score: verdict.passed ? 1.0 : 0,
          passed: verdict.passed,
          details: verdict.errors.length > 0 ? verdict.errors.join('\n') : 'OK',
          errors: verdict.errors,
          duration: 0,
          testsPassed: totalPassed,
          testsTotal: totalPassed + totalFailed,
          error: verdict.errors.length > 0 ? verdict.errors[0] : undefined
        };
        this.results.push(testResult);
        return;
      }

      // Full suite mode (used by non-integration test tasks)
      const taskId = urlParams.get('task');
      const modelName = urlParams.get('model');
      const explicitProvider = urlParams.get('provider');

      // Use explicit provider if provided, otherwise search the live provider
      // list for one that has this model in its discovered model set.
      let providerFilter = explicitProvider || null;
      if (!providerFilter && modelName) {
        const providers = await providersCache.waitForFirst();
        for (const p of providers) {
          if (p.modelsWithContext && p.modelsWithContext.some(m => m.id === modelName)) {
            providerFilter = p.name;
            break;
          }
        }
        // Models with a namespace prefix (e.g. "anthropic/claude-...") route
        // through openrouter when no direct provider claimed them above.
        if (!providerFilter && modelName.includes('/')) {
          providerFilter = 'openrouter';
        }
      }

      if (!taskId) {
        throw new Error('No task ID provided in URL parameters');
      }

      const response = await fetch(apiUrl(`/test/task?id=${encodeURIComponent(taskId)}`));
      if (!response.ok) {
        throw new Error(`Failed to load task ${taskId}: ${response.status} ${response.statusText}`);
      }

      const task = await response.json();

      logger.essential(`Loaded task: ${taskId}`);
      this.clearResults();
      this.updateProgress(0, 1, 'Starting test...');
      logger.essential(`[1/1] Running task: ${task.id}`);
      this.updateProgress(0, 1, `Running ${task.id}...`);

      let result = null;
      let lastError = null;

      try {
        const scoringType = task.scoring?.type;
        const needsLLM = scoringType !== 'unit_test' && scoringType !== 'integration_test';
        const executor = needsLLM
          ? new TestExecutor(task, providerFilter, modelName)
          : new UnitTestExecutor(task);
        result = await executor.execute();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[ESSENTIAL] Task ${task.id} failed with error: ${errorMsg}`);
        lastError = error;
        result = null;
      }

      if (result) {
        this.results.push(result);
        this.addResultRow(result);
        const testsInfo = result.testsTotal ? `${result.testsPassed}/${result.testsTotal} tests` : `${(result.score * 100).toFixed(1)}%`;
        logger.essential(`Task ${task.id}: ${result.passed ? 'PASSED' : 'FAILED'} (${testsInfo})`);
      } else {
        const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
        const errorResult = {
          taskId: task.id,
          category: task.category,
          score: 0,
          passed: false,
          details: `Error: ${errorMessage}`,
          duration: 0,
          error: errorMessage
        };
        this.results.push(errorResult);
        this.addResultRow(errorResult);
      }

      this.updateProgress(1, 1, 'Test complete!');
      this.showSummary();

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ESSENTIAL] Failed to run tests: ${errorMsg}`);
      console.error(`[ESSENTIAL] Full error: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`);
      throw error;
    } finally {
      this.running = false;
      this.shouldStop = false;
    }
  }

  /**
   * Stop test execution
   */
  stop() {
    if (this.running) {
      this.shouldStop = true;
      logger.info('Stopping tests...');
    }
  }

  /**
   * Clear results table
   * @private
   */
  clearResults() {
    const tbody = document.getElementById('results-tbody');
    if (tbody) {
      tbody.innerHTML = '';
    }

    const summary = document.getElementById('summary-section');
    if (summary) {
      summary.style.display = 'none';
    }
  }

  /**
   * Add result row to table
   * @param {TestResult} result
   * @private
   */
  addResultRow(result) {
    const tbody = document.getElementById('results-tbody');
    if (!tbody) return;

    const row = document.createElement('tr');

    const statusClass = result.passed ? 'status-passed' : 'status-failed';
    const statusText = result.passed ? '✓ Passed' : '✗ Failed';

    const testsInfo = result.testsTotal ? `${result.testsPassed}/${result.testsTotal}` : '-';
    row.innerHTML = `
            <td>${result.taskId}</td>
            <td>${result.category}</td>
            <td class="${statusClass}">${statusText}</td>
            <td>${testsInfo}</td>
            <td>${result.duration.toFixed(1)}s</td>
            <td>${result.details || '-'}</td>
        `;

    tbody.appendChild(row);
  }

  /**
   * Update progress bar and text
   * @param {number} current
   * @param {number} total
   * @param {string} text
   * @private
   */
  updateProgress(current, total, text) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    if (progressBar) {
      const percentage = total > 0 ? (current / total) * 100 : 0;
      progressBar.style.width = `${percentage}%`;
    }

    if (progressText) {
      progressText.textContent = text;
    }
  }

  /**
   * Show summary section with aggregated results
   * @private
   */
  showSummary() {
    const summary = document.getElementById('summary-section');
    if (!summary) return;

    summary.style.display = 'block';

    // Calculate overall stats
    const totalTasks = this.results.length;
    const passedTasks = this.results.filter(r => r.passed).length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);
    const avgDuration = totalTasks > 0 ? totalDuration / totalTasks : 0;

    // Aggregate individual test counts
    let totalTestsPassed = 0;
    let totalTestsTotal = 0;
    for (const result of this.results) {
      if (result.testsTotal) {
        totalTestsPassed += result.testsPassed || 0;
        totalTestsTotal += result.testsTotal;
      }
    }

    // Update summary stats
    const overallScoreEl = document.getElementById('overall-score');
    const passRateEl = document.getElementById('pass-rate');
    const totalTasksEl = document.getElementById('total-tasks');
    const avgDurationEl = document.getElementById('avg-duration');

    // Show test counts instead of percentages
    if (overallScoreEl) {
      overallScoreEl.textContent = totalTestsTotal > 0
        ? `${totalTestsPassed}/${totalTestsTotal} tests`
        : `${passedTasks}/${totalTasks} tasks`;
    }
    if (passRateEl) passRateEl.textContent = `${passedTasks}/${totalTasks} tasks passed`;
    if (totalTasksEl) totalTasksEl.textContent = `${passedTasks}/${totalTasks}`;
    if (avgDurationEl) avgDurationEl.textContent = `${avgDuration.toFixed(1)}s`;

    // Calculate category test counts
    /** @type {Record<string, {passed: number, total: number, tasks: number}>} */
    const categoryStats = {};

    for (const result of this.results) {
      const stats = categoryStats[result.category] ??= { passed: 0, total: 0, tasks: 0 };
      stats.tasks++;
      if (result.testsTotal) {
        stats.passed += result.testsPassed || 0;
        stats.total += result.testsTotal;
      }
    }

    // Display category breakdown
    const categoryList = document.getElementById('category-list');
    if (categoryList) {
      categoryList.innerHTML = '';

      for (const [category, stats] of Object.entries(categoryStats)) {

        const li = document.createElement('li');
        li.className = 'category-item';
        const testsInfo = stats.total > 0
          ? `${stats.passed}/${stats.total} tests`
          : `${stats.tasks} tasks`;
        li.innerHTML = `
                    <span>${category}</span>
                    <span>${testsInfo}</span>
                `;
        categoryList.appendChild(li);
      }
    }
  }
}

export default TestOrchestrator;
