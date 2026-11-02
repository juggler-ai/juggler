//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package bundlelaunch starts a macOS app bundle through LaunchServices, as
// the Finder would, rather than as a child of the process starting it.
//
// A process forked from an app stays in that app's launchd job however it is
// detached, and LaunchServices files the job's processes as one launch. When
// one of them checks in as an app before the app itself does, it is given the
// launch the Dock is waiting on: the Dock bounces the app's icon until that
// process quits, and keeps a tile for it after the app has gone. A bundle
// started here is a launch of its own, in a job of its own, which its own
// children share.
//
// It is not detach, which starts a plain process that outlives its starter but
// stays in the starter's job.
package bundlelaunch
