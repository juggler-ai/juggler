//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"compress/flate"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"juggler/internal/jlog"
)

// WebSocket bandwidth instrumentation. Diagnostic-only, off unless the
// JUGGLER_WS_STATS env var is set (to a flush-interval in seconds, or any
// non-numeric value for the 10s default). It answers two questions a remote
// tunnel session raises: where do the bytes actually go (per direction / message
// type), and how much would permessage-deflate save (the modeled ratio).
//
// All state lives in a single goroutine fed by a channel, so no lock is needed.
// record() copies the payload because gorilla reuses its read buffer.

const (
	statsIn  = "in"
	statsOut = "out"
)

// wsStats is the accounting actor. Nil-safe: a nil *wsStats means disabled, so
// callers invoke record() unconditionally without a guard.
type wsStats struct {
	ch chan wsStatEvent
}

type wsStatEvent struct {
	dir     string
	role    ClientRole
	payload []byte
}

type wsStatAcc struct {
	count int64
	raw   int64
	comp  int64 // modeled per-message deflate size
}

// newWSStats returns an enabled accountant when JUGGLER_WS_STATS is set,
// otherwise nil (disabled). The env value, if a positive integer, is the
// flush interval in seconds.
func newWSStats() *wsStats {
	v, ok := os.LookupEnv("JUGGLER_WS_STATS")
	if !ok || v == "0" || strings.EqualFold(v, "off") {
		return nil
	}
	interval := 10 * time.Second
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
		interval = time.Duration(n) * time.Second
	}
	s := &wsStats{ch: make(chan wsStatEvent, 1024)}
	go s.run(interval)
	jlog.Info("WS bandwidth stats enabled (flush every %s); set JUGGLER_WS_STATS=0 to disable", interval)
	return s
}

// record copies payload and forwards it to the actor. Best-effort: drops the
// sample rather than block a hot write/read path if the actor is saturated.
func (s *wsStats) record(dir string, payload []byte, role ClientRole) {
	if s == nil || len(payload) == 0 {
		return
	}
	buf := make([]byte, len(payload))
	copy(buf, payload)
	select {
	case s.ch <- wsStatEvent{dir: dir, role: role, payload: buf}:
	default:
	}
}

func (s *wsStats) run(interval time.Duration) {
	accs := map[string]*wsStatAcc{}
	// One reused flate writer models gorilla's permessage-deflate, which
	// compresses each message independently (no context takeover).
	var fbuf compressCounter
	fw, _ := flate.NewWriter(&fbuf, flate.DefaultCompression)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case ev := <-s.ch:
			key := fmt.Sprintf("%-3s %-6s %s", ev.dir, ev.role, wsMsgLabel(ev.payload))
			a := accs[key]
			if a == nil {
				a = &wsStatAcc{}
				accs[key] = a
			}
			a.count++
			a.raw += int64(len(ev.payload))
			fbuf.n = 0
			fw.Reset(&fbuf)
			_, _ = fw.Write(ev.payload)
			_ = fw.Flush() // per-message boundary, matches permessage-deflate framing
			a.comp += fbuf.n
		case <-tick.C:
			s.flush(accs)
		}
	}
}

func (s *wsStats) flush(accs map[string]*wsStatAcc) {
	if len(accs) == 0 {
		return
	}
	keys := make([]string, 0, len(accs))
	var totRaw, totComp, totCount int64
	for k, a := range accs {
		keys = append(keys, k)
		totCount += a.count
		totRaw += a.raw
		totComp += a.comp
	}
	sort.Slice(keys, func(i, j int) bool { return accs[keys[i]].raw > accs[keys[j]].raw })

	var b strings.Builder
	fmt.Fprintf(&b, "WS bandwidth (cumulative): %d msgs  raw=%s  deflate≈%s (%.0f%% of raw)\n",
		totCount, humanBytes(totRaw), humanBytes(totComp), pctOf(totComp, totRaw))
	for _, k := range keys {
		a := accs[k]
		fmt.Fprintf(&b, "  %-26s %7d msgs  raw=%-9s deflate≈%-9s (%.0f%%)\n",
			k, a.count, humanBytes(a.raw), humanBytes(a.comp), pctOf(a.comp, a.raw))
	}
	jlog.Info("%s", strings.TrimRight(b.String(), "\n"))
}

// wsMsgLabel extracts the message's logical type for grouping. Worker envelopes
// carry the meaningful type one level down in workerMsgType.
// A binary sync frame is labelled apart from the JSON form of the same worker
// message, so the two can be compared.
func wsMsgLabel(payload []byte) string {
	if isYjsFrame(payload) {
		if f, err := parseYjsFrame(payload); err == nil {
			return "worker:" + yjsFrameMsgType[f.kind] + " (bin)"
		}
		return "(bad sync frame)"
	}
	var g struct {
		Type          string `json:"type"`
		WorkerMsgType string `json:"workerMsgType"`
	}
	if json.Unmarshal(payload, &g) != nil {
		return "(non-json)"
	}
	if g.Type == "worker-message" {
		if g.WorkerMsgType != "" {
			return "worker:" + g.WorkerMsgType
		}
		return "worker:?"
	}
	if g.Type == "" {
		return "(untyped)"
	}
	return g.Type
}

// compressCounter is an io.Writer that only counts bytes — the flate writer
// streams into it so we measure compressed size without retaining the output.
type compressCounter struct{ n int64 }

func (c *compressCounter) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return len(p), nil
}

func pctOf(part, whole int64) float64 {
	if whole == 0 {
		return 0
	}
	return 100 * float64(part) / float64(whole)
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGT"[exp])
}
