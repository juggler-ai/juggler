//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"juggler/internal/apipaths"
)

// activityPollInterval is how often each session child is asked whether a
// turn is running.
const activityPollInterval = 2 * time.Second

// retireRetryMax caps the wait between retirement requests to a session whose
// child keeps refusing — one held by an approval nobody is there to give.
const retireRetryMax = 30 * time.Second

// activityHTTP asks children for their activity. Its timeout keeps one stuck
// child from stalling its poller past a couple of intervals; a poll decides
// nothing, so one given up on costs only a sample.
var activityHTTP = &http.Client{Timeout: activityPollInterval}

// pollActivity asks c, every interval, whether it is running a turn and
// records the answer on session id (Session.Busy, Session.LastActive). It
// returns when c exits. A poll that fails records nothing: an unreachable
// child is either gone — which its supervisor records — or stuck, and a stuck child
// stays whatever it was last seen to be rather than turning idle under a turn.
//
// A session that has had no viewer for the grace is asked to retire (retire),
// unless the poll found a turn running, which would refuse. A refusal — an
// approval wait, queued work — is asked again after a wait that doubles, up to
// retireRetryMax, and starts again from every once a turn is seen.
func (s *Server) pollActivity(id string, c *child, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	var retryAt time.Time
	retryAfter := every
	for {
		select {
		case <-c.exited:
			return
		case <-tick.C:
		}
		activity, err := childActivity(c)
		if err != nil {
			continue
		}
		now := time.Now()
		s.reg.setActivity(id, c, activity.Active, now)
		if activity.Active {
			retryAt, retryAfter = time.Time{}, every
			continue
		}
		if now.Before(retryAt) || !s.reg.retireUnviewed(id, c, now) {
			continue
		}
		if s.retire(id, c) {
			return
		}
		retryAt = time.Now().Add(retryAfter)
		retryAfter = min(2*retryAfter, retireRetryMax)
	}
}

// childActivityResponse is the quit-warning signal: a turn is running, not
// merely parked on a tool approval.
type childActivityResponse struct {
	Active bool `json:"active"`
}

// childActivity reads c's activity endpoint, quoting the API token minted for
// it: the child serves its health to no one without it.
func childActivity(c *child) (body childActivityResponse, err error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://"+c.addr+apipaths.HealthActive, nil)
	if err != nil {
		return body, err
	}
	req.Header.Set(TokenHeader, c.apiToken)
	resp, err := activityHTTP.Do(req)
	if err != nil {
		return body, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return body, fmt.Errorf("%s: status %d", apipaths.HealthActive, resp.StatusCode)
	}
	err = json.NewDecoder(resp.Body).Decode(&body)
	return body, err
}

// setActivity records one activity poll of child c on session id: busy, and
// when busy, at as its last activity. A poll of any child but the one the
// entry holds now — one that has crashed, or been replaced — is dropped.
func (r *registry) setActivity(id string, c *child, busy bool, at time.Time) {
	r.do(func(m map[string]*sessionEntry) {
		e, ok := m[id]
		if !ok || e.child != c {
			return
		}
		e.Busy = busy
		if busy {
			e.LastActive = &at
		}
	})
}
