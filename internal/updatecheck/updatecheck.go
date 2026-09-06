//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package updatecheck polls a remote version manifest (juggler.studio) and
// decides whether the running build should show a "new version available"
// notice. It is deliberately stateless across restarts: the website is the
// single source of truth for what to show, the result is held only in memory,
// and there is no dismiss-state anywhere. To retract a message, edit the
// manifest — the next poll reflects it.
//
// The request carries the running version, OS and arch as query params
// (?v=&os=&arch=), plus a mark on the day's first scheduled check (see
// Config.Mark). On static hosting (GitHub Pages) these are ignored and the
// version comparison happens here; once juggler.studio gains a real backend the
// same params let it target responses and gather analytics without any client
// change. The manifest also reserves a `downloads` block (per os/arch artifact
// URLs + integrity fields) for a future auto-updater; it is parsed but unused by
// the notice path today.
package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"
)

// DefaultManifestURL is the well-known location of the version manifest.
const DefaultManifestURL = "https://juggler.studio/juggler-version.json"

// Schema is the required value of the manifest's "schema" field — a guard
// against a captive-portal page or unrelated JSON being parsed as a manifest.
const Schema = "juggler-version"

// SupportedSchemaVersion is the highest manifest schemaVersion this build was
// written against. A higher value is still parsed (unknown fields are ignored,
// known fields read) so the format can grow additively without bricking older
// builds; a value below 1 is rejected.
const SupportedSchemaVersion = 1

const (
	defaultInterval = 6 * time.Hour
	defaultTimeout  = 10 * time.Second
	maxBodyBytes    = 1 << 20 // 1 MiB cap on the manifest body
)

// Manifest is the on-the-wire shape served at the manifest URL.
type Manifest struct {
	Schema        string              `json:"schema"`
	SchemaVersion int                 `json:"schemaVersion"`
	Latest        string              `json:"latest"`
	Notice        *Notice             `json:"notice,omitempty"`
	Downloads     map[string]Download `json:"downloads,omitempty"` // reserved: future auto-updater
}

// Notice is a server-authored message to show. html is optional — when absent
// the client generates a default message from latestVersion (hybrid authoring).
type Notice struct {
	ID       string   `json:"id"`
	Severity string   `json:"severity"` // "info" | "recommended" | "required"
	Title    string   `json:"title,omitempty"`
	HTML     string   `json:"html,omitempty"`
	Actions  []Action `json:"actions,omitempty"`
}

// Action is a button rendered in the notice.
type Action struct {
	Label   string `json:"label"`
	URL     string `json:"url"`
	Primary bool   `json:"primary,omitempty"`
}

// Download is a per-os/arch artifact descriptor. Reserved for the future
// auto-updater; sha256/size are intentionally present-but-unused now so the
// manifest publisher can start populating them ahead of that work.
type Download struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size,omitempty"`
}

// Status is the computed answer for this build, served at /api/update-status
// and pushed over WS when it changes.
type Status struct {
	CurrentVersion  string  `json:"currentVersion"`
	LatestVersion   string  `json:"latestVersion,omitempty"`
	UpdateAvailable bool    `json:"updateAvailable"`
	Notice          *Notice `json:"notice,omitempty"`
}

// validate rejects responses that are not a recognisable manifest.
func (m *Manifest) validate() error {
	if m.Schema != Schema {
		return fmt.Errorf("unexpected schema %q (want %q)", m.Schema, Schema)
	}
	if m.SchemaVersion < 1 {
		return fmt.Errorf("unsupported schemaVersion %d", m.SchemaVersion)
	}
	return nil
}

// ComputeStatus decides what (if anything) to show for currentVersion given a
// manifest. A notice is surfaced only when currentVersion parses as semver and
// is strictly older than the manifest's latest — so development builds ("dev",
// or anything unparseable) are never nagged. The notice presentation itself is
// passed straight through from the manifest.
func ComputeStatus(m *Manifest, currentVersion string) Status {
	st := Status{CurrentVersion: currentVersion}
	if m == nil {
		return st
	}
	st.LatestVersion = m.Latest
	if cmp, ok := compareSemver(currentVersion, m.Latest); ok && cmp < 0 {
		st.UpdateAvailable = true
		st.Notice = m.Notice
	}
	return st
}

// compareSemver returns -1/0/1 comparing a to b on MAJOR.MINOR.PATCH, ignoring
// a leading "v" and any -prerelease/+build suffix. ok is false when either side
// does not parse (e.g. "dev"), in which case callers must treat the comparison
// as indeterminate rather than equal.
func compareSemver(a, b string) (int, bool) {
	pa, okA := parseSemver(a)
	pb, okB := parseSemver(b)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		switch {
		case pa[i] < pb[i]:
			return -1, true
		case pa[i] > pb[i]:
			return 1, true
		}
	}
	return 0, true
}

func parseSemver(s string) ([3]int, bool) {
	var out [3]int
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return out, false
	}
	parts := strings.Split(s, ".")
	if len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Config configures a Checker.
type Config struct {
	URL            string        // manifest URL; defaults to DefaultManifestURL
	CurrentVersion string        // this build's version (core.Version)
	OS             string        // runtime.GOOS, sent as ?os=
	Arch           string        // runtime.GOARCH, sent as ?arch=
	Client         *http.Client  // defaults to a client with a 10s timeout
	Interval       time.Duration // poll interval; defaults to 6h
	OnChange       func(Status)  // called when the surfaced notice/status changes
	// Enabled gates the scheduled poll: when non-nil and it returns false,
	// CheckOnce is a no-op that touches neither the network nor the stored
	// Status (the user has turned automatic checking off). A nil Enabled means
	// always-on. The manual path (CheckNow) bypasses this gate entirely.
	Enabled func() bool
	// Mark supplies the countme value for a scheduled check, plus a release
	// called at most once — when the request never reached a server — so the
	// caller can take the mark back. Zero sends no param; a nil Mark never does.
	//
	// Consulted only on the gated scheduled path. CheckNow runs regardless of
	// the Enabled gate, so it must not spend a mark the user has opted out of.
	Mark func() (mark int, release func())
}

// Checker polls the manifest and holds the latest computed Status in memory.
type Checker struct {
	cfg    Config
	status atomic.Pointer[Status]
	etag   atomic.Pointer[string]
}

// New builds a Checker seeded with an initial (no-manifest) Status, applying
// defaults. It does not start polling — call Start.
func New(cfg Config) *Checker {
	if cfg.URL == "" {
		cfg.URL = DefaultManifestURL
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: defaultTimeout}
	}
	if cfg.Interval <= 0 {
		cfg.Interval = defaultInterval
	}
	c := &Checker{cfg: cfg}
	init := ComputeStatus(nil, cfg.CurrentVersion)
	c.status.Store(&init)
	return c
}

// Current returns the latest computed Status (a value copy; never nil).
func (c *Checker) Current() Status {
	return *c.status.Load()
}

// Start launches the poll loop: an immediate check, then every Interval, until
// done is closed. Safe to call once.
func (c *Checker) Start(done <-chan struct{}) {
	go func() {
		c.checkWithTimeout(done)
		t := time.NewTicker(c.cfg.Interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				c.checkWithTimeout(done)
			}
		}
	}()
}

func (c *Checker) checkWithTimeout(done <-chan struct{}) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	go func() {
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()
	if err := c.CheckOnce(ctx); err != nil {
		jlog.Info("updatecheck: %v", err)
	}
}

// CheckOnce fetches the manifest once, recomputes Status, and fires OnChange if
// the surfaced notice/version changed. A 304 (ETag match) leaves Status as-is.
// Network/parse/validation failures return an error and leave the last-good
// Status untouched. When the Enabled gate is set and returns false it is a
// no-op (no network, Status untouched) — this is the scheduled-poll entry point.
func (c *Checker) CheckOnce(ctx context.Context) error {
	if c.cfg.Enabled != nil && !c.cfg.Enabled() {
		return nil
	}
	mark, release := 0, func() {}
	if c.cfg.Mark != nil {
		mark, release = c.cfg.Mark()
	}
	return c.checkOnce(ctx, mark, release)
}

// CheckNow performs a manual check that always runs, bypassing the Enabled gate
// — an explicit user "Check for updates" overrides the automatic-off policy. It
// never carries a mark; see Config.Mark.
func (c *Checker) CheckNow(ctx context.Context) error {
	return c.checkOnce(ctx, 0, func() {})
}

// checkOnce is the ungated fetch-and-recompute shared by CheckOnce and CheckNow.
// release runs only when the request never reached a server: any response at
// all, an error status included, was recorded at the other end already.
func (c *Checker) checkOnce(ctx context.Context, mark int, release func()) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.requestURL(mark), nil)
	if err != nil {
		release()
		return err
	}
	req.Header.Set("User-Agent", "juggler/"+c.cfg.CurrentVersion)
	req.Header.Set("Accept", "application/json")
	if e := c.etag.Load(); e != nil && *e != "" {
		req.Header.Set("If-None-Match", *e)
	}

	resp, err := c.cfg.Client.Do(req)
	if err != nil {
		release()
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotModified {
		jlog.Info("updatecheck: manifest unchanged (304)")
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("manifest fetch: status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return fmt.Errorf("manifest parse: %w", err)
	}
	if err := m.validate(); err != nil {
		return fmt.Errorf("manifest invalid: %w", err)
	}

	if et := resp.Header.Get("ETag"); et != "" {
		c.etag.Store(&et)
	}

	next := ComputeStatus(&m, c.cfg.CurrentVersion)
	prev := c.Current()
	c.status.Store(&next)
	if next.UpdateAvailable {
		jlog.Info("updatecheck: update available: %s (current %s)", next.LatestVersion, next.CurrentVersion)
	} else {
		jlog.Info("updatecheck: no update (current %s, latest %s)", next.CurrentVersion, next.LatestVersion)
	}
	if c.cfg.OnChange != nil && statusChanged(prev, next) {
		c.cfg.OnChange(next)
	}
	return nil
}

// requestURL appends the self-describing query params to the configured URL.
// Malformed base URLs fall back to the raw string so a poll is still attempted.
// A zero mark is omitted rather than sent as "countme=0".
func (c *Checker) requestURL(mark int) string {
	u, err := url.Parse(c.cfg.URL)
	if err != nil {
		return c.cfg.URL
	}
	q := u.Query()
	q.Set("v", c.cfg.CurrentVersion)
	if c.cfg.OS != "" {
		q.Set("os", c.cfg.OS)
	}
	if c.cfg.Arch != "" {
		q.Set("arch", c.cfg.Arch)
	}
	if mark > 0 {
		q.Set("countme", strconv.Itoa(mark))
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// statusChanged reports whether the user-visible decision differs: update
// availability, the latest version, or which notice is surfaced.
func statusChanged(a, b Status) bool {
	if a.UpdateAvailable != b.UpdateAvailable || a.LatestVersion != b.LatestVersion {
		return true
	}
	return noticeID(a.Notice) != noticeID(b.Notice)
}

func noticeID(n *Notice) string {
	if n == nil {
		return ""
	}
	return n.ID
}
