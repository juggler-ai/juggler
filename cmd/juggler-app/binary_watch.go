//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"sync"
	"time"

	"juggler/internal/binwatch"
)

// The app watches the binaries it was launched from — its own, and the server
// binary it starts — for another build put in their place: a rebuild under the
// running app. It then offers the page a relaunch (relaunch.go), which starts
// the app again from what is installed now; the server catches up as the
// relaunched app connects to it (serverClient), or is used as it is when it
// has caught up already (isInstalledServerBuild).
//
// Every build watches. A build from source is rebuilt under the running app; a
// published one is replaced under it by whatever installs it outside the
// in-app updater — a release unpacked over the old one (Linux, which has no
// updater), a package manager's upgrade. The in-app updater never trips it: it
// swaps the app only once the app has quit.

// relaunchOffer is what the page is told of a relaunch on offer: which binary
// is another build now, and the version the app's own new one carries, when it
// is stamped with one.
type relaunchOffer struct {
	App     bool   `json:"app"`
	Server  bool   `json:"server"`
	Version string `json:"version,omitempty"`
}

// binaryPollInterval is how often the binaries are looked at. A file counts as
// settled once two looks in a row find it unchanged (binwatch.Watcher.Poll),
// so this is how soon after a build finishes the offer appears, not a bound on
// how long the build may take.
const binaryPollInterval = 2 * time.Second

// ownBuild is the build ID of the binary this app was launched from, read once,
// as early as anything asks (watchBinaries, as the app starts); "" when it
// cannot be read.
var ownBuild = sync.OnceValue(func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	id, err := binwatch.ReadID(exe)
	if err != nil {
		return ""
	}
	return id
})

// ownBinaryReplaced is whether the binary at this app's path is another
// complete build than the one running, as it reads now — not settled over two
// looks, as the watcher's offer is. False when either build cannot be read. A
// variable so tests can play an install.
var ownBinaryReplaced = func() bool {
	base := ownBuild()
	exe, err := os.Executable()
	if base == "" || err != nil {
		return false
	}
	b, err := binwatch.Read(exe)
	return err == nil && b.ID != base
}

// appIsAnotherBuild is whether the binary at this app's path is another build
// than the one running: as the watcher has settled it (relaunchOffer.App), or
// as it reads now (ownBinaryReplaced). An install that replaces the server and
// the app together may have the server relaunch into it before the watcher has
// looked twice at the app's binary.
func (a *appState) appIsAnotherBuild() bool {
	if offer := a.relaunchOffer.Load(); offer != nil && offer.App {
		return true
	}
	return ownBinaryReplaced()
}

// relaunchOfferEvent is the event the page is sent when the offer changes. It
// carries nothing: every window is sent it, a remote one too, and each page
// reads the offer over its own control endpoint (op=state), which a remote
// window is refused.
const relaunchOfferEvent = "juggler:relaunch-offer"

// watchBinaries starts watching, until the app exits.
func (a *appState) watchBinaries() {
	var app, server *binwatch.Watcher
	if exe, err := os.Executable(); err == nil {
		if id := ownBuild(); id != "" {
			app = binwatch.NewFrom(exe, id)
		} else {
			logf("relaunch: not watching the app binary: its build cannot be read")
		}
	}
	if bin, err := serverBinPath(); err == nil {
		if server, err = binwatch.New(bin); err != nil {
			logf("relaunch: not watching the server binary: %v", err)
		}
	}
	if app == nil && server == nil {
		return
	}
	go func() {
		tick := time.NewTicker(binaryPollInterval)
		defer tick.Stop()
		for range tick.C {
			a.takeRelaunchOffer(pollRelaunchOffer(app, server))
		}
	}()
}

// pollRelaunchOffer looks at both binaries once and returns the offer they
// make, or nil when both are still the builds the app launched with.
func pollRelaunchOffer(app, server *binwatch.Watcher) *relaunchOffer {
	var offer relaunchOffer
	if app != nil {
		if b := app.Poll(); b != nil {
			offer.App, offer.Version = true, b.Version
		}
	}
	if server != nil && server.Poll() != nil {
		offer.Server = true
	}
	if !offer.App && !offer.Server {
		return nil
	}
	return &offer
}

// takeRelaunchOffer records offer and, when it differs from the one before,
// tells every page to read it again.
func (a *appState) takeRelaunchOffer(offer *relaunchOffer) {
	prev := a.relaunchOffer.Swap(offer)
	if same := (prev == nil) == (offer == nil) && (prev == nil || *prev == *offer); same {
		return
	}
	if offer != nil {
		logf("relaunch: another build is installed (app %v, server %v, version %q); offering a relaunch", offer.App, offer.Server, offer.Version)
	}
	a.execJSInAllWindows("window.dispatchEvent(new CustomEvent('" + relaunchOfferEvent + "'))")
}
