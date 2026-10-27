//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"encoding/json"
	"net/http"
	"time"

	"juggler/cmd/juggler/server/handlers"
)

// auditRec is the server's own account of one test's passage through the run
// queue. Both the queue and the result buffer are destructive reads — a pop
// removes the entry, a fetch removes the result — so once a work item goes
// missing, nothing downstream can say where it was lost. Counting each
// transition as it happens is the only record that survives, and it is kept
// server-side precisely because neither participant can be trusted to report a
// step it failed to complete.
type auditRec struct {
	queued, dispatched, resultPosted, resultServed         int
	queuedAt, dispatchedAt, resultPostedAt, resultServedAt time.Time
	// progress counts the lane's reports that the test is still making
	// progress (HandlePostProgress), and progressAt is when the last came.
	progress   int
	progressAt time.Time
}

// TestAudit is the wire form of an auditRec: counts, plus how long ago each
// transition last happened (the server's clock, so no cross-process clock
// reconciliation is needed). An age is negative when that transition never
// occurred.
type TestAudit struct {
	Name              string   `json:"name"`
	Queued            int      `json:"queued"`
	Dispatched        int      `json:"dispatched"`
	ResultPosted      int      `json:"resultPosted"`
	ResultServed      int      `json:"resultServed"`
	QueuedAgeMs       int64    `json:"queuedAgeMs"`
	DispatchedAgeMs   int64    `json:"dispatchedAgeMs"`
	ResultPostedAgeMs int64    `json:"resultPostedAgeMs"`
	ResultServedAgeMs int64    `json:"resultServedAgeMs"`
	Progress          int      `json:"progress"`
	ProgressAgeMs     int64    `json:"progressAgeMs"`
	PendingDepth      int      `json:"pendingDepth"`
	PendingNames      []string `json:"pendingNames"`
	BufferedResults   int      `json:"bufferedResults"`
}

// ageMs renders how long ago t happened, or -1 if it never did.
func ageMs(t time.Time) int64 {
	if t.IsZero() {
		return -1
	}
	return time.Since(t).Milliseconds()
}

// auditFor returns the audit record for a test name, creating it on first use.
// Actor-goroutine only.
func (s *actorState) auditFor(name string) *auditRec {
	if s.audit == nil {
		s.audit = map[string]*auditRec{}
	}
	rec, ok := s.audit[name]
	if !ok {
		rec = &auditRec{}
		s.audit[name] = rec
	}
	return rec
}

// HandleAudit reports what the server itself observed happen to one test:
// whether it was ever queued, ever handed to a lane, ever had a result posted,
// and whether that result was ever served. GET /api/test/audit?name=X.
//
// The Go harness reads this when a test times out. Together with the lane
// breadcrumbs it pins the loss to a specific hop: an entry that was never
// dispatched never reached a lane; one dispatched with no result was lost by
// the lane after it took it; and a result that was posted AND served, on a test
// the harness is still waiting for, was dropped by the harness's own read.
func (api *TestRunAPI) HandleAudit(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	out := TestAudit{Name: name, PendingNames: []string{}}
	api.withState(func(s *actorState) {
		if rec, ok := s.audit[name]; ok {
			out.Queued = rec.queued
			out.Dispatched = rec.dispatched
			out.ResultPosted = rec.resultPosted
			out.ResultServed = rec.resultServed
			out.QueuedAgeMs = ageMs(rec.queuedAt)
			out.DispatchedAgeMs = ageMs(rec.dispatchedAt)
			out.ResultPostedAgeMs = ageMs(rec.resultPostedAt)
			out.ResultServedAgeMs = ageMs(rec.resultServedAt)
			out.Progress = rec.progress
			out.ProgressAgeMs = ageMs(rec.progressAt)
		} else {
			out.QueuedAgeMs, out.DispatchedAgeMs = -1, -1
			out.ResultPostedAgeMs, out.ResultServedAgeMs = -1, -1
			out.ProgressAgeMs = -1
		}
		out.PendingDepth = len(s.pending)
		for _, e := range s.pending {
			out.PendingNames = append(out.PendingNames, e.Name)
		}
		out.BufferedResults = len(s.resultBufs[name])
	})
	handlers.WriteJSON(w, r, 0, out)
}

// HandlePostProgress records that a test is still making progress.
// POST /api/test/progress  body: {"name":"..."}
//
// The lane posts this whenever its own stall watchdog sees the test move (the
// runner's `_watchForStall`). The harness waits on the result for as long as
// these keep coming, so a test that is slow on a slow core is waited for and
// one that has stopped is not, with no wall-clock guess at how long a test may
// take.
func (api *TestRunAPI) HandlePostProgress(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	api.withState(func(s *actorState) {
		rec := s.auditFor(body.Name)
		rec.progress++
		rec.progressAt = time.Now()
	})
	w.WriteHeader(http.StatusNoContent)
}
