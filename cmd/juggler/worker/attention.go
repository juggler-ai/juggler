//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"maps"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/internal/attention"
	"juggler/internal/jlog"
)

// A conversation's attention (juggler/internal/attention) is its tab's status
// circle worked out on the server, in the same order of precedence as
// ConversationBar._tabStatus: a tool call waiting on the user, else a claimed
// turn, else a root thread whose last item is an error, else idle. Each worker
// publishes its own entry to the Manager's attentionIndex from its run loop;
// the index serves the project's summary and keeps its durable part on disk.

// askUserQuestionTool is the tool whose pending call is a question to the
// user rather than a call to approve.
const askUserQuestionTool = "AskUserQuestion"

// attentionMinGap is the least time between two recomputations prompted by
// events. Working attention out walks the whole item tree under the
// process-wide ycrdtMu, and a streaming turn raises an event per update; the
// liveness tick (livenessInterval) recomputes what a burst left stale, so an
// entry trails the conversation by at most that.
const attentionMinGap = 250 * time.Millisecond

// attentionNow is the conversation's attention at now, prev being what it was
// last found to be: a turn already working keeps the time it was first seen,
// and a state with no time of its own on record takes now.
func (w *ConversationWorker) attentionNow(prev attention.Entry, now time.Time) attention.Entry {
	var pending, lastRoot *ycrdt.YMap
	var running bool
	var e attention.Entry
	withYDoc(func() {
		items := w.doc.getItems()
		walkAllItems(items, "", func(m *ycrdt.YMap, _ string) bool {
			if yMapString(m, keyType) == ItemTypeToolAction && yMapString(m, keyState) == StatePending {
				pending = m
				return true
			}
			return false
		})
		running = w.subtreeHasActiveRunLocked("")
		if items != nil {
			if n := int(items.GetLength()); n > 0 {
				lastRoot, _ = items.Get(ycrdt.Number(n - 1)).(*ycrdt.YMap)
			}
		}
		switch {
		case pending != nil:
			e = pendingAttention(pending)
		case running:
			e = attention.Entry{State: attention.Working}
		case lastRoot != nil && yMapString(lastRoot, keyType) == ItemTypeError:
			text := yMapString(lastRoot, keySummary)
			if text == "" {
				text = yMapString(lastRoot, keyContent)
			}
			e = attention.Entry{State: attention.Failed, Since: itemTime(lastRoot), Excerpt: attention.Excerpt(text)}
		default:
			e = attention.Entry{State: attention.Idle}
		}
	})
	if e.State == attention.Idle {
		return e
	}
	if e.Since.IsZero() {
		e.Since = now
		if prev.State == e.State && prev.Wait == e.Wait && prev.Excerpt == e.Excerpt {
			e.Since = prev.Since
		}
	}
	return e
}

// pendingAttention is the waiting entry for the pending tool call m. Caller
// holds ycrdtMu.
func pendingAttention(m *ycrdt.YMap) attention.Entry {
	name := yMapString(m, keyToolName)
	input := yMapRawJSON(m, keyToolInput)
	e := attention.Entry{State: attention.Waiting, Wait: attention.Approval, Since: itemTime(m)}
	if name == askUserQuestionTool {
		e.Wait = attention.Question
		var in struct {
			Questions []struct {
				Question string `json:"question"`
			} `json:"questions"`
		}
		if json.Unmarshal(input, &in) == nil && len(in.Questions) > 0 {
			e.Excerpt = attention.Excerpt(in.Questions[0].Question)
		}
		return e
	}
	excerpt := name
	if head := toolSummary(name, input); head != "" {
		excerpt += ": " + head
	}
	e.Excerpt = attention.Excerpt(excerpt)
	return e
}

// itemTime is an item's creation time, zero when it has none on record.
// Caller holds ycrdtMu.
func itemTime(m *ycrdt.YMap) time.Time {
	t, err := time.Parse(time.RFC3339, yMapString(m, keyTimestamp))
	if err != nil {
		return time.Time{}
	}
	return t
}

// attentionPublication is a worker's record of what it last published to the
// index, and when it last worked its attention out. Actor only.
type attentionPublication struct {
	entry attention.Entry
	// valid is false until the first publish, which is written even when
	// idle: the saved summary of an earlier session may still list the
	// conversation.
	valid bool
	// stale is set by every event but a liveness tick, and cleared by the
	// recomputation that follows it.
	stale bool
	// at is when attention was last worked out.
	at time.Time
}

// refreshAttention works the conversation's attention out again when an
// event since the last time may have changed it — at once, unless the last
// was under attentionMinGap ago and this is not a liveness tick — and
// publishes it if it differs from what was last published. Actor only.
func (r *run) refreshAttention(tick bool) {
	if r.attentionIndex == nil || r.projectPath == "" || r.deleting.Load() {
		return
	}
	p := &r.attentionPublished
	if !tick {
		p.stale = true
	}
	now := time.Now()
	if !p.stale || (!tick && p.valid && now.Sub(p.at) < attentionMinGap) {
		return
	}
	p.stale, p.at = false, now
	e := r.attentionNow(p.entry, now)
	if p.valid && e == p.entry {
		return
	}
	p.entry, p.valid = e, true
	r.attentionIndex.publish(r.projectPath, r.conversationID, e, now)
}

// attentionIndex is every project's attention summary, shared by the
// Manager's workers. Safe for concurrent use — workers publish from their own
// run loops — because its state sits in a one-slot channel and is owned by
// whoever has taken it out (with).
type attentionIndex struct {
	state chan *attentionIndexState
}

type attentionIndexState struct {
	projects map[string]*attentionProject // by project path
	// removed holds the conversations Remove tore down, refused until
	// restored, as in heldIndexState.
	removed map[string]bool
}

// attentionProject is one project's summary.
type attentionProject struct {
	// live holds what loaded workers published; saved, the durable entries
	// as written to the project's attention.json — read from it first, so
	// a conversation no worker has loaded is still known. A conversation's
	// entry is its live one, else its saved one, else idle.
	live, saved map[string]attention.Entry
	rev         uint64
	lastActive  time.Time
}

func newAttentionIndex() *attentionIndex {
	x := &attentionIndex{state: make(chan *attentionIndexState, 1)}
	x.state <- &attentionIndexState{projects: map[string]*attentionProject{}, removed: map[string]bool{}}
	return x
}

// with runs fn as the state's only owner.
func (x *attentionIndex) with(fn func(s *attentionIndexState)) {
	s := <-x.state
	defer func() { x.state <- s }()
	fn(s)
}

// project returns the summary for path, its saved part read from disk the
// first time.
func (s *attentionIndexState) project(path string) *attentionProject {
	if p, ok := s.projects[path]; ok {
		return p
	}
	saved, err := attention.Read(path)
	if err != nil {
		jlog.Error("[attention] %s is unreadable, starting it afresh: %v", attention.Path(path), err)
	}
	p := &attentionProject{live: map[string]attention.Entry{}, saved: saved}
	s.projects[path] = p
	return p
}

// entry is a conversation's entry in p.
func (p *attentionProject) entry(convID string) attention.Entry {
	if e, ok := p.live[convID]; ok {
		return e
	}
	if e, ok := p.saved[convID]; ok {
		return e
	}
	return attention.Entry{State: attention.Idle}
}

// write saves p's durable entries to path's attention.json.
func (p *attentionProject) write(path string) {
	if err := attention.Write(path, p.saved); err != nil {
		jlog.Error("[attention] writing %s: %v", attention.Path(path), err)
	}
}

// publish records a loaded conversation's entry, at now. A change moves the
// project's revision, a change into or out of a state that is not idle moves
// its last activity, and a change to what outlives the process is written
// through. A conversation Remove tore down is not recorded.
func (x *attentionIndex) publish(projectPath, convID string, e attention.Entry, now time.Time) {
	x.with(func(s *attentionIndexState) {
		if s.removed[convID] {
			return
		}
		p := s.project(projectPath)
		prev := p.entry(convID)
		p.live[convID] = e
		if prev == e {
			return
		}
		p.rev++
		if prev.State != attention.Idle || e.State != attention.Idle {
			p.lastActive = now
		}
		saved, had := p.saved[convID]
		switch {
		case e.Durable() && (!had || saved != e):
			p.saved[convID] = e
		case !e.Durable() && had:
			delete(p.saved, convID)
		default:
			return
		}
		p.write(projectPath)
	})
}

// summary returns a project's summary: every conversation not idle.
func (x *attentionIndex) summary(projectPath string) AttentionSummary {
	var out AttentionSummary
	x.with(func(s *attentionIndexState) {
		p := s.project(projectPath)
		out = AttentionSummary{Rev: p.rev, LastActive: p.lastActive, Conversations: maps.Clone(p.saved)}
		maps.Copy(out.Conversations, p.live)
		maps.DeleteFunc(out.Conversations, func(_ string, e attention.Entry) bool { return e.State == attention.Idle })
	})
	return out
}

// drop withdraws a removed conversation from every summary and refuses its
// entry from now on, until restore.
func (x *attentionIndex) drop(convID string) {
	x.with(func(s *attentionIndexState) {
		s.removed[convID] = true
		for path, p := range s.projects {
			_, live := p.live[convID]
			_, saved := p.saved[convID]
			if !live && !saved {
				continue
			}
			delete(p.live, convID)
			delete(p.saved, convID)
			p.rev++
			if saved {
				p.write(path)
			}
		}
	})
}

// restore lets a conversation brought back from the bin publish again.
func (x *attentionIndex) restore(convID string) {
	x.with(func(s *attentionIndexState) { delete(s.removed, convID) })
}

// AttentionSummary is a project's attention as the index holds it: every
// conversation not idle, by id.
type AttentionSummary struct {
	// Rev moves whenever any conversation's entry changes.
	Rev uint64
	// LastActive is when a conversation last entered or left a state that
	// is not idle; zero when none has since the Manager started.
	LastActive    time.Time
	Conversations map[string]attention.Entry
}

// Attention returns the attention summary of projectPath's conversations:
// those loaded as they stand, and the rest as the project's saved summary
// last recorded them.
func (m *Manager) Attention(projectPath string) AttentionSummary {
	return m.attention.summary(projectPath)
}
