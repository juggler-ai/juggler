//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/worker"
)

// What a conversation digest keeps, in bytes of text. A digest is part of a
// commit-message prompt, beside a diff of up to 24k (gitview.CommitContext),
// so together they stay a few thousand tokens.
const (
	digestMessageBudget = 2000  // one user message, or one turn's closing message
	digestUserBudget    = 8000  // the user messages together
	digestTurnsBudget   = 12000 // the turns together
)

// digestCut ends a message cut to its budget.
const digestCut = " [… cut]"

// conversationDigest is GET /api/git/conversation-digest's answer: what one
// conversation says about why some files changed, for a commit message.
//
// UserMessages are the text of the conversation's own user messages (not its
// sub-threads'), oldest first, each cut to digestMessageBudget and, together,
// to digestUserBudget by dropping the oldest. Turns are the turns that touched
// any of the files asked about, oldest first: what the user asked, the last
// thing the agent said in that turn, and which of the files it touched; the
// oldest are dropped past digestTurnsBudget. A cut message ends with
// digestCut; Truncated says a message or a turn was cut or dropped.
type conversationDigest struct {
	Conv         string       `json:"conv"`
	Title        string       `json:"title"`
	UserMessages []string     `json:"userMessages"`
	Turns        []digestTurn `json:"turns"`
	Truncated    bool         `json:"truncated"`
}

// digestTurn is one turn: from a user message up to the next. Files are the
// files asked about that it touched, as they were asked about, sorted.
type digestTurn struct {
	User    string   `json:"user"`
	Closing string   `json:"closing"`
	Files   []string `json:"files"`
}

// digestScope is what a digest is about: the files asked about, in the
// repository repo of the tree rooted at root, and what the attribution index
// says each of the conversation's tool calls wrote there (by tool use id).
type digestScope struct {
	root     string
	repo     string
	paths    map[string]bool
	recorded map[string][]string
}

// handleGitConversationDigest handles
// GET /api/git/conversation-digest?conv=<id>&workspace=<id>&repo=<rel>&paths=<p>&paths=<p>…:
// a digest of one conversation (conversationDigest) for the files named by
// paths — relative to the repository repo of the tree workspace names, as an
// attribution read's files are. It is a GET with the paths repeated in the
// query, because the files asked about are the few one conversation made; a
// query string carries thousands of them before any limit applies.
//
// The conversation is read live when it is loaded and from its stored
// document otherwise, and is never changed. One the project does not have
// (deleted, or in the bin) is a 404; a request naming no conversation, or a
// workspace that cannot be resolved, a 400.
func (s *Server) handleGitConversationDigest(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	conv := q.Get("conv")
	if conv == "" {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("A digest needs a conversation."))
		return
	}
	workspaceID := q.Get("workspace")
	tree, err := s.gitResolve(workspaceID)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	repo, ok := cleanDigestRepo(q.Get("repo"))
	if !ok {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("Not a path inside the project: repo"))
		return
	}
	dir := conversationDirectory{s}
	title, items, found := dir.Transcript(conv)
	if !found {
		handlers.WriteMessageError(w, r, http.StatusNotFound, msg.New("No such conversation"))
		return
	}

	paths := q["paths"]
	scope := digestScope{root: tree.Root(), repo: repo, paths: map[string]bool{}, recorded: map[string][]string{}}
	for _, p := range paths {
		scope.paths[p] = true
	}
	if project := s.ProjectPath(); project != "" && len(paths) > 0 {
		for _, rec := range gitattr.ForProject(project).ForPaths(workspaceID, repo, paths) {
			if rec.Conv == conv && rec.Item != "" {
				scope.recorded[rec.Item] = append(scope.recorded[rec.Item], rec.Path)
			}
		}
	}
	d := digestItems(items, scope)
	d.Conv, d.Title = conv, title
	handlers.WriteJSON(w, r, 0, d)
}

// cleanDigestRepo is a repository named relative to the tree, slash-separated
// and cleaned, or false for one that is absolute or climbs out.
func cleanDigestRepo(raw string) (string, bool) {
	if raw == "" {
		return "", true
	}
	if strings.ContainsAny(raw, "\\\x00") || strings.HasPrefix(raw, "/") || filepath.IsAbs(raw) {
		return "", false
	}
	cleaned := path.Clean(raw)
	if cleaned == "." {
		return "", true
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

// Transcript is a conversation's title and items, read from its live document
// when it is loaded and from what it stored otherwise. found is false for a
// conversation the project does not have; one with nothing stored yet has no
// items.
func (d conversationDirectory) Transcript(id string) (title string, items []worker.ConversationItem, found bool) {
	idx := d.scan()
	if idx == nil {
		return "", nil, false
	}
	dir, ok := idx.ByID[id]
	if !ok {
		return "", nil, false
	}
	title = idx.Names[id]
	if d.s.workerManager != nil {
		if live := d.s.workerManager.Get(id); live != nil {
			return title, live.Document().GetItems(), true
		}
	}
	state, err := os.ReadFile(core.ConvDocPath(dir))
	if err != nil {
		return title, nil, true
	}
	doc := worker.NewConversationDocument(id, "")
	if err := doc.LoadFromState(state); err != nil {
		return title, nil, true
	}
	return title, doc.GetItems(), true
}

// digestItems digests a conversation's items for scope (see
// conversationDigest), leaving its Conv and Title to the caller.
func digestItems(items []worker.ConversationItem, scope digestScope) conversationDigest {
	d := conversationDigest{UserMessages: []string{}, Turns: []digestTurn{}}
	var users []string
	var turns []digestTurn
	var turn *digestTurn
	touched := map[string]bool{}
	closeTurn := func() {
		if turn != nil && len(touched) > 0 {
			for p := range touched {
				turn.Files = append(turn.Files, p)
			}
			slices.Sort(turn.Files)
			turns = append(turns, *turn)
		}
		turn, touched = nil, map[string]bool{}
	}
	for _, item := range items {
		switch item.Type {
		case worker.ItemTypeUser:
			closeTurn()
			text, cut := capText(item.Content, digestMessageBudget)
			d.Truncated = d.Truncated || cut
			turn = &digestTurn{User: text}
			if strings.TrimSpace(item.Content) != "" {
				users = append(users, text)
			}
		case worker.ItemTypeAssistant:
			if turn != nil && strings.TrimSpace(item.Content) != "" {
				text, cut := capText(item.Content, digestMessageBudget)
				d.Truncated = d.Truncated || cut
				turn.Closing = text
			}
		default:
			if turn != nil {
				scope.touchedBy(item, touched)
			}
		}
	}
	closeTurn()

	var dropped bool
	d.UserMessages, dropped = keepRecent(users, digestUserBudget, func(s string) int { return len(s) })
	d.Truncated = d.Truncated || dropped
	d.Turns, dropped = keepRecent(turns, digestTurnsBudget, func(t digestTurn) int { return len(t.User) + len(t.Closing) })
	d.Truncated = d.Truncated || dropped
	return d
}

// touchedBy adds to touched the files asked about that item wrote: a
// completed write or edit by the path it was given, any tool call by what the
// attribution index recorded of it, and a sub-thread by everything inside it.
func (scope digestScope) touchedBy(item worker.ConversationItem, touched map[string]bool) {
	switch item.Type {
	case worker.ItemTypeToolAction:
		for _, p := range scope.recorded[item.ToolUseID] {
			if scope.paths[p] {
				touched[p] = true
			}
		}
		if !writesFiles(item) {
			return
		}
		var input struct {
			Path     string `json:"path"`
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(item.ToolInput, &input) != nil {
			return
		}
		for _, raw := range []string{input.Path, input.FilePath} {
			if p, ok := scope.inRepo(raw); ok && scope.paths[p] {
				touched[p] = true
			}
		}
	case worker.ItemTypeThread:
		var nested []worker.ConversationItem
		if json.Unmarshal(item.Items, &nested) != nil {
			return
		}
		for _, n := range nested {
			scope.touchedBy(n, touched)
		}
	}
}

// writesFiles says whether a tool call is a write or edit that went through:
// the tools that attribute their writes (edit-base.js), by their name with
// any MCP server prefix ("mcp__juggler__edit") taken off.
func writesFiles(item worker.ConversationItem) bool {
	name := item.ToolName
	if at := strings.LastIndex(name, "__"); at >= 0 {
		name = name[at+2:]
	}
	return (name == "edit" || name == "write") &&
		item.State == worker.StateCompleted && !item.IsError && !item.Cancelled
}

// inRepo names a tool's path as the files asked about are named: relative to
// the repository, slash-separated. A tool's path is absolute, or relative to
// the tree's root. false for one outside the repository.
func (scope digestScope) inRepo(raw string) (string, bool) {
	if raw == "" || scope.root == "" {
		return "", false
	}
	file := filepath.FromSlash(raw)
	if !filepath.IsAbs(file) {
		file = filepath.Join(scope.root, file)
	}
	file = filepath.Clean(file)
	rel, ok := relWithin(scope.root, file)
	if !ok {
		// Two names for one place: macOS's /var is /private/var.
		realRoot, rerr := filepath.EvalSymlinks(scope.root)
		realFile, ferr := filepath.EvalSymlinks(file)
		if rerr != nil || ferr != nil {
			return "", false
		}
		if rel, ok = relWithin(realRoot, realFile); !ok {
			return "", false
		}
	}
	if scope.repo == "" {
		return rel, true
	}
	if inner, cut := strings.CutPrefix(rel, scope.repo+"/"); cut {
		return inner, true
	}
	return "", false
}

// relWithin is file relative to dir, slash-separated, or false when it is not
// below dir.
func relWithin(dir, file string) (string, bool) {
	rel, err := filepath.Rel(dir, file)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// capText is s cut to at most n bytes, at a character boundary, and marked;
// cut says whether it was.
func capText(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	keep := n - len(digestCut)
	for keep > 0 && !utf8.RuneStart(s[keep]) {
		keep--
	}
	return s[:keep] + digestCut, true
}

// keepRecent is the newest of all whose sizes fit in budget together, in
// their order, and whether any were dropped.
func keepRecent[T any](all []T, budget int, size func(T) int) ([]T, bool) {
	total, from := 0, len(all)
	for from > 0 && total+size(all[from-1]) <= budget {
		total += size(all[from-1])
		from--
	}
	return append([]T{}, all[from:]...), from > 0
}
