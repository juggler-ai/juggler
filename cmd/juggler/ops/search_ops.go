//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/bmatcuk/doublestar/v4"
)

// SearchOperations handles code search operations
type SearchOperations struct {
	scope PathScope
}

// NewSearchOperations creates a new search operations handler
func NewSearchOperations(scope PathScope) *SearchOperations {
	return &SearchOperations{
		scope: scope,
	}
}

// filepathRelEvalSymlinks computes filepath.Rel after resolving both arguments
// through EvalSymlinks. The plain filepath.Rel treats /var and /private/var
// (macOS) as distinct roots and returns a long ../ path that points outside
// the project; resolving symlinks first puts both sides in the same canonical
// space. Falls back to the literal filepath.Rel result on any EvalSymlinks
// error (e.g. a path that doesn't exist yet).
func filepathRelEvalSymlinks(base, target string) string {
	absBase, errB := filepath.EvalSymlinks(base)
	absTarget, errT := filepath.EvalSymlinks(target)
	if errB != nil || errT != nil {
		rel, _ := filepath.Rel(base, target)
		return rel
	}
	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil {
		return target
	}
	return rel
}

// Execute executes a search operation
func (ops *SearchOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "grep":
		return ops.grep(ctx, params)
	case "findSymbol":
		return ops.findSymbol(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// grep performs a grep search using native Go (no external dependencies)
func (ops *SearchOperations) grep(ctx context.Context, params map[string]any) (any, error) {
	pattern, ok := params["pattern"].(string)
	if !ok {
		return nil, fmt.Errorf("missing or invalid 'pattern' parameter")
	}

	// SECURITY: Validate pattern (prevent ReDoS)
	if err := ValidateSearchPattern(pattern); err != nil {
		return nil, fmt.Errorf("invalid search pattern: %w", err)
	}

	// Handle case sensitivity (support both old and new param names)
	// ignoreCase: true (new, grep -i style) = case insensitive (default)
	// caseSensitive: true (old) = case sensitive
	ignoreCase := true // Default: case insensitive (like grep -i)
	if ic, ok := params["ignoreCase"].(bool); ok {
		ignoreCase = ic
	} else if cs, ok := params["caseSensitive"].(bool); ok {
		// Legacy param: invert logic
		ignoreCase = !cs
	}

	var re *regexp.Regexp
	var err error
	if ignoreCase {
		re, err = regexp.Compile("(?i)" + pattern) // (?i) = case insensitive
	} else {
		re, err = regexp.Compile(pattern)
	}
	if err != nil {
		return nil, fmt.Errorf("invalid regex pattern: %w", err)
	}

	// Resolve the search base. We search the conversation's worktree (execBase)
	// but report matches relative to the REAL project root, so the agent's reads
	// of those paths remap back to the same worktree files. realBaseRel is the
	// real search base relative to the project root (e.g. "" for the whole
	// project, "repoB" for a nested repo), which is prefixed onto each match's
	// path-relative-to-execBase to reconstruct the project-relative report path.
	// Supports glob patterns like "src/**/*.go".
	execBase := ""
	realBaseRel := ""
	globPattern := ""
	pathIsGlob := false
	if path, ok := params["path"].(string); ok && path != "" {
		if containsGlobChars(path) {
			execBase = ops.scope.BaseDir()
			globPattern = path
			pathIsGlob = true
		} else {
			// Validate path in real-project space, then search its worktree.
			realResult, err := ops.scope.ResolveReal(path)
			if err != nil {
				return nil, fmt.Errorf("invalid path: %w", err)
			}
			realBaseRel = relToRoot(ops.scope.Root(), realResult.AbsPath)
			execBase = ops.scope.Remap(realResult.AbsPath)
		}
	} else {
		execBase = ops.scope.BaseDir()
	}

	// Get max results limit (support both old and new param names)
	maxResults := 100
	if mc, ok := params["maxCount"].(float64); ok && mc > 0 {
		maxResults = int(mc)
	} else if mr, ok := params["maxResults"].(float64); ok && mr > 0 {
		maxResults = int(mr)
	}
	if maxResults > 1000 {
		maxResults = 1000 // Hard cap
	}

	// Get file pattern filter (support both old and new param names)
	filePattern := ""
	if fp, ok := params["include"].(string); ok {
		filePattern = fp
	} else if fp, ok := params["filePattern"].(string); ok {
		filePattern = fp
	}

	// Get noIgnore parameter (when true, don't respect .gitignore)
	noIgnore := false
	if ni, ok := params["noIgnore"].(bool); ok {
		noIgnore = ni
	}

	// Load .gitignore patterns from the worktree we actually search.
	var gitignorePatterns []string
	if !noIgnore {
		gitignorePatterns = loadGitignorePatterns(execBase)
	}

	// Perform search
	var matches []map[string]any
	var truncated bool

	if pathIsGlob {
		// Use glob to find matching files, then search in each
		matches, truncated = ops.searchGlobFiles(ctx, execBase, realBaseRel, globPattern, re, maxResults, gitignorePatterns, noIgnore)
	} else {
		matches, truncated = ops.searchFiles(ctx, execBase, realBaseRel, re, maxResults, filePattern, gitignorePatterns, noIgnore)
	}
	fileCount := countUniqueFiles(matches)

	result := map[string]any{
		"pattern":    pattern,
		"matches":    matches,
		"fileCount":  fileCount,
		"matchCount": len(matches),
	}

	if truncated {
		result["truncated"] = true
	}

	return result, nil
}

// containsGlobChars checks if a path contains glob special characters
func containsGlobChars(path string) bool {
	return strings.ContainsAny(path, "*?[")
}

// relToRoot returns abs relative to root as a forward-slashed path, or "" when
// abs IS root (or the relation can't be computed). Used to record where a search
// base sits under the real project root so match paths can be reported
// project-relative.
func relToRoot(root, abs string) string {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// joinReportPath composes a project-relative report path from a base's
// project-relative prefix and a file's path within that base (both
// forward-slashed).
func joinReportPath(prefix, rel string) string {
	switch {
	case prefix == "":
		return rel
	case rel == "" || rel == ".":
		return prefix
	default:
		return prefix + "/" + rel
	}
}

// searchGlobFiles searches files matching a glob pattern. execBase is the
// (worktree-redirected) directory to glob within; realBaseRel is that base's
// path relative to the real project root, prefixed onto reported match paths.
func (ops *SearchOperations) searchGlobFiles(ctx context.Context, execBase, realBaseRel, globPattern string, pattern *regexp.Regexp, maxResults int, gitignorePatterns []string, noIgnore bool) ([]map[string]any, bool) {
	matches := make([]map[string]any, 0, maxResults)
	truncated := false

	// Use doublestar to expand glob pattern
	files, err := doublestar.Glob(os.DirFS(execBase), globPattern)
	if err != nil {
		return matches, false
	}

	for _, relFile := range files {
		// Stop early if the client cancelled the request (Escape).
		if ctx.Err() != nil {
			return matches, truncated
		}
		absPath := filepath.Join(execBase, relFile)

		// Skip directories
		info, err := os.Stat(absPath)
		if err != nil || info.IsDir() {
			continue
		}

		// Skip files matching .gitignore (unless noIgnore)
		if !noIgnore && len(gitignorePatterns) > 0 {
			if isGitignored(filepath.Dir(relFile), filepath.Base(relFile), gitignorePatterns) {
				continue
			}
		}

		// Skip binary files and very large files
		if info.Size() > 10*1024*1024 {
			continue
		}

		// Search within file
		fileMatches := ops.searchInFile(absPath, execBase, realBaseRel, pattern, maxResults-len(matches))
		matches = append(matches, fileMatches...)

		if len(matches) >= maxResults {
			truncated = true
			break
		}
	}

	return matches, truncated
}

// searchFiles performs native Go file search with early termination. execBase is
// the (worktree-redirected) directory to walk; realBaseRel is that base's path
// relative to the real project root, prefixed onto reported match paths.
func (ops *SearchOperations) searchFiles(ctx context.Context, execBase, realBaseRel string, pattern *regexp.Regexp, maxResults int, filePattern string, gitignorePatterns []string, noIgnore bool) ([]map[string]any, bool) {
	matches := make([]map[string]any, 0, maxResults)
	truncated := false

	// Walk directory tree
	err := filepath.WalkDir(execBase, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // Skip errors, continue walking
		}

		// Stop walking if the client cancelled the request (Escape). Returning
		// the ctx error halts WalkDir; the caller ignores it and returns the
		// matches gathered so far (the aborted response is discarded anyway).
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Get relative path (to the search base) for gitignore matching
		relPath, _ := filepath.Rel(execBase, path)

		// Skip directories
		if d.IsDir() {
			name := d.Name()
			// Always skip .git and node_modules
			if name == ".git" || name == "node_modules" || name == ".juggler" {
				return fs.SkipDir
			}
			// Skip hidden directories unless noIgnore
			if !noIgnore && strings.HasPrefix(name, ".") {
				return fs.SkipDir
			}
			// Skip gitignored directories
			if !noIgnore && len(gitignorePatterns) > 0 {
				if isGitignored(filepath.Dir(relPath), name, gitignorePatterns) {
					return fs.SkipDir
				}
			}
			return nil
		}

		// Skip hidden files unless noIgnore
		if !noIgnore && strings.HasPrefix(d.Name(), ".") {
			return nil
		}

		// Skip gitignored files
		if !noIgnore && len(gitignorePatterns) > 0 {
			if isGitignored(filepath.Dir(relPath), d.Name(), gitignorePatterns) {
				return nil
			}
		}

		// Apply file pattern filter if specified
		if filePattern != "" {
			// If pattern contains path separators or ** (directory pattern),
			// match against full relative path
			// Otherwise, match against just the filename (more intuitive)
			var matchTarget string
			if strings.Contains(filePattern, "/") || strings.Contains(filePattern, "**") {
				// Pattern includes path components - match full relative path
				matchTarget = relPath
			} else {
				// Simple pattern like "*.go" - match just filename
				matchTarget = d.Name()
			}

			matched, _ := doublestar.Match(filePattern, matchTarget)
			if !matched {
				return nil
			}
		}

		// Skip binary files and very large files
		info, err := d.Info()
		if err != nil || info.Size() > 10*1024*1024 { // Skip files > 10MB
			return nil
		}

		// Search within file
		fileMatches := ops.searchInFile(path, execBase, realBaseRel, pattern, maxResults-len(matches))
		matches = append(matches, fileMatches...)

		// Early termination when we hit max results
		if len(matches) >= maxResults {
			truncated = true
			return fs.SkipAll // Stop walking
		}

		return nil
	})

	// Ignore SkipAll errors - they're intentional for limiting results
	_ = err

	return matches, truncated
}

// searchInFile searches for pattern within a single file. execBase is the
// directory the file was found under (a worktree when isolation is on);
// realBaseRel is execBase's location relative to the real project root, so the
// reported path is project-relative and the agent's subsequent reads of it
// redirect back to this same worktree file.
func (ops *SearchOperations) searchInFile(filePath, execBase, realBaseRel string, pattern *regexp.Regexp, maxMatches int) []map[string]any {
	matches := make([]map[string]any, 0)

	file, err := os.Open(filePath)
	if err != nil {
		return matches
	}
	defer file.Close()

	// Report the match path relative to the REAL project root: the file's path
	// relative to the (worktree) search base, prefixed with that base's real
	// project-relative location. EvalSymlinks both sides so macOS's /var ↔
	// /private/var symlink doesn't produce a multi-".." rel path. filepath.Rel
	// yields OS separators (\ on Windows); tool results are always POSIX-style,
	// so normalise back to forward slashes.
	relInBase := filepath.ToSlash(filepathRelEvalSymlinks(execBase, filePath))
	relPath := joinReportPath(realBaseRel, relInBase)

	scanner := bufio.NewScanner(file)
	lineNum := 1

	for scanner.Scan() && len(matches) < maxMatches {
		line := scanner.Text()

		// Check if line matches pattern
		if pattern.MatchString(line) {
			matches = append(matches, map[string]any{
				"file":    relPath,
				"line":    strconv.Itoa(lineNum),
				"content": line,
			})
		}

		lineNum++
	}

	return matches
}

// countUniqueFiles counts unique files in search results
func countUniqueFiles(matches []map[string]any) int {
	fileSet := make(map[string]bool)
	for _, match := range matches {
		if file, ok := match["file"].(string); ok {
			fileSet[file] = true
		}
	}
	return len(fileSet)
}

// findSymbol finds a symbol (function, class, etc.) using native Go search
func (ops *SearchOperations) findSymbol(ctx context.Context, params map[string]any) (any, error) {
	symbol, ok := params["symbol"].(string)
	if !ok {
		return nil, fmt.Errorf("missing or invalid 'symbol' parameter")
	}

	// Validate symbol name
	if err := validateSymbolName(symbol); err != nil {
		return nil, fmt.Errorf("invalid symbol name: %w", err)
	}

	// Escape regex special characters in symbol name for literal matching
	escapedSymbol := regexp.QuoteMeta(symbol)

	// Search for symbol definition patterns
	patterns := []string{
		fmt.Sprintf(`func\s+%s`, escapedSymbol),      // Go
		fmt.Sprintf(`def\s+%s`, escapedSymbol),       // Python
		fmt.Sprintf(`function\s+%s`, escapedSymbol),  // JavaScript
		fmt.Sprintf(`class\s+%s`, escapedSymbol),     // Multiple languages
		fmt.Sprintf(`interface\s+%s`, escapedSymbol), // Go, TypeScript
	}

	var allResults []map[string]any
	maxResults := 100

	// Load .gitignore patterns for symbol search from the searched worktree.
	symbolBase := ops.scope.BaseDir()
	gitignorePatterns := loadGitignorePatterns(symbolBase)

	for _, patternStr := range patterns {
		pattern, err := regexp.Compile(patternStr)
		if err != nil {
			continue
		}

		matches, _ := ops.searchFiles(ctx, symbolBase, "", pattern, maxResults-len(allResults), "", gitignorePatterns, false)
		allResults = append(allResults, matches...)

		if len(allResults) >= maxResults {
			break
		}
	}

	return map[string]any{
		"symbol":  symbol,
		"results": allResults,
		"count":   len(allResults),
	}, nil
}

// validateSymbolName validates a symbol name for security
func validateSymbolName(symbol string) error {
	// Check for empty symbol
	if strings.TrimSpace(symbol) == "" {
		return fmt.Errorf("symbol name cannot be empty")
	}

	// Check symbol length
	const maxSymbolLength = 200
	if utf8.RuneCountInString(symbol) > maxSymbolLength {
		return fmt.Errorf("symbol name exceeds maximum length of %d characters", maxSymbolLength)
	}

	// Symbol should only contain alphanumeric characters, underscores, and basic punctuation
	// This prevents injection of regex special characters
	validSymbolPattern := regexp.MustCompile(`^[a-zA-Z0-9_\-\.]+$`)
	if !validSymbolPattern.MatchString(symbol) {
		return fmt.Errorf("symbol name contains invalid characters (only alphanumeric, underscore, hyphen, and dot allowed)")
	}

	return nil
}
