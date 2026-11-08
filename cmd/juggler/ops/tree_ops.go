//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bmatcuk/doublestar/v4"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/gitignore"
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
	case "copy":
		return ops.copyTree(ctx, params)
	case "compare":
		return ops.compareTrees(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// getTreeParams are getTree's params. Depth's range is MaxTreeDepth's
// (TestGetTreeDepthRangeIsMaxTreeDepth), the guard against stack overflow.
type getTreeParams struct {
	Path          string   `param:"path"`
	UserInitiated bool     `param:"userInitiated"`
	Depth         *int     `param:"depth,min=1,max=50"`
	MaxTokens     *float64 `param:"maxTokens,strict"`
	Pattern       string   `param:"pattern,strict"`
	FileType      string   `param:"fileType,strict"`
	ShowAll       bool     `param:"showAll,strict"`
	NoIgnore      bool     `param:"noIgnore,strict"`
}

// getTree returns the file tree structure with token budget awareness
func (ops *TreeOperations) getTree(params map[string]any) (any, error) {
	p, err := decodeParams[getTreeParams](params)
	if err != nil {
		return nil, err
	}
	path := "."
	if p.Path != "" {
		path = p.Path
	}

	// SECURITY: Validate path. A user-initiated tree (a folder pinned via
	// @-mention or the file picker) may point outside the project root, just
	// like a user-initiated file read; the escape hatch covers relative
	// (../sibling) and absolute mentions alike. LLM tool calls stay contained.
	absPath, err := ops.scope.ResolveUserInitiated(path, p.UserInitiated)
	if err != nil {
		return nil, err
	}

	depth := 2
	if p.Depth != nil {
		depth = *p.Depth
	}

	// maxTokens defaults to 2000, and is never under a reasonable minimum of 100.
	maxTokens := 2000
	if p.MaxTokens != nil {
		maxTokens = max(int(*p.MaxTokens), 100)
	}

	// Get pattern filter (glob matching)
	pattern := p.Pattern

	// Get fileType filter (all, files, dirs)
	fileType := "all"
	if p.FileType == "files" || p.FileType == "dirs" {
		fileType = p.FileType
	}

	// Get showAll parameter (default: false)
	// When true: include hidden files and ignore .gitignore
	showAll := p.ShowAll

	// Get noIgnore parameter (default: false). Unlike showAll it only releases
	// .gitignore filtering; hidden files stay hidden. showAll implies it.
	noIgnore := showAll || p.NoIgnore

	// Ensure path exists
	if _, err = os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("path does not exist: %w", err)
	}

	// Build a gitignore matcher unless opted out (nil = filtering off), rooted
	// at the project root; relative paths are computed against it. A directory
	// that is itself ignored, or outside the project, is rooted at instead:
	// naming it is asking to see it, and under the project's rules everything
	// inside an ignored directory is ignored, so the listing would be empty.
	matchRoot := ops.scope.Root()
	if rel, relErr := filepath.Rel(matchRoot, absPath); relErr != nil || rel == ".." ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) ||
		gitignore.NewMatcher(matchRoot).Ignored(filepath.ToSlash(rel), true) {
		matchRoot = absPath
	}
	var ign *gitignore.Matcher
	if !noIgnore {
		ign = gitignore.NewMatcher(matchRoot)
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
		ign:            ign,
		workingDir:     matchRoot,
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
	showAll        bool               // When true, include hidden files and ignore .gitignore
	ign            *gitignore.Matcher // gitignore matcher (nil = filtering off)
	workingDir     string             // The matcher's root: paths given to ign are relative to it
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
		shouldSkip, isHidden := shouldSkipEntry(entry.Name(), relPath, entry.IsDir(), ctx)
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
		shouldSkip, _ := shouldSkipEntry(entry.Name(), relPath, entry.IsDir(), ctx)
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
func shouldSkipEntry(name string, relPath string, isDir bool, ctx *buildContext) (bool, bool) {
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

	// Check .gitignore patterns (relPath is slash-separated relative to the
	// project root; the matcher is nil when filtering is off).
	childRel := name
	if relPath != "" {
		childRel = filepath.ToSlash(filepath.Join(relPath, name))
	}
	if ctx.ign.Ignored(childRel, isDir) {
		return true, false
	}

	return false, false
}

// glob returns files matching a glob pattern, sorted by modification time
// globParams are glob's params.
type globParams struct {
	Pattern           string `param:"pattern"`
	Path              string `param:"path"`
	UserInitiated     bool   `param:"userInitiated"`
	OutOfRootApproved bool   `param:"outOfRootApproved"`
	NoIgnore          bool   `param:"noIgnore"`
}

func (ops *TreeOperations) glob(ctx context.Context, params map[string]any) (any, error) {
	p, err := decodeParams[globParams](params)
	if err != nil {
		return nil, err
	}
	pattern := p.Pattern
	if pattern == "" {
		return nil, fmt.Errorf("pattern is required")
	}

	// Get optional path parameter (directory to search in)
	searchPath := "."
	if p.Path != "" {
		searchPath = p.Path
	}

	// SECURITY: Validate path. ResolveRead honours a user-initiated pin and the
	// JS out-of-root approval (the glob `pattern` is expanded within this
	// resolved dir and cannot escape it), so an approved out-of-project glob
	// resolves instead of being rejected.
	absPath, err := ops.scope.ResolveRead(searchPath, p.UserInitiated, p.OutOfRootApproved)
	if err != nil {
		return nil, err
	}

	// Build a gitignore matcher unless opted out (nil = filtering off), rooted
	// at the resolved search directory.
	var ign *gitignore.Matcher
	if !p.NoIgnore {
		ign = gitignore.NewMatcher(absPath)
	}

	// Collect file info for sorting and filtering
	type fileInfo struct {
		path    string
		modTime int64
	}
	var files []fileInfo

	// Walk the tree, pruning gitignored directories so large ignored subtrees
	// (node_modules, build output) are never descended into. This matches
	// doublestar.Glob's rel-path match semantics but avoids traversing pruned
	// dirs. An invalid pattern surfaces on the first Match call below.
	if _, perr := doublestar.Match(pattern, ""); perr != nil {
		return nil, fmt.Errorf("invalid glob pattern: %w", perr)
	}
	fsys := os.DirFS(absPath)
	_ = fs.WalkDir(fsys, ".", func(rel string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries, keep walking
		}
		// Stop early if the client cancelled the request (Escape).
		if ctx.Err() != nil {
			return fs.SkipAll
		}
		if rel == "." {
			return nil
		}

		if d.IsDir() {
			if ign.Ignored(rel, true) {
				return fs.SkipDir
			}
			return nil
		}

		// Skip gitignored files.
		if ign.Ignored(rel, false) {
			return nil
		}

		if ok, _ := doublestar.Match(pattern, rel); !ok {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return nil // skip files we can't stat
		}

		// Build relative path from the working directory. If searchPath is ".",
		// rel is already relative to workingDir; otherwise prefix searchPath.
		relPath := rel
		if searchPath != "." {
			// filepath.Join uses the OS separator (\ on Windows); tool results
			// are always POSIX-style, so normalise back to forward slashes.
			relPath = filepath.ToSlash(filepath.Join(searchPath, rel))
		}

		files = append(files, fileInfo{
			path:    relPath,
			modTime: info.ModTime().Unix(),
		})
		return nil
	})

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

// expandDirectoryParams are expandDirectory's params. Path is a pointer
// because an empty one is a path (the working directory) and only a missing
// one is an error. Detail asks for what a file browser shows beside each name
// (see entryDetail); it costs an lstat per entry and a read of each
// subdirectory, so the callers that only want names don't ask. UserInitiated
// is a folder the user named themselves — a pin they made — which may be
// outside the project, as getTree's and glob's may.
type expandDirectoryParams struct {
	Path          *string `param:"path"`
	Detail        bool    `param:"detail,strict"`
	UserInitiated bool    `param:"userInitiated,strict"`
}

// maxDirEntriesCounted caps how far a subdirectory is read to count what is in
// it: a browser row says "1000+ items" as usefully as an exact count, and a
// node_modules is not worth reading to the end to say so.
const maxDirEntriesCounted = 1000

func (ops *TreeOperations) expandDirectory(params map[string]any) (any, error) {
	p, err := decodeParams[expandDirectoryParams](params)
	if err != nil {
		return nil, err
	}
	if p.Path == nil {
		return nil, fmt.Errorf("missing or invalid 'path' parameter")
	}
	path := *p.Path

	// Resolve and confirm the path stays within the working directory (or an
	// allowed root), using the same containment check as the other
	// read/search/tree ops, unless the user named it themselves.
	absPath, err := ops.scope.ResolveRead(path, p.UserInitiated, false)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	// Ignored entries are listed, never dropped (TestExpandDirectoryUnfiltered):
	// with detail they are marked, and hiding them is the browser's choice.
	var ign *gitignore.Matcher
	var relDir string
	if p.Detail {
		if root, rel, ok := relativeToRoot(ops.scope.Root(), absPath); ok {
			ign = gitignore.NewMatcher(root)
			relDir = rel
		}
	}

	var items []map[string]any
	for _, entry := range entries {
		item := map[string]any{
			"name":  entry.Name(),
			"isDir": entry.IsDir(),
			// POSIX-style path in results, even on Windows (filepath.Join → \).
			"path": filepath.ToSlash(filepath.Join(path, entry.Name())),
		}
		if p.Detail {
			entryDetail(item, absPath, entry)
			if ign != nil {
				rel := entry.Name()
				if relDir != "." {
					rel = relDir + "/" + rel
				}
				item["ignored"] = ign.Ignored(rel, entry.IsDir() || item["linkDir"] == true)
			}
		}
		items = append(items, item)
	}

	return map[string]any{
		"items": items,
		"path":  path,
	}, nil
}

// relativeToRoot says where abs is under root, as a slash path ("." for root
// itself), and which spelling of root that was found under. A resolved path
// has had its symlinks followed and root may not have — macOS's /var is
// /private/var — so root is tried as written and then resolved.
func relativeToRoot(root, abs string) (string, string, bool) {
	candidates := []string{root}
	if resolved, err := filepath.EvalSymlinks(root); err == nil && resolved != root {
		candidates = append(candidates, resolved)
	}
	for _, r := range candidates {
		rel, err := filepath.Rel(r, abs)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return r, filepath.ToSlash(rel), true
		}
	}
	return "", "", false
}

// entryDetail adds to item what a file browser shows beside an entry's name:
//
//   - kind: "file", "dir", "symlink" or "other" (a device, socket or pipe)
//   - size (bytes, files only) and modified (Unix ms), of the entry itself: a
//     symlink is described as a link, by lstat, never as what it points at
//   - mode ("rwxr-xr-x"), executable (any execute bit, files only), hidden (a
//     dot-file)
//   - target, for a symlink: where it points, as written. linkDir when that is a
//     directory, so the browser can open it like one
//   - entries, for a directory: how many entries it holds, counted no further
//     than maxDirEntriesCounted, with entriesTruncated set when it holds more
//
// An entry that vanishes or can't be read between the listing and the lstat
// keeps its name and gets only the fields that could be found.
func entryDetail(item map[string]any, dir string, entry os.DirEntry) {
	name := entry.Name()
	full := filepath.Join(dir, name)
	item["hidden"] = strings.HasPrefix(name, ".")

	info, err := entry.Info()
	if err != nil {
		item["kind"] = "other"
		return
	}
	mode := info.Mode()
	item["modified"] = info.ModTime().UnixMilli()
	item["mode"] = mode.Perm().String()[1:]

	switch {
	case mode&fs.ModeSymlink != 0:
		item["kind"] = "symlink"
		if target, err := os.Readlink(full); err == nil {
			item["target"] = filepath.ToSlash(target)
		}
		if st, err := os.Stat(full); err == nil && st.IsDir() {
			item["linkDir"] = true
		}
	case mode.IsDir():
		item["kind"] = "dir"
		if n, more, err := countEntries(full, maxDirEntriesCounted); err == nil {
			item["entries"] = n
			if more {
				item["entriesTruncated"] = true
			}
		}
	case mode.IsRegular():
		item["kind"] = "file"
		item["size"] = info.Size()
		item["executable"] = mode.Perm()&0o111 != 0
	default:
		item["kind"] = "other"
	}
}

// countEntries counts a directory's entries, reading no more than limit+1 names,
// and says whether there were more than limit.
func countEntries(dir string, limit int) (int, bool, error) {
	f, err := os.Open(dir)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = f.Close() }()
	names, err := f.Readdirnames(limit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, false, err
	}
	if len(names) > limit {
		return limit, true, nil
	}
	return len(names), false, nil
}
