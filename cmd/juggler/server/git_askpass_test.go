//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/cgi" //nolint:gosec // serves git http-backend to this test's own git; the advisory is for Go before 1.6.3
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/gitaskpass"
	"juggler/cmd/juggler/gitview/gitviewtest"
	"juggler/cmd/juggler/jobs"
	"juggler/cmd/juggler/workspace"
)

// A network write's questions — a username, a password — asked of the user
// through the job, against a real remote: git's smart HTTP, served by `git
// http-backend` behind basic auth, as a forge serves it. The helper git runs is
// this test binary (TestMain hands it to gitaskpass), so what answers is the
// same code the server binary runs, reached the same way.

const (
	askpassUser = "jules"
	// askpassSecret is the password: it must reach git, and nothing else.
	askpassSecret = "Sentinel-Pa55word-9d1f"
)

// httpRemote is a clone whose origin is a repository served over HTTP that
// wants askpassUser and askpassSecret, with one commit the clone has not
// fetched. It returns the clone and the commit.
func httpRemote(t *testing.T) (string, string) {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(gitviewtest.LendClocks(time.Minute, 5*time.Minute))

	src := t.TempDir()
	gitIn(t, src, "init", "-q")
	gitIn(t, src, "config", "user.email", "test@example.com")
	gitIn(t, src, "config", "user.name", "Juggler Test")
	gitIn(t, src, "commit", "-q", "--allow-empty", "-m", "first")
	served := t.TempDir()
	gitIn(t, src, "clone", "-q", "--bare", src, filepath.Join(served, "repo.git"))

	backend := &cgi.Handler{
		Path:       gitPath,
		Args:       []string{"http-backend"},
		Env:        []string{"GIT_PROJECT_ROOT=" + served, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"},
		InheritEnv: []string{"PATH", "HOME", "SYSTEMROOT", "TMPDIR"},
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != askpassUser || pass != askpassSecret {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			http.Error(w, "sign in", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(remote.Close)

	clone := t.TempDir()
	gitIn(t, clone, "init", "-q")
	gitIn(t, clone, "config", "credential.helper", "")
	gitIn(t, clone, "remote", "add", "origin", remote.URL+"/repo.git")

	gitIn(t, src, "commit", "-q", "--allow-empty", "-m", "second")
	gitIn(t, src, "push", "-q", filepath.Join(served, "repo.git"), "HEAD:refs/heads/main")
	return clone, gitIn(t, src, "rev-parse", "HEAD")
}

// askpassServer is a server whose project tree is dir, with a viewer watching
// it.
func askpassServer(t *testing.T, dir string) (*Server, *websocket.Conn) {
	t.Helper()
	ws, err := workspace.NewResolver(func() string { return dir }, nil, nil).Resolve("")
	if err != nil {
		t.Fatal(err)
	}
	s, ts := newGitJobServer(t, map[string]workspace.Workspace{"": ws})
	viewer, _ := dialViewerAs(t, ts, "")
	askForJobs(t, viewer, "")
	eventually(t, "the viewer's subscription taken in", func() bool { return jobSubscribersOf(s, "") == 1 })
	return s, viewer
}

// frameRecorder reads a viewer's frames, every one kept raw.
type frameRecorder struct {
	t    *testing.T
	conn *websocket.Conn
	raw  []string
}

// next reads frames until a job event about job id arrives, and returns it.
func (f *frameRecorder) next(id string) testGitJob {
	f.t.Helper()
	_ = f.conn.SetReadDeadline(time.Now().Add(time.Minute))
	for {
		_, data, err := f.conn.ReadMessage()
		if err != nil {
			f.t.Fatalf("no frame about %s reached the viewer: %v", id, err)
		}
		f.raw = append(f.raw, string(data))
		var frame struct {
			Type  frameType    `json:"type"`
			Event testJobEvent `json:"event"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Type == frameTopicEvent && frame.Event.Type == jobEventType && frame.Event.Job.ID == id {
			return frame.Event.Job
		}
	}
}

// prompt reads frames until job id asks a question, and returns it; the job
// ending first fails the test.
func (f *frameRecorder) prompt(id string) jobs.Question {
	f.t.Helper()
	for {
		job := f.next(id)
		if job.Prompt != nil {
			return *job.Prompt
		}
		if job.State != jobs.Running {
			f.t.Fatalf("job %s ended without asking anything: %+v", id, job)
		}
	}
}

// end reads frames until job id ends, failing if it asks anything on the way.
func (f *frameRecorder) end(id string) testGitJob {
	f.t.Helper()
	for {
		job := f.next(id)
		if job.Prompt != nil {
			f.t.Fatalf("job %s asked %q, want no question", id, job.Prompt.Text)
		}
		if job.State != jobs.Running {
			return job
		}
	}
}

// answerJob answers a job's question as the router would.
func answerJob(t *testing.T, s *Server, id string, body jobAnswerBody) *httptest.ResponseRecorder {
	t.Helper()
	data, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/answer?workspace=&id="+id, strings.NewReader(string(data)))
	s.handleJobAnswer(rec, req)
	return rec
}

// answered answers a question that must be taken.
func answered(t *testing.T, s *Server, id string, body jobAnswerBody) {
	t.Helper()
	if rec := answerJob(t, s, id, body); rec.Code != http.StatusOK {
		t.Fatalf("answer %+v = %d %s, want 200", body.Prompt, rec.Code, rec.Body.String())
	}
}

// signIn answers a fetch's two questions, username then password, and returns
// the job as it ended.
func signIn(t *testing.T, s *Server, frames *frameRecorder, id string) testGitJob {
	t.Helper()
	user := frames.prompt(id)
	if user.Kind != string(gitaskpass.KindText) || !strings.HasPrefix(user.Text, "Username for ") || user.ID == "" {
		t.Fatalf("first question = %+v, want the username, typed in the open", user)
	}
	answered(t, s, id, jobAnswerBody{Prompt: user.ID, Answer: askpassUser})
	if rec := answerJob(t, s, id, jobAnswerBody{Prompt: user.ID, Answer: "someone else"}); rec.Code != http.StatusConflict {
		t.Errorf("a second answer to the same question = %d %s, want 409: the first answer wins", rec.Code, rec.Body.String())
	}
	pass := frames.prompt(id)
	if pass.Kind != string(gitaskpass.KindSecret) || !strings.HasPrefix(pass.Text, "Password for ") || pass.ID == user.ID {
		t.Fatalf("second question = %+v, want the password, masked", pass)
	}
	answered(t, s, id, jobAnswerBody{Prompt: pass.ID, Answer: askpassSecret})
	return frames.end(id)
}

// noSecret fails the test if the password is anywhere a viewer could read it.
func noSecret(t *testing.T, s *Server, frames *frameRecorder, id string) {
	t.Helper()
	for _, raw := range frames.raw {
		if strings.Contains(raw, askpassSecret) {
			t.Errorf("the password reached a viewer in a frame: %s", raw)
		}
	}
	read := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace=&id="+id)
	if strings.Contains(read.Body.String(), askpassSecret) {
		t.Errorf("the password is in the job read back: %s", read.Body.String())
	}
	list := gitJobsRequest(t, s, http.MethodGet, "/api/jobs?workspace=")
	if strings.Contains(list.Body.String(), askpassSecret) {
		t.Errorf("the password is in the job list: %s", list.Body.String())
	}
}

func TestGitAskpass_AnsweredFetchCompletes(t *testing.T) {
	clone, want := httpRemote(t)
	s, viewer := askpassServer(t, clone)
	frames := &frameRecorder{t: t, conn: viewer}

	job := startGitJob(t, s, "", `{"kind":"fetch"}`)
	ended := signIn(t, s, frames, job.ID)
	if ended.State != jobs.Done {
		t.Fatalf("fetch = %+v, want it done once signed in", ended)
	}
	if got := gitIn(t, clone, "rev-parse", "origin/main"); got != want {
		t.Errorf("origin/main = %s, want %s", got, want)
	}
	noSecret(t, s, frames, job.ID)
}

func TestGitAskpass_DeclinedIsAnAuthFailure(t *testing.T) {
	clone, _ := httpRemote(t)
	s, viewer := askpassServer(t, clone)
	frames := &frameRecorder{t: t, conn: viewer}

	job := startGitJob(t, s, "", `{"kind":"fetch"}`)
	user := frames.prompt(job.ID)
	answered(t, s, job.ID, jobAnswerBody{Prompt: user.ID, Decline: true})
	ended := frames.end(job.ID)
	if ended.State != jobs.Failed || ended.Error == nil || ended.Error.Kind != "auth" {
		t.Errorf("declined fetch = %s %+v, want failed as auth", ended.State, ended.Error)
	}
}

// The fetch made on first showing asks nobody: its question is declined at
// once, and it fails quietly as an auth failure.
func TestGitAskpass_AutoFetchAsksNobody(t *testing.T) {
	clone, _ := httpRemote(t)
	s, viewer := askpassServer(t, clone)
	frames := &frameRecorder{t: t, conn: viewer}

	first := fetchOnShow(t, s, "", "")
	if first.Job == nil {
		t.Fatal("no fetch on first showing")
	}
	ended := frames.end(first.Job.ID)
	if ended.State != jobs.Failed || ended.Error == nil || ended.Error.Kind != "auth" {
		t.Errorf("auto fetch = %s %+v, want failed as auth", ended.State, ended.Error)
	}
}

// Cancelling a job whose question is waiting ends it, takes the question back
// from every viewer, and leaves nothing to answer.
func TestGitAskpass_CancelWithAQuestionWaiting(t *testing.T) {
	clone, _ := httpRemote(t)
	s, viewer := askpassServer(t, clone)
	frames := &frameRecorder{t: t, conn: viewer}

	job := startGitJob(t, s, "", `{"kind":"fetch"}`)
	asked := frames.prompt(job.ID)
	if rec := gitJobsRequest(t, s, http.MethodPost, "/api/jobs/cancel?workspace=&id="+job.ID); rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s", rec.Code, rec.Body.String())
	}
	ended := frames.end(job.ID)
	if ended.State != jobs.Cancelled || ended.Prompt != nil {
		t.Errorf("cancelled job = %s with prompt %+v, want cancelled with none", ended.State, ended.Prompt)
	}
	if rec := answerJob(t, s, job.ID, jobAnswerBody{Prompt: asked.ID, Answer: askpassSecret}); rec.Code != http.StatusConflict {
		t.Errorf("answering the cancelled job's question = %d %s, want 409", rec.Code, rec.Body.String())
	}
}
