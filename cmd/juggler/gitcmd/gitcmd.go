//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitcmd is the one way the server runs git: the reads behind the git
// views (gitview) and the writes the git client makes (gitops) build their
// commands here, and differ only in whether git may take its optional locks.
package gitcmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// Mode is what a command is allowed to do to the repository.
type Mode int

const (
	// Read is a command that must leave the repository as it found it.
	Read Mode = iota
	// Write is a command whose purpose is to change it.
	Write
)

// Observe, when set, is told of every command built here — its context and its
// arguments, without the flags Command adds — before it runs. It is how a test
// counts the processes a read costs, telling its own reads from a parallel
// test's by a value it put in the context. Nothing in the server sets it; a
// test sets it before any command is built (in TestMain) and leaves it set.
var Observe func(ctx context.Context, args []string)

// Command builds one git invocation with the flags every command here carries.
// core.quotePath=false stops git escaping non-ASCII paths into \303\251.
// diff.external is emptied for the same reason --no-ext-diff and --no-textconv
// are passed to the commands that accept them: working in a project is not
// consent to run commands its configuration names. --literal-pathspecs makes a
// path a path: without it a file the user named `*` or `:(glob)x` would be read
// as a pattern over the whole repository.
//
// A Read adds --no-optional-locks, which keeps it from taking index.lock and
// contending with the user's own git client mid-operation. It is not on its own
// enough to keep a read from writing, and this is why every comparison against a
// tree in gitview is asked of the plumbing diff-index rather than of diff.
// Porcelain diff refreshes the index and writes the refreshed stat information
// back whatever GIT_OPTIONAL_LOCKS says, so a user who only looked at a review
// would find their index rewritten underneath whatever their own git client was
// doing with it. diff-index answers the same question — the same records, byte
// for byte, given the rename and abbreviation options porcelain applies from
// configuration — and refreshes nothing.
//
// A Write takes the locks it needs, which is what serializes it against every
// other writer of the repository; see Exec for how one is run.
func Command(ctx context.Context, dir string, mode Mode, args ...string) *exec.Cmd {
	return command(ctx, dir, mode, true, args)
}

// command is Command, with --literal-pathspecs left off when literal is false
// (see Request.NoPathspecs).
func command(ctx context.Context, dir string, mode Mode, literal bool, args []string) *exec.Cmd {
	flags := []string{"-c", "core.quotePath=false", "-c", "diff.external="}
	if literal {
		flags = append([]string{"--literal-pathspecs"}, flags...)
	}
	if mode == Read {
		flags = append([]string{"--no-optional-locks"}, flags...)
	}
	if Observe != nil {
		Observe(ctx, args)
	}
	cmd := exec.CommandContext(ctx, "git", append(flags, args...)...)
	cmd.Dir = dir
	return cmd
}

// Output is what was read from a stream that may be larger than anything worth
// returning.
//
// Revision fingerprints every byte of the stream, including the ones past the
// ceiling that were dropped: a change is not a different change because the part
// that differs fell off the end, and an anchor that moved when nothing moved is
// worse than no anchor. Lines counts the whole stream for the same reason, so an
// untracked file can say how long it is without being held in memory.
type Output struct {
	Kept      []byte
	Lines     int
	Truncated bool
	Revision  string
}

// ReadBounded reads r to the end, keeping at most limit bytes of it and hashing
// all of it.
//
// What is kept ends at a line boundary whenever anything was dropped. Half a
// line parses as a real line holding half its text — a quieter wrong answer than
// a missing one — and cutting at a newline is also what keeps a multi-byte
// character whole, since no byte of one can be a newline.
func ReadBounded(ctx context.Context, r io.Reader, limit int) (Output, error) {
	var (
		out    Output
		kept   bytes.Buffer
		digest = sha256.New()
		buf    = make([]byte, 64*1024)
		total  int64
		last   byte
	)
	for {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		n, err := r.Read(buf)
		if chunk := buf[:n]; len(chunk) > 0 {
			digest.Write(chunk)
			out.Lines += bytes.Count(chunk, []byte{'\n'})
			last = chunk[len(chunk)-1]
			total += int64(len(chunk))
			if room := limit - kept.Len(); room > 0 {
				if room > len(chunk) {
					room = len(chunk)
				}
				kept.Write(chunk[:room])
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return out, err
		}
	}

	// A final line nobody terminated is still a line.
	if total > 0 && last != '\n' {
		out.Lines++
	}
	out.Revision = hex.EncodeToString(digest.Sum(nil))
	out.Kept = kept.Bytes()
	if total > int64(len(out.Kept)) {
		out.Truncated = true
		if i := bytes.LastIndexByte(out.Kept, '\n'); i >= 0 {
			out.Kept = out.Kept[:i+1]
		} else {
			out.Kept = nil
		}
	}
	return out, nil
}

// Capture runs one read and streams its output under a ceiling, so that nothing
// git can produce has to fit in memory first. Every failure is a failure: read
// as an empty diff, a command that could not run becomes the claim that a file
// did not change, which is the one thing a read must never say wrongly. The
// budget is the caller's, because how long one command may take is a property
// of what is being served: a status that wants an answer now, or a diff
// somebody is waiting to read.
func Capture(ctx context.Context, dir string, budget time.Duration, limit int, args ...string) (Output, error) {
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	cmd := Command(cctx, dir, Read, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Output{}, err
	}
	if err := cmd.Start(); err != nil {
		return Output{}, err
	}

	out, readErr := ReadBounded(cctx, stdout, limit)
	// The output is read to the end even when it is past the ceiling, so git is
	// never left blocked on a pipe nobody is draining.
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()

	switch {
	case cctx.Err() != nil:
		return Output{}, DeadlineError(ctx, cctx, budget)
	case readErr != nil:
		return Output{}, readErr
	case waitErr != nil:
		return Output{}, Failure(waitErr, stderr.String())
	}
	return out, nil
}

// DeadlineError says which clock ran out: the request's, meaning the caller is
// gone or the whole budget is spent, or this one command's.
func DeadlineError(ctx, cctx context.Context, budget time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("git took longer than %s", budget)
}

// Failure names what git complained about, since "exit status 128" names
// nothing.
func Failure(err error, stderr string) error {
	if line, _, _ := strings.Cut(strings.TrimSpace(stderr), "\n"); line != "" {
		return errors.New(line)
	}
	return err
}
