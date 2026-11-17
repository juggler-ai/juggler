//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

// Progress is one reading of a network write's --progress meter: the phase
// git is in ("Receiving objects"), said by the remote end when Remote is set,
// and how far through it git is. Phases are git's English words — network
// writes run under LC_ALL=C — for the client to translate the ones it knows.
type Progress struct {
	Phase    string `json:"phase"`
	Remote   bool   `json:"remote,omitempty"`
	Percent  int    `json:"percent"`         // -1 when git gives only a count
	Done     int64  `json:"done"`            // objects (or deltas) so far
	Total    int64  `json:"total,omitempty"` // of how many; 0 when not known
	Rate     string `json:"rate,omitempty"`  // e.g. "2.00 MiB/s", when git says
	Finished bool   `json:"finished,omitempty"`
}

// progressLine is git's meter: `[remote: ]Phase: NN% (d/t)[, size | rate][, done.]`,
// or a bare count, `Phase: N[, done.]`.
// The ", done." that ends a phase is taken off before it is matched.
var progressLine = regexp.MustCompile(`^(remote: )?([A-Z][A-Za-z ]*[a-z]): +(?:(\d+)% \((\d+)/(\d+)\)|(\d+))(?:, ([^,]*))?$`)

// ParseProgress reads one line or frame of git's stderr as a meter reading.
func ParseProgress(line string) (Progress, bool) {
	// A remote's lines may end in the escape that clears the rest of the line.
	line = strings.TrimSpace(strings.ReplaceAll(line, "\x1b[K", ""))
	body, finished := strings.CutSuffix(line, ", done.")
	m := progressLine.FindStringSubmatch(body)
	if m == nil {
		return Progress{}, false
	}
	p := Progress{Phase: m[2], Remote: m[1] != "", Finished: finished, Percent: -1}
	if m[3] != "" {
		p.Percent, _ = strconv.Atoi(m[3])
		p.Done, _ = strconv.ParseInt(m[4], 10, 64)
		p.Total, _ = strconv.ParseInt(m[5], 10, 64)
	} else {
		p.Done, _ = strconv.ParseInt(m[6], 10, 64)
	}
	if extra := m[7]; extra != "" {
		// "607.10 KiB | 23.35 MiB/s": the size so far, then the rate.
		if _, rate, ok := strings.Cut(extra, "|"); ok {
			p.Rate = strings.TrimSpace(rate)
		}
	}
	return p, true
}

// progressSplitter reads a network write's output as a terminal would show it.
// A frame ended by a carriage return is redrawn over by the next, so it is
// reported as progress only; a line ended by a newline is what stays on screen,
// so it goes to the output too (and is progress as well if it is a meter).
type progressSplitter struct {
	buf      []byte
	output   func([]byte)
	progress func(Progress)
}

func newProgressSplitter(output func([]byte), progress func(Progress)) *progressSplitter {
	return &progressSplitter{output: output, progress: progress}
}

func (s *progressSplitter) write(b []byte) {
	s.buf = append(s.buf, b...)
	for {
		i := bytes.IndexAny(s.buf, "\r\n")
		if i < 0 {
			return
		}
		segment, ended := s.buf[:i], s.buf[i]
		s.read(segment, ended == '\n')
		s.buf = s.buf[i+1:]
	}
}

// flush hands on whatever was written after the last line ended.
func (s *progressSplitter) flush() {
	if len(s.buf) > 0 {
		s.read(s.buf, false)
		if s.output != nil {
			s.output(s.buf)
		}
	}
	s.buf = nil
}

// read reports one segment: its meter reading, if it is one, and, when a
// newline ended it, the line itself to the output.
func (s *progressSplitter) read(segment []byte, line bool) {
	if p, ok := ParseProgress(string(segment)); ok && s.progress != nil {
		s.progress(p)
	}
	if line && s.output != nil {
		s.output(append(append([]byte(nil), segment...), '\n'))
	}
}
