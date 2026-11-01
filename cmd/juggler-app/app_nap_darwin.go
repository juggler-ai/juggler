//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation

#import <Foundation/Foundation.h>

// holdOffAppNap begins an activity that lasts for the rest of the process,
// which keeps App Nap off it while still letting the machine idle-sleep. The
// token is held in a static so ARC never ends the activity.
static void holdOffAppNap(void) {
	static id<NSObject> activity;
	if (activity != nil) {
		return;
	}
	activity = [[NSProcessInfo processInfo]
		beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
		reason:@"Juggler holds its server and shows its sessions"];
}
*/
import "C"

// holdOffAppNap keeps macOS from napping the app for as long as it runs. A
// napped app's timers are deferred and its threads run at background priority:
// with its windows hidden behind a dark display and the machine saturated, its
// heartbeats to its server (machineserver.Client.Attach) and its handling of
// the server going stall for tens of seconds. The machine can still sleep.
func holdOffAppNap() { C.holdOffAppNap() }
