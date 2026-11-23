//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"testing"
)

// The jobs topic is a viewer's: the engine shows no jobs, and a role the topic
// does not name hears none.
func TestJobsTopic_ViewersOnly(t *testing.T) {
	s := newTestServerState(t)
	h := s.topicHub()
	if err := h.subscribe("v", ClientRoleViewer, "jobs", []string{""}); err != nil {
		t.Errorf("a viewer subscribing to jobs: %v, want it taken", err)
	}
	if err := h.subscribe("e", ClientRoleEngine, "jobs", []string{""}); !errors.Is(err, errTopicRefused) {
		t.Errorf("the engine subscribing to jobs: %v, want %v", err, errTopicRefused)
	}
}
