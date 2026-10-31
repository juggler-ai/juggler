//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production stub for test_process_pids.go: a release build has no test pool.

//go:build production

package server

// testPoolHooks holds nothing in a release build: no test pool installs hooks.
type testPoolHooks struct{}

// testLanesHold is false in a release build: it queues no browser tests.
func (s *Server) testLanesHold() bool { return false }
