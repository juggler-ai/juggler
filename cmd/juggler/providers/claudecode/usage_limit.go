//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"regexp"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// usageLimitResetRE finds the reset in the CLI's subscription-cap refusal:
// "You've hit your session limit · resets 3pm (Europe/London)", where the limit
// is named for its window (session, weekly, Opus…) and further " · " clauses
// may follow the time. The CLI states the reset only as this text, so reading
// it is the only way the wait reaches the worker as a stated one.
var usageLimitResetRE = regexp.MustCompile(`(?i)\byou(?:'|’)ve hit your [^·\n]*?limit\s*·\s*resets\s+([^·\n]+)`)

// usageLimitClocks are the clock forms the CLI prints a reset in: en-US, 12-hour,
// minutes only when they are not zero, the meridiem lowercased against the time.
var usageLimitClocks = []string{"3:04pm", "3pm"}

// usageLimitError is the rate limit a capped CLI turn reports, carrying the
// wait until the reset its text states, or nil when the text is not that
// refusal or states no reset still to come. text stays the error's message
// verbatim.
func usageLimitError(text string, cause error, now time.Time) *provider.RateLimitedError {
	m := usageLimitResetRE.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	at, ok := parseLimitReset(strings.TrimSpace(m[1]), now)
	if !ok || !at.After(now) {
		return nil
	}
	return &provider.RateLimitedError{RetryAfter: at.Sub(now), Message: text, Cause: cause}
}

// parseLimitReset reads a reset time as the CLI prints one in its refusal:
// "3pm", "3:30pm", "Oct 30, 9am" or "Jan 2, 2027, 5pm", each followed by the
// zone it is in, in parentheses — the host's own zone when there are none. A
// bare clock is the next time it comes round: the CLI prints the date only for
// a reset more than a day away. A date with no year is this year's, unless it
// has already gone by, when it is next year's.
func parseLimitReset(s string, now time.Time) (time.Time, bool) {
	loc := time.Local
	if open := strings.LastIndex(s, "("); open >= 0 && strings.HasSuffix(s, ")") {
		if loaded, err := time.LoadLocation(strings.TrimSpace(s[open+1 : len(s)-1])); err == nil {
			loc = loaded
		}
		s = strings.TrimSpace(s[:open])
	}
	s = strings.Join(strings.Fields(strings.ReplaceAll(s, ",", " ")), " ")
	nowIn := now.In(loc)
	for _, clock := range usageLimitClocks {
		if t, err := time.ParseInLocation(clock, s, loc); err == nil {
			at := time.Date(nowIn.Year(), nowIn.Month(), nowIn.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if !at.After(now) {
				at = at.AddDate(0, 0, 1)
			}
			return at, true
		}
		if t, err := time.ParseInLocation("Jan 2 2006 "+clock, s, loc); err == nil {
			return t, true
		}
		if t, err := time.ParseInLocation("Jan 2 "+clock, s, loc); err == nil {
			at := time.Date(nowIn.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if at.Before(now.Add(-24 * time.Hour)) {
				at = at.AddDate(1, 0, 0)
			}
			return at, true
		}
	}
	return time.Time{}, false
}
