//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"juggler/cmd/juggler/gitaskpass"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
)

// A network write's questions, asked of the user through its job.
//
// Git and ssh ask for a credential by running an askpass program; every network
// job runs them with gitaskpass.Env, which makes that program this server's own
// binary and points it at a listener of the hub's on loopback, with a token
// naming the job. The listener is the hub's alone — not the server's router, so
// none of its routes or middleware see a question or an answer — and is started
// the first time a network job runs.
//
// A question arrives on the listener and is put on its job as Prompt, which the
// job's next frame carries to every viewer watching its workspace; its handler
// waits. POST /api/git/jobs/answer gives the answer, or declines; the first one
// to arrive is the one taken, and a later one is told the question is gone. The
// answer goes from that request to the waiting handler, and from there to the
// helper's stdout, which is git's: it is never on the job, so no frame, read or
// log can hold it.
//
// A question is also over — declined — when its job is cancelled or ends, when
// the helper goes away, and at once for an automatic job (the fetch on first
// showing), which asks nobody anything.

const (
	gitAskpassBodyMax    = 64 << 10         // bytes of a question the listener reads
	gitAskpassHeaderWait = 10 * time.Second // for a helper to send its headers, which it does at once
)

// gitJobPrompt is a question a job is waiting on: Kind says what the viewer
// shows for it (gitaskpass.Kind: "text", "secret" or "confirm").
type gitJobPrompt struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Kind string `json:"kind"`
}

// gitJobAnswerBody is the answer route's request: the question it answers, and
// the answer, or Decline. A confirm is answered "yes".
type gitJobAnswerBody struct {
	Prompt  string `json:"prompt"`
	Answer  string `json:"answer,omitempty"`
	Decline bool   `json:"decline,omitempty"`
}

// gitAsk is one question while it waits, owned by the hub's goroutine. Reply is
// sent to once, by settle.
type gitAsk struct {
	run    *gitJobRun
	prompt gitJobPrompt
	reply  chan gitaskpass.Answer
}

// gitAskpassListener is the hub's askpass listener, once started.
type gitAskpassListener struct {
	addr string
	srv  *http.Server
}

// askpassEnv starts the listener if it has not been, gives run a token, and
// returns the environment its git commands that talk to a remote are run with.
// On the hub's goroutine. Without a listener there is nobody to ask, and git's
// questions fail as unanswered.
func (h *gitJobHub) askpassEnv(s *Server, run *gitJobRun) []string {
	if h.askpass == nil {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Printf("[GitJobs] No askpass listener, so git's questions go unasked: %v", err)
			return nil
		}
		srv := &http.Server{Handler: h.serveAskpass(s), ReadHeaderTimeout: gitAskpassHeaderWait}
		go func() { _ = srv.Serve(ln) }()
		h.askpass = &gitAskpassListener{addr: ln.Addr().String(), srv: srv}
	}
	exe := s.gitAskpassExe
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			log.Printf("[GitJobs] No askpass helper, so git's questions go unasked: %v", err)
			return nil
		}
	}
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	run.token = hex.EncodeToString(secret)
	h.tokens[run.token] = run
	return gitaskpass.Env(exe, h.askpass.addr, run.token, os.Getenv)
}

// tokenRun is the running job a token names, compared in constant time; nil
// for any other token. On the hub's goroutine.
func (h *gitJobHub) tokenRun(token string) *gitJobRun {
	var found *gitJobRun
	for t, run := range h.tokens {
		if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
			found = run
		}
	}
	return found
}

// serveAskpass is the listener's one route: a question from the helper,
// answered once there is an answer.
func (h *gitJobHub) serveAskpass(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != gitaskpass.Path {
			http.NotFound(w, r)
			return
		}
		var req gitaskpass.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, gitAskpassBodyMax)).Decode(&req); err != nil {
			http.Error(w, "not a question", http.StatusBadRequest)
			return
		}
		kind := gitaskpass.Classify(req.Prompt, req.SSHPrompt)
		known := false
		var ask *gitAsk
		var now gitaskpass.Answer
		h.do(func() {
			run := h.tokenRun(req.Token)
			if run == nil || run.job.State != gitJobRunning {
				return
			}
			known = true
			switch {
			case run.job.Auto:
				now.Declined = true
				return
			case kind == gitaskpass.KindNotice:
				// ssh telling the user something and ignoring the reply.
				return
			}
			if run.ask != nil {
				// Git asks one thing at a time; an older question still
				// open is one its asker has given up on.
				h.settle(run.ask, gitaskpass.Answer{Declined: true})
			}
			ask = &gitAsk{
				run:    run,
				prompt: gitJobPrompt{ID: "ask_" + rand.Text(), Text: req.Prompt, Kind: string(kind)},
				reply:  make(chan gitaskpass.Answer, 1),
			}
			run.ask = ask
			h.asks[ask.prompt.ID] = ask
			p := ask.prompt
			run.job.Prompt = &p
			h.publish(s, run)
		})
		if !known {
			http.Error(w, "no such job", http.StatusForbidden)
			return
		}
		if ask != nil {
			select {
			case now = <-ask.reply:
			case <-r.Context().Done():
				// The helper is gone — git or ssh gave up, or was stopped.
				h.do(func() {
					if h.settle(ask, gitaskpass.Answer{Declined: true}) && ask.run.job.State == gitJobRunning {
						h.publish(s, ask.run)
					}
				})
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(now)
	}
}

// settle ends a question with answer, if it is still open, and reports whether
// it was. The job's frame is the caller's to send. On the hub's goroutine.
func (h *gitJobHub) settle(ask *gitAsk, answer gitaskpass.Answer) bool {
	if h.asks[ask.prompt.ID] != ask {
		return false
	}
	delete(h.asks, ask.prompt.ID)
	if ask.run.ask == ask {
		ask.run.ask = nil
		ask.run.job.Prompt = nil
	}
	ask.reply <- answer
	return true
}

// forgetAskpass declines run's open question and retires its token, for a job
// that is ending or cancelled. On the hub's goroutine.
func (h *gitJobHub) forgetAskpass(run *gitJobRun, retire bool) {
	if run.ask != nil {
		h.settle(run.ask, gitaskpass.Answer{Declined: true})
	}
	if retire && run.token != "" {
		delete(h.tokens, run.token)
	}
}

// stopAskpass closes the listener, once no job runs. On the hub's goroutine;
// the closing is not.
func (h *gitJobHub) stopAskpass() {
	if h.askpass == nil {
		return
	}
	srv := h.askpass.srv
	h.askpass = nil
	go func() { _ = srv.Close() }()
}

// handleGitJobAnswer handles POST /api/git/jobs/answer?workspace=<id>&id=<job>
// with a gitJobAnswerBody: it answers, or declines, the question the job is
// waiting on, and answers with the job as it then stands. A question answered
// already — from another window, say — or no longer asked is a 409, and the
// answer goes nowhere.
func (s *Server) handleGitJobAnswer(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	body, ok := handlers.DecodeJSON[gitJobAnswerBody](w, r)
	if !ok {
		return
	}
	h := s.gitJobsHub()
	var job gitJob
	found, taken := false, false
	h.do(func() {
		run := h.find(q.Get("workspace"), id)
		if run == nil {
			return
		}
		found = true
		if ask := h.asks[body.Prompt]; ask != nil && ask.run == run {
			taken = h.settle(ask, gitaskpass.Answer{Answer: body.Answer, Declined: body.Decline})
			h.publish(s, run)
		}
		job = run.snapshot()
	})
	switch {
	case !found:
		writeGitJob(w, r, job, false, id)
	case !taken:
		handlers.WriteMessageError(w, r, http.StatusConflict, msg.New("That question has been answered already, or is no longer asked."))
	default:
		handlers.WriteJSON(w, r, 0, gitJobAnswer{Job: job})
	}
}
