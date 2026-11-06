//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"juggler/internal/apipaths"
	"juggler/internal/attention"
)

// Attention is which of a session's conversations wait on the user, are
// working, or failed (juggler/internal/attention). The activity poll
// (pollActivity) reads the revision a child carries on every answer, and
// fetches the child's report only when that has moved.

// SessionAttention is what a session's child last reported of its
// conversations.
type SessionAttention struct {
	Waiting int `json:"waiting"`
	Working int `json:"working"`
	Failed  int `json:"failed"`
	// Items are the waiting and failed conversations, oldest first.
	Items []attention.Conversation `json:"items"`
	// WorkingOn is the name of the oldest working conversation; absent when
	// none works.
	WorkingOn string `json:"workingOn,omitempty"`
}

// newSessionAttention summarises a child's report of cs, which come oldest
// first.
func newSessionAttention(cs []attention.Conversation) *SessionAttention {
	a := &SessionAttention{
		Waiting: attention.Count(cs, attention.Waiting),
		Working: attention.Count(cs, attention.Working),
		Failed:  attention.Count(cs, attention.Failed),
		Items:   []attention.Conversation{},
	}
	for _, c := range cs {
		if c.Durable() {
			a.Items = append(a.Items, c)
		}
		if c.State == attention.Working && a.WorkingOn == "" {
			a.WorkingOn = c.Name
		}
	}
	return a
}

// durable is what of a outlives its child — the waiting and failed
// conversations, which are in their documents — for a session whose child
// has gone; nil for nil.
func (a *SessionAttention) durable() *SessionAttention {
	if a == nil {
		return nil
	}
	return newSessionAttention(a.Items)
}

// setAttention records child c's attention report on session id, and its
// last change of attention as the session's last activity when that is
// later. A report from any child but the one the entry holds now is dropped.
func (r *registry) setAttention(id string, c *child, report attention.Report) {
	r.do(func(m map[string]*sessionEntry) {
		e, ok := m[id]
		if !ok || e.child != c {
			return
		}
		e.Attention = newSessionAttention(report.Conversations)
		if at := report.LastActive; !at.IsZero() && (e.LastActive == nil || at.After(*e.LastActive)) {
			e.LastActive = &at
		}
	})
}

// errNoAttention is childAttention's answer from a child that serves no
// attention report: one of an earlier build.
var errNoAttention = fmt.Errorf("%s: not served", apipaths.HealthAttention)

// childAttention reads c's attention report, quoting its API token as
// childActivity does.
func childAttention(c *child) (report attention.Report, err error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://"+c.addr+apipaths.HealthAttention, nil)
	if err != nil {
		return report, err
	}
	req.Header.Set(TokenHeader, c.apiToken)
	resp, err := activityHTTP.Do(req)
	if err != nil {
		return report, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return report, errNoAttention
	default:
		return report, fmt.Errorf("%s: status %d", apipaths.HealthAttention, resp.StatusCode)
	}
	err = json.NewDecoder(resp.Body).Decode(&report)
	return report, err
}
