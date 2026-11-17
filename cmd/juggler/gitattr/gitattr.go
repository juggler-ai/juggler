//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitattr is a project's attribution index: which conversation wrote
// which version of which file, so the git client can say which conversation
// made the changes being committed.
//
// One record is kept per write. A file is named the way the git views name it
// (gitview): by its repository, relative to the root of the tree it was
// written in ("" for the root repository), and its path relative to that
// repository's top level, slash-separated — what `git ls-files -s --full-name`
// prints in that repository. The version is the git blob id of the content as
// `git hash-object` reads it from the working tree, clean filters applied, so
// it equals the index's entry once that content is staged. A record whose blob
// matches what is staged says this conversation's version is what is being
// committed; one that matches only by path says the file was edited since.
//
// The index lives at git-attribution.json in the project's state folder
// (projectpaths.StateDir), never in the project. It is kept small: a record
// older than MaxAge is dropped whenever the file is read or written, only the
// newest record of each conversation for each file is kept, and no more than
// MaxRecords in all. The index is a hint for choosing a conversation, never
// the truth about one: a write it missed is a file the git client cannot
// attribute, nothing worse.
package gitattr

import (
	"cmp"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/projectpaths"
)

// FileName is the index's name in the project's state folder.
const FileName = "git-attribution.json"

const (
	// MaxAge is how long a record is kept.
	MaxAge = 30 * 24 * time.Hour
	// MaxRecords is the most records an index keeps: the newest.
	MaxRecords = 5000
)

// Strength is how sure a record is of who wrote the file.
type Strength string

const (
	// Strong is a write the conversation's own tool made.
	Strong Strength = "strong"
	// Weak is a change seen while the conversation was one of the writers that
	// could have made it (a shell command, among others running in the tree).
	Weak Strength = "weak"
)

// Record is one write of one file by one conversation.
type Record struct {
	// Workspace is the id of the workspace whose tree was written, "" for the
	// project's.
	Workspace string `json:"workspace,omitempty"`
	// Repo is the repository, relative to the tree's root and slash-separated;
	// "" for the tree's own (or the one that encloses it).
	Repo string `json:"repo,omitempty"`
	// Path is the file relative to the repository's top level, slash-separated.
	Path string `json:"path"`
	// Blob is the git blob id of the content written.
	Blob string `json:"blob"`

	Conv   string `json:"conv"`
	Thread string `json:"thread,omitempty"` // The thread item that wrote it, "" for the root thread
	Item   string `json:"item,omitempty"`   // The tool use that wrote it

	// Time is when it was written, epoch milliseconds.
	Time     int64    `json:"time"`
	Strength Strength `json:"strength"`
}

// key is what makes two records the same file written by the same conversation.
type key struct{ workspace, repo, path, conv string }

func (r Record) key() key { return key{r.Workspace, r.Repo, r.Path, r.Conv} }

// fileShape is the file's contents.
type fileShape struct {
	Records []Record `json:"records"`
}

// Index is one project's attribution index, written through to its file. Safe
// for concurrent use.
type Index struct {
	file string
	now  func() time.Time

	// state is owned by whoever has taken it out of the channel (with), so
	// writers from any goroutine take turns.
	state chan *indexState
}

type indexState struct {
	loaded  bool
	records []Record // oldest first
}

// with runs fn as the state's only owner, the file read first if it has not
// been.
func (x *Index) with(fn func(s *indexState)) {
	s := <-x.state
	defer func() { x.state <- s }()
	x.load(s)
	fn(s)
}

// Path is where a project's index lives.
func Path(project string) string {
	return filepath.Join(projectpaths.StateDir(project), FileName)
}

// Open is the index kept in file, read from it on first use. Two Indexes over
// one file do not know of each other's writes; ForProject is the one every
// caller in a server shares.
func Open(file string) *Index {
	x := &Index{file: file, now: time.Now, state: make(chan *indexState, 1)}
	x.state <- &indexState{}
	return x
}

// shared is every project's index ForProject has handed out, by file, owned by
// whoever has taken it out of the channel.
var shared = func() chan map[string]*Index {
	c := make(chan map[string]*Index, 1)
	c <- map[string]*Index{}
	return c
}()

// ForProject is the project's index, the same one for every caller asking for
// the same file.
func ForProject(project string) *Index {
	file := Path(project)
	m := <-shared
	defer func() { shared <- m }()
	if x := m[file]; x != nil {
		return x
	}
	x := Open(file)
	m[file] = x
	return x
}

// PruneConversation forgets every record the conversation made in the
// project's index.
func PruneConversation(project, conv string) {
	if project == "" || conv == "" {
		return
	}
	ForProject(project).PruneConversation(conv)
}

// Add records a write. A record with no Time is stamped now, and one with no
// Strength is Strong. It replaces the conversation's earlier record of the same
// file.
func (x *Index) Add(r Record) {
	if r.Time == 0 {
		r.Time = x.now().UnixMilli()
	}
	if r.Strength == "" {
		r.Strength = Strong
	}
	x.with(func(s *indexState) {
		k := r.key()
		s.records = slices.DeleteFunc(s.records, func(old Record) bool { return old.key() == k })
		s.records = append(s.records, r)
		x.trim(s)
		x.write(s)
	})
}

// ForPaths is every record of the files named in one repository of one tree,
// newest first. No paths is every file of it.
func (x *Index) ForPaths(workspace, repo string, paths []string) []Record {
	want := make(map[string]bool, len(paths))
	for _, p := range paths {
		want[p] = true
	}
	return x.matching(func(r Record) bool {
		return r.Workspace == workspace && r.Repo == repo && (len(paths) == 0 || want[r.Path])
	})
}

// Lookup is every record of one file whose content was blob, newest first:
// the conversations whose version of the file that is.
func (x *Index) Lookup(workspace, repo, path, blob string) []Record {
	return x.matching(func(r Record) bool {
		return r.Workspace == workspace && r.Repo == repo && r.Path == path && r.Blob == blob
	})
}

// PruneConversation forgets every record the conversation made.
func (x *Index) PruneConversation(conv string) {
	x.with(func(s *indexState) {
		n := len(s.records)
		s.records = slices.DeleteFunc(s.records, func(r Record) bool { return r.Conv == conv })
		if len(s.records) != n {
			x.write(s)
		}
	})
}

// matching is the records keep accepts, newest first, after dropping those
// past their age.
func (x *Index) matching(keep func(Record) bool) []Record {
	var out []Record
	x.with(func(s *indexState) {
		if x.trim(s) {
			x.write(s)
		}
		for i := len(s.records) - 1; i >= 0; i-- {
			if keep(s.records[i]) {
				out = append(out, s.records[i])
			}
		}
	})
	return out
}

// trim drops the records past MaxAge and past MaxRecords, and says whether it
// dropped any.
func (x *Index) trim(s *indexState) bool {
	n := len(s.records)
	cutoff := x.now().Add(-MaxAge).UnixMilli()
	s.records = slices.DeleteFunc(s.records, func(r Record) bool { return r.Time < cutoff })
	if len(s.records) > MaxRecords {
		s.records = slices.Delete(s.records, 0, len(s.records)-MaxRecords)
	}
	return len(s.records) != n
}

// load reads the file the first time the index is used. A file that cannot be
// read starts the index afresh.
func (x *Index) load(s *indexState) {
	if s.loaded {
		return
	}
	s.loaded = true
	data, err := atomicio.RobustReadFile(x.file)
	switch {
	case err == nil:
		var f fileShape
		if err := json.Unmarshal(data, &f); err != nil {
			jlog.Error("[gitattr] %s is unreadable, starting it afresh: %v", x.file, err)
			return
		}
		s.records = f.Records
		slices.SortStableFunc(s.records, func(a, b Record) int { return cmp.Compare(a.Time, b.Time) })
		if x.trim(s) {
			x.write(s)
		}
	case !os.IsNotExist(err):
		jlog.Error("[gitattr] reading %s: %v", x.file, err)
	}
}

// write writes the index atomically, so a reader never sees half a file. An
// empty index is deleted.
func (x *Index) write(s *indexState) {
	if len(s.records) == 0 {
		if err := atomicio.RobustRemoveAll(x.file); err != nil {
			jlog.Error("[gitattr] removing %s: %v", x.file, err)
		}
		return
	}
	data, err := json.Marshal(fileShape{Records: s.records})
	if err != nil {
		jlog.Error("[gitattr] encoding %s: %v", x.file, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(x.file), 0o755); err != nil {
		jlog.Error("[gitattr] creating %s: %v", filepath.Dir(x.file), err)
		return
	}
	if err := atomicio.WriteFile(x.file, data, 0o644); err != nil {
		jlog.Error("[gitattr] writing %s: %v", x.file, err)
	}
}
