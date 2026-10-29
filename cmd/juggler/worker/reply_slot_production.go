//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build production

package worker

import "encoding/json"

// replyInjections holds nothing in a release build: there is no uncorrelated
// route into a reply registry (reply_slot_testonly.go).
type replyInjections struct{}

// take never has an injected answer in a release build.
func (*replyInjections) take() (json.RawMessage, bool) { return nil, false }

// handle knows no commands in a release build.
func (*replyInjections) handle(any, map[string]pendingReply, []string) bool { return false }
