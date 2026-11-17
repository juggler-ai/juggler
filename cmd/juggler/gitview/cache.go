//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bytes"
	"container/list"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// historyCache holds what History reads over and over and git can only ever
// answer one way: answers about commits named by their full ids. A commit is
// the hash of its content, so the commit an id names, its parents, its message
// and the difference between it and another commit are fixed for as long as the
// id names anything — and every key here is an id git resolved, never a name a
// user typed, which can move.
//
// Each key also carries the repository's git and common directories, so one
// workspace is never answered from another's repository even where the two
// hold the same commit, and every limit the answer was read under. Nothing
// about a working tree, an index or a stash is ever kept: a scope is cached
// only when both of its sides are commits or trees named by id (see
// immutableScope).
//
// It also remembers which repositories a project holds, briefly; see
// resolveRepoDir.
var historyCache = newGitCache(historyCacheEntries, historyCacheBytes)

// The bounds on historyCache: entries, and an estimate of the bytes they hold.
// A commit's detail is a few kilobytes; a whole commit's file metadata is
// roughly a hundred bytes a file.
const (
	historyCacheEntries = 1024
	historyCacheBytes   = 32 << 20
)

// repoFindFresh is how long a repository found under a project is taken to be
// there without searching again. See resolveRepoDir for why that is safe.
const repoFindFresh = 10 * time.Second

// The empty tree's id under each hash git uses. An object id's length says
// which hash its repository uses, so a commit's id is enough to name the tree
// of nothing it is compared against when it has no parent.
const (
	sha1EmptyTree   = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
	sha256EmptyTree = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
)

// cacheKind is what a cache entry answers.
type cacheKind int

const (
	cacheCommit   cacheKind = iota + 1 // a commit read's answer, Repo left empty: target is the commit
	cacheParent                        // what a commit is compared against: target is the commit
	cacheDiffMeta                      // gitDiffMetadata's answer: base against target
	cacheRepoDir                       // a repository found under a project: base is the root, target the repo's path
)

// cacheKey is everything an entry's answer depends on. limit and limit2 are
// the ceilings it was read under.
type cacheKey struct {
	repo         repoID
	kind         cacheKind
	base, target string
	limit        int
	limit2       int
}

// gitCache is a least-recently-used map bounded by its number of entries and
// by the bytes they are estimated to hold, safe for concurrent use. Its values
// are never modified once put: a reader that needs to change one copies it.
type gitCache struct {
	lock       chan struct{} // held while the fields below are read or written
	maxEntries int
	maxBytes   int
	bytes      int
	recent     *list.List // of *cacheEntry, the most recently used first
	entries    map[cacheKey]*list.Element
}

type cacheEntry struct {
	key   cacheKey
	value any
	size  int
}

func newGitCache(maxEntries, maxBytes int) *gitCache {
	return &gitCache{
		lock: make(chan struct{}, 1), maxEntries: maxEntries, maxBytes: maxBytes,
		recent: list.New(), entries: map[cacheKey]*list.Element{},
	}
}

func (c *gitCache) get(k cacheKey) (any, bool) {
	c.lock <- struct{}{}
	defer func() { <-c.lock }()
	e, ok := c.entries[k]
	if !ok {
		return nil, false
	}
	c.recent.MoveToFront(e)
	return e.Value.(*cacheEntry).value, true
}

// put keeps value under k, evicting the least recently used entries until the
// cache is back within its bounds. A value bigger than an eighth of the cache
// is not kept: it would push out everything else for one answer.
func (c *gitCache) put(k cacheKey, value any, size int) {
	if size > c.maxBytes/8 {
		return
	}
	c.lock <- struct{}{}
	defer func() { <-c.lock }()
	if e, ok := c.entries[k]; ok {
		entry := e.Value.(*cacheEntry)
		c.bytes += size - entry.size
		entry.value, entry.size = value, size
		c.recent.MoveToFront(e)
	} else {
		c.entries[k] = c.recent.PushFront(&cacheEntry{key: k, value: value, size: size})
		c.bytes += size
	}
	for c.recent.Len() > c.maxEntries || c.bytes > c.maxBytes {
		oldest := c.recent.Back()
		entry := oldest.Value.(*cacheEntry)
		c.recent.Remove(oldest)
		delete(c.entries, entry.key)
		c.bytes -= entry.size
	}
}

// remove forgets k.
func (c *gitCache) remove(k cacheKey) {
	c.lock <- struct{}{}
	defer func() { <-c.lock }()
	if e, ok := c.entries[k]; ok {
		c.recent.Remove(e)
		delete(c.entries, k)
		c.bytes -= e.Value.(*cacheEntry).size
	}
}

// repoID names a repository by its two directories, as GitDirs does.
type repoID struct{ gitDir, commonDir string }

// repoIdentity reads the directories of the repository whose working tree is
// dir off disk, the way git finds them, so that a cached read can be keyed on
// them without running git: `.git` is the git directory, or a file naming it,
// and a `commondir` file in it names the common directory relative to it. Both
// come back absolute with their links resolved, as GitDirs gives them.
//
// false is a repository this does not recognise, or one git would be pointed
// elsewhere for by its environment; such a read is simply not cached.
func repoIdentity(dir string) (repoID, bool) {
	for _, v := range []string{"GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"} {
		if os.Getenv(v) != "" {
			return repoID{}, false
		}
	}
	dotGit := filepath.Join(dir, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return repoID{}, false
	}
	gitDir := dotGit
	if !info.IsDir() {
		named, ok := readSmallFile(dotGit)
		if !ok || !strings.HasPrefix(named, "gitdir: ") {
			return repoID{}, false
		}
		gitDir = strings.TrimPrefix(named, "gitdir: ")
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(dir, gitDir)
		}
	}
	if gitDir, err = filepath.EvalSymlinks(gitDir); err != nil {
		return repoID{}, false
	}
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		return repoID{}, false
	}
	common := gitDir
	if named, ok := readSmallFile(filepath.Join(gitDir, "commondir")); ok {
		if !filepath.IsAbs(named) {
			named = filepath.Join(gitDir, named)
		}
		if common, err = filepath.EvalSymlinks(named); err != nil {
			return repoID{}, false
		}
	} else if _, err := os.Lstat(filepath.Join(gitDir, "commondir")); !errors.Is(err, fs.ErrNotExist) {
		return repoID{}, false
	}
	return repoID{gitDir: gitDir, commonDir: common}, true
}

// readSmallFile is the first line of one of git's own pointer files, which
// hold a path and nothing else.
func readSmallFile(p string) (string, bool) {
	f, err := os.Open(p) //nolint:gosec // a file of git's inside a repository the project holds
	if err != nil {
		return "", false
	}
	defer f.Close() //nolint:errcheck // read-only
	b, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return "", false
	}
	line, _, _ := strings.Cut(string(b), "\n")
	line = strings.TrimRight(line, "\r")
	return line, line != ""
}

// isObjectID reports whether s is a whole object id as git prints one: forty
// lowercase hex digits under SHA-1, sixty-four under SHA-256. Only such a name
// is fixed; an abbreviation can become ambiguous, and a ref can move.
func isObjectID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if (s[i] < '0' || s[i] > '9') && (s[i] < 'a' || s[i] > 'f') {
			return false
		}
	}
	return true
}

// knownCommit reports whether id is a commit a read of this repository has
// already resolved, so that resolving it again can be skipped.
func knownCommit(dir, id string) bool {
	if !isObjectID(id) {
		return false
	}
	repo, ok := repoIdentity(dir)
	if !ok {
		return false
	}
	_, ok = historyCache.get(cacheKey{repo: repo, kind: cacheParent, target: id})
	return ok
}

// cachedParent is what the commit id is compared against, if a read of this
// repository has already said.
func cachedParent(dir, id string) (string, bool) {
	if !isObjectID(id) {
		return "", false
	}
	repo, ok := repoIdentity(dir)
	if !ok {
		return "", false
	}
	v, ok := historyCache.get(cacheKey{repo: repo, kind: cacheParent, target: id})
	if !ok {
		return "", false
	}
	return v.(string), true
}

// rememberParent records what the commit id is compared against: its first
// parent, or the empty tree.
func rememberParent(dir, id, base string) {
	if !isObjectID(id) || !isObjectID(base) {
		return
	}
	if repo, ok := repoIdentity(dir); ok {
		historyCache.put(cacheKey{repo: repo, kind: cacheParent, target: id}, base, len(id)+len(base)+64)
	}
}

// immutableScope is the key a resolved scope's answer of kind is kept under,
// and false for a scope whose answer can change: one with the working tree or
// the index on a side, or a conversation's turn, or a repository whose
// directories cannot be read.
func immutableScope(dir string, scope resolvedScope, kind cacheKind, limit int) (cacheKey, bool) {
	if scope.Kind() != ScopeCommits || scope.turn || !isObjectID(scope.base) || !isObjectID(scope.target) {
		return cacheKey{}, false
	}
	repo, ok := repoIdentity(dir)
	if !ok {
		return cacheKey{}, false
	}
	return cacheKey{repo: repo, kind: kind, base: scope.base, target: scope.target, limit: limit}, true
}

// metaSize estimates what a file metadata map holds.
func metaSize(meta map[string]gitFileMeta) int {
	n := 64
	for path, f := range meta {
		n += len(path) + len(f.OldPath) + len(f.NewID) + 96
	}
	return n
}

// commitSize estimates what a commit read's answer holds.
func commitSize(c Commit) int {
	n := 512 + len(c.Subject) + len(c.Body) + len(c.Author.Name) + len(c.Author.Email) +
		len(c.Committer.Name) + len(c.Committer.Email) + 48*len(c.Parents)
	for _, f := range c.Files {
		n += len(f.Path) + len(f.OldPath) + 96
	}
	return n
}

// emptyTreeFor is the tree of nothing in the repository the object id is from.
func emptyTreeFor(id string) (string, bool) {
	switch len(id) {
	case len(sha1EmptyTree):
		return sha1EmptyTree, true
	case len(sha256EmptyTree):
		return sha256EmptyTree, true
	}
	return "", false
}

// parseGitRawNumstat reads one `diff-tree --raw --numstat -z`: every raw
// record first (see parseGitRawDiff), then every numstat record (see
// parseGitNumstat). A raw record is a colon-led field block and then its one
// or two paths, so the first record that does not open with a colon, at a
// place where a record begins, is the first of the numstat half — a path that
// opens with a colon is never mistaken for one, because a path is only ever
// read where a path is due.
func parseGitRawNumstat(out []byte) (map[string]gitFileMeta, map[string]gitDiffstat) {
	split := len(out)
	for at := 0; at < len(out); {
		end := bytes.IndexByte(out[at:], 0)
		if end < 0 {
			break // a pass cut short inside a record
		}
		record := out[at : at+end]
		if len(record) == 0 || record[0] != ':' {
			split = at
			break
		}
		fields := strings.Fields(string(record[1:]))
		paths := 1
		if len(fields) >= 5 && (fields[4][0] == 'R' || fields[4][0] == 'C') {
			paths = 2
		}
		at += end + 1
		for ; paths > 0 && at < len(out); paths-- {
			next := bytes.IndexByte(out[at:], 0)
			if next < 0 {
				at = len(out)
				break
			}
			at += next + 1
		}
	}
	return parseGitRawDiff(out[:split]), parseGitNumstat(out[split:])
}
