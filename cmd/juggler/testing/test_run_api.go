//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"juggler/cmd/juggler/server/handlers"
)

// HandleJSTrace logs ad-hoc trace messages from iframes to stderr when
// JUGGLER_TEST_TRACE is set. No-op otherwise.
func (api *TestRunAPI) HandleJSTrace(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("JUGGLER_TEST_TRACE") == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	body, _ := io.ReadAll(r.Body)
	fmt.Fprintf(os.Stderr, "[TEST_TRACE] JS %s\n", string(body))
	w.WriteHeader(http.StatusNoContent)
}

// testEntry is a single queued test run request.
type testEntry struct {
	Name        string `json:"name"`
	ProjectPath string `json:"projectPath"`
	// Optional fields for benchmark task mode (used by juggler-test).
	TaskID   string `json:"taskId,omitempty"`
	Model    string `json:"model,omitempty"`
	Provider string `json:"provider,omitempty"`
}

// testResult is what the browser posts when a test finishes.
type testResult struct {
	Name    string   `json:"name"`
	Passed  bool     `json:"passed"`
	Details string   `json:"details"`
	Errors  []string `json:"errors"`
	// BudgetWarning is a unit suite's account of its own time when it crossed
	// the line past which a suite is split (suiteBudgetWarning in
	// integration-test-executor.js), empty otherwise. Carried, never judged here.
	BudgetWarning string `json:"budgetWarning,omitempty"`
	// PostedUnder is the path prefix the result's POST arrived under: the
	// X-Forwarded-Prefix a reverse proxy set, "" for a lane that reached this
	// server directly. Recorded by the server, never taken from the body, so
	// a harness can tell which route its lane was served through.
	PostedUnder string `json:"postedUnder,omitempty"`
}

// TestRunAPI coordinates test execution between Go and the browser. It is
// multi-flight: any number of tests can be in flight at once, each routed to
// the matching POST /api/test/result by name. This lets the Go side fan a
// pool of N parallel TestBrowser sub-tests out across N test consumers
// (subprocesses or iframes inside one subprocess) that all race for the same
// /api/test/pending queue.
//
// All state is owned by a single actor goroutine; HTTP handlers exchange
// closures with it over opsCh (no mutexes — the actor is the serialiser).
type TestRunAPI struct {
	opsCh   chan func(*actorState)
	namesCh chan testNames // capacity 1: test names list waiting to be consumed
}

// testNames is the discovered test inventory: every test name plus the subset
// that must run with no sibling lane in flight (see listExclusiveTests in the
// JS test executor for the two reasons a test qualifies).
type testNames struct {
	Names     []string `json:"names"`
	Exclusive []string `json:"exclusive"`
}

// actorState lives entirely inside the actor goroutine. Closures from opsCh
// receive a pointer to it.
type actorState struct {
	pending    []testEntry             // FIFO of queued tests
	resultBufs map[string][]testResult // delivered results not yet picked up
	audit      map[string]*auditRec    // per-test queue/result transition counts
}

// NewTestRunAPI creates a ready-to-use TestRunAPI.
func NewTestRunAPI() *TestRunAPI {
	api := &TestRunAPI{
		opsCh:   make(chan func(*actorState), 128),
		namesCh: make(chan testNames, 1),
	}
	go api.run()
	return api
}

func (api *TestRunAPI) run() {
	st := &actorState{
		resultBufs: map[string][]testResult{},
	}
	for op := range api.opsCh {
		op(st)
	}
}

// withState submits fn to the actor goroutine and waits for it to finish.
func (api *TestRunAPI) withState(fn func(*actorState)) {
	done := make(chan struct{})
	api.opsCh <- func(s *actorState) {
		fn(s)
		close(done)
	}
	<-done
}

// HandleRun enqueues a test (or the special "__list__" sentinel).
// POST /api/test/run  body: {"name":"...", "projectPath":"..."}
func (api *TestRunAPI) HandleRun(w http.ResponseWriter, r *http.Request) {
	var entry testEntry
	if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	api.withState(func(s *actorState) {
		s.pending = append(s.pending, entry)
		rec := s.auditFor(entry.Name)
		rec.queued++
		rec.queuedAt = time.Now()
	})
	w.WriteHeader(http.StatusNoContent)
}

// HoldsSession reports whether any queued test is unfinished: still in the
// queue, or taken by a lane whose result its harness has not yet read. Each
// name's audit counts every queueing and every served result, so a name queued
// more often than served is one the harness is still waiting on. The list
// sentinel is answered with names rather than a result, so it holds only while
// it is queued.
func (api *TestRunAPI) HoldsSession() bool {
	held := false
	api.withState(func(s *actorState) {
		if len(s.pending) > 0 {
			held = true
			return
		}
		for name, rec := range s.audit {
			if name != "__list__" && rec.resultServed < rec.queued {
				held = true
				return
			}
		}
	})
	return held
}

// HandlePending returns the next queued test, or 204 if none is waiting.
// GET /api/test/pending
//
// The read is destructive: this response is the only copy of the work item, so
// a consumer that fails to receive it intact destroys the test run rather than
// deferring it, and cannot re-queue what it never managed to read. The queue
// audit (HandleAudit) records the dispatch so that loss is at least visible
// afterwards.
func (api *TestRunAPI) HandlePending(w http.ResponseWriter, r *http.Request) {
	var (
		entry testEntry
		ok    bool
	)
	api.withState(func(s *actorState) {
		if len(s.pending) > 0 {
			entry = s.pending[0]
			s.pending = s.pending[1:]
			ok = true
			rec := s.auditFor(entry.Name)
			rec.dispatched++
			rec.dispatchedAt = time.Now()
		}
	})
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	handlers.WriteJSON(w, r, 0, entry)
}

// HandlePostResult receives the test result from the browser.
// POST /api/test/result  body: {"name":"...", "passed":bool, ...}
// The result is buffered by name; GET /api/test/result?name=X picks it up.
func (api *TestRunAPI) HandlePostResult(w http.ResponseWriter, r *http.Request) {
	var result testResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	result.PostedUnder = r.Header.Get("X-Forwarded-Prefix")
	api.withState(func(s *actorState) {
		s.resultBufs[result.Name] = append(s.resultBufs[result.Name], result)
		rec := s.auditFor(result.Name)
		rec.resultPosted++
		rec.resultPostedAt = time.Now()
	})
	w.WriteHeader(http.StatusNoContent)
}

// HandleGetResult returns the stored result for a test name, or 204 if not
// ready yet. If ?name= is omitted, returns ANY buffered result (legacy
// callers that ran one test at a time per pool slot).
// GET /api/test/result[?name=X]
func (api *TestRunAPI) HandleGetResult(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	var (
		result testResult
		ok     bool
	)
	api.withState(func(s *actorState) {
		if name != "" {
			if bufs := s.resultBufs[name]; len(bufs) > 0 {
				result = bufs[0]
				s.resultBufs[name] = bufs[1:]
				ok = true
				rec := s.auditFor(name)
				rec.resultServed++
				rec.resultServedAt = time.Now()
			}
			return
		}
		for n, bufs := range s.resultBufs {
			if len(bufs) > 0 {
				result = bufs[0]
				s.resultBufs[n] = bufs[1:]
				ok = true
				rec := s.auditFor(n)
				rec.resultServed++
				rec.resultServedAt = time.Now()
				return
			}
		}
	})
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	handlers.WriteJSON(w, r, 0, result)
}

// HandlePostNames receives the discovered test names from the browser.
// POST /api/test/names  body: {"names":["integration:foo",...],"exclusive":[...]}
func (api *TestRunAPI) HandlePostNames(w http.ResponseWriter, r *http.Request) {
	var payload testNames
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	select {
	case <-api.namesCh:
	default:
	}
	api.namesCh <- payload
	w.WriteHeader(http.StatusNoContent)
}

// HandleGetNames returns the stored names list, or 204 if not yet available.
// GET /api/test/names
func (api *TestRunAPI) HandleGetNames(w http.ResponseWriter, r *http.Request) {
	select {
	case names := <-api.namesCh:
		handlers.WriteJSON(w, r, 0, names)
		api.namesCh <- names
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// TestService combines the task/fixture API and the run/result API into
// a single object that RegisterTestRoutes can accept.
type TestService struct {
	*TestAPI
	*TestRunAPI
}

// NewTestService creates a TestService for the given juggler project root.
// session is the live SessionManager (passed in so future test helpers can
// reach it through the service); the test API currently uses it only for
// the optional per-test bulldoze hook.
func NewTestService(projectRoot string, session SessionResetter) *TestService {
	return &TestService{
		TestAPI:    NewTestAPIWithSession(projectRoot, session),
		TestRunAPI: NewTestRunAPI(),
	}
}
