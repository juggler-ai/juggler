//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package attention is the vocabulary of a project's attention summary: which
// of its conversations wait on the user, are working, or failed. A session
// serves it (GET /api/health/attention), the machine server gathers it from
// every session, and the session keeps the part that outlives it in
// <project>/.juggler/attention.json, so a conversation nobody has loaded since
// a restart — and a project with no session at all — is still known to be
// waiting.
//
// The states are those of a conversation tab's status circle in the app, in
// the same order of precedence: waiting outranks working, which outranks
// failed.
package attention

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"juggler/internal/atomicio"
)

// State is what a conversation is doing, as far as its user is concerned.
type State string

const (
	// Idle: nothing running, nothing asked, the last turn did not fail.
	Idle State = "idle"
	// Working: a turn is in flight and not parked on the user.
	Working State = "working"
	// Waiting: a tool call waits for the user's approval or answer.
	Waiting State = "waiting"
	// Failed: the conversation's last turn ended in an error.
	Failed State = "failed"
)

// Wait is what a waiting conversation waits for.
type Wait string

const (
	// Approval: a tool call waits to be allowed.
	Approval Wait = "approval"
	// Question: the model asked the user a question (AskUserQuestion).
	Question Wait = "question"
)

// ExcerptMax caps an excerpt, in characters.
const ExcerptMax = 120

// Entry is one conversation's attention.
type Entry struct {
	State State `json:"state"`
	// Wait is set for a waiting conversation only.
	Wait Wait `json:"wait,omitempty"`
	// Since is when the conversation entered its state, as far as it is
	// known: a waiting call's or an error's creation time, or when a turn was
	// first seen working.
	Since time.Time `json:"since,omitzero"`
	// Excerpt is the question asked, the tool and the head of its input, or
	// the error's summary, at most ExcerptMax characters.
	Excerpt string `json:"excerpt,omitempty"`
}

// Durable reports whether e describes something that outlives the session
// process: a waiting call and a failed turn are in the conversation's
// document, a working turn is not.
func (e Entry) Durable() bool {
	return e.State == Waiting || e.State == Failed
}

// Conversation is one conversation's entry as a session serves it.
type Conversation struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	Entry
}

// Report is a session's answer to GET /api/health/attention: every
// conversation of its project that is not idle.
type Report struct {
	// Rev changes whenever any conversation's entry does, so a poller can ask
	// for the report only when it has moved (GET /api/health/active carries
	// it as attentionRev).
	Rev uint64 `json:"rev"`
	// LastActive is when any conversation last entered or left a non-idle
	// state in this session; absent when none has.
	LastActive    time.Time      `json:"lastActive,omitzero"`
	Conversations []Conversation `json:"conversations"`
}

// Count returns how many of cs are in state s.
func Count(cs []Conversation, s State) int {
	n := 0
	for _, c := range cs {
		if c.State == s {
			n++
		}
	}
	return n
}

// Excerpt makes s an excerpt: its whitespace runs collapsed to single
// spaces, and cut to ExcerptMax characters with an ellipsis.
func Excerpt(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= ExcerptMax {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:ExcerptMax-1]), " ") + "…"
}

// fileName is the saved summary's name under the project's .juggler directory.
const fileName = "attention.json"

// Path is where project's saved summary lives.
func Path(project string) string {
	return filepath.Join(project, ".juggler", fileName)
}

// Read returns project's saved summary: conversation id → durable entry.
// A project with none saved has an empty one.
func Read(project string) (map[string]Entry, error) {
	data, err := atomicio.RobustReadFile(Path(project))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]Entry{}, nil
	}
	if err != nil {
		return map[string]Entry{}, err
	}
	saved := map[string]Entry{}
	if err := json.Unmarshal(data, &saved); err != nil {
		return map[string]Entry{}, err
	}
	return saved, nil
}

// Write saves entries as project's summary, atomically, so a reader never
// sees half a file. An empty summary is deleted.
func Write(project string, entries map[string]Entry) error {
	path := Path(project)
	if len(entries) == 0 {
		return atomicio.RobustRemoveAll(path)
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return atomicio.WriteFile(path, data, 0o644)
}

// CountWaiting returns how many of a saved summary's conversations wait.
func CountWaiting(saved map[string]Entry) int {
	n := 0
	for _, e := range saved {
		if e.State == Waiting {
			n++
		}
	}
	return n
}
