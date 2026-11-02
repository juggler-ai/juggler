//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// TestALaunchWithoutALockStillStarts: on Linux the single-instance lock is a
// name on the session bus, and Wails treats any failure to claim it other than
// "already running" as fatal. Without a session bus — an ssh -X session, a
// minimal window manager — the app would refuse to start at all. It starts
// without the lock instead.
func TestALaunchWithoutALockStillStarts(t *testing.T) {
	if opts := singleInstanceOptions(errors.New("no session bus"), nil); opts != nil {
		t.Errorf("with no lock to be had the app asks Wails for one anyway (%+v), which ends the launch", opts)
	}
	called := false
	opts := singleInstanceOptions(nil, func(application.SecondInstanceData) { called = true })
	if opts == nil || opts.UniqueID != singleInstanceID || opts.OnSecondInstanceLaunch == nil {
		t.Fatalf("with a lock to be had the app does not take it: %+v", opts)
	}
	opts.OnSecondInstanceLaunch(application.SecondInstanceData{})
	if !called {
		t.Error("a second launch is not handed to the running app")
	}
}
