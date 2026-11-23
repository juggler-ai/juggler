//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"net/http"

	"juggler/cmd/juggler/jobs"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
)

// The server's jobs (package jobs): work a client started that runs on the
// server's time, of any kind — git's writes are one (git_jobs.go).
//
// A feature starts its kind's jobs through its own route, which answers with
// the job at once. Every change to a job is a job event of the jobs topic,
// keyed by the workspace the job was started under ("" is the project), so it
// reaches the viewers showing that workspace and no others. What every kind
// shares is read and steered through the routes here:
//
//	GET  /api/jobs?workspace=<id>[&id=<job>]          one job, or the workspace's, newest first
//	POST /api/jobs/cancel?workspace=<id>&id=<job>     cancel it; its end follows as an event
//	POST /api/jobs/answer?workspace=<id>&id=<job>     answer the question it waits on
//
// None of them resolves the workspace: a job belongs to the id it was started
// under, and stays readable after that workspace closes.
//
// Only viewers may subscribe: the engine shows no jobs.

// jobsTopicName is the jobs topic's name on the wire.
const jobsTopicName = "jobs"

// jobEventType is the jobs topic's one event.
const jobEventType = "job"

// jobEvent is a job as it now stands, sent on each change and at its end.
type jobEvent struct {
	Type      string   `json:"type"` // "job"
	Workspace string   `json:"workspace"`
	Job       jobs.Job `json:"job"`
}

// jobAnswer is one job: what the start, read, cancel and answer routes answer.
type jobAnswer struct {
	Job jobs.Job `json:"job"`
}

// jobsAnswer is a workspace's jobs, newest first.
type jobsAnswer struct {
	Jobs []jobs.Job `json:"jobs"`
}

// jobAnswerBody is the answer route's request: the question it answers, and the
// answer, or Decline. A confirm is answered "yes".
type jobAnswerBody struct {
	Prompt  string `json:"prompt"`
	Answer  string `json:"answer,omitempty"`
	Decline bool   `json:"decline,omitempty"`
}

// jobsTopic is the jobs topic as the hub registers it.
func (s *Server) jobsTopic() topic {
	return topic{name: jobsTopicName, roles: []ClientRole{ClientRoleViewer}}
}

// jobHub is the server's job hub, made on first use.
func (s *Server) jobHub() *jobs.Hub {
	s.jobsOnce.Do(func() {
		s.jobs = jobs.New(func(j jobs.Job) {
			s.Publish(jobsTopicName, j.Workspace, jobEvent{Type: jobEventType, Workspace: j.Workspace, Job: j})
		})
	})
	return s.jobs
}

// stopJobs cancels every running job and waits for each to end, for shutdown;
// a job asked for afterwards is refused. Safe to call twice.
func (s *Server) stopJobs() {
	s.jobHub().Stop()
}

// writeJob answers with one job, or 404 when there is none of that id.
func writeJob(w http.ResponseWriter, r *http.Request, job jobs.Job, err error, id string) {
	if errors.Is(err, jobs.ErrNoJob) {
		handlers.WriteMessageError(w, r, http.StatusNotFound, msg.New("No such job: {id}", "id", id))
		return
	}
	handlers.WriteJSON(w, r, 0, jobAnswer{Job: job})
}

// handleJobs handles GET /api/jobs?workspace=<id>[&id=<job>]: the one job
// named, or 404; or every job of the workspace still running or among the last
// to end, newest first.
func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if id := q.Get("id"); id != "" {
		job, found := s.jobHub().Get(q.Get("workspace"), id)
		var err error
		if !found {
			err = jobs.ErrNoJob
		}
		writeJob(w, r, job, err, id)
		return
	}
	handlers.WriteJSON(w, r, 0, jobsAnswer{Jobs: s.jobHub().List(q.Get("workspace"))})
}

// handleJobCancel handles POST /api/jobs/cancel?workspace=<id>&id=<job>: it
// cancels the job if it is still running and answers with the job as it
// stands; its end follows as an event. A job that has already ended is
// answered as it ended.
func (s *Server) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	job, err := s.jobHub().Cancel(q.Get("workspace"), q.Get("id"))
	writeJob(w, r, job, err, q.Get("id"))
}

// handleJobAnswer handles POST /api/jobs/answer?workspace=<id>&id=<job> with a
// jobAnswerBody: it answers, or declines, the question the job is waiting on,
// and answers with the job as it then stands. A question answered already —
// from another window, say — or no longer asked is a 409, and the answer goes
// nowhere. The answer is handed to the job's work and kept nowhere.
func (s *Server) handleJobAnswer(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	body, ok := handlers.DecodeJSON[jobAnswerBody](w, r)
	if !ok {
		return
	}
	job, err := s.jobHub().Answer(q.Get("workspace"), id, body.Prompt, jobs.Answer{Text: body.Answer, Declined: body.Decline})
	if errors.Is(err, jobs.ErrNotAsked) {
		handlers.WriteMessageError(w, r, http.StatusConflict, msg.New("That question has been answered already, or is no longer asked."))
		return
	}
	writeJob(w, r, job, err, id)
}
