//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bmatcuk/doublestar/v4"

	provider "juggler/cmd/juggler/providers/registry"
)

// TreeOperations handles directory tree operations
type TreeOperations struct {
	scope PathScope
}

// NewTreeOperations creates a new tree operations handler
func NewTreeOperations(scope PathScope) *TreeOperations {
	return &TreeOperations{
		scope: scope,
	}
}

// Execute executes a tree operation
func (ops *TreeOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "getTree":
		return ops.getTree(params)
	case "expandDirectory":
		return ops.expandDirectory(params)
	case "glob":
		return ops.glob(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// getTree returns the file tree structure with token budget awareness
func (ops *TreeOperations) getTree(params map[string]any) (any, error) {
	path := "."
	if p, ok := params["path"].(string); ok && p != "" {
		path = p
	}

	// SECURITY: Validate path. A user-initiated tree (a folder pinned via
	// @-mention or the file picker) may point outside the project root, just
	// like a user-initiated file read; the escape hatch covers relative
	// (../sibling) and absolute mentions alike. LLM tool calls stay contained.
	userInitiated, _ := params["userInitiated"].(bool)
	absPath, err := ops.scope.ResolveUserInitiated(path, userInitiated)
	if err != nil {
		return nil, err
	}

	// SECURITY: Validate depth parameter (prevent stack overflow)
	depth := 2
	if d, ok := params["depth"]; ok {
		validatedDepth, err := ValidateTreeDepth(d)
		if err != nil {
			return nil, err
		}
		depth = validatedDepth
	}

	// Get maxTokens parameter (default: 2000 as fallback)
	maxTokens := 2000
	if mt, ok := params["maxTokens"].(float64); ok {
		maxTokens = max(int(mt),
			// Minimum reasonable budget
			100)
	} else if params["maxTokens"] != nil {
		return nil, fmt.Errorf("maxTokens must be a number, got %T", params["maxTokens"])
	}

	// Get pattern filter (glob matching)
	pattern := ""
	if p, ok := params["pattern"].(string); ok {
		pattern = p
	} else if params["pattern"] != nil {
		return nil, fmt.Errorf("pattern must be a string, got %T", params["pattern"])
	}

	// Get fileType filter (all, files, dirs)
	fileType := "all"
	if ft, ok := params["fileType"].(string); ok {
		if ft == "files" || ft == "dirs" {
			fileType = ft
		}
	} else if params["fileType"] != nil {
		return nil, fmt.Errorf("fileType must be a string, got %T", params["fileType"])
	}

	// Get showAll parameter (default: false)
	// When true: include hidden files and ignore .gitignore
	showAll := false
	if sa, ok := params["showAll"].(bool); ok {
		showAll = sa
	} else if params["showAll"] != nil {
		return nil, fmt.Errorf("showAll must be a boolean, got %T", params["showAll"])
	}

	// Ensure path exists
	if _, err = os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("path does not exist: %w", err)
	}

	// Load .gitignore patterns (unless showAll is true)
	var gitignorePatterns []string
	if !showAll {
		gitignorePatterns = loadGitignorePatterns(ops.scope.BaseDir())
	}

	// Build tree with token budget awareness
	buildCtx := &buildContext{
		tokensUsed:     0,
		maxTokens:      maxTokens,
		pattern:        pattern,
		fileType:       fileType,
		maxItemsPerDir: 500, // Hard limit to prevent CPU burnout
		maxDepth:       depth,
		showAll:        showAll,
		gitignore:      gitignorePatterns,
		workingDir:     ops.scope.BaseDir(),
	}

	stats := &treeStats{}
	tree, err := buildTreeWithBudget(absPath, 0, buildCtx, stats)
	if err != nil {
		return nil, fmt.Errorf("failed to build tree: %w", err)
	}

	return map[string]any{
		"content":             tree,
		"path":                path,
		"depth":               depth,
		"fileCount":           stats.files,
		"dirCount":            stats.dirs,
		"tokensUsed":          buildCtx.tokensUsed,
		"maxTokens":           maxTokens,
		"pattern":             pattern,
		"fileType":            fileType,
		"truncated":           buildCtx.truncated,
		"hiddenFilesExcluded": stats.hiddenSkipped,
		"hiddenFilesIncluded": showAll,
	}, nil
}

// buildContext holds state during tree building
type buildContext struct {
	tokensUsed     int
	maxTokens      int
	pattern        string
	fileType       string
	maxItemsPerDir int
	maxDepth       int
	truncated      bool
	showAll        bool     // When true, include hidden files and ignore .gitignore
	gitignore      []string // Parsed .gitignore patterns
	workingDir     string   // Root working directory for relative path calculation
}

// treeStats holds statistics about the tree
type treeStats struct {
	files         int
	dirs          int
	hiddenSkipped int // Count of hidden files/dirs that were excluded
}

// treeEntry holds information about a file or directory
type treeEntry struct {
	name      string
	isDir     bool
	size      int64
	itemCount int // for directories: number of items
}

// buildTreeWithBudget recursively builds a tree structure with token budget awareness
func buildTreeWithBudget(root string, depth int, ctx *buildContext, stats *treeStats) (string, error) {
	// Check depth limit
	if depth >= ctx.maxDepth {
		return "", nil
	}

	// Check token budget
	if ctx.tokensUsed >= ctx.maxTokens {
		ctx.truncated = true
		return "", nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}

	// Calculate relative path for gitignore matching
	relPath := ""
	if ctx.workingDir != "" {
		relPath, _ = filepath.Rel(ctx.workingDir, root)
		if relPath == "." {
			relPath = ""
		}
	}

	// Collect and filter entries
	var treeEntries []*treeEntry
	skippedCount := 0
	filteredCount := 0 // Track items filtered by pattern/fileType

	for _, entry := range entries {
		// Skip hidden files and common bloat directories
		shouldSkip, isHidden := shouldSkipEntry(entry.Name(), relPath, ctx)
		if shouldSkip {
			skippedCount++
			if isHidden {
				stats.hiddenSkipped++
			}
			continue
		}

		// Apply pattern filter
		if ctx.pattern != "" && !matchesPattern(entry.Name(), ctx.pattern) {
			filteredCount++
			continue
		}

		// Apply file type filter
		if ctx.fileType == "files" && entry.IsDir() {
			filteredCount++
			continue
		}
		if ctx.fileType == "dirs" && !entry.IsDir() {
			filteredCount++
			continue
		}

		// Get entry info with size
		te, err := getEntryInfo(root, entry, ctx)
		if err != nil {
			// Skip on error but don't fail entire operation
			continue
		}

		treeEntries = append(treeEntries, te)

		// Hard limit to prevent CPU burnout on huge directories
		if len(treeEntries) >= ctx.maxItemsPerDir {
			break
		}
	}

	// Calculate how many items were not processed due to item limit
	// (exclude filtered items - they were intentionally excluded by pattern/fileType)
	matchingEntries := len(entries) - skippedCount - filteredCount
	truncatedCount := matchingEntries - len(treeEntries)

	var builder strings.Builder
	indent := strings.Repeat("-", depth+1) + " " // Dash-per-level format: depth shown by dash count

	// Process each entry
	for i, te := range treeEntries {
		// Build line with metadata
		line := indent + te.name

		if te.isDir {
			// Directory: only show item count if it's collapsed (not being expanded)
			willExpand := depth+1 < ctx.maxDepth && ctx.tokensUsed < ctx.maxTokens
			if !willExpand {
				// Directory is collapsed - show item count with correct plural
				itemWord := "items"
				if te.itemCount == 1 {
					itemWord = "item"
				}
				line += fmt.Sprintf("/\t[%d %s]", te.itemCount, itemWord)
			} else {
				// Directory is expanded - just show slash, no count (it's redundant)
				line += "/"
			}
			stats.dirs++
		} else {
			// File with size (tab-delimited for easier parsing)
			line += fmt.Sprintf("\t[%s]", formatSize(te.size))
			stats.files++
		}

		line += "\n"

		// Check if adding this line would exceed token budget
		lineTokens := provider.EstimateTokens(line)
		if ctx.tokensUsed+lineTokens > ctx.maxTokens {
			// Budget exhausted - add summary and stop
			remaining := len(treeEntries) - i
			if remaining > 0 {
				summary := fmt.Sprintf("%s... and %d more items (token budget exhausted)\n", indent, remaining)
				builder.WriteString(summary)
				ctx.tokensUsed += provider.EstimateTokens(summary)
				ctx.truncated = true
			}
			break
		}

		// Add line to output
		builder.WriteString(line)
		ctx.tokensUsed += lineTokens

		// Recurse into directory if within depth limit
		if te.isDir && depth+1 < ctx.maxDepth && ctx.tokensUsed < ctx.maxTokens {
			subTree, err := buildTreeWithBudget(filepath.Join(root, te.name), depth+1, ctx, stats)
			if err == nil && subTree != "" {
				builder.WriteString(subTree)
			}
		}
	}

	// Add truncation summary if items were skipped
	if truncatedCount > 0 {
		summary := fmt.Sprintf("%s... and %d more items\n", indent, truncatedCount)
		builder.WriteString(summary)
		ctx.tokensUsed += provider.EstimateTokens(summary)
		ctx.truncated = true
	}

	return builder.String(), nil
}

// getEntryInfo collects metadata about a file or directory
func getEntryInfo(root string, entry os.DirEntry, ctx *buildContext) (*treeEntry, error) {
	info, err := entry.Info()
	if err != nil {
		return nil, err
	}

	te := &treeEntry{
		name:  entry.Name(),
		isDir: entry.IsDir(),
		size:  info.Size(),
	}

	// If directory, calculate item count
	if entry.IsDir() {
		te.itemCount = countDirectoryItems(filepath.Join(root, entry.Name()), ctx)
	}

	return te, nil
}

// countDirectoryItems counts the number of items in a directory
func countDirectoryItems(path string, ctx *buildContext) int {
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}

	// Calculate relative path for gitignore matching
	relPath := ""
	if ctx != nil && ctx.workingDir != "" {
		relPath, _ = filepath.Rel(ctx.workingDir, path)
		if relPath == "." {
			relPath = ""
		}
	}

	count := 0
	for _, entry := range entries {
		// Skip hidden files and common bloat
		shouldSkip, _ := shouldSkipEntry(entry.Name(), relPath, ctx)
		if shouldSkip {
			continue
		}
		count++
	}

	return count
}

// matchesPattern checks if a name matches a glob pattern
func matchesPattern(name, pattern string) bool {
	if pattern == "" {
		return true
	}
	matched, err := filepath.Match(pattern, name)
	if err != nil {
		return false
	}
	return matched
}

// formatSize formats bytes in human-readable format
func formatSize(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}

	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}

	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}

	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// shouldSkipEntry determines if a file/directory should be skipped in the tree
// Returns (shouldSkip, isHidden) - isHidden indicates if it was skipped due to being hidden
func shouldSkipEntry(name string, relPath string, ctx *buildContext) (bool, bool) {
	// If showAll is true, only skip truly useless directories
	if ctx.showAll {
		// Even with showAll, skip node_modules as it's massive and never useful
		if name == "node_modules" {
			return true, false
		}
		return false, false
	}

	// Skip hidden files (starting with .)
	if strings.HasPrefix(name, ".") {
		return true, true
	}

	// Skip common directories that bloat the tree
	skipDirs := []string{
		"node_modules",
		"vendor",
		"__pycache__",
		"build",
		"dist",
		"target",
		"bin",
		"obj",
		".next",
		".nuxt",
		"coverage",
	}

	if slices.Contains(skipDirs, name) {
		return true, false
	}

	// Check .gitignore patterns
	if len(ctx.gitignore) > 0 && isGitignored(relPath, name, ctx.gitignore) {
		return true, false
	}

	return false, false
}

// loadGitignorePatterns loads patterns from .gitignore file
func loadGitignorePatterns(workingDir string) []string {
	gitignorePath := filepath.Join(workingDir, ".gitignore")
	file, err := os.Open(gitignorePath)
	if err != nil {
		return nil // No .gitignore or can't read it
	}
	defer file.Close()

	var patterns []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}
	return patterns
}

// isGitignored checks if a path matches any gitignore pattern
func isGitignored(relPath string, name string, patterns []string) bool {
	for _, pattern := range patterns {
		// Handle directory-only patterns (ending with /)
		dirOnly := strings.HasSuffix(pattern, "/")
		if dirOnly {
			pattern = strings.TrimSuffix(pattern, "/")
		}

		// Try matching against just the name (for patterns like "*.log")
		if matched, _ := doublestar.Match(pattern, name); matched {
			return true
		}

		// Try matching against relative path (for patterns like "logs/*.log")
		if relPath != "" {
			fullPath := relPath + "/" + name
			if matched, _ := doublestar.Match(pattern, fullPath); matched {
				return true
			}
			// Also try with ** prefix for deep matching
			if matched, _ := doublestar.Match("**/"+pattern, fullPath); matched {
				return true
			}
		}
	}
	return false
}

// glob returns files matching a glob pattern, sorted by modification time
func (ops *TreeOperations) glob(ctx context.Context, params map[string]any) (any, error) {
	pattern, ok := params["pattern"].(string)
	if !ok || pattern == "" {
		return nil, fmt.Errorf("pattern is required")
	}

	// Get optional path parameter (directory to search in)
	searchPath := "."
	if p, ok := params["path"].(string); ok && p != "" {
		searchPath = p
	}

	// SECURITY: Validate path
	pathResult, err := ops.scope.Resolve(searchPath)
	if err != nil {
		return nil, err
	}

	// Use doublestar for glob matching (supports **)
	// Root the filesystem at the search path so relative patterns work correctly
	matches, err := doublestar.Glob(os.DirFS(pathResult.AbsPath), pattern)
	if err != nil {
		return nil, fmt.Errorf("invalid glob pattern: %w", err)
	}

	// Collect file info for sorting and filtering
	type fileInfo struct {
		path    string
		modTime int64
	}
	var files []fileInfo

	for _, match := range matches {
		// Stop early if the client cancelled the request (Escape).
		if ctx.Err() != nil {
			break
		}
		// Build absolute path for stat
		absMatch := filepath.Join(pathResult.AbsPath, match)

		info, err := os.Stat(absMatch)
		if err != nil {
			continue // Skip files we can't stat
		}

		// Skip directories - only return files
		if info.IsDir() {
			continue
		}

		// Build relative path from working directory
		// If searchPath is ".", match is already relative to workingDir
		// If searchPath is "src", we need "src/" + match
		var relPath string
		if searchPath == "." {
			relPath = match
		} else {
			// filepath.Join uses the OS separator (\ on Windows); tool results
			// are always POSIX-style, so normalise back to forward slashes.
			relPath = filepath.ToSlash(filepath.Join(searchPath, match))
		}

		files = append(files, fileInfo{
			path:    relPath,
			modTime: info.ModTime().Unix(),
		})
	}

	// Sort by modification time (newest first)
	slices.SortFunc(files, func(a, b fileInfo) int {
		return cmp.Compare(b.modTime, a.modTime)
	})

	// Extract just the paths
	var result []string
	for _, f := range files {
		result = append(result, f.path)
	}

	// Limit results to prevent huge responses
	maxResults := 1000
	truncated := false
	if len(result) > maxResults {
		result = result[:maxResults]
		truncated = true
	}

	return map[string]any{
		"files":     result,
		"pattern":   pattern,
		"path":      searchPath,
		"count":     len(result),
		"truncated": truncated,
	}, nil
}

// expandDirectory expands a directory to show its contents
func (ops *TreeOperations) expandDirectory(params map[string]any) (any, error) {
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("missing or invalid 'path' parameter")
	}

	// Resolve and confirm the path stays within the working directory (or an
	// allowed root), using the same containment check as the other
	// read/search/tree ops.
	validation, err := ops.scope.Resolve(path)
	if err != nil {
		return nil, err
	}
	absPath := validation.AbsPath

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	var items []map[string]any
	for _, entry := range entries {
		items = append(items, map[string]any{
			"name":  entry.Name(),
			"isDir": entry.IsDir(),
			// POSIX-style path in results, even on Windows (filepath.Join → \).
			"path": filepath.ToSlash(filepath.Join(path, entry.Name())),
		})
	}

	return map[string]any{
		"items": items,
		"path":  path,
	}, nil
}
