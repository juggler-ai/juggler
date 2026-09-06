//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitignore implements git-compatible .gitignore matching for the file
// operations that walk the project tree (grep, glob, getTree, findSymbol) and
// the file watcher's path index. It lives in internal/ (like skipdirs) so both
// the ops package and core can import it without an import cycle.
//
// A Matcher is rooted at an absolute directory and answers whether a
// slash-separated path relative to that root is ignored. Ignore files load
// lazily as queries touch their directories; parsed rules are cached
// process-wide and revalidated by a single os.Stat per file.
//
// Documented deviations from git: the git index is never consulted (a tracked
// file matching a pattern is still reported as ignored), the global
// core.excludesFile is not read, and matching is case-sensitive (git's
// default). Rules above the Matcher root are never read.
package gitignore

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bmatcuk/doublestar/v4"
)

// rule is a single compiled .gitignore pattern.
type rule struct {
	negate   bool
	dirOnly  bool
	anchored bool
	// pattern is preprocessed for doublestar.Match. For anchored rules it is
	// matched against the path relative to the containing directory; for
	// unanchored rules it is matched against the entry's base name.
	pattern string
}

// dirRules holds the compiled rules that apply within a single directory,
// plus whether that directory begins a fresh ignore context (contains .git).
type dirRules struct {
	rules    []rule // .git/info/exclude first (repo roots only), then .gitignore
	repoRoot bool   // this dir contains .git → its contents form a fresh context
}

// Matcher answers gitignore queries for paths under a single root. It is NOT
// safe for concurrent use: construct one per request or per walk.
type Matcher struct {
	root string
	dirs map[string]*dirRules // rel dir ("" = root) → loaded rules
}

// NewMatcher creates a matcher rooted at rootAbs. Construction scans nothing;
// .gitignore files load lazily as queries touch their directories.
func NewMatcher(rootAbs string) *Matcher {
	return &Matcher{
		root: filepath.Clean(rootAbs),
		dirs: make(map[string]*dirRules),
	}
}

// Ignored reports whether relPath (slash-separated, relative to the root) is
// gitignored. isDir enables dir-only (trailing-slash) patterns and lets walks
// prune whole subtrees. A nil *Matcher returns false (filtering off) so callers
// can thread a single pointer instead of a pointer plus a bool.
func (m *Matcher) Ignored(relPath string, isDir bool) bool {
	if m == nil {
		return false
	}

	rel := strings.Trim(filepath.ToSlash(relPath), "/")
	if rel == "" || rel == "." {
		return false // the root itself is never ignored
	}

	components := strings.Split(rel, "/")

	// .git and .juggler are always ignored, at any depth.
	for _, c := range components {
		if c == ".git" || c == ".juggler" {
			return true
		}
	}

	// Walk the ancestor chain root→leaf. If any ancestor directory is ignored,
	// the path is ignored (git's excluded-parent rule: a negation cannot
	// resurrect a file inside an excluded directory). The leaf is evaluated
	// with the caller's isDir.
	last := len(components) - 1
	for i := 0; i < len(components); i++ {
		sub := strings.Join(components[:i+1], "/")
		subIsDir := i < last || isDir
		if m.matchEntry(components, i, sub, subIsDir) {
			return true
		}
	}
	return false
}

// matchEntry reports whether the single entry `sub` (whose path components are
// components[:idx+1]) is directly ignored by the rules that apply to it.
func (m *Matcher) matchEntry(components []string, idx int, sub string, subIsDir bool) bool {
	baseName := components[idx]

	// The directories whose ignore files can affect `sub` are its ancestor
	// directories: "" (root), components[0], components[0]/components[1], … up
	// to and including the parent of `sub` (join(components[:idx])).
	//
	// Nested-repo boundary: only rules at or below the deepest ancestor
	// directory that contains .git apply to `sub`'s context. Root ("") is the
	// default boundary, so rules above the Matcher root are never consulted.
	// The parent (k == idx) counts: an entry directly inside a nested repo is
	// governed by that repo's ignore files, not the outer tree's.
	boundary := 0
	for k := 0; k <= idx; k++ {
		d := strings.Join(components[:k], "/")
		if m.loadDirRules(d).repoRoot {
			boundary = k
		}
	}

	ignored := false
	for k := boundary; k <= idx; k++ {
		d := strings.Join(components[:k], "/")
		dr := m.loadDirRules(d)
		if len(dr.rules) == 0 {
			continue
		}
		// Path of `sub` relative to directory d (used for anchored matches).
		relToD := strings.Join(components[k:idx+1], "/")
		for _, r := range dr.rules {
			if r.dirOnly && !subIsDir {
				continue
			}
			var matched bool
			if r.anchored {
				matched, _ = doublestar.Match(r.pattern, relToD)
			} else {
				matched, _ = doublestar.Match(r.pattern, baseName)
			}
			if matched {
				ignored = !r.negate
			}
		}
	}
	return ignored
}

// loadDirRules returns the compiled rules for directory relDir (memoized per
// Matcher). "" is the root. The result is never nil.
func (m *Matcher) loadDirRules(relDir string) *dirRules {
	if dr, ok := m.dirs[relDir]; ok {
		return dr
	}

	absDir := m.root
	if relDir != "" {
		absDir = filepath.Join(m.root, filepath.FromSlash(relDir))
	}

	dr := &dirRules{}
	// A .git entry (directory for a normal repo, file for a submodule/worktree)
	// marks a fresh ignore context for this directory's contents.
	if _, err := os.Lstat(filepath.Join(absDir, ".git")); err == nil {
		dr.repoRoot = true
		dr.rules = append(dr.rules, compileFile(filepath.Join(absDir, ".git", "info", "exclude"))...)
	}
	dr.rules = append(dr.rules, compileFile(filepath.Join(absDir, ".gitignore"))...)

	m.dirs[relDir] = dr
	return dr
}

// cachedFile is a process-global parse of one ignore file, keyed by absolute
// path and revalidated by mtime+size.
type cachedFile struct {
	modUnixNano int64
	size        int64
	rules       []rule
}

var fileCache sync.Map // absPath → *cachedFile

// compileFile parses one ignore file into rules, using the process-global cache
// validated by a single os.Stat. A missing file yields no rules.
func compileFile(absPath string) []rule {
	info, err := os.Stat(absPath)
	if err != nil {
		return nil
	}
	mod := info.ModTime().UnixNano()
	size := info.Size()

	if v, ok := fileCache.Load(absPath); ok {
		cf := v.(*cachedFile)
		if cf.modUnixNano == mod && cf.size == size {
			return cf.rules
		}
	}

	f, err := os.Open(absPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var rules []rule
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if r, ok := compileLine(scanner.Text()); ok {
			rules = append(rules, r)
		}
	}

	fileCache.Store(absPath, &cachedFile{modUnixNano: mod, size: size, rules: rules})
	return rules
}

// compileLine turns one raw .gitignore line into a rule. It returns ok=false
// for blank lines and comments.
func compileLine(raw string) (rule, bool) {
	line := strings.TrimRight(raw, "\r") // tolerate CRLF files
	if line == "" || strings.HasPrefix(line, "#") {
		return rule{}, false
	}

	// Trailing whitespace is stripped unless the last space is backslash-escaped.
	line = trimTrailingSpaces(line)
	if line == "" {
		return rule{}, false
	}

	negate := false
	if strings.HasPrefix(line, "!") {
		negate = true
		line = line[1:]
	} else if strings.HasPrefix(line, `\#`) || strings.HasPrefix(line, `\!`) {
		// A leading hash or bang meant literally is backslash-escaped in git.
		line = line[1:]
	}

	dirOnly := false
	if strings.HasSuffix(line, "/") {
		dirOnly = true
		line = strings.TrimSuffix(line, "/")
	}
	if line == "" {
		return rule{}, false
	}

	// A slash anywhere other than a stripped trailing slash anchors the pattern
	// to the containing directory. A leading slash only anchors.
	anchored := strings.Contains(line, "/")
	line = strings.TrimPrefix(line, "/")
	if line == "" {
		return rule{}, false
	}

	return rule{negate: negate, dirOnly: dirOnly, anchored: anchored, pattern: line}, true
}

// trimTrailingSpaces removes trailing spaces that are not backslash-escaped.
func trimTrailingSpaces(line string) string {
	i := len(line)
	for i > 0 && line[i-1] == ' ' {
		bs := 0
		for j := i - 2; j >= 0 && line[j] == '\\'; j-- {
			bs++
		}
		if bs%2 == 1 {
			break // this space is escaped; keep it (and its backslash)
		}
		i--
	}
	return line[:i]
}
