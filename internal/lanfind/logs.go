//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/logging"

	"juggler/internal/jlog"
)

// logLine is where the responder's warnings are written. A seam, with now,
// for tests.
var logLine = jlog.Info

// now is the clock the responder's warnings are rate-limited by.
var now = time.Now

// warnEvery is how often one warning of the responder's is logged. A machine
// that refuses multicast fails every answer the responder sends, on every
// interface, each time anyone on the network asks; the first says so, and the
// rest only count.
const warnEvery = time.Minute

// warned is each of the responder's warnings, by its format, that has been
// logged: a *warning.
var warned sync.Map

// warning is when one of the responder's warnings was last logged (Unix
// nanoseconds), and how many like it have been left out since.
type warning struct {
	at      atomic.Int64
	skipped atomic.Int64
}

// responderLogs is the LoggerFactory the responder is opened with: its
// warnings and errors go to the log (jlog), rate-limited, and the rest of its
// chatter nowhere. The advertisement it serves, if any, is told of each send
// that fails (Advertisement.SendFailed).
type responderLogs struct {
	ad *Advertisement
}

// NewLogger is the logger for one of the responder's scopes; they all log alike.
func (l responderLogs) NewLogger(string) logging.LeveledLogger { return responderLogger(l) }

type responderLogger responderLogs

func (responderLogger) Trace(string)          {}
func (responderLogger) Tracef(string, ...any) {}
func (responderLogger) Debug(string)          {}
func (responderLogger) Debugf(string, ...any) {}
func (responderLogger) Info(string)           {}
func (responderLogger) Infof(string, ...any)  {}

func (l responderLogger) Warn(msg string)                   { l.note("%s", msg) }
func (l responderLogger) Warnf(format string, args ...any)  { l.note(format, args...) }
func (l responderLogger) Error(msg string)                  { l.note("%s", msg) }
func (l responderLogger) Errorf(format string, args ...any) { l.note(format, args...) }

// note logs one warning, unless one like it (by format) was logged under
// warnEvery ago; the next that is logged says how many were left out. A
// failed write among its arguments is a send that did not leave, which the
// advertisement is told of.
func (l responderLogger) note(format string, args ...any) {
	if l.ad != nil {
		for _, a := range args {
			var op *net.OpError
			if err, ok := a.(error); ok && errors.As(err, &op) && op.Op == "write" {
				l.ad.sendFailed.Store(true)
			}
		}
	}
	t := now().UnixNano()
	v, seen := warned.Load(format)
	if !seen {
		w := &warning{}
		w.at.Store(t - int64(warnEvery))
		v, _ = warned.LoadOrStore(format, w)
	}
	w := v.(*warning) //nolint:forcetypeassert // warned holds only *warning
	last := w.at.Load()
	// One of two at once is logged; the other is left out, as one under
	// warnEvery after it would be.
	if t-last < int64(warnEvery) || !w.at.CompareAndSwap(last, t) {
		w.skipped.Add(1)
		return
	}
	line := "mDNS: " + fmt.Sprintf(format, args...)
	if n := w.skipped.Swap(0); n > 0 {
		line += fmt.Sprintf(" (and %d more like it)", n)
	}
	logLine("%s", line)
}
