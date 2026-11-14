//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	// Windows ships no IANA tz database and a deployed binary has no GOROOT, so
	// without this embedded copy time.LoadLocation fails for the zone the CLI
	// reports (e.g. "Europe/London") and the reset instant would be misread in
	// the machine's local zone instead.
	_ "time/tzdata"

	"juggler/cmd/juggler/providers/provider"
)

type usageCommandResult struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	Result  string `json:"result"`
}

var usageLineRE = regexp.MustCompile(`^Current (session|week)(?: \(([^)]+)\))?:\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*·\s*resets\s*(.+))?$`)

// usageResetLayouts spans the locale shapes the claude CLI prints the reset time
// in. The CLI formats it with the host's conventions, so the date word-order
// (Jun 12 vs 12 Jun) and clock (1:50pm vs 13:50 on a 24-hour machine) both vary.
// The date/time separator also varies — " at " on macOS, ", " on Windows — but
// parseUsageReset normalises that to a single space before matching, so the
// layouts here use a bare space.
var usageResetLayouts = func() []string {
	dates := []string{"Jan 2", "2 Jan"}
	clocks := []string{"3:04pm", "3pm", "15:04"}
	var out []string
	for _, d := range dates {
		for _, c := range clocks {
			out = append(out, d+" "+c+" 2006")
		}
	}
	return out
}()

// UsageStats fetches Claude.ai subscription limit usage using Claude Code's
// zero-turn /usage command. The richer statusLine rate_limits JSON is only
// emitted in interactive sessions, not in the -p/stream-json mode Juggler uses,
// but /usage is available in print mode and returns the same user-visible
// percentages without making a model turn.
func (c *Client) UsageStats(ctx context.Context) (provider.UsageStats, error) {
	// A logged-out claude CLI opens the browser auth page the instant it's
	// spawned, so the poll must not fire every tick. claudeUsagePollAllowed lets
	// usage appear before the first turn for a signed-in user (one startup probe)
	// while capping a logged-out CLI at one spawn per retry interval — after that
	// only a real turn, or the interval elapsing, re-enables polling.
	if !claudeUsagePollAllowed(c.acct.id()) {
		return provider.UsageStats{}, fmt.Errorf("claude CLI usage poll skipped: sign-in not yet confirmed")
	}
	bin := claudeBinary()
	if bin == "" {
		return provider.UsageStats{}, claudeNotFoundError(c.acct)
	}
	// --setting-sources project,local omits "user", so the probe loads only
	// project/local settings and fires none of the user's Claude Code plugins or
	// hooks. A usage poll is a transport for a number, not an agent turn — Juggler
	// supplies its own prompt, project, and tools — so an unrelated tool's
	// session-lifecycle machinery (memory stores, telemetry, audit hooks) must not
	// run every time we read a quota percentage.
	args := []string{"-p", "--output-format", "json", "--max-turns", "1", "--setting-sources", "project,local", "/usage"}
	cmd := claudeCommand(ctx, bin, args)
	cmd.Dir = c.workingDir
	cmd.Env = spawnEnv(bin, testExtraSpawnEnv, c.acct.configDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return provider.UsageStats{}, fmt.Errorf("claude /usage failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	var parsed usageCommandResult
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return provider.UsageStats{}, fmt.Errorf("decode claude /usage output: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if parsed.Type != "result" || parsed.Subtype != "success" {
		return provider.UsageStats{}, fmt.Errorf("claude /usage returned %s/%s", parsed.Type, parsed.Subtype)
	}
	// The probe succeeded, so the CLI is signed in: keep the poll enabled for the
	// rest of the process rather than through the rate-limited probe latch.
	markClaudeLoginConfirmed(c.acct.id())
	stats := parseUsageText(parsed.Result, time.Now())
	stats.Provider = c.acct.id()
	return stats, nil
}

func parseUsageText(text string, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{UpdatedAt: now}
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(rawLine)
		m := usageLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pct, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			continue
		}
		stat := provider.UsageStat{
			UsedPercent: provider.Pct(pct),
		}
		switch m[1] {
		case "session":
			stat.Name = "Session (5h)"
			stat.Category = "primary"
			stat.WindowSecs = 5 * 60 * 60
		case "week":
			label := strings.TrimSpace(m[2])
			if label == "" {
				stat.Name = "Week (7d)"
				stat.Category = "weekly"
			} else {
				stat.Name = "Week (" + label + ")"
				if strings.EqualFold(label, "all models") {
					stat.Category = "weekly"
				} else {
					stat.Category = "model"
				}
			}
			stat.WindowSecs = 7 * 24 * 60 * 60
		}
		if reset := parseUsageReset(strings.TrimSpace(m[4]), now); reset != nil {
			stat.ResetsAt = reset
		}
		stats.Stats = append(stats.Stats, stat)
	}
	return stats
}

func parseUsageReset(s string, now time.Time) *time.Time {
	if s == "" {
		return nil
	}
	zoneName := ""
	if open := strings.LastIndex(s, "("); open >= 0 && strings.HasSuffix(s, ")") {
		zoneName = strings.TrimSpace(strings.TrimSuffix(s[open+1:], ")"))
		s = strings.TrimSpace(s[:open])
	}
	loc := time.Local
	if zoneName != "" {
		if loaded, err := time.LoadLocation(zoneName); err == nil {
			loc = loaded
		}
	}
	// The CLI separates date and time with " at " on macOS and ", " on Windows;
	// normalise both to a single space so one set of layouts matches either host.
	s = strings.ReplaceAll(s, " at ", " ")
	s = strings.ReplaceAll(s, ",", "")
	withYear := fmt.Sprintf("%s %d", s, now.In(loc).Year())
	for _, layout := range usageResetLayouts {
		parsed, err := time.ParseInLocation(layout, withYear, loc)
		if err != nil {
			continue
		}
		nowInLoc := now.In(loc)
		// Around New Year, a future weekly reset may belong to the next calendar
		// year. Use the same instant normalised into the parsed location before
		// comparing; comparing a Europe/London parse directly against a time.Local
		// value would be host/timezone dependent on Windows/Linux/macOS.
		if parsed.Before(nowInLoc.Add(-24 * time.Hour)) {
			parsed = parsed.AddDate(1, 0, 0)
		}
		utc := parsed.UTC()
		return &utc
	}
	return nil
}
