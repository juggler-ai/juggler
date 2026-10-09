//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"juggler/internal/gitignore"
	"juggler/internal/skipdirs"
)

// PathSearcher is the subset of the file index that completion needs. It is an
// interface so this package does not import core (which would be an import
// cycle — core imports ops for FileMatch); core's *PathIndex satisfies it.
type PathSearcher interface {
	Search(query string, limit int) []FileMatch
}

// CompletePath returns filesystem entries whose names match the typed prefix.
// Unlike CompleteFiles, it is NOT restricted to the project directory and
// accepts absolute paths directly (tilde is expanded here).
// query may be an absolute path (starting with "/" or "~"), or a relative path
// (starting with "." or ".."), which is resolved against basePath.
// If basePath is empty the user's home directory is used as the base.
func CompletePath(ctx context.Context, query, basePath string, limit int) ([]FileMatch, error) {
	if limit <= 0 {
		limit = 20
	}

	// Expand leading ~ to home directory.
	if query == "~" || strings.HasPrefix(query, "~/") || strings.HasPrefix(query, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			query = home + query[1:]
		}
	}

	// Resolve relative paths (starting with "." or "..") against basePath.
	if strings.HasPrefix(query, ".") {
		base := basePath
		if base == "" {
			base, _ = os.UserHomeDir()
		}
		// Separate the typed name fragment after the last slash so we can
		// reconstruct the query as an absolute path.
		var relDir, frag string
		if strings.HasSuffix(query, "/") {
			relDir = query
		} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
			relDir = query[:idx+1]
			frag = query[idx+1:]
		} else {
			relDir = query + "/"
		}
		absDir := filepath.Clean(filepath.Join(base, relDir))
		query = absDir + "/" + frag
	}

	// Split into the directory to read and the name prefix to filter by.
	var dirPart, namePrefix string
	if strings.HasSuffix(query, "/") {
		dirPart = strings.TrimSuffix(query, "/")
		if dirPart == "" {
			dirPart = "/"
		}
	} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
		dirPart = query[:idx]
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = query[idx+1:]
	} else {
		// No slash and not a relative path — nothing useful to complete yet.
		return nil, nil
	}

	entries, err := os.ReadDir(dirPart)
	if err != nil {
		return nil, err
	}

	var dirs, files []FileMatch
	lowerPrefix := strings.ToLower(namePrefix)

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if lowerPrefix != "" && !strings.HasPrefix(strings.ToLower(name), lowerPrefix) {
			continue
		}

		var fullPath string
		if dirPart == "/" {
			fullPath = "/" + name
		} else {
			fullPath = filepath.Join(dirPart, name)
		}

		if entry.IsDir() {
			dirs = append(dirs, FileMatch{Path: fullPath + "/", IsDir: true})
		} else {
			files = append(files, FileMatch{Path: fullPath, IsDir: false})
		}

		select {
		case <-ctx.Done():
			return append(dirs, files...), nil
		default:
		}
	}

	results := make([]FileMatch, 0, len(dirs)+len(files))
	results = append(results, dirs...)
	results = append(results, files...)
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// FileMatch is a single file completion result.
// Directories have a trailing "/" in Path.
type FileMatch struct {
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

// ignoredCompletionScanLimit bounds the work spent finding files omitted from
// the persistent index. The fallback only runs for specific filename fragments.
const ignoredCompletionScanLimit = 10_000

// CompleteFiles returns file and directory paths whose names start with the
// name component of query, within the directory component of query.
// Directories are returned first (with trailing "/"), then files, both
// case-insensitively sorted. Results are capped at limit.
//
// For a non-empty unqualified query, results from the whole-tree path index are
// merged with the direct prefix matches. The direct scan covers root entries
// omitted from the index, including gitignored files and directories.
// The call returns early (with nil, nil) if ctx is cancelled.
func CompleteFiles(ctx context.Context, workingDir, query string, limit int, searcher PathSearcher) ([]FileMatch, error) {
	if limit <= 0 {
		limit = 20
	}

	// Split query into directory part and name prefix.
	// "src/ma"  → dirPart="src",  namePrefix="ma"
	// "src/"    → dirPart="src",  namePrefix=""
	// "ma"      → dirPart=".",    namePrefix="ma"
	// ""        → dirPart=".",    namePrefix=""
	var dirPart, namePrefix string
	if strings.HasSuffix(query, "/") {
		dirPart = strings.TrimSuffix(query, "/")
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = ""
	} else if idx := strings.LastIndex(query, "/"); idx >= 0 {
		dirPart = query[:idx]
		if dirPart == "" {
			dirPart = "/"
		}
		namePrefix = query[idx+1:]
	} else {
		dirPart = "."
		namePrefix = query
	}

	// Resolve dirPart to an absolute directory to read.
	// Absolute paths are used as-is; relative paths (including "..") are
	// resolved from workingDir so the user can navigate freely.
	var absDir string
	if filepath.IsAbs(dirPart) {
		absDir = filepath.Clean(dirPart)
	} else {
		absDir = filepath.Clean(filepath.Join(workingDir, dirPart))
	}

	entries, err := os.ReadDir(absDir)
	if err != nil {
		return nil, err
	}

	var dirs, files []FileMatch
	lowerPrefix := strings.ToLower(namePrefix)

	for _, entry := range entries {
		name := entry.Name()

		// Skip hidden entries and excluded dirs
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() && skipdirs.Skip(name) {
			continue
		}

		// Case-insensitive prefix match
		if lowerPrefix != "" && !strings.HasPrefix(strings.ToLower(name), lowerPrefix) {
			continue
		}

		// Build result path using the same dirPart the user typed, so the
		// completion preserves the form they entered (relative or absolute).
		// Always join with "/" — completion queries are forward-slash UI
		// strings, so filepath.Join's OS separator would corrupt them on
		// Windows (src\deep/ instead of src/deep/).
		var relPath string
		switch dirPart {
		case ".":
			relPath = name
		case "/":
			relPath = "/" + name
		default:
			relPath = dirPart + "/" + name
		}

		if entry.IsDir() {
			dirs = append(dirs, FileMatch{Path: relPath + "/", IsDir: true})
		} else {
			files = append(files, FileMatch{Path: relPath, IsDir: false})
		}
	}

	// Dirs first, then files
	results := make([]FileMatch, 0, len(dirs)+len(files))
	results = append(results, dirs...)
	results = append(results, files...)

	if len(results) > limit {
		results = results[:limit]
	}

	// Every non-empty unqualified query uses the whole-tree index. Keep direct
	// prefix matches first because the index intentionally omits ignored paths.
	if searcher != nil && !filepath.IsAbs(dirPart) && namePrefix != "" && !strings.Contains(query, "/") {
		indexed := searcher.Search(namePrefix, limit)
		ignored := []FileMatch(nil)
		if len(namePrefix) >= 4 {
			ignored = searchIgnoredCompletionPaths(ctx, workingDir, namePrefix, limit, ignoredCompletionScanLimit)
		}
		if indexed != nil {
			return mergeFileMatches(limit, results, ignored, indexed), nil
		}
	}

	return results, nil
}

func mergeFileMatches(limit int, groups ...[]FileMatch) []FileMatch {
	merged := make([]FileMatch, 0, limit)
	seen := make(map[string]struct{}, limit)
	for _, group := range groups {
		for _, match := range group {
			if len(merged) >= limit {
				return merged
			}
			if _, exists := seen[match.Path]; exists {
				continue
			}
			seen[match.Path] = struct{}{}
			merged = append(merged, match)
		}
	}
	return merged
}

// searchIgnoredCompletionPaths performs a bounded breadth-first scan of ignored
// entries directly under the project root. It never descends into the indexed
// tree, and each directory read is capped by the remaining entry budget.
func searchIgnoredCompletionPaths(ctx context.Context, workingDir, query string, limit, scanLimit int) []FileMatch {
	matcher := gitignore.NewMatcher(workingDir)
	type queued struct{ abs, rel string }
	queue := []queued{{abs: workingDir}}
	matches := make([]FileMatch, 0, limit)
	lowerQuery := strings.ToLower(query)
	visited := 0

	for len(queue) > 0 && visited < scanLimit {
		select {
		case <-ctx.Done():
			return matches
		default:
		}
		cur := queue[0]
		queue = queue[1:]
		entries := readCompletionEntries(cur.abs, scanLimit-visited)
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") || entry.IsDir() && skipdirs.Skip(name) {
				continue
			}
			visited++
			rel := name
			if cur.rel != "" {
				rel = cur.rel + "/" + name
			}
			ignored := cur.rel != "" || matcher.Ignored(rel, entry.IsDir())
			if !ignored {
				continue
			}
			if strings.Contains(strings.ToLower(name), lowerQuery) {
				path := rel
				if entry.IsDir() {
					path += "/"
				}
				matches = append(matches, FileMatch{Path: path, IsDir: entry.IsDir()})
			}
			if entry.IsDir() {
				queue = append(queue, queued{abs: filepath.Join(cur.abs, name), rel: rel})
			}
		}
	}

	sort.Slice(matches, func(i, j int) bool {
		a, b := strings.ToLower(matches[i].Path), strings.ToLower(matches[j].Path)
		return a < b
	})
	if len(matches) > limit {
		matches = matches[:limit]
	}
	return matches
}

// treeSearchScanLimit bounds the entries one TreeSearcher query visits. A
// workspace has no persistent index, so each keystroke walks; the bound keeps
// that a few milliseconds on an ordinary tree, and the walk's breadth-first
// order means the cap trims the deepest paths, not a whole subtree.
const treeSearchScanLimit = 20_000

// TreeSearcher answers whole-tree "@" completion for a tree that has no path
// index — a workspace — by walking it per query, under the same rules the
// project's index is built by: dot-entries, skipped directories and gitignored
// paths are left out, and a match is a case-insensitive substring of the
// basename. Results are ranked as the index ranks them (earlier match in the
// name, then shallower, then shorter, then alphabetical), so a menu reads the
// same in a workspace as it does in the project.
type TreeSearcher struct {
	ctx  context.Context
	root string
}

// NewTreeSearcher returns a searcher over root that stops walking when ctx ends.
func NewTreeSearcher(ctx context.Context, root string) TreeSearcher {
	return TreeSearcher{ctx: ctx, root: root}
}

// Search returns up to limit root-relative, forward-slashed matches for query.
func (s TreeSearcher) Search(query string, limit int) []FileMatch {
	if limit <= 0 {
		limit = 20
	}
	q := strings.ToLower(query)
	if q == "" {
		return nil
	}

	type ranked struct {
		FileMatch
		offset, depth int
	}
	matcher := gitignore.NewMatcher(s.root)
	type queued struct {
		abs, rel string
		depth    int
	}
	queue := []queued{{abs: s.root}}
	var matches []ranked
	visited := 0

	for len(queue) > 0 && visited < treeSearchScanLimit {
		if s.ctx.Err() != nil {
			break
		}
		cur := queue[0]
		queue = queue[1:]
		for _, entry := range readCompletionEntries(cur.abs, treeSearchScanLimit-visited) {
			name := entry.Name()
			isDir := entry.IsDir()
			if strings.HasPrefix(name, ".") || isDir && skipdirs.Skip(name) {
				continue
			}
			visited++
			rel := name
			if cur.rel != "" {
				rel = cur.rel + "/" + name
			}
			if matcher.Ignored(rel, isDir) {
				continue
			}
			if off := strings.Index(strings.ToLower(name), q); off >= 0 {
				p := rel
				if isDir {
					p += "/"
				}
				matches = append(matches, ranked{FileMatch{Path: p, IsDir: isDir}, off, cur.depth})
			}
			if isDir {
				queue = append(queue, queued{abs: filepath.Join(cur.abs, name), rel: rel, depth: cur.depth + 1})
			}
		}
	}

	sort.Slice(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.offset != b.offset {
			return a.offset < b.offset
		}
		if a.depth != b.depth {
			return a.depth < b.depth
		}
		if len(a.Path) != len(b.Path) {
			return len(a.Path) < len(b.Path)
		}
		return strings.ToLower(a.Path) < strings.ToLower(b.Path)
	})
	out := make([]FileMatch, 0, min(limit, len(matches)))
	for _, m := range matches {
		if len(out) >= limit {
			break
		}
		out = append(out, m.FileMatch)
	}
	return out
}

func readCompletionEntries(dir string, limit int) []os.DirEntry {
	if limit <= 0 {
		return nil
	}
	f, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer f.Close()
	entries, _ := f.ReadDir(limit)
	return entries
}
