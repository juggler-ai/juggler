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
	"juggler/cmd/juggler/jobs"
)

// A network write's questions, asked of the user through its job.
//
// Git and ssh ask for a credential by running an askpass program; every network
// job runs them with gitaskpass.Env, which makes that program this server's own
// binary and points it at a listener of the job's own on loopback, with a token
// only that job's commands are given. The listener is the job's alone — not the
// server's router, so none of its routes or middleware see a question or an
// answer — and is closed when the job's write returns.
//
// A question that arrives on it is asked through the job (jobs.Hooks.Ask): put
// on the job as its Prompt, answered or declined through POST /api/jobs/answer,
// and the answer handed back here and on to the helper's stdout, which is git's.
// An automatic job (the fetch on first showing) asks nobody: its questions are
// declined at once. A notice — ssh telling the user something and ignoring the
// reply — is not asked at all.

const (
	gitAskpassBodyMax    = 64 << 10         // bytes of a question the listener reads
	gitAskpassHeaderWait = 10 * time.Second // for a helper to send its headers, which it does at once
)

// gitAskpass starts a job's askpass listener and returns the environment its
// git commands that talk to a remote are run with, and the function that
// closes the listener. Without a listener there is nobody to ask, and git's
// questions fail as unanswered.
func (s *Server) gitAskpass(auto bool, h jobs.Hooks) (env []string, stop func()) {
	exe := s.gitAskpassExe
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			log.Printf("[GitJobs] No askpass helper, so git's questions go unasked: %v", err)
			return nil, func() {}
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Printf("[GitJobs] No askpass listener, so git's questions go unasked: %v", err)
		return nil, func() {}
	}
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	token := hex.EncodeToString(secret)
	srv := &http.Server{Handler: serveGitAskpass(token, auto, h), ReadHeaderTimeout: gitAskpassHeaderWait}
	go func() { _ = srv.Serve(ln) }()
	return gitaskpass.Env(exe, ln.Addr().String(), token, os.Getenv), func() { _ = srv.Close() }
}

// serveGitAskpass is a job's listener's one route: a question from the helper
// carrying token, answered once there is an answer.
func serveGitAskpass(token string, auto bool, h jobs.Hooks) http.HandlerFunc {
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
		if subtle.ConstantTimeCompare([]byte(req.Token), []byte(token)) != 1 {
			http.Error(w, "no such job", http.StatusForbidden)
			return
		}
		var reply gitaskpass.Answer
		switch kind := gitaskpass.Classify(req.Prompt, req.SSHPrompt); {
		case auto:
			reply.Declined = true
		case kind == gitaskpass.KindNotice:
		default:
			answer, err := h.Ask(r.Context(), jobs.Question{Text: req.Prompt, Kind: string(kind)})
			if err != nil {
				// The helper is gone — git or ssh gave up, or was stopped.
				return
			}
			reply = gitaskpass.Answer{Answer: answer.Text, Declined: answer.Declined}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply)
	}
}
