//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"net"
	"strconv"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/jlog"
	"juggler/internal/lanfind"
)

// Being findable (tunnel.RegisterLANAnnouncer): while LAN access is on and the
// saved connectivity.lanFindable says so, the registered announcer tells a
// third party where this server is on its network, so a browser there can list
// it and open its LAN address. That grants nothing: the browser then meets the
// LAN gate as any caller on the network does. The switch is a sub-option of LAN
// access, shown and set beside it (GET/PUT /api/server/lan "findable"), and
// exists only in a build that registered an announcer.

// findLANAnnouncer is the registered LAN announcer. A seam for tests.
var findLANAnnouncer = tunnel.FindLANAnnouncer

// lanAnnouncerRun is one stretch of the announcer running; end stops it.
type lanAnnouncerRun struct {
	end context.CancelFunc
}

// findableView is the findable switch in the /api/server/lan payload: whether
// it is on, and its copy from the spec, each as its English and, beside it
// under the key plus "Message", the message for the page to translate (as a
// tunnel mode's copy is sent), and the page its label links to.
type findableView struct {
	Enabled            bool         `json:"enabled"`
	Label              string       `json:"label"`
	LabelMessage       *msg.Message `json:"labelMessage,omitempty"`
	PageURL            string       `json:"pageURL,omitempty"`
	Description        string       `json:"description"`
	DescriptionMessage *msg.Message `json:"descriptionMessage,omitempty"`
}

// findableState is the findable switch as it stands, or nil when no announcer
// is registered.
func (s *Server) findableState() *findableView {
	spec, ok := findLANAnnouncer()
	if !ok {
		return nil
	}
	view := &findableView{Enabled: s.findable.Load(), Label: spec.Label.English(), PageURL: spec.PageURL, Description: spec.Description.English()}
	if !spec.Label.IsZero() {
		view.LabelMessage = &spec.Label
	}
	if !spec.Description.IsZero() {
		view.DescriptionMessage = &spec.Description
	}
	return view
}

// launchFindable is whether a start makes the server findable: the saved
// connectivity.lanFindable, read at every start except under --test, so the
// harness never picks up a developer's real settings.json.
func launchFindable(opts ServeOptions) bool {
	if opts.TestChildren {
		return false
	}
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		return false
	}
	return gs.Connectivity.LANFindable
}

// setFindable saves whether the server is findable, and starts or stops the
// announcer to match.
func (s *Server) setFindable(on bool) error {
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Connectivity.LANFindable = on
		return true
	}); err != nil {
		return err
	}
	s.findable.Store(on)
	s.syncLANAnnouncer()
	return nil
}

// announcerWanted is whether the announcer should run: LAN access is on, the
// server is findable, a build registered one, and the server is not a test
// harness's (unlisted).
func (s *Server) announcerWanted() bool {
	_, ok := findLANAnnouncer()
	return ok && !s.unlisted && s.lan.Load() && s.findable.Load()
}

// syncLANAnnouncer starts the announcer if it should run and does not, and
// stops it if it runs and should not. A switch that changes while it starts is
// caught by the check after the run is published: whichever runs second stops
// it.
func (s *Server) syncLANAnnouncer() {
	if !s.announcerWanted() {
		if run := s.lanAnnouncer.Swap(nil); run != nil {
			run.end()
		}
		return
	}
	spec, _ := findLANAnnouncer()
	life, end := context.WithCancel(s.lifetime())
	run := &lanAnnouncerRun{end: end}
	if !s.lanAnnouncer.CompareAndSwap(nil, run) {
		end()
		return
	}
	if !s.announcerWanted() {
		s.stopLANAnnouncerIf(run)
		return
	}
	announcer := spec.New(lanAnnounceHost{s: s})
	jlog.Info("   findable from %s", spec.Name)
	s.announcing.Add(1)
	go func() {
		defer s.announcing.Done()
		err := announcer.Run(life)
		if s.stopLANAnnouncerIf(run) && err != nil {
			jlog.Error("LAN announcer (%s): %v", spec.Name, err)
		}
	}()
}

// lanAnnouncerStopLimit bounds how long a stopping server waits for the
// announcer's run to return (awaitLANAnnouncer): its last word to the third
// party, past what tunnel.LANAnnouncer allows it.
const lanAnnouncerStopLimit = 10 * time.Second

// awaitLANAnnouncer waits, up to lanAnnouncerStopLimit, for every announcer
// run to return, so that a run's last word to the third party (that the
// server is no longer findable) leaves before the process ends. Part of
// server shutdown: called once the lifetime has ended every run and no
// request can start another.
func (s *Server) awaitLANAnnouncer() {
	done := make(chan struct{})
	go func() {
		s.announcing.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(lanAnnouncerStopLimit):
		jlog.Info("serve: the LAN announcer did not stop within %v; leaving without it", lanAnnouncerStopLimit)
	}
}

// stopLANAnnouncerIf ends run if it is still the running one, and reports
// whether it was.
func (s *Server) stopLANAnnouncerIf(run *lanAnnouncerRun) bool {
	if !s.lanAnnouncer.CompareAndSwap(run, nil) {
		return false
	}
	run.end()
	return true
}

// lanAnnounceHost is the tunnel.LANAnnounceHost an announcer is handed.
type lanAnnounceHost struct {
	s *Server
}

var _ tunnel.LANAnnounceHost = lanAnnounceHost{}

// Announcement is this machine's name and the addresses LAN access shows, read
// afresh. It reads the interfaces alone, not lanState, whose read of the mDNS
// announcement may send one.
func (h lanAnnounceHost) Announcement() tunnel.LANAnnouncement {
	a := tunnel.LANAnnouncement{Name: lanfind.MachineName(), URLs: []string{}, Version: core.Version}
	_, port, err := net.SplitHostPort(h.s.addr)
	if err != nil {
		return a
	}
	a.Port, _ = strconv.Atoi(port)
	for _, addr := range lanAddresses() {
		a.URLs = append(a.URLs, lanRootURL(addr.ip, port))
	}
	return a
}
