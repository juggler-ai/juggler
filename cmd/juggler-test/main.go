//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/acp"
	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/deepseek"
	"juggler/cmd/juggler/providers/gemini"
	"juggler/cmd/juggler/providers/moonshot"
	"juggler/cmd/juggler/providers/ollama"
	"juggler/cmd/juggler/providers/openai"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/openaicompat"
	"juggler/cmd/juggler/providers/openrouter"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/streamidle"
	"juggler/cmd/juggler/providers/zai"
	jugglertest "juggler/cmd/juggler/testing"
	"juggler/internal/jlog"
	"juggler/tests/helpers"
)

// registerProviders registers every built-in provider. Mirrors the juggler
// binary's startup; kept in sync explicitly so juggler-test reports the same
// model set the runtime serves.
func registerProviders() {
	acp.Register()
	anthropic.Register()
	claudecode.Register()
	deepseek.Register()
	gemini.Register()
	moonshot.Register()
	ollama.Register()
	openai.Register()
	openaicodex.Register()
	openaicompat.Register()
	openrouter.Register()
	zai.Register()
	streamidle.Register()
}

// TestResult represents a single test result from the browser
type TestResult struct {
	TaskID      string  `json:"taskId"`
	Category    string  `json:"category"`
	Score       float64 `json:"score"`
	Passed      bool    `json:"passed"`
	Skipped     bool    `json:"skipped,omitempty"` // True if test was skipped due to unmet requirements
	Details     string  `json:"details"`
	Duration    float64 `json:"duration"`
	Error       string  `json:"error,omitempty"`
	TestsPassed int     `json:"testsPassed,omitempty"` // Number of individual tests passed (for integration tests)
	TestsTotal  int     `json:"testsTotal,omitempty"`  // Total number of individual tests (for integration tests)
}

// TaskDefinition represents a benchmark task definition
type TaskDefinition struct {
	ID           string         `json:"id"`
	Category     string         `json:"category"`
	Description  string         `json:"description"`
	Fixture      any            `json:"fixture"` // Can be string (file-based) or map (git-based)
	Prompt       string         `json:"prompt"`
	Scoring      map[string]any `json:"scoring"`
	Requirements map[string]any `json:"requirements,omitempty"` // Optional requirements (python_version, etc.)
}

// FixtureInfo holds information about a setup fixture
type FixtureInfo struct {
	Path    string
	IsGit   bool
	TempDir string // For cleanup
	TaskID  string
}

// ANSI color codes for terminal output
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorGray   = "\033[90m"
)

var (
	listFlag        = flag.Bool("list", false, "List all available tests and exit")
	listModelsFlag  = flag.Bool("list-models", false, "List all available models and exit")
	taskFlag        = flag.String("task", "", "Run specific task by ID (e.g., bugfix-001)")
	categoryFlag    = flag.String("category", "", "Run all tasks in a category (e.g., simple-bug-fixes)")
	modelFlag       = flag.String("model", "glm-4.7", "Model to use for tests (default: glm-4.7)")
	providerFlag    = flag.String("provider", "", "Provider to use. Run --list-models to see registered providers. If not specified, inferred from model name.")
	timeoutFlag     = flag.Int("timeout", 120, "Overall timeout in minutes (default: 2 hours)")
	resultsFileFlag = flag.String("results-file", "tests/benchmarks/results/results.json", "Output file for JSON results")
	quietFlag       = flag.Bool("quiet", true, "Quiet mode - only show test progress and results (default: true)")
	verboseFlag     = flag.Bool("verbose", false, "Verbose mode - show all logs (overrides --quiet)")
	failFastFlag    = flag.Bool("fail-fast", false, "Stop after first test failure and show command to re-run it")
	versionFlag     = flag.Bool("version", false, "Print version and exit")
	// Global test base name for fixture directory naming
	globalTestBaseName string
)

func main() {
	flag.Parse()

	// Handle --version flag
	if *versionFlag {
		fmt.Printf("juggler-test %s (commit: %s, built: %s)\n",
			core.Version, core.Commit, core.BuildDate)
		os.Exit(0)
	}

	registerProviders()

	// Generate descriptive base name with timestamp and filters
	timestamp := time.Now().Format("20060102-150405")
	var baseName string

	// Add task/category info to base name if specified
	if *taskFlag != "" {
		baseName = fmt.Sprintf("%s-task-%s", timestamp, *taskFlag)
	} else if *categoryFlag != "" {
		baseName = fmt.Sprintf("%s-cat-%s", timestamp, *categoryFlag)
	} else {
		baseName = fmt.Sprintf("%s-all-tests", timestamp)
	}

	// Store base name globally for fixture creation
	globalTestBaseName = baseName

	// Set up logging to stdout only for now - log file will be created per-test
	log.SetOutput(os.Stdout)

	// Remove timestamp from log output
	log.SetFlags(0)

	// Print banner
	printBanner()

	// Load API keys from credentials file (same as main app)
	// This ensures the test runner uses the same credential source
	credStore, err := core.NewCredentialsStore()
	if err != nil {
		log.Printf("⚠️  Failed to initialize credentials store: %v", err)
		log.Println("Will fall back to environment variables")
	} else {
		// Load credentials and set as environment variables for provider initialization
		creds, err := credStore.Load()
		if err != nil {
			log.Printf("⚠️  Failed to load credentials: %v", err)
		} else {
			// Count how many credentials were loaded
			credCount := 0
			for key, value := range creds {
				if strings.HasPrefix(key, "ext:") {
					continue
				}
				if value != "" {
					credCount++
					// Convert config key name to environment variable name
					// e.g., "anthropic_api_key" -> "ANTHROPIC_API_KEY"
					envVarName := strings.ToUpper(key)
					if os.Getenv(envVarName) == "" {
						// Only set if not already set in environment
						os.Setenv(envVarName, value)
					}
				}
			}
			if credCount > 0 {
				fmt.Printf("✓ Loaded %d API key(s) from ~/.juggler/credentials.json\n", credCount)
			}
		}
	}

	// Get current working directory (where tests/benchmarks lives)
	projectPath, err := os.Getwd()
	if err != nil {
		log.Fatalf("❌ Failed to get current directory: %v", err)
	}

	// Handle --list flag
	if *listFlag {
		if err := listTests(projectPath); err != nil {
			log.Fatalf("❌ Failed to list tests: %v", err)
		}
		return
	}

	// Handle --list-models flag
	if *listModelsFlag {
		listModels()
		return
	}

	// Enable debug logging when verbose mode is on
	if *verboseFlag {
		jlog.SetLevel(jlog.LevelDebug)
		log.Println("🔍 Debug logging enabled")
	}

	// Get juggler root from executable path
	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("❌ Failed to get executable path: %v", err)
	}
	// Executable is at bin/juggler-test, so go up one level to get project root
	jugglerRoot := filepath.Dir(filepath.Dir(exePath))

	// Setup signal handling for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("\n⚠️  Interrupted, shutting down...")
		cancel()
	}()

	// Run tests with per-test servers
	if !*quietFlag || *verboseFlag {
		log.Println("🧪 Running benchmarks...")
	}
	// Always show model/provider being used
	if *providerFlag != "" {
		fmt.Printf("🤖 Using provider: %s, model: %s\n", *providerFlag, *modelFlag)
	} else {
		fmt.Printf("🤖 Using model: %s\n", *modelFlag)
	}
	if *quietFlag && !*verboseFlag {
		log.SetOutput(io.Discard)
	}
	results, err := runBenchmarksWithPerTestServers(ctx, projectPath, jugglerRoot)
	if err != nil {
		log.Fatalf("❌ Benchmark run failed: %v", err)
	}

	// Write results to JSON file
	if err := writeResults(results); err != nil {
		log.Printf("⚠️  Failed to write results file: %v", err)
	} else if !*quietFlag || *verboseFlag {
		log.Printf("💾 Results written to %s\n", *resultsFileFlag)
	}

	// Print summary
	printSummary(results)

	// Determine exit code
	exitCode := 0
	for _, result := range results {
		if !result.Passed {
			exitCode = 1
			break
		}
	}

	os.Exit(exitCode)
}

// startJugglerSubprocess starts bin/juggler --test --port 0 --project <fixture>
// and returns the HTTP address once JUGGLER_ADDR= appears on stdout.
//
// Windows are hidden by default; set JUGGLER_TEST_SHOW_WINDOW=1 to make them
// visible (helpful when watching a benchmark run interactively).
func startJugglerSubprocess(jugglerBinary, fixture string) (*exec.Cmd, string, error) {
	jugglerBinary = filepath.Clean(jugglerBinary)
	if !filepath.IsAbs(jugglerBinary) {
		return nil, "", fmt.Errorf("jugglerBinary must be an absolute path: %q", jugglerBinary)
	}
	args := []string{"--test", "--assets-from-disk", "--port", "0", "--project", fixture}
	if os.Getenv("JUGGLER_TEST_SHOW_WINDOW") == "1" {
		args = append(args, "--window")
	}
	cmd := exec.Command(jugglerBinary, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, "", fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("start: %w", err)
	}

	addrCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if after, ok := strings.CutPrefix(scanner.Text(), "JUGGLER_ADDR="); ok {
				addrCh <- after
			}
		}
	}()

	select {
	case addr := <-addrCh:
		return cmd, "http://" + addr, nil
	case <-time.After(60 * time.Second):
		cmd.Process.Kill() //nolint:errcheck
		cmd.Wait()         //nolint:errcheck
		return nil, "", fmt.Errorf("timeout waiting for JUGGLER_ADDR")
	}
}

// runTaskViaJuggler runs a single benchmark task by starting a Wails subprocess,
// POSTing the task entry to /api/test/run, then polling /api/test/result.
func runTaskViaJuggler(ctx context.Context, jugglerBinary string, task *TaskDefinition, fixture *FixtureInfo, taskTimeout time.Duration) (TestResult, error) {
	cmd, serverURL, err := startJugglerSubprocess(jugglerBinary, fixture.Path)
	if err != nil {
		return TestResult{}, fmt.Errorf("start juggler: %w", err)
	}
	defer helpers.StopSubprocess(cmd)

	if err := helpers.WaitForServer(serverURL, 10*time.Second); err != nil {
		return TestResult{}, fmt.Errorf("server readiness: %w", err)
	}

	entry := map[string]any{
		"name":        task.ID,
		"projectPath": fixture.Path,
		"taskId":      task.ID,
	}
	if *modelFlag != "" {
		entry["model"] = *modelFlag
	}
	if *providerFlag != "" {
		entry["provider"] = *providerFlag
	}

	data, _ := json.Marshal(entry)
	resp, err := http.Post(serverURL+"/api/test/run", "application/json", bytes.NewReader(data))
	if err != nil {
		return TestResult{}, fmt.Errorf("POST /api/test/run: %w", err)
	}
	resp.Body.Close()

	// Poll for result with per-task timeout.
	deadline := time.Now().Add(taskTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return TestResult{}, fmt.Errorf("context cancelled")
		default:
		}
		r, err := http.Get(serverURL + "/api/test/result")
		if err == nil && r.StatusCode == http.StatusOK {
			var result struct {
				Passed  bool     `json:"passed"`
				Details string   `json:"details"`
				Errors  []string `json:"errors"`
			}
			if decErr := json.NewDecoder(r.Body).Decode(&result); decErr == nil {
				r.Body.Close()
				details := result.Details
				if !result.Passed && len(result.Errors) > 0 {
					details = strings.Join(result.Errors, "\n")
				}
				return TestResult{
					TaskID:   task.ID,
					Category: task.Category,
					Score:    map[bool]float64{true: 1.0, false: 0}[result.Passed],
					Passed:   result.Passed,
					Details:  details,
				}, nil
			}
			r.Body.Close()
		} else if r != nil {
			r.Body.Close()
		}
		time.Sleep(500 * time.Millisecond)
	}
	return TestResult{}, fmt.Errorf("timeout waiting for test result after %s", taskTimeout)
}

// runBenchmarksWithPerTestServers runs benchmarks using a Wails subprocess per task.
func runBenchmarksWithPerTestServers(ctx context.Context, projectPath string, jugglerRoot string) ([]TestResult, error) {
	taskDefinitions := make(map[string]*TaskDefinition)
	tasksDir := filepath.Join(projectPath, "tests", "benchmarks", "tasks")

	err := filepath.Walk(tasksDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		task, err := loadTaskDefinition(path)
		if err != nil {
			log.Printf("⚠️  Failed to load task from %s: %v\n", path, err)
			return nil
		}
		taskDefinitions[task.ID] = task
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to load task definitions: %w", err)
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, time.Duration(*timeoutFlag)*time.Minute)
	defer cancel()

	allResults := []TestResult{}
	fixturesDir := filepath.Join(projectPath, "tests", "benchmarks", "fixtures")
	jugglerBinary := filepath.Join(jugglerRoot, "bin", "juggler")

	taskIDs := make([]string, 0, len(taskDefinitions))
	for taskID := range taskDefinitions {
		if *taskFlag != "" && taskID != *taskFlag {
			continue
		}
		task := taskDefinitions[taskID]
		if *categoryFlag != "" && task.Category != *categoryFlag {
			continue
		}
		taskIDs = append(taskIDs, taskID)
	}
	sort.Strings(taskIDs)

	for i, taskID := range taskIDs {
		select {
		case <-timeoutCtx.Done():
			return allResults, fmt.Errorf("test execution timeout or interrupted")
		default:
		}

		task := taskDefinitions[taskID]
		if task == nil {
			continue
		}

		canRun, skipReason := checkRequirements(task)
		if !canRun {
			if !*quietFlag || *verboseFlag {
				log.Printf("[%d/%d] ⊘ Skipping task %s: %s\n", i+1, len(taskIDs), taskID, skipReason)
			}
			allResults = append(allResults, TestResult{
				TaskID:   taskID,
				Category: task.Category,
				Skipped:  true,
				Details:  skipReason,
			})
			continue
		}

		if !*quietFlag || *verboseFlag {
			log.Printf("[%d/%d] Setting up fixture for task: %s\n", i+1, len(taskIDs), taskID)
		}

		fixture, err := setupFixture(timeoutCtx, task, fixturesDir)
		if err != nil {
			log.Printf("❌ Failed to setup fixture for %s: %v\n", taskID, err)
			result := TestResult{
				TaskID:   taskID,
				Category: task.Category,
				Details:  fmt.Sprintf("Fixture setup failed: %v", err),
				Error:    err.Error(),
			}
			allResults = append(allResults, result)
			if *failFastFlag {
				printFailFastMessage(result, task)
				break
			}
			continue
		}

		if !*quietFlag || *verboseFlag {
			log.Printf("[%d/%d] Running task: %s\n", i+1, len(taskIDs), taskID)
		}

		// Per-task timeout: integration-all gets 30 min; benchmark tasks get 10 min.
		taskTimeout := 10 * time.Minute
		if task.Category == "integration-tests" {
			taskTimeout = 30 * time.Minute
		}

		taskStart := time.Now()
		result, err := runTaskViaJuggler(timeoutCtx, jugglerBinary, task, fixture, taskTimeout)
		taskDuration := time.Since(taskStart)
		if err != nil {
			if timeoutCtx.Err() != nil {
				return allResults, fmt.Errorf("test execution interrupted")
			}
			log.Printf("❌ Task execution failed for %s: %v\n", taskID, err)
			result = TestResult{
				TaskID:   taskID,
				Category: task.Category,
				Details:  fmt.Sprintf("Task execution failed: %v", err),
				Error:    err.Error(),
			}
		}
		result.Duration = taskDuration.Seconds()

		allResults = append(allResults, result)
		log.Printf("⏱️  %s: %v\n", taskID, taskDuration)

		if *failFastFlag && !result.Passed && !result.Skipped {
			printFailFastMessage(result, task)
			break
		}
	}

	return allResults, nil
}

// writeResults writes the results to a JSON file
func writeResults(results []TestResult) error {
	// Ensure directory exists
	dir := filepath.Dir(*resultsFileFlag)
	if dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}

	// Marshal results with indentation
	data, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal results: %w", err)
	}

	// Write to file
	if err := os.WriteFile(*resultsFileFlag, data, 0o644); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

// printFailFastMessage prints a detailed failure message when fail-fast is triggered
func printFailFastMessage(result TestResult, task *TaskDefinition) {
	fmt.Println()
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Printf("  %s⚠️  FIRST FAILURE DETECTED (fail-fast mode)%s\n", colorRed, colorReset)
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Printf("Failed task: %s\n", result.TaskID)
	fmt.Printf("Category: %s\n", result.Category)
	if result.TestsTotal > 0 {
		fmt.Printf("Tests: %d/%d passed\n", result.TestsPassed, result.TestsTotal)
	}
	fmt.Printf("Details: %s\n", result.Details)
	fmt.Println()
	fmt.Println("To re-run just this test:")
	fmt.Printf("  make benchmark ARGS=\"--task %s\"\n", result.TaskID)
	fmt.Println()
	fmt.Println("Or to run all tests in this category:")
	fmt.Printf("  make benchmark ARGS=\"--category %s\"\n", result.Category)
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Println()
}

// printSummary prints a summary table of results to the console
func printSummary(results []TestResult) {
	if len(results) == 0 {
		log.Println("⚠️  No results to display")
		return
	}

	// Calculate overall statistics
	totalTasks := len(results)
	passedTasks := 0
	skippedTasks := 0
	totalDuration := 0.0
	// Aggregate individual test counts across all tasks
	totalTestsPassed := 0
	totalTestsTotal := 0

	for _, result := range results {
		if result.Skipped {
			skippedTasks++
		} else {
			if result.Passed {
				passedTasks++
			}
			totalDuration += result.Duration
			// Aggregate individual test counts
			if result.TestsTotal > 0 {
				totalTestsPassed += result.TestsPassed
				totalTestsTotal += result.TestsTotal
			}
		}
	}

	// Calculate stats excluding skipped tests
	runTasks := totalTasks - skippedTasks
	avgDuration := 0.0
	if runTasks > 0 {
		avgDuration = totalDuration / float64(runTasks)
	}

	// Print summary header
	fmt.Println()
	fmt.Println("╔═══════════════════════════════════════════════════════════════╗")
	fmt.Println("║                      BENCHMARK SUMMARY                        ║")
	fmt.Println("╚═══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// Print overall stats
	if totalTestsTotal > 0 {
		// Show aggregate test counts (for integration/unit test suites)
		testsPassed := totalTestsPassed == totalTestsTotal
		fmt.Printf("Tests:          %s%d/%d passed%s\n", passColor(testsPassed), totalTestsPassed, totalTestsTotal, colorReset)
	}
	fmt.Printf("Tasks:          %s%d/%d passed%s", passColor(passedTasks == runTasks), passedTasks, runTasks, colorReset)
	if skippedTasks > 0 {
		fmt.Printf(" (%d skipped)", skippedTasks)
	}
	fmt.Println()
	fmt.Printf("Avg Duration:   %.1fs\n", avgDuration)
	fmt.Println()

	// Print detailed results table
	fmt.Println("Detailed Results:")
	fmt.Println("┌──────────────────────────────────┬──────────────────────────┬────────┬─────────┬──────────┐")
	fmt.Println("│ Task ID                          │ Category                 │ Status │ Tests   │ Duration │")
	fmt.Println("├──────────────────────────────────┼──────────────────────────┼────────┼─────────┼──────────┤")

	for _, result := range results {
		status := "✗ FAIL"
		statusColor := colorRed
		if result.Skipped {
			status = "⊘ SKIP"
			statusColor = colorGray
		} else if result.Passed {
			status = "✓ PASS"
			statusColor = colorGreen
		}

		// Format tests column: show "passed/total" or "-" if no test counts
		testsStr := "-"
		testsColor := colorReset
		if result.TestsTotal > 0 {
			testsStr = fmt.Sprintf("%d/%d", result.TestsPassed, result.TestsTotal)
			if result.TestsPassed == result.TestsTotal {
				testsColor = colorGreen
			} else {
				testsColor = colorYellow
			}
		}

		fmt.Printf("│ %-32s │ %-24s │ %s%-6s%s │ %s%7s%s │ %7.1fs │\n",
			truncate(result.TaskID, 32),
			truncate(result.Category, 24),
			statusColor, status, colorReset,
			testsColor, testsStr, colorReset,
			result.Duration,
		)
	}

	fmt.Println("└──────────────────────────────────┴──────────────────────────┴────────┴─────────┴──────────┘")
	fmt.Println()

	// Print failed tests details (excluding skipped)
	failedTests := []TestResult{}
	skippedTestsList := []TestResult{}
	for _, result := range results {
		if result.Skipped {
			skippedTestsList = append(skippedTestsList, result)
		} else if !result.Passed {
			failedTests = append(failedTests, result)
		}
	}

	if len(skippedTestsList) > 0 {
		fmt.Printf("%sSkipped Tests:%s\n", colorYellow, colorReset)
		for _, result := range skippedTestsList {
			fmt.Printf("  • %s: %s\n", result.TaskID, result.Details)
		}
		fmt.Println()
	}

	if len(failedTests) > 0 {
		fmt.Printf("%sFailed Tests:%s\n", colorRed, colorReset)
		for _, result := range failedTests {
			fmt.Printf("  • %s: %s\n", result.TaskID, result.Details)
			if result.Error != "" {
				fmt.Printf("    Error: %s\n", result.Error)
			}
		}
		fmt.Println()
	}
}

// passColor returns green if passed, red if not
func passColor(passed bool) string {
	if passed {
		return colorGreen
	}
	return colorRed
}

// truncate truncates a string to a maximum length
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

// setupFixture creates a test fixture in a date-stamped results directory
// Returns fixture info with paths to both the fixture working directory and results directory
//
// Directory structure created:
//
//	/tmp/juggler/<timestamp>-task-<id>/     (results directory for logs)
//	  ├── log.txt                            (test execution log)
//	  └── fixture/                           (fixture working directory)
//	      └── ...fixture files...
func setupFixture(ctx context.Context, task *TaskDefinition, fixturesDir string) (*FixtureInfo, error) {
	if task.Fixture == nil {
		return &FixtureInfo{
			Path:    fixturesDir, // Default to fixtures dir if no fixture specified
			IsGit:   false,
			TempDir: "",
			TaskID:  task.ID,
		}, nil
	}

	// Check if it's a git fixture (map with "type": "git")
	if fixtureMap, ok := task.Fixture.(map[string]any); ok {
		if fixtureType, ok := fixtureMap["type"].(string); ok && fixtureType == "git" {
			// Git-based fixture
			config := jugglertest.GitFixtureConfig{}

			if repoURL, ok := fixtureMap["repo_url"].(string); ok {
				config.RepoURL = repoURL
			}
			if baseCommit, ok := fixtureMap["base_commit"].(string); ok {
				config.BaseCommit = baseCommit
			}
			if installCmds, ok := fixtureMap["install_commands"].([]any); ok {
				for _, cmd := range installCmds {
					if cmdStr, ok := cmd.(string); ok {
						config.InstallCommands = append(config.InstallCommands, cmdStr)
					}
				}
			}

			// Clone git repo using fixtures package
			tmpDir, err := jugglertest.SetupGitFixture(ctx, config)
			if err != nil {
				return nil, fmt.Errorf("failed to setup git fixture: %w", err)
			}

			// Create date-stamped results directory (include task ID for uniqueness)
			// Use os.TempDir() for cross-platform temp directory
			resultsDir := filepath.Join(os.TempDir(), "juggler", fmt.Sprintf("%s-task-%s", globalTestBaseName, task.ID))
			if err := os.MkdirAll(resultsDir, 0o755); err != nil {
				return nil, fmt.Errorf("failed to create results dir: %w", err)
			}

			// Move git repo into results directory as "fixture" subdirectory
			fixtureDir := filepath.Join(resultsDir, "fixture")
			if err := os.Rename(tmpDir, fixtureDir); err != nil {
				return nil, fmt.Errorf("failed to move git fixture: %w", err)
			}

			return &FixtureInfo{
				Path:    fixtureDir, // Git repo inside results directory
				IsGit:   true,
				TempDir: resultsDir, // Results directory for logs
				TaskID:  task.ID,
			}, nil
		}
	}

	// File-based fixture - copy from fixtures directory
	fixtureName, ok := task.Fixture.(string)
	if !ok {
		return nil, fmt.Errorf("fixture must be a string or git fixture object")
	}

	// Create date-stamped results directory (include task ID for uniqueness)
	// Use os.TempDir() for cross-platform temp directory
	resultsDir := filepath.Join(os.TempDir(), "juggler", fmt.Sprintf("%s-task-%s", globalTestBaseName, task.ID))
	if err := os.MkdirAll(resultsDir, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create results dir: %w", err)
	}

	// Create fixture subdirectory inside results directory
	fixtureDir := filepath.Join(resultsDir, "fixture")
	if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create fixture dir: %w", err)
	}

	// Copy fixture files into the fixture subdirectory
	fixturePath := filepath.Join(fixturesDir, fixtureName)
	if _, err := os.Stat(fixturePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("fixture not found: %s", fixtureName)
	}

	// Copy fixture contents
	err := filepath.Walk(fixturePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(fixturePath, path)
		if err != nil {
			return err
		}

		dstPath := filepath.Join(fixtureDir, relPath)

		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}

		// Copy file
		return copyFile(path, dstPath)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to copy fixture: %w", err)
	}

	return &FixtureInfo{
		Path:    fixtureDir, // The fixture working directory
		IsGit:   false,
		TempDir: resultsDir, // Results directory for logs
		TaskID:  task.ID,
	}, nil
}

// copyFile copies a single file
func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	return err
}

// checkRequirements checks if system meets task requirements
// Returns (canRun bool, skipReason string)
func checkRequirements(task *TaskDefinition) (bool, string) {
	if task.Requirements == nil {
		return true, "" // No requirements = always run
	}

	// Check Python version requirement
	if pyVersion, ok := task.Requirements["python"].(string); ok {
		// For now, we support "2.7" (skip on Python 3.x) or "<=3.11" (skip on Python 3.12+)
		if pyVersion == "2.7" || pyVersion == "2" {
			return false, "Requires Python 2.7 (not supported)"
		}
		if after, hasMax := strings.CutPrefix(pyVersion, "<="); hasMax {
			maxVersion := after
			if maxVersion == "3.11" {
				pythonBinary := "python3"
				if goruntime.GOOS == "windows" {
					pythonBinary = "python"
				}
				cmd := exec.Command(pythonBinary, "--version")
				output, err := cmd.CombinedOutput()
				if err == nil {
					versionStr := string(output)
					if strings.Contains(versionStr, "3.12") ||
						strings.Contains(versionStr, "3.13") ||
						strings.Contains(versionStr, "3.14") {
						return true, ""
					}
				}
			}
		}
	}

	return true, "" // No blocking requirements found
}

// loadTaskDefinition loads a task definition from file
func loadTaskDefinition(taskPath string) (*TaskDefinition, error) {
	data, err := os.ReadFile(taskPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read task file: %w", err)
	}

	var task TaskDefinition
	if err := json.Unmarshal(data, &task); err != nil {
		return nil, fmt.Errorf("failed to parse task JSON: %w", err)
	}

	return &task, nil
}

// listTests lists all available benchmark tests organized by category
func listTests(projectPath string) error {
	tasksDir := filepath.Join(projectPath, "tests", "benchmarks", "tasks")

	// Group tasks by category
	tasksByCategory := make(map[string][]*TaskDefinition)

	err := filepath.Walk(tasksDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		task, err := loadTaskDefinition(path)
		if err != nil {
			log.Printf("⚠️  Failed to load task from %s: %v\n", path, err)
			return nil
		}
		tasksByCategory[task.Category] = append(tasksByCategory[task.Category], task)
		return nil
	})

	if err != nil {
		return fmt.Errorf("failed to load tasks: %w", err)
	}

	// Sort categories and tasks
	categories := make([]string, 0, len(tasksByCategory))
	for category := range tasksByCategory {
		categories = append(categories, category)
	}
	sort.Strings(categories)

	// Print header
	fmt.Println("\n📋 Available Benchmark Tests")
	fmt.Println(strings.Repeat("=", 80))

	totalTasks := 0
	for _, category := range categories {
		tasks := tasksByCategory[category]
		sort.Slice(tasks, func(i, j int) bool {
			return tasks[i].ID < tasks[j].ID
		})

		fmt.Printf("\n%s%s%s (%d tests)\n", colorBlue, category, colorReset, len(tasks))
		for _, task := range tasks {
			fmt.Printf("  • %s%s%s - %s\n", colorGreen, task.ID, colorReset, task.Description)
		}
		totalTasks += len(tasks)
	}

	fmt.Printf("\n%sTotal: %d tests across %d categories%s\n\n", colorGray, totalTasks, len(categories), colorReset)
	fmt.Println("Usage:")
	fmt.Println("  ./bin/juggler-test                                 # Run all tests")
	fmt.Println("  ./bin/juggler-test --task=bugfix-001              # Run specific test")
	fmt.Println("  ./bin/juggler-test --category=simple-bug-fixes    # Run all tests in a category")
	fmt.Println()

	return nil
}

func printBanner() {
	banner := fmt.Sprintf(`
   ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄    ▄▄▄▄▄▄ ▄▄▄▄▄  ▄▄▄▄ ▄▄▄▄▄▄
   ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄     ██   ██▄▄  ███▄▄   ██
 ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██     ██   ██▄▄▄ ▄▄██▀   ██

 Automated Test Runner • v%s
 `, core.Version)
	fmt.Println(banner)
}

// listModels lists all available models organized by provider, reading
// each provider's static ModelContextWindows from the registry. Providers
// whose models come from a runtime source register without a map and
// are shown with a note.
func listModels() {
	fmt.Println("\n🤖 Available Models")
	fmt.Println(strings.Repeat("=", 80))

	infos := provider.ListProviderInfos()
	sort.Slice(infos, func(i, j int) bool {
		return infos[i].DisplayName < infos[j].DisplayName
	})

	for _, info := range infos {
		fmt.Printf("\n%s%s%s\n", colorBlue, info.DisplayName, colorReset)

		if len(info.ModelContextWindows) == 0 {
			fmt.Printf("  %s(models discovered at runtime)%s\n", colorGray, colorReset)
			continue
		}

		modelNames := make([]string, 0, len(info.ModelContextWindows))
		for name := range info.ModelContextWindows {
			modelNames = append(modelNames, name)
		}
		sort.Strings(modelNames)

		for _, name := range modelNames {
			fmt.Printf("  • %s - %s context\n", name, formatContextWindow(info.ModelContextWindows[name]))
		}
	}

	fmt.Printf("\n%sUsage:%s\n", colorGray, colorReset)
	fmt.Println("  ./bin/juggler-test --model=glm-4.7              # Use Z.AI GLM-4.7 (default)")
	fmt.Println("  ./bin/juggler-test --model=claude-sonnet-4.5    # Use Claude Sonnet 4.5")
	fmt.Println("  ./bin/juggler-test --model=gemini-2.0-flash     # Use Gemini 2.0 Flash")
	fmt.Println("  ./bin/juggler-test --model=gpt-4o               # Use OpenAI GPT-4o")
	fmt.Println("  ./bin/juggler-test --provider=openaicodex --model=gpt-5.6-luna")
	fmt.Println()
}

// formatContextWindow formats a token count as a human-readable string (e.g., "200K", "1M", "2M")
func formatContextWindow(tokens int) string {
	if tokens >= 1000000 {
		if tokens%1000000 == 0 {
			return fmt.Sprintf("%dM", tokens/1000000)
		}
		return fmt.Sprintf("%.1fM", float64(tokens)/1000000)
	}
	return fmt.Sprintf("%dK", tokens/1000)
}
