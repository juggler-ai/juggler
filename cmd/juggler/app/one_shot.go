//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/server"
	"juggler/internal/apipaths"
)

// `juggler run "<prompt>"` — one prompt, unattended, exiting with a status.
//
// The run is a client. It spawns a session child for its project — the
// per-project server a machine server spawns, but its own and shared with
// nobody — asks it over POST /api/one-shot to carry the prompt out, stops it,
// and reports. Nothing it starts outlives it: the child is stopped before the
// run exits, and dies with it (--exit-with-parent) if the run is killed.
//
// Nobody is watching: there is no window, no keyboard, and nothing to answer a
// question with. So the child configures the conversation so that nothing
// needs answering (see engine-one-shot.js), and the deadline is this side's.
//
// stdout carries the answer and nothing else, so a caller can pipe it. Every
// other word goes to stderr.

// Exit codes. A caller needs to tell these apart without reading prose, because
// the difference between "the model answered and was wrong" and "something
// wanted a human" is the difference between a result and a broken harness.
const (
	// exitRunCompleted: the turn ran to its end.
	exitRunCompleted = 0
	// exitRunFailed: the turn errored, never started, or was interrupted.
	exitRunFailed = 1
	// exitRunUsage: the command line was wrong. Matches `juggler serve`.
	exitRunUsage = 2
	// exitRunParked: a tool wanted a human, and there wasn't one.
	exitRunParked = 3
	// exitRunTimeout: the run outlived its deadline and was abandoned.
	exitRunTimeout = 4
	// exitRunForced: a second Ctrl-C, which exits without waiting for the
	// child to stop (it follows, as its parent has gone).
	exitRunForced = 130
)

// defaultRunTimeout bounds a run that names no deadline of its own. Long enough
// for real work on a real repository; short enough that a wedged run in a
// container is not still there tomorrow.
const defaultRunTimeout = 30 * time.Minute

// Why a run stopped before the child answered, as the causes of its context.
var (
	errRunInterrupted = errors.New("the run was interrupted")
	errRunTimedOut    = errors.New("the run timed out")
	errChildGone      = errors.New("the run's session stopped before the run finished")
)

// oneShotOptions is a parsed `juggler run` invocation.
type oneShotOptions struct {
	prompt   string
	project  string
	strategy string
	timeout  time.Duration
	asJSON   bool
	// name is the conversation's name, and therefore how its directory is found
	// again — including when the run times out and the engine never says which
	// conversation it made. It is stamped with the start time so consecutive
	// runs in one project stay apart.
	name string
}

// parseOneShotFlags parses `juggler run`'s own flag set. It returns nil options
// and an exit code when the command line is unusable or has already been
// answered (--help).
func parseOneShotFlags(args []string) (*oneShotOptions, int) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	project := fs.String("project", "", "Project folder to work in (defaults to the current directory)")
	strategy := fs.String("strategy", "yolo", "Strategy to run under")
	timeout := fs.Duration("timeout", defaultRunTimeout, "Give up if the run takes longer than this")
	asJSON := fs.Bool("json", false, "Print the whole outcome as JSON instead of just the answer")
	fs.Usage = func() {
		out := fs.Output()
		fmt.Fprintf(out, "Juggler — run one prompt to completion and exit.\n\nUsage: %s run [options] <prompt>\n\n"+
			"Reads the prompt from stdin when it is `-`. Options come before the prompt.\n\nOptions:\n",
			filepath.Base(os.Args[0]))
		fs.PrintDefaults()
		fmt.Fprintf(out, "\nExit codes: %d finished, %d failed, %d bad usage, %d a tool wanted a human, %d timed out.\n",
			exitRunCompleted, exitRunFailed, exitRunUsage, exitRunParked, exitRunTimeout)
	}
	if err := fs.Parse(args); err != nil {
		// ContinueOnError has already printed the error and the usage. Asking
		// for that usage is not a failure to report as one.
		if errors.Is(err, flag.ErrHelp) {
			return nil, exitRunCompleted
		}
		return nil, exitRunUsage
	}

	prompt := strings.Join(fs.Args(), " ")
	if strings.TrimSpace(prompt) == "-" {
		piped, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't read the prompt from stdin: %v\n", err)
			return nil, exitRunUsage
		}
		prompt = string(piped)
	}
	if strings.TrimSpace(prompt) == "" {
		fmt.Fprintln(os.Stderr, "There is no prompt to run.")
		fs.Usage()
		return nil, exitRunUsage
	}

	// A run with no --project means "here". Absolute either way, since the
	// child it spawns is told the folder by path.
	dir := *project
	if dir == "" {
		dir = "."
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Couldn't work out which folder to run in: %v\n", err)
		return nil, exitRunUsage
	}

	return &oneShotOptions{
		prompt:   prompt,
		project:  dir,
		strategy: *strategy,
		timeout:  *timeout,
		asJSON:   *asJSON,
		name:     "Run " + time.Now().Format("2006-01-02 15-04-05"),
	}, exitRunCompleted
}

// runOneShot is `juggler run`; args are the words after `run`. It returns the
// process exit code.
func runOneShot(args []string) int {
	opts, code := parseOneShotFlags(args)
	if opts == nil {
		return code
	}
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)
	return runOneShotWith(opts, sigs, os.Stdout, os.Stderr)
}

// runOneShotWith spawns the run's session child, runs the prompt on it, stops
// it, and reports. The first signal interrupts the run, which still stops the
// child and reports; a second exits at once.
func runOneShotWith(opts *oneShotOptions, sigs <-chan os.Signal, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-sigs:
		case <-finished:
			return
		}
		cancel(errRunInterrupted)
		select {
		case <-sigs:
			fmt.Fprintln(stderr, "Interrupted again: exiting without waiting for the run's session to stop.")
			os.Exit(exitRunForced)
		case <-finished:
		}
	}()

	child, err := machineserver.SpawnSessionChild(ctx, opts.project, "--exit-with-parent")
	if err != nil {
		why := spawnFailure(opts.project, err)
		if cause := context.Cause(ctx); cause != nil {
			why = cause.Error()
		}
		result := server.OneShotResult{Status: server.OneShotFailed, ErrorText: why}
		reportOneShot(stdout, stderr, opts, exitRunFailed, result)
		return exitRunFailed
	}

	runCtx, stopRun := context.WithCancelCause(ctx)
	go func() {
		select {
		case <-child.Exited():
			stopRun(errChildGone)
		case <-runCtx.Done():
		}
	}()
	code, result := runAgainstChild(runCtx, child.Addr(), child.Token(), opts)
	stopRun(nil)
	// Stopped before the report, so the conversation it names has been saved.
	child.Stop()
	reportOneShot(stdout, stderr, opts, code, result)
	return code
}

// runAgainstChild asks the session child at addr to run opts' prompt, and
// waits for its answer until ctx ends or the run's own deadline passes. Leaving
// lets go of the request, which is what tells the child to give the run up. It
// returns the exit code and whatever the child reported.
func runAgainstChild(ctx context.Context, addr, token string, opts *oneShotOptions) (int, server.OneShotResult) {
	failed := func(format string, args ...any) (int, server.OneShotResult) {
		return exitRunFailed, server.OneShotResult{Status: server.OneShotFailed, ErrorText: fmt.Sprintf(format, args...)}
	}
	// Why the wait ended early, when it did: the deadline, Ctrl-C, or the child.
	stopped := func(ctx context.Context, err error) (int, server.OneShotResult) {
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, errRunTimedOut):
			return exitRunTimeout, server.OneShotResult{
				Status:    server.OneShotTimedOut,
				ErrorText: fmt.Sprintf("the run did not finish within %v", opts.timeout),
			}
		case cause != nil:
			return failed("%v", cause)
		default:
			return failed("couldn't reach the run's session: %v", err)
		}
	}

	ctx, cancel := context.WithTimeoutCause(ctx, opts.timeout, errRunTimedOut)
	defer cancel()
	body, err := json.Marshal(server.OneShotRequest{
		Prompt:     opts.prompt,
		StrategyID: opts.strategy,
		Name:       opts.name,
		TimeoutMs:  opts.timeout.Milliseconds(),
	})
	if err != nil {
		return failed("%v", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+apipaths.OneShot, bytes.NewReader(body))
	if err != nil {
		return failed("%v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Juggler-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return stopped(ctx, err)
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(resp.Body)
	if err != nil {
		return stopped(ctx, err)
	}
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error string `json:"error"`
		}
		why := strings.TrimSpace(string(answer))
		if json.Unmarshal(answer, &refusal) == nil && refusal.Error != "" {
			why = refusal.Error
		}
		return failed("the run's session refused it (%d): %s", resp.StatusCode, why)
	}
	var result server.OneShotResult
	if err := json.Unmarshal(answer, &result); err != nil {
		return failed("the run's session answered something unreadable: %v", err)
	}
	switch result.Status {
	case server.OneShotCompleted:
		return exitRunCompleted, result
	case server.OneShotParked:
		return exitRunParked, result
	case server.OneShotFailed:
		return exitRunFailed, result
	default:
		// A status this side does not know — the timeout among them, which is
		// this side's to report — is a failure, reported as one, so the status
		// and the exit code still agree.
		if result.ErrorText == "" {
			result.ErrorText = fmt.Sprintf("the run's session answered with status %q", result.Status)
		} else {
			result.ErrorText = fmt.Sprintf("the run's session answered with status %q: %s", result.Status, result.ErrorText)
		}
		result.Status = server.OneShotFailed
		return exitRunFailed, result
	}
}

// spawnFailure explains a session child that could not be started for
// project. The usual reason is a project already open in a session elsewhere,
// whose lock the child cannot take; that is said in those words rather than as
// a pointer to the child's crash log.
func spawnFailure(project string, err error) string {
	if locked, _, lockErr := core.CheckProjectLocked(project); lockErr == nil && locked {
		return fmt.Sprintf("%s is open in another Juggler session, so this run can't use it; close it there, or wait for it to finish, then run again", project)
	}
	return err.Error()
}

// reportOneShot writes the outcome: the answer on stdout, the account of it on
// stderr. Where the conversation ended up is on stderr too, and on every exit
// path — a run that failed or timed out is the one whose trajectory somebody
// wants to read.
func reportOneShot(stdout, stderr io.Writer, opts *oneShotOptions, code int, result server.OneShotResult) {
	dir := conversationDir(opts.project, opts.name, result.ConversationID)

	if opts.asJSON {
		payload := map[string]any{
			"status":          result.Status,
			"exitCode":        code,
			"conversationId":  result.ConversationID,
			"conversationDir": dir,
			"turns":           result.Turns,
			"finalText":       result.FinalText,
			"parkedTool":      result.ParkedTool,
			"errorText":       result.ErrorText,
		}
		encoded, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "Couldn't render the outcome as JSON: %v\n", err)
			return
		}
		fmt.Fprintln(stdout, string(encoded))
		return
	}

	if result.FinalText != "" {
		fmt.Fprintln(stdout, result.FinalText)
	}
	switch code {
	case exitRunCompleted:
	case exitRunParked:
		if result.ParkedTool != "" {
			fmt.Fprintf(stderr, "Stopped: %s wanted an answer, and there is nobody here to give one.\n", result.ParkedTool)
		} else {
			fmt.Fprintln(stderr, "Stopped: a tool wanted an answer, and there is nobody here to give one.")
		}
	case exitRunTimeout:
		fmt.Fprintf(stderr, "%s\n", capitalise(result.ErrorText))
	default:
		fmt.Fprintf(stderr, "Couldn't finish the run: %s\n", result.ErrorText)
	}
	if dir != "" && code != exitRunCompleted {
		fmt.Fprintf(stderr, "The conversation is in %s\n", dir)
	}
}

// conversationDir locates the run's conversation folder, from which its
// transaction blobs — the only record of what actually went to the model — can
// be read. The id is the exact answer when the engine got far enough to report
// one; the name is the fallback, which is why each run's name is unique.
func conversationDir(project, name, id string) string {
	index, err := core.ScanConvDirs(filepath.Join(project, ".juggler"))
	if err != nil {
		return ""
	}
	if dir, ok := index.ByID[id]; ok && id != "" {
		return dir
	}
	for convID, convName := range index.Names {
		if convName == name {
			return index.ByID[convID]
		}
	}
	return ""
}

// capitalise upper-cases the first letter of a sentence assembled from a phrase
// written to read mid-sentence.
func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
