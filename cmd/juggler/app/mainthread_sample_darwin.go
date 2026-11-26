//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package app

// Native thread sampling for a wedged main thread.
//
// The main-thread watchdog can tell that the main queue stopped draining, but
// not why: the Go side is parked in cgo and a Go traceback shows only that. The
// frames that would name the culprit are Objective-C and C++ ones inside
// AppKit, WebKit and CoreVideo, and the only way to read them is to sample the
// process from outside. macOS ships exactly that tool — /usr/bin/sample, which
// needs no privileges to examine a process owned by the same user, and labels
// the thread we care about "DispatchQueue_1: com.apple.main-thread".
//
// Sampling is fired from the stall WARNING, not the wedge: by the time the
// watchdog gives up the process has seconds to live, and the sample must be on
// disk before the image is replaced.

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"
)

const (
	// samplePath is the macOS sampler. Absolute, because an app-spawned server
	// inherits whatever PATH the launcher had (see path_repair.go) and this
	// runs at the one moment nothing else can be re-tried.
	samplePath = "/usr/bin/sample"

	// stallSampleDuration is how long sample watches the process. A wedged
	// thread is not moving, so this only has to be long enough to prove that —
	// and short enough to finish inside the gap between the stall warning and
	// the re-exec.
	stallSampleDuration = 2 * time.Second

	// stallSampleIntervalMS is the gap between stack captures. sample defaults
	// to 1ms, which buys nothing against threads that are standing still and
	// spends CPU on a machine that is already in trouble.
	stallSampleIntervalMS = 10

	// stallSampleGrace is how much longer than its own duration a sample may
	// take before the wedge path stops waiting for it. Symbolication, not
	// sampling, dominates the runtime, and it is running against a struggling
	// machine — but the freeze the user is sitting through is real, so the wait
	// is bounded.
	stallSampleGrace = 4 * time.Second
)

// stallSample is a sample run started against this process, and against the
// peer processes sampled with it.
type stallSample struct {
	path string
	// peers are the samples of the peer processes that started, in the
	// order they were given.
	peers  []string
	done   <-chan struct{}
	cancel context.CancelFunc
}

// stallPeers names the WebKit processes behind this process's pages, which
// a stall sample covers as well as this one: a main thread wedged in WebKit's
// display refresh waits on a rendering update a web process has to commit, and
// only that process's stacks say why it doesn't. The main thread is the one
// thing that cannot be asked for them during a stall, so a test-capable build
// keeps this up to date while the thread is healthy (keepStallPeers). Nothing
// sets it in a release build, which asks no WebKit SPI.
var stallPeers atomic.Pointer[[]int]

// currentStallPeers is the last list of peers recorded, or none.
func currentStallPeers() []int {
	if p := stallPeers.Load(); p != nil {
		return *p
	}
	return nil
}

// captureStallSample starts sampling this process and each of peers in the
// background, writing beside logPath, and returns a handle to wait on. It
// returns nil — a valid handle to settle — when there is nowhere to write, or
// when this process's own sampler could not start, so a caller never has to
// ask whether sampling happened. A peer whose sampler cannot start is logged
// and left out.
//
// It does not block: the watchdog loop that calls this must keep ticking, both
// to notice the main thread coming back and to reach its own deadline.
func captureStallSample(logPath string, pid int, now time.Time, peers ...int) *stallSample {
	path := stallSamplePath(logPath, now)
	if path == "" {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	var running sync.WaitGroup
	start := func(pid int, path, what string) bool {
		cmd := exec.CommandContext(ctx, samplePath,
			strconv.Itoa(pid),
			strconv.Itoa(int(stallSampleDuration/time.Second)),
			strconv.Itoa(stallSampleIntervalMS),
			"-file", path,
		)
		if err := cmd.Start(); err != nil {
			jlog.Error("Couldn't sample %s: %v", what, err)
			return false
		}
		jlog.Info("Sampling %s for %v → %s", what, stallSampleDuration, path)
		running.Go(func() {
			if err := cmd.Wait(); err != nil {
				// A cancelled sample is settle's own doing and already reported.
				if ctx.Err() == nil {
					jlog.Error("Sampling %s failed: %v", what, err)
				}
				return
			}
			jlog.Info("Sample of %s written: %s", what, path)
		})
		return true
	}
	if !start(pid, path, "the stalled main thread") {
		cancel()
		return nil
	}
	s := &stallSample{path: path, cancel: cancel}
	for _, peer := range peers {
		peerPath := stallPeerSamplePath(path, peer)
		if start(peer, peerPath, fmt.Sprintf("WebKit process %d", peer)) {
			s.peers = append(s.peers, peerPath)
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Releases the context once every sampler is reaped, whether it
		// finished on its own or settle killed it.
		defer cancel()
		running.Wait()
	}()
	s.done = done
	return s
}

// stallPeerSamplePath is where the sample of peer goes, beside path, this
// process's own sample of the same stall.
func stallPeerSamplePath(path string, peer int) string {
	return strings.TrimSuffix(path, ".sample.log") + "-pid" + strconv.Itoa(peer) + ".sample.log"
}

// settle waits up to budget for the sample to be written, and reports whether
// it was.
//
// On expiry it KILLS the sampler. The re-exec that follows keeps this pid, so a
// sample still running would go on sampling the same number — by then a
// brand-new server — and write a file that blends the wedge with its
// replacement. A missing sample sends us looking again; a plausible-looking
// wrong one sends us looking in the wrong place.
//
// A nil *stallSample settles immediately: nothing was started, so there is
// nothing to wait for.
func (s *stallSample) settle(budget time.Duration) bool {
	if s == nil {
		return true
	}
	select {
	case <-s.done:
		return true
	case <-time.After(budget):
		s.cancel()
		return false
	}
}

// finish waits for the sampler to exit by itself, however long its
// symbolication takes, and reports that the sample was written. It is for a
// wedge that ends in exit rather than re-exec: no replacement server will take
// this pid, so the reason settle kills the sampler does not apply, and on a
// saturated machine — where wedges are seen — symbolication outlasts any grace
// worth giving a user. The sampler is a child doing a fixed amount of work, so
// its exit is the bound. A nil *stallSample finishes immediately.
func (s *stallSample) finish() bool {
	if s == nil {
		return true
	}
	<-s.done
	return true
}

// webKitSampleNotePrefix opens the stderr line naming a peer's sample
// (stallSampleNote).
const webKitSampleNotePrefix = "WebKit process sample: "

// stallSampleNote is the stderr lines naming a wedge's samples, written just
// before a force-exit. Stderr, because a server with a log file and no terminal
// discards jlog's console output — the browser test pool's servers among them —
// so the harness, which keeps only their stderr, would otherwise never learn a
// sample was taken. The "Main-thread sample: " and webKitSampleNotePrefix
// prefixes are matched by stallSampleStderrPrefix and webKitSampleStderrPrefix
// in tests/integration/browser. Empty when nothing was sampled; samples settle
// had to kill are reported without their paths, since the files they left are
// partial at best.
func stallSampleNote(s *stallSample, settled bool) string {
	if s == nil {
		return ""
	}
	if !settled {
		return fmt.Sprintf("\nMain-thread sample didn't finish within %v; killed it.\n", stallSampleGrace)
	}
	var b strings.Builder
	b.WriteString("\nMain-thread sample: " + s.path + "\n")
	for _, peer := range s.peers {
		b.WriteString(webKitSampleNotePrefix + peer + "\n")
	}
	return b.String()
}

// stallSamplePath places a sample file beside the server log that will describe
// the stall, named so it sorts with its siblings and matches the log sweep's
// retention (internal/logpaths) — the sample ages out with the logs it belongs
// to rather than accumulating forever. An empty logPath (on-disk logging
// disabled) yields "": no log, no sample.
func stallSamplePath(logPath string, now time.Time) string {
	if logPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(logPath), "mainthread-stall-"+now.Format("20060102-150405")+".sample.log")
}
