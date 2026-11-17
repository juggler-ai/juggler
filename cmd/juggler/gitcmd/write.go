//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitcmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"juggler/cmd/juggler/childcontain"
)

// Bounds on what a write keeps of its own output. Stdout is what a plumbing
// command answers with — an object id, a list — and is kept whole up to a
// ceiling no answer of that kind reaches; the combined output is what a person
// reads (a hook's complaint) and only its end is worth keeping.
const (
	writeStdoutLimit = 8 << 20
	writeOutputLimit = 256 << 10
)

// writeGrace is how long a cancelled write is given to act on its interrupt
// and clean up after itself before it and everything it started are killed.
// It is not a clock on the write: nothing bounds a write that has not been
// cancelled, because a commit hook may legitimately take minutes.
var writeGrace = 10 * time.Second

// strippedEnv is the git environment a write must not inherit. A server
// started from inside a git hook or a `git rebase --exec` carries these, and
// every write would then act on that repository rather than the one it names.
var strippedEnv = []string{
	"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
}

// Request is one git command that changes the repository.
type Request struct {
	Dir   string
	Args  []string
	Stdin []byte

	// Env is added to the inherited environment, KEY=VALUE, and wins over it.
	Env []string

	// OnOutput is handed every byte of stdout and stderr as it arrives, in the
	// order it arrived, from one goroutine. Nil for nobody.
	OnOutput func([]byte)

	// NoPathspecs runs the command without --literal-pathspecs, for a command
	// given no pathspec that the flag would make misbehave. `stash push -u`
	// is one: under the flag it saves the untracked files into the stash and
	// then leaves them in the working tree, so the stash and the tree both
	// hold them.
	NoPathspecs bool
}

// Result is what a write said.
type Result struct {
	Stdout []byte // stdout, whole up to its ceiling
	Output []byte // stdout and stderr interleaved as they arrived, its last part
}

// Error is a write git refused or could not finish. Output is everything it
// said, stdout and stderr interleaved — a hook's complaint is the reason, and
// git sends a hook's stdout to stderr anyway.
type Error struct {
	Args      []string
	Code      int
	Stderr    string
	Output    string
	Cancelled bool
}

// Error names what git complained about first, since "exit status 1" names
// nothing.
func (e *Error) Error() string {
	if e.Cancelled {
		return "cancelled"
	}
	for _, text := range []string{e.Stderr, e.Output} {
		if line, _, _ := strings.Cut(strings.TrimSpace(text), "\n"); line != "" {
			return line
		}
	}
	verb := ""
	if len(e.Args) > 0 {
		verb = " " + e.Args[0]
	}
	return fmt.Sprintf("git%s exited with status %d", verb, e.Code)
}

// stream says which of a write's two outputs a chunk came from.
type stream int

const (
	streamStdout stream = iota
	streamStderr
)

// chunk is one write to one of a command's outputs.
type chunk struct {
	from stream
	data []byte
}

// streamWriter hands each write to the collector, copied, since os/exec reuses
// its buffer.
type streamWriter struct {
	from stream
	out  chan<- chunk
}

func (w streamWriter) Write(p []byte) (int, error) {
	w.out <- chunk{from: w.from, data: append([]byte(nil), p...)}
	return len(p), nil
}

// Exec runs one write to the end.
//
// Cancelling ctx interrupts git rather than killing it — SIGINT to its whole
// process group, hooks included — because git removes its lock files when it
// is interrupted, and a killed git leaves index.lock behind for the user to
// find. Only a write that is still running writeGrace later is killed. On a
// platform with no interrupt to send, it is killed at once.
func Exec(ctx context.Context, req Request) (Result, error) {
	cmd := command(ctx, req.Dir, Write, !req.NoPathspecs, req.Args)
	cmd.Env = writeEnv(req.Env)
	if req.Stdin != nil {
		cmd.Stdin = bytes.NewReader(req.Stdin)
	}
	cmd.Cancel = func() error {
		if err := childcontain.Interrupt(cmd); err == nil {
			return nil
		}
		return cmd.Process.Kill()
	}
	cmd.WaitDelay = writeGrace

	chunks := make(chan chunk, 64)
	cmd.Stdout = streamWriter{from: streamStdout, out: chunks}
	cmd.Stderr = streamWriter{from: streamStderr, out: chunks}

	var stdout, stderr, output tailBuffer
	collected := make(chan struct{})
	go func() {
		defer close(collected)
		for c := range chunks {
			if c.from == streamStdout {
				stdout.keepHead(c.data, writeStdoutLimit)
			} else {
				stderr.keepTail(c.data, writeOutputLimit)
			}
			output.keepTail(c.data, writeOutputLimit)
			if req.OnOutput != nil {
				req.OnOutput(c.data)
			}
		}
	}()

	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		close(chunks)
		<-collected
		return Result{}, err
	}
	child, _ := childcontain.Adopt(cmd)
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		// Whatever the interrupt did not stop is stopped now.
		_ = child.Terminate()
	}
	child.Cleanup()
	close(chunks)
	<-collected

	result := Result{Stdout: stdout.bytes(), Output: output.bytes()}
	if waitErr == nil {
		return result, nil
	}
	failure := &Error{
		Args:      req.Args,
		Code:      -1,
		Stderr:    string(stderr.bytes()),
		Output:    string(result.Output),
		Cancelled: ctx.Err() != nil,
	}
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		failure.Code = exit.ExitCode()
	} else if !failure.Cancelled && failure.Stderr == "" {
		return result, waitErr
	}
	return result, failure
}

// writeEnv is the inherited environment without the variables that would point
// a write at another repository, with git told never to wait on a terminal or
// an editor nobody can see, and then the caller's own.
func writeEnv(extra []string) []string {
	env := make([]string, 0, len(os.Environ())+len(extra)+2)
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if !isStripped(name) {
			env = append(env, kv)
		}
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=:")
	return append(env, extra...)
}

func isStripped(name string) bool {
	for _, s := range strippedEnv {
		if strings.EqualFold(name, s) {
			return true
		}
	}
	return false
}

// tailBuffer keeps either the first or the last part of a stream.
type tailBuffer struct{ buf []byte }

func (b *tailBuffer) keepHead(p []byte, limit int) {
	if room := limit - len(b.buf); room > 0 {
		b.buf = append(b.buf, p[:min(room, len(p))]...)
	}
}

func (b *tailBuffer) keepTail(p []byte, limit int) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - limit; over > 0 {
		b.buf = append(b.buf[:0:0], b.buf[over:]...)
	}
}

func (b *tailBuffer) bytes() []byte { return b.buf }
